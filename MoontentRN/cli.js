#!/usr/bin/env node
// ============================================================================
// 月幕 MoontentRN 多端启动器 / 打包器（cli.js）
// ----------------------------------------------------------------------------
// 定位：零第三方依赖的 Node 脚本（CommonJS），`node cli.js` 直接运行，
//       统一负责后端（server）、前端（app，Expo SDK 57）与桌面端
//       （desktop，Electron，由并行工程师按契约提供）的「运行」与「打包」。
//
// 已核实的官方事实（2026-10，Expo SDK 57 / @expo/cli 57.0.28，本机实测
// `npx expo export --help`、`npx expo start --help`、`npx expo prebuild --help`
// 并对照 https://docs.expo.dev/more/expo-cli.md）：
//   1) expo export 指定输出目录的参数是 `--output-dir <dir>`（默认 dist）；
//      平台参数 `-p, --platform` 取值 android | ios | web | all。
//   2) expo start 没有任何「不打开浏览器」的命令行开关（--help 中不存在
//      --no-open 之类）；@expo/cli 源码 build/src/utils/open.js 的
//      openBrowserAsync() 明确写着：环境变量 BROWSER=none 时直接返回、不打开
//      浏览器。因此禁止自动打开浏览器的正确做法是子进程环境加 BROWSER=none。
//   3) expo prebuild 用 `-p, --platform <all|android|ios>` 选择平台，
//      `npx expo prebuild -p android` 用法成立。
//   4) iOS 真机链路（2026-10 本机实测，Xcode 26.6 + iOS 27.2 Beta 真机）：
//      a. xcodebuild 自动签名组合拳：-destination 'generic/platform=iOS'
//         + -allowProvisioningUpdates + -allowProvisioningDeviceRegistration
//         + DEVELOPMENT_TEAM=<id> + CODE_SIGN_STYLE=Automatic；账号须已在
//         Xcode Settings → Accounts 登录。PLA 待同意（error 文案「PLA Update
//         available」）与旧证书待撤销（「Revoke certificate」）会以构建错误
//         形式出现，需人为在 developer.apple.com / Xcode 处理后重跑；缺
//         iOS 平台组件（「iOS xx is not installed」）先跑一次
//         `xcodebuild -downloadPlatform iOS`（数 GB 下载）。
//      b. 团队 ID 可从 `defaults read com.apple.dt.Xcode
//         IDEProvisioningTeamByIdentifier` 解析（每账号块内 teamID/teamName/
//         teamType 三行；优先 teamType=Individual 个人团队），IOS_TEAM_ID
//         环境变量可显式覆盖。
//      c. 装机 / 拉起用 xcrun devicectl（CoreDevice，不依赖 Xcode GUI，真机
//         Beta 系统也可用）：`device install app --device <id> <app.app>`、
//         `device process launch --device <id> [-e '<json环境变量>'] <bundleId>`
//         （-e 的 JSON 字典即拉起环境，RCT_METRO_HOST / EXPO_PACKAGER_PROXY_URL
//         指 Metro）；设备清单 `devicectl list devices --json-output <file>`
//         （jsonVersion 3：result.devices[].identifier、deviceProperties.name；
//         可用判据 connectionProperties.pairingState=paired 即候选——
//         tunnelState/transportType 在 wired/localNetwork/connected 间漂移，
//         隧道未连时 install/launch 也会按需自动建连；IOS_DEVICE 环境变量
//         按 id/名称选设备）。
//      d. bundleId 用 `plutil -extract CFBundleIdentifier raw <app>/Info.plist`
//         读取（macOS 自带 plutil，比解析 ESM 的 app.config.js 简单可靠）。
//      e. EXPO_PUBLIC_API_BASE 在 Metro 打包期内联进 JS：debug 变体由 run ios
//         的 Metro 子进程注入（每次热载生效）；release 变体由 xcodebuild
//         子进程（bundle 阶段脚本继承 env）注入，构建后固化进 .app。
//   5) Android 变体差异（依据本工程 app/android/app/build.gradle 模板与
//      React Native Gradle Plugin 行为核实）：debug 属默认 debuggableVariants，
//      assembleDebug 不打 JS 包（不跑 Metro/hermesc）、不做 release 独有的
//      PNG 压缩，故明显快于 assembleRelease；代价是 APK 不内嵌 JS，启动需
//      Metro 开发服务器（node cli.js run android），且与 release 同包名
//      com.moontent.app（安装互相覆盖）。本模板 minifyEnabled 默认 false
//      （未设 android.enableMinifyInReleaseBuilds），release 慢的大头是 JS
//      打包而非 R8。gradle.properties 模板注释明示可用
//      -PreactNativeArchitectures=<abi> 在命令行覆盖架构清单。
//   6) 原生工程「过期」防线（2026-10-08 事故复盘）：expo prebuild 是唯一把
//      app.config.js 的原生配置（iOS ATS 明文放行、Android usesCleartextTraffic
//      等）写进 native 工程的环节；而 build 为提速在原生工程已存在时跳过它，
//      于是后续新增的配置永远进不了包——ios release 演示包的 API 是公网明文
//      http://，ATS 未放行时被系统原生层拦下，JS 侧只看到「fetch failed」
//      （栈顶落在 expo-modules-core/ios/Core/Promise.swift 的 promise 拒绝，
//      离病因很远），排查绕远。现以 mtime 实测为判据：app 配置/依赖清单
//      （app.config.js、app.json、package.json、package-lock.json）新于原生
//      工程关键文件即视为过期，自动补跑 prebuild 对齐；配置未动照旧跳过提速。
//      判据可行性已实测：prebuild 每次必重写它生成的关键文件（ios/Podfile、
//      android/app/src/main/AndroidManifest.xml 的 mtime 每次 prebuild 后必刷新，
//      内容无变化也写）。配套：prebuild 改写 Podfile 后 Podfile.lock 即过期，
//      xcodebuild 的 [CP] Check Pods Manifest.lock 阶段会报 sandbox 不同步而
//      直接失败——故 Podfile / Podfile.properties.json 新于 Podfile.lock 时
//      自动补 pod install。
//
// 约定（与 desktop / app 工程师的三方契约，见任务说明）：
//   - desktop/package.json：name "moontent-desktop"、type module、
//     scripts.start="electron ."、scripts.dev="electron . --dev"；
//   - server 的 npm start 在 3001 端口起 Koa 服务；
//   - app 的 Web 产物导出到 MoontentRN/dist/web（server/desktop 均消费该目录）；
//   - electron-builder 通过 --config.directories.output 在命令行覆盖输出目录，
//     yml 中不写 directories.output；
//   - deploy 子命令（node cli.js deploy server / deploy web）：把 server 与
//     dist/web 发布到 deploy.config.json 指定的服务器（scp 上传 + systemd
//     常驻 + 健康检查 + 失败自动回滚），凭据与参数模板见
//     deploy.config.example.json，远端脚本在 deploy/remote-*.sh。
//   - install 子命令（node cli.js install android）：把 dist/android 下最新
//     APK 经 adb 装到已连接安卓真机（install -r 保留数据，装完默认拉起，
//     --no-launch 跳过）。adb 定位：ADB_BIN → ANDROID_HOME → 平台默认 SDK
//     路径（macOS ~/Library/Android/sdk）→ PATH；ANDROID_DEVICE 按序列号选
//     设备（对称于 iOS 的 IOS_DEVICE）；只剩 unauthorized 设备时轮询等待
//     手机上确认授权弹窗。
//
// 平台过滤：win32 不提供 ios/macos 打包（菜单不显示、命令不接受）；
//           darwin 提供全量目标。桌面端调试 mac/Windows 完全同链（后台
//           expo web dev + 前台 electron . --dev，Electron 随宿主机平台
//           运行），run 目标据此合并为单一的 desktop。
// ============================================================================

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline/promises');

// —— 目录常量：一律基于 __dirname 解析，与启动时的 cwd 无关 ——
const ROOT = path.resolve(__dirname);          // MoontentRN/
const APP_DIR = path.join(ROOT, 'app');        // Expo 前端
const SERVER_DIR = path.join(ROOT, 'server');  // Koa 后端
const DESKTOP_DIR = path.join(ROOT, 'desktop');// Electron 桌面端（并行工程）
const DIST_DIR = path.join(ROOT, 'dist');      // 统一产物输出根目录
const DEPLOY_CONFIG = path.join(ROOT, 'deploy.config.json'); // 部署配置（凭据+参数）
const DEPLOY_DIR = path.join(ROOT, 'deploy');  // deploy 子命令的远端脚本

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const BACKEND_PORT = 3001;   // server 的 npm start 端口
const EXPO_WEB_PORT = 8081;  // expo web dev server 默认端口（--help 实测默认 8081）

// —— npm/npx 在 Windows 上是 .cmd 脚本，Node 18.20+ 出于安全（CVE-2024-27980）
//    禁止无 shell 直接 spawn .cmd/.bat，故 Windows 统一走 shell:true 拼命令行 ——
const NPM = IS_WIN ? 'npm.cmd' : 'npm';
const NPX = IS_WIN ? 'npx.cmd' : 'npx';

// ============================================================================
// 目标清单与平台过滤
// ============================================================================

// run 目标：key → { platforms: 受支持平台, label: 菜单文案 }
const RUN_TARGETS = {
  android: { platforms: ['win32', 'darwin'], label: '运行到安卓真机' },
  web: { platforms: ['win32', 'darwin'], label: '运行到 web' },
  ios: { platforms: ['darwin'], label: '运行到 iOS 真机（Metro 热更新调试）' },
  // 桌面调试 mac/Windows 完全同链路（后台 expo web dev + 前台 electron . --dev，
  // Electron 随宿主机平台运行），故合并为单一 desktop 目标；build 仍分 win/macos
  desktop: { platforms: ['win32', 'darwin'], label: '运行到桌面端（Electron 调试）' },
};

// build 目标：key → { platforms, label, desc }
const BUILD_TARGETS = {
  web: {
    platforms: ['win32', 'darwin'],
    label: '打包 Web 静态站点',
    desc: 'expo export → dist/web',
  },
  android: {
    platforms: ['win32', 'darwin'],
    label: '打包 Android APK',
    desc: 'prebuild + gradle → dist/android；--debug 快速包 / --arm64 单架构提速',
  },
  ios: {
    platforms: ['darwin'],
    label: '打包 iOS 并安装到真机',
    desc: 'prebuild + pod + xcodebuild → devicectl 装机拉起；--debug 调试包 / --release 演示包 / --api 覆盖后端地址',
  },
  win: {
    platforms: ['win32', 'darwin'],
    label: '打包 Windows 安装包',
    desc: 'electron-builder → dist/win',
  },
  macos: {
    platforms: ['darwin'],
    label: '打包 macOS 安装包',
    desc: 'electron-builder --mac dmg → dist/macos',
  },
  all: {
    platforms: ['win32', 'darwin'],
    label: '打包全部（本机受支持目标）',
    desc: '按顺序执行，单项失败不中断，最后打印汇总表',
  },
};

// build all 的固定执行顺序（过滤到本机受支持的目标后使用）
const BUILD_ALL_ORDER = ['web', 'android', 'ios', 'win', 'macos'];

// deploy 目标：把已构建产物发布到远程服务器（连接信息见 deploy.config.json）
const DEPLOY_TARGETS = {
  server: {
    platforms: ['win32', 'darwin'],
    label: '部署服务器（后端）',
    desc: '打包 server 源码 → 上传 → systemd 守护 + 健康检查 + 失败自动回滚',
  },
  web: {
    platforms: ['win32', 'darwin'],
    label: '部署 web 站点',
    desc: 'expo export → 上传 → 由后端单服务托管（koa-static + SPA 补位）',
  },
};

// install 目标：把已构建产物安装到本机连接的设备（iOS 的装机拉起已在
// build ios 内完成，无需独立 install）
const INSTALL_TARGETS = {
  android: {
    platforms: ['win32', 'darwin'],
    label: '安装 APK 到安卓真机',
    desc: 'adb install -r → dist/android 下最新 APK，装完拉起；--no-launch 不拉起',
  },
};

/** 判断某 run/build 目标在当前平台是否受支持 */
function isSupported(map, target) {
  const item = map[target];
  return !!item && item.platforms.includes(process.platform);
}

/** 当前平台受支持的 run / build 目标键列表（保持定义顺序） */
function supportedRunTargets() {
  return Object.keys(RUN_TARGETS).filter((k) => isSupported(RUN_TARGETS, k));
}
function supportedBuildTargets() {
  return Object.keys(BUILD_TARGETS).filter((k) => k !== 'all' && isSupported(BUILD_TARGETS, k));
}
function supportedDeployTargets() {
  return Object.keys(DEPLOY_TARGETS).filter((k) => isSupported(DEPLOY_TARGETS, k));
}
function supportedInstallTargets() {
  return Object.keys(INSTALL_TARGETS).filter((k) => isSupported(INSTALL_TARGETS, k));
}

// ============================================================================
// 基础小工具
// ============================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 打印一行（统一走 console.log，输出均为中文） */
function say(msg) {
  console.log(msg);
}

/** 探测 host:port 是否可建立 TCP 连接（net.connect，不发起 HTTP 请求） */
function probePort(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.setTimeout(timeoutMs, () => finish(false));
  });
}

/** 轮询等待端口就绪；超时返回 false（不抛错，由调用方决定如何提示） */
async function waitPortReady(port, timeoutMs, host = '127.0.0.1') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePort(port, host)) return true;
    await sleep(500);
  }
  return false;
}

/** 取本机局域网 IPv4（供手机等外部设备访问）；取不到返回 null */
function getLanIp() {
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos || []) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return null;
}

/** Windows shell:true 命令行的简易引号包裹（我们的参数不含引号，够用） */
function winQuote(token) {
  return /[ \t"&<>|^]/.test(token) ? `"${token}"` : token;
}

// ============================================================================
// 子进程管理：注册表 + 退出/Ctrl-C 统一清理
// ============================================================================

const liveChildren = new Set(); // 所有由本进程拉起的子进程
let cleaningUp = false;

function registerChild(child) {
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
}

/**
 * 结束单个子进程（含其整个进程树）：
 * - Windows 用系统自带 taskkill /PID <pid> /T /F（/T 连子进程一起杀，
 *   否则 shell:true 拉起的 npm/expo/gradle 会残留）；
 * - POSIX 先 SIGTERM 再补 SIGKILL。
 */
function killTreeSync(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (IS_WIN) {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* 尽力而为，清理失败不阻断退出 */
    }
  } else {
    try {
      child.kill('SIGTERM');
      if (!child.killed) child.kill('SIGKILL');
    } catch {
      /* 同上 */
    }
  }
}

