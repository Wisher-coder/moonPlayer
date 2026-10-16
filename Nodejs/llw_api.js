#!/usr/bin/env node
'use strict';
/**
 * llw_api.js —— llw(萝莉窝,daga88n,MacCMS 站群·形态 A)视频类只读 API 爬取器
 * (Node.js 版,零依赖,需 Node>=18)
 *
 * 逆向结论(2026-10-06,授权测试环境实测,与懂色帝 dsd 同一套 MacCMS 源码):
 *   1. MacCMS 内核服务端直出 HTML,无独立 JSON API——数据面 = 页面解析(与 dsd 同构:
 *      video-item 卡片 / vod/type 分类 / search.html?wd= 搜索 / 播放页=详情页 /
 *      「猜你喜欢」相关区 / verify_token 挑战壳保险处理);
 *   2. 媒体全挂外部存储 pp.{标识}.top:22200/{日期}/{随机8}/(运营商标识轮换,从页面
 *      海报 URL 动态提取,勿硬编码),与 dsd 形态 B(本站 /video1 + sign 网关)不同:
 *      【全链零签名零时效】index.m3u8 主清单(单变体,BANDWIDTH/RESOLUTION)→
 *      hls/index.m3u8 子清单(随机名 .ts + hls/key.key 16B,AES-128-CBC,
 *      KEY 行无 IV ⇒ 媒体序列号作 IV,首段 IV=0;实测解密 TS 同步字节全命中);
 *   3. 唯一防线是【站群域 Referer 白名单】:清单/切片/密钥/海报不带 Referer 或带外部
 *      Referer(如 localhost)一律 403,带 daga88n.com 系 Referer 全 200——服务端
 *      现取现带即过,无挑战无时效(站内播放器同链路);子清单响应带 ACAO:* 仅对
 *      同 Referer 请求生效,跨源浏览器直连不可用;
 *   4. 媒体目录无公式,但每片在同页必有其一(与 dsd 同构三级):VIP 墙页 = 墙背景图
 *      .video-before-ad(absolute pp URL);免费片页 = player_aaaa.url(absolute
 *      index.m3u8);通用 = 「猜你喜欢」自片卡片 img(海报与清单/key/切片同目录);
 *   5. 页面无日期字段;时长在卡片 video-item-tag-duration(HH:MM:SS)/子清单真实
 *      EXTINF;VIP 标记 video-item-tag-is-vip;站内无 vplayer 签名网关(404)。
 *
 * 端点/页面清单(只读部分,全部实测通过):
 *   页面 /(首页=type122 强烈推荐第 1 页)
 *        /index.php/vod/type/id/{122|64|113|67|66|65}/[page/N/.]html
 *                                                         类型列表(122强烈推荐 64萝莉
 *                                                         113国外萝莉 67乱伦 66人兽 65猎奇)
 *        /index.php/vod/search.html?wd={kw}               搜索第 1 页
 *        /index.php/vod/search/page/N/wd/{kw}.html        搜索翻页
 *        /index.php/vod/search/tag/{tag}/[page/N/.]html   标签过滤
 *        /index.php/vod/play/id/{id}/sid/1/nid/1.html      播放页(=详情页)
 *   媒体 {pp基座}/{日期}/{随机8}/index.m3u8                主清单(须站群域 Referer)
 *        {pp基座}/{日期}/{随机8}/hls/index.m3u8            子清单(随机名 .ts + key.key)
 *        {pp基座}/{日期}/{随机8}/1.jpg                     海报(须站群域 Referer)
 *
 * 用法(基地址默认 https://daga88n.com;也可 --base=https://www.daga88n.com 等):
 *   node llw_api.js                          # 总览:类型列表 → 首片详情 → 真实清单+密钥
 *   node llw_api.js list [--page=2] [--type=64]          # 类型列表(缺省 122 强烈推荐)
 *   node llw_api.js search 关键词 [--page=1]             # 搜索
 *   node llw_api.js tag 标签词 [--page=1]                # 标签过滤
 *   node llw_api.js categories                          # 类型索引(逐类型实测标题/页深)
 *   node llw_api.js cat 64 [--page=1]                    # 类型内视频(cat = list --type= 别名)
 *   node llw_api.js video 13316                         # 详情(标题/时长/VIP形态/目录推导来源)
 *   node llw_api.js related 13316                       # 「猜你喜欢」卡片
 *   node llw_api.js lines 13316 [--out=x.m3u8]          # 真实清单直取(主→子,绝对化落盘)
 *   node llw_api.js key 13316                           # 密钥 key.key 探测(hex 查看)
 *   node llw_api.js trace <完整URL>                      # 任意站内/存储 URL 重定向链取证
 *   通用旗标:--base=https://daga88n.com  --raw(输出完整 JSON)
 *           --no-title(摘要隐藏标题)  --out=<file>(lines 清单落盘路径)
 * 退出码:0=成功;1=失败。仅供站方授权测试使用。
 */

