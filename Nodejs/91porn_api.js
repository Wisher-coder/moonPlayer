#!/usr/bin/env node
'use strict';
/**
 * 91porn_api.js —— 91pron(Butterfly H5 站群,d17f2ecjynx0fw.cloudfront.net)视频类只读 API 爬取器(Node.js 版,零依赖,需 Node>=18)
 *
 * 逆向结论(2026-10-06 三轮 34 端点活线实测;协议链与 pnk3n_pentest_tool.user.js v6.13.0 bf 段同源互证;
 *            同协议不同站的姊妹工具 = bf_api.js,勿混线):
 *   1. 站点为 Vue3 SPA(网页入口 /home 空壳,#app + /js/main-*.js + web-sdk-v 引导脚本),长视频与
 *      短剧同壳同 SPA 两套数据面,全部走独立 API 网关(候选表写在主 bundle 的 JSON.parse('[…]') 明文:
 *      gx5q5.com / d122lhoqt6shfh / d2dyiyxr71jnmg);本工具直连 API 网关,不依赖网页入口存活;
 *      (网页壳带反调试保护:vendor 六探针 debugger 时序/functionToString/eruda 等,命中跳百度——
 *       直连 API 不经网页零影响;手工调试网页时带 ?devTest=1 后门参数即整段停摆);
 *   2. 协议「Butterfly」双层 AES(2026-10-06 复验未轮换):
 *      - 请求:参数对象 JSON → AES-128-CBC(key=iv=常量 BxJand%xf5h3sycH 的 Latin1 字节)
 *        → base64 → GET 拼在 ?data= 上 / POST 放 {"data":…} 体;
 *      - 响应:{code,hash,data};code==200 且 hash==true 时 data 为密文 base64,
 *        解密:interfaceKey 常量 UTF8 字节 + 密文头 12B 播种 → SHA256 链派生 AES-256-CBC
 *        key/iv(链式三次 digest 拼 32B key/16B iv),interfaceKey 随前端版本轮换→候选制逐把试解;
 *      - 头:X-User-Agent 设备串(BuildID=com.abc.Butterfly;…Terminal=1;IsH5=1)标识 H5 终端;
 *   3. 登录态:游客登录 POST /mine/login/h5 {devID(16位随机+毫秒),sysType:ios,cutInfos:'{}',
 *      isAppStore:false} → {token,uid};token 经 Authorization 头携带,失效(code 5009)重登即可;
 *      登录端点有全局限频 4007(频繁换 devID 冷启会触发)→ 会话缓存 %TEMP%\91porn_api_session.json
 *      跨进程复用(devID 生成即固化;成功一次之后冷启零登录;5009 只清 token 保设备号);
 *      也可手工种:从浏览器 localStorage 收割 token / devID(__web_sdk_device_id__)/ uid 写入该文件;
 *   4. 【m3u8 的 UA 硬判已解除】:旧版站群清单端点要求 okhttp 系 UA(浏览器 UA 只回预览流),
 *      本站 2026-10-06 实测 Node 默认 UA 亦直接回全片清单——长视频 123 段/短剧集 19 段全过;
 *      工具仍统一带 okhttp UA 保持与站方 App 一致的请求形态;
 *   5. 长视频(电影/长片,movieDetails 面,全部实测):
 *      模块 GET /modules/list(旧)与 /modules/list/v2(v2 含 homeContentType=DRAMA 的短剧模块,
 *      其 id 即 drama/home 的 moduleId;/vid/v2/module/{id} 已 404 下线);
 *      模块视频 GET /vid/module/{moduleId} {pageNumber,pageSize,moduleSort};
 *      首页新片 GET /vid/home/new/list {pageNumber,pageSize} → {videos}(条目直出 sourceURL 票据);
 *      推荐流 GET /vid/list {pageNumber,pageSize} → {list}(条目直出 sourceURL);
 *      发现流 GET /recommend/vid/list/discover {type:1,pageNumber,pageSize} → {videos}
 *      (newsType=SHORT 抖音系短视频;缺 type 即 4001);
 *      搜索 POST /search/list {keyWords:[词],pageNumber,pageSize,realm:'SP',sortType}(1观看/2最新/3喜欢);
 *      热片 GET /search/hotVid/list {pageNumber,pageSize} → {data};热词 GET /search/hotTag;
 *      标签 GET /tag/conf/list;标签视频 GET /tag/vid/list {tagID,pageNumber,pageSize,sortType};
 *      详情 GET /vid/info {videoID}(⚠ id 已全面 ObjectID 化——24hex;旧数字 id 报 5001
 *      database query error,列条目里的 id 才是合法入参);
 *      相关 GET /vid/recommend/list {vid,pageNumber,pageSize}(游客态空列表属正常);
 *      片库配置 GET /vid/library → {canvas,orderBy,vidTags,acgTags,paymentType,timeType}(五维选项对象表);
 *      片库筛选 POST /vid/library/search {keyword:{canvas,orderBy,tags,paymentType,timeType}
 *      (⚠ 须传 /vid/library 里的完整选项对象,字符串/裸 key 报 4001),pageNumber,pageSize}
 *      → {list,allMediaList(动漫/漫画类),hasNext,total};条目同 vid/list 结构;
 *      金币视频 GET /video_gold_coin/list(条目直出 vidId/vidTitle/sourceURL);活动 GET /video_activity/list;
 *      (合集系 /vid/section/list、POST /section/allList 实测参数未定/404,不入命令表);
 *   6. 短剧(drama 面,网页 /shortVideo 同源,全部实测):
 *      信息流 GET /media/drama/feed {pageSize} → {queueVersion,list:[{content=集,media=剧}]}
 *      (feed 只带各剧第 1 集,集对象含 videoUrl 票据);
 *      剧列表 GET /media/drama/list {sortType:1热门/2最新/4收藏,pageNumber,pageSize} → {total,list}(654+ 部);
 *      短剧首页 GET /media/drama/home {moduleId,pageNumber,pageSize}(moduleId 取 v2 模块表);
 *      专题 GET /media/drama/topics → {list[{topicId:hot_recommend/latest/…,workCount}]};
 *      专题作品 GET /media/drama/topic/works {topicId,pageNumber,pageSize};
 *      频道配置 GET /media/drama/channel/config(底部 tabs:直播/抖音/AI短剧/热门短剧);
 *      剧详情 GET /media/info {id} → {totalEpisode,currentEpisode,freeEpisode,price,contentsPrice,…};
 *      选集 GET /media_content/list {mediaId,sortType:0,pageNumber,pageSize:200} → {list}
 *      (每集 episodeNumber/isFree/canPlay/price/accessType;
 *       免费/已解锁集带 videoUrl=按次随机铸造票据(JHA-204/tk1/{108B加密定位符}.m3u8,
 *       同集两次取票全异);金币锁定集 videoUrl/h265Url/preview* 全空——服务端票据签发层完备);
 *      单集 GET /media_content/info {id} → 详情+paywall{checkoutContextId,unlockCoin,coinBalance};
 *      剧搜索 GET /media/search {keyword,kind:4,pageNumber,pageSize,sortType};
 *      剧库 GET /media/library(分类树);标签 GET /media_tag/list {pageNumber,pageSize}(5575 条,kind/dimension);
 *      已购 GET /media/my_buy {mediaType:'drama',…};书架 GET /media_bookshelf/list {type:'drama',…};
 *      (解锁 POST /product/buy {productType:19,productID:mediaId,contentID,checkoutContextId}+X-Request-ID
 *       为写操作不入命令;实测 0 余额干净拒绝 8006「支付繁忙」);
 *   7. 播放链(长视频/短剧同一网关同一形态,游客态即全片):
 *      清单 GET /api/app/vid/h5/m3u8/{票据}?token=&c=(实测免 UA 硬判)→ 完整 AES-128 HLS
 *      (真实 EXTINF;KEY 行 URI=/api/app/vid/sec 相对网关根,免鉴权 16B 且带不带 token 同钥,
 *      备用互补端点 /vid/m3u8sec);切片为清单内绝对 URL(注册表 VID 域:线路1 sjljsla.lkkwip.cn/
 *      海外专线 rs2sts.pjrwfe.cn,?md= 时间戳签名,ACAO:* + Range 206 全开);KEY 行短剧自带
 *      IV=0x000…0,长视频无 IV 属性但站方固定 IV=0(HLS 规范缺省 IV=媒体序号,直接给 hls.js 会
 *      解出垃圾——重写清单时统一显式补 IV=0);
 *   8. 封面:相对路径(如 cf230705/image/…)基座 = 注册表 /ping/domain/h5 的 IMAGE 域(轮换,
 *      ACAO:* octet-stream 实为 JPEG);注册表另含 GUIDE(导航)/LAND(落地)/TELEGRAM/APK 链接
 *      与 VID 播放线路表。
 *
 * 用法(网关三候选自动 ping 优选,--base 可换线路):
 *   node 91porn_api.js                          # 总览:短剧链(信息流→选集→播放链)+ 长视频链(推荐→详情→播放链)
 *   ── 通用 ──
 *   node 91porn_api.js help                     # 本用法总览(零网络零登录)
 *   node 91porn_api.js lines                    # API 网关候选 ping 状态
 *   node 91porn_api.js registry                 # 官方注册表(导航/下载/频道/播放线路)
 *   ── 长视频 ──
 *   node 91porn_api.js modules [--v2]           # 首页模块清单(v2 含短剧模块 id)
 *   node 91porn_api.js module <moduleId> [--page=1] [--size=10] [--sort=1]   # 模块内视频
 *   node 91porn_api.js home [--page=1] [--size=10]           # 首页新片(/vid/home/new/list)
 *   node 91porn_api.js recommend [--page=1] [--size=10]      # 推荐流(/vid/list,条目直出票据)
 *   node 91porn_api.js discover [--type=1] [--page=1] [--size=10]           # 发现流(SHORT 抖音系)
 *   node 91porn_api.js search 关键词 [--page=1] [--size=10] [--sort=2]      # 搜索(1观看/2最新/3喜欢)
 *   node 91porn_api.js hot                      # 热片榜(/search/hotVid/list)
 *   node 91porn_api.js hotwords                 # 热词榜(/search/hotTag)
 *   node 91porn_api.js tags                     # 标签表(/tag/conf/list)
 *   node 91porn_api.js tagvid <tagID> [--page=1] [--size=10] [--sort=2]      # 标签内视频
 *   node 91porn_api.js goldcoin                 # 金币视频清单(条目直出 sourceURL)
 *   node 91porn_api.js activity                 # 活动作品
 *   node 91porn_api.js library                  # 片库筛选配置(分类/排序/标签/付费/时间五维选项表)
 *   node 91porn_api.js catvid [SP] [--sort=new] [--tag=巨乳|标签id] [--pay=vip|point] [--time=1] [--page=1] [--size=10]
 *                                              # 片库分类筛选(/vid/library/search,6万+;SP影片/SHORT抖音/
 *                                              #   video动漫/image漫画 用 acgTags;时间 1本月/2三月内/3半年内/4更久)
 *   node 91porn_api.js video <videoID>          # 视频详情(标题/时长/付费形态/票据/标签)
 *   node 91porn_api.js rec <videoID> [--page=1] [--size=6]                   # 相关推荐
 *   node 91porn_api.js play <videoID>           # 播放链全探测(清单/密钥/切片 Range)
 *   node 91porn_api.js m3u8 <videoID> [--out=x.m3u8]   # 播放清单落盘(KEY 绝对化+IV=0)
 *   ── 短剧 ──
 *   node 91porn_api.js dfeed [--size=10]        # 短剧信息流(各剧第 1 集)
 *   node 91porn_api.js dlist [hot|latest|collect] [--page=1] [--size=10]    # 剧列表(654+ 部)
 *   node 91porn_api.js dhome [moduleId] [--page=1] [--size=10]              # 短剧首页(缺省取 v2 模块表)
 *   node 91porn_api.js dtopics                 # 短剧专题表(hot_recommend/latest/…)
 *   node 91porn_api.js dworks <topicId> [--page=1] [--size=10]              # 专题内剧
 *   node 91porn_api.js dchannels               # 短剧频道 tabs 配置
 *   node 91porn_api.js drama <mediaId>         # 剧详情(集数/免费集/价格/更新状态)
 *   node 91porn_api.js eps <mediaId>           # 全选集(锁态/价格/票据有无,分页拉平)
 *   node 91porn_api.js ep <contentId>          # 单集详情(含 paywall 结算上下文)
 *   node 91porn_api.js dsearch 关键词 [--page=1] [--size=10]                # 剧搜索(kind=4)
 *   node 91porn_api.js dlib                    # 剧库分类树
 *   node 91porn_api.js dtags [--page=1] [--size=20]                         # 剧标签表(5575 条)
 *   node 91porn_api.js mybuy                   # 已购短剧(游客态空)
 *   node 91porn_api.js shelf                   # 书架收藏(游客态空)
 *   node 91porn_api.js dplay <contentId>       # 短剧集播放链全探测(票据/清单/密钥/切片)
 *   node 91porn_api.js dm3u8 <contentId> [--out=x.m3u8]                     # 短剧清单落盘
 *   node 91porn_api.js wall <mediaId>          # 金币墙探测(锁集统计/单集 paywall/防线结论)
 *   node 91porn_api.js key                     # 双密钥端点探测(m3u8sec/sec)
 *   通用旗标:--base=<API网关>  --raw(输出完整 JSON)  --no-title(摘要隐藏标题)  --out=<文件)
 * 退出码:0=成功;1=失败。仅供站方授权测试使用。
 */

