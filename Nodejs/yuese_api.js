#!/usr/bin/env node
'use strict';
/**
 * yuese_api.js —— 月色视频站视频类只读 API 爬取器(Node.js 版,零依赖,需 Node>=18)
 *
 * 逆向结论(2026-10-06,授权测试环境实测):
 *   1. 站点为 Flutter Web,API 走同源 /api/ 路径(包内另有 api.cloud{visi,tunings,neurals,
 *      deeps,bulks}.com 五个备用网关,直连返回 error 9527,同源路径无此问题);
 *   2. 全部为裸 GET,无 token/无签名/无自定义头,浏览器 UA 即可;
 *   3. 响应统一形如 {"error":0,"message":"请求成功","content":C}:
 *        - 常规:C = {"encrypt":1,"encryptData":"<base64>"},AES-128-CBC(key=iv=
 *          "LqzCOd16vnYhOHTz",PKCS7)解密得明文 JSON——密钥提取自 main.dart.js
 *          的解密函数 bNZ(key/iv 同一字符串硬编码,密钥若轮换需回包里重提);
 *        - 少数接口(tags 等)content 里再嵌一层 {error,content} 壳,需递归剥;
 *        - 图片/截图 URL 带 .aes 后缀,同为该密钥加密的图片,不在本脚本范围。
 *
 * 端点清单(只读部分,全部实测通过;vote/flag/fav 等写操作刻意不实现):
 *   /api/videos/index_byall                首页聚合(最新视频+导航+公告+广告开关)
 *   /api/videos/classification             分类列表
 *   /api/videos/index?page&size&sort&categories   视频列表(分类过滤/排序/分页)
 *       sort ∈ post_date(最新)|video_viewed(热门)|rating|most_popular(最受欢迎)
 *       注意分类参数名是复数 categories(单数 category_id 会被服务端忽略变成全库)
 *   /api/videos/tags                       标签列表
 *   /api/videos/search?keyword&page&size   搜索(参数名单数 keyword,复数会被忽略)
 *   /api/videos/search_keywords            无参,返回站方固定热词榜(不随输入变化)
 *   /api/videos/detail?id[&line_idx]       视频详情
 *   /api/videos/related?id&page&size       视频下方「猜你喜欢」(支持分页)
 *   /api/videos/dvds?page&size[&group_id&sort]  专辑(碟片)列表
 *   /api/videos/list_bydvd?dvd_id&page&size&sort=title_asc 按专辑取视频
 *   /api/videos/list_bytags?tags&page&size&sort 按标签取视频(参数名 tags,传标签ID)
 *
 * 用法(基地址默认经发布页 yuese04/05/06.cc 实时解析,也可 --base 直指):
 *   node yuese_api.js                        # 全端点总览(逐个跑,输出摘要)
 *   node yuese_api.js home                   # 首页聚合
 *   node yuese_api.js categories             # 分类列表
 *   node yuese_api.js list --category=1 --page=2 --size=24 --sort=video_viewed
 *   node yuese_api.js tags                   # 标签列表
 *   node yuese_api.js search 关键词 --page=1 --size=10
 *   node yuese_api.js suggest                # 热词榜
 *   node yuese_api.js detail 145897          # 视频详情
 *   node yuese_api.js related 145897         # 猜你喜欢(--page 翻页)
 *   node yuese_api.js dvds --page=1
 *   node yuese_api.js bydvd 2 --page=1       # 专辑内视频
 *   node yuese_api.js bytag 96 --page=1      # 标签内视频(传标签ID)
 *   通用旗标:--base=https://ys.xxx.icu(跳过发布页解析)
 *           --raw(输出完整解密 JSON)  --no-title(摘要隐藏标题,便于留档)
 * 退出码:0=成功;1=失败。仅供站方授权测试使用。
 */

// ============ 0. 常量与命令行 ============

