// ============================================================================
// auth.js —— teleproto 登录域:手机号+验证码+2FA(SRP)+ QR 扫码(仅 Node 服务端)
// ----------------------------------------------------------------------------
// 对外契约与 TDLib 时代逐字一致(routes /session /login /verify /password
// /cancel /logout):sessionSnapshot 八字段 {authorized,me,creds,phase,phone,
// hint,error,codeViaApp},phase ∈ idle|sending|code|password|qr|ok|error(qr 为
// 本版新增值,前端登录页新增扫码入口消费);TgNotLoggedInError 类同一性
// (shared.js 单一实现,routes fail() 的 instanceof 命中)。
//
// 与 TDLib 时代的根本差异(切库即切态机,注释留档):
//   · TDLib 以 updateAuthorizationState 事件为单一真相,本层自维护 phase——
//     teleproto 的登录是显式步骤(auth.SendCode/SignIn/CheckPassword/Export
//     LoginToken),每步同步推进相位,无事件竞态面;
//   · 取消登录不再需要「删库重建」:teleproto 无 TDLib 的持久化半登录态,
//     phone_code_hash 由本层自持,丢弃即取消(服务端验证码自然过期);
//   · 登录成功即 saveSessionFile(StringSession 串,.telegram-session.json,
//     tg-client.js 单一实现)——同一客户端实例原地变授权态,无重建窗口;
//   · QR 登录(TDLib 时代不支持):auth.ExportLoginToken 生成 tg://login 令牌,
//     「qrcode」npm 包在服务端渲染 PNG dataURL(app 零新增 RN 依赖),内部
//     每 3s 轮询 ExportLoginToken 等待手机端 auth.AcceptLoginToken 确认,
//     loginTokenMigrateTo 自动 _switchDC 后续轮;前端轮询 /session 等相位。
//
// host 注入契约(engine.js 组装;测试以同形 mock 注入):
//   ensureClient() → Promise<client>  连接态客户端(未授权也是合法返回——
//                                    登录步骤在未授权客户端上执行);
//                                    已保存会话的恢复/authorized 判定在引擎侧
//   recreateClient({fresh}) → Promise<client>
//                                    重建客户端;fresh=true 丢弃已保存会话串
//                                    (登出/换号路径),false 从会话文件重建
//   lib                              teleproto 形对象(Api/errors/sessions;
//                                    测试注入 mock,缺省真实包)
//   onDropCaches()                   登出/换号作废各域账号态缓存(engine 接线)
//   qrLib                            {toDataURL(text,opts)}(测试注入;缺省
//                                    'qrcode' npm 包)
//
// 防风暴红线:一切失败如实上抛中文错误(mapAuthError 单一映射),绝不自动
// 重试(重发验证码只由用户显式再次 login 触发);每步等待有界(loginToken
// 轮询 3s 间隔、QR 闲置自毁 10min 与手机流同档);登录闲置 10min 自毁。
// ============================================================================
import { TgNotLoggedInError, hasCreds, getCreds } from './shared.js';
import { saveSessionFile, deleteSessionFile, normTgClientError } from './tg-client.js';
import * as defaultLib from 'teleproto';
import * as defaultQrLib from 'qrcode';

// 有界等待(毫秒);构造可逐项覆盖(测试用)
const DEFAULT_BOUNDS = {
  code: 60e3,    // beginLogin 发码等待(上限参考,流程内为单次请求)
  submit: 30e3,  // verify/password 提交(单次请求上限)
  closed: 10e3,  // logOut 上限(超时也继续本地清理)
};

const LOGIN_IDLE_TIMEOUT = 10 * 60e3; // 登录闲置自毁(手机流与 QR 流同档)
const QR_POLL_MS = 3000;              // QR 轮询间隔(auth.ExportLoginToken 重调)

/**
 * 登录流程错误 → 中文提示(文案与 TDLib 时代逐字一致;auth 域专用,
 * 写侧共用段在 writes.js mapTdlibError——两份码表分别维护,语义锚点相同)。
 */
