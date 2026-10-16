// ============================================================================
// Telegram 增量能力端点:/api/telegram/*(引擎-扩展 lane,新文件)
// ----------------------------------------------------------------------------
// 页面蓝图 .fixtmp/tgios-pages-blueprint.md §4「服务端增量端点契约表」的 12 个
// 增量端点(搜索/日历/转发/置顶/编辑/删除/对话动作/提及已读/聊天头部),数据面
// 唯一实现 = plugins/telegram-tg/extras.js(engine.js 生产单例 host 代理装配;
// mtproto 引擎已随 2026-10 引擎收敛删除,无分发层)。
//
// 注册顺序红线(routes/index.js 头注):本路由必须在 telegramRouter 之后、
// siteMethodRouter 之前挂载——12 个新路径(/search、/search/global、/calendar、
// /forward、/pin、/pinned、/edit、/delete、/dialog/update、/dialog/delete、
// /read-mentions、/chat-header)与既有 18 端点零冲突,但同为两段静态路径,
// 晚于兜底网关注册会被按 site='telegram' 抢成「未知站点」404。
//
// 缺引擎能力(域装配不完整)→ {__err:1,message:'暂不支持…'} 中文契约错误
// (501),页面按文案降级呈现,绝不轮询重试(防风暴红线)。
//
// 错误契约:与 routes/telegram.js 同构——一切异常回 {__err:1,message}(中文)
// 且 ctx.status = err.status || 502;TgNotLoggedInError 额外带 needLogin:true。
// 全部端点会话类数据 Cache-Control:no-store。
// ============================================================================

import Router from '@koa/router';
import { TgNotLoggedInError, isPeerKey } from '../plugins/telegram-tg/shared.js';

// ============ 增量域单飞装载(teleproto 唯一引擎) ============

// 增量域单飞装载:经 engine.js 生产单例接线。engine._tgDeps 是引擎装配期构造
// 的内部依赖口 {getClient(授权态客户端)/entityOf(dialogs 共享口)/
// getSelfId(本人 user id)},extras 域工厂(createTgExtras)直连;引擎处于
// 装配失败态时不产生 _tgDeps,此处如实中文报错。getSelfId 的 'saved' 伪对话
// 编解码与全局搜索按 chat_id 归位依赖由引擎侧注入同一实现。
let tgExtrasP = null;
function tgExtras() {
  if (!tgExtrasP) {
    tgExtrasP = (async () => {
      const engineMod = await import('../plugins/telegram-tg/engine.js');
      const E = await engineMod.getTdlibEngine();
      const deps = E && E._tgDeps;
      if (!deps || typeof deps.getClient !== 'function' || typeof deps.entityOf !== 'function') {
        throw new Error('teleproto 引擎未就绪:引擎装配失败（请检查 engine.js 装配日志）');
      }
      const extrasMod = await import('../plugins/telegram-tg/extras.js');
      const domain = extrasMod.createTgExtras(deps);
      return { E, domain };
    })().catch((e) => {
      tgExtrasP = null; // 装配失败不缓存拒绝:下次请求可重试显式触发(引擎自身仍不自动重试)
      throw e;
    });
  }
  return tgExtrasP;
}

// 能力函数定位:按名取增量域函数;缺失(装配不完整/域面缺能力)→ 501 中文
// 契约错误 {__err:1},页面按文案降级呈现。
const CAPABILITY_LABELS = {
  searchInChat: '会话内搜索',
  searchGlobal: '全局搜索',
  calendar: '消息日历',
  forwardMessages: '消息转发',
  pinMessage: '消息置顶',
  pinnedMessages: '置顶列表',
  editText: '消息编辑',
  deleteMessages: '消息删除',
  dialogUpdate: '对话动作',
  dialogDelete: '对话删除',
  readMentions: '提及已读',
  chatHeader: '聊天头部',
};

async function caps(name) {
  const label = CAPABILITY_LABELS[name] || name;
  const { E, domain } = await tgExtras();
  // 登录闸门:未登录抛 TgNotLoggedInError → needLogin 契约
  await E.ensureReady();
  const fn = domain[name];
  if (typeof fn !== 'function') {
    throw httpError(501, '暂不支持' + label + '（引擎装配不完整），请稍后再试');
  }
  return fn;
}

// ============ 路由层公共代码(与 routes/telegram.js 同款语义,不复制实现) ============

// 数字参数安全转换:非法/非正数给默认值
function intParam(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}

// 非负整数参数(时间戳等;与 telegram.js idParam 同款,名称不同便于区分语义)
function numParam(v, name) {
  const s = String(v == null ? '' : v).trim();
  if (s === '') return 0;
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(Number(s))) {
    throw httpError(400, '参数 ' + name + ' 必须是非负整数');
  }
  return Number(s);
}

// id 形参解析:非负整数(0=「最新」语义;非法 400)
function idParam(v, name) {
  return numParam(v, name);
}

