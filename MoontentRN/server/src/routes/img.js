// ============================================================================
// 图片代理:GET /api/img/:site?u=<图片地址>[&w=320|480|640|960]
// ----------------------------------------------------------------------------
// (自 NextWeb/app/api/img/[site]/route.js 1:1 移植,语义零改动)
// 需要代理的站点在插件内实现 image(u)(yuese/aidou/hanxiucao 封面须服务端解密,
// dsd 忌外部 Referer 明文中转,llw 须站群 Referer,bf 密文头 100B XOR 混淆须解密;
// avjb 封面是裸 CDN 直链不走代理 → 无 image 能力 404),回明文图 1 天公共缓存。
// 解密逻辑(.aes/.ttf/XOR 混淆头等)全部经由 plugin.image(u) 调用插件实例方法,
// 本层不复制任何解密实现。
//
// —— 吞吐防护(全部内聚在本代理层,各插件不感知)——
// 事故形态(NextWeb 2026-10-06 月色站卡死事故):网格页一次涌入 24+ 封面,
// 上游图床在并发突发/隧道拥塞下把请求排队 30~90s(HTTP/1.1 浏览器同源 6 连接
// 上限),图片长请求占满连接槽后,同源的所有 /api/* 数据请求全部排在其后 →
// 页面整体卡死。三层防护让每张图「要么快速完成、要么快速失败」:
//   ① LRU 字节上限缓存——封面在首页/相关/搜索/足迹间大量重复,命中即 0 上游
//      0 解密,直接回内存 Buffer;
//   ② 同键并发去重——同一张图并发到达只发一次上游,其余共享同一 Promise;
//   ③ 每站并发车道(FIFO 排队)——突发 24 张不再同时打到上游图床,逐张快速
//      完成,不给拥塞中的上游加压(车道额度移交式释放)。
// 失败语义不变:上游错/超时 → 502(不缓存失败),卡片侧 onError 降级占位图。
//
// —— sharp 图片管线:宽度档 w + 魔数嗅探 Content-Type ——
//   · Content-Type 按字节魔数嗅探(jpeg/png/webp/gif,未知回退 image/jpeg,
//     绝不 500);
//   · 带 &w=白名单档位时用 sharp 缩宽转 WebP(q72),变体缓存键 = 原图键 + '|w档',
//     与原图各自独立 LRU;上游抓取路径一字不动(变体是纯本地 CPU 处理,不占车道);
//   · 回退链保证「永不劣于现状」:sharp 未装/加载失败、处理抛错、输入是 gif
//     (动图转 WebP 丢动画)→ 一律回原图字节 + 嗅探出的原类型。
//
// —— 缓存验证器:ETag + 304 + stale-while-revalidate ——
// 每个响应带内容哈希强 ETag,客户端重验证命中即 304 空体(0 字节传输);
// stale-while-revalidate=604800 让过期响应先用后验,取回路径不阻塞渲染。
// 哈希按 Buffer 内容算一次(WeakMap 缓存),同图多档变体天然各异。
// ============================================================================

import { createHash } from 'node:crypto';
import Router from '@koa/router';
import { getPlugin } from '../plugins/registry.js';

// 缓存与车道参数:封面多为 10~50KB,64MB/2000 条可容纳整页网格的全部封面+
// 翻页余量;单张超 4MB 不入缓存,防一张驱逐全部
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 2000;
const CACHE_ENTRY_MAX = 4 * 1024 * 1024;
const SITE_CONCURRENCY = 6; // 每站同时在飞的上游图片抓取数上限

// 宽度档白名单(与前端封面档位约定一一对应)。白名单之外的 w(缺省/乱填/
// 恶意 fuzz)一律忽略走原图——不为任意数字生成变体,防缓存键空间被撑爆
const WIDTH_TIERS = [320, 480, 640, 960];

