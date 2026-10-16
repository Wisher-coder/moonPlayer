// ============================================================================
// use-playback-progress.js —— 播放进度落盘/续播 hook(包装 history.js)
// ----------------------------------------------------------------------------
// 职责(对齐 NextWeb ArtPlayer 的存档策略):
//   - save(t, d):播放中高频调用(timeupdate 级),内部按「距上次落盘 ≥15s」
//     节流写 AsyncStorage(全量 JSON 读改写,高频落盘在低端机上是周期性卡顿源);
//     每次调用都更新内存快照,保证 flush 时有最新位置;
//   - flush():无视节流立即落盘一次(暂停/播完/关闭/换源兜底用);
//   - restore():读本地进度并做续播价值判定——太靠前(t ≤ 10s)不值得续、
//     已看完(距结尾 ≤ 20s)不续;AsyncStorage 异步读 → 返回
//     Promise<{t,d,at}|null>,调用方 await;
//   - site/id 变化(换源连播)时,先把旧片最后快照落盘再切换(cleanup 闭包
//     冻结旧值,写的一定是旧片);组件卸载同路径兜底。
// 快照存 ref 不存 state:落盘频率与渲染频率解耦,进度回调不会触发重渲染。
// ============================================================================
import { useCallback, useEffect, useRef } from 'react';
import { getProgress, saveProgress } from '../lib/history.js';

// 节流间隔(秒):NextWeb 同值——进度档案是整份 JSON 读改写,5s 一拍在低端机上
// 造成周期性主线程停顿;放宽到 15s,精度由离散事件(暂停/播完/关闭/换源)的
// 即时 flush 兜底
const SAVE_INTERVAL_S = 15;

export function usePlaybackProgress(site, id) {
  // 最新存档快照:{ site, id, t, d }(flush 从这里取,不吃闭包过期)
  const snapRef = useRef({ site: '', id: null, t: 0, d: 0 });
  // 上次落盘的播放位置(节流基准)
  const lastSavedRef = useRef(-999);

  // 无视节流立即落盘:读快照写盘并同步节流基准(防随后一拍进度回调重复写)
  const flush = useCallback(() => {
    const s = snapRef.current;
    if (!s.site || s.id == null || !(s.t > 0)) return;
    lastSavedRef.current = s.t;
    try {
      saveProgress(s.site, s.id, s.t, s.d);
    } catch (_e) {
      /* 本地存储异常不苛求(隐私模式/存储满),续播档案缺失不致命 */
    }
  }, []);

  // 换源/卸载兜底:site/id 变化前把旧片最后快照落盘(flush 读 ref,闭包无关)
  useEffect(() => {
    return () => {
      flush();
      // 新片开始:重置快照与节流基准,防旧片进度串进新片档案
      snapRef.current = { site: '', id: null, t: 0, d: 0 };
      lastSavedRef.current = -999;
    };
  }, [site, id, flush]);

  // 高频进度回调:更新快照 + 节流落盘(onProgress(sec, dur) 直通)
  const save = useCallback(
    (t, d) => {
      if (!site || id == null || !(t > 0) || !isFinite(t)) return;
      snapRef.current = { site: site, id: id, t: t, d: isFinite(d) ? d : 0 };
      if (Math.abs(t - lastSavedRef.current) >= SAVE_INTERVAL_S) {
        lastSavedRef.current = t;
        try {
          saveProgress(site, id, t, isFinite(d) ? d : 0);
        } catch (_e) {
          /* 同上:本地存储异常静默 */
        }
      }
    },
    [site, id]
  );

  // 续播判定:读本地进度,值得续才返回(NextWeb ready 同款条件)。
  // 注意 RN 侧 history.getProgress 走 AsyncStorage,是异步函数 → restore 返回
  // Promise<{t,d,at}|null>,调用方(Provider 解析流程)await 后再用
  const restore = useCallback(async () => {
    if (!site || id == null) return null;
    let p = null;
    try {
      p = await getProgress(site, id);
    } catch (_e) {
      p = null; // 本地存储异常:当无进度,从头播
    }
    if (!p || !isFinite(p.t) || !(p.t > 10)) return null; // 太靠前:不值得续
    if (p.d && p.t >= p.d - 20) return null; // 已看完(距结尾 ≤20s):不续
    return p;
  }, [site, id]);

  return { save, flush, restore };
}
