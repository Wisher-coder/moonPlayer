// ============================================================
// yuese.js —— 月色站点插件(加密 JSON API,仅 Node 服务端运行)
//
// 逆向结论(2026-10-06 授权测试环境实测,移植自 ys-server.js / yuese_api.js):
//   · 站点为 Flutter Web,API 走同源 /api/ 路径,裸 GET 无鉴权;
//   · 响应统一 {"error":0,"message":"请求成功","content":C},
//     常规 C={"encrypt":1,"encryptData":"<b64>"},AES-128-CBC
//     (key=IV="LqzCOd16vnYhOHTz",PKCS7);tags 等接口 content 内再嵌
//     一层同构壳,需二次剥;
//   · detail 的 POST 形态:body={"encrypt":1,"encryptData":AES(JSON({id}))}
//     (同密钥同 IV),匿名未耗配额时有机会返回签名 video_url;
//   · .aes 图片 = 前 16 字节 IV + AES-128-CBC 密文,独立密钥 "yuese!niubia!666";
//   · 参数名坑:分类复数 categories、搜索单数 keyword、标签 tags;
//   · 入口域名轮换:发布页 yuese04/05/06.cc →(JS 跳转≤3 跳)→
//     var domainsH5Codes=<charCode 数组>,逐项解码得最新基址数组。
//
// 基址策略:环境变量 YS_API_TARGET 有值 → 单基址直连(禁用自动刷新);否则发布页
// 解析,结果模块级缓存 10 分钟(域名刷新调度器 domain-refresh.js 每 5 分钟重跑
// 发现链,顺带续本缓存)。请求失败(HTTP≥400/网络错)换下一基址重试;
// 业务错(error!==0)与解密错换基址无意义,直接抛;发布页解析失败/全部基址
// 不可达时先 urgent 刷新入口域名,changed 则原请求重试一轮(每请求至多一次)。
// ============================================================
import crypto from 'node:crypto';
import { SitePlugin } from './base.js';
import { registerRefresher, requestUrgentRefresh } from './domain-refresh.js';

const API_KEY = Buffer.from('LqzCOd16vnYhOHTz', 'utf8');   // key=IV,16 字节
const IMG_KEY = Buffer.from('yuese!niubia!666', 'utf8');   // .aes 图片独立密钥
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const PUBLISH_ENTRIES = ['yuese04.cc', 'yuese05.cc', 'yuese06.cc']; // 发布页(站群轮换)
const MAX_HOPS = 3;            // 发布页→中转页 JS 跳转最大跟进层数
const BASES_TTL = 10 * 60 * 1000; // 基址缓存有效期(10 分钟)
const IMG_TIMEOUT_MS = 15000;  // 图片抓取超时(对齐其余插件 TIMEOUT_MS 约定)
const SORTS = ['post_date', 'video_viewed', 'most_popular']; // 上游合法排序值

// ============ 通用文本抓取(发布页解析 / CDN 直探共用) ============

async function fetchText(url, timeoutMs = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      cache: 'no-store',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/json,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

// ============ 基地址解析(发布页→中转页→最新地址) ============

// 模块级基址缓存:{bases, at}
let baseCache = { bases: null, at: 0 };

// 页面 JS 跳转目标:location.href=… 或 meta refresh
const extractRedirect = (html) =>
  (html.match(/location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i) || [])[1]
  || (html.match(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']?\s*\d+\s*;\s*url\s*=\s*([^"'>\s]+)/i) || [])[1]
  || null;

