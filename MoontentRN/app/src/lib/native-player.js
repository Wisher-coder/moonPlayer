// ============================================================================
// native-player.js —— native 端共享播放实例工厂（原生实现）
// ----------------------------------------------------------------------------
// player-context 的 ensureNativePlayer 经本模块取 expo-video 的 createVideoPlayer
// 创建跨页不断流的共享实例。抽成独立模块 + .web.js 平台分流，是为了让
// expo-video 只进原生图谱：web 端播放走 VideoPlayer.web.js 的 video 元素
// （hls.js 动态加载），expo-video 的 web 实现纯属静态 import 付账、从未被调用。
// ============================================================================
export { createVideoPlayer } from 'expo-video';
