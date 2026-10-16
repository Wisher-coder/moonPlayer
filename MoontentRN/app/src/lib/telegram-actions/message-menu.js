// ============================================================================
// telegram-actions/message-menu.js —— 菜单项目录装配纯函数（M4·页面-菜单动作）
// ----------------------------------------------------------------------------
// 职责：把 abilities.js 的可用性判定 + 装配层注入的动作回调，编成
// ContextMenu（components/telegram/context-menu/ContextMenu.jsx）的 items。
// 零 RN import：node 可直载；产出项形状即蓝图二 §5.1-A 契约：
//   { key, label, icon?, destructive?, disabled?, onPress } | 'sep'
//   · icon 为图标名串，由 ContextMenu 的 MENU_ICONS 注册表解析成 icons.js
//     生成件（本文件零 RN，不能直接 import 图标组件——两处键名须同步，
//     ContextMenu 头注有清单）；未知名/缺省=无图标（占位槽保留）。
//   · 动作回调缺失时对应项不渲染（装配层没接线的动作不出空项）。
//
// 选项目录（蓝图二 §3.3 消息主菜单 / §3.4 内容类型专属菜单，逐条裁定）：
//   ✅ Reply/Copy/Select/Delete/Pin(Unpin)/Retry + 链接/电话/日期/命令菜单
//   （#话题菜单已退役：点按直达搜索态，见下方 openHashtagContextMenu 注）
//   🔻 Forward（直接进 ForwardPanel 两步；TI 三源 Quote Select/link 源裁剪）、
//      Edit（仅自己的纯文本）、Cancel Sending（仅本地存根）、Mention（打开
//      资料页降级为打开对话——无资料页）
//   ❌ v1 裁剪（无端点/无数据面，出现即契约外）：
//      Copy Link（peer 无 username）、Report/Block、Translate/Speak、Save
//      图片/GIF/视频（expo-media-library 权限面）、View Thread/Poll Stats、
//      FactCheck/Todo/BankCard/Ton/Timecode/自定义 emoji、菜单顶部反应条
//      （reactions 消息面/写侧/事件三处缺口，蓝图一 §7-R9）。
//      ⚠️ 媒体专属菜单亦不在 v1：Save 系裁剪后无剩余项（查看由看图器/观看页
//      承接），故不提供 buildMediaMenu——如实注明，非遗漏。
// ============================================================================

import { messageAbilities } from './abilities.js';

// —— 工具：回调存在判定（装配层未接线的动作不出项） ——
function isFn(f) {
  return typeof f === 'function';
}

// —— 工具：压入一个菜单项（onPress 已绑定入参） ——
function pushItem(items, key, label, icon, extra, onPress) {
  items.push({ key, label, icon, ...(extra || {}), onPress });
}

