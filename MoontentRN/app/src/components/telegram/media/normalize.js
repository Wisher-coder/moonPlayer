// ============================================================================
// normalize.js —— 共享媒体面板的响应归一(URL 绝对化,单一映射点)
// ----------------------------------------------------------------------------
// /api/telegram/search(媒体浏览)响应里的图片地址是服务端内部令牌
// (https://tg.local/<...>)或相对代理地址(/api/img/telegram?u=...),喂给
// expo-image 前必须过本文件归一——语义与 hooks/use-chat-timeline.js 的
// normalizeDeep/tgMediaUrl 逐字同源(该函数不导出且其宿主文件不在本任务
// 改动范围,故在此同款落地;幂等,重复归一无副作用):
//   · tg.local 令牌 → 包 /api/img/telegram?u=<enc> 代理;
//   · 其余相对地址 → absolutizeUrl 绝对化(client.js 的 api-base 口径);
//   · URL 键集比 client.js 的 URL_KEYS 多 fullUrl 与 webpage.photo 字符串
//     形态(photo 键既可能是对象 media.photo 也可能是字符串 webpage.photo,
//     靠 typeof 守卫分流,只归一字符串值)。
// 日历端点(GET /calendar type=media)的 days[].thumb 同走 absolutizeMediaUrl。
// ============================================================================
import { absolutizeUrl } from '../../../lib/client.js';

const TG_TOKEN_HOST = 'https://tg.local/'; // 服务端图片伪 URL 令牌的宿主
const MAX_DEPTH = 8;                       // 深遍历防御式上限(同 client.js)

// 已知 URL 值键:命中且值为字符串即归一(client.js 键集 + fullUrl)
const URL_KEYS = new Set(['url', 'fullUrl', 'cover', 'thumb', 'avatar', 'photo']);

// —— 图片地址归一:伪 URL 令牌 → /api/img/telegram 代理 → 绝对化 ——
function tgMediaUrl(u) {
  if (typeof u !== 'string' || !u) return u || '';
  if (u.startsWith(TG_TOKEN_HOST)) {
    return absolutizeUrl('/api/img/telegram?u=' + encodeURIComponent(u));
  }
  return absolutizeUrl(u);
}

// 深遍历归一(重建新对象,不污染共享引用)
export function normalizeMediaDeep(v, depth = 0) {
  if (depth > MAX_DEPTH || v == null) return v;
  if (Array.isArray(v)) return v.map((x) => normalizeMediaDeep(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      const val = v[k];
      out[k] = URL_KEYS.has(k) && typeof val === 'string' ? tgMediaUrl(val) : normalizeMediaDeep(val, depth + 1);
    }
    return out;
  }
  return v;
}

// 归一化单条媒体消息:深归一 + id 防御式归一为数字(时间线 normalizeMsg 同款)
export function normalizeMediaMsg(m) {
  if (!m || typeof m !== 'object') return m;
  const out = normalizeMediaDeep(m, 0);
  if (out && out.id != null) out.id = Number(out.id) || 0;
  return out;
}

// 单个 URL 直通归一(日历 days[].thumb 用)
export function absolutizeMediaUrl(u) {
  return tgMediaUrl(u);
}
