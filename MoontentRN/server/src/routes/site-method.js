// ============================================================================
// 统一分发网关:GET /api/:site/:method?参数 → 站点插件方法
// ----------------------------------------------------------------------------
// (自 NextWeb/app/api/[site]/[method]/route.js 1:1 移植,语义零改动)
// 方法与参数:
//   meta     → {id,name,capabilities}
//   home / categories / hotwords / tags
//   boards → 首页板块清单(仅 boards 能力站点)   board?id&tab&page&size → 板块取数
//   detail?id   play?id
//   list?page&size&sort&category   search?kw&page&size   related?id&page&size
//   package?id → 量贩包整包片单(仅含羞草,detail 的 packageId 指向的包)
//   dvds?page&size   bydvd?dvd&page&size   bytag?tag&page&size
//   三区面(仅 zones 能力站点,前端按 caps.zones 门控):
//     subjects?page&size   bysubject?subject&sort&page&size   packages?page&size
//     gathers?page&size    gather?id → 合集整包片单(形态同 package)
//   author?id → 作者资料(仅 author 能力站点)   byauthor?author&page&size → 作者片单
//   authors?page&size&group → 作者/女优目录(仅 authors 能力站点,group=站点自有分档)
//   playlist?id → 仅切片型站点:回 m3u8 文本,其他站点 404
//   seg?u=… → 切片/密钥流式中转(仅切片型无 CORS 站点)
//   相册面(仅 albums 能力站点,前端按 caps 门控):
//     albums?page&size&category   albumcats   album?id   albumsearch?kw&page&size
// 错误约定沿用旧网关:未知站点/方法 404 {__err:1,message};一切异常 502 {__err:1,message}
//
// —— 结果缓存(NextWeb 同款):本站无账号无个性化,/api 响应即公共资产,统一走
//   src/lib/api-cache.js 的进程内 LRU(300 条 / ~8MB 双维度上限,同 key
//   在途去重):META 档 5min / LIST 档 30s(见下表),命中零上游链路(AES 解密/
//   bf 网关登录/WAF 挑战/HTML 爬取全免),可缓存响应同步下发 public Cache-Control。
//   账号型站源例外(插件声明 accountBound=true,如 telegram):响应按登录账号
//   个性化、登出/换号即失效——不进公共缓存、不下发 public 头,统一 no-store
//   (与 routes/telegram.js 专属端点同口径)。
// ============================================================================

import { Readable } from 'node:stream';
// 注:telegram 等账号型站源(accountBound)不做来源门禁(2026-10-10 用户决定
// 个人部署全部放行),仅保留 accountBound 的缓存豁免(见上方注释与 190 行起)
import Router from '@koa/router';
import { getPlugin } from '../plugins/registry.js';
import { cachedGet, TTL_META, TTL_LIST } from '../lib/api-cache.js';
// getPlugin 为 async:静态站同步命中,zy_ 前缀的资源站插件群异步合并(cms/)

// 可缓存方法 → TTL 档(方法不在表内 = 不缓存):
//   META 档 5min:结构面(首页/分类树/热词/标签表/各类目录页),上游变化慢;
//   LIST 档 30s:列表/搜索/详情/整包片单等内容面——站方新片晚半分钟可见,
//     刻意的新鲜度权衡,换来热门页 30s 内全体访客零上游成本。
// 不缓存:meta(插件常量拼装,回包极小)、play(插件层已有会话/清单级缓存与
//   鉴权时效,双层缓存徒增内存无收益)、playlist/seg(非 JSON 直通分支,
//   在缓存包裹之前提前分流,响应头保持原样)。
const CACHE_TTL = {
  home: TTL_META, categories: TTL_META, hotwords: TTL_META, tags: TTL_META,
  boards: TTL_META, authors: TTL_META, albumcats: TTL_META, dvds: TTL_META,
  subjects: TTL_META, packages: TTL_META, gathers: TTL_META,
  board: TTL_LIST, list: TTL_LIST, search: TTL_LIST, related: TTL_LIST,
  detail: TTL_LIST, bydvd: TTL_LIST, bytag: TTL_LIST, bysubject: TTL_LIST,
  byauthor: TTL_LIST, albums: TTL_LIST, album: TTL_LIST, albumsearch: TTL_LIST,
  author: TTL_LIST, gather: TTL_LIST, package: TTL_LIST,
};

