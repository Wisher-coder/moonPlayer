// ============================================================
// api-cache.js —— /api 数据面公共缓存:L1 进程内 LRU + L2 Redis + SWR
// (仅 Node 服务端运行)
//
// 定位:src/routes/site-method.js 的整包 JSON 结果缓存。本站无账号
// 体系、无个性化(所有用户看到同一份数据),因此 /api 响应是天然的公共资产,
// 一个用户拉过的列表,下一个用户直接复用——这与插件层的元数据缓存(如 bf 的
// modsCache 类目树 10min、playlist 文本 LRU)是同一套分层哲学:插件层缓存
// 「上游原始结构」供插件内部多请求复用,本层缓存「归一化后的最终响应」供
// 路由层秒回。插件层对 list/search 结果页零缓存,本层补上这一格,且在途
// 去重把「同一 URL 的并发未命中」合并成一次上游链路(AES 解密 / bf 网关
// 登录 / WAF 挑战 / HTML 爬取,插件超时 15s,惊群代价极高)。
//
// (L1 自 NextWeb/src/server/lib/api-cache.js 1:1 移植,语义逐条保留至今;
//  2026-10 在 L1 之上叠加 Redis L2 与 SWR 软过期,设计见下节)
//
// —— L2/SWR 设计(2026-10 叠加)——
// 分层:L1 = 进程内 Map(热端,零网络开销);L2 = Redis,'mnt:api:'+原key →
// JSON {out, at, ttl, hard},跨进程共享、进程重启不丢。hard = min(ttl*10,
// 30min):ttl 过后到 hard 之间是「软过期」SWR 窗口——旧值仍可秒回,换来
// 后台静默换新;超过 hard 视同 miss 必须回源(L2 条目本身也按 ceil(hard/1000)
// 秒在 Redis 过期,不会无限堆积)。
//   · 读序:L1 新鲜 → 直接回;L1 miss/过期 → L2 新鲜(at+ttl>now) → 按现行
//     size 口径回填 L1(计入条目/字节预算、参与淘汰)后回;L2 软过期
//     (ttl≤age<hard) → 立即回旧值 + 后台刷新——复用 inflight 表防惊群,同 key
//     并发只打一次上游,成功双写 L1+L2,失败静默留旧值(上游故障不放大成
//     对客端的错误页);L2 硬过期/不存在 → 同步 produce(现行 miss 语义)。
//   · 写序:produce 成功 → 写 L1(现行逻辑不变) → rdSet(L2 键, JSON,
//     ceil(hard/1000) 秒);单条 JSON >1MB 跳过 L2(防超大响应挤占 Redis,
//     归一化响应本就极少超此量级)。
//   · 降级:Redis 是加速器不是依赖项(src/lib/redis.js 同款铁律)。l2On()
//     为 false 时短路一切 L2 读写,行为与本文件纯 L1 时代完全一致。注意
//     redis.js 是惰性建连(lazyConnect),进程冷启动后首次调用前 redisOn()
//     恒为 false——若直接据此短路,L2 将永不生效,因此进程生命周期内的
//     第一次 L2 动作放行(由 rdGet/rdSet 内部触发建连);Redis 不可达时该次
//     命令按 maxRetriesPerRequest=1 快速失败,此后永久短路、零 Redis 等待,
//     由 ioredis 后台无限重连自愈,恢复后 redisOn() 自动翻真、L2 重新生效。
//   · 重启收益(核心):进程重启 L1 清空,Redis 里 L2 仍在——重启后的首批
//     请求直接 L2 命中回填(上游 AES/网关/WAF 链路零成本恢复热度),热门页
//     不因发版/重启产生回源风暴。
//
// 容量双维度(为 1GB 内存部署机收敛,口径仅约束 L1;L2 由 Redis 自身内存
// 与 hard TTL 管理):
//   · 条目数上限 300 —— 列表/搜索/详情 key 空间按「站×方法×参数」展开,
//     热点请求集中于首页与前几页,300 条足够覆盖活跃工作集;
//   · 字节预算 ~8MB —— 条目大小用 JSON.stringify(out).length 粗估(近似
//     UTF-16 码元数,对以 ASCII 为主的 JSON 即字节数;精确字节数需二次遍历,
//     不值得——预算本身只需量级正确)。两维任一超限即从最旧端淘汰,防慢速
//     内存增长把小机压垮;单条超大(如整包片单 gather/package)也只挤掉旧
//     条目,不会因一条超限整体清空。
//
// 语义要点(L1 时代即有,逐条保留):
//   · 淘汰近似 LRU:命中即把条目挪到插入序队尾(touch),淘汰永远从队首取;
//   · 同 key 在途去重:未命中时 Map<key, Promise> 共享同一 producer Promise,
//     并发调用只执行一次上游链路(L2 时代的 SWR 后台刷新共用这张表);
//   · 仅成功入缓存:producer 抛错(上游故障/协议失败)原样上抛、不留缓存,
//     下一次请求立即重试真实上游——失败永不被放大成 30s/5min 的持续错误页
//     (SWR 后台刷新的失败按设计静默留旧值,不冒泡给调用方)。
// ============================================================

