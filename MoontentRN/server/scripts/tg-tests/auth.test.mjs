// ============================================================================
// auth.test.mjs —— teleproto 登录域态机单元测试(离线;mock host + 真实 Api 类)
// 覆盖:手机三步流(发码→验证码→2FA)、QR 流(令牌→轮询确认)、取消/登出、
// 相位快照契约。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { Api, errors, sessions as sessionsRef } from 'teleproto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// 离线假凭据(host 为 mock,零网络;getCreds 只校验形态)。会话文件指向临时
// 目录——completeLogin 的落盘动作绝不碰 server/.telegram-session.json。
process.env.TELEGRAM_API_ID = '12345';
process.env.TELEGRAM_API_HASH = 'testhash';
process.env.TELEGRAM_SESSION_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-auth-test-')), 'session.json');
import { TgAuthEngine, mapAuthError } from '../../src/plugins/telegram-tg/auth.js';

// mock host:记录调用;invoke 序列可编程
function makeHost(script = {}) {
  const calls = [];
  let sessionStr = script.savedSession || '';
  const client = {
    session: { save: () => sessionStr || 'SAVED1' },
    getMe: async () => new Api.User({ id: 100, firstName: '我', lastName: '', bot: false, username: 'me' }),
    invoke: async (req) => {
      calls.push(req.className);
      const h = script[req.className];
      if (typeof h === 'function') return h(req);
      if (h) throw h;
      return null;
    },
    _switchDC: async () => {},
    disconnect: async () => {},
  };
  return {
    calls,
    client,
    setSession: (s) => { sessionStr = s; },
    ensureClient: async () => client,
    recreateClient: async (o) => { calls.push('recreate:' + (o && o.fresh ? 'fresh' : 'saved')); return client; },
  };
}

const qrLib = { toDataURL: async (t) => 'data:image/png;base64,QR(' + t + ')' };

function mk(script) {
  const host = makeHost(script);
  // lib 注入:Api/errors/sessions 用真实包(构造 fixture),password 以桩替
  // (真实 SRP 计算依赖服务端盐值语义,离线测试只验证编排)
  const lib = {
    Api,
    errors,
    password: { computeCheck: async () => new Api.InputCheckPasswordSRP({ srpId: 1, A: Buffer.alloc(256, 7), M1: Buffer.alloc(32, 9) }) },
    sessions: sessionsRef,
  };
  const eng = new TgAuthEngine({ host, lib, qrLib, log: () => {} });
  return { host, eng };
}

test('mapAuthError:限流秒数/验证码错/密码错/凭据无效中文文案', () => {
  assert.match(mapAuthError(new errors.FloodWaitError({ capture: 30, request: undefined })).message, /30 秒/);
  assert.match(mapAuthError(Object.assign(new Error('PHONE_CODE_INVALID'), { errorMessage: 'PHONE_CODE_INVALID' })).message, /验证码不正确/);
  assert.match(mapAuthError(Object.assign(new Error('PASSWORD_HASH_INVALID'), { errorMessage: 'PASSWORD_HASH_INVALID' })).message, /两步验证密码不正确/);
  assert.match(mapAuthError(Object.assign(new Error('API_ID_PUBLISHED'), { errorMessage: 'API_ID_PUBLISHED' })).message, /api_id\/api_hash 无效/);
});

