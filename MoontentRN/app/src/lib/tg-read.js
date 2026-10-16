// ============================================================================
// tg-read.js —— Telegram 聊天本地阅读位置(AsyncStorage,按对话键隔离)
// ----------------------------------------------------------------------------
// 契约(两个导出):
//   getReadPos(peerKey)        → Promise<number>:该对话最后阅读到的消息 id,
//                                无记录 / peerKey 为空 / 存储损坏一律回 0(调用
//                                方据此走「最新页 / peer.readInboxMaxId」兜底链);
//   setReadPos(peerKey, msgId) → Promise<void>:覆盖写(msgId<=0 或 peerKey 为空
//                                静默忽略,阅读位置只存有效消息 id)。
// 键 moontent_tg_read,形态 { "<peerKey>": { msgId, at } }:
//   · peerKey 形如 c*/g*/u*/saved(服务端归一化对话键,前后端共享契约);
//   · msgId   最后阅读位置的消息 id——本层只做覆盖写,「只进不退」由调用方
//             保证(use-chat-timeline 的 onVisible 游标单调递增后才落盘),
//             与 history.js 播放进度同款的责任边界;
//   · at      写入时间戳,仅用于超上限时淘汰排序(活跃对话留驻)。
// 上限保留最近 200 个对话,超出按 at 淘汰最旧——照抄 history.js saveProgress
// 的淘汰口径。读-改-写全部经模块级串行链排队(同 enqueue 模式):聊天页
// onVisible 节流写与卸载兜底 flush 并发是常态,防并发丢更新。
// 纯本地数据,不上传、不同步;存储不可用时读写均静默降级(读回 0 / 写跳过)。
// ============================================================================
import AsyncStorage from '@react-native-async-storage/async-storage';

const READ_KEY = 'moontent_tg_read';
const READ_MAX = 200; // 最多保留的对话数,超出按 at 淘汰最旧

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

// 取某对话的最后阅读消息 id:防御式归一为正整数,脏数据(负数/NaN/字符串)
// 一律视同未读回 0
export async function getReadPos(peerKey) {
  if (!peerKey) return 0;
  const map = await readJSON(READ_KEY, {});
  const r = map && typeof map === 'object' ? map[String(peerKey)] : null;
  const n = r ? Math.floor(Number(r.msgId)) || 0 : 0;
  return n > 0 ? n : 0;
}

// 写某对话的最后阅读消息 id:覆盖写 + 刷新 at(活跃对话免被淘汰);条目超
// 上限时按 at 升序淘汰最旧的对话。整个读-改-写在串行链上单任务完成。
export function setReadPos(peerKey, msgId) {
  return enqueue(async () => {
    const pk = String(peerKey || '');
    const n = Math.floor(Number(msgId)) || 0;
    if (!pk || n <= 0) return;
    const map = await readJSON(READ_KEY, {});
    if (!map || typeof map !== 'object') return;
    map[pk] = { msgId: n, at: Date.now() };
    const keys = Object.keys(map);
    if (keys.length > READ_MAX) {
      keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0));
      for (const k of keys.slice(0, keys.length - READ_MAX)) delete map[k];
    }
    await writeJSON(READ_KEY, map);
  });
}
