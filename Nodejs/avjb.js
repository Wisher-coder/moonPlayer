#!/usr/bin/env node
'use strict';
/**
 * avjb.js —— 爱微社区(avjb)发布页「最新地址」解析器(Node.js 版,零依赖,需 Node>=18)
 *
 * 解析链路(2026-10-06 实测):
 *   1. 官方发布页 avjb.github.io(GitHub Pages,长期稳定):根路径返回整页 jsjiami.com.v7
 *      混淆脚本(单脚本 82KB,无任何明文域名/无 HTTP 跳转),沙箱执行后 document.write 出
 *      静态壳——海外地址 avjb.com、官方 Telegram 频道硬编码在壳里;
 *   2. 静态壳内嵌第二段脚本(明文):DOMContentLoaded 后
 *      fetch('https://more.timka.cc/fasjlkfsakjfsakfsa/dom.php') 返回【明文 JSON 数组】
 *      即当前入口域名(bavNN.cc / bavNNN.xyz 形态,高频轮换——实测 5 分钟内即换批),
 *      页面再逐个 HEAD favicon.ico 测速渲染「速度:NNNms」;
 *      ⇒ 解析器无需跑混淆脚本:直连 dom.php 即唯一权威入口源(Referer 需带 avjb.github.io,
 *      不带也实测放行);混淆壳仅在 dom.php 不可达时兜底(沙箱跑出静态壳硬编码部分);
 *   3. 入口域全部套 rsso2 JS 挑战+18+ 年龄门(~1KB 壳,var safeid=… 写 cookie _safe 即过),
 *      对"域名存活探测"无碍——挑战页本身就是服务在响应;
 *   4. 主域 avjb.com / avjb.cc 与入口同壳同库,一并探测;avjb_api.js 爬取器可直接
 *      --base=https://<任一存活域> 使用。
 *
 * 用法:
 *   node avjb.js                 # 常规输出(人读),含入口存活探测
 *   node avjb.js --json          # 纯 JSON 输出到 stdout(进度日志走 stderr)
 *   node avjb.js --no-probe      # 跳过存活探测,只解析
 *   node avjb.js bav99.cc        # 站群轮换出新入口域时,命令行直接指定(并入探测列表)
 *
 * 退出码:0=解析出最新地址;1=发布页与 dom.php 全部失败。仅供站方授权测试使用。
 */

// ============ 0. 配置与命令行 ============

const PUBLISH_URL = 'https://avjb.github.io/';                     // 官方发布页(GitHub Pages)
const DOM_API = 'https://more.timka.cc/fasjlkfsakjfsakfsa/dom.php'; // 发布页动态域名接口(明文 JSON)
const MAIN_DOMAINS = ['avjb.com', 'avjb.cc'];                      // 主域(与入口同壳同库)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15000;
const PROBE_TIMEOUT_MS = 10000;   // 地址轮换期打不开是常态,别等太久

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const NO_PROBE = argv.includes('--no-probe');
// 命令行传入的主机名(裸域或带协议均可),并入探测列表
const extraHosts = argv.filter(a => !a.startsWith('--'))
  .map(h => h.replace(/^https?:\/\//i, '').replace(/\/.*$/, ''));

// --json 时 stdout 只留给结果,进度/错误一律走 stderr
const log = (...a) => AS_JSON ? console.error(...a) : console.log(...a);

// ============ 1. 网络层(内置 fetch,零依赖) ============

async function fetchText(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('超时(' + timeoutMs + 'ms)')), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow', signal: ac.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/json,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': PUBLISH_URL,   // dom.php 实测不强制,带上无碍
      },
    });
    return { status: res.status, finalUrl: res.url || url, text: await res.text() };
  } finally { clearTimeout(timer); }
}

// ============ 2. 解析核心 ============

// 首选:dom.php 明文 JSON(发布页动态渲染的唯一数据源)
async function resolveFromDomApi() {
  const r = await fetchText(DOM_API, FETCH_TIMEOUT_MS);
  if (r.status >= 400) throw new Error('dom.php HTTP ' + r.status);
  const list = JSON.parse(r.text);
  if (!Array.isArray(list) || !list.length || typeof list[0] !== 'string')
    throw new Error('dom.php 返回非域名数组: ' + r.text.slice(0, 80));
  return list.map(d => d.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
}

// 兜底:发布页混淆壳沙箱执行(jsjiami.v7 有反调试,宿主对象会被 constructor.constructor
// 逃逸调 process.exit 静默杀进程——上下文内必须自建 console/定时器等全部全局,不传宿主对象)
async function resolveFromPublishShell() {
  const vm = require('vm');
  const r = await fetchText(PUBLISH_URL, FETCH_TIMEOUT_MS);
  const m = r.text.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) throw new Error('发布页无脚本(改版?)');
  const prelude = `
    var __writes = [];
    function __mkEl() { return { innerHTML: '', style: {}, children: [], appendChild(c) { this.children.push(c); }, setAttribute() {}, addEventListener() {}, getElementsByTagName() { return []; }, querySelector() { return null; }, querySelectorAll() { return []; }, classList: { add() {}, remove() {} } }; }
    var document = { write: s => __writes.push(String(s)), writeln: s => __writes.push(String(s)),
      cookie: '', title: '', domain: 'avjb.github.io', referrer: '', readyState: 'complete',
      documentElement: __mkEl(), body: __mkEl(), head: __mkEl(), createElement: __mkEl,
      createTextNode: t => ({ text: t }), getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => [], getElementsByTagName: () => [], addEventListener() {}, removeEventListener() {},
      currentScript: { src: '' } };
    var location = { href: 'https://avjb.github.io/', protocol: 'https:', host: 'avjb.github.io', hostname: 'avjb.github.io', origin: 'https://avjb.github.io', pathname: '/', search: '', hash: '', replace() {} };
    var navigator = { userAgent: '${UA.replace(/'/g, "\\'")}', language: 'zh-CN' };
    var console = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
    var performance = { now: () => Date.now() };
    var setTimeout = f => 0, setInterval = f => 0, clearTimeout = () => {}, clearInterval = () => {};
    var fetch = () => new Promise(() => {});
    var XMLHttpRequest = function () { this.open = () => {}; this.send = () => {}; this.setRequestHeader = () => {}; };
    var alert = () => {}, confirm = () => true;
    var window = this, self = this, globalThis = this;
  `;
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(prelude + '\n' + m[1], sb, { timeout: 10000 });
  const w = vm.runInContext('__writes.join("")', sb);
  // 壳内硬编码部分:海外地址/Telegram;入口域名壳里是空 href(靠 dom.php 动态填),拿不到
  const urls = [...new Set((w.match(/https?:\/\/[a-zA-Z0-9.-]+/g) || []))]
    .filter(u => !/timka\.cc|github\.io/.test(u));
  if (!urls.length) throw new Error('混淆壳未产出任何地址');
  return { shell: true, urls };
}

