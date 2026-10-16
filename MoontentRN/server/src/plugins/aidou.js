// ============================================================
// aidou.js —— 爱豆站点插件(AwsApi 加密 JSON,仅 Node 服务端运行)
//
// 逆向结论(2026-10-06 授权测试环境实测,移植自 CLI 取证版 aidou_api.js / aidou.js):
//   · 站点(w23.aida4.top 等)为 jQuery+ElementUI 传统页,数据接口全部走同源
//     /awsapi/* 路径,协议 AwsApi(逻辑提取自 ps1.lczzyr.top/static/js/all.min.js):
//       - 请求:POST /awsapi/<端点>?md5=<hex>,表单体 data=<密文base64>;
//       - 加密:AES-128-CBC/PKCS7,key=iv=Latin1(reverse(String(t*299)+"1")),
//         t=Date.now()(毫秒;16 字节密钥,无 Salted__ 头);
//       - md5 参数名是幌子,实为可逆时间戳载体:
//         hex(parseInt(reverse(String(parseInt(t*177)+"1")))),服务端由此还原 t
//         作解密密钥,故必须与请求体密钥同一 t 生成;
//       - 响应 {code,message,data},code==200 成功,data 为同密钥加密的 JSON 串;
//       - 请求头需 X-Requested-With/Origin/Referer 伪装 ajax(jQuery 默认行为)。
//   · 播放地址零校验:列表/详情行内直给 vodPlayUrl=/api/m3u8/{code}.m3u8,
//     主站域裸 GET 即得有效 HLS(切片绝对地址指向 ws*.benben.website,伪装 .pdf,
//     ACAO:* 浏览器可直连);清单本体无 ACAO → 须服务端代理文本(playlist 方法),
//     切片由浏览器 hls.js 直接拉取,服务器不过流量;
//   · 封面 vodPic 为 .ttf 伪装,内容是整段字节序反转的 JPEG(getCover 即
//     Uint8Array.reverse();另有海椒系 XOR "2019ysapp7527" 变体,image 内按
//     魔数嗅探逐形态兜底);
//   · 类型表(导航实测):1国产 2日韩 3欧美 4动漫 5传媒 6免费;
//     列表页公式 extypes=(type!=6?"6":"")——默认排除「免费」类;
//   · 无时长/清晰度字段(duration 恒 null)、无相关推荐端点(related 用
//     详情首个标签/分类的列表合成)、无标签榜端点(bytag 仍可用,标签词即 id);
//   · 入口域名轮换:发布页 w1/w2/w3.aido1.cc →(JS 跳转≤3 跳)→导航页
//     atob(mobile?site2:site) 三元解码得电脑端/移动端基址。
//
// 基址策略:环境变量 AIDOU_BASE 有值 → 单基址直连(禁用自动刷新);否则发布页
// 解析,结果模块级缓存 10 分钟(域名刷新调度器 domain-refresh.js 每 5 分钟重跑
// 发现链,顺带续本缓存)。请求失败(HTTP≥400/网络错/非 JSON)换下一基址;
// 业务错(code!==200)与解密错换基址无意义,直接抛;发布页解析失败/全部基址
// 不可达时先 urgent 刷新入口域名,changed 则原请求重试一轮(每请求至多一次)。
// ============================================================
import crypto from 'node:crypto';
import { SitePlugin } from './base.js';
import { registerRefresher, requestUrgentRefresh } from './domain-refresh.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const PUBLISH_ENTRIES = ['w1.aido1.cc', 'w2.aido1.cc', 'w3.aido1.cc']; // 发布页(站群轮换)
const MAX_HOPS = 3;               // 发布页→导航页 JS 跳转最大跟进层数(防循环)
const BASES_TTL = 10 * 60 * 1000; // 基址缓存有效期(10 分钟)
const CATS_TTL = 10 * 60 * 1000;  // 分类计数缓存有效期
const PLAY_CACHE_MAX = 40;        // 播放清单文本缓存上限(片长清单可达数百 KB)
const TIMEOUT_MS = 15000;
// 前端三档排序键 → 上游 by 值(vod_time 最新 / vod_hits 人气播放 / vod_score 评分)
const SORT_BY = { post_date: 'vod_time', video_viewed: 'vod_hits', most_popular: 'vod_score' };
const TYPE_NAMES = { 1: '国产', 2: '日韩', 3: '欧美', 4: '动漫', 5: '传媒', 6: '免费' };

