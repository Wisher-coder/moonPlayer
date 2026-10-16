#!/usr/bin/env node
'use strict';
/**
 * yuese.js —— 月色发布页「最新地址」解析器(Node.js 版,零依赖,需 Node>=18)
 *
 * 解析链路(2026-10-06 实测):
 *   1. 发布页入口 yuese04.cc / yuese05.cc / yuese06.cc,根路径返回极简壳页:
 *      <script>window.location.href = 'https://ys.mkk7fcra.icu';</script>
 *      —— 纯 JS 跳转,HTTP 层无 302,必须拉 HTML 后正则提取跳转目标;
 *   2. 跳转目标是「中转页」(标题"中转页"),页面内联脚本里有四个变量:
 *      var domainsH5Codes=[[104,116,...],...]   —— 最新地址,charCode 数组编码
 *      var internationalCodes=[{name,codes}]    —— 海外地址(当前为空)
 *      var emailCodes=[100,105,...]             —— 官方邮箱,同为 charCode 数组
 *      var updatedDate="\u66f4\u65b0..."        —— 更新日期(\uXXXX 转义字符串)
 *      String.fromCharCode 逐码解码即得明文地址;
 *   3. 三入口依次尝试(04→05→06),任一成功即止,全部失败才报错;支持多级跳转
 *      跟进(上限 MAX_HOPS 层,防循环);解码出的最新地址默认逐条 GET 单次
 *      存活探测(不重试,防请求风暴)。
 *
 * 用法:
 *   node yuese.js                 # 常规输出(人读),含地址存活探测
 *   node yuese.js --json          # 纯 JSON 输出到 stdout(进度日志走 stderr)
 *   node yuese.js --no-probe      # 跳过存活探测,只解析
 *   node yuese.js yuese07.cc      # 站群轮换出新入口域时,命令行直接指定(优先于内置三入口)
 *
 * 退出码:0=成功解析出最新地址;1=三入口全部失败。仅供站方授权测试使用。
 */

// ============ 0. 配置与命令行 ============

// 发布页入口(站群轮换,yueseNN.cc 形态;04/05/06 为 2026-10-06 实测当前入口)
const DEFAULT_ENTRIES = ['yuese04.cc', 'yuese05.cc', 'yuese06.cc'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15000;  // 单次请求超时
const PROBE_TIMEOUT_MS = 10000;  // 存活探测超时(地址轮换期打不开是常态,别等太久)
const MAX_HOPS = 3;              // 发布页→中转页 之间最多跟进几层 JS 跳转(防循环)

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const NO_PROBE = argv.includes('--no-probe');
// 命令行传入的主机名(裸域或带协议均可)插到最前,优先于内置入口
const extraHosts = argv.filter(a => !a.startsWith('--'))
  .map(h => h.replace(/^https?:\/\//i, '').replace(/\/.*$/, ''));
const ENTRIES = [...new Set([...extraHosts, ...DEFAULT_ENTRIES])];

// --json 时 stdout 只留给结果,进度/错误一律走 stderr
const log = (...a) => AS_JSON ? console.error(...a) : console.log(...a);

// ============ 1. 网络层(内置 fetch,零依赖) ============

async function fetchText(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('超时(' + timeoutMs + 'ms)')), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',  // HTTP 层 30x 自动跟(实测当前走 JS 跳转,此为兜底)
      signal: ac.signal,
      headers: {
        'User-Agent': UA,  // 裸 node UA 会被部分 CDN 拒,伪装桌面浏览器
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    return { status: res.status, finalUrl: res.url || url, text: await res.text() };
  } finally { clearTimeout(timer); }
}

// ============ 2. 解析核心 ============

// 从壳页 HTML 里提取 JS 跳转目标(location.href 赋值 / meta refresh 双保险)
function extractRedirectTarget(html) {
  let m = html.match(/location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i);
  if (m) return m[1];
  m = html.match(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']?\s*\d+\s*;\s*url\s*=\s*([^"'>\s]+)/i);
  if (m) return m[1];
  return null;
}

// 中转页壳签名:内联脚本含 domainsH5Codes 变量(实测 04/05 两路中转页同构)
const isTransit = html => /var\s+domainsH5Codes\s*=/.test(html);

