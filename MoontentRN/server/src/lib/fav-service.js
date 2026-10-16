// ============================================================
// fav-service.js —— 收藏域服务层(仅 Node 服务端运行)
//
// 定位:/api/fav/* 五端点背后的唯一业务实现。收藏是全局共享清单(无账号
// 无设备概念,所有端同一份),MySQL(favorites 表,结构见 scripts/init-db.mjs)
// 是唯一持久层,Redis 只是热缓存——键 mnt:fav:all = 全量 items JSON
// (created_at 倒序),连不上必须静默降级直查 MySQL,绝不让主链路 5xx
// (与 redis.js 文件头「加速器不是依赖项」同一条铁律)。
//
// 读写路径:
//   · 读路径(ids/list):Redis 优先,miss 从 MySQL ORDER BY created_at DESC
//     重建全量数组并回填(SET EX 86400);ids/list 全部从该数组派生——list
//     的站点精确过滤 + 标题 kw 大小写不敏感过滤 + 切片分页全在内存做,
//     全局上限 5000 条下全量数组就是最省事的分页基座,不再发第二条 SQL;
//   · 写路径(toggle/remove/clear):先 MySQL(INSERT ... ON DUPLICATE KEY
//     UPDATE / DELETE WHERE (site,vid) IN / 全删),成功后 rdDel 失效缓存
//     再返回——「库为准、缓存可弃」,任何时刻缓存丢失都只是多一次重建,
//     读到旧数组的窗口也只到 DEL 生效为止。
//
// 错误语义:业务 4xx(超上限等)抛带 status 的 Error,路由层原样透传;
// MySQL 故障抛 db.js 包装的普通 Error(无 status),由路由层统一转 503
// 「收藏服务暂不可用」——收藏是持久化数据,连不上绝不装作成功。
// ============================================================

import { q } from './db.js';
import { rdGet, rdSet, rdDel } from './redis.js';

// 全局收藏上限:toggle 新增时已到上限即 400(文案契约,数字写进消息)
export const FAV_LIMIT = 5000;

// 全量热缓存键与回填 TTL(秒):写操作 DEL 失效,miss 重建后回填
const FAV_CACHE_KEY = 'mnt:fav:all';
const FAV_CACHE_TTL = 86400;

// 业务错误(带 HTTP 状态,路由层按 err.status 透传;MySQL 故障无 status → 503)
function favError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// 行 → 契约 item(created_at 经池层 timezone:'Z' 读出即 UTC 时间,getTime
// 得 ms 纪元值;duration 保留 null 语义,hd 归一为布尔)
function rowToItem(r) {
  return {
    site: r.site,
    id: r.vid,
    title: r.title || '',
    cover: r.cover || '',
    duration: r.duration == null ? null : Number(r.duration),
    hd: Boolean(r.hd),
    at: r.created_at instanceof Date
      ? r.created_at.getTime()
      : (Date.parse(r.created_at) || 0),
  };
}

// 全量清单(读路径唯一取数口):Redis 命中直接用(坏 JSON 视为 miss 重建
// 覆盖);miss 走 MySQL 重建并回填。Redis 不可用时 rdGet 回 null,自然落
// MySQL——加速器语义零额外分支。同列 created_at 相同的极端场景按 id DESC
// 二次排序,保证分页稳定。
async function loadAll() {
  const raw = await rdGet(FAV_CACHE_KEY);
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
    } catch { /* 坏缓存视为 miss:下面重建覆盖 */ }
  }
  const rows = await q(
    'SELECT site, vid, title, cover, duration, hd, created_at FROM favorites ORDER BY created_at DESC, id DESC',
  );
  const items = rows.map(rowToItem);
  await rdSet(FAV_CACHE_KEY, JSON.stringify(items), FAV_CACHE_TTL);
  return items;
}

// 当前总数(写路径回包用;读路径直接取数组长度,省一次往返)
async function countAll() {
  const rows = await q('SELECT COUNT(*) AS c FROM favorites');
  return Number((rows[0] && rows[0].c) || 0);
}

/**
 * GET /api/fav/ids 的数据:全量 key 清单(site:id,按收藏时间倒序)
 * @returns {Promise<{ids:string[], total:number, at:number}>}
 */
export async function favIds() {
  const items = await loadAll();
  return {
    ids: items.map((it) => it.site + ':' + it.id),
    total: items.length,
    at: Date.now(),
  };
}

