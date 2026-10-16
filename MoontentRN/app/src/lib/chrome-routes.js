// ============================================================================
// chrome-routes.js —— 壳层显隐的路由口径（唯一来源，白名单制）
// ----------------------------------------------------------------------------
// 手机画幅下 AppShell 的顶栏/底栏按「页面归属」白名单显示（历史口径是黑名单
// 式只藏 /video/* 与 /search，plugins/telegram/board 等自带「返回+标题」自绘
// 页头的页面全被顶栏叠出双 header，底栏还压住聊天页输入区）：
//   · 顶栏（品牌/搜索/主题钮）只属于首页与「我的」两个门户页；
//   · 底栏只属于 tab 槽位页（BottomNav 可达的六个路由；/search 虽在 (tabs)
//     组但本就沉浸自理，不列内；BottomNav 槽位按站点能力动态增减，本表取
//     超集——槽位被裁减时栏本身仍在，与改造前行为一致）；
//   · 其余页面（board/plugins/telegram×3/package/album/author 及各详情页）
//     顶栏底栏整条收起，页面自绘页头、经 useChromeInsets 自垫安全区。
// pad/PC 画幅不查本表：顶栏流内常驻（沉浸观看收起）、无底栏、侧栏常驻
//（观看页收），Electron 桌面端顶栏兼窗口标题栏——一切维持原状。
// AppShell 的显隐判定与 use-chrome-scroll 的 useChromeInsets 都以本文件为
// 准，勿在别处再手写路由判定（两处口径漂移就是「栏在避让不在」回归的起点）。
// ============================================================================

// 手机画幅保留顶栏的门户页
const TOPBAR_PHONE_ROUTES = new Set(['/', '/mine']);

// 手机画幅保留底栏的 tab 槽位页（(tabs) 组路由超集，不含沉浸自理的 /search）
const TABS_ROUTES = new Set([
  '/',
  '/category',
  '/albums',
  '/authors',
  '/zones',
  '/mine',
]);

// 手机画幅该页是否保留顶栏
export function hasPhoneTopBar(pathname) {
  return TOPBAR_PHONE_ROUTES.has(pathname);
}

// 手机画幅该页是否保留底栏
export function hasPhoneBottomNav(pathname) {
  return TABS_ROUTES.has(pathname);
}

// 观看页（沉浸自理，pad/PC 侧栏/沉浸判定也用）
export function isWatchRoute(pathname) {
  return !!pathname && pathname.startsWith('/video/');
}

// 搜索页（手机端沉浸自理：自绘「返回+输入」头）
export function isSearchRoute(pathname) {
  return pathname === '/search';
}