// 抓取中转页内联脚本里的 var xxx=<字面量>;
// 四个变量值都是纯 JSON(数组/转义字符串),惰性匹配到 `];` / 闭合字符串后 JSON.parse。
// 数组元素全为数字、不含分号,该终止策略安全;updatedDate 的 \uXXXX 由 JSON.parse 原生解码。
function grabVar(html, name) {
  const m = html.match(new RegExp('var\\s+' + name + '\\s*=\\s*(\\[[\\s\\S]*?\\]|"(?:[^"\\\\]|\\\\.)*")\\s*;'));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

// charCode 数组 → 明文(map+join,避免 apply 参数上限)
const decodeCodes = codes => Array.isArray(codes) ? codes.map(c => String.fromCharCode(c)).join('') : '';

// 中转页 HTML → 结构化结果;非中转页返回 null
function parseTransit(html, transitUrl) {
  if (!isTransit(html)) return null;
  const dom = grabVar(html, 'domainsH5Codes') || [];
  const intl = grabVar(html, 'internationalCodes') || [];
  const emailCodes = grabVar(html, 'emailCodes') || [];
  const latest = dom.map(decodeCodes).filter(Boolean);
  // internationalCodes 当前为空数组;页面渲染逻辑用 {name, codes} 形态,做双形态兼容
  const intlList = [];
  if (Array.isArray(intl)) for (const it of intl) {
    const url = it && Array.isArray(it.codes) ? decodeCodes(it.codes) : (Array.isArray(it) ? decodeCodes(it) : '');
    if (url) intlList.push({ name: (it && it.name) || '海外地址', url });
  }
  return {
    transitUrl: transitUrl || '',
    updatedDate: String(grabVar(html, 'updatedDate') || '').replace(/^更新日期[：:]\s*/, ''),
    latest,                                  // ['https://ys.xxx.icu', ...]
    intl: intlList,                          // [{name, url}]
    email: decodeCodes(emailCodes),
  };
}

// 单入口全链路:发布页根 →(JS 跳转,最多 MAX_HOPS 层)→ 中转页 → 解码
async function resolveFromEntry(host) {
  const root = 'https://' + host + '/';
  const chain = [root];
  log('  · 请求入口 ' + root + ' ...');
  const r = await fetchText(root, FETCH_TIMEOUT_MS);
  if (r.status >= 400) throw new Error('入口 HTTP ' + r.status);
  if (isTransit(r.text)) {  // 发布页根本身就是中转页的形态兼容
    log('  · 入口即中转页,就地解析');
    return { data: parseTransit(r.text, root), chain };
  }
  let next = extractRedirectTarget(r.text);
  if (!next) throw new Error('入口页无跳转目标(HTTP ' + r.status + ')');
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    chain.push(next);
    log('  · 跳转 → ' + next);
    const rr = await fetchText(next, FETCH_TIMEOUT_MS);
    if (isTransit(rr.text)) return { data: parseTransit(rr.text, next), chain };
    const n2 = extractRedirectTarget(rr.text);
    if (!n2) throw new Error('中转页无最新地址数据: ' + next);
    next = n2;
  }
  throw new Error('跳转层级超过 ' + MAX_HOPS + ' 层(疑似循环)');
}

// 三入口顺序尝试(不并发,防请求风暴),首个成功即返回
async function resolveAll() {
  const errors = [];
  for (const host of ENTRIES) {
    try {
      const r = await resolveFromEntry(host);
      if (r.data && r.data.latest.length) return { host, ...r, errors };
      errors.push({ host, err: '解析成功但最新地址列表为空' });
    } catch (e) { errors.push({ host, err: (e && e.message) || String(e) }); }
    log('  × ' + host + ' 失败,换下一入口');
  }
  return { errors };
}

// ============ 3. 存活探测(单次 GET,不重试) ============

async function probe(url) {
  try {
    const r = await fetchText(url, PROBE_TIMEOUT_MS);
    // 任意 HTTP 状态码都算"域名活着在服务"(轮换期 403/404 也常见),如实报码
    return { ok: true, status: r.status };
  } catch (e) {
    return { ok: false, err: (e && e.message) || String(e) };
  }
}

// ============ 4. 主流程与输出 ============

(async () => {
  log('月色发布页最新地址解析(v1.0.0,入口: ' + ENTRIES.join(' / ') + ')');
  const result = await resolveAll();

  if (!result.data) {
    log('✘ 全部入口解析失败:');
    for (const e of result.errors) log('  · ' + e.host + ' —— ' + e.err);
    if (AS_JSON) console.log(JSON.stringify({ success: false, errors: result.errors }));
    process.exitCode = 1;  // 只设码不强杀(Windows 下 process.exit 会与 undici 句柄关闭竞态,触发 libuv 断言崩溃)
    return;
  }

  const { data } = result;

  // 存活探测:最新地址 + 海外地址逐条(GET 单次;--no-probe 跳过)
  const targets = [...data.latest.map(url => ({ url })), ...data.intl];
  if (!NO_PROBE && targets.length) {
    log('  · 存活探测 ' + targets.length + ' 条地址 ...');
    for (const t of targets) t.probe = await probe(t.url);
  }

  if (AS_JSON) {
    console.log(JSON.stringify({
      success: true,
      sourceEntry: result.host,
      chain: result.chain,          // 发布页 → … → 中转页 完整链路
      updatedDate: data.updatedDate,
      latest: data.latest.map(url => ({ url, probe: (targets.find(t => t.url === url) || {}).probe || null })),
      intl: data.intl,
      email: data.email,
    }, null, 2));
  } else {
    const badge = p => !p ? '' : p.ok ? '  [✓ 可达 HTTP ' + p.status + ']' : '  [✗ ' + p.err + ']';
    log('✔ 解析成功(来源入口: ' + result.host + ')');
    log('  发布页  : ' + result.chain[0]);
    log('  中转页  : ' + data.transitUrl);
    if (data.updatedDate) log('  更新日期: ' + data.updatedDate);
    log('  ── 最新地址 ──');
    data.latest.forEach((u, i) => log('  [' + (i + 1) + '] ' + u + badge((targets.find(t => t.url === u) || {}).probe)));
    for (const it of data.intl) log('  [' + it.name + '] ' + it.url + badge(it.probe));
    if (data.email) log('  官方邮箱: ' + data.email);
  }
  // 成功路径不 process.exit —— 让事件循环自然排空退出(强杀在 Windows 上有 libuv 断言竞态)
})().catch(e => { console.error('✘ 未预期错误:', e); process.exitCode = 1; });
