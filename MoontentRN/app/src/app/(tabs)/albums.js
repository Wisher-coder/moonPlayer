// ============================================================================
// albums.js —— 相册浏览页（/albums?cat=<相册分类ID>）
// ----------------------------------------------------------------------------
// 逐条移植 NextWeb app/albums/page.js（YouTube 频道网格形态，仅 albums 能力站点）。
// URL 即状态——?cat= 过滤（无过滤=全部最新）。分类 chips 横滚条（相册分类索引
// 单独拉，与列表数据解耦，切分类不弄丢 chips；失败静默降级为无 chips）+
// 小节标题（分类名或「最新相册」，20px/700/行高 28 = YouTube 书架标题实测值，
// 随内容滚动）+ 方卡网格无限滚动（useInfiniteList，竞态防护内聚于 hook）。
// 相册无排序能力，不造榜单 tabs；无相册能力的站点直达时给
// 「当前站点没有相册专区」空态（不造假数据）。
// ============================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Gallery } from '../../components/icons.js';
import { api } from '../../lib/client.js';
import { useSite } from '../../lib/site-context.jsx';
import { useForm } from '../../lib/use-form.js';
import { useInfiniteList, toPage } from '../../hooks/use-infinite-list.js';
import useChromeScroll, { useChromeInsets } from '../../hooks/use-chrome-scroll.js';
import AlbumGrid from '../../components/album/AlbumGrid.jsx';
import ChipsBar from '../../components/video/ChipsBar.jsx';
import { EmptyState, ErrorState, LoadMoreBar } from '../../components/zones/PageStates.jsx';
import Skeleton from '../../components/ui/Skeleton.jsx';
import { usePalette } from '../../components/ui/palette.js';

const SIZE = 24;

// 整页骨架（站点上下文未就绪）：chips 行 + 方卡网格骨架
function AlbumsSkeleton() {
  return (
    <View style={{ gap: 16 }}>
      <View style={{ flexDirection: 'row', gap: 12, paddingVertical: 2 }}>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} style={{ height: 32, width: 72, borderRadius: 8 }} />
        ))}
      </View>
      <Text style={{ fontSize: 20, fontWeight: '700', lineHeight: 28, color: 'transparent' }}>占位</Text>
      <AlbumGrid loading={12} />
    </View>
  );
}

