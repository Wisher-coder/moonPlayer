// ============================================================================
// engine.js —— teleproto 统一引擎 facade(引擎-接线域;仅 Node 服务端运行)
// ----------------------------------------------------------------------------
// 2026-10 引擎收敛(TDLib → teleproto 全量替换)后的装配层:不实现数据面
// 逻辑,只做客户端生命周期、域模块装配、签名表方法分发与缓存失效协调。
//
// —— client 生命周期(与 TDLib 版的根本差异) ——
//   · 单一 teleproto 客户端:server/.telegram-session.json(StringSession,
//     tg-client.js 单一实现)为唯一会话源;登录成功即原地变授权态,无
//     「删库重建」概念(recreateClient({fresh}) 仅用于登出/换号:断开旧
//     客户端 → 重建空客户端);
//   · 懒连接:start() 只标记 ready,首个数据面调用/登录步骤经 ensureClient()
//     单飞连接(服务端离线启动不再拖死 boot;连接失败如实上抛,绝不重试);
//     已保存会话恢复时自动恢复登录态(markAuthorized)并挂接 updates 订阅;
//   · 数据面统一门 getClient():连接且已授权;未登录抛 TgNotLoggedInError
//     (routes fail() 的 instanceof 命中)。登录流程(auth 域)用裸
//     ensureClient()(未授权客户端是登录步骤的合法载体);
//   · stop:进程退出挂钩(beforeExit/SIGINT/SIGTERM)有界收尾 disconnect。
//
// —— 域模块装配契约(与 TDLib 版同构) ——
// 每个域模块支持两种导出形状(assembleDomain 自动适配):
//   ① 工厂/类形状:export function createXxx(deps) —— deps 为全量依赖包;
//   ② 直函数形状:模块直接导出自足命名函数(updates.js 的模块单例门面)。
// 全量依赖包(各域按需解构,多余键忽略):getClient(授权态客户端)/
// entityOf/normalizeMessage 双调用面/跨域缓存端口/dataDir/env/log 等。
//
// —— 缓存失效协调 ——
//   dropCaches() 向全部已装配域广播(dropCaches;updates 域额外
//   dropUpdateEvents 清事件环);单域失败记日志继续。auth 域经 onDropCaches
//   通知登出/换号,facade 对 logout/beginLogin 再兜底直调——双路径幂等。
//
// —— 防风暴红线(仓库约定) ——
//   一切失败如实上抛中文错误;绝不自动重试;有界等待常量在各域模块内,
//   facade 不新增任何重试。
// ============================================================================

import { TgNotLoggedInError, getCreds } from './shared.js';
import { peerKeyOfPeer } from './normalize.js';
import {
  newTgClient, readSavedSession, deleteSessionFile, defaultMediaConcurrency,
} from './tg-client.js';

// ============ normalize 双调用面适配(writes 同步面 / updates 异步面) ============

/**
 * 构造 normalize.js 单条归一化的两条调用带:
 *   forWrites(msg)     —— writes.js 的回执归一化:peerKey 由消息 peerId 反解
 *   forPorts(pk, msg)  —— updates.js 的端口:经 collectAndNormalize 全保真
 * @param {object} d { normalizeOne, selfId(串或()=>串), collectBatch }
 */
export function makeNormalizeFaces(d = {}) {
  const { normalizeOne, collectBatch } = d;
  if (typeof normalizeOne !== 'function') {
    throw new Error('teleproto 引擎装配失败:makeNormalizeFaces 需要 normalizeOne(normalize.js)');
  }
  const sidOf = () => {
    const s = typeof d.selfId === 'function' ? d.selfId() : d.selfId;
    return s == null ? '' : String(s);
  };
  return {
    forWrites: (msg) => {
      const pk = peerKeyOfPeer(msg && msg.peerId, sidOf());
      return normalizeOne(pk || '', msg, { selfId: sidOf() });
    },
    async forPorts(pk, msg) {
      if (typeof collectBatch !== 'function') {
        return normalizeOne(pk, msg, { selfId: sidOf() }); // 无批量面:退纯映射
      }
      const out = await collectBatch(pk, [msg]);
      return (out && out[0]) || null;
    },
  };
}

// ============ 域模块装配适配器(可单测;契约见文件头) ============