// ============ 通用文本抓取(发布页解析 / 播放清单代理共用) ============

async function fetchText(url, timeoutMs = TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      cache: 'no-store',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/json,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

// ============ 基地址解析(发布页→导航页→最新地址) ============

// 模块级基址缓存:{bases, at}
let baseCache = { bases: null, at: 0 };

// base64 → 明文;明文须像域名(过滤把普通字符串误当 base64 解出的垃圾)
const b64d = (s) => { try { return Buffer.from(String(s), 'base64').toString('utf8').trim(); } catch (e) { return ''; } };
const isDomainLike = (s) => /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(s) && !/\s/.test(s);

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

// 导航页壳签名:存在 atob() 且有 .enter 链接赋值(爱豆导航页特征,防误伤其他站同路径页)
const isNavPage = (html) => /atob\(/.test(html) && (/a\.enter/.test(html) || /class="enter"/.test(html));

// 导航页 → 基址数组(jQuery 按 UA 三元 atob(mobile ? site2 : site) 分流,两个都取;兜底收全部域名形 var)
function parseNav(html) {
  const vars = collectBase64Vars(html);
  const out = { pc: '', mobile: '', extra: [] };
  const t = html.match(/atob\(\s*[\w$]+\s*\?\s*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*\)/);
  if (t) {
    const mob = b64d(vars[t[1]]), pc = b64d(vars[t[2]]);
    if (isDomainLike(pc)) out.pc = 'https://' + pc;
    if (isDomainLike(mob)) out.mobile = 'https://' + mob;
  }
  const seen = new Set([out.pc, out.mobile]);
  for (const enc of Object.values(vars)) {
    const d = b64d(enc);
    if (isDomainLike(d) && !seen.has('https://' + d)) { out.extra.push('https://' + d); seen.add('https://' + d); }
  }
  return (out.pc || out.mobile || out.extra.length) ? out : null;
}

// 发布页发现链本体(不读不写缓存;供 resolveBases 与域名刷新 refreshAidouDomains
// 共用);全部入口失败抛错
async function discoverBases() {
  for (const host of PUBLISH_ENTRIES) {
    try {
      let url = 'https://' + host + '/';
      for (let hop = 0; hop <= MAX_HOPS; hop++) {
        const r = await fetchText(url);
        if (isNavPage(r.text)) {
          const n = parseNav(r.text);
          if (n) {
            const bases = [n.pc, n.mobile, ...n.extra].filter(Boolean).map((u) => u.replace(/\/+$/, ''));
            if (bases.length) {
              return bases;
            }
          }
          break;
        }
        const next = extractRedirect(r.text);
        if (!next) break;
        url = next;
      }
    } catch (e) { /* 换下一发布页入口 */ }
  }
  throw new Error('爱豆发布页解析失败(可设置环境变量 AIDOU_BASE 手动指定基址)');
}

// 返回最新基址数组(电脑端优先,移动端兜底):环境变量直连 / 缓存命中 / 发现链
// 三层;发现成功写入 baseCache(既有 10 分钟懒缓存机制不变)
async function resolveBases() {
  if (process.env.AIDOU_BASE) return [String(process.env.AIDOU_BASE).replace(/\/+$/, '')];
  if (Array.isArray(baseCache.bases) && baseCache.bases.length && Date.now() - baseCache.at < BASES_TTL) {
    return baseCache.bases;
  }
  const bases = await discoverBases();
  baseCache = { bases, at: Date.now() };
  return bases;
}

// 域名自动刷新(注册给 domain-refresh.js 调度):绕过缓存重跑发布页发现链,成功
// 覆写 baseCache(顺带续 BASES_TTL);失败保留旧值 fail-soft;环境变量直连时禁用;
// 新旧 bases 完全一致返回 changed:false
async function refreshAidouDomains() {
  if (process.env.AIDOU_BASE) return { changed: false };
  let bases;
  try { bases = await discoverBases(); } catch (e) { return { changed: false }; }
  const old = Array.isArray(baseCache.bases) && baseCache.bases.length ? baseCache.bases : null;
  baseCache = { bases, at: Date.now() };
  return { changed: !old || JSON.stringify(bases) !== JSON.stringify(old) };
}
registerRefresher('aidou', refreshAidouDomains);

// ============ AwsApi 协议(AES-128-CBC 时间戳派生密钥) ============

const reverse = (s) => String(s).split('').reverse().join('');

// t(毫秒时间戳)→ {key(16字节), md5(URL参数)};两者必须同源,服务端由 md5 还原 t
function derive(t) {
  return {
    key: Buffer.from(reverse(String(t * 299) + '1'), 'latin1'),
    md5: parseInt(reverse(String(parseInt(t * 177)) + '1')).toString(16),
  };
}

// 温和重试(共 2 次隔 1.5s):本地代理对站群域偶发 TLS/连接抖动;仅网络错重试,防请求风暴勿加码
async function fetchRetry(fn, tries = 2, gapMs = 1500) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; if (i < tries - 1) await new Promise((r) => setTimeout(r, gapMs)); }
  }
  throw lastErr;
}