// ============ 0. 常量与命令行 ============

const DEFAULT_LINES = [   // API 网关候选(2026-10-06 本站主 bundle JSON.parse 明文;轮换后 --base 指定)
  'https://gx5q5.com',
  'https://d122lhoqt6shfh.cloudfront.net',
  'https://d2dyiyxr71jnmg.cloudfront.net',
];
const IMG_FALLBACK = 'https://zzzznnn.lkkwip.cn';   // 封面基座兜底(注册表 IMAGE 域轮换,registry 命令可查最新)
const PARAM_KEY = 'BxJand%xf5h3sycH';               // 请求 AES-128-CBC key=iv 常量
const IFACES = ['65dc07d1b7915c6b2937432b091837a7', '0a958fb9ac062420af6ba5f4caad779f']; // interfaceKey 候选(新→旧)
const UA_OKHTTP = 'okhttp/3.12.0';                  // 与站方 App 一致的非浏览器 UA(现行网关已免硬判,保留求同构)
const TIMEOUT_MS = 15000;
// 短剧列表排序映射(bundle 常量 di={hot:1,latest:2,collect:4})
const DRAMA_SORT = { hot: 1, latest: 2, collect: 4 };

const argv = process.argv.slice(2);
const flag = {};
for (const a of argv) {
  const m = a.match(/^--([a-z][a-z0-9_-]*)(?:=(.*))?$/);
  if (m) flag[m[1]] = m[2] !== undefined ? m[2] : true;
}
const positional = argv.filter(a => !a.startsWith('--'));
flag.noTitle = flag['no-title'];
const cmd = positional[0] || 'all';
const arg1 = positional[1];
const num = (k, d) => (flag[k] !== undefined ? parseInt(flag[k], 10) : d);
const fs = require('fs');

