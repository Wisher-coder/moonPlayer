// ============================================================================
// scripts/test-content-state.mjs —— 内容状态机/转发纯逻辑 零依赖测试（工作流门 11）
// ----------------------------------------------------------------------------
// 覆盖（蓝图二 §6.2 门 11 契约）：
//   ① reducer 全动作纯函数性与不可变更新（深度冻结 fixture,变更动作断言新引用）；
//   ② serialize/parse 往返（全字段/空态/单字段态）；
//   ③ parse 失败回退（主包损坏仍救出 draft.text;版本不符降级同口径）；
//   ④ store LRU 200 淘汰与串行链（内存 KV 注入,可注入时钟;store.js 的
//      AsyncStorage 零顶层 import,runner 不加载任何 RN 模块）；
//   ⑤ forwardAbilities 真值表 + buildForwardPayload 校验/组装 + sentTargetCount；
//   ⑥ messageAbilities/dialogAbilities 判定矩阵（§5.1-B 口径）——实现文件
//      telegram-actions/abilities.js 归并行 worker M4:在位则加载实测,未落地则
//      显式 skip 并注明原因（绝不冒充通过）。
// runner 模式（蓝图二 §6.2）：node:test + assert/strict,零 npm 依赖;不连真网、
// 不触真上游;不 import AsyncStorage（store 抽象层注入内存 KV 测）。
// loader 说明（「loader 强制 module 格式」）：app/package.json 无 "type":"module"，
// Node 缺省把 .js 当 CJS——被测源码是 ESM。此处用 module.register 挂载内联
// loader（data: URL,零独立文件）,load 钩子把 /app/src/ 下 .js 强制按 ESM 解析
// （先 next 拿源码再覆盖 format）。挂载必须先于被测对象的 import。
// 用法：node MoontentRN/app/scripts/test-content-state.mjs（exit 0=全绿）
// ============================================================================
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');
const SRC_ROOT = path.join(APP_ROOT, 'src');

// ---- 内联 loader（data: URL）：/app/src/ 下 .js 强制 ESM（见文件头说明）----
// 直接读源码返回 format:'module'（不走 next 的缺省装载——避免 Node 对无
// "type":"module" 的 .js 先做 CJS 探测产生的 MODULE_TYPELESS 告警与二次解析）
const LOADER_SRC = [
  "import { readFileSync } from 'node:fs';",
  'export async function load(url, context, next) {',
  "  if (url.startsWith('file:') && url.includes('/app/src/') && url.endsWith('.js')) {",
  "    return { format: 'module', shortCircuit: true, source: readFileSync(new URL(url)) };",
  '  }',
  '  return next(url, context);',
  '}',
].join('\n');
register('data:text/javascript,' + encodeURIComponent(LOADER_SRC), import.meta.url);

// ---- 挂载 loader 之后才能 import 被测对象（顺序红线,同 test-delegation.mjs）----
const stateMod = await import('../src/lib/telegram-content-state/state.js');
const reducerMod = await import('../src/lib/telegram-content-state/reducer.js');
const serializeMod = await import('../src/lib/telegram-content-state/serialize.js');
const storeMod = await import('../src/lib/telegram-content-state/store.js');
const forwardMod = await import('../src/lib/telegram-forward.js');

const {
  CSTATE_VERSION, emptyContentState, normalizeDraft, sanitizeContentState,
} = stateMod;
const { reduceState } = reducerMod;
const { serializeState, parseState } = serializeMod;
const { createContentStateStore, CSTATE_STORAGE_KEY, CSTATE_MAX_PEERS, loadState, saveState } = storeMod;
const { forwardAbilities, buildForwardPayload, sentTargetCount, isPeerKey } = forwardMod;

// ---- fixture 工具 ----
// 深度冻结：reducer 改入参即抛 TypeError（ESM 严格模式）——不可变更新的硬断言
function deepFreeze(o) {
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) deepFreeze(o[k]);
    Object.freeze(o);
  }
  return o;
}

// 全字段状态（v1 契约形状,蓝图二 §5.2）
function fullState() {
  return {
    v: 1,
    draft: { text: '还没发出去的草稿', updatedAt: 1700000000000 },
    reply: { msgId: 11, name: '张三', snippet: '被引用的消息摘要' },
    editing: { msgId: 22 },
    selection: [3, 7, 9],
    forward: { ids: [3, 7], hideNames: true, hideCaptions: false },
    scroll: { anchorMsgId: 15 },
  };
}

