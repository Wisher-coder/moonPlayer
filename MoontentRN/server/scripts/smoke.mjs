// ============================================================================
// 冒烟测试脚本(smoke)
// ----------------------------------------------------------------------------
// 用法:node scripts/smoke.mjs <site...> | all [--json]
//   - 指定站点模式:逐个探测命名站点,任一站失败 exit 1;
//   - all 模式:探测 10 个主站(yuese avjb aidou hanxiucao zimuquan dsd bf
//     llw 91pron telegram——telegram 为账号绑定站点,未登录时记「未登录,跳过」
//     不计失败),失败达 3 个及以上、或 /api/sites 失败才 exit 1;单站失败
//     打印 ⚠ 但退出码 0;另从 /api/sites 取前 3 个 zy_ 资源站探测并计入
//     JSON(不计入退出码);
//   - --json:stdout 只输出完整 JSON 数组 [{site,ok,note}...](无论成败都
//     输出),诊断信息全部走 stderr。
// 流程:import createApp → 随机端口 listen → GET /api/sites(取能力表与 zy
// 清单)→ 逐站请求 meta 与 home(无 home 能力的站用 list 第一页)→ 汇总退出。
// ============================================================================
import { writeSync } from 'node:fs';
import { createApp } from '../src/index.js';

// 输出通道:全部走同步 writeSync(Windows 下 process.exit 与异步管道写出存在
// libuv 竞态,异步 write 的残段会炸掉退出码——同步写规避之)
const writeErr = (s) => { try { writeSync(2, s); } catch (e) { /* 管道已断 */ } };
const writeOut = (s) => { try { writeSync(1, s); } catch (e) { /* 管道已断 */ } };

// —— 参数解析:--json 全局标志;all 或站点名列表二选一 ——
const argv = process.argv.slice(2);
const jsonMode = argv.includes('--json');
const targets = argv.filter((a) => a !== '--json');
const allMode = targets.includes('all');
const siteArgs = allMode ? [] : targets;

// 用法守卫:既没有 all 也没有任何站点名才报用法(all 模式下 siteArgs 恒为空属正常)
if (!allMode && siteArgs.length === 0) {
  writeErr('用法:node scripts/smoke.mjs <site...> | all [--json]\n');
  process.exit(2);
}

// all 模式的 10 个主站(顺序即探测顺序;telegram 数据面需登录,见下方登录门禁)
const MAIN_SITES = ['yuese', 'avjb', 'aidou', 'hanxiucao', 'zimuquan', 'dsd', 'bf', 'llw', '91pron', 'telegram'];
const MAIN_FAIL_LIMIT = 3;      // 主站失败达 3 个及以上才判整体失败
const ZY_PROBE_COUNT = 3;       // all 模式额外探测的 zy_ 资源站数(不计退出码)
const REQ_TIMEOUT_MS = 45000;   // 单请求上限:插件内部链路 15s,留足冷启动余量

// 日志出口:--json 模式 stdout 只留给最终 JSON 数组,其余全部走 stderr
const log = (...a) => writeErr(a.join(' ') + '\n');

// 随机取一个 30000~39999 的端口,避免与常驻服务冲突
const PORT = 30000 + Math.floor(Math.random() * 10000);
const app = createApp();
const server = app.listen(PORT);
await new Promise((resolve) => server.once('listening', resolve));
const BASE = `http://127.0.0.1:${PORT}`;