// ============ 3. 存活探测(单次 GET,不重试;挑战页=活) ============

async function probe(host) {
  try {
    const r = await fetchText('https://' + host + '/', PROBE_TIMEOUT_MS);
    // 挑战壳/任意状态码都算"域名活着在服务"(rsso2 门与轮换期 403 均常见),如实报形态
    const form = /var\s+safeid\s*=/.test(r.text) ? 'rsso2 挑战壳' : (r.status === 200 ? 'KVS 页' : 'HTTP ' + r.status);
    return { ok: true, status: r.status, form };
  } catch (e) {
    return { ok: false, err: (e && e.message) || String(e) };
  }
}

// ============ 4. 主流程与输出 ============

(async () => {
  log('爱微社区发布页最新地址解析(v1.0.0,发布页: ' + PUBLISH_URL + ')');

  // 入口列表:dom.php 首选,混淆壳兜底(壳仅含海外地址等硬编码)
  let entries = [], shellFallback = null, source = '';
  try {
    entries = await resolveFromDomApi();
    source = DOM_API;
    log('· dom.php 当前入口: ' + entries.join(' , '));
  } catch (e1) {
    log('  × dom.php 失败(' + e1.message + '),转发布页混淆壳兜底');
    try {
      shellFallback = await resolveFromPublishShell();
      source = PUBLISH_URL + '(混淆壳)';
      log('· 混淆壳产出 ' + shellFallback.urls.length + ' 条硬编码地址');
    } catch (e2) {
      if (AS_JSON) console.log(JSON.stringify({ success: false, errors: [String(e1.message), String(e2.message)] }));
      else { log('✘ 全部解析路径失败:'); log('  · dom.php —— ' + e1.message); log('  · 混淆壳 —— ' + e2.message); }
      process.exitCode = 1;   // 只设码不强杀(Windows 下 process.exit 与 undici 句柄关闭竞态会触发 libuv 断言)
      return;
    }
  }

  const hosts = entries.length
    ? [...new Set([...extraHosts, ...entries, ...MAIN_DOMAINS])]
    : [...new Set([...extraHosts, ...MAIN_DOMAINS, ...shellFallback.urls.map(u => u.replace(/^https?:\/\//, ''))])];

  // 存活探测(串行单次 GET,防请求风暴;--no-probe 跳过)
  const results = [];
  if (!NO_PROBE) {
    log('· 存活探测 ' + hosts.length + ' 个域名 ...');
    for (const h of hosts) results.push({ host: h, probe: await probe(h) });
  } else {
    for (const h of hosts) results.push({ host: h, probe: null });
  }

  if (AS_JSON) {
    console.log(JSON.stringify({
      success: true, source,
      entries,                     // dom.php 当前入口(权威源)
      mainDomains: MAIN_DOMAINS,
      extra: extraHosts,
      shellFallback: shellFallback ? shellFallback.urls : null,   // 兜底壳硬编码地址(海外/TG)
      hosts: results,
    }, null, 2));
  } else {
    const badge = p => !p ? '' : p.ok ? '  [✓ ' + p.form + ']' : '  [✗ ' + p.err + ']';
    log('✔ 解析成功(来源: ' + source + ')');
    log('  ── 当前入口(dom.php,' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ')──');
    entries.forEach((h, i) => log('  [' + (i + 1) + '] https://' + h + '/' + badge((results.find(r => r.host === h) || {}).probe)));
    log('  ── 主域 ──');
    MAIN_DOMAINS.forEach(h => log('  https://' + h + '/' + badge((results.find(r => r.host === h) || {}).probe)));
    const extras = results.filter(r => !entries.includes(r.host) && !MAIN_DOMAINS.includes(r.host));
    if (extras.length) { log('  ── 命令行指定/兜底壳 ──'); extras.forEach(r => log('  https://' + r.host + '/' + badge(r.probe))); }
    if (shellFallback) { log('  ── 兜底壳硬编码 ──'); shellFallback.urls.forEach(u => log('  ' + u)); }
    log('  注:入口套 rsso2 挑战属正常形态(写 cookie _safe 即过);avjb_api.js 用法:');
    log('      node avjb_api.js --base=https://<上面任一存活域> list');
  }
  // 成功路径不 process.exit —— 让事件循环自然排空退出
})().catch(e => { console.error('✘ 未预期错误:', e); process.exitCode = 1; });
