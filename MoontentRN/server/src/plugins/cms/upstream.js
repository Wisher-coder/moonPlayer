// ============================================================
// upstream.js —— 资源站上游抓取层(仅 Node 服务端运行,plugin/source 共用)
//
// 三类站点差异在这里一次抹平,上层(_get/probeEntry)零分支:
//   · 盾站(实测奥斯卡 aosikazy 的 CDN「OriginStatusGuard」):裸抓 418 + HTML,
//     页内 <script id="jump-request-data">{Captcha-Time,Captcha-Sign}</script> +
//     <script id="jump-formula">算式</script> + body[data-token];按算式求值后
//     POST /_waf/_<token>.sjs?r=..(Captcha-Sign/Captcha-Time 头 + captcha_result
//     表单体)即通过,放行按「IP + 域名」生效(全路径、跨请求持续,实测过盾后
//     十分钟仍直连),故过盾成功按主机记 TTL 免重复;并发请求单飞,只解一次。
//   · XML 站(实测大地 dadiapi / 色猫 semaozy:MacCMS 同源 RSS 形态):ac=list/
//     videolist/detail/wd/t/pg 语义与 json 接口完全一致,仅响应为
//     <rss><list><video>…<class><ty id=".."> 结构,此处解析成与 json 同形信封。
//     坑:XML 站 ac=detail 返回精简元素(无 <dl> 播放组),播放地址必须走
//     ac=videolist&ids=(plugin._rawById 本就是此序,direct 回退仅兜底)。
//   · HTTP-only 站(实测百花 bhziyuan https 连接失败、http 正常):https 连接级
//     失败自动降级 http 重试,命中主机记 30 分钟(到期重试 https,防某天修好
//     了还走 http);协议偏好进程级共享,探测学到的偏好运行时直接复用,避免
//     每次请求都付双倍超时。
//
// 安全:算式求值前先过字符白名单(仅数字与 + - * / ( ) . % 空白),不白名单
// 一律拒解——绝不把页面内容直接丢进 Function。
// ============================================================

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 15000;
const WAF_PASS_TTL_MS = 30 * 60 * 1000;   // 过盾放行记忆时长(期间直连不重复过盾)
const PROTO_DOWN_TTL_MS = 30 * 60 * 1000; // https 降级 http 的记忆时长

const wafPassed = new Map();   // host → exp(过盾放行到期时间)
const wafInflight = new Map(); // host → Promise(并发单飞,同主机只解一次盾)
const protoDown = new Map();   // host → exp(该主机 https 不通,先走 http)

// 连接级失败(区别于 HTTP 状态码失败):https 握手/连接建不起来才有意义降级
const CONN_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PACKET_LENGTH_TOO_LONG', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
]);
function isConnError(e) {
  const codes = [e && e.code, e && e.cause && e.cause.code, e && e.cause && e.cause.cause && e.cause.cause.code];
  for (const c of codes) if (c && (CONN_CODES.has(c) || /^ERR_SSL|^ERR_TLS|^CERT_/.test(String(c)))) return true;
  return false;
}

// 请求失败错误:kind 供上层翻成人话(plugin 的错误文案要带站点名)
class UpstreamError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind;   // 'network' | 'http' | 'parse' | 'code' | 'waf'
    Object.assign(this, extra);
  }
}
export { UpstreamError };

// ============ 盾:解析 / 求值 / 过盾 ============

// 挑战页解析:非挑战页返回 null(418 之外的形态也认,部分盾返 200 带挑战)
export function parseChallenge(html) {
  const s = String(html || '');
  if (!s.includes('jump-request-data') || !s.includes('jump-formula')) return null;
  const token = (s.match(/<body[^>]*\bdata-token="([^"]+)"/i) || [])[1] || '';
  if (!token) return null;
  let data = null;
  try {
    const raw = (s.match(/<script[^>]*id="jump-request-data"[^>]*>([\s\S]*?)<\/script>/i) || [])[1] || '';
    data = JSON.parse(raw);
  } catch (e) { return null; }
  const formula = ((s.match(/<script[^>]*id="jump-formula"[^>]*>([\s\S]*?)<\/script>/i) || [])[1] || '').trim();
  if (!data || !formula) return null;
  return { token, sign: String(data['Captcha-Sign'] || ''), time: String(data['Captcha-Time'] || ''), formula };
}

// 算式求值:白名单字符 + 定长截断;非法一律 null(不做 Function 自由求值)
export function evalFormula(formula) {
  const f = String(formula || '').trim();
  if (!f || f.length > 200) return null;
  if (!/^[0-9+\-*/().%\s]+$/.test(f)) return null;
  try {
    const v = Function('"use strict";return (' + f + ')')(); // 已白名单,无标识符可注入
    if (!Number.isFinite(v)) return null;
    return String(v).slice(0, 10);
  } catch (e) { return null; }
}

