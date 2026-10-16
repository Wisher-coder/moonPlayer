// ============================================================
// dsd.js —— 懂色帝插件(MacCMS 内核 HTML 抓取,仅 Node 服务端运行)
//
// 逆向结论(2026-10-06 授权测试环境实测,移植自 CLI 取证版 dsd_api.js / dsd.js):
//   · MacCMS 内核服务端直出 HTML,无独立 JSON API——数据面 = 页面解析;
//   · 入口偶套 verify_token JS 挑战(~117B 壳):document.cookie="verify_token=pass"
//     后 reload——写 cookie verify_token=pass 重取即过(模块级 jar 进程保活);
//   · 入口域名轮换:发布页 dsd.name(Vue SPA)把跳转端点 /go1,/go2,/go3 硬编码在
//     ./files/app.<hash>.js 的 r={pc:…,mobile:…};逐个过挑战后 302 Location 即当前
//     入口域(go1→www.dsd901.lol 轮换,go2/3→www.dsd.com.se 永久);
//   · 分类导航频繁改名/增删(2026-10 实测导航仅 3 类、名称与历史硬编码全不同):
//     每页侧边导航 dropdown-title 链接即分类全集 → 动态解析 + 10 分钟缓存,
//     解析失败退 FALLBACK_TYPES 兜底表;
//   · 媒体目录 /video1/{频道}/{批次}/{番号}/ 无公式,但每片在同页必有:VIP 墙背景图
//     .video-before-ad / 免费片 player_aaaa.url / 「猜你喜欢」自片卡片 data-src;
//   · 正片:目录下质量子目录(实测全站仅 1000k),indexNNN.jpeg 为 .jpeg 伪装的
//     AES-128-CBC 密文 TS(IV=0,key=同目录 logo.jpeg 16 字节),切片与密钥零签名
//     零鉴权;index.m3u8 裸取 403(站方 sign 网关);
//   · 【官方签名线路对任意路径无购买校验】:/addons/vplayer/?url=<enc> 播放器页把
//     短时效 sign(256 hex,实测 <2 分钟)嵌进一段 AAEncode 颜文字混淆脚本,沙箱
//     执行钩 initVideo({url}) 即得——VIP 未购片同样可签,清单含真实 EXTINF;
//   · 媒体无 ACAO(浏览器跨域不可直连)且海报忌外部 Referer(带则 404)⇒ 切片/密钥
//     经 /api/dsd/seg、封面经 /api/img/dsd 服务端中转(切片流式透传不过内存)。
//
// 基址策略:环境变量 DSD_BASE 有值 → 单基址直连(禁用自动刷新);否则发布页解析,
// 结果模块级缓存 10 分钟(域名刷新调度器 domain-refresh.js 每 5 分钟重跑发现链,
// 顺带续本缓存);发布页不可达时兜底 FALLBACK_BASES。HTTP≥400/网络错/解析空换
// 下一基址(www.dsd901.lol → www.dsd.com.se → …);全部基址不可达时先 urgent
// 刷新入口域名,changed 则原路径重试一轮(每请求至多一次)。
// ============================================================
import vm from 'node:vm';
import { SitePlugin } from './base.js';
import { registerRefresher, requestUrgentRefresh } from './domain-refresh.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const PUBLISH_URL = 'https://dsd.name/';                          // 发布页(Vue SPA)
const FALLBACK_BASES = ['https://www.dsd901.lol', 'https://www.dsd.com.se', 'https://dsd900.com'];   // 发布页不可达时兜底
const BASES_TTL = 10 * 60 * 1000;    // 基址缓存有效期(10 分钟)
const CATS_TTL = 10 * 60 * 1000;     // 分类页深缓存
const PLAY_CACHE_MAX = 40;           // 播放清单文本缓存上限(重写为代理 URL 后无时效问题,可长存)
const TIMEOUT_MS = 15000;
const PROBE_RETRY = 3;               // 切片探测网络错误重试
const QUALITIES = ['1000k', '2000k', '3000k', '720p', '1080p', ''];   // 质量目录探测序列(实测仅 1000k)
// 分类兜底表(历史名称):站方导航解析失败时的应急清单。正常路径一律走下方
// fetchNav() 动态解析——站方频繁改名/增删分类(2026-10 实测导航只剩 3 类且名称
// 与本表全不同),写死名称必然过时
const FALLBACK_TYPES = [{ id: '1', title: '推荐' }, { id: '2', title: '中文字幕' }, { id: '4', title: '解说' }, { id: '6', title: '免费' }];

