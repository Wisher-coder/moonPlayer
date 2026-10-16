// ============================================================================
// writes.js —— teleproto 引擎写侧(send / callback / vote / read 四端点域)
// ----------------------------------------------------------------------------
// 契约与 TDLib 版一致:send() → 契约消息(路由层包 {message});sendBotCallback()
// → {answer:{message,alert,url}|null, message};sendPollVote() → 契约消息;
// markChatRead() → {ok:true}。
//
// 与 TDLib 版的有意差异(切库即切实现,注释留档):
//   · send 回执即最终 id:MTProto messages.sendMessage 经 teleproto 解析回
//     完整 Api.Message(真实 id)——TDLib 时代的「临时 id + updateMessageSend
//     Succeeded 对账重映射」整链删除;自身消息在事件环的回声经 isSelfSent
//     近期发送表去重(engine 接线到 updates 端口);
//   · 投票 options 直通不透明 bytes:归一化层把 PollAnswer.option(bytes)
//     base64 直通,端点原样解码回 Buffer 传 messages.SendVote——TDLib 版的
//     「序号 base64 假码」编解码层(pollOptionIdsFromB64)删除;
//   · 回调 data(bytes)base64 直通(InlineButtonTypeCallback.data,契约
//     形态与 TDLib JSON bytes 天然一致)。
//
// MTProto 方法(teleproto Api 类;layer 230):
//   messages.SendVote{peer,msgId,options:bytes[]} / GetBotCallbackAnswer{peer,
//   msgId,data?:bytes,game?:true} → BotCallbackAnswer{message,alert,url} /
//   markAsRead(entity,{maxId})(channel→channels.readHistory,chat→
//   messages.readHistory,teleproto 内部分流)。
//
// 防风暴红线(同 TDLib 版):上游失败如实上抛中文错误,绝不自动重试;
// 回调/投票后的编辑同步是有界等待(400/900ms 阶梯、总上限 1300ms、≤2 次
// 拉取,EDIT_SYNC_STAIR_MS 禁止追加);唯一内部状态是近期发送表(有界 256,
// 供事件环去重,防泄漏)。
// ============================================================================
import { isPeerKey, TgNotLoggedInError, localMsgIdOf } from './shared.js';
import { normTgClientError } from './tg-client.js';
import * as defaultLib from 'teleproto';

// ============ 通用小工具 ============

// 带状态的业务错误(4xx 客户端参数语义;路由层 catch 统一按 err.status||502 回包)
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ============ 编辑同步阶梯常量 ============

// 阶梯间隔 400/900ms:唯一计时来源,总时长上限 = 400+900 = 1300ms(约 1.3 秒),
// 即最多 2 次强拉;加长数组会突破上限、触碰「绝不无界等待」红线,禁止追加。
export const EDIT_SYNC_STAIR_MS = [400, 900];
export const EDIT_SYNC_CAP_MS = 400 + 900;

// ============ MTProto error → 中文(写侧共用映射段) ============

/**
 * teleproto 异常(RPCError:.errorMessage/.code;FloodWaitError:.seconds)→
 * 面向用户的中文错误。子串匹配;文案与 TDLib 版逐字一致。纯大写错误码
 * 统一加「Telegram 接口错误:」前缀,人话原文透传。
 */