const DOMAIN_SPECS = {
  auth: [
    ['sessionSnapshot', ['sessionSnapshot', 'snapshot', 'loginStateSnapshot'], true],
    ['beginLogin', ['beginLogin', 'startLogin'], true],
    ['submitCode', ['submitCode', 'checkCode'], true],
    ['submitPassword', ['submitPassword', 'checkPassword'], true],
    ['beginQrLogin', ['beginQrLogin', 'startQrLogin'], false],
    ['abortLogin', ['abortLogin', 'cancelLogin'], true],
    ['logout', ['logout'], true],
    ['ensureReady', ['ensureReady', 'ensureAuthorized'], false],
    ['dropCaches', ['dropCaches', 'dropAuthCaches'], false],
    // meInfo:登录域 me 快照(selfUserId 的唯一来源;saved 伪对话编解码依赖)
    ['meInfo', ['meInfo'], false],
  ],
  dialogs: [
    ['getDialogs', ['getDialogs', 'loadDialogs', 'dialogList'], true],
    ['resolveUsername', ['resolveUsername', 'resolvePeerByUsername', 'resolve'], true],
    ['resolveInviteLink', ['resolveInviteLink'], false],
    ['dropCaches', ['dropCaches'], false],
    ['markDialogsDirty', ['markDialogsDirty'], false],
    ['chatOf', ['chatOf', 'getChat'], false],
    ['entityOf', ['entityOf'], false], // 跨域共享口(messages/media/writes/extras)
  ],
  messages: [
    ['getChatPage', ['getChatPage', 'chatPage'], true],
    ['getOneMessage', ['getOneMessage', 'getMessageOne'], true],
    ['dropCaches', ['dropCaches'], false],
    // —— 跨域复用面(兄弟域缓存/归一化不复制第二份;可选,缺则装配层降级) ——
    ['getMessage', ['getMessage'], false],
    ['collectAndNormalize', ['collectAndNormalize'], false],
    ['putMessage', ['putMessage'], false],
    ['dropMessages', ['dropMessages'], false],
    ['findMessagesByIds', ['findMessagesByIds'], false],
    ['rekeyMessage', ['rekeyMessage'], false],
  ],
  writes: [
    ['send', ['send', 'sendChatMessage', 'sendMessage'], true],
    ['sendBotCallback', ['sendBotCallback', 'sendCallback', 'callback'], true],
    ['sendPollVote', ['sendPollVote', 'sendVote', 'vote'], true],
    ['markChatRead', ['markChatRead', 'markRead', 'read'], true],
    ['dropCaches', ['dropCaches'], false],
    ['isSelfSent', ['isSelfSent'], false], // updates 端口:自身消息回声去重
  ],
  media: [
    ['listPeerVideos', ['listPeerVideos', 'peerVideos', 'boardList'], true],
    ['getVideoDetail', ['getVideoDetail', 'videoDetail', 'detail'], true],
    ['searchVideos', ['searchVideos', 'searchGlobalVideos'], true],
    ['signStream', ['signStream'], true],
    ['verifyStream', ['verifyStream'], true],
    ['resolveStreamTarget', ['resolveStreamTarget', 'streamTarget'], true],
    ['createRangeStream', ['createRangeStream', 'rangeStream'], true],
    ['serveImage', ['serveImage', 'tgImage', 'image'], true],
    ['pluginList', ['pluginList', 'list', 'aggregateList'], false],
    ['pluginBoards', ['pluginBoards', 'boards'], false],
    ['pluginRelated', ['pluginRelated', 'related'], false],
    ['dropCaches', ['dropCaches', 'dropMediaCaches'], false],
  ],
  updates: [
    ['globalUpdateSeq', ['globalUpdateSeq', 'currentSeq'], true],
    ['getUpdatesSince', ['getUpdatesSince', 'updatesSince'], true],
    ['waitForPeerEvent', ['waitForPeerEvent', 'waitPeerEvent'], true],
    ['dropUpdateEvents', ['dropUpdateEvents', 'drop', 'dropEvents', 'resetEvents'], false],
    ['dropCaches', ['dropCaches'], false],
    ['getChatFolders', ['getChatFolders', 'chatFolders'], false],
  ],
};

