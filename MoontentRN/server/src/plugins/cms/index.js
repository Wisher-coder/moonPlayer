// ============================================================
// index.js —— 资源站插件群入口:buildCmsPlugins() 返回【插件数组】(仅 Node 服务端)
//
// 与传统插件(一文件一实例、registry 静态注册一行)不同:本模块按资源族清单
// 批量生产 SitePlugin 实例,registry 以 await 异步合并(静态 9 站仍同步命中)。
//
// 状态机(globalThis 单例,防 dev 热重载丢状态):
//   冷启动:磁盘缓存/内置快照【立即注册全部站点,全程不等网络】→ 同步后台
//   启动 cycle(拉最新清单 + 全量健康探测)→ 完成后死站退出 /api/sites、
//   活站复位(先注册后收敛,/api/sites 秒级可用);
//   此后:清单 12h TTL 重拉(api 不变的站保留原插件实例,缓存不丢)、
//   探测结果 30min TTL 重探(已摘除站每轮必重探,这是恢复通道);
//   运行时:单站上游连续 2 次失败即时摘除,下次成功触发单站复探提前恢复;
//   另挂 10 分钟 unref 定时器,无访问流量也自动续期探测。
// ============================================================
import { makeCmsPlugin, hostOf, slugify } from './plugin.js';
import {
  loadSeed, saveDisk, fetchSourcesFresh, validateEntries, sortEntries,
  probeEntry, runPool, REFRESH_TTL_MS, PROBE_TTL_MS, PROBE_CONCURRENCY,
} from './source.js';

const RUNTIME_FAIL_LIMIT = 2;  // 运行时连续失败 N 次即时摘除
const CYCLE_TIMER_MS = 10 * 60 * 1000;
// 模块版本号:插件类行为变更时 +1(如剧集 id 分隔符调整)。dev 热重载后
// globalThis 单例会延续,但其中的旧实例仍是旧类——版本不符即丢弃插件层
// (entries/health/down 探测与摘除态保留),下次访问按当前类重建。
// 4 = 上游抓取层 upstream.js(盾站过盾/XML 站 RSS/协议降级)+ 裸地址 vod_play_url
const STATE_VER = 4;

const G = (globalThis.__moontentCms ||= {
  inited: false, initing: null,
  entries: [],            // 当前生效清单(已排序)
  fetchedAt: 0,           // 清单拉取时间(0 = 尚未在线拉过,快照态)
  byId: new Map(),        // id → CmsPlugin
  idByApi: new Map(),     // api → id(id 派生自查表)
  meta: [],               // [{id, name, capabilities, group:'cms'}](与 entries 同序)
  health: new Map(),      // api → {ok, at} 探测结果
  down: new Set(),        // 当前摘除站点(探测死 / 运行时连败)
  runtimeFails: new Map(),// id → 连败计数
  lastProbeAt: 0,
  cycleBusy: false, timerSet: false,
  ver: 0,
});
if (G.ver !== STATE_VER) {
  G.byId = new Map();
  G.idByApi = new Map();
  G.meta = [];
  G.inited = false;
  G.initing = null;
  G.ver = STATE_VER;
}

// ============ 初始化(只读磁盘/内置快照,不碰网络) ============

async function ensureInit() {
  if (G.inited && G.byId.size) return;
  if (!G.initing) {
    G.initing = (async () => {
      if (!G.entries.length) {
        const seed = await loadSeed();
        G.entries = seed.entries;
        G.fetchedAt = seed.fetchedAt;
      }
      rebuild(G.entries);
      G.inited = true;
      cycle().catch(() => { /* 后台任务失败不外泄 */ });
      if (!G.timerSet) {
        G.timerSet = true;
        const t = setInterval(() => cycle().catch(() => {}), CYCLE_TIMER_MS);
        if (t.unref) t.unref(); // 不阻止进程退出
      }
    })();
  }
  await G.initing;
}