const PUBLISH_ENTRIES = ['yuese04.cc', 'yuese05.cc', 'yuese06.cc']; // 发布页(站群轮换)
const AES_KEY = Buffer.from('LqzCOd16vnYhOHTz', 'utf8');            // key=iv,16 字节
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;
const MAX_HOPS = 3;   // 发布页→中转页 JS 跳转最大跟进层数

const argv = process.argv.slice(2);
const flag = {};
for (const a of argv) {
  const m = a.match(/^--([a-z][a-z_-]*)(?:=(.*))?$/); // 支持 --no-title 这类带连字符旗标
  if (m) flag[m[1]] = m[2] !== undefined ? m[2] : true;
}
const positional = argv.filter(a => !a.startsWith('--'));
flag.noTitle = flag['no-title']; // 连字符旗标别名,摘要打印统一读 flag.noTitle
const cmd = positional[0] || 'all';
const arg1 = positional[1];
const num = (k, d) => (flag[k] !== undefined ? parseInt(flag[k], 10) : d);

const log = (...a) => console.log(...a);
const die = (msg) => { console.error('✘ ' + msg); process.exit(1); };

// ============ 1. 基地址解析(发布页→中转页→最新地址,内嵌自 yuese.js 同源逻辑) ============

async function fetchText(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('超时')), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow', signal: ac.signal,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    return { status: res.status, text: await res.text() };
  } finally { clearTimeout(timer); }
}

const extractRedirect = html => (html.match(/location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i) || [])[1]
  || (html.match(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']?\s*\d+\s*;\s*url\s*=\s*([^"'>\s]+)/i) || [])[1]
  || null;

function grabVar(html, name) { // 中转页 var xxx=<JSON字面量>;
  const m = html.match(new RegExp('var\\s+' + name + '\\s*=\\s*(\\[[\\s\\S]*?\\]|"(?:[^"\\\\]|\\\\.)*")\\s*;'));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}
const decodeCodes = codes => Array.isArray(codes) ? codes.map(c => String.fromCharCode(c)).join('') : '';

// 返回最新地址数组(如 ['https://ys.xxx.icu', ...]),--base 时单元素
async function resolveBases() {
  if (flag.base) return [String(flag.base).replace(/\/+$/, '')];
  for (const host of PUBLISH_ENTRIES) {
    try {
      let url = 'https://' + host + '/';
      for (let hop = 0; hop <= MAX_HOPS; hop++) {
        const r = await fetchText(url);
        const d = grabVar(r.text, 'domainsH5Codes');
        if (d) {
          const latest = d.map(decodeCodes).filter(Boolean);
          if (latest.length) { log('· 发布页 ' + host + ' → 最新地址: ' + latest.join(' , ')); return latest.map(u => u.replace(/\/+$/, '')); }
        }
        const next = extractRedirect(r.text);
        if (!next) break;
        url = next;
      }
    } catch (e) { /* 换下一入口 */ }
  }
  die('发布页解析失败(可用 --base=https://ys.xxx.icu 手动指定)');
}

// ============ 2. API 客户端(GET→剥壳→解密,失败换下一基地址) ============

function decryptContent(c) {
  if (c && c.encrypt === 1 && typeof c.encryptData === 'string') {
    const d = require('crypto').createDecipheriv('aes-128-cbc', AES_KEY, AES_KEY);
    return JSON.parse(Buffer.concat([d.update(Buffer.from(c.encryptData, 'base64')), d.final()]).toString('utf8'));
  }
  return c;
}

function unwrap(j) { // 外层 {error,message,content};少数接口 content 内再嵌一层同构壳
  let c = j.content;
  c = decryptContent(c);
  if (c && typeof c === 'object' && !Array.isArray(c) && c.error === 0 && 'content' in c) c = unwrap(c);
  return c;
}

