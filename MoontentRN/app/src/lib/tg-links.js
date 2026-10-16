// ============================================================================
// tg-links.js —— t.me / tg:// 深链解析(纯函数,零平台依赖)
// ----------------------------------------------------------------------------
// 契约(核心导出):
//   parseTgLink(url) → {kind:'jump', peerKey?, domain?, msgId?} | {kind:'invite', invite} | {kind:'external'}
//     · kind='jump'   —— 本应用可承接的「跳进某个对话(可选定位到某条消息)」链
//                        接:带 peerKey 的可直接路由(t.me/c/<id> 私有频道帖);
//                        带 domain 的需先经 GET /api/telegram/resolve 解析成
//                        peerKey(t.me/<username>、tg://resolve);
//     · kind='invite' —— 邀请链接(t.me/+hash / t.me/joinchat/<hash>):invite
//                        为规范化的 https://t.me/+hash,页面经 GET /resolve?
//                        invite= checkChatInviteLink——已加入的频道/群组应用内
//                        直达,未加入才提示后外开(官方客户端同款,N3 承接);
//     · kind='external' —— 其余一律外链(贴纸包/发票/web app/story/boost 等
//                        保留路径、无关域名),由调用方走系统打开或如实提示,
//                        不得伪装承接;
//     · msgId 仅在解析到 >0 的消息 id 时携带(数字),否则缺省。
// 菜单适配导出(蓝图二 §3.4 openLinkContextMenu「外部打开」项;纯函数增量,
//   不改 parseTgLink 契约):
//   toExternalUrl(url) → string
//     · 把任意消息内链接折算成「可交系统浏览器打开」的 http(s) 绝对地址:
//       http(s)/无协议头 → 补 https:// 原样;tg://resolve?domain=x[&post=n]
//       → https://t.me/x[/n];其余 tg:// scheme(贴纸包/邀请/web app 等无
//       网页等价物)→ ''(不可外开,调用方如实提示,不伪装承接)。
// 覆盖面(对照 tmpTelegram/webk internalLinkProcessor 的路径注册表取「可路由
// 到聊天域」的最小集,其余显式放弃):
//   · https?://t.me/c/<channelId>[/<topicId>]*/<msgId>(telegram.me 同域,
//     协议头可省):私有频道帖,peerKey='c'+裸频道 id(不带 -100 前缀,与
//     server tg.js peerKeyFromPeer 同口径);无消息段则只跳会话;
//   · https?://t.me/<username>/<msgId>(telegram.me 同域,协议头可省):
//     公开帖/私聊消息,domain=username;无消息段只跳会话;
//   · tg://resolve?domain=<username>&post=<msgId>:scheme 版用户名解析。
// 用户名规则与服务端 resolvePeerByUsername 同口径:4~64 位字母/数字/下划线,
// 可带 @ 前缀;webk 注册过的 t.me 保留路径(share/boost/invoice/…)不是用户
// 名,一律 external(「其余一律 external」红线)。纯字符串处理,不触碰
// DOM/RN API,SSG 静态导出评估安全。
// ============================================================================

// 用户名形态(与服务端 tg.js resolvePeerByUsername 的校验同款)
const USERNAME_RE = /^[a-zA-Z0-9_]{4,64}$/;
// 非负整数字段(消息 id / 频道裸 id)
const NUM_RE = /^\d+$/;

// t.me 保留路径(取 webk internalLinkProcessor 注册过的路径名 + Telegram 官方
// 保留的 login/proxy/socks 等):这些段形状上常能过用户名正则(如 share/boost/
// call 均为 4~6 位),但绝不是用户名——必须显式排除,防把 t.me/share/xxx 之类
// 的功能链接当用户名去 resolve(m 段/s 段/c 段长度不足,正则天然排除,不列)
const RESERVED_PATHS = new Set([
  'joinchat', 'join', 'share', 'addstickers', 'addemoji', 'addlist',
  'invoice', 'boost', 'giftcode', 'nft', 'call', 'addstyle',
  'login', 'proxy', 'socks', 'verify', 'contact', 'contacts',
  'passport', 'telegrampassport',
]);

// 查询串取参(纯字符串切分,不依赖 URLSearchParams——Hermes/web 一致行为)
function queryParam(qs, key) {
  for (const part of qs.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = eq < 0 ? part : part.slice(0, eq);
    if (k !== key) continue;
    const v = eq < 0 ? '' : part.slice(eq + 1);
    try {
      return decodeURIComponent(v.replace(/\+/g, '%2B'));
    } catch (_e) {
      return v; // 非法百分号转义:原样返回,上层正则会拒掉
    }
  }
  return '';
}

// 路径段逐段 decode(非法转义原样保留,交给后续正则判定)
function decodeSeg(s) {
  try {
    return decodeURIComponent(s);
  } catch (_e) {
    return s;
  }
}

/**
 * 解析 t.me / telegram.me / tg://resolve 深链。
 * @param {string} url 原始链接文本(可带/省 https:// 前缀,可带查询串/锚点)
 * @returns {{kind:'jump', peerKey?:string, domain?:string, msgId?:number}
 *   | {kind:'external'}}
 */
