// ============================================================
// zimuquan.js —— 字母圈插件(maccms HTML 抓取,仅 Node 服务端运行)
//
// 逆向结论(2026-10-06 授权测试环境实测,移植自 CLI 取证版 zimuquan_api.js):
//   · 站群无独立 JSON API——数据面 = maccms 服务端直出 HTML,但整页包一层
//     反扒壳:首个 <script> 为 document.write(decodeURIComponent(atob("<base64>")))
//     ——Base64+URI 双层编码,一次解开即明文 HTML(无 VM 沙箱需求);
//   · 入口域无挑战门无年龄门,零 cookie 依赖(发布页 www.zmqurl7.top 系
//     .site-url[data-url] 静态直给,站群全部同壳同库,任一存活域可作基座);
//   · 视频卡片区:col-5 卡 → .subtitle 标题 / .time 时长 / data-src 封面
//     (efv 系视频主机直链,ACAO:* 可热链,浏览器 <img> 直用不走代理);
//   · 播放页即详情页(voddetail 404):免费/福利片内联 var player_aaaa=
//     {"url":"…/movie/auto/{mid}.m3u8?counts=5&timestamp=…&key=…"} 签名主清单
//     直给;VIP/金币片无 player_aaaa,代之以付费墙弹窗 popup-text——游客态
//     不可播,resolvePlay 如实抛错(产品无账号体系,登录态线路留扩展位:
//     后续若恢复账号,可在此挂接会员态播放页解析);
//   · m3u8 两级链路:主清单(单 variant,绝对 URL 自带二级签名)→ 子清单
//     (AES-128 密钥与 indexN.ts 均相对路径,hls.js 按清单 URL 自动解析);
//     主/子/ts/key 实测全部 ACAO:*,浏览器 hls.js 直连播放,服务器不过流量;
//     签名分钟级时效——resolvePlay 每次现取播放页,不做长缓存;
//   · 分页/排序:maccms 路径段式 /index.php/vod/show/by/{time|hits_week|up}/
//     id/{cat}/page/{n}.html(cat=1 全部);页脚「共N条数据,当前x/y页」给
//     总页数(hasMore 依据);搜索 /vod/search/page/{n}/wd/{kw}.html;
//     专题(=专辑)detail 走 query 式 ?page=N 且无 page_tip,空页即止。
// ============================================================
import { SitePlugin } from './base.js';

const BASE = String(process.env.ZMQ_BASE || 'https://www2.zimuquan16.com').replace(/\/+$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;
// 前端统一排序键 → 站点 by/{sort} 原生值(最新/最热/最赞)
const SORTS = { post_date: 'time', video_viewed: 'hits_week', most_popular: 'up' };
// 会员态 Cookie(可选):VIP/金币片播放页仅对有权限账号渲染 player_aaaa(签名主清单),
// 配置后插件带 Cookie 取页即得签名流 → 游客态不可播的付费片真实直读播放
// (浏览器 DevTools → Network → 任意站内请求 → Cookie 头原样抄入)
const COOKIE = String(process.env.ZMQ_COOKIE || '').trim();

// ============ HTTP 底座(编码壳解包) ============

async function http(url, { referer } = {}) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  if (COOKIE) headers['Cookie'] = COOKIE;
  if (referer) headers['Referer'] = referer;
  return fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers });
}

// 反扒壳解包:Base64+URI 双层编码一次解开;无壳(已明文)原样返回
function unwrap(text) {
  const m = text.match(/atob\("([A-Za-z0-9+/=]+)"\)/);
  if (!m) return text;
  try { return decodeURIComponent(Buffer.from(m[1], 'base64').toString('utf8')); }
  catch (e) { return text; }
}

// 页面获取:GET → 解壳;非 200 或空壳抛错(站点无挑战门无重定向戏法)
async function fetchPage(path) {
  const url = path.startsWith('http') ? path : BASE + path;
  const res = await http(url, { referer: BASE + '/' });
  const text = unwrap(await res.text());
  if (res.status >= 400) throw new Error('字母圈 HTTP ' + res.status + ' @' + url);
  if (!text || text.length < 500) throw new Error('字母圈页面过短(' + (text ? text.length : 0) + 'B,改版?)');
  return text;
}

// ============ 页面解析器(卡片/分类/专题/详情) ============

// 展示时长串("00:02:54"/"58:26")→ 秒;失败给 null(内联实现,勿依赖前端 utils)
function parseDurStr(s) {
  const m = String(s || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  return (+m[1] || 0) * 3600 + (+m[2]) * 60 + (+m[3]);
}

// 相对地址绝对化(畸形地址防御:失败给空串)
function absUrl(u) {
  try { return new URL(u, BASE).href; } catch (e) { return ''; }
}

// 视频卡片:逐锚点切块(<a href=/index.php/vod/play/id/{id}/… class="col-5">);
// 角标 vip/gold/welfare 仅供内部识别,归一化输出不带付费字段
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
    out.push({
      id: +ms[i][1],
      title: sm[1].trim(),
      kind: /<div class="gold">/.test(head) ? 'coin' : /<div class="welfare">/.test(head) ? 'free' : 'vip',
      duration: (head.match(/class="time">([^<]*)</) || [, ''])[1].trim(),
      thumb: (head.match(/data-src="([^"]+)"/) || [, ''])[1],
    });
  }
  return out;
}

