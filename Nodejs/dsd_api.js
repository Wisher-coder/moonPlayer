#!/usr/bin/env node
'use strict';
/**
 * dsd_api.js —— dsd(懂色帝,MacCMS 站群)视频类只读 API 爬取器(Node.js 版,零依赖,需 Node>=18)
 *
 * 逆向结论(2026-10-06,授权测试环境实测,dsd901.lol / dsd900.com / dsd.com.se 同壳同库):
 *   1. MacCMS 内核服务端直出 HTML,无独立 JSON API——数据面 = 页面解析;
 *   2. 入口偶套 verify_token JS 挑战(~117B 壳):document.cookie="verify_token=pass;
 *      Max-Age=3600" 后 location.reload()——写 cookie verify_token=pass 重取即过,
 *      对脚本完全透明;
 *   3. 媒体目录公式 /video1/{频道}/{批次}/{番号}/(如 /video1/zw/zw20260116-20260131/
 *      FJIN-122/),频道与批次无规律,但每部片的目录在同页三处必有其一:
 *      VIP 墙页 = 墙背景图 .video-before-ad[style*=background-image];
 *      免费片页 = player_aaaa.url(/video1/…/1000k/index.m3u8 去尾两级);
 *      通用 = 「猜你喜欢」自片卡片 img 的 data-src(懒加载真图);
 *   4. 正片存储:目录下质量子目录(实测全站仅 1000k,探测序列兼容 2000k/3000k/720p/
 *      1080p/空),index.m3u8 走站方 sign 网关(短时效,裸取 403「参数错误或缺失」),
 *      但 indexNNN.jpeg 切片与 logo.jpeg 密钥(16B,即 AES-128 密钥本体)零签名零鉴权
 *      (无 Referer 亦 200;同目录海报 1.jpg 反而忌外部 Referer——带外部域 Referer 404,
 *      无 Referer 200,勿混淆);切片为 .jpeg 伪装的 AES-128-CBC 密文 TS(IV=0,
 *      key=logo.jpeg 16 字节,实测解密后 TS 同步字节 0x47@0/188/376/564 俱在),
 *      hls.js 原生解密;
 *   5. 【官方签名线路对任意路径无购买校验】:/addons/vplayer/?url=<enc>&jump= 播放器页
 *      服务端把短时效 sign(256 hex)嵌进一段 AAEncode 颜文字混淆脚本,沙箱执行后
 *      initVideo({url:"…index.m3u8?sign=…"}) 即得签名 URL——VIP 未购片同样可签
 *      (服务端只回放器配置,不看购买态),签名清单含真实 EXTINF 与 KEY 行;
 *      sign 时效实测 <2 分钟(0s 有效 121s 过期),现取现用;
 *   6. 页面无日期字段;时长在卡片 .video-item-tag-duration(HH:MM:SS);VIP 标记
 *      .video-item-tag-is-vip;播放次数 video-item-tag-hits 文本。
 *
 * 端点/页面清单(只读部分,全部实测通过):
 *   页面 /(首页 = type1 推荐第 1 页)
 *        /index.php/vod/type/id/{1|2|4|6}/[page/N/.]html      类型列表(1推荐 2中文字幕 4解说 6免费)
 *        /index.php/vod/search.html?wd={kw}                   搜索第 1 页
 *        /index.php/vod/search/page/N/wd/{kw}.html            搜索翻页
 *        /index.php/vod/search/tag/{tag}/[page/N/.]html       标签过滤
 *        /index.php/vod/play/id/{id}/sid/1/nid/1.html          播放页(=详情页;/vod/detail/id/N 会 JS 跳回此处)
 *   媒体 {媒体目录}/{质量}/indexNNN.jpeg                        裸 AES 切片(3 位零填充连续编号)
 *        {媒体目录}/{质量}/logo.jpeg                            裸 AES-128 密钥(16B)
 *        {媒体目录}/1.jpg                                      海报(须无 Referer 取)
 *   端点 /addons/vplayer/?url=<enc>&jump=                      官方签名播放器页(AAEncode 嵌 sign)
 *
 * 用法(基地址默认 https://www.dsd901.lol,挑战自动过;也可 --base=https://dsd900.com 等):
 *   node dsd_api.js                          # 总览:类型列表 → 首片详情 → 官方签名清单(回退切片枚举)
 *   node dsd_api.js list [--page=2] [--type=2]           # 类型列表(1推荐 2中文字幕 4解说 6免费)
 *   node dsd_api.js search 关键词 [--page=1]             # 搜索
 *   node dsd_api.js tag 角色扮演 [--page=1]              # 标签过滤
 *   node dsd_api.js categories                          # 类型索引(逐类型实测标题/页深)
 *   node dsd_api.js cat 2 [--page=1]                     # 类型内视频(cat = list --type= 别名)
 *   node dsd_api.js video 111                           # 详情(标题/番号/VIP形态/目录推导来源)
 *   node dsd_api.js related 111                         # 「猜你喜欢」卡片
 *   node dsd_api.js segs 111 [--out=111.m3u8]           # 裸切片枚举+合成全片 m3u8(AES-128/IV=0)落盘
 *   node dsd_api.js lines 111 [--out=111-official.m3u8] # 官方签名清单(真实 EXTINF,切片绝对化落盘)
 *   node dsd_api.js key 111                             # 密钥 logo.jpeg 探测(hex 查看)
 *   node dsd_api.js trace <完整URL>                      # 任意站内 URL 重定向链取证(含挑战过门)
 *   通用旗标:--base=https://www.dsd901.lol  --raw(输出完整 JSON)
 *           --no-title(摘要隐藏标题)  --out=<file>(segs/lines 清单落盘路径)
 * 退出码:0=成功;1=失败。仅供站方授权测试使用。
 */

