// ============================================================================
// MessageBubble.jsx —— Telegram 聊天消息气泡（消息组件族渲染主件）
// ----------------------------------------------------------------------------
// 数据契约：归一化消息对象（服务端 chat.js 输出，见任务共享契约）：
//   { id, peerKey, kind: 'message'|'service', date, out, views, from, text,
//     entities, groupedId, forward:{name,date}|null, viaBot, signature,
//     replyTo:{msgId,name,snippet}|null, media, inlineKeyboard, replyKeyboard,
//     service:{text}|null }
// 本组件职责（纯展示，数据与动作全由页面注入）。分区对照 Telegram-iOS
// ChatMessageBubbleItemNode 的字段清单（蓝图二 §3.1 分区表），裁剪项均经
// 蓝图裁定（话题行/反应页脚/滑动回复/下载态机/九宫格位图等不移植）：
//   · 背景组：左右布局（out 自己靠右/入站靠左）+ 气泡底 BUBBLE 板
//     （chat-helpers 唯一映射点，亮 #EFFDDE/surface、暗 #2B5278/#182533）；
//     运行组 merge 角：页面行装配（tg-rows）给出 mergeTop/mergeBottom
//     （与视觉上/下方相邻气泡同组）→ 发送侧顶角收 4、发送侧底角恒 4
//     （组末为尾角、组中为收角，值相同——mergeBottom 与尾角常量重合，
//     保留入参以对齐行协议，视觉无额外效果）；不移植九宫格位图
//     （RN 圆角+浅阴影已够，example bubbleShadow 语言）。
//   · 作者头组：群聊入站组首条出发送者名（from.id 稳定色 senderColor）；
//     via @bot / 频道署名 signature 在 meta 行。头像走 PeerBadge 的
//     TgAvatar（哈希底+双首字母，组件族内复用）。
//   · 信息条组：转发头「转发自 X」；replyTo 引用条（竖线+名+摘要，
//     点击 onReplyTap(msgId) 跳原消息）。
//   · 主体：MessageText（实体切分）/ MessageMedia（图/视频/文件/贴纸/语音/
//     网页/投票/位置/联系人；unsupported → UnsupportedPill 胶囊）/
//     InlineKeyboard（气泡下全宽）。媒体 URL 均为页面 normalizeDeep 归一后
//     的代理地址（/api/img/telegram），视频直通 videoId，本组件不碰地址。
//   · 页脚组：meta 行（署名/viaBot/浏览量/状态/时间，右对齐小字）；
//     own 已读双勾 readState（'sending'|'sent'|'read'，页面从 msg.__status
//     与 peer.readOutboxMaxId>=msg.id 推导后传入，组件不感知数据源）。
//     sent/read 双态逐字对齐蓝图一 §5.2（✓ 灰 / ✓✓ 蓝）；pending 以小
//     spinner 承载蓝图字面的 ⏳（等价件，2026-10-12 复核留痕）。
//   · 状态组：pending spinner / failed 品牌红警示钮（onRetry 重发）；
//     多选态（selectionActive）行左侧出选择圆、点按/长按切换选中（M2 渲染
//     M4 状态）；搜索命中 highlight（受控：交互蓝 tint overlay + 进入一次短
//     闪烁，多选态忽略——两态互斥）。
//     swipe-to-reply 裁剪（蓝图裁定：长按菜单「回复」承载同动作）。
//   · 交互管线：长按 onLongPress(msg) 外抛（页面装配 M4 通用菜单）；未注入
//     时退组件内建菜单（回复/复制文本，向后兼容）；多选态长按/点按=切换
//     选中；气泡本体不挂 onPress（多选态除外）——点按让给嵌套 Text 的链接/
//     剧透行内交互；菜单态（多选）下嵌套实体禁抢触（MessageText interactive）。
//   · kind='service' 居中灰字（复用 ChatDividers.ServiceMessage）。
//   · 贴纸等「纯媒体无文字」消息走裸排（无气泡底），meta 右下黑底半透明
//     小胶囊；unsupported 胶囊自带底色，恒裸排且不叠时间角标（TI
//     hidesBackground 同语义，pill 即全部内容）。
// 相册：页面把相邻同 groupedId 的消息合成一条传入（album=全体媒体成员），
//   本组件透传 MessageMedia。
// 几何基准（example ChatScreen）：maxWidth 78%、圆角 14、发送侧收角 4、
//   内边距 12/8、浅阴影（iOS/web shadow；Android elevation 1）。
// ============================================================================
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Modal, Platform, Pressable, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Alert, Check, Copy, Reply as ReplyIcon } from '../icons.js';
import { usePalette, BADGE_BG } from '../ui/palette.js';
import { ABS_FILL } from '../../lib/abs-fill.js';
import usePressVisual from '../../lib/use-press-visual.js';
import { useThemeSafe } from '../../lib/theme-context.jsx';
import Spinner from '../ui/Spinner.jsx';
import { useHint } from './HintPill.jsx';
import { toneColors, senderColor, fmtChatTime } from './chat-helpers/index.js';
import TgAvatar from './PeerBadge.jsx';
import MessageText from './MessageText.jsx';
import MessageMedia from './MessageMedia.jsx';
import InlineKeyboard from './InlineKeyboard.jsx';
import { ServiceMessage } from './ChatDividers.jsx';
import { FSM_META } from '../../lib/text-fit.js';

