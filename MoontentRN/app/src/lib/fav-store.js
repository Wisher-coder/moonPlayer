// ============================================================================
// fav-store.js —— 「收藏」域响应式 store（模块级单例 + Set 订阅 +
// useSyncExternalStore，与 wall-store/theater-store 同款零依赖形态）
// ----------------------------------------------------------------------------
// 收藏域契约：全局共享清单（无账号无设备概念），MySQL 唯一持久层，本 store
// 只是前端的响应式镜像——keys/total 以服务端返回为准，本地乐观 + 回滚 + 校准。
// 状态形态：state = { keys: string[]（"site:id"，收藏时间倒序）, total, ready }
//   ready = 本地水合完成（AsyncStorage 快照已读入或服务端首次同步成功），
//   页面用它避免星标「先灭后亮」的闪变；后端不可用时快照兜底、ready 照常置位。
// 离线兜底：AsyncStorage 'moontent_fav_snapshot' 存最后一份全量快照
//   { ids, items, at }——ids 为全量 key 清单（星标判定离线可用），items 为
//   最近一次拉到的首页清单（收藏页离线首屏兜底，上限 64 条）。每次
//   refreshFavs / toggleFav 校准 / removeFavsLocal / clearFavsLocal 成功后落盘。
// 与 wall-store 的口径对齐：
//   · 模块加载即异步水合（fire-and-forget），读完 emit 一次；水合完成前内存
//     态已被改动（页面抢先 refresh/toggle 的极端时序）则内存为准不覆盖；
//   · 写回 write-behind：换 state 引用后同步 emit（UI 即时），落盘异步进行、
//     失败静默（存储不可用只丢离线兜底，不影响内存态）。
// id 归一化：资源站在播会话 id 形如 vid-epN，收藏按「片」归档——splitEpId
// （复用 history.js 的导出，未导出则补最小 export，此处已直接复用）拆出裸
// vid 再拼 key，与服务端存储的 (site,vid) 天然一致，一部剧全集合共用一颗星。
// ============================================================================
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { favIds, favList, favToggle } from './fav-api.js';
import { splitEpId } from './history.js';

const FAV_KEY = 'moontent_fav_snapshot'; // 离线兜底快照键
const SNAP_ITEMS_MAX = 64;               // 快照 items 上限（首页 24 + 周转余量，防快照膨胀）
const SNAP_PAGE_SIZE = 24;               // refreshFavs 顺带拉取的首页条数（与服务端默认档一致）

// key 形态校验（与服务端契约同款口径）：site:/^[0-9A-Za-z_-]{1,32}$/，
// vid:/^[0-9A-Za-z_.:-]{1,64}$/——vid 允许含 ':'，故按第一个冒号切分
function validKey(k) {
  if (typeof k !== 'string') return false;
  const i = k.indexOf(':');
  if (i <= 0 || i === k.length) return false;
  return /^[0-9A-Za-z_-]{1,32}$/.test(k.slice(0, i)) && /^[0-9A-Za-z_.:-]{1,64}$/.test(k.slice(i + 1));
}

// 服务器/存储读到的 ids → 干净 key 数组：过滤非法形态 + 首见去重（保序，
// 序即收藏时间倒序）
function sanitizeKeys(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const k of arr) {
    if (validKey(k) && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

// 服务器/存储读到的 items → 白名单字段修复（site/id/title/cover/duration/
// hd/at），同 key 去重、截上限；cover 保留原始值（可能是 /api/img/... 相对
// 地址，展示层经 client.js 的 absolutizeUrl 绝对化，快照不预烙基址）
function sanitizeItems(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (!x || !x.site || x.id == null) continue;
    const id = String(x.id);
    const key = String(x.site) + ':' + id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      site: String(x.site),
      id,
      title: typeof x.title === 'string' ? x.title : String(x.title || ''),
      cover: typeof x.cover === 'string' ? x.cover : String(x.cover || ''),
      duration: typeof x.duration === 'number' && isFinite(x.duration) ? x.duration : null,
      hd: !!x.hd,
      at: typeof x.at === 'number' && isFinite(x.at) && x.at > 0 ? x.at : 0,
    });
    if (out.length >= SNAP_ITEMS_MAX) break;
  }
  return out;
}

// 在播会话 id → 收藏归档 id：vid-epN 拆出裸 vid（多集片全集合共用一颗星），
// 其余形态原样字符串化
function normVid(id) {
  const se = splitEpId(id);
  return String(se ? se.vid : id);
}

let state = { keys: [], total: 0, ready: false };
let keySet = new Set();   // keys 的 Set 镜像（useIsFav O(1) 判定，keys 变更时重建）
let snapItems = [];       // 快照 items（离线兜底首屏，独立于 state 生命周期）
let snapAt = 0;           // 快照时间戳（服务端 at 优先）
let localDirty = false;   // 水合完成前内存态是否已被改动（内存为准的短路开关）

