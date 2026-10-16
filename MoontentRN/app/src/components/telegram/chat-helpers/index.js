// ============================================================================
// chat-helpers/index.js —— Telegram 聊天组件族共享纯工具（无 RN 依赖，双端安全）
// ----------------------------------------------------------------------------
// 消息组件族（components/telegram/）的日期/字节/发送者配色/气泡 tone 取色/
// 图片适配尺寸/头像哈希色/气泡底色板/Unsupported 胶囊几何等纯函数与常量统一
// 放这里；组件文件只管布局与交互。
// 归一化消息对象契约见服务端 chat.js（任务下发的共享契约），本文件不做
// 取数——纯展示组件，数据与动作全部由页面经 props 注入。
// 本文件是气泡域视觉的「唯一映射点」（蓝图一 §5.3）：气泡底色板 BUBBLE、
// 头像哈希色板 AVATAR_PALETTE 集中在此，组件内不得散落硬编码色值。
// ============================================================================

// ============================================================================
// 一、气泡底色板 BUBBLE（蓝图一 §5.3 唯一映射点，亮暗双主题）
// ----------------------------------------------------------------------------
// example theme.ts 的 bubbleOwn/bubbleOther → MoontentRN 落点：
//   亮：own #EFFDDE（Telegram 经典出站绿）、other=surface 令牌（经 tokens.js
//       取值，不散落第二份 #f9f9f9）；
//   暗：own #2B5278、other=#182533（Telegram 官方暗色气泡色，非语义令牌——
//       语义令牌九色不足以承载气泡底，按 BADGE_BG 先例落域级常量色板）。
// 交互蓝/品牌红仍走 usePalette 的 link/accent 令牌（蓝图一 §0.1-24：accent
// 是品牌红，勿当蓝用）；本板只管「气泡底」，不管文字/链接。
// ============================================================================
import { COLORS as THEME_TOKENS } from '../../../theme/tokens.js';

// 亮档 other 直接引用 tokens 的 surface 值（单一事实源；tokens.js 纯 JS 可安全 import）
const LIGHT_OTHER = THEME_TOKENS.light['--surface'] || '#f9f9f9';

export const BUBBLE = {
  light: { own: '#EFFDDE', other: LIGHT_OTHER },
  dark: { own: '#2B5278', other: '#182533' },
};

// 由色板推断亮暗档（无 scheme 入参时的兜底）：按 background 令牌的相对亮度
// 阈值判定。主题色板恒为 #rrggbb 形态（tokens.js 唯一事实源），亮 #ffffff
// 亮度 1、暗 #0f0f0f 亮度约 0.06，0.5 阈值两端都远离，判定稳定。
function hexLum(hex) {
  const s = String(hex || '').trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!m) return 1; // 解析失败按亮档（usePalette 兜底路径同为浅色）
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// scheme 显式传入优先（调用方已有 useThemeSafe().resolved 时）；否则由 p 推断
export function bubbleScheme(p, scheme) {
  if (scheme === 'light' || scheme === 'dark') return scheme;
  return hexLum(p && p.background) < 0.5 ? 'dark' : 'light';
}

