#!/usr/bin/env node
'use strict';
/**
 * telegram.js —— Telegram MTProto 接入诊断 CLI(独立实现,与服务端插件双份维护)
 *
 * 用途:在把 Telegram 接进 MoontentRN/server 插件体系之前/之后,独立验证
 * 账号链路与能力面:登录、对话清单(群组/频道/私聊/我的收藏)、群内视频
 * 抽样、大文件分块下载测速、缩略图与头像下载。凭据与会话均可独立于服务端
 * 配置,排查问题时互不干扰(注意:MTProto 同一 auth key 双端并发在线可能互
 * 踢,诊断时先停服务端或用不同账号)。
 *
 * 依赖:teleproto(纯 JS MTProto 客户端,GramJS 活跃继任 fork,MIT)。本目录
 * 无 package.json,按仓库惯例从 MoontentRN/server/node_modules 以文件 URL
 * 动态导入,不引入新的安装位置。
 *
 * 用法:
 *   node Nodejs/telegram.js login                    交互式登录(手机号→验证码→两步验证),保存会话
 *   node Nodejs/telegram.js me                       当前账号信息(验证会话有效性)
 *   node Nodejs/telegram.js dialogs [N]              对话清单(N=视频数抽样上限,默认 12;0=不抽样)
 *   node Nodejs/telegram.js videos <peer> [N]        某对话的视频抽样(N 默认 10)
 *   node Nodejs/telegram.js dl <peer> <msgId> [MB]   下载测速(默认 8MB,512KB 块)
 *   node Nodejs/telegram.js thumb <peer> <msgId>     缩略图+头像下载验证(产物写 .tmpx/)
 *
 *   <peer> 形态:@username | 用户/群/频道数字 id(dialogs 输出的「标记形」:
 *   频道 -100xxxx、群 -xxxx、用户 xxxx)| saved(我的收藏)
 *
 * 凭据(优先级:环境变量 > MoontentRN/server/.env > 交互输入):
 *   TELEGRAM_API_ID / TELEGRAM_API_HASH —— my.telegram.org「API development tools」申请
 * 会话:Nodejs/.telegram-session.json(独立于服务端的 .telegram-session.json,均不入库)
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'MoontentRN', 'server');
const SESSION_FILE = path.join(__dirname, '.telegram-session.json');
const TMP_DIR = path.join(ROOT, '.tmpx');

// —— teleproto 定位:server/node_modules 下的文件 URL 动态导入(本目录无包环境) ——
async function loadTeleproto() {
  const rootPkg = path.join(SERVER_DIR, 'node_modules', 'teleproto', 'index.js');
  if (!fs.existsSync(rootPkg)) {
    console.error('[tg-cli] 未找到 teleproto,请先在 MoontentRN/server 下 npm install teleproto');
    process.exit(1);
  }
  const ns = await import(pathToFileURL(rootPkg).href);
  return ns; // { TelegramClient, Api, utils, errors, sessions, ... }
}

// —— 凭据:环境变量 > server/.env > 交互输入(server/.env 与服务端共用一套凭据) ——
function loadEnvCreds() {
  const out = { apiId: process.env.TELEGRAM_API_ID || '', apiHash: process.env.TELEGRAM_API_HASH || '' };
  try {
    const text = fs.readFileSync(path.join(SERVER_DIR, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(TELEGRAM_API_ID|TELEGRAM_API_HASH)\s*=\s*"?([^"\r\n]+)"?\s*$/);
      if (m && !out[m[1] === 'TELEGRAM_API_ID' ? 'apiId' : 'apiHash']) {
        out[m[1] === 'TELEGRAM_API_ID' ? 'apiId' : 'apiHash'] = m[2].trim();
      }
    }
  } catch (_e) { /* 无 .env 属正常 */ }
  return out;
}

async function ensureCreds(rl) {
  const c = loadEnvCreds();
  if (!c.apiId) c.apiId = (await rl.question('TELEGRAM_API_ID(my.telegram.org 申请): ')).trim();
  if (!c.apiHash) c.apiHash = (await rl.question('TELEGRAM_API_HASH: ')).trim();
  if (!/^\d+$/.test(c.apiId) || !c.apiHash) {
    console.error('[tg-cli] 凭据无效(apiId 须为数字)');
    process.exit(1);
  }
  return { apiId: Number(c.apiId), apiHash: c.apiHash };
}

