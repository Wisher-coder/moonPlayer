// ============================================================================
// media.js —— teleproto 引擎·媒体域(视频字节流 + 视频面 + 图片供给)
// ----------------------------------------------------------------------------
// 引擎收敛(2026-10 TDLib → teleproto 全量替换)后媒体域的单一实现:
//   ① 令牌体系:thumbToken/avatarToken/photoToken 伪 URL 构造器 import 自
//      ./shared.js(客户端零改动);本文件负责令牌 → 消息定位 → 文件挑档 →
//      _media.getFile 下载;
//   ② 图片/缩略图/头像供给 serveImage(token) → Buffer;
//   ③ 视频 Range 流:resolveStreamTarget/createRangeStream——512KB 块背压拉取,
//      传输走 teleproto MediaScheduler(downloadPool 16 会话×4 在途=64 并发/DC,
//      tg-client.js 缺省档;临时密钥、媒体专用 DC、FLOOD_WAIT 内建退避、
//      FILE_MIGRATE 内建迁移)。在飞预算 32MiB = TDLib patched 版(8 会话/
//      16MiB)的两倍,Turrit 类「解除客户端并发封顶」机制的服务端等价物;
//      服务器按账号软限速为最终上界(实测不满意可 TG_MEDIA_SESSIONS/
//      TG_MEDIA_INFLIGHT/TG_MEDIA_CONCURRENCY 降档);
//   ④ 视频面取数:listPeerVideos/getVideoDetail/searchVideos + 插件聚合
//      list/boards/related(VideoItem 形状与聚合语义与 TDLib 版逐字段一致)。
//
// 与 TDLib 版的有意差异(注释留档):
//   · 字节源不再是「可选接管」——TG_MEDIA_SOURCE 环境开关与 TDLib 分窗
//     downloadFile 字节源(windowPlan/startWindow/updateFile 进度驱动)整链
//     删除,512KB 块 + LRU 缓存 + 消费驱动预读 + moov 尾块预取为唯一路径;
//   · 全局 GetFile 信号量缺省 = sessions×inFlight(tg-client.defaultMedia
//     Concurrency;env TG_MEDIA_CONCURRENCY 显式压低时以低者为准);
//   · videoId 铸币用 MTProto 原生消息 id(旧 TDLib 打包 id 经 localMsgIdOf
//     shim 继续可读,历史收藏不失效);
//   · 图片档位:PhotoSize{type,w,h,size}/PhotoSizeProgressive{sizes[]}/
//     PhotoStrippedSize{bytes}(零网络兜底,JPEG 头重建走 teleproto
//     utils.strippedPhotoToJpg)/Photo.minithumbnail(base64 JPEG 直读)。
//     兜底口径(2026-10-15 全损事故修正):PhotoStrippedSize/minithumbnail 仅在
//     「消息里根本没有真实档位」时作为唯一可用图返回;真实档位下载失败一律
//     留痕后如实上抛(502 不缓存,前端占位,下次请求自动重试)——此前失败
//     静默回 stripped 会以成功语义被 img 代理与浏览器缓存 1 天,瞬时故障
//     被钉死成永久「全损画质」,且错误被吞、无从诊断。
//
// 防风暴红线(仓库约定):上游失败如实上抛中文错误,绝不自动重试
// (file_reference 保鲜恰一次是保鲜层语义);全局在途 GetFile 有上限、块缓存
// 字节上限 128MB(超限 LRU 逐出)、同块在途去重、预读只由消费驱动(有界
// 窗口,防无人消费一路自滑到 EOF);深跳页按序走梯上限 64 页。
// ============================================================================

import { Readable } from 'node:stream';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import {
  TgNotLoggedInError, parseVideoId, videoIdOf, isPeerKey, thumbToken,
  mapLimitFailSoft, localMsgIdOf,
} from './shared.js';
import { normTgClientError, defaultMediaConcurrency } from './tg-client.js';
import { peerKeyOfPeer } from './normalize.js';
import * as defaultLib from 'teleproto';

// ============ 常量 ============

const CHUNK = 512 * 1024;                   // 单块字节数(upload.GetFile 上限 512KB)
const CACHE_MAX_BYTES = 128 * 1024 * 1024;  // 块缓存字节上限(超限 LRU 逐出)
const PREFETCH_AHEAD = 16;                  // 滑动窗口预读块数(8MB lookahead)
const IMAGE_TIMEOUT = 20e3;                 // 整图下载有界等待(图片/缩略图/头像)
const MSG_TTL = 10 * 60e3;                  // 元数据 TTL(file_reference 同量级)
const META_TTL = 60e3;                      // videoId → 文档摘要缓存时效
const TOKEN_CACHE_MAX = 2000;               // 图片令牌解析 LRU 上限
const CURSOR_TTL = 10 * 60e3;               // 深分页游标梯子 TTL
const CURSOR_PAGES_MAX = 64;                // 梯子页数上限
const VIDEO_SIZE_MAX = 96;                  // 单页视频条数上限(MTProto limit≤100,
                                            // 页1/页N 探测 +1,留 2 余量 ⇒ 96)
const HISTORY_LIMIT_MAX = 100;              // MTProto getHistory/search 单次上限

// 插件聚合口径(与 TDLib 版数值一致)
const VIDEO_KINDS = new Set(['saved', 'group', 'channel']);
const LIST_DIALOGS = 10;
const BOARDS_DIALOGS = 12;
const BOARDS_PAGE_SIZE = 12;
const AGGREGATE_CONCURRENCY = 4;

