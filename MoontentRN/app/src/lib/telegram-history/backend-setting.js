// ============================================================================
// backend-setting.js —— 聊天历史后端调试开关(本地设置持久化 + hook)
// ----------------------------------------------------------------------------
// 参照系:.fixtmp/tgios-pages-blueprint.md §2.6(切换与回滚)。
// 取值 ∈ 'auto' | 'flatlist' | 'virtual',缺省 'auto' → 解析为 A(FlatList
// 后端)——解析规则在 history-backend.js 的 resolveBackendKind(纯函数,门
// 10-⑨ 直测:setting 缺失 → usesBackend==='flatlist')。三态对照 TI:
//   'virtual'  = Debug 开关 coreListChatBackend(强制开)等价;
//   'auto'/'flatlist' = 缺省 A;
//   无服务端 killswitch(TI ios_killswitch_disable_corelist_chat_backend 的
//   「服务器压过 Debug」语义在单机自部署无对应面),设备级退出=切回 'auto'。
// 选择器落点(§2.6):useHistoryBackendSetting() 在聊天页挂载时读一次 →
// 构造协调器时传入——三态选择器落在 init、每实例一次、构造期决策(TI 同构);
// 切换后以 tick 换 key 整体重挂聊天页(telegram.js 既有重挂模式)。
// 调试入口:聊天页头部标题长按 → 通用菜单显示「切换聊天历史后端」,点击写
// setting 并重挂;普通用户不可见风险低(无入口暗示),运维可即时回滚。
// ----------------------------------------------------------------------------
// 存储口径照抄 tg-read.js:AsyncStorage 单键 JSON、读-改-写模块级串行链、
// 存储不可用静默降级(读回 null=用缺省,写跳过)。纯本地调试态,不上传。
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  HISTORY_BACKEND_STORAGE_KEY, HISTORY_BACKEND_VALUES, resolveBackendKind,
} from './history-backend.js';

// 读-改-写串行链(tg-read.js 同款:前序失败也要继续跑后续任务)
let chain = Promise.resolve();
function enqueue(task) {
  const run = chain.then(task, task);
  chain = run.then(() => {}, () => {});
  return run;
}

// 读原始 setting(null=未设置/存储不可用,调用方用 resolveBackendKind 回缺省)
export async function getHistoryBackendSetting() {
  try {
    const v = await AsyncStorage.getItem(HISTORY_BACKEND_STORAGE_KEY);
    return typeof v === 'string' && HISTORY_BACKEND_VALUES.indexOf(v) !== -1 ? v : null;
  } catch (_e) {
    return null; // 存储不可用:按未设置处理(缺省 A,绝不抛)
  }
}

// 写 setting(非法值静默忽略;存储不可用静默降级)。返回最终生效的原始值;
// 同步推进模块缓存(切换后重挂的聊天页实例必须立刻读到新值,不能吃旧缓存)。
export async function setHistoryBackendSetting(value) {
  if (HISTORY_BACKEND_VALUES.indexOf(value) === -1) return getHistoryBackendSetting();
  await enqueue(async () => {
    try {
      await AsyncStorage.setItem(HISTORY_BACKEND_STORAGE_KEY, value);
    } catch (_e) { /* 存储不可用:跳过 */ }
    cachedRaw = value; // 意图即真相:即便存储失败,本进程内的选择也已生效
  });
  return value;
}

// 模块级缓存:首个挂载后,后续聊天页实例在同一进程内微任务级拿到结果
// (避免每次进聊天页都等一个完整 AsyncStorage 往返)
let cachedRaw;
let cachedPromise = null;
function readOnce() {
  if (cachedPromise) {
    // 已有读在途/已完成:完成后取最新缓存(切换可能发生在读在途期间)
    return cachedPromise.then(() => cachedRaw);
  }
  cachedPromise = getHistoryBackendSetting().then((v) => {
    cachedRaw = v;
    return v;
  });
  return cachedPromise;
}

// —— hook:挂载时读一次(构造期决策,每实例一次)。返回 { ready, raw, kind }:
//   ready  首读是否完成(未完成时页面渲染骨架,不构造后端);
//   raw    原始 setting(null=未设置);
//   kind   解析后的实际后端('flatlist' | 'virtual'),由 resolveBackendKind
//          统一解析(含非法值回缺省),页面不得自行判字符串(防重推)。
// 切换流程(调试菜单):setHistoryBackendSetting(v) → 调用方以 tick 换 key
// 重挂本页 → 新实例的 hook 首读命中模块缓存并拿到新值 → 构造期生效。
export function useHistoryBackendSetting() {
  const [raw, setRaw] = useState(() => (cachedPromise ? cachedRaw : undefined));
  useEffect(() => {
    let alive = true;
    readOnce().then((v) => {
      if (alive) setRaw(v); // effect 体内的异步续体 setState(Compiler 红线合规)
    });
    return () => {
      alive = false;
    };
  }, []);
  const ready = raw !== undefined;
  const kind = ready ? resolveBackendKind(raw) : null;
  // 切换:写 setting 并同步本 hook 状态 → kind 变化 → 调用方以 tick 换 key
  // 重挂聊天页(键含 kind),新实例构造期即用新后端。
  const update = useCallback(
    (v) => setHistoryBackendSetting(v).then((final) => {
      setRaw(final);
      return final;
    }),
    []
  );
  return { ready, raw, kind, update };
}
