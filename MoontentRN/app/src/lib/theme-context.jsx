// ============================================================================
// theme-context.jsx —— 主题上下文（light / dark / system 三态）
// ----------------------------------------------------------------------------
// 契约：ThemeProvider；useTheme() → { mode, resolved, setMode }（另附 toggle
// 便捷方法）。mode 为用户偏好三态，resolved 为实际生效值（'light'|'dark'）。
// 持久化：AsyncStorage 键 'moontent_theme'（键语义同 NextWeb，默认 system）。
// 生效机制（双轨，同一 resolved 值驱动，不会互相矛盾）：
//   ① 根部 vars()：ThemeProvider 自带一个 flex-1 包装 View，style 挂
//      THEME_VARS[resolved]（--background 等全部语义变量），后代所有
//      var(--xxx) 语义色类（bg-background / text-foreground / …）随主题换档；
//      native 经 css-interop 变量观察器沿 React 树传播，web 经 CSS 自定义
//      属性级联——两端同一份代码。
//   ② nativewind colorScheme.set(mode)：全局覆写颜色方案，使 dark: 变体与
//      useColorScheme() 与应用主题对齐（'system' 态还原跟随系统）。
//      注意这是全局副作用：从 'dark'/'light' 切回 'system' 时显式重读
//      Appearance.getColorScheme() 修系统偏好缓存（覆写会污染其返回值）。
// 系统偏好：Appearance.addChangeListener 实时跟随（system 态下生效）。
// 存储读写全程静默降级（存储不可用按 system 会话级处理）。
// ============================================================================
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Appearance, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { colorScheme, vars } from 'nativewind';
import { COLORS } from '../theme/tokens.js';

// 【web 深色模式开关】nativewind 的 colorScheme.set() 仅在 class 模式下可用：
// 编译期由 tailwind.config.js 的 darkMode:'class' 注入 --css-interop-darkMode:
// class dark（RN-web 0.21 无 StyleSheet.setFlag API，运行时改不了，只能走配置）。

const KEY = 'moontent_theme';

const ThemeContext = createContext(null);

// 主题变量（模块级构建一次；theme/index.js 从这里再导出，保证单一构造点）
export const THEME_VARS = {
  light: vars(COLORS.light),
  dark: vars(COLORS.dark),
};

// 合法主题值校验：非 light/dark/system 的脏数据一律当 system
const normalize = (v) => (v === 'light' || v === 'dark' || v === 'system' ? v : 'system');

export function ThemeProvider({ children }) {
  // 初始恒 system：真实偏好挂载后从 AsyncStorage 恢复（AsyncStorage 异步，
  // 恢复前 resolved 按当前系统偏好走，通常与最终一致、无闪变问题）。
  // sysDark 初始恒 false（=light）：SSG 导出的首帧 HTML 是 light 变量组，客户端
  // 首帧必须与之完全一致（否则 hydration 不匹配 #418 整树重建）；真实系统偏好
  // 在挂载 effect 里补读，属于水合完成后的正常重渲染。
  const [mode, setModeState] = useState('system');
  const [sysDark, setSysDark] = useState(false);
  const [ready, setReady] = useState(false);

  // 挂载：恢复本机主题选择 + 订阅系统偏好变化（system 态实时跟随）
  useEffect(() => {
    let alive = true;
    // 水合后补读真实系统偏好（见上：初始值刻意与 SSG 对齐）
    setSysDark(Appearance.getColorScheme() === 'dark');
    (async () => {
      let stored = null;
      try { stored = await AsyncStorage.getItem(KEY); } catch (_e) { /* 存储不可用：当 system */ }
      if (!alive) return;
      setModeState(normalize(stored));
      setReady(true);
    })();
    const sub = Appearance.addChangeListener(({ colorScheme: cs }) => setSysDark(cs === 'dark'));
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  // 实际生效值：显式选择直取，system 跟随系统
  const resolved = mode === 'system' ? (sysDark ? 'dark' : 'light') : mode;

  // 生效：dark: 变体 / useColorScheme 全局对齐（ready 前不动，避免把恢复中的
  // 默认 system 覆写到渲染层——system 本就是默认值，跳过无副作用）
  useEffect(() => {
    if (!ready) return;
    colorScheme.set(mode);
    // 回到 system 态：覆写清除后 Appearance 返回真实系统值，重读一次修正缓存
    // （显式 dark/light 期间系统偏好若变化，监听回调读到的是被污染的值）
    if (mode === 'system') setSysDark(Appearance.getColorScheme() === 'dark');
  }, [mode, ready]);

  // 持久化：mode 变化即写（ready 后才写，防把恢复中的瞬时默认值覆盖存储）
  useEffect(() => {
    if (!ready) return;
    AsyncStorage.setItem(KEY, mode).catch(() => { /* 存不进就算会话级切换 */ });
  }, [mode, ready]);

  const setMode = useCallback((t) => {
    if (t !== 'light' && t !== 'dark' && t !== 'system') return; // 非法入参不落状态不落盘
    setModeState(t);
  }, []);

  // 快捷切换：在 light/dark 间跳（resolved 取反；从 system 出发落到显式反色）
  const toggle = useCallback(() => {
    setModeState(resolved === 'dark' ? 'light' : 'dark');
  }, [resolved]);

  // value 必须缓存（全站大量消费组件，Provider 每次渲染造新对象会引发整片
  // 无意义重渲染）；setMode/toggle 已是稳定引用，真实状态变化才换新 value
  const value = useMemo(() => ({ mode, resolved, setMode, toggle, ready }), [mode, resolved, setMode, toggle, ready]);

  return (
    <ThemeContext.Provider value={value}>
      {/* 主题变量根：所有 var(--xxx) 语义色的注入点（flex-1 占满外壳） */}
      <View style={THEME_VARS[resolved]} className="flex-1 bg-background">
        {children}
      </View>
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return ctx;
}

// 无 Provider 场景的安全取值（GlassSurface 等 UI 原语用：缺席按浅色档降级，
// 不抛错不阻断组件树——语义同 usePalette 的降级路径；钩子恒定调用，无 try/catch）
export function useThemeSafe() {
  return useContext(ThemeContext)
    || { mode: 'system', resolved: 'light', setMode: () => {}, toggle: () => {}, ready: false };
}