// 中转页 var xxx=<JSON 字面量>;
function grabVar(html, name) {
  const m = html.match(new RegExp('var\\s+' + name + '\\s*=\\s*(\\[[\\s\\S]*?\\]|"(?:[^"\\\\]|\\\\.)*")\\s*;'));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

// domainsH5Codes 为 charCode 数组,逐项拼接
const decodeCodes = (codes) => (Array.isArray(codes) ? codes.map((c) => String.fromCharCode(c)).join('') : '');

// 发布页发现链本体(不读不写缓存;供 resolveBases 与域名刷新 refreshYueseDomains
// 共用);全部入口失败抛错
async function discoverBases() {
  for (const host of PUBLISH_ENTRIES) {
    try {
      let url = 'https://' + host + '/';
      for (let hop = 0; hop <= MAX_HOPS; hop++) {
        const r = await fetchText(url);
        const d = grabVar(r.text, 'domainsH5Codes');
        if (d) {
          const latest = d.map(decodeCodes).filter(Boolean);
          if (latest.length) {
            return latest.map((u) => String(u).replace(/\/+$/, ''));
          }
        }
        const next = extractRedirect(r.text);
        if (!next) break;
        url = next;
      }
    } catch (e) { /* 换下一发布页入口 */ }
  }
  throw new Error('月色发布页解析失败(可设置环境变量 YS_API_TARGET 手动指定基址)');
}

// 返回最新基址数组(如 ['https://ys.xxx.icu', ...]):环境变量直连 / 缓存命中 /
// 发现链三层;发现成功写入 baseCache(既有 10 分钟懒缓存机制不变)
async function resolveBases() {
  if (process.env.YS_API_TARGET) return [String(process.env.YS_API_TARGET).replace(/\/+$/, '')];
  if (Array.isArray(baseCache.bases) && baseCache.bases.length && Date.now() - baseCache.at < BASES_TTL) {
    return baseCache.bases;
  }
  const bases = await discoverBases();
  baseCache = { bases, at: Date.now() };
  return bases;
}

// 域名自动刷新(注册给 domain-refresh.js 调度):绕过缓存重跑发布页发现链,成功
// 覆写 baseCache(顺带续 BASES_TTL);失败保留旧值 fail-soft;环境变量直连时禁用;
// 新旧 bases 完全一致返回 changed:false
async function refreshYueseDomains() {
  if (process.env.YS_API_TARGET) return { changed: false };
  let bases;
  try { bases = await discoverBases(); } catch (e) { return { changed: false }; }
  const old = Array.isArray(baseCache.bases) && baseCache.bases.length ? baseCache.bases : null;
  baseCache = { bases, at: Date.now() };
  return { changed: !old || JSON.stringify(bases) !== JSON.stringify(old) };
}
registerRefresher('yuese', refreshYueseDomains);

// ============ AES 加解密与剥壳 ============

function dec(b64) {
  const d = crypto.createDecipheriv('aes-128-cbc', API_KEY, API_KEY);
  return Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]).toString('utf8');
}

function encBody(obj) {
  const c = crypto.createCipheriv('aes-128-cbc', API_KEY, API_KEY);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
  return JSON.stringify({ encrypt: 1, encryptData: ct.toString('base64') });
}

// 剥壳 + 解密:外层 {error,message,content};tags 等接口 content 内再嵌一层同构壳
function unwrap(j) {
  if (!j || j.error !== 0) throw new Error('接口 error=' + (j && j.error) + ' ' + ((j && j.message) || ''));
  let c = j.content;
  if (c && c.encrypt === 1 && typeof c.encryptData === 'string') c = JSON.parse(dec(c.encryptData));
  if (c && typeof c === 'object' && !Array.isArray(c) && c.error === 0 && 'content' in c) c = c.content;
  return c;
}

// ============ 请求底座(单次重试共 2 次,间隔 600ms——防请求风暴,勿加码) ============

async function fetchRetry(url, opts, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fetch(url, opts); }
    catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw lastErr;
}

// 按基址轮换的 API GET 单轮:HTTP≥400/网络错/非 JSON 换下一基址;
// 业务错(error!==0)与解密错换基址无意义,直接抛
async function apiRequestRound(path, { params, method = 'GET', bodyObj = null } = {}) {
  const bases = await resolveBases();
  const qs = params ? '?' + new URLSearchParams(params) : '';
  let lastErr = null;
  for (const base of bases) {
    try {
      const opts = {
        method,
        headers: { 'User-Agent': UA, 'Accept': 'application/json,*/*;q=0.8' },
        cache: 'no-store',
      };
      if (method === 'POST') {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = encBody(bodyObj);
      }
      const r = await fetchRetry(base + path + qs, opts);
      if (!r.ok) { lastErr = new Error('上游 HTTP ' + r.status + ' @' + base); continue; }
      const j = await r.json();
      if (j && j.error !== 0) throw new Error('月色接口 error=' + j.error + ' ' + (j.message || '') + ' @' + path);
      try { return unwrap(j); }
      catch (e) { throw new Error('月色解密失败(密钥可能已轮换):' + e.message); }
    } catch (e) {
      if (/月色接口|月色解密/.test(e.message)) throw e; // 业务/密钥错误换基址无意义
      lastErr = e;
    }
  }
  throw lastErr || new Error('月色全部基址不可达');
}

