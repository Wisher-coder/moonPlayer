// ============================================================================
// Telegram 专属端点:/api/telegram/*(仅 Node 服务端运行)
// ----------------------------------------------------------------------------
// 登录态机与数据面端点,读侧 GET(前端经 src/lib/client.js 的
// api('telegram', method, params) 拼同一批地址),聊天写侧 POST(读侧之外的
// 动作面,请求体经 app 级 koa-bodyparser 解析 JSON):
//   session                          → 登录态快照(未登录也 200)
//   login?phone=                     → 发起登录(发送验证码)
//   verify?code=                     → 提交验证码 → {phase:'ok'|'password'|'code',error,hint}
//   password?pw=                     → 提交两步验证密码 → {phase:'ok'|'password',error}
//   qr                               → 发起 QR 扫码登录(teleproto 引擎新增;服务端渲染
//                                       PNG dataURL,app 零新增依赖;前端展示后轮询 /session
//                                       等相位变 ok)
//   cancel                           → 作废在途登录(手机流/QR 流通用)
//   logout                           → 登出并清会话
//   dialogs?page=&size=&filter=      → 对话目录(内存分页,filter=all|group|channel|saved|
//                                       种类档(兼容保留)+archive|folder:<id> 列表档
//                                       (B7:引擎侧带 chatListArchive/chatListFolder
//                                       装载,不再按 kind 过滤);逐对话带
//                                       unreadCount/muted/pinned/lastMessage,不再逐
//                                       会话打 messages.Search 计数;响应加性 folders:
//                                       [{id,title,emoji}](用户自建文件夹清单,来自
//                                       引擎 updateChatFolders 缓存,未到达为 [])
//   videos?peer=&page=&size=         → 某对话的视频分页(复用插件 boardList 归一化)
//   stream?u=&t=                     → 视频字节流(签名短时令牌 + Range/206;HEAD 同头无体)
//   messages?peer=&anchor=&dir=&limit= → 聊天页双向分页(around/older/newer,归一化
//                                       在 telegram-tg/messages.js;around/newer
//                                       附带对话头部 peer)
//   message?peer=&id=                → 单条消息(归一化)
//   updates?peer=&seq=&wait=         → 更新事件长轮询(telegram-tg/updates.js;
//                                       有界等待默认/上限 20s;无 peer 只回全局 seq)
//   resolve?domain=                  → 用户名解析(contacts.resolveUsername,TTL 缓存)
//   POST send   {peer,text,replyTo?} → 发送纯文本 → {message}
//   POST callback {peer,msgId,data?,game?} → bot 内联键盘回调 → {answer,message}
//   POST vote   {peer,msgId,options} → 投票 → {message}
//   POST read   {peer,maxId}         → 已读同步 → {ok:true}
//
// 注册顺序红线(routes/index.js):本路由必须在 imgRouter 之后、siteMethodRouter
// 之前挂载——@koa/router 嵌套时各子路由层摊平进同一栈按注册序匹配,首个命中
// 且不调 next() 的层胜出;晚于 /:site/:method 注册的话,/api/telegram/session
// 会被兜底网关按 site='telegram' 抢走(getPlugin 未注册 → 404 未知站点)。
//
// 来源访问策略(2026-10-10 用户决定):本服务为个人本机/局域网部署,【不做
// 来源门禁,全部放行】——仅依赖 app 级 cors() 的 ACAO:* 允许任意前端跨源直连
// (局域网设备/mDNS 主机名/IPv6 本机地址等此前会被白名单误拒,故撤下门禁)。
// stream 端点仍保留 HMAC 短时令牌防外链滥用;日后若公网部署需重新收口来源。
//
// 错误契约:与统一分发网关同构——一切异常回 {__err:1,message}(中文)且
// ctx.status = err.status || 502;TgNotLoggedInError 额外带 needLogin:true
// (前端据此跳登录页)。会话类数据(非公共资产)全部 Cache-Control:no-store。
// ============================================================================