// 按基址轮换的 API POST 单轮:HTTP≥400/网络错/非 JSON 换下一基址;
// 业务错(code!==200)与解密错换基址无意义,直接抛
async function apiPostRound(path, payload) {
  const bases = await resolveBases();
  let lastErr = null;
  for (const base of bases) {
    try {
      const t = Date.now();
      const { key, md5 } = derive(t);
      const c = crypto.createCipheriv('aes-128-cbc', key, key);
      const data = Buffer.concat([c.update(Buffer.from(JSON.stringify(payload), 'utf8')), c.final()]).toString('base64');
      const r = await fetchRetry(() => fetch(base + '/awsapi' + path + '?md5=' + md5, {
        method: 'POST',
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest', // jQuery $.ajax 默认头,缺失可能被网关拒
          'Origin': base,
          'Referer': base + '/',
        },
        body: new URLSearchParams({ data }).toString(),
      }));
      if (!r.ok) { lastErr = new Error('上游 HTTP ' + r.status + ' @' + base); continue; }
      let j;
      try { j = await r.json(); } catch (e) { lastErr = new Error('非 JSON 响应 @' + base); continue; }
      if (j.code !== 200) throw new Error('爱豆接口 code=' + j.code + ' ' + (j.message || '') + ' @' + path);
      try {
        const d = crypto.createDecipheriv('aes-128-cbc', key, key);
        return JSON.parse(Buffer.concat([d.update(Buffer.from(j.data, 'base64')), d.final()]).toString('utf8'));
      } catch (e) {
        throw new Error('爱豆解密失败(密钥派生与服务端不一致,可能已改版):' + e.message);
      }
    } catch (e) {
      if (/爱豆接口|爱豆解密/.test(e.message)) throw e; // 业务/密钥错误换基址无意义
      lastErr = e;
    }
  }
  throw lastErr || new Error('爱豆全部基址不可达');
}

// API POST 入口(基址解析失败/全部基址不可达的失败钩子):非业务错先 urgent 刷新
// 入口域名(单站 60s 冷却/在途共享,见 domain-refresh.js),changed 则原请求重试
// 一轮(每请求至多一次 urgent 重试);业务/解密错不经过此钩子,正常请求逻辑零改动
async function apiPost(path, payload) {
  try {
    return await apiPostRound(path, payload);
  } catch (e) {
    if (/爱豆接口|爱豆解密/.test(e.message)) throw e;
    try {
      const r = await requestUrgentRefresh('aidou');
      if (r.changed) return await apiPostRound(path, payload);
    } catch (e2) { /* urgent 刷新自身异常按未变更处理 */ }
    throw e; // 仍失败抛原错误
  }
}

