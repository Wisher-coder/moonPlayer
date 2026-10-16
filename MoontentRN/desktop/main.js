// ============================================================================
// 月幕 MoontentRN 桌面端 —— Electron 主进程（ESM）
// ----------------------------------------------------------------------------
// 职责：把「Koa 后端（server/）+ Expo Web 静态产物」组装进桌面壳——
//   1. 解析 serverRoot / webDist：已打包（electron-builder 的 extraResources）
//      用 process.resourcesPath 下 server/ 与 web/；未打包用仓库同级的
//      server 与 dist/web（后者不存在时回落 app/dist 旧产物）；
//   2. 动态 import server/src/index.js 导出的 createApp({ distDir }) 起内嵌
//      HTTP 服务（server 是 ESM，Windows 盘符路径必须经 pathToFileURL 转
//      file:// URL 再 import；sharp 是 NAPI 模块，主进程可直接加载，
//      无需 electron-rebuild）；
//   3. 打开 1440x900 主窗口加载内嵌服务地址（宽 ≥1280 命中应用 PC 画幅，
//      即 AppShell 的导视侧栏布局，见 app/src/lib/use-form.js 断点口径）；
//   4. 无边框窗口 + 自绘标题栏：Windows/Linux 用 frame:false，应用内以
//      -webkit-app-region 拖拽区 + WindowControls 三钮承担移动/最大化/关闭
//      （腾讯视频/爱奇艺形态）；macOS 改 titleBarStyle:'hidden' 保留原生
//      红绿灯（trafficLightPosition 摆进自绘标题栏，前端不再画三钮）。
//      本进程提供窗口控制 IPC（moontent:win-*，一律按 event.sender
//      反查所属窗口，主窗/播放窗共用同一组通道）；
//   5. 视频播放独立窗（moontent:open-video）：主窗点视频卡 → 单独
//      BrowserWindow 加载 /video/<site>/<id>?win=player 深链（服务端已有
//      动态路由 SPA 回退，见 server/src/index.js）。single 模式全程复用
//      一个播放窗（moontent:navigate 无刷新切集 + 置前），multi 模式每次
//      新开；主窗关闭即退出整个应用（播放窗一并关闭，不留无入口后台进程）。
//   6. 菜单独立子窗（moontent:menu-*，腾讯视频形态）：播放器的倍速/音量/
//      设置弹层浮出为无边框透明置顶小窗——不再受播放器表面 overflow 裁剪
//      （小窗播放 520x300 里六档倍速菜单放不下）。每 owner 窗一个会话，
//      惰性创建常驻隐藏复用；动作经主进程回流 owner 窗落地（详见下方
//      「菜单独立子窗」区注释）。
//
// 运行模式（按 process.argv 分派）：
//   electron . --dev       开发模式：直连 cli.js 预先拉起的 expo web dev
//                          server（http://localhost:8081）；后端也由 cli 在
//                          3001 起，本进程不内嵌起服务；
//   electron . --selftest  自检模式：不创建窗口；走生产装配（未打包按仓库
//                          路径解析、已打包按 resources 装配——cli build macos
//                          用它验证安装包产物），
//                          起内嵌服务后断言 GET / 的 HTML 含 id="root" 且
//                          GET /api/sites 返回非空 JSON 数组；全部通过打印
//                          [desktop-selftest] OK 并退出码 0，任一失败打印
//                          原因退出码 1；任何异常都保证进程退出、不悬挂；
//   electron .             生产模式（默认）：内嵌服务 + 本地静态产物窗口。
// ============================================================================

import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';

// —— ESM 无 __dirname：基于 import.meta.url 自行推导（本文件在 desktop/ 内） ——
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// —— 内嵌服务网络参数：仅回环监听（桌面壳只服务本机窗口，不暴露局域网）；
//    端口首选 3001，与 server/src/index.js 的默认端口一致 ——
const HOST = '127.0.0.1';
const PREFER_PORT = 3001;

// —— 播放独立窗参数校验口径（与应用侧一致：video/[site]/[id] 页对 id 的
//    正则同源；site 同字符集收紧到 32 位）——任何不合法值直接拒绝，绝不
//    进入 URL 拼接 ——
const SITE_RE = /^[0-9A-Za-z_-]{1,32}$/;
const VID_RE = /^[0-9A-Za-z_-]{1,64}$/;

// —— 看板条目上限（与前端 wall-store.js 的 WALL_MAX 同口径）：跨窗转发通道
//    的载荷粗校验上限，超限视为异常态直接丢弃 ——
const WALL_MAX_ITEMS = 16;

// —— 小窗播放尺寸（站方播放器「小窗」形态：一小块置顶浮窗，视频铺满、控件
//    压在画面上；宽 ≥500 命中播放器宽幅控制条，控件不至于退化成手机底行）——
const MINI_W = 520;
const MINI_H = 300;
const MINI_MIN_W = 360; // 小窗态最小尺寸（播放窗默认 960x600 会把小窗钳回大尺寸）
const MINI_MIN_H = 220;
const MINI_MARGIN = 24; // 距显示器工作区右下角的边距

// —— 菜单独立子窗（腾讯式弹层窗）：倍速/音量/设置浮出为独立小窗 ——
const MENU_KINDS = new Set(['rate', 'vol', 'settings']); // 菜单类别白名单
const MENU_HIDE_GRACE_MS = 800; // 「控制条 ↔ 菜单窗」指针穿行宽限（到点即收；
//                                宁可晚收半秒,不可用户还没移到菜单就被收掉）
const MENU_FALLBACK_SIZE = { width: 200, height: 240 }; // 未测得内容尺寸前的兜底窗尺寸（隐藏态就位）

// —— 模式判定（argv 精确匹配；--selftest 优先于 --dev，二者同给时按自检处理） ——
const MODE = process.argv.includes('--selftest') ? 'selftest'
  : process.argv.includes('--dev') ? 'dev'
  : 'prod';

// —— 内嵌 HTTP 服务实例（生产模式持有，退出时关闭；复用外部 3001 时为 null） ——
let embeddedServer = null;
// —— 内嵌服务的分片端口服务表（startShards 写入，退出清理用；复用外部
//    3001 时保持为空——外部服务自带分片，不越俎代庖） ——
let shardServers = [];
// —— 主窗口引用（second-instance 聚焦用） ——
let mainWindow = null;

// —— 渲染端来源（播放独立窗深链的 URL 前缀）：生产 = 内嵌/复用服务基址，
//    dev = expo web dev server；由 runProd/runDev 在开窗前写入 ——
let rendererOrigin = null;
// —— 非 null 时前端基址与默认（3001）不同（内嵌服务换空闲端口场景），
//    播放窗深链需补 &api=<实际基址> 告知前端（对齐主窗 ?api= 注入） ——
let rendererApiParam = null;
// —— 主窗最近一次加载地址（macOS activate 兜底重建主窗用） ——
let lastMainWindowUrl = null;

// —— 播放独立窗集合（插入序）：multi 模式每视频一新窗；single 模式复用
//    「最近聚焦」的那个（focus 时移到集合末位，取末位即最近使用） ——
const playerWindows = new Set();

