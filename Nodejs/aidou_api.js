#!/usr/bin/env node
'use strict';
/**
 * aidou_api.js —— 爱豆视频站视频类只读 API 爬取器(Node.js 版,零依赖,需 Node>=18)
 * 结构与 yuese_api.js 同款:发布页解析基地址 → 加密 API 客户端 → 命令表 → 摘要打印。
 *
 * 逆向结论(2026-10-06,授权测试环境实测):
 *   1. 站点(w22.aida4.top 等)为 jQuery+ElementUI 传统页,数据接口全部走同源
 *      /awsapi/* 路径,协议为 AwsApi(逻辑提取自 ps1.lczzyr.top/static/js/all.min.js):
 *        - 请求:POST /awsapi/<端点>?md5=<hex>,表单体 data=<密文base64>;
 *        - 加密:AES-128-CBC/PKCS7,key=iv=Latin1(reverse(String(t*299)+"1")),
 *          t=Date.now()(13 位毫秒;16 字节密钥,与 CryptoJS WordArray 模式等价,
 *          无 Salted__ 头);
 *        - md5 参数名是幌子,实为可逆时间戳载体:
 *          hex(parseInt(reverse(String(parseInt(t*177))+"1"))),服务端由此还原 t
 *          作解密密钥,故必须与请求体密钥同一 t 生成;
 *        - 响应:{code,message,data},code==200 成功(401/402 需登录/403/500 错误),
 *          data 为同密钥加密的 JSON 串,解密即明文;
 *        - 请求头需 X-Requested-With/Origin/Referer 伪装 ajax(jQuery 默认行为)。
 *   2. 播放地址零校验:列表/详情行内直给 vodPlayUrl=/api/m3u8/{code}.m3u8,
 *      主站域裸 GET 即得有效 HLS(切片绝对地址指向 ws*.benben.website,伪装 .pdf;
 *      对 ws 域直接请求 /api/m3u8/ 是 404,清单只在主站域服务);
 *   3. 封面 vodPic 为 .ttf 伪装,内容是整段字节序反转的 JPEG(getCover 即
 *      Uint8Array.reverse(),另有海椒系 XOR "2019ysapp7527" 变体)——不在本脚本范围。
 *
 * 端点清单(只读部分,全部实测通过;login/reg/pay/add_/del_ 系列写操作刻意不实现):
 *   /awsapi/vod/search.php    视频列表/搜索/标签过滤(首页四区块亦走此端点)
 *       参数 {type,by,order,page,size,tag,keyword,count,extypes}
 *       by ∈ vod_time(最新)|vod_score(评分)|vod_hits(人气);type 见下方类型表;
 *       站点列表页公式 extypes=(type!=6?"6":"")(即默认排除"免费"类),首页区块则
 *       有带 extypes=6(重磅热推/人气排行)与不带(今日上新)两种形态;
 *       响应 {count,page,rows:[{vodId,code,typeId,vodName,vodTag,vodHits,vodUp,
 *             vodScoreNum,vodSize,vodTime(unix秒),vodPic,vodPlayUrl,vodPlayFrom}]}
 *   /awsapi/vod/info.php      视频详情 {id},响应含 token/vodPlayServer/lineNum
 *   /awsapi/vod/hotwords.php  热词榜(无参,逗号分隔字符串,站方固定)
 *   /awsapi/sys/conf.php      站点配置 {code}(如 app.pub.pc/app.wap.site)
 *
 * 类型表(导航实测): 1国产 2日韩 3欧美 4动漫 5传媒 6免费
 *
 * 用法(基地址默认经发布页 w1/w2/w3.aido1.cc 实时解析,也可 --base 直指):
 *   node aidou_api.js                        # 全端点总览(逐个跑,输出摘要)
 *   node aidou_api.js home                   # 首页四区块(免费/重磅热推/今日上新/人气)
 *   node aidou_api.js list --type=1 --page=2 --size=12 --by=vod_time
 *   node aidou_api.js search 关键词 --page=1 --size=10
 *   node aidou_api.js bytag 制服 --page=1    # 标签过滤(传标签词)
 *   node aidou_api.js hotwords               # 热词榜
 *   node aidou_api.js detail 71230           # 视频详情(含完整 m3u8 地址)
 *   node aidou_api.js conf app.pub.pc        # 站点配置项
 *   通用旗标:--base=https://w22.aida4.top(跳过发布页解析)
 *           --raw(输出完整解密 JSON)  --no-title(摘要隐藏标题,便于留档)
 * 退出码:0=成功;1=失败。仅供站方授权测试使用。
 */

