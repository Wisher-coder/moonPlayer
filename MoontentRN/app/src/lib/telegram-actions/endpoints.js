// ============================================================================
// telegram-actions/endpoints.js —— 消息动作增量端点调用器（M4·页面-菜单动作）
// ----------------------------------------------------------------------------
// 数据通道：统一服务 API lib/tg-api.js（postJson，默认 20s 超时）——app 端
// 不接任何 Telegram 客户端库（历史红线沿用；vendored react-native-tdlib 已
// 随服务端引擎替换删除，数据面全部经服务端）。
//
// 服务端契约：routes/telegram-extras.js（页面蓝图 §4.2-④⑤⑦⑧⑨⑩⑪ 逐行对应）：
//   POST /api/telegram/pin            {peer,id,unpin?,silent?}         → {ok:true}
//   POST /api/telegram/edit           {peer,id,text,entities?}         → {message}
//   POST /api/telegram/delete         {peer,ids:[int],revoke?}         → {ok:true,deletedIds}
//   POST /api/telegram/forward        {peer,toPeerIds,messageIds,...}  → {sent:[…]}
//   POST /api/telegram/dialog/update  {peer, pinned?|muted?|unread?|archived?}（单字段/次）→ {ok:true}
//   POST /api/telegram/dialog/delete  {peer}                           → {ok:true}
//   POST /api/telegram/read-mentions  {peer}                           → {ok:true}
// 错误契约：{__err:1,message,needLogin?} 由 tg-api 归一为 Error（message 中文
// 原样透传，needLogin 挂 Error.needLogin）。
//
// 防风暴红线：绝不自动重试；失败如实上抛，由装配层决定呈现（toast/Dialog）。
// 转发主链路：页面蓝图 §5.1-C 的「转发」入口走 ForwardPanel（M5 的
// telegram-forward.js 组 payload）；本文件同时提供 forwardMessages 调用器
// （同一 POST 契约），供面板/装配层复用，避免各处手拼 body。
// ============================================================================

import { postJson } from '../tg-api.js';

// —— 置顶 / 取消置顶（§4.2-⑤）：unpin=true 即取消置顶；silent 透传上游 ——
export function pinMessage({ peer, id, unpin = false, silent = false } = {}, opts) {
  return postJson(
    '/api/telegram/pin',
    { peer, id: Math.floor(Number(id)) || 0, unpin: !!unpin, silent: !!silent },
    opts
  );
}

// —— 编辑自己的纯文本消息（§4.2-⑦）：v1 仅纯文本，entities 恒传空数组
//     （非空由引擎层 400 拒绝；媒体 caption 编辑已裁剪，见 abilities.js 注）——
//     成功返回 { message:<契约消息> }，装配层 replaceMessage 原位替换（同 doVote 模式）。
export function editMessage({ peer, id, text } = {}, opts) {
  return postJson(
    '/api/telegram/edit',
    { peer, id: Math.floor(Number(id)) || 0, text: String(text == null ? '' : text), entities: [] },
    opts
  );
}

// —— 删除消息（§4.2-⑧）：ids 只收真实消息 id（乐观存根负 id 在 abilities 层
//     已挡住；此处再滤一道防脏数据进服务端）；revoke=true 为所有人删除 ——
export function deleteMessages({ peer, ids, revoke = false } = {}, opts) {
  const list = (Array.isArray(ids) ? ids : [])
    .map((n) => Math.floor(Number(n)))
    .filter((n) => Number.isFinite(n) && n > 0);
  return postJson('/api/telegram/delete', { peer, ids: list, revoke: !!revoke }, opts);
}

// —— 转发（§4.2-④）：peer=来源会话；toPeerIds=目标 peerKey 数组；返回
//     { sent:[{peerId,messageIds:[int]}] }（messageIds 尽力提取，提取不到回 []）——
export function forwardMessages({ peer, toPeerIds, messageIds, hideNames = false, hideCaptions = false, silent = false } = {}, opts) {
  return postJson(
    '/api/telegram/forward',
    {
      peer,
      toPeerIds: Array.isArray(toPeerIds) ? toPeerIds : [],
      messageIds: Array.isArray(messageIds) ? messageIds : [],
      hideNames: !!hideNames,
      hideCaptions: !!hideCaptions,
      silent: !!silent,
    },
    opts
  );
}

// —— 对话动作（域 3，§4.2-⑨）：单字段/次，多字段服务端 400——客户端先行
//     校验（本地中文错，不发无效请求）。patch 形如：
//     { pinned:true } | { muted:false } | { unread:true } | { archived:true } ——
const DIALOG_PATCH_KEYS = ['pinned', 'muted', 'unread', 'archived'];
export function updateDialog(params = {}, opts) {
  const peer = params && params.peer;
  if (!peer) throw new Error('对话动作缺少 peer 参数');
  const keys = DIALOG_PATCH_KEYS.filter((k) => params[k] !== undefined);
  if (keys.length !== 1) {
    throw new Error('对话动作一次只能改一个状态（置顶/静音/未读/归档）');
  }
  const key = keys[0];
  return postJson('/api/telegram/dialog/update', { peer, [key]: !!params[key] }, opts);
}

// —— 删除对话（§4.2-⑩）：语义=「从列表隐藏并清空历史」，不退出群组/频道 ——
export function deleteDialog({ peer } = {}, opts) {
  return postJson('/api/telegram/dialog/delete', { peer }, opts);
}

// —— @ 提及全部已读（§4.2-⑪）——
export function readMentions({ peer } = {}, opts) {
  return postJson('/api/telegram/read-mentions', { peer }, opts);
}

// ============================================================================
// 动作错误分类（契约化降级判定；只标注不吞错——错误仍由调用方如实呈现）
// ----------------------------------------------------------------------------
// 引擎能力缺口：双引擎缺能力时服务端回 HTTP 501 + 固定中文文案
// 「该引擎暂不支持<能力>，请切换 TG_ENGINE 或稍后再试」（routes/telegram-extras.js
// caps()，页面蓝图 §4.1 双引擎降级原则）。tg-api 的 Error 不携带 HTTP 状态码，
// 故按该契约文案子串识别为 unsupported——与服务端文案耦合点收敛在本函数单处，
// 服务端文案若变更须同步这里。
//   { message, needLogin, unsupported }
//     needLogin   → 未登录（Error.needLogin 精确透传，非文案启发）
//     unsupported → 当前引擎缺该能力：装配层据此隐藏/禁用对应菜单入口，
//                   绝不轮询重试（防风暴红线）
// ============================================================================
export function classifyActionError(e) {
  const message = (e && e.message) || '操作失败';
  return {
    message,
    needLogin: !!(e && e.needLogin),
    unsupported: typeof message === 'string' && message.indexOf('该引擎暂不支持') !== -1,
  };
}
