// ============================================================================
// lazy-hls.js —— hls.js 动态加载器（仅被 *.web.js 引用，原生图谱不可达）
// ----------------------------------------------------------------------------
// hls.js 完整版 ~560KB，静态 import 会把它钉进首屏 entry；asyncRoutes 分包后
// 动态 import('hls.js') 成为独立 chunk，只在真正起播 HLS 时按需拉取（文件名
// 带哈希 + 服务器 immutable 长缓存，重复进入零成本）。三个调用点（VideoPlayer /
// HoverPreviewLayer / WallTile 的 .web.js）共享同一份模块级 Promise，并发触发
// 也只有一次网络往返；失败清空缓存，下次起播重新加载（瞬时故障可自愈）。
// ============================================================================
let hlsPromise = null;

export function loadHls() {
  if (!hlsPromise) {
    hlsPromise = import('hls.js')
      .then((m) => m.default)
      .catch((e) => {
        hlsPromise = null;
        throw e;
      });
  }
  return hlsPromise;
}
