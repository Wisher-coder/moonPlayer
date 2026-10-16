// ============================================================================
// history-backend.js —— 聊天历史双后端·协议定义(Telegram-iOS ChatHistoryListViewBackend 等价)
// ----------------------------------------------------------------------------
// 参照系:.fixtmp/tgios-pages-blueprint.md §2.2(协议成员表/事务字段/协议纪律)。
// 协议刻意独立:不 refine 任何通用列表抽象,只声明协调器真正访问的成员——
// TI 的 ChatHistoryListViewBackend 约 37 个重叠成员重复声明是 by-design(蓝图
// §2.2-纪律 1),「新增一处 backend.<member> 访问必须同步加协议成员并两后端
// 同时实现」,齐备性由 app/scripts/test-history-backends.mjs(门 10)断言兜底。
//
// 分层铁律(蓝图 §2.1):本文件与 history-coordinator.js / backend-virtual-core.js /
// backend-flatlist.js 一律零 RN import,runner 直接加载;任何 RN import 只允许
// 出现在 backend-virtual-host.jsx 与 backend-setting.js。
//
// 坐标系约定(蓝图 §0.3/§2.5-⑨):两后端对协调器呈现同一「列表空间」——
// 数据序恒新→旧、index 0=最新;滚动偏移 y 以「最新消息边」为 0(0=贴最新端,
// 向更旧方向增大,iOS 弹性回弹越过最新端为负)——与 inverted FlatList 的
// contentOffset.y 同一套数值(chat/[id].js:93 现状口径),§2.2-d 的几何 API
// (itemNodeFrame/itemHeaderNodeFrame)一律列表空间。
// ============================================================================
// 协议成员清单(四组,§2.2 成员表;意图命名,禁止机制名——TI
// setTopContentIndent→holdOverscrollAction 更名教训,蓝图 §2.2-纪律 2)
export const BACKEND_MEMBERS = Object.freeze([
  // a 窄滚动访问器
  'getContentHeight',                  // () => number|null 列表内容总高(列表空间);不可知回 null
  'getBounces',                        // () => boolean 弹性回弹配置读数
  // b 意图命名(把「机制」藏进意图后)
  'holdOverscrollAction',              // (distance, movesContent) => void 把最新消息边撑开 distance
  'holdsOverscrollActionDuringDrag',   // () => boolean 拖拽中是否维持撑开
  'getScrollHostNode',                 // () => node|null 实际可滚动宿主(≠页面根)
  'didInteractivelyDragFromTopOrigin', // () => boolean 本次拖拽是否从最新边开始(TI 合并成员,禁拆两半)
  'settledContentOffsets',             // () => {top,bottom}|null settled 几何双读数(同一次采样)
  // c 事务(TI 主事务签名逐项,字段表见 makeTransaction)
  'chatHistoryTransaction',            // (tx) => void
  // d 枚举器 + 几何(枚举真节点 ≠ 几何正确;几何一律走 itemNodeFrame)
  'forEachItemNode',                   // (fn({row, node})) => void
  'forEachVisibleItemNode',            // (fn({row, node})) => void
  'enumerateItemNodes',                // () => [{row, node}]
  'forEachItemHeaderNode',             // (fn({row, node})) => void
  'itemNodeFrame',                     // (row) => {x,y,width,height}|null(列表空间;null=行不在加载窗口)
  'itemHeaderNodeFrame',               // (row) => {x,y,width,height}|null
  // e 页面事件流输出(页面既有事件消费面全部改接这三个回调,页面不得绕过
  //   后端直挂列表回调——蓝图 §2.2-e 硬性语义)
  'onScrolled',                        // (offset, {atBottom}) => void 滚动读数(presented)+贴底判定
  'onVisibleRange',                    // (realIds: number[]) => void 可见行真实消息 id 集合(已读数据源)
  'onReachOlderEdge',                  // () => void 到达视觉旧端(旧向翻页触发)
]);

// 开关取值(蓝图 §2.6):'auto'/'flatlist' 缺省解析为 A;'virtual' 强制 B。
// 无服务端 killswitch——单机自部署无服务器 app config 通道,设备级退出=切回
// 'auto',如实不做(不为它新增服务端能力)。
export const HISTORY_BACKEND_STORAGE_KEY = 'moontent_tg_history_backend';
export const HISTORY_BACKEND_VALUES = Object.freeze(['auto', 'flatlist', 'virtual']);

// 三态 → 实际后端解析(纯函数,零依赖,门 10-⑨ 直测):setting 缺失/'auto'/
// 非法值一律回落 A(FlatList 后端)=缺省回滚面;只有显式 'virtual' 才进 B。
export function resolveBackendKind(raw) {
  return raw === 'virtual' ? 'virtual' : 'flatlist';
}

