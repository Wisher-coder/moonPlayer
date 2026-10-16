// ============================================================================
// normalize.js —— teleproto(MTProto)Message → 前端渲染契约的纯函数归一化
// ----------------------------------------------------------------------------
// 契约基准与 TDLib 时代逐字一致:{ id, peerKey, kind, date, out, views, from,
// text, entities, groupedId, forward, viaBot, signature, replyTo, media,
// inlineKeyboard, replyKeyboard, service },媒体载荷嵌在与 kind 同名的子对象里。
// 输入换为 teleproto 原生对象(Api.Message/Api.MessageService/CustomMessage,
// 字段形态出处 tmpTelegram/teleproto/teleproto/tl/generated/api.d.ts,layer 230)
// 后,实体类名天然就是契约的 MessageEntity*(无需映射表);键盘/相册/投票的
// 不透明 bytes(option/data)以 base64 直通——写侧 vote/callback 原样回传,
// 不再有 TDLib 时代的「序号 base64 假码」换算层。
//
// 关键 schema 实查(layer 230,与旧 GramJS 有出入处逐条注明):
//   · Message extends CustomMessage:字段驼峰(peerId/fromId/viaBotId/
//     replyTo(MessageReplyHeader)/fwdFrom(MessageFwdHeader)/postAuthor/
//     groupedId(bigInt)/views/entities[]/replyMarkup;正文在 .message 字符串)
//   · 服务消息 = Api.MessageService{action: MessageAction*}(TDLib 无包装类,
//     MTProto 显式分型;文案映射逐条对照旧 chat.js/TDLib 版)
//   · 键盘为统一按钮 schema(229+):ReplyInlineMarkup{rows:
//     KeyboardInlineButtonRow{buttons: KeyboardInlineButton{text,type}}};
//     回调载荷在 InlineButtonTypeCallback{data:bytes};回复键盘
//     ReplyKeyboardMarkup{rows:KeyboardButtonRow{buttons:KeyboardButton{text,
//     type}},placeholder}(请求系按钮 ButtonTypeRequest*)
//   · Photo.sizes = PhotoSize{type,w,h,size}(无 location 字段——下载地址由
//     InputPhotoFileLocation{thumbSize:type} 派生)/ PhotoSizeProgressive
//     {sizes[]}/ PhotoStrippedSize{bytes}(需重建 JPEG 头)/ PhotoPathSize
//   · Poll{question:TextWithEntities,answers[PollAnswer{text,option:bytes}],
//     quiz/closed/multipleChoice};结果在 MessageMediaPoll.results
//     (PollResults{totalVoters,results[PollAnswerVoters{option,voters,chosen,
//     correct}],solution})
//   · Document.attributes:DocumentAttributeVideo{duration,w,h,roundMessage,
//     nosound}/Animated/Filename/Sticker{emoji}/Voice{duration}/Audio{title,
//     performer,duration}
//
// 本文件零 I/O:发送者/回复目标等外部解析结果经 ctx(Map)注入;防御红线
// 同旧版:单条归一化异常由调用方降级 unsupported 占位,本层只做「意外字段
// 防御性兜底、绝不抛」的纯映射。
// ============================================================================
import { thumbToken, avatarToken, photoToken, videoIdOf } from './shared.js';
import * as defaultLib from 'teleproto';

// ============ 基础小工具 ============

// 伪 URL 令牌 → img 代理完整地址(契约形状的一部分)
export function imgOf(token) {
  return '/api/img/telegram?u=' + encodeURIComponent(token);
}

// unix 秒 → ISO;0/缺省 → null
function isoOf(sec) {
  const n = Number(sec) || 0;
  return n > 0 ? new Date(n * 1000).toISOString() : null;
}

// bytes(TypedArray/Buffer)→ base64 字符串;空值回 ''
export function b64OfBytes(b) {
  if (!b || !b.length) return '';
  try { return Buffer.from(b).toString('base64'); } catch (_e) { return ''; }
}

// TextWithEntities(Layer 230:question/answer 均此形态)→ 纯文本
export function textOfFte(fte) {
  if (!fte) return '';
  if (typeof fte === 'string') return fte; // 历史形态防御
  return String(fte.text || '');
}

// 秒数 → 「x 分 y 秒」人话(服务消息通话/自动删除时长)
function humanSeconds(s) {
  const n = Math.max(0, Math.round(Number(s) || 0));
  if (n < 60) return n + ' 秒';
  return Math.floor(n / 60) + ' 分 ' + (n % 60) + ' 秒';
}

