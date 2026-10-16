// 卡片网格列数算法（RN 三端移植，源：NextWeb/src/hooks/use-grid-columns.js）
// ----------------------------------------------------------------------------
// 对齐 YouTube 桌面版富网格（ytd-rich-grid-renderer）的口径——列数由容器实测
// 宽度算出，卡宽再反推：
//   卡宽 = (容器内容宽 - 列距 × (列数 - 1)) / 列数
//   列数 = clamp(floor((容器内容宽 + 16) / (最小卡宽 + 16)), 1, 6)
//   最小卡宽三档：容器 ≥1500 → 420；1000–1499 → 320；<1000 → 285
// 这三档 + 上限 6 逐一复现 YouTube 首页实测（1920+展开侧栏 3 列 / 1920+迷你轨
// 4 列 / 1440+展开 3 列 / 1024+迷你 3 列 / 900+迷你 2 列 / 640 两列 / 手机 390
// 单列 m.youtube 形态）；同一视口收起侧栏内容变宽会重算出多一列，与 YouTube
// 一致。列距恒 16；行距 36（≥768 宽，手机保持 16 紧凑档，由 VideoGrid 落地）。
// RN 侧宽源：容器 onLayout 实测宽（web/native 通用，侧栏/迷你轨占据宽度后
// 容器 ≠ 窗口，比 useWindowDimensions 更准；未测到（首帧）columns=0，调用方
// 可拿窗口宽估列或先渲染骨架）。
// 契约：useGridColumns() → { columns, cardWidth }（另附 onLayout/containerWidth
// 供容器挂接，props 只增不减）。
import { useCallback, useState } from 'react';

// 最小卡宽分档（容器内容宽 px → 最小卡宽 px）；档位间是阶跃，与 YouTube 一致
export function minCardWidth(containerWidth) {
  if (containerWidth >= 1500) return 420;
  if (containerWidth >= 1000) return 320;
  return 285;
}

// 列数：容器内容宽 → 列数（1..6）；auto-fill 的 floor((W+g)/(min+g)) 同式
export function columnsFor(containerWidth) {
  if (!(containerWidth > 0)) return 0; // 未测到
  const n = Math.floor((containerWidth + 16) / (minCardWidth(containerWidth) + 16));
  return Math.max(1, Math.min(6, n));
}

// 卡宽：容器内容宽 + 列数 → 单卡宽（交给网格按显式 width 落地，RN 无 1fr）。
// native 陷阱：结果取整——Yoga 按像素栅格取整后「N 卡 × 小数宽 + 整数列距」
// 可能超出容器零点几像素，flexWrap 行尾卡会被挤到下一行、文本测量也随之
// 抖动（安卓专属，web 亚像素无碍）；Math.floor 一处收口，全部消费方受益
export function cardWidthFor(containerWidth, cols) {
  if (!(containerWidth > 0) || !(cols > 0)) return 0;
  return Math.floor((containerWidth - 16 * (cols - 1)) / cols);
}

// 观测网格容器宽度：返回 { columns, cardWidth, containerWidth, onLayout }。
// onLayout 挂到网格容器（FlashList/View 均可）；宽度变化 <0.5px 不更新，
// 避免 web 上亚像素 resize 引发的无谓重渲染。columns=0 表示尚未测到。
export default function useGridColumns() {
  const [containerWidth, setWidth] = useState(0);
  const onLayout = useCallback((e) => {
    const w = e && e.nativeEvent && e.nativeEvent.layout ? e.nativeEvent.layout.width : 0;
    setWidth((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
  }, []);
  const columns = columnsFor(containerWidth);
  const cardWidth = cardWidthFor(containerWidth, columns);
  return { columns, cardWidth, containerWidth, onLayout };
}
