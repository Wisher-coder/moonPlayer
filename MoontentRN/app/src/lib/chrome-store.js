// ============================================================================
// chrome-store.js —— 壳层收放 store（手机画幅顶栏/底栏 hide-on-scroll）
// ----------------------------------------------------------------------------
// 语义：手机画幅下页面滚动方向驱动 AppShell 顶栏/底栏收放——向下滚收起
// （顶栏上滑出、底栏下滑出），向上回滚或回到顶部恢复。pad/PC 画幅不接入
// （AppShell 侧在画幅离开 phone 时硬复位）。YouTube App 同款交互。
// 结构仿 searchbar-store：模块级单例 + useSyncExternalStore 订阅、等值短路；
// 动画值（Animated.Value，0=显示 1=隐藏）跨树共享——tab 页滚动容器经
// use-chrome-scroll 判定方向后写入本 store，AppShell 消费动画值做 overlay
// 平移。**只做 transform 平移、绝不动布局属性**（高度/边距动画每帧全屏
// 重排，还会与 FlashList 的容器 resize 处理打架引发滚动回跳）；transform
// 在 native 走 native driver、web 只走合成器，两端零布局开销，滚动中收放
// 不掉帧。内容全出血滚到栏底下，页面滚动内容用 useChromeInsets 自垫安全
// 间距（见 use-chrome-scroll.js）。
// 复位语义：路由变化 / 画幅切换由 AppShell 调 resetChrome() 硬复位（无动画），
// 保证进入任何页面、任何画幅下壳层恒为显示态起步。
// ============================================================================
import { useSyncExternalStore } from 'react';
import { Animated, Easing, Platform } from 'react-native';

const DURATION = 220; // 收/放时长（方向翻转时一次性触发）
const NATIVE = Platform.OS !== 'web'; // transform 平移：native 可走原生驱动

// 动画值：AppShell 平移插值源（0=显示 1=隐藏）
export const chromeAnim = new Animated.Value(0);

let hidden = false;
const subs = new Set();

const emit = () => {
  for (const fn of subs) {
    try { fn(); } catch (_e) { /* 单个订阅异常不影响其它订阅 */ }
  }
};

const subscribe = (fn) => {
  subs.add(fn);
  return () => subs.delete(fn);
};

// 写入收/放意图（等值短路）；布尔态同步广播（AppShell 用于 hidden 时关掉
// overlay 命中——平移出视口的栏不可再点）
export function setChromeHidden(next) {
  const v = !!next;
  if (v === hidden) return;
  hidden = v;
  Animated.timing(chromeAnim, {
    toValue: v ? 1 : 0,
    duration: DURATION,
    easing: Easing.out(Easing.cubic),
    useNativeDriver: NATIVE,
  }).start();
  emit();
}

// 硬复位为显示（无动画）：路由变化 / 画幅离开 phone 时由 AppShell 调用
export function resetChrome() {
  if (!hidden) return;
  chromeAnim.stopAnimation();
  chromeAnim.setValue(0);
  hidden = false;
  emit();
}

// 布尔态订阅（AppShell 消费）
export function useChromeHidden() {
  return useSyncExternalStore(subscribe, () => hidden, () => hidden);
}
