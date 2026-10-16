// ============================================================================
// zones.js —— 专区页（/zones?tab=subject|package|gather）
// ----------------------------------------------------------------------------
// 逐条移植 NextWeb src/components/tabs/ZonesTab.jsx（RN 版无 TabKeepAlive 保活层，
// 直接作路由页）。含羞草三区（专题/量贩/合集）浏览面：
//   - 三档 chips（站方导航顺序 专题/量贩/合集），URL 即状态（?tab=，深链唯一形态）；
//   - ZoneCard 网格无限滚动，三区各自独立取数（单区上游改版只丢该区，
//     ErrorState 局部重试）；分区取数互不影响；
//   - 卡片深链：专题 → /category?subject=（列表模式承接），量贩 → /package/{site}/{id}，
//     合集 → /package/{site}/{id}?k=gather（整包片单页共用呈现）；
//   - caps.zones 门控：非该能力站点给友好空态（内容另有组织面，不渲染半死页面）。
// tab 状态：本地冻结 + 激活时与 URL 参数对齐（chips 切换走 setParams 同步回 URL，
// 深链/返回键进入则由参数同步 effect 落状态）——与 NextWeb 保活适配同一套语义。
// ============================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Clapperboard, Layers } from '../../components/icons.js';
import { api } from '../../lib/client.js';
import { useSite } from '../../lib/site-context.jsx';
import { useForm } from '../../lib/use-form.js';
import { useInfiniteList, toPage } from '../../hooks/use-infinite-list.js';
import useChromeScroll, { useChromeInsets } from '../../hooks/use-chrome-scroll.js';
import ChipsBar from '../../components/video/ChipsBar.jsx';
import ZoneGrid from '../../components/zones/ZoneGrid.jsx';
import { EmptyState, ErrorState } from '../../components/zones/PageStates.jsx';
import Skeleton from '../../components/ui/Skeleton.jsx';
import { usePalette } from '../../components/ui/palette.js';

const SIZE = 24;
// 三区档位（key=URL tab 值；站方导航顺序 专题/量贩/合集，传媒非视频面不接）
const TABS = [
  { key: 'subject', label: '专题' },
  { key: 'package', label: '量贩' },
  { key: 'gather', label: '合集' },
];
const TAB_KEYS = TABS.map((t) => t.key);
// tab → 三区取数方法（subjects/packages/gathers 归一同形 {items,page,hasMore}）
const TAB_METHOD = { subject: 'subjects', package: 'packages', gather: 'gathers' };

// 卡片深链：专题进 ?subject= 列表模式（tab 级目标 navigate=组内 JUMP_TO）；
// 量贩/合集进共用包页（?k=gather 切合集源，详情路由仍走 push）
function goCard(tab, site, id) {
  if (tab === 'subject') {
    router.navigate({ pathname: '/category', params: { subject: String(id) } });
    return;
  }
  router.push({
    pathname: '/package/[site]/[id]',
    params: { site, id: String(id), ...(tab === 'gather' ? { k: 'gather' } : {}) },
  });
}

// 三区 chips + 网格骨架（站点上下文未就绪时的整页骨架形态）
function ZonesSkeleton() {
  return (
    <View style={{ gap: 16 }}>
      <View style={{ flexDirection: 'row', gap: 12, paddingVertical: 2 }}>
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} style={{ height: 32, width: 64, borderRadius: 8 }} />
        ))}
      </View>
      <ZoneGrid loading={10} />
    </View>
  );
}

