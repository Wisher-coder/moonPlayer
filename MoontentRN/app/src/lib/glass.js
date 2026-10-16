// ============================================================================
// glass.js —— 液态玻璃能力检测 + 启用判定（iOS 26+ Liquid Glass 单一事实源）
// ----------------------------------------------------------------------------
// 契约：isGlassSupported() / useGlassEnabled()；「怎么画」统一走
// components/ui/GlassSurface.jsx（唯一渲染出口），本模块只回答「能不能开 /
// 开没开」。全部玻璃表面（导航 chrome / 播放器控件 / 弹层）经 GlassSurface
// 消费本判定，降级路径 = 各表面现有不透明视觉，非 iOS 端代码路径零变化。
//
// 能力检测 isGlassSupported()（同步、模块级缓存）：
//   ① 仅 iOS（web/Android/SSG 恒 false，两端水合对齐无闪变）；
//   ② requireOptionalNativeModule('ExpoGlassEffect') 探测在前——包入口在模块
//     求值期就 requireNativeViewManager，原生侧缺失时直接 require 包本体是
//     致命错误（Expo Metro 上报 RedBox，外层 try/catch 拦不住；同款坑与对策
//     见 screen-orientation.js 头注）。旧调试包（未含玻璃原生侧）热更新 JS
//     由此降级；重建原生包后自动恢复；
//   ③ isLiquidGlassAvailable()：系统/编译档达标（iOS 26+ 才有真玻璃）；
//   ④ isGlassEffectAPIAvailable()：部分 iOS 26 beta 缺 UIKit API 会崩
//     （expo#40911），官方要求使用前必查。
//
// 启用判定 useGlassEnabled()（三因子相与，任一翻转即整树玻璃↔不透明切换）：
//   ① 平台能力 isGlassSupported()；
//   ② 用户开关 settings.liquidGlass（「我的」页 SettingRow，默认开；settings.js
//      水合广播保证设置页与各玻璃表面同步翻转）；
//   ③ 系统无障碍「减弱透明度」未开启（AccessibilityInfo 实时监听；开启时
//      降级不透明底，对齐系统无障碍语义——原生端无 SSG 顾虑，初始按未开启
//      处理、挂载后异步补读）。
// ============================================================================
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { getSettingsSnapshot, subscribeSettings } from './settings.js';

let supported = null;

// 能力检测（结果缓存：探测只做一次，恒定返回值不会引发消费方重渲染）
export function isGlassSupported() {
  if (supported !== null) return supported;
  supported = false;
  if (Platform.OS !== 'ios') return supported;
  // 探测在前：原生侧不存在时绝不 require 包本体（require 即致命错误）
  if (!requireOptionalNativeModule('ExpoGlassEffect')) return supported;
  try {
    const m = require('expo-glass-effect');
    supported = !!(
      m
      && typeof m.isLiquidGlassAvailable === 'function' && m.isLiquidGlassAvailable()
      && typeof m.isGlassEffectAPIAvailable === 'function' && m.isGlassEffectAPIAvailable()
    );
  } catch {
    supported = false; // 理论不可达（探测已过）：兜底静默
  }
  return supported;
}

// 启用判定（hook 规则：hooks 无条件调用，能力恒 false 时短路返回 false）
export function useGlassEnabled() {
  const ok = isGlassSupported();
  // 用户开关：快照起步（镜像未水合 = 默认开），settings 广播跟随
  const [pref, setPref] = useState(() => !!getSettingsSnapshot().liquidGlass);
  // 系统「减弱透明度」：初始按未开启，挂载后补读 + 监听翻转
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    if (!ok) return undefined;
    const off = subscribeSettings((s) => { if (s) setPref(!!s.liquidGlass); });
    let alive = true;
    AccessibilityInfo.isReduceTransparencyEnabled()
      .then((v) => { if (alive) setReduceTransparency(!!v); })
      .catch(() => { /* 查询失败按未开启，不打断玻璃 */ });
    const sub = AccessibilityInfo.addEventListener(
      'reduceTransparencyChanged',
      (e) => setReduceTransparency(!!e),
    );
    return () => {
      alive = false;
      off();
      sub.remove();
    };
  }, [ok]);

  return ok && pref && !reduceTransparency;
}
