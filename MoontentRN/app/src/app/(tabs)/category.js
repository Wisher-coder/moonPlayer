// ============================================================================
// 分类页 —— YouTube 话题浏览形态，URL 即状态（?cat/?tag/?dvd/?subject 四种
// 过滤互斥 + ?sort）；无过滤时展示总览三小节「分类 / 标签 / 专辑」（分类与
// 标签为 pill 云、专辑为横滚架，均有数据才显示）。?subject= 为三区（专区）
// 专题的列表承接面：专题卡深链至此，fetcher 走 bysubject（排序 chips 复用
// caps.sort 渲染），返回 chip 链回 /zones?tab=subject。板块型站点（boards 且
// 无标签/专辑面）总览为引导空态（内容按首页板块组织）。
// ----------------------------------------------------------------------------
// 交互语义 1:1 移植自 NextWeb/src/components/tabs/CategoryTab.jsx，RN 三端
// 适配点：
//   · URL 参数读 useLocalSearchParams（expo-router 承接 NextWeb 的
//     useSearchParams；本页现居 (tabs) 保活分组，navigate 换参照原地替换
//     （不换实例）、replace 原地换参不增历史——两种路径下参数都是唯一事实
//     源，常驻挂载下 deps 变化自然重拉列表）；
//   · 页内 pill/chip 走 router.navigate / router.replace（tab 级目标 navigate
//     = 组内 JUMP_TO，语义同 NextWeb 的 Link 与 router.replace）；
//   · 无限流走共享 VideoGrid，底态条与首页同款（见 index.js 文件头说明）；
//   · fetcher 未就绪/总览态解析空结果而非挂起（RN 版 useInfiniteList 的
//     在途锁无 force 通道，挂起会永久卡死，同首页说明）。
// ============================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useRouter , useLocalSearchParams } from 'expo-router';
import { ChevronLeft, VideoFrame, Category as CategoryIcon } from '../../components/icons.js';
import { api } from '../../lib/client.js';
import { useSite } from '../../lib/site-context.jsx';
import { useOpenVideo } from '../../lib/open-video.js';
import { useForm } from '../../lib/use-form.js';
import { usePalette } from '../../components/ui/palette.js';
import usePressVisual from '../../lib/use-press-visual.js';
import { coverUrl, useDataSaver } from '../../components/ui/cover.js';
import { useInfiniteList, toPage } from '../../hooks/use-infinite-list.js';
import useChromeScroll, { useChromeInsets } from '../../hooks/use-chrome-scroll.js';
import VideoGrid from '../../components/video/VideoGrid.jsx';
import ChipsBar from '../../components/video/ChipsBar.jsx';
import Chip from '../../components/ui/Chip.jsx';
import Button from '../../components/ui/Button.jsx';
import Skeleton from '../../components/ui/Skeleton.jsx';
import EmptyState from '../../components/home/EmptyState.jsx';
import ErrorState from '../../components/home/ErrorState.jsx';
import ListFooter from '../../components/home/ListFooter.jsx';
import ScreenScrollView from '../../components/layout/ScreenScrollView.jsx';

const SIZE = 24;
// 排序三档：''（缺省）与 post_date 同效，统一折叠到「最新」
const SORTS = [
  { key: 'post_date', label: '最新' },
  { key: 'video_viewed', label: '热播' },
  { key: 'most_popular', label: '人气' },
];
const KIND = { cat: '分类', tag: '标签', dvd: '专辑', subject: '专题' }; // 过滤种类 → 兜底名

// expo-router 参数值防御式归一：可能为 string | string[] | undefined，一律取首值字符串
const one = (v) => {
  const x = Array.isArray(v) ? v[0] : v;
  return x == null ? '' : String(x);
};