// —— 气泡几何常量（example ChatScreen styles.bubble 逐字）——
const BUBBLE_RADIUS = 14;   // 基础圆角
const BUBBLE_TAIL = 4;      // 发送侧收角（组末尾角/组内收角同值）
const BUBBLE_MAX_W = '78%'; // 气泡最大宽（相对时间线宽）

// —— 长按菜单项：图标 + 文案行（hover 灰面 / 按压透明度，视觉态经钩子）——
function MenuItem({ icon: Icon, label, onPress }) {
  const p = usePalette();
  const hv = usePressVisual();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      {...hv.binds}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          height: 40,
          borderRadius: 8,
          paddingHorizontal: 10,
        },
        { backgroundColor: hv.hovered ? p.surface2 : 'transparent', opacity: hv.pressed ? 0.8 : 1 },
      ]}
    >
      <Icon size={16} color={p.foreground} />
      <Text style={{ fontSize: 14, color: p.foreground, includeFontPadding: false }}>{label}</Text>
    </Pressable>
  );
}

// —— 引用条：竖线 + 回复对象名 + 摘要，整条可点（onReplyTap(msgId)）——
function ReplyStrip({ replyTo, tc, onTap }) {
  const hv = usePressVisual();
  const r = replyTo || {};
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={'查看回复的原消息：' + (r.name || '')}
      disabled={!onTap}
      onPress={() => onTap && onTap(r.msgId)}
      {...hv.binds}
      style={[
        {
          position: 'relative',
          flexDirection: 'row',
          alignItems: 'stretch',
          gap: 8,
          marginBottom: 6,
          borderRadius: 6,
          overflow: 'hidden',
        },
        { opacity: hv.pressed ? 0.8 : 1 },
      ]}
    >
      <View style={{ width: 3, borderRadius: 2, backgroundColor: tc.bar }} />
      <View style={{ flex: 1, minWidth: 0, paddingVertical: 1 }}>
        <Text numberOfLines={1} maxFontSizeMultiplier={FSM_META} style={{ fontSize: 12, fontWeight: '600', color: tc.out ? tc.fg : tc.link, includeFontPadding: false }}>
          {r.name || '原消息'}
        </Text>
        <Text numberOfLines={1} maxFontSizeMultiplier={FSM_META} style={{ fontSize: 12, color: tc.dim, opacity: tc.dimOpacity, includeFontPadding: false }}>
          {r.snippet || '(无内容)'}
        </Text>
      </View>
    </Pressable>
  );
}

// —— 已读双勾（own 专用）：sent 单勾灰 / read 双勾交互蓝（蓝图一 §5.2：
//    ✓ 灰 11pt / ✓✓ 蓝 11/700；出站气泡底上灰用 muted、蓝用 link 令牌）——
function ReadTicks({ state, tc, p }) {
  if (state === 'read') {
    return (
      <Text maxFontSizeMultiplier={FSM_META} style={{ fontSize: 11, fontWeight: '700', color: p.link, includeFontPadding: false }}>
        ✓✓
      </Text>
    );
  }
  return (
    <Text maxFontSizeMultiplier={FSM_META} style={{ fontSize: 11, color: tc.dim, includeFontPadding: false }}>
      ✓
    </Text>
  );
}

