// ============================================================================
// native-player.web.js —— web 占位（Metro 平台分流顶替 native-player.js）
// ----------------------------------------------------------------------------
// web 端共享播放实例是 VideoPlayer.web.js 常驻 Provider 宿主里的 video 元素，
// player-context 的 ensureNativePlayer 在 web 直接 return null，从不调本工厂。
// 提供等形空实现而非 null，防未来误调用处直接崩溃（调用即返回 null，
// 下游按「无共享实例」分支处理）。
// ============================================================================
export function createVideoPlayer() {
  return null;
}