// ============ 0. 常量与命令行 ============

const DEFAULT_BASE = 'https://www.dsd901.lol';
// 质量目录探测序列(实测全站仅 1000k,兼容站方日后开高清;空串=目录本体)
const QUALITIES = ['1000k', '2000k', '3000k', '720p', '1080p', ''];
const TYPE_NAMES = { 1: '推荐', 2: '中文字幕', 4: '解说', 6: '免费' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;
const PROBE_RETRY = 3;   // 切片探测网络错误重试(防代理抖动误判 404 截短)

const argv = process.argv.slice(2);
const flag = {};
for (const a of argv) {
  const m = a.match(/^--([a-z][a-z_-]*)(?:=(.*))?$/);
  if (m) flag[m[1]] = m[2] !== undefined ? m[2] : true;
}
const positional = argv.filter(a => !a.startsWith('--'));
flag.noTitle = flag['no-title'];
const cmd = positional[0] || 'all';
const arg1 = positional[1];
const num = (k, d) => (flag[k] !== undefined ? parseInt(flag[k], 10) : d);

const log = (...a) => console.log(...a);
const die = (msg) => { console.error('✘ ' + msg); process.exitCode = 1; throw new Error('__DIE__'); };

// ============ 1. HTTP 底座(cookie jar + verify_token 挑战自动过) ============

const jar = new Map();   // name → value(Set-Cookie 增量合并)
const cookieHeader = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');

function absorbSetCookie(res) {
  for (const line of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
    const [kv] = line.split(';');
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}

// 基本请求:浏览器头 + jar cookie(页面/切片均无需 Referer;海报反忌外部 Referer,故一律不带)
async function http(url, { method = 'GET', range } = {}) {
  const headers = {
    'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,image/*,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  if (cookieHeader()) headers['Cookie'] = cookieHeader();
  if (range) headers['Range'] = range;
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers });
  absorbSetCookie(res);
  return res;
}

// 页面获取(跟 301/302 共 6 跳;verify_token 挑战页自动过门:写 cookie → 原地重取一次)
async function fetchPage(base, path) {
  const url = path.startsWith('http') ? path : base + path;
  let cur = url;
  for (let hop = 0; hop < 6; hop++) {
    const res = await http(cur);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      cur = new URL(res.headers.get('location'), cur).href;
      continue;
    }
    const text = await res.text();
    // 挑战壳判定:仅 ~117B 的 verify_token 门(真实页面不会含该 document.cookie 赋值)
    if (/document\.cookie\s*=\s*"verify_token=pass/.test(text) && text.length < 512) {
      jar.set('verify_token', 'pass');
      continue;                      // 带票重取同 URL(location.reload() 的全部动作即写此 cookie)
    }
    return { status: res.status, url: cur, text };
  }
  throw new Error('重定向/挑战层数超限 @' + url);
}

