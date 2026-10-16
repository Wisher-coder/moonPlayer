// ============================================================================
// use-hover-preview.js —— 视频卡悬浮预览接入钩子（RN 三端，真三层架构）
// ----------------------------------------------------------------------------
// 源：NextWeb/src/hooks/use-hover-preview.js。三层架构与 NextWeb 同款：
//   ① lib/hover-preview-store.js（单值联动 store）
//   ② components/video/HoverPreviewLayer.web.js（AppShell 全局唯一浮层，web 专用）
//   ③ 本钩子（卡片侧零逻辑，只把 {site,id,v,缩略图框 el} 写进 store）
// 卡片用法：const { hovered, elRef, onHoverIn, onHoverOut } = useHoverPreview(site, v)
//   - onHoverIn/onHoverOut 挂 Pressable 同名 props（RN-web 支持 hover 事件，
//     native 上这两个回调不会被触发）；
//   - elRef 挂到卡片缩略图 View 的 ref——web 端 RNW 的 View ref 直达 DOM div
//     （VideoPlayer.web.js 同惯例），即浮层锚定用的 DOM 锚点；
//   - hovered 为卡片本地 hover 态（视觉反馈消费方还在），web 且非省流时点亮。
// site 实参为 null 时回退 useSite() 上下文站点（列表卡所在页面即当前站点）；
// 历史卡片等自带 site 的条目显式传入（NextWeb 同款语义）。
// 守卫在事件期惰性判定（设置开关关 / 省流 / 低端 / 触屏 hover:none → 不上报），
// 渲染期不碰存储/matchMedia，零水合负担。native（Platform.OS !== 'web'）恒不
// 上报（无消费者，store 在 native 是死代码）；hovered 本地态同样只在 web 生效。
// ============================================================================
import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useDataSaver } from '../components/ui/cover.js';
import { useSite } from '../lib/site-context.jsx';
import { getSettingsSnapshot } from '../lib/settings.js';
import { previewIn, previewOut } from '../lib/hover-preview-store.js';

// 低端/省流设备集中判定（照 NextWeb settings.js 的 isLowEndDevice 口径；RN 侧
// settings.js 无此集中入口，就近内联在此——只在 web hover 事件里被调用，
// navigator 可安全直用）：
//   ① 用户开了省流模式（settings 契约的 datasaver 键）；
//   ② 浏览器自报系统级省流量开关（navigator.connection.saveData）；
//   ③ 设备内存 <4GB（navigator.deviceMemory，缺省按高端不误伤）。
// 悬浮预览一弹就是拉流 + 起解码，流量与 CPU 双杀，直接判不可预览。
function isLowEndDevice() {
  try {
    if (getSettingsSnapshot().datasaver) return true;
    const conn = typeof navigator !== 'undefined' && navigator.connection;
    if (conn && conn.saveData === true) return true;
    const mem = typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined;
    if (typeof mem === 'number' && mem < 4) return true;
    return false;
  } catch (_e) { return false; }
}

// 可预览判定（事件期惰性求值，照 NextWeb previewable）：
// 设置开关 hover_preview 关 / 低端省流 / 触屏（hover:none 命中）→ false。
// getSettingsSnapshot 为同步内存镜像：水合完成前是默认值（开），最坏多弹一个
// 浮层，水合完成的广播后即对齐本机偏好。环境异常按可用处理（大不了多弹一层）。
function previewable() {
  try {
    if (!getSettingsSnapshot().hover_preview) return false;
    if (isLowEndDevice()) return false;
    return !window.matchMedia('(hover: none)').matches;
  } catch (_e) { return true; }
}

export function useHoverPreview(site, v) {
  const { site: ctxSite } = useSite();
  const sid = site || ctxSite; // site 缺省回退站点上下文（VideoCard 传 null 即此路）
  const saver = useDataSaver(); // 省流（hook 订阅，含 datasaver 键）时不启用
  const elRef = useRef(null); // 挂缩略图 View：web 端即 DOM 锚点，native 端闲置
  const [hovered, setHovered] = useState(false); // 卡片本地 hover 态（视觉反馈消费方）
  // 只在 web 且非省流时启用：native 无鼠标悬停，省流档不做预览类开销
  const enabled = Platform.OS === 'web' && !saver;
  const key = v && v.id != null && sid ? sid + ':' + v.id : null;
  const onHoverIn = useCallback(() => {
    if (!enabled) return;
    setHovered(true); // 本地视觉态照常（即使预览被守卫拦下）
    // 上报全局层：无 key / 守卫不过则不发（快速扫过/触屏/低端不触发弹层）
    if (key && previewable()) previewIn({ key: key, site: sid, id: v.id, v: v, el: elRef.current });
  }, [enabled, key, sid, v]);
  const onHoverOut = useCallback(() => {
    setHovered(false);
    if (key) previewOut(key); // store 带 key 校验：旧卡迟到的 leave 不会误杀新卡
  }, [key]);
  return { hovered, onHoverIn, onHoverOut, elRef };
}

export default useHoverPreview;
