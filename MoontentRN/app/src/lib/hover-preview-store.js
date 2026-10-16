// ============================================================================
// hover-preview-store.js —— 视频卡悬浮预览联动 store（RN 三端移植）
// ----------------------------------------------------------------------------
// 源：NextWeb/src/lib/hover-preview-store.js（1:1 照搬：模块级单值 store +
// useSyncExternalStore，零依赖）。卡片只写（use-hover-preview 钩子）、浮层
// （HoverPreviewLayer.web，AppShell 全局唯一）只读：
//   鼠标进卡 → previewIn({ key, site, id, v, el })；鼠标离卡 → previewOut(key)。
// el = 缩略图框（RN-web 的 View ref 直达 DOM div，VideoPlayer.web.js 同惯例），
// 浮层用它实时 getBoundingClientRect 锚定与滚动跟随。
// previewOut 带 key 校验：只有当前 target 自己的 leave 才生效——卡片间快速移动
// 时，旧卡迟到的 leave 不会误杀新卡。
// RN 适配点：无 SSR / 无水合概念（三端 App 均纯客户端渲染），getServerSnapshot
// 位照 NextWeb 保留稳定快照引用（无害且免得两端签名漂移）。native 端无消费者
// （AppShell 分流到 null stub），本模块即便被打进 native bundle 也只是死代码。
// ============================================================================
import { useSyncExternalStore } from 'react';

let state = { target: null };
const subs = new Set();

const emit = () => {
  for (const fn of subs) {
    try { fn(); } catch (_e) { /* 单个订阅异常不影响其它订阅 */ }
  }
};

// 卡片悬浮进入：target 存 { key, site, id, v, el }；同 key 重进也重发（新对象），
// 浮层 effect 依赖 target 身份重跑，以此取消上一轮 leave 排定的隐藏。
export function previewIn(entry) {
  if (!entry || entry.id == null || !entry.el) return;
  const key = entry.key || entry.site + ':' + entry.id;
  state = { target: { ...entry, key } };
  emit();
}

// 卡片悬浮离开：key 与当前 target 不符时忽略（防旧卡 leave 打断新卡）
export function previewOut(key) {
  if (!state.target || state.target.key !== key) return;
  state = { target: null };
  emit();
}

// 浮层/路由侧主动清空（路由切换、锚元素失联等兜底场景）
export function previewClear() {
  if (!state.target) return;
  state = { target: null };
  emit();
}

const subscribe = (fn) => {
  subs.add(fn);
  return () => subs.delete(fn);
};

export function useHoverPreviewStore() {
  return useSyncExternalStore(subscribe, () => state, () => state);
}
