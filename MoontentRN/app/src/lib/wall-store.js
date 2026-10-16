// ============================================================================
// wall-store.js —— 「视频大屏看板」数据 store（模块级单例 + Set 订阅 +
// useSyncExternalStore,与 theater-store/settings 同款零依赖形态）
// ----------------------------------------------------------------------------
// 移植自 NextWeb/src/lib/wall-store.js,行为 1:1,RN 三端适配点:
//   1) 持久化 localStorage → AsyncStorage(键 'moontent_wall',只存 items,open
//      开关不持久化,重启后默认收起)。AsyncStorage 是异步存储,无法像 NextWeb
//      那样模块加载同步读——改为「加载即异步水合」(fire-and-forget,读完 emit
//      一次让已挂载的看板浮层对齐本机数据),期间内存态照常可用;水合完成时若
//      内存 items 已非空(极端时序:水合完成前用户已加入),以内存为准不覆盖
//      (会话内新增数据不丢)。
//   2) 写回改为 write-behind:setItems 换引用后同步 emit(UI 即时),落盘异步
//      进行、try/catch 静默(存储不可用只丢持久化,不影响内存态功能)。
//   3) NextWeb 满员淘汰走 sonner toast——RN 端无全局 toast 基建,降级为静默
//      (加入方 PlayerControls 的「图标变 Check」本地反馈已足够)。
//   4) 新增「看板入口注入通道」(setWallEntry/useWallEntry):PlayerControls 嵌在
//      VideoPlayer(.web).js 内层,本任务不可改那两个文件,prop 传不进去;观看页
//      经本通道注册「加入看板候选提供器」,PlayerControls 缺 onAddWall prop 时
//      兜底读注入(prop 优先,两者皆无则不渲染按钮,向后兼容语义不变)。这是与
//      NextWeb(直接在 ArtPlayer 内挂按钮)的唯一结构性差异,行为语义一致:
//      加入不自动打开看板、迷你态不注入(只有观看页注册,卸载即注销)。
//   5) 桌面 Electron 跨窗同步:主窗与播放窗是两个渲染进程,本 store 是模块级
//      单例——播放窗「添加到看板」原本只写自己的内存态,主窗 TopBar 的看板
//      胶囊+计数气泡永远不出现。接线:setItems(本地变更唯一出口)末尾
//      wallBroadcast(items) 经主进程转发给其余窗;收到 moontent:wall-changed
//      走 applyExternalItems 整组替换(sanitize 后等值短路)。防回声:外部应用
//      不再广播;防重复落盘:外部应用不回写存储(发起窗已写)。open 开关是每窗
//      UI 态不参与同步(看板浮层只在主窗,播放窗无浮层)。非桌面环境桥全为
//      no-op,三端行为零变化。
// 数据形态:state = { items: WallItem[], open: boolean }
//   WallItem = { key: 'site:id'(去重主键), site, id, title, cover(可空),
//     duration(秒|null), hd, t(加入时进度秒), d(总时长秒,可 0),
//     ratio(宽高比 w/h,默认 16/9), at(加入时间戳,置顶时刷新) }
// items 最新在前(unshift),上限 WALL_MAX=16,加新超限淘汰末尾最旧项。
// updateWallProgress/updateWallRatio 是播放器高频回调(看板开着时每秒/每次
// 尺寸事件打进来):等值短路——值没变就不换 items 引用、不写存储、不 emit,
// 避免整个看板浮层无谓重渲染。
// ============================================================================
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { primeWallSrc } from './wall-src.js';
import { isDesktopApp, wallBroadcast, subscribeWallChanged } from './desktop-bridge.js';

const WALL_KEY = 'moontent_wall';
export const WALL_MAX = 16;
const DEF_RATIO = 16 / 9;

// 数值修复:非有限数/负数一律回退默认(进度秒与总时长不允许出现 NaN/负值)
const num = (v, def) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : def);

// AsyncStorage 读取结果 → 修复后的 items:字段过滤 + 修复,key 一律按 site:id
// 重算,防止旧版本/手改数据把脏形态带进内存;只认白名单字段,多余字段丢弃。
// 同 key 去重:存储数组中重复的 site:id 只留一条(addToWall 运行时本身按 key
// 去重,此处是对历史脏数据/异常写入的兜底——重复格会让看板同一视频铺两格)
function sanitizeItems(raw) {
  const arr = Array.isArray(raw) ? raw : raw && Array.isArray(raw.items) ? raw.items : [];
  const seen = new Set(); // 首见保留(数组序=新在前,留最新一条)
  return arr
    .filter((x) => x && x.site && x.id != null)
    .map((x) => ({
      key: x.site + ':' + String(x.id),
      site: String(x.site),
      id: x.id,
      title: typeof x.title === 'string' ? x.title : String(x.title || ''),
      cover: typeof x.cover === 'string' ? x.cover : String(x.cover || ''),
      duration: typeof x.duration === 'number' && isFinite(x.duration) ? x.duration : null,
      hd: !!x.hd,
      t: num(x.t, 0),
      d: num(x.d, 0),
      ratio: typeof x.ratio === 'number' && isFinite(x.ratio) && x.ratio > 0 ? x.ratio : DEF_RATIO,
      at: num(x.at, Date.now()),
    }))
    .filter((x) => (seen.has(x.key) ? false : (seen.add(x.key), true)))
    .slice(0, WALL_MAX);
}

