// ============================================================================
// AppShell.jsx —— 应用外壳：三画幅布局编排
// ----------------------------------------------------------------------------
// 画幅（src/lib/use-form.js 口径）：
//   phone（宽 <768）  无侧栏；底部三~六槽导航；汉堡开覆盖式抽屉；顶栏/底栏
//                     按路由白名单显示（chrome-routes）：顶栏只属首页与「我
//                     的」，底栏只属 tab 槽位页；其余页面（board/plugins/
//                     telegram×3/各详情页等自绘「返回+标题」页头页）整条收起，
//                     页面经 useChromeInsets 自垫安全区（m.youtube 形态）
//   pad（768–1279）   迷你轨 72px 常驻；汉堡开抽屉；观看页收侧栏留顶栏
//   pc（>=1280）      导视侧栏 240px 常驻；汉堡在 展开↔迷你 间切换并持久化
//                      （AsyncStorage 键 'moontent_guide'，'full' 默认 / 'mini'）；
//                      观看页收侧栏留顶栏
// 抽屉：半透明遮罩点击关闭 + 路由变化关闭；顶部对齐顶栏总高（h-14+安全区）。
// 安全区：顶栏垫 insets.top（刘海/灵动岛），底部导航垫 insets.bottom（手势条）；
// 观看页手机端全屏化时两者均隐藏，无残留垫高。
// 布局用 flex 列（顶栏/内容/底栏）+ 行（侧栏/主区），不依赖 CSS fixed——
// RN 三端同一套结构。
// 手机画幅壳层收放（hide-on-scroll，YouTube App 同款）：tab 页向下滚动时
// 顶栏上滑出、底栏下滑出，回滚/回顶恢复。phone 画幅下两栏 overlay 悬浮于
// 内容之上（absolute + zIndex 30，层级仍低于舞台 40/抽屉 50/视频墙 100），
// 内容全出血铺满整屏、滚到栏底下，页面滚动内容用 useChromeInsets 自垫间距；
// 收放只做 translateY 纯变换（native 走 native driver、web 只走合成器），
// 绝不动布局属性——高度/边距动画每帧全屏重排还与 FlashList resize 处理打架
// （实测会引发滚动回跳/掉帧）。pad/PC 顶栏维持流内常驻（原布局分毫不动）。
// 方向判定与阈值在 use-chrome-scroll，动画值/复位在 chrome-store；路由变化
// 与画幅离开 phone 均硬复位为显示。
// ============================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { Animated, Pressable, View } from 'react-native';
import { usePathname } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { chromeAnim, resetChrome, useChromeHidden } from '../../lib/chrome-store.js';
import TopBar from './TopBar.jsx';
import BottomNav from './BottomNav.jsx';
import Guide from './Guide.jsx';
// 平台分流（无后缀 import，metro 按 .web.js 优先解析）：web 端两阶段 hover 预览
// 播放层，native 端 HoverPreviewLayer.js 为 null stub（零开销）
import HoverPreviewLayer from '../video/HoverPreviewLayer';
// 视频墙覆盖层（多路同播看板；常驻挂载保活，关闭态移出视口不卸载）
import WallOverlay from '../wall/WallOverlay.jsx';
import { useForm } from '../../lib/use-form.js';
// 手机横屏沉浸态统一判定(稳定设备形态口径,旋转不翻转——form 按窗口宽分档,
// 大屏手机横屏宽 844~932 会被误判成平板导致顶栏收不掉)
import { isImmersiveLandscape } from '../../lib/device-class.js';
import { useDimensions } from '../../lib/use-dimensions.js';
import { PlayerStageSlot, usePlayer } from '../../lib/player-context.jsx';
import GlassSurface from '../ui/GlassSurface.jsx';
import { RADIUS } from '../../lib/higlass.js';
import { TOPBAR_H, BOTTOMNAV_H } from '../../lib/chrome-metrics.js';
import { hasPhoneBottomNav, hasPhoneTopBar, isWatchRoute } from '../../lib/chrome-routes.js';
import { useColors } from '../../theme/index.js';

const GUIDE_KEY = 'moontent_guide';

