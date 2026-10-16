// ============================================================================
// api-base.js —— 后端基址（原生 App 无同源概念，所有请求必须走绝对地址）
// ----------------------------------------------------------------------------
// 契约：getApiBase() / setApiBase(url)
//   - getApiBase() → 同步返回当前基址字符串（默认值见下方 resolveDefaultApiBase：
//     web 生产构建 = 部署站点同源地址；其余 = http://localhost:3001 即 Koa 后端
//     默认端口，原生端无同源概念，client.js 等一律以它拼绝对 URL）；
//   - setApiBase(url) → 归一化（去尾部斜杠、校验 http/https）→ 更新内存值 →
//     经 settings.js 持久化到 'moontent_server' 键（'' 表示回落默认）并广播。
// 桌面注入：Web 端 URL 带 ?api= 查询参数时（Electron 桌面壳在 3001 被占且
// 不可复用时换空闲端口、以该参数告知前端实际基址），模块加载即归一后作为
// 初始基址；无参数 / 原生端行为不变，用户设置水合与「我的」页显式设置仍优先。
// 同步性说明：AsyncStorage 异步，故模块加载即开始水合（读 settings 的
// serverBase 键），水合完成前 getApiBase() 返回默认值——「我的」页改完基址后
// 的会话内读取全部走内存值，不受影响；冷启动首包请求理论上可能落在水合前的
// 默认值上，属可接受的竞态（settings 水合在首批界面渲染前即完成）。
// 依赖方向：本文件 → settings.js（单向；settings 不反向依赖，无循环）。
// ============================================================================
import { ensureSettings, getSettingsSnapshot, setSetting } from './settings.js';

// 兜底默认基址：Koa 后端默认端口（原生端 / web dev / SSG 导出期使用）
export const DEFAULT_API_BASE = 'http://localhost:3001';

// 归一化：去首尾空白与尾部斜杠；非 http(s) 绝对地址返回 ''（视为默认）
function normalize(url) {
  const u = String(url == null ? '' : url).trim().replace(/\/+$/, '');
  return /^https?:\/\/.+/.test(u) ? u : '';
}

// 当前环境的默认基址（三级回落，逐次取第一个合法值）：
// 1) EXPO_PUBLIC_API_BASE —— 构建期注入（Metro 内联 process.env，dev 与 export
//    均生效）：前端与 API 不同源部署（如静态托管上 CDN、API 独立域名）时用；
// 2) web 生产 —— 静态导出产物与 /api 由同一 Koa 进程同源同端口提供
//    （cli.js deploy server 的 SERVE_DIST 布局），取 window.location.origin
//    即部署站点自身；必须限定 production：dev server（8081）不同源、无 /api，
//    若取其 origin 会全军覆没，dev 维持打 localhost:3001（CORS 已放行）。
//    SSG 导出期（Node 环境，无 window）取不到 origin，落到第 3 级——渲染进
//    mine.html 的基址文案由 mine.js 挂载后渲染兜住，不在壳里烙任何地址；
// 3) DEFAULT_API_BASE —— 原生三端 / web dev / 桌面壳未注入参数时。
function resolveDefaultApiBase() {
  const envBase = normalize(process.env.EXPO_PUBLIC_API_BASE);
  if (envBase) return envBase;
  if (
    typeof window !== 'undefined' &&
    window.location &&
    process.env.NODE_ENV === 'production' &&
    (window.location.protocol === 'http:' || window.location.protocol === 'https:')
  ) {
    const origin = normalize(window.location.origin);
    if (origin) return origin;
  }
  return DEFAULT_API_BASE;
}

let base = resolveDefaultApiBase();

// Electron 桌面壳端口注入（仅 Web 端生效，不影响原生三端）：
// 桌面主进程首选 3001，被占且 127.0.0.1:3001 不可复用时换空闲端口，并在加载
// URL 上追加 ?api=<实际后端基址>。此处模块加载时读一次该参数，经上面的
// normalize 归一合法则作为初始 base；无参数或参数非法时行为与现状完全一致
// （typeof window 守卫 + window.location 存在才读，原生端直接跳过）。
if (typeof window !== 'undefined' && window.location) {
  try {
    const injected = normalize(new URLSearchParams(window.location.search).get('api'));
    if (injected) base = injected;
  } catch (_) {
    // 老旧 WebView 无 URLSearchParams 等异常：视同无注入，保持默认基址
  }
}

// 模块加载：等设置水合后对齐本机保存的基址（有保存值才覆盖默认）
ensureSettings().then(() => {
  const saved = normalize(getSettingsSnapshot().serverBase);
  if (saved) base = saved;
});

// 当前基址（同步）
export function getApiBase() {
  return base;
}

// 设置基址：立即更新内存值（本会话后续请求即刻生效），再持久化 + 广播
export async function setApiBase(url) {
  const n = normalize(url);
  base = n || resolveDefaultApiBase();
  await setSetting('serverBase', n); // 存归一化值；'' = 回落默认
  return base;
}

// 是否仍在默认基址（「我的」页设置行显示用；与「当前环境的默认」比较，
// web 生产端默认即站点自身，清空设置后回到同源状态）
export function isDefaultApiBase() {
  return base === resolveDefaultApiBase();
}
