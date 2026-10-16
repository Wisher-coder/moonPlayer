// ============================================================
// p91.js —— 91pron(Butterfly H5 同协议姊妹站,d17f2ecjynx0fw.cloudfront.net
// 站群)站点插件(仅 Node 服务端运行);只接长视频面(影片/抖音/动漫),不含短剧
//
// 逆向结论(2026-10-06 授权测试环境实测,移植自 CLI 取证版 ../Nodejs/91porn_api.js;
// 与 bf.js 同协议不同站——网关/interfaceKey/能力面均不同,勿混线):
//   · 协议与 bf 同款「Butterfly」双层 AES:请求参数 JSON → AES-128-CBC
//     (key=iv=常量 BxJand%xf5h3sycH)→ base64 → GET ?data= / POST {"data":…};
//     响应 code==200 且 hash==true 时 data 密文 = interfaceKey 常量+密文头 12B 播种
//     → SHA256 链派生 AES-256-CBC key/iv;interfaceKey 候选制轮换容错(与 bf 同把);
//     头 X-User-Agent 设备串标识 H5 终端;
//   · 登录态:游客 POST /mine/login/h5 → {token,uid};登录端点有全局限频 4007
//     (频繁换 devID 冷启触发)→ 本插件与 CLI 工具共享会话缓存文件
//     %TEMP%\91porn_api_session.json(devID 固化 + token 复用,双端只登一次);
//     失效(5009)单飞重登一次原参重放并回写文件;
//   · 分类面(本站独有,片库页 /moreCate 逆向):配置 GET /vid/library →
//     {canvas,orderBy,vidTags,acgTags,paymentType,timeType}(选项对象表);
//     筛选 POST /vid/library/search {keyword:{canvas,orderBy,tags,paymentType,
//     timeType},pageNumber,pageSize}——⚠ keyword 须传完整选项对象(字符串/裸 key
//     报 4001);timeType 传空 key 对象 = 不限时间(全量 6 万+);动漫/漫画类
//     (canvas=video/image)结果在 allMediaList 字段,其余在 list;
//   · 其余长视频面:推荐流 GET /vid/list {pageNumber,pageSize};搜索 POST
//     /search/list {keyWords:[词],realm:'SP',sortType};热词 GET /search/hotTag;
//     标签表 GET /tag/conf/list;标签视频 GET /tag/vid/list {tagID,…};
//     详情 GET /vid/info {videoID};相关 GET /vid/recommend/list {vid,…}
//     (游客态常空 → 相关兜底:详情首标签的标签视频,再兜底标题搜索);
//     排序 sortType:1=最多观看 2=最新发布 3=最多喜欢(片库 orderBy:new/playNum/love);
//   · 播放链(游客态即全片——金币片亦然,与 bf 同防线形同虚设):清单
//     GET /api/app/vid/h5/m3u8/{sourceURL}?token=&c=(本站已免 UA 硬判,保留
//     okhttp UA 求同构);切片为清单内绝对 URL(ACAO:* + Range 全开,浏览器
//     hls.js 直连,服务器不过流量);KEY 行 URI=/api/app/vid/sec 相对网关根,
//     免鉴权且 ACAO:*,但【无 IV 属性而站方固定 IV=0】→ playlist 方法重写
//     KEY 行:URI 绝对化 + 显式 IV=0,密文切片 hls.js 原生 AES-128 解密;
//   · 封面:相对路径 v3/image/…,基座 = 注册表 /ping/domain/h5 的 IMAGE 域(轮换,
//     10 分钟缓存 + 硬编码兜底);与 bf 同款混淆:octet-stream 密文,文件头
//     100B 以 imgKey(2019ysapp7527)循环 XOR → 一律经 /api/img/91pron 服务端
//     解密输出明文(仅放行 IMAGE 域防开放代理);
//
// 基址策略:环境变量 P91_BASE 有值 → 单网关直连;否则内置候选并行 ping 取活者
// (优先级序),结果缓存 10 分钟。
// ============================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SitePlugin } from './base.js';