function loadSession() {
  try {
    const j = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (j && typeof j.session === 'string' && j.session) return j;
  } catch (_e) { /* 无会话 */ }
  return null;
}

function saveSession(client, phone) {
  const j = { session: client.session.save(), phone: phone || '', savedAt: new Date().toISOString() };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(j, null, 2));
  console.log(`[tg-cli] 会话已保存:${path.relative(ROOT, SESSION_FILE)}(请勿外泄,等同账号密码)`);
}

// —— 客户端构造(诊断用保守参数:连接重试 3 次,不开激进并发) ——
function makeClient(Teleproto, StringSession, apiId, apiHash, sessionStr) {
  return new TelegramClient(new StringSession(sessionStr || ''), apiId, apiHash, {
    connectionRetries: 3,
    useWSS: false,
  });
}

// 已登录客户端:读会话→connect→校验授权;失败给出明确指引
async function authedClient(rl) {
  const T = await loadTeleproto();
  const saved = loadSession();
  if (!saved) {
    console.error('[tg-cli] 尚未登录,先执行:node Nodejs/telegram.js login');
    process.exit(1);
  }
  const creds = await ensureCreds(rl);
  const client = makeClient(T.TelegramClient, T.sessions.StringSession, creds.apiId, creds.apiHash, saved.session);
  await client.connect();
  if (!(await client.isUserAuthorized())) {
    console.error('[tg-cli] 会话已失效(被登出/被踢),请重新 login');
    process.exit(1);
  }
  return { T, client };
}

// 对话分类:频道(broadcast)/群组(megagroup|Chat)/用户(私聊)/收藏(self 伪对话)
function classify(entity) {
  const cn = entity.className;
  if (cn === 'Channel') return entity.broadcast ? '频道' : '群组';
  if (cn === 'Chat') return '群组';
  if (cn === 'User') return entity.self ? '收藏' : '私聊';
  return cn;
}

// 标记形 id:频道 -100xxxx / 普通群 -xxxx / 用户 xxxx(与官方客户端展示口径一致)
function markedId(entity) {
  const cn = entity.className;
  if (cn === 'Channel') return -1000000000000 - Number(entity.id);
  if (cn === 'Chat') return -Number(entity.id);
  return Number(entity.id);
}

// 视频文档属性摘要:时长秒/宽高/文件名/大小
function docInfo(message) {
  const doc = message && message.media && message.media.document;
  if (!doc || doc.className !== 'Document') return null;
  let duration = null; let w = null; let h = null; let name = '';
  for (const a of doc.attributes || []) {
    if (a.className === 'DocumentAttributeVideo') { duration = Number(a.duration) || null; w = Number(a.w) || null; h = Number(a.h) || null; }
    if (a.className === 'DocumentAttributeFilename') name = a.fileName || '';
  }
  return { id: String(doc.id), size: Number(doc.size), mime: doc.mimeType, duration, w, h, name, dcId: doc.dcId };
}

// 我的收藏 = 自己与自己的对话(self peer)
async function resolvePeer(T, client, arg) {
  if (arg === 'saved') return await client.getInputEntity('me');
  if (/^@/.test(arg)) return await client.getInputEntity(arg);
  if (/^-?\d+$/.test(arg)) {
    const marked = Number(arg);
    // 先走实体缓存(getInputEntity 对裸 id 未必有 accessHash),miss 则扫对话表找
    try { return await client.getInputEntity(marked); } catch (_e) { /* 走全量扫描 */ }
    for await (const d of client.iterDialogs({})) {
      if (d.entity && markedId(d.entity) === marked) return d.entity;
    }
    throw new Error('对话表与实体缓存中均未找到该 id,请先用 dialogs 确认');
  }
  throw new Error('peer 形态须为 @username | 数字id | saved');
}

// ============ 子命令 ============

