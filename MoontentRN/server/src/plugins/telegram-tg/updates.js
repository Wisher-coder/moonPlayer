// ============================================================================
// updates.js —— teleproto 引擎更新事件层(仅 Node 服务端运行)
// ----------------------------------------------------------------------------
// 消费 teleproto 的 raw updates 流(client.addEventHandler + events.Raw 订阅,
// getDifference/频道差量/状态同步由库内 UpdateManager 处理,本层只消费已解析
// 的 Api.Update* 对象),在其上维护「全局递增 seq + 每会话(peerKey)事件环」,
// 为 /api/telegram/updates 长轮询端点供数。事件环常量与游标语义与 TDLib 版
// 逐字一致(reset 自愈/RING_MAX/RING_PEERS_MAX/wait ≤20s)。
//
// 事件类型与形状(契约面不变;MTProto 更新 → 事件的映射表):
//   new    {peer,type:'new',id,message}      —— UpdateNewMessage /
//                                             UpdateNewChannelMessage;
//                                             自身经本引擎 send 的消息经
//                                             isSelfSent 端口去重(回执已发过,
//                                             回声不再入环)
//   edit   {peer,type:'edit',id,message}    —— UpdateEditMessage /
//                                             UpdateEditChannelMessage(携带
//                                             完整新消息,直接归一化;MTProto
//                                             不像 TDLib 只给 new_content 增量)
//   delete {peer,type:'delete',ids}         —— UpdateDeleteMessages(跨会话形态
//                                             :经 msgCache 反查归属)/
//                                             UpdateDeleteChannelMessages(定向)
//   peer   {peer,type:'peer',...patch}      —— UpdateReadHistoryInbox/Outbox、
//                                             UpdateReadChannelInbox/Outbox、
//                                             UpdateDialogUnreadMark
//   typing {peer,type:'typing',senders}     —— UpdateUserTyping /
//                                             UpdateChatUserTyping /
//                                             UpdateChannelUserTyping(仅
//                                             SendMessageTypingAction/
//                                             SendMessageCancelAction 两动作,
//                                             每 peer×sender 5s TTL 自清)
//   reset  非入环事件:getUpdatesSince 的响应形态 {reset:true,seq}。
//
// 引擎级 folders 缓存:UpdateDialogFilters(无载荷)→ 标脏重拉;读取走
// client.getDialogFilters()(Folder{id,title} → [{id,title,emoji:null}]),
// 首读拉一次、事件到达即失效(TDLib 版的逐 id 探测引导已不需要——MTProto
// 有全清单拉取 API)。
//
// 端口契约(engine.js 接线时注入;均为「模块级稳定函数」,内部状态由各域
// 自持并随 dropCaches 自清):
//   decodePeerKey(peerId)       MTProto Peer → peerKey(PeerUser/PeerChat/
//                               PeerChannel;normalize.peerKeyOfPeer 注入)
//   normalizeMessage(pk,msg)    MTProto message → 契约消息(collectAndNormalize
//                               全保真;失败/返回 null 按 null 降级入环)
//   isSelfSent(pk,msgId)        近期经本引擎发送(writes.recentSent 命中)
//   senderOf(userId)            发送者 {id,name}|null(可 Promise;实现方自备
//                               TTL 缓存防心跳打爆)
//   putMessage(pk,msg)          原始 message 进 msgCache
//   markDialogsDirty()          对话表软作废(两档新鲜度)
//   dropPeerVideoCount(pk)      视频计数缓存作废
//   dropMessageIds(ids)         跨会话按 id 清 msgCache,返回命中归属 peerKey[]
//   now()/alarm()/typingTtlMs   时钟/定时器工厂/typing TTL(测试注入)
//
// 防风暴红线:本层不发起任何业务网络请求(folders 读取除外——按需一次),
// 无重试逻辑;长轮询有界等待 ≤20s;归一化失败降级 message:null 不吞事件。
// ============================================================================
import { isPeerKey } from './shared.js';
import { peerKeyOfPeer } from './normalize.js';
import * as defaultLib from 'teleproto';