// ============ 2. 页面解析器(卡片/详情/相关) ============

const durToSec = (s) => {
  const m = String(s || '').trim().match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  return m ? (m[3] !== undefined ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2])) : null;
};

// 列表卡片:<a href=…/vod/play/id/{id}/… class="video-item"> 块 → 标题/时长/VIP/次数/海报
// (id 统一由配对的 href 序列回填,避免跨块串读;海报在 img 的 data-src,src 是占位图勿取)
function parseCards(html) {
  const hrefs = [...html.matchAll(/<a href="\/index\.php\/vod\/play\/id\/(\d+)\/sid\/1\/nid\/1\.html" class="video-item">/g)];
  const blocks = html.split(/<a href="\/index\.php\/vod\/play\/id\/\d+\/sid\/1\/nid\/1\.html" class="video-item">/).slice(1);
  return hrefs.map((h, i) => {
    const b = blocks[i] || '';
    return {
      id: +h[1],
      title: (b.match(/<div class="video-desc[^>]*>([^<]*)</) || [, ''])[1].trim(),
      duration: (b.match(/video-item-tag-duration">([^<]*)</) || [, ''])[1].trim(),
      vip: /class="video-item-tag-is-vip"/.test(b),
      hits: (b.match(/video-item-tag-hits">(?:<[^>]*>)*([\d.]+)万?次/) || [, ''])[1],
      thumb: (b.match(/data-src="([^"]+)"/) || [, ''])[1],
    };
  }).filter(c => c.id && c.title);
}

// 相关/猜你喜欢卡片:dl 列表与 li.madou1 两种同构形态(href → dt/thumb → dd/h3-h2)
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
      thumb: (b.match(/data-src="([^"]+)"/) || [, (b.match(/src="(\/video1\/[^"]+)"/) || [, ''])[1]]) [1],
    });
  }
  return out.filter(c => c.id && c.title);
}