/** 清理全部子进程（幂等；信号处理与正常退出路径共用） */
function cleanupAll() {
  if (cleaningUp) return;
  cleaningUp = true;
  for (const child of [...liveChildren]) killTreeSync(child);
  liveChildren.clear();
}

function installExitHandlers() {
  // Ctrl-C（Windows 控制台同样以 SIGINT 送达 Node）与 SIGBREAK（Ctrl-Break）
  for (const sig of ['SIGINT', 'SIGBREAK', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      say(`\n[cli] 收到 ${sig}，正在清理子进程…`);
      cleanupAll();
      process.exit(130);
    });
  }
  // 兜底：无论以何退出码结束，都不留孤儿进程
  process.on('exit', () => cleanupAll());
}

/**
 * 统一子进程封装。
 * @param {object} opts
 *   - label     输出前缀标签（如 'server' / 'expo-web'）
 *   - cmd/args  命令与参数（Windows 内部拼成一行经 shell:true 执行，
 *               以兼容 npm.cmd / npx.cmd / gradlew.bat / electron.cmd）
 *   - cwd       工作目录（绝对路径）
 *   - envExtra  追加的环境变量（如 { BROWSER: 'none' }）
 *   - quiet     静默模式：输出仅缓存，结束时打印最后 tailLines 行
 *   - tailLines 静默模式下打印的尾部行数（默认 200）
 *   - background true=不等待结束（后台），false=等待并返回退出码
 *   - stdinData 非空时写入子进程 stdin 后关闭（deploy 经 `ssh … bash -s`
 *               送入远端脚本用；此时 stdin 由 ignore 改为 pipe）
 *   - onLine    每行输出的回调（deploy 捕获远端标记用；quiet 下同样触发）
 * @returns {{child: ChildProcess, promise: Promise<number>}}
 */
function runProcess(opts) {
  const {
    label, cmd, args = [], cwd, envExtra = {},
    quiet = false, tailLines = 200, background = false,
    stdinData = null, onLine = null,
  } = opts;

  if (!fs.existsSync(cwd)) {
    say(`[cli] 错误：目录不存在，无法执行 ${cmd}：${cwd}`);
    const p = Promise.resolve(1);
    return { child: null, promise: p };
  }

  const env = { ...process.env, ...envExtra };

  // Windows：拼命令行 + shell:true（.cmd 脚本必须如此，见文件头注释）；
  // POSIX：数组参数直接 spawn，无引号问题
  let child;
  const stdinMode = stdinData != null ? 'pipe' : 'ignore';
  if (IS_WIN) {
    const cmdLine = [winQuote(cmd), ...args.map(winQuote)].join(' ');
    child = spawn(cmdLine, { shell: true, cwd, env, stdio: [stdinMode, 'pipe', 'pipe'], windowsHide: true });
  } else {
    child = spawn(cmd, args, { cwd, env, stdio: [stdinMode, 'pipe', 'pipe'] });
  }

  registerChild(child);

  // 经 stdin 送入数据（远端脚本）；对端提前断开时的 EPIPE 忽略——退出码已能说明失败
  if (stdinData != null && child.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(stdinData);
  }

  const buffered = [];                       // quiet 模式的行缓存
  const pipeLines = (stream, isError) => {
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      rest += chunk;
      const lines = rest.split(/\r?\n/);
      rest = lines.pop();                    // 末尾可能是不完整行，留在缓冲
      for (const line of lines) {
        if (onLine) onLine(line);
        if (quiet) buffered.push(line);
        else say(`[${label}] ${isError ? '' : ''}${line}`);
      }
    });
    stream.on('end', () => {
      if (rest) {
        if (onLine) onLine(rest);
        if (quiet) buffered.push(rest);
        else say(`[${label}] ${rest}`);
      }
    });
  };
  pipeLines(child.stdout, false);
  pipeLines(child.stderr, true);

  const promise = new Promise((resolve) => {
    child.once('close', (code) => {
      if (quiet && buffered.length) {
        // 静默模式：结束时补打最后 N 行（自动化调用只需看结论与尾部日志）
        const tail = buffered.slice(-tailLines);
        say(`[cli] ── ${label} 输出（最后 ${tail.length}/${buffered.length} 行）──`);
        for (const line of tail) say(`[${label}] ${line}`);
      }
      resolve(code === null ? 1 : code);     // 被信号杀死(code=null)按失败计
    });
  });

  if (!background) {
    return { child, promise };
  }
  // 后台进程：提前崩溃时给出提示，不阻塞调用方
  promise.then((code) => say(`[cli] 后台进程 [${label}] 已退出（退出码 ${code}）`));
  return { child, promise };
}

// ============================================================================
// 后端（server，端口 3001）
// ============================================================================

/**
 * 确保 3001 端口有后端在跑：
 * 先 net.connect 探测，未起则后台 spawn `npm start`（cwd=server），
 * 输出加 [server] 前缀透传；等待端口就绪（最多 60 秒），超时告警不中断。
 */
async function ensureBackend() {
  if (await probePort(BACKEND_PORT)) {
    say(`[cli] 后端已在 ${BACKEND_PORT} 端口运行，直接复用`);
    return true;
  }
  say(`[cli] 后端未启动，正在后台拉起（目录 ${SERVER_DIR}）…`);
  runProcess({
    label: 'server', cmd: NPM, args: ['start'], cwd: SERVER_DIR, background: true,
  });
  const ok = await waitPortReady(BACKEND_PORT, 60_000);
  say(ok ? `[cli] 后端已就绪：http://127.0.0.1:${BACKEND_PORT}` : '[cli] 警告：后端 60 秒内未在 3001 就绪，继续执行（请查看 [server] 输出）');
  return ok;
}

// ============================================================================
// run 子命令
// ============================================================================

/** 局域网连接指引（安卓真机 / iOS 真机场景通用） */
function printLanGuide() {
  const ip = getLanIp();
  say('');
  say('==================================================');
  say('手机连接指引（手机与电脑需在同一局域网）：');
  if (ip) {
    say(`  本机局域网 IP：${ip}`);
    say(`  App 内「我的 → 设置 → 服务器地址」填：http://${ip}:${BACKEND_PORT}`);
  } else {
    say('  未检测到局域网 IPv4 地址（可用 ipconfig / ifconfig 自行确认）');
    say(`  App 内「我的 → 设置 → 服务器地址」填：http://<本机局域网IP>:${BACKEND_PORT}`);
  }
  say('  终端出现二维码后，用 Expo Go 扫码即可加载开发端');
  say('==================================================');
  say('');
}

/**
 * run <target> 主流程。
 * 共同点：先确保 3001 后端；前台进程结束后统一清理并按其退出码退出。
 */
async function cmdRun(target) {
  installExitHandlers();
  await ensureBackend();

  let fg;
  if (target === 'android') {
    // 安卓真机：前台起 Expo 开发服务器（默认 host=lan，终端出二维码），
    // 并打印局域网 IP 与「我的 → 设置 → 服务器地址」指引
    printLanGuide();
    say(`[cli] 正在启动 Expo 开发服务器（目录 ${APP_DIR}），按 Ctrl-C 退出…`);
    fg = runProcess({
      label: 'expo',
      cmd: NPX,
      args: ['expo', 'start'],
      cwd: APP_DIR,
      envExtra: { BROWSER: 'none' },
    });
  } else if (target === 'ios') {
    // iOS 真机（配合 build ios --debug 装进手机的开发包）：后台 Metro
    // （--dev-client，与 web dev 同端口）→ 就绪后带 Metro 地址拉起手机上的
    // App → 前台等待（Ctrl-C 一并清理）。EXPO_PUBLIC_API_BASE 随 Metro 注入
    // （构建期内联），手机上 App 的 API 自动指向本机局域网后端。
    const lanIp = getLanIp();
    const device = pickIosDevice(listConnectedIosDevices());
    say('[cli] iOS 真机调试：Metro 开发服务器 → 手机 debug 包热更新（未装包先执行 node cli.js build ios --debug）');
    say(`[cli] 正在后台启动 Metro（目录 ${APP_DIR}，--dev-client）…`);
    const metroEnv = { BROWSER: 'none' };
    if (lanIp) metroEnv.EXPO_PUBLIC_API_BASE = `http://${lanIp}:${BACKEND_PORT}`;
    const metro = runProcess({
      label: 'expo',
      cmd: NPX,
      args: ['expo', 'start', '--dev-client'],
      cwd: APP_DIR,
      envExtra: metroEnv,
      background: true,
    });
    const ready = await waitPortReady(EXPO_WEB_PORT, 180_000, lanIp || '127.0.0.1');
    if (!ready) {
      say(`[cli] 错误：Metro ${EXPO_WEB_PORT} 端口 180 秒内未就绪，中止`);
      cleanupAll();
      return 1;
    }
    if (lanIp) {
      say(`[cli] Metro 就绪：http://${lanIp}:${EXPO_WEB_PORT}（已注入 EXPO_PUBLIC_API_BASE=${metroEnv.EXPO_PUBLIC_API_BASE}）`);
    }
    if (device) {
      const bundleId = latestIosBundleId('Debug');
      if (bundleId && lanIp) {
        await devicectlLaunch(device.id, bundleId, {
          RCT_METRO_HOST: `${lanIp}:${EXPO_WEB_PORT}`,
          EXPO_PACKAGER_PROXY_URL: `http://${lanIp}:${EXPO_WEB_PORT}`,
        });
      } else {
        say('[cli] 提示：未解析到已装包的 bundleId（或无局域网 IP），请在手机上手动打开 App');
      }
    } else {
      say('[cli] 未检测到已连接 iPhone：请在手机上手动打开 App（摇一摇出开发菜单可切换 Metro 地址）');
    }
    say('[cli] Metro 运行中：保存代码即热更新；Metro 终端按 j 打开调试器；Ctrl-C 退出');
    fg = metro;
  } else if (target === 'web') {
    // 前台 Expo Web 开发服务器；BROWSER=none 禁止自动打开浏览器（见文件头核实结论）
    say(`[cli] 正在启动 Expo Web 开发服务器（目录 ${APP_DIR}），禁止自动打开浏览器，按 Ctrl-C 退出…`);
    fg = runProcess({
      label: 'expo-web',
      cmd: NPX,
      args: ['expo', 'start', '--web'],
      cwd: APP_DIR,
      envExtra: { BROWSER: 'none' },
    });
  } else {
    // desktop：后台 expo web dev（8081，等端口就绪）+ 前台 electron . --dev
    //（mac/Windows 调试同链路：Electron 随宿主机平台运行，无平台分支）
    const missing = checkDesktopReady('运行');
    if (missing) {
      // 对齐 buildDesktop 路径（prepareDesktopBuild 打印后返回）：错误消息必须
      // 落到输出，否则新克隆仓库首次 run desktop 时进程静默退出码 1、无任何提示
      say(missing);
      return 1;
    }

    say(`[cli] 正在后台启动 Expo Web 开发服务器（端口 ${EXPO_WEB_PORT}）…`);
    runProcess({
      label: 'expo-web',
      cmd: NPX,
      args: ['expo', 'start', '--web'],
      cwd: APP_DIR,
      envExtra: { BROWSER: 'none' },
      background: true,
    });
    const ready = await waitPortReady(EXPO_WEB_PORT, 180_000);
    if (!ready) {
      say(`[cli] 错误：Expo Web 开发服务器 ${EXPO_WEB_PORT} 端口 180 秒内未就绪，中止`);
      cleanupAll();
      return 1;
    }
    say(`[cli] Expo Web 已就绪（http://localhost:${EXPO_WEB_PORT}），启动 Electron 调试模式…`);
    const electronBin = electronBinPath();
    fg = runProcess({
      label: 'electron',
      cmd: electronBin,
      args: ['.', '--dev'],
      cwd: DESKTOP_DIR,
    });
  }

  const code = await fg.promise;
  say(`[cli] 前台进程已结束（退出码 ${code}），清理其余子进程…`);
  cleanupAll();
  return code;
}

// ============================================================================
// build 子命令
// ============================================================================

/** desktop 端 electron 可执行文件路径（node_modules/.bin 下） */
function electronBinPath() {
  return path.join(DESKTOP_DIR, 'node_modules', '.bin', IS_WIN ? 'electron.cmd' : 'electron');
}

/**
 * desktop 就绪检查（run 与 build 共用）：
 * 返回中文错误消息（未就绪）或 null（就绪）。
 */
function checkDesktopReady(scene) {
  if (!fs.existsSync(path.join(DESKTOP_DIR, 'package.json'))) {
    return `[cli] 错误：${DESKTOP_DIR} 尚未就绪（缺 package.json）。desktop 端由并行工程师提供，请确认其已创建后再${scene}。`;
  }
  if (!fs.existsSync(electronBinPath())) {
    return `[cli] 错误：desktop 依赖未安装（找不到 ${electronBinPath()}）。请先在 MoontentRN/desktop 下执行 npm install。`;
  }
  return null;
}

/** build web：cwd=app 执行 npx expo export --platform web --output-dir ../dist/web */
async function buildWeb(quiet) {
  say(`[cli] 打包 Web 静态站点 → ${path.join(DIST_DIR, 'web')} …`);
  const { promise } = runProcess({
    label: 'build:web',
    cmd: NPX,
    args: ['expo', 'export', '--platform', 'web', '--output-dir', path.join('..', 'dist', 'web')],
    cwd: APP_DIR,
    quiet,
  });
  const code = await promise;
  const indexHtml = path.join(DIST_DIR, 'web', 'index.html');
  if (code !== 0) {
    say('[cli] build web 失败（expo export 退出码非 0）');
    return { ok: false, note: 'expo export 失败' };
  }
  if (!fs.existsSync(indexHtml)) {
    say(`[cli] build web 异常：导出结束但未找到 ${indexHtml}`);
    return { ok: false, note: '导出目录缺少 index.html' };
  }
  say(`[cli] build web 成功：${indexHtml}`);
  return { ok: true, note: indexHtml };
}

