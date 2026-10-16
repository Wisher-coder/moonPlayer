// ============================================================================
// telegram-actions/abilities.js —— 消息/对话动作可用性纯函数（M4·页面-菜单动作）
// ----------------------------------------------------------------------------
// 契约来源：页面蓝图 .fixtmp/tgios-pages-blueprint.md §5.1-B（判定公式钉死）、
// §3.3（消息主菜单项目录）/§3.4（内容类型专属菜单）/§4（增量端点可用性）。
// 零 RN import：node 可直载（门 11 的 abilities 判定矩阵按本文件口径）。
//
// 输入契约：
//   msg  = 服务端 chat.js normalizeOne 归一化消息 + 页面本地增量字段：
//          { id, peerKey, kind:'message'|'service', out, text, media, forward,
//            service, __status?:'pending'|'failed'（乐观存根,负 id）, ... }
//   ctx  = { peer:{kind,canSend}, selectionActive?, pinnedMessageId?, me? }
//          · peer.kind ∈ 'user'|'group'|'channel'|'saved'|'other'
//            （服务端 tg.js kindOf:569-573 口径——超群 megagroup 亦归 'group'，
//              Channel.broadcast 才是 'channel'）；
//          · pinnedMessageId 为可选增量（GET /chat-header 的 pinnedMessageId，
//            §5.3-E 置顶条同源），用于区分「置顶/取消置顶」两项；未提供时不猜。
// 输出键集与蓝图 §5.1-B 一致，只增不删（复核口径）。
//
// 判定总原则（蓝图 §5.1-B 保守推导 + 上游兜底）：
//   · 本地只做保守可用性推导；服务端权限错误（RIGHT_FORBIDDEN 等）由调用链
//     如实中文上抛（endpoints.js / 装配层 toast），绝不本地冒充成功。
//   · 乐观存根（负 id，chat/[id].js 发送口径）不进任何服务端动作。
// ============================================================================

// 全不可用兜底形状（键集稳定，消费方解构安全）
function noneAbilities() {
  return {
    reply: false, forward: false, copy: false, select: false,
    del: false, revoke: false, edit: false,
    pin: false, unpin: false,
    retry: false, cancelSend: false,
  };
}

// 消息动作可用性（蓝图 §5.1-B messageAbilities 逐条口径）
//   reply      回复        = canSend && id>0 && 非 service（§3.3 canReply）
//   forward    转发入口    = id>0 && 非 service（🔻 直接进 ForwardPanel 两步）
//   copy       复制文本    = 非 service && 有正文（caption 也在 text 字段）
//   select     多选        = id>0 && 非 service && 非多选态（§3.2-2：多选态下
//                            长按=切换选中，菜单不再重复提供入口）
//   del        删除        = id>0 && 非 service（真实消息才进 POST /delete；
//                            失败/在途存根由 retry/cancelSend 承载）
//   revoke     为所有人删  = del 且（out===true || peer.kind ∈ {group, saved}）
//                            （§5.1-B 保守公式：私聊/频道他人的消息只能为我删；
//                            它是删除的子语义，恒随 del 门控，不独立成立）
//   edit       编辑        = out && 有 text && !forward && id>0（§5.1-B 公式），
//                            v1 仅纯文本：排除媒体 caption（§3.3 裁剪——MTProto
//                            EditMessage 会改写 caption、TD editMessageText 对
//                            媒体直接报错，双引擎语义不一致不做）；webpage 链接
//                            预览仍属文本消息（两引擎 editMessageText 语义一致），
//                            可编辑
//   pin        置顶        = peer.kind!=='saved' && id>0 && 非 service（§5.1-B）
//   unpin      取消置顶    = pin 且装配层提供了 pinnedMessageId 且命中本条
//                            （无数据不猜：未知置顶态时只出「置顶」项）
//   retry      重新发送    = 负 id 乐观存根 __status==='failed'（既有 retrySend；
//                            §3.3 Retry「failed 存根专属」）
//   cancelSend 取消发送    = 负 id 乐观存根 __status==='pending'（§5.1-B 公式；
//                            MTProto 无在途撤回原语，仅移除本地存根，§3.3 🔻）
export function messageAbilities(msg, ctx) {
  if (!msg || typeof msg !== 'object') return noneAbilities();
  const peer = (ctx && ctx.peer) || null;
  const kind = (peer && peer.kind) || 'other';
  // canSend 缺省保守：peer 头未就绪时视为不可发（菜单打开必晚于首屏响应，
  // 此分支纯防御——不可误把频道当可回复合）
  const canSend = !peer ? false : peer.canSend !== false;

  const id = Math.floor(Number(msg.id));
  const real = Number.isFinite(id) && id > 0;   // 乐观存根为负 id
  const isService = msg.kind === 'service' || !!msg.service;
  const status = String(msg.__status || '');
  const pending = !real && status === 'pending';
  const failed = !real && status === 'failed';
  const hasText = !!(msg.text && String(msg.text).length);
  const out = msg.out === true;

  // 置顶态增量输入（可选）：GET /chat-header 的 pinnedMessageId（§5.3-E）
  const pinnedId = Math.floor(Number(ctx && ctx.pinnedMessageId)) || 0;

  // 编辑的内容面门槛：无媒体，或仅网页预览（webpage 是文本消息的一部分）
  const textOnly = !msg.media || (msg.media && msg.media.kind === 'webpage');

  return {
    reply: real && !isService && canSend,
    forward: real && !isService,
    copy: !isService && hasText,
    select: real && !isService && !(ctx && ctx.selectionActive),
    del: real && !isService,
    revoke: real && !isService && (out || kind === 'group' || kind === 'saved'),
    edit: out && real && !isService && hasText && !msg.forward && textOnly,
    pin: real && !isService && kind !== 'saved',
    unpin: real && !isService && kind !== 'saved' && pinnedId > 0 && pinnedId === id,
    retry: failed,
    cancelSend: pending,
  };
}

// 对话（列表行）动作可用性——域 3 EnabledContextActions（蓝图 §5.1-B）：
//   置顶/静音/标记未读/归档对所有对话开放（服务端 POST /dialog/update 单字段；
//   权限类上游错误如实上抛）；「删除对话」= 从列表隐藏并清空历史（§4.2-⑩，
//   不退出群组/频道的语义降级，确认弹层文案由装配层如实描述），
//   「我的收藏」（saved 伪对话）不可移除。
// 注：目录条目无 archived 字段（服务端 dialog 契约未携带），归档项恒出、
//   当前归档态由装配层自行决定文案；置顶/静音/未读的当前态读 item 的
//   pinned/muted/unreadCount 供标签翻转（能力布尔不受影响）。
export function dialogAbilities(item /* , ctx */) {
  const key = String((item && item.peerKey) || '');
  return {
    pin: true,
    mute: true,
    markUnread: true,
    archive: true,
    remove: !!key && key !== 'saved',
  };
}