// ============ 纯函数:图片令牌解析 ============

/**
 * 解析 https://tg.local/ 伪 URL 令牌(路由 img 层原样透传 u 参数):
 *   t/<videoId>            → 媒体缩略图(视频封面/贴纸/文档/音频封面)
 *   p/<videoId>[w]/<m|x>   → 相册图(w 尾缀 = 链接预览配图变体)
 *   a/<peerKey>            → 对话头像
 */
export function parseImageToken(u) {
  let p;
  try { p = new URL(String(u || '')); } catch (_e) { throw new Error('Telegram 图片令牌非法'); }
  if (p.host !== 'tg.local') throw new Error('Telegram 图片令牌非法:' + u);
  const parts = p.pathname.split('/').filter(Boolean);
  if (parts[0] === 't' && parts[1]) return { kind: 't', videoId: parts[1] };
  if (parts[0] === 'a' && parts[1]) return { kind: 'a', peerKey: parts[1] };
  if (parts[0] === 'p' && parts[1] && parts[2]) {
    const raw = parts[1];
    const web = /w$/.test(raw);
    return { kind: 'p', videoId: web ? raw.slice(0, -1) : raw, tag: parts[2], web };
  }
  throw new Error('Telegram 图片令牌非法:' + u);
}

// ============ 纯函数:相册图档位梯子(MTProto PhotoSize 形态) ============

/** 档位梯子:气泡中档 m→n→c→b→a;查看器全档 x→y→w */
export function photoLadder(tag) {
  return tag === 'x' ? ['x', 'y', 'w'] : ['m', 'n', 'c', 'b', 'a'];
}

function isRealSize(s) {
  return Boolean(s) && (s.className === 'PhotoSize' || s.className === 'PhotoSizeProgressive');
}

function areaOf(s) { return (Number(s && s.w) || 0) * (Number(s && s.h) || 0); }

/** 像素面积最大的档位(梯子全部未命中时的兜底) */
export function largestPhotoSize(sizes) {
  let best = null;
  let bestArea = -1;
  for (const s of sizes || []) {
    if (!isRealSize(s)) continue;
    if (areaOf(s) > bestArea) { bestArea = areaOf(s); best = s; }
  }
  return best;
}

/**
 * 按档位字母挑 PhotoSize(PhotoSizeProgressive 同字母命中;渐进式取最大
 * 分片),全部未命中回最大档,无任何可用档回 null。
 */
export function pickPhotoSize(sizes, tag) {
  const all = (sizes || []).filter(isRealSize);
  for (const t of photoLadder(tag)) {
    const hit = all.find((s) => s.type === t);
    if (hit) return hit;
  }
  return largestPhotoSize(all);
}

/** 档位字节数:PhotoSize.size / PhotoSizeProgressive.sizes 取最大 */
export function photoSizeBytes(s) {
  if (!s) return 0;
  if (s.className === 'PhotoSize') return Number(s.size) || 0;
  if (s.className === 'PhotoSizeProgressive') {
    return Math.max(0, ...(s.sizes || []).map((x) => Number(x) || 0));
  }
  return 0;
}

// ============ 纯函数:视频消息面(MTProto Document) ============

/**
 * MTProto 视频消息 → 摘要(非视频回 null)。视频面 = DocumentAttributeVideo
 * (含 roundMessage 圆形视频)+ DocumentAttributeAnimated(GIF 动图)——
 * TDLib 版 videoInfoOf 的 video/videoNote/animation 三分支同判。
 * {round,duration,w,h,name,mime,size,dcId,doc,thumbs}
 */
export function videoInfoOf(msg) {
  const media = msg && msg.media;
  if (!media || media.className !== 'MessageMediaDocument') return null;
  const doc = media.document;
  if (!doc || doc.className !== 'Document') return null;
  let video = null; let animated = false; let name = '';
  for (const a of doc.attributes || []) {
    if (a.className === 'DocumentAttributeVideo') video = a;
    else if (a.className === 'DocumentAttributeAnimated') animated = true;
    else if (a.className === 'DocumentAttributeFilename' && a.fileName) name = String(a.fileName);
  }
  if (!video && !animated) return null;
  const v = video || { duration: 0, w: null, h: null, roundMessage: false };
  return {
    round: Boolean(video && video.roundMessage),
    duration: Math.round(Number(v.duration)) || null,
    w: Number(v.w) || null,
    h: Number(v.h) || null,
    name,
    mime: String(doc.mimeType || 'video/mp4'),
    size: Number(doc.size) || 0,
    dcId: Number(doc.dcId) || 0,
    doc,
    thumbs: doc.thumbs || [],
  };
}

/** 视频标题:caption 首行 > 文件名去扩展名 > 兜底「未命名视频+日期」 */
export function titleOf(msg, info) {
  const cap = String((msg && msg.message) || '').trim(); // caption 与正文同为 .message
  if (cap) return cap.split(/\r?\n/)[0].slice(0, 80);
  if (info && info.name) return info.name.replace(/\.[a-z0-9]{1,5}$/i, '').slice(0, 80);
  const d = msg && msg.date ? new Date(msg.date * 1000) : null;
  return '未命名视频' + (d ? ' ' + d.toISOString().slice(0, 10) : '');
}

/**
 * 归一化单条视频消息 → VideoItem(契约形态:无 author 字段;hd=w≥1280‖
 * h≥720;cover 已包 /api/img/telegram?u= 代理)。非视频/无文档/无对话键回 null。
 */
