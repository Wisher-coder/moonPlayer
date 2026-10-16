// ============================================================================
// 主题色板（ui 内部共享件，不属于跨模块契约的八原语）
// ----------------------------------------------------------------------------
// 本模块（ui/video/album 卡片族）的 YouTube 亮/暗双主题取色统一入口。
// 色值单一事实源是 src/theme/tokens.js（取值对齐 NextWeb globals.css），经
// src/theme/index.js 的 useColors()（命令式取色钩子，resolved 主题的驼峰键）
// 消费；这里再包一层 usePalette()：
//   - 键名从驼峰语义直用（surface/surface2/line/foreground/muted/accent/
//     accentStrong/link），与本模块各组件注释里的语义 token 一一对应；
//   - ThemeProvider 尚未挂载（集成期/单组件预览）时 useColors 会因
//     useTheme() 的 Provider 断言抛错——这里降级为浅色板渲染，不阻断组件树。
// 布局/间距/圆角等非颜色类继续走 NativeWind className（Tailwind 标准类）；
// 主题色走 style 内联（var(--xxx) 语义色在 Modal 等脱离根 View 树的位置不可
// 靠，命令式取色三端通吃）。
import { Platform } from 'react-native';
import { COLORS, useColors, BADGE_BG as THEME_BADGE_BG, SCRIM_BG as THEME_SCRIM_BG } from '../../theme/index.js';

// 角标（时长/N 部/N 张）与遮罩用的常量黑：与主题无关，深浅同值（tokens 单源）
export const BADGE_BG = THEME_BADGE_BG;
export const SCRIM_BG = THEME_SCRIM_BG;

// 静态双主题色板（非组件场景按需直取；键为 '--background' 形态的令牌名）
export const PALETTES = COLORS;

// 是否 web 端：hover 态只对 web 生效（native 无鼠标悬停概念），组件内统一经
// 此常量或 Pressable 的 hovered 回调参数判定（hovered 在 native 恒为 false）
export const isWeb = Platform.OS === 'web';

// 取当前生效色板（驼峰键）：resolved 异常/未挂载一律回退浅色（YouTube 缺省观感）
export function usePalette() {
  try {
    return useColors() || fromColors('light');
  } catch (_e) {
    return fromColors('light'); // 主题上下文不可用：按浅色板渲染
  }
}

// '--background' 令牌形态 → 驼峰键色板（兜底路径用；键集与 useColors 一致）
function fromColors(which) {
  const src = COLORS[which] || COLORS.light;
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
  };
}
