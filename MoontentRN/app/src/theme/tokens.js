// ============================================================================
// tokens.js —— 主题语义色令牌（唯一事实源）
// ----------------------------------------------------------------------------
// 取值对齐 NextWeb/app/globals.css 的 YouTube 亮/暗双主题体系：
//   浅底 #fff / 深底 #0f0f0f、面板 #f9f9f9→深 #212121、抬升面 #f2f2f2→深 #272727、
//   品牌红 #f00（深浅同值）、交互蓝浅色 #065fd4 / 深色 #3ea6ff，无描边扁平。
// 消费方式（三处同步约定）：
//   ① tailwind.config.js 的 colors 把语义类映射到 var(--xxx)；
//   ② global.css 的 :root / .dark 放 web 兜底值；
//   ③ ThemeProvider 根部 vars() 按本文件在 native/web 运行时注入。
// 本文件保持纯 JS（不 import 任何 RN / nativewind 模块），任何层都可安全引用；
// 组件里需要「命令式取色」（图标 color、Modal 底色等 className 覆盖不了的位）
// 时走 src/theme/index.js 的 useColors()。
// ============================================================================

// CSS 变量名 → 语义；light/dark 两套取值
export const TOKEN_NAMES = [
  'background',    // 页面底
  'surface',       // 卡片/面板
  'surface-2',     // 悬浮/抬升面/chip 组底
  'line',          // 分隔线
  'foreground',    // 主文字
  'muted',         // 次级文字
  'accent',        // 品牌红（深浅同值）
  'accent-strong', // 品牌红按下档
  'link',          // 交互蓝
];

export const COLORS = {
  light: {
    '--background': '#ffffff',
    '--surface': '#f9f9f9',
    '--surface-2': '#f2f2f2',
    '--line': '#e5e5e5',
    '--foreground': '#0f0f0f',
    '--muted': '#606060',
    '--accent': '#ff0000',
    '--accent-strong': '#cc0000',
    '--link': '#065fd4',
  },
  dark: {
    '--background': '#0f0f0f',
    '--surface': '#212121',
    '--surface-2': '#272727',
    '--line': '#303030',
    '--foreground': '#f1f1f1',
    '--muted': '#aaaaaa',
    '--accent': '#ff0000',
    '--accent-strong': '#ff3333',
    '--link': '#3ea6ff',
  },
};

// 角标（时长/N 张）全站唯一规格：黑底 60% 半透明（YouTube badge-shape 实测值），
// 与主题无关、深浅通用，因此放常量而非主题档
export const BADGE_BG = 'rgba(0,0,0,0.6)';

// 抽屉遮罩：半透明黑（YouTube 覆盖式抽屉同款）
export const SCRIM_BG = 'rgba(0,0,0,0.5)';
