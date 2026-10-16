#!/usr/bin/env node
'use strict';
/**
 * bf_api.js —— bf(Butterfly H5,cloudfront 轮换域站群)视频类只读 API 爬取器(Node.js 版,零依赖,需 Node>=18)
 *
 * 逆向结论(2026-10-06,授权测试环境实测;协议链与 pnk3n_pentest_tool.user.js v6.12.7 bf 段同源互证):
 *   1. 站点为 Vue3 SPA(网页入口 /home 为空壳,#app + /js/main-*.js),数据面全部走
 *      独立 API 网关(cloudfront/自建域轮换,清单写在主 bundle 的 JSON.parse('[…]') 明文里);
 *      本工具直连 API 网关,不依赖网页入口存活;
 *   2. 协议「Butterfly」双层 AES:
 *      - 请求:参数对象 JSON → AES-128-CBC(key=iv=常量 BxJand%xf5h3sycH 的 Latin1 字节)
 *        → base64 → GET 拼在 ?data= 上 / POST 放 {"data":…} 体;
 *      - 响应:{code,hash,data};code==200 且 hash==true 时 data 为密文 base64,
 *        解密:interfaceKey 常量 UTF8 字节 + 密文头 12B 播种 → SHA256 链派生 AES-256-CBC
 *        key/iv(链式三次 digest 拼 32B key/16B iv),interfaceKey 随前端版本轮换→候选制逐把试解;
 *      - 头:X-User-Agent 设备串(BuildID=com.abc.Butterfly;…Terminal=1;IsH5=1)标识 H5 终端,
 *        User-Agent 须 okhttp 系(m3u8 端点硬判,浏览器 UA 被“架空”的付费墙即靠它);
 *   3. 登录态:游客登录 POST /mine/login/h5 {devID(16位随机+毫秒),sysType:ios,android,
 *      cutInfos:'{}',isAppStore:false} → {token,uid};token 经 Authorization 头携带,
 *      失效(code 5009)重登即可,零账号零成本;
 *   4. 列表/发现面(全部实测):首页模块 GET /modules/list → homePage[{id,moduleName,…}];
 *      模块视频 GET /vid/module/{moduleId} {pageNumber,pageSize,moduleSort} → {allVideoInfo,hasNext};
 *      搜索 POST /search/list {keyWords:[词],pageNumber,pageSize,realm:'SP',sortType} → {list,hasNext,tagVidList};
 *      标签视频 GET /tag/vid/list {tagID,pageNumber,pageSize,sortType};标签表 GET /tag/conf/list;
 *      热词 GET /search/hotTag {pageNumber,pageSize} → {list[{id,name,hot}]};
 *      详情 GET /vid/info {videoID} → {sourceURL,previewURL,playTime,cover,tags,…};
 *      相关 GET /vid/recommend/list {vid,pageNumber,pageSize}(注意参数名是 vid 不是 videoID);
 *      排序 sortType:1=最多观看 2=最新发布 3=最多喜欢;
 *   5. 播放链(游客态即全片,站方付费墙按 UA/X-UA 判定已被架空——pnk3n 工具既有结论):
 *      清单 GET /api/app/vid/h5/m3u8/{sourceURL}?token=&c=(须 okhttp UA)→ 完整 AES-128 HLS
 *      (327 段级,EXTINF 真实 4.0s);切片为清单内绝对 URL(注册表 VID 域,?md= 时间戳签名,
 *      ACAO:* + Range 206 全开,浏览器 hls.js 可直连);KEY 行 URI=/api/app/vid/m3u8sec
 *      相对网关根,免鉴权(裸 GET 亦 16B)且 ACAO:*,备用互补端点 /vid/sec;
 *      KEY 行无 IV 属性但站方固定 IV=0(HLS 规范缺省 IV=媒体序号,直接给 hls.js 会解出
 *      垃圾——重写清单时必须显式补 IV=0x000…0);
 *   6. 封面:相对路径 v3/image/…,基座 = 注册表 /ping/domain/h5 的 IMAGE 域(轮换),
 *      ACAO:* octet-stream(实为 JPEG),<img> 可直载;
 *   7. 官方注册表 GET /ping/domain/h5(须 token)→ {sourceList[{type,domain[{url}]}],…}:
 *      GUIDE(导航页)/LAND(下载落地)/TELEGRAM(App 侧频道)/andLink 安卓 APK/iosLink 描述文件;
 *      注意其中【无网页版入口字段】(webJumpLandpage 存在但为空)——运营方已转 APP 分发,
 *      网页入口不公开发布,API 网关清单是目前唯一稳定的程序化入口源。
 *
 * 用法(网关默认 https://d1w3p997s8acw6.cloudfront.net,--base 可换线路;线路自动 ping 优选):
 *   node bf_api.js                          # 总览:线路 → 首页模块 → 模块视频 → 详情 → 播放链探测
 *   node bf_api.js lines                    # API 网关候选 ping 状态
 *   node bf_api.js modules                  # 首页模块清单(id/名称/排序表)
 *   node bf_api.js module <moduleId> [--page=1] [--size=10] [--sort=2]   # 模块内视频
 *   node bf_api.js search 关键词 [--page=1] [--size=10] [--sort=2]       # 搜索(sort 1观看/2最新/3喜欢)
 *   node bf_api.js tags                     # 标签表(id/名称)
 *   node bf_api.js tagvid <tagID> [--page=1] [--size=10] [--sort=2]      # 标签内视频
 *   node bf_api.js hot                      # 热词榜
 *   node bf_api.js video <videoID>          # 视频详情(标题/时长/付费形态/流地址/标签)
 *   node bf_api.js rec <videoID> [--page=1] [--size=6]                   # 相关推荐
 *   node bf_api.js play <videoID>           # 播放链全探测(清单/密钥/切片 Range)
 *   node bf_api.js m3u8 <videoID> [--out=x.m3u8]   # 播放清单落盘(KEY 绝对化+显式 IV=0,hls.js/mpv 可直接播)
 *   node bf_api.js key                      # 双密钥端点探测(m3u8sec/sec)
 *   node bf_api.js registry                 # 官方注册表(导航/下载/频道/APK 链接)
 *   通用旗标:--base=<API网关>  --raw(输出完整 JSON)  --no-title(摘要隐藏标题)  --out=<文件>
 * 退出码:0=成功;1=失败。仅供站方授权测试使用。
 */

