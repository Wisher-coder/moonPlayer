#!/usr/bin/env node
'use strict';
/**
 * hanxiucao_api.js —— 含羞草(fi11)视频站视频类只读 API 爬取器(Node.js 版,零依赖,需 Node>=18)
 *
 * 逆向结论(2026-10-06,授权测试环境实测):
 *   1. 前端为 Vue3+Vite SPA(主包 index.e7f809e2.js 经 javascript-obfuscator 混淆),
 *      API 走独立网关域(静态资源另走 nasuiyile.com),网关池硬编码在主包
 *      VITE_APP_SERVER_ADDRESS:'https://a83k.aqx84.com,https://a48j.jot4v.com',
 *      网关轮换时需回主包重提(见 .work/deob_fi11.js 提取器);
 *   2. 全部 POST,请求体整体加密:{endata:加密参数,ents:加密时间戳},响应明文
 *      {code:0,msg,data,traceId}。AES-256-CBC/Pkcs7,key=iv 同串
 *      'B77A9FF7F323B5404902102257503C2F'(Utf8 传入,IV 取前 16 字节,CryptoJS 宽容
 *      超长 IV 的行为);同样密钥亦用于 .aes 后缀图片解密(图片走 ECB,不在本脚本范围);
 *   3. ents=加密(本地秒+时区偏移+服务器偏移),启动先调 /base/getTimeStamp 校准,
 *      未校准直接发本地秒会报 code 607「非法请求」;
 *   4. 游客请求头固定:Did:1 / source:1 / isShortChain:''(无需 Auth;评论等
 *      /user/ 前缀接口需登录,code 700,本脚本只收游客可读部分);
 *   5. 参数名为 key 而非 keyword(globalSearch/associationalWord),搜索须带 type:1;
 *      分页字段 page/length(推荐接口 page 从 0 起,列表从 1 起)。
 *
 * 服务端对应实现(2026-10-09,按 AGENTS.md 溯源规则注明):MoontentRN/server/
 *   src/plugins/hanxiucao.js 已上线网关自动发现——发布页入口(www.fi11.xyz)→
 *   中转页 copy-btn 最新前端域 → 前端主包提取网关池 → getTimeStamp 逐个验活,
 *   由 server/src/plugins/domain-refresh.js 统一调度(5 分钟周期轮 + 请求失败
 *   urgent 触发,单站 60s 冷却);服务端网关来源优先级:HXC_GATEWAY 环境变量 >
 *   自动发现池 > 内置双网关兜底。本 CLI 仍为静态内置双网关 + --gw 手动指定
 *   (取证工具定位,不做自动发现);网关轮换后优先看服务端自动发现结果,本 CLI
 *   按 --gw 显式指定对照,两份实现各自维护、协议层修 bug 时需双向同步。
 *
 * 端点清单(只读部分,全部实测通过;buy/collect/like 等写操作刻意不实现):
 *   /base/getTimeStamp        服务器时间(ents 校准基准)
 *   /base/getApiVersion       版本号(前端据此清本地缓存)
 *   /base/getConfigPub        公共配置 {key}
 *   /base/hotWord             热词榜(固定词表)
 *   /base/hotWordDefault      搜索框占位词
 *   /base/associationalWord   搜索联想词 {key,videoSort}
 *   /base/globalSearch        全局搜索 {key,videoSort,page,length,type:1=视频}
 *   /panel/list               栏目面板列表(首页/四大栏目布局)
 *   /panel/get                面板详情 {panelId}(栏目页布局,含专题/合集 id 列表)
 *   /videos/getList           视频列表 {page,length,orderType[,typeId][,subjectId][,offset]}
 *       orderType:1=最新 4=最热(播放量);2/3 为站内其他排序,语义未标注
 *   /videos/getInfo           视频详情 {videoSort,videoId}(canPlay/价格/tags/分类/统计)
 *   /videos/v2/getUrl         播放地址 {videoId}(canPlay=true 的视频返回 m3u8+sign;
 *       HLS-VOD,ts 切片另有标准 #EXT-X-KEY AES-128 层,hls.js 播放时自动处理)
 *   /videos/getPreUrl         试看地址 {videoId}(零鉴权:无/伪造 Auth 一律放行;
 *       签名只校验 start/end 存在、不校验其值,窗口改写 start=0&end=99999
 *       重放即得全片清单——2026-10-06 #7024 复测:VIP 专享片该口空串即真无入口)
 *   [CDN 签名缺陷实测 2026-10-06] sign 亦不绑路径:任一视频有效 sign 搬到另一
 *       视频清单路径照样放行(#18796 签→#78414 路径,回真实 567 段);但对
 *       「路径从未签发」的片无效——媒体路径随机段(/read/{日期}/{8位随机}/,
 *       /vc/{目录}/{4位随机}.m3u8)不可枚举(62^8/62^4)、CDN 目录列表 404、
 *       rand 无哈希规律、全序列化器(search/recommend/package/getInfo 全字段)
 *       均不泄露媒体引用——#7024(2019 老片,VIP 专享+试看全关+全邻域同形态)
 *       游客侧渗透面收口,唯 HXC_TOKEN/--token 有权限账号直读一路。
 *   /videos/getRecommendListByVideoId  相关推荐 {videoId,page(从0起),length}
 *   /subject/get              专题详情 {id}(专题内视频用 getList 带 subjectId)
 *   /videoPackage/getList     量贩视频集列表 {page,length,orderType}
 *   /gather/getListByVideoId  视频所在合集 {videoId}
 *   /home/getAds              广告位 {type}(4=播放页,14/15=其他位)
 *   /home/getDefaultGraph     默认占位图映射
 *   /vip/getIndex             VIP 档位信息
 *   /visitor/add              游客注册拿 visitorId(deviceType:5 为 Web)
 *
 * 用法(网关默认内置双线,轮换后 --gw=https://xxx 指定):
 *   node hanxiucao_api.js                     # 全端点总览(逐个跑,输出摘要)
 *   node hanxiucao_api.js hotwords            # 热词榜
 *   node hanxiucao_api.js suggest 御姐        # 搜索联想词
 *   node hanxiucao_api.js search 御姐 --page=1 --size=10
 *   node hanxiucao_api.js list --page=2 --size=20 --order=4 --type=5 --subject=62
 *   node hanxiucao_api.js panels              # 栏目面板
 *   node hanxiucao_api.js panel 209           # 面板详情
 *   node hanxiucao_api.js detail 78415        # 视频详情(--video-sort=1 可覆盖)
 *   node hanxiucao_api.js play 78415          # 取播放地址:①v2/getUrl 直取 →
 *       ②getPreUrl 试看签名窗口改写(start=0&end=99999)取全片清单(游客态主链)
 *   node hanxiucao_api.js related 78415       # 相关推荐(--page 从 0 起)
 *   node hanxiucao_api.js subject 62          # 专题详情(内含视频用 list --subject=62)
 *   node hanxiucao_api.js packages --page=1   # 量贩视频集
 *   node hanxiucao_api.js gather 65756        # 视频所在合集
 *   node hanxiucao_api.js ads 4               # 广告位
 *   通用旗标:--gw=https://a83k.aqx84.com(指定网关,优先于内置)
 *           --token=eyJhbGciOi...(登录态 Auth 头;VIP 专享片 play 直读用,
 *             fi11.com 登录后 localStorage token 原样抄入,带不带引号均可)
 *           --raw(输出完整 JSON)  --no-title(摘要隐藏标题,便于留档)
 * 退出码:0=成功;1=失败。仅供站方授权测试使用。
 */

