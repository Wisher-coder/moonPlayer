// ============================================================================
// 后端启动自检脚本（boot-check）
// ----------------------------------------------------------------------------
// 流程：import createApp → 随机端口 listen → GET /api/sites 断言 200 →
// 打印 OK 并 exit 0；任一步失败 exit 1。
// 用法：node MoontentRN/server/scripts/boot-check.mjs
// ============================================================================

import { createApp } from '../src/index.js';

// 随机取一个 30000~39999 的端口，避免与常驻服务冲突
const PORT = 30000 + Math.floor(Math.random() * 10000);

const app = createApp();
const server = app.listen(PORT);

// 等待端口就绪后再发起请求
await new Promise((resolve) => server.once('listening', resolve));

let exitCode = 0;
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/sites`);
  if (res.status !== 200) {
    throw new Error(`HTTP 状态码异常：${res.status}`);
  }
  const body = await res.json();
  // 断言与 NextWeb 一致的裸数组契约:GET /api/sites → [{id,name,capabilities,group}]
  if (!Array.isArray(body)) {
    throw new Error('响应体不是站点数组');
  }
  console.log(`[boot-check] GET /api/sites → 200 ${JSON.stringify(body)}`);
  console.log('OK');
} catch (err) {
  console.error(`[boot-check] 自检失败：${err.message}`);
  exitCode = 1;
} finally {
  // Windows 下直接 process.exit 会与 libuv 关闭流程竞态（UV_HANDLE_CLOSING 断言），
  // 故先切断 keep-alive 残余连接，再等 close 完成后才退出
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

process.exit(exitCode);
