// ============================================================================
// origin-pool.js —— 媒体 origin 分片池(纯模块,三端安全:无 DOM/window 依赖)
// ----------------------------------------------------------------------------
// 背景:服务端 /api/sites 响应数组里 id==='telegram' 的条目可携带可选字段
// shardPorts: number[](可用端口,主端口在前)与 streamSlots: number(看板并发
// 活跃流上限,由 lib/wall/stream-gate.js 消费,缺省 16)。字段缺失 = 旧服务端,
// 本模块保持「未启用」态,一切消费方回落现有单基址行为,零行为变化。
// 能力:仅当 API 基址形如 scheme://host:port(host 带显式端口)且路径为空或
// / 时,用同 host 逐个换端口生成多 origin(端口表序 = 池序,主端口在前 = 池
// 首);基址带路径 / 无显式端口(反代/缺省 443/80 部署)/ 解析失败 / 端口表
// 非法一律回落单基址(池退化为未启用)。/api/telegram/stream
// (视频流代理)与 /api/img(图片代理)两类「过本站服务器」的地址可在池内
// origin 间轮询分摊;其余地址(外部 CDN 直链等)不属分片面,原样交还调用方。
// 喂料:site-context 在站点清单到达(挂载首拉 / refreshSites)时调
// applyShardConfig(base, shardPorts);client.resetClientCache()(切基址)时调
// resetShardConfig() 先清池,防「新基址 + 旧 origin」串台,清单重拉到位后重喂。
// 纯度说明:全部逻辑只做字符串/数组运算 + 模块内一份喂料状态,不触碰任何平台
// API,web/native/静态导出求值三端安全。URL 解析手写正则(Hermes 无 URL 构造
// 器保证,与 client.js 查询串自建同理),任何解析失败一律回落单基址。
// ============================================================================
// —— 纯函数区(不读模块态)——

// 分片媒体路径前缀:本站代理的流与图片(可搬 origin 的唯一两面)
const MEDIA_PREFIXES = ['/api/telegram/stream', '/api/img'];

// 前缀命中判定(带边界:下一字符须为 '/'、'?'、'#' 或结尾,防 '/api/imgxy'
// 这类前缀串误命中)
function mediaPrefixHit(u) {
  if (typeof u !== 'string') return false;
  for (let i = 0; i < MEDIA_PREFIXES.length; i++) {
    const p = MEDIA_PREFIXES[i];
    if (u.startsWith(p)) {
      const c = u.charAt(p.length);
      if (c === '' || c === '/' || c === '?' || c === '#') return true;
    }
  }
  return false;
}

// 稳定字符串 hash(djb2 变体):同串必同值、跨平台一致(纯 charCode 运算),
// 供「按序号轮询」派生序号——封面按 URL、看板格子按 item.key
export function stableHash(s) {
  const str = String(s == null ? '' : s);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return h >>> 0;
}

// 端口表清洗:仅认 1~65535 整数,去重保序;非数组/全非法 → null(= 无分片)
function cleanPorts(shardPorts) {
  if (!Array.isArray(shardPorts)) return null;
  const out = [];
  for (let i = 0; i < shardPorts.length; i++) {
    const p = shardPorts[i];
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535) continue;
    if (out.indexOf(p) < 0) out.push(p);
  }
  return out.length ? out : null;
}

