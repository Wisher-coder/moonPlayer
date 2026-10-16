// ============================================================================
// player-context.jsx —— 播放器常驻 Provider(单一「舞台」+ YouTube 式变形过渡)
// ----------------------------------------------------------------------------
// 移植自 NextWeb/src/lib/player-context.jsx,按 RN 三端改造;本次重构把
// 「观看页 dock + 迷你浮层 + web 停车场搬运」三件套收敛为一个常驻舞台:
//
// 【会话与解析】(与旧版一致)
//   - open(item)(item={site,id,title,cover})写会话;播放源解析全在 Provider 内
//     经 client 的 api(site,'play',{id}) 取 resolvePlay(单次请求,不做轮询),
//     失败如实进错误态(phase='error'),重试由 retry() 重走解析;
//   - url/cover 经 absolutizeUrl 绝对化后下发放播放组件;
//   - 解析成功顺手 recordView 落观看足迹。
//
// 【单一舞台 PlayerStage——「完全共享一个播放器」的落点】
//   - 全 App 只有一个播放器:session 存在即由 Provider 构造 PlayerStage 元素,
//     经 PlayerStageContext 交给 AppShell 的 <PlayerStageSlot/> 在壳层内渲染
//     (底导航之后、抽屉/视频墙之前——同父 zIndex:内容(0)<舞台(40)<抽屉
//     遮罩(40,后置兄弟)<抽屉(50)<视频墙(100),三端一致;挂在壳层外时
//     native 上舞台会整层盖住 AppShell 子树,抽屉/弹窗全部失效)。
//     「观看页大播放器」与「右下悬浮小窗」只是舞台的两种
//     几何形态,播放器实例/视频元素自始至终不动:
//       · native:共享 expo-video 实例(Provider 持有),舞台渲染它唯一的窗;
//       · web:唯一 VideoPlayer(video 元素)永久住在舞台里——旧「停车场
//         appendChild 搬运」整链删除,不再有搬运时序问题,续播天然不断流;
//   - 观看页不再挂播放器:PlayerDock 退化为「透明锚点」,只负责把自己的窗口
//     坐标(rect)上报给 Provider,舞台据此停泊到播放器外框位置。
//
// 【相位状态机与变形过渡(YouTube 手感)】
//   - uiPhase: hidden→entering(新会话在观看位淡入)/ mini(悬浮小窗)/
//     expanding(小窗→观看位放大)/ docked(停泊观看位)/ shrinking(观看位→
//     小窗缩小);切换全部走 FLIP 变形:布局一步落位到目标 rect,transform
//     (translate+scale,transformOrigin 左上)反演回起点再动画归零(单
//     progress 节点图驱动四路输出,web 端每帧仅 1 个 JS 回调)——动画期
//     纯 transform+opacity(GPU 合成,native 端 useNativeDriver),形变落定撤
//     scale;小窗拖动始终由平移承载,吸附结束不换布局/动画通道;
//   - 编排返回 beginShrinkThenBack(backFn):内容淡出+舞台缩小完成后再真正
//     pop 路由,全程无整页切换动画(video 屏 Stack 配 animation:'none');
//     非编排退出(切 tab/浏览器后退/URL 直跳)由路由感知兜底自动缩小——
//     「退出时悬浮播放」设置(settings.miniOnExit,默认开)关闭时,一切退出
//     路径收敛为 close() 直接停止播放(见路由驱动相位 effect);
//   - 悬浮窗交互:自由拖动(视口内 clamp)、松手吸附最近角落、向下快甩关闭;
//     左上暂停/右上关闭两个钮,点按画面=展开(本窗 router.push,不走
//     useOpenVideo——会话在本窗,展开也在本窗)。
//   - 滚动跟随:桌面双列/剧场布局里播放器随页滚动,观看页把滚动差写进共享
//     Animated(scroll),docked 时舞台叠加 translateY 跟随(纯 transform);
//     滚动结束锚点重测归零(经 dockNudge 触发 PlayerDock 再 measure)。
//   - dock 覆盖槽 setDockOverlay:返回箭头/连播倒计时必须压在视频之上,由
//     观看页经 effect 注册节点、舞台在 docked 态渲染(留在页面内会被舞台盖住)。
//
// 【进度与关闭】(与旧版一致)
//   - usePlaybackProgress 包装 history 的 saveProgress/getProgress:高频进度
//   回调节流落盘;close() 销毁会话并兜底落进度。
//
// 【对外契约(usePlayer)】
//   - { current, open(item), close() } —— 钉死的最小契约(不变);
//   - 扩展:src/phase/errorMsg/retry/videoProps/subscribe(不变)+
//     uiPhase/beginShrinkThenBack/setDockOverlay/reportDockScroll/
//     endDockScroll/dockNudge(舞台编排面)。
// ============================================================================
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  BackHandler,
  Easing,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Pause, Play, Close } from '../components/icons.js';
import { createVideoPlayer } from './native-player.js'; // 平台分流:web=占位空实现(expo-video 不进 web 图谱),native=re-export expo-video
// 方向策略层(平台分流:web=占位空实现,expo-screen-orientation 不进 web 图谱):
// 进全屏按画幅锁向/退全屏恢复进入前方向(含延迟解锁)/物理旋转订阅(联动用)
import { lockForVideo, restoreAfterFullscreen, subscribeOrientation } from './screen-orientation.js';
import { api, absolutizeUrl } from './client.js';
import { shardMediaUrl } from './origin-pool.js';
import { recordView } from './history.js';
// 退出时悬浮播放开关(离开观看页:开=缩悬浮小窗续播,关=close 停止播放)
import { getSettingsSnapshot } from './settings.js';
import { useForm } from './use-form.js';
// 稳定设备形态(与窗口宽解耦):旋转联动的门卫与手机横屏沉浸态判定用,
// 不能按 form——旋转瞬间宽度跨 768 断点 form 会翻转(大屏手机横屏→pad、
// 小平板竖屏→phone),设备类型语义的判定必须恒定
import { isPadDevice, isImmersiveLandscape } from './device-class.js';
import { videoPath } from './open-video.js';
import { usePlaybackProgress } from '../hooks/use-playback-progress.js';
import VideoPlayer from '../components/player/VideoPlayer'; // 平台分流:web=.web.js(hls.js),native=.js(expo-video)
import SurfaceCard from '../components/player/SurfaceCard.jsx';
import { ABS_FILL } from './abs-fill.js';
import {
  createStagePanMotion,
  stageDragOffset,
  stageLayoutForTarget,
  stageRectWithPan,
} from './player-stage-motion.js';

const PlayerContext = createContext(null);
// 舞台插槽上下文:独立小上下文只携带舞台元素本身,AppShell 经 <PlayerStageSlot/>
// 消费渲染。不并入主 PlayerContext value:舞台元素随 rect/相位高频换代,并进去
// 会把全体 usePlayer 消费方一起拖着重渲染;独立上下文让换新只波及插槽子树
const PlayerStageContext = createContext(null);

// 形变/吸附动画参数(YouTube 观感:~320ms 减速曲线,松手滑角 ~240ms)
const NATIVE = Platform.OS !== 'web'; // native 端 transform 动画走原生驱动
const MORPH_MS = 320;
const CORRECT_MS = 160; // docked 态几何修正(剧场切换/resize)
const SNAP_MS = 240; // 拖动松手滑向角落
const FLING_VY = 1.6; // 快甩关闭阈值(px/ms,向下)
const DRAG_SLOP = 6; // 拖动起判位移(px;小于此算点按)

// rect 等价判定(报告/修正用,亚像素抖动不算变化)
function sameRect(a, b) {
  return (
    !!a && !!b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5
  );
}

