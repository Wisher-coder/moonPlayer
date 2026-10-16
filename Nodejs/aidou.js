#!/usr/bin/env node
'use strict';
/**
 * aidou.js —— 爱豆(aido)发布页「最新地址」解析器(Node.js 版,零依赖,需 Node>=18)
 * 与 yuese.js 同套路的姊妹脚本,解析链路(2026-10-06 实测):
 *
 *   1. 发布页入口 w1.aido1.cc(w2/w3.aido1.cc 同构并存,可作兜底),根路径返回壳页:
 *        <script>
 *            var site = "dzk0LmFpZG91Lm1l";
 *            location.href= "https://" + atob(site);
 *        </script>
 *      —— 纯 JS 跳转且目标域名 base64 编码(dzk0LmFpZG91Lm1l → w94.aidou.me),
 *      必须拉 HTML 后先提取 atob 引用的变量再解码,拼回 https:// 完整地址;
 *   2. 跳转目标是「爱豆导航」导航页(title=导航页),页面尾部 jQuery 脚本:
 *        var site  = "dzIyLmFpZGE0LnRvcA=="   —— 电脑端域名(base64 → w22.aida4.top)
 *        var site2 = "bjIyLmFpZGE0LmxvbA=="   —— 移动端域名(base64 → n22.aida4.lol)
 *        $("a.enter").attr("href", "https://" + atob(mobile ? site2 : site));
 *      即「进入新站/登录网站/立即注册/联系我们」四个按钮的真实指向;
 *      按 UA 三元(mobile ? site2 : site)分流,解析时两个都取,标注 电脑端/移动端;
 *   3. 三入口 w1→w2→w3 依次尝试,任一成功即止;支持多级跳转跟进(上限 MAX_HOPS 层防循环);
 *      解码出的地址默认逐条 GET 单次存活探测(不重试,防请求风暴)。
 *      本机代理(fake-ip)对这批域名偶发 TLS 抖动,每入口仅做 1 次隔 1.5s 的温和重试,
 *      全程最多 6 个请求,不构成请求风暴。
 *
 * 用法:
 *   node aidou.js                 # 常规输出(人读),含地址存活探测
 *   node aidou.js --json          # 纯 JSON 输出到 stdout(进度日志走 stderr)
 *   node aidou.js --no-probe      # 跳过存活探测,只解析
 *   node aidou.js w4.aido1.cc     # 站群轮换出新入口域时,命令行直接指定(优先于内置三入口)
 *
 * 退出码:0=成功解析出最新地址;1=三入口全部失败。仅供站方授权测试使用。
 */

// ============ 0. 配置与命令行 ============

// 发布页入口(同构并存,w1/w2/w3 实测均在线;2026-10-06 实测当前入口)
const DEFAULT_ENTRIES = ['w1.aido1.cc', 'w2.aido1.cc', 'w3.aido1.cc'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15000;  // 单次请求超时
const PROBE_TIMEOUT_MS = 10000;  // 存活探测超时(移动端根路径 404 属正常,如实报码)
const MAX_HOPS = 3;              // 发布页→导航页 之间最多跟进几层 JS 跳转(防循环)
const ENTRY_RETRY = 1;           // 每入口额外温和重试次数(代理 TLS 抖动兜底)
const RETRY_DELAY_MS = 1500;

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

// 带温和重试的取页面(仅入口用;导航页/探测仍单发,总量可控)
async function fetchTextWithRetry(url, timeoutMs, retries) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fetchText(url, timeoutMs); }
    catch (e) { lastErr = e; if (i < retries) await new Promise(r => setTimeout(r, RETRY_DELAY_MS)); }
  }
  throw lastErr;
}

// ============ 2. 解析核心 ============

// base64 → 明文(atob 等价,Node Buffer 实现;解码失败返回空串)
const b64d = s => { try { return Buffer.from(String(s), 'base64').toString('utf8').trim(); } catch (e) { return ''; } };
// 明文是否像域名(过滤把普通字符串误当 base64 解出的垃圾)
const isDomainLike = s => /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(s) && !/\s/.test(s);