/** 读取 app/android/local.properties 中 sdk.dir= 行（存在则返回非空值） */
function readLocalPropsSdkDir() {
  const file = path.join(APP_DIR, 'android', 'local.properties');
  if (!fs.existsSync(file)) return null;
  const m = fs.readFileSync(file, 'utf8').match(/^sdk\.dir\s*=\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

/**
 * build android 前置检测：JAVA_HOME 必须有；
 * ANDROID_HOME/ANDROID_SDK_ROOT 或 app/android/local.properties（sdk.dir）任一即可。
 * 返回缺失项中文描述数组（空数组=通过）。
 */
function checkAndroidToolchain() {
  const missing = [];
  if (!process.env.JAVA_HOME) missing.push('JAVA_HOME（JDK 17，Gradle 与 Android Gradle Plugin 均需要）');
  const hasSdkEnv = Boolean(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT);
  if (!hasSdkEnv && !readLocalPropsSdkDir()) {
    missing.push('ANDROID_HOME / ANDROID_SDK_ROOT（或 app/android/local.properties 中有效的 sdk.dir）');
  }
  return missing;
}

function printAndroidInstallGuide(missing) {
  say('[cli] build android 前置检测未通过，缺以下环境（退出码 2，未触发构建）：');
  for (const item of missing) say(`  - 缺少：${item}`);
  say('安装指引：');
  say('  1) 安装 JDK 17（Temurin 等），设置环境变量 JAVA_HOME 指向 JDK 目录，并把 %JAVA_HOME%\\bin 加入 PATH；');
  say('  2) 安装 Android Studio（含 Android SDK），设置 ANDROID_HOME 指向 SDK 目录（Windows 常见：');
  say('     %LOCALAPPDATA%\\Android\\Sdk；macOS 常见：~/Library/Android/sdk），或确认 ANDROID_SDK_ROOT；');
  say('  3) 若用 local.properties 方式：在 MoontentRN/app/android/local.properties 写一行');
  say('     sdk.dir=<你的 SDK 绝对路径>（Windows 路径需转义为 \\\\ 或使用正斜杠）；');
  say('  4) 配置完成后重开终端（让新环境变量生效），再次执行：node cli.js build android');
}

/** 在目录下按扩展名递归找文件（返回相对 root 的路径数组） */
function findFilesByExt(root, ext) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.toLowerCase().endsWith(ext)) found.push(path.relative(root, full));
    }
  };
  walk(root);
  return found;
}

/** 在 outputsDir 下找 .apk（无扩展名过滤参数则全找），返回绝对路径或 null */
function findApk(outputsDir) {
  const list = findFilesByExt(outputsDir, '.apk');
  return list.length ? path.join(outputsDir, list[0]) : null;
}

// ============================================================================
// Android 构建提速补丁（幂等：打过补丁的文件带 marker，重复执行自动跳过）
// ----------------------------------------------------------------------------
// 针对两类耗时大头：
// 1) 国内网络直连 google()/mavenCentral()/services.gradle.org 慢且易断：
//    - wrapper 分发地址换腾讯镜像（同版本 gradle-*-bin.zip 直链）；
//    - 各 gradle 脚本的 google()/mavenCentral() 前插阿里云对应镜像仓库，
//      原仓库地址保留在后兜底（镜像缺件时 Gradle 自动回落官方源）。
// 2) gradle.properties 默认单线程、无缓存、2g 堆：
//    - org.gradle.parallel / org.gradle.caching：多模块并行 + 任务级增量缓存，
//      重复构建只重跑变更任务（配合下方「跳过重复 prebuild」，二次构建从
//      分钟级降到秒级）；
//    - jvmargs 扩到 4g：RN + Hermes 打包期内存峰值高，默认 2g 频繁 GC 停顿；
//    - daemon / configuration-cache：编译进程常驻（跨次构建免 JVM 冷启动，
//      省十几秒启动期）+ 缓存配置阶段（本模板 react{} 块在配置期要拉起
//      4 个 node 子进程探测路径，缓存后整段跳过；problems=warn 保证个别
//      任务不兼容时仅告警降级、不失败）。
// 3) app/build.gradle 跳过 release 的 lintVital：AGP 在 release 组装时挂
//    lintVitalRelease，RN 依赖图大、动辄数十秒，自用/内部分发无需该检查。
// 注意：*.properties 是 Java properties 语法，行尾注释会被并进值里（分发地址
// 会带着注释去下载而 404），marker 一律独立注释行。
// ============================================================================
const GRADLE_PATCH_MARK = 'moontent-fast-build';

function patchAndroidGradle(androidDir) {
  try {
    // --- 1) wrapper 分发地址换腾讯镜像 ---
    // 注意：properties 文件里 URL 常写作转义形式 https\://（冒号前的反斜杠），
    // 故用「行首 distributionUrl= 直到行尾」整行替换，不做精确 URL 匹配。
    const wrapperProps = path.join(androidDir, 'gradle', 'wrapper', 'gradle-wrapper.properties');
    if (fs.existsSync(wrapperProps)) {
      const wp = fs.readFileSync(wrapperProps, 'utf8');
      if (!wp.includes(GRADLE_PATCH_MARK) && wp.includes('services.gradle.org')) {
        const patched = wp.replace(
          /^distributionUrl=.*\/distributions\/(gradle-[0-9.]+-(?:bin|all)\.zip).*$/m,
          `# ${GRADLE_PATCH_MARK}\ndistributionUrl=https\\://mirrors.cloud.tencent.com/gradle/$1`,
        );
        if (patched !== wp) {
          fs.writeFileSync(wrapperProps, patched);
          say('[cli] 提速补丁：gradle wrapper 分发地址已换腾讯镜像');
        }
      }
    }

    // --- 2) 仓库镜像：google()/mavenCentral() 前插阿里云镜像（原仓库保留兜底） ---
    const gradleFiles = ['build.gradle', 'settings.gradle', 'app/build.gradle']
      .map((f) => path.join(androidDir, f))
      .filter((f) => fs.existsSync(f));
    let repoPatched = false;
    for (const file of gradleFiles) {
      let src = fs.readFileSync(file, 'utf8');
      if (src.includes(GRADLE_PATCH_MARK)) continue; // 该文件已打过
      const before = src;
      src = src.replace(
        /(\n[ \t]*)google\(\)/g,
        `$1maven { url 'https://maven.aliyun.com/repository/google' } // ${GRADLE_PATCH_MARK}$1google()`,
      );
      src = src.replace(
        /(\n[ \t]*)mavenCentral\(\)/g,
        `$1maven { url 'https://maven.aliyun.com/repository/public' } // ${GRADLE_PATCH_MARK}$1mavenCentral()`,
      );
      if (src !== before) {
        fs.writeFileSync(file, src);
        repoPatched = true;
      }
    }
    if (repoPatched) say('[cli] 提速补丁：gradle 仓库已插阿里云镜像（官方源保留兜底）');

    // --- 3) gradle.properties 性能开关：逐项「缺则补」（用户/模板显式写过
    //     的值不覆盖），已打过补丁的老工程也能增量获得后续新增的开关；
    //     jvmargs 的整行改写仍用 marker 防重复（marker 独立注释行，见上方说明） ---
    const gprops = path.join(androidDir, 'gradle.properties');
    if (fs.existsSync(gprops)) {
      let gp = fs.readFileSync(gprops, 'utf8');
      let changed = false;
      // 模板文件末行常无换行符：不补换行直接追加会把新属性粘进上一行的值里
      if (gp && !gp.endsWith('\n')) { gp += '\n'; changed = true; }
      const JVM_ARGS = 'org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8';
      if (/^org\.gradle\.jvmargs=/m.test(gp)) {
        if (!gp.includes(GRADLE_PATCH_MARK)) {
          gp = gp.replace(/^org\.gradle\.jvmargs=.*$/m, `# ${GRADLE_PATCH_MARK}\n${JVM_ARGS}`);
          changed = true;
        }
      } else {
        gp += `${gp.includes(GRADLE_PATCH_MARK) ? '' : `# ${GRADLE_PATCH_MARK}\n`}${JVM_ARGS}\n`;
        changed = true;
      }
      const ensureProp = (line) => {
        const key = line.split('=')[0].replace(/\./g, '\\.');
        if (!new RegExp(`^${key}=`, 'm').test(gp)) {
          gp += `${line}\n`;
          changed = true;
        }
      };
      ensureProp('org.gradle.parallel=true');
      ensureProp('org.gradle.caching=true');
      ensureProp('org.gradle.daemon=true');
      ensureProp('org.gradle.configuration-cache=true');
      ensureProp('org.gradle.configuration-cache.problems=warn');
      if (changed) {
        fs.writeFileSync(gprops, gp);
        say('[cli] 提速补丁：gradle.properties 已启用并行/任务缓存/配置缓存/常驻 daemon 并扩堆到 4g');
      }
    }

    // --- 4) 跳过 release 的 lintVital 检查（assembleRelease 的一部分，
    //     RN 依赖图大、动辄数十秒）；幂等判据：文件出现过 checkReleaseBuilds
    //     即视为已处理 ---
    const appGradle = path.join(androidDir, 'app', 'build.gradle');
    if (fs.existsSync(appGradle)) {
      let ag = fs.readFileSync(appGradle, 'utf8');
      if (!ag.includes('checkReleaseBuilds')) {
        const patched = ag.replace(
          /^android\s*\{\s*$/m,
          `android { // ${GRADLE_PATCH_MARK}: 跳过 release lintVital\n    lint {\n        checkReleaseBuilds false\n        abortOnError false\n    }`,
        );
        if (patched !== ag) {
          fs.writeFileSync(appGradle, patched);
          say('[cli] 提速补丁：app/build.gradle 已跳过 release 的 lintVital 检查');
        }
      }
    }
  } catch (err) {
    // 补丁属尽力而为：失败只降速不致败，交由 gradle 走官方源
    say(`[cli] 提速补丁跳过（不影响构建）：${err.message}`);
  }
}

/** 把 gradle 产出的 APK 拷到 dist/android/；debug 包补打「需 Metro 开发服务器」提示 */
function copyApkToDist(apk) {
  const outDir = path.join(DIST_DIR, 'android');
  fs.mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, path.basename(apk));
  fs.copyFileSync(apk, dest);
  say(`[cli] build android 成功：${dest}`);
  if (/debug\.apk$/i.test(dest)) {
    say('[cli] 提示：这是 debug 包（不内嵌 JS）——先运行 node cli.js run android 启动开发服务器再打开 App；与 release 同包名，安装会互相覆盖');
  }
  return { ok: true, note: dest };
}

// —— 原生工程新鲜度（build android / ios 共用；背景与实测见文件头第 6 条）——

/** 「原生工程落后于 app 配置」的判据源：改了它们就要重跑 prebuild 才进包 */
const NATIVE_CONFIG_FILES = ['app.config.js', 'app.json', 'package.json', 'package-lock.json'];

/** 配置/依赖清单里最新的 mtime（ms；全部缺失返回 0，即永不判过期） */
function newestConfigMtime() {
  let newest = 0;
  for (const name of NATIVE_CONFIG_FILES) {
    try {
      newest = Math.max(newest, fs.statSync(path.join(APP_DIR, name)).mtimeMs);
    } catch {
      /* 缺文件跳过 */
    }
  }
  return newest;
}

/** 原生工程是否落后：markerFiles 任一缺失，或任一 mtime 早于最新的配置/依赖文件
 *  （markerFiles 传 prebuild 每次必重写的生成物，如 ios/Podfile、android 主
 *  AndroidManifest.xml；只有确认原生工程存在的调用方才该走到这里）。 */
function nativeProjectStale(markerFiles) {
  let oldest = Infinity;
  for (const file of markerFiles) {
    try {
      oldest = Math.min(oldest, fs.statSync(file).mtimeMs);
    } catch {
      return true; // 关键生成物缺失：补一次 prebuild（代价远小于配置陈旧的包）
    }
  }
  return newestConfigMtime() > oldest;
}

/**
 * build android：环境检测 → prebuild（已有 android/ 且不落后于 app 配置则跳过）
 * → gradle 构建对应变体 → 拷贝 APK 到 dist/android/。
 * @param {'release'|'debug'} variant release（默认）：内嵌 JS 的独立安装包，
 *   耗时大头是 Metro 打包 + hermesc 编译 + release 独有的 PNG 压缩；
 *   debug：属默认 debuggableVariants，跳过 JS 打包与资源拷贝，明显更快，
 *   但 APK 不内嵌 JS，启动需 Metro 开发服务器（node cli.js run android），
 *   且与 release 同包名 com.moontent.app（安装互相覆盖），仅适合开发调试。
 * @param {boolean} arm64 true=只打 arm64-v8a 单架构：默认打满 4 套 ABI
 *   （armeabi-v7a/arm64-v8a/x86/x86_64），现代手机均为 arm64，单架构少打
 *   3 套 .so 明显提速、包体更小；32 位机型与 x86 模拟器不适用（去掉 --arm64 重打）。
 */