const UA_OKHTTP = 'okhttp/3.12.0';               // 与站方 App 一致的非浏览器 UA(本站清单端点已免硬判,保留求同构)
const DEFAULT_LINES = [                          // API 网关候选(主 bundle JSON.parse 明文 + 实测存活;轮换后 P91_BASE 指定)
  'https://gx5q5.com',
  'https://d122lhoqt6shfh.cloudfront.net',
  'https://d2dyiyxr71jnmg.cloudfront.net',
];
const IMG_FALLBACK = 'https://zzzznnn.lkkwip.cn';   // 封面基座兜底(注册表 IMAGE 域轮换)
const IMG_KEY = '2019ysapp7527';                    // 封面混淆钥(与 bf 同款:文件头 100B 循环 XOR)
const PARAM_KEY = 'BxJand%xf5h3sycH';               // 请求 AES-128-CBC key=iv 常量
const IFACES = ['65dc07d1b7915c6b2937432b091837a7', '0a958fb9ac062420af6ba5f4caad779f']; // interfaceKey 候选(新→旧)
const BASES_TTL = 10 * 60 * 1000;                // 网关/片库配置/封面基座缓存 10 分钟
const PLAY_CACHE_MAX = 40;                       // 播放清单文本缓存上限
const PLAY_TTL = 5 * 60 * 1000;                  // 清单新鲜期(切片 ?md= 时间戳签名,保守 5 分钟)
const TIMEOUT_MS = 15000;
// 长视频面的可播 canvas(SP影片/SHORT抖音/video动漫;image漫画/PIC图集/COVER帖子非视频不入)
const VIDEO_CANVASES = ['SP', 'SHORT', 'video'];
// 前端三档排序键 → 上游 sortType(搜索/标签面;1=最多观看 2=最新发布 3=最多喜欢)
const SORT_TYPE = { post_date: 2, video_viewed: 1, most_popular: 3 };
// 前端三档排序键 → 片库 orderBy 键(new/playNum/love)
const SORT_ORDER = { post_date: 'new', video_viewed: 'playNum', most_popular: 'love' };
// 片库配置兜底(/vid/library 不可用时按当前线上形状降级,筛选面仍可用)
const LIB_FALLBACK = {
  canvas: [{ key: 'SP', name: '影片' }, { key: 'SHORT', name: '抖音' }, { key: 'video', name: '动漫' }],
  orderBy: [{ key: 'new', name: '最新上架' }, { key: 'playNum', name: '最多观看' }, { key: 'love', name: '最多收藏' }],
  paymentType: [{ key: '', name: '全部' }],
  timeType: [],
};

// ============ 会话(与 CLI 工具共享缓存文件:稳定 devID + token 复用,防 4007) ============

const AZ = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const newDevId = () => Array.from({ length: 16 }, () => AZ[Math.floor(Math.random() * 62)]).join('') + Date.now();
const xua = (devID) => 'BuildID=com.abc.Butterfly;SysType=ios;DevID=' + devID + ';Ver=1.0.0;DevType=iPhone;DeviceBrand=APPLE;DeviceModel=iPhone;SystemName=ios;SystemVersion=17.5;Terminal=1;IsH5=1;Sid=';

// 会话缓存文件(与 ../Nodejs/91porn_api.js 同一份):登录端点全局限频 4007,
// 固化 devID + 复用 token 后,插件与 CLI 双端合计只登一次
const SESSION_FILE = path.join(os.tmpdir(), '91porn_api_session.json');
function readSessionFile() {
  try {
    const j = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (j && j.devID) return j;
  } catch (e) { /* 无文件/损坏都按无缓存处理 */ }
  return null;
}
function writeSessionFile() {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify({ devID: S.devID, token: S.token, uid: S.uid, ts: Date.now() })); } catch (e) { /* 写失败不影响主流程 */ }
}

