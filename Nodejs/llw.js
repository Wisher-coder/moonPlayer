#!/usr/bin/env node
'use strict';
/**
 * llw.js —— 萝莉窝(llw / daga88n)「最新地址」解析器(Node.js 版,零依赖,需 Node>=18)
 *
 * 解析链路(2026-10-06 实测):
 *   1. 萝莉窝与懂色帝(dsd)同一套 MacCMS 源码(「形态 A:媒体外部存储」),但发布面薄:
 *      站内无发布页/无 /goN 跳转端点,搜索框仅公布「永久网址 n744.com」;
 *   2. n744.com 本体是 302 跳转:实测 Location→91117.top——并非入口,而是运营商标识下的
 *      「.top 域名跳转」模拟地址栏页(输入前缀 N 拼 https://N.top,5KB 静态页);
 *      入口域挂了只能靠该跳板页人肉找回(91117 即媒体存储节点 pp.91117.top 的运营商标识);
 *   3. 当前入口 daga88n.com 直连 200(MacCMS 页,无挑战壳);媒体/海报全挂外部存储
 *      pp.{标识}.top:22200/{日期}/{随机8}/——pp 基座从入口页海报 URL 动态提取,
 *      运营商标识轮换自适应(勿硬编码);
 *   4. ⇒ 解析器:拉入口页 → 提取 pp 存储基座 → 记录 n744 302 目标 → 逐域名存活探测;
 *      无权威「最新地址」接口,入口轮换时用命令行传新域直接探测(node llw.js 新域.com)。
 *
 * 用法:
 *   node llw.js                 # 常规输出(人读),含入口存活探测
 *   node llw.js --json          # 纯 JSON 输出到 stdout(进度日志走 stderr)
 *   node llw.js --no-probe      # 跳过存活探测,只解析
 *   node llw.js daga89n.com     # 站群轮换出新入口域时,命令行直接指定(并入探测列表)
 *
 * 退出码:0=解析成功;1=全部失败。仅供站方授权测试使用。
 */

// ============ 0. 配置与命令行 ============

const ENTRY_HOSTS = ['daga88n.com', 'www.daga88n.com'];   // 实测入口(站群轮换时命令行传新域)
const PERMANENT_DOMAINS = ['n744.com'];                    // 搜索框公布「永久网址」(302 跳板,非入口)
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
      redirect: 'manual', signal: ac.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/json,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    return { status: res.status, location: res.headers.get('location') || '', text: await res.text() };
  } finally { clearTimeout(timer); }
}

// ============ 2. 解析核心 ============

// 入口页 → pp 外部存储基座(海报/资产 URL 形如 https://pp.91117.top:22200/…,运营商标识轮换自适应)
function extractPpBases(html) {
  return [...new Set([...html.matchAll(/https?:\/\/(pp\.[a-z0-9.-]+:\d+)\//gi)].map(m => 'https://' + m[1]))];
}

// 永久域 302 目标(n744.com → 当前 91117.top 跳板页;仅信息展示,非入口)
async function resolvePermanentTarget(host) {
  const r = await fetchText('https://' + host + '/', FETCH_TIMEOUT_MS);
  if (r.status >= 300 && r.status < 400 && r.location) return r.location;
  return null;
}

// ============ 3. 存活探测(单次 GET,不重试;挑战壳/403=活) ============

async function probe(host) {
  try {
    const r = await fetchText('https://' + host + '/', PROBE_TIMEOUT_MS);
    const form = /document\.cookie\s*=\s*"verify_token=pass/.test(r.text)
      ? 'verify_token 挑战壳'
      : /\/index\.php\/vod\/(play|type)|pp\.[a-z0-9.-]+:\d+/.test(r.text) ? 'MacCMS 页'
        : /\.top 域名跳转|模拟地址栏/.test(r.text) ? '跳板页(非入口)' : (r.status === 200 ? '其他页' : 'HTTP ' + r.status);
    return { ok: true, status: r.status, form };
  } catch (e) {
    return { ok: false, err: (e && e.message) || String(e) };
  }
}

// ============ 4. 主流程与输出 ============

(async () => {
  log('萝莉窝最新地址解析(v1.0.0,入口: https://' + ENTRY_HOSTS[0] + '/)');

  // 主解析:入口页 → pp 存储基座;永久域 302 目标记录
  let ppBases = [], permTarget = null;
  const errors = [];
  try {
    const r = await fetchText('https://' + ENTRY_HOSTS[0] + '/', FETCH_TIMEOUT_MS);
    if (r.status >= 400) throw new Error('入口页 HTTP ' + r.status);
    ppBases = extractPpBases(r.text);
    if (!ppBases.length) throw new Error('入口页未提取到 pp 存储基座(改版?)');
    log('· pp 外部存储基座: ' + ppBases.join(' , '));
  } catch (e) { errors.push('入口页 —— ' + e.message); }
  try {
    permTarget = await resolvePermanentTarget(PERMANENT_DOMAINS[0]);
    log('· 永久域 ' + PERMANENT_DOMAINS[0] + ' → 302 ' + (permTarget || '(无跳转)'));
  } catch (e) { errors.push('永久域 —— ' + e.message); }

  if (!ppBases.length) {
    if (AS_JSON) console.log(JSON.stringify({ success: false, errors }));
    else {
      log('✘ 解析失败:');
      errors.forEach(m => log('  · ' + m));
      log('  注:入口域可能已轮换,可命令行传入新域直接探测,如: node llw.js 新域.com');
    }
    process.exitCode = 1;
    return;
  }

  const hosts = [...new Set([
    ...extraHosts, ...ENTRY_HOSTS, ...PERMANENT_DOMAINS,
    ...(permTarget ? [permTarget.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')] : []),
  ])];

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
      success: true, source: 'https://' + ENTRY_HOSTS[0] + '/',
      entry: ENTRY_HOSTS[0],
      ppBases,                    // 外部存储基座(海报/切片/密钥同源)
      permanent: { host: PERMANENT_DOMAINS[0], target: permTarget },
      extra: extraHosts,
      hosts: results,
    }, null, 2));
  } else {
    const badge = p => !p ? '' : p.ok ? '  [✓ ' + p.form + ']' : '  [✗ ' + p.err + ']';
    log('✔ 解析成功(' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ')');
    log('  ── 当前入口 ──');
    ENTRY_HOSTS.forEach((h, i) => log('  [' + (i + 1) + '] https://' + h + '/' + badge((results.find(r => r.host === h) || {}).probe)));
    log('  ── pp 外部存储(海报/切片/密钥同源)──');
    ppBases.forEach(b => log('  ' + b + '/  (媒体路径 {日期}/{随机8}/,须带站群域 Referer)'));
    log('  ── 永久域(302 跳板,非入口)──');
    log('  https://' + PERMANENT_DOMAINS[0] + '/' + badge((results.find(r => r.host === PERMANENT_DOMAINS[0]) || {}).probe) + '  → ' + (permTarget || '(无跳转)'));
    const extras = results.filter(r => !ENTRY_HOSTS.includes(r.host) && !PERMANENT_DOMAINS.includes(r.host) && r.host !== (permTarget || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, ''));
    if (extras.length) { log('  ── 命令行指定 ──'); extras.forEach(r => log('  https://' + r.host + '/' + badge(r.probe))); }
    log('  注:入口轮换时命令行传新域探测;llw_api.js 用法: node llw_api.js --base=https://<任一存活入口> list');
  }
  // 成功路径不 process.exit —— 让事件循环自然排空退出
})().catch(e => { console.error('✘ 未预期错误:', e); process.exitCode = 1; });
