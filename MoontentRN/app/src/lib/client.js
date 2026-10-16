// ============================================================================
// client.js —— 统一前端 API（全部打 Koa 后端 /api/{site}/{method}）
// ----------------------------------------------------------------------------
// 契约（跨模块钉死）：
//   api(site, method, params) → 解析后 JSON（遇 {__err:1,message} 抛 Error）；
//   getSites()                → Promise<[{id,name,capabilities,group}]>；
//   absolutizeUrl(u)          → 相对地址绝对化（喂给图片/播放器组件前必须过它）。
// 接口与数据形状（VideoItem/ListResult/Detail/resolvePlay 等）见
// NextWeb/src/server/plugins/base.js 文件头；错误统一 {__err:1,message}+502，
// 本层转成异常（message 原样透传）。
//
// 在 NextWeb/src/lib/client.js 基础上做三处 RN 化改造：
// 1) 全部请求走 api-base 绝对地址（三端 App 无同源概念）；
// 2) 响应内的封面/头像/播放地址统一绝对化：cover 字段可能是 /api/img/... 相对
//    地址（后端图片代理），deep-walk 已知 URL 键（cover/avatar/thumb/url）把
//    '/' 开头的值拼上基址，图片组件拿到的永远是可直接加载的绝对 URL；
// 3) 查询串自建（Hermes 无 URLSearchParams 保证），null/undefined/空串不进参数。
// 保留 NextWeb 同款三项加速/防御：20s 默认超时、同 URL GET 在途去重（仅未传
// 自定义 signal 的调用参与）、meta 类方法（sites/categories/tags/hotwords/
// albumcats/boards）5 分钟内存 TTL 缓存。注意去重与缓存返回同一个解析对象、
// 被多方共享——消费方只读不改（deep-walk 绝对化时也重建新对象，不污染缓存……
// 缓存的即为绝对化后的结果，基址变更后请调 resetClientCache()）。
// ============================================================================
import { getApiBase } from './api-base.js';
import { resetShardConfig } from './origin-pool.js';

const TIMEOUT_MS = 20000;    // 默认请求超时（上游插件链路 15s 超时，留余量）
// play 单独放宽：播放地址解析走各站最重链路（含羞草加密网关实测冷热均 ~15-30s，
// 服务端刻意不缓存 play），20s 默认档必然截断——真机测试实测 27s 稳定超时报
// 「请求已取消」。观看页/看板/悬浮预览全走本方法，取 60s 兜底。
const PLAY_TIMEOUT_MS = 60000;
const META_TTL_MS = 300000;  // meta 缓存 5 分钟
// 走 meta 缓存的方法集：站点/分类/标签/热词/相册分类/板块清单——纯结构元数据
const META_METHODS = new Set(['sites', 'categories', 'tags', 'hotwords', 'albumcats', 'boards']);

const inflight = new Map(); // url → Promise（同 URL 在途去重；settle 后即删）
const metaCache = new Map(); // url → { at, data }

// 裸请求：默认超时兜底 + AbortError 归一化 + ok/__err 错误契约
async function rawGet(url, signal, timeoutMs) {
  // 无自定义 signal 时给默认超时（个别环境无 AbortSignal.timeout，退化为不设限）
  const sig = signal
    || (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs || TIMEOUT_MS)
      : undefined);
  let r;
  try {
    r = await fetch(url, sig ? { signal: sig } : undefined);
  } catch (e) {
    if (e && e.name === 'AbortError') {
      // 中止来源二选一：调用方 signal 已 abort（主动中止）还是默认超时兜底
      throw new Error(signal && signal.aborted ? '请求已中止' : '请求超时(' + ((timeoutMs || TIMEOUT_MS) / 1000) + 's)已中止');
    }
    throw e;
  }
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.__err) throw new Error((j && j.message) || 'HTTP ' + r.status);
  return j;
}