const log = (...a) => console.log(...a);
const die = (msg) => { console.error('✘ ' + msg); process.exitCode = 1; throw new Error('__DIE__'); };
const enc = new TextEncoder();

// ============ 1. 协议层(AES 请求加密 / SHA256 链响应解密) ============

const b64e = (u8) => Buffer.from(u8).toString('base64');
const b64d = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const cat = (...a) => { const n = a.reduce((x, y) => x + y.length, 0); const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const aes = async (key, iv, data, encrypt) => {
  const k = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, [encrypt ? 'encrypt' : 'decrypt']);
  return new Uint8Array(await crypto.subtle[encrypt ? 'encrypt' : 'decrypt']({ name: 'AES-CBC', iv }, k, data));
};
const sha = async (u8) => new Uint8Array(await crypto.subtle.digest('SHA-256', u8));

// 请求加密:参数 JSON → AES-128-CBC(key=iv=PARAM_KEY) → base64
const encReq = async (obj) => b64e(await aes(enc.encode(PARAM_KEY), enc.encode(PARAM_KEY), enc.encode(JSON.stringify(obj)), true));

// 响应解密(单把 interfaceKey):密文头 12B 与常量播种 → SHA256 链派生 AES-256 key/iv
async function decRespRaw(b64, iface) {
  const t = b64d(String(b64).replace(/\n/g, ''));
  const r = cat(enc.encode(iface), t.subarray(0, 12));
  const o = parseInt(String(r.length / 2));
  const s = (await sha(r)).subarray(8, 24);
  const u = await sha(cat(s, r.subarray(0, o)));
  const h = await sha(cat(r.subarray(o), s));
  const key = cat(u.subarray(0, 8), h.subarray(8, 24), u.subarray(24));
  const iv = cat(h.subarray(0, 4), u.subarray(12, 20), h.subarray(28));
  return JSON.parse(new TextDecoder().decode(await aes(key, iv, t.subarray(12), false)));
}
// interfaceKey 候选制轮换容错:新→旧逐把试解
async function decResp(b64) {
  let lastErr;
  for (const iface of IFACES) { try { return await decRespRaw(b64, iface); } catch (e) { lastErr = e; } }
  throw new Error('响应解密失败(interfaceKey 候选全不匹配,站点可能又轮换——从新 bundle 提取):' + (lastErr && lastErr.message || ''));
}

// ============ 2. 会话(线路优选 + 游客登录) ============

const AZ = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// 会话缓存:token/devID 跨进程复用(登录端点限频 4007 login too frequently——每次 CLI 冷启
// 都游客登录会触发;缓存命中即零登录,失效 5009 自动清缓存重登)
const os = require('os');
const SESSION_FILE = require('path').join(os.tmpdir(), '91porn_api_session.json');
let devID = '';
function loadSession() {
  try {
    const j = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    // 只要有 devID 就采纳(哪怕还没 token):设备号跨进程稳定,避免「频繁换设备登录」触发 4007
    if (j && j.devID) { devID = j.devID; if (j.token) { S.token = j.token; S.uid = j.uid || ''; return true; } }
  } catch (e) { }
  return false;
}
function saveSession() {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify({ devID, token: S.token, uid: S.uid, ts: Date.now() })); } catch (e) { }
}
function clearSession() { try { fs.writeFileSync(SESSION_FILE, JSON.stringify({ devID })); } catch (e) { } }   // 只清 token,设备号保留(换号会被判频繁登录)
const genDevId = () => Array.from({ length: 16 }, () => AZ[Math.floor(Math.random() * 62)]).join('') + Date.now();
const xua = () => 'BuildID=com.abc.Butterfly;SysType=ios;DevID=' + devID + ';Ver=1.0.0;DevType=iPhone;DeviceBrand=APPLE;DeviceModel=iPhone;SystemName=ios;SystemVersion=17.5;Terminal=1;IsH5=1;Sid=';

const S = { base: '', token: '', uid: '' };   // 会话态(线路 + 游客 token)

const api = (p) => S.base + '/api/app' + p;

