// ============================================================================
// (tabs)/_layout.js —— 一级 Tab 导航器（页面保活层）
// ----------------------------------------------------------------------------
// 为什么要有这层：一级页（首页/分类/相册/女优/专区/搜索/我的）此前平铺在根
// Stack 里靠 router.navigate 切换，而 expo-router 的 navigate 在 Stack 语义下
// 「目标屏非当前栈顶即按新屏入栈」（fork StackRouter：无 pop 标志的 NAVIGATE
// 一律 push 新 key 的实例）——底部导航 首页↔我的 来回切，每次都会往栈里压一
// 个全新实例：旧屏的数据与滚动位留在栈底吃灰，新屏骨架屏重拉，就是「切 tab
// 页面重刷、滚动进度全丢、越切栈越深」的病根。
// 怎么治：一级页收进本 (tabs) 分组（分组不占 URL 段，对外路由地址不变），由
// bottom-tabs 导航器承接——切 tab = 只切索引，已访问的 tab 常驻挂载（lazy：
// 首访才挂载），组件树 / FlashList 滚动位 / 已拉数据全保留，切回零重建零重
// 发请求（NextWeb 侧 TabKeepAlive 常驻层的 RN 对应物）。tab 屏的 URL 参数
// （category?cat= / search?kw= / zones?tab= …）由 TabRouter 原地替换，页面侧
// useLocalSearchParams 响应式消费，常驻挂载下换参照常重拉列表。
// 壳层分工：原生 tabBar 整条隐藏（tabBar: () => null）——底部导航仍由
// AppShell 的 BottomNav（手机画幅）/ Guide 侧栏（平板·PC）按 pathname 自绘，
// 与 YouTube 壳层一致；观看页等详情路由仍走根 Stack 压在 (tabs) 组之上。
// 跳转口径（全站统一，见 lib/tab-nav.js）：tab→tab 用 router.navigate（组内
// JUMP_TO）；详情页→tab 用 router.dismissTo（POP_TO 弹回本组并切 tab，直接
// navigate 会把整个 (tabs) 组当新屏再压一份）。
// web 端非活动屏隐藏（screenLayout）：bottom-tabs 对非活动 tab 屏的隐藏依赖
// react-native-screens（MaybeScreen → Screens.Screen activityState），而
// screensEnabled() 在 web 恒为 false（core.ts：仅 ios/android/windows 视为
// native）——退化路径 MaybeScreen 渲染普通 View，非活动屏只压 zIndex:-1 仍绝
// 对定位叠在原地，透过透明背景就是「背景好几个页面重叠展示」。这里给每个
// tab 屏包一层保活壳补上隐藏。
// 隐藏口径 = visibility:hidden + pointerEvents 'none'（RNW 样式编译器对未知
// 样式键原样透传成 CSS，visibility 生效）：元素移出绘制 / 命中测试 / 无障碍
// 树，但**布局盒保留**——scrollTop 是滚动盒的属性，盒不塌陷位置就天然不动，
// 无需任何「记录/恢复」补丁。旧方案用 display:none：盒子被摘出布局，scrollTop
// 被浏览器钳到 0，只能靠 rAF 逐帧重试事后恢复，返回时先见顶再跳回（闪烁的
// 来源），整套兜底已随口径切换删除。仅 web 生效——native 端 Screens.Screen
// 的 activityState 摘挂机制本就正确，不再叠一层。screenLayout 的契约是「函数
// 返回 JSX」而非组件本身（fork useDescriptors 对其直接调用，传含 hooks 的组件
// 会把 hooks 挂错宿主），所以包一层真正的元素 <TabVisibility>。
// ============================================================================
import React from 'react';
import { Platform, View } from 'react-native';
import { Tabs, useIsFocused } from 'expo-router';

// web 端非活动 tab 屏的保活壳（原理见文件头注释）。结构必须**恒定**（始终同一
// 层 View，只切样式）——若写成「失焦才包 View」的条件结构，children 会在
// 「裸节点 ↔ 包裹层」两级结构间搬家，React 按位置对不上直接整棵子树卸载重挂：
// 保活层自己把保活打穿，真机上表现为切回 tab 整页重刷、进度全丢。
function TabVisibility({ children }) {
  const focused = useIsFocused();
  return (
    <View
      // pointerEvents 走 style（RNW 对 props.pointerEvents 已弃用告警）
      style={[{ flex: 1 }, !focused && { visibility: 'hidden', pointerEvents: 'none' }]}
    >
      {children}
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={() => null}
      backBehavior="history"
      screenOptions={{ headerShown: false }}
      screenLayout={Platform.OS === 'web'
        ? ({ children }) => <TabVisibility>{children}</TabVisibility>
        : undefined}
    />
  );
}