const DOMAIN_FACTORIES = {
  auth: ['createAuth', 'createTgAuth', 'TgAuthEngine', 'create'],
  dialogs: ['createDialogs', 'createTgDialogs', 'create'],
  messages: ['createMessages', 'createTgMessages', 'create'],
  writes: ['createTgWrites', 'createWrites', 'create'],
  media: ['createTgMedia', 'createMedia', 'create'],
  updates: ['createTgUpdates', 'createTgUpdatesCore', 'create'],
};

function instantiateFactory(fn, deps, factoryOpts) {
  const src = Function.prototype.toString.call(fn);
  if (src.startsWith('class ')) return new fn(deps);
  try {
    return fn(deps, factoryOpts);
  } catch (e) {
    if (e instanceof TypeError && /invoked without 'new'/i.test(e.message)) return new fn(deps);
    throw e;
  }
}

function pickFn(obj, candidates) {
  if (!obj || typeof obj !== 'object') return null;
  for (const c of candidates) {
    if (typeof obj[c] === 'function') return obj[c];
  }
  return null;
}

/**
 * 把一个域模块适配成 facade 需要的绑定表(与 TDLib 版同构:①模块直函数
 * → ②工厂/类实例;必需项缺失抛中文装配错误)。
 */
export function assembleDomain(mod, label, deps = {}, factoryOpts) {
  const spec = DOMAIN_SPECS[label];
  if (!spec) throw new Error('teleproto 引擎装配错误:未知域 ' + label);
  if (!mod || typeof mod !== 'object') {
    throw new Error('teleproto 引擎域模块 ' + label + ' 未就绪:文件缺失(应为 server/src/plugins/telegram-tg/' + label + '.js)');
  }
  const bound = {};
  const missing = [];
  const needFactory = [];
  for (const [name, candidates, required] of spec) {
    const direct = pickFn(mod, candidates);
    if (direct) bound[name] = direct.bind(mod);
    else needFactory.push([name, candidates, required]);
  }
  if (needFactory.some(([, , required]) => required)) {
    let inst = null;
    for (const fname of DOMAIN_FACTORIES[label] || []) {
      const fn = typeof mod[fname] === 'function' ? mod[fname] : null;
      if (!fn) continue;
      try {
        const made = instantiateFactory(fn, deps, factoryOpts);
        if (made && typeof made === 'object') { inst = made; break; }
      } catch (e) {
        throw new Error('teleproto 引擎域模块 ' + label + ' 装配失败:' + ((e && e.message) || e));
      }
    }
    if (!inst) {
      const names = needFactory.filter(([, , required]) => required).map(([name]) => name);
      throw new Error('teleproto 引擎域模块 ' + label + ' 未就绪:缺少 ' + names.join('/') + ' 导出(engine.js 文件头「域模块装配契约」为接口锚点)');
    }
    for (const [name, candidates] of needFactory) {
      const m2 = pickFn(inst, candidates);
      if (m2) bound[name] = m2.bind(inst);
      else if (spec.find((s) => s[0] === name)[2]) missing.push(name);
    }
  }
  if (missing.length) {
    throw new Error('teleproto 引擎域模块 ' + label + ' 未就绪:缺少 ' + missing.join('/') + ' 导出(engine.js 文件头「域模块装配契约」为接口锚点)');
  }
  return bound;
}

// ============ facade 主体 ============

class TgEngine {
  /**
   * @param {object} o
   * @param {Object<string,Function>} o.domains 域绑定表 { auth, dialogs, ... }(测试可注 mock)
   * @param {Function} [o.dropCachesImpl] dropCaches 实现(生产=广播各域;测试注入)
   * @param {boolean} [o.registerExitHooks] 进程退出挂钩(仅生产单例开启)
   * @param {Error} [o.fatal] 装配失败根因:置入后所有数据方法如实上抛同一错误
   * @param {(msg:string)=>void} [o.log]
   */
  constructor(o = {}) {
    this._domains = o.domains || {};
    this._dropCachesImpl = o.dropCachesImpl || (async () => {});
    this._log = o.log || ((m) => console.log('[telegram-tg] ' + m));
    this._fatal = o.fatal || null;
    this.status = 'idle'; // idle → ready → stopped
    this._startP = null;
    this._stopped = false;
    if (o.registerExitHooks) this._registerExitHooks();
  }

