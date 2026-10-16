// ============================================================================
// 收藏域端点:/api/fav/*(仅 Node 服务端运行)
// ----------------------------------------------------------------------------
// 全局共享收藏清单(无账号无设备概念,所有端同一份)的读写面。数据面唯一
// 实现 = src/lib/fav-service.js(MySQL 唯一持久层 + Redis mnt:fav:all 热缓存):
//   GET  /ids                        → { ids:["site:id"...按收藏时间倒序], total, at }
//   GET  /list?page=&size=&site=&kw= → { items:[{site,id,title,cover,duration,hd,at}],
//                                        page, size, hasMore, total }
//                                        (cover 可能是 /api/img/... 相对路径,
//                                         展示层负责 absolutize,本层原样存取)
//   POST /toggle {site,id,title?,cover?,duration?,hd?} → { fav:0|1, total }
//                                        (已收藏→删除回 fav:0;未收藏→插入/更新
//                                         快照回 fav:1;全局上限 5000,超限 400)
//   POST /remove { keys:["site:id",...] } → { removed, total }
//   POST /clear                           → { total: 0 }
//
// 注册顺序红线(routes/index.js):本路由必须在 telegramExtrasRouter 之后、
// siteMethodRouter 之前挂载——五个端点均为两段静态路径(/fav/xxx),晚于兜底
// /:site/:method 注册的话会被按 site='fav' 抢先匹配成「未知站点」404
// (与 routes/telegram.js 头注同一条红线)。
//
// 校验契约:site=/^[0-9A-Za-z_-]{1,32}$/、vid=/^[0-9A-Za-z_.:-]{1,64}$/,
// 非法一律 400;title 截 512 字符、cover 截 1024(入参容错截断,不报错)。
//
// 错误契约:一切异常回 {__err:1,message}(中文)。业务 4xx(非法参数/超上限,
// 带 status)保原状态码;MySQL 不可用(db.js 包装错误,无 status)统一 503
// 「收藏服务暂不可用」——收藏是持久化数据,连不上绝不装作成功。Redis 故障
// 由 redis.js 静默降级(直查 MySQL),到不了错误出口。进程绝不因收藏域崩溃。
// 全部响应 Cache-Control:no-store(个人清单,非公共资产,禁任何层缓存)。
// ============================================================================

import Router from '@koa/router';
import { favIds, favList, favToggle, favRemove, favClear } from '../lib/fav-service.js';

export const favRouter = new Router({ prefix: '/fav' });

// 带 HTTP 状态的错误(catch 统一按 err.status||503 回包)
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// 入参正则(契约红线):site 段与 vid 段的合法字符集/长度
const SITE_RE = /^[0-9A-Za-z_-]{1,32}$/;
const VID_RE = /^[0-9A-Za-z_.:-]{1,64}$/;

// 数字参数安全转换:非法/非正数给默认值(与 site-method.js 同款语义)
function intParam(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}

// POST body 门禁:必须是 JSON 对象(app 级 koa-bodyparser 已解析;缺 body /
// 数组 / 原始类型一律 400,不进业务层。与 routes/telegram.js 的 jsonBody 同款)
function jsonBody(ctx) {
  const b = ctx.request && ctx.request.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw httpError(400, '请求体必须是 JSON 对象');
  }
  return b;
}

// 统一错误出口:业务 4xx(带 status)保原状态码与文案;其余(即 MySQL 故障,
// db.js 包装错误无 status)统一 503 固定文案,并留一条终端日志供排障
function fail(ctx, e) {
  const biz = e && e.status;
  if (!biz) console.error(`[收藏] 服务异常:${(e && e.message) || e}`);
  ctx.status = biz || 503;
  ctx.type = 'application/json';
  ctx.set('Cache-Control', 'no-store');
  ctx.body = { __err: 1, message: biz ? e.message : '收藏服务暂不可用' };
}

// ============ 读侧:ids / list ============

// 全量 key 清单(site:id 倒序;前端收藏按钮的批量打点数据源)
favRouter.get('/ids', async (ctx) => {
  try {
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    ctx.body = await favIds();
  } catch (e) { fail(ctx, e); }
});

// 分页清单:site 精确过滤 + 标题 kw 大小写不敏感过滤,过滤/分页全在服务层
// 内存做(过滤语义交给 fav-service 与缓存数组同源,路由层只管入参收敛)
favRouter.get('/list', async (ctx) => {
  try {
    const q = new URLSearchParams(ctx.querystring);
    const page = intParam(q.get('page'), 1);
    const size = Math.min(100, intParam(q.get('size'), 24)); // size 上限 100
    const site = q.get('site') || '';
    if (site && !SITE_RE.test(site)) throw httpError(400, '参数 site 非法:' + site);
    const kw = q.get('kw') || '';
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    ctx.body = await favList({
      page,
      size,
      site: site || undefined,
      kw: kw || undefined,
    });
  } catch (e) { fail(ctx, e); }
});

// ============ 写侧:toggle / remove / clear(POST,请求体走 bodyParser) ============

// 收藏开关:已收藏→删除回 fav:0;未收藏→插入/更新快照回 fav:1
favRouter.post('/toggle', async (ctx) => {
  try {
    const b = jsonBody(ctx);
    const site = String(b.site == null ? '' : b.site);
    const vid = String(b.id == null ? '' : b.id);
    if (!SITE_RE.test(site)) throw httpError(400, '参数 site 非法:' + (site || '(空)'));
    if (!VID_RE.test(vid)) throw httpError(400, '参数 id 非法:' + (vid || '(空)'));
    // 快照字段容错截断:title 512 / cover 1024(契约上限,超长截断不报错)
    const title = b.title == null ? '' : String(b.title).slice(0, 512);
    const cover = b.cover == null ? '' : String(b.cover).slice(0, 1024);
    // duration 非法/缺省统一 null(契约「整数秒|null」),hd 任意真值归 1
    const durNum = Number(b.duration);
    const duration = b.duration == null || !Number.isFinite(durNum)
      ? null
      : Math.max(0, Math.round(durNum));
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    ctx.body = await favToggle({
      site,
      vid,
      title,
      cover,
      duration,
      hd: b.hd ? 1 : 0,
    });
  } catch (e) { fail(ctx, e); }
});

// 批量删除:keys 为 "site:id" 数组(site 字符集不含 ':',首个冒号即分隔,
// vid 允许含 ':' 因此不按 split 切,取首个冒号前后两段分别校验)
favRouter.post('/remove', async (ctx) => {
  try {
    const b = jsonBody(ctx);
    if (!Array.isArray(b.keys)) throw httpError(400, '参数 keys 必须是字符串数组');
    const pairs = [];
    for (const raw of b.keys) {
      const k = String(raw == null ? '' : raw);
      const i = k.indexOf(':');
      const site = i > 0 ? k.slice(0, i) : '';
      const vid = i >= 0 ? k.slice(i + 1) : '';
      if (!SITE_RE.test(site) || !VID_RE.test(vid)) {
        throw httpError(400, '收藏 key 非法:' + (k || '(空)'));
      }
      pairs.push({ site, vid });
    }
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    ctx.body = await favRemove(pairs);
  } catch (e) { fail(ctx, e); }
});

// 清空收藏(危险操作由前端二次确认;服务端无条件全删)
favRouter.post('/clear', async (ctx) => {
  try {
    ctx.type = 'application/json';
    ctx.set('Cache-Control', 'no-store');
    ctx.body = await favClear();
  } catch (e) { fail(ctx, e); }
});