export function mapTgError(e) {
  if (e instanceof TgNotLoggedInError) return e;
  const code = Number(e && e.code) || 0;
  const msg = String((e && (e.errorMessage ?? e.message)) || e || '');
  // 慢速模式:SLOWMODE_WAIT_30
  const slow = /SLOWMODE_WAIT_?(\d*)/.exec(msg);
  if (slow) return new Error('慢速模式限制中,请约 ' + (Number(slow[1]) || 30) + ' 秒后再发送');
  const flood = /^FLOOD_WAIT_(\d+)/.exec(msg) || /^FLOOD_PREMIUM_WAIT_(\d+)/.exec(msg);
  if (flood) {
    const err = new Error(`Telegram 限流(FLOOD_WAIT),请约 ${Number(flood[1])} 秒后再试`);
    err.isFlood = true;
    return err;
  }
  if (e instanceof defaultLib.errors.FloodWaitError) {
    const err = new Error(`Telegram 限流(FLOOD_WAIT),请约 ${e.seconds || 60} 秒后再试`);
    err.isFlood = true;
    return err;
  }
  if (code === 429) {
    const err = new Error('Telegram 限流(FLOOD_WAIT),请约 60 秒后再试');
    err.isFlood = true;
    return err;
  }
  if (/CHAT_WRITE_FORBIDDEN/.test(msg)) return new Error('该对话不允许发言(无权限或频道只读)');
  if (/CHAT_SEND_PLAIN_FORBIDDEN/.test(msg)) return new Error('该对话禁止发送纯文本消息');
  if (/MSG_TOO_LONG/.test(msg)) return new Error('消息过长(Telegram 上限 4096 字)');
  if (/USER_IS_BOT/.test(msg)) return new Error('机器人账号不能作为私聊对象');
  if (/PEER_FLOOD/.test(msg)) return new Error('操作过于频繁,触发 Telegram 风控,请稍后再试');
  if (/BOT_WRITE_FORBIDDEN/.test(msg)) return new Error('该机器人暂时无法接收消息(可能已停用)');
  // 登录/账号态
  if (/^API_ID_INVALID$/.test(msg) || /API_ID_PUBLISHED/.test(msg)) {
    return new Error('api_id/api_hash 无效:Telegram 已封禁公开/他人客户端凭据(如 Telegram Desktop 的 611335),请到 my.telegram.org 申请自己的凭据并填入 server/.env');
  }
  if (/PHONE_NUMBER_INVALID/.test(msg)) return new Error('手机号格式不正确(应含国际区号,如 +8613800138000)');
  if (/PHONE_CODE_INVALID/.test(msg)) return new Error('验证码不正确,请重试');
  if (/PHONE_CODE_EXPIRED/.test(msg)) return new Error('验证码已过期,请重新发送');
  if (/PHONE_NUMBER_TOO_MANY_REQUESTS|AUTH_RESTART/.test(msg)) return new Error('发送验证码过于频繁,请几分钟后再试');
  if (/PASSWORD_HASH_INVALID/.test(msg)) return new Error('两步验证密码不正确,请重试');
  if (/SESSION_REVOKED|USER_DEACTIVATED/.test(msg)) return new Error('账号状态异常(被冻结/停用),请在官方客户端确认');
  // 游戏按钮回调:契约面无法供给 game_short_name
  if (/game short name/i.test(msg)) return new Error('暂不支持游戏按钮回调');
  if (code === 420) return new Error('Telegram 限流,请稍后再试');
  if (/^[A-Z_0-9]+$/.test(msg)) return new Error('Telegram 接口错误:' + msg);
  return normTgClientError(e, defaultLib);
}

// TDLib 时代函数名兼容别名(dialogs/extras 等历史引用点逐步更名;单一实现)
export const mapTdlibError = mapTgError;

// ============ 编辑指纹(MTProto 原生 message,写侧共用) ============

// 统一按钮 schema(layer 229+)的按键类型短标(InlineButtonType* / ButtonType*)
function buttonTypeKeyOf(t) {
  const cn = (t && t.className) || 'unknown';
  if (cn === 'InlineButtonTypeCallback') return 'cb';
  if (cn === 'InlineButtonTypeCallbackGame') return 'cbgame';
  if (cn === 'InlineButtonTypeUrl') return 'url';
  if (cn === 'InlineButtonTypeCopy') return 'copy';
  if (cn === 'InlineButtonTypeWebView') return 'webapp';
  if (cn === 'InlineButtonTypeSwitchInline') return 'switch';
  if (cn === 'InlineButtonTypeBuy') return 'buy';
  if (cn === 'InlineButtonTypeUserProfile') return 'user';
  return cn.replace(/^(Inline)?ButtonType/, '').toLowerCase() || 'unknown';
}

/**
 * replyMarkup → 键盘内容摘要(仅长度/计数,内容无关、不泄漏按钮文案与 URL):
 * rows 数/每行按钮数序列/文案长度合计/末按钮文案长度/类型计数直方图。
 * bot 分两步编辑(先正文后键盘)时,键盘内容差异同样改变指纹(B1 修复语义
// 延续——markup-only 编辑未必刷新 edit_date)。统一按钮 schema 双形态
 * (ReplyInlineMarkup/ReplyKeyboardMarkup)共用;Hide/ForceReply 无行无按钮,
 * 与无键盘同摘要。
 */
