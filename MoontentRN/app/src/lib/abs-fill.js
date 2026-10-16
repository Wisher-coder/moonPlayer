// ============================================================================
// abs-fill.js —— 「绝对定位四边归零」样式常量(三端单源)
// ----------------------------------------------------------------------------
// 背景：RN 0.86 已移除 StyleSheet.absoluteFillObject——沿用旧写法
// `...StyleSheet.absoluteFillObject` 在原生端展开的是 undefined，等于什么都没写：
// position/top/left/right/bottom 全部丢失，元素退回普通流(宽度仍是撑满，高度变成
// 内容高)。占用它的覆盖层因此塌成「顶部一条带」:解析占位卡不再盖住播放器框、
// 舞台内层(L2/L3)也不再铺满——视频视图随之拿不到满幅尺寸。
//
// 为什么不用两端自带的 constant：
//   · 原生 RN 0.86：StyleSheet.absoluteFill 是普通对象(可展开)——但 RNW 没有；
//   · react-native-web 0.21：StyleSheet.absoluteFill 是编译后的样式对象
//     ($$css 类名映射)，`{...}` 展开得到的是类名映射而非样式属性——会污染样式；
//     它那边的 StyleSheet.absoluteFillObject 才可展开，而原生端已没有。
// 故自持常量：原生/web 都是普通样式对象，`{...ABS_FILL}` 与直接当 style 用都成立。
// ============================================================================

export const ABS_FILL = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
};

export default ABS_FILL;
