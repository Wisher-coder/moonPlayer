// ============================================================================
// backend-virtual-core.js —— 聊天历史后端 B:轻量虚拟列表·纯逻辑
// (对照 Telegram-iOS CoreListChatHistoryBackend 语义,蓝图 §2.5)
// ----------------------------------------------------------------------------
// 分层铁律:本文件零 RN import,runner 直测(门 10);RN 宿主在
// backend-virtual-host.jsx(ScrollView inverted + 量测 + 窗口渲染),经
// attachHost 注入宿主实现——平台细节留宿主,几何/窗口/事务/定位全在本层。
//
// π 旋转不变量(§2.5-⑨,corelist 文档「Rotation invariant」):TI 里反转留在
// 包装器、被托管子列表恒 identity;RN 映射=反转机制(宿主 ScrollView inverted
// + 行级 scaleY(-1) 双层反向布局)住在宿主实现内部,本层与协调器恒 identity、
// 恒按列表空间陈述(index 0=最新,偏移 y 以最新消息边为 0——与 inverted
// FlatList 的 contentOffset.y 同一套数值)。两个后端对协调器呈现同一坐标系。
//
// 横向 inset(§2.5-⑦):归行(行内 paddingHorizontal),本层不做 TI 的
// left/right 交换——我们的行不自带 π(反转在宿主层),差异出处见宿主头注。
//
// 日期/未读分隔(§2.5-⑤ 的落地偏差,如实注明):TI 把日期头做成 attached
// overlay(.overlay 不 .reservesSpace);本仓两后端的日期/未读分隔都是占位行
// (tg-rows 行数组直出,「锚定链/未读线/日期分隔保留现状行为」为任务底线)。
// 「绝不以占位行预留高度之外的第二个高度来源」不变量天然满足:行高只有
// onLayout 量测一个来源。forEachItemHeaderNode 因此为空遍历。
//
// 已知缺口(蓝图 §2.7,v1 随代码发布):
//   1. per-item 选择性动画不支持(事务 options.animated 全事务开关);
//   2. customAnimationTransition 退化为 animated;
//   3. itemNodeFrame 精度=量测帧(无逐帧 presented 几何);itemHeaderNodeFrame
//      恒 null(无附着头);
//   4. 无 mVCP 等价:吸底为自管近似(64px 阈值);
//   5. pin-to-edge(latch+clamp+release 三态)机制储备,当前无消费方;
//   6. 高频滚动下的窗口重算与量测回填性能未在低端安卓实测(真屏门槛项)。
// ============================================================================
import {
  AT_BOTTOM_EPS, assertBackendMembers, makeTransaction, PINNED_EPS,
} from './history-backend.js';
import { applyTransactionToRows } from './history-coordinator.js';

const OVERSCAN_ROWS = 12;        // 渲染窗口两端的越界行数(可见带 ± OVERSCAN)
const OLD_EDGE_THRESHOLD = 0.6;  // 旧端翻页触发:距最旧已载端 ≤ 0.6×视口高(A 的
                                 // onEndReachedThreshold=0.6 同口径,§2.2-e 同语义)
const READ_VISIBLE_RATIO = 0.8;  // 已读采集档:行高落入可见带的比例下限(与 A 的
                                 // itemVisiblePercentThreshold 80% 同口径,B2 已读修复)
const HOLD_TTL_MS = 0;           // 预留:hold 的自动回落由消费方驱动,本层不设定时

// 未量测行的估高(估高只影响未进入过窗口的行,进入窗口后被 onLayout 修正;
// 日期/未读分隔条结构固定,给更贴近的初值减少首屏补偿量)
function estimateRowHeight(row) {
  if (!row) return 64;
  if (row.t === 'date') return 44;
  if (row.t === 'unread') return 44;
  return 68;
}

