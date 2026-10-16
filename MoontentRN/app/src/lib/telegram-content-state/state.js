// ============================================================================
// telegram-content-state/state.js —— 聊天内容状态机·状态形状与字段归一
// ----------------------------------------------------------------------------
// Telegram-iOS ChatInterfaceState 持久化字段子集的 JS 等价（蓝图二 §5.2，
// ChatControllerContentData 语义：输入 / 选择 / 草稿 / 滚动位置 / 转发 / 编辑态）：
//   · composeInputState → draft；replyMessageSubject → reply；editMessage → editing；
//     selectionState → selection；forwardMessageIds+forwardOptionsState → forward；
//     historyScrollState → scroll（像素级 relativeOffset 裁剪，只存行级锚点——
//     RN 行级量测体系下 v1 不可靠，恢复走 loadInitial(anchorMsgId) 既有锚定链）；
//   · mediaRecordingMode / mediaDraftState / silentPosting / inputLanguage /
//     sendMessageEffect / postSuggestionState 无对应数据面，裁剪（蓝图二 §5.2）；
//   · 搜索态不进本状态机——TI 同样不持久化搜索态（蓝图二 §0.1-4 决策），搜索
//     面板是页内瞬态（关闭即失，无深链需求，蓝图二 §7-R6）。
// 持久化不做服务端草稿同步（draft 端点已在蓝图二 §4.3 裁掉）：本地 AsyncStorage，
// 见同目录 store.js；reducer 动作见 reducer.js；序列化/兜底见 serialize.js。
// 零 RN import 的纯逻辑层（app/scripts/test-content-state.mjs 零依赖 runner 直测）。
// 归一化约定（全部防御式，脏数据归零不抛——序列化状态机的输入是磁盘，不可信）：
//   · 消息 id 一律正整数（乐观存根的负 id 不得进 selection/forward/scroll）；
//   · id 列表升序去重（选择态与 TI 一致按会话顺序呈现，升序即会话时间序）；
//   · 空列表/null → null（「无此状态」与「空列表」不区分，省一个语义分支）。
// ============================================================================

// 状态包版本：字段形状/语义变更时递增；parseState 对非当前版本的包按「只救
// draft」降级兜底（对应 TI parse 失败回退 synchronizeableInputState 的语义）
export const CSTATE_VERSION = 1;

// 空状态工厂（每次返回全新对象，防调用方共享可变引用）
export function emptyContentState() {
  return {
    v: CSTATE_VERSION,
    draft: null,      // { text, updatedAt } | null   输入框草稿（updatedAt 仅为展示性元数据）
    reply: null,      // { msgId, name, snippet } | null   回复目标（长按菜单「回复」设置）
    editing: null,    // { msgId } | null   编辑中的自有文本消息（菜单「编辑」设置）
    selection: null,  // number[] | null   多选中的真实消息 id（升序去重）
    forward: null,    // { ids, hideNames, hideCaptions } | null   转发会话（ids 升序去重）
    scroll: null,     // { anchorMsgId } | null   离开页面时的滚动锚点（行级恢复）
  };
}

// 冻结单例：仅作「形状文档」与 reducer/parse 的兜底蓝本（经展开使用，不直接外发）
const EMPTY = Object.freeze(emptyContentState());
export { EMPTY as EMPTY_CONTENT_STATE };

// —— 正整数 id 列表归一：过滤非法/负数/重复，升序；空集回 null ——
function idListAsc(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const x of raw) {
    const n = Math.floor(Number(x));
    if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  if (!out.length) return null;
  out.sort((a, b) => a - b);
  return out;
}

// —— 草稿：{ text, updatedAt }；空文本视同无草稿 ——
export function normalizeDraft(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (!text.length) return null;
  const updatedAt = Math.floor(Number(raw.updatedAt)) || 0;
  return { text, updatedAt };
}

// —— 回复目标：msgId 必须为正（回复乐观存根无意义，服务端不接受负 id） ——
export function normalizeReply(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const msgId = Math.floor(Number(raw.msgId));
  if (!Number.isFinite(msgId) || msgId <= 0) return null;
  return {
    msgId,
    name: typeof raw.name === 'string' ? raw.name : '',
    snippet: typeof raw.snippet === 'string' ? raw.snippet : '',
  };
}

// —— 编辑态：同上只认真实消息 id ——
export function normalizeEditing(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const msgId = Math.floor(Number(raw.msgId));
  if (!Number.isFinite(msgId) || msgId <= 0) return null;
  return { msgId };
}

// —— 多选：正 id 升序去重 ——
export function normalizeSelection(raw) {
  return idListAsc(raw);
}

// —— 转发会话：ids 非空 + 两个选项布尔（选项缺省 false，与 ForwardPanel 初值同口径） ——
export function normalizeForward(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ids = idListAsc(raw.ids);
  if (!ids) return null;
  return {
    ids,
    hideNames: !!raw.hideNames,
    hideCaptions: !!raw.hideCaptions,
  };
}

// —— 滚动锚点：行级恢复（像素级 relativeOffset 裁剪声明见文件头） ——
export function normalizeScroll(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const anchorMsgId = Math.floor(Number(raw.anchorMsgId));
  if (!Number.isFinite(anchorMsgId) || anchorMsgId <= 0) return null;
  return { anchorMsgId };
}

// —— 整包归一：逐字段独立容错（单字段脏不影响其余字段），供 reducer 的
//     hydrate 动作、serializeState 与 store.saveState 统一走此入口 ——
export function sanitizeContentState(raw) {
  const base = emptyContentState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  return {
    v: CSTATE_VERSION,
    draft: normalizeDraft(raw.draft),
    reply: normalizeReply(raw.reply),
    editing: normalizeEditing(raw.editing),
    selection: normalizeSelection(raw.selection),
    forward: normalizeForward(raw.forward),
    scroll: normalizeScroll(raw.scroll),
  };
}

// —— 版本守卫：v 为当前版本（或缺失——装配层内联构造的旧对象）才放行整包，
//     否则回 null 由调用方决定降级（parseState 据此走「只救 draft」兜底） ——
export function isCurrentVersion(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return raw.v === undefined || raw.v === null || Number(raw.v) === CSTATE_VERSION;
}
