// ============================================================================
// 徽标（中性小胶囊）—— ui 八原语之一
// ----------------------------------------------------------------------------
// 从 NextWeb src/components/ui/badge.jsx 移植：内容区的小徽章（如「剧集」
// 选集面板 tag、设置项说明位），不是缩略图角标（那是 corner-badge）。
// 规格：11px/500、胶囊圆角、内边距 2×0.5（≈ 8×2px）、surface-2 底 muted 字；
// 无品牌色，不抢内容。
// 契约 props：{ icon, text }——icon 为可选的图标组件（icons.js 桶）
// （12px 内联），text 为徽标文案；其余 props 只增不减。
import { memo } from 'react';
import { Text, View } from 'react-native';
import { usePalette } from './palette.js';

function Badge({ icon: Icon, text, style, textStyle }) {
  const p = usePalette();
  return (
    <View
      style={[
        { pointerEvents: 'none',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          alignSelf: 'flex-start', // 不抢占整行（行内徽章语义）
          borderRadius: 999,
          paddingHorizontal: 8,
          paddingVertical: 2,
          backgroundColor: p.surface2,
        },
        style,
      ]}
    >
      {Icon ? <Icon size={12} color={p.muted} /> : null}
      {text != null ? (
        <Text
          numberOfLines={1}
          style={[
            {
              color: p.muted,
              fontSize: 11,
              fontWeight: '500',
              includeFontPadding: false,
            },
            textStyle,
          ]}
        >
          {text}
        </Text>
      ) : null}
    </View>
  );
}

// memo：纯展示件，父级重渲染按 props 浅比较跳过
export default memo(Badge);
