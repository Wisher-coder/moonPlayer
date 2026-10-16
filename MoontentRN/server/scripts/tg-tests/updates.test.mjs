// ============================================================================
// updates.test.mjs —— 更新事件层单元测试(离线;手动闹钟 + mock 端口)。
// 覆盖:MTProto 更新 → 事件映射(new/edit/delete/peer/typing)、事件环 seq/
// reset 自愈、clampWait、self-sent 去重、folders 拉取。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { Api } from 'teleproto';
import {
  createTgUpdatesCore, clampWaitMs, RING_MAX,
} from '../../src/plugins/telegram-tg/updates.js';

function makeCore(over = {}) {
  let now = 1000;
  const alarms = [];
  const core = createTgUpdatesCore({
    decodePeerKey: (peer) => {
      if (!peer) return null;
      if (peer.className === 'PeerUser') return 'u' + peer.userId;
      if (peer.className === 'PeerChat') return 'g' + peer.chatId;
      if (peer.className === 'PeerChannel') return 'c' + peer.channelId;
      return null;
    },
    normalizeMessage: async (pk, msg) => ({ id: Number(msg.id), peerKey: pk, text: String(msg.message || ''), kind: msg.action ? 'service' : 'message' }),
    isSelfSent: (pk, id) => pk === 'u7' && id === 99,
    senderOf: async (uid) => ({ id: String(uid), name: '用户' + uid }),
    putMessage: over.putMessage || (() => {}),
    markDialogsDirty: over.markDialogsDirty || (() => {}),
    dropMessageIds: over.dropMessageIds || (() => []),
    now: () => now,
    alarm: (fn, ms) => {
      const entry = { fn, at: now + ms };
      alarms.push(entry);
      return () => { const i = alarms.indexOf(entry); if (i >= 0) alarms.splice(i, 1); };
    },
    ...over.core,
  });
  return { core, tick: (ms) => { now += ms; }, get now() { return now; } };
}

test('clampWaitMs:钳制到 [0,20000],非法回落 20000', () => {
  assert.equal(clampWaitMs(5000), 5000);
  assert.equal(clampWaitMs(99999), 20000);
  assert.equal(clampWaitMs(-1), 0);
  assert.equal(clampWaitMs('x'), 20000);
});

test('UpdateNewMessage → new 事件入环;isSelfSent 命中不入环', async () => {
  const { core } = makeCore();
  const msg = new Api.Message({ id: 10, peerId: new Api.PeerChannel({ channelId: 5 }), date: 1, message: 'hi' });
  await core.handleMtprotoUpdate(new Api.UpdateNewMessage({ message: msg, pts: 1, ptsCount: 1 }));
  let out = core.getUpdatesSince('c5', 0);
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].type, 'new');
  assert.equal(out.events[0].id, 10);
  assert.equal(out.events[0].message.text, 'hi');
  // 自身消息(u7:99)去重
  const own = new Api.Message({ id: 99, peerId: new Api.PeerUser({ userId: 7 }), date: 1, message: 'me' });
  await core.handleMtprotoUpdate(new Api.UpdateNewMessage({ message: own, pts: 2, ptsCount: 1 }));
  out = core.getUpdatesSince('u7', 0);
  assert.equal(out.events.length, 0);
});

test('UpdateEditMessage → edit(携带完整新消息);UpdateDeleteChannelMessages → 定向 delete', async () => {
  const { core } = makeCore();
  await core.handleMtprotoUpdate(new Api.UpdateEditChannelMessage({
    message: new Api.Message({ id: 3, peerId: new Api.PeerChannel({ channelId: 5 }), date: 1, message: '改' }),
    pts: 1, ptsCount: 1,
  }));
  let out = core.getUpdatesSince('c5', 0);
  assert.equal(out.events[0].type, 'edit');
  assert.equal(out.events[0].message.text, '改');
  await core.handleMtprotoUpdate(new Api.UpdateDeleteChannelMessages({ channelId: 5, messages: [3, 4], pts: 2, ptsCount: 1 }));
  out = core.getUpdatesSince('c5', 0);
  assert.equal(out.events[1].type, 'delete');
  assert.deepEqual(out.events[1].ids, [3, 4]);
});

test('已读 peer patch:ReadHistoryInbox/Outbox + ReadChannelInbox', async () => {
  const { core } = makeCore();
  await core.handleMtprotoUpdate(new Api.UpdateReadHistoryInbox({
    peer: new Api.PeerUser({ userId: 7 }), maxId: 30, stillUnreadCount: 2, pts: 1, ptsCount: 1, folderId: undefined, topMsgId: undefined,
  }));
  await core.handleMtprotoUpdate(new Api.UpdateReadHistoryOutbox({
    peer: new Api.PeerUser({ userId: 7 }), maxId: 28, pts: 2, ptsCount: 1,
  }));
  await core.handleMtprotoUpdate(new Api.UpdateReadChannelInbox({
    channelId: 5, maxId: 100, stillUnreadCount: 0, pts: 3,
  }));
  const out = core.getUpdatesSince('u7', 0);
  assert.deepEqual(out.events[0], { peer: 'u7', type: 'peer', seq: out.events[0].seq, readInboxMaxId: 30, unreadCount: 2 });
  assert.deepEqual(out.events[1], { peer: 'u7', type: 'peer', seq: out.events[1].seq, readOutboxMaxId: 28 });
  const ch = core.getUpdatesSince('c5', 0);
  assert.equal(ch.events[0].unreadCount, 0);
});