// —— 菜单独立子窗会话表（owner BrowserWindow → 会话）：每 owner 窗一个，
//    惰性创建后常驻隐藏复用（首次要整树启动一次；owner 侧 PlayerControls
//    挂载即 prewarm，用户 hover 菜单钮时早已就绪） ——
const menuSessions = new Map();

// ============================================================================
// 路径解析
// ============================================================================
/**
 * 解析 serverRoot / webDist
 * - 已打包：extraResources 已把 ../server → resources/server 与
 *   ../dist/web → resources/web 整目录带入安装包，直接取；
 * - 未打包：desktop/ 的上一级即 MoontentRN 仓库根；webDist 首选
 *   dist/web（cli build web 的输出），不存在时回落 app/dist（旧产物），
 *   回落行为保证 selftest / 首次运行不因未导出而直接失败。
 * @returns {{ serverRoot: string, webDist: string }}
 */
function resolvePaths() {
  if (app.isPackaged) {
    return {
      serverRoot: path.join(process.resourcesPath, 'server'),
      webDist: path.join(process.resourcesPath, 'web'),
    };
  }
  const repoRoot = path.resolve(__dirname, '..');
  const preferred = path.join(repoRoot, 'dist', 'web');
  const fallback = path.join(repoRoot, 'app', 'dist');
  return {
    serverRoot: path.join(repoRoot, 'server'),
    webDist: fs.existsSync(preferred) ? preferred : fallback,
  };
}

// ============================================================================
// 网络工具（探测 / 空闲端口 / HTTP 断言用）
// ============================================================================

/**
 * 起一个临时 TCP server 探测空闲端口（listen 0 由系统分配）
 * @returns {Promise<number>} 可用端口号
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * 在指定端口把 Koa 应用挂到 http server 上
 * @param {import('koa').Application} koaApp createApp() 返回的 Koa 实例
 * @param {number} port 监听端口
 * @returns {Promise<import('node:http').Server>} 已监听的 server 实例
 *   （端口被占等监听失败走 reject，err.code 形如 'EADDRINUSE'）
 */
function listen(koaApp, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(koaApp.callback());
    server.once('error', reject);
    server.listen(port, HOST, () => resolve(server));
  });
}

/**
 * 探测某地址是否是「完整可用的月幕装配」：GET / 必须 200、text/html 且
 * HTML 含 id="root"（与 selftest 断言同口径）。只探 /api/sites 2xx 不够——
 * 裸起的 node src/index.js（无 distDir → 无静态托管）API 正常但页面 404，
 * 复用它会导致主窗/播放窗/菜单窗全部 404 白屏（HTTP 404 是「成功的导航」，
 * 连 did-fail-load 都不触发）。本探测决定复用还是换端口，不影响错误契约。
 * @param {string} baseUrl 服务基址（如 http://127.0.0.1:3001）
 * @returns {Promise<boolean>}
 */
async function backendUsable(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return false;
    const type = res.headers.get('content-type') || '';
    if (!type.includes('text/html')) return false;
    const html = await res.text();
    return html.includes('id="root"');
  } catch {
    return false;
  }
}

/**
 * 关闭内嵌服务（尽力而为：主动断开 keep-alive 连接，close 回调最迟
 * 1.5s 到齐，绝不因挂起连接阻塞退出流程）
 * @param {import('node:http').Server|null} server
 */
async function stopServer(server) {
  if (!server) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1500);
    try {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections(); // Node ≥18.2：立断空闲 keep-alive 连接
      }
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

// ============================================================================
// 内嵌后端装配（生产 / 自检共用）
// ============================================================================

/**
 * 内嵌服务 listen 成功后起分片端口（自动分片：同一 Koa 回调挂到主端口+1..+N，
 * 视频流分散拉取，防同源 HTTP/1.1 连接上限把 /api/* 短请求饿死；见
 * server/src/lib/shard-ports.js）。只在本进程内嵌起服务的路径调用——复用外部
 * 3001 的分支绝不另起（外部服务自己带分片，/api/sites 由它自己上报）。
 * 任一失败仅告警，绝不影响内嵌主服务。
 * @param {{ startShardServers?: Function }|null} shardMod shard-ports 模块
 *   （缺失/加载失败为 null，直接跳过）
 * @param {import('koa').Application} koaApp 内嵌 Koa 实例
 * @param {number} port 内嵌主端口
 */
function startShards(shardMod, koaApp, port) {
  if (!shardMod || typeof shardMod.startShardServers !== 'function') return;
  try {
    shardServers = shardMod.startShardServers(koaApp.callback(), port, HOST) || [];
  } catch (err) {
    console.warn(`[月幕桌面端] 分片端口启动失败（不影响主服务）：${(err && err.message) || err}`);
    shardServers = [];
  }
}

/**
 * 装配并启动内嵌后端服务
 * 端口策略（契约）：首选 3001；复用判定——
 *   - reuseIfAlive=true（生产）：listen 之前先用 backendUsable 主动探测
 *     http://127.0.0.1:3001（GET / 必须返回含 id="root" 的应用页面），
 *     通过才复用该既有服务（不再内嵌起服务）——裸起的 server（无静态
 *     托管、API 正常但页面 404）不可复用。不能只等 EADDRINUSE 触发：
 *     Windows 上 libuv 对 listen 设 SO_REUSEADDR，外部进程绑 0.0.0.0:3001
 *     （server 的 npm start 默认形态）时本进程仍能成功绑 127.0.0.1:3001，
 *     EADDRINUSE 不会报、两服务同端口共存，被动分支在典型场景是死代码。
 *     EADDRINUSE 路径保留兜底（探测不可达但端口确被独占的其余平台/场景）；
 *     仍不可复用则换空闲端口，且加载 URL 需追加 ?api= 参数把前端基址指过去；
 *   - reuseIfAlive=false（自检）：断言必须打在「本进程的生产装配」上，
 *     复用外部进程验证不到装配链路，故不做预探测，EADDRINUSE 一律换空闲端口。
 * @param {{ serverRoot: string, webDist: string, reuseIfAlive: boolean }} opts
 * @returns {Promise<{ server: import('node:http').Server|null, baseUrl: string,
 *   embedded: boolean, apiParam: boolean }>}
 */
