// ============================================================================
// GhRoot.web.js —— 手势系统根视图（web 占位，Metro 平台分流顶替 GhRoot.js）
// ----------------------------------------------------------------------------
// web 版 GestureHandlerRootView 的实质只是 GestureHandlerRootViewContext.Provider
// + flex:1 的 View；而 GestureDetector 对该 context 的强制校验仅限非 web 平台
// （其源码：__DEV__ && !ctx && Platform.OS !== 'web' 才 throw），web 端没有根
// 视图手势照常工作。故 web 渲染等价布局的透传 View，不引 gesture-handler（避免
// 包根桶静态拖入 reanimated，见 GhRoot.js 头注释）。
// ============================================================================
import { View } from 'react-native';

export default function GhRootView({ children, style }) {
  return <View style={style ?? { flex: 1 }}>{children}</View>;
}
