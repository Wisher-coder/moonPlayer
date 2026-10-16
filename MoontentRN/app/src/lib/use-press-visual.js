// ============================================================================
// use-press-visual.js —— Pressable 视觉态事件钩子（安卓样式函数陷阱的配套）
// ----------------------------------------------------------------------------
// 【根因记录（2026-10 真机实锤）】安卓原生端 Pressable 的 style 函数返回的
// 「布局属性」不生效（web/react-native-web 按普通 CSS 处理一切正常）：
//   - flexDirection 丢失 → row 容器塌成竖排（「设置选项被换行」「卡片错位」
//     的直接来源）；
//   - flex/宽度丢失 → 承重塌陷（987c4d0 记录的「样式函数里 flex:1 不生效」
//     是同一件事的局部表现，当时只修了 flex 没修 flexDirection）。
// 【全仓约定（终版）】Pressable 的 style 一律为「纯静态对象 / 对象数组」，
// 不允许出现任何 style 函数携带布局；hover（web-only 视觉态）与按压视觉态
// 一律经本钩子的setState 驱动——事件回调更新 state 后，style 仍是从普通
// 对象拼出的数组，两端都走正常布局管线，不再有函数路径。
// 用法：
//   const hv = usePressVisual();
//   <Pressable {...hv.binds} style={[布局对象, { backgroundColor: hv.hovered ? A : B, opacity: hv.pressed ? 0.85 : 1 }]}>
// 与组件已有的 onHoverIn/onPressIn 冲突时（如悬浮预览），不要展开 binds，
// 手动在各自回调里同时调 hv 的 setter（见 CompactCard 主链的写法）。
// ============================================================================
import { useCallback, useState } from 'react';

export default function usePressVisual() {
  const [hovered, setHovered] = useState(false); // web 鼠标悬停（native 无悬停事件，恒 false）
  const [pressed, setPressed] = useState(false); // 按压中（onPressIn/Out，两端都触发）
  const binds = {
    onHoverIn: useCallback(() => setHovered(true), []),
    onHoverOut: useCallback(() => setHovered(false), []),
    onPressIn: useCallback(() => setPressed(true), []),
    onPressOut: useCallback(() => setPressed(false), []),
  };
  return { hovered, pressed, binds };
}
