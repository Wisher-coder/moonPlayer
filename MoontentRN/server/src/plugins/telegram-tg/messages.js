// ============================================================================
// messages.js —— teleproto 引擎·消息域(聊天页双向分页/单条强拉/peer 头部/
//               消息缓存;仅 Node 服务端运行)
// ----------------------------------------------------------------------------
// 契约与 TDLib 版逐字一致:getChatPage 双向游标分页 {peer,items,hasOlder,
// hasNewer}、getOneMessage、getMessage 缓存版(媒体令牌/写侧指纹复用)、
// collectAndNormalize 全保真归一化(updates 端口复用)。取数换 teleproto
// iterMessages(messages.getHistory),游标语义天然同构:
//   · MTProto offsetId 排他(仅返回 id < offsetId)——TDLib 版 offset=0 的
//     「锚排他」等价直译:older 腿 offsetId=锚;
//   · 含锚腿:offsetId=锚+1(id ≤ 锚;TDLib 版 offset=-1 的等价形态);
//   · 新向探测窗:offsetId=锚、addOffset=-(n+2)、limit=n+2(窗口覆盖
//     锚+1..锚+n+2,过滤 id>锚后按「条数>n 判 hasNewer」,与 TDLib 版探测
//     位口径一致);MTProto 上限 100/请求 ⟹ n ≤ 97 与 TDLib 版同钳制。
// 与 TDLib 版的有意差异(注释留档):
//   · 短页补齐(refillHistoryWindow)删除——TDLib 本地库窗口不足额的特有
//     行为;MTProto 每页都是服务端权威结果,空页=到头,无需补齐重发;
//   · 锚越顶钳制保留但简化:MTProto 对 offsetId 越顶不报 400(返回空/就近
//     结果),仅 newer/around 腿做一次 limit=1 的最新 id 探测,越顶回退
//     最新页语义(会话历史被清空后本地水位越顶的场景,TDLib 版同款保护);
//   · openChat/closeChat 删除——TDLib「超群/频道更新仅对已 open 会话派发」
//     的概念在 MTProto 不存在(更新走 getDifference/频道差量,teleproto
//     内建处理);
//   · 消息 id 空间:MTProto 原生 id(每会话 int32)。旧 TDLib 打包 id
//     (local_id<<20)经 localMsgIdOf shim 继续可读(历史 videoId/收藏兼容)。
//
// 防风暴红线(同 TDLib 版):回复目标批量补齐一次 getMessages(上限 100),
// 绝不逐条回源;单条归一化异常降级 unsupported 占位,绝不炸整页;上游失败
// 如实上抛中文错误,绝不自动重试。
// ============================================================================
import { isPeerKey, avatarToken, localMsgIdOf } from './shared.js';
import { normTgClientError } from './tg-client.js';
import {
  imgOf, normalizeOne, unsupportedPlaceholder, replyTargetIdOf, contractUserOf,
} from './normalize.js';
import * as defaultLib from 'teleproto';

// —— 常量(对齐 TDLib 版同款口径) ——
export const REPLY_FETCH_MAX = 100; // 回复目标单次批量补齐上限
export const NEWER_MAX = 60;        // around 首屏新向腿上限
export const NEWER_PROBE_MAX = 97;  // 新向探测窗上限(addOffset+limit ≤ 100)
const MSG_TTL = 10 * 60e3;          // 单条消息缓存时效
const MSG_CACHE_MAX = 500;          // 单对话消息缓存上限
const USERS_TTL = 10 * 60e3;        // 发送者信息缓存时效
const USERS_CACHE_MAX = 1000;       // 发送者缓存条数上限
const HISTORY_LIMIT_MAX = 100;      // MTProto getHistory 单次上限

/**
 * 消息域工厂。依赖注入:
 *   getClient  async () => teleproto client(engine 注入,每次现取)
 *   entityOf   async (peerKey) => entity(dialogs 域共享口;'saved'→'me')
 *   getSelfId  () => String(自己的 user id 十进制串;未登录 '')
 *   getUser    async (userId:String) => 契约用户|null(发送者解析钩子;缺省
 *              经 client.getEntity + contractUserOf 实现)
 *   log        (msg)=>void 可选
 */