import Router from '@koa/router';
// 引擎收敛（2026-10）：TDLib 为唯一实现——数据面全部直连 telegram-tdlib/
// engine.js 的 facade（getTdlibEngine 单例，内部懒启动单飞；装配失败返回
// 「失败态引擎」，各端点如实回 {__err:1} 中文错）。TgNotLoggedInError /
// avatarToken 等共享纯逻辑收敛在 telegram-tg/shared.js 单一实现。
import { getTdlibEngine } from '../plugins/telegram-tg/engine.js';
import { TgNotLoggedInError, isPeerKey, avatarToken } from '../plugins/telegram-tg/shared.js';

// 引擎单飞取用：getTdlibEngine 自身即进程级单例（内部缓存装配 Promise），
// 此处薄封装保持各 handler「(await tdlibEngine()).xxx」的既有调用形态。
function tdlibEngine() {
  return getTdlibEngine();
}

// 数字参数安全转换:非法/非正数给默认值(与 site-method.js 同款语义)
function intParam(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}

// 带 HTTP 状态的错误(分发层 4xx 语义;catch 统一按 err.status||502 回包)
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// 统一错误出口:502 兜底,ApiError 形态(带 status)保原状态码
function fail(ctx, e) {
  ctx.status = e.status || 502;
  ctx.type = 'application/json';
  ctx.body = { __err: 1, message: e.message || '服务器内部错误', needLogin: e instanceof TgNotLoggedInError };
}

// ============ 来源访问策略:全部放行(见文件头说明,无门禁中间件) ============

export const telegramRouter = new Router({ prefix: '/telegram' });

// ============ 登录态机(session/login/verify/password/cancel/logout) ============

// 登录态快照:登录相位面 + 常驻客户端面合并产出(旧双引擎时代的两快照
// 合并形态);未登录/无凭据也是 200,前端按字段渲染
telegramRouter.get('/session', async (ctx) => {
  try {
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    // facade 合并快照(auth 域产出,相位面 + 账号面同形态)
    ctx.body = await (await tdlibEngine()).sessionSnapshot();
  } catch (e) { fail(ctx, e); }
});

// 发起登录:发送验证码,等到 code 相位(或直接失败)后回快照
telegramRouter.get('/login', async (ctx) => {
  try {
    const q = new URLSearchParams(ctx.querystring);
    // beginLogin 等相位转 code 后自带快照(合并形态)
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    ctx.body = await (await tdlibEngine()).beginLogin(q.get('phone') || '');
  } catch (e) { fail(ctx, e); }
});

// 提交验证码:phase=ok 完成 / password 要两步验证 / code 重问(附 error)
telegramRouter.get('/verify', async (ctx) => {
  try {
    const q = new URLSearchParams(ctx.querystring);
    const out = await (await tdlibEngine()).submitCode(q.get('code') || '');
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    ctx.body = out;
  } catch (e) { fail(ctx, e); }
});

// 提交两步验证密码:phase=ok 完成 / password 重问(附 error)
telegramRouter.get('/password', async (ctx) => {
  try {
    const q = new URLSearchParams(ctx.querystring);
    const out = await (await tdlibEngine()).submitPassword(q.get('pw') || '');
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    ctx.body = out;
  } catch (e) { fail(ctx, e); }
});

telegramRouter.get('/cancel', async (ctx) => {
  try {
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    await (await tdlibEngine()).abortLogin('用户取消登录');
    ctx.body = { ok: true };
  } catch (e) { fail(ctx, e); }
});

// 发起 QR 扫码登录(teleproto 引擎新增):auth.ExportLoginToken → 服务端
// 渲染 PNG dataURL;返回 {phase:'qr',qr,expires} 或已扫完 {phase:'ok'}。
// app 展示二维码后轮询 /session 等相位变 ok(手机端 Telegram 扫码确认)。
telegramRouter.get('/qr', async (ctx) => {
  try {
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    ctx.body = await (await tdlibEngine()).beginQrLogin();
  } catch (e) { fail(ctx, e); }
});

