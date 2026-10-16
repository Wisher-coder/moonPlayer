// ============================================================
// plugin.js —— 资源站(Apple CMS V10 采集接口)通用插件工厂(仅 Node 服务端运行)
//
// 与传统插件「一文件一站点一实例」不同:本模块按清单条目批量生成插件实例,
// 由 ./index.js 的 buildCmsPlugins() 以【插件数组】形式交给 registry 动态合并。
// 上游为 MacCMS10 标准 json 采集接口(api.php/provide/vod),2026-10-06 以
// 360资源/鸭鸭/大地实测:
//   · ?ac=list → {code:1,msg,page,pagecount,limit,total,class,list};
//     class:[{type_id,type_pid,type_name}] 天然两级分类树;list 为简条(无 vod_pic),
//     故列表页一律走 ac=videolist(全字段条目,含 vod_pic);
//   · ?ac=videolist&pg=&t=&wd=&ids= → 全字段:vod_id/vod_name/vod_pic/vod_class/
//     vod_version/vod_time/vod_duration(分钟数或空)/vod_play_url;
//     个别站 videolist 不认 ids → 回退 ?ac=detail&ids=(同一响应形态);
//   · vod_play_url 形如「第01集$https://x/index.m3u8#第02集$…」,多播放源以
//     $$$ 分隔(vod_play_from 同步分隔),取首个含 http(s)/根相对直链的源;
//     无 '$' 的裸地址形态(json.php 系与部分 api.php 站)按整段即地址收下;
//   · 上游形态差异(盾/XML/协议)统一沉淀在 ./upstream.js,本文件只认信封;
//   · 播放链路:清单/切片所在 CDN 普遍无 ACAO(或带 Referer 校验)→ 全服务端
//     中转:playlist() 取上游 m3u8 文本后重写——变体(子清单)行铸令牌回本
//     playlist 代理递归重写,切片/密钥行改走 /seg 代理;seg 仅放行本站清单
//     出现过的主机(防开放代理),Range 透传;.mp4 直链 video 标签免代理直连;
//   · 多集片:detail.packageId = 自身 vod_id,videoPackage() 吐剧集片单
//     (条目 id 形如 vid-epN——'-' 在全站 id 合法字符集内,观看页校验直过),
//     复用观看页选集面板(资源站面板 tag=「剧集」)与连播队列,零契约改动。
//
// 健康上报:上游网络错/超时/HTTP≥400/非 JSON 连续 2 次 → markFailure 摘除
// (下轮探测或复探恢复);任何成功 → markSuccess(复位计数,摘除态触发单站复探)。
// 例外:502/503/504 为「服务端临时忙」不属站点故障,不掷连败计数(摘除仍由
// 30min 探测把关,不会因此漏摘真死站)。
//
// 上游抓取(2026-10-06 起)统一走 ./upstream.js:盾站自动过盾(奥斯卡 418)、
// XML 站 RSS 同形解析(大地/色猫)、https 连接失败自动降级 http(百花)——三类
// 站点差异在那一层抹平,本文件的 _get/playlist 只认「信封」与「文本」。
// ============================================================
import { SitePlugin } from '../base.js';
import { macCmsRequest, requestUpstream, effectiveUrl, UA } from './upstream.js';

const TIMEOUT_MS = 15000;       // 上游接口超时(与全站一致)
const SEG_TIMEOUT_MS = 30000;   // 切片流超时(大切片,放宽)
const FAIL_LIMIT = 2;           // 连续失败 N 次上报摘除(下轮探测恢复)
const CATS_TTL = 10 * 60 * 1000;      // 分类树缓存
const RAW_TTL = 5 * 60 * 1000;        // vod 原始数据缓存(detail/related/play 共享)
const RAW_CACHE_MAX = 120;
const PLS_CACHE_MAX = 60;       // 重写后清单文本缓存
const TOKEN_TTL = 30 * 60 * 1000;     // 子清单令牌有效期
const TOKEN_MAX = 400;
const SEG_HOST_TTL = 6 * 60 * 60 * 1000; // seg 主机白名单登记有效期
const HD_RE = /(高清|蓝光|4K|1080|720|HD)/i;

// ============ id 派生(api 主机 → 稳定 slug) ============

export function hostOf(api) {
  try { return new URL(api).hostname; } catch (e) { return String(api); }
}
export function slugify(host) {
  return String(host).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'site';
}

