// ============================================================================
// ChatSearchHeader.jsx —— 会话内搜索·官方式头部(搜索条 + 结果导航条)
// ----------------------------------------------------------------------------
// Telegram 官方形态(聊天内搜索,非弹层):聊天页激活搜索态时,头部行整体替换
// 为本组件——搜索条嵌在聊天流顶部,结果间用 ↑/↓ 逐条跳转高亮,聊天流保持
// 原位。纯受控展示件:取数/分页/跳转状态机全部在聊天页(chat/[id].js),本
// 组件不持业务状态。
// 契约 props:
//   { value, onChange, onSubmit?, onCancel, onCalendar,
//     globalActive, onToggleGlobal,
//     showNav, onPrev, onNext, counter, loading, err, onRetry,
//     onInputFocusChange? }
//   · 搜索条:TextInput(激活即自动聚焦) + 清空 × 钮 + 日历图标钮(「按日期
//     跳转」入口,打开 CalendarPanel) + 「全局」图标切换钮(本会话/全局两态
//     互斥,激活态交互蓝) + 「取消」文字钮(退出搜索恢复原头部);
//   · 导航条(仅本会话态,全局态互斥隐藏):↑/↓ 圆钮逐条移动 + 「n/m」计数
//     (达累计加载上限时计数位如实标「已载 N」)+ 关闭钮;首查进行中计数位
//     转 spinner;无结果时出文案占位;
//   · 错误条:契约错误原文 + 显式重试(绝不自动重试,防风暴红线);
//   · 回车 = 跳下一条结果(官方语义;web 端聊天页 onSend 快捷键对搜索条聚焦
//     让位,见 chat/[id].js 门闩),onInputFocusChange 上抛聚焦态供其判定。
// 取色一律语义 token(亮暗双主题);图标走生成件 icons.js。
// ============================================================================
import React from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { Calendar, ChevronDown, ChevronUp, Close, Globe, Search } from '../../icons.js';
import { usePalette } from '../../ui/palette.js';

// 导航圆钮(↑/↓):32pt 圆形描边钮;无结果时置灰不可点(计数位同步出占位文案)
function NavButton({ label, disabled, onPress, children }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: disabled ? p.line : p.link,
        backgroundColor: p.surface,
        opacity: pressed ? 0.7 : (disabled ? 0.45 : 1),
      })}
    >
      {children}
    </Pressable>
  );
}

// 搜索条右侧图标钮(日历/全局):无底透明钮,按压透明度反馈
function IconAction({ label, active, onPress, children }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 34,
        height: 34,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 17,
        backgroundColor: active ? p.surface2 : 'transparent',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {children}
    </Pressable>
  );
}

export default function ChatSearchHeader({
  value,
  onChange,
  onSubmit,             // 回车(下一条结果;官方语义)
  onCancel,             // 取消/关闭:退出搜索恢复原头部
  onCalendar,           // 日历图标:打开消息日历面板(按日期跳转入口)
  globalActive,         // 全局态激活(本会话/全局互斥)
  onToggleGlobal,
  showNav,              // 导航条显隐(全局态隐藏——两态互斥)
  onPrev,
  onNext,
  counter,              // 「n/m」计数文案('' = 无结果/未开始,组件出占位)
  loading,              // 取数在途(计数位转 spinner)
  err,                  // 错误原文('' = 无;错误条原文呈现 + 显式重试)
  onRetry,
  onInputFocusChange,   // (focused:boolean) 搜索条聚焦态上抛(Enter 语义门闩)
}) {
  const p = usePalette();
  const hasText = typeof value === 'string' && value.length > 0;
  const navDisabled = !counter;
  return (
    <View style={{ gap: 6 }}>
      {/* 搜索条:输入框(+清空) + 日历 + 全局切换 + 取消 */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
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
            accessibilityLabel="搜索本会话消息"
            value={value}
            onChangeText={onChange}
            onFocus={() => { if (onInputFocusChange) onInputFocusChange(true); }}
            onBlur={() => { if (onInputFocusChange) onInputFocusChange(false); }}
            onSubmitEditing={() => { if (onSubmit) onSubmit(); }}
            placeholder="搜索本会话消息;#话题 可直达"
            placeholderTextColor={p.muted}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
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
        {/* 日历:按日期跳转入口(打开 CalendarPanel) */}
        <IconAction label="按日期跳转(打开消息日历)" onPress={onCalendar}>
          <Calendar size={17} color={p.foreground} />
        </IconAction>
        {/* 全局切换:本会话/全局互斥;激活态交互蓝 */}
        <IconAction
          label={globalActive ? '切回本会话搜索' : '切换全局搜索'}
          active={globalActive}
          onPress={onToggleGlobal}
        >
          <Globe size={17} color={globalActive ? p.link : p.foreground} />
        </IconAction>
        {/* 取消:退出搜索,恢复原头部 */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="取消搜索"
          hitSlop={6}
          onPress={onCancel}
          style={({ pressed }) => ({ paddingHorizontal: 4, opacity: pressed ? 0.7 : 1 })}
        >
          <Text style={{ fontSize: 14, fontWeight: '500', color: p.link, includeFontPadding: false }}>取消</Text>
        </Pressable>
      </View>

      {/* 导航条(仅本会话态):↑ ↓ 圆钮 + n/m 计数 + 关闭钮 */}
      {showNav ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 2 }}>
          <NavButton label="上一条结果" disabled={navDisabled} onPress={onPrev}>
            <ChevronUp size={17} color={navDisabled ? p.muted : p.link} />
          </NavButton>
          <NavButton label="下一条结果" disabled={navDisabled} onPress={onNext}>
            <ChevronDown size={17} color={navDisabled ? p.muted : p.link} />
          </NavButton>
          {loading && navDisabled ? (
            <ActivityIndicator size="small" color={p.link} />
          ) : (
            <Text
              numberOfLines={1}
              style={{ flex: 1, minWidth: 0, fontSize: 12, color: p.muted, fontVariant: ['tabular-nums'], includeFontPadding: false }}
            >
              {counter || '输入关键词搜索本会话消息'}
            </Text>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭搜索"
            hitSlop={6}
            onPress={onCancel}
            style={({ pressed }) => ({ width: 30, height: 30, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}
          >
            <Close size={16} color={p.muted} />
          </Pressable>
        </View>
      ) : null}

      {/* 错误条:契约错误原文 + 显式重试(绝不自动重试) */}
      {err ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 }}>
          <Text numberOfLines={2} style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 17, color: p.accent, includeFontPadding: false }}>
            {err}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="重试搜索"
            hitSlop={6}
            onPress={onRetry}
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
          >
            <Text style={{ fontSize: 12, fontWeight: '500', color: p.link, includeFontPadding: false }}>重试</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