// ============ Peer ↔ peerKey 编解码(MTProto 原生;全引擎单一实现) ============

/**
 * MTProto Peer(PeerUser/PeerChat/PeerChannel)→ peerKey。PeerUser 命中
 * selfId → 'saved'。空/未知形态回 null(调用方过滤)。
 */
export function peerKeyOfPeer(peer, selfId = '') {
  const cn = peer && peer.className;
  if (cn === 'PeerUser') {
    const id = String(peer.userId);
    return selfId && id === String(selfId) ? 'saved' : 'u' + id;
  }
  if (cn === 'PeerChat') return 'g' + peer.chatId;
  if (cn === 'PeerChannel') return 'c' + peer.channelId;
  return null;
}

/**
 * 标记形数字 id(频道 -100xxxx / 群 -xxxx / 用户 xxxx;与 shared.markedOf
 * 同一数值空间,即 TDLib chat_id 空间)→ peerKey;secret/非法段回 ''。
 */
export function chatIdToPeerKey(chatId, selfId = '') {
  const id = Number(chatId);
  if (!Number.isSafeInteger(id) || id === 0) return '';
  if (id > 0) return String(selfId) && String(id) === String(selfId) ? 'saved' : 'u' + id;
  if (id <= -2000000000000) return 'other'; // secret chat 段:降级不支持
  if (id <= -1000000000000) return 'c' + (-id - 1000000000000);
  return 'g' + (-id);
}

/** peerKey → 标记形数字 id;saved 依赖 selfId,非法键抛中文错 */
export function peerKeyToChatId(peerKey, selfId = '') {
  const s = String(peerKey || '');
  if (s === 'saved') {
    const me = Number(selfId);
    if (!Number.isSafeInteger(me) || me <= 0) {
      throw new Error('尚未获取账号信息,无法定位「我的收藏」对话');
    }
    return me;
  }
  if (/^c\d+$/.test(s)) return -(1000000000000 + Number(s.slice(1)));
  if (/^g\d+$/.test(s)) return -Number(s.slice(1));
  if (/^u\d+$/.test(s)) return Number(s.slice(1));
  throw new Error('Telegram 对话 id 非法:' + peerKey);
}

// ============ 实体(MessageEntity*;类名即契约,无需映射表) ============

/**
 * entities → 契约实体数组。offset/length 原样直通(MTProto 与 TDLib 同为
 * UTF-16 码元);TextUrl 补 url、MentionName 补 userId。
 */
export function entitiesOf(entities) {
  return (entities || []).map((e) => {
    const out = {
      type: String((e && e.className) || 'MessageEntityUnknown'),
      offset: Number(e.offset) || 0,
      length: Number(e.length) || 0,
    };
    if (e && e.url) out.url = String(e.url);
    if (e && e.userId != null) out.userId = String(e.userId);
    return out;
  });
}

// ============ 服务消息(MessageAction* → 中文) ============

/**
 * MessageAction 类名判定(显式集合;服务消息 = MessageService,action 字段)。
 */
export function isServiceAction(action) {
  return Boolean(action && typeof action.className === 'string' && action.className.startsWith('MessageAction'));
}

/**
 * 服务消息 action → 居中灰字中文。文案与 TDLib 版逐条对齐(messageChat* 系)。
 */