// 分类导航:首页 header 的 vod/type/id/{N}.html(全集在首页;show 页 classify 只有子集)
function parseCategories(html) {
  const out = [];
  for (const m of html.matchAll(/href="\/index\.php\/vod\/(?:type|show)\/id\/(\d+)\.html"[^>]*>\s*([^<]{2,10})\s*</g)) {
    if (!out.some((c) => c.id === m[1])) out.push({ id: m[1], name: m[2].trim() });
  }
  return out;
}

// 页脚总数:「共72218条数据,当前1/2889页」→ hasMore 依据
function parsePageTip(html) {
  const m = html.match(/共(\d+)条数据,当前(\d+)\/(\d+)页/);
  return m ? { total: +m[1], page: +m[2], pages: +m[3] } : null;
}

// 专题瓦片:topic/detail 锚点切块 → .movie「N部影片」/.subtitle/data-src
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

// 播放页(=详情页):player_aaaa(免费/福利片,含签名主清单+海报)或付费墙弹窗;
// 元数据:标题(operation-bottom 首个 li)/日期/点赞/分类标签/相关推荐侧栏
function parseDetail(html) {
  const d = { player: null, paywall: '' };
  const pm = html.match(/var player_aaaa=(\{.*?\})<\/script>/s);
  if (pm) {
    try {
      const j = JSON.parse(pm[1]);
      d.player = { url: j.url || '', poster: j.poster || '', name: (j.vod_data && j.vod_data.vod_name) || '' };
    } catch (e) { /* 忽略畸形 JSON */ }
  }
  d.paywall = (html.match(/<div class="popup-text">([^<]*)</) || [, ''])[1].trim() ||
    (/此影片为VIP专享/.test(html) ? '此影片为VIP专享' : '');
  d.title = '';
  const oi = html.indexOf('class="operation-bottom"');
  if (oi >= 0) {
    const seg = html.slice(oi, oi + 1200);
    d.title = (seg.match(/<li>([^<]*)<\/li>/) || [, d.player ? d.player.name : ''])[1].trim();
    d.category = (seg.match(/class="category">([^<]*)</) || [, ''])[1].trim();
    d.uploadDate = (seg.match(/<span>(\d{4}-\d{2}-\d{2})<\/span>/) || [, ''])[1];
  }
  if (!d.title && d.player) d.title = d.player.name;
  d.digg = +((html.match(/class="digg_num">(\d+)</) || [, 0])[1]);
  d.poster = (d.player && d.player.poster) || (html.match(/background-image:\s*url\((https?:\/\/[^)]+)\)/) || [, ''])[1];
  // 相关推荐:「猜你喜欢」侧栏(#scrollBar 容器到 </ul> 止)
  const rb = html.split('id="scrollBar"').pop() || '';
  d.related = parseCards(rb.split('</ul>')[0]);
  return d;
}

// ============ 归一化 ============

// 卡片 → VideoItem(封面为 efv 系主机直链,ACAO:* 浏览器直接 <img>,不走代理)
function normCards(cards) {
  const out = [];
  for (const c of cards || []) {
    if (!c || !c.id) continue;
    out.push({
      id: c.id,
      title: c.title || '',
      cover: c.thumb ? absUrl(c.thumb) : '',
      duration: parseDurStr(c.duration),
      hd: false,
    });
  }
  return out;
}

// 播放页路径(站点标准形态;slug 恒 sid/1/nid/1)
const playPath = (vid) => '/index.php/vod/play/id/' + vid + '/sid/1/nid/1.html';

// ============ 插件类 ============

export class ZimuquanPlugin extends SitePlugin {
  get id() { return 'zimuquan'; }
  get name() { return '字母圈'; }
  // HTML 抓取源:无热词/标签能力;专题(专辑)有;排序三档(最新/最热/最赞)
  get capabilities() { return { home: true, hotwords: false, tags: false, dvds: true, bytag: false, sort: true }; }

  async list(o = {}) {
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const cat = o.category != null && String(o.category).trim() ? String(o.category).trim() : '1';
    if (!/^\d+$/.test(cat)) throw new Error('字母圈非法分类参数(须为数字 id)');
    const sort = SORTS[o.sort] || 'time';
    const html = await fetchPage('/index.php/vod/show/by/' + sort + '/id/' + cat + '/page/' + page + '.html');
    const items = normCards(parseCards(html));
    const tip = parsePageTip(html);
    return { items, page, hasMore: tip ? tip.page < tip.pages : items.length > 0 };
  }