export default function Albums() {
  const params = useLocalSearchParams();
  const cat0 = params.cat ? String(params.cat) : '';
  const { site, caps, ready } = useSite();
  const { width, form } = useForm();
  const p = usePalette();
  const padH = width >= 768 ? 24 : 12; // 主区留白约定：px-3 / md:px-6
  const capsAlbums = !!caps.albums;

  // 手机画幅壳层收放：相册网格滚动方向判定挂载
  const chromeScroll = useChromeScroll(form === 'phone');
  // 手机画幅内容全出血：滚动内容自垫安全间距（pad/PC 为 0）
  const chromeInsets = useChromeInsets();

  // 分区状态：本地冻结 + URL 参数对齐（chips 切换先落状态再同步 URL）
  const [cat, setCat] = useState(cat0);
  useEffect(() => {
    setCat((cur) => (cur === cat0 ? cur : cat0));
  }, [cat0]);

  // 相册分类索引：随 site 重拉一次（失败静默——无 chips 仍有「最新相册」流）
  const [cats, setCats] = useState([]);
  useEffect(() => {
    if (!ready || !capsAlbums) {
      setCats([]);
      return;
    }
    let alive = true;
    api(site, 'albumcats')
      .then((list) => { if (alive) setCats(Array.isArray(list) ? list.slice() : []); })
      .catch(() => { if (alive) setCats([]); });
    return () => { alive = false; };
  }, [site, ready, capsAlbums]);

  // 列表取数：?cat= 过滤，页码走 hook（未就绪/无能力挂起，不发请求）
  const fetchPage = useCallback(
    (page) => {
      if (!ready || !capsAlbums) return new Promise(() => {}); // 未就绪/无能力：挂起
      return api(site, 'albums', cat ? { page, size: SIZE, category: cat } : { page, size: SIZE }).then(toPage);
    },
    [site, cat, ready, capsAlbums]
  );
  const { items, loading, loadingMore, err, loadMore, reload } = useInfiniteList(fetchPage, [
    site,
    cat,
    ready,
    capsAlbums,
  ]);

  // chips：「全部」清 cat，其余进对应相册分类（深链 ?cat=）
  const changeCat = useCallback((key) => {
    const n = key === 'all' ? '' : key;
    setCat(n);
    try {
      router.setParams({ cat: n || undefined }); // undefined = 从 URL 移除该参数
    } catch (_e) { /* 导航未就绪等异常：状态已切，数据照常跟随 */ }
  }, []);

  // chips 条目（「全部」+ 分类索引；脏条目跳过）
  const catItems = [{ key: 'all', label: '全部' }].concat(
    (cats || [])
      .filter((c) => c && c.id != null)
      .map((c) => ({ key: String(c.id), label: c.name || String(c.id) }))
  );
  const catName = ((cats || []).find((c) => c && String(c.id) === cat) || {}).name || '';

  // 小节标题：分类名或「最新相册」（书架标题规格，随内容滚动）
  const Title = (
    <Text style={{ fontSize: 20, fontWeight: '700', lineHeight: 28, color: p.foreground }}>
      {catName || '最新相册'}
    </Text>
  );

  // 页头（分类 chips + 小节标题）随内容滚出/回顶滚回——挂进网格 ListHeader；
  // chips 通栏负边距吃到槽外全宽，手机画幅首部垫 inset 防被 overlay 顶栏盖住
  const listHeader = (
    <View>
      {cats.length > 0 ? (
        <View
          style={{
            paddingTop: chromeInsets.top,
            marginHorizontal: -padH,
            paddingHorizontal: padH,
            borderBottomWidth: 1,
            borderBottomColor: p.line,
          }}
        >
          <ChipsBar items={catItems} active={cat || 'all'} onChange={changeCat} />
        </View>
      ) : null}
      <View style={{ paddingBottom: 16, paddingTop: cats.length > 0 ? 0 : chromeInsets.top }}>
        {Title}
      </View>
    </View>
  );

  const body = (() => {
    if (!ready) return <View style={{ paddingTop: chromeInsets.top }}><AlbumsSkeleton /></View>;
    // 无相册能力的站点：空态引导（不造假）
    if (!capsAlbums) {
      return (
        <EmptyState
          icon={Gallery}
          title="当前站点没有相册专区"
          desc="切换到支持相册的站点（如艾薇社区）后可在此浏览图集"
        />
      );
    }
    if (loading) {
      return (
        <View style={{ gap: 16, paddingTop: chromeInsets.top }}>
          {Title}
          <AlbumGrid loading={12} />
        </View>
      );
    }
    if (err && !items) return <ErrorState message={err} onRetry={reload} />;
    if (!items || !items.length) {
      return (
        <View>
          {Title}
          <EmptyState icon={Gallery} title="暂无相册" />
        </View>
      );
    }
    return (
      <AlbumGrid
        items={items}
        ListHeaderComponent={listHeader}
        onPress={(a) =>
          a && router.push({ pathname: '/album/[site]/[id]', params: { site, id: String(a.id) } })
        }
        onEndReached={loadMore}
        onScroll={chromeScroll.onScroll}
        scrollEventThrottle={chromeScroll.scrollEventThrottle}
        contentContainerStyle={{ paddingBottom: width >= 768 ? 48 : 16 + chromeInsets.bottom }}
      />
    );
  })();

  return (
    <View style={{ flex: 1, backgroundColor: p.background }}>
      <View style={{ flex: 1, paddingHorizontal: padH }}>{body}</View>
      {/* 加载更多态：页底浮层（共享网格不透传列表尾部，见 LoadMoreBar 注释） */}
      {items && items.length ? (
        <LoadMoreBar loadingMore={loadingMore} err={err} onRetry={loadMore} />
      ) : null}
    </View>
  );
}
