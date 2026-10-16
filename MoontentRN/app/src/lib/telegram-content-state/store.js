// ============================================================================
// telegram-content-state/store.js —— 内容状态机·本地持久化（AsyncStorage）
// ----------------------------------------------------------------------------
// 契约（蓝图二 §5.2，键与淘汰口径照抄 lib/tg-read.js 的阅读位置存储）：
//   loadState(peerKey)  → Promise<ChatContentState | null>
//       该对话的持久化内容状态；无记录 / peerKey 非法 / 存储不可用回 null
//       （装配层据此注入空状态，消费时机见蓝图二 §5.2：items 首次就绪后注入）；
//   saveState(peerKey, state) → Promise<void>
//       覆盖写（读-改-写整体在模块级串行链上单任务完成，防聊天页失焦 flush
//       与卸载 flush 并发丢更新）；state 先经 serializeState 归一，非法输入
//       静默跳过；存储不可用静默降级（读写均不抛）。
//   键 moontent_tg_cstate，形态 { "<peerKey>": { state, at } }：
//     · peerKey 形如 c*/g*/u*/saved（服务端归一化对话键）；
//     · state   归一后的内容状态对象（经 serialize→parse 往返消毒）；
//     · at      写入时间戳，仅用于超上限时淘汰排序（活跃对话留驻）。
//   上限保留最近 200 个对话，超出按 at 淘汰最旧（tg-read.js:61-75 同款）。
// 存储边界：纯本地数据，不上传、不同步（服务端草稿同步已在蓝图二 §4.3 裁掉，
// MTProto L230 无 messages.GetDraft，得不偿失）；与 lib/tg-read.js 的阅读位置
// 是两个正交存储（蓝图二 §1.2 明令不合并边界）。
// 抽象层设计（门 11-④ 的注入口径）：createContentStateStore(kv) 纯工厂接收
//   kv = { getItem(key) → Promise<string|null>, setItem(key, value) → Promise<void> }
// 本文件对 AsyncStorage 零顶层 import——默认实例在首次使用时经动态 import 惰性
// 获取（runner 只注入内存 KV，永不触发该路径，RN 模块不被测试加载；动态 import
// 在本仓已有先例：app/src/app/album/[site]/[id].js 的 React.lazy）。
// 零 RN 顶层 import 的纯逻辑层（runner 直测）；仓库惯例：JS 非 TS、注释中文。
// ============================================================================
import { parseState, serializeState } from './serialize.js';

export const CSTATE_STORAGE_KEY = 'moontent_tg_cstate';
export const CSTATE_MAX_PEERS = 200; // 最多保留的对话数,超出按 at 淘汰最旧

// 读-改-写串行链:任务排队执行,返回各自的 Promise;链上异常吞掉不断链
// （tg-read.js:27-32 同款模式照抄）
function makeChain() {
  let chain = Promise.resolve();
  return function enqueue(task) {
    const run = chain.then(task, task); // 前序失败也要继续跑后续任务
    chain = run.then(() => {}, () => {});
    return run;
  };
}

// 纯工厂：kv 为存储适配器（AsyncStorage 形态子集）；opts.now 仅供 runner 注入
// 确定性时钟做 LRU 淘汰断言（缺省 Date.now）。kv 缺失/不完整 → 读写静默降级
// 的空实现（web 无痕模式等存储不可用场景同路径）。
export function createContentStateStore(kv, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const enqueue = makeChain();

  // 整包读取:损坏/非对象一律当空表重建(旧数据损坏不抛,当不存在)
  async function readAll() {
    try {
      const v = await kv.getItem(CSTATE_STORAGE_KEY);
      if (v == null) return {};
      const j = JSON.parse(v);
      return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
    } catch (_e) {
      return {};
    }
  }

  if (!kv || typeof kv.getItem !== 'function' || typeof kv.setItem !== 'function') {
    return {
      loadState: async () => null,
      saveState: async () => {},
    };
  }

  // 取某对话的持久化内容状态:统一经 parseState 三层兜底（主包损坏/版本不符
  // → 只救 draft），返回完整形状状态或 null（无记录）
  async function loadState(peerKey) {
    const pk = String(peerKey || '');
    if (!pk) return null;
    let map;
    try {
      map = await readAll();
    } catch (_e) {
      return null; // 存储不可用:静默降级
    }
    const entry = map ? map[pk] : null;
    const rawState = entry ? entry.state : null;
    if (rawState == null) return null;
    if (typeof rawState === 'string') return parseState(rawState);
    if (typeof rawState === 'object') return parseState(JSON.stringify(rawState));
    return null;
  }

  // 覆盖写 + 刷新 at（活跃对话免被淘汰）;条目超上限时按 at 升序淘汰最旧的
  // 对话。整个读-改-写在串行链上单任务完成（tg-read.js:61-75 同款口径）。
  function saveState(peerKey, state) {
    return enqueue(async () => {
      const pk = String(peerKey || '');
      if (!pk) return;
      if (!state || typeof state !== 'object' || Array.isArray(state)) return;
      let norm = null;
      try {
        norm = JSON.parse(serializeState(state)); // 归一 + 消毒（脏字段落盘前归零）
      } catch (_e) {
        return; // 序列化异常:静默跳过（不抛,flush 路径不阻塞页面卸载）
      }
      if (!norm) return;
      try {
        const map = await readAll();
        if (!map || typeof map !== 'object') return;
        map[pk] = { state: norm, at: now() };
        const keys = Object.keys(map);
        if (keys.length > CSTATE_MAX_PEERS) {
          keys.sort((a, b) => ((map[a] && map[a].at) || 0) - ((map[b] && map[b].at) || 0));
          for (const k of keys.slice(0, keys.length - CSTATE_MAX_PEERS)) delete map[k];
        }
        await kv.setItem(CSTATE_STORAGE_KEY, JSON.stringify(map));
      } catch (_e) {
        /* 存储不可用:静默降级跳过（防请求风暴红线无关,纯本地写失败不重试） */
      }
    });
  }

  return { loadState, saveState };
}

// —— 默认实例：AsyncStorage 惰性动态 import（零顶层 RN import,见文件头）——
// 加载失败（包缺失/异常环境）→ 空适配器工厂（读写静默降级），绝不抛错打断页面
let defaultStorePromise = null;
function getDefaultStore() {
  if (!defaultStorePromise) {
    defaultStorePromise = Promise.resolve()
      .then(() => import('@react-native-async-storage/async-storage'))
      .then((m) => {
        const ash = m && (m.default || m);
        return createContentStateStore({
          getItem: (k) => ash.getItem(k),
          setItem: (k, v) => ash.setItem(k, v),
        });
      })
      .catch(() => createContentStateStore(null));
  }
  return defaultStorePromise;
}

// 契约出口（蓝图二 §5.2 钉死的两个函数；装配层直接 import 这两个名字使用）
export function loadState(peerKey) {
  return getDefaultStore().then((store) => store.loadState(peerKey));
}

export function saveState(peerKey, state) {
  return getDefaultStore().then((store) => store.saveState(peerKey, state));
}
