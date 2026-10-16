// ============================================================================
// menu-window.js —— 播放器菜单独立子窗（owner 侧编排，桌面 Electron 专用）
// ----------------------------------------------------------------------------
// PlayerControls 的倍速/音量/设置弹层在桌面壳里浮出为独立小窗（腾讯视频
// 形态；建窗/摆位/收起在 desktop/main.js 的「菜单独立子窗」区），本文件只
// 做 owner 侧两件事：
//   1) 锚点换算：触发钮 measureInWindow 得视口 CSS 坐标 → 加 window.
//      screenX/screenY（无边框窗内容原点即窗原点，无浏览器铬）、乘
//      outerWidth/innerWidth 比值（吸收 zoomFactor 缩放，默认 1）→ 屏幕
//      DIP 坐标交主进程摆位；
//   2) openMenuWindow：主进程返回 fallback:'local'（macOS 全屏空间不允许
//      他窗悬浮等）时回调 onFallback，调用方回落窗口内弹层。
// prewarmMenuWindow 供 PlayerControls 挂载即调（菜单窗提前整树启动，
// hover 时零延迟）。非桌面/桥异常环境一律回落，绝不抛错。
// ============================================================================
import { Platform } from 'react-native';
import { isDesktopApp, menuWindow } from './desktop-bridge.js';

/** 预热菜单窗（幂等；桌面端 PlayerControls 挂载即调） */
export function prewarmMenuWindow() {
  if (Platform.OS !== 'web' || !isDesktopApp()) return;
  menuWindow.prewarm();
}

/**
 * 打开菜单独立子窗
 * @param {'rate'|'vol'|'settings'} kind 菜单类别
 * @param {{ current: any }} anchorRef 触发钮的 ref（measureInWindow 测锚点）
 * @param {object} state 菜单内容快照（rate/volume/muted/autoplay/multi…，
 *   由 PlayerControls 的 buildMenuState 组装）
 * @param {() => void} [onFallback] 主进程要求回落窗口内弹层时回调（macOS
 *   全屏空间等场景）
 * @returns {Promise<'window'|'local'|'none'>} 实际走向（同步视角按独立窗
 *   处理；fallback 经 onFallback 异步回调，调用方据其回落本地弹层）
 */
export async function openMenuWindow(kind, anchorRef, state, onFallback) {
  if (Platform.OS !== 'web' || !isDesktopApp()) return 'none';
  const el = anchorRef && anchorRef.current;
  if (!el || typeof el.measureInWindow !== 'function') return 'none';
  el.measureInWindow((x, y, w, h) => {
    // 视口 CSS px → 屏幕 DIP：内容原点 = 窗原点（无边框窗无浏览器铬），
    // 比值吸收 zoomFactor（默认 1）
    const scale = window.innerWidth > 0 ? window.outerWidth / window.innerWidth : 1;
    menuWindow
      .show({
        kind,
        anchor: {
          x: window.screenX + x * scale,
          y: window.screenY + y * scale,
          w: (w || 0) * scale,
          h: (h || 0) * scale,
        },
        state,
      })
      .then((r) => {
        if (r === 'local' && typeof onFallback === 'function') onFallback();
      })
      .catch(() => {
        /* 桥异常已在 menuWindow.show 内回落，不会到这 */
      });
  });
  return 'window';
}
