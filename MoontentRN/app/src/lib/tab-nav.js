// ============================================================================
// tab-nav.js —— 一级 tab 跳转统一入口
// ----------------------------------------------------------------------------
// 壳层导航（BottomNav / Guide 侧栏 / TopBar）与页内「跳去某 tab」按钮共用。
// 跳转口径（配合 (tabs)/_layout.js 的分组结构）：
//   · tab 上下文（当前就在某个一级 tab 上）→ router.navigate：落在 (tabs) 组
//     内即 JUMP_TO，只切索引不换实例——已挂载 tab 常驻保活，数据/滚动位全留；
//   · 详情上下文（观看页/专辑/女优/包/板块详情、插件管理——压在 (tabs) 组之上
//     的根栈屏）→ router.dismissTo：POP_TO 弹回 (tabs) 组再切目标 tab。此处
//     若用 navigate，根栈会把整个 (tabs) 组当新屏再压一份（组内全部 tab 重
//     新挂载重拉），用 push 同理且还会把详情留在栈底——都是要避开的坑。
// 判定按 pathname 前缀：详情路由清单与 _layout.js 根 Stack 上的非 tab 屏一致。
// ============================================================================
const DETAIL_PREFIXES = ['/video/', '/album/', '/author/', '/package/', '/board', '/plugins'];

// 统一入口：router 传 expo-router 的 router（或 useRouter() 结果），pathname
// 传 usePathname()，href 为 tab 级目标（'/'、'/category?cat=5' 均可）
export function openTab(router, pathname, href) {
  const inDetail = !!pathname && DETAIL_PREFIXES.some((p) => pathname.startsWith(p));
  if (inDetail) router.dismissTo(href);
  else router.navigate(href);
}
