// ============================================================================
// index.js —— Telegram 消息组件族桶导出（聊天页统一从这里拿件）
// ----------------------------------------------------------------------------
// 纯展示组件族：数据与动作全部 props 注入，不取数、不感知路由。归一化
// 消息对象契约见服务端 chat.js / 任务共享契约；各组件 props 明细见各自
// 文件头注释。
// 桶导出面只增不删（既有消费方 zero-break）；新增件：UnsupportedPill
// （TI UnsupportedContentPill 等价）；chat-helpers 新增头像哈希色/双首字母/
// 气泡底色板/Unsupported 胶囊几何导出。
// ============================================================================
export { default as MessageBubble } from './MessageBubble.jsx';
export { default as MessageText } from './MessageText.jsx';
export { default as TgAvatar, KindBadge, KIND_LABEL } from './PeerBadge.jsx';
// 桶导出只增不删(蓝图二 §5.5-2「telegram.js 与 ForwardPanel 都从桶导入」):
// ForwardPanel 经桶消费 DialogRow,缺导出=面板挂载即 Element type invalid(复核 2026-10-12 补)
export { default as DialogRow } from './DialogRow.jsx';
export { default as MessageMedia } from './MessageMedia.jsx';
export { default as PollCard } from './PollCard.jsx';
export { default as UnsupportedPill } from './UnsupportedPill.jsx';
export { default as InlineKeyboard } from './InlineKeyboard.jsx';
export { default as ChatComposer } from './ChatComposer.jsx';
export { default as ReplyKeyboardBar } from './ReplyKeyboardBar.jsx';
export { DateDivider, UnreadDivider, ServiceMessage } from './ChatDividers.jsx';
export { useHint } from './HintPill.jsx';
export {
  senderColor, toneColors, fmtChatTime, fmtChatDate, fmtBytes, fitPhotoBox,
  ALBUM_CELL, BUBBLE_MEDIA_MAX_W,
  // 新增（蓝图一 §5.2/§5.3 唯一映射点）：气泡底色板/亮暗档推断/头像哈希色
  BUBBLE, bubbleScheme, avatarColor, initialsOf, AVATAR_PALETTE,
  // TI UnsupportedContentPill 几何（常量逐字 + 纯函数量测）
  UNSUPPORTED_PILL, measureUnsupportedPill,
} from './chat-helpers/index.js';