let state = { items: [], open: false };
const subs = new Set();

const emit = () => {
  for (const fn of subs) {
    try { fn(); } catch (_e) { /* 单个订阅异常不影响其它订阅 */ }
  }
};

// items 变更统一出口:换 state/items 引用 → 异步写回 AsyncStorage(write-behind,
// 失败静默:隐私模式/存储写满都不影响内存态)→ 通知订阅 → 桌面壳广播给其余窗
// (播放窗加项 → 主窗胶囊+气泡即时出现;非桌面环境 no-op)
const setItems = (items) => {
  state = { ...state, items };
  AsyncStorage.setItem(WALL_KEY, JSON.stringify({ items: state.items })).catch(() => {
    /* 存储不可用:跳过(会话级数据,重启丢持久化可接受) */
  });
  emit();
  wallBroadcast(state.items);
};

// ===== 模块加载即异步水合(fire-and-forget,不阻塞任何消费方挂载) =====
// 读完 emit 一次:已挂载的看板浮层(停车场形态)拿到本机数据即铺 tiles 预载;
// 水合完成前若内存 items 已非空(用户已手动加入),内存为准不覆盖
(async () => {
  let items = [];
  try {
    items = sanitizeItems(JSON.parse((await AsyncStorage.getItem(WALL_KEY)) || 'null'));
  } catch (_e) {
    items = []; // 旧数据损坏:当不存在,重建
  }
  if (state.items.length === 0 && items.length > 0) {
    state = { ...state, items };
    emit();
  }
})();

// ===== 桌面跨窗同步接收(仅 Electron 壳;preload 在页面脚本前注入,时序安全) =====
// 其余窗发来的 items 整组替换本窗内存态。口径:
//   - sanitize 后与当前态 JSON 等值短路:字段顺序两端同源(sanitize 与各 mutator
//     的字面量构造序一致),比不出差异就不换引用不 emit,零无谓重渲染;
//   - 不回写 AsyncStorage(发起窗 setItems 已落盘,重复写徒增竞态面);
//   - 不再 wallBroadcast(外部应用绝不转发,防回声环);
//   - 对本次新出现的 key 顺手 primeWallSrc:接收窗(典型是主窗)的 wall-src
//     缓存是冷的,预热后主窗首开看板 tile 命中热缓存秒挂流。
// 极端并发(两窗毫秒级同时变更)last-writer-wins 整组覆盖——看板是轻量功能,
// 可接受;常态下所有消息经同一主进程串行转发,顺序一致。
function applyExternalItems(raw) {
  const items = sanitizeItems(raw);
  if (JSON.stringify(items) === JSON.stringify(state.items)) return;
  const prevKeys = new Set(state.items.map((x) => x.key));
  state = { ...state, items };
  emit();
  for (const it of items) {
    if (!prevKeys.has(it.key)) primeWallSrc(it.site, it.id);
  }
}

if (isDesktopApp()) {
  subscribeWallChanged((payload) => {
    if (!payload || typeof payload !== 'object') return;
    applyExternalItems(payload.items);
  });
}

// 加入/刷新看板项(返回 'invalid' | 'updated' | 'added',调用方据此做本地反馈):
// site/id 缺失 → 'invalid';同 key 已存在 → 只更新 t/d/cover/title 并置顶
// (at 刷新,ratio 保留已修正值),→ 'updated';新项 unshift 到最前,超上限淘汰
// 末尾最旧项(NextWeb 此处 toast 提示,RN 无全局 toast:静默),→ 'added'。
// 入参只收白名单字段,多余字段(播放器内部句柄等)忽略。
// 两种成功路径都顺手 primeWallSrc 后台预解析播放地址——看板首开命中热缓存,
// tile 免等服务端现取上游的往返(秒开的第一半)。
export function addToWall(video) {
  if (!video || !video.site || video.id == null) return 'invalid';
  const site = String(video.site);
  const key = site + ':' + String(video.id);
  const t = num(video.t, 0);
  const d = num(video.d, 0);
  const idx = state.items.findIndex((x) => x.key === key);
  if (idx >= 0) {
    const prev = state.items[idx];
    const next = {
      ...prev,
      title: typeof video.title === 'string' ? video.title : String(video.title || ''),
      cover: typeof video.cover === 'string' ? video.cover : String(video.cover || ''),
      t,
      d,
      at: Date.now(), // 置顶时间刷新,排序口径统一用 at
    };
    setItems([next].concat(state.items.filter((x) => x.key !== key)));
    primeWallSrc(site, video.id); // 刷新也重预热:进度同步后大概率马上要开看板
    return 'updated';
  }
  const item = {
    key,
    site,
    id: video.id,
    title: typeof video.title === 'string' ? video.title : String(video.title || ''),
    cover: typeof video.cover === 'string' ? video.cover : String(video.cover || ''),
    duration: typeof video.duration === 'number' && isFinite(video.duration) ? video.duration : null,
    hd: !!video.hd,
    t,
    d,
    ratio: DEF_RATIO, // 先按 16:9 上墙,tile 播放后由 updateWallRatio 修正
    at: Date.now(),
  };
  const items = [item].concat(state.items);
  while (items.length > WALL_MAX) {
    items.pop(); // 末尾 = 最旧(at 最小,unshift 语义保证);RN 无 toast:静默淘汰
  }
  setItems(items);
  primeWallSrc(site, video.id); // 添加即后台预解析地址(wall-src LRU+TTL)
  return 'added';
}

