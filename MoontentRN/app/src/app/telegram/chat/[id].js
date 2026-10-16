// ============================================================================
// telegram/chat/[id].js —— Telegram 聊天页(/telegram/chat/<id>,id = 对话键
// peerKey:c<频道/超群id> | g<普通群id> | u<用户id> | saved 我的收藏)
// ----------------------------------------------------------------------------
// 对话的默认入口(对话列表行点击直达本页);共享媒体面板
// /telegram/media/[id] 从本页头部「头像+标题区」点按进入(带 name/avatar/
// kind 参数;其行点击/日历跳转带 anchor 回本页定位对应消息)。
// 路由参数:id 必填;name / avatar / kind 可选(列表页跳转带来,冷深链缺参时
// 由 GET /messages 首屏 around 响应的 peer 字段补齐头部);anchor 可选(>0 时
// 深链定位到指定消息,透传给 hook 的 opts.anchor 优先于本地阅读位置)。
//
// —— 聊天历史双后端(蓝图 §2,Telegram-iOS ChatHistoryListViewBackend 移植)——
// 时间线的滚动/几何/定位全部经 backend 协议(src/lib/telegram-history/),
// 平台细节留在各后端 wrapper,页面不绕过后端直挂列表回调:
//   · 后端 A(FlatListBackend,缺省):RN FlatList inverted + mVCP 吸底,
//     行为=改造前现状(FlashList v2 不支持 inverted,flash-list 仅用于对话
//     列表页);A 的 getListProps() 供给全部列表行为配置(onScroll/可见集/
//     onEndReached/onScrollToIndexFailed/mVCP/视口节流),页面只展开;
//   · 后端 B(VirtualBackend,调试开关):自研轻量虚拟列表(ScrollView
//     inverted + 窗口渲染 + onLayout 量测,对照 CoreListChatHistoryBackend
//     语义),宿主 backend-virtual-host.jsx 承载平台细节;
//   · 协调器(history-coordinator):行事实源 + diff 三段事务(删降序→插升序
//     →更)+ 挂载门禁 + 定位/重钉;聊天层一切后端相关分支只读
//     coordinator.usesBackend,页面不出现后端 kind 字符串字面量(防重推,
//     取值经 telegram-history 的常量/工具);
//   · 开关:头部标题长按 → 调试菜单「切换聊天历史后端」→ 写本地设置并
//     以 tick 换 key 整体重挂(构造期决策、每实例一次;缺省 A,可随时回滚,
//     无服务端 killswitch——单机自部署无该通道,如实不做)。
//
// 数据面全部走 useChatTimeline(首屏锚定 / 旧向翻页 / 乐观发送 / 阅读位置
// 本地落盘),页面只做装配:
//   · 行装配:lib/tg-rows.js buildRows(相册合流 + 发送者运行组 + merge 角 +
//     日期/未读分隔条)→ 协调器 setRows → diff 事务 → 后端应用(页面经后端
//     发布回调拿到 A 的应用结果作为 FlatList data;B 由宿主直读 core);
//   · 页面三事件流(§2.2-e,硬性语义:两后端同语义,页面只接一次):
//       onScrolled → 「在底部」判定(FAB 显隐门禁);
//       onVisibleRangeStrict → 已读双通道(onVisible 本地落盘 + reportRead
//         上报,相册取组内最大 id;只采信 ≥80% 可见档,锚定滚动落定前不喂,
//         防锚定滚动途中视口扫过的行误推进);
//       onReachOlderEdge → 旧向翻页(loadOlder,错误归属标「旧向」);
//   · 首屏锚定:loadInitial 落地后 coordinator.scrollToRow(锚点行,居中)
//     ——锚定链(anchor 参数>本地阅读位置>readInboxMaxId 跳记>最新页)与
//     feedGate 门禁照旧;feedGate 在锚定滚动落定(后端 onScrollSettled:
//     滚动成功/量测重试耗尽/无需滚动)后才开,滚动途中不采信已读;
//   · 分隔条:「未读消息」按 unreadAnchorId 插在锚点之上首条前(会话内固定
//     不随阅读移动),整条可点跳到未读起点;日期分隔条按天插(现状行为保留);
//   · 导航(§5.7 统一路径,禁止第五种定位实现):窗口内 scrollToRow(居中)/
//     窗口外 loadInitial 重锚定——引用条点击、未读线点击、t.me 深链、日历
//     跳转(CalendarPanel onJump,UI 由搜索域供给、契约见 §5.3-C)全部走
//     coordinator.navigateToMessage 一条路;
//   · 会话内搜索(官方式,非弹层):激活时头部行整体替换为搜索条+结果导航条
//     (components/telegram/search/ChatSearchHeader),防抖 250ms GET /search
//     起步 limit:50、offsetId 累计翻页(上限 500 条防无界);↑/↓ 逐条经统一
//     导航跳转并高亮当前结果(MessageBubble highlight);#tag 点按/⌘F/头部
//     搜索钮三个入口,取消/ESC 退出恢复原头部;「全局」切换在头部下方内嵌
//     GlobalSearchSection(#词限定,点结果跳对应会话,同列表页行为);
//   · 实时事件:聚焦时 hook 的 startPolling() 长轮询 GET /updates(失焦
//     stopPolling 掐断在途+清续轮,重新聚焦首拍即查);新消息/编辑/删除/
//     计数事件由 hook 落进 items 与 peer 头;typing 事件(TD 引擎)经 hook
//     typingSenders 呈现为头部「对方正在输入…」;
//   · 悬浮「回到底部」FAB(贴右下、输入区上方):不在底部时显示;unreadCount
//     (peer 头,随事件刷新)或 hasNewer 时带未读徽标;点击时若 hasNewer 先
//     有界循环 loadNewer 追平最新再滚底(失败 toast 即停,绝不自动重试),
//     否则经 coordinator.scrollToEndOfHistory 滚底(已贴底短路,TI
//     ulpOfOne 短路同构);
//   · 发送:ChatComposer 受控输入 + hook 乐观插入;回复态由消息长按菜单
//     「回复」设置;canSend=false 的频道隐藏输入条,显示「频道仅广播」;
//     bot 回复键盘条(最新一条 replyKeyboard)挂在输入条上方;
//   · 交互:内联键盘 onCallback → POST /callback(answer.message 轻提示 /
//     answer.alert 为弹窗标记、文案取 message 弹 Dialog / answer.url 走
//     openUrl 分流);成功后用返回的 message replaceMessage,并安排一次 1.5s
//     延时兜底同步——bot 编辑可能在响应快照之后落地,迟到的最终状态再补一拉;
//     投票 onVote → POST /vote 后 replaceMessage;视频消息
//     → useOpenVideo('telegram', videoId) 进观看页;
//   · 链接应用内跳转:正文链接(MessageText onUrl)/内联键盘 url 按钮/callback
//     answer.url 统一走 openUrl → lib/tg-links 的 parseTgLink 分流——同会话
//     jump 原位滚到该消息;peerKey 明确的跨会话 jump 直跳 /telegram/chat/
//     <peerKey>(带 anchor);只有 domain 的 jump 先 GET /api/telegram/resolve
//     解析成 peerKey 再跳(失败 toast 放弃,不外跳);其余 external 补协议头
//     后 Linking 外开。气泡本体不挂 onPress(长按菜单/失败警示钮承载),嵌套
//     Text 的链接点按优先;
//   · 已读:onVisibleRangeStrict 事件流(见上)+ 贴底新消息补喂 reportRead
//     (喂已确认可见的最大 id,不喂已载窗口最大 id——防把未真正看过的消息
//     顺手标读);已读双勾呈现:own 真实消息按 peer.readOutboxMaxId>=id
//     推导 readState('sent'/'read')传给气泡(数据缺失时恒 sent 单勾,不猜);
//   · 方向锁:仅手机画幅,聚焦 lockOrientation(false)(锁竖屏),失焦/卸载
//     restoreAfterFullscreen(true)(= cancelPendingUnlock + unlockAsync——与
//     播放器方向锁的延迟解锁定时器互斥,见 screen-orientation.js 注释);
//     iPad/桌面不锁;web 端模块探测恒空,天然 no-op;
//   · 键盘:useKeyboardInset 驱动——键盘可见时输入区 paddingBottom 去掉壳层
//     避让(chrome.bottom)只留小间距(iOS 由 KAV behavior 'padding' 整体抬
//     升,offset=头部以上实测高度;Android edge-to-edge 下系统 resize 不可
//     靠,用 hook 的 height 手动垫);键盘收起恢复壳层避让 padding;web 恒
//     无键盘不受影响;
//   · 壳层:手机画幅顶/底栏悬浮,页根垫 useChromeInsets().top、输入区垫
//     .bottom(pad/PC 恒 0),过 check:chrome 门禁。
// POST 通道(callback/vote)与 GET /message、GET /resolve 统一走 lib/tg-api.js
// (20s 默认超时;{__err:1,message,needLogin} → Error,needLogin 挂 Error
// 精确透传;响应原样返回不经 client.js 绝对化——消息对象由 hook 的
// replaceMessage 内归一)。失败如实上抛/展示,绝不自动重试;错误归属区分:
// 旧向翻页失败出视觉顶部错误条(重试入口),追平/后台链路失败静默或 toast。
// ============================================================================
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { ChevronDown, ChevronLeft, Close, Pin, Restart, Search, Send } from '../../../components/icons.js';
import { useChatTimeline } from '../../../hooks/use-chat-timeline.js';
import { useKeyboardInset } from '../../../hooks/use-keyboard-inset.js';
import { api, postJson } from '../../../lib/tg-api.js';
import { parseTgLink } from '../../../lib/tg-links.js';
import { buildRows } from '../../../lib/tg-rows.js';
import { one } from '../../../lib/router-params.js';
import { useOpenVideo } from '../../../lib/open-video.js';
import { useForm } from '../../../lib/use-form.js';
import { lockOrientation, restoreAfterFullscreen } from '../../../lib/screen-orientation.js';
import { useChromeInsets } from '../../../hooks/use-chrome-scroll.js';
import { usePalette } from '../../../components/ui/palette.js';
import { toDate } from '../../../components/telegram/chat-helpers.js';
import usePressVisual from '../../../lib/use-press-visual.js';
import Button from '../../../components/ui/Button.jsx';
import Dialog from '../../../components/ui/Dialog.jsx';
import Skeleton from '../../../components/ui/Skeleton.jsx';
import Spinner from '../../../components/ui/Spinner.jsx';
import { EmptyState, ErrorState } from '../../../components/zones/PageStates.jsx';
import {
  MessageBubble, ChatComposer, ReplyKeyboardBar, DateDivider, UnreadDivider, useHint,
  TgAvatar, KindBadge, KIND_LABEL,
} from '../../../components/telegram/index.js';
// —— 聊天历史双后端(协议/协调器/两后端/开关;kind 字面量只住 telegram-history/) ——
import {
  BACKEND_VIRTUAL, switchBackendKind, backendKindLabel, resolveBackendKind,
} from '../../../lib/telegram-history/history-backend.js';
import { createHistoryCoordinator } from '../../../lib/telegram-history/history-coordinator.js';
import { createFlatlistBackend } from '../../../lib/telegram-history/backend-flatlist.js';
import { createVirtualBackend } from '../../../lib/telegram-history/backend-virtual-core.js';
import VirtualHistoryHost from '../../../lib/telegram-history/backend-virtual-host.jsx';
import { useHistoryBackendSetting } from '../../../lib/telegram-history/backend-setting.js';
// —— 跨模块装配(§5 冻结契约):调试菜单容器(M4)/消息日历面板(M3) ——
import ContextMenu from '../../../components/telegram/context-menu/ContextMenu.jsx';
import CalendarPanel from '../../../components/telegram/search/CalendarPanel.jsx';
// —— 装配收口(蓝图二 §5.1-C/§5.3-B/§5.4/§5.6;复核 2026-10-12 补齐 M4/M5 接入):
//     消息主菜单/内容类型菜单/多选条/转发面板/会话内搜索/快捷键/增量端点 ——
import {
  buildMessageMenuFor, buildMentionMenu, buildCommandMenu,
} from '../../../lib/telegram-actions/message-menu.js';
import {
  pinMessage, editMessage, deleteMessages, classifyActionError,
} from '../../../lib/telegram-actions/endpoints.js';
import { forwardAbilities } from '../../../lib/telegram-forward.js';
import { reduceState } from '../../../lib/telegram-content-state/reducer.js';
import { emptyContentState } from '../../../lib/telegram-content-state/state.js';
import { loadState, saveState } from '../../../lib/telegram-content-state/store.js';
import { useTelegramShortcuts } from '../../../hooks/use-keyboard-shortcuts.js';
import ChatSearchHeader from '../../../components/telegram/search/ChatSearchHeader.jsx';
import GlobalSearchSection from '../../../components/telegram/search/GlobalSearchSection.jsx';
import ForwardPanel from '../../../components/telegram/forward/ForwardPanel.jsx';
import SelectionBar from '../../../components/telegram/SelectionBar.jsx';