  get mode() { return 'teleproto'; }

  _d(name) {
    if (this._fatal) throw new Error('teleproto 引擎装配失败:' + (this._fatal.message || String(this._fatal)));
    const d = this._domains[name];
    if (!d) throw new Error('teleproto 引擎域模块 ' + name + ' 未装配(engine.js 文件头「域模块装配契约」为接口锚点)');
    return d;
  }

  // 未授权错误形态统一转换(needLogin 契约的接线层兜底;teleproto 侧域内
  // 已抛 TgNotLoggedInError,此处只兜 401 形态的漏网)
  async _mapErr(fn) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof TgNotLoggedInError) throw e;
      const msg = (e && e.message) || '';
      if (e && (e.code === 401 || /UNAUTHORIZED|AUTH_KEY_UNREGISTERED/.test(msg))) {
        throw new TgNotLoggedInError();
      }
      throw e;
    }
  }

  async _ready() {
    if (this._fatal) throw new Error('teleproto 引擎装配失败:' + (this._fatal.message || String(this._fatal)));
    await this.start();
  }

  /** 懒就绪:start 只标记 ready(客户端连接由首个使用方单飞驱动,见文件头) */
  async start() {
    if (this._fatal) throw new Error('teleproto 引擎装配失败:' + (this._fatal.message || String(this._fatal)));
    if (this._stopped) throw new Error('teleproto 引擎已停止(进程退出中),不再接受新请求');
    if (this._startP) return this._startP;
    this._startP = (async () => {
      // 无凭据:会话面照常可答(auth 域自读 hasCreds),数据面经 getClient
      // 如实上抛 getCreds(strict) 的既有中文文案(newTgClient 构造时)
      getCreds(false);
      this.status = 'ready';
    })().catch((e) => {
      this._startP = null;
      this.status = 'idle';
      throw e;
    });
    return this._startP;
  }

  /** 等待客户端就绪;未登录抛 TgNotLoggedInError(auth 域实现) */
  async ensureReady() {
    await this._ready();
    const auth = this._d('auth');
    if (typeof auth.ensureReady === 'function') return auth.ensureReady();
    const snap = await auth.sessionSnapshot();
    if (!snap || !snap.authorized) throw new TgNotLoggedInError();
    return undefined;
  }

  /** 缓存纪元:向全部已装配域广播;单域失败记日志继续(幂等作废动作) */
  async dropCaches() {
    for (const name of ['dialogs', 'messages', 'writes', 'media', 'updates', 'auth']) {
      const d = this._domains[name];
      if (!d) continue; // 失败态引擎(domains 空)也允许静默通过
      try {
        if (typeof d.dropCaches === 'function') await d.dropCaches();
      } catch (e) { this._log('dropCaches(' + name + ') 失败(继续其余域): ' + (e && e.message)); }
    }
    const upd = this._domains.updates;
    if (upd && typeof upd.dropUpdateEvents === 'function') {
      try { await upd.dropUpdateEvents(); }
      catch (e) { this._log('dropUpdateEvents 失败(继续): ' + (e && e.message)); }
    }
    if (typeof this._dropCachesImpl === 'function') await this._dropCachesImpl();
  }

  /** 启动预热:确保引擎就绪(失败静默不重试;真实请求会重走并如实报错) */
  async warm() {
    try { await this.start(); } catch (_e) { /* 预热失败静默 */ }
    const kick = this._domains._kickClient;
    if (typeof kick === 'function') kick().catch(() => { /* 连接失败静默:数据面首次调用会如实上抛 */ });
  }

  /** 停止:有界收尾(断开客户端),幂等;停止后拒绝新请求 */
  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    const stopImpl = this._domains._stopClient;
    if (typeof stopImpl === 'function') {
      try { await stopImpl(); }
      catch (e) { this._log('客户端停止失败(忽略,进程即将退出): ' + (e && e.message)); }
    }
    this.status = 'stopped';
  }

  // ============ 签名表(登录/对话/消息/写侧/事件环/媒体/插件聚合) ============

  async sessionSnapshot() { await this._ready(); return this._d('auth').sessionSnapshot(); }
  async beginLogin(phone) {
    await this._ready();
    const out = await this._d('auth').beginLogin(phone);
    await this.dropCaches();
    return out;
  }
  async submitCode(code) { await this._ready(); return this._d('auth').submitCode(code); }
  async submitPassword(pw) { await this._ready(); return this._d('auth').submitPassword(pw); }
  /** QR 扫码登录:返回 {phase:'qr',qr(dataURL),expires}|{phase:'ok',...}(已扫完) */
  async beginQrLogin() {
    await this._ready();
    const auth = this._d('auth');
    if (typeof auth.beginQrLogin !== 'function') {
      throw new Error('teleproto 引擎域模块 auth 未就绪:缺少 beginQrLogin 导出(QR 扫码登录)');
    }
    const out = await auth.beginQrLogin();
    if (out && out.snapshot && out.snapshot.authorized) await this.dropCaches();
    return out;
  }
  async abortLogin(reason) { await this._ready(); return this._d('auth').abortLogin(reason); }
  async logout() {
    await this._ready();
    const out = await this._d('auth').logout();
    await this.dropCaches();
    return out;
  }

  async getDialogs(list) { await this._ready(); return this._mapErr(() => this._d('dialogs').getDialogs(list)); }
  async resolveUsername(domain) { await this._ready(); return this._mapErr(() => this._d('dialogs').resolveUsername(domain)); }
  async resolveInviteLink(link) { await this._ready(); return this._mapErr(() => this._d('dialogs').resolveInviteLink(link)); }
  async getChatFolders() {
    await this._ready();
    const u = this._d('updates');
    return typeof u.getChatFolders === 'function' ? u.getChatFolders() : [];
  }

  async getChatPage(peerKey, opts) { await this._ready(); return this._mapErr(() => this._d('messages').getChatPage(peerKey, opts)); }
  async getOneMessage(peerKey, msgId, force) { await this._ready(); return this._mapErr(() => this._d('messages').getOneMessage(peerKey, msgId, force)); }

  async send(peerKey, text, replyTo) { await this._ready(); return this._mapErr(() => this._d('writes').send(peerKey, text, replyTo)); }
  async sendBotCallback(peerKey, msgId, dataB64, game) { await this._ready(); return this._mapErr(() => this._d('writes').sendBotCallback(peerKey, msgId, dataB64, game)); }
  async sendPollVote(peerKey, msgId, optionsB64) { await this._ready(); return this._mapErr(() => this._d('writes').sendPollVote(peerKey, msgId, optionsB64)); }
  async markChatRead(peerKey, maxId) { await this._ready(); return this._mapErr(() => this._d('writes').markChatRead(peerKey, maxId)); }

  async globalUpdateSeq() { await this._ready(); return this._d('updates').globalUpdateSeq(); }
  async getUpdatesSince(peer, afterSeq) { await this._ready(); return this._d('updates').getUpdatesSince(peer, afterSeq); }
  async waitForPeerEvent(peer, ms, signal) { await this._ready(); return this._d('updates').waitForPeerEvent(peer, ms, signal); }

  async resolveStreamTarget(videoId) { await this._ready(); return this._mapErr(() => this._d('media').resolveStreamTarget(videoId)); }
  async createRangeStream(videoId, start, end) {
    // 不经 _ready():流是惰性生成器,首字节窗口保持快速;真取数时 media 域经
    // getClient 自取当前客户端,错误在流内如实上抛
    return this._d('media').createRangeStream(videoId, start, end);
  }
  async listPeerVideos(peerKey, opts) { await this._ready(); return this._mapErr(() => this._d('media').listPeerVideos(peerKey, opts)); }
  async getVideoDetail(id) { await this._ready(); return this._mapErr(() => this._d('media').getVideoDetail(id)); }
  async searchVideos(kw, page, size) { await this._ready(); return this._mapErr(() => this._d('media').searchVideos(kw, { page, size })); }
  async signStream(videoId) { return this._d('media').signStream(videoId); }
  async verifyStream(videoId, token) { return this._d('media').verifyStream(videoId, token); }
  async serveImage(token) { await this._ready(); return this._mapErr(() => this._d('media').serveImage(token)); }

  async pluginList(o) {
    await this._ready();
    const m = this._d('media');
    if (typeof m.pluginList !== 'function') {
      throw new Error('teleproto 引擎域模块 media 未就绪:缺少 pluginList 导出(插件聚合语义由 media 域实现)');
    }
    return m.pluginList(o);
  }
  async pluginBoards() {
    await this._ready();
    const m = this._d('media');
    if (typeof m.pluginBoards !== 'function') {
      throw new Error('teleproto 引擎域模块 media 未就绪:缺少 pluginBoards 导出(插件聚合语义由 media 域实现)');
    }
    return m.pluginBoards();
  }
  async pluginRelated(id, o) {
    await this._ready();
    const m = this._d('media');
    if (typeof m.pluginRelated !== 'function') {
      throw new Error('teleproto 引擎域模块 media 未就绪:缺少 pluginRelated 导出(插件聚合语义由 media 域实现)');
    }
    return m.pluginRelated(id, o);
  }

  _registerExitHooks() {
    if (this._exitHooksOn) return;
    this._exitHooksOn = true;
    process.once('beforeExit', () => { this.stop().catch(() => {}); });
    const onSignal = () => {
      let done = false;
      const finish = () => { if (!done) { done = true; process.exit(0); } };
      this.stop().then(finish, finish);
      const t = setTimeout(finish, 6000);
      if (typeof t.unref === 'function') t.unref();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }
}

