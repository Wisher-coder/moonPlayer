// ============================================================================
// history-coordinator.js —— 聊天历史协调器(Telegram-iOS ChatHistoryListNodeImpl 等价)
// ----------------------------------------------------------------------------
// 参照系:.fixtmp/tgios-pages-blueprint.md §2.3(协调器七条)与 corelist 文档
// (tmpTelegram/Telegram-iOS/docs/chat/corelist-chat-history-backend.md,只读)。
// 职责:行事实源与 diff(事务三段)/挂载门禁/定位(锚定链入口)/未读重钉合并
// 参数——全部零 RN import,runner 直测(门 10)。
//
// 「聊天层一切后端相关分支只读 coordinator.usesBackend,禁止自行重推策略」
// (§2.3-1,TI usesCoreListBackend 教训:有一处代码在缺省翻转后自行重推而漂移)。
//
// 事务应用顺序恒:先删(降序索引)→ 后插(升序)→ 再更新——TI CoreList
// 事务顺序;邻居描述(merge 角/日期线/未读线归属)是「最终邻接」的函数,
// 由 tg-rows.buildRows 在行数组落定后一次性算好,协调器只消费最终行
// (corelist 文档「Neighbor awareness」:邻居在删/插/更 settle 之后一次计算)。
// ============================================================================
import { makeTransaction, MAX_INT, PINNED_EPS } from './history-backend.js';
import { findRowIndex } from '../tg-rows.js';

// —— 行渲染面指纹(stableVersion 的内容等价判别符) ——
// 白名单必须覆盖「行渲染的全部输入」,漏字段的既有回归面(代码即文档,蓝图
// §2.3-2 必须写明的三类):
//   ① 投票/bot 回调成功后 replaceMessage 只改 media(PollCard chosen/voters、
//      InlineKeyboard),text/date/id 全不变(chat/[id].js doVote/doCallback →
//      replaceMessage)——指纹不含 media 即把原位替换吞成 no-op、气泡不重渲;
//   ② merge 角随运行组邻接变化(删除组中间一条后幸存行角半径变,tg-rows
//      runPrev/runNext)——指纹不含 mergeTop/mergeBottom 即行不重渲;
//   ③ replyTo 补齐/转发头同理(存根成功后被服务端完整形状原位替换)。
// 对照 corelist 文档不变量:邻居描述参与 isEqual(to:),「a descriptor must
// encode everything a neighbor reads, or the omitted fact goes stale on screen」。
function digestMedia(media) {
  if (!media || typeof media !== 'object') return '';
  const k = media.kind;
  switch (k) {
    case 'photo':
      return 'photo:' + jstr([media.photo && media.photo.url, media.photo && media.photo.fullUrl, media.photo && media.photo.w, media.photo && media.photo.h]);
    case 'video':
      return 'video:' + jstr([media.video && media.video.videoId, media.video && media.video.cover, media.video && media.video.duration, media.video && media.video.w, media.video && media.video.h]);
    case 'sticker':
      return 'sticker:' + jstr([media.sticker && media.sticker.emoji, media.sticker && media.sticker.url, media.sticker && media.sticker.w, media.sticker && media.sticker.h]);
    case 'voice':
      return 'voice:' + jstr([media.voice && media.voice.duration]);
    case 'audio':
      return 'audio:' + jstr([media.audio && media.audio.name, media.audio && media.audio.duration]);
    case 'document':
      return 'document:' + jstr([media.document && media.document.name, media.document && media.document.size, media.document && media.document.thumb]);
    case 'webpage':
      return 'webpage:' + jstr([media.webpage && media.webpage.url, media.webpage && media.webpage.title]);
    case 'poll':
      // 回归面①:投票原位替换只动 chosen/voters/total——逐项纳入
      return 'poll:' + jstr([
        media.poll && media.poll.question,
        media.poll && media.poll.closed,
        media.poll && media.poll.quiz,
        media.poll && media.poll.multipleChoice,
        media.poll && media.poll.results && media.poll.results.total,
        media.poll && media.poll.results && media.poll.results.per,
      ]);
    case 'geo':
      return 'geo:' + jstr([media.geo && media.geo.lat, media.geo && media.geo.long, media.geo && media.geo.title]);
    case 'contact':
      return 'contact:' + jstr([media.contact && media.contact.name, media.contact && media.contact.phone]);
    case 'unsupported':
      return 'unsupported:' + jstr([media.unsupported && media.unsupported.note]);
    default:
      return 'kind:' + String(k || '');
  }
}