  async search(kw, o = {}) {
    const k = String(kw || '').trim();
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    if (!k) return { items: [], page: 1, hasMore: false };
    const html = await fetchPage('/index.php/vod/search/page/' + page + '/wd/' + encodeURIComponent(k) + '.html');
    const items = normCards(parseCards(html));
    const tip = parsePageTip(html);
    return { items, page, hasMore: tip ? tip.page < tip.pages : items.length > 0 };
  }

  async categories() {
    return parseCategories(await fetchPage('/')).map((c) => ({ id: c.id, name: c.name, count: 0 }));
  }

  async detail(id) {
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('字母圈 detail 缺少有效视频 id');
    const d = parseDetail(await fetchPage(playPath(vid)));
    // 白名单构造:VIP/金币等付费字段一律不带出(付费形态只在 resolvePlay 报错时明示)
    return {
      id: vid,
      title: d.title || '',
      cover: d.poster ? absUrl(d.poster) : '',
      duration: null,   // 播放页无时长字段(仅列表卡片有;此处不可得)
      hd: false,
      resolution: '',
      uploadDate: d.uploadDate || '',
      tags: [],
      categories: d.category ? [{ id: null, name: d.category }] : [],
    };
  }

  async related(id) {
    // 相关推荐 = 播放页「猜你喜欢」侧栏,无上游分页接口
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('字母圈 related 缺少有效视频 id');
    const d = parseDetail(await fetchPage(playPath(vid)));
    return { items: normCards(d.related), page: 1, hasMore: false };
  }

  async home() {
    const html = await fetchPage('/');
    const nav = parseCategories(html).map((c) => ({ id: c.id, title: c.name }));
    const notice = (html.match(/<div class="notice-text">\s*([\s\S]*?)\s*<\/div>/) || [, ''])[1].replace(/\s+/g, ' ');
    // 「最近更新」区块:锚点 <li>最近更新</li> 之后到下一个 maxWidth 区块止
    const i = html.indexOf('<li>最近更新</li>');
    const seg = i >= 0 ? html.slice(i, i + 40000) : html;
    const items = normCards(parseCards(seg).slice(0, 24));
    return { notice, nav, list: { items, page: 1, hasMore: true } };
  }

  async dvds() {
    // 专题索引:单页瓦片(站方无分页),cover 为站内相对路径 → 绝对化(可热链)
    const ts = parseTopics(await fetchPage('/index.php/topic/index.html'));
    return {
      items: ts.map((t) => ({ id: t.id, title: t.title, cover: t.thumb && t.thumb !== '/' ? absUrl(t.thumb) : '', count: t.count })),
      page: 1,
      hasMore: false,
    };
  }

  async bydvd(dvd, o = {}) {
    // 专题内视频:query 式分页 ?page=N,无 page_tip → 空页即止
    const tid = String(dvd || '').trim();
    if (!/^\d+$/.test(tid)) throw new Error('字母圈 bydvd 缺少有效专题 id');
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const html = await fetchPage('/index.php/topic/detail/id/' + tid + '.html?page=' + page);
    const items = normCards(parseCards(html));
    return { items, page, hasMore: items.length > 0 };
  }

  // 游客态解析:免费/福利片播放页直给签名主清单(浏览器 hls.js 直连,
  // 主/子/密钥/切片全链 ACAO:*);VIP/金币片签名流只对有权限账号渲染——
  // 配 ZMQ_COOKIE 会员态即真实直读播放,游客态如实抛错并给出指引
  async resolvePlay(id) {
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('字母圈 resolvePlay 缺少有效视频 id');
    const d = parseDetail(await fetchPage(playPath(vid)));
    if (d.player && d.player.url) {
      // 签名分钟级时效:每次现取播放页,浏览器即刻消费
      return { type: 'hls', url: d.player.url, via: COOKIE ? 'member' : 'page' };
    }
    if (d.paywall) {
      // 实测付费判定完备于服务端:EFV 存储 master/子清单/密钥全链验签(签名绑片绑时,
      // 错值/挪用他片 key/跨片同主机复用均 403),ts 切片零鉴权但 AES-128 无密钥不可解,
      // 移动 UA/换线均无试看——会员态 Cookie 是唯一取流通道
      throw new Error(COOKIE
        ? '字母圈:' + d.paywall + '(ZMQ_COOKIE 已配但本片仍不可播:Cookie 失效或该账号无本片权限,请重抄 Cookie 头)'
        : '字母圈:' + d.paywall + '(付费墙为服务端硬墙,游客态无流;在 .env.local 配 ZMQ_COOKIE=<浏览器Cookie头> 并重启,即可真实播放)');
    }
    throw new Error('字母圈:该视频不可播(已删或私有?)');
  }
}