// ============ 模块级共享缓存(键均带站点 id,多插件实例共用) ============

const rawCache = new Map();   // siteId:vid → {v, at} 原始 vod 条目
const plsCache = new Map();   // siteId:url → {text, at} 重写后的清单文本
const plsTokens = new Map();  // siteId:token → {url, at} 子清单令牌(主清单变体行铸造)
const segAllow = new Map();   // siteId|host → exp(seg 放行主机白名单)

function trimCache(map, max) {
  if (map.size <= max) return;
  let oldest = null; let oldestAt = Infinity;
  for (const [k, e] of map) if (e.at < oldestAt) { oldestAt = e.at; oldest = k; }
  if (oldest !== null) map.delete(oldest);
}

function mintToken(siteId, url) {
  const t = Math.random().toString(36).slice(2, 10);
  plsTokens.set(siteId + ':' + t, { url, at: Date.now() });
  if (plsTokens.size > TOKEN_MAX) {
    const now = Date.now();
    for (const [k, e] of plsTokens) if (now - e.at > TOKEN_TTL) plsTokens.delete(k);
    if (plsTokens.size > TOKEN_MAX) plsTokens.delete(plsTokens.keys().next().value);
  }
  return t;
}
function tokenTake(siteId, t) {
  const e = plsTokens.get(siteId + ':' + t);
  if (!e || Date.now() - e.at > TOKEN_TTL) throw new Error('播放清单令牌无效或已过期');
  return e.url;
}
function allowSegHost(siteId, host) { segAllow.set(siteId + '|' + host, Date.now() + SEG_HOST_TTL); }
function segHostAllowed(siteId, host) {
  const exp = segAllow.get(siteId + '|' + host);
  return exp != null && Date.now() < exp;
}

// ============ 归一化小工具 ============

// 视频条目 id:vid 或合成集 vid-epN(多集片选集面板/连播队列的条目形态;
// '-epN' 后缀用 '-' 连接——全站 id 合法字符集直过,前端无需任何适配;
// '~epN' 为同义旧形态,播放器还挂着的旧清单 URL 仍可解析)
function parseVid(id) {
  const m = String(id || '').match(/^(.+)[~-]ep(\d+)$/);
  if (m) return { vid: m[1], ep: parseInt(m[2], 10) || 1 };
  return { vid: String(id || ''), ep: 0 };
}

// vod_duration:MacCMS 惯例存分钟数;个别站存 hh:mm:ss / mm:ss → 一并换算成秒
function parseDur(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  let m = t.match(/^(\d{1,3}):(\d{2}):(\d{2})$/);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  m = t.match(/^(\d{1,3}):(\d{2})$/);
  if (m) return +m[1] * 60 + +m[2];
  m = t.match(/^(\d+(?:\.\d+)?)\s*分钟$/);
  if (m) return Math.round(parseFloat(m[1]) * 60);
  const n = parseInt(t, 10);
  if (Number.isFinite(n) && n > 0) return n * 60; // 纯数字视为分钟
  return null;
}

// vod_class 逗号串 → 标签(资源站标签不可链,id 置 null,前端按字渲染不深链)
function parseClassTags(s) {
  return String(s || '').split(/[,，、]/).map((x) => x.trim()).filter(Boolean).slice(0, 12)
    .map((t) => ({ id: null, name: t }));
}
const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();

// 相对地址绝对化(协议相对 //、根相对 /、路径相对均按 base 归一)
function absUrl(u, base) {
  const s = String(u || '').trim();
  if (!s) return s;
  try {
    if (s.startsWith('//')) return 'https:' + s;
    return new URL(s, base).href;
  } catch (e) { return s; }
}