// 过盾:POST 验签(captcha_result 表单体 + Captcha-Sign/Time 头),成功记 host TTL
async function solveChallenge(baseUrl, html, timeoutMs) {
  const ch = parseChallenge(html);
  if (!ch) return false;
  const result = evalFormula(ch.formula);
  if (result == null) throw new UpstreamError('waf', '盾算式无法求值');
  const u = new URL(baseUrl);
  const verify = u.origin + '/_waf/_' + ch.token + '.sjs?r=' + Math.random();
  let res;
  try {
    res = await fetch(verify, {
      method: 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Captcha-Sign': ch.sign,
        'Captcha-Time': ch.time,
        'Origin': u.origin,
        'Referer': baseUrl,
      },
      body: 'captcha_result=' + encodeURIComponent(result), // jQuery data 序列化即此形态(实测验签用表单体)
    });
  } catch (e) {
    throw new UpstreamError('waf', '盾验签请求不可达:' + ((e && e.message) || '网络错误'));
  }
  if (!res.ok) throw new UpstreamError('waf', '盾验签 HTTP ' + res.status);
  let j = null;
  try { j = JSON.parse(await res.text()); } catch (e) { /* 非 JSON 按验签失败 */ }
  if (!j || j.result !== 'success') throw new UpstreamError('waf', '盾验签未通过');
  wafPassed.set(u.hostname, Date.now() + WAF_PASS_TTL_MS);
  return true;
}

// 同主机过盾单飞:并发撞盾时只解一次,其余等结果
function solveOnce(host, baseUrl, html, timeoutMs) {
  if (!wafInflight.has(host)) {
    const p = solveChallenge(baseUrl, html, timeoutMs)
      .finally(() => wafInflight.delete(host));
    wafInflight.set(host, p);
  }
  return wafInflight.get(host);
}

// ============ XML/RSS 解析(MacCMS 同源形态 → json 同形信封) ============

function unwrap(s) {
  const t = String(s || '');
  const m = t.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  const body = m ? m[1] : t;
  return body.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
}
function tagText(xml, tag) {
  const m = String(xml).match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i'));
  return m ? unwrap(m[1]) : '';
}
function attr(tag, name) {
  const m = String(tag).match(new RegExp(name + '="([^"]*)"', 'i'));
  return m ? m[1] : '';
}

// RSS 文本 → {code:1,page,pagecount,total,limit,class,list(vod 形态)}
// 判定要求响应【以 XML 声明或 <rss 开头】——不靠全文 includes,免得 JSON 正文
// 里偶然出现 "<rss" 字样(标题/描述)被误判成 XML 站
export function parseRss(text) {
  const s = String(text || '');
  if (!/^\s*(<\?xml[\s>]|<rss[\s>])/i.test(s)) return null;
  const listTag = (s.match(/<list\b[^>]*>/i) || [''])[0];
  const page = parseInt(attr(listTag, 'page'), 10) || 1;
  const pagecount = parseInt(attr(listTag, 'pagecount'), 10) || 0;
  const total = parseInt(attr(listTag, 'recordcount'), 10) || 0;
  const limit = parseInt(attr(listTag, 'pagesize'), 10) || 0;
  const cls = [];
  const classBlock = (s.match(/<class>([\s\S]*?)<\/class>/i) || [])[1] || '';
  const tyRe = /<ty\b([^>]*)>([\s\S]*?)<\/ty>/gi;
  let ty;
  while ((ty = tyRe.exec(classBlock))) {
    const id = attr(ty[1], 'id');
    const name = unwrap(ty[2]);
    if (id && name) cls.push({ type_id: id, type_pid: 0, type_name: name });
  }
  const list = [];
  const vRe = /<video>([\s\S]*?)<\/video>/gi;
  let vm;
  while ((vm = vRe.exec(s))) {
    const v = vm[1];
    const id = tagText(v, 'id');
    if (!id) continue;
    // 播放组:多 <dd flag="源名">CDATA(label$url)</dd> → 与 json 接口的
    // vod_play_from/vod_play_url 同形($$$ 拆源),上层 pickEpisodes 直接吃
    const froms = []; const urls = [];
    const ddRe = /<dd\b([^>]*)>([\s\S]*?)<\/dd>/gi;
    let dm;
    while ((dm = ddRe.exec(v))) {
      froms.push(attr(dm[1], 'flag') || 'm3u8');
      urls.push(unwrap(dm[2]));
    }
    list.push({
      vod_id: id,
      vod_name: tagText(v, 'name'),
      vod_pic: tagText(v, 'pic'),
      vod_class: tagText(v, 'type'),
      type_id: tagText(v, 'tid'),
      type_name: tagText(v, 'type'),
      vod_version: tagText(v, 'note'),
      vod_time: tagText(v, 'last'),
      vod_year: tagText(v, 'year'),
      vod_content: tagText(v, 'des'),
      vod_play_from: froms.join('$$$'),
      vod_play_url: urls.filter(Boolean).join('$$$'),
    });
  }
  return { code: 1, msg: 'rss', page, pagecount, total, limit, class: cls, list };
}

