// ============================================================================
// extras.js —— teleproto 引擎增量能力域(搜索/日历/转发/置顶/编辑/删除/
//              对话动作/提及已读/聊天头部;仅 Node 服务端运行)
// ----------------------------------------------------------------------------
// 契约与 TDLib 版一致(12 端点;输出形状/中文错误文案对齐)。MTProto 原生
// 调用映射(teleproto Api,layer 230;请求形参收 EntityLike,库内解析 peer):
//   searchInChat     messages.Search{peer,q,fromId?,filter?,minDate?,maxDate?,
//                    offsetId(排他,契约 MTProto 口径天然对齐),limit+1 探测}
//   searchGlobal     messages.SearchGlobal{q,filter,offsetRate/offsetPeer/
//                    offsetId 三元组游标(nextOffset 加性字段序列化携带)}
//   calendar         messages.GetSearchResultsCalendar{peer,filter:PhotoVideo|
//                    Empty} → periods[{date,count,maxMsgId}](服务端按日聚合,
//                    TDLib 时代的服务端日历同源能力;thumbs 取 messages[] 内
//                    每期样本消息)
//   forward          client.forwardMessages(dropAuthor=hideNames/
//                    dropMediaCaptions=hideCaptions/silent)
//   pin/unpin        messages.UpdatePinnedMessage{peer,id,silent,unpin}
//   pinned           iterMessages({filter:InputMessagesFilterPinned})
//   edit             messages.EditMessage{peer,id,message,noWebpage}
//   delete           channels.DeleteMessages{channel,id} | messages.DeleteMessages
//                    {id,revoke}(按会话形态分流)
//   dialog update    pinned→messages.ToggleDialogPin;muted→account.
//                    UpdateNotifySettings(muteUntil);unread→messages.
//                    MarkDialogUnread;archived→client.editPeerFolders(1|0)
//   dialog delete    messages.DeleteHistory{peer,justClear:false,revoke:true}
//   read mentions    messages.ReadMentions{peer}
//   chat header      messages.GetPeerDialogs + entity(status/fullChat 人数/
//                    onlineCount——TDLib 版 onlineCount 恒 null,MTProto 原生有)
//
// 与 TDLib 版的有意差异(注释留档):
//   · searchInChat 的 minDate/maxDate 从 501(不支持)变为原生支持
//     (messages.Search 自带日期参数);
//   · 会话内搜索锚(offsetId)从「含锚+响应侧剔除」变为原生排他,无须 +1
//     锚剔除补偿;
//   · searchGlobal 分页从 TDLib 不透明 next_offset 串变为三元组游标
//     (rate|markedId|accessHash|msgId 序列化在 nextOffset 加性字段里,对
//     客户端仍是不透明令牌)。
//
// 防风暴红线(同 TDLib 版):一切上游失败如实上抛中文错误(extrasError →
// writes.mapTgError 兜底),绝不自动重试;搜索结果发送者解析走本地缓存,
// 绝不逐条回源;无写侧阶梯(编辑直回完整消息)。
// ============================================================================
import { isPeerKey, thumbToken, photoToken, videoIdOf, localMsgIdOf } from './shared.js';
import { normTgClientError } from './tg-client.js';
import {
  contractUserOf, chatIdToPeerKey, peerKeyOfPeer, imgOf,
  normalizeOne, unsupportedPlaceholder,
} from './normalize.js';
import { mapTgError } from './writes.js';
import * as defaultLib from 'teleproto';

// ============================================================================
// ============ 通用小工具 ============

// 带状态的业务错误(4xx/5xx;路由层 catch 统一按 err.status||502 回包)
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// extras 域错误中文化:先过本域权限/编辑类码表,再落写侧共用映射
function extrasError(e) {
  if (e instanceof Error && e.status) return e; // 本域已中文化的业务错误直通
  const msg = String((e && (e.errorMessage ?? e.message)) || e || '');
  if (/RIGHT_FORBIDDEN|CHAT_ADMIN_REQUIRED|CHAT_PIN_FORBIDDEN/.test(msg)) {
    return new Error('没有权限执行该操作(需要群/频道管理员权限)');
  }
  if (/MESSAGE_DELETE_FORBIDDEN/.test(msg)) return new Error('没有权限删除该消息');
  if (/MESSAGE_EDIT_FORBIDDEN|MESSAGE_NOT_MODIFIED/.test(msg)) {
    return new Error('该消息不允许编辑(仅自己的纯文本消息可编辑)');
  }
  if (/CHAT_FORWARDS_RESTRICTED/.test(msg)) return new Error('该对话内容受保护,禁止转发');
  return mapTgError(e);
}

