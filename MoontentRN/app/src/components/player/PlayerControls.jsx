// ============================================================================
// PlayerControls.jsx —— 播放器统一控件层(两端共用,纯 UI + 手势)
// ----------------------------------------------------------------------------
// 由 VideoPlayer.web.js / VideoPlayer.js 两端各自喂「状态 + 动作」,本组件只管
// 呈现与交互,不持有任何播放内核。形态彻底对齐 YouTube:
//   - 顶部无标题(YouTube 播放器 chrome 不在顶部放片名;title prop 保留向后
//     兼容但不再渲染);
//   - 窄幅(手机 inline,实测宽 <500):YouTube 移动端形态——
//       · 单击切控件显隐;双击左/右 1/3 快退/快进 10 秒(带涟漪反馈 pill),
//         双击中间播放/暂停;
//       · 暂停/播完时中央大钮;底部一行 = 当前时间 · 进度条 · 总时长 · 全屏钮
//         (无成排功能钮,这是「像 YouTube」的关键);
//       · 倍速/看板/(web)音量收进顶右小图标排(控件可见时才出现);
//   - 表面手势(腾讯/爱奇艺同款;承载面两端常驻——RNW 的 PanResponder 同样
//     响应鼠标,桌面按住画面横拖也能调进度;tap 语义按 isTouch 分流:触屏
//     单击切控件/桌面单击播放暂停,双击判定不变):
//       · 左半长按 = 持续快退(200ms×1s ≈5×),右半长按 = 按住 2× 倍速
//         (松手还原原速);长按锁死后明显横移 = 结束长按转调进度(慢起步
//         横拖不被长按计时锁死,倍速先还原);
//       · 按住左右拖 = 调进度(拖满表面宽 ≈±120 秒,中央 HUD + 进度条红条/
//         拇指/时间气泡双路实时回显「松手会到哪」,松手一次 seek,不逐帧跳;
//         seekTo 乐观落位,松手后进度条不闪回旧位);
//       · 左半上下滑 = 亮度(onSetBrightness 缺省则禁用),右半上下滑 = 音量;
//       · 未触发任何手势的轻点回落到单击/双击判定(原行为不变);
//   - 宽幅(桌面 web / 大窗,≥500):桌面播放器控制条(站方播放窗形态,腾讯视频
//     同款)——三行:进度条通栏 / 时间(左) / 按钮行,左起 [播放][下一集],右起
//     [选集][倍速][音量][看板][设置][小窗][全屏];web 双击表面切全屏、
//     单击直接播放/暂停(YouTube 桌面行为);±10s 不上条(桌面按住画面横拖即调
//     进度、双击左右区仍 ±10s);
//   - 桌面专属钮的数据通路:下一集/选集/小窗经 player-chrome 注入通道由观看页
//     供数(见 lib/player-chrome.js 文件头),字段缺席即整钮不渲染——首页迷你
//     浮层等无观看页上下文的场景与改动前完全一致;小窗播放=舞台缩小成应用内
//     悬浮小窗+一次性清栈回首页(原浏览器画中画钮位已由它取代——系统级 PiP
//     浮窗没有本应用的控件与状态;Chromium 仍可右键 video 走原生画中画);
//     设置菜单(PlayerMenu)读 settings.js 持久化键(自动连播/播放窗口);
//   - 进度条:播放位置(白)/已缓冲(白 30%)/拖拽 seek(拖拽中浮时间气泡);
//   - 弹层(倍速/音量/设置)双形态:桌面壳(Electron,非全屏)浮出为独立菜单
//     子窗(腾讯视频形态,不被播放器表面 overflow 裁剪——小窗播放也放得下;
//     建窗/摆位在 desktop/main.js,owner 侧接线在 lib/menu-window.js);浏览
//     器/原生/全屏回落窗口内弹层(PlayerPopup 家族)。悬停即开(倍速/音量),
//     移出热区宽限自动收(独立窗=主进程中央定时器,本地=MENU_CLOSE_GRACE_MS),
//     点空白/选档/控件收起即收;
//   - 音量(web 独有:图标开关静音 + 悬停弹出横条拖动调音量,条端百分比实时
//     显示;native 走系统音量);
//   - 全屏(动作由两端实现:web 容器 requestFullscreen,native 应用内全屏——
//     Provider 注入 fullscreen/onToggleFullscreen,观看页沉浸布局+按画幅锁方向);
//   - 看板(可选):把当前视频加入「视频大屏看板」(wall-store),加入成功图标
//     短暂变 WallAdded 填充形 ~1.5s 作本地反馈;两条供血路径——onAddWall prop 优先(缺省
//     不渲染该钮,向后兼容),否则兜底读 wall-store 的看板入口注入(观看页注册
//     的候选提供器,详见 wall-store.js 文件头;注入通道因 PlayerControls 嵌在
//     VideoPlayer 内层、prop 无法从观看页直达而设,语义与 NextWeb ArtPlayer 的
//     看板入口一致:加入不自动打开看板、迷你态不注入);
//   - 倍速:弹出六档菜单(0.5~2x),当前档整行提亮(锚定倍速钮旁);
//   - 加载 spinner(内核缓冲中)/错误重试浮层(如实显示错误信息 + 重试钮);
//   - 自动静音兜底 pill(web 自动播放被拦时「点按取消静音」);
//   - 自动静藏:播放中 3s 无操作收起;暂停/播完/出错控件常驻。
// YouTube 风格:播放器 chrome 恒深色(不随主题翻转)、无描边扁平、功能图标 24px;
// 强调色白色系(播放器整体去红口径:进度/在用倍速档/激活图标/开关全白,红只
// 留给错误语义——ERROR_RED)。
// 实现 note:按钮组/进度条用「工厂函数返回 JSX」而非内嵌组件——本组件随播放
// 进度高频重渲(每拍 currentTime 更新),内嵌组件定义会让整组 Pressable 每拍
// 换类型重挂载(按压态丢失 + 无谓 diff);工厂函数返回的就是 Pressable 元素树,
// 类型恒定不重挂。
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  PanResponder,
  Platform,
  Pressable,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Forward, Speed, Playlist, FullscreenEnter, FullscreenExit, WallAdd, WallAdded, Pause, Pip, Play, Rewind, Restart, Settings, Next, Sun, Alert, VolumeUp, VolumeOff } from '../icons.js';
import { fmtDur } from '../../lib/utils.js';
import { addToWall, removeFromWall, useWallEntry, useWallItems } from '../../lib/wall-store.js';
import { usePlayerChrome } from '../../lib/player-chrome.js';
import { useIsDesktopApp, menuWindow, winControls } from '../../lib/desktop-bridge.js';
import { openMenuWindow, prewarmMenuWindow } from '../../lib/menu-window.js';
import { getSettingsSnapshot, setSetting } from '../../lib/settings.js';
import { setMiniWindow, useMiniWindow } from '../../lib/mini-window-store.js';
import PlayerMenu from './PlayerMenu.jsx';
import { PlayerPopup, PlayerPopupRow, RATES_DESC } from './PlayerPopup.jsx';
import GlassSurface from '../ui/GlassSurface.jsx';
import GlassGroup from '../ui/GlassGroup.jsx';
import { DIMMING, SPACING, RADIUS, FLOAT_SHADOW } from '../../lib/higlass.js';

// ===== 常量(YouTube 同款体感值)=====
const ERROR_RED = '#ff0000'; // 错误三角的语义红（播放器整体去红口径下唯一保留：
//                            进度条/在用倍速档/激活图标/开关一律白色系，红只表达「出错」）
const AUTO_HIDE_MS = 3000; // 控件自动隐藏延时(播放中无操作)
const DBL_TAP_MS = 300; // 双击判定窗口(毫秒)
const ICON = 24; // 功能图标统一 24px(README 图标规格)
// 倍速六档展示序（站方形态：由快到慢自上而下）——与菜单独立子窗共用，
// 定义在 PlayerPopup.jsx（弹层家族共享口径）
const MENU_CLOSE_GRACE_MS = 500; // 窗口内弹层移出自动收起的宽限(钮↔面板穿行
//                                不断流;宁晚收勿早收——没移到面板就被收掉最伤手感)
const VOL_W = 96; // 音量条宽(数值驱动填充宽度)
const WIDE_W = 500; // 宽幅阈值:≥500 走 YouTube 桌面控制条,否则移动端形态
const RIPPLE_MS = 700; // 双击 ±10s 涟漪反馈 pill 停留时长
// ===== 沉浸态悬浮底条几何(对齐 AppShell 底部浮动 tab bar 形态) =====
// 沉浸态(应用内全屏/手机横屏 landfs)底条整条收进安全区悬浮:底缘 = 安全区外
// 再抬 FLOAT_GAP(避让 Home 指示条),两侧 = 左右安全区(横屏刘海/圆角)外再留
// FLOAT_SIDE;常态舞台锚在页面内,insets 恒 0,贴底满宽行为不变。观看页选集
// 浮层的 bottomPad 与此同口径(见 video/[site]/[id].js)
export const FLOAT_GAP = 10;
export const FLOAT_SIDE = 12;
// 悬浮外观:玻璃端 control 档圆角 + 浮动补强阴影;降级端同圆角深色半透明底
// (悬浮态不再裸压画面)
const FLOAT_BAR_GLASS = { borderRadius: RADIUS.control, overflow: 'hidden', boxShadow: FLOAT_SHADOW };
const FLOAT_BAR_FALLBACK = { borderRadius: RADIUS.control, backgroundColor: 'rgba(0,0,0,0.72)' };
// ===== 触屏手势体感值(腾讯/爱奇艺同款量级)=====
const LP_MS = 350; // 长按判定延时(超时未位移 → 触发长按手势)
const LP_SLOP = 10; // 位移阈值(超此值先于长按 → 判轴进横拖/竖滑)
const GEST_REW_STEP = 1; // 左长按快退步长(秒/次)
const GEST_REW_MS = 200; // 快退步进间隔(200ms×1s ≈ 5× 倒退)
const GEST_LP_RATE = 2; // 右长按临时倍速档
const GEST_MIN_BRIGHT = 0.05; // 亮度下限(0 会全黑像死机)
const HUD_BAR_H = 150; // 竖滑 HUD 竖条高(亮度/音量)

