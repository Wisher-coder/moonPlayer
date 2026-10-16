// ============================================================================
// telegram-content-state/serialize.js —— 内容状态机·序列化与解析兜底
// ----------------------------------------------------------------------------
// serializeState(state) → string   v1 前缀 JSON（{"v":1,...}）——入参先整包
//   归一（sanitizeContentState）再落串，脏输入序列化出干净串；
// parseState(s) → ChatContentState  解析 + 三层兜底（对应 TI parse 失败回退
//   synchronizeableInputState（草稿态）而非全丢的语义，蓝图二 §5.2）：
//     ① 主包可解析且 v=当前版本 → 整包逐字段归一（单字段脏不影响其余）；
//     ② 主包可解析但版本不符 → 只救 draft.text（版本间唯一跨版本稳定语义是
//        草稿文本——TI 的 inputState 同款精神），其余字段归零；
//     ③ 主包损坏（JSON.parse 抛错/非对象）→ 对原文串做 draft.text 单字段
//        抢救（正则定位 + JSON 转义还原，尽力而为），救不出回空状态。
// 永不抛错：磁盘上的字符串不可信，解析层抛错会打断聊天页打开路径。
// 零 RN import 的纯逻辑层（runner 直测，门 11-②③）。
// ============================================================================
import {
  CSTATE_VERSION,
  emptyContentState,
  isCurrentVersion,
  normalizeDraft,
  sanitizeContentState,
} from './state.js';

// 主包损坏时尽力提取 draft.text 单字段：定位 "draft":{...} 内的首个 "text"
// 字符串字面量（不含嵌套花括号），再经 JSON 转义还原引号/换行/中文
function salvageDraftText(rawStr) {
  const m = /"draft"\s*:\s*\{[^{}]*?"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(rawStr);
  if (!m) return null;
  try {
    const text = JSON.parse('"' + m[1] + '"');
    return typeof text === 'string' && text.length ? text : null;
  } catch (_e) {
    return null; // 转义序列损坏：放弃抢救
  }
}

// 序列化：脏输入先归一（非对象入参按空状态落串），输出恒为可解析的 v1 JSON
export function serializeState(state) {
  const st = state && typeof state === 'object' && !Array.isArray(state)
    ? sanitizeContentState(state)
    : emptyContentState();
  return JSON.stringify(st);
}

// 解析：三层兜底见文件头；任何路径都返回完整形状（字段缺失=null）
export function parseState(s) {
  if (typeof s !== 'string' || !s.length) return emptyContentState();
  let obj = null;
  try {
    obj = JSON.parse(s);
  } catch (_e) {
    obj = undefined; // 与「解析成功但非对象」分流
  }
  if (obj !== undefined && obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    if (isCurrentVersion(obj)) return sanitizeContentState(obj);
    // 版本不符：只救 draft，其余归零（未来版本向前读的安全下限）
    const draft = normalizeDraft(obj.draft);
    return draft ? { ...emptyContentState(), draft } : emptyContentState();
  }
  // 主包损坏（或非对象包）：draft.text 单字段抢救
  const text = salvageDraftText(s);
  if (text) {
    return { ...emptyContentState(), draft: { text, updatedAt: 0 } };
  }
  return emptyContentState();
}

// 便捷导出：供 store/装配层判断当前序列化版本（演进排查用）
export { CSTATE_VERSION as CONTENT_STATE_VERSION };