const subs = new Set();
const emit = () => {
  for (const fn of subs) {
    try { fn(); } catch (_e) { /* 单个订阅异常不影响其它订阅 */ }
  }
};

// 状态变更统一出口：换 state 引用 → 重建 keySet → 通知订阅。dirty=false 供
// 模块加载水合专用（不点亮「内存为准」开关，后续变更仍可被水合短路保护）
function setState(patch, { dirty = true } = {}) {
  state = { ...state, ...patch };
  if (patch.keys) keySet = new Set(state.keys);
  if (dirty) localDirty = true;
  emit();
}

// 快照落盘（write-behind，失败静默：只丢离线兜底，不影响内存态）
function persistSnapshot() {
  try {
    AsyncStorage.setItem(FAV_KEY, JSON.stringify({ ids: state.keys, items: snapItems, at: snapAt })).catch(() => {
      /* 存储不可用：跳过 */
    });
  } catch (_e) {
    /* 序列化异常（极端脏数据）：跳过 */
  }
}

// ===== 模块加载即异步水合（fire-and-forget，不阻塞任何消费方挂载） =====
(async () => {
  let snap = null;
  try {
    snap = JSON.parse((await AsyncStorage.getItem(FAV_KEY)) || 'null');
  } catch (_e) {
    snap = null; // 旧快照损坏：当不存在，重建
  }
  const ids = sanitizeKeys(snap && snap.ids);
  const items = sanitizeItems(snap && snap.items);
  const at = snap && typeof snap.at === 'number' && snap.at > 0 ? snap.at : 0;
  // 水合完成前内存态已非原始（页面抢先 refresh/toggle）：内存为准不覆盖，
  // 只补 ready（wall-store 同款口径）
  if (!localDirty && ids.length > 0) {
    snapItems = items;
    snapAt = at;
    setState({ keys: ids, total: ids.length, ready: true }, { dirty: false });
    return;
  }
  if (!state.ready) setState({ ready: true }, { dirty: false });
})();

// 收藏/取消收藏（详情页/卡片星标钮调用）：
//   1) 乐观翻转——本地 key 即时加/移（星标零延迟），快照 items 同步调整；
//   2) 服务端取反成功——用响应 {fav,total} 校准（多端并发下本地猜测可能与
//      服务端相反，以响应为准）并落盘快照，返回响应原对象（调用方提示用）；
//   3) 失败——整组回滚到乐观前状态（state + keySet + snapItems）并 rethrow，
//      调用方 catch 呈现错误（如「收藏已满(5000)」「收藏服务暂不可用」）。
// id 形如 vid-epN 时归一为裸 vid（一部剧一颗星，与服务端存储键一致）。
export async function toggleFav(site, item) {
  if (!site || !item || item.id == null) throw new Error('收藏参数缺失');
  const vid = normVid(item.id);
  const key = String(site) + ':' + vid;
  const prevState = state;      // 回滚锚点（setState 恒换新引用，旧对象不可变）
  const prevItems = snapItems;
  const had = keySet.has(key);
  if (had) {
    // —— 乐观移除 ——
    snapItems = snapItems.filter((it) => it.site + ':' + it.id !== key);
    setState({ keys: state.keys.filter((k) => k !== key), total: Math.max(0, state.total - 1) });
  } else {
    // —— 乐观加入（新收藏置顶，序=收藏时间倒序）——
    snapItems = [{
      site: String(site),
      id: vid,
      title: typeof item.title === 'string' ? item.title : String(item.title || ''),
      cover: typeof item.cover === 'string' ? item.cover : String(item.cover || ''),
      duration: typeof item.duration === 'number' && isFinite(item.duration) ? item.duration : null,
      hd: !!item.hd,
      at: Date.now(),
    }].concat(snapItems.filter((it) => it.site + ':' + it.id !== key)).slice(0, SNAP_ITEMS_MAX);
    setState({ keys: [key].concat(state.keys), total: state.total + 1 });
  }
  let res;
  try {
    res = await favToggle({ site: String(site), id: vid, title: item.title, cover: item.cover, duration: item.duration, hd: item.hd });
  } catch (e) {
    // 失败回滚：恢复乐观前的整组状态再抛（UI 星标退回，错误由调用方呈现）
    state = prevState;
    keySet = new Set(state.keys);
    snapItems = prevItems;
    emit();
    throw e;
  }
  // 校准：fav=1 → key 必在（前端猜测为取消、服务端实际仍在收藏的并发场景）；
  // fav=0 → key 必不在；total 一律以响应为准
  const favOn = !!(res && res.fav === 1);
  const total = res && typeof res.total === 'number' && isFinite(res.total) ? res.total : state.total;
  let keys = state.keys;
  if (favOn && !keySet.has(key)) keys = [key].concat(state.keys);
  else if (!favOn && keySet.has(key)) keys = state.keys.filter((k) => k !== key);
  if (favOn && !snapItems.some((it) => it.site + ':' + it.id === key)) {
    snapItems = [{
      site: String(site),
      id: vid,
      title: typeof item.title === 'string' ? item.title : String(item.title || ''),
      cover: typeof item.cover === 'string' ? item.cover : String(item.cover || ''),
      duration: typeof item.duration === 'number' && isFinite(item.duration) ? item.duration : null,
      hd: !!item.hd,
      at: Date.now(),
    }].concat(snapItems).slice(0, SNAP_ITEMS_MAX);
  } else if (!favOn) {
    snapItems = snapItems.filter((it) => it.site + ':' + it.id !== key);
  }
  setState({ keys, total, ready: true });
  persistSnapshot();
  return res;
}