// vod_play_url → 剧集表($$$ 拆源、# 拆集、$ 拆名/地址)。多播放源优选:
// 含 .m3u8 直链的源最优先(浏览器 hls 可直接消费),次 .mp4,再次任意
// http 直链——部分站第一源是无扩展的播放器页(如实测光速 gsyun 源
// /play/{id},抓下来是 HTML 非 m3u8),不能按「首个 http 源」盲取。
// 另:json.php 系与部分 api.php 站(实测清水源/美少女/香系源/X色A-V/白嫖/
// 湿乐园)vod_play_url 是【裸地址无 label$】——整段即播放地址,早期严格按
// '$' 切分会把这类片全判成「无可用播放地址」;此处对无 '$' 段做地址形态
// 识别后原样收下并给合成集名,非地址形态(纯文字噪音)仍丢弃。
function pickEpisodes(v) {
  const raw = String((v && v.vod_play_url) || '');
  if (!raw.trim()) return { src: '', list: [] };
  const srcNames = String((v && v.vod_play_from) || '').split('$$$');
  const groups = raw.split('$$$');
  const parsed = [];
  for (let i = 0; i < groups.length; i++) {
    const list = [];
    for (const part of String(groups[i] || '').split('#')) {
      const seg = part.trim();
      if (!seg) continue;
      const d = seg.indexOf('$');
      if (d < 0) {
        if (/^(https?:)?\/\//i.test(seg) || /^[^\s]+\.(m3u8|mp4)(\?|$)/i.test(seg)) {
          list.push({ label: '第' + (list.length + 1) + '集', url: seg });
        }
        continue;
      }
      const label = seg.slice(0, d).trim() || '第' + (list.length + 1) + '集';
      const url = seg.slice(d + 1).trim();
      if (!url) continue;
      list.push({ label, url });
    }
    if (list.length) parsed.push({ src: (srcNames[i] || '').trim(), list });
  }
  if (!parsed.length) return { src: '', list: [] };
  const rank = (g) => {
    if (g.list.some((e) => /\.m3u8(\?|$)/i.test(e.url))) return 0;
    if (g.list.some((e) => /\.mp4(\?|$)/i.test(e.url))) return 1;
    return g.list.some((e) => /^(https?:)?\//.test(e.url)) ? 2 : 3;
  };
  parsed.sort((a, b) => rank(a) - rank(b)); // Array.sort 稳定,同档保持源序
  return parsed[0];
}

// m3u8 文本重写:URI 行 → seg 代理;子清单(变体)行 → 令牌回 playlist 代理;
// 标签行内 URI="…"(密钥/fMP4 init)同走 seg。涉及主机全部登记 seg 白名单。
function rewriteM3u8(siteId, text, baseUrl) {
  const proxySeg = (u) => {
    const abs = absUrl(u, baseUrl);
    try { allowSegHost(siteId, new URL(abs).hostname); } catch (e) { /* 畸形地址留给后续报错 */ }
    return '/api/' + siteId + '/seg?u=' + encodeURIComponent(abs);
  };
  const proxyPls = (u) => {
    const abs = absUrl(u, baseUrl);
    return '/api/' + siteId + '/playlist?id=t%3A' + mintToken(siteId, abs);
  };
  const out = [];
  let prevTag = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) { out.push(raw); prevTag = ''; continue; }
    if (line.startsWith('#')) {
      out.push(/URI="[^"]+"/.test(line)
        ? raw.replace(/URI="([^"]+)"/, (_s, u) => 'URI="' + proxySeg(u) + '"')
        : raw);
      prevTag = line;
      continue;
    }
    // 变体判定:紧跟 #EXT-X-STREAM-INF 的 URI 行,或自身即 .m3u8(媒体清单直引形态)
    const isVariant = prevTag.startsWith('#EXT-X-STREAM-INF') || /\.m3u8(\?|$)/i.test(line);
    out.push(isVariant ? proxyPls(line) : proxySeg(line));
    prevTag = '';
  }
  return out.join('\n');
}

// ============ 插件类(每资源站一个实例) ============

export class CmsPlugin extends SitePlugin {
  constructor(entry, id, hooks = {}) {
    super();
    this.entry = entry;          // 清单条目 {name, api, uptime, speed, totalResources}
    this.api = entry.api;
    this._id = id;
    this._name = entry.name;
    this.hooks = hooks;
    this._fails = 0;             // 连续失败计数(成功清零)
    this._cats = null;
    this._catsAt = 0;
    try { const u = new URL(this.api); this.origin = u.origin; this.apiHost = u.hostname; } catch (e) { this.origin = ''; this.apiHost = ''; }
  }

  // 地址归一基准:生效协议(http 降级站学到的偏好)——相对封面/相对播放地址
  // 绝对化一律用它,不直接用清单声明的 api(那可能是打不开的 https)
  get base() { return effectiveUrl(this.api); }

  // 上游 Referer:跟随生效协议(base 的 origin),防「https 声明 + http 实抓」
  // 时带错协议头被上游拒
  get referer() {
    try { return new URL(this.base).origin + '/'; } catch (e) { return this.origin ? this.origin + '/' : ''; }
  }

