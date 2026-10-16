// ============================================================================
// ErrorState.jsx —— 错误态（首屏失败 / 加载更多失败共用）
// ----------------------------------------------------------------------------
// NextWeb src/components/video/ErrorState.jsx 的 RN 三端移植：警示图标 +
// 错误文案 + 重试按钮（onRetry 缺省时只展示文案）。
// compact 档为本工程补充：列表底部的「加载更多失败」条用（图标与留白收窄，
// 与 NextWeb 页脚内联重试行的语义对应），首屏失败仍走默认大留白档。
// ============================================================================
import React, { memo } from 'react';
import { Text, View } from 'react-native';
import { Restart, Alert } from '../icons.js';
import { usePalette } from '../ui/palette.js';
import Button from '../ui/Button.jsx';

function ErrorState({ message, onRetry, compact = false }) {
  const p = usePalette();
  return (
    <View
      style={{
        paddingVertical: compact ? 12 : 64,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
      }}
    >
      <Alert size={compact ? 20 : 32} color="#f87171" opacity={0.8} />
      {message ? (
        <Text style={{ maxWidth: 448, fontSize: 14, color: p.muted, textAlign: 'center' }}>
          {message}
        </Text>
      ) : null}
      {onRetry ? (
        <Button
          variant="secondary"
          size="sm"
          onPress={onRetry}
          style={{ marginTop: compact ? 4 : 8 }}
        >
          <Restart size={14} color={p.foreground} />
          <Text style={{ color: p.foreground, fontSize: 12, fontWeight: '500', includeFontPadding: false }}>
            重试
          </Text>
        </Button>
      ) : null}
    </View>
  );
}

export default memo(ErrorState);
