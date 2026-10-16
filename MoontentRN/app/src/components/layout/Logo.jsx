// ============================================================================
// Logo.jsx —— 品牌标记
// ----------------------------------------------------------------------------
// YouTube 构图：红底（#f00 固定值，不随语义色走）圆角矩形 + 白色圆角三角
// 播放键（三角用白填充 + 白粗描边 + strokeLinejoin:round 画出圆角，无需手算
// 圆弧）。用 react-native-svg 实现（三端同源渲染）。BrandWord 为文字商标：
// 月幕 + Moontent（英文后缀窄画幅隐藏）。
// ============================================================================
import React from 'react';
import { Text } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

// 播放键图标：视图盒 34×24（红块圆角 6 + 居中白色圆角三角）
// size 指定宽度，高度按 24/34 比例换算
export function Logo({ size = 24 }) {
  const w = size;
  const h = Math.round((size * 24) / 34);
  return (
    <Svg width={w} height={h} viewBox="0 0 34 24" fill="none">
      <Rect width="34" height="24" rx="6" fill="#ff0000" />
      <Path
        d="M13.2 7.6v8.8l7.8-4.4z"
        fill="#fff"
        stroke="#fff"
        strokeWidth={2.4}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

// 文字商标：月幕（语义色随主题）+ Moontent（小号 muted 后缀，窄画幅可隐藏）
export function BrandWord({ showEn = true }) {
  if (!showEn) {
    return <Text className="text-lg font-bold tracking-wide text-foreground">月幕</Text>;
  }
  return (
    <Text className="text-lg font-bold tracking-wide text-foreground">
      月幕{' '}
      <Text className="text-[10px] font-semibold uppercase tracking-[2px] text-muted">
        Moontent
      </Text>
    </Text>
  );
}
