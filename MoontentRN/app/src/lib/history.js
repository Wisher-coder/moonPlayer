// ============================================================================
// history.js —— 本地观看足迹 + 播放进度 + 搜索历史（AsyncStorage，按站点隔离）
// ----------------------------------------------------------------------------
// 契约：recordView / getViews / clearViews / saveProgress / getProgress /
//       addSearch / getSearches（另附 removeView / removeProgress /
//       clearSearches 超集导出，「我的」页管理等场景用）。
// 键语义同 NextWeb README「本地数据边界」：
//   moontent_views          观看足迹，上限 50，条目 {site,id,title,cover,duration,hd,at,
//                           多集片另带 ep(集号,1 起)}——条目恒按「片」归档(裸 vid)，
//                           传入 id 形如 vid-epN 时由 splitEpId 归一,一部剧一条不刷屏
//   moontent_progress       播放进度（续播），形态 { "{site}:{id}": {t,d,at} }，上限 200；
//                           资源站多集片会话 id 为 vid-epN → 进度天然按集存取
//   moontent_lastep         集数档案（资源站多集片「最后播放到第几集」），形态
//                           { "{site}:{vid}": {ep,at} }，上限 200；裸 vid 进入观看页时
//                           据此直达 vid-epN 续播（recordView 带 ep 时同步落盘）
//   moontent_search_{site}  搜索历史（字符串数组，去重置前、上限 10）
// 全部为纯本地数据，不上传、不同步。
// RN 化差异：
//   ① AsyncStorage 异步 → 全部函数返回 Promise；
//   ② 读改写操作（足迹去重插入/进度淘汰/历史去重置前）经模块级串行链排队，
//     防并发丢更新（播放器高频 saveProgress 与 recordView 并发是常态）；
//   ③ 封面读取时统一经 absolutizeUrl 绝对化（存储保留当时的原始地址，
//     换基址后历史也能正确显示）。
// ============================================================================
import AsyncStorage from '@react-native-async-storage/async-storage';
import { absolutizeUrl } from './client.js';

const VIEWS_KEY = 'moontent_views';
const PROGRESS_KEY = 'moontent_progress';
const LASTEP_KEY = 'moontent_lastep';
const SEARCH_KEY = (site) => 'moontent_search_' + site;
const VIEWS_MAX = 50;
const PROGRESS_MAX = 200;
const LASTEP_MAX = 200;
const SEARCH_MAX = 10;

// 读-改-写串行链：任务排队执行，返回各自的 Promise；链上异常吞掉不断链
let chain = Promise.resolve();
function enqueue(task) {
  const run = chain.then(task, task); // 前序失败也要继续跑后续任务
  chain = run.then(() => {}, () => {});
  return run;
}

async function readJSON(key, fallback) {
  try {
    const v = await AsyncStorage.getItem(key);
    if (v == null) return fallback;
    const j = JSON.parse(v);
    return j == null ? fallback : j;
  } catch (_e) {
    return fallback; // 旧数据损坏：当不存在，重建
  }
}

async function writeJSON(key, v) {
  try { await AsyncStorage.setItem(key, JSON.stringify(v)); } catch (_e) { /* 存储不可用：跳过 */ }
}

// 资源站合成集 id 拆解：vid-epN（'~epN' 为服务端兼容的旧同义形态）→ {vid, ep}；
// 与服务端 cms/plugin.js 的 parseVid 同义镜像。非资源站 id（mongoid/纯数字等）
// 不含该形态不命中，天然不受影响。观看页归一化与 recordView 归档共用。
export function splitEpId(id) {
  const m = String(id == null ? '' : id).match(/^(.+)[~-]ep(\d+)$/);
  return m ? { vid: m[1], ep: parseInt(m[2], 10) || 1 } : null;
}

