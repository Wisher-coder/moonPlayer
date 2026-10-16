// ============================================================
// avjb.js —— 艾薇社区插件(KVS 内核 HTML 抓取,仅 Node 服务端运行)
//
// 逆向结论(2026-10-06 授权测试环境实测,移植自 CLI 取证版 avjb_api.js):
//   · KVS 内核服务端直出 HTML,无独立 JSON API——数据面 = 页面解析;
//   · 入口有 rsso2 JS 挑战 + 18+ 年龄门(整页 ~1KB):页内 var safeid='<16字符>'
//     即钥匙——写 cookie _safe=<safeid> 后原地重取即过(模块级 jar 进程保活,
//     免每请求过门);
//   · 视频内容双世代并存,切片为 .jpg 伪装扩展的明文 TS,零签名零鉴权
//     (ACAO:* 与 Range 全开、TS 同步字节 0x47@0/188/376 俱在):
//       - 新片:bot.imgclh.com / list.avstatic.com 的 /videos/{dir}/{id}/NNNN.jpg;
//       - 老片:r22.jb-aiwei.cc 的【/cdn/ 前缀挂载】/cdn/videos/{dir}/{id}/NNNN.jpg
//         (r22 的 /videos/ 挂载对 .jpg 一律 403,勿被此假象误导);
//     目录公式 dir=floor(id/1000)*1000,切片 0000.jpg 起 4 位零填充连续编号;
//   · 页面内联 Playerjs file: 配置对访客恒为 30 秒试看流 *video_limt.mp4
//     (Referer 白名单放行 avjb.cc 系域,服务端须显式带 Referer);
//   · 登录态 spped.php 签名线路(需 cookie+已购)本版不实现——产品已移除
//     账号体系,此处留扩展位:后续若恢复账号,可在 resolvePlay ① 之前挂接
//     /player/spped.php?csrf=<页面 PLAYER_CSRF> 签名 m3u8 线路(时效约 45 分钟)。
//   · 作者体系(2026-10-06 实测):站点有真实作者(上传者),全站卡片/详情页均带
//     .card-owner 作者行(onclick 跳 /members/{id}/,含头像/名称/验证标);
//     作者主页 /members/{id}/(h1=名、验证作者徽章、{N} 视频、订阅档位——付费面
//     不外泄);作者片单 /members/{id}/videos/,KVS 异步分页直连可用:
//     ?mode=async&function=get_block&block_id=list_videos_uploaded_videos&
//     sort_by=post_date&from_videos={页} 返回 HTML 片段(每页 12 条);
//     hasMore = 分页器 li.next 内含 <a>(末页为 <span>);超界页 404 且带垃圾
//     卡片,不可用条目数判底。
//   · 相册专区(2026-10-06 实测,/albums/ 独立于视频面,同壳同门):
//     - 列表 /albums/{page}/ 12 卡/页,卡片 <div class="item  ">(双空格无 kind 类);
//       详情路径 /albums/{id}/{slug}/——【任意 slug 301 归一到真实 slug】,裸
//       /albums/{id}/ 才 404,故占位 slug 直接取、fetchPage 跟 301 即可(免
//       newembed 式 slug 解析);到底判定 = 分页器 <li class="next"><a 在场;
//     - 详情页照片【全量直出】无照片分页(实测 59/59 张全在首屏 HTML):签名跳转
//       <a href=…get_image/2/{hash}/sources/{dir}/{aid}/{pid}.jpg/> + 内层缩略图
//       data-original={cdn}/contents/albums/main/200x150/{dir}/{aid}/{pid}.jpg;
//       原图 = 缩略图路径把 /main/{尺寸}/ 换轴 /sources/(get_image 302 的落地
//       即此)——【裸链零鉴权】(无 Referer 亦 206),浏览器 <img> 免代理直用;
//       CDN 仅此一档缩略尺寸(main/400x300 等 404),原图单张可达数 MB → 瀑布流
//       用 thumb、看图器用 url 由前端分层消费;
//     - 相册卡片无作者行;详情页作者块 a.avatar[href*=members/{id}]+span.name
//       (站方号常缺头像,部分相册无作者);
//     - 相册搜索 /search/{kw}/albums/{page}/ 可用(页间内容递进但无分页器标记,
//       hasMore 沿用 items.length>0 约定);相册分类 /albums/categories/ 瓦片为
//       <a class="item"(与视频 cat-card 不同),分类 id 可为 slug(fc2)或 hex,
//       分类内列表 /albums/categories/{id}/{page}/ 同卡片+分页器。
// ============================================================
import { SitePlugin } from './base.js';