export function mapAuthError(e) {
  const m = (e && (e.errorMessage || e.message)) || String(e);
  if ((e && e.code === 429) || /retry after \d+/i.test(m) || e instanceof defaultLib.errors.FloodWaitError) {
    const s = Number((m.match(/wait (\d+) seconds?/i) || [])[1] || (e && e.seconds) || 60);
    return new Error(`Telegram 限流,请约 ${s} 秒后再试`);
  }
  if (/API_ID_PUBLISHED|API_ID_INVALID/.test(m) || /^Valid api_id/.test(m)) {
    return new Error('api_id/api_hash 无效:Telegram 已封禁公开/他人客户端凭据(如 Telegram Desktop 的 611335),请到 my.telegram.org 申请自己的凭据并填入 server/.env');
  }
  if (/PHONE_NUMBER_INVALID/.test(m)) return new Error('手机号格式不正确(应含国际区号,如 +8613800138000)');
  if (/PHONE_CODE_INVALID/.test(m)) return new Error('验证码不正确,请重试');
  if (/PHONE_CODE_EXPIRED/.test(m)) return new Error('验证码已过期,请重新发送');
  if (/PHONE_NUMBER_TOO_MANY_REQUESTS|AUTH_RESTART/.test(m)) return new Error('发送验证码过于频繁,请几分钟后再试');
  if (/PASSWORD_HASH_INVALID/.test(m)) return new Error('两步验证密码不正确,请重试');
  if (/SESSION_REVOKED|USER_DEACTIVATED|AUTH_KEY_UNREGISTERED/.test(m)) {
    return new Error('账号状态异常(被冻结/停用或会话失效),请重新登录');
  }
  return normTgClientError(e, defaultLib);
}

/**
 * teleproto 登录域引擎。
 */
export class TgAuthEngine {
  /**
   * @param {object} deps 见文件头「host 注入契约」
   */
  constructor(deps = {}) {
    const { host, onDropCaches, bounds, idleTimeoutMs, lib, qrLib, log } = deps;
    if (!host || typeof host.ensureClient !== 'function' || typeof host.recreateClient !== 'function') {
      throw new Error('TgAuthEngine 需要注入 host({ensureClient,recreateClient})');
    }
    this.host = host;
    this.lib = lib || defaultLib;
    this.qrLib = qrLib || defaultQrLib;
    this.onDropCaches = typeof onDropCaches === 'function' ? onDropCaches : null;
    this.log = typeof log === 'function' ? log : (() => {});
    this.bounds = { ...DEFAULT_BOUNDS, ...(bounds || {}) };
    this.idleTimeoutMs = Number.isFinite(idleTimeoutMs) ? idleTimeoutMs : LOGIN_IDLE_TIMEOUT;

    // —— 态机内部态 ——
    this.phase = 'idle';        // idle|sending|code|password|qr|ok|error(自维护真相)
    this.phone = '';            // 最近一次登录提交的手机号
    this.hint = '';             // 2FA 密码提示(account.Password.hint)
    this.codeViaApp = false;    // 验证码是否经 Telegram 应用内发送(SentCodeTypeApp)
    this.pendingPhone = '';     // beginLogin 已受理、发码未返的 'sending' 瞬态
    this.flowError = '';        // 业务重问(验证码/密码错)的伴随文案(相位不变)
    this.stickyError = '';      // 流程硬失败滞留文案
    this.abortMsg = '';         // 取消/闲置自毁滞留(→ phase 'error')
    this.me = null;             // 账号快照 {id,name,username,phone}
    this.meInflight = null;     // getMe 单飞
    this.codeHash = '';         // 在途验证码流程的 phone_code_hash(teleproto 侧无状态)
    this.qrToken = null;        // 在途 QR 令牌(Buffer;tg://login?token=base64url)
    this.qrExpires = 0;         // 令牌过期(unix 毫秒)
    this.qrTimer = null;        // QR 轮询定时器
    this.idleTimer = null;
  }

  // ==================== me 快照(getMe 单飞) ====================

  async ensureMe(timeoutMs) {
    if (this.me) return this.me;
    if (!this.meInflight) {
      this.meInflight = (async () => {
        const client = await this.host.ensureClient();
        const u = await client.getMe();
        this.me = {
          id: String(u && u.id != null ? u.id : ''),
          name: [u && u.firstName, u && u.lastName].filter(Boolean).join(' ').trim() || 'Telegram 用户',
          username: (u && u.username) || '',
          phone: this.phone
            ? (this.phone.startsWith('+') ? this.phone : `+${this.phone}`)
            : (u && u.phone ? `+${u.phone}` : ''),
        };
        return this.me;
      })().finally(() => { this.meInflight = null; });
    }
    return this.meInflight;
  }

