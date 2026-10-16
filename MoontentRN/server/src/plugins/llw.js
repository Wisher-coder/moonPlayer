// ============================================================
// llw.js —— 萝莉窝插件(MacCMS 内核 HTML 抓取·形态 A 外部存储,仅 Node 服务端运行)
//
// 逆向结论(2026-10-06 授权测试环境实测,移植自 CLI 取证版 llw_api.js / llw.js):
//   · 与懂色帝(dsd 插件)同一套 MacCMS 源码:video-item 卡片 / vod/type 分类 /
//     search.html?wd= 搜索 / 播放页=详情页 /「猜你喜欢」相关区 / verify_token
//     挑战壳保险处理,页面解析同构;
//   · 媒体形态与 dsd 相反(形态 A):全挂外部存储 pp.{标识}.top:22200/{日期}/{随机8}/
//     (运营商标识轮换,从页面海报 URL 动态提取)——index.m3u8 主清单(单变体)→
//     hls/index.m3u8 子清单(随机名 .ts + hls/key.key 16B,AES-128-CBC,KEY 行无 IV
//     ⇒ 媒体序列号作 IV),部分片无 KEY 行(明文 TS);
//   · 唯一防线是【站群域 Referer 白名单】:清单/切片/密钥/海报不带 Referer 或带外部
//     Referer(如 localhost)一律 403,带 daga88n.com 系 Referer 全 200——零签名零
//     时效,服务端现取现带即过;⇒ 浏览器跨源直连不可用,媒体/封面全走服务端中转;
//   · 媒体目录无公式,但每片同页必有(与 dsd 同构三级):VIP 墙背景图 / 免费片
//     player_aaaa.url(绝对 index.m3u8,JSON 转义斜杠须还原)/ 猜你喜欢自片卡片;
//   · 发布面薄:无发布页/无 /goN;搜索框公布「永久网址 n744.com」(302 → 91117.top
//     「模拟地址栏」跳板页,非入口);入口轮换时只能换 LLW_BASE 环境变量指定。
// ============================================================
import { SitePlugin } from './base.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const FALLBACK_BASES = ['https://daga88n.com'];   // 实测入口(无发布页可解析,轮换时用 LLW_BASE 指定)
const PLAY_CACHE_MAX = 40;       // 播放清单文本缓存上限(重写为代理 URL 后无时效问题,可长存)
const TIMEOUT_MS = 15000;
// 导航类型表(顺序即站内导航顺序)
const TYPE_NAMES = { 122: '强烈推荐', 64: '萝莉', 113: '国外萝莉', 67: '乱伦', 66: '人兽', 65: '猎奇' };
// pp 外部存储主机形态(pp.{标识}.top:22200)——seg/图片代理放行判定用(防开放代理)
const PP_HOST_RE = /^pp\.[a-z0-9.-]+:\d{2,5}$/i;

// ============ HTTP 底座(cookie jar + verify_token 挑战自动过 + Referer 白名单) ============

const jar = new Map(); // name → value(Set-Cookie 增量合并,进程存活期内保活 verify_token)
const cookieHeader = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');