  get id() { return this._id; }
  get name() { return this._name; }
  // 资源站只有「列表/搜索/分类/详情/播放」基础面:无聚合首页/热词/标签榜/排序档;
  // cms:true 供前端识别分组(片源列表「资源站」折叠节)
  get capabilities() { return { home: false, hotwords: false, tags: false, dvds: false, bytag: false, sort: false, cms: true }; }

  // —— 健康上报:连续 FAIL_LIMIT 次失败摘除;任何成功复位(摘除态触发单站复探)
  _fail() {
    this._fails += 1;
    if (this._fails >= FAIL_LIMIT && this.hooks.markFailure) { try { this.hooks.markFailure(this._id); } catch (e) { /* 上报失败不影响主流程 */ } }
  }
  _ok() {
    this._fails = 0;
    if (this.hooks.markSuccess) { try { this.hooks.markSuccess(this._id); } catch (e) { /* 同上 */ } }
  }

  // MacCMS 统一 GET(JSON 或 RSS 同形信封;upstream 层负责过盾/协议降级):
  // code!==1 / 非 JSON-RSS / HTTP 状态错 / 网络错一律抛,并计入失败
  async _get(params) {
    let j;
    try {
      j = await macCmsRequest(this.api, params, {
        referer: this.referer,
        timeoutMs: TIMEOUT_MS,
      });
    } catch (e) {
      const kind = e && e.kind;
      // 502/503/504 = 服务端临时忙(实测爱奇艺突发 503),不计连败防误摘
      if (kind === 'http' && e.status >= 502) throw new Error(this._name + ' 接口 HTTP ' + e.status + '(服务端临时不可用)');
      this._fail();
      if (kind === 'network') throw new Error(this._name + ' 接口不可达(' + (e.timeout ? '超时' : (e.message || '网络错误')) + ')');
      if (kind === 'http') throw new Error(this._name + ' 接口 HTTP ' + e.status);
      if (kind === 'waf') throw new Error(this._name + ' 接口盾拦截(' + e.message + ')');
      throw new Error(this._name + ' 接口非 JSON 响应');
    }
    if (!j || Number(j.code) !== 1) {
      this._fail();
      throw new Error(this._name + ' 接口 code=' + (j && j.code) + ' ' + String((j && j.msg) || ''));
    }
    this._ok();
    return j;
  }

  // 条目归一化:cover 绝对化(部分站 vod_pic 为根相对路径;base 走
  // effectiveUrl——http-only 站(百花)相对封面不能拼回 https)
  _normItem(v) {
    if (!v || v.vod_id == null) return null;
    return {
      id: String(v.vod_id),
      title: String(v.vod_name || ''),
      cover: absUrl(v.vod_pic, this.base),
      duration: parseDur(v.vod_duration),
      hd: HD_RE.test(String(v.vod_version || '') + ' ' + String(v.vod_class || '')),
    };
  }

  // 响应信封 → ListResult(上游每页条数固定 ~20,size 参数不透传;hasMore 按 pagecount)
  _normList(j, page) {
    const arr = Array.isArray(j && j.list) ? j.list : [];
    const pc = parseInt(j && j.pagecount, 10) || 0;
    return { items: arr.map((v) => this._normItem(v)).filter(Boolean), page, hasMore: page < pc };
  }

  // vid → 原始 vod 条目(detail/related/resolvePlay/videoPackage 共享缓存);
  // 个别站 videolist 不认 ids(返回最新列表)→ 命不中回退 ac=detail
  async _rawById(vid) {
    const key = this._id + ':' + vid;
    const hit = rawCache.get(key);
    if (hit && Date.now() - hit.at < RAW_TTL) return hit.v;
    let v = null;
    try {
      const j = await this._get({ ac: 'videolist', ids: vid });
      const list = Array.isArray(j.list) ? j.list : [];
      v = list.find((x) => x && String(x.vod_id) === String(vid)) || null;
    } catch (e) { /* 回退 ac=detail 再试一次 */ }
    if (!v) {
      const j = await this._get({ ac: 'detail', ids: vid });
      const list = Array.isArray(j.list) ? j.list : [];
      v = list.find((x) => x && String(x.vod_id) === String(vid)) || list[0] || null;
    }
    if (!v) throw new Error(this._name + ' 查无此影片 id=' + vid);
    rawCache.set(key, { v, at: Date.now() });
    trimCache(rawCache, RAW_CACHE_MAX);
    return v;
  }