// 后端 kind 常量与切换/文案工具:页面代码禁止出现 'flatlist'/'virtual' 字面量
// (蓝图 §2.6 usesBackend 防重推,复核 grep 项)——聊天层一切后端相关分支只读
// coordinator.usesBackend 或经本组工具取值,字面量只住在本目录与测试脚本。
export const BACKEND_FLATLIST = 'flatlist';
export const BACKEND_VIRTUAL = 'virtual';

// 调试开关的「另一个」后端(A↔B 互切;§2.6 调试入口)
export function switchBackendKind(kind) {
  return kind === BACKEND_VIRTUAL ? BACKEND_FLATLIST : BACKEND_VIRTUAL;
}

// 调试菜单文案(当前后端的人话名;中文文案随本目录维护)
export function backendKindLabel(kind) {
  return kind === BACKEND_VIRTUAL ? '虚拟列表' : 'FlatList';
}

// 「在底部」判定阈值:视觉底部 64px 内视为已到底(chat/[id].js:93 BOTTOM_EPS
// 现状口径;两后端的 onScrolled.atBottom 必须同口径,门 10-⑫ 锁同语义)。
export const AT_BOTTOM_EPS = 64;
// settled 判定 ε:TI scrollToEndOfHistory 以 .known(value)<=ulpOfOne 短路
// (corelist 文档「Content offsets」节);JS 侧取半像素,避开亚点物理残差
// (同文档「a third of a point of physics」教训:阈值判据对亚点残差敏感)。
export const PINNED_EPS = 0.5;
// TI ListView/事务的 MAX_INT(corelist 文档:全替换 [.Reload] 的
// stationaryItemRange 传 [0, MAX_INT])。
export const MAX_INT = 0x7fffffff;

// 事务缺省字段组装(TI 主事务签名的 JS 等价;Swift 无默认参数 → extension
// convenience 的等价 = 本工厂,蓝图 §2.2-c)。字段语义:
//   deleteIndices           降序(pre-transaction 下标)
//   insertIndicesAndItems   升序({index,row};应用顺序=先删→后插→再更新)
//   updateIndicesAndItems   升序({index,row};stableVersion 变化的原位替换)
//   options.animated        v1 唯一动画开关(per-item 选择性动画不支持,§2.7-1)
//   scrollToItem            {row, position:'top'|'center'|'bottom', offset?} | null
//   additionalScrollDistance 缺省 0(TI 聊天层恒 0,corelist 文档实读)
//   updateSizeAndInsets     {contentInset:{top,bottom}} | null 与事务同 pass 提交
//   stationaryItemRange     [fromIdx,toIdx]|null 承重值:全替换 [0,MAX_INT];
//                           贴底发送 [maxInserted+1,MAX_INT](蓝图 §2.2 字段表)
//   customAnimationTransition v1 不支持:传入按 options.animated 处理(§2.7-2)
//   maintainsUnreadItemAlignment 量测+重钉合并参数(TI 两个半边分跨 inset 变化
//                           会静默破坏——禁拆两半,蓝图 §2.2-纪律 3)
//   updateOpaqueState       纯存储,无行为(安全 stub 语义)
//   completion              (applied) => void 事务落地回调(A=已下发,B=布局落地帧)
export function makeTransaction(partial) {
  const p = partial || {};
  return {
    deleteIndices: Array.isArray(p.deleteIndices) ? p.deleteIndices : [],
    insertIndicesAndItems: Array.isArray(p.insertIndicesAndItems) ? p.insertIndicesAndItems : [],
    updateIndicesAndItems: Array.isArray(p.updateIndicesAndItems) ? p.updateIndicesAndItems : [],
    options: { animated: !!(p.options && p.options.animated) },
    scrollToItem: p.scrollToItem || null,
    additionalScrollDistance: Number(p.additionalScrollDistance) || 0,
    updateSizeAndInsets: p.updateSizeAndInsets || null,
    stationaryItemRange: Array.isArray(p.stationaryItemRange) ? p.stationaryItemRange : null,
    customAnimationTransition: p.customAnimationTransition || null,
    maintainsUnreadItemAlignment:
      p.maintainsUnreadItemAlignment === undefined ? null : !!p.maintainsUnreadItemAlignment,
    updateOpaqueState: p.updateOpaqueState === undefined ? null : p.updateOpaqueState,
    completion: typeof p.completion === 'function' ? p.completion : () => {},
  };
}

// 协议齐备性断言(「编译即检查」的 JS 等价;构造两后端时各跑一次,门 10-①
// 用同一函数全表核对)。缺失成员 → 抛中文错(含缺失清单),绝不静默。
export function assertBackendMembers(backend, label) {
  const missing = [];
  for (const m of BACKEND_MEMBERS) {
    if (!backend || typeof backend[m] !== 'function') missing.push(m);
  }
  if (missing.length) {
    throw new Error('聊天历史后端(' + (label || '?') + ')缺少协议成员:' + missing.join(', '));
  }
  return true;
}