export function PlayerProvider({ children }) {
  // ===== 会话与解析态 =====
  const [session, setSession] = useState(null); // { site,id,title,cover,duration,hd } | null
  const [src, setSrc] = useState(null); // { type:'hls'|'mp4', url, key, startAt } | null
  const [phase, setPhase] = useState('idle'); // idle | resolving | ready | error
  const [errMsg, setErrMsg] = useState('');
  const [retryKey, setRetryKey] = useState(0); // 重试轮次(同 url 强制换源用)

  const tokenRef = useRef(0); // 解析竞态令牌(过期响应作废)
  // 会话元信息镜像(render 期刷新):解析成功顺手 recordView 要取「此刻最新」的
  // 标题/封面——异步解析闭包捕获的 session 对象在观看页详情 meta open 之后是
  // 旧引用(title 尚空),直接用会把空标题写进观看足迹
  const sessionMetaRef = useRef(null);
  sessionMetaRef.current = session;
  const releasePendingRef = useRef(false); // close() 的延后销毁标记(native)
  const playerRef = useRef(null); // native 共享 expo-video 实例(实例上提,跨页不断流)
  const instanceRef = useRef(null); // VideoPlayer 暴露的共享实例(Provider 经它 pause/读进度)
  const progressRef = useRef(null); // 进度 hook 的最新方法镜像(effect 闭包防过期)
  // 播放事件订阅表(观看页连播倒计时等监听 'ended' 用)
  const listenersRef = useRef({ ended: new Set(), close: new Set() });

  // ===== 舞台几何与相位 =====
  // uiPhase: hidden | entering | mini | expanding | docked | shrinking
  const [uiPhase, setUiPhaseState] = useState('hidden');
  const phaseRef = useRef('hidden');
  // FLIP 形变在途标记:transform 数组只在在途时挂载,静止态(entering 淡入/
  // docked/mini 落定)舞台零 scale 变换——原生视频视图祖先链上恒挂 transform
  // 时 iOS 画面帧不随层同步(黑屏有声),落定即撤、下形变再挂
  const [morphing, setMorphing] = useState(false);
  const setUiPhase = useCallback((v) => {
    phaseRef.current = v;
    setUiPhaseState(v);
  }, []);
  const [rect, setRect] = useState(null); // 舞台布局基点 { x,y,w,h,r };实际位置还需加常驻 pan
  const rectRef = useRef(null); // 布局基点镜像(手势/动画回调里读最新值)
  const miniCornerRef = useRef('br');
  // L1 始终绑定同一组 JS 平移节点，松手只停动画、不重基 rect、不清零 pan。
  // Fabric 的 setNativeProps 与 Fiber 样式快照异步；动画值换成静态 0 时，
  // React 可能省略这次清零，旧偏移叠在新布局上会把窗口移出屏幕。
  const [dockRect, setDockRect] = useState(null); // 观看页锚点最近一次上报
  const [dockNudge, setDockNudge] = useState(0); // 锚点重测触发器(滚动结束等)
  const [dockOverlays, setDockOverlays] = useState({}); // dock 覆盖槽 { back, countdown }
  const scrollBaseRef = useRef(null); // 滚动跟随:上报基线(锚点 rect 对应的 offset)
  const scrollDeltaRef = useRef(0); // 滚动跟随:当前累计差(镜像 anim.scroll 的负值)
  const morphInfoRef = useRef(null); // 在途形变元数据(native 驱动下 JS 读不到逐帧值,自算插值)
  const hadSessionRef = useRef(false); // 会话生命周期边沿(进场复位动画值)
  // 应用内全屏的同步镜像(提前声明:reportDockScroll 等较早定义的回调也要读
  // 它们判「全屏态舞台钉死整窗」;state 与状态机集中在下方全屏区块)
  const playerFsRef = useRef(false);
  const webFsRef = useRef(false);

  // ===== 舞台动画值(三层:布局层静态;形变层 FLIP;拖拽层 pan+scroll)=====
  // 形变层是常驻节点图:progress 单值(0→1 缓动)同时驱动四路输出
  //   tx = fromTx·(1-p)、sx = 1-(1-p)·(1-fromSx)……(p=1 → tx=0、sx=1,恒等)
  // 每次形变只写起点(from*)再起 1 个 timing。相比 4 个并行 timing:
  //   · web(JS 驱动)每帧回调 4→1,形变期 JS 占用约降 3/4(卡顿主源);
  //   · native 端整图随 useNativeDriver 落 UI 线程求值,帧率不受 JS 忙碌影响;
  //   · 终点由图结构保证恒等,「缩放被驱动到 0」一类终点错配不可能复发。
  const anim = useMemo(() => {
    const ONE = new Animated.Value(1);
    const NEG1 = new Animated.Value(-1);
    const progress = new Animated.Value(1); // 1=恒等(未在形变/已落定)
    const fromTx = new Animated.Value(0);
    const fromTy = new Animated.Value(0);
    const fromSx = new Animated.Value(1);
    const fromSy = new Animated.Value(1);
    const inv = Animated.add(ONE, Animated.multiply(progress, NEG1)); // 1-p
    return {
      progress, fromTx, fromTy, fromSx, fromSy,
      tx: Animated.multiply(fromTx, inv),
      ty: Animated.multiply(fromTy, inv),
      sx: Animated.subtract(ONE, Animated.multiply(inv, Animated.subtract(ONE, fromSx))),
      sy: Animated.subtract(ONE, Animated.multiply(inv, Animated.subtract(ONE, fromSy))),
      stageOpacity: new Animated.Value(1), // 整体淡入(新会话进场/快甩关闭)
      panX: new Animated.Value(0), // 拖拽位移(JS 驱动,PanResponder 直写)
      panY: new Animated.Value(0),
      scroll: new Animated.Value(0), // docked 滚动跟随 translateY(负值)
      ctrl: new Animated.Value(0), // mini 控件(暂停/关闭)透明度
    };
  }, []);
  const panMotion = useMemo(() => createStagePanMotion(anim), [anim]);
  const placedRect = useCallback(
    () => stageRectWithPan(rectRef.current, anim.panX.__getValue(), anim.panY.__getValue()),
    [anim]
  );

  // ===== 路由感知(与旧口径一致)=====
  const pathname = usePathname();
  const isWatch = !!pathname && pathname.startsWith('/video/');

  // ===== 悬浮窗角落槽位(主题无关的纯几何)=====
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  const { form } = useForm();
  const miniRectOf = useCallback(
    (corner) => {
      const mSide = form === 'phone' ? 12 : 24;
      const w = Math.round(Math.min(winW - mSide * 2, 400));
      const h = Math.round((w * 9) / 16);
      const topY = insets.top + 12;
      const botY = Math.max(topY, Math.round(winH - insets.bottom - (form === 'phone' ? 72 : 24) - h));
      const x = corner === 'tl' || corner === 'bl' ? mSide : Math.round(winW - mSide - w);
      const y = corner === 'tl' || corner === 'tr' ? topY : botY;
      return { x, y, w, h, r: 12 };
    },
    [winW, winH, insets.top, insets.bottom, form]
  );
  const miniRectOfRef = useRef(miniRectOf);
  miniRectOfRef.current = miniRectOf;

  // ===== 舞台当前视觉位(含在途形变插值/拖拽偏移/滚动差)=====
  // native 驱动的 timing 不回写 JS 侧 Value,在途时按元数据自算(Easing.out(cubic));
  // 拖拽/滚动值恒 JS 驱动,__getValue 可靠。
  const visualNow = useCallback(() => {
    const r = rectRef.current;
    if (!r) return null;
    let tx = anim.tx.__getValue();
    let ty = anim.ty.__getValue();
    let sx = anim.sx.__getValue();
    let sy = anim.sy.__getValue();
    const mi = morphInfoRef.current;
    if (mi) {
      const p = Math.min(1, Math.max(0, (Date.now() - mi.t0) / mi.dur));
      const e = 1 - Math.pow(1 - p, 3); // 与 Easing.out(Easing.cubic) 同式
      tx = mi.fromTx * (1 - e);
      ty = mi.fromTy * (1 - e);
      sx = mi.fromSx + (1 - mi.fromSx) * e;
      sy = mi.fromSy + (1 - mi.fromSy) * e;
    }
    const px = anim.panX.__getValue();
    const py = anim.panY.__getValue();
    return {
      x: r.x + tx + px,
      y: r.y + ty + py - scrollDeltaRef.current,
      w: r.w * sx,
      h: r.h * sy,
    };
  }, [anim]);

  // ===== FLIP 形变:布局一步落位到目标,transform 反演回起点再归零 =====
  const commitRect = useCallback((r) => {
    rectRef.current = r;
    setRect(r);
  }, []);
  const morphAnimStopRef = useRef(null); // 在途形变的 stop 句柄(重定向前先停)
  const stopMorph = useCallback(() => {
    const stop = morphAnimStopRef.current;
    morphAnimStopRef.current = null; // stop 可能同步调用完成回调，先作废身份
    if (stop) stop();
    morphInfoRef.current = null;
  }, []);
  const animateTo = useCallback(
    (target, opts = {}) => {
      const dur = opts.duration || MORPH_MS;
      panMotion.stop(); // 先作废旧吸附/甩关回调，再停其动画
      const from = visualNow();
      stopMorph();
      // pan 始终挂在 L1 上；目标布局扣除现有偏移，形变期间也无需摘挂或清零。
      const layout = stageLayoutForTarget(target, anim.panX.__getValue(), anim.panY.__getValue());
      if (!from) {
        commitRect(layout);
        if (opts.onDone) opts.onDone(true);
        return;
      }
      const tw = Math.max(target.w, 1);
      const th = Math.max(target.h, 1);
      const fromTx = from.x - target.x;
      const fromTy = from.y - target.y;
      const fromSx = Math.max(from.w, 1) / tw;
      const fromSy = Math.max(from.h, 1) / th;
      anim.fromTx.setValue(fromTx);
      anim.fromTy.setValue(fromTy);
      anim.fromSx.setValue(fromSx);
      anim.fromSy.setValue(fromSy);
      anim.progress.setValue(0);
      // 形变期停用滚动跟随(from 已含滚动差;新观看页滚动恒从 0 起)
      anim.scroll.setValue(0);
      scrollDeltaRef.current = 0;
      scrollBaseRef.current = null;
      commitRect(layout);
      morphInfoRef.current = { t0: Date.now(), dur, fromTx, fromTy, fromSx, fromSy };
      // 单 timing 驱动 progress:web 端每帧只剩 1 个 JS 回调(此前 4 个并行
      // timing 各自跑 rAF,是形变卡顿的主源);p=1 时节点图输出恒等
      // (tx=0、sx=1),落定即恒等变换——历史回归(缩放被驱动到 0、舞台
      // 途中坍缩成点再弹回)在图结构上不可能复发
      const run = Animated.timing(anim.progress, {
        toValue: 1,
        duration: dur,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: NATIVE,
      });
      const stop = () => run.stop();
      morphAnimStopRef.current = stop;
      // 变换数组随本批渲染挂上(与上方 commitRect 同一次提交:布局落目标位 +
      // transform 反演回起点,首帧视觉即起点,不闪目标位)
      setMorphing(true);
      run.start(({ finished }) => {
        if (morphAnimStopRef.current !== stop) return;
        morphAnimStopRef.current = null;
        morphInfoRef.current = null;
        if (finished) anim.progress.setValue(1);
        // 落定撤变换:静止态视频祖先链零 scale(iOS 视频帧同步),重定向时
        // animateTo 会紧接着再置 true,批内末值生效
        setMorphing(false);
        if (opts.onDone) opts.onDone(finished);
      });
    },
    [anim, commitRect, panMotion, visualNow]
  );

  // ===== 缩小回悬浮窗(编排返回与兜底共用)=====
  const startShrink = useCallback(
    (after) => {
      // docked 之外的三个可缩相位:expanding(展开途中折返/离开观看页——
      // 从当前视觉位继续缩小,不滞留全屏)/entering(进场未完即退)/
      // shrinking 自身(重复触发按新目标重定向)
      const ph = phaseRef.current;
      if (ph !== 'docked' && ph !== 'expanding' && ph !== 'entering' && ph !== 'shrinking') {
        if (after) after();
        return;
      }
      setUiPhase('shrinking');
      const target = miniRectOfRef.current(miniCornerRef.current);
      animateTo(target, {
        duration: MORPH_MS,
        onDone: () => {
          if (phaseRef.current !== 'shrinking') return; // 中途被重定向
          setUiPhase('mini');
          if (after) after();
        },
      });
    },
    [animateTo, setUiPhase]
  );
  const shrinkRef = useRef(startShrink);
  shrinkRef.current = startShrink;
  const beginShrinkThenBack = useCallback((backFn) => {
    shrinkRef.current(backFn);
  }, []);

  // ===== 锚点上报(观看页 PlayerDock → 舞台)=====
  const reportDockRect = useCallback(
    (r) => {
      // 新 rect 已含当前滚动位置:先把「落定位」平移到当前视觉位(视觉连续),
      // 滚动差清零,几何修正 effect 再决定是否平滑过渡(剧场切换等)。
      const delta = scrollDeltaRef.current;
      scrollDeltaRef.current = 0;
      anim.scroll.setValue(0);
      if (rectRef.current && delta) {
        commitRect({ ...rectRef.current, y: rectRef.current.y - delta });
      }
      setDockRect((prev) => (sameRect(prev, r) ? prev : r));
    },
    [anim, commitRect]
  );

  // ===== 滚动跟随(观看页 onScroll → 舞台 translateY)=====
  const reportDockScroll = useCallback(
    (offset) => {
      // 全屏态舞台钉死整窗,不跟随页面滚动——全屏下页面被舞台盖住,web 端仍
      // 可能有 wheel 滚动事件穿透进来,跟随会把整屏舞台拖走
      if (playerFsRef.current || webFsRef.current) return;
      if (scrollBaseRef.current == null) scrollBaseRef.current = offset;
      const d = offset - scrollBaseRef.current; // 可负:上滚跟回
      scrollDeltaRef.current = d;
      anim.scroll.setValue(-d);
    },
    [anim]
  );
  const endDockScroll = useCallback(() => {
    scrollBaseRef.current = null; // 下次滚动事件重建基线
    setDockNudge((n) => n + 1); // 触发锚点重测:测得即已滚后位置,report 内同步清差
  }, []);

  // ===== dock 覆盖槽(返回箭头/连播倒计时等压在视频之上的浮层)=====
  const setDockOverlay = useCallback((name, node) => {
    setDockOverlays((prev) => (prev[name] === node ? prev : { ...prev, [name]: node }));
  }, []);
  // 按属主条件清除:槽位当前值仍是 expectNode 才清——video→video 压栈/返回时
  // 同名槽被多页先后写,卸载清理若无条件置 null 会把新聚焦页刚注册的节点顶掉
  // (focus/blur 派发顺序两说,顺序无关才稳)
  const clearDockOverlay = useCallback((name, expectNode) => {
    setDockOverlays((prev) => (prev[name] === expectNode ? { ...prev, [name]: null } : prev));
  }, []);

  // ===== 进度落盘/续播(包装 history)=====
  const { save: saveProgressT, flush: flushProgress, restore: restoreProgress } = usePlaybackProgress(
    session ? session.site : undefined,
    session ? session.id : undefined
  );
  progressRef.current = { save: saveProgressT, flush: flushProgress, restore: restoreProgress };

  // ===== 事件广播(小事件总线:'ended'/'close')=====
  const emit = useCallback((name) => {
    listenersRef.current[name].forEach((fn) => {
      try {
        fn();
      } catch (_e) {
        /* 订阅方异常不外溢 */
      }
    });
  }, []);
  const subscribe = useCallback((name, fn) => {
    if (!listenersRef.current[name] || typeof fn !== 'function') {
      return () => {};
    }
    listenersRef.current[name].add(fn);
    return () => {
      listenersRef.current[name].delete(fn);
    };
  }, []);

  // ===== 会话写入(契约 open):site/id 相同的重开只刷新元信息,不重解析 =====
  const open = useCallback((item) => {
    if (!item || item.site == null || item.id == null) return;
    setSession((prev) => {
      if (prev && prev.site === String(item.site) && String(prev.id) === String(item.id)) {
        // 同片重开:仅补标题/封面等元信息(解析 effect 依赖 site/id,不会重跑)
        return {
          site: prev.site,
          id: prev.id,
          title: item.title || prev.title,
          cover: item.cover || prev.cover,
          duration: item.duration != null ? item.duration : prev.duration,
          hd: item.hd != null ? !!item.hd : prev.hd,
        };
      }
      return {
        site: String(item.site),
        id: item.id,
        title: item.title || '',
        cover: item.cover || '',
        duration: item.duration != null ? item.duration : null,
        hd: !!item.hd,
      };
    });
  }, []);

  // ===== 关闭会话(契约 close):兜底落进度 + 销毁播放实例 =====
  const close = useCallback(() => {
    panMotion.stop();
    stopMorph();
    // 先让内核停播(防销毁窗口的幽灵声音),再落进度
    const inst = instanceRef.current;
    if (inst && typeof inst.pause === 'function') {
      try {
        inst.pause();
      } catch (_e) {
        /* 忽略 */
      }
    }
    try {
      if (progressRef.current) progressRef.current.flush();
    } catch (_e) {
      /* 忽略 */
    }
    // native:共享实例延后到会话清空的 commit 之后再 release(见下方 effect)——
    // 立即 release 的话,卸载中的 VideoView 仍引用着已释放的实例,原生侧清理
    // 可能踩到悬空引用;先标记,提交完再销毁
    if (Platform.OS !== 'web' && playerRef.current) releasePendingRef.current = true;
    instanceRef.current = null;
    setSession(null);
    setSrc(null);
    setPhase('idle');
    setErrMsg('');
    emit('close');
  }, [emit, panMotion]);

  // close() 的延后销毁:会话已清空的渲染提交之后,再释放 native 共享实例
  useEffect(() => {
    if (!session && releasePendingRef.current) {
      releasePendingRef.current = false;
      if (playerRef.current) {
        try {
          playerRef.current.pause();
        } catch (_e) {
          /* 忽略 */
        }
        try {
          playerRef.current.release(); // release 后不可再用,下次 open 重建
        } catch (_e) {
          /* 忽略 */
        }
        playerRef.current = null;
      }
    }
  }, [session]);

  // ===== 重试:重走解析(播放中断/解析失败共用一个入口)=====
  const retry = useCallback(() => {
    setRetryKey((k) => k + 1);
  }, []);

  // ===== 播放源解析:会话 site/id 或重试轮变化时重走(单次请求,无轮询)=====
  useEffect(() => {
    if (!session) {
      setSrc(null);
      setPhase('idle');
      return;
    }
    let alive = true;
    const my = ++tokenRef.current;
    // 换源先停旧流:共享实例常驻 Provider,不主动暂停的话解析期间旧片会一直出声
    const inst = instanceRef.current;
    if (inst && typeof inst.pause === 'function') {
      try {
        inst.pause();
      } catch (_e) {
        /* 忽略 */
      }
    }
    if (Platform.OS !== 'web' && playerRef.current) {
      try {
        playerRef.current.pause();
      } catch (_e) {
        /* 忽略 */
      }
    }
    setSrc(null);
    setPhase('resolving');
    setErrMsg('');
    (async () => {
      try {
        const r = await api(session.site, 'play', { id: session.id });
        if (!alive || tokenRef.current !== my) return; // 过期响应作废
        if (!r || !r.url) throw new Error('播放地址为空');
        // 三端无同源概念:相对地址(/api 代理类)一律绝对化;分片池启用时
        // telegram 代理流改走池首 origin(端口表首位 = 主端口,与基址一致时
        // 零差异;池未启用/非分片地址 → null 回落既有单基址绝对化)
        const url = shardMediaUrl(r.url, 0) || absolutizeUrl(r.url);
        // 续播判定:命中本地进度则从该处起播(restore 为 AsyncStorage 异步读,
        // await 后经令牌校验再用;太靠前/已看完的 restore 自行判 null)
        let startAt = 0;
        try {
          const p = progressRef.current ? await progressRef.current.restore() : null;
          if (!alive || tokenRef.current !== my) return; // 等待期间会话已换:作废
          if (p && p.t > 0) startAt = p.t;
        } catch (_e) {
          startAt = 0;
        }
        setSrc({
          type: r.type === 'mp4' ? 'mp4' : 'hls',
          url,
          key: retryKey,
          startAt,
        });
        setPhase('ready');
        // 观看足迹:解析成功即记(字段取 sessionMetaRef 的最新元信息)
        try {
          const s = sessionMetaRef.current || session;
          recordView(s.site, {
            id: s.id,
            title: s.title || '',
            cover: s.cover || '',
            duration: s.duration != null ? s.duration : null,
            hd: !!s.hd,
          });
        } catch (_e) {
          /* 本地存储异常不苛求 */
        }
      } catch (e) {
        if (!alive || tokenRef.current !== my) return;
        setPhase('error');
        setErrMsg((e && e.message) || '播放地址解析失败');
      }
    })();
    return () => {
      alive = false;
    };
    // 依赖取原始字段(session 对象每次 setSession 都是新引用,靠字段值判等)
  }, [session && session.site, session && session.id, retryKey]);

  // ===== 播放回调(稳定引用,videoProps 不因它们重建)=====
  const onProgressCb = useCallback((sec, dur) => {
    if (progressRef.current) progressRef.current.save(sec, dur);
  }, []);
  const onFlushCb = useCallback(() => {
    if (progressRef.current) progressRef.current.flush();
  }, []);
  const onEndedCb = useCallback(() => {
    emit('ended'); // 观看页的 5s 倒计时连播从这里起步
  }, [emit]);
  const onRetryCb = useCallback(() => {
    setRetryKey((k) => k + 1);
  }, []);

  // ===== native 共享实例:懒建单例(实例上提,归 Provider 所有)=====
  const ensureNativePlayer = useCallback(() => {
    if (Platform.OS === 'web') return null;
    if (!playerRef.current) {
      playerRef.current = createVideoPlayer(null);
      try {
        playerRef.current.timeUpdateEventInterval = 0.5;
      } catch (_e) {
        /* 忽略 */
      }
    }
    return playerRef.current;
  }, []);
  // Provider 卸载兜底释放
  useEffect(
    () => () => {
      if (playerRef.current) {
        try {
          playerRef.current.release();
        } catch (_e) {
          /* 忽略 */
        }
        playerRef.current = null;
      }
    },
    []
  );

  // ===== 应用内全屏(native 主导;web 伪全屏经 onFakeFullscreenChange 联动)=====
  // 不走 expo-video 的 VideoView.enterFullscreen——那会把视频表面提进原生
  // 呈现层(RN 窗口之上),自定义控件层留在普通窗口里跟不过去(全屏即「裸
  // 视频」,Android 下 JS 还会被暂停)。改为「方向策略 + 舞台直切几何」:
  //   · 进:按视频画幅锁向(横幅 LANDSCAPE 随传感器双向 / 竖幅 PORTRAIT_UP
  //     不旋转,TikTok 式竖屏铺满;画幅未知回退当前窗口方向,不硬编码横屏);
  //     舞台目标恒为整窗 rect,不依赖锚点测量——旋转在途 measure 的竞态由
  //     此根治(旧版横屏右侧大片黑边/退出无反应的本源);
  //   · 退:恢复进入前方向(竖屏进入 → 锁回竖 + ~1s 后放开传感器;横屏进入
  //     → 直接解锁),并立即 nudge 锚点重测回 dock;
  //   · 物理旋转联动:观看位转横自动进全屏、回竖且全屏由旋转进入时自动退
  //     (按钮进入的不随旋转退出);退全屏后 1.5s 联动冷却,防恢复竖屏的
  //     延迟解锁回波把刚退出的全屏又拉回去(af-video-player 同款思路)。
  const [playerFs, setPlayerFs] = useState(false);
  const [webFs, setWebFs] = useState(false); // web 伪全屏(iPhone Safari 等不支持容器全屏 API 时由 VideoPlayer.web 上报)
  const preFsLandscapeRef = useRef(false); // 进入前屏幕方向(退出恢复用)
  const byRotateRef = useRef(false); // 本次全屏是否由旋转联动进入(退出联动判据)
  const rotateGateUntilRef = useRef(0); // 旋转联动冷却窗(时间戳)
  const videoLandscapeRef = useRef(null); // 视频画幅缓存(null 未知/true 横/false 竖)
  const fsLockedLandscapeRef = useRef(true); // 本次全屏落锁的画幅(全屏中换片重锁用)

  const applyWebFs = useCallback((v) => {
    webFsRef.current = !!v;
    setWebFs(!!v);
    if (!v) setDockNudge((n) => n + 1); // 退出伪全屏:锚点立即重测回 dock(与 native 退屏同款兜底)
  }, []);

  // 视频画幅缓存:源就绪起持续维护(sourceLoad/videoTrackChange,WallTile 同款
  // 读法)。横竖口径:宽高比 ≥1:1(含等边——1:1、1.1:1 都算)即横屏,只有
  // 明显竖幅(如 9:16)才判竖——站方内容横幅为绝对主流,从严判竖
  useEffect(() => {
    if (Platform.OS === 'web' || !src) return;
    const p = playerRef.current;
    if (!p || !p.addListener) return;
    const read = () => {
      try {
        const vt = p.videoTrack;
        const w = vt && vt.size ? vt.size.width : 0;
        const h = vt && vt.size ? vt.size.height : 0;
        if (w > 0 && h > 0) videoLandscapeRef.current = w >= h;
      } catch (_e) {
        /* track 未就绪:等下一个事件 */
      }
    };
    read();
    const subs = ['sourceLoad', 'videoTrackChange'].map((ev) => p.addListener(ev, read));
    return () => {
      subs.forEach((s) => {
        try {
          s.remove();
        } catch (_e) {
          /* 忽略 */
        }
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src && src.url, src && src.key]);

  const enterPlayerFs = useCallback(
    (opts = {}) => {
      if (playerFsRef.current) return;
      const byRotate = !!opts.byRotate;
      const winLandscape = winW > winH;
      // 画幅补读:个别源(不报 track 的 HLS)事件一直不报,进全屏时同步再读
      // 一次实例——拿到即用(≥1:1 即横屏口径,与缓存 effect 一致)
      if (videoLandscapeRef.current == null && playerRef.current) {
        try {
          const vt = playerRef.current.videoTrack;
          const vw = vt && vt.size ? vt.size.width : 0;
          const vh = vt && vt.size ? vt.size.height : 0;
          if (vw > 0 && vh > 0) videoLandscapeRef.current = vw >= vh;
        } catch (_e) {
          /* track 未就绪:走下方兜底口径 */
        }
      }
      // 锁向:按钮进入按视频画幅;仍拿不到按横屏兜底(横幅是站方内容绝对
      // 主流,真竖幅源基本都会报 track;万一误判,全屏中换片重锁 effect 会按
      // 真实 track 自动拧回)。旋转联动进入跟随用户刚转到的方向(竖幅视频在
      // 横屏全屏=contain 黑边,尊重姿势不拧回)
      const landscape = byRotate
        ? (opts.landscape != null ? !!opts.landscape : winLandscape)
        : videoLandscapeRef.current != null
          ? videoLandscapeRef.current
          : true;
      // 进入前方向存档:旋转联动时窗口宽高可能尚未跟上事件,按事件值反推
      preFsLandscapeRef.current = byRotate && opts.landscape != null ? !opts.landscape : winLandscape;
      byRotateRef.current = byRotate;
      fsLockedLandscapeRef.current = landscape;
      playerFsRef.current = true;
      setPlayerFs(true);
      // 锁向只对按钮进入落锁:旋转联动进入保持传感器自由——用户转回竖屏时
      // 系统才会真旋转、方向事件才会派发,「回竖自动退全屏」依赖它(落锁
      // LANDSCAPE 会把屏幕钉死横屏,转回竖屏无事件,退出联动失效)
      if (!byRotate) lockForVideo(landscape);
    },
    [winW, winH]
  );

  const exitPlayerFs = useCallback(() => {
    if (!playerFsRef.current) return;
    playerFsRef.current = false;
    setPlayerFs(false);
    restoreAfterFullscreen(preFsLandscapeRef.current);
    // 锚点立即重测:页面回常态布局锚点几何即变,不等视口变化(旧版退出后
    // 舞台停在旧 rect「点了没反应」的兜底)
    setDockNudge((n) => n + 1);
    // 旋转联动冷却:恢复竖屏的延迟解锁放开的瞬间,横握的设备会再翻横——
    // 短窗内不响应联动,避免「退出→被拉回全屏」的乒乓
    rotateGateUntilRef.current = Date.now() + 1500;
  }, []);

  const togglePlayerFs = useCallback(() => {
    if (playerFsRef.current) exitPlayerFs();
    else enterPlayerFs();
  }, [enterPlayerFs, exitPlayerFs]);

  // 离场兜底:相位离开观看位(缩悬浮窗/快甩关闭/会话清空)必须退全屏+恢复
  // 方向,否则悬浮窗/首页会被锁在横屏。video→video 同栈换片相位不动,全屏保留
  useEffect(() => {
    const left = uiPhase === 'mini' || uiPhase === 'shrinking' || uiPhase === 'hidden';
    if (left && playerFsRef.current) exitPlayerFs();
    if (left && webFsRef.current) applyWebFs(false);
  }, [uiPhase, exitPlayerFs, applyWebFs]);

  // Android 返回键:全屏态先退全屏,不退页面
  useEffect(() => {
    if (Platform.OS !== 'android' || !playerFs) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      exitPlayerFs();
      return true;
    });
    return () => sub.remove();
  }, [playerFs, exitPlayerFs]);

  // 物理旋转 ↔ 全屏联动(native 手机;NewPipe checkLandscape / video.js
  // mobile-ui enterOnRotate·exitOnRotate 模式):观看位转横自动进全屏,回竖
  // 且全屏由旋转进入时自动退出。自己进全屏落锁引起的方向回波天然无歧义
  // (联动进入只看非全屏态、联动退出只看 byRotate 全屏),冷却窗再挡掉退屏
  // 恢复段传感器的回翻;平板不联动(横屏是桌面形态 land 布局,不是全屏诉求)。
  // 门卫用稳定设备形态:旧版按 form 门卫,旋转瞬间宽度跨 768 断点 form 翻转 →
  // effect 重跑拆订阅,与方向事件派发赛跑——大屏手机(横屏宽 844~932)「转横
  // 不进全屏/转竖不退出」,小平板(竖屏宽<768)则误联动「一转横突然进全屏」
  // 且转回后订阅已拆、方向又被锁横,被困在全屏。联动动作走 latest-ref,deps
  // 只剩恒定布尔——订阅整个 Provider 生命周期只挂一次,旋转全程在场
  const phoneDevice = Platform.OS !== 'web' && !isPadDevice();
  const rotateApiRef = useRef(null);
  rotateApiRef.current = { isWatch, enterPlayerFs, exitPlayerFs };
  useEffect(() => {
    if (!phoneDevice) return;
    return subscribeOrientation((landscape) => {
      const api = rotateApiRef.current;
      if (!api) return;
      if (Date.now() < rotateGateUntilRef.current) return;
      if (landscape) {
        if (!playerFsRef.current && api.isWatch && phaseRef.current === 'docked') {
          api.enterPlayerFs({ byRotate: true, landscape: true });
        }
      } else if (playerFsRef.current && byRotateRef.current) {
        api.exitPlayerFs();
      }
    });
  }, [phoneDevice]);

  // 竖屏早退:视口宽高随旋转提交即翻转(useWindowDimensions 派发不晚于方向
  // 事件,而 addOrientationChangeListener 要等系统旋转完成),byRotate 全屏在
  // 此刻直接退——不再先经几何 effect 把全屏舞台重排成竖屏整窗(letterbox
  // 闪现)再等方向事件,「先竖屏才退出全屏」的滞后观感由此消除。方向监听的
  // 退出分支保留为兜底(经 playerFsRef 幂等)
  useEffect(() => {
    if (!phoneDevice) return;
    if (winH > winW && playerFsRef.current && byRotateRef.current) exitPlayerFs();
  }, [phoneDevice, winW, winH, exitPlayerFs]);

  // 全屏中换片(连播/选集)画幅横竖翻转 → 方向重锁(同向不折腾,不反复触发
  // 原生锁);监听随 playerFs 变 false 一并卸载。也是「按钮进入时画幅未知按
  // 横屏兜底」的自愈路径:真实 track 一到,与落锁画幅不符即拧回。
  // byRotate 会话跳过:旋转联动进入未落锁(保持传感器自由供回竖退出联动),
  // 此处落锁会把屏幕钉死,退出联动失效
  useEffect(() => {
    if (!playerFs || Platform.OS === 'web' || byRotateRef.current) return;
    const p = playerRef.current;
    if (!p || !p.addListener) return;
    const sub = p.addListener('videoTrackChange', () => {
      try {
        const vt = p.videoTrack;
        const w = vt && vt.size ? vt.size.width : 0;
        const h = vt && vt.size ? vt.size.height : 0;
        if (w <= 0 || h <= 0) return;
        const landscape = w >= h; // ≥1:1(含等边)即横屏,与缓存口径一致
        videoLandscapeRef.current = landscape;
        if (landscape !== fsLockedLandscapeRef.current) {
          fsLockedLandscapeRef.current = landscape;
          lockForVideo(landscape);
        }
      } catch (_e) {
        /* track 未就绪:等下一个事件 */
      }
    });
    return () => {
      try {
        sub.remove();
      } catch (_e) {
        /* 忽略 */
      }
    };
  }, [playerFs]);

  // ===== 舞台直喂 VideoPlayer 的 props 包 =====
  const videoProps = useMemo(() => {
    if (!session || !src) return null;
    return {
      source: { type: src.type, url: src.url, key: src.key },
      poster: session.cover ? absolutizeUrl(session.cover) : '',
      startAt: src.startAt || 0,
      autoplay: true,
      controls: true, // 舞台按 uiPhase 覆盖:docked 出全量控件,其余不出
      title: session.title || '',
      style: { flex: 1 },
      onProgress: onProgressCb,
      onFlush: onFlushCb,
      onEnded: onEndedCb,
      onRetry: onRetryCb,
      instanceRef,
      // native:共享实例注入(实例上提);web:忽略(实例即舞台里常驻的 video 元素)
      player: Platform.OS === 'web' ? null : ensureNativePlayer(),
      // native:应用内全屏由 Provider 主导(观看页沉浸布局/AppShell 收顶栏与本
      // props 三方共用 playerFs);web 的全屏是 VideoPlayer.web.js 容器
      // requestFullscreen 自管(真全屏不注入避免双头),伪全屏(fake fullscreen,
      // iPhone Safari 等)的「舞台整窗几何」经 onFakeFullscreenChange 上报本
      // Provider 联动。immersive=舞台处于 edge-to-edge 沉浸态(全屏钮 或 手机
      // 横屏 landfs——平板横屏是 land 分栏布局,非沉浸)——观看页沉浸分支已不垫
      // 安全区,控件层/浮层据此自垫;与 fullscreen 分开(全屏钮图标/切换语义
      // 只归 fullscreen)
      ...(Platform.OS === 'web'
        ? { onFakeFullscreenChange: applyWebFs }
        : {
            fullscreen: playerFs,
            onToggleFullscreen: togglePlayerFs,
            immersive:
              playerFs || (isWatch && isImmersiveLandscape(winW, winH)),
          }),
    };
  }, [session, src, onProgressCb, onFlushCb, onEndedCb, onRetryCb, ensureNativePlayer, playerFs, togglePlayerFs, applyWebFs, isWatch, winW, winH]);

  // ===== 会话生命周期:进场复位动画值/退场清相位 =====
  useEffect(() => {
    if (session && !hadSessionRef.current) {
      hadSessionRef.current = true;
      anim.progress.setValue(1); // 形变图归恒等(输出即 tx=0/sx=1)
      anim.panX.setValue(0);
      anim.panY.setValue(0);
      anim.scroll.setValue(0);
      anim.ctrl.setValue(0);
      anim.stageOpacity.setValue(1);
      morphInfoRef.current = null;
    }
    if (!session) {
      hadSessionRef.current = false;
      phaseRef.current = 'hidden';
      setUiPhaseState('hidden');
      setMorphing(false);
      rectRef.current = null;
      setRect(null);
      setDockRect(null);
      miniCornerRef.current = 'br';
      setDockOverlays({});
      scrollBaseRef.current = null;
      scrollDeltaRef.current = 0;
    }
  }, [session, anim]);

  useEffect(() => () => {
    panMotion.stop();
    stopMorph();
  }, [panMotion]);

  // ===== 路由驱动相位(编排返回此前已置 mini,这里兜住其余一切进出)=====
  const startShrinkRef = useRef(null);
  const closeRef = useRef(null);
  useEffect(() => {
    if (!session) return;
    const ph = phaseRef.current;
    if (isWatch) {
      if (ph === 'mini' || ph === 'shrinking') {
        // 悬浮窗展开/缩小途中折返 → 从当前视觉位继续放大(锚点到位后起跳)
        setUiPhase('expanding');
      } else if (ph === 'hidden') {
        // 新会话直开观看页(卡片进页):舞台在观看位淡入,不走变形
        setUiPhase('entering');
      }
      // docked(video→video 同栈换片)原地换源,不动
    } else {
      // 离开观看页:旧锚点 rect 作废(下次进页等新锚点上报再变形,不闪错误尺寸)
      setDockRect(null);
      if (ph === 'docked' || ph === 'entering' || ph === 'expanding') {
        // 离开观看页且未编排(切 tab/浏览器后退/URL 直跳)→ 自动缩小成悬浮窗。
        // 「退出时悬浮播放」关闭时改为直接结束播放(观看页 back() 同步跳过缩小
        // 编排,与这里收敛同一口径——暂停+落进度+清会话,不出悬浮小窗;显式
        // 「小窗播放」钮不受此开关影响)
        if (getSettingsSnapshot().miniOnExit !== false) startShrinkRef.current(null);
        else closeRef.current();
      }
    }
    // 依赖取会话字段值(对象引用每次 open 都换新)
  }, [isWatch, session && session.site, session && session.id, setUiPhase]);
  startShrinkRef.current = startShrink;
  closeRef.current = close;

  // ===== 相位 × 锚点:展开/进场/几何修正 =====
  useEffect(() => {
    if (!session) return;
    // 应用内全屏(native)与 web 伪全屏:目标恒为整窗 rect,不依赖锚点上报——
    // 进入即切,锁向旋转引起的视口变化也在此跟随修正。旋转在途 measure 竞态
    // 由此根治(旧版靠 400ms 延迟补测兜底,兜不住即横屏大片黑边/退出无反应)。
    // 手机横屏沉浸(landfs)同列:方向事件与视口重渲先后不定,playerFs 可能
    // 尚未置位——此刻就直取整窗,playerFs 随后到时 sameRect 短路,旋转全程
    // 只有一段动画(旧版先按 dock 锚点小过渡、400ms 补测再切全屏,两段跳变
    // 是旋转卡顿的主源)
    // 旋转联动全屏转竖的早退在途(竖屏早退 effect 本拍已调 exitPlayerFs,
    // playerFs 状态下一拍才翻):跳过「全屏 rect 跟随视口」重排——否则先把
    // 舞台排成竖屏整窗 letterbox 再缩回 dock,两段动画正是「先竖屏才退出
    // 全屏」的观感;停住原 rect 等 exit → dockNudge → 新锚点,一段动画直回观看位
    const rotateExitPending =
      playerFs && byRotateRef.current && phoneDevice && winH > winW;
    if (
      !rotateExitPending &&
      phaseRef.current === 'docked' &&
      (playerFs || webFs || (isWatch && isImmersiveLandscape(winW, winH)))
    ) {
      const fsRect = { x: 0, y: 0, w: winW, h: winH, r: 0 };
      if (rectRef.current && !sameRect(placedRect(), fsRect)) {
        animateTo(fsRect, { duration: CORRECT_MS, onDone: () => {} });
      }
      return;
    }
    if (rotateExitPending) return;
    if (!dockRect) return;
    const ph = phaseRef.current;
    if (ph === 'expanding') {
      animateTo(dockRect, {
        duration: MORPH_MS,
        onDone: () => {
          if (phaseRef.current !== 'expanding') return;
          setUiPhase('docked');
        },
      });
    } else if (ph === 'entering' && !rectRef.current) {
      commitRect(dockRect);
      anim.stageOpacity.setValue(0);
      Animated.timing(anim.stageOpacity, { toValue: 1, duration: 220, useNativeDriver: NATIVE }).start(
        ({ finished }) => {
          if (finished && phaseRef.current === 'entering') setUiPhase('docked');
        }
      );
    } else if (ph === 'docked' && rectRef.current && !sameRect(placedRect(), dockRect)) {
      // 旋转刚提交的 1-2 帧竞态窗:dockRect 可能仍是旧方向锚点(超出新视口
      // 的 rect 一律陈旧,400ms 补测 nudge 会重测拉回)——照旧动画会先朝错误
      // 几何过渡一拍
      if (dockRect.w > winW + 1 || dockRect.h > winH + 1) return;
      // 剧场切换/resize:观看位几何修正,短过渡
      animateTo(dockRect, { duration: CORRECT_MS, onDone: () => {} });
    }
  }, [dockRect, uiPhase, session, playerFs, webFs, isWatch, winW, winH, phoneDevice, animateTo, commitRect, placedRect, anim, setUiPhase]);

  // ===== mini 控件淡入淡出(相位切换;拖拽中由手势代码自行控制)=====
  useEffect(() => {
    if (uiPhase === 'mini') {
      Animated.timing(anim.ctrl, { toValue: 1, duration: 180, delay: 120, useNativeDriver: NATIVE }).start();
    } else {
      anim.ctrl.setValue(0);
    }
  }, [uiPhase, anim]);

  // ===== 视口/安全区变化时悬浮窗归位(比较实际位置，而非布局基点)=====
  useEffect(() => {
    if (uiPhase !== 'mini' || !(winW > 0) || !(winH > 0)) return;
    const target = miniRectOf(miniCornerRef.current);
    if (!rectRef.current) {
      commitRect(stageLayoutForTarget(target, anim.panX.__getValue(), anim.panY.__getValue()));
    } else if (!sameRect(placedRect(), target)) {
      animateTo(target, { duration: CORRECT_MS });
    }
  }, [uiPhase, winW, winH, miniRectOf, animateTo, commitRect, placedRect, anim]);

  // ===== 视口变化时 docked 锚点补测(旋转在途测位失败的兜底)=====
  // 旋转动画在途 measureInWindow 可能测得中间态坐标、或锚点相对布局恰未变化
  // 使 onLayout 不触发——舞台 rect 停在旋转前几何(横屏下右侧大片黑边的来源)。
  // 视口一变,等旋转动画落定(~400ms)再触发锚点重测(dockNudge → PlayerDock
  // 再 measure),reportDockRect → 几何修正 effect 把舞台拉回正位
  useEffect(() => {
    if (phaseRef.current !== 'docked') return;
    const t = setTimeout(() => setDockNudge((n) => n + 1), 400);
    return () => clearTimeout(t);
     
  }, [winW, winH]);

  // ===== 吸附落定仅保存角落；位置由常驻 pan 承载，不触碰布局/形变 =====
  const commitMini = useCallback(
    (corner) => {
      if (phaseRef.current !== 'mini') return;
      miniCornerRef.current = corner;
      Animated.timing(anim.ctrl, { toValue: 1, duration: 160, useNativeDriver: NATIVE }).start();
    },
    [anim]
  );

  const value = useMemo(
    () => ({
      // —— 钉死契约 ——
      current: session,
      open,
      close,
      // —— 扩展面:解析/播放(不变)——
      src, // { type,url,key,startAt } | null
      phase, // idle | resolving | ready | error
      errMsg,
      retry, // () => void 重走解析
      videoProps, // 舞台直接展开喂 <VideoPlayer {...videoProps}/>
      subscribe, // (event, cb) => 取消函数;event: 'ended' | 'close'
      // —— 扩展面:舞台编排 ——
      uiPhase, // hidden | entering | mini | expanding | docked | shrinking
      beginShrinkThenBack, // (backFn) 编排返回:内容淡出+舞台缩小完成后再 backFn()
      setDockOverlay, // (name, node) dock 覆盖槽注册(返回箭头/连播倒计时)
      clearDockOverlay, // (name, expectNode) 按属主条件清除覆盖槽(卸载清理用)
      reportDockRect, // (rect) PlayerDock 锚点上报窗口坐标(舞台停泊目标)
      dockRect, // 观看页锚点最近一次上报(窗口坐标 { x,y,w,h,r };未测到前 null)
      reportDockScroll, // (offset) 观看页 onScroll → 舞台滚动跟随
      endDockScroll, // () => 观看页滚动结束 → 锚点重测归零
      dockNudge, // 锚点重测触发器(PlayerDock 依赖它再 measure)
      // —— 扩展面:应用内全屏(native 主导;webFs=web 伪全屏)——
      playerFs, // native 全屏态(观看页沉浸布局/AppShell 收顶栏消费)
      webFs, // web 伪全屏态(iPhone Safari 等场景;与 playerFs 同消费面)
      togglePlayerFs, // () => 进/退应用内全屏(按视频画幅锁横/竖屏)
    }),
    [
      session, open, close, src, phase, errMsg, retry, videoProps, subscribe,
      uiPhase, beginShrinkThenBack, setDockOverlay, clearDockOverlay, reportDockRect, dockRect, reportDockScroll, endDockScroll, dockNudge,
      playerFs, webFs, togglePlayerFs,
    ]
  );

  // 唯一播放器舞台:session 存在即常驻;观看页与悬浮窗只是两种几何形态。
  // 元素经 PlayerStageContext 交 AppShell 渲染(层级编排见文件头)
  const stageNode = session ? (
    <PlayerStage
      uiPhase={uiPhase}
      rect={rect}
      rectRef={rectRef}
      anim={anim}
      morphing={morphing}
      panMotion={panMotion}
      session={session}
      videoProps={videoProps}
      phase={phase}
      errMsg={errMsg}
      retry={retry}
      overlays={dockOverlays}
      close={close}
      miniRectOf={miniRectOf}
      commitMini={commitMini}
      playerFs={playerFs}
    />
  ) : null;

  return (
    <PlayerContext.Provider value={value}>
      <PlayerStageContext.Provider value={stageNode}>{children}</PlayerStageContext.Provider>
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer 必须在 PlayerProvider 内使用');
  return ctx;
}

// 舞台插槽:AppShell 在「底导航之后、抽屉之前」渲染本插槽——舞台与抽屉/
// 视频墙成为同父兄弟,zIndex 编排三端统一(内容(0)<舞台(40)<抽屉遮罩(40,
// 后置)<抽屉(50)<视频墙(100))。Provider 外使用时返回 null(上下文缺省)
export function PlayerStageSlot() {
  return useContext(PlayerStageContext);
}

// 播放事件订阅 hook(组件态):'ended'(播完,观看页 5s 倒计时连播的触发点)/
// 'close'(会话销毁)。fn 引用变化自动换绑,不必手工 useMemo。
export function usePlayerEvent(name, fn) {
  const { subscribe } = usePlayer();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    return subscribe(name, (...args) => {
      if (typeof fnRef.current === 'function') fnRef.current(...args);
    });
  }, [name, subscribe]);
}

