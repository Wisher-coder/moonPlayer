// ============================================================================
// ChatDividers.jsx —— 聊天流分隔条（日期 / 未读消息 / 服务消息）
// ----------------------------------------------------------------------------
// · DateDivider：日期分隔条——今天/昨天/周几（六天内）/MM-DD（当年）/
//   YYYY-MM-DD（跨年），时间戳归一与标签口径同 chat-helpers.fmtChatDate
//   （telegram.js fmtRel 的同源防御式归一）；
// · UnreadDivider：「未读消息」分隔条（新消息起点，列表锚点定位用）；
// · ServiceMessage：kind='service' 的系统消息（入群/置顶/改题名等），
//   居中灰字渲染（MessageBubble 对 service 消息直接走这里）。
// 纯展示组件：由页面在 FlatList/FlashList 数据里插占位行 + 渲染对应条。
// ============================================================================
import { Text, View } from 'react-native';
import { usePalette } from '../ui/palette.js';
import { fmtChatDate } from './chat-helpers.js';
import { FSM_META } from '../../lib/text-fit.js';

// 日期分隔条：居中胶囊（surface2 底 + muted 字）
function DateDivider({ date }) {
  const p = usePalette();
  const label = fmtChatDate(date);
  if (!label) return null;
  return (
    <View style={{ alignItems: 'center', marginVertical: 10 }}>
      <View style={{ borderRadius: 8, backgroundColor: p.surface2, paddingHorizontal: 10, paddingVertical: 3 }}>
        <Text maxFontSizeMultiplier={FSM_META} style={{ fontSize: 12, lineHeight: 17, color: p.muted, includeFontPadding: false }}>
          {label}
        </Text>
      </View>
    </View>
  );
}

// 未读消息分隔条：两侧细线 + 居中「未读消息」胶囊（强调色文案）
function UnreadDivider() {
  const p = usePalette();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 10, paddingHorizontal: 4 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: p.line }} />
      <View style={{ borderRadius: 8, backgroundColor: p.surface2, paddingHorizontal: 10, paddingVertical: 3 }}>
        <Text maxFontSizeMultiplier={FSM_META} style={{ fontSize: 12, lineHeight: 17, fontWeight: '500', color: p.accent, includeFontPadding: false }}>
          未读消息
        </Text>
      </View>
      <View style={{ flex: 1, height: 1, backgroundColor: p.line }} />
    </View>
  );
}

// 服务消息：居中灰字（kind='service'，service.text 直接渲染）
function ServiceMessage({ text }) {
  const p = usePalette();
  if (!text) return null;
  return (
    <View style={{ alignItems: 'center', marginVertical: 6, paddingHorizontal: 24 }}>
      <Text maxFontSizeMultiplier={FSM_META} style={{ fontSize: 12, lineHeight: 17, textAlign: 'center', color: p.muted, includeFontPadding: false }}>
        {text}
      </Text>
    </View>
  );
}

export { DateDivider, UnreadDivider, ServiceMessage };