/**
 * 引擎工厂(可注入域绑定表——单测经此注入 mock,零网络)。
 */
export function createEngine(o = {}) {
  return new TgEngine(o);
}

// ============ 生产单例(域模块动态装配 + 客户端生命周期 + 退出挂钩) ============

let _singletonP = null;

/** 生产引擎单例:装配失败返回「失败态引擎」(所有调用如实上抛,无回退路径) */
export function getTdlibEngine() {
  if (!_singletonP) _singletonP = _buildSingleton();
  return _singletonP;
}

async function importDomain(label) {
  try {
    return await import('./' + label + '.js');
  } catch (e) {
    throw new Error('teleproto 引擎域模块 ' + label + ' 未就绪:文件缺失或加载失败(server/src/plugins/telegram-tg/' + label + '.js): ' + ((e && e.message) || e));
  }
}

const NOOP = () => {};

async function _buildSingleton() {
  try {
    const [tgClientMod, authMod, dialogsMod, messagesMod, writesMod, mediaMod, updatesMod, normalizeMod] = await Promise.all([
      importDomain('tg-client'),
      importDomain('auth'),
      importDomain('dialogs'),
      importDomain('messages'),
      importDomain('writes'),
      importDomain('media'),
      importDomain('updates'),
      importDomain('normalize'),
    ]);
    const log = (msg) => console.log('[telegram-tg] ' + msg);

    // —— 客户端生命周期闭包(单飞连接/恢复登录态/挂 updates/重建) ——
    let client = null;
    let connectP = null;
    let authDomain = null; // auth 绑定表(facade 形方法名,如 sessionSnapshot)装配后回填
    let authInst = null;   // auth 类实例(markAuthorized 等未入绑定表的方法)

    async function ensureClient() {
      if (client) return client;
      if (!connectP) {
        connectP = (async () => {
          const saved = readSavedSession();
          const c = tgClientMod.newTgClient({ sessionStr: saved || '' });
          try {
            await c.connect();
          } catch (e) {
            try { await c.disconnect(); } catch (_e) { /* 忽略 */ }
            throw e;
          }
          client = c;
          // 先挂事件转发:updates 订阅在连接后第一时间生效(零丢失窗口)
          try {
            updatesMod.attachTgUpdates(c, ports);
          } catch (e) { log('updates 挂接失败(实时事件将缺失,轮询兜底): ' + ((e && e.message) || e)); }
          // 恢复登录态:已保存会话有效 → markAuthorized(数据面 getClient 门放行)
          try {
            if (await c.isUserAuthorized()) {
              if (authInst && typeof authInst.markAuthorized === 'function') {
                authInst.markAuthorized();
              }
              log('已恢复 Telegram 会话');
            }
          } catch (_e) { /* isUserAuthorized 失败:保持未登录态,数据面如实报错 */ }
          return c;
        })().catch((e) => {
          connectP = null; // 连接失败回滚单飞:下次调用可重试显式触发
          throw e;
        }).finally(() => { connectP = null; });
      }
      return connectP;
    }

    async function recreateClient(opts = {}) {
      // 在途连接先落定(成功/失败都继续:失败也要清场重建)
      if (connectP) { try { await connectP; } catch (_e) { /* 清场重建 */ } }
      const old = client;
      client = null;
      if (old) {
        try { await old.disconnect(); } catch (e) { log('旧客户端断开失败(继续重建): ' + ((e && e.message) || e)); }
      }
      if (opts.fresh) {
        // 登出/换号:会话文件已由 auth 域删除;readSavedSession 兜底再清一次
        try { tgClientMod.deleteSessionFile(); } catch (_e) { /* 幂等 */ }
      }
      await ensureClient();
    }

    // 数据面统一门:连接且已授权;未登录抛 TgNotLoggedInError(needLogin 契约)
    async function getClient() {
      const c = await ensureClient();
      const snap = authDomain ? await authDomain.sessionSnapshot() : null;
      if (!snap || !snap.authorized) throw new TgNotLoggedInError();
      return c;
    }

    const host = {
      ensureClient,
      recreateClient,
      log,
    };

    // —— auth 域(类导出直接实例化;host 契约 {ensureClient,recreateClient}) ——
    if (typeof authMod.TgAuthEngine !== 'function') {
      throw new Error('teleproto 引擎域模块 auth 未就绪:缺少 TgAuthEngine 导出');
    }
    const authInstance = new authMod.TgAuthEngine({
      host,
      onDropCaches: () => engineRef.current.dropCaches(),
      log,
    });
    const authBound = {};
    for (const [name, candidates] of DOMAIN_SPECS.auth) {
      const fn = pickFn(authInstance, candidates);
      if (fn) authBound[name] = fn.bind(authInstance);
    }
    const missingAuth = DOMAIN_SPECS.auth.filter(([name, , req]) => req && !authBound[name]).map(([name]) => name);
    if (missingAuth.length) {
      throw new Error('teleproto 引擎域模块 auth 未就绪:缺少 ' + missingAuth.join('/') + ' 导出');
    }
    authDomain = authBound;
    authInst = authInstance;

    // —— 本人 user id(auth 缓存同步口;saved 伪对话编解码依赖) ——
    const selfUserId = () => {
      const me = typeof authInstance.meInfo === 'function' ? authInstance.meInfo() : null;
      return me && me.id != null ? String(me.id) : '';
    };

    // —— dialogs 域(模块级幂等单例;entityOf 跨域共享口) ——
    const dialogs = assembleDomain(dialogsMod, 'dialogs', {
      getClient,
      getSelfId: selfUserId,
      log,
    });

    const entityOf = (typeof dialogs.entityOf === 'function')
      ? dialogs.entityOf
      : (pk) => { throw new Error('未找到该 Telegram 对话(可能已退出),请刷新对话列表'); };

    // —— messages 域 ——
    const messages = assembleDomain(messagesMod, 'messages', {
      getClient,
      entityOf,
      getSelfId: selfUserId,
      log,
    });

    // —— normalize 双调用面 ——
    if (typeof normalizeMod.normalizeOne !== 'function') {
      throw new Error('teleproto 引擎域模块 normalize 未就绪:缺少 normalizeOne 导出');
    }
    const norm = makeNormalizeFaces({
      normalizeOne: normalizeMod.normalizeOne,
      selfId: selfUserId,
      collectBatch: (typeof messages.collectAndNormalize === 'function') ? messages.collectAndNormalize : null,
    });

    // —— writes 域 ——
    const writes = assembleDomain(writesMod, 'writes', {
      getClient,
      entityOf,
      normalizeMessage: norm.forPorts, // (pk,msg) 形:peerKey 显式(TDLib 版为单参形态)
      getMessageRaw: (typeof messages.getMessage === 'function') ? messages.getMessage : undefined,
      log,
    });

    // —— media 域 + env 吞吐旋钮(TG_MEDIA_CONCURRENCY 显式压低;缺省=
    //    downloadPool sessions×inFlight,见 tg-client.js) ——
    const envPosInt = (name) => {
      const n = Number(process.env[name]);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
    };
    const media = assembleDomain(mediaMod, 'media', {
      getClient,
      entityOf,
      getMessage: (typeof messages.getMessage === 'function') ? messages.getMessage : undefined,
      listChats: () => dialogs.getDialogs('main', { staleOk: true }),
      selfUserId,
      log,
    }, {
      ...(envPosInt('TG_MEDIA_CONCURRENCY') != null
        ? { getFileConcurrency: envPosInt('TG_MEDIA_CONCURRENCY') }
        : { getFileConcurrency: defaultMediaConcurrency() }),
    });

    // —— updates 域:端口接线(事件环核心 + attachTgUpdates 激活) ——
    const SENDER_TTL_MS = 60e3;
    const senderCache = new Map(); // userId → {info, at}(typing 心跳防打爆)
    async function senderOf(userId) {
      const key = String(userId);
      const hit = senderCache.get(key);
      if (hit && Date.now() - hit.at < SENDER_TTL_MS) return hit.info;
      let info = null;
      try {
        const c = await ensureClient();
        const u = await c.getEntity(key);
        info = { id: key, name: (((u && u.firstName) || '') + ' ' + ((u && u.lastName) || '')).trim() || ('用户 ' + key) };
      } catch (_e) { info = null; }
      if (info) {
        if (senderCache.size > 512) senderCache.clear();
        senderCache.set(key, { info, at: Date.now() });
      }
      return info;
    }
    const ports = {
      decodePeerKey: (peer) => peerKeyOfPeer(peer, selfUserId()),
      normalizeMessage: norm.forPorts,
      isSelfSent: (typeof writes.isSelfSent === 'function') ? writes.isSelfSent : NOOP,
      senderOf,
      putMessage: (typeof messages.putMessage === 'function') ? messages.putMessage : NOOP,
      markDialogsDirty: (typeof dialogs.markDialogsDirty === 'function') ? dialogs.markDialogsDirty : NOOP,
      dropPeerVideoCount: NOOP, // media 视频计数 TTL 自愈(游标梯子),无独立作废口
      dropMessageIds: (typeof messages.findMessagesByIds === 'function' && typeof messages.dropMessages === 'function')
        ? (ids) => {
          const hits = messages.findMessagesByIds(ids) || [];
          for (const h of hits) messages.dropMessages(h.peerKey, [h.msgId]);
          // 按 peerKey 去重:同会话多条命中只回一个会话键(环语义,不重复 enqueue)
          return [...new Set(hits.map((h) => h.peerKey))];
        }
        : NOOP,
      getClient: ensureClient, // folders 读取用(连接即可,无须授权门)
    };
    if (typeof updatesMod.attachTgUpdates !== 'function') {
      throw new Error('teleproto 引擎域模块 updates 未就绪:缺少 attachTgUpdates 导出(模块单例激活口)');
    }
    const updates = assembleDomain(updatesMod, 'updates', { host, log });
    const baseDropUpdateEvents = updates.dropUpdateEvents;
    updates.dropUpdateEvents = async () => {
      senderCache.clear(); // typing 发送者缓存属账号态
      await baseDropUpdateEvents();
    };

    const engineRef = { current: null };
    const engine = new TgEngine({
      domains: {
        auth: authBound,
        dialogs,
        messages,
        writes,
        media,
        updates,
        // 生命周期内部口(非域;warm/stop 消费)
        _kickClient: ensureClient,
        _stopClient: async () => {
          const c = client;
          client = null;
          if (c) { try { await c.disconnect(); } catch (_e) { /* 忽略 */ } }
        },
      },
      registerExitHooks: true,
      log,
    });
    engineRef.current = engine;
    // 增量域(routes/telegram-extras.js 的装载口):getClient/entityOf/selfUserId
    // 为引擎内部接线依赖,不经 facade 签名表面(extras 域工厂直连)
    engine._tgDeps = { getClient, entityOf, getSelfId: selfUserId, log };
    return engine;
  } catch (e) {
    console.error('[telegram-tg] 引擎装配失败(所有 Telegram 调用将如实上抛该错误): ' + (e && e.message));
    return new TgEngine({ fatal: e });
  }
}