// ============ 0. 常量与命令行 ============

const PUBLISH_ENTRIES = ['w1.aido1.cc', 'w2.aido1.cc', 'w3.aido1.cc']; // 发布页(站群轮换)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;
const MAX_HOPS = 3;    // 发布页→导航页 JS 跳转最大跟进层数
const ENTRY_RETRY = 1; // 入口温和重试次数(本地代理对这批域名偶发 TLS 抖动)

const TYPE_NAMES = { 1: '国产', 2: '日韩', 3: '欧美', 4: '动漫', 5: '传媒', 6: '免费' };

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

// ============ 1. 基地址解析(发布页→导航页→最新地址,内嵌自 aidou.js 同源逻辑) ============

async function httpReq(url, opt = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('超时')), opt.timeout || TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: opt.method || 'GET',
      redirect: 'follow', signal: ac.signal,
      headers: {
        'User-Agent': UA,
        'Accept': opt.accept || 'text/html,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(opt.headers || {}),
      },
      body: opt.body,
    });
    return { status: res.status, text: await res.text() };
  } finally { clearTimeout(timer); }
}

// 带温和重试的取页面(仅入口用;API/探测仍单发,总量可控)
async function httpReqRetry(url, opt, retries) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await httpReq(url, opt); }
    catch (e) { lastErr = e; if (i < retries) await new Promise(r => setTimeout(r, 1500)); }
  }
  throw lastErr;
}

// base64 → 明文;明文须像域名(过滤把普通字符串误当 base64 解出的垃圾)
const b64d = s => { try { return Buffer.from(String(s), 'base64').toString('utf8').trim(); } catch (e) { return ''; } };
const isDomainLike = s => /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(s) && !/\s/.test(s);

// 收集页面里 var <name> = "<base64 字面量>" 声明(壳页/导航页共用此形态存编码域名)
function collectBase64Vars(html) {
  const map = {};
  const re = /var\s+([A-Za-z_$][\w$]*)\s*=\s*"([A-Za-z0-9+/]{6,}={0,2})"/g;
  let m; while ((m = re.exec(html))) map[m[1]] = m[2];
  return map;
}

// 从壳页 HTML 提取 JS 跳转目标:①atob(变量)拼接 ②atob("字面量") ③明文直跳 ④meta refresh
function extractRedirect(html) {
  const vars = collectBase64Vars(html);
  let m = html.match(/location(?:\.href)?\s*=\s*["']https?:\/\/["']\s*\+\s*atob\(\s*([A-Za-z_$][\w$]*)\s*\)/);
  if (m && vars[m[1]]) { const d = b64d(vars[m[1]]); if (isDomainLike(d)) return 'https://' + d; }
  m = html.match(/atob\(\s*"([A-Za-z0-9+/]+={0,2})"\s*\)/);
  if (m) { const d = b64d(m[1]); if (isDomainLike(d)) return 'https://' + d; }
  m = html.match(/location(?:\.href)?\s*=\s*['"](https?:\/\/[^'"]+)['"]/i);
  if (m) return m[1];
  m = html.match(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']?\s*\d+\s*;\s*url\s*=\s*([^"'>\s]+)/i);
  if (m) return m[1];
  return null;
}

