// ============================================================================
// WallOverlay.jsx —— 视频大屏看板(全屏覆盖层,三端同一份)
// ----------------------------------------------------------------------------
// 移植自 NextWeb/src/components/wall/WallOverlay.jsx,行为 1:1,RN 三端适配点:
//   - 常驻挂载保活(NextWeb 停车场语义):根 View 永在 AppShell 内(主线已在
//     AppShell 挂载本组件),open=false 时整棵树 transform: translateX(屏宽外)
//     + pointerEvents 'none' 移出视口——绝不卸载 tile 树、绝不用 display:none
//     语义的隐藏(RN-web 上脱离渲染树的媒体会被 Chromium 内部暂停,保活就破了;
//     native 上 VideoView 在树内即继续持有解码缓冲),配合 WallTile 的 !open→
//     pause 联动,重开零加载从原位置续播;「清空」是唯一销毁路径(条目清空 →
//     tile 卸载走完整 teardown)。空墙且关着时连停车场都不摆(return null,无
//     媒体可保活),items 出现即自动摆回。
//   - 测量:NextWeb 的 ResizeObserver 换 RN 的 onLayout(translate 不影响布局,
//     停车场形态同样量得出尺寸→入场预载:只要有 items 就先量布局把 tiles 挂进
//     停车场预载,首开真秒开);重排签名 = 各格比例拼接——增删格/比例收敛才变,
//     进度回写每 5s 换 item 身份但不改签名 → 不重排、整墙不抖。
//   - 打开时暂停主播放器:经 usePlayer() 找正确句柄——videoProps.instanceRef
//     (web=常驻宿主里的 video 元素包装,native=Provider 共享 expo-video 实例包
//     装,两端都暴露 pause()),调 pause 不自动恢复(NextWeb 同语义:回主播放
//     器自己续播)。
//   - 退出路径:X 钮;web Esc(typeof document 守卫 + keydown);Android
//     BackHandler('hardwareBackPress' 消费并 setWallOpen(false),open 时才挂
//     监听)。NextWeb 的 pushState/popstate 栈位法是浏览器历史语义,RN 无此
//     概念,不移植。
//   - 元素全屏:web 顶栏「全屏」钮 requestFullscreen(+webkit 前缀兜底,
//     fullscreenchange 收口同步态);native 墙本身已全屏——「全屏」钮改为切
//     状态栏显隐(打开时默认 <StatusBar hidden /> 沉浸,expo-status-bar),平台
//     语义差异见钮位注释。与 NextWeb 的另一点克制差异:元素全屏中不隐藏顶栏
//     (NextWeb 藏顶栏 + 右上 hover 热区退出钮;RN 触屏无 hover,藏了就没有
//     可达的退出路径,保留 h-14 顶栏让退出钮永远在)。
//   - 皮肤黑色硬编码(不随主题翻转,NextWeb 同款);顶栏壳(h-14 口径)常驻、
//     chrome 内容只在 open 时渲染——关/开内容盒尺寸一致,首开不重排。
//   - 桌面 Electron 适配:看板打开时本浮层 zIndex 100 盖满全窗——主窗 TopBar
//     的自绘 Windows 三钮(最小化/最大化/关闭)与拖拽区一并被盖住(按钮按需
//     隐藏,窗口仍可经任务栏操作);顶栏空白区挂 app-drag 接管窗口拖拽(对齐
//     TopBar 的「整条拖拽 + 行内可点元素 no-drag」模式),顶栏各功能钮
//     app-nodrag 保可点。看板浮层只在主窗使用(播放窗 PlayerWindowFrame 不挂
//     本组件),条目数据经 wall-store 的桌面跨窗同步互通。
//   - masterPaused:全局一键停/续,只 pause/play 不拆流(各格原地停);
//     清空两步确认(第一次点变红「确认清空?」3s 超时还原,再点 clearWall)。
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FullscreenEnter, FullscreenExit, Wall, Pause, Play, Trash, Close } from '../icons.js';
import { usePlayer } from '../../lib/player-context.jsx';
import {
  clearWall,
  removeFromWall,
  setWallOpen,
  useWallItems,
  useWallOpen,
} from '../../lib/wall-store.js';
import { computeWallLayout } from '../../lib/wall-layout.js';
import { useIsDesktopApp } from '../../lib/desktop-bridge.js';
// 平台分流(无后缀 import,metro 按 .web.js 优先解析):web=hls.js 裸 video 版,
// native=expo-video 版;两端 props 契约一致 { item, masterPaused, onRemove }
import WallTile from './WallTile';
import usePressVisual from '../../lib/use-press-visual.js';
import { ABS_FILL } from '../../lib/abs-fill.js';
import { TOPBAR_H } from '../../lib/chrome-metrics.js';