// 页内异步小钩子：loading/error/data + 重试（alive 防卸载后 setState；仅本页使用，
// 与 NextWeb CategoryTab 的 useAsync 同构）
function useAsync(fn, deps) {
  const [st, setSt] = useState({ loading: true, error: '', data: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setSt({ loading: true, error: '', data: null });
    fn().then(
      (d) => { if (alive) setSt({ loading: false, error: '', data: d }); },
      (e) => { if (alive) setSt({ loading: false, error: (e && e.message) || String(e), data: null }); }
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const retry = useCallback(() => setTick((t) => t + 1), []);
  return { ...st, retry };
}

// 归一化条目的防御式取值（容错 id/category_id、name/title 等新旧字段名）；
// 分类可带可选 children（两级分类站点输出，如 bf 模块→板块），一并归一化
const catOf = (c) => ({
  id: c && (c.id ?? c.category_id),
  name: (c && (c.name ?? c.title)) || '分类',
  total: (c && (c.total ?? c.total_videos)) || 0,
  children: c && Array.isArray(c.children) && c.children.length ? c.children.map(catOf) : null,
});
const tagOf = (t) => ({ id: t && (t.id ?? t.tag_id), name: (t && (t.name ?? t.tag)) || '', total: (t && (t.total ?? t.total_videos)) || 0 });
const dvdOf = (d) => ({ id: d && (d.id ?? d.dvd_id), name: (d && (d.name ?? d.title)) || '', cover: (d && d.cover) || '', total: (d && (d.total ?? d.total_videos)) || 0 });
// 专题卡形态（{id,title,count}，契约见 base.js 三区段）→ 显示名条目
const subjOf = (s) => ({ id: s && s.id, name: (s && (s.name ?? s.title)) || '', total: 0 });

// 总览小节：小节标题 + 内容三态（loading 骨架 / error 行内重试 / 有数据才渲染内容）
function OverviewSection({ title, loading, error, onRetry, skeleton, children }) {
  const p = usePalette();
  if (error) {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 12, color: p.muted }}>
          {title + '加载失败：' + error}
        </Text>
        <Button variant="secondary" size="sm" onPress={onRetry}>重试</Button>
      </View>
    );
  }
  if (loading) return skeleton;
  if (!children) return null; // 加载完无数据：整节隐藏
  return (
    <View>
      <Text style={{ marginBottom: 12, fontSize: 16, fontWeight: '500', color: p.foreground }}>{title}</Text>
      {children}
    </View>
  );
}

// 专辑横滚卡：16:9 封面（176 宽 = NextWeb w-44）+ 一行标题（NextWeb albums 架同形）
function DvdCard({ d, saver, onPress }) {
  const p = usePalette();
  const hv = usePressVisual(); // 布局静态化 + 按压视觉态事件 state（安卓样式函数陷阱）
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={d.name || '专辑'}
      onPress={onPress}
      {...hv.binds}
      style={[{ width: 176 }, { opacity: hv.pressed ? 0.9 : 1 }]}
    >
      <View
        style={{
          position: 'relative',
          aspectRatio: 16 / 9,
          borderRadius: 12,
          overflow: 'hidden',
          backgroundColor: p.surface,
        }}
      >
        {d.cover ? (
          <Image
            source={{ uri: coverUrl(d.cover, saver) }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            transition={200}
            recyclingKey={String(d.id)}
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <VideoFrame size={32} color={p.muted} opacity={0.4} />
          </View>
        )}
      </View>
      <Text numberOfLines={1} style={{ marginTop: 6, fontSize: 12, color: p.foreground, opacity: 0.9 }}>
        {d.name}
      </Text>
    </Pressable>
  );
}