// —— 事件环参数:每会话上限 300 条;会话环总数上限(LRU 逐出最久未活跃) ——
export const RING_MAX = 300;
export const RING_PEERS_MAX = 128;

// 长轮询有界等待上限/缺省值(红线 ≤20s)
export const WAIT_MAX_MS = 20000;

// typing 条目存活时长:每 peer×sender 5s TTL 自清
export const TYPING_TTL_MS = 5000;

/** wait 毫秒钳制到 [0,20000],非法回落 20000 */
export function clampWaitMs(wait) {
  const n = Number(wait);
  return Number.isFinite(n) ? Math.min(WAIT_MAX_MS, Math.max(0, n)) : WAIT_MAX_MS;
}

// 缺省定时器:真实 setTimeout 包装(测试注入手动闹钟替代)
const defaultAlarm = (fn, ms) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

// 端口缺省安全空实现(引擎未接线/单测未覆盖端口时的无害兜底)
const NOOP_PORTS = {
  decodePeerKey: (peer) => peerKeyOfPeer(peer, ''),
  normalizeMessage: async () => null,
  isSelfSent: () => false,
  senderOf: () => null,
  putMessage: () => {},
  markDialogsDirty: () => {},
  dropPeerVideoCount: () => {},
  dropMessageIds: () => [],
};

/**
 * 更新层核心工厂(纯逻辑,全端口可注入)。
 * @param {object} deps 端口集(见文件头契约表),均可选
 */
