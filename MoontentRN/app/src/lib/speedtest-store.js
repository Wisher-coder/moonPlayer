// ============================================================================
// speedtest-store.js —— 站源测速结果持久化(AsyncStorage,照 history.js 的
// readJSON/writeJSON + enqueue 串行写范式)
// ----------------------------------------------------------------------------
// 键语义:
//   moontent_speedtest  测速结果 map:{ "{siteId}": { apiMs, imgMs, mbps,
//                       at, err } }(at 为完成时间戳;数值字段失败为
//                       null)。纯本地数据,不上传、不同步;站点数有限
//                       (主站 9 + 资源站 ~80),不做淘汰上限。
// 契约:getSpeedResults() 读取全量 map;saveSpeedResult(siteId, result)
// 读改写单条(经模块级串行链排队,防「全部测速」逐行落盘并发丢更新)。
// ============================================================================
import AsyncStorage from '@react-native-async-storage/async-storage';

const SPEEDTEST_KEY = 'moontent_speedtest';

// 读-改-写串行链:任务排队执行,返回各自的 Promise;链上异常吞掉不断链
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
    return fallback; // 旧数据损坏:当不存在,重建
  }
}

async function writeJSON(key, v) {
  try { await AsyncStorage.setItem(key, JSON.stringify(v)); } catch (_e) { /* 存储不可用:跳过 */ }
}

// 读全量测速结果:{ siteId → { apiMs, imgMs, mbps, at, err } }
// (可播指标已移除;旧记录里可能残留 readyMs/readyStage 字段,消费方不再读取)
export async function getSpeedResults() {
  const v = await readJSON(SPEEDTEST_KEY, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// 落单条测速结果(读改写,串行排队)
export function saveSpeedResult(siteId, result) {
  return enqueue(async () => {
    if (!siteId || !result || typeof result !== 'object') return;
    const map = await readJSON(SPEEDTEST_KEY, {});
    if (!map || typeof map !== 'object' || Array.isArray(map)) return;
    map[String(siteId)] = result;
    await writeJSON(SPEEDTEST_KEY, map);
  });
}