// 全字段动作集（① 用:逐动作跑纯函数性;载荷覆盖正常/边界两档）。
// expectSameRef:防御忽略型动作按契约返回原引用（不产新对象）,断言分档用。
const ACTION_CASES = [
  { action: { type: 'setDraft', text: '新草稿', at: 123 }, desc: 'setDraft 带显式时间戳' },
  { action: { type: 'setDraft', text: '', at: 123 }, desc: 'setDraft 空文本=清草稿' },
  { action: { type: 'clearDraft' }, desc: 'clearDraft' },
  { action: { type: 'setReply', msgId: 5, name: '李四', snippet: '摘要' }, desc: 'setReply' },
  { action: { type: 'setReply', msgId: -1 }, desc: 'setReply 非法 id(防御忽略)', expectSameRef: true },
  { action: { type: 'clearReply' }, desc: 'clearReply' },
  { action: { type: 'beginEdit', msgId: 8 }, desc: 'beginEdit' },
  { action: { type: 'beginEdit', msgId: 0 }, desc: 'beginEdit 非法 id(防御忽略)', expectSameRef: true },
  { action: { type: 'cancelEdit' }, desc: 'cancelEdit' },
  { action: { type: 'toggleSelect', msgId: 4 }, desc: 'toggleSelect 增选' },
  { action: { type: 'toggleSelect', msgId: 3 }, desc: 'toggleSelect 去选' },
  { action: { type: 'toggleSelect', msgId: -3 }, desc: 'toggleSelect 负 id(存根不进多选)', expectSameRef: true },
  { action: { type: 'selectAll', ids: [9, 2, 5, 2] }, desc: 'selectAll 去重升序' },
  { action: { type: 'selectAll', ids: [] }, desc: 'selectAll 空窗=清空' },
  { action: { type: 'clearSelection' }, desc: 'clearSelection' },
  { action: { type: 'setForward', ids: [2, 1], hideNames: true }, desc: 'setForward' },
  { action: { type: 'setForward', ids: [] }, desc: 'setForward 空=清转发' },
  { action: { type: 'updateForwardOptions', hideCaptions: true }, desc: 'updateForwardOptions' },
  { action: { type: 'updateForwardOptions', hideNames: false }, desc: 'updateForwardOptions 部分键' },
  { action: { type: 'clearForward' }, desc: 'clearForward' },
  { action: { type: 'setScrollAnchor', anchorMsgId: 42 }, desc: 'setScrollAnchor' },
  { action: { type: 'setScrollAnchor', anchorMsgId: 0 }, desc: 'setScrollAnchor 0=清除' },
  { action: { type: 'hydrate', state: fullState() }, desc: 'hydrate 整包并入' },
  { action: { type: 'hydrate', state: null }, desc: 'hydrate 空包=归零' },
  { action: { type: '未知动作' }, desc: '未知动作=原引用返回', expectSameRef: true },
];

// ---- 内存 KV 适配器（④ 的注入口;可注入第 N 次写入失败模拟存储不可用）----
function makeKV() {
  const backing = new Map();
  let setCalls = 0;
  let failOnCall = 0; // 0=不注入;>0=第 N 次 setItem 抛错(随后恢复)
  return {
    backing,
    failOnCallNth(n) { failOnCall = n; },
    async getItem(k) { return backing.has(k) ? backing.get(k) : null; },
    async setItem(k, v) {
      setCalls += 1;
      if (failOnCall > 0 && setCalls === failOnCall) {
        failOnCall = 0;
        throw new Error('注入的存储写入失败');
      }
      backing.set(k, String(v));
    },
  };
}

// 确定性时钟:每次取值自增,保证 LRU 淘汰次序可断言
function makeClock() {
  let tick = 0;
  return () => ++tick;
}

