// ============================================================================
// 静态托管验收脚本(serve-check)
// ----------------------------------------------------------------------------
// 目的:验证「expo export 产物由后端单服务托管」这条生产链路——
//   以 SERVE_DIST=../app/dist 起 createApp(与 npm start 生产形态一致,
//   koa-static 托管前端 dist),断言:
//   ① GET /           → 200 且 HTML 含应用根挂载点 <div id="root">
//                       (Expo Web 导出的固定挂载点,缺失说明托管的不是前端产物);
//   ② GET /api/sites  → 200(站点清单接口,后端数据面就绪)。
//   两项全过打印 OK 并 exit 0;任一失败打印原因并 exit 1。
// 前置:app/dist 已由 `npm --prefix ../app run export` 产出;目录缺失时
//   直接以明确报错退出(提示先跑 export),不静默跳过静态断言。
// 用法:node MoontentRN/server/scripts/serve-check.mjs
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// —— 定位 server 根与 app/dist(相对本脚本推导,与调用方 cwd 无关) ——
const __filename = fileURLToPath(import.meta.url);
const SERVER_ROOT = path.resolve(path.dirname(__filename), '..');
const DIST_DIR = path.resolve(SERVER_ROOT, '../app/dist');

// dist 前置检查:缺失即失败退出(此处不能用静态 import createApp——
// 那样会在本检查之前就触发模块加载,报错信息不友好)
if (!fs.existsSync(DIST_DIR)) {
  console.error(`[serve-check] 失败:前端产物目录不存在:${DIST_DIR}`);
  console.error('[serve-check] 请先执行:npm --prefix MoontentRN/app run export');
  process.exit(1);
}

// —— 以 SERVE_DIST 环境变量指向 dist 起 createApp(生产同款路径) ——
// 必须在动态 import 之前设置:静态 import 会被提升到赋值之前执行,
// createApp 在调用时才读 process.env.SERVE_DIST,但保持「先设后载」
// 让语义一目了然,也不受未来改为加载期读取的影响
process.env.SERVE_DIST = path.relative(SERVER_ROOT, DIST_DIR);
const { createApp } = await import('../src/index.js');

// 随机取一个 30000~39999 的端口,避免与常驻服务冲突
const PORT = 30000 + Math.floor(Math.random() * 10000);

const app = createApp();
const server = app.listen(PORT);

// 等待端口就绪后再发起请求
await new Promise((resolve) => server.once('listening', resolve));
const BASE = `http://127.0.0.1:${PORT}`;

let exitCode = 0;
try {
  // ① 首页:200 + HTML 含应用根挂载点
  const home = await fetch(`${BASE}/`);
  if (home.status !== 200) throw new Error(`GET / 状态码异常:${home.status}`);
  const html = await home.text();
  if (!/<div[^>]+id="root"/.test(html)) {
    throw new Error('GET / 的 HTML 未找到应用根挂载点 <div id="root">');
  }
  console.log(`[serve-check] GET / → 200(HTML ${html.length} 字节,含根挂载点)`);

  // ② 站点清单:200 + 裸数组(与 boot-check 同口径的契约断言)
  const sites = await fetch(`${BASE}/api/sites`);
  if (sites.status !== 200) throw new Error(`GET /api/sites 状态码异常:${sites.status}`);
  const list = await sites.json();
  if (!Array.isArray(list)) throw new Error('GET /api/sites 响应体不是站点数组');
  console.log(`[serve-check] GET /api/sites → 200(共 ${list.length} 个站点)`);

  console.log('OK');
} catch (err) {
  console.error(`[serve-check] 自检失败:${err.message}`);
  exitCode = 1;
} finally {
  // —— 收尾:关服后留一小段排空窗口再硬退 ——
  // Windows 下 process.exit 与在途 libuv 句柄(server 侧 keep-alive 连接、
  // /api/sites 触发的 warmAll 后台预热链路、cms 清单探测的 socket/定时器)
  // 存在竞态,直接退会以 UV_HANDLE_CLOSING 断言炸掉退出码(与 smoke.mjs
  // 同源问题):先切连接、等 close 完成,再等 timers 排空一轮、补切一次
  // 残余连接后才 process.exit,拿到确定性的退出码
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 250));
  server.closeAllConnections?.();
}

process.exit(exitCode);
