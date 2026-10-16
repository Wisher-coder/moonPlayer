// ============================================================================
// tg-client.test.mjs —— teleproto 客户端基座单元测试(离线;零网络)
// 覆盖:buildClientParams(env 旋钮/downloadPool 缺省 16×4/钳制/SOCKS5 透传)、
// localMsgIdOf 打包 id shim、normTgClientError 中文化。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClientParams, MEDIA_SESSIONS_DEFAULT, MEDIA_INFLIGHT_DEFAULT, normTgClientError } from '../../src/plugins/telegram-tg/tg-client.js';
import { localMsgIdOf } from '../../src/plugins/telegram-tg/shared.js';
import * as lib from 'teleproto';

test('buildClientParams:缺省 downloadPool 为激进档 16×4(64 并发/DC)', () => {
  const p = buildClientParams();
  assert.equal(p.downloadPool.download.sessions, MEDIA_SESSIONS_DEFAULT);
  assert.equal(p.downloadPool.download.inFlight, MEDIA_INFLIGHT_DEFAULT);
  assert.equal(p.downloadPool.partSize, 512 * 1024);
  assert.equal(p.useWSS, false);
  assert.equal(p.floodSleepThreshold, 20);
  assert.equal(p.connectionRetries, 3);
  assert.equal('proxy' in p, false); // 未配置代理不携带
});

test('buildClientParams:env 旋钮生效并钳制到 1..16', () => {
  const prevS = process.env.TG_MEDIA_SESSIONS;
  const prevI = process.env.TG_MEDIA_INFLIGHT;
  try {
    process.env.TG_MEDIA_SESSIONS = '8';
    process.env.TG_MEDIA_INFLIGHT = '2';
    let p = buildClientParams();
    assert.equal(p.downloadPool.download.sessions, 8);
    assert.equal(p.downloadPool.download.inFlight, 2);
    process.env.TG_MEDIA_SESSIONS = '99'; // 越界钳回 16
    p = buildClientParams();
    assert.equal(p.downloadPool.download.sessions, 16);
    process.env.TG_MEDIA_SESSIONS = '0'; // 非法取缺省
    p = buildClientParams();
    assert.equal(p.downloadPool.download.sessions, 16);
    // 显式入参优先于 env
    p = buildClientParams({ sessions: 4, inflight: 1 });
    assert.deepEqual([p.downloadPool.download.sessions, p.downloadPool.download.inFlight], [4, 1]);
  } finally {
    if (prevS == null) delete process.env.TG_MEDIA_SESSIONS; else process.env.TG_MEDIA_SESSIONS = prevS;
    if (prevI == null) delete process.env.TG_MEDIA_INFLIGHT; else process.env.TG_MEDIA_INFLIGHT = prevI;
  }
});

test('localMsgIdOf:TDLib 打包 id(<<20)解包,<2^20 视为已本地形态', () => {
  assert.equal(localMsgIdOf(131454730240), 125365); // 实测样本(saved)
  assert.equal(localMsgIdOf(71049412608), 67758);   // 实测样本(频道)
  assert.equal(localMsgIdOf(125365), 125365);       // 已是本地形态
  assert.throws(() => localMsgIdOf(0), /非法/);
  assert.throws(() => localMsgIdOf(-5), /非法/);
});

test('normTgClientError:FLOOD_WAIT 带秒数 / CDN / 401 → 登录态 / 纯大写码加前缀', () => {
  const flood = new lib.errors.FloodWaitError({ capture: 17, request: undefined });
  assert.match(normTgClientError(flood).message, /17 秒/);
  const cdn = new Error('upload.fileCdnRedirect');
  cdn.name = 'CdnRedirectError';
  assert.match(normTgClientError(cdn).message, /CDN/);
  const unauth = Object.assign(new Error('Unauthorized'), { code: 401 });
  const n = normTgClientError(unauth);
  assert.equal(n.name, 'TgNotLoggedInError');
  assert.equal(normTgClientError(new Error('SOME_CODE_X')).message, 'Telegram 接口错误:SOME_CODE_X');
  assert.equal(normTgClientError(new Error('人话错误')).message, '人话错误');
});