// 清单 → 插件数组重建:api 不变的站沿用原实例(raw/清单缓存、失败计数不丢);
// id = zy_ + api 主机 slug,同主机多 api 加 -2/-3 序号(迭代顺序稳定 → 序号稳定)
function rebuild(entries) {
  const prevByApi = new Map();
  for (const p of G.byId.values()) prevByApi.set(p.api, p);
  const byId = new Map();
  const idByApi = new Map();
  for (const e of entries) {
    const base = 'zy_' + slugify(hostOf(e.api));
    let id = base; let n = 2;
    while (byId.has(id)) id = base + '-' + n++;
    const p = prevByApi.get(e.api) || makeCmsPlugin(e, id, { markSuccess, markFailure });
    byId.set(id, p);
    idByApi.set(e.api, id);
  }
  G.byId = byId;
  G.idByApi = idByApi;
  G.meta = entries.map((e) => {
    const id = idByApi.get(e.api);
    const p = byId.get(id);
    return { id, name: p.name, capabilities: p.capabilities, group: 'cms' };
  });
}

// ============ 后台周期:清单刷新 + 健康探测(永不抛出) ============

async function cycle() {
  if (!G.inited || G.cycleBusy) return;
  G.cycleBusy = true;
  try {
    // ① 清单刷新(12h TTL;失败沿用旧清单等下轮)
    if (!G.fetchedAt || Date.now() - G.fetchedAt > REFRESH_TTL_MS) {
      try {
        const fresh = await fetchSourcesFresh();
        const entries = sortEntries(validateEntries(fresh));
        if (entries.length) {
          G.entries = entries;
          G.fetchedAt = Date.now();
          rebuild(entries);
          await saveDisk(entries, G.fetchedAt);
        }
      } catch (e) { /* 清单拉取失败:沿用旧清单 */ }
    }
    // ② 健康探测:未探过 / 结果过期 / 已摘除(恢复通道)的站
    const now = Date.now();
    const need = G.entries.filter((e) => {
      const h = G.health.get(e.api);
      if (!h || now - h.at > PROBE_TTL_MS) return true;
      const id = G.idByApi.get(e.api);
      return id && G.down.has(id);
    });
    if (need.length) {
      await runPool(need, PROBE_CONCURRENCY, async (e) => {
        G.health.set(e.api, { ok: await probeEntry(e), at: Date.now() });
      });
      G.lastProbeAt = Date.now();
    }
    // ③ 应用探测结果:活站复位(清运行时计数),死站摘除
    for (const e of G.entries) {
      const h = G.health.get(e.api);
      const id = G.idByApi.get(e.api);
      if (!h || !id) continue;
      if (h.ok) { G.down.delete(id); G.runtimeFails.delete(id); }
      else G.down.add(id);
    }
  } finally {
    G.cycleBusy = false;
  }
}

// 访问驱动的轻量触发:清单/探测过期就后台补一轮(fire-and-forget,不阻塞请求)
function maybeCycle() {
  const now = Date.now();
  if (G.cycleBusy) return;
  if ((!G.fetchedAt || now - G.fetchedAt > REFRESH_TTL_MS) || now - G.lastProbeAt > PROBE_TTL_MS) {
    cycle().catch(() => {});
  }
}

// ============ 对外接口 ============

// 【返回插件数组】当前健康站点的插件实例(registry 动态合并用)
export async function buildCmsPlugins() {
  await ensureInit();
  maybeCycle();
  return [...G.byId.entries()].filter(([id]) => !G.down.has(id)).map(([, p]) => p);
}

// 站点元数据(GET /api/sites 的 CMS 增量,已剔除摘除站)
export async function cmsSitesMeta() {
  await ensureInit();
  maybeCycle();
  return G.meta.filter((m) => !G.down.has(m.id));
}

// 按 id 取插件(摘除站也返回:在播/深链请求不中断,只是不再列入站点清单)
export async function findCmsPlugin(id) {
  await ensureInit();
  return G.byId.get(id) || null;
}

// —— 运行时健康上报(plugin.js 失败计数达阈值/成功时回调) ——

function markFailure(id) {
  const n = (G.runtimeFails.get(id) || 0) + 1;
  G.runtimeFails.set(id, n);
  if (n >= RUNTIME_FAIL_LIMIT) G.down.add(id);
}

function markSuccess(id) {
  G.runtimeFails.delete(id);
  if (G.down.has(id)) {
    // 摘除态出现成功请求:单站复探,通过即提前恢复(不等 30min 周期)
    const p = G.byId.get(id);
    if (!p) return;
    probeEntry(p.entry)
      .then((ok) => { if (ok) { G.down.delete(id); G.health.set(p.api, { ok: true, at: Date.now() }); } })
      .catch(() => {});
  }
}
