// ============================================================================
// _layout.js —— 根布局（expo-router）
// ----------------------------------------------------------------------------
// Provider 编排（自外向内）：
//   GestureHandlerRootView —— 手势系统根（react-native-gesture-handler 必需）；
//   SafeAreaProvider        —— 安全区上下文（AppShell 顶栏/底栏取 insets）；
//   ThemeProvider           —— 主题三态 + 语义色变量注入（含根部 vars() 包装 View）；
//   SiteProvider            —— 数据源站点上下文（AsyncStorage 持久化）；
//   PlayerProvider          —— 播放实例常驻 Provider（阶段三交付；契约：
//                              usePlayer() → { current, open, close }，open 后
//                              观看页全屏停泊、其余页右下迷你浮层不断流）；
//   AppShell                —— 三画幅外壳（顶栏/侧栏/底部导航/抽屉）+ Stack 路由。
// 双壳分流（IS_PLAYER_WINDOW，加载期定格）：桌面 Electron 的「视频播放独立
// 窗」深链（?win=player）不走 AppShell，改走 PlayerWindowFrame——36px 窄
// 标题栏（拖拽区 + 自绘窗口控件）+ 同一份 Stack，Provider 编排不变。
// 三壳分流（IS_MENU_WINDOW，加载期定格）：桌面 Electron 的「菜单独立子窗」
// 深链（/menu?win=menu，倍速/音量/设置弹层浮出为独立透明小窗——腾讯视频
// 形态，见 desktop/main.js 菜单会话区）连壳都不带：只挂路由让 /menu 屏
//（= MenuWindowRoot）渲染，主题/站点/播放器 Provider 一概不需要（面板是
// 固定深灰弹层语言），透明底色由 MenuWindowRoot 自理。
// Stack 结构：一级 tab 页在 (tabs) 分组（bottom-tabs 保活，切 tab 不卸载不重
// 拉滚动不丢），详情路由（观看/专辑/女优/包/板块/插件管理）压在组之上；跳转
// 口径见 lib/tab-nav.js。web 端另有整栈保活层：presentation transparentModal +
// screenLayout StackKeepAlive 壳（被压屏「不绘制但布局保留」，返回零闪烁零
// 滚动丢失，机制详见 RootStack/StackKeepAlive 处注释）。
// Stack 全 screenOptions headerShown:false（壳层自绘顶栏与标题）；背景透明让
// 外壳主题底色透出。StatusBar 样式随 resolved 主题联动。
// ============================================================================
import '../global.css';
// 控制台噪声精确过滤必须最先执行(抢在一切组件渲染前装好),见其文件头说明
import '../lib/console-guard.js';
import React, { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider as NavThemeProvider, useIsFocused, usePathname, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
// 手势根：平台分流（web=透传 View，不引 gesture-handler 桶 → reanimated 不进
// 首屏；native=真 GestureHandlerRootView），见 components/layout/GhRoot*.js
import GestureHandlerRootView from '../components/layout/GhRoot.js';
// 平台分流（必须无后缀 import，metro 才做 .web.js 优先解析）：web=自绘
// 窗口控件三钮（Electron 无边框壳）；native=null stub
import WindowControls from '../components/layout/WindowControls';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from '../lib/theme-context.jsx';
import { SiteProvider } from '../lib/site-context.jsx';
import { PlayerProvider, usePlayer, PlayerStageSlot } from '../lib/player-context.jsx';
import AppShell from '../components/layout/AppShell.jsx';
// 播放独立窗识别与切集指令（桌面壳，见 lib/desktop-bridge.js 头注释）
import {
  IS_MENU_WINDOW,
  IS_PLAYER_WINDOW,
  subscribeNavigate,
  useNativeTrafficLights,
  TRAFFIC_LIGHT_W,
  desktopOpenMain,
  winControls,
} from '../lib/desktop-bridge.js';
import { Home, Pin, PinSolid } from '../components/icons.js';
import { usePlayerChrome } from '../lib/player-chrome.js';
import { setMiniWindow, useMiniWindow } from '../lib/mini-window-store.js';
import { videoPath } from '../lib/open-video.js';
import { useColors } from '../theme/index.js';

// 状态栏样式随主题（深底亮字 / 浅底暗字）
function ThemedStatusBar() {
  const { resolved } = useTheme();
  return <StatusBar style={resolved === 'dark' ? 'light' : 'dark'} />;
}

// 导航栈主题：底色强制透明。expo-router 的栈容器（react-native-screens 的
// ScreenStack）默认拿 react-navigation DefaultTheme 的 #f2f2f2 垫在每页之下
// （position:absolute 全幅面、随应用主题深浅都不换），与应用主题底色冲突
// （暗色下垫浅灰、浅色下垫灰非白）。这里用 expo-router 公开导出的
// ThemeProvider 按应用 resolved 主题供给导航主题、仅把 background 改透明——
// 页面底色一律由 ThemeProvider 根部（--background）提供，栈只管路由不管配色。
function ThemedNavShell({ children }) {
  const { resolved } = useTheme();
  const base = resolved === 'dark' ? DarkTheme : DefaultTheme;
  const theme = { ...base, colors: { ...base.colors, background: 'transparent' } };
  return <NavThemeProvider value={theme}>{children}</NavThemeProvider>;
}

// 播放独立窗外壳（桌面 Electron 专用，深链 ?win=player 由 desktop/main.js
// 建窗注入；IS_PLAYER_WINDOW 模块加载期定格，见 desktop-bridge.js）：
// 不带 AppShell（顶栏/侧栏/底栏/看板/悬浮预览全部不参与）。
// 【无独立 header —— 控制钮浮在画面之上】形态对齐站方播放窗（腾讯视频客户端）：
// 视频区从窗口顶边起铺满（左列整块都是视频），窗口控制不占任何版面：
//   拖拽带 —— 整窗顶部一条透明 app-drag（本窗唯一拖拽区；浮钮各自 app-nodrag
//        且 zIndex 更高，点按不被吞）；
//   左端 home 钮「打开主界面」——锚在视频区左上（macOS 原生红绿灯在窗口左上，
//        按 TRAFFIC_LIGHT_W 让位）；桌面壳经桥把主窗置前（恢复+显示+聚焦），
//        浏览器 ?win=player 调试直达回落首页；悬停出同款气泡；
//        小窗态其右侧补片名（站方小窗形态：home + 片名在顶）；
//   右端 窗口置顶（桌面端专属：把本窗钉在最前，再点取消）——锚在视频区右上：
//        右缘按观看页上报的右侧面板宽收进来（player-chrome 的 sideW），钮压在
//        画面右上而不越到面板顶上；中段不摆任何文本（站方此处是「多窗口片单」
//        页签，本应用无对应物）。
//   窗口三钮（Windows/Linux 自绘）恒在窗口右上角，与视频区无关。
// 小窗播放态（PlayerControls 右下「小窗」钮切，主进程缩窗+置顶，见 desktop/
// main.js）：观看页收右侧面板（只留视频），本壳在 home 右侧补片名——站方播放
// 器小窗形态（浮窗 + home + 片名 + 控件压在画面上）。
// Provider 编排与主壳完全一致——视频页依赖 Theme/Site/Player 三个上下文
// （usePlayer 停泊播放器）。
// 单窗复用切集：订阅主进程 moontent:navigate 指令，本窗 SPA 内 router.push
// 无刷新切集（主窗点新视频 → 播放窗原地换片，不整页重载白闪）。
// 浮条高 44：与 desktop/main.js 的 titleBarH 口径一致（macOS 红绿灯垂直居中）。

// 浮条图标钮：32px 圆钮（玩家 chrome 恒深色——白图标 + 半透明黑底，压在画面/
// 亮色帧上也看得清；悬停加深）+ 悬停气泡（文案同站方：钮下方黑底小气泡，见
// 参考的「打开主界面」气泡）。app-nodrag 必须显式挂——拖拽区内的可点元素不声明
// 会被壳层当拖窗，点按落空
function HeaderIconBtn({ label, onPress, children }) {
  const [hovered, setHovered] = useState(false);
  return (
    <View style={{ position: 'relative' }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        className="app-nodrag h-8 w-8 items-center justify-center rounded-full"
        style={({ pressed }) => ({
          backgroundColor: pressed
            ? 'rgba(0,0,0,0.72)'
            : hovered
              ? 'rgba(0,0,0,0.55)'
              : 'rgba(0,0,0,0.32)',
        })}
      >
        {children}
      </Pressable>
      {/* 悬停气泡：不接事件（pointerEvents none），左右各出 80px 留居中余量 */}
      {hovered ? (
        <View
          style={{
            position: 'absolute',
            top: 34,
            left: -80,
            right: -80,
            alignItems: 'center',
            zIndex: 400,
            pointerEvents: 'none',
          }}
        >
          <View
            className="rounded px-2 py-1"
            style={{ backgroundColor: 'rgba(0,0,0,0.85)' }}
          >
            <Text className="text-xs text-white" allowFontScaling={false}>
              {label}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function PlayerWindowFrame({ children }) {
  const router = useRouter();
  // macOS 红绿灯让位（壳层 titleBarStyle:'hidden' 保留原生钮在左，
  // desktop/main.js 按浮条高 44 垂直居中摆放；自绘三钮在 mac 自渲染 null）
  const nativeLights = useNativeTrafficLights();
  // 观看页经 player-chrome 供的两件事：片名（仅小窗态显示）与右侧面板宽
  // （浮钮右缘锚点——站方形态里这些钮属于画面，不越到右侧面板顶上）。
  // 注意：PlayerWindowFrame 虽订阅了 chrome 版本，但 children 是父级传来的同一
  // 元素引用，React 直接跳过其子树重渲染，不会把观看页拖进本壳的更新
  const chrome = usePlayerChrome() || {};
  const miniWin = useMiniWindow();
  // 窗口置顶 / 小窗（桌面端专属）：初值查主进程，切换由主进程回写状态
  const [onTop, setOnTop] = useState(false);
  useEffect(() => {
    let alive = true;
    winControls.isAlwaysOnTop().then((v) => {
      if (alive) setOnTop(v);
    });
    winControls.isMini().then((v) => {
      if (alive) setMiniWindow(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  const toggleOnTop = useCallback(async () => {
    setOnTop(await winControls.toggleAlwaysOnTop());
  }, []);

  useEffect(() => {
    return subscribeNavigate(({ site, id }) => {
      if (site && id) router.push(videoPath(site, id));
    });
  }, [router]);

  // 打开主界面：把主窗置前（恢复+显示+聚焦）——主窗是应用入口，关闭即退出整个
  // 应用；非桌面（浏览器 ?win=player 调试直达）回落回首页
  const openMain = useCallback(async () => {
    const ok = await desktopOpenMain();
    if (!ok) router.replace('/');
  }, [router]);

  // 浮钮与窗口顶边的距离（站方形态约半个 44px 顶栏）：顶栏高度 44 减去 32px
  // 钮高的一半 → 6；这里取 8（视觉上更稳，且不与拖拽带边缘打架）
  const BTN_TOP = 8;
  // 左端起点：macOS 红绿灯整组宽 TRAFFIC_LIGHT_W + 钮侧留白；非 mac 贴窗口左缘
  const btnLeft = nativeLights ? TRAFFIC_LIGHT_W : 8;
  // 右端起点：右侧面板宽（player-chrome 的 sideW，land 画幅才有；小窗态为 0）
  // + 钮侧留白——钮压在视频区右上，不越到面板上
  const btnRight = Math.max(0, Number(chrome.sideW) || 0) + 8;

  return (
    <View style={{ flex: 1 }}>
      {/* 内容区从窗口顶边起（无独立标题栏——视频铺满左列整块） */}
      <View style={{ flex: 1 }}>{children}</View>
      {/* 播放器舞台插槽:舞台元素由 PlayerProvider 经上下文下发、各壳层自行
          渲染(主壳在 AppShell 内与抽屉同父编排层级;本窗无抽屉/看板,插槽
          置末位=窗口内最上层,视频页停泊位即整个内容区) */}
      <PlayerStageSlot />
      {/* 拖拽带：整窗顶部一条透明 app-drag（本窗唯一拖拽区——浮钮各自
          app-nodrag 且 zIndex 更高，点按不被吞） */}
      <View
        className="app-drag"
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 44, zIndex: 100 }}
      />
      {/* 左端「打开主界面」：锚在视频区左上（macOS 红绿灯在窗口左上，让位）；
          小窗态其右侧补片名（站方小窗形态：home + 片名在顶，见参考小窗） */}
      <View
        style={{
          position: 'absolute',
          top: BTN_TOP,
          left: btnLeft,
          flexDirection: 'row',
          alignItems: 'center',
          zIndex: 110,
        }}
      >
        <HeaderIconBtn label="打开主界面" onPress={openMain}>
          <Home size={17} color="#fff" />
        </HeaderIconBtn>
        {miniWin && chrome.title ? (
          <Text
            numberOfLines={1}
            allowFontScaling={false}
            style={{
              marginLeft: 10,
              maxWidth: 320,
              fontSize: 13,
              color: '#fff',
              // RNW 弃用 textShadow* 三件套（web 走 CSS 字符串语法；native 只有三件套）
              ...Platform.select({
                web: { textShadow: '0px 1px 4px rgba(0,0,0,0.65)' },
                default: {
                  textShadowColor: 'rgba(0,0,0,0.65)',
                  textShadowOffset: { width: 0, height: 1 },
                  textShadowRadius: 4,
                },
              }),
            }}
          >
            {chrome.title}
          </Text>
        ) : null}
      </View>
      {/* 右端「窗口置顶」：锚在视频区右上（桌面端专属；置顶态以同形填充图标
          区分——线性=未置顶 / 填充=已置顶，播放器整体去红口径图标恒白） */}
      <View
        style={{
          position: 'absolute',
          top: BTN_TOP,
          right: btnRight,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          zIndex: 110,
        }}
      >
        <HeaderIconBtn label={onTop ? '取消置顶' : '窗口置顶'} onPress={toggleOnTop}>
          {onTop ? <PinSolid size={16} color="#fff" /> : <Pin size={16} color="#fff" />}
        </HeaderIconBtn>
      </View>
      {/* 自绘窗口三钮（Windows/Linux 无边框壳；macOS 为 null——原生红绿灯在左）。
          窗口级控件恒在窗口右上角（不跟视频区走） */}
      <View
        className="app-nodrag"
        style={{ position: 'absolute', top: 0, right: 0, height: 44, flexDirection: 'row', zIndex: 110 }}
      >
        <WindowControls />
      </View>
    </View>
  );
}

export default function RootLayout() {
  // 菜单独立子窗：极简树（不带壳与 Provider，见文件头三壳分流注）；保活
  // screenLayout 也一并跳过（StackKeepAlive 依赖主题/播放器上下文）
  if (IS_MENU_WINDOW) {
    return (
      <View style={{ flex: 1 }}>
        <RootStack />
      </View>
    );
  }
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <SiteProvider>
            <PlayerProvider>
              <ThemedStatusBar />
              {IS_PLAYER_WINDOW ? (
                <PlayerWindowFrame>
                  <ThemedNavShell>
                    <RootStack />
                  </ThemedNavShell>
                </PlayerWindowFrame>
              ) : (
                <AppShell>
                  <ThemedNavShell>
                    <RootStack />
                  </ThemedNavShell>
                </AppShell>
              )}
            </PlayerProvider>
          </SiteProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// web 端根栈保活壳（screenLayout 逐屏包裹，原理与 (tabs)/_layout.js 的
// TabVisibility 同层）：expo-router 在 web 上的 <Stack> 是 JS 实现（vendored
// NativeStackView），push 新屏时给下层屏加 display:'none' ——盒子被摘出布局，
// 下层（整个 (tabs) 组 / 上一级视频页）的 scrollTop 被浏览器钳到 0，返回即回顶。
// 同一处 vendored 代码有个官方后门：上层屏 presentation ∈ transparentModal 时
// 下层保持 display:'flex'（且该 web JS 栈无动画代码路径，transparentModal 在
// web 纯粹只影响这一处 display 判定，无副作用）。配合全局 presentation:
// 'transparentModal'（见 RootStack）让被压屏永不塌陷后，由本壳把失焦屏
// visibility:hidden + pointerEvents 'none'（移出绘制/命中/无Accessibility树，
// 布局盒保留）——滚动位置与组件树天然不丢，零「记录/恢复」代码。仅 web 生效；
// native 端 native-stack 经 react-native-screens 摘挂视图本就正确，不包。
// 【舞台变形联动】播放器舞台（player-context 的 PlayerStage）在 expanding/
// entering/shrinking 相位时，下层屏须保持可见——首页内容要在播放器放大/缩小
// 的背后透出（YouTube 手感：过渡期唯一在动的是播放器）；落定（docked/mini）
// 后才隐。观看页自身不垫底色（页面根自带主题底色且随内容淡入淡出，壳垫的
// 话淡入期会盖住下层屏）；其余屏照旧由壳垫主题底色兜住透叠。
function StackKeepAlive({ children }) {
  const focused = useIsFocused();
  const C = useColors();
  const pathname = usePathname();
  const { uiPhase } = usePlayer();
  const isWatch = !!pathname && pathname.startsWith('/video/');
  if (focused) {
    return <View style={[{ flex: 1 }, isWatch ? null : { backgroundColor: C.background }]}>{children}</View>;
  }
  // 失焦屏:舞台变形期保可见,落定再隐(pointerEvents 走 style——RNW 对
  // props.pointerEvents 已弃用告警)
  const reveal = uiPhase === 'expanding' || uiPhase === 'entering' || uiPhase === 'shrinking';
  return (
    <View style={[{ flex: 1 }, reveal ? { visibility: 'visible' } : { visibility: 'hidden', pointerEvents: 'none' }]}>
      {children}
    </View>
  );
}

// 根 Stack（主壳 / 播放独立窗 / 菜单独立子窗共用同一份路由屏声明）
function RootStack() {
  const isWeb = Platform.OS === 'web';
  // 菜单独立子窗不包保活壳（StackKeepAlive 依赖主题/播放器上下文，菜单窗
  // 分支不带这些 Provider）
  const keepAlive = isWeb && !IS_MENU_WINDOW;
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        // 路由屏背景透明，主题底色由外壳（ThemeProvider 根）提供
        contentStyle: { backgroundColor: 'transparent' },
        // web 专用保活口径：vendored web 栈对被压屏默认 display:none（布局
        // 塌陷 → 滚动归零），transparentModal 让下层保持 display:flex，配合
        // 上方 StackKeepAlive 壳完成「不绘制但布局保留」。native 不设——
        // native-stack 的 transparentModal 是真模态语义（下层不摘挂），会
        // 破坏原生返回手势与层叠观感，原生保活由 react-native-screens 承担
        ...(isWeb && { presentation: 'transparentModal' }),
      }}
      screenLayout={keepAlive ? ({ children }) => <StackKeepAlive>{children}</StackKeepAlive> : undefined}
    >
      {/* 菜单独立子窗屏（桌面壳深链 /menu?win=menu；普通窗口误入自回落首页，
          见 menu.js） */}
      <Stack.Screen name="menu" />
      {/* 一级 tab 页组（首页/分类/相册/女优/专区/搜索/我的；保活切
          换不卸载不重拉，结构与跳转口径见 (tabs)/_layout.js） */}
      <Stack.Screen name="(tabs)" />
      {/* 板块详情（板块书架 BoardsHome 进入） */}
      <Stack.Screen name="board" />
      {/* Telegram 专属页（登录 + 对话列表;账号型站源独立入口,不参与切站） */}
      <Stack.Screen name="telegram" />
      {/* Telegram 共享媒体面板（媒体/文件/链接/语音；id = 对话键 peerKey） */}
      <Stack.Screen name="telegram/media/[id]" />
      {/* Telegram 聊天页（对话默认入口；id = 对话键 peerKey） */}
      <Stack.Screen name="telegram/chat/[id]" />
      {/* 站源插件管理（「我的」页片源节进入；加载/卸载纯前端态） */}
      <Stack.Screen name="plugins" />
      {/* 深链详情页（site 维度路由参数）——视频页关掉栈动画与手势:舞台
          （PlayerStage）的放大/缩小变形就是过渡本身,栈的整页推进动画会叠出
          「明显切页」感(YouTube 同款观感的关键);iOS 侧滑返回会绕过编排返回
          (内容淡出+舞台缩小后再 pop),一并禁掉,返回统一走页面自绘箭头/
          Android 硬返回 */}
      <Stack.Screen
        name="video/[site]/[id]"
        options={isWeb ? undefined : { animation: 'none', gestureEnabled: false }}
      />
      <Stack.Screen name="package/[site]/[id]" />
      <Stack.Screen name="album/[site]/[id]" />
      <Stack.Screen name="author/[site]/[id]" />
    </Stack>
  );
}