async function startBackend({ serverRoot, webDist, reuseIfAlive }) {
  const entry = path.join(serverRoot, 'src', 'index.js');
  if (!fs.existsSync(entry)) {
    throw new Error(`后端入口不存在：${entry}`);
  }
  // 校验落到 index.html 而非目录本身：目录在而缺 index.html 同样是页面 404
  if (!fs.existsSync(path.join(webDist, 'index.html'))) {
    if (app.isPackaged) {
      // 打包态缺失 = 安装包装配不完整（extraResources 漏拷），必须显式失败，
      // 不能让用户面对无诊断信息的白屏
      throw new Error(`安装包装配不完整：${path.join(webDist, 'index.html')} 不存在，请重新构建安装包`);
    }
    // 与 server 侧「目录不存在仅告警」的口径一致：仍起服务（API 可用），
    // 页面 404 由开窗前预检拦截进错误页；未打包回落 app/dist 后正常不会走到这
    console.warn(`[月幕桌面端] 静态产物缺失：${path.join(webDist, 'index.html')}（先 node MoontentRN/cli.js build web）`);
  }

  // server 是 ESM 工程：动态 import 必须用 file:// URL（Windows 的
  // C:\... 路径直接 import 会因缺协议前缀而非法）
  const mod = await import(pathToFileURL(entry).href);
  if (typeof mod.createApp !== 'function') {
    throw new Error('server/src/index.js 未导出 createApp 函数');
  }
  const koaApp = mod.createApp({ distDir: webDist });

  // —— 分片端口模块（叶子模块，只依赖 node:http；与 index.js 内的相对
  //    import 解析到同一 URL，即同一模块单例——本进程起的分片会被内嵌服务
  //    的 /api/sites 如实上报）。缺失/加载失败仅告警，主服务不受影响 ——
  let shardMod = null;
  try {
    shardMod = await import(pathToFileURL(path.join(serverRoot, 'src', 'lib', 'shard-ports.js')).href);
  } catch (err) {
    console.warn(`[月幕桌面端] 分片端口模块加载失败（不影响主服务）：${(err && err.message) || err}`);
  }

  // —— 生产模式：listen 前先主动探测 3001 是否已有「完整可用」的月幕装配 ——
  if (reuseIfAlive) {
    const usable = await backendUsable(`http://${HOST}:${PREFER_PORT}`);
    if (usable) {
      return { server: null, baseUrl: `http://${HOST}:${PREFER_PORT}`, embedded: false, apiParam: false };
    }
  }

  // —— 首选 3001 ——
  try {
    const server = await listen(koaApp, PREFER_PORT);
    startShards(shardMod, koaApp, PREFER_PORT); // 回环分片（HOST 常量）；失败不影响主服务
    return { server, baseUrl: `http://${HOST}:${PREFER_PORT}`, embedded: true, apiParam: false };
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
  }

  // —— 3001 被占（EADDRINUSE 兜底）：按模式决定复用还是换端口 ——
  if (reuseIfAlive) {
    const usable = await backendUsable(`http://${HOST}:${PREFER_PORT}`);
    if (usable) {
      // 复用外部服务：不另起分片（外部服务自己带；本进程 shardServers 保持为空）
      return { server: null, baseUrl: `http://${HOST}:${PREFER_PORT}`, embedded: false, apiParam: false };
    }
  }
  const port = await findFreePort();
  const server = await listen(koaApp, port);
  startShards(shardMod, koaApp, port); // 换端口场景同样起分片（跟实际主端口）
  return { server, baseUrl: `http://${HOST}:${port}`, embedded: true, apiParam: true };
}

// ============================================================================
// 窗口（无边框 + 自绘标题栏 + 播放独立窗）
// ============================================================================

/**
 * 无边框窗口公共基参：frame:false 去掉系统标题栏/边框（Windows 下仍保留
 * 系统隐式缩放边，resizable 默认开，边缘拖拽缩放不受影响），移动/最大化/
 * 关闭全部由应用内自绘标题栏承担——主窗融合进 TopBar（app/src/components/
 * layout/TopBar.jsx 的 app-drag 拖拽区 + WindowControls 三钮），播放窗为
 * PlayerWindowShell 自带窄标题栏（app/src/app/_layout.js）。
 * macOS 红绿灯适配：frame:false 会连原生红绿灯一起藏掉，改 titleBarStyle:
 * 'hidden'——同样没有系统标题栏（app-drag 拖拽/双击行为不变），但保留红绿灯
 * 并经 trafficLightPosition 摆进自绘标题栏垂直居中；此时前端不画 Windows
 * 风三钮、标题栏左侧给红绿灯让位（按桥的 platform 判定，见 preload.cjs 与
 * app/src/lib/desktop-bridge.js）。
 * @param {{ titleBarH?: number }} [opts] macOS 红绿灯垂直居中所对的标题栏高
 *   （主窗 56 / 播放窗 44，与前端两处标题栏高同口径；非 macOS 忽略）
 */
function baseWindowOptions({ titleBarH = 48 } = {}) {
  return {
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hidden',
          // 红绿灯三颗 12px 圆钮、8px 间距，整组宽 52px：x=8 取系统默认贴边
          // 位（前端让位宽度 TRAFFIC_LIGHT_W 与此对齐），y 按宿主标题栏高居中
          trafficLightPosition: { x: 8, y: Math.round((titleBarH - 12) / 2) },
        }
      : { frame: false }),
    autoHideMenuBar: true,
    backgroundColor: '#0f0f0f',
    show: false, // 渲染就绪再显示，避免启动白屏闪烁
    webPreferences: {
      // 预加载桥用 .cjs 后缀：desktop/package.json 是 type:module，沙箱渲染
      // 器的 preload 必须是 CommonJS——.js 会被按 ESM 解析而在沙箱中加载
      // 失败（moontentDesktop 桥整体不注入，自绘窗口控件随之消失）
      preload: path.join(__dirname, 'preload.cjs'),
      // 安全基线：contextIsolation 保持默认开启、nodeIntegration 保持默认
      // 关闭（preload.cjs 仅暴露窄白名单桥，见该文件头）
    },
  };
}

/**
 * 最大化状态前送：自绘标题栏的「最大化/还原」图标切换依赖该事件
 * （每窗各自前送到自己的 webContents，互不串扰）
 */
function forwardWindowState(win) {
  const send = (maximized) => {
    if (!win.isDestroyed()) win.webContents.send('moontent:win-state-changed', { maximized });
  };
  win.on('maximize', () => send(true));
  win.on('unmaximize', () => send(false));
}

/**
 * 注册窗口控制与播放窗 IPC（whenReady 后、开窗前调用一次）
 * 窗口自控口径：一律以 event.sender 反查发起窗（BrowserWindow.
 * fromWebContents），主窗/播放窗共用同一组通道，各控各的。
 */