// 数字参数安全转换:非法/非正数给默认值
function intParam(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}

// 分发层 4xx(未知方法/能力不支持):数据产出抽成 producer 函数(供缓存层
// 包裹)后,这些分支从「提前回响应」改为 throw 冒泡到统一 catch 转回
// 404——throw 语义天然保证错误绝不被缓存层留住,错误响应与原先一致
class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// —— seg 同键在途去重(只共享「等上游响应头」阶段)——
// 形态:双窗/多端同时开同一部片、hls.js 重试风暴时,同 (site,u,Range) 的并发
// 请求在「上游响应头还在路上」的窗口内只打一次上游,后来者共享同一在途
// Promise(api-cache/img.js 的同 key 防惊群同源语义);响应头回来后响应体由
// 发起者独享流式直发,共享者循环一圈变发起者各自现拉。刻意不 tee 分发/不攒
// 整段:部署机 systemd MemoryMax=550M,tee 的未读分支会为每个在途段攒一份
// 完整拷贝,满墙 16 路峰值 +30~80MB 得不偿失;且墙内各格是不同视频,段级
// 撞车本就罕见。上游失败:发起者原样上抛 502,共享者自拉一次再认栽(保留
// 各请求独立失败语义)。循环设 3 圈上限防极端抖动下活锁。
const SEG_DEDUP_MAX_SPIN = 3;
const segInflight = new Map(); // 'site|range|u' → Promise<out>(settle 即出表)

async function segSharedFetch(ctx, plugin, site, u) {
  const range = ctx.get('range') || null;
  const key = site + '|' + (range || '') + '|' + u;
  for (let spin = 0; ; spin++) {
    let p = segInflight.get(key);
    const created = !p;
    if (created) {
      p = plugin.seg(u, { range }).finally(() => {
        if (segInflight.get(key) === p) segInflight.delete(key); // settle 即出表
      });
      segInflight.set(key, p);
    }
    let out;
    try {
      out = await p;
    } catch (e) {
      if (!created && spin < SEG_DEDUP_MAX_SPIN) continue; // 共享到失败:自己现拉一次
      throw e; // 发起者(或自拉仍失败):上抛走统一 502
    }
    if (!created && spin < SEG_DEDUP_MAX_SPIN && out && out.body) {
      continue; // 响应体已被发起者领走:循环去自己发起(此刻条目已出表,必成发起者)
    }
    ctx.status = out.status;
    ctx.set('Content-Type', out.contentType);
    ctx.set('Cache-Control', 'public, max-age=86400');
    ctx.set('Access-Control-Allow-Origin', '*');
    if (out.contentRange) ctx.set('Content-Range', out.contentRange);
    // 上游 304 等空体场景 body 可能为 null:直接给空体,不构造流
    ctx.body = out.body ? Readable.fromWeb(out.body) : null;
    return;
  }
}

export const siteMethodRouter = new Router();