const _seed = readSessionFile();
const S = { base: '', at: 0, token: (_seed && _seed.token) || '', uid: (_seed && _seed.uid) || '', devID: (_seed && _seed.devID) || newDevId() };   // 网关 + 游客会话(模块级)

// 网关 ping:/api/app/ping/check 返回 {code:200} 即活
async function ping(base) {
  try {
    const r = await fetch(base.replace(/\/+$/, '') + '/api/app/ping/check', { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': UA_OKHTTP } });
    return (await r.json()).code === 200;
  } catch (e) { return false; }
}

// 当前网关(env 直连优先;候选并行 ping 按优先级取活者,缓存 10 分钟)
async function resolveBase() {
  if (process.env.P91_BASE) return String(process.env.P91_BASE).replace(/\/+$/, '');
  if (S.base && Date.now() - S.at < BASES_TTL) return S.base;
  const alive = await Promise.all(DEFAULT_LINES.map(ping));
  for (let i = 0; i < DEFAULT_LINES.length; i++) {
    if (alive[i]) { S.base = DEFAULT_LINES[i]; S.at = Date.now(); return S.base; }
  }
  throw new Error('91pron 网关候选全部不可达(可设置环境变量 P91_BASE 手动指定)');
}

// 游客登录 → token(模块级缓存;单飞:并发首拉只登一次——同 devID 重复登录会作废
// 旧 token 互相踩出 5009;成功后回写共享缓存文件)
let loginInFlight = null;
async function ensureToken(force) {
  if (S.token && !force) return S.token;
  if (!loginInFlight) {
    loginInFlight = (async () => {
      const d = await call('POST', '/mine/login/h5', { body: { devID: S.devID, sysType: 'ios', cutInfos: '{}', isAppStore: false }, noAuth: true });
      S.token = d.token; S.uid = d.uid;
      writeSessionFile();
      return S.token;
    })().finally(() => { loginInFlight = null; });
  }
  return loginInFlight;
}

// 响应解密(interfaceKey 候选制轮换容错,新→旧逐把试解)
function decResp(b64) {
  let lastErr;
  for (const iface of IFACES) {
    try {
      const t = Buffer.from(String(b64).replace(/\n/g, ''), 'base64');
      const r = Buffer.concat([Buffer.from(iface, 'utf8'), t.subarray(0, 12)]);
      const o = parseInt(String(r.length / 2));
      const s = crypto.createHash('sha256').update(r).digest().subarray(8, 24);
      const u = crypto.createHash('sha256').update(Buffer.concat([s, r.subarray(0, o)])).digest();
      const h = crypto.createHash('sha256').update(Buffer.concat([r.subarray(o), s])).digest();
      const key = Buffer.concat([u.subarray(0, 8), h.subarray(8, 24), u.subarray(24)]);
      const iv = Buffer.concat([h.subarray(0, 4), u.subarray(12, 20), h.subarray(28)]);
      const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
      return JSON.parse(Buffer.concat([d.update(t.subarray(12)), d.final()]).toString('utf8'));
    } catch (e) { lastErr = e; }
  }
  throw new Error('91pron 响应解密失败(interfaceKey 候选全不匹配,站点可能又轮换):' + (lastErr && lastErr.message || ''));
}

// 统一调用:GET 参数 ?data= 密文 / POST {"data":…} 体;进入即确保游客 token,
// 登录态失效(5009)自动重登一次原参重放
async function call(method, path, { params, body, noAuth } = {}) {
  if (!noAuth) await ensureToken();
  const base = await resolveBase();
  let url = base + '/api/app' + path;
  const headers = { 'Content-Type': 'application/json', 'temp': 'test', 'X-User-Agent': xua(S.devID), 'User-Agent': UA_OKHTTP };
  if (!noAuth && S.token) headers.Authorization = S.token;
  const encBody = (obj) => {
    const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(PARAM_KEY, 'latin1'), Buffer.from(PARAM_KEY, 'latin1'));
    return Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]).toString('base64');
  };
  if (method === 'GET' && params) url += '?data=' + encodeURIComponent(encBody(params));
  const opts = { method, headers, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (method === 'POST') opts.body = JSON.stringify({ data: encBody(body || {}) });
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => { throw new Error('91pron 接口 HTTP ' + r.status + ' 非 JSON @' + path); });
  if (j.code === 200) {
    if (j.hash && typeof j.data === 'string') j.data = decResp(j.data);
    return j.data;
  }
  if (j.code === 5009 && !noAuth && headers.Authorization) {   // 登录态失效:并发下他请求可能已换新 token
    if (S.token && S.token !== headers.Authorization) return call(method, path, { params, body });
    S.token = '';
    await ensureToken(true);   // 单飞:并发 5009 也只重登一次
    return call(method, path, { params, body });
  }
  throw new Error('91pron 接口 code=' + j.code + ' ' + (j.msg || '') + ' @' + path);
}