// ============ HTTP 底座(cookie jar + verify_token 挑战自动过) ============

const jar = new Map(); // name → value(Set-Cookie 增量合并,进程存活期内保活 verify_token)
const cookieHeader = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');

function absorbSetCookie(res) {
  for (const line of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
    const [kv] = line.split(';');
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}

// 基本请求:浏览器头 + jar cookie(页面/切片均无需 Referer;海报反忌外部 Referer,故一律不带)
async function http(url, { range } = {}) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,image/*,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  const ck = cookieHeader();
  if (ck) headers['Cookie'] = ck;
  if (range) headers['Range'] = range;
  const res = await fetch(url, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS), headers });
  absorbSetCookie(res);
  return res;
}

// ============ 基地址解析(发布页 dsd.name → app.js → /goN 过挑战 → 302 目标) ============

let baseCache = { bases: null, at: 0 };

async function fetchText(url) {
  const res = await fetch(url, {
    redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/json,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' },
  });
  return { status: res.status, location: res.headers.get('location') || '', text: await res.text() };
}

// /goN 端点 → 当前入口域:首访 verify_token 挑战壳 → 带 cookie 重取 → 302 Location
async function resolveGo(goPath) {
  const url = new URL(goPath, PUBLISH_URL).href;
  let cookie = '';
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetch(url, {
      redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) },
    });
    const loc = res.headers.get('location') || '';
    if (res.status >= 300 && res.status < 400 && loc) return loc;
    const text = await res.text();
    if (/document\.cookie\s*=\s*"verify_token=pass/.test(text)) { cookie = 'verify_token=pass'; continue; }
    break;
  }
  return null;
}

// 发布页发现链本体(不读不写缓存;失败抛错)。FALLBACK_BASES 兜底不在本函数——
// 正常请求路径的兜底写在 resolveBases(兜底合并语义不变:仅请求路径可写入兜底
// 缓存),域名刷新失败须保留旧值不得用兜底覆写(红线「不把还能用的基址刷没」)
async function discoverBases() {
  try {
    const home = await fetchText(PUBLISH_URL);
    const appJs = home.text.match(/<script src="(\.\/files\/app\.[a-f0-9]+\.js[^"]*)"/i);
    if (appJs) {
      const js = await fetchText(new URL(appJs[1].replace(/^\.\//, '/'), PUBLISH_URL).href);
      // r={pc:"/go1,…"…mobile:"…"} 硬编码跳转端点(pc/mobile 并集去重)
      const goes = [];
      for (const m of js.text.matchAll(/\{[^{}]*pc\s*:\s*"([^"]*)"\.split\([^)]*\)[^{}]*mobile\s*:\s*"([^"]*)"/g)) {
        for (const list of [m[1], m[2]]) for (const p of list.split(',')) {
          if (/^\/[A-Za-z0-9_-]+$/.test(p.trim())) goes.push(p.trim());
        }
      }
      const bases = [];
      for (const g of [...new Set(goes)]) {
        const target = await resolveGo(g);
        const b = target ? target.replace(/\/+$/, '') : '';
        if (/^https?:\/\/[a-z0-9.-]+$/i.test(b) && !bases.includes(b)) bases.push(b);
      }
      if (bases.length) return bases;
    }
  } catch (e) { /* 抛给调用方处置 */ }
  throw new Error('dsd 发布页解析失败');
}