telegramRouter.get('/logout', async (ctx) => {
  try {
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    await (await tdlibEngine()).logout();
    ctx.body = { ok: true };
  } catch (e) { fail(ctx, e); }
});

// ============ 对话目录(dialogs) ============

// filter → 对话种类(内存过滤后分页;user=私聊仅在全量档可见)。
// B7 扩展:archive / folder:<id> 为「列表档」取值——不进本表(它们按 chat_list
// 装载各自的目录,不做 kind 过滤),在 handler 内单独分流。
const DIALOG_FILTERS = {
  all: ['saved', 'group', 'channel', 'user'],
  group: ['group'],
  channel: ['channel'],
  saved: ['saved'],
};

telegramRouter.get('/dialogs', async (ctx) => {
  try {
    const q = new URLSearchParams(ctx.querystring);
    const page = intParam(q.get('page'), 1);
    const size = Math.min(50, intParam(q.get('size'), 24)); // size 上限 50
    const filterRaw = q.get('filter') || 'all';
    // filter 三类取值:①既有种类档 all|group|channel|saved(主列表内存过滤,
    // 兼容保留不删);②'archive' 归档列表;③'folder:<id>' 用户自建文件夹
    // (id 必须是正整数,非法 400;不匹配的未知取值照旧回落 all)
    let list = 'main';
    let kinds = null; // null = 不按 kind 过滤(列表档:归档/文件夹本就是多类型混合清单)
    const fm = /^folder:(\d+)$/.exec(filterRaw);
    if (filterRaw === 'archive') {
      list = 'archive';
    } else if (fm) {
      const fid = Number(fm[1]);
      if (!Number.isSafeInteger(fid) || fid <= 0) {
        throw httpError(400, '参数 filter 的文件夹 id 非法:' + filterRaw);
      }
      list = 'folder:' + fid;
    } else {
      kinds = DIALOG_FILTERS[filterRaw] || DIALOG_FILTERS.all;
    }
    const E = await tdlibEngine();
    // 对话表来自 facade(list 档位化装载;路由层 filter/分页/avatar 包装逻辑不变)
    const all = (await E.getDialogs(list))
      .filter((d) => kinds === null || kinds.includes(d.kind));
    const slice = all.slice((page - 1) * size, page * size);
    // 计数/静音/置顶/lastMessage 全部来自对话表取数自带的原始字段,
    // 零逐会话额外请求(原 videoCount 的视频搜索计数已移除,视频计数仍在
    // videos 端点/插件层按需取)
    const items = slice.map((d) => ({
      id: d.peerKey,
      name: d.name || ('Telegram 对话 ' + d.peerKey),
      avatar: '/api/img/telegram?u=' + encodeURIComponent(avatarToken(d.peerKey)),
      kind: d.kind,
      unreadCount: d.unreadCount || 0,
      unreadMentionsCount: d.unreadMentionsCount || 0,
      muted: Boolean(d.muted),
      pinned: Boolean(d.pinned),
      lastMessage: d.lastMessage || null,
      lastAt: d.lastAt ? new Date(d.lastAt * 1000).toISOString() : null,
    }));
    // 加性字段 folders:用户自建文件夹清单(引擎级缓存,updateChatFolders 事件
    // 维护;未到达为 []。纯缓存读取零请求,前端四个 tab 的文件夹化改造消费)
    const folders = await E.getChatFolders();
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    ctx.body = { items, page, hasMore: page * size < all.length, folders };
  } catch (e) { fail(ctx, e); }
});

// ============ 对话视频(videos) ============

// 直调 facade 的 listPeerVideos(与站点插件 boardList 同一份数据形状,
// 归一化/分页语义单一实现,不复制第二份)
telegramRouter.get('/videos', async (ctx) => {
  try {
    const q = new URLSearchParams(ctx.querystring);
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    const peer = q.get('peer') || '';
    const opts = {
      page: intParam(q.get('page'), 1),
      size: intParam(q.get('size'), 24),
    };
    ctx.body = await (await tdlibEngine()).listPeerVideos(peer, opts);
  } catch (e) { fail(ctx, e); }
});

