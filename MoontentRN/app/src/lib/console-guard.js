// ============================================================================
// console-guard.js —— 控制台噪声精确过滤（零告警标准的最后一道闸）
// ----------------------------------------------------------------------------
// 原则:只过滤【框架内部无法从用户侧修复】的已知噪声,且必须精确匹配整句
// 特征;其余一切 warn/error 原样透传,绝不吞掉真实问题。
//
// 当前唯一被过滤的噪声:
//   "Got a component with the name 'x' for the screen '__root'. React
//    Components must start with an uppercase letter..."
//   —— expo-router 静态导出管线给根导航槽(__root)挂的组件是它自己生成的
//   压缩名函数(名字恒为小写,如 'o'),useNavigationBuilder 对小写组件名提
//   示告警。组件在 expo-router 的构建产物里,用户代码无法改名;该提示无任何
//   功能影响(我们自己的全部路由组件均为 PascalCase 文件默认导出)。
//   仅当 screen 名恰为 '__root' 时才拦,普通路由若真出现小写组件名仍会如实
//   报出。
//
// 原生端教训(2026-10,安卓 release 包启动即崩):本文件曾在调查期挂过
// window 事件钩子/捕获数组等 Web 侧调试设施,即便有能力检测也在 Hermes
// release 组合下于模块加载期抛 TypeError,连带 _layout 的默认导出一起失效
// (expo-router 随之报 missing default export / ErrorBoundary of undefined)。
// 现约束:本模块只覆盖 console.warn 一个函数,不触碰 window/全局对象上的
// 任何其它 API,并整体 try/catch 兜底——噪声过滤器绝不允许成为崩溃点。
// ============================================================================
try {
  const RAW_WARN = console.warn.bind(console);

  // expo-router 根槽位小写组件名提示(见文件头说明)
  const ROOT_SLOT_RE =
    /^Got a component with the name '[^']*' for the screen '__root'\. React Components must start with an uppercase letter/;

  console.warn = function guardedWarn(...args) {
    if (args.length === 1 && typeof args[0] === 'string' && ROOT_SLOT_RE.test(args[0])) {
      return; // 框架内部噪声:精确命中即静默
    }
    return RAW_WARN(...args);
  };
} catch (_e) {
  // 兜底:过滤器自身异常时保持 console 原样,绝不影响业务
}
