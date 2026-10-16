// ============================================================================
// PhotoViewer.jsx —— 全屏看图器（核心交互件，RN 三端移植）
// ----------------------------------------------------------------------------
// 源：NextWeb src/components/album/PhotoViewer.jsx（业内最佳交互 Google Photos 式
// 渐进加载/双击缩放/拖拽平移 + Imgur 式侧箭头/底部胶片条）移植为 YouTube 皮肤
// （深色 #0f0f0f 铬、品牌红胶片条当前环、播放器同款圆形导航钮）。
//
// 数据契约：photos:[{ url（原图，数 MB 级）, thumb（200x150 网格缩略图）}]——
// 渐进加载（Medium 手法）：先显示 thumb 放大模糊占位，原图 load 完成后淡入替换；
// 当前张加载完成后才预加载相邻 ±1 张（Image.prefetch，不抢首屏带宽）。
//
// 交互清单（对齐任务口径，RN 化改造）：
//   导航   左右圆形导航钮（端点隐藏）、单指左右滑动翻页（未放大态，边界收敛
//         不环绕）、胶片条点按跳张；
//   缩放   双指捏合（1x–5x，焦点为锚 + 双指中点位移为平移）、双击以点击点为锚
//         1x↔2x、放大后单指拖拽平移；切图自动复位；Android 返回键先退放大再关
//         （对应 NextWeb 的 Esc 语义）；
//   其它   底部胶片条（可折叠，当前项品牌红环并自动滚入视野）、n/N 计数、
//         加载 spinner、失败重试（底层 thumb 常驻无黑屏）、role 弹窗语义。
//
// 缩放实现（与 NextWeb 同一公式，锚点改以舞台中心为原点——RN 的 scale 以视图
// 中心为锚，无法设 transformOrigin）：屏幕 = c + s*(p-c) + t，锚点 a 视觉不动
// ⟺ t' = t + (s-s')*(a-c)，单一公式贯通双击缩放/捏合步进；平移直接累加增量。
// 变换走 Reanimated 共享值（原生驱动不掉帧）；zoomed 态镜像回 JS 驱动 UI 分支。
// ============================================================================
import React, { useCallback, useEffect, useRef, useState } from 'react';
// RN 经典 Animated 与 Reanimated 的 Animated 不可混用：useAnimatedStyle 的
// 句柄（含 styleUpdaterContainer）必须交给 Reanimated 的 Animated.View——经典
// Animated.View 会把句柄原样透传给原生 View 的 style，Fabric 开发模式对宿主
// props 深冻结后，Reanimated 挂载时写 styleUpdaterContainer.current 即抛
// "immutable and has been frozen"。thumbOp 淡出仍用经典 RNAnimated。
// 另：Reanimated 4 只有默认导出 Animated（index 无 export { Animated }），
// 具名导入得 undefined，渲染期即抛 "Cannot read property 'View' of undefined"。
import {Platform, Animated as RNAnimated, Modal, Pressable, ScrollView, Text, View} from 'react-native';
import useDimensions from '../../lib/use-dimensions.js';
import { Image } from 'expo-image';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { ChevronLeft, ChevronRight, Gallery, Restart, Close } from '../icons.js';
import Spinner from '../ui/Spinner.jsx';
import GlassSurface from '../ui/GlassSurface.jsx';
import { useGlassEnabled } from '../../lib/glass.js';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DIMMING } from '../../lib/higlass.js';

const MAX_SCALE = 5;
const CLICK_ZOOM = 2; // 双击放大档（NextWeb 单击/双指同档）
const SWIPE_DIST = 48; // 翻页滑动最小横移（NextWeb 同值）
const CHROME_BG = 'rgba(15,15,15,0.97)'; // 深色铬（YouTube 看图器皮肤，主题无关）
// iOS 26 玻璃端工具条口径：叠照片（媒体富内容）= HIG Clear 变体 + 35% 黑暗化
// 层（lib/higlass.js DIMMING；旧 CHROME_GLASS_TINT 深色透染已废弃——官方
// 示例 .background(.black.opacity(0.3))，tint 只留给主操作强调）
// 胶片条缩略图：56 高、4:3（上游 thumb 恒 200x150），宽 ≈ 74
const STRIP_H = 56;
const STRIP_W = 74;