function registerIpc() {
  const fromEvent = (e) => BrowserWindow.fromWebContents(e.sender) || null;
  ipcMain.handle('moontent:win-min', (e) => { fromEvent(e)?.minimize(); });
  ipcMain.handle('moontent:win-toggle-max', (e) => {
    const win = fromEvent(e);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle('moontent:win-close', (e) => { fromEvent(e)?.close(); });
  ipcMain.handle('moontent:win-state', (e) => ({ maximized: !!fromEvent(e)?.isMaximized() }));
  // 「打开主界面」（播放窗窄标题栏左端 home 钮）：把主窗从最小化/后台拉起并聚焦。
  // 主窗是应用入口——关主窗即退出整个应用（见 createWindow 的 closed 分支），
  // 故只要还有播放窗在，主窗必然健在；理论到不了的分支返回 false，前端静默
  ipcMain.handle('moontent:open-main', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return true;
  });
  // 「窗口置顶」（播放窗右上，桌面端专属）：把本窗钉在最前（always-on-top），
  // 再点取消。返回切换后的状态，前端据此亮/灭按钮
  ipcMain.handle('moontent:win-toggle-top', (e) => {
    const win = fromEvent(e);
    if (!win) return false;
    const next = !win.isAlwaysOnTop();
    win.setAlwaysOnTop(next);
    return next;
  });
  // 查询本窗置顶态（浮钮初值；置顶态挂在窗体上，前端不需要事件订阅）
  ipcMain.handle('moontent:win-top', (e) => !!fromEvent(e)?.isAlwaysOnTop());
  // 「小窗播放」（桌面端专属；站方播放器右下钮）——把本窗缩成小窗并置顶：
  //   · 进小窗：记住原 bounds/原置顶态 → 移到当前显示器右下角（留边距）→
  //     置顶；返回 true；
  //   · 退小窗：回原 bounds，恢复原置顶态（小窗期间用户手动取消置顶不还原）；
  //     返回 false。
  // 状态挂在窗体对象上（__mini*），主窗/多播放窗各自独立
  ipcMain.handle('moontent:win-toggle-mini', (e) => {
    const win = fromEvent(e);
    if (!win || win.isDestroyed()) return false;
    if (win.__mini) {
      // 还原：最小尺寸先复原（否则小窗下限仍钳在最小尺寸上），再回原 bounds
      if (win.__miniMin) win.setMinimumSize(win.__miniMin[0], win.__miniMin[1]);
      if (win.__miniBounds) win.setBounds(win.__miniBounds);
      if (!win.__miniWasTop) win.setAlwaysOnTop(false);
      win.__mini = false;
      return false;
    }
    win.__miniBounds = win.getBounds();
    win.__miniWasTop = win.isAlwaysOnTop();
    win.__miniMin = win.getMinimumSize();
    // 播放窗最小尺寸 960x600 会把小窗钳回大尺寸（窗口缩不下去、还可能顶出屏幕）：
    // 进小窗前先把下限放开到小窗尺寸之下，退出时复原
    win.setMinimumSize(MINI_MIN_W, MINI_MIN_H);
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    // 工作区比小窗还小时按工作区收（含边距），任何情况下不超出屏幕
    const w = Math.max(320, Math.min(MINI_W, area.width - MINI_MARGIN * 2));
    const h = Math.max(200, Math.min(MINI_H, area.height - MINI_MARGIN * 2));
    win.setBounds({
      width: w,
      height: h,
      x: Math.round(area.x + area.width - w - MINI_MARGIN),
      y: Math.round(area.y + area.height - h - MINI_MARGIN),
    });
    win.setAlwaysOnTop(true);
    win.__mini = true;
    return true;
  });
  // 查询小窗态（前端挂载时对齐；浮钮/布局初值用）
  ipcMain.handle('moontent:win-mini', (e) => !!fromEvent(e)?.__mini);
  ipcMain.handle('moontent:open-video', (_e, payload) => {
    const target = parseVideoPayload(payload);
    if (!target) throw new Error('非法的视频参数（site/id 校验未通过）');
    openPlayerWindow(target);
  });

  // 看板跨窗同步（wall-store 的 setItems 统一出口触发，fire-and-forget 用 send
  // 不用 invoke）：任一窗的看板 items 变更转发给其余所有窗——播放窗「添加到
  // 看板」→ 主窗 TopBar 胶囊+计数气泡即时出现；主窗移除/清空/进度回写 →
  // 播放窗「已在看板 ✓」态跟随。发起窗不回发（防回声环），open 开关是每窗
  // UI 态不参与同步（看板浮层只在主窗，播放窗不需要）。
  ipcMain.on('moontent:wall-broadcast', (e, payload) => {
    if (!Array.isArray(payload?.items)) return; // 形态不对：静默丢弃
    if (payload.items.length > WALL_MAX_ITEMS) return; // 超上限：异常态丢弃
    // 每项粗校验（site/id 缺失的项不转发；字段级白名单由接收端 sanitizeItems 兜底）
    const ok = payload.items.every(
      (x) => x && typeof x === 'object' && x.site != null && x.id != null
    );
    if (!ok) return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents === e.sender) continue;
      win.webContents.send('moontent:wall-changed', { items: payload.items });
    }
  });

  // ===== 菜单独立子窗（见上方「菜单独立子窗」区注释）=====
  // 预热：owner 侧 PlayerControls 挂载即调——菜单窗提前整树启动，用户 hover
  // 菜单钮时零延迟（幂等：会话已存在直接复用）
  ipcMain.handle('moontent:menu-prewarm', (e) => {
    const owner = fromEvent(e);
    if (owner && !owner.isDestroyed() && rendererOrigin) ensureMenuSession(owner);
  });
  // 打开（owner 发起）：anchor 为触发钮屏幕坐标（DIP）。macOS 全屏空间不允
  // 许他窗悬浮在 fullscreen 窗之上 → 返回 fallback:'local'，owner 回落窗内弹层
  ipcMain.handle('moontent:menu-show', (e, payload) => {
    const owner = fromEvent(e);
    if (!owner || owner.isDestroyed() || !rendererOrigin) return { fallback: 'local' };
    if (owner.isFullScreen()) return { fallback: 'local' };
    const kind = payload && MENU_KINDS.has(payload.kind) ? payload.kind : null;
    if (!kind) return { fallback: 'local' };
    const a = (payload && payload.anchor) || {};
    const anchor = {
      x: Number(a.x) || 0,
      y: Number(a.y) || 0,
      w: Number(a.w) || 0,
      h: Number(a.h) || 0,
    };
    const s = ensureMenuSession(owner, anchor);
    clearMenuHideTimer(s);
    sendMenuState(s, kind, payload.state);
    placeMenuWindow(s, kind, anchor);
    return { ok: true };
  });
  // 菜单窗内容尺寸回报（onLayout，含外圈留白）：按 kind 缓存；首次打开
  // （pending）精调摆位后显示；可见中的尺寸微调（内容变化/字体缩放）按
  // 最近锚点重摆
  ipcMain.handle('moontent:menu-sized', (e, payload) => {
    const s = menuSessionFor(fromEvent(e));
    if (!s || s.win.isDestroyed()) return;
    const kind = payload && MENU_KINDS.has(payload.kind) ? payload.kind : null;
    const w = Math.round(Number(payload && payload.w)) || 0;
    const h = Math.round(Number(payload && payload.h)) || 0;
    if (!kind || w <= 0 || h <= 0 || w > 4000 || h > 4000) return; // 异常态丢弃
    s.sizes[kind] = { width: w, height: h };
    const showAt = (anchor) => {
      const b = computeMenuBounds(s.owner, anchor, s.sizes[kind]);
      s.win.setBounds(b);
      if (!s.win.isVisible()) s.win.showInactive();
      s.win.setBounds(b); // 显示后重设（透明窗隐藏态 setBounds 怪癖，同上）
    };
    if (s.pending && s.pending.kind === kind) {
      const { anchor } = s.pending;
      s.pending = null;
      s.lastAnchor = anchor;
      showAt(anchor);
    } else if (s.win.isVisible() && s.lastState && s.lastState.kind === kind && s.lastAnchor) {
      showAt(s.lastAnchor);
    }
  });
  // 指针进/出菜单热区（owner 控制条与菜单窗两侧都会发）。跨窗口事件乱序是
  // 本通道的核心风险：指针从按钮上移进菜单窗的一瞬，owner 侧（按钮/控制
  // 条）的 mouseleave 与菜单窗的 mouseenter 两个 IPC 谁后到不一定——若
  // owner 的「移出」后到，会重新武装收起计时，把正停着指针的菜单关掉。
  // 裁决（到点复核地面真值，不赌事件顺序）：计时到点时读系统全局光标位置
  //（screen.getCursorScreenPoint），光标就在菜单窗矩形内 → 不收；起计时后
  // 又有任何「进入」事件（lastEnterAt > armedAt，指针正从另一侧穿过来）→
  // 也不收。两层保险都不依赖菜单窗渲染端的 hover 事件是否可靠。
  ipcMain.handle('moontent:menu-enter', (e) => {
    const s = menuSessionFor(fromEvent(e));
    if (!s) return;
    s.lastEnterAt = Date.now();
    clearMenuHideTimer(s);
  });
  ipcMain.handle('moontent:menu-leave', (e) => {
    const s = menuSessionFor(fromEvent(e));
    if (!s) return;
    const armedAt = Date.now();
    clearMenuHideTimer(s);
    s.hideTimer = setTimeout(() => {
      s.hideTimer = null;
      if (s.lastEnterAt > armedAt) return; // 计时后又进入:穿行中,不收
      // 地面真值:光标就在菜单窗内 → 指针正停在菜单上,无论渲染端 hover 事件
      // 有没有到/到没到乱序,都不收
      try {
        const pt = screen.getCursorScreenPoint();
        const b = s.win.getBounds();
        if (pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height) {
          return;
        }
      } catch {
        /* 光标读取异常:按事件面裁决(下面的 hide) */
      }
      hideMenuSession(s);
    }, MENU_HIDE_GRACE_MS);
  });
  // 立即收起（选档完成/点空白/控件隐藏；owner 与菜单窗都可能发起）
  ipcMain.handle('moontent:menu-hide', (e) => {
    const s = menuSessionFor(fromEvent(e));
    if (s) hideMenuSession(s);
  });
  // owner 侧状态反推（菜单开着时倍速/音量被手势等改动）：刷新菜单窗快照
  ipcMain.handle('moontent:menu-update', (e, payload) => {
    const s = menuSessions.get(fromEvent(e)); // 仅 owner 发起（key 命中）
    if (!s || s.win.isDestroyed() || !s.lastState) return;
    sendMenuState(s, s.lastState.kind, payload && payload.state);
  });
  // 菜单窗启动报到（渲染端挂载完成）：补推 lastState（建窗初期 send 可能
  // 早于渲染端订阅而丢失，这里拉齐竞态）
  ipcMain.handle('moontent:menu-ready', (e) => {
    const s = menuSessionFor(fromEvent(e));
    if (!s || s.win.isDestroyed() || !s.lastState) return;
    s.win.webContents.send('moontent:menu-state', s.lastState);
  });
  // 菜单动作回流：菜单窗 → 主进程 → owner（owner 用 onSetRate/onSetVolume/
  // setSetting 落地；type 白名单，value/key 细校验由 owner 侧回调兜底）
  ipcMain.handle('moontent:menu-action', (e, payload) => {
    const s = menuSessionFor(fromEvent(e));
    if (!s || s.owner.isDestroyed()) return false;
    const type = payload && typeof payload === 'object' ? payload.type : null;
    if (type !== 'rate' && type !== 'volume' && type !== 'setting') return false;
    if (!s.owner.webContents.isDestroyed()) {
      s.owner.webContents.send('moontent:menu-action', {
        type,
        value: payload.value,
        key: type === 'setting' ? String(payload.key || '') : undefined,
      });
    }
    return true;
  });
}