siteMethodRouter.get('/:site/:method', async (ctx) => {
  try {
    const { site, method } = ctx.params;
    const plugin = await getPlugin(site);
    if (!plugin) {
      ctx.status = 404;
      ctx.type = 'application/json';
      ctx.body = { __err: 1, message: '未知站点 ' + site };
      return;
    }
    // 用 WHATWG URLSearchParams 解析原始查询串:与 NextWeb req.nextUrl.searchParams
    // 同一解析口径,缓存键 q.toString() 的编码/顺序也与 NextWeb 侧同构
    const q = new URLSearchParams(ctx.querystring);
    const page = intParam(q.get('page'), 1);
    const size = intParam(q.get('size'), 24);

    // —— 非 JSON 直通分支:在缓存包裹之前提前分流(返回体不是 JSON,与
    // api-cache 的「归一化 JSON 结果缓存」不同构),响应头与行为保持原样 ——
    if (method === 'playlist') {
      // 播放清单合成仅切片型站点支持:回 m3u8 文本(5 分钟公共缓存)。
      // ACAO:*:Chromecast/电视投屏接收端跨源拉清单必需(本域浏览器同源播放不受影响)
      // max-age 必须 ≤ 插件内部清单新鲜期(切片 ?md= 签名分钟级时效):
      // 浏览器缓存一旦盖过服务端新鲜期,hls 致命恢复 startLoad() 与手动重试
      // 都会从 HTTP 缓存拿回同一份死链清单,恢复彻底失效。其余站点缩短到
      // 5 分钟只是多几次小文本请求,无碍。
      if (typeof plugin.playlist !== 'function') {
        ctx.status = 404;
        ctx.type = 'application/json';
        ctx.body = { __err: 1, message: '站点 ' + site + ' 不支持 playlist' };
        return;
      }
      const text = await plugin.playlist(q.get('id'));
      ctx.status = 200;
      ctx.set('Content-Type', 'application/vnd.apple.mpegurl');
      ctx.set('Cache-Control', 'public, max-age=300');
      ctx.set('Access-Control-Allow-Origin', '*');
      ctx.body = text;
      return;
    }
    if (method === 'seg') {
      // 切片/密钥流式中转:仅无 CORS 切片型站点支持;转发 Range(206 透传 Content-Range)。
      // ACAO:*:投屏接收端跨源拉切片/密钥必需(路径白名单仍由各插件自管,不因此变开放代理)。
      // 插件侧 fetch 回的 web ReadableStream 用 Readable.fromWeb 转成 Node 流交给
      // Koa body 直通——不在服务端攒整段,大切片内存占用与首字节延迟都与
      // NextWeb 的流式语义一致;同 (site,u,Range) 在途请求经 segSharedFetch 在
      // 「等上游响应头」窗口内去重(双窗/多端/重试风暴不重复打上游)。
      if (typeof plugin.seg !== 'function') {
        ctx.status = 404;
        ctx.type = 'application/json';
        ctx.body = { __err: 1, message: '站点 ' + site + ' 不支持切片代理' };
        return;
      }
      const u = q.get('u');
      if (!u || !/^https?:\/\//.test(u)) {
        ctx.status = 400;
        ctx.type = 'application/json';
        ctx.body = { __err: 1, message: 'bad u' };
        return;
      }
      // 响应头/空体/错误语义(异常冒泡统一 catch 502)与去重前的直连版完全一致
      await segSharedFetch(ctx, plugin, site, u);
      return;
    }

    // —— 数据面:switch 原样内聚成 producer,可缓存方法整段交给 cachedGet ——
    // 命中未过期直接回缓存;未命中时同 key 并发请求共享同一在途 Promise(上游
    // 链路最重 15s,防惊群);producer 抛错不入缓存、原样上抛走 502/404,失败
    // 语义与无缓存时代一致。key = site|method|searchParams 序列(URLSearchParams
    // 迭代序即 URL 参数出现序,同一客户端请求天然稳定)。
    // 账号型站源(插件声明 accountBound=true,如 telegram):响应按登录账号
    // 个性化,登出/换号即语义失效——跳过「无账号无个性化」假设的公共缓存层
    // (缓存键无账号维度,登出/换号后无法失效、会跨账号串数据),也不下发
    // public Cache-Control,统一 no-store(与专属端点同口径)
    const accountBound = plugin.accountBound === true;
    const ttl = accountBound ? undefined : CACHE_TTL[method];
    const produce = async () => {
      let out;
      switch (method) {
        case 'meta':
          out = { id: plugin.id, name: plugin.name, capabilities: plugin.capabilities };
          break;
        case 'home':
          out = await plugin.home();
          break;
        case 'boards':
          out = await plugin.boards();
          break;
        case 'board':
          out = await plugin.boardList(q.get('id'), { page, size, tab: q.get('tab') || undefined });
          break;
        case 'categories':
          out = await plugin.categories();
          break;
        case 'detail':
          out = await plugin.detail(q.get('id'));
          break;
        case 'play':
          out = await plugin.resolvePlay(q.get('id'));
          break;
        case 'hotwords':
          out = await plugin.hotwords();
          break;
        case 'tags':
          out = await plugin.tags();
          break;
        case 'list':
          out = await plugin.list({
            page,
            size,
            sort: q.get('sort') || undefined,
            category: q.get('category') || undefined,
          });
          break;
        case 'search':
          out = await plugin.search(q.get('kw') || '', { page, size });
          break;
        case 'related':
          out = await plugin.related(q.get('id'), { page, size });
          break;
        case 'package': {
          // 量贩包整包片单(仅含羞草):detail 返回的 packageId 指向的包,观看页选集面板用
          if (typeof plugin.videoPackage !== 'function') {
            throw new ApiError('站点 ' + site + ' 不支持 package', 404);
          }
          out = await plugin.videoPackage(q.get('id'));
          break;
        }
        case 'dvds':
          out = await plugin.dvds({ page, size });
          break;
        case 'bydvd':
          out = await plugin.bydvd(q.get('dvd'), { page, size });
          break;
        case 'bytag':
          out = await plugin.bytag(q.get('tag'), { page, size });
          break;
        case 'subjects':
          out = await plugin.subjects({ page, size });
          break;
        case 'bysubject':
          out = await plugin.bysubject(q.get('subject'), {
            page,
            size,
            sort: q.get('sort') || undefined,
          });
          break;
        case 'packages':
          out = await plugin.packages({ page, size });
          break;
        case 'gathers':
          out = await plugin.gathers({ page, size });
          break;
        case 'gather':
          out = await plugin.gather(q.get('id'));
          break;
        case 'author':
          out = await plugin.author(q.get('id'));
          break;
        case 'byauthor':
          out = await plugin.byauthor(q.get('author'), { page, size });
          break;
        case 'authors':
          out = await plugin.authors({ page, size, group: q.get('group') || undefined });
          break;
        case 'albums':
          out = await plugin.albumList({
            page,
            size,
            category: q.get('category') || undefined,
          });
          break;
        case 'albumcats':
          out = await plugin.albumCategories();
          break;
        case 'album':
          out = await plugin.albumDetail(q.get('id'));
          break;
        case 'albumsearch':
          out = await plugin.albumSearch(q.get('kw') || '', { page, size });
          break;
        default:
          throw new ApiError('未知方法 ' + method, 404);
      }
      return out;
    };
    const { out } = ttl
      ? await cachedGet(site + '|' + method + '|' + q.toString(), ttl, produce)
      : { out: await produce() };
    // 可缓存方法(命中与未命中)统一带公共 Cache-Control,档位与进程内 TTL
    // 同步(30/300 秒):浏览器/中间层复用后连本进程都不必再碰;不可缓存方法
    // (meta/play)保持原样不加头
    if (ttl) ctx.set('Cache-Control', 'public, max-age=' + (ttl / 1000));
    else if (accountBound) ctx.set('Cache-Control', 'no-store'); // 账号型:禁止任何公共缓存复用
    ctx.type = 'application/json';
    ctx.body = out;
  } catch (e) {
    // ApiError = 分发层 4xx(原「未知方法/能力不支持」提前回响应的等价改写)
    ctx.status = e instanceof ApiError ? e.status : 502;
    ctx.type = 'application/json';
    ctx.body = { __err: 1, message: e.message };
  }
});
