// ============================================================================
// normalize.test.mjs —— MTProto Message → 契约消息归一化(真实 teleproto Api
// 类构造 fixture;零网络)。覆盖:peerKey 编解码、实体直通、服务消息文案、
// 媒体八面(photo/video/poll/webpage/geo/contact)、统一键盘 schema、
// normalizeOne 全字段、短标/预览。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { Api } from 'teleproto';
import {
  normalizeOne, unsupportedPlaceholder, peerKeyOfPeer, chatIdToPeerKey,
  peerKeyToChatId, entitiesOf, mtKeyboardOf, mediaKindOf, previewOf,
  forwardNameOf, contractUserOf, replyTargetIdOf, mtMediaOf,
} from '../../src/plugins/telegram-tg/normalize.js';

const SELF = '100';

function textMsg(over = {}) {
  return new Api.Message({
    id: 42, peerId: new Api.PeerChannel({ channelId: 500 }), date: 1759000000,
    message: 'hello', out: false, entities: [], ...over,
  });
}

test('peerKeyOfPeer:PeerUser/Chat/Channel 三形态 + saved 命中自己', () => {
  assert.equal(peerKeyOfPeer(new Api.PeerUser({ userId: 7 })), 'u7');
  assert.equal(peerKeyOfPeer(new Api.PeerUser({ userId: 100 }), SELF), 'saved');
  assert.equal(peerKeyOfPeer(new Api.PeerChat({ chatId: 9 })), 'g9');
  assert.equal(peerKeyOfPeer(new Api.PeerChannel({ channelId: 5 })), 'c5');
  assert.equal(peerKeyOfPeer(null), null);
});

test('chatIdToPeerKey / peerKeyToChatId:标记形数值空间往返(secret 段降级)', () => {
  assert.equal(peerKeyToChatId('c5', SELF), -(1000000000000 + 5));
  assert.equal(peerKeyToChatId('g9', SELF), -9);
  assert.equal(peerKeyToChatId('u7', SELF), 7);
  assert.equal(chatIdToPeerKey(-(1000000000000 + 5), SELF), 'c5');
  assert.equal(chatIdToPeerKey(-9, SELF), 'g9');
  assert.equal(chatIdToPeerKey(Number(SELF), SELF), 'saved');
  assert.equal(chatIdToPeerKey(8, SELF), 'u8');
  assert.equal(chatIdToPeerKey(-2100000000000, SELF), 'other'); // secret 段
  assert.throws(() => peerKeyToChatId('x9', SELF), /非法/);
});

test('entitiesOf:类名直通 MessageEntity*(TextUrl 带 url/MentionName 带 userId)', () => {
  const out = entitiesOf([
    new Api.MessageEntityBold({ offset: 0, length: 2 }),
    new Api.MessageEntityTextUrl({ offset: 3, length: 4, url: 'https://a.b' }),
    new Api.MessageEntityMentionName({ offset: 8, length: 1, userId: 5 }),
  ]);
  assert.equal(out[0].type, 'MessageEntityBold');
  assert.equal(out[1].url, 'https://a.b');
  assert.equal(out[2].userId, '5');
  assert.deepEqual([out[0].offset, out[0].length], [0, 2]);
});