// 返回最新基址数组(go1 轮换入口优先,永久域垫底):环境变量直连 / 缓存命中 /
// 发现链三层;发现失败落 FALLBACK_BASES 兜底并写入缓存(既有语义不变)
async function resolveBases() {
  if (process.env.DSD_BASE) return [String(process.env.DSD_BASE).replace(/\/+$/, '')];
  if (Array.isArray(baseCache.bases) && baseCache.bases.length && Date.now() - baseCache.at < BASES_TTL) {
    return baseCache.bases;
  }
  try {
    const bases = await discoverBases();
    baseCache = { bases, at: Date.now() };
    return bases;
  } catch (e) {
    baseCache = { bases: FALLBACK_BASES, at: Date.now() };
    return FALLBACK_BASES;
  }
}

// 域名自动刷新(注册给 domain-refresh.js 调度):绕过缓存重跑发布页发现链,成功
// 覆写 baseCache(顺带续 BASES_TTL);失败保留旧值 fail-soft(不写 FALLBACK 兜底,
// 不动 resolveBases 的兜底合并语义);与旧值比对以 FALLBACK_BASES 为空值参照,
// 新旧完全一致返回 changed:false;环境变量直连时禁用
async function refreshDsdDomains() {
  if (process.env.DSD_BASE) return { changed: false };
  let bases;
  try { bases = await discoverBases(); } catch (e) { return { changed: false }; }
  const old = Array.isArray(baseCache.bases) && baseCache.bases.length ? baseCache.bases : FALLBACK_BASES;
  baseCache = { bases, at: Date.now() };
  return { changed: JSON.stringify(bases) !== JSON.stringify(old) };
}
registerRefresher('dsd', refreshDsdDomains);

// 按基址轮换的页面获取单轮:HTTP≥400/网络错/空解析换下一基址;挑战页写票重取
async function fetchPageRound(path) {
  const bases = await resolveBases();
  let lastErr = null;
  for (const base of bases) {
    let cur = path.startsWith('http') ? path : base + path;
    try {
      for (let hop = 0; hop < 6; hop++) {
        const res = await http(cur);
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
  throw lastErr || new Error('dsd 全部基址不可达');
}

// 页面获取入口(全部基址不可达的失败钩子):先 urgent 刷新入口域名(单站 60s
// 冷却/在途共享,见 domain-refresh.js),changed 则同路径重试一轮(每请求至多
// 一次 urgent 重试);正常请求逻辑零改动。注:resolveBases 自带 FALLBACK_BASES
// 兜底,走到这里的失败 = 连兜底域也不可达
async function fetchPage(path) {
  try {
    return await fetchPageRound(path);
  } catch (e) {
    try {
      const r = await requestUrgentRefresh('dsd');
      if (r.changed) return await fetchPageRound(path);
    } catch (e2) { /* urgent 刷新自身异常按未变更处理 */ }
    throw e; // 仍失败抛原错误
  }
}

// ============ 分类导航(站方左侧导航动态解析) ============

let navCache = { list: null, at: 0 };

// 页面导航提取:每页侧边导航的 dropdown-title 链接即站方当前分类全集
// (menu-item 里 id1 重复出现,按 id 去重保序)
function parseNav(html) {
  const seen = new Set();
  const list = [];
  for (const m of html.matchAll(/href="\/index\.php\/vod\/type\/id\/(\d+)\.html" class="dropdown-title">([^<]*)</g)) {
    const id = m[1].replace(/^0+(?=\d)/, '');
    const title = m[2].trim();
    if (!title || seen.has(id)) continue;
    seen.add(id);
    list.push({ id, title });
  }
  return list;
}

// 分类表 [{id,title}]:首页解析 + 10 分钟缓存;解析失败退兜底表(不缓存,便于下轮重试)
async function fetchNav() {
  if (Array.isArray(navCache.list) && navCache.list.length && Date.now() - navCache.at < CATS_TTL) {
    return navCache.list;
  }
  try {
    const list = parseNav((await fetchPage('/')).text);
    if (list.length) {
      navCache = { list, at: Date.now() };
      return list;
    }
  } catch (e) { /* 落入兜底 */ }
  return FALLBACK_TYPES;
}

// ============ 页面解析器(卡片/详情/相关) ============

// 展示时长串("58:26"/"1:23:45")→ 秒;解析失败给 null
function parseDurStr(s) {
  const m = String(s || '').trim().match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return null;
  if (m[3] !== undefined) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  return (+m[1]) * 60 + (+m[2]);
}

// 列表卡片:<a href=…/vod/play/id/{id}/… class="video-item"> → id/标题/时长/VIP/海报
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
      thumb: (b.match(/data-src="([^"]+)"/) || [, (b.match(/src="(\/video1\/[^"]+)"/) || [, ''])[1]])[1],
    });
  }
  return out.filter((c) => c.id && c.title);
}