export function videoItemOf(peerKey, msg) {
  const info = videoInfoOf(msg);
  if (!info || !info.doc || !peerKey) return null;
  const id = videoIdOf(peerKey, Number(msg.id));
  return {
    id,
    title: titleOf(msg, info),
    cover: '/api/img/telegram?u=' + encodeURIComponent(thumbToken(id)),
    duration: info.duration,
    hd: Boolean((info.w || 0) >= 1280 || (info.h || 0) >= 720),
  };
}

// ============ 流签名(HMAC 短时令牌;与 TDLib 版逐字一致) ============

const STREAM_SECRET = randomBytes(32);

function signBucket(videoId, bucket) {
  return createHmac('sha256', STREAM_SECRET).update(videoId + '|' + bucket).digest('base64url');
}

export function signStream(videoId) {
  return signBucket(String(videoId), Math.floor(Date.now() / 3600e3));
}

export function verifyStream(videoId, token) {
  if (!token || typeof token !== 'string') return false;
  const bucket = Math.floor(Date.now() / 3600e3);
  for (const b of [bucket, bucket - 1]) {
    const expect = Buffer.from(signBucket(String(videoId), b));
    const got = Buffer.from(token);
    if (expect.length === got.length && timingSafeEqual(expect, got)) return true;
  }
  return false;
}

// ============ 引擎工厂(全部依赖注入) ============
//
// deps 契约(接线层 engine.js 装配;测试用 mock 实现):
//   getClient   async () => teleproto client       【必须】
//   entityOf    async (peerKey) => entity          【必须】dialogs 域共享口
//   getMessage  (peer, id, force?) => Promise<msg> 【必须】messages 域缓存版
//   listChats   async () => [目录条目]              【必须】dialogs 域目录面
//   selfUserId  () => string|number                【必须】saved 伪对话定位
//   log         (msg)=>void                        可选
// opts(测试可调,缺省=文件头常量):getFileConcurrency/cacheMaxBytes/
// prefetchAhead/imageTimeoutMs。env TG_MEDIA_CONCURRENCY 缺省接入
// defaultMediaConcurrency()(=sessions×inFlight)。

