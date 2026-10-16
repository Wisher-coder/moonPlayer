// ============================================================================
// MediaListRow.jsx —— 共享媒体面板·文件/链接/语音 tab 列表行(TI 同款行形态)
// ----------------------------------------------------------------------------
// 单行纯展示件,kind 三档分流(数据契约 = 归一化消息的 media 子对象):
//   document { name, size, mime, thumb }   → 文件行:缩略图/文件图标 + 文件名
//     + 大小(mime)+ 日期;
//   url      { url, title, siteName, … }   → 链接行:Globe 图标 + 标题
//     (title→siteName→文本摘要三级回退)+ url + 日期;
//   voice    { duration, size, mime }      → 语音行:Mic 图标 + 「语音消息」
//     + 时长 + 日期。
// 日期为本地时区(当年 MM-DD,跨年 YYYY-MM-DD);点击整行上抛
// onPress(msgId)——由装配方跳聊天页对应消息(带 anchor),本组件不感知路由。
// ============================================================================
import { memo, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { usePalette } from '../../ui/palette.js';
import usePressVisual from '../../../lib/use-press-visual.js';
import { toDate, fmtBytes } from '../chat-helpers.js';
import { fmtDur } from '../../../lib/utils.js';
import { File, Globe, Mic } from '../../icons.js';

// 本地时区日期文案:当年 MM-DD,跨年 YYYY-MM-DD(列表行的绝对日期口径)
function fmtRowDate(v) {
  const d = toDate(v);
  if (!d) return '';
  const md = ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  return d.getFullYear() === new Date().getFullYear() ? md : d.getFullYear() + '-' + md;
}

function MediaListRow({ msg, kind, onPress }) {
  const p = usePalette();
  const hv = usePressVisual();
  const [bad, setBad] = useState(false);
  const media = (msg && msg.media) || {};

  // 三档标题/副题/图标/缩略图装配
  let title = '';
  let meta = '';
  let Icon = File;
  let thumb = '';
  if (kind === 'document') {
    const d = media.document || {};
    title = d.name || '未命名文件';
    meta = [fmtBytes(d.size), d.mime].filter(Boolean).join(' · ');
    Icon = File;
    thumb = d.thumb || '';
  } else if (kind === 'url') {
    const g = media.webpage || {};
    // 标题三级回退:webpage.title → siteName → 文本摘要(再无则落 URL 本身)
    title = g.title || g.siteName
      || String((msg && msg.text) || '').trim().slice(0, 80)
      || g.url || '链接';
    meta = g.url || g.siteName || '';
    Icon = Globe;
  } else if (kind === 'voice') {
    const v = media.voice || {};
    title = '语音消息';
    meta = [fmtDur(v.duration), fmtBytes(v.size)].filter(Boolean).join(' · ');
    Icon = Mic;
  } else {
    title = String((msg && msg.text) || '').trim() || '消息';
    meta = '';
  }
  const dateText = fmtRowDate(msg && msg.date);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={'在聊天中查看:' + title}
      onPress={() => onPress && onPress(msg && msg.id)}
      {...hv.binds}
      style={[
        { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
        { opacity: hv.pressed ? 0.8 : 1 },
      ]}
    >
      {/* 左槽:文档缩略图(有则)/类型图标,44 圆角方 */}
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 10,
          backgroundColor: p.surface2,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {thumb && !bad ? (
          <Image
            source={{ uri: thumb }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            transition={200}
            recyclingKey={String(thumb)}
            onError={() => setBad(true)}
          />
        ) : (
          <Icon size={20} color={p.muted} />
        )}
      </View>
      {/* 中槽:标题 + 副题 */}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: '500', color: p.foreground, includeFontPadding: false }}>
          {title}
        </Text>
        {meta ? (
          <Text
            numberOfLines={1}
            style={{ marginTop: 2, fontSize: 12, color: kind === 'url' ? p.link : p.muted, includeFontPadding: false }}
          >
            {meta}
          </Text>
        ) : null}
      </View>
      {/* 右槽:日期 */}
      {dateText ? (
        <Text style={{ fontSize: 11, color: p.muted, includeFontPadding: false }}>{dateText}</Text>
      ) : null}
    </Pressable>
  );
}

export default memo(MediaListRow);
