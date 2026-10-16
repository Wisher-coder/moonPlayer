// ============================================================================
// theme/index.js —— 主题体系出口
// ----------------------------------------------------------------------------
// - THEME_VARS：light/dark 两套 NativeWind vars() 样式对象，挂在 ThemeProvider
//   根部 View 的 style 上，后代所有 var(--xxx) 语义色随之换档（native 经
//   css-interop 变量观察器传播、web 经 CSS 自定义属性级联，两端同一份代码）；
// - useColors()：命令式取色钩子（图标 color / Modal 背景等 className 够不着
//   的位置），返回当前 resolved 主题的 { background, surface, surface2, line,
//   foreground, muted, accent, accentStrong, link }（驼峰键，去 -- 前缀）。
//   依赖 lib/theme-context（方向单一：本文件 → theme-context → tokens，
//   theme-context 只 import tokens，不引本文件，无循环）。
// ============================================================================
import { useTheme } from '../lib/theme-context.jsx';
import { COLORS, BADGE_BG, SCRIM_BG, TOKEN_NAMES } from './tokens.js';

export { COLORS, BADGE_BG, SCRIM_BG, TOKEN_NAMES };
// 主题变量对象在 lib/theme-context.jsx 单点构造（ThemeProvider 根部挂载），
// 此处仅再导出，避免双份构造
export { THEME_VARS } from '../lib/theme-context.jsx';

// 命令式取色：resolved 主题的语义色（驼峰键）
export function useColors() {
  const { resolved } = useTheme();
  const src = COLORS[resolved] || COLORS.light;
  return {
    background: src['--background'],
    surface: src['--surface'],
    surface2: src['--surface-2'],
    line: src['--line'],
    foreground: src['--foreground'],
    muted: src['--muted'],
    accent: src['--accent'],
    accentStrong: src['--accent-strong'],
    link: src['--link'],
    badge: BADGE_BG,
    scrim: SCRIM_BG,
  };
}