export function createTgUpdatesCore(deps = {}) {
  const {
    decodePeerKey = NOOP_PORTS.decodePeerKey,
    normalizeMessage = NOOP_PORTS.normalizeMessage,
    isSelfSent = NOOP_PORTS.isSelfSent,
    senderOf = NOOP_PORTS.senderOf,
    putMessage = NOOP_PORTS.putMessage,
    markDialogsDirty = NOOP_PORTS.markDialogsDirty,
    dropPeerVideoCount = NOOP_PORTS.dropPeerVideoCount,
    dropMessageIds = NOOP_PORTS.dropMessageIds,
    getClient,
    now = Date.now,
    alarm = defaultAlarm,
    typingTtlMs = TYPING_TTL_MS,
  } = deps;

  let globalSeq = 0;         // 全局单调事件序号(0 = 尚无任何事件)
  const rings = new Map();   // peerKey → {events:[], droppedThrough:0, lastSeq:0, chain:Promise}
  const waiters = new Map(); // peerKey → Set<() => void>(长轮询等待者)
  let boundClient = null;    // 已订阅的 teleproto 客户端(幂等再入判断)
  let offHandler = null;     // removeEventHandler 句柄
  const typing = new Map();  // peerKey → Map<senderId,{id,name,expiresAt}>
  const typingAlarms = new Map();
  let chatFolders = [];      // 引擎级文件夹缓存
  let foldersDirty = true;   // 事件到达标脏;首读拉一次

  // ============ 事件环(与 TDLib 版逐字同构) ============

  function ringOf(peerKey) {
    let ring = rings.get(peerKey);
    if (!ring) {
      ring = { events: [], droppedThrough: 0, lastSeq: 0, chain: Promise.resolve() };
      rings.set(peerKey, ring);
    }
    return ring;
  }

  function wakeWaiters(peerKey) {
    const set = waiters.get(peerKey);
    if (!set || !set.size) return;
    for (const fn of [...set]) fn();
    set.clear();
  }

  function wakeAllWaiters() {
    for (const peerKey of [...waiters.keys()]) wakeWaiters(peerKey);
    waiters.clear();
  }

  function clearTyping(peerKey) {
    const cancel = typingAlarms.get(peerKey);
    if (cancel) {
      try { cancel(); } catch (_e) { /* 闹钟已自然走完则忽略 */ }
      typingAlarms.delete(peerKey);
    }
    typing.delete(peerKey);
  }

  /** 事件入环(同步,seq 在此分配;同会话内保持严格递增——经 enqueue 串行化) */
  function pushEvent(peerKey, ev) {
    const seq = ++globalSeq;
    ev.seq = seq;
    const ring = ringOf(peerKey);
    ring.lastSeq = seq;
    ring.events.push(ev);
    if (ring.events.length > RING_MAX) {
      const cut = ring.events.splice(0, ring.events.length - RING_MAX);
      ring.droppedThrough = cut[cut.length - 1].seq;
    }
    rings.delete(peerKey);
    rings.set(peerKey, ring);
    while (rings.size > RING_PEERS_MAX) {
      const oldest = rings.keys().next().value;
      if (oldest === peerKey) break;
      wakeWaiters(oldest);
      waiters.delete(oldest);
      clearTyping(oldest);
      rings.delete(oldest);
    }
    wakeWaiters(peerKey);
  }

  /** 同会话事件按到达顺序串行处理(归一化是异步的,直接并发会乱序入环) */
  function enqueue(peerKey, work) {
    const ring = ringOf(peerKey);
    ring.chain = ring.chain.then(work).catch(() => { /* 单条事件失败不阻塞后续 */ });
    return ring.chain;
  }

  // ============ MTProto 更新 → 事件(映射表见文件头) ============

  /** Peer → peerKey;解码失败/非法段一律 null(事件面不收编未知会话) */
  function decode(peer) {
    try {
      const pk = decodePeerKey(peer);
      return pk && isPeerKey(pk) ? pk : null;
    } catch (_e) {
      return null;
    }
  }

  /** 频道/超群定向更新的裸 channelId/chatId → peerKey 快路 */
  function decodeId(prefix, rawId) {
    const n = Number(rawId);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    const pk = prefix + n;
    return isPeerKey(pk) ? pk : null;
  }

  /**
   * new:UpdateNewMessage/UpdateNewChannelMessage(完整 message 载荷)。
   * 自身经本引擎 send 的消息不入环(isSelfSent 命中——回执已经 POST 响应
   * 发过,回声入环会双显);其它设备的消息照常入环(out=true 的 new 事件)。
   * 新消息入缓存+对话表软作废+视频计数作废后入环。
   */
  function handleNewMessage(msg) {
    if (!msg || !msg.id || msg.className === 'MessageEmpty') return;
    const pk = decode(msg.peerId);
    if (!pk) return;
    const msgId = Number(msg.id);
    if (isSelfSent(pk, msgId)) return;
    return enqueue(pk, async () => {
      putMessage(pk, msg);
      markDialogsDirty();
      dropPeerVideoCount(pk);
      let message = null;
      try {
        message = await normalizeMessage(pk, msg);
      } catch (_e) { /* 归一化失败:message 置 null 入环,前端按 id 走 /message 强拉 */ }
      pushEvent(pk, { peer: pk, type: 'new', id: msgId, message });
    });
  }

  /**
   * edit:UpdateEditMessage/UpdateEditChannelMessage(完整新消息)——直接
   * 归一化入环并回填缓存(MTProto 给整条消息,无须 TDLib 版的
   * 「msgCache 旧文+new_content 重建」);归一化失败 → message:null,
   * 前端按 id 强拉补全。
   */
  function handleEdit(msg) {
    if (!msg || !msg.id || msg.className === 'MessageEmpty') return;
    const pk = decode(msg.peerId);
    if (!pk) return;
    const msgId = Number(msg.id);
    return enqueue(pk, async () => {
      putMessage(pk, msg);
      let message = null;
      try {
        message = await normalizeMessage(pk, msg);
      } catch (_e) { /* null 降级入环 */ }
      pushEvent(pk, { peer: pk, type: 'edit', id: msgId, message });
    });
  }

  /**
   * delete:UpdateDeleteChannelMessages{channelId,messages}(定向)与
   * UpdateDeleteMessages{messages}(跨会话形态——按 msgCache 反查归属,
   * 未命中由 markDialogsDirty 兜底)。同 id 消息在其他会话的转存副本仍存在,
   * 只清缓存、只对归属会话入 delete 事件。MTProto 无 TDLib 的 from_cache
   * (缓存驱逐)概念,全部按真实删除处理。
   */
  function handleDelete(channelId, rawIds) {
    const list = (Array.isArray(rawIds) ? rawIds : [])
      .map((x) => Number(x))
      .filter((x) => x > 0);
    if (!list.length) return;
    const hintPk = channelId != null ? decodeId('c', channelId) : null;
    const peers = dropMessageIds(list); // 同步缓存清理(返回命中会话)
    markDialogsDirty();
    const targets = hintPk ? [hintPk] : peers;
    const jobs = [];
    for (const pk of targets) {
      if (!pk || !isPeerKey(pk)) continue;
      dropPeerVideoCount(pk);
      jobs.push(enqueue(pk, () => pushEvent(pk, { peer: pk, type: 'delete', ids: list })));
    }
    return Promise.all(jobs);
  }

  /** peer 计数事件:unreadCount/readInboxMaxId/readOutboxMaxId/unreadMark */
  function pushPeer(peerKey, patch) {
    if (!peerKey || !isPeerKey(peerKey)) return;
    markDialogsDirty(); // 未读角标在对话表缓存里,一并软作废
    return enqueue(peerKey, () => pushEvent(peerKey, { peer: peerKey, type: 'peer', ...patch }));
  }

  // —— typing 在打者表(peerKey → senderId → {id,name,expiresAt}) ——

  /** 重算某会话在打者全量名单(先清过期条目;名单有序:先开始打字者在前) */
  function typingSenders(peerKey) {
    const set = typing.get(peerKey);
    if (!set) return [];
    const t = now();
    let expired = false;
    for (const [id, entry] of set) {
      if (entry.expiresAt <= t) { set.delete(id); expired = true; }
    }
    if (expired) {
      if (!set.size) { typingAlarms.delete(peerKey); typing.delete(peerKey); }
      else rearmTypingAlarm(peerKey);
    }
    return [...set.values()].map(({ id, name }) => ({ id, name }));
  }

  /** 按「最近到期条目」重设该会话的 TTL 清扫闹钟 */
  function rearmTypingAlarm(peerKey) {
    const prev = typingAlarms.get(peerKey);
    if (prev) {
      try { prev(); } catch (_e) { /* 已触发过则忽略 */ }
      typingAlarms.delete(peerKey);
    }
    const set = typing.get(peerKey);
    if (!set || !set.size) return;
    let minAt = Infinity;
    for (const entry of set.values()) if (entry.expiresAt < minAt) minAt = entry.expiresAt;
    typingAlarms.set(peerKey, alarm(() => onTypingExpire(peerKey), Math.max(0, minAt - now())));
  }

  /** TTL 到点清扫:过期者移除并补发一条剩余在打者全量事件(含空名单=收尾) */
  function onTypingExpire(peerKey) {
    typingAlarms.delete(peerKey);
    const set = typing.get(peerKey);
    if (!set || !set.size) { typing.delete(peerKey); return; }
    const before = set.size;
    const senders = typingSenders(peerKey);
    if (senders.length === before) {
      rearmTypingAlarm(peerKey); // 无实际过期(定时器提前触发/时钟漂移)
      return;
    }
    return enqueue(peerKey, () => pushEvent(peerKey, { peer: peerKey, type: 'typing', senders }));
  }

  /**
   * typing:仅转发 SendMessageTypingAction/SendMessageCancelAction 两动作
   * (上传/录制等不转发);开始=加入(TTL 刷新)、取消=移除;每次动作把
   * 「全量在打者名单」入环(心跳重复也照发,客户端靠它续显)。发送者身份
   * 解析在会话链内完成(可同步可异步)。
   */
  function handleTyping(peerKey, fromId, action) {
    const pk = peerKey;
    if (!pk || !isPeerKey(pk)) return;
    const t = action && action.className;
    if (t !== 'SendMessageTypingAction' && t !== 'SendMessageCancelAction') return;
    return enqueue(pk, async () => {
      const sender = await senderOf(fromId);
      if (!sender || sender.id == null) return; // 拿不到发送者身份无法呈现,跳过
      const senderId = String(sender.id);
      let set = typing.get(pk);
      if (t === 'SendMessageTypingAction') {
        if (!set) { set = new Map(); typing.set(pk, set); }
        set.set(senderId, {
          id: senderId,
          name: String(sender.name || '对方'),
          expiresAt: now() + typingTtlMs,
        });
        rearmTypingAlarm(pk);
        pushEvent(pk, { peer: pk, type: 'typing', senders: typingSenders(pk) });
        return;
      }
      if (!set || !set.delete(senderId)) return;
      if (!set.size) clearTyping(pk);
      else rearmTypingAlarm(pk);
      pushEvent(pk, { peer: pk, type: 'typing', senders: typingSenders(pk) });
    });
  }

  /**
   * Raw 更新分发入口(addEventHandler 流的消费端;测试可直接注入 fixture)。
   * 只按 className 分派;异常自吞(单条更新异常不炸接收循环)。返回值是本条
   * 更新触发的入环链 Promise(测试 await 它保证环已结算)。
   */
  function handleMtprotoUpdate(u) {
    try {
      const t = u && typeof u.className === 'string' ? u.className : '';
      if (!t.startsWith('Update')) return; // 非 Update 系(引擎内部直接忽略)
      switch (t) {
        case 'UpdateNewMessage':
        case 'UpdateNewChannelMessage':
          return handleNewMessage(u.message);
        case 'UpdateEditMessage':
        case 'UpdateEditChannelMessage':
          return handleEdit(u.message);
        case 'UpdateDeleteMessages':
          return handleDelete(null, u.messages);
        case 'UpdateDeleteChannelMessages':
          return handleDelete(u.channelId, u.messages);
        case 'UpdateReadHistoryInbox': // 收件已读:剩余未读数随行
          return pushPeer(decode(u.peer), {
            readInboxMaxId: Number(u.maxId) || 0,
            unreadCount: Number(u.stillUnreadCount) || 0,
          });
        case 'UpdateReadHistoryOutbox': // 对端已读自己发出的消息
          return pushPeer(decode(u.peer), { readOutboxMaxId: Number(u.maxId) || 0 });
        case 'UpdateReadChannelInbox':
          return pushPeer(decodeId('c', u.channelId), {
            readInboxMaxId: Number(u.maxId) || 0,
            unreadCount: Number(u.stillUnreadCount) || 0,
          });
        case 'UpdateReadChannelOutbox':
          return pushPeer(decodeId('c', u.channelId), { readOutboxMaxId: Number(u.maxId) || 0 });
        case 'UpdateDialogUnreadMark': // 对话手动标记(取消标记)未读
          return pushPeer(u.peer && u.peer.className === 'DialogPeer' ? decode(u.peer.peer) : null, {
            unreadMark: Boolean(u.unread),
          });
        case 'UpdateUserTyping': // 私聊 typing(peer = 与该用户的会话)
          return handleTyping(decodeId('u', u.userId), u.userId, u.action);
        case 'UpdateChatUserTyping': // 普通群 typing
          return handleTyping(decodeId('g', u.chatId), u.fromId && u.fromId.userId, u.action);
        case 'UpdateChannelUserTyping': // 超群/频道 typing
          return handleTyping(decodeId('c', u.channelId), u.fromId && u.fromId.userId, u.action);
        case 'UpdateDialogFilters': // 文件夹清单变更(无载荷)→ 缓存标脏 + 目录软作废
        case 'UpdateDialogFiltersOrder':
        case 'UpdateFolderPeers':
        case 'UpdateDialogPinned':
          foldersDirty = true;
          markDialogsDirty();
          return;
        case 'UpdateChatParticipantAdmin':
        case 'UpdateChannelMessageViews':
          return; // 细粒度成员/浏览量变化:不入环不标脏(装饰性,轮询自愈)
        default:
          return; // 其余更新不消费
      }
    } catch (_e) { /* 事件处理异常不炸接收循环 */ }
  }

  // ============ 对外接口(facade「pollUpdates 组」) ============

  /**
   * 绑定/换绑 teleproto 客户端(消费其 raw updates 流)。幂等:同客户端重复
   * 挂接零副作用;换客户端先摘旧订阅(events.Raw 放行全部 Update 系对象)。
   */
  function attachClient(client) {
    if (!client || typeof client.addEventHandler !== 'function') {
      throw new Error('teleproto 更新层挂接失败:客户端缺少 addEventHandler(handler, builder) 接口');
    }
    if (boundClient === client) return;
    if (offHandler) {
      try { offHandler(); } catch (_e) { /* 旧客户端已断连则忽略 */ }
      offHandler = null;
    }
    boundClient = client;
    const handler = (update) => handleMtprotoUpdate(update);
    client.addEventHandler(handler, new defaultLib.events.Raw({}));
    offHandler = () => {
      try { client.removeEventHandler(handler); } catch (_e) { /* 已断连则忽略 */ }
    };
  }

  /** 账号态清空(登出/换号):摘订阅、清环/seq/typing 及 folders 缓存,唤醒等待者 */
  function drop() {
    if (offHandler) {
      try { offHandler(); } catch (_e) { /* 已断连则忽略 */ }
      offHandler = null;
    }
    boundClient = null;
    globalSeq = 0;
    rings.clear();
    chatFolders = [];
    foldersDirty = true;
    for (const cancel of typingAlarms.values()) {
      try { cancel(); } catch (_e) { /* 忽略 */ }
    }
    typingAlarms.clear();
    typing.clear();
    wakeAllWaiters();
  }

  /** 全局最新 seq(无 peer 参数的轻量轮询用) */
  function globalUpdateSeq() {
    return globalSeq;
  }

  /**
   * folders 缓存读取([{id,title,emoji:null}]):事件标脏/首读时经
   * client.getDialogFilters() 拉取(messages.getDialogFilters;返回包装对象
   * DialogFilters{filters:DialogFilter[]})。标题提取双形态:layer 230 的
   * DialogFilter.title 是 TextWithEntities 对象(取 .text;与 TDLib 版
   * folderTitleOf 的 name.text.text 漂移同源),纯字符串形态兜底。
   * 失败如实上抛;回拷贝防外部改写。
   */
  async function getChatFolders() {
    if (!foldersDirty && chatFolders.length) return chatFolders.slice();
    const client = typeof getClient === 'function' ? await getClient() : null;
    if (!client || typeof client.getDialogFilters !== 'function') return [];
    const res = await client.getDialogFilters();
    const list = Array.isArray(res) ? res
      : (res && Array.isArray(res.filters) ? res.filters : []);
    const titleOf = (t) => {
      if (!t) return '';
      if (typeof t === 'string') return t; // 历史形态防御
      return String(t.text || '');
    };
    chatFolders = list
      .filter((f) => f && Number.isSafeInteger(Number(f.id)) && Number(f.id) > 0)
      .map((f) => ({ id: Number(f.id), title: titleOf(f.title), emoji: null }));
    foldersDirty = false;
    return chatFolders.slice();
  }

  /**
   * 取某会话 seq 之后的事件(reset 语义与 TDLib 版逐字一致:游标落后于环
   * 起点/超前于 lastSeq → {reset:true,seq},客户端整页重拉自愈)。
   */
  function getUpdatesSince(peerKey, afterSeq) {
    const ring = rings.get(peerKey);
    if (!ring) {
      return afterSeq > 0 ? { reset: true, seq: 0 } : { events: [], seq: 0 };
    }
    if (afterSeq < ring.droppedThrough || afterSeq > ring.lastSeq) {
      return { reset: true, seq: ring.lastSeq };
    }
    const events = ring.events.filter((e) => e.seq > afterSeq);
    return { events, seq: ring.lastSeq };
  }

  /** 有界等待该会话的下一条事件(ms 内新事件到达/到时/abort 任一即 resolve) */
  function waitForPeerEvent(peerKey, ms, signal) {
    return new Promise((resolve) => {
      if (signal && signal.aborted) { resolve(); return; }
      let set = waiters.get(peerKey);
      if (!set) { set = new Set(); waiters.set(peerKey, set); }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        set.delete(finish);
        if (!set.size) waiters.delete(peerKey);
        if (signal) signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      if (signal) signal.addEventListener('abort', finish, { once: true });
      set.add(finish);
    });
  }

  /**
   * 长轮询取数(路由 handler 单次完整流程):无 peer 只回全局最新 seq;有
   * peer → 取增量,无增量且有界等待窗口内等待。reset 形态不等待。seq 非法
   * 属参数契约违反,如实上抛。
   */
  async function pollUpdates({ peer, seq = 0, wait, signal } = {}) {
    if (!peer) return { seq: globalSeq };
    const afterSeq = Number(seq);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new Error('参数 seq 必须是非负整数');
    }
    const waitMs = clampWaitMs(wait);
    let out = getUpdatesSince(peer, afterSeq);
    if (!out.reset && out.events.length === 0 && waitMs > 0) {
      await waitForPeerEvent(peer, waitMs, signal);
      out = getUpdatesSince(peer, afterSeq);
    }
    return out;
  }

  return {
    handleMtprotoUpdate,
    attachClient,
    drop,
    globalUpdateSeq,
    getUpdatesSince,
    waitForPeerEvent,
    pollUpdates,
    getChatFolders,
  };
}

