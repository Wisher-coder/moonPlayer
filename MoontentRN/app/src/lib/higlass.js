// ============================================================================
// higlass.js —— HIG 液态玻璃设计令牌（iOS 26+ 玻璃路径专用；单一事实源）
// ----------------------------------------------------------------------------
// 依据 Apple Human Interface Guidelines「Materials / Liquid Glass」与
// WWDC25-219（Meet Liquid Glass）、WWDC25-356（Get to know the new design
// system）、官方「Applying Liquid Glass to custom views」沉淀的可执行口径。
// 本模块只放「纯常量 + 纯函数」，全部由 GlassSurface / GlassGroup / 壳层与
// 播放器的 glassOnlyStyle 消费——降级端（web/Android/旧 iOS/减弱透明度/
// 用户关开关）一概不引用，保证 fallback 视觉零波及。
//
// 关键条款出处（摘要）：
//   · 形状：默认 capsule；大表面用圆角矩形（官方示例 16pt）；嵌套同心
//     半径 = 父半径 − padding（ConcentricRectangle 三型：fixed / capsule /
//     concentric）；屏幕边缘附近 capsule + 让边（WWDC25-356）。
//   · Clear 变体叠亮色媒体内容时加 35% 黑色暗化层（官方示例
//     .background(.black.opacity(0.3))，HIG Materials「consider adding a
//     dark dimming layer of 35% opacity」）。
//   · GlassEffectContainer(spacing:)：相邻玻璃同容器，靠近时形状融合
//     （「glass cannot sample other glass」，容器外相邻玻璃渲染不一致）。
//   · 显隐走 materialize（glassEffectStyle {animate:true}）而非 opacity。
//   · 同屏玻璃数量要节制（HIG 性能红线）——分簇合并本身即减少独立玻璃面。
// ============================================================================

// ---- 暗化层（Clear 变体配套） -----------------------------------------------
// 播放器/图片查看器等叠在媒体富内容上的 Clear 玻璃统一暗化口径。
// HIG 明示 35%；实现上玻璃内部、前景内容之下的 absolute-fill 黑层。
export const DIMMING = 0.35;

// ---- 圆角阶梯（大表面用圆角矩形；控件默认胶囊） ------------------------------
// 官方大组件示例 16pt；阶梯按「容器越大圆角越大 + 同心递减」展开：
//   control  —— 玻璃控件排（顶右功能排/工具条）这类中等表面
//   popup    —— 弹层面板（菜单/倍速/设置，官方 popover 量级）
//   dialog   —— 居中对话框（HIG：sheet/alert 更圆的圆角）
//   drawer   —— 抽屉大表面外缘（右缘）
// 胶囊不进阶梯：半径恒 = 元素高的一半（RN 里 rounded-full 即是）。
export const RADIUS = {
  control: 20,
  popup: 18,
  dialog: 22,
  drawer: 26,
};

// 同心圆角：嵌套元素的圆角 = 父圆角 − 两者之间的内边距（下限 0）。
// HIG 用它避免「过紧(pinched)/外翻(flared)」的圆角观感。
export function concentric(parentRadius, padding) {
  return Math.max(0, parentRadius - padding);
}

// ---- GlassContainer 间距档位 --------------------------------------------------
// 容器 spacing = 玻璃元素开始互相影响（融合）的距离。spacing 大于布局容器的
// 元素间距时静止态就会融合（官方警告），因此两档都从紧：
//   tight   —— 同一功能簇（桌面控制条按钮组、手势 HUD 成对 pill）
//   cluster —— 同层相邻但语义独立的簇（顶右功能排）
export const SPACING = {
  tight: 8,
  cluster: 14,
};

// ---- Materialize 动效时长（秒） ----------------------------------------------
// glassEffectStyle {animate:true, animationDuration} 用；对齐系统弹层
// 出现节奏（UIKit UIView.animate 默认 0.35s 量级）。
export const MATERIALIZE_S = 0.35;

// ---- 浮动胶囊阴影（壳层 chrome / 大玻璃表面） --------------------------------
// GlassView 自带材质阴影；此阴影只用于玻璃端「让胶囊浮起」的补强，
// 降级端各自维持原有视觉，不共享本令牌。
export const FLOAT_SHADOW = '0px 6px 20px rgba(0,0,0,0.28)';
