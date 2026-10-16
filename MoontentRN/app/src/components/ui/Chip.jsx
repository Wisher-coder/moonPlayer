// ============================================================================
// 话题 chip —— ui 八原语之一
// ----------------------------------------------------------------------------
// 全站唯一 chip 规格（数值取自 YouTube ytChipShapeChip 计算样式实测，与
// NextWeb ChipsBar.jsx 导出的 CHIP_CLS 同语义）：
//   32px 高、8px 圆角（非胶囊！）、左右 12px 内边距、14px/500；
//   非激活走 surface-2 底（hover 提亮到 line，即 YouTube 浅色 #e5e5e5 档），
//   激活反色（foreground 底 + background 字，深浅主题各自取反）。
// 只用于「筛选/选择类」控件：首页分类与榜单、分类页 pill 云、搜索热词、
// 相册分类、scope 切换……新增 chip 一律走本组件或 CHIP_STYLE 常量，不要手写。
// 契约 props：{ active }；onPress/label/children… 只增不减。
// hover 态只对 web 生效：Pressable 回调参数 hovered（native 恒 false）。
import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { usePalette } from './palette.js';
import { FSM_DENSE } from '../../lib/text-fit.js';
import usePressVisual from '../../lib/use-press-visual.js';

// 统一 chip 样式常量（ChipsBar 等处以它为基准拼装，保证同一元素全站一个规格）
export const CHIP_STYLE = {
  height: 32,
  borderRadius: 8,
  paddingHorizontal: 12,
  fontSize: 14,
  fontWeight: '500',
};

function Chip({ active = false, onPress, label, children, style, ...rest }) {
  const p = usePalette();
  // 布局纯静态 + 视觉态事件 state（安卓样式函数陷阱，见 use-press-visual 头注）
  const hv = usePressVisual();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      {...hv.binds}
      style={[
        {
          height: CHIP_STYLE.height,
          borderRadius: CHIP_STYLE.borderRadius,
          paddingHorizontal: CHIP_STYLE.paddingHorizontal,
          justifyContent: 'center',
          alignItems: 'center',
        },
        {
          // 非激活 surface-2 / hover 提亮到 line；激活反色（fg 底 bg 字）
          backgroundColor: active
            ? p.foreground
            : hv.hovered
              ? p.line
              : p.surface2,
          opacity: hv.pressed ? 0.85 : 1,
        },
        style,
      ]}
      {...rest}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        {children /* 可选内联小图标等 */}
        {label != null ? (
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={FSM_DENSE}
            style={{
              color: active ? p.background : p.foreground,
              fontSize: CHIP_STYLE.fontSize,
              fontWeight: CHIP_STYLE.fontWeight,
              includeFontPadding: false,
            }}
          >
            {label}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export default memo(Chip);
