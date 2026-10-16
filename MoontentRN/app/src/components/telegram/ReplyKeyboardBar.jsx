// ============================================================================
// ReplyKeyboardBar.jsx —— bot 回复键盘条（输入条上方的快捷回复按钮行）
// ----------------------------------------------------------------------------
// 数据契约（归一化消息对象的 replyKeyboard）：
//   { rows: [[{ text, request }]], placeholder }
//   rows 拍平后横向滚动成一行按钮（Telegram 的 bot 快捷回复形态）；request
//   字段（request_location/request_contact/request_poll 等特殊请求钮）样式
//   弱化但点击照常上报，由页面/服务端决定如何应答。
// 交互：点按钮 → onPick(text)（页面通常直接作为消息发送）；右侧收起/展开
//   钮切换整条显隐（收起后剩一个小展开钮，不占聊天空间）。
// 纯展示组件：placeholder 只是透传字段（建议页面把它接到 ChatComposer 的
// placeholder），组件自身不渲染它。
// ============================================================================
import { memo, useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { ChevronDown, Keyboard } from '../icons.js';
import { usePalette } from '../ui/palette.js';
import usePressVisual from '../../lib/use-press-visual.js';
import { FSM_DENSE } from '../../lib/text-fit.js';

// 快捷回复按钮：surface 底 + line 描边小胶囊
function ReplyKeyBtn({ btn, onPick }) {
  const p = usePalette();
  const hv = usePressVisual();
  const label = (btn && btn.text) || '';
  const special = !!(btn && btn.request); // 特殊请求钮（位置/联系人/投票）：弱化示意
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={'快捷回复 ' + label}
      disabled={!label}
      onPress={() => onPick(label)}
      {...hv.binds}
      style={[
        {
          height: 34,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: special ? p.line : p.link,
          backgroundColor: p.surface,
          paddingHorizontal: 12,
          alignItems: 'center',
          justifyContent: 'center',
        },
        { opacity: !label || hv.pressed ? 0.6 : 1 },
      ]}
    >
      <Text numberOfLines={1} maxFontSizeMultiplier={FSM_DENSE} style={{ fontSize: 13, fontWeight: '500', color: special ? p.muted : p.link, includeFontPadding: false }}>
        {label || '(空)'}
      </Text>
    </Pressable>
  );
}

function ReplyKeyboardBar({ keyboard, onPick, style }) {
  const p = usePalette();
  const hv = usePressVisual(); // 收起/展开钮视觉态
  const [collapsed, setCollapsed] = useState(false); // 收起态（组件内自持）

  // rows 拍平：多行回复键盘在本条里横向一列展示（空间紧凑，长列表横向滚）。
  // 拍平/回调一律在早退之前（空键盘 → 有键盘的钩子数量恒定，React 规则）
  const flat = useMemo(() => {
    const out = [];
    if (keyboard && Array.isArray(keyboard.rows)) {
      for (const row of keyboard.rows) {
        if (!Array.isArray(row)) continue;
        for (const btn of row) if (btn && btn.text) out.push(btn);
      }
    }
    return out;
  }, [keyboard]);

  const pick = useCallback((text) => {
    if (typeof onPick === 'function') onPick(text);
  }, [onPick]);

  if (flat.length === 0) return null;

  // 收起态：只留一个小展开钮（键盘图标），不占横向空间
  if (collapsed) {
    return (
      <View style={[{ alignItems: 'flex-start' }, style]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="展开快捷回复键盘"
          onPress={() => setCollapsed(false)}
          {...hv.binds}
          style={[
            {
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              height: 30,
              borderRadius: 8,
              backgroundColor: p.surface,
              borderWidth: 1,
              borderColor: p.line,
              paddingHorizontal: 10,
            },
            { opacity: hv.pressed ? 0.7 : 1 },
          ]}
        >
          <Keyboard size={14} color={p.muted} />
          <Text style={{ fontSize: 12, color: p.muted, includeFontPadding: false }}>快捷回复</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 8 }, style]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ flexDirection: 'row', gap: 8, paddingHorizontal: 2, paddingVertical: 2 }}
        style={{ flex: 1, minWidth: 0 }}
      >
        {flat.map((btn, i) => (
          <ReplyKeyBtn key={(btn.text || '') + '-' + i} btn={btn} onPick={pick} />
        ))}
      </ScrollView>
      {/* 收起钮：键盘图标 + 下箭头 */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="收起快捷回复键盘"
        onPress={() => setCollapsed(true)}
        {...hv.binds}
        style={[
          {
            width: 30,
            height: 30,
            borderRadius: 8,
            backgroundColor: p.surface,
            borderWidth: 1,
            borderColor: p.line,
            alignItems: 'center',
            justifyContent: 'center',
          },
          { opacity: hv.pressed ? 0.7 : 1 },
        ]}
      >
        <View style={{ alignItems: 'center', justifyContent: 'center' }}>
          <Keyboard size={13} color={p.muted} />
          <ChevronDown size={9} color={p.muted} />
        </View>
      </Pressable>
    </View>
  );
}

export default memo(ReplyKeyboardBar);