async function buildAndroid(quiet, fresh, variant = 'release', arm64 = false) {
  const missing = checkAndroidToolchain();
  if (missing.length) {
    printAndroidInstallGuide(missing);
    return { ok: false, note: '前置环境缺失（退出码 2）', code: 2 };
  }
  say(`[cli] 前置检测通过（JAVA_HOME 与 Android SDK 均可用），开始打包 Android（变体 ${variant}${arm64 ? '，仅 arm64-v8a 架构' : ''}）…`);

  const androidDir = path.join(APP_DIR, 'android');
  const gradlew = path.join(androidDir, IS_WIN ? 'gradlew.bat' : 'gradlew');
  const hasNativeProject =
    fs.existsSync(path.join(androidDir, 'app', 'build.gradle')) && fs.existsSync(gradlew);

  // 1) 生成/同步 android 原生工程（CNG：不手改 android/ 目录）。
  //    提速：android/ 已存在且未指定 --fresh 时跳过 prebuild —— 它每次都重跑
  //    模板装配与依赖安装（数十秒），且重新生成 gradle 文件会冲掉下面的镜像/
  //    性能补丁；原生工程未变更时纯属重复劳动。改了 app.config.js / package.json
  //    后用 --fresh 强制重生成。--no-install：node_modules 已由外层保证，跳过
  //    prebuild 内部的包管理器步骤。
  //    「未变更」不能只看目录是否存在——配置晚于原生工程时必须补跑，否则
  //    app.config.js 的原生配置（如 usesCleartextTraffic 明文放行）进不了
  //    release 包（见文件头第 6 条）。
  const androidStale = hasNativeProject
    && nativeProjectStale([path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml')]);
  if (hasNativeProject && !fresh && !androidStale) {
    say('[cli] android/ 原生工程已存在且不落后于 app 配置，跳过 expo prebuild（提速；--fresh 可强制重生成）');
  } else {
    if (androidStale) {
      say('[cli] app 配置/依赖晚于 android/ 原生工程，自动补跑 expo prebuild 对齐'
        + '（否则本包沿用过期原生配置，如明文 HTTP 放行）…');
    }
    say(`[cli] 执行 npx expo prebuild -p android --no-install（目录 ${APP_DIR}）…`);
    const pre = await runProcess({
      label: 'build:android-prebuild',
      cmd: NPX, args: ['expo', 'prebuild', '-p', 'android', '--no-install'], cwd: APP_DIR, quiet,
    }).promise;
    if (pre !== 0) return { ok: false, note: 'expo prebuild 失败' };
  }
  if (!fs.existsSync(gradlew)) {
    say(`[cli] 错误：prebuild 后仍未找到 ${gradlew}`);
    return { ok: false, note: '未找到 gradlew' };
  }

  // 1.5) 提速补丁（幂等）：国内镜像 + gradle 并行/缓存/扩堆 + 跳过 lintVital
  patchAndroidGradle(androidDir);
  // --arm64 经命令行 -P 覆盖 gradle.properties 的 reactNativeArchitectures
  //（模板注释明示支持该覆盖方式；不改文件，后续全架构构建不受影响）
  const gradleRun = (task) => runProcess({
    label: `build:android-${task}`,
    cmd: gradlew,
    args: arm64 ? [task, '-PreactNativeArchitectures=arm64-v8a'] : [task],
    cwd: androidDir, quiet,
  }).promise;
  const releaseApkDir = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release');
  const debugApkDir = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug');

  // 2) gradle 构建变体
  if (variant === 'debug') {
    say('[cli] 执行 gradlew assembleDebug …');
    const code = await gradleRun('assembleDebug');
    const apk = code === 0 ? findApk(debugApkDir) : null;
    if (!apk) {
      say('[cli] 错误：assembleDebug 未产出 APK');
      return { ok: false, note: 'gradle 构建失败（debug 无产物）' };
    }
    return copyApkToDist(apk);
  }

  say('[cli] 执行 gradlew assembleRelease …');
  const relCode = await gradleRun('assembleRelease');
  let apk = findApk(releaseApkDir);
  if (relCode !== 0 || !apk) {
    say('[cli] assembleRelease 未产出 APK，回落执行 assembleDebug …');
    const dbgCode = await gradleRun('assembleDebug');
    apk = findApk(debugApkDir);
    if (dbgCode !== 0 || !apk) {
      say('[cli] 错误：assembleRelease 与 assembleDebug 均未产出 APK');
      return { ok: false, note: 'gradle 构建失败（release/debug 均无产物）' };
    }
  }

  // 3) 拷贝 APK 到 MoontentRN/dist/android/ 并打印路径
  return copyApkToDist(apk);
}

// —— web 产物新鲜度（build win / macos 前置判定；口径对齐 android/ios 原生
//    工程的 mtime 判定先例）：app 源码或关键配置有比 dist/web 更新的修改即
//    过期——否则会把上一代页面静默打进安装包（表现为「桌面端还是旧 UI」，
//    且无任何警告） ——

/**
 * dist/web 是否落后于 app 源码：app/src 树 / app.config.js / package.json
 * 任一比产物 index.html 新（1s 容差，防构建自身 touch 源文件的秒级竞态）即过期。
 * app/src 文件量千级以内，同步 stat 百毫秒级，构建期一次性开销可接受。
 * @returns {string|null} 过期描述（含最晚改动的源文件相对路径）；null = 新鲜
 */
function webDistOutdated() {
  const distIndex = path.join(DIST_DIR, 'web', 'index.html');
  let distMtime = 0;
  try {
    distMtime = fs.statSync(distIndex).mtimeMs;
  } catch {
    return null; // 产物缺失由调用方按「缺失」分支处理
  }
  let newest = distMtime;
  let newestFile = null;
  const consider = (file) => {
    try {
      const m = fs.statSync(file).mtimeMs;
      if (m > newest) { newest = m; newestFile = file; }
    } catch { /* 缺文件跳过 */ }
  };
  consider(path.join(APP_DIR, 'app.config.js'));
  consider(path.join(APP_DIR, 'package.json'));
  const srcDir = path.join(APP_DIR, 'src');
  const stack = [srcDir];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try {
      st = fs.statSync(cur);
    } catch {
      continue;
    }
    if (st.mtimeMs > newest) { newest = st.mtimeMs; newestFile = cur; }
    if (st.isDirectory()) {
      try {
        for (const name of fs.readdirSync(cur)) stack.push(path.join(cur, name));
      } catch { /* 枚举失败按已见 mtime 计 */ }
    }
  }
  if (newestFile && newest - distMtime > 1000) {
    return `app 源码/配置有比 dist/web 更新的修改（最晚：${path.relative(ROOT, newestFile)}）`;
  }
  return null;
}

/**
 * 确保桌面端可打包：web 产物缺失/过期先自动 build web（--no-web 跳过检测直接
 * 用现状产物、--force-web 无条件重建）；desktop 依赖缺失先 npm install。
 * @param {boolean} quiet
 * @param {{ noWeb?: boolean, forceWeb?: boolean }} [webOpts]
 * @returns {Promise<string|null>} 失败原因；null = 就绪
 */
async function prepareDesktopBuild(quiet, webOpts = {}) {
  const webIndex = path.join(DIST_DIR, 'web', 'index.html');
  if (!webOpts.noWeb) {
    let reason = null;
    if (!fs.existsSync(webIndex)) {
      reason = 'dist/web 缺失';
    } else if (webOpts.forceWeb) {
      reason = '--force-web 指定强制重建';
    } else {
      reason = webDistOutdated();
    }
    if (reason) {
      say(`[cli] ${reason}，先自动执行 build web（--no-web 可跳过、直接用现状产物）…`);
      const r = await buildWeb(quiet);
      if (!r.ok) return r.note;
    } else {
      // 口径对账：app 内 `npm run export` 默认写 app/dist，是与 cli build web
      // （写 dist/web）并存的另一条导出路径；桌面/部署只消费 dist/web，二者
      // 不互通——app/dist 更新时提示，防止把旧 dist/web 当最新产物出包
      const appDistIndex = path.join(APP_DIR, 'dist', 'index.html');
      try {
        if (fs.statSync(appDistIndex).mtimeMs - fs.statSync(webIndex).mtimeMs > 1000) {
          say('[cli] 提示：app/dist（app 内 npm run export 输出）比 dist/web 新——出包/部署统一以 dist/web 为准，本 CLI 只认它');
        }
      } catch { /* app/dist 不存在则无事 */ }
    }
  }
  if (!fs.existsSync(path.join(DESKTOP_DIR, 'package.json'))) {
    return `desktop 端尚未就绪（${DESKTOP_DIR} 缺 package.json，由并行工程师提供）`;
  }
  if (!fs.existsSync(path.join(DESKTOP_DIR, 'node_modules'))) {
    say('[cli] desktop/node_modules 缺失，先在 desktop 下执行 npm install …');
    const code = await runProcess({
      label: 'desktop-install', cmd: NPM, args: ['install'], cwd: DESKTOP_DIR, quiet,
    }).promise;
    if (code !== 0) return 'desktop npm install 失败';
  }
  return null;
}

/** 在 electron-builder 输出目录里找 .app 包（macOS 结构：mac-arm64/月幕.app
 *  等——目录名随 arch 而变，只搜两层深度足够） */
function findAppBundleIn(dir) {
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (!fs.statSync(p).isDirectory()) continue;
      if (name.endsWith('.app')) return p;
      for (const n2 of fs.readdirSync(p)) {
        if (n2.endsWith('.app')) return path.join(p, n2);
      }
    }
  } catch { /* 枚举失败按未找到处理 */ }
  return null;
}

/**
 * build win / macos：electron-builder 打包桌面端。
 * @param {'win'|'macos'} target 输出目录与校验扩展名随之不同
 * @param {boolean} quiet
 * @param {{ noWeb?: boolean, forceWeb?: boolean, noVerify?: boolean }} [deskOpts]
 *   noWeb：跳过 web 产物检测（用现状）；forceWeb：强制重建 web；
 *   noVerify：跳过打包态自检（macos 产物验证步骤）
 */
async function buildDesktop(target, quiet, deskOpts = {}) {
  const isWin = target === 'win';
  const outDir = isWin ? path.join(DIST_DIR, 'win') : path.join(DIST_DIR, 'macos');
  say(`[cli] 打包${isWin ? ' Windows 安装包' : ' macOS 安装包'} → ${outDir} …`);

  const problem = await prepareDesktopBuild(quiet, deskOpts);
  if (problem) {
    say(`[cli] build ${target} 前置准备失败：${problem}`);
    return { ok: false, note: problem };
  }

  // —— 历史孤儿暂存目录尽力清理：早期把 electron-builder 输出直接指向
  //    dist/<target> 时，其解压暂存目录（win-unpacked.tmp 等）可能被宿主
  //    IDE 的文件索引器持柄锁死在工作区内删不掉；清不掉只提示、不阻断 ——
  const staleTmp = path.join(outDir, isWin ? 'win-unpacked.tmp' : 'mac.tmp');
  try {
    fs.rmSync(staleTmp, { recursive: true, force: true });
  } catch {
    say(`[cli] 提示：${staleTmp} 暂无法删除（多为宿主索引器持锁的孤儿目录，待其释放后自动清掉），不影响构建`);
  }

  // —— electron-builder 输出目录用命令行覆盖（electron-builder.js 中
  //    不写 directories.output，契约约定），但覆盖值不直接指向 dist/<target>，
  //    而是指向系统临时目录下
  //    的本次构建暂存目录：electron-builder 解压 Electron 运行时先写
  //    <输出>/win-unpacked.tmp 再整体改名，这类对目录内文件的删除/改名操作
  //    一旦撞上宿主 IDE 文件索引器对新解压 .asar 的持柄（实测 ZCode 宿主即
  //    如此：rename 报 EPERM、unlink 报 EBUSY，且句柄长期不释放），构建即
  //    失败。暂存目录在工作区之外、索引器不可见，构建全程免疫；成功后仅把
  //    安装包等普通文件移入 dist/<target>（契约产物目录），win-unpacked 等
  //    中间目录随暂存目录一并清理 ——
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), `moontent-build-${target}-`));
  say(`[cli] 构建暂存目录（工作区外，成功后仅安装包入 ${outDir}）：${stagingDir}`);
  const args = isWin
    ? ['electron-builder', '--win', 'nsis', 'portable', `--config.directories.output=${stagingDir}`]
    : ['electron-builder', '--mac', 'dmg', `--config.directories.output=${stagingDir}`];
  try {
    const code = await runProcess({
      label: `build:${target}`, cmd: NPX, args, cwd: DESKTOP_DIR, quiet,
    }).promise;
    if (code !== 0) return { ok: false, note: `electron-builder 退出码 ${code}` };

    // —— 打包态自检（仅 macos，--no-verify 跳过）：对暂存目录里的 .app 直接
    //    跑 --selftest——此时 app.isPackaged=true，main.js resolvePaths 走
    //    resources 装配，断言打在「安装包内的 server（含 node_modules）+ web
    //    产物」上。仓库态 selftest（npm --prefix desktop run selftest）走仓库
    //    回落路径，覆盖不到这条链路——安装包缺 node_modules 的历史事故正是
    //    这层缺失放过去的。selftest 自带 30s 看门狗与单实例锁隔离，外层再
    //    兜 60s 强杀；失败则产物不入库（暂存目录随 finally 清理）。
    //    win 产物（.exe）无法在本机运行，跳过并提示。 ——
    if (!isWin && !deskOpts.noVerify) {
      const bundle = findAppBundleIn(stagingDir);
      if (!bundle) {
        return { ok: false, note: `暂存目录 ${stagingDir} 下未找到 .app，无法执行打包态自检` };
      }
      const bin = path.join(bundle, 'Contents', 'MacOS', '月幕');
      say(`[cli] 打包态自检（验证安装包内 server/web 装配）：${bin} --selftest …`);
      const { child, promise } = runProcess({
        label: 'selftest', cmd: bin, args: ['--selftest'], cwd: DESKTOP_DIR, quiet,
      });
      const killer = setTimeout(() => {
        say('[cli] 自检超时（60s），强制终止');
        try { if (child) child.kill('SIGKILL'); } catch { /* 已退出 */ }
      }, 60000);
      const vCode = await promise;
      clearTimeout(killer);
      if (vCode !== 0) {
        return { ok: false, note: `打包态自检失败（退出码 ${vCode}），产物未入库` };
      }
    } else if (isWin) {
      say('[cli] 提示：Windows 产物未做打包态自检（.exe 无法在本机运行）；在 Windows 上构建后请手动执行「月幕.exe --selftest」验证装配');
    }

    // —— 暂存根下的普通文件（安装包 .exe/.dmg、blockmap、配置快照等）移入
    //    产物目录；win-unpacked / mac 等目录性中间产物不随迁（契约只认安装包）。
    //    旧同名产物先清再改名单移入；改名受限（跨盘等）回落复制覆盖 ——
    fs.mkdirSync(outDir, { recursive: true });
    const moveFails = [];
    for (const name of fs.readdirSync(stagingDir)) {
      const from = path.join(stagingDir, name);
      if (!fs.statSync(from).isFile()) continue;
      const to = path.join(outDir, name);
      try {
        fs.rmSync(to, { force: true });
        fs.renameSync(from, to);
      } catch {
        try {
          fs.copyFileSync(from, to);
        } catch (err2) {
          moveFails.push(`${name}（${(err2 && err2.message) || err2}）`);
        }
      }
    }
    if (moveFails.length) {
      say(`[cli] 警告：以下产物移入 ${outDir} 失败：${moveFails.join('、')}`);
    }
  } finally {
    // —— 暂存目录清理：工作区外不受索引器持锁，正常必成；失败仅告警 ——
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch (err) {
      say(`[cli] 警告：暂存目录清理失败（可稍后手动删除）：${stagingDir}（${(err && err.message) || err}）`);
    }
  }

  // 结束校验：win 要求 dist/win 下有 .exe；macos 要求有 .dmg
  const ext = isWin ? '.exe' : '.dmg';
  const found = findFilesByExt(outDir, ext);
  if (!found.length) {
    return { ok: false, note: `${outDir} 下未找到任何 ${ext} 文件` };
  }
  say(`[cli] build ${target} 成功：${outDir} 下共 ${found.length} 个 ${ext}（示例：${path.join(outDir, found[0])}）`);
  // 内嵌 web 产物代际留痕：出包用的是哪一代前端，事后可追溯
  try {
    const webMtime = fs.statSync(path.join(DIST_DIR, 'web', 'index.html')).mtime;
    say(`[cli] 内嵌 web 产物代际：${webMtime.toLocaleString('zh-CN')}${deskOpts.noWeb ? '（--no-web：未做新鲜度检查）' : '（已确保不旧于 app 源码）'}`);
  } catch { /* web 产物缺失时省略（前置步骤已兜） */ }
  return { ok: true, note: `${outDir}（${found.length} 个 ${ext}）` };
}

