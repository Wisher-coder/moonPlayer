// ============================================================================
// SettingRow.jsx —— 设置行（「我的」页辅助件，RN 三端移植）
// ----------------------------------------------------------------------------
// 源：NextWeb/src/components/mine/SettingRow.jsx（1:1 交互语义）。
// YouTube 设置形态——行首图标 + 标签（可选次行 desc 说明）+ 行尾控件槽 right。
// 可点行（传 onPress，或行尾无交互控件）根为 Pressable，按压灰面（web 另有
// hover 灰面）；行尾自带控件的行（如自动连播开关）根为普通 View，避免按钮
// 嵌套。规格对齐 NextWeb：h-12（48）、rounded-lg（8）、px-2（8）、gap-4（16）、
// 图标 20（size-5）、标签 14px、desc 12px 灰字单行截断。
// 另导出 TogglePill：YouTube 同款自绘开关 pill（56×32 全圆角；开 = foreground
// 底 + background 圆点，关 = line 底 + foreground 点），形态与 F1 Guide 侧栏的
// 开关一致——本组件只做视觉，点按交互由整行或行尾 Pressable 承担。
import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { usePalette } from '../ui/palette.js';
import { FSM_DENSE, FSM_META } from '../../lib/text-fit.js';
import usePressVisual from '../../lib/use-press-visual.js';

// YouTube 同款开关 pill：56×32（h-8 w-14）全圆角；纯视觉件（无内置点按）。
// mixed = 混合态（如插件管理页 CMS 父开关「部分子项已加载」）：胶囊取开档
// 底色、圆点换短横线，与开/关两档一眼可分。
export function TogglePill({ on, mixed }) {
  const p = usePalette();
  const active = on || mixed;
  return (
    <View
      style={{ pointerEvents: 'none',

        width: 56,
        height: 32,
        borderRadius: 16,
        paddingHorizontal: 4,
        justifyContent: 'center',
        backgroundColor: active ? p.foreground : p.line,
      }}
    >
      {mixed ? (
        <View
          style={{
            width: 16,
            height: 3,
            borderRadius: 1.5,
            alignSelf: 'center',
            backgroundColor: p.background,
          }}
        />
      ) : (
        <View
          style={{
            width: 24,
            height: 24,
            borderRadius: 12,
            alignSelf: on ? 'flex-end' : 'flex-start',
            backgroundColor: on ? p.background : p.foreground,
          }}
        />
      )}
    </View>
  );
}

// 设置行：icon（icons.js 桶图标组件）+ label + 可选 desc + 行尾 right 槽
function SettingRow({ icon: Icon, label, desc, right, onPress, style, ...rest }) {
  const p = usePalette();
  const interactive = !!onPress || !right; // 行尾带控件且自身无 onPress：非按钮行
  // 布局纯静态对象（native 陷阱：安卓端 Pressable 样式函数携带的布局属性不
  // 生效——flexDirection 丢失即整行塌竖排（「设置选项被换行」的根因）；视觉
  // 态经事件 state 驱动，见 lib/use-press-visual.js 头注）
  const rowBody = {
    minHeight: 48, // h-12：单标签行 48 高；带 desc 时随内容略增（对齐 NextWeb 形态）
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  };
  const hv = usePressVisual();
  const children = (
    <>
      {Icon ? <Icon size={20} color={p.muted} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} maxFontSizeMultiplier={FSM_DENSE} style={{ fontSize: 14, color: p.foreground, lineHeight: desc ? 20 : undefined, includeFontPadding: false }}>
          {label}
        </Text>
        {desc ? (
          <Text numberOfLines={1} maxFontSizeMultiplier={FSM_META} style={{ fontSize: 12, lineHeight: 16, color: p.muted, includeFontPadding: false }}>
            {desc}
          </Text>
        ) : null}
      </View>
      {right}
    </>
  );
  if (!interactive) {
    return (
      <View style={[rowBody, style]} {...rest}>
        {children}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={typeof label === 'string' ? label : undefined}
      onPress={onPress}
      {...hv.binds}
      style={[
        rowBody,
        { backgroundColor: hv.hovered ? p.surface2 : 'transparent' }, // web hover 灰面（native 恒 false）
        { opacity: hv.pressed ? 0.85 : 1 },
        style,
      ]}
      {...rest}
    >
      {children}
    </Pressable>
  );
}

export default memo(SettingRow);