// 导航页壳签名:存在 atob() 且有 .enter 链接赋值(爱豆导航页特征)
const isNavPage = html => /atob\(/.test(html) && (/a\.enter/.test(html) || /class="enter"/.test(html));

// 导航页 → {pc, mobile, extra}(jQuery 按 UA 三元 atob(mobile ? site2 : site) 分流)
function parseNav(html, navUrl) {
  const vars = collectBase64Vars(html);
  const out = { pc: '', mobile: '', extra: [] };
  const t = html.match(/atob\(\s*[\w$]+\s*\?\s*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*\)/);
  if (t) {
    const mob = b64d(vars[t[1]]), pc = b64d(vars[t[2]]);
    if (isDomainLike(pc)) out.pc = 'https://' + pc;
    if (isDomainLike(mob)) out.mobile = 'https://' + mob;
  }
  const seen = new Set([out.pc, out.mobile]);
  for (const enc of Object.values(vars)) { // 兜底:改版无三元时收全部域名形 var
    const d = b64d(enc);
    if (isDomainLike(d) && !seen.has('https://' + d)) { out.extra.push('https://' + d); seen.add('https://' + d); }
  }
  return (out.pc || out.mobile || out.extra.length) ? out : null;
}

// 返回最新地址数组(电脑端优先,移动端兜底),--base 时单元素
async function resolveBases() {
  if (flag.base) return [String(flag.base).replace(/\/+$/, '')];
  for (const host of PUBLISH_ENTRIES) {
    try {
      let url = 'https://' + host + '/';
      for (let hop = 0; hop <= MAX_HOPS; hop++) {
        const r = await httpReqRetry(url, {}, ENTRY_RETRY);
        if (isNavPage(r.text)) {
          const n = parseNav(r.text, url);
          if (n) {
            const bases = [n.pc, n.mobile, ...n.extra].filter(Boolean).map(u => u.replace(/\/+$/, ''));
            if (bases.length) { log('· 发布页 ' + host + ' → 最新地址: ' + bases.join(' , ')); return bases; }
          }
          break;
        }
        const next = extractRedirect(r.text);
        if (!next) break;
        url = next;
      }
    } catch (e) { /* 换下一入口 */ }
  }
  die('发布页解析失败(可用 --base=https://w22.aida4.top 手动指定)');
}

// ============ 2. API 客户端(AwsApi 协议复现:AES-128-CBC 时间戳派生密钥) ============

const reverse = s => String(s).split('').reverse().join('');

// t(毫秒时间戳)→ {key(16字节), md5(URL参数)};两者必须同源,服务端由 md5 还原 t
function derive(t) {
  return {
    key: Buffer.from(reverse(String(t * 299) + '1'), 'latin1'),
    md5: parseInt(reverse(String(parseInt(t * 177)) + '1')).toString(16),
  };
}

async function apiPost(bases, path, payload) {
  let lastErr = null;
  for (const base of bases) {
    try {
      const t = Date.now();
      const { key, md5 } = derive(t);
      const c = require('crypto').createCipheriv('aes-128-cbc', key, key);
      const data = Buffer.concat([c.update(Buffer.from(JSON.stringify(payload), 'utf8')), c.final()]).toString('base64');
      const r = await httpReq(base + '/awsapi' + path + '?md5=' + md5, {
        method: 'POST',
        accept: 'application/json, text/javascript, */*; q=0.01',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest', // jQuery $.ajax 默认头,缺失可能被网关拒
          'Origin': base, 'Referer': base + '/',
        },
        body: new URLSearchParams({ data }).toString(),
      });
      if (r.status >= 400) { lastErr = new Error('HTTP ' + r.status + ' @' + base); continue; }
      let j;
      try { j = JSON.parse(r.text); } catch (e) { lastErr = new Error('非 JSON 响应 @' + base); continue; }
      if (j.code !== 200) throw new Error('接口报错 code=' + j.code + ' ' + (j.message || '') + ' @' + path);
      try {
        const d = require('crypto').createDecipheriv('aes-128-cbc', key, key);
        return JSON.parse(Buffer.concat([d.update(Buffer.from(j.data, 'base64')), d.final()]).toString('utf8'));
      } catch (e) { throw new Error('解密失败(密钥派生与服务端不一致,请回 all.min.js 复核): ' + e.message); }
    } catch (e) {
      if (/接口报错|解密失败/.test(e.message)) throw e; // 业务/密钥错误换基址无意义
      lastErr = e;
    }
  }
  throw lastErr || new Error('全部基地址不可达');
}