// ============ 聊天域(messages/message/send/callback/vote/read) ============

// id 形参解析:非负整数(0 合法,「最新」语义;正则是十进制原样,拒绝小数/
// 负号/空白混入);缺省回 0,非法 400
function idParam(v, name) {
  const s = String(v == null ? '' : v).trim();
  if (s === '') return 0;
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(Number(s))) {
    throw httpError(400, '参数 ' + name + ' 必须是非负整数');
  }
  return Number(s);
}

// POST body 门禁:必须是 JSON 对象(app 级 koa-bodyparser 已解析;缺 body /
// 数组 / 原始类型一律 400,不进业务层)
function jsonBody(ctx) {
  const b = ctx.request && ctx.request.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw httpError(400, '请求体必须是 JSON 对象');
  }
  return b;
}

// —— 聊天页分页:anchor 缺省/0 = 最新一页;dir=older 比 anchor 更旧一页;
//    dir=newer anchor 之后的新消息(增量拉取,附带 peer 头部刷新水位线);
//    dir=around 定位首屏(附带 peer 头部)。归一化与游标语义见
//    telegram-tg/messages.js ——
telegramRouter.get('/messages', async (ctx) => {
  try {
    const q = new URLSearchParams(ctx.querystring);
    const dir = q.get('dir') || 'around';
    if (!['around', 'older', 'newer'].includes(dir)) {
      throw httpError(400, '参数 dir 只支持 around|older|newer');
    }
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    const peerKey = q.get('peer') || '';
    const pageOpts = {
      anchor: idParam(q.get('anchor'), 'anchor'),
      dir,
      limit: Math.min(100, intParam(q.get('limit'), 30)), // limit 上限 100
    };
    // facade(messages 域;游标语义 around/older/newer 与页面契约一致)
    ctx.body = await (await tdlibEngine()).getChatPage(peerKey, pageOpts);
  } catch (e) { fail(ctx, e); }
});

// —— 单条消息(强制穿透缓存强拉,写侧回执/深链定位复用) ——
telegramRouter.get('/message', async (ctx) => {
  try {
    const q = new URLSearchParams(ctx.querystring);
    const id = idParam(q.get('id'), 'id');
    if (!id) throw httpError(400, '参数 id 不能为空');
    const peerKey = q.get('peer') || '';
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    // force=true 穿透缓存强拉(写侧回执/深链定位复用)
    const message = await (await tdlibEngine()).getOneMessage(peerKey, id, true);
    ctx.body = { message };
  } catch (e) { fail(ctx, e); }
});

// —— 发送纯文本(仅文本,不做媒体上传;空文本/超 4096 字在写侧域前置
//    校验 400,写侧错误码统一中文映射) ——
telegramRouter.post('/send', async (ctx) => {
  try {
    const b = jsonBody(ctx);
    const replyTo = idParam(b.replyTo, 'replyTo'); // 缺省/0 = 不回复
    const peerKey = String(b.peer || '');
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    // facade send(peerKey,text,replyTo?) 回执为归一化契约消息
    const message = await (await tdlibEngine()).send(peerKey, b.text, replyTo || undefined);
    ctx.body = { message };
  } catch (e) { fail(ctx, e); }
});

// —— bot 内联键盘回调(callback 按钮的 data 为 base64;game 按钮带 game 标记)。
//    返回 answer(toast/弹窗/跳转)与更新后的消息(bot 回调常编辑原消息) ——
telegramRouter.post('/callback', async (ctx) => {
  try {
    const b = jsonBody(ctx);
    const msgId = idParam(b.msgId, 'msgId');
    if (!msgId) throw httpError(400, '参数 msgId 不能为空');
    if (!b.game && !b.data) throw httpError(400, '缺少回调数据(data 与 game 至少其一)');
    const peerKey = String(b.peer || '');
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    // 回 {answer:{message,alert,url},message}(编辑同步阶梯常量在写侧域内建)
    ctx.body = await (await tdlibEngine()).sendBotCallback(peerKey, msgId, b.data, Boolean(b.game));
  } catch (e) { fail(ctx, e); }
});

