// ============================================================================
// use-chat-timeline.js —— Telegram 聊天时间线状态机 hook(页面渲染的唯一数据源)
// ----------------------------------------------------------------------------
// 契约:useChatTimeline(peerKey, opts?) → 见文件尾返回对象;配套页面用 RN
// FlatList inverted 渲染:
//   · items 数据序恒为新→旧(desc,id 大在前)——inverted 下 data[0]=最新=
//     视觉底部,data 末尾=最旧=视觉顶部;本地乐观消息(负 id)恒在最前;
//   · 首屏锚定:挂载/换会话自动 loadInitial()——锚点决策链:
//       opts.anchor > 0(深链定位)→ 本地阅读位置 getReadPos → 都没有则先以
//       anchor=0 拉最新页拿 peer 元数据,再用 peer.readInboxMaxId 重跳一记
//       dir=around 锚定服务端已读上界,仍为 0 就停在最新页;
//   · 未读分隔线:unreadAnchorId>0 时 items 中 id>unreadAnchorId 的消息构成
//     严格前缀(数组已按 id 降序),页面在「第一条 id<=unreadAnchorId 的消息」
//     视觉上方(即 items.findIndex(m => m.id <= unreadAnchorId) 命中行)插
//     「未读消息」线;命中不到(整屏皆未读)则插在最旧端(data 末尾那条的
//     视觉上方)。与 Telegram 同款:会话内边界固定,不随阅读推进移动;
//   · 翻页:loadOlder=视觉顶部取更旧一页(dir=older,排他锚=当前最旧真实 id),
//     loadNewer=拉新(dir=newer,锚=当前最新真实 id)。loadOlder 受 hasOlder
//     门禁(历史尽头不会变);loadNewer 刻意不受 hasNewer 门禁——它只是上次
//     响应的结论,新消息随时可能到来,页面手动「检查新消息/跳到最新」恒可用;
//   · 发送:send(text, replyTo?) 乐观插入(pending 存根负 id、out=true、mimic
//     归一化消息形状),成功后原位替换为服务端消息,失败标记 __status='failed'
//     供 retrySend(localId) 重发;两者均返回 Promise(失败 reject,页面可 catch
//     做 toast——存根上的失败角标是主呈现,reject 是如实上抛的第二通道);
//   · 单条更新:replaceMessage(msg) 按 id 原地替换(bot 回调/投票后页面喂回);
//   · 存根丢弃:discardStub(localId) 移除一条乐观存根(负 id)——长按菜单
//     「取消发送」入口(蓝图 §5.1-B cancelSend;仅负 id 存根可丢,真实消息
//     的撤回走服务端 delete 通道,不在本 hook 职责内);
//   · typing 事件消费(type:'typing',服务端契约:{peer,type,senders:[{id,name}]},
//     senders 为全量在打者、服务端按 peer×sender 5s TTL 自清):hook 只做
//     转存 + 5s 本地兜底清零(末次取消事件丢失时不悬挂「正在输入」);
//     MTProto 事件层不产 typing 事件(服务端 updates.js 不冒充),该状态恒空,
//     旧调用方零影响;
//   · 阅读位置联动:onVisible(msgId) 喂「当前最新可见消息 id」(页面在
//     onViewableItemsChanged 里取可见集最大 id 调用),内部只进不退 + 1s 节流
//     写 setReadPos,窗口内尾随定时器补写,卸载/换会话兜底 flush;阅读位
//     越过 unreadAnchorId 时清界(未读分隔线随 state 消失)——建议页面
//     在首屏 scrollTo 锚点落定后再开始喂,防锚定滚动前底部可见事件误推进已读。
// 竞态防护(照搬 use-infinite-list 的三层 + 定向扩展):
//   · epoch 世代号:换会话/重挂/重试时 +1,迟到的旧响应整组丢弃;增量翻页
//     (older/newer)不自增世代,互不作废、可并行;
//   · alive 存活标志:卸载后到达的响应丢弃;
//   · 在途锁:首屏 / older / newer / 单条重发各一把,滚动反复触发不重复发请求;
//     首屏锁带世代判定——同代在途拒绝(双击重试防抖),跨代(换会话后迟到的
//     旧代)由新代接管,旧代自行丢弃;
//   · 焦点门闩:失焦屏 loadOlder/loadNewer 一律拒绝,防隐藏态容器重排误触
//     连打;loadInitial 与 send 是显式动作,不受门闩约束。
// 失败如实暴露、绝不自动重试(防请求风暴,仓库红线):err 只置值不清列表,
// 页面给重试入口(loadInitial / loadOlder / loadNewer 再调即重试);上游错误
// 经 mapErr 统一映射中文提示。needLogin:tg-api 通道 Error.needLogin 精确
// 透传,文案启发式匹配仅留兜底(见网络层说明)。
// 网络层说明:GET/POST 统一走 lib/tg-api.js 的 api/postJson(20s 默认超时 +
// {__err:1,message,needLogin} 错误契约,Error.needLogin 精确透传——GET 侧
// 未登录判定不再依赖文案启发式;长轮询 GET /updates 单独放宽到 30s:服务端
// wait 挂起上限 20s + 网络余量,默认档必然截断)。消息对象再过一层本文件的
// normalizeDeep:补齐 URL 键(fullUrl/webpage.photo 等),并把 https://tg.local/
// <...> 图片伪 URL 令牌统一包成 /api/img/telegram?u=<enc> 代理地址后绝对化
// (幂等)。媒体里的视频不经此层:页面用 media.video.videoId 直通
// /video/telegram/<videoId> 播放。
// 实时事件面(长轮询,页面驱动启停;锚定/翻页/发送逻辑不因它重构):
//   · startPolling()/stopPolling() —— 页面聚焦/失焦时启停(幂等;stop 掐断
//     在途长轮询 + 清续轮定时器)。循环打 GET /api/telegram/updates?
//     peer&seq&wait=20000 维护会话游标 seq:响应 {events,seq} → 事件按序
//     落地(new/edit → mergeMessages 按 id 覆盖即应用编辑;message=null 按
//     id 走 GET /message 强拉一次;delete → 按 ids 从 items 移除;peer →
//     部分计数补进 peer 头),游标推进到返回 seq(例外:首屏/重载未就绪时
//     冻结游标——事件留在服务端环、就绪后下一轮原样重放,防重载窗口与
//     服务端取数的时间竞态丢消息,见 pollTick);{reset:true,seq} → 游标
//     对齐后做一次 loadInitial 整页重拉。失败一律静默(不置 err)、绝不自动
//     重试,20s 间歇后再发(与旧定时轮询同拍,防请求风暴);经本后端 /send
//     发出的消息不产生事件(send 响应即回执),其它设备的消息/编辑/删除/
//     已读水位经事件流到达;
//   · reportRead(maxId) —— 已读上报(POST /read),有界去抖约 2s(窗口外
//     立即报、窗口内一个尾随定时器到点补报、不被后续喂值无限顺延、只进不
//     退),卸载/换会话兜底 flush;失败 console 记录不重试;成功回调本地
//     乐观 patch peer(readInboxMaxId 推进 + unreadCount 扣减已载窗口内
//     新看的来向消息数,FAB 徽标即时收敛;服务端 peer 事件随后校正,双保险)。
// ============================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { absolutizeUrl } from '../lib/client.js';
import { api, postJson, LONGPOLL_TIMEOUT_MS } from '../lib/tg-api.js';
import { getReadPos, setReadPos } from '../lib/tg-read.js';