// 静默同步服务器（收藏页/详情页挂载时调用）：并行拉 ids 全量 + 首页清单，
// 成功 → keys/total 以服务端为准、快照落盘，返回 true；失败（含网络断开/
// 后端 503）→ 现有态原样保留（离线快照继续兜底），返回 false。绝不抛错。
export async function refreshFavs() {
  try {
    const [idsRes, listRes] = await Promise.all([
      favIds().catch(() => null),
      favList({ page: 1, size: SNAP_PAGE_SIZE }).catch(() => null),
    ]);
    if (!idsRes || !Array.isArray(idsRes.ids)) return false; // ids 是权威源：它失败即整体放弃
    const keys = sanitizeKeys(idsRes.ids);
    if (listRes && Array.isArray(listRes.items)) snapItems = sanitizeItems(listRes.items);
    // 首页拉取失败时保留现有 snapItems（ids 已新鲜，items 仅离线兜底展示用）
    snapAt = typeof idsRes.at === 'number' && idsRes.at > 0 ? idsRes.at : Date.now();
    setState({
      keys,
      total: typeof idsRes.total === 'number' && isFinite(idsRes.total) ? idsRes.total : keys.length,
      ready: true,
    });
    persistSnapshot();
    return true;
  } catch (_e) {
    return false; // 静默：失败不清现有态、不抛错
  }
}

// 本地移除（favRemove API 成功后由页面调用，纯内存态调整不走网络）
export function removeFavsLocal(keys) {
  const set = new Set((Array.isArray(keys) ? keys : [keys]).filter((k) => typeof k === 'string' && k));
  if (!set.size) return;
  const next = state.keys.filter((k) => !set.has(k));
  if (next.length === state.keys.length) return; // 无命中：不写不 emit
  snapItems = snapItems.filter((it) => !set.has(it.site + ':' + it.id));
  setState({ keys: next, total: next.length });
  persistSnapshot();
}

// 本地清空（favClear API 成功后由页面调用；ready 不动——水合语义已达成）
export function clearFavsLocal() {
  if (state.keys.length === 0) return;
  snapItems = [];
  snapAt = Date.now();
  setState({ keys: [], total: 0 });
  persistSnapshot();
}

// 读最后一份落盘快照（收藏页离线首屏兜底用）：{ ids, items, at } | null，
// 坏数据/无快照返回 null
export async function readFavSnapshot() {
  try {
    const v = await AsyncStorage.getItem(FAV_KEY);
    if (v == null) return null;
    const j = JSON.parse(v);
    if (!j || typeof j !== 'object') return null;
    return {
      ids: sanitizeKeys(j.ids),
      items: sanitizeItems(j.items),
      at: typeof j.at === 'number' && isFinite(j.at) && j.at > 0 ? j.at : 0,
    };
  } catch (_e) {
    return null;
  }
}

const subscribe = (fn) => {
  subs.add(fn);
  return () => subs.delete(fn);
};

// SSR/静态渲染快照必须是稳定引用（模块级常量）：getServerSnapshot 每次返回新
// 数组会让 hydration 比较永不相等 → 无限重渲染（expo-router 静态导出/React
// StrictMode 双渲染下同理）；水合完成后客户端快照接管真实数据
const SERVER_KEYS = [];

// 全量 key 清单（收藏时间倒序）；消费方按需选更细的 selector，减少重渲染面
export function useFavKeys() {
  return useSyncExternalStore(subscribe, () => state.keys, () => SERVER_KEYS);
}

// 单片收藏判定：vid-epN 经 splitEpId 归一为基础 vid 后比对（多集片共用星标）
export function useIsFav(site, id) {
  const key = site != null && id != null ? String(site) + ':' + normVid(id) : null;
  return useSyncExternalStore(subscribe, () => (key ? keySet.has(key) : false), () => false);
}

export function useFavTotal() {
  return useSyncExternalStore(subscribe, () => state.total, () => 0);
}

export function useFavReady() {
  return useSyncExternalStore(subscribe, () => state.ready, () => false);
}
