// 无限滚动列表 hook（RN 三端移植，源：NextWeb/src/hooks/use-infinite-list.js）
// ----------------------------------------------------------------------------
// fetcher 形态：fetchPage(page) → Promise<{ items, hasMore }>（page 从 1 起）。
// 竞态防护照搬 NextWeb 的「epoch 世代号 + alive 存活标志 + 在途去重」三层：
//   - epoch 世代号：deps 变化/重置/重试时 +1，迟到的旧响应对不上世代号即整组丢弃；
//   - alive 存活标志：组件卸载后到达的响应丢弃；
//   - 在途去重：串行拉页，滚动反复触底不重复发请求。
// 追加按 id 去重（防接口重复条目）；首屏失败 err 有值（reload 重拉），加载更多
// 失败保留列表且 err 置值（loadMore 即重试）。
// 与 NextWeb 版的差异（RN 侧裁剪）：滚动哨兵 IntersectionObserver → 调用方用
// FlashList 的 onEndReached 直连 loadMore；web 侧的快照水合/滚动恢复/双 rAF
// 属浏览窗行为，RN 由 FlashList 自身的回收与 keep-alive 机制承接，不在此层。
// 契约：useInfiniteList(fetchPage) → { items, loading, more, loadMore, reload }；
// 第二参 deps（可选，默认 []）变化即整体重置回第 1 页——fetchPage 引用变化
// 不触发重置（页面用 useCallback 包 fetcher，靠 deps 表达「换数据源」）。
// 屏幕焦点门闩：栈式 push（如首页 → 观看页）后本屏仍挂载但被隐藏，FlashList
// 容器塌缩/重排会反复误触 onEndReached（每追加一页数据又重排一次），形成
// 离开页面后 list 接口一页接一页连打的刷屏循环——失焦期间 loadMore 一律
// 拒绝，回焦后随真实触底/滚动自然恢复（无需补偿加载）。reload 与首屏
// loadTo(1) 不受门闩约束（前者是用户手动重试，后者只在挂载/deps 变化时跑）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';

// 归一化 ListResult → fetcher 返回形态的公共适配器：容错 items/data 字段名与
// hasMore/page+pageCount（旧形态 current_page/last_page）两套表述，列表页
// fetcher 共用（照搬 NextWeb）
export function toPage(res) {
  const raw = res && (Array.isArray(res.items) ? res.items : Array.isArray(res.data) ? res.data : null);
  const items = raw ? raw.filter(Boolean) : [];
  let hasMore = false;
  if (res && typeof res.hasMore === 'boolean') {
    hasMore = res.hasMore;
  } else {
    const page = Number(res && (res.page != null ? res.page : res.current_page)) || 1;
    const last = Number(res && (res.pageCount != null ? res.pageCount : res.last_page)) || 1;
    hasMore = page < last;
  }
  return { items, hasMore };
}

// 注意：调用方（首页/分类/搜索/专区/相册/作者/观看页相关）一律按【命名导入】
// 使用 useInfiniteList，导出必须同时提供命名与默认两种形态。
export function useInfiniteList(fetchPage, deps = []) {
  const [items, setItems] = useState(null); // null = 首屏未就绪（骨架屏）；[] = 已加载但为空
  const [page, setPage] = useState(0); // 已成功加载的页码
  const [done, setDone] = useState(false); // 到底标志（没有更多了）
  const [err, setErr] = useState(''); // 首屏失败 / 加载更多失败（后者保留列表可重试）
  const [loadingMore, setLoadingMore] = useState(false);

  const epochRef = useRef(0); // 请求世代号（过期判定，照搬 NextWeb）
  const aliveRef = useRef(true); // 组件存活标志（卸载后丢弃迟到响应）
  const inflightRef = useRef(false); // 在途去重，防触底反复触发重复拉页

  // 最新 fetcher/items 引用：render 期同步，避免闭包过期
  const fetcherRef = useRef(fetchPage);
  fetcherRef.current = fetchPage;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // 屏幕焦点门闩（见文件头说明）：focus 置位 / blur 复位，loadMore 据此拒发。
  // 初值 true——栈导航下屏只在首次导航到时挂载且彼时必为焦点，不会出现
  // 「挂载即失焦」的窗口；useFocusEffect 等导航 state 就绪才补跑，无竞态。
  const focusedRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      return () => {
        focusedRef.current = false;
      };
    }, [])
  );

  // 统一加载入口：target = 要拉的页码；世代号 +1 作废在途旧响应（双保险里的
  // 第一层：迟到旧响应 seq 对不上 epochRef 即丢弃）
  const loadTo = useCallback(async (target) => {
    if (inflightRef.current) return; // 串行，防重复请求
    inflightRef.current = true;
    const seq = ++epochRef.current;
    if (target === 1) {
      // 回到第 1 页：全量重置，先亮骨架屏
      setItems(null);
      setPage(0);
      setDone(false);
      setErr('');
      setLoadingMore(false);
    } else {
      setLoadingMore(true);
      setErr('');
    }
    try {
      const res = await fetcherRef.current(target);
      if (!aliveRef.current || seq !== epochRef.current) return; // 已卸载或过期，丢弃
      const list = res && Array.isArray(res.items) ? res.items.filter(Boolean) : [];
      const hasMore = !!(res && res.hasMore);
      const prev = itemsRef.current;
      let next;
      if (target === 1) next = list;
      else {
        const seen = new Set((prev || []).map((x) => x && x.id)); // 防接口重复条目
        next = (prev || []).concat(list.filter((x) => x && !seen.has(x.id)));
      }
      setItems(next);
      setPage(target);
      setDone(!list.length || !hasMore);
    } catch (e) {
      if (!aliveRef.current || seq !== epochRef.current) return; // 已卸载/过期，丢弃
      setErr((e && e.message) || '加载失败，请重试'); // 加载更多失败：列表保留在原处
    } finally {
      // 仅最新世代放行在途锁，防被作废请求提前解锁造成重复拉页
      if (seq === epochRef.current) {
        setLoadingMore(false);
        inflightRef.current = false;
      }
    }
  }, []);

  // 挂载 / deps 变化：自动重置并拉第 1 页；cleanup 世代号 +1 作废在途旧响应
  useEffect(() => {
    aliveRef.current = true; // 严格模式双执行时复活（真实卸载后保持 false）
    const cleanup = () => {
      aliveRef.current = false;
      epochRef.current++;
    };
    loadTo(1);
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps]);

  // 加载更多（含加载更多失败后的手动重试）：首屏失败态由 reload 负责；
  // 失焦屏拒绝（防隐藏态 onEndReached 误触连打，见文件头焦点门闩说明）
  const loadMore = useCallback(() => {
    if (!focusedRef.current) return;
    if (items == null || !items.length || done || inflightRef.current) return;
    loadTo(page + 1);
  }, [items, page, done, loadTo]);

  // 重置重拉（首屏失败重试 / 手动刷新）：作废在途请求回到第 1 页
  const reload = useCallback(() => {
    epochRef.current++;
    inflightRef.current = false;
    loadTo(1);
  }, [loadTo]);

  return {
    items,
    loading: items == null && !err, // 首屏加载中（reload 重试时也回到此态）
    loadingMore,
    more: items != null && items.length > 0 && !done, // 还有下一页可拉
    err,
    done,
    loadMore,
    reload,
  };
}

// 兼容默认导入形态（BoardsHome 等如有默认导入也走这里）
export default useInfiniteList;