// POST body 门禁:必须是 JSON 对象(app 级 koa-bodyparser 已解析)
function jsonBody(ctx) {
  const b = ctx.request && ctx.request.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw httpError(400, '请求体必须是 JSON 对象');
  }
  return b;
}

// 带 HTTP 状态的错误(分发层 4xx 语义;catch 统一按 err.status||502 回包)
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// peer 校验(公共 GET/POST 两路)
function peerParam(peerKey) {
  const pk = String(peerKey || '');
  if (!isPeerKey(pk)) throw httpError(400, '参数 peer 非法:' + pk);
  return pk;
}

// 统一错误出口:502 兜底,带 status 的业务错误保原状态码。no-store 无条件携带
// (会话类数据全部不缓存——参数校验 400 路径在 okCtx 之前抛出,这里兜住,
// 比 routes/telegram.js 既有 fail() 略严,只影响本路由 12 端点)
function fail(ctx, e) {
  ctx.status = e.status || 502;
  ctx.type = 'application/json';
  ctx.set('Cache-Control', 'no-store');
  ctx.body = { __err: 1, message: e.message || '服务器内部错误', needLogin: e instanceof TgNotLoggedInError };
}

function okCtx(ctx) {
  ctx.type = 'application/json';
  ctx.set('Cache-Control', 'no-store');
}

// ============ 增量端点(契约:页面蓝图 §4.2,逐行对应) ============
// 顺序约定(对齐 routes/telegram.js /updates「参数校验先行」口径):每个 handler
// 先做纯本地参数校验(peer/月份/id/请求体),再进 caps()(其内含登录闸门与
// 客户端懒启动)——非法参数不拉起客户端连接。

export const telegramExtrasRouter = new Router({ prefix: '/telegram' });

// —— ① GET /search 会话内搜索:{messages,totalCount,completed}(id 降序) ——
//     filter 可选:photo|video|photoVideo|document|url|voice(按媒体类型浏览,
//     引擎层映射 searchChatMessages 的 SearchMessagesFilter 并做白名单校验;
//     有 filter 时 q 允许为空串=纯媒体浏览)。
telegramExtrasRouter.get('/search', async (ctx) => {
  try {
    const q = new URLSearchParams(ctx.querystring);
    const params = {
      peerKey: peerParam(q.get('peer')),
      q: q.get('q') || '',
      threadId: idParam(q.get('threadId'), 'threadId'),
      fromId: q.get('fromId') || '',
      filter: q.get('filter') || '', // 可选媒体过滤(引擎层 SEARCH_MEDIA_FILTERS 白名单)
      minDate: numParam(q.get('minDate'), 'minDate'),
      maxDate: numParam(q.get('maxDate'), 'maxDate'),
      offsetId: idParam(q.get('offsetId'), 'offsetId'), // 分页:上一页最旧 id
      limit: intParam(q.get('limit'), 20),
    };
    const fn = await caps('searchInChat');
    okCtx(ctx);
    ctx.body = await fn(params);
  } catch (e) { fail(ctx, e); }
});

// —— ② GET /search/global 全局搜索:{messages,nextRate:null,completed} ——
//     分页:响应加性字段 nextOffset(不透明令牌)原样回传(参数 offset);
//     offsetDate/offsetPeer/offsetId 为旧 mtproto 时代的分页参数,引擎收敛后
//     不再消费,保留仅为前端旧版本兼容。
telegramExtrasRouter.get('/search/global', async (ctx) => {
  try {
    const q = new URLSearchParams(ctx.querystring);
    const params = {
      q: q.get('q') || '',
      minDate: numParam(q.get('minDate'), 'minDate'),
      maxDate: numParam(q.get('maxDate'), 'maxDate'),
      offsetDate: numParam(q.get('offsetDate'), 'offsetDate'), // 上一页最后一条 date(unix 秒/ISO 服务端归一)
      offsetPeer: q.get('offsetPeer') || '',                    // 上一页最后一条 peerKey
      offsetId: idParam(q.get('offsetId'), 'offsetId'),         // 上一页最后一条 id
      offset: q.get('offset') || '',                            // TDLib 专用分页令牌
      limit: intParam(q.get('limit'), 20),
    };
    const fn = await caps('searchGlobal');
    okCtx(ctx);
    ctx.body = await fn(params);
  } catch (e) { fail(ctx, e); }
});

// —— ③ GET /calendar 消息日历:{month,days:[{date,count,lastMessageId}]} ——
//     type=media → 媒体日历:days 每日附 thumb(照片/视频缩略代理地址,解析
//     失败为 null;其余三字段不变);缺省=全部消息,响应形状与既有完全一致。
telegramExtrasRouter.get('/calendar', async (ctx) => {
  try {
    const q = new URLSearchParams(ctx.querystring);
    const params = {
      peerKey: peerParam(q.get('peer')),
      month: q.get('month') || '',
      type: q.get('type') || '', // type=media 媒体日历(PhotoAndVideo 过滤+每日缩略)
      threadId: idParam(q.get('threadId'), 'threadId'), // v1 两引擎均不消费(契约注释)
    };
    const fn = await caps('calendar');
    okCtx(ctx);
    ctx.body = await fn(params);
  } catch (e) { fail(ctx, e); }
});

