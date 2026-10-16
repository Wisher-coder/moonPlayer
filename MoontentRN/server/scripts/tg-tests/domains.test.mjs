// ============================================================================
// domains.test.mjs —— 数据域单元测试合集(dialogs/messages/writes/extras;
// 离线;mock 客户端注入)。覆盖:目录过滤与条目形状、聊天页三向分页游标、
// 写侧四件套编排、extras 纯函数与全局游标编解码。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { Api } from 'teleproto';
import { createTgDialogs, identityOfEntity, dialogEntryOf } from '../../src/plugins/telegram-tg/dialogs.js';
import { createMessages } from '../../src/plugins/telegram-tg/messages.js';
import { createTgWrites, pollOptionsFromB64, editFingerprintOf, mapTgError } from '../../src/plugins/telegram-tg/writes.js';
import {
  monthWindowUtc, encodeGlobalCursor, decodeGlobalCursor, inputPeerOfCursor,
  normalizeCalendarDays, mediaThumbTokenOf, statusTextOf, clampSearchLimit, senderIdFrom,
} from '../../src/plugins/telegram-tg/extras.js';

// ============ dialogs ============

function fakeDialog(entity, { unread = 0, mentions = 0, pinned = false, archived = false, message = null, date = 1759000000, muteUntil = 0 } = {}) {
  return {
    entity,
    dialog: {
      className: 'Dialog', unreadCount: unread, unreadMentionsCount: mentions,
      pinned, folderId: archived ? 1 : undefined,
      notifySettings: { className: 'PeerNotifySettings', muteUntil },
    },
    message,
    date,
    pinned,
    archived,
    unreadCount: unread,
    unreadMentionsCount: mentions,
    name: entity.title || entity.firstName,
  };
}

test('identityOfEntity:User/Chat/Channel(+megagroup)+saved 命中自己', () => {
  assert.deepEqual(identityOfEntity(new Api.User({ id: 7, firstName: 'A', bot: false }), null), { peerKey: 'u7', kind: 'user' });
  assert.deepEqual(identityOfEntity(new Api.User({ id: 100, firstName: '我', bot: false }), 100), { peerKey: 'saved', kind: 'saved' });
  assert.deepEqual(identityOfEntity(new Api.Chat({ id: 9, title: 'G' }), null), { peerKey: 'g9', kind: 'group' });
  assert.deepEqual(identityOfEntity(new Api.Channel({ id: 5, title: 'C', accessHash: 0 }), null), { peerKey: 'c5', kind: 'channel' });
  assert.deepEqual(identityOfEntity(new Api.Channel({ id: 6, title: 'S', accessHash: 0, megagroup: true }), null), { peerKey: 'c6', kind: 'group' });
  assert.equal(identityOfEntity(null), null);
});

test('dialogEntryOf:契约字段(unread/mentions/muted/pinned/lastMessage)', () => {
  const msg = new Api.Message({ id: 42, peerId: new Api.PeerChannel({ channelId: 5 }), date: 1759000000, message: '预览文本' });
  const d = fakeDialog(new Api.Channel({ id: 5, title: '频道X', accessHash: 0 }), {
    unread: 7, mentions: 2, pinned: true, muteUntil: Math.floor(Date.now() / 1000) + 3600, message: msg,
  });
  const e = dialogEntryOf(d, { ownUserId: 100 });
  assert.equal(e.peerKey, 'c5');
  assert.equal(e.name, '频道X');
  assert.equal(e.kind, 'channel');
  assert.equal(e.unreadCount, 7);
  assert.equal(e.unreadMentionsCount, 2);
  assert.equal(e.muted, true);
  assert.equal(e.pinned, true);
  assert.equal(e.lastMessage.preview, '预览文本');
  assert.equal(e.lastMessage.mediaKind, null);
});

