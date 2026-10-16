// ============================================================================
// media.test.mjs —— 媒体域单元测试(离线;mock 客户端注入)。
// 覆盖:纯函数(令牌解析/档位梯位/视频面/流签名)+ 字节源(4096 对齐下载/
// 512KB 块流/Range 切片/尾块预取)+ 视频分页(锚排他+探测位)。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { Api } from 'teleproto';
import {
  parseImageToken, photoLadder, pickPhotoSize, photoSizeBytes,
  videoInfoOf, videoItemOf, signStream, verifyStream, createTgMedia,
} from '../../src/plugins/telegram-tg/media.js';

// ============ 纯函数 ============

test('parseImageToken:t/p/a 三形态 + w 尾缀;非法抛中文', () => {
  assert.deepEqual(parseImageToken('https://tg.local/t/c5m10'), { kind: 't', videoId: 'c5m10' });
  assert.deepEqual(parseImageToken('https://tg.local/a/u7'), { kind: 'a', peerKey: 'u7' });
  assert.deepEqual(parseImageToken('https://tg.local/p/c5m10/m'), { kind: 'p', videoId: 'c5m10', tag: 'm', web: false });
  assert.deepEqual(parseImageToken('https://tg.local/p/c5m10w/x'), { kind: 'p', videoId: 'c5m10', tag: 'x', web: true });
  assert.throws(() => parseImageToken('https://x.y/t/1'), /非法/);
});

test('photoLadder/pickPhotoSize/photoSizeBytes:档位梯子 + 渐进式分片', () => {
  assert.deepEqual(photoLadder('m'), ['m', 'n', 'c', 'b', 'a']);
  assert.deepEqual(photoLadder('x'), ['x', 'y', 'w']);
  const sizes = [
    new Api.PhotoStrippedSize({ type: 'i', bytes: Buffer.from([1, 2, 3]) }),
    new Api.PhotoSize({ type: 'm', w: 100, h: 100, size: 5000 }),
    new Api.PhotoSizeProgressive({ type: 'x', w: 900, h: 900, sizes: [1000, 2000, 8000] }),
  ];
  const pickM = pickPhotoSize(sizes, 'm');
  assert.equal(pickM.type, 'm');
  assert.equal(photoSizeBytes(pickM), 5000);
  const pickX = pickPhotoSize(sizes, 'x');
  assert.equal(pickX.className, 'PhotoSizeProgressive');
  assert.equal(photoSizeBytes(pickX), 8000);
  const fallback = pickPhotoSize(sizes.slice(0, 2), 'q'); // 梯子全未命中 → 最大档
  assert.equal(fallback.type, 'm');
});

function videoMsg(id, over = {}) {
  const doc = new Api.Document({
    id: 11, accessHash: 22, fileReference: Buffer.from('fr'), date: 0,
    mimeType: 'video/mp4', size: 4096 * 100, dcId: 4,
    attributes: [
      new Api.DocumentAttributeVideo({ duration: 90.5, w: 1280, h: 720 }),
      ...(over.filename ? [new Api.DocumentAttributeFilename({ fileName: over.filename })] : []),
    ],
  });
  return new Api.Message({
    id, peerId: new Api.PeerChannel({ channelId: 5 }), date: 1759000000,
    message: over.caption || '', media: new Api.MessageMediaDocument({ document: doc }),
  });
}

