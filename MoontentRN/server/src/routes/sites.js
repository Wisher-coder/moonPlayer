// ============================================================================
// 站点清单路由:GET /api/sites
// ----------------------------------------------------------------------------
// (自 NextWeb/app/api/sites/route.js 1:1 移植;2026-10 叠加 Redis 60s 缓存)
// 返回 [{id,name,capabilities,group}]:前端按 capabilities 自适应各站点可用
// 接口;group=main 主站 / cms 资源站(资源站插件群按健康态动态增减,见
// src/plugins/cms/)。
//
// 响应体缓存(Redis 'mnt:sites' 60s):清单是全站入口,前端每个页面首访都
// 拉一次,60s 内多端共享同一份 JSON,连 listSites() 的插件群遍历都省掉;
// miss 才回源并回写。warmAll/startDomainRefreshCycle 的冷启动触发语义原样
// 保留在缓存判定之前——无论命中与否都照常触发(预热与清单内容无关,缓存
// 命中也绝不跳过)。Redis 不可用时直接回源,行为与无缓存时代完全一致
// (铁律同 api-cache/redis.js:加速器不是依赖项)。
// ============================================================================

import Router from '@koa/router';
import { listSites, warmAll } from '../plugins/registry.js';
import { startDomainRefreshCycle } from '../plugins/domain-refresh.js';
import { redisOn, rdGet, rdSet } from '../lib/redis.js';
import { getShardInfo } from '../lib/shard-ports.js';

const SITES_CACHE_KEY = 'mnt:sites';  // Redis 键
const SITES_CACHE_TTL = 60;           // 60s

// 首次尝试放行(与 api-cache.js 的 l2On 同理):redis.js 惰性建连,冷启动后
// redisOn() 恒为 false,不放行一次则缓存永不生效;Redis 不可达时该次 rdGet
// 快速失败,此后严格按 redisOn() 短路直接回源,与无缓存时代零行为差异
let redisTried = false;
function sitesCacheOn() {
  const first = !redisTried;
  redisTried = true;
  return redisOn() || first;
}

export const sitesRouter = new Router();

sitesRouter.get('/sites', async (ctx) => {
  // 进程冷启动预热触发点(NextWeb 同款):前端任何页面首访都会拉本清单,借这个
  // 「必然发生」的时机 fire-and-forget 触发 warmAll()(不 await,清单响应
  // 绝不等预热)——把 bf 这类重冷启动链路(guest 登录/网关优选/类目树)提前
  // 到后台完成,首个真实数据请求命中的已是热缓存。warmAll 进程内只跑一次,
  // 内部已对每个插件的 warm() 逐个吞错;这里再包一层 try 兜底,保证预热
  // 任何形态的失败都绝不影响清单响应本身。
  // 旁边一并启动站点入口域名自动刷新周期(对齐 cms/index.js 的访问驱动启动
  // 范式):startDomainRefreshCycle 幂等——首轮 fire-and-forget + 5 分钟
  // unref 常驻定时器,对已接入站点(hanxiucao/yuese/aidou/dsd)串行重跑
  // 各自发现链,详见 plugins/domain-refresh.js。
  try {
    warmAll();
    startDomainRefreshCycle();
  } catch (e) { /* 预热失败静默:真实用户请求会重走完整链路并如实报错 */ }

  // 响应结构与 NextWeb 一致:body 即站点清单裸数组(无外层包装)
  ctx.type = 'application/json';
  // —— Redis 60s 缓存:命中直接回缓存体(上文预热触发不受缓存影响)——
  if (sitesCacheOn()) {
    const raw = await rdGet(SITES_CACHE_KEY);
    if (raw) {
      try {
        ctx.body = JSON.parse(raw);   // 损坏值走 catch 视同 miss 回源覆盖
        return;
      } catch { /* 半写入/损坏:视同 miss */ }
    }
  }
  const list = await listSites();
  // —— Telegram 分片信息注入(接口契约,字段名一字不差,客户端并行开发依赖):
  //    id==='telegram' 的条目附加可选字段——分片启用(实际绑定端口数 >1,即
  //    主端口之外还有分片)时 shardPorts: number[](实际绑定端口,主端口在前),
  //    恒带 streamSlots: number(缺省 16)。契约红线:响应仍是站点清单裸数组,
  //    只加条目级可选字段。注入在 Redis 回写之前,缓存体天然带这些字段
  //    (命中即原样回,无需特判;旧缓存体至多 60s 后自然过期) ——
  const shard = getShardInfo();
  for (const item of list) {
    if (item && item.id === 'telegram') {
      if (shard.ports.length > 1) item.shardPorts = shard.ports;
      item.streamSlots = shard.streamSlots;
    }
  }
  // 回写不 await(不拖慢响应)也不 gate:rdSet 失败本就静默 no-op,Redis
  // 断线时这条写不进只是下次仍回源,零副作用。
  // 冷启动竞态防御:分片端口在各自 listen 回调里异步落账,若本次响应生成
  // 于分片结算完成之前,telegram 条目会少报 shardPorts——该形态一旦回写
  // Redis 会钉住至多 60s;故未结算(settled=false)时跳过本次回写,只回
  // 当前响应、下一请求重算,代价仅是结算前的几个请求直回源(与「Redis
  // 不可用直回源」同款优雅降级)
  if (redisOn() && shard.settled !== false) {
    rdSet(SITES_CACHE_KEY, JSON.stringify(list), SITES_CACHE_TTL);
  }
  ctx.body = list;
});