test('createTgDialogs:getDialogs main 过滤归档/archive 反向/saved 恒顶 + entityOf 兜底', async () => {
  const dialogsRaw = [
    fakeDialog(new Api.Channel({ id: 5, title: '主列表频道', accessHash: 0 }), { message: new Api.Message({ id: 1, peerId: new Api.PeerChannel({ channelId: 5 }), date: 1759000100, message: '' }) }),
    fakeDialog(new Api.Channel({ id: 6, title: '归档频道', accessHash: 0 }), { archived: true }),
    fakeDialog(new Api.User({ id: 100, firstName: '我自己', bot: false }), {}),
  ];
  const client = { getDialogs: async () => dialogsRaw, getInputEntity: async (m) => new Api.InputPeerUser({ userId: 88, accessHash: 0 }) };
  const d = createTgDialogs({ getClient: async () => client, getSelfId: () => '100', log: () => {} });
  const main = await d.getDialogs('main');
  assert.deepEqual(main.map((x) => x.peerKey), ['saved', 'c5']); // saved 恒顶 + 归档被滤
  assert.equal(main[1].name, '主列表频道');
  const archive = await d.getDialogs('archive');
  assert.deepEqual(archive.map((x) => x.peerKey), ['c6']);
  // entityOf:表优先;miss 走 getInputEntity(marked)
  assert.equal((await d.entityOf('c5')).className, 'Channel');
  const u = await d.entityOf('u88');
  assert.equal(u.className, 'InputPeerUser');
  assert.equal(await d.entityOf('saved'), 'me');
  // 缓存失效
  d.dropCaches();
  assert.equal((await d.getDialogs('main', { staleOk: false })).length, 2);
});

// ============ messages:getChatPage 三向分页(iterMessages 游标) ============

function pagedClient(all, { newestId = null } = {}) {
  const calls = [];
  const client = {
    _media: {},
    getMessages: async (entity, { ids }) => ids.map((id) => all.find((m) => m.id === id)).map((m) => m || new Api.MessageEmpty({ id: 0 })),
    getEntity: async () => { throw new Error('nope'); },
    iterMessages: async function* iter(entity, params) {
      calls.push(params);
      let list = all;
      if (params.offsetId) list = list.filter((m) => Number(m.id) < Number(params.offsetId));
      if (params.addOffset && params.addOffset < 0) {
        // addOffset<0:窗口自「锚上方 |addOffset| 条」向下覆盖 → 取 id>锚 的
        // 最近 |addOffset| 条(降序),与引擎的「过滤 id>锚 + 条数判 hasNewer」配套
        const newer = all.filter((m) => Number(m.id) > Number(params.offsetId || 0));
        list = newer.slice(-Math.abs(Number(params.addOffset))).reverse();
      }
      for (const m of list.slice(0, Number(params.limit || 100))) yield m;
    },
  };
  if (newestId != null) {
    // 锚越顶探测(limit:1 → 最新一条)
    const orig = client.iterMessages.bind(client);
    client.iterMessages = async function* iter2(entity, params) {
      if (Number(params.limit) === 1 && !params.offsetId && !params.filter) {
        const newest = all[0];
        if (newest) yield newest;
        return;
      }
      yield* orig(entity, params);
    };
  }
  return { client, calls };
}

const CHAIN = [100, 95, 90, 85, 80, 75, 70].map((id) => new Api.Message({
  id, peerId: new Api.PeerChannel({ channelId: 5 }), date: 1759000000 + id, message: 'm' + id,
}));

function mkMessages(client) {
  return createMessages({
    getClient: async () => client,
    entityOf: async () => new Api.Channel({ id: 5, title: 'C', accessHash: 0 }),
    getSelfId: () => '100',
    log: () => {},
  });
}

test('getChatPage:最新一页(无锚)+1 探测判 hasOlder;升序输出', async () => {
  const { client, calls } = pagedClient(CHAIN);
  const page = await mkMessages(client).getChatPage('c5', { dir: 'around', limit: 3 });
  assert.deepEqual(page.items.map((x) => x.id), [90, 95, 100]); // 升序
  assert.equal(page.hasOlder, true); // 4 条 > 3
  assert.equal(calls[0].offsetId, 0);
});

