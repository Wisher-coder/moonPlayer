#!/usr/bin/env node
'use strict';
/**
 * avjb_api.js —— avjb(爱微社区,KVS 站群)视频类只读 API 爬取器(Node.js 版,零依赖,需 Node>=18)
 *
 * 逆向结论(2026-10-06,授权测试环境实测,avjb.cc 与 avjb.com 同壳同源不同域):
 *   1. KVS 内核服务端直出 HTML,无独立 JSON API——数据面 = 页面解析 + 少量原生端点;
 *   2. 入口有 rsso2 JS 挑战 + 18+ 年龄门(整页仅 ~1KB):页内 var safeid='<16 字符>' 即
 *      解谜钥匙——写 cookie _safe=<safeid> 后重取即过(写 cookie 即「满18岁进入」按钮
 *      的全部动作,无其他校验),对脚本完全透明;
 *   3. 视频内容存储双世代并存,切片均为 .jpg 伪装扩展的明文 TS,零签名零鉴权
 *      (无 Referer 亦 200、ACAO:* 与 Range 全开、TS 同步字节 0x47@0/188/376 俱在):
 *        - 新片(id≳130000):bot.imgclh.com / list.avstatic.com 的
 *          /videos/{dir}/{id}/NNNN.jpg;
 *        - 老片(如 46887):视频存储节点 r22.jb-aiwei.cc 的【/cdn/ 前缀挂载】
 *          /cdn/videos/{dir}/{id}/NNNN.jpg(r22 的 /videos/ 挂载对 .jpg 一律 403,
 *          勿被此假象误导;存储节点 rNN/99newline 轮换,详情页脚本文本可发现);
 *      目录公式 dir=floor(id/1000)*1000,切片 0000.jpg 起 4 位零填充连续编号;
 *   4. 官方签名线路:/player/spped.php?csrf=<页面 PLAYER_CSRF>(金币购片/VIP 后页面才
 *      渲染该脚本)返回 {direct,defaultKey,sources:[{key,name,url}]},url 即签名 m3u8
 *      /videos/…/index.m3u8?md5=&expires=(时效约 45 分钟,CSRF 本身亦短时效,页面现取现用);
 *      页面内联 Playerjs file: 配置对访客恒为 30 秒试看流 *video_limt.mp4(Referer 白名单
 *      放行 avjb.cc/avjb.com/bavNN.cc 域,Node 侧须显式带 Referer);
 *   5. get_file/{mode}/{hash}/{dir}/{id}/{文件}/ 为站方签名媒体跳转(mode1=列表悬停预览,
 *      mode0=截图,mode4=视频文件),302 落 r22 对应挂载且无二次签名;bot/list 对不存在的
 *      mp4 名义路径会 301 互踢成环(文件不存在的表现形态,勿误判为可达);
 *   6. 会员体系:注册送 10 币+每日签到 1 币,金币视频 5 币可购(永久解锁);purchase_video/
 *      签到/注册等写操作刻意不实现,登录态经 --cookie 传入(浏览器 DevTools 抄 Cookie 头)。
 *   7. 相册专区(2026-10-06 实测,/albums/ 独立于视频面,同壳同门):
 *      - 列表 /albums/{page}/ 12 卡/页,卡片 <div class="item  ">(双空格,无 free/premium
 *        kind 类,与视频卡同头不同身):/albums/{id}/{slug}/ + title 属性、张数
 *        <div class="photos">N照片、时间 <div class="added"><em>2天前</em>、封面
 *        data-original={cdn}/contents/albums/preview/380x500/{dir}/{id}/preview.jpg
 *        (竖版 380x500);卡片无作者行;翻页到底判定 = 分页器 <li class="next"><a 在场;
 *      - 详情 /albums/{id}/{slug}/:【任意 slug 301 归一到真实 slug】(裸 /albums/{id}/ 才
 *        404,故免 newembed 式 slug 解析,任一占位 slug 直接取,跟 301 即可);照片【全量
 *        直出】无照片分页(实测 59/59 张全在首屏 HTML);信息块「照片: <em>N</em>」
 *        「加入日期: <em>3天前</em>」;作者块 a.avatar[href*=members/{id}] + span.name
 *        (站方号常缺头像,部分相册无作者);
 *      - 照片原图:{cdn}/contents/albums/sources/{dir}/{aid}/{pid}.jpg —— 由页面签名跳转
 *        /get_image/2/{hash}/sources/{dir}/{aid}/{pid}.jpg/ 302 落地,但目标即缩略图
 *        main/200x150 路径的 /sources/ 换轴,【裸链零鉴权】(无 Referer 亦 206、无 Cookie),
 *        浏览器 <img> 免代理直用;实测 CDN 主机 bmc2.imgclh.com(imgclh 家族,按页面
 *        原样绝对化,勿硬编码);
 *      - 相册搜索 /search/{关键词}/albums/{page}/ 可用(12 卡/页,页间内容递进;页面无
 *        分页器标记,hasMore 沿用 items.length>0 约定);
 *      - 相册分类:/albums/categories/ 索引瓦片 <a class="item"(注意与视频的 cat-card
 *        不同)…<div class="albums">N相册;分类 id 可为 slug(如 fc2)或 hex hash;
 *        分类内列表 /albums/categories/{id}/{page}/ 同列表卡片+分页器。
 *
 * 端点/页面清单(只读部分,全部实测通过):
 *   页面 /new/{page}/[?rast_filter=free|coin|vip]   最新视频(free/coin/vip 过滤)
 *        /search/{关键词}/videos/{page}/            搜索(URL 路径编码,无通配)
 *        /categories/                                分类索引(名称/哈希/视频数)
 *        /categories/{hash}/{page}/                  分类内视频
 *        /video/{id}/…(任意 slug,301 归一)          视频详情(付费墙形态/试看流/相关推荐)
 *        /newembed/{id}                              试看壳页(limt.mp4 + 海报直出)
 *        /embed/{id}/                                KVS 标准嵌入(未购:「您没有获得该视频」)
 *        /redirect_random_video.php                  随机跳一部片(301 → /video/{id}/{slug}/)
 *        /albums/{page}/                             相册列表(12 卡/页)
 *        /albums/{id}/{slug}/(任意 slug,301 归一)    相册详情(照片全量直出)
 *        /albums/categories/                         相册分类索引(名称/ID/相册数)
 *        /albums/categories/{id}/{page}/             分类内相册(id 可为 slug 或 hex)
 *        /search/{关键词}/albums/{page}/             相册搜索
 *   端点 /player/spped.php?csrf=…                    签名线路(需 --cookie 登录+已购)
 *        /get_image/2/{hash}/sources/{dir}/{aid}/{pid}.jpg/   相册原图签名跳转(302 落裸 CDN)
 *   存储 {seg 基座}/videos/{dir}/{id}/NNNN.jpg       裸 TS 切片(合成全片清单的原料)
 *        r22.jb-aiwei.cc/videos/{dir}/{id}/{id}video_limt.mp4   30s 试看正片
 *        {img CDN}/contents/albums/sources/{dir}/{aid}/{pid}.jpg  相册原图(裸链)
 *        {img CDN}/contents/albums/main/200x150/{dir}/{aid}/{pid}.jpg  相册网格缩略图
 *        {img CDN}/contents/albums/preview/380x500/{dir}/{aid}/preview.jpg  相册封面
 *
 * 用法(基地址默认 https://avjb.cc,挑战自动过;也可 --base=https://avjb.com 等):
 *   node avjb_api.js                          # 总览:最新列表 → 首片详情 → 切片枚举/时长校准
 *   node avjb_api.js list [--page=2] [--filter=vip]      # 最新视频(coin=金币 vip=VIP free=免费)
 *   node avjb_api.js search 关键词 [--page=1]            # 搜索
 *   node avjb_api.js categories                          # 分类索引(名称+哈希+数量)
 *   node avjb_api.js cat <hash> [--page=1]               # 分类内视频
 *   node avjb_api.js video 46887                         # 视频详情(标题/时长/付费形态/试看流/截图/相关)
 *   node avjb_api.js related 46887                       # 相关推荐(详情页侧栏卡片)
 *   node avjb_api.js segs 46887 [--out=46887.m3u8]       # 裸切片枚举+时长校准,可选合成全片 m3u8 落盘
 *   node avjb_api.js limt 46887                          # 试看流可用性探测(Range 探针)
 *   node avjb_api.js lines 46887 --cookie='…'            # 签名线路(需登录+已购 cookie)
 *   node avjb_api.js embed 46887                         # KVS 嵌入端点状态
 *   node avjb_api.js random                              # 随机片解析
 *   node avjb_api.js trace <完整URL>                     # 任意站内 URL 重定向链取证(get_file 等)
 *   node avjb_api.js albums [--page=2]                   # 相册列表(12 卡/页)
 *   node avjb_api.js albumcats                           # 相册分类索引(名称+ID+相册数)
 *   node avjb_api.js albumcat <分类ID> [--page=1]        # 分类内相册(ID 可为 slug 如 fc2)
 *   node avjb_api.js album 4537                          # 相册详情(照片全量直出/作者/相关)
 *   node avjb_api.js albumsearch 关键词 [--page=1]       # 相册搜索
 *   通用旗标:--base=https://avjb.cc  --cookie=<Cookie头>  --raw(输出完整 JSON)
 *           --no-title(摘要隐藏标题)  --out=<file>(segs 合成清单落盘路径)
 * 退出码:0=成功;1=失败。仅供站方授权测试使用。
 */