// —— 投票(options 为 base64 选项列表,多选传多个;回传更新后的消息) ——
telegramRouter.post('/vote', async (ctx) => {
  try {
    const b = jsonBody(ctx);
    const msgId = idParam(b.msgId, 'msgId');
    if (!msgId) throw httpError(400, '参数 msgId 不能为空');
    if (!Array.isArray(b.options) || !b.options.length) {
      throw httpError(400, '参数 options 必须是非空数组(base64 选项列表)');
    }
    const peerKey = String(b.peer || '');
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    // options base64 形态契约不变(引擎侧为选项序号的 base64 编码)
    const message = await (await tdlibEngine()).sendPollVote(peerKey, msgId, b.options);
    ctx.body = { message };
  } catch (e) { fail(ctx, e); }
});

// —— 已读同步(openChat 后 viewMessages force_read=true 到 maxId) ——
telegramRouter.post('/read', async (ctx) => {
  try {
    const b = jsonBody(ctx);
    const maxId = idParam(b.maxId, 'maxId');
    if (!maxId) throw httpError(400, '参数 maxId 不能为空');
    const peerKey = String(b.peer || '');
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    ctx.body = await (await tdlibEngine()).markChatRead(peerKey, maxId);
  } catch (e) { fail(ctx, e); }
});

// ============ 更新事件长轮询(updates)+ 用户名解析(resolve) ============

// —— 更新事件长轮询:客户端带会话游标 seq 取增量事件;无新事件时有界等待
//    (wait 毫秒,默认/上限 20000),事件到达/到时/客户端断开任一即返回。
//    无 peer 参数只回全局最新 seq(对话目录侧的轻量游标)。事件层随
//    引擎常驻客户端订阅;未登录走 needLogin 契约 ——
telegramRouter.get('/updates', async (ctx) => {
  let aborted = false; // 客户端断开收尾标记(此时不再回包,也不走 fail)
  try {
    // 先取 facade(装配失败走 fail() 中文契约错)
    const E = await tdlibEngine();
    const q = new URLSearchParams(ctx.querystring);
    // 参数校验先行(纯本地,不因非法参数拉起客户端连接)
    const peer = q.get('peer') || '';
    let afterSeq = 0;
    if (peer) {
      if (!isPeerKey(peer)) throw httpError(400, '参数 peer 非法:' + peer);
      // seq:客户端会话游标(缺省 0 = 从现在开始);非法(非十进制非负整数)400
      const rawSeq = q.get('seq');
      if (rawSeq != null && rawSeq !== '') {
        if (!/^\d+$/.test(rawSeq) || !Number.isSafeInteger(Number(rawSeq))) {
          throw httpError(400, '参数 seq 必须是非负整数');
        }
        afterSeq = Number(rawSeq);
      }
    }
    // wait:有界等待毫秒数,缺省 20000,钳制到 [0,20000](默认即上限)
    const waitRaw = parseInt(q.get('wait'), 10);
    const waitMs = Number.isFinite(waitRaw) ? Math.min(20000, Math.max(0, waitRaw)) : 20000;

    // 事件层随常驻客户端订阅;未登录走 needLogin 契约(ensureReady 抛
    // TgNotLoggedInError,shared.js 同一个类)
    await E.ensureReady();
    // koa-compress 会对挂起中的 JSON 响应缓冲:长轮询路由关压缩,保证事件即达
    // (与 stream 端点 ctx.compress = false 同款手法)
    ctx.compress = false;
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    if (!peer) {
      ctx.body = { seq: await E.globalUpdateSeq() };
      return;
    }

    let out = await E.getUpdatesSince(peer, afterSeq);
    // reset 返回值没有 events 字段,须先行短路(游标越界只应立即回包,不进等待)
    if (!out.reset && out.events.length === 0 && waitMs > 0) {
      // 有界等待:客户端断开(res close 且响应未写出)立即收尾,不留悬挂 handler
      const ac = new AbortController();
      const onClose = () => { if (!ctx.res.writableEnded) ac.abort(); };
      ctx.res.once('close', onClose);
      try {
        await E.waitForPeerEvent(peer, waitMs, ac.signal);
      } finally {
        ctx.res.removeListener('close', onClose);
      }
      if (ac.signal.aborted) {
        // 客户端已断开:标记后交还 koa(ctx.respond=false 跳过响应写出,
        // 不再向死套接字写体)
        aborted = true;
        ctx.respond = false;
        return;
      }
      // 等待期间可能积累多条,一次带回
      out = await E.getUpdatesSince(peer, afterSeq);
    }
    ctx.body = out;
  } catch (e) {
    if (aborted) return; // 断开收尾路径不再回包
    fail(ctx, e);
  }
});

