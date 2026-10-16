#!/usr/bin/env node
'use strict';
/**
 * zimuquan_api.js —— 字母圈(maccms MDskin/MaDouYM 模板)视频类只读 API 爬取器
 *                    (Node.js 版,零依赖,需 Node>=18)
 *
 * 逆向结论(2026-10-06,授权测试环境实测,发布页 zmqurl7.top 系入口域全部同壳同库):
 *   1. 站群无独立 JSON API——数据面 = maccms 服务端直出 HTML,但整页包一层反扒壳:
 *      首个 <script> 为 window.addEventListener("load",…document.write(
 *      decodeURIComponent(atob("<base64>"))))——Base64+URI 双层编码,
 *      解码即得明文 HTML(零 VM 沙箱需求,比 avjb 的 jsjiami 壳友好得多);
 *   2. 入口域无 rsso2 挑战无年龄门,GET 即回编码壳;零 cookie 依赖
 *      (Set-Cookie server_session_* 发而不校验,爬虫可不带);
 *   3. 视频卡片区(maccms 标准):<a href=/index.php/vod/play/id/{id}/sid/1/nid/1.html
 *      class="col-5"> → .subtitle 标题 / .time 时长(00:02:54)/ .hits N次播放 /
 *      data-src 封面(efvN 系视频主机直链,ACAO:* 可热链)/ 角标 div:
 *      vip=VIP专享 gold=金币付费 welfare=免费(付费标记仅供识别,购买写操作不实现);
 *   4. 播放页即详情页(voddetail 404,无独立详情路由):
 *      - 免费/福利片:内联 var player_aaaa={"url":"https://efvN/movie/auto/{mid}.m3u8
 *        ?counts=5&timestamp=…&key=…",…} —— 签名主清单直给(零鉴权,无 Referer 要求);
 *      - VIP/金币片:无 player_aaaa,代之以付费墙弹窗 <div class="popup-text">
 *        「此影片为VIP专享…」/「本视频为金币付费…」——如实报形态;
 *   5. m3u8 链路两级:主清单(单 variant,绝对 URL 自带二级签名)→ 子清单
 *      (#EXT-X-KEY:AES-128 的 key URI 与 indexN.ts 均为相对路径,hls.js 自动按清单
 *      URL 解析;主/子/ts/key 实测全部 ACAO:*,Range 全开,浏览器直连无碍;
 *      签名时效分钟级,页面现取现用,勿长缓存——子清单重放偶发 403 属签名过期);
 *   6. 分页/排序形态:maccms 路径段式——
 *        片库 /index.php/vod/show/by/{time|hits_week|up}/id/{cat}/page/{n}.html
 *        (cat=1 为全部;by/{sort} 缺省=by/time;show/type 两种前缀等价可互换)
 *        搜索 /index.php/vod/search/page/{n}/wd/{关键词URL编码}.html
 *        专题 /index.php/topic/detail/id/{tid}.html?page={n}(query 式分页)
 *      页脚 page_tip「共72218条数据,当前1/2889页」给总数与总页数;
 *   7. 其余只读面:排行榜 /index.php/label/rank.html(日榜/周榜/月榜三段同卡片);
 *      专题索引 /index.php/topic/index.html(.movie「N部影片」给数量);
 *      分类导航 vod/type/id/{N}.html 全站 header 同源(15 个内容分区+片库);
 *      封面热链零成本(efvN 主机 ACAO:* 无 Referer 校验);
 *   8. 登录态(VIP/金币购买/收藏/点赞)刻意不实现——游客态已覆盖全部只读需求。
 *
 * 端点/页面清单(只读部分,全部实测通过):
 *   页面 /                                        首页(公告/轮播/最近更新/各分区)
 *        /index.php/vod/show/by/{sort}/id/{cat}/page/{n}/   片库列表(排序+分页)
 *        /index.php/vod/search/page/{n}/wd/{kw}/            搜索(路径编码)
 *        /index.php/label/rank.html              排行榜(日/周/月榜)
 *        /index.php/topic/index.html             专题索引
 *        /index.php/topic/detail/id/{tid}/       专题内视频(?page=N)
 *        /index.php/vod/play/id/{id}/sid/1/nid/1.html  播放页=详情页(含相关推荐)
 *   播放 {efvN}/movie/auto/{mid}.m3u8?counts=5&…  签名主清单(播放页现取)
 *
 * 用法(基地址默认 https://www2.zimuquan16.com,换批用 node zimuquan.js 查最新):
 *   node zimuquan_api.js                          # 总览:分类 → 片库首页 → 首片详情 → m3u8 链路
 *   node zimuquan_api.js list [--page=2] [--cat=8] [--sort=time|hits_week|up]   # 片库列表
 *   node zimuquan_api.js search 关键词 [--page=1] # 搜索
 *   node zimuquan_api.js categories               # 分区索引(导航解析,id+名)
 *   node zimuquan_api.js rank                     # 排行榜(日/周/月榜三段)
 *   node zimuquan_api.js topics                   # 专题索引(名称+影片数)
 *   node zimuquan_api.js topic 13 [--page=2]      # 专题内视频
 *   node zimuquan_api.js video 4902               # 视频详情(标题/日期/付费形态/m3u8/相关)
 *   node zimuquan_api.js related 4902             # 相关推荐(播放页「猜你喜欢」)
 *   node zimuquan_api.js lines 4902               # m3u8 链路探测(主/子清单/段数/时长/加密)
 *   node zimuquan_api.js m3u8 4902 [--out=x.m3u8] # 子清单绝对化落盘(本地播放器可直用)
 *   通用旗标:--base=https://…  --raw(输出完整 JSON)  --no-title(摘要隐藏标题)
 *           --out=<file>(m3u8 落盘路径)
 * 退出码:0=成功;1=失败。仅供站方授权测试使用。
 */