// ============================================================================
// 二、气泡 tone 取色：入站（BUBBLE.other 底）/ 出站（BUBBLE.own 底）两套派生
// ----------------------------------------------------------------------------
// 出站底由旧实现的 link 令牌整块换成 BUBBLE.own（Telegram 气泡语言，蓝图一
// §5.3）：其上正文用 foreground 令牌（亮档深字压浅绿/暗档浅字压深蓝），
// 链接用 link 令牌（亮绿上 #065fd4、暗蓝上 #3ea6ff 均可读，无需再反色加
// 下划线）。card/track 是压在气泡底上的中性透明叠层（BADGE_BG 同类结构色），
// 码块/投票条/文件卡在两种气泡底上都有可用对比。
// scheme 参数可选：显式传入（resolved）优先，缺省由色板推断——不传的既有
// 调用方（InlineKeyboard 等）行为自动跟随主题，签名向后兼容。
// ============================================================================
export function toneColors(p, tone, scheme) {
  const sch = bubbleScheme(p, scheme);
  const dark = sch === 'dark';
  const bubble = BUBBLE[sch];
  if (tone === 'out') {
    return {
      out: true,
      fg: p.foreground,                 // 出站正文（气泡底上的常规前景字）
      bg: bubble.own,                   // 出站气泡底（Telegram 气泡色板）
      dim: p.muted,                     // 出站次级字（meta 行时间/署名等）
      dimOpacity: 1,
      bar: p.link,                      // 引用条竖线/分隔（交互蓝，双档可读）
      card: dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.07)',   // 气泡内卡片/码块底
      track: dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.14)',  // 进度条底轨
      link: p.link,                     // 出站气泡内链接（亮绿/暗蓝底上均可用）
      linkUnderline: false,
    };
  }
  return {
    out: false,
    fg: p.foreground,
    bg: bubble.other,                   // 入站气泡底
    dim: p.muted,
    dimOpacity: 1,
    bar: p.link,
    card: dark ? 'rgba(255,255,255,0.06)' : p.background, // 入站气泡上的卡片微对比
    track: p.line,
    link: p.link,
    linkUnderline: false,
  };
}

// ============================================================================
// 三、头像哈希色板（蓝图一 §5.2/§5.3：example theme.ts 原样移植）
// ----------------------------------------------------------------------------
// avatarColor(seed) 按 h*31 散列从 8 色板取色（同一 peer 恒定同色，亮暗通用
// ——占位底色属域级视觉）；initialsOf 取「首词+末词」双首字母（单词取首字
// 母），白字压哈希底。PeerBadge 的 TgAvatar 与气泡内头像共用。
// ============================================================================
export const AVATAR_PALETTE = [
  '#FF885E',
  '#FFCD6A',
  '#8EEE98',
  '#72D5FD',
  '#E0A2F3',
  '#FFA8A8',
  '#B794F4',
  '#62D4BB',
];

// seed（peerKey|id|任意稳定串）→ 稳定色；null/undefined → 色板首色（example 同款）
export function avatarColor(seed) {
  if (seed == null) return AVATAR_PALETTE[0];
  const s = String(seed);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

// 标题 → 双首字母（首词首字母 + 末词首字母，大写；空标题退 '?'）
export function initialsOf(title) {
  if (!title) return '?';
  const parts = String(title).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0].charAt(0) || '';
  const second = parts.length > 1 ? (parts[parts.length - 1].charAt(0) || '') : '';
  return (first + second).toUpperCase() || '?';
}

// —— 发送者名稳定配色（群聊入站发送者名按 from.id 派生）——
// 【口径说明】语义色令牌（theme/tokens.js 的九色）没有足够色相承载「按人
// 派生的多色名牌」，此处沿用 tokens.js 中 BADGE_BG / SCRIM_BG 的先例：与
// 主题档无关（但按亮/暗两套取值）的常量色板，双端/双主题实测对比度可用；
// 亮色档取深饱和（白气泡上可读）、暗色档取浅色（深气泡上可读）。
const SENDER_COLORS = {
  light: ['#9c27b0', '#1565c0', '#2e7d32', '#ef6c00', '#c2185b', '#00838f'],
  dark: ['#ce93d8', '#64b5f6', '#81c784', '#ffb74d', '#f48fb1', '#4dd0e1'],
};

// from.id → 稳定色（同一用户在同一主题下恒定同色；非数字串走逐字符散列）
export function senderColor(id, resolved = 'light') {
  const s = String(id == null ? '' : id);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const list = SENDER_COLORS[resolved] || SENDER_COLORS.light;
  return list[h % list.length];
}

// ISO 字符串/秒/毫秒时间戳防御式归一 → Date|null（口径同 telegram.js fmtRel）
export function toDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isFinite(v.getTime()) ? v : null;
  const n = Number(v);
  const d = new Date(typeof v === 'string' && !/^\d+$/.test(v) ? v : n > 1e12 ? n : n * 1000);
  return d && isFinite(d.getTime()) ? d : null;
}

// 两位补零
function pad2(n) {
  return ('0' + n).slice(-2);
}