test('手机三步流:发码(SentCodeTypeApp)→ phase code;验证码 → SESSION_PASSWORD_NEEDED → phase password;密码 → ok + 会话落盘', async () => {
  const { eng } = mk({
    'auth.SendCode': () => new Api.auth.SentCode({
      phoneCodeHash: 'H1', type: new Api.auth.SentCodeTypeApp({ length: 5 }), nextType: undefined, timeout: 60,
    }),
    'auth.SignIn': () => { throw Object.assign(new Error('SESSION_PASSWORD_NEEDED'), { errorMessage: 'SESSION_PASSWORD_NEEDED' }); },
    'account.GetPassword': () => new Api.account.Password({
      newSalt: Buffer.alloc(0), newSecureSalt: Buffer.alloc(0), secureAlgo: undefined, secureRandom: Buffer.alloc(0),
      hint: '我的提示', hasRecovery: false, hasSecureValues: false, algo: undefined,
    }),
    'auth.CheckPassword': () => new Api.auth.Authorization({ user: new Api.User({ id: 100, firstName: '我', bot: false }) }),
  });
  const snap1 = await eng.beginLogin('+8613800138000');
  assert.equal(snap1.phase, 'code');
  assert.equal(snap1.codeViaApp, true);
  const r2 = await eng.submitCode('12345');
  assert.deepEqual(r2, { phase: 'password', error: '', hint: '我的提示' });
  const r3 = await eng.submitPassword('pw123');
  assert.deepEqual(r3, { phase: 'ok', error: '' });
  const snap = eng.buildSnapshot();
  assert.equal(snap.authorized, true);
  assert.equal(snap.me.id, '100');
  assert.equal(snap.phone, '+8613800138000');
});

test('验证码错误:留 code 相位带 error(原位重输);PASSWORD_HASH_INVALID 同理', async () => {
  const { eng } = mk({
    'auth.SendCode': () => new Api.auth.SentCode({ phoneCodeHash: 'H', type: new Api.auth.SentCodeTypeSms({ length: 5 }), nextType: undefined, timeout: 60 }),
    'auth.SignIn': () => { throw Object.assign(new Error('PHONE_CODE_INVALID'), { errorMessage: 'PHONE_CODE_INVALID' }); },
  });
  await eng.beginLogin('+8613800138000');
  const r = await eng.submitCode('00000');
  assert.equal(r.phase, 'code');
  assert.match(r.error, /验证码不正确/);
  assert.equal(eng.buildSnapshot().phase, 'code'); // 相位跟随真实进度,不落错
});

test('QR 流:ExportLoginToken → phase qr + dataURL;轮询 LoginTokenSuccess → ok', async () => {
  let exported = 0;
  const { eng } = mk({
    'auth.ExportLoginToken': () => {
      exported += 1;
      if (exported <= 1) {
        return new Api.auth.LoginToken({ expires: 300, token: Buffer.from('tok123') });
      }
      return new Api.auth.LoginTokenSuccess({
        authorization: new Api.auth.Authorization({ user: new Api.User({ id: 100, firstName: 'QR', bot: false }) }),
      });
    },
  });
  const r = await eng.beginQrLogin();
  assert.equal(r.phase, 'qr');
  assert.match(r.qr, /^data:image\/png;base64,QR\(tg:\/\/login\?token=/);
  await eng.pollQrOnce(); // 模拟手机端确认后的下一次轮询
  const snap = eng.buildSnapshot();
  assert.equal(snap.authorized, true);
  assert.equal(snap.me.name, 'QR');
});

test('abortLogin:在途 → phase error 粘滞;非在途幂等清回 idle', async () => {
  const { eng } = mk({
    'auth.SendCode': () => new Api.auth.SentCode({ phoneCodeHash: 'H', type: new Api.auth.SentCodeTypeSms({ length: 5 }), nextType: undefined, timeout: 60 }),
  });
  await eng.beginLogin('+8613800138000');
  await eng.abortLogin('用户取消');
  let snap = eng.buildSnapshot();
  assert.equal(snap.phase, 'error');
  assert.equal(snap.error, '用户取消');
  await eng.abortLogin('再次取消'); // 非在途:清回 idle
  snap = eng.buildSnapshot();
  assert.equal(snap.phase, 'idle');
});

test('logout:服务端 LogOut(失败不阻断)→ 删会话 fresh 重建 → {ok:true} 绝不抛', async () => {
  const { host, eng } = mk({
    'auth.LogOut': () => { throw new Error('网络失败'); },
  });
  const out = await eng.logout();
  assert.deepEqual(out, { ok: true });
  assert.ok(host.calls.includes('auth.LogOut'));
  assert.ok(host.calls.includes('recreate:fresh'));
  assert.equal(eng.buildSnapshot().phase, 'idle');
});
