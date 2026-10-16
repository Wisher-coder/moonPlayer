// ============================================================
// bf.js —— bf(Butterfly H5,cloudfront 轮换域站群)站点插件(仅 Node 服务端运行)
//
// 逆向结论(2026-10-06 授权测试环境实测,移植自 CLI 取证版 ../Nodejs/bf_api.js):
//   · 站点为 Vue3 SPA(网页入口 /home 空壳),数据面全部走独立 API 网关(cloudfront/
//     自建域轮换,候选明文写在主 bundle 的 JSON.parse('[…]') 里);本插件直连网关,
//     不依赖网页入口存活(运营方已转 APP 分发,网页入口不公开发布——见 bf_api.js 头注);
//   · 协议「Butterfly」双层 AES:请求参数 JSON → AES-128-CBC(key=iv=常量
//     BxJand%xf5h3sycH)→ base64 → GET ?data= / POST {"data":…};
//     响应 code==200 且 hash==true 时 data 密文 = interfaceKey 常量+密文头 12B 播种
//     → SHA256 链派生 AES-256-CBC key/iv;interfaceKey 随前端版本轮换 → 候选制试解;
//     头 X-User-Agent 设备串标识 H5 终端,User-Agent 须 okhttp 系(清单端点硬判);
//   · 登录态:游客 POST /mine/login/h5 {devID,sysType:'ios',cutInfos:'{}',isAppStore:false}
//     → {token,uid},Authorization 携带;失效(code 5009)自动重登重放;
//   · 发现面:首页模块 GET /modules/list → homePage[{id,moduleName,haiJiaoStyle.sortList}];
//     模块视频 GET /vid/module/{id} {pageNumber,pageSize,moduleSort} → {allVideoInfo,hasNext};
//     ⚠ 模块 sort 数据面损坏(2026-10-06 实测):sortList 自报档位含 4/6/7/8 未定义档,
//     且 sort=2(最新发布)索引坏——「最新」模块整响应为空、「推荐」模块仅 29 条策展小池
//     (首页「只有一页」即此),其余模块 sort=2 深度也普遍劣于 sortList 首档;站方 App 模块
//     实际用 sortList 首档 → 模块 feed 第 1 页空时退回首档重试一次(moduleFeed);
//     搜索 POST /search/list {keyWords:[词],realm:'SP',sortType} → {list,hasNext};
//     标签视频 GET /tag/vid/list {tagID,…}(键名是 tagID);标签表 GET /tag/conf/list;
//     热词 GET /search/hotTag → {list[{id,name,hot}]};详情 GET /vid/info {videoID};
//     相关 GET /vid/recommend/list {vid,…}(键名是 vid 不是 videoID);
//     分类两级(2026-10-06 补逆向,主 bundle getSectionList 页面互证):父=首页模块;
//     子=模块视频响应的 allSection[{sectionID,sectionName,sectionCover,hot,sort,…}]
//     (各模块 0~52 个不等;bundle 里另有 /section/allList、/section/details 两端点
//     线上网关 404 未部署,H5 实际就用 allSection 这条路);子分类取片
//     GET /vid/section/{sectionID} {pageNumber,pageSize,sortType} → {videos,hasNext}
//     (条目结构与模块视频同构;sortType 三档同全局);
//     排序 sortType:1=最多观看 2=最新发布 3=最多喜欢;
//   · 播放链(游客态即全片,站方付费墙按 UA/X-UA 判定、对 okhttp UA 失效——pnk3n
//     工具既有结论):清单 GET /api/app/vid/h5/m3u8/{sourceURL}?token=&c= 须 okhttp UA;
//     切片为清单内绝对 URL(注册表 VID 域 + ?md= 时间戳签名,ACAO:* + Range 全开,
//     浏览器 hls.js 直连,服务器不过流量);KEY 行 URI=/api/app/vid/m3u8sec 免鉴权且
//     ACAO:*,但【无 IV 属性而站方固定 IV=0】(HLS 规范缺省按媒体序号解会出垃圾)——
//     playlist 方法重写 KEY 行:URI 绝对化 + 显式 IV=0,密文切片 hls.js 原生 AES-128
//     解密(无填充 CBC,本地实解首段 0x47@0/188/376 已验证);
//   · 封面:相对路径 v3/image/…,基座 = 注册表 /ping/domain/h5 的 IMAGE 域(轮换,
//     10 分钟缓存 + 硬编码兜底);2026-10 站方启用图片混淆:响应为 ACAO:* 的
//     octet-stream 密文,文件头 100B 以 imgKey 循环 XOR(其余明文)——密钥写在主
//     bundle 的 t(my,"imgKey","2019ysapp7527") 里,站方图片组件 imgDecypt 同款解法
//     (XHR arraybuffer → XOR → blob),<img> 直链已不可载 → 封面一律经 /api/img/bf
//     服务端解密输出明文;
//
// 基址策略:环境变量 BF_BASE 有值 → 单网关直连;否则内置候选并行 ping 取活者
// (优先级序),结果缓存 10 分钟。业务错(code!==200)直接抛,网络错换线无意义场景少,
// 统一走候选重试一次。
// ============================================================
import crypto from 'node:crypto';
import { SitePlugin } from './base.js';