// API 请求入口(基址解析失败/全部基址不可达的失败钩子):非业务错先 urgent 刷新
// 入口域名(单站 60s 冷却/在途共享,见 domain-refresh.js),changed 则原请求重试
// 一轮(每请求至多一次 urgent 重试);业务/解密错不经过此钩子,正常请求逻辑零改动
async function apiRequest(path, opts = {}) {
  try {
    return await apiRequestRound(path, opts);
  } catch (e) {
    if (/月色接口|月色解密/.test(e.message)) throw e;
    try {
      const r = await requestUrgentRefresh('yuese');
      if (r.changed) return await apiRequestRound(path, opts);
    } catch (e2) { /* urgent 刷新自身异常按未变更处理 */ }
    throw e; // 仍失败抛原错误
  }
}

const apiGet = (path, params) => apiRequest(path, { params });
const apiPost = (path, bodyObj) => apiRequest(path, { method: 'POST', bodyObj });

// detail 专用:GET 形态 video_url 常为空 → 自动补一发 POST 加密体形态,
// 有签名直链则合并返回(多形态回退封装在服务端)
async function fetchDetailRaw(vid) {
  let d = await apiGet('/api/videos/detail', { id: vid });
  if (d && !d.video_url) {
    try {
      const d2 = await apiPost('/api/videos/detail', { id: vid });
      if (d2 && d2.video_url) d = { ...d, ...d2 };
    } catch (e) { /* POST 形态失败保持 GET 结果 */ }
  }
  return d;
}

