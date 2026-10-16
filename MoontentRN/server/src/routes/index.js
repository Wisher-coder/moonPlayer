// ============================================================================
// /api 路由总装:把五个子路由(清单 / 图片代理 / Telegram 专属 / 收藏域 /
// 统一分发)挂到同一前缀下
// ----------------------------------------------------------------------------
// 注册顺序即匹配优先级——@koa/router 嵌套时子路由层被摊平进同一栈按注册序
// 匹配,首个命中且不调 next() 的层胜出:
//   ① 单段 /sites 与两段路由天然互不冲突;
//   ② 两段静态路径 /img/:site 必须先于兜底的 /:site/:method 注册(与 Next.js
//      目录路由 /api/img/[site] 优先于 /api/[site]/[method] 的静态段优先
//      语义一致);
//   ③ Telegram 专属端点 /telegram/session|login|verify|password|cancel|
//      logout|dialogs|videos|messages|message|send|callback|vote|read|stream
//      同理是两段静态路径,必须夹在 imgRouter
//      之后、siteMethodRouter 之前——晚于兜底网关注册会被按 site='telegram'
//      抢先匹配成「未知站点」404。
//   ④ 收藏域端点 /fav/ids|list|toggle|remove|clear 同理是两段静态路径,
//      必须夹在 telegramExtrasRouter 之后、siteMethodRouter 之前——晚于兜底
//      网关注册会被按 site='fav' 抢先匹配成「未知站点」404。
// ============================================================================

import Router from '@koa/router';
import { sitesRouter } from './sites.js';
import { imgRouter } from './img.js';
import { telegramRouter } from './telegram.js';
import { telegramExtrasRouter } from './telegram-extras.js';
import { favRouter } from './fav.js';
import { siteMethodRouter } from './site-method.js';

export const apiRouter = new Router({ prefix: '/api' });
apiRouter.use(sitesRouter.routes());
apiRouter.use(imgRouter.routes());
apiRouter.use(telegramRouter.routes());
apiRouter.use(telegramExtrasRouter.routes()); // Telegram 增量端点(引擎-扩展):紧随 telegramRouter、先于兜底网关(注册顺序红线)
apiRouter.use(favRouter.routes()); // 收藏域端点(两段静态路径 /fav/xxx):必须在 siteMethodRouter 之前挂载——晚于兜底 /:site/:method 注册会被按 site='fav' 抢成「未知站点」404(注册顺序红线,见文件头 ④)
apiRouter.use(siteMethodRouter.routes());
