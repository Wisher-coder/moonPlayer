// ============================================================================
// use-media-feed.js —— 共享媒体面板单 tab 的取数状态机(offsetId 游标分页)
// ----------------------------------------------------------------------------
// 数据面:GET /api/telegram/search {peer, q:'', filter, limit, offsetId,
// minDate?, maxDate?} → {messages,totalCount,completed}(id 降序;契约见
// server routes/telegram-extras.js ①)。filter 取值 photoVideo|document|url|
// voice(有 filter 时 q 允许空串=纯媒体浏览)。走 lib/tg-api.js 的 api()
// (不去重不缓存;Error.needLogin 精确透传)——响应经 normalize.js 归一图片
// 地址后落状态。
// 分页语义:首页不带 offsetId;翻页带「上一页最旧 id」(排他),completed
// 即到底。日期窗口 dates({minDate,maxDate} | null,unix 秒)只作用于首页
// ——媒体日历点日重锚:窗口首查拿到当日媒体,后续翻页只带 offsetId 继续
// 向旧分页(与 TI「定位到当日,继续向前浏览」同语义,窗口不截断时间线)。
// 生命周期契约:
//   · 惰性首拉:active 首次为真才拉首页(四 tab 各持一份 feed,切 tab 不重拉,
//     已载数据保留);
//   · dates 变化(重锚/退出重锚)= 重拉首页(骨架屏);
//   · 竞态三层:epoch 世代号 + alive 存活标志 + 在途单飞(hooks/use-infinite-list
//     同款);上游失败如实呈现中文错误 + 显式重试,绝不自动重试(防风暴红线)。
// 契约返回:{ items, loading, loadingMore, err, needLogin, completed,
// reload, loadMore }。items==null = 首页未就绪(骨架屏)。
// ============================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../lib/tg-api.js';
import { normalizeMediaMsg } from './normalize.js';

const PAGE_LIMIT = 50; // 单页条数(与服务端 clampSearchLimit 上限 SEARCH_LIMIT_MAX=50 对齐,超出会被钳制)

// 未登录判定:tg-api 通道 Error.needLogin 精确透传,文案启发式仅留兜底
// (use-chat-timeline mapErr 同款正则)
const NEED_LOGIN_RE = /(未登录|请先登录|需要登录|重新登录)/;

