// ============================================================
// domain-refresh.js —— 站点入口域名自动刷新调度器(仅 Node 服务端运行)
//
// 【机制】上游站群的入口/网关域名高频轮换,「手改环境变量 + 重启」的维护方式
// 跟不上轮换节奏。本模块给「有发布页/发现链」的站点插件提供统一的域名刷新
// 调度(范式对齐 cms/index.js 的 globalThis 单例 + unref 定时器):
//   · registerRefresher(siteId, fn):各插件在【自己模块文件】加载时调用注册;
//     fn 为该站刷新函数,须返回 { changed:boolean }——新基址与旧不同才算
//     changed;fn 内部失败一律 fail-soft 保留旧基址(绝不把还能用的基址刷没),
//     抛出的异常由调度器吞掉并按 { changed:false } 处理;
//   · 5 分钟周期轮(startDomainRefreshCycle 启动,幂等):每轮对全部已注册
//     站点【串行】执行——防请求风暴是本仓库铁律,禁止改成并发;
//   · requestUrgentRefresh(siteId):用户请求失败路径的触发口;单站 60 秒
//     冷却(冷却期内直接回 {changed:false}),该站刷新在途则共享同一 Promise,
//     绝不叠加并发;
//   · 启动范式对齐 CMS 的访问驱动启动:由 GET /api/sites 处、warmAll() 旁边
//     一起调用(前端任何页面首访都会拉站点清单,等价于「进程启动后不久必然
//     触发」),首轮 fire-and-forget + 常驻 setInterval(t.unref())。
//
// 【节流红线】发现链全程串行、单请求超时由各插件自守(10-15s)、urgent 60s
// 冷却、不加码重试;本模块自身零网络请求(刷新逻辑全在各插件内)。
//
// 【依赖方向】本模块不 import 任何插件(插件单向依赖本模块),无循环依赖;
// registry.js 亦无需为刷新器做静态注册——registry import 插件模块时,插件
// 模块顶层的 registerRefresher 即生效。
//
// 状态机(globalThis 单例,防 dev 热重载丢状态;ver 不符即丢弃可重建部分,
// 常驻定时器/started 沿用——旧定时器闭包操作的仍是同一个共享 G,重挂定时器
// 反而会加倍轮询频率,见 cms/index.js 同款说明)。
// ============================================================

const STATE_VER = 1;                     // 模块版本号:调度行为变更时 +1(热重载守卫)
const CYCLE_MS = 5 * 60 * 1000;          // 周期轮间隔(5 分钟)
const URGENT_COOLDOWN_MS = 60 * 1000;    // 单站 urgent 触发冷却(60 秒)

const G = (globalThis.__moontentDomainRefresh ||= {
  refreshers: new Map(),  // siteId → 刷新函数(插件模块加载时注册)
  inFlight: new Map(),    // siteId → 在途 Promise(同站并发触发共享,绝不叠加)
  urgentAt: new Map(),    // siteId → 上次 urgent 触发时间戳(冷却判据)
  cycleBusy: false,       // 周期轮重入守卫
  started: false,         // startDomainRefreshCycle 幂等守卫
  timerSet: false,        // 常驻定时器只挂一次
  ver: 0,
});
if (G.ver !== STATE_VER) {
  // 版本不符:丢弃可重建部分(注册表/在途/冷却),由新模块图重新注册;
  // started/timerSet 保留,防止旧定时器之外再叠一个新定时器(双倍频率)
  G.refreshers = new Map();
  G.inFlight = new Map();
  G.urgentAt = new Map();
  G.cycleBusy = false;
  G.ver = STATE_VER;
}

// 插件注册刷新函数:同 id 重复注册以后者为准(dev 热重载后插件模块重新
// import,会以新闭包覆盖旧闭包)
export function registerRefresher(siteId, fn) {
  if (typeof siteId !== 'string' || !siteId || typeof fn !== 'function') return;
  G.refreshers.set(siteId, fn);
}

// 单站刷新执行(在途去重:周期轮与 urgent 交叉触发时共享同一 Promise,同站
// 绝不并发跑两份发现链);刷新函数任何异常都按 {changed:false} 吞掉(fail-soft)
function runExclusive(siteId) {
  const hit = G.inFlight.get(siteId);
  if (hit) return hit;
  const p = (async () => {
    const fn = G.refreshers.get(siteId);
    if (typeof fn !== 'function') return { changed: false };
    try {
      const r = await fn();
      return { changed: !!(r && r.changed) };
    } catch (e) {
      return { changed: false }; // 刷新函数抛错=未变更(旧基址仍在插件内,错误不外泄)
    }
  })();
  const wrapped = p.finally(() => { if (G.inFlight.get(siteId) === wrapped) G.inFlight.delete(siteId); });
  G.inFlight.set(siteId, wrapped);
  return wrapped;
}

// 周期轮:全部已注册站点【串行】刷新(快照迭代,注册表并发变更不影响本轮);
// cycleBusy 重入守卫——上一轮未跑完时定时器再触发直接跳过
async function cycle() {
  if (G.cycleBusy) return;
  G.cycleBusy = true;
  try {
    for (const siteId of [...G.refreshers.keys()]) {
      await runExclusive(siteId); // 串行执行,防请求风暴(仓库铁律)
    }
  } finally {
    G.cycleBusy = false;
  }
}

// urgent 触发口(用户请求失败路径调用):单站 60 秒冷却;在途共享同一 Promise;
// 未接入站点直接回 {changed:false}。返回 { changed:boolean }
export async function requestUrgentRefresh(siteId) {
  if (!G.refreshers.has(siteId)) return { changed: false }; // 未接入站点:无事可刷
  if (G.inFlight.has(siteId)) return G.inFlight.get(siteId); // 在途:直接共享结果
  const last = G.urgentAt.get(siteId) || 0;
  if (Date.now() - last < URGENT_COOLDOWN_MS) return { changed: false }; // 冷却期内不重复打上游
  G.urgentAt.set(siteId, Date.now());
  return runExclusive(siteId);
}

// 启动周期轮(幂等):首轮 fire-and-forget + 5 分钟常驻定时器(unref,不阻止
// 进程退出);由 GET /api/sites 的 warmAll() 旁边调用,对齐 cms/index.js 的
// 访问驱动启动范式——无需独立启动钩子
export function startDomainRefreshCycle() {
  if (G.started) return;
  G.started = true;
  cycle().catch(() => { /* 首轮失败静默(fail-soft):下轮定时器再试 */ });
  if (!G.timerSet) {
    G.timerSet = true;
    const t = setInterval(() => cycle().catch(() => {}), CYCLE_MS);
    if (t.unref) t.unref(); // 不阻止进程退出
  }
}
