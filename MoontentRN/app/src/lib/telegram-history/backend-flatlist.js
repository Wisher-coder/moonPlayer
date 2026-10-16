// ============================================================================
// backend-flatlist.js —— 聊天历史后端 A:FlatList 桥(现状能力,缺省后端)
// ----------------------------------------------------------------------------
// 参照系:.fixtmp/tgios-pages-blueprint.md §2.4。
// 命名注:任务原文「FlashList 后端」系沿袭误称——聊天时间线是 RN FlatList
// (import { FlatList } from 'react-native'),且正是因 FlashList v2 不支持
// inverted 才不用它;flash-list 只用于对话列表页等网格页。本文件与 setting
// 值一律 FlatListBackend / 'flatlist';M1 禁止引入 @shopify/flash-list。
//
// 宿主=现有 FlatList inverted + maintainVisibleContentPosition(chat/[id].js
// 既有配置整体迁入后端装配——getListProps() 供页面展开,页面不再直配行为项)。
// 本文件零 RN import(分层铁律):RN 面只剩「页面持有 listRef 并经
// getListNode() 注入」这一条 wrapper 边界——平台细节留 wrapper(任务不变量:
// 几何/取数/锚定归 backend,平台细节留 wrapper)。
//
// 范围外成员安全 stub 表(TI:范围外成员是安全 stub,no-op 闭包或纯存储,
// 绝不崩——corelist 文档「Scope」节):
//   holdOverscrollAction      no-op + 存储 distance(现状键盘避让在输入区层、
//                             不撑列表;激活条件:接入「底部撑开」类需求时,
//                             把存储值转成 FlatList 的 contentInset/top 級调
//                             整并在滚动读数里减去——本版不做)
//   holdsOverscrollActionDuringDrag  false
//   itemNodeFrame/itemHeaderNodeFrame  null(v1 几何消费点为 0,安全;
//                             FlatList 无逐帧量测帧可读)
//   forEachItemNode 等        空遍历(v1 无真节点注册面)
//   customAnimationTransition 按 options.animated 退化(§2.7-2)
// ----------------------------------------------------------------------------
// 消息整体滑入(TI animateInsertedBlock:块为单位、index0 锚定+连续插入才
// 生效)的 A 等价=贴底时 index0 连续插入 + mVCP autoscrollToTopThreshold:100
// 吸底(现状行为);不贴底时不做插入动画,判据=mVCP 阈值自身。
// ============================================================================
import {
  AT_BOTTOM_EPS, assertBackendMembers, makeTransaction, PINNED_EPS,
} from './history-backend.js';
import { applyTransactionToRows } from './history-coordinator.js';

// 模块级常量:FlatList 的 viewabilityConfig / mVCP 配置对象引用必须跨渲染恒稳
// (chat/[id].js 现状同款:对象引用变化会导致 FlatList 重置 viewability 状态)
// 可见阈值取舍(2026-10-12 已读准确性修复):单档 80%(原 50%)。曾按任务首选
// 评估 viewabilityConfigCallbackPairs 双档(50% 既有 + 80% 已读采集),但
// react-native-web 的 FlatList 不允许 onViewableItemsChanged 与 pairs 并存
// (0.21.3 源码 invariant,两者同传直接抛错),而 50% 档在页面已读改采
// onVisibleRangeStrict 通道后已无任何消费方——如实降级为单档 80%,不保留
// 无消费方的 50% 档(取舍已记录在任务结果;协议通道 onVisibleRange 与已读
// 采集通道 onVisibleRangeStrict 同集双发,见 handleHostViewable)
const VIEWABILITY = { itemVisiblePercentThreshold: 80 };
const MVP_CONF = { minIndexForVisible: 1, autoscrollToTopThreshold: 100 };

