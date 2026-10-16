// ============================================================================
// backend-virtual-host.jsx —— 聊天历史后端 B:RN 薄宿主(虚拟列表的平台层)
// ----------------------------------------------------------------------------
// 参照系:.fixtmp/tgios-pages-blueprint.md §2.5 宿主职责行。职责最小化:
//   · ScrollView inverted + onScroll(presented 读数,经协议 onScrolled 发布);
//   · 窗口渲染(core 算窗口,可见行集合经 onVisibleRange 发布——在 core 内);
//   · 行 onLayout 量测回填 core;
//   · 窗口触达已载最旧行经 onReachOlderEdge 发布翻页信号(core 内判定)。
// 吸底自管(无 mVCP):贴底判定 offset ≤ 64px(chat/[id].js:93 BOTTOM_EPS
// 语义,core 的 AT_BOTTOM_EPS 同值);贴底时新消息插入不补偿滚动,pin-to-edge
// 自然成立(TI pinsLoadedTop 同构,core 事务补偿规则)。
//
// 反转机制(§2.5-⑨)住在宿主内部:ScrollView inverted(scaleY -1)+ 行级
// scaleY(-1) 双层反向布局;core 与页面恒 identity、恒按列表空间陈述。
// 横向 padding 归行(行内样式),宿主不做 TI 的 left/right 交换——TI 那是
// 「item 自带 π」的产物,我们的行不自带 π(反转在宿主层),差异如实注明。
//
// 日期/未读分隔是占位行(tg-rows 行数组直出,现状行为保留),随行翻转即可;
// 「不双重预留高度」不变量:inset/hold 走 contentContainer padding,垫条只含
// 行高(core getWindow 各算各的)。
// ============================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';