// 播放页(=详情页)解析:标题/描述/标签/VIP形态/墙背景/内联播放配置/猜你喜欢
function parseDetail(html) {
  const d = {};
  d.title = (html.match(/<h2 class="ellipsis">([^<]*)</) || [, (html.match(/<title>([^<]*) - /) || [, ''])[1].trim()])[1].trim();
  d.desc = (html.match(/<div class="desc">([\s\S]*?)<\/div>/) || [, ''])[1].replace(/<[^>]*>/g, '').trim();
  d.num = (d.title.match(/([A-Z]{2,8}-\d{2,5})/) || [, ''])[1];
  d.tags = [...html.matchAll(/\/index\.php\/vod\/search\/tag\/([^".]+)(?:\.html)?"/g)].map(m => decodeURIComponent(m[1]));
  d.vip = /VIP会员专享/.test(html);
  d.hasPlayer = /var player_aaaa=/.test(html);
  // 内联播放配置:player_aaaa 内首个指向 /videoN/ 的 url(广告/logo 等字段的 url 一律非此形态)
  d.playerUrl = (html.match(/"url":"((?:[^"\\]|\\.)*\/video\d*\/(?:[^"\\]|\\.)*)"/) || [, ''])[1].replace(/\\\//g, '/');
  d.wallBg = (html.match(/video-before-ad[^"]*"[^>]*style="background-image:\s*url\(([^)]+)\)/) || [, ''])[1];
  d.guessLove = parseRelated(html.split('guess-love-wrap').pop() || '');
  return d;
}

// 媒体目录推导(三级来源:VIP墙背景图 → player_aaaa.url → 猜你喜欢自片卡片)
function resolveDir(html, vid) {
  const d = parseDetail(html);
  const trim = (u) => u ? u.replace(/\/[^/]+$/, '') : '';
  if (d.wallBg && /\/video\d*\//.test(d.wallBg)) return { base: trim(d.wallBg), src: 'VIP墙背景图' };
  if (d.playerUrl && /\/video\d*\//.test(d.playerUrl)) return { base: trim(d.playerUrl.replace(/\/[^/]+\/[^/]+$/, '')), src: 'player_aaaa.url' };
  const self = d.guessLove.find(g => g.id === vid && /\/video\d*\//.test(g.thumb));
  if (self) return { base: trim(self.thumb), src: '猜你喜欢自片卡片' };
  return null;
}

// ============ 3. 官方签名线路(vplayer 播放器页 → AAEncode 沙箱 → sign) ============

const vm = require('vm');

// AAEncode(颜文字混淆)沙箱执行:脚本最终调用 initVideo({url:"…?sign=…"})——钩住即得
// 签名 URL。上下文内自建全部全局(不传宿主对象),给齐最小可用面。
function extractSign(html, pageUrl) {
  const aa = [...html.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)].map(m => m[1]).find(b => /ﾟωﾟ/.test(b));
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
      write() {}, cookie: '', referrer: '',
      location: { href: pageUrl },
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

// 官方签名清单:播放器页现取现解(sign 分钟级时效,勿缓存);成功返回切片/密钥绝对化后的清单文本
// (m3u8Path 允许站内相对/绝对两种形态;绝对化基准取签名 URL 自身目录,防重复拼 base)
async function officialM3u8(base, m3u8Path) {
  const target = new URL(m3u8Path, base + '/').href;
  const r = await fetchPage(base, '/addons/vplayer/?url=' + encodeURIComponent(target) + '&jump=');
  if (r.status >= 400) throw new Error('vplayer 播放器页 HTTP ' + r.status);
  const signed = extractSign(r.text, r.url);
  if (!signed) throw new Error('AAEncode 未产出签名 URL(播放器页改版?)');
  const res = await http(signed.startsWith('http') ? signed : base + signed);
  const text = await res.text();
  if (res.status >= 400 || !text.startsWith('#EXTM3U'))
    throw new Error('签名清单 HTTP ' + res.status + '(' + text.slice(0, 40).replace(/\s+/g, ' ') + ')');
  const su = new URL(signed.startsWith('http') ? signed : base + signed);
  const pdir = su.origin + su.pathname.replace(/\/[^/]+$/, '');   // 清单内切片/KEY 均为相对路径
  return text.split('\n').map(l => {
    if (!l || l.startsWith('#')) return l.replace(/URI="([^"]+)"/, (s, u) => 'URI="' + new URL(u, pdir + '/').href + '"');
    return new URL(l, pdir + '/').href;
  }).join('\n');
}

// ============ 4. 切片存储面(探测/末段二分/合成清单) ============

const segUrl = (qdir, n) => qdir + '/index' + String(n).padStart(3, '0') + '.jpeg';

// 状态码探测:响应头到即断不下载体;网络错误重试后按缺失处理
async function probe(url) {
  for (let i = 0; i < PROBE_RETRY; i++) {
    try {
      const res = await http(url);
      try { res.body && res.body.cancel(); } catch (e) { }
      return res.status;
    } catch (e) { /* 重试 */ }
  }
  return -1;
}

// 倍增上界 + 二分找末段(串行 ~2×log₂N 次探测,CLI 场景够用)
async function findLast(qdir) {
  if (await probe(segUrl(qdir, 0)) !== 200) return -1;
  let hi = 1;
  while (await probe(segUrl(qdir, hi)) === 200) hi *= 2;
  let lo = hi / 2;   // lo=在,hi=首缺
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    (await probe(segUrl(qdir, mid)) === 200) ? lo = mid : hi = mid;
  }
  return lo;
}

// 合成全片清单:AES-128 key=logo.jpeg IV=0(与站方清单 KEY 行同款),EXTINF 名义 3.0s
// (真实分段 2~6s 不等,hls.js/MSE 随真实分片附加自动修正 duration)
function synthM3u8(qdir, last) {
  let t = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n' +
    '#EXT-X-KEY:METHOD=AES-128,URI="' + qdir + '/logo.jpeg",IV=0x00000000000000000000000000000000\n';
  for (let i = 0; i <= last; i++) t += '#EXTINF:3.000000,\n' + segUrl(qdir, i) + '\n';
  return t + '#EXT-X-ENDLIST\n';
}

// 质量目录探测:序列内 index000.jpeg 先 200 者胜(实测全站仅 1000k)
async function qualityDir(dirPath) {
  for (const q of QUALITIES) {
    const qdir = dirPath + (q ? '/' + q : '');
    if (await probe(qdir + '/index000.jpeg') === 200) return qdir;
  }
  return null;
}

// ============ 5. 摘要打印 ============

const mask = (t, on) => on ? '<标题已隐藏>' : String(t == null ? '' : t).slice(0, 46);
const fs = require('fs');

function printCards(list, opt) {
  if (!list.length) { log('  (无卡片)'); return; }
  for (const v of list) {
    log('   [' + v.id + '] ' + (v.duration || '--:--').padStart(8) + '  ' + (v.vip ? 'VIP' : '免费').padEnd(4) +
      (v.hits ? String(v.hits).padStart(9) + '次' : '') + '  ' + mask(v.title, opt.noTitle));
  }
}

// ============ 6. 命令表 ============

const COMMANDS = {
  async list(base, type) { // 类型列表(1推荐 2中文字幕 4解说 6免费;缺省 1)
    const t = String(type || flag.type || '1');
    const p = num('page', 1);
    const r = await fetchPage(base, '/index.php/vod/type/id/' + t + (p > 1 ? '/page/' + p : '') + '.html');
    const cards = parseCards(r.text);
    log('── 类型列表 ' + (TYPE_NAMES[t] || ('type' + t)) + ' 第 ' + p + ' 页 ──');
    printCards(cards, flag);
    if (flag.raw) log('  RAW: ' + JSON.stringify(cards).slice(0, 1500));
  },
  async search(base) { // 搜索(第 1 页 query 形态,翻页路径段形态)
    const kw = arg1;
    if (!kw) die('用法: search <关键词> [--page=N]');
    const p = num('page', 1);
    const path = p > 1
      ? '/index.php/vod/search/page/' + p + '/wd/' + encodeURIComponent(kw) + '.html'
      : '/index.php/vod/search.html?wd=' + encodeURIComponent(kw);
    const r = await fetchPage(base, path);
    const cards = parseCards(r.text);
    log('── 搜索 "' + kw + '" 第 ' + p + ' 页 ──');
    printCards(cards, flag);
    if (flag.raw) log('  RAW: ' + JSON.stringify(cards).slice(0, 1500));
  },
  async tag(base) { // 标签过滤(播放页 .labels 链接同款路径)
    const kw = arg1;
    if (!kw) die('用法: tag <标签词> [--page=N]');
    const p = num('page', 1);
    const r = await fetchPage(base, '/index.php/vod/search/tag/' + encodeURIComponent(kw) + (p > 1 ? '/page/' + p : '') + '.html');
    const cards = parseCards(r.text);
    log('── 标签 "' + kw + '" 第 ' + p + ' 页 ──');
    printCards(cards, flag);
  },
  async categories(base) { // 类型索引(逐类型实测标题/卡片/页深,串行防风暴)
    log('── 类型索引(实测)──');
    for (const [id, name] of Object.entries(TYPE_NAMES)) {
      const r = await fetchPage(base, '/index.php/vod/type/id/' + id + '.html');
      const cards = parseCards(r.text).length;
      const maxPage = Math.max(1, ...[...r.text.matchAll(/\/page\/(\d+)\.html/g)].map(m => +m[1]));
      log('   [type ' + id + '] ' + name.padEnd(5) + '  ' + cards + ' 卡/页, 页深 ' + maxPage + '(~' + (maxPage * cards) + ' 条)');
    }
  },
  async cat(base) { await COMMANDS.list(base, arg1); },   // cat <typeId> = list --type=<typeId> 别名
  async video(base, a2) { // 详情(播放页即详情页;/vod/detail/id/N 会 JS 跳回播放页)
    const vid = a2 !== undefined ? a2 : arg1;
    if (!vid) die('用法: video <视频ID>');
    const vid_ = parseInt(vid, 10);
    const r = await fetchPage(base, '/index.php/vod/play/id/' + vid_ + '/sid/1/nid/1.html');
    if (!/vod\/play\/id\/|video-box|video-info/.test(r.text)) die('播放页无内容(id=' + vid_ + ' 可能不存在)');
    const d = parseDetail(r.text);
    log('── 视频详情 id=' + vid_ + ' ──');
    log('  title: ' + mask(d.title, flag.noTitle));
    log('  番号: ' + (d.num || '(无)') + '  形态: ' + (d.vip ? 'VIP 会员专享墙' : (d.hasPlayer ? '免费可播(页面内联配置)' : '无播放配置')));
    log('  desc: ' + d.desc.slice(0, 90));
    log('  标签: ' + (d.tags.join('、') || '(无)').slice(0, 90));
    const dir = resolveDir(r.text, vid_);
    log('  媒体目录: ' + (dir ? dir.src + ' → ' + dir.base : '(三级来源均未命中)'));
    if (d.playerUrl) log('  内联播放配置: ' + d.playerUrl);
    log('  猜你喜欢: ' + d.guessLove.length + ' 条');
    if (flag.raw) log('\n── RAW ──\n' + JSON.stringify({ ...d, guessLove: d.guessLove.length ? d.guessLove : [] }, null, 1).slice(0, 2500));
  },
  async related(base, a2) { // 「猜你喜欢」卡片
    const vid = a2 !== undefined ? a2 : arg1;
    if (!vid) die('用法: related <视频ID>');
    const r = await fetchPage(base, '/index.php/vod/play/id/' + parseInt(vid, 10) + '/sid/1/nid/1.html');
    const d = parseDetail(r.text);
    log('── 猜你喜欢 id=' + vid + ' ──');
    printCards(d.guessLove, flag);
  },
  async segs(base, a2) { // 裸切片枚举 + 合成全片 m3u8(AES-128/IV=0,KEY=logo.jpeg)
    const vid = a2 !== undefined ? a2 : arg1;
    if (!vid) die('用法: segs <视频ID> [--out=文件.m3u8]');
    const vid_ = parseInt(vid, 10);
    const r = await fetchPage(base, '/index.php/vod/play/id/' + vid_ + '/sid/1/nid/1.html');
    const dir = resolveDir(r.text, vid_);
    if (!dir) die('无法推导媒体目录(墙背景/内联配置/猜你喜欢自片卡片均未命中)');
    const qdir = await qualityDir(new URL(dir.base, base + '/').href);
    if (!qdir) die('质量目录探测失败(切片不存在/视频已删?)');
    const kr = await probe(qdir + '/logo.jpeg');
    log('── 切片枚举 id=' + vid_ + ' ──');
    log('  目录: ' + dir.src + ' → ' + qdir);
    log('  密钥 logo.jpeg: HTTP ' + kr + (kr === 200 ? '(16B AES-128 key,裸取)' : '(不可达!)'));
    const last = await findLast(qdir);
    if (last < 0) die('切片枚举失败(index000.jpeg 非 200)');
    log('  ✓ 共 ' + (last + 1) + ' 段,名义 ~' + Math.round((last + 1) * 3 / 60) + ' 分钟(AES-128-CBC/IV=0,hls.js 原生解密)');
    if (flag.out) {
      fs.writeFileSync(String(flag.out), synthM3u8(qdir, last));
      log('  ✓ 全片清单已落盘 ' + flag.out + '(' + (last + 1) + ' 段,hls.js/Artplayer 可直接播)');
    }
    if (flag.raw) log('  RAW: ' + JSON.stringify({ qdir, last, count: last + 1 }));
  },
  async lines(base, a2) { // 官方签名清单(vplayer 现取现签,真实 EXTINF;VIP 未购同样可签)
    const vid = a2 !== undefined ? a2 : arg1;
    if (!vid) die('用法: lines <视频ID> [--out=文件.m3u8]');
    const vid_ = parseInt(vid, 10);
    const r = await fetchPage(base, '/index.php/vod/play/id/' + vid_ + '/sid/1/nid/1.html');
    const dir = resolveDir(r.text, vid_);
    if (!dir) die('无法推导媒体目录');
    const qdir = await qualityDir(new URL(dir.base, base + '/').href);
    if (!qdir) die('质量目录探测失败');
    const path = qdir + '/index.m3u8';
    log('── 官方签名线路 id=' + vid_ + ' ──');
    const text = await officialM3u8(base, path);
    const segs = text.split('\n').filter(l => l && !l.startsWith('#')).length;
    const total = (text.match(/#EXTINF:([\d.]+)/g) || []).reduce((a, s) => a + parseFloat(s.split(':')[1]), 0);
    log('  ✓ vplayer 签名清单: ' + segs + ' 段,总时长 ' + Math.round(total) + 's(= ' + Math.floor(total / 60) + ':' + String(Math.round(total % 60)).padStart(2, '0') + '),真实 EXTINF');
    if (flag.out) {
      fs.writeFileSync(String(flag.out), text);
      log('  ✓ 清单已落盘 ' + flag.out + '(切片/密钥已绝对化;sign 仅签清单本体——切片零鉴权可直用)');
    }
    if (flag.raw) log('  RAW 头部: ' + text.split('\n').slice(0, 6).join(' | ').slice(0, 200));
  },
  async key(base, a2) { // 密钥探测(hex 查看)
    const vid = a2 !== undefined ? a2 : arg1;
    if (!vid) die('用法: key <视频ID>');
    const vid_ = parseInt(vid, 10);
    const r = await fetchPage(base, '/index.php/vod/play/id/' + vid_ + '/sid/1/nid/1.html');
    const dir = resolveDir(r.text, vid_);
    if (!dir) die('无法推导媒体目录');
    const qdir = await qualityDir(new URL(dir.base, base + '/').href);
    if (!qdir) die('质量目录探测失败');
    const res = await http(qdir + '/logo.jpeg');
    const buf = Buffer.from(await res.arrayBuffer());
    log('── 密钥 logo.jpeg id=' + vid_ + ' ──');
    log('  HTTP ' + res.status + '  ' + buf.length + 'B  hex=' + buf.toString('hex'));
    log('  (AES-128-CBC 密钥本体,IV=0;站方清单 KEY 行同款)');
  },
  async trace(base) { // 任意站内 URL 重定向链取证(含挑战过门)
    if (!arg1) die('用法: trace <完整URL>');
    let cur = arg1, hops = 0;
    log('── 重定向链 ' + cur.replace(/^https?:\/\//, '').slice(0, 70) + ' ──');
    while (hops++ < 10) {
      const res = await http(cur);
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        log('  ' + res.status + ' → ' + res.headers.get('location').replace(/^https?:\/\//, '').slice(0, 96));
        cur = new URL(res.headers.get('location'), cur).href;
        continue;
      }
      const ct = res.headers.get('content-type') || '?';
      const text = await res.text();   // 2xx/4xx:读体判挑战壳
      if (/document\.cookie\s*=\s*"verify_token=pass/.test(text) && text.length < 512) { jar.set('verify_token', 'pass'); continue; }
      const len = res.headers.get('content-length') || text.length;
      log('  ' + res.status + '  ' + ct + '  ' + len + 'B  ' + cur.replace(/^https?:\/\//, '').slice(0, 96));
      break;
    }
  },
};

// ============ 7. 主流程 ============

(async () => {
  const base = String(flag.base || DEFAULT_BASE).replace(/\/+$/, '');
  if (cmd === 'all') {
    // 总览:类型列表 → 首片详情 → 官方签名清单(失败回退切片枚举),串行防请求风暴
    log('── 总览(' + base + ',挑战自动过)──');
    const r = await fetchPage(base, '/index.php/vod/type/id/1.html');
    const cards = parseCards(r.text);
    log('· 类型1(推荐)' + cards.length + ' 条,首片 [' + (cards[0] && cards[0].id) + ']');
    if (cards[0]) {
      await COMMANDS.video(base, String(cards[0].id));
      try { await COMMANDS.lines(base, String(cards[0].id)); }
      catch (e) { log('  × 官方签名清单失败(' + e.message + '),回退切片枚举…'); await COMMANDS.segs(base, String(cards[0].id)); }
    }
    log('✔ 总览完成(基地址 ' + base + ')');
  } else {
    const fn = COMMANDS[cmd];
    if (!fn) die('未知命令 "' + cmd + '"(可用: ' + Object.keys(COMMANDS).join(' / ') + ')');
    await fn(base, arg1);
  }
  process.exitCode = process.exitCode || 0;   // 不强杀:Node24/win 下 process.exit 会触发 libuv 句柄断言,自然排空
})().catch(e => { if (e.message !== '__DIE__') { console.error('✘ ' + e.message); process.exitCode = 1; } });