// ============================================================================
// createFlatlistBackend({ getListNode, publishRows })
//   getListNode () => FlatList 实例引用|null —— 页面持有的 listRef 注入(wrapper 边界)
//   publishRows (rows) => void —— 事务应用后的行数组发布(页面 setState 进
//                 FlatList data;A 的「渲染」=把事务重建结果交给宿主)
// ============================================================================
export function createFlatlistBackend({ getListNode, publishRows } = {}) {
  if (typeof getListNode !== 'function') throw new Error('FlatList 后端缺少 listRef 访问器');
  if (typeof publishRows !== 'function') throw new Error('FlatList 后端缺少行发布回调');

  const backend = {
    kind: 'flatlist', // 协调器 usesBackend 的唯一发布值(§2.3-1)

    // —— 内部状态(纯逻辑,runner 直测) ——
    appliedRows: [],   // 已应用行(事务重建结果;发布给宿主的同一份内容)
    lastScroll: null,  // 最近一次滚动读数 {y, contentHeight, viewportHeight, at}
    drag: { beganPinned: false, moved: false }, // 拖拽起源采样(见 didInteractivelyDragFromTopOrigin)
    pendingSettle: null, // performScroll 在途的滚动落定回调(宿主侧量测失败
                       // onScrollToIndexFailed 占用,由其重试收尾统一落定;见 performScroll)

    // ============ e 页面事件流(组 e;页面把消费面接到这些回调上) ============
    onScrolled: () => {},           // (offset, {atBottom}) => void
    onVisibleRange: () => {},       // (realIds) => void 协议可见集通道(单档 80% 口径,取舍见 VIEWABILITY 注)
    onVisibleRangeStrict: () => {}, // (realIds) => void 已读采集通道(≥80% 可见档;页面已读只采信此通道)
    onReachOlderEdge: () => {},     // () => void
    onScrollSettled: () => {},      // () => void 程序滚动落定(performScroll 成功/重试耗尽/无需滚动都调;页面据此开 feedGate)

    // —— 宿主 props(onScroll/onViewable/onEndReached/onScrollToIndexFailed
    //      全部在这里收口,页面不得绕过后端直挂列表回调——§2.2-e 硬性语义)。
    //      返回对象与全部回调引用跨渲染恒稳:react-native-web 的 FlatList 对
    //      onViewableItemsChanged 有 identity invariant(引用一变即抛「Changing
    //      onViewableItemsChanged on the fly is not supported」,实测 0.21.3),
    //      页面每渲染都展开 {...getListProps()},不缓存则任何一次重渲(如输入
    //      联动)都会炸;配置对象(VIEWABILITY/MVP_CONF)恒稳本就是既有约定 ——
    getListProps() {
      if (!this._listProps) {
        this._listProps = {
          inverted: true,
          maintainVisibleContentPosition: MVP_CONF,
          viewabilityConfig: VIEWABILITY,
          initialNumToRender: 12,
          onEndReachedThreshold: 0.6,
          scrollEventThrottle: 16,
          keyboardShouldPersistTaps: 'handled',
          showsVerticalScrollIndicator: false,
          onScroll: (e) => this.handleHostScroll(e),
          onScrollBeginDrag: () => this.handleDragBegin(),
          onScrollEndDrag: () => { /* 终态由 drag 标志冻结到下一次 begin(状态只在 begin 复位,见下) */ },
          onViewableItemsChanged: (info) => this.handleHostViewable(info),
          onEndReached: () => { this.onReachOlderEdge(); },
          onScrollToIndexFailed: (info) => this.handleScrollToIndexFailed(info),
        };
      }
      return this._listProps;
    },

    // —— 滚动读数透传:atBottom=offset≤64(chat/[id].js:93 现状口径);
    //     didInteractivelyDragFromTopOrigin 的「内容移动过」半边在此积累 ——
    handleHostScroll(e) {
      const ne = (e && e.nativeEvent) || {};
      const y = ne.contentOffset ? Number(ne.contentOffset.y) || 0 : 0;
      const h = ne.contentSize ? Number(ne.contentSize.height) || 0 : 0;
      const vh = ne.layoutMeasurement ? Number(ne.layoutMeasurement.height) || 0 : 0;
      this.lastScroll = { y, contentHeight: h, viewportHeight: vh, at: Date.now() };
      if (this.drag.beganPinned) this.drag.moved = true;
      this.onScrolled(y, { atBottom: y <= AT_BOTTOM_EPS });
    },

    // —— 拖拽起源采样(TI 合并成员的两半都在 begin 一并复位、不在 end 复位:
    //     值要活到读它的那次布局 pass;容差 10px 照抄 ListView.swift:4959) ——
    handleDragBegin() {
      this.drag.beganPinned = !!(this.lastScroll && this.lastScroll.y <= 10);
      this.drag.moved = false;
    },

    // —— 可见集透传:可见行真实消息 id 集合(已读上报数据源;相册合流行取
    //     组内最大 readId——chat/[id].js:391-404 现状口径);空窗口产出 []。
    //     双通道同集双发:协议通道 onVisibleRange(既有)+ 已读采集通道
    //     onVisibleRangeStrict——宿主配置已是单档 80%(见 VIEWABILITY 注),
    //     页面已读只采信 strict 通道,阈值收紧即在此生效 ——
    handleHostViewable(info) {
      const list = (info && info.viewableItems) || [];
      const ids = [];
      for (let vi = 0; vi < list.length; vi++) {
        const row = list[vi] && list[vi].item;
        if (!row || row.t !== 'msg' || !row.msg) continue;
        const rid = typeof row.readId === 'number' && row.readId > 0 ? row.readId : row.msg.id;
        if (rid > 0) ids.push(rid);
      }
      this.onVisibleRange(ids);
      this.onVisibleRangeStrict(ids);
    },

    // ============ c 事务 ============
    // 应用顺序:先删(降序)→ 后插(升序)→ 再更新(与协调器共用
    // applyTransactionToRows 单一实现,防两处口径漂移);应用即发布(页面
    // setState 进 FlatList data)——completion 语义=「已下发」(§2.2-c)。
    chatHistoryTransaction(tx) {
      const t = tx || makeTransaction(null);
      this.appliedRows = applyTransactionToRows(this.appliedRows, t);
      publishRows(this.appliedRows.slice());
      if (t.scrollToItem) {
        // 滚动落定回调:成功/重试耗尽/无需滚动都会调——页面据 onScrollSettled
        // 开 feedGate(锚定滚动落定前不采信已读,防视口扫过的行被误标读)
        this.performScroll(t.scrollToItem, t.options.animated, () => this.onScrollSettled());
      }
      t.completion(true);
    },

    // —— scrollToItem:行 → 下标 → scrollToIndex(viewPosition 按位映射)。
    //     position 'bottom' 且目标即最新行(index 0)=回底,走 scrollToOffset(0)
    //     (chat/[id].js goBottom 现状口径,等价于 viewPosition 1 的数学结果);
    //     其余 top→0 / center→0.5 / bottom→1。量测未就绪的失败由宿主
    //     onScrollToIndexFailed 兜底(见下);直接路径失败补一次延时重试。
    //     onSettled 落定口径(B2 已读修复):滚动指令下发成功、重试耗尽、无需
    //     滚动(目标缺位/未挂载/不在已应用窗口)三类终态都回调且只回调一次;
    //     宿主侧失败(scrollToIndex 内部同步转 onScrollToIndexFailed)经
    //     pendingSettle 占位,由 handleScrollToIndexFailed 的重试收尾落定 ——
    performScroll(target, animated, onSettled) {
      const done = typeof onSettled === 'function' ? onSettled : null;
      const row = target && target.row;
      if (!row) {
        if (done) done(); // 无需滚动:立即落定
        return false;
      }
      const list = getListNode();
      if (!list) {
        if (done) done();
        return false;
      }
      const position = target.position || 'center';
      const idx = this.appliedRows.findIndex((r) => r && r.key === row.key);
      if (idx < 0) {
        if (done) done(); // 行不在已应用窗口(存活判据外):不滚,立即落定
        return false;
      }
      if (idx === 0 && position === 'bottom') {
        try {
          list.scrollToOffset({ offset: 0, animated: !!animated });
        } catch (_e) {
          if (done) done();
          return false;
        }
        if (done) done();
        return true;
      }
      const viewPosition = position === 'top' ? 0 : position === 'bottom' ? 1 : 0.5;
      // 先占位再下发:宿主对未量测行会在 scrollToIndex 内部同步回调
      // onScrollToIndexFailed,该回调占用 pendingSettled 后由其重试收尾落定
      this.pendingSettle = done;
      try {
        list.scrollToIndex({ index: idx, animated: !!animated, viewPosition });
        if (this.pendingSettle === done) {
          this.pendingSettle = null;
          if (done) done(); // 指令下发成功且未被宿主失败路径占用:当场落定
        }
        return true;
      } catch (_e) {
        // 量测未就绪:延时重试一次(屡试不中交给 onScrollToIndexFailed 兜底;
        // 保持现状行为——chat/[id].js 锚定滚动同款 300ms 延时口径);重试
        // 收尾(无论成败)统一落定
        setTimeout(() => {
          if (this.pendingSettle === done) this.pendingSettle = null;
          const l = getListNode();
          try {
            if (l) l.scrollToIndex({ index: idx, animated: false, viewPosition });
          } catch (_e2) { /* 保持现状 */ }
          if (done) done();
        }, 300);
        return false;
      }
    },

    // onScrollToIndexFailed 兜底:虚拟化窗口未量测到目标行时延时重试,并夹到
    // 最近已量测行(屡试不中退化为部分定位;chat/[id].js:365-376 现状迁入)。
    // 若 performScroll 有在途落定回调(pendingSettled 被本路径占用),重试
    // 收尾(无论成败)统一落定——锚定滚动真正结束前 feedGate 不开
    handleScrollToIndexFailed(info) {
      const done = this.pendingSettle;
      this.pendingSettle = null;
      setTimeout(() => {
        const list = getListNode();
        if (!list) {
          if (done) done();
          return;
        }
        const hi = info && info.highestMeasuredFrameIndex != null ? info.highestMeasuredFrameIndex : 0;
        const idx = Math.max(0, Math.min(info.index, hi));
        try {
          list.scrollToIndex({ index: idx, animated: false, viewPosition: 0.5 });
        } catch (_e) { /* 保持现状 */ }
        if (done) done();
      }, 300);
    },

    // ============ a 窄滚动访问器 ============
    getContentHeight() {
      return this.lastScroll && this.lastScroll.contentHeight > 0 ? this.lastScroll.contentHeight : null;
    },
    getBounces() {
      return true; // iOS FlatList 缺省 true(§2.2-a;宿主未改 bounces 配置)
    },

    // ============ b 意图命名成员 ============
    // settled 双读数(同一次采样;A 无逐帧回调 → 回最新已知读数,注释如实:
    // 非严格 settled——滚动动画进行中读到的是动画中途值,由下一帧修正)。
    // bottom=距最新端(0=贴住,正值=向旧端滚开,负=iOS 回弹越过最新端);
    // top=距最旧已载端(0=旧端贴住,正值=还有已载内容在旧端之外,短内容为负)。
    settledContentOffsets() {
      const s = this.lastScroll;
      if (!s || s.viewportHeight <= 0) return null;
      return {
        top: s.contentHeight - s.viewportHeight - s.y,
        bottom: s.y,
      };
    },
    holdOverscrollAction(distance, movesContent) {
      // 安全 stub:纯存储,无行为(见文件头 stub 表与激活条件注释)
      this._overscrollHold = { distance: Number(distance) || 0, movesContent: !!movesContent };
    },
    holdsOverscrollActionDuringDrag() {
      return false;
    },
    getScrollHostNode() {
      const list = getListNode();
      if (list && typeof list.getScrollableNode === 'function') {
        try {
          return list.getScrollableNode() || null;
        } catch (_e) {
          return null;
        }
      }
      return null;
    },
    // TI 合并成员:本次拖拽是否从最新边开始(两半合并,禁拆;状态只在拖拽
    // begin 复位,活到读取它的布局 pass)
    didInteractivelyDragFromTopOrigin() {
      return this.drag.beganPinned && this.drag.moved;
    },

    // ============ d 枚举器 + 几何(v1 安全 stub,消费点为 0) ============
    forEachItemNode(_fn) { /* 空遍历:FlatList 桥无真节点注册面(v1) */ },
    forEachVisibleItemNode(_fn) { /* 同上 */ },
    enumerateItemNodes() {
      return []; // 枚举器返回真节点 ≠ 几何正确;几何一律走 itemNodeFrame
    },
    forEachItemHeaderNode(_fn) { /* 空遍历:日期/未读分隔在本仓是占位行,非附着头 */ },
    itemNodeFrame(_row) {
      return null; // v1 无量测帧,几何消费点为 0,null=行不在加载窗口(存活判据)
    },
    itemHeaderNodeFrame(_row) {
      return null;
    },
  };

  assertBackendMembers(backend, 'flatlist');
  return backend;
}
