// ============================================================================
// fav-api.js —— 收藏域 API 通道（GET + JSON POST，收藏页/收藏星标共用）
// ----------------------------------------------------------------------------
// 契约（后端 /api/fav/*，全局共享清单，无账号无设备概念）：
//   favIds()                            → GET  /api/fav/ids
//     { ids: string[]（"site:id"，收藏时间倒序）, total, at }
//   favList({page,size,site,kw}, sig?)  → GET  /api/fav/list?page=&size=&site=&kw=
//     { items: [{site,id,title,cover,duration,hd,at(ms)}], page, size,
//       hasMore, total }（site 精确过滤，kw 标题大小写不敏感过滤，内存切片分页）
//   favToggle(item)                     → POST /api/fav/toggle
//     入参 {site,id,title?,cover?,duration?,hd?} → { fav: 0|1, total }
//     （已收藏→删除返回 fav:0；未收藏→插入/更新快照返回 fav:1；
//     全局上限 5000，超限 400「收藏已满(5000)」）
//   favRemove(keys)                     → POST /api/fav/remove {keys:["site:id",…]}
//     → { removed, total }
//   favClear()                          → POST /api/fav/clear → { total: 0 }
// 错误契约：{__err:1,message}（非法参数 400 / 服务不可用 503 等）→ 抛
//   Error(message 原样透传)；默认 20s 超时，AbortError 归一中文。
// 与 tg-api.js / client.js 的分工（勿混淆）：
//   · 仿 tg-api.js 的 fetchJson 自建通道，但归收藏域专用：不去重不缓存
//     （清单数据要求新鲜，no-store）、绝不自动重试（仓库红线）；
//   · 响应不做深遍历绝对化——cover 可能是 /api/img/... 相对地址，由展示层
//     经 client.js 的 absolutizeUrl 自行绝对化（收藏 store/快照保留原始值，
//     换基址后仍可正确显示）。
// ============================================================================
import { getApiBase } from './api-base.js';

const TIMEOUT_MS = 20000; // 默认超时（与 client.js / tg-api.js 默认档一致）

// 查询串：null/undefined/空串不进参数（与 client.js buildQuery 同款，Hermes
// 无 URLSearchParams 保证，纯字符串拼接）
function buildQuery(params) {
  const parts = [];
  for (const k of Object.keys(params || {})) {
    const v = params[k];
    if (v == null || v === '') continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  }
  return parts.join('&');
}

// 裸请求：超时计时器 + 调用方 signal 并联中止 + ok/__err 错误契约 → Error
async function fetchJson(path, { method = 'GET', body, timeoutMs = TIMEOUT_MS, signal } = {}) {
  const ms = Math.max(1000, Math.floor(Number(timeoutMs)) || TIMEOUT_MS);
  // 无 AbortController 的极端环境退化为不设限（与 tg-api.js 同款兜底）
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  const onAbort = () => { if (ctl) ctl.abort(); };
  if (ctl) {
    if (signal) {
      if (signal.aborted) ctl.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => ctl.abort(), ms);
  }
  try {
    const r = await fetch(getApiBase() + path, {
      method,
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
      signal: ctl ? ctl.signal : undefined,
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.__err) {
      throw new Error((j && j.message) || 'HTTP ' + r.status);
    }
    return j;
  } catch (e) {
    if (e && e.name === 'AbortError') {
      // 中止来源二选一：调用方 signal 主动中止 vs 超时计时器兜底（文案与
      // tg-api.js 逐字一致，页面 catch 的既有提示风格统一）
      throw new Error(signal && signal.aborted ? '请求已中止' : '请求超时(' + Math.round(ms / 1000) + 's)已中止');
    }
    throw e;
  } finally {
    if (timer != null) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// 全量收藏 id 清单（收藏时间倒序）→ { ids, total, at }
export function favIds(opts = {}) {
  return fetchJson('/api/fav/ids', { signal: opts.signal, timeoutMs: opts.timeoutMs });
}

// 分页清单（首页口径 page=1/size=24 由服务端兜底，此处透传非空参数）
// → { items, page, size, hasMore, total }；opts.signal 供页面卸载中止
export function favList(params = {}, signal) {
  const qs = buildQuery(params);
  return fetchJson('/api/fav/list' + (qs ? '?' + qs : ''), { method: 'GET', signal });
}

// 收藏/取消收藏（服务端按自身状态取反）→ { fav: 0|1, total }
// 入参 item = {site,id,title?,cover?,duration?,hd?}；title/cover 客户端先按
// 服务端口径截断（512/1024），超长脏数据不进请求体
export function favToggle(item) {
  const it = item || {};
  const body = {
    site: String(it.site || ''),
    id: String(it.id == null ? '' : it.id),
  };
  if (typeof it.title === 'string' && it.title) body.title = it.title.slice(0, 512);
  if (typeof it.cover === 'string' && it.cover) body.cover = it.cover.slice(0, 1024);
  if (typeof it.duration === 'number' && isFinite(it.duration)) body.duration = it.duration;
  if (it.hd != null) body.hd = !!it.hd;
  return fetchJson('/api/fav/toggle', { method: 'POST', body });
}

// 按 key 批量移除（key 形如 "site:id"）→ { removed, total }；单个字符串入参
// 也收（包成单元素数组）
export function favRemove(keys) {
  const arr = Array.isArray(keys) ? keys : [keys];
  const body = { keys: arr.filter((k) => typeof k === 'string' && k) };
  return fetchJson('/api/fav/remove', { method: 'POST', body });
}

// 清空收藏 → { total: 0 }
export function favClear() {
  return fetchJson('/api/fav/clear', { method: 'POST', body: {} });
}
