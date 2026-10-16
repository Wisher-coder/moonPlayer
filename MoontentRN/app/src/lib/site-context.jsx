// ============================================================================
// site-context.jsx —— 站点上下文（当前数据源插件 + 站源插件加载态，全站请求随之切换）
// ----------------------------------------------------------------------------
// 契约：SiteProvider；useSite() → { site, sites, visibleSites, loadedIds,
// setSite, setPluginLoaded, setManyLoaded, refreshSites }（另附 caps 能力元数据
// 与 ready 水合标志，超集导出）。
// 站源插件化（纯前端实现，服务端零改动）：
//   · GET /api/sites 恒返回全量目录（10 主站 + cms 资源站群 zy_ 前缀），本层在
//     其上叠一份「已加载」集合：AsyncStorage 键 'moontent_plugins'（id JSON
//     数组，无记录默认仅光速资源站 zy_api_guangsuapi_com）。visibleSites =
//     全量 ∩ 已加载（保持目录顺序），Guide 片源区等切站入口只见已加载站。
//   · 卸载只是清单层面的摘除，运行时接口 /api/{site}/* 不受影响——历史记录/
//     深链对未加载站照常可播；sites 也为此保持全量，video/author 深链页与
//     SiteAvatar 按 id 查能力/站名的逻辑零回归。
//   · setPluginLoaded(id,on) 单站加载/卸载；setManyLoaded(ids,on) 批量启停
//     （插件管理页 /plugins 的 CMS 父开关一键全启用/全卸载用）。两者共同守卫
//     「至少保留一个已加载站源」（拒绝并返回 {ok:false,reason}，调用方据此
//     toast）；卸载当前在用站时自动切换到剩余第一个已加载站（不切会把全站
//     请求留在已卸载源上），返回 {ok:true,switchedTo?} 供调用方提示。
//   · 水合安全网：site 与 loadedIds 均恢复后、以及真实清单到位后，若当前站
//     不在可见清单（旧安装恢复出 yuese 这类未加载站）→ 自动切到第一个可见
//     站并持久化；可见清单为空（离线且已加载集合不在兜底内）时不动作，等
//     真实清单到位再校验。
//   · refreshSites()：重拉全量清单（服务器地址切换后由「我的」页调用；失败
//     沿用当前清单）。
// 持久化：AsyncStorage 键 'moontent_site'（当前站）与 'moontent_plugins'
// （已加载 id 数组）。sites 元数据优先读 GET /api/sites（client.getSites），
// 失败时退回内置兜底清单（首屏不等待网络；兜底含默认站光速，离线首屏的
// 片源形态也正确）；id 校验允许数字开头（91pron 这类源名即 id）；兜底清单
// 只是首屏元数据，注册表站点（bf/dsd/llw/zimuquan/91pron/资源站群…）不在
// 其中，不能拿它当恢复白名单，否则刷新即跌回月色——水合安全网只在「已加载
// 集合」口径上校验，不做目录白名单。
// value 必须缓存（全站网格里每张卡都可能取上下文，Provider 每次渲染造新
// 对象会让所有消费组件整片重渲染）；deps 覆盖全部真实依赖即可（caps 由
// sites+site 派生，不需要单列）。
// ============================================================================
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSites } from './client.js';
import { getApiBase } from './api-base.js';
import { applyShardConfig } from './origin-pool.js';
import { setStreamLimit } from './wall/stream-gate.js';

const KEY = 'moontent_site';
const PLUGINS_KEY = 'moontent_plugins';

// 捕获 telegram 条目的分片配置并喂数:/api/sites 里 id==='telegram' 的条目可带
// 可选字段 shardPorts: number[](媒体 origin 分片池,主端口在前)与
// streamSlots: number(看板并发活跃流上限)。字段缺失 = 旧服务端,喂
// undefined → origin-pool 回落「未启用」、stream-gate 回落缺省 16,零行为
// 变化。清单每次到位(挂载首拉 / refreshSites)都用当前基址重喂(调用方以
// 请求发起时的基址快照守卫在途竞态,基址已变则跳过喂料);切基址时
// client.resetClientCache 已先清池,重喂即用新基址重建(池绝不跨基址残留)
function feedShardConfig(list) {
  const tg = Array.isArray(list) ? list.find((s) => s && s.id === 'telegram') : null;
  applyShardConfig(getApiBase(), tg ? tg.shardPorts : undefined);
  setStreamLimit(tg ? tg.streamSlots : undefined);
}

