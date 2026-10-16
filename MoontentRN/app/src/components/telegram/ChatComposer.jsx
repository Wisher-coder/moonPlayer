// ============================================================================
// ChatComposer.jsx —— 聊天底部输入条（受控输入 + 发送钮 + 回复引用条）
// ----------------------------------------------------------------------------
// 受控组件：文本由页面持有（value/onChangeText），onSend(text) 只上报动作，
// 清空输入/乐观消息插入都由页面做（发送中 sending=true 时发送钮转 spinner
// 且防重入）。键盘避让由页面层 KeyboardAvoidingView 负责，本组件只管自身
// 布局。
// · 外观对齐官方 Telegram iOS：输入盒去描边、浅灰底（surface2 token）、
//   单行盒高 40 / 圆角 20 的胶囊；发送钮同径 40 圆钮（link 底不变）；
// · 单行垂直居中（三端一致）：固定 paddingVertical=(盒高-行高)/2=10——
//   单行 20+10+10=40 恰好居中，多行由内容自然撑高（上下各留 10），不做
//   动态切换（onContentSizeChange 判定切换会与 paddingTop 互相触发,实测
//   造成占位符上下闪烁的反馈振荡,2026-10-13 回归修复）；Android 另保留
//   textAlignVertical=top 习惯；
// · multiline TextInput 高度自适应（内容撑高，上限约 5 行 ≈ 122px 后内滚）；
//   字号 16px（iOS web 聚焦缩放根治口径，见 ui/Input 头注）；
// · 回复引用条：reply={name, snippet} 时输入盒顶部出灰底圆角内嵌条
//   （「回复 X + 摘要」+ 右侧取消钮 onCancelReply()）；
// · disabled：整体只读（canSend=false 的对话：只读频道/未登录窗口期）；
// · placeholder：缺省「发送消息」，bot 回复键盘的 placeholder 由页面透传。
// 纯展示组件：不持网络态、不感知路由。
// ============================================================================
import { memo, useCallback } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Close, Send } from '../icons.js';
import { usePalette } from '../ui/palette.js';
import usePressVisual from '../../lib/use-press-visual.js';
import Spinner from '../ui/Spinner.jsx';
import { FSM_META } from '../../lib/text-fit.js';

const INPUT_MIN_H = 40; // 输入盒单行高（Telegram iOS 口径 40-44，取与发送钮同径的 40）
const LINE_H = 20;      // 16px 字号行高（iOS web 聚焦缩放根治字号，见 ui/Input 头注）
const INPUT_MAX_H = 122; // 多行输入高度上限（≈5 行：5×20 行高 + 上下内边距）

function ChatComposer({
  value = '',
  onChangeText,          // (text) 受控文本变更（页面持有 state）
  onSend,                // (text) 发送动作（页面 POST /send 并做乐观插入/清空）
  sending = false,       // 发送请求在途（发送钮转 spinner + 防重入）
  disabled = false,      // 整体禁用（canSend=false：只读频道等）
  reply = null,          // { name, snippet } | null 回复引用态（页面维护）
  onCancelReply,         // () 取消回复
  placeholder = '发送消息',
  style,
}) {
  const p = usePalette();
  const sendHv = usePressVisual(); // 发送钮视觉态
  const cancelHv = usePressVisual(); // 取消回复钮视觉态

  const canSend = !disabled && !sending && !!value.trim();

  const submit = useCallback(() => {
    if (!canSend || typeof onSend !== 'function') return;
    onSend(value);
  }, [canSend, onSend, value]);

  const cancelReply = useCallback(() => {
    if (typeof onCancelReply === 'function') onCancelReply();
  }, [onCancelReply]);

  return (
    <View style={[{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }, style]}>
      {/* 输入盒：回复引用条 + 多行输入（灰底无描边胶囊，Telegram iOS 口径） */}
      <View
        style={{
          flex: 1,
          minWidth: 0,
          borderRadius: 20,
          backgroundColor: p.surface2,
          overflow: 'hidden',
        }}
      >
        {/* 回复引用条：灰底圆角内嵌（名字交互蓝 + 摘要一行 + 取消钮） */}
        {reply ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              marginHorizontal: 4,
              marginTop: 4,
              borderRadius: 12,
              backgroundColor: p.surface,
              paddingHorizontal: 10,
              paddingVertical: 6,
            }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} maxFontSizeMultiplier={FSM_META} style={{ fontSize: 12, fontWeight: '600', color: p.link, includeFontPadding: false }}>
                回复 {reply.name || '原消息'}
              </Text>
              {reply.snippet ? (
                <Text numberOfLines={1} maxFontSizeMultiplier={FSM_META} style={{ fontSize: 12, color: p.muted, includeFontPadding: false }}>
                  {reply.snippet}
                </Text>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="取消回复"
              hitSlop={6}
              onPress={cancelReply}
              {...cancelHv.binds}
              style={[
                { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
                { backgroundColor: cancelHv.hovered ? p.surface2 : 'transparent', opacity: cancelHv.pressed ? 0.7 : 1 },
              ]}
            >
              <Close size={13} color={p.muted} />
            </Pressable>
          </View>
        ) : null}
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={p.muted}
          editable={!disabled}
          multiline
          maxHeight={INPUT_MAX_H}
          textAlignVertical="top"
          accessibilityLabel={reply ? '回复消息输入框' : '消息输入框'}
          style={{
            paddingHorizontal: 12,
            // 单行垂直居中（三端一致）：固定上下内边距=(盒高-行高)/2——单行
            // 20+10+10=40 恰好居中,多行由内容自然撑高;不做动态切换(与
            // onContentSizeChange 互相触发会造成占位符闪烁,见文件头注)
            paddingVertical: (INPUT_MIN_H - LINE_H) / 2,
            minHeight: INPUT_MIN_H,
            fontSize: 16, // iOS web 聚焦缩放根治字号（ui/Input 头注同源）
            lineHeight: LINE_H,
            color: p.foreground,
            opacity: disabled ? 0.55 : 1,
            includeFontPadding: false,
          }}
        />
      </View>

      {/* 发送钮：交互蓝圆钮（出站气泡同色系），与输入盒同径 40；空值/禁用/
          在途不可点，在途转 spinner 防连点 */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={sending ? '发送中' : '发送消息'}
        disabled={!canSend}
        onPress={submit}
        {...sendHv.binds}
        style={[
          {
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: p.link,
            alignItems: 'center',
            justifyContent: 'center',
          },
          { opacity: !canSend ? 0.5 : sendHv.pressed ? 0.8 : 1 },
        ]}
      >
        {sending ? <Spinner size={16} color={p.background} /> : <Send size={18} color={p.background} />}
      </Pressable>
    </View>
  );
}

export default memo(ChatComposer);