// —— 用户名解析(@username / t.me 链接片段)→ {peerKey,name,kind};成功
//    TTL 缓存 10 分钟,失败(不存在/超时/限流)走 fail() 中文文案 ——
// 邀请链接(t.me/+hash / t.me/joinchat/<hash>)走 invite 参数:checkChatInviteLink
// ——已加入回 {joined:true,peerKey,name,kind} 供应用内跳转,未加入回
// {joined:false,title,memberCount} 供提示(官方客户端同款承接,N3) ——
telegramRouter.get('/resolve', async (ctx) => {
  try {
    const q = new URLSearchParams(ctx.querystring);
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    const invite = q.get('invite') || '';
    if (invite) {
      ctx.body = await (await tdlibEngine()).resolveInviteLink(invite);
      return;
    }
    const domain = q.get('domain') || '';
    if (!domain) throw httpError(400, '参数 domain 不能为空');
    // searchPublicChat(TTL 10min/上限 256 缓存)
    ctx.body = await (await tdlibEngine()).resolveUsername(domain);
  } catch (e) { fail(ctx, e); }
});

// ============ Range 字节流(stream) ============

// 同 u 在途去重(「等 resolveStreamTarget 元数据」窗口):流式响应前的唯一
// 上游往返,并发首字节窗口内只打一次;失败原样共享上抛、不自动重试(仓库
// 规约)。响应体各请求独立 createRangeStream——刻意不 tee 分发(同
// site-method.js segInflight 的内存权衡),字节级网络去重由 media.js 的
// 块缓存/在途表内建,无须本层再管。
const streamTargetInflight = new Map(); // u → Promise<{size}>(settle 即出表)
// 解析函数参数化(签名流四件套的 resolveStreamTarget 经 facade 取用;该
// 去重表只认函数本体,绑定实例或裸函数均可)
function sharedStreamTarget(u, resolveTarget) {
  let p = streamTargetInflight.get(u);
  if (!p) {
    p = resolveTarget(u).finally(() => {
      if (streamTargetInflight.get(u) === p) streamTargetInflight.delete(u);
    });
    streamTargetInflight.set(u, p);
  }
  return p;
}

/**
 * Range 头解析:bytes=a-b / a- / -n(后缀式);多段区间只取第一段(视频
 * 播放器不发多段请求)。返回值:
 *   null                → 无 Range/语法非法 → 调用方回 200 全量(RFC 7233:
 *                         收到无效 Range 头必须忽略)
 *   {unsatisfiable:true} → start 越过文件末尾 → 调用方回 416
 *   {start,end}          → 闭区间且已按 size 收敛 → 调用方回 206
 * (导出仅为离线自检:探针脚本复用同一实现,不另抄一份)
 */