import { redisOn, rdGet, rdSet } from './redis.js';

// TTL 档位(与路由层「可缓存方法 → 档位」表一一对应):
//   META 档 5min:结构面(首页骨架/分类树/热词/标签表/目录页),上游变化慢;
//   LIST 档 30s:内容面(列表/搜索/详情),站方新片上架晚半分钟可见,是刻意
//     的新鲜度权衡——换来热门页 30s 内所有访客零上游成本。
export const TTL_META = 300000;
export const TTL_LIST = 30000;

const MAX_ENTRIES = 300;              // 条目数上限(见文件头「容量双维度」)
const MAX_BYTES = 8 * 1024 * 1024;    // 字节预算 ~8MB

// —— L2(Redis)常量(见文件头「L2/SWR 设计」)——
const L2_PREFIX = 'mnt:api:';         // L2 键 = 前缀 + 原 key
const L2_MAX_JSON = 1024 * 1024;      // 单条 L2 JSON 上限 1MB,超过跳过 L2
const L2_HARD_CAP = 30 * 60 * 1000;   // 软过期上限绝对值(30min)

const cache = new Map();    // key → { out, size, at, ttl };Map 迭代序 = 插入序,队首即最旧
const inflight = new Map(); // key → Promise(同 key 在途去重,miss 与 SWR 刷新共用)
let bytes = 0;              // 当前总占用(粗估口径,与 size 同源)

// 软过期上限:hard = min(ttl*10, 30min)——ttl 内新鲜,ttl~hard 之间 SWR 旧值
// 可用,超过 hard 视同 miss
function hardTtl(ttlMs) {
  return Math.min(ttlMs * 10, L2_HARD_CAP);
}

// L2 可用性判定(见文件头「降级」):redisOn() 是健康镜像,但冷启动后首次
// 建连前恒为 false——首次放行一次以触发惰性建连,此后严格以 redisOn()
// 为准:断线短路一切 L2 动作(零 Redis 等待),ioredis 后台重连成功后自动恢复
let l2Bootstrapped = false;
function l2On() {
  const first = !l2Bootstrapped;
  l2Bootstrapped = true;    // 首次之后一律交给 redisOn() 健康镜像
  return redisOn() || first;
}

// 摘除一条并回冲字节占用(命中 touch / 过期清理 / 淘汰共用)
function removeEntry(key, ent) {
  cache.delete(key);
  bytes -= ent.size;
}

// 双维度淘汰:条目数或字节数任一超限,从队首(最旧)逐条摘除
function evictIfNeeded() {
  while (cache.size > MAX_ENTRIES || bytes > MAX_BYTES) {
    const first = cache.entries().next();
    if (first.done) break;   // 缓存已空仍超限(理论不可达):防御性退出
    removeEntry(first.value[0], first.value[1]);
  }
}

