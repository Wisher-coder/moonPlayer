// ============================================================================
// stream-gate.js —— 看板并发活跃流闸门(web/native 共用同一模块,零平台 API)
// ----------------------------------------------------------------------------
// 服务端可经 /api/sites 的 telegram 条目下发 streamSlots(number,并发活跃流
// 上限;缺省/非法回落 16 = 看板格子上限 WALL_MAX)。上限 ≥ 格子数时闸门永不
// 排队——acquire 同步直通(整型比较 + 计数,不建 Promise 不进队列,零开销),
// 「默认 16 = 闸门关闭」,行为与无闸门完全一致;上限 < 格子数才真正约束:
// 超额格子 FIFO 排队,「移除 / 错误烧穿 / 看板关闭」释放闸位后队首依序复活。
// 接线:site-context 在站点清单到达时 setStreamLimit(streamSlots);WallTile
// 两端(.web.js / .js)在「挂流」前 acquireStream 过闸(web 是 v.src /
// hls.loadSource,native 是 setSrc 驱动 useVideoPlayer),effect cleanup /
// 失败出口 release。
// API:
//   setStreamLimit(n)     —— 喂上限(放宽时立即放行队首;收紧不回收已发 slots,
//                            只约束后续 acquire);
//   acquireStream()       —— 返回 { wait, release }:
//                              wait: Promise|null(null = 已直通零开销;非 null =
//                                    FIFO 排队中,resolve 后才可挂流);
//                              release(): 幂等。持位中 → 让位并放行队首;
//                                    排队中 → 撤队(挂流前的等待作废);
//   isStreamGateBinding() —— 上限是否真正构成瓶颈(< WALL_MAX)。WallTile 用它
//                            守卫「看板关闭即休眠、重开按 FIFO 复活」的分支:
//                            默认档恒 false,停车场保活语义分毫不动。
// 纯计数/队列逻辑,无定时器无平台 API,静态导出求值安全。
// ============================================================================
import { WALL_MAX } from '../wall-store.js';

const DEFAULT_LIMIT = WALL_MAX; // 缺省上限 = 格子总数 → 闸门天然全直通(关闭态)

let limit = DEFAULT_LIMIT;
let active = 0;         // 当前持位数(= 并发活跃流数口径)
const queue = [];       // FIFO 等待者({ resolve, released })

// 放行:只要还有空位就依序唤醒队首(撤队的项在 release 时已摘除)
function drain() {
  while (active < limit && queue.length) {
    const w = queue.shift();
    active += 1;
    w.resolve();
  }
}

// 喂上限:非有限数/小于 1 一律回落缺省;放宽时立即放行能放行的排队者
export function setStreamLimit(n) {
  const v = typeof n === 'number' && isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_LIMIT;
  if (v === limit) return;
  const widened = v > limit;
  limit = v;
  if (widened) drain();
}

// 闸门是否真正构成瓶颈(< 格子数):WallTile 的开合联动分支守卫
export function isStreamGateBinding() {
  return limit < DEFAULT_LIMIT;
}

// 过闸:上限内同步直通(wait=null);超额 FIFO 排队(await wait 复活)。
// release 幂等且双态安全:排队中撤队不占位,持位中让位并放行队首
export function acquireStream() {
  if (active < limit) {
    active += 1;
    let done = false;
    return {
      wait: null,
      release() {
        if (done) return;
        done = true;
        active -= 1;
        drain();
      },
    };
  }
  const w = { resolve: null, released: false };
  const wait = new Promise((res) => { w.resolve = res; });
  queue.push(w);
  return {
    wait,
    release() {
      if (w.released) return;
      w.released = true;
      const i = queue.indexOf(w);
      if (i >= 0) {
        queue.splice(i, 1); // 还在排队:撤队即可(从未占位)
      } else {
        active -= 1; // 已持位(wait 已 resolve):让位并放行队首
        drain();
      }
    },
  };
}