async function cmdLogin(rl) {
  const T = await loadTeleproto();
  const creds = await ensureCreds(rl);
  const client = makeClient(T.TelegramClient, T.sessions.StringSession, creds.apiId, creds.apiHash, '');
  await client.connect();
  const phone = (await rl.question('手机号(含国际区号,如 +8613800138000): ')).trim();
  // 原生登录链(与服务端 tg.js 同构):不用 signInUser——凭据被拒时它会无限
  // 重问回调形成重试风暴(2026-10-10 实测拖死事件循环),这里每个请求一次往返
  const sent = await client.sendCode({ apiId: creds.apiId, apiHash: creds.apiHash }, phone);
  if (!sent || !sent.phoneCodeHash) throw new Error('发送验证码失败:未返回 phone_code_hash');
  console.log(`[tg-cli] 验证码已发送(经${sent.isCodeViaApp ? 'Telegram 应用内' : '短信'})`);
  let user = null;
  // 验证码轮(错误码原位重试,上限 3 轮)
  for (let i = 0; i < 3 && !user; i++) {
    const code = (await rl.question('验证码: ')).trim();
    try {
      const out = await client.invoke(new T.Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: sent.phoneCodeHash, phoneCode: code }));
      if (out.className === 'auth.AuthorizationSignUpRequired') throw new Error('该手机号尚未注册 Telegram 账号');
      user = out.user;
    } catch (e) {
      const m = e && e.errorMessage ? e.errorMessage : '';
      if (/SESSION_PASSWORD_NEEDED/.test(m)) { user = await loginPassword(T, client, rl); break; }
      if (/PHONE_CODE_INVALID|PHONE_CODE_EXPIRED/.test(m)) { console.error(`[tg-cli] ${/EXPIRED/.test(m) ? '验证码已过期' : '验证码不正确'},请重试(${2 - i} 次机会)`); continue; }
      throw e;
    }
  }
  if (!user) throw new Error('验证码重试次数用尽');
  console.log(`[tg-cli] 登录成功:${user.firstName || ''} ${user.lastName || ''} (@${user.username || '-'})`);
  saveSession(client, phone);
  await client.disconnect();
}

// 两步验证(2FA):GetPassword → SRP computeCheck → CheckPassword,密码错原位重试 3 轮
async function loginPassword(T, client, rl) {
  const pwdInfo = await client.invoke(new T.Api.account.GetPassword());
  for (let i = 0; i < 3; i++) {
    const pw = await rl.question(`两步验证密码${pwdInfo && pwdInfo.hint ? `(提示:${pwdInfo.hint})` : ''}: `);
    try {
      const check = await T.password.computeCheck(pwdInfo, pw);
      const out = await client.invoke(new T.Api.auth.CheckPassword({ password: check }));
      return out.user;
    } catch (e) {
      if (/PASSWORD_HASH_INVALID/.test((e && e.errorMessage) || '')) { console.error(`[tg-cli] 密码不正确,请重试(${2 - i} 次机会)`); continue; }
      throw e;
    }
  }
  throw new Error('两步验证重试次数用尽');
}

async function cmdMe(rl) {
  const { client } = await authedClient(rl);
  const me = await client.getMe();
  console.log(`账号:${me.firstName || ''} ${me.lastName || ''} (@${me.username || '-'}) id=${me.id} premium=${!!me.premium}`);
  await client.disconnect();
}