export function serviceTextOf(action, { out = false } = {}) {
  if (!action) return '服务消息';
  switch (action.className) {
    case 'MessageActionChatCreate': return '创建了群组「' + (action.title || '') + '」';
    case 'MessageActionChannelCreate': return '创建了频道「' + (action.title || '') + '」';
    case 'MessageActionChatEditTitle': return '修改名称为「' + (action.title || '') + '」';
    case 'MessageActionChatEditPhoto': return '更换了头像';
    case 'MessageActionChatDeletePhoto': return '删除了头像';
    case 'MessageActionChatAddUsers': return '加入了成员';
    case 'MessageActionChatDeleteUser': return out ? '移除了成员' : '退出了群组';
    case 'MessageActionChatJoinedByLink': return '通过邀请链接加入了群组';
    case 'MessageActionChatJoinedByRequest': return '加入了群组(经管理员批准)';
    case 'MessageActionChatMigrateTo': return '群组已升级为超级群组';
    case 'MessageActionChannelMigrateFrom': return '群组由「' + (action.title || '') + '」迁移而来';
    case 'MessageActionPinMessage': return (out ? '置顶' : '被置顶') + '了一条消息';
    case 'MessageActionScreenshotTaken': return '截取了屏幕截图';
    case 'MessageActionHistoryClear': return '清空了聊天记录';
    case 'MessageActionContactSignUp': return '加入了 Telegram';
    case 'MessageActionGameScore': return '游戏得分 ' + (Number(action.score) || 0);
    case 'MessageActionSetMessagesTTL': {
      const sec = Number(action.period) || 0;
      return sec > 0 ? '消息自动删除已设为 ' + humanSeconds(sec) : '已关闭消息自动删除';
    }
    case 'MessageActionPhoneCall': {
      // 未接判定:任意非空 discardReason 即未接(Busy/Declined/Missed 均算)
      const missed = action.discardReason && action.discardReason.className !== 'PhoneCallDiscardReasonHangup';
      const video = Boolean(action.video);
      if (Number(action.duration) > 0) return (video ? '视频通话' : '通话') + '时长 ' + humanSeconds(action.duration);
      if (missed) return video ? '未接的视频通话' : '未接的通话';
      return video ? '视频通话' : '通话';
    }
    case 'MessageActionChatSetTheme': return '服务消息';
    default: return '服务消息'; // 未识别 action:宁模糊不错译
  }
}

// ============ 媒体八面(mediaOf;MTProto 原生形态) ============

// 相册尺寸档 → 展示宽高(PhotoSize/PhotoSizeProgressive 取最大;Stripped/Path 无尺寸)
function maxDimsOf(sizes) {
  let w = 0; let h = 0;
  for (const s of sizes || []) {
    if (!s) continue;
    const sw = Number(s.w) || 0;
    const sh = Number(s.h) || 0;
    if (sw > w) w = sw;
    if (sh > h) h = sh;
  }
  return { w: w || null, h: h || null };
}

/** minithumbnail(base64 JPEG)→ data URL;缺失回 null */
function miniThumbDataUrlOf(mini) {
  if (!mini) return null;
  const s = typeof mini === 'string' ? mini : String(mini || '');
  return s ? 'data:image/jpeg;base64,' + s : null;
}

/**
 * 消息 media(MessageMedia*)→ 契约 media 子对象 {kind,<kind>:{...}}。
 * 优先级与载荷字段与 TDLib 版逐字段同形;photo/video 的字节访问全部走伪
 * URL 令牌(经 /api/img 代理),本函数零下载。
 */
