// ============================================================================
// NoticeBar.jsx —— 首页公告条（可关闭）
// ----------------------------------------------------------------------------
// NextWeb HomeTab 顶部公告条的 RN 三端移植：低调 surface 面（无描边、12 圆角）、
// 喇叭图标 16、正文 14px/muted 最多两行、行尾 X 关闭钮。公告由聚合首页接口
// （api home 的 notice 字段）带出，防御式提取逻辑在页面侧（pickNotice），
// 本组件只吃已提好的字符串——空串直接不渲染。
// ============================================================================
import React, { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Notice, Close } from '../icons.js';
import { usePalette } from '../ui/palette.js';
import usePressVisual from '../../lib/use-press-visual.js';

function NoticeBar({ text, onClose }) {
  const closeHv = usePressVisual(); // 布局静态化 + 视觉态事件 state（安卓样式函数陷阱）
  const p = usePalette();
  if (!text) return null;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        borderRadius: 12, // rounded-xl
        backgroundColor: p.surface,
        paddingHorizontal: 16,
        paddingVertical: 10,
      }}
    >
      <Notice size={16} color={p.muted} style={{ marginTop: 3 }} />
      <Text
        numberOfLines={2}
        style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 20, color: p.muted }}
      >
        {text}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="关闭公告"
        hitSlop={8}
        onPress={onClose}
        {...closeHv.binds}
        style={[
          { marginTop: 2, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
          { backgroundColor: closeHv.hovered ? p.surface2 : 'transparent' }, // hover 才出灰面（web only）
        ]}
      >
        <Close size={16} color={p.muted} />
      </Pressable>
    </View>
  );
}

export default memo(NoticeBar);