// ============ 3. 摘要打印 ============

const fmtSize = b => b == null ? '?' : b >= 1073741824 ? (b / 1073741824).toFixed(1) + 'G' : (b / 1048576).toFixed(0) + 'M';
const fmtTime = t => { // 列表行 unix 秒,详情行为日期字符串,兼容两者
  if (t == null) return '?';
  if (/^\d{10}$/.test(String(t))) { const d = new Date(t * 1000); return (d.getMonth() + 1) + '-' + String(d.getDate()).padStart(2, '0'); }
  return String(t);
};
const mask = (t, on) => on ? '<标题已隐藏>' : String(t == null ? '' : t).slice(0, 42);

function printRows(x, opt = {}) { // {count,page,total?,rows:[...]}
  if (!x || !Array.isArray(x.rows)) { log('  (无 rows 数组)'); return; }
  log('  共 ' + (x.count != null ? x.count : '?') + ' 条  第 ' + (x.page || 1) + (x.total ? '/' + x.total : '') + ' 页  本页 ' + x.rows.length + ' 条');
  for (const v of x.rows) {
    log('   [' + v.vodId + '] ' + (TYPE_NAMES[v.typeId] || 'type' + v.typeId) + '  ' + fmtTime(v.vodTime) + '  ' + fmtSize(v.vodSize)
      + '  人气' + (v.vodHits != null ? v.vodHits : '?') + (v.vodUp ? '  赞' + v.vodUp : '') + '  ' + mask(v.vodName, opt.noTitle));
  }
}

// ============ 4. 命令表 ============

// 站点列表页参数公式:extypes = (type != 6 ? "6" : "")——默认排除"免费"类
const siteExtypes = type => (String(type) !== '6' ? '6' : '');

const COMMANDS = {
  async home(a) { // 首页四区块(参数照搬首页 .video-module 的 data-* 属性)
    const modules = [
      ['免费视频', { type: '6', extypes: '', by: 'vod_time', size: 12 }],
      ['重磅热推', { type: '', extypes: '6', by: 'vod_score', size: 8 }],
      ['今日上新', { type: '', extypes: '', by: 'vod_time', size: 8 }],
      ['人气排行', { type: '', extypes: '6', by: 'vod_hits', size: 8 }],
    ];
    for (const [name, m] of modules) {
      const x = await a('/vod/search.php', { type: m.type, by: m.by, order: 'desc', page: 1, size: m.size, tag: '', keyword: '', count: '', extypes: m.extypes });
      log('── 首页·' + name + '(by=' + m.by + (m.extypes ? ' extypes=' + m.extypes : '') + ') ──');
      printRows(x, flag);
    }
  },
  async list(a) { // 通用列表(默认仿"今日上新"全量;--type 给出时套站点 extypes 公式)
    const type = flag.type !== undefined ? String(num('type', '')) : '';
    const p = {
      type, by: flag.by || 'vod_time', order: flag.order || 'desc',
      page: num('page', 1), size: num('size', 12), tag: flag.tag || '', keyword: flag.keyword || '', count: '',
      extypes: flag.extypes !== undefined ? String(flag.extypes) : (type ? siteExtypes(type) : ''),
    };
    const x = await a('/vod/search.php', p);
    log('── 视频列表 search' + (type ? ' type=' + type + '(' + (TYPE_NAMES[type] || '?') + ')' : '') + ' by=' + p.by + ' extypes="' + p.extypes + '" ──');
    printRows(x, flag);
  },
  async search(a) { // 关键词搜索(照搬站点搜索页:type="" extypes="6")
    const kw = arg1;
    if (!kw) die('用法: search <关键词> [--page=N] [--size=N] [--type=N] [--extypes=]');
    const type = flag.type !== undefined ? String(num('type', '')) : '';
    const p = {
      type, by: flag.by || 'vod_time', order: 'desc',
      page: num('page', 1), size: num('size', 10), tag: '', keyword: kw, count: '',
      extypes: flag.extypes !== undefined ? String(flag.extypes) : siteExtypes(type),
    };
    const x = await a('/vod/search.php', p);
    log('── 搜索 "' + kw + '" ──');
    printRows(x, flag);
  },
  async bytag(a) { // 标签过滤(播放页标签链 /vod/search.html?tag=xxx 同款参数)
    const tag = arg1;
    if (!tag) die('用法: bytag <标签词> [--page=N] [--size=N]');
    const p = { type: '', by: 'vod_time', order: 'desc', page: num('page', 1), size: num('size', 12), tag, keyword: '', count: '', extypes: '6' };
    const x = await a('/vod/search.php', p);
    log('── 标签 "' + tag + '" ──');
    printRows(x, flag);
  },
  async hotwords(a) { // 热词榜(无参,逗号分隔热词串)
    const x = await a('/vod/hotwords.php', {});
    log('── 热词榜 hotwords ──');
    log('  ' + (typeof x === 'string' ? x : JSON.stringify(x)));
  },
  async detail(a, a2) { // 视频详情(含 token/播放服务器;完整 m3u8 在主流程补打)
    const vid = a2 !== undefined ? a2 : arg1;
    if (!vid) die('用法: detail <视频ID>');
    const x = await a('/vod/info.php', { id: String(parseInt(vid, 10)) });
    log('── 视频详情 id=' + vid + ' ──');
    for (const [k, v] of Object.entries(x)) {
      if (k === 'vodName') { log('  vodName: ' + mask(v, flag.noTitle)); continue; }
      if (typeof v !== 'object' || v === null) log('  ' + k + ': ' + v);
      else log('  ' + k + ': ' + JSON.stringify(v).slice(0, 80));
    }
  },
  async conf(a) { // 站点配置项(如 app.pub.pc / app.wap.site)
    const code = arg1 || 'app.pub.pc';
    const x = await a('/sys/conf.php', { code });
    log('── 站点配置 ' + code + ' ──');
    log('  ' + (typeof x === 'string' ? x : JSON.stringify(x)));
  },
};

