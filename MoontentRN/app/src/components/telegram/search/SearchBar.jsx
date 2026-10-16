// ============================================================================
// SearchBar.jsx —— Telegram 搜索输入条(受控,无 token 系统)
// ----------------------------------------------------------------------------
// 页面蓝图 §5.3-A 契约:{ value, onChange, onSubmit, autoFocus?, onCancel? }。
// · Bar 本身纯受控:输入即时 onChange 上抛,防抖(250ms)由面板层做(列表页/
//   会话内搜索面板各自实现,Bar 不持有定时器);
// · 无 SearchBarToken 系统(蓝图 §3.6:全谱过滤器裁剪,query 文本+最近查询);
// · onCancel 传入时右侧出「取消」文字钮(example ChatsScreen 头部形态),
//   同时自带「清空」× 钮(有输入时);
// · 提交语义:回车触发 onSubmit 并收起键盘(列表页用做 dismiss,面板可忽略)。
// 取色一律语义 token(亮暗双主题);icons 走生成件,不引运行时图标库。
// ============================================================================
import React from 'react';
import { Keyboard, Pressable, Text, TextInput, View } from 'react-native';
import { Close, Search } from '../../icons.js';
import { usePalette } from '../../ui/palette.js';

export default function SearchBar({ value, onChange, onSubmit, autoFocus, onCancel }) {
  const p = usePalette();
  const hasText = typeof value === 'string' && value.length > 0;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View
        style={{
          flex: 1,
          minWidth: 0,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          borderWidth: 1,
          borderColor: p.line,
          borderRadius: 10,
          backgroundColor: p.surface,
          paddingHorizontal: 12,
          paddingVertical: 7,
        }}
      >
        <Search size={16} color={p.muted} />
        <TextInput
          accessibilityLabel="搜索"
          value={value}
          onChangeText={onChange}
          onSubmitEditing={() => {
            if (typeof onSubmit === 'function') onSubmit(value);
            Keyboard.dismiss();
          }}
          placeholder="搜索"
          placeholderTextColor={p.muted}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus={!!autoFocus}
          returnKeyType="search"
          style={{ flex: 1, minWidth: 0, fontSize: 15, color: p.foreground, paddingVertical: 0, includeFontPadding: false }}
        />
        {hasText ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="清空搜索词"
            hitSlop={8}
            onPress={() => onChange('')}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <Close size={14} color={p.muted} />
          </Pressable>
        ) : null}
      </View>
      {onCancel ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="取消搜索"
          hitSlop={6}
          onPress={onCancel}
          style={({ pressed }) => ({ paddingHorizontal: 4, opacity: pressed ? 0.7 : 1 })}
        >
          <Text style={{ fontSize: 14, fontWeight: '500', color: p.link, includeFontPadding: false }}>取消</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
