#!/usr/bin/env node
'use strict';
/**
 * hanxiucao.js —— 含羞草(fi11)发布页「最新地址」解析器(Node.js 版,零依赖,需 Node>=18)
 *
 * 解析链路(2026-10-06 实测):
 *   1. 发布页入口 www.fi11.xyz / fi11.xyz,两种到达方式(同一落点):
 *      https 入口返回 200 + 极简壳页:
 *      <script>window.location.href = 'https://z2z.rjhij.com';</script>
 *      —— 纯 JS 跳转,HTTP 层无 302,必须拉 HTML 后正则提取跳转目标;
 *      http 入口则是 HTTP 302 直跳中转页(fetch redirect:'follow' 自动跟,兜底);
 *   2. 跳转目标是「中转页」(标题"中转页"),与月色不同,地址不走 charCode 数组
 *      编码,直接写在 DOM 属性里:
 *      <div class="... copy-btn" data-copy-prefix="网址"
 *           data-clipboard-text="https://www.7oz0y.com">  —— 最新地址(复制按钮)
 *      <div class="download-btn"><a href="https://op.7oz0y.com">下载APP</a>
 *                                                                  —— APP 下载地址
 *      邮箱仅以图片展示(static/switch/pc_email.png),HTML 无明文;注释块里偶有
 *      残留邮箱文本,尽力提取仅作参考;页面无更新日期字段,以响应头 Last-Modified
 *      作参考更新时间;
 *   3. 双入口依次尝试(www 优先),每入口 https→http 两级;任一成功即止,全部失败
 *      才报错;支持多级跳转跟进(上限 MAX_HOPS 层,防循环);解码出的最新地址默认
 *      逐条 GET 单次存活探测(不重试,防请求风暴)。
 *
 * 服务端对应实现(2026-10-09,按 AGENTS.md 溯源规则注明):MoontentRN/server 已上线
 *   自动发现——本 CLI 的跳转链解析/中转页签名/copy-btn 解析(L84-129)已移植为服务端
 *   插件 server/src/plugins/hanxiucao.js 的 discoverGateways,并注册进统一调度器
 *   server/src/plugins/domain-refresh.js(5 分钟周期轮 + 请求失败 urgent 触发,单站
 *   60s 冷却)。服务端比本 CLI 多走一步:拿到最新前端域后继续拉主包提取 API 网关池
 *   并逐个 getTimeStamp 验活(本 CLI 止步于最新前端域;网关提取历来靠 .work/
 *   deob_fi11.js 手工重提,见 hanxiucao_api.js)。分歧:服务端版全串行、fail-soft
 *   (发现失败保留旧网关,内置双网关兜底永不删除);本 CLI 保留探测输出/退出码语义,
 *   供人工取证对照,两份实现各自维护、修 bug 时需双向同步。
 *
 * 用法:
 *   node hanxiucao.js                 # 常规输出(人读),含地址存活探测
 *   node hanxiucao.js --json          # 纯 JSON 输出到 stdout(进度日志走 stderr)
 *   node hanxiucao.js --no-probe      # 跳过存活探测,只解析
 *   node hanxiucao.js fi12.xyz        # 站群轮换出新入口域时,命令行直接指定(优先于内置入口)
 *
 * 退出码:0=成功解析出最新地址;1=全部入口失败。仅供站方授权测试使用。
 */

// ============ 0. 配置与命令行 ============