// 站点列表页参数公式:extypes = (type != 6 ? "6" : "")——默认排除「免费」类
const siteExtypes = (type) => (String(type) !== '6' ? '6' : '');

// search.php 统一参数骨架(by/order/extypes 按调用场景覆写)
const searchParams = (p) => ({
  type: '', by: 'vod_time', order: 'desc', page: 1, size: 24,
  tag: '', keyword: '', count: '', extypes: '', ...p,
});

// ============ 归一化(上游字段 → 前端契约,白名单构造,社交付费字段一律不带) ============

// 爱豆图源为 .ttf 伪装(字节反转 JPEG),必须走服务端解密代理
const imgProxy = (u) => (u ? '/api/img/aidou?u=' + encodeURIComponent(u) : '');

function normItem(v) {
  if (!v || v.vodId == null) return null;
  return {
    id: v.vodId,
    title: String(v.vodName || ''),
    cover: imgProxy(v.vodPic),
    duration: null, // 上游无时长字段(仅 vodSize 体积)
    hd: false,
  };
}

// 列表信封 {count,page,size,rows} → ListResult(响应回显 page/size,hasMore 按 count 换算)
function normList(x) {
  const arr = x && Array.isArray(x.rows) ? x.rows : [];
  const page = x && Number(x.page) > 0 ? Number(x.page) : 1;
  const size = (x && Number(x.size)) || arr.length;
  const count = (x && Number(x.count)) || 0;
  return { items: arr.map(normItem).filter(Boolean), page, hasMore: arr.length > 0 && page * size < count };
}

// vodTag 逗号串 → 标签数组(标签词即 id:bytag 直接吃词,详情页 chip 可链 ?tag=词)
function parseTags(vodTag) {
  return String(vodTag || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((t) => ({ id: t, name: t }));
}

// ============ 播放清单代理(vid → vodPlayUrl 路径缓存 + 文本 LRU) ============

const playPathCache = new Map(); // id(字符串) → '/api/m3u8/{code}.m3u8'
const playTextCache = new Map(); // id(字符串) → {text, at}
function cachePlayText(vid, text) {
  playTextCache.set(String(vid), { text, at: Date.now() });
  if (playTextCache.size > PLAY_CACHE_MAX) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [k, ent] of playTextCache) {
      if (ent.at < oldestAt) { oldestAt = ent.at; oldestKey = k; }
    }
    if (oldestKey !== null) playTextCache.delete(oldestKey);
  }
  return text;
}

// 详情原始数据(归一化前;顺带喂播放路径缓存)
async function fetchDetailRaw(vid) {
  const d = await apiPost('/vod/info.php', { id: String(vid) });
  if (!d || d.vodId == null) throw new Error('爱豆 detail 无数据 id=' + vid);
  if (d.vodPlayUrl) playPathCache.set(String(vid), d.vodPlayUrl);
  return d;
}

