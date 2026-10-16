// ============================================================================
// tg-api.js —— Telegram 域统一 API 通道(GET + JSON POST,聊天域共用)
// ----------------------------------------------------------------------------
// 契约(导出 api / postJson / 两档超时常量):
//   api(site, method, params?, opts?)  → GET {base}/api/{site}/{method}?{qs}
//     解析后 JSON;错误契约 {__err:1,message,needLogin?}(HTTP 502/400 等)
//     → 抛 Error(message 原样透传,needLogin 挂 Error.needLogin——比 client.js
//     的 GET 通道多保留该字段,聊天域未登录判定不再依赖文案启发式);
//   postJson(path, body?, opts?)       → POST {base}{path} JSON 体,契约同上。
//     合并 use-chat-timeline.js 与聊天页两份同款 postJson 拷贝(chat/[id].js
//     的迁移由后续任务做,契约逐字兼容:默认 20s 超时、AbortError 归一中文、
//     needLogin 透传);
//   opts.timeoutMs                     → 单次请求超时覆盖(默认 DEFAULT_TIMEOUT_MS
//     =20s);长轮询类(GET /updates,服务端 wait 钳制上限 20s + 网络余量)必须
//     传 LONGPOLL_TIMEOUT_MS=30s——默认档必然截断挂起中的长轮询;
//   opts.signal                        → 调用方中止信号(轮询停止时掐断在途
//     长轮询用);与超时计时器并联,任一先触发即中止。
// 与 lib/client.js 的分工(勿混淆):
//   · client.js api() 是全站通用 GET 通道(同 URL 在途去重 + meta TTL 缓存 +
//     响应深遍历绝对化),适合目录/详情页;
//   · 本文件是聊天域专用:① 不去重不缓存——长轮询的「同一 URL 挂 20s」若被
//     去重会让第二个等待者陪着第一个挂到天荒地老;② 响应不做深遍历绝对化——
//     聊天消息统一由 use-chat-timeline 的 normalizeDeep 补 URL(覆盖 fullUrl/
//     webpage.photo 等本域键 + tg.local 令牌代理),两处归一反而会互相踩脚;
//   · 绝不自动重试(仓库红线);失败如实抛错,由调用方决定呈现。
// ============================================================================
import { getApiBase } from './api-base.js';

export const DEFAULT_TIMEOUT_MS = 20000;   // 默认超时(与 client.js 默认档一致)
export const LONGPOLL_TIMEOUT_MS = 30000;  // 长轮询档:>服务端 wait 上限 20s(任务口径 25s+),留网络余量

// 查询串:null/undefined/空串不进参数(与 client.js buildQuery 同款,Hermes
// 无 URLSearchParams 保证,纯字符串拼接)
function buildQuery(params) {
  const parts = [];
  for (const k of Object.keys(params || {})) {
    const v = params[k];
    if (v == null || v === '') continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  }
  return parts.join('&');
}

// 裸请求:超时计时器 + 调用方 signal 并联中止 + ok/__err 错误契约 → Error
async function fetchJson(path, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const ms = Math.max(1000, Math.floor(Number(timeoutMs)) || DEFAULT_TIMEOUT_MS);
  // 无 AbortController 的极端环境退化为不设限(与既有 postJson 拷贝同款兜底)
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  const onAbort = () => { if (ctl) ctl.abort(); };
  if (ctl) {
    if (signal) {
      if (signal.aborted) ctl.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => ctl.abort(), ms);
  }
  try {
    const r = await fetch(getApiBase() + path, {
      method,
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
      signal: ctl ? ctl.signal : undefined,
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.__err) {
      const e = new Error((j && j.message) || 'HTTP ' + r.status);
      if (j && j.needLogin) e.needLogin = true;
      throw e;
    }
    return j;
  } catch (e) {
    if (e && e.name === 'AbortError') {
      // 中止来源二选一:调用方 signal 主动中止 vs 超时计时器兜底(文案与既有
      // postJson 拷贝逐字一致,页面 catch 的既有提示不受迁移影响)
      throw new Error(signal && signal.aborted ? '请求已中止' : '请求超时(' + Math.round(ms / 1000) + 's)已中止');
    }
    throw e;
  } finally {
    if (timer != null) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// GET {base}/api/{site}/{method}?{qs} → 解析后 JSON(原始形状,不绝对化,见文件头)
export async function api(site, method, params, opts = {}) {
  const qs = params ? buildQuery(params) : '';
  const path = '/api/' + site + '/' + method + (qs ? '?' + qs : '');
  return fetchJson(path, { method: 'GET', timeoutMs: opts.timeoutMs, signal: opts.signal });
}

// POST {base}{path}(JSON 体)→ 解析后 JSON
export function postJson(path, body, opts = {}) {
  return fetchJson(path, { method: 'POST', body, timeoutMs: opts.timeoutMs, signal: opts.signal });
}