// 统一写 L1(produce 成功与 L2 新鲜回填共用):按现行 size 口径(JSON
// stringify 长度粗估)记账并入双维度淘汰;回填时 at 沿用 L2 条目的写入时刻,
// 保证 L1/L2 新鲜期同拍到点(回填后的 L1 到期即进 L2 的 SWR 窗口)
function writeL1(key, out, ttl, at) {
  const size = JSON.stringify(out).length;
  const prev = cache.get(key);           // 防御:同 key 旧条目(理论上已摘)先摘掉
  if (prev) removeEntry(key, prev);
  cache.set(key, { out, size, at: at ?? Date.now(), ttl });
  bytes += size;
  evictIfNeeded();
}

// L2 值解析:键不存在/Redis 不可用(rdGet 统一回 null)、JSON 损坏、字段
// 异常,一律视同 miss——公共缓存容错优先,回源一次即自愈
function parseL2(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || !('out' in j)
      || !Number.isFinite(j.at) || !Number.isFinite(j.ttl) || !Number.isFinite(j.hard)) {
      return null;
    }
    return j;
  } catch {
    return null;
  }
}

// 统一产 new 口(miss 同步路径与 SWR 后台刷新共用):同 key 只允许一个在途
// producer,后来者共享同一 Promise;成功即 L1 现行写入 + L2 双写(单条超
// 1MB 跳过 L2);失败不落任何缓存——同步路径原样冒泡给调用方,SWR 路径由
// 调用方吞错静默留旧值
function startProduce(key, ttlMs, producer) {
  let p = inflight.get(key);
  if (p) return p;
  p = (async () => {
    const out = await producer();          // 抛错即不入缓存(现行语义)
    writeL1(key, out, ttlMs);
    if (l2On()) {
      const hard = hardTtl(ttlMs);
      const json = JSON.stringify({ out, at: Date.now(), ttl: ttlMs, hard });
      if (json.length <= L2_MAX_JSON) {
        // await 保证测试/调用方在拿到返回值时 L2 已落键;rdSet 内部吞错,
        // Redis 侧失败不影响主链路(下次读不到,仅退化回 L1)
        await rdSet(L2_PREFIX + key, json, Math.ceil(hard / 1000));
      }
    }
    return out;
  })().finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

// 统一取数口(读序/写序见文件头「L2/SWR 设计」)。hit 标记一切「缓存直接
// 返回」的路径(L1 新鲜 / L2 新鲜回填 / SWR 旧值秒回),hit:false 表示本次
// 等待了 producer;数据本体各分支完全一致,调用方无需区分来源。
export async function cachedGet(key, ttlMs, producer) {
  const ent = cache.get(key);
  if (ent) {
    if (Date.now() - ent.at < ent.ttl) {
      // 命中且未过期:touch 到队尾(近似 LRU),零上游成本
      removeEntry(key, ent);
      cache.set(key, ent);
      return { out: ent.out, hit: true };
    }
    // 过期:先摘除(重取成功后会以新值回到队尾;重取失败则条目本就不该留)
    removeEntry(key, ent);
  }
  // —— L1 miss/过期 → 查 L2(Redis 不可用时 l2On() 短路,直接走 produce)——
  if (l2On()) {
    const l2 = parseL2(await rdGet(L2_PREFIX + key));
    if (l2) {
      const age = Date.now() - l2.at;
      if (age < l2.ttl) {
        // L2 新鲜:按现行口径回填 L1(记账、入淘汰)后秒回——进程重启后
        // L1 空、L2 仍在,首批请求即走这条零上游链路(重启不丢的核心收益)
        writeL1(key, l2.out, l2.ttl, l2.at);
        return { out: l2.out, hit: true };
      }
      if (age < l2.hard) {
        // L2 软过期(SWR):旧值立即回,后台刷新复用 inflight 防惊群——
        // 刷新失败静默留旧值(不冒泡),硬过期前始终有值可回
        startProduce(key, ttlMs, producer).catch(() => {});
        return { out: l2.out, hit: true };
      }
      // L2 硬过期:视同 miss,落到下面的同步 produce
    }
  }
  // 未命中:同 key 只允许一个在途 producer,后来者共享同一 Promise
  return { out: await startProduce(key, ttlMs, producer), hit: false };
}