test('videoInfoOf/videoItemOf:Document 属性分流(视频面/动图/非视频 null)', () => {
  const info = videoInfoOf(videoMsg(42, { caption: '标题第一行\n第二行', filename: 'a.mp4' }));
  assert.deepEqual(
    [info.duration, info.w, info.h, info.size, info.dcId, info.round],
    [91, 1280, 720, 409600, 4, false],
  );
  const item = videoItemOf('c5', videoMsg(42, { caption: '标题第一行\n第二行', filename: 'a.mp4' }));
  assert.equal(item.id, 'c5m42');
  assert.equal(item.title, '标题第一行');
  assert.equal(item.hd, true); // w≥1280
  assert.match(item.cover, /\/api\/img\/telegram\?u=/);
  const gifDoc = new Api.Message({
    id: 43, peerId: new Api.PeerChannel({ channelId: 5 }), date: 0,
    media: new Api.MessageMediaDocument({ document: new Api.Document({
      id: 1, accessHash: 2, fileReference: Buffer.alloc(0), date: 0,
      mimeType: 'video/mp4', size: 100, dcId: 4, attributes: [new Api.DocumentAttributeAnimated()],
    }) }),
  });
  assert.equal(videoInfoOf(gifDoc).round, false);
  const plain = new Api.Message({ id: 44, peerId: new Api.PeerChannel({ channelId: 5 }), date: 0, message: 'x' });
  assert.equal(videoInfoOf(plain), null);
  assert.equal(videoItemOf('c5', plain), null);
});

test('signStream/verifyStream:HMAC 一小时分桶(当前+上一桶有效)', () => {
  const t = signStream('c5m42');
  assert.equal(verifyStream('c5m42', t), true);
  assert.equal(verifyStream('c5m42', '伪造'), false);
  assert.equal(verifyStream('c5m43', t), false);
});

// ============ 字节源(mock 客户端) ============

function mockMediaClient({ sizeBytes = 4096 * 40 } = {}) {
  const getFileInfoCalls = [];
  const chunks = new Map(); // offset → Buffer
  const getFile = async (dcId, location, offsetBigInt, limit) => {
    const off = Number(offsetBigInt.toString());
    const end = Math.min(off + Number(limit), sizeBytes);
    if (off >= sizeBytes) return Buffer.alloc(0);
    const buf = Buffer.alloc(Math.max(0, end - off), 7); // 填充可识别字节
    chunks.set(off, buf);
    return buf;
  };
  const doc = new Api.Document({
    id: 11, accessHash: 22, fileReference: Buffer.from('fr'), date: 0,
    mimeType: 'video/mp4', size: sizeBytes, dcId: 4,
    attributes: [new Api.DocumentAttributeVideo({ duration: 90, w: 1280, h: 720 })],
  });
  const msg = new Api.Message({
    id: 42, peerId: new Api.PeerChannel({ channelId: 5 }), date: 0,
    media: new Api.MessageMediaDocument({ document: doc }),
  });
  const client = {
    session: { dcId: 2 },
    _media: { getFile },
    getMessages: async () => [msg],
    iterMessages: async function* iter(entity, params) {
      // 视频分页 mock:按 offsetId 排他降序(签名对齐 teleproto (entity, params))
      const all = [videoMsg(100), videoMsg(90), videoMsg(80), videoMsg(70)];
      const anchor = Number(params.offsetId || 0);
      const arr = anchor > 0 ? all.filter((m) => m.id < anchor) : all;
      for (const m of arr.slice(0, Number(params.limit || 100))) yield m;
    },
  };
  return { client, chunks, msg };
}

test('createTgMedia:Range 流按 512KB 块背压产出(块对齐下载,首尾切片精确)', async () => {
  process.env.TELEGRAM_API_ID = '1'; process.env.TELEGRAM_API_HASH = 'x';
  const { client, chunks } = mockMediaClient({ sizeBytes: 4096 * 260 }); // 1040KB
  const media = createTgMedia({
    getClient: async () => client,
    entityOf: async () => new Api.Channel({ id: 5, title: 'C', accessHash: 0 }),
    getMessage: async (pk, id, force) => (await client.getMessages())[0],
    listChats: async () => [],
    selfUserId: () => '100',
    log: () => {},
  }, { getFileConcurrency: 4, prefetchAhead: 0 });
  const target = await media.resolveStreamTarget('c5m42');
  assert.equal(target.size, 4096 * 260);
  const stream = media.createRangeStream('c5m42', 100, 100 + 2047); // 非 512KB 对齐的 2KB 窗
  const out = [];
  for await (const b of stream) out.push(b);
  const total = out.reduce((n, b) => n + b.length, 0);
  assert.equal(total, 2048);
  assert.ok(out.every((b) => b.every((x) => x === 7)));
  // 触发的块下载全部 512KB 对齐(fetchChunk 固定 CHUNK)
  for (const off of chunks.keys()) assert.equal(off % (512 * 1024), 0);
});