export function keyboardDigestOf(replyMarkup) {
  if (!replyMarkup || !Array.isArray(replyMarkup.rows)) return 'rm=0|rn=|t=0|last=0|none';
  const rowCounts = [];
  const typeCounts = new Map();
  let totalLen = 0;
  let lastLen = 0;
  for (const row of replyMarkup.rows) {
    const buttons = (row && Array.isArray(row.buttons)) ? row.buttons : [];
    rowCounts.push(buttons.length);
    for (const b of buttons) {
      const len = String((b && b.text) || '').length;
      totalLen += len;
      lastLen = len; // 顺序遍历,循环结束留存的即「末按钮」
      const key = buttonTypeKeyOf(b && b.type);
      typeCounts.set(key, (typeCounts.get(key) || 0) + 1);
    }
  }
  const hist = [...typeCounts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, n]) => k + ':' + n)
    .join(',');
  return 'rm=' + replyMarkup.rows.length + '|rn=' + rowCounts.join(',') + '|t=' + totalLen
    + '|last=' + lastLen + '|' + (hist || 'none');
}

/**
 * MTProto message → 轻量指纹:editDate / 正文长度 / entity 数量 / 键盘内容
 * 摘要 / 媒体类名(投票再追加 totalVoters:票数变化未必刷新 edit_date)。
 * 内容无关、不泄漏正文。
 */
export function editFingerprintOf(raw) {
  if (!raw || !raw.id) return 'gone';
  let mediaSignal = raw.action ? 'service' : String((raw.media && raw.media.className) || 'none');
  if (raw.media && raw.media.className === 'MessageMediaPoll') {
    mediaSignal += ':voters=' + (Number(raw.media.results && raw.media.results.totalVoters) || 0);
  }
  return [
    'edit=' + (Number(raw.editDate) || 0),
    'len=' + String(raw.message || '').length,
    'ent=' + ((raw.entities || []).length),
    keyboardDigestOf(raw.replyMarkup),
    'media=' + mediaSignal,
  ].join('|');
}

// ============ 投票选项编解码(契约 base64 ⇔ MTProto 不透明 bytes) ============

/**
 * 契约的投票选项(options:base64 列表,归一化层对 PollAnswer.option 的直通)
 * → Buffer[](messages.SendVote 原样消费)。空项跳过、全空 400——与旧口径
 * 同语义(TDLib 版的序号解码层已删,bytes 天然直通)。
 */
export function pollOptionsFromB64(optionsB64) {
  const list = Array.isArray(optionsB64) ? optionsB64 : [];
  const out = [];
  for (const x of list) {
    const s = String(x || '');
    if (!s) continue; // 空项跳过
    try {
      const buf = Buffer.from(s, 'base64');
      if (buf.length) out.push(buf);
    } catch (_e) { /* 非法 base64 按空项跳过(宁可不投也不误投) */ }
  }
  if (!out.length) throw httpError(400, '投票选项不能为空');
  return out;
}

// ============ 域工厂(注入依赖,产出 facade 四方法) ============

/**
 * 装配写侧域。
 * @param {object} deps
 *   getClient       async () => teleproto client(engine 注入,每次现取)
 *   entityOf        async (peerKey) => entity(dialogs 域共享口;'saved'→'me')
 *   normalizeMessage(pk, msg) → 契约消息(normalize.js 归一化;engine 装配
 *                   makeNormalizeFaces 注入——peerKey 由消息 peerId 反解)
 *   getMessageRaw   可选 (peerKey,msgId,force) → 原始 message(messages.js
 *                   缓存版;缺省经 client.getMessages 强拉)
 *   sleep/now       可注入(编辑同步阶梯测试用)
 */