export default function PhotoViewer({ photos, index, onIndexChange, onClose, title = '' }) {
  const n = photos.length;
  const cur = Math.min(Math.max(index, 0), Math.max(0, n - 1));
  const t = photos[cur] || {};
  const win = useDimensions();
  // 系统栏让位（Modal 已 statusBarTranslucent/navigationBarTranslucent，内容
  // 铺到系统栏之下）：顶栏控制钮垫状态栏、胶片条垫小白条；图片舞台保持满屏
  // 出血（top/bottom inset 只作用于控制件区域，不进舞台尺寸）。web/桌面恒 0
  const insets = useSafeAreaInsets();
  // 液态玻璃（iOS 26+）：顶栏/胶片条/导航圆钮换玻璃；Modal fade 会把玻璃祖先
  // opacity 从 0 起动画（玻璃 opacity=0 禁区），玻璃态改无动画直出
  const glass = useGlassEnabled();

  const [loaded, setLoaded] = useState(false); // 当前原图已加载（切图即复位）
  const [failed, setFailed] = useState(false); // 当前原图加载失败（重试用）
  const [strip, setStrip] = useState(true);    // 底部胶片条显隐
  const [zoomed, setZoomed] = useState(false); // 放大态（导航钮隐藏/翻页滑动让位）

  // —— 变换共享值（原生驱动）：scale / 平移 ——
  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  // 舞台尺寸与手势基准快照也走共享值：worklet 闭包按「创建时刻的拷贝」捕获
  // 普通对象，useRef 跨线程读不到最新值（UI 线程读写必须 useSharedValue）
  const stageW = useSharedValue(win.width);
  const stageH = useSharedValue(win.height);
  const pinchBase = useSharedValue(null); // { s0, x0, y0, fx0, fy0 }
  const panBase = useSharedValue(null);   // { x0, y0 }

  // 闭包过期防御：JS 线程侧经 ref 读最新索引/回调（不进 worklet）
  const curRef = useRef(cur);
  curRef.current = cur;
  const changeRef = useRef(onIndexChange);
  changeRef.current = onIndexChange;
  const preloadedRef = useRef(new Set()); // 已预加载原图 URL（实例内去重）

  // zoomed 态镜像回 JS（导航钮/滑动翻页的让位判定）；resetZoom 双端可用
  //（worklet 化：手势 worklet 与 JS 线程（切图复位）都能调用）
  const resetZoom = useCallback(
    (animated) => {
      'worklet';
      if (animated) {
        scale.value = withTiming(1, { duration: 200 });
        tx.value = withTiming(0, { duration: 200 });
        ty.value = withTiming(0, { duration: 200 });
      } else {
        scale.value = 1;
        tx.value = 0;
        ty.value = 0;
      }
    },
    [scale, tx, ty]
  );
  const syncZoomed = useCallback((v) => setZoomed(v), []);

  // —— 导航（边界收敛不环绕；Google Photos/Imgur 同款）——
  const go = useCallback((d) => {
    const next = curRef.current + d;
    if (next < 0 || next >= photos.length) return;
    changeRef.current(next);
  }, [photos]);
  const jump = useCallback((i) => {
    if (i === curRef.current || i < 0 || i >= photos.length) return;
    changeRef.current(i);
  }, [photos]);

  // —— 关闭：放大态先退放大（NextWeb Esc 同语义；Android 返回键走这里）——
  const requestClose = useCallback(() => {
    if (scale.value > 1.001) {
      resetZoom(true);
      setZoomed(false); // 此处已在 JS 线程，直接置位
      return;
    }
    onClose && onClose();
  }, [scale, resetZoom, onClose]);

  // 切图：复位缩放/加载态（key 随 url 重建原图层，重挂即重载）
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
    setZoomed(false);
    resetZoom(false);
  }, [cur, resetZoom]);

  // 当前原图加载完成 → 预加载相邻 ±1（原图数 MB 级，排后避免抢首屏带宽）
  useEffect(() => {
    if (!loaded) return;
    for (const d of [1, -1]) {
      const p = photos[cur + d];
      if (p && p.url && !preloadedRef.current.has(p.url)) {
        preloadedRef.current.add(p.url);
        try {
          Image.prefetch(p.url);
        } catch (_e) { /* 预载失败不致命：轮到该张时按需加载 */ }
      }
    }
  }, [loaded, cur, photos]);

  // —— 手势：双指捏合（缩放 + 双指中点位移平移） ——
  const pinch = Gesture.Pinch()
    .onStart((e) => {
      pinchBase.value = { s0: scale.value, x0: tx.value, y0: ty.value, fx0: e.focalX, fy0: e.focalY };
    })
    .onUpdate((e) => {
      const b = pinchBase.value;
      if (!b) return;
      // 倍率夹取 1..5（内联，免跨 worklet 函数引用）；≤1 即复位
      const s = Math.min(MAX_SCALE, Math.max(1, b.s0 * e.scale));
      if (s <= 1) {
        scale.value = 1;
        tx.value = 0;
        ty.value = 0;
        return;
      }
      // 锚点 = 焦点（以舞台中心为原点）；叠加焦点位移为平移（NextWeb 捏合同构）
      const cx = stageW.value / 2;
      const cy = stageH.value / 2;
      scale.value = s;
      tx.value = b.x0 + (b.s0 - s) * (e.focalX - cx) + (e.focalX - b.fx0);
      ty.value = b.y0 + (b.s0 - s) * (e.focalY - cy) + (e.focalY - b.fy0);
    })
    .onEnd(() => {
      // 松手时倍率贴近 1 直接复位（避免 1.001 的死放大态）
      if (scale.value < 1.02) {
        scale.value = withTiming(1, { duration: 150 });
        tx.value = withTiming(0, { duration: 150 });
        ty.value = withTiming(0, { duration: 150 });
        runOnJS(syncZoomed)(false);
      } else {
        runOnJS(syncZoomed)(true);
      }
    });

  // —— 手势：单指拖拽（放大态=平移；未放大态=滑动翻页判定） ——
  const pan = Gesture.Pan()
    .maxPointers(1) // 双指归捏合分支，互不抢占
    .minDistance(8) // 与点击区分（NextWeb moved 阈值同 8px）
    .onStart(() => {
      panBase.value = { x0: tx.value, y0: ty.value };
    })
    .onUpdate((e) => {
      const b = panBase.value;
      if (!b || scale.value <= 1.001) return; // 未放大：不位移（翻页在 onEnd 判定）
      tx.value = b.x0 + e.translationX;
      ty.value = b.y0 + e.translationY;
    })
    .onEnd((e) => {
      if (scale.value <= 1.001) {
        // 未放大态的滑动：横向位移主导且超阈值 → 翻页（移动端主路径）；
        // go 是 JS 函数，UI 线程调用必须经 runOnJS
        const dx = e.translationX;
        const dy = e.translationY;
        if (Math.abs(dx) > SWIPE_DIST && Math.abs(dx) > Math.abs(dy) * 1.5) {
          runOnJS(go)(dx < 0 ? 1 : -1);
        }
        return;
      }
      runOnJS(syncZoomed)(true);
    });

  // —— 手势：双击 1x↔2x（以点击点为锚，Google Photos 手感） ——
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((e, ok) => {
      if (!ok) return;
      const cx = stageW.value / 2;
      const cy = stageH.value / 2;
      if (scale.value > 1.001) {
        scale.value = withTiming(1, { duration: 200 });
        tx.value = withTiming(0, { duration: 200 });
        ty.value = withTiming(0, { duration: 200 });
        runOnJS(syncZoomed)(false);
        return;
      }
      const s = CLICK_ZOOM;
      scale.value = withTiming(s, { duration: 200 });
      // t' = t + (s0 - s')*(a - c)，当前 t=0、s0=1
      tx.value = withTiming((1 - s) * (e.x - cx), { duration: 200 });
      ty.value = withTiming((1 - s) * (e.y - cy), { duration: 200 });
      runOnJS(syncZoomed)(true);
    });

  // 捏合与单指拖拽并行（双指中第二指落下时 pan 让位给 pinch）；双击与两者兼容
  const stageGesture = Gesture.Simultaneous(pinch, pan, doubleTap);

  const stageStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: scale.value },
    ],
  }));

  // —— thumb 模糊占位淡出（原图就绪后 300ms 淡出；失败时常驻底图） ——
  const thumbOp = useRef(new RNAnimated.Value(1)).current;
  useEffect(() => {
    RNAnimated.timing(thumbOp, { toValue: loaded ? 0 : 1, duration: 300, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [loaded, thumbOp]);

  // —— 胶片条：当前项自动滚入视野 ——
  const stripRef = useRef(null);
  const itemX = useRef(new Map()); // 序号 → onLayout 记录的 x/宽度
  const stripW = useRef(0);
  const scrollCurRef = useRef(null); // 最新滚动函数（onItemLayout 时机调用，免闭包过期）
  const onItemLayout = useCallback((i) => (e) => {
    const l = e && e.nativeEvent && e.nativeEvent.layout;
    if (l) itemX.current.set(i, { x: l.x, w: l.width });
    // 当前项的首帧布局晚于挂载 effect：此处补一次滚入视野（仅当前项触发）
    if (i === curRef.current && scrollCurRef.current) {
      const fn = scrollCurRef.current;
      setTimeout(fn, 50);
    }
  }, []);
  const scrollCurIntoView = useCallback(() => {
    const el = stripRef.current;
    const m = itemX.current.get(cur);
    if (!el || !m || !(stripW.current > 0)) return;
    el.scrollTo({ x: Math.max(0, m.x - stripW.current / 2 + m.w / 2), animated: true });
  }, [cur]);
  scrollCurRef.current = scrollCurIntoView;
  useEffect(() => {
    scrollCurIntoView();
  }, [cur, strip, scrollCurIntoView]);

  // 圆形导航钮（播放器同款；端点隐藏；放大态隐藏避免误触）——纯渲染函数而
  // 非内联组件，避免每次渲染换组件类型导致按钮子树反复重挂
  const renderNav = (dir, Icon, label) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => go(dir)}
      style={[
        {
          position: 'absolute',
          top: '50%',
          marginTop: -24,
          ...(dir < 0 ? { left: 16 } : { right: 16 }),
        },
      ]}
    >
      {/* iOS 26 玻璃端 clear 玻璃圆钮叠照片上 + HIG 35% 暗化层（按压反馈由
          玻璃 isInteractive 承担）；降级端半透明黑圆钮原样（按压加深经函数
          children 状态驱动） */}
      {({ pressed }) => (
        <GlassSurface
          glassStyle="clear"
          dark
          dimming={DIMMING}
          interactive
          className="h-12 w-12 items-center justify-center rounded-full"
          fallbackStyle={{ backgroundColor: pressed ? 'rgba(0,0,0,0.65)' : 'rgba(0,0,0,0.5)' }}
        >
          <Icon size={28} color="#ffffff" />
        </GlassSurface>
      )}
    </Pressable>
  );

  return (
    <Modal
      visible
      transparent
      animationType={glass ? 'none' : 'fade'}
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={requestClose}
      accessibilityViewIsModal
    >
      {/* Android 上 Modal 是新窗口：手势系统根须在 Modal 内再包一层 */}
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View
          accessibilityRole="alert"
          accessibilityLabel={'照片查看器 第' + (cur + 1) + '张，共' + n + '张'}
          style={{ flex: 1, backgroundColor: CHROME_BG }}
          onLayout={(e) => {
            const l = e.nativeEvent.layout;
            stageW.value = l.width; // 共享值：手势 worklet 侧即时可见
            stageH.value = l.height;
          }}
        >
          {/* —— 顶栏：关闭 + 标题 + 计数 | 胶片条开关（垫状态栏高，控制钮
              落在状态栏之下；桌面/web inset 为 0 即原形态）。iOS 26 玻璃端
              整条 clear 玻璃 + 35% 暗化层悬浮于照片之上（HIG Clear 变体叠媒
              体口径，Apple 看图器形态）；降级端透明条原样 —— */}
          <GlassSurface
            glassStyle="clear"
            dark
            dimming={DIMMING}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              zIndex: 20,
              paddingTop: insets.top,
              height: 56 + insets.top, // h-14 内容区 + 状态栏
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingHorizontal: 8,
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭查看器"
              onPress={requestClose}
              style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' }}
            >
              {({ pressed }) => (
                <View style={{ width: '100%', height: '100%', borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? 'rgba(255,255,255,0.1)' : 'transparent' }}>
                  <Close size={24} color="#ffffff" />
                </View>
              )}
            </Pressable>
            <View style={{ flex: 1, minWidth: 0, paddingLeft: 4 }}>
              <Text numberOfLines={1} style={{ color: '#ffffff', fontSize: 14, fontWeight: '500' }}>
                {title}
              </Text>
              <Text
                style={{
                  color: 'rgba(255,255,255,0.6)',
                  fontSize: 12,
                  fontVariant: ['tabular-nums'],
                  includeFontPadding: false,
                }}
              >
                {cur + 1} / {n}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={strip ? '隐藏缩略图条' : '显示缩略图条'}
              onPress={() => setStrip((v) => !v)}
              style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' }}
            >
              {({ pressed }) => (
                <View style={{ width: '100%', height: '100%', borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? 'rgba(255,255,255,0.1)' : 'transparent' }}>
                  <Gallery size={24} color={strip ? '#ff0000' : '#ffffff'} />
                </View>
              )}
            </Pressable>
          </GlassSurface>

          {/* —— 舞台：渐进加载（thumb 模糊占位 → 原图淡入）；缩放/平移容器 —— */}
          <GestureDetector gesture={stageGesture}>
            <View style={{ flex: 1, overflow: 'hidden' }}>
              <Animated.View
                style={[
                  // row + center：原图作唯一流内子元素天然居中；thumb/spinner/重试
                  // 作绝对铺满叠层（绝对层自带 center 布局，不抢手势目标）
                  { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
                  stageStyle,
                ]}
              >
                {/* thumb 层：放大+模糊占位（原图就绪后淡出；失败时常驻底图；
                    pointerEvents none 让手势直落舞台） */}
                {t.thumb ? (
                  <RNAnimated.Image
                    source={{ uri: t.thumb }}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      top: 0,
                      bottom: 0,
                      width: '100%',
                      height: '100%',
                    opacity: thumbOp,
                  }}
                  resizeMode="contain"
                  blurRadius={20}
                  />
                ) : null}
                {/* 原图层：load 后淡入（expo-image transition）；失败卸载、重试重挂即重载 */}
                {t.url && !failed ? (
                  <Image
                    key={t.url}
                    source={{ uri: t.url }}
                    style={{ width: '100%', height: '100%' }}
                    contentFit="contain"
                    transition={300}
                    recyclingKey={String(t.url)}
                    accessibilityLabel={(title ? title + ' ' : '') + '第' + (cur + 1) + '张照片'}
                    onLoad={() => setLoaded(true)}
                    onError={() => setFailed(true)}
                  />
                ) : null}
                {/* 加载中：品牌红 spinner（绝对铺满 + 居中叠层） */}
                {!loaded && !failed ? (
                  <View
                    style={{ pointerEvents: 'none',
                    
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      top: 0,
                      bottom: 0,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Spinner size={32} color="#ff0000" />
                  </View>
                ) : null}
                {/* 失败：重试（底层 thumb 仍在，无黑屏） */}
                {failed ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="加载失败，点击重试"
                    onPress={() => { setFailed(false); setLoaded(false); }}
                    style={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      top: 0,
                      bottom: 0,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <View style={{ alignItems: 'center', gap: 8 }}>
                      <Restart size={32} color="rgba(255,255,255,0.8)" />
                      <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 14 }}>加载失败，点击重试</Text>
                    </View>
                  </Pressable>
                ) : null}
              </Animated.View>
            </View>
          </GestureDetector>

          {/* —— 左右导航（端点隐藏；放大态隐藏避免误触） —— */}
          {cur > 0 && !zoomed ? renderNav(-1, ChevronLeft, '上一张') : null}
          {cur < n - 1 && !zoomed ? renderNav(1, ChevronRight, '下一张') : null}

          {/* —— 底部胶片条：当前项品牌红环，自动滚入视野（垫小白条/导航条）。
              iOS 26 玻璃端整条 clear 玻璃 + 35% 暗化层（同顶栏 HIG 口径，
              Apple 看图器形态）；降级端透明浮条原样 —— */}
          {strip ? (
            <GlassSurface
              glassStyle="clear"
              dark
              dimming={DIMMING}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 20,
                paddingTop: 24,
                paddingBottom: 8 + insets.bottom, // 小白条让位
                paddingHorizontal: 8,
              }}
            >
              <ScrollView
                ref={stripRef}
                horizontal
                showsHorizontalScrollIndicator={false}
                onLayout={(e) => { stripW.current = e.nativeEvent.layout.width; }}
                contentContainerStyle={{ flexDirection: 'row', gap: 8 }}
              >
                {photos.map((ph, i) => (
                  <Pressable
                    key={(ph && (ph.url || ph.thumb)) || i}
                    accessibilityRole="button"
                    accessibilityLabel={'第' + (i + 1) + '张'}
                    onPress={() => jump(i)}
                    onLayout={onItemLayout(i)}
                    style={{
                      height: STRIP_H,
                      width: STRIP_W,
                      borderRadius: 4,
                      overflow: 'hidden',
                      borderWidth: i === cur ? 2 : 0,
                      borderColor: '#ff0000', // 品牌红当前环
                      opacity: i === cur ? 1 : 0.5,
                    }}
                  >
                    {ph && ph.thumb ? (
                      <Image
                        source={{ uri: ph.thumb }}
                        style={{ width: '100%', height: '100%' }}
                        contentFit="cover"
                        recyclingKey={'strip-' + i}
                      />
                    ) : (
                      <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.1)' }} />
                    )}
                  </Pressable>
                ))}
              </ScrollView>
            </GlassSurface>
          ) : null}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}