test('getChatPage:older 锚排他(offsetId=锚,MTProto 原生)', async () => {
  const { client, calls } = pagedClient(CHAIN);
  const page = await mkMessages(client).getChatPage('c5', { anchor: 90, dir: 'older', limit: 2 });
  assert.deepEqual(page.items.map((x) => x.id), [80, 85]); // 锚排他(90 不含)
  assert.equal(page.hasOlder, true); // 3>2
  const olderCall = calls.find((c) => c.offsetId === 90 && c.limit === 3); // 首个调用是锚越顶探测(limit=1)
  assert.ok(olderCall, 'older 腿 offsetId=锚(排他)');
});

test('getChatPage:around 含锚两腿(旧腿 offsetId=锚+1)', async () => {
  const { client, calls } = pagedClient(CHAIN);
  const page = await mkMessages(client).getChatPage('c5', { anchor: 90, dir: 'around', limit: 2 });
  assert.deepEqual(page.items.map((x) => x.id), [85, 90, 95, 100]); // 旧腿 2 条(含锚)+ 新向 2 条
  const olderLeg = calls.find((c) => c.offsetId === 91);
  assert.ok(olderLeg, '含锚腿 offsetId=锚+1');
});

// ============ writes ============

test('pollOptionsFromB64:base64 不透明 bytes 直通;空/全空 400', () => {
  const b64 = Buffer.from('0').toString('base64');
  assert.equal(pollOptionsFromB64([b64, b64]).length, 2);
  assert.equal(pollOptionsFromB64([b64])[0].toString(), '0');
  assert.throws(() => pollOptionsFromB64([]), /不能为空/);
  assert.throws(() => pollOptionsFromB64(['', 'x']), /不能为空|非法/);
});

test('editFingerprintOf:键盘摘要参与指纹(markup-only 编辑可辨)', () => {
  const mk = (markup) => new Api.Message({
    id: 1, peerId: new Api.PeerChannel({ channelId: 5 }), date: 1, message: 'x', replyMarkup: markup,
  });
  const kb1 = new Api.ReplyInlineMarkup({ rows: [new Api.KeyboardInlineButtonRow({ buttons: [new Api.KeyboardInlineButton({ text: 'A', type: new Api.InlineButtonTypeCallback({ data: Buffer.from('1') }) })] })] });
  const kb2 = new Api.ReplyInlineMarkup({ rows: [new Api.KeyboardInlineButtonRow({ buttons: [
    new Api.KeyboardInlineButton({ text: 'A', type: new Api.InlineButtonTypeCallback({ data: Buffer.from('1') }) }),
    new Api.KeyboardInlineButton({ text: 'B', type: new Api.InlineButtonTypeUrl({ url: 'https://x' }) }),
  ] })] });
  assert.notEqual(editFingerprintOf(mk(kb1)), editFingerprintOf(mk(kb2))); // 结构差异可辨
  assert.equal(editFingerprintOf(mk(kb1)), editFingerprintOf(mk(kb1)));     // 同键盘恒同摘要
});

test('mapTgError:慢速模式/FLOOD_WAIT/写侧权限中文文案', () => {
  assert.match(mapTgError(Object.assign(new Error('SLOWMODE_WAIT_30'), { errorMessage: 'SLOWMODE_WAIT_30' })).message, /30 秒/);
  const flood = mapTgError(Object.assign(new Error('FLOOD_WAIT_17'), { errorMessage: 'FLOOD_WAIT_17' }));
  assert.match(flood.message, /17 秒/);
  assert.equal(flood.isFlood, true);
  assert.match(mapTgError(Object.assign(new Error('CHAT_WRITE_FORBIDDEN'), { errorMessage: 'CHAT_WRITE_FORBIDDEN' })).message, /不允许发言/);
  assert.match(mapTgError(Object.assign(new Error('MSG_TOO_LONG'), { errorMessage: 'MSG_TOO_LONG' })).message, /4096 字/);
});