const cache = new Map();    // 'site|u' | 'site|u|w档' → Buffer(插入序即 LRU 序,命中重插触碰)
let cacheBytes = 0;
const inflight = new Map(); // 'site|u' → Promise<Buffer>(同键并发去重,只去重上游抓取)
const lanes = new Map();    // site → { active, queue } 每站并发车道

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit); // LRU 触碰
  }
  return hit;
}

function cachePut(key, buf) {
  if (!buf || buf.length > CACHE_ENTRY_MAX) return;
  if (cache.has(key)) {
    cacheBytes -= cache.get(key).length;
    cache.delete(key);
  }
  cache.set(key, buf);
  cacheBytes += buf.length;
  while ((cacheBytes > CACHE_MAX_BYTES || cache.size > CACHE_MAX_ENTRIES) && cache.size > 1) {
    const oldest = cache.keys().next().value;
    cacheBytes -= cache.get(oldest).length;
    cache.delete(oldest);
  }
}

// 拿一个车道名额:有空位立即给;否则进 FIFO 队列,等到名额时 resolve 出 release。
// release 时队列非空则名额直接移交队首(active 不减不加,免计数往返),队列空才
// 真正归还。调用方必须在 finally 里 release,保证名额绝不泄漏。
function acquireLane(site) {
  let lane = lanes.get(site);
  if (!lane) {
    lane = { active: 0, queue: [] };
    lanes.set(site, lane);
  }
  if (lane.active < SITE_CONCURRENCY) {
    lane.active++;
    return Promise.resolve(() => releaseLane(lane));
  }
  return new Promise((resolve) => {
    lane.queue.push(() => resolve(() => releaseLane(lane)));
  });
}

function releaseLane(lane) {
  const next = lane.queue.shift();
  if (next) next(); // 名额移交队首(其 acquire 侧 resolve 的 release 闭包绑同一 lane)
  else lane.active--;
}

// 魔数嗅探:插件 image() 只保证回明文图片字节,不报类型;按文件头判真实类型,
// 未知魔数回退 image/jpeg(绝不因此 500)
function sniffType(b) {
  if (!b || b.length < 3) return 'image/jpeg';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';               // FF D8 FF
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'; // ‰PNG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';                // GIF
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'; // RIFF….WEBP
  return 'image/jpeg';
}

// sharp 惰性单例:首次命中宽度档才动态 import,缓存加载结果(含失败)——sharp
// 没装好时每个请求都白付一次 import 探测太亏,失败也缓存住,本进程内后续请求
// 直接走原字节回退,不反复重试;依赖装好后重启服务即自动启用
let sharpPromise = null;
function loadSharp() {
  if (!sharpPromise) {
    sharpPromise = import('sharp').then((m) => m.default || null).catch(() => null);
  }
  return sharpPromise;
}

// imgResp:Content-Type 由调用方决定(原图 = 嗅探类型;变体 = image/webp),
// 其余响应头保持不变(公共缓存 1 天 + SWR 7 天 + ETag + ACAO:* 投屏海报跨源)
const CC_IMG = 'public, max-age=86400, stale-while-revalidate=604800';

// 内容哈希强 ETag:同一段 Buffer 只算一次(WeakMap 随 LRU 逐出自动可回收);
// sha1/base64 前 16 字符(96bit)对几万张封面足够防碰撞,响应头也短
const etagMap = new WeakMap();
function etagOf(buf) {
  let t = etagMap.get(buf);
  if (!t) {
    t = '"' + createHash('sha1').update(buf).digest('base64').slice(0, 16) + '"';
    etagMap.set(buf, t);
  }
  return t;
}