async function apiGet(bases, path) {
  let lastErr = null;
  for (const base of bases) {
    try {
      const r = await fetchText(base + path);
      if (r.status >= 400) { lastErr = new Error('HTTP ' + r.status + ' @' + base); continue; }
      let j;
      try { j = JSON.parse(r.text); } catch (e) { lastErr = new Error('非 JSON 响应 @' + base); continue; }
      if (j.error !== 0) throw new Error('接口报错 error=' + j.error + ' message=' + (j.message || '') + ' @' + path);
      try { return unwrap(j); } catch (e) { throw new Error('解密失败(密钥可能已轮换,请回 main.dart.js 重提): ' + e.message); }
    } catch (e) {
      if (/接口报错|解密失败/.test(e.message)) throw e; // 业务/密钥错误换基址无意义
      lastErr = e;
    }
  }
  throw lastErr || new Error('全部基地址不可达');
}

// ============ 3. 摘要打印 ============

const fmtDur = s => s == null ? '?' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
const mask = (t, on) => on ? '<标题已隐藏>' : String(t == null ? '' : t).slice(0, 42);

function printPagedList(x, opt = {}) {
  if (!x || !Array.isArray(x.data)) { log('  (无 data 数组)'); return; }
  log('  共 ' + x.total + ' 条  第 ' + x.current_page + '/' + x.last_page + ' 页  每页 ' + x.per_page);
  for (const v of x.data) log('   [' + v.video_id + '] ' + fmtDur(v.duration) + (v.is_hd ? ' HD' : '  ') + ' ' + mask(v.title, opt.noTitle));
}
function printDictList(arr, keyId, keyName, keyCount, opt) {
  log('  共 ' + arr.length + ' 项:');
  for (const it of arr) log('   [' + it[keyId] + '] ' + mask(it[keyName], opt.noTitle) + (keyCount ? '  (' + it[keyCount] + ')' : ''));
}

// ============ 4. 命令表 ============