// ============================================================================
// iOS 真机构建辅助（仅 darwin 使用；链路事实见文件头注释第 4 条）
// ============================================================================

/** 定位 pod 可执行文件：POD_BIN 环境变量 → PATH 上的 pod → ~/bin/pod
 *  （本机系统 Ruby 2.6 过老装不了新版 CocoaPods 时的 portable-ruby 包装方案）；
 *  找不到返回 null（调用方给出中文指引）。 */
function findPodBin() {
  const candidates = [];
  if (process.env.POD_BIN) candidates.push(process.env.POD_BIN);
  candidates.push('pod', path.join(os.homedir(), 'bin', 'pod'));
  for (const cand of candidates) {
    if (cand !== 'pod' && !fs.existsSync(cand)) continue;
    try {
      if (spawnSync(cand, ['--version']).status === 0) return cand;
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

/** 探测签名团队：IOS_TEAM_ID 环境变量优先；否则解析 Xcode 已登录账号
 *  （IDEProvisioningTeamByIdentifier，优先 teamType=Individual 个人团队，
 *  避免误选公司团队）。探测不到返回 null。 */
function detectIosTeamId() {
  if (process.env.IOS_TEAM_ID) {
    return { id: process.env.IOS_TEAM_ID, name: '（IOS_TEAM_ID 指定）' };
  }
  const out = spawnSync('defaults',
    ['read', 'com.apple.dt.Xcode', 'IDEProvisioningTeamByIdentifier'], { encoding: 'utf8' });
  if (out.status !== 0 || !out.stdout) return null;
  const teams = [...out.stdout.matchAll(/teamID\s*=\s*"?([A-Z0-9]+)"?;[\s\S]{0,200}?teamType\s*=\s*(\w+)/g)]
    .map((m) => ({ id: m[1], type: m[2] }));
  if (!teams.length) return null;
  const pick = teams.find((t) => t.type === 'Individual') || teams[0];
  const tail = out.stdout.slice(Math.max(0, out.stdout.indexOf(pick.id)));
  const nameM = tail.match(/teamName\s*=\s*(?:"([^"]+)"|([^;\n]+))/);
  return {
    id: pick.id,
    name: `${nameM ? (nameM[1] || nameM[2]).trim() : '未知名称'}（${pick.type}，Xcode 账号自动探测，IOS_TEAM_ID 可覆盖）`,
  };
}

/** 已配对的 iOS 真机列表（devicectl JSON）。
 *  可用判据：pairingState=paired 即候选（tunnelState/transportType 会在
 *  wired / localNetwork / connected 间漂移：隧道断开的有线设备会显示
 *  localNetwork，且 install/launch 时 devicectl 会按需自动建连，本机实测
 *  可行；偏好排序交给 pickIosDevice）。 */
function listConnectedIosDevices() {
  const tmp = path.join(os.tmpdir(), `moontent-devices-${process.pid}.json`);
  try {
    const r = spawnSync('xcrun',
      ['devicectl', 'list', 'devices', '--json-output', tmp], { encoding: 'utf8' });
    if (r.status !== 0) return [];
    const devices = ((JSON.parse(fs.readFileSync(tmp, 'utf8')).result || {}).devices) || [];
    return devices
      .filter((d) => (d.connectionProperties || {}).pairingState === 'paired')
      .map((d) => ({
        id: d.identifier,
        name: (d.deviceProperties || {}).name || d.identifier,
        wired: (d.connectionProperties || {}).transportType === 'wired',
        tunneled: (d.connectionProperties || {}).tunnelState === 'connected',
      }));
  } catch {
    return [];
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 尽力而为 */ }
  }
}

/** 选目标设备：IOS_DEVICE（id 或名称）精确匹配 → 隧道已连 > USB 有线 > 其余 */
function pickIosDevice(devices) {
  if (!devices.length) return null;
  const want = process.env.IOS_DEVICE;
  if (want) {
    const hit = devices.find((d) => d.id === want || d.name === want);
    if (hit) return hit;
    say(`[cli] 警告：IOS_DEVICE=${want} 未匹配到已连接设备，改用自动选择`);
  }
  return devices.find((d) => d.tunneled) || devices.find((d) => d.wired) || devices[0];
}

/** 读 .app 的 bundleId（plutil 为 macOS 自带）；失败返回 null */
function readAppBundleId(appPath) {
  const r = spawnSync('plutil',
    ['-extract', 'CFBundleIdentifier', 'raw', path.join(appPath, 'Info.plist')],
    { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** ios/ 下找 .xcworkspace（CocoaPods 工作区；scheme 名与工作区同名，Expo 模板如此） */
function findIosWorkspace(iosDir) {
  if (!fs.existsSync(iosDir)) return null;
  const hit = fs.readdirSync(iosDir).find((n) => n.endsWith('.xcworkspace'));
  return hit ? path.join(iosDir, hit) : null;
}

/** ios/build 下指定 configuration 的 .app 产物路径（不存在返回 null） */
function findIosApp(iosDir, configuration) {
  const productsDir = path.join(iosDir, 'build', 'Build', 'Products', `${configuration}-iphoneos`);
  try {
    const hit = fs.readdirSync(productsDir).find((n) => n.endsWith('.app'));
    return hit ? path.join(productsDir, hit) : null;
  } catch {
    return null;
  }
}

/** 最近一次构建产物的 bundleId（run ios 拉起已装包用；解析不到返回 null） */
function latestIosBundleId(configuration = 'Debug') {
  const app = findIosApp(path.join(APP_DIR, 'ios'), configuration);
  return app ? readAppBundleId(app) : null;
}

/** devicectl 拉起手机上的 App；envDict 非空时经 -e 注入环境变量（如 RCT_METRO_HOST） */
async function devicectlLaunch(deviceId, bundleId, envDict) {
  if (!bundleId) return;
  const args = ['devicectl', 'device', 'process', 'launch', '--device', deviceId];
  if (envDict) args.push('-e', JSON.stringify(envDict));
  args.push(bundleId);
  await runProcess({
    label: 'ios-launch', cmd: 'xcrun', args, cwd: APP_DIR, quiet: true, tailLines: 20,
  }).promise;
}

/** 读部署服务器地址（deploy.config.json + DEPLOY_HOST / DEPLOY_APP_PORT 覆盖；
 *  只取地址不要求密码，无配置返回 null —— release 演示包的默认 API 指向它） */
function readDeployEndpoint() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(DEPLOY_CONFIG, 'utf8'));
  } catch {
    /* 无配置则回落 */
  }
  const host = process.env.DEPLOY_HOST || cfg.host;
  const port = Number(process.env.DEPLOY_APP_PORT || cfg.appPort || 3001);
  return host ? `http://${host}:${port}` : null;
}

/**
 * build ios（仅 darwin）：prebuild（已有 ios/ 且不落后于 app 配置则跳过）→
 * pod install（Pods 与 Podfile 同步则跳过）→ xcodebuild
 * （自动签名）→ devicectl 安装到已连接真机 → 拉起（debug 连 Metro / release 直接开）。
 * @param {'release'|'debug'} variant release（默认）：JS 内嵌进 .app，脱离
 *   Metro / 局域网独立运行，API 默认内联为 deploy.config.json 的部署服务器
 *   （--api 覆盖），适合外出演示；debug：JS 由 Metro 提供，需配合
 *   node cli.js run ios，API 默认指向本机局域网后端。两变体同 bundleId
 *   com.moontent.app（安装互相覆盖）。
 * @param {string|null} apiBase 显式指定 EXPO_PUBLIC_API_BASE（Metro 构建期内联）
 */
async function buildIos(quiet, fresh, variant = 'release', apiBase = null) {
  const iosDir = path.join(APP_DIR, 'ios');

  // 1) 原生工程：缺失 / --fresh / 落后于 app 配置（mtime 实测，见文件头第 6 条）
  //    时 prebuild（--no-install：pod 由下一步统一处理）。存在性判据用 Podfile
  //    而非 .xcworkspace —— 后者要到 pod install 才有，拿它当判据会在「工程已
  //    生成但还没装 pod」时反复触发 prebuild。
  const hasIosProject = fs.existsSync(path.join(iosDir, 'Podfile'));
  const iosStale = hasIosProject && nativeProjectStale([path.join(iosDir, 'Podfile')]);
  if (hasIosProject && !fresh && !iosStale) {
    say('[cli] ios/ 原生工程已存在且不落后于 app 配置，跳过 expo prebuild（提速；--fresh 可强制重生成）');
  } else {
    if (iosStale) {
      say('[cli] app 配置/依赖晚于 ios/ 原生工程，自动补跑 expo prebuild 对齐'
        + '（否则本包沿用过期原生配置，如 ATS 明文放行，联网请求会被系统拦成 fetch failed）…');
    }
    say(`[cli] 执行 npx expo prebuild -p ios --no-install（目录 ${APP_DIR}）…`);
    const pre = await runProcess({
      label: 'build:ios-prebuild',
      cmd: NPX, args: ['expo', 'prebuild', '-p', 'ios', '--no-install'], cwd: APP_DIR, quiet,
    }).promise;
    if (pre !== 0) return { ok: false, note: 'expo prebuild -p ios 失败' };
  }
  // 注意：--no-install 下 prebuild 只产 .xcodeproj（首次生成、或被 expo 判定
  // 「malformed」清空重建时都没有 .xcworkspace），.xcworkspace 由下一步的
  // pod install 生成，故工作区定位只能放在 pod install 之后（曾因顺序反了而在
  // prebuild 成功后静默返回失败）。

  // 2) CocoaPods 依赖：pod 未必在 PATH（见 findPodBin）。需 pod install 的情形
  //    有二：Pods/ 缺失（含刚 prebuild 完的全新工程：连 .xcworkspace 都还没有）；
  //    或 Podfile / Podfile.properties.json 新于 Podfile.lock —— prebuild 刚重
  //    写过 Podfile（哪怕内容仅一行环境变量），旧 Pods 即不再与之同步，
  //    xcodebuild 的 [CP] Check Pods Manifest.lock 阶段会直接报 sandbox 不一致
  //    而构建失败，故这里一并补齐。
  let podReason = null;
  if (!fs.existsSync(path.join(iosDir, 'Pods'))) {
    podReason = 'Pods/ 缺失';
  } else {
    try {
      const lockAt = fs.statSync(path.join(iosDir, 'Podfile.lock')).mtimeMs;
      const newer = ['Podfile', 'Podfile.properties.json'].filter((n) => {
        try {
          return fs.statSync(path.join(iosDir, n)).mtimeMs > lockAt;
        } catch {
          return true; // 文件缺失：无法确认同步，宁可重装
        }
      });
      if (newer.length) podReason = `${newer.join(' / ')} 晚于 Podfile.lock`;
    } catch {
      podReason = 'Podfile.lock 缺失';
    }
  }
  if (podReason) {
    const pod = findPodBin();
    if (!pod) {
      say('[cli] 错误：未找到可用的 CocoaPods（iOS 原生依赖必需）。任选其一：');
      say('  - brew install cocoapods（或用户目录免 sudo 安装 Homebrew 后再装）；');
      say('  - 系统 Ruby>=3.0：gem install cocoapods --user-install；');
      say('  - Ruby 过老：用 portable-ruby 装 gem 后把 pod 包装脚本放 ~/bin/pod；');
      say('  - 或用 POD_BIN 环境变量直接指定 pod 可执行文件路径。');
      return { ok: false, note: '缺少 CocoaPods' };
    }
    say(`[cli] 执行 pod install（${pod}；原因：${podReason}）…`);
    // cwd 进 ios/ 执行（`cd ios && pod install` 的规范形态）：本机 CocoaPods
    // 1.17 只认 `--project-directory=<dir>` 的等号形式，空格分隔会报
    // 「Unknown option: --project-directory」（实测），改目录最省心。
    const code = await runProcess({
      label: 'build:ios-pod', cmd: pod, args: ['install'],
      cwd: path.join(APP_DIR, 'ios'), quiet,
    }).promise;
    if (code !== 0) return { ok: false, note: 'pod install 失败' };
  }

  // 2.5) pod install 之后再定位工作区（.xcworkspace 由它生成；见上面注释）
  const workspace = findIosWorkspace(iosDir);
  if (!workspace) {
    say(`[cli] 错误：ios/ 下未找到 .xcworkspace（pod install 未完成？）。可加 --fresh 重跑，或手动执行 pod install --project-directory ios。`);
    return { ok: false, note: 'ios/ 下未找到 .xcworkspace' };
  }
  const scheme = path.basename(workspace, '.xcworkspace');

  // 3) 签名团队：IOS_TEAM_ID > Xcode 已登录账号自动探测（优先个人团队）
  const team = detectIosTeamId();
  if (!team) {
    say('[cli] 错误：未找到可用的开发者团队。请先在 Xcode（Settings → Accounts）登录 Apple ID，');
    say('  或用环境变量 IOS_TEAM_ID=<团队ID> 指定后重试。');
    return { ok: false, note: '未找到签名团队' };
  }
  say(`[cli] 签名团队：${team.id} ${team.name}`);

  // 4) API 地址决策（EXPO_PUBLIC_API_BASE 于打包期内联进 JS，见文件头注释）
  const lanIp = getLanIp();
  let effectiveApi = apiBase;
  if (!effectiveApi) {
    if (variant === 'release') {
      effectiveApi = readDeployEndpoint();
      if (effectiveApi) {
        say(`[cli] release 变体 API 内联为部署服务器：${effectiveApi}（--api 可覆盖）`);
      } else if (lanIp) {
        effectiveApi = `http://${lanIp}:${BACKEND_PORT}`;
        say(`[cli] 警告：未读到 deploy.config.json，release API 回落本机局域网 ${effectiveApi}（离开局域网不可用，建议 --api 指定公网地址）`);
      }
    } else if (lanIp) {
      effectiveApi = `http://${lanIp}:${BACKEND_PORT}`;
    }
  }

  // 5) xcodebuild（generic 目标编译，不强依赖此刻是否有设备连接；产物在 ios/build）
  const configuration = variant === 'debug' ? 'Debug' : 'Release';
  say(`[cli] 执行 xcodebuild（${configuration}，自动签名，首次含证书/描述文件创建会稍慢）…`);
  const xc = await runProcess({
    label: `build:ios-${variant}`,
    cmd: 'xcodebuild',
    args: [
      '-workspace', path.relative(APP_DIR, workspace),
      '-scheme', scheme,
      '-configuration', configuration,
      '-destination', 'generic/platform=iOS',
      '-derivedDataPath', 'ios/build',
      '-allowProvisioningUpdates',
      '-allowProvisioningDeviceRegistration',
      `DEVELOPMENT_TEAM=${team.id}`,
      'CODE_SIGN_STYLE=Automatic',
    ],
    cwd: APP_DIR,
    envExtra: effectiveApi ? { EXPO_PUBLIC_API_BASE: effectiveApi } : {},
    quiet,
  }).promise;
  if (xc !== 0) {
    say('[cli] xcodebuild 失败。常见错误对照（见上方构建日志）：');
    say('  - 「PLA Update available」：到 developer.apple.com 同意最新许可协议后重试；');
    say('  - 「Revoke certificate」：Xcode Settings → Accounts → Manage Certificates → ➕ Apple Development → Revoke；');
    say('  - 「iOS xx is not installed」：先执行 xcodebuild -downloadPlatform iOS 安装平台组件（数 GB）；');
    say('  - 手机系统为 Beta 时 Xcode GUI 可能弹「安装更新才能连接」，命令行链路不受影响。');
    return { ok: false, note: `xcodebuild 退出码 ${xc}` };
  }

  // 6) 定位 .app 产物并安装到真机
  const appPath = findIosApp(iosDir, configuration);
  if (!appPath) return { ok: false, note: `未在 ios/build/Build/Products/${configuration}-iphoneos 找到 .app 产物` };
  const bundleId = readAppBundleId(appPath);
  say(`[cli] build ios（${variant}）成功：${appPath}`);

  const device = pickIosDevice(listConnectedIosDevices());
  if (!device) {
    say(`[cli] 未检测到已连接的 iPhone（devicectl），跳过安装；产物保留在 ${appPath}`);
    return { ok: true, note: `${appPath}（未连接设备，未安装）` };
  }
  say(`[cli] 安装到真机：${device.name}（${device.id}）…`);
  const inst = await runProcess({
    label: 'ios-install',
    cmd: 'xcrun',
    args: ['devicectl', 'device', 'install', 'app', '--device', device.id, appPath],
    cwd: APP_DIR, quiet: true, tailLines: 30,
  }).promise;
  if (inst !== 0) return { ok: false, note: 'devicectl 安装失败' };

  // 7) 拉起：debug 且 Metro 已在跑 → 带环境拉起连 Metro；否则直接拉起
  if (variant === 'debug') {
    if (lanIp && (await probePort(EXPO_WEB_PORT, lanIp))) {
      await devicectlLaunch(device.id, bundleId, {
        RCT_METRO_HOST: `${lanIp}:${EXPO_WEB_PORT}`,
        EXPO_PACKAGER_PROXY_URL: `http://${lanIp}:${EXPO_WEB_PORT}`,
      });
      say(`[cli] debug 包已拉起并连接 Metro（http://${lanIp}:${EXPO_WEB_PORT}）；调试：Metro 终端按 j`);
    } else {
      say('[cli] debug 包已安装，但 Metro 未运行——执行 node cli.js run ios 启动后再打开 App');
    }
  } else {
    await devicectlLaunch(device.id, bundleId, null);
    say(`[cli] release 演示包已安装并启动（JS 内嵌独立运行，API：${effectiveApi || 'App 内默认'}）`);
  }
  return { ok: true, note: `${appPath} → 已安装到 ${device.name}` };
}

/**
 * build <target> 主入口；build all 逐项执行、单项失败不中断、最后汇总表。
 * @returns {Promise<number>} 进程退出码
 */
async function cmdBuild(target, quiet, fresh, variant, arm64, apiBase, deskOpts = {}) {
  installExitHandlers();

  if (target !== 'all') {
    const result = await runSingleBuild(target, quiet, fresh, variant, arm64, apiBase, deskOpts);
    if (result && typeof result.code === 'number') return result.code; // android 环境缺失固定退出码 2
    return result && result.ok ? 0 : 1;
  }

  // —— build all：按本机受支持目标顺序执行 ——
  const targets = BUILD_ALL_ORDER.filter((t) => isSupported(BUILD_TARGETS, t));
  say(`[cli] build all：本机受支持目标为 ${targets.join('、')}，开始依次执行…`);
  const rows = [];
  for (const t of targets) {
    say('');
    say(`[cli] ===== build all → ${t} =====`);
    const r = await runSingleBuild(t, quiet, undefined, undefined, undefined, undefined, deskOpts);
    rows.push({ target: t, ok: Boolean(r && r.ok), note: r ? r.note : '内部错误' });
  }

  // —— 汇总表 ——
  say('');
  say('================ build all 汇总 ================');
  for (const row of rows) {
    say(`  ${row.target.padEnd(8)} ${row.ok ? '成功' : '失败'}    ${row.note}`);
  }
  const failed = rows.filter((r) => !r.ok).length;
  say(`================================================`);
  say(`[cli] 共 ${rows.length} 项：成功 ${rows.length - failed}，失败 ${failed}`);
  return failed ? 1 : 0;
}

/** 单个 build 目标的分发（build all 与单目标命令共用）；fresh/variant/arm64 透传给 android，
 *  fresh/variant/apiBase 透传给 ios，deskOpts（--no-web/--force-web/--no-verify）透传给 win/macos */
async function runSingleBuild(target, quiet, fresh, variant, arm64, apiBase, deskOpts = {}) {
  switch (target) {
    case 'web': return buildWeb(quiet);
    case 'android': return buildAndroid(quiet, fresh, variant, arm64);
    case 'ios': return buildIos(quiet, fresh, variant, apiBase);
    case 'win': return buildDesktop('win', quiet, deskOpts);
    case 'macos': return buildDesktop('macos', quiet, deskOpts);
    default: return { ok: false, note: `未知打包目标：${target}` };
  }
}

// ============================================================================
// deploy 子命令（server / web 发布到远程服务器）
// ----------------------------------------------------------------------------
// 免交互密码沿用 NextWeb deploy/deploy.sh 已验证的 SSH_ASKPASS 方案：
// 写一次性 askpass 脚本 + SSH_ASKPASS_REQUIRE=force（OpenSSH >= 8.4），
// Windows 下优先 Git 自带的 ssh/scp（10.x；系统自带 8.1 不支持 force）。
// 上传一律用「cwd + 相对文件名 + scp」：本地路径出现盘符冒号（C:\…）会被
// scp 当成远程主机名，相对路径天然规避。
// ============================================================================

/**
 * 读取部署配置：deploy.config.json + 环境变量覆盖（DEPLOY_HOST /
 * DEPLOY_PORT / DEPLOY_USER / DEPLOY_PASSWORD / DEPLOY_REMOTE_DIR /
 * DEPLOY_APP_NAME / DEPLOY_APP_PORT / DEPLOY_NODE_VER，环境变量优先）。
 * @returns {{host:string,port:number,user:string,password:string,
 *   remoteDir:string,appName:string,appPort:number,nodeVer:string}}
 * @throws 配置缺失/非法时抛出带中文提示的 Error
 */
function loadDeployConfig() {
  let fileCfg = {};
  if (fs.existsSync(DEPLOY_CONFIG)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(DEPLOY_CONFIG, 'utf8'));
    } catch (err) {
      throw new Error(`[部署] 配置解析失败：${DEPLOY_CONFIG}（${err.message}）`);
    }
  }
  const cfg = {
    host: process.env.DEPLOY_HOST || fileCfg.host || '',
    port: Number(process.env.DEPLOY_PORT || fileCfg.port || 22),
    user: process.env.DEPLOY_USER || fileCfg.user || 'root',
    password: process.env.DEPLOY_PASSWORD || fileCfg.password || '',
    remoteDir: process.env.DEPLOY_REMOTE_DIR || fileCfg.remoteDir || '/opt/moontent',
    appName: process.env.DEPLOY_APP_NAME || fileCfg.appName || 'moontent',
    appPort: Number(process.env.DEPLOY_APP_PORT || fileCfg.appPort || 3001),
    nodeVer: process.env.DEPLOY_NODE_VER || fileCfg.nodeVer || 'v22.14.0',
  };
  if (!cfg.host || !cfg.password) {
    throw new Error('[部署] 错误：缺少服务器连接信息。请创建 MoontentRN/deploy.config.json'
      + '（参照 deploy.config.example.json，含 host/user/password）或设置环境变量'
      + ' DEPLOY_HOST / DEPLOY_USER / DEPLOY_PASSWORD。');
  }
  return cfg;
}