  /** me 快照(saved 伪对话编解码依赖本人 user id;未登录 null) */
  meInfo() {
    return this.me;
  }

  /** 标记「已授权」(engine 侧恢复保存会话成功时调用;phase 真相在此推进) */
  markAuthorized() {
    this.phase = 'ok';
    this.pendingPhone = '';
    this.fatalReset();
    this.clearIdleTimer();
  }

  fatalReset() {
    this.flowError = '';
    this.stickyError = '';
    this.abortMsg = '';
  }

  // ==================== 契约快照(session 端点) ====================

  buildSnapshot() {
    // 相位派生:error(取消/闲置自毁) > ok > qr > password > code > sending > idle;
    // stickyError(流程硬失败)不落错相位——登录客户端仍存活,相位跟随真实进度,
    // 允许用户原位重试(与 TDLib 版语义一致),失败文案经 error 字段滞留展示。
    let phase;
    if (this.abortMsg) phase = 'error';
    else if (this.phase === 'ok') phase = 'ok';
    else if (this.phase === 'qr') phase = 'qr';
    else if (this.phase === 'password') phase = 'password';
    else if (this.phase === 'code') phase = 'code';
    else if (this.pendingPhone) phase = 'sending';
    else phase = 'idle';
    return {
      authorized: this.phase === 'ok' && Boolean(this.me),
      me: this.me,
      creds: hasCreds(),
      phase,
      phone: this.phone,
      hint: this.hint,
      error: phase === 'error' ? this.abortMsg : (this.flowError || this.stickyError),
      codeViaApp: this.codeViaApp,
    };
  }

  /**
   * GET /api/telegram/session 数据面:未登录/无凭据也返回快照(路由层 200);
   * 连接/恢复会话失败如实上抛(与 TDLib 版「引擎起不来」同口径)。
   */
  async snapshot() {
    if (!hasCreds()) return this.buildSnapshot();
    try {
      await this.host.ensureClient();
    } catch (e) {
      throw mapAuthError(e);
    }
    if (this.phase === 'ok' && !this.me) {
      try { await this.ensureMe(); } catch (e) { throw mapAuthError(e); }
    }
    return this.buildSnapshot();
  }

  /** facade 数据面统一门:已授权客户端就绪;未登录抛 TgNotLoggedInError */
  async ensureReady() {
    if (!hasCreds()) throw new TgNotLoggedInError();
    await this.host.ensureClient();
    if (this.phase !== 'ok') throw new TgNotLoggedInError();
    if (!this.me) {
      try { await this.ensureMe(); } catch (e) { throw mapAuthError(e); }
    }
  }

  // ==================== 手机号+验证码+2FA 流程 ====================

  /**
   * 发起登录:auth.SendCode → phase 'code'。分支:已授权 → 先 dropCaches +
   * 服务端登出 + fresh 重建(换号接管);在途登录同号重发(auth.ResendCode)。
   */
  async beginLogin(phone) {
    if (!phone || !/^\+?\d{6,16}$/.test(phone)) {
      throw new Error('手机号格式不正确(应含国际区号,如 +8613800138000)');
    }
    getCreds();
    if (this.phase === 'ok') {
      if (this.onDropCaches) this.onDropCaches();
      await this.teardownForRelogin();
    } else if (this.phase === 'code' || this.phase === 'password' || this.pendingPhone) {
      await this.abortLogin('新的登录请求已接管');
    }
    this.stopQrPoller();
    const resend = this.phase === 'code' && phone === this.phone && this.codeHash;
    this.phone = phone;
    this.hint = '';
    this.codeViaApp = false;
    this.fatalReset();
    this.me = null;
    this.pendingPhone = phone; // 'sending' 瞬态
    this.armIdleTimer();
    try {
      const client = await this.host.ensureClient();
      const { Api } = this.lib;
      let sent;
      if (resend) {
        sent = await client.invoke(new Api.auth.ResendCode({ phoneNumber: phone, phoneCodeHash: this.codeHash }));
      } else {
        sent = await client.invoke(new Api.auth.SendCode({
          phoneNumber: phone,
          apiId: getCreds().apiId,
          apiHash: getCreds().apiHash,
          settings: new Api.CodeSettings({}),
        }));
      }
      if (!(sent instanceof Api.auth.SentCode)) {
        throw new Error('登录状态异常,请重新开始');
      }
      this.codeHash = String(sent.phoneCodeHash || '');
      this.codeViaApp = sent.type instanceof Api.auth.SentCodeTypeApp;
      this.pendingPhone = '';
      this.phase = 'code';
      return this.buildSnapshot();
    } catch (e) {
      this.pendingPhone = '';
      const err = mapAuthError(e);
      this.stickyError = err.message;
      this.clearIdleTimer();
      throw err;
    }
  }