// ============ 0. 常量与命令行 ============

const DEFAULT_BASE = 'https://avjb.cc';
// 切片基座(含路径前缀):新片 bot/list 原 /videos/ 挂载 + 老片 r22 的 /cdn/ 挂载
const SEG_BASES = ['https://bot.imgclh.com', 'https://list.avstatic.com', 'https://r22.jb-aiwei.cc/cdn'];
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

// ============ 1. HTTP 底座(cookie jar + rsso2 挑战自动过) ============

const jar = new Map();   // name → value(--cookie 先入 jar,Set-Cookie 增量合并)
if (flag.cookie) for (const kv of String(flag.cookie).split(/;\s*/)) {
  const i = kv.indexOf('=');
  if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
}
const cookieHeader = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');

function absorbSetCookie(res) {
  for (const line of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
    const [kv] = line.split(';');
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}

// 基本请求:浏览器头 + jar cookie + 显式 Referer(r22 系 CDN 有 Referer 白名单)
async function http(url, { referer, method = 'GET', range } = {}) {
  const headers = {
    'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  if (cookieHeader()) headers['Cookie'] = cookieHeader();
  if (referer) headers['Referer'] = referer;
  if (range) headers['Range'] = range;
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers });
  absorbSetCookie(res);
  return res;
}