export function mtMediaOf(media, videoId) {
  if (!media) return null;
  const Api = defaultLib.Api;
  if (media instanceof Api.MessageMediaPhoto) {
    const photo = media.photo;
    if (!(photo instanceof Api.Photo)) return null;
    const { w, h } = maxDimsOf(photo.sizes);
    const out = {
      kind: 'photo',
      photo: {
        w, h,
        url: imgOf(photoToken(videoId, 'm', false)),
        fullUrl: imgOf(photoToken(videoId, 'x', false)),
      },
    };
    const mini = miniThumbDataUrlOf(photo.minithumbnail);
    if (mini) out.photo.miniThumb = mini;
    return out;
  }
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document;
    if (!(doc instanceof Api.Document)) return null;
    return mediaOfDocument(doc, videoId);
  }
  if (media instanceof Api.MessageMediaWebPage) {
    const wp = media.webpage;
    if (!(wp instanceof Api.WebPage) || !wp.url) return null;
    return {
      kind: 'webpage',
      webpage: {
        url: String(wp.url),
        title: String(wp.title || ''),
        description: String(wp.description || ''),
        siteName: String(wp.siteName || ''),
        photo: wp.photo instanceof Api.Photo ? imgOf(photoToken(videoId, 'm', true)) : null,
      },
    };
  }
  if (media instanceof Api.MessageMediaPoll) {
    const poll = media.poll;
    if (!(poll instanceof Api.Poll)) return null;
    const results = media.results instanceof Api.PollResults ? media.results : null;
    const per = new Map((results && results.results || []).map((r) => [b64OfBytes(r.option), r]));
    return {
      kind: 'poll',
      poll: {
        id: String(poll.id != null ? poll.id : ''),
        question: textOfFte(poll.question),
        options: (poll.answers || []).map((a) => ({
          text: textOfFte(a.text),
          option: b64OfBytes(a.option), // 不透明 bytes 的 base64(写侧 vote 原样回传)
        })),
        results: {
          total: Number(results && results.totalVoters) || 0,
          per: (poll.answers || []).map((a) => {
            const r = per.get(b64OfBytes(a.option)) || {};
            return {
              option: b64OfBytes(a.option),
              voters: Number(r.voters) || 0,
              chosen: Boolean(r.chosen),
              correct: Boolean(r.correct),
            };
          }),
          solution: (results && results.solution) || null,
        },
        closed: Boolean(poll.closed),
        multipleChoice: Boolean(poll.multipleChoice),
        quiz: Boolean(poll.quiz),
      },
    };
  }
  if (media instanceof Api.MessageMediaGeo || media instanceof Api.MessageMediaGeoLive) {
    const g = media.geo;
    if (!g) return null;
    return { kind: 'geo', geo: { lat: Number(g.lat) || 0, long: Number(g.long) || 0 } };
  }
  if (media instanceof Api.MessageMediaVenue) {
    // layer 230:字段内联(geo/title/address/provider/venueId/venueType),无 Venue 包装类
    const g = media.geo;
    if (!g) return null;
    return {
      kind: 'geo',
      geo: {
        lat: Number(g.lat) || 0, long: Number(g.long) || 0,
        title: String(media.title || ''),
        address: String(media.address || ''),
      },
    };
  }
  if (media instanceof Api.MessageMediaContact) {
    return {
      kind: 'contact',
      contact: {
        name: (((media.firstName || '') + ' ' + (media.lastName || '')).trim()) || '联系人',
        phone: String(media.phoneNumber || ''),
      },
    };
  }
  return { kind: 'unsupported', unsupported: { note: '暂不支持的媒体类型(' + String(media.className) + ')' } };
}

/**
 * Document → 契约 media 子对象(按 attributes 分流:视频/圆形视频/动图并入
 * video 面、贴纸、语音、音频、普通文件——TDLib 版 mediaKindOf/docInfoOf 同判)。
 * layer 230 注意:无 DocumentAttributeVoice——语音 = DocumentAttributeAudio
 * {voice:true}(字段 voice 位分流音频/语音)。
 */
export function mediaOfDocument(doc, videoId) {
  const Api = defaultLib.Api;
  let video = null; let animated = false; let sticker = null;
  let audio = null; let name = '';
  for (const a of doc.attributes || []) {
    if (a instanceof Api.DocumentAttributeVideo) video = a;
    else if (a instanceof Api.DocumentAttributeAnimated) animated = true;
    else if (a instanceof Api.DocumentAttributeSticker) sticker = a;
    else if (a instanceof Api.DocumentAttributeAudio) audio = a;
    else if (a instanceof Api.DocumentAttributeFilename) name = String(a.fileName || '');
  }
  const size = Number(doc.size) || 0;
  if (video || animated) {
    const v = video || {};
    return {
      kind: 'video',
      video: {
        videoId,                                        // 直通 /video/telegram/<videoId>
        cover: imgOf(thumbToken(videoId)),
        duration: Math.round(Number(v.duration)) || 0,
        w: Number(v.w) || null,
        h: Number(v.h) || null,
        size,
        round: Boolean(video && video.roundMessage),    // 圆形视频(视频留言)
      },
    };
  }
  if (sticker) {
    const dims = maxDimsOf(doc.thumbs);
    return {
      kind: 'sticker',
      sticker: {
        emoji: String(sticker.emoji || ''),
        animated: animated || String(doc.mimeType || '') !== 'image/webp',
        url: imgOf(thumbToken(videoId)),
        w: dims.w, h: dims.h,
      },
    };
  }
  if (audio && audio.voice) {
    return {
      kind: 'voice',
      voice: { duration: Math.round(Number(audio.duration)) || 0, size, mime: String(doc.mimeType || '') },
    };
  }
  if (audio) {
    return {
      kind: 'audio',
      audio: {
        duration: Math.round(Number(audio.duration)) || 0,
        size,
        mime: String(doc.mimeType || ''),
        name: String(audio.title || name || ''),
        performer: String(audio.performer || ''),
      },
    };
  }
  return {
    kind: 'document',
    document: {
      name: name || '文件',
      size,
      mime: String(doc.mimeType || 'application/octet-stream'),
      thumb: imgOf(thumbToken(videoId)),
    },
  };
}