// ============================================================================
describe('① reducer 纯函数性与不可变更新', () => {
  it('全动作 × 全字段基座:输入深度冻结不抛（无变异）,两次执行结果一致,变更动作产新引用', () => {
    for (const c of ACTION_CASES) {
      const base = deepFreeze(fullState());
      const out1 = reduceState(base, c.action);
      const out2 = reduceState(base, c.action);
      assert.deepEqual(out1, out2, `${c.desc}: 同输入两次执行结果应一致`);
      assert.deepEqual(
        JSON.parse(JSON.stringify(base)), fullState(),
        `${c.desc}: 输入状态不得被改写（冻结对象被变异会直接抛错,浅拷贝对照兜底）`,
      );
      if (c.expectSameRef) {
        assert.strictEqual(out1, base, `${c.desc}: 防御忽略动作应按契约返回原引用`);
      } else {
        assert.notStrictEqual(out1, base, `${c.desc}: 变更动作应返回新对象（不可变更新）`);
      }
    }
  });

  it('空状态起步:state 非法时从空状态出发且动作仍可用', () => {
    const out = reduceState(null, { type: 'setDraft', text: 'hi', at: 5 });
    assert.equal(out.draft && out.draft.text, 'hi');
    assert.equal(out.v, CSTATE_VERSION);
    assert.deepEqual(Object.keys(out).sort(), ['draft', 'editing', 'forward', 'reply', 'scroll', 'selection', 'v']);
  });

  it('selection 语义:升序去重/删空归 null/负 id 存根拒收', () => {
    let s = reduceState(emptyContentState(), { type: 'toggleSelect', msgId: 5 });
    assert.deepEqual(s.selection, [5]);
    s = reduceState(s, { type: 'toggleSelect', msgId: 2 });
    s = reduceState(s, { type: 'toggleSelect', msgId: 9 });
    assert.deepEqual(s.selection, [2, 5, 9]);
    s = reduceState(s, { type: 'toggleSelect', msgId: 2 });
    assert.deepEqual(s.selection, [5, 9]);
    s = reduceState(s, { type: 'toggleSelect', msgId: 9 });
    s = reduceState(s, { type: 'toggleSelect', msgId: 5 });
    assert.equal(s.selection, null, '删空后归 null');
    s = reduceState(s, { type: 'selectAll', ids: [-1, 0, 4, '6', 4] });
    assert.deepEqual(s.selection, [4, 6], 'selectAll 过滤非法并去重升序');
  });

  it('forward 语义:setForward 重置选项/updateForwardOptions 只补出现过的键/无会话不凭空造', () => {
    let s = reduceState(emptyContentState(), { type: 'setForward', ids: [2, 1], hideNames: true, hideCaptions: true });
    assert.deepEqual(s.forward, { ids: [1, 2], hideNames: true, hideCaptions: true });
    s = reduceState(s, { type: 'updateForwardOptions', hideCaptions: false });
    assert.equal(s.forward.hideNames, true, '未出现的键保持');
    assert.equal(s.forward.hideCaptions, false, '出现的键更新');
    s = reduceState(s, { type: 'setForward', ids: [3] });
    assert.deepEqual(s.forward, { ids: [3], hideNames: false, hideCaptions: false }, '重开会话选项复位');
    s = reduceState(s, { type: 'clearForward' });
    s = reduceState(s, { type: 'updateForwardOptions', hideNames: true });
    assert.equal(s.forward, null, '无转发会话时选项动作无效');
  });

  it('setDraft 时间戳:显式 at 生效;缺省兜底 Date.now（runner 断言一律显式传 at 保纯）', () => {
    const s = reduceState(emptyContentState(), { type: 'setDraft', text: 'x', at: 999 });
    assert.equal(s.draft.updatedAt, 999);
  });
});

