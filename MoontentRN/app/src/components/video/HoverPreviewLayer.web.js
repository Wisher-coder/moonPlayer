// ============================================================================
// HoverPreviewLayer.web.js —— 视频卡悬浮预览全局层（web 专用，RN 三端移植主体）
// ----------------------------------------------------------------------------
// 源：NextWeb/src/components/video/HoverPreviewLayer.jsx（时序参数 / 缓存策略 /
// teardown 全部 1:1 照搬，见下方各段注释；AppShell 经 metro 平台分流挂载本层，
// native 端取同目录 HoverPreviewLayer.js 的 null stub）。
// 行为对齐 YouTube 桌面实测（2026-10 观察记录，NextWeb 同源）：
//   · 阶段一「内联」：悬停 ~500ms 后，视频原位铺在卡片缩略图上播放（静音、循环），
//     底部一条 2-3px 细红进度条，无任何控件；浮层 pointer-events 穿透，点击落进卡片。
//   · 阶段二「扩展」：同卡持续悬停 ~3s 后，同一视频原地外扩（缩略图四周 +12px）成
//     圆角阴影面板盖住邻卡；此时进度条可拖（悬浮加粗出拖点，拖动出时间气泡），
//     右下出静音钮（悬停面板时）。
//   · 无视频源的卡（音频类/解析失败）：完全不出预览，也不出错误 UI（会话内拉黑）。
//   · 保温：移开后 30s 内再悬停同卡，从上次进度续播。
// 架构约束（勿破坏，NextWeb 同款）：
//   · 全 App 只此一个预览 video + hls 实例；换卡「先毁后建」原地换源，绝不新建
//     播放器组件——主播放器（VideoPlayer.web）与预览互不干扰。
//   · 取流走 api(site,'play')（服务端是真实上游抓取），必须保守：意图延迟 + 换卡
//     去抖 + 模块级结果缓存 + 同 key 并发去重 + 失败拉黑，杜绝 hover 扫过请求风暴。
//   · 隐藏/卸载必走完整 teardown（pause + 摘 src + load + hls.destroy），epoch 防
//     过期异步回填（项目惯用法，见 VideoPlayer.web.js / ArtPlayer.jsx）。
//   · 面板锚定用页面坐标（absolute 直挂 body 门户，勿改回 fixed）：页面滚动时面板
//     与卡片同为文档内元素、合成器同帧搬运零滞后；fixed 视口坐标要靠 scroll 事件
//     JS 追位，主线程一忙（视频解码/React 更新）就晚帧即滚动拖影。
//   · 预览不读写 history.js——进度不落盘、不产生观看记录。
//   · 渲染性能两铁律（NextWeb 2026-10 治理原样保留）：① 几何动画只走 transform
//     （FLIP，见 expandNow），绝不 transition left/top/width——布局属性每帧强制
//     重排，动画期与视频解码叠载正是低端机掉帧源；② 进度/缓冲等 timeupdate 高频
//     量直写 DOM（paintProgress）不进 React 状态。
// RN-web 适配点（相对 NextWeb 原版的全部差异）：
//   1) createPortal(react-dom) 挂 document.body；整层用原生 DOM 元素（div/video/img
//      + 内联 style，不走 Tailwind className——nativewind 的 className interop 只对
//      注册过的 RN 组件生效，原生 DOM 元素必须内联样式）。RN-web 由 react-dom 渲染，
//      原生元素字符串（'div'/'video'）直达真实 DOM，与 VideoPlayer.web.js 的 DOM
//      惯用法同源；锚元素 rect 测量直接用 DOM API（getBoundingClientRect 等）。
//   2) 取流用 RN 客户端签名 api(site, 'play', { id })（lib/client.js，返回
//      {type:'hls'|'mp4', url, via}，url 已被 client 绝对化）。
//   3) hls.js 动态 import 懒加载（lib/lazy-hls.js，对齐 NextWeb 原版；分包后
//      独立 chunk 不进首屏，Safari 原生 HLS 分支不触发加载）。
//   4) 路由：expo-router 的 usePathname（变化即收层）+ useRouter().push 深链观看页
//      '/video/' + site + '/' + encodeURIComponent(String(id))（NextWeb 是 next/link）。
//   5) 静音钮图标为内联 svg（Solar 24px 描边路径，与 icons.js 桶同源），不引 native 图标组件进 portal。
//   6) NextWeb 的 rememberCardAuthor（卡片作者随行记忆）为 NextWeb 独有模块，RN 侧
//      无对应物，跳过——点击仍正常进观看页。
// ============================================================================
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname } from 'expo-router';
import { loadHls } from '../../lib/lazy-hls.js';
import { api } from '../../lib/client.js';
import { useOpenVideo } from '../../lib/open-video.js';
import { fmtDur } from '../../lib/utils.js';
import { useHoverPreviewStore, previewClear } from '../../lib/hover-preview-store.js';
import { useColors } from '../../theme/index.js';

// ===== 时序参数（对齐 YouTube 实测；取流是真实上游抓取，勿调快）=====
const OPEN_DELAY = 500;   // 悬停意图延迟：多久后进入内联播放（快速扫过不触发）
const EXPAND_DELAY = 3000; // 内联起播后持续悬停多久，原地扩展成面板
const SWAP_DELAY = 120;   // 换卡去抖：滑到新卡多久后切换预览（新卡回到内联态）
const HIDE_GRACE = 200;   // 离开宽限：鼠标桥——从卡片移进扩展面板的间隙容差
const FADE_MS = 150;      // 淡出动画时长，结束后再卸载媒体
const BLEED = 12;         // 扩展态向缩略图四周外扩的像素（实测 YouTube ≈12px）

