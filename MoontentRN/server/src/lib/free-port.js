// ============================================================================
// 端口占用自动清理（server 启动自愈）
// ----------------------------------------------------------------------------
// 背景：上一轮 `npm start` 的旧进程仍监听主端口（终端被关但 node 存活 /
// npm 后台残留），新一轮启动直接 EADDRINUSE 崩溃，只能手动 lsof+kill。
// 本模块在主端口 listen 之前接管清理：
//   定位「仅 LISTEN 状态」的占用进程 → 逐个 SIGTERM（3s 宽限）→ 仍存活则
//   SIGKILL（再 2s）→ 复核端口已无监听者。挂在端口上的客户端连接
//   （CLOSE_WAIT/ESTABLISHED）不是监听者，不会被触碰。
// 平台：macOS/Linux 走 lsof -t（Linux 无 lsof 时退回 ss -ltnp 解析 pid=）；
//   Windows 走 netstat -ano 解析 LISTENING 行。工具缺失/无权限时如实返回
//   失败，绝不静默吞掉占用。
// 安全边界：跳过本进程与 PID 1；kill 报 EPERM（无权限，占用者属其他用户/
// 系统服务）时点名 PID 留给人工处理；清理后仍被占用则返回 false，由调用方
// 决定退出。与 cli.js 的「探测复用」不冲突：cli 只在端口空闲时才 spawn 本
// 服务，不会触发这里的清理。
// ============================================================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// —— 统一的命令执行：5s 超时；任何失败（工具不存在/非零退出）返回空串 ——
function run(cmd, args) {
  return execFileAsync(cmd, args, { windowsHide: true, timeout: 5000 })
    .then(({ stdout }) => stdout)
    .catch(() => '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 找出监听 port 的全部进程 PID（去重；不含本进程与 PID 1）
 * @param {number} port 端口号
 * @returns {Promise<number[]>} 监听者 PID 列表，可能为空
 */
async function listenerPids(port) {
  const pids = new Set();
  if (process.platform === 'win32') {
    // netstat -ano -p tcp：本地地址列（cols[1]）以 :port 结尾且状态为
    // LISTENING 的行，取末列 PID。endswith 带冒号前缀，不会误配 30010。
    const out = await run('netstat', ['-ano', '-p', 'tcp']);
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 5 && cols[1].endsWith(`:${port}`) && /LISTENING/i.test(cols[3])) {
        const pid = Number(cols[cols.length - 1]);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
    }
  } else {
    // lsof -t + -sTCP:LISTEN：只列监听套接字持有者的 PID，天然排除客户端连接。
    // 注意：lsof 对「持有者已消亡/无法归属」的套接字会报 PID 0——绝不能收
    // 进列表（POSIX kill(0,·) 等于给自己整个进程组发信号，会当场自杀）。
    let out = await run('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN']);
    if (!out.trim() && process.platform === 'linux') {
      // 无 lsof 的 Linux 退路：ss -ltnp（跳过表头），本地地址列（cols[3]）
      // 以 :port 结尾的行内解析 pid=（users:(("node",pid=123,fd=12))）
      const ss = await run('ss', ['-ltnp']);
      for (const line of ss.split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length >= 4 && cols[3].endsWith(`:${port}`)) {
          const m = line.match(/pid=(\d+)/);
          const pid = Number(m?.[1]);
          if (Number.isInteger(pid) && pid > 0) pids.add(pid);
        }
      }
    }
    for (const tok of out.split(/\s+/)) {
      const pid = Number(tok);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  pids.delete(process.pid); // 绝不自杀
  pids.delete(1);           // PID 1 = launchd/systemd 等 init，永不可杀
  return [...pids];
}

// —— 占用者的命令行描述（日志留痕，方便确认杀的是旧实例而非误伤） ——
async function describePid(pid) {
  if (process.platform === 'win32') {
    const out = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    return (out.split(',')[0] || '').replace(/"/g, '') || `PID ${pid}`;
  }
  const out = await run('ps', ['-p', String(pid), '-o', 'command=']);
  return out.trim() || `PID ${pid}`;
}

// —— 进程是否仍存活：kill(pid,0) 探测；EPERM = 在但无权限，按存活计 ——
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * 自动清理 port 上的监听进程（SIGTERM → 宽限 → SIGKILL → 复核）
 * @param {number} port 端口号
 * @returns {Promise<boolean>} 端口已无监听者返回 true；仍被占用返回 false
 */
export async function freePort(port) {
  let pids = await listenerPids(port);
  if (!pids.length) return true;

  const names = await Promise.all(pids.map(describePid));
  console.warn(`[月幕后端] 端口 ${port} 被旧进程占用，自动结束：${pids.map((p, i) => `${p}（${names[i]}）`).join('、')}`);

  // —— 第一轮 SIGTERM：优雅退出，3s 宽限（pid<=0 硬防线：防进程组误杀） ——
  for (const pid of pids) {
    if (pid <= 0) continue;
    try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出/无权限：留给复核 */ }
  }
  for (let i = 0; i < 30 && pids.some(alive); i++) await sleep(100);

  // —— 仍存活的顽固进程：SIGKILL 强杀，再 2s 宽限 ——
  const stubborn = pids.filter((p) => p > 0 && alive(p));
  if (stubborn.length) {
    for (const pid of stubborn) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* 同上 */ }
    }
    for (let i = 0; i < 20 && pids.some(alive); i++) await sleep(100);
  }

  // —— 复核：仍被监听则如实报失败（可能无权限，或占用者已易主） ——
  const left = await listenerPids(port);
  if (left.length) {
    console.error(`[月幕后端] 端口 ${port} 仍被占用（PID ${left.join('、')}），请手动处理`);
    return false;
  }
  console.warn(`[月幕后端] 端口 ${port} 已释放`);
  return true;
}