// ============ 统一请求:协议降级 + 过盾重试 ============

// 裸文本抓取(不判状态码,由调用方定语义);自动降级 http、自动过盾并重试
export async function requestUpstream(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const headers = {
    'User-Agent': UA,
    'Accept': opts.accept || 'application/json,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...(opts.referer ? { Referer: opts.referer } : {}),
    ...(opts.headers || {}),
  };
  const doFetch = (u) => fetch(u, {
    cache: 'no-store',
    method: opts.method || 'GET',
    signal: AbortSignal.timeout(timeoutMs),
    headers,
    ...(opts.body != null ? { body: opts.body } : {}),
  });

  let u = String(url);
  let host = '';
  try { host = new URL(u).hostname; } catch (e) { /* 畸形地址交给 fetch 报错 */ }
  // 已学到「该主机 https 不通」→ 直接用 http,免双倍等待
  if (host && protoDown.get(host) > Date.now() && u.startsWith('https://')) u = 'http://' + u.slice(8);

  let res;
  try {
    res = await doFetch(u);
  } catch (e) {
    if (!isConnError(e)) throw new UpstreamError('network', (e && e.message) || '网络错误');
    // 连接级失败且当前为 https → 降级 http 重试(命中则记住 30 分钟)
    if (u.startsWith('https://')) {
      const alt = 'http://' + u.slice(8);
      try {
        res = await doFetch(alt);
        if (host) protoDown.set(host, Date.now() + PROTO_DOWN_TTL_MS);
        u = alt;
      } catch (e2) {
        throw new UpstreamError('network', (e2 && e2.message) || '网络错误', { timeout: e2 && e2.name === 'TimeoutError' });
      }
    } else {
      throw new UpstreamError('network', (e && e.message) || '网络错误', { timeout: e && e.name === 'TimeoutError' });
    }
  }

  let text = await res.text();
  // 撞盾(418 或过盾记忆过期)→ 过盾后重试。最多解两次:验签数据与「当次 GET 的
  // URL」绑定,并发时同主机共享的第一次解可能对应别的 URL,重试页自带新签,再解
  // 一次即可(过盾记忆命中后第二次通常直接 200)
  for (let i = 0; i < 2 && (res.status === 418 || parseChallenge(text)); i++) {
    if (!host) throw new UpstreamError('waf', '盾页缺少主机信息');
    await solveOnce(host, u, text, timeoutMs);
    res = await doFetch(u);
    text = await res.text();
  }
  if (res.status === 418 || parseChallenge(text)) throw new UpstreamError('waf', '盾未放行(HTTP ' + res.status + ')');
  return { status: res.status, text, url: u, contentType: res.headers.get('content-type') || '' };
}

// ============ MacCMS 接口封装:JSON / RSS 同形返回 ============

// 按「已学到的协议偏好」归一出实际可用地址:入库/相对地址绝对化用它当 base,
// 免得 https 降级站(http-only)的相对封面/相对播放地址又拼回 https 打不开
export function effectiveUrl(u) {
  const s = String(u || '');
  try {
    const x = new URL(s);
    if (x.protocol === 'https:' && protoDown.get(x.hostname) > Date.now()) x.protocol = 'http:';
    return x.href;
  } catch (e) { return s; }
}

// api + 参数 → 信封 {code,msg,page,pagecount,total,limit,class,list}
// HTTP≥400 抛 http;非 JSON/RSS 抛 parse;其余原样回(含 code!==1,由上层判)
export async function macCmsRequest(api, params, opts = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = api + (api.includes('?') ? '&' : '?') + qs;
  const r = await requestUpstream(url, { referer: opts.referer, timeoutMs: opts.timeoutMs });
  if (r.status >= 400) throw new UpstreamError('http', 'HTTP ' + r.status, { status: r.status });
  const t = r.text.replace(/^\uFEFF/, '');
  const rss = parseRss(t);
  if (rss) return rss;
  let j = null;
  try { j = JSON.parse(t); } catch (e) { /* 两种形态都不像 */ }
  if (!j || typeof j !== 'object') throw new UpstreamError('parse', '非 JSON/RSS 响应');
  return j;
}
