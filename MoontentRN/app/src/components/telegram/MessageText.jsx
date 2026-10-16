// ============================================================================
// MessageText.jsx —— Telegram 消息富文本（entities → 嵌套 Text span）
// ----------------------------------------------------------------------------
// 数据契约（归一化消息对象）：text 原文（caption 也在 text 字段）+ entities:
// [{ type: MessageEntity 的 className（如 'MessageEntityBold'）, offset, length,
//    url?, userId? }]。offset/length 按 Telegram 口径是 UTF-16 码元——JS 字符串
// 本身就是 UTF-16 编码，String.slice 天然按码元切，不做任何转换（emoji 代理对
// 正确）。
// 实体支持清单：Bold / Italic / Underline / Strike / Code / Pre（块级，mono +
// 底色）/ Blockquote（块级，左侧竖线）/ Spoiler（点击揭示）/ Url（正文即链接）
// / TextUrl（实体带 url）/ Email（mailto:）/ Mention / MentionName / Hashtag /
// BotCommand；未知实体一律降级为纯文本（内容保留、样式丢弃）。
// 结构策略：
//   · 行内实体 → 嵌套 <Text> 样式叠加（DescriptionBox 的嵌套 span 先例）；
//   · Pre / Blockquote 是块级语义：顶层（未被其它实体包裹）渲染为独立 <View>
//     块，与相邻文本块自然上下排；嵌套在其它实体内部时降级行内样式（RN 的
//     Text 内不能塞 View）；
//   · 相邻行内片段合并进同一个外层 <Text>，保持自然换行流。
// 纯展示组件：不取数、不感知路由；链接默认 Linking.openURL（页面可传 onUrl
// 接管），Mention/Hashtag/BotCommand 只染色、回调由页面选配。
// ============================================================================
import { memo, useCallback, useMemo, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { usePalette } from '../ui/palette.js';
import { useHint } from './HintPill.jsx';
import { toneColors } from './chat-helpers.js';

const MAX_DEPTH = 6; // 实体嵌套深度上限（防病态数据递归爆栈，超出降级纯文本）

// className 归一：'MessageEntityBold' → 'Bold'；防御空值/怪值
function entityType(raw) {
  const t = String((raw && raw.type) || '').replace(/^MessageEntity/, '');
  return t || null;
}

// entities 防御式归一：钳到文本长度、滤掉空/越界项；offset 升序、同起点
// 长者优先（外层实体先消费，内层的进子池递归）
function normalizeEntities(text, entities) {
  if (!Array.isArray(entities) || entities.length === 0) return [];
  const max = text.length;
  const out = [];
  for (const raw of entities) {
    if (!raw || typeof raw !== 'object') continue;
    const type = entityType(raw);
    if (!type) continue;
    const off = Math.floor(Number(raw.offset) || 0);
    const len = Math.floor(Number(raw.length) || 0);
    if (len <= 0 || off >= max) continue;
    const end = Math.min(max, off + len);
    if (end <= off) continue;
    out.push({ key: 'e' + out.length, type, offset: off, end, url: raw.url, userId: raw.userId });
  }
  out.sort((a, b) => a.offset - b.offset || b.end - b.offset - (a.end - a.offset));
  return out;
}

function MessageText({
  text = '',
  entities,
  tone = 'in', // 'in' 入站气泡 | 'out' 出站气泡（底色见 chat-helpers.toneColors）
  interactive = true, // false=菜单/多选态：实体不挂 onPress（点按让给气泡层的选择切换）
  onUrl,       // (url, kind) 页面接管链接打开；缺省 Linking.openURL
  onMention,   // (nameOrId) @提及点击（不传则只染色不可点）
  onHashtag,   // (tag) #话题点击
  onBotCommand, // (cmd) /命令点击
  onHint,      // 轻提示转发（Linking 失败等；缺省组件内胶囊）
  style,       // 追加到外层文本的样式（fontSize 覆盖等）
}) {
  const p = usePalette();
  const tc = toneColors(p, tone);
  const { show, overlay } = useHint(onHint);
  const [revealed, setRevealed] = useState(() => new Set()); // 已揭示的 Spoiler（实体 key 集）

  const src = String(text == null ? '' : text);
  const ents = useMemo(() => normalizeEntities(src, entities), [src, entities]);

  // 链接打开：页面回调优先；email 补 mailto:，无协议的补 https://；失败轻提示
  const openLink = useCallback(
    (raw, kind) => {
      if (onUrl) { onUrl(raw, kind); return; }
      let u = String(raw || '').trim();
      if (!u) return;
      if (kind === 'email') u = 'mailto:' + u;
      else if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
      Linking.openURL(u).catch(() => show('无法打开链接'));
    },
    [onUrl, show]
  );

  const toggleSpoiler = useCallback((key) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // —— 区间渲染：返回原子数组 [{ block: boolean, node }] ——
  // pool 为当前层级可用实体（已排序）；消费过的区间由 cursor 前推跳过，
  // 落在实体内部的更小实体经 inner 池递归（嵌套样式叠加）。
  const walk = (from, to, pool, depth) => {
    const atoms = [];
    let cursor = from;
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i];
      if (e.offset < cursor) continue; // 已被先前实体覆盖（嵌套项在外层消费）
      if (e.offset >= to) break;
      if (e.end > to) continue; // 半截越界（防御）：按纯文本处理
      if (e.offset > cursor) atoms.push({ block: false, node: src.slice(cursor, e.offset) });
      atoms.push(renderEntity(e, pool, depth));
      cursor = e.end;
    }
    if (cursor < to) atoms.push({ block: false, node: src.slice(cursor, to) });
    return atoms;
  };

  // 单实体 → 原子。inline 走嵌套 Text；Pre/Blockquote 仅在顶层出块。
  const renderEntity = (e, pool, depth) => {
    // 子内容：深度超限整体降级纯文本；否则递归（子池 = 严格落在实体区间内的）
    let childAtoms;
    if (depth >= MAX_DEPTH) {
      childAtoms = [{ block: false, node: src.slice(e.offset, e.end) }];
    } else {
      const inner = pool.filter((x) => x !== e && x.offset >= e.offset && x.end <= e.end);
      childAtoms = walk(e.offset, e.end, inner, depth + 1);
    }
    const kids = childAtoms.map((a) => a.node); // 深度>0 时块级已降级，均为行内
    // wrapText：菜单/多选态（interactive=false）剥离 onPress 等交互 props——
    // 点按让给气泡层（选择切换/菜单），实体只保留染色样式
    const wrapText = (extraStyle, extraProps) => ({
      block: false,
      node: (
        <Text key={e.key} style={extraStyle} {...(interactive ? extraProps : undefined)}>
          {kids}
        </Text>
      ),
    });

    switch (e.type) {
      case 'Bold':
        return wrapText({ fontWeight: '700' });
      case 'Italic':
        return wrapText({ fontStyle: 'italic' });
      case 'Underline':
        return wrapText({ textDecorationLine: 'underline' });
      case 'Strike':
        return wrapText({ textDecorationLine: 'line-through' });
      case 'Code':
        return wrapText({ fontFamily: 'monospace', fontSize: 13, backgroundColor: tc.card, opacity: 0.95 });
      case 'Pre':
        // 顶层 = 块级代码块；嵌套时降级为行内等宽（Text 内不能塞 View）
        if (depth === 0) {
          return {
            block: true,
            node: (
              <View
                key={e.key}
                style={{ borderRadius: 8, backgroundColor: tc.card, paddingHorizontal: 8, paddingVertical: 6, marginVertical: 2 }}
              >
                <Text style={{ fontFamily: 'monospace', fontSize: 13, color: tc.fg }}>{kids}</Text>
              </View>
            ),
          };
        }
        return wrapText({ fontFamily: 'monospace', fontSize: 13 });
      case 'Blockquote':
        // 顶层 = 左竖线引用块；嵌套时降级为斜体（无竖线可画）
        if (depth === 0) {
          return {
            block: true,
            node: (
              <View key={e.key} style={{ flexDirection: 'row', gap: 8, marginVertical: 2, minHeight: 4 }}>
                <View style={{ width: 3, borderRadius: 2, backgroundColor: tc.bar }} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: tc.fg }}>{kids}</Text>
                </View>
              </View>
            ),
          };
        }
        return wrapText({ fontStyle: 'italic', opacity: 0.9 });
      case 'Spoiler': {
        const open = revealed.has(e.key);
        return wrapText(
          open ? { opacity: 0.85 } : { backgroundColor: tc.fg, color: 'transparent' },
          { onPress: () => toggleSpoiler(e.key), accessibilityLabel: open ? '收起剧透内容' : '点击查看剧透内容' }
        );
      }
      case 'Url':
        return wrapText(linkStyle(tc), {
          onPress: () => openLink(src.slice(e.offset, e.end), 'url'),
          accessibilityRole: 'link',
        });
      case 'TextUrl':
        return wrapText(linkStyle(tc), {
          onPress: () => openLink(e.url != null ? e.url : src.slice(e.offset, e.end), 'url'),
          accessibilityRole: 'link',
        });
      case 'Email':
        return wrapText(linkStyle(tc), {
          onPress: () => openLink(src.slice(e.offset, e.end), 'email'),
          accessibilityRole: 'link',
        });
      case 'Mention':
        return wrapText(linkStyle(tc), onMention
          ? { onPress: () => onMention(src.slice(e.offset, e.end)), accessibilityRole: 'link' }
          : undefined);
      case 'MentionName':
        // 带用户 id 的提及（textUrl 的 userId 形态）：回调给 id，缺省回退文本
        return wrapText(linkStyle(tc), onMention
          ? { onPress: () => onMention(e.userId != null ? e.userId : src.slice(e.offset, e.end)), accessibilityRole: 'link' }
          : undefined);
      case 'Hashtag':
        return wrapText(linkStyle(tc), onHashtag
          ? { onPress: () => onHashtag(src.slice(e.offset, e.end)), accessibilityRole: 'link' }
          : undefined);
      case 'BotCommand':
        return wrapText(linkStyle(tc), onBotCommand
          ? { onPress: () => onBotCommand(src.slice(e.offset, e.end)), accessibilityRole: 'link' }
          : undefined);
      default:
        // 未知实体：降级纯文本（内容原样、无样式），Telegram 侧新增实体类型
        // 不会导致丢字
        return wrapText(null);
    }
  };

  // 链接样式：出站气泡蓝底上蓝字不可见 → 反色 + 下划线示可点
  const linkStyle = (t) => (t.linkUnderline
    ? { color: t.link, textDecorationLine: 'underline' }
    : { color: t.link });

  // —— 顶层装配：相邻行内原子合并进同一 <Text>（自然换行流），块级原子独立 ——
  const baseStyle = [
    { color: tc.fg, fontSize: 15, lineHeight: 21, includeFontPadding: false },
    style,
  ];
  const nodes = [];
  if (ents.length === 0) {
    nodes.push(<Text key="t0" style={baseStyle}>{src}</Text>);
  } else {
    const atoms = walk(0, src.length, ents, 0);
    let buf = [];
    const flush = () => {
      if (buf.length === 0) return;
      nodes.push(<Text key={'t' + nodes.length} style={baseStyle}>{buf}</Text>);
      buf = [];
    };
    for (const a of atoms) {
      if (a.block) {
        flush();
        nodes.push(a.node);
      } else {
        buf.push(a.node);
      }
    }
    flush();
  }

  return (
    <View style={{ position: 'relative' }}>
      {nodes}
      {overlay}
    </View>
  );
}

export default memo(MessageText);