/**
 * 校验播放窗参数：site/id 与应用侧字符集口径一致（video/[site]/[id] 页
 * 的 id 正则同源），mode 收敛到 'single' | 'multi'（缺省 single）
 * @returns {{site: string, id: string, mode: 'single'|'multi'}|null}
 */
function parseVideoPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const site = String(payload.site == null ? '' : payload.site);
  const id = String(payload.id == null ? '' : payload.id);
  if (!SITE_RE.test(site) || !VID_RE.test(id)) return null;
  return { site, id, mode: payload.mode === 'multi' ? 'multi' : 'single' };
}

/**
 * 播放窗深链 URL：<origin>/video/<site>/<id>?win=player
 * win=player 由前端模块加载时读一次（app/src/lib/desktop-bridge.js，
 * 对齐 api-base 的注入模式，SPA 内后续跳转不丢标志）；内嵌服务换过端口时
 * 再补 &api= 告知前端实际基址。
 */
function buildPlayerUrl({ site, id }) {
  const base = `${rendererOrigin}/video/${site}/${id}?win=player`;
  return rendererApiParam ? `${base}&api=${encodeURIComponent(rendererApiParam)}` : base;
}

// ============================================================================
// 窗口加载兜底（错误页 / 失败监听 / 超时强显）
// ============================================================================

/**
 * 加载本地错误页（desktop/error.html 随 asar 分发，离线可用）
 * @param {Electron.BrowserWindow} win 目标窗口
 * @param {string} targetUrl 加载失败的目标地址（错误页「重试」导航回去）
 * @param {string} reason 失败原因描述（如 "ERR_CONNECTION_REFUSED"）
 */
function loadErrorPage(win, targetUrl, reason) {
  if (win.isDestroyed()) return;
  win.loadFile(path.join(__dirname, 'error.html'), {
    query: { target: targetUrl || '', reason: reason || '' },
  });
}

/**
 * 窗口加载失败兜底（主窗/播放窗共用）：
 * - dev：打日志 + cli 指引（原行为）；
 * - prod：进本地错误页（中文说明 + 重试按钮）。
 * 注意 HTTP 404 是「成功的导航」，不触发 did-fail-load——404 场景由
 * runProd 的开窗前预检拦截；此处兜的是连接拒绝/服务退出等真失败。
 */
function attachLoadFailureHandler(win, url, { isDev = false } = {}) {
  win.webContents.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame) return;
    const target = failedUrl || url;
    if (target.startsWith('file:')) return; // 错误页自身加载失败不递归处理
    if (isDev) {
      console.error(`[月幕桌面端] 开发页面加载失败（${code} ${desc}）：${target}`);
      console.error('[月幕桌面端] 请确认 expo web dev server 已在 http://localhost:8081 就绪（cli run web / cli run desktop）');
      return;
    }
    console.error(`[月幕桌面端] 页面加载失败（${code} ${desc}）：${target}，进入错误页`);
    loadErrorPage(win, target, `${code} ${desc}`);
  });
}

/**
 * ready-to-show 兜底显示：后端不响应时 ready-to-show 可能永不来，show:false
 * 的窗口会「有进程无窗口」假死——到点强显，给用户可见反馈（错误页/重试入口）
 */
function showWhenReady(win, timeoutMs = 15000) {
  const timer = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  }, timeoutMs);
  win.once('ready-to-show', () => {
    clearTimeout(timer);
    win.show();
  });
}

/**
 * 创建播放独立窗：1280x800（宽 1280 恰命中 pc 画幅双栏布局）、最小
 * 960x600；title 为兜底值，实际片名由页面 document.title 接管。
 */