/**
 * 定位 ssh / scp：优先 Git 自带（Windows 系统 OpenSSH 8.1 不支持
 * SSH_ASKPASS_REQUIRE=force，Git 的 9.x/10.x 均可），找不到回落 PATH
 * （macOS/Linux 系统 ssh 均为 9.x+ 直接可用）。可用 DEPLOY_SSH /
 * DEPLOY_SCP 显式指定。
 */
function findSshBins() {
  const pick = (envKey, name) => {
    if (process.env[envKey]) return process.env[envKey];
    if (IS_WIN) {
      for (const dir of ['C:\\Program Files\\Git\\usr\\bin', 'C:\\Program Files (x86)\\Git\\usr\\bin']) {
        const full = path.join(dir, `${name}.exe`);
        if (fs.existsSync(full)) return full;
      }
    }
    return name; // PATH 兜底
  };
  return { ssh: pick('DEPLOY_SSH', 'ssh'), scp: pick('DEPLOY_SCP', 'scp') };
}

/**
 * 建立 SSH 会话封装：写一次性 askpass 脚本（免交互密码），提供
 * sshRun / scpRun 两个执行入口与 dispose 清理；全部复用 runProcess
 * （输出加前缀透传 / quiet 静默、统一纳入子进程清理）。
 * @returns {{sshRun:Function, scpRun:Function, dispose:Function}}
 */
