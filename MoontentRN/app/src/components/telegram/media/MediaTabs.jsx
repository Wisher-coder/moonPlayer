// ============================================================================
// MediaTabs.jsx —— 共享媒体面板分段控件(媒体/文件/链接/语音)
// ----------------------------------------------------------------------------
// Telegram-iOS 共享媒体页的分段 tabs 观感(TI MediaTabsComponent:分段底 +
// 激活段提亮):容器 surface2 圆角底 + 2 内衬,激活段 surface 底反白提亮,
// 段内图标 + 文案(激活 semibold)。纯受控展示件:
//   <MediaTabs tabs=[{key,label,icon}] active onChange(key) />
// 取色一律语义 token(亮暗双主题);图标由调用方从 icons.js 注入(本组件
// 不感知具体档位)。
// ============================================================================
import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { usePalette } from '../../ui/palette.js';
import usePressVisual from '../../../lib/use-press-visual.js';

function MediaTabSegment({ tab, active, onPress }) {
  const p = usePalette();
  const hv = usePressVisual();
  const Icon = tab && tab.icon;
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={tab ? tab.label : ''}
      accessibilityState={{ selected: active }}
      onPress={() => onPress && onPress(tab.key)}
      {...hv.binds}
      style={[
        {
          flex: 1,
          height: 32,
          borderRadius: 9,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 5,
          backgroundColor: active ? p.surface : 'transparent',
        },
        { opacity: hv.pressed ? 0.75 : 1 },
      ]}
    >
      {Icon ? <Icon size={14} color={active ? p.foreground : p.muted} /> : null}
      <Text
        numberOfLines={1}
        style={{
          fontSize: 13,
          fontWeight: active ? '600' : '400',
          color: active ? p.foreground : p.muted,
          includeFontPadding: false,
        }}
      >
        {tab ? tab.label : ''}
      </Text>
    </Pressable>
  );
}

function MediaTabs({ tabs = [], active, onChange }) {
  const p = usePalette();
  const list = (tabs || []).filter((t) => t && t.key != null);
  if (!list.length) return null;
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        backgroundColor: p.surface2,
        borderRadius: 11,
        padding: 2,
      }}
    >
      {list.map((t) => (
        <MediaTabSegment key={String(t.key)} tab={t} active={t.key === active} onPress={onChange} />
      ))}
    </View>
  );
}

export default memo(MediaTabs);