// 单请求:超时兜底,失败抛 Error(带可读 message),成功回解析后的 JSON 对象
async function getJson(path) {
  let res;
  try {
    res = await fetch(BASE + path, { signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' || e.name === 'AbortError' ? `请求超时(${REQ_TIMEOUT_MS / 1000}s)` : `网络错误:${e.message}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // 错误契约:HTTP 4xx/5xx + {__err:1,message}(消息缺失时退化到状态码)
    const err = new Error(body && body.message ? body.message : `HTTP ${res.status}`);
    err.status = res.status;   // 供探测层识别「无 home 能力」的分发层 404
    throw err;
  }
  if (!body || body.__err) throw new Error(body && body.message ? body.message : '响应体异常');
  return body;
}

// 从 home/list 响应里数条数:home 契约 {list:{items}},list 契约 {items}
function extractCount(out, isHome) {
  const items = isHome ? out && out.list && out.list.items : out && out.items;
  return Array.isArray(items) ? items.length : null;
}

// 探测单个站点:meta + (home 或 list 第一页)。
// capsHome 三态:true 有 home / false 无 home(直接走 list)/ undefined 能力
// 未知(清单接口不可用,先试 home、识别出「无 home 能力」信号后回退 list)。
// 返回 { site, ok, note }:note = 条数(成功)或错误信息。
async function probeSite(site, capsHome) {
  let metaOk = false;
  try {
    const meta = await getJson(`/api/${site}/meta`);
    metaOk = meta && meta.id === site;
    if (!metaOk) throw new Error('meta 返回的站点 id 与请求不符');
  } catch (e) {
    return { site, ok: false, note: `meta ${e.message}` };
  }

  // 选面:能力表明确无 home → 直接 list;能力表有 home → 只试 home;
  // 能力未知(清单接口不可用)→ 先试 home,拿到「无 home 能力」信号
  // (分发层 404,或插件基类抛「不支持此接口:home」被网关转成的 502)再回退 list
  const tryOne = async (isHome) => {
    try {
      const out = await getJson(isHome ? `/api/${site}/home` : `/api/${site}/list?page=1&size=24`);
      const n = extractCount(out, isHome);
      const method = isHome ? 'home' : 'list';
      return { site, ok: true, note: n === null ? `${method} 通过(未解析出条数)` : `${method} ${n} 条` };
    } catch (e) {
      e.isNoHome = isHome && (e.status === 404 || /不支持此接口/.test(e.message || ''));
      throw e;
    }
  };
  if (capsHome === false) return tryOne(false);
  try {
    return await tryOne(true);
  } catch (e) {
    if (capsHome === undefined && e.isNoHome) return tryOne(false);
    return { site, ok: false, note: `home ${e.message}` };
  }
}

// telegram 登录门禁:账号绑定站点,未登录时数据面必 502(needLogin)。探测前先
// GET /api/telegram/session——未 authorized 直接记「未登录,跳过」(ok=true 不计
// 失败,也不发 meta/list,避免无凭据环境下 all 模式必挂);已登录回 null 走常规
// 探测。session 端点自身异常也回 null 让常规探测如实报出问题,不静默吞掉。
async function telegramLoginGate() {
  try {
    const s = await getJson('/api/telegram/session');
    if (s && s.authorized === true) return null;
    return { site: 'telegram', ok: true, note: '未登录,跳过' };
  } catch (_e) {
    return null;
  }
}

const results = [];
let sitesOk = true;   // /api/sites 是否可用(all 模式计入退出码)
let caps = new Map(); // id → capabilities.home(三态:false 无 home / true 有 / 缺省未知)

// —— 第一步:GET /api/sites(能力表 + all 模式的 zy 清单) ——
let zySites = [];
try {
  const list = await getJson('/api/sites');
  if (!Array.isArray(list)) throw new Error('清单不是数组(响应结构与约定不符)');
  for (const s of list) {
    if (s && typeof s.id === 'string' && s.capabilities && typeof s.capabilities === 'object') {
      caps.set(s.id, s.capabilities.home === true);
    }
  }
  zySites = list.map((s) => (s && typeof s.id === 'string' ? s.id : '')).filter((id) => id.startsWith('zy_'));
  log(`[smoke] /api/sites ✓ 共 ${list.length} 个站点(其中 zy_ 资源站 ${zySites.length} 个)`);
} catch (e) {
  sitesOk = false;
  log(`[smoke] /api/sites ✗ ${e.message}`);
}

// —— 第二步:逐站探测(telegram 先过登录门禁,未登录记跳过) ——
const sitesToProbe = allMode ? MAIN_SITES.slice() : siteArgs.slice();
for (const site of sitesToProbe) {
  let r = site === 'telegram' ? await telegramLoginGate() : null;
  if (!r) r = await probeSite(site, caps.has(site) ? caps.get(site) : undefined);
  results.push(r);
  log(`[smoke] ${r.site} ${r.ok ? '✓' : '✗'} ${r.note}`);
}

// —— 第三步(all 模式):前 3 个 zy_ 资源站附加探测(不计退出码) ——
const zyResults = [];
if (allMode && sitesOk) {
  for (const site of zySites.slice(0, ZY_PROBE_COUNT)) {
    const r = await probeSite(site, caps.has(site) ? caps.get(site) : undefined);
    zyResults.push(r);
    log(`[smoke] ${r.site} ${r.ok ? '✓' : '✗'} ${r.note}(zy 探测,不计入门禁)`);
  }
}

const finalResults = results.concat(zyResults);

// —— 输出与退出码 ——
// --json:stdout 只输出完整 JSON 数组(成败都输出);普通模式逐行汇总。
// 输出先于关服完成:同步 writeSync 已落管道,与之后的 close/exit 无竞态
const mainFails = results.filter((r) => !r.ok);
let exitCode;

if (allMode) {
  exitCode = (!sitesOk || mainFails.length >= MAIN_FAIL_LIMIT) ? 1 : 0;
  if (!jsonMode) {
    if (!sitesOk) writeOut('⚠ /api/sites 不可用 → 退出码 1\n');
    if (mainFails.length > 0 && exitCode === 0) {
      writeOut(`⚠ ${mainFails.length} 个主站失败(未达 ${MAIN_FAIL_LIMIT} 个阈值,退出码 0):${mainFails.map((r) => r.site).join(' ')}\n`);
    }
  }
} else {
  exitCode = mainFails.length > 0 ? 1 : 0;
}

if (jsonMode) {
  writeOut(JSON.stringify(finalResults) + '\n');
} else {
  for (const r of finalResults) {
    writeOut(`${r.site} ${r.ok ? '✓' : '✗'} ${r.note}\n`);
  }
  const okCount = finalResults.filter((r) => r.ok).length;
  log(`[smoke] 完成:成功 ${okCount}/${finalResults.length},退出码 ${exitCode}`);
}

// —— 收尾:关服后留一小段排空窗口再硬退 ——
// Windows 下 process.exit 与在途 libuv 句柄(server 侧 keep-alive 连接、/api/sites
// 触发的 warmAll 后台预热链路、cms 清单探测的 socket/定时器)存在竞态,直接退
// 会以 UV_HANDLE_CLOSING 断言炸掉退出码:先切连接、等 close 完成,再等 timers
// 排空一轮后才 process.exit,拿到确定性的退出码
server.closeAllConnections?.();
await new Promise((resolve) => server.close(() => resolve()));
await new Promise((resolve) => setTimeout(resolve, 250));
server.closeAllConnections?.();
process.exit(exitCode);
