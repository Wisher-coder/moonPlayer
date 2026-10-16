/* global Buffer */
// ============================================================================
// scripts/test-history-backends.mjs —— 聊天历史双后端·零依赖纯逻辑测试(工作流门 10)
// ----------------------------------------------------------------------------
// 参照系:.fixtmp/tgios-pages-blueprint.md §6.2 门 10(①-⑫ 十二格即契约)。
// 运行:node MoontentRN/app/scripts/test-history-backends.mjs —— 只用 Node 内置
// 模块(node:test / node:assert / node:module / node:fs / node:url),不装依赖、
// 不连真网、不触真上游、零 RN import。
//
// loader 的强制 ESM 手法(先 register 钩子、后 import 被测对象;历史出处为已删除的
// react-native-tdlib 调试模块):被测对象是 app 包内的 .js
// 文件而 app/package.json 无 "type":"module",load 钩子对四个零 RN 文件
// (协议/协调器/后端 A/后端 B 纯逻辑)及其依赖(tg-rows.js / chat-helpers.js)
// 显式按 format:'module' 自读源码返回——分层铁律(蓝图 §2.1)由此静态锁定:
// 这六个文件里任何 RN import 都会在本 runner 直接炸出解析错误。
//
// 被测对象:
//   src/lib/telegram-history/history-backend.js       协议/常量/开关解析
//   src/lib/telegram-history/history-coordinator.js   协调器(diff/事务/定位)
//   src/lib/telegram-history/backend-flatlist.js      后端 A(FlatList 桥)
//   src/lib/telegram-history/backend-virtual-core.js  后端 B(虚拟列表纯逻辑)
//   src/lib/tg-rows.js                                行装配(diff 输入的来源形状)
//   src/components/telegram/chat-helpers.js           tg-rows 的依赖(toDate)
// ============================================================================
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// ---- 强制 ESM 的目标(全部零 RN;新增零 RN 依赖文件须加进此处,漏加即
// ---- runner 以 CJS 解析失败炸出,天然防呆)。chat-helpers.js 现转发扩展目录
// ---- chat-helpers/index.js(零 RN 纯工具),一并纳入。
const FORCE_ESM_RE = /\/src\/(lib\/telegram-history\/(history-backend|history-coordinator|backend-flatlist|backend-virtual-core)\.js|lib\/tg-rows\.js|components\/telegram\/chat-helpers\.js|components\/telegram\/chat-helpers\/index\.js)$/;

// ---- 钩子本体:主 pass 与钩子 pass 共用本文件(globalThis 闸防递归注册;
// ---- Node 24 的 module.register 钩子在主线程同 realm 运行,globalThis 共享)。
// ---- 钩子 pass 只导出 resolve/load;主 pass 走 register+测试流程。
export async function resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (FORCE_ESM_RE.test(url)) {
    // 强制 ESM:自读源码并显式声明 format,绕开无 "type":"module" 包的解析歧义
    const source = readFileSync(fileURLToPath(url), 'utf8');
    return { format: 'module', source, shortCircuit: true };
  }
  return nextLoad(url, context);
}

