// ============================================================================
// router-params.js —— expo-router 路由参数防御式归一(页面共用小工具)
// ----------------------------------------------------------------------------
// expo-router 的 useLocalSearchParams 对重复参数返回 string[],单值为 string,
// 缺参为 undefined——页面消费前一律经 one() 归一成 string(缺参 '')。原先
// board/category/search/telegram 各页自持同款拷贝,这里落一份共享导出(既有
// 页面的本地拷贝不动,新页面从这里拿)。
// ============================================================================
export function one(v) {
  const x = Array.isArray(v) ? v[0] : v;
  return x == null ? '' : String(x);
}

export default one;