  // ============ 统一契约方法 ============

  async list(o = {}) {
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const p = { ac: 'videolist', pg: page };
    if (o.category != null && o.category !== '') p.t = String(o.category);
    return this._normList(await this._get(p), page);
  }

  async search(kw, o = {}) {
    const k = String(kw || '').trim();
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    if (!k) return { items: [], page: 1, hasMore: false };
    return this._normList(await this._get({ ac: 'videolist', wd: k, pg: page }), page);
  }

  // 分类树:class[] 按 type_pid 组两级(契约 children;脏数据孤儿子类平铺兜底)
  async categories() {
    if (this._cats && Date.now() - this._catsAt < CATS_TTL) return this._cats;
    const j = await this._get({ ac: 'list', pg: 1 });
    const cls = Array.isArray(j.class) ? j.class : [];
    const tops = [];
    const kidsByPid = new Map();
    for (const c of cls) {
      if (!c || c.type_id == null) continue;
      const node = { id: String(c.type_id), name: String(c.type_name || ''), count: 0 };
      const pid = Number(c.type_pid) || 0;
      if (!pid) tops.push(node);
      else {
        if (!kidsByPid.has(pid)) kidsByPid.set(pid, []);
        kidsByPid.get(pid).push(node);
      }
    }
    const topIds = new Set(tops.map((t) => Number(t.id)));
    const out = tops.map((t) => {
      const kids = kidsByPid.get(Number(t.id));
      return kids && kids.length ? { ...t, children: kids } : t;
    });
    for (const [pid, kids] of kidsByPid) if (!topIds.has(pid)) out.push(...kids);
    this._cats = out;
    this._catsAt = Date.now();
    return out;
  }

  async detail(id) {
    const { vid, ep } = parseVid(id);
    const v = await this._rawById(vid);
    const d = this._normItem(v);
    const eps = pickEpisodes(v);
    const idx = ep > 0 ? Math.min(ep, eps.list.length || 1) - 1 : 0;
    const cur = eps.list[idx];
    const out = {
      id: d.id,
      title: d.title + (eps.list.length > 1 && cur && cur.label ? ' · ' + cur.label : ''),
      cover: d.cover,
      duration: d.duration,
      hd: d.hd,
      resolution: String(v.vod_version || ''),
      uploadDate: String(v.vod_time || v.vod_pubdate || ''),
      tags: parseClassTags(v.vod_class),
      categories: v.type_id != null ? [{ id: String(v.type_id), name: String(v.type_name || '') }] : [],
    };
    // 多集片:借量贩选集面板(packageId → videoPackage 剧集片单),选集与连播零前端改动
    if (eps.list.length > 1 && /^\d+$/.test(String(vid))) out.packageId = Number(vid);
    return out;
  }

  // 剧集片单(全量无分页,形态同量贩包):条目 id 形如 vid-epN
  async videoPackage(id) {
    const { vid } = parseVid(id);
    const v = await this._rawById(vid);
    const d = this._normItem(v);
    const eps = pickEpisodes(v);
    return {
      id: /^\d+$/.test(String(vid)) ? Number(vid) : String(vid),
      title: d.title,
      description: stripHtml(v.vod_content).slice(0, 200),
      count: eps.list.length,
      items: eps.list.map((e, i) => ({ id: vid + '-ep' + (i + 1), title: e.label, cover: d.cover, duration: d.duration, hd: d.hd })),
    };
  }

  // 上游无相关推荐端点:同分类最新一页合成「猜你喜欢」,剔除自身
  async related(id, o = {}) {
    const { vid } = parseVid(id);
    const v = await this._rawById(vid);
    const size = Math.max(1, parseInt(o.size, 10) || 12);
    const p = { ac: 'videolist', pg: 1 };
    const t = v.type_id != null ? String(v.type_id) : '';
    if (t) p.t = t;
    const j = await this._get(p);
    const arr = (Array.isArray(j.list) ? j.list : [])
      .filter((x) => x && String(x.vod_id) !== String(vid))
      .slice(0, size);
    return { items: arr.map((x) => this._normItem(x)).filter(Boolean), page: 1, hasMore: false };
  }