const UA_OKHTTP = 'okhttp/3.12.0';               // 与站方 App 一致的非浏览器 UA(清单端点硬依赖)
const DEFAULT_LINES = [                          // API 网关候选(主 bundle 明文 + 实测存活;轮换后 BF_BASE 指定)
  'https://d1w3p997s8acw6.cloudfront.net',
  'https://d2m0k739byzwun.cloudfront.net',
  'https://lidhgjxsh3kc.com',
];
const IMG_FALLBACK = 'https://zzzznnn.lkkwip.cn';   // 封面基座兜底(注册表 IMAGE 域轮换)
const IMG_KEY = '2019ysapp7527';                    // 封面混淆钥(主 bundle imgKey:文件头 100B 循环 XOR)
const PARAM_KEY = 'BxJand%xf5h3sycH';               // 请求 AES-128-CBC key=iv 常量
const IFACES = ['65dc07d1b7915c6b2937432b091837a7', '0a958fb9ac062420af6ba5f4caad779f']; // interfaceKey 候选(新→旧)
const BASES_TTL = 10 * 60 * 1000;                // 网关/模块/封面基座缓存 10 分钟
const PLAY_CACHE_MAX = 40;                       // 播放清单文本缓存上限
const PLAY_TTL = 5 * 60 * 1000;                  // 清单新鲜期(切片 ?md= 时间戳签名,保守 5 分钟)
const TIMEOUT_MS = 15000;
// 前端三档排序键 → 上游 sortType(1=最多观看 2=最新发布 3=最多喜欢)
const SORT_TYPE = { post_date: 2, video_viewed: 1, most_popular: 3 };

// ============ 会话(网关优选 + 游客登录 + 协议收发) ============

const AZ = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const newDevId = () => Array.from({ length: 16 }, () => AZ[Math.floor(Math.random() * 62)]).join('') + Date.now();
const xua = (devID) => 'BuildID=com.abc.Butterfly;SysType=ios;DevID=' + devID + ';Ver=1.0.0;DevType=iPhone;DeviceBrand=APPLE;DeviceModel=iPhone;SystemName=ios;SystemVersion=17.5;Terminal=1;IsH5=1;Sid=';

const S = { base: '', at: 0, token: '', uid: '', devID: newDevId() };   // 网关 + 游客会话(模块级)

