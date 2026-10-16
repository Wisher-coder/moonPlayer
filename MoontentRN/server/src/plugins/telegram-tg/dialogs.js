// ============================================================================
// dialogs.js —— teleproto 引擎·对话目录数据面(仅 Node 服务端运行)
// ----------------------------------------------------------------------------
// 职责(TDLib 版同形,取数换 MTProto):
//   ① getDialogs(list):client.getDialogs 全量拉取(custom Dialog 含 entity +
//      原始 Api.Dialog——unreadCount/notifySettings/folderId 都在)→ 产出与
//      TDLib 版同形的内部对话表;main=folderId≠1(归档除外,用户文件夹成员
//      仍在主列表——官方「所有聊天」口径)/archive=folderId===1/folder:N 走
//      iterDialogs({folder:N}) 定向拉取。路由层 /dialogs 的 filter/内存分页
//      逻辑不变(契约逐字不变)。
//   ② entityOf(peerKey):实体解析的跨域共享口(messages/media/writes/extras
//      取消息都要 access_hash)——对话表暖缓存 → 过期/miss 重拉一次 →
//      getInputEntity 兜底;'saved' → 'me'。
//   ③ resolveUsername:contacts.ResolveUsername + TTL 缓存(10min/256,
//      15s 有界超时竞速——TDLib 版同款)。
//   ④ resolveInviteLink:messages.CheckChatInvite(已加入 → 应用内跳转;
//      未加入 → 预览信息)。
//   ⑤ markDialogsDirty/dropCaches:两档新鲜度(updates 事件软作废/账号态
//      整表作废,engine 缓存纪元广播)。
//
// 防风暴红线:一切上游失败如实上抛中文错误(normTgClientError 统一归一,
// tg-client.js 单一实现),绝不自动重试;目录缓存按 list 分键 TTL 5min。
//
// 与 TDLib 版的有意差异(注释留档):
//   · 拉取上限:MTProto 无本地库,全量装载是逐页网络请求(100/页)——上限
//     1000(TDLib 版 loadChats 全量装载有本地库兜底);超大账号的目录截断在
//     前 1000 个,分页 hasMore 相应收口,folder/archive 定向拉取不受影响;
//   · muted:notifySettings.muteUntil(unix 秒)> now 即静音(绝对时刻口径,
//     TDLib mute_for 剩余秒口径等价);
//   · pinned:custom Dialog.pinned(该 dialog 所属 folder 档内置顶——main/
//     archive/folder 各自拉取时即各自档位,语义与 TDLib positions 等价)。
// ============================================================================

import { TgNotLoggedInError, isPeerKey, markedOf } from './shared.js';
import { normTgClientError } from './tg-client.js';
import { peerKeyOfPeer, previewMetaOf } from './normalize.js';
import * as defaultLib from 'teleproto';

// ============ 常量(与 TDLib 版同款口径) ============

const DIALOGS_TTL = 5 * 60e3;    // 对话表缓存 5 分钟
const RESOLVE_TTL = 10 * 60e3;   // resolve 成功缓存 10 分钟
const RESOLVE_TIMEOUT = 15e3;    // resolve 有界等待上限 15s
const RESOLVE_CACHE_MAX = 256;   // resolve 缓存上限 256
const DIR_FETCH_MAX = 1000;      // 全量拉取上限(MTCPoto 无本地库;见文件头差异说明)

// ============ 纯函数:entity → {peerKey, kind} ============

/**
 * MTProto 实体(User/Chat/Channel* + Forbidden 形态)→ {peerKey, kind};
 * 不可识别形态回 null(不参与目录)。Channel.megagroup 为超群(kind='group'),
 * 否则频道;saved 识别命中自己。
 */
