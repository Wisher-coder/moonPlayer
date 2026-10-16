// ============================================================================
// speedtest.js —— 站源测速编排(插件管理页「逐站测速」核心;纯前端、纯静默:
// 不导航、不碰舞台播放器、不操作任何页面)
// ----------------------------------------------------------------------------
// runSiteSpeedTest(site, { signal }) →
//   { apiMs, imgMs, mbps, at, err }   数值字段失败时为 null
//
//   ① apiMs  接口响应延迟:list(page 1 / size 6)往返耗时。_t=Date.now() 同时
//            穿透客户端 meta 缓存、服务端 30s 结果缓存(api-cache key 含全部
//            查询参数)与 web 端浏览器 HTTP 缓存,测的是真实冷请求;
//   ② imgMs  图片加载延迟:①返回 items[0].cover(已绝对化),经 expo-image
//            的 Image.prefetch 计时(三端可用、无 CORS 顾虑);/api/img/ 代理
//            地址追加 &w=640——服务端宽度档白名单 320/480/640/960,UI 平常
//            只打 320 省流档或原图,640 档基本不命中缓存,避免「假 0ms」;
//   ③ mbps  播放速度(MB/s,一位小数):fetch 播放清单文本 → 含
//            #EXT-X-STREAM-INF(master)则解析最高 RESOLUTION 变体行、相对地址
//            绝对化后再 fetch 一层 → 取媒体清单前 2 个非 # 行逐个 arrayBuffer
//            累计字节,总字节/总耗时。字节帽 ~4MB(够即停)。hanxiucao/
//            zimuquan 为 CDN 直链 ACAO:*,多数站播放地址是 /api/<site>/
//            playlist 代理(同源/ACAO:*),均可 fetch。
//   编排:三项同一波起跑——①list 计时即接口指标;②③等①的条目一到立即开火,
//        图片预取 ‖ [play 解析 → 速度下载]全程并发,速度只等 play URL。②③
//        的输入物理上来自①与 play 的返回,再复制 list 请求不会更快只会多打
//        上游。「全部测速」仍按站串行(防请求风暴)。
//        (视频可播测量已按需求移除:探针文件 speedtest.video.*.js 一并删除,
//         旧持久化结果里的 readyMs/readyStage 字段仅成历史残留,读取方不再消费)
//
// 失败语义:仅①失败(列表都拿不到,后续无从谈起)落 err;②③各自失败只把
// 对应数值记 null,整测仍算「有结果」。自定义 signal 用于离页中止——传自定义
// signal 会绕过 client 在途去重、同时失去 client 默认超时兜底,这里统一经
// guardedSignal 补齐同档超时(计时口径与常规请求一致)。
// 平台红线:本文件三端共享,禁止出现 DOM/window(崩 Hermes release 构建)。
// ============================================================================
import { Image } from 'expo-image';
import { api } from './client.js';

const LIST_TIMEOUT_MS = 20000; // 与 client 默认档一致
const PLAY_TIMEOUT_MS = 60000; // 与 client 的 play 档一致(解析链路最重)
const IMG_TIMEOUT_MS = 15000; // 图片 prefetch 超时
const NET_TIMEOUT_MS = 15000; // 清单/切片 fetch 超时
const BYTES_CAP = 4 * 1024 * 1024; // 切片字节帽(~4MB,够算速度即停)

// 自建中止信号:超时兜底 + 外层 signal(离页中止)联动。client 侧传自定义
// signal 即不设默认超时,这里补齐;done() 在请求 settle 后调用,清定时器并
// 摘外层监听(串行全测几十个站,不摘会累积监听)
function guardedSignal(timeoutMs, outer) {
  if (typeof AbortController === 'undefined') {
    return { signal: null, done: () => {} }; // 理论不发生,防御式退化
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  if (outer) {
    if (outer.aborted) ctl.abort();
    else if (typeof outer.addEventListener === 'function') outer.addEventListener('abort', onAbort);
  }
  return {
    signal: ctl.signal,
    done: () => {
      clearTimeout(timer);
      if (outer && typeof outer.removeEventListener === 'function') outer.removeEventListener('abort', onAbort);
    },
  };
}

// 图片 prefetch + 超时(expo-image prefetch 不收 signal,超时只能竞速:底层
// 拉取不可中止,但本项指标按时记 null,不阻塞后续测量)
function prefetchImage(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);
    Image.prefetch(url).then(
      (ok) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(!!ok);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(false);
        }
      }
    );
  });
}