// 紧凑稳定序列化(键序固定:数组/字面量输入,无对象键枚举序问题)
function jstr(v) {
  try {
    return JSON.stringify(v);
  } catch (_e) {
    return String(v);
  }
}

// 单行指纹:t/key 之外覆盖渲染面白名单(见上三类回归面注释)。日期/未读行
// 是常量 identity 行(key 恒定),指纹只含日期值。
export function rowFingerprint(row) {
  if (!row) return '';
  if (row.t === 'date') return 'date|' + String(row.key) + '|' + String(row.date || '');
  if (row.t === 'unread') return 'unread|' + String(row.key);
  const m = row.msg || {};
  const parts = [
    'msg',
    row.key,
    row.t,
    m.id,
    m.kind,
    m.out ? 1 : 0,
    String(m.date || ''),
    String(m.__status || ''),
    String(m.text || ''),
    // 实体面:同文本不同实体(加粗/链接)也算内容变化
    jstr(m.entities || []),
    m.views == null ? '' : String(m.views),
    String(m.signature || ''),
    String(m.viaBot || ''),
    m.forward ? String(m.forward.name || '') + '|' + String(m.forward.date || '') : '',
    m.replyTo ? jstr([m.replyTo.msgId, m.replyTo.name, m.replyTo.snippet]) : '',
    m.service ? String(m.service.text || '') : '',
    // 发送者面(MessageBubble 渲染 from.name/头像 name/seed):补齐链路重拉
    // 只换 from(名字补全/改名)而其余不变时,指纹必须变化才触发重渲
    m.from ? String(m.from.id || '') + '|' + String(m.from.name || '') : '',
    digestMedia(m.media),
    jstr(m.inlineKeyboard || null),
    jstr(m.replyKeyboard || null),
    // 行级(回归面②:merge 角)+ 运行组呈现面 + 相册面
    row.mergeTop ? 1 : 0,
    row.mergeBottom ? 1 : 0,
    row.showSender ? 1 : 0,
    row.showAvatar ? 1 : 0,
    String(row.readId || ''),
    jstr(row.memberIds || null),
    row.album ? 'album' + row.album.length + ':' + jstr(row.album) : '',
  ];
  return parts.join('\u0001');
}

// —— 行数组 diff → 事务三段(删降序/插升序/更升序;同 stableId 换内容 →
// update 非重插,门 10-③) ——
export function diffRows(prevRows, nextRows) {
  const prev = prevRows || [];
  const next = nextRows || [];
  const prevFp = new Map();
  for (let i = 0; i < prev.length; i++) {
    const r = prev[i];
    if (r && !prevFp.has(r.key)) prevFp.set(r.key, { index: i, fp: rowFingerprint(r) });
  }
  const nextKeySet = new Set();
  for (const r of next) {
    if (r) nextKeySet.add(r.key);
  }
  const deletes = [];
  for (let i = 0; i < prev.length; i++) {
    const r = prev[i];
    if (!r || nextKeySet.has(r.key)) continue;
    deletes.push(i);
  }
  const inserts = [];
  const updates = [];
  for (let i = 0; i < next.length; i++) {
    const r = next[i];
    if (!r) continue;
    const p = prevFp.get(r.key);
    if (!p) {
      inserts.push({ index: i, row: r });
    } else if (p.fp !== rowFingerprint(r)) {
      updates.push({ index: i, row: r });
    }
  }
  deletes.sort((a, b) => b - a); // 降序:先删,早删不移位晚删
  return { deleteIndices: deletes, insertIndicesAndItems: inserts, updateIndicesAndItems: updates };
}