// 产出媒体 origin 池(纯函数):仅当基址形如 scheme://host:port(host 带显式
// 端口)且路径为空或 / 时,同 host 换端口逐个生成;否则/端口表非法/解析失败
// → 单元素 [基址]。主端口在端口表首位 → 池首即主 origin(与基址一致时消费
// 方零差异)。无显式端口的基址(https://域名、http://内网名——反代/端口映射
// 部署,协议缺省 443/80)不启用池:服务端上报的分片端口未必经代理转发,拼出
// 的 origin 大概率连不通,而「不启用池走基址」在此形态本就完整可用
export function buildOriginPool(apiBase, shardPorts) {
  const base = typeof apiBase === 'string' ? apiBase.trim() : '';
  if (!base) return [];
  const ports = cleanPorts(shardPorts);
  if (!ports) return [base];
  // 手写解析(Hermes 无 URL 保证):scheme://host[:port] 之后只允许空或 '/'
  const m = /^(https?):\/\/([^/?#]*)([^#]*)$/.exec(base);
  if (!m) return [base]; // 解析失败一律回落单基址
  const rest = m[3];
  if (rest !== '' && rest !== '/') return [base]; // 带路径/查询:非纯 origin 形态
  let hostPart = m[2];
  // 剥端口(IPv6 方括号形态保留方括号整体);hasPort=基址带显式端口
  let host;
  let hasPort = false;
  if (hostPart.charCodeAt(0) === 91 /* '[' */) {
    const close = hostPart.indexOf(']');
    if (close < 0) return [base]; // 残缺 IPv6
    host = hostPart.slice(0, close + 1);
    const tail = hostPart.slice(close + 1);
    if (tail) {
      if (!/^:\d+$/.test(tail)) return [base]; // ']' 后只能是空或 :port
      hasPort = true;
    }
  } else {
    const ci = hostPart.indexOf(':');
    if (ci >= 0) {
      if (!/^\d+$/.test(hostPart.slice(ci + 1))) return [base]; // 冒号后非纯数字端口
      host = hostPart.slice(0, ci);
      hasPort = true;
    } else {
      host = hostPart;
    }
  }
  if (!host) return [base];
  if (!hasPort) return [base]; // 无显式端口(反代/缺省 443/80):保守回落单基址
  const out = [];
  for (let i = 0; i < ports.length; i++) {
    const o = m[1] + '://' + host + ':' + ports[i];
    if (out.indexOf(o) < 0) out.push(o);
  }
  return out;
}

// 池内按序号取模选 origin(纯函数;负数/非数值序号安全取模,池空返回 null)
export function pickOrigin(pool, seq) {
  if (!Array.isArray(pool) || !pool.length) return null;
  const n = typeof seq === 'number' && isFinite(seq) ? Math.floor(seq) : 0;
  const i = ((n % pool.length) + pool.length) % pool.length;
  return typeof pool[i] === 'string' && pool[i] ? pool[i] : pool[0];
}

// 把 /api/telegram/stream 与 /api/img 开头的相对地址 absolutize 到指定 origin
// (纯函数):前缀带边界校验;origin 去尾斜杠后拼接;入参不匹配/非字符串原样
// 返回 u(调用方自行回落既有 absolutizeUrl 语义)
export function toOriginUrl(origin, u) {
  if (typeof u !== 'string' || !u) return u || '';
  if (!mediaPrefixHit(u)) return u;
  const o = typeof origin === 'string' ? origin.replace(/\/+$/, '') : '';
  if (!o) return u;
  return o + u;
}

// ============================================================================
// —— 模块态(site-context 喂 / client 切基址清;唯一可变部分)——
// ============================================================================
let fedPool = null; // string[] | null:null = 分片未启用(字段缺失/形态不符/已清)
let fedBase = '';   // 喂料时的基址(无尾斜杠;识别「基址绝对形态」的媒体地址用)

function samePool(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 喂料:站点清单到达/重拉时由 site-context 调。单元素池 = 无分片,等价未启用;
// 返回池是否发生变化(测试/调试用,消费方无需关心)
export function applyShardConfig(apiBase, shardPorts) {
  const pool = buildOriginPool(apiBase, shardPorts);
  fedBase = typeof apiBase === 'string' ? apiBase.trim().replace(/\/+$/, '') : '';
  const next = pool && pool.length > 1 ? pool : null;
  const changed = !samePool(next, fedPool);
  fedPool = next;
  return changed;
}

// 清池(切基址时 client.resetClientCache 调):立即回到未启用态,消费方回落
// 单基址行为;新清单到位后 site-context 用新基址重喂重建
export function resetShardConfig() {
  fedPool = null;
  fedBase = '';
}

// 当前池(只读引用,调用方勿改;null = 未启用)
export function getShardPool() {
  return fedPool;
}

// 识别可搬家的分片媒体路径:相对形态('/api/telegram/stream…'、'/api/img…')
// 或「喂料基址」的绝对形态('{base}/api/…' → 剥基址归一,client 的 deep-walk
// 绝对化产物即此形态);不属其一返回 null
export function shardPathOf(u) {
  if (typeof u !== 'string' || !u) return null;
  if (mediaPrefixHit(u)) return u;
  if (fedBase && u.startsWith(fedBase)) {
    const tail = u.slice(fedBase.length);
    if (mediaPrefixHit(tail)) return tail;
  }
  return null;
}

// 一键轮询(消费方主入口):
//   u   —— 相对或基址绝对形态的媒体地址;
//   seq —— 轮询序号(缺省 = 归一路径的稳定 hash,即「按 URL 稳定轮询」;
//          看板格子传 item.key 的 stableHash,播放页传 0 取池首)。
// 池启用且命中分片路径 → 池上对应 origin 的绝对地址;否则 null(调用方回落
// 既有 absolutizeUrl 语义,行为与现在一致)
export function shardMediaUrl(u, seq) {
  if (!fedPool || fedPool.length < 2) return null;
  const rel = shardPathOf(u);
  if (!rel) return null;
  const origin = pickOrigin(fedPool, seq == null ? stableHash(rel) : seq);
  if (!origin) return null;
  return toOriginUrl(origin, rel);
}
