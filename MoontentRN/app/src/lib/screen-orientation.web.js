// ============================================================================
// screen-orientation.web.js —— web 占位（Metro 平台分流顶替 screen-orientation.js）
// ----------------------------------------------------------------------------
// web 端播放器全屏走容器 requestFullscreen（VideoPlayer.web.js）。方向锁在
// 全屏上下文内由 VideoPlayer.web.js 自行尝试（screen.orientation.lock，仅
// Android Chrome 生效；iOS Safari 全系不支持，静默失败）；「锁回竖屏 + 延迟
// 解锁」的 app 级恢复对 web 无意义（浏览器全屏退出即回页面方向）。此处仅
// 提供等形实现 + matchMedia 方向读取（供旋转联动对齐 native 行为）。
// ============================================================================
export function getOrientationAsync() {
  try {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return Promise.resolve(window.matchMedia('(orientation: landscape)').matches);
    }
  } catch (_e) {
    /* 忽略 */
  }
  return Promise.resolve(null);
}

export function lockOrientation() {
  return Promise.resolve();
}

export function lockForVideo() {
  return Promise.resolve();
}

export function restoreAfterFullscreen() {
  /* web 无 app 级方向恢复 */
}

export function subscribeOrientation() {
  return () => {};
}
