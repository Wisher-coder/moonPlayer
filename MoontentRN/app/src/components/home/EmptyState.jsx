// ============================================================================
// EmptyState.jsx —— 空态占位（首页/分类/搜索三页共用）
// ----------------------------------------------------------------------------
// NextWeb src/components/video/EmptyState.jsx 的 RN 三端移植：图标 + 标题 +
// 说明 + 可选操作（引导按钮等），py-16 居中列布局。图标由调用方传
// 图标组件（icons.js 桶，如 Clapperboard/VideoFrame/SearchX/Category…），
// 缺省 Inbox；颜色走 muted 半档（text-muted/50 → 0.5 透明度）。
// ============================================================================
import React, { memo } from 'react';
import { Text, View } from 'react-native';
import { Inbox } from '../icons.js';
import { usePalette } from '../ui/palette.js';

function EmptyState({ icon: Icon = Inbox, title = '暂无内容', desc, action }) {
  const p = usePalette();
  return (
    <View
      style={{
        paddingVertical: 64, // py-16
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
      }}
    >
      <Icon size={40} color={p.muted} opacity={0.5} />
      <Text style={{ marginTop: 4, fontSize: 14, color: p.muted, textAlign: 'center' }}>{title}</Text>
      {desc ? (
        <Text style={{ fontSize: 12, color: p.muted, opacity: 0.7, textAlign: 'center' }}>{desc}</Text>
      ) : null}
      {action ? <View style={{ marginTop: 12 }}>{action}</View> : null}
    </View>
  );
}

export default memo(EmptyState);
