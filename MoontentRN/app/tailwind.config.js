// tailwind 配置：NativeWind v4 官方指南要求——
// - presets 引入 nativewind/preset（把 tailwind 类编译为 RN 原生样式）；
// - content 覆盖 src/ 下全部组件代码；
// - 语义色全部映射到 CSS 变量（--background 等），变量值由两层注入：
//   ① global.css 的 :root / .dark（web 侧兜底 + 首屏底色）；
//   ② ThemeProvider 根部 vars()（src/lib/theme-context.jsx，native/web 运行时
//      随主题三态切换实时换值）。
//   两处取值必须与 src/theme/tokens.js 保持一致（同名同值），改动需三处同步。
// 组件侧统一用 bg-background / text-foreground / text-muted / bg-surface-2 /
// border-line / text-link / bg-accent 等语义类，主题切换对组件零侵入。
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx}'],
  // darkMode 必须显式 'class'：nativewind 据此在 web 注入
  // --css-interop-darkMode: class dark，colorScheme.set() 才被允许（默认
  // 'media' 时 ThemeProvider 一调 colorScheme.set 即抛错、整树打崩白屏）；
  // 'dark' 类由 react-native-css-interop 自动挂到 <html>，与 global.css 的
  // .dark 变量组配套。
  darkMode: 'class',
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        line: 'var(--line)',
        foreground: 'var(--foreground)',
        muted: 'var(--muted)',
        accent: 'var(--accent)',
        'accent-strong': 'var(--accent-strong)',
        link: 'var(--link)',
      },
    },
  },
  plugins: [],
};