/**
 * GET /api/fav/list 的数据:站点精确过滤 + 标题 kw 大小写不敏感过滤,
 * 过滤后在内存切片分页(hasMore 按过滤后的 total 计算)
 * @param {{page:number, size:number, site?:string, kw?:string}} o
 * @returns {Promise<{items:Array, page:number, size:number, hasMore:boolean, total:number}>}
 */
export async function favList({ page, size, site, kw } = {}) {
  const items = await loadAll();
  let arr = items;
  if (site) arr = arr.filter((it) => it.site === site);
  if (kw) {
    const w = String(kw).toLowerCase();
    arr = arr.filter((it) => (it.title || '').toLowerCase().includes(w));
  }
  const total = arr.length;
  const start = (page - 1) * size;
  return {
    items: arr.slice(start, start + size),
    page,
    size,
    hasMore: start + size < total,
    total,
  };
}

/**
 * POST /api/fav/toggle 的数据:已收藏→删除回 fav:0;未收藏→(未超全局
 * 上限)插入/更新快照回 fav:1。快照字段(title/cover/duration/hd)由
 * 路由层先行校验/截断,本层只管落库与缓存失效。
 * @param {{site:string, vid:string, title?:string, cover?:string, duration?:number|null, hd?:0|1}} o
 * @returns {Promise<{fav:0|1, total:number}>}
 */
export async function favToggle({ site, vid, title = '', cover = '', duration = null, hd = 0 }) {
  // 存在性以 MySQL 为准(刻意不读缓存):杜绝「缓存未失效导致反向误删/
  // 重复插入」的语义漂移——写侧永远对着数据本体做判定
  const found = await q(
    'SELECT id FROM favorites WHERE site = ? AND vid = ? LIMIT 1',
    [site, vid],
  );
  if (found.length > 0) {
    await q('DELETE FROM favorites WHERE site = ? AND vid = ?', [site, vid]);
    await rdDel(FAV_CACHE_KEY);
    return { fav: 0, total: await countAll() };
  }
  // 未收藏:新增前检查全局上限,超出按契约 400
  if ((await countAll()) >= FAV_LIMIT) {
    throw favError(400, `收藏已满(${FAV_LIMIT})`);
  }
  // ON DUPLICATE KEY UPDATE 兜「查在插前」的极小并发窗口(同 key 竞态下
  // 退化为刷新快照,仍回 fav:1)。行别名语法需 MySQL ≥8.0.19,当前收藏库
  // 8.4;旧式 VALUES() 自 8.0.20 起废弃,不再使用
  await q(
    `INSERT INTO favorites (site, vid, title, cover, duration, hd)
     VALUES (?, ?, ?, ?, ?, ?) AS new
     ON DUPLICATE KEY UPDATE
       title = new.title, cover = new.cover, duration = new.duration, hd = new.hd`,
    [site, vid, title, cover, duration, hd ? 1 : 0],
  );
  await rdDel(FAV_CACHE_KEY);
  return { fav: 1, total: await countAll() };
}

/**
 * POST /api/fav/remove 的数据:按 (site,vid) 批量删除(keys 已由路由层逐条
 * 校验并拆成键值对);IN 列表按 500 一批分片,防超长 SQL
 * @param {Array<{site:string, vid:string}>} pairs
 * @returns {Promise<{removed:number, total:number}>}
 */
export async function favRemove(pairs) {
  let removed = 0;
  for (let i = 0; i < pairs.length; i += 500) {
    const batch = pairs.slice(i, i + 500);
    const params = [];
    const holders = batch.map((p) => {
      params.push(p.site, p.vid);
      return '(?, ?)';
    });
    const res = await q(
      `DELETE FROM favorites WHERE (site, vid) IN (${holders.join(', ')})`,
      params,
    );
    removed += Number((res && res.affectedRows) || 0);
  }
  if (pairs.length > 0) await rdDel(FAV_CACHE_KEY);
  return { removed, total: await countAll() };
}

/**
 * POST /api/fav/clear 的数据:清空全部收藏(测试收尾清理同走此路)
 * @returns {Promise<{total:number}>}
 */
export async function favClear() {
  await q('DELETE FROM favorites');
  await rdDel(FAV_CACHE_KEY);
  return { total: 0 };
}