test('normalizeOne:纯文本消息全字段契约(from/via/回复目标走 ctx)', () => {
  const replyTarget = textMsg({ id: 40, message: '被回复的原消息', fromId: new Api.PeerUser({ userId: 7 }) });
  const msg = textMsg({
    fromId: new Api.PeerUser({ userId: 7 }),
    viaBotId: 9,
    replyTo: new Api.MessageReplyHeader({ replyToMsgId: 40 }),
    fwdFrom: new Api.MessageFwdHeader({ fromName: '隐藏来源', date: 1758000000 }),
    postAuthor: 'admin',
    views: 1234,
    groupedId: 777,
  });
  const users = new Map([
    ['7', { id: '7', name: '张三', isBot: false, username: 'zs', avatar: null }],
    ['9', { id: '9', name: 'Bot', isBot: true, username: 'xxbot', avatar: null }],
  ]);
  const out = normalizeOne('c500', msg, { users, replies: new Map([[40, { msg: replyTarget }]]), selfId: SELF });
  assert.equal(out.id, 42);
  assert.equal(out.peerKey, 'c500');
  assert.equal(out.kind, 'message');
  assert.equal(out.from.name, '张三');
  assert.equal(out.viaBot, '@xxbot');
  assert.equal(out.forward.name, '隐藏来源');
  assert.equal(out.signature, 'admin');
  assert.equal(out.views, 1234);
  assert.equal(out.groupedId, '777');
  assert.deepEqual(out.replyTo, { msgId: 40, name: '张三', snippet: '被回复的原消息' });
  assert.equal(out.text, 'hello');
  assert.equal(out.service, null);
  assert.ok(String(out.date).startsWith('2025-'));
});

test('normalizeOne:频道消息 from 为 null(署名走 signature);已删回复占位', () => {
  const msg = textMsg({
    fromId: new Api.PeerChannel({ channelId: 500 }),
    replyTo: new Api.MessageReplyHeader({ replyToMsgId: 41 }),
  });
  const out = normalizeOne('c500', msg, { users: new Map(), replies: new Map([[41, { deleted: true }]]), selfId: SELF });
  assert.equal(out.from, null);
  assert.equal(out.replyTo.snippet, '原消息已删除');
});

test('normalizeOne:服务消息(MessageService.action)→ kind service + 中文文案', () => {
  const svc = new Api.MessageService({
    id: 50, peerId: new Api.PeerChannel({ channelId: 500 }), date: 1759000000,
    action: new Api.MessageActionChannelCreate({ title: '测试频道' }),
  });
  const out = normalizeOne('c500', svc, {});
  assert.equal(out.kind, 'service');
  assert.equal(out.service.text, '创建了频道「测试频道」');
  assert.equal(out.media, null);
  assert.equal(out.text, '');
});

test('mtMediaOf:photo 媒体(m 档 url/x 档 fullUrl;layer 230 Photo 已无 minithumbnail)', () => {
  const photo = new Api.Photo({
    id: 1, accessHash: 2, fileReference: Buffer.alloc(0), date: 0,
    sizes: [new Api.PhotoSize({ type: 'm', w: 320, h: 240, size: 12345 })],
  });
  const out = mtMediaOf(new Api.MessageMediaPhoto({ photo }), 'c500m42');
  assert.equal(out.kind, 'photo');
  assert.match(out.photo.url, /\/api\/img\/telegram\?u=/);
  assert.match(out.photo.fullUrl, /%2Fx/);
  assert.equal(out.photo.w, 320);
  assert.equal(out.photo.miniThumb, undefined); // layer 230:Photo 无 minithumbnail 字段
});

test('mtMediaOf:video 文档(属性分流)+ 轮播 poll(option bytes base64 直通)', () => {
  const doc = new Api.Document({
    id: 1, accessHash: 2, fileReference: Buffer.alloc(0), date: 0,
    mimeType: 'video/mp4', size: 1024, dcId: 4,
    attributes: [
      new Api.DocumentAttributeVideo({ duration: 61.4, w: 1920, h: 1080 }),
      new Api.DocumentAttributeFilename({ fileName: 'a.mp4' }),
    ],
  });
  const v = mtMediaOf(new Api.MessageMediaDocument({ document: doc }), 'c500m42');
  assert.equal(v.kind, 'video');
  assert.deepEqual([v.video.duration, v.video.w, v.video.h, v.video.size], [61, 1920, 1080, 1024]);
  assert.equal(v.video.round, false);

  const optA = Buffer.from('0'); // 不透明 option bytes
  const poll = new Api.Poll({
    id: 3, question: new Api.TextWithEntities({ text: '选哪个?', entities: [] }),
    answers: [new Api.PollAnswer({ text: new Api.TextWithEntities({ text: 'A', entities: [] }), option: optA })],
    quiz: false, multipleChoice: true,
  });
  const p = mtMediaOf(new Api.MessageMediaPoll({
    poll,
    results: new Api.PollResults({
      totalVoters: 9,
      results: [new Api.PollAnswerVoters({ option: optA, voters: 7, chosen: true })],
    }),
  }), 'c500m42');
  assert.equal(p.kind, 'poll');
  assert.equal(p.poll.question, '选哪个?');
  assert.equal(p.poll.options[0].text, 'A');
  assert.equal(Buffer.from(p.poll.options[0].option, 'base64').toString(), '0');
  assert.deepEqual(p.poll.results.per[0], { option: p.poll.options[0].option, voters: 7, chosen: true, correct: false });
  assert.equal(p.poll.results.total, 9);
  assert.equal(p.poll.multipleChoice, true);
});

