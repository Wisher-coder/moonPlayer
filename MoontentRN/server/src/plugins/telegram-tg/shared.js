// ============================================================================
// shared.js —— Telegram 服务端共享纯逻辑(TDLib 唯一引擎;仅 Node 服务端运行)
// ----------------------------------------------------------------------------
// 收敛背景:server 原为双引擎——旧 mtproto 引擎(社区 fork 的 MTProto 客户端,
// 缺省)与本目录 TDLib 引擎,routes 按环境开关分发。2026-10 引擎收敛为 TDLib
// 唯一(官方维护库),mtproto 引擎目录整体删除;原先被 routes、registry 与
// tdlib 各域交叉引用的【无引擎耦合纯函数】逐字迁入本文件,保持单一实现不
// 复制。各符号的旧出处(mtproto 引擎删除前的 tg.js / media.js / index.js,
// 均已不存在)在逐段注释里留档供追溯。
//
// 现存消费面(grep 实查 2026-10-12):
//   TgNotLoggedInError / normTgError —— routes 两文件的 needLogin instanceof
//     判定与错误中文化;auth/media 域复用;
//   hasCreds / getCreds —— engine 凭据探测(无凭据不建 client)与 auth 域
//     凭据缺失中文文案;
//   PEER_RE / isPeerKey / markedOf / videoIdOf / parseVideoId —— peer/video
//     id 编解码契约(对话键 c|g|u|saved,视频键 <对话键>m<消息id>);
//   parseProxy —— TELEGRAM_PROXY SOCKS5 出口解析(tdjson-client 经 TDLib
//     addProxy 下发);
//   thumbToken / avatarToken / photoToken —— img 代理伪 URL 令牌构造器
//     (media/normalize 域与 routes /dialogs 头像包装复用);
//   mapLimitFailSoft —— 插件聚合取数的跨对话并发 fail-soft 面(media 域)。
//
// 迁移说明(与旧实现的仅有差异,均因旧客户端库依赖随引擎删除):
//   ① normTgError 去掉 `e instanceof errors.FloodWaitError` 分支(旧库的
//      错误类已不存在);字符串形 'FLOOD_WAIT_X' 与 code 420 判定原样保留;
//   ② parseProxy 解析失败的错误文案不再回显 TELEGRAM_PROXY 原值(该值可能
//      含代理账号口令,属敏感配置,不得进日志/响应)。
// ============================================================================

// ============ 错误形态(旧出处:已删除的 mtproto 客户端基座 tg.js:61-84) ============

// 未登录标记错误:路由层据此回 needLogin 语义,前端跳登录页。
// 类同一性是硬契约:routes/telegram.js fail() 与 routes/telegram-extras.js
// fail() 的 `e instanceof TgNotLoggedInError` 必须命中本类。
export class TgNotLoggedInError extends Error {
  constructor(msg) { super(msg || 'Telegram 未登录,请先在 Telegram 页面完成登录'); this.name = 'TgNotLoggedInError'; }
}

// 任意 Telegram 上游异常 → 面向用户的中文消息(保留原始 message 供日志)。
// 纯大写错误码(如 PHONE_CODE_INVALID)统一加「Telegram 接口错误:」前缀;
// 登录流程错误码由 auth 域另行映射(原样透传给 mapAuthError)。
export function normTgError(e) {
  if (e instanceof TgNotLoggedInError) return e;
  // CDN 重定向标记名(mtproto 时代遗留错误形态;TDLib 内部处理 CDN,防御性保留)
  if (e && e.name === 'CdnRedirectError') {
    return new Error('该文件位于 Telegram CDN,暂不支持中转播放');
  }
  // 限流:FLOOD_WAIT_X 字符串形态 / HTTP 420(TDLib 侧 429 由写侧映射表另译)
  if (e && e.errorMessage === 'FLOOD_WAIT_X') {
    const s = e.seconds || 60;
    const err = new Error(`Telegram 限流(FLOOD_WAIT),请约 ${s} 秒后再试`);
    err.isFlood = true;
    return err;
  }
  if (e && e.code === 420) return new Error('Telegram 限流,请稍后再试');
  const msg = (e && e.message) || String(e);
  // PHONE_CODE_INVALID / SESSION_PASSWORD_NEEDED 等登录流程错误原样透传(登录态机另译)
  return new Error(/^[A-Z_0-9]+$/.test(msg) ? 'Telegram 接口错误:' + msg : msg);
}

// ============ 凭据读取(旧出处:已删除的 mtproto 客户端基座 tg.js:86-98) ============

export function hasCreds() {
  return Boolean(getCreds(false));
}

export function getCreds(strict = true) {
  const id = parseInt(process.env.TELEGRAM_API_ID || '', 10);
  const hash = process.env.TELEGRAM_API_HASH || '';
  if (Number.isFinite(id) && id > 0 && hash) return { apiId: id, apiHash: hash };
  if (strict) throw new Error('缺少 Telegram 凭据:请在 server/.env 配置 TELEGRAM_API_ID / TELEGRAM_API_HASH(my.telegram.org 申请)');
  return null;
}