const BASE = String(process.env.AVJB_BASE || 'https://avjb.cc').replace(/\/+$/, '');
// 切片基座(含路径前缀):新片 bot/list 的 /videos/ 挂载 + 老片 r22 的 /cdn/ 挂载
const SEG_BASES = ['https://bot.imgclh.com', 'https://list.avstatic.com', 'https://r22.jb-aiwei.cc/cdn'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;
const PROBE_RETRY = 3;       // 切片探测网络错误重试(防代理抖动误判 404 截短)
const PLAY_CACHE_MAX = 300;  // 切片枚举结果缓存上限(超限按 at 淘汰最旧)

// ============ HTTP 底座(cookie jar + rsso2 挑战自动过) ============

const jar = new Map(); // name → value(Set-Cookie 增量合并,进程存活期内保活 _safe)
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
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  const ck = cookieHeader();
  if (ck) headers['Cookie'] = ck;
  if (referer) headers['Referer'] = referer;
  if (range) headers['Range'] = range;
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers });
  absorbSetCookie(res);
  return res;
}

// 页面获取(跟 301/302 共 6 跳;rsso2 挑战页自动过门:safeid → cookie _safe → 原地重取)
async function fetchPage(path) {
  let cur = path.startsWith('http') ? path : BASE + path;
  for (let hop = 0; hop < 6; hop++) {
    const res = await http(cur, { referer: BASE + '/' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      cur = new URL(res.headers.get('location'), cur).href;
      continue;
    }
    const text = await res.text();
    // 挑战壳判定:真实页也会引用 rsso2 资产,只有 ~1KB 年龄门壳才带 var safeid=
    if (/var\s+safeid\s*=\s*'/.test(text)) {
      jar.set('_safe', text.match(/var\s+safeid\s*=\s*'([^']+)'/)[1]);
      continue; // 带 _safe 重取同 URL(「满18岁进入」的全部动作即写此 cookie)
    }
    return { status: res.status, url: cur, text };
  }
  throw new Error('avjb 重定向/挑战层数超限 @' + cur);
}

// ============ 页面解析器(卡片/分类/详情) ============

const dirOf = (vid) => Math.floor(vid / 1000) * 1000;

// 展示时长串("58:26"/"1:23:45")→ 秒;解析失败给 null(内联实现,勿依赖前端 utils)
function parseDurStr(s) {
  const m = String(s || '').trim().match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return null;
  if (m[3] !== undefined) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  return (+m[1]) * 60 + (+m[2]);
}

// 相对地址绝对化(畸形地址防御:失败给空串)
function absUrl(u) {
  try { return new URL(u, BASE).href; } catch (e) { return ''; }
}

// slug 缓存:裸 /video/{id}/ 是 404,任意 slug 虽 200 但会落到另一部片的假页(勿用);
// /newembed/{id} 的「观看完整版」链接带真实 slug —— 解析一次后缓存,避免重复 newembed
const slugCache = new Map(); // id(数字) → '/video/{id}/{slug}/'

async function resolveVideoPath(vid) {
  if (slugCache.has(vid)) return slugCache.get(vid);
  const r = await fetchPage('/newembed/' + vid);
  const m = r.text.match(new RegExp('/videos?/' + vid + '/([A-Za-z0-9_%-]+)/'));
  if (!m) throw new Error('avjb newembed 未能解析 slug(视频已删?)');
  const p = '/video/' + vid + '/' + m[1] + '/';
  slugCache.set(vid, p);
  return p;
}

// 作者行解析:.card-owner(onclick 带 /members/{id}/)→ id/名称/头像/验证标;
// 只看首块起 1.2KB 窗口,防跨块串读。订阅档位/金币价等付费信息不在此块,亦不外泄
function parseOwner(html) {
  const m = html.match(/<div\s+class="card-owner"/);
  if (!m) return null;
  const seg = html.slice(m.index, m.index + 1200);
  const idm = seg.match(/\/members\/(\d+)\//);
  if (!idm) return null;
  return {
    id: idm[1],
    name: (seg.match(/class="card-owner-name">([^<]*)</) || [, ''])[1].trim(),
    avatar: (seg.match(/<img[^>]*\ssrc="([^"]+)"[^>]*class="card-owner-ava"/) || [, ''])[1],
    verified: /class="card-owner-vf"/.test(seg),
  };
}

// 视频卡片:.item → id/标题/时长串/缩略图/HD 标/作者行(金币/VIP 等付费标记刻意不外泄)
function parseCards(html) {
  const out = [];
  // 逐卡片切块再取属性,避免跨卡片串读(卡片头形如 <div class="item premium ">)
  const blocks = html.split(/<div\s+class="item /).slice(1);
  for (const b of blocks) {
    const idm = b.match(/\/video\/(\d+)\//);
    const tm = b.match(/title="([^"]*)"/);
    if (!idm || !tm) continue;
    // 缩略图:懒加载位 data-original 优先,作者片单页直出 src(class 在 src 前后皆可)
    const thumbTag = (b.match(/<img[^>]*\bclass="thumb[^"]*"[^>]*>/) || [''])[0];
    out.push({
      id: +idm[1],
      title: tm[1],
      duration: (b.match(/class="duration">([^<]*)</) || [, ''])[1],
      hd: /class="is-hd"/.test(b),
      thumb: (b.match(/data-original="([^"]+)"/) || thumbTag.match(/\ssrc="([^"]+)"/) || [, ''])[1],
      owner: parseOwner(b),
    });
  }
  return out;
}

// 分类瓦片:<a class="cat-card" href=…/categories/{hash}/ title="{名}">…{N}视频…
function parseCategories(html) {
  const out = [];
  for (const m of html.matchAll(/<a class="cat-card" href="https?:\/\/[^\/]+\/categories\/([a-f0-9]+)\/" title="([^"]*)">[\s\S]*?<div class="v">(\d+)视频</g)) {
    out.push({ hash: m[1], name: m[2], count: +m[3] });
  }
  return out;
}

// 视频详情页:标题/时长/日期/直链配置/海报/相关卡片/分类标签/在引存储基座
function parseDetail(html) {
  const d = {};
  d.title = (html.match(/<h1[^>]*>([^<]*)<\/h1>/) || [, (html.match(/property="og:title" content="([^"]*)"/) || [, ''])[1]])[1].trim();
  const iso = html.match(/"uploadDate":\s*"([^"]+)"/);
  d.uploadDate = iso ? iso[1] : '';
  const pt = html.match(/"duration":\s*"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?"/);
  if (pt) d.duration = (+pt[1] || 0) * 3600 + (+pt[2] || 0) * 60 + (+pt[3] || 0);
  d.limt = (html.match(/file\s*:\s*"(https?:\/\/[^"]+video_limt\.mp4)"/) || [, ''])[1];
  d.file = (html.match(/file\s*:\s*"(https?:\/\/[^"]+)"/) || [, ''])[1];
  d.poster = (html.match(/"thumbnailUrl":\s*"(https?:\/\/[^"]+)"/) || [, ''])[1];
  d.categories = [...html.matchAll(/\/categories\/([a-f0-9]+)\/"[^>]*>([^<]{1,30})</g)].map((m) => ({ hash: m[1], name: m[2] }));
  d.tags = [...html.matchAll(/\/tags\/[a-z0-9]+\/"[^>]*>([^<]{1,24})</g)].map((m) => m[1]);
  // 【实测边界】详情页(游客态)不携带本片作者:主体信息区/JSON-LD/meta/embed/
  // newembed/AJAX 块均无 members 引用(订阅用户块只有 CSS 模板不渲染;相关卡为
  // 分类混合推荐,其 card-owner 不等于本片作者)——作者仅存在于列表卡片
  // (list/search/byauthor 的 .card-owner)。故 Detail 不输出 author 字段,
  // 观看页作者行由前端「卡片作者随行」展示(见 src/lib/card-author.js)。
  // 锚 _items 容器(容器 id 本体在 AJAX 分页属性里还会出现一次且位于卡片之后,pop 会取空)
  d.related = parseCards(html.split('id="list_videos_related_videos_items"').pop() || '');
  // 页面在引的视频存储主机(内联脚本文本,含 Playerjs 配置)→ /cdn 基座(rNN 轮换自适应)
  d.segBases = [...new Set([...html.matchAll(/https?:\/\/([a-z0-9.-]+\.jb-aiwei\.cc)\//gi)].map((m) => 'https://' + m[1] + '/cdn'))];
  return d;
}

// ============ 相册面解析器(2026-10-06 实测,结构见文件头) ============

// 相册卡片:<div class="item  ">(双空格无 kind,与视频卡同头不同身)→
// id/标题/张数/封面/发布时间;相册卡片无作者行/付费标记(社交付费面照旧不外泄)
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

// 相册分类瓦片:<a class="item" href=…/albums/categories/{id}/ title="{名}">…{N}相册
// (注意与视频的 <a class="cat-card" 不同;分类 id 可为 slug(fc2)或 hex hash)
function parseAlbumCategories(html) {
  const out = [];
  for (const m of html.matchAll(/<a class="item" href="https?:\/\/[^\/]+\/albums\/categories\/([a-z0-9]+)\/" title="([^"]*)">[\s\S]*?<div class="albums">(\d+)相册</g)) {
    out.push({ id: m[1], name: m[2], count: +m[3] });
  }
  return out;
}

// 相册详情页:标题/张数/加入日期/描述/作者块/分类标签/照片清单(全量直出)/相关相册
function parseAlbumDetail(html) {
  const d = {};
  d.title = (html.match(/<h1[^>]*>([^<]*)<\/h1>/) || [, (html.match(/property="og:title" content="([^"]*)"/) || [, ''])[1]])[1].trim();
  d.count = +(html.match(/照片:\s*<em>(\d+)<\/em>/) || [, 0])[1];
  d.added = (html.match(/加入日期:\s*<em>([^<]*)<\/em>/) || [, ''])[1].trim();
  d.desc = (html.match(/描述:\s*<em>([^<]*)<\/em>/) || [, ''])[1].trim();
  // 作者块:<a class="avatar" href=…/members/{id}/ title="{名}"> + span.name(部分相册无作者)
  d.member = null;
  const av = html.match(/<a class="avatar" href="https?:\/\/[^"]+\/members\/(\d+)\/" title="([^"]*)"/);
  if (av) d.member = { id: av[1], name: av[2], avatar: '', verified: false };
  d.categories = [...html.matchAll(/\/albums\/categories\/([a-z0-9]+)\/"[^>]*>([^<]{1,30})</g)].map((m) => ({ id: m[1], name: m[2].trim() }));
  d.tags = [...html.matchAll(/\/albums\/tags\/[a-z0-9]+\/"[^>]*>([^<]{1,24})</g)].map((m) => m[1].trim());
  // 照片:签名跳转 <a href="…get_image/2/{hash}/sources/{dir}/{aid}/{pid}.jpg/"> + 内层
  // 缩略图 data-original={cdn}/contents/albums/main/{尺寸}/{dir}/{aid}/{pid}.jpg——
  // 原图 = 缩略图路径把 /main/{尺寸}/ 换轴 /sources/(get_image 302 的落地即此,裸链)
  d.photos = [...html.matchAll(/<a href="([^"]*get_image\/2\/[a-f0-9]+\/sources\/\d+\/\d+\/\d+\.jpg\/)"[^>]*>\s*<img[^>]*data-original="([^"]+)"/g)]
    .map((m) => ({ thumb: m[2], url: m[2].replace(/\/main\/[^/]+\//, '/sources/') }));
  // 相关相册容器(锚 _items,与视频 related 同款手法)
  d.related = parseAlbums(html.split('id="list_albums_related_albums_items"').pop() || '');
  return d;
}

// 相册卡片归一化 → AlbumItem(封面为裸 CDN 直链,浏览器可直接 <img>,不走代理)
function normAlbums(albums) {
  const out = [];
  for (const a of albums || []) {
    if (!a || !a.id) continue;
    out.push({
      id: a.id,
      title: a.title || '',
      cover: a.thumb ? absUrl(a.thumb) : '',
      count: a.count || 0,
      added: a.added || '',
    });
  }
  return out;
}

// ============ 切片存储面(探测/末段二分/时长校准/合成清单) ============

const segUrl = (base, vid, n) => base + '/videos/' + dirOf(vid) + '/' + vid + '/' + String(n).padStart(4, '0') + '.jpg';

// 状态码探测:响应头到即断不下载体;网络错误重试 3 次后按缺失处理
async function probe(url, referer) {
  for (let i = 0; i < PROBE_RETRY; i++) {
    try {
      const res = await http(url, { referer, method: 'GET' });
      try { res.body && res.body.cancel(); } catch (e) { /* 忽略取消异常 */ }
      return res.status;
    } catch (e) { /* 重试 */ }
  }
  return -1;
}

// 倍增上界 + 二分找末段(串行 ~2×log₂N 次探测;保守节奏,勿为提速并发轰炸)
async function findLast(base, vid, referer) {
  if (await probe(segUrl(base, vid, 0), referer) !== 200) return -1;
  let hi = 1;
  while (await probe(segUrl(base, vid, hi), referer) === 200) hi *= 2;
  let lo = hi / 2; // lo=在,hi=首缺
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    (await probe(segUrl(base, vid, mid), referer) === 200) ? (lo = mid) : (hi = mid);
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

// 抽样 2 对相邻切片(片头+片中)实解 PTS 求均段时长(老片 /cdn ≈1s,新片 ≈1.7s;失败回退 0 → 合成按 1s)
async function calibDur(base, vid, last, referer) {
  const mid = Math.max(1, last >> 1);
  const idx = [0, 1, mid, mid + 1];
  const bufs = await Promise.all(idx.map((n) => fetchBuf(segUrl(base, vid, n), referer)));
  const pts = bufs.map((b) => (b ? firstPts(b) : -1));
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

// 全片清单合成:EXTINF 用校准 dur(失败按 1s 名义),切片为绝对 URL,浏览器 hls.js 直消费
function synthM3u8(base, vid, last, dur) {
  const d = dur || 1;
  let t = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:' + Math.max(1, Math.ceil(d)) +
    '\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n';
  for (let i = 0; i <= last; i++) t += '#EXTINF:' + d.toFixed(6) + ',\n' + segUrl(base, vid, i) + '\n';
  return t + '#EXT-X-ENDLIST\n';
}

// ============ 切片枚举与缓存 ============

// 切片枚举结果 LRU 缓存:playlist 合成直接命中,免重复二分轰炸上游
const playCache = new Map(); // id(字符串) → {host,last,dur,at}
function cachePlay(vid, host, last, dur) {
  const v = { host, last, dur, at: Date.now() };
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

// 切片枚举:基座 = 硬编码三基座 ∪ 详情页在引 *jb-aiwei.cc/cdn,
// 顺序探测(0 号片 200 者胜,命中即停),命中后 calibDur 校准均段时长
async function enumerateSegs(vid, d) {
  const bases = [...new Set([...SEG_BASES, ...((d && d.segBases) || [])])];
  const ref = BASE + '/';
  for (const b of bases) {
    const last = await findLast(b, vid, ref);
    if (last >= 0) {
      const dur = await calibDur(b, vid, last, ref);
      return { host: b, last, dur };
    }
  }
  return null;
}

// 详情页加载(slug 走缓存;产出解析后的原始字段,归一化在各方法内做)
async function loadDetail(vid) {
  const r = await fetchPage(await resolveVideoPath(vid));
  return parseDetail(r.text);
}

// 卡片归一化 → VideoItem(avjb 封面/头像是裸 CDN 直链,浏览器可直接 <img>,不走代理);
// 卡片带作者行时输出可选 author 字段,解析不出则整字段省略(前端按此条件渲染作者行)
function normCards(cards) {
  const out = [];
  for (const c of cards || []) {
    if (!c || !c.id) continue;
    const it = {
      id: c.id,
      title: c.title || '',
      cover: c.thumb ? absUrl(c.thumb) : '',
      duration: parseDurStr(c.duration),
      hd: !!c.hd,
    };
    if (c.owner && c.owner.id && c.owner.name) {
      it.author = { id: c.owner.id, name: c.owner.name, avatar: c.owner.avatar ? absUrl(c.owner.avatar) : '', verified: !!c.owner.verified };
    }
    out.push(it);
  }
  return out;
}

// ============ 插件类 ============

export class AvjbPlugin extends SitePlugin {
  get id() { return 'avjb'; }
  get name() { return '艾薇社区'; }
  // 游客态 HTML 抓取源:无首页聚合/热词/标签/专辑/排序能力
  // (对应方法不覆盖,基类默认抛,包装层回 502,前端按能力自适应不会调到);
  // 相册专区(/albums/)为 avjb 独有面 → albums 能力
  get capabilities() { return { home: false, hotwords: false, tags: false, dvds: false, bytag: false, sort: false, author: true, albums: true }; }

  async list(o = {}) {
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const cat = o.category != null ? String(o.category).trim() : '';
    if (cat && !/^[a-f0-9]+$/i.test(cat)) throw new Error('avjb 非法分类参数(须为十六进制 hash)');
    const path = cat
      ? '/categories/' + cat + '/' + (page > 1 ? page + '/' : '')
      : '/new/' + page + '/';
    const r = await fetchPage(path);
    const items = normCards(parseCards(r.text));
    return { items, page, hasMore: items.length > 0 };
  }

  async search(kw, o = {}) {
    const k = String(kw || '').trim();
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    if (!k) return { items: [], page: 1, hasMore: false };
    // 搜索为路径编码,分页为路径段
    const r = await fetchPage('/search/' + encodeURIComponent(k) + '/videos/' + (page > 1 ? page + '/' : ''));
    const items = normCards(parseCards(r.text));
    return { items, page, hasMore: items.length > 0 };
  }

  async categories() {
    const r = await fetchPage('/categories/');
    return parseCategories(r.text).map((c) => ({ id: c.hash, name: c.name, count: c.count }));
  }

  async detail(id) {
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('avjb detail 缺少有效视频 id');
    const d = await loadDetail(vid);
    // 白名单构造:金币/VIP/付费墙等社交付费字段一律不带出;author 亦不带出
    // (上游详情页游客态无作者字段,见 parseDetail 注释)
    return {
      id: vid,
      title: d.title || '',
      cover: d.poster ? absUrl(d.poster) : '',
      duration: typeof d.duration === 'number' ? d.duration : null,
      hd: false,
      resolution: '',
      uploadDate: d.uploadDate || '',
      tags: (d.tags || []).map((t) => ({ id: null, name: t })),
      categories: (d.categories || []).map((c) => ({ id: c.hash, name: c.name })),
    };
  }

  // 作者资料:/members/{id}/ → 名称/头像/验证标/视频数(仅内容元数据;
  // 订阅档位价格属付费面,契约红线不外泄)
  async author(id) {
    const mid = parseInt(id, 10);
    if (!Number.isFinite(mid) || mid <= 0) throw new Error('avjb author 缺少有效作者 id');
    const r = await fetchPage('/members/' + mid + '/');
    if (r.status === 404) throw new Error('avjb 作者不存在(可能已注销)');
    const name = (r.text.match(/<h1[^>]*>([^<]*)<\/h1>/) || [, ''])[1].trim();
    if (!name) throw new Error('avjb 作者页解析失败(年龄门/风控页?)');
    // 头像:资料头图(contents/avatars/…),与卡片头像同存储
    const avatar = (r.text.match(/<img[^>]*\ssrc="([^"]*\/avatars\/[^"]+)"/) || [, ''])[1];
    // 视频数:资料区统计「<b>302</b> 视频」(数字裹 b 标签;片单标题另有
    // 「视频 (301)」口径且数字在后,不会误中;侧栏「视频 99+」数字亦在后)
    const vc = r.text.match(/<b>(\d[\d,.]*)<\/b>\s*视频/) || r.text.match(/(\d[\d,.]*)\s*视频/);
    return {
      id: String(mid),
      name,
      avatar: avatar ? absUrl(avatar) : '',
      verified: /验证作者/.test(r.text),
      videoCount: vc ? (parseInt(vc[1].replace(/[,.]/g, ''), 10) || 0) : 0,
    };
  }

  // 作者视频列表:KVS 异步分页直连(get_block HTML 片段,每页 12 条,免整页开销)。
  // hasMore = 片段分页器 li.next 内含 <a>(末页为 <span>);超界页 404 且带垃圾
  // 卡片,按空页收尾。sort 固定 post_date(最新)
  async byauthor(id, o = {}) {
    const mid = parseInt(id, 10);
    if (!Number.isFinite(mid) || mid <= 0) throw new Error('avjb byauthor 缺少有效作者 id');
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const path = '/members/' + mid + '/videos/?mode=async&function=get_block&block_id=list_videos_uploaded_videos&sort_by=post_date&from_videos=' + page;
    const r = await fetchPage(path);
    if (r.status === 404) return { items: [], page, hasMore: false };
    return { items: normCards(parseCards(r.text)), page, hasMore: /<li\s+class="next">\s*<a/.test(r.text) };
  }

  async related(id) {
    // avjb 相关推荐 = 详情页侧栏卡片,无上游分页接口
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('avjb related 缺少有效视频 id');
    const d = await loadDetail(vid);
    return { items: normCards(d.related), page: 1, hasMore: false };
  }

  // 游客态三级解析:① 页面内联正片直链 → ② 切片枚举合成 → ③ 兜底 30 秒试看流
  async resolvePlay(id) {
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('avjb resolvePlay 缺少有效视频 id');
    const d = await loadDetail(vid);
    // ① 页面内联正片直链(游客态 file 恒为试看流,须排除后按 m3u8 后缀判型)
    if (d.file && !/video_limt\.mp4/.test(d.file)) {
      return { type: /\.m3u8(\?|#|$)/.test(d.file) ? 'hls' : 'mp4', url: d.file, via: 'page' };
    }
    // ② 切片枚举合成全片清单(浏览器经 /api/avjb/playlist 消费,hls.js 直接播)
    const hit = await enumerateSegs(vid, d);
    if (hit) {
      cachePlay(vid, hit.host, hit.last, hit.dur);
      return { type: 'hls', url: '/api/avjb/playlist?id=' + vid, via: 'segs' };
    }
    // ③ 兜底试看流(30 秒 limt.mp4,页面内联值优先,否则按存储节点公式构造)
    const url = d.limt || ('https://r22.jb-aiwei.cc/videos/' + dirOf(vid) + '/' + vid + '/' + vid + 'video_limt.mp4');
    return { type: 'mp4', url, via: 'trial' };
  }

  // 播放清单合成:缓存命中直接合成;未命中跑一遍枚举再合成
  async playlist(id) {
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('avjb playlist 缺少有效视频 id');
    let hit = playCache.get(String(vid));
    if (!hit) {
      const d = await loadDetail(vid);
      const e = await enumerateSegs(vid, d);
      if (!e) throw new Error('avjb 全部基座均无切片,无法合成播放清单(视频已删/私有?)');
      hit = cachePlay(vid, e.host, e.last, e.dur);
    }
    return synthM3u8(hit.host, vid, hit.last, hit.dur);
  }

  // —— 相册面(仅 albums 能力;路径/结构见文件头实测注释) ——

  // 相册列表:12 卡/页;到底 = 分页器 li.next 内含 <a>(末页为 <span>)
  async albumList(o = {}) {
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const cat = o.category != null ? String(o.category).trim() : '';
    if (cat && !/^[a-z0-9]+$/i.test(cat)) throw new Error('avjb 非法相册分类参数(须为 slug 或十六进制 hash)');
    const path = cat
      ? '/albums/categories/' + cat + '/' + (page > 1 ? page + '/' : '')
      : '/albums/' + page + '/';
    const r = await fetchPage(path);
    return { items: normAlbums(parseAlbums(r.text)), page, hasMore: /<li\s+class="next">\s*<a/.test(r.text) };
  }

  // 相册搜索:页间内容递进但页面无分页器标记,hasMore 沿用 items.length>0 约定(与视频搜索一致)
  async albumSearch(kw, o = {}) {
    const k = String(kw || '').trim();
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    if (!k) return { items: [], page: 1, hasMore: false };
    const r = await fetchPage('/search/' + encodeURIComponent(k) + '/albums/' + (page > 1 ? page + '/' : ''));
    const items = normAlbums(parseAlbums(r.text));
    return { items, page, hasMore: items.length > 0 };
  }

  // 相册分类索引
  async albumCategories() {
    const r = await fetchPage('/albums/categories/');
    return parseAlbumCategories(r.text).map((c) => ({ id: c.id, name: c.name, count: c.count }));
  }

  // 相册详情:任意 slug 301 归一 → 占位 slug 直接取,fetchPage 跟 301 落真实页;
  // 照片全量直出(免分页),related 为详情页顺带解析的相关相册(可选字段)
  async albumDetail(id) {
    const aid = parseInt(id, 10);
    if (!Number.isFinite(aid) || aid <= 0) throw new Error('avjb albumDetail 缺少有效相册 id');
    const r = await fetchPage('/albums/' + aid + '/nw/');
    const d = parseAlbumDetail(r.text);
    if (!d.title && !d.photos.length) throw new Error('avjb 相册页解析失败(已删/ID 错误?)');
    // 封面:380x500 竖版 preview(由缩略图路径换轴推导),推导失败退回首张缩略图
    let cover = '';
    if (d.photos.length) {
      cover = d.photos[0].thumb.replace(/\/main\/[^/]+\//, '/preview/380x500/').replace(/\/[^/]+\.jpg$/, '/preview.jpg');
      if (cover === d.photos[0].thumb) cover = d.photos[0].thumb;
    }
    const out = {
      id: aid,
      title: d.title || '',
      cover: cover ? absUrl(cover) : '',
      count: d.count || d.photos.length,
      uploadDate: d.added || '',
      description: d.desc || '',
      tags: (d.tags || []).map((t) => ({ id: null, name: t })),
      categories: (d.categories || []).map((c) => ({ id: c.id, name: c.name })),
      photos: d.photos.map((p) => ({ url: absUrl(p.url), thumb: absUrl(p.thumb) })),
    };
    if (d.member && d.member.id && d.member.name) out.author = { id: d.member.id, name: d.member.name, avatar: '', verified: false };
    if (d.related && d.related.length) out.related = normAlbums(d.related);
    return out;
  }
}