// ============ 纯函数:月份窗口与日期串(UTC 口径) ============

export const MONTH_RE = /^(\d{4})-(\d{2})$/;

/** 合法月份 → {month,startSec,endSec}(当月 1 日 0 点 UTC 起,左闭右开);非法回 null */
export function monthWindowUtc(month) {
  const m = MONTH_RE.exec(String(month || '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const startSec = Math.floor(Date.UTC(y, mo - 1, 1) / 1000);
  const endSec = Math.floor(Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1) / 1000);
  return { month: `${m[1]}-${m[2]}`, startSec, endSec };
}

/** unix 秒 → 'YYYY-MM-DD'(UTC) */
export function ymdOf(sec) {
  const d = new Date(Number(sec) * 1000);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

// ============================================================================
// ============ 纯函数:搜索参数(契约层校验/钳制) ============

export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_LIMIT_DEFAULT = 20;

/** 搜索 limit 钳制:正整数,缺省 20,上限 50 */
export function clampSearchLimit(v, dflt = SEARCH_LIMIT_DEFAULT) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(SEARCH_LIMIT_MAX, n);
}

// fromId(发送者)形态:'u<id>' / 纯数字;返回十进制串,非法回 ''
export function senderIdFrom(fromId) {
  const s = String(fromId == null ? '' : fromId).trim();
  const m = /^u(\d+)$/.exec(s) || /^(\d+)$/.exec(s);
  return m ? m[1] : '';
}

// /search 媒体过滤参数 → MTProto InputMessagesFilter* 类名
export const SEARCH_MEDIA_FILTERS = {
  photo: 'InputMessagesFilterPhotos',
  video: 'InputMessagesFilterVideo',
  photoVideo: 'InputMessagesFilterPhotoVideo',
  document: 'InputMessagesFilterDocument',
  url: 'InputMessagesFilterUrl',
  voice: 'InputMessagesFilterVoice',
};

/** 会话内搜索响应归一(+1 探测位判 completed;锚排他由 offsetId 原生保证) */
export function normalizeSearchChatPage({ msgs, peerKey, offsetId, limit, users }) {
  const anchor = Number(offsetId) || 0;
  const rawAll = (msgs || []).filter((m) => m && m.id && m.className !== 'MessageEmpty');
  const raw = anchor > 0 ? rawAll.filter((m) => Number(m.id) < anchor) : rawAll; // 防御性(排他已由服务端保证)
  const page = raw.slice(0, limit);
  const items = page.map((m) => {
    try {
      return normalizeOne(peerKey, m, { users: users || new Map(), replies: new Map() });
    } catch (_e) {
      return unsupportedPlaceholder(peerKey, m);
    }
  });
  return {
    messages: items,
    completed: rawAll.length <= limit,
  };
}

// ============ 纯函数:全局搜索游标序列化(不透明令牌) ============

/**
 * 三元组游标(rate|markedId|accessHash|msgId)↔ 令牌串。markedId 即 shared
 * markedOf 数值空间(频道 -100xxx/群 -xxx/用户 xxx);accessHash 随令牌携带,
 * 重建 InputPeer 免回源(令牌对客户端不透明)。
 */
export function encodeGlobalCursor(rate, markedId, accessHash, msgId) {
  return [Number(rate) || 0, Number(markedId) || 0, String(accessHash || '0'), Number(msgId) || 0].join('|');
}

export function decodeGlobalCursor(token) {
  const parts = String(token || '').split('|');
  if (parts.length !== 4) return null;
  const [rate, markedId, accessHash, msgId] = parts;
  if (!/^-?\d+$/.test(markedId) || !/^\d+$/.test(msgId)) return null;
  return { rate: Number(rate), markedId: Number(markedId), accessHash: String(accessHash), msgId: Number(msgId) };
}

/** markedId + accessHash → InputPeer(用户/群/频道三分支;accessHash=0 回 null 走 Empty) */
export function inputPeerOfCursor(Api, markedId, accessHash) {
  const ah = String(accessHash || '0');
  if (markedId > 0) return new Api.InputPeerUser({ userId: markedId, accessHash: ah });
  if (markedId <= -1000000000000) {
    return new Api.InputPeerChannel({ channelId: -markedId - 1000000000000, accessHash: ah });
  }
  if (markedId < 0) return new Api.InputPeerChat({ chatId: -markedId });
  return null;
}

/** 响应实体池 → last.peerId 的 (markedId, accessHash)(游标重建材料) */
export function cursorOfMessage(peer, pool) {
  if (!peer) return null;
  if (peer.className === 'PeerUser') {
    const u = pool.find((x) => x.className === 'User' && String(x.id) === String(peer.userId));
    return u && u.accessHash != null ? { markedId: Number(peer.userId), accessHash: String(u.accessHash) } : null;
  }
  if (peer.className === 'PeerChat') {
    const c = pool.find((x) => /Chat/.test(x.className) && String(x.id) === String(peer.chatId));
    return c ? { markedId: -Number(peer.chatId), accessHash: '0' } : null;
  }
  if (peer.className === 'PeerChannel') {
    const c = pool.find((x) => /Channel/.test(x.className) && String(x.id) === String(peer.channelId));
    return c && c.accessHash != null
      ? { markedId: -(1000000000000 + Number(peer.channelId)), accessHash: String(c.accessHash) }
      : null;
  }
  return null;
}

// ============ 纯函数:日历归一 ============

/**
 * SearchResultsCalendar.periods[{date,count,maxMsgId}] → 本月升序 days
 * [{date:'YYYY-MM-DD',count,lastMessageId:maxMsgId}](TDLib 版语义锚:跳转
 * 锚定 id,GET /messages?dir=around 消费;maxMsgId 是当日最大 id,锚定语义
 * 与 TDLib 版「当日第一条消息」等价可用)。
 */
export function normalizeCalendarDays({ calendar, win }) {
  const days = [];
  const list = Array.isArray(calendar && calendar.periods) ? calendar.periods : [];
  for (const p of list) {
    const sec = Number(p && p.date) || 0;
    if (sec < win.startSec || sec >= win.endSec) continue; // 只留本月(入参倒序,过滤后重排)
    const ymd = ymdOf(sec);
    if (!ymd) continue;
    days.push({
      date: ymd,
      count: Number(p.count) || 0,
      lastMessageId: Number(p.maxMsgId) || 0,
    });
  }
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)); // 升序(TI 日历口径)
  return days;
}

