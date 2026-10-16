#!/usr/bin/env node
// ============================================================================
// mtproto-login.mjs —— MTProto 会话一次性登录 CLI(node:xxx,交互式)
// ----------------------------------------------------------------------------
// 背景:teleproto 引擎(2026-10 TDLib 全量替换后)以 server/.telegram-session.json
// 为唯一会话源。常规登录走 Web /api/telegram/login 三步流或 /qr 扫码流;
// 本脚本是 CLI 兜底通道(服务起不来/无 Web 面板的场景):手机号 → 验证码 →
// (可选)两步验证密码 → 会话落盘。
//
// 登录链刻意不用 teleproto 的 signInUser(2026-10-10 实测:凭据被拒时回调
// 无限重试拖死事件循环),改为原生调用链:sendCode(内建 PHONE_MIGRATE 换 DC)
// → auth.SignIn →(SESSION_PASSWORD_NEEDED)account.GetPassword + computeCheck
// → auth.CheckPassword,每步恰好一次往返、任何错误立即退出。
//
// 用法:cd MoontentRN/server && node scripts/mtproto-login.mjs
// ============================================================================
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import 'dotenv/config';
import { TelegramClient, Api, password, sessions } from 'teleproto';
import { saveSessionFile } from '../src/plugins/telegram-tg/tg-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dotenv 默认找 cwd 的 .env;直接运行时显式指到 server/.env(与 index.js 同源)
{
  const envPath = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const dotenv = await import('dotenv');
    dotenv.config({ path: envPath, override: false, quiet: true });
  }
}

function ask(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(String(a || '').trim()); }));
}

function fail(msg) {
  console.error('[mtproto-login] 失败:' + msg);
  process.exit(1);
}

const apiId = parseInt(process.env.TELEGRAM_API_ID || '', 10);
const apiHash = process.env.TELEGRAM_API_HASH || '';
if (!(Number.isFinite(apiId) && apiId > 0 && apiHash)) {
  fail('缺少凭据:请在 server/.env 配置 TELEGRAM_API_ID / TELEGRAM_API_HASH(my.telegram.org 申请)');
}

const proxy = (() => {
  const raw = (process.env.TELEGRAM_PROXY || '').trim();
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'socks5:') throw new Error('仅支持 socks5:// 形态');
    return {
      ip: u.hostname, port: Number(u.port) || 1080, socksType: 5,
      ...(u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password || '') } : {}),
    };
  } catch (e) { fail('TELEGRAM_PROXY 解析失败(' + raw + '):' + e.message); }
})();

const phone = await ask('手机号(含国际区号,如 +8613800138000): ');
if (!/^\+?\d{6,16}$/.test(phone)) fail('手机号格式不正确');

const c = new TelegramClient(new sessions.StringSession(''), apiId, apiHash, {
  connectionRetries: 3, useWSS: false, floodSleepThreshold: 20, ...(proxy ? { proxy } : {}),
});
try {
  const timeout = new Promise((_r, reject) => {
    setTimeout(() => reject(new Error('连接 Telegram 超时(20s):网络受限时请配置 TELEGRAM_PROXY')), 20000);
  });
  timeout.catch(() => { /* 竞速落败的拒绝不上抛 */ });
  await Promise.race([c.connect(), timeout]);
} catch (e) { fail(e.message); }

let sent;
try {
  sent = await c.sendCode({ apiId, apiHash }, phone);
  if (!sent || !sent.phoneCodeHash) fail('发送验证码失败:服务端未返回 phone_code_hash');
} catch (e) { fail('发送验证码失败:' + (e.errorMessage || e.message)); }
console.log('[mtproto-login] 验证码已发送' + (sent.isCodeViaApp ? '(经 Telegram 应用内)' : '(短信)') + '。');

// 验证码 → 登录(错码原位重输;二步验证进入密码环)
let user = null;
let needPassword = false;
for (;;) {
  const code = await ask('验证码: ');
  if (!/^\d{4,8}$/.test(code)) { console.log('验证码格式不正确,请重输'); continue; }
  let out = null;
  try {
    out = await c.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: sent.phoneCodeHash, phoneCode: code }));
  } catch (e) {
    const m = e.errorMessage || '';
    if (/PHONE_CODE_INVALID/.test(m)) { console.log('验证码不正确,请重输'); continue; }
    if (/PHONE_CODE_EXPIRED/.test(m)) { fail('验证码已过期,请重新运行本脚本'); }
    if (/SESSION_PASSWORD_NEEDED/.test(m)) { needPassword = true; break; }
    fail(m || e.message);
  }
  if (out && out.className === 'auth.AuthorizationSignUpRequired') fail('该手机号尚未注册 Telegram 账号');
  user = out && out.user;
  if (!user) fail('登录响应异常:未携带用户信息');
  break;
}

// 两步验证:SRP computeCheck → auth.CheckPassword(错密码原位重输)
if (needPassword) {
  const pwdInfo = await c.invoke(new Api.account.GetPassword());
  console.log('[mtproto-login] 该账号开启了两步验证(提示:' + (pwdInfo.hint || '无') + ')。');
  for (;;) {
    const pw = await ask('两步验证密码: ');
    try {
      const check = await password.computeCheck(pwdInfo, pw);
      const out = await c.invoke(new Api.auth.CheckPassword({ password: check }));
      user = out && out.user;
      if (!user) fail('登录响应异常:未携带用户信息');
      break;
    } catch (e) {
      if (/PASSWORD_HASH_INVALID/.test(e.errorMessage || '')) { console.log('密码不正确,请重输'); continue; }
      fail(e.errorMessage || e.message);
    }
  }
}

const name = ((user.firstName || '') + ' ' + (user.lastName || '')).trim() || 'Telegram 用户';
const file = saveSessionFile(c.session.save(), phone, name);
try { await c.disconnect(); } catch (_e) { /* 忽略 */ }
console.log('[mtproto-login] 登录成功:' + name + '(id ' + user.id + ')');
console.log('[mtproto-login] 会话已写入 ' + file + '(重启后端生效)');