// ---- 主 pass 守卫:Node 24 的 module.register 钩子线程有自己的 globalThis
// ---- (本会话实测:钩子线程读不到主线程的 globalThis 标记),单靠内存标记会
// ---- 让钩子线程把整套测试再跑一遍。守卫双通道:进程环境变量(register 派生
// ---- 工作线程在创建时继承)+ 内存标记(防同线程重复进入)。
const isHooksPass = process.env.MOONTENT_HISTORY_HOOKS === '1' || globalThis.__MOONTENT_HISTORY_TEST_HOOKS__ === true;
if (!isHooksPass) {
  process.env.MOONTENT_HISTORY_HOOKS = '1';
  globalThis.__MOONTENT_HISTORY_TEST_HOOKS__ = true;
  // 挂载解析钩子:必须发生在 import 被测对象之前(test-delegation.mjs 同款)
  register('./test-history-backends.mjs', import.meta.url);

  const { BACKEND_MEMBERS, MAX_INT, makeTransaction, assertBackendMembers, resolveBackendKind, AT_BOTTOM_EPS } =
    await import('../src/lib/telegram-history/history-backend.js');
  const { createHistoryCoordinator, diffRows, rowFingerprint, applyTransactionToRows, stationaryRangeFor } =
    await import('../src/lib/telegram-history/history-coordinator.js');
  const { createFlatlistBackend } = await import('../src/lib/telegram-history/backend-flatlist.js');
  const { createVirtualBackend } = await import('../src/lib/telegram-history/backend-virtual-core.js');
  const { buildRows, findRowIndex } = await import('../src/lib/tg-rows.js');

  // ==========================================================================
  // fixture 工具
  // ==========================================================================
  // 行构造:与 tg-rows.buildRows 的输出形状一致(协议消费面)
  function msgRow(id, extra = {}) {
    const mExtra = extra.msg || {};
    delete extra.msg;
    return {
      t: 'msg',
      key: 'm' + id,
      msg: {
        id,
        peerKey: 'u1',
        kind: 'message',
        date: '2026-10-12T10:00:00.000Z',
        out: false,
        views: null,
        from: { id: '7', name: '甲', isBot: false, username: '', avatar: null },
        text: '正文 ' + id,
        entities: [],
        groupedId: null,
        forward: null,
        viaBot: null,
        signature: null,
        replyTo: null,
        media: null,
        inlineKeyboard: null,
        replyKeyboard: null,
        service: null,
        ...mExtra,
      },
      album: null,
      memberIds: null,
      readId: id,
      showSender: false,
      showAvatar: true,
      mergeTop: false,
      mergeBottom: false,
      ...extra,
    };
  }
  function dateRow(dayKey, date) {
    return { t: 'date', key: 'd' + dayKey, date };
  }
  function unreadRow() {
    return { t: 'unread', key: 'unread' };
  }

  // 全成员 no-op 桩后端(协调器/纯逻辑单测用;成员齐备性由 assertBackendMembers 把关)
  function makeSpyBackend() {
    const spy = { kind: 'flatlist', txs: [] };
    for (const m of BACKEND_MEMBERS) {
      spy[m] = () => {};
    }
    spy.chatHistoryTransaction = (tx) => {
      spy.txs.push(tx);
    };
    return spy;
  }

  // B 后端的假宿主:scrollTo 直接回灌滚动帧(模拟 RN ScrollView 行为链:
  // 程序滚动 → onScroll → core 收 presented),让「欠上报」链路真实走通
  function attachFakeHost(b, { vh = 600, vw = 320 } = {}) {
    const host = {
      scrolls: [], // host.scrollTo 收到的 y 序列
      vh,
      vw,
      getNode: () => ({ node: true }),
      getNodes: () => new Map(),
      onCoreChanged: () => {},
      scrollTo: (y, animated) => {
        host.scrolls.push({ y, animated: !!animated });
        b.handleHostScroll({ y, viewportHeight: host.vh, viewportWidth: host.vw });
      },
    };
    b.attachHost(host);
    return host;
  }

  // 把 B 的全部行量测成给定高度(onLayout 语义的直灌;事件面用 no-op 免噪)
  function measureAll(b, rows, heightOf) {
    for (const r of rows) b.setRowHeight(r.key, heightOf(r));
  }

  // ==========================================================================
  // ① 两后端协议齐备性(BACKEND_MEMBERS 全表 typeof function)
  // ==========================================================================
  describe('门10-① 协议齐备性', () => {
    it('后端 A(FlatList)实现全部协议成员', () => {
      const a = createFlatlistBackend({ getListNode: () => null, publishRows: () => {} });
      assert.equal(assertBackendMembers(a, 'flatlist'), true);
      for (const m of BACKEND_MEMBERS) assert.equal(typeof a[m], 'function', 'A 缺成员 ' + m);
    });
    it('后端 B(虚拟列表)实现全部协议成员', () => {
      const b = createVirtualBackend();
      assert.equal(assertBackendMembers(b, 'virtual'), true);
      for (const m of BACKEND_MEMBERS) assert.equal(typeof b[m], 'function', 'B 缺成员 ' + m);
    });
    it('缺成员的后端被断言拒绝(中文错误)', () => {
      assert.throws(() => assertBackendMembers({ kind: 'x' }, '残缺'), /缺少协议成员/);
    });
    it('两后端 kind 只发布 flatlist/virtual(usesBackend 唯一来源)', () => {
      const a = createFlatlistBackend({ getListNode: () => null, publishRows: () => {} });
      const b = createVirtualBackend();
      assert.equal(a.kind, 'flatlist');
      assert.equal(b.kind, 'virtual');
    });
  });

  // ==========================================================================
  // ② 事务应用顺序(删降序→插升序→更)与 stationaryItemRange 两处承重值
  // ==========================================================================
  describe('门10-② 事务应用顺序与 stationary 承重值', () => {
    const prev = [msgRow(5), msgRow(4), msgRow(3), msgRow(2), msgRow(1)];
    const next = [msgRow(9), msgRow(5), msgRow(4), msgRow(3), msgRow(1), msgRow(0)];
    // prev→next:删 id2(下标 3);插 id9@0、id0@5;其余 id 存续
    it('diff 三段:删除降序/插入升序/更新升序', () => {
      const d = diffRows(prev, next);
      assert.deepEqual(d.deleteIndices, [3]); // 降序输出
      assert.deepEqual(
        d.insertIndicesAndItems.map((x) => x.index),
        [0, 5]
      ); // 升序
      assert.equal(d.updateIndicesAndItems.length, 0);
    });
    it('按 ListView 顺序重建=目标数组(先删→后插→再更)', () => {
      const d = diffRows(prev, next);
      const rebuilt = applyTransactionToRows(prev, makeTransaction({
        deleteIndices: d.deleteIndices,
        insertIndicesAndItems: d.insertIndicesAndItems,
        updateIndicesAndItems: d.updateIndicesAndItems,
      }));
      assert.deepEqual(rebuilt.map((r) => r.key), next.map((r) => r.key));
    });
    it('删除入参顺序被规范化(共享实现内置降序;任何一处自行实现顺序都偏离此基线)', () => {
      // 升序入参 [3,4] 与降序入参 [4,3] 必须等价(删 id2、id1)
      const asc = applyTransactionToRows(prev, makeTransaction({ deleteIndices: [3, 4] }));
      const desc = applyTransactionToRows(prev, makeTransaction({ deleteIndices: [4, 3] }));
      assert.deepEqual(asc.map((r) => r.key), ['m5', 'm4', 'm3']);
      assert.deepEqual(desc.map((r) => r.key), ['m5', 'm4', 'm3']);
    });
    it('更新段按最终下标原位替换', () => {
      const p = [msgRow(2), msgRow(1)];
      const n = [msgRow(2, { msg: { text: '编辑后' } }), msgRow(1)];
      const d = diffRows(p, n);
      assert.deepEqual(d.updateIndicesAndItems.map((x) => x.index), [0]);
      const rebuilt = applyTransactionToRows(p, makeTransaction({
        updateIndicesAndItems: d.updateIndicesAndItems,
      }));
      assert.equal(rebuilt[0].msg.text, '编辑后');
      assert.deepEqual(rebuilt.map((r) => r.key), ['m2', 'm1']);
    });
    it('stationaryItemRange 承重值:全替换 [.Reload]=[0,MAX_INT]', () => {
      const rows = [msgRow(2), msgRow(1)];
      const d = diffRows([], rows);
      assert.deepEqual(stationaryRangeFor(rows, d, 'reload'), [0, MAX_INT]);
    });
    it('stationaryItemRange 承重值:贴底头部连续插入=[k, MAX_INT](发送动画口径)', () => {
      const p2 = [msgRow(2), msgRow(1)];
      const n2 = [msgRow(3), msgRow(2), msgRow(1)];
      const d = diffRows(p2, n2);
      assert.deepEqual(stationaryRangeFor(n2, d, 'update'), [1, MAX_INT]);
    });
    it('协调器挂载门禁:未挂载时事务排队,markMounted 后按序补发', () => {
      const spy = makeSpyBackend();
      const coord = createHistoryCoordinator({ backend: spy });
      coord.setRows([msgRow(1)], {});
      assert.equal(spy.txs.length, 0, '未挂载不得下发');
      coord.scrollToRow(1, {});
      assert.equal(spy.txs.length, 0, '未挂载时定位事务同样排队');
      coord.markMounted();
      assert.equal(spy.txs.length, 2, '挂载后按序补发');
      assert.equal(spy.txs[0].insertIndicesAndItems.length, 1);
      assert.ok(spy.txs[1].scrollToItem);
    });
    it('纯滚动走事务(scrollToItem 字段),未命中窗口不下发', () => {
      const spy = makeSpyBackend();
      const coord = createHistoryCoordinator({ backend: spy });
      coord.markMounted();
      coord.setRows([msgRow(2), msgRow(1)], {});
      spy.txs.length = 0;
      assert.equal(coord.scrollToRow(1, { position: 'center' }), true);
      assert.equal(spy.txs.length, 1);
      assert.equal(spy.txs[0].scrollToItem.row.key, 'm1');
      assert.equal(spy.txs[0].scrollToItem.position, 'center');
      assert.equal(coord.scrollToRow(999, {}), false, '未命中返回 false,不产生事务');
      assert.equal(spy.txs.length, 1);
    });
    it('等值集合不发事务(防渲染循环)', () => {
      const spy = makeSpyBackend();
      const coord = createHistoryCoordinator({ backend: spy });
      coord.markMounted();
      coord.setRows([msgRow(2), msgRow(1)], {});
      spy.txs.length = 0;
      coord.setRows([msgRow(2), msgRow(1)], {});
      assert.equal(spy.txs.length, 0);
    });
  });

  // ==========================================================================
  // ③ 指纹相等判定(同 id 换内容 → update 非重插)+ ⑪ 白名单三格
  // ==========================================================================
  describe('门10-③/⑪ 指纹白名单(漏字段=原位替换吞成 no-op 的回归面)', () => {
    it('同 id 内容不变 → 无 diff(等值 no-op)', () => {
      const rows = [msgRow(1)];
      const d = diffRows(rows, [msgRow(1)]);
      assert.equal(d.deleteIndices.length + d.insertIndicesAndItems.length + d.updateIndicesAndItems.length, 0);
    });
    it('同 id 换 text/date/__status → update 事务(非重插)', () => {
      const next = [msgRow(1, { msg: { text: '改过的正文', __status: undefined } })];
      const d = diffRows([msgRow(1)], next);
      assert.equal(d.insertIndicesAndItems.length, 0);
      assert.equal(d.updateIndicesAndItems.length, 1);
      assert.equal(d.updateIndicesAndItems[0].index, 0);
    });
    it('白名单格1:同 id 只换 media(poll chosen/voters/total)→ 必产 update 事务', () => {
      const pollBase = { kind: 'poll', poll: { id: 'p', question: '选谁', options: [], results: { total: 10, per: [{ option: 'MA==', voters: 3, chosen: false }] }, closed: false, quiz: false, multipleChoice: false } };
      const pollVoted = JSON.parse(JSON.stringify(pollBase));
      pollVoted.poll.results.per[0].chosen = true;
      pollVoted.poll.results.per[0].voters = 4;
      pollVoted.poll.results.total = 11;
      const d = diffRows(
        [msgRow(1, { msg: { media: pollBase } })],
        [msgRow(1, { msg: { media: pollVoted } })]
      );
      assert.equal(d.updateIndicesAndItems.length, 1, 'replaceMessage 只改 media 的原位替换必须重渲');
      assert.equal(d.insertIndicesAndItems.length, 0);
    });
    it('白名单格1b:同 id 只换 inlineKeyboard(bot 回调)→ 必产 update 事务', () => {
      const d = diffRows(
        [msgRow(1, { msg: { inlineKeyboard: [[{ type: 'callback', text: '赞', data: 'YQ==' }]] } })],
        [msgRow(1, { msg: { inlineKeyboard: [[{ type: 'callback', text: '已赞 (1)', data: 'YQ==' }]] } })]
      );
      assert.equal(d.updateIndicesAndItems.length, 1);
    });
    it('白名单格2:同 id 只换 mergeTop/mergeBottom(运行组邻接变化)→ 必产 update 事务', () => {
      const d = diffRows(
        [msgRow(1, { mergeTop: false, mergeBottom: false })],
        [msgRow(1, { mergeTop: true, mergeBottom: true })]
      );
      assert.equal(d.updateIndicesAndItems.length, 1, '删除组中间一条后幸存行角半径必须重渲');
    });
    it('白名单格2b:showSender/showAvatar(运行组呈现面)同格覆盖', () => {
      const d = diffRows(
        [msgRow(1, { showSender: true, showAvatar: true })],
        [msgRow(1, { showSender: false, showAvatar: false })]
      );
      assert.equal(d.updateIndicesAndItems.length, 1);
    });
    it('白名单格3:同 id 只换 replyTo(引用补齐)→ 必产 update 事务', () => {
      const d = diffRows(
        [msgRow(1, { msg: { replyTo: { msgId: 9, name: '', snippet: '' } } })],
        [msgRow(1, { msg: { replyTo: { msgId: 9, name: '甲', snippet: '原消息内容' } } })]
      );
      assert.equal(d.updateIndicesAndItems.length, 1, 'replyTo 补齐必须重渲');
    });
    it('白名单格3b:forward/signature/viaBot/views 同格覆盖', () => {
      const d = diffRows(
        [msgRow(1)],
        [msgRow(1, { msg: { forward: { name: '来源频道', date: '2026-10-01T00:00:00.000Z' }, signature: '署名', viaBot: 'bot', views: 120 } })]
      );
      assert.equal(d.updateIndicesAndItems.length, 1);
    });
    it('指纹函数稳定:同输入两次调用相等(无随机序/时间污染)', () => {
      const r = msgRow(1, { msg: { media: { kind: 'photo', photo: { url: 'u', fullUrl: 'f', w: 1, h: 2 } } } });
      assert.equal(rowFingerprint(r), rowFingerprint(JSON.parse(JSON.stringify(r))));
    });
  });

  // ==========================================================================
  // ④ 后端 B resolver 三态与「目标未量测→先量测→pointOffset 回调」路径
  // ==========================================================================
  describe('门10-④ 后端 B 定位 resolver', () => {
    it('三态映射:top/center/bottom(目标已量测 → 立即定位)', () => {
      const b = createVirtualBackend();
      const host = attachFakeHost(b, { vh: 600 });
      const rows = [msgRow(5), msgRow(4), msgRow(3), msgRow(2), msgRow(1)];
      b.chatHistoryTransaction(makeTransaction({
        insertIndicesAndItems: rows.map((row, index) => ({ index, row })),
      }));
      b.handleHostScroll({ y: 0, viewportHeight: 600, viewportWidth: 320 });
      measureAll(b, rows, () => 300); // 总高 1500,maxScroll=900
      // 目标 id3:下标 2,rowTop=600,h=300
      b.chatHistoryTransaction(makeTransaction({ scrollToItem: { row: rows[2], position: 'top' } }));
      assert.equal(host.scrolls.at(-1).y, 600 + 300 - 600); // top: rowTop+h-vh
      b.chatHistoryTransaction(makeTransaction({ scrollToItem: { row: rows[2], position: 'center' } }));
      assert.equal(host.scrolls.at(-1).y, 600 + 150 - 300); // center: rowTop+h/2-vh/2
      b.chatHistoryTransaction(makeTransaction({ scrollToItem: { row: rows[2], position: 'bottom' } }));
      assert.equal(host.scrolls.at(-1).y, 600); // bottom: rowTop(视觉底=近端/最新端)
    });
    it('目标未量测 → 先进窗口量测(forceMeasure)→ onLayout 回填 → 回调定位', () => {
      const b = createVirtualBackend();
      const host = attachFakeHost(b, { vh: 500 });
      const rows = [msgRow(5), msgRow(4), msgRow(3), msgRow(2), msgRow(1)];
      b.chatHistoryTransaction(makeTransaction({
        insertIndicesAndItems: rows.map((row, index) => ({ index, row })),
      }));
      b.handleHostScroll({ y: 0, viewportHeight: 500, viewportWidth: 320 });
      // 只量测 id5..id2(id1 不量测,保持估高)
      for (const r of rows.slice(0, 4)) b.setRowHeight(r.key, 200);
      // 跳到 id1(最旧端,未量测):目标不可立即解析 → 不滚
      b.chatHistoryTransaction(makeTransaction({ scrollToItem: { row: rows[4], position: 'center' } }));
      assert.equal(host.scrolls.length, 0, '未量测目标不得直接滚');
      assert.ok(b._internals.pendingScroll, '待定滚动挂起');
      assert.equal(b._internals.forceMeasureKey, 'm1', '量测请求已置');
      // onLayout 回填(=pointOffset 回调时刻):解析并定位
      b.setRowHeight('m1', 200);
      assert.equal(host.scrolls.length, 1, '量测到位后一次定位');
      // rowTop(id1)=4*200=800,h=200,vh=500 → center y=800+100-250=650;maxScroll=1000-500=500 → 夹 500
      assert.equal(host.scrolls[0].y, 500);
      assert.equal(b._internals.pendingScroll, null);
    });
    it('目标行不在集合 → 不滚(存活判据)', () => {
      const b = createVirtualBackend();
      const host = attachFakeHost(b, { vh: 500 });
      const rows = [msgRow(1)];
      b.chatHistoryTransaction(makeTransaction({
        insertIndicesAndItems: rows.map((row, index) => ({ index, row })),
      }));
      b.handleHostScroll({ y: 0, viewportHeight: 500, viewportWidth: 320 });
      b.chatHistoryTransaction(makeTransaction({ scrollToItem: { row: msgRow(999), position: 'center' } }));
      assert.equal(host.scrolls.length, 0);
    });
  });

  // ==========================================================================
  // ⑤ 未读重钉两分支:B 同 pass 一次移动 / A apply-后补滚 + completion
  // ==========================================================================
  describe('门10-⑤ maintainsUnreadItemAlignment 两分支', () => {
    it('后端 B:重钉=同一次滚动(事务内一次 host.scrollTo)', () => {
      const b = createVirtualBackend();
      const host = attachFakeHost(b, { vh: 400 });
      const rows = [msgRow(2), unreadRow(), msgRow(1)];
      b.chatHistoryTransaction(makeTransaction({
        insertIndicesAndItems: rows.map((row, index) => ({ index, row })),
      }));
      b.handleHostScroll({ y: 0, viewportHeight: 400, viewportWidth: 320 });
      measureAll(b, rows, () => 200);
      host.scrolls.length = 0;
      b.chatHistoryTransaction(makeTransaction({
        updateSizeAndInsets: { contentInset: { top: 0, bottom: 0 } },
        maintainsUnreadItemAlignment: true,
        scrollToItem: { row: rows[1], position: 'top' }, // 协调器合成:unread 行贴视觉顶
      }));
      assert.equal(host.scrolls.length, 1, 'B 同 pass:一次移动一次动画');
      // unread 行下标 1:rowTop=200,h=200 → top y = 200+200-400 = 0
      assert.equal(host.scrolls[0].y, 0);
    });
    it('后端 A:先发布行数据,后补滚动(scrollToIndex),completion 收尾', () => {
      const calls = [];
      const listNode = {
        scrollToOffset: (o) => calls.push(['offset', o]),
        scrollToIndex: (o) => calls.push(['index', o]),
        getScrollableNode: () => ({ node: true }),
      };
      const published = [];
      const a = createFlatlistBackend({ getListNode: () => listNode, publishRows: (rows) => published.push(rows) });
      let completed = null;
      a.chatHistoryTransaction(makeTransaction({
        insertIndicesAndItems: [{ index: 0, row: msgRow(2) }, { index: 1, row: msgRow(1) }],
        scrollToItem: { row: msgRow(1), position: 'center' },
        completion: (applied) => { completed = applied; },
      }));
      assert.equal(completed, true, 'completion=已下发');
      assert.equal(published.length, 1, '行数据先发布');
      assert.deepEqual(calls.map((c) => c[0]), ['index'], 'A 补滚=scrollToIndex(应用后独立执行,非同 pass)');
      assert.equal(calls[0][1].index, 1);
      assert.equal(calls[0][1].viewPosition, 0.5, 'center=viewPosition 0.5(现状口径)');
      // 贴底回底走 scrollToOffset(0):position bottom + index 0
      calls.length = 0;
      a.chatHistoryTransaction(makeTransaction({ scrollToItem: { row: msgRow(2), position: 'bottom' } }));
      assert.deepEqual(calls.map((c) => c[0]), ['offset']);
      assert.equal(calls[0][1].offset, 0);
    });
  });

  // ==========================================================================
  // ⑥ settled/presented 双读数 + 事务外几何变更欠一次上报
  // ==========================================================================
  describe('门10-⑥ settled/presented 双读数与欠上报', () => {
    it('后端 B:滚动帧报 presented,事务点报 settled(同采样成员两出口)', () => {
      const b = createVirtualBackend();
      attachFakeHost(b, { vh: 300 });
      const rows = [msgRow(3), msgRow(2), msgRow(1)];
      b.chatHistoryTransaction(makeTransaction({
        insertIndicesAndItems: rows.map((row, index) => ({ index, row })),
      }));
      b.handleHostScroll({ y: 0, viewportHeight: 300, viewportWidth: 320 });
      measureAll(b, rows, () => 300); // 总高 900,maxScroll=600
      // 用户滚动帧:presented 与 settled 同值(y=200)
      b.handleHostScroll({ y: 200, viewportHeight: 300, viewportWidth: 320 });
      assert.deepEqual(b.settledContentOffsets(), { top: 400, bottom: 200 });
      // 程序滚动:事务点 settled 立即到终点(模型 y=0),假宿主 scrollTo 回灌
      // 滚动帧后 presented 收敛——两读数经同一成员读取,出口语义由时序区分
      b.chatHistoryTransaction(makeTransaction({ scrollToItem: { row: rows[0], position: 'top' } }));
      assert.deepEqual(b.settledContentOffsets(), { top: 600, bottom: 0 });
    });
    it('后端 B:量测补偿(行在可见带更新侧)驱动滚动帧 → 欠上报规则兑现', () => {
      const b = createVirtualBackend();
      const host = attachFakeHost(b, { vh: 300 });
      const rows = [msgRow(4), msgRow(3), msgRow(2), msgRow(1)];
      b.chatHistoryTransaction(makeTransaction({
        insertIndicesAndItems: rows.map((row, index) => ({ index, row })),
      }));
      b.handleHostScroll({ y: 0, viewportHeight: 300, viewportWidth: 320 });
      measureAll(b, rows, () => 200); // 总高 800,maxScroll=500
      // 滚到中部(y=300;可见带 [300,600])
      b.handleHostScroll({ y: 300, viewportHeight: 300, viewportWidth: 320 });
      const before = b.settledContentOffsets();
      // id4(下标 0,在可见带更新侧:0+200<=300)量测修正 +100 → 补偿滚动 +100
      const r = b.setRowHeight('m4', 300);
      assert.equal(r.changed, true);
      assert.equal(r.shift, 100, '更新侧行高修正必须补偿滚动');
      assert.equal(host.scrolls.at(-1).y, 400, 'scrollY 补偿到 400(经宿主滚动帧,欠上报兑现)');
      assert.equal(b.settledContentOffsets().bottom, before.bottom + 100, '视口内行不动(读数平移)');
      // 更旧侧行(id1)高度变化不补偿(向远端生长)
      const r2 = b.setRowHeight('m1', 260);
      assert.equal(r2.changed, true);
      assert.equal(r2.shift, 0, '旧端侧行高变化不补偿');
    });
    it('后端 A:settled 双读数来自最近滚动帧(非严格 settled,注释口径)', () => {
      const a = createFlatlistBackend({ getListNode: () => null, publishRows: () => {} });
      assert.equal(a.settledContentOffsets(), null, '无滚动读数 → null(不可知)');
      a.handleHostScroll({ nativeEvent: { contentOffset: { y: 120 }, contentSize: { height: 1000 }, layoutMeasurement: { height: 400 } } });
      assert.deepEqual(a.settledContentOffsets(), { top: 480, bottom: 120 });
      assert.equal(a.getContentHeight(), 1000);
      // 回弹(负 y)保持负读数(iOS 弹性)
      a.handleHostScroll({ nativeEvent: { contentOffset: { y: -30 }, contentSize: { height: 1000 }, layoutMeasurement: { height: 400 } } });
      assert.equal(a.settledContentOffsets().bottom, -30);
    });
  });

  // ==========================================================================
  // ⑦ 集合边缘 fixtures:空/单行/仅插入首行/仅删末行/整屏未读/单行未读
  // ==========================================================================
  describe('门10-⑦ 集合边缘(两后端逐格)', () => {
    function runBoth(rowsFn) {
      const a = createFlatlistBackend({ getListNode: () => null, publishRows: () => {} });
      const b = createVirtualBackend();
      attachFakeHost(b);
      const ca = createHistoryCoordinator({ backend: a });
      const cb = createHistoryCoordinator({ backend: b });
      ca.markMounted();
      cb.markMounted();
      const rows = rowsFn();
      ca.setRows(rows, { reason: 'reload' });
      cb.setRows(rows, { reason: 'reload' });
      return { a, b, ca, cb, rows };
    }
    it('空集合:不发事务,后端内容为空', () => {
      const { a, b } = runBoth(() => []);
      assert.deepEqual(a.appliedRows, []);
      assert.deepEqual(b._internals.entries, []);
      const g = b.getWindow();
      assert.deepEqual(g.rows, []);
      assert.equal(g.topSpacer, 0);
    });
    it('单行:两后端内容一致', () => {
      const { a, b } = runBoth(() => [msgRow(1)]);
      assert.deepEqual(a.appliedRows.map((r) => r.key), ['m1']);
      assert.deepEqual(b._internals.entries.map((r) => r.key), ['m1']);
    });
    it('仅插入首行(新消息到达):两后端头部插入;B 贴底不补偿/非贴底按估高补偿', () => {
      const rows = [msgRow(2), msgRow(1)];
      const next = [msgRow(3), msgRow(2), msgRow(1)];
      // 贴底(y=0):头部插入不补偿(pin-to-edge 自然成立)
      const { a, b, ca, cb } = runBoth(() => rows);
      measureAll(b, rows, () => 200); // 先量测(视口未知,零补偿),再滚
      b.handleHostScroll({ y: 0, viewportHeight: 300, viewportWidth: 320 });
      ca.setRows(next, {});
      cb.setRows(next, {});
      assert.deepEqual(a.appliedRows.map((r) => r.key), ['m3', 'm2', 'm1']);
      assert.deepEqual(b._internals.entries.map((r) => r.key), ['m3', 'm2', 'm1']);
      assert.equal(b._internals.presentedY, 0, '贴底保持贴底');
      // 非贴底(y=400,四行长列表内):头部插入补偿一个估高(68),视口内行不动
      const rows4 = [msgRow(4), msgRow(3), msgRow(2), msgRow(1)];
      const next5 = [msgRow(5), msgRow(4), msgRow(3), msgRow(2), msgRow(1)];
      const b2 = createVirtualBackend();
      attachFakeHost(b2, { vh: 300 });
      const c2 = createHistoryCoordinator({ backend: b2 });
      c2.markMounted();
      c2.setRows(rows4, { reason: 'reload' });
      measureAll(b2, rows4, () => 200); // 总高 800,maxScroll=500
      b2.handleHostScroll({ y: 400, viewportHeight: 300, viewportWidth: 320 });
      c2.setRows(next5, {}); // 头部插入估高 68 < 可见带起点 400 → 补偿 68
      assert.equal(b2._internals.presentedY, 468, '非贴底头部插入按估高补偿,视口内行不动');
    });
    it('仅删末行(最旧端离场):不补偿(远端变化)', () => {
      const b = createVirtualBackend();
      attachFakeHost(b, { vh: 300 });
      const c = createHistoryCoordinator({ backend: b });
      c.markMounted();
      c.setRows([msgRow(3), msgRow(2), msgRow(1)], { reason: 'reload' });
      for (const k of ['m3', 'm2', 'm1']) b.setRowHeight(k, 200); // 先量测(视口未知,零补偿)
      b.handleHostScroll({ y: 200, viewportHeight: 300, viewportWidth: 320 });
      c.setRows([msgRow(3), msgRow(2)], {}); // 删最旧端
      assert.deepEqual(b._internals.entries.map((r) => r.key), ['m3', 'm2']);
      assert.equal(b._internals.presentedY, 200, '最旧端删除不推挤视口');
    });
    it('整屏皆未读:未读行贴最旧端,两后端一致;B 可见集只产 msg 行 readId', () => {
      const rows = [msgRow(2), msgRow(1), unreadRow()]; // buildRows 整屏未读口径:unread 行随最旧端 msg 行之后
      const { a, b } = runBoth(() => rows);
      assert.deepEqual(a.appliedRows.map((r) => r.key), ['m2', 'm1', 'unread']);
      assert.deepEqual(b._internals.entries.map((r) => r.key), ['m2', 'm1', 'unread']);
      b.handleHostScroll({ y: 0, viewportHeight: 100, viewportWidth: 320 });
      b.setRowHeight('m2', 200);
      b.setRowHeight('m1', 200);
      const visible = [];
      b.onVisibleRange = (ids) => visible.push(ids);
      b.handleHostScroll({ y: 0, viewportHeight: 100, viewportWidth: 320 });
      assert.deepEqual(visible.at(-1), [2], '贴最新端可见集=首个 msg 行 readId(常量行不产出 id)');
    });
    it('单行未读:单消息 + 未读行,定位不炸', () => {
      const { a, b, ca, cb } = runBoth(() => [msgRow(1), unreadRow()]);
      assert.deepEqual(a.appliedRows.map((r) => r.key), ['m1', 'unread']);
      assert.equal(cb.scrollToRow(1, {}), true);
      assert.equal(ca.scrollToRow(1, {}), true);
      assert.deepEqual(b._internals.entries.map((r) => r.key), ['m1', 'unread']);
    });
    it('A 事务重建与目标数组全等(边缘集合逐格)', () => {
      const a = createFlatlistBackend({ getListNode: () => null, publishRows: () => {} });
      const cases = [
        [[msgRow(1)], [msgRow(2), msgRow(1)]],
        [[msgRow(2), msgRow(1)], [msgRow(2)]],
        [[dateRow('2026-10-11', 'x'), msgRow(1)], [msgRow(1)]],
        [[msgRow(1), unreadRow()], [msgRow(2), msgRow(1), unreadRow()]],
      ];
      for (const [prev, next] of cases) {
        a.appliedRows = prev;
        a.chatHistoryTransaction(makeTransaction({
          ...diffRows(prev, next),
          stationaryItemRange: [0, MAX_INT],
        }));
        assert.deepEqual(a.appliedRows.map((r) => r.key), next.map((r) => r.key));
      }
    });
  });

  // ==========================================================================
  // ⑧ 常量 identity 行:full-replace diff 下 'unread'/'d'+dayKey 不删插
  // ==========================================================================
  describe('门10-⑧ 常量 identity 行(§2.5-⑧ 的 diff 等价判据)', () => {
    it('整页重载(全替换):常量行 key 存续 → 不产生常量行的删插(msg 行全换)', () => {
      const prev = [dateRow('2026-10-12', 'v1'), msgRow(5), unreadRow(), msgRow(4)];
      const next = [dateRow('2026-10-12', 'v1'), msgRow(9), unreadRow(), msgRow(8)];
      const d = diffRows(prev, next);
      const touchedKeys = new Set([
        ...d.insertIndicesAndItems.map((x) => x.row.key),
        ...d.updateIndicesAndItems.map((x) => x.row.key),
      ]);
      const deletedKeys = d.deleteIndices.map((i) => prev[i].key);
      // 常量行不参与「旧元素仍在」判据(§2.5-⑧):JS 等价=同一 key 不因内容
      // 重生成而删插;date 行内容未变 → 无操作;unread 行 key 恒定 → 无操作
      assert.equal(touchedKeys.has('unread'), false);
      assert.equal(touchedKeys.has('d2026-10-12'), false);
      assert.equal(deletedKeys.includes('unread'), false);
      assert.equal(deletedKeys.includes('d2026-10-12'), false);
      // msg 行全换 → 删 2(降序)插 2
      assert.deepEqual(d.deleteIndices, [3, 1]);
      assert.deepEqual(d.insertIndicesAndItems.map((x) => x.row.key).sort(), ['m8', 'm9']);
      // 重建=目标
      const rebuilt = applyTransactionToRows(prev, makeTransaction({
        deleteIndices: d.deleteIndices,
        insertIndicesAndItems: d.insertIndicesAndItems,
      }));
      assert.deepEqual(rebuilt.map((r) => r.key), next.map((r) => r.key));
    });
    it('跨天日期行 = 新 key(删+插);同 key 恒 no-op(unread)', () => {
      const d = diffRows([dateRow('2026-10-12', 'd1')], [dateRow('2026-10-13', 'd2')]);
      assert.equal(d.deleteIndices.length, 1);
      assert.equal(d.insertIndicesAndItems.length, 1);
      const du = diffRows([unreadRow()], [unreadRow()]);
      assert.equal(du.deleteIndices.length + du.insertIndicesAndItems.length + du.updateIndicesAndItems.length, 0);
    });
    it('后端 B:常量行随全替换事务存续(渲染面事实)', () => {
      const b = createVirtualBackend();
      attachFakeHost(b);
      const prev = [msgRow(2), unreadRow()];
      b.chatHistoryTransaction(makeTransaction({
        insertIndicesAndItems: prev.map((row, index) => ({ index, row })),
        stationaryItemRange: [0, MAX_INT],
      }));
      b.chatHistoryTransaction(makeTransaction({
        deleteIndices: [0],
        insertIndicesAndItems: [{ index: 0, row: msgRow(3) }],
        stationaryItemRange: [0, MAX_INT],
      }));
      assert.deepEqual(b._internals.entries.map((r) => r.key), ['m3', 'unread']);
    });
  });

  // ==========================================================================
  // ⑨ 开关缺省:setting 缺失 → usesBackend==='flatlist'
  // ==========================================================================
  describe('门10-⑨ 开关缺省回滚', () => {
    it('resolveBackendKind:缺失/auto/非法 → flatlist;仅 virtual 进 B', () => {
      assert.equal(resolveBackendKind(undefined), 'flatlist');
      assert.equal(resolveBackendKind(null), 'flatlist');
      assert.equal(resolveBackendKind('auto'), 'flatlist');
      assert.equal(resolveBackendKind(''), 'flatlist');
      assert.equal(resolveBackendKind('bogus'), 'flatlist');
      assert.equal(resolveBackendKind('virtual'), 'virtual');
    });
    it('缺省构造的协调器 usesBackend === flatlist', () => {
      const a = createFlatlistBackend({ getListNode: () => null, publishRows: () => {} });
      const coord = createHistoryCoordinator({ backend: a });
      assert.equal(coord.usesBackend, 'flatlist');
      const coord2 = createHistoryCoordinator({ backend: createVirtualBackend() });
      assert.equal(coord2.usesBackend, 'virtual');
    });
  });

  // ==========================================================================
  // ⑩ 后端 A stub 面调用不抛(no-op/纯存储/null 契约)
  // ==========================================================================
  describe('门10-⑩ 后端 A stub 面安全', () => {
    const a = createFlatlistBackend({ getListNode: () => null, publishRows: () => {} });
    it('holdOverscrollAction=纯存储;holdsOverscrollActionDuringDrag=false', () => {
      assert.doesNotThrow(() => a.holdOverscrollAction(120, false));
      assert.equal(a.holdsOverscrollActionDuringDrag(), false);
    });
    it('几何枚举:null/空遍历(消费点为 0)', () => {
      const row = msgRow(1);
      assert.equal(a.itemNodeFrame(row), null);
      assert.equal(a.itemHeaderNodeFrame(row), null);
      assert.deepEqual(a.enumerateItemNodes(), []);
      assert.doesNotThrow(() => a.forEachItemNode(() => { throw new Error('不应被调到'); }));
      assert.doesNotThrow(() => a.forEachVisibleItemNode(() => { throw new Error('不应被调到'); }));
      assert.doesNotThrow(() => a.forEachItemHeaderNode(() => { throw new Error('不应被调到'); }));
    });
    it('宿主节点/拖拽读数:无宿主 → null/false,不抛', () => {
      assert.equal(a.getScrollHostNode(), null);
      assert.equal(a.didInteractivelyDragFromTopOrigin(), false);
      assert.equal(a.getBounces(), true);
    });
    it('事务面安全 stub:customAnimationTransition 传入不抛、按 animated 退化', () => {
      assert.doesNotThrow(() => {
        a.chatHistoryTransaction(makeTransaction({
          insertIndicesAndItems: [{ index: 0, row: msgRow(1) }],
          customAnimationTransition: { '@type': 'whatever' },
          options: { animated: false },
        }));
      });
    });
  });

  // ==========================================================================
  // ⑫ 页面三事件流同语义:同一输入序列下 A 透传与 B 计算逐条一致
  // ==========================================================================
  describe('门10-⑫ 页面三事件流同语义(A 透传 vs B 计算)', () => {
    function buildWorld() {
      // 统一世界:6 msg 行 + date/unread 常量行;行高 msg=120/常量=60,视口 480
      const rows = [
        msgRow(6), msgRow(5), dateRow('2026-10-12', 'x'), msgRow(4), msgRow(3), unreadRow(), msgRow(2), msgRow(1),
      ];
      const H = {}; // key → 高(第三方参照与 B 量测共用同一高度表)
      for (const r of rows) H[r.key] = r.t === 'msg' ? 120 : 60;
      const total = Object.values(H).reduce((x, y) => x + y, 0); // 840
      const vh = 480;

      // —— A 透传侧(事件面在量测后再接,保序对齐) ——
      const a = createFlatlistBackend({ getListNode: () => null, publishRows: () => {} });
      a.chatHistoryTransaction(makeTransaction({
        insertIndicesAndItems: rows.map((row, index) => ({ index, row })),
        stationaryItemRange: [0, MAX_INT],
      }));
      const aProps = a.getListProps();
      const aEvents = { scrolled: [], visible: [], older: 0 };

      // —— B 计算侧 ——
      const b = createVirtualBackend();
      const host = attachFakeHost(b, { vh, vw: 320 });
      b.chatHistoryTransaction(makeTransaction({
        insertIndicesAndItems: rows.map((row, index) => ({ index, row })),
        stationaryItemRange: [0, MAX_INT],
      }));
      b.handleHostScroll({ y: 0, viewportHeight: vh, viewportWidth: 320 });
      measureAll(b, rows, (r) => H[r.key]);
      // 量测后滚离旧端一帧再回预载位:世界高度从估高(496<vh,预载期即触发过
      // 旧端信号并消耗 armed)长到真实高(840),与 A 的 onEndReached 重评估
      // 节奏对齐——旧端信号只在滚离后重新武装
      b.handleHostScroll({ y: 0, viewportHeight: vh, viewportWidth: 320 });
      const bEvents = { scrolled: [], visible: [], older: 0 };

      // —— 量测/预载完成后统一接事件面(输入序列逐帧喂入,两后端逐条对拍) ——
      a.onScrolled = (offset, info) => aEvents.scrolled.push([offset, info.atBottom]);
      a.onVisibleRange = (ids) => aEvents.visible.push(ids);
      a.onReachOlderEdge = () => aEvents.older += 1;
      b.onScrolled = (offset, info) => bEvents.scrolled.push([offset, info.atBottom]);
      b.onVisibleRange = (ids) => bEvents.visible.push(ids);
      b.onReachOlderEdge = () => bEvents.older += 1;

      // —— 第三方参照:行几何(列表空间)由统一高度表直接推 ——
      function rowTop(key) {
        let acc = 0;
        for (const r of rows) {
          if (r.key === key) return acc;
          acc += H[r.key];
        }
        return -1;
      }
      // 可见集参照:与带 [y, y+vh] 相交的 msg 行 readId(行序)
      function refVisible(y) {
        const ids = [];
        for (const r of rows) {
          const top = rowTop(r.key);
          const h = H[r.key];
          if (r.t === 'msg' && top + h > y && top < y + vh) ids.push(r.readId);
        }
        return ids;
      }
      return { a, aProps, aEvents, b, bEvents, host, rows, H, total, vh, refVisible };
    }

    it('onScrolled 序列逐条一致(offset 与 atBottom 同口径)', () => {
      const w = buildWorld();
      const ys = [0, 64, 65, 200, 360, w.total - w.vh, 0];
      for (const y of ys) {
        w.aProps.onScroll({ nativeEvent: { contentOffset: { y }, contentSize: { height: w.total }, layoutMeasurement: { height: w.vh } } });
        w.b.handleHostScroll({ y, viewportHeight: w.vh, viewportWidth: 320 });
      }
      assert.equal(w.aEvents.scrolled.length, w.bEvents.scrolled.length);
      for (let i = 0; i < w.aEvents.scrolled.length; i++) {
        assert.deepEqual(w.aEvents.scrolled[i], w.bEvents.scrolled[i], '第 ' + i + ' 帧读数不一致');
      }
      // atBottom 阈值口径抽查(64 内视为贴底;两后端同值,页面只接一次)
      assert.deepEqual(w.aEvents.scrolled.map((x) => x[1]), [true, true, false, false, false, false, true]);
      assert.equal(AT_BOTTOM_EPS, 64);
    });

    it('onVisibleRange 序列逐条一致(与第三方几何参照对拍)', () => {
      const w = buildWorld();
      const ys = [0, 130, 260, 390, w.total - w.vh];
      for (const y of ys) {
        const ref = w.refVisible(y);
        // A:参照可见集以 FlatList viewableItems 形状喂入(行序)
        w.aProps.onViewableItemsChanged({ viewableItems: ref.map((id) => ({ item: w.rows.find((r) => r.readId === id) })) });
        // B:同 y 滚动帧自算
        w.b.handleHostScroll({ y, viewportHeight: w.vh, viewportWidth: 320 });
      }
      assert.equal(w.aEvents.visible.length, w.bEvents.visible.length);
      for (let i = 0; i < w.aEvents.visible.length; i++) {
        assert.deepEqual(w.aEvents.visible[i], w.bEvents.visible[i], '第 ' + i + ' 帧可见集不一致');
      }
      // 再与参照本身对拍(双后端都等于第三方几何)
      assert.deepEqual(w.bEvents.visible.at(-1), w.refVisible(w.total - w.vh));
    });

    it('onReachOlderEdge 触发/再武装节奏一致(数据变化后重评估)', () => {
      const w = buildWorld();
      const maxScroll = w.total - w.vh;
      // 滚到旧端阈值内:两后端各发一次
      w.aProps.onEndReached();
      w.b.handleHostScroll({ y: maxScroll, viewportHeight: w.vh, viewportWidth: 320 });
      assert.equal(w.aEvents.older, 1);
      assert.equal(w.bEvents.older, 1);
      // 同位置不再重发(B armed 闸;A 由页面在途锁吸收——此处不重复调)
      w.b.handleHostScroll({ y: maxScroll, viewportHeight: w.vh, viewportWidth: 320 });
      assert.equal(w.bEvents.older, 1);
      // 数据变化(旧向补页):两后端再武装,再次到边各再发一次
      w.a.chatHistoryTransaction(makeTransaction({
        insertIndicesAndItems: [{ index: w.rows.length, row: msgRow(0) }],
        stationaryItemRange: [0, MAX_INT],
      }));
      w.b.chatHistoryTransaction(makeTransaction({
        insertIndicesAndItems: [{ index: w.rows.length, row: msgRow(0) }],
        stationaryItemRange: [0, MAX_INT],
      }));
      w.aProps.onEndReached();
      w.b.handleHostScroll({ y: w.total + 120 - w.vh, viewportHeight: w.vh, viewportWidth: 320 });
      assert.equal(w.aEvents.older, 2);
      assert.equal(w.bEvents.older, 2);
    });
  });

  // ==========================================================================
  // 补充:tg-rows 增量(merge 角)与协议输入形状(双后端同一装配的前提)
  // ==========================================================================
  describe('补充 tg-rows 行装配(mergeTop/mergeBottom 增量)', () => {
    function item(id, over = {}) {
      return {
        id, peerKey: 'g1', kind: 'message', date: '2026-10-12T10:00:00.000Z', out: false,
        views: null, from: { id: '7', name: '甲' }, text: 't' + id, entities: [], groupedId: null,
        forward: null, viaBot: null, signature: null, replyTo: null, media: null,
        inlineKeyboard: null, replyKeyboard: null, service: null, ...over,
      };
    }
    it('入站运行组:组中行 mergeTop/mergeBottom 同真;组端行按邻接取值', () => {
      const items = [item(3), item(2), item(1)]; // 同发送者连续三条(新→旧)
      const rows = buildRows(items, 0, true);
      const byId = new Map(rows.filter((r) => r.t === 'msg').map((r) => [r.msg.id, r]));
      // 视觉最上=最旧(id1):上方无同组 → mergeTop=false;下方同组 → mergeBottom=true
      assert.equal(byId.get(1).mergeTop, false);
      assert.equal(byId.get(1).mergeBottom, true);
      // 组中(id2):上下都同组 → 双真
      assert.equal(byId.get(2).mergeTop, true);
      assert.equal(byId.get(2).mergeBottom, true);
      // 视觉最下=最新(id3):上方同组 → mergeTop=true;下方无 → mergeBottom=false
      assert.equal(byId.get(3).mergeTop, true);
      assert.equal(byId.get(3).mergeBottom, false);
    });
    it('out 消息断组(与运行组同判据);相册/未读/日期行为不变', () => {
      const items = [item(2, { out: true }), item(1)];
      const rows = buildRows(items, 1, true); // unreadAnchor=1:分隔线插在 id1 行的视觉上方(数组序其后)
      // 末尾的 date 行=最旧端日期分隔(buildRows 现状行为:整段起点之上插日期线;
      // dayKey 格式为 'Y-M-D' 不补零)
      assert.deepEqual(rows.map((r) => r.key), ['m2', 'm1', 'unread', 'd2026-9-12']);
      const byId = new Map(rows.filter((r) => r.t === 'msg').map((r) => [r.msg.id, r]));
      assert.equal(byId.get(2).mergeTop, false, '出站与入站不同组,不合并');
      assert.equal(byId.get(2).mergeBottom, false);
      assert.equal(byId.get(1).mergeTop, false);
      assert.equal(byId.get(1).mergeBottom, false);
      // 相册合流行为不变(两成员合成一行,memberIds 全体;日期线照常在最旧端)
      const albums = [
        item(11, { groupedId: 'g', media: { kind: 'photo', photo: { url: 'a', fullUrl: 'A', w: 10, h: 10 } } }),
        item(10, { groupedId: 'g', media: { kind: 'photo', photo: { url: 'b', fullUrl: 'B', w: 10, h: 10 } } }),
      ];
      const arows = buildRows(albums, 0, true);
      const msgRows = arows.filter((r) => r.t === 'msg');
      assert.equal(msgRows.length, 1, '相册合流成一条渲染条目');
      assert.equal(msgRows[0].album.length, 2);
      assert.deepEqual(msgRows[0].memberIds, [10, 11]);
      assert.equal(findRowIndex(arows, 10), 0, '相册成员按 memberIds 命中(行为不变)');
    });
  });
}