// ============================================================================
// createVirtualBackend()
// 返回协议面实例;RN 宿主经 attachHost({ getNode, scrollTo, getNodes }) 注入。
// ============================================================================
export function createVirtualBackend() {
  const state = {
    entries: [],                 // 行数组(列表空间:新→旧,index 0=最新;唯一事实源)
    heights: new Map(),          // stableId → 量测高(onLayout 回填)
    insets: { top: 0, bottom: 0 }, // 列表空间垂直 inset(top=最新端=视觉底,键盘/底部留白)
    hold: 0,                     // holdOverscrollAction 撑开量(最新边位移,储备机制)
    holdMeta: { movesContent: false },
    presentedY: 0,               // 滚动帧读数(presented;宿主 onScroll 直报)
    modelY: 0,                   // 模型 y(settled 真值;程序滚动即写目标,滚动帧跟随)
    viewport: { h: 0, w: 0 },
    window: { start: 0, end: 0 },
    pendingScroll: null,         // {row, position, animated, onSettled} 待解析滚动目标
    forceMeasureKey: null,       // 需要临时进窗口量测的行
    armed: true,                 // 旧端翻页信号的再触发闸(数据变化/滚离即再武装)
  };

  let host = null; // { getNode, scrollTo(y, animated), getNodes() }

  // —— 行几何 ——
  function rowHeight(row) {
    if (!row) return 64;
    const m = state.heights.get(row.key);
    return m != null ? m : estimateRowHeight(row);
  }
  function offsetOf(index) {
    let sum = state.insets.top + state.hold; // 偏移坐标含顶部 inset 与 hold(最新端侧)
    for (let i = 0; i < index && i < state.entries.length; i++) sum += rowHeight(state.entries[i]);
    return sum;
  }
  function totalContentHeight() {
    return offsetOf(state.entries.length) + state.insets.bottom;
  }
  function maxScrollY() {
    return Math.max(0, totalContentHeight() - state.viewport.h);
  }
  // 行在条目数组中的下标(按 stableId;-1=不在)
  function indexOfKey(key) {
    for (let i = 0; i < state.entries.length; i++) {
      if (state.entries[i] && state.entries[i].key === key) return i;
    }
    return -1;
  }

  // —— 窗口计算(纯函数;宿主每帧/每次数据变化来取) ——
  // 可见带 [presentedY, presentedY + vh](偏移坐标,含 inset/hold 前缀);
  // 窗口=与带相交的行 ± OVERSCAN,并并入 forceMeasureKey(定位解析的量测请求)。
  function computeWindow() {
    const n = state.entries.length;
    if (!n) {
      state.window = { start: 0, end: 0 };
      return state.window;
    }
    const y0 = state.presentedY;
    const y1 = state.presentedY + Math.max(1, state.viewport.h);
    let start = n;
    let end = 0;
    let acc = state.insets.top + state.hold;
    for (let i = 0; i < n; i++) {
      const h = rowHeight(state.entries[i]);
      if (acc + h > y0 && acc < y1) {
        if (i < start) start = i;
        if (i + 1 > end) end = i + 1;
      }
      acc += h;
    }
    if (end <= start) {
      // 带与任何行都不相交(视口未量测/带在空白处):退化到最近端窗口
      start = 0;
      end = Math.min(n, OVERSCAN_ROWS);
    }
    start = Math.max(0, start - OVERSCAN_ROWS);
    end = Math.min(n, end + OVERSCAN_ROWS);
    const fk = state.forceMeasureKey;
    if (fk) {
      const fi = indexOfKey(fk);
      if (fi >= 0) {
        if (fi < start) start = fi;
        if (fi + 1 > end) end = fi + 1;
      }
    }
    state.window = { start, end };
    return state.window;
  }

  // —— 宿主渲染几何(backend-virtual-host 消费) ——
  // 宿主内容布局(内部坐标,翻转前):[paddingTop=insets.top+hold][首行前垫条]
  // [窗口行][尾行后垫条][paddingBottom=insets.bottom];垫条只含行高——inset 与
  // hold 由 padding 独立承担,两层各算各的,绝不双重预留(§2.5-⑤ 不变量)。
  function getWindow() {
    computeWindow();
    const start = state.window.start;
    const end = state.window.end;
    const prefix = state.insets.top + state.hold;
    let before = 0;
    for (let i = 0; i < start; i++) before += rowHeight(state.entries[i]);
    let inWindow = 0;
    for (let i = start; i < end; i++) inWindow += rowHeight(state.entries[i]);
    const allRows = totalContentHeight() - state.insets.bottom - prefix;
    return {
      rows: state.entries.slice(start, end),
      startIndex: start,
      topSpacer: before,
      bottomSpacer: Math.max(0, allRows - before - inWindow),
      paddingTop: prefix,
      paddingBottom: state.insets.bottom,
      contentHeight: totalContentHeight(),
    };
  }

  // —— 可见行真实消息 id 集合(已读上报数据源;相册行取组内最大 readId,
  //     与 A 的 onViewable 映射同口径;空窗口/全存根产出 [])。
  //     minVisibleRatio(B2 已读修复):行高落入可见带的比例下限——0/缺省=
  //     任意相交(onVisibleRange 协议通道的既有口径,门 10-⑫ 对拍基线);
  //     READ_VISIBLE_RATIO=可见比例 ≥80% 判定(onVisibleRangeStrict 已读采集
  //     档,页面已读只采信该通道,与 A 的 80% 单档同语义) ——
  function visibleRealIds(minVisibleRatio) {
    const ratio = Number(minVisibleRatio) || 0;
    computeWindow();
    const y0 = state.presentedY;
    const y1 = state.presentedY + Math.max(1, state.viewport.h);
    const ids = [];
    let acc = state.insets.top + state.hold;
    for (let i = 0; i < state.entries.length; i++) {
      const row = state.entries[i];
      const h = rowHeight(row);
      if (row && row.t === 'msg' && row.msg) {
        const top = acc;
        const bottom = acc + h;
        let hit;
        if (ratio > 0) {
          // 可见比例判定:与可见带的重叠高度 ≥ ratio×行高(无重叠为负值,自然不中)
          hit = Math.min(bottom, y1) - Math.max(top, y0) >= ratio * h;
        } else {
          hit = bottom > y0 && top < y1; // 任意相交(既有口径)
        }
        if (hit) {
          const rid = typeof row.readId === 'number' && row.readId > 0 ? row.readId : row.msg.id;
          if (rid > 0) ids.push(rid);
        }
      }
      acc += h;
    }
    return ids;
  }

  // —— 旧端翻页信号:带远端距最旧已载端 ≤ 0.6×视口高时触发;闸门在数据
  //     变化(事务)或滚离时再武装(A 的 onEndReached 在数据变化后会重评估,
  //     页面 loadOlder 的在途锁/hasOlder 门禁吸收重复触发——同语义) ——
  function maybeReachOlderEdge() {
    if (!state.armed) return;
    const distToEnd = maxScrollY() - state.presentedY;
    if (distToEnd <= OLD_EDGE_THRESHOLD * Math.max(1, state.viewport.h)) {
      state.armed = false;
      backend.onReachOlderEdge();
    }
  }

  function notifyChange() {
    if (host && typeof host.onCoreChanged === 'function') host.onCoreChanged();
  }

  // —— 内容偏移上报:reported = presentedY - hold(TI:hold 期间读 .known(-hold),
  //     「how much content lies beyond that edge」的负值即撑开量) ——
  function reportedOffset() {
    return state.presentedY - state.hold;
  }
  function emitScrolled() {
    backend.onScrolled(reportedOffset(), { atBottom: reportedOffset() <= AT_BOTTOM_EPS });
  }

  // scrollY 补偿(不动画):写模型 y 并驱动宿主滚动;宿主滚动帧回灌 presented。
  // 无宿主时(runner)直接把 presented/model 同步到目标,并按欠上报规则发一帧。
  function applyScrollShift(delta) {
    const target = Math.max(0, Math.min(maxScrollY(), state.presentedY + delta));
    state.modelY = target;
    if (host && typeof host.scrollTo === 'function') {
      host.scrollTo(target, false);
    } else {
      state.presentedY = target;
      emitScrolled();
    }
  }

  const backend = {
    kind: 'virtual', // 协调器 usesBackend 的唯一发布值(§2.3-1)

    // ============ e 页面事件流(组 e) ============
    onScrolled: () => {},          // (offset, {atBottom}) => void
    onVisibleRange: () => {},      // (realIds) => void 协议可见集通道(任意相交,既有口径)
    onVisibleRangeStrict: () => {},// (realIds) => void 已读采集通道(可见比例 ≥80%;页面已读只采信此通道)
    onReachOlderEdge: () => {},    // () => void
    onScrollSettled: () => {},     // () => void 程序滚动落定(定位解析完成/待定收尾/无需滚动;页面据此开 feedGate)

    // —— 宿主注入(attachHost/detachHost;平台细节全在宿主侧) ——
    attachHost(impl) {
      host = impl || null;
      notifyChange();
    },
    detachHost() {
      host = null;
    },

    // —— 窗口几何(宿主每次渲染取用;runner 亦直接观测) ——
    getWindow,

    // —— 宿主滚动帧(presented 读数源):窗口/可见集/贴底/旧端信号都在这里
    //     重算发布;用户滚动帧 = 真值,modelY 跟随(momentum 中 model 滞后于
    //     呈现、静止时收敛,§2.3-7 的 presented 语义)。y 不夹负值:iOS 弹性
    //     回弹越过最新端时保持负读数,与 A(FlatList 原样透传)同口径 ——
    handleHostScroll({ y, viewportHeight, viewportWidth } = {}) {
      if (viewportHeight != null) state.viewport.h = Number(viewportHeight) || 0;
      if (viewportWidth != null) state.viewport.w = Number(viewportWidth) || 0;
      if (y != null) {
        state.presentedY = Number(y) || 0;
        state.modelY = state.presentedY;
      }
      emitScrolled();
      computeWindow();
      backend.onVisibleRange(visibleRealIds());
      backend.onVisibleRangeStrict(visibleRealIds(READ_VISIBLE_RATIO)); // 已读采集档(≥80% 可见比例)
      // 旧端信号随 armed 闸评估(数据变化/滚离即再武装);同位置不会每帧重发
      maybeReachOlderEdge();
      if (maxScrollY() - state.presentedY > OLD_EDGE_THRESHOLD * Math.max(1, state.viewport.h)) {
        state.armed = true; // 滚离旧端:再武装
      }
    },

    // —— 行量测回填(宿主 onLayout):估高修正 + 视口稳定补偿 + 事务外几何
    //     变更欠上报规则(§2.3-7) ——
    // 补偿规则:被量测行整体在可见带的「更新侧」(offset 全程 < presentedY)时,
    // 其高度变化会把带内内容推离原位 → scrollY 补同样的增量,保持用户正在看的
    // 行不动;在带内(局部重排,offset 读数不变)或更旧侧(向远端生长)不补。
    setRowHeight(key, h) {
      const nh = Math.max(1, Math.floor(Number(h)) || 0);
      if (!(nh > 0)) return { changed: false };
      const prev = state.heights.get(key);
      if (prev === nh) return { changed: false };
      const idx = indexOfKey(key);
      const oldH = prev != null ? prev : (idx >= 0 ? estimateRowHeight(state.entries[idx]) : 0);
      state.heights.set(key, nh);
      let shift = 0;
      if (idx >= 0 && state.viewport.h > 0) {
        const rowTop = offsetOf(idx); // 已含新高的前缀不变(前行高度未变)
        if (rowTop + nh <= state.presentedY && nh !== oldH) {
          shift = nh - oldH; // 行整体在可见带更新侧:补滚动保持视口稳定
        }
      }
      if (state.forceMeasureKey === key) state.forceMeasureKey = null;
      notifyChange();
      if (shift !== 0) {
        applyScrollShift(shift);
      }
      // 事务外几何变更欠一次 content-offset 上报:补偿经由 scrollTo 触发滚动
      // 帧(handleHostScroll)自然上报;runner 的宿主桩以 scrollTo→滚动帧链路
      // 验证该链路(门 10-⑥)。可见集在高度变化后立即重发一次(幂等,页面
      // 只进不退吸收)——双通道同发(协议/已读采集)。
      backend.onVisibleRange(visibleRealIds());
      backend.onVisibleRangeStrict(visibleRealIds(READ_VISIBLE_RATIO));
      tryResolvePendingScroll();
      return { changed: true, shift };
    },

    // ============ c 事务 ============
    chatHistoryTransaction(tx) {
      const t = tx || makeTransaction(null);
      const reason = t.updateOpaqueState && t.updateOpaqueState.reason;

      // 1) 量测+重钉合并参数(§2.3-6):与 scrollToItem 同 pass——本层一个事务
      //    至多一次滚动目标,天然「一次移动一次动画」;A 的 completion 补滚
      //    分支由 backend-flatlist 兑现,门 10-⑤ 锁两分支。
      // 2) updateSizeAndInsets:与事务同 pass 提交(TI 不变量);未变化的 inset
      //    是精确 no-op(照抄 corelist「an unchanged inset is an exact no-op」)。
      if (t.updateSizeAndInsets) {
        const ci = t.updateSizeAndInsets.contentInset || {};
        const top = Math.max(0, Number(ci.top) || 0);
        const bottom = Math.max(0, Number(ci.bottom) || 0);
        if (state.insets.top !== top || state.insets.bottom !== bottom) {
          state.insets = { top, bottom };
          state.armed = true;
        }
      }

      // 3) 数据三段(先删→后插→再更;与协调器/A 共用单一实现)
      const prevEntries = state.entries;
      const delSet = new Set(t.deleteIndices || []);
      for (const idx of t.deleteIndices || []) {
        const r = prevEntries[idx];
        if (r) state.heights.delete(r.key); // 离场行高随行丢弃(回场重新量测)
      }
      state.entries = applyTransactionToRows(prevEntries, t);

      // 4) 视口稳定补偿:全替换(reload)跳过——整页重锚定由页面随后下发
      //    scrollToItem;其余按几何补(插入/删除的行整体在可见带更新侧时,
      //    把 scrollY 补上等量,保持用户正在看的行不动;贴底(≤ε)时保持
      //    贴底——新消息出现在最新边,pin-to-edge 自然成立,TI pinsLoadedTop 同构)
      if (reason !== 'reload' && state.viewport.h > 0) {
        let shift = 0;
        const pinned = state.modelY <= PINNED_EPS;
        for (const { index, row } of t.insertIndicesAndItems || []) {
          const at = offsetOf(index); // 插入行的目标偏移(前行高未变)
          const h = rowHeight(row);
          if (!pinned && at + h <= state.modelY) shift += h;
        }
        for (const idx of t.deleteIndices || []) {
          const r = prevEntries[idx];
          if (!r) continue;
          const at = offsetOfPre(prevEntries, idx);
          const h = rowHeight(r);
          if (!pinned && at + h <= state.modelY) shift -= h;
        }
        if (shift !== 0) applyScrollShift(shift);
      }

      // 5) 滚动目标(resolver,§2.5-③):目标行已量测 → 立即定位;未量测 →
      //    宿主先把该行渲染进窗口量测(先量测后回调 pointOffset 的等价链路),
      //    onLayout 回填后 tryResolvePendingScroll 续跑。落定回调 onSettled
      //    (B2 已读修复):解析下发/待定收尾/无需滚动都调——页面据
      //    onScrollSettled 开 feedGate,锚定滚动落定前不采信已读
      if (t.scrollToItem) {
        performScrollTo(t.scrollToItem, t.options.animated, () => backend.onScrollSettled());
      }
      state.armed = true; // 数据变化后旧端信号再武装(与 A 的 onEndReached 重评估同语义)
      computeWindow();
      notifyChange();

      // 6) completion=布局落地帧(§2.2-c):本层事务同步应用完毕,把 completion
      //    排到下一拍,并在落点报一次 settled 读数(§2.3-7:事务点报 settled,
      //    事务外的补偿/hold 变化由滚动帧/本处补报,绝不欠报)
      scheduleCompletion(() => {
        t.completion(true);
        emitScrolled();
      });
    },

    // ============ a 窄滚动访问器 ============
    getContentHeight() {
      return state.viewport.h > 0 || state.entries.length ? totalContentHeight() : null;
    },
    getBounces() {
      return true; // 宿主 ScrollView bounces 缺省(iOS);配置读数同 A 口径
    },

    // ============ b 意图命名成员 ============
    // settled 双读数(同一次采样,§2.2-b 禁拆;事务点=模型 y 的 settled 终点,
    // 滚动帧由 onScrolled 报 presented——两种几何两个出口,不混用)。
    // 【落地口径】modelY 每帧无条件跟随 presentedY(handleHostScroll :250-253),
    // 程序动画滚动在途时 settled 读数=动画中途值,与「settled 终点」字面有差:
    // 最小改法是如实注明而非引入目标值保持(现消费面仅 scrollToEndOfHistory
    // 贴底短路,最坏多滚一次;2026-10-12 复核留痕)。
    // bottom=距最新端(0=贴住,正值=向旧端滚开,hold 期间按 TI 读负值=-hold);
    // top=距最旧已载端。
    settledContentOffsets() {
      const y = state.modelY;
      return {
        top: maxScrollY() - y,
        bottom: y - state.hold,
      };
    },
    holdOverscrollAction(distance, movesContent) {
      // TI holdOverscrollAction:把最新消息边撑开 distance(列表空间 px);
      // movesContent=false 咬住呈现位置、true 回程斜坡携带内容。release 斜坡
      // 语义随消费方落地(§2.5-⑩ 储备);撑开本身经 insets.top+hold 进窗口
      // 几何,offset 读数按 -hold 报(TI:held 时 .known(-distance))。
      state.hold = Math.max(0, Number(distance) || 0);
      state.holdMeta = { movesContent: !!movesContent };
      notifyChange();
      emitScrolled(); // 几何变了,欠一次上报(§2.3-7)
    },
    holdsOverscrollActionDuringDrag() {
      return false; // 拖拽中不维持撑开(v1 无消费方;机制储备 §2.5-⑩)
    },
    getScrollHostNode() {
      if (host && typeof host.getNode === 'function') {
        try {
          return host.getNode() || null;
        } catch (_e) {
          return null;
        }
      }
      return null;
    },
    didInteractivelyDragFromTopOrigin() {
      // TI 合并成员(禁拆两半):「本次拖拽从最新边开始且内容移动过」。
      // 宿主经 handleDragBegin/handleHostScroll 喂两半,状态只在拖拽 begin
      // 复位(活到读它的布局 pass,容差 10px 抄 ListView.swift:4959)。
      return backend._drag.beganPinned && backend._drag.moved;
    },

    // —— 拖拽起源采样(宿主 onScrollBeginDrag/onScrollEndDrag 调) ——
    handleDragBegin() {
      backend._drag.beganPinned = reportedOffset() <= 10;
      backend._drag.moved = false;
    },
    handleDragEnd() { /* 终态冻结到下一次 begin;不在 end 复位(TI 同款) */ },

    // ============ d 枚举器 + 几何 ============
    // 真节点=宿主当前渲染的行视图引用(getNodes() 由宿主每次窗口渲染后刷新)。
    // 枚举器返回真节点 ≠ 几何正确:几何一律走 itemNodeFrame(TI 教训)。
    forEachItemNode(fn) {
      if (typeof fn !== 'function') return;
      const nodes = host && typeof host.getNodes === 'function' ? host.getNodes() : null;
      if (!nodes) return;
      for (let i = state.window.start; i < state.window.end; i++) {
        const row = state.entries[i];
        const node = row && nodes.get ? nodes.get(row.key) : null;
        if (row && node) fn({ row, node });
      }
    },
    forEachVisibleItemNode(fn) {
      if (typeof fn !== 'function') return;
      const y0 = state.presentedY;
      const y1 = state.presentedY + Math.max(1, state.viewport.h);
      const nodes = host && typeof host.getNodes === 'function' ? host.getNodes() : null;
      if (!nodes) return;
      let acc = state.insets.top + state.hold;
      for (let i = 0; i < state.entries.length; i++) {
        const row = state.entries[i];
        const h = rowHeight(row);
        if (acc + h > y0 && acc < y1 && row) {
          const node = nodes.get ? nodes.get(row.key) : null;
          if (node) fn({ row, node });
        }
        acc += h;
      }
    },
    enumerateItemNodes() {
      const out = [];
      backend.forEachItemNode((entry) => out.push(entry));
      return out;
    },
    forEachItemHeaderNode(_fn) {
      // 空遍历:日期/未读分隔在本仓是占位行(现状行为保留),非 attached 头
      // (§2.5-⑤ 落地偏差,见文件头注)
    },
    // 列表空间帧;null=行不在加载窗口(存活判据)。精度=量测帧(§2.7-3)。
    itemNodeFrame(row) {
      if (!row) return null;
      const idx = indexOfKey(row.key);
      if (idx < 0) return null;
      computeWindow();
      if (idx < state.window.start || idx >= state.window.end) return null;
      const h = state.heights.get(row.key);
      if (h == null) return null; // 未量测行不给假几何
      return { x: 0, y: offsetOf(idx), width: state.viewport.w, height: h };
    },
    itemHeaderNodeFrame(_row) {
      return null; // 无附着头(v1,见文件头注)
    },

    // —— 定位解析(§2.5-③ resolver):三种 position 需要目标行高;历史跳转时
    //     目标常未量测 → 先把目标渲染进窗口量测 → onLayout 回调 → 计算
    //     pointOffset → 滚动。top/center/bottom 三态按视口上下/居中映射。 ——
    // _internals 仅供 runner 观测(非协议面)
    _internals: state,
    _resolveScrollTarget(target) {
      const idx = indexOfKey(target.row && target.row.key);
      if (idx < 0) return null;
      const rowTop = offsetOf(idx);
      const h = rowHeight(state.entries[idx]);
      const vh = Math.max(1, state.viewport.h);
      const position = target.position || 'center';
      let y;
      if (position === 'top') y = rowTop + h - vh;          // 行贴视口视觉顶(远端)
      else if (position === 'bottom') y = rowTop;           // 行贴视口视觉底(近端/最新端)
      else y = rowTop + h / 2 - vh / 2;                     // 居中(现状 viewPosition 0.5 口径)
      return Math.max(0, Math.min(maxScrollY(), y));
    },
  };

  backend._drag = { beganPinned: false, moved: false };

  // —— 事务驱动的滚动(定位 resolver 主路径)。onSettled 落定口径(B2 已读
  //     修复,与 A 的 performScroll 同语义):定位指令下发、待定滚动收尾
  //     (解析完成/目标离场/解析无望)、无需滚动(目标不在集合)都回调 ——
  function performScrollTo(target, animated, onSettled) {
    const done = typeof onSettled === 'function' ? onSettled : null;
    const idx = indexOfKey(target.row && target.row.key);
    if (idx < 0) {
      if (done) done(); // 目标行不在集合(存活判据外):不滚,立即落定
      return false;
    }
    if (state.heights.has(target.row.key) && state.viewport.h > 0) {
      const y = backend._resolveScrollTarget(target);
      if (y == null) {
        if (done) done();
        return false;
      }
      state.modelY = y;
      if (host && typeof host.scrollTo === 'function') {
        host.scrollTo(y, !!animated);
      } else {
        state.presentedY = y;
        emitScrolled();
      }
      if (done) done(); // 定位指令已下发:落定
      return true;
    }
    // 目标行未量测:请求宿主把它渲染进窗口(onLayout 回填后继续)。
    // 「先量测后回调 pointOffset」的等价链路,门 10-④ 锁三态与本路径。
    // 在途的待定滚动被顶替:旧落定回调当场了结(重试耗尽语义),防悬挂
    const prev = state.pendingScroll;
    if (prev && prev.onSettled) prev.onSettled();
    state.pendingScroll = { row: target.row, position: target.position || 'center', animated: !!animated, onSettled: done };
    state.forceMeasureKey = target.row.key;
    computeWindow();
    notifyChange();
    return false;
  }

  // 量测回填后续跑待定滚动(可能仍缺视口高/仍解析不出,保持待定);目标行
  // 已离场(事务删除)时解析无望,按重试耗尽落定并清挂起
  function tryResolvePendingScroll() {
    const p = state.pendingScroll;
    if (!p) return;
    if (!(state.viewport.h > 0)) return;
    if (indexOfKey(p.row.key) < 0) {
      state.pendingScroll = null;
      state.forceMeasureKey = null;
      if (p.onSettled) p.onSettled();
      return;
    }
    if (!state.heights.has(p.row.key)) return;
    const y = backend._resolveScrollTarget(p);
    if (y == null) {
      state.pendingScroll = null;
      state.forceMeasureKey = null;
      if (p.onSettled) p.onSettled();
      return;
    }
    state.pendingScroll = null;
    state.forceMeasureKey = null;
    state.modelY = y;
    if (host && typeof host.scrollTo === 'function') {
      host.scrollTo(y, p.animated);
    } else {
      state.presentedY = y;
      emitScrolled();
    }
    if (p.onSettled) p.onSettled(); // 待定滚动解析并下发:落定
  }

  // completion 调度(缺省下一拍;runner 注入受控调度以观察落地帧顺序)
  let completionScheduler = (fn) => setTimeout(fn, 0);
  function scheduleCompletion(fn) {
    completionScheduler(fn);
  }
  backend.setCompletionScheduler = (fn) => {
    if (typeof fn === 'function') completionScheduler = fn;
  };

  // 删除行的 pre-transaction 偏移(补偿计算用;前行集合=prevEntries)
  function offsetOfPre(prevEntries, index) {
    let sum = state.insets.top + state.hold;
    for (let i = 0; i < index && i < prevEntries.length; i++) {
      const r = prevEntries[i];
      const m = r ? state.heights.get(r.key) : null;
      sum += m != null ? m : estimateRowHeight(r);
    }
    return sum;
  }

  assertBackendMembers(backend, 'virtual');
  return backend;
}