test('createTgMedia:视频分页(锚排他 + 探测位 hasMore)', async () => {
  process.env.TELEGRAM_API_ID = '1'; process.env.TELEGRAM_API_HASH = 'x';
  const { client } = mockMediaClient();
  const media = createTgMedia({
    getClient: async () => client,
    entityOf: async () => new Api.Channel({ id: 5, title: 'C', accessHash: 0 }),
    getMessage: async () => (await client.getMessages())[0],
    listChats: async () => [],
    selfUserId: () => '100',
    log: () => {},
  }, { getFileConcurrency: 4 });
  const p1 = await media.listPeerVideos('c5', { page: 1, size: 3 });
  assert.deepEqual(p1.items.map((x) => x.id), ['c5m100', 'c5m90', 'c5m80']);
  assert.equal(p1.hasMore, true); // 第 4 条为探测位
  const p2 = await media.listPeerVideos('c5', { page: 2, size: 3 });
  assert.deepEqual(p2.items.map((x) => x.id), ['c5m70']);
  assert.equal(p2.hasMore, false);
});

test('createTgMedia:4096 对齐的整图下载(图片路径,LimitInvalid 防回归)', async () => {
  process.env.TELEGRAM_API_ID = '1'; process.env.TELEGRAM_API_HASH = 'x';
  const limits = [];
  const doc = new Api.Document({
    id: 11, accessHash: 22, fileReference: Buffer.from('fr'), date: 0,
    mimeType: 'image/jpeg', size: 14378, dcId: 4,
    attributes: [],
    thumbs: [new Api.PhotoSize({ type: 'm', w: 320, h: 240, size: 14378 })],
  });
  const msg = new Api.Message({
    id: 42, peerId: new Api.PeerChannel({ channelId: 5 }), date: 0,
    media: new Api.MessageMediaDocument({ document: doc }),
  });
  const client = {
    session: { dcId: 2 },
    _media: { getFile: async (dcId, loc, off, limit) => { limits.push(Number(limit)); return Buffer.alloc(Math.min(Number(limit), 14378), 9); } },
    getMessages: async () => [msg],
  };
  const media = createTgMedia({
    getClient: async () => client,
    entityOf: async () => new Api.Channel({ id: 5, title: 'C', accessHash: 0 }),
    getMessage: async () => msg,
    listChats: async () => [],
    selfUserId: () => '100',
    log: () => {},
  }, { getFileConcurrency: 4 });
  const buf = await media.serveImage('https://tg.local/t/c5m42');
  assert.equal(buf.length, 14378); // 精确截断到声明字节数
  assert.ok(limits.every((l) => l % 4096 === 0)); // 全部请求 4096 对齐
  assert.ok(limits[0] >= 14378);
});

// ============ 图片供给兜底口径(2026-10-15 全损事故修正) ============

function thumbDocMsg(ref) {
  const doc = new Api.Document({
    id: 11, accessHash: 22, fileReference: ref, date: 0,
    mimeType: 'video/mp4', size: 8192, dcId: 4,
    attributes: [new Api.DocumentAttributeVideo({ duration: 9, w: 320, h: 240 })],
    thumbs: [
      new Api.PhotoStrippedSize({ type: 'i', bytes: Buffer.from('not-stripped') }),
      new Api.PhotoSize({ type: 'm', w: 320, h: 240, size: 8192 }),
    ],
  });
  return new Api.Message({
    id: 42, peerId: new Api.PeerChannel({ channelId: 5 }), date: 0,
    media: new Api.MessageMediaDocument({ document: doc }),
  });
}