// 默认站与默认已加载集合：仅光速资源站（id = zy_ + api.guangsuapi.com 主机 slug，
// 与服务端 cms 插件 id 派生规则一致）
const DEFAULT_SITE = 'zy_api_guangsuapi_com';
const DEFAULT_LOADED = [DEFAULT_SITE];
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

// 与服务端插件注册表保持同构的兜底清单（接口失败/未就绪时用；group 语义同 /api/sites；
// 末位光速 = 默认已加载站，离线/接口失败时首屏片源形态依旧正确）
const FALLBACK_SITES = [
  { id: 'yuese', name: '月色', group: 'main', capabilities: { home: true, hotwords: true, tags: true, dvds: true, bytag: true, sort: true } },
  { id: 'avjb', name: '艾薇社区', group: 'main', capabilities: { home: false, hotwords: false, tags: false, dvds: false, bytag: false, sort: false, author: true, albums: true } },
  { id: 'aidou', name: '爱豆', group: 'main', capabilities: { home: true, hotwords: true, tags: false, dvds: false, bytag: true, sort: true } },
  { id: 'hanxiucao', name: '含羞草', group: 'main', capabilities: { home: false, boards: true, hotwords: true, tags: false, dvds: false, bytag: false, sort: true } },
  { id: 'zy_api_guangsuapi_com', name: '光速资源站', group: 'cms', capabilities: { home: false, hotwords: false, tags: false, dvds: false, bytag: false, sort: false, cms: true } },
];

// 原生 context 一并导出：需要「Provider 缺席不抛错」防御式读取的消费方
//（如 SiteAvatar）用它 + useContext 直读替代 useSite() 的 try/catch 包裹——
// 钩子一旦进 try/catch 即成条件调用（rules-of-hooks），useContext 永不抛错
export const SiteContext = createContext(null);