  /**
   * 提交验证码:auth.SignIn。SESSION_PASSWORD_NEEDED → phase 'password'
   * (带 hint);成功 → completeLogin;验证码错 → 留 code 相位带 error(原位重输)。
   */
  async submitCode(code) {
    if (this.phase !== 'code') throw new Error('当前不在等待验证码状态');
    if (!code || !/^\d{4,8}$/.test(code)) throw new Error('验证码格式不正确');
    const { Api } = this.lib;
    try {
      const client = await this.host.ensureClient();
      const r = await client.invoke(new Api.auth.SignIn({
        phoneNumber: this.phone,
        phoneCodeHash: this.codeHash,
        phoneCode: String(code),
      }));
      await this.completeLogin(r && r.user);
      return { phase: 'ok', error: '', hint: '' };
    } catch (e) {
      const m = (e && (e.errorMessage || e.message)) || String(e);
      if (/SESSION_PASSWORD_NEEDED/.test(m)) {
        try {
          const client = await this.host.ensureClient();
          const pw = await client.invoke(new Api.account.GetPassword());
          this.hint = String((pw && pw.hint) || '');
        } catch (_e) { this.hint = ''; }
        this.phase = 'password';
        this.armIdleTimer();
        return { phase: 'password', error: '', hint: this.hint };
      }
      if (/PHONE_CODE_INVALID|PHONE_CODE_EXPIRED/.test(m)) {
        const msg = mapAuthError(e).message;
        this.flowError = msg;
        this.armIdleTimer(); // 重问滚动续期闲置窗口
        return { phase: 'code', error: msg, hint: '' };
      }
      const err = mapAuthError(e);
      this.stickyError = err.message;
      this.clearIdleTimer();
      throw err;
    }
  }

  /**
   * 提交两步验证密码:account.GetPassword → SRP computeCheck → auth.CheckPassword。
   * 密码错 → 留 password 相位带 error(原位重输)。
   */
  async submitPassword(pw) {
    if (this.phase !== 'password') throw new Error('当前不在等待两步验证密码状态');
    if (!pw) throw new Error('密码不能为空');
    const { Api } = this.lib;
    try {
      const client = await this.host.ensureClient();
      const info = await client.invoke(new Api.account.GetPassword());
      const srp = await this.lib.password.computeCheck(info, String(pw));
      const r = await client.invoke(new Api.auth.CheckPassword({ password: srp }));
      await this.completeLogin(r && r.user);
      return { phase: 'ok', error: '' };
    } catch (e) {
      const m = (e && (e.errorMessage || e.message)) || String(e);
      if (/PASSWORD_HASH_INVALID/.test(m)) {
        const msg = mapAuthError(e).message;
        this.flowError = msg;
        this.armIdleTimer();
        return { phase: 'password', error: msg };
      }
      const err = mapAuthError(e);
      this.stickyError = err.message;
      this.clearIdleTimer();
      throw err;
    }
  }