test('typing:UpdateUserTyping 全量名单入环;Cancel 移除', async () => {
  const { core } = makeCore();
  await core.handleMtprotoUpdate(new Api.UpdateUserTyping({ userId: 8, action: new Api.SendMessageTypingAction() }));
  let out = core.getUpdatesSince('u8', 0);
  assert.equal(out.events[0].type, 'typing');
  assert.deepEqual(out.events[0].senders, [{ id: '8', name: '用户8' }]);
  await core.handleMtprotoUpdate(new Api.UpdateChatUserTyping({
    chatId: 9, fromId: new Api.PeerUser({ userId: 8 }), action: new Api.SendMessageCancelAction(),
  }));
  out = core.getUpdatesSince('u8', 0);
  assert.equal(out.events.length, 1); // cancel 无可移除项(不同会话)→ 无事件
  await core.handleMtprotoUpdate(new Api.UpdateUserTyping({ userId: 8, action: new Api.SendMessageTypingAction() }));
  await core.handleMtprotoUpdate(new Api.UpdateUserTyping({ userId: 8, action: new Api.SendMessageCancelAction() }));
  out = core.getUpdatesSince('u8', 0);
  const last = out.events[out.events.length - 1];
  assert.equal(last.type, 'typing');
  assert.deepEqual(last.senders, []); // 移除后空名单=收尾事件
});

test('reset 自愈:游标落后于环起点(丢最旧)→ {reset:true,seq}', async () => {
  const { core } = makeCore();
  const mk = (id) => new Api.UpdateEditMessage({
    message: new Api.Message({ id, peerId: new Api.PeerChannel({ channelId: 5 }), date: 1, message: '' }),
    pts: id, ptsCount: 1,
  });
  for (let i = 0; i < RING_MAX + 5; i += 1) await core.handleMtprotoUpdate(mk(i + 1));
  const out = core.getUpdatesSince('c5', 0); // seq 0 落后于 droppedThrough
  assert.equal(out.reset, true);
  assert.ok(out.seq > 0);
  const fresh = core.getUpdatesSince('c5', out.seq);
  assert.equal(fresh.reset, undefined);
  assert.equal(fresh.events.length, 0);
  // 游标超前(旧账号纪元)同样 reset
  assert.equal(core.getUpdatesSince('c5', out.seq + 999).reset, true);
});

test('drop:清环归零 + folders 缓存随账号作废;pollUpdates 无 peer 回全局 seq', async () => {
  let foldersCall = 0;
  // 真实返回形态:包装对象 DialogFilters{filters:[DialogFilter...]},且 layer 230
  // 的 DialogFilter.title 是 TextWithEntities 对象(非纯字符串)
  const client = { getDialogFilters: async () => { foldersCall += 1; return { filters: [{ id: 2, title: { text: 'F2', entities: [] } }] }; } };
  const { core } = makeCore({ core: { getClient: async () => client } });
  await core.handleMtprotoUpdate(new Api.UpdateEditMessage({
    message: new Api.Message({ id: 1, peerId: new Api.PeerChannel({ channelId: 5 }), date: 1, message: '' }),
    pts: 1, ptsCount: 1,
  }));
  const folders = await core.getChatFolders();
  assert.deepEqual(folders, [{ id: 2, title: 'F2', emoji: null }]);
  assert.equal(foldersCall, 1);
  await core.getChatFolders(); // 未标脏走缓存
  assert.equal(foldersCall, 1);
  await core.handleMtprotoUpdate(new Api.UpdateDialogFilters()); // 标脏
  await core.getChatFolders();
  assert.equal(foldersCall, 2);
  assert.equal((await core.pollUpdates({})).seq, 1);
  core.drop();
  assert.equal(core.globalUpdateSeq(), 0);
  assert.equal(core.getUpdatesSince('c5', 1).reset, true);
});

test('attachClient:teleproto 客户端 addEventHandler 订阅接入', async () => {
  const handlers = [];
  const client = {
    addEventHandler: (h) => handlers.push(h),
    removeEventHandler: () => handlers.splice(0, handlers.length),
  };
  const { core } = makeCore();
  core.attachClient(client);
  assert.equal(handlers.length, 1);
  await handlers[0](new Api.UpdateEditMessage({
    message: new Api.Message({ id: 1, peerId: new Api.PeerChat({ chatId: 3 }), date: 1, message: '' }),
    pts: 1, ptsCount: 1,
  }));
  assert.equal(core.getUpdatesSince('g3', 0).events.length, 1);
  const client2 = { addEventHandler: () => {}, removeEventHandler: () => {} };
  core.attachClient(client2); // 换绑摘旧
  assert.equal(handlers.length, 0);
});