// .aes 图片解密:前 16 字节 IV + AES-128-CBC 密文 → 明文 JPEG Buffer。
// 超时 15s 必须有(2026-10-06 卡死事故根因):图床在并发突发/隧道拥塞下会把
// 请求排队 30~90s,无超时的挂起 fetch 会一直占住浏览器同源(HTTP/1.1,6 连接
// 上限)的连接槽,同源全部 /api/* 数据请求被压死,页面整体卡死。超时后走 502,
// 卡片侧 onError 落 Film 占位图;封面非关键数据,不做重试(重试只会加剧排队)。
// 同键并发去重/解密结果缓存不在插件层做,统一内聚在 /api/img 代理路由。
async function ysImgDecrypt(u) {
  const r = await fetch(u, {
    cache: 'no-store',
    signal: AbortSignal.timeout(IMG_TIMEOUT_MS),
    headers: { 'User-Agent': UA, 'Accept': 'image/*,*/*;q=0.8' },
  });
  if (!r.ok) throw new Error('图片 HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length <= 16) throw new Error('图片体过短');
  const d = crypto.createDecipheriv('aes-128-cbc', IMG_KEY, buf.subarray(0, 16));
  return Buffer.concat([d.update(buf.subarray(16)), d.final()]);
}

// ============ 归一化(上游字段 → 前端契约,白名单构造,社交付费字段一律不带) ============

// 月色图源为 .aes 加密图,必须走服务端解密代理
const imgProxy = (u) => (u ? '/api/img/yuese?u=' + encodeURIComponent(u) : '');

function normItem(v) {
  if (!v || v.video_id == null) return null;
  return {
    id: v.video_id,
    title: String(v.title || ''),
    cover: imgProxy(v.video_img),
    duration: Number(v.duration) || null,
    hd: !!v.is_hd,
  };
}

// 分页信封 {data,current_page,last_page,total} → ListResult
function normList(x) {
  const arr = x && Array.isArray(x.data) ? x.data : [];
  const page = x && Number(x.current_page) > 0 ? Number(x.current_page) : 1;
  const last = x && Number(x.last_page) > 0 ? Number(x.last_page) : page;
  return { items: arr.map(normItem).filter(Boolean), page, hasMore: page < last };
}

// 公告可能是字符串或 {content} HTML:剥标签取纯文本,取不到给 ''
function noticeText(n) {
  if (!n) return '';
  const raw = typeof n === 'string' ? n : (n && typeof n.content === 'string' ? n.content : '');
  return raw.replace(/<[^>]+>/g, '').trim();
}

// ============ 插件类 ============

export class YuesePlugin extends SitePlugin {
  get id() { return 'yuese'; }
  get name() { return '月色'; }
  get capabilities() { return { home: true, hotwords: true, tags: true, dvds: true, bytag: true, sort: true }; }

  async list(o = {}) {
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 24);
    const sort = SORTS.includes(o.sort) ? o.sort : 'post_date';
    const params = { page, size, sort };
    // 注意:上游分类参数名是复数 categories(单数会被服务端忽略变成全库)
    if (o.category != null && o.category !== '') params.categories = o.category;
    return normList(await apiGet('/api/videos/index', params));
  }

  async search(kw, o = {}) {
    const k = String(kw || '').trim();
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 10);
    if (!k) return { items: [], page: 1, hasMore: false };
    // 注意:上游搜索参数名是单数 keyword(复数会被静默忽略变全库)
    return normList(await apiGet('/api/videos/search', { keyword: k, page, size }));
  }

  async categories() {
    const x = await apiGet('/api/videos/classification');
    if (!Array.isArray(x)) return [];
    return x
      .filter((c) => c && c.category_id != null)
      .map((c) => ({ id: String(c.category_id), name: String(c.title || ''), count: Number(c.total_videos) || 0 }));
  }

  async tags() {
    const x = await apiGet('/api/videos/tags');
    if (!Array.isArray(x)) return [];
    return x
      .filter((t) => t && t.tag_id != null)
      .map((t) => ({ id: String(t.tag_id), name: String(t.tag || ''), count: Number(t.total_videos) || 0 }));
  }

  async home() {
    const x = (await apiGet('/api/videos/index_byall')) || {};
    // 导航:按 display_order 排序,过滤掉无 category_id 的项(如纯链接位)
    const nav = (Array.isArray(x.nav_list) ? x.nav_list : [])
      .filter((it) => it && it.category_id != null && it.category_id !== '')
      .slice()
      .sort((a, b) => (Number(a.display_order) || 0) - (Number(b.display_order) || 0))
      .map((it) => ({ id: String(it.category_id), title: String(it.title || '') }));
    return { notice: noticeText(x.notice), nav, list: normList(x.list_new) };
  }

  async hotwords() {
    const x = await apiGet('/api/videos/search_keywords');
    // 站方固定热词榜:数组则逐项取字符串过滤空,其他形态一律回 []
    if (!Array.isArray(x)) return [];
    return x
      .map((v) => String(v == null ? '' : v))
      .filter((s) => s && s !== '[object Object]');
  }

  async detail(id) {
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('月色 detail 缺少有效视频 id');
    const d = await fetchDetailRaw(vid);
    if (!d) throw new Error('月色 detail 无数据 id=' + vid);
    // 标签项可能是 {tag,tag_id} 或纯字符串,统一 {id:字符串|null, name}
    const tags = (Array.isArray(d.tags) ? d.tags : [])
      .map((t) => {
        if (typeof t === 'string') return { id: null, name: t };
        return { id: t && t.tag_id != null ? String(t.tag_id) : null, name: String((t && t.tag) || '') };
      })
      .filter((t) => t.name);
    const categories = (Array.isArray(d.categories) ? d.categories : [])
      .map((c) => ({ id: String(c && c.category_id), name: String((c && (c.title || c.name)) || '') }))
      .filter((c) => c.name);
    // 白名单构造:favourites/likes/dislikes/vip_required 等社交付费字段一律不带出
    return {
      id: d.video_id != null ? d.video_id : vid,
      title: String(d.title || ''),
      cover: imgProxy(d.video_img),
      duration: Number(d.duration) || null,
      hd: !!d.is_hd,
      resolution: d.file_dimensions ? String(d.file_dimensions) : '',
      uploadDate: String(d.post_date || d.created_at || d.upload_date || ''),
      tags,
      categories,
    };
  }

  async related(id, o = {}) {
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('月色 related 缺少有效视频 id');
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 8);
    return normList(await apiGet('/api/videos/related', { id: vid, page, size }));
  }

  async dvds(o = {}) {
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 24);
    const x = (await apiGet('/api/videos/dvds', { page, size })) || {};
    const arr = Array.isArray(x.data) ? x.data : [];
    const cur = Number(x.current_page) > 0 ? Number(x.current_page) : page;
    const last = Number(x.last_page) > 0 ? Number(x.last_page) : cur;
    return {
      items: arr
        .filter((v) => v && v.dvd_id != null)
        .map((v) => ({
          id: String(v.dvd_id),
          title: String(v.title || ''),
          cover: imgProxy(v.cover),
          count: Number(v.total_videos) || 0,
        })),
      page: cur,
      hasMore: cur < last,
    };
  }

  async bydvd(dvd, o = {}) {
    const did = parseInt(dvd, 10);
    if (!Number.isFinite(did) || did <= 0) throw new Error('月色 bydvd 缺少有效专辑 id');
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 10);
    // 上游按专辑取视频默认 sort=title_asc
    return normList(await apiGet('/api/videos/list_bydvd', { dvd_id: did, page, size, sort: 'title_asc' }));
  }

  async bytag(tag, o = {}) {
    const tid = parseInt(tag, 10);
    if (!Number.isFinite(tid) || tid <= 0) throw new Error('月色 bytag 缺少有效标签 id');
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 10);
    // 上游参数名 tags,传标签 ID
    return normList(await apiGet('/api/videos/list_bytags', { tags: tid, page, size }));
  }

  async resolvePlay(id) {
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('月色 resolvePlay 缺少有效视频 id');
    // ① CDN 公式直探(Bunny urlset 母带,m3u8 文本以 #EXTM3U 开头)
    const cdn = 'https://yuese.b-cdn.net/hls/contents/videos/' + Math.floor(vid / 1000) * 1000
      + '/' + vid + '/,' + vid + '.mp4,.urlset/master.m3u8';
    try {
      const r = await fetchText(cdn, 12000);
      if (r.status < 400 && r.text.trimStart().startsWith('#')) {
        return { type: 'hls', url: cdn, via: 'cdn' };
      }
    } catch (e) { /* 落 detail 形态 */ }
    // ② detail 签名直链嗅探:流式读首块即断,按首字符/URL 形态判型
    const d = await fetchDetailRaw(vid);
    if (d && d.video_url) {
      const t = await sniffUrlType(d.video_url);
      if (t) return { type: t, url: d.video_url, via: 'detail' };
    }
    throw new Error('月色视频 ' + vid + ' 无可用播放地址');
  }

  // 域名自动刷新(可选能力,契约见 base.js):手动触发一次发布页发现链;
  // domain-refresh.js 的周期轮与 urgent 触发亦走同一函数;YS_API_TARGET 有值时为 no-op
  async refreshDomains() { return refreshYueseDomains(); }

  // 静态图片能力:供 /api/img/yuese 代理调用,返回明文 JPEG Buffer
  async image(u) {
    if (!/^https?:\/\//.test(u || '')) throw new Error('月色图片代理需要合法 http(s) 地址');
    return ysImgDecrypt(u);
  }
}

// 流式嗅探:fetch 读首块即 abort(不下载整个文件);
// 首字符 '#' → hls;否则按 URL 是否 .m3u8 结尾判型;网络失败返回 null
async function sniffUrlType(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ac.signal, cache: 'no-store', headers: { 'User-Agent': UA, 'Accept': '*/*' } });
    if (!r.ok || !r.body) return null;
    const reader = r.body.getReader();
    let head = '';
    try {
      const { value } = await reader.read();
      if (value && value.length) head = Buffer.from(value).toString('latin1');
    } finally {
      try { ac.abort(); } catch (e) { /* 忽略中止异常 */ }
      try { reader.cancel(); } catch (e) { /* 忽略取消异常 */ }
    }
    if (head.startsWith('#')) return 'hls';
    return /\.m3u8(\?|#|$)/.test(url) ? 'hls' : 'mp4';
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
