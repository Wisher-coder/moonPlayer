// ============================================================================
// engine.test.mjs —— 引擎装配层单元测试(离线;mock 域模块注入)。
// 覆盖:assembleDomain 两形状解析/必需项缺失报错、makeNormalizeFaces 双调用面、
// TgEngine facade(ready 闸门/needLogin 映射/dropCaches 广播/插件聚合缺失报错)。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { Api } from 'teleproto';
import { assembleDomain, makeNormalizeFaces, createEngine } from '../../src/plugins/telegram-tg/engine.js';
import { TgNotLoggedInError } from '../../src/plugins/telegram-tg/shared.js';

test('assembleDomain:模块直函数形状(updates 门面)优先命中', () => {
  const mod = {
    globalUpdateSeq: () => 1,
    getUpdatesSince: () => ({ events: [], seq: 0 }),
    waitForPeerEvent: () => Promise.resolve(),
  };
  const bound = assembleDomain(mod, 'updates');
  assert.equal(bound.globalUpdateSeq(), 1);
});

test('assembleDomain:工厂形状(deps 注入)与必需项缺失中文报错', () => {
  const mod = {
    createMessages: (deps) => ({
      getChatPage: (pk) => 'page:' + pk + ':' + typeof deps.getClient,
      getOneMessage: () => null,
    }),
  };
  const bound = assembleDomain(mod, 'messages', { getClient: async () => ({}) });
  assert.equal(bound.getChatPage('u1'), 'page:u1:function');
  assert.equal(bound.getMessage, undefined); // 可选导出未提供
  const broken = {
    createMessages: () => ({ getChatPage: () => null }), // 缺 getOneMessage
  };
  assert.throws(() => assembleDomain(broken, 'messages', {}), /缺少 getOneMessage/);
  assert.throws(() => assembleDomain(undefined, 'dialogs', {}), /文件缺失/);
});

function mockDomains() {
  const calls = [];
  return {
    calls,
    domains: {
      auth: {
        sessionSnapshot: async () => ({ authorized: false, me: null, creds: true, phase: 'idle' }),
        ensureReady: async () => { throw new TgNotLoggedInError(); },
        beginLogin: async () => ({ phase: 'code' }),
        submitCode: async () => ({ phase: 'ok' }),
        submitPassword: async () => ({ phase: 'ok' }),
        abortLogin: async () => { },
        logout: async () => ({ ok: true }),
        dropCaches: async () => { calls.push('auth.drop'); },
        meInfo: () => null,
      },
      dialogs: {
        getDialogs: async () => [{ peerKey: 'u1', name: 'A', kind: 'user' }],
        resolveUsername: async () => { throw Object.assign(new Error('x'), { code: 401 }); },
        dropCaches: async () => { calls.push('dialogs.drop'); },
      },
      messages: {
        getChatPage: async () => ({ items: [] }),
        getOneMessage: async () => null,
        dropCaches: async () => { calls.push('messages.drop'); },
      },
      writes: {
        send: async () => ({ id: 1 }),
        sendBotCallback: async () => ({ answer: null }),
        sendPollVote: async () => ({ id: 1 }),
        markChatRead: async () => ({ ok: true }),
        dropCaches: async () => { calls.push('writes.drop'); },
      },
      media: {
        listPeerVideos: async () => ({ items: [] }),
        getVideoDetail: async () => ({}),
        searchVideos: async () => ({ items: [] }),
        signStream: () => 'T',
        verifyStream: () => true,
        resolveStreamTarget: async () => ({ size: 1 }),
        createRangeStream: () => null,
        serveImage: async () => Buffer.alloc(0),
        dropCaches: async () => { calls.push('media.drop'); },
      },
      updates: {
        globalUpdateSeq: () => 0,
        getUpdatesSince: () => ({ events: [], seq: 0 }),
        waitForPeerEvent: () => Promise.resolve(),
        dropUpdateEvents: async () => { calls.push('updates.ring'); },
        dropCaches: async () => { calls.push('updates.drop'); },
      },
    },
  };
}

test('TgEngine facade:dropCaches 广播全部域 + updates 额外清环', async () => {
  const { calls, domains } = mockDomains();
  const E = createEngine({ domains });
  await E.start();
  await E.dropCaches();
  for (const k of ['auth.drop', 'dialogs.drop', 'messages.drop', 'writes.drop', 'media.drop', 'updates.drop', 'updates.ring']) {
    assert.ok(calls.includes(k), '缺少 ' + k);
  }
});

test('TgEngine facade:401 形态错误 → TgNotLoggedInError(needLogin 契约兜底)', async () => {
  const { domains } = mockDomains();
  const E = createEngine({ domains });
  await assert.rejects(() => E.resolveUsername('abc'), TgNotLoggedInError);
});

test('TgEngine facade:插件聚合面缺失时中文报错(不冒充能力)', async () => {
  const { domains } = mockDomains();
  const E = createEngine({ domains });
  await assert.rejects(() => E.pluginList(), /缺少 pluginList 导出/);
  await assert.rejects(() => E.pluginBoards(), /缺少 pluginBoards 导出/);
  // media 域带聚合时正常转发
  domains.media.pluginList = async () => ({ items: [1] });
  const out = await createEngine({ domains }).pluginList();
  assert.deepEqual(out, { items: [1] });
});

test('makeNormalizeFaces:forWrites 由 peerId 反解 peerKey;forPorts 走批量面', async () => {
  const { normalizeOne: real } = await import('../../src/plugins/telegram-tg/normalize.js');
  const faces = makeNormalizeFaces({
    normalizeOne: real,
    selfId: '100',
    collectBatch: async (pk, msgs) => msgs.map((m) => ({ id: m.id, peerKey: pk })),
  });
  const msg = new Api.Message({ id: 9, peerId: new Api.PeerUser({ userId: 100 }), date: 1, message: 'x' });
  const w = faces.forWrites(msg);
  assert.equal(w.peerKey, 'saved'); // PeerUser 命中自己
  const p = await faces.forPorts('u7', msg);
  assert.deepEqual(p, { id: 9, peerKey: 'u7' });
});

test('TgEngine:start 后状态 ready;失败态引擎如实上抛装配错误', async () => {
  const { domains } = mockDomains();
  const E = createEngine({ domains });
  assert.equal(E.status, 'idle');
  await E.start();
  assert.equal(E.status, 'ready');
  assert.equal(E.mode, 'teleproto');
  const fatal = createEngine({ domains: {}, fatal: new Error('装配炸了') });
  await assert.rejects(() => fatal.sessionSnapshot(), /装配炸了/);
});