// 网关 ping:/api/app/ping/check 返回 {code:200} 即活
async function ping(base) {
  try {
    const r = await fetch(base.replace(/\/+$/, '') + '/api/app/ping/check', { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': UA_OKHTTP } });
    return (await r.json()).code === 200;
  } catch (e) { return false; }
}

// 当前网关(env 直连优先;候选并行 ping 按优先级取活者,缓存 10 分钟)
async function resolveBase() {
  if (process.env.BF_BASE) return String(process.env.BF_BASE).replace(/\/+$/, '');
  if (S.base && Date.now() - S.at < BASES_TTL) return S.base;
  const alive = await Promise.all(DEFAULT_LINES.map(ping));
  for (let i = 0; i < DEFAULT_LINES.length; i++) {
    if (alive[i]) { S.base = DEFAULT_LINES[i]; S.at = Date.now(); return S.base; }
  }
  throw new Error('bf 网关候选全部不可达(可设置环境变量 BF_BASE 手动指定)');
}

// 游客登录 → token(模块级缓存;单飞:页面 detail/related/play 并发首拉时只登一次
// ——同 devID 重复登录会作废旧 token,并发各登各的必然互相踩出 5009)
let loginInFlight = null;
async function ensureToken(force) {
  if (S.token && !force) return S.token;
  if (!loginInFlight) {
    loginInFlight = (async () => {
      const d = await call('POST', '/mine/login/h5', { body: { devID: S.devID, sysType: 'ios', cutInfos: '{}', isAppStore: false }, noAuth: true });
      S.token = d.token; S.uid = d.uid;
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
  throw new Error('bf 响应解密失败(interfaceKey 候选全不匹配,站点可能又轮换):' + (lastErr && lastErr.message || ''));
}

// 统一调用:GET 参数 ?data= 密文 / POST {"data":…} 体;进入即确保游客 token
// (5005 no token 防线),登录态失效(5009)自动重登一次原参重放
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
  const j = await r.json().catch(() => { throw new Error('bf 接口 HTTP ' + r.status + ' 非 JSON @' + path); });
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
  throw new Error('bf 接口 code=' + j.code + ' ' + (j.msg || '') + ' @' + path);
}

// ============ 封面基座(注册表 IMAGE 域,轮换自适应)与解密代理出口 ============

let imgBaseCache = { urls: [], at: 0 };

// IMAGE 域全量(注册表可能配多台;首个作基座拼相对路径,全部并入代理放行名单)
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
// /api/img/bf 服务端解密,前端拿到的恒为明文图片地址(同站方 imgDecypt→blob 等价)
const imgProxy = (u) => (u ? '/api/img/bf?u=' + encodeURIComponent(u) : '');
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
// normItem 的 cover 需异步解析基座:批量补全(一次 imageBase 调用,临时字段随即删除)
// 上游列表键三态:搜索=list / 模块=allVideoInfo / 板块(/vid/section/)=videos
async function normList(x) {
  const arr = Array.isArray(x) ? x : (x && Array.isArray(x.list) ? x.list : (x && Array.isArray(x.allVideoInfo) ? x.allVideoInfo : (x && Array.isArray(x.videos) ? x.videos : [])));
  const items = arr.map(normItem).filter(Boolean);
  const base = await imageBase();
  for (const it of items) {
    it.cover = imgProxy(it.coverPending && !/^https?:\/\//.test(it.coverPending) ? base + '/' + it.coverPending.replace(/^\/+/, '') : it.coverPending);
    delete it.coverPending;
  }
  return { items, page: 1, hasMore: !!(x && x.hasNext) };
}

// ============ 模块 + 板块(分类树)缓存 ============
// 分类两级:父 = 首页模块(/modules/list),子 = 模块视频响应里的 allSection
// (sectionID/sectionName/…;「最新」等模块无板块为空);子分类取片走
// GET /vid/section/{sectionID} {pageNumber,pageSize,sortType} → {videos,hasNext}。
// 树整体缓存 10 分钟;子分类对每个模块并行拉一页(pageSize=1 只为 allSection),
// 单模块失败不拖垮整棵树(children 缺席即可)。各模块 sortList 首档(站方 App 的
// 模块默认档)一并缓存:板块探测与 moduleFeed 空页回退都用它——sort=2 索引损坏的
// 模块(「最新」整响应为空)连 allSection 都不带,板块探测硬编码 2 会丢板块。

let modsCache = { at: 0, homePage: [], sectionsByModule: new Map(), sectionsFlat: new Map(), sortDefault: new Map() };

// 模块自报默认档 = haiJiaoStyle.sortList 首个正整数;缺失兜底 2(最新发布)
const moduleDefaultSort = (m) => {
  const l = m && m.haiJiaoStyle && Array.isArray(m.haiJiaoStyle.sortList) ? m.haiJiaoStyle.sortList : [];
  return Number(l.find((x) => Number.isFinite(Number(x)) && Number(x) > 0)) || 2;
};

// 全库 feed 模块:优先「最新」(站方全量库,千条级深翻页);首页首模块「推荐」是
// 29 条策展小池(其 sort=2 档),不宜作首页/无分类列表的缺省流;名字轮换退回首模块
const feedModule = (mods) => mods.find((m) => String(m.moduleName || '') === '最新') || mods[0];

// 模块 feed:按请求档直取;响应空且与模块默认档不同 → 退回默认档重试一次,并在
// 拿到内容后粘性记住(「模块×档位 → 生效档」)——sort=2 索引损坏是整条分页全空而非
// 仅首页,后续页必须直取默认档才能接上同一序流,否则前端第 2 页拿到空即误判到底
// (站方 App 模块本就用默认档,展示语义一致)。模块数×3 档封顶,无需淘汰。
const moduleSortFix = new Map();

async function moduleFeed(moduleId, page, size, sortType) {
  const key = moduleId + ':' + sortType;
  const def = modsCache.sortDefault.get(String(moduleId));
  const fetchMod = (s) => call('GET', '/vid/module/' + moduleId, { params: { pageNumber: page, pageSize: size, moduleSort: s } });
  const isEmpty = (d) => !(d && Array.isArray(d.allVideoInfo) && d.allVideoInfo.length);
  const fixed = moduleSortFix.get(key);
  if (fixed) return fetchMod(fixed);
  const d = await fetchMod(sortType);
  if (isEmpty(d) && def && def !== sortType) {
    const alt = await fetchMod(def);
    if (!isEmpty(alt)) moduleSortFix.set(key, def);   // 粘性:后续页免一次注定为空的直取
    return alt;
  }
  return d;
}

async function homeModules() {
  if (modsCache.homePage.length && Date.now() - modsCache.at < BASES_TTL) return modsCache.homePage;
  const d = await call('GET', '/modules/list');
  const homePage = (d && Array.isArray(d.homePage)) ? d.homePage : [];
  // 并行补全各模块的板块(子分类);列表页码 1 只要 allSection,payload 最小化
  const byMod = new Map();
  const flat = new Map();
  const sortDefault = new Map();
  for (const m of homePage) sortDefault.set(String(m.id), moduleDefaultSort(m));
  await Promise.all(homePage.map(async (m) => {
    try {
      const v = await call('GET', '/vid/module/' + m.id, { params: { pageNumber: 1, pageSize: 1, moduleSort: sortDefault.get(String(m.id)) } });
      const secs = (v && Array.isArray(v.allSection)) ? v.allSection : [];
      if (secs.length) byMod.set(String(m.id), secs);
      for (const s of secs) {
        if (s && s.sectionID) flat.set(String(s.sectionID), { id: String(s.sectionID), name: String(s.sectionName || ''), moduleId: String(m.id) });
      }
    } catch (e) { /* 单模块板块失败:该模块无 children,不影响整树 */ }
  }));
  modsCache = { at: Date.now(), homePage, sectionsByModule: byMod, sectionsFlat: flat, sortDefault };
  return homePage;
}

// 分类树(含子分类);树未构建时先构建
async function categoryTree() {
  await homeModules();
  return modsCache;
}

// ============ 播放清单(vid → m3u8 文本,KEY 绝对化 + 显式 IV=0,LRU 缓存) ============

const playCache = new Map(); // id → {text, at}

// 清单重写:KEY 行 URI 绝对化 + 显式 IV=0(站方固定零 IV,缺省会按媒体序号解出垃圾);
// 切片本就是绝对 URL(ACAO:*),原样保留;重写产物 hls.js 浏览器直连可播
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
  if (!d || !d.id) throw new Error('bf detail 无数据 id=' + vid);
  return d;
}

// ============ 插件类 ============

export class BfPlugin extends SitePlugin {
  get id() { return 'bf'; }
  get name() { return 'Butterfly'; }
  // 模块=分类(home 聚合 + categories);标签表 + bytag 标签视频;热词榜;排序三档;
  // 无专辑概念;播放走 /api/bf/playlist 服务端代理清单(切片/密钥浏览器直连)
  get capabilities() { return { home: true, hotwords: true, tags: true, dvds: false, bytag: true, sort: true }; }

  // 启动预热(registry.warmAll 触发,fire-and-forget,不挡任何用户请求):
  // 把 bf 冷启动最重的三段——guest 登录(ensureToken)/网关优选(resolveBase,
  // 3 候选并发 ping)/类目树构建(homeModules:/modules/list + 各模块并发探测
  // 子分类)——从「首个用户请求」挪到进程启动后的后台完成。三者均为幂等的
  // 缓存预热(ensureToken 单飞、resolveBase 结果 10min 缓存、homeModules 建
  // modsCache),显式按链路顺序列出仅为可读(homeModules 内部经 call 也会顺
  // 走前两步,已有缓存直接命中);失败静默(warmAll 兜错),真实用户请求
  // 会重走完整链路并如实报错——预热只是提前,不是正确性依赖。
  async warm() {
    await ensureToken();
    await resolveBase();
    await homeModules();
  }

  async home() {
    const mods = await homeModules();
    if (!mods.length) throw new Error('bf 首页模块为空');
    // 首页缺省流 = 全库 feed 模块(「最新」);sort 仍按「最新发布」请求,moduleFeed
    // 空页自动退回模块默认档(站方 sort=2 索引损坏),翻页与 list() 缺省路径同源
    const d = await moduleFeed(String(feedModule(mods).id), 1, 24, 2);
    return { notice: '', nav: mods.map((m) => ({ id: String(m.id), title: String(m.moduleName || '') })), list: await normList(d) };
  }

  // category 同时接受父(模块 id)与子(板块 sectionID)——两者同为 24 位十六进制
  // ObjectId 无法从格式区分,一律先查分类树:命中板块表走 /vid/section/,命中模块
  // (或未知 id,向后兼容旧深链)走 /vid/module/;树由 homeModules 顺带构建并缓存。
  async list(o = {}) {
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 24);
    const tree = await categoryTree();
    if (!tree.homePage.length) throw new Error('bf 模块清单为空');
    const cat = o.category ? String(o.category) : '';
    if (cat && tree.sectionsFlat.has(cat)) {
      const d = await call('GET', '/vid/section/' + cat, { params: { pageNumber: page, pageSize: size, sortType: SORT_TYPE[o.sort] || 2 } });
      const out = await normList(d);
      out.page = page;
      return out;
    }
    const moduleId = cat || String(feedModule(tree.homePage).id);   // 缺省 = 全库 feed 模块(「最新」,与 home() 同源)
    const d = await moduleFeed(moduleId, page, size, SORT_TYPE[o.sort] || 2);
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

  // 分类 = 模块(父) + allSection 板块(子);契约可选 children 字段,无板块的模块
  // (如「最新」)不带;站方无计数端点,count 恒 0
  async categories() {
    const tree = await categoryTree();
    return tree.homePage.map((m) => {
      const out = { id: String(m.id), name: String(m.moduleName || ''), count: 0 };
      const secs = tree.sectionsByModule.get(String(m.id)) || [];
      if (secs.length) out.children = secs.map((s) => ({ id: String(s.sectionID), name: String(s.sectionName || ''), count: 0 }));
      return out;
    });
  }

  async tags() {
    const d = await call('GET', '/tag/conf/list');
    return ((d && d.tags) || []).map((t) => ({ id: String(t.id), name: String(t.tagName || ''), count: 0 }));
  }

  async bytag(tag, o = {}) {
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 24);
    if (!tag) throw new Error('bf bytag 缺少标签 id');
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
    if (!id) throw new Error('bf detail 缺少视频 id');
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

  async related(id, o = {}) {
    if (!id) throw new Error('bf related 缺少视频 id');
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 8);
    const d = await call('GET', '/vid/recommend/list', { params: { vid: String(id), pageNumber: page, pageSize: size } });
    const out = await normList(d);
    out.page = page;
    return out;
  }

  // 封面静态图能力:供 /api/img/bf 调用——密文 octet-stream 解头 100B(以 imgKey 循环
  // XOR,同站方 imgDecypt;解出的才是真图片,直链 <img> 必挂);仅放行注册表 IMAGE 域
  // (轮换自适应 + 兜底域,防开放代理);头字节已是明文图片魔数的原样放行(混杂形态容错)
  async image(u) {
    if (!/^https?:\/\//.test(u || '')) throw new Error('bf 图片代理需要合法 http(s) 地址');
    let host = '';
    try { host = new URL(u).hostname; } catch (e) { throw new Error('bf 图片代理地址畸形'); }
    const allow = new Set((await imageBases()).concat([IMG_FALLBACK]).map((b) => { try { return new URL(b).hostname; } catch (e) { return ''; } }));
    if (!allow.has(host)) throw new Error('bf 图片代理拒绝非 IMAGE 域地址');
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

  // 播放解析:清单须 okhttp UA(浏览器 fetch 禁改 UA)→ 经 /api/bf/playlist 服务端代理文本;
  // 重写后 KEY(ACAO:*)与切片(ACAO:*)均浏览器 hls.js 直连,服务器不过流量
  async resolvePlay(id) {
    if (!id) throw new Error('bf resolvePlay 缺少视频 id');
    const d = await fetchDetailRaw(id);
    if (!d.sourceURL) throw new Error('bf 视频 ' + id + ' 无播放地址(可能已下架)');
    return { type: 'hls', url: '/api/bf/playlist?id=' + encodeURIComponent(String(id)), via: 'm3u8' };
  }

  // 播放清单文本代理:LRU 缓存(5 分钟新鲜期,切片 ?md= 签名分钟级时效)
  async playlist(id) {
    if (!id) throw new Error('bf playlist 缺少视频 id');
    const hit = playCache.get(String(id));
    if (hit && Date.now() - hit.at < PLAY_TTL) return hit.text;
    const d = await fetchDetailRaw(id);
    if (!d.sourceURL) throw new Error('bf 视频 ' + id + ' 无播放地址(可能已下架)');
    await ensureToken();
    const base = await resolveBase();
    const m3u8Url = base + '/api/app/vid/h5/m3u8/' + d.sourceURL + '?token=' + encodeURIComponent(S.token) + '&c=';
    const r = await fetch(m3u8Url, {
      cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': UA_OKHTTP, 'X-User-Agent': xua(S.devID), 'temp': 'test' },
    });
    const text = await r.text();
    if (!text.startsWith('#EXTM3U')) throw new Error('bf 清单被拦(HTTP ' + r.status + ' ' + text.slice(0, 40) + ')');
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