// ===== 模块级缓存（跨挂载共享；服务端解析贵，宁可缓存）=====
// srcCache 带 TTL（口径对齐 wall-src 的 4 分钟）：上游播放地址多为分钟级签名
// （zimuquan 分钟级、bf/p91 切片签名 ~5 分钟），无限期缓存会在会话后半段反复
// 喂死链——过期即删现解析；播放中二次致命错误也会删项（见 ERROR 处理器）。
const SRC_CACHE_MAX = 40;
const SRC_TTL = 4 * 60e3;
const srcCache = new Map(); // site:id → { type, url, at }
const inflight = new Map(); // site:id → Promise（同 key 并发去重）
const errKeys = new Set(); // 解析失败的卡：会话内拉黑（音频类无源卡，YouTube 同样无预览）
const posCache = new Map(); // site:id → { t, exp }：移开后 30s 内续播（保温）
const POS_MAX = 20;

function resolveSrc(site, id) {
  const key = site + ':' + id;
  const hit = srcCache.get(key);
  if (hit) {
    if (Date.now() - hit.at < SRC_TTL) {
      srcCache.delete(key); srcCache.set(key, hit); // LRU 触碰
      return Promise.resolve(hit);
    }
    srcCache.delete(key); // 过期死链：删掉现解析，不无限期复读
  }
  let p = inflight.get(key);
  if (!p) {
    p = api(site, 'play', { id })
      .then((r) => {
        if (!r || !r.url) throw new Error('播放地址为空');
        srcCache.set(key, { ...r, at: Date.now() }); // at：入缓存时刻（TTL 判龄用）
        if (srcCache.size > SRC_CACHE_MAX) srcCache.delete(srcCache.keys().next().value);
        return r;
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, p);
  }
  return p;
}

// 静音钮图标：Solar volume-loud / volume-cross 的 24px 描边路径内联（16px 展示；
// 与 icons.js 桶同源 @iconify-json/solar。本层全原生 DOM 门户树，不走 RN 组件）
function VolIcon({ muted }) {
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"
    >
      {muted ? (
        <>
          <path d="M15.5 11.9998C15.5 12.5317 15.4646 13.4879 15.4127 14.6052C15.2725 17.6226 15.2024 19.1313 14.2797 19.7797C14.1028 19.9041 13.9047 20.0049 13.7001 20.0747C12.7327 20.4048 11.5975 19.747 9.5 18.3725M7.0162 17.0417C6.76819 16.9998 6.51215 16.9998 6.00008 16.9998C4.62617 16.9998 3.93921 16.9998 3.33988 16.7225C2.7923 16.4692 2.24473 15.9539 1.95854 15.4228C1.64531 14.8414 1.60847 14.237 1.53479 13.0282C1.51299 12.6706 1.5 12.3222 1.5 11.9998C1.5 11.6774 1.51299 11.329 1.53479 10.9714C1.60847 9.76255 1.64531 9.15814 1.95854 8.57679C2.24473 8.04563 2.7923 7.53042 3.33988 7.27707C3.93921 6.99979 4.62617 6.99979 6.00008 6.99979C6.51215 6.99979 6.76819 6.99979 7.0162 6.95791C7.26138 6.9165 7.50046 6.84478 7.72795 6.74438C7.95806 6.64283 8.17181 6.50189 8.59932 6.22002L8.81825 6.07566C11.3612 4.39898 12.6327 3.56063 13.7001 3.92487C13.9047 3.9947 14.1028 4.09551 14.2797 4.21984C15.115 4.80685 15.2516 6.09882 15.374 8.57679" />
          <path d="M20 18C20 18 21.5 16.2 21.5 12C21.5 9.56658 20.9965 7.93882 20.5729 7" />
          <path d="M18 15C18 15 18.5 14.1 18.5 12C18.5 11.1381 18.4158 10.4784 18.3165 10" />
          <path d="M22 2L2 22" />
        </>
      ) : (
        <>
          <path d="M1.53479 10.9714C1.60847 9.76255 1.64531 9.15814 1.95854 8.57679C2.24473 8.04563 2.7923 7.53042 3.33988 7.27707C3.93921 6.99979 4.62617 6.99979 6.00008 6.99979C6.51215 6.99979 6.76819 6.99979 7.0162 6.95791C7.26138 6.9165 7.50046 6.84478 7.72795 6.74438C7.95806 6.64283 8.17181 6.50189 8.59932 6.22002L8.81825 6.07566C11.3612 4.39898 12.6327 3.56063 13.7001 3.92487C13.9047 3.9947 14.1028 4.09551 14.2797 4.21984C15.2024 4.86829 15.2725 6.37699 15.4127 9.3944C15.4646 10.5117 15.5 11.4679 15.5 11.9998C15.5 12.5317 15.4646 13.4879 15.4127 14.6052C15.2725 17.6226 15.2024 19.1313 14.2797 19.7797C14.1028 19.9041 13.9047 20.0049 13.7001 20.0747C12.6327 20.4389 11.3612 19.6006 8.81825 17.9239L8.59932 17.7796C8.17181 17.4977 7.95806 17.3567 7.72795 17.2552C7.50046 17.1548 7.26138 17.0831 7.0162 17.0417C6.76819 16.9998 6.51215 16.9998 6.00008 16.9998C4.62617 16.9998 3.93921 16.9998 3.33988 16.7225C2.7923 16.4692 2.24473 15.9539 1.95854 15.4228C1.64531 14.8414 1.60847 14.237 1.53479 13.0282C1.51299 12.6706 1.5 12.3222 1.5 11.9998C1.5 11.6774 1.51299 11.329 1.53479 10.9714Z" />
          <path d="M20 6C20 6 21.5 7.8 21.5 12C21.5 16.2 20 18 20 18" />
          <path d="M18 9C18 9 18.5 9.9 18.5 12C18.5 14.1 18 15 18 15" />
        </>
      )}
    </svg>
  );
}