test('mtMediaOf:语音/音频分流(Audio.voice 位)+ 动图并入 video 面', () => {
  const mk = (attrs) => mtMediaOf(new Api.MessageMediaDocument({ document: new Api.Document({
    id: 1, accessHash: 2, fileReference: Buffer.alloc(0), date: 0,
    mimeType: 'audio/ogg', size: 512, dcId: 4, attributes: attrs,
  }) }), 'x');
  const voice = mk([new Api.DocumentAttributeAudio({ duration: 30, voice: true })]);
  assert.equal(voice.kind, 'voice');
  assert.equal(voice.voice.duration, 30);
  const audio = mk([new Api.DocumentAttributeAudio({ duration: 180, title: '歌', performer: '人' })]);
  assert.equal(audio.kind, 'audio');
  assert.deepEqual([audio.audio.duration, audio.audio.name, audio.audio.performer], [180, '歌', '人']);
  const gif = mk([new Api.DocumentAttributeAnimated()]);
  assert.equal(gif.kind, 'video');
});

test('mtMediaOf:webpage 预览(带 photo 出 w 变体令牌;无 photo 恒 null)', () => {
  const wp = new Api.WebPage({
    id: 1, url: 'https://x.y/z', displayUrl: 'https://x.y/z', hash: 0,
    title: 'T', description: 'D', siteName: 'S',
    photo: new Api.Photo({ id: 1, accessHash: 2, fileReference: Buffer.alloc(0), date: 0, sizes: [] }),
  });
  const out = mtMediaOf(new Api.MessageMediaWebPage({ webpage: wp }), 'c500m42');
  assert.equal(out.kind, 'webpage');
  assert.equal(out.webpage.url, 'https://x.y/z');
  assert.match(out.webpage.photo, /w/);
  const bare = mtMediaOf(new Api.MessageMediaWebPage({ webpage: new Api.WebPage({ ...wp, photo: undefined }) }), 'c500m42');
  assert.equal(bare.webpage.photo, null);
});

test('mtMediaOf:geo/venue(内联字段)/contact;未知媒体 → unsupported', () => {
  const geo = mtMediaOf(new Api.MessageMediaGeo({ geo: new Api.GeoPoint({ lat: 1.5, long: 2.5 }) }), 'c500m42');
  assert.deepEqual(geo.geo, { lat: 1.5, long: 2.5 });
  const venue = mtMediaOf(new Api.MessageMediaVenue({
    geo: new Api.GeoPoint({ lat: 1, long: 2 }), title: 'V', address: 'A', provider: '', venueId: '', venueType: '',
  }), 'c500m42');
  assert.equal(venue.geo.title, 'V');
  assert.equal(venue.geo.address, 'A');
  const contact = mtMediaOf(new Api.MessageMediaContact({ phoneNumber: '+86138', firstName: '李', lastName: '四', vcard: '', userId: 0 }), 'c500m42');
  assert.equal(contact.contact.name, '李 四');
  const dice = mtMediaOf(new Api.MessageMediaDice({ value: 3, emoticon: '🎲' }), 'c500m42');
  assert.equal(dice.kind, 'unsupported');
});