// 按 ListView 事务顺序把三段应用回数组(后端 A 的重建路径与门 10-② 共用
// 同一实现,防两处口径漂移;顺序错 → 重建结果与目标不等,断言即炸)
export function applyTransactionToRows(prevRows, tx) {
  let list = (prevRows || []).slice();
  const del = (tx.deleteIndices || []).slice().sort((a, b) => b - a);
  for (const idx of del) {
    if (idx >= 0 && idx < list.length) list.splice(idx, 1);
  }
  const ins = (tx.insertIndicesAndItems || []).slice().sort((a, b) => a.index - b.index);
  for (const { index, row } of ins) {
    list.splice(Math.min(Math.max(index, 0), list.length), 0, row);
  }
  const upd = (tx.updateIndicesAndItems || []).slice().sort((a, b) => a.index - b.index);
  for (const { index, row } of upd) {
    if (index >= 0 && index < list.length) list[index] = row;
  }
  return list;
}

// 贴底发送动画的 stationaryItemRange 承重值:全替换 [.Reload] = [0, MAX_INT];
// 仅头部(最新端,index 0)连续插入 = [maxInserted+1, MAX_INT](蓝图 §2.2 字段表;
// 发送动画 v2 才有滑入消费,v1 机制先按同一口径给值)。
export function stationaryRangeFor(rows, diff, reason) {
  if (reason === 'reload') return [0, MAX_INT];
  const ins = diff.insertIndicesAndItems;
  const headOnly = ins.length > 0
    && diff.deleteIndices.length === 0
    && diff.updateIndicesAndItems.length === 0
    && ins[ins.length - 1].index === ins.length - 1; // 0..k-1 连续
  if (headOnly) return [ins.length, MAX_INT];
  return [0, MAX_INT];
}

