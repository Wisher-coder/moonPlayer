// ============================================================================
// tg-rows.js —— Telegram 聊天时间线渲染行装配(纯函数,零平台依赖)
// ----------------------------------------------------------------------------
// 从聊天页(chat/[id].js)拆出的渲染层装配逻辑,页面唯一数据源 use-chat-timeline
// 的 items(恒新→旧)在这里变成时间线列表的行数组(inverted 下数组序=视觉自底
// 向上;行数组同时供 FlatList 后端与自研虚拟列表后端消费,双后端同一装配)。
// 导出:
//   buildRows(items, unreadAnchorId, showNames) → rows
//     · 相册合流:相邻且 groupedId 非空且相同的连续消息合成一条——msg 取组内
//       id 最小那条,caption(text/entities)取组内第一个非空,album 按消息原
//       顺序(组内 id 升序)收集全体媒体成员(图片与视频混排,各 tile 带 kind
//       判别符;≥2 个媒体才走网格,否则按 head 单媒体渲染);
//     · 发送者名:群聊(showNames)入站运行组的首条(视觉最上)出发送者名;
//       头像:入站运行组的末条(视觉最下)出头位(由页面消费 showAvatar);
//     · merge 角(蓝图 §2.3-③,运行组内相邻行合并圆角,气泡四态角半径消费):
//       mergeTop=与视觉上方邻行同组(该行顶角收平)、mergeBottom=与视觉下方
//       邻行同组(底角收平)——由运行组邻接(runNext/runPrev)推导,服务消息
//       断组、日期线天然断行(同组必同天,见 sameRun 注释);
//     · 日期分隔条:每段同天消息的最旧一条之上(数组序:该条行之后插 date 行);
//     · 未读分隔条:hook 契约 items.findIndex(m => m.id <= unreadAnchorId)
//       命中行的视觉上方(相册成员命中时贴相册行);整屏皆未读(-1)插在最旧
//       端那条的视觉上方;unreadAnchorId<=0 不渲染。
//   findRowIndex(rows, msgId) → number
//     按消息 id 找渲染行下标(引用条点击/链接定位用;相册合流行按 memberIds
//     命中组内成员;-1 = 不在已载窗口)。
// ============================================================================
import { toDate } from '../components/telegram/chat-helpers.js';

// 本地日键(同一天 = 同本地年月日;日期缺失视为同天,不出分隔条)
function dayKey(v) {
  const d = toDate(v);
  return d ? d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate() : '';
}
function sameDay(a, b) {
  const ka = dayKey(a);
  const kb = dayKey(b);
  return !ka || !kb || ka === kb;
}

// 连续同发送者运行判定(双方均为普通入站消息且 from.id 相同;服务消息断组)
function sameRun(a, b) {
  return !!(a && b && a.kind !== 'service' && b.kind !== 'service'
    && !a.out && !b.out && a.from && b.from && a.from.id === b.from.id);
}

// 按消息 id 找渲染行下标(相册合流行用 memberIds 命中组内成员)
export function findRowIndex(rows, msgId) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.t !== 'msg') continue;
    if (r.msg && r.msg.id === msgId) return i;
    if (r.memberIds && r.memberIds.indexOf(msgId) !== -1) return i;
  }
  return -1;
}

// 渲染行装配(items 恒新→旧;输出行数组同序,inverted 下数组序=视觉自底向上)
export function buildRows(items, unreadAnchorId, showNames) {
  if (!items || !items.length) return [];
  const entries = []; // 渲染条目(相册已合流),仍按新→旧
  const n = items.length;
  let i = 0;
  while (i < n) {
    const m = items[i];
    const gid = m && m.groupedId;
    if (gid) {
      // 向旧向收集同组连续消息(items 降序,段内反转为升序=消息原顺序)
      let j = i;
      while (j < n && items[j] && items[j].groupedId === gid) j++;
      const members = items.slice(i, j).reverse();
      const head = members[0];
      let cap = head;
      for (const x of members) {
        if (x && x.text) { cap = x; break; }
      }
      // 相册 tiles:收集全体媒体成员(图片 tile 沿用 w/h/url/fullUrl,视频
      // tile 带 videoId/cover/duration/w/h 直通观看页)——按全部媒体成员计数,
      // 1 图+1 视也走混合网格(视频成员不丢弃、不降级为 head 单消息)
      const album = [];
      for (const x of members) {
        const md = x && x.media;
        if (!md) continue;
        if (md.kind === 'photo' && md.photo) {
          const ph = md.photo;
          album.push({ kind: 'photo', w: ph.w, h: ph.h, url: ph.url, fullUrl: ph.fullUrl });
        } else if (md.kind === 'video' && md.video) {
          const v = md.video;
          album.push({ kind: 'video', videoId: v.videoId, cover: v.cover, duration: v.duration, w: v.w, h: v.h });
        }
      }
      entries.push({
        msg: cap === head || !cap ? head : { ...head, text: cap.text, entities: cap.entities || [] },
        album: album.length >= 2 ? album : null,
        memberIds: members.map((x) => (x ? x.id : 0)),
      });
      i = j;
    } else {
      entries.push({ msg: m, album: null, memberIds: null });
      i++;
    }
  }
  // 未读边界条目:严格按 hook 契约的 findIndex 口径(跳过乐观存根)
  let unreadEntry = null;
  if (unreadAnchorId > 0) {
    let target = 0;
    for (const m of items) {
      if (m && typeof m.id === 'number' && m.id > 0 && m.id <= unreadAnchorId) { target = m.id; break; }
    }
    if (target) {
      unreadEntry = entries.find((e) => (e.msg && e.msg.id === target)
        || (e.memberIds && e.memberIds.indexOf(target) !== -1)) || null;
    } else {
      unreadEntry = entries[entries.length - 1] || null; // 整屏皆未读:最旧端之上
    }
  }
  const rows = [];
  for (let k = 0; k < entries.length; k++) {
    const e = entries[k];
    const m = e.msg;
    if (!m) continue;
    const prev = entries[k - 1] || null; // 更新邻条(视觉下方)
    const next = entries[k + 1] || null; // 更旧邻条(视觉上方)
    const runPrev = prev && sameRun(prev.msg, m);
    const runNext = next && sameRun(next.msg, m);
    rows.push({
      t: 'msg',
      key: 'm' + m.id,
      msg: m,
      album: e.album,
      memberIds: e.memberIds,
      readId: e.memberIds ? Math.max.apply(null, e.memberIds) : m.id, // 已读喂值:相册取组内最大 id
      showSender: !!showNames && !m.out && !!(m.from && m.from.name) && !runNext, // 组首条(视觉最上)
      showAvatar: !m.out && !runPrev, // 组末条(视觉最下)出头像
      // merge 角(蓝图 §2.3-③):与视觉上方邻行同组 → 顶角收平(mergeTop);
      // 与视觉下方邻行同组 → 底角收平(mergeBottom)。merge 角是「最终邻接」
      // 的函数(删除组中间一条后,幸存行角半径要跟着变)——行数组落定后在此
      // 一次算好,协调器的行指纹纳入这两个字段(漏了=原位替换吞成 no-op)
      mergeTop: !!runNext,
      mergeBottom: !!runPrev,
    });
    if (unreadEntry === e) rows.push({ t: 'unread', key: 'unread' });
    if (!next || !sameDay(m.date, next.msg.date)) rows.push({ t: 'date', key: 'd' + dayKey(m.date), date: m.date });
  }
  return rows;
}

export default buildRows;
