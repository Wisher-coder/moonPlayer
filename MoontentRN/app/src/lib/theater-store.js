// ============================================================================
// theater-store.js —— 剧场模式全局状态（模块级极简 store + useSyncExternalStore）
// ----------------------------------------------------------------------------
// 移植自 NextWeb/app/video/[site]/[id]/theater.js（1:1 同口径）：
//   - 状态不进 URL（YouTube 亦然）；观看页进页/跨站时由页面调 set(false) 复位，
//     同站切集不触发复位——剧场是「浏览形态」不是「视频属性」，选集连播中途
//     塌回双列即「整个大刷新」体感；
//   - 播放器控制条（PlayerControls）的「剧场」按钮接 toggle()，布局随本 store
//     切换：剧场态播放器通栏出血、信息与相关限宽居中（观看页消费）；
//   - 无持久化：杀进程/刷新即回默认态（模块变量，不落 AsyncStorage）。
// 消费入口：useTheater() → { theater:boolean, toggle(), set(v) }，
// 另附 setTheater/toggleTheater 裸函数（非组件场景用）。
// ============================================================================
import { useSyncExternalStore } from 'react';

let theater = false;         // 全局唯一快照（首帧恒 false，无 hydration 差异）
const listeners = new Set(); // 订阅者（useSyncExternalStore 内部注册）

function emit() {
  for (const fn of listeners) fn();
}

// 显式置位（等值短路，避免无谓重渲染）
export function setTheater(v) {
  const next = !!v;
  if (next === theater) return;
  theater = next;
  emit();
}

// 切换（播放器控制条「剧场」按钮用）
export function toggleTheater() {
  setTheater(!theater);
}

function subscribe(fn) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot() {
  return theater;
}

// 消费入口：{ theater:boolean, toggle(), set(v) } —— 跨组件共享同一份状态
// （观看页布局与播放器控制条按钮读同一个快照，切换即同帧联动）
export function useTheater() {
  const value = useSyncExternalStore(subscribe, getSnapshot);
  return { theater: value, toggle: toggleTheater, set: setTheater };
}