const GAP = 0;   // 视频墙满铺无缝:格间距 0(wall-layout 契约参数,0 合法;垂直
                 // 不足时行距仍会被算法摊大铺满,那是有意的填屏行为)
const ICON = 24;     // 功能图标统一 24px(README 图标规格)

// 看板顶栏圆钮：布局/视觉全部静态对象 + 悬停态事件 state（安卓端 Pressable
// 样式函数携带的布局属性不生效，见 lib/use-press-visual.js 头注）；className
// 仅供桌面壳传 app-nodrag（顶栏挂 app-drag 后保钮可点，见 open 态渲染处）
function IconBtn({ label, onPress, disabled, className, children }) {
  const hv = usePressVisual();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      className={className}
      {...hv.binds}
      style={[styles.iconBtn, hv.hovered && styles.iconBtnHover, disabled && styles.iconBtnDisabled]}
    >
      {children}
    </Pressable>
  );
}

export default function WallOverlay() {
  const open = useWallOpen();
  const items = useWallItems();
  const { videoProps } = usePlayer(); // 主播放器句柄(打开看板时 pause 它)
  const { width: winW, height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // 桌面壳:打开时浮层盖住 TopBar 的拖拽区与 Windows 三钮,顶栏改由本组件
  // 接管拖拽(app-drag,行内钮 app-nodrag);hook 形态保 SSG 水合对齐
  const desktop = useIsDesktopApp();
  // 内容盒高度不走 flex 链(flex:1 在绝对定位根 + elevation/zIndex 组合下实测
  // 会被 Yoga 塌成 0,安卓真机 Fabric 复现):顶栏总高恒定(56+顶部安全区,开/关
  // 同值——垫高不随开合变化是「停车场量出的布局首开直接可用」的前提),内容高
  // 直接由窗口尺寸推得,给 content 显式高度,contentBox(absoluteFill)随之确定
  const contentH = Math.max(0, winH - (TOPBAR_H + insets.top));

  const [masterPaused, setMasterPaused] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false); // 清空两步确认态
  // 内容盒尺寸不走 onLayout 测量:真机(Fabric/安卓)实测 absolute 定位根下
  // flex:1/显式高度链会把 absoluteFill 子盒塌成 0 高,量不出真实尺寸。改为
  // 确定性推算——根恒铺满窗口(useWindowDimensions),顶栏总高恒定(56+顶部
  // 安全区),内容盒 = 窗口宽 × (窗口高-顶栏)。旋转/分屏窗口变化由 hook 自动
  // 跟随,与 NextWeb ResizeObserver 语义等价且零 Yoga 依赖。
  const box = { w: winW, h: contentH };
  // fs 双语义:web=元素全屏态(fullscreenchange 收口同步,初始未全屏);
  // native=沉浸态(藏状态栏),打开时默认沉浸
  const [fs, setFs] = useState(Platform.OS !== 'web');

  const rootRef = useRef(null); // 根 View(web 端 ref 直达 DOM,元素全屏目标)
  const clearTimerRef = useRef(null);

  // ===== 进入/退出元素全屏(仅 web;标准 API 优先,Safari 走 webkit 前缀;
  //       拒绝/不支持静默)=====
  const enterFs = useCallback(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const el = rootRef.current;
    if (!el) return;
    try {
      if (el.requestFullscreen) {
        const p = el.requestFullscreen();
        if (p && p.catch) p.catch(() => {});
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      }
    } catch (_e) { /* 忽略 */ }
  }, []);
  const exitFs = useCallback(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    try {
      if (document.exitFullscreen) {
        const p = document.exitFullscreen();
        if (p && p.catch) p.catch(() => {});
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    } catch (_e) { /* 忽略 */ }
  }, []);

  // 全屏态同步(仅 web):进入/退出(含 Esc、系统夺回)全走 fullscreenchange,
  // 单一事实源;只认「全屏元素是看板根」这一种情况
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onFs = () => {
      const el = rootRef.current;
      const cur = document.fullscreenElement || document.webkitFullscreenElement;
      setFs(!!el && cur === el);
    };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('webkitfullscreenchange', onFs);
    };
  }, []);

  // native:每次打开回到沉浸默认(藏状态栏);web 的 fs 由 fullscreenchange 收口
  useEffect(() => {
    if (open && Platform.OS !== 'web') setFs(true);
  }, [open]);

  // 关闭统一入口:元素全屏中顺手退出(不留空的满屏舞台),再 setWallOpen(false)
  const closeWall = useCallback(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      if (document.fullscreenElement || document.webkitFullscreenElement) exitFs();
    }
    setWallOpen(false);
  }, [exitFs]);

  // ===== 打开时的副作用:暂停主播放器(不自动恢复)+ web Esc + Android 返回键。
  //       effect 以 open 为门:开→编排,关→还原 =====
  useEffect(() => {
    if (!open) return;
    // 多路墙与主播放抢声必打架:经共享实例句柄 pause(web=常驻 video 元素,
    // native=Provider 共享 expo-video 实例);不自动恢复
    const inst = videoProps && videoProps.instanceRef ? videoProps.instanceRef.current : null;
    if (inst && typeof inst.pause === 'function') {
      try { inst.pause(); } catch (_e) { /* 实例不在:无主播放可停 */ }
    }
    // web:Esc 关闭(typeof 守卫——native 无 document)
    let onKey = null;
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeWall();
        }
      };
      window.addEventListener('keydown', onKey);
    }
    // Android:物理返回键消费并关闭看板(open 时才挂监听,防吞其它页的返回)
    let backSub = null;
    if (Platform.OS === 'android') {
      backSub = BackHandler.addEventListener('hardwareBackPress', () => {
        setWallOpen(false);
        return true; // 消费掉,不冒泡给路由(不退出观看页)
      });
    }
    return () => {
      if (onKey) window.removeEventListener('keydown', onKey);
      if (backSub) backSub.remove();
    };
  }, [open, videoProps, closeWall]);

  // 内容盒尺寸已改为 useWindowDimensions 确定性推算(见 box 定义处注释),
  // onLayout 测量通道整体移除——真机上量不出(见上),留着只会误导后来人。

  // 清空确认 3s 超时计时器:卸载兜底清掉
  useEffect(() => () => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
  }, []);

  // 清空两步确认:首点变红字「确认清空?」(3s 超时还原),再点执行
  const onClear = useCallback(() => {
    if (!confirmClear) {
      setConfirmClear(true);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      clearTimerRef.current = setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    setConfirmClear(false);
    clearWall(); // 唯一销毁路径:条目清空 → tiles 卸载走完整 teardown(释放内存)
  }, [confirmClear]);

  // 重排签名:各项比例拼接(增删格/比例收敛时变化;签名内嵌长度,空墙自然为空串)
  const ratioSig = items.map((x) => x.ratio || 16 / 9).join(',');
  const layout = useMemo(() => {
    if (!ratioSig || !box.w || !box.h) return { tiles: [], height: 0 };
    // 签名还原为比例数组(toString→Number 对 IEEE754 双精度无损往返),依赖只有
    // 签名 + 宽高:进度回写不改签名 → 不重排
    const r = computeWallLayout(ratioSig.split(',').map(Number), box.w, box.h, GAP);
    return r;
  }, [ratioSig, box.w, box.h]);

  if (!open && items.length === 0) {
    // 空墙且关着:连停车场都不用摆(无媒体可保活),直接空占位(所有 hooks 已
    // 调用完毕,return null 不违反 hook 规则);items 一出现即自动摆回停车场
    return null;
  }

  // 全屏钮(web=元素全屏开关;native=沉浸态开关,切 StatusBar 显隐)
  const onToggleFs = () => {
    if (Platform.OS === 'web') {
      if (fs) exitFs();
      else enterFs();
      return;
    }
    setFs((v) => !v); // native:墙本身已全屏,钮只切状态栏显隐(平台语义差异)
  };

  return (
    <View
      ref={rootRef}
      style={open ? styles.rootOpen : styles.rootParked(winW)}
      // 无障碍语义对齐 NextWeb:开=对话框,关=纯停车位
      accessibilityLabel={open ? '视频看板' : undefined}
    >
      {/* native 打开时藏状态栏(沉浸默认开,「全屏」钮可切回;web 不渲染——
          元素全屏由浏览器接管状态栏) */}
      {open && Platform.OS !== 'web' ? <StatusBar hidden={fs} /> : null}

      {/* —— 顶栏壳(h-14 常驻,chrome 内容仅 open 时挂):标题 + 数量徽标 |
            全部暂停/续播、清空(两步确认)、全屏、关闭 —— */}
      {/* 顶栏安全区垫高两端恒定(开/关同值):垫高随开合变化会让内容盒尺寸漂移,
          首开重排破坏「停车场量出的布局直接可用」——NextWeb 的 env() 同为常量 */}
      <View style={[styles.topbar, { paddingTop: insets.top }]}>
        {/* 桌面壳:整行 app-drag 接管窗口拖拽(浮层已盖住 TopBar 的拖拽区),
            行内可点元素显式 app-nodrag——对齐 TopBar 的标题栏模式;布局仍走
            StyleSheet,className 只承担拖拽区语义 */}
        <View
          className={desktop ? 'app-drag' : undefined}
          style={[styles.topbarInner, { height: TOPBAR_H }]}
        >
          {open ? (
            <>
              <Wall size={20} color="rgba(255,255,255,0.8)" />
              <Text style={styles.title}>看板</Text>
              <View style={styles.count}>
                <Text style={styles.countText}>{items.length}</Text>
              </View>
              <View style={styles.flex1} />
              <IconBtn
                label={masterPaused ? '全部播放' : '全部暂停'}
                onPress={() => setMasterPaused((p) => !p)}
                className={desktop ? 'app-nodrag' : undefined}
              >
                {masterPaused ? (
                  <Play size={ICON} color="rgba(255,255,255,0.8)" />
                ) : (
                  <Pause size={ICON} color="rgba(255,255,255,0.8)" />
                )}
              </IconBtn>
              {confirmClear ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="确认清空看板"
                  onPress={onClear}
                  className={desktop ? 'app-nodrag' : undefined}
                  style={styles.confirmBtn}
                >
                  <Text style={styles.confirmText}>确认清空?</Text>
                </Pressable>
              ) : (
                <IconBtn
                  label="清空看板"
                  onPress={onClear}
                  disabled={items.length === 0}
                  className={desktop ? 'app-nodrag' : undefined}
                >
                  <Trash
                    size={ICON}
                    color={items.length === 0 ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.8)'}
                  />
                </IconBtn>
              )}
              <IconBtn
                label={fs ? '退出全屏' : '全屏'}
                onPress={onToggleFs}
                className={desktop ? 'app-nodrag' : undefined}
              >
                {fs ? (
                  <FullscreenExit size={ICON} color="rgba(255,255,255,0.8)" />
                ) : (
                  <FullscreenEnter size={ICON} color="rgba(255,255,255,0.8)" />
                )}
              </IconBtn>
              <IconBtn
                label="关闭看板"
                onPress={closeWall}
                className={desktop ? 'app-nodrag' : undefined}
              >
                <Close size={ICON} color="rgba(255,255,255,0.8)" />
              </IconBtn>
            </>
          ) : null}
        </View>
      </View>

      {/* —— 内容区:内容盒负责测量与铺 tiles(满铺无缝,无内边距);常驻渲染
            (停车场形态也在),tile 容器永不卸载=保活,测量 ref 永远在 —— */}
      <View style={[styles.content, { height: contentH }]}>
        <View style={styles.contentBox}>
          {layout.tiles.map((tile) => {
            const it = items[tile.i];
            if (!it) return null;
            return (
              <View
                key={it.key}
                style={{
                  position: 'absolute',
                  left: tile.x,
                  top: tile.y,
                  width: tile.w,
                  height: tile.h,
                }}
              >
                <WallTile item={it} masterPaused={masterPaused} onRemove={removeFromWall} />
              </View>
            );
          })}
        </View>
        {/* 空态:居中提示文案(克制文案;仅打开时可见,停车场形态不抢可见层) */}
        {open && items.length === 0 ? (
          <View style={styles.empty} pointerEvents="none">
            <Text style={styles.emptyText}>看板是空的，去播放器里加入视频</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // 打开态:全屏黑底盖住一切(黑色硬编码,不随主题翻转);zIndex/elevation 压过
  // 抽屉/迷你播放器等一切壳层悬浮件
  rootOpen: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
    elevation: 100,
    backgroundColor: 'rgba(0,0,0,0.95)',
  },
  // 停车场态:整棵树平移出视口 + 断指针(必须保持「渲染中」——display:none 语义
  // 的隐藏会让 Chromium 内部暂停媒体、native 丢弃渲染管线,保活就破了)
  rootParked: (winW) => ({
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 0,
    elevation: 0,
    backgroundColor: 'rgba(0,0,0,0.95)',
    transform: [{ translateX: winW + 8 }],
    pointerEvents: 'none',
  }),
  topbar: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  topbarInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
  },
  count: {
    height: 24,
    minWidth: 28,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  countText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.8)',
  },
  flex1: {
    flex: 1,
  },
  iconBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
  },
  iconBtnHover: {
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  iconBtnDisabled: {
    opacity: 0.4,
  },
  confirmBtn: {
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 18,
    backgroundColor: 'rgba(239,68,68,0.15)',
  },
  confirmText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#f87171',
  },
  content: {
    flex: 1,
    position: 'relative',
    overflow: 'hidden',
  },
  contentBox: {
    ...ABS_FILL,
  },
  empty: {
    ...ABS_FILL,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
    color: 'rgba(255,255,255,0.5)',
  },
});