// ============ 0. 常量与命令行 ============

const DEFAULT_LINES = [   // API 网关候选(主 bundle JSON.parse 明文 + 实测存活;轮换后 --base 指定)
  'https://d1w3p997s8acw6.cloudfront.net',
  'https://d2m0k739byzwun.cloudfront.net',
  'https://lidhgjxsh3kc.com',
];
const IMG_FALLBACK = 'https://zzzznnn.lkkwip.cn';   // 封面基座兜底(注册表 IMAGE 域轮换,registry 命令可查最新)
const PARAM_KEY = 'BxJand%xf5h3sycH';               // 请求 AES-128-CBC key=iv 常量
const IFACES = ['65dc07d1b7915c6b2937432b091837a7', '0a958fb9ac062420af6ba5f4caad779f']; // interfaceKey 候选(新→旧)
const UA_OKHTTP = 'okhttp/3.12.0';                  // 与站方 App 一致的非浏览器 UA(清单端点硬依赖)
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
const devID = Array.from({ length: 16 }, () => AZ[Math.floor(Math.random() * 62)]).join('') + Date.now();
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

// 游客登录 → token(失效 5009 由 call 自动重登一次)
async function login() {
  const d = await call('POST', '/mine/login/h5', { body: { devID, sysType: 'ios', cutInfos: '{}', isAppStore: false }, noAuth: true });
  S.token = d.token; S.uid = d.uid;
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
  if (j.code === 5009 && !noAuth && S.token) {   // 登录态失效:重登一次原参重放
    S.token = '';
    await login();
    return call(method, path, { params, body });
  }
  throw new Error('API ' + path + ' code=' + j.code + ' ' + (j.msg || j.tip || ''));
}

// ============ 3. 摘要打印 ============

const fmtDur = (s) => s == null ? '?' : Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
const mask = (t, on) => on ? '<标题已隐藏>' : String(t == null ? '' : t).slice(0, 42);

// 视频项(allVideoInfo/list 元素同构)摘要行
function printItems(list, opt) {
  if (!list || !list.length) { log('  (无结果)'); return; }
  for (const v of list) {
    const tags = [v.coins ? '金币' + +v.coins : 'free', v.freeTime ? '试' + +v.freeTime + 's' : ''].filter(Boolean).join('/');
    log('   [' + String(v.id).slice(-6) + '] ' + fmtDur(v.playTime).padStart(7) + ' ' + tags.padEnd(11) + ' ' + mask(v.title, opt.noTitle));
  }
}
const normList = (d) => (d && Array.isArray(d.list) ? d.list : Array.isArray(d) ? d : (d && Array.isArray(d.allVideoInfo) ? d.allVideoInfo : []));

// ============ 4. 播放链 ============