/**
 * 媒体日历单日缩略令牌(纯函数;不触网):照片=photoToken m 档、视频/圆形
 * 视频/动图=thumbToken——与 normalize.mtMediaOf 的媒体判定同源。非媒体回 null。
 */
export function mediaThumbTokenOf(peerKey, msg) {
  const id = Number(msg && msg.id) || 0;
  if (!id || !isPeerKey(peerKey)) return null;
  const Api = defaultLib.Api;
  const media = msg.media;
  if (!media) return null;
  const videoId = videoIdOf(peerKey, id);
  if (media.className === 'MessageMediaPhoto' && media.photo instanceof Api.Photo) {
    return photoToken(videoId, 'm', false);
  }
  if (media.className === 'MessageMediaDocument' && media.document instanceof Api.Document) {
    let video = false; let animated = false;
    for (const a of media.document.attributes || []) {
      if (a.className === 'DocumentAttributeVideo') video = true;
      else if (a.className === 'DocumentAttributeAnimated') animated = true;
    }
    if (video || animated) return thumbToken(videoId);
  }
  return null;
}

// ============ 纯函数:在线状态人话(MTProto UserStatus*;私聊头部副标题) ============

export function statusTextOf(status) {
  const t = status && status.className;
  if (t === 'UserStatusOnline') return '在线';
  if (t === 'UserStatusRecently') return '最近在线';
  if (t === 'UserStatusLastWeek') return '一周内在线';
  if (t === 'UserStatusLastMonth') return '上月在线';
  if (t === 'UserStatusOffline') {
    const sec = Number(status.wasOnline) || 0;
    return sec > 0 ? '最后上线 ' + ymdOf(sec) : '离线';
  }
  return null; // UserStatusEmpty/未知:副标题缺省
}

// ============================================================================
// ============ 域工厂(注入 getClient/entityOf/getSelfId/log,产出 12 能力) ============