export function identityOfEntity(e, ownUserId = null) {
  if (!e) return null;
  const cn = e.className;
  if (cn === 'User') {
    const saved = ownUserId != null && String(e.id) === String(ownUserId);
    return { peerKey: saved ? 'saved' : 'u' + e.id, kind: saved ? 'saved' : 'user' };
  }
  if (cn === 'Chat' || cn === 'ChatForbidden') return { peerKey: 'g' + e.id, kind: 'group' };
  if (cn === 'Channel' || cn === 'ChannelForbidden') {
    return { peerKey: 'c' + e.id, kind: e.megagroup ? 'group' : 'channel' };
  }
  return null;
}

/** 实体显示名(与 teleproto getDisplayName 同源:Chat/Channel.title、User 拼名) */
export function nameOfEntity(e) {
  if (!e) return '';
  const cn = e.className;
  if (cn === 'User' || cn === 'UserEmpty') {
    return (((e.firstName || '') + ' ' + (e.lastName || '')).trim())
      || (e.username ? '@' + e.username : '') || 'Telegram 用户';
  }
  return String(e.title || '');
}

/**
 * custom Dialog(teleproto tl/custom/dialog)→ 目录条目(契约形状与 TDLib
 * 版逐字段同形):{peerKey,name,kind,chat,lastAt(秒),unreadCount,
 * unreadMentionsCount,muted,pinned,lastMessage}。chat 字段携带 MTProto
 * entity(域内 entityOf/查名链路使用;路由层不消费)。
 */
export function dialogEntryOf(d, { ownUserId = null, nowMs = Date.now() } = {}) {
  if (!d || !d.entity) return null;
  const identity = identityOfEntity(d.entity, ownUserId);
  if (!identity) return null;
  const raw = d.dialog; // 原始 Api.Dialog(unreadCount/notifySettings/folderId)
  const muteUntil = Number(raw && raw.notifySettings && raw.notifySettings.muteUntil) || 0;
  const msg = d.message || (raw && raw.topMessage ? null : null);
  return {
    peerKey: identity.peerKey,
    name: identity.kind === 'saved' ? '我的收藏' : String(d.name || nameOfEntity(d.entity)).trim(),
    kind: identity.kind,
    chat: d.entity,
    lastAt: Number(d.date || (msg && msg.date)) || 0,
    unreadCount: Number(d.unreadCount) || 0,
    unreadMentionsCount: Number(d.unreadMentionsCount) || 0,
    muted: muteUntil * 1000 > nowMs,
    pinned: Boolean(d.pinned),
    lastMessage: msg ? previewMetaOf(msg) : null,
  };
}

// ============ 域核心(纯依赖注入,可独立测试) ============

/**
 * 装配对话目录域。
 * @param {object} deps
 *   getClient  async () => client(engine 注入,每次现取——重建后自动指向新实例)
 *   getSelfId  () => String(自己的 user id 十进制串;saved 识别)
 *   log        (msg)=>void
 *   now        () => ms(测试注入假时钟)
 *   dialogsTtl/resolveTtl/resolveTimeout/resolveCacheMax/fetchMax 有界参数覆盖
 * @returns {{ getDialogs, resolveUsername, resolveInviteLink, entityOf, chatOf,
 *             markDialogsDirty, dropCaches }}
 */
