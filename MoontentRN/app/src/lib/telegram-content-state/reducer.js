// ============================================================================
// telegram-content-state/reducer.js —— 聊天内容状态机·纯函数 reducer
// ----------------------------------------------------------------------------
// reduceState(state, action)：输入/回复/编辑/多选/转发/滚动六域的动作表
// （蓝图二 §5.2 钉死的动作清单；hydrate 为装配便利的加性动作）：
//   setDraft{ text, at? }        草稿（空文本=清除；at 缺省兜底 Date.now()，
//                                仅为展示性元数据——runner 断言纯函数性时显式传 at）
//   clearDraft                   清草稿
//   setReply{ msgId, name?, snippet? } / clearReply     回复目标（msgId 须正 id）
//   beginEdit{ msgId } / cancelEdit                     编辑自有文本消息
//   toggleSelect{ msgId }        多选增删（null→[id]；删空→null）
//   selectAll{ ids }             全选已载窗口（正 id 升序去重；空窗→null——
//                                TI 的 Select All 是当前 history view 全量，
//                                本域收窄为已载窗口，蓝图二 §3.3 注明）
//   clearSelection               退出多选
//   setForward{ ids, hideNames?, hideCaptions? }        开转发会话（选项缺省 false）
//   updateForwardOptions{ hideNames?, hideCaptions? }   只补已出现的键（undefined=保持）
//   clearForward                 清转发会话
//   setScrollAnchor{ anchorMsgId }  行级滚动锚点（0/null=清除）
//   hydrate{ state }             整包并入（loadState 结果进 useReducer 流的装配入口，
//                                加性动作；逐字段容错归一，见 state.sanitizeContentState）
// 契约：纯函数——不读外部可变态、不改入参（runner 用深度冻结对象验证不可变
// 更新）；非法载荷一律防御式忽略（返回原引用），绝不抛错——序列化状态机的
// 动作来自 UI 与磁盘两个不可信面，抛错会打断装配层的 useReducer。
// 回复与编辑互不联动（正交字段，装配层决定输入区头部条的呈现优先级）。
// ============================================================================
import { emptyContentState, sanitizeContentState, isCurrentVersion } from './state.js';

// 时间戳：动作未显式携带 at 时的兜底（纯函数性由 runner 显式传 at 保证）
function stampAt(at) {
  const n = Math.floor(Number(at));
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

export function reduceState(state, action) {
  // 基座：入参非对象时从空状态起步（仍走纯路径，不引用可变单例）
  const cur = state && typeof state === 'object' && !Array.isArray(state)
    ? state
    : emptyContentState();
  if (!action || typeof action !== 'object') return cur;

  switch (action.type) {
    case 'setDraft': {
      const text = typeof action.text === 'string' ? action.text : String(action.text == null ? '' : action.text);
      if (!text.length) return { ...cur, draft: null };
      return { ...cur, draft: { text, updatedAt: stampAt(action.at) } };
    }
    case 'clearDraft':
      return cur.draft == null ? cur : { ...cur, draft: null };
    case 'setReply': {
      const msgId = Math.floor(Number(action.msgId));
      if (!Number.isFinite(msgId) || msgId <= 0) return cur; // 非法载荷：原样返回（纯函数防御）
      return {
        ...cur,
        reply: {
          msgId,
          name: typeof action.name === 'string' ? action.name : '',
          snippet: typeof action.snippet === 'string' ? action.snippet : '',
        },
      };
    }
    case 'clearReply':
      return cur.reply == null ? cur : { ...cur, reply: null };
    case 'beginEdit': {
      const msgId = Math.floor(Number(action.msgId));
      if (!Number.isFinite(msgId) || msgId <= 0) return cur;
      return { ...cur, editing: { msgId } };
    }
    case 'cancelEdit':
      return cur.editing == null ? cur : { ...cur, editing: null };
    case 'toggleSelect': {
      const n = Math.floor(Number(action.msgId));
      if (!Number.isFinite(n) || n <= 0) return cur; // 乐观存根（负 id）不进多选
      const prev = Array.isArray(cur.selection) ? cur.selection : [];
      const next = prev.includes(n)
        ? prev.filter((x) => x !== n)
        : prev.concat(n).sort((a, b) => a - b);
      return { ...cur, selection: next.length ? next : null };
    }
    case 'selectAll': {
      const ids = Array.isArray(action.ids) ? action.ids : [];
      const seen = new Set();
      const next = [];
      for (const x of ids) {
        const n = Math.floor(Number(x));
        if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
        seen.add(n);
        next.push(n);
      }
      if (!next.length) return { ...cur, selection: null };
      next.sort((a, b) => a - b);
      return { ...cur, selection: next };
    }
    case 'clearSelection':
      return cur.selection == null ? cur : { ...cur, selection: null };
    case 'setForward': {
      const seen = new Set();
      const ids = [];
      for (const x of Array.isArray(action.ids) ? action.ids : []) {
        const n = Math.floor(Number(x));
        if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
        seen.add(n);
        ids.push(n);
      }
      if (!ids.length) return { ...cur, forward: null }; // 空选择=无转发会话
      ids.sort((a, b) => a - b);
      return {
        ...cur,
        forward: { ids, hideNames: !!action.hideNames, hideCaptions: !!action.hideCaptions },
      };
    }
    case 'updateForwardOptions': {
      if (!cur.forward) return cur; // 选项依附于转发会话，无会话不凭空造
      return {
        ...cur,
        forward: {
          ...cur.forward,
          hideNames: action.hideNames === undefined ? cur.forward.hideNames : !!action.hideNames,
          hideCaptions: action.hideCaptions === undefined ? cur.forward.hideCaptions : !!action.hideCaptions,
        },
      };
    }
    case 'clearForward':
      return cur.forward == null ? cur : { ...cur, forward: null };
    case 'setScrollAnchor': {
      const n = Math.floor(Number(action.anchorMsgId));
      if (!Number.isFinite(n) || n <= 0) return { ...cur, scroll: null };
      return { ...cur, scroll: { anchorMsgId: n } };
    }
    case 'hydrate': {
      // 版本守卫:hydrate 的契约入参是 loadState 产物(已过 parseState 的版本
      // 降级),但动作面同样来自「磁盘」这一不可信面——若装配层绕过 loadState
      // 直喂原始包,v≠1 的异版本包会被 sanitize 洗成 v:1 整包接受。这里与
      // parseState(:54-58)同口径:非当前版本只救 draft(2026-10-12 复核补)
      const st = action && typeof action === 'object' ? action.state : null;
      if (st && typeof st === 'object' && !isCurrentVersion(st)) {
        return sanitizeContentState({ draft: st.draft || null });
      }
      return sanitizeContentState(st);
    }
    default:
      return cur; // 未知动作：原样返回（同引用），调用方 useReducer 语义安全
  }
}

export default reduceState;