// 按基址轮换拉播放清单文本(单轮,不带 urgent):HTTP≥400/网络错/非 m3u8 换下一基址
async function fetchPlaylistText(path) {
  const bases = await resolveBases();
  let lastErr = null;
  for (const base of bases) {
    try {
      const r = await fetchText(base + path);
      if (r.status >= 400) { lastErr = new Error('清单 HTTP ' + r.status + ' @' + base); continue; }
      if (!r.text.trimStart().startsWith('#EXTM3U')) { lastErr = new Error('清单内容非 m3u8 @' + base); continue; }
      return r.text;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('爱豆播放清单全部基址不可达');
}

// ============ 插件类 ============

export class AidouPlugin extends SitePlugin {
  get id() { return 'aidou'; }
  get name() { return '爱豆'; }
  // 无标签榜端点(tags 不覆盖);bytag 可用(标签词即 id,详情页 chip 深链);
  // 无专辑概念;home=今日上新+类型导航;排序三档映射上游 by
  get capabilities() { return { home: true, hotwords: true, tags: false, dvds: false, bytag: true, sort: true }; }

  async home() {
    // 「今日上新」形态(type="" extypes=""),与 list 缺省参数一致,保证首页第 1 页与翻页无缝衔接
    const x = await apiPost('/vod/search.php', searchParams({ size: 24 }));
    const nav = Object.entries(TYPE_NAMES).map(([id, name]) => ({ id: String(id), title: name }));
    return { notice: '', nav, list: normList(x) };
  }

  async list(o = {}) {
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 24);
    const type = o.category != null && o.category !== '' ? String(parseInt(o.category, 10) || '') : '';
    const x = await apiPost('/vod/search.php', searchParams({
      type, page, size,
      by: SORT_BY[o.sort] || 'vod_time',
      extypes: siteExtypes(type),
    }));
    return normList(x);
  }

  async search(kw, o = {}) {
    const k = String(kw || '').trim();
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 24);
    if (!k) return { items: [], page: 1, hasMore: false };
    // 照搬站点搜索页形态:type="" extypes="6"
    const x = await apiPost('/vod/search.php', searchParams({ page, size, keyword: k, extypes: '6' }));
    return normList(x);
  }

  async bytag(tag, o = {}) {
    const t = String(tag || '').trim();
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 24);
    if (!t) throw new Error('爱豆 bytag 缺少标签词');
    // 播放页标签链 /vod/search.html?tag=xxx 同款参数(extypes="6")
    const x = await apiPost('/vod/search.php', searchParams({ page, size, tag: t, extypes: '6' }));
    return normList(x);
  }

  async hotwords() {
    const x = await apiPost('/vod/hotwords.php', {});
    // 站方固定热词榜:逗号分隔字符串
    const s = typeof x === 'string' ? x : (x && x.word != null ? String(x.word) : '');
    return s.split(/[,，]/).map((w) => w.trim()).filter(Boolean);
  }

  // 分类 = 导航实测六类型;计数用 size=1 探针逐类拉取(串行防风暴,结果缓存 10 分钟)
  async categories() {
    if (this._cats && Date.now() - this._catsAt < CATS_TTL) return this._cats;
    const out = [];
    for (const [id, name] of Object.entries(TYPE_NAMES)) {
      let count = 0;
      try {
        const x = await apiPost('/vod/search.php', searchParams({ type: id, size: 1, extypes: siteExtypes(id) }));
        count = Number(x && x.count) || 0;
      } catch (e) { /* 计数失败给 0,不挡分类页 */ }
      out.push({ id: String(id), name, count });
    }
    this._cats = out;
    this._catsAt = Date.now();
    return out;
  }

  async detail(id) {
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('爱豆 detail 缺少有效视频 id');
    const d = await fetchDetailRaw(vid);
    // 白名单构造:vodHits/vodUp 等统计字段按产品定位一律不带出
    return {
      id: d.vodId != null ? d.vodId : vid,
      title: String(d.vodName || ''),
      cover: imgProxy(d.vodPic),
      duration: null,
      hd: false,
      resolution: '',
      uploadDate: String(d.vodTime || ''), // 详情行为日期串(列表行为 unix 秒)
      tags: parseTags(d.vodTag),
      categories: TYPE_NAMES[d.typeId] ? [{ id: String(d.typeId), name: TYPE_NAMES[d.typeId] }] : [],
    };
  }

  // 上游无相关推荐端点:用详情首个标签(退而求分类)的列表合成,剔除自身
  async related(id, o = {}) {
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('爱豆 related 缺少有效视频 id');
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 8);
    const d = await fetchDetailRaw(vid);
    const firstTag = parseTags(d.vodTag)[0];
    let x;
    if (firstTag) {
      x = await apiPost('/vod/search.php', searchParams({ page, size, tag: firstTag.name, extypes: '6' }));
    } else {
      const type = d.typeId != null ? String(d.typeId) : '';
      x = await apiPost('/vod/search.php', searchParams({ type, page, size, extypes: siteExtypes(type) }));
    }
    const arr = (x && Array.isArray(x.rows) ? x.rows : []).filter((v) => v && v.vodId !== vid);
    return { items: arr.map(normItem).filter(Boolean), page, hasMore: page * size < (Number(x && x.count) || 0) };
  }

  // 播放解析:清单在主站域无 CORS → 经 /api/aidou/playlist 服务端代理文本,
  // 切片绝对地址且 ACAO:*,浏览器 hls.js 直连拉流
  async resolvePlay(id) {
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('爱豆 resolvePlay 缺少有效视频 id');
    const d = await fetchDetailRaw(vid);
    if (!d.vodPlayUrl) throw new Error('爱豆视频 ' + vid + ' 无播放地址(可能已下架)');
    return { type: 'hls', url: '/api/aidou/playlist?id=' + vid, via: 'm3u8' };
  }

  // 域名自动刷新(可选能力,契约见 base.js):手动触发一次发布页发现链;
  // domain-refresh.js 的周期轮与 urgent 触发亦走同一函数;AIDOU_BASE 有值时为 no-op
  async refreshDomains() { return refreshAidouDomains(); }

  // 播放清单文本代理:缓存命中直出;未命中取 detail 的 vodPlayUrl 路径再拉文本。
  // 基址解析失败/全部基址不可达时先 urgent 刷新入口域名,changed 则重试一轮
  // (每请求至多一次 urgent 重试);成功文本才进缓存,缓存语义不变
  async playlist(id) {
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('爱豆 playlist 缺少有效视频 id');
    const hit = playTextCache.get(String(vid));
    if (hit) return hit.text;
    let path = playPathCache.get(String(vid));
    if (!path) path = (await fetchDetailRaw(vid)).vodPlayUrl;
    if (!path) throw new Error('爱豆视频 ' + vid + ' 无播放清单路径');
    try {
      return cachePlayText(vid, await fetchPlaylistText(path));
    } catch (e) {
      try {
        const r = await requestUrgentRefresh('aidou');
        if (r.changed) return cachePlayText(vid, await fetchPlaylistText(path));
      } catch (e2) { /* urgent 刷新自身异常按未变更处理 */ }
      throw e; // 仍失败抛原错误
    }
  }

  // 静态图片能力:供 /api/img/aidou 代理调用,返回明文 JPEG/PNG Buffer
  async image(u) {
    if (!/^https?:\/\//.test(u || '')) throw new Error('爱豆图片代理需要合法 http(s) 地址');
    const r = await fetch(u, {
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': UA, 'Accept': 'image/*,*/*;q=0.8' },
    });
    if (!r.ok) throw new Error('图片 HTTP ' + r.status);
    return decodeCover(Buffer.from(await r.arrayBuffer()));
  }
}

// 封面伪装嗅探:明文 → 整段反转(主形态)→ XOR "2019ysapp7527"(海椒系变体)→ 反转+XOR,
// 逐形态按 JPEG/PNG 魔数判定,全不中抛错
function decodeCover(buf) {
  const okMagic = (b) => b.length > 4 && ((b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50));
  if (okMagic(buf)) return buf;
  const rev = Buffer.from(buf).reverse();
  if (okMagic(rev)) return rev;
  const xk = Buffer.from('2019ysapp7527', 'latin1');
  const xored = Buffer.from(buf.map((b, i) => b ^ xk[i % xk.length]));
  if (okMagic(xored)) return xored;
  const revXored = Buffer.from(xored).reverse();
  if (okMagic(revXored)) return revXored;
  throw new Error('封面解密失败(未知伪装形态,' + buf.length + ' 字节)');
}
