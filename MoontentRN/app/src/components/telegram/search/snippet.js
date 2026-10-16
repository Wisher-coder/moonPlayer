// ============================================================================
// snippet.js —— 搜索结果行摘要纯工具(零 RN 依赖,双端安全)
// ----------------------------------------------------------------------------
// 搜索域(ChatSearchHeader 全局段/GlobalSearchSection)与对话行(DialogRow)
// 共用的文案推导:归一化契约消息/对话 lastMessage → 单行摘要。
// 归一化消息契约见服务端 chat.js normalizeOne({id,peerKey,kind,date,out,from,
// text,entities,media,service,...});MEDIA_FALLBACK 的 kind 短标与服务端
// previewOf 的媒体标签口径一致(photo/video/voice/audio/document/sticker/
// poll/geo/contact/webpage/service)。
// ============================================================================

// 摘要为空但 mediaKind 有值时的中文媒体占位(与 telegram 列表页 preview 同款
// 口径;service 无占位——服务消息 preview 必有中文映射;unsupported 无占位)
export const MEDIA_FALLBACK = {
  photo: '[图片]',
  video: '[视频]',
  voice: '[语音]',
  audio: '[音乐]',
  document: '[文件]',
  sticker: '[贴纸]',
  poll: '[投票]',
  geo: '[位置]',
  contact: '[联系人]',
  webpage: '[链接]',
};

// 单行摘要上限(结果行 numberOfLines=1,超长由截断兜底,避免超长文本参与布局)
const SNIPPET_MAX = 160;

// 归一化契约消息 → 单行摘要:正文文本优先,服务消息出中文映射,媒体消息出
// 中文占位;最终为空回空串(调用方自行兜底文案)
export function msgSnippet(msg) {
  if (!msg || typeof msg !== 'object') return '';
  let text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (!text && msg.service && typeof msg.service.text === 'string') {
    text = msg.service.text.trim();
  }
  if (!text && msg.media && msg.media.kind) {
    text = MEDIA_FALLBACK[msg.media.kind] || '';
  }
  if (text.length > SNIPPET_MAX) text = text.slice(0, SNIPPET_MAX);
  return text;
}