// ============ 模块单例门面(engine.js 接线面) ============

let activeCore = null;

function ensureCore(ports) {
  if (!activeCore) activeCore = createTgUpdatesCore(ports || {});
  return activeCore;
}

/**
 * 挂接 teleproto 客户端并注入端口(幂等;端口只在首次挂接时生效)。
 * @returns 当前更新层核心
 */
export function attachTgUpdates(client, ports = {}) {
  const core = ensureCore(ports);
  core.attachClient(client);
  return core;
}

/** 账号态清空(登出/换号接管):摘订阅+清环/seq/typing,唤醒全部等待者 */
export function dropUpdateEvents() {
  if (activeCore) activeCore.drop();
}

/** 全局最新 seq(无 peer 参数的轻量轮询用) */
export function globalUpdateSeq() {
  return activeCore ? activeCore.globalUpdateSeq() : 0;
}

/** 引擎级 folders 缓存读取(未接线 → []) */
export function getChatFolders() {
  return activeCore ? activeCore.getChatFolders() : Promise.resolve([]);
}

/** 取某会话 seq 之后的事件(reset 语义见核心实现) */
export function getUpdatesSince(peerKey, afterSeq) {
  if (!activeCore) return afterSeq > 0 ? { reset: true, seq: 0 } : { events: [], seq: 0 };
  return activeCore.getUpdatesSince(peerKey, afterSeq);
}

/** 有界等待该会话的下一条事件;未接线时立即返回 */
export function waitForPeerEvent(peerKey, ms, signal) {
  if (!activeCore) return Promise.resolve();
  return activeCore.waitForPeerEvent(peerKey, ms, signal);
}

/** 长轮询取数(契约同核心实现);未接线时按空环应答,不悬挂 */
export async function pollUpdates(opts = {}) {
  if (!activeCore) {
    const { peer, seq = 0 } = opts;
    if (!peer) return { seq: 0 };
    const afterSeq = Number(seq);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new Error('参数 seq 必须是非负整数');
    }
    return afterSeq > 0 ? { reset: true, seq: 0 } : { events: [], seq: 0 };
  }
  return activeCore.pollUpdates(opts);
}