function imageHarness(msgRef, getFileImpl) {
  let msg = thumbDocMsg(msgRef);
  const logs = [];
  const client = { session: { dcId: 2 }, _media: { getFile: getFileImpl } };
  const media = createTgMedia({
    getClient: async () => client,
    entityOf: async () => new Api.Channel({ id: 5, title: 'C', accessHash: 0 }),
    getMessage: async (_pk, _id, force) => {
      if (force) msg = thumbDocMsg(Buffer.from('fr-fresh')); // 强拉返回新 fileReference
      return msg;
    },
    listChats: async () => [],
    selfUserId: () => '100',
    log: (m) => logs.push(m),
  }, { getFileConcurrency: 4 });
  return { media, logs };
}

test('serveImage:真实档下载失败 → 留痕后如实上抛(不再回退 stripped 钉死全损)', async () => {
  process.env.TELEGRAM_API_ID = '1'; process.env.TELEGRAM_API_HASH = 'x';
  const { media, logs } = imageHarness(Buffer.from('fr'), async () => {
    throw new Error('Telegram 接口错误:AUTH_KEY_DUPLICATED');
  });
  await assert.rejects(media.serveImage('https://tg.local/t/c5m42'), /AUTH_KEY_DUPLICATED/);
  assert.ok(logs.some((l) => /缩略图 c5m42/.test(l) && /AUTH_KEY_DUPLICATED/.test(l)));
});

test('serveImage:FILE_REFERENCE 类失败 → 恰一次强拉消息重试且换用新 fileReference', async () => {
  process.env.TELEGRAM_API_ID = '1'; process.env.TELEGRAM_API_HASH = 'x';
  const seenRefs = [];
  let calls = 0;
  const { media } = imageHarness(Buffer.from('fr-stale'), async (_dc, loc) => {
    seenRefs.push(loc.fileReference.toString());
    calls += 1;
    if (calls === 1) throw new Error('Telegram 接口错误:FILE_REFERENCE_EXPIRED');
    return Buffer.alloc(8192, 3);
  });
  const buf = await media.serveImage('https://tg.local/t/c5m42');
  assert.equal(buf.length, 8192);
  assert.deepEqual(seenRefs, ['fr-stale', 'fr-fresh']); // 第二次用强拉后的新引用
});

test('serveImage:无任何真实档(仅 stripped)→ 仍回 stripped 兜底', async () => {
  process.env.TELEGRAM_API_ID = '1'; process.env.TELEGRAM_API_HASH = 'x';
  const doc = new Api.Document({
    id: 11, accessHash: 22, fileReference: Buffer.from('fr'), date: 0,
    mimeType: 'image/webp', size: 0, dcId: 4,
    attributes: [new Api.DocumentAttributeFilename({ fileName: 'sticker.webp' })],
    thumbs: [new Api.PhotoStrippedSize({ type: 'i', bytes: Buffer.from('not-stripped') })],
  });
  const msg = new Api.Message({
    id: 42, peerId: new Api.PeerChannel({ channelId: 5 }), date: 0,
    media: new Api.MessageMediaDocument({ document: doc }),
  });
  const client = { session: { dcId: 2 }, _media: { getFile: async () => { throw new Error('不应发起下载'); } } };
  const media = createTgMedia({
    getClient: async () => client,
    entityOf: async () => new Api.Channel({ id: 5, title: 'C', accessHash: 0 }),
    getMessage: async () => msg,
    listChats: async () => [],
    selfUserId: () => '100',
    log: () => {},
  }, { getFileConcurrency: 4 });
  const buf = await media.serveImage('https://tg.local/t/c5m42');
  assert.equal(buf.toString(), 'not-stripped'); // stripped 原样兜底(strippedPhotoToJpg 对非 1 开头输入原样返回)
});
