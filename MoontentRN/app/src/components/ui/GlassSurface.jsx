// ============================================================================
// GlassSurface.jsx —— 液态玻璃表面（唯一渲染出口；iOS 26+ 生效，其余端零变化）
// ----------------------------------------------------------------------------
// 双路径组件：useGlassEnabled() 为真渲染 expo-glass-effect 的 GlassView
// （iOS 26 原生液态玻璃），否则渲染普通 View 并叠加 fallback 样式——降级
// 端（web/Android/旧 iOS/减弱透明度/用户关开关）视觉与改造前完全一致。
// props 约定（调用方零平台分支，两端同一份 JSX）：
//   className / style        布局与通用样式，两端都应用（定位/尺寸/内边距）；
//   fallbackClassName /      仅降级端应用——把改造前的不透明视觉（bg-* /
//   fallbackStyle            border-* 等）原样搬进来，玻璃端不生效（玻璃材质
//                            自带明暗与高光边缘，再叠不透明底会闷掉折射）；
//   glassOnlyStyle           仅玻璃端应用——iOS 26 重设计的专属几何（浮动胶囊
//                            的外边距/全圆角/投影等；对称于 fallbackStyle）；
//   glassStyle               'regular'（默认，磨砂）| 'clear'（更通透，叠视频
//                            上的控件胶囊用）；
//   tint                     透染色（可选，HIG：tint 只留给主操作强调——全 app
//                            现仅 Dialog 主钮使用；播放器系已全面改 dimming 口
//                            径，勿再新增大面积 tint）；
//   dark                     true 时 colorScheme 恒 'dark'（播放器 chrome 恒
//                            深色契约）；否则跟随应用主题（useTheme().resolved，
//                            GlassView 的 colorScheme 就是为自带主题切换的 app
//                            准备的）；ThemeProvider 缺席（Electron 播放子窗
//                            等场景）按 'light' 降级，同 usePalette 语义；
//   interactive              映射 GlassView.isInteractive（可点控件的玻璃跟
//                            随按压反馈——HIG interactive 语义：按压缩放+弹跳
//                            +从指尖内发光），默认 false；
//   dimming                  0~1 暗化层（仅玻璃路径生效）。HIG Clear 变体口径：
//                            叠亮色媒体内容时加 35% 黑色暗化层（官方示例
//                            .background(.black.opacity(0.3))）——层在玻璃内部、
//                            前景内容之下。实现为首个 absolute-fill 子 View +
//                            overflow hidden（裁进玻璃圆角形状）。降级端忽略
//                            （原不透明底本就足够对比）；
//   shown                    显隐控制（弹层/浮层专用；undefined = 常显）。
//                            玻璃路径走 materialize（HIG：显隐靠调制折光而非
//                            opacity 淡入淡出）：glassEffectStyle 在目标样式与
//                            'none' 间 animate 切换；原生 'none' 只撤材质不藏
//                            内容（GlassView.swift 核实），内容层同步包进子
//                            View opacity 门卫（子层非玻璃祖先，安全）——观感
//                            为玻璃熔聚而出、内容随玻璃到位。隐藏时本组件
//                            pointerEvents 收 'none'——调用方的外层 absolute
//                            包裹不在管辖内，保持挂载的调用方须自行给包裹层
//                            同步 pointerEvents={shown?'auto':'none'}。降级路
//                            径退化为直接渲染 null（与改造前条件挂载等价）。
// 铁律：GlassView 及其祖先的 opacity 为 0 会彻底破坏玻璃渲染——需要显隐用
//   shown（materialize）或移除挂载，绝不用 opacity 动画（本仓壳层收放本就
//   是 translateY 纯变换，天然安全）。
// ============================================================================
import React from 'react';
import { Platform, View } from 'react-native';
import { cssInterop } from 'nativewind';
import { isGlassSupported, useGlassEnabled } from '../../lib/glass.js';
import { useThemeSafe } from '../../lib/theme-context.jsx';
import { cn } from '../../lib/utils.js';

// iOS 且能力达标才 require 玻璃组件本体（探测语义见 lib/glass.js 头注；
// web/Android 上 expo-glass-effect 虽是纯 View 占位实现，但按端守卫直接不
// 引入）。cssInterop 注册一次：GlassView 与普通 View 同吃 NativeWind
// className，调用方不用为玻璃路径另写一套样式
let GlassView = null;
if (Platform.OS === 'ios' && isGlassSupported()) {
  try {
    GlassView = require('expo-glass-effect').GlassView;
    cssInterop(GlassView, { className: 'style' });
  } catch {
    GlassView = null; // 理论不可达（探测已过）：兜底走降级路径
  }
}

export default function GlassSurface({
  glassStyle = 'regular',
  tint,
  dark = false,
  interactive = false,
  dimming,
  shown,
  className,
  style,
  fallbackClassName,
  fallbackStyle,
  glassOnlyStyle,
  children,
  ...rest
}) {
  const enabled = useGlassEnabled();
  // colorScheme：dark 显式恒深色（播放器 chrome 契约）；否则跟应用主题；
  // ThemeProvider 缺席（Electron 播放子窗等）按浅色降级（useThemeSafe 不抛错）
  const { resolved } = useThemeSafe();
  const scheme = dark ? 'dark' : (resolved || 'light');

  // 降级路径 + 显隐关：与改造前条件挂载完全等价（null）
  if (!enabled && shown === false) return null;

  if (enabled && GlassView) {
    const { pointerEvents, ...glassRest } = rest;
    // materialize（HIG）：显隐切换动画调制折光，绝不动 GlassView/祖先 opacity
    //（expo 原生侧 'none' 只撤材质不藏内容——GlassView.swift 源码核实：effect
    // 置空后 contentView 照常渲染。故隐藏时内容层同步藏进子 View opacity=0，
    // 子层不是玻璃祖先、不触禁区；玻璃本体仍走 animate 物化/去物化，观感 =
    // 玻璃熔聚而出、内容随玻璃到位）
    const hidden = shown === false;
    const effect = shown === undefined
      ? glassStyle
      : { style: hidden ? 'none' : glassStyle, animate: true };
    return (
      <GlassView
        glassEffectStyle={effect}
        tintColor={tint}
        colorScheme={scheme}
        isInteractive={interactive}
        className={className}
        style={[style, glassOnlyStyle, dimming ? { overflow: 'hidden' } : null]}
        pointerEvents={shown === false ? 'none' : pointerEvents}
        {...glassRest}
      >
        {dimming ? (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 0, left: 0, right: 0, bottom: 0,
              backgroundColor: `rgba(0,0,0,${Math.max(0, Math.min(1, dimming))})`,
            }}
          />
        ) : null}
        {shown === undefined ? (
          children
        ) : (
          <View
            pointerEvents={hidden ? 'none' : 'box-none'}
            style={{ opacity: hidden ? 0 : 1 }}
          >
            {children}
          </View>
        )}
      </GlassView>
    );
  }
  return (
    <View className={cn(className, fallbackClassName)} style={[style, fallbackStyle]} {...rest}>
      {children}
    </View>
  );
}