export function parseRangeHeader(header, size) {
  if (!header) return null;
  const m = /^bytes\s*=\s*(.*)$/i.exec(String(header).trim());
  if (!m) return null;
  const spec = m[1].split(',')[0].trim(); // 多段取第一段
  const r = /^(\d*)-(\d*)$/.exec(spec);
  if (!r || (r[1] === '' && r[2] === '')) return null;
  if (r[1] === '') {
    // 后缀式 bytes=-n:最后 n 字节(n 大于文件大小时即全量)
    const n = Number(r[2]);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (size <= 0) return { unsatisfiable: true };
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(r[1]);
  if (!Number.isSafeInteger(start) || start < 0) return null;
  if (start >= size) return { unsatisfiable: true };
  const end = r[2] === '' ? size - 1 : Math.min(Number(r[2]), size - 1);
  if (end < start) return null; // start>end:无效区间,忽略 Range 回全量
  return { start, end };
}

// 流式出口。HEAD 由 @koa/router 的 GET 注册自动附带匹配(layer 注册时把
// HEAD 并进 methods),Koa respond() 对 HEAD 不消费 ctx.body 直接 end()——
// 头照发、体不发;createRangeStream 是惰性生成器,不被消费就不会发起任何
// 网络请求,HEAD 不存在泄漏窗口。
async function streamHandler(ctx) {
  try {
    const q = new URLSearchParams(ctx.querystring);
    const u = q.get('u') || '';
    // facade 签名流四件套(HMAC 短时令牌;STREAM_SECRET 为引擎进程级随机)
    const E = await tdlibEngine();
    if (!(await E.verifyStream(u, q.get('t') || ''))) {
      throw httpError(403, '流地址签名无效或已过期,请重新进入播放页获取新地址');
    }
    // 引擎收敛回归修复:此调用点此前漏传解析函数(裸引用未定义变量,每个
    // /stream 请求必抛 ReferenceError → 502,AVPlayer 报 resource unavailable)
    const { size } = await sharedStreamTarget(u, (x) => E.resolveStreamTarget(x));
    if (!size) throw new Error('文件大小未知');
    const range = parseRangeHeader(ctx.get('range'), size);
    if (range && range.unsatisfiable) {
      ctx.set('Content-Range', 'bytes */' + size);
      throw httpError(416, '请求的字节范围无法满足(已越过文件末尾)');
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    ctx.status = range ? 206 : 200;
    if (range) ctx.set('Content-Range', 'bytes ' + start + '-' + end + '/' + size);
    ctx.set('Accept-Ranges', 'bytes');
    ctx.set('Content-Type', 'video/mp4');
    ctx.set('Content-Length', String(end - start + 1));
    ctx.set('Access-Control-Allow-Origin', '*'); // 投屏/跨源播放器拉流需要
    ctx.set('Cache-Control', 'no-store');        // 令牌一小时分桶,不做公共缓存
    ctx.compress = false;                        // 视频流不压缩(也让 Content-Length 精确)
    // —— 流拆除卫生:客户端断连后 Koa 仍可能向死套接字补写,残余写错会以
    //    EPIPE 风暴形态涌进 app 级错误日志。两条兜底都在 ctx.body 赋值前挂:
    //    ① res 'error' 空 handler——吞掉断连后的残余写错,防 'error' 事件
    //      无监听触发未捕获异常;
    //    ② res 'close' 时 destroy 响应体流——尽早拆上游,释放 TDLib 媒体
    //      传输槽位(正常结束时流已自然 end,destroy 是无害 no-op)。HEAD
    //      路径 ctx.body 不被消费(惰性生成器不启动),destroy 同样无害,
    //      头照发体不发的既有行为不变。
    const body = await E.createRangeStream(u, start, end);
    ctx.res.on('error', () => { /* 断连后的残余写错:吞掉即可 */ });
    ctx.res.on('close', () => { try { body.destroy(); } catch { /* 已拆除 */ } });
    ctx.body = body;
  } catch (e) { fail(ctx, e); }
}

telegramRouter.get('/stream', streamHandler);
