// ============================================================================
// context-menu/index.js —— 长按菜单目录桶导出（M4·页面-菜单动作）
// ----------------------------------------------------------------------------
// 通用菜单容器 + 菜单项目录装配纯函数的统一出口。注意：components/telegram
// 的家族桶（../index.js）归页面-气泡内容模块所有（蓝图二 §1.2，只增不删），
// 本目录独立成桶，装配层按需二选一引入。
// ============================================================================
export { default as ContextMenu } from './ContextMenu.jsx';
export {
  buildMessageMenu,
  buildMessageMenuFor,
  buildLinkMenu,
  buildPhoneMenu,
  buildMentionMenu,
  buildDateMenu,
  buildCommandMenu,
  buildDialogMenu,
} from '../../../lib/telegram-actions/message-menu.js';