export function SiteProvider({ children }) {
  const [site, setSiteState] = useState(DEFAULT_SITE);
  const [sites, setSites] = useState(FALLBACK_SITES);
  const [loadedIds, setLoadedIdsState] = useState(DEFAULT_LOADED);
  const [ready, setReady] = useState(false); // 本机站点+插件加载态恢复完成后才放行页面取数

  // 挂载：恢复本机选择的站点与已加载插件集合 + 刷新插件元数据（能力驱动页面自适应渲染）
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [v, plug] = await Promise.all([
          AsyncStorage.getItem(KEY),
          AsyncStorage.getItem(PLUGINS_KEY),
        ]);
        if (v && ID_RE.test(v)) setSiteState(v);
        // 已加载集合：非法 JSON / 非数组 / 空数组一律按无记录回默认（仅光速）；
        // id 逐个形态校验防脏数据进清单
        let ids = null;
        try { ids = JSON.parse(plug); } catch (_e) { /* 按无记录处理 */ }
        if (Array.isArray(ids) && ids.length) {
          const clean = [...new Set(ids.filter((x) => typeof x === 'string' && ID_RE.test(x)))];
          if (clean.length) setLoadedIdsState(clean);
        }
      } catch (_e) { /* 存储不可用：用默认站与默认加载集合 */ }
      setReady(true);
      // 基址快照:响应返回后校验一致才喂分片配置——in-flight 期间切过基址的
      // 话,「新基址 + 旧清单 shardPorts」会建出指向新服务器未监听端口的
      // origin 池(resetClientCache 已清池,守住清零态即可;setSites 维持既有
      // 行为不动)
      const baseAt = getApiBase();
      try {
        const list = await getSites();
        if (alive && Array.isArray(list) && list.length) {
          if (getApiBase() === baseAt) feedShardConfig(list); // 分片配置随清单到位(缺字段=旧服务端,各自回落)
          setSites(list);
        }
      } catch (_e) { /* 元数据失败：沿用兜底清单 */ }
    })();
    return () => { alive = false; };
  }, []);

  // 水合安全网：当前站不在可见清单（旧安装恢复出未加载站 / 卸载当前站的边角）
  // → 自动切到第一个可见站并持久化；ready 前不动作（集合还没恢复完）
  useEffect(() => {
    if (!ready) return;
    if (loadedIds.includes(site) && sites.some((s) => s && s.id === site)) return;
    const first = sites.find((s) => s && loadedIds.includes(s.id));
    if (!first || first.id === site) return;
    setSiteState(first.id);
    AsyncStorage.setItem(KEY, first.id).catch(() => { /* 忽略 */ });
  }, [ready, sites, loadedIds, site]);

  // 切站：更新上下文（全站请求随之切换）+ 持久化（存不进就当会话级切换）
  const setSite = useCallback((id) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) return;
    setSiteState(id);
    AsyncStorage.setItem(KEY, id).catch(() => { /* 忽略 */ });
  }, []);

  // 应用新的已加载集合：更新上下文 + 持久化 + 卸载当前站时自动切换；
  // 返回 {ok:true,switchedTo?} 供调用方 toast（存不进只降级为会话级）
  const commitLoaded = useCallback((next, dropped) => {
    setLoadedIdsState(next);
    AsyncStorage.setItem(PLUGINS_KEY, JSON.stringify(next)).catch(() => { /* 忽略 */ });
    if (dropped.has(site)) {
      const remain = sites.find((s) => s && next.includes(s.id));
      if (remain) {
        setSiteState(remain.id);
        AsyncStorage.setItem(KEY, remain.id).catch(() => { /* 忽略 */ });
        return { ok: true, switchedTo: remain };
      }
    }
    return { ok: true };
  }, [site, sites]);

  // 单站加载/卸载（插件管理页逐行开关用）；幂等调用直接成功返回
  const setPluginLoaded = useCallback((id, on) => {
    if (typeof id !== 'string' || !id) return { ok: false, reason: '站点 id 无效' };
    const has = loadedIds.includes(id);
    if (on === has) return { ok: true };
    if (on) return commitLoaded([...loadedIds, id], new Set());
    const next = loadedIds.filter((x) => x !== id);
    if (!next.length) return { ok: false, reason: '至少保留一个已加载站源' };
    return commitLoaded(next, new Set([id]));
  }, [loadedIds, commitLoaded]);

  // 批量加载/卸载（插件管理页 CMS 父开关一键全启用/全卸载用）；幂等同上
  const setManyLoaded = useCallback((ids, on) => {
    const batch = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && !!x);
    if (!batch.length) return { ok: true };
    if (on) {
      const cur = new Set(loadedIds);
      for (const x of batch) cur.add(x);
      if (cur.size === loadedIds.length) return { ok: true };
      return commitLoaded([...cur], new Set());
    }
    const drop = new Set(batch);
    const next = loadedIds.filter((x) => !drop.has(x));
    if (next.length === loadedIds.length) return { ok: true };
    if (!next.length) return { ok: false, reason: '至少保留一个已加载站源' };
    return commitLoaded(next, drop);
  }, [loadedIds, commitLoaded]);

  // 重拉站点清单（服务器地址切换后由「我的」页调用；失败沿用当前清单）
  const refreshSites = useCallback(() => {
    const baseAt = getApiBase(); // 同挂载首拉:在途响应与切基址的喂料竞态守卫
    getSites()
      .then((list) => {
        if (Array.isArray(list) && list.length) {
          if (getApiBase() === baseAt) feedShardConfig(list); // 基址未变才喂:用当前基址重建分片池/闸门上限
          setSites(list);
        }
      })
      .catch(() => { /* 忽略：沿用当前清单 */ });
  }, []);

  // 当前站点能力元数据（无匹配站点时空对象，消费方按「无此能力」渲染）；
  // 按全量清单查——深链/历史进入未加载站时详情页仍拿得到正确能力表
  const caps = (sites.find((s) => s && s.id === site) || {}).capabilities || {};

  // 已加载集合（查询用 Set）+ 可见站点清单（Guide 片源区等切站入口的消费口径）
  const loadedSet = useMemo(() => new Set(loadedIds), [loadedIds]);
  const visibleSites = useMemo(() => sites.filter((s) => s && loadedSet.has(s.id)), [sites, loadedSet]);

  const value = useMemo(
    () => ({ site, sites, visibleSites, loadedIds, setSite, setPluginLoaded, setManyLoaded, refreshSites, caps, ready }),
    [site, sites, visibleSites, loadedIds, setSite, setPluginLoaded, setManyLoaded, refreshSites, caps, ready]
  );

  return (
    <SiteContext.Provider value={value}>
      {children}
    </SiteContext.Provider>
  );
}

export function useSite() {
  const ctx = useContext(SiteContext);
  if (!ctx) throw new Error('useSite 必须在 SiteProvider 内使用');
  return ctx;
}