export function useMediaFeed({ peer, filter, active, dates }) {
  const [items, setItems] = useState(null);      // null = 首页未就绪
  const [loading, setLoading] = useState(false); // 首页在途(骨架屏门禁)
  const [loadingMore, setLoadingMore] = useState(false); // 翻页在途
  const [err, setErr] = useState('');            // 首页失败(重试入口)/翻页失败
  const [needLogin, setNeedLogin] = useState(false);
  const [completed, setCompleted] = useState(false); // 服务端分页到底

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const completedRef = useRef(completed);
  completedRef.current = completed;
  const epochRef = useRef(0);    // 请求世代号(迟到旧响应丢弃)
  const aliveRef = useRef(true); // 卸载存活标志
  const inflightRef = useRef(false); // 在途单飞
  const bootedRef = useRef(false);   // 首拉门闩(active 首真一拉,切走保留)
  const datesRef = useRef(dates);    // dates 实时镜像(fetchPage 取最新窗口)

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      epochRef.current++; // 卸载即作废在途响应
    };
  }, []);

  // peer/filter 变化(冷深链换会话/换 tab 档):重武装首拉门闩
  useEffect(() => {
    bootedRef.current = false;
  }, [peer, filter]);

  const fetchPage = useCallback(
    async (offsetId) => {
      if (inflightRef.current) return; // 单飞:滚动反复触底不重复发请求
      inflightRef.current = true;
      const seq = ++epochRef.current;
      const d = datesRef.current;
      const params = { peer, q: '', filter, limit: PAGE_LIMIT };
      if (offsetId > 0) {
        params.offsetId = Math.floor(offsetId);
      } else if (d) {
        // 日期窗口只进首页请求(重锚语义,见文件头)
        if (d.minDate > 0) params.minDate = Math.floor(d.minDate);
        if (d.maxDate > 0) params.maxDate = Math.floor(d.maxDate);
      }
      if (offsetId > 0) {
        setLoadingMore(true);
        setErr('');
      } else {
        setLoading(true);
        setErr('');
        setItems(null); // 首页/重锚:回骨架屏
      }
      try {
        const r = await api('telegram', 'search', params);
        if (!aliveRef.current || seq !== epochRef.current) return;
        // 响应数组键:现行契约为 messages(与聊天页会话内搜索同源);对 items
        // 形态做防御式兼容(任务契约口径的别名),两者皆缺按空页处理
        const raw = r && Array.isArray(r.messages)
          ? r.messages
          : (r && Array.isArray(r.items) ? r.items : []);
        const msgs = raw.map(normalizeMediaMsg).filter(Boolean);
        if (offsetId > 0) {
          // 翻页:按 id 去重追加(结果恒 id 降序)
          setItems((prev) => {
            const seen = new Set((prev || []).map((x) => (x && x.id != null ? String(x.id) : '')));
            return (prev || []).concat(msgs.filter((x) => x && x.id != null && !seen.has(String(x.id))));
          });
        } else {
          setItems(msgs);
        }
        setCompleted(Boolean(r && r.completed) || !msgs.length);
        setNeedLogin(false);
      } catch (e) {
        if (!aliveRef.current || seq !== epochRef.current) return;
        const msg = (e && e.message) || '加载失败,请重试';
        setErr(msg);
        setNeedLogin(!!(e && e.needLogin) || NEED_LOGIN_RE.test(msg));
        // 翻页失败保留已载列表(仅标错误,loadMore 即重试);首页失败 items 已清空
      } finally {
        // 仅最新世代放行在途锁,防被作废请求提前解锁造成重复拉页
        if (seq === epochRef.current) {
          setLoading(false);
          setLoadingMore(false);
          inflightRef.current = false;
        }
      }
    },
    [peer, filter]
  );

  // 首拉门闩:active 首次为真拉首页(peer 无效/未配置不发)
  useEffect(() => {
    if (!active || !peer || !filter || bootedRef.current) return;
    bootedRef.current = true;
    fetchPage(0);
  }, [active, peer, filter, fetchPage]);

  // 日期窗口变化(重锚/退出)= 强制重拉首页:接管在途的翻页请求(世代号
  // 作废其响应),防「翻页在途时点日重锚被单飞锁吞掉」;未首拉时让首拉
  // 请求自带最新窗口
  useEffect(() => {
    const prev = datesRef.current;
    datesRef.current = dates;
    const keyOf = (d) => (d ? Math.floor(d.minDate) + '-' + Math.floor(d.maxDate) : '');
    if (keyOf(prev) === keyOf(dates)) return; // 窗口未变
    if (!bootedRef.current) return; // 尚未首拉:上面的首拉 effect 自会带上
    epochRef.current++;      // 作废在途(翻页/首页)响应
    inflightRef.current = false; // 强制接管单飞锁(旧 finally 因世代号不符不再动锁)
    fetchPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dates]);

  // 翻页(含失败重试):已载最旧 id 作游标;到底/在途/无游标不发
  const loadMore = useCallback(() => {
    const list = itemsRef.current;
    if (!list || !list.length) return;
    if (completedRef.current || inflightRef.current) return;
    const oldest = list[list.length - 1];
    const off = oldest && Number(oldest.id) > 0 ? Math.floor(Number(oldest.id)) : 0;
    if (!off) return;
    fetchPage(off);
  }, [fetchPage]);

  // 显式重拉(错误重试):作废在途请求回首页
  const reload = useCallback(() => {
    epochRef.current++;
    inflightRef.current = false;
    fetchPage(0);
  }, [fetchPage]);

  return {
    items,
    loading,
    loadingMore,
    err,
    needLogin,
    completed,
    reload,
    loadMore,
  };
}
