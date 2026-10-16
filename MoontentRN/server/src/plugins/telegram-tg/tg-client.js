// ============================================================================
// tg-client.js —— teleproto 客户端基座(纯 JS MTProto;仅 Node 服务端运行)
// ----------------------------------------------------------------------------
// 引擎收敛(2026-10 TDLib → teleproto 全量替换):本文件是唯一的 teleproto
// 客户端构造点——会话持久化(StringSession,server/.telegram-session.json)、
// 客户端参数(含 downloadPool 多连接媒体调度)、SOCKS5 出口代理、MTProto
// 错误归一中文。域模块(auth/dialogs/messages/writes/updates/media/extras)
// 一律经注入的 getClient() 复用同一个客户端实例(engine 装配层接线),
// 本文件不持有任何模块级可变状态(纯函数 + 工厂,可独立单测)。
//
// —— downloadPool(媒体多连接调度旋钮) ——
// teleproto MediaScheduler 按「每 DC N 条媒体专用连接 × 每连接 M 在途」并发
// 拉 512KB 块(临时密钥、媒体专用 DC、FLOOD_WAIT 内建退避、FILE_MIGRATE 内建
// 迁移、CDN 不请求)。缺省=激进档 16×4=64 并发/DC(在飞预算 32MiB,teleproto
// 理论上限 kMaxMediaDcCount=16;对齐 TDLib 时代 patched 2→8 会话/16MiB 预算
// 之上再翻倍——服务器按账号软限速为最终上界,实测不满意可 env 降档):
//   TG_MEDIA_SESSIONS   下载会话数/DC(1..16,缺省 16)
//   TG_MEDIA_INFLIGHT   每会话在途请求数(1..16,缺省 4)
// 全局 GetFile 信号量上限缺省 = sessions×inFlight(见 media 域;env
// TG_MEDIA_CONCURRENCY 可显式压低,防小内存实例被 64 并发打满)。
//
// —— 会话口径 ——
// StringSession 只持久化主 DC authKey;env TELEGRAM_SESSION 直填会话串 >
// 会话文件(TELEGRAM_SESSION_FILE 覆盖路径)> 无。登录成功即 saveSessionFile
// 落盘;logout 删文件重建空客户端。同文件与 scripts/mtproto-login.mjs 共用
// (该脚本保留为 CLI 兜底登录通道;Web /login 三步流与 /qr 扫码流走 auth 域)。
//
// 防风暴红线:构造零连接副作用(顶层 import 不出网);一切失败如实上抛中文
// 错误;绝无自动重试(connectionRetries=3 是连接层握手重试,不是业务重试)。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as defaultLib from 'teleproto';
import { TgNotLoggedInError, getCreds, parseProxy } from './shared.js';

// —— server 根目录(src/plugins/telegram-tg/ 上三级),与启动 cwd 无关 ——
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..');

// downloadPool 缺省档:每 DC 16 会话 × 4 在途 = 64 并发 512KB 块(kMaxMediaDcCount=16 上限)
export const MEDIA_SESSIONS_DEFAULT = 16;
export const MEDIA_INFLIGHT_DEFAULT = 4;

function envClamp(name, dflt, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n < min) return dflt; // 非法/越下界取缺省(0=未设档)
  return Math.min(max, Math.floor(n));
}

// ============ 会话持久化(StringSession 串;mtproto-login.mjs 共用) ============

/** 会话文件路径(env TELEGRAM_SESSION_FILE 覆盖) */
export function sessionFilePath() {
  return process.env.TELEGRAM_SESSION_FILE
    || path.join(SERVER_ROOT, '.telegram-session.json');
}

/** 读已保存会话串:env TELEGRAM_SESSION 直填 > 会话文件;无则 null */
export function readSavedSession() {
  if (process.env.TELEGRAM_SESSION) return process.env.TELEGRAM_SESSION;
  try {
    const j = JSON.parse(fs.readFileSync(sessionFilePath(), 'utf8'));
    if (j && typeof j.session === 'string' && j.session) return j.session;
  } catch (_e) { /* 无会话文件属正常 */ }
  return null;
}

/** 会话落盘(格式与旧 mtproto-media/engine 逐字一致,部署链随包上传) */
export function saveSessionFile(sessionStr, phone, name) {
  const file = sessionFilePath();
  fs.writeFileSync(file, JSON.stringify({
    session: sessionStr, phone: phone || '', name: name || '',
    savedAt: new Date().toISOString(),
  }, null, 2));
  return file;
}

/** 删除会话文件(登出;不存在时幂等) */
export function deleteSessionFile() {
  try { fs.rmSync(sessionFilePath(), { force: true }); } catch (_e) { /* 幂等 */ }
}

// ============ MTProto 错误归一(teleproto 异常 → 中文;全引擎单一实现) ============