// —— ④ POST /forward 转发:{sent:[{peerId,messageIds}]} ——
telegramExtrasRouter.post('/forward', async (ctx) => {
  try {
    const b = jsonBody(ctx);
    const params = {
      peerKey: peerParam(b.peer), // 来源会话
      toPeerIds: b.toPeerIds,     // 目标 peerKey 数组(引擎层校验非空/合法/去重)
      messageIds: b.messageIds,   // 源消息 id 数组
      hideNames: Boolean(b.hideNames),
      hideCaptions: Boolean(b.hideCaptions),
      silent: Boolean(b.silent),
    };
    const fn = await caps('forwardMessages');
    okCtx(ctx);
    ctx.body = await fn(params);
  } catch (e) { fail(ctx, e); }
});

// —— ⑤ POST /pin 置顶/取消置顶:{ok:true} ——
telegramExtrasRouter.post('/pin', async (ctx) => {
  try {
    const b = jsonBody(ctx);
    const params = {
      peerKey: peerParam(b.peer),
      id: idParam(b.id, 'id'),
      unpin: Boolean(b.unpin),
      silent: Boolean(b.silent),
    };
    const fn = await caps('pinMessage');
    okCtx(ctx);
    ctx.body = await fn(params);
  } catch (e) { fail(ctx, e); }
});

// —— ⑥ GET /pinned 置顶列表:{messages:[契约消息]} ——
telegramExtrasRouter.get('/pinned', async (ctx) => {
  try {
    const q = new URLSearchParams(ctx.querystring);
    const params = {
      peerKey: peerParam(q.get('peer')),
      limit: intParam(q.get('limit'), 20),
    };
    const fn = await caps('pinnedMessages');
    okCtx(ctx);
    ctx.body = await fn(params);
  } catch (e) { fail(ctx, e); }
});

// —— ⑦ POST /edit 编辑自己的纯文本消息:{message} ——
telegramExtrasRouter.post('/edit', async (ctx) => {
  try {
    const b = jsonBody(ctx);
    const params = {
      peerKey: peerParam(b.peer),
      id: idParam(b.id, 'id'),
      text: b.text,
      entities: b.entities, // v1 仅纯文本:非空数组由引擎层 400 拒绝
    };
    const fn = await caps('editText');
    okCtx(ctx);
    ctx.body = await fn(params);
  } catch (e) { fail(ctx, e); }
});

// —— ⑧ POST /delete 删除消息:{ok:true,deletedIds:[int]} ——
telegramExtrasRouter.post('/delete', async (ctx) => {
  try {
    const b = jsonBody(ctx);
    const params = {
      peerKey: peerParam(b.peer),
      ids: b.ids,
      revoke: Boolean(b.revoke), // 为所有人删除
    };
    const fn = await caps('deleteMessages');
    okCtx(ctx);
    ctx.body = await fn(params);
  } catch (e) { fail(ctx, e); }
});

// —— ⑨ POST /dialog/update 对话动作(单字段/次):{ok:true} ——
telegramExtrasRouter.post('/dialog/update', async (ctx) => {
  try {
    const b = jsonBody(ctx);
    const params = {
      peerKey: peerParam(b.peer),
      pinned: b.pinned,     // 四字段至多出现一个(引擎层 400)
      muted: b.muted,
      unread: b.unread,
      archived: b.archived,
    };
    const fn = await caps('dialogUpdate');
    okCtx(ctx);
    ctx.body = await fn(params);
  } catch (e) { fail(ctx, e); }
});

// —— ⑩ POST /dialog/delete 删除对话(从列表隐藏并清空历史):{ok:true} ——
telegramExtrasRouter.post('/dialog/delete', async (ctx) => {
  try {
    const b = jsonBody(ctx);
    const params = { peerKey: peerParam(b.peer) };
    const fn = await caps('dialogDelete');
    okCtx(ctx);
    ctx.body = await fn(params);
  } catch (e) { fail(ctx, e); }
});

// —— ⑪ POST /read-mentions @ 提及全部已读:{ok:true} ——
telegramExtrasRouter.post('/read-mentions', async (ctx) => {
  try {
    const b = jsonBody(ctx);
    const params = { peerKey: peerParam(b.peer) };
    const fn = await caps('readMentions');
    okCtx(ctx);
    ctx.body = await fn(params);
  } catch (e) { fail(ctx, e); }
});

// —— ⑫ GET /chat-header 聊天头部:{title,subtitle,memberCount,onlineCount,
//      unreadMentionsCount,pinnedMessageId}(缺失字段 null,页面退现有头部) ——
telegramExtrasRouter.get('/chat-header', async (ctx) => {
  try {
    const q = new URLSearchParams(ctx.querystring);
    const params = { peerKey: peerParam(q.get('peer')) };
    const fn = await caps('chatHeader');
    okCtx(ctx);
    ctx.body = await fn(params);
  } catch (e) { fail(ctx, e); }
});