// —— 多选选择圆（行左侧；M2 渲染 M4 的 selection 状态）——
function SelectionDot({ selected }) {
  const p = usePalette();
  return (
    <View
      pointerEvents="none"
      accessibilityLabel={selected ? '已选中' : '未选中'}
      style={{
        width: 24,
        height: 24,
        borderRadius: 12,
        borderWidth: 1.5,
        borderColor: selected ? p.link : p.line,
        backgroundColor: selected ? p.link : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {selected ? <Check size={14} color="#ffffff" /> : null}
    </View>
  );
}

// 浏览量：1.2万 / 9999 两档简写
function fmtViews(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v <= 0) return '';
  if (v >= 10000) return (Math.round(v / 1000) / 10) + '万';
  return String(v);
}

function MessageBubble({
  msg,
  album,                 // 相册全体 [{ kind, w, h, url, fullUrl | videoId, cover, ... }]（页面合成）
  showSender = false,    // 群聊入站组首条：出「发送者名」
  showAvatar,            // 入站头像显隐（缺省：入站显示；组内后续条由页面传 false）
  status,                // null | 'sending' | 'failed'（本地乐观发送态，页面维护）
  readState,             // null | 'sending' | 'sent' | 'read'（own 已读双勾，页面推导）
  mergeTop,              // 与视觉上方（更旧）相邻气泡同组 → 发送侧顶角收 4
  mergeBottom,           // 与视觉下方（更新）相邻气泡同组（发送侧底角恒 4，值重合）
  selectionActive,       // 多选态进行中（行左侧出选择圆，点按/长按切换选中）
  selected,              // 多选态选中与否
  highlight,             // 搜索命中当前结果（受控；多选态忽略——两态互斥）
  onToggleSelect,        // (msg) 多选态切换选中
  onLongPress,           // (msg) 长按外抛（页面装配 M4 通用菜单）；未注入退内建菜单
  onReplyTap,            // (msgId) 引用条点击
  onReply,               // (msg) 长按菜单「回复」
  onRetry,               // (msg) 发送失败点击重发
  onOpenVideo,           // (videoId) 视频卡点击（透传 MessageMedia）
  onVote,                // (optionsBase64[]) 投票（透传 PollCard）
  onCallback,            // ({data,password?,game?}) 内联键盘回调（透传 InlineKeyboard）
  onHint,                // 轻提示转发（复制成功等；缺省组件内胶囊）
  onUrl,                 // (url, kind) 链接点击接管（透传 MessageText/MessageMedia/InlineKeyboard）
  onMention,             // (nameOrId) @提及点击（透传 MessageText）
  onHashtag,             // (tag) #话题点击（透传 MessageText）
  onBotCommand,          // (cmd) /命令点击（透传 MessageText）
  viewerTitle = '',      // 全屏看图器标题（通常为对话名，透传 MessageMedia）
}) {
  const p = usePalette();
  const { resolved } = useThemeSafe(); // 发送者名稳定色需感知亮/暗档
  const hv = usePressVisual();         // 气泡整体按压视觉态
  const { show, overlay } = useHint(onHint);
  const [menuOpen, setMenuOpen] = useState(false); // 内建长按菜单（外抛未注入时的兜底）

  // —— 搜索高亮（受控 highlight，会话内搜索 ↑/↓ 逐条跳转时命中）：进入时
  //    一次短闪烁（交互蓝 overlay 0.32 → 常驻 tint 0.10，Animated 单值衰减），
  //    退出即撤；多选态忽略（两态互斥——选择圆/选中面优先）——
  const highlightOn = !!highlight && !selectionActive;
  const hlFlash = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!highlightOn) {
      hlFlash.stopAnimation();
      hlFlash.setValue(0);
      return undefined;
    }
    hlFlash.setValue(0.32);
    const anim = Animated.timing(hlFlash, {
      toValue: 0.1,
      duration: 700,
      useNativeDriver: Platform.OS !== 'web', // opacity 原生可驱动（web 走 JS 驱动）
    });
    anim.start();
    return () => { anim.stop(); };
  }, [highlightOn, hlFlash]);

  const hasText = !!(msg && msg.text && msg.text.length);
  // unsupported：整条降级占位（服务端 normalize 单条异常的保底形状，无正文），
  // 走 UnsupportedPill（在 MessageMedia 内分发）；恒裸排且不叠时间角标
  const unsupported = !!(msg && msg.media && msg.media.kind === 'unsupported');

  // 长按：多选态=切换选中 → 外抛 onLongPress(msg) → 内建菜单兜底。
  // 气泡不挂 onPress（多选态除外）：点按让给嵌套 Text 的链接/剧透行内
  // 交互（父级 Pressable 的 onPress 会与嵌套 Text 抢响应），失败重试由
  // meta 行/裸排胶囊的警示钮承载。回调一律挂在早退之前（msg 空对象 →
  // 有对象的钩子数量恒定，React 规则）
  const handleLong = useCallback(() => {
    if (selectionActive) {
      if (typeof onToggleSelect === 'function') onToggleSelect(msg);
      return;
    }
    if (typeof onLongPress === 'function') { onLongPress(msg); return; }
    if (onReply || hasText) setMenuOpen(true);
  }, [selectionActive, onToggleSelect, msg, onLongPress, onReply, hasText]);

  // 多选态点按=切换选中（TI selection 态 tapAction 等价）
  const handlePress = useCallback(() => {
    if (selectionActive && typeof onToggleSelect === 'function') onToggleSelect(msg);
  }, [selectionActive, onToggleSelect, msg]);

  // 复制文本：写剪贴板 + 轻提示（失败也如实提示，不静默）
  const copyText = useCallback(async () => {
    setMenuOpen(false);
    try {
      await Clipboard.setStringAsync(String((msg && msg.text) || ''));
      show('已复制');
    } catch (_e) {
      show('复制失败');
    }
  }, [msg, show]);
  const doReply = useCallback(() => {
    setMenuOpen(false);
    if (msg && typeof onReply === 'function') onReply(msg);
  }, [onReply, msg]);

  if (!msg || msg.id == null) return null;

  // 服务消息（入群/改题名等）：居中灰字，无气泡
  if (msg.kind === 'service' || msg.service) {
    return <ServiceMessage text={(msg.service && msg.service.text) || msg.text || ''} />;
  }

  const out = !!msg.out;
  const tone = out ? 'out' : 'in';
  const tc = toneColors(p, tone, resolved);
  const from = msg.from || null;
  const media = msg.media || null;
  // 裸排（无气泡底）：纯媒体消息（无正文/引用/转发头时）或 unsupported 胶囊
  // （pill 自带底色，TI hidesBackground 同语义）。贴纸恒裸排；其余媒体卡
  // 自带卡底（tc.card），meta 变右下黑底胶囊
  const bare = unsupported || (!!media && !hasText && !msg.replyTo && !msg.forward);

  const time = fmtChatTime(msg.date);
  const views = fmtViews(msg.views);

  // 状态/双勾优先级：failed（警示钮，可重试）> sending（spinner）> readState 勾
  const failed = status === 'failed';
  const sending = status === 'sending' || readState === 'sending';
  const tick = !failed && !sending && (readState === 'sent' || readState === 'read') ? readState : null;

  // meta 行（非裸排）：署名 / via bot / 浏览量 / 状态 / 双勾 / 时间，右对齐小字
  const metaRow = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, alignSelf: 'flex-end', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {msg.signature ? (
        <Text maxFontSizeMultiplier={FSM_META} style={{ fontSize: 11, color: tc.dim, includeFontPadding: false }}>
          {msg.signature}
        </Text>
      ) : null}
      {msg.viaBot ? (
        <Text maxFontSizeMultiplier={FSM_META} style={{ fontSize: 11, color: tc.dim, includeFontPadding: false }}>
          via @{msg.viaBot}
        </Text>
      ) : null}
      {views ? (
        <Text maxFontSizeMultiplier={FSM_META} style={{ fontSize: 11, color: tc.dim, fontVariant: ['tabular-nums'], includeFontPadding: false }}>
          {views} 次观看
        </Text>
      ) : null}
      {failed ? <FailedMark onPress={() => onRetry && onRetry(msg)} /> : null}
      {sending ? <SendingDot color={tc.dim} /> : null}
      {tick ? <ReadTicks state={tick} tc={tc} p={p} /> : null}
      {time ? (
        <Text maxFontSizeMultiplier={FSM_META} style={{ fontSize: 10, color: tc.dim, fontVariant: ['tabular-nums'], includeFontPadding: false }}>
          {time}
        </Text>
      ) : null}
    </View>
  );

  // 裸排 meta：右下黑底半透明胶囊（角标同款结构色），盖在媒体右下。
  // unsupported 胶囊自带完整信息面，不叠时间角标（pill 即全部内容）
  const metaPill = !unsupported && (time || status || tick) ? (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', right: 6, bottom: 6, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: BADGE_BG, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}
    >
      {status === 'sending' ? <SendingDot color="#ffffff" size={10} /> : null}
      {status === 'failed' ? <Alert size={11} color="#ffffff" /> : null}
      {tick ? (
        <Text style={{ color: '#ffffff', fontSize: 11, lineHeight: 16, fontWeight: '700', includeFontPadding: false }}>
          {tick === 'read' ? '✓✓' : '✓'}
        </Text>
      ) : null}
      {time ? (
        <Text style={{ color: '#ffffff', fontSize: 11, lineHeight: 16, fontVariant: ['tabular-nums'], includeFontPadding: false }}>{time}</Text>
      ) : null}
    </View>
  ) : null;

  // 气泡圆角：基础 14；发送侧（own 右 / 入站左）顶角按 mergeTop 收 4，
  // 底角恒 4（组末=尾角、组内=收角，值相同）；非发送侧恒 14
  // （position:'relative' 使搜索高亮 overlay 以气泡本体为定位框）
  const corners = out
    ? {
        borderTopRightRadius: mergeTop ? BUBBLE_TAIL : BUBBLE_RADIUS,
        borderBottomRightRadius: BUBBLE_TAIL,
      }
    : {
        borderTopLeftRadius: mergeTop ? BUBBLE_TAIL : BUBBLE_RADIUS,
        borderBottomLeftRadius: BUBBLE_TAIL,
      };
  const bubbleStyle = bare
    ? { position: 'relative', borderRadius: 12, padding: 0 }
    : {
        position: 'relative',
        borderRadius: BUBBLE_RADIUS,
        ...corners,
        backgroundColor: tc.bg,
        paddingHorizontal: 12,
        paddingVertical: 8,
        // 浅阴影（example bubbleShadow 语言；shadow* 为 iOS/web 通道，
        // Android 走 elevation 1，不叠加以免暗色 halo）
        shadowColor: '#000000',
        shadowOpacity: 0.08,
        shadowRadius: 1,
        shadowOffset: { width: 0, height: 1 },
        elevation: 1,
      };
  // 高亮 overlay 圆角与气泡同角（裸排媒体 12；常规气泡按发送侧收角）
  const highlightCorners = bare ? { borderRadius: 12 } : { borderRadius: BUBBLE_RADIUS, ...corners };

  // 头像：入站才出（out 无头像）；showAvatar 显式 false 可收（组内连续条）；
  // from 为 null（频道广播/匿名管理员等无发送者信息）也不出——频道消息本就
  // 无逐条头像，退占位圆反而误导；多选态隐藏头像（选择圆顶替，TI 同语义）
  const avatarVisible = !selectionActive && !out && showAvatar !== false && from != null;

  return (
    <View style={{ flexDirection: 'row', justifyContent: out ? 'flex-end' : 'flex-start', alignItems: 'flex-end', gap: 8, position: 'relative' }}>
      {/* 多选态：行左侧选择圆（M2 渲染 M4 selection 状态） */}
      {selectionActive ? <SelectionDot selected={!!selected} /> : null}
      {/* 气泡主体（多选点按切换/长按菜单/失败态点击重试；布局静态对象 + 视觉态拼接） */}
      {avatarVisible ? (
        <TgAvatar uri={from && from.avatar} name={from && from.name} seed={from && from.id} size={28} />
      ) : null}
      <View style={{ flexShrink: 1, maxWidth: BUBBLE_MAX_W, minWidth: 0 }}>
        {/* 群聊入站发送者名：from.id 派生稳定色（亮暗各一套色板） */}
        {showSender && !out && !selectionActive && from && from.name ? (
          <Text maxFontSizeMultiplier={FSM_META} style={{ marginLeft: 4, marginBottom: 2, fontSize: 12, fontWeight: '600', color: senderColor(from.id, resolved), includeFontPadding: false }}>
            {from.name}
            {from.isBot ? '（bot）' : ''}
          </Text>
        ) : null}
        <Pressable
          accessibilityLabel={
            selectionActive
              ? (selected ? '已选中，点按取消选择' : '未选中，点按选择') + '：' + (hasText ? String(msg.text).slice(0, 30) : (time || '消息'))
              : (out ? '我发送的消息' : (from && from.name ? from.name + ' 的消息' : '消息')) +
                (time ? '，' + time : '') + (hasText ? '，长按可回复或复制' : '')
          }
          onPress={selectionActive ? handlePress : undefined}
          onLongPress={handleLong}
          delayLongPress={250}
          {...hv.binds}
          style={[bubbleStyle, { opacity: hv.pressed ? 0.92 : 1 }]}
        >
          {/* 搜索命中高亮 overlay（盖全气泡、内容之下之上的着色层）：进入时
              交互蓝 0.32 短闪烁衰减到常驻 tint 0.10；pointerEvents none 不抢
              嵌套 Text 的链接/剧透点按；多选态由 highlightOn 门闩整体撤除 */}
          {highlightOn ? (
            <Animated.View
              pointerEvents="none"
              style={[ABS_FILL, highlightCorners, { backgroundColor: p.link, opacity: hlFlash }]}
            />
          ) : null}
          {/* 转发头：转发自 X（+ 原始日期若有） */}
          {msg.forward ? (
            <Text maxFontSizeMultiplier={FSM_META} style={{ marginBottom: 4, fontSize: 11, color: tc.dim, includeFontPadding: false }}>
              转发自 {msg.forward.name || '未知来源'}
            </Text>
          ) : null}
          {/* 引用条（多选态冻结点按：与 MessageText/MessageMedia 的
              interactive={!selectionActive} 同语义，点按让给选择切换） */}
          {msg.replyTo ? <ReplyStrip replyTo={msg.replyTo} tc={tc} onTap={selectionActive ? undefined : onReplyTap} /> : null}
          {/* 媒体（相册/图/视频/文件/贴纸/语音/网页/投票/位置/联系人/unsupported 胶囊） */}
          {media ? (
            <MessageMedia
              media={media}
              album={album}
              tone={tone}
              onOpenVideo={onOpenVideo}
              onVote={onVote}
              onHint={onHint}
              onUrl={onUrl}
              interactive={!selectionActive}
              viewerTitle={viewerTitle}
              style={bare ? null : { marginBottom: hasText ? 6 : 0 }}
            />
          ) : null}
          {/* 裸排 meta 胶囊盖在媒体右下（此时必无正文） */}
          {bare ? metaPill : null}
          {/* 正文/媒体说明（富文本实体）；多选态禁实体抢触（点按让给选择切换） */}
          {hasText ? (
            <MessageText
              text={msg.text}
              entities={msg.entities}
              tone={tone}
              interactive={!selectionActive}
              onUrl={onUrl}
              onMention={onMention}
              onHashtag={onHashtag}
              onBotCommand={onBotCommand}
              onHint={onHint}
            />
          ) : null}
          {/* meta 行（非裸排） */}
          {!bare ? metaRow : null}
        </Pressable>
        {/* 内联键盘：气泡下方全宽按钮行（callback 走 onCallback，页面 POST 后用新消息重渲；
            url 按钮与正文链接同走 onUrl 分流） */}
        {msg.inlineKeyboard && Array.isArray(msg.inlineKeyboard) && msg.inlineKeyboard.length ? (
          <InlineKeyboard
            rows={msg.inlineKeyboard}
            tone={tone}
            onCallback={selectionActive ? undefined : onCallback} // 多选态冻结：点按让给选择切换
            onUrl={onUrl}
            onHint={onHint}
            style={{ marginTop: 4 }}
          />
        ) : null}
      </View>

      {/* 组件内轻提示胶囊（页面传 onHint 时 overlay 恒空） */}
      {overlay}

      {/* 内建长按菜单（Modal 弹层：回复 / 复制文本）——仅页面未注入
          onLongPress 时的向后兼容兜底；页面装配 M4 通用菜单后不再走到这里 */}
      {menuOpen ? (
        <Modal transparent animationType="fade" statusBarTranslucent onRequestClose={() => setMenuOpen(false)}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭消息菜单"
            onPress={() => setMenuOpen(false)}
            style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          >
            <Pressable
              onStartShouldSetResponder={() => true} // 吃掉卡片上的触摸，不透传关闭
              style={{ width: '100%', maxWidth: 260, borderRadius: 12, backgroundColor: p.surface, padding: 8 }}
            >
              <MenuItem icon={ReplyIcon} label="回复" onPress={doReply} />
              {hasText ? <MenuItem icon={Copy} label="复制文本" onPress={copyText} /> : null}
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
    </View>
  );
}

// 发送中：小 spinner（meta 行/裸排胶囊内通用；color 由调用方给）
function SendingDot({ color, size = 11 }) {
  return <Spinner size={size} color={color} />;
}

// 发送失败：品牌红警示钮，点击重试（红=错误语义位）
function FailedMark({ onPress }) {
  const p = usePalette();
  const hv = usePressVisual();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="发送失败，点击重试"
      hitSlop={6}
      onPress={onPress}
      {...hv.binds}
      style={[{ width: 18, height: 18, alignItems: 'center', justifyContent: 'center' }, { opacity: hv.pressed ? 0.6 : 1 }]}
    >
      <Alert size={13} color={p.accent} />
    </Pressable>
  );
}

export default memo(MessageBubble);