function createSshSession(cfg, bins, quiet) {
  const askpass = path.join(os.tmpdir(), `moontent-askpass-${process.pid}-${Date.now()}.sh`);
  fs.writeFileSync(askpass, `#!/bin/sh\necho '${cfg.password.replace(/'/g, "'\\\\''")}'\n`, 'utf8');
  // writeFileSync 默认 0644 无执行位，ssh exec askpass 会直接 EACCES
  // （报 ssh_askpass: exec(...): Permission denied），必须补执行位；
  // 脚本内含明文密码，仅给属主 0700。
  fs.chmodSync(askpass, 0o700);
  const envExtra = { SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0' };
  const baseOpts = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=25'];
  const dest = `${cfg.user}@${cfg.host}`;

  /**
   * 执行远端命令。script 非空时经 stdin 送入 `bash -s`（scriptArgs 为
   * 远端脚本的位置参数），remoteArgs 为一次性远端命令的字面参数。
   */
  const sshRun = (label, remoteArgs, script = null, scriptArgs = []) => {
    const args = [...baseOpts, '-p', String(cfg.port), dest, ...remoteArgs];
    if (script != null) args.push('bash', '-s', '--', ...scriptArgs);
    return runProcess({
      label, cmd: bins.ssh, args, cwd: ROOT, envExtra, quiet,
      // Windows 检出的脚本多为 CRLF（core.autocrlf=true），远端 bash 会把 \r
      // 当成 token 的一部分（set -euo pipefail 直接报「pipefail: invalid
      // option name」而部署中止）；送入前统一归一为 LF，与本地行尾无关
      stdinData: script == null ? null : script.replace(/\r\n?/g, '\n'),
    }).promise;
  };

  /** 上传单个文件（localFile 用相对 cwd 的文件名，规避盘符冒号问题） */
  const scpRun = (label, localFile, remotePath, cwd) => runProcess({
    label, cmd: bins.scp,
    args: [...baseOpts, '-P', String(cfg.port), localFile, `${dest}:${remotePath}`],
    cwd, envExtra, quiet,
  }).promise;

  const dispose = () => {
    try { fs.rmSync(askpass, { force: true }); } catch { /* 尽力而为 */ }
  };
  return { sshRun, scpRun, dispose };
}

/** SSH 连接/传输失败的中文排查提示 */
function sshFailHint(cfg) {
  say(`[部署] 失败：SSH 连接/传输未成功（${cfg.user}@${cfg.host}:${cfg.port}）。排查：`);
  say('  - 地址/密码是否正确（deploy.config.json 或 DEPLOY_* 环境变量）；');
  say(`  - 服务器重装过系统：先执行一次 ssh-keygen -R ${cfg.host} 再重试；`);
  say('  - 服务器 22 端口限流（如 ufw LIMIT）时，等约 1 分钟再重试。');
}

/**
 * deploy server：组装后端发布包（源码 + package*.json + 可选 .env /
 * .cms-sources.json，不含 node_modules——sharp 等平台二进制必须在服务
 * 器上安装）→ scp 上传 → 远端 npm ci + systemd 守护 + 健康检查（失败
 * 自动回滚，见 deploy/remote-server.sh）。
 */
async function deployServer(session, cfg, quiet) {
  const STAGE = path.join(ROOT, '.deploy-stage');
  const TAR_NAME = 'moontent-rn-server.tar.gz';
  const TAR_REMOTE = `/tmp/${TAR_NAME}`;

  say('[部署] 组装后端发布包（server 源码，不含 node_modules）…');
  fs.rmSync(STAGE, { recursive: true, force: true });
  const payload = path.join(STAGE, 'server-payload');
  fs.mkdirSync(payload, { recursive: true });
  fs.cpSync(path.join(SERVER_DIR, 'src'), path.join(payload, 'src'), { recursive: true });
  for (const name of ['package.json', 'package-lock.json', '.env', '.cms-sources.json', '.telegram-session.json']) {
    const from = path.join(SERVER_DIR, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(payload, name));
  }

  say('[部署] 压缩发布包 …');
  const tarCode = await runProcess({
    label: 'tar', cmd: 'tar', args: ['-czf', TAR_NAME, 'server-payload'], cwd: STAGE, quiet,
  }).promise;
  const tarLocal = path.join(STAGE, TAR_NAME);
  if (tarCode !== 0 || !fs.existsSync(tarLocal)) {
    say('[部署] 失败：后端发布包压缩失败');
    return 1;
  }
  say(`[部署] 发布包就绪：${(fs.statSync(tarLocal).size / 1024).toFixed(0)} KB`);

  say('[部署] 上传到服务器 …');
  if (await session.scpRun('scp', TAR_NAME, TAR_REMOTE, STAGE) !== 0) {
    sshFailHint(cfg);
    return 1;
  }

  say('[部署] 远端部署（首次会自动安装 Node 与生产依赖，稍候）…');
  const script = fs.readFileSync(path.join(DEPLOY_DIR, 'remote-server.sh'), 'utf8');
  const code = await session.sshRun('远端', [], script,
    [cfg.appName, String(cfg.appPort), cfg.remoteDir, TAR_REMOTE, cfg.nodeVer]);

  if (code === 0) {
    say('');
    say(`[部署] 全部完成 ✅  后端服务：http://${cfg.host}:${cfg.appPort}（API 前缀 /api/*）`);
    say(`[部署] 服务器管理：systemctl status|restart ${cfg.appName} ／ 日志：journalctl -u ${cfg.appName} -f`);
    say('[部署] web 站点另行发布：node cli.js deploy web');
  } else {
    say('[部署] 远端部署未成功（看上方 [远端] 日志）');
  }
  return code === 0 ? 0 : 1;
}

/**
 * deploy web：先构建 web 静态产物（总是重新 expo export，发布即最新）→
 * 打包上传到远端 web 目录 → 重启服务并探活（koa-static 在启动时挂载
 * SERVE_DIST，目录此前不存在时必须重启才生效），见 deploy/remote-web.sh。
 */
async function deployWeb(session, cfg, quiet) {
  say('[部署] 第 1/4 步：构建 web 静态产物（expo export）…');
  const built = await buildWeb(quiet);
  if (!built.ok) return 1;

  const STAGE = path.join(ROOT, '.deploy-stage');
  const TAR_NAME = 'moontent-rn-web.tar.gz';
  const TAR_REMOTE = `/tmp/${TAR_NAME}`;
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  say('[部署] 第 2/4 步：压缩 web 产物 …');
  const tarCode = await runProcess({
    label: 'tar', cmd: 'tar',
    args: ['-czf', path.join('..', '.deploy-stage', TAR_NAME), 'web'],
    cwd: DIST_DIR, quiet,
  }).promise;
  const tarLocal = path.join(STAGE, TAR_NAME);
  if (tarCode !== 0 || !fs.existsSync(tarLocal)) {
    say('[部署] 失败：web 产物压缩失败');
    return 1;
  }
  say(`[部署] 发布包就绪：${(fs.statSync(tarLocal).size / 1024 / 1024).toFixed(1)} MB`);

  say('[部署] 第 3/4 步：上传到服务器 …');
  if (await session.scpRun('scp', TAR_NAME, TAR_REMOTE, STAGE) !== 0) {
    sshFailHint(cfg);
    return 1;
  }

  say('[部署] 第 4/4 步：远端发布（解压 → 重启服务 → 探活）…');
  const script = fs.readFileSync(path.join(DEPLOY_DIR, 'remote-web.sh'), 'utf8');
  const code = await session.sshRun('远端', [], script,
    [cfg.appName, String(cfg.appPort), cfg.remoteDir, TAR_REMOTE]);

  if (code === 0) {
    say('');
    say(`[部署] 全部完成 ✅  web 站点：http://${cfg.host}:${cfg.appPort}/`);
    say('[部署] App 真机使用：「我的 → 设置 → 服务器地址」填上面的地址即可');
  } else {
    say('[部署] 远端发布未成功（看上方 [远端] 日志）');
  }
  return code === 0 ? 0 : 1;
}

/**
 * deploy <target> 主入口：加载配置 → 定位 ssh/scp → 连通性检查 → 分发。
 * @returns {Promise<number>} 进程退出码
 */
async function cmdDeploy(target, quiet) {
  installExitHandlers();

  let cfg;
  try {
    cfg = loadDeployConfig();
  } catch (err) {
    say(err.message);
    return 1;
  }
  const session = createSshSession(cfg, findSshBins(), quiet);
  try {
    const item = DEPLOY_TARGETS[target];
    say(`[部署] ${item.label} → ${cfg.user}@${cfg.host}:${cfg.port}（部署目录 ${cfg.remoteDir}，服务端口 ${cfg.appPort}）`);
    say('[部署] 连通性检查 …');
    if (await session.sshRun('ssh', ['echo', 'ok']) !== 0) {
      sshFailHint(cfg);
      return 1;
    }
    return target === 'server'
      ? await deployServer(session, cfg, quiet)
      : await deployWeb(session, cfg, quiet);
  } finally {
    session.dispose();
    fs.rmSync(path.join(ROOT, '.deploy-stage'), { recursive: true, force: true });
  }
}

// ============================================================================
// install 子命令（把已构建产物安装到本机连接的设备）
// ============================================================================

/** 定位 adb：ADB_BIN 环境变量 → ANDROID_HOME/ANDROID_SDK_ROOT 下的
 *  platform-tools → 平台默认 SDK 路径（macOS 为 ~/Library/Android/sdk，
 *  Android Studio 默认安装位；Windows 为 %LOCALAPPDATA%\Android\Sdk）→
 *  PATH 兜底。逐候选 spawnSync 探活（首候选可能拉起 adb 守护进程，属正常），
 *  找不到返回 null（调用方给中文指引）。 */
function findAdbBin() {
  const candidates = [];
  if (process.env.ADB_BIN) candidates.push(process.env.ADB_BIN);
  const sdkEnv = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (sdkEnv) candidates.push(path.join(sdkEnv, 'platform-tools', IS_WIN ? 'adb.exe' : 'adb'));
  if (IS_WIN && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
  } else if (IS_MAC) {
    candidates.push(path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'));
  }
  candidates.push('adb');
  for (const cand of candidates) {
    if (cand !== 'adb' && !fs.existsSync(cand)) continue;
    try {
      if (spawnSync(cand, ['version']).status === 0) return cand;
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

/** `adb devices` 输出解析：返回 [{id, state}]（state 为 device/unauthorized/
 *  offline 等；表头行与 daemon 提示行已滤除）。 */
function listAdbDevices(adb) {
  const r = spawnSync(adb, ['devices'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split(/\r?\n/)
    .slice(1)                              // 首行是表头 List of devices attached
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('*'))
    .map((line) => {
      const [id, state] = line.split(/\s+/);
      return { id, state: state || 'unknown' };
    })
    .filter((d) => d.id);
}

/** 选目标设备：ANDROID_DEVICE（序列号）精确匹配 → 第一台 state=device 的
 *  设备；匹配不到 ANDROID_DEVICE 时告警并回落自动选择。 */
function pickAndroidDevice(devices) {
  const usable = devices.filter((d) => d.state === 'device');
  const want = process.env.ANDROID_DEVICE;
  if (want) {
    const hit = usable.find((d) => d.id === want) || devices.find((d) => d.id === want);
    if (hit && hit.state === 'device') return hit;
    if (hit) {
      say(`[cli] 警告：ANDROID_DEVICE=${want} 匹配到的设备状态为 ${hit.state}，改用自动选择`);
    } else {
      say(`[cli] 警告：ANDROID_DEVICE=${want} 未匹配到已连接设备，改用自动选择`);
    }
  }
  return usable[0] || null;
}

/** 读 android applicationId（app/android/app/build.gradle 的 applicationId "…"；
 *  prebuild 未生成过原生工程时文件不存在，读不到返回 null，调用方回落
 *  已知包名 com.moontent.app）。 */
function readAndroidApplicationId() {
  const file = path.join(APP_DIR, 'android', 'app', 'build.gradle');
  try {
    const m = fs.readFileSync(file, 'utf8').match(/^\s*applicationId\s+["']([^"']+)["']/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** dist/android 下选 mtime 最新的 APK（release/debug 同存时取刚构建的），
 *  无 APK 返回 null。 */
function findNewestDistApk() {
  const dir = path.join(DIST_DIR, 'android');
  const list = findFilesByExt(dir, '.apk');
  if (!list.length) return null;
  const st = list
    .map((rel) => ({ full: path.join(dir, rel), mtime: fs.statSync(path.join(dir, rel)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return { apk: st[0].full, total: st.length };
}

/**
 * install android：定位 adb → 选 dist/android 最新 APK → 选设备（unauthorized
 * 时轮询等待手机确认授权）→ adb install -r（保留应用数据）→ monkey 拉起。
 * @param {boolean} quiet 静默透传子进程输出
 * @param {boolean} launch true=装完拉起 App（默认行为），false=--no-launch
 * @returns {Promise<number>} 进程退出码
 */
async function installAndroid(quiet, launch) {
  const adb = findAdbBin();
  if (!adb) {
    say('[cli] 错误：未找到可用的 adb。任选其一：');
    say('  - 安装 Android Studio（其 SDK 自带 platform-tools），或单独下载 platform-tools；');
    say('  - 设置 ANDROID_HOME 指向 SDK 目录（cli 会自动找其下 platform-tools/adb）；');
    say('  - 或用环境变量 ADB_BIN 直接指定 adb 可执行文件路径。');
    return 1;
  }

  const found = findNewestDistApk();
  if (!found) {
    say(`[cli] 错误：${path.join(DIST_DIR, 'android')} 下没有 APK，请先执行 node cli.js build android`);
    return 1;
  }
  if (found.total > 1) say(`[cli] dist/android 下有 ${found.total} 个 APK，选取最新的：${path.basename(found.apk)}`);

  // 设备选择；只剩 unauthorized（授权弹窗待确认）时轮询等待，最长约 24 秒
  let devices = listAdbDevices(adb);
  if (!devices.some((d) => d.state === 'device') && devices.some((d) => d.state === 'unauthorized')) {
    say('[cli] 设备待授权（unauthorized）：请在手机上确认「允许 USB 调试」弹窗（建议勾选一律允许）…');
    const deadline = Date.now() + 24_000;
    while (Date.now() < deadline) {
      await sleep(3000);
      devices = listAdbDevices(adb);
      if (devices.some((d) => d.state === 'device')) break;
    }
  }
  const device = pickAndroidDevice(devices);
  if (!device) {
    if (devices.length) {
      say(`[cli] 错误：设备均不可用（${devices.map((d) => `${d.id}=${d.state}`).join('、')}）。`);
      say('  - unauthorized：重插 USB 后在手机上重新确认授权弹窗；');
      say(`  - offline：重插 USB，或执行 ${adb} kill-server 后重试。`);
    } else {
      say('[cli] 错误：未检测到安卓设备。请用 USB 连接手机并开启「开发者选项 → USB 调试」，');
      say('  - 无线调试：手机上配对后执行 adb connect <ip:端口>；');
      say(`  - 多台设备时用 ANDROID_DEVICE=<序列号> 指定（序列号可用 ${adb} devices 查看）。`);
    }
    return 1;
  }
  say(`[cli] 目标设备：${device.id}，安装 ${path.basename(found.apk)}（install -r 保留应用数据）…`);

  const appId = readAndroidApplicationId() || 'com.moontent.app';
  const code = await runProcess({
    label: 'adb-install', cmd: adb,
    args: ['-s', device.id, 'install', '-r', found.apk],
    cwd: ROOT, quiet, tailLines: 30,
  }).promise;
  if (code !== 0) {
    say('[cli] 安装失败。常见错误对照（见上方 [adb-install] 日志）：');
    say(`  - INSTALL_FAILED_UPDATE_INCOMPATIBLE：与本机已装旧版签名不一致——先执行`);
    say(`    ${adb} -s ${device.id} uninstall ${appId} 卸载后重试（会清应用数据）；`);
    say('  - INSTALL_FAILED_VERSION_DOWNGRADE：设备上已是更高版本，先卸载或重新构建。');
    return 1;
  }
  say('[cli] 安装成功 ✅');
  if (!launch) {
    say('[cli] 已按 --no-launch 跳过拉起，请在手机上手动打开 App');
    return 0;
  }

  // monkey 带 LAUNCHER intent 拉起：无需解析入口 Activity（对 RN/Expo 工程够用）
  const mon = await runProcess({
    label: 'adb-launch', cmd: adb,
    args: ['-s', device.id, 'shell', 'monkey', '-p', appId,
      '-c', 'android.intent.category.LAUNCHER', '1'],
    cwd: ROOT, quiet: true, tailLines: 10,
  }).promise;
  say(mon === 0
    ? `[cli] 已拉起 App（${appId}）`
    : `[cli] 警告：拉起 ${appId} 失败（monkey 退出码 ${mon}），请在手机上手动打开`);
  return 0;
}

/**
 * install <target> 主入口。iOS 无此命令：装机拉起已内置于 build ios。
 * @returns {Promise<number>} 进程退出码
 */
async function cmdInstall(target, quiet, launch) {
  installExitHandlers();
  if (target === 'android') return installAndroid(quiet, launch);
  say(`[cli] 错误：install 暂不支持目标「${target}」。`);
  return 1;
}

// ============================================================================
// list / 帮助 / 交互菜单
// ============================================================================

const PLATFORM_NAME = IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : process.platform;

/** list：打印本机受支持的运行/打包目标清单（不出现本机不支持的目标） */
function cmdList() {
  say(`月幕 MoontentRN 多端启动器 —— 本机可用目标（${PLATFORM_NAME}）`);
  say('');
  say('运行（node cli.js run <目标>）：');
  for (const key of supportedRunTargets()) {
    say(`  node cli.js run ${key.padEnd(8)} ${RUN_TARGETS[key].label}`);
  }
  say('');
  say('打包（node cli.js build <目标> [--quiet] [--fresh]）：');
  for (const key of supportedBuildTargets()) {
    const item = BUILD_TARGETS[key];
    say(`  node cli.js build ${key.padEnd(8)} ${item.label}（${item.desc}）`);
  }
  say(`  node cli.js build ${'all'.padEnd(8)} ${BUILD_TARGETS.all.label}（${BUILD_TARGETS.all.desc}）`);
  say('');
  say('部署（node cli.js deploy <目标> [--quiet]，连接信息见 deploy.config.json）：');
  for (const key of supportedDeployTargets()) {
    const item = DEPLOY_TARGETS[key];
    say(`  node cli.js deploy ${key.padEnd(8)} ${item.label}（${item.desc}）`);
  }
  say('');
  say('安装（node cli.js install <目标> [--quiet] [--no-launch]）：');
  for (const key of supportedInstallTargets()) {
    const item = INSTALL_TARGETS[key];
    say(`  node cli.js install ${key.padEnd(8)} ${item.label}（${item.desc}）`);
  }
  say('');
  say('说明：--quiet 为静默打包（子进程输出仅缓存，结束时打印最后 200 行）；');
  say('      --fresh 仅 android/ios：无条件重跑 expo prebuild（app 配置/依赖晚于原生');
  say('      工程时本就会自动补跑，见 README「cli 打包提速」）；');
  say('      --debug/--release 仅 android/ios：选变体，默认 release。ios release 为独立');
  say('      演示包（JS 内嵌、API 指向部署服务器）、ios debug 需配合 run ios 的 Metro；');
  say('      --arm64 仅 android：只打 arm64-v8a 单架构，提速且包体更小；');
  say('      --api <url> 仅 ios：覆盖 release 包内联的后端 API 地址；');
  say('      --no-web 仅 win/macos：跳过 web 产物新鲜度检查，直接用 dist/web 现状；');
  say('      --force-web 仅 win/macos：无条件重建 web 产物；默认源码比产物新时自动重建；');
  say('      --no-verify 仅 win/macos：跳过打包态自检（默认对装配出的 .app 跑 --selftest，');
  say('      验证安装包内 server/web 完整后才入库）；');
  say('      --no-launch 仅 install android：装完不自动拉起 App；');
  say('      ios 环境变量：IOS_TEAM_ID 指定签名团队、IOS_DEVICE 按名称/id 选真机、');
  say('      POD_BIN 指定 pod 可执行文件；');
  say('      android 环境变量：ANDROID_DEVICE 按序列号选真机、ADB_BIN 指定 adb 路径');
  return 0;
}

/** 帮助：用法 + 本机受支持目标（与 list 的平台过滤规则一致） */
function printHelp() {
  say('月幕 MoontentRN 多端启动器（用法）');
  say('');
  say('  node cli.js list               查看本机受支持的运行/打包/部署目标');
  say('  node cli.js run <target>       运行到指定目标');
  say('  node cli.js build <target>     打包指定目标（--quiet 静默；android/ios 支持 --debug/--release，android 另有 --arm64，ios 另有 --api <url>）');
  say('  node cli.js deploy <target>    部署到服务器（可加 --quiet 静默）');
  say('  node cli.js install <target>   安装已构建产物到本机设备（install android → adb 装到真机；--no-launch 装完不拉起）');
  say('');
  say(`本机（${PLATFORM_NAME}）可用目标：`);
  say(`  run   ：${supportedRunTargets().join('、')}`);
  say(`  build ：${[...supportedBuildTargets(), 'all'].join('、')}`);
  say(`  deploy：${supportedDeployTargets().join('、')}`);
  say(`  install：${supportedInstallTargets().join('、')}`);
  say('');
  say('示例：node cli.js run web ／ node cli.js build android --arm64 --quiet ／ node cli.js install android ／ node cli.js build ios --debug ／ node cli.js deploy server');
}

/**
 * 交互菜单（仅在无参数且 stdout 为 TTY 时进入；非 TTY 一律打印帮助退出）。
 * 返回 {action, target, flags} 或 null（退出）；flags 为追加到命令行的参数，
 * 目前仅 build android 的变体/架构二级选择会给出非空值。
 */
async function interactiveMenu() {
  const runKeys = supportedRunTargets();
  const buildKeys = [...supportedBuildTargets(), 'all'];
  const deployKeys = supportedDeployTargets();
  const installKeys = supportedInstallTargets();
  const options = [
    ...runKeys.map((k) => ({ action: 'run', target: k, label: RUN_TARGETS[k].label })),
    ...buildKeys.map((k) => ({ action: 'build', target: k, label: BUILD_TARGETS[k].label })),
    ...deployKeys.map((k) => ({ action: 'deploy', target: k, label: DEPLOY_TARGETS[k].label })),
    ...installKeys.map((k) => ({ action: 'install', target: k, label: INSTALL_TARGETS[k].label })),
  ];
  const actionName = { run: '运行', build: '打包', deploy: '部署', install: '安装' };
  say(`月幕 MoontentRN 多端启动器（${PLATFORM_NAME}）—— 请选择操作：`);
  options.forEach((opt, i) => say(`  ${i + 1}) ${actionName[opt.action]}：${opt.label}`));
  say('  q) 退出');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await rl.question('请输入编号：')).trim();
      if (answer.toLowerCase() === 'q') return null;
      const idx = Number(answer) - 1;
      if (!(Number.isInteger(idx) && idx >= 0 && idx < options.length)) {
        say('输入无效，请重新选择。');
        continue;
      }
      const opt = options[idx];
      const flags = opt.action === 'build' && opt.target === 'android'
        ? await askAndroidBuildOptions(rl)
        : opt.action === 'build' && opt.target === 'ios'
          ? await askIosBuildOptions(rl)
          : [];
      return { action: opt.action, target: opt.target, flags };
    }
  } finally {
    rl.close();
  }
}

/** 交互菜单里 build android 的二级选择：变体（release/debug）与是否单架构 arm64 */
async function askAndroidBuildOptions(rl) {
  say('  —— Android 打包选项 ——');
  say('    1) release 标准发布包（内嵌 JS 可独立安装；最慢）');
  say('    2) release 仅 arm64（少打 3 套架构，更快更小；现代手机通用）');
  say('    3) debug 快速包（跳过 JS 打包最快；需配合 run android 的开发服务器）');
  while (true) {
    const answer = (await rl.question('请选择（回车=1）：')).trim();
    if (answer === '' || answer === '1') return [];
    if (answer === '2') return ['--arm64'];
    if (answer === '3') return ['--debug'];
    say('输入无效，请重新选择。');
  }
}

/** 交互菜单里 build ios 的二级选择：变体（release 演示包 / debug 开发包）与 release 的 API 地址 */
async function askIosBuildOptions(rl) {
  say('  —— iOS 打包选项 ——');
  say('    1) release 演示包（JS 内嵌独立运行，无需电脑/局域网；API 默认指向部署服务器）');
  say('    2) debug 开发包（配合 run ios 的 Metro 热更新调试；API 指向本机后端）');
  while (true) {
    const answer = (await rl.question('请选择（回车=1）：')).trim();
    if (answer === '' || answer === '1') {
      const api = (await rl.question('    API 地址（回车=deploy.config.json 部署服务器）：')).trim();
      return api ? ['--api', api] : [];
    }
    if (answer === '2') return ['--debug'];
    say('输入无效，请重新选择。');
  }
}

// ============================================================================
// 参数解析与入口
// ============================================================================

async function main() {
  const argv = process.argv.slice(2);

  // 无参数：stdout 非 TTY 只打印帮助退出码 1（不进交互）；TTY 进交互菜单
  if (argv.length === 0) {
    if (!process.stdout.isTTY) {
      printHelp();
      process.exit(1);
    }
    const choice = await interactiveMenu();
    if (!choice) {
      say('已退出。');
      process.exit(0);
    }
    argv.push(choice.action, choice.target, ...(choice.flags || []));
  }

  const command = argv[0];

  if (command === 'list') {
    process.exit(cmdList());
  }

  if (command === 'run' || command === 'build') {
    const map = command === 'run' ? RUN_TARGETS : BUILD_TARGETS;
    const target = argv[1];
    if (!target) {
      say(`[cli] 错误：${command} 缺少目标参数。`);
      printHelp();
      process.exit(1);
    }
    if (!(target in map)) {
      say(`[cli] 错误：未知目标「${target}」。`);
      printHelp();
      process.exit(1);
    }
    if (!isSupported(map, target)) {
      say(`[cli] 错误：目标「${target}」在本机（${PLATFORM_NAME}）不受支持。`);
      printHelp();
      process.exit(1);
    }

    if (command === 'run') {
      const code = await cmdRun(target);
      process.exit(code);
    }

    // build：解析 --quiet / --fresh / --debug / --release / --arm64 / --api <url>
    // / --no-web / --force-web / --no-verify（其余未知参数报错，避免拼错被静默
    // 忽略）；--fresh 对 android/ios 有意义：强制重跑 expo prebuild；
    // --debug/--release 选变体（默认 release，android/ios）；--arm64 只打
    // arm64-v8a 单架构（仅 android）；--api 覆盖 ios release 包内联的后端 API
    // 地址（仅 ios，需带值）；--no-web/--force-web/--no-verify 仅桌面打包
    // （win/macos）：跳过 web 产物新鲜度检查 / 强制重建 web / 跳过打包态自检
    const rest = argv.slice(2);
    const quiet = rest.includes('--quiet');
    const fresh = rest.includes('--fresh');
    const debugFlag = rest.includes('--debug');
    const releaseFlag = rest.includes('--release');
    const arm64Flag = rest.includes('--arm64');
    const noWebFlag = rest.includes('--no-web');
    const forceWebFlag = rest.includes('--force-web');
    const noVerifyFlag = rest.includes('--no-verify');
    const knownFlags = ['--quiet', '--fresh', '--debug', '--release', '--arm64', '--api',
      '--no-web', '--force-web', '--no-verify'];
    const apiIdx = rest.indexOf('--api');
    let apiBase = null;
    if (apiIdx !== -1) {
      apiBase = rest[apiIdx + 1];
      if (!apiBase || apiBase.startsWith('--')) {
        say('[cli] 错误：--api 需要跟一个地址值，如 --api http://192.168.1.5:3001');
        printHelp();
        process.exit(1);
      }
    }
    // 未知参数检测（--api 的值不算未知参数）
    const unknownFlags = rest.filter((a, i) => !knownFlags.includes(a) && !(i > 0 && rest[i - 1] === '--api'));
    if (unknownFlags.length) {
      say(`[cli] 错误：无法识别的参数：${unknownFlags.join('、')}`);
      printHelp();
      process.exit(1);
    }
    if (debugFlag && releaseFlag) {
      say('[cli] 错误：--debug 与 --release 不能同时指定。');
      printHelp();
      process.exit(1);
    }
    if (arm64Flag && target !== 'android') {
      say('[cli] 错误：--arm64 仅用于 android 目标。');
      printHelp();
      process.exit(1);
    }
    if ((debugFlag || releaseFlag) && target !== 'android' && target !== 'ios') {
      say('[cli] 错误：--debug / --release 仅用于 android / ios 目标。');
      printHelp();
      process.exit(1);
    }
    if (apiBase && target !== 'ios') {
      say('[cli] 错误：--api 仅用于 ios 目标。');
      printHelp();
      process.exit(1);
    }
    if ((noWebFlag || forceWebFlag || noVerifyFlag) && target !== 'win' && target !== 'macos' && target !== 'all') {
      say('[cli] 错误：--no-web / --force-web / --no-verify 仅用于桌面打包（win / macos）。');
      printHelp();
      process.exit(1);
    }
    if (noWebFlag && forceWebFlag) {
      say('[cli] 错误：--no-web 与 --force-web 不能同时指定。');
      printHelp();
      process.exit(1);
    }
    const variant = debugFlag ? 'debug' : 'release';
    const deskOpts = { noWeb: noWebFlag, forceWeb: forceWebFlag, noVerify: noVerifyFlag };
    const code = await cmdBuild(target, quiet, fresh, variant, arm64Flag, apiBase, deskOpts);
    process.exit(code);
  }

  // deploy：目标校验同 run/build，--quiet 解析同 build
  if (command === 'deploy') {
    const target = argv[1];
    if (!target) {
      say('[cli] 错误：deploy 缺少目标参数。');
      printHelp();
      process.exit(1);
    }
    if (!(target in DEPLOY_TARGETS)) {
      say(`[cli] 错误：未知目标「${target}」。`);
      printHelp();
      process.exit(1);
    }
    if (!isSupported(DEPLOY_TARGETS, target)) {
      say(`[cli] 错误：目标「${target}」在本机（${PLATFORM_NAME}）不受支持。`);
      printHelp();
      process.exit(1);
    }
    const rest = argv.slice(2);
    const quiet = rest.includes('--quiet');
    const unknownFlags = rest.filter((a) => a !== '--quiet');
    if (unknownFlags.length) {
      say(`[cli] 错误：无法识别的参数：${unknownFlags.join('、')}`);
      printHelp();
      process.exit(1);
    }
    const code = await cmdDeploy(target, quiet);
    process.exit(code);
  }

  // install：目标校验同 deploy，--quiet 静默、--no-launch 装完不拉起
  if (command === 'install') {
    const target = argv[1];
    if (!target) {
      say('[cli] 错误：install 缺少目标参数。');
      printHelp();
      process.exit(1);
    }
    if (!(target in INSTALL_TARGETS)) {
      say(`[cli] 错误：未知目标「${target}」。`);
      printHelp();
      process.exit(1);
    }
    if (!isSupported(INSTALL_TARGETS, target)) {
      say(`[cli] 错误：目标「${target}」在本机（${PLATFORM_NAME}）不受支持。`);
      printHelp();
      process.exit(1);
    }
    const rest = argv.slice(2);
    const quiet = rest.includes('--quiet');
    const launch = !rest.includes('--no-launch');
    const unknownFlags = rest.filter((a) => a !== '--quiet' && a !== '--no-launch');
    if (unknownFlags.length) {
      say(`[cli] 错误：无法识别的参数：${unknownFlags.join('、')}`);
      printHelp();
      process.exit(1);
    }
    const code = await cmdInstall(target, quiet, launch);
    process.exit(code);
  }

  // 未知命令
  say(`[cli] 错误：未知命令「${command}」。`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  say(`[cli] 未捕获异常：${err && err.stack ? err.stack : err}`);
  cleanupAll();
  process.exit(1);
});
