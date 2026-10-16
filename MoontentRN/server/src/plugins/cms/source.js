// ============================================================
// source.js —— 资源站清单自动更新 + 健康探测(仅 Node 服务端运行)
//
// 清单来源:资源族 ziyuanzu.com/download/ziyuanzu-cms-interfaces.json
// (73 个 Apple CMS V10 json 采集接口,含 name/api/apiType/uptime/speed/
// totalResources 元数据)。数据三级:
//   内存(globalThis 单例,见 index.js,防 dev 热重载丢)
//   → 磁盘 <server 根>/.cms-sources.json(重启免拉;路径由 import.meta.url
//     推导,与本文件位置绑定,从任意 cwd 启动行为一致)
//   → 仓库内置快照 ./fallback-sources.json(实施时一次性抓取固化,离线冷启动种子)。
//
// 自动更新:12h TTL 到期后由 index.js 的后台 cycle 重拉(当次请求仍回旧
// 清单,永不阻塞请求路径);拉取失败沿用旧清单等下轮。
// 健康探测(排除丢包站点):8 并发、单站 8s,GET {api}?ac=list&pg=1,
// 判活 = HTTP 200 + 信封 code=1 + class/list 为数组(JSON 与 RSS 同形,
// upstream 层已抹平盾站/协议差异);结果 30min 有效。
// uptime/speed/totalResources 元数据只用于排序(fast→slow、uptime 降序、
// 资源量降序),不作为排除依据——活跃探测是唯一事实。
// ============================================================
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 纯 Node 运行时要求 JSON 模块导入必须带 with { type: 'json' } 属性
import FALLBACK_SOURCES from './fallback-sources.json' with { type: 'json' };
import { macCmsRequest, UA } from './upstream.js';

export const SOURCES_URL = process.env.ZIYUANZU_URL || 'https://www.ziyuanzu.com/download/ziyuanzu-cms-interfaces.json';
export const REFRESH_TTL_MS = 12 * 60 * 60 * 1000;   // 清单重拉周期
export const PROBE_TTL_MS = 30 * 60 * 1000;          // 探测结果有效期
export const PROBE_CONCURRENCY = 8;                  // 探测并发池
const PROBE_TIMEOUT_MS = 8000;
const FETCH_TIMEOUT_MS = 15000;
// 磁盘缓存落点:基于 import.meta.url 推导 server 根(src/ 的上两级),
// 与启动时 cwd 无关——从任意目录启动都读写同一份缓存
const DISK_CACHE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.cms-sources.json');

// ============ 清单校验 / 排序 ============

// 只收 json 形态、name/api 齐全的条目;按 api 去重
export function validateEntries(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const name = String(it.name || '').trim();
    const api = String(it.api || '').trim();
    if (!name || !/^https?:\/\//i.test(api)) continue;
    if (it.apiType && String(it.apiType).toLowerCase() !== 'json') continue;
    if (seen.has(api)) continue;
    seen.add(api);
    out.push({
      name, api, apiType: 'json',
      uptime: String(it.uptime || ''),
      speed: String(it.speed || '').toLowerCase(),
      totalResources: Number(it.totalResources) || 0,
    });
  }
  return out;
}

const SPEED_RANK = { fast: 0, medium: 1, slow: 2 };
const uptimeNum = (s) => {
  const n = parseFloat(String(s || '').replace('%', ''));
  return Number.isFinite(n) ? n : 0;
};

// 展示顺序:速度档 → uptime → 资源量(仅排序,不排除)
export function sortEntries(entries) {
  return [...entries].sort((a, b) =>
    ((SPEED_RANK[a.speed] ?? 3) - (SPEED_RANK[b.speed] ?? 3)) ||
    (uptimeNum(b.uptime) - uptimeNum(a.uptime)) ||
    ((b.totalResources || 0) - (a.totalResources || 0)));
}

// ============ 三级数据源 ============

// 磁盘缓存 → 内置快照;返回 {entries, fetchedAt}(均已校验排序)
export async function loadSeed() {
  try {
    const j = JSON.parse(await fsp.readFile(DISK_CACHE, 'utf8'));
    const entries = sortEntries(validateEntries(j && j.entries));
    if (entries.length) return { entries, fetchedAt: Number(j.fetchedAt) || 0 };
  } catch (e) { /* 无磁盘缓存/损坏:走内置快照 */ }
  return { entries: sortEntries(validateEntries(FALLBACK_SOURCES)), fetchedAt: 0 };
}

export async function saveDisk(entries, fetchedAt) {
  try { await fsp.writeFile(DISK_CACHE, JSON.stringify({ fetchedAt, savedAt: Date.now(), entries })); } catch (e) { /* 写盘失败无碍内存态 */ }
}

// 在线拉最新清单(失败抛错由调用方沿用旧数据)
export async function fetchSourcesFresh() {
  const res = await fetch(SOURCES_URL, {
    cache: 'no-store',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': UA, 'Accept': 'application/json,*/*;q=0.8' },
  });
  if (!res.ok) throw new Error('资源族清单 HTTP ' + res.status);
  return await res.json();
}

// ============ 健康探测(排除丢包站点) ============

// 单站判活:GET {api}?ac=list&pg=1,8s 超时;任何异常按死站处理。
// 走 upstream 封装:盾站(奥斯卡)先过盾再判、XML 站(大地)RSS 同形吃下、
// https 不通的站(百花)自动降级 http——探测口径必须与运行时一致,否则
// 「探测判死→摘除」会把已修复的站点又踢出去
export async function probeEntry(entry) {
  try {
    const j = await macCmsRequest(entry.api, { ac: 'list', pg: 1 }, { timeoutMs: PROBE_TIMEOUT_MS });
    return !!j && Number(j.code) === 1 && (Array.isArray(j.class) || Array.isArray(j.list));
  } catch (e) { return false; }
}

// 简单并发池(探测 8 并发用;单项异常不中断池)
export async function runPool(items, concurrency, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await fn(items[idx], idx); } catch (e) { /* 单项失败不拖垮整池 */ }
    }
  });
  await Promise.all(workers);
}