describe('② serialize/parse 往返', () => {
  it('全字段状态:serialize → parse 深等（v1 前缀 JSON）', () => {
    const s = fullState();
    const text = serializeState(s);
    assert.ok(text.startsWith('{"v":1,'), '输出应为 v1 前缀 JSON');
    assert.deepEqual(parseState(text), sanitizeContentState(s));
  });

  it('空状态/单字段态:往返稳定;字段缺失补 null', () => {
    assert.deepEqual(parseState(serializeState(emptyContentState())), emptyContentState());
    const partial = parseState(serializeState({ v: 1, draft: { text: '只有草稿', updatedAt: 7 } }));
    assert.deepEqual(partial, {
      v: 1,
      draft: { text: '只有草稿', updatedAt: 7 },
      reply: null, editing: null, selection: null, forward: null, scroll: null,
    });
  });

  it('脏输入序列化:非对象/数组/带垃圾字段都落成干净 v1 串', () => {
    for (const bad of [null, undefined, 42, 'str', [], { v: 1, selection: '不是数组', draft: 7 }]) {
      const text = serializeState(bad);
      const back = parseState(text);
      assert.deepEqual(Object.keys(back).sort(), ['draft', 'editing', 'forward', 'reply', 'scroll', 'selection', 'v']);
    }
    // 带垃圾字段:合法字段保留,垃圾字段丢弃
    const back = parseState(serializeState({ v: 1, draft: { text: '保留', updatedAt: 3 }, junk: { x: 1 }, selection: [0, 2, '3'] }));
    assert.equal(back.draft.text, '保留');
    assert.deepEqual(back.selection, [2, 3]);
    assert.equal('junk' in back, false);
  });

  it('normalizeDraft 单元:非串文本/空文本归 null', () => {
    assert.equal(normalizeDraft({ text: '' }), null);
    assert.equal(normalizeDraft({ text: 42 }), null);
    assert.deepEqual(normalizeDraft({ text: 'ok' }), { text: 'ok', updatedAt: 0 });
  });
});

describe('③ parse 失败回退（主包损坏仍救 draft.text）', () => {
  it('主包截断损坏:正则抢救出 draft.text,其余归零', () => {
    const good = JSON.stringify(fullState());
    const corrupted = good.slice(0, good.indexOf('"reply"')) + '"reply":{"msgId":11'; // 截断+残尾
    const out = parseState(corrupted);
    assert.equal(out.v, CSTATE_VERSION);
    assert.deepEqual(out.draft, { text: '还没发出去的草稿', updatedAt: 0 }, 'draft 文本应被救出(updatedAt 允许归零)');
    assert.equal(out.reply, null);
    assert.equal(out.selection, null);
    assert.equal(out.forward, null);
  });

  it('转义文本的损坏包:draft.text 的引号/换行还原', () => {
    const s = { v: 1, draft: { text: '带"引号"和\n换行', updatedAt: 1 } };
    const corrupted = JSON.stringify(s).split('"reply"')[0] + '}';
    const out = parseState(corrupted);
    assert.equal(out.draft && out.draft.text, '带"引号"和\n换行');
  });

  it('版本不符(v≠1):只救 draft,其余归零', () => {
    const out = parseState(JSON.stringify({ v: 99, draft: { text: '未来版本的草稿', updatedAt: 5 }, selection: [1, 2] }));
    assert.deepEqual(out.draft, { text: '未来版本的草稿', updatedAt: 5 });
    assert.equal(out.selection, null);
    assert.equal(out.reply, null);
    assert.equal(out.v, CSTATE_VERSION, '输出恒为当前版本形状');
  });

  it('彻底垃圾:回空状态,永不抛', () => {
    for (const s of ['', 'not json at all', '{"draft":{"text":', '123', '"字符串"', 'null', '{"v":"x"}']) {
      const out = parseState(s);
      assert.deepEqual(Object.keys(out).sort(), ['draft', 'editing', 'forward', 'reply', 'scroll', 'selection', 'v']);
    }
    assert.deepEqual(parseState('随便一段文字'), emptyContentState());
  });
});