// ============================================================================
// PlayerDock —— 观看页播放器锚点(纯测位,不再挂播放器)
// ----------------------------------------------------------------------------
// 观看页在播放器外框位置渲染本组件:透明 View,把自己的窗口坐标上报给
// Provider(measureInWindow 三端通吃;onLayout 覆盖布局变化,dockNudge 覆盖
// 滚动结束重测)。舞台据此停泊/变形到外框位置;外框底色仍由观看页提供
// (舞台视频恰好盖满,解析中/失败时露出黑底)。radius 供舞台 docked 圆角
// 对齐(桌面双列 12,通栏 0)。
// ============================================================================
export function PlayerDock({ style, radius = 0 }) {
  const { reportDockRect, dockNudge } = usePlayer();
  const ref = useRef(null);
  // 测位硬化:除 w/h>0 外还校验 x/y 有限;native 新屏异步挂载期间的
  // measureInWindow 可能给出 (0,0,w,h) 假坐标(本页锚点恒在顶栏之下,真实
  // y>0)——假坐标一旦上报会成为变形目标,舞台飞向屏幕左上角。检出即 rAF
  // 有界重测(≤3 帧),重测仍为零才如实上报(防吞掉合法的全出血布局)
  const measure = useCallback(
    function measureAnchor(retries = 0) {
      const el = ref.current;
      if (!el || typeof el.measureInWindow !== 'function') return;
      el.measureInWindow((x, y, w, h) => {
        if (w <= 0 || h <= 0 || !Number.isFinite(x) || !Number.isFinite(y)) return;
        if (x === 0 && y === 0 && retries < 3) {
          const raf = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame
            : (fn) => setTimeout(fn, 16);
          raf(() => measureAnchor(retries + 1));
          return;
        }
        reportDockRect({ x, y, w, h, r: radius });
      });
    },
    [reportDockRect, radius]
  );
  useLayoutEffect(() => {
    measure();
  }, [measure, dockNudge]);
  return (
    <View
      ref={ref}
      collapsable={false}
      style={[styles.dockAnchor, style]}
      onLayout={measure}
    />
  );
}