function createPlayerWindow(target) {
  const win = new BrowserWindow({
    ...baseWindowOptions({ titleBarH: 44 }), // 窄标题栏高（_layout.js PlayerWindowFrame）
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: '月幕 · 视频播放',
  });
  playerWindows.add(win);
  forwardWindowState(win);
  // 最近使用置尾（Set 插入序）：single 模式复用「最近聚焦」的播放窗
  const bump = () => {
    if (playerWindows.delete(win)) playerWindows.add(win);
  };
  win.on('focus', bump);
  showWhenReady(win);
  win.on('closed', () => playerWindows.delete(win));
  const playerUrl = buildPlayerUrl(target);
  attachLoadFailureHandler(win, playerUrl, { isDev: MODE === 'dev' });
  win.loadURL(playerUrl);
  return win;
}

/**
 * 打开（或复用）播放独立窗
 * - single：已有播放窗 → 发 moontent:navigate 让其 SPA 内无刷新切集并
 *   置前（整页重载会白闪 + 播放器全拆，故走导航指令）；没有 → 新建；
 * - multi：每次新开一窗，多视频同播。
 */
function openPlayerWindow(target) {
  if (target.mode === 'single' && playerWindows.size > 0) {
    const win = [...playerWindows].pop(); // 末位 = 最近创建/聚焦的播放窗
    if (win && !win.isDestroyed()) {
      win.webContents.send('moontent:navigate', { site: target.site, id: target.id });
      if (win.isMinimized()) win.restore();
      win.focus();
      return win;
    }
  }
  return createPlayerWindow(target);
}

// ============================================================================
// 菜单独立子窗（腾讯式：倍速/音量/设置弹层浮出为无边框透明置顶小窗）
// ============================================================================
// 为什么独立窗：弹层原是播放器表面内的绝对定位子节点，被 VideoPlayer 容器与
// 舞台层的 overflow:hidden 双重裁剪——小窗播放（520x300）里六档倍速菜单（约
// 240px 高）必然放不下。参考腾讯视频客户端：菜单做成独立小窗，锚在触发钮的
// 屏幕坐标旁，完全不受播放器窗口边界限制。
// 形态：frame:false + transparent（圆角/阴影由前端 CSS 画，与 PlayerPopup 同
// 一视觉语言）+ focusable:false（不抢 owner 焦点，hover/点选语义连续）+
// skipTaskbar + pop-up-menu 级置顶（浮在小窗态的置顶 owner 之上）。Linux 无
// 合成器时 transparent 会退化黑底——桌面目标 win/mac，不另做分支。
// 定位流：owner 用 measureInWindow + window.screenX/Y 换算锚点屏幕坐标 →
// menu-show → 主进程推送菜单状态（kind+快照）→ 菜单窗内容渲染 → onLayout
// 回报尺寸（menu-sized）→ 主进程把窗摆到「菜单右下角对齐锚点右上角、上方
// 放不下翻到锚点下方」并 showInactive；此后按 kind 缓存尺寸，开合即位。
// 指针语义：菜单窗与 owner 控制条两侧的 enter/leave 都汇到主进程一个 450ms
// 宽限定时器——指针在「钮 ↔ 菜单」间穿行不断流，移到别处到点即收（选档/
// 点空白/owner 窗一动则立即收）。
// 动作回流：菜单窗的选择（rate/volume/setting）经 moontent:menu-action 由主
// 进程转发回 owner 窗，owner 用现有回调（onSetRate/onSetVolume/setSetting）
// 落地——单一漏斗，不依赖跨窗 localStorage 事件；owner 侧状态变化（手势改
// 倍速等）经 menu-update 反向刷新菜单窗快照；菜单收起时回 menu-closed 让
// owner 清自己的开窗标记。

/** 菜单窗深链 URL：<origin>/menu?win=menu（app/src/app/menu.js 路由承载，
 *  IS_MENU_WINDOW 加载期定格，见 desktop-bridge.js） */
function buildMenuUrl() {
  const base = `${rendererOrigin}/menu?win=menu`;
  return rendererApiParam ? `${base}&api=${encodeURIComponent(rendererApiParam)}` : base;
}

/** 按「owner 或菜单窗自身」找菜单会话（owner 侧调用以 owner 为 key 直取；
 *  菜单窗发起的调用按 win 反查） */
function menuSessionFor(win) {
  if (!win) return null;
  if (menuSessions.has(win)) return menuSessions.get(win);
  for (const s of menuSessions.values()) if (s.win === win) return s;
  return null;
}

function clearMenuHideTimer(s) {
  if (s.hideTimer) {
    clearTimeout(s.hideTimer);
    s.hideTimer = null;
  }
}

/** 立即隐藏（不清会话——窗常驻复用）；同步通知 owner 清开窗标记 */
function hideMenuSession(s) {
  clearMenuHideTimer(s);
  s.pending = null;
  if (s.win && !s.win.isDestroyed() && s.win.isVisible()) s.win.hide();
  if (s.owner && !s.owner.isDestroyed()) {
    s.owner.webContents.send('moontent:menu-closed');
  }
}

/** 销毁会话（owner 关闭时；owner 已不在无需通知） */
function destroyMenuSession(owner) {
  const s = menuSessions.get(owner);
  if (!s) return;
  menuSessions.delete(owner);
  clearMenuHideTimer(s);
  if (s.win && !s.win.isDestroyed()) s.win.destroy();
}

/**
 * 计算菜单窗边界：右下角对齐锚点右上角（浮在触发钮上方），上方放不下翻到
 * 锚点下方；整体收进 owner 所在显示器的工作区
 * @param {Electron.BrowserWindow} owner 锚点所属窗（显示器取它的）
 * @param {{x,y,w,h}} anchor 触发钮屏幕坐标（DIP）
 * @param {{width,height}} size 菜单窗尺寸（含内容外圈留白）
 */
function computeMenuBounds(owner, anchor, size) {
  const area = screen.getDisplayMatching(owner.getBounds()).workArea;
  let x = Math.round(anchor.x + anchor.w - size.width);
  let y = Math.round(anchor.y - size.height);
  if (y < area.y) y = Math.round(anchor.y + anchor.h); // 上方放不下：翻到锚点下方
  x = Math.max(area.x, Math.min(x, area.x + area.width - size.width));
  y = Math.max(area.y, Math.min(y, area.y + area.height - size.height));
  return { x, y, width: size.width, height: size.height };
}

/**
 * 确保 owner 的菜单窗会话存在（惰性创建；已存在且未销毁则复用）。创建位
 * 置直接取当前锚点（不落锚的窗口会被 Electron 默认摆到屏幕中央——透明窗
 * 在隐藏态的 setBounds 有不生效的怪癖，先落位再精调更稳）。
 * owner 生命周期钩子：移动/缩放/最小化/失焦（点其它应用）→ 立即收（菜单锚
 * 定屏幕坐标，窗一动就错位）；关闭 → 连带销毁菜单窗。
 */