test('mtKeyboardOf:统一按钮 schema(callback data base64/url/copy/game/unknown + 回复键盘请求位)', () => {
  const markup = new Api.ReplyInlineMarkup({
    rows: [
      new Api.KeyboardInlineButtonRow({ buttons: [
        new Api.KeyboardInlineButton({ text: '点我', type: new Api.InlineButtonTypeCallback({ data: Buffer.from('abc') }) }),
        new Api.KeyboardInlineButton({ text: '链接', type: new Api.InlineButtonTypeUrl({ url: 'https://a.b' }) }),
      ] }),
      new Api.KeyboardInlineButtonRow({ buttons: [
        new Api.KeyboardInlineButton({ text: '游戏', type: new Api.InlineButtonTypeGame() }),
        new Api.KeyboardInlineButton({ text: '复制', type: new Api.InlineButtonTypeCopy({ copyText: 'hi' }) }),
        new Api.KeyboardInlineButton({ text: '其它', type: new Api.InlineButtonTypeBuy() }),
      ] }),
    ],
  });
  const { inlineKeyboard, replyKeyboard } = mtKeyboardOf(markup);
  assert.equal(inlineKeyboard[0][0].type, 'callback');
  assert.equal(Buffer.from(inlineKeyboard[0][0].data, 'base64').toString(), 'abc');
  assert.equal(inlineKeyboard[0][1].url, 'https://a.b');
  assert.equal(inlineKeyboard[1][0].type, 'game');
  assert.equal(inlineKeyboard[1][1].copy, 'hi');
  assert.equal(inlineKeyboard[1][2].type, 'unknown');
  assert.equal(replyKeyboard, null);

  const reply = mtKeyboardOf(new Api.ReplyKeyboardMarkup({
    rows: [new Api.KeyboardButtonRow({ buttons: [
      new Api.KeyboardButton({ text: '电话', type: new Api.ButtonTypeRequestPhone() }),
      new Api.KeyboardButton({ text: '普通', type: new Api.ButtonTypeDefault() }),
    ] })],
    placeholder: '说点什么',
  }));
  assert.equal(reply.replyKeyboard.rows[0][0].request, 'phone');
  assert.equal(reply.replyKeyboard.rows[0][1].request, null);
  assert.equal(reply.replyKeyboard.placeholder, '说点什么');
  const none = mtKeyboardOf(undefined);
  assert.deepEqual(none, { inlineKeyboard: null, replyKeyboard: null });
});

test('mediaKindOf / previewOf / forwardNameOf / contractUserOf / replyTargetIdOf', () => {
  assert.equal(mediaKindOf(textMsg({ media: new Api.MessageMediaGeo({ geo: new Api.GeoPoint({ lat: 0, long: 0 }) }) })), 'geo');
  assert.equal(mediaKindOf(textMsg()), null);
  const svc = textMsg({ action: new Api.MessageActionPinMessage() });
  assert.equal(mediaKindOf(svc), null);
  assert.equal(previewOf(textMsg({ message: '正文第一行\n第二行' })), '正文第一行');
  assert.equal(forwardNameOf(textMsg({ fwdFrom: new Api.MessageFwdHeader({ fromName: 'X', date: 0 }) })), 'X');
  const user = new Api.User({ id: 7, firstName: '王', lastName: '', bot: false, username: 'w', status: undefined, accessHash: 0 });
  const cu = contractUserOf(user, SELF);
  assert.deepEqual([cu.id, cu.name, cu.isBot, cu.username], ['7', '王', false, 'w']);
  assert.match(cu.avatar, /a%2Fu7/);
  assert.equal(replyTargetIdOf(textMsg({ replyTo: new Api.MessageReplyHeader({ replyToMsgId: 12 }) })), 12);
  assert.equal(replyTargetIdOf(textMsg()), 0);
});

test('unsupportedPlaceholder:保 id/peerKey,媒体降级占位', () => {
  const out = unsupportedPlaceholder('c500', textMsg());
  assert.equal(out.id, 42);
  assert.equal(out.peerKey, 'c500');
  assert.equal(out.media.kind, 'unsupported');
  assert.equal(out.service, null);
});
