// ============================================================================
// ListFooter.jsx —— 无限列表底态（正在加载…/没有更多了/失败重试）
// ----------------------------------------------------------------------------
// NextWeb 各列表页网格之后的三分支底态的 RN 三端移植（文案逐字保留）：
//   err        → 紧凑错误条 + 重试按钮（加载更多失败，列表保留在原处）；
//   done       → 「没有更多了」居中小字；
//   loading    → 「正在加载…」居中小字 + 小号 Spinner。
// 用法（两种落位，由页面按各自列表组件的能力选择）：
//   · 搜索页自管 FlashList → 作 ListFooterComponent 渲染在列表流内（NextWeb 同位）；
//   · 首页/分类页走共享 VideoGrid（契约未透传 footer 槽）→ 作为列表下方的
//     常驻条渲染（pinned），状态语义完全一致。
// 无任何状态时渲染 null（不占位）。
// ============================================================================
import React, { memo } from 'react';
import { Text, View } from 'react-native';
import { usePalette } from '../ui/palette.js';
import Spinner from '../ui/Spinner.jsx';
import ErrorState from './ErrorState.jsx';

function ListFooter({ loading = false, error = '', done = false, onRetry }) {
  const p = usePalette();
  if (error) {
    return <ErrorState message={error} onRetry={onRetry} compact />;
  }
  if (done) {
    return (
      <Text style={{ paddingVertical: 24, textAlign: 'center', fontSize: 12, color: p.muted, opacity: 0.6 }}>
        没有更多了
      </Text>
    );
  }
  if (loading) {
    return (
      <View style={{ paddingVertical: 16, alignItems: 'center', justifyContent: 'center', gap: 6, flexDirection: 'row' }}>
        <Spinner size={14} />
        <Text style={{ fontSize: 12, color: p.muted, opacity: 0.6 }}>正在加载…</Text>
      </View>
    );
  }
  return null;
}

export default memo(ListFooter);