function ensureMenuSession(owner, anchor) {
  let s = menuSessions.get(owner);
  if (s && !s.win.isDestroyed()) return s;
  const size = MENU_FALLBACK_SIZE;
  const at = anchor
    ? computeMenuBounds(owner, anchor, size)
    : { x: -4000, y: -4000, ...size }; // 无锚点（预热）:先放屏幕外，正式打开再摆
  const win = new BrowserWindow({
    frame: false,
    transparent: true, // 圆角/阴影走前端 CSS；系统阴影在透明窗上发虚，关掉
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false, // 不抢 owner 焦点：hover/点选不打断 owner 键盘态
    show: false,
    x: at.x,
    y: at.y,
    width: at.width,
    height: at.height,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      // 安全基线同 baseWindowOptions（contextIsolation 开/nodeIntegration 关）
      backgroundThrottling: false, // 隐藏常驻也要及时收状态/回报尺寸
    },
  });
  // 浮在 owner 之上（含小窗态的置顶 owner）：pop-up-menu 级置顶
  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.loadURL(buildMenuUrl());
  s = {
    owner, win,
    hideTimer: null, // 移出宽限收起定时器（enter/leave 两侧共用）
    sizes: {}, // 按 kind 缓存的内容尺寸（{width,height}）
    pending: null, // 未测得尺寸的待显示请求（{kind,anchor}）
    lastState: null, // 最近推送的 {kind,state}（menu-ready 补推用）
    lastAnchor: null, // 最近一次摆位用的锚点（可见期尺寸微调重摆用）
    lastEnterAt: 0, // 最近一次「进入热区」时间戳（跨窗事件乱序裁决用）
  };
  menuSessions.set(owner, s);
  const hide = () => hideMenuSession(s);
  owner.on('move', hide);
  owner.on('resize', hide);
  owner.on('minimize', hide);
  // focusable:false 的菜单窗点按不夺焦，不会误触本分支；覆盖点其它应用场景
  owner.on('blur', hide);
  owner.once('closed', () => destroyMenuSession(owner));
  win.on('closed', () => {
    if (menuSessions.get(owner) === s) menuSessions.delete(owner);
  });
  return s;
}

/** 推送菜单状态（kind + 快照）到菜单窗；记 lastState 供 menu-ready 补推
 *  （建窗初期 send 可能早于渲染端订阅而丢失，ready 到达即拉齐） */
function sendMenuState(s, kind, state) {
  s.lastState = { kind, state: state && typeof state === 'object' ? state : {} };
  if (!s.win.isDestroyed()) s.win.webContents.send('moontent:menu-state', s.lastState);
}

/** 摆位并显示：有缓存尺寸即位显示；没有则按兜底尺寸隐藏就位、记 pending
 *  等 menu-sized 精调后显示。显示后再补一次 setBounds——macOS 透明窗在
 *  隐藏态的 setBounds 有不生效的怪癖（窗口会停在创建位/屏幕中央，表现为
 *  「菜单出现在离按钮很远的地方」），先显示再摆一次双保险 */
function placeMenuWindow(s, kind, anchor) {
  const size = s.sizes[kind] || MENU_FALLBACK_SIZE;
  s.lastAnchor = anchor;
  s.lastEnterAt = Date.now(); // 打开即视为进入热区（与 enter 同权重参与乱序裁决）
  const b = computeMenuBounds(s.owner, anchor, size);
  s.win.setBounds(b);
  if (s.sizes[kind]) {
    s.pending = null;
    if (!s.win.isVisible()) s.win.showInactive();
    s.win.setBounds(b); // 显示后重设，压住隐藏态 setBounds 不生效的怪癖
  } else {
    s.pending = { kind, anchor };
  }
}

/**
 * 创建主窗口
 * 尺寸契约：1440x900、最小 960x640；默认宽 1440 ≥ 1280，直接命中应用
 * PC 画幅（导视侧栏 240px，app/src/lib/use-form.js 断点口径），用户手动
 * 缩到 <1280 时应用自身会回落平板/手机画幅，无需壳层干预。
 * @param {string} url 加载地址
 * @param {{ isDev?: boolean, loadError?: string|null }} [opts] isDev：--dev 模式
 *   （8081 dev server）；loadError：非空时不加载 url、直接进错误页（值为
 *   失败原因描述，runProd 预检未通过时使用，url 仍作为重试目标传入）
 */
function createWindow(url, { isDev = false, loadError = null } = {}) {
  const win = new BrowserWindow({
    ...baseWindowOptions({ titleBarH: 56 }), // TopBar 行高（h-14）
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
  });
  mainWindow = win;
  forwardWindowState(win);
  showWhenReady(win);
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
      // 关主窗即退出整个应用：播放独立窗一并关闭，避免无入口的后台残留
      // （复制一份再遍历——close 会触发 closed 回调改动集合本身）
      for (const p of [...playerWindows]) p.close();
    }
  });
  attachLoadFailureHandler(win, url, { isDev });
  if (loadError) {
    loadErrorPage(win, url, loadError);
  } else {
    win.loadURL(url);
  }
  return win;
}

// ============================================================================
// 三种模式的主流程
// ============================================================================

/** 生产模式：内嵌服务 + 静态产物窗口 */
async function runProd() {
  const { serverRoot, webDist } = resolvePaths();
  console.log(`[月幕桌面端] 生产装配：server=${serverRoot}`);
  console.log(`[月幕桌面端] 前端产物：${webDist}`);
  const backend = await startBackend({ serverRoot, webDist, reuseIfAlive: true });
  embeddedServer = backend.server; // 复用外部服务时为 null，退出时无需关闭
  if (backend.embedded) {
    console.log(`[月幕桌面端] 内嵌服务已启动：${backend.baseUrl}`);
    if (backend.apiParam) {
      console.log(`[月幕桌面端] ${PREFER_PORT} 被不可复用的进程占用（无应用页面的裸后端或其它服务），已改用空闲端口`);
    }
  } else {
    console.log(`[月幕桌面端] 端口 ${PREFER_PORT} 已有完整月幕装配（页面 + API），直接复用：${backend.baseUrl}`);
  }
  // 换端口场景必须把实际地址经 ?api= 告知前端（app/src/lib/api-base.js
  // 默认基址是 3001）；3001 场景与默认一致，不加参数、行为与现状相同
  const url = backend.apiParam
    ? `${backend.baseUrl}/?api=${encodeURIComponent(backend.baseUrl)}`
    : `${backend.baseUrl}/`;
  // 播放独立窗深链的 URL 前缀与 api 注入口径（同上）
  rendererOrigin = backend.baseUrl;
  rendererApiParam = backend.apiParam ? backend.baseUrl : null;
  // —— 开窗前预检（与 backendUsable 同口径）：拦下「服务起了但页面 404」
  //    （裸后端被误复用 / 产物缺 index.html 等），404 是成功的导航，
  //    did-fail-load 兜不住，必须在开窗前变成错误页 ——
  const usable = await backendUsable(backend.baseUrl);
  lastMainWindowUrl = url;
  createWindow(url, usable ? {} : { loadError: '后端服务未返回应用页面（GET / 预检未通过）' });
}

/** 开发模式：直连 cli 预先拉起的 expo web dev server（8081），不内嵌起服务 */
async function runDev() {
  console.log('[月幕桌面端] 开发模式：加载 http://localhost:8081（后端由 cli 起在 3001）');
  rendererOrigin = 'http://localhost:8081';
  rendererApiParam = null; // dev 前端默认基址即 localhost:3001，无需注入
  lastMainWindowUrl = 'http://localhost:8081';
  createWindow('http://localhost:8081', { isDev: true });
}

