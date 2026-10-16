// ============================================================================
// searchbar-store.js —— 顶栏搜索胶囊 ↔ 搜索页 轻量联动 store
// ----------------------------------------------------------------------------
// 语义同 NextWeb/src/lib/searchbar-store.js：搜索结果页把当前关键词推给顶栏
// 搜索胶囊预填（YouTube 行为：结果页搜索框里就是当前关键词），离开搜索页清空。
// RN 侧顶栏搜索胶囊是「点击进搜索页」的入口（输入在搜索页内进行），本 store
// 让胶囊文字随搜索页关键词联动；模块级状态 + useSyncExternalStore 订阅，
// 零依赖、等值短路避免无谓重渲染。
// ============================================================================
import { useSyncExternalStore } from 'react';

const EMPTY = { pageKw: '' };
let state = EMPTY;
const subs = new Set();

const emit = () => {
  for (const fn of subs) {
    try { fn(); } catch (_e) { /* 单个订阅异常不影响其它订阅 */ }
  }
};

// 搜索页写入当前关键词（'' 表示离开/无关键词）
export function setPageKw(kw) {
  const v = String(kw || '');
  if (state.pageKw === v) return; // 等值短路
  state = { pageKw: v };
  emit();
}

const subscribe = (fn) => {
  subs.add(fn);
  return () => subs.delete(fn);
};

export function useSearchBar() {
  return useSyncExternalStore(subscribe, () => state, () => state);
}
