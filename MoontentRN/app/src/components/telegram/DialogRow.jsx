// ============================================================================
// DialogRow.jsx —— Telegram 对话行(Web K/TI 式,列表页与转发面板共用)
// ----------------------------------------------------------------------------
// 自 src/app/telegram.js 的行组件抽出(页面蓝图 §1.2 M3:抽件形态对齐 example
// ChatsScreen 行几何——52 头像/12 间距/hairline 缩进 78/未读 pill 22×22),
// 供对话列表页(telegram.js)与转发目标选择(ForwardPanel,M5)复用:
//   { item, onOpen, selected?, disabled?, onLongPress? }
//   · item         服务端 /dialogs 行契约:{id(peerKey),name,avatar,kind,
//                  unreadCount,unreadMentionsCount,muted,pinned,lastMessage,
//                  lastAt}(routes/telegram.js dialogs handler 归一口径);
//   · onOpen       行点按回调(列表页=跳聊天页;转发面板=勾选目标);
//   · selected     选择态高亮(转发目标多选);
//   · disabled     禁用态(不可选目标)置灰;
//   · onLongPress  行长按外抛(列表页=行上下文菜单;不传则无长按行为)。
// 行为红线(蓝图一 §8.1-3 不降级):preview 规则(出站「我: 」/群聊署名
// 「名字: 」前缀/媒体中文占位/相对时间兜底)、未读 99+ 截断、静音灰调、
// @ 提醒气泡、时间取最后消息时间优先——全部保留现状语义。
// 纯展示组件:不取数、不感知路由;数据与动作全部 props 注入。
// ============================================================================
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Pin } from '../icons.js';
import { usePalette } from '../ui/palette.js';
import usePressVisual from '../../lib/use-press-visual.js';
import TgAvatar, { KindBadge } from './PeerBadge.jsx';
import { MEDIA_FALLBACK } from './search/snippet.js';