// ============ 0. 常量与命令行 ============

const DEFAULT_BASE = 'https://www2.zimuquan16.com';   // 发布页「最新网址」(轮换后用 zimuquan.js 查)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;
const SORTS = { time: '最新', hits_week: '最热', up: '最赞' };   // 片库排序(站点原生值)

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

// ============ 1. HTTP 底座(编码壳解包) ============

async function http(url, { referer, range } = {}) {
  const headers = {
    'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  if (referer) headers['Referer'] = referer;
  if (range) headers['Range'] = range;
  return fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers });
}

// 反扒壳解包:整页 <script>…document.write(decodeURIComponent(atob("…")))…
// Base64+URI 双层编码,一次解开即明文 HTML;无壳(已是明文)则原样返回
function unwrap(text) {
  const m = text.match(/atob\("([A-Za-z0-9+/=]+)"\)/);
  if (!m) return text;
  try { return decodeURIComponent(Buffer.from(m[1], 'base64').toString('utf8')); }
  catch (e) { return text; }
}

// 页面获取:GET → 解壳;非 200 抛错(站点无挑战门无重定向戏法)
async function fetchPage(base, path) {
  const url = path.startsWith('http') ? path : base + path;
  const res = await http(url, { referer: base + '/' });
  const text = unwrap(await res.text());
  if (res.status >= 400) throw new Error('HTTP ' + res.status + ' @' + url);
  if (!text || text.length < 500) throw new Error('页面过短(' + (text ? text.length : 0) + 'B,改版?) @' + url);
  return { status: res.status, url, text };
}

// ============ 2. 页面解析器(卡片/分类/榜单/专题/详情) ============