  /**
   * 登录完成收尾:会话串落盘 + getMe + phase 'ok'。
   * 同一客户端实例原地变授权态,无重建窗口(见文件头差异说明)。
   */
  async completeLogin(user) {
    const client = await this.host.ensureClient();
    const sessionStr = client.session.save();
    if (!sessionStr) throw new Error('登录会话保存失败,请重试');
    try { saveSessionFile(sessionStr, this.phone, ''); } catch (_e) { /* 落盘失败不挡登录;下次重启需重登 */ }
    if (!user) {
      user = await client.getMe();
    }
    this.me = {
      id: String(user && user.id != null ? user.id : ''),
      name: [user && user.firstName, user && user.lastName].filter(Boolean).join(' ').trim() || 'Telegram 用户',
      username: (user && user.username) || '',
      phone: this.phone
        ? (this.phone.startsWith('+') ? this.phone : `+${this.phone}`)
        : (user && user.phone ? `+${user.phone}` : ''),
    };
    this.codeHash = '';
    this.qrToken = null;
    this.stopQrPoller();
    this.phase = 'ok';
    this.fatalReset();
    this.clearIdleTimer();
    this.log('Telegram 登录完成(' + this.me.name + ')');
  }

  // ==================== QR 扫码流程 ====================

  /**
   * 发起 QR 登录:auth.ExportLoginToken → tg://login 令牌 + 服务端渲染 PNG
   * dataURL。内部每 QR_POLL_MS 轮询等手机端确认(loginTokenSuccess →
   * completeLogin);loginTokenMigrateTo 自动 _switchDC。返回
   * {qr(dataURL), expires(秒)};前端展示二维码并轮询 /session 等相位变 ok。
   */
  async beginQrLogin() {
    getCreds();
    if (this.phase === 'ok') {
      if (this.onDropCaches) this.onDropCaches();
      await this.teardownForRelogin();
    } else {
      await this.abortLogin('新的登录请求已接管');
    }
    this.phone = '';
    this.hint = '';
    this.codeViaApp = false;
    this.fatalReset();
    this.me = null;
    this.armIdleTimer();
    const { Api } = this.lib;
    try {
      const client = await this.host.ensureClient();
      let r;
      for (let hop = 0; hop < 3; hop += 1) { // migrate 跳 DC 上限 3 次(防异常环)
        r = await client.invoke(new Api.auth.ExportLoginToken({
          apiId: getCreds().apiId,
          apiHash: getCreds().apiHash,
          exceptIds: [],
        }));
        if (r instanceof Api.auth.LoginTokenMigrateTo) {
          await client._switchDC(r.dcId);
          continue;
        }
        break;
      }
      if (r instanceof Api.auth.LoginTokenSuccess) {
        await this.completeLogin(r.authorization && r.authorization.user);
        const snap = this.buildSnapshot();
        return { phase: 'ok', qr: null, expires: 0, snapshot: snap };
      }
      if (!(r instanceof Api.auth.LoginToken)) {
        throw new Error('登录状态异常,请重新开始');
      }
      this.qrToken = r.token;
      this.qrExpires = Date.now() + (Number(r.expires) || 300) * 1000;
      this.phase = 'qr';
      this.startQrPoller();
      const url = this.qrUrl();
      const png = await this.qrLib.toDataURL(url, { margin: 1, width: 320 });
      return { phase: 'qr', qr: png, expires: Math.round((this.qrExpires - Date.now()) / 1000) };
    } catch (e) {
      const err = mapAuthError(e);
      this.stickyError = err.message;
      this.clearIdleTimer();
      throw err;
    }
  }

  /** tg://login 深链(官方 App 扫码即确认);令牌按 base64url 编码 */
  qrUrl() {
    if (!this.qrToken) return '';
    const b64 = Buffer.from(this.qrToken).toString('base64url');
    return 'tg://login?token=' + b64;
  }

  /** QR 轮询:ExportLoginToken 重调等确认(服务端在手机端 Accept 后改返 success) */
  startQrPoller() {
    this.stopQrPoller();
    this.qrTimer = setInterval(() => {
      this.pollQrOnce().catch((e) => {
        this.stopQrPoller();
        this.abortMsg = '扫码登录中断:' + (((e && e.message) || e) + '');
        this.phase = 'error';
        this.clearIdleTimer();
      });
    }, QR_POLL_MS);
    this.qrTimer.unref?.();
  }

  stopQrPoller() {
    if (this.qrTimer) {
      clearInterval(this.qrTimer);
      this.qrTimer = null;
    }
  }

