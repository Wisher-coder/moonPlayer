// ============================================================================
// player-chrome.js —— 播放器 chrome 能力注入通道（与 wall-store 的 setWallEntry
// 同款先例与形态）
// ----------------------------------------------------------------------------
// 为何需要：底部控制条（PlayerControls 嵌在 VideoPlayer(.web).js 内层）与
// 播放窗外壳（_layout.js 的 PlayerWindowFrame：小窗态顶部片名、浮钮锚点）都拿
// 不到观看页手里的数据与动作——「下一集」的选队结果（play-queue 的 nextUp）、
// 「选集」的片单（量贩/合集包）、
// 右栏宽度——props 递不进去。本模块是唯一接线：观看页注册提供器，两侧现算读取。
//
// 契约（提供器返回对象，字段全可空；字段缺席 = 对应钮/文本不渲染）：
//   title    : string                     片名（播放窗外壳在小窗态顶部显示）
//   sideW    : number                     播放窗右侧面板宽（外壳浮钮锚点：右缘
//                                         收进来，钮压在视频区右上而非面板顶上；
//                                         0/缺省 = 无面板，钮贴窗口右缘）
//   next     : { title, go } | null       下一集（go() 切集；title 进无障碍标签）
//   episodes : { count, open, toggle } | null
//                                         选集浮层（open=浮层展开中，供按钮高亮；
//                                         toggle() 开合；count=总集数）
//   mini     : { go } | null              小窗播放（go()=舞台缩小成应用内悬浮小窗
//                                         +退出整条观看链落回链底来路页；桌面壳
//                                         钮位分流走 winControls.toggleMini，
//                                         不消费本字段）
//
// 实现口径：模块级单例 + 版本号（useSyncExternalStore 快照）+ 渲染期现算。
// 不缓存提供器返回值——值变化由观看页重注册（effect 依赖驱动）emit 出去，消费方
// 随之重渲染；现算异常视同无 chrome（绝不把观看页的异常带上控制条）。
// 非观看页（首页/迷你浮层态）不注册 → 各钮不渲染，行为与改动前一致。
// ============================================================================
import { useMemo, useSyncExternalStore } from 'react';

let entry = null; // 当前提供器（观看页注册；卸载/离开即注销）
let version = 0; // 版本号（注册/注销/重注册递增；订阅者据此重渲染）
const subs = new Set();

function emit() {
  version += 1;
  for (const fn of subs) {
    try {
      fn();
    } catch (_e) {
      /* 单个订阅异常不影响其它订阅 */
    }
  }
}

/**
 * 注册 chrome 提供器（fn 非函数 = 注销）
 * @param {null|(() => object)} fn 提供器（每次调用现算并返回契约对象）
 */
export function setChromeEntry(fn) {
  entry = typeof fn === 'function' ? fn : null;
  emit();
}

/** 现算 chrome 描述（渲染期/事件回调均可安全调用；无提供器或异常恒 null） */
export function readChrome() {
  if (!entry) return null;
  try {
    return entry() || null;
  } catch (_e) {
    return null;
  }
}

function subscribe(fn) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

function getVersion() {
  return version;
}

/**
 * 消费入口（组件）：注册表变化即重渲染，返回现算描述（无提供器恒 null）
 * @returns {{ title?: string, sideW?: number, next?: object, episodes?: object, mini?: object }|null}
 */
export function usePlayerChrome() {
  const v = useSyncExternalStore(subscribe, getVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => readChrome(), [v]);
}