const PAGE_LIMIT = 40;         // dir=older/around 旧向每页条数(新向由服务端封顶约 60)
const READ_WRITE_MS = 1000;    // 阅读位置节流窗口(窗口外即写 + 窗口内尾随补写)
const TG_TOKEN_HOST = 'https://tg.local/'; // 服务端图片伪 URL 令牌的宿主
const MAX_DEPTH = 8;           // normalizeDeep 防御式深度上限(同 client.js)
const LONGPOLL_WAIT_MS = 20000; // 长轮询服务端等待毫秒(服务端钳制上限即 20s,传满额)
const POLL_ERROR_MS = 20000;    // 轮询失败后的静默间歇(与旧 20s 定时轮询同拍,防请求风暴)
const RELOAD_REPOLL_MS = 500;   // 重载窗口冻结游标后的就绪探测间隔(见 pollTick,防密集空转)
const READ_REPORT_MS = 2000;    // 已读上报有界去抖窗口(约 2s)
const TYPING_TTL_MS = 5000;     // typing 本地兜底 TTL(与服务端 peer×sender 5s 自清同拍)

// peer 计数事件(/updates type='peer')携带的部分计数键,补进 peer 头
const PEER_PATCH_KEYS = ['unreadCount', 'readInboxMaxId', 'readOutboxMaxId', 'unreadMark'];

// —— 上游错误 → 中文提示(裸网络/HTTP 错误在此归一) ——
// needLogin:tg-api 通道已把 Error.needLogin 精确透传;文案启发式匹配保留
// 兜底(历史错误对象无该字段时仍可识别,双通道与旧版兼容)
const NEED_LOGIN_RE = /(未登录|请先登录|需要登录|重新登录)/;
function mapErr(e) {
  const raw = e && e.message ? String(e.message) : '';
  let message = raw;
  if (!raw) message = '请求失败,请重试';
  else if (/^(Network request failed|Failed to fetch|Load failed)/i.test(raw)) {
    message = '网络连接失败,请检查网络后重试';
  } else if (/^HTTP \d+/.test(raw)) {
    message = '服务异常(' + raw + '),请稍后重试';
  }
  return { message, needLogin: !!(e && e.needLogin) || NEED_LOGIN_RE.test(raw) };
}

// mapErr 的抛错形态(send/retrySend reject 给页面 catch 用)
function toCnError(e) {
  const m = mapErr(e);
  const err = new Error(m.message);
  err.needLogin = m.needLogin;
  return err;
}

// —— 图片地址归一:伪 URL 令牌 → /api/img/telegram 代理 → 绝对化 ——
// tg.local/t/<videoId>(文档缩略图)、/a/<peerKey>(头像)、/p/<videoId>[w]/<m|x>
// (相册图)是服务端内部令牌,真正加载必须经图片代理;已是代理/绝对/相对
// 地址的按 absolutizeUrl 常规处理(幂等,重复归一无副作用)
function tgMediaUrl(u) {
  if (typeof u !== 'string' || !u) return u || '';
  if (u.startsWith(TG_TOKEN_HOST)) {
    return absolutizeUrl('/api/img/telegram?u=' + encodeURIComponent(u));
  }
  return absolutizeUrl(u);
}

// 深遍历归一:补 client.js URL_KEYS(cover/avatar/thumb/url)之外的本模块键
// (fullUrl / webpage.photo)。photo 键既可能是对象(media.photo 子对象)也可能
// 是字符串(webpage.photo),靠 typeof 守卫分流,与 client 的写法同款
const URL_KEYS = new Set(['url', 'fullUrl', 'cover', 'thumb', 'avatar', 'photo']);
function normalizeDeep(v, depth) {
  if (depth > MAX_DEPTH || v == null) return v;
  if (Array.isArray(v)) return v.map((x) => normalizeDeep(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      const val = v[k];
      out[k] = URL_KEYS.has(k) && typeof val === 'string' ? tgMediaUrl(val) : normalizeDeep(val, depth + 1);
    }
    return out;
  }
  return v;
}

// 归一化单条消息:重建对象(不污染共享引用)+ id 防御式归一为数字
function normalizeMsg(m) {
  if (!m || typeof m !== 'object') return m;
  const out = normalizeDeep(m, 0);
  if (out && out.id != null) out.id = Number(out.id) || 0;
  return out;
}

// —— 本地乐观消息:id 发号器(负数递减,模块级会话内唯一) ——
let localSeq = 0;
function nextLocalId() {
  localSeq -= 1;
  return localSeq;
}

// 乐观存根:mimic 归一化消息形状(out=true,from 留空——自己发的消息页面按
// out 判定归属),__status 供页面出转圈/失败角标;replyTo 只填 msgId,成功后
// 被服务端完整形状({msgId,name,snippet})原位替换
function makeStub(peerKey, localId, text, replyTo) {
  let rid = 0;
  if (replyTo && typeof replyTo === 'object') rid = Math.floor(Number(replyTo.msgId)) || 0;
  else rid = Math.floor(Number(replyTo)) || 0;
  return {
    id: localId,
    peerKey: String(peerKey || ''),
    kind: 'message',
    date: new Date().toISOString(),
    out: true,
    views: null,
    from: null,
    text: String(text || ''),
    entities: [],
    groupedId: null,
    forward: null,
    viaBot: null,
    signature: null,
    replyTo: rid > 0 ? { msgId: rid, name: '', snippet: '' } : null,
    media: null,
    inlineKeyboard: null,
    replyKeyboard: null,
    service: null,
    __status: 'pending', // 'pending' | 'failed'
  };
}

// 数组切成 [本地存根(保序,恒在前), 真实消息]
function splitStubs(list) {
  const stubs = [];
  const real = [];
  for (const m of list || []) {
    if (!m) continue;
    if (typeof m.id === 'number' && m.id < 0) stubs.push(m);
    else real.push(m);
  }
  return [stubs, real];
}