// 发布页入口(站群轮换;www.fi11.xyz / fi11.xyz 为 2026-10-06 实测当前入口,www 优先)
const DEFAULT_ENTRIES = ['www.fi11.xyz', 'fi11.xyz'];
const SCHEMES = ['https', 'http'];   // 每入口依次尝试 https → http(单协议失败才降级,防请求风暴)
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
      redirect: 'follow',  // HTTP 层 30x 自动跟(实测 http 入口走 302,https 入口走 JS 壳页)
      signal: ac.signal,
      headers: {
        'User-Agent': UA,  // 裸 node UA 会被部分 CDN 拒,伪装桌面浏览器
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    return {
      status: res.status,
      finalUrl: res.url || url,
      // 中转页无更新日期字段,响应头 Last-Modified 作参考更新时间
      lastModified: res.headers.get('last-modified') || '',
      text: await res.text(),
    };
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

// 中转页壳签名:标题含"中转页"或存在 data-clipboard-text 地址属性(双信号任一命中)
const isTransit = html =>
  /<title>[^<]*中转页[^<]*<\/title>/i.test(html) ||
  /data-clipboard-text\s*=\s*["']https?:\/\//i.test(html);

// data-clipboard-text 的值可能裸域无协议,统一补 https://
const normalizeUrl = u => /^https?:\/\//i.test(u) ? u : 'https://' + u;

// 中转页 HTML → 结构化结果;非中转页返回 null
function parseTransit(html, transitUrl, lastModified) {
  if (!isTransit(html)) return null;
  // 全部复制按钮:data-copy-prefix(标签) + data-clipboard-text(地址),逐个配对
  // 当前仅一条「网址:www.7oz0y.com」;若站方日后加备用地址行,自动多收,无需改码
  const latest = [];
  const btnRe = /<div[^>]*class="[^"]*copy-btn[^"]*"[^>]*>/gi;
  let m;
  while ((m = btnRe.exec(html))) {
    const tag = m[0];
    const label = (tag.match(/data-copy-prefix\s*=\s*"([^"]*)"/) || [])[1] || '地址';
    const raw = (tag.match(/data-clipboard-text\s*=\s*"([^"]*)"/) || [])[1] || '';
    if (raw) latest.push({ label, url: normalizeUrl(raw.trim()) });
  }
  // APP 下载地址:download-btn 内第一个 <a href>
  const app = normalizeUrl(((html.match(/class="[^"]*download-btn[^"]*"[^>]*>\s*<a[^>]+href\s*=\s*"([^"]+)"/i) || [])[1] || '').trim());
  // 邮箱:中转页仅以图片展示,HTML 无明文;先剥掉全部标签(连属性一起,避免把
  // Slice18@2x.png 之类图片文件名误当邮箱),注释块残留文本尽力提取,仅作参考
  const textOnly = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]*>/g, ' ');
  const email = (textOnly.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [])[0] || '';
  // 纯地址数组(主输出形态,与探测/JSON 输出对齐)
  const urls = [...new Set(latest.map(it => it.url))];
  return {
    transitUrl: transitUrl || '',
    lastModified,                             // 参考更新时间(响应头,非站方明示)
    latest: urls,                             // ['https://www.7oz0y.com', ...]
    latestLabeled: latest,                    // [{label:'网址', url}] 原始标签形态
    app: app || '',
    email,                                    // 可能为空:站方以图片展示邮箱
  };
}

// 单入口全链路:发布页根 →(302 自动跟 / JS 跳转最多 MAX_HOPS 层)→ 中转页 → 提取
async function resolveFromEntry(host) {
  let lastErr = null;
  for (const scheme of SCHEMES) {
    const root = scheme + '://' + host + '/';
    const chain = [root];
    try {
      log('  · 请求入口 ' + root + ' ...');
      const r = await fetchText(root, FETCH_TIMEOUT_MS);
      if (r.status >= 400) throw new Error('入口 HTTP ' + r.status);
      if (isTransit(r.text)) {  // 发布页根本身就是中转页的形态兼容
        log('  · 入口即中转页,就地解析');
        return { data: parseTransit(r.text, r.finalUrl, r.lastModified), chain };
      }
      let next = extractRedirectTarget(r.text);
      if (!next) throw new Error('入口页无跳转目标(HTTP ' + r.status + ')');
      for (let hop = 0; hop < MAX_HOPS; hop++) {
        chain.push(next);
        log('  · 跳转 → ' + next);
        const rr = await fetchText(next, FETCH_TIMEOUT_MS);
        if (isTransit(rr.text)) return { data: parseTransit(rr.text, rr.finalUrl, rr.lastModified), chain };
        const n2 = extractRedirectTarget(rr.text);
        if (!n2) throw new Error('中转页无最新地址数据: ' + next);
        next = n2;
      }
      throw new Error('跳转层级超过 ' + MAX_HOPS + ' 层(疑似循环)');
    } catch (e) { lastErr = e; log('  × ' + root + ' 失败:' + ((e && e.message) || e)); }
  }
  throw lastErr || new Error(host + ' 全协议失败');
}

// 双入口顺序尝试(不并发,防请求风暴),首个成功即返回
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
  log('含羞草(fi11)发布页最新地址解析(v1.0.0,入口: ' + ENTRIES.join(' / ') + ')');
  const result = await resolveAll();

  if (!result.data) {
    log('✘ 全部入口解析失败:');
    for (const e of result.errors) log('  · ' + e.host + ' —— ' + e.err);
    if (AS_JSON) console.log(JSON.stringify({ success: false, errors: result.errors }));
    process.exitCode = 1;  // 只设码不强杀(Windows 下 process.exit 会与 undici 句柄关闭竞态,触发 libuv 断言崩溃)
    return;
  }

  const { data } = result;

  // 存活探测:最新地址 + APP 地址逐条(GET 单次;--no-probe 跳过)
  const targets = data.latest.map(url => ({ url }));
  if (data.app) targets.push({ url: data.app });
  if (!NO_PROBE && targets.length) {
    log('  · 存活探测 ' + targets.length + ' 条地址 ...');
    for (const t of targets) t.probe = await probe(t.url);
  }

  if (AS_JSON) {
    console.log(JSON.stringify({
      success: true,
      sourceEntry: result.host,
      chain: result.chain,          // 发布页 → … → 中转页 完整链路
      updatedDateRef: data.lastModified,   // 参考更新时间(中转页响应头 Last-Modified)
      latest: data.latest.map(url => ({ url, probe: (targets.find(t => t.url === url) || {}).probe || null })),
      latestLabeled: data.latestLabeled,   // [{label, url}] 原始标签形态
      app: data.app,
      email: data.email,                  // 可能为空:站方以图片展示,此为注释残留参考值
    }, null, 2));
  } else {
    const badge = p => !p ? '' : p.ok ? '  [✓ 可达 HTTP ' + p.status + ']' : '  [✗ ' + p.err + ']';
    log('✔ 解析成功(来源入口: ' + result.host + ')');
    log('  发布页  : ' + result.chain[0]);
    log('  中转页  : ' + data.transitUrl);
    if (data.lastModified) log('  更新参考: ' + data.lastModified + '(响应头 Last-Modified)');
    log('  ── 最新地址 ──');
    data.latest.forEach((u, i) => log('  [' + (i + 1) + '] ' + u + badge((targets.find(t => t.url === u) || {}).probe)));
    if (data.app) log('  [APP下载] ' + data.app + badge((targets.find(t => t.url === data.app) || {}).probe));
    if (data.email) log('  官方邮箱: ' + data.email + '(页面注释残留参考值,站方实际以图片展示)');
  }
  // 成功路径不 process.exit —— 让事件循环自然排空退出(强杀在 Windows 上有 libuv 断言竞态)
})().catch(e => { console.error('✘ 未预期错误:', e); process.exitCode = 1; });