// ============ 0. 常量与命令行 ============

// API 网关池(2026-10-06 提取自主包 VITE_APP_SERVER_ADDRESS;轮换后 --gw 指定或重提)
const GATEWAYS = ['https://a83k.aqx84.com', 'https://a48j.jot4v.com'];
const AES_KEY = Buffer.from('B77A9FF7F323B5404902102257503C2F', 'utf8'); // 32B → AES-256
const AES_IV = Buffer.from('B77A9FF7F323B5404902102257503C2F'.slice(0, 16), 'utf8'); // CryptoJS 只用 IV 前 16B
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;

const argv = process.argv.slice(2);
const flag = {};
for (const a of argv) {
  const m = a.match(/^--([a-z][a-z_-]*)(?:=(.*))?$/); // 支持 --no-title / --video-sort 这类旗标
  if (m) flag[m[1]] = m[2] !== undefined ? m[2] : true;
}
const positional = argv.filter(a => !a.startsWith('--'));
flag.noTitle = flag['no-title'];               // 连字符别名
flag.videoSort = flag['video-sort'] !== undefined ? flag['video-sort'] : flag.videoSort;
const cmd = positional[0] || 'all';
const arg1 = positional[1];
const num = (k, d) => (flag[k] !== undefined ? parseInt(flag[k], 10) : d);