// 合并:真实消息按 id 去重(incoming 覆盖旧值——服务端数据更新鲜)后降序排,
// 本地存根原序拼在最前(最新端=视觉底部)。older/newer/发送成功共用一个口径
function mergeMessages(prev, incoming) {
  const [stubs, real] = splitStubs(prev);
  const map = new Map();
  for (const m of real) map.set(m.id, m);
  for (const m of incoming || []) {
    const n = normalizeMsg(m);
    if (n && typeof n.id === 'number' && n.id !== 0) map.set(n.id, n);
  }
  const list = Array.from(map.values()).sort((a, b) => b.id - a.id);
  return stubs.concat(list);
}

// 存根打标(pending/failed):按 localId 精确命中,未命中原样返回
function markStub(prev, localId, status) {
  const list = prev || [];
  let hit = false;
  const next = list.map((m) => {
    if (m && m.id === localId) {
      hit = true;
      return { ...m, __status: status };
    }
    return m;
  });
  return hit ? next : list;
}

// 从 items 移除一组消息 id(delete 事件用;乐观存根负 id 永不命中,prev 为
// null/未命中时原样返回引用,不给 React 制造无谓的新数组)
function dropIds(prev, ids) {
  if (!prev || !prev.length) return prev;
  const drop = new Set();
  for (const x of ids || []) {
    const n = Math.floor(Number(x)) || 0;
    if (n > 0) drop.add(n);
  }
  if (!drop.size) return prev;
  return prev.filter((m) => !(m && drop.has(m.id)));
}

// 覆盖事件关联摘除:TDLib 引擎 send 回执携带临时 id(TDLib messageSendingState
// 语义),updateMessageSendSucceeded 的 new 覆盖事件加性携带
// replacesId=临时 id——合并前摘除旧 id 副本,防同一条消息双显(临时 id 副本
// 此后不再有 edit/delete/已读事件打上来,是僵尸拷贝;mtproto 引擎事件不带
// replacesId,此分支不触达)。prev 为 null/未命中时原样返回。
function dropReplaced(prev, replacedId) {
  const n = Math.floor(Number(replacedId)) || 0;
  if (!(n > 0) || !prev || !prev.length) return prev;
  const hit = prev.some((m) => m && m.id === n);
  return hit ? prev.filter((m) => !(m && m.id === n)) : prev;
}