// 最近活跃时间(秒/毫秒时间戳与 ISO 字符串防御式归一——dialogs 的 lastAt 与
// lastMessage.date 均为 ISO 字符串,Number() 对其是 NaN,需走 Date 解析支路):
// 刚刚/N分钟前/N小时前/昨天/MM-DD/YYYY-MM-DD(时间格式保留现有 fmtRel,行为
// 不降级——蓝图一 §5.2:example formatTime 不引入)
function fmtRel(v) {
  const n = Number(v);
  const t = isFinite(n) && n > 0
    ? new Date(n > 1e12 ? n : n * 1000).getTime()
    : typeof v === 'string' && v ? new Date(v).getTime() : NaN;
  if (!isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  if (diff < 172800e3) return '昨天';
  const d = new Date(t);
  const md = ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  return d.getFullYear() === new Date().getFullYear() ? md : d.getFullYear() + '-' + md;
}

// 最后消息预览行:preview 优先,空则按 mediaKind 出中文占位;前缀规则(Telegram
// 同款)——出站(out)打「我: 」(含我的收藏的转发),群聊带署名元数据(转发头/
// 频道署名,群普通发言者零网络拿不到名字、为空串不打)打「名字: 」;无
// lastMessage 或最终无文案(如 unsupported 且 preview 空)退回 lastAt 相对时间,
// 保持次行有内容可读(现状行为原样保留)
function previewLine(item) {
  const lm = item && item.lastMessage;
  if (!lm) return fmtRel(item && item.lastAt);
  let text = typeof lm.preview === 'string' ? lm.preview.trim() : '';
  if (!text && lm.mediaKind) text = MEDIA_FALLBACK[lm.mediaKind] || '';
  if (!text) return fmtRel(item && item.lastAt);
  if (lm.out) return '我: ' + text;
  if (item.kind === 'group' && lm.fromName) return lm.fromName + ': ' + text;
  return text;
}

// 行几何(example ChatsScreen 基准):水平留白 14 + 头像 52 + 主体间距 12
// ⟹ 分隔线缩进 78;未读 pill 22×22
const ROW_PAD_H = 14;
const AVATAR_SIZE = 52;
const ROW_GAP = 12;
const HAIRLINE_INDENT = ROW_PAD_H + AVATAR_SIZE + ROW_GAP;

export default function DialogRow({ item, onOpen, selected = false, disabled = false, onLongPress }) {
  const p = usePalette();
  const hv = usePressVisual();
  if (!item || item.id == null) return null;
  const lm = item.lastMessage || null;
  const rel = fmtRel(lm && lm.date ? lm.date : item.lastAt); // 时间优先最后消息时间
  const unread = Math.max(0, Math.floor(Number(item.unreadCount) || 0));
  const mentions = Math.max(0, Math.floor(Number(item.unreadMentionsCount) || 0));
  const pillBg = item.muted ? p.muted : p.link; // 静音灰调 / 常规高亮蓝
  const pinned = Boolean(item.pinned);
  return (
    <View style={{ maxWidth: 860, width: '100%', alignSelf: 'center' }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={'打开对话 ' + (item.name || '')}
        accessibilityState={{ selected, disabled }}
        onPress={() => { if (!disabled && typeof onOpen === 'function') onOpen(item); }}
        onLongPress={typeof onLongPress === 'function' ? () => onLongPress(item) : undefined}
        disabled={disabled}
        {...hv.binds}
        style={[
          {
            flexDirection: 'row',
            alignItems: 'center',
            gap: ROW_GAP,
            paddingVertical: 10,
            paddingHorizontal: ROW_PAD_H,
            borderRadius: 10,
          },
          selected ? { backgroundColor: p.surface2 } : null,
          { opacity: disabled ? 0.5 : hv.pressed ? 0.85 : 1 },
        ]}
      >
        {/* 头像:双通道传参——uri 为现行契约(即刻可用),seed/url 为组件族
            TgAvatar 升级契约(蓝图一 §5.2 哈希色+双首字母);升级落地前升级
            参数被现组件忽略,落地后 uri 退出使用,两形态均不报错 */}
        <TgAvatar uri={item.avatar} url={item.avatar} seed={item.id} name={item.name} size={AVATAR_SIZE} muted={item.muted} />
        <View style={{ flex: 1, minWidth: 0 }}>
          {/* 首行:名称(+kind 徽标) | 时间(置顶行加 Pin 角标) */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 16, fontWeight: '600', color: p.foreground }}>
              {item.name || '(未命名对话)'}
            </Text>
            <KindBadge kind={item.kind} />
            <View style={{ flex: 1 }} />
            {pinned ? <Pin size={12} color={p.muted} /> : null}
            {rel ? (
              <Text numberOfLines={1} style={{ fontSize: 12, color: p.muted, includeFontPadding: false }}>{rel}</Text>
            ) : null}
          </View>
          {/* 次行:最后消息预览 | @ 提醒 + 未读气泡(未读 >99 显示「99+」) */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 }}>
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: p.muted }}>
              {previewLine(item)}
            </Text>
            {mentions > 0 || unread > 0 ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                {mentions > 0 ? (
                  <View
                    style={{
                      borderRadius: 999,
                      backgroundColor: pillBg,
                      minWidth: 22,
                      height: 22,
                      paddingHorizontal: 6,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: '700', color: p.background, includeFontPadding: false }}>@</Text>
                  </View>
                ) : null}
                {unread > 0 ? (
                  <View
                    style={{
                      borderRadius: 999,
                      backgroundColor: pillBg,
                      minWidth: 22,
                      height: 22,
                      paddingHorizontal: 7,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: '700', color: p.background, includeFontPadding: false }}>
                      {unread > 99 ? '99+' : String(unread)}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        </View>
      </Pressable>
      {/* 行分隔线:hairline,按 TI/example 口径缩进到头像右缘(14+52+12=78) */}
      <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.line, marginLeft: HAIRLINE_INDENT }} />
    </View>
  );
}