// ============ 键盘归一化(统一按钮 schema,layer 229+) ============

/**
 * inline 键盘(ReplyInlineMarkup{rows[KeyboardInlineButtonRow{buttons
 * [KeyboardInlineButton{text,type}]}]})→ 契约二维数组。仅映射 callback/url/
 * copy/game 四种可执行面;Callback(requiresPassword)/WebView/SwitchInline/
 * Buy/UserProfile 等如实降级 unknown 灰钮。
 * callback 的 data(bytes)→ base64 直通(与契约一致,写侧原样回传)。
 */
function inlineKeyboardOf(markup) {
  const rows = (markup.rows || []).map((row) => (row.buttons || []).map((btn) => {
    const t = (btn && btn.type) || {};
    const base = { text: String((btn && btn.text) || '') };
    switch (t.className) {
      case 'InlineButtonTypeCallback':
        if (t.requiresPassword) return { type: 'unknown', ...base }; // 两步密码回调未实现
        return { type: 'callback', ...base, data: b64OfBytes(t.data) };
      case 'InlineButtonTypeUrl':
        return { type: 'url', ...base, url: String(t.url || '') };
      case 'InlineButtonTypeCopy':
        return { type: 'copy', ...base, copy: String(t.copyText || '') }; // copyText(layer 230 字段)
      case 'InlineButtonTypeGame':
        return { type: 'game', ...base };
      default:
        return { type: 'unknown', ...base };
    }
  })).filter((r) => r.length);
  return rows.length ? rows : null;
}

/** 回复键盘(ReplyKeyboardMarkup)→ {rows,placeholder};请求系按钮压 request 标记 */
function replyKeyboardOf(markup) {
  const rows = (markup.rows || []).map((row) => (row.buttons || []).map((btn) => {
    const t = (btn && btn.type) || {};
    const request = ({
      ButtonTypeRequestPhone: 'phone',
      ButtonTypeRequestGeoLocation: 'geo',
      ButtonTypeRequestPoll: 'poll',
      ButtonTypeRequestPeer: 'peer',
      ButtonTypeSimpleWebView: 'webview',
    })[t.className] || null;
    return { text: String((btn && btn.text) || ''), request };
  })).filter((r) => r.length);
  if (!rows.length) return null;
  return { rows, placeholder: markup.placeholder ? String(markup.placeholder) : null };
}

// 消息级键盘归一化总入口(inline 与 reply 互斥;Hide/ForceReply 双 null)
export function mtKeyboardOf(replyMarkup) {
  const rm = replyMarkup;
  if (!rm) return { inlineKeyboard: null, replyKeyboard: null };
  if (rm.className === 'ReplyInlineMarkup') {
    return { inlineKeyboard: inlineKeyboardOf(rm), replyKeyboard: null };
  }
  if (rm.className === 'ReplyKeyboardMarkup') {
    return { inlineKeyboard: null, replyKeyboard: replyKeyboardOf(rm) };
  }
  return { inlineKeyboard: null, replyKeyboard: null };
}

// ============ 短标 / 预览(对话目录 lastMessage 复用面) ============

const MEDIA_LABELS = {
  photo: '[图片]', video: '[视频]', document: '[文件]', sticker: '[贴纸]',
  voice: '[语音]', audio: '[音乐]', webpage: '[链接]', poll: '[投票]',
  geo: '[位置]', contact: '[联系人]', unsupported: '[消息]',
};

/**
 * 消息媒体种类 → 机读短标;纯文本/服务消息/无媒体回 null。
 * 判定分支与 mtMediaOf 同源(显式导出:dialogs/updates 域复用)。
 */