// 播放页(=详情页)解析
function parseDetail(html) {
  const d = {};
  d.title = (html.match(/<h2 class="ellipsis">([^<]*)</) || [, (html.match(/<title>([^<]*) - /) || [, ''])[1].trim()])[1].trim();
  d.desc = (html.match(/<div class="desc">([\s\S]*?)<\/div>/) || [, ''])[1].replace(/<[^>]*>/g, '').trim();
  d.tags = [...html.matchAll(/\/index\.php\/vod\/search\/tag\/([^".]+)(?:\.html)?"/g)].map((m) => decodeURIComponent(m[1]));
  d.vip = /VIP会员专享/.test(html);
  d.playerUrl = (html.match(/"url":"((?:[^"\\]|\\.)*\/video\d*\/(?:[^"\\]|\\.)*)"/) || [, ''])[1].replace(/\\\//g, '/');
  d.wallBg = (html.match(/video-before-ad[^"]*"[^>]*style="background-image:\s*url\(([^)]+)\)/) || [, ''])[1];
  d.guessLove = parseRelated(html.split('guess-love-wrap').pop() || '');
  return d;
}

// 媒体目录推导(三级来源:VIP墙背景图 → player_aaaa.url → 猜你喜欢自片卡片)
function resolveDir(html, vid) {
  const d = parseDetail(html);
  const trim = (u) => (u ? u.replace(/\/[^/]+$/, '') : '');
  if (d.wallBg && /\/video\d*\//.test(d.wallBg)) return { base: trim(d.wallBg), src: 'wall' };
  if (d.playerUrl && /\/video\d*\//.test(d.playerUrl)) return { base: trim(d.playerUrl.replace(/\/[^/]+\/[^/]+$/, '')), src: 'player' };
  const self = d.guessLove.find((g) => g.id === vid && /\/video\d*\//.test(g.thumb));
  if (self) return { base: trim(self.thumb), src: 'guess' };
  return null;
}

// ============ 切片存储面(探测/末段二分/合成) ============

const segUrl = (qdir, n) => qdir + '/index' + String(n).padStart(3, '0') + '.jpeg';

async function probe(url) {
  for (let i = 0; i < PROBE_RETRY; i++) {
    try {
      const res = await http(url);
      try { res.body && res.body.cancel(); } catch (e) { /* 忽略取消异常 */ }
      return res.status;
    } catch (e) { /* 重试 */ }
  }
  return -1;
}

// 倍增上界 + 二分找末段(串行 ~2×log₂N 次探测;保守节奏,勿为提速并发轰炸)
async function findLast(qdir) {
  if (await probe(segUrl(qdir, 0)) !== 200) return -1;
  let hi = 1;
  while (await probe(segUrl(qdir, hi)) === 200) hi *= 2;
  let lo = hi / 2;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    (await probe(segUrl(qdir, mid)) === 200) ? (lo = mid) : (hi = mid);
  }
  return lo;
}

// 质量目录探测:序列内 index000.jpeg 先 200 者胜(实测全站仅 1000k)
async function qualityDir(absDir) {
  for (const q of QUALITIES) {
    const qdir = absDir + (q ? '/' + q : '');
    if (await probe(qdir + '/index000.jpeg') === 200) return qdir;
  }
  return null;
}

// 合成全片清单:AES-128 key=logo.jpeg IV=0(与站方清单 KEY 行同款),EXTINF 名义 3.0s
function synthM3u8(qdir, last) {
  let t = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n' +
    '#EXT-X-KEY:METHOD=AES-128,URI="' + qdir + '/logo.jpeg",IV=0x00000000000000000000000000000000\n';
  for (let i = 0; i <= last; i++) t += '#EXTINF:3.000000,\n' + segUrl(qdir, i) + '\n';
  return t + '#EXT-X-ENDLIST\n';
}

// ============ 官方签名线路(vplayer 播放器页 → AAEncode 沙箱 → sign) ============

// AAEncode(颜文字混淆)沙箱执行:脚本最终调用 initVideo({url:"…?sign=…"})——钩住即得
// 签名 URL。上下文内自建全部全局(不传宿主对象),给齐最小可用面。
function extractSign(html, pageUrl) {
  const aa = [...html.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((b) => /ﾟωﾟ/.test(b));
  if (!aa) return null;
  let got = null;
  const pu = new URL(pageUrl);
  const sb = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    initVideo: (p) => { if (p && p.url) got = String(p.url); },
    document: {
      getElementById: () => ({ innerHTML: '', textContent: '', style: {} }),
      createElement: () => ({ src: '', setAttribute() {}, appendChild() {}, style: {} }),
      querySelector: () => null, querySelectorAll: () => [],
      body: { appendChild() {} }, head: { appendChild() {} },
      write() {}, cookie: '', referrer: '', location: { href: pageUrl },
    },
    location: { href: pageUrl, search: pu.search, protocol: pu.protocol, host: pu.host, hostname: pu.hostname, origin: pu.origin, pathname: pu.pathname },
    XMLHttpRequest: class { open() {} send() {} setRequestHeader() {} addEventListener() {} },
    fetch: () => Promise.resolve({ ok: true, text: () => Promise.resolve('') }),
    setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
    navigator: { userAgent: UA }, alert() {}, confirm: () => true,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    unescape, escape, decodeURIComponent, encodeURIComponent,
    parseInt, parseFloat, isNaN, isFinite,
    String, Number, Boolean, Array, Object, Math, Date, JSON, RegExp, Error, Map, Set, Promise,
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb; sb.top = sb; sb.parent = sb;
  vm.createContext(sb);
  vm.runInContext(aa, sb, { timeout: 10000 });
  return got;
}

// 官方签名清单文本:播放器页现取现解(sign 分钟级时效,勿缓存中间产物)
async function officialM3u8Text(base, absQdir) {
  const target = absQdir + '/index.m3u8';
  const r = await fetchPage('/addons/vplayer/?url=' + encodeURIComponent(target) + '&jump=');
  if (r.status >= 400) throw new Error('vplayer 播放器页 HTTP ' + r.status);
  const signed = extractSign(r.text, r.url);
  if (!signed) throw new Error('AAEncode 未产出签名 URL(播放器页改版?)');
  const res = await http(signed.startsWith('http') ? signed : r.base + signed);
  const text = await res.text();
  if (res.status >= 400 || !text.startsWith('#EXTM3U'))
    throw new Error('签名清单 HTTP ' + res.status + '(' + text.slice(0, 40).replace(/\s+/g, ' ') + ')');
  const su = new URL(signed.startsWith('http') ? signed : r.base + signed);
  const pdir = su.origin + su.pathname.replace(/\/[^/]+$/, '');
  // 切片/KEY 相对路径 → 绝对;hls.js 需要绝对地址
  return text.split('\n').map((l) => {
    if (!l || l.startsWith('#')) return l.replace(/URI="([^"]+)"/, (s, u) => 'URI="' + new URL(u, pdir + '/').href + '"');
    return new URL(l, pdir + '/').href;
  }).join('\n');
}

// ============ 归一化与代理 URL ============

// 封面忌外部 Referer → 走 /api/img/dsd 服务端中转
const imgProxy = (base, u) => (u ? '/api/img/dsd?u=' + encodeURIComponent(new URL(u, base + '/').href) : '');

function normCards(base, cards) {
  const out = [];
  for (const c of cards || []) {
    if (!c || !c.id) continue;
    out.push({
      id: c.id,
      title: c.title || '',
      cover: imgProxy(base, c.thumb),
      duration: parseDurStr(c.duration),
      hd: false,
    });
  }
  return out;
}

// 媒体/密钥无 ACAO → 经 /api/dsd/seg 服务端流式中转(hls.js 由本域拉切片)
const segProxy = (u) => '/api/dsd/seg?u=' + encodeURIComponent(u);
const proxifyM3u8 = (text) => text.split('\n').map((l) => {
  if (!l || l.startsWith('#')) return l.replace(/URI="([^"]+)"/, (s, u) => 'URI="' + segProxy(u) + '"');
  return segProxy(l);
}).join('\n');

// ============ 播放清单缓存(LRU) ============

const playCache = new Map(); // id(字符串) → {text, via, at}
function cachePlay(vid, text, via) {
  const v = { text, via, at: Date.now() };
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

export class DsdPlugin extends SitePlugin {
  get id() { return 'dsd'; }
  get name() { return '懂色帝'; }
  // 游客态 HTML 抓取源:无热词/标签榜/专辑概念(对应方法不覆盖,前端按能力自适应);
  // home=类型导航+推荐第 1 页;bytag 可用(播放页标签词即 id)
  get capabilities() { return { home: true, hotwords: false, tags: false, dvds: false, bytag: true, sort: false }; }

  async home() {
    // 首页 = 类型导航 + 首个分类第 1 页:导航动态解析(站方改名/增删即时跟进),
    // 首档与 list 缺省参数一致保证翻页无缝衔接
    const nav = await fetchNav();
    const first = (nav[0] && nav[0].id) || '1';
    const r = await fetchPage('/index.php/vod/type/id/' + first + '.html');
    return { notice: '', nav, list: { items: normCards(r.base, parseCards(r.text)), page: 1, hasMore: true } };
  }

  async list(o = {}) {
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const cat = o.category != null && o.category !== '' ? String(parseInt(o.category, 10) || '') : '';
    // 分类 id 以站方当前导航为准:不在导航内(下线/未知)→ 回落首档
    const nav = await fetchNav();
    const ent = cat ? nav.find((n) => n.id === cat) : null;
    const type = (ent && ent.id) || (nav[0] && nav[0].id) || '1';
    const r = await fetchPage('/index.php/vod/type/id/' + type + (page > 1 ? '/page/' + page : '') + '.html');
    const items = normCards(r.base, parseCards(r.text));
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
    const items = normCards(r.base, parseCards(r.text));
    return { items, page, hasMore: items.length > 0 };
  }

  async bytag(tag, o = {}) {
    const t = String(tag || '').trim();
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    if (!t) throw new Error('dsd bytag 缺少标签词');
    const r = await fetchPage('/index.php/vod/search/tag/' + encodeURIComponent(t) + (page > 1 ? '/page/' + page : '') + '.html');
    const items = normCards(r.base, parseCards(r.text));
    return { items, page, hasMore: items.length > 0 };
  }

  // 分类 = 站方导航动态全集(名称随导航即时更新);页深/计数逐类型探测
  // (串行防风暴,结果缓存 10 分钟)
  async categories() {
    if (this._cats && Date.now() - this._catsAt < CATS_TTL) return this._cats;
    const nav = await fetchNav();
    const out = [];
    for (const { id, title } of nav) {
      let count = 0;
      try {
        const r = await fetchPage('/index.php/vod/type/id/' + id + '.html');
        const cards = parseCards(r.text).length || 1;
        count = Math.max(1, ...[...r.text.matchAll(/\/page\/(\d+)\.html/g)].map((m) => +m[1])) * cards;
      } catch (e) { /* 计数失败给 0,不挡分类页 */ }
      out.push({ id: String(id), name: title, count });
    }
    this._cats = out;
    this._catsAt = Date.now();
    return out;
  }

  // 播放页原始数据(详情/相关/清单推导共用一次抓取;顺带留全页文本供目录推导)
  async loadPlay(vid) {
    const r = await fetchPage('/index.php/vod/play/id/' + vid + '/sid/1/nid/1.html');
    if (!/video-box|video-info/.test(r.text)) throw new Error('dsd 播放页无内容(id=' + vid + ' 可能不存在)');
    return { html: r.text, base: r.base, d: parseDetail(r.text) };
  }

  async detail(id) {
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('dsd detail 缺少有效视频 id');
    const { html, base, d } = await this.loadPlay(vid);
    const self = d.guessLove.find((g) => g.id === vid);
    // 白名单构造:VIP/播放次数等社交付费字段一律不带出
    return {
      id: vid,
      title: d.title || '',
      cover: imgProxy(base, d.wallBg || (self && self.thumb) || ''),
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
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('dsd related 缺少有效视频 id');
    const { base, d } = await this.loadPlay(vid);
    const items = normCards(base, d.guessLove).filter((v) => v.id !== vid);
    return { items, page: 1, hasMore: false };
  }

  // 播放解析两级:① vplayer 官方签名清单(真实 EXTINF,免购可签)→ ② 裸切片枚举合成;
  // 产出统一重写为 /api/dsd/seg 代理 URL(媒体无 ACAO,浏览器跨域不可直连)
  async resolvePlay(id) {
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('dsd resolvePlay 缺少有效视频 id');
    const hit = await this.buildPlaylist(vid);
    return { type: 'hls', url: '/api/dsd/playlist?id=' + vid, via: hit.via };
  }

  // 域名自动刷新(可选能力,契约见 base.js):手动触发一次发布页发现链;
  // domain-refresh.js 的周期轮与 urgent 触发亦走同一函数;DSD_BASE 有值时为 no-op
  async refreshDomains() { return refreshDsdDomains(); }

  // 清单构建(带 LRU 缓存;缓存文本已代理化,无 sign 时效问题可长存)
  async buildPlaylist(vid) {
    const hit = playCache.get(String(vid));
    if (hit) return hit;
    const { html, base } = await this.loadPlay(vid);
    const dir = resolveDir(html, vid);
    if (!dir) throw new Error('dsd 无法推导媒体目录(墙背景/内联配置/猜你喜欢均未命中,id=' + vid + ')');
    const absDir = new URL(dir.base, base + '/').href;
    const qdir = await qualityDir(absDir);
    if (!qdir) throw new Error('dsd 质量目录探测失败(切片不存在/视频已删? id=' + vid + ')');
    // ① 官方签名清单(vplayer 现取现签)
    try {
      const text = await officialM3u8Text(base, qdir);
      return cachePlay(vid, proxifyM3u8(text), 'sign');
    } catch (e) { /* 落入枚举合成 */ }
    // ② 裸切片枚举合成全片(AES-128/IV=0,KEY=logo.jpeg)
    const last = await findLast(qdir);
    if (last < 0) throw new Error('dsd 切片枚举失败(index000.jpeg 非 200,id=' + vid + ')');
    return cachePlay(vid, proxifyM3u8(synthM3u8(qdir, last)), 'segs');
  }

  async playlist(id) {
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('dsd playlist 缺少有效视频 id');
    return (await this.buildPlaylist(vid)).text;
  }

  // 切片/密钥流式中转:供 /api/dsd/seg 调用;仅放行已知基址域(防开放代理)
  async seg(u, { range } = {}) {
    const abs = String(u || '');
    if (!/^https?:\/\//.test(abs)) throw new Error('dsd seg 需要合法 http(s) 地址');
    let host = '';
    try { host = new URL(abs).hostname; } catch (e) { throw new Error('dsd seg 地址畸形'); }
    const bases = await resolveBases();
    const ok = bases.some((b) => { try { return new URL(b).hostname === host; } catch (e) { return false; } });
    if (!ok) throw new Error('dsd seg 拒绝非本站基址地址');
    const res = await fetch(abs, {
      cache: 'no-store', signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': UA, ...(range ? { Range: range } : {}) },
    });
    return { status: res.status, contentType: res.headers.get('content-type') || 'application/octet-stream', contentRange: res.headers.get('content-range') || '', body: res.body };
  }

  // 封面静态图能力:供 /api/img/dsd 调用(须无 Referer 取,带外部 Referer 404)
  async image(u) {
    if (!/^https?:\/\//.test(u || '')) throw new Error('dsd 图片代理需要合法 http(s) 地址');
    const r = await fetch(u, {
      cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': UA, 'Accept': 'image/*,*/*;q=0.8' },
    });
    if (!r.ok) throw new Error('图片 HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  }
}
