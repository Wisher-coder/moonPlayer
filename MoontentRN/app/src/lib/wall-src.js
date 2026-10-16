// ============================================================================
// wall-src.js —— 看板播放地址预解析缓存(模块级 Map,LRU + TTL)
// ----------------------------------------------------------------------------
// 移植自 NextWeb/src/lib/wall-src.js,行为 1:1。addToWall 时后台先把播放地址
// 解析好,看板首开时 tile 命中热缓存直接挂流,省掉每格 1~6s 的服务端现取上游
// 往返——「秒开」的第一半;第二半(重开)由 WallOverlay 的停车场保活负责,
// 与本模块无关。
//   - 键 "site:id" → { url, type, at };TTL 4 分钟:上游播放地址多为分钟级签名
//     (zimuquan 分钟级、bf/cms 令牌 5~30 分钟),缓存取短侧,宁可过期重取也不
//     拿失效地址去挂流(hls 挂失败走 tile 现有 fatal 恢复/错误态重试兜底);
//   - 容量 24(> WALL_MAX 16,覆盖满员+换血);满时淘汰最旧(at 最小);
//   - primeWallSrc:fire-and-forget 预热(inflight 去重,不重不漏),addToWall 调;
//   - getWallSrc:tile 取流唯一入口——新鲜直返、过期/缺失现解析并回填、失败清项
//     并抛错(调用方走「解析失败」错误态给重试);{force:true} 跳过缓存读直取新
//     地址(tile 重试必走 force:TTL 内死掉的地址重试不能又拿回同一条);
//   - dropWallSrc:只删缓存项不触发解析(播放挂死清账用,下次取流自然现解析)。
// RN 适配点仅一处:解析调用按 RN client 契约写 api(site,'play',{id})
// (NextWeb 为 api.play(site,id) 便捷形);client 的 deep-walk 已把 url 键绝对化,
// 返回的 url 可直接喂给 web 的 video.src / native 的 VideoSource,无需再过
// absolutizeUrl。纯客户端模块,无平台 API 依赖,三端同一份逻辑。
// 分片池(origin-pool):telegram 代理流地址按格子序号轮询 origin——序号取
// item.key('site:id',与本缓存键同构)的稳定 hash(WallOverlay 不在本任务
// 改动面,渲染序透传不可行;key hash 同格恒定、异格分散,等价轮询)。池未
// 启用/非本站流地址(外部 CDN 直链)原样;重定向发生在解析回填时,缓存命中
// 自然沿用同一 origin。
// ============================================================================
import { api } from './client.js';
import { shardMediaUrl, stableHash } from './origin-pool.js';

const SRC_MAX = 24;        // LRU 容量(> 看板上限 16)
const SRC_TTL = 4 * 60e3;  // 地址时效(保守取短,见文件头)

const cache = new Map();   // "site:id" → { url, type, at };Map 迭代序 = 插入序,LRU 用重插实现
const inflight = new Map(); // "site:id" → Promise(去重并发解析)

const keyOf = (site, id) => site + ':' + String(id);

// 容量控制:超限淘汰最旧(Map 首项 = 最久未重插)
function evict() {
  while (cache.size > SRC_MAX) cache.delete(cache.keys().next().value);
}

// 真正的解析(带缓存回填;只在缓存无/过期/force 时走到)
async function resolve(site, id, force) {
  const key = keyOf(site, id);
  const hit = cache.get(key);
  if (hit && !force && Date.now() - hit.at < SRC_TTL) { cache.delete(key); cache.set(key, hit); return hit; } // LRU 重插
  if (force) cache.delete(key); // force:先清旧项,解析失败也不留死链
  const p = inflight.get(key);
  if (p) return p;
  const task = (async () => {
    try {
      const r = await api(site, 'play', { id });
      if (!r || !r.url) throw new Error('播放地址为空');
      // 分片池轮询:r.url 已被 client 绝对化为主基址形态,shardMediaUrl 识别
      // telegram 代理流并按 key 稳定 hash 搬到对应 origin;不命中原样
      const entry = { url: shardMediaUrl(r.url, stableHash(key)) || r.url, type: r.type, at: Date.now() };
      cache.delete(key);
      cache.set(key, entry);
      evict();
      return entry;
    } catch (e) {
      cache.delete(key); // 失败不留脏项,下次现取
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

// 预热:加入/刷新看板项时后台先解析好,结果由缓存吃下,错误静默(首开时
// getWallSrc 会再试一次,那里才有用户可见的错误态)
export function primeWallSrc(site, id) {
  if (!site || id == null) return;
  resolve(site, id).catch(() => { /* 预热失败不声张 */ });
}

// tile 取流入口:语义同 api(site,'play',{id}),但命中新鲜缓存零往返;
// {force:true} 绕过缓存现取新地址(重试用,防 TTL 内死链复读)
export async function getWallSrc(site, id, opts) {
  return resolve(site, id, !!(opts && opts.force));
}

// 删除缓存项(不触发解析):tile 播放挂死时清账,下次取流现解析
export function dropWallSrc(site, id) {
  cache.delete(keyOf(site, id));
}