/**
 * 任意 teleproto/MTProto 异常 → 面向用户的中文错误。
 * 与旧 mtproto-media.normMtError 同语义:登录态错误类原样透传(auth 域另译);
 * CDN 重定向(≥10 万订阅频道可能命中;MediaScheduler cdnSupported=false 不
 * 主动请求 CDN,命中即明确告知而非裸抛 upload.fileCdnRedirect);
 * FLOOD_WAIT 带秒数;纯大写码加「Telegram 接口错误:」前缀。
 * @param {Error} e teleproto 抛出的异常(RPCError 有 .errorMessage/.code;
 *                  FloodWaitError 有 .seconds)
 * @param {object} [lib] teleproto 形对象(测试注入;缺省真实包,判 errors 用)
 */
export function normTgClientError(e, lib) {
  const L = lib || defaultLib;
  if (e instanceof TgNotLoggedInError) return e;
  if (e && e.name === 'CdnRedirectError') {
    return new Error('该文件位于 Telegram CDN,暂不支持中转播放');
  }
  if (e && (e instanceof L.errors.FloodWaitError || e.errorMessage === 'FLOOD_WAIT_X')) {
    const s = e.seconds || 60;
    return new Error('Telegram 限流(FLOOD_WAIT),请约 ' + s + ' 秒后再试');
  }
  if (e && e.code === 420) return new Error('Telegram 限流,请稍后再试');
  if (e && e.code === 401) return new TgNotLoggedInError(); // 会话被吊销/未授权
  const msg = (e && (e.errorMessage || e.message)) || String(e);
  return new Error(/^[A-Z_0-9]+$/.test(msg) ? 'Telegram 接口错误:' + msg : msg);
}

// ============ 客户端参数(纯函数;downloadPool/env 全在此读) ============

/**
 * 组装 TelegramClientParams(纯函数,可单测)。
 * @param {{sessions?: number, inflight?: number, connectionRetries?: number,
 *          floodSleepThreshold?: number}} [opts] 旋钮覆盖(env 优先级低于显式入参)
 */
export function buildClientParams(opts = {}) {
  const sessions = Math.max(1, opts.sessions ?? envClamp('TG_MEDIA_SESSIONS', MEDIA_SESSIONS_DEFAULT, 1, 16));
  const inflight = Math.max(1, opts.inflight ?? envClamp('TG_MEDIA_INFLIGHT', MEDIA_INFLIGHT_DEFAULT, 1, 16));
  const proxy = parseProxy() || undefined; // 非法值抛中文错(不出网即失败,shared.js 单一实现)
  return {
    connectionRetries: opts.connectionRetries ?? 3,
    useWSS: false, // 服务端直连 TCP(设了 TELEGRAM_PROXY 则经 SOCKS5 出口)
    floodSleepThreshold: opts.floodSleepThreshold ?? 20, // ≤20s 的 FLOOD_WAIT 静默等待;更长抛错转中文
    // 媒体多连接调度(见文件头):16×4 缺省激进档,env/入参可降
    downloadPool: {
      partSize: 512 * 1024,
      download: { sessions, inFlight: inflight },
      upload: { sessions: 8, inFlight: 2 },
    },
    ...(proxy ? { proxy } : {}),
  };
}

/**
 * 构造 teleproto 客户端(未连接——connect 由引擎/auth 域显式驱动)。
 * 凭据缺失抛中文错(getCreds strict);sessionStr 为空串时构造的是「干净」
 * 客户端(登录流程用;已保存会话的恢复走 readSavedSession → connect →
 * isUserAuthorized)。
 * @param {{sessionStr?: string, lib?: object}} [deps]
 * @param {object} [opts] buildClientParams 的旋钮
 */
export function newTgClient(deps = {}, opts = {}) {
  const lib = deps.lib || defaultLib;
  const { apiId, apiHash } = getCreds(); // 凭据缺失抛中文文案(shared.js 单一实现)
  const client = new lib.TelegramClient(
    new lib.sessions.StringSession(deps.sessionStr || ''),
    apiId,
    apiHash,
    buildClientParams(opts),
  );
  // 纯文本发送语义:关闭库缺省的 Markdown 解析(用户原文即所发文本,
  // **bold** 等标记不意外生效;parseMode 属客户端级全局开关,建库即关)
  client._parseMode = undefined;
  return client;
}

/**
 * 「全局 GetFile 信号量」缺省值 = sessions×inFlight(与 downloadPool 同源;
 * media 域消费,防 64 并发打满小内存实例时可用 TG_MEDIA_CONCURRENCY 压低)。
 */
export function defaultMediaConcurrency() {
  const sessions = envClamp('TG_MEDIA_SESSIONS', MEDIA_SESSIONS_DEFAULT, 1, 16);
  const inflight = envClamp('TG_MEDIA_INFLIGHT', MEDIA_INFLIGHT_DEFAULT, 1, 16);
  return sessions * inflight;
}
