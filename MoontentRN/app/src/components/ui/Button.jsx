// ============================================================================
// 通用按钮（胶囊）—— ui 八原语之一
// ----------------------------------------------------------------------------
// 从 NextWeb src/components/ui/button.jsx 移植（cva 变体 → RN 函数式 style）。
// 尺寸档 = YouTube ytSpecButtonShapeNextHost 实测：文字钮 40 高、胶囊（圆角
// 半径 = 高度一半）、左右 16 内边距、14px/500。
// 变体（跨模块契约钉死三种）：
//   - default   反色胶囊：foreground 底 + background 字（浅色黑底白字、深色白底黑字）
//   - secondary 中性灰面：surface-2 底 + foreground 字，hover 提亮
//   - ghost     无底色文字钮：hover 才出灰面（YouTube 控制行按钮的常态）
// 【约定】胶囊是「按钮」形状；话题/筛选 chip 是 8px 圆角 32 高（见 ui/Chip），
// 两者不要混用。
// hover 态只对 web 生效：经 Pressable 回调参数 hovered 实现（react-native-web
// 支持鼠标 hover，native 上 hovered 恒为 false，即天然仅 web 生效）。
// 契约 props：{ variant: 'default'|'secondary'|'ghost' }；其余（size/onPress/
// disabled/style/children…）只增不减。children 为字符串时自动包 Text。
import { memo } from 'react';
import { Pressable, Text } from 'react-native';
import { usePalette } from './palette.js';
import { FSM_DENSE } from '../../lib/text-fit.js';
import usePressVisual from '../../lib/use-press-visual.js';

// 尺寸档：高 / 圆角 / 横向内边距 / 字号 —— 圆角取「高的一半」即胶囊
const SIZES = {
  default: { height: 40, radius: 20, paddingH: 16, fontSize: 14 },
  sm: { height: 32, radius: 16, paddingH: 12, fontSize: 12 },
  lg: { height: 44, radius: 22, paddingH: 24, fontSize: 16 },
  icon: { height: 40, radius: 20, paddingH: 0, fontSize: 14 }, // 纯图标方圆钮
};

function Button({
  variant = 'default',
  size = 'default',
  onPress,
  disabled = false,
  style,
  children,
  ...rest
}) {
  const p = usePalette();
  const s = SIZES[size] || SIZES.default;
  // 各变体的底色/字色 + hover（web）/按下态——按下统一 0.85 透明度（RN 侧触感）
  const surfaceFor = (hovered) => {
    if (variant === 'default') return { bg: p.foreground, fg: p.background, hoverBg: p.foreground };
    if (variant === 'secondary') return { bg: hovered ? p.line : p.surface2, fg: p.foreground, hoverBg: p.line };
    // ghost：常态透明底，hover 才出灰面（YouTube 文字钮的常态）
    return { bg: hovered ? p.surface2 : 'transparent', fg: p.foreground, hoverBg: p.surface2 };
  };
  // 形状/布局走纯静态对象（native 陷阱：安卓端 Pressable 样式函数返回的布局
  // 属性不生效——flexDirection 丢失即 row 塌竖排；视觉态一律事件 state 驱动，
  // 见 lib/use-press-visual.js 头注），底色/透明度经 hv 读 state 拼普通对象
  const shape = {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6, // 按钮内小图标与文字间距（≈ gap-1.5）
    height: s.height,
    minWidth: size === 'icon' ? s.height : undefined, // 图标钮保持方形
    borderRadius: s.radius,
    paddingHorizontal: s.paddingH,
  };
  const hv = usePressVisual();

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      {...hv.binds}
      style={[
        shape,
        { backgroundColor: surfaceFor(hv.hovered).bg },
        { opacity: disabled ? 0.5 : hv.pressed ? 0.85 : 1 },
        style,
      ]}
      {...rest}
    >
      {typeof children === 'string' || typeof children === 'number' ? (
        <Text
          maxFontSizeMultiplier={FSM_DENSE}
          style={{
            color: surfaceFor(false).fg,
            fontSize: s.fontSize,
            fontWeight: '500',
            includeFontPadding: false, // 安卓默认字体上下留白会把胶囊内的字顶歪
          }}
        >
          {children}
        </Text>
      ) : (
        children
      )}
    </Pressable>
  );
}

export default memo(Button);