/**
 * 自检模式：不创建窗口；走生产装配（未打包路径解析）起内嵌服务后断言：
 *   1) GET / 的 HTML 含 id="root"（expo 静态导出的应用挂载点）；
 *   2) GET /api/sites 返回非空 JSON 数组（站点清单裸数组契约）。
 * 全部通过打印 [desktop-selftest] OK 并退出码 0；任一失败打印原因退出码 1。
 * 防悬挂三重兜底：30s 总看门狗 + 未捕获异常兜底 + stopServer 限时关闭。
 */
async function runSelftest() {
  const watchdog = setTimeout(() => {
    console.error('[desktop-selftest] FAIL：总超时（30s），强制退出');
    app.exit(1);
  }, 30000);

  let server = null;
  try {
    const { serverRoot, webDist } = resolvePaths();
    console.log(`[desktop-selftest] 装配 serverRoot：${serverRoot}`);
    console.log(`[desktop-selftest] 装配 webDist：${webDist}`);
    // 自检不复用外部 3001：断言对象必须是本进程按生产装配拉起的服务
    const backend = await startBackend({ serverRoot, webDist, reuseIfAlive: false });
    server = backend.server;
    console.log(`[desktop-selftest] 内嵌服务：${backend.baseUrl}`);

    // —— 断言 1：GET / 的 HTML 含 id="root" ——
    const homeRes = await fetch(`${backend.baseUrl}/`, { signal: AbortSignal.timeout(10000) });
    if (!homeRes.ok) {
      throw new Error(`GET / 状态码 ${homeRes.status}（webDist 是否有 index.html？）`);
    }
    const html = await homeRes.text();
    if (!html.includes('id="root"')) {
      throw new Error('GET / 的 HTML 不含 id="root"');
    }
    console.log(`[desktop-selftest] GET / 命中 id="root"（${html.length} 字节）`);

    // —— 断言 2：GET /api/sites 返回非空 JSON 数组 ——
    // 首访会触发 cms 资源站群 ensureInit + 后台预热，给足超时余量
    const sitesRes = await fetch(`${backend.baseUrl}/api/sites`, { signal: AbortSignal.timeout(25000) });
    if (!sitesRes.ok) {
      throw new Error(`GET /api/sites 状态码 ${sitesRes.status}`);
    }
    const sites = await sitesRes.json().catch(() => null);
    if (!Array.isArray(sites) || sites.length === 0) {
      throw new Error(`GET /api/sites 应为非空数组，实际：${JSON.stringify(sites)?.slice(0, 120)}`);
    }
    console.log(`[desktop-selftest] GET /api/sites 返回 ${sites.length} 个站点`);

    await stopServer(server);
    console.log('[desktop-selftest] OK');
    await flushAndExit(0);
  } catch (err) {
    console.error(`[desktop-selftest] FAIL：${(err && err.message) || err}`);
    await stopServer(server);
    await flushAndExit(1);
  }
}

/**
 * 打印缓冲冲刷后退出：Windows 管道下 stdout 是异步写，app.exit 前稍等
 * 一拍，确保 [desktop-selftest] OK / FAIL 一定先于进程结束落盘
 * @param {number} code 退出码
 */
async function flushAndExit(code) {
  await new Promise((resolve) => setTimeout(resolve, 60));
  app.exit(code);
}

/** 启动失败统一出口（whenReady 拒绝 / 顶层异常走到这里时） */
function fatal(err) {
  const detail = (err && err.stack) || String(err);
  if (MODE === 'selftest') {
    console.error(`[desktop-selftest] FAIL：${detail}`);
    app.exit(1);
  } else {
    console.error(`[月幕桌面端] 启动失败：${detail}`);
    app.exit(1);
  }
}

// ============================================================================
// 生命周期：单实例锁 / 退出清理 / 未捕获异常兜底
// ============================================================================

// —— 未捕获异常兜底：任何模式都不许悬挂；selftest 模式必须落退出码 ——
process.on('uncaughtException', (err) => {
  const detail = (err && err.stack) || String(err);
  if (MODE === 'selftest') {
    console.error(`[desktop-selftest] FAIL：未捕获异常 ${detail}`);
    app.exit(1);
  } else {
    console.error(`[月幕桌面端] 未捕获异常：${detail}`);
  }
});
process.on('unhandledRejection', (err) => {
  const detail = (err && err.stack) || String(err);
  if (MODE === 'selftest') {
    console.error(`[desktop-selftest] FAIL：未处理的 Promise 拒绝 ${detail}`);
    app.exit(1);
  } else {
    console.error(`[月幕桌面端] 未处理的 Promise 拒绝：${detail}`);
  }
});

// —— 单实例锁：已有实例时聚焦既有窗口，本进程让位退出 ——
// selftest 先把 userData 指到独立固定目录再取锁：锁按 userData 路径判定，
// 构建期对打包装配跑自检时（cli build macos 的产物验证步），用户可能正开着
// 月幕——不隔离会被锁误杀成 FAIL（自检按退出码判定，误杀 = 构建假失败）
if (MODE === 'selftest') {
  try {
    app.setPath('userData', path.join(os.tmpdir(), 'moontent-desktop-selftest'));
  } catch { /* 隔离失败退回默认锁行为（同机开两自检的场景本就罕见） */ }
}
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  if (MODE === 'selftest') {
    // 自检按退出码判定，锁被占用意味着自检压根没跑：必须显式 FAIL + 非零
    // 退出码（app.quit() 是退出码 0，自动化会把「没跑」误判为通过）
    console.error('[desktop-selftest] FAIL：单实例锁被占用（已有月幕桌面实例在运行）');
    flushAndExit(1); // 稍等一拍再 exit，保证 FAIL 行先于进程结束落盘
  } else {
    app.quit();
  }
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // —— macOS：主窗已关而进程未退的窗口期（如退出被外部阻塞），点 Dock
  //    图标兜底重建主窗（正常路径 window-all-closed 即退出，走不到这里） ——
  app.on('activate', () => {
    if (!mainWindow && rendererOrigin && lastMainWindowUrl) {
      createWindow(lastMainWindowUrl, { isDev: MODE === 'dev' });
    }
  });

  // —— 退出清理：窗口关全即退出；退出前关闭内嵌服务（若为本进程所有） ——
  app.on('window-all-closed', () => {
    app.quit();
  });
  app.on('before-quit', () => {
    if (embeddedServer) {
      try {
        if (typeof embeddedServer.closeAllConnections === 'function') {
          embeddedServer.closeAllConnections();
        }
        embeddedServer.close(() => {});
      } catch { /* 退出路径尽力关闭，失败不阻断退出 */ }
    }
    // 分片端口一并尽力关闭（退出路径，失败不阻断；数组元素含 listen 失败的
    // 死服务，close 对其回调带 ERR_SERVER_NOT_RUNNING，静默即可）
    for (const srv of shardServers) {
      try {
        if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
        srv.close(() => {});
      } catch { /* 尽力关闭 */ }
    }
  });

  app.whenReady().then(() => {
    registerIpc(); // 窗口控制 / 播放窗通道（自检模式不建窗，注册亦无害）
    if (MODE === 'selftest') return runSelftest();
    if (MODE === 'dev') return runDev();
    return runProd();
  }).catch(fatal);
}
