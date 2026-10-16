// ============================================================================
// 标签页（YouTube 式 chip 组）—— ui 八原语之一
// ----------------------------------------------------------------------------
// 从 NextWeb src/components/ui/tabs.jsx 移植（Radix Tabs → RN Pressable 组）：
// surface-2 圆角底座（p-1、圆角 12），激活项反色胶囊（foreground 底 +
// background 字、圆角 999、左右 16 内边距、14px），未激活 muted 字。
// 契约 props：{ tabs, active, onChange }——
//   tabs: [{ key, label }]（纯字符串项防御式兼容，键 = 文案）；
//   active: 当前激活 key；onChange(key) 点击切换回调。
import { memo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { usePalette } from './palette.js';
import usePressVisual from '../../lib/use-press-visual.js';

// 条目归一化：容忍纯字符串项与缺 key 项（脏数据防御，脏条目跳过不渲染）
const norm = (t, i) =>
  typeof t === 'string'
    ? { key: t, label: t }
    : t && t.key != null
      ? { key: t.key, label: t.label != null ? String(t.label) : String(t.key) }
      : t && t.label != null
        ? { key: i, label: String(t.label) }
        : null;

function Tabs({ tabs = [], active, onChange, scrollable = false }) {
  const p = usePalette();
  const list = tabs.map(norm).filter(Boolean);
  if (!list.length) return null;

  // 单个 trigger：激活反色胶囊（YouTube tabs 的激活位）
  // 单个 trigger：激活反色胶囊（YouTube tabs 的激活位）。拆子组件挂视觉态
  // state，布局纯静态（安卓样式函数陷阱，见 use-press-visual 头注）
  const Trigger = ({ on, label, onChange }) => {
    const hv = usePressVisual();
    return (
      <Pressable
        accessibilityRole="tab"
        accessibilityState={{ selected: on }}
        onPress={onChange}
        {...hv.binds}
        style={[
          { borderRadius: 999, paddingHorizontal: 16, paddingVertical: 6 },
          {
            backgroundColor: on ? p.foreground : hv.hovered ? p.line : 'transparent',
            opacity: hv.pressed ? 0.85 : 1,
          },
        ]}
      >
        <Text
          numberOfLines={1}
          style={{
            color: on ? p.background : p.muted,
            fontSize: 14,
            fontWeight: '500',
            includeFontPadding: false,
          }}
        >
          {label}
        </Text>
      </Pressable>
    );
  };
  const trigger = (t) => {
    const on = t.key === active;
    return <Trigger key={String(t.key)} on={on} label={t.label} onChange={() => onChange && onChange(t.key)} />;
  };

  // 底座：surface-2、圆角 12、内边距 4（p-1）；条目多时可选横滚
  const deck = (children) => (
    <View
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        borderRadius: 12,
        padding: 4,
        backgroundColor: p.surface2,
      }}
    >
      {children}
    </View>
  );

  if (scrollable) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {deck(list.map(trigger))}
      </ScrollView>
    );
  }
  return deck(list.map(trigger));
}

export default memo(Tabs);
