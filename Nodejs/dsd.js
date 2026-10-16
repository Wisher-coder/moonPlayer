#!/usr/bin/env node
'use strict';
/**
 * dsd.js —— 懂色帝(dsd)发布页「最新地址」解析器(Node.js 版,零依赖,需 Node>=18)
 *
 * 解析链路(2026-10-06 实测):
 *   1. 发布页 dsd.name 本体即 Vue SPA「懂色帝最新官方网址」页(壳 ~1KB,标题/文案
 *      服务端直出,域名数据不在 HTML 里):真实入口列表硬编码在 ./files/app.<hash>.js
 *      的 r={pc:"/go1,/go2,/go3".split(","),mobile:…} —— pc/mobile 同值,均为
 *      dsd.name 自身的 /goN 跳转端点(非直接域名);
 *   2. /goN 端点两段式:首访回 200 + ~117B JS 挑战壳(document.cookie="verify_token=
 *      pass;Max-Age=3600";location.reload())——写 cookie verify_token=pass 原地
 *      重取即出 HTTP 302,Location 即当前入口域(实测 go1→www.dsd901.lol 轮换域,
 *      go2/go3→www.dsd.com.se 永久域);页面 favicon.ico 测速排序纯客户端行为;
 *   3. 官方永久域:dsd900.com / dsd.com.se(发布页 app.js 同库站群,macCMS 内核);
 *      dsd.lol 为搜索框提示的「永久网址」但实测本体也是 verify_token 挑战壳,
 *      过门后 302 跳当前入口;dsd901.lol 为 go1 当前目标(高频轮换形态 dsdNNN.lol);
 *   4. ⇒ 解析器:拉发布页壳 → 提 app.js 地址 → 解析 /goN 列表 → 逐个过挑战拿 302
 *      目标即权威入口;app.js 改版/不可达时兜底内置永久域直接探测。
 *
 * 用法:
 *   node dsd.js                 # 常规输出(人读),含入口存活探测
 *   node dsd.js --json          # 纯 JSON 输出到 stdout(进度日志走 stderr)
 *   node dsd.js --no-probe      # 跳过存活探测,只解析
 *   node dsd.js dsd902.lol      # 站群轮换出新入口域时,命令行直接指定(并入探测列表)
 *
 * 退出码:0=解析出最新地址;1=发布页与内置域全部失败。仅供站方授权测试使用。
 */

// ============ 0. 配置与命令行 ============

const PUBLISH_URL = 'https://dsd.name/';          // 发布页(Vue SPA,域名数据在 app.js)
const PERMANENT_DOMAINS = ['dsd900.com', 'dsd.com.se', 'dsd.lol'];   // 官方永久/提示域
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

async function fetchText(url, timeoutMs, cookie) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('超时(' + timeoutMs + 'ms)')), timeoutMs);
  try {
    const headers = {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/json,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    };
    if (cookie) headers['Cookie'] = cookie;
    const res = await fetch(url, { redirect: 'manual', signal: ac.signal, headers });
    return { status: res.status, location: res.headers.get('location') || '', text: await res.text() };
  } finally { clearTimeout(timer); }
}

// ============ 2. 解析核心 ============