// 展示时长串("00:02:54"/"58:26")→ 秒;失败给 null
function parseDurStr(s) {
  const m = String(s || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  return (+m[1] || 0) * 3600 + (+m[2]) * 60 + (+m[3]);
}

// 视频卡片:<a href=/index.php/vod/play/id/{id}/… class="col-5"> 逐锚点切块,
// 角标 div: vip=VIP专享 gold=金币付费 welfare=免费(其余无角标=默认VIP区)
function parseCards(html) {
  const out = [];
  const ms = [...html.matchAll(/<a href="\/index\.php\/vod\/play\/id\/(\d+)[^"]*"[^>]*>/g)];
  for (let i = 0; i < ms.length; i++) {
    const end = ms[i].index + ms[i][0].length;
    const b = html.slice(end, i + 1 < ms.length ? Math.min(ms[i + 1].index, end + 2200) : end + 2200);
    const head = b.slice(0, 1600);
    // 列表卡 .subtitle / 相关推荐卡 .desc-title 两种标题形态
    const sm = head.match(/class="(?:subtitle|desc-title)">([^<]*)</);
    if (!sm) continue;
    const kind = /<div class="gold">/.test(head) ? 'coin' : /<div class="welfare">/.test(head) ? 'free' : 'vip';
    out.push({
      id: +ms[i][1],
      title: sm[1].trim(),
      kind,
      duration: (head.match(/class="time">([^<]*)</) || [, ''])[1].trim(),
      hits: +((head.match(/class="hits">(\d+)次播放/) || [, 0])[1]),
      thumb: (head.match(/data-src="([^"]+)"/) || [, ''])[1],
    });
  }
  return out;
}

function printCards(list, opt) {
  if (!list.length) { log('  (无卡片)'); return; }
  for (const v of list) {
    const kind = v.kind === 'free' ? '免费' : v.kind === 'coin' ? '金币' : 'VIP';
    log('   [' + v.id + '] ' + (v.duration || '--:--').padStart(8) + ' ' + kind.padEnd(4) +
      ' ' + String(v.hits || 0).padStart(6) + '次  ' + mask(v.title, opt.noTitle));
  }
}

// 分类导航:首页 header 的 vod/type/id/{N}.html(内容分区;片库 id=1=全部不单列);
// 兼容 show 页 classify 的 vod/show/id/{N}.html 形态,按 id 去重
function parseCategories(html) {
  const out = [];
  for (const m of html.matchAll(/href="\/index\.php\/vod\/(?:type|show)\/id\/(\d+)\.html"[^>]*>\s*([^<]{2,10})\s*</g)) {
    if (!out.some(c => c.id === m[1])) out.push({ id: m[1], name: m[2].trim() });
  }
  return out;
}

// 页脚总数:「共72218条数据,当前1/2889页」
function parsePageTip(html) {
  const m = html.match(/共(\d+)条数据,当前(\d+)\/(\d+)页/);
  return m ? { total: +m[1], page: +m[2], pages: +m[3] } : null;
}

// 排行榜:日榜/周榜/月榜三段(区块标题 span 后跟 <div class="cl"> 卡片流,段界=下一标题/页脚)
function parseRank(html) {
  const out = [];
  for (const m of html.matchAll(/<span>(日榜|周榜|月榜)<\/span>[\s\S]*?<div class="cl">([\s\S]*?)(?=<div class="title-rank|<footer|<div class="page_tip|$)/g)) {
    out.push({ name: m[1], cards: parseCards(m[2]) });
  }
  return out;
}

// 专题瓦片:<a href=/index.php/topic/detail/id/{tid}.html class="card …> → .movie「N部影片」/.subtitle/data-src
function parseTopics(html) {
  const out = [];
  const ms = [...html.matchAll(/<a href="\/index\.php\/topic\/detail\/id\/(\d+)\.html"[^>]*>/g)];
  for (let i = 0; i < ms.length; i++) {
    const end = ms[i].index + ms[i][0].length;
    const head = html.slice(end, i + 1 < ms.length ? ms[i + 1].index : end + 900).slice(0, 900);
    const sm = head.match(/class="subtitle">([^<]*)</);
    if (!sm) continue;
    out.push({
      id: ms[i][1],
      title: sm[1].trim(),
      count: +((head.match(/class="movie">(\d+)部影片/) || [, 0])[1]),
      thumb: (head.match(/data-src="([^"]+)"/) || [, ''])[1],
    });
  }
  return out;
}

// 播放页(=详情页)解析:player_aaaa(免费/福利片)或付费墙弹窗(VIP/金币片)
// 元数据:标题(operation-bottom 首个 li)/日期/点赞数(digg_num)/海报/分类标签/相关推荐
function parseDetail(html) {
  const d = {};
  const pm = html.match(/var player_aaaa=(\{.*?\})<\/script>/s);
  d.player = null;
  if (pm) {
    try {
      const j = JSON.parse(pm[1]);
      d.player = { url: j.url || '', poster: j.poster || '', trysee: j.trysee, points: j.points, name: (j.vod_data && j.vod_data.vod_name) || '' };
    } catch (e) { /* 忽略畸形 JSON */ }
  }
  // 付费墙形态(无 player_aaaa 时唯一判据)
  d.paywall = (html.match(/<div class="popup-text">([^<]*)</) || [, ''])[1].trim() ||
    (/此影片为VIP专享/.test(html) ? '此影片为VIP专享' : '');
  // 标题:operation-bottom 首个 li(与 player_aaaa.vod_name 同源)
  d.title = '';
  const oi = html.indexOf('class="operation-bottom"');
  if (oi >= 0) {
    const seg = html.slice(oi, oi + 1200);
    d.title = (seg.match(/<li>([^<]*)<\/li>/) || [, (d.player && d.player.name) || ''])[1].trim();
    d.category = (seg.match(/class="category">([^<]*)</) || [, ''])[1].trim();
    d.uploadDate = (seg.match(/<span>(\d{4}-\d{2}-\d{2})<\/span>/) || [, ''])[1];
  }
  if (!d.title && d.player) d.title = d.player.name;
  d.digg = +((html.match(/class="digg_num">(\d+)</) || [, 0])[1]);
  d.poster = (d.player && d.player.poster) || (html.match(/background-image:\s*url\((https?:\/\/[^)]+)\)/) || [, ''])[1];
  d.hits = +((html.match(/(\d+)次播放/) || [, 0])[1]);
  // 相关推荐:播放页「猜你喜欢」侧栏(#scrollBar 容器内,卡片为 desc-title/desc-read 形态)
  const rb = html.split('id="scrollBar"').pop() || '';
  d.related = parseCards(rb.split('</ul>')[0]);
  return d;
}

// ============ 3. m3u8 链路(主清单→子清单→段/密钥) ============

// 主清单:单 variant,行末即子清单绝对 URL(自带二级签名)
async function fetchMaster(masterUrl, base) {
  const res = await http(masterUrl, { referer: base + '/' });
  const text = await res.text();
  if (res.status >= 400) throw new Error('主清单 HTTP ' + res.status + '(签名过期?重跑刷新)');
  const sub = text.trim().split('\n').filter(l => l && !l.startsWith('#')).pop();
  const varm = text.match(/RESOLUTION=(\d+)x(\d+)/);
  return { status: res.status, sub, width: varm ? +varm[1] : 0, height: varm ? +varm[2] : 0, text };
}

// 子清单:EXTINF 累计时长/段数/AES-128 密钥与 IV;绝对化改写供落盘
async function fetchSub(subUrl, base) {
  const res = await http(subUrl, { referer: base + '/' });
  const text = await res.text();
  if (res.status >= 400) throw new Error('子清单 HTTP ' + res.status + '(签名分钟级时效,重跑刷新)');
  const lines = text.split('\n');
  let dur = 0, count = 0;
  for (const l of lines) {
    const m = l.match(/^#EXTINF:([\d.]+),/);
    if (m) { dur += +m[1]; count++; }
  }
  const key = text.match(/^#EXT-X-KEY:METHOD=AES-128,URI="([^"]+)"/m);
  const iv = text.match(/^#EXT-X-KEY:[^\n]*IV=(0x[0-9a-fA-F]+)/m);
  return {
    status: res.status, duration: dur, count,
    keyUri: key ? new URL(key[1], subUrl).href : '',   // 相对 URI 按清单 URL 绝对化
    iv: iv ? iv[1] : '',
    text,
    absolutize() {   // 密钥与切片绝对化(hls.js 在线播自动做;落盘后本地播放器需要)
      return lines.map(l => (l && !l.startsWith('#')) ? new URL(l, subUrl).href : l
        .replace(/URI="([^"]+)"/, (s, u) => 'URI="' + new URL(u, subUrl).href + '"')).join('\n');
    },
  };
}

// ============ 4. 摘要打印 ============

const fmtDur = s => s == null ? '?' : Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
const mask = (t, on) => on ? '<标题已隐藏>' : String(t == null ? '' : t).slice(0, 42);
const fs = require('fs');

// ============ 5. 命令表 ============

const COMMANDS = {
  async list(base) { // 片库列表(排序+分类+分页,路径段式)
    const p = num('page', 1);
    const cat = String(flag.cat || '1');
    const sort = SORTS[flag.sort] ? flag.sort : 'time';
    const path = '/index.php/vod/show/by/' + sort + '/id/' + cat + '/page/' + p + '.html';
    const r = await fetchPage(base, path);
    const tip = parsePageTip(r.text);
    log('── 片库 /show/by/' + sort + '/id/' + cat + '/ ' + (SORTS[sort] || sort) + ' ──');
    if (tip) log('  共 ' + tip.total + ' 条,第 ' + tip.page + '/' + tip.pages + ' 页');
    printCards(parseCards(r.text), flag);
  },
  async search(base) { // 搜索(路径编码,分页路径段)
    const kw = arg1;
    if (!kw) die('用法: search <关键词> [--page=N]');
    const p = num('page', 1);
    const r = await fetchPage(base, '/index.php/vod/search/page/' + p + '/wd/' + encodeURIComponent(kw) + '.html');
    const tip = parsePageTip(r.text);
    log('── 搜索 "' + kw + '" 第 ' + p + ' 页 ──');
    if (tip) log('  共 ' + tip.total + ' 条,第 ' + tip.page + '/' + tip.pages + ' 页');
    printCards(parseCards(r.text), flag);
  },
  async categories(base) { // 分区索引(首页 header 导航解析,全集在首页而非 show 页)
    const r = await fetchPage(base, '/');
    const cats = parseCategories(r.text);
    log('── 分区索引(片库 id=1=全部)──');
    if (!cats.length) return log('  (导航无 vod/type|show 链接,页面改版?)');
    for (const c of cats) log('   [' + c.id + '] ' + mask(c.name, flag.noTitle));
  },
  async rank(base) { // 排行榜(日/周/月榜)
    const r = await fetchPage(base, '/index.php/label/rank.html');
    const secs = parseRank(r.text);
    log('── 排行榜 /label/rank.html ──');
    if (!secs.length) return log('  (未解析到榜单区块,页面改版?)');
    for (const s of secs) { log('  ◆ ' + s.name + '(' + s.cards.length + ' 条)'); printCards(s.cards, flag); }
  },
  async topics(base) { // 专题索引
    const r = await fetchPage(base, '/index.php/topic/index.html');
    const ts = parseTopics(r.text);
    log('── 专题索引 /topic/index.html ──');
    if (!ts.length) return log('  (无专题瓦片,页面改版?)');
    for (const t of ts) log('   [' + t.id + '] ' + mask(t.title, flag.noTitle) + '  (' + t.count + '部)');
  },
  async topic(base) { // 专题内视频(query 式分页)
    if (!arg1) die('用法: topic <专题id> [--page=N]');
    const r = await fetchPage(base, '/index.php/topic/detail/id/' + arg1 + '.html?page=' + num('page', 1));
    log('── 专题视频 /topic/detail/id/' + arg1 + '/ ?page=' + num('page', 1) + ' ──');
    printCards(parseCards(r.text), flag);
  },
  async video(base, a2) { // 视频详情(播放页一体)
    const vid = a2 !== undefined ? a2 : arg1;
    if (!vid) die('用法: video <视频ID>');
    const r = await fetchPage(base, '/index.php/vod/play/id/' + parseInt(vid, 10) + '/sid/1/nid/1.html');
    const d = parseDetail(r.text);
    log('── 视频详情 id=' + vid + ' ──');
    log('  title: ' + mask(d.title, flag.noTitle));
    log('  uploadDate: ' + (d.uploadDate || '?') + '  点赞: ' + d.digg + '  播放: ' + (d.hits || '?'));
    log('  付费形态: ' + (d.paywall ? '付费墙(' + d.paywall + ')' : '无(游客可播)'));
    log('  主清单: ' + (d.player && d.player.url ? d.player.url.replace(/^https?:\/\//, '').slice(0, 96) : '(无)'));
    log('  海报: ' + (d.poster ? d.poster.replace(/^https?:\/\//, '').slice(0, 70) : '-'));
    log('  分区: ' + (d.category || '(页面未标)'));
    log('  相关推荐: ' + d.related.length + ' 条(猜你喜欢侧栏)');
    if (flag.raw) log('\n── RAW ──\n' + JSON.stringify({ ...d, related: d.related.length ? d.related : [] }, null, 2).slice(0, 3000));
  },
  async related(base, a2) { // 相关推荐(播放页侧栏)
    const vid = a2 !== undefined ? a2 : arg1;
    if (!vid) die('用法: related <视频ID>');
    const r = await fetchPage(base, '/index.php/vod/play/id/' + parseInt(vid, 10) + '/sid/1/nid/1.html');
    const d = parseDetail(r.text);
    log('── 相关推荐 id=' + vid + ' ──');
    printCards(d.related, flag);
  },
  async lines(base, a2) { // m3u8 链路探测:主→子→段数/时长/加密形态
    const vid = a2 !== undefined ? a2 : arg1;
    if (!vid) die('用法: lines <视频ID>(仅免费/福利片有主清单)');
    const r = await fetchPage(base, '/index.php/vod/play/id/' + parseInt(vid, 10) + '/sid/1/nid/1.html');
    const d = parseDetail(r.text);
    log('── m3u8 链路 id=' + vid + ' ──');
    if (!d.player || !d.player.url) return log('  ✗ 无主清单(' + (d.paywall || '视频已删?') + ')');
    const m = await fetchMaster(d.player.url, base);
    log('  ✓ 主清单 ' + m.status + (m.height ? '(' + m.width + 'x' + m.height + ')' : '') + ': ' + d.player.url.replace(/^https?:\/\//, '').slice(0, 90));
    const s = await fetchSub(m.sub, base);
    log('  ✓ 子清单 ' + s.status + ': ' + m.sub.replace(/^https?:\/\//, '').slice(0, 90));
    log('    ' + s.count + ' 段,总时长 ' + fmtDur(Math.round(s.duration)) + '(=' + Math.round(s.duration) + 's)' +
      (s.keyUri ? ',AES-128 密钥' + (s.iv ? '(IV=' + s.iv + ')' : '(清单内 IV)') : ',明文'));
    log('    注:签名分钟级时效,过期重跑本命令刷新;ACAO:* 全开,hls.js/浏览器可直连');
    if (flag.raw) log('  RAW: ' + JSON.stringify({ master: d.player.url, sub: m.sub, count: s.count, duration: s.duration, key: s.keyUri, iv: s.iv }));
  },
  async m3u8(base, a2) { // 子清单绝对化落盘(密钥+切片绝对地址,本地 hls.js/mpv 可直用)
    const vid = a2 !== undefined ? a2 : arg1;
    if (!vid) die('用法: m3u8 <视频ID> [--out=文件.m3u8]');
    if (!flag.out) die('需要 --out=<文件.m3u8> 指定落盘路径');
    const r = await fetchPage(base, '/index.php/vod/play/id/' + parseInt(vid, 10) + '/sid/1/nid/1.html');
    const d = parseDetail(r.text);
    if (!d.player || !d.player.url) die('无主清单(' + (d.paywall || '视频已删?') + ')');
    const m = await fetchMaster(d.player.url, base);
    const s = await fetchSub(m.sub, base);
    fs.writeFileSync(String(flag.out), s.absolutize());
    log('✓ 已落盘 ' + flag.out + '(' + s.count + ' 段,' + fmtDur(Math.round(s.duration)) +
      ',密钥/切片已绝对化;签名分钟级时效,尽快播)');
  },
};

// ============ 6. 主流程 ============

(async () => {
  const base = String(flag.base || DEFAULT_BASE).replace(/\/+$/, '');
  if (cmd === 'all') {
    // 总览:首页(分区+公告)→ 片库首页 → 免费片详情 → m3u8 链路(串行,防请求风暴)
    const home = await fetchPage(base, '/');
    const cats = parseCategories(home.text);
    const notice = (home.text.match(/<div class="notice-text">\s*([\s\S]*?)\s*<\/div>/) || [, ''])[1].replace(/\s+/g, ' ');
    const r = await fetchPage(base, '/index.php/vod/show/by/time/id/1/page/1.html');
    const cards = parseCards(r.text);
    const tip = parsePageTip(r.text);
    log('── 总览(' + base + ',编码壳自动解)──');
    log('· 分区 ' + cats.length + ' 个;片库 ' + (tip ? '共 ' + tip.total + ' 条 ' + tip.pages + ' 页' : '?') +
      ',本页 ' + cards.length + ' 条,首片 [' + (cards[0] && cards[0].id) + ']');
    if (notice) log('· 站方公告: ' + notice.slice(0, 60) + '…');
    // 演示用片:优先免费片(片库首页可能全 VIP,回退免费区 cat=8)
    let free = cards.find(c => c.kind === 'free') || parseCards(home.text).find(c => c.kind === 'free');
    if (!free) {
      const fr = await fetchPage(base, '/index.php/vod/show/by/time/id/8/page/1.html');
      free = parseCards(fr.text)[0];
    }
    if (free) {
      await COMMANDS.video(base, String(free.id));
      await COMMANDS.lines(base, String(free.id));
    }
    log('✔ 总览完成(基地址 ' + base + ';轮换后 node zimuquan.js 查最新)');
  } else {
    const fn = COMMANDS[cmd];
    if (!fn) die('未知命令 "' + cmd + '"(可用: ' + Object.keys(COMMANDS).join(' / ') + ')');
    await fn(base, arg1);
  }
  process.exitCode = process.exitCode || 0;   // 不强杀:让事件循环自然排空
})().catch(e => { if (e.message !== '__DIE__') { console.error('✘ ' + e.message); process.exitCode = 1; } });
