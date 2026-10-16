// ============================================================================
// GhRoot.js —— 手势系统根视图（原生实现；web 由同名 .web.js 平台分流顶替）
// ----------------------------------------------------------------------------
// 原生端 GestureDetector 必须包在 GestureHandlerRootView 里（context 注册）。
// 独立成文件 + 平台分流的原因：包根桶（react-native-gesture-handler）会连带
// 再导出 GestureDetector 全套，其 gesture 链静态 require react-native-reanimated
// （reanimatedWrapper），把 reanimated+worklets 运行时（~800KB）钉进首屏
// __common。web 端渲染等价的透传 View（见 .web.js），gesture-handler 桶只由
// PhotoViewer（懒加载）按需引入，reanimated 随之只进相册异步 chunk。
// ============================================================================
import { GestureHandlerRootView } from 'react-native-gesture-handler';

export default GestureHandlerRootView;