export function createTgWrites(deps) {
  const d = deps || {};
  if (typeof d.getClient !== 'function') {
    throw new Error('teleproto 写侧初始化失败:缺少 getClient 依赖(注入契约见 writes.js 头注)');
  }
  if (typeof d.entityOf !== 'function') {
    throw new Error('teleproto 写侧初始化失败:缺少 entityOf 依赖(dialogs 域共享口)');
  }
  if (typeof d.normalizeMessage !== 'function') {
    throw new Error('teleproto 写侧初始化失败:缺少 normalizeMessage 依赖(normalize.js 注入)');
  }
  const normalizeMessage = d.normalizeMessage;
  const getMessageRaw = typeof d.getMessageRaw === 'function'
    ? d.getMessageRaw
    : async (peerKey, msgId) => {
      const client = await d.getClient();
      const entity = await d.entityOf(peerKey);
      const msgs = await client.getMessages(entity, { ids: [localMsgIdOf(msgId)] });
      return msgs && msgs[0];
    };
  const sleep = typeof d.sleep === 'function' ? d.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const now = typeof d.now === 'function' ? d.now : () => Date.now();

  // —— 近期发送表:'<peerKey>:<msgId>' → 时间戳(事件环自身消息回声去重;
  //    TDLib 时代的 pendingSends 对账表已删——回执即最终 id) ——
  const RECENT_TTL = 60e3;
  const RECENT_MAX = 256;
  const recentSent = new Map();
  function noteSelfSent(peerKey, msgId) {
    const key = peerKey + ':' + msgId;
    recentSent.set(key, now());
    while (recentSent.size > RECENT_MAX) recentSent.delete(recentSent.keys().next().value);
  }
  function isSelfSent(peerKey, msgId) {
    const at = recentSent.get(peerKey + ':' + msgId);
    if (at == null) return false;
    if (now() - at > RECENT_TTL) { recentSent.delete(peerKey + ':' + msgId); return false; }
    return true;
  }

  /** raw invoke 包装:错误统一 mapTgError 中文化(不自动重试) */
  async function invoke(peerKey, build) {
    const client = await d.getClient();
    const entity = await d.entityOf(peerKey);
    const inputPeer = client.getInputEntity(entity);
    try {
      return await client.invoke(build(inputPeer, client));
    } catch (e) {
      throw mapTgError(e);
    }
  }

  // 最小回执:响应缺 id 或归一化意外失败时兜底——发送本身已成功,绝不二次重发。
  function minimalReceipt(peerKey, text) {
    return {
      id: 0, peerKey, kind: 'message',
      date: new Date().toISOString(), out: true, views: null,
      from: null, text: String(text || ''), entities: [],
      groupedId: null, forward: null, viaBot: null, signature: null, replyTo: null,
      media: null, inlineKeyboard: null, replyKeyboard: null, service: null,
    };
  }

  // —— 回调/投票后的「有界等待-校验」强拉(语义同 TDLib 版:等待 bot 对消息
  //    的编辑在服务端可见的有界同步,不是错误重试;阶梯 400/900ms、总上限
  //    ~1.3 秒、≤2 次拉取;等满仍相同就如实返回当前状态) ——
  async function refetchEditedMessage(peerKey, msgId) {
    const id = localMsgIdOf(msgId);
    let before = null;
    try {
      before = editFingerprintOf(await getMessageRaw(peerKey, id, false));
    } catch (_e) { /* 基线拉不到不影响流程:before=null 必不等于任何指纹 */ }
    const deadline = now() + EDIT_SYNC_CAP_MS; // 总时长硬上限
    let raw = null;
    for (const waitMs of EDIT_SYNC_STAIR_MS) { // 有界循环:至多 2 次
      if (now() >= deadline) break;
      await sleep(waitMs);
      raw = await getMessageRaw(peerKey, id, true);
      if (editFingerprintOf(raw) !== before) break; // 编辑已落地:提前返回
    }
    if (!raw || !raw.id) throw new Error('该 Telegram 消息不存在或已被删除');
    return normalizeMessage(peerKey, raw);
  }

  // ============ ① 发送纯文本(send) ============

  /**
   * 发送纯文本(teleproto sendMessage;仅文本,不做媒体上传——契约一致)。
   * 前置校验同旧口径:空/超 4096 字 400,不发上游;linkPreview:false 对齐
   * 旧 linkPreview:false(纯文本不抓网页预览);parseMode 已在客户端级关闭
   * (tg-client.js),原文即所发。回执即最终 id(MTProto 天然),登记近期
   * 发送表供事件环去重。
   */
  async function send(peerKey, text, replyTo) {
    if (!isPeerKey(peerKey)) throw httpError(400, 'Telegram 对话 id 非法:' + peerKey);
    const body = String(text == null ? '' : text);
    if (!body.trim()) throw httpError(400, '消息内容不能为空');
    if (body.length > 4096) throw httpError(400, '消息过长(Telegram 上限 4096 字)');
    const replyId = replyTo ? localMsgIdOf(replyTo) : undefined;
    const client = await d.getClient();
    const entity = await d.entityOf(peerKey);
    let raw;
    try {
      raw = await client.sendMessage(entity, {
        message: body,
        linkPreview: false,
        ...(replyId ? { replyTo: replyId } : {}),
      });
    } catch (e) {
      throw mapTgError(e);
    }
    if (raw && raw.id) {
      noteSelfSent(peerKey, Number(raw.id));
      try {
        return normalizeMessage(peerKey, raw);
      } catch (_e) {
        return minimalReceipt(peerKey, body); // 归一化意外失败:精简回执兜底,绝不重发
      }
    }
    return minimalReceipt(peerKey, body); // 响应缺 id(理论不发生):占位,绝不重发
  }

  // ============ ② bot 内联键盘回调(callback) ============

  /**
   * 触发 bot 内联键盘回调(messages.GetBotCallbackAnswer;普通按钮 data 为
   * base64 → bytes 直通,game 按钮携 game: true——契约面无法供给
   * game_short_name,上游拒绝时 mapTgError 已把「game short name」类错误
   * 契约化为中文降级)。answer 映射 {message,alert,url}(BotCallbackAnswer
   * 字段天然同名);三者全空 → answer=null。随后经 refetchEditedMessage
   * 有界等待 bot 对原消息的编辑在服务端可见后强拉回传;重拉失败不阻塞
   * answer(消息编辑可能在别的会话窗口生效)。
   */
  async function sendBotCallback(peerKey, msgId, dataB64, game) {
    if (!isPeerKey(peerKey)) throw httpError(400, 'Telegram 对话 id 非法:' + peerKey);
    const id = localMsgIdOf(msgId);
    const { Api } = defaultLib;
    const r = await invoke(peerKey, (peer) => new Api.messages.GetBotCallbackAnswer({
      peer,
      msgId: id,
      ...(game
        ? { game: true }
        : { data: Buffer.from(String(dataB64 || ''), 'base64') }),
    }));
    const answer = r && ((r.message && String(r.message)) || r.url || r.alert)
      ? { message: String(r.message || ''), alert: Boolean(r.alert), url: r.url ? String(r.url) : null }
      : null;
    let message = null;
    try {
      message = await refetchEditedMessage(peerKey, id); // 有界等待编辑可见(见 helper 头注)
    } catch (_e) { /* 重拉失败不阻塞 answer */ }
    return { answer, message };
  }

  // ============ ③ 投票(vote) ============

  /**
   * 投票(messages.SendVote;options 为归一化层直通的 base64 不透明 bytes,
   * 解码回 Buffer 原样回传,多选传多个)。投票后经 refetchEditedMessage
   * 有界等待结果编辑在服务端可见再强拉回传;失败如实上抛(不吞)。
   */
  async function sendPollVote(peerKey, msgId, optionsB64) {
    if (!isPeerKey(peerKey)) throw httpError(400, 'Telegram 对话 id 非法:' + peerKey);
    const id = localMsgIdOf(msgId);
    const options = pollOptionsFromB64(optionsB64);
    const { Api } = defaultLib;
    await invoke(peerKey, (peer) => new Api.messages.SendVote({
      peer,
      msgId: id,
      options,
    }));
    return await refetchEditedMessage(peerKey, id); // 有界等待编辑可见;失败如实上抛
  }

  // ============ ④ 已读同步(read) ============

  /**
   * 已读同步(teleproto markAsRead(entity,{maxId});channel→
   * channels.readHistory、chat/user→messages.readHistory,库内分流)。已读
   * 水位推进以 UpdateReadHistoryInbox/UpdateReadChannelInbox 回流为准
   * (updates 域转 peer patch,写侧不再做事)。
   */
  async function markChatRead(peerKey, maxId) {
    if (!isPeerKey(peerKey)) throw httpError(400, 'Telegram 对话 id 非法:' + peerKey);
    if (!Number.isSafeInteger(maxId) || maxId <= 0) throw httpError(400, '已读消息 id 非法');
    const id = localMsgIdOf(maxId);
    const client = await d.getClient();
    const entity = await d.entityOf(peerKey);
    try {
      await client.markAsRead(entity, undefined, { maxId: id });
    } catch (e) {
      throw mapTgError(e);
    }
    return { ok: true };
  }

  return {
    send,
    sendBotCallback,
    sendPollVote,
    markChatRead,
    isSelfSent, // updates 端口:自身消息回声去重(engine 接线)
  };
}
