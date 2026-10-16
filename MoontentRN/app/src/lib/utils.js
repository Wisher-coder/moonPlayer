// ============================================================================
// utils.js —— 通用工具
// ----------------------------------------------------------------------------
// 契约：cn() / fmtDur()；另附 NextWeb 同源的 parseDurText 与封面代理宽度档
// （coverSrc），供省流模式等消费（超出契约的附加导出，不影响契约消费方）。
// ============================================================================

// 类名合并（RN 版轻量实现）：支持 字符串 / 数组 / {类名: 真值} 对象，
// 过滤假值后以空格连接。工程未装 clsx / tailwind-merge（RN 场景下
// tailwind 冲突消解收益极小），NativeWind 的 className 拼接用本实现即可。
export function cn(...inputs) {
  const out = [];
  const push = (x) => {
    if (!x) return;
    if (typeof x === 'string' || typeof x === 'number') {
      const s = String(x).trim();
      if (s) out.push(s);
    } else if (Array.isArray(x)) {
      for (const item of x) push(item);
    } else if (typeof x === 'object') {
      for (const k of Object.keys(x)) if (x[k]) out.push(k);
    }
  };
  for (const input of inputs) push(input);
  return out.join(' ');
}

// 时长秒 → m:ss / h:mm:ss 展示（null 安全）
export function fmtDur(s) {
  if (s == null || s === '' || !isFinite(Number(s))) return '';
  const n = Math.max(0, Math.floor(Number(s)));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const ss = String(n % 60).padStart(2, '0');
  return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + ss : m + ':' + ss;
}

// "58:26" / "1:23:45" 形态的展示串 → 秒（解析失败返回 null）
export function parseDurText(t) {
  if (t == null) return null;
  const m = String(t).trim().match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return null;
  if (m[3] != null) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  return (+m[1]) * 60 + (+m[2]);
}

// ===== 封面响应式宽度档（与后端 /api/img 的 w 白名单一一对应，两边同步改）=====
export const COVER_WIDTHS = [320, 480, 640, 960];
// 省流档固定 320：手机网格卡约 46~92vw(≤400px)、横滚卡 176px，320 宽已覆盖
// 全部展示位 ×2~3 DPR，是「最省字节且不糊」的一档
export const COVER_SAVER_W = 320;

// 给代理封面 URL 追加宽度档：coverSrc(url, 320) → '.../api/img/x?u=…&w=320'。
// RN 侧封面已由 client.js 绝对化（含 http://基址前缀），故判据是 URL 中含
// '/api/img/' 路径；外部 CDN 直链绝不乱拼参数。非白名单档位原样返回
export function coverSrc(url, w) {
  if (typeof url !== 'string' || url.indexOf('/api/img/') < 0 || COVER_WIDTHS.indexOf(w) < 0) return url;
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'w=' + w;
}