  // 播放解析:取对应集直链——.mp4 原址直连(video 标签不受 CORS 限制);
  // 其余(m3u8/未知扩展)按 HLS 清单走本站 playlist 代理
  async resolvePlay(id) {
    const { vid, ep } = parseVid(id);
    const v = await this._rawById(vid);
    const eps = pickEpisodes(v);
    if (!eps.list.length) throw new Error(this._name + ' 影片 ' + vid + ' 无可用播放地址(可能已下架)');
    const idx = Math.min(Math.max(ep || 1, 1), eps.list.length) - 1;
    const u = absUrl(eps.list[idx].url, this.base);
    if (/\.mp4(\?|$)/i.test(u)) return { type: 'mp4', url: u, via: 'cms-mp4' };
    return { type: 'hls', url: '/api/' + this._id + '/playlist?id=' + encodeURIComponent(vid + '-ep' + (idx + 1)), via: 'cms-m3u8' };
  }

  // 播放清单文本:id 为 vid-epN(主清单)或 t:令牌(变体子清单,重写时铸造)。
  // 取上游文本 → 重写(变体回本代理、切片/密钥走 seg)→ 缓存重写结果。
  // 抓取走 upstream(清单主机也可能带盾/需协议降级),文本形态判定留在此处
  async playlist(id) {
    const s = String(id || '');
    if (!s) throw new Error(this._name + ' playlist 缺少 id');
    const target = s.startsWith('t:') ? tokenTake(this._id, s.slice(2)) : await this._playUrlOf(s);
    const ck = this._id + ':' + target;
    const hit = plsCache.get(ck);
    if (hit && Date.now() - hit.at < RAW_TTL) return hit.text;
    let r;
    try {
      r = await requestUpstream(target, {
        referer: this.referer,
        accept: '*/*',
        timeoutMs: TIMEOUT_MS,
      });
    } catch (e) {
      if (e && e.kind === 'network') throw new Error(this._name + ' 播放清单不可达(' + (e.timeout ? '超时' : (e.message || '网络错误')) + ')');
      if (e && e.kind === 'waf') throw new Error(this._name + ' 播放清单盾拦截(' + e.message + ')');
      throw new Error(this._name + ' 播放清单不可达(' + ((e && e.message) || '网络错误') + ')');
    }
    if (r.status >= 400) throw new Error(this._name + ' 播放清单 HTTP ' + r.status);
    const text = r.text;
    if (!text.trimStart().startsWith('#EXTM3U')) throw new Error(this._name + ' 播放清单内容非 m3u8');
    const out = rewriteM3u8(this._id, text, target);
    plsCache.set(ck, { text: out, at: Date.now() });
    trimCache(plsCache, PLS_CACHE_MAX);
    return out;
  }

  // vid-epN → 该集上游清单绝对地址
  async _playUrlOf(vidEp) {
    const { vid, ep } = parseVid(vidEp);
    const v = await this._rawById(vid);
    const eps = pickEpisodes(v);
    if (!eps.list.length) throw new Error(this._name + ' 影片 ' + vid + ' 无可用播放地址');
    const idx = Math.min(Math.max(ep || 1, 1), eps.list.length) - 1;
    return absUrl(eps.list[idx].url, this.base);
  }

  // 切片/密钥流式中转:供 /api/{site}/seg 调用;仅放行本站 api 域与清单出现过
  // 主机(重写时登记,6h 有效,命中续期)——防被当开放代理;Range 透传
  async seg(u, { range } = {}) {
    const abs = String(u || '');
    if (!/^https?:\/\//.test(abs)) throw new Error(this._name + ' seg 需要合法 http(s) 地址');
    let host;
    try { const x = new URL(abs); host = x.hostname; } catch (e) { throw new Error(this._name + ' seg 地址畸形'); }
    if (!segHostAllowed(this._id, host) && host !== this.apiHost) throw new Error(this._name + ' seg 拒绝未登记主机(防开放代理)');
    allowSegHost(this._id, host);
    const res = await fetch(abs, {
      cache: 'no-store',
      signal: AbortSignal.timeout(SEG_TIMEOUT_MS),
      headers: { 'User-Agent': UA, ...(this.referer ? { 'Referer': this.referer } : {}), ...(range ? { Range: range } : {}) },
    });
    return { status: res.status, contentType: res.headers.get('content-type') || 'application/octet-stream', contentRange: res.headers.get('content-range') || '', body: res.body };
  }
}

// 工厂入口:清单条目 → 插件实例(id 由 index.js 派生并保证唯一)
export function makeCmsPlugin(entry, id, hooks) {
  return new CmsPlugin(entry, id, hooks);
}