// 清单文本(okhttp UA 硬依赖):?token= 携带游客态
async function fetchM3u8(src, token) {
  const url = api('/vid/h5/m3u8/' + src) + '?token=' + encodeURIComponent(token) + '&c=';
  const r = await fetch(url, { headers: { 'User-Agent': UA_OKHTTP, 'X-User-Agent': xua(), 'temp': 'test' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const t = await r.text();
  if (!t.startsWith('#EXTM3U')) throw new Error('m3u8 被拦(HTTP ' + r.status + ' ' + t.slice(0, 50) + ')');
  return t;
}

// 清单重写:KEY 行 URI 绝对化 + 显式 IV=0(站方固定零 IV;缺省按规范会用媒体序号解出垃圾),
// 切片本就是绝对 URL 原样保留——产物 hls.js/mpv 可直接播
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

// ============ 5. 命令表 ============

const COMMANDS = {
  async lines() {   // 网关候选 ping 状态
    log('── API 网关候选 ──');
    const rs = await Promise.all(DEFAULT_LINES.map(ping));
    DEFAULT_LINES.forEach((b, i) => log('   ' + (rs[i] ? '✓' : '✗') + ' ' + b.replace(/^https?:\/\//, '')));
    if (rs.every(x => !x)) die('全部不可达——线路已轮换(从新 bundle 的 JSON.parse 候选表提取)');
  },
  async modules() {   // 首页模块
    const d = await call('GET', '/modules/list');
    const hp = (d && d.homePage) || [];
    log('── 首页模块 /modules/list(' + hp.length + ')──');
    for (const m of hp) log('   [' + m.id + '] ' + (m.moduleName || '?') + '  sortList=' + JSON.stringify(m.haiJiaoStyle && m.haiJiaoStyle.sortList || []));
  },
  async module() {   // 模块内视频
    if (!arg1) die('用法: module <moduleId> [--page=N] [--size=N] [--sort=N]');
    const d = await call('GET', '/vid/module/' + arg1, { params: { pageNumber: num('page', 1), pageSize: num('size', 10), moduleSort: num('sort', 1) } });
    log('── 模块视频 ' + arg1.slice(-6) + ' ──');
    printItems(normList(d), flag);
    log('   hasNext=' + !!(d && d.hasNext));
    if (flag.raw) log('  RAW: ' + JSON.stringify(d).slice(0, 600));
  },
  async search() {   // 搜索(排序 1观看/2最新/3喜欢)
    if (!arg1) die('用法: search <关键词> [--page=N] [--size=N] [--sort=N]');
    const d = await call('POST', '/search/list', { body: { keyWords: [arg1], pageNumber: num('page', 1), pageSize: num('size', 10), realm: 'SP', sortType: num('sort', 2) } });
    log('── 搜索 "' + arg1 + '"(sort=' + num('sort', 2) + ')──');
    printItems(normList(d), flag);
    log('   hasNext=' + !!(d && d.hasNext) + (d && d.tagVidList && d.tagVidList.length ? '  tag命中:' + d.tagVidList.length + '(tagID=' + d.tagID + ')' : ''));
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
    printItems(normList(d), flag);
    log('   hasNext=' + !!(d && d.hasNext));
  },
  async hot() {   // 热词榜
    const d = await call('GET', '/search/hotTag', { params: { pageNumber: 1, pageSize: 20 } });
    const list = (d && d.list) || [];
    log('── 热词榜 /search/hotTag ──');
    if (!list.length) return log('  (空)');
    for (const h of list) log('   ' + mask(h.name, flag.noTitle) + '  hot=' + h.hot);
  },
  async video() {   // 视频详情
    if (!arg1) die('用法: video <videoID>');
    const d = await call('GET', '/vid/info', { params: { videoID: arg1 } });
    log('── 视频详情 id=' + arg1.slice(-6) + ' ──');
    log('  title: ' + mask(d.title, flag.noTitle));
    log('  duration: ' + fmtDur(d.playTime) + '  createdAt: ' + (d.createdAt || '').slice(0, 19));
    log('  付费形态: ' + (+d.coins ? '金币' + +d.coins + (d.freeTime ? '(试看' + +d.freeTime + 's)' : '') : 'free'));
    log('  正片路径: ' + (d.sourceURL || '(无)'));
    log('  试看路径: ' + (d.previewURL || '(无)'));
    log('  封面: ' + IMG_FALLBACK.replace(/^https?:\/\//, '') + '/…' + String(d.cover || '').slice(-24));
    log('  标签: ' + ((d.tags || []).map(t => t.tagName || t.name || t).join('、') || '(无)').slice(0, 90));
    if (flag.raw) log('\n── RAW ──\n' + JSON.stringify(d, null, 2).slice(0, 2000));
  },
  async rec() {   // 相关推荐
    if (!arg1) die('用法: rec <videoID> [--page=N] [--size=N]');
    const d = await call('GET', '/vid/recommend/list', { params: { vid: arg1, pageNumber: num('page', 1), pageSize: num('size', 6) } });
    log('── 相关推荐 id=' + arg1.slice(-6) + ' ──');
    printItems(normList(d), flag);
    log('   hasNext=' + !!(d && d.hasNext));
  },
  async play() {   // 播放链全探测
    if (!arg1) die('用法: play <videoID>');
    const info = await call('GET', '/vid/info', { params: { videoID: arg1 } });
    if (!info.sourceURL) die('该视频无 sourceURL(可能已删)');
    log('── 播放链 id=' + arg1.slice(-6) + '《' + mask(info.title, flag.noTitle) + '》──');
    const token = S.token;
    const raw = await fetchM3u8(info.sourceURL, token);
    const m3u8Url = api('/vid/h5/m3u8/' + info.sourceURL) + '?token=' + encodeURIComponent(token) + '&c=';
    const text = rewriteM3u8(raw, m3u8Url);
    const segs = (text.match(/^https?:\/\//gm) || []).length;
    const dur = text.split('\n').filter(l => l.startsWith('#EXTINF')).reduce((a, l) => a + parseFloat(l.slice(8)) || 0, 0);
    log('  ① 清单(okhttp UA):✓ ' + segs + ' 段,总时长 ~' + fmtDur(Math.round(dur)));
    const keyLine = text.split('\n').find(l => l.startsWith('#EXT-X-KEY')) || '';
    log('  ② KEY 行: ' + keyLine.slice(0, 110));
    const ku = (keyLine.match(/URI="([^"]+)"/) || [])[1];
    if (ku) log('  ③ 密钥(免鉴权): ' + await fetchKey(ku));
    log('  ④ 备用钥 /vid/sec: ' + await fetchKey('/vid/sec'));
    const seg = text.split('\n').find(l => l && !l.startsWith('#'));
    const rs = await fetch(seg, { headers: { 'User-Agent': UA_OKHTTP, 'Range': 'bytes=0-187' } });
    const head = new Uint8Array(await rs.arrayBuffer());
    log('  ⑤ 首段 Range: ' + rs.status + ' ' + head.byteLength + 'B ACAO=' + (rs.headers.get('access-control-allow-origin') || '-') + '(AES 密文,同步字节无意义)');
    if (flag.out) { fs.writeFileSync(String(flag.out), text); log('  ✓ 清单已落盘 ' + flag.out + '(KEY 已绝对化+IV=0,hls.js/mpv 可直接播)'); }
  },
  async m3u8() {   // 清单落盘(等价 play --out,轻量直出)
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
  async key() {   // 双密钥端点
    log('── 密钥端点 ──');
    log('  /vid/m3u8sec(全片): ' + await fetchKey('/vid/m3u8sec'));
    log('  /vid/sec(互补): ' + await fetchKey('/vid/sec'));
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
    log('   (webJumpLandpage 为空=网页入口未发布,运营方现走 APP 分发)');
  },
};

// ============ 6. 主流程 ============

(async () => {
  await ensureBase();
  if (cmd !== 'lines') {
    await login();
    log('· 线路 ' + S.base.replace(/^https?:\/\//, '') + ' · 游客 uid=' + S.uid);
  }
  if (cmd === 'all') {
    // 总览:模块 → 模块视频 → 首片详情 → 播放链(串行,防请求风暴)
    log('── 总览 ──');
    await COMMANDS.modules();
    const d = await call('GET', '/modules/list');
    const first = ((d && d.homePage) || [])[0];
    if (first) {
      const md = await call('GET', '/vid/module/' + first.id, { params: { pageNumber: 1, pageSize: 3, moduleSort: 1 } });
      log('── 模块「' + (first.moduleName || '?') + '」首屏 ──');
      printItems(normList(md), flag);
      const v0 = normList(md)[0];
      if (v0) {
        const info = await call('GET', '/vid/info', { params: { videoID: v0.id } });
        log('── 首片[' + String(v0.id).slice(-6) + ']播放链 ──');
        const raw = await fetchM3u8(info.sourceURL, S.token);
        const m3u8Url = api('/vid/h5/m3u8/' + info.sourceURL) + '?token=' + encodeURIComponent(S.token) + '&c=';
        const text = rewriteM3u8(raw, m3u8Url);
        log('  清单 ✓ ' + (text.match(/^https?:\/\//gm) || []).length + ' 段;密钥 ' + await fetchKey('/vid/m3u8sec'));
      }
    }
    log('✔ 总览完成(网关 ' + S.base.replace(/^https?:\/\//, '') + ')');
  } else {
    const fn = COMMANDS[cmd];
    if (!fn) die('未知命令 "' + cmd + '"(可用: ' + Object.keys(COMMANDS).join(' / ') + ')');
    await fn();
  }
  process.exitCode = process.exitCode || 0;   // 不强杀:Node24/win 下 process.exit 会触发 libuv 句柄断言,自然排空
})().catch(e => { if (e.message !== '__DIE__') { console.error('✘ ' + e.message); process.exitCode = 1; } });