// ============ 0. 常量与命令行 ============

const DEFAULT_BASE = 'https://daga88n.com';
const TYPE_NAMES = { 122: '强烈推荐', 64: '萝莉', 113: '国外萝莉', 67: '乱伦', 66: '人兽', 65: '猎奇' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;

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

// ============ 1. HTTP 底座(cookie jar + verify_token 挑战自动过 + Referer 白名单) ============

const jar = new Map();   // name → value(Set-Cookie 增量合并)
const cookieHeader = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');

function absorbSetCookie(res) {
  for (const line of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
    const [kv] = line.split(';');
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}

// 基本请求:浏览器头 + jar cookie + 显式 Referer(pp 存储系全链只认站群域 Referer,
// 一律带 base;页面带 Referer 无碍)
async function http(url, base, { range } = {}) {
  const headers = {
    'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/vnd.apple.mpegurl,image/*,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9', 'Referer': base + '/',
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
    const res = await http(cur, base);
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

// 列表卡片:<a href=…/vod/play/id/{id}/… class="video-item"> 块 → 标题/时长/VIP/海报
// (id 由配对的 href 序列回填;海报在 img 的 data-src,src 是占位图勿取)
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
      thumb: (b.match(/data-src="([^"]+)"/) || [, (b.match(/src="(https?:\/\/pp\.[^"]+)"/) || [, ''])[1]])[1],
    });
  }
  return out.filter(c => c.id && c.title);
}

