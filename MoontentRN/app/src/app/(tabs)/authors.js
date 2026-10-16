// ============================================================================
// authors.js —— 女优目录页（/authors?group=1）
// ----------------------------------------------------------------------------
// 逐条移植 NextWeb src/components/tabs/AuthorsTab.jsx（RN 版无 TabKeepAlive
// 保活层，直接作路由页）。YouTube 频道目录形态，仅 authors 能力站点：
//   - URL 即状态——?group=1 为「当红女优」分档（仅认字面 '1'，站方女优面板
//     upScroll 块同源分组，站方分组 id=1），缺省=全量目录；
//   - 两档 chips（全部/当红女优）横滚条 + 圆形头像网格无限滚动
//     （useInfiniteList，竞态防护内聚于 hook）；
//   - 卡片深链 /author/{site}/{id}（个人中心）；
//   - caps.authors 门控：无能力站点直达给「当前站点没有女优专区」空态
//     （不造假数据）。
// RN 适配点：保活的「激活时对齐 URL」退化为 zones.js 同款参数同步 effect
// （本地冻结 + URL 参数变化才对齐，chips 切换先落状态再 setParams 同步回
// URL，交互零等待）；NextWeb fetcher 的挂起 Promise（等 ready/能力）在 RN 版
// hook 无 force 通道——未就绪/无能力直接 resolve 空页，绝不挂起（骨架/空态
// 由页面的 ready 与 caps 门控先行接管）。
// ============================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Users } from '../../components/icons.js';
import { api } from '../../lib/client.js';
import { useSite } from '../../lib/site-context.jsx';
import { useForm } from '../../lib/use-form.js';
import { useInfiniteList, toPage } from '../../hooks/use-infinite-list.js';
import useChromeScroll, { useChromeInsets } from '../../hooks/use-chrome-scroll.js';
import ChipsBar from '../../components/video/ChipsBar.jsx';
import AuthorGrid from '../../components/author/AuthorGrid.jsx';
import { EmptyState, ErrorState } from '../../components/zones/PageStates.jsx';
import Skeleton from '../../components/ui/Skeleton.jsx';
import { usePalette } from '../../components/ui/palette.js';

// 两档分档 chips（key 与 URL 形态一一对应：all → 摘参，hot → ?group=1）
const GROUPS = [
  { key: 'all', label: '全部' },
  { key: 'hot', label: '当红女优' },
];

// URL group 参数 → 分档布尔（仅认字面 '1'；数字形态的 setParams 回流也归一）
function groupFromParam(raw) {
  return (raw != null && raw !== '' ? String(raw) : '') === '1';
}

// 整页骨架（站点上下文未就绪）：两条 chips + 圆头像网格骨架
function AuthorsSkeleton() {
  return (
    <View style={{ gap: 16 }}>
      <View style={{ flexDirection: 'row', gap: 12, paddingVertical: 2 }}>
        {Array.from({ length: 2 }, (_, i) => (
          <Skeleton key={i} style={{ height: 32, width: 72, borderRadius: 8 }} />
        ))}
      </View>
      <AuthorGrid loading={12} />
    </View>
  );
}

export default function Authors() {
  const params = useLocalSearchParams();
  const { site, caps, ready } = useSite();
  const { width, form } = useForm();
  const p = usePalette();
  const padH = width >= 768 ? 24 : 12; // 主区留白约定：px-3 / md:px-6
  const capsAuthors = !!caps.authors;

  // 手机画幅壳层收放：女优网格滚动方向判定挂载
  const chromeScroll = useChromeScroll(form === 'phone');
  // 手机画幅内容全出血：滚动内容自垫安全间距（pad/PC 为 0）
  const chromeInsets = useChromeInsets();

  // 分档状态：挂载时从 URL 初始化，此后冻结；URL 参数变化（深链/返回键/
  // setParams 回流）才对齐——chips 切换先落状态再同步 URL，交互零等待
  const [group, setGroup] = useState(() => groupFromParam(params.group));
  useEffect(() => {
    const g = groupFromParam(params.group);
    setGroup((cur) => (cur === g ? cur : g));
  }, [params.group]);

  // 目录取数：group 仅在当红档传（避免键值污染上游；页码走 hook）；
  // 未就绪/无能力 resolve 空页（RN 版 hook 无 force 通道，绝不挂起）
  const fetchPage = useCallback(
    (page) => {
      if (!ready || !capsAuthors) return Promise.resolve({ items: [], hasMore: false });
      return api(site, 'authors', group ? { page, group: 1 } : { page }).then(toPage);
    },
    [site, group, ready, capsAuthors]
  );
  const { items, loading, loadingMore, err, done, loadMore, reload } = useInfiniteList(fetchPage, [
    site,
    group,
    ready,
    capsAuthors,
  ]);

  // chips 切换：本地状态先行 + setParams 同步 URL（hot 带参 / all 摘参；
  // 导航未就绪等异常不影响交互——状态已切，数据照常跟随）
  const changeGroup = useCallback((key) => {
    const g = key === 'hot';
    setGroup(g);
    try {
      router.setParams(g ? { group: '1' } : { group: undefined }); // undefined = 从 URL 移除该参数
    } catch (_e) { /* 忽略 */ }
  }, []);

  // 小节标题：分档名（20px/700/行高 28 = YouTube 书架标题实测值，随内容滚动）
  const Title = (
    <Text style={{ fontSize: 20, fontWeight: '700', lineHeight: 28, color: p.foreground }}>
      {group ? '当红女优' : '全部女优'}
    </Text>
  );

  // 页头（分档 chips + 小节标题）随内容滚出/回顶滚回——挂进网格 ListHeader；
  // chips 通栏负边距吃到槽外全宽，手机画幅首部垫 inset 防被 overlay 顶栏盖住
  const listHeader = (
    <View>
      <View
        style={{
          paddingTop: chromeInsets.top,
          marginHorizontal: -padH,
          paddingHorizontal: padH,
          borderBottomWidth: 1,
          borderBottomColor: p.line,
        }}
      >
        <ChipsBar items={GROUPS} active={group ? 'hot' : 'all'} onChange={changeGroup} />
      </View>
      <View style={{ paddingBottom: 16 }}>
        {Title}
      </View>
    </View>
  );

  const body = (() => {
    // 站点上下文未就绪：整页骨架（chips + 头像网格形态）
    if (!ready) return <View style={{ paddingTop: chromeInsets.top }}><AuthorsSkeleton /></View>;
    // 无女优能力的站点：空态引导（不造假）
    if (!capsAuthors) {
      return (
        <EmptyState
          icon={Users}
          title="当前站点没有女优专区"
          desc="切换到支持女优体系的站点（如含羞草）后可在此浏览"
        />
      );
    }
    // 目录流：首屏骨架 / 失败重试 / 空态 / 网格 + 无限滚动（与相册页同构）
    if (loading) {
      return (
        <View style={{ gap: 16, paddingTop: chromeInsets.top }}>
          {Title}
          <AuthorGrid loading={12} />
        </View>
      );
    }
    if (err && !items) return <ErrorState message={err} onRetry={reload} />;
    if (!items || !items.length) {
      return (
        <View>
          {Title}
          <EmptyState icon={Users} title="暂无女优" />
        </View>
      );
    }
    return (
      <AuthorGrid
        items={items}
        ListHeaderComponent={listHeader}
        onPress={(a) => a && router.push('/author/' + site + '/' + encodeURIComponent(String(a.id)))}
        onEndReached={loadMore}
        onScroll={chromeScroll.onScroll}
        scrollEventThrottle={chromeScroll.scrollEventThrottle}
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
