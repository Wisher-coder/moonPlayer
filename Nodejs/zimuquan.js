#!/usr/bin/env node
'use strict';
/**
 * zimuquan.js —— 字母圈发布页「最新地址」解析器(Node.js 版,零依赖,需 Node>=18)
 *
 * 解析链路(2026-10-06 实测):
 *   1. 官方回家发布页 www.zmqurl7.top(数字段轮换:页面自述打不开时 5→6→7…往下试,
 *      页面还会给出备用发布页 www.zmqsite.top / zmqsite1.top…):纯静态 HTML,
 *      零混淆零脚本渲染——全部入口域名硬编码在 DOM 里;
 *   2. 页面结构:.site-url 元素的 data-url 属性即入口地址:
 *        - .site-url.mobile-glow 为「最新网址」(首位,权威入口);
 *        - .btn.site-url 为「备用网址一~十七」(速度更快/移动推荐等);
 *        - APP 下载(down.mediainfokorupsi.com)不是网页入口,单列不入探测列表;
 *      ⇒ 直接正则抽 data-url 即可,无 dom.php 类动态接口、无混淆壳兜底需求;
 *   3. 入口域形态 wwwN.zimuquanNN.{com|uk|top}(数字两段轮换,高频换批),
 *      实测全部同壳同库(同字节响应,仅 CDN 缓存态不同)——任一存活域可作
 *      zimuquan_api.js 的 --base;主站页面另有内嵌 maccms.url 指向站点自记录域,
 *      仅作交叉印证,不参与探测;
 *   4. 入口域无 rsso2 挑战无年龄门,GET 即回 atob+URI 双层编码的整页 HTML
 *      (站方反扒壳,解码见 zimuquan_api.js)——探测时任意 HTML 即「活」。
 *
 * 用法:
 *   node zimuquan.js                 # 常规输出(人读),含入口存活探测
 *   node zimuquan.js --json          # 纯 JSON 输出到 stdout(进度日志走 stderr)
 *   node zimuquan.js --no-probe      # 跳过存活探测,只解析
 *   node zimuquan.js www2.xxx.com    # 站群轮换出新入口域时,命令行直接指定(并入探测列表)
 *
 * 退出码:0=解析出最新地址;1=发布页抓取/解析失败。仅供站方授权测试使用。
 */

// ============ 0. 配置与命令行 ============

const PUBLISH_URL = 'https://www.zmqurl7.top/';   // 回家发布页(数字段轮换,5→6→7…)
const APP_HOST = 'down.mediainfokorupsi.com';      // APP 下载域(非网页入口,单列)
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
      },
    });
    return { status: res.status, finalUrl: res.url || url, text: await res.text() };
  } finally { clearTimeout(timer); }
}

// ============ 2. 解析核心(静态 DOM 直抽,无兜底层级) ============

// 发布页整页静态:按 DOM 顺序抽 .site-url 的 data-url;mobile-glow(最新网址)排首,
// APP 下载域剔除;备用发布页(zmqsite 系)从提示文案里补捞,供发布页本身失联时人肉换源
async function resolveFromPublish() {
  const r = await fetchText(PUBLISH_URL, FETCH_TIMEOUT_MS);
  if (r.status >= 400) throw new Error('发布页 HTTP ' + r.status);
  const html = r.text;
  if (!/site-url/.test(html)) throw new Error('发布页无 .site-url 元素(改版?)');

  const entries = [];   // data-url 依 DOM 顺序(最新网址在最前)
  for (const m of html.matchAll(/data-url="(https?:\/\/[^"]+)"/g)) {
    const host = m[1].replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (host === APP_HOST) continue;          // APP 下载不是网页入口
    if (!entries.includes(host)) entries.push(host);
  }
  if (!entries.length) throw new Error('发布页未产出任何入口域名');

  // 备用回家发布页(文案形态「www.zmqsite.top;打不开时www.zmqsite1.top」)
  const publishFallback = [...new Set((html.match(/www\.zmqsite\d*\.top/g) || []))];

  // 交叉印证:发布页自身地址(数字段),供轮换后回溯
  const selfHost = (PUBLISH_URL.match(/www\.zmqurl\d+\.top/) || [''])[0];
  return { entries, publishFallback, selfHost };
}

// ============ 3. 存活探测(单次 GET,不重试;任意 HTML 即活) ============

async function probe(host) {
  try {
    const r = await fetchText('https://' + host + '/', PROBE_TIMEOUT_MS);
    // 入口域无挑战门:200+atob 编码壳即完整服务;其他状态码如实报形态
    const form = /atob\("/.test(r.text) ? 'maccms 编码壳' : (r.status === 200 ? 'HTML' : 'HTTP ' + r.status);
    return { ok: r.status < 500, status: r.status, form };
  } catch (e) {
    return { ok: false, err: (e && e.message) || String(e) };
  }
}

// ============ 4. 主流程与输出 ============

(async () => {
  log('字母圈发布页最新地址解析(v1.0.0,发布页: ' + PUBLISH_URL + ')');

  let res;
  try {
    res = await resolveFromPublish();
  } catch (e) {
    if (AS_JSON) console.log(JSON.stringify({ success: false, errors: [String(e.message)] }));
    else { log('✘ 发布页解析失败: ' + e.message); log('  提示:发布页数字段轮换,试 www.zmqurl5/6/8….top 或备用系 www.zmqsite.top'); }
    process.exitCode = 1;
    return;
  }
  const { entries, publishFallback, selfHost } = res;
  log('· 发布页产出 ' + entries.length + ' 个入口域(最新网址: ' + entries[0] + ')');
  if (publishFallback.length) log('· 备用发布页: ' + publishFallback.join(' , '));

  const hosts = [...new Set([...extraHosts, ...entries])];

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
      success: true, source: PUBLISH_URL,
      latest: entries[0],            // 「最新网址」(权威入口)
      entries,                       // 发布页全部入口(dom 顺序)
      appDownload: 'https://' + APP_HOST + '/',
      publishFallback,               // 备用回家发布页(zmqsite 系)
      extra: extraHosts,
      hosts: results,
    }, null, 2));
  } else {
    const badge = p => !p ? '' : p.ok ? '  [✓ ' + p.form + ']' : '  [✗ ' + p.err + ']';
    log('✔ 解析成功(来源: ' + PUBLISH_URL + (selfHost ? ',自记录 ' + selfHost : '') + ')');
    log('  ── 最新网址 ──');
    log('  https://' + entries[0] + '/' + badge((results.find(r2 => r2.host === entries[0]) || {}).probe));
    log('  ── 备用入口(共 ' + (entries.length - 1) + ' 个,' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ')──');
    entries.slice(1).forEach((h, i) => log('  [' + String(i + 1).padStart(2, '0') + '] https://' + h + '/' + badge((results.find(r2 => r2.host === h) || {}).probe)));
    if (extraHosts.length) { log('  ── 命令行指定 ──'); extraHosts.forEach(h => log('  https://' + h + '/' + badge((results.find(r2 => r2.host === h) || {}).probe))); }
    log('  APP 下载: https://' + APP_HOST + '/   备用发布页: ' + (publishFallback.join(' , ') || '(页面未给出)'));
    log('  注:入口域全部同壳同库,任一存活域可作基座;zimuquan_api.js 用法:');
    log('      node zimuquan_api.js --base=https://<上面任一存活域> list');
  }
  // 成功路径不 process.exit —— 让事件循环自然排空退出
})().catch(e => { console.error('✘ 未预期错误:', e); process.exitCode = 1; });
