// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    // React Compiler 系诊断降级为 warn（保留 advisory 可见性,不再阻断）:
    // 本仓的核心编排(播放器舞台/全屏方向锁/悬浮窗拖拽/动效层)刻意采用
    // 「渲染期 latest-ref 镜像(ref.current = x)、effect 内 setState、
    // 手动记忆化 + 可变播放实例」等模式——这些是 React Compiler 明确不支持
    // 的写法,但正是跨页不断流/零闪烁交接等硬约束的实现基础(见
    // lib/player-context.jsx 头注)。模式属架构决策而非缺陷:
    //   · refs                        渲染期写 ref(103 处,latest-ref 惯用法)
    //   · set-state-in-effect         挂载标记/外设同步类 effect(49 处)
    //   · immutability / purity       驱动 expo-video 可变实例/动画值的固有写法
    //   · preserve-manual-memoization 手动 useMemo/useCallback 与编译器不可兼得
    // rules-of-hooks(钩子调用顺序)与 exhaustive-deps 维持原级别不变。
    rules: {
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
    },
  },
]);