// 线路 ping:/api/app/ping/check 返回 {code:200} 即活
async function ping(base) {
  try {
    const r = await fetch(base.replace(/\/+$/, '') + '/api/app/ping/check', { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': UA_OKHTTP } });
    return (await r.json()).code === 200;
  } catch (e) { return false; }
}

// 线路优选:--base 显式优先,否则候选并行 ping 取活者(顺序即优先级)
async function ensureBase() {
  if (S.base) return;
  const cands = flag.base ? [String(flag.base).replace(/\/+$/, '')] : DEFAULT_LINES;
  if (flag.base) { S.base = cands[0]; return; }   // 显式线路不 ping(取证场景要打指定网关)
  const alive = await Promise.all(cands.map(ping));
  for (let i = 0; i < cands.length; i++) if (alive[i]) { S.base = cands[i]; return; }
  die('API 网关候选全部不可达(' + cands.join(' ') + ';轮换后用 --base= 指定,registry 命令可查导航页)');
}

// 游客登录 → token(缓存命中直接复用;失效 5009 由 call 清除后重登;限频 4007 仅退避一次防喂养限频计数)
async function login() {
  if (S.token) return;
  if (!devID) { devID = genDevId(); saveSession(); }   // 生成即落盘:服务端按设备号识频,换号冷启会被判「频繁登录」
  for (let i = 0; i < 2; i++) {
    try {
      const d = await call('POST', '/mine/login/h5', { body: { devID, sysType: 'ios', cutInfos: '{}', isAppStore: false }, noAuth: true });
      S.token = d.token; S.uid = d.uid;
      saveSession();
      return;
    } catch (e) {
      if (!/code=4007/.test(e.message) || i === 1) {
        if (/code=4007/.test(e.message)) throw new Error(e.message + '\n  · 登录端点全局限频窗口未过(设备号已固定为 ' + devID.slice(0, 6) + '…并落盘,后续冷启不再换设备)。\n  · 等几分钟再跑即可;成功一次 token 会写入 ' + SESSION_FILE + ',之后每次冷启都复用缓存会话,零登录请求。');
        throw e;
      }
      log('· 登录限频(4007 login too frequently),8s 后重试(1/1)…');
      await new Promise(r => setTimeout(r, 8000));
    }
  }
}

// 统一调用:GET 参数走 ?data= 密文,POST 走 {"data":…} 体;响应解密 + 5009 重登重试
async function call(method, path, { params, body, token, noAuth } = {}) {
  let url = api(path);
  const headers = { 'Content-Type': 'application/json', 'temp': 'test', 'X-User-Agent': xua(), 'User-Agent': UA_OKHTTP };
  const tok = token !== undefined ? token : (noAuth ? undefined : S.token || undefined);
  if (tok) headers.Authorization = tok;
  const opts = { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (method === 'GET' && params) url += '?data=' + encodeURIComponent(await encReq(params));
  if (method === 'POST') opts.body = JSON.stringify({ data: await encReq(body || {}) });
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => { throw new Error('HTTP ' + r.status + ' 非 JSON @' + path); });
  if (j.code === 200 && j.hash && typeof j.data === 'string') j.data = await decResp(j.data);
  if (j.code === 200) return j.data;
  if (j.code === 5009 && !noAuth && S.token) {   // 登录态失效:清缓存重登一次原参重放
    S.token = '';
    clearSession();
    await login();
    return call(method, path, { params, body });
  }
  throw new Error('API ' + path + ' code=' + j.code + ' ' + (j.msg || j.tip || ''));
}

// ============ 3. 摘要打印 ============

const fmtDur = (s) => s == null ? '?' : Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
const mask = (t, on) => on ? '<标题已隐藏>' : String(t == null ? '' : t).slice(0, 42);

// 长视频条目(vid/list、videos、allVideoInfo、data 等字段同构)摘要行
function printVids(list, opt) {
  if (!list || !list.length) { log('  (无结果)'); return; }
  for (const v of list) {
    const tags = [v.coins ? '金币' + +v.coins : 'free', v.freeTime ? '试' + +v.freeTime + 's' : '', v.newsType || ''].filter(Boolean).join('/');
    log('   [' + String(v.id).slice(-6) + '] ' + fmtDur(v.playTime).padStart(7) + ' ' + tags.padEnd(12) + ' ' + mask(v.title, opt.noTitle));
  }
}
const normVids = (d) => (d && Array.isArray(d.list) ? d.list : Array.isArray(d) ? d : (d && Array.isArray(d.allVideoInfo) ? d.allVideoInfo : (d && Array.isArray(d.videos) ? d.videos : (d && Array.isArray(d.data) ? d.data : []))));

// 短剧集(media_content/list 元素)摘要行:集号/锁态/价格/票据有无
function printEps(list, opt) {
  if (!list || !list.length) { log('  (无选集)'); return; }
  for (const e of list) {
    const state = e.isFree ? 'free' : e.canPlay ? 'unlocked' : '🔒coin' + (e.price || '?');
    const ticket = e.videoUrl ? '票✓' : (e.previewVideoUrl || e.previewH265Url) ? '试✓' : '票✗';
    log('   第' + String(e.episodeNumber).padStart(3) + '集 [' + String(e.id).slice(-6) + '] ' + state.padEnd(9) + ' ' + ticket + '  ' + fmtDur(e.playTime).padStart(7) + '  ' + mask(e.name, opt.noTitle));
  }
}

// 短剧集(信息流/专题/列表条目)
function printDramas(list, opt) {
  if (!list || !list.length) { log('  (无结果)'); return; }
  for (const m of list) {
    const s = m.media || m;
    const ep = m.content ? ' 第' + m.content.episodeNumber + '集' : '';
    log('   [' + String(s.id).slice(-6) + '] ' + String(s.totalEpisode || '?').padStart(3) + '集' + ep.padEnd(5) +
      ' 更新' + (s.updateStatus === 2 ? '完' : '中') + ' ' + mask(s.title, opt.noTitle));
  }
}

// ============ 4. 播放链 ============

// 清单文本:?token= 携带游客态(2026-10-06 实测免 UA 硬判,Node 默认 UA 亦全片;仍带 okhttp 求同构)
async function fetchM3u8(src, token) {
  const url = api('/vid/h5/m3u8/' + src) + '?token=' + encodeURIComponent(token) + '&c=';
  const r = await fetch(url, { headers: { 'User-Agent': UA_OKHTTP, 'X-User-Agent': xua(), 'temp': 'test' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const t = await r.text();
  if (!t.startsWith('#EXTM3U')) throw new Error('m3u8 被拦(HTTP ' + r.status + ' ' + t.slice(0, 50) + ')');
  return t;
}

// 清单重写:KEY 行 URI 绝对化 + 显式 IV=0(长视频无 IV 属性、短剧自带,统一补齐零 IV——
// 站方固定零 IV,缺省按规范会用媒体序号解出垃圾),切片本就是绝对 URL 原样保留
function rewriteM3u8(text, m3u8Url) {
  return text.split('\n').map((l) => {
    if (l.indexOf('#EXT-X-KEY') === 0) {
      const ku = (l.match(/URI="([^"]+)"/) || [])[1];
      if (!ku) return l;
      const abs = new URL(ku, m3u8Url).href;
      return '#EXT-X-KEY:METHOD=AES-128,URI="' + abs + '",IV=0x00000000000000000000000000000000';
    }
    return l;
  }).join('\n');
}

// 密钥拉取(端点免鉴权,双端点互补:全片 m3u8sec / 试看 sec;接受路径或绝对 URL)
async function fetchKey(pathOrUrl) {
  const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : api(pathOrUrl);
  const r = await fetch(url, { headers: { 'User-Agent': UA_OKHTTP }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const b = new Uint8Array(await r.arrayBuffer());
  if (b.length !== 16) throw new Error('密钥长度异常 ' + b.length + 'B @' + url);
  return Buffer.from(b).toString('hex');
}

// 播放链探测通用件:票据 → 清单重写 → 段数/时长/密钥/首段 Range(长视频与短剧共用)
async function probePlayChain(ticket, label) {
  if (!ticket) throw new Error('无票据(锁定集不发票据——服务端门禁)');
  const m3u8Url = api('/vid/h5/m3u8/' + ticket) + '?token=' + encodeURIComponent(S.token) + '&c=';
  const text = rewriteM3u8(await fetchM3u8(ticket, S.token), m3u8Url);
  const segs = (text.match(/^https?:\/\//gm) || []).length;
  const dur = text.split('\n').filter(l => l.startsWith('#EXTINF')).reduce((a, l) => a + (parseFloat(l.slice(8)) || 0), 0);
  log('  ① 清单:✓ ' + segs + ' 段,总时长 ~' + fmtDur(Math.round(dur)) + '(' + label + ')');
  const keyLine = text.split('\n').find(l => l.startsWith('#EXT-X-KEY')) || '';
  log('  ② KEY 行: ' + keyLine.slice(0, 110));
  const ku = (keyLine.match(/URI="([^"]+)"/) || [])[1];
  if (ku) log('  ③ 密钥(免鉴权): ' + await fetchKey(ku));
  const seg = text.split('\n').find(l => l && !l.startsWith('#'));
  if (seg) {
    const rs = await fetch(seg, { headers: { 'User-Agent': UA_OKHTTP, 'Range': 'bytes=0-187' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const head = new Uint8Array(await rs.arrayBuffer());
    log('  ④ 首段 Range: ' + rs.status + ' ' + head.byteLength + 'B ACAO=' + (rs.headers.get('access-control-allow-origin') || '-') + '(AES 密文,同步字节无意义)');
  }
  return text;
}

// ============ 5. 命令表 ============

const COMMANDS = {
  async help() {   // 用法总览:直接回显本文件头部注释(零网络零登录)
    const src = fs.readFileSync(__filename, 'utf8');
    log(src.slice(src.indexOf('/*'), src.indexOf('*/') + 2).replace(/^ \* ?/gm, '').trimEnd());
  },
  async lines() {   // 网关候选 ping 状态
    log('── API 网关候选 ──');
    const rs = await Promise.all(DEFAULT_LINES.map(ping));
    DEFAULT_LINES.forEach((b, i) => log('   ' + (rs[i] ? '✓' : '✗') + ' ' + b.replace(/^https?:\/\//, '')));
    if (rs.every(x => !x)) die('全部不可达——线路已轮换(从新 bundle 的 JSON.parse 候选表提取)');
  },
  async registry() {   // 官方注册表(须登录态)
    const d = await call('GET', '/ping/domain/h5');
    log('── 官方注册表 /ping/domain/h5 ──');
    for (const it of (d && d.sourceList) || []) {
      const urls = (it.domain || []).map(x => x.url).join(' | ');
      log('   ' + String(it.type).padEnd(14) + ' ' + urls);
    }
    const keep = ['andLink', 'iosLink', 'webJumpLandpage', 'louFengH5', 'aiMateH5'];
    for (const k of keep) if (d && d[k]) log('   ' + k.padEnd(16) + ' ' + String(d[k]).slice(0, 90));
  },

  // ── 长视频 ──
  async modules() {   // 首页模块(v2 含短剧模块)
    const v2 = flag.v2 || flag['2'];
    const d = await call('GET', v2 ? '/modules/list/v2' : '/modules/list');
    const hp = (d && d.homePage) || [];
    log('── 首页模块 ' + (v2 ? '/modules/list/v2' : '/modules/list') + '(' + hp.length + ')──');
    for (const m of hp) log('   [' + m.id + '] ' + (m.moduleName || '?') + (v2 && m.homeContentType ? '  ' + m.homeContentType : '') + '  type=' + m.type);
  },
  async module() {   // 模块内视频
    if (!arg1) die('用法: module <moduleId> [--page=N] [--size=N] [--sort=N]');
    const d = await call('GET', '/vid/module/' + arg1, { params: { pageNumber: num('page', 1), pageSize: num('size', 10), moduleSort: num('sort', 1) } });
    log('── 模块视频 ' + arg1.slice(-6) + ' ──');
    printVids(normVids(d), flag);
    log('   hasNext=' + !!(d && d.hasNext));
  },
  async home() {   // 首页新片
    const d = await call('GET', '/vid/home/new/list', { params: { pageNumber: num('page', 1), pageSize: num('size', 10) } });
    log('── 首页新片 /vid/home/new/list ──');
    printVids(normVids(d), flag);
  },
  async recommend() {   // 推荐流(条目直出票据)
    const d = await call('GET', '/vid/list', { params: { pageNumber: num('page', 1), pageSize: num('size', 10) } });
    log('── 推荐流 /vid/list ──');
    printVids(normVids(d), flag);
    log('   hasNext=' + !!(d && d.hasNext));
  },
  async discover() {   // 发现流(SHORT 抖音系;type 缺省 4001)
    const d = await call('GET', '/recommend/vid/list/discover', { params: { type: num('type', 1), pageNumber: num('page', 1), pageSize: num('size', 10) } });
    log('── 发现流 /recommend/vid/list/discover(type=' + num('type', 1) + ')──');
    printVids(normVids(d), flag);
    log('   hasNext=' + !!(d && d.hasNext));
  },
  async search() {   // 搜索(排序 1观看/2最新/3喜欢)
    if (!arg1) die('用法: search <关键词> [--page=N] [--size=N] [--sort=N]');
    const d = await call('POST', '/search/list', { body: { keyWords: [arg1], pageNumber: num('page', 1), pageSize: num('size', 10), realm: 'SP', sortType: num('sort', 2) } });
    log('── 搜索 "' + arg1 + '"(sort=' + num('sort', 2) + ')──');
    printVids(normVids(d), flag);
    log('   hasNext=' + !!(d && d.hasNext));
  },
  async hot() {   // 热片榜
    const d = await call('GET', '/search/hotVid/list', { params: { pageNumber: 1, pageSize: 15 } });
    log('── 热片榜 /search/hotVid/list ──');
    printVids(normVids(d), flag);
  },
  async hotwords() {   // 热词榜
    const d = await call('GET', '/search/hotTag', { params: { pageNumber: 1, pageSize: 20 } });
    const list = (d && d.list) || [];
    log('── 热词榜 /search/hotTag ──');
    if (!list.length) return log('  (空)');
    for (const h of list) log('   ' + mask(h.name, flag.noTitle) + '  hot=' + h.hot);
  },
  async tags() {   // 标签表
    const d = await call('GET', '/tag/conf/list');
    const tags = (d && d.tags) || [];
    log('── 标签表 /tag/conf/list(' + tags.length + ')──');
    for (const t of tags) log('   [' + t.id + '] ' + mask(t.tagName, flag.noTitle));
  },
  async tagvid() {   // 标签内视频
    if (!arg1) die('用法: tagvid <tagID> [--page=N] [--size=N] [--sort=N]');
    const d = await call('GET', '/tag/vid/list', { params: { tagID: arg1, pageNumber: num('page', 1), pageSize: num('size', 10), sortType: num('sort', 2) } });
    log('── 标签视频 ' + arg1.slice(-6) + ' ──');
    printVids(normVids(d), flag);
    log('   hasNext=' + !!(d && d.hasNext));
  },
  async goldcoin() {   // 金币视频清单(条目直出 sourceURL)
    const d = await call('GET', '/video_gold_coin/list', { params: { pageNumber: num('page', 1), pageSize: num('size', 10) } });
    const list = normVids(d);
    log('── 金币视频 /video_gold_coin/list ──');
    printVids(list, flag);
    if (list[0] && list[0].vidId) log('   (条目含 vidId/vidTitle,详情用 video 命令查)');
  },
  async activity() {   // 活动作品
    const d = await call('GET', '/video_activity/list', { params: { pageNumber: num('page', 1), pageSize: num('size', 10) } });
    const list = (d && d.workList) || [];
    log('── 活动作品 /video_activity/list ──');
    printVids(list, flag);
  },
  async library() {   // 片库筛选配置(catvid 五维筛选的选项来源;取自片库页 /moreCate 逆向)
    const d = await call('GET', '/vid/library');
    log('── 片库配置 /vid/library(catvid 的五维筛选)──');
    const show = (name, arr) => log('  ' + name + '(' + arr.length + '): ' + arr.map(x => (x.id || x.key || '') + (x.name ? '=' + x.name : '')).join(' / ').slice(0, 600));
    show('分类 canvas', d.canvas || []);
    show('排序 orderBy', d.orderBy || []);
    show('长视频标签 vidTags', d.vidTags || []);
    show('动漫漫画标签 acgTags', d.acgTags || []);
    show('付费 paymentType', d.paymentType || []);
    show('时间 timeType', d.timeType || []);
    if (flag.raw) log('  RAW: ' + JSON.stringify(d).slice(0, 1500));
  },
  async catvid() {   // 片库分类筛选:POST /vid/library/search {keyword:{canvas,orderBy,tags,paymentType,timeType}(须传完整选项对象,字符串报 4001),pageNumber,pageSize}
    const lib = await call('GET', '/vid/library');
    const canvases = lib.canvas || [], orders = lib.orderBy || [], pays = lib.paymentType || [], times = lib.timeType || [];
    const ckey = arg1 || 'SP';
    const canvas = canvases.find(c => c.key === ckey);
    if (!canvas) die('未知分类 ' + ckey + '(可用: ' + canvases.map(c => c.key + '=' + c.name).join(' / ') + ')');
    const pick = (arr, val) => arr.find(x => String(x.key != null ? x.key : x.id) === String(val) || x.name === val);
    const order = (flag.sort ? pick(orders, flag.sort) : orders[0]) || die('排序不存在(可用: ' + orders.map(o => o.key).join('/') + ')');
    const pay = (flag.pay ? pick(pays, flag.pay) : pays[0]) || die('付费不存在(可用: ' + pays.map(p => p.key || '全部').join('/') + ')');
    const time = (flag.time ? pick(times, flag.time) : times[0]) || die('时间不存在(可用: ' + times.map(t => t.key + '=' + t.name).join('/') + ')');
    const tagPool = (ckey === 'video' || ckey === 'image') ? (lib.acgTags || []) : (lib.vidTags || []);   // 动漫/漫画用 acgTags(片库页同款切换)
    let tag = tagPool[0];
    if (flag.tag) {
      tag = tagPool.find(t => t.id === String(flag.tag) || t.name === String(flag.tag));
      if (!tag) die('标签不存在: ' + flag.tag + '(library 命令可查全部标签)');
    }
    const d = await call('POST', '/vid/library/search', { body: { keyword: { canvas, orderBy: order, tags: tag, paymentType: pay, timeType: time }, pageNumber: num('page', 1), pageSize: num('size', 10) } });
    const list = d.list || d.allMediaList || [];   // 动漫/漫画类返回 allMediaList(片库页 w 计算属性同判)
    log('── 片库 ' + canvas.name + (tag && tag.id ? ' · ' + tag.name : '') + ' · ' + order.name + ' · ' + pay.name + ' · ' + time.name + '(共 ' + (d.total != null ? d.total : '?') + ')──');
    printVids(list, flag);
    if (flag.raw) log('  RAW: ' + JSON.stringify(d).slice(0, 800));
  },
  async video(id0) {   // 视频详情(⚠ id 为 24 位 ObjectID,旧数字 id 报 5001;id0 供 all 总览内调)
    const vid = id0 || arg1;
    if (!vid) die('用法: video <videoID>(id 从 list 类命令取)');
    const d = await call('GET', '/vid/info', { params: { videoID: vid } });
    log('── 视频详情 id=' + vid.slice(-6) + ' ──');
    log('  title: ' + mask(d.title, flag.noTitle));
    log('  duration: ' + fmtDur(d.playTime) + '  createdAt: ' + (d.createdAt || '').slice(0, 19));
    log('  付费形态: ' + (+d.coins ? '金币' + +d.coins + (d.freeTime ? '(试看' + +d.freeTime + 's)' : '') : 'free'));
    log('  正片票据: ' + (d.sourceURL || '(无)'));
    log('  试看票据: ' + (d.previewURL || '(无)'));
    log('  封面基座: ' + IMG_FALLBACK.replace(/^https?:\/\//, '') + '/…(注册表 IMAGE 域轮换)');
    log('  标签: ' + ((d.tags || []).map(t => t.tagName || t.name || t).join('、') || '(无)').slice(0, 90));
    if (flag.raw) log('\n── RAW ──\n' + JSON.stringify(d, null, 2).slice(0, 2000));
  },
  async rec() {   // 相关推荐(游客态空列表属正常)
    if (!arg1) die('用法: rec <videoID> [--page=N] [--size=N]');
    const d = await call('GET', '/vid/recommend/list', { params: { vid: arg1, pageNumber: num('page', 1), pageSize: num('size', 6) } });
    log('── 相关推荐 id=' + arg1.slice(-6) + ' ──');
    printVids(normVids(d), flag);
    log('   hasNext=' + !!(d && d.hasNext));
  },
  async play() {   // 长视频播放链全探测
    if (!arg1) die('用法: play <videoID>');
    const info = await call('GET', '/vid/info', { params: { videoID: arg1 } });
    if (!info.sourceURL) die('该视频无 sourceURL(可能已删)');
    log('── 播放链 id=' + arg1.slice(-6) + '《' + mask(info.title, flag.noTitle) + '》──');
    const text = await probePlayChain(info.sourceURL, '游客态全片,免 UA 硬判');
    if (flag.out) { fs.writeFileSync(String(flag.out), text); log('  ✓ 清单已落盘 ' + flag.out + '(KEY 已绝对化+IV=0,hls.js/mpv 可直接播)'); }
  },
  async m3u8() {   // 长视频清单落盘
    if (!arg1) die('用法: m3u8 <videoID> [--out=文件.m3u8]');
    const info = await call('GET', '/vid/info', { params: { videoID: arg1 } });
    if (!info.sourceURL) die('该视频无 sourceURL(可能已删)');
    const m3u8Url = api('/vid/h5/m3u8/' + info.sourceURL) + '?token=' + encodeURIComponent(S.token) + '&c=';
    const text = rewriteM3u8(await fetchM3u8(info.sourceURL, S.token), m3u8Url);
    if (flag.out) {
      fs.writeFileSync(String(flag.out), text);
      log('✓ ' + String(flag.out) + '(' + (text.match(/^https?:\/\//gm) || []).length + ' 段,KEY 绝对化+IV=0)');
    } else {
      log(text.slice(0, 800));
    }
  },

  // ── 短剧 ──
  async dfeed() {   // 短剧信息流(各剧第 1 集,集对象含票据)
    const d = await call('GET', '/media/drama/feed', { params: { pageSize: num('size', 10) } });
    log('── 短剧信息流 /media/drama/feed(queue=' + String((d && d.queueVersion) || '').slice(0, 24) + ')──');
    for (const it of (d && d.list) || []) {
      const m = it.media || {}, c = it.content || {};
      const st = c.isFree ? 'free' : c.canPlay ? 'unlocked' : '🔒coin' + (c.price || '?');
      log('   [' + String(m.id).slice(-6) + '] ' + String(m.totalEpisode || '?').padStart(3) + '集 第' + (c.episodeNumber || 1) + '集 ' + st.padEnd(9) + (c.videoUrl ? '票✓ ' : '票✗ ') + mask(m.title, flag.noTitle));
    }
    log('   hasNext=' + !!(d && d.hasNext));
    if (flag.raw) log('  RAW: ' + JSON.stringify((d && d.list) || []).slice(0, 800));
  },
  async dlist() {   // 剧列表(hot/latest/collect → sortType 1/2/4)
    const sname = String(arg1 || 'hot').toLowerCase();
    const st = DRAMA_SORT[sname] || num('sort', 1);
    const d = await call('GET', '/media/drama/list', { params: { sortType: st, pageNumber: num('page', 1), pageSize: num('size', 10) } });
    log('── 剧列表 /media/drama/list(sort=' + st + ' 共 ' + ((d && d.total) || '?') + ' 部)──');
    printDramas((d && d.list) || [], flag);
    log('   hasNext=' + !!(d && d.hasNext));
    if (flag.raw) log('  RAW: ' + JSON.stringify((d && d.list) || []).slice(0, 800));
  },
  async dhome() {   // 短剧首页(moduleId 缺省取 v2 模块表首个 DRAMA 模块)
    let mid = arg1;
    if (!mid) {
      const mv = await call('GET', '/modules/list/v2');
      const dm = ((mv && mv.homePage) || []).find(m => m.homeContentType === 'DRAMA' || m.type === 12);
      if (!dm) die('v2 模块表无 DRAMA 模块(用 dhome <moduleId> 显式指定)');
      mid = dm.id;
      log('· moduleId 取自 v2 模块表:[' + dm.id + '] ' + (dm.moduleName || '?'));
    }
    const d = await call('GET', '/media/drama/home', { params: { moduleId: mid, pageNumber: num('page', 1), pageSize: num('size', 10) } });
    log('── 短剧首页 /media/drama/home(banners=' + ((d && d.banners) || []).length + ')──');
    printDramas((d && d.list) || (d && d.mediaList) || [], flag);
    if (flag.raw) log('  RAW: ' + JSON.stringify(d).slice(0, 500));
  },
  async dtopics() {   // 短剧专题表
    const d = await call('GET', '/media/drama/topics');
    log('── 短剧专题 /media/drama/topics ──');
    for (const t of (d && d.list) || []) log('   [' + t.topicId + '] ' + t.name + '  ' + (t.workCount || 0) + ' 部(' + t.topicType + ')');
  },
  async dworks() {   // 专题内剧
    if (!arg1) die('用法: dworks <topicId>(dtopics 可查,如 hot_recommend/latest)');
    const d = await call('GET', '/media/drama/topic/works', { params: { topicId: arg1, pageNumber: num('page', 1), pageSize: num('size', 10) } });
    log('── 专题作品 ' + arg1 + '(共 ' + ((d && d.total) || '?') + ')──');
    printDramas((d && d.list) || [], flag);
    log('   hasNext=' + !!(d && d.hasNext));
    if (flag.raw) log('  RAW: ' + JSON.stringify((d && d.list) || []).slice(0, 800));
  },
  async dchannels() {   // 短剧频道 tabs 配置
    const d = await call('GET', '/media/drama/channel/config');
    log('── 短剧频道 /media/drama/channel/config ──');
    log('   bottomTabTitle=' + (d.bottomTabTitle || '?') + '  defaultTab=' + (d.defaultTab || '?') + '  adEnabled=' + d.adEnabled);
    for (const t of d.tabs || []) log('   [' + t.key + '] ' + t.title + (t.enabled ? '' : '(关)') + '  moduleId=' + (t.moduleId || '-'));
  },
  async drama() {   // 剧详情
    if (!arg1) die('用法: drama <mediaId>(id 从 dlist/dfeed/dworks 取,--raw 可得完整 id)');
    const d = await call('GET', '/media/info', { params: { id: arg1 } });
    log('── 剧详情 id=' + arg1.slice(-6) + ' ──');
    log('  title: ' + mask(d.title, flag.noTitle));
    log('  集数: ' + (d.currentEpisode || '?') + '/' + (d.totalEpisode || '?') + '(' + (d.updateStatus === 2 ? '已完更' : '连载中') + ')  免费集:' + (d.freeEpisode != null ? d.freeEpisode : '?'));
    log('  价格: 整剧=' + (d.price || 0) + '  全集=' + (d.contentsPrice || 0) + '(金币)  hasDramaCard=' + d.hasDramaCard);
    log('  数据: 浏览' + (d.countBrowse || 0) + ' 收藏' + (d.countCollect || 0) + ' 喜欢' + (d.countLike || 0) + ' 购买' + (d.countPurchases || 0));
    log('  标签: ' + ((d.tagDetails || d.tags || []).map(t => t.name || t.tagName || t).join('、') || '(无)').slice(0, 90));
    if (flag.raw) log('\n── RAW ──\n' + JSON.stringify(d, null, 2).slice(0, 2400));
  },
  async eps(id0) {   // 全选集(分页拉平;锁态/价格/票据有无;id0 供 all 总览内调)
    const mid = id0 || arg1;
    if (!mid) die('用法: eps <mediaId>');
    const all = [];
    for (let page = 1; page <= 20; page++) {
      const d = await call('GET', '/media_content/list', { params: { mediaId: mid, sortType: 0, pageNumber: page, pageSize: 200 } });
      const list = (d && d.list) || [];
      all.push(...list);
      if (!d || !d.hasNext || !list.length) break;
    }
    const locked = all.filter(e => !e.isFree && !e.canPlay);
    const prev = all.filter(e => !e.isFree && !e.canPlay && (e.previewVideoUrl || e.previewH265Url));
    log('── 选集 /media_content/list id=' + mid.slice(-6) + '(共 ' + all.length + ' 集:可播 ' + (all.length - locked.length) + ' · 锁定 ' + locked.length + (locked.length ? '(每集 ' + (locked[0].price || '?') + ' 币)' : '') + (prev.length ? ' · 其中试看 ' + prev.length : '') + ')──');
    printEps(all, flag);
    if (flag.raw) log('  RAW: ' + JSON.stringify(all).slice(0, 1000));
  },
  async ep() {   // 单集详情(含 paywall 结算上下文)
    if (!arg1) die('用法: ep <contentId>(id 从 eps 取)');
    const d = await call('GET', '/media_content/info', { params: { id: arg1 } });
    log('── 单集详情 id=' + arg1.slice(-6) + ' ──');
    log('  第' + (d.episodeNumber || '?') + '集 ' + mask(d.name, flag.noTitle) + '  ' + fmtDur(d.playTime));
    log('  锁态: ' + (d.isFree ? 'free' : d.canPlay ? 'unlocked' : 'locked(' + (d.accessType || 'coin') + ', ' + (d.price || 0) + ' 币)') + '  hasBuy=' + d.hasBuy + '  hasDramaCard=' + d.hasDramaCard);
    log('  正片票据: ' + (d.videoUrl || '(无——锁定集不签发)'));
    log('  试看票据: ' + (d.previewVideoUrl || d.previewH265Url || '(无)') + (d.previewEnabled ? '(试看' + (d.previewSeconds || 0) + 's@' + (d.previewStart || 0) + 's)' : ''));
    if (d.paywall) log('  paywall: unlockCoin=' + d.paywall.unlockCoin + '  coinBalance=' + d.paywall.coinBalance + '  checkoutContextId=' + d.paywall.checkoutContextId);
    if (d.prev || d.next) log('  相邻: prev=第' + (d.prev && d.prev.episodeNumber) + '集 next=第' + (d.next && d.next.episodeNumber) + '集');
    if (flag.raw) log('\n── RAW ──\n' + JSON.stringify(d, null, 2).slice(0, 2400));
  },
  async dsearch() {   // 剧搜索(kind=4)
    if (!arg1) die('用法: dsearch <关键词> [--page=N] [--size=N] [--sort=N]');
    const d = await call('GET', '/media/search', { params: { keyword: arg1, kind: 4, pageNumber: num('page', 1), pageSize: num('size', 10), sortType: num('sort', 1) } });
    log('── 剧搜索 "' + arg1 + '"(kind=4)──');
    printDramas((d && d.list) || [], flag);
    log('   hasNext=' + !!(d && d.hasNext));
    if (flag.raw) log('  RAW: ' + JSON.stringify((d && d.list) || []).slice(0, 800));
  },
  async dlib() {   // 剧库分类树
    const d = await call('GET', '/media/library');
    log('── 剧库 /media/library ──');
    for (const c of Array.isArray(d) ? d : []) {
      const kinds = (c.kind || []).map(k => k.name).join('、');
      log('   [' + c.key + '] ' + c.name + (kinds ? ' → ' + kinds.slice(0, 60) : ''));
    }
    log('   (POST /media/library/search 空态,筛选参数形态未定)');
  },
  async dtags() {   // 剧标签表
    const d = await call('GET', '/media_tag/list', { params: { pageNumber: num('page', 1), pageSize: num('size', 20) } });
    log('── 剧标签 /media_tag/list(共 ' + ((d && d.total) || '?') + ')──');
    for (const t of (d && d.list) || []) log('   [' + String(t.id).slice(-6) + '] ' + mask(t.name, flag.noTitle) + '  ' + (t.dimension || '?') + '  kind=' + (t.kind || '?'));
  },
  async mybuy() {   // 已购短剧
    const d = await call('GET', '/media/my_buy', { params: { mediaType: 'drama', pageNumber: num('page', 1), pageSize: num('size', 10) } });
    log('── 已购短剧 /media/my_buy(共 ' + ((d && d.total) || 0) + ')──');
    printDramas((d && d.list) || [], flag);
  },
  async shelf() {   // 书架收藏
    const d = await call('GET', '/media_bookshelf/list', { params: { type: 'drama', pageNumber: num('page', 1), pageSize: num('size', 10) } });
    log('── 书架 /media_bookshelf/list(共 ' + ((d && d.total) || 0) + ')──');
    printDramas((d && d.list) || [], flag);
  },
  async dplay() {   // 短剧集播放链全探测(票据来自单集 info;锁定集无票据如实报错)
    if (!arg1) die('用法: dplay <contentId>(id 从 eps/feed 取)');
    const d = await call('GET', '/media_content/info', { params: { id: arg1 } });
    const ticket = d.videoUrl || d.previewVideoUrl || d.previewH265Url || '';
    const label = d.videoUrl ? '正片票据' : (d.previewVideoUrl ? '试看票据(如实标注)' : '');
    log('── 短剧播放链 ep' + (d.episodeNumber || '?') + '《' + mask(d.name, flag.noTitle) + '》──');
    if (!ticket) {
      log('  ✗ 无任何票据:该集为金币锁定(服务端票据签发层完备,页内不可越权)');
      log('     金币/短剧卡解锁后重跑本命令即直读(票据按次随机铸造,现取现用)');
      return;
    }
    const text = await probePlayChain(ticket, label);
    if (flag.out) { fs.writeFileSync(String(flag.out), text); log('  ✓ 清单已落盘 ' + flag.out + '(KEY 已绝对化+IV=0,hls.js/mpv 可直接播)'); }
  },
  async dm3u8() {   // 短剧清单落盘
    if (!arg1) die('用法: dm3u8 <contentId> [--out=文件.m3u8]');
    const d = await call('GET', '/media_content/info', { params: { id: arg1 } });
    const ticket = d.videoUrl || d.previewVideoUrl || d.previewH265Url || '';
    if (!ticket) die('该集无票据(金币锁定,服务端不签发)');
    const m3u8Url = api('/vid/h5/m3u8/' + ticket) + '?token=' + encodeURIComponent(S.token) + '&c=';
    const text = rewriteM3u8(await fetchM3u8(ticket, S.token), m3u8Url);
    if (flag.out) {
      fs.writeFileSync(String(flag.out), text);
      log('✓ ' + String(flag.out) + '(' + (text.match(/^https?:\/\//gm) || []).length + ' 段,KEY 绝对化+IV=0)');
    } else {
      log(text.slice(0, 800));
    }
  },
  async wall() {   // 金币墙探测(只读:锁集统计+单集 paywall+防线结论)
    if (!arg1) die('用法: wall <mediaId>');
    const all = [];
    for (let page = 1; page <= 20; page++) {
      const d = await call('GET', '/media_content/list', { params: { mediaId: arg1, sortType: 0, pageNumber: page, pageSize: 200 } });
      const list = (d && d.list) || [];
      all.push(...list);
      if (!d || !d.hasNext || !list.length) break;
    }
    const locked = all.filter(e => !e.isFree && !e.canPlay);
    log('── 金币墙探测 id=' + arg1.slice(-6) + ' ──');
    log('  选集 ' + all.length + ' 集:可播 ' + (all.length - locked.length) + ' · 锁定 ' + locked.length + (locked.length ? '(每集 ' + (locked[0].price || '?') + ' 币,accessType=' + (locked[0].accessType || 'coin') + ')' : ''));
    if (!locked.length) { log('  ✓ 本剧无金币墙'); return; }
    const info = await call('GET', '/media_content/info', { params: { id: locked[0].id } });
    log('  锁定集样本: 第' + info.episodeNumber + '集 videoUrl=' + (info.videoUrl || '(空)') + '  previewUrl=' + (info.previewVideoUrl || '(空)') + '  h265=' + (info.h265Url || '(空)'));
    if (info.paywall) log('  paywall: ' + JSON.stringify(info.paywall));
    log('  ── 防线结论(2026-10-06 实测)──');
    log('  服务端门禁完备于票据签发层:list/info 对未解锁集一律不下发 videoUrl/h265Url/试看流');
    log('  (ios/android/旧 Terminal XUA 变体与匿名态全同);票据为按次随机铸造的加密定位符');
    log('  (同集两次取票全异,尾部篡改解码指向无关内容不可控);旧 /vid/info 对剧集 id 回空壳;');
    log('  购买 POST /product/buy(productType=19)0 余额干净拒绝 8006。零身份路径不存在——');
    log('  解锁(金币/短剧卡)后 eps/dplay 命令即自动直读解锁集(与站方播放器同链路)。');
  },
  async key() {   // 双密钥端点
    log('── 密钥端点 ──');
    log('  /vid/m3u8sec(全片): ' + await fetchKey('/vid/m3u8sec'));
    log('  /vid/sec(互补): ' + await fetchKey('/vid/sec'));
  },
};

// ============ 6. 主流程 ============

(async () => {
  if (cmd === 'help') { await COMMANDS.help(); process.exitCode = 0; return; }   // help 零网络零登录
  await ensureBase();
  if (cmd !== 'lines') {
    const cached = loadSession();
    await login();
    log('· 线路 ' + S.base.replace(/^https?:\/\//, '') + ' · ' + (cached ? '复用缓存会话' : '游客登录') + ' uid=' + S.uid);
  }
  if (cmd === 'all') {
    // 总览:短剧链(feed → 选集 → 播放链)+ 长视频链(推荐 → 详情 → 播放链),串行防请求风暴
    log('── 总览 ──');
    log('── [短剧] 信息流 ──');
    await COMMANDS.dfeed();
    const df = await call('GET', '/media/drama/feed', { params: { pageSize: 1 } });
    const first = (df && df.list && df.list[0]) || null;   // call 已解包 data
    if (first && first.media && first.content) {
      log('── [短剧] 选集(《' + mask(first.media.title, flag.noTitle) + '》)──');
      await COMMANDS.eps(String(first.media.id));
      const c0 = first.content;
      if (c0.videoUrl) {
        log('── [短剧] 第 1 集播放链 ──');
        await probePlayChain(c0.videoUrl, 'feed 第 1 集正片票据');
      }
    }
    log('── [长视频] 推荐流 ──');
    await COMMANDS.recommend();
    const vl = await call('GET', '/vid/list', { params: { pageNumber: 1, pageSize: 1 } });
    const v0 = (vl && vl.list && vl.list[0]) || null;
    if (v0) {
      log('── [长视频] 首片详情 ──');
      await COMMANDS.video(String(v0.id));
      log('── [长视频] 播放链 ──');
      const info = await call('GET', '/vid/info', { params: { videoID: v0.id } });
      if (info.sourceURL) await probePlayChain(info.sourceURL, '游客态全片,免 UA 硬判');
    }
    log('✔ 总览完成(网关 ' + S.base.replace(/^https?:\/\//, '') + ')');
  } else {
    const fn = COMMANDS[cmd];
    if (!fn) die('未知命令 "' + cmd + '"(可用: ' + Object.keys(COMMANDS).join(' / ') + ')');
    await fn();
  }
  process.exitCode = process.exitCode || 0;   // 不强杀:Node24/win 下 process.exit 会触发 libuv 句柄断言,自然排空
})().catch(e => { if (e.message !== '__DIE__') { console.error('✘ ' + e.message); process.exitCode = 1; } });