export function createTgExtras({ getClient, entityOf, getSelfId, log } = {}) {
  if (typeof getClient !== 'function') {
    throw new Error('teleproto 增量域初始化失败:缺少 getClient 依赖(注入契约见 extras.js 头注)');
  }
  if (typeof entityOf !== 'function') {
    throw new Error('teleproto 增量域初始化失败:缺少 entityOf 依赖(dialogs 域共享口)');
  }
  const selfId = typeof getSelfId === 'function' ? getSelfId : () => '';
  const warn = typeof log === 'function' ? log : (() => {});
  const Api = defaultLib.Api;

  async function call(fn) {
    const client = await getClient();
    try {
      return await fn(client);
    } catch (e) {
      throw extrasError(e);
    }
  }

  // —— 发送者解析(搜索结果行「发送者名+摘要」依赖;缓存+绝不抛) ——
  const USERS_TTL = 10 * 60e3;
  const USERS_CACHE_MAX = 1000;
  const usersCache = new Map();

  async function userInfoOf(userId) {
    const key = String(userId);
    const hit = usersCache.get(key);
    if (hit && Date.now() - hit.at < USERS_TTL) return hit.info;
    let info = null;
    try {
      const client = await getClient();
      const u = await client.getEntity(key);
      info = contractUserOf(u, selfId());
    } catch (_e) { /* 解析失败:占位,不上抛 */ }
    if (!info || info.id == null) info = { id: key, name: '用户 ' + key, isBot: false, username: '', avatar: null };
    usersCache.set(key, { info, at: Date.now() });
    if (usersCache.size > USERS_CACHE_MAX) usersCache.delete(usersCache.keys().next().value);
    return info;
  }

  /** 收集一页消息的发送者并预解析 → ctx.users Map */
  async function collectUsers(msgs) {
    const ids = new Set();
    for (const m of msgs || []) {
      const p = m && m.fromId;
      if (p && p.className === 'PeerUser' && Number(p.userId) > 0) ids.add(String(p.userId));
    }
    const users = new Map();
    await Promise.all([...ids].map(async (id) => { users.set(id, await userInfoOf(id)); }));
    return users;
  }

  // ============ ① 会话内搜索(GET /search) ============

  /**
   * messages.Search{peer, q, fromId?, filter?, minDate/maxDate?, offsetId(排他),
   * limit+1 探测}。minDate/maxDate(YYYY-MM-DD 或 unix 秒)原生支持(原 TDLib
   * 版 501 的差异点,见文件头)。返回 {messages,completed}(契约形状;id 降序)。
   */
  async function searchInChat(params = {}) {
    if (!isPeerKey(params.peerKey)) throw httpError(400, '参数 peer 非法:' + params.peerKey);
    const q = String(params.q == null ? '' : params.q).trim();
    const fromId = senderIdFrom(params.fromId);
    if (params.fromId && !fromId) throw httpError(400, '参数 fromId 非法(应为用户 id 或 u<id>):' + params.fromId);
    const filterType = String(params.filter == null ? '' : params.filter).trim();
    if (filterType && !SEARCH_MEDIA_FILTERS[filterType]) {
      throw httpError(400, '参数 filter 非法(应为 photo|video|photoVideo|document|url|voice):' + filterType);
    }
    if (!q && !fromId && !filterType) {
      throw httpError(400, '搜索条件不能为空(关键词、发送者或媒体过滤器至少其一)');
    }
    const limit = clampSearchLimit(params.limit);
    const offsetId = localMsgIdOfSafe(params.offsetId);
    const entity = await entityOf(params.peerKey);
    const raw = await call(async (client) => {
      const inputPeer = await client.getInputEntity(entity);
      return client.invoke(new Api.messages.Search({
        peer: inputPeer,
        q,
        fromId: fromId ? await client.getInputEntity(Number(fromId)) : undefined,
        filter: filterType ? new Api[SEARCH_MEDIA_FILTERS[filterType]]() : new Api.InputMessagesFilterEmpty(),
        minDate: dateToSec(params.minDate),
        maxDate: dateToSec(params.maxDate),
        offsetId,
        addOffset: 0,
        limit: Math.min(100, limit + 1), // +1 探测位(100 为 MTProto 上限)
        maxId: 0,
        minId: 0,
        hash: 0,
        topMsgId: undefined,
      }));
    });
    const msgs = Array.isArray(raw && raw.messages) ? raw.messages : [];
    const users = await collectUsers(msgs);
    return normalizeSearchChatPage({ msgs, peerKey: params.peerKey, offsetId, limit, users });
  }

  // ============ ② 全局搜索(GET /search/global) ============

  /**
   * messages.SearchGlobal{q, filter: Empty, minDate/maxDate?, 三元组游标}。
   * 分页令牌走契约的加性字段 nextOffset(不透明,encodeGlobalCursor)。
   */
  async function searchGlobal(params = {}) {
    const q = String(params.q == null ? '' : params.q).trim();
    if (!q) throw httpError(400, '搜索关键词不能为空');
    const limit = clampSearchLimit(params.limit);
    const cursor = params.offset ? decodeGlobalCursor(params.offset) : null;
    if (params.offset && !cursor) throw httpError(400, '参数 offset 非法(分页令牌已过期,请从第一页重新搜索)');
    const self = String(selfId() || '');
    const raw = await call(async (client) => {
      const offsetPeer = cursor && cursor.markedId
        ? (inputPeerOfCursor(Api, cursor.markedId, cursor.accessHash) || new Api.InputPeerEmpty())
        : new Api.InputPeerEmpty();
      return client.invoke(new Api.messages.SearchGlobal({
        q,
        filter: new Api.InputMessagesFilterEmpty(),
        minDate: dateToSec(params.minDate),
        maxDate: dateToSec(params.maxDate),
        offsetRate: cursor ? cursor.rate : 0,
        offsetPeer,
        offsetId: cursor ? cursor.msgId : 0,
        limit: Math.min(100, limit + 1),
      }));
    });
    const msgs = (Array.isArray(raw && raw.messages) ? raw.messages : [])
      .filter((m) => m && m.id && m.className !== 'MessageEmpty');
    const users = await collectUsers(msgs);
    const items = [];
    for (const m of msgs.slice(0, limit)) {
      const pk = peerKeyOfPeer(m.peerId, self);
      if (!pk) continue;
      try {
        items.push(normalizeOne(pk, m, { users, replies: new Map() }));
      } catch (_e) {
        items.push(unsupportedPlaceholder(pk, m));
      }
    }
    const completed = msgs.length <= limit;
    let nextOffset = null;
    if (!completed && msgs.length) {
      const last = msgs[limit - 1];
      const pool = [...((raw && raw.chats) || []), ...((raw && raw.users) || [])];
      const cur = cursorOfMessage(last.peerId, pool);
      if (cur) nextOffset = encodeGlobalCursor((raw && raw.nextRate) || 0, cur.markedId, cur.accessHash, Number(last.id));
    }
    return {
      messages: items,
      completed,
      nextOffset,   // 加性字段(分页令牌;客户端原样回传)
      nextRate: null, // 契约字段保留但恒 null(不可依赖)
    };
  }

  // ============ ③ 消息日历(GET /calendar) ============

  /**
   * messages.GetSearchResultsCalendar{peer, filter: PhotoVideo|Empty} →
   * periods[{date,count,maxMsgId}](服务端按日聚合)。type=media 时逐日附
   * thumb(calendar.messages[] 内每期样本消息直取令牌;缺样本按 lastMessageId
   * 经 getMessage 解引用兜底)。返回 {month,days}。
   */
  async function calendar(params = {}) {
    const win = monthWindowUtc(params.month);
    if (!win) throw httpError(400, '参数 month 格式不正确(应为 YYYY-MM)');
    if (!isPeerKey(params.peerKey)) throw httpError(400, '参数 peer 非法:' + params.peerKey);
    const type = String(params.type == null ? '' : params.type).trim();
    if (type && type !== 'media') throw httpError(400, '参数 type 非法(仅支持 media 媒体日历):' + type);
    const entity = await entityOf(params.peerKey);
    const isMedia = type === 'media';
    const raw = await call(async (client) => {
      const inputPeer = await client.getInputEntity(entity);
      return client.invoke(new Api.messages.GetSearchResultsCalendar({
        peer: inputPeer,
        filter: isMedia ? new Api.InputMessagesFilterPhotoVideo() : new Api.InputMessagesFilterEmpty(),
        offsetId: 0,
        offsetDate: 0,
      }));
    });
    const days = normalizeCalendarDays({ calendar: raw, win });
    if (isMedia) await attachDayThumbs(days, params.peerKey, raw);
    return { month: win.month, days };
  }

  /** 媒体日历逐日缩略:样本消息直取;缺样本经 getMessages 解引用;单日失败 null 不抛 */
  async function attachDayThumbs(days, peerKey, raw) {
    const stubs = new Map(); // lastMessageId(maxMsgId) → 样本消息
    for (const m of (Array.isArray(raw && raw.messages) ? raw.messages : [])) {
      if (m && m.id) stubs.set(Number(m.id), m);
    }
    await Promise.all(days.map(async (day) => {
      const id = Number(day.lastMessageId) || 0;
      try {
        let stub = id > 0 ? stubs.get(id) : null;
        if (!stub && id > 0) {
          const client = await getClient();
          const entity = await entityOf(peerKey);
          const got = await client.getMessages(entity, { ids: [id] });
          stub = got && got[0];
        }
        const token = stub ? mediaThumbTokenOf(peerKey, stub) : null;
        day.thumb = token ? imgOf(token) : null;
      } catch (e) {
        if (e && e.name === 'TgNotLoggedInError') throw e; // 全局登录态:不吞
        day.thumb = null; // 单日解析失败:降级 null,不抛不阻塞
      }
    }));
  }

  // ============ ④ 转发(POST /forward) ============

  /**
   * 转发到多个目标(client.forwardMessages;dropAuthor=hideNames 去转发头、
   * dropMediaCaptions=hideCaptions、silent)。串行逐目标(防风暴);回执 id
   * 取返回 Message[](teleproto 从 Updates 提取)。
   */
  async function forwardMessages(params = {}) {
    const targets = Array.isArray(params.toPeerIds) ? params.toPeerIds : [];
    if (!isPeerKey(params.peerKey)) throw httpError(400, '参数 peer 非法:' + params.peerKey);
    const ids = (Array.isArray(params.messageIds) ? params.messageIds : [])
      .map((x) => localMsgIdOfSafe(x))
      .filter((x) => x > 0);
    if (!ids.length) throw httpError(400, '参数 messageIds 必须是非空的正整数数组');
    if (!targets.length) throw httpError(400, '转发目标不能为空');
    if (new Set(targets).size !== targets.length) throw httpError(400, '转发目标不能重复');
    for (const t of targets) {
      if (!isPeerKey(t)) throw httpError(400, '转发目标非法:' + t);
    }
    const fromEntity = await entityOf(params.peerKey);
    const sent = [];
    for (const toPeerKey of targets) {
      const toEntity = await entityOf(toPeerKey);
      const out = await call((client) => client.forwardMessages(toEntity, {
        messages: ids,
        fromPeer: fromEntity,
        silent: Boolean(params.silent),
        dropAuthor: Boolean(params.hideNames),
        dropMediaCaptions: Boolean(params.hideCaptions),
      }));
      const outIds = (out || [])
        .map((m) => (m && m.className === 'Message' ? Number(m.id) : 0))
        .filter(Boolean);
      sent.push({ peerId: toPeerKey, messageIds: outIds });
    }
    return { sent };
  }

  // ============ ⑤ 置顶/取消置顶(POST /pin) ============

  /** messages.UpdatePinnedMessage{peer,id,silent,unpin}(置顶与取消同方法) */
  async function pinMessage(params = {}) {
    if (!isPeerKey(params.peerKey)) throw httpError(400, '参数 peer 非法:' + params.peerKey);
    const id = localMsgIdOfSafe(params.id);
    if (!id) throw httpError(400, '消息 id 非法');
    const entity = await entityOf(params.peerKey);
    await call(async (client) => {
      const inputPeer = await client.getInputEntity(entity);
      return client.invoke(new Api.messages.UpdatePinnedMessage({
        peer: inputPeer,
        id,
        silent: Boolean(params.silent),
        unpin: Boolean(params.unpin),
        pmOneside: false,
      }));
    });
    return { ok: true };
  }

  // ============ ⑥ 置顶列表(GET /pinned) ============

  /** 置顶消息列表(iterMessages + InputMessagesFilterPinned;单页返回) */
  async function pinnedMessages(params = {}) {
    if (!isPeerKey(params.peerKey)) throw httpError(400, '参数 peer 非法:' + params.peerKey);
    const limit = clampSearchLimit(params.limit);
    const entity = await entityOf(params.peerKey);
    const msgs = [];
    await call(async (client) => {
      for await (const m of client.iterMessages(entity, {
        filter: new Api.InputMessagesFilterPinned(),
        limit,
      })) {
        if (m && m.id && m.className !== 'MessageEmpty') msgs.push(m);
      }
    });
    const users = await collectUsers(msgs);
    return {
      messages: msgs.map((m) => {
        try {
          return normalizeOne(params.peerKey, m, { users, replies: new Map() });
        } catch (_e) {
          return unsupportedPlaceholder(params.peerKey, m);
        }
      }),
    };
  }

  // ============ ⑦ 编辑消息(POST /edit) ============

  /**
   * 编辑自己已发出的纯文本消息(messages.EditMessage{peer,id,message,
   * noWebpage:true} → 直回完整 Message,归一化即回执,无须补拉)。
   */
  async function editText(params = {}) {
    if (!isPeerKey(params.peerKey)) throw httpError(400, '参数 peer 非法:' + params.peerKey);
    const id = localMsgIdOfSafe(params.id);
    if (!id) throw httpError(400, '消息 id 非法');
    const body = String(params.text == null ? '' : params.text);
    if (!body.trim()) throw httpError(400, '消息内容不能为空');
    if (body.length > 4096) throw httpError(400, '消息过长(Telegram 上限 4096 字)');
    if (Array.isArray(params.entities) && params.entities.length) {
      throw httpError(400, '暂不支持带格式的编辑,请发送纯文本');
    }
    const entity = await entityOf(params.peerKey);
    const raw = await call(async (client) => {
      const inputPeer = await client.getInputEntity(entity);
      return client.invoke(new Api.messages.EditMessage({
        peer: inputPeer,
        id,
        message: body,
        noWebpage: true, // 对齐 send 的 linkPreview:false 口径
      }));
    });
    if (!raw || !raw.id) throw new Error('编辑结果异常(响应缺消息),请刷新后重试');
    try {
      return { message: normalizeOne(params.peerKey, raw, { users: new Map(), replies: new Map() }) };
    } catch (_e) {
      return { message: unsupportedPlaceholder(params.peerKey, raw) };
    }
  }

  // ============ ⑧ 删除消息(POST /delete) ============

  /**
   * 删除消息:频道/超群实体 → channels.DeleteMessages{channel,id};其余 →
   * messages.DeleteMessages{id,revoke}。deletedIds 回显请求 ids(上游只回 ok);
   * 删除事件经事件环 type:'delete'(updates 域),客户端原位移除幂等。
   */
  async function deleteMessages(params = {}) {
    if (!isPeerKey(params.peerKey)) throw httpError(400, '参数 peer 非法:' + params.peerKey);
    const ids = (Array.isArray(params.ids) ? params.ids : [])
      .map((x) => localMsgIdOfSafe(x))
      .filter((x) => x > 0);
    if (!ids.length) throw httpError(400, '参数 ids 必须是非空的正整数数组');
    if (ids.length > 100) throw httpError(400, '单次最多删除 100 条消息');
    const entity = await entityOf(params.peerKey);
    await call(async (client) => {
      if (entity && entity.className === 'Channel') {
        return client.invoke(new Api.channels.DeleteMessages({ channel: defaultLib.utils.getInputChannel(entity), id: ids }));
      }
      return client.invoke(new Api.messages.DeleteMessages({ id: ids, revoke: Boolean(params.revoke) }));
    });
    return { ok: true, deletedIds: ids };
  }

  // ============ ⑨ 对话动作(POST /dialog/update) ============

  /**
   * 对话行上下文动作(单字段/次):
   *   pinned  → messages.ToggleDialogPin{peer,pinned}
   *   muted   → account.UpdateNotifySettings(muteUntil=永久/0;只翻静音位)
   *   unread  → messages.MarkDialogUnread{peer,unread}
   *   archived→ client.editPeerFolders(1 归档 / 0 取消)
   */
  async function dialogUpdate(params = {}) {
    if (!isPeerKey(params.peerKey)) throw httpError(400, '参数 peer 非法:' + params.peerKey);
    const fields = ['pinned', 'muted', 'unread', 'archived'].filter((k) => params[k] !== undefined);
    if (fields.length !== 1) {
      throw httpError(400, '一次只能修改一项对话属性(pinned|muted|unread|archived)');
    }
    const [field] = fields;
    const v = Boolean(params[field]);
    const entity = await entityOf(params.peerKey);
    await call(async (client) => {
      if (field === 'pinned') {
        return client.invoke(new Api.messages.ToggleDialogPin({
          peer: new Api.InputDialogPeer({ peer: await client.getInputEntity(entity) }),
          pinned: v,
        }));
      }
      if (field === 'muted') {
        return client.invoke(new Api.account.UpdateNotifySettings({
          peer: new Api.NotifyPeer({ peer: await client.getInputEntity(entity) }),
          settings: new Api.InputPeerNotifySettings({
            muteUntil: v ? 2147483647 : 0, // int32 上限 ≈ 68 年 = 永久静音
          }),
        }));
      }
      if (field === 'unread') {
        return client.invoke(new Api.messages.MarkDialogUnread({
          peer: new Api.InputDialogPeer({ peer: await client.getInputEntity(entity) }),
          unread: v,
        }));
      }
      return client.editPeerFolders(entity, v ? 1 : 0); // archived
    });
    return { ok: true };
  }

  // ============ ⑩ 删除对话(POST /dialog/delete) ============

  /**
   * 从列表隐藏并清空会话历史(messages.DeleteHistory{peer,justClear:false,
   * revoke:true};不退出群组/频道)。saved 会话同样走本方法(仅自删)。
   */
  async function dialogDelete(params = {}) {
    if (!isPeerKey(params.peerKey)) throw httpError(400, '参数 peer 非法:' + params.peerKey);
    const entity = await entityOf(params.peerKey);
    await call(async (client) => {
      const inputPeer = await client.getInputEntity(entity);
      return client.invoke(new Api.messages.DeleteHistory({
        peer: inputPeer,
        justClear: false,
        revoke: true,
        maxId: 0,
      }));
    });
    return { ok: true };
  }

  // ============ ⑪ 提及已读(POST /read-mentions) ============

  /** @ 提及全部已读(messages.ReadMentions);徽标清零后靠聚焦刷新/dialogs 回流 */
  async function readMentions(params = {}) {
    if (!isPeerKey(params.peerKey)) throw httpError(400, '参数 peer 非法:' + params.peerKey);
    const entity = await entityOf(params.peerKey);
    await call(async (client) => {
      const inputPeer = await client.getInputEntity(entity);
      return client.invoke(new Api.messages.ReadMentions({ peer: inputPeer }));
    });
    return { ok: true };
  }

  // ============ ⑫ 聊天头部(GET /chat-header) ============

  /**
   * 聊天页头部增量字段(GetPeerDialogs + entity + full info)。任何子字段失败
   * 回 null,页面退现有头部;peer 实体本身不可得才上抛。onlineCount 走
   * channels.getFullChannel.fullChat.onlineCount(MTProto 原生;TDLib 版恒 null)。
   */
  async function chatHeader(params = {}) {
    if (!isPeerKey(params.peerKey)) throw httpError(400, '参数 peer 非法:' + params.peerKey);
    const self = String(selfId() || '');
    const entity = await entityOf(params.peerKey);
    const out = {
      title: null, subtitle: null, memberCount: null,
      onlineCount: null, unreadMentionsCount: null, pinnedMessageId: null,
    };
    const dialog = await call(async (client) => {
      const inputPeer = entity === 'me' ? new Api.InputPeerSelf() : await client.getInputEntity(entity);
      const r = await client.invoke(new Api.messages.GetPeerDialogs({
        peers: [new Api.InputDialogPeer({ peer: inputPeer })],
      }));
      return r && Array.isArray(r.dialogs) ? r.dialogs[0] : null;
    }).catch(() => null);

    if (dialog && dialog.className === 'Dialog') {
      out.unreadMentionsCount = Number(dialog.unreadMentionsCount) > 0
        ? Number(dialog.unreadMentionsCount) : null;
    }

    const cn = entity && entity.className;
    if (params.peerKey === 'saved' || (cn === 'User' && self && String(entity.id) === self)) {
      out.title = '我的收藏'; // saved 伪对话契约统一「我的收藏」
    } else if (cn === 'User') {
      const info = contractUserOf(entity, self);
      if (info && info.name) out.title = info.name;
      out.subtitle = statusTextOf(entity.status);
    } else {
      out.title = String((entity && entity.title) || '') || null;
      if (cn === 'Channel') {
        try {
          const client = await getClient();
          const full = await client.invoke(new Api.channels.GetFullChannel({ channel: defaultLib.utils.getInputChannel(entity) }));
          const fc = full && full.fullChat;
          const n = Number(fc && fc.participantsCount);
          out.memberCount = Number.isFinite(n) && n > 0 ? n : null;
          const online = Number(fc && fc.onlineCount);
          out.onlineCount = Number.isFinite(online) && online > 0 ? online : null;
        } catch (_e) {
          warn('chatHeader getFullChannel 失败(人数降级): ' + ((_e && _e.message) || _e));
        }
      } else if (cn === 'Chat') {
        try {
          const client = await getClient();
          const full = await client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
          const fc = full && full.fullChat;
          const n = Number(fc && fc.participantsCount);
          out.memberCount = Number.isFinite(n) && n > 0 ? n : null;
        } catch (_e) {
          warn('chatHeader getFullChat 失败(人数降级): ' + ((_e && _e.message) || _e));
        }
      }
    }

    // 置顶条:置顶过滤器单取 1 条(无置顶 → null)
    try {
      const client = await getClient();
      const inputEntity = entity === 'me' ? 'me' : entity;
      for await (const m of client.iterMessages(inputEntity, {
        filter: new Api.InputMessagesFilterPinned(),
        limit: 1,
      })) {
        if (m && m.id) out.pinnedMessageId = Number(m.id);
        break;
      }
    } catch (_e) { /* 无置顶或不可见:null(页面退现有头部) */ }

    return out;
  }

  return {
    searchInChat,
    searchGlobal,
    calendar,
    forwardMessages,
    pinMessage,
    pinnedMessages,
    editText,
    deleteMessages,
    dialogUpdate,
    dialogDelete,
    readMentions,
    chatHeader,
  };
}

// ============ 模块内小工具 ============

/** anchor 的宽松换算(0/非法 → 0;TDLib 打包 id shim) */
function localMsgIdOfSafe(anchor) {
  const n = Number(anchor) || 0;
  if (n <= 0) return 0;
  return n < (1 << 20) ? n : Number(BigInt(n) >> 20n);
}

/** 日期参数('YYYY-MM-DD' | unix 秒)→ unix 秒;空/非法回 0(不携带) */
function dateToSec(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
  if (m) return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000);
  return 0;
}
