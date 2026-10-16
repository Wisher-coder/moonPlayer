// ============================================================================
// use-keyboard-shortcuts.js —— Telegram 快捷键·原生端空实现（平台拆分基线）
// ----------------------------------------------------------------------------
// 契约（蓝图二 §5.6，与 use-keyboard-shortcuts.web.js 同签名同导出面）：
//   useTelegramShortcuts(handlers) → 注销函数
//     handlers: { onEscape, onFocusSearch, onSend? }
//     · onEscape()      按浮层栈关闭最上层（页面聚合各 Modal 的 visible——
//                       菜单→转发→日历→搜索→多选退出→清回复；返回 truthy
//                       表示「关掉了东西」,web 版据此 preventDefault）
//     · onFocusSearch() 聚焦会话内搜索
//     · onSend()        发送输入框内容
//     返回值：注销函数（幂等；原生端为空操作）。
// 原生端（iOS/Android）无物理键盘面,本文件是**空实现**：注册即返回空注销
// 函数,零 import、零订阅——桌面/web 键位在 .web.js 平台变体里实现（Metro
// 按平台后缀在模块加载期解析,共享代码不引入运行时平台检查,desktop 规则）。
// 两端签名一致,装配层（M1,chat/[id].js）无需平台分支。
// 键位表子集对照 Telegram-iOS ChatControllerKeyShortcuts（裁剪明细与 TI 出处
// 见 .web.js 文件头——原生端无键位,不再复述）。
// ============================================================================

// 空注销函数（模块级恒稳引用,调用方 useCallback 依赖恒稳）
function noopUnbind() {}

export function useTelegramShortcuts(_handlers) {
  return noopUnbind;
}

export default useTelegramShortcuts;