export default function Zones() {
  const params = useLocalSearchParams();
  const { site, caps, ready } = useSite();
  const { width, form } = useForm();
  const p = usePalette();
  const padH = width >= 768 ? 24 : 12; // 主区留白约定：px-3 / md:px-6

  // 手机画幅壳层收放：专区网格滚动方向判定挂载
  const chromeScroll = useChromeScroll(form === 'phone');
  // 手机画幅内容全出血：滚动内容自垫安全间距（pad/PC 为 0）
  const chromeInsets = useChromeInsets();

  // 分区状态：挂载时从 URL 初始化，此后冻结；URL 参数变化（深链/返回键/setParams
  // 回流）才对齐——chips 切换先落状态再同步 URL，交互零等待
  const [tab, setTab] = useState(() => {
    const raw = params.tab ? String(params.tab) : '';
    return TAB_KEYS.indexOf(raw) >= 0 ? raw : 'subject';
  });
  useEffect(() => {
    const raw = params.tab ? String(params.tab) : '';
    const n = TAB_KEYS.indexOf(raw) >= 0 ? raw : 'subject';
    setTab((cur) => (cur === n ? cur : n));
  }, [params.tab]);

  const capsZones = !!caps.zones;

  // 分区取数：tab 切换由 deps 重置回第 1 页；未就绪/无该能力挂起（不发请求）
  const fetchPage = useCallback(
    (page) => {
      if (!ready || !capsZones) return new Promise(() => {});
      return api(site, TAB_METHOD[tab], { page, size: SIZE }).then(toPage);
    },
    [site, tab, ready, capsZones]
  );
  const { items, loading, loadingMore, err, done, loadMore, reload } = useInfiniteList(fetchPage, [
    site,
    tab,
    ready,
    capsZones,
  ]);

  // chips 切换：本地状态先行 + setParams 同步 URL（URL 即状态；失败不影响交互）
  const changeTab = useCallback((key) => {
    setTab(key);
    try {
      router.setParams({ tab: key });
    } catch (_e) { /* 导航未就绪等异常：状态已切，数据照常跟随 */ }
  }, []);

  // 三区 chips（URL 即状态；默认档显式带参，深链形态唯一）——随内容滚出/
  // 回顶滚回（挂进网格 ListHeader）；通栏负边距吃到槽外全宽，手机画幅
  // 首部垫 inset 防被 overlay 顶栏盖住。注意此常量是**即时求值**的 JSX
  //（不是组件、无惰性），必须排在上面 tab/changeTab 声明之后——提到前面就是
  // 首帧渲染即 TDZ（Cannot access 'tab' before initialization）
  const zonesHeader = (
    <View
      style={{
        paddingTop: chromeInsets.top,
        marginHorizontal: -padH,
        paddingHorizontal: padH,
        borderBottomWidth: 1,
        borderBottomColor: p.line,
      }}
    >
      <ChipsBar items={TABS} active={tab} onChange={changeTab} />
    </View>
  );

  const body = (() => {
    // 站点上下文未就绪：整页骨架（chips + 卡片网格形态）
    if (!ready) return <View style={{ paddingTop: chromeInsets.top }}><ZonesSkeleton /></View>;
    // 非三区能力站点：友好空态（内容另有组织面，不渲染半死页面）
    if (!capsZones) {
      return <EmptyState icon={Layers} title="当前站点没有专区" desc="该站内容不按专题/量贩/合集组织" />;
    }
    // 卡片网格：首屏骨架 / 失败重试 / 空态 / 列表 + 无限滚动
    if (loading) return <View style={{ paddingTop: chromeInsets.top }}><ZoneGrid loading={10} /></View>;
    if (err && !items) return <ErrorState message={err} onRetry={reload} />;
    if (!items || !items.length) return <EmptyState icon={Clapperboard} title="暂无内容" />;
    return (
      <ZoneGrid
        items={items}
        onPress={(z) => z && goCard(tab, site, z.id)}
        onEndReached={loadMore}
        onScroll={chromeScroll.onScroll}
        scrollEventThrottle={chromeScroll.scrollEventThrottle}
        ListHeaderComponent={zonesHeader}
        contentContainerStyle={{ paddingBottom: width >= 768 ? 48 : 16 + chromeInsets.bottom }}
        ListFooterComponent={
          err ? (
            <ErrorState message={err} onRetry={loadMore} />
          ) : done ? (
            <Text style={{ paddingVertical: 24, textAlign: 'center', fontSize: 12, color: p.muted, opacity: 0.6 }}>
              没有更多了
            </Text>
          ) : loadingMore ? (
            <Text style={{ paddingVertical: 16, textAlign: 'center', fontSize: 12, color: p.muted, opacity: 0.6 }}>
              正在加载…
            </Text>
          ) : null
        }
      />
    );
  })();

  return (
    <View style={{ flex: 1, backgroundColor: p.background }}>
      <View style={{ flex: 1, paddingHorizontal: padH }}>{body}</View>
    </View>
  );
}
