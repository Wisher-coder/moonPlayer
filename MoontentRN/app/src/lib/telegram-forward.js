// ============================================================================
// telegram-forward.js —— 转发流纯逻辑（蓝图二 §5.4，ChatControllerForwardMessages 语义等价）
// ----------------------------------------------------------------------------
// 契约（零 RN import 的纯逻辑层，runner 直测——门 11-⑤ forwardAbilities 真值表）：
//   forwardAbilities(ids, msgs) → { hideNames, hideCaptions }
//     转发选项可用性（只统计 ids 命中的消息，ids 缺省=全部 msgs）：
//     · hideNames     存在非本人消息（!out）——TI 转发多源时才出现的「隐藏
//                     发送者名字」；骰子类附件隐藏判定无数据面，按「来源是否
//                     混入他人」收窄（蓝图二 §5.4 注明）；
//     · hideCaptions  存在「带说明文字的媒体」（media && text）——摘除媒体
//                     说明仅对图/视频等带 caption 的消息有意义。
//   buildForwardPayload({ peer, toPeerIds, ids, opts }) → body
//     POST /api/telegram/forward 请求体组装（端点契约见蓝图二 §4.2-4：
//     {peer, toPeerIds, messageIds, hideNames, hideCaptions, silent?}，服务端
//     逐目标 messages.ForwardMessages / TDLib forwardMessages）。防御校验失败
//     抛中文 Error（与发送空文本前置校验同口径，绝不发半截请求；防风暴红线：
//     失败如实上抛，不自动重试）。
//   sentTargetCount(res) → number
//     响应 {sent:[{peerId, messageIds}]} → 实际送达目标数（面板 toast
//     「已转发给 N 个对话」的 N；响应缺失/形状不符回 0，绝不猜）。
// POST 出口归面板（lib/tg-api.js 的 postJson 直连，与聊天页 callback/vote 同
// 口径）——本文件保持零网络零 RN，runner 可直载。
// 入口装配（M1，蓝图二 §5.1-C）：消息菜单「转发」（单条）/ 多选条「转发」
// （多条）→ contentState setForward(ids) → ForwardPanel（目标多选→选项→确认
// POST）→ 成功清 forward 态。scheduleDate/whenOnline/附带文本/requiresPayment
// v1 裁剪（蓝图二 §4.2-4 差异列）。
// ============================================================================

// 对话键形态（与服务端 tg.js isPeerKey / 聊天页 PEER_RE 同口径）
const PEER_RE = /^(c\d+|g\d+|u\d+|saved)$/;

// 键形态预校验（面板装配层禁用确认钮用；buildForwardPayload 内部仍会再校验）
export function isPeerKey(k) {
  return PEER_RE.test(String(k == null ? '' : k));
}

// —— 选项可用性：见文件头；单遍扫描，两个判据齐了就提前收 ——
export function forwardAbilities(ids, msgs) {
  const want = Array.isArray(ids) && ids.length ? ids : null;
  const wantSet = want ? new Set() : null;
  if (wantSet) {
    for (const x of want) {
      const n = Math.floor(Number(x));
      if (Number.isFinite(n) && n > 0) wantSet.add(n);
    }
  }
  let hideNames = false;
  let hideCaptions = false;
  const list = Array.isArray(msgs) ? msgs : [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    if (wantSet && !wantSet.has(Math.floor(Number(m.id)))) continue; // 只统计选中的那部分
    if (!m.out) hideNames = true;
    if (m.media && m.text) hideCaptions = true;
    if (hideNames && hideCaptions) break;
  }
  return { hideNames, hideCaptions };
}

// 目标 peerKey 数组归一：合法键去重保序；空集回 null（由调用方抛错或禁用按钮）
function normTargets(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const x of raw) {
    const k = String(x == null ? '' : x);
    if (!PEER_RE.test(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out.length ? out : null;
}

// 消息 id 数组归一：正整数升序去重；空集回 null
function normMsgIds(raw) {
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

// 请求体组装：防御校验失败抛中文 Error（装配层 catch 转提示，不静默吞）
export function buildForwardPayload({ peer, toPeerIds, ids, opts } = {}) {
  const from = String(peer == null ? '' : peer);
  if (!PEER_RE.test(from)) throw new Error('转发来源会话无效');
  const targets = normTargets(toPeerIds);
  if (!targets) throw new Error('请先选择要转发到的对话');
  const msgIds = normMsgIds(ids);
  if (!msgIds) throw new Error('没有可转发的消息');
  const o = opts && typeof opts === 'object' ? opts : {};
  return {
    peer: from,
    toPeerIds: targets,
    messageIds: msgIds,
    hideNames: !!o.hideNames,
    hideCaptions: !!o.hideCaptions,
    silent: !!o.silent,
  };
}

// 送达目标数：响应 {sent:[{peerId,messageIds}]} → 条数（按 peerId 去重防御）
export function sentTargetCount(res) {
  const sent = res && Array.isArray(res.sent) ? res.sent : [];
  const seen = new Set();
  let n = 0;
  for (const s of sent) {
    if (!s || typeof s !== 'object' || s.peerId == null) continue;
    const k = String(s.peerId);
    if (seen.has(k)) continue;
    seen.add(k);
    n += 1;
  }
  return n;
}