// 收集页面里 var <name> = "<base64 字面量>" 声明(壳页/导航页共用此形态存编码域名)
function collectBase64Vars(html) {
  const map = {};
  const re = /var\s+([A-Za-z_$][\w$]*)\s*=\s*"([A-Za-z0-9+/]{6,}={0,2})"/g;
  let m; while ((m = re.exec(html))) map[m[1]] = m[2];
  return map;
}

// 从壳页 HTML 提取 JS 跳转目标,按优先级:
//   ① location.href = "https://" + atob(varName)  —— 爱豆壳页形态,变量再经 base64 解码
//   ② location.href = 'https://literal'           —— 明文直跳(yuese 同款,形态兼容)
//   ③ meta refresh                                  —— 兜底
function extractRedirectTarget(html) {
  const vars = collectBase64Vars(html);
  let m = html.match(/location(?:\.href)?\s*=\s*["']https?:\/\/["']\s*\+\s*atob\(\s*([A-Za-z_$][\w$]*)\s*\)/);
  if (m && vars[m[1]]) {
    const d = b64d(vars[m[1]]);
    if (isDomainLike(d)) return 'https://' + d;
  }
  m = html.match(/atob\(\s*"([A-Za-z0-9+/]+={0,2})"\s*\)/);  // atob 内联字面量形态兼容
  if (m) { const d = b64d(m[1]); if (isDomainLike(d)) return 'https://' + d; }
  m = html.match(/location(?:\.href)?\s*=\s*['"](https?:\/\/[^'"]+)['"]/i);
  if (m) return m[1];
  m = html.match(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']?\s*\d+\s*;\s*url\s*=\s*([^"'>\s]+)/i);
  if (m) return m[1];
  return null;
}

// 导航页壳签名:存在 atob() 且有 .enter 链接赋值(爱豆导航页特征,防误伤其他站同路径页)
const isNavPage = html => /atob\(/.test(html) && (/a\.enter/.test(html) || /class="enter"/.test(html));

// 导航页 HTML → 结构化结果;非导航页返回 null
function parseNav(html, navUrl) {
  if (!isNavPage(html)) return null;
  const vars = collectBase64Vars(html);
  const out = { navUrl, pc: '', mobile: '', extra: [] };
  // 主形态:atob(mobile ? site2 : site) —— 条件真(移动 UA)取第二元,假(桌面)取第三元
  const t = html.match(/atob\(\s*[\w$]+\s*\?\s*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*\)/);
  if (t) {
    const mob = b64d(vars[t[1]]), pc = b64d(vars[t[2]]);
    if (isDomainLike(pc)) out.pc = 'https://' + pc;
    if (isDomainLike(mob)) out.mobile = 'https://' + mob;
  }
  // 兜底:页面若改版无三元,把所有能解出域名形的 var 全部收进 extra(去重)
  const seen = new Set([out.pc, out.mobile]);
  for (const enc of Object.values(vars)) {
    const d = b64d(enc);
    if (isDomainLike(d) && !seen.has('https://' + d)) { out.extra.push('https://' + d); seen.add('https://' + d); }
  }
  return (out.pc || out.mobile || out.extra.length) ? out : null;
}

// 单入口全链路:发布页根 →(JS 跳转,最多 MAX_HOPS 层)→ 导航页 → 解码
async function resolveFromEntry(host) {
  const root = 'https://' + host + '/';
  const chain = [root];
  log('  · 请求入口 ' + root + ' ...');
  const r = await fetchTextWithRetry(root, FETCH_TIMEOUT_MS, ENTRY_RETRY);
  if (r.status >= 400) throw new Error('入口 HTTP ' + r.status);
  if (isNavPage(r.text)) {  // 发布页根本身就是导航页的形态兼容
    log('  · 入口即导航页,就地解析');
    return { data: parseNav(r.text, root), chain };
  }
  let next = extractRedirectTarget(r.text);
  if (!next) throw new Error('入口页无跳转目标(HTTP ' + r.status + ')');
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    chain.push(next);
    log('  · 跳转 → ' + next);
    const rr = await fetchText(next, FETCH_TIMEOUT_MS);
    if (isNavPage(rr.text)) return { data: parseNav(rr.text, next), chain };
    const n2 = extractRedirectTarget(rr.text);
    if (!n2) throw new Error('导航页无最新地址数据: ' + next);
    next = n2;
  }
  throw new Error('跳转层级超过 ' + MAX_HOPS + ' 层(疑似循环)');
}

