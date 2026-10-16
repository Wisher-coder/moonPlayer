// ============================================================================
// use-dimensions.js —— 水合安全的 useWindowDimensions 替身
// ----------------------------------------------------------------------------
// 动机：SSG 导出时 RN-web 的 Dimensions.get('window') 恒为 {width:0,height:0}
// （无 DOM 环境），静态 HTML 全按 0 尺寸渲染；客户端首帧若直接取真实窗口
// 尺寸，与 HTML 必然不一致 → React 水合失败（#418）整树丢弃重渲、控制台
// 大量报错。本钩子在 web 首帧恒返回 0 尺寸（与 SSG 完全一致），挂载 effect
// 后放行真实值（受控的一次重渲）。native 无 SSG，恒为真实值。
// 全站需要窗口尺寸的组件一律经本钩子（或 lib/use-form.js，其内部同源），
// 不要直接 import react-native 的 useWindowDimensions。
// ============================================================================
import { useEffect, useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';

export function useDimensions() {
  const real = useWindowDimensions();
  const isWeb = Platform.OS === 'web';
  const [live, setLive] = useState(!isWeb);
  useEffect(() => {
    if (!live) setLive(true);
  }, [live]);
  if (!isWeb || live) return real;
  return { width: 0, height: 0, scale: real.scale, fontScale: real.fontScale };
}

export default useDimensions;