// ============================================================================
// useChatTimeline(peerKey, opts?)
//   peerKey:string    —— 服务端归一化对话键(c*/g*/u*/saved),空值时 hook 静止
//   opts.limit:number —— 旧向每页条数(默认 40,下限 10)
//   opts.anchor:number —— 首屏锚点覆盖(深链定位到某条消息用;>0 时优先于
//                         本地阅读位置;变化即整体重载)
// ============================================================================
export function useChatTimeline(peerKey, opts = {}) {
  const limit = Math.max(10, Math.floor(Number(opts && opts.limit)) || PAGE_LIMIT);
  const anchorOpt = Math.floor(Number(opts && opts.anchor)) || 0;

  const [items, setItems] = useState(null); // null=首屏未就绪(骨架);[]=已加载但为空
  const [peer, setPeer] = useState(null);   // 对话元数据(around 响应携带,见契约)
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [err, setErr] = useState('');       // 最近一次取数失败(首屏失败 items=null;加载更多失败列表保留)
  const [needLogin, setNeedLogin] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [hasNewer, setHasNewer] = useState(false);
  const [anchorId, setAnchorId] = useState(0);             // 本次首屏锚点消息 id(0=最新页无锚)
  const [unreadAnchorId, setUnreadAnchorId] = useState(0); // 未读边界(0=不渲染分隔线)
  const [typingSenders, setTypingSenders] = useState([]);  // 正在输入者(全量列表;恒空=无 typing 事件面)

  const epochRef = useRef(0);               // 请求世代号(过期判定,照搬 use-infinite-list)
  const aliveRef = useRef(true);            // 组件存活标志(卸载后丢弃迟到响应)
  const initialInflightRef = useRef(false); // 首屏在途锁(带世代判定,见文件头)
  const initialSeqRef = useRef(0);          // 首屏在途所属世代
  const olderInflightRef = useRef(false);   // 旧向翻页在途锁
  const newerInflightRef = useRef(false);   // 新向拉取在途锁
  const retryInflightRef = useRef(new Set()); // 单条重发在途锁(防双击重复发送)
  const readRef = useRef({ max: 0, at: 0, saved: 0, timer: null }); // 阅读位置游标
  const focusedRef = useRef(true);          // 屏幕焦点门闩(失焦拒绝增量翻页)
  const pollRef = useRef({ on: false, seq: 0, timer: null, ctl: null, busy: false }); // 长轮询循环(开关/会话游标/续轮定时器/在途中止/单链在途锁)
  const reportRef = useRef({ max: 0, at: 0, timer: null });             // 已读上报游标(只进不退 + 有界去抖)
  const typingTimerRef = useRef(null);     // typing 兜底清零定时器(见 TYPING_TTL_MS)
  const pollTickRef = useRef(null);        // pollTick 跨渲染稳定引用(render 期同步,见下)

  // render 期同步的最新引用:回调跨渲染稳定,避免闭包过期(基线同款)
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const peerRef = useRef(peer);
  peerRef.current = peer;
  const hasOlderRef = useRef(hasOlder);
  hasOlderRef.current = hasOlder;
  const peerKeyRef = useRef(peerKey);
  peerKeyRef.current = peerKey;
  const anchorOptRef = useRef(anchorOpt);
  anchorOptRef.current = anchorOpt;
  const limitRef = useRef(limit);
  limitRef.current = limit;
  const unreadAnchorIdRef = useRef(unreadAnchorId); // 未读边界镜像(onVisible 内推进判据用)
  unreadAnchorIdRef.current = unreadAnchorId;

  // 屏幕焦点门闩:focus 置位 / blur 复位(初值 true,栈导航下屏挂载时必为焦点)
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      return () => {
        focusedRef.current = false;
      };
    }, [])
  );

  // GET /messages:anchor=0 表示最新页;dir=around|older|newer
  const fetchMessages = useCallback((anchor, dir) => {
    const p = peerKeyRef.current;
    if (!p) return Promise.reject(new Error('缺少对话标识'));
    return api('telegram', 'messages', {
      peer: p,
      anchor: Math.max(0, Math.floor(Number(anchor)) || 0),
      dir,
      limit: limitRef.current,
    });
  }, []);

  // 首屏结果落地:a=最终锚点(0=最新页)。functional setItems 与并发的乐观存根
  // 自然合流(存根保留在最前);unreadAnchorId=锚点(无锚不渲染分隔线)
  const applyInitial = useCallback((res, a) => {
    const list = Array.isArray(res && res.items) ? res.items : [];
    setItems((prev) => mergeMessages(prev, list));
    setHasOlder(!!(res && res.hasOlder));
    setHasNewer(!!(res && res.hasNewer));
    if (res && res.peer) setPeer(normalizeDeep(res.peer, 0));
    setAnchorId(a > 0 ? a : 0);
    setUnreadAnchorId(a > 0 ? a : 0);
  }, []);

  // —— 首屏锚定加载(loadInitial 也兼做整体重试/手动刷新) ——
  // anchor 省略/0 → opts.anchor → 本地阅读位置 → 0;之后走两跳决策链:
  // 第一跳 anchor=0 拿最新页+peer 元数据,readInboxMaxId>0 则以它为锚再跳
  // 一记 around(第一跳 items 弃用,只留 peer 元数据);仍 0 则停在最新页。
  // 注意:入锁/世代判定之后即设微任务屏障——无论锚点决策链走哪条(含
  // opts.anchor>0 深链直取,首个 await 不再必然是 getReadPos),effect 直呼
  // 路径(如登录重试)的 setState 全部落在异步续体(React Compiler 红线:
  // effect 体内不得同步 setState)
  const loadInitial = useCallback(
    async (anchor) => {
      // 同代在途:拒(双击重试防抖);跨代在途:接管(旧代被世代号丢弃)
      if (initialInflightRef.current && initialSeqRef.current === epochRef.current) return;
      const seq = ++epochRef.current; // 作废一切在途的增量/旧首屏响应
      initialInflightRef.current = true;
      initialSeqRef.current = seq;
      olderInflightRef.current = false;
      newerInflightRef.current = false;
      await Promise.resolve(); // 微任务屏障(见上注):此后零同步 setState
      try {
        let a = Math.floor(Number(anchor)) || 0;
        if (!(a > 0)) a = anchorOptRef.current; // 深链锚点优先于本地位置
        if (!(a > 0)) a = await getReadPos(peerKeyRef.current); // 本地阅读位置
        if (!aliveRef.current || seq !== epochRef.current) return; // 已卸载/过期,丢弃
        // 全量重置(回到骨架屏;peer 一并清空防换会话串台)
        setItems(null);
        setPeer(null);
        setErr('');
        setNeedLogin(false);
        setLoadingOlder(false);
        setLoadingNewer(false);
        setHasOlder(false);
        setHasNewer(false);
        setAnchorId(0);
        setUnreadAnchorId(0);
        setTypingSenders([]); // 重载/换会话:typing 态一并清(新会话不带旧状态)
        if (!peerKeyRef.current) {
          setItems([]); // 无对话标识:静止的空列表(loading 恒 false)
          return;
        }
        let res = await fetchMessages(a, 'around');
        if (!aliveRef.current || seq !== epochRef.current) return;
        if (!(a > 0) && res.peer && Number(res.peer.readInboxMaxId) > 0) {
          // 本地无记录 → 服务端已读上界锚定(第二跳);先落 peer,第二跳失败时
          // 错误态也能渲染对话头
          setPeer(normalizeDeep(res.peer, 0));
          a = Math.floor(Number(res.peer.readInboxMaxId));
          res = await fetchMessages(a, 'around');
          if (!aliveRef.current || seq !== epochRef.current) return;
        }
        applyInitial(res, a);
      } catch (e) {
        if (!aliveRef.current || seq !== epochRef.current) return; // 已卸载/过期,丢弃
        const me = mapErr(e);
        setErr(me.message);
        setNeedLogin(me.needLogin);
        // 首屏失败:items 保持 null,页面 ErrorState + loadInitial() 重试
      } finally {
        // 仅最新世代放行在途锁,防被作废请求提前解锁(基线同款)
        if (seq === epochRef.current) {
          initialInflightRef.current = false;
        }
      }
    },
    [fetchMessages, applyInitial]
  );

  // —— 视觉顶部取更旧一页(dir=older,排他锚=当前最旧真实消息 id) ——
  // 焦点门闩 + hasOlder 门禁 + 在途锁三重;失败保留列表、err 置值,再调即重试
  const loadOlder = useCallback(() => {
    if (!focusedRef.current) return;
    if (olderInflightRef.current) return;
    const cur = itemsRef.current;
    if (!cur || !cur.length) return;
    if (!hasOlderRef.current) return; // 历史尽头(older 向尽头不会回弹)
    let oldest = 0;
    for (let i = cur.length - 1; i >= 0; i--) {
      const id = cur[i] && cur[i].id;
      if (typeof id === 'number' && id > 0) {
        oldest = id;
        break;
      }
    }
    if (!oldest) return; // 只有乐观存根:无真实锚可翻
    olderInflightRef.current = true;
    const seq = epochRef.current; // 增量不自增世代:与 newer/在途发送互不作废
    setLoadingOlder(true);
    setErr('');
    fetchMessages(oldest, 'older')
      .then((res) => {
        if (!aliveRef.current || seq !== epochRef.current) return;
        const list = Array.isArray(res && res.items) ? res.items : [];
        setItems((prev) => mergeMessages(prev, list));
        setHasOlder(!!(res && res.hasOlder));
        // 不回写 hasNewer:older 响应的 hasNewer 恒真(服务端语义=「锚点之下
        // 必有新消息」,而锚点是已加载的最旧 id),覆盖会在已读尽的会话误出
        // 「还有未读消息」补页闸;该状态只由首屏 around 与 loadNewer 响应维护
      })
      .catch((e) => {
        if (!aliveRef.current || seq !== epochRef.current) return;
        const me = mapErr(e);
        setErr(me.message);
        if (me.needLogin) setNeedLogin(true);
      })
      .finally(() => {
        if (seq === epochRef.current) {
          setLoadingOlder(false);
          olderInflightRef.current = false;
        }
      });
  }, [fetchMessages]);

  // —— 拉新(dir=newer,锚=当前最新真实消息 id) ——
  // 刻意不受 hasNewer 门禁(新消息随时可能到来,手动检查恒可用);其余防护
  // 与 loadOlder 同款。结果并入后页面自行决定是否滚到最新端
  const loadNewer = useCallback(() => {
    if (!focusedRef.current) return;
    if (newerInflightRef.current) return;
    const cur = itemsRef.current;
    if (!cur || !cur.length) return;
    let newest = 0;
    for (let i = 0; i < cur.length; i++) {
      const id = cur[i] && cur[i].id;
      if (typeof id === 'number' && id > 0) {
        newest = id;
        break;
      }
    }
    if (!newest) return;
    newerInflightRef.current = true;
    const seq = epochRef.current;
    setLoadingNewer(true);
    setErr('');
    fetchMessages(newest, 'newer')
      .then((res) => {
        if (!aliveRef.current || seq !== epochRef.current) return;
        const list = Array.isArray(res && res.items) ? res.items : [];
        setItems((prev) => mergeMessages(prev, list));
        setHasNewer(!!(res && res.hasNewer));
        setHasOlder(!!(res && res.hasOlder));
        // dir=newer 响应现也附带 peer 头(服务端契约:增量补页时水位线随页刷新,
        // unreadCount 供「还有 N 条未读」闸显示);null 时不动既有头部
        if (res && res.peer) setPeer((prev) => (prev ? { ...prev, ...normalizeDeep(res.peer, 0) } : normalizeDeep(res.peer, 0)));
      })
      .catch((e) => {
        if (!aliveRef.current || seq !== epochRef.current) return;
        const me = mapErr(e);
        setErr(me.message);
        if (me.needLogin) setNeedLogin(true);
      })
      .finally(() => {
        if (seq === epochRef.current) {
          setLoadingNewer(false);
          newerInflightRef.current = false;
        }
      });
  }, [fetchMessages]);

  // —— 单条更新事件落地(长轮询驱动;事件形状见服务端 routes/telegram.js
  //    /updates:new/edit 带 id+message、delete 带 ids、peer 带部分计数) ——
  // new/edit:message 非空走 mergeMessages 按 id 覆盖(编辑即应用;窗口外
  // id 的消息也会按序插入——数据面正确,与 loadNewer 补页同口径);
  // message=null(服务端规范化失败)按 id 走 GET /message 强拉一次(静默,
  // 不算失败重试——是事件载荷缺失的补全通道,拉不到等下一轮/翻页自然补)。
  // delete:按 ids 从 items 移除。peer:部分计数补进 peer 头。首屏未就绪
  // (items/peer 为 null)时跳过消息与计数落地——重载中的整页取数自然带来
  // 最新状态,往骨架上打补丁只会制造首帧闪烁。锚定两跳/乐观存根逻辑不因
  // 事件面重构(存根负 id 与事件正 id 天然不相撞)
  const applyUpdateEvent = useCallback((ev) => {
    if (!ev || !aliveRef.current) return;
    if (ev.peer !== peerKeyRef.current) return; // 定向事件按会话防御校验
    if (ev.type === 'new' || ev.type === 'edit') {
      if (ev.message) {
        if (itemsRef.current == null) return; // 首屏未就绪:整页重载会带来
        // replacesId(TDLib send 回执重映射):先摘临时 id 副本再合并最终 id,
        // 防自发消息在时间线双显(TD 引擎,mtproto 无此键不触达)
        setItems((prev) => (prev == null ? prev : mergeMessages(dropReplaced(prev, ev.replacesId), [ev.message])));
        return;
      }
      const id = Math.floor(Number(ev.id)) || 0;
      if (id > 0) {
        api('telegram', 'message', { peer: peerKeyRef.current, id })
          .then((res) => {
            if (!aliveRef.current || itemsRef.current == null) return;
            if (res && res.message) {
              setItems((prev) => (prev == null ? prev : mergeMessages(prev, [res.message])));
            }
          })
          .catch(() => { /* 静默:补全通道失败不重试,下一轮事件/翻页自然补 */ });
      }
      return;
    }
    if (ev.type === 'delete') {
      setItems((prev) => dropIds(prev, ev.ids));
      return;
    }
    if (ev.type === 'peer') {
      setPeer((prev) => {
        if (!prev) return prev; // 头未就绪:首屏/拉新响应带全量
        const patch = {};
        for (const k of PEER_PATCH_KEYS) {
          if (ev[k] !== undefined) patch[k] = ev[k];
        }
        return Object.keys(patch).length ? { ...prev, ...patch } : prev;
      });
      return;
    }
    if (ev.type === 'typing') {
      // typing 事件:{peer,type,senders:[{id,name}]}——senders 为全量在打者
      // (服务端增量重算,客户端一次拿到全量;服务端按 peer×sender 5s TTL 自
      // 清)。本 hook 转存 + 5s 本地兜底清零(末次取消事件丢失时不悬挂「正在
      // 输入」)。MTProto 引擎事件层不产 typing(updates.js 不冒充契约外事件),
      // 缺省引擎下该分支不触达,typingSenders 恒空,旧调用方零影响。
      const list = Array.isArray(ev.senders)
        ? ev.senders
          .filter((s) => s && typeof s === 'object')
          .map((s) => ({ id: String(s.id == null ? '' : s.id), name: String(s.name == null ? '' : s.name) }))
        : [];
      setTypingSenders(list);
      if (typingTimerRef.current != null) {
        clearTimeout(typingTimerRef.current);
        typingTimerRef.current = null;
      }
      if (list.length) {
        typingTimerRef.current = setTimeout(() => {
          typingTimerRef.current = null;
          setTypingSenders([]);
        }, TYPING_TTL_MS);
      }
      return;
    }
    // 其余 type 不冒充处理(服务端契约外):翻页与 peer 头自然取到
  }, []);

  // —— 长轮询循环单轮:GET /updates?peer&seq&wait=20000(客户端超时 30s) ——
  // 响应 {events,seq}:事件按序落地、游标推进到该会话最新事件序号,立即发
  // 下一轮(长轮询常态节奏:等待到时零间隙续轮,事件到达即刻续轮);
  // {reset:true,seq}:游标错位(环丢弃/账号纪元重置)——对齐到返回值并做
  // 一次 loadInitial 整页重拉(reset 无 events,重载页自然带来真相),随后
  // 续轮。失败一律静默(不置 err、不置 needLogin,页面错误面只归取数动作),
  // 按 POLL_ERROR_MS 间歇后再发;stopPolling 中止(signal abort)后不再续轮。
  // 单链在途锁(busy):换会话时 effect 清理掐断在途请求、effect 体又立即
  // 重起新轮,旧请求的迟到 catch 若再排续轮定时器会分叉出第二条并发轮询链
  // ——busy 保证任一时刻至多一条链在跑
  const pollTick = useCallback(() => {
    const st = pollRef.current;
    if (!st.on || !aliveRef.current) return;
    if (st.busy) return; // 一轮在途/待续:不叠加(单链续轮)
    const p = peerKeyRef.current;
    if (!p) {
      st.on = false; // 无会话标识:循环静止(页面换会话后会再 start)
      return;
    }
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    st.ctl = ctl;
    st.busy = true;
    api(
      'telegram',
      'updates',
      { peer: p, seq: st.seq, wait: LONGPOLL_WAIT_MS },
      { timeoutMs: LONGPOLL_TIMEOUT_MS, signal: ctl ? ctl.signal : undefined }
    )
      .then((res) => {
        st.busy = false;
        st.ctl = null;
        if (!st.on || !aliveRef.current) return;
        if (res && res.reset) {
          st.seq = Math.max(0, Math.floor(Number(res.seq)) || 0);
          // 整页重拉(锚定决策链重走);期间到达的事件走 else 分支的冻结
          // 口径兜底(游标不推进、就绪后重放,不丢)
          loadInitial();
        } else {
          const events = Array.isArray(res && res.events) ? res.events : [];
          // 首屏/重载未就绪(items==null 且 loadInitial 在途):事件不落地、
          // 游标不推进——留在服务端事件环,列表就绪后下一轮按未推进的游标
          // 原样重放(mergeMessages 按 id 幂等,重复投递无副作用)。若在此
          // 窗口推进游标,重拉取数又早于消息在服务端可见(时间竞态),窗口
          // 内消息既不在重拉结果里也不会再由事件补——时间线空洞,直到手动
          // 刷新/拉新才补齐。就绪探测走短延时机而非立即续轮,避免就绪前
          // 密集空转(每轮都带回同一批事件)。重载失败(items 仍为 null 但
          // 已无在途)不冻结:跳过+推进的原口径,页面重试的整页重拉自然
          // 带来服务端最新真相。
          if (events.length && itemsRef.current == null && initialInflightRef.current) {
            st.timer = setTimeout(() => {
              st.timer = null;
              pollTickRef.current();
            }, RELOAD_REPOLL_MS);
            return;
          }
          for (const ev of events) applyUpdateEvent(ev);
          st.seq = Math.floor(Number(res && res.seq)) || 0; // 会话最新事件序号 = 下一轮游标(0 = 尚无事件)
        }
        pollTickRef.current(); // 立即续轮(内部自带 on/alive/busy 门)
      })
      .catch(() => {
        st.busy = false;
        st.ctl = null;
        if (!st.on || !aliveRef.current) return;
        // 静默间歇续轮:非失败自动重试(那是即时再打同一请求),是轮询循环
        // 自身的节律——与旧版 20s 定时轮询失败等下一拍完全同拍,防请求风暴
        st.timer = setTimeout(() => {
          st.timer = null;
          pollTickRef.current();
        }, POLL_ERROR_MS);
      });
  }, [loadInitial, applyUpdateEvent]);
  pollTickRef.current = pollTick; // render 期同步稳定引用(基线同款手法)

  // —— 长轮询启停(页面驱动:聚焦 start / 失焦 stop;幂等) ——
  // stop 掐断在途长轮询 + 清续轮定时器;换会话时 effect 清理只掐在途与游标、
  // 保持开关(页面 focus 联动跨会话自然延续,不依赖页面重调)
  const startPolling = useCallback(() => {
    const st = pollRef.current;
    if (st.on) return;
    if (!peerKeyRef.current) return; // 无会话:静止
    st.on = true;
    pollTickRef.current();
  }, []);

  const stopPolling = useCallback(() => {
    const st = pollRef.current;
    st.on = false;
    if (st.timer != null) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    if (st.ctl) {
      try { st.ctl.abort(); } catch (_e) { /* 已完成的中止无妨 */ }
      st.ctl = null;
    }
    st.busy = false; // 在途链收尾时还会再置一次;此处先放行,紧接的重 start 不被卡死
  }, []);

  // —— 本地乐观 peer patch(B2 已读修复):走 PEER_PATCH_KEYS 同一白名单,
  //     已读上报成功回调与页面共用。TDLib 引擎的 updateChatReadInbox peer
  //     事件随后会以服务端真值校正,双保险 ——
  const patchPeerLocal = useCallback((partial) => {
    if (!partial || typeof partial !== 'object') return;
    setPeer((prev) => {
      if (!prev) return prev; // 头未就绪:整页取数自然带来
      const patch = {};
      for (const k of PEER_PATCH_KEYS) {
        if (partial[k] !== undefined) patch[k] = partial[k];
      }
      return Object.keys(patch).length ? { ...prev, ...patch } : prev;
    });
  }, []);

  // —— 已读上报(POST /read):有界去抖(约 2s),只进不退 ——
  // 页面在 viewability 联动里喂「当前最新可见消息 id」;窗口外立即上报,
  // 窗口内起一个尾随定时器到点补报(不被后续喂值无限顺延——有界);只报有
  // 推进的值。失败 console 记录不重试(尽力而为);卸载/换会话由 effect 清理
  // 兜底 flush(pk 显式传参,与 writeReadPos 同款责任边界)。
  // 成功回调(B2 已读修复):本地乐观 patch peer——readInboxMaxId=maxId、
  // unreadCount 扣减已载窗口内 id∈(旧 readInboxMaxId, maxId] 的来向(非
  // out)消息数,右下角 FAB 徽标即时收敛;旧 readInboxMaxId 缺失时只推进
  // 水位不扣减(计数真值交由服务端 peer 事件,不猜)
  const sendReadReport = useCallback(
    (pk) => {
      const r = reportRef.current;
      if (!pk || !(r.max > 0)) return;
      const maxId = r.max;
      r.at = Date.now();
      postJson('/api/telegram/read', { peer: pk, maxId })
        .then(() => {
          if (!aliveRef.current || pk !== peerKeyRef.current) return; // 迟到响应不越会话/不越生命周期
          const prev = peerRef.current;
          if (!prev) return;
          const oldRead = typeof prev.readInboxMaxId === 'number' ? prev.readInboxMaxId : null;
          if (oldRead != null && maxId <= oldRead) return; // 本地水位已在前:无需 patch(不回退)
          const patch = { readInboxMaxId: maxId };
          if (oldRead != null && typeof prev.unreadCount === 'number') {
            let seen = 0;
            for (const m of itemsRef.current || []) {
              const id = m && typeof m.id === 'number' ? m.id : 0;
              if (id > oldRead && id <= maxId && !m.out) seen += 1;
            }
            patch.unreadCount = Math.max(0, Math.floor(prev.unreadCount) - seen);
          }
          patchPeerLocal(patch);
        })
        .catch((e) => {
          console.warn('[telegram/chat] 已读上报失败(忽略):', e && e.message ? e.message : e);
        });
    },
    [patchPeerLocal]
  );

  const reportRead = useCallback(
    (maxId) => {
      const n = Math.floor(Number(maxId)) || 0;
      if (n <= 0) return;
      const r = reportRef.current;
      if (n <= r.max) return; // 只进不退
      r.max = n;
      const now = Date.now();
      if (now - r.at >= READ_REPORT_MS) {
        sendReadReport(peerKeyRef.current);
      } else if (r.timer == null) {
        r.timer = setTimeout(() => {
          r.timer = null;
          sendReadReport(peerKeyRef.current);
        }, READ_REPORT_MS);
      }
    },
    [sendReadReport]
  );

  // —— 发送(text 会 trim,空串/不可发对话直接 reject,不插存根) ——
  // 乐观插入:存根恒落 data[0](最新=视觉底部);成功原位替换为服务端消息,
  // 失败标记 __status='failed' 供 retrySend。会话中途被切换(世代号变了)时
  // 服务端可能已实际发出——UI 不再回填(如实:不假装失败也不重复插入)
  const send = useCallback(async (text, replyTo) => {
    const t = String(text == null ? '' : text).trim();
    if (!t) throw new Error('消息内容为空');
    const p = peerKeyRef.current;
    if (!p) throw new Error('缺少对话标识');
    const pe = peerRef.current;
    if (pe && pe.canSend === false) throw new Error('该对话不支持发送消息');
    const seq = epochRef.current;
    const localId = nextLocalId();
    const stub = makeStub(p, localId, t, replyTo);
    setItems((prev) => [stub].concat(prev || []));
    try {
      const rid = stub.replyTo ? stub.replyTo.msgId : 0;
      const res = await postJson('/api/telegram/send', {
        peer: p,
        text: t,
        replyTo: rid > 0 ? rid : undefined,
      });
      if (!aliveRef.current || seq !== epochRef.current) return null;
      const msg = normalizeMsg(res && res.message);
      if (!msg) throw new Error('服务端未返回消息');
      if (!(msg.id > 0)) {
        // id:0 最小回执 = 上游已接受但回执缺 id(服务端契约:发送已成功,绝不
        // 可重发)。不标 failed(重试即重复发送):移除乐观存根即可,消息本体
        // 由后续 loadNewer/轮询补显
        setItems((prev) => (prev || []).filter((m) => !(m && m.id === localId)));
        return msg;
      }
      setItems((prev) => mergeMessages((prev || []).filter((m) => !(m && m.id === localId)), [msg]));
      return msg;
    } catch (e) {
      if (aliveRef.current && seq === epochRef.current) {
        setItems((prev) => markStub(prev, localId, 'failed'));
      }
      throw toCnError(e);
    }
  }, []);

  // —— 重发失败的乐观消息(按 localId 精确命中,仅 failed 态可重发) ——
  // 单条在途锁防双击重复发送;原文/回复目标取自存根自身
  const retrySend = useCallback(async (localId) => {
    const lid = Math.floor(Number(localId)) || 0;
    if (!(lid < 0)) return;
    if (retryInflightRef.current.has(lid)) return;
    const cur = itemsRef.current || [];
    const stub = cur.find((m) => m && m.id === lid);
    if (!stub || stub.__status !== 'failed') return;
    const p = peerKeyRef.current;
    if (!p) return;
    retryInflightRef.current.add(lid);
    const seq = epochRef.current;
    setItems((prev) => markStub(prev, lid, 'pending'));
    try {
      let rid = 0;
      if (stub.replyTo && stub.replyTo.msgId != null) rid = Math.floor(Number(stub.replyTo.msgId)) || 0;
      const res = await postJson('/api/telegram/send', {
        peer: p,
        text: stub.text,
        replyTo: rid > 0 ? rid : undefined,
      });
      if (!aliveRef.current || seq !== epochRef.current) return null;
      const msg = normalizeMsg(res && res.message);
      if (!msg) throw new Error('服务端未返回消息');
      if (!(msg.id > 0)) {
        // id:0 最小回执:同 send——已成功不可重发,移除存根,消息由拉新补显
        setItems((prev) => (prev || []).filter((m) => !(m && m.id === lid)));
        return msg;
      }
      setItems((prev) => mergeMessages((prev || []).filter((m) => !(m && m.id === lid)), [msg]));
      return msg;
    } catch (e) {
      if (aliveRef.current && seq === epochRef.current) {
        setItems((prev) => markStub(prev, lid, 'failed'));
      }
      throw toCnError(e);
    } finally {
      retryInflightRef.current.delete(lid);
    }
  }, []);

  // —— 单条原位更新(bot 回调/投票后页面喂回服务端返回的完整消息) ——
  // 按 id 精确命中替换;不在当前已载窗口的消息忽略(未拉到的无从原位更新)
  const replaceMessage = useCallback((msg) => {
    const n = normalizeMsg(msg);
    if (!n || !(n.id > 0)) return;
    setItems((prev) => {
      if (!prev) return prev;
      const i = prev.findIndex((m) => m && m.id === n.id);
      if (i < 0) return prev;
      const next = prev.slice();
      next[i] = n; // id 不变 → 降序位置不变,严格原位替换
      return next;
    });
  }, []);

  // —— 存根丢弃(蓝图 §5.1-B cancelSend 的数据面):仅负 id 乐观存根可丢,
  //     真实消息(正 id)一律不动——撤回走服务端 delete 通道(事件回流幂等)。
  //     未命中/空列表原样返回引用,不给 React 制造无谓的新数组 ——
  const discardStub = useCallback((localId) => {
    const lid = Math.floor(Number(localId)) || 0;
    if (!(lid < 0)) return;
    setItems((prev) => {
      if (!prev || !prev.length) return prev;
      const next = prev.filter((m) => !(m && m.id === lid));
      return next.length === prev.length ? prev : next;
    });
  }, []);

  // —— 阅读位置落盘(pk 显式传参:卸载 flush 时 render 期 ref 可能已指向
  // 新会话,必须用 effect 闭包捕获的旧键)——只写有推进的值(max>saved)
  const writeReadPos = useCallback((pk) => {
    const r = readRef.current;
    if (pk && r.max > 0 && r.max > r.saved) {
      r.saved = r.max;
      r.at = Date.now();
      setReadPos(pk, r.max); // tg-read 串行链,永不 reject
    }
  }, []);

  // —— 阅读位置联动入口:页面滚动时喂「最新可见消息 id」 ——
  // 只进不退(inverted 列表乱序 viewability 事件天然被吸收)+ 1s 节流:
  // 窗口外立即写,窗口内起一个尾随定时器到点补写;卸载/换会话兜底 flush。
  // 未读边界推进(B2 已读修复):阅读位(已记录与本次喂值的较大者)越过
  // unreadAnchorId 即清界——buildRows 的「未读消息」分隔线随 state 消失;
  // 判据用较大者,重载后已越过新锚点时,喂值未推进的路径也能即时收线
  const onVisible = useCallback(
    (msgId) => {
      const n = Math.floor(Number(msgId)) || 0;
      if (n <= 0) return;
      const r = readRef.current;
      const anchor = unreadAnchorIdRef.current;
      if (anchor > 0 && Math.max(r.max, n) > anchor) setUnreadAnchorId(0);
      if (n <= r.max) return;
      r.max = n;
      const now = Date.now();
      if (now - r.at >= READ_WRITE_MS) {
        writeReadPos(peerKeyRef.current);
      } else if (r.timer == null) {
        r.timer = setTimeout(() => {
          r.timer = null;
          writeReadPos(peerKeyRef.current);
        }, READ_WRITE_MS);
      }
    },
    [writeReadPos]
  );

  // 挂载 / peerKey / opts.anchor 变化:自动首屏锚定。async IIFE 首句
  // await Promise.resolve() 做微任务屏障——后续一切 setState 必在异步续体,
  // effect 同步帧零 setState(React Compiler 红线);cleanup 作废在途 + 阅读位
  // 置/已读上报兜底 flush(pk 用闭包捕获的本周期键)+ 游标复位供下一周期;
  // 长轮询随会话切换掐在途 + 游标归零(开关保持——页面 focus 联动跨会话延续,
  // 不依赖页面重调 start),真实卸载后 ref 随组件消亡自然静止
  useEffect(() => {
    aliveRef.current = true; // 严格模式双执行时复活(真实卸载后保持 false)
    const pk = peerKey; // 本周期对话键(cleanup 闭包捕获,防 ref 已指向新会话)
    let dead = false; // 本周期异步链路作废标志
    if (pk) {
      (async () => {
        await Promise.resolve(); // 微任务屏障(Compiler 红线,见上)
        if (dead || !aliveRef.current) return;
        loadInitial(); // 不传参 → 走 深链锚/本地位置/readInboxMaxId/最新页 决策链
      })();
      // 换会话重挂时续上长轮询(游标已归零,seq=0 起步:服务端环尾重放幂等,
      // 错位由 reset 自愈);首挂时开关为关,零副作用
      if (pollRef.current.on) pollTickRef.current();
    }
    return () => {
      dead = true;
      aliveRef.current = false;
      epochRef.current++; // 作废一切在途响应
      // 长轮询:掐断旧会话在途请求 + 清续轮定时器 + 游标归零(on 保持,见上;
      // busy 一并放行,新周期 effect 体可立即重起新链;旧请求迟到的 catch 在
      // busy 门下最多多排一个无害的续轮定时器,绝不分叉出第二条链)
      const pst = pollRef.current;
      if (pst.timer != null) {
        clearTimeout(pst.timer);
        pst.timer = null;
      }
      if (pst.ctl) {
        try { pst.ctl.abort(); } catch (_e) { /* 已完成的中止无妨 */ }
        pst.ctl = null;
      }
      pst.seq = 0;
      pst.busy = false;
      // typing 兜底定时器随周期清理;typing 态本身清零(卸载时 setState 为
      // 无害 no-op,换会话时防旧会话的「正在输入」串台)
      if (typingTimerRef.current != null) {
        clearTimeout(typingTimerRef.current);
        typingTimerRef.current = null;
      }
      setTypingSenders([]);
      const r = readRef.current;
      if (r.timer != null) {
        clearTimeout(r.timer);
        r.timer = null;
      }
      writeReadPos(pk); // 卸载/换会话兜底:把最后看到的位次落盘
      // 已读上报兜底:清尾随定时器 + flush 旧会话最后看到的位次
      const rr = reportRef.current;
      if (rr.timer != null) {
        clearTimeout(rr.timer);
        rr.timer = null;
      }
      sendReadReport(pk);
      reportRef.current = { max: 0, at: 0, timer: null };
      readRef.current = { max: 0, at: 0, saved: 0, timer: null };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerKey, anchorOpt]);

  const loading = items == null && !err && !!peerKey; // 首屏加载中(骨架屏)

  return {
    // 数据面 -------------------------------------------------------------
    items,          // 消息数组(新→旧;含乐观存根:负 id + __status)或 null(首屏未就绪)
    peer,           // null | { peerKey,name,kind,avatar,canSend,unreadCount,readInboxMaxId,topMessage}(peer 事件可再补 readOutboxMaxId/unreadMark)
    // 状态面 -------------------------------------------------------------
    loading,        // 首屏加载中(骨架屏)
    loadingOlder,   // 视觉顶部取更旧一页中
    loadingNewer,   // 拉新中
    err,            // 最近一次取数失败(中文;加载更多失败保留列表),绝不自动重试
    needLogin,      // err 是否因未登录(tg-api 通道 Error.needLogin 精确透传 + 文案启发式兜底)
    hasOlder,       // 还有更旧历史可翻(loadOlder 的门禁)
    hasNewer,       // 最新端之上是否还有新消息(首屏 around/loadNewer 响应维护,older 不回写;仅提示用,loadNewer 不受其门禁)
    anchorId,       // 本次首屏锚点消息 id(0=最新页无锚;页面 scrollTo 定位用)
    unreadAnchorId, // 未读边界:id>该值的消息为未读,分隔线插在其前(0=不渲染)
    // 动作面 -------------------------------------------------------------
    loadInitial,    // (anchor?) 首屏锚定/整体重试/手动刷新
    loadOlder,      // 视觉顶部取更旧一页(失败后再调即重试)
    loadNewer,      // 拉新(手动「检查新消息/跳到最新」入口,恒可调)
    send,           // (text, replyTo?) 乐观发送;成功 resolve 服务端消息,失败 reject 且存根标 failed
    retrySend,      // (localId) 重发失败的乐观消息;语义同 send
    replaceMessage, // (msg) 按 id 原位替换单条(bot 回调/投票后)
    discardStub,    // (localId) 丢弃一条乐观存根(仅负 id;长按菜单「取消发送」数据面)
    onVisible,      // (msgId) 滚动时喂最新可见消息 id(内部只进不退 + 1s 节流落盘)
    typingSenders,  // [{id,name}] 正在输入者(全量;MTProto 引擎恒空数组——无 typing 事件面)
    // 实时事件面(页面驱动)-----------------------------------------------
    startPolling,   // ()  启动长轮询(GET /updates 维护 seq;幂等;聚焦时调)
    stopPolling,    // ()  停止长轮询并掐断在途请求(幂等;失焦/离开时调)
    reportRead,     // (maxId) 已读上报(POST /read;有界去抖约 2s + 只进不退;成功回调本地乐观 patch peer)
    patchPeerLocal, // (partial) 本地乐观 peer patch(PEER_PATCH_KEYS 同一白名单;已读上报成功回调同款)
  };
}

// 注意:调用方一律按【命名导入】使用 useChatTimeline(与 use-infinite-list
// 口径一致),默认导出仅为兼容兜底
export default useChatTimeline;
