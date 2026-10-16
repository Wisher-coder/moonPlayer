// ============================================================================
// use-form.js —— 三画幅判定
// ----------------------------------------------------------------------------
// 契约：useForm() → { width, form }，form ∈ 'phone' | 'pad' | 'pc'。
// 断点口径（与 NextWeb/src/hooks/use-grid-columns.js 的容器算法兼容的视口档）：
//   宽 < 768     phone —— 底部四槽导航、单列卡；
//   768 – 1279   pad   —— 迷你导视轨 72px 常驻；
//   >= 1280      pc    —— 导视侧栏 240px（可折叠持久化）。
// 基于 useWindowDimensions（窗口尺寸变化即时重渲，平板旋转/桌面改窗均跟随）。
//
// 【web 水合对齐】SSG 导出时 RN-web 的 Dimensions.get('window') 恒为
// {width:0,height:0}（无 DOM 环境），服务端 HTML 全按 0 宽（手机分支）输出；
// 客户端首帧若直接用真实宽度，与 HTML 必然不一致 → React 水合失败（#418）
// 整树丢弃重渲。这里 web 首帧恒返回 0（与服务端完全一致），挂载 effect 后
// 切真实值——受控的一次重渲换取水合成功与零控制台报错。native 无 SSG，
// 直接用真实值。
// ============================================================================
import { useEffect, useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';

// 断点阈值（px，含边界语义：<768 手机 / <1280 平板 / 其余 PC）
export const PHONE_MAX_WIDTH = 767;
export const PAD_MAX_WIDTH = 1279;

// 观看页宽幅阈值（px）：宽 ≥1024 视为桌面画幅（对齐 NextWeb lg）。AppShell 的
// 沉浸全屏判定与播放页的布局分档共用同一口径，勿在页面内另立常量
export const DESKTOP_MIN = 1024;

// 纯函数形态（非组件场景复用同一口径）
export function formFor(width) {
  if (!(width > 0)) return 'phone'; // 未测到/异常按手机兜底
  if (width <= PHONE_MAX_WIDTH) return 'phone';
  if (width <= PAD_MAX_WIDTH) return 'pad';
  return 'pc';
}

// 画幅钩子：{ width, form }
export function useForm() {
  const real = useWindowDimensions();
  const isWeb = Platform.OS === 'web';
  // web：首帧恒 0（与 SSG 服务端渲染一致），挂载后才放行真实宽度
  const [live, setLive] = useState(!isWeb);
  useEffect(() => {
    if (!live) setLive(true);
  }, [live]);
  const width = !isWeb || live ? real.width : 0;
  return { width, form: formFor(width) };
}

export default useForm;