const CALLBACK_SYNC_MS = 1500; // bot 回调后兜底同步的延时(见 scheduleCallbackSync)
const CHAT_MAX_W = 860;      // 聊天流最大宽(pad/PC 居中收束,同对话列表行宽)
const CATCHUP_MAX_PAGES = 15; // FAB 追平最新的有界页数上限(每页约 60 条,约 900 条封顶)
const LIST_EDGE_PAD = 8;     // 列表内容两端的视觉留白(A=contentContainerStyle
                             // 纵向 padding;B=宿主 edgePadding,同值同语义)
// —— 会话内搜索·官方式(头部搜索条+结果间导航,GET /search 契约) ——
const SEARCH_DEBOUNCE_MS = 250; // 输入防抖(官方口径 250ms)
const SEARCH_PAGE_LIMIT = 50;   // 单页条数(起步 limit:50,offsetId 累计翻页)
const SEARCH_MAX_LOADED = 500;  // 累计加载上限(防无界;达上限时计数位显示「已载 N」)
const SEARCH_PREFETCH = 10;     // 临近已载末端时预取下一页的余量(↑/↓ 途中无感续页)

// 对话键形态(与服务端 tg.js 的 isPeerKey 同口径;非法 id 走无效态)
const PEER_RE = /^(c\d+|g\d+|u\d+|saved)$/;

// 时间戳 → 'YYYY-MM'(日历面板 initialMonth 口径,§5.3-C;解析失败回当前月)
function monthKeyOf(v) {
  const d = toDate(v) || new Date();
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
}

// —— 「回到底部」FAB(贴右下、输入区上方):不在底部时显示;未读徽标
//    (count>0 出数字,hasNewer 但无计数出圆点);追平过程中转 spinner ——
function BackToBottomFab({ count, dot, loading, onPress }) {
  const p = usePalette();
  const hv = usePressVisual();
  const label = count > 0 ? '回到底部,' + count + ' 条未读' : '回到底部';
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', right: 14, bottom: 12, zIndex: 20 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        {...hv.binds}
        style={[
          {
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: p.surface,
            borderWidth: 1,
            borderColor: p.line,
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: '#000',
            shadowOpacity: 0.12,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 2 },
            elevation: 4,
          },
          { opacity: hv.pressed ? 0.85 : 1 },
        ]}
      >
        {loading ? <Spinner size={16} color={p.link} /> : <ChevronDown size={20} color={p.link} />}
      </Pressable>
      {/* 未读徽标:数字气泡(交互蓝,同对话列表未读口径);无计数但有更新出圆点 */}
      {count > 0 ? (
        <View
          style={{
            position: 'absolute',
            top: -5,
            right: -5,
            minWidth: 18,
            height: 18,
            borderRadius: 9,
            paddingHorizontal: 5,
            backgroundColor: p.link,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: p.background, fontSize: 11, lineHeight: 14, fontWeight: '600', includeFontPadding: false }}>
            {count > 99 ? '99+' : String(count)}
          </Text>
        </View>
      ) : dot ? (
        <View style={{ position: 'absolute', top: -4, right: -4, width: 10, height: 10, borderRadius: 5, backgroundColor: p.link }} />
      ) : null}
    </View>
  );
}

// —— 视觉顶部旧向翻页态条(A 的 ListFooter / B 的宿主 footer 同位):加载中 /
//    失败重试 / 历史尽头 ——
function TopTail({ loading, err, done, onRetry }) {
  const p = usePalette();
  if (err) {
    return (
      <View style={{ alignItems: 'center', paddingVertical: 10, gap: 6 }}>
        <Text numberOfLines={2} style={{ fontSize: 12, color: p.accent, textAlign: 'center', includeFontPadding: false }}>
          {'加载更早消息失败:' + err}
        </Text>
        <Button variant="secondary" size="sm" onPress={onRetry}>重试</Button>
      </View>
    );
  }
  if (loading) {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 10 }}>
        <Spinner size={13} color={p.muted} />
        <Text style={{ fontSize: 12, color: p.muted, includeFontPadding: false }}>正在加载更早的消息…</Text>
      </View>
    );
  }
  if (done) {
    return (
      <View style={{ alignItems: 'center', paddingVertical: 10 }}>
        <Text style={{ fontSize: 12, color: p.muted, includeFontPadding: false }}>没有更早的消息了</Text>
      </View>
    );
  }
  return null;
}

// —— 聊天流骨架:左右交替的气泡占位(首屏取数中) ——
function ChatSkeleton() {
  return (
    <View
      style={{
        flex: 1,
        maxWidth: CHAT_MAX_W,
        width: '100%',
        alignSelf: 'center',
        paddingHorizontal: 12,
        paddingTop: 8,
        gap: 10,
      }}
    >
      {Array.from({ length: 8 }, (_, i) => {
        const w = 120 + ((i * 53) % 150);
        const left = i % 3 !== 0; // 三行里两行靠左,近似入站居多的节奏
        return (
          <View key={i} style={{ flexDirection: 'row', justifyContent: left ? 'flex-start' : 'flex-end' }}>
            <Skeleton style={{ width: w, height: 22 + ((i * 17) % 30), borderRadius: 15 }} />
          </View>
        );
      })}
    </View>
  );
}

// ============================================================================
// 路由出口:设置读取 + 后端切换重挂(蓝图 §2.6 选择器落点)
// ----------------------------------------------------------------------------
// 三态选择器落在 init、每实例一次、构造期决策(TI 同构):开关设置由本层
// 读一次,连同路由参数交给内层;切换 = 写 setting + 换 key 整体重挂(复用
// 列表页的 tick 重挂模式),内层新实例构造期即用新后端。
// ============================================================================
export default function TelegramChatPage() {
  const params = useLocalSearchParams();
  const rawId = one(params.id);
  const id = PEER_RE.test(rawId) ? rawId : null;
  const nameParam = one(params.name);
  const avatarParam = one(params.avatar);
  const kindParam = one(params.kind);
  const anchorParam = Math.floor(Number(one(params.anchor))) || 0; // 深链锚点(可选)

  const p = usePalette();
  const setting = useHistoryBackendSetting(); // { ready, raw, kind, update } 首读(模块缓存后微任务级)
  // 切换意图的本地覆盖:update() 内部的 setRaw 与本层的 setTick 分属两个微
  // 任务,直接用 setting.kind 当 key 会让内层重挂两次(多一次整页重载)——
  // 切换回调里同批写覆盖+tick,单次重挂落地。
  const [overrideKind, setOverrideKind] = useState(null);
  const [tick, setTick] = useState(0);        // 切换后端的重挂计数(换 key)
  const activeKind = overrideKind || setting.kind;

  const switchBackend = useCallback(
    (next) => {
      // 写 setting(进程内即时生效,存储失败静默降级)→ 同批换 key 重挂内层。
      setting
        .update(next)
        .then((final) => {
          setOverrideKind(resolveBackendKind(final));
          setTick((t) => t + 1);
        })
        .catch(() => {});
    },
    [setting]
  );

  if (!setting.ready || !activeKind) {
    // 首读未就绪(AsyncStorage 一次往返):一帧底色占位
    return <View style={{ flex: 1, backgroundColor: p.background }} />;
  }
  return (
    <TelegramChatScreen
      key={activeKind + ':' + tick} // 后端切换 = 整页重挂(构造期决策)
      backendKind={activeKind}
      onSwitchBackend={switchBackend}
      routeId={id}
      routeName={nameParam}
      routeAvatar={avatarParam}
      routeKind={kindParam}
      routeAnchor={anchorParam}
    />
  );
}