test('createTgWrites:send 编排(校验→sendMessage→回执归一化+登记自发表)', async () => {
  const sent = [];
  const client = {
    sendMessage: async (entity, params) => {
      sent.push(params);
      return new Api.Message({ id: 500, peerId: new Api.PeerChannel({ channelId: 5 }), date: 1759000000, message: params.message, out: true });
    },
    invoke: async () => { throw new Error('不应走 raw'); },
    getInputEntity: async () => new Api.InputPeerChannel({ channelId: 5, accessHash: 0 }),
    getMessages: async () => [new Api.Message({ id: 500, peerId: new Api.PeerChannel({ channelId: 5 }), date: 1, message: '', editDate: 5 })],
  };
  const w = createTgWrites({
    getClient: async () => client,
    entityOf: async () => new Api.Channel({ id: 5, title: 'C', accessHash: 0 }),
    normalizeMessage: async (pk, msg) => ({ id: Number(msg.id), peerKey: pk, text: String(msg.message || '') }),
    log: () => {},
  });
  const r = await w.send('c5', '你好', 499);
  assert.equal(r.id, 500);
  assert.equal(r.text, '你好');
  assert.equal(sent[0].replyTo, 499);
  assert.equal(sent[0].linkPreview, false);
  assert.equal(w.isSelfSent('c5', 500), true); // 回声去重登记
  // 空文本 400
  await assert.rejects(() => w.send('c5', '  '), /内容不能为空/);
});

// ============ extras 纯函数 ============

test('monthWindowUtc/normalizeCalendarDays:月份窗口 + 日历归一(升序/本月过滤)', () => {
  const win = monthWindowUtc('2025-09');
  assert.equal(win.month, '2025-09');
  assert.equal(monthWindowUtc('2025-13'), null);
  assert.equal(monthWindowUtc('bad'), null);
  const calendar = {
    periods: [
      { date: win.startSec + 86400 * 2, count: 4, maxMsgId: 92 },
      { date: win.startSec + 86400, count: 2, maxMsgId: 90 },
      { date: win.endSec + 100, count: 9, maxMsgId: 99 }, // 次月:滤除
    ],
  };
  const days = normalizeCalendarDays({ calendar, win });
  assert.deepEqual(days, [
    { date: new Date((win.startSec + 86400) * 1000).toISOString().slice(0, 10), count: 2, lastMessageId: 90 },
    { date: new Date((win.startSec + 86400 * 2) * 1000).toISOString().slice(0, 10), count: 4, lastMessageId: 92 },
  ]);
});

test('全局游标编解码:encode/decode 往返 + inputPeerOfCursor 三形态', () => {
  const tok = encodeGlobalCursor(77, -(1000000000000 + 5), '999', 42);
  const cur = decodeGlobalCursor(tok);
  assert.deepEqual(cur, { rate: 77, markedId: -(1000000000000 + 5), accessHash: '999', msgId: 42 });
  assert.equal(decodeGlobalCursor('garbage'), null);
  const pc = inputPeerOfCursor(Api, -(1000000000000 + 5), '999');
  assert.equal(pc.className, 'InputPeerChannel');
  const pg = inputPeerOfCursor(Api, -9, '0');
  assert.equal(pg.className, 'InputPeerChat');
  const pu = inputPeerOfCursor(Api, 7, '0');
  assert.equal(pu.className, 'InputPeerUser');
});

test('mediaThumbTokenOf/statusTextOf/clampSearchLimit/senderIdFrom', () => {
  const photoMsg = new Api.Message({
    id: 7, peerId: new Api.PeerChannel({ channelId: 5 }), date: 0,
    media: new Api.MessageMediaPhoto({ photo: new Api.Photo({ id: 1, accessHash: 2, fileReference: Buffer.alloc(0), date: 0, sizes: [] }) }),
  });
  assert.match(mediaThumbTokenOf('c5', photoMsg), /^https:\/\/tg\.local\/p\/c5m7\/m$/);
  assert.equal(mediaThumbTokenOf('c5', new Api.Message({ id: 8, peerId: new Api.PeerChannel({ channelId: 5 }), date: 0, message: 'x' })), null);
  assert.equal(statusTextOf(new Api.UserStatusOnline({ expires: 0 })), '在线');
  assert.equal(statusTextOf(new Api.UserStatusOffline({ wasOnline: 1759000000 })), '最后上线 2025-09-27');
  assert.equal(statusTextOf(undefined), null);
  assert.equal(clampSearchLimit('99'), 50);
  assert.equal(clampSearchLimit('0'), 20);
  assert.equal(senderIdFrom('u123'), '123');
  assert.equal(senderIdFrom('xyz'), '');
});