describe('④ store:注入内存 KV(零 AsyncStorage/RN 加载)+ LRU + 串行链', () => {
  it('store.js 可在无 RN 环境加载:默认实例绑定导出存在,AsyncStorage 零顶层 import（import 未炸即证）', () => {
    assert.equal(typeof loadState, 'function');
    assert.equal(typeof saveState, 'function');
    assert.equal(typeof createContentStateStore, 'function');
    assert.equal(CSTATE_STORAGE_KEY, 'moontent_tg_cstate');
    assert.equal(CSTATE_MAX_PEERS, 200);
  });

  it('save → load 往返:归一消毒落盘,读出完整形状;无记录回 null', async () => {
    const kv = makeKV();
    const store = createContentStateStore(kv, { now: makeClock() });
    assert.equal(await store.loadState('u1'), null, '无记录回 null');
    await store.saveState('u1', fullState());
    assert.deepEqual(await store.loadState('u1'), sanitizeContentState(fullState()));
    assert.equal(await store.loadState('u2'), null);
    assert.equal(await store.loadState(''), null, '非法 peerKey 回 null');
    const saved = JSON.parse(kv.backing.get(CSTATE_STORAGE_KEY));
    assert.deepEqual(Object.keys(saved.u1.state).sort(), ['draft', 'editing', 'forward', 'reply', 'scroll', 'selection', 'v'], '落盘形态为 v1 整包');
    assert.equal(typeof saved.u1.at, 'number', '条目带 at 时间戳（淘汰排序用）');
  });

  it('非法输入静默跳过:空 peerKey/非法 state 不落盘不抛', async () => {
    const kv = makeKV();
    const store = createContentStateStore(kv, { now: makeClock() });
    await store.saveState('', fullState());
    await store.saveState('u1', null);
    await store.saveState('u1', '不是对象');
    await store.saveState('u1', []);
    assert.equal(kv.backing.has(CSTATE_STORAGE_KEY), false, '不应有任何写入');
    await assert.doesNotReject(store.saveState('u1', { v: 1 }));
  });

  it('LRU 200:超出按 at 淘汰最旧;重写刷新 at 留驻活跃对话', async () => {
    const kv = makeKV();
    const store = createContentStateStore(kv, { now: makeClock() }); // 每次写 at 递增
    for (let i = 0; i <= CSTATE_MAX_PEERS + 4; i++) {
      await store.saveState('p' + i, { v: 1, draft: { text: 'd' + i, updatedAt: 0 } });
    }
    // 存了 205 个:循环中途 p0..p4 已按 at 逐个淘汰(每存第 201 个起淘汰一个)
    assert.equal(await store.loadState('p0'), null);
    assert.equal(await store.loadState('p4'), null);
    assert.ok(await store.loadState('p5'), 'p5 应留驻');
    // 再写第 206 个:淘汰按 at 升序取最旧者——p5 的 at=6 是当前全表最小 → p5 出局
    // （p6 的 at=7 比它大,未轮到）;p5 的留驻断言写在本轮写入之前,不受影响。
    await store.saveState('p205', { v: 1 }); // 第 206 次写 → 淘汰 at 最小者 = p5
    assert.equal(await store.loadState('p5'), null, 'p5(at=6,当前最旧)应被淘汰');
    assert.ok(await store.loadState('p6'), 'p6(at=7)应留驻');
    assert.ok(await store.loadState('p7'), 'p7 应留驻');
    assert.ok(await store.loadState('p205'), '最新写入应留驻');
  });

  it('串行链:并发 save 按提交序落盘;写失败不抛不断链,后续照常', async () => {
    const kv = makeKV();
    const store = createContentStateStore(kv, { now: makeClock() });
    // 注入第 2 次 setItem 失败（必须在三个 save 同步入队前挂好——链在微任务里跑）
    kv.failOnCallNth(2);
    const p1 = store.saveState('x', { v: 1, draft: { text: '第一笔', updatedAt: 0 } });
    const p2 = store.saveState('x', { v: 1, draft: { text: '第二笔(写失败)', updatedAt: 0 } });
    const p3 = store.saveState('x', { v: 1, draft: { text: '第三笔', updatedAt: 0 } });
    await Promise.all([p1, p2, p3]); // 均应 resolve（写失败吞掉不断链）
    assert.deepEqual((await store.loadState('x')).draft, { text: '第三笔', updatedAt: 0 });
  });

  it('盘上脏数据兜底:损坏整包/版本不符/垃圾条目 → parseState 同款降级,不抛', async () => {
    const kv = makeKV();
    const store = createContentStateStore(kv, { now: makeClock() });
    kv.backing.set(CSTATE_STORAGE_KEY, JSON.stringify({
      u9: { state: { v: 9, draft: { text: '版本不符的草稿' } }, at: 1 },
      u8: { state: '{{彻底垃圾', at: 2 },
      u7: { at: 3 }, // 无 state 字段
    }));
    const s9 = await store.loadState('u9');
    assert.deepEqual(s9.draft, { text: '版本不符的草稿', updatedAt: 0 }, '版本不符 → 只救 draft');
    assert.equal(s9.selection, null);
    const s8 = await store.loadState('u8');
    assert.equal(s8.draft, null, '救不出 → 空状态');
    assert.equal(await store.loadState('u7'), null, '无 state 字段 → null');
    // 整包损坏
    kv.backing.set(CSTATE_STORAGE_KEY, 'not-json{');
    assert.equal(await store.loadState('u9'), null);
  });

  it('存储降级:适配器缺失/读写抛错 → 读写静默,不抛', async () => {
    const none = createContentStateStore(null);
    assert.equal(await none.loadState('u1'), null);
    await assert.doesNotReject(none.saveState('u1', fullState()));

    const boom = {
      async getItem() { throw new Error('读炸了'); },
      async setItem() { throw new Error('写炸了'); },
    };
    const broken = createContentStateStore(boom);
    assert.equal(await broken.loadState('u1'), null);
    await assert.doesNotReject(broken.saveState('u1', fullState()));
  });
});