async function cmdDialogs(rl, sampleLimitArg) {
  const { T, client } = await authedClient(rl);
  const sampleLimit = Math.max(0, parseInt(sampleLimitArg || '12', 10) || 0);
  const dialogs = [];
  for await (const d of client.iterDialogs({})) {
    const e = d.entity;
    if (!e) continue;
    dialogs.push({ entity: e, name: d.name || e.title || (e.firstName + ' ' + (e.lastName || '')).trim(), kind: classify(e), marked: markedId(e), lastAt: d.date ? new Date(d.date * 1000).toISOString().slice(0, 16).replace('T', ' ') : '-' });
  }
  // 收藏置顶,其余按最近活跃排
  dialogs.sort((a, b) => (a.kind === '收藏' ? -1 : b.kind === '收藏' ? 1 : String(b.lastAt).localeCompare(String(a.lastAt))));
  console.log(`[tg-cli] 共 ${dialogs.length} 个对话${sampleLimit ? `(前 ${Math.min(sampleLimit, dialogs.length)} 个抽样视频数)` : ''}`);

  // 视频数抽样:messages.Search(filter=video) 的 count 字段(并发 4,防风暴)
  const pick = dialogs.slice(0, sampleLimit || dialogs.length).filter((d) => d.kind !== '收藏');
  let cursor = 0;
  const worker = async () => {
    while (cursor < pick.length) {
      const d = pick[cursor++];
      try {
        const r = await client.invoke(new T.Api.messages.Search({
          peer: await client.getInputEntity(d.entity), q: '',
          filter: new T.Api.InputMessagesFilterVideo(),
          minDate: 0, maxDate: 0, offsetId: 0, addOffset: 0, limit: 1, maxId: 0, minId: 0, hash: T.helpers.readBigIntFromBuffer(Buffer.alloc(16), true, true),
        }));
        d.videos = Number(r.count) || 0;
      } catch (e) { d.videos = 'err:' + String(e.message || e).slice(0, 30); }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  for (const d of dialogs.slice(0, 40)) {
    const v = d.videos == null ? '' : `  视频:${d.videos}`;
    console.log(`  [${d.kind}] ${String(d.marked)}  ${d.name.slice(0, 30)}  活跃:${d.lastAt}${v}`);
  }
  if (dialogs.length > 40) console.log(`  …(其余 ${dialogs.length - 40} 个省略)`);
  await client.disconnect();
}

async function cmdVideos(rl, peerArg, nArg) {
  const { T, client } = await authedClient(rl);
  const peer = await resolvePeer(T, client, peerArg);
  const n = Math.max(1, parseInt(nArg || '10', 10) || 10);
  console.log(`[tg-cli] ${peerArg} 最近 ${n} 条视频:`);
  let i = 0;
  for await (const m of client.iterMessages(peer, { filter: new T.Api.InputMessagesFilterVideo(), limit: n })) {
    const info = docInfo(m);
    if (!info) continue;
    i++;
    const title = (m.message || info.name || '(未命名)').split('\n')[0].slice(0, 40);
    console.log(`  #${i} msgId=${m.id}  ${new Date(m.date * 1000).toISOString().slice(0, 16).replace('T', ' ')}  ${info.duration != null ? info.duration + 's' : '-'}  ${info.w || '?'}x${info.h || '?'}  ${(info.size / 1048576).toFixed(1)}MB  dc${info.dcId}  ${title}`);
    console.log(`      thumbs=${(m.media.document.thumbs || []).map((t) => t.className + (t.type ? ':' + t.type : '')).join(',')}  caption=${m.message ? '有' : '无'}`);
  }
  if (!i) console.log('  (无视频消息)');
  await client.disconnect();
}

async function cmdDl(rl, peerArg, msgIdArg, mbArg) {
  const { T, client } = await authedClient(rl);
  const peer = await resolvePeer(T, client, peerArg);
  const msgs = await client.getMessages(peer, { ids: [Number(msgIdArg)] });
  const msg = msgs && msgs[0];
  const info = msg ? docInfo(msg) : null;
  if (!info) { console.error('[tg-cli] 该消息不是视频文档'); process.exit(1); }
  const total = Math.min(Math.max(1, parseInt(mbArg || '8', 10) || 8) * 1048576, info.size);
  const CHUNK = 512 * 1024;
  console.log(`[tg-cli] 下载测速:${peerArg} msg=${msgIdArg} ${(info.size / 1048576).toFixed(1)}MB 文件取前 ${(total / 1048576).toFixed(1)}MB,块 ${CHUNK / 1024}KB`);
  const t0 = Date.now(); let got = 0; let chunks = 0;
  for (let off = 0; off < total; off += CHUNK) {
    const len = Math.min(CHUNK, total - off);
    // iterDownload 支持任意 offset(内部自动对齐),单块一次迭代取满即走
    for await (const buf of client.iterDownload(msg, { offset: off, limit: len, requestSize: CHUNK })) { got += buf.length; }
    chunks++;
    if (chunks % 8 === 0) console.log(`  …${(got / 1048576).toFixed(1)}MB`);
  }
  const sec = (Date.now() - t0) / 1000;
  console.log(`[tg-cli] 完成:${(got / 1048576).toFixed(2)}MB / ${sec.toFixed(2)}s = ${(got / 1048576 / sec).toFixed(2)} MB/s(${chunks} 块)`);
  await client.disconnect();
}

async function cmdThumb(rl, peerArg, msgIdArg) {
  const { T, client } = await authedClient(rl);
  const peer = await resolvePeer(T, client, peerArg);
  fs.mkdirSync(TMP_DIR, { recursive: true });
  // 头像
  try {
    const avatar = await client.downloadProfilePhoto(peer, { isBig: false });
    if (avatar && avatar.length) {
      const p = path.join(TMP_DIR, `tg-avatar-${String(peerArg).replace(/[^0-9a-zA-Z_@]/g, '_')}.jpg`);
      fs.writeFileSync(p, Buffer.from(avatar));
      console.log(`[tg-cli] 头像 OK:${avatar.length}B → ${path.relative(ROOT, p)}`);
    } else console.log('[tg-cli] 头像:无(未设置)');
  } catch (e) { console.error('[tg-cli] 头像失败:', e.message || e); }
  // 视频缩略图:downloadMedia(thumb:0)+ 本地 stripped 重建双路验证
  const msgs = await client.getMessages(peer, { ids: [Number(msgIdArg)] });
  const msg = msgs && msgs[0];
  if (!msg || !docInfo(msg)) { console.error('[tg-cli] 该消息不是视频文档'); process.exit(1); }
  const thumbs = (msg.media.document.thumbs || []);
  const stripped = thumbs.find((t) => t.className === 'PhotoStrippedSize');
  if (stripped) {
    const jpg = T.utils.strippedPhotoToJpg(Buffer.from(stripped.bytes));
    const p = path.join(TMP_DIR, `tg-thumb-stripped-${msgIdArg}.jpg`);
    fs.writeFileSync(p, jpg);
    console.log(`[tg-cli] stripped 缩略图 OK(本地重建):${jpg.length}B → ${path.relative(ROOT, p)}`);
  } else console.log('[tg-cli] 无 stripped 缩略图(改走下载路径)');
  const full = await client.downloadMedia(msg, { thumb: 0 });
  if (full && full.length) {
    const p = path.join(TMP_DIR, `tg-thumb-full-${msgIdArg}.jpg`);
    fs.writeFileSync(p, Buffer.from(full));
    console.log(`[tg-cli] 全尺寸缩略图 OK:${full.length}B → ${path.relative(ROOT, p)}`);
  } else console.log('[tg-cli] 全尺寸缩略图:无');
  await client.disconnect();
}

// ============ 入口 ============

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    switch (cmd) {
      case 'login': await cmdLogin(rl); break;
      case 'me': await cmdMe(rl); break;
      case 'dialogs': await cmdDialogs(rl, rest[0]); break;
      case 'videos': if (!rest[0]) throw new Error('用法:videos <peer> [N]'); await cmdVideos(rl, rest[0], rest[1]); break;
      case 'dl': if (!rest[0] || !rest[1]) throw new Error('用法:dl <peer> <msgId> [MB]'); await cmdDl(rl, rest[0], rest[1], rest[2]); break;
      case 'thumb': if (!rest[0] || !rest[1]) throw new Error('用法:thumb <peer> <msgId>'); await cmdThumb(rl, rest[0], rest[1]); break;
      default:
        console.log('用法:node Nodejs/telegram.js login | me | dialogs [N] | videos <peer> [N] | dl <peer> <msgId> [MB] | thumb <peer> <msgId>');
        process.exit(cmd ? 1 : 0);
    }
  } catch (e) {
    // FLOOD_WAIT 等限流错误单独提示(诊断时频繁出现属正常,等待即可,勿重试风暴)
    const wait = e && e.errorMessage === 'FLOOD_WAIT_X' ? ` 需等待 ${e.seconds}s` : '';
    console.error(`[tg-cli] 失败:${e.message || e}${wait}`);
    process.exit(1);
  } finally {
    rl.close();
  }
})();