// ===== 观看足迹 =====
// 记一条足迹：去重置前（同 site+片 id 的旧条目剔除）、盖上时间戳、截上限。
// 传入 id 形如 vid-epN（资源站在播会话 id）时按「片」归档：条目 id 存裸 vid、
// 集号存 ep 字段——一部剧始终一条记录，集与集之间互相去重置前；同时把
// 「site:vid → 最后播放集」落入集数档案（裸 vid 再进观看页时据此直达续播）。
// 两笔写在同一串行任务内完成，与进度落盘共用一条队列防并发丢更新。
export function recordView(site, item) {
  return enqueue(async () => {
    if (!site || !item || item.id == null) return;
    const se = splitEpId(item.id);
    const vid = se ? se.vid : String(item.id);
    const prev = await readJSON(VIEWS_KEY, []);
    const arr = Array.isArray(prev) ? prev : [];
    const entry = {
      site: String(site),
      id: vid,
      title: item.title || '',
      cover: item.cover || '',
      duration: item.duration ?? null,
      hd: !!item.hd,
      at: Date.now(),
    };
    if (se) entry.ep = se.ep;
    await writeJSON(
      VIEWS_KEY,
      [entry]
        .concat(arr.filter((x) => !(x && x.site === entry.site && String(x.id) === vid)))
        .slice(0, VIEWS_MAX)
    );
    // 集数档案：仅带集号的记录落盘（单集片/他站不产生条目，键空间不被污染）
    if (se) {
      const lep = await readJSON(LASTEP_KEY, {});
      if (lep && typeof lep === 'object') {
        lep[String(site) + ':' + vid] = { ep: se.ep, at: entry.at };
        const keys = Object.keys(lep);
        if (keys.length > LASTEP_MAX) {
          keys.sort((a, b) => (lep[a].at || 0) - (lep[b].at || 0));
          for (const k of keys.slice(0, keys.length - LASTEP_MAX)) delete lep[k];
        }
        await writeJSON(LASTEP_KEY, lep);
      }
    }
  });
}

// 读全部足迹（新的在前）；封面绝对化后返回，图片组件可直接加载
export async function getViews() {
  const v = await readJSON(VIEWS_KEY, []);
  const arr = Array.isArray(v) ? v.filter((x) => x && x.site && x.id != null) : [];
  return arr.map((x) => ({ ...x, cover: absolutizeUrl(x.cover) }));
}

// 删单条足迹（「我的」页历史管理用）
export function removeView(site, id) {
  return enqueue(async () => {
    const cur = await readJSON(VIEWS_KEY, []);
    const arr = Array.isArray(cur) ? cur : [];
    await writeJSON(VIEWS_KEY, arr.filter((x) => !(x && x.site === site && String(x.id) === String(id))));
  });
}

export function clearViews() {
  return enqueue(() => writeJSON(VIEWS_KEY, []));
}

// 取某片的最后播放集号：{ ep, at } | null（观看页裸 vid 进入时归一化用；
// vid 传裸片 id——带 -epN 的形态先自行拆解，本函数不做二次拆解）
export async function getLastEp(site, vid) {
  if (!site || vid == null) return null;
  const map = await readJSON(LASTEP_KEY, {});
  const r = map && map[String(site) + ':' + String(vid)];
  return r && r.ep > 0 ? r : null;
}

// ===== 播放进度（续播）=====
// 形态：{ "{site}:{id}": { t: 秒, d: 总时长, at: 时间戳 } }；超上限按 at 淘汰最旧
export function saveProgress(site, id, t, d) {
  return enqueue(async () => {
    if (!site || id == null || !isFinite(t) || t <= 0) return;
    const map = await readJSON(PROGRESS_KEY, {});
    if (!map || typeof map !== 'object') return;
    map[site + ':' + id] = { t: Math.floor(t), d: isFinite(d) ? Math.floor(d) : 0, at: Date.now() };
    const keys = Object.keys(map);
    if (keys.length > PROGRESS_MAX) {
      keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0));
      for (const k of keys.slice(0, keys.length - PROGRESS_MAX)) delete map[k];
    }
    await writeJSON(PROGRESS_KEY, map);
  });
}

// 取某片进度：{ t, d, at } | null
export async function getProgress(site, id) {
  if (!site || id == null) return null;
  const map = await readJSON(PROGRESS_KEY, {});
  const p = map && map[site + ':' + id];
  return p && isFinite(p.t) ? p : null;
}

// 删单条进度（看完/重播重置用）
export function removeProgress(site, id) {
  return enqueue(async () => {
    const map = await readJSON(PROGRESS_KEY, {});
    if (map && typeof map === 'object') {
      delete map[site + ':' + id];
      await writeJSON(PROGRESS_KEY, map);
    }
  });
}

// ===== 搜索历史（按站点隔离）=====
// 记一条搜索词：去重置前、截上限 10
export function addSearch(site, kw) {
  return enqueue(async () => {
    const k = String(kw || '').trim();
    if (!site || !k) return;
    const key = SEARCH_KEY(site);
    const prev = await readJSON(key, []);
    const arr = (Array.isArray(prev) ? prev : []).filter((x) => typeof x === 'string' && x && x !== k);
    arr.unshift(k);
    await writeJSON(key, arr.slice(0, SEARCH_MAX));
  });
}

// 读搜索历史（新的在前）
export async function getSearches(site) {
  if (!site) return [];
  const a = await readJSON(SEARCH_KEY(site), []);
  return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x) : [];
}

// 清空某站搜索历史
export function clearSearches(site) {
  return enqueue(() => writeJSON(SEARCH_KEY(site), []));
}