describe('⑤ 转发流纯逻辑（telegram-forward.js）', () => {
  it('forwardAbilities 真值表（蓝图二 §5.4 口径）', () => {
    const cases = [
      { name: '空选择', ids: [], msgs: [], want: { hideNames: false, hideCaptions: false } },
      { name: '仅本人消息', ids: [1], msgs: [{ id: 1, out: true }], want: { hideNames: false, hideCaptions: false } },
      { name: '混入他人消息→可隐藏名字', ids: [1, 2], msgs: [{ id: 1, out: true }, { id: 2, out: false }], want: { hideNames: true, hideCaptions: false } },
      { name: '带说明的媒体→可摘说明', ids: [3], msgs: [{ id: 3, out: true, media: { kind: 'photo' }, text: '看图' }], want: { hideNames: false, hideCaptions: true } },
      { name: '媒体无说明→不可摘', ids: [4], msgs: [{ id: 4, out: false, media: { kind: 'video' }, text: '' }], want: { hideNames: true, hideCaptions: false } },
      { name: '纯文本→不可摘说明', ids: [5], msgs: [{ id: 5, out: false, text: 'hi' }], want: { hideNames: true, hideCaptions: false } },
      { name: 'ids 过滤:未选中的他人消息不计入', ids: [1], msgs: [{ id: 1, out: true }, { id: 2, out: false, media: { kind: 'photo' }, text: 'x' }], want: { hideNames: false, hideCaptions: false } },
      { name: 'ids 缺省=全部 msgs', ids: null, msgs: [{ id: 1, out: false, media: { kind: 'photo' }, text: 'x' }], want: { hideNames: true, hideCaptions: true } },
      { name: '垃圾输入防御', ids: undefined, msgs: null, want: { hideNames: false, hideCaptions: false } },
    ];
    for (const c of cases) {
      assert.deepEqual(forwardAbilities(c.ids, c.msgs), c.want, `forwardAbilities: ${c.name}`);
    }
  });

  it('buildForwardPayload:组装/去重/升序/布尔归一', () => {
    assert.deepEqual(
      buildForwardPayload({ peer: 'u12', toPeerIds: ['saved', 'c5', 'saved'], ids: [9, 3, 9, 0, -1], opts: { hideNames: 1 } }),
      { peer: 'u12', toPeerIds: ['saved', 'c5'], messageIds: [3, 9], hideNames: true, hideCaptions: false, silent: false },
    );
    assert.equal(isPeerKey('c5'), true);
    assert.equal(isPeerKey('saved'), true);
    assert.equal(isPeerKey('x5'), false);
    assert.equal(isPeerKey(''), false);
  });

  it('buildForwardPayload:防御校验抛中文 Error(前置 400 口径,绝不发半截请求)', () => {
    assert.throws(() => buildForwardPayload({ peer: '', toPeerIds: ['u1'], ids: [1] }), /转发来源会话无效/);
    assert.throws(() => buildForwardPayload({ peer: 'zz', toPeerIds: ['u1'], ids: [1] }), /转发来源会话无效/);
    assert.throws(() => buildForwardPayload({ peer: 'u1', toPeerIds: [], ids: [1] }), /请先选择要转发到的对话/);
    assert.throws(() => buildForwardPayload({ peer: 'u1', toPeerIds: ['bad-key'], ids: [1] }), /请先选择要转发到的对话/);
    assert.throws(() => buildForwardPayload({ peer: 'u1', toPeerIds: ['u2'], ids: [] }), /没有可转发的消息/);
    assert.throws(() => buildForwardPayload({ peer: 'u1', toPeerIds: ['u2'], ids: [-5, 0] }), /没有可转发的消息/);
  });

  it('sentTargetCount:按 peerId 去重计数;响应缺失回 0(绝不猜)', () => {
    assert.equal(sentTargetCount({ sent: [{ peerId: 'u1' }, { peerId: 'saved' }, { peerId: 'u1' }] }), 2);
    assert.equal(sentTargetCount({ sent: [] }), 0);
    assert.equal(sentTargetCount(null), 0);
    assert.equal(sentTargetCount({}), 0);
    assert.equal(sentTargetCount({ sent: [null, {}, { peerId: null }] }), 0);
  });
});