// 页面获取(跟 301/302;rsso2 挑战页自动过门:safeid → cookie _safe → 原地重取一次)
async function fetchPage(base, path) {
  const url = path.startsWith('http') ? path : base + path;
  let cur = url;
  for (let hop = 0; hop < 6; hop++) {
    const res = await http(cur, { referer: base + '/' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      cur = new URL(res.headers.get('location'), cur).href;
      continue;
    }
    const text = await res.text();
    // 挑战壳判定:真实页也会引用 rsso2 资产,只有 ~1KB 年龄门壳才带 var safeid=
    if (/var\s+safeid\s*=\s*'/.test(text)) {
      jar.set('_safe', text.match(/var\s+safeid\s*=\s*'([^']+)'/)[1]);
      continue;                      // 带 _safe 重取同 URL(「满18岁进入」的全部动作即写此 cookie)
    }
    return { status: res.status, url: cur, text };
  }
  throw new Error('重定向/挑战层数超限 @' + url);
}

// ============ 2. 页面解析器(卡片/分类/详情) ============

const dirOf = vid => Math.floor(vid / 1000) * 1000;

// 由 ID 解析正片页路径:裸 /video/{id}/ 是 404,任意 slug 虽 200 但落到【另一部片】的
// 详情页(假页勿用);/newembed/{id} 的「观看完整版」链接带真实 slug(/videos/{id}/{slug}/)
async function resolveVideoPath(base, vid) {
  const r = await fetchPage(base, '/newembed/' + vid);
  const m = r.text.match(new RegExp('/videos?/' + vid + '/([A-Za-z0-9_%-]+)/'));
  if (!m) throw new Error('newembed 未能解析 slug(视频已删?)');
  return '/video/' + vid + '/' + m[1] + '/';
}

// 视频卡片:.item(free/premium/private=金币) → id/标题/时长/缩略图/悬停预览/标记
function parseCards(html) {
  const out = [];
  // 逐卡片切块再取属性,避免跨卡片串读(卡片头形如 <div class="item premium ">)
  const blocks = html.split(/<div\s+class="item /).slice(1);
  for (const b of blocks) {
    const idm = b.match(/\/video\/(\d+)\//);
    const tm = b.match(/title="([^"]*)"/);
    if (!idm || !tm) continue;
    out.push({
      id: +idm[1],
      title: tm[1],
      kind: (b.slice(0, 40).match(/^(free|premium|private|)[\s"]/) || [, ''])[1] || 'free',
      duration: (b.match(/class="duration">([^<]*)</) || [, ''])[1],
      hd: /class="is-hd"/.test(b),
      vip: /class="is-vip"|aria-label="VIP/.test(b),
      coin: /aria-label="金币解锁"|line-private/.test(b),
      thumb: (b.match(/data-original="([^"]+)"/) || [, ''])[1],
      preview: (b.match(/data-preview="([^"]+)"/) || [, ''])[1],
    });
  }
  return out;
}

function printCards(list, opt) {
  if (!list.length) { log('  (无卡片)'); return; }
  for (const v of list) {
    const tags = [v.kind !== 'free' ? v.kind.toUpperCase() : 'free', v.hd ? 'HD' : '', v.coin ? '金币' : '', v.vip ? 'VIP' : '']
      .filter(Boolean).join('/');
    log('   [' + v.id + '] ' + (v.duration || '--:--').padStart(6) + ' ' + tags.padEnd(12) + ' ' + mask(v.title, opt.noTitle));
  }
}

// 分类瓦片:<a class="cat-card" href=…/categories/{hash}/ title="{名}">…{N}视频…
function parseCategories(html) {
  const out = [];
  for (const m of html.matchAll(/<a class="cat-card" href="https?:\/\/[^\/]+\/categories\/([a-f0-9]+)\/" title="([^"]*)">[\s\S]*?<div class="v">(\d+)视频</g))
    out.push({ hash: m[1], name: m[2], count: +m[3] });
  return out;
}

// 视频详情页:标题/时长/日期/付费形态/试看流/线路脚本(登录态)/截图/相关卡片/分类标签
function parseDetail(html) {
  const d = {};
  d.title = (html.match(/<h1[^>]*>([^<]*)<\/h1>/) || [, (html.match(/property="og:title" content="([^"]*)"/) || [, ''])[1]])[1].trim();
  const iso = html.match(/"uploadDate":\s*"([^"]+)"/);
  d.uploadDate = iso ? iso[1] : '';
  const pt = html.match(/"duration":\s*"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?"/);
  if (pt) d.duration = (+pt[1] || 0) * 3600 + (+pt[2] || 0) * 60 + (+pt[3] || 0);
  d.paywalled = /class="no-player paywall-player"/.test(html);
  d.pwTitle = (html.match(/<span class="pw-title">([^<]*)<\/span>/) || [, d.paywalled ? '付费墙' : '无(可播)'])[1].trim();
  d.csrf = (html.match(/PLAYER_CSRF\s*=\s*"([^"]+)"/) || [, ''])[1];   // 登录+已购才渲染
  d.limt = (html.match(/file\s*:\s*"(https?:\/\/[^"]+video_limt\.mp4)"/) || [, ''])[1];
  d.file = (html.match(/file\s*:\s*"(https?:\/\/[^"]+)"/) || [, ''])[1];
  d.poster = (html.match(/"thumbnailUrl":\s*"(https?:\/\/[^"]+)"/) || [, ''])[1];
  d.contentUrl = (html.match(/"contentUrl":\s*"(https?:\/\/[^"]+)"/) || [, ''])[1];
  d.shots = [...html.matchAll(/get_file\/0\/[a-f0-9]+\/\d+\/\d+\/screenshots\/(\d+)\.jpg\//g)].map(m => +m[1]);
  d.categories = [...html.matchAll(/\/categories\/([a-f0-9]+)\/"[^>]*>([^<]{1,30})</g)].map(m => ({ hash: m[1], name: m[2] }));
  d.tags = [...html.matchAll(/\/tags\/[a-z0-9]+\/"[^>]*>([^<]{1,24})</g)].map(m => m[1]);
  // 锚 _items 容器(容器 id 本体在 AJAX 分页属性里还会出现一次且位于卡片之后,pop 会取空)
  d.related = parseCards(html.split('id="list_videos_related_videos_items"').pop() || '');
  // 页面在引的视频存储主机(内联脚本文本,含 Playerjs 配置/线路清单)→ /cdn 基座
  d.segBases = [...new Set([...html.matchAll(/https?:\/\/([a-z0-9.-]+\.jb-aiwei\.cc)\//gi)].map(m => 'https://' + m[1] + '/cdn'))];
  return d;
}

// —— 相册面解析器(2026-10-06 实测,结构见文件头第 7 条) ——

// 相册卡片:<div class="item  ">(双空格无 kind)→ id/标题/张数/封面/发布时间;
// 与视频卡同头(<div class="item )不同身,切块隔离同一手法;相册卡片无作者行/付费标记
function parseAlbums(html) {
  const out = [];
  const blocks = html.split(/<div\s+class="item\s/).slice(1);
  for (const b of blocks) {
    const idm = b.match(/\/albums\/(\d+)\/[A-Za-z0-9_%-]+\//);
    const tm = b.match(/title="([^"]*)"/);
    if (!idm || !tm) continue;
    out.push({
      id: +idm[1],
      title: tm[1],
      count: +(b.match(/class="photos">(\d+)照片/) || [, 0])[1],
      added: (b.match(/class="added"><em>([^<]*)<\/em>/) || [, ''])[1],
      thumb: (b.match(/data-original="([^"]+)"/) || [, ''])[1],
    });
  }
  return out;
}

function printAlbums(list, opt) {
  if (!list.length) { log('  (无卡片)'); return; }
  for (const a of list) {
    log('   [' + a.id + '] ' + (String(a.count || '?') + '张').padStart(5) + '  ' + (a.added || '-').padEnd(6) + '  ' + mask(a.title, opt.noTitle));
  }
}

// 相册分类瓦片:<a class="item" href=…/albums/categories/{id}/ title="{名}">…<div class="albums">{N}相册
// (注意与视频的 <a class="cat-card" 不同;分类 id 可为 slug(fc2)或 hex hash)
function parseAlbumCategories(html) {
  const out = [];
  for (const m of html.matchAll(/<a class="item" href="https?:\/\/[^\/]+\/albums\/categories\/([a-z0-9]+)\/" title="([^"]*)">[\s\S]*?<div class="albums">(\d+)相册</g))
    out.push({ id: m[1], name: m[2], count: +m[3] });
  return out;
}

// 相册详情页:标题/张数/加入日期/作者/分类标签/照片清单(全量直出)/相关相册
function parseAlbumDetail(html) {
  const d = {};
  d.title = (html.match(/<h1[^>]*>([^<]*)<\/h1>/) || [, (html.match(/property="og:title" content="([^"]*)"/) || [, ''])[1]])[1].trim();
  d.count = +(html.match(/照片:\s*<em>(\d+)<\/em>/) || [, 0])[1];
  d.added = (html.match(/加入日期:\s*<em>([^<]*)<\/em>/) || [, ''])[1].trim();
  d.desc = (html.match(/描述:\s*<em>([^<]*)<\/em>/) || [, ''])[1].trim();
  // 作者块:<a class="avatar" href=…/members/{id}/ title="{名}"> + span.name(部分相册无作者)
  const av = html.match(/<a class="avatar" href="https?:\/\/[^"]+\/members\/(\d+)\/" title="([^"]*)"/);
  d.member = av ? { id: +av[1], name: av[2] } : null;
  d.categories = [...html.matchAll(/\/albums\/categories\/([a-z0-9]+)\/"[^>]*>([^<]{1,30})</g)].map(m => ({ id: m[1], name: m[2].trim() }));
  d.tags = [...html.matchAll(/\/albums\/tags\/[a-z0-9]+\/"[^>]*>([^<]{1,24})</g)].map(m => m[1].trim());
  // 照片:签名跳转 <a href="…get_image/2/{hash}/sources/{dir}/{aid}/{pid}.jpg/"> + 内层缩略图
  // data-original={cdn}/contents/albums/main/{尺寸}/{dir}/{aid}/{pid}.jpg —— 原图即缩略图
  // 路径把 /main/{尺寸}/ 换轴成 /sources/(get_image 302 的落地即此,裸链零鉴权)
  d.photos = [...html.matchAll(/<a href="([^"]*get_image\/2\/[a-f0-9]+\/sources\/\d+\/\d+\/(\d+)\.jpg\/)"[^>]*>\s*<img[^>]*data-original="([^"]+)"/g)]
    .map(m => ({ pid: +m[2], signed: m[1], thumb: m[3], url: m[3].replace(/\/main\/[^/]+\//, '/sources/') }));
  // 相关相册容器(锚 _items,与视频 related 同款手法)
  d.related = parseAlbums(html.split('id="list_albums_related_albums_items"').pop() || '');
  return d;
}

// ============ 3. 切片存储面(探测/末段二分/时长校准/合成清单) ============

const segUrl = (base, vid, n) => base + '/videos/' + dirOf(vid) + '/' + vid + '/' + String(n).padStart(4, '0') + '.jpg';

// 状态码探测:响应头到即断不下载体;网络错误重试后按缺失处理
async function probe(url, referer) {
  for (let i = 0; i < PROBE_RETRY; i++) {
    try {
      const res = await http(url, { referer, method: 'GET' });
      try { res.body && res.body.cancel(); } catch (e) { }
      return res.status;
    } catch (e) { /* 重试 */ }
  }
  return -1;
}

// 倍增上界 + 二分找末段(串行 ~2×log₂N 次探测,CLI 场景够用)
async function findLast(base, vid, referer) {
  if (await probe(segUrl(base, vid, 0), referer) !== 200) return -1;
  let hi = 1;
  while (await probe(segUrl(base, vid, hi), referer) === 200) hi *= 2;
  let lo = hi / 2;   // lo=在,hi=首缺
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    (await probe(segUrl(base, vid, mid), referer) === 200) ? lo = mid : hi = mid;
  }
  return lo;
}

// 最小 TS 解析:取段内最小 PTS(188B 步进扫 PES 起始包;33bit PTS 乘法拼防 32bit 截断)
function firstPts(u8) {
  let min = -1;
  for (let i = 0; i + 188 <= u8.length; i += 188) {
    if (u8[i] !== 0x47 || !(u8[i + 1] & 0x40)) continue;
    const pid = ((u8[i + 1] & 0x1f) << 8) | u8[i + 2];
    if (pid === 0 || pid === 0x1fff) continue;
    const afc = (u8[i + 3] >> 4) & 3;
    if (afc === 0 || afc === 2) continue;
    let p = i + 4;
    if (afc & 2) p += 1 + u8[p];
    if (p + 13 >= i + 188) continue;
    if (u8[p] || u8[p + 1] || u8[p + 2] !== 1 || !(u8[p + 7] & 0x80)) continue;
    const pts = ((u8[p + 9] >> 1) & 7) * 0x40000000 + u8[p + 10] * 0x400000 +
      ((u8[p + 11] >> 1) & 0x7f) * 0x8000 + u8[p + 12] * 0x80 + (u8[p + 13] >> 1);
    if (min < 0 || pts < min) min = pts;
  }
  return min;
}

async function fetchBuf(url, referer) {
  try {
    const res = await http(url, { referer });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) { return null; }
}

// 抽样 2 对相邻切片(片头+片中)实解 PTS,均段时长(老片 /cdn ≈1s,新片 ≈1.7s,校准失败回退 1s)
async function calibDur(base, vid, last, referer) {
  const mid = Math.max(1, last >> 1);
  const idx = [0, 1, mid, mid + 1];
  const bufs = await Promise.all(idx.map(n => fetchBuf(segUrl(base, vid, n), referer)));
  const pts = bufs.map(b => b ? firstPts(b) : -1);
  const ds = [];
  for (let i = 0; i + 1 < idx.length; i++) {
    if (idx[i + 1] !== idx[i] + 1 || pts[i] < 0 || pts[i + 1] < 0) continue;
    let d = pts[i + 1] - pts[i];
    if (d < 0) d += 0x200000000;
    d /= 90000;
    if (d > 0.3 && d < 12) ds.push(d);
  }
  return ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : 0;
}

function synthM3u8(base, vid, last, dur) {
  const d = dur || 1;
  let t = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:' + Math.max(1, Math.ceil(d)) +
    '\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n';
  for (let i = 0; i <= last; i++) t += '#EXTINF:' + d.toFixed(6) + ',\n' + segUrl(base, vid, i) + '\n';
  return t + '#EXT-X-ENDLIST\n';
}

// ============ 4. 摘要打印 ============

const fmtDur = s => s == null ? '?' : Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
const mask = (t, on) => on ? '<标题已隐藏>' : String(t == null ? '' : t).slice(0, 42);
const fs = require('fs');

// ============ 5. 命令表 ============

const COMMANDS = {
  async list(base) { // 最新视频(free/coin/vip 过滤走 ?rast_filter=)
    const p = num('page', 1);
    const f = flag.filter ? '?rast_filter=' + flag.filter : '';
    const r = await fetchPage(base, '/new/' + p + '/' + f);
    log('── 最新视频 /new/' + p + '/' + (f ? ' ' + f : '') + ' ──');
    printCards(parseCards(r.text), flag);
  },
  async search(base) { // 搜索(路径编码,分页路径段)
    const kw = arg1;
    if (!kw) die('用法: search <关键词> [--page=N]');
    const p = num('page', 1);
    const r = await fetchPage(base, '/search/' + encodeURIComponent(kw) + '/videos/' + (p > 1 ? p + '/' : ''));
    log('── 搜索 "' + kw + '" 第 ' + p + ' 页 ──');
    printCards(parseCards(r.text), flag);
  },
  async categories(base) { // 分类索引
    const r = await fetchPage(base, '/categories/');
    const cats = parseCategories(r.text);
    log('── 分类索引 /categories/ ──');
    if (!cats.length) return log('  (无 cat-card 瓦片,页面改版?)');
    for (const c of cats) log('   [' + c.hash + '] ' + mask(c.name, flag.noTitle) + '  (' + c.count + ')');   // 完整 hash:cat 命令直用
  },
  async cat(base) { // 分类内视频
    if (!arg1) die('用法: cat <分类hash> [--page=N]');
    const r = await fetchPage(base, '/categories/' + arg1 + '/' + (num('page', 1) > 1 ? num('page', 1) + '/' : ''));
    log('── 分类视频 /categories/' + arg1.slice(0, 8) + '…/ ──');
    printCards(parseCards(r.text), flag);
  },
  async albums(base) { // 相册列表(12 卡/页;到底 = 分页器 li.next 无 <a>)
    const p = num('page', 1);
    const r = await fetchPage(base, '/albums/' + p + '/');
    const list = parseAlbums(r.text);
    const hasMore = /<li\s+class="next">\s*<a/.test(r.text);
    log('── 相册列表 /albums/' + p + '/ ──');
    printAlbums(list, flag);
    log('  共 ' + list.length + ' 本' + (hasMore ? ',还有下一页' : ',已到末页'));
  },
  async albumcats(base) { // 相册分类索引
    const r = await fetchPage(base, '/albums/categories/');
    const cats = parseAlbumCategories(r.text);
    log('── 相册分类索引 /albums/categories/ ──');
    if (!cats.length) return log('  (无瓦片,页面改版?)');
    for (const c of cats) log('   [' + c.id + '] ' + mask(c.name, flag.noTitle) + '  (' + c.count + ')');
  },
  async albumcat(base) { // 分类内相册(id 可为 slug 如 fc2 或 hex hash)
    if (!arg1) die('用法: albumcat <分类ID> [--page=N]');
    const p = num('page', 1);
    const r = await fetchPage(base, '/albums/categories/' + arg1 + '/' + (p > 1 ? p + '/' : ''));
    const list = parseAlbums(r.text);
    const hasMore = /<li\s+class="next">\s*<a/.test(r.text);
    log('── 分类相册 /albums/categories/' + arg1 + '/ ──');
    printAlbums(list, flag);
    log('  共 ' + list.length + ' 本' + (hasMore ? ',还有下一页' : ',已到末页'));
  },
  async albumsearch(base) { // 相册搜索(页间内容递进但页面无分页器标记)
    const kw = arg1;
    if (!kw) die('用法: albumsearch <关键词> [--page=N]');
    const p = num('page', 1);
    const r = await fetchPage(base, '/search/' + encodeURIComponent(kw) + '/albums/' + (p > 1 ? p + '/' : ''));
    log('── 相册搜索 "' + kw + '" 第 ' + p + ' 页 ──');
    printAlbums(parseAlbums(r.text), flag);
  },
  async album(base, a2) { // 相册详情(任意 slug 301 归一,占位 slug 直接取)
    const aid = a2 !== undefined ? a2 : arg1;
    if (!aid) die('用法: album <相册ID>');
    const aid_ = parseInt(aid, 10);
    if (!Number.isFinite(aid_) || aid_ <= 0) die('相册 ID 须为正整数');
    const r = await fetchPage(base, '/albums/' + aid_ + '/cli/');   // 占位 slug,301 落真实 slug
    const d = parseAlbumDetail(r.text);
    if (!d.photos.length && !d.title) die('相册页解析失败(已删?ID 错误?)');
    log('── 相册详情 id=' + aid_ + ' ──');
    log('  title: ' + mask(d.title, flag.noTitle));
    log('  照片: ' + (d.count || d.photos.length) + ' 张(页面直出 ' + d.photos.length + ' 条)  加入: ' + (d.added || '?'));
    log('  用户: ' + (d.member ? d.member.name + '(' + d.member.id + ')' : '(无)'));
    log('  分类: ' + (d.categories.map(c => c.name).join('、') || '(无)').slice(0, 90));
    log('  标签: ' + (d.tags.join('、') || '(无)').slice(0, 90));
    if (d.desc) log('  描述: ' + mask(d.desc, flag.noTitle));
    log('  照片直链(前 5):');
    for (const p of d.photos.slice(0, 5)) log('   [' + p.pid + '] ' + p.url);
    log('  相关相册: ' + d.related.length + ' 本');
    if (flag.raw) log('\n── RAW ──\n' + JSON.stringify({ ...d, photos: d.photos.slice(0, 60), related: d.related.slice(0, 12) }, null, 2).slice(0, 6000));
  },
  async video(base, a2) { // 视频详情
    const vid = a2 !== undefined ? a2 : arg1;
    if (!vid) die('用法: video <视频ID>');
    const r = await fetchPage(base, await resolveVideoPath(base, parseInt(vid, 10)));
    const d = parseDetail(r.text);
    log('── 视频详情 id=' + vid + ' ──');
    log('  title: ' + mask(d.title, flag.noTitle));
    log('  duration: ' + fmtDur(d.duration) + '  uploadDate: ' + d.uploadDate);
    log('  付费形态: ' + (d.paywalled ? '付费墙(' + d.pwTitle + ')' : '无(可直播)') + (d.csrf ? '  [已购/会员:线路脚本在场]' : ''));
    log('  试看流: ' + (d.limt ? d.limt.replace(/^https?:\/\//, '').slice(0, 80) : '(页面无内联配置)'));
    log('  海报: ' + (d.poster ? d.poster.replace(/^https?:\/\//, '').slice(0, 70) : '-'));
    log('  截图: ' + (d.shots.length ? d.shots.length + ' 张(get_file/0 签名)' : '(无)'));
    log('  分类: ' + (d.categories.map(c => c.name).join('、') || '(无)').slice(0, 90));
    log('  标签: ' + (d.tags.join('、') || '(无)').slice(0, 90));
    log('  相关推荐: ' + d.related.length + ' 条;页面发现的存储基座: ' + (d.segBases.join(' ') || '(无)'));
    if (flag.raw) log('\n── RAW ──\n' + JSON.stringify({ ...d, related: d.related.length ? d.related : [] }, null, 2).slice(0, 3000));
  },
  async related(base, a2) { // 相关推荐(详情页侧栏卡片)
    const vid = a2 !== undefined ? a2 : arg1;
    if (!vid) die('用法: related <视频ID>');
    const r = await fetchPage(base, await resolveVideoPath(base, parseInt(vid, 10)));
    const d = parseDetail(r.text);
    log('── 相关推荐 id=' + vid + ' ──');
    printCards(d.related, flag);
  },
  async segs(base, a2) { // 裸切片枚举 + 时长校准 + 可选合成全片 m3u8
    const vid = a2 !== undefined ? a2 : arg1;
    if (!vid) die('用法: segs <视频ID> [--out=文件.m3u8]');
    const vid_ = parseInt(vid, 10);
    const ref = base + '/';
    // 基座 = 硬编码三基座 + 详情页在引的存储主机(/cdn 形态,rNN 轮换自适应)
    const d = parseDetail((await fetchPage(base, await resolveVideoPath(base, vid_))).text);
    const bases = [...new Set([...SEG_BASES, ...d.segBases])];
    // 官方清单优先(newbox 等无签名入口,免购免登录;命中即站方原版清单+真实 EXTINF)
    const dir = dirOf(vid_);
    for (const c of ['https://newbox.jb-aiwei.cc', ...d.segBases.map(b => b.replace(/\/cdn$/, ''))]) {
      const u = c + '/videos/' + dir + '/' + vid_ + '/index.m3u8';
      if (await probe(u, base + '/') === 200) {
        log('── 切片枚举 id=' + vid_ + ' ──');
        log('  ✓ 官方清单直连(无签名入口): ' + u);
        if (flag.out) {   // 落盘需把相对切片绝对化,本地播放器才能用
          const txt = await (await http(u, { referer: base + '/' })).text();
          fs.writeFileSync(String(flag.out), txt.split('\n').map(l => l && !l.startsWith('#') ? new URL(l, u).href : l).join('\n'));
          log('  ✓ 官方清单已落盘 ' + flag.out + '(切片已绝对化;newbox 拒带 Origin 请求:mpv --referrer=https://avjb.cc/ 可播,Chrome 网页/VLC 默认被拦)');
        }
        return;
      }
    }
    log('── 切片枚举 id=' + vid_ + ' ──');
    log('  基座: ' + bases.join('  '));
    let chosen = null, last = -1;
    for (const b of bases) {   // 顺序探测基座(0 号切片 200 者胜;实测命中即停)
      last = await findLast(b, vid_, ref);
      log('  ' + b.replace(/^https?:\/\//, '') + ' → ' + (last >= 0 ? '末段 ' + String(last).padStart(4, '0') + '.jpg' : '无切片'));
      if (last >= 0) { chosen = b; break; }
    }
    if (!chosen) die('全部基座均无切片——2021 老批次(id≲15000)正片在旧 bbmmic2 存储系(日期+随机串路径,id 公式不可枚举)且多无试看流;购片后用 lines <id> --cookie=… 取签名线路(实测 AES-128 流可播);或视频已删');
    const dur = await calibDur(chosen, vid_, last, ref);
    const tot = (last + 1) * (dur || 1);
    log('  ✓ 共 ' + (last + 1) + ' 段,校准均段 ' + (dur ? dur.toFixed(2) + 's' : '(失败,按 1s 名义)') +
      ',总时长 ~' + fmtDur(Math.round(tot)) + '(=' + Math.round(tot) + 's)');
    if (flag.out) {
      fs.writeFileSync(String(flag.out), synthM3u8(chosen, vid_, last, dur));
      log('  ✓ 全片清单已落盘 ' + flag.out + '(' + (last + 1) + ' 段,hls.js/Artplayer 可直接播)');
    }
    if (flag.raw) log('  RAW: ' + JSON.stringify({ base: chosen, last, dur, count: last + 1 }));
  },
  async limt(base, a2) { // 试看流可用性(Referer 白名单下 Range 探针)
    const vid = a2 !== undefined ? a2 : arg1;
    if (!vid) die('用法: limt <视频ID>');
    const vid_ = parseInt(vid, 10);
    const d = parseDetail((await fetchPage(base, await resolveVideoPath(base, vid_))).text);
    const url = d.limt || ('https://r22.jb-aiwei.cc/videos/' + dirOf(vid_) + '/' + vid_ + '/' + vid_ + 'video_limt.mp4');
    const res = await http(url, { referer: base + '/', range: 'bytes=0-99' });
    const len = (res.headers.get('content-range') || '').split('/')[1];
    log('── 试看流 id=' + vid_ + ' ──');
    log('  ' + res.status + (res.status === 206 ? '(Range OK)' : '') + '  总长 ' + (len ? Math.round(+len / 1024) + 'KB' : '?') + '  ' + url.replace(/^https?:\/\//, '').slice(0, 90));
  },
  async lines(base, a2) { // 签名线路(需 --cookie 登录+已购;CSRF/清单均短时效,页面现取现用)
    const vid = a2 !== undefined ? a2 : arg1;
    if (!vid) die('用法: lines <视频ID> --cookie=<浏览器Cookie头>');
    if (!flag.cookie) die('需要登录态:用 --cookie 传入(购片/VIP 账号,DevTools → Network → Cookie 头原样抄)');
    const r = await fetchPage(base, await resolveVideoPath(base, parseInt(vid, 10)));
    const d = parseDetail(r.text);
    if (!d.csrf) die('页面无 PLAYER_CSRF(cookie 未生效或该账号未购本片)');
    const res = await http(base + '/player/spped.php?csrf=' + encodeURIComponent(d.csrf), { referer: r.url });
    const j = JSON.parse(await res.text());
    log('── 签名线路 id=' + vid + ' ──');
    if (!Array.isArray(j.sources) || !j.sources.length) return log('  (sources 为空:' + JSON.stringify(j).slice(0, 120) + ')');
    for (const s of j.sources) log('   [' + s.key + '] ' + s.name + '  ' + String(s.url).replace(/^https?:\/\//, '').slice(0, 100));
    log('  注:md5/expires 时效约 45 分钟,过期重跑本命令刷新');
  },
  async embed(base, a2) { // KVS 标准嵌入端点状态
    const vid = a2 !== undefined ? a2 : arg1;
    if (!vid) die('用法: embed <视频ID>');
    const r = await fetchPage(base, '/embed/' + parseInt(vid, 10) + '/');
    const denied = /您没有获得该视频/.test(r.text);
    log('── 嵌入端点 /embed/' + vid + '/ ──');
    log('  HTTP ' + r.status + '  ' + (denied ? '未购(您没有获得该视频)' : '可播(会员态?)'));
  },
  async random(base) { // 随机片(302 → /video/{id}/{slug}/;冷进程首访可能是挑战 200,过门后重试)
    log('── 随机片 redirect_random_video.php ──');
    for (let i = 0; i < 2; i++) {
      const res = await http(base + '/redirect_random_video.php', { referer: base + '/' });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) return log('  ' + res.status + ' → ' + loc);
      const t = await res.text();
      const m = t.match(/var\s+safeid\s*=\s*'([^']+)'/);
      if (m) { jar.set('_safe', m[1]); continue; }   // 挑战壳:过门重试
      return log('  ' + res.status + ' → ' + (loc || '(无 location)'));
    }
    log('  (过门后仍无跳转)');
  },
  async trace(base) { // 任意站内 URL 重定向链取证(get_file 签名跳转等;含挑战过门)
    if (!arg1) die('用法: trace <完整URL>');
    let cur = arg1, hops = 0;
    log('── 重定向链 ' + cur.replace(/^https?:\/\//, '').slice(0, 70) + ' ──');
    while (hops++ < 10) {
      const res = await http(cur, { referer: base + '/' });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        log('  ' + res.status + ' → ' + res.headers.get('location').replace(/^https?:\/\//, '').slice(0, 96));
        cur = new URL(res.headers.get('location'), cur).href;
        continue;
      }
      const ct = res.headers.get('content-type') || '?';
      const text = await res.text();   // 2xx/4xx:读体判挑战壳(冷进程首访 get_file 也会撞门)
      const m = text.match(/var\s+safeid\s*=\s*'([^']+)'/);
      if (m && text.length < 3000) { jar.set('_safe', m[1]); continue; }
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
    // 总览:最新列表 → 首片详情 → 切片枚举+时长校准(串行,防请求风暴)
    const r = await fetchPage(base, '/new/');
    const cards = parseCards(r.text);
    log('── 总览(' + base + ',挑战自动过)──');
    log('· 最新视频 ' + cards.length + ' 条,首片 [' + (cards[0] && cards[0].id) + ']');
    // 相册面一行概况(失败不挡视频总览)
    try {
      const ar = await fetchPage(base, '/albums/');
      const alist = parseAlbums(ar.text);
      log('· 相册专区 ' + alist.length + ' 本,首本 [' + (alist[0] && alist[0].id) + '](' + (alist[0] && alist[0].count) + '张)');
    } catch (e) { log('· 相册专区不可达(' + e.message.slice(0, 60) + ')'); }
    if (cards[0]) {
      await COMMANDS.video(base, String(cards[0].id));
      await COMMANDS.segs(base, String(cards[0].id));
    }
    log('✔ 总览完成(基地址 ' + base + ')');
  } else {
    const fn = COMMANDS[cmd];
    if (!fn) die('未知命令 "' + cmd + '"(可用: ' + Object.keys(COMMANDS).join(' / ') + ')');
    await fn(base, arg1);
  }
  process.exitCode = process.exitCode || 0;   // 不强杀:Node24/win 下 process.exit 会触发 libuv 句柄断言,自然排空
})().catch(e => { if (e.message !== '__DIE__') { console.error('✘ ' + e.message); process.exitCode = 1; } });