// ============ 片库配置(/vid/library 选项对象表,keyword 组包依赖) ============

let libCache = { at: 0, conf: null };

async function libConfig() {
  if (libCache.conf && Date.now() - libCache.at < BASES_TTL) return libCache.conf;
  try {
    const d = await call('GET', '/vid/library');
    if (d && Array.isArray(d.canvas) && d.canvas.length) {
      libCache = { at: Date.now(), conf: d };
      return d;
    }
  } catch (e) { /* 落入兜底 */ }
  if (!libCache.conf) libCache = { at: Date.now(), conf: LIB_FALLBACK };
  return libCache.conf;
}

// 片库筛选搜索:canvas(category)/orderBy(sort)入 keyword 的完整选项对象;
// timeType 空 key 对象 = 不限时间(全量);动漫/漫画类结果在 allMediaList
async function librarySearch({ canvas, orderBy, tag, page, size }) {
  const lib = await libConfig();
  const cv = (lib.canvas || []).find((c) => c.key === canvas) || (lib.canvas || [])[0];
  if (!cv) throw new Error('91pron 片库配置无 canvas');
  const ob = (lib.orderBy || []).find((o) => o.key === orderBy) || (lib.orderBy || [])[0];
  const tg = tag || { id: '', name: '全部类型' };   // 24hex 标签对象由调用方(tag/vid 面优先,片库标签不混用)
  const pays = (lib.paymentType || [])[0] || { key: '', name: '全部' };
  const d = await call('POST', '/vid/library/search', {
    body: {
      keyword: { canvas: cv, orderBy: ob, tags: tg, paymentType: pays, timeType: { key: '', name: '' } },
      pageNumber: page, pageSize: size,
    },
  });
  return d;
}

// ============ 封面基座(注册表 IMAGE 域,轮换自适应)与解密代理出口 ============

let imgBaseCache = { urls: [], at: 0 };

async function imageBases() {
  if (imgBaseCache.urls.length && Date.now() - imgBaseCache.at < BASES_TTL) return imgBaseCache.urls;
  try {
    const reg = await call('GET', '/ping/domain/h5');
    const urls = ((reg && reg.sourceList) || []).filter((x) => x && x.type === 'IMAGE')
      .flatMap((x) => x.domain || []).map((d) => d && d.url).filter(Boolean).map((u) => u.replace(/\/+$/, ''));
    if (urls.length) { imgBaseCache = { urls, at: Date.now() }; return urls; }
  } catch (e) { /* 落入兜底 */ }
  return [IMG_FALLBACK];
}
const imageBase = async () => (await imageBases())[0];
// 封面是密文(文件头 100B XOR 混淆的 octet-stream),<img> 直载必挂 → 一律走
// /api/img/91pron 服务端解密,前端拿到的恒为明文图片地址
const imgProxy = (u) => (u ? '/api/img/91pron?u=' + encodeURIComponent(u) : '');
const imgAbs = async (p) => {
  if (!p) return '';
  const abs = /^https?:\/\//.test(p) ? String(p) : (await imageBase()) + '/' + String(p).replace(/^\/+/, '');
  return imgProxy(abs);
};

