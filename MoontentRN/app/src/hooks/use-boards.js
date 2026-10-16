// 首页板块中间件（RN 三端移植，源：NextWeb/src/hooks/use-boards.js）
// ----------------------------------------------------------------------------
// 站点无关的板块取数层（仅 boards 能力站点启用，由页面按 caps.boards 门控后
// 调用）。拉 api(site, 'boards') → 防御式归一化 sections；站点切换/重试自动
// 重拉；竞态防护与 use-infinite-list 同手法（alive + 世代号，迟到的旧响应
// 对不上世代号即整组丢弃）。板块行内的子标签切换取数（api(site,'board')）
// 由板块首页组件就地管理，不在此层。
// 与 NextWeb 版的差异：契约签名简化为 useBoards(site)——ready/enabled 门控
// 由调用方表达（site 传空串/null 即视为未启用，不发请求）。
// api 调用走跨模块契约 src/lib/client.js 的 api(site, method, params)。
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/client.js';

// ListResult 防御式取值：容错 items/data 两套字段名，脏条目过滤
const pageItems = (res) => (res && Array.isArray(res.items) ? res.items.filter(Boolean) : []);

// 板块归一化：id/title 必有；tabs 缺省或空 → null（无子标签板块）；list 拍平为 items
const secOf = (s) => {
  if (!s || s.id == null || !s.title) return null;
  const tabs = Array.isArray(s.tabs)
    ? s.tabs
        .filter((t) => t && t.title)
        .map((t) => ({ id: t.id == null ? null : String(t.id), title: String(t.title) }))
    : null;
  return {
    id: String(s.id),
    title: String(s.title),
    tabs: tabs && tabs.length ? tabs : null,
    items: pageItems(s.list),
  };
};

export default function useBoards(site) {
  const [st, setSt] = useState({ loading: true, error: '', sections: null });
  const [tick, setTick] = useState(0); // 手动重试
  const aliveRef = useRef(true);
  const epochRef = useRef(0); // 请求世代号（site 变化/重试时作废在途旧响应）

  useEffect(() => {
    if (!site) {
      // 未启用（非 boards 能力站点 / 站点未就绪）：不发请求，静默空态
      epochRef.current++;
      setSt({ loading: false, error: '', sections: null });
      return;
    }
    aliveRef.current = true; // 严格模式双执行时复活（真实卸载后保持 false）
    const seq = ++epochRef.current;
    setSt({ loading: true, error: '', sections: null });
    api(site, 'boards')
      .then((h) => {
        if (!aliveRef.current || seq !== epochRef.current) return; // 已卸载或过期，丢弃
        const sections = (Array.isArray(h && h.sections) ? h.sections : []).map(secOf).filter(Boolean);
        setSt({ loading: false, error: '', sections });
      })
      .catch((e) => {
        if (!aliveRef.current || seq !== epochRef.current) return;
        setSt({ loading: false, error: (e && e.message) || '板块加载失败，请重试', sections: null });
      });
    return () => {
      aliveRef.current = false;
      epochRef.current++;
    };
  }, [site, tick]);

  const retry = useCallback(() => setTick((t) => t + 1), []);
  return { ...st, retry };
}
