// ============================================================================
// HoverPreviewLayer.js —— native 端 stub（悬浮预览层仅 web 端存在）
// ----------------------------------------------------------------------------
// native 端无鼠标悬停（触屏），视频卡悬浮预览只在 web 上有意义：AppShell 以
// 无后缀 import 引入本组件名，metro 平台分流让 web 取 HoverPreviewLayer.web.js
// （真实现），native 取本 stub 返回 null——保证 AppShell 的跨端 import 成立、
// native bundle 零开销（不打包 DOM/hls.js/react-dom 任何一丁点预览代码）。
// export default function HoverPreviewLayer() { return null; } 的写法保持与
// web 版同签名（无 props），将来若需要透传也只动两端各自文件。
// ============================================================================
export default function HoverPreviewLayer() { return null; }