export default function Category() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const p = usePalette();
  const { form } = useForm();
  const { site, caps, ready } = useSite();
  const saver = useDataSaver();

  const padH = form === 'phone' ? 12 : 24; // 页边距：px-3 / md:px-6

  // 手机画幅壳层收放：总览 ScrollView / 列表模式 VideoGrid 两路方向判定挂载
  const chromeScroll = useChromeScroll(form === 'phone');
  // 手机画幅内容全出血：滚动内容自垫安全间距（pad/PC 为 0）
  const chromeInsets = useChromeInsets();

  // —— URL → 筛选状态（五种字段全部字符串化；四种过滤互斥，按优先级取一）——
  const q = {
    cat: one(params.cat),
    tag: one(params.tag),
    dvd: one(params.dvd),
    subject: one(params.subject),
    sort: one(params.sort),
  };
  const mode = q.cat ? 'cat' : q.tag ? 'tag' : q.dvd ? 'dvd' : q.subject ? 'subject' : '';
  const fid = q.cat || q.tag || q.dvd || q.subject;
  const effSort = q.sort || 'post_date'; // 缺省排序与最新同效

  // 组装目标地址：只保留当前过滤 + 可选 sort（切排序不丢过滤；默认排序不进 URL）
  const buildQuery = useCallback(
    (patch = {}) => {
      const next = {};
      if (mode) next[mode] = fid;
      const s = patch.sort !== undefined ? patch.sort : effSort;
      if (s && s !== 'post_date') next.sort = s;
      const qs = Object.keys(next)
        .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(next[k]))
        .join('&');
      return qs ? '/category?' + qs : '/category';
    },
    [mode, fid, effSort]
  );

  // —— 总览数据（进入列表模式时不发无谓请求；回到总览会重拉刷新计数）——
  // 板块型站点（boards 且无标签/专辑面）无分类体系：分类不发包，总览改友好空态
  const boardOnly = !!caps.boards && !caps.tags && !caps.dvds;
  const cats = useAsync(
    () => (mode || !ready || boardOnly ? Promise.resolve(null) : api(site, 'categories')),
    [mode, site, ready, boardOnly]
  );
  const tags = useAsync(
    () => (mode || !ready || !caps.tags ? Promise.resolve(null) : api(site, 'tags')),
    [mode, site, ready, caps.tags]
  );
  const dvds = useAsync(
    () => (mode || !ready || !caps.dvds ? Promise.resolve(null) : api(site, 'dvds', { page: 1, size: 12 })),
    [mode, site, ready, caps.dvds]
  );

  // —— 当前过滤项显示名：分类/标签查全量，专辑/专题查首百条，深链靠后者退化为通用名 ——
  const nameRes = useAsync(() => {
    if (!mode || !ready) return Promise.resolve([]);
    if (mode === 'cat') return api(site, 'categories');
    if (mode === 'tag') return api(site, 'tags');
    if (mode === 'subject') return api(site, 'subjects', { page: 1, size: 100 });
    return api(site, 'dvds', { page: 1, size: 100 });
  }, [mode, fid, site, ready]);
  const nameList = (((mode === 'dvd' || mode === 'subject') ? toPage(nameRes.data).items : nameRes.data) || [])
    .map(mode === 'cat' ? catOf : mode === 'tag' ? tagOf : mode === 'subject' ? subjOf : dvdOf)
    .filter((x) => x.id != null);
  let found = nameList.find((x) => String(x.id) === fid);
  // 子分类深链：顶层找不到时下钻 children（命中后父分类上下文保留，供子 chips 行用）
  let parentCat = null;
  if (mode === 'cat') {
    if (found) parentCat = found;
    else {
      for (const c of nameList) {
        const ch = (c.children || []).find((k) => String(k.id) === fid);
        if (ch) { found = ch; parentCat = c; break; }
      }
    }
  }
  const curName = found ? found.name : (nameRes.loading ? '' : KIND[mode] || '');

  // 子分类/「全部」chip 跳转：保留当前排序
  const catHref = useCallback(
    (id) => {
      const qs = ['cat=' + encodeURIComponent(String(id))];
      if (effSort && effSort !== 'post_date') qs.push('sort=' + encodeURIComponent(effSort));
      return '/category?' + qs.join('&');
    },
    [effSort]
  );

  // —— 过滤列表：tag=bytag / dvd=bydvd / subject=bysubject（三区专题承接）/
  //    cat=普通列表带 category；未就绪/总览态解析空结果（绝不挂起，见文件头）——
  const fetcher = useCallback(
    (page) => {
      if (!ready || !mode) return Promise.resolve({ items: [], hasMore: false });
      if (mode === 'tag') return api(site, 'bytag', { tag: fid, page, size: SIZE, sort: effSort }).then(toPage);
      if (mode === 'dvd') return api(site, 'bydvd', { dvd: fid, page, size: SIZE }).then(toPage);
      if (mode === 'subject') return api(site, 'bysubject', { subject: fid, page, size: SIZE, sort: effSort }).then(toPage);
      return api(site, 'list', { page, size: SIZE, sort: effSort, category: fid }).then(toPage);
    },
    [site, mode, fid, effSort, ready]
  );
  // deps = 「换一页列表」的全部维度：站点 / 过滤种类 / 过滤值 / 排序 / 就绪
  const { items, loading, loadingMore, err, done, loadMore, reload } =
    useInfiniteList(fetcher, [site, mode, fid, effSort, ready]);

  // 卡片深链观看页（跳转口径统一 useOpenVideo：桌面壳主窗弹独立播放窗）
  const goVideo = useOpenVideo();
  const openVideo = useCallback(
    (v) => {
      if (v && v.id != null) goVideo(site, v.id);
    },
    [site, goVideo]
  );

  // ———————————————— 上下文未就绪：整页骨架（pill 云 + 专辑横滚架形态）————————————————
  if (!ready) {
    return (
      <View style={{ flex: 1, paddingHorizontal: padH, paddingTop: 12 + chromeInsets.top, gap: 32 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} style={{ height: 32, width: 80, borderRadius: 8 }} />
          ))}
        </View>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} style={{ width: 176, aspectRatio: 16 / 9, borderRadius: 12 }} />
          ))}
        </View>
      </View>
    );
  }

  // ———————————————— 总览模式 ————————————————
  if (!mode) {
    // 板块型站点（如含羞草）：内容按首页板块组织，无分类总览可列
    if (boardOnly) {
      return (
        <ScreenScrollView
          style={{ flex: 1 }}
          topGap={12}
          bottomGap={12}
          contentContainerStyle={{ paddingHorizontal: padH }}
        >
          <EmptyState
            icon={CategoryIcon}
            title="该站内容按首页板块组织"
            desc="分类入口已隐藏，请回首页浏览各板块"
            action={
              <Button variant="ghost" onPress={() => router.navigate('/')}>回首页</Button>
            }
          />
        </ScreenScrollView>
      );
    }
    const catList = (cats.data || []).map(catOf).filter((x) => x.id != null);
    const tagList = (tags.data || []).map(tagOf).filter((x) => x.id != null && x.name);
    const dvdList = toPage(dvds.data).items.map(dvdOf).filter((x) => x.id != null);

    return (
      <ScreenScrollView
        style={{ flex: 1 }}
        onScroll={chromeScroll.onScroll}
        scrollEventThrottle={chromeScroll.scrollEventThrottle}
        topGap={12}
        bottomGap={12}
        contentContainerStyle={{ paddingHorizontal: padH, gap: 32 }} // space-y-8
      >
        {/* 分类 pill 云 */}
        <OverviewSection
          title="分类"
          loading={cats.loading}
          error={cats.error}
          onRetry={cats.retry}
          skeleton={(
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {Array.from({ length: 10 }, (_, i) => (
                <Skeleton key={i} style={{ height: 32, width: 80, borderRadius: 8 }} />
              ))}
            </View>
          )}
        >
          {catList.length ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {catList.map((c) => (
                <Chip
                  key={String(c.id)}
                  label={c.name}
                  onPress={() => router.navigate('/category?cat=' + encodeURIComponent(String(c.id)))}
                />
              ))}
            </View>
          ) : null}
        </OverviewSection>

        {/* 标签 pill 云（仅 tags 能力站点） */}
        {caps.tags ? (
          <OverviewSection
            title="标签"
            loading={tags.loading}
            error={tags.error}
            onRetry={tags.retry}
            skeleton={(
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {Array.from({ length: 12 }, (_, i) => (
                  <Skeleton key={i} style={{ height: 32, width: 80, borderRadius: 8 }} />
                ))}
              </View>
            )}
          >
            {tagList.length ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {tagList.map((t) => (
                  <Chip
                    key={String(t.id)}
                    label={t.name}
                    onPress={() => router.navigate('/category?tag=' + encodeURIComponent(String(t.id)))}
                  />
                ))}
              </View>
            ) : null}
          </OverviewSection>
        ) : null}

        {/* 专辑横滚架（仅 dvds 能力站点） */}
        {caps.dvds ? (
          <OverviewSection
            title="专辑"
            loading={dvds.loading}
            error={dvds.error}
            onRetry={dvds.retry}
            skeleton={(
              <View style={{ flexDirection: 'row', gap: 12 }}>
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} style={{ width: 176, aspectRatio: 16 / 9, borderRadius: 12 }} />
                ))}
              </View>
            )}
          >
            {dvdList.length ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingBottom: 8 }}>
                {dvdList.map((d) => (
                  <DvdCard
                    key={String(d.id)}
                    d={d}
                    saver={saver}
                    onPress={() => router.navigate('/category?dvd=' + encodeURIComponent(String(d.id)))}
                  />
                ))}
              </ScrollView>
            ) : null}
          </OverviewSection>
        ) : null}
      </ScreenScrollView>
    );
  }

  // ———————————————— 过滤列表模式：返回钮 + 筛选名 + 无限滚动 ————————————————
  // 页头三行（页头行/子分类 chips/排序 chips）随内容滚出/回顶滚回——挂进网格
  // ListHeader；槽位已有 padH 横向留白，行内不再重复。手机画幅内容全出血：
  // 首行垫 useChromeInsets 顶距防被 overlay 顶栏盖住（pad/PC 为 0）
  const hasList = !!(items && items.length);
  const listHeader = (
    <View style={{ paddingTop: chromeInsets.top }}>
      {/* 页头：返回钮（subject 模式返回三区入口；板块站总览为空态，直接回专区）+ 筛选名 */}
      <View style={{ paddingTop: 12, marginBottom: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Button variant="ghost" onPress={() => router.navigate(mode === 'subject' ? '/zones?tab=subject' : '/category')}>
          <ChevronLeft size={16} color={p.foreground} />
          <Text style={{ color: p.foreground, fontSize: 14, fontWeight: '500', includeFontPadding: false }}>
            {mode === 'subject' ? '专区' : '全部'}
          </Text>
        </Button>
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 18, fontWeight: '700', color: p.foreground }}>
          {curName || KIND[mode]}
        </Text>
      </View>

      {/* 子分类 chips 行（仅两级分类站点：当前分类带 children 时出现；「全部」= 父级本档） */}
      {mode === 'cat' && parentCat && parentCat.children ? (
        <View style={{ marginBottom: 16 }}>
          <ChipsBar
            items={[{ key: parentCat.id, label: '全部' }, ...parentCat.children].map((k) => ({
              key: String(k.id),
              label: k.name,
            }))}
            active={String(fid)}
            onChange={(id) => router.navigate(catHref(id))}
          />
        </View>
      ) : null}

      {/* 排序 chips（仅 sort 能力站点；replace 不新增历史项，与 NextWeb 同语义） */}
      {caps.sort ? (
        <View style={{ marginBottom: 16 }}>
          <ChipsBar
            items={SORTS.map((s) => ({ key: s.key, label: s.label }))}
            active={effSort}
            onChange={(k) => router.replace(buildQuery({ sort: k }))}
          />
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      {/* 列表主体：骨架 / 失败重试 / 空态 / 网格 + 无限滚动 */}
      <View style={{ flex: 1, minHeight: 0, paddingHorizontal: padH }}>
        {loading ? (
          <View style={{ paddingTop: chromeInsets.top }}>
            <VideoGrid loading={10} />
          </View>
        ) : err && !items ? (
          <ErrorState message={err} onRetry={reload} />
        ) : !hasList ? (
          <EmptyState icon={VideoFrame} title="暂无视频" />
        ) : (
          <VideoGrid
            items={items}
            onPress={openVideo}
            onEndReached={loadMore}
            onScroll={chromeScroll.onScroll}
            scrollEventThrottle={chromeScroll.scrollEventThrottle}
            ListHeaderComponent={listHeader}
            ListFooterComponent={
              /* 列表底态条（与首页同款）：尾部随列表滚入，底距垫 inset */
              <ListFooter loading={loadingMore} error={err || ''} done={done} onRetry={loadMore} />
            }
            contentContainerStyle={{ paddingBottom: 12 + chromeInsets.bottom }}
          />
        )}
      </View>
    </View>
  );
}