// 清单相对地址 → 绝对地址(Hermes 不保证 URL 全局,手写三段式;与
// client.absolutizeUrl 的差异:清单行常为相对路径,需按「基址目录」解析)
function resolveAgainst(rel, base) {
  if (!rel || !base) return null;
  if (/^https?:\/\//i.test(rel)) return rel;
  if (rel.startsWith('//')) return 'https:' + rel;
  const m = base.match(/^(https?:\/\/[^/?#]+)/i);
  if (!m) return null;
  const origin = m[1];
  if (rel.startsWith('/')) return origin + rel;
  // 相对路径:去掉基址的文件名与查询段,取目录
  const noQuery = base.split('#')[0].split('?')[0];
  const cut = noQuery.lastIndexOf('/');
  const dir = cut >= origin.length ? noQuery.slice(0, cut + 1) : origin + '/';
  return dir + rel;
}

// master 清单:解析最高 RESOLUTION 的变体行(无 RESOLUTION 属性按 0 计,
// 有明确分辨率的优先;同分取先出现的)
function pickBestVariant(text) {
  const lines = text.split('\n');
  let best = '';
  let bestArea = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().indexOf('#EXT-X-STREAM-INF') !== 0) continue;
    const m = lines[i].match(/RESOLUTION=(\d+)\s*x\s*(\d+)/i);
    const area = m ? parseInt(m[1], 10) * parseInt(m[2], 10) : 0;
    // 变体 URI 在其标签行的下一非空非 # 行
    let j = i + 1;
    while (j < lines.length) {
      const t = lines[j].trim();
      if (t && t.charAt(0) !== '#') break;
      j++;
    }
    const uri = j < lines.length ? lines[j].trim() : '';
    if (uri && area > bestArea) {
      bestArea = area;
      best = uri;
    }
  }
  return best || null;
}

// 字节/耗时 → MB/s(一位小数)
function rateOneDecimal(bytes, ms) {
  if (!bytes || ms <= 0) return null;
  return Math.round(((bytes / (1024 * 1024)) / (ms / 1000)) * 10) / 10;
}

// ④ 播放速度:清单链路(master → 媒体清单 → 前 2 个切片)逐段拉字节计时。
// mp4 直链没有清单可解,退化为 Range 头限 4MB 的整档拉取(服务器不支持
// Range 时由 NET_TIMEOUT_MS 中止兜底,不会无界下载)。任何一步失败返回 null。
async function measureThroughput(url, type, outer) {
  const g = guardedSignal(NET_TIMEOUT_MS, outer);
  try {
    // mp4 直链(非 hls 且 URL 无 .m3u8 迹象):Range 限帽拉一段测速
    if (type !== 'hls' && !/\.m3u8/i.test(url)) {
      const t0 = Date.now();
      const r = await fetch(url, {
        signal: g.signal,
        headers: { Range: 'bytes=0-' + (BYTES_CAP - 1) },
      });
      if (!r.ok) return null;
      const buf = await r.arrayBuffer();
      return rateOneDecimal(buf.byteLength, Date.now() - t0);
    }
    // 清单文本
    const res = await fetch(url, { signal: g.signal });
    if (!res.ok) return null;
    const text = await res.text();
    let mediaUrl = url;
    let list = text;
    if (text.indexOf('#EXT-X-STREAM-INF') !== -1) {
      const variant = pickBestVariant(text);
      if (!variant) return null;
      mediaUrl = resolveAgainst(variant, url);
      if (!mediaUrl) return null;
      const r2 = await fetch(mediaUrl, { signal: g.signal });
      if (!r2.ok) return null;
      list = await r2.text();
    }
    // 媒体清单前 2 个非 # 行(切片)
    const segs = list
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && l.charAt(0) !== '#')
      .slice(0, 2);
    if (!segs.length) return null;
    const t0 = Date.now(); // 只计切片拉取阶段(清单解析不计入速度)
    let bytes = 0;
    for (let i = 0; i < segs.length; i++) {
      if (bytes >= BYTES_CAP) break; // 够了即停,不多拉
      const segUrl = resolveAgainst(segs[i], mediaUrl);
      if (!segUrl) return null;
      const r = await fetch(segUrl, { signal: g.signal });
      if (!r.ok) return null;
      const buf = await r.arrayBuffer();
      bytes += buf.byteLength;
      if (bytes >= BYTES_CAP) break;
    }
    return rateOneDecimal(bytes, Date.now() - t0);
  } catch (_e) {
    return null; // 中止/网络失败/解析失败:本项记空
  } finally {
    g.done();
  }
}

// 站源测速主入口(编排:三项同一波并发;任一步失败不炸整体)
export async function runSiteSpeedTest(site, opts = {}) {
  const outer = (opts && opts.signal) || null;
  const out = { apiMs: null, imgMs: null, mbps: null, at: Date.now(), err: null };

  // ① 接口响应延迟(list 计时即指标)——②③的条目输入共享这一份结果,
  // 波内只发一次 list(复制请求不会更快,每路仍要先等自己的 list)
  const g1 = guardedSignal(LIST_TIMEOUT_MS, outer);
  const listTask = (async () => {
    try {
      const t0 = Date.now();
      const r = await api(site, 'list', { page: 1, size: 6, _t: Date.now() }, { signal: g1.signal });
      out.apiMs = Date.now() - t0;
      const items = r && Array.isArray(r.items) ? r.items : null;
      if (!items || !items.length) throw new Error('站源列表为空');
      return items[0] || null;
    } catch (e) {
      out.err = (e && e.message) || '接口请求失败'; // ①失败即整测失败,②③静默
      return null;
    } finally {
      g1.done();
    }
  })();

  // ② 图片加载延迟(与①同波创建,条目一到即预取;独立指标,失败仅记 null)
  const imgTask = (async () => {
    const first = await listTask;
    if (!first) return;
    const cover = typeof first.cover === 'string' ? first.cover : '';
    if (!cover) return;
    let imgUrl = cover;
    if (imgUrl.indexOf('/api/img/') !== -1) {
      // 服务端宽度档白名单 320/480/640/960;640 档基本不命中缓存,避免假 0ms
      imgUrl += (imgUrl.indexOf('?') !== -1 ? '&' : '?') + 'w=640';
    }
    const t0 = Date.now();
    if (await prefetchImage(imgUrl, IMG_TIMEOUT_MS)) out.imgMs = Date.now() - t0;
  })();

  // ③ 播放速度(与①②同波创建):play 只解析一次,速度下载紧随其后(只等 URL;
  // play 解析失败/无地址则本项记 null——没有可测的清单)
  const playTask = (async () => {
    const first = await listTask;
    if (!first) return;
    const g2 = guardedSignal(PLAY_TIMEOUT_MS, outer);
    try {
      const play = await api(site, 'play', { id: first.id }, { signal: g2.signal });
      if (!(play && typeof play.url === 'string' && play.url)) return;
      const url = play.url; // 已绝对化(client 的 URL_KEYS 深遍历)
      const type = play.type || '';
      if (!(outer && outer.aborted)) out.mbps = await measureThroughput(url, type, outer);
    } catch (_e) {
      // play 解析失败:速度无地址可测,保持 null
    } finally {
      g2.done();
    }
  })();

  await Promise.all([imgTask, playTask]);
  out.at = Date.now();
  return out;
}