describe('⑥ messageAbilities / dialogAbilities 判定矩阵（§5.1-B 口径,实现归 M4）', () => {
  const abilitiesPath = path.join(SRC_ROOT, 'lib', 'telegram-actions', 'abilities.js');
  const abilitiesReady = existsSync(abilitiesPath);

  it(abilitiesReady
    ? 'telegram-actions/abilities.js 在位:按 §5.1-B 口径实测判定矩阵'
    : 'telegram-actions/abilities.js 未落地（并行 worker M4 未产出）——显式跳过,不冒充通过', async (t) => {
    if (!abilitiesReady) {
      t.skip('src/lib/telegram-actions/abilities.js 不存在:该段归页面-菜单动作 worker,落地后本门自动覆盖');
      return;
    }
    const abilities = await import(pathToFileURL(abilitiesPath).href); // 加载失败=本用例失败,如实上报
    assert.equal(typeof abilities.messageAbilities, 'function', 'messageAbilities 应为导出函数');
    assert.equal(typeof abilities.dialogAbilities, 'function', 'dialogAbilities 应为导出函数');

    const msgAb = (msg, peerKind, extra = {}) =>
      abilities.messageAbilities(msg, { me: {}, peer: { kind: peerKind, canSend: true }, selectionActive: false, ...extra });

    // revoke = out || ['group','saved'].includes(peer.kind)（保守推导,§5.1-B）
    assert.equal(msgAb({ id: 5, out: true }, 'group').revoke, true, 'own 消息可撤');
    assert.equal(msgAb({ id: 5, out: false }, 'group').revoke, true, '群聊他人消息可撤(管理员语义,上游错误兜底)');
    assert.equal(msgAb({ id: 5, out: false }, 'saved').revoke, true, 'saved 可撤');
    assert.equal(msgAb({ id: 5, out: false }, 'channel').revoke, false, '频道他人消息不可撤');

    // edit = out && text && !forward && id>0（仅文本 v1）
    assert.equal(msgAb({ id: 5, out: true, text: 'x' }, 'group').edit, true);
    assert.equal(msgAb({ id: 5, out: true, text: 'x', forward: { name: 'a' } }, 'group').edit, false, '带转发头不可编辑');
    assert.equal(msgAb({ id: 5, out: false, text: 'x' }, 'group').edit, false, '他人消息不可编辑');
    assert.equal(msgAb({ id: -1, out: true, text: 'x', __status: 'pending' }, 'group').edit, false, '乐观存根不可编辑');
    assert.equal(msgAb({ id: 5, out: true }, 'group').edit, false, '无文本不可编辑');

    // pin = kind!=='saved' && id>0 && !msg.service（契约消息 kind:'message'|'service'）
    assert.equal(msgAb({ id: 5 }, 'group').pin, true);
    assert.equal(msgAb({ id: 5 }, 'saved').pin, false, 'saved 不提供置顶');
    assert.equal(msgAb({ id: 5, kind: 'service' }, 'group').pin, false, '服务消息不可置顶');
    assert.equal(msgAb({ id: -1 }, 'group').pin, false, '负 id 存根不可置顶');

    // cancelSend = id<0 && __status==='pending'
    assert.equal(msgAb({ id: -1, __status: 'pending' }, 'group').cancelSend, true);
    assert.equal(msgAb({ id: -1, __status: 'failed' }, 'group').cancelSend, false);
    assert.equal(msgAb({ id: 5, __status: 'pending' }, 'group').cancelSend, false, '正 id 无取消发送');

    // dialogAbilities:五键布尔面（域 3 EnabledContextActions）
    const d = abilities.dialogAbilities({ id: 'u1', kind: 'user', pinned: false, muted: false }, { me: {} });
    for (const k of ['pin', 'mute', 'markUnread', 'archive', 'remove']) {
      assert.equal(typeof d[k], 'boolean', `dialogAbilities.${k} 应为布尔`);
    }
  });
});