export default function AppShell({ children }) {
  const pathname = usePathname();
  const { width, form } = useForm();
  const { height: vh } = useDimensions();
  const insets = useSafeAreaInsets();

  // 观看页：手机端顶栏底栏全收（页面自绘返回层）；平板/PC 保留顶栏、收侧栏。
  // 搜索页：手机端同样整条收起（YouTube App 形态——搜索页自绘「返回+输入」
  // 头，输入在本页进行，顶栏不再叠出第二个搜索框）；平板/PC 照旧（顶栏即输入位）
  // 手机画幅白名单口径（chrome-routes 唯一来源）：顶栏只属首页/我的，底栏只
  // 属 tab 槽位页；board/plugins/telegram×3/各详情页等自绘页头页整条收起。
  // pad/PC 不查白名单：顶栏常驻（沉浸观看收起）、无底栏。
  // 手机横屏观看页（宽<1024 且宽>高）：沉浸全屏——整条顶栏也收起，页面铺满
  // 整屏（横屏布局自管安全区/返回层），底栏侧栏本就不在；平板横屏不沉浸
  // （横屏是常态使用姿势，观看页走 land 分栏布局，顶栏保留）；
  // 应用内全屏（playerFs，native 全屏钮 / webFs，web 伪全屏）：任意画幅/方向
  // 都收顶栏进沉浸态（竖屏视频全屏铺满、平板全屏同理）
  const isWatch = isWatchRoute(pathname);
  const { playerFs, webFs } = usePlayer();
  const immersiveWatch =
    isWatch && ((playerFs || webFs) || isImmersiveLandscape(width, vh));
  const showTopBar = form === 'phone' ? hasPhoneTopBar(pathname) : !immersiveWatch;
  const showBottomNav = form === 'phone' && hasPhoneBottomNav(pathname);
  const showSidebar = !isWatch && form !== 'phone';

  // PC 侧栏形态偏好：'full'（240px 展开，默认）| 'mini'（72px 折叠）
  const [guideMode, setGuideMode] = useState('full');
  const [drawerOpen, setDrawerOpen] = useState(false);

  // 壳层收放：手机画幅 hide-on-scroll（见文件头说明）。折叠插值端点 = 栏高 +
  // 安全区；hidden 布尔态用于收起后关掉 wrapper 命中（防越界幽灵触摸）。
  const chromeHidden = useChromeHidden();
  const C = useColors();
  // 液态玻璃（iOS 26+）：手机画幅顶栏/底栏 overlay 与抽屉面板整条换玻璃材质
  //（含安全区延伸段），内容从栏底下滚过即被折射；降级端 fallback = 原不透明
  // 底，视觉与改造前一致（判定与出口统一 GlassSurface）。pad/PC 流内顶栏/
  // 侧栏不参与——流内栏背后是纯页面底色，无内容可折射，玻璃无意义。
  const topH = TOPBAR_H + insets.top;
  const bottomH = BOTTOMNAV_H + insets.bottom;

  // 恢复侧栏折叠偏好（AsyncStorage 异步，恢复前按默认展开态渲染）
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(GUIDE_KEY)
      .then((v) => { if (alive && v === 'mini') setGuideMode('mini'); })
      .catch(() => { /* 存储不可用：用默认展开态 */ });
    return () => { alive = false; };
  }, []);

  // 路由变化：关抽屉（链接点击已即时关，这里是兜底——含编程式跳转）+
  // 壳层收放硬复位（切 tab / push / 返回，进入页面恒显示态起步）
  useEffect(() => {
    setDrawerOpen(false);
    resetChrome();
  }, [pathname]);

  // 画幅离开 phone：收放交互只在手机画幅启用，切画幅硬复位为常驻
  useEffect(() => {
    if (form !== 'phone') resetChrome();
  }, [form]);

  // 汉堡：PC（非观看页）切换 常驻展开↔迷你 并持久化；其余场景开抽屉
  const handleMenuClick = useCallback(() => {
    if (form === 'pc' && !isWatch) {
      setGuideMode((m) => {
        const next = m === 'full' ? 'mini' : 'full';
        AsyncStorage.setItem(GUIDE_KEY, next).catch(() => { /* 存不进就当会话级偏好 */ });
        return next;
      });
      return;
    }
    setDrawerOpen(true);
  }, [form, isWatch]);

  // 常驻侧栏形态：PC 按 guideMode，平板恒迷你轨
  const sidebarVariant = form === 'pc' ? (guideMode === 'full' ? 'full' : 'mini') : 'mini';
  // 抽屉顶部偏移：有顶栏时对齐其总高（顶栏 56 + 顶部安全区），无顶栏只让安全区
  const drawerTop = (showTopBar ? TOPBAR_H : 0) + insets.top;

  return (
    <View className="flex-1 bg-background">
      {/* 顶栏：pad/PC 流内常驻（侧栏/主区行仍在栏下，原布局不变）；phone
          overlay 悬浮于内容之上，translateY 纯变换收放（顶栏整条含安全区
          不透明底，内容从栏底下滚过） */}
      {showTopBar &&
        (form === 'phone' ? (
          <Animated.View
            pointerEvents={chromeHidden ? 'none' : 'auto'}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              zIndex: 30,
              transform: [
                { translateY: chromeAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -topH] }) },
              ],
            }}
          >
            <GlassSurface style={{ paddingTop: insets.top }} fallbackStyle={{ backgroundColor: C.background }}>
              <TopBar onMenuClick={handleMenuClick} />
            </GlassSurface>
          </Animated.View>
        ) : (
          <View style={{ paddingTop: insets.top }}>
            <TopBar onMenuClick={handleMenuClick} />
          </View>
        ))}

      <View className="min-w-0 flex-1 flex-row">
        {/* 常驻侧栏：PC 展开 240px（guideMode=full） */}
        {showSidebar && sidebarVariant === 'full' && (
          <View className="w-60 border-r border-line bg-background">
            <Guide variant="full" />
          </View>
        )}
        {/* 常驻侧栏：迷你轨 72px（平板恒此形态；PC 折叠态同款） */}
        {showSidebar && sidebarVariant === 'mini' && (
          <View className="w-[72px] border-r border-line bg-background">
            <Guide variant="mini" />
          </View>
        )}
        {/* 主区：Stack 路由内容 */}
        <View className="min-w-0 flex-1">{children}</View>
      </View>

      {/* 底部导航：手机画幅三~六槽。overlay 悬浮于内容之上（底栏本就只在
          phone 存在），translateY 纯变换下滑出/滑回，内容滚到栏底下（页面自垫
          useChromeInsets）。iOS 26 玻璃端呈浮动圆角矩形（TabBar 与底缘脱开、
          两侧留边、圆角 = 栏高 0.36）；降级端贴边不透明底延伸到屏幕底缘 */}
      {showBottomNav && (
        <Animated.View
          pointerEvents={chromeHidden ? 'none' : 'box-none'}
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 30,
            transform: [
              { translateY: chromeAnim.interpolate({ inputRange: [0, 1], outputRange: [0, bottomH] }) },
            ],
          }}
        >
          {/* 浮动圆角矩形几何挂 glassOnlyStyle（仅玻璃端）：marginBottom=安全区 →
              胶囊悬于手势条上方，总占位与降级端一致（hide-on-scroll 平移端点
              bottomH 两端通用）；两侧留边 21pt = iOS 26 原生浮动 tab bar 实测
              口径（learnui.design 图解指南）；栏高 56 → 圆角 20（= 栏高 0.36，
              对齐参考图实测 0.35~0.36：浮动栏是圆角矩形、非全圆角胶囊，与露珠
              同半径档）；阴影取参考图实测的淡档（栏下压暗 ≈2%、软边 ~14pt），
              重阴影会糊掉玻璃自身的边缘折射；wrapper box-none 放行胶囊两侧
              留白的底层触摸 */}
          <GlassSurface
            glassOnlyStyle={{
              marginBottom: insets.bottom,
              marginHorizontal: 21,
              borderRadius: 20,
              overflow: 'hidden',
              boxShadow: '0px 5px 16px rgba(0,0,0,0.14)',
            }}
            fallbackStyle={{ paddingBottom: insets.bottom, backgroundColor: C.background }}
          >
            <BottomNav />
          </GlassSurface>
        </Animated.View>
      )}

      {/* 播放器舞台插槽：全 App 唯一播放器（docked 观看位 / mini 悬浮窗两形态）。
          渲染在本层使舞台与抽屉/视频墙成为同父兄弟——zIndex 只比同父兄弟，
          舞台挂在壳层外（Provider 根）时 native 上会整层盖住 AppShell 子树，
          抽屉/弹窗全被视频压住（web 因根无层叠上下文恰好正常，三端不一致）。
          落位后层级：内容(0) < 舞台(40) < 抽屉遮罩(40,后置) < 抽屉(50) < 视频墙(100) */}
      <PlayerStageSlot />

      {/* 抽屉：遮罩点击关闭；顶部对齐顶栏总高 */}
      {drawerOpen && (
        <>
          <Pressable
            accessibilityLabel="关闭菜单"
            className="absolute inset-0 z-40 bg-black/50"
            onPress={() => setDrawerOpen(false)}
          />
          {/* 玻璃端专属：HIG 大表面（sidebar/抽屉）用圆角矩形非胶囊——右缘
              （自由边）走同心大圆角，贴屏两缘保持直角（与窗口边缘对齐的
              同心语义，WWDC25-356）；overflow 裁内部内容 */}
          <GlassSurface
            className="absolute bottom-0 left-0 z-50 w-60"
            fallbackClassName="border-r border-line bg-background"
            style={{ top: drawerTop }}
            glassOnlyStyle={{
              borderTopRightRadius: RADIUS.drawer,
              borderBottomRightRadius: RADIUS.drawer,
              overflow: 'hidden',
            }}
          >
            <Guide variant="drawer" onNavigate={() => setDrawerOpen(false)} />
          </GlassSurface>
        </>
      )}

      {/* 全局悬浮预览层：web 端鼠标悬停卡片两阶段预览播放（native 分流为 null）。
          挂在根 View 末尾 = 兄弟序最上层（NextWeb 同位：AppShell 层级编排） */}
      <HoverPreviewLayer />
      {/* 视频墙覆盖层：多路同播看板（常驻保活；组件内部自管开合与移出视口） */}
      <WallOverlay />
    </View>
  );
}