export default function PlayerControls({
  playing = false,
  loading = false,
  ended = false,
  currentTime = 0,
  duration = 0,
  buffered = 0,
  rate = 1,
  volume = 1,
  brightness = null, // 当前亮度(0~1;null=端侧不支持,亮度手势随之禁用)
  muted = false,
  fullscreen = false,
  rotated = false, // web 伪全屏 CSS 旋转态(iPhone Safari 横幅视频):PanResponder
                   // 的 dx/dy 是屏幕坐标,旋转层内手势轴需对调(容器 x↔屏幕 y)
  edgeToEdge = false, // 舞台 edge-to-edge 沉浸态(全屏钮或手机横屏 landfs):
                      // 安全区由本层自垫(顶右功能排/底行/弹出层锚位)
  canVolume = false, // 仅 web:true(native 音量归系统)
  autoMuted = false, // 自动静音兜底中(web)
  error = '',
  title = '', // 已不渲染(YouTube 形态顶部无标题);保留 prop 向后兼容
  onToggle,
  onSeek,
  onSeekBy,
  onSetRate,
  onSetVolume,
  onSetBrightness, // 可选:亮度手势动作(缺省则左半竖滑禁用);两端各自实现
                   // (web=视频区遮罩变暗,native=expo-brightness 系统亮度)
  onToggleMute,
  onUnmute,
  onToggleFullscreen,
  onRetry,
  onAddWall, // 可选:加入看板动作(() => boolean,成功返回 true);缺省时兜底读
             // wall-store 的看板入口注入,两者皆无则不渲染看板钮(向后兼容)
}) {
  const [visible, setVisible] = useState(true); // 控件显隐(单击切换/自动隐藏)
  const [dragT, setDragT] = useState(null); // 进度条拖拽中的位置(秒;null=非拖拽)
  // 弹出层单开:null | 'rate' | 'vol' | 'settings'(互斥,开一关余;
  // 此前是 rateOpen/volOpen 两个布尔,新增设置后收敛为单状)
  const [menu, setMenu] = useState(null);
  // 独立菜单子窗开着:'rate'|'vol'|'settings'|null(桌面壳专用——菜单浮出为
  // 独立小窗,与上面的窗口内 menu 互斥:独立窗路径 menu 恒 null)
  const [menuWinKind, setMenuWinKind] = useState(null);
  // 本地弹层右缘距播放器右缘的偏移(打开时实测触发钮位置,面板右缘对齐钮右
  // 缘;独立窗路径不用——主进程按锚点屏幕坐标摆窗)
  const [menuAnchorRight, setMenuAnchorRight] = useState(8);
  const [barW, setBarW] = useState(0); // 进度条实测宽(渲染定位拇指/气泡用)
  const [wallAdded, setWallAdded] = useState(false); // 加入看板成功的 WallAdded 填充反馈态(~1.5s)
  const [surfW, setSurfW] = useState(0); // 播放器表面实测宽(宽/窄形态与双击分区用)
  const [ripple, setRipple] = useState(null); // 双击 ±10s 反馈 pill:{dir:-1|1,k:时间戳}
  const [hud, setHud] = useState(null); // 触屏手势 HUD:{type:'seek'|'rew'|'rate'|'bright'|'vol',...}
  const wide = surfW >= WIDE_W; // 形态:窄=YouTube 移动端 / 宽=YouTube 桌面
  // 底部安全区(native 应用内全屏时底行垫 Home 指示条;web/非全屏恒 0 不影响)
  const insets = useSafeAreaInsets();
  // 沉浸态(舞台 edge-to-edge)安全区垫层:观看页沉浸分支已不垫安全区(视频
  // letterbox/裁切吸收刘海),顶右功能排/窄幅弹出层锚位/底行在此自避让;
  // 常态舞台锚在页面内,垫层为 0 视觉不变
  const padTop = edgeToEdge ? insets.top : 0;
  const padRight = edgeToEdge ? insets.right : 0;
  // 沉浸态悬浮底条整体抬升量(底缘安全区+留白):宽幅弹层/静音 pill 的底部
  // 锚位跟随(锚在 wrapper 边缘=播放器边缘,不随底条 margin 走,需手动补)
  const barLift = edgeToEdge ? insets.bottom + FLOAT_GAP : 0;
  // 沉浸态底条悬浮几何(margin 挂在底条本体——普通流子元素,玻璃/降级两端
  // 一致生效;弹层是 absolute 锚 wrapper 边缘,不受 margin 影响)
  const floatBarStyle = edgeToEdge
    ? {
        marginBottom: insets.bottom + FLOAT_GAP,
        marginLeft: insets.left + FLOAT_SIDE,
        marginRight: insets.right + FLOAT_SIDE,
      }
    : null;

  // 触屏判定(native 恒 true;web 以 pointer:coarse 识别手机/平板浏览器,
  // 另以一次性 touchstart 兜住「主指针是鼠标」的触屏笔记本/Electron 触屏)。
  // web 首帧恒 false(SSG 水合对齐,#418 同款),挂载 effect 后放行真实值——
  // 仅影响 tap 语义分流(触屏=切控件,桌面=播放/暂停);手势承载面两端常驻
  const [isTouch, setIsTouch] = useState(Platform.OS !== 'web');
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    try {
      if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
        setIsTouch(true);
      }
    } catch (_e) { /* matchMedia 不可用:按非触屏(桌面路径) */ }
    // pointer:coarse 只认「主指针」;触屏笔记本/桌面壳常主指针=鼠标 →
    // 真实触摸一到即翻真(once,鼠标路径永不触发)
    const onTouchStart = () => setIsTouch(true);
    window.addEventListener('touchstart', onTouchStart, { once: true, passive: true });
    return () => window.removeEventListener('touchstart', onTouchStart);
  }, []);

  // 看板入口注入(wall-store):观看页注册的候选提供器;与 onAddWall prop 二选一
  // 供血,prop 优先——本组件嵌在 VideoPlayer(.web).js 内层,观看页递不进 prop,
  // 注入通道是唯一接线(见 wall-store.js 文件头);两者皆无 → 不渲染看板钮
  const wallEntry = useWallEntry();
  const wallEntryRef = useRef(wallEntry);
  wallEntryRef.current = wallEntry;

  // 「已在看板」持久态:当前候选(注入提供器现算的 site/id)的 key 已在墙内时,
  // 看板钮常态显示填充形(WallAdded);点击转为移除(toggle:未在=添加 /
  // 已在=移除)——既消除「可反复加入」误感知,也补齐看板外的反向出口。
  const wallItems = useWallItems();
  let inWall = false;
  try {
    const cand = typeof wallEntry === 'function' ? wallEntry() : null;
    if (cand && cand.site != null && cand.id != null) {
      const candKey = String(cand.site) + ':' + String(cand.id);
      inWall = wallItems.some((x) => x && x.key === candKey);
    }
  } catch (_e) {
    /* 提供器读在播实例异常:不判定,按未在墙渲染 */
  }

  // 播放器 chrome 注入(观看页经 player-chrome 注册):下一集/选集——
  // 字段缺席即对应钮不渲染(首页迷你浮层等无观看页上下文的场景)。
  // 每次渲染现算(注册表变化由 useSyncExternalStore 触发重渲染),不做本地缓存
  const chrome = usePlayerChrome() || {};
  // 桌面壳识别与小窗态（小窗播放钮；挂载后查一次主进程对齐初值——播完关窗
  // 重开、或多窗场景，态由主进程持有，前端 store 只做镜像）
  const desktopApp = useIsDesktopApp();
  const miniWin = useMiniWindow();
  useEffect(() => {
    if (!desktopApp) return undefined;
    let alive = true;
    winControls.isMini().then((v) => {
      if (alive) setMiniWindow(v);
    });
    return () => {
      alive = false;
    };
  }, [desktopApp]);
  // 弹出层单状镜像:自动隐藏到点回调里读(菜单开着不收控件——用户正要点;
  // 独立菜单子窗开着同理)
  const menuRef = useRef(null);
  menuRef.current = menu;
  const menuWinKindRef = useRef(null);
  menuWinKindRef.current = menuWinKind;

  // ===== 菜单独立子窗(桌面壳):倍速/音量/设置浮出为独立小窗(腾讯形态) =====
  // 建窗/摆位/收起在 desktop/main.js 菜单会话区,owner 侧锚点换算在
  // lib/menu-window.js;此处接线:预热 + 动作回流 + 收起通知 + 状态反推。

  // 菜单内容快照(三类菜单共用;设置项同步读 settings 快照)
  const buildMenuState = useCallback(() => {
    let autoplay = true;
    let multi = false;
    try {
      const snap = getSettingsSnapshot() || {};
      autoplay = snap.autoplay !== false;
      multi = snap.playerWindow === 'multi';
    } catch (_e) {
      /* 快照读取异常:按默认值 */
    }
    return {
      rate,
      volume: muted ? 0 : volume,
      muted,
      canVolume,
      autoplay,
      multi,
    };
  }, [rate, volume, muted, canVolume]);

  useEffect(() => {
    if (!desktopApp) return undefined;
    // 预热:菜单窗提前整树启动,用户 hover 时零延迟(幂等)
    prewarmMenuWindow();
    // 动作回流:菜单窗选择 → 本窗落地。倍速/音量套现有回调;设置走 setSetting
    // 单一漏斗,应用后按已知新值反推快照刷新菜单窗(持久化广播是异步的,
    // 快照可能尚未跟上,直接按本次写入值构造)
    const offAction = menuWindow.subscribeAction(({ type, value, key } = {}) => {
      if (type === 'rate') {
        if (latest.current.onSetRate) latest.current.onSetRate(value);
      } else if (type === 'volume') {
        if (latest.current.onSetVolume) latest.current.onSetVolume(value);
      } else if (type === 'setting') {
        try {
          setSetting(key, value);
        } catch (_e) {
          /* 持久化异常:静默(菜单窗保持旧值,再点再试) */
        }
        const snap = buildMenuState();
        if (key === 'autoplay') snap.autoplay = value !== false;
        else if (key === 'playerWindow') snap.multi = value === 'multi';
        menuWindow.update(snap);
      }
    });
    // 收起通知:主进程已收菜单(宽限到点/选档/窗口动过),清开窗标记
    const offClosed = menuWindow.subscribeClosed(() => setMenuWinKind(null));
    return () => {
      offAction();
      offClosed();
    };
  }, [desktopApp, buildMenuState]);

  // 菜单开着时倍速/音量被手势等改动 → 主动反推快照(菜单跟随新值)
  useEffect(() => {
    if (desktopApp && menuWinKind) menuWindow.update(buildMenuState());
  }, [desktopApp, menuWinKind, buildMenuState]);

  // 控件收起(自动隐藏/单击切显隐)时联动收菜单窗(收起回执里清 menuWinKind)
  useEffect(() => {
    if (!visible && menuWinKind) menuWindow.hide();
  }, [visible, menuWinKind]);

  const dragTRef = useRef(null); // dragT 的同步镜像(释放时读,不等 setState)
  const barWRef = useRef(0); // 进度条宽镜像(PanResponder 换算用)
  const barXRef = useRef(0); // 进度条在页面上的 x(gestureState.pageX 换算用)
  const volWRef = useRef(0); // 音量条宽
  const volXRef = useRef(0); // 音量条页面 x
  const lastTapRef = useRef(0); // 上次单击时间戳(双击判定)
  const tapTimerRef = useRef(null); // 单击延迟器(等第二击)
  const hideTimerRef = useRef(null); // 自动隐藏定时器
  const wallTimerRef = useRef(null); // 看板 Check 反馈复位定时器
  const rippleTimerRef = useRef(null); // ±10s 涟漪复位定时器
  const surfWRef = useRef(0); // 表面宽镜像(双击分区读,不等 setState)
  const surfHRef = useRef(0); // 表面高镜像(竖滑手势全高换算用)
  const gestRef = useRef(null); // 表面手势会话(见 surfacePan)
  const wideRef = useRef(false); // 宽幅镜像(手势回调读当下值)
  wideRef.current = wide;
  const isTouchRef = useRef(false); // 触屏镜像(手势/点击回调读当下值)
  isTouchRef.current = isTouch;
  const rotatedRef = useRef(false); // 伪全屏 CSS 旋转镜像(手势轴对调读当下值)
  rotatedRef.current = rotated;
  // 旋转态坐标换算:容器 rotate(90deg)(顺时针)后,容器 x 轴 → 屏幕 y 轴、
  // 容器 y 轴 → 屏幕 -x 轴;PanResponder 的 dx/dy/locationX 都是屏幕坐标,
  // 旋转层内手势要还原成「视频空间」轴——seek 横拖/竖滑亮度音量/进度条拖动
  // 才与视觉一致(B 站 iPhone web 同款处理)
  const coordX = (e) => (rotatedRef.current ? e.nativeEvent.locationY : e.nativeEvent.locationX);
  const pageXOf = (e) => (rotatedRef.current ? e.nativeEvent.pageY : e.nativeEvent.pageX);

  // 最新 props/回调镜像:PanResponder 只建一次,回调经 ref 读当下值防闭包过期
  const latest = useRef({});
  latest.current = {
    duration, currentTime, playing, ended, error, rate, volume, brightness,
    canVolume, onToggle, onSeek, onSeekBy, onSetRate, onSetVolume, onSetBrightness,
    onToggleMute, onUnmute, onToggleFullscreen, onRetry, onAddWall,
  };

  // ===== 自动隐藏:播放中且控件可见,3s 无操作收起 =====
  const armHide = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (!latest.current.playing || !visible) return;
    hideTimerRef.current = setTimeout(() => {
      // 到点再核一次当下状态:等待期间已暂停/播完/出错的绝不收起控件;
      // 弹出层(倍速/音量/设置)开着也不收——正被操作(窗口内弹层与独立
      // 菜单子窗两种形态都算)
      if (menuRef.current || menuWinKindRef.current) return;
      if (!latest.current.playing || latest.current.ended || latest.current.error) return;
      setVisible(false);
    }, AUTO_HIDE_MS);
    }, [visible]);
  const armHideRef = useRef(armHide); // armHide 镜像(surfacePan 回调防闭包过期)
  armHideRef.current = armHide;

  useEffect(() => {
    armHide();
    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [armHide]);

  // 暂停/播完/出错:控件常驻不收起(用户正要看状态)
  useEffect(() => {
    if (!playing || ended || error) setVisible(true);
  }, [playing, ended, error]);

  // 卸载清干净定时器
  useEffect(
    () => () => {
      if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (wallTimerRef.current) clearTimeout(wallTimerRef.current);
      if (rippleTimerRef.current) clearTimeout(rippleTimerRef.current);
    },
    []
  );

  // ===== 窗口内弹层(回落路径)移出自动收起 =====
  // 悬停打开的面板此前只靠点空白/选档关闭,鼠标走开后永久滞留。这里补齐悬停
  // 语义:面板 onHoverOut 起宽限计时,onHoverIn/控制条热区撤销;指针进视频区
  // (关闭背板)视为意图关闭立即收;收起后重新武装控件自动隐藏。
  const menuCloseTimerRef = useRef(null); // 宽限收起定时器
  const cancelMenuClose = useCallback(() => {
    if (menuCloseTimerRef.current) {
      clearTimeout(menuCloseTimerRef.current);
      menuCloseTimerRef.current = null;
    }
  }, []);
  const closeMenuSoon = useCallback(() => {
    cancelMenuClose();
    menuCloseTimerRef.current = setTimeout(() => {
      menuCloseTimerRef.current = null;
      setMenu(null);
      armHide();
    }, MENU_CLOSE_GRACE_MS);
  }, [armHide, cancelMenuClose]);
  const closeMenuNow = useCallback(() => {
    cancelMenuClose();
    setMenu(null);
    armHide();
  }, [armHide, cancelMenuClose]);

  // ===== web 悬停显控(YouTube 同款):鼠标移入出控件,移出走后自动隐藏 =====
  // native 无鼠标概念,不注入这两个 prop。悬停即出控件并把自动隐藏计时清零,
  // 移出后若在播放则立即收起(与 3s 自动隐藏同一套 visible 状态,无新增态);
  // 弹层开着时移出整个播放器也联动宽限收起(菜单不应比控件活得久)。
  const hoverProps =
    Platform.OS === 'web'
      ? {
          onHoverIn: () => {
            if (hideTimerRef.current) {
              clearTimeout(hideTimerRef.current);
              hideTimerRef.current = null;
            }
            setVisible(true);
          },
          onHoverOut: () => {
            armHide();
            closeMenuSoon();
          },
        }
      : null;

  // ===== ±10 秒快退/快进(双击左右区触发;按钮共用)=====
  const seekBy = useCallback(
    (d) => {
      if (latest.current.onSeekBy) latest.current.onSeekBy(d);
      armHide();
    },
    [armHide]
  );

  // 双击 ±10s 的涟漪反馈:对应侧黑底圆 pill(快退/快进图标 + 「10 秒」),短暂停留
  const showRipple = useCallback((dir) => {
    setRipple({ dir, k: Date.now() });
    if (rippleTimerRef.current) clearTimeout(rippleTimerRef.current);
    rippleTimerRef.current = setTimeout(() => setRipple(null), RIPPLE_MS);
  }, []);

  // ===== 单击/双击判定(按 YouTube 分端行为)=====
  // 窄幅(移动端形态):双击左/右 1/3 = ±10s(带涟漪),双击中间 = 播放/暂停;
  //   单击 = 切换控件显隐。
  // 宽幅 web(桌面形态):双击 = 全屏,单击 = 直接播放/暂停(吞掉双击的两次单击)。
  // 宽幅 native(平板横置 inline 等):与窄幅同判定(双击中间播放/暂停)。
  // 触屏设备横屏全屏时表面也会 ≥500(宽幅),但触屏单击语义应是「切控件」而非
  // 「播放/暂停」(YouTube 移动全屏同款)——桌面单击分支以「web 且非触屏」收窄
  const onSurfaceTap = useCallback(
    (e) => {
      const now = Date.now();
      const x = e && e.nativeEvent ? coordX(e) : 0;
      const w = surfWRef.current || 1;
      const desktopWeb = wideRef.current && Platform.OS === 'web' && !isTouchRef.current;
      // 菜单窗开着时点视频区 = 意图关闭(选档/移出之外的手动收起口;收起回执
      // 清 menuWinKind);点击本身照常走播放/暂停判定
      if (menuWinKindRef.current) menuWindow.hide();
      if (now - lastTapRef.current < DBL_TAP_MS) {
        // 双击:先撤掉挂起的单击动作,再按区/按形态执行
        lastTapRef.current = 0;
        if (tapTimerRef.current) {
          clearTimeout(tapTimerRef.current);
          tapTimerRef.current = null;
        }
        if (desktopWeb) {
          if (latest.current.onToggleFullscreen) latest.current.onToggleFullscreen();
          return;
        }
        const frac = x / w;
        if (frac < 0.33) {
          seekBy(-10);
          showRipple(-1);
        } else if (frac > 0.67) {
          seekBy(10);
          showRipple(1);
        } else {
          const fn = latest.current.onToggle;
          if (fn) fn();
        }
        return;
      }
      lastTapRef.current = now;
      tapTimerRef.current = setTimeout(() => {
        tapTimerRef.current = null;
        if (desktopWeb) {
          const fn = latest.current.onToggle; // YouTube 桌面:单击即播放/暂停
          if (fn) fn();
        } else {
          setVisible((v) => !v);
        }
      }, DBL_TAP_MS);
    },
    [seekBy, showRipple]
  );

  // ===== 进度条 PanResponder(只建一次,动作经 latest ref)=====
  const barPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          barXRef.current = pageXOf(e) - coordX(e);
          const w = barWRef.current || 1;
          const frac = Math.max(0, Math.min(1, coordX(e) / w));
          const t = frac * (latest.current.duration || 0);
          dragTRef.current = t;
          setDragT(t);
        },
        onPanResponderMove: (e) => {
          const w = barWRef.current || 1;
          // 页坐标必须取 nativeEvent:gestureState 没有 pageX/pageY 字段
          // (只有 moveX/moveY/x0/y0/dx/dy/vx/vy),读 g.pageX 得 undefined →
          // frac=NaN → 进度条恒在最前,且松手 onSeek(NaN) 两端内核都把 NaN
          // 钳成 0 真跳回片头
          const px = pageXOf(e);
          const frac = Math.max(0, Math.min(1, (px - barXRef.current) / w));
          const t = frac * (latest.current.duration || 0);
          dragTRef.current = t;
          setDragT(t);
        },
        onPanResponderRelease: () => {
          const t = dragTRef.current;
          dragTRef.current = null;
          setDragT(null);
          if (t != null && isFinite(t) && latest.current.onSeek) latest.current.onSeek(t);
        },
        onPanResponderTerminate: () => {
          // 被系统手势打断:放弃本次拖拽不 seek(宁可不跳也不错跳)
          dragTRef.current = null;
          setDragT(null);
        },
      }),
    []
  );

  // ===== 音量条 PanResponder(仅 web,0~1 线性)=====
  const volPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          volXRef.current = pageXOf(e) - coordX(e);
          const w = volWRef.current || 1;
          const v = Math.max(0, Math.min(1, coordX(e) / w));
          if (latest.current.onSetVolume) latest.current.onSetVolume(v);
        },
        onPanResponderMove: (e) => {
          const w = volWRef.current || 1;
          const px = pageXOf(e); // 同 barPan:页坐标在 nativeEvent 上,gestureState 无 pageX
          const v = Math.max(0, Math.min(1, (px - volXRef.current) / w));
          if (latest.current.onSetVolume) latest.current.onSetVolume(v);
        },
      }),
    []
  );

  // ===== 表面手势(腾讯/爱奇艺手机端同款;承载面两端常驻,鼠标同样可用)=====
  // 状态机:grant 记起点/左右半区并起 350ms 长按计时;
  //   · 计时到且未位移 → 左半持续快退(interval 200ms×1s ≈5×)/右半按住 2×
  //     倍速(记原速,松手还原);
  //   · 长按锁死后手指明显横移 → 结束长按效果转判轴(慢起步横拖也进 seek,
  //     倍速先还原);先位移(>10px)则长按计时作废,直接判轴锁模式;
