// ============================================================================
// chat-helpers.js —— 兼容垫片（实现已迁至 chat-helpers/index.js）
// ----------------------------------------------------------------------------
// chat-helpers 升级为目录模块后，仍以 `./chat-helpers.js` 相对路径引用的
// 既有消费方（InlineKeyboard.jsx、lib/tg-rows.js 等非本域文件）零改动兼容：
// 这里整表转发目录版导出，请勿在本文件添加新实现——新工具一律落
// chat-helpers/index.js（气泡域共享工具唯一实现点）。
// ============================================================================
export {
  BUBBLE,
  bubbleScheme,
  toneColors,
  senderColor,
  avatarColor,
  initialsOf,
  AVATAR_PALETTE,
  toDate,
  fmtChatTime,
  fmtChatDate,
  fmtBytes,
  fitPhotoBox,
  ALBUM_CELL,
  BUBBLE_MEDIA_MAX_W,
  UNSUPPORTED_PILL,
  measureUnsupportedPill,
} from './chat-helpers/index.js';