export function mediaKindOf(msg) {
  const m = msg && msg.media;
  if (!m || msg.action) return null;
  const Api = defaultLib.Api;
  if (m instanceof Api.MessageMediaPhoto) return m.photo instanceof Api.Photo ? 'photo' : null;
  if (m instanceof Api.MessageMediaDocument) {
    const doc = m.document;
    if (!(doc instanceof Api.Document)) return null;
    let video = false; let animated = false; let sticker = false;
    let voice = false; let audio = false;
    for (const a of doc.attributes || []) {
      if (a instanceof Api.DocumentAttributeVideo) video = true;
      else if (a instanceof Api.DocumentAttributeAnimated) animated = true;
      else if (a instanceof Api.DocumentAttributeSticker) sticker = true;
      else if (a instanceof Api.DocumentAttributeAudio) {
        if (a.voice) voice = true; else audio = true; // layer 230:语音=Audio.voice 位
      }
    }
    if (video || animated) return 'video';
    if (sticker) return 'sticker';
    if (voice) return 'voice';
    if (audio) return 'audio';
    return 'document';
  }
  if (m instanceof Api.MessageMediaWebPage) return 'webpage';
  if (m instanceof Api.MessageMediaPoll) return 'poll';
  if (m instanceof Api.MessageMediaGeo || m instanceof Api.MessageMediaGeoLive
    || m instanceof Api.MessageMediaVenue) return 'geo';
  if (m instanceof Api.MessageMediaContact) return 'contact';
  if (m instanceof Api.MessageMediaEmpty) return null;
  return 'unsupported';
}

function mediaKindLabelOf(msg) {
  const kind = mediaKindOf(msg);
  return kind ? MEDIA_LABELS[kind] : '';
}

/**
 * 对话目录 lastMessage 用的纯文本预览(零网络):正文首行 > 媒体种类标签;
 * 服务消息走 serviceTextOf 中文映射。
 */
export function previewOf(msg) {
  if (!msg) return '';
  if (msg.action) return serviceTextOf(msg.action, { out: Boolean(msg.out) });
  const text = String(msg.message || '').trim();
  if (text) return text.split(/\r?\n/)[0].slice(0, 80);
  return mediaKindLabelOf(msg);
}

/**
 * 转发来源名(隐藏来源用户名 fromName / 频道署名 postAuthor),供对话目录
 * lastMessage.fromName(只取消息自带元数据——群内普通发言者不逐条回源)。
 */
export function forwardNameOf(msg) {
  const fwd = msg && msg.fwdFrom;
  if (!fwd) return '';
  const fromName = String(fwd.fromName || '');
  if (fromName) return fromName;
  return String(fwd.postAuthor || ''); // messageOriginChannel/Chat 的 author_signature 同义
}

// 目录 lastMessage 元数据包(dialogs.js 直取)
export function previewMetaOf(msg) {
  if (!msg || !msg.id) return null;
  return {
    preview: previewOf(msg),
    out: Boolean(msg.out),
    fromName: forwardNameOf(msg),
    date: isoOf(msg.date),
    mediaKind: msg.action ? 'service' : mediaKindOf(msg),
  };
}

// 回复目标摘要行:正文首行 > 媒体种类标签 > 空
function snippetOf(msg) {
  const text = String((msg && msg.message) || '').trim();
  if (text) return text.split(/\r?\n/)[0].slice(0, 80);
  return mediaKindLabelOf(msg);
}

/**
 * 回复目标 id 提取:MessageReplyHeader.replyToMsgId;MessageReplyStoryHeader
 * /无头回 null(契约无对应面,按无回复处理)。跨会话回复(replyToPeerId)仅
 * 取本会话 id——跨贴回复摘要不逐条回源。
 */
export function replyTargetIdOf(msg) {
  const rt = msg && msg.replyTo;
  if (rt && rt.className === 'MessageReplyHeader') {
    return Number(rt.replyToMsgId) > 0 ? Number(rt.replyToMsgId) : 0;
  }
  return 0;
}

// ============ 发送者(Api.User → from 契约对象) ============

/**
 * MTProto User → 契约 {id,name,isBot,username,avatar}。自己 → saved 伪对话
 * 头像。双形态 username 兼容(平字段 ?? usernames 活动名,layer 漂移防御)。
 */
export function contractUserOf(u, selfId = '') {
  if (!u || u.id == null) return null;
  const id = String(u.id);
  const username = String(u.username
    || (u.usernames && Array.isArray(u.usernames.activeUsernames) && u.usernames.activeUsernames[0])
    || '');
  const name = (((u.firstName || '') + ' ' + (u.lastName || '')).trim())
    || (username ? '@' + username : '')
    || 'Telegram 用户';
  return {
    id,
    name,
    isBot: Boolean(u.bot),
    username,
    avatar: imgOf(avatarToken(selfId && id === String(selfId) ? 'saved' : 'u' + id)),
  };
}

// ============ normalizeOne:单条消息 → 契约对象 ============