export function createMessages({ getClient, entityOf, getSelfId, getUser, log } = {}) {
  if (typeof getClient !== 'function') {
    throw new Error('messages 域缺少 getClient 依赖(teleproto 客户端)');
  }
  if (typeof entityOf !== 'function') {
    throw new Error('messages 域缺少 entityOf 依赖(dialogs 域共享口)');
  }
  const selfId = typeof getSelfId === 'function' ? getSelfId : () => '';
  const warn = typeof log === 'function' ? log : () => {};

  async function clientOf() { return getClient(); }
  async function call(fn) {
    const client = await clientOf();
    try {
      return await fn(client);
    } catch (e) {
      throw normTgClientError(e, defaultLib);
    }
  }

  // ============ 账号态缓存(msgCache/usersCache;dropCaches 统一作废) ============

  const msgCache = new Map();    // peerKey → Map(msgId → {msg(MTProto Message), at})
  const usersCache = new Map();  // String(userId) → {info, at}

  /** 缺省发送者解析:getEntity(会话实体缓存)→ 契约用户;失败由 userInfoOf 兜底占位 */
  async function defaultGetUser(userId) {
    const entity = await call((client) => client.getEntity(userId));
    return contractUserOf(entity, selfId());
  }

  /**
   * 解析单个用户 → from 契约对象:缓存命中零网络;任何失败兜底「用户 <id>」
   * 占位,绝不抛(发送者信息是装饰性数据,不能因它炸整页)。
   */
  async function userInfoOf(userId) {
    const key = String(userId);
    const hit = usersCache.get(key);
    if (hit && Date.now() - hit.at < USERS_TTL) return hit.info;
    let info = null;
    try {
      const resolve = typeof getUser === 'function' ? getUser : defaultGetUser;
      info = (await resolve(key)) || null;
    } catch (_e) { /* 解析失败:占位,不上抛 */ }
    if (!info || info.id == null) {
      info = { id: key, name: '用户 ' + key, isBot: false, username: '', avatar: null };
    }
    usersCache.set(key, { info, at: Date.now() });
    if (usersCache.size > USERS_CACHE_MAX) usersCache.delete(usersCache.keys().next().value);
    return info;
  }

  // ============ 消息缓存 ============

  /** 原始 MTProto message 写入 msgCache(!msg || !msg.id 直接返回不污染缓存) */
  function putMessage(peerKey, msg) {
    if (!msg || !msg.id) return;
    let per = msgCache.get(peerKey);
    if (!per) { per = new Map(); msgCache.set(peerKey, per); }
    if (per.size > MSG_CACHE_MAX) per.clear(); // 粗粒度防泄漏,冷数据无价值
    per.set(Number(msg.id), { msg, at: Date.now() });
  }

  /**
   * TDLib 打包 id shim(shared.js 单一实现):旧 videoId/收藏的打包 id 继续
   * 可读;新 id 为 MTProto 原生形态(<2^20 直通)。
   */

  /** 取原始消息:缓存(TTL)优先,miss 经 getMessages 强拉并回填 */
  async function getMessage(peerKey, msgId, force = false) {
    if (!isPeerKey(peerKey)) throw new Error('Telegram 对话 id 非法:' + peerKey);
    const id = localMsgIdOf(msgId);
    let per = msgCache.get(peerKey);
    if (!per) { per = new Map(); msgCache.set(peerKey, per); }
    const hit = per.get(id);
    if (!force && hit && Date.now() - hit.at < MSG_TTL) return hit.msg;
    const entity = await entityOf(peerKey);
    const msgs = await call((client) => client.getMessages(entity, { ids: [id] }));
    const msg = msgs && msgs[0];
    if (!msg || !msg.id || msg.className === 'MessageEmpty') {
      throw new Error('该 Telegram 消息不存在或已被删除');
    }
    putMessage(peerKey, msg);
    return msg;
  }

  /** 按 id 列表清缓存(updates 事件面 delete 用) */
  function dropMessages(peerKey, msgIds) {
    const per = msgCache.get(peerKey);
    if (!per) return;
    for (const id of msgIds || []) per.delete(Number(id));
  }

  /** 跨全部会话按 id 反查缓存归属(updates 的跨会话 delete 形态用) */
  function findMessagesByIds(msgIds) {
    const hits = [];
    for (const id of msgIds || []) {
      const key = Number(id);
      if (!Number.isSafeInteger(key) || key <= 0) continue;
      for (const [peerKey, per] of msgCache) {
        const hit = per.get(key);
        if (hit) hits.push({ peerKey, msgId: key, msg: hit.msg });
      }
    }
    return hits;
  }

  /** 兼容口:MTProto 发送回执即最终 id,无须改键(TDLib 时代临时 id 重映射已删) */
  function rekeyMessage(peerKey, oldId, newId) {
    const per = msgCache.get(peerKey);
    if (!per) return false;
    const hit = per.get(Number(oldId));
    if (!hit) return false;
    per.delete(Number(oldId));
    per.set(Number(newId), { msg: hit.msg, at: Date.now() });
    return true;
  }

  // ============ 批量归一化 ============

  // 发送者 user id 提取(仅 PeerUser;PeerChat/PeerChannel → null)
  function senderUserIdOf(m) {
    const p = m && m.fromId;
    return p && p.className === 'PeerUser' ? String(p.userId) : null;
  }

  /**
   * 批量归一化一页消息:
   *   ① 收集全部待解析 userId(发送者/viaBot/转发来源/本页回复目标发送者)
   *      → usersCache 批量命中;
   *   ② 回复目标批量补齐:先从本页按 id 取,缺的一次 getMessages 批量取
   *      (上限 100、位置对齐——MTProto 对缺失位回 MessageEmpty);
   *   ③ 逐条 normalizeOne;单条异常降级 unsupported 占位,绝不炸整页。
   */
  async function collectAndNormalize(peerKey, msgs) {
    const list = (msgs || []).filter((m) => m && m.id && m.className !== 'MessageEmpty');

    // ① 用户 id 收集(去重)
    const userIds = new Set();
    for (const m of list) {
      const s = senderUserIdOf(m);
      if (s) userIds.add(s);
      if (m.viaBotId && Number(m.viaBotId) > 0) userIds.add(String(m.viaBotId));
      const fo = m.fwdFrom && m.fwdFrom.fromId;
      if (fo && fo.className === 'PeerUser') userIds.add(String(fo.userId));
      const rid = replyTargetIdOf(m);
      if (rid) {
        const t = list.find((x) => Number(x.id) === rid);
        const ts = t && senderUserIdOf(t);
        if (ts) userIds.add(ts);
      }
    }
    const users = new Map();
    await Promise.all([...userIds].map(async (id) => {
      users.set(id, await userInfoOf(id)); // 内部缓存 + 兜底,绝不抛
    }));

    // ② 回复目标补齐:本页优先,缺的批量强拉一次
    const replies = new Map(); // msgId → {msg} | {deleted:true} | {}
    for (const m of list) {
      const rid = replyTargetIdOf(m);
      if (rid) replies.set(rid, null);
    }
    const missing = [];
    for (const id of replies.keys()) {
      const inPage = list.find((x) => Number(x.id) === id);
      if (inPage) replies.set(id, { msg: inPage });
      else missing.push(id);
    }
    if (missing.length) {
      let fetched = [];
      try {
        const entity = await entityOf(peerKey);
        fetched = await call((client) => client.getMessages(entity, {
          ids: missing.slice(0, REPLY_FETCH_MAX),
        }));
      } catch (_e) { /* 批量补齐失败:全部按「无摘要」占位,不阻塞整页 */ }
      const lateIds = new Set();
      missing.forEach((id, i) => {
        if (i >= REPLY_FETCH_MAX) { replies.set(id, {}); return; } // 超上限:摘要留空
        const got = fetched[i];
        if (got && got.id && got.className !== 'MessageEmpty') {
          replies.set(id, { msg: got });
          const s = senderUserIdOf(got);
          if (s && !users.has(s)) {
            users.set(s, { id: s, name: '用户 ' + s, isBot: false, username: '', avatar: null });
            lateIds.add(s);
          }
        } else {
          replies.set(id, { deleted: true }); // MessageEmpty = 已删除
        }
      });
      await Promise.all([...lateIds].map(async (uid) => {
        users.set(uid, await userInfoOf(uid));
      }));
    }

    // ③ 逐条归一化:单条异常降级 unsupported 占位(保 id/分页),绝不炸整页
    const ctx = { users, replies, selfId: String(selfId() || '') };
    return list.map((m) => {
      try {
        return normalizeOne(peerKey, m, ctx);
      } catch (_e) {
        return unsupportedPlaceholder(peerKey, m);
      }
    });
  }

  // ============ 分页取数:getChatPage ============

  /** iterMessages → 降序数组(辅助;iter 返回最新→最旧序) */
  async function collectIter(entity, opts) {
    const out = [];
    await call(async (client) => {
      for await (const m of client.iterMessages(entity, opts)) {
        if (m && m.id && m.className !== 'MessageEmpty') out.push(m);
      }
    });
    return out;
  }

  /**
   * 聊天页取数(双向游标分页;方向语义与 TDLib 版逐分支对齐,游标换算见
   * 文件头)。结果统一按 id 升序;页内消息全部回填 msgCache 预热。
   * 返回 { peer, items, hasOlder, hasNewer }。
   */
  async function getChatPage(peerKey, { anchor = 0, dir = 'around', limit = 30 } = {}) {
    if (!isPeerKey(peerKey)) throw new Error('Telegram 对话 id 非法:' + peerKey);
    const size = Math.min(HISTORY_LIMIT_MAX - 3, Math.max(1, Number(limit) || 30));
    let at = localMsgIdOfSafe(anchor);
    const entity = await entityOf(peerKey);

    // 锚越顶钳制(仅带锚腿):一次 limit=1 探测最新 id,越顶回退最新页语义
    if (at > 0 && (dir === 'newer' || dir === 'around' || dir === 'older')) {
      try {
        const [newest] = await collectIter(entity, { limit: 1, offsetId: 0 });
        const lastId = newest ? Number(newest.id) : 0;
        if (lastId && at > lastId) at = 0;
      } catch (_e) { /* 探测失败:不拦截,按原锚继续 */ }
    }

    let oldMsgs = [];
    let newMsgs = [];
    let hasOlder = false;
    let hasNewer = false;
    let peer = null;

    if (dir === 'newer' && at > 0) {
      // 往新(锚排他,升序输出):addOffset=-(n+2) 探测窗,过滤 id>锚
      const n = Math.min(size, NEWER_PROBE_MAX);
      const [got, peerInfo] = await Promise.all([
        collectIter(entity, { offsetId: at, addOffset: -(n + 2), limit: n + 2 }),
        getPeerInfo(peerKey).catch(() => null),
      ]);
      const newer = got.filter((m) => Number(m.id) > at).sort((a, b) => Number(a.id) - Number(b.id));
      hasNewer = newer.length > n;
      newMsgs = newer.slice(0, n);
      hasOlder = true; // 锚点必在下方,旧向恒可继续翻
      peer = peerInfo;
    } else if (dir === 'older' && at > 0) {
      // 往旧(锚排他):offsetId=锚 → 仅返回 id<锚;多取 1 条判 hasOlder
      const got = await collectIter(entity, { offsetId: at, limit: size + 1 });
      hasOlder = got.length > size;
      hasNewer = true; // 锚点之上必有新消息
      oldMsgs = got.slice(0, size); // 天然降序
    } else if (dir === 'around' && at > 0) {
      // 定位首屏:两腿并发 + 对话头部一并取。
      // 旧腿 offsetId=锚+1(含锚,id≤锚);新腿同 dir=newer 探测窗口径。
      const newerSize = Math.min(size, NEWER_MAX);
      const [olderGot, newerGot, peerInfo] = await Promise.all([
        collectIter(entity, { offsetId: at + 1, limit: size + 1 }),
        collectIter(entity, { offsetId: at, addOffset: -(newerSize + 2), limit: newerSize + 2 }),
        getPeerInfo(peerKey).catch(() => null),
      ]);
      const olderDesc = olderGot.filter((m) => Number(m.id) <= at); // 响应天然降序
      const newer = newerGot.filter((m) => Number(m.id) > at).sort((a, b) => Number(a.id) - Number(b.id));
      hasOlder = olderDesc.length > size;
      hasNewer = newer.length > newerSize;
      // 旧腿自降序头部取 size 条:保锚及其下方较新消息、弃最旧(锚必在页内)
      oldMsgs = olderDesc.slice(0, size);
      newMsgs = newer.slice(0, newerSize);
      peer = peerInfo;
    } else {
      // 最新一页(锚缺省/0/越顶回退):dir=around 无锚 = 前端首屏第一跳,
      // 并发补取对话头部;older/newer 无锚退化为纯翻页,不带头部
      const [got, peerInfo] = await Promise.all([
        collectIter(entity, { limit: size + 1, offsetId: 0 }),
        dir === 'around' ? getPeerInfo(peerKey).catch(() => null) : Promise.resolve(null),
      ]);
      hasOlder = got.length > size;
      oldMsgs = got.slice(0, size);
      peer = peerInfo;
    }

    // 合并排序:升序输出(契约形状)
    const raw = [...oldMsgs, ...newMsgs].sort((a, b) => Number(a.id) - Number(b.id));
    for (const m of raw) putMessage(peerKey, m);
    const items = await collectAndNormalize(peerKey, raw);
    return { peer, items, hasOlder, hasNewer };
  }

  // ============ peer 头部信息(getPeerInfo) ============

  /**
   * 对话头部信息:messages.GetPeerDialogs 单会话定向(dialog.readInboxMaxId/
   * readOutboxMaxId/unreadCount/topMessage 全在)→ 契约
   * {peerKey,name,kind,avatar,canSend,unreadCount,readInboxMaxId,topMessage,
   * readOutboxMaxId}。全链失败返回 null(调用方 peer 置 null 渲染)。
   */
  async function getPeerInfo(peerKey) {
    if (!isPeerKey(peerKey)) throw new Error('Telegram 对话 id 非法:' + peerKey);
    const Api = defaultLib.Api;
    try {
      const entity = await entityOf(peerKey);
      const r = await call(async (client) => {
        const inputPeer = peerKey === 'saved'
          ? new Api.InputPeerSelf()
          : await client.getInputEntity(entity);
        return client.invoke(new Api.messages.GetPeerDialogs({
          peers: [new Api.InputDialogPeer({ peer: inputPeer })],
        }));
      });
      const dialog = r && Array.isArray(r.dialogs) && r.dialogs[0];
      const identEntity = (r && Array.isArray(r.chats) && r.chats[0])
        || (r && Array.isArray(r.users) && r.users[0])
        || entity;
      const identity = entityIdentity(identEntity, selfId());
      if (!identity || !dialog || dialog.className !== 'Dialog') return null;
      let name = identity.kind === 'saved' ? '我的收藏' : nameOf(identEntity);
      if (!name) return null;
      const chatEntity = peerKey === 'saved' ? null : identEntity;
      return {
        peerKey,
        name,
        kind: identity.kind,
        avatar: imgOf(avatarToken(peerKey)),
        canSend: canSendOf(identity.kind, chatEntity),
        unreadCount: Number(dialog.unreadCount) || 0,
        readInboxMaxId: Number(dialog.readInboxMaxId) || 0,
        topMessage: Number(dialog.topMessage) || null,
        readOutboxMaxId: Number(dialog.readOutboxMaxId) || 0,
      };
    } catch (_e) {
      return null; // 全链失败:交调用方按 null 渲染
    }
  }

  // ============ 单条消息 ============

  /** 单条消息归一化(force 穿透 msgCache 强拉;写侧回执复用) */
  async function getOneMessage(peerKey, msgId, force = false) {
    if (!isPeerKey(peerKey)) throw new Error('Telegram 对话 id 非法:' + peerKey);
    const msg = await getMessage(peerKey, msgId, force);
    const [item] = await collectAndNormalize(peerKey, [msg]);
    return item;
  }

  /** 账号态作废(engine dropCaches 广播) */
  function dropCaches() {
    msgCache.clear();
    usersCache.clear();
  }

  return {
    // —— facade 面(engine.js 装配) ——
    getChatPage,
    getOneMessage,
    getPeerInfo,
    collectAndNormalize,
    // —— 兄弟域复用面(媒体/更新/写侧;不复制第二份缓存) ——
    getMessage,
    putMessage,
    dropMessages,
    findMessagesByIds,
    rekeyMessage,
    dropCaches,
    // —— 测试与诊断口(非契约) ——
    _debug: { msgCache, usersCache },
  };
}