const COMMANDS = {
  async home(a) { // 首页聚合:最新视频 + 导航 + 公告 + 广告开关
    const x = await a('/api/videos/index_byall');
    log('── 首页聚合 index_byall ──');
    log('  ENCRYPT=' + x.ENCRYPT + ' OPEN_AD=' + x.OPEN_AD + ' nav_list=' + (x.nav_list || []).length + ' 项');
    if (x.notice && x.notice.content) log('  公告: ' + String(x.notice.content).replace(/<[^>]+>/g, '').slice(0, 60));
    printPagedList(x.list_new, flag);
  },
  async categories(a) { // 分类列表
    const x = await a('/api/videos/classification');
    log('── 分类列表 classification ──');
    printDictList(x, 'category_id', 'title', 'total_videos', flag);
  },
  async list(a) { // 视频列表(可按分类/排序/分页;分类参数服务端要复数 categories)
    const p = new URLSearchParams({ page: num('page', 1), size: num('size', 24), sort: flag.sort || 'post_date' });
    const cat = flag.category !== undefined ? flag.category : flag.category_id;
    if (cat) p.set('categories', cat);
    const x = await a('/api/videos/index?' + p);
    log('── 视频列表 index' + (cat ? ' categories=' + cat : '') + ' sort=' + p.get('sort') + ' ──');
    printPagedList(x, flag);
  },
  async tags(a) { // 标签列表
    const x = await a('/api/videos/tags');
    log('── 标签列表 tags ──');
    printDictList(x, 'tag_id', 'tag', 'total_videos', flag);
  },
  async search(a) { // 搜索(服务端参数名单数 keyword,传复数会被静默忽略变全库)
    const kw = arg1;
    if (!kw) die('用法: search <关键词> [--page=N] [--size=N]');
    const p = new URLSearchParams({ keyword: kw, page: num('page', 1), size: num('size', 10) });
    const x = await a('/api/videos/search?' + p);
    log('── 搜索 "' + kw + '" ──');
    printPagedList(x, flag);
  },
  async suggest(a) { // 固定热词榜(端点无参,与输入无关)
    const x = await a('/api/videos/search_keywords');
    log('── 热词榜 search_keywords ──');
    log('  ' + JSON.stringify(x));
  },
  async detail(a, a2) { // 视频详情(a2 供 all 总览显式传 ID)
    const vid = a2 !== undefined ? a2 : arg1;
    if (!vid) die('用法: detail <视频ID>');
    const x = await a('/api/videos/detail?id=' + parseInt(vid, 10));
    log('── 视频详情 id=' + vid + ' ──');
    for (const [k, v] of Object.entries(x)) {
      if (k === 'title') { log('  title: ' + mask(v, flag.noTitle)); continue; }
      if (typeof v !== 'object' || v === null) log('  ' + k + ': ' + v);
      else log('  ' + k + ': ' + JSON.stringify(v).slice(0, 80));
    }
  },
  async related(a, a2) { // 猜你喜欢(视频下方推荐;支持翻页,a2 供 all 总览显式传 ID)
    const vid = a2 !== undefined ? a2 : arg1;
    if (!vid) die('用法: related <视频ID> [--page=N] [--size=N]');
    const p = new URLSearchParams({ id: parseInt(vid, 10), page: num('page', 1), size: num('size', 8) });
    const x = await a('/api/videos/related?' + p);
    log('── 猜你喜欢 related id=' + vid + ' ──');
    printPagedList(x, flag);
  },
  async dvds(a) { // 专辑列表
    const x = await a('/api/videos/dvds?page=' + num('page', 1) + '&size=' + num('size', 24));
    log('── 专辑列表 dvds ──');
    printPagedList(x, flag);
  },
  async bydvd(a) { // 专辑内视频(服务端默认 sort=title_asc)
    if (!arg1) die('用法: bydvd <dvd_id> [--page=N]');
    const x = await a('/api/videos/list_bydvd?dvd_id=' + parseInt(arg1, 10) + '&page=' + num('page', 1) + '&size=' + num('size', 10) + '&sort=title_asc');
    log('── 专辑视频 list_bydvd dvd_id=' + arg1 + ' ──');
    printPagedList(x, flag);
  },
  async bytag(a) { // 标签内视频(参数名 tags,传标签ID)
    if (!arg1) die('用法: bytag <tag_id> [--page=N]');
    const x = await a('/api/videos/list_bytags?tags=' + parseInt(arg1, 10) + '&page=' + num('page', 1) + '&size=' + num('size', 10));
    log('── 标签视频 list_bytags tags=' + arg1 + ' ──');
    printPagedList(x, flag);
  },
};

// ============ 5. 主流程 ============

(async () => {
  const bases = await resolveBases();
  let lastData = null;
  const api = async path => { log('  → GET ' + path); lastData = await apiGet(bases, path); return lastData; };

  if (cmd === 'all') {
    // 总览:逐端点跑一遍(串行,防请求风暴),取每类第一条的 video_id 供后续深入
    const id = num('id', 0);
    await COMMANDS.home(api);
    await COMMANDS.categories(api);
    await COMMANDS.tags(api);
    await COMMANDS.list(api);
    const firstId = (lastData && lastData.data && lastData.data[0] && lastData.data[0].video_id) || id;
    await COMMANDS.detail(api, firstId);
    await COMMANDS.related(api, firstId);
    await COMMANDS.dvds(api);
    log('✔ 全端点总览完成(基地址 ' + bases[0] + ')');
  } else {
    const fn = COMMANDS[cmd];
    if (!fn) die('未知命令 "' + cmd + '"(可用: ' + Object.keys(COMMANDS).join(' / ') + ')');
    await fn(api, arg1);
  }
  if (flag.raw) log('\n── RAW ──\n' + JSON.stringify(lastData, null, 2));
  process.exitCode = 0; // 不用 process.exit:Node24/win 下强杀会触发 libuv 句柄断言,自然排空即可
})().catch(e => die(e.message));
