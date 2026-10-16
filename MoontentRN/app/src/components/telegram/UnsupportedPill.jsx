// ============================================================================
// UnsupportedPill.jsx —— 「暂不支持的消息」胶囊（TI UnsupportedContentPill 等价）
// ----------------------------------------------------------------------------
// 触发：归一化消息 media.kind === 'unsupported'（及未知 kind 兜底），替换
// 旧版灰字占位卡。几何常量与公式从 Telegram-iOS
// UnsupportedContentPill/Sources/UnsupportedContentPill.swift 逐字移植
// （chat-helpers/UNUPPORTED_PILL + measureUnsupportedPill，本会话对 TI 源实读
// 核对；TI 注释明言像素一致、非可调项），RN 中 pt=dp 不换算。
// 与 TI 的实现差异（语义等价，几何逐字）：
//   · TI 徽章是两张 44×44 模板资产（气泡剪影+纸飞机）同框 0 偏移；RN 无该
//     资产，等价为 44 圆形凹陷底（黑透明叠层）+ Send 纸飞机图标居中——
//     「双资产同框」不变式在单图标实现下自然成立（无第二资产可错位）；
//   · TI 背景优先壁纸穿透（fill 仅无壁纸时用）；本应用无聊天壁纸，恒走
//     fill = surface2 令牌（日期分隔条同源），文字用 muted（服务消息灰）；
//   · TI 按钮动作 = 打开 App Store 更新；本应用无商店通道，等价为轻提示
//     「请更新应用以支持该消息类型」（onAction 可注入页面接管）。
// 布局走 flex（间距/内边距/徽章直径/最小高逐字），圆角经 onLayout 按
// TI 公式 min(高/2, 22) 取值；文本列可收缩换行，按钮钉右缘不收缩。
// 几何的纯函数表述在 chat-helpers/index.js measureUnsupportedPill（同一
// 组常量）；两处表述必须同步改动，详见该函数头注(2026-10-12 复核注明)。
// ============================================================================
import { memo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { usePalette } from '../ui/palette.js';
import usePressVisual from '../../lib/use-press-visual.js';
import { useThemeSafe } from '../../lib/theme-context.jsx';
import { Send } from '../icons.js';
import { useHint } from './HintPill.jsx';
import { UNSUPPORTED_PILL as PILL } from './chat-helpers/index.js';
import { FSM_DENSE, FSM_META } from '../../lib/text-fit.js';

// 中文文案（TI strings.Conversation_UnsupportedMedia_* 的本应用等价文案）
const TITLE = '暂不支持的消息';
const DEFAULT_TEXT = '该消息类型在当前版本无法展示';
const ACTION = '更新应用';
const ACTION_HINT = '请更新应用以支持该消息类型';

function UnsupportedPill({ note, onAction, onHint, style }) {
  const p = usePalette();
  const { resolved } = useThemeSafe(); // 徽章凹陷/按钮底色的明暗极性
  const dark = resolved === 'dark';
  const { show, overlay } = useHint(onHint);
  const [contentH, setContentH] = useState(0); // onLayout 实测高 → TI 圆角公式
  const hv = usePressVisual(); // 按钮视觉态（钩子须顶层：按钮按文案条件渲染）

  const title = TITLE;
  const text = note ? String(note) : DEFAULT_TEXT;

  // TI 圆角公式：min(size.height * 0.5, 22)；最小高 = 6 + 44 + 8 = 58，
  // 高/2 ≥ 29 > 22，正常内容下恒取 22（公式照写，不预 shortcuts）
  const radius = contentH > 0 ? Math.min(contentH * 0.5, PILL.CORNER_RADIUS) : PILL.CORNER_RADIUS;

  const press = () => {
    if (typeof onAction === 'function') { onAction(); return; }
    show(ACTION_HINT);
  };

  return (
    <View
      onLayout={(e) => {
        const h = Math.round(e.nativeEvent.layout.height);
        setContentH((prev) => (prev === h ? prev : h)); // 量测值幂等，避免循环重渲
      }}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: PILL.BADGE_TEXT_SPACING,
          paddingLeft: PILL.INSETS.left,
          paddingRight: PILL.INSETS.right,
          paddingTop: PILL.INSETS.top,
          paddingBottom: PILL.INSETS.bottom,
          minHeight: PILL.INSETS.top + PILL.BADGE + PILL.INSETS.bottom,
          borderRadius: radius,
          backgroundColor: p.surface2,
          alignSelf: 'flex-start',
          maxWidth: '100%',
        },
        style,
      ]}
    >
      {/* 徽章：44×44 凹陷底（黑透明叠层，暗档 alpha 0.2/亮档 0.15）+ 纸飞机图标。
          alpha 烘进 backgroundColor（容器 opacity 会连子图标一起变淡，TI 的
          alpha 只作用于资产本身） */}
      <View
        accessibilityLabel="暂不支持的消息类型"
        style={{
          width: PILL.BADGE,
          height: PILL.BADGE,
          borderRadius: PILL.BADGE / 2,
          backgroundColor: dark ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.15)',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Send size={20} color={p.muted} />
      </View>

      {/* 文本列：标题（semibold 15，单行）+ 副标题（regular 13，alpha 0.6，多行） */}
      <View style={{ flexShrink: 1, minWidth: 0, gap: PILL.TITLE_SUBTITLE_SPACING }}>
        <Text numberOfLines={1} maxFontSizeMultiplier={FSM_DENSE} style={{ fontSize: PILL.TITLE_FONT_SIZE, fontWeight: '600', color: p.muted, includeFontPadding: false }}>
          {title}
        </Text>
        <Text maxFontSizeMultiplier={FSM_META} style={{ fontSize: PILL.SUBTITLE_FONT_SIZE, lineHeight: Math.round(PILL.SUBTITLE_FONT_SIZE * 1.35), color: p.muted, opacity: PILL.SUBTITLE_ALPHA, includeFontPadding: false }}>
          {text}
        </Text>
      </View>

      {/* 动作按钮：钉右缘胶囊（底色 primary 黑/白 alpha 0.12 按明暗取极性）。
          TI：buttonNode.backgroundColor = 黑/白 alpha 0.12（isDark 定极性），
          圆角 = 按钮高/2；alpha 烘进背景色，按压态只提容器不透明度 */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={ACTION}
        onPress={press}
        {...hv.binds}
        style={[
          {
            flexShrink: 0,
            borderRadius: 999, // TI：按钮圆角 = 按钮高/2（胶囊）；定值 999 等价
            backgroundColor: dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)',
            opacity: hv.pressed ? 0.8 : 1,
            paddingHorizontal: PILL.BUTTON_PADDING_H,
            paddingVertical: PILL.BUTTON_PADDING_V,
          },
        ]}
      >
        <Text maxFontSizeMultiplier={FSM_DENSE} style={{ fontSize: PILL.BUTTON_FONT_SIZE, fontWeight: '600', color: p.muted, includeFontPadding: false }}>
          {ACTION}
        </Text>
      </Pressable>

      {/* 组件内轻提示（页面传 onHint 时 overlay 恒空） */}
      {overlay}
    </View>
  );
}

export default memo(UnsupportedPill);