const log = (...a) => console.log(...a);
// 不用 process.exit:Node24/win 下强杀会触发 libuv 句柄断言(keep-alive 连接未关),设码后自然排空
const die = (msg) => { console.error('✘ ' + msg); process.exitCode = 1; throw new Error('__EXIT__'); };

// ============ 1. 加密层(与主包 ve()/Me() 逐字节对齐,已用真实抓包双向验证) ============

function ve(plain) { // AES-256-CBC/Pkcs7 → base64(请求体/时间戳共用)
  const c = require('crypto').createCipheriv('aes-256-cbc', AES_KEY, AES_IV);
  return Buffer.concat([c.update(Buffer.from(String(plain), 'utf8')), c.final()]).toString('base64');
}

function Me(obj) { // 主包预处理:删除值为 ''/null/undefined 的键(空参不发包)
  const empty = ['', null, undefined];
  for (const k in obj) if (empty.includes(obj[k])) delete obj[k];
  return obj;
}

// ents 帧换算:本地秒+时区偏移(分钟→秒)+服务器偏移;偏移由 getTimeStamp 启动校准
const tzSec = new Date().getTimezoneOffset() * 60;
let srvOffset = 0; // 服务器与本帧的残差(秒),校准前为 0(getTimeStamp 本身校验宽松)
const entsNow = () => ve(parseInt(Date.now() / 1000) + tzSec + srvOffset);

// ============ 2. API 客户端(POST→{endata,ents},失败换下一网关) ============