// 多入口顺序尝试(不并发,防请求风暴),首个成功即返回
async function resolveAll() {
  const errors = [];
  for (const host of ENTRIES) {
    try {
      const r = await resolveFromEntry(host);
      if (r.data) return { host, ...r, errors };
      errors.push({ host, err: '跳转正常但未解析出地址' });
    } catch (e) { errors.push({ host, err: (e && e.message) || String(e) }); }
    log('  × ' + host + ' 失败,换下一入口');
  }
  return { errors };
}

// ============ 3. 存活探测(单次 GET,不重试) ============

async function probe(url) {
  try {
    const r = await fetchText(url, PROBE_TIMEOUT_MS);
    // 任意 HTTP 状态码都算"域名活着在服务"(移动端根路径 404 属正常),如实报码
    return { ok: true, status: r.status };
  } catch (e) {
    return { ok: false, err: (e && e.message) || String(e) };
  }
}

// ============ 4. 主流程与输出 ============

(async () => {
  log('爱豆发布页最新地址解析(v1.0.0,入口: ' + ENTRIES.join(' / ') + ')');
  const result = await resolveAll();

  if (!result.data) {
    log('✘ 全部入口解析失败:');
    for (const e of result.errors) log('  · ' + e.host + ' —— ' + e.err);
    if (AS_JSON) console.log(JSON.stringify({ success: false, errors: result.errors }));
    process.exitCode = 1;  // 只设码不强杀(Windows 下 process.exit 会与 undici 句柄关闭竞态,触发 libuv 断言崩溃)
    return;
  }

  const { data } = result;
  // 探测目标:电脑端 / 移动端 / 兜底 extra,逐条单次 GET
  const targets = [
    { label: '电脑端', url: data.pc },
    { label: '移动端', url: data.mobile },
    ...data.extra.map((u, i) => ({ label: '其他(' + (i + 1) + ')', url: u })),
  ].filter(t => t.url);
  if (!NO_PROBE && targets.length) {
    log('  · 存活探测 ' + targets.length + ' 条地址 ...');
    for (const t of targets) t.probe = await probe(t.url);
  }

  if (AS_JSON) {
    console.log(JSON.stringify({
      success: true,
      sourceEntry: result.host,
      chain: result.chain,          // 发布页 → … → 导航页 完整链路
      navUrl: data.navUrl,
      pc: data.pc || null,
      mobile: data.mobile || null,
      extra: data.extra,
      probes: Object.fromEntries(targets.map(t => [t.url, t.probe || null])),
    }, null, 2));
  } else {
    const badge = p => !p ? '' : p.ok ? '  [✓ 可达 HTTP ' + p.status + ']' : '  [✗ ' + p.err + ']';
    log('✔ 解析成功(来源入口: ' + result.host + ')');
    log('  发布页  : ' + result.chain[0]);
    log('  导航页  : ' + data.navUrl);
    log('  ── 最新地址 ──');
    for (const t of targets) log('  [' + t.label + '] ' + t.url + badge(t.probe));
  }
  // 成功路径不 process.exit —— 让事件循环自然排空退出(强杀在 Windows 上有 libuv 断言竞态)
})().catch(e => { console.error('✘ 未预期错误:', e); process.exitCode = 1; });