// ============ 5. 主流程 ============

(async () => {
  const bases = await resolveBases();
  let lastData = null, lastVod = null; // lastVod:最近一次含播放地址的结果(all 模式下 conf 会覆盖 lastData)
  const api = async (path, payload) => {
    log('  → POST /awsapi' + path);
    lastData = await apiPost(bases, path, payload);
    if (lastData && lastData.vodPlayUrl) lastVod = lastData;
    return lastData;
  };

  if (cmd === 'all') {
    // 总览:逐端点跑一遍(串行,防请求风暴),取列表第一条的 vodId 供详情深入
    const id = num('id', 0);
    await COMMANDS.hotwords(api);
    await COMMANDS.home(api);
    await COMMANDS.list(api);
    const firstId = (lastData && lastData.rows && lastData.rows[0] && lastData.rows[0].vodId) || id;
    await COMMANDS.detail(api, firstId);
    await COMMANDS.conf(api);
    log('✔ 全端点总览完成(基地址 ' + bases[0] + ')');
  } else {
    const fn = COMMANDS[cmd];
    if (!fn) die('未知命令 "' + cmd + '"(可用: ' + Object.keys(COMMANDS).join(' / ') + ')');
    await fn(api, arg1);
  }

  // 详情类结果补打完整播放地址(清单只在主站域服务,切片在其内为绝对地址)
  if (lastVod && lastVod.vodPlayUrl && lastVod.vodPlayServer) {
    log('  播放清单: ' + bases[0] + lastVod.vodPlayUrl);
    log('  切片域名: ' + lastVod.vodPlayServer + '(切片 .pdf 伪装 HLS,token 未参与校验)');
  }
  if (flag.raw) log('\n── RAW ──\n' + JSON.stringify(lastData, null, 2));
  process.exitCode = 0; // 不用 process.exit:Node24/win 下强杀会触发 libuv 句柄断言,自然排空即可
})().catch(e => die(e.message));