// 发布页壳 → app.js 地址(./files/app.<hash>.js?… 相对路径绝对化)
function extractAppJs(html) {
  const m = html.match(/<script src="(\.\/files\/app\.[a-f0-9]+\.js[^"]*)"/i);
  return m ? new URL(m[1].replace(/^\.\//, '/'), PUBLISH_URL).href : null;
}

// app.js → /goN 跳转端点列表(r={pc:"/go1,…".split(","),mobile:"…" 同形态,并集去重)
function extractGoPaths(appJs) {
  const out = [];
  for (const m of appJs.matchAll(/\{[^{}]*pc\s*:\s*"([^"]*)"\.split\([^)]*\)[^{}]*mobile\s*:\s*"([^"]*)"/g)) {
    for (const list of [m[1], m[2]]) for (const p of list.split(',')) {
      const t = p.trim();
      if (/^\/[A-Za-z0-9_-]+$/.test(t)) out.push(t);
    }
  }
  return [...new Set(out)];
}

// /goN 端点 → 当前入口域:首访 verify_token 挑战壳 → 写 cookie 重取 → 302 Location
async function resolveGo(goPath) {
  const url = new URL(goPath, PUBLISH_URL).href;
  let cookie = '';
  for (let hop = 0; hop < 3; hop++) {
    const r = await fetchText(url, FETCH_TIMEOUT_MS, cookie);
    if (r.status >= 300 && r.status < 400 && r.location) return r.location;
    if (/document\.cookie\s*=\s*"verify_token=pass/.test(r.text)) { cookie = 'verify_token=pass'; continue; }
    throw new Error(goPath + ' 非 302 亦非挑战壳(HTTP ' + r.status + ', ' + r.text.slice(0, 60).replace(/\s+/g, ' ') + ')');
  }
  throw new Error(goPath + ' 挑战层数超限');
}

// 主解析:发布页壳 → app.js → /goN 列表 → 逐个过挑战拿入口域
async function resolveFromPublish() {
  const r = await fetchText(PUBLISH_URL, FETCH_TIMEOUT_MS);
  if (r.status >= 400) throw new Error('发布页 HTTP ' + r.status);
  const appJs = extractAppJs(r.text);
  if (!appJs) throw new Error('发布页壳无 app.js 引用(改版?)');
  const js = await fetchText(appJs, FETCH_TIMEOUT_MS);
  const goes = extractGoPaths(js.text);
  if (!goes.length) throw new Error('app.js 未解析出 pc/mobile 跳转端点(混淆改版?)');
  const entries = [];
  for (const g of goes) {
    try {
      const target = await resolveGo(g);
      const host = target.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
      if (host) entries.push({ go: g, url: target, host });
    } catch (e) { log('  × ' + g + ' 解析失败(' + e.message + ')'); }
  }
  if (!entries.length) throw new Error('全部 /goN 端点未产出入口域');
  return entries;
}

// ============ 3. 存活探测(单次 GET,不重试;挑战壳=活) ============

async function probe(host) {
  try {
    const r = await fetchText('https://' + host + '/', PROBE_TIMEOUT_MS);
    // 挑战壳/MacCMS 页/任意状态码都算"域名活着在服务",如实报形态
    const form = /document\.cookie\s*=\s*"verify_token=pass/.test(r.text)
      ? 'verify_token 挑战壳'
      : /\/index\.php\/vod\/(play|type)|\/MDassets\//.test(r.text) ? 'MacCMS 页' : (r.status === 200 ? '其他页' : 'HTTP ' + r.status);
    return { ok: true, status: r.status, form };
  } catch (e) {
    return { ok: false, err: (e && e.message) || String(e) };
  }
}

// ============ 4. 主流程与输出 ============

(async () => {
  log('懂色帝发布页最新地址解析(v1.0.0,发布页: ' + PUBLISH_URL + ')');

  let entries = [], source = PUBLISH_URL;
  try {
    entries = await resolveFromPublish();
    log('· /goN 端点 → ' + entries.map(e => e.host + '(' + e.go + ')').join(' , '));
  } catch (e) {
    if (AS_JSON) console.log(JSON.stringify({ success: false, errors: [e.message] }));
    else {
      log('✘ 发布页解析失败: ' + e.message);
      log('  注:可命令行传入入口域直接探测,如: node dsd.js dsd901.lol');
    }
    process.exitCode = 1;
    return;
  }

  const hosts = [...new Set([...extraHosts, ...entries.map(e => e.host), ...PERMANENT_DOMAINS])];

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
      entries,                    // /goN 端点解析出的当前入口(权威源)
      permanentDomains: PERMANENT_DOMAINS,
      extra: extraHosts,
      hosts: results,
    }, null, 2));
  } else {
    const badge = p => !p ? '' : p.ok ? '  [✓ ' + p.form + ']' : '  [✗ ' + p.err + ']';
    log('✔ 解析成功(来源: ' + source + ', ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ')');
    log('  ── 当前入口(/goN 过挑战 302)──');
    entries.forEach((e, i) => log('  [' + (i + 1) + '] ' + e.url + '  ← ' + e.go + badge((results.find(r => r.host === e.host) || {}).probe)));
    log('  ── 永久/提示域 ──');
    PERMANENT_DOMAINS.forEach(h => log('  https://' + h + '/' + badge((results.find(r => r.host === h) || {}).probe)));
    const extras = results.filter(r => !entries.some(e => e.host === r.host) && !PERMANENT_DOMAINS.includes(r.host));
    if (extras.length) { log('  ── 命令行指定 ──'); extras.forEach(r => log('  https://' + r.host + '/' + badge(r.probe))); }
    log('  注:入口/永久域偶套 verify_token 挑战属正常形态(写 cookie verify_token=pass 即过);');
    log('      dsd_api.js 用法: node dsd_api.js --base=https://<上面任一存活域> list');
  }
  // 成功路径不 process.exit —— 让事件循环自然排空退出
})().catch(e => { console.error('✘ 未预期错误:', e); process.exitCode = 1; });