// 消息时间戳 → HH:mm（24 小时制，气泡 meta 行用）
export function fmtChatTime(v) {
  const d = toDate(v);
  if (!d) return '';
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

// —— 日期分隔条标签：今天/昨天/周几/MM-DD/YYYY-MM-DD ——
// 与 telegram.js fmtRel 同一归一口径：跨年带年份，当年只出 MM-DD；六天内
// （昨天之外）出「周几」。周几中文映射（getDay 0=周日）。
const WEEK_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function fmtChatDate(v, now = Date.now()) {
  const d = toDate(v);
  if (!d) return '';
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const b = new Date(now);
  const today = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  const day = 86400e3;
  if (a === today) return '今天';
  if (a === today - day) return '昨天';
  if (a > today - 7 * day && a < today) return WEEK_LABEL[d.getDay()] || '';
  const md = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  return d.getFullYear() === b.getFullYear() ? md : d.getFullYear() + '-' + md;
}

// —— 字节数 → 人类可读（B/KB/MB/GB，一位小数，够用即止）——
export function fmtBytes(size) {
  const n = Number(size);
  if (!isFinite(n) || n < 0) return '';
  if (n < 1024) return n + ' B';
  const kb = n / 1024;
  if (kb < 1024) return (kb >= 100 ? Math.round(kb) : kb.toFixed(1).replace(/\.0$/, '')) + ' KB';
  const mb = kb / 1024;
  if (mb < 1024) return (mb >= 100 ? Math.round(mb) : mb.toFixed(1).replace(/\.0$/, '')) + ' MB';
  const gb = mb / 1024;
  return gb.toFixed(1).replace(/\.0$/, '') + ' GB';
}

// —— 图片按原始宽高适配气泡内展示尺寸（单图/贴纸共用）——
// 上限 maxW×maxH 等比缩放；缺宽高（或非法）退 maxW×fallbackH 占位；
// 被上限夹过的盒子与原图宽高比有出入，调用方一律 contentFit="cover"
// （等比命中原比例时 cover 与 contain 等价，无需分支）。
export function fitPhotoBox(w, h, maxW = 280, maxH = 340, fallbackH = 200) {
  const nw = Number(w);
  const nh = Number(h);
  if (!(nw > 0) || !(nh > 0)) return { width: maxW, height: fallbackH };
  let width = maxW;
  let height = Math.round((width * nh) / nw);
  if (height > maxH) {
    height = maxH;
    width = Math.round((height * nw) / nh);
    if (width > maxW) width = maxW; // 双超（近方形大图）夹回
  }
  // 小图不放大放肆：宽不足 120 的拉到 120（保持等比），避免缩略点不开
  if (width < 120) {
    width = 120;
    height = Math.min(maxH, Math.round((width * nh) / nw));
  }
  return { width, height };
}

// 相册网格单元边长（2 列、间隔 2，总宽上限 280：280 = cell*2 + 2）
export const ALBUM_CELL = 139;

// 单图/相册/圆形视频的气泡内最大宽度（任务口径：上限约 280）
export const BUBBLE_MEDIA_MAX_W = 280;

// ============================================================================
// 四、UnsupportedContentPill 几何（TI 逐字移植，非可调项）
// ----------------------------------------------------------------------------
// 出处：tmpTelegram/Telegram-iOS/submodules/TelegramUI/Components/
//   UnsupportedContentPill/Sources/UnsupportedContentPill.swift（本会话实读）。
// TI 注释明言「chat bubble 必须像素一致，these are not tunables」，故常量
// 一律逐字，不做本地化调整。RN 中 pt=dp，不换算。
// 与 TI 的唯一实现差异：TI 文本量宽走 TextNode.asyncLayout（UIKit 字体引擎），
// RN 无对应纯函数量测——measureUnsupportedPill 的文本/按钮尺寸改由调用方
// 注入（RN onLayout 实测值），几何公式（fixedWidth/高度/actionFrame）逐字
// 保留；UnsupportedPill.jsx 以同组常量走 flex 布局，两者同源不会漂移。
// ============================================================================
export const UNSUPPORTED_PILL = {
  // pillContentInsets = UIEdgeInsets(top: 6, left: 12, bottom: 8, right: 12)
  INSETS: { top: 6, left: 12, bottom: 8, right: 12 },
  // pillMaximumCornerRadius = 22（实际取 min(高/2, 22)）
  CORNER_RADIUS: 22,
  // pillBadgeDiameter = 44；徽章双模板资产（气泡剪影+纸飞机）同框 0 偏移
  BADGE: 44,
  // pillBadgeTextSpacing = 12（徽章→文本列）；pillTextButtonSpacing = 12（文本列→按钮）
  BADGE_TEXT_SPACING: 12,
  TITLE_SUBTITLE_SPACING: 0,
  TEXT_BUTTON_SPACING: 12,
  // 按钮：pillButtonHorizontalPadding = 11 / pillButtonVerticalPadding = 8，
  // 圆角 = 按钮高/2（胶囊）；底色 primary 黑或白、alpha 0.12（isDark 定极性）
  BUTTON_PADDING_H: 11,
  BUTTON_PADDING_V: 8,
  BUTTON_BG_ALPHA: 0.12,
  // pillSubtitleAlpha = 0.6；pillBadgeBackgroundAlpha = (dark 0.2, light 0.15)
  SUBTITLE_ALPHA: 0.6,
  BADGE_ALPHA: { dark: 0.2, light: 0.15 },
  // 字号：标题 semibold 15 / 副标题 regular 13 / 按钮 semibold 15
  TITLE_FONT_SIZE: 15,
  SUBTITLE_FONT_SIZE: 13,
  BUTTON_FONT_SIZE: 15,
};

// 纯几何量测（零 RN，双端安全；TI UnsupportedContentPill.layout 同构）。
// measured 为 RN 量测注入的文本/按钮尺寸：
//   { titleWidth, titleHeight, textWidth, textHeight, buttonWidth, buttonHeight }
// 返回 { width, height, fixedWidth, textColumnWidth, textColumnHeight, buttonFrame }。
// 固定宽公式（TI 逐字）：12 + 44 + 12 + 12 + 按钮宽 + 12；总宽 = 固定宽 +
// 文本列宽；总高 = 6 + max(44, 文本列高, 按钮高) + 8；按钮钉右缘垂直居中。
// 【双表述并行留痕】本纯函数是 TI 公式的可测表述；UnsupportedPill.jsx 实际
// 渲染走 flex 布局（间距/内边距同组常量，几何对齐 TI 已实读核对）。两边
// 描述同一几何——单边改动几何常量必须同步另一处，否则静默漂移无门可拦
// (2026-10-12 复核注明)。
export function measureUnsupportedPill(measured) {
  const C = UNSUPPORTED_PILL;
  const m = measured || {};
  const buttonWidth = Math.max(0, Number(m.buttonWidth) || 0);
  const buttonHeight = Math.max(0, Number(m.buttonHeight) || 0);
  const titleWidth = Math.max(0, Number(m.titleWidth) || 0);
  const titleHeight = Math.max(0, Number(m.titleHeight) || 0);
  const textWidth = Math.max(0, Number(m.textWidth) || 0);
  const textHeight = Math.max(0, Number(m.textHeight) || 0);
  const fixedWidth = C.INSETS.left + C.BADGE + C.BADGE_TEXT_SPACING + C.TEXT_BUTTON_SPACING + buttonWidth + C.INSETS.right;
  const textColumnWidth = Math.max(titleWidth, textWidth);
  const textColumnHeight = titleHeight + C.TITLE_SUBTITLE_SPACING + textHeight;
  const width = fixedWidth + textColumnWidth;
  const height = C.INSETS.top + Math.max(C.BADGE, Math.max(textColumnHeight, buttonHeight)) + C.INSETS.bottom;
  return {
    width,
    height,
    fixedWidth,
    textColumnWidth,
    textColumnHeight,
    // TI actionFrame(in:)：按钮钉右缘（x = 宽 - 右 inset - 按钮宽），垂直居中
    buttonFrame: {
      x: width - C.INSETS.right - buttonWidth,
      y: Math.floor((height - buttonHeight) / 2),
    },
  };
}
