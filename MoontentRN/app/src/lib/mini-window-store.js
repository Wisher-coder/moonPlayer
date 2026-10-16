// ============================================================================
// mini-window-store.js —— 桌面播放窗「小窗播放」态（模块级单例 + 订阅）
// ----------------------------------------------------------------------------
// 语义：Electron 播放独立窗的「小窗播放」开关态（控制条右下钮切；主进程把窗
// 缩成小窗并置顶，见 desktop/main.js 的 moontent:win-toggle-mini）。窗口把态
// 写进本 store，观看页据此收掉右侧面板（小窗里只留视频），外壳据此在小窗态
// 补顶部片名（站方小窗形态：home + 片名在顶、视频铺满、控件压在画面上）。
// 形态与 theater-store 同款：模块级变量 + useSyncExternalStore；非桌面环境
// 恒 false（不显示小窗钮，见 PlayerControls）。
// ============================================================================
import { useSyncExternalStore } from 'react';

let mini = false;
const subs = new Set();

function emit() {
  for (const fn of subs) {
    try {
      fn();
    } catch (_e) {
      /* 单个订阅异常不影响其它订阅 */
    }
  }
}

/** 置小窗态（等值短路；由控制条小窗钮/外壳初值查询调用） */
export function setMiniWindow(v) {
  const next = !!v;
  if (next === mini) return;
  mini = next;
  emit();
}

function subscribe(fn) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

function getSnapshot() {
  return mini;
}

/** 消费入口：小窗态（boolean） */
export function useMiniWindow() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** 裸读（非组件场景） */
export function getMiniWindow() {
  return mini;
}