export function createTgDialogs(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const DIALOGS_TTL_MS = Number(deps.dialogsTtl) > 0 ? Number(deps.dialogsTtl) : DIALOGS_TTL;
  const RESOLVE_TTL_MS = Number(deps.resolveTtl) > 0 ? Number(deps.resolveTtl) : RESOLVE_TTL;
  const RESOLVE_TIMEOUT_MS = Number(deps.resolveTimeout) > 0 ? Number(deps.resolveTimeout) : RESOLVE_TIMEOUT;
  const RESOLVE_MAX = Number(deps.resolveCacheMax) > 0 ? Number(deps.resolveCacheMax) : RESOLVE_CACHE_MAX;
  const FETCH_MAX = Number(deps.fetchMax) > 0 ? Number(deps.fetchMax) : DIR_FETCH_MAX;
  const selfId = typeof deps.getSelfId === 'function' ? deps.getSelfId : () => '';

  if (typeof deps.getClient !== 'function') {
    throw new Error('teleproto 对话目录域初始化失败:缺少 getClient 依赖');
  }
  const clientOf = deps.getClient;

  // 发送请求统一包装:错误归一中文(TgNotLoggedInError 透传,不自动重试)
  async function call(fn) {
    const client = await clientOf();
    try {
      return await fn(client);
    } catch (e) {
      if (e instanceof TgNotLoggedInError) throw e;
      throw normTgClientError(e, defaultLib);
    }
  }

  // 目录缓存按 list 分键:'main'/'archive'/'folder:<id>' → { list, at, dirty }
  const caches = new Map();
  const resolveCache = new Map(); // username(小写)→ { out, at }

  /** list 参数归一(main/archive/folder:N);非法抛中文错 */
  function listKeyOf(list) {
    const s = list == null ? 'main' : String(list).trim();
    if (s === 'main' || s === '') return 'main';
    if (s === 'archive') return 'archive';
    const m = /^folder:(\d+)$/.exec(s) || (/^\d+$/.test(s) ? [null, s] : null);
    const fid = m ? Number(m[1]) : 0;
    if (!Number.isSafeInteger(fid) || fid <= 0) {
      throw new Error('无法识别的对话列表:' + s + '(应为 main/archive/文件夹 id)');
    }
    return 'folder:' + fid;
  }

  /**
   * 全量对话表(两档新鲜度):
   * main → getDialogs 全量(folderId≠1 过滤归档);archive → folderId===1;
   * folder:N → iterDialogs({folder:N}) 定向。saved 恒顶、其余 lastAt 降序;
   * main 缺 saved 时 unshift「我的收藏」桩(归档/文件夹不注入)。
   */
  async function getDialogs(list = 'main', o = {}) {
    const { force = false, staleOk = false } = o || {};
    const key = listKeyOf(list);
    const nowMs = now();
    const cached = caches.get(key);
    if (!force && cached && nowMs - cached.at < DIALOGS_TTL_MS
      && (!cached.dirty || staleOk)) {
      return cached.list;
    }
    const raw = await call(async (client) => {
      if (key.startsWith('folder:')) {
        const fid = Number(key.slice(7));
        return client.getDialogs({ limit: FETCH_MAX, folder: fid });
      }
      // main/archive:一次全量拉取后按 folderId 分流(official「所有聊天」口径:
      // 用户文件夹成员仍在主列表,归档不在)
      return client.getDialogs({ limit: FETCH_MAX });
    });
    const wantArchive = key === 'archive';
    const entries = [];
    for (const d of raw || []) {
      if (!d || !d.entity || d.isCommunity) continue; // 社区行不参与对话目录
      if (key === 'main' && d.archived) continue;     // folderId===1(归档)
      if (wantArchive && !d.archived) continue;
      const entry = dialogEntryOf(d, { ownUserId: selfId() || null, nowMs });
      if (entry) entries.push(entry);
    }
    entries.sort((a, b) => (a.kind === 'saved' ? -1 : b.kind === 'saved' ? 1 : b.lastAt - a.lastAt));
    if (key === 'main' && !entries.some((x) => x.kind === 'saved')) {
      entries.unshift({ peerKey: 'saved', name: '我的收藏', kind: 'saved', chat: null, lastAt: 0 });
    }
    caches.set(key, { list: entries, at: now(), dirty: false });
    log('对话目录构建完成(list=' + key + '):' + entries.length + ' 个对话');
    return entries;
  }

  /**
   * 对话键 → MTProto 实体(跨域共享口):main 表优先(staleOk 两档新鲜度),
   * miss 时 getInputEntity(marked)兜底;saved → 'me';失败抛中文错。
   */
  async function entityOf(peerKey) {
    if (!isPeerKey(peerKey)) throw new Error('Telegram 对话 id 非法:' + peerKey);
    if (peerKey === 'saved') return 'me';
    const list = await getDialogs('main', { staleOk: true });
    const hit = list.find((d) => d.peerKey === peerKey);
    if (hit && hit.chat) return hit.chat;
    try {
      return await call((client) => client.getInputEntity(markedOf(peerKey)));
    } catch (_e) {
      throw new Error('未找到该 Telegram 对话(可能已退出),请刷新对话列表');
    }
  }

  /** 对话键 → 实体(表优先;404/不存在回 null,其余错误如实上抛) */
  async function chatOf(peerKey) {
    if (!isPeerKey(peerKey)) throw new Error('Telegram 对话 id 非法:' + peerKey);
    try {
      return await entityOf(peerKey);
    } catch (e) {
      if (/未找到该 Telegram 对话/.test(String((e && e.message) || e))) return null;
      throw e;
    }
  }

  /**
   * 用户名(@username / t.me 链接片段)→ {peerKey,name,kind}。contacts.
   * ResolveUsername;成功 TTL 缓存,失败如实上抛中文错误(格式错误带
   * status=400);15s 竞速超时(TDLib 版同款)。
   */
  async function resolveUsername(domain) {
    const username = String(domain || '').replace(/^@/, '').trim().toLowerCase();
    if (!/^[a-zA-Z0-9_]{4,64}$/.test(username)) {
      const e = new Error('用户名格式不正确(应为 4~64 位字母/数字/下划线)');
      e.status = 400;
      throw e;
    }
    const hit = resolveCache.get(username);
    if (hit && now() - hit.at < RESOLVE_TTL_MS) return hit.out;
    const Api = defaultLib.Api;
    let r;
    let timer = null;
    try {
      const timeout = new Promise((_res, rej) => {
        timer = setTimeout(() => {
          const err = new Error('解析用户名超时,请稍后重试');
          err.resolveTimeout = true;
          rej(err);
        }, RESOLVE_TIMEOUT_MS);
      });
      timeout.catch(() => { /* 竞速落败的拒绝不上抛 */ });
      r = await Promise.race([
        call(async (client) => client.invoke(new Api.contacts.ResolveUsername({ username }))),
        timeout,
      ]);
    } catch (e) {
      if (e && e.resolveTimeout) throw e;
      const m = String((e && (e.errorMessage || e.message)) || e);
      if (/USERNAME_NOT_OCCUPIED/i.test(m)) throw new Error('该用户名不存在或尚未注册');
      if (/USERNAME_INVALID/i.test(m)) throw new Error('该用户名不是有效的 Telegram 用户名');
      throw normTgClientError(e, defaultLib);
    } finally {
      if (timer) clearTimeout(timer);
    }
    // ResolvedPeer{peer, chats, users} → 实体匹配
    const peer = r && r.peer;
    if (!peer) throw new Error('未找到该用户名对应的对话');
    const pool = [...((r && r.chats) || []), ...((r && r.users) || [])];
    let entity = null;
    if (peer.className === 'PeerUser') entity = pool.find((c) => c.className === 'User' && String(c.id) === String(peer.userId));
    else if (peer.className === 'PeerChat') entity = pool.find((c) => /Chat/.test(c.className) && String(c.id) === String(peer.chatId));
    else if (peer.className === 'PeerChannel') entity = pool.find((c) => /Channel/.test(c.className) && String(c.id) === String(peer.channelId));
    let ownUserId = null;
    try { ownUserId = selfId() || null; } catch (_e) { ownUserId = null; }
    const identity = identityOfEntity(entity, ownUserId);
    if (!identity) throw new Error('未找到该用户名对应的对话');
    const out = {
      peerKey: identity.peerKey,
      name: (identity.kind === 'saved' ? '我的收藏' : nameOfEntity(entity)).trim(),
      kind: identity.kind,
    };
    resolveCache.set(username, { out, at: now() });
    if (resolveCache.size > RESOLVE_MAX) resolveCache.delete(resolveCache.keys().next().value);
    return out;
  }

  /**
   * 邀请链接解析(t.me/+hash | t.me/joinchat/<hash>):messages.CheckChatInvite。
   * 已加入(ChatInviteAlready{chat})→ {joined:true,peerKey,name,kind};
   * 未加入(ChatInvite{title,membersCount})→ {joined:false,title,memberCount}。
   * 不做缓存(邀请链接单发点按,无风暴面)。
   */
  async function resolveInviteLink(inviteLink) {
    const link = String(inviteLink || '').trim();
    if (!/^https:\/\/(?:t\.me|telegram\.me)\/(?:\+[A-Za-z0-9_-]{4,}|joinchat\/[A-Za-z0-9_-]{4,})$/i.test(link)) {
      const e = new Error('邀请链接格式不正确');
      e.status = 400;
      throw e;
    }
    const hash = /\/\+([A-Za-z0-9_-]+)/.exec(link) ? /\/\+([A-Za-z0-9_-]+)/.exec(link)[1]
      : /joinchat\/([A-Za-z0-9_-]+)/.exec(link)[1];
    const Api = defaultLib.Api;
    let r;
    let timer = null;
    try {
      const timeout = new Promise((_res, rej) => {
        timer = setTimeout(() => {
          const err = new Error('解析邀请链接超时,请稍后重试');
          err.resolveTimeout = true;
          rej(err);
        }, RESOLVE_TIMEOUT_MS);
      });
      timeout.catch(() => { /* 竞速落败的拒绝不上抛 */ });
      r = await Promise.race([
        call(async (client) => client.invoke(new Api.messages.CheckChatInvite({ hash }))),
        timeout,
      ]);
    } catch (e) {
      if (e && e.resolveTimeout) throw e;
      throw normTgClientError(e, defaultLib);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (r instanceof Api.ChatInviteAlready && r.chat) {
      let ownUserId = null;
      try { ownUserId = selfId() || null; } catch (_e) { ownUserId = null; }
      const identity = identityOfEntity(r.chat, ownUserId);
      if (identity) {
        return {
          joined: true,
          peerKey: identity.peerKey,
          name: (identity.kind === 'saved' ? '我的收藏' : nameOfEntity(r.chat)).trim(),
          kind: identity.kind,
        };
      }
    }
    if (r instanceof Api.ChatInvite) {
      return {
        joined: false,
        title: String(r.title || '').trim(),
        memberCount: Number(r.membersCount) || 0,
      };
    }
    // ChatInvitePeek(预览已加入形态)等:按未加入预览降级
    return { joined: false, title: '', memberCount: 0 };
  }

  /** 事件层软作废:全部 list 的目录缓存仅标记元数据过期,TTL 内 entity 查找照服 */
  function markDialogsDirty() {
    for (const c of caches.values()) c.dirty = true;
  }

  /** 账号态整表作废(登出/换号) */
  function dropCaches() {
    caches.clear();
    resolveCache.clear();
  }

  return {
    getDialogs,
    resolveUsername,
    resolveInviteLink,
    entityOf,
    chatOf,
    markDialogsDirty,
    dropCaches,
  };
}

// ============ engine 装配形状(模块级单例,跨域 entityOf/chatOf 同实例) ============

let sharedDomain = null;

/**
 * engine/wiring 装配入口(幂等):首调以 ctx 建域,后续调用返回同一实例。
 * @param {object} ctx engine 共享上下文(getClient/getSelfId/log,见 engine.js)
 */
export function createDialogs(ctx = {}) {
  if (!sharedDomain) {
    sharedDomain = createTgDialogs({
      getClient: typeof ctx.getClient === 'function' ? ctx.getClient : undefined,
      getSelfId: typeof ctx.getSelfId === 'function' ? ctx.getSelfId : undefined,
      log: typeof ctx.log === 'function' ? ctx.log : undefined,
    });
  }
  return sharedDomain;
}