// GET 管道：meta 缓存 → 在途去重 → rawGet（三条路返回的对象都可能被共享，只读）
function request(path, { signal, meta = false, method = '' } = {}) {
  const url = getApiBase() + path;
  const timeoutMs = method === 'play' ? PLAY_TIMEOUT_MS : TIMEOUT_MS;
  if (meta) {
    const hit = metaCache.get(url);
    if (hit && Date.now() - hit.at <= META_TTL_MS) return Promise.resolve(hit.data);
    if (hit) metaCache.delete(url); // 过期清位，下面重拉
  }
  if (!signal && inflight.has(url)) return inflight.get(url); // 在途同求：共享同一 Promise
  const p = rawGet(url, signal, timeoutMs);
  if (!signal) {
    inflight.set(url, p);
    // settle 即摘除（成功失败都摘），去重只作用于「在途」窗口
    const done = () => { if (inflight.get(url) === p) inflight.delete(url); };
    p.then(done, done);
  }
  if (meta) p.then((d) => { metaCache.set(url, { at: Date.now(), data: d }); }, () => {}); // 失败不缓存
  return p;
}

// 查询串：null/undefined/空串不进参数（避免序列化成 "undefined"）
function buildQuery(params) {
  const parts = [];
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (v == null || v === '') continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  }
  return parts.join('&');
}

// 相对地址 → 绝对地址：'/' 开头拼基址；协议相对 '//x' 补 https:；data:/blob:/
// file: 与已是 http(s) 的原样返回；其余按相对路径拼。null/空安全返回 ''
export function absolutizeUrl(u) {
  if (typeof u !== 'string' || !u) return u || '';
  if (/^https?:\/\//i.test(u) || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('file:')) return u;
  if (u.startsWith('//')) return 'https:' + u;
  const b = getApiBase();
  return u.startsWith('/') ? b + u : b + '/' + u;
}

// 已知 URL 值键：deep-walk 时命中即绝对化（契约中所有图片/播放入口字段）
const URL_KEYS = new Set(['cover', 'avatar', 'thumb', 'url']);
const MAX_DEPTH = 8; // 防御式深度上限（响应结构异常深时止步）

// 响应深遍历绝对化（重建新对象，不改动缓存里的共享结构）
function absolutizeDeep(v, depth) {
  if (depth > MAX_DEPTH || v == null) return v;
  if (Array.isArray(v)) return v.map((x) => absolutizeDeep(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      const val = v[k];
      out[k] = URL_KEYS.has(k) && typeof val === 'string'
        ? absolutizeUrl(val)
        : absolutizeDeep(val, depth + 1);
    }
    return out;
  }
  return v;
}

// 统一 API 调用：GET {base}/api/{site}/{method}?{qs} → 归一化 JSON（绝对化后）
// 例：api('yuese', 'list', { page: 1, size: 24 })；opts = { signal } 可透传中止信号
export async function api(site, method, params, opts = {}) {
  const qs = params ? buildQuery(params) : '';
  const j = await request('/api/' + site + '/' + method + (qs ? '?' + qs : ''), {
    signal: opts.signal,
    meta: META_METHODS.has(method),
    method,
  });
  return absolutizeDeep(j, 0);
}

// 站点清单：[{ id, name, capabilities, group }]（group: main 主站 / cms 资源站，
// zy_ 前缀 id 为资源站群）；meta 缓存命中直接返回
export async function getSites(opts = {}) {
  const j = await request('/api/sites', { signal: opts.signal, meta: true });
  return Array.isArray(j) ? j : [];
}

// 清空在途去重表与 meta 缓存：切换后端基址后调用，防旧基址缓存串台；
// 分片 origin 池一并清（旧基址的 origin 不可再用，清单重拉重喂前消费方回落
// 单基址行为——见 site-context 的 feedShardConfig）
export function resetClientCache() {
  inflight.clear();
  metaCache.clear();
  resetShardConfig();
}