async function apiPost(gateway, path, payload) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('超时')), TIMEOUT_MS);
  // 登录态(可选):--token 旗标 → 主包拦截器同款 Auth 头(VIP 专享片 v2/getUrl 直读)
  const token = flag.token ? String(flag.token).trim().replace(/^["']+|["']+$/g, '') : '';
  try {
    const res = await fetch(gateway + path, {
      method: 'POST', signal: ac.signal,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Accept': 'application/json, text/plain, */*',
        'Did': '1', 'source': '1', 'isShortChain': '', // 游客固定头(逆向自主包拦截器)
        ...(token ? { Auth: token } : {}),
        'User-Agent': UA,
      },
      body: JSON.stringify({ endata: ve(JSON.stringify(Me(payload))), ents: entsNow() }),
    });
    if (res.status >= 400) throw new Error('HTTP ' + res.status + ' @' + gateway);
    const j = await res.json();
    if (j.code !== 0) throw new Error('接口报错 code=' + j.code + ' msg=' + (j.msg || '') + ' @' + path);
    return j.data;
  } finally { clearTimeout(timer); }
}

async function apiImpl(path, payload) {
  const gws = flag.gw ? [String(flag.gw).replace(/\/+$/, '')] : GATEWAYS;
  let lastErr = null;
  for (const gw of gws) {
    try { return await apiPost(gw, path, payload); }
    catch (e) {
      if (/接口报错/.test(e.message)) throw e; // 业务错误换网关无意义
      lastErr = e;
    }
  }
  throw lastErr || new Error('全部网关不可达');
}

let lastData = null; // 最近一次成功响应(--raw 输出用)
async function api(path, payload) { lastData = await apiImpl(path, payload); return lastData; }

// 启动校准:getTimeStamp 拿服务器帧,算残差(服务器时钟本身即 UTC 帧)
async function syncTime() {
  const d = await api('/base/getTimeStamp', {});
  if (d && d.timeStamp) {
    srvOffset = d.timeStamp - (parseInt(Date.now() / 1000) + tzSec);
    log('· 时间校准: 服务器 ' + d.timeStamp + '(偏移 ' + srvOffset + 's)');
  }
}

// ============ 3. 摘要打印 ============

const fmtDur = s => s == null ? '?' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
const mask = (t, on) => on ? '<标题已隐藏>' : String(t == null ? '' : t).slice(0, 42);

// 列表形态:{count,list:[...]}(getList)或 {count,infos:[...]}(globalSearch)
function printVideoList(x, opt = {}, listKey = 'list') {
  const arr = x && (x[listKey] || x.infos);
  if (!Array.isArray(arr)) { log('  (无 ' + listKey + ' 数组)'); return null; }
  if (x.count !== undefined) log('  共 ' + x.count + ' 条,本页 ' + arr.length + ' 条');
  else log('  共 ' + arr.length + ' 条');
  for (const v of arr) log('   [' + v.id + '] ' + fmtDur(v.length) + ' ' + mask(v.name, opt.noTitle));
  return arr;
}

// ============ 4. 命令表 ============

const COMMANDS = {
  async hotwords() { // 热词榜(站方固定词表,与输入无关)
    const x = await api('/base/hotWord', {});
    log('── 热词榜 hotWord ──');
    log('  ' + ((x.word || []).join(' , ')));
  },
  async suggest(a) { // 搜索联想词(参数名是 key)
    const kw = a !== undefined ? a : arg1;
    if (!kw) die('用法: suggest <关键词>');
    const x = await api('/base/associationalWord', { key: kw, videoSort: num('videoSort', 1) });
    log('── 联想词 associationalWord "' + kw + '" ──');
    log('  ' + ((x.word || []).join(' , ') || '(无联想)'));
  },
  async search(a) { // 全局搜索(type:1=视频;参数名是 key,传 keyword 会被忽略)
    const kw = a !== undefined ? a : arg1;
    if (!kw) die('用法: search <关键词> [--page=N] [--size=N]');
    const x = await api('/base/globalSearch', {
      key: kw, videoSort: num('videoSort', 1), type: 1,
      page: num('page', 1), length: num('size', 10),
    });
    log('── 搜索 "' + kw + '" ──');
    printVideoList(x, flag, 'infos');
  },
  async panels() { // 栏目面板(panel/list 实测返回空,回退逐个验证导航四面板;panelId 来自导航实测)
    const x = await api('/panel/list', {});
    let arr = (x && x.list) || [];
    if (!arr.length) {
      log('· panel/list 返回空,回退枚举导航面板(panel/get)');
      arr = [];
      for (const pid of [209, 173, 220, 172]) { // 专题/传媒/量贩/合集(2026-10-06 导航实测)
        try { const p = await api('/panel/get', { panelId: pid }); if (p && p.info) arr.push(p.info); } catch (e) { /* 换面板 */ }
      }
    }
    log('── 面板列表 ── 共 ' + arr.length + ' 个');
    for (const p of arr) log('   [' + p.panelId + '] ' + p.panelName + (p.isDefault ? ' (默认)' : ''));
  },
  async panel(a) { // 面板详情(布局内含专题 id 列表/合集 id 列表,供 subject/gather 深入)
    const pid = a !== undefined ? a : arg1;
    if (!pid) die('用法: panel <panelId>');
    const x = await api('/panel/get', { panelId: parseInt(pid, 10) });
    const info = x.info || x;
    log('── 面板详情 panel/get panelId=' + pid + ' ──');
    log('  ' + (info.panelName || '') + ' 布局 ' + ((info.Layouts || []).length) + ' 块');
    for (const l of info.Layouts || []) log('   [' + l.layoutId + '] ' + l.layoutName + ' (' + l.layoutCode + ')');
  },
  async list() { // 视频列表(可按分类/专题/排序/分页;orderType 1=最新 4=最热)
    // 专题模式(subjectId)实测必带 offset:0 且站方用 orderType:8,缺失报「参数类型错误: subjectId」
    const subjectMode = flag.subject !== undefined;
    const x = await api('/videos/getList', {
      page: num('page', 1), length: num('size', 20),
      orderType: num('order', subjectMode ? 8 : 1),
      typeId: flag.type !== undefined ? parseInt(flag.type, 10) : undefined,       // 服务端严格校验数字类型
      subjectId: flag.subject !== undefined ? parseInt(flag.subject, 10) : undefined,
      offset: subjectMode ? num('offset', 0) : flag.offset,
    });
    log('── 视频列表 getList' + (flag.type ? ' typeId=' + flag.type : '') + (flag.subject ? ' subjectId=' + flag.subject : '') + ' order=' + num('order', subjectMode ? 8 : 1) + ' ──');
    printVideoList(x, flag);
  },
  async detail(a) { // 视频详情(标签/分类/价格/统计;url/preUrl 仅 canPlay 视频非空)
    const vid = a !== undefined ? a : arg1;
    if (!vid) die('用法: detail <视频ID> [--video-sort=1]');
    const x = await api('/videos/getInfo', { videoSort: num('videoSort', 1), videoId: parseInt(vid, 10) });
    log('── 视频详情 id=' + vid + ' ──');
    log('  canPlay=' + x.canPlay + ' canPrePlay=' + x.canPrePlay + ' point=' + (x.info && x.info.point) + '(折后' + x.discountPoint + ') download=' + x.downloadPoint);
    const i = x.info || {};
    log('  name: ' + mask(i.name, flag.noTitle));
    log('  分类: ' + i.typeName + '(typeId=' + i.typeId + ')  时长: ' + fmtDur(i.length) + '  编号: ' + i.no);
    log('  播放/收藏/点赞: ' + i.seeCount + ' / ' + i.collectionCount + ' / ' + i.likeCount);
    if (i.tags) log('  标签: ' + String(i.tags).slice(0, 80));
    if (i.subjectInfos && i.subjectInfos.length) log('  所属专题: ' + i.subjectInfos.map(s => '[' + s.id + ']' + s.name).join(' , '));
    if (i.url) log('  url: ' + i.url);
  },
  async play(a) { // 播放链三级(与 NextWeb 插件 resolvePlay 同源):
    // ① v2/getUrl 正片直取(游客 canPlay / --token 有权限账号)
    // ② getPreUrl 试看签名(零鉴权)窗口改写 start=0&end=99999 → 全片清单
    // ③ 全败 getInfo 诊断(VIP 专享/金币片/需登录;实测 #7024 即此形态)
    const vid = a !== undefined ? a : arg1;
    if (!vid) die('用法: play <视频ID> [--token=登录态token]');
    let url = '', authStale = false, lvl = '';
    try {
      const x = await api('/videos/v2/getUrl', { videoId: parseInt(vid, 10) });
      url = x.url || '';
      if (url) lvl = '① v2/getUrl 正片直取';
    } catch (e) {
      if (/code=700/.test(e.message)) authStale = true;   // token 失效:降级走②级
      else if (!/code=200[23]/.test(e.message)) throw e;  // 其余业务错直接抛;2002/2003 落②级
    }
    if (!url) {
      const p = await api('/videos/getPreUrl', { videoId: parseInt(vid, 10) });
      url = (p && p.url) || '';
      if (url) lvl = '② getPreUrl 试看签名窗口改写';
    }
    if (!url) {
      let why = '服务端未签发试看地址';
      try {
        const d = await api('/videos/getInfo', { videoSort: 1, videoId: parseInt(vid, 10) });
        const i = (d && d.info) || {};
        const bits = [];
        if (i.isVip === 1) bits.push('VIP 专享');
        if (Number(i.point) > 0) bits.push('金币片 ' + i.point + ' 点');
        if (i.isNeedLogin === 1) bits.push('需登录');
        if (bits.length) why = bits.join(' + ') + ',' + why;
      } catch (e) { /* 诊断探针失败(token 失效时 getInfo 亦 700):沿用默认表述 */ }
      die('无可用播放地址(' + why + (authStale ? ';--token 已失效(登录态过期)'
        : flag.token ? ';当前 token 无此片权限' : ';可 --token=VIP账号token 直读重试') + ')');
    }
    log('── 播放地址 id=' + vid + ' ── ' + lvl);
    // master 剥壳:逐级取最高分辨率变体(变体行可能裸名,须继承 master 的
    // sign/rSign/start/end),到媒体清单层改宽试看窗口,复核全片清单
    const widenWin = (u) => u.replace(/([?&])start=\d+/, '$1start=0').replace(/([?&])end=\d+/, '$1end=99999');
    let cur = url;
    for (let hop = 0; hop < 2; hop++) {
      const res = await fetch(cur, { headers: { 'User-Agent': UA } });
      const text = await res.text();
      if (!text.trimStart().startsWith('#EXTM3U')) die('清单不可用(HTTP ' + res.status + ':' + text.slice(0, 60).replace(/\n/g, ' ') + ')');
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      let best = null;
      for (let k = 0; k < lines.length; k++) {
        if (!lines[k].startsWith('#EXT-X-STREAM-INF')) continue;
        const rel = lines[k + 1];
        if (!rel || rel.startsWith('#')) continue;
        const h = Number((lines[k].match(/RESOLUTION=\d+x(\d+)/) || [])[1]) || 0;
        let vu;
        try { vu = new URL(rel, cur).href; } catch (e) { continue; }
        if (!/[?&](sign|rSign)=/.test(vu) && /[?&](sign|rSign)=/.test(cur)) {
          const vp = new URL(vu).searchParams, mp = new URL(cur).searchParams;
          for (const kk of ['sign', 'rSign', 'start', 'end']) { const vv = mp.get(kk); if (vv != null && !vp.has(kk)) vp.set(kk, vv); }
          vu = vu.split('?')[0] + '?' + vp.toString();
        }
        if (!best || h > best.h) best = { h, url: vu };
      }
      if (!best) break; // 已是媒体清单:就地改宽
      cur = best.url;
    }
    const widened = widenWin(cur);
    const wres = await fetch(widened, { headers: { 'User-Agent': UA } });
    const wtext = await wres.text();
    if (!wtext.trimStart().startsWith('#EXTM3U')) die('全片清单(窗口改写)不可用(HTTP ' + wres.status + ':' + wtext.slice(0, 60).replace(/\n/g, ' ') + ')——站点可能已收紧窗口校验');
    log('  ' + widened);
    log('  ✓ 全片清单 ' + (wtext.match(/#EXTINF/g) || []).length + ' 段'
      + (wtext.includes('#EXT-X-KEY') ? ',AES-128(hls.js 原生解密)' : ',未加密'));
  },
  async related(a) { // 相关推荐(page 从 0 起,与其他列表从 1 起不同)
    const vid = a !== undefined ? a : arg1;
    if (!vid) die('用法: related <视频ID> [--page=0] [--size=10]');
    const x = await api('/videos/getRecommendListByVideoId', {
      videoId: parseInt(vid, 10), page: num('page', 0), length: num('size', 10),
    });
    log('── 相关推荐 getRecommendListByVideoId id=' + vid + ' ──');
    printVideoList(x, flag, 'info');
  },
  async subject(a) { // 专题详情(专题内视频: list --subject=<id>)
    const sid = a !== undefined ? a : arg1;
    if (!sid) die('用法: subject <专题ID>');
    const x = await api('/subject/get', { id: parseInt(sid, 10) });
    const i = x.info || x;
    log('── 专题详情 subject/get id=' + sid + ' ──');
    log('  name: ' + mask(i.name, flag.noTitle));
    log('  热度: ' + i.hotCount + '  描述: ' + String(i.description || '').slice(0, 50));
    log('  (专题内视频: node hanxiucao_api.js list --subject=' + sid + ')');
  },
  async packages() { // 量贩视频集(按集购买的视频包)
    const x = await api('/videoPackage/getList', { page: num('page', 1), length: num('size', 20), orderType: num('order', 1) });
    const arr = (x && x.list) || [];
    log('── 量贩视频集 videoPackage/getList ──');
    if (x.count !== undefined) log('  共 ' + x.count + ' 条,本页 ' + arr.length + ' 条');
    for (const p of arr) log('   [' + p.videoPackageId + '] ' + mask(p.name, flag.noTitle) + '  ' + p.videoCount + '部/' + p.discountPoint + '点 已购' + p.buyCount);
  },
  async gather(a) { // 视频所在合集
    const vid = a !== undefined ? a : arg1;
    if (!vid) die('用法: gather <视频ID>');
    const x = await api('/gather/getListByVideoId', { videoId: parseInt(vid, 10) });
    const arr = (x && x.list) || [];
    log('── 视频合集 gather/getListByVideoId id=' + vid + ' ──');
    if (!arr.length) log('  (该视频未收录进任何合集)');
    for (const g of arr) log('   [' + (g.gatherId || g.id) + '] ' + mask(g.name, flag.noTitle));
  },
  async ads(a) { // 广告位(4=播放页,14/15=其他位)
    const t = a !== undefined ? a : arg1;
    if (!t) die('用法: ads <type>');
    const x = await api('/home/getAds', { type: parseInt(t, 10) });
    const arr = (x && x.list) || [];
    log('── 广告位 getAds type=' + t + ' ── 共 ' + arr.length + ' 条');
    for (const ad of arr) log('   [' + ad.id + '] ' + ad.name + ' → ' + ad.url);
  },
};

// ============ 5. 主流程 ============

(async () => {
  log('含羞草(fi11)视频 API 爬取器(v1.0.0,网关: ' + (flag.gw || GATEWAYS.join(' / ')) + ')');
  await syncTime(); // ents 校准(607「非法请求」的根源就是未校准)

  if (cmd === 'all') {
    // 总览:逐端点跑一遍(串行,防请求风暴),取列表第一条的 id 供 detail/play 深入
    await COMMANDS.hotwords();
    await COMMANDS.suggest('御姐');
    await COMMANDS.search('御姐');
    const x = await api('/videos/getList', { page: 1, length: 5, orderType: 1 });
    log('── 视频列表 getList(最新前5) ──');
    const arr = printVideoList(x, flag) || [];
    const firstId = (arr[0] && arr[0].id) || num('id', 0);
    await COMMANDS.detail(firstId);
    await COMMANDS.play(firstId);
    await COMMANDS.related(firstId);
    await COMMANDS.panels();
    await COMMANDS.subject(62);
    await COMMANDS.packages();
    await COMMANDS.gather(firstId);
    log('✔ 全端点总览完成');
  } else {
    const fn = COMMANDS[cmd];
    if (!fn) die('未知命令 "' + cmd + '"(可用: ' + Object.keys(COMMANDS).join(' / ') + ')');
    await fn(arg1);
  }
  if (flag.raw) log('\n── RAW ──\n' + JSON.stringify(lastData, null, 2));
  process.exitCode = 0; // 不用 process.exit:Node24/win 下强杀会触发 libuv 句柄断言,自然排空即可
})().catch(e => { // die() 已打印过的 __EXIT__ 不再重复报错
  if (String(e && e.message).indexOf('__EXIT__') < 0) { console.error('✘ ' + ((e && e.message) || e)); process.exitCode = 1; }
});