export function parseTgLink(url) {
  const s = String(url == null ? '' : url).trim();
  if (!s) return { kind: 'external' };

  // —— tg://resolve?domain=<username>&post=<msgId>(其余 tg:// scheme 一律外链) ——
  if (/^tg:\/\//i.test(s)) {
    if (!/^tg:\/\/resolve\b/i.test(s)) return { kind: 'external' };
    const qAt = s.indexOf('?');
    const qs = qAt >= 0 ? s.slice(qAt + 1).split('#')[0] : '';
    const domain = String(queryParam(qs, 'domain') || '').replace(/^@/, '');
    if (!USERNAME_RE.test(domain)) return { kind: 'external' };
    const postRaw = queryParam(qs, 'post');
    const msgId = NUM_RE.test(postRaw) ? Number(postRaw) : 0;
    return msgId > 0 ? { kind: 'jump', domain, msgId } : { kind: 'jump', domain };
  }

  // —— t.me / telegram.me(可带 https:// 前缀;其余域名一律外链) ——
  const m = /^(?:https?:\/\/)?(t\.me|telegram\.me)(?:\/|$)/i.exec(s);
  if (!m) return { kind: 'external' };
  // 只取路径(剥查询串/锚点),切分并逐段 decode
  const path = s.slice(m[0].length).split(/[?#]/, 1)[0];
  const segs = path.split('/').map(decodeSeg).filter((x) => x !== '');
  if (!segs.length) return { kind: 'external' };

  // —— t.me/c/<channelId>[/<topicId>]*/<msgId>:私有频道帖 ——
  // 裸频道 id(无 -100 前缀);末段数字为消息 id(话题链 c/<id>/<topic>/<msg>
  // 取最后一段,与 webk PRIVATE_POST 的 post=pathnameParams 末段口径一致)
  if (segs[0] === 'c') {
    const id = segs[1];
    if (!id || !NUM_RE.test(id)) return { kind: 'external' };
    const peerKey = 'c' + id;
    const last = segs[segs.length - 1];
    const msgId = segs.length >= 3 && NUM_RE.test(last) ? Number(last) : 0;
    return msgId > 0 ? { kind: 'jump', peerKey, msgId } : { kind: 'jump', peerKey };
  }

  // —— 邀请链接(t.me/+hash / t.me/joinchat/<hash>):invite 承接——页面
  //    openUrl 经 /resolve?invite= checkChatInviteLink,已加入的频道/群组
  //    应用内直达(官方客户端同款),未加入才提示后外开(N3 承接;规范成
  //    https://t.me/+hash 形态交服务端) ——
  if (segs[0].startsWith('+') || segs[0] === 'joinchat') {
    const hash = segs[0] === 'joinchat' ? segs[1] : segs[0].slice(1);
    if (hash && /^[A-Za-z0-9_-]{4,}$/.test(hash)) {
      return { kind: 'invite', invite: 'https://t.me/+' + hash };
    }
    return { kind: 'external' };
  }

  // —— t.me/<username>[/<msgId>]:公开用户名(可定位到某条消息) ——
  const name = segs[0];
  if (!USERNAME_RE.test(name) || RESERVED_PATHS.has(name.toLowerCase())) {
    return { kind: 'external' };
  }
  if (segs.length === 1) return { kind: 'jump', domain: name };
  // 第二段必须是纯数字消息 id;非数字段(web app 名 / 's' 故事 / 'live' 等)
  // 是其它类型的链接,不在承接面内 → external
  if (segs.length === 2 && NUM_RE.test(segs[1])) {
    const msgId = Number(segs[1]);
    return msgId > 0 ? { kind: 'jump', domain: name, msgId } : { kind: 'jump', domain: name };
  }
  return { kind: 'external' };
}

export default parseTgLink;

/**
 * 把消息内链接折算成「可交系统浏览器打开」的 http(s) 绝对地址（纯函数）。
 * 供链接长按菜单的「外部打开」项使用：t.me 链接在本应用内走 parseTgLink
 * 分流承接，菜单的外部打开则强制走系统浏览器；tg://resolve 有网页等价物
 * （t.me/<domain>），其余 tg:// scheme 无网页等价物，返回空串由调用方如实
 * 提示（不伪装承接）。
 * @param {string} url 原始链接文本
 * @returns {string} http(s) 绝对地址；不可外开（含空输入/其余 tg://）→ ''
 */
export function toExternalUrl(url) {
  const s = String(url == null ? '' : url).trim();
  if (!s) return '';

  // —— tg://resolve?domain=<username>&post=<msgId> → https://t.me/<domain>[/<post>] ——
  if (/^tg:\/\//i.test(s)) {
    if (!/^tg:\/\/resolve\b/i.test(s)) return '';
    const qAt = s.indexOf('?');
    const qs = qAt >= 0 ? s.slice(qAt + 1).split('#')[0] : '';
    const domain = String(queryParam(qs, 'domain') || '').replace(/^@/, '');
    if (!USERNAME_RE.test(domain)) return '';
    const postRaw = queryParam(qs, 'post');
    const msgId = NUM_RE.test(postRaw) ? Number(postRaw) : 0;
    return msgId > 0 ? 'https://t.me/' + domain + '/' + msgId : 'https://t.me/' + domain;
  }

  // —— 已带 http(s) 协议头：原样交系统浏览器 ——
  if (/^https?:\/\//i.test(s)) return s;

  // —— 无协议头的裸域/链接（正文里常见的「t.me/xxx」「example.com」形态）：
  //    补 https:// 外开；调用方的 parseTgLink 分流仍按原文判定承接 ——
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}([/?#].*)?$/i.test(s)) return 'https://' + s;

  // —— 其余（mailto: 等其它 scheme / 乱串）：无浏览器等价物 ——
  return '';
}