// 播放页(=详情页)解析:标题/描述/标签/VIP形态/墙背景/内联播放配置/猜你喜欢
function parseDetail(html) {
  const d = {};
  d.title = (html.match(/<h2 class="ellipsis">([^<]*)</) || [, (html.match(/<title>([^<]*) - /) || [, ''])[1].trim()])[1].trim();
  d.desc = (html.match(/<div class="desc">([\s\S]*?)<\/div>/) || [, ''])[1].replace(/<[^>]*>/g, '').trim();
  d.tags = [...html.matchAll(/\/index\.php\/vod\/search\/tag\/([^".]+?)(?:\.html)?"/g)].map(m => decodeURIComponent(m[1]));
  d.vip = /VIP会员专享/.test(html);
  d.hasPlayer = /var player_aaaa=/.test(html);
  // 内联播放配置:player_aaaa 内的 pp 存储形态 url(绝对 index.m3u8;JSON 转义斜杠先还原再锚定)
  d.playerUrl = [...html.matchAll(/"url":"((?:[^"\\]|\\.)*)"/g)]
    .map(m => m[1].replace(/\\\//g, '/'))
    .find(u => /^https?:\/\/pp\.[a-z0-9.-]+:\d+\/.*index\.m3u8/i.test(u)) || '';
  d.wallBg = (html.match(/video-before-ad[^"]*"[^>]*style="background-image:\s*url\(([^)]+)\)/) || [, ''])[1];
  d.guessLove = parseRelated(html.split('guess-love-wrap').pop() || '');
  return d;
}

// 媒体目录推导(三级来源:VIP墙背景图 → player_aaaa.url → 猜你喜欢自片卡片;
// 形态 A 三处均为 absolute pp URL,统一去尾文件名即目录)
function resolveDir(html, vid) {
  const d = parseDetail(html);
  const trim = (u) => u ? u.replace(/\/[^/]+$/, '') : '';
  if (d.wallBg && /\/pp\.[a-z0-9.-]+:\d+\//i.test(d.wallBg)) return { base: trim(d.wallBg), src: 'VIP墙背景图' };
  if (d.playerUrl) return { base: trim(d.playerUrl), src: 'player_aaaa.url' };
  const self = d.guessLove.find(g => g.id === vid && /\/pp\.[a-z0-9.-]+:\d+\//i.test(g.thumb));
  if (self) return { base: trim(self.thumb), src: '猜你喜欢自片卡片' };
  return null;
}

// ============ 3. 媒体面(主清单→子清单,绝对化;全链仅 Referer 校验) ============

// 真实清单直取:主清单(master 单变体)→ 选最高 BANDWIDTH 变体 → 子清单;
// 返回 {text(切片/KEY 绝对化后的子清单), variant, segs, total}
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
  const pdir = plsUrl.replace(/\/[^/]+$/, '');   // 子清单内 KEY/切片为站内绝对路径(/日期/…)
  const out = text.split('\n').map(l => {
    if (!l || l.startsWith('#')) return l.replace(/URI="([^"]+)"/, (s, u) => 'URI="' + new URL(u, pdir + '/').href + '"');
    return new URL(l, pdir + '/').href;
  }).join('\n');
  const segs = out.split('\n').filter(l => l && !l.startsWith('#')).length;
  const total = (out.match(/#EXTINF:([\d.]+)/g) || []).reduce((a, s) => a + parseFloat(s.split(':')[1]), 0);
  return { text: out, variant: plsUrl, segs, total };
}

// 密钥:子清单 KEY 行指向的 key.key(16B);部分片子清单无 KEY 行(明文 TS)如实返回
async function fetchKey(base, dirUrl) {
  const { text } = await fetchPls(base, dirUrl);
  const km = text.match(/URI="([^"]+\.key)"/);
  if (!km) return { plain: true, url: '', status: 0, buf: Buffer.alloc(0) };
  const res = await http(km[1], base);
  return { plain: false, url: km[1], status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}

// ============ 4. 摘要打印 ============

const mask = (t, on) => on ? '<标题已隐藏>' : String(t == null ? '' : t).slice(0, 46);
const fs = require('fs');

function printCards(list, opt) {
  if (!list.length) { log('  (无卡片)'); return; }
  for (const v of list) {
    log('   [' + v.id + '] ' + (v.duration || '--:--').padStart(8) + '  ' + (v.vip ? 'VIP' : '免费').padEnd(4) +
      (v.hits ? String(v.hits).padStart(9) + '次' : '') + '  ' + mask(v.title, opt.noTitle));
  }
}

// ============ 5. 命令表 ============

const COMMANDS = {
  async list(base, type) { // 类型列表(122强烈推荐 64萝莉 113国外萝莉 67乱伦 66人兽 65猎奇)
    const t = String(type || flag.type || '122');
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
      const cards = parseCards(r.text).length || 1;
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
    if (!/video-box|video-info/.test(r.text)) die('播放页无内容(id=' + vid_ + ' 可能不存在)');
    const d = parseDetail(r.text);
    log('── 视频详情 id=' + vid_ + ' ──');
    log('  title: ' + mask(d.title, flag.noTitle));
    log('  形态: ' + (d.vip ? 'VIP 会员专享墙' : (d.hasPlayer ? '免费可播(页面内联配置)' : '无播放配置')));
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
  async lines(base, a2) { // 真实清单直取(主→子,真实 EXTINF;切片/密钥绝对化落盘)
    const vid = a2 !== undefined ? a2 : arg1;
    if (!vid) die('用法: lines <视频ID> [--out=文件.m3u8]');
    const vid_ = parseInt(vid, 10);
    const r = await fetchPage(base, '/index.php/vod/play/id/' + vid_ + '/sid/1/nid/1.html');
    const dir = resolveDir(r.text, vid_);
    if (!dir) die('无法推导媒体目录(墙背景/内联配置/猜你喜欢自片卡片均未命中)');
    log('── 真实清单 id=' + vid_ + ' ──');
    log('  目录: ' + dir.src + ' → ' + dir.base);
    const pls = await fetchPls(base, dir.base);
    log('  ✓ 变体: ' + pls.variant.replace(/^https?:\/\//, '').slice(0, 90));
    log('  ✓ ' + pls.segs + ' 段,总时长 ' + Math.round(pls.total) + 's(= ' + Math.floor(pls.total / 60) + ':' + String(Math.round(pls.total % 60)).padStart(2, '0') + '),真实 EXTINF(全链仅 Referer 校验,零签名零时效)');
    if (flag.out) {
      fs.writeFileSync(String(flag.out), pls.text);
      log('  ✓ 清单已落盘 ' + flag.out + '(切片/密钥已绝对化,须带 Referer 消费,如 mpv --referrer=' + base + '/)');
    }
    if (flag.raw) log('  RAW 头部: ' + pls.text.split('\n').slice(0, 6).join(' | ').slice(0, 200));
  },
  async key(base, a2) { // 密钥探测(hex 查看)
    const vid = a2 !== undefined ? a2 : arg1;
    if (!vid) die('用法: key <视频ID>');
    const vid_ = parseInt(vid, 10);
    const r = await fetchPage(base, '/index.php/vod/play/id/' + vid_ + '/sid/1/nid/1.html');
    const dir = resolveDir(r.text, vid_);
    if (!dir) die('无法推导媒体目录');
    const k = await fetchKey(base, dir.base);
    log('── 密钥 key.key id=' + vid_ + ' ──');
    if (k.plain) {
      log('  子清单无 KEY 行(明文 TS,无需解密)');
    } else {
      log('  HTTP ' + k.status + '  ' + k.buf.length + 'B  hex=' + k.buf.toString('hex'));
      log('  (' + k.url.replace(/^https?:\/\//, '').slice(0, 90) + ')');
      log('  (AES-128-CBC 密钥本体,KEY 行无 IV ⇒ 媒体序列号作 IV,hls.js 原生解密)');
    }
  },
  async trace(base) { // 任意站内/存储 URL 重定向链与 Referer 面取证(含挑战过门)
    if (!arg1) die('用法: trace <完整URL>');
    let cur = arg1, hops = 0;
    log('── 重定向链 ' + cur.replace(/^https?:\/\//, '').slice(0, 70) + ' ──');
    while (hops++ < 10) {
      const res = await http(cur, base);
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

// ============ 6. 主流程 ============

(async () => {
  const base = String(flag.base || DEFAULT_BASE).replace(/\/+$/, '');
  if (cmd === 'all') {
    // 总览:类型列表 → 首片详情 → 真实清单+密钥,串行防请求风暴
    log('── 总览(' + base + ')──');
    const r = await fetchPage(base, '/index.php/vod/type/id/122.html');
    const cards = parseCards(r.text);
    log('· 类型122(强烈推荐)' + cards.length + ' 条,首片 [' + (cards[0] && cards[0].id) + ']');
    if (cards[0]) {
      await COMMANDS.video(base, String(cards[0].id));
      await COMMANDS.lines(base, String(cards[0].id));
      await COMMANDS.key(base, String(cards[0].id));
    }
    log('✔ 总览完成(基地址 ' + base + ')');
  } else {
    const fn = COMMANDS[cmd];
    if (!fn) die('未知命令 "' + cmd + '"(可用: ' + Object.keys(COMMANDS).join(' / ') + ')');
    await fn(base, arg1);
  }
  process.exitCode = process.exitCode || 0;   // 不强杀:Node24/win 下 process.exit 会触发 libuv 句柄断言,自然排空
})().catch(e => { if (e.message !== '__DIE__') { console.error('✘ ' + e.message); process.exitCode = 1; } });