// ============ 归一化(上游字段 → 前端契约,白名单构造,社交付费字段一律不带) ============

function normItem(v) {
  if (!v || !v.id) return null;
  return { id: String(v.id), title: String(v.title || ''), cover: '', duration: Number(v.playTime) > 0 ? Math.round(Number(v.playTime)) : null, hd: false, coverPending: v.cover || '' };
}
// normItem 的 cover 需异步解析基座:批量补全(一次 imageBase 调用,临时字段随即删除);
// 容错 list / allVideoInfo / allMediaList(片库动漫漫画面)三种上游形态
async function normList(x) {
  const arr = Array.isArray(x) ? x : (x && Array.isArray(x.list) ? x.list : (x && Array.isArray(x.allVideoInfo) ? x.allVideoInfo : (x && Array.isArray(x.allMediaList) ? x.allMediaList : [])));
  const items = arr.map(normItem).filter(Boolean);
  const base = await imageBase();
  for (const it of items) {
    it.cover = imgProxy(it.coverPending && !/^https?:\/\//.test(it.coverPending) ? base + '/' + it.coverPending.replace(/^\/+/, '') : it.coverPending);
    delete it.coverPending;
  }
  return { items, page: 1, hasMore: !!(x && x.hasNext) };
}

// ============ 播放清单(vid → m3u8 文本,KEY 绝对化 + 显式 IV=0,LRU 缓存) ============

const playCache = new Map(); // id → {text, at}

// 清单重写:KEY 行 URI 绝对化(本站 /vid/sec 相对网关根,免鉴权 ACAO:*)+ 显式
// IV=0(站方固定零 IV,缺省会按媒体序号解出垃圾);切片本就是绝对 URL(ACAO:*),
// 原样保留;重写产物 hls.js 浏览器直连可播
function rewriteM3u8(text, m3u8Url) {
  return text.split('\n').map((l) => {
    if (l.indexOf('#EXT-X-KEY') === 0) {
      const ku = (l.match(/URI="([^"]+)"/) || [])[1];
      if (!ku) return l;
      return '#EXT-X-KEY:METHOD=AES-128,URI="' + new URL(ku, m3u8Url).href + '",IV=0x00000000000000000000000000000000';
    }
    return l;
  }).join('\n');
}

// 详情原始数据(sourceURL 为播放清单原料)
async function fetchDetailRaw(vid) {
  const d = await call('GET', '/vid/info', { params: { videoID: String(vid) } });
  if (!d || !d.id) throw new Error('91pron detail 无数据 id=' + vid);
  return d;
}

// ============ 插件类 ============

export class P91Plugin extends SitePlugin {
  get id() { return '91pron'; }
  get name() { return '91pron'; }
  // 片库 canvas=分类(影片/抖音/动漫);标签表 + bytag 标签视频;热词榜;排序三档;
  // 无专辑概念;播放走 /api/91pron/playlist 服务端代理清单(切片/密钥浏览器直连)
  get capabilities() { return { home: true, hotwords: true, tags: true, dvds: false, bytag: true, sort: true }; }

  async home() {
    const d = await call('GET', '/vid/list', { params: { pageNumber: 1, pageSize: 24 } });   // 站方推荐流
    const lib = await libConfig();
    const nav = (lib.canvas || []).filter((c) => VIDEO_CANVASES.includes(c.key)).map((c) => ({ id: String(c.key), title: String(c.name || '') }));
    return { notice: '', nav, list: await normList(d) };
  }

  // 分类浏览 = 片库筛选(canvas=分类,orderBy=排序,不限时间取全量)
  async list(o = {}) {
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 24);
    const canvas = o.category && VIDEO_CANVASES.includes(String(o.category)) ? String(o.category) : 'SP';
    const d = await librarySearch({ canvas, orderBy: SORT_ORDER[o.sort] || 'new', page, size });
    const out = await normList(d);
    out.page = page;
    return out;
  }

  async search(kw, o = {}) {
    const k = String(kw || '').trim();
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 24);
    if (!k) return { items: [], page: 1, hasMore: false };
    const d = await call('POST', '/search/list', { body: { keyWords: [k], pageNumber: page, pageSize: size, realm: 'SP', sortType: SORT_TYPE[o.sort] || 2 } });
    const out = await normList(d);
    out.page = page;
    return out;
  }

  // 分类 = 片库可播 canvas(影片/抖音/动漫;站方无计数端点,count 给 0)
  async categories() {
    const lib = await libConfig();
    return (lib.canvas || []).filter((c) => VIDEO_CANVASES.includes(c.key)).map((c) => ({ id: String(c.key), name: String(c.name || ''), count: 0 }));
  }

  async tags() {
    const d = await call('GET', '/tag/conf/list');
    return ((d && d.tags) || []).map((t) => ({ id: String(t.id), name: String(t.tagName || ''), count: 0 }));
  }

  async bytag(tag, o = {}) {
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 24);
    if (!tag) throw new Error('91pron bytag 缺少标签 id');
    const d = await call('GET', '/tag/vid/list', { params: { tagID: String(tag), pageNumber: page, pageSize: size, sortType: SORT_TYPE[o.sort] || 2 } });
    const out = await normList(d);
    out.page = page;
    return out;
  }

  async hotwords() {
    const d = await call('GET', '/search/hotTag', { params: { pageNumber: 1, pageSize: 20 } });
    return ((d && d.list) || []).map((h) => String(h.name || '')).filter(Boolean);
  }

  async detail(id) {
    if (!id) throw new Error('91pron detail 缺少视频 id');
    const d = await fetchDetailRaw(id);
    // 白名单构造:coins/freeTime/播放数等社交付费字段按产品定位一律不带出
    return {
      id: String(d.id),
      title: String(d.title || ''),
      cover: await imgAbs(d.cover),
      duration: Number(d.playTime) > 0 ? Math.round(Number(d.playTime)) : null,
      hd: false,
      resolution: String(d.resolution || ''),
      uploadDate: String(d.createdAt || '').slice(0, 19),
      tags: (Array.isArray(d.tags) ? d.tags : []).map((t) => ({ id: t && t.id ? String(t.id) : null, name: String((t && (t.tagName || t.name)) || t || '') })).filter((t) => t.name),
      categories: [],
    };
  }

  // 相关推荐:站方 /vid/recommend/list 游客态常态为空 → 兜底详情首标签的标签视频
  // (排除自己),再兜底标题前 8 字搜索;两级兜底保证观看页「猜你喜欢」不空栏
  async related(id, o = {}) {
    if (!id) throw new Error('91pron related 缺少视频 id');
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 8);
    let out = null;
    try {
      const d = await call('GET', '/vid/recommend/list', { params: { vid: String(id), pageNumber: page, pageSize: size } });
      out = await normList(d);
    } catch (e) { /* 站方相关面异常不致命,走兜底 */ }
    if (out && out.items.length) { out.page = page; return out; }
    try {
      const det = await fetchDetailRaw(id);
      const t0 = (Array.isArray(det.tags) && det.tags[0]) || null;
      if (t0 && t0.id) {
        const d = await call('GET', '/tag/vid/list', { params: { tagID: String(t0.id), pageNumber: page, pageSize: size + 1, sortType: 2 } });
        const r = await normList(d);
        r.items = r.items.filter((it) => it.id !== String(id)).slice(0, size);
        if (r.items.length) { r.page = page; return r; }
      }
      if (det.title) {
        const d = await call('POST', '/search/list', { body: { keyWords: [String(det.title).slice(0, 8)], pageNumber: page, pageSize: size + 1, realm: 'SP', sortType: 2 } });
        const r = await normList(d);
        r.items = r.items.filter((it) => it.id !== String(id)).slice(0, size);
        r.page = page;
        return r;
      }
    } catch (e) { /* 兜底链异常按空结果返回 */ }
    return { items: [], page, hasMore: false };
  }

  // 封面静态图能力:供 /api/img/91pron 调用——密文 octet-stream 解头 100B(以
  // imgKey 循环 XOR,与 bf 同款);仅放行注册表 IMAGE 域(轮换自适应 + 兜底域,
  // 防开放代理);头字节已是明文图片魔数的原样放行(混杂形态容错)
  async image(u) {
    if (!/^https?:\/\//.test(u || '')) throw new Error('91pron 图片代理需要合法 http(s) 地址');
    let host = '';
    try { host = new URL(u).hostname; } catch (e) { throw new Error('91pron 图片代理地址畸形'); }
    const allow = new Set((await imageBases()).concat([IMG_FALLBACK]).map((b) => { try { return new URL(b).hostname; } catch (e) { return ''; } }));
    if (!allow.has(host)) throw new Error('91pron 图片代理拒绝非 IMAGE 域地址');
    const r = await fetch(u, {
      cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': UA_OKHTTP, 'Accept': 'image/*,*/*;q=0.8' },
    });
    if (!r.ok) throw new Error('图片 HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    const plainMagic = buf.length > 4 && (buf[0] === 0xff || buf[0] === 0x89 || (buf[0] === 0x47 && buf[1] === 0x49) || (buf[0] === 0x52 && buf[1] === 0x49));
    if (!plainMagic && buf.length) {
      const key = Buffer.from(IMG_KEY, 'utf8');
      for (let i = 0; i < 100 && i < buf.length; i++) buf[i] ^= key[i % key.length];
    }
    return buf;
  }

  // 播放解析:清单走 /api/91pron/playlist 服务端代理文本(本站已免 UA 硬判,
  // 代理为 CORS 兜底 + 统一 KEY 重写);重写后 KEY(ACAO:*)与切片(ACAO:*)
  // 均浏览器 hls.js 直连,服务器不过流量
  async resolvePlay(id) {
    if (!id) throw new Error('91pron resolvePlay 缺少视频 id');
    const d = await fetchDetailRaw(id);
    if (!d.sourceURL) throw new Error('91pron 视频 ' + id + ' 无播放地址(可能已下架)');
    return { type: 'hls', url: '/api/91pron/playlist?id=' + encodeURIComponent(String(id)), via: 'm3u8' };
  }

  // 播放清单文本代理:LRU 缓存(5 分钟新鲜期,切片 ?md= 签名分钟级时效)
  async playlist(id) {
    if (!id) throw new Error('91pron playlist 缺少视频 id');
    const hit = playCache.get(String(id));
    if (hit && Date.now() - hit.at < PLAY_TTL) return hit.text;
    const d = await fetchDetailRaw(id);
    if (!d.sourceURL) throw new Error('91pron 视频 ' + id + ' 无播放地址(可能已下架)');
    await ensureToken();
    const base = await resolveBase();
    const m3u8Url = base + '/api/app/vid/h5/m3u8/' + d.sourceURL + '?token=' + encodeURIComponent(S.token) + '&c=';
    const r = await fetch(m3u8Url, {
      cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': UA_OKHTTP, 'X-User-Agent': xua(S.devID), 'temp': 'test' },
    });
    const text = await r.text();
    if (!text.startsWith('#EXTM3U')) throw new Error('91pron 清单被拦(HTTP ' + r.status + ' ' + text.slice(0, 40) + ')');
    const out = rewriteM3u8(text, m3u8Url);
    playCache.set(String(id), { text: out, at: Date.now() });
    if (playCache.size > PLAY_CACHE_MAX) {
      let oldestKey = null, oldestAt = Infinity;
      for (const [k, ent] of playCache) if (ent.at < oldestAt) { oldestAt = ent.at; oldestKey = k; }
      if (oldestKey !== null) playCache.delete(oldestKey);
    }
    return out;
  }
}