const styles = StyleSheet.create({
  // 观看页锚点:透明占位(缺省 16:9 通栏,观看页经 style 覆盖宽高)
  dockAnchor: {
    width: '100%',
    aspectRatio: 16 / 9,
  },
});

// ============================================================================
// PlayerStage —— 唯一播放器舞台(根部覆盖层,YouTube 式两形态变形)
// ----------------------------------------------------------------------------
// 【为何内联在本文件】与旧 MiniPlayer 同因:Provider 渲染舞台、舞台用
// usePlayer 会构成 Require cycle,Metro 每次加载都告警——内联同文件断环。
// 三层结构(驱动策略隔离,互不干扰):
//   L1 布局层(静态):位置尺寸=布局基点 rect,悬浮态圆角阴影;常驻 pan 位移 +
//       docked 滚动跟随 translate 也在本层——必须在 L2 裁剪之外,移动的才
//       是整个悬浮窗(挂裁剪层内会变成「内容在窗框下打滑」,窗不动);
//   L2 形变层(native 驱动):FLIP transform(translate+scale,transformOrigin
//       左上)+ 整体透明度;overflow hidden 在本层(裁剪随 transform 缩放);
//       transform 仅在形变在途(morphing)时挂载,静止态零变换——原生视频
//       视图在恒挂 scale 变换的祖先下 iOS 画面帧不随层同步(黑屏有声);
//       translate 类位移(L1)不受此限,层整体平移视频照常渲染;
//   L3 内容层(静态):承载 VideoPlayer/占位卡/mini 控件/dock 覆盖槽。
// 交互:
//   - mini:PanResponder 拖动(视口内 clamp,move>6px 才接管,不夺子钮点按);
//     松手 vy 向下超阈=快甩关闭(飞出+淡出→close),否则滑向最近角落吸附;
//   - mini 控件:左上暂停/继续(instanceRef 控制,onPlayingChange 驱动图标)、
//     右上关闭;点按画面=本窗 router.push 展开(不走 useOpenVideo:会话在
//     本窗,展开也在本窗;卡片点击开独立播放窗的口径不受影响);
//   - docked:渲染观看页注册的覆盖槽(返回箭头/连播倒计时)。
// ============================================================================
function PlayerStage(props) {
  const {
    uiPhase, rect, rectRef, anim, morphing, panMotion, session, videoProps,
    phase, errMsg, retry, overlays, close, miniRectOf, commitMini, playerFs,
  } = props;
  const router = useRouter();
  const { width: winW, height: winH } = useWindowDimensions();
  const [playing, setPlaying] = useState(false);

  const isMini = uiPhase === 'mini';
  const isDocked = uiPhase === 'docked';
  // PanResponder 回调闭包在手势创建时定格,相位经 ref 读最新
  const phaseRef = useRef(uiPhase);
  phaseRef.current = uiPhase;

  // 拖拽中累计速度(vy 判快甩)
  const dragRef = useRef(null);
  // 「刚拖完」守卫:真拖动(位移超阈)松手的时间戳。窗口跟手移动后,松手点
  // 必然还在窗内,浏览器为 mouse/touch 合成的 click 会落在展开层/控件钮上
  // (RNW 的 onPress 走原生 DOM click,不随 responder 接管而取消)——
  // 展开等入口在短窗内忽略点击即可兜底(比拦事件稳,对一切 click 来源生效)
  const lastDragEndRef = useRef(0);
  const justDragged = useCallback(() => Date.now() - lastDragEndRef.current < 600, []);

  const panYScroll = useMemo(() => Animated.add(anim.panY, anim.scroll), [anim]);

  const flingDismiss = useCallback(
    () => {
      const r = rectRef.current;
      if (!r) return;
      // 被新拖动/展开打断时，旧关闭回调必须作废、透明度必须恢复。
      const run = Animated.parallel([
        Animated.timing(anim.panY, { toValue: winH + 120 - r.y, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: false }),
        Animated.timing(anim.stageOpacity, { toValue: 0, duration: 200, useNativeDriver: NATIVE }),
      ]);
      panMotion.start(run, close, { dismiss: true });
    },
    [anim, close, panMotion, winH, rectRef]
  );

  const snapToCorner = useCallback(
    (curX, curY) => {
      const r = rectRef.current;
      if (!r) return;
      // 四角槽位,按窗口中心距离取最近
      const cx = curX + r.w / 2;
      const cy = curY + r.h / 2;
      let best = 'br';
      let bestD = Infinity;
      for (const corner of ['tl', 'tr', 'bl', 'br']) {
        const s = miniRectOf(corner);
        const d = (s.x + s.w / 2 - cx) ** 2 + (s.y + s.h / 2 - cy) ** 2;
        if (d < bestD) {
          bestD = d;
          best = corner;
        }
      }
      const slot = miniRectOf(best);
      const run = Animated.parallel([
        Animated.timing(anim.panX, { toValue: slot.x - r.x, duration: SNAP_MS, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
        Animated.timing(anim.panY, { toValue: slot.y - r.y, duration: SNAP_MS, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
      ]);
      panMotion.start(run, () => {
        if (phaseRef.current !== 'mini') return;
        commitMini(best);
      });
    },
    [anim, commitMini, miniRectOf, panMotion, rectRef]
  );

  const pan = useMemo(
    () =>
      PanResponder.create({
        // start 即接管(mini 态):web 鼠标拖动必须如此——RNW 的 responder
        // 谈判只沿事件 target 的祖先链进行,mousemove 的 target 会随指针
        // 移出窗体而脱离舞台,依赖「位移超阈 capture 夺取」永远问不到舞台;
        // 按下即成为 responder 后,后续 move 无论指针在哪都直接派发给舞台,
        // 全程跟手。子钮(暂停/关闭/展开层 Pressable)走 DOM click 不经
        // responder 谈判,点按不受影响;小位移(<DRAG_SLOP)松手浏览器照常
        // 合成 click=展开,真拖动后 mouseup 已在窗外,click 落在公共祖先上
        // 不会误触展开
        onStartShouldSetPanResponder: () => phaseRef.current === 'mini' && !morphing,
        // web 专属:start 的 capture 段即拦截。RNW 的 responder 谈判沿事件
        // target 祖先链「深层优先」,子层 Pressable(PressResponder 注册了
        // onStartShouldSetResponder)会先赢掉 mousedown;而鼠标 mousemove 的
        // target 随指针移出窗体脱离舞台链,事后夺取永远问不到舞台——所以
        // 鼠标拖动必须在 start capture(根→叶,L1 最先被问)直接接管。
        // RNW 的 onPress 走原生 DOM click 不接 responder,tap 展开不受影响;
        // native 端禁用(原生 Pressable 依赖 responder 驱动 onPress,capture
        // 拦截会吞掉子钮点击),原生触摸 target 恒定,走下方 move 夺取即可
        onStartShouldSetPanResponderCapture:
          Platform.OS === 'web' ? () => phaseRef.current === 'mini' && !morphing : undefined,
        // 捕获段兜底接管:native 触摸拖动(位移超阈夺取)+ web 的相位竞态
        onMoveShouldSetPanResponderCapture: (e, g) =>
          phaseRef.current === 'mini' && !morphing && (Math.abs(g.dx) > DRAG_SLOP || Math.abs(g.dy) > DRAG_SLOP),
        onPanResponderGrant: () => {
          panMotion.stop();
          anim.ctrl.setValue(0); // 拖动中控件隐去
          // 停吸附后以当前偏移为手势起点，连续拖动不跳回上一角落。
          dragRef.current = {
            x: anim.panX.__getValue(), y: anim.panY.__getValue(),
            rect: rectRef.current, vy: 0,
          };
        },
        onPanResponderMove: (e, g) => {
          const r = rectRef.current;
          const d = dragRef.current;
          if (!r || !d || d.rect !== r || phaseRef.current !== 'mini' || morphing) return;
          // web 触屏:接管后的 touchmove 一律取消默认行为——否则浏览器会把
          // 拖窗当成页面滚动/历史滑动(overscroll navigation)手势,轻则页面
          // 跟滚,重则左滑前进右滑后退把观看页又导航回来(RNW 的 document
          // 监听非 passive,preventDefault 有效;native 无默认滚动无此问题)
          if (Platform.OS === 'web') {
            try {
              e.preventDefault();
            } catch (_err) { /* 忽略 */ }
          }
          const offset = stageDragOffset(r, d, g, winW, winH);
          anim.panX.setValue(offset.x);
          anim.panY.setValue(offset.y);
          d.vy = g.vy;
        },
        onPanResponderRelease: (e, g) => {
          const d = dragRef.current;
          dragRef.current = null;
          const r = rectRef.current;
          // 真拖动过(位移超阈):吃掉松手点随后合成的点击。三重防线:
          // 1) preventDefault touchend 本身(规范行为:阻止浏览器为触摸合成
          //    click——合成 click 的派发时机不稳,拦 document click 不可靠);
          // 2) web 上再一次性拦截 document 捕获段 click(mouseup 的
          //    preventDefault 不阻止鼠标 click 合成,只能拦);
          // 3) lastDragEndRef 时间戳,展开/控件入口短窗内忽略(兜底一切来源)
          if (d && r && (Math.abs(g.dx) > DRAG_SLOP || Math.abs(g.dy) > DRAG_SLOP)) {
            lastDragEndRef.current = Date.now();
            try {
              e.preventDefault();
            } catch (_err) { /* 忽略 */ }
            if (Platform.OS === 'web' && typeof document !== 'undefined') {
              const swallow = (ev) => {
                ev.stopPropagation();
                ev.preventDefault();
              };
              document.addEventListener('click', swallow, { capture: true, once: true });
              setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 800);
            }
          }
          if (!d || !r || d.rect !== r || phaseRef.current !== 'mini' || morphing) return;
          const curX = r.x + anim.panX.__getValue();
          const curY = r.y + anim.panY.__getValue();
          // 快甩判定双条件:vy 超阈 + 手势真实向下走了 60px(挪位拖拽的收尾
          // 微速度不应触发关闭;vy 的单位口径 native/web 存在 px/s 与 px/ms
          // 的历史歧义,位移条件对两个口径都稳)
          if (d.vy > FLING_VY && g.dy > 60 && curY > r.y + d.y + 40) {
            flingDismiss(); // 向下快甩 → 关闭
          } else {
            snapToCorner(curX, curY); // 松手滑向最近角落
          }
        },
        onPanResponderTerminate: () => {
          const d = dragRef.current;
          dragRef.current = null;
          const r = rectRef.current;
          // 中断仍从当前视觉位置吸附；旋转/展开已换布局时不再操作旧手势。
          if (d && r && d.rect === r && phaseRef.current === 'mini' && !morphing) {
            snapToCorner(r.x + anim.panX.__getValue(), r.y + anim.panY.__getValue());
          }
        },
      }),
    [anim, winW, winH, rectRef, flingDismiss, snapToCorner, panMotion, morphing]
  );

  if (!rect || uiPhase === 'hidden') return null;

  const miniLook = isMini; // 圆角/阴影随形态(docked 用锚点上报的 r)

  // mini 控件:实例句柄经 videoProps.instanceRef(无源解析期不可播,恒出暂停钮)
  const inst = videoProps && videoProps.instanceRef ? videoProps.instanceRef.current : null;
  const togglePlay = () => {
    if (justDragged()) return; // 拖拽刚结束:吞掉松手点合成的 click
    if (!inst) return;
    try {
      if (inst.playing) inst.pause();
      else inst.play();
    } catch (_e) {
      /* 忽略 */
    }
  };
  const dismissMini = () => {
    if (justDragged()) return; // 拖拽刚结束:吞掉松手点合成的 click
    const run = Animated.timing(anim.stageOpacity, { toValue: 0, duration: 150, useNativeDriver: NATIVE });
    panMotion.start(run, close, { dismiss: true });
  };
  const openWatch = () => {
    if (justDragged()) return; // 拖拽刚结束:吞掉松手点合成的 click
    router.push(videoPath(session.site, session.id));
  };

  return (
    <Animated.View
      style={[
        stageStyles.layer1,
        {
          position: Platform.OS === 'web' ? 'fixed' : 'absolute',
          left: rect.x,
          top: rect.y,
          width: rect.w,
          height: rect.h,
          // 平移节点跨拖动/吸附/停泊常驻，放在裁剪层外移动整个窗口。
          transform: [{ translateX: anim.panX }, { translateY: panYScroll }],
        },
        miniLook ? stageStyles.miniShadow : null,
      ]}
      {...pan.panHandlers}
    >
      {/* 沉浸全屏藏系统状态栏(声明式:卸载即恢复,异常路径不漏恢复——替代旧
          命令式 StatusBar.hide/show;web 无系统状态栏概念恒不渲染。与
          WallOverlay 的 <StatusBar hidden/> 共存,后挂者胜,语义同向不冲突) */}
      {Platform.OS !== 'web' && playerFs ? <StatusBar hidden style="light-content" /> : null}
      <Animated.View
        style={[
          stageStyles.layer2,
          {
            borderRadius: miniLook ? 12 : rect.r || 0,
            // 进场淡入(native 驱动;形变图/布局已不再依赖它)
            opacity: anim.stageOpacity,
            // FLIP 变换仅在形变在途挂载:静止态视频祖先链零 scale(iOS 上
            // AVPlayerLayer 帧不随恒挂变换的祖先同步,有声音无画面);落定
            // 撤数组同时强制一次样式提交,形变期万一瞬黑也随之自愈。
            // 注意键必须整个缺席而非置 undefined——Animated 视图的样式处理
            // 会对 transform 键直接 .forEach,transform:undefined 即崩
            // 「Cannot read property 'forEach' of null」(真机黑屏报错本尊)
            ...(morphing
              ? {
                  transform: [
                    { translateX: anim.tx },
                    { translateY: anim.ty },
                    { scaleX: anim.sx },
                    { scaleY: anim.sy },
                  ],
                  transformOrigin: 'left top',
                }
              : null),
          },
        ]}
      >
        <Animated.View style={stageStyles.layer3}>
          {/* 播放内核:三端唯一的 VideoPlayer 常驻于此(docked 出全量控件) */}
          {videoProps ? (
            <VideoPlayer
              {...videoProps}
              controls={isDocked}
              onPlayingChange={setPlaying}
            />
          ) : phase === 'error' ? (
            <SurfaceCard small={isMini} errMsg={errMsg || '播放地址解析失败'} onRetry={retry} />
          ) : (
            <SurfaceCard small={isMini} loading label="解析播放地址中…" />
          )}

          {/* mini 点按展开层(盖视频、让位控件钮) */}
          {isMini ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="展开回观看页"
              onPress={openWatch}
              style={StyleSheet.absoluteFill}
            />
          ) : null}

          {/* mini 控件:左上暂停/继续,右上关闭(半透明圆钮,YouTube 形态) */}
          <Animated.View
            style={[StyleSheet.absoluteFill, { opacity: anim.ctrl }]}
            pointerEvents={isMini ? 'box-none' : 'none'}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={playing ? '暂停' : '继续播放'}
              onPress={togglePlay}
              style={stageStyles.miniBtnLeft}
            >
              {playing ? <Pause size={20} color="#fff" /> : <Play size={20} color="#fff" />}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭悬浮播放器"
              onPress={dismissMini}
              style={stageStyles.miniBtnRight}
            >
              <Close size={20} color="#fff" />
            </Pressable>
          </Animated.View>

          {/* dock 覆盖槽:观看页注册的浮层(压在视频之上;留在页面里会被舞台
              zIndex 压住)。层序:返回箭头 → 横屏全屏「选集」唤出钮 → 横屏浮层
              面板 → 选集浮层 → 连播倒计时(最上层,播完接管交互)——各节点自带
              zIndex,兄弟层内按值叠放。
              注:panel/panelBtn 此前注册了却未在此渲染(横屏窄幅的选集浮层面板
              实际不可见),本次一并接上 */}
          {isDocked ? (
            <>
              {overlays.back || null}
              {overlays.panelBtn || null}
              {overlays.panel || null}
              {overlays.episodes || null}
              {overlays.countdown || null}
            </>
          ) : null}
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

const stageStyles = StyleSheet.create({
  layer1: {
    zIndex: 40, // 悬浮在页面内容之上(与底导航同档,低于弹窗)
    elevation: 40,
  },
  // 悬浮形态投影:boxShadow 三端通吃(RN 新架构原生支持,web CSS 原生);
  // 圆角随 L2 对齐(阴影贴圆角盒)
  miniShadow: {
    borderRadius: 12,
    boxShadow: '0px 4px 12px rgba(0,0,0,0.35)',
    elevation: 8,
  },
  layer2: {
    ...ABS_FILL,
    overflow: 'hidden', // 裁剪随 transform 缩放(形变期视觉边界正确)
  },
  layer3: {
    ...ABS_FILL,
  },
  miniBtnLeft: {
    position: 'absolute',
    left: 8,
    top: 8,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    // 液态玻璃不适配本钮:外层 Animated.View 以 opacity 淡入淡出控件层,
    // 而 GlassView 祖先 opacity=0 会永久破坏玻璃渲染(官方已知限制)——
    // 维持半透明黑圆钮(YouTube 形态)
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  miniBtnRight: {
    position: 'absolute',
    right: 8,
    top: 8,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)', // 同 miniBtnLeft:opacity 动画层内,不玻璃化
  },
});