// ============ 模块内小工具(entity 形态判定;dialogs.identityOf 的轻量镜像) ============

function entityIdentity(e, selfId = '') {
  if (!e) return null;
  const cn = e.className;
  if (cn === 'User') {
    const saved = selfId && String(e.id) === String(selfId);
    return { peerKey: saved ? 'saved' : 'u' + e.id, kind: saved ? 'saved' : 'user' };
  }
  if (cn === 'Chat' || cn === 'ChatForbidden') return { peerKey: 'g' + e.id, kind: 'group' };
  if (cn === 'Channel' || cn === 'ChannelForbidden') {
    return { peerKey: 'c' + e.id, kind: e.megagroup ? 'group' : 'channel' };
  }
  return null;
}

function nameOf(e) {
  if (!e) return '';
  if (e.className === 'User') {
    return (((e.firstName || '') + ' ' + (e.lastName || '')).trim())
      || (e.username ? '@' + e.username : '') || 'Telegram 用户';
  }
  return String(e.title || '');
}

/** canSend 启发式:频道/未知禁发;群/私聊看禁言位(defaultBannedRights.sendPlainMessages) */
function canSendOf(kind, entity) {
  if (kind === 'channel' || kind === 'other') return false;
  if (!entity) return kind === 'user' || kind === 'group' || kind === 'saved';
  const banned = entity.defaultBannedRights;
  if (banned && banned.sendPlainMessages) return false;
  return true;
}

/** anchor 的宽松换算(0/非法 → 0;合法正整数按 TDLib 打包 shim 解包) */
function localMsgIdOfSafe(anchor) {
  const n = Number(anchor) || 0;
  if (n <= 0) return 0;
  return n < (1 << 20) ? n : Number(BigInt(n) >> 20n);
}