export function createTgMedia(deps, opts = {}) {
  for (const k of ['getClient', 'entityOf', 'getMessage', 'listChats', 'selfUserId']) {
    if (typeof deps[k] !== 'function') {
      throw new Error('createTgMedia 缺少依赖注入:' + k);
    }
  }
  const lib = deps.lib || defaultLib;
  const { entityOf, getMessage, listChats, selfUserId } = deps;
  const log = typeof deps.log === 'function' ? deps.log : (() => {});
  const concurrencyDefault = defaultMediaConcurrency();
  const getFileConcurrency = Math.max(1, Math.floor(Number(opts.getFileConcurrency) || concurrencyDefault));
  const cacheMaxBytes = Math.max(CHUNK, Math.floor(Number(opts.cacheMaxBytes) || CACHE_MAX_BYTES));
  const prefetchAhead = Math.max(0, Math.floor(Number(opts.prefetchAhead) || PREFETCH_AHEAD));
  const imageTimeoutMs = Math.max(1, Math.floor(Number(opts.imageTimeoutMs) || IMAGE_TIMEOUT));

  async function clientOf() { return deps.getClient(); }
  async function call(fn) {
    const client = await clientOf();
    try {
      return await fn(client);
    } catch (e) {
      throw normTgClientError(e, lib);
    }
  }

  // GetFile 的 offset 为 MTProto long(teleproto big-integer):8 字节大端构造
  function offsetBig(n) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(n));
    return lib.helpers.readBigIntFromBuffer(b, false, false);
  }

  // ---------- 视频元数据(file_reference 保鲜:恰一次强拉重试) ----------

  const metaCache = new Map(); // videoId → {info, at}

  async function withFreshRef(peerKey, msgId, fn) {
    try {
      return await fn(await getMessage(peerKey, msgId));
    } catch (e) {
      const msgText = String((e && e.message) || e);
      if (/FILE_REFERENCE|FILE_MIGRATE|assertion/i.test(msgText) || (e && e.code === 400 && /REFERENCE/i.test(msgText))) {
        return await fn(await getMessage(peerKey, msgId, true));
      }
      throw e;
    }
  }

  /** 取视频文档元数据(短 TTL;file_reference 保鲜由 withFreshRef 兜) */
  async function metaOf(videoId) {
    const hit = metaCache.get(videoId);
    if (hit && Date.now() - hit.at < META_TTL) return hit.info;
    const { peerKey, msgId } = parseVideoId(videoId);
    const info = await withFreshRef(peerKey, localMsgIdOf(msgId), async (msg) => {
      const d = videoInfoOf(msg);
      if (!d) throw new Error('该消息不是视频文档,无法播放');
      return d;
    });
    metaCache.set(videoId, { info, at: Date.now() });
    return info;
  }

  // ---------- 分块下载(信号量 + LRU 块缓存 + 在途去重 + 消费驱动预读) ----------

  const chunkCache = new Map();   // `${videoId}:${idx}` → Buffer(插入序即 LRU 序)
  let chunkBytes = 0;
  const chunkInflight = new Map();

  // 账号态作废纪元:dropCaches() 自增;「作废前发起、作废后才结算」的旧账号
  // 字节按纪元比对丢弃、不落新缓存(savedm* 等账号相对键不能跨账号串数据)
  let cacheEpoch = 0;

  function cachePut(key, buf) {
    if (!buf || !buf.length) return;
    if (chunkCache.has(key)) { chunkBytes -= chunkCache.get(key).length; chunkCache.delete(key); }
    chunkCache.set(key, buf);
    chunkBytes += buf.length;
    while (chunkBytes > cacheMaxBytes && chunkCache.size > 1) {
      const oldest = chunkCache.keys().next().value;
      chunkBytes -= chunkCache.get(oldest).length;
      chunkCache.delete(oldest);
    }
  }

  // 全局 GetFile 信号量(额度移交式释放;上限=sessions×inFlight 或 env 压低值)
  const sem = { active: 0, queue: [] };
  function acquire() {
    if (sem.active < getFileConcurrency) {
      sem.active++;
      return Promise.resolve(release);
    }
    return new Promise((resolve) => { sem.queue.push(() => resolve(release)); });
  }
  function release() {
    const next = sem.queue.shift();
    if (next) next();
    else sem.active--;
  }

  /** 滑动窗口预读:确保 idx+1..idx+n 均已缓存或在途(仅由消费者驱动) */
  function ensureAhead(videoId, idx, n, endIdx) {
    for (let k = 1; k <= n; k++) {
      const j = idx + k;
      if (endIdx != null && j > endIdx) break;
      const key = videoId + ':' + j;
      if (chunkCache.has(key) || chunkInflight.has(key)) continue;
      fetchChunk(videoId, j).catch(() => { /* 预读失败不影响当前块 */ });
    }
  }

  /**
   * 拉一块(512KB 对齐;缓存命中 0 网络)。传输走 teleproto MediaScheduler
   * (downloadPool 多会话×在飞窗,FLOOD_WAIT/FILE_MIGRATE 内建处理)。
   */
  async function fetchChunk(videoId, idx) {
    const myEpoch = cacheEpoch;
    const key = videoId + ':' + idx;
    const hit = chunkCache.get(key);
    if (hit) { chunkCache.delete(key); chunkCache.set(key, hit); return hit; } // LRU 触碰
    let p = chunkInflight.get(key);
    if (p) return p;
    p = (async () => {
      const { peerKey, msgId } = parseVideoId(videoId);
      const releaseSlot = await acquire();
      try {
        return await withFreshRef(peerKey, localMsgIdOf(msgId), async (msg) => {
          const c = (msg && msg.client) || (await clientOf());
          const sched = c._media;
          if (!sched || typeof sched.getFile !== 'function') {
            throw new Error('当前 teleproto 版本缺少 MediaScheduler 多连接下载器');
          }
          const info = videoInfoOf(msg);
          const doc = info && info.doc;
          if (!doc) throw new Error('该消息不是视频文档,无法播放');
          const location = new lib.Api.InputDocumentFileLocation({
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference,
            thumbSize: '',
          });
          return await sched.getFile(
            Number(doc.dcId) || c.session.dcId, location, offsetBig(idx * CHUNK), CHUNK,
          );
        });
      } finally {
        releaseSlot();
        if (chunkInflight.get(key) === p) chunkInflight.delete(key);
      }
    })();
    chunkInflight.set(key, p);
    const buf = await p;
    if (myEpoch === cacheEpoch) cachePut(key, buf);
    return buf;
  }

  // ---------- 整文件字节下载(图片/缩略图/头像;≤数 MB) ----------

  /**
   * 从 offset 起拉 size 字节(512KB 块循环拼接;有界 imageTimeoutMs 墙钟)。
   * limit 必须按 4096 对齐(upload.GetFile 硬约束——按精确字节数请求回
   * LimitInvalidError,图片/缩略图全部失败;对齐后多余尾部字节由调用方按
   * want 截断)。CDN 重定向/限流由 normTgClientError 转中文。
   */
  async function downloadBytes(dcId, location, size, timeoutMs) {
    const want = Math.max(1, Math.floor(Number(size) || 0));
    const deadline = Date.now() + (timeoutMs || imageTimeoutMs);
    const parts = [];
    let off = 0;
    while (off < want) {
      if (Date.now() > deadline) {
        throw new Error('图片下载超时(' + Math.round((timeoutMs || imageTimeoutMs) / 1000) + ' 秒)');
      }
      const remain = want - off;
      // 4096 向上取整(单块上限 1MB=CHUNK 的两倍也按对齐截断)
      const len = Math.min(CHUNK, Math.ceil(remain / 4096) * 4096);
      const releaseSlot = await acquire();
      let buf;
      try {
        buf = await call(async (client) => client._media.getFile(
          Number(dcId) || client.session.dcId, location, offsetBig(off), len,
        ));
      } finally {
        releaseSlot();
      }
      if (!buf || !buf.length) break; // 实际短于声明:按 EOF 截断
      parts.push(off + buf.length <= want ? buf : buf.subarray(0, want - off));
      off += buf.length;
      if (buf.length < len) break;
    }
    return Buffer.concat(parts);
  }

  // ---------- Range 流(对齐 streamHandler 消费契约) ----------

  /**
   * 校验并解析播放目标:回 {size}(路由层算 Content-Range/Content-Length)。
   * 顺带后台预取文件最后一块:moov 盒尾置的非 faststart mp4 元数据在尾部,
   * 播放器首个 Range 后常另行探测尾部,预取消除这一次冷启动往返。
   */
  async function resolveStreamTarget(videoId) {
    const info = await metaOf(videoId);
    const size = info.size || 0;
    if (size > CHUNK) {
      const lastIdx = Math.floor((size - 1) / CHUNK);
      const lastKey = videoId + ':' + lastIdx;
      if (!chunkCache.has(lastKey) && !chunkInflight.has(lastKey)) {
        fetchChunk(videoId, lastIdx).catch(() => { /* 尾块预取失败不影响正片 */ });
      }
    }
    return { size };
  }

  /**
   * 构造 [start,end] 闭区间的字节流(Readable,按块背压拉取,不整段缓冲)。
   * end 超出文件实际长度时以实际数据为准截断(流提前结束)。
   */
  function createRangeStream(videoId, start, end) {
    const iter = (async function* rangeIterator() {
      let off = Math.max(0, start);
      const endIdx = Math.floor(end / CHUNK); // 预读不越过本段 Range 终点
      while (off <= end) {
        const idx = Math.floor(off / CHUNK);
        let buf;
        try {
          buf = await fetchChunk(videoId, idx);
        } catch (e) {
          throw e instanceof TgNotLoggedInError ? e : normTgClientError(e, lib);
        }
        ensureAhead(videoId, idx, prefetchAhead, endIdx); // 消费驱动预读的唯一驱动点
        if (!buf || !buf.length) return; // 实际短于声明大小:按 EOF 处理
        const from = off - idx * CHUNK;
        if (from >= buf.length) return;
        const to = Math.min(end - idx * CHUNK + 1, buf.length);
        yield buf.subarray(from, to);
        off = idx * CHUNK + to;
      }
    })();
    return Readable.from(iter);
  }

  // ---------- 图片/缩略图/头像供给 ----------

  const tokenCache = new Map();
  const imageInflight = new Map();

  function tokenParse(u) {
    const key = String(u);
    const hit = tokenCache.get(key);
    if (hit) {
      tokenCache.delete(key);
      tokenCache.set(key, hit); // LRU 触碰
      return hit;
    }
    const parsed = parseImageToken(key); // 非法令牌抛中文错,不缓存
    tokenCache.set(key, parsed);
    while (tokenCache.size > TOKEN_CACHE_MAX) {
      tokenCache.delete(tokenCache.keys().next().value);
    }
    return parsed;
  }

  /** Document 缩略档(真实 PhotoSize 档位中面积最大者;type 即 thumbSize) */
  function docThumbOf(thumbs) {
    return largestPhotoSize(thumbs);
  }

  /** PhotoStrippedSize 兜底(零网络:JPEG 头重建) */
  function strippedFallback(sizes) {
    for (const s of sizes || []) {
      if (s && s.className === 'PhotoStrippedSize' && s.bytes && s.bytes.length) {
        try {
          const jpg = lib.utils.strippedPhotoToJpg(Buffer.from(s.bytes));
          if (jpg && jpg.length) return jpg;
        } catch (_e) { /* 重建失败走下一兜底 */ }
      }
    }
    return null;
  }

  /** minithumbnail(base64 JPEG)兜底(Photo.minithumbnail) */
  function minithumbnailToBuffer(mm) {
    if (!mm || typeof mm !== 'string' || !mm) return null;
    const buf = Buffer.from(mm, 'base64');
    return buf.length ? buf : null;
  }

  /**
   * 真实档下载的统一出口:失败先经 log 留痕再如实上抛。
   * 不再回退 stripped——回退图会以 200 成功语义流经 img 代理(LRU 缓存 +
   * 浏览器 1 天 Cache-Control),瞬时下载故障被钉死成「永久全损」;上抛则
   * 走 502 不缓存,前端占位,下次请求自动重试(2026-10-15 全损事故修正)。
   */
  async function downloadRealSize(dcId, buildLocation, sizeBytes, label, tok) {
    try {
      return await downloadBytes(dcId, buildLocation(), sizeBytes, imageTimeoutMs);
    } catch (e) {
      if (e instanceof TgNotLoggedInError) throw e;
      log('图片真实档下载失败(' + label + ' ' + (tok.videoId || tok.peerKey) + '):'
        + ((e && e.message) || e));
      throw e;
    }
  }

  /** Document 缩略档下载:真实档下载;无任何真实档回 stripped(该文档本就只有 stripped) */
  async function docThumbBytes(doc, thumbs, tok) {
    const pick = docThumbOf(thumbs || []);
    if (pick) {
      return await downloadRealSize(doc.dcId, () => new lib.Api.InputDocumentFileLocation({
        id: doc.id,
        accessHash: doc.accessHash,
        fileReference: doc.fileReference,
        thumbSize: pick.type,
      }), photoSizeBytes(pick), '缩略图', tok);
    }
    const stripped = strippedFallback(thumbs);
    if (stripped) return stripped;
    throw new Error('该文档无可用缩略图');
  }

  /**
   * 缩略图供给:Document 真实档(InputDocumentFileLocation{thumbSize})下载。
   * withFreshRef 保鲜(与视频路径同款):FILE_REFERENCE 类失败恰一次强拉消息
   * 重试;仍失败如实上抛。仅「根本没有真实档」的文档回 stripped 兜底。
   */
  async function serveThumb(tok) {
    const { peerKey, msgId } = parseVideoId(tok.videoId);
    return await withFreshRef(peerKey, localMsgIdOf(msgId), async (msg) => {
      const info = videoInfoOf(msg);
      const doc = info && info.doc;
      if (doc) return await docThumbBytes(doc, info.thumbs, tok);
      // 非视频文档(贴纸/音频封面等):走消息媒体 Document 的同一路径
      const media = msg && msg.media;
      if (media && media.className === 'MessageMediaDocument' && media.document
        && media.document.className === 'Document') {
        return await docThumbBytes(media.document, media.document.thumbs, tok);
      }
      throw new Error('该文档无可用缩略图');
    });
  }

  /**
   * 相册图供给:档位梯子挑 PhotoSize(InputPhotoFileLocation{thumbSize})。
   * withFreshRef 保鲜恰一次重试;仍失败如实上抛(不再回退 stripped——防
   * 全损画质被 img 代理当成功缓存,见 downloadRealSize)。仅「无任何真实
   * 档」时 stripped/minithumbnail 兜底。w 变体 = 链接预览配图
   * (message.media 为 MessageMediaWebPage 时取 webpage.photo)。
   */
  async function servePhoto(tok) {
    const { peerKey, msgId } = parseVideoId(tok.videoId);
    return await withFreshRef(peerKey, localMsgIdOf(msgId), async (msg) => {
      let photo = null;
      if (tok.web) {
        const wp = msg && msg.media && msg.media.className === 'MessageMediaWebPage' ? msg.media.webpage : null;
        photo = (wp && wp.photo) || null;
      } else {
        photo = msg && msg.media && msg.media.className === 'MessageMediaPhoto' ? msg.media.photo : null;
      }
      if (photo && photo.className === 'Photo') {
        const pick = pickPhotoSize(photo.sizes, tok.tag);
        if (pick) {
          return await downloadRealSize(photo.dcId, () => new lib.Api.InputPhotoFileLocation({
            id: photo.id,
            accessHash: photo.accessHash,
            fileReference: photo.fileReference,
            thumbSize: pick.type,
          }), photoSizeBytes(pick), '相册图', tok);
        }
        const stripped = strippedFallback(photo.sizes);
        if (stripped) return stripped;
        const mm = minithumbnailToBuffer(photo.minithumbnail);
        if (mm) return mm;
      }
      throw new Error('该图片无可用档位');
    });
  }

  /**
   * 头像供给:entity.photo(UserProfilePhoto/ChatPhoto{photoId,dcId,
   * strippedThumb})→ InputPeerPhotoFileLocation{peer,photoId,big:false}(160
   * 档);未设头像抛「该对话未设置头像」。
   */
  async function serveAvatar(tok) {
    if (!isPeerKey(tok.peerKey)) throw new Error('Telegram 对话键非法:' + tok.peerKey);
    const entity = await entityOf(tok.peerKey);
    const photo = entity && entity.photo;
    if (!photo || !(photo.photoId != null)) throw new Error('该对话未设置头像');
    try {
      const client = await clientOf();
      const inputPeer = entity === 'me' ? new lib.Api.InputPeerSelf() : await client.getInputEntity(entity);
      const location = new lib.Api.InputPeerPhotoFileLocation({
        peer: inputPeer,
        photoId: photo.photoId,
        big: false,
      });
      // 头像档无字节尺寸声明:按 160 档封顶 512KB 单块取
      const buf = await downloadBytes(photo.dcId || client.session.dcId, location, CHUNK, imageTimeoutMs);
      if (buf && buf.length) return buf;
      throw new Error('头像下载为空');
    } catch (e) {
      if (e instanceof TgNotLoggedInError) throw e;
      // 头像渲染尺寸小,stripped 兜底画质可接受,维持回退;但失败必须留痕
      log('头像下载失败(' + tok.peerKey + '):' + ((e && e.message) || e));
      const stripped = strippedFallback([photo]);
      if (stripped) return stripped;
      throw e;
    }
  }

  async function serveImage(u) {
    const tok = tokenParse(u);
    const key = String(u);
    const inflight = imageInflight.get(key);
    if (inflight) return inflight; // 同 token 在途去重
    const p = (async () => {
      if (tok.kind === 't') return serveThumb(tok);
      if (tok.kind === 'p') return servePhoto(tok);
      return serveAvatar(tok);
    })();
    imageInflight.set(key, p);
    try {
      return await p;
    } finally {
      if (imageInflight.get(key) === p) imageInflight.delete(key); // settle 出表
    }
  }

  // ---------- 对话视频页(iterMessages filter;锚排他 + 探测位) ----------

  /** iterMessages → 降序数组 */
  async function collectIter(entity, opts) {
    const out = [];
    await call(async (client) => {
      for await (const m of client.iterMessages(entity, opts)) {
        if (m && m.id && m.className !== 'MessageEmpty') out.push(m);
      }
    });
    return out;
  }

  const ladders = new Map(); // 深分页游标梯子(页号/搜索 → 游标;TTL+上限)

  function ladderGet(prefix, page) {
    const l = ladders.get(prefix);
    if (!l) return null;
    const hit = l.m.get(page);
    if (!hit) return null;
    if (Date.now() - hit.at > CURSOR_TTL) { l.m.delete(page); return null; }
    hit.at = Date.now();
    return hit.cursor;
  }

  function ladderSet(prefix, page, cursor) {
    let l = ladders.get(prefix);
    if (!l) { l = { m: new Map() }; ladders.set(prefix, l); }
    l.m.set(page, { cursor, at: Date.now() });
    while (l.m.size > CURSOR_PAGES_MAX) l.m.delete(l.m.keys().next().value); // 丢最旧
  }

  function intCoerce(v, d) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : d;
  }

  /**
   * 单页取数:iterMessages({filter: InputMessagesFilterVideo, offsetId: 锚,
   * limit: size+1})。MTProto offsetId 排他(锚条已在上页消费,无须 TDLib
   * 版的「+2 锚剔除补偿」),+1 为探测位判 hasMore。
   */
  async function pageOnce(peerKey, prefix, page, effSize) {
    const entity = await entityOf(peerKey);
    const anchor = page > 1 ? ladderGet(prefix, page) : null;
    const limit = Math.min(HISTORY_LIMIT_MAX, effSize + 1);
    const got = await collectIter(entity, {
      filter: new lib.Api.InputMessagesFilterVideo(),
      ...(anchor != null ? { offsetId: Number(anchor) } : {}),
      limit,
    });
    const hasMore = got.length > effSize;
    const items = got.slice(0, effSize);
    if (hasMore && items.length) {
      ladderSet(prefix, page + 1, Number(items[items.length - 1].id)); // 下页锚=本页最旧一条
    }
    return { msgs: items, hasMore };
  }

  async function fetchPeerVideoPage(peerKey, page, size) {
    if (!isPeerKey(peerKey)) throw new Error('Telegram 对话键非法:' + peerKey);
    const effSize = Math.max(1, Math.min(VIDEO_SIZE_MAX, Math.floor(Number(size) || 24)));
    const prefix = 'v:' + peerKey;
    if (page > 1 && ladderGet(prefix, page) == null) {
      // 深跳页:梯子只存内存,过期/重启后按序从第一页走到目标页(每页一次
      // 请求,上限 CURSOR_PAGES_MAX;应用侧恒从第一页起翻,深跳仅手工触发)
      if (page > CURSOR_PAGES_MAX) throw new Error('视频分页过深,请从第一页重新翻起');
      for (let k = 1; k < page; k++) {
        const r = await pageOnce(peerKey, prefix, k, effSize);
        if (!r.hasMore) return { msgs: [], hasMore: false }; // 提前见底
      }
    }
    return pageOnce(peerKey, prefix, page, effSize);
  }

  // ---------- 视频面 facade ----------

  async function listPeerVideos(peerKey, o = {}) {
    const page = intCoerce(o.page, 1);
    const size = intCoerce(o.size, 24);
    const r = await fetchPeerVideoPage(peerKey, page, size);
    const items = r.msgs.map((m) => videoItemOf(peerKey, m)).filter(Boolean);
    return { items, page, hasMore: r.hasMore };
  }

  async function getVideoDetail(id) {
    const { peerKey, msgId } = parseVideoId(id);
    const msg = await getMessage(peerKey, localMsgIdOf(msgId));
    const info = videoInfoOf(msg);
    if (!info || !info.doc) throw new Error('该 Telegram 消息不是视频,无法查看详情');
    let name = '';
    try {
      const hit = (await listChats()).find((d) => d.peerKey === peerKey);
      name = (hit && hit.name) || '';
    } catch (_e) { /* 对话表失败不阻塞详情 */ }
    return {
      id,
      title: titleOf(msg, info),
      cover: '/api/img/telegram?u=' + encodeURIComponent(thumbToken(id)),
      duration: info.duration,
      hd: Boolean((info.w || 0) >= 1280 || (info.h || 0) >= 720),
      resolution: info.w && info.h ? info.w + 'x' + info.h : '',
      uploadDate: msg && msg.date ? new Date(msg.date * 1000).toISOString().slice(0, 10) : '',
      tags: [], // Telegram 无标签体系
      categories: name ? [{ id: peerKey, name }] : [],
    };
  }

  // ---------- 全局视频搜索(messages.SearchGlobal + 三元组游标) ----------

  /**
   * 全局搜索单页:messages.SearchGlobal{q, filter: video, offsetRate/
   * offsetPeer/offsetId}(游标三元组:rate + 上一页最旧消息的 peer+id)。
   * 响应 messages.SearchGlobal{nextRate, messages, chats, users}——
   * hasMore 以「+1 探测位」判定(权威);游标入梯(内存,InputPeer 对象
   * 直接持有,不再序列化)。
   */
  async function searchOnce(kw, prefix, page, cursor, effSize) {
    const selfId = String(selfUserId() || '');
    const r = await call(async (client) => {
      const offsetPeer = cursor && cursor.peer ? cursor.peer : new lib.Api.InputPeerEmpty();
      return client.invoke(new lib.Api.messages.SearchGlobal({
        q: kw,
        filter: new lib.Api.InputMessagesFilterVideo(),
        minDate: 0,
        maxDate: 0,
        offsetRate: (cursor && Number(cursor.rate)) || 0,
        offsetPeer,
        offsetId: (cursor && Number(cursor.id)) || 0,
        limit: Math.min(HISTORY_LIMIT_MAX, effSize + 1),
      }));
    });
    const raw = (r && Array.isArray(r.messages) ? r.messages : [])
      .filter((m) => m && m.id && m.className !== 'MessageEmpty');
    const hasMore = raw.length > effSize;
    const items = raw.slice(0, effSize);
    if (hasMore && items.length) {
      const last = items[items.length - 1];
      // 下一页 offsetPeer:响应 chats/users 里找 last.peerId 对应实体构造 InputPeer
      const pool = [...((r && r.chats) || []), ...((r && r.users) || [])];
      const peer = inputPeerFor(last.peerId, pool);
      ladderSet(prefix, page + 1, { rate: (r && Number(r.nextRate)) || 0, peer, id: Number(last.id) });
    }
    // 归位 peerKey(msg.peerId;命中自己 → saved)
    const out = [];
    for (const m of items) {
      const pk = peerKeyOfPeer(m.peerId, selfId);
      if (!pk) continue;
      out.push({ msg: m, peerKey: pk });
    }
    return { rows: out, hasMore };
  }

  function inputPeerFor(peer, pool) {
    if (!peer) return null;
    const Api = lib.Api;
    if (peer.className === 'PeerUser') {
      const u = pool.find((x) => x.className === 'User' && String(x.id) === String(peer.userId));
      if (u && u.accessHash != null) {
        return new Api.InputPeerUser({ userId: u.id, accessHash: u.accessHash });
      }
      return null;
    }
    if (peer.className === 'PeerChat') {
      const c = pool.find((x) => /Chat/.test(x.className) && String(x.id) === String(peer.chatId));
      if (c) return new Api.InputPeerChat({ chatId: c.id });
      return null;
    }
    if (peer.className === 'PeerChannel') {
      const c = pool.find((x) => /Channel/.test(x.className) && String(x.id) === String(peer.channelId));
      if (c && c.accessHash != null) {
        return new Api.InputPeerChannel({ channelId: c.id, accessHash: c.accessHash });
      }
      return null;
    }
    return null;
  }

  async function searchVideos(kw, o = {}) {
    const page = intCoerce(o.page, 1);
    const size = intCoerce(o.size, 24);
    const k = String(kw || '').trim();
    if (!k) return { items: [], page, hasMore: false }; // 空关键词不发上游
    const effSize = Math.max(1, Math.min(VIDEO_SIZE_MAX, size));
    const prefix = 's:' + k;
    let cursor = ladderGet(prefix, page);
    if (cursor == null && page > 1) {
      if (page > CURSOR_PAGES_MAX) throw new Error('视频搜索分页过深,请从第一页重新翻起');
      for (let k2 = 1; k2 < page; k2++) {
        const r = await searchOnce(k, prefix, k2, ladderGet(prefix, k2), effSize);
        if (!r.hasMore) return { items: [], page, hasMore: false };
      }
      cursor = ladderGet(prefix, page);
    }
    const r = await searchOnce(k, prefix, page, cursor || null, effSize);
    const items = r.rows.map((x) => videoItemOf(x.peerKey, x.msg)).filter(Boolean);
    return { items, page, hasMore: r.hasMore };
  }

  // ---------- 插件聚合(list/boards/related;语义与 TDLib 版一致) ----------

  async function pluginList(o = {}) {
    const page = intCoerce(o.page, 1);
    const size = intCoerce(o.size, 24);
    const dialogs = (await listChats())
      .filter((d) => VIDEO_KINDS.has(d.kind))
      .slice(0, LIST_DIALOGS);
    const results = await mapLimitFailSoft(dialogs, AGGREGATE_CONCURRENCY,
      (d) => fetchPeerVideoPage(d.peerKey, page, size));
    const merged = [];
    let anyMore = false;
    results.forEach((r, i) => {
      if (!r) return;
      if (r.hasMore) anyMore = true;
      for (const m of r.msgs) merged.push({ msg: m, peerKey: dialogs[i].peerKey, at: m.date || 0 });
    });
    merged.sort((a, b) => b.at - a.at); // 按消息时间降序归并切页
    const items = merged.slice(0, size)
      .map((x) => videoItemOf(x.peerKey, x.msg))
      .filter(Boolean);
    return { items, page, hasMore: anyMore || merged.length > size };
  }

  async function pluginBoards() {
    const dialogs = (await listChats())
      .filter((d) => VIDEO_KINDS.has(d.kind))
      .slice(0, BOARDS_DIALOGS);
    const results = await mapLimitFailSoft(dialogs, AGGREGATE_CONCURRENCY,
      (d) => fetchPeerVideoPage(d.peerKey, 1, BOARDS_PAGE_SIZE));
    const sections = [];
    results.forEach((r, i) => {
      if (!r) return;
      const items = r.msgs
        .map((m) => videoItemOf(dialogs[i].peerKey, m))
        .filter(Boolean);
      if (!items.length) return; // 无视频的对话不占板块位
      sections.push({
        id: dialogs[i].peerKey,
        title: dialogs[i].name || ('Telegram 对话 ' + dialogs[i].peerKey),
        list: { items, page: 1, hasMore: true },
      });
    });
    return { sections };
  }

  async function pluginRelated(id, o = {}) {
    const { peerKey } = parseVideoId(id);
    const size = intCoerce(o.size, 24);
    const r = await fetchPeerVideoPage(peerKey, 1, size + 1);
    const items = r.msgs
      .filter((m) => videoIdOf(peerKey, Number(m.id)) !== String(id))
      .map((m) => videoItemOf(peerKey, m))
      .filter(Boolean)
      .slice(0, size);
    return { items, page: 1, hasMore: true };
  }

  // ---------- 账号态作废 / 收尾 ----------

  /**
   * 作废全部本域账号态缓存(engine dropCaches 广播):纪元自增拒旧结算,
   * 块缓存/在途表/元数据/令牌/分页梯子一并清空。不主动断开客户端。
   */
  function dropCaches() {
    cacheEpoch += 1;
    chunkCache.clear();
    chunkBytes = 0;
    chunkInflight.clear();
    metaCache.clear();
    tokenCache.clear();
    imageInflight.clear();
    ladders.clear();
    return Promise.resolve();
  }

  function close() {
    dropCaches();
  }

  return {
    signStream,
    verifyStream,
    serveImage,
    resolveStreamTarget,
    createRangeStream,
    listPeerVideos,
    getVideoDetail,
    searchVideos,
    pluginList,
    pluginBoards,
    pluginRelated,
    dropCaches,
    close,
  };
}
