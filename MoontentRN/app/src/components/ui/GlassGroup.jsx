// ============================================================================
// GlassGroup.jsx —— 玻璃融合簇（GlassContainer 包装；GlassSurface 的姊妹件）
// ----------------------------------------------------------------------------
// HIG（WWDC25-219 / Applying Liquid Glass to custom views）：多个相邻玻璃
// 元素必须放进同一个 GlassEffectContainer——「glass cannot sample other
// glass」，容器外的相邻玻璃渲染不一致；spacing = 玻璃开始互相影响（形状
// 融合）的距离，元素靠近时轮廓像水滴一样融合。
//
// 双路径组件（与 GlassSurface 同款判定/同款降级语义）：
//   玻璃路径 → expo-glass-effect 的 GlassContainer（spacing 生效）；
//   降级路径 → 普通 View（spacing 无意义，布局间距由调用方 className/style
//              自理——降级端本就是原不透明视觉，不存在融合概念）。
// props：
//   spacing   融合距离（pt），默认 SPACING.tight；档位见 lib/higlass.js；
//   className / style / children   两端都应用的常规 View 语法。
// 注意：GlassContainer 自身不是玻璃，只影响内部 GlassView 间的相互反应；
// 组内元素仍是各自的 GlassSurface（glassStyle/dimming 等 per 元素照常）。
// ============================================================================
import React from 'react';
import { Platform, View } from 'react-native';
import { cssInterop } from 'nativewind';
import { isGlassSupported, useGlassEnabled } from '../../lib/glass.js';
import { SPACING } from '../../lib/higlass.js';

// 探测语义同 GlassSurface：iOS 且原生侧达标才 require 包本体（见 lib/glass.js 头注）
let GlassContainer = null;
if (Platform.OS === 'ios' && isGlassSupported()) {
  try {
    GlassContainer = require('expo-glass-effect').GlassContainer;
    cssInterop(GlassContainer, { className: 'style' });
  } catch {
    GlassContainer = null; // 理论不可达（探测已过）：兜底走降级路径
  }
}

export default function GlassGroup({
  spacing = SPACING.tight,
  className,
  style,
  children,
  ...rest
}) {
  const enabled = useGlassEnabled();
  if (enabled && GlassContainer) {
    return (
      <GlassContainer spacing={spacing} className={className} style={style} {...rest}>
        {children}
      </GlassContainer>
    );
  }
  return (
    <View className={className} style={style} {...rest}>
      {children}
    </View>
  );
}