export default function HoverPreviewLayer() {
  const { target } = useHoverPreviewStore();
  const pathname = usePathname();
  const goVideo = useOpenVideo(); // 深链口径统一（桌面壳主窗弹独立播放窗）
  const C = useColors(); // 语义色（accent 进度条/拖点、line 描边环），随主题换档

  // cur = 浮层当前锚定的 target 快照（target 清空后保留到淡出完成再卸载）；
  // phase:'inline'（铺在缩略图上）|'expanded'（外扩面板）；shown 控淡入淡出
  const [cur, setCur] = useState(null);
  const [phase, setPhase] = useState('inline');
  const [shown, setShown] = useState(false);
  // FLIP 几何过渡量：{ dx, dy, s, play } | null（替代旧的 geoAnim + 布局属性过渡）。
  // play=false 是反演首帧：面板已瞬时摆到终位（left/top/width 即终值），transform
  // 反演回起点矩形、不带过渡；play=true 的下一帧放开过渡到 none，transform 走
  // 合成器零重排。换卡/滚动即清空（瞬时跟随）
  const [flip, setFlip] = useState(null);
  const [pos, setPos] = useState({ left: 0, top: 0, width: 320, radius: 12 });
  // 媒体与控制条状态（只留离散低频态：指针/起播/时长事件驱动；timeupdate 高频量
  // 一律 ref 直写，见 paintProgress——此前 t/buf 各一拍 setT/setBuf 整层重渲染）
  const [mode, setMode] = useState('resolving'); // resolving | playing
  const [vidReady, setVidReady] = useState(false); // 首帧起播前 video 保持透明（静态封面垫底）
  const [dur, setDur] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [barHover, setBarHover] = useState(false);
  const [chrome, setChrome] = useState(false); // 扩展面板悬停时的控件显隐
  const [muted, setMuted] = useState(true);

  const panelRef = useRef(null);
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const barRef = useRef(null);
  // 进度直写 DOM 的节点池：红条/缓冲条（直写 width）、拖点（直写 left）、拖动
  // 气泡（直写 left + textContent）——全部绕过 React；节点挂卸仍由 barHot/dragging
  // 的条件渲染管，直写只在已挂载时生效
  const playedRef = useRef(null);
  const bufferedRef = useRef(null);
  const thumbRef = useRef(null);
  const bubbleRef = useRef(null);
  const curRef = useRef(null);
  const shownRef = useRef(false);
  const phaseRef = useRef('inline');
  const modeRef = useRef('resolving');
  const panelHoverRef = useRef(false);
  const draggingRef = useRef(false);
  const pendingExpandRef = useRef(false); // 到点时还没起播：等起播再扩展
  const lastSeekRef = useRef(0);
  const pointerRef = useRef(null); // 最后指针位置：滚动时鼠标未动，判定指针是否仍在锚卡
  const timersRef = useRef({}); // 命名计时器集中管理，防悬挂
  const epochRef = useRef(0);   // 媒体流水号：换源/卸载后旧异步链全部作废

  const setTimer = useCallback((name, fn, ms) => {
    clearTimeout(timersRef.current[name]);
    timersRef.current[name] = setTimeout(fn, ms);
  }, []);
  const clearTimer = useCallback((name) => {
    clearTimeout(timersRef.current[name]);
    delete timersRef.current[name];
  }, []);

  // ===== 进度直写 DOM：timeupdate 高频路径不进 React =====
  // 红条/缓冲条宽度、拖点与气泡的位置及文本，全部经 ref 直写节点；onTimeUpdate
  // 每秒 ~4 拍，原先每拍 setT/setBuf 触发整层（portal+面板+video）reconcile，
  // 是悬浮预览期间全局掉帧的主因之一。保留的离散态（dragging/barHover/vidReady/
  // dur）全部由指针/媒体事件驱动，频率与 timeupdate 无关。
  const paintProgress = useCallback(() => {
    const v = videoRef.current;
    const dNow = v && isFinite(v.duration) ? v.duration : 0;
    const tNow = v ? v.currentTime : 0;
    const pctT = dNow > 0 ? Math.min(100, (tNow / dNow) * 100) : 0;
    let b = 0;
    try { if (v && v.buffered.length) b = v.buffered.end(v.buffered.length - 1); } catch (_e) { /* 忽略 */ }
    if (playedRef.current) playedRef.current.style.width = pctT + '%';
    if (bufferedRef.current) bufferedRef.current.style.width = (dNow > 0 ? Math.min(100, (b / dNow) * 100) : 0) + '%';
    // 拖点/气泡仅 barHot（悬浮/拖动）时挂载，不在场即免写（挂载瞬间由 ref 回调补一拍）
    if (!thumbRef.current && !bubbleRef.current) return;
    // 轨道在 8px 内边距内（扩展态 px-2），按比例换算到容器坐标
    const left = 'calc(8px + (100% - 16px) * ' + pctT / 100 + ')';
    if (thumbRef.current) thumbRef.current.style.left = left;
    if (bubbleRef.current) {
      bubbleRef.current.style.left = left;
      bubbleRef.current.textContent = (fmtDur(tNow) || '0:00') + ' / ' + (fmtDur(dNow) || '--:--');
    }
  }, []);

  // 隐藏：淡出 → 到点卸载媒体（cur 置空，teardown 由媒体 effect 的 cleanup 完成）。
  // 幂等（shownRef 把门）：滚动中每个 scroll 事件的离卡判定都会调到这里，重复调用
  // 不得重排淡出计时——否则持续滚动会一直推迟卸载，隐形面板与媒体白挂着解码
  const hideNow = useCallback(() => {
    if (!curRef.current || !shownRef.current) return;
    clearTimer('open');
    clearTimer('swap');
    clearTimer('expand');
    clearTimer('hide');
    shownRef.current = false;
    setShown(false);
    setTimer('fade', () => {
      curRef.current = null;
      setCur(null);
    }, FADE_MS + 40);
  }, [clearTimer, setTimer]);

  // 离开宽限：触发时再看鼠标是否已进扩展面板（鼠标桥）/是否拖动进度中（顺延再查）
  const scheduleHide = useCallback(() => {
    setTimer('hide', () => {
      if (panelHoverRef.current) return;
      if (draggingRef.current) {
        scheduleHide();
        return;
      }
      hideNow();
    }, HIDE_GRACE);
  }, [hideNow, setTimer]);

  // ===== 锚定：精确贴住缩略图（内联），扩展态四周外扩 BLEED 并夹进视口 =====
  // 输出页面坐标（rect + window.scrollX/Y）：面板是文档内 absolute 元素，页面
  // 滚动时与卡片同层同动、合成器原生搬运——跟随零 JS、零滞后（勿改回 fixed）。
  // phaseOverride：FLIP（见 expandNow）需要同帧取「内联/外扩」两份几何，不传则
  // 读当前态（scroll 校正等既有调用点全部不动）
  const geoOf = useCallback((phaseOverride) => {
    const c = curRef.current;
    if (!c) return null;
    if (!c.el || !c.el.isConnected) {
      hideNow(); // 锚元素失联（列表刷新/翻页卸载）：立即收层
      return null;
    }
    const r = c.el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left, top, w;
    if ((phaseOverride || phaseRef.current) === 'expanded') {
      w = r.width + BLEED * 2;
      left = r.left - BLEED;
      top = r.top - BLEED;
      const h = (w * 9) / 16;
      // 视口钳制（边缘卡片）：整体收进视口，不裁切（钳制在视口空间算，
      // 落成页面坐标后随文档走）
      left = Math.min(Math.max(4, left), Math.max(4, vw - w - 4));
      top = Math.min(Math.max(4, top), Math.max(4, vh - h - 4));
    } else {
      w = r.width; // 内联：与缩略图完全重合
      left = r.left;
      top = r.top;
    }
    return { left: left + window.scrollX, top: top + window.scrollY, width: w, radius: c.radius || 12 };
  }, [hideNow]);

  // 扩展（FLIP）：状态机语义不变（仍只在内联→扩展时做 ~200ms 过渡，换卡/滚动瞬时
  // 落位），只换几何实现——同帧取内联（起点）与外扩（终点）两份几何，面板瞬时摆到
  // 终位，transform 反演回起点矩形，下一帧过渡回 none（放行见下方 flip effect）。
  // transform 是合成器属性、动画期零重排；旧实现 transition left/top/width 每帧
  // 强制 layout，与在跑的视频解码叠负载正是低端机预览卡顿根因之一。两态皆 16:9，
  // 单一 scale 同时覆盖宽高；原点取面板左上（transform-origin:0 0），dx/dy 即两
  // 矩形左上角差
  const expandNow = useCallback(() => {
    if (!curRef.current || phaseRef.current !== 'inline') return;
    const src = geoOf('inline');
    const dst = geoOf('expanded');
    phaseRef.current = 'expanded';
    setPhase('expanded');
    if (src && dst && dst.width > 0) {
      setFlip({ dx: src.left - dst.left, dy: src.top - dst.top, s: src.width / dst.width, play: false });
    } else {
      // 锚失联等异常（geoOf 已顺带收层）：退化为瞬时切态，不做动画
      setFlip(null);
    }
    // ~200ms 动画 + 余量后收尾（transform 归位、过渡撤除）；动画被滚动/换卡提前
    // 打断时 flip 已被那边清空，这里再清一次是幂等 no-op
    setTimer('geo', () => setFlip(null), 260);
  }, [geoOf, setTimer]);

  // FLIP 放行：反演帧必须先真实绘制（「终位 + 反演 transform」先落屏），下一帧才
  // 把 transform 换成 none 并放开过渡——否则前后两帧被合并、动画起点即终点直接
  // 跳变。双 rAF 保证跨浏览器都隔出中间帧；期间 flip 被清空即随 cleanup 撤销
  useEffect(() => {
    if (!flip || flip.play) return;
    let id2 = 0;
    const id1 = requestAnimationFrame(() => {
      id2 = requestAnimationFrame(() => setFlip((f) => (f && !f.play ? { ...f, play: true } : f)));
    });
    return () => { cancelAnimationFrame(id1); cancelAnimationFrame(id2); };
  }, [flip]);

  const activate = useCallback(
    (entry) => {
      clearTimer('fade');
      clearTimer('hide');
      // 锚卡圆角随卡取一次：滚动高频路径 geoOf 不再逐事件 getComputedStyle
      // （强制样式重算，快速滚动下白费主线程——拖影的另一处小诱因）
      let radius = 12;
      try {
        if (entry.el && entry.el.isConnected) {
          radius = parseFloat(getComputedStyle(entry.el).borderRadius) || 12;
        }
      } catch (_e) { /* 取不到按默认圆角 */ }
      const full = { ...entry, radius };
      curRef.current = full;
      setCur(full);
      phaseRef.current = 'inline';
      setPhase('inline'); // 换卡回到内联态（YouTube：新卡不直接出大面板）
      setFlip(null); // 换卡瞬时落位：清掉可能残留的 FLIP 反演 transform
      pendingExpandRef.current = false;
      shownRef.current = true;
      setShown(true);
      // 扩展计时：到点已起播就地扩展；没起播挂起，等起播补
      setTimer('expand', () => {
        if (modeRef.current === 'playing') expandNow();
        else pendingExpandRef.current = true;
      }, EXPAND_DELAY);
    },
    [clearTimer, setTimer, expandNow]
  );

  // ===== target 驱动：进卡意图延迟 / 换卡去抖 / 离卡宽限 =====
  useEffect(() => {
    if (!target) {
      if (curRef.current) scheduleHide();
      else clearTimer('open'); // 尚未弹层就被扫过：撤意图计时，不发一枪
      return;
    }
    clearTimer('hide'); // 鼠标离卡又回来：先撤隐藏计划
    const c = curRef.current;
    if (!c) {
      if (errKeys.has(target.key)) return; // 无源卡（音频类/失败）：会话内不出预览
      setTimer('open', () => activate(target), OPEN_DELAY);
    } else if (c.key !== target.key) {
      setTimer('swap', () => activate(target), SWAP_DELAY);
    } else {
      // 同一张卡折返（常见于淡出中途回卡）：撤卸载计时并拉回可见；
      // 无限滚动重挂载会换 DOM 节点，顺手把锚换新（旧节点失联会被误判收层）
      if (target.el && c.el !== target.el) c.el = target.el;
      clearTimer('fade');
      shownRef.current = true;
      setShown(true);
    }
  }, [target, activate, scheduleHide, setTimer, clearTimer]);

  // ===== 媒体流水线：取流 → 挂流 → 起播（保温续播）；换源/卸载先毁后建 =====
  useEffect(() => {
    if (!cur) return;
    const epoch = ++epochRef.current;
    // 每轮重置控制条状态（新卡新气象：回零、静音；t/buf 已不进 React，见 paintProgress）
    setMode('resolving');
    modeRef.current = 'resolving';
    setVidReady(false);
    setDur(0);
    setChrome(false);
    setMuted(true);
    const v0 = videoRef.current;
    if (v0) {
      v0.muted = true;
      try { v0.currentTime = 0; } catch (_e) { /* 摘源后个别浏览器会抛，忽略 */ }
    }
    // 进度条直写归零：换卡不闪上一卡的进度残影。不走 paintProgress——它读的是
    // video 元素实况，旧源的 buffered 在新源挂上前还留在元素上，清 0 更稳
    if (playedRef.current) playedRef.current.style.width = '0%';
    if (bufferedRef.current) bufferedRef.current.style.width = '0%';

    let hls = null; // 登记前的半成品引用（cleanup 兜底销毁）
    (async () => {
      try {
        const src = await resolveSrc(cur.site, cur.id);
        if (epoch !== epochRef.current || !videoRef.current) return;
        // Safari 原生 HLS 优先（省一份 MSE 开销 + 不必拉 hls.js）；其余走 hls.js
        // 动态加载（asyncRoutes 分包后 hls.js 独立 chunk，不进首屏；模块 Promise
        // 全 App 共享，见 lib/lazy-hls.js）
        if (src.type === 'hls' && !videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
          const Hls = await loadHls();
          if (epoch !== epochRef.current || !videoRef.current) return; // 加载期间已换卡/收层
          if (!Hls.isSupported()) throw new Error('当前环境不支持 HLS 播放');
          hls = new Hls({ maxBufferLength: 10 }); // 预览短缓冲，省流量
          let recovered = false;
          hls.on(Hls.Events.ERROR, (_evt, data) => {
            if (epoch !== epochRef.current || !data || !data.fatal) return;
            if (!recovered) {
              // 致命错误先恢复一次（对齐主播放器预算），二次直接收层（预览不打扰）
              recovered = true;
              if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
              else hls.startLoad();
              return;
            }
            // 二次仍挂：缓存里大概率是过期死链（签名时效 < TTL 时会出现），删项
            // 让下次悬停重新解析，而不是整个会话反复喂同一条死链
            srcCache.delete(cur.site + ':' + cur.id);
            hideNow();
          });
          hls.loadSource(src.url);
          hls.attachMedia(videoRef.current);
          hlsRef.current = hls;
        } else {
          videoRef.current.src = src.url; // mp4 直挂 / Safari 原生 HLS
        }
        if (epoch !== epochRef.current) return;
        // 保温续播：30s 内回同卡，从上次进度接着放
        const warm = posCache.get(cur.key);
        if (warm && Date.now() < warm.exp) {
          posCache.delete(cur.key);
          try { videoRef.current.currentTime = warm.t; } catch (_e) { /* 忽略 */ }
        }
        setMode('playing');
        modeRef.current = 'playing';
        videoRef.current.play().catch(() => {}); // 静音自动播；被拒停在封面态不强求
      } catch (_e) {
        if (epoch === epochRef.current) {
          errKeys.add(cur.key); // 无源/解析失败：会话内拉黑，不再重试（音频类卡）
          hideNow(); // 静默收层，不出错误 UI（对齐 YouTube：无预览可用就不出）
        }
      }
    })();

    return () => {
      epochRef.current++; // 本轮作废（后续无新 effect 时，在途异步链也全部失效）
      if (hls && hls !== hlsRef.current) {
        try { hls.destroy(); } catch (_e) { /* 忽略 */ }
      }
      if (hlsRef.current) {
        try { hlsRef.current.destroy(); } catch (_e) { /* 忽略 */ }
        hlsRef.current = null;
      }
      const el = videoRef.current;
      if (el) {
        // 保温：正常播过的卡记下进度，30s 内回来自动续
        if (el.currentTime > 2 && isFinite(el.duration)) {
          posCache.set(cur.key, { t: el.currentTime, exp: Date.now() + 30000 });
          if (posCache.size > POS_MAX) posCache.delete(posCache.keys().next().value);
        }
        try { el.pause(); } catch (_e) { /* 忽略 */ }
        el.removeAttribute('src');
        try { el.load(); } catch (_e) { /* 忽略 */ }
      }
    };
  }, [cur, hideNow]);

  // 锚定几何的落地应用（几何计算 geoOf 见上，含页面坐标锚定零滞后的原因）：
  // 仅坐标真正变化才 setState，窗口滚动下 geoOf 算出的页面坐标不变，写入是零开销 no-op
  const place = useCallback(() => {
    const g = geoOf();
    if (!g) return;
    setPos((p) =>
      p.left === g.left && p.top === g.top && p.width === g.width && p.radius === g.radius
        ? p
        : g
    );
  }, [geoOf]);

  // cur/宽度/阶段变化后、绘制前定位；页面滚动跟随由页面坐标锚定原生完成（见 geoOf）
  useLayoutEffect(() => {
    if (cur) place();
  }, [cur, pos.width, phase, place]);

  // 指针位置采集（仅存坐标）：滚动时鼠标未动，「指针离卡即收层」判定的依据
  useEffect(() => {
    const onP = (e) => { pointerRef.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener('pointermove', onP, { passive: true });
    return () => window.removeEventListener('pointermove', onP);
  }, []);

  // 挂载期间（含淡出的 150ms）：滚动监听只做三件事——离卡判定收层、resize/
  // 内部滚动容器/扩展钳制的命令式校正。页面滚动跟随本身零 JS（页面坐标锚定，
  // 见 geoOf）：窗口滚动下 geoOf 算出的页面坐标不变，写入是零开销 no-op。
  // 监听绝不能在淡出开始就撤——淡出中的面板仍要随内容一起滑走，冻在原地盖住
  // 顶栏/邻卡正是滚动拖影的另一半根因（此前 shown=false 即摘监听）
  useEffect(() => {
    if (!cur) return;
    const onMove = () => {
      const c = curRef.current;
      if (!c) return;
      setFlip(null); // 跟随必须瞬时：残留的 FLIP 反演量会把面板钉在旧位置，同属拖影
      const panel = panelRef.current;
      const g = geoOf();
      if (panel && g) {
        panel.style.transition = 'opacity 150ms';
        panel.style.left = g.left + 'px';
        panel.style.top = g.top + 'px';
        panel.style.width = g.width + 'px';
        panel.style.borderRadius = g.radius + 'px';
      }
      // 鼠标没动而卡片被滚走（滚轮/惯性/轨道翻页）：指针已不在锚卡（含扩展外扩缘），
      // 立即收层——继续等宽限只会留一个淡出中的浮层盖在页面 chrome 上
      if (panel && c.el && c.el.isConnected) {
        const r = c.el.getBoundingClientRect();
        const p = pointerRef.current;
        const m = phaseRef.current === 'expanded' ? BLEED + 4 : 2;
        if (!p || p.x < r.left - m || p.x > r.right + m || p.y < r.top - m || p.y > r.bottom + m) {
          hideNow();
        }
      }
    };
    window.addEventListener('scroll', onMove, { capture: true, passive: true });
    window.addEventListener('resize', onMove);
    const guard = setInterval(() => {
      const c = curRef.current;
      if (c && (!c.el || !c.el.isConnected)) hideNow();
    }, 800);
    return () => {
      window.removeEventListener('scroll', onMove, { capture: true });
      window.removeEventListener('resize', onMove);
      clearInterval(guard);
    };
  }, [cur, geoOf, hideNow]);

  // 路由切换：立即收层（浮层不跨页存活）
  useEffect(() => {
    previewClear();
    hideNow();
  }, [pathname, hideNow]);

  // 卸载：清光所有计时器（媒体 teardown 由 cur-effect 的 cleanup 兜底）
  useEffect(() => () => {
    Object.values(timersRef.current).forEach((id) => clearTimeout(id));
    timersRef.current = {};
  }, []);

  // ===== 鼠标桥：扩展面板自身可悬浮（拖进度条时人就在面板里）=====
  const onPanelEnter = useCallback(() => {
    panelHoverRef.current = true;
    clearTimer('hide');
    setChrome(true);
  }, [clearTimer]);
  const onPanelLeave = useCallback(() => {
    panelHoverRef.current = false;
    setChrome(false);
    scheduleHide();
  }, [scheduleHide]);

  // ===== 进度条拖动（仅扩展态；指针捕获，拖动中 100ms 节流 seek，松手落定）=====
  const seekRatio = (ratio) => {
    const v = videoRef.current;
    if (!v || !isFinite(v.duration) || v.duration <= 0) return;
    v.currentTime = Math.min(Math.max(0, ratio), 1) * v.duration;
    paintProgress(); // 拖动即时直写（拖点/气泡/红条），不等 timeupdate 回拍
  };
  const ratioOf = (clientX) => {
    const el = barRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return 0;
    return Math.min(Math.max(0, (clientX - r.left) / r.width), 1);
  };
  const onBarDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_err) { /* 忽略 */ }
    draggingRef.current = true;
    setDragging(true);
    lastSeekRef.current = performance.now();
    seekRatio(ratioOf(e.clientX));
  };
  const onBarMove = (e) => {
    if (!draggingRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const now = performance.now();
    if (now - lastSeekRef.current >= 100) {
      lastSeekRef.current = now;
      seekRatio(ratioOf(e.clientX));
    }
  };
  const onBarUp = (e) => {
    if (!draggingRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_err) { /* 忽略 */ }
    draggingRef.current = false;
    setDragging(false);
    seekRatio(ratioOf(e.clientX)); // 松手落定最后一格
  };

  // 静音切换（预览默认静音；点击不得触发外层进观看页跳转）
  const toggleMute = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };

  // 点击面板 = 深链观看页（与卡片点击行为一致）；进度条/静音钮自行
  // preventDefault + stopPropagation 拦截。NextWeb 是 Link + rememberCardAuthor，
  // RN 侧经 useOpenVideo 统一跳转（作者随行记忆模块 RN 侧无对应物，跳过）
  const goWatch = (e) => {
    e.preventDefault();
    goVideo(cur.site, cur.id);
  };

  // 起播补挂：到点未起播的扩展，等首帧就绪再扩（对齐 YouTube：扩展必在播放中）
  const onStarted = () => {
    setVidReady(true);
    if (pendingExpandRef.current) {
      pendingExpandRef.current = false;
      expandNow();
    }
  };

  if (!cur) return null;

  const expanded = phase === 'expanded';
  const seekable = mode === 'playing' && dur > 0 && isFinite(dur);
  const barHot = expanded && (barHover || dragging); // 进度条悬浮/拖动态
  const durText = fmtDur(cur.v && cur.v.duration);

  return createPortal(
    // 层级：zIndex 20 只盖内容层（卡片/网格），一切 chrome 之下——AppShell 抽屉/
    // 遮罩层（z-40/z-50）都在其上；滚动拖走卡片时浮层随内容一起滑到 chrome 底下，
    // 而不是浮在 chrome 上面。
    // 包裹层 = absolute 全屏（页面坐标，document 原点起）：面板随文档滚动由合成器
    // 与卡片同帧搬运；fixed 包裹层则整层钉死在视口，要 JS 逐 scroll 事件追卡片，
    // 主线程忙时追不上即拖影——勿改回 fixed。原生 DOM 元素 + 内联样式（适配点 1）
    <div style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, zIndex: 20, pointerEvents: 'none' }}>
      <div
        ref={panelRef}
        aria-label="悬浮预览"
        onPointerEnter={onPanelEnter}
        onPointerLeave={onPanelLeave}
        style={{
          position: 'absolute',
          overflow: 'hidden',
          backgroundColor: '#000',
          left: pos.left + 'px',
          top: pos.top + 'px',
          width: pos.width + 'px',
          borderRadius: pos.radius + 'px',
          opacity: shown ? 1 : 0,
          // 内联态整体穿透（点击落进卡片链接，YouTube 同款）；扩展态可交互并浮起
          // （阴影 = shadow-2xl + 1px line 描边环，NextWeb shadow-2xl ring-1 同规格）
          pointerEvents: expanded && shown ? 'auto' : 'none',
          boxShadow: expanded && shown
            ? '0 0 0 1px ' + C.line + ', 0 25px 50px -12px rgba(0,0,0,0.25)'
            : 'none',
          // 几何动画只走 transform（FLIP，见 expandNow）：left/top/width 恒为终位瞬时值、
          // 绝不进 transition（过渡布局属性每帧强制重排，与在跑的视频解码叠载即低端机
          // 掉帧）。flip 为反演量：首帧（play=false）transform 反演回起点、不带过渡；
          // 放行帧过渡回 none。换卡/滚动时 flip 已清空、transform 移除，跟随瞬时。
          transform: !flip ? undefined : flip.play ? 'none' : 'translate(' + flip.dx + 'px, ' + flip.dy + 'px) scale(' + flip.s + ')',
          transformOrigin: flip ? '0 0' : undefined,
          transition: flip && flip.play ? 'opacity 150ms, transform 200ms ease-out' : 'opacity 150ms',
        }}
      >
        {/* 点击面板 = 进观看页（expo-router 深链，见 goWatch）。
            进度条/静音钮自行 preventDefault + stopPropagation 拦截 */}
        <div onClick={goWatch} style={{ display: 'block', cursor: 'pointer' }}>
          {/* 视频区：16:9；封面垫底（取流中保持卡片原样，YouTube 同款无加载指示），
              首帧起播后 video 淡入盖住 */}
          <div style={{ position: 'relative', aspectRatio: '16 / 9', width: '100%' }}>
            {cur.v && cur.v.cover ? (
              <img
                src={cur.v.cover}
                alt=""
                draggable={false}
                style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : null}
            <video
              ref={videoRef}
              muted={muted}
              loop
              playsInline
              preload="metadata"
              style={{
                position: 'absolute', left: 0, top: 0, width: '100%', height: '100%',
                objectFit: 'cover', transition: 'opacity 200ms', opacity: vidReady ? 1 : 0,
              }}
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                if (v.currentTime > 0 && !vidReady) onStarted();
                // 高频（~4 拍/秒）：直写 DOM 不进 React（此前每拍 setT 整层重渲染）；
                // 拖动中不回写，由 seekRatio 即时直写接管
                if (!draggingRef.current) paintProgress();
              }}
              onPlaying={() => onStarted()}
              onDurationChange={(e) => {
                const d = e.currentTarget.duration;
                setDur(d && isFinite(d) ? d : 0);
                paintProgress(); // 时长就绪：进度百分比按真实时长重算一拍
              }}
              onProgress={() => paintProgress()} // 缓冲区前进：直写缓冲条（不进 React）
            />
            {/* 进度条：内联态 = 底部细红条（纯指示，随面板穿透不可点）；
                扩展态 = 可拖（悬浮加粗出拖点、拖动出时间气泡），触区加高便于抓取 */}
            <div
              ref={barRef}
              onPointerDown={expanded ? onBarDown : undefined}
              onPointerMove={expanded ? onBarMove : undefined}
              onPointerUp={expanded ? onBarUp : undefined}
              onPointerCancel={expanded ? onBarUp : undefined}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onPointerEnter={() => setBarHover(true)}
              onPointerLeave={() => setBarHover(false)}
              style={{
                position: 'absolute', left: 0, right: 0, bottom: 0,
                display: 'flex', alignItems: 'flex-end', touchAction: 'none',
                height: expanded ? 16 : 3,
                padding: expanded ? '0 8px 3px' : 0,
                pointerEvents: expanded && !seekable ? 'none' : undefined,
                opacity: expanded && !seekable ? 0.4 : 1,
              }}
            >
              <div
                style={{
                  position: 'relative', width: '100%', overflow: 'hidden',
                  borderRadius: 9999, backgroundColor: 'rgba(255,255,255,0.25)',
                  transitionProperty: 'height', transitionDuration: '100ms',
                  height: barHot ? 5 : 3,
                }}
              >
                {/* 缓冲/播放进度宽度由 paintProgress 直写（不进 React 状态），
                    元素跨卡常驻不重挂，无初值闪烁问题 */}
                <div ref={bufferedRef} style={{ height: '100%', backgroundColor: 'rgba(255,255,255,0.3)' }} />
                <div ref={playedRef} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, backgroundColor: C.accent }} />
              </div>
              {barHot && (
                <div
                  ref={(el) => { thumbRef.current = el; if (el) paintProgress(); }} // 挂载即补一拍定位
                  style={{
                    position: 'absolute', bottom: -2, width: 12, height: 12,
                    transform: 'translateX(-50%)', borderRadius: 9999,
                    backgroundColor: C.accent, boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                  }}
                />
              )}
            </div>
            {/* 拖动时间气泡：拖动中显示在拖点上方；位置与「当前/总时长」文本由
                paintProgress 直写（children 恒空——React 没有可 diff 的子节点，
                不会在重渲染时覆写直写进去的文本） */}
            {dragging && dur > 0 && (
              <div
                ref={(el) => { bubbleRef.current = el; if (el) paintProgress(); }}
                style={{
                  pointerEvents: 'none', position: 'absolute', bottom: 24,
                  transform: 'translateX(-50%)', borderRadius: 4,
                  backgroundColor: 'rgba(0,0,0,0.8)', padding: '2px 6px',
                  fontSize: 11, lineHeight: '16px', fontVariantNumeric: 'tabular-nums',
                  color: '#fff', whiteSpace: 'nowrap',
                }}
              />
            )}
            {/* 时长角标：内联态视频盖住了卡片自己的角标，补一枚同规格的
                （卡片角标实测：12px/500、bg rgba(0,0,0,.6)）；扩展态由播放器接管不重复出 */}
            {!expanded && durText && (
              <span
                style={{
                  pointerEvents: 'none', position: 'absolute', bottom: 4, right: 4,
                  borderRadius: 4, backgroundColor: 'rgba(0,0,0,0.6)', padding: '1px 4px',
                  fontSize: 12, fontWeight: 500, lineHeight: '18px',
                  fontVariantNumeric: 'tabular-nums', color: '#fff',
                }}
              >
                {durText}
              </span>
            )}
            {/* 静音钮：仅扩展态 + 指针在面板内时出现（右下角，进度条上方） */}
            {expanded && chrome && (
              <button
                type="button"
                aria-label={muted ? '取消静音' : '静音'}
                onClick={toggleMute}
                style={{
                  position: 'absolute', bottom: 16, right: 8, borderRadius: 9999,
                  backgroundColor: 'rgba(0,0,0,0.5)', padding: 6,
                  color: 'rgba(255,255,255,0.9)', border: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <VolIcon muted={muted} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