// ============ SOCKS5 出口代理解析(旧出处:已删除的 mtproto 客户端基座 tg.js:128-152) ============

// 可选 SOCKS5 出口(受限网络下 DC 直连被限速时恢复吞吐):
// TELEGRAM_PROXY=socks5://[user:pass@]host:port —— 惰性解析缓存一次,非法值
// 抛中文错误且【不回显原值】(不出网即失败,好过静默直连被慢速卡死)。
// 返回形态保持旧实现的 MTProto 客户端形状 {ip,port,socksType,username?,password?};
// TDLib 消费面(tdjson-client.js _initProxy)自行映射 ip→server/socksType→
// proxyTypeSocks5。未配置返回 null。
let proxyCache;
export function parseProxy() {
  if (proxyCache !== undefined) return proxyCache;
  const raw = (process.env.TELEGRAM_PROXY || '').trim();
  if (!raw) { proxyCache = null; return proxyCache; }
  try {
    const u = new URL(raw);
    if (u.protocol !== 'socks5:') throw new Error('仅支持 socks5:// 形态');
    proxyCache = {
      ip: u.hostname,
      port: Number(u.port) || 1080,
      socksType: 5,
      ...(u.username ? {
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password || ''),
      } : {}),
    };
  } catch (e) {
    // 不回显 raw:代理串可能内嵌账号口令(敏感,不得进日志/HTTP 响应)
    throw new Error('TELEGRAM_PROXY 解析失败:' + (e.message || e));
  }
  return proxyCache;
}

// ============ peer / video id 编解码(旧出处:已删除的 mtproto 客户端基座 tg.js:461-510) ============

const PEER_RE = /^(c\d+|g\d+|u\d+|saved)$/;
const VIDEO_RE = /^(c\d+|g\d+|u\d+|saved)m(\d+)$/;

/** 对话键 → 官方「标记形」数字 id(频道 -100xxxx / 群 -xxxx / 用户 xxxx);saved → 'me' */
export function markedOf(peerKey) {
  if (peerKey === 'saved') return 'me';
  if (/^c/.test(peerKey)) return -1000000000000 - Number(peerKey.slice(1));
  if (/^g/.test(peerKey)) return -Number(peerKey.slice(1));
  if (/^u/.test(peerKey)) return Number(peerKey.slice(1));
  return null;
}

export function videoIdOf(peerKey, msgId) { return peerKey + 'm' + String(msgId); }

export function parseVideoId(id) {
  const m = VIDEO_RE.exec(String(id || ''));
  if (!m) throw new Error('Telegram 视频 id 非法:' + id);
  return { peerKey: m[1], msgId: Number(m[2]) };
}

export function isPeerKey(s) { return PEER_RE.test(String(s || '')); }

/**
 * 消息 id shim:TDLib 时代打包 id(int53,local_id<<20)→ MTProto 原生 id
 * (int32)。小于 2^20 的输入视为已是本地形态(打包结果必 ≥2^20,真消息恒
 * ≥1)——旧 videoId/收藏/历史消息 id 在 teleproto 引擎下继续可解析。
 */
export function localMsgIdOf(tdlibId) {
  const n = Number(tdlibId);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Telegram 消息 id 非法:' + tdlibId);
  if (n < (1 << 20)) return n;
  return Number(BigInt(n) >> 20n);
}

// ============ img 代理伪 URL 令牌(旧出处:已删除的 mtproto 媒体核心 media.js:96-107) ============

// 伪 http 形态为过 img.js 的 u 门禁,插件内自行解析:
//   /t/<视频id> 封面、/a/<对话键> 头像、/p/<视频id>[w]/<档位> 相册图
const TG_HOST = 'https://tg.local/';

export function thumbToken(videoId) { return TG_HOST + 't/' + videoId; }
export function avatarToken(peerKey) { return TG_HOST + 'a/' + peerKey; }
// 相册图片令牌:tag 为档位(m=中档,气泡内展示;x=全档,查看器);web=true 时
// videoId 尾缀 w(网页预览图变体——同一条消息里 photo 可能来自 webpage.photo,
// 强拉时需按该标记取网页侧图片而非消息本体)
export function photoToken(videoId, tag, web) {
  return TG_HOST + 'p/' + videoId + (web ? 'w' : '') + '/' + tag;
}

// ============ 并发受限 fail-soft 映射(旧出处:已删除的 mtproto 插件 index.js:53-74) ============

/**
 * 并发受限的 fail-soft 映射:对 items 逐个执行 fn,单条失败置 null 丢弃,
 * 整体不因此报错;TgNotLoggedInError 例外——它是全局登录态,如实上抛。
 * @returns {Promise<Array>} 与 items 等长,失败位为 null
 */
export async function mapLimitFailSoft(items, limit, fn) {
  const out = new Array(items.length).fill(null);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (e) {
        if (e instanceof TgNotLoggedInError) throw e; // 全局态:不吞
        out[idx] = null; // 单对话失败:fail-soft 丢弃
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