// 按 key 移除单项(不存在时静默返回,不写不 emit)
export function removeFromWall(key) {
  if (!state.items.some((x) => x.key === key)) return;
  setItems(state.items.filter((x) => x.key !== key));
}

// 清空 items(open 开关不动:面板还开着,只是格子没了)
export function clearWall() {
  if (state.items.length === 0) return;
  setItems([]);
}

// 就地回写单项播放进度(看板 tile 节流调用):不刷新 at、不重排、不置顶;
// t/d 与现值完全一致时短路,零副作用
export function updateWallProgress(key, t, d) {
  const tv = num(t, 0);
  const dv = num(d, 0);
  const cur = state.items.find((x) => x.key === key);
  if (!cur || (cur.t === tv && cur.d === dv)) return;
  setItems(state.items.map((x) => (x.key === key ? { ...x, t: tv, d: dv } : x)));
}

// 就地回写单项实测宽高比(tile 拿到视频真实分辨率后调用一次):与现值差
// < 0.02 视为抖动跳过,防止布局频繁重算引起看板跳动
export function updateWallRatio(key, ratio) {
  if (typeof ratio !== 'number' || !isFinite(ratio) || ratio <= 0) return;
  const cur = state.items.find((x) => x.key === key);
  if (!cur || Math.abs(cur.ratio - ratio) < 0.02) return;
  setItems(state.items.map((x) => (x.key === key ? { ...x, ratio } : x)));
}

// 看板浮层开关(路由级 UI 态,不持久化);等值短路,变更才 emit
export function setWallOpen(open) {
  const v = !!open;
  if (state.open === v) return;
  state = { ...state, open: v };
  emit();
}

const subscribe = (fn) => {
  subs.add(fn);
  return () => subs.delete(fn);
};

// SSR/静态渲染快照必须是稳定引用(模块级常量):getServerSnapshot 每次返回新
// 数组会让 hydration 比较永不相等 → 无限重渲染(expo-router 静态导出/React
// StrictMode 双渲染下同理);水合完成后客户端快照接管真实数据
const SERVER_ITEMS = [];
const SERVER_STATE = { items: SERVER_ITEMS, open: false };

// 整个 state(items + open);消费方按需选下面更细的 selector,减少重渲染面
export function useWall() {
  return useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
}

export function useWallItems() {
  return useSyncExternalStore(subscribe, () => state.items, () => SERVER_ITEMS);
}

export function useWallCount() {
  return useSyncExternalStore(subscribe, () => state.items.length, () => 0);
}

export function useWallOpen() {
  return useSyncExternalStore(subscribe, () => state.open, () => false);
}

// ============================================================================
// 看板入口注入通道 —— PlayerControls「加入看板」钮与观看页的接线桥
// ----------------------------------------------------------------------------
// 背景:PlayerControls 由 VideoPlayer.js / VideoPlayer.web.js 内层渲染,观看页
// 无法直接递 prop(那两个文件与本 store 均为他人领地,不加耦合)。观看页把
// 「当前视频加入看板候选」的提供器注册进本通道(() => WallItem 形态 | null),
// PlayerControls 经 useWallEntry() 订阅:有注入(或传入 onAddWall prop)才渲染
// 「看板」钮,点击取候选调 addToWall 并做 Check 反馈。
// 语义对齐 NextWeb ArtPlayer 的看板入口:加入不自动打开看板;迷你态不注入
// (只有观看页注册,路由离开/卸载即注销,迷你浮层控件层本就不渲染 PlayerControls)。
// ============================================================================
let entryProvider = null; // 当前注册的候选提供器(仅一份:观看页独占)
const entrySubs = new Set();

const emitEntry = () => {
  for (const fn of entrySubs) {
    try { fn(); } catch (_e) { /* 单个订阅异常不影响其它订阅 */ }
  }
};

// 注册/注销候选提供器(fn 为 null 或缺省 = 注销);同引用重复注册幂等短路
export function setWallEntry(fn) {
  const next = typeof fn === 'function' ? fn : null;
  if (next === entryProvider) return;
  entryProvider = next;
  emitEntry();
}

// PlayerControls 消费:返回当前提供器(null = 无入口,不渲染看板钮)
export function useWallEntry() {
  return useSyncExternalStore(
    (fn) => {
      entrySubs.add(fn);
      return () => entrySubs.delete(fn);
    },
    () => entryProvider,
    () => null
  );
}