export default function VirtualHistoryHost({
  backend,                 // createVirtualBackend() 实例(协议面)
  renderRow,               // ({item: row}) => node —— 页面行渲染器(A/B 共用同一份)
  footer = null,           // 视觉顶部的旧向翻页态条(TopTail;与 A 的 ListFooter 同位)
  contentContainerStyle,   // 页面级内容样式(maxWidth/横向留白等视觉项;纵向外边距
                           // 走 edgePadding,避免盖掉 core 管理的 inset/hold)
  edgePadding = 0,         // 视觉两端的固定留白(A 的 contentContainerStyle
                           // paddingTop/paddingBottom=8 的 B 侧等价物;core 的
                           // inset/hold 之外叠加,两层各管各的,不互相覆盖)
  keyboardShouldPersistTaps = 'handled',
  onMounted,               // 挂载信号(页面据此 coordinator.markMounted(),§2.3-4 门禁)
}) {
  const scRef = useRef(null);
  const [, setTick] = useState(0); // core 变更/窗口跨度变化的重渲信号
  const lastYRef = useRef(0);
  const vpRef = useRef({ h: 0, w: 0 });          // 视口量测(渲染无关,事件期更新)
  const winRef = useRef({ start: -1, end: -1 }); // 最近渲染的窗口跨度(变化才重渲)
  const nodesRef = useRef(new Map());            // 稳定 key → 行视图引用(d 枚举器真节点)

  // —— core 变更订阅:attachHost 时 core 可能立即回调,先备好 impl 再挂 ——
  useEffect(() => {
    const impl = {
      getNode: () => (scRef.current && typeof scRef.current.getScrollableNode === 'function'
        ? scRef.current.getScrollableNode()
        : scRef.current),
      scrollTo: (y, animated) => {
        const sc = scRef.current;
        if (!sc) return;
        try {
          sc.scrollTo({ y, animated: !!animated });
        } catch (_e) { /* 宿主已卸载等极端场景:忽略 */ }
      },
      getNodes: () => nodesRef.current,
      onCoreChanged: () => setTick((x) => x + 1),
    };
    backend.attachHost(impl);
    if (typeof onMounted === 'function') onMounted(); // B 的挂载门禁信号
    return () => {
      backend.detachHost();
      nodesRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend]);

  // —— 滚动帧:喂 core(内聚发布 onScrolled/onVisibleRange/onReachOlderEdge),
  //     窗口跨度变化才重渲(同窗口内滚动零重渲,量测回填经 onCoreChanged 走) ——
  const handleScroll = useCallback(
    (e) => {
      const ne = (e && e.nativeEvent) || {};
      const y = ne.contentOffset ? Number(ne.contentOffset.y) || 0 : 0;
      lastYRef.current = y;
      backend.handleHostScroll({ y, viewportHeight: vpRef.current.h, viewportWidth: vpRef.current.w });
      const w = backend._internals.window;
      if (w.start !== winRef.current.start || w.end !== winRef.current.end) {
        winRef.current = { start: w.start, end: w.end };
        setTick((x) => x + 1);
      }
    },
    [backend]
  );

  // —— 视口量测:尺寸变化喂 core(首帧量测前窗口退化为最新端 OVERSCAN 行) ——
  const handleLayout = useCallback(
    (e) => {
      const ne = (e && e.nativeEvent.layout) || {};
      const h = Number(ne.height) || 0;
      const w = Number(ne.width) || 0;
      if (h > 0 && (vpRef.current.h !== h || vpRef.current.w !== w)) {
        vpRef.current = { h, w };
        backend.handleHostScroll({ y: lastYRef.current, viewportHeight: h, viewportWidth: w });
        const win = backend._internals.window;
        if (win.start !== winRef.current.start || win.end !== winRef.current.end) {
          winRef.current = { start: win.start, end: win.end };
          setTick((x) => x + 1);
        }
      }
    },
    [backend]
  );

  const geom = backend.getWindow(); // 渲染期取窗口(core 内缓存,幂等)
  const dragBegin = useCallback(() => backend.handleDragBegin(), [backend]);
  const dragEnd = useCallback(() => backend.handleDragEnd(), [backend]);

  return (
    <ScrollView
      ref={scRef}
      inverted
      style={{ flex: 1 }}
      contentContainerStyle={[
        {
          // core 管理的 inset/hold + 页面视觉留白(edgePadding)——纵向一律在这里
          // 合成,页面传入的 contentContainerStyle 不得再带纵向 padding
          paddingTop: geom.paddingTop + (Number(edgePadding) || 0),
          paddingBottom: geom.paddingBottom + (Number(edgePadding) || 0),
        },
        contentContainerStyle || null,
      ].filter(Boolean)}
      onScroll={handleScroll}
      onLayout={handleLayout}
      onScrollBeginDrag={dragBegin}
      onScrollEndDrag={dragEnd}
      scrollEventThrottle={16}
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      showsVerticalScrollIndicator={false}
    >
      {/* 首行前垫条:窗口之外(更新侧)的行高合计——只有行高,inset/hold 在 padding */}
      <View style={{ height: geom.topSpacer }} />
      {geom.rows.map((row) => (
        <View
          key={row ? row.key : 'x'}
          // 行级反转:宿主 inverted 已把整体翻成「最新在底」,行内容再翻一次
          // 回正(TI 每个 item 自带 π 的同构,组合后恒 identity,§2.5-⑨)
          style={{ transform: [{ scaleY: -1 }] }}
          ref={(el) => {
            // React 19 ref 回调返回值会被当作清理函数,用块体避免误返
            if (el) nodesRef.current.set(row ? row.key : 'x', el);
            else nodesRef.current.delete(row ? row.key : 'x');
          }}
          onLayout={(e) => {
            const h = e && e.nativeEvent && e.nativeEvent.layout ? e.nativeEvent.layout.height : 0;
            if (h > 0) backend.setRowHeight(row ? row.key : 'x', h);
          }}
        >
          {renderRow({ item: row })}
        </View>
      ))}
      {/* 尾行后垫条:窗口之外(更旧侧)的行高合计 */}
      <View style={{ height: geom.bottomSpacer }} />
      {/* 旧向翻页态条:视觉顶部(internal 底部),同 A 的 ListFooter 位置 */}
      {footer ? <View style={{ transform: [{ scaleY: -1 }] }}>{footer}</View> : null}
    </ScrollView>
  );
}