// ============================================================================
// 聊天页本体(每实例一个后端,构造期冻结)
// ============================================================================
function TelegramChatScreen({ backendKind, onSwitchBackend, routeId, routeName, routeAvatar, routeKind, routeAnchor }) {
  const router = useRouter();
  const id = routeId;
  const nameParam = routeName;
  const avatarParam = routeAvatar;
  const kindParam = routeKind;
  const anchorParam = routeAnchor;

  const p = usePalette();
  const { form } = useForm();
  const padH = form === 'phone' ? 12 : 24; // 主区留白约定:px-3 / md:px-6
  // 壳层避让:手机画幅顶/底栏悬浮于内容之上,页根/输入区自垫(pad/PC 恒 0)
  const chrome = useChromeInsets();
  // 键盘避让:iOS KAV padding / Android 手动垫 hook 高度 / web 无感(hook 恒 0)
  const kb = useKeyboardInset();
  const kbBehavior = Platform.OS === 'ios' ? 'padding' : undefined;
  // 头部「头像+标题区」按压视觉(Android 样式函数陷阱,一律走本钩子,
  // 见 use-press-visual.js 头注)
  const titleHv = usePressVisual();

  // —— 时间线状态机(数据面唯一来源;无效 id 时 hook 静止) ——
  const {
    items, peer, loading, loadingOlder, loadingNewer, err, needLogin,
    hasOlder, hasNewer, anchorId, unreadAnchorId, typingSenders,
    loadInitial, loadOlder, loadNewer, send, retrySend, replaceMessage, onVisible,
    startPolling, stopPolling, reportRead, discardStub,
  } = useChatTimeline(id, { anchor: anchorParam });

  // —— 页内轻提示(toast):useHint 自管胶囊,消息组件族的 onHint 统一转发到这里 ——
  const { show: toast, overlay: toastOverlay } = useHint();
  // bot 回调 alert(Dialog 弹层文案;answer.alert 通道)
  const [alertText, setAlertText] = useState('');

  // —— 输入区状态 ——
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState(null); // { msgId, name, snippet } | null

  // —— 滚动/可见性联动状态 ——
  const [atBottom, setAtBottom] = useState(true); // 是否在视觉底部(FAB 显隐门禁)
  const [catchup, setCatchup] = useState(false);  // FAB 追平循环进行中(有界)
  const [headerH, setHeaderH] = useState(0);      // 头部行实测高度(KAV offset 用)
  const [inputAreaH, setInputAreaH] = useState(0); // 输入区实测高度(toast 定位用)
  const [backendRows, setBackendRows] = useState([]); // 后端 A 应用事务后的行(FlatList data)
  const [calendarOpen, setCalendarOpen] = useState(false);   // 消息日历面板(M3 件)
  const [calendarMonth, setCalendarMonth] = useState('');    // 日历初始月('YYYY-MM')
  const [debugMenuOpen, setDebugMenuOpen] = useState(false); // 标题长按调试菜单(M4 容器)

  // —— M4/M5 装配态(蓝图二 §5.1-C/§5.3-B/§5.4;复核 2026-10-12 收口) ——
  const [menuTarget, setMenuTarget] = useState(null);       // 长按主菜单目标消息
  const [entityMenu, setEntityMenu] = useState(null);        // 内容类型专属菜单 {kind:'mention'|'command', value}
  const [deleteTarget, setDeleteTarget] = useState(null);    // 删除确认 { ids:[int], revoke:bool, multi:bool }
  const [actionBusy, setActionBusy] = useState(false);       // 置顶/删除/编辑等动作在途(防连点)
  const [pinnedMessageId, setPinnedMessageId] = useState(0); // 置顶条/取消置顶数据源(GET /chat-header,§5.3-E)

  // —— 会话内搜索·官方式(聊天页头部行整体替换为搜索条+结果导航条;结果间
  //     ↑/↓ 逐条跳转高亮,#tag 点按直达,⌘F 激活/ESC 退出):state 面
  //     active/query/results/idx,已载计数与「n/m」的 m 由 results/服务端
  //     totalCount 派生;取数链(防抖/分页/重试)见下方 fetchSearchPage ——
  const [searchActive, setSearchActive] = useState(false);
  const [searchText, setSearchText] = useState('');          // 受控输入(含 # 前缀原样)
  const [searchResults, setSearchResults] = useState([]);    // 命中结果(消息 id 降序)
  const [searchIdx, setSearchIdx] = useState(0);             // 当前结果下标(↑/↓ 移动,钳制)
  const [searchPhase, setSearchPhase] = useState('idle');    // idle | loading | done | error
  const [searchTotal, setSearchTotal] = useState(null);      // 服务端 totalCount(缺省回已载数)
  const [searchCompleted, setSearchCompleted] = useState(true); // 服务端分页是否到底
  const [searchErr, setSearchErr] = useState('');
  const [searchMoreBusy, setSearchMoreBusy] = useState(false); // 翻页在途
  const [searchGlobal, setSearchGlobal] = useState(false);   // 本会话/全局互斥切换(全局段内嵌)
  // 内容状态机(§5.2):selection/forward/editing/draft——useReducer 纯函数域,
  // 持久化经 loadState/saveState(失焦/卸载 flush,清 selection/forward 留 draft)
  const [cstate, dispatchC] = useReducer(reduceState, null, emptyContentState);
  const cstateRef = useRef(cstate);                          // flush 用实时镜像
  cstateRef.current = cstate;
  const hydratedRef = useRef(false);                         // 每实例只 hydrate 一次

  // 跨渲染稳定的回调闭包用 ref(render 期同步,与 hook 的 itemsRef 同款)
  const listRef = useRef(null);     // 后端 A 的 FlatList 引用(wrapper 边界:经
                                    // getListNode 注入后端,页面自身不再直挂列表回调)
  const anchorIdRef = useRef(anchorId);
  anchorIdRef.current = anchorId;
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;
  const reportReadRef = useRef(reportRead);
  reportReadRef.current = reportRead;
  const loadInitialRef = useRef(loadInitial);
  loadInitialRef.current = loadInitial;
  const unreadAnchorRef = useRef(unreadAnchorId);
  unreadAnchorRef.current = unreadAnchorId;
  const atBottomRef = useRef(true);
  const readMaxRef = useRef(0);     // 已确认可见的最大消息 id(≥80% 档可见集
                                    // 维护;贴底补报与去重喂值共用,绝不直接
                                    // 采信已载窗口最大 id——防把未真正看过的
                                    // 消息顺手标读)
  const feedGateRef = useRef(false); // 首屏锚定滚动落定后才允许喂已读(见锚定 effect)
  const anchoredRef = useRef(false); // 本周期(items 就绪→下次重载)是否已做过首屏锚定
  const anchorTimerRef = useRef(null); // 在途的锚定滚动定时器(卸载兜底清理)
  const catchupTriesRef = useRef(0);   // FAB 追平已翻页数(有界循环上限)
  const resolveBusyRef = useRef(false); // /resolve 在途防抖(链接连点)
  const errFromRef = useRef('');    // 最近一次取数发起来源:'older'|'newer'(错误归属)
  const reloadPendingRef = useRef(true); // 下一次 rows 落地是否为「整页重载」(事务 reason)
  // —— 会话内搜索机的 ref 面(事件回调实时镜像/在途守卫;渲染期同步赋值,
  //     与上方 hook itemsRef 同款手法) ——
  const searchAbortRef = useRef(null);       // 在途 GET /search 掐断(换词/退出/卸载)
  const searchAliveRef = useRef(true);       // 卸载后旧响应丢弃
  const searchCompletedRef = useRef(true);   // completed 实时镜像(翻页判定用)
  const searchMoreBusyRef = useRef(false);   // 翻页在途镜像(防连点)
  const searchResultsRef = useRef([]);       // results 实时镜像(searchStep 事件面)
  const searchIdxRef = useRef(0);            // idx 实时镜像
  const searchTextRef = useRef('');          // 当前查询词镜像(重试/翻页取词)
  const searchInputFocusRef = useRef(false); // 搜索条聚焦中(Enter 发送语义门闩)
  // 渲染期实时镜像(事件回调闭包取最新值,与 anchorIdRef 同款手法)
  searchResultsRef.current = searchResults;
  searchIdxRef.current = searchIdx;
  searchTextRef.current = searchText;

  // —— 渲染行装配(相册合流 + 发送者运行组 + merge 角 + 日期/未读分隔条;
  //     lib/tg-rows,双后端同一装配) ——
  const showNames = !!(peer && peer.kind === 'group'); // 群聊才出发送者名
  const rows = useMemo(() => buildRows(items, unreadAnchorId, showNames), [items, unreadAnchorId, showNames]);

  // —— 头部元数据:路由参数先行,冷深链由首屏 around 响应的 peer 补齐 ——
  const title = nameParam
    || (peer && peer.name)
    || (id === 'saved' ? '我的收藏' : '对话 ' + (id || ''));
  const avatarSrc = avatarParam || (peer && peer.avatar) || '';
  const kind = KIND_LABEL[kindParam] ? kindParam : (peer ? peer.kind : '');

  // 未读徽标计数:peer 头的 unreadCount(首屏 around/拉新响应带来,/updates
  // 的 peer 事件随时刷新——FAB 徽标随事件同步)
  const unreadCount = peer && peer.unreadCount != null
    ? Math.max(0, Math.floor(Number(peer.unreadCount)) || 0)
    : 0;
  // 已读双勾推导(§5.7):own 真实消息按 peer.readOutboxMaxId 推;缺失恒 sent
  // 单勾降级(MTProto 首屏无该字段,事件流到达后即完整),绝不猜
  const readOutboxMaxId = peer && typeof peer.readOutboxMaxId === 'number' ? peer.readOutboxMaxId : 0;

  // ============================================================================
  // 后端与协调器(构造期装配;kind 每实例冻结)
  // ============================================================================
  // 页面三事件流的消费面(§2.2-e 硬性语义):后端把事件打到这里,页面绝不
  // 绕过后端直挂列表回调。render 期 latest-ref 镜像,后端闭包恒稳定。
  const backendHandlersRef = useRef({});

  // —— 后端 A 的事件消费:滚动读数 → 「在底部」判定(FAB 显隐门禁) ——
  const handleScrolledFromBackend = useCallback((offset, info) => {
    const near = !!(info && info.atBottom); // offset≤64(chat/[id].js BOTTOM_EPS 现状口径,后端内聚)
    if (near !== atBottomRef.current) {
      atBottomRef.current = near;
      setAtBottom(near);
    }
  }, []);

  // —— 后端事件消费:严格可见档(≥80% 可见)行真实消息 id 集合 → 已读双通道
  //     (onVisible 本地节流落盘 + reportRead 有界去抖上报);锚定滚动落定前
  //     不喂(feedGate)。两后端同语义:A=FlatList 单档 80% viewability 事件,
  //     B=自算几何的可见比例判定(backend-virtual-core READ_VISIBLE_RATIO) ——
  const handleVisibleFromBackend = useCallback((realIds) => {
    let maxId = 0;
    for (const rid of realIds || []) {
      const n = Math.floor(Number(rid)) || 0;
      if (n > maxId) maxId = n;
    }
    if (maxId > 0 && feedGateRef.current) {
      if (maxId > readMaxRef.current) readMaxRef.current = maxId;
      onVisibleRef.current(maxId);
      reportReadRef.current(maxId);
    }
  }, []);

  // —— 贴底时新消息到达:补喂 reportRead(喂 readMaxRef=已确认可见的最大
  //     id——由 ≥80% 档可见集维护,随 mVCP 吸底的滚动帧推进;绝不喂已载
  //     窗口最大 id,防锚定/翻页窗口里未真正看过的消息被顺手标读;同样等
  //     锚定滚动落定后采信,防锚定滚动前误报) ——
  useEffect(() => {
    if (!atBottom || !feedGateRef.current) return;
    if (readMaxRef.current > 0) reportReadRef.current(readMaxRef.current);
  }, [atBottom, items]);

  // —— 后端事件消费:到达视觉旧端 → 旧向翻页(错误归属标「旧向」) ——
  const onEnd = useCallback(() => {
    errFromRef.current = 'older';
    loadOlder();
  }, [loadOlder]);

  backendHandlersRef.current = {
    onScrolled: handleScrolledFromBackend,
    onVisibleRangeStrict: handleVisibleFromBackend, // 已读只采信 ≥80% 可见档(strict 通道)
    onReachOlderEdge: onEnd,
  };

  // —— 后端实例(构造期决策:kind 变化=整页重挂,不存在热切换) ——
  const backend = useMemo(() => {
    const handlers = backendHandlersRef;
    let b;
    if (backendKind === BACKEND_VIRTUAL) {
      b = createVirtualBackend(); // B:自研虚拟列表(平台细节在宿主,attachHost 注入)
    } else {
      b = createFlatlistBackend({
        getListNode: () => listRef.current, // wrapper 边界:页面持 ref,后端经此访问
        publishRows: setBackendRows,        // 事务应用结果 → FlatList data
      });
    }
    // 组 e 事件流:后端 → 页面消费面(latest-ref 转发,闭包恒稳定)。
    // onVisibleRange(协议通道,任意相交的宽口径)本页已无消费方——已读改采
    // onVisibleRangeStrict(≥80% 档),不接即自然悬空,后端缺省 no-op
    b.onScrolled = (offset, info) => { const h = handlers.current.onScrolled; if (h) h(offset, info); };
    b.onVisibleRangeStrict = (ids) => { const h = handlers.current.onVisibleRangeStrict; if (h) h(ids); };
    b.onReachOlderEdge = () => { const h = handlers.current.onReachOlderEdge; if (h) h(); };
    // 程序滚动落定(滚动成功/量测重试耗尽/无需滚动都回调):锚定滚动真正结束
    // 才开 feedGate,防滚动途中视口扫过的行被误采信(只碰 ref,无需 latest-ref)
    b.onScrollSettled = () => { feedGateRef.current = true; };
    return b;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendKind]);

  // —— 协调器(行事实源/diff/事务/定位;定位出窗口走 hook 的重锚定链) ——
  const coordinator = useMemo(
    () =>
      createHistoryCoordinator({
        backend,
        onOutOfWindow: (msgId) => {
          const fn = loadInitialRef.current;
          if (fn) fn(msgId); // §5.3 onJump 契约:未命中已载窗口 → loadInitial(msgId) 重锚定
        },
      }),
    [backend]
  );
  const coordinatorRef = useRef(coordinator);
  coordinatorRef.current = coordinator;
  const markMounted = useCallback(() => coordinator.markMounted(), [coordinator]);

  // —— 行事实源:rows → 协调器 diff → 事务(两后端同一入口)。
  //     items==null(骨架/重载)时清空事实源并标记下一轮为整页重载(事务
  //     stationaryItemRange 走 [.Reload] 承重值)——A 的发布面同步清空,防
  //     重挂后 FlatList 首帧吃旧数据 ——
  const itemsReady = items != null;
  useEffect(() => {
    const coord = coordinatorRef.current;
    if (!itemsReady) {
      reloadPendingRef.current = true;
      coord.setRows([], { reason: 'reload' });
      return undefined;
    }
    const reason = reloadPendingRef.current ? 'reload' : 'update';
    reloadPendingRef.current = false;
    coord.setRows(rows, { reason });
    return undefined;
  }, [rows, itemsReady]);

  // —— 首屏锚定:items 首次就绪(或刷新重载)后经协调器滚到锚点行 ——
  // items==null(骨架/重载)复位标志;就绪后延时 80ms 等首帧量测再定位
  // (居中;锚点行不在已载窗口则停在底部——定位失败由后端兜底,不重锚)。
  // 定时器不随 rows 变化清除(锚定指令每周期只发一次;定时器回调内取
  // anchorIdRef 的实时值,防 80ms 窗口内增量合并后滚到过期下标)。
  // feedGate 时序(B2 已读修复):有锚点时不再在发指令的同时开闸,改由后端
  // onScrollSettled(滚动成功/量测重试耗尽/无需滚动,含 backend-flatlist 的
  // 300ms 延时重试收尾)开启——锚定滚动完成前视口扫过的行不喂已读;指令
  // 未真正下发(锚点不在已载窗口,无滚动可言)或无锚点(停在最新页,无需
  // 滚动)时立即开闸。
  // effect 体内只写 ref + 定时器,零同步 setState(React Compiler 红线)
  useEffect(() => {
    if (items == null) {
      anchoredRef.current = false;
      feedGateRef.current = false;
      readMaxRef.current = 0; // 整页重载新周期:已确认可见位次清零,防跨周期旧值补报
      return undefined;
    }
    if (anchoredRef.current) return undefined;
    anchoredRef.current = true;
    anchorTimerRef.current = setTimeout(() => {
      anchorTimerRef.current = null;
      const aid = anchorIdRef.current;
      if (aid > 0) {
        // 定位经协议事务(scrollToItem);命中已载窗口才滚,未命中保持现状
        // (停在最新页)——首屏锚点本就来自本次取数,不重锚。feedGate 由
        // onScrollSettled 落定回调开启;scrollToRow 返回 false=指令未下发
        // (未挂载排队返回 true,flush 后仍会落定),此时立即开闸兜底
        const dispatched = coordinatorRef.current.scrollToRow(aid, { position: 'center', animated: false });
        if (dispatched !== true) feedGateRef.current = true;
      } else {
        // 无锚点(最新页,无需滚动):立即开闸
        feedGateRef.current = true;
      }
    }, 80);
    return undefined;
  }, [items, rows, anchorId]);

  // 卸载兜底:清在途的锚定定时器(回调内的定位已有后端兜底)
  useEffect(() => {
    return () => {
      if (anchorTimerRef.current != null) {
        clearTimeout(anchorTimerRef.current);
        anchorTimerRef.current = null;
      }
    };
  }, []);

  // 错误归属派生(渲染期):旧向失败出视觉顶部错误条;追平循环失败 toast;
  // 后台轮询失败 hook 内部已静默(err 单通道,以发起来源归属)
  const olderErr = !loadingOlder && err && errFromRef.current === 'older' ? err : '';
  const newerErr = !loadingNewer && err && errFromRef.current === 'newer' ? err : '';

  // —— 向新方向补一页(追平循环的单元动作,失败给 toast 由 effect 承接) ——
  const loadMoreNewer = useCallback(() => {
    errFromRef.current = 'newer';
    loadNewer();
  }, [loadNewer]);

  // —— 滚底(FAB 兜底路径):经协调器(已贴底短路;TI ulpOfOne 短路同构) ——
  const goBottom = useCallback(() => {
    coordinatorRef.current.scrollToEndOfHistory({ animated: true });
  }, []);

  // —— FAB 追平循环(状态机驱动,有界):每轮 loadNewer 落定后判——还有更新
  //    且未超页数上限则续翻;失败即停 + toast(绝不自动重试);到头(或达上限)
  //    收循环并滚底。loadNewer 在途/静默失败不落 loadingNewer 时由 deps 变化
  //    自然推进,不会同步自旋。 ——
  useEffect(() => {
    if (!catchup || loadingNewer) return;
    if (newerErr) {
      setCatchup(false);
      toast('加载新消息失败:' + newerErr);
      return;
    }
    if (hasNewer && catchupTriesRef.current < CATCHUP_MAX_PAGES) {
      catchupTriesRef.current += 1;
      loadMoreNewer();
      return;
    }
    setCatchup(false);
    goBottom();
  }, [catchup, loadingNewer, newerErr, hasNewer, loadMoreNewer, goBottom, toast]);

  // FAB 点击:有更新先走追平循环——首页由点击直接发起(顺带清掉 hook 里上一
  // 轮的旧错误态),后续页由上面的 effect 续,滚底由循环收尾统一做;否则直接滚底
  const onFab = useCallback(() => {
    if (!hasNewer) {
      goBottom();
      return;
    }
    catchupTriesRef.current = 1;
    setCatchup(true);
    loadMoreNewer();
  }, [hasNewer, goBottom, loadMoreNewer]);

  // —— 聚焦态:竖屏锁(仅手机画幅)+ 长轮询启停 + 失焦/卸载时解锁。
  //    restoreAfterFullscreen(true) = cancelPendingUnlock + unlockAsync,
  //    与播放器退全屏的延迟解锁定时器互斥(screen-orientation.js 注释口径),
  //    不会把后续视频全屏的横屏锁当场放掉 ——
  useFocusEffect(
    useCallback(() => {
      if (form === 'phone') lockOrientation(false); // 聊天页锁竖屏(web/iPad/PC 不锁)
      startPolling(); // 长轮询(重新聚焦首拍即查;失败 hook 内静默 20s 再发)
      return () => {
        stopPolling();
        if (form === 'phone') restoreAfterFullscreen(true);
      };
    }, [form, startPolling, stopPolling])
  );

  // 从登录页返回聚焦:此前因未登录失败的首屏自动重拉([id].js 同款口径)
  const errRef = useRef('');
  errRef.current = err;
  useFocusEffect(
    useCallback(() => {
      if (errRef.current && errRef.current.indexOf('未登录') !== -1) loadInitial();
    }, [loadInitial])
  );

  // —— 返回:栈里有上一级(通常是 Telegram 列表页)就 back;冷深链回列表页 ——
  const back = useCallback(() => {
    try {
      if (typeof router.canGoBack === 'function' && router.canGoBack()) {
        router.back();
        return;
      }
    } catch (_e) { /* 判定异常走兜底 */ }
    router.replace('/telegram');
  }, [router]);

  // 去登录:跳 Telegram 专属页完成登录(back 回本页自动重拉)
  const goLogin = useCallback(() => {
    router.push('/telegram');
  }, [router]);

  // —— 共享媒体面板:头部「头像+标题区」点按进入(带 name/avatar/kind 免
  //    冷启动拉对话表;面板内行点击/长按日跳转带 anchor 回本页) ——
  const openMedia = useCallback(() => {
    router.push({
      pathname: '/telegram/media/[id]',
      params: {
        id: String(id),
        name: typeof title === 'string' ? title : '',
        avatar: avatarSrc || '',
        kind,
      },
    });
  }, [router, id, title, avatarSrc, kind]);

  // —— 刷新:整体重载(hook 决策链重走锚定;回复态一并清掉) ——
  const refresh = useCallback(() => {
    setReplyTo(null);
    loadInitial();
  }, [loadInitial]);

  // —— 视频消息 → 观看页(site 固定 'telegram',id = media.video.videoId) ——
  const goVideo = useOpenVideo();
  const openVideo = useCallback(
    (videoId) => {
      if (videoId != null && videoId !== '') goVideo('telegram', String(videoId));
    },
    [goVideo]
  );

  // —— 导航(§5.7 统一路径):窗口内滚到该消息(居中)/ 窗口外重锚定,
  //     由 coordinator.navigateToMessage 一条路承载(引用条点击 / 未读线
  //     点击 / t.me 深链 / 日历跳转全部走它,禁止第五种定位实现) ——
  const jumpToRow = useCallback((msgId, animated) => {
    coordinatorRef.current.navigateToMessage(msgId, { position: 'center', animated: animated !== false });
  }, []);
  const jumpTo = useCallback((msgId) => jumpToRow(msgId, true), [jumpToRow]);

  // —— 消息日历(M3 件,§5.3-C 契约):初始月=已载窗口最新真实消息的所属月
  //     (无消息回当前月);点击某日 → onJump(lastMessageId) → 统一导航 ——
  const openCalendar = useCallback(() => {
    const newest = items && items.length ? items.find((m) => m && typeof m.id === 'number' && m.id > 0) : null;
    setCalendarMonth(monthKeyOf(newest ? newest.date : null));
    setCalendarOpen(true);
  }, [items]);
  const handleCalendarJump = useCallback(
    (msgId) => {
      setCalendarOpen(false);
      jumpTo(msgId);
    },
    [jumpTo]
  );

  // ============================================================================
  // 会话内搜索·官方式取数与导航(头部行整体替换为 ChatSearchHeader)
  // ----------------------------------------------------------------------------
  // GET /api/telegram/search {peer,q,limit,offsetId} → {messages,totalCount,
  // completed}(id 降序;分页 offsetId=上一页最旧 id;q 支持 #tag——响应形状
  // 沿用既有增量端点契约)。防抖 250ms 起步 limit:50;累计翻页上限 500 条
  // 防无界(计数位如实标「已载 N」);上游失败如实呈现中文错误+显式重试,
  // 绝不自动重试(防风暴红线);↑/↓ 经统一导航链定位(窗口外自动重锚定)。
  // ============================================================================
  const fetchSearchPage = useCallback(
    async (qText, offsetId, isMore) => {
      if (searchAbortRef.current) searchAbortRef.current.abort();
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      searchAbortRef.current = ctl;
      if (isMore) {
        searchMoreBusyRef.current = true;
        setSearchMoreBusy(true);
      } else {
        // 首查即清空旧词结果态(防换词失败时残留旧结果被误当新词结果翻页/
        // 计数;空态由计数位 spinner/占位文案承接)
        setSearchResults([]);
        setSearchIdx(0);
        setSearchPhase('loading');
      }
      try {
        const r = await api('telegram', 'search', {
          peer: id,
          q: qText,
          limit: SEARCH_PAGE_LIMIT,
          ...(offsetId ? { offsetId } : {}),
        }, { signal: ctl ? ctl.signal : undefined });
        if (!searchAliveRef.current) return;
        const msgs = Array.isArray(r && r.messages) ? r.messages.filter(Boolean) : [];
        const done = r ? Boolean(r.completed) : true;
        searchCompletedRef.current = done;
        setSearchCompleted(done);
        setSearchTotal(r && r.totalCount != null ? Number(r.totalCount) : null);
        setSearchErr('');
        setSearchPhase('done');
        if (!isMore) {
          setSearchResults(msgs);
          setSearchIdx(0);
          // 官方式:落首查结果即跳到最新一条命中并高亮(窗口内滚动/窗口外
          // 重锚定,统一导航一条路)
          const first = msgs.find((m) => m && m.id > 0);
          if (first) jumpTo(first.id);
        } else {
          // 翻页:按 id 去重追加(结果恒按 id 降序)
          setSearchResults((prev) => {
            const seen = new Set(prev.map((x) => (x && x.id != null ? String(x.id) : '')));
            return prev.concat(msgs.filter((x) => x && x.id != null && !seen.has(String(x.id))));
          });
        }
      } catch (e) {
        if (!searchAliveRef.current) return;
        if (e && e.name === 'AbortError') return; // 换词/退出掐断:静默
        setSearchErr((e && e.message) || '搜索失败,请重试');
        // 翻页失败保留已载结果(仅标错误);首查失败才进整段错误态
        if (!isMore) setSearchPhase('error');
      } finally {
        if (isMore) {
          searchMoreBusyRef.current = false;
          setSearchMoreBusy(false);
        }
      }
    },
    [id, jumpTo]
  );
  const fetchSearchPageRef = useRef(fetchSearchPage);
  fetchSearchPageRef.current = fetchSearchPage;

  // 卸载兜底:掐断在途搜索请求(退出页面前后到达的响应一律丢弃)
  useEffect(() => {
    searchAliveRef.current = true;
    return () => {
      searchAliveRef.current = false;
      if (searchAbortRef.current) {
        searchAbortRef.current.abort();
        searchAbortRef.current = null;
      }
    };
  }, []);

  // —— 输入防抖 250ms → 首查;空词复位结果态(在途请求掐断;翻页不在此路径)。
  //     全局态挂起本会话取数(两态互斥;回本会话态时本 effect 重跑续查) ——
  useEffect(() => {
    if (!searchActive || searchGlobal || !id) return undefined; // 无效对话不发搜索
    const q = String(searchText == null ? '' : searchText).trim();
    if (!q) {
      if (searchAbortRef.current) {
        searchAbortRef.current.abort();
        searchAbortRef.current = null;
      }
      searchCompletedRef.current = true;
      setSearchResults([]);
      setSearchIdx(0);
      setSearchPhase('idle');
      setSearchTotal(null);
      setSearchCompleted(true);
      setSearchErr('');
      return undefined;
    }
    const t = setTimeout(() => {
      fetchSearchPageRef.current(q, 0, false);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchActive, searchGlobal, searchText, id]);

  // —— 进入全局态:掐断在途的本会话搜索请求(已载结果保留,回本会话态续用) ——
  useEffect(() => {
    if (searchActive && searchGlobal && searchAbortRef.current) {
      searchAbortRef.current.abort();
      searchAbortRef.current = null;
    }
  }, [searchActive, searchGlobal]);

  // —— 翻页(有界):已载末端再按 ↓ 或临近末端(余量 SEARCH_PREFETCH)时取
  //     下一页;completed/达 500 上限/在途中不再取 ——
  const searchLoadMore = useCallback(() => {
    const list = searchResultsRef.current;
    if (!list.length) return;
    if (searchCompletedRef.current || list.length >= SEARCH_MAX_LOADED) return;
    if (searchMoreBusyRef.current) return;
    const oldest = list[list.length - 1];
    const off = oldest && Number(oldest.id) > 0 ? Math.floor(Number(oldest.id)) : 0;
    if (!off) return;
    fetchSearchPageRef.current(searchTextRef.current.trim(), off, true);
  }, []);

  // —— ↑/↓ 逐条移动(钳制 [0, len-1]) + 统一导航跳转;临近末端预取下一页。
  //     idx 镜像同步写 ref(连点不等重渲染,读到的恒是最新位次) ——
  const searchStep = useCallback(
    (dir) => {
      const list = searchResultsRef.current;
      if (!list.length) return;
      const cur = searchIdxRef.current;
      let next = cur + (dir > 0 ? 1 : -1);
      if (next < 0) next = 0;
      if (next > list.length - 1) next = list.length - 1;
      if (next >= list.length - SEARCH_PREFETCH) searchLoadMore(); // 有界预取(内部自守)
      searchIdxRef.current = next;
      if (next !== cur) setSearchIdx(next);
      const target = list[next];
      if (target && target.id > 0) jumpTo(target.id); // 窗口外自动重锚定
    },
    [searchLoadMore, jumpTo]
  );

  // —— 激活(头部搜索钮/⌘F/#tag 点按直达,可预填)与退出(取消/关闭/ESC,
  //     恢复原头部;在途请求掐断) ——
  const activateSearch = useCallback((prefill) => {
    setSearchText(typeof prefill === 'string' ? prefill : '');
    setSearchActive(true);
  }, []);
  const exitSearch = useCallback(() => {
    if (searchAbortRef.current) {
      searchAbortRef.current.abort();
      searchAbortRef.current = null;
    }
    searchCompletedRef.current = true;
    searchMoreBusyRef.current = false;
    setSearchActive(false);
    setSearchGlobal(false);
    setSearchText('');
    setSearchResults([]);
    setSearchIdx(0);
    setSearchPhase('idle');
    setSearchTotal(null);
    setSearchCompleted(true);
    setSearchErr('');
    setSearchMoreBusy(false);
  }, []);

  // —— 错误重试(显式点按):已载结果非空=续翻上一页失败的重试;否则整查重试 ——
  const searchRetry = useCallback(() => {
    const q = String(searchTextRef.current || '').trim();
    if (!q) return;
    if (searchResultsRef.current.length) searchLoadMore();
    else fetchSearchPageRef.current(q, 0, false);
  }, [searchLoadMore]);

  // —— 全局段结果跳转(同对话列表页现行为):push 聊天页带 anchor;冷会话
  //     头部元数据由聊天页首屏响应补齐 ——
  const openGlobalResult = useCallback(
    (msg) => {
      if (!msg || msg.peerKey == null || msg.id == null) return;
      router.push({
        pathname: '/telegram/chat/[id]',
        params: { id: String(msg.peerKey), anchor: String(msg.id) },
      });
    },
    [router]
  );

  // —— 派生:当前命中消息 id(renderRow 高亮判定,相册成员命中由行装配面
  //     处理)与「n/m」计数文案 ——
  const searchHitId = useMemo(() => {
    const m = searchResults[searchIdx];
    return m && typeof m.id === 'number' && m.id > 0 ? m.id : 0;
  }, [searchResults, searchIdx]);
  // 计数位:n/m(m=服务端 totalCount,缺省回已载数);达 500 累计上限后不再
  // 翻页,如实标「已载 N」;空词/首查在途/错误态不出计数(占位文案/错误条承接)
  const searchQ = String(searchText == null ? '' : searchText).trim();
  const searchIsTag = searchQ.startsWith('#') && searchQ.length > 1;
  const searchCapped = !searchCompleted && searchResults.length >= SEARCH_MAX_LOADED;
  const searchCounter = !searchActive || !searchQ
    ? ''
    : (searchPhase === 'loading' && !searchResults.length) || searchPhase === 'error'
      ? ''
      : !searchResults.length
        ? '无匹配结果'
        : (searchIdx + 1) + '/' + (searchCapped
          ? '已载 ' + searchResults.length
          : (searchTotal != null ? searchTotal : searchResults.length));

  // —— 回复态:消息长按菜单「回复」设置(输入条上方出引用条) ——
  const startReply = useCallback((msg) => {
    if (!msg) return;
    const name = (msg.from && msg.from.name) || (msg.out ? '我自己' : '');
    const snippet = String(msg.text || '').slice(0, 64) || (msg.media ? '[媒体消息]' : '');
    setReplyTo({ msgId: msg.id, name, snippet });
  }, []);

  // bot 快捷回复键盘:点按钮直接作为消息发送(不带回复目标)
  const pickQuick = useCallback(
    (text) => {
      const t = String(text == null ? '' : text).trim();
      if (!t) return;
      send(t).catch((e) => {
        toast((e && e.message) || '发送失败');
      });
    },
    [send, toast]
  );

  // —— 失败消息重发(气泡警示钮触发) ——
  const retryOne = useCallback(
    (msg) => {
      if (!msg || !(msg.id < 0)) return;
      retrySend(msg.id).catch((e) => {
        toast((e && e.message) || '重发失败');
      });
    },
    [retrySend, toast]
  );

  // ============================================================================
  // M4/M5 装配处理器(蓝图二 §5.1-C/§5.3-B/§5.4/§5.6;复核 2026-10-12 收口):
  // 消息主菜单/多选/转发/编辑/置顶/删除/会话内搜索/快捷键/内容状态机
  // ============================================================================

  const inputRef = useRef('');      // composer 实时镜像(draft flush 用)
  inputRef.current = input;
  const doSendRef = useRef(null);   // ⌘+Enter 发送用实时镜像(快捷键 latest-ref)
  const selection = cstate.selection;
  const selectionActive = !!selection;
  const editing = cstate.editing;
  const editTarget = useMemo(
    () => (editing ? (items || []).find((m) => m && m.id === editing.msgId) || null : null),
    [editing, items]
  );
  const pinnedMsg = useMemo(
    () => (pinnedMessageId > 0 ? (items || []).find((m) => m && m.id === pinnedMessageId) || null : null),
    [items, pinnedMessageId]
  );

  // 动作错误统一呈现(§4.1 契约化降级:unsupported 服务端中文原文如实、
  // needLogin 引导去登录;绝不轮询重试——防风暴红线)
  const runAction = useCallback(
    async (fn, okMsg) => {
      setActionBusy(true);
      try {
        const r = await fn();
        if (r != null && okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
        return r;
      } catch (e) {
        const cls = classifyActionError(e);
        if (cls.needLogin) {
          toast('请先登录');
          goLogin();
        } else {
          toast(cls.message);
        }
        return undefined;
      } finally {
        setActionBusy(false);
      }
    },
    [toast, goLogin]
  );

  // —— 发送:受控输入清空 + hook 乐观插入(存根负 id,失败标 __status='failed'
  //    由气泡红色警示钮承载重试;此处 catch 只补一条 toast,如实不自动重试)。
  //    编辑态(§3.3)优先:POST /edit → replaceMessage 原位替换后退编辑。
  //    声明点须在 editTarget/runAction 之后:依赖数组在渲染期即读取这两个
  //    后置声明(声明提升不覆盖 const,TDZ 直接炸「Cannot access before
  //    initialization」,2026-10-13 修复) ——
  const doSend = useCallback(
    (text) => {
      const t = String(text == null ? '' : text).trim();
      if (!t || sending) return;
      if (editTarget) {
        setSending(true);
        runAction(() => editMessage({ peer: id, id: editTarget.id, text: t }))
          .then((r) => {
            if (r && r.message) {
              replaceMessage(r.message);
              dispatchC({ type: 'cancelEdit' });
              setInput('');
            }
          })
          .finally(() => setSending(false));
        return;
      }
      const rid = replyTo && replyTo.msgId > 0 ? replyTo.msgId : 0; // 回复本地存根(负 id)不带给服务端
      setInput('');
      setReplyTo(null);
      setSending(true);
      send(t, rid > 0 ? rid : undefined)
        .catch((e) => {
          toast((e && e.message) || '发送失败');
        })
        .finally(() => setSending(false));
    },
    [send, sending, replyTo, toast, editTarget, id, runAction, replaceMessage]
  );

  const copyText = useCallback(
    async (t) => {
      try {
        await Clipboard.setStringAsync(String(t == null ? '' : t));
        toast('已复制');
      } catch (_e) {
        toast('复制失败');
      }
    },
    [toast]
  );

  // —— 编辑自有文本消息(§3.3:输入框回填 + 编辑条,确认 POST /edit 后原位替换) ——
  const startEdit = useCallback((msg) => {
    dispatchC({ type: 'beginEdit', msgId: msg.id });
    setReplyTo(null);
    setInput(String(msg.text || ''));
  }, []);
  const cancelEdit = useCallback(() => {
    dispatchC({ type: 'cancelEdit' });
    setInput('');
  }, []);

  // —— 多选(§3.2-2:多选态长按/点按=切换选中;Select All=已载窗口) ——
  const toggleSelect = useCallback((msg) => {
    if (msg && msg.id > 0) dispatchC({ type: 'toggleSelect', msgId: msg.id });
  }, []);
  const selectAllLoaded = useCallback(() => {
    const ids = (items || [])
      .filter((m) => m && typeof m.id === 'number' && m.id > 0 && m.kind !== 'service')
      .map((m) => m.id);
    dispatchC({ type: 'selectAll', ids });
  }, [items]);

  // —— 删除(§4.2-⑧:三选 Dialog 的动作面;真实 id 才进服务端,时间线随
  //     /updates 的 delete 事件自愈,失败如实 toast 不重试) ——
  const runDelete = useCallback(
    (ids, revoke) => {
      const list = (Array.isArray(ids) ? ids : []).map((n) => Math.floor(Number(n))).filter((n) => Number.isFinite(n) && n > 0);
      if (!list.length) return;
      runAction(() => deleteMessages({ peer: id, ids: list, revoke: !!revoke }), '已删除 ' + list.length + ' 条消息')
        .then((r) => {
          if (r) dispatchC({ type: 'clearSelection' });
        });
    },
    [id, runAction]
  );

  // —— 置顶/取消置顶(§4.2-⑤;本地同步 pinnedMessageId 供置顶条与菜单翻转) ——
  const runPin = useCallback(
    (msg, unpin) => {
      runAction(() => pinMessage({ peer: id, id: msg.id, unpin: !!unpin }), unpin ? '已取消置顶' : '已置顶')
        .then((r) => {
          if (r) setPinnedMessageId(unpin ? 0 : msg.id);
        });
    },
    [id, runAction]
  );

  // 置顶条/取消置顶数据源:GET /chat-header(§5.3-E 同源字段;尽力而为,
  // 失败静默——头部增强信息缺失不阻塞主流程, abilities 的 unpin 不猜)
  useEffect(() => {
    setPinnedMessageId(0);
    let alive = true;
    api('telegram', 'chat-header', { peer: id })
      .then((hd) => {
        if (alive && hd && Number(hd.pinnedMessageId) > 0) setPinnedMessageId(Math.floor(Number(hd.pinnedMessageId)));
      })
      .catch(() => { /* 尽力而为:缺失只降级「取消置顶/置顶条」呈现 */ });
    return () => { alive = false; };
  }, [id]);

  // 内容状态 hydrate(items 首次就绪后注入,§5.2;草稿回填只在输入框为空时让位)
  useEffect(() => {
    if (items == null || hydratedRef.current || !id) return undefined;
    hydratedRef.current = true;
    let alive = true;
    loadState(id)
      .then((s) => {
        if (!alive || !s) return;
        dispatchC({ type: 'hydrate', state: s });
        if (s.draft && s.draft.text) setInput((prev) => (prev ? prev : s.draft.text));
      })
      .catch(() => { /* 存储不可用:静默降级 */ });
    return () => {
      alive = false;
    };
  }, [items == null, id]);

  // 失焦/卸载 flush(§5.6:清 selection/forward、留 draft)——即时读 ref 镜像,
  // 不依赖渲染闭包
  const flushContentState = useCallback(() => {
    if (!id) return;
    const st = cstateRef.current;
    const text = String(inputRef.current || '');
    const draft = text ? { text, updatedAt: Date.now() } : null;
    saveState(id, { ...st, draft }).catch(() => { /* 本地写失败静默 */ });
  }, [id]);
  useFocusEffect(
    useCallback(
      () => () => {
        flushContentState();
        dispatchC({ type: 'clearSelection' });
        dispatchC({ type: 'clearForward' });
      },
      [flushContentState]
    )
  );
  useEffect(() => () => flushContentState(), [flushContentState]);

  // —— 主菜单 actions(§5.1-C 表;动作先收菜单再执行,与 ContextMenu 语义一致) ——
  const canSend = peer ? peer.canSend !== false : false;
  const menuActions = useMemo(
    () => ({
      onReply: (m) => { setMenuTarget(null); startReply(m); },
      onEdit: (m) => { setMenuTarget(null); startEdit(m); },
      onCopy: (m) => { setMenuTarget(null); copyText(m.text); },
      onForward: (m) => { setMenuTarget(null); dispatchC({ type: 'setForward', ids: [m.id] }); },
      onPin: (m) => { setMenuTarget(null); runPin(m, false); },
      onUnpin: (m) => { setMenuTarget(null); runPin(m, true); },
      onSelect: (m) => { setMenuTarget(null); dispatchC({ type: 'toggleSelect', msgId: m.id }); },
      onDelete: (m, { revoke }) => {
        setMenuTarget(null);
        setDeleteTarget({ ids: [m.id], revoke: !!revoke, multi: false });
      },
      onRetry: (m) => { setMenuTarget(null); retryOne(m); },
      onCancelSend: (m) => { setMenuTarget(null); discardStub(m.id); },
    }),
    [startReply, startEdit, copyText, runPin, retryOne, discardStub]
  );
  const menuCtx = useMemo(
    () => ({ peer: { kind, canSend }, selectionActive, pinnedMessageId }),
    [kind, canSend, selectionActive, pinnedMessageId]
  );
  const menuItems = useMemo(
    () => (menuTarget ? buildMessageMenuFor(menuTarget, menuCtx, menuActions) : []),
    [menuTarget, menuCtx, menuActions]
  );

  // —— @提及跳转(§3.4 降级语义:打开对话=GET /resolve 后 push;MentionName
  //    的 userId 无解析面,如实降级为复制入口不可用提示) ——
  const openMentionChat = useCallback(
    ({ username }) => {
      const domain = String(username || '').trim();
      if (!domain) {
        toast('暂不支持跳转该提及');
        return;
      }
      if (resolveBusyRef.current) return;
      resolveBusyRef.current = true;
      api('telegram', 'resolve', { domain })
        .then((res) => {
          if (!res || !res.peerKey) throw new Error('无法识别该提及');
          router.push({
            pathname: '/telegram/chat/[id]',
            params: { id: String(res.peerKey), name: res.name || '', kind: res.kind || '' },
          });
        })
        .catch((e) => toast((e && e.message) || '无法打开该提及'))
        .finally(() => {
          resolveBusyRef.current = false;
        });
    },
    [router, toast]
  );

  // —— 内容类型专属菜单(§3.4):提及/命令两 builder。#话题已改官方式直达
  //    (MessageText onHashtag → activateSearch('#tag') 直接激活搜索态并预填,
  //    不再弹两项菜单,buildHashtagMenu 已退役) ——
  const entityItems = useMemo(() => {
    if (!entityMenu) return [];
    if (entityMenu.kind === 'mention') {
      return buildMentionMenu({ username: entityMenu.value }, {
        onOpenChat: (v) => { setEntityMenu(null); openMentionChat(v); },
        onCopy: (t) => { setEntityMenu(null); copyText(t); },
      });
    }
    if (entityMenu.kind === 'command') {
      return buildCommandMenu({ command: entityMenu.value }, {
        onFill: (cmd) => { setEntityMenu(null); setInput(cmd + ' '); },
      });
    }
    return [];
  }, [entityMenu, copyText, openMentionChat]);

  // —— 快捷键(§5.6 Esc 浮层栈:调试菜单→主/专属菜单→删除确认→转发→日历→
  //    搜索退出(恢复原头部)→多选退出→清回复→退编辑;⌘/Ctrl+F 激活搜索态;
  //    web 平台实现,原生空实现,签名一致) ——
  useTelegramShortcuts({
    onEscape: () => {
      if (debugMenuOpen) { setDebugMenuOpen(false); return true; }
      if (menuTarget) { setMenuTarget(null); return true; }
      if (entityMenu) { setEntityMenu(null); return true; }
      if (deleteTarget) { setDeleteTarget(null); return true; }
      if (cstate.forward) { dispatchC({ type: 'clearForward' }); return true; }
      if (calendarOpen) { setCalendarOpen(false); return true; }
      if (searchActive) { exitSearch(); return true; }
      if (selectionActive) { dispatchC({ type: 'clearSelection' }); return true; }
      if (replyTo) { setReplyTo(null); return true; }
      if (editTarget) { cancelEdit(); return true; }
      return false;
    },
    onFocusSearch: () => {
      // ⌘/Ctrl+F:激活官方式会话内搜索(已激活则不动——保留当前结果态)
      if (!searchActive) activateSearch('');
    },
    onSend: () => {
      // 搜索条聚焦时 Enter 不发送消息(「下一条结果」由搜索条 onSubmitEditing
      // 承载,避免 web 双派发);其余(输入条聚焦)照常发送
      if (searchActive && searchInputFocusRef.current) return;
      if (doSendRef.current) doSendRef.current();
    },
  });
  doSendRef.current = () => doSend(inputRef.current); // 渲染期镜像(⌘+Enter 发送当前输入)

  // —— bot 回调兜底同步:bot 对消息的编辑可能在回调响应快照之后才落地(服务
  //    端阶梯已尽力带回编辑后状态),此处只补一次迟到同步——1500ms 后经页面
  //    现成 GET 通道(与取数同源,lib/tg-api 原样响应;结果经 replaceMessage
  //    内归一)单条拉取并原位替换(id 不在已载窗口 / 内容相同为无害 no-op 或
  //    等值替换)。失败静默 console 记录,绝不重试:这不是失败自动重试,是
  //    bot 编辑晚于响应快照落地的最终一致性兜底。每个消息 id 同时最多一个
  //    在途兜底(重复点击先清旧定时器防叠加;按钮自身 busy 防连点之外的第二
  //    道保险) ——
  const cbSyncTimersRef = useRef(new Map()); // msgId → 兜底定时器
  const clearCbSyncTimer = useCallback((msgId) => {
    const t = cbSyncTimersRef.current.get(msgId);
    if (t != null) {
      clearTimeout(t);
      cbSyncTimersRef.current.delete(msgId);
    }
  }, []);
  const scheduleCallbackSync = useCallback(
    (msgId) => {
      clearCbSyncTimer(msgId); // 防叠加:同 id 已有兜底先清旧定时器
      cbSyncTimersRef.current.set(msgId, setTimeout(() => {
        cbSyncTimersRef.current.delete(msgId);
        api('telegram', 'message', { peer: id, id: msgId })
          .then((res) => {
            if (res && res.message) replaceMessage(res.message);
          })
          .catch((e) => {
            // 失败静默:只补这一次迟到同步,绝不重试(防请求风暴红线)
            console.warn('[telegram/chat] 回调兜底同步失败(忽略):', e && e.message ? e.message : e);
          });
      }, CALLBACK_SYNC_MS));
    },
    [id, clearCbSyncTimer, replaceMessage]
  );
  // 卸载/换会话兜底:清掉全部在途的兜底定时器(照抄锚定定时器的清理模式;
  // 清理随 id 变化也触发——换会话后旧会话的兜底同步没有意义)
  useEffect(() => {
    return () => {
      for (const t of cbSyncTimersRef.current.values()) clearTimeout(t);
      cbSyncTimersRef.current.clear();
    };
  }, [id]);

  // —— 外链兜底:补协议头后交系统打开(email 走 mailto:,无协议补 https)——
  const openExternal = useCallback(
    (raw, kindArg) => {
      let u = String(raw == null ? '' : raw).trim();
      if (!u) return;
      if (kindArg === 'email') u = 'mailto:' + u;
      else if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
      Linking.openURL(u).catch(() => toast('无法打开链接'));
    },
    [toast]
  );

  // —— 链接点击分流(正文链接 / 内联键盘 url 按钮 / callback answer.url):
  //    parseTgLink 判定可承接的「跳进对话」深链——同会话原位滚到该消息;
  //    peerKey 明确的跨会话直跳聊天页(带 anchor);只有 domain 的先
  //    GET /resolve 解析成 peerKey 再跳(失败 toast 放弃,不外跳);其余
  //    external 补协议头外开 ——
  const openUrl = useCallback(
    (raw, kindArg) => {
      const link = parseTgLink(raw);
      // 邀请链接(t.me/+hash):checkChatInviteLink 承接——已加入的频道/群组
      // 应用内直达(官方客户端同款,N3);未加入如实提示后外开邀请页加入
      if (link.kind === 'invite') {
        if (resolveBusyRef.current) return; // /resolve 在途:吞掉连点,不排队
        resolveBusyRef.current = true;
        api('telegram', 'resolve', { invite: link.invite })
          .then((res) => {
            if (res && res.joined && res.peerKey) {
              router.push({
                pathname: '/telegram/chat/[id]',
                params: { id: String(res.peerKey), name: res.name || '', kind: res.kind || '' },
              });
              return;
            }
            toast('尚未加入该频道' + (res && res.title ? '「' + res.title + '」' : '') + ',已打开邀请页');
            openExternal(link.invite, 'url');
          })
          .catch((e) => {
            // 失败如实提示并放弃(不外跳);服务端错误已归一中文
            toast((e && e.message) || '无法打开邀请链接');
          })
          .finally(() => {
            resolveBusyRef.current = false;
          });
        return;
      }
      if (link.kind !== 'jump') {
        openExternal(raw, kindArg);
        return;
      }
      const anchorValue = link.msgId > 0 ? String(link.msgId) : '';
      if (link.peerKey) {
        if (link.peerKey === id) {
          if (link.msgId > 0) jumpTo(link.msgId); // 同会话:原位滚到该消息
          return;
        }
        router.push({ pathname: '/telegram/chat/[id]', params: { id: link.peerKey, anchor: anchorValue } });
        return;
      }
      if (link.domain) {
        if (resolveBusyRef.current) return; // /resolve 在途:吞掉连点,不排队
        resolveBusyRef.current = true;
        api('telegram', 'resolve', { domain: link.domain })
          .then((res) => {
            if (!res || !res.peerKey) throw new Error('无法识别该链接');
            router.push({
              pathname: '/telegram/chat/[id]',
              params: { id: String(res.peerKey), name: res.name || '', kind: res.kind || '', anchor: anchorValue },
            });
          })
          .catch((e) => {
            // 失败如实提示并放弃(不外跳);服务端错误已归一中文
            toast((e && e.message) || '无法打开链接');
          })
          .finally(() => {
            resolveBusyRef.current = false;
          });
      }
    },
    [id, jumpTo, router, openExternal, toast]
  );

  // —— 内联键盘回调:POST /callback → answer 三通道(message 轻提示 /
  //    alert 弹 Dialog / url 走 openUrl 分流)+ 用返回的 message 原位重渲;
  //    成功后无论快照是否已带来可见变化,都再安排一次兜底同步(见
  //    scheduleCallbackSync) ——
  const doCallback = useCallback(
    async (msgId, payload) => {
      try {
        const res = await postJson('/api/telegram/callback', {
          peer: id,
          msgId,
          data: payload && payload.data,
          game: !!(payload && payload.game),
        });
        const ans = res && res.answer;
        if (ans && ans.alert) {
          // alert 只是「弹窗而非轻提示」的布尔标记,文案在 message;缺文案兜底通用提示
          setAlertText(String(ans.message || '操作已完成'));
        } else if (ans && ans.message) {
          toast(String(ans.message));
        }
        if (ans && ans.url) {
          openUrl(String(ans.url), 'url');
        }
        if (res && res.message) replaceMessage(res.message);
        scheduleCallbackSync(msgId); // 迟到的 bot 编辑最终落地后的补同步(一次性)
      } catch (e) {
        toast((e && e.message) || '操作失败,请重试');
      }
    },
    [id, replaceMessage, scheduleCallbackSync, openUrl, toast]
  );

  // —— 投票:POST /vote → 用返回的 message 原位重渲(reject 供 PollCard
  //    收尾 busy;失败如实 toast,不自动重试) ——
  const doVote = useCallback(
    async (msgId, options) => {
      try {
        const res = await postJson('/api/telegram/vote', { peer: id, msgId, options });
        if (res && res.message) replaceMessage(res.message);
      } catch (e) {
        toast((e && e.message) || '投票失败,请重试');
        throw e;
      }
    },
    [id, replaceMessage, toast]
  );

  // —— bot 回复键盘:取最新一条带 replyKeyboard 的消息(未被清除前持续生效) ——
  const replyKeyboard = useMemo(() => {
    for (const m of items || []) {
      if (m && m.replyKeyboard && Array.isArray(m.replyKeyboard.rows) && m.replyKeyboard.rows.length) {
        return m.replyKeyboard;
      }
    }
    return null;
  }, [items]);

  // —— 行渲染(回调跨渲染尽量稳定:全部动作经 ref/稳定 useCallback 注入;
  //     A/B 两后端共用同一渲染器) ——
  const renderRow = useCallback(
    ({ item }) => {
      if (!item) return null;
      if (item.t === 'date') return <DateDivider date={item.date} />;
      if (item.t === 'unread') {
        // 未读分隔线可点:跳到未读起点(统一导航;出窗口自动重锚定)
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="跳到未读消息"
            onPress={() => {
              const u = unreadAnchorRef.current;
              if (u > 0) jumpTo(u);
            }}
          >
            <UnreadDivider />
          </Pressable>
        );
      }
      const m = item.msg;
      // 搜索命中当前结果:相册行按成员 id 命中(合流行 lead 可能不是命中成员)
      const searchHit = searchActive && searchHitId > 0
        && (m.id === searchHitId
          || (Array.isArray(item.memberIds) && item.memberIds.indexOf(searchHitId) !== -1));
      return (
        <View style={{ marginVertical: 1.5 }}>
          <MessageBubble
            msg={m}
            album={item.album}
            showSender={item.showSender}
            showAvatar={item.showAvatar}
            mergeTop={item.mergeTop}   // 运行组合并角(§2.3-③;气泡四态角半径消费)
            mergeBottom={item.mergeBottom}
            status={m.id < 0 ? (m.__status === 'pending' ? 'sending' : 'failed') : null}
            // 已读双勾呈现(§5.7):own 真实消息按 peer.readOutboxMaxId 推导;
            // 数据缺失(首屏 MTProto 无该字段)恒 sent 单勾,不猜
            readState={m.out && m.id > 0 ? (readOutboxMaxId >= m.id ? 'read' : 'sent') : undefined}
            highlight={searchHit} // 搜索高亮(气泡内与多选态互斥)
            onUrl={openUrl}
            onReplyTap={jumpTo}
            onReply={startReply}
            onRetry={retryOne}
            onOpenVideo={openVideo}
            onVote={(opts) => doVote(m.id, opts)}
            onCallback={(payload) => doCallback(m.id, payload)}
            onHint={toast}
            viewerTitle={title}
            onLongPress={(msg) => {
              if (!msg) return;
              if (selectionActive) toggleSelect(msg);
              else setMenuTarget(msg);
            }}
            selectionActive={selectionActive}
            selected={selectionActive && selection.indexOf(m.id) !== -1}
            onToggleSelect={toggleSelect}
            onMention={(v) => setEntityMenu({ kind: 'mention', value: v })}
            onHashtag={(tag) => activateSearch(tag)} // #tag 直达:激活搜索态并预填(不再弹菜单)
            onBotCommand={(cmd) => setEntityMenu({ kind: 'command', value: cmd })}
          />
        </View>
      );
    },
    [jumpTo, startReply, retryOne, openVideo, doVote, doCallback, openUrl, toast, title, readOutboxMaxId,
      selectionActive, selection, toggleSelect, searchActive, searchHitId, activateSearch]
  );

  // 视觉顶部旧向态条(A 的 ListFooter=B 的宿主 footer,同位同语义)
  const topTail = (
    <TopTail loading={loadingOlder} err={olderErr} done={!hasOlder && !!rows.length} onRetry={onEnd} />
  );

  // 列表内容视觉样式(双后端共用;A 直配,B 经宿主合并——纵向留白走
  // LIST_EDGE_PAD/edgePadding,与 core 管理的 inset/hold 各管各的)
  const listContentStyle = useMemo(
    () => ({
      maxWidth: CHAT_MAX_W,
      width: '100%',
      alignSelf: 'center',
      paddingHorizontal: padH,
    }),
    [padH]
  );

  // —— 调试菜单(M4 通用容器,§2.6 调试入口):标题长按出「切换聊天历史
  //     后端」;label 文案与切换目标取自 telegram-history 工具(页面无
  //     kind 字面量),切换 = 写 setting + 外层换 key 重挂 ——
  const currentBackendLabel = backendKindLabel(coordinator.usesBackend);
  const debugMenuItems = useMemo(
    () => [
      {
        key: 'switch-history-backend',
        label: '切换聊天历史后端(当前:' + currentBackendLabel + ')',
        onPress: () => {
          setDebugMenuOpen(false);
          onSwitchBackend(switchBackendKind(coordinator.usesBackend));
        },
      },
    ],
    [currentBackendLabel, coordinator, onSwitchBackend]
  );

  // —— 消息流主体:骨架 / 首屏失败 / 空会话 / 时间线(按 usesBackend 分支;
  //     一切后端相关分支只读 coordinator.usesBackend,§2.3-1 防重推) ——
  const body = (() => {
    if (id == null) {
      return (
        <ErrorState message="对话 ID 无效" />
      );
    }
    if (loading) {
      return <ChatSkeleton />;
    }
    if (err && items == null) {
      return (
        <View style={{ flex: 1 }}>
          <ErrorState message={err} onRetry={() => loadInitial()} />
          {/* 未登录:错误态之上加「去登录」(完成登录 back 回本页自动重拉) */}
          {needLogin ? (
            <View style={{ alignItems: 'center', marginTop: -48 }}>
              <Button size="sm" onPress={goLogin}>去登录</Button>
            </View>
          ) : null}
        </View>
      );
    }
    if (!rows.length) {
      return (
        <EmptyState icon={Send} title="暂无消息" desc={peer && peer.canSend === false ? '该对话还没有任何消息' : '发送第一条消息,开始对话'} />
      );
    }
    if (coordinator.usesBackend === BACKEND_VIRTUAL) {
      // 后端 B:虚拟列表宿主(窗口渲染/量测/滚动内聚在宿主+core)
      return (
        <VirtualHistoryHost
          backend={backend}
          renderRow={renderRow}
          footer={topTail}
          contentContainerStyle={listContentStyle}
          edgePadding={LIST_EDGE_PAD}
          onMounted={markMounted}
        />
      );
    }
    // 后端 A:FlatList(行为配置全部来自后端 getListProps,页面不直配——
    // inverted/mVCP/可见集/onScroll/onEndReached/onScrollToIndexFailed 内聚)
    return (
      <FlatList
        ref={listRef}
        data={backendRows}
        keyExtractor={(r) => (r ? r.key : 'x')}
        renderItem={renderRow}
        ListFooterComponent={topTail}
        onLayout={markMounted}
        contentContainerStyle={[listContentStyle, { paddingTop: LIST_EDGE_PAD, paddingBottom: LIST_EDGE_PAD }]}
        {...backend.getListProps()}
      />
    );
  })();

  // 悬浮「回到底部」FAB:时间线就绪且不在底部时显示(贴右下、输入区上方;
  // 追平转圈只跟随 loadNewer 在途态,循环被卡住时按钮仍可重点重入)
  const fab = rows.length && !atBottom ? (
    <BackToBottomFab
      count={unreadCount}
      dot={hasNewer && unreadCount <= 0}
      loading={loadingNewer}
      onPress={onFab}
    />
  ) : null;

  // 输入区:频道(canSend=false)只留「频道仅广播」提示;否则 bot 回复键盘条 +
  // 受控输入条。键盘可见时 paddingBottom 去掉壳层避让(chrome.bottom)只留小
  // 间距;Android 另垫 hook 的键盘高度(edge-to-edge 下系统 resize 不可靠),
  // iOS 由外层 KAV 整体抬升;键盘收起恢复壳层避让;web 恒走壳层避让分支
  const inputPadBottom = !kb.visible
    ? 8 + chrome.bottom
    : (Platform.OS === 'android' ? 8 + kb.height : 8);

  // 输入区:多选态=SelectionBar 动作条(§5.1-C,覆盖输入条);其余=编辑条
  // (§3.3)/bot 回复键盘条 + 受控输入条;频道只广播提示照旧
  const composerArea = selectionActive ? (
    <SelectionBar
      count={selection.length}
      busy={actionBusy}
      onSelectAll={selectAllLoaded}
      onForward={() => dispatchC({ type: 'setForward', ids: selection })}
      onDelete={() => setDeleteTarget({ ids: selection.slice(), revoke: kind === 'group' || kind === 'saved', multi: true })}
      onExit={() => dispatchC({ type: 'clearSelection' })}
    />
  ) : (
    <>
      {peer && peer.canSend === false ? (
        <View style={{ alignItems: 'center', paddingVertical: 10 }}>
          <Text style={{ fontSize: 12, color: p.muted, includeFontPadding: false }}>频道仅广播,不能发送消息</Text>
        </View>
      ) : (
        <>
          {editTarget ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 6 }}>
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: p.link, includeFontPadding: false }}>
                正在编辑消息
              </Text>
              <Button variant="ghost" size="sm" onPress={cancelEdit} accessibilityLabel="取消编辑">
                <Close size={12} color={p.muted} />
                <Text style={{ fontSize: 12, color: p.muted }}>取消编辑</Text>
              </Button>
            </View>
          ) : null}
          {replyKeyboard ? (
            <ReplyKeyboardBar keyboard={replyKeyboard} onPick={pickQuick} style={{ marginBottom: 6 }} />
          ) : null}
          <ChatComposer
            value={input}
            onChangeText={setInput}
            onSend={doSend}
            sending={sending}
            reply={replyTo}
            onCancelReply={() => setReplyTo(null)}
            placeholder={(replyKeyboard && replyKeyboard.placeholder) || '发送消息'}
          />
        </>
      )}
    </>
  );

  return (
    <View style={{ flex: 1, backgroundColor: p.background, paddingTop: 8 + chrome.top }}>
      {/* 头部(固定,不随消息滚动/键盘避让):搜索态=官方式会话内搜索(搜索条+
          结果导航条,整体替换本行;蓝图 §5.3-B 官方式改版);常规态=返回+「头像+
          名称/kind 徽标」(点按进共享媒体面板)+搜索+刷新;实测高度供 KAV 的
          keyboardVerticalOffset 用。头像+标题区长按 = 聊天历史后端调试菜单
          (无入口暗示,普通用户不可见) */}
      <View
        onLayout={(e) => {
          const h = e.nativeEvent.layout.height;
          setHeaderH((prev) => (Math.abs(prev - h) > 0.5 ? h : prev));
        }}
        style={{ paddingHorizontal: padH, marginBottom: 6 }}
      >
        {searchActive ? (
          <ChatSearchHeader
            value={searchText}
            onChange={setSearchText}
            onSubmit={() => searchStep(1)}        // 回车=下一条结果(官方语义)
            onCancel={exitSearch}                 // 取消/关闭:退出恢复原头部
            onCalendar={openCalendar}             // 日历图标:按日期跳转入口
            globalActive={searchGlobal}
            onToggleGlobal={() => setSearchGlobal((v) => !v)}
            showNav={!searchGlobal}               // 本会话/全局两态互斥
            onPrev={() => searchStep(-1)}
            onNext={() => searchStep(1)}
            counter={searchCounter}
            loading={searchPhase === 'loading' || searchMoreBusy}
            err={searchErr}
            onRetry={searchRetry}
            onInputFocusChange={(f) => { searchInputFocusRef.current = f; }}
          />
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Button variant="ghost" size="icon" onPress={back} accessibilityLabel="返回">
              <ChevronLeft size={22} color={p.foreground} />
            </Button>
            {/* 头像+标题区:点按进共享媒体面板;长按 = 聊天历史后端调试菜单
                (无入口暗示,普通用户不可见) */}
            <Pressable
              onPress={openMedia}
              onLongPress={() => setDebugMenuOpen(true)}
              delayLongPress={400}
              accessibilityRole="button"
              accessibilityLabel="对话标题(打开共享媒体面板;长按打开调试菜单)"
              {...titleHv.binds}
              style={[
                { flex: 1, minWidth: 0, marginLeft: 2, flexDirection: 'row', alignItems: 'center', gap: 8 },
                { opacity: titleHv.pressed ? 0.7 : 1 },
              ]}
            >
              <TgAvatar uri={avatarSrc} name={title} size={34} />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
                <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 16, fontWeight: '600', color: p.foreground }}>
                  {title}
                </Text>
                {/* typing 呈现(TD 引擎事件面):头部副题位被「正在输入」顶替,
                    TI 同款;MTProto 引擎恒无该事件,恒显 kind 徽标 */}
                {typingSenders.length ? (
                  <Text numberOfLines={1} style={{ fontSize: 12, color: p.link, includeFontPadding: false }}>
                    对方正在输入…
                  </Text>
                ) : (
                  <KindBadge kind={kind} />
                )}
              </View>
            </Pressable>
            <Button variant="ghost" size="icon" onPress={() => activateSearch('')} accessibilityLabel="搜索消息">
              <Search size={16} color={p.foreground} />
            </Button>
            <Button variant="ghost" size="icon" onPress={refresh} accessibilityLabel="刷新消息">
              <Restart size={16} color={p.foreground} />
            </Button>
          </View>
        )}
      </View>

      {/* 全局公开帖段(全局态内嵌,复用列表页同款 GlobalSearchSection,段内自
          防抖/分页/错误呈现;#词限定,点结果跳对应会话——同列表页现行为);
          上限 45% 高度内滚动,聊天流仍在原位 */}
      {searchActive && searchGlobal ? (
        <View style={{ maxHeight: '45%', paddingHorizontal: padH, marginBottom: 6 }}>
          <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
            {searchIsTag ? (
              <GlobalSearchSection query={searchQ} onOpenMessage={openGlobalResult} />
            ) : (
              <Text style={{ fontSize: 12, color: p.muted, paddingVertical: 10, includeFontPadding: false }}>
                全局搜索仅支持 #话题;请输入以 # 开头的话题词
              </Text>
            )}
          </ScrollView>
        </View>
      ) : null}

      {/* 置顶条(§5.3-E):chat-header 的 pinnedMessageId 驱动;点击跳转、× 取消置顶。
          摘要尽力取已载窗口消息,取不到只显「置顶消息」标签;搜索态隐藏(头部
          已整体替换为搜索条)。药丸容器为普通 View、跳转/取消置顶两个 Pressable
          平级不嵌套——web 端 role=button 渲染成真 <button>,HTML 禁 button 嵌
          button(非法 DOM+水合报错) */}
      {!searchActive && pinnedMessageId > 0 ? (
        <View style={{ paddingHorizontal: padH, marginBottom: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 10, backgroundColor: p.surface, borderWidth: 1, borderColor: p.line }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="查看置顶消息"
              onPress={() => jumpTo(pinnedMessageId)}
              style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}
            >
              <Pin size={12} color={p.link} />
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: p.muted, includeFontPadding: false }}>
                {(pinnedMsg && String(pinnedMsg.text || '').trim()) || (pinnedMsg && pinnedMsg.media ? '[媒体消息]' : '置顶消息')}
              </Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="取消置顶" hitSlop={8}
              onPress={() => runPin({ id: pinnedMessageId }, true)}>
              <Close size={13} color={p.muted} />
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* 键盘避让只作用于头部以下主体:iOS KAV behavior 'padding',
          keyboardVerticalOffset = 头部以上实际高度(根 paddingTop + 头部实测高
          + 头部下边距)——KAV 的自身量测相对本 wrapper,须补上与屏幕顶的距离,
          避让量才精确等于键盘高度(不多垫出头部那截);Android/web behavior
          留空(KAV 退化为普通 View),Android 由输入区手动垫 hook 高度 */}
      <View style={{ flex: 1, minHeight: 0 }}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={kbBehavior} keyboardVerticalOffset={8 + chrome.top + headerH + 6}>
          {/* 消息流 + 悬浮 FAB */}
          <View style={{ flex: 1, minHeight: 0 }}>
            {body}
            {fab}
          </View>

          {/* 输入区(实测高度供 toast 定位;键盘弹起时 iOS 随 KAV 整体上移、
              Android 随 paddingBottom 变高,toast 跟随) */}
          <View
            onLayout={(e) => {
              const h = e.nativeEvent.layout.height;
              setInputAreaH((prev) => (Math.abs(prev - h) > 0.5 ? h : prev));
            }}
            style={{ paddingHorizontal: padH, paddingTop: 4, paddingBottom: inputPadBottom }}
          >
            {composerArea}
            {/* 页内轻提示:胶囊浮在输入区上方一条带内(useHint 自管 1.8s 自动
                消失);bottom 跟随输入区实测高度(回复键盘条/多行撑高/键盘垫高) */}
            {toastOverlay ? (
              <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: inputAreaH + 8, height: 44 }}>
                {toastOverlay}
              </View>
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </View>

      {/* bot 回调 alert(answer.alert 通道):Dialog 弹层如实展示 */}
      <Dialog visible={!!alertText} onClose={() => setAlertText('')} title="Telegram">
        <Text style={{ fontSize: 14, lineHeight: 20, color: p.muted }}>{alertText}</Text>
        <View style={{ marginTop: 16, flexDirection: 'row', justifyContent: 'flex-end' }}>
          <Button size="sm" onPress={() => setAlertText('')}>知道了</Button>
        </View>
      </Dialog>

      {/* 消息日历(M3 件,§5.3-C 契约):按日跳转走统一导航(onJump →
          jumpTo → 窗口内滚动/窗口外重锚定);端点契约错误在面板内呈现;
          入口=搜索条日历图标(搜索态;常规头部的「日历」钮已随共享媒体
          面板改版移除,日历浏览入口改走媒体面板的媒体日历) */}
      <CalendarPanel
        peer={id || ''}
        visible={calendarOpen}
        onClose={() => setCalendarOpen(false)}
        onJump={handleCalendarJump}
        initialMonth={calendarMonth}
      />

      {/* 转发面板(M5,§5.4):forward 态驱动按需挂载(每次打开即全新面板);
          onDone 只清态(成功 toast 由面板经 onHint 透传),目标多选瞬态不持久 */}
      {cstate.forward ? (
        <ForwardPanel
          visible
          fromPeer={id || ''}
          msgIds={cstate.forward.ids}
          abilities={forwardAbilities(cstate.forward.ids, items || [])}
          initialOptions={{ hideNames: !!cstate.forward.hideNames, hideCaptions: !!cstate.forward.hideCaptions }}
          onOptionsChange={(o) => dispatchC({ type: 'updateForwardOptions', ...o })}
          onHint={toast}
          onClose={() => dispatchC({ type: 'clearForward' })}
          onDone={() => dispatchC({ type: 'clearForward' })}
        />
      ) : null}

      {/* 消息主菜单(M4 通用容器,§5.1-C):buildMessageMenuFor 编目 */}
      <ContextMenu visible={!!menuTarget} onClose={() => setMenuTarget(null)} items={menuItems} />

      {/* 内容类型专属菜单(§3.4):提及/话题/命令三 builder */}
      <ContextMenu visible={!!entityMenu} onClose={() => setEntityMenu(null)} items={entityItems} />

      {/* 删除确认(§4.2-⑧:单条/多条共用;revoke 可用才出「为所有人删」) */}
      <Dialog visible={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="删除消息">
        <Text style={{ fontSize: 14, lineHeight: 20, color: p.muted }}>
          {deleteTarget && deleteTarget.multi
            ? '删除选中的 ' + deleteTarget.ids.length + ' 条消息?' + (deleteTarget.revoke ? '(可同时为所有人删除)' : '')
            : '删除这条消息?' + (deleteTarget && deleteTarget.revoke ? '(可同时为所有人删除)' : '')}
        </Text>
        <View style={{ marginTop: 16, flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
          <Button size="sm" variant="secondary" onPress={() => setDeleteTarget(null)}>取消</Button>
          {deleteTarget && deleteTarget.revoke ? (
            <Button size="sm" onPress={() => { const t = deleteTarget; setDeleteTarget(null); runDelete(t.ids, true); }}>为所有人删</Button>
          ) : null}
          <Button size="sm" onPress={() => { const t = deleteTarget; setDeleteTarget(null); runDelete(t.ids, false); }}>删除</Button>
        </View>
      </Dialog>

      {/* 聊天历史后端调试菜单(M4 通用容器,§2.6):受控 items */}
      <ContextMenu visible={debugMenuOpen} onClose={() => setDebugMenuOpen(false)} items={debugMenuItems} />
    </View>
  );
}