// 频道浏览量:普通消息 MTProto 不带 views(仅频道/超级组)——>0 才外发
function viewsOf(msg) {
  const vc = Number(msg && msg.views) || 0;
  return vc > 0 ? vc : null;
}

/**
 * 归一化一条 teleproto Message/MessageService → 契约对象。
 * ctx 为批量预解析的上下文:users:Map(String(userId)→info)、replies:
 * Map(msgId→{msg}|{deleted:true}|{})、selfId:自己的 id 字符串。
 * 只做纯映射,任何意外字段防御性兜底,不抛(调用方另有整条兜底)。
 */
export function normalizeOne(peerKey, msg, ctx = {}) {
  const users = ctx.users || new Map();
  const replies = ctx.replies || new Map();
  const isService = Boolean(msg.action);
  const out = Boolean(msg.out);
  const id = Number(msg.id) || 0;
  const videoId = videoIdOf(peerKey, id);

  // from:仅 PeerUser → ctx 预解析用户;PeerChat/PeerChannel(频道形态)一律
  // null——频道消息署名走 signature/forward,不产发送者面
  const fromPeer = msg.fromId;
  const from = fromPeer && fromPeer.className === 'PeerUser'
    ? (users.get(String(fromPeer.userId)) || null)
    : null;

  // 转发头:隐藏来源名(fromName)> 来源用户名(fromId 命中 ctx)>
  // 频道/匿名管理员署名(postAuthor)
  let forward = null;
  const fwd = msg.fwdFrom;
  if (fwd) {
    let name = String(fwd.fromName || '');
    if (!name && fwd.fromId && fwd.fromId.className === 'PeerUser') {
      const u = users.get(String(fwd.fromId.userId));
      if (u) name = u.name || '';
    }
    if (!name) name = String(fwd.postAuthor || '');
    forward = { name, date: isoOf(fwd.date) };
  }

  // via bot:viaBotId(0=无)→ ctx 命中取 @username|name
  let viaBot = null;
  if (msg.viaBotId && Number(msg.viaBotId) > 0) {
    const u = users.get(String(msg.viaBotId));
    viaBot = u ? (u.username ? '@' + u.username : u.name) : '机器人';
  }

  // 回复目标:批量补齐结果(缺消息占位「原消息已删除」)
  let replyTo = null;
  const replyId = replyTargetIdOf(msg);
  if (replyId > 0) {
    const target = replies.get(replyId);
    if (target && target.msg) {
      const t = target.msg;
      const tFromPeer = t.fromId;
      const tFrom = tFromPeer && tFromPeer.className === 'PeerUser'
        ? users.get(String(tFromPeer.userId)) : null;
      replyTo = {
        msgId: Number(t.id),
        name: (tFrom && tFrom.name) || '',
        snippet: snippetOf(t),
      };
    } else {
      replyTo = {
        msgId: replyId,
        name: '',
        snippet: target && target.deleted ? '原消息已删除' : '',
      };
    }
  }

  return {
    id,
    peerKey,
    kind: isService ? 'service' : 'message',
    date: isoOf(msg.date),
    out,
    views: viewsOf(msg),
    from,
    text: isService ? '' : String(msg.message || ''), // caption 与正文同为 .message
    entities: isService ? [] : entitiesOf(msg.entities),
    groupedId: msg.groupedId ? String(msg.groupedId) : null, // 相册分组(bigInt)
    forward,
    viaBot,
    signature: msg.postAuthor ? String(msg.postAuthor) : null, // 频道管理员署名
    replyTo,
    media: isService ? null : mtMediaOf(msg.media, videoId),
    ...mtKeyboardOf(msg.replyMarkup),
    service: isService ? { text: serviceTextOf(msg.action, { out }) } : null,
  };
}

/**
 * 单条归一化异常 → unsupported 占位(保 id/保分页)。
 */
export function unsupportedPlaceholder(peerKey, msg) {
  return {
    id: Number(msg && msg.id) || 0,
    peerKey,
    kind: 'message',
    date: msg && msg.date ? isoOf(msg.date) : null,
    out: Boolean(msg && msg.out),
    views: null, from: null, text: '', entities: [],
    groupedId: null, forward: null, viaBot: null, signature: null, replyTo: null,
    media: { kind: 'unsupported', unsupported: { note: '消息解析失败,暂无法展示' } },
    inlineKeyboard: null, replyKeyboard: null, service: null,
  };
}