// ============================================================================
// 消息主菜单（蓝图二 §5.1-C：ContextMenu items=buildMessageMenu(msg, abilities, actions)）
// ----------------------------------------------------------------------------
// actions 键（全部可选，缺失即隐藏对应项）：
//   onReply(msg)                    回复（既有 startReply 语义）
//   onEdit(msg)                     编辑（输入框回填 + 编辑条，确认 POST /edit）
//   onCopy(msg)                     复制文本（Clipboard）
//   onForward(msg)                  转发入口（进 ForwardPanel，M5 承载实际 POST）
//   onPin(msg) / onUnpin(msg)       置顶 / 取消置顶（POST /pin）
//   onSelect(msg)                   进入多选态并选中本条
//   onDelete(msg, { revoke })       删除（装配层出「取消/为我删/为所有人删」
//                                   三选 Dialog；revoke=可否「为所有人删」提示，
//                                   存根不进服务端删除）
//   onRetry(msg)                    失败存根重发（既有 retrySend）
//   onCancelSend(msg)               在途存根取消（hook discardStub，本地移除）
// 顺序对照 TI 消息主菜单布局：回复 → 编辑 → 复制 → 转发 → 置顶 → 多选 → ─ → 删除。
// ============================================================================
export function buildMessageMenu(msg, abilities, actions) {
  const items = [];
  if (!msg || !abilities || typeof abilities !== 'object') return items;
  const acts = actions || {};
  const a = abilities;

  // 乐观存根分支：失败=重发；在途=取消发送（§3.3 两行专属项，无其余动作）
  if (a.retry && isFn(acts.onRetry)) {
    pushItem(items, 'retry', '重新发送', 'retry', null, () => acts.onRetry(msg));
    return items;
  }
  if (a.cancelSend && isFn(acts.onCancelSend)) {
    pushItem(items, 'cancel', '取消发送', 'cancel', { destructive: true }, () => acts.onCancelSend(msg));
    return items;
  }

  if (a.reply && isFn(acts.onReply)) {
    pushItem(items, 'reply', '回复', 'reply', null, () => acts.onReply(msg));
  }
  if (a.edit && isFn(acts.onEdit)) {
    // 无贴合「编辑」语义的生成图标（icons.js 无铅笔类），该项不带图标（占位槽保留）
    pushItem(items, 'edit', '编辑', null, null, () => acts.onEdit(msg));
  }
  if (a.copy && isFn(acts.onCopy)) {
    pushItem(items, 'copy', '复制文本', 'copy', null, () => acts.onCopy(msg));
  }
  if (a.forward && isFn(acts.onForward)) {
    pushItem(items, 'forward', '转发', 'forward', null, () => acts.onForward(msg));
  }
  if (a.pin && !a.unpin && isFn(acts.onPin)) {
    pushItem(items, 'pin', '置顶', 'pin', null, () => acts.onPin(msg));
  }
  if (a.unpin && isFn(acts.onUnpin)) {
    pushItem(items, 'unpin', '取消置顶', 'unpin', null, () => acts.onUnpin(msg));
  }
  if (a.select && isFn(acts.onSelect)) {
    pushItem(items, 'select', '多选', 'select', null, () => acts.onSelect(msg));
  }
  if (a.del && isFn(acts.onDelete)) {
    if (items.length) items.push('sep');
    pushItem(items, 'delete', '删除', 'delete', { destructive: true }, () => acts.onDelete(msg, { revoke: a.revoke === true }));
  }
  return items;
}

// 便捷装配：内部先算 abilities 再编菜单（装配层一次调用即可）
export function buildMessageMenuFor(msg, ctx, actions) {
  return buildMessageMenu(msg, messageAbilities(msg, ctx), actions);
}

// ============================================================================
// 内容类型专属菜单（蓝图二 §3.4，对照 TI open*ContextMenu 逐条裁定）
// 触发面：MessageText 实体点按回调（onUrl/onMention/onBotCommand，由 M1 装配
// 到对应 builder；url 点按仍走既有 openUrl 分流，本目录的链接菜单供装配层在
// 长按等入口选用。onHashtag 不再进菜单——直达搜索态，见下方退役注）。
// ============================================================================

// openLinkContextMenu ✅：打开（openUrl 分流）/ 复制链接 / 外部打开（openExternal）
export function buildLinkMenu(input, actions) {
  const url = String((input && input.url) || '').trim();
  if (!url) return [];
  const acts = actions || {};
  const items = [];
  if (isFn(acts.onOpen)) pushItem(items, 'open', '打开链接', 'link', null, () => acts.onOpen(url));
  if (isFn(acts.onCopy)) pushItem(items, 'copy', '复制链接', 'copy', null, () => acts.onCopy(url));
  if (isFn(acts.onOpenExternal)) pushItem(items, 'external', '外部打开', 'external', null, () => acts.onOpenExternal(url));
  return items;
}

// openPhoneContextMenu ✅：复制 / 呼叫（tel: 外开；无电话类生成图标，呼叫项不带图标）
export function buildPhoneMenu(input, actions) {
  const phone = String((input && input.phone) || '').trim();
  if (!phone) return [];
  const acts = actions || {};
  const items = [];
  if (isFn(acts.onCopy)) pushItem(items, 'copy', '复制号码', 'copy', null, () => acts.onCopy(phone));
  if (isFn(acts.onCall)) pushItem(items, 'call', '呼叫', null, null, () => acts.onCall(phone));
  return items;
}

// openMentionContextMenu 🔻（蓝图裁定：TI 是打开资料页，无资料页面，降级为
// 「打开对话」= GET /resolve 解析后 push，复用既有链）：打开对话 / 复制
// 入参兼容两种实体：@用户名（MessageText 传原文含 @）与 MentionName 的 userId。
export function buildMentionMenu(input, actions) {
  const raw = input && input.username;
  const acts = actions || {};
  const name = typeof raw === 'string' ? String(raw).trim().replace(/^@+/, '') : '';
  const userId = raw != null && typeof raw !== 'string' ? String(raw) : '';
  if (!name && !userId) return [];
  const items = [];
  if (isFn(acts.onOpenChat)) {
    pushItem(items, 'open', '打开对话', 'user', null, () => acts.onOpenChat({ username: name, userId }));
  }
  if (isFn(acts.onCopy)) {
    const text = name ? '@' + name : userId;
    pushItem(items, 'copy', '复制', 'copy', null, () => acts.onCopy(text));
  }
  return items;
}