// 带条件请求的响应出口:If-None-Match 命中 → 304 空体(验证器/缓存头照带),
// 否则 200 全量。inm 是逗号分隔列表语义(代理链可能叠多个),逐项精确比对
function respondImage(ctx, buf, type) {
  const etag = etagOf(buf);
  const inm = ctx.get('if-none-match');
  if (inm && inm.split(',').some((s) => s.trim() === etag)) {
    ctx.status = 304;
    ctx.set('Cache-Control', CC_IMG);
    ctx.set('ETag', etag);
    ctx.set('Access-Control-Allow-Origin', '*');
    ctx.body = null;
    return;
  }
  ctx.status = 200;
  ctx.set('Content-Type', type || 'image/jpeg');
  ctx.set('Cache-Control', CC_IMG);
  ctx.set('ETag', etag);
  ctx.set('Access-Control-Allow-Origin', '*'); // 投屏接收端拉 MediaInfo 海报跨源需要(本域 <img> 同源不受影响)
  ctx.body = buf;
}

export const imgRouter = new Router();

imgRouter.get('/img/:site', async (ctx) => {
  const { site } = ctx.params;
  const q = new URLSearchParams(ctx.querystring);
  const u = q.get('u');
  if (!u || !/^https?:\/\//.test(u)) {
    ctx.status = 400;
    ctx.body = 'bad u';
    return;
  }
  const plugin = await getPlugin(site);
  if (!plugin || typeof plugin.image !== 'function') {
    ctx.status = 404;
    ctx.type = 'application/json';
    ctx.body = { __err: 1, message: '站点 ' + site + ' 不支持图片代理' };
    return;
  }

  const wq = Number(q.get('w'));
  const width = WIDTH_TIERS.indexOf(wq) >= 0 ? wq : 0;

  // 第一步:拿原图字节(带不带 w 都要先有原图)。LRU 命中直接用;未命中走
  // 「同键去重 + 每站车道」抓取,失败语义(上游错 → 502 不缓存)与 NextWeb 一致
  const key = site + '|' + u;
  const hit = cacheGet(key);
  let buf;
  if (hit) {
    buf = hit;
  } else {
    let p = inflight.get(key);
    if (!p) {
      const run = (async () => {
        const release = await acquireLane(site);
        try {
          const b = await plugin.image(u);
          cachePut(key, b);
          return b;
        } finally {
          release();
        }
      })();
      p = run.finally(() => {
        if (inflight.get(key) === p) inflight.delete(key);
      });
      inflight.set(key, p);
    }
    try {
      buf = await p;
    } catch (e) {
      ctx.status = 502;
      ctx.body = 'decrypt fail: ' + e.message;
      return;
    }
  }

  // 第二步:Content-Type 一律按魔数修正(不带 w 的原图请求也受益)
  const type = sniffType(buf);
  if (!width) return respondImage(ctx, buf, type); // 无宽度档:原图直出,到此为止

  // 第三步:变体。缓存键在原图键后拼 '|w档':同一张图的多档变体与原图各自独立
  // LRU、互不挤占同一条目;命中即 0 处理直回(变体恒为 WebP)
  const vKey = key + '|w' + width;
  const vHit = cacheGet(vKey);
  if (vHit) return respondImage(ctx, vHit, 'image/webp');

  // 回退链:sharp 不可用(未装/加载失败)或输入是 gif(动图转 WebP 丢动画)→
  // 原图原类型直出。任何路径下响应「永不劣于现状」:最坏也只是多传几个原始字节
  const sharp = await loadSharp();
  if (!sharp || type === 'image/gif') return respondImage(ctx, buf, type);

  try {
    // 缩到目标宽 + 转 WebP:withoutEnlargement 防小图放大(放大只加字节不加细节);
    // q72 是封面档目测无感知损失的常用档;纯本地 CPU 处理,不发上游请求不占车道
    const out = await sharp(buf)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();
    cachePut(vKey, out);
    return respondImage(ctx, out, 'image/webp');
  } catch (e) {
    // 处理抛错(Corrupt 输入/内存压力等):同样回退原字节,绝不 500;失败不缓存,
    // 下次同档请求可重试(与代理「失败不缓存」哲学一致)
    return respondImage(ctx, buf, type);
  }
});