//   · 横向 = 调进度(拖满表面宽 = 整段视频时长,按时长比例;中央 HUD + 进度
//     条红条/拇指/时间气泡双路实时回显「松手会到哪」,松手一次 onSeek);
//     纵向 = 左半亮度/右半音量(全表面高 = 0→1 全程,亮度下限 0.05;变化 >0.02
//     才推送——原生亮度调用重,节流);
  //   · 释放时未触发任何手势 → 合成 tap 事件回落到 onSurfaceTap 单/双击判定;
  //   · 系统打断(terminate)只清理不提交(与进度条同哲学:宁可不跳也不错跳),
  //     唯例外是倍速必须还原,否则全程停在 2×。
  // 会话经 gestRef(同步读不等 setState);HUD 经 setHud(与 dragT/ripple 同款
  // 低频 state,只在手势进行期更新)
  const endGest = useCallback((s) => {
    if (!s) return;
    if (s.lpTimer) { clearTimeout(s.lpTimer); s.lpTimer = null; }
    if (s.rewTimer) { clearInterval(s.rewTimer); s.rewTimer = null; }
  }, []);

  const surfacePan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          const s = {
            x0: e && e.nativeEvent ? coordX(e) : 0,
            side: 'l',
            mode: null, // null=未定 | 'seek' | 'bright' | 'vol' | 'lprew' | 'lprate' | 'none'
            seekFrom: 0,
            seekTarget: null,
            val0: 1, // 竖滑起始值(亮度/音量)
            lastVal: -1, // 竖滑推送节流锚点
            prevRate: null, // lprate 前倍速(还原用)
            lpTimer: null,
            rewTimer: null,
          };
          s.side = s.x0 / (surfWRef.current || 1) < 0.5 ? 'l' : 'r';
          s.lpTimer = setTimeout(() => {
            const g = gestRef.current;
            if (!g || g.mode != null) return;
            if (g.side === 'l') {
              g.mode = 'lprew';
              setHud({ type: 'rew' });
              g.rewTimer = setInterval(() => {
                if (latest.current.onSeekBy) latest.current.onSeekBy(-GEST_REW_STEP);
              }, GEST_REW_MS);
            } else {
              g.mode = 'lprate';
              g.prevRate = latest.current.rate != null ? latest.current.rate : 1;
              if (latest.current.onSetRate) latest.current.onSetRate(GEST_LP_RATE);
              setHud({ type: 'rate', v: GEST_LP_RATE });
            }
          }, LP_MS);
          gestRef.current = s;
        },
        onPanResponderMove: (e, g) => {
          const s = gestRef.current;
          if (!s) return;
          // 旋转态轴对调:屏幕 dx/dy → 视频空间 gdx/gdy(容器 rotate(90deg) 后
          // x 轴 → 屏幕 y 轴、y 轴 → 屏幕 -x 轴;非旋转态原样)
          const gdx = rotatedRef.current ? g.dy : g.dx;
          const gdy = rotatedRef.current ? -g.dx : g.dy;
          if (s.mode === 'lprew' || s.mode === 'lprate') {
            // 长按已锁但手指开始明显横移 → 结束长按效果转判轴:按住 350ms
            // 后才起步的横拖(慢起步拖进度)也必须进 seek,不能被长按计时
            // 锁死成快退/倍速。竖向漂移仍按长按忽略(横移才是拖进度的意图)
            if (Math.abs(gdx) <= LP_SLOP) return;
            if (s.mode === 'lprate' && s.prevRate != null && latest.current.onSetRate) {
              latest.current.onSetRate(s.prevRate); // 倍速先还原再转 seek
            }
            s.prevRate = null;
            endGest(s); // 停快退 interval(长按计时此时已自然触发过)
            s.mode = null;
            setHud(null);
          }
          if (s.mode == null) {
            if (Math.abs(gdx) < LP_SLOP && Math.abs(gdy) < LP_SLOP) return;
            if (s.lpTimer) {
              clearTimeout(s.lpTimer); // 位移先于长按 → 取消长按,判轴锁模式
              s.lpTimer = null;
            }
            if (Math.abs(gdx) >= Math.abs(gdy)) {
              s.mode = 'seek';
              s.seekFrom = latest.current.currentTime || 0;
              setVisible(true); // 回显可见性:控件可能已被自动隐藏,拖进度必须亮出进度条
            } else if (s.side === 'l') {
              s.mode = typeof latest.current.onSetBrightness === 'function' ? 'bright' : 'none';
              s.val0 = latest.current.brightness != null ? latest.current.brightness : 1;
              s.lastVal = s.val0;
            } else {
              s.mode = latest.current.canVolume ? 'vol' : 'none';
              s.val0 = latest.current.volume != null ? latest.current.volume : 1;
              s.lastVal = s.val0;
            }
          }
          if (s.mode === 'seek') {
            const dur = latest.current.duration || 0;
            if (dur <= 0) return;
            // 拖满表面宽 = 整段视频时长(相对增量·按时长比例);目标夹在 [0, dur]
            const delta = (gdx / (surfWRef.current || 1)) * dur;
            const target = Math.max(0, Math.min(dur, s.seekFrom + delta));
            s.seekTarget = target;
            // 进度条跟随回显:与进度条自身拖动共用 dragT,红条/拇指/时间气泡
            // 实时表达「松手会到哪」(原来只出中央 HUD,进度条纹丝不动)
            dragTRef.current = target;
            setDragT(target);
            setHud({ type: 'seek', delta: Math.round(target - s.seekFrom), target });
          } else if (s.mode === 'bright' || s.mode === 'vol') {
            // 上滑增大(dy 负 = 上);全表面高 = 0→1 全程
            let v = s.val0 - gdy / (surfHRef.current || 1);
            v = Math.max(0, Math.min(1, v));
            if (s.mode === 'bright') v = Math.max(GEST_MIN_BRIGHT, v);
            if (Math.abs(v - s.lastVal) >= 0.02 || v === 0 || v === 1) {
              s.lastVal = v;
              if (s.mode === 'bright') {
                if (latest.current.onSetBrightness) latest.current.onSetBrightness(v);
              } else if (latest.current.onSetVolume) {
                latest.current.onSetVolume(v);
              }
            }
            setHud({ type: s.mode, v });
          }
          // lprew/lprate:长按锁定,忽略后续漂移;none:该侧无手势能力,静默
        },
        onPanResponderRelease: () => {
          const s = gestRef.current;
          gestRef.current = null;
          setHud(null);
          if (!s) return;
          endGest(s);
          if (s.mode === 'seek' && s.seekTarget != null) {
            if (dragTRef.current != null) {
              dragTRef.current = null;
              setDragT(null); // 清回显;seekTo 乐观落位,进度条不闪回旧位
            }
            if (latest.current.onSeek) latest.current.onSeek(s.seekTarget);
            armHideRef.current(); // 因回显亮出的控件重新计自动隐藏
            return;
          }
          if (s.mode != null) return; // 手势已消费(长按/竖滑),不再当点击
          // 未触发手势的轻点 → 合成 tap 回落到单/双击判定(与桌面同一条路径)
          onSurfaceTap({ nativeEvent: { locationX: s.x0 } });
        },
        onPanResponderTerminate: () => {
          const s = gestRef.current;
          gestRef.current = null;
          setHud(null);
          if (dragTRef.current != null) {
            dragTRef.current = null;
            setDragT(null); // 被打断:清回显不提交(宁可不跳也不错跳)
          }
          if (!s) return;
          endGest(s);
          if (s.mode === 'lprate' && s.prevRate != null && latest.current.onSetRate) {
            latest.current.onSetRate(s.prevRate); // 倍速必须还原,否则停在 2×
          }
        },
      }),
    [onSurfaceTap, endGest]
  );

  // 卸载兜底:手势进行中卸载(切页/换布局)清计时器,倍速经 latest 还原不可靠
  // (回调引用还在,prevRate 在会话里——能读到就还原)
  useEffect(
    () => () => {
      const s = gestRef.current;
      if (!s) return;
      if (s.lpTimer) clearTimeout(s.lpTimer);
      if (s.rewTimer) clearInterval(s.rewTimer);
    },
    []
  );

  // ===== 呈现值:拖拽中显示拖拽位置,否则显示播放位置 =====
  const dur = duration || 0;
  const pos = dragT != null ? dragT : currentTime;
  const playedFrac = dur > 0 ? Math.max(0, Math.min(1, pos / dur)) : 0;
  const bufferedFrac = dur > 0 ? Math.max(0, Math.min(1, buffered / dur)) : 0;
  const isRate1 = rate != null && Math.abs(rate - 1) < 0.01;

  const toggle = useCallback(() => {
    const fn = latest.current.onToggle;
    if (fn) fn();
    armHide();
  }, [armHide]);

  // ===== 控件元素工厂(返回 Pressable/View 元素树;用函数而非内嵌组件,防高频
  // 重渲时按钮组换类型重挂载——见文件头实现 note)=====

  // —— 弹层打开分流:桌面非全屏 → 独立菜单子窗;浏览器/原生/全屏 → 窗口内
  //    弹层(macOS 全屏空间不允许他窗悬浮,主进程 menu-show 也会兜底返回
  //    fallback,两端判断同口径)——
  const desktopMenus = desktopApp && Platform.OS === 'web' && !fullscreen;
  // 弹层钮锚点 ref(独立窗路径经 measureInWindow 测屏幕坐标用;本地路径
  // 测「钮右缘距播放器右缘」给面板定位)
  const rateBtnRef = useRef(null);
  const volBtnRef = useRef(null);
  const settingsBtnRef = useRef(null);
  const rootRef = useRef(null); // 播放器表面根(本地弹层锚定的测量基准)
  const openKind = (kind, anchorRef) => {
    armHide();
    if (desktopMenus) {
      if (menuWinKindRef.current === kind) {
        menuWindow.enter(); // 已开着:指针回热区,撤销宽限收起
        return;
      }
      setMenuWinKind(kind);
      setMenu(null);
      openMenuWindow(kind, anchorRef, buildMenuState(), () => {
        // 主进程要求回落(macOS 全屏空间等):走窗口内弹层
        setMenuWinKind(null);
        setMenu(kind);
      });
    } else {
      setMenuWinKind(null);
      setMenu(kind);
      cancelMenuClose();
      // 本地弹层锚定触发钮:面板右缘对齐钮右缘(YouTube 形态——此前钉死
      // right:8,音量面板会飘到离钮很远的控制条右端)
      const el = anchorRef && anchorRef.current;
      const root = rootRef.current;
      if (
        el && root &&
        typeof el.measureInWindow === 'function' &&
        typeof root.measureInWindow === 'function'
      ) {
        el.measureInWindow((bx, _by, bw, _bh) => {
          root.measureInWindow((rx, _ry, rw, _rh) => {
            setMenuAnchorRight(Math.max(0, Math.round(rx + rw - (bx + bw))));
          });
        });
      } else {
        setMenuAnchorRight(8); // 测不到(触屏/异常环境):回老锚位
      }
    }
  };
  // 弹层钮移出:桌面=菜单窗宽限收起(主进程中央定时器,菜单窗 enter 可撤销);
  // 本地=宽限收起(面板/控制条 hoverIn 撤销)
  const onMenuBtnHoverOut = () => {
    if (desktopMenus) menuWindow.leave();
    else closeMenuSoon();
  };
  // 控制条热区悬停:指针仍在「钮 ↔ 菜单」动线上(穿行/停留都算),两种弹层
  // 形态的宽限收起计时一并撤销——只靠钮与菜单两侧的 enter 撤销,穿行稍慢
  // 就会被收掉,来不及点
  const onBarHoverIn = () => {
    cancelMenuClose();
    if (desktopMenus) menuWindow.enter();
  };

  // 通用圆钮(40px 命中/24px 图标,YouTube 功能钮形态);hoverProps 供悬停即开
  // 弹层的钮(倍速/音量)挂 onHoverIn/onHoverOut——必须是 {onHoverIn,onHoverOut}
  // 形态的对象(早期版本误传裸函数,spread 函数等于什么都没挂,音量弹窗因此
  // 从未打开过);btnRef 供独立窗路径测锚点
  const ctrlBtn = (label, onPress, children, onLongPress, hoverProps, btnRef) => (
    <Pressable
      ref={btnRef || null}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onLongPress={onLongPress}
      {...(hoverProps || null)}
      className="h-10 w-10 items-center justify-center rounded-full"
    >
      {children}
    </Pressable>
  );

  // 倍速钮(窄幅在顶右排;宽幅在底条):图标 + 当前档文本,非 1x 时以半粗白字
  // 区分(播放器整体去红口径,不再用品牌红)。鼠标移入即出菜单(站方体感:
  // 不用先点——桌面浮出为独立小窗,其余环境窗口内弹层);点按也只管打开,
  // 关闭走选档/移出/点空白,免得「悬停已开、再点又关」的反复
  const rateBtn = () => (
    <Pressable
      ref={rateBtnRef}
      accessibilityRole="button"
      accessibilityLabel="倍速"
      onHoverIn={() => openKind('rate', rateBtnRef)}
      onHoverOut={onMenuBtnHoverOut}
      onPress={() => openKind('rate', rateBtnRef)}
      className="h-10 min-w-[48px] flex-row items-center justify-center gap-1 rounded-full px-2"
    >
      <Speed size={18} color="#fff" />
      <Text
        className="text-xs"
        style={{ color: '#fff', fontWeight: isRate1 ? '500' : '700' }}
      >
        {isRate1 ? '倍速' : rate + 'x'}
      </Text>
    </Pressable>
  );

  // 看板钮:加入视频大屏看板;成功后图标短暂变填充形(~1.5s 本地反馈)。
  // 已在墙时同钮转为移除(toggle)。prop 优先,无 prop 走 wall-store 注入通道
  // 取候选自行 addToWall;两条路都没有则整钮不渲染(null)
  const wallBtn = () =>
    onAddWall || wallEntry ? (
      ctrlBtn(
        inWall ? '从看板移除' : '添加到看板',
        () => {
          // 已在墙:同 key 反向移除(key 从注入提供器现算,与渲染侧 inWall 同口径;
          // inWall 本就只由注入通道判定,此处必有提供器)
          if (inWall) {
            try {
              const cur = wallEntryRef.current;
              const v = typeof cur === 'function' ? cur() : null;
              if (v && v.site != null && v.id != null) {
                removeFromWall(String(v.site) + ':' + String(v.id));
              }
            } catch (_e) {
              /* 提供器读在播实例异常:静默放弃本次移除 */
            }
            armHide();
            return;
          }
          let ok = false;
          const fn = latest.current.onAddWall;
          if (typeof fn === 'function') {
            ok = !!fn(); // prop 路径:调用方自行组 WallItem 并 addToWall
          } else {
            const provide = wallEntryRef.current;
            const v = typeof provide === 'function' ? provide() : null;
            if (v) ok = addToWall(v) !== 'invalid'; // 注入路径:就地组账入墙
          }
          if (ok) {
            setWallAdded(true);
            if (wallTimerRef.current) clearTimeout(wallTimerRef.current);
            wallTimerRef.current = setTimeout(() => setWallAdded(false), 1500);
          }
          armHide();
        },
        wallAdded || inWall ? (
          <WallAdded size={ICON} color="#fff" />
        ) : (
          <WallAdd size={ICON} color="#fff" />
        )
      )
    ) : null;

  // 音量钮(仅 web):点图标开关静音;鼠标移入弹出音量条(桌面=独立小窗,
  // 其余=窗口内弹层;站方体感)。早期版本给 ctrlBtn 的第 5 参误传裸函数,
  // spread 后什么都没挂上,音量弹窗从未打开过——现在按 {onHoverIn,onHoverOut}
  // 对象传入,悬停真正生效
  const volBtn = () =>
    canVolume ? (
      ctrlBtn(
        muted ? '取消静音' : '静音',
        () => {
          if (latest.current.onToggleMute) latest.current.onToggleMute();
          armHide();
        },
        muted || volume === 0 ? (
          <VolumeOff size={ICON} color="#fff" />
        ) : (
          <VolumeUp size={ICON} color="#fff" />
        ),
        null,
        {
          onHoverIn: () => openKind('vol', volBtnRef),
          onHoverOut: onMenuBtnHoverOut,
        },
        volBtnRef
      )
    ) : null;

  // 下一集钮(桌面形态):观看页经 player-chrome 注入的连播选队结果(量贩/合集/
  // 相关的下一部,与播完 5 秒倒计时同一口径);无下一项/非观看页整钮不渲染
  const nextBtn = () =>
    chrome.next ? (
      ctrlBtn(
        chrome.next.title ? '下一集：' + chrome.next.title : '下一集',
        () => {
          try {
            if (typeof chrome.next.go === 'function') chrome.next.go();
          } catch (_e) {
            /* 切集失败:静默(目标页自会呈现自己的错误态) */
          }
          armHide();
        },
        <Next size={ICON} color="#fff" />
      )
    ) : null;

  // 选集钮(桌面形态):开合压在播放器上的选集浮层(观看页注册进 dock 覆盖槽);
  // 无选集片单(单集片)不渲染。图标恒白(播放器整体去红口径,开合态由浮层
  // 自身呈现)
  const episodesBtn = () =>
    chrome.episodes ? (
      ctrlBtn(
        chrome.episodes.open ? '收起选集' : '选集',
        () => {
          try {
            if (typeof chrome.episodes.toggle === 'function') chrome.episodes.toggle();
          } catch (_e) {
            /* 开合异常:静默 */
          }
          armHide();
        },
        <Playlist size={ICON} color="#fff" />
      )
    ) : null;

  // 设置钮(两形态共用):弹出播放设置菜单(自动连播/播放窗口)。桌面非全屏
  // 浮出为独立小窗(点按开/收),其余环境窗口内弹层(点按切换)
  const settingsBtn = () =>
    ctrlBtn(
      '设置',
      () => {
        if (desktopMenus) {
          if (menuWinKindRef.current === 'settings') menuWindow.hide();
          else openKind('settings', settingsBtnRef);
        } else {
          setMenu(menu === 'settings' ? null : 'settings');
          cancelMenuClose();
        }
        armHide();
      },
      <Settings size={ICON} color="#fff" />,
      null,
      null,
      settingsBtnRef
    );

  // 小窗播放钮（同一钮位，按环境分流）：
  //   · 桌面壳（Electron 播放独立窗）：点它把窗口缩成右下角置顶小窗（站方播放器
  //     的「小窗播放」形态，见 desktop/main.js 的 moontent:win-toggle-mini），
  //     再点还原——不用浏览器画中画（那样的浮窗没有本应用的控件与状态）；
  //   · 其余（浏览器/原生）：走 player-chrome 注入的观看页动作 mini.go()——
  //     舞台缩小成应用内悬浮小窗 + 退出整条观看链落回链底来路页（video→video
  //     链一并弹掉；落在观看页会被路由相位 effect 拉回观看位，小窗钮失效）。
  //     不再回落浏览器画中画：系统级 PiP 浮窗同样没有本应用的控件与状态，
  //     且与「首页悬浮小窗」形态重复
  //     （Chromium 仍可右键 video 元素用原生画中画）；无注入（非观看页）不渲染。
  const pipBtn = () =>
    desktopApp
      ? ctrlBtn(
          miniWin ? '退出小窗播放' : '小窗播放',
          async () => {
            setMiniWindow(await winControls.toggleMini());
            armHide();
          },
          <Pip size={ICON} color="#fff" />
        )
      : chrome.mini
        ? ctrlBtn(
            '小窗播放',
            () => {
              if (typeof chrome.mini.go === 'function') chrome.mini.go();
              armHide();
            },
            <Pip size={ICON} color="#fff" />
          )
        : null;

  // 全屏钮(两种形态共用)
  const fsBtn = () =>
    ctrlBtn(
      fullscreen ? '退出全屏' : '全屏',
      () => {
        if (latest.current.onToggleFullscreen) latest.current.onToggleFullscreen();
        armHide();
      },
      fullscreen ? (
        <FullscreenExit size={ICON} color="#fff" />
      ) : (
        <FullscreenEnter size={ICON} color="#fff" />
      )
    );

  // 进度条本体(两种形态共用:20px 命中区 + 3px 视觉轨道 + 拖拽拇指/气泡)
  const scrubber = (cls) => (
    <View
      className={'h-5 justify-center ' + (cls || '')}
      {...barPan.panHandlers}
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        barWRef.current = w;
        setBarW(w);
      }}
    >
      {/* 轨道底 + 缓冲 + 已播放(白色系——播放器整体去红口径);绝对定位用
          数值样式,两端一致 */}
      <View
        className="rounded-full bg-white/30"
        style={{ position: 'absolute', left: 0, right: 0, top: 8.5, height: 3 }}
      >
        <View
          className="absolute left-0 top-0 rounded-full bg-white/30"
          style={{ height: 3, width: (bufferedFrac * 100) + '%' }}
        />
        <View
          className="absolute left-0 top-0 rounded-full"
          style={{ height: 3, width: (playedFrac * 100) + '%', backgroundColor: '#fff' }}
        />
      </View>
      {/* 拖拽拇指 + 时间气泡(拖拽中才出现;宽度未测得前不渲染)。拇指中心与
          气泡中心都落在 playedFrac*barW——与 barPan 全宽线性换算严格一致,
          手指/鼠标位置即落点,不随拇指宽内缩 */}
      {dragT != null && barW > 0 ? (
        <>
          <View
            className="absolute size-3 rounded-full bg-white"
            style={{ left: playedFrac * barW - 6, top: 4 }}
          />
          <GlassSurface
            glassStyle="clear"
            dark
            dimming={DIMMING}
            className="absolute rounded px-2 py-1"
            fallbackClassName="bg-black/80"
            style={{
              left: Math.max(0, Math.min(barW - 60, playedFrac * barW - 30)),
              top: -26,
            }}
          >
            <Text className="text-xs text-white">{fmtDur(dragT)}</Text>
          </GlassSurface>
        </>
      ) : null}
    </View>
  );

  // ===== 出错态:全遮浮层如实显示错误 + 重试(解析失败/播放中断共用)=====
  if (error) {
    return (
      <View className="absolute inset-0 items-center justify-center bg-black/85">
        <Alert size={32} color={ERROR_RED} />
        <Text className="mt-2 px-6 text-center text-sm text-white/70" numberOfLines={3}>
          {error}
        </Text>
        {onRetry ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="重试"
            onPress={() => {
              if (latest.current.onRetry) latest.current.onRetry();
            }}
            className="mt-3"
          >
            <GlassSurface
              glassStyle="clear"
              dark
              dimming={DIMMING}
              interactive
              className="h-10 flex-row items-center gap-1.5 rounded-full px-4"
              fallbackClassName="bg-[#272727]"
            >
              <Restart size={16} color="#fff" />
              <Text className="text-sm font-medium text-white">重试</Text>
            </GlassSurface>
          </Pressable>
        ) : null}
      </View>
    );
  }

  // 弹出层锚位:两种形态都锚在底部控制条上方——弹层挂载于底条簇容器内
  // (簇本身 absolute 锚在播放器底缘),top 锚会算到播放器下方去,手机上
  // 点了「不出现」的本源;宽幅让位三行条(96),窄幅让位底行(52,与静音
  // pill 同基准)。右缘用实测的「钮右缘距播放器右缘」(menuAnchorRight,
  // 打开时更新)——面板跟钮走;沉浸态底条悬浮抬升,锚位 bottom 同步跟
  // (面板不压悬浮条)
  const popAnchor = {
    bottom: (wide ? 96 : 52) + barLift,
    right: menuAnchorRight,
  };

  return (
    <View
      ref={rootRef}
      className="absolute inset-0"
      style={{ pointerEvents: 'box-none', zIndex: 2 }}
      {...hoverProps}
      onHoverOut={() => {
        if (hoverProps) hoverProps.onHoverOut();
        // 指针离开整个播放器:独立菜单窗也进宽限收起(否则从控制条边缘直接
        // 出播放器时,菜单没有触发收起的路径,会滞留不关;主进程到点会复核
        // 指针是否其实跨进了菜单窗,跨窗乱序不误收)
        if (desktopMenus) menuWindow.leave();
      }}
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        surfWRef.current = w;
        setSurfW(w);
        surfHRef.current = e.nativeEvent.layout.height;
      }}
    >
      {/*
        点击/双击/手势承载面:盖满整个视频区,两端常驻同一手势状态机——
        react-native-web 的 PanResponder 同样响应鼠标,桌面按住画面横拖也能
        调进度(与触屏行为完全一致)。长按快退/倍速、横拖调进度(进度条实时
        回显)、竖滑亮度/音量见 surfacePan 注释;未触发手势的释放合成 tap 回落
        onSurfaceTap,桌面单击播放/暂停、双击全屏的语义经 desktopWeb 分支
        原样保留(isTouch 只再分流 tap 语义,不再分流承载面)。
      */}
      <View
        accessibilityRole="button"
        accessibilityLabel={playing ? '暂停' : '播放'}
        className="absolute inset-0"
        {...surfacePan.panHandlers}
      />

      {/* 中央:缓冲 spinner(不受显隐控制,缓冲就该被看见) */}
      {loading ? (
        <View className="absolute inset-0 items-center justify-center" style={{ pointerEvents: 'none' }}>
          <ActivityIndicator size="large" color="#fff" />
        </View>
      ) : null}

      {/* 中央:暂停/播完的大钮(只在控件可见时;仅钮身可点,不挡单击翻面) */}
      {!loading && visible && !playing ? (
        <View className="absolute inset-0 items-center justify-center" style={{ pointerEvents: 'box-none' }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={ended ? '重播' : '播放'}
            onPress={toggle}
            className="h-16 w-16 rounded-full"
          >
            <GlassSurface
              glassStyle="clear"
              dark
              dimming={DIMMING}
              interactive
              className="h-16 w-16 items-center justify-center rounded-full"
              fallbackClassName="bg-black/60"
            >
              {ended ? (
                <Restart size={32} color="#fff" />
              ) : (
                <Play size={36} color="#fff" />
              )}
            </GlassSurface>
          </Pressable>
        </View>
      ) : null}

      {/* 双击 ±10s 涟漪反馈(YouTube 同款:对应侧黑底圆 pill,快退/快进图标+10秒) */}
      {ripple ? (
        <View
          key={ripple.k}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: ripple.dir < 0 ? '8%' : undefined,
            right: ripple.dir > 0 ? '8%' : undefined,
            justifyContent: 'center',
            alignItems: 'center',
            pointerEvents: 'none',
          }}
        >
          <GlassSurface
            glassStyle="clear"
            dark
            dimming={DIMMING}
            className="h-20 w-20 items-center justify-center rounded-full"
            fallbackClassName="bg-black/50"
          >
            {ripple.dir < 0 ? (
              <Rewind size={26} color="#fff" />
            ) : (
              <Forward size={26} color="#fff" />
            )}
            <Text className="mt-0.5 text-xs font-medium text-white" allowFontScaling={false}>
              10 秒
            </Text>
          </GlassSurface>
        </View>
      ) : null}

      {/* ===== 触屏手势 HUD(进行中才出现,纯展示不接事件)===== */}
      {hud ? (
        hud.type === 'seek' ? (
          // 横拖调进度:中央 pill「±时长 · 目标时间」(松手一次 seek 提交;
          // 增量按时长比例可达整段,h:mm:ss 展示防大数值不可读)
          <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <GlassSurface
              glassStyle="clear"
              dark
              dimming={DIMMING}
              className="flex-row items-center gap-2 rounded-full px-4 py-2"
              fallbackClassName="bg-black/75"
            >
              {hud.delta < 0 ? (
                <Rewind size={18} color="#fff" />
              ) : (
                <Forward size={18} color="#fff" />
              )}
              <Text className="text-sm font-medium text-white" allowFontScaling={false}>
                {(hud.delta < 0 ? '' : '+') + fmtDur(Math.abs(hud.delta))}
              </Text>
              <Text className="text-sm text-white/70" allowFontScaling={false}>
                {fmtDur(hud.target)}
              </Text>
            </GlassSurface>
          </View>
        ) : hud.type === 'rew' || hud.type === 'rate' ? (
          // 长按反馈:左半快退中 / 右半 N× 倍速中(松手结束/还原)
          <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <GlassSurface
              glassStyle="clear"
              dark
              dimming={DIMMING}
              className="flex-row items-center gap-2 rounded-full px-4 py-2"
              fallbackClassName="bg-black/75"
            >
              {hud.type === 'rew' ? (
                <Rewind size={18} color="#fff" />
              ) : (
                <Speed size={18} color={ERROR_RED} />
              )}
              <Text className="text-sm font-medium text-white" allowFontScaling={false}>
                {hud.type === 'rew' ? '快退中' : hud.v + 'x 倍速中'}
              </Text>
            </GlassSurface>
          </View>
        ) : (
          // 竖滑:对应侧竖条(白填充 = 当前值)+ 图标钉在条顶
          <View
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              ...(hud.type === 'bright' ? { left: '18%' } : { right: '18%' }),
              justifyContent: 'center',
              alignItems: 'center',
              pointerEvents: 'none',
            }}
          >
            <GlassSurface
              glassStyle="clear"
              dark
              dimming={DIMMING}
              style={{
                width: 40,
                height: HUD_BAR_H,
                borderRadius: 20,
                overflow: 'hidden',
                alignItems: 'center',
                justifyContent: 'flex-end',
              }}
              fallbackStyle={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
            >
              <View
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: Math.round(Math.max(0, Math.min(1, hud.v)) * HUD_BAR_H),
                  backgroundColor: '#fff',
                  opacity: 0.9,
                }}
              />
              <View style={{ position: 'absolute', top: 8 }}>
                {hud.type === 'bright' ? (
                  <Sun size={16} color="#fff" />
                ) : (
                  <VolumeUp size={16} color="#fff" />
                )}
              </View>
            </GlassSurface>
          </View>
        )
      ) : null}

      {/* 弹出层点击关闭背板:任一面板(倍速/音量/设置)开着时盖住视频区,
          点空白即收;web 上指针移入视频区也视为意图关闭立即收(悬停语义),
          排在控制条之前——条上的钮/面板本体永远压它之上可点 */}
      {visible && menu ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭菜单"
          onPress={closeMenuNow}
          onHoverIn={Platform.OS === 'web' ? closeMenuNow : undefined}
          className="absolute inset-0"
        />
      ) : null}

      {/* ===== 控件主体(不可见时整组收起)===== */}
      {visible ? (
        <>
          {/* 顶右功能排(窄幅):(web)音量/看板/倍速/设置——控件可见时才出现;
              宽幅并入底部控制条,不重复渲染。热区悬停撤销弹层的宽限收起
              (指针在钮↔面板动线上穿行/停留都不断流) */}
          {!wide ? (
            <View
              className="absolute flex-row items-center"
              style={{
                // 沉浸态舞台 edge-to-edge，顶右功能排垫安全区避开刘海/灵动岛；
                // 常态舞台锚在页面内（insets 极小），保持原 4px 边距
                right: 4 + padRight,
                top: 4 + padTop,
                pointerEvents: 'box-none',
              }}
              onHoverIn={onBarHoverIn}
            >
              {/* iOS 26 玻璃端:功能排整组收进 clear 玻璃胶囊(悬浮控件簇形态);
                  降级端裸图标排(原样,无底) */}
              <GlassSurface
                glassStyle="clear"
                dark
                dimming={DIMMING}
                className="flex-row items-center rounded-full"
                glassOnlyStyle={{ paddingVertical: 2, paddingLeft: 2, paddingRight: 6 }}
              >
                {volBtn()}
                {wallBtn()}
                {rateBtn()}
                {settingsBtn()}
              </GlassSurface>
            </View>
          ) : null}

          {/* ===== 底部玻璃簇（GlassGroup）=====
              HIG（WWDC25-219）：相邻玻璃必须同容器——「glass cannot sample other
              glass」，容器外的相邻玻璃渲染不一致；spacing = 开始互相影响（形状
              融合）的距离。本簇收编：控制条衬底 + 自动静音兜底 pill + 倍速/设置/
              音量弹层（弹层锚在控制条正上方，开合时与控制条玻璃协同融合/分离，
              即官方菜单与触发钮的 morph 语义在 UIKit 容器下的近似）。降级端
              GlassGroup = 普通 View，结构与视觉零变化 */}
          <GlassGroup
            spacing={SPACING.tight}
            className="absolute inset-x-0 bottom-0"
            style={{ pointerEvents: 'box-none' }}
            onHoverIn={onBarHoverIn}
          >
            {/* 自动静音兜底 pill(web):自动播放被拦转静音后,点按恢复声音;
                站位随控制条高(宽幅三行条更高) */}
            {autoMuted && onUnmute ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="取消静音"
                onPress={() => {
                  if (latest.current.onUnmute) latest.current.onUnmute();
                }}
                className="absolute left-3"
                style={{ bottom: (wide ? 96 : 52) + barLift }}
              >
                <GlassSurface
                  glassStyle="clear"
                  dark
                  dimming={DIMMING}
                  interactive
                  className="h-8 flex-row items-center gap-1.5 rounded-full px-3"
                  fallbackClassName="bg-black/75"
                >
                  <VolumeOff size={14} color="#fff" />
                  <Text className="text-xs font-medium text-white">点按取消静音</Text>
                </GlassSurface>
              </Pressable>
            ) : null}

            {/* 倍速菜单（站方形态：面板锚在钮上方浮出，当前档整行提亮；
                由快到慢自上而下，标签 1X/1.5X 口径；鼠标移入倍速钮即开。
                窗口内回落形态——移出面板/离开热区宽限自动收，移入撤销。
                显隐走 materialize（HIG：调制折光而非 opacity）——常驻挂载 +
                shown 门卫；隐藏期包裹层 pointerEvents 收 none（玻璃端玻璃已
                materialize 走，降级端 PlayerPopup 直接 null） */}
            <View
              className="absolute"
              style={popAnchor}
              pointerEvents={menu === 'rate' ? 'auto' : 'none'}
              onHoverIn={cancelMenuClose}
              onHoverOut={closeMenuSoon}
            >
              <PlayerPopup minWidth={112} shown={menu === 'rate'}>
                {RATES_DESC.map((r) => (
                  <PlayerPopupRow
                    key={r}
                    label={r + 'X'}
                    active={Math.abs(rate - r) < 0.01}
                    onPress={() => {
                      if (latest.current.onSetRate) latest.current.onSetRate(r);
                      setMenu(null);
                      armHide();
                    }}
                  />
                ))}
              </PlayerPopup>
            </View>

            {/* 播放设置菜单（自动连播/播放窗口；同款移出宽限收起；materialize 同上） */}
            <View
              className="absolute"
              style={popAnchor}
              pointerEvents={menu === 'settings' ? 'auto' : 'none'}
              onHoverIn={cancelMenuClose}
              onHoverOut={closeMenuSoon}
            >
              <PlayerMenu shown={menu === 'settings'} />
            </View>

            {/* 音量弹出条（仅 web，音量钮悬停唤起）：同一面板底色的横条拖动，
                左端百分比实时显示（materialize 同上；canVolume=false 不挂载） */}
            {canVolume ? (
              <View
                className="absolute"
                style={popAnchor}
                pointerEvents={menu === 'vol' ? 'auto' : 'none'}
                onHoverIn={cancelMenuClose}
                onHoverOut={closeMenuSoon}
              >
                <PlayerPopup
                  minWidth={0}
                  shown={menu === 'vol'}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12 }}
                >
                  <Text className="w-7 text-right text-xs text-white/85" allowFontScaling={false}>
                    {Math.round((muted ? 0 : volume) * 100)}
                  </Text>
                  <View
                    className="h-1 rounded-full bg-white/30"
                    style={{ width: VOL_W }}
                    onLayout={(e) => {
                      volWRef.current = e.nativeEvent.layout.width;
                    }}
                    {...volPan.panHandlers}
                  >
                    <View
                      className="absolute left-0 top-0 h-1 rounded-full bg-white"
                      style={{ width: (muted ? 0 : volume) * VOL_W }}
                    />
                  </View>
                </PlayerPopup>
              </View>
            ) : null}

            {wide ? (
              /* ===== 宽幅:桌面播放器控制条(腾讯视频客户端形态;站方播放窗同构)
                 行1 进度条通栏 → 行2 时间(左) → 行3 左起传输组/右起功能组。
                 沉浸态整条收进安全区悬浮:clear 玻璃 control 档圆角 + 浮动阴影
                 (对齐首页 tab bar);降级端常态无衬原样直压画面,沉浸态深色半
                 透明圆角底 ===== */
              <GlassSurface
                glassStyle="clear"
                dark
                dimming={DIMMING}
                className="pb-2"
                style={floatBarStyle}
                glassOnlyStyle={edgeToEdge ? FLOAT_BAR_GLASS : undefined}
                fallbackStyle={edgeToEdge ? FLOAT_BAR_FALLBACK : undefined}
              >
                <View className="px-2">{scrubber('')}</View>
                <View className="px-3 pt-1">
                  <Text className="text-xs text-white/90" allowFontScaling={false}>
                    {fmtDur(pos)}/{fmtDur(dur)}
                  </Text>
                </View>
                <View className="flex-row items-center justify-between px-2 pt-0.5">
                  {/* 左起传输组:[播放/暂停][下一集]（站方形态:±10s 不上条——桌面
                      按住画面横拖即调进度、双击左右区仍 ±10s，钮位留给主功能） */}
                  <View className="flex-row items-center">
                    {ctrlBtn(playing ? '暂停' : '播放', toggle,
                      playing ? <Pause size={ICON} color="#fff" /> : <Play size={ICON} color="#fff" />
                    )}
                    {nextBtn()}
                  </View>
                  <View className="flex-row items-center">
                    {episodesBtn()}
                    {rateBtn()}
                    {volBtn()}
                    {wallBtn()}
                    {settingsBtn()}
                    {pipBtn()}
                    {onToggleFullscreen ? fsBtn() : null}
                  </View>
                </View>
              </GlassSurface>
            ) : (
              /* ===== 窄幅:YouTube 移动端底行 =====
                 [当前时间][进度条 flex][总时长][全屏]——无成排功能钮;
                 无全屏动作(VideoPlayer 独立使用形态)则全屏钮缺席。
                 沉浸态整条收进安全区悬浮(同宽幅口径);降级端常态无衬(原样) */
              <GlassSurface
                glassStyle="clear"
                dark
                dimming={DIMMING}
                className="flex-row items-center px-2 pb-1.5"
                style={floatBarStyle}
                glassOnlyStyle={edgeToEdge ? FLOAT_BAR_GLASS : undefined}
                fallbackStyle={edgeToEdge ? FLOAT_BAR_FALLBACK : undefined}
              >
                <Text
                  className="w-10 text-right text-xs text-white/90"
                  allowFontScaling={false}
                >
                  {fmtDur(pos)}
                </Text>
                {scrubber('mx-1 flex-1')}
                <Text className="w-10 text-xs text-white/90" allowFontScaling={false}>
                  {fmtDur(dur)}
                </Text>
                {onToggleFullscreen ? fsBtn() : null}
              </GlassSurface>
            )}
          </GlassGroup>
        </>
      ) : null}
    </View>
  );
}