  async pollQrOnce() {
    if (this.phase !== 'qr') { this.stopQrPoller(); return; }
    const { Api } = this.lib;
    const client = await this.host.ensureClient();
    let r;
    for (let hop = 0; hop < 3; hop += 1) {
      r = await client.invoke(new Api.auth.ExportLoginToken({
        apiId: getCreds().apiId,
        apiHash: getCreds().apiHash,
        exceptIds: [],
      }));
      if (r instanceof Api.auth.LoginTokenMigrateTo) {
        await client._switchDC(r.dcId);
        continue;
      }
      break;
    }
    if (r instanceof Api.auth.LoginToken) {
      this.qrToken = r.token; // 服务端可能刷新令牌(过期前重发)
      this.qrExpires = Date.now() + (Number(r.expires) || 300) * 1000;
      return;
    }
    if (r instanceof Api.auth.LoginTokenSuccess) {
      await this.completeLogin(r.authorization && r.authorization.user);
      return;
    }
    // 其余形态(畸形响应):按中断处理
    throw new Error('扫码登录响应异常');
  }

  // ==================== 取消 / 登出 ====================

  /**
   * 作废在途登录(手机流丢弃 phone_code_hash;QR 流停轮询)。teleproto 无
   * TDLib 的持久化半登录态,无须重建客户端;幂等且绝不抛;已授权账号不受
   * 影响。phase → 'error'(abortMsg 粘滞到下一次 beginLogin/beginQrLogin)。
   */
  async abortLogin(reason) {
    const inFlight = this.phase === 'code' || this.phase === 'password' || this.phase === 'qr' || Boolean(this.pendingPhone);
    this.stopQrPoller();
    this.pendingPhone = '';
    this.codeHash = '';
    this.qrToken = null;
    this.flowError = '';
    this.stickyError = '';
    this.clearIdleTimer();
    if (!inFlight) {
      // 非在途:若当前是 abort 滞留的 error 相位,重置回 idle(幂等清理)
      if (this.phase === 'error') { this.phase = 'idle'; this.abortMsg = ''; }
      return;
    }
    this.phase = 'error';
    this.abortMsg = reason || '登录已取消';
  }

  /**
   * 已授权客户端让位(换号接管内部流程):服务端 auth.LogOut(失败不阻断)→
   * 本地删会话文件 → fresh 重建空客户端。phase 回 idle 由后续 beginLogin 推进。
   */
  async teardownForRelogin() {
    await this.logoutServerSide();
    this.me = null;
    this.phase = 'idle';
    this.fatalReset();
    await this.host.recreateClient({ fresh: true });
  }

  async logoutServerSide() {
    try {
      const client = await this.host.ensureClient();
      await Promise.race([
        client.invoke(new this.lib.Api.auth.LogOut()),
        new Promise((_r, rej) => setTimeout(() => rej(new Error('logOut 超时')), this.bounds.closed + 5000)),
      ]);
    } catch (_e) { /* 服务端登出失败不影响本地清理 */ }
    deleteSessionFile();
  }

  /**
   * 登出:服务端 LogOut(失败不阻断)→ 删会话文件 → fresh 重建 → dropCaches。
   * 绝不抛,契约恒 {ok:true}。
   */
  async logout() {
    this.stopQrPoller();
    this.clearIdleTimer();
    this.pendingPhone = '';
    this.codeHash = '';
    this.qrToken = null;
    this.hint = '';
    this.flowError = '';
    this.stickyError = '';
    this.abortMsg = '';
    if (hasCreds()) {
      await this.logoutServerSide();
      this.me = null;
      this.phase = 'idle';
      try { await this.host.recreateClient({ fresh: true }); } catch (_e) { /* 重建失败:快照仍按未登录呈现 */ }
    } else {
      this.me = null;
      this.phase = 'idle';
    }
    if (this.onDropCaches) this.onDropCaches();
    return { ok: true };
  }

  // ==================== 登录闲置自毁(手机流与 QR 流同档) ====================

  armIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pendingPhone || this.phase === 'code' || this.phase === 'password' || this.phase === 'qr') {
        this.abortLogin('登录超时未完成,已作废,请重新开始'); // 绝不抛
      }
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