// openHashtagContextMenu 🔻（2026-10-12 官方式搜索改版退役）：#话题点按已改
// 直达——MessageText onHashtag 由聊天页直接激活会话内搜索态并预填 #tag
// （chat/[id].js activateSearch），不再弹两项菜单；本 builder 随之删除。

// openDateContextMenu ✅：在日历中打开（CalendarPanel initialMonth 由装配层从
// date 换算月份，§5.3-C；date 为 ISO 串或 unix 秒，原样透传）
export function buildDateMenu(input, actions) {
  const date = input && input.date;
  if (date == null || date === '') return [];
  const acts = actions || {};
  const items = [];
  if (isFn(acts.onOpenCalendar)) {
    pushItem(items, 'calendar', '在日历中打开', 'calendar', null, () => acts.onOpenCalendar(date));
  }
  return items;
}

// openCommandContextMenu ✅：填入输入框（TI tapAction 同语义：把命令挂进输入态）
export function buildCommandMenu(input, actions) {
  const command = String((input && input.command) || '').trim();
  if (!command) return [];
  const acts = actions || {};
  const items = [];
  if (isFn(acts.onFill)) pushItem(items, 'fill', '填入输入框', 'command', null, () => acts.onFill(command));
  return items;
}

// ============================================================================
// 对话行上下文菜单（域 3 EnabledContextActions；蓝图二 §5.1-C 列表页行菜单，
// M3 的 DialogRow onLongPress(item) → 本 builder → ContextMenu）
// ----------------------------------------------------------------------------
// item = 对话目录条目 { peerKey, kind, pinned, muted, unreadCount, ... }
// actions 键（可选）：
//   onTogglePin(item, pinned)      置顶/取消置顶（POST /dialog/update {pinned}）
//   onToggleMute(item, muted)      静音/取消静音（{muted}）
//   onMarkUnread(item, makeUnread) 标记未读/已读（{unread}；按 unreadCount 翻转）
//   onArchive(item)                归档（{archived:true}；目录条目无归档态字段，
//                                  恒出「归档」单项，取消归档由装配层在归档视图
//                                  自行换签——当前列表无归档视图，见蓝图 §4.2-⑨）
//   onDelete(item)                 删除对话（POST /dialog/delete；确认弹层文案
//                                  由装配层如实描述「从列表隐藏并清空历史，
//                                  不退出群组/频道」）
// ============================================================================
export function buildDialogMenu(item, abilities, actions) {
  const items = [];
  if (!item || typeof item !== 'object') return items;
  const a = abilities || null;
  const acts = actions || {};
  const pinned = item.pinned === true;
  const muted = item.muted === true;
  const unread = (Math.floor(Number(item.unreadCount)) || 0) > 0;

  if (a && a.pin && isFn(acts.onTogglePin)) {
    pushItem(items, 'pin', pinned ? '取消置顶' : '置顶', 'pin', null, () => acts.onTogglePin(item, !pinned));
  }
  if (a && a.mute && isFn(acts.onToggleMute)) {
    pushItem(items, 'mute', muted ? '取消静音' : '静音', muted ? 'unmute' : 'mute', null, () => acts.onToggleMute(item, !muted));
  }
  if (a && a.markUnread && isFn(acts.onMarkUnread)) {
    pushItem(
      items,
      'markunread',
      unread ? '标记为已读' : '标记为未读',
      unread ? 'markRead' : 'markUnread',
      null,
      () => acts.onMarkUnread(item, !unread)
    );
  }
  if (a && a.archive && isFn(acts.onArchive)) {
    pushItem(items, 'archive', '归档', 'archive', null, () => acts.onArchive(item));
  }
  if (a && a.remove && isFn(acts.onDelete)) {
    if (items.length) items.push('sep');
    pushItem(items, 'delete', '删除对话', 'delete', { destructive: true }, () => acts.onDelete(item));
  }
  return items;
}