// ============================================================================
// createHistoryCoordinator({ backend, onOutOfWindow, scheduler })
//   backend       已构造的后端实例(必须过 assertBackendMembers;构造期配置
//                 已在具体类型上设好,upcast 到协议面不携带构造参数——纪律 4)
//   onOutOfWindow (msgId) => void 定位未命中已载窗口时的重锚定出口(页面接
//                 hook.loadInitial,§5.3 onJump 契约的「未命中 → loadInitial」)
//   scheduler     (fn) => void completion 的调度器(缺省 setTimeout 0;runner
//                 注入同步/受控调度)
// ============================================================================
export function createHistoryCoordinator({ backend, onOutOfWindow, scheduler } = {}) {
  if (!backend) throw new Error('聊天历史协调器缺少后端实例');
  let committed = [];          // 已提交行(事实源;与两后端渲染面一致)
  let mounted = false;         // 挂载门禁(TI let _ = self.view 的等价不变量)
  const queue = [];            // 未挂载时排队的事务(挂载后按序补发)
  const schedule = typeof scheduler === 'function' ? scheduler : (fn) => setTimeout(fn, 0);

  // —— 事务下发(统一入口):组 tx → 挂载门禁 → backend.chatHistoryTransaction ——
  function dispatch(tx) {
    if (!mounted) {
      queue.push(tx);
      return;
    }
    backend.chatHistoryTransaction(tx);
  }

  // —— 行事实源入口:diff → 三段事务(reload/头部插入的 stationary 承重值) ——
  function setRows(rows, opts = {}) {
    const next = Array.isArray(rows) ? rows : [];
    const diff = diffRows(committed, next);
    committed = next;
    if (!diff.deleteIndices.length && !diff.insertIndicesAndItems.length && !diff.updateIndicesAndItems.length) {
      return null; // 无变化不发事务(等值 no-op,防渲染循环)
    }
    const tx = makeTransaction({
      deleteIndices: diff.deleteIndices,
      insertIndicesAndItems: diff.insertIndicesAndItems,
      updateIndicesAndItems: diff.updateIndicesAndItems,
      options: { animated: opts.animated === true },
      stationaryItemRange: stationaryRangeFor(next, diff, opts.reason),
      updateOpaqueState: { reason: opts.reason || 'update' },
    });
    dispatch(tx);
    return tx;
  }

  // —— 挂载门禁(§2.3-4):两后端都必须先过门禁再收第一个事务;A=宿主
  // FlatList 首帧 onLayout,B=host mount 事件,页面分别调用 ——
  function markMounted() {
    if (mounted) return;
    mounted = true;
    while (queue.length) {
      backend.chatHistoryTransaction(queue.shift());
    }
  }

  // —— 定位:命中已载窗口走后端 scrollToItem(经事务,TI ListViewScrollToItem
  //     全支持);未命中返回 false,由调用方决定是否走重锚定 ——
  // position 语义:'center'=视口居中(现状 scrollToIndex viewPosition 0.5 口径,
  // v1 全部消费点都用它);'top'/'bottom'=视口顶/底(TI .top/.bottom)。
  function scrollToRow(rowId, opts = {}) {
    const row = findRowById(committed, rowId);
    if (!row) return false;
    const tx = makeTransaction({
      options: { animated: opts.animated !== false },
      scrollToItem: { row, position: opts.position || 'center', offset: opts.offset || 0 },
      stationaryItemRange: [0, MAX_INT], // 纯滚动事务:不移动任何行,全范围驻留
    });
    dispatch(tx);
    return true;
  }

  // —— 导航统一路径(§5.7):窗口内 scrollToRow / 窗口外 onOutOfWindow(页面
  //     接 loadInitial(msgId) 重锚定,hook :866 既有签名)。搜索结果/日历/
  //     置顶条/t.me 深链全部走这一条,禁止新开第五种定位实现 ——
  function navigateToMessage(msgId, opts = {}) {
    const id = Math.floor(Number(msgId)) || 0;
    if (!(id > 0)) return false;
    if (scrollToRow(id, opts)) return true;
    if (typeof onOutOfWindow === 'function') {
      onOutOfWindow(id);
      return true;
    }
    return false;
  }

  // —— scrollToEndOfHistory 等价(§2.3-5):settled 底边读数 <= ε 时短路
  // (TI .known(value)<=ulpOfOne 短路同构;settledContentOffsets 双读数在同一
  // 次采样里,bottom=距最新端 0=贴住),否则发 scrollToItem(bottom) ——
  function scrollToEndOfHistory(opts = {}) {
    if (!committed.length) return 'empty';
    const settled = typeof backend.settledContentOffsets === 'function'
      ? backend.settledContentOffsets()
      : null;
    if (settled && settled.bottom <= PINNED_EPS) return 'pinned';
    const tx = makeTransaction({
      options: { animated: opts.animated !== false },
      scrollToItem: { row: committed[0], position: 'bottom', offset: 0 },
      stationaryItemRange: [0, MAX_INT],
    });
    dispatch(tx);
    return 'scrolled';
  }

  // —— 量测+重钉合并参数的事务入口(§2.3-6):updateSizeAndInsets 与
  //     maintainsUnreadItemAlignment 同 pass 提交(TI:两个半边分跨 inset 变化
  //     会静默破坏——禁拆两半)。maintainsUnreadItemAlignment=true 时协调器把
  //     'unread' 行与锚行合成同一次 scrollTo(B 一次移动一次动画;A 无同 pass
  //     能力 → backend 在 completion 里补滚,由后端各自兑现,门 10-⑤ 锁两分支)。
  //     v1 页面无真实 inset 变化消费面(壳层顶栏不在会话中变化、键盘避让不进
  //     列表几何),机制先落地并随门 10 发布,消费点见后端缺口清单 ——
  function applySizeAndInsets(opts = {}) {
    const inset = opts.contentInset || null;
    const tx = makeTransaction({
      options: { animated: opts.animated !== false },
      updateSizeAndInsets: inset
        ? {
            contentInset: {
              top: Math.max(0, Number(inset.top) || 0),
              bottom: Math.max(0, Number(inset.bottom) || 0),
            },
          }
        : null,
      maintainsUnreadItemAlignment: opts.maintainsUnreadItemAlignment === true,
      stationaryItemRange: [0, MAX_INT],
      scrollToItem: opts.maintainsUnreadItemAlignment === true && opts.unreadRow
        ? { row: opts.unreadRow, position: opts.position || 'top', offset: 0 }
        : null,
    });
    dispatch(tx);
    return tx;
  }

  return {
    // 只读发布(§2.3-1:聊天层一切后端相关分支只读它)
    get usesBackend() { return backend.kind; },
    get rows() { return committed; },
    get isMounted() { return mounted; },
    setRows,
    markMounted,
    scrollToRow,
    navigateToMessage,
    scrollToEndOfHistory,
    applySizeAndInsets,
  };
}

// 按消息 id 找已提交行(相册成员命中合流行;findRowIndex 的行数组口径)
function findRowById(rows, msgId) {
  const idx = findRowIndex(rows, Math.floor(Number(msgId)) || 0);
  return idx >= 0 ? rows[idx] : null;
}