function absorbSetCookie(res) {
  for (const line of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
    const [kv] = line.split(';');
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}

// 基地址:环境变量 LLW_BASE 优先(无发布页可解析,入口轮换只能显式指定)
async function resolveBases() {
  if (process.env.LLW_BASE) return [String(process.env.LLW_BASE).replace(/\/+$/, '')];
  return FALLBACK_BASES;
}

// 基本请求:浏览器头 + jar cookie + 显式 Referer(pp 存储系全链只认站群域 Referer)
async function http(url, base, { range } = {}) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/vnd.apple.mpegURL,image/*,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': base + '/',
  };
  const ck = cookieHeader();
  if (ck) headers['Cookie'] = ck;
  if (range) headers['Range'] = range;
  const res = await fetch(url, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS), headers });
  absorbSetCookie(res);
  return res;
}

// 页面获取(跟 301/302 共 6 跳;verify_token 挑战页自动过门:写 cookie → 原地重取一次)
async function fetchPage(path) {
  const bases = await resolveBases();
  let lastErr = null;
  for (const base of bases) {
    let cur = path.startsWith('http') ? path : base + path;
    try {
      for (let hop = 0; hop < 6; hop++) {
        const res = await http(cur, base);
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          cur = new URL(res.headers.get('location'), cur).href;
          continue;
        }
        const text = await res.text();
        // 挑战壳判定:仅 ~117B 的 verify_token 门
        if (/document\.cookie\s*=\s*"verify_token=pass/.test(text) && text.length < 512) {
          jar.set('verify_token', 'pass');
          continue;
        }
        if (res.status >= 400) { lastErr = new Error('上游 HTTP ' + res.status + ' @' + base); break; }
        return { status: res.status, base, url: cur, text };
      }
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('llw 全部基址不可达');
}

// ============ 页面解析器(卡片/详情/相关) ============

// 展示时长串("58:26"/"1:23:45")→ 秒;解析失败给 null
function parseDurStr(s) {
  const m = String(s || '').trim().match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return null;
  if (m[3] !== undefined) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  return (+m[1]) * 60 + (+m[2]);
}

// 列表卡片:<a href=…/vod/play/id/{id}/… class="video-item"> → id/标题/时长/海报
function parseCards(html) {
  const hrefs = [...html.matchAll(/<a href="\/index\.php\/vod\/play\/id\/(\d+)\/sid\/1\/nid\/1\.html" class="video-item">/g)];
  const blocks = html.split(/<a href="\/index\.php\/vod\/play\/id\/\d+\/sid\/1\/nid\/1\.html" class="video-item">/).slice(1);
  return hrefs.map((h, i) => {
    const b = blocks[i] || '';
    return {
      id: +h[1],
      title: (b.match(/<div class="video-desc[^>]*>([^<]*)</) || [, ''])[1].trim(),
      duration: (b.match(/video-item-tag-duration">([^<]*)</) || [, ''])[1].trim(),
      thumb: (b.match(/data-src="([^"]+)"/) || [, ''])[1],
    };
  }).filter((c) => c.id && c.title);
}

// 相关/猜你喜欢卡片:dl 列表与 li.madou1 两种同构形态
function parseRelated(html) {
  const out = [];
  const parts = html.split(/<a href="(\/index\.php\/vod\/play\/id\/(\d+)\/sid\/1\/nid\/1\.html)">/);
  for (let i = 1; i + 1 < parts.length; i += 3) {
    const id = +parts[i + 1];
    const b = parts[i + 2].slice(0, 800);
    if (!/<dt>|class="thumb"/.test(b)) continue;   // 只认 dl/li 卡片结构,防误收页内其他锚点
    out.push({
      id,
      title: (b.match(/<h[23][^>]*>([^<]*)</) || [, ''])[1].trim(),
      duration: (b.match(/class="duration">([^<]*)</) || [, ''])[1].trim(),
      thumb: (b.match(/data-src="([^"]+)"/) || [, (b.match(/src="(https?:\/\/pp\.[^"]+)"/) || [, ''])[1]])[1],
    });
  }
  return out.filter((c) => c.id && c.title);
}

// 播放页(=详情页)解析
function parseDetail(html) {
  const d = {};
  d.title = (html.match(/<h2 class="ellipsis">([^<]*)</) || [, (html.match(/<title>([^<]*) - /) || [, ''])[1].trim()])[1].trim();
  d.desc = (html.match(/<div class="desc">([\s\S]*?)<\/div>/) || [, ''])[1].replace(/<[^>]*>/g, '').trim();
  d.tags = [...html.matchAll(/\/index\.php\/vod\/search\/tag\/([^".]+?)(?:\.html)?"/g)].map((m) => decodeURIComponent(m[1]));
  d.vip = /VIP会员专享/.test(html);
  // 内联播放配置:player_aaaa 内的 pp 存储形态 url(JSON 转义斜杠先还原再锚定)
  d.playerUrl = [...html.matchAll(/"url":"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1].replace(/\\\//g, '/'))
    .find((u) => /^https?:\/\/pp\.[a-z0-9.-]+:\d+\/.*index\.m3u8/i.test(u)) || '';
  d.wallBg = (html.match(/video-before-ad[^"]*"[^>]*style="background-image:\s*url\(([^)]+)\)/) || [, ''])[1];
  d.guessLove = parseRelated(html.split('guess-love-wrap').pop() || '');
  return d;
}

// 媒体目录推导(三级来源:VIP墙背景图 → player_aaaa.url → 猜你喜欢自片卡片)
// 形态 A 三处均为 absolute pp URL,统一去尾文件名即目录
function resolveDir(html, vid) {
  const d = parseDetail(html);
  const trim = (u) => (u ? u.replace(/\/[^/]+$/, '') : '');
  if (d.wallBg && /\/pp\.[a-z0-9.-]+:\d+\//i.test(d.wallBg)) return { base: trim(d.wallBg), src: 'wall' };
  if (d.playerUrl) return { base: trim(d.playerUrl), src: 'player' };
  const self = d.guessLove.find((g) => g.id === vid && /\/pp\.[a-z0-9.-]+:\d+\//i.test(g.thumb));
  if (self) return { base: trim(self.thumb), src: 'guess' };
  return null;
}

// ============ 媒体面(主清单→子清单,绝对化;全链仅站群域 Referer 校验) ============

// 真实清单直取:主清单(master 单变体)→ 选最高 BANDWIDTH 变体 → 子清单;
// 返回切片/KEY 绝对化后的子清单文本(相对 KEY/切片按子清单目录绝对化)
async function fetchPls(base, dirUrl) {
  const r1 = await http(dirUrl + '/index.m3u8', base);
  const t1 = await r1.text();
  if (r1.status >= 400 || !t1.startsWith('#EXTM3U'))
    throw new Error('主清单 HTTP ' + r1.status + '(' + t1.slice(0, 40).replace(/\s+/g, ' ') + ',视频已删?)');
  let plsUrl = dirUrl + '/index.m3u8', text = t1;
  if (t1.indexOf('#EXT-X-STREAM-INF') > -1) {   // master:选最高 BANDWIDTH 变体
    const lines = t1.split('\n');
    let best = '', bw = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('#EXT-X-STREAM-INF') === 0) {
        const b = +((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1]) || 0;
        const u = (lines[i + 1] || '').trim();
        if (u && b > bw) { bw = b; best = u; }
      }
    }
    if (!best) throw new Error('主清单无变体(改版?)');
    plsUrl = new URL(best, dirUrl + '/').href;
    const r2 = await http(plsUrl, base);
    text = await r2.text();
    if (r2.status >= 400 || !text.startsWith('#EXTM3U')) throw new Error('子清单 HTTP ' + r2.status);
  }
  const pdir = plsUrl.replace(/\/[^/]+$/, '');
  return text.split('\n').map((l) => {
    if (!l || l.startsWith('#')) return l.replace(/URI="([^"]+)"/, (s, u) => 'URI="' + new URL(u, pdir + '/').href + '"');
    return new URL(l, pdir + '/').href;
  }).join('\n');
}

// ============ 归一化与代理 URL ============

// 封面(pp 存储)须站群域 Referer → 走 /api/img/llw 服务端中转
const imgProxy = (u) => (u ? '/api/img/llw?u=' + encodeURIComponent(u) : '');

function normCards(cards) {
  const out = [];
  for (const c of cards || []) {
    if (!c || !c.id) continue;
    out.push({
      id: c.id,
      title: c.title || '',
      cover: imgProxy(c.thumb),
      duration: parseDurStr(c.duration),
      hd: false,
    });
  }
  return out;
}

// 媒体/密钥带外部 Referer 一律 403 → 经 /api/llw/seg 服务端流式中转(带站群 Referer)
const segProxy = (u) => '/api/llw/seg?u=' + encodeURIComponent(u);
const proxifyM3u8 = (text) => text.split('\n').map((l) => {
  if (!l || l.startsWith('#')) return l.replace(/URI="([^"]+)"/, (s, u) => 'URI="' + segProxy(u) + '"');
  return segProxy(l);
}).join('\n');

// ============ 播放清单缓存(LRU) ============

const playCache = new Map(); // id(字符串) → {text, at}
function cachePlay(vid, text) {
  const v = { text, at: Date.now() };
  playCache.set(String(vid), v);
  if (playCache.size > PLAY_CACHE_MAX) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [k, ent] of playCache) {
      if (ent.at < oldestAt) { oldestAt = ent.at; oldestKey = k; }
    }
    if (oldestKey !== null) playCache.delete(oldestKey);
  }
  return v;
}

// ============ 插件类 ============

export class LlwPlugin extends SitePlugin {
  get id() { return 'llw'; }
  get name() { return '萝莉窝'; }
  // 游客态 HTML 抓取源:无热词/标签榜/专辑概念(对应方法不覆盖,前端按能力自适应);
  // home=类型导航+强烈推荐第 1 页;bytag 可用(播放页标签词即 id)
  get capabilities() { return { home: true, hotwords: false, tags: false, dvds: false, bytag: true, sort: false }; }

  async home() {
    // 首页 = 类型导航 + 强烈推荐(type122)第 1 页,与 list 缺省参数一致保证翻页无缝衔接
    const r = await fetchPage('/index.php/vod/type/id/122.html');
    const nav = Object.entries(TYPE_NAMES).map(([id, name]) => ({ id, title: name }));
    return { notice: '', nav, list: { items: normCards(parseCards(r.text)), page: 1, hasMore: true } };
  }

  async list(o = {}) {
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const cat = o.category != null && o.category !== '' ? parseInt(o.category, 10) : 122;
    const type = Number.isFinite(cat) && TYPE_NAMES[cat] ? cat : 122;
    const r = await fetchPage('/index.php/vod/type/id/' + type + (page > 1 ? '/page/' + page : '') + '.html');
    const items = normCards(parseCards(r.text));
    return { items, page, hasMore: items.length > 0 };
  }

  async search(kw, o = {}) {
    const k = String(kw || '').trim();
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    if (!k) return { items: [], page: 1, hasMore: false };
    // 搜索:第 1 页 query 形态,翻页路径段形态
    const path = page > 1
      ? '/index.php/vod/search/page/' + page + '/wd/' + encodeURIComponent(k) + '.html'
      : '/index.php/vod/search.html?wd=' + encodeURIComponent(k);
    const r = await fetchPage(path);
    const items = normCards(parseCards(r.text));
    return { items, page, hasMore: items.length > 0 };
  }

  async bytag(tag, o = {}) {
    const t = String(tag || '').trim();
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    if (!t) throw new Error('llw bytag 缺少标签词');
    const r = await fetchPage('/index.php/vod/search/tag/' + encodeURIComponent(t) + (page > 1 ? '/page/' + page : '') + '.html');
    const items = normCards(parseCards(r.text));
    return { items, page, hasMore: items.length > 0 };
  }

  // 分类 = 导航六类型;页深/计数逐类型探测(串行防风暴,结果进程内缓存)
  async categories() {
    if (!this._cats) {
      const out = [];
      for (const [id, name] of Object.entries(TYPE_NAMES)) {
        let count = 0;
        try {
          const r = await fetchPage('/index.php/vod/type/id/' + id + '.html');
          const cards = parseCards(r.text).length || 1;
          count = Math.max(1, ...[...r.text.matchAll(/\/page\/(\d+)\.html/g)].map((m) => +m[1])) * cards;
        } catch (e) { /* 计数失败给 0,不挡分类页 */ }
        out.push({ id: String(id), name, count });
      }
      this._cats = out;
    }
    return this._cats;
  }

  // 播放页原始数据(详情/相关/清单推导共用一次抓取;顺带留全页文本供目录推导)
  async loadPlay(vid) {
    const r = await fetchPage('/index.php/vod/play/id/' + vid + '/sid/1/nid/1.html');
    if (!/video-box|video-info/.test(r.text)) throw new Error('llw 播放页无内容(id=' + vid + ' 可能不存在)');
    return { html: r.text, base: r.base, d: parseDetail(r.text) };
  }

  async detail(id) {
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('llw detail 缺少有效视频 id');
    const { html, base, d } = await this.loadPlay(vid);
    const self = d.guessLove.find((g) => g.id === vid);
    // 白名单构造:VIP/播放次数等社交付费字段一律不带出
    return {
      id: vid,
      title: d.title || '',
      cover: imgProxy(d.wallBg || (self && self.thumb) || ''),
      duration: self ? parseDurStr(self.duration) : null,
      hd: false,
      resolution: '',
      uploadDate: '',   // 站点页面无日期字段
      tags: (d.tags || []).map((t) => ({ id: t, name: t })),
      categories: [],
    };
  }

  async related(id) {
    // 相关推荐 = 播放页「猜你喜欢」卡片(站方会把本片排在首位,剔除自身)
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('llw related 缺少有效视频 id');
    const { d } = await this.loadPlay(vid);
    const items = normCards(d.guessLove).filter((v) => v.id !== vid);
    return { items, page: 1, hasMore: false };
  }

  // 播放解析:真实清单直取(主→子,真实 EXTINF,VIP 墙亦仅 Referer 无购买校验),
  // 重写为 /api/llw/seg 代理 URL(媒体带外部 Referer 一律 403,浏览器跨源不可直连)
  async resolvePlay(id) {
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('llw resolvePlay 缺少有效视频 id');
    await this.buildPlaylist(vid);
    return { type: 'hls', url: '/api/llw/playlist?id=' + vid, via: 'direct' };
  }

  // 清单构建(带 LRU 缓存;缓存文本已代理化,零时效问题可长存)
  async buildPlaylist(vid) {
    const hit = playCache.get(String(vid));
    if (hit) return hit;
    const { html, base } = await this.loadPlay(vid);
    const dir = resolveDir(html, vid);
    if (!dir) throw new Error('llw 无法推导媒体目录(墙背景/内联配置/猜你喜欢均未命中,id=' + vid + ')');
    const text = await fetchPls(base, dir.base);
    return cachePlay(vid, proxifyM3u8(text));
  }

  async playlist(id) {
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('llw playlist 缺少有效视频 id');
    return (await this.buildPlaylist(vid)).text;
  }

  // 切片/密钥流式中转:供 /api/llw/seg 调用;仅放行入口域与 pp 存储形态主机(防开放代理)
  async seg(u, { range } = {}) {
    const abs = String(u || '');
    if (!/^https?:\/\//.test(abs)) throw new Error('llw seg 需要合法 http(s) 地址');
    let host = '';
    try { host = new URL(abs).hostname + (new URL(abs).port ? ':' + new URL(abs).port : ''); } catch (e) { throw new Error('llw seg 地址畸形'); }
    const bases = await resolveBases();
    const ok = PP_HOST_RE.test(host) || bases.some((b) => { try { const u2 = new URL(b); return (u2.hostname + (u2.port ? ':' + u2.port : '')) === host; } catch (e) { return false; } });
    if (!ok) throw new Error('llw seg 拒绝非本站/非 pp 存储地址');
    const res = await fetch(abs, {
      cache: 'no-store', signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': UA, Referer: (await resolveBases())[0] + '/', ...(range ? { Range: range } : {}) },
    });
    return { status: res.status, contentType: res.headers.get('content-type') || 'application/octet-stream', contentRange: res.headers.get('content-range') || '', body: res.body };
  }

  // 封面静态图能力:供 /api/img/llw 调用(pp 海报须站群域 Referer,带外部 Referer 403)
  async image(u) {
    if (!/^https?:\/\//.test(u || '')) throw new Error('llw 图片代理需要合法 http(s) 地址');
    const base = (await resolveBases())[0];
    const r = await fetch(u, {
      cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8', Referer: base + '/' },
    });
    if (!r.ok) throw new Error('图片 HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  }
}
