// ============================================================================
// board.js —— 板块「查看全部」深链页（/board?section=&tab=）
// ----------------------------------------------------------------------------
// 源：NextWeb/app/board/page.js 的 RN 三端移植。首页板块书架（BoardsHome）的
// 「查看全部」钮深链至此，同款呈现：返回 chip + 板块大标题 + 子标签 chips +
// VideoGrid 无限滚动。RN 适配点：
//   · URL 即状态：section/tab 读 useLocalSearchParams（expo-router 承接 NextWeb
//     的 useSearchParams，RN 无 Suspense 硬性要求，不用包壳）；子标签 chips 用
//     本地 active 态先行、切换走 router.setParams 同步回 URL——默认档「综合」
//     的 tab 不进 URL（回到默认档 setParams 置 undefined 删参），深链形态唯一；
//     深链/返回键进入由参数对齐 effect 落状态（与 zones.js 的 tab 同步同一套
//     语义）；
//   · 板块元数据（标题/tabs）走 api(site, 'boards', null)：boards 是 meta 缓存
//     方法（client.js 5 分钟 TTL，与首页 use-boards 同 URL 共享缓存，从首页
//     「查看全部」进来近零成本）；页面内手写小 useAsync（loading/error/data +
//     retry，alive 防卸载后 setState，照 NextWeb useAsync 语义，不引入新依赖）；
//   · 列表走 use-infinite-list + api(site, 'board') 分页（toPage 归一）；
//     fetcher 未就绪/无板块时解析空结果而非挂起——RN 版 hook 在途锁无 force
//     通道，挂起的 Promise 会永久占锁卡死后续加载（index.js 文件头钉死的约束）；
//   · section 失效（站方布局改版/脏深链）时 ErrorState 提示，不渲染半死页面；
//   · 列表底态与首页同款：VideoGrid 契约未透传 footer 槽，ListFooter 作列表
//     下方常驻条（loadingMore / err 重试 / done 三分支）；
//   · 返回 chip 用 router.dismissTo('/') 回首页而不用 router.back()：详情页
//     跳 tab 级路由必须 POP_TO 弹回 (tabs) 组再切目标 tab（直接 navigate/push
//     会把整个组当新屏再压一份）；深链冷启动时栈内没有 (tabs)，POP_TO 也会落
//     到「替换当前屏」，任何进入路径都成立；
//   · NextWeb 切板块/子标签后的 window.scrollTo 回页首在 RN 无对应通道（滚动
//     归 FlashList 自管），不搬运。
// ============================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft, VideoFrame } from '../components/icons.js';
import { api } from '../lib/client.js';
import { useSite } from '../lib/site-context.jsx';
import { useOpenVideo } from '../lib/open-video.js';
import { useForm } from '../lib/use-form.js';
import { usePalette } from '../components/ui/palette.js';
import { useInfiniteList, toPage } from '../hooks/use-infinite-list.js';
import VideoGrid from '../components/video/VideoGrid.jsx';
import ChipsBar from '../components/video/ChipsBar.jsx';
import Button from '../components/ui/Button.jsx';
import Skeleton from '../components/ui/Skeleton.jsx';
import EmptyState from '../components/home/EmptyState.jsx';
import ErrorState from '../components/home/ErrorState.jsx';
import ListFooter from '../components/home/ListFooter.jsx';
import { useChromeInsets } from '../hooks/use-chrome-scroll.js';

const SIZE = 24;

// expo-router 参数值防御式归一：可能为 string | string[] | undefined，一律取首值字符串
const one = (v) => {
  const x = Array.isArray(v) ? v[0] : v;
  return x == null ? '' : String(x);
};

// 子标签键归一：null/undefined/'' 一律折叠到 ''（默认档「综合」，与 BoardsHome 同口径）
const tabKey = (id) => (id == null || id === '' ? '' : String(id));

// 页内异步小钩子：loading/error/data + 重试（alive 防卸载后 setState；仅本页使用，
// 与 NextWeb board 页的 useAsync 同构，不引入新依赖）
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

export default function Board() {
  const params = useLocalSearchParams();
  const p = usePalette();
  const { form } = useForm();
  const { site, ready } = useSite();
  const padH = form === 'phone' ? 12 : 24; // 页边距：px-3 / md:px-6
  // 壳层避让：手机画幅顶/底栏悬浮于内容之上，首末内容需自垫（pad/PC 恒 0）
  const chrome = useChromeInsets();
  const sectionId = one(params.section);
  const tabFromUrl = one(params.tab);

  // 子标签状态：挂载时从 URL 初始化，此后冻结；URL 参数变化（深链进入/setParams
  // 回流）才对齐——chips 切换先落状态再同步 URL，交互零等待
  const [tab, setTab] = useState(tabFromUrl);
  useEffect(() => {
    setTab((cur) => (cur === tabFromUrl ? cur : tabFromUrl));
  }, [params.section, params.tab]);

  // 板块元数据：boards 聚合里查目标板块（标题/tabs）；未就绪/无板块不发请求
  const meta = useAsync(
    () => (ready && sectionId ? api(site, 'boards', null) : Promise.resolve(null)),
    [site, ready, sectionId]
  );
  const sec = (() => {
    const list = meta.data && Array.isArray(meta.data.sections) ? meta.data.sections : [];
    return list.find((s) => String(s.id) === sectionId) || null;
  })();

  // 子标签切换：本地状态先行 + setParams 同步 URL（section 由合并语义保留，不重传）；
  // 默认档「综合」不进 URL——置 undefined 即删参（expo-router/react-navigation
  // 语义），深链形态唯一；导航异常不回滚状态，数据照常跟随
  const changeTab = useCallback((k) => {
    setTab(k);
    try {
      router.setParams({ tab: k ? k : undefined });
    } catch (_e) { /* 导航未就绪等异常：状态已切，数据照常跟随 */ }
  }, []);

  // 板块分页取数（切子标签由 deps 重置回第 1 页）；未就绪/无板块解析空结果
  // 而非挂起（RN 版 hook 无 force 通道，绝不挂起——index.js 文件头钉死的约束）
  const fetcher = useCallback(
    (page) => {
      if (!ready || !sectionId) return Promise.resolve({ items: [], hasMore: false });
      return api(site, 'board', { id: sectionId, tab: tab || undefined, page, size: SIZE }).then(toPage);
    },
    [site, sectionId, tab, ready]
  );
  // deps =「换一页数据」的全部维度：站点 / 板块 / 子标签 / 就绪
  const { items, loading, loadingMore, err, done, loadMore, reload } =
    useInfiniteList(fetcher, [site, sectionId, tab, ready]);

  // 卡片深链观看页（URL 携带站点，深链可回放）；跳转口径统一 useOpenVideo
  //（桌面壳主窗弹独立播放窗，浏览器/原生窗口内 push）
  const goVideo = useOpenVideo();
  const openVideo = useCallback(
    (v) => {
      if (v && v.id != null) goVideo(site, v.id);
    },
    [site, goVideo]
  );

  // ———————————————— 未就绪/元数据加载中：整页骨架（标题条 + chips + 网格）————————————————
  if (!ready || meta.loading) {
    return (
      <View style={{ flex: 1, paddingHorizontal: padH, paddingTop: 12 + chrome.top, gap: 16 }}>
        {/* 标题条（NextWeb h-8 w-40：高 32 宽 160） */}
        <Skeleton style={{ height: 32, width: 160, borderRadius: 8 }} />
        {/* chip 占位 ×6（h-8 w-16：32×64，条内间距 12 同 ChipsBar） */}
        <View style={{ flexDirection: 'row', gap: 12, paddingVertical: 2 }}>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} style={{ height: 32, width: 64, borderRadius: 8 }} />
          ))}
        </View>
        <VideoGrid loading={10} />
      </View>
    );
  }

  // ———————————————— 元数据拉取失败：整页错误态（带重试）————————————————
  if (meta.error) {
    return (
      <View style={{ flex: 1, paddingHorizontal: padH, paddingTop: chrome.top }}>
        <ErrorState message={'板块信息加载失败：' + meta.error} onRetry={meta.retry} />
      </View>
    );
  }

  // ———————————————— section id 失效（站方布局改版/脏深链）：不渲染半死页面 ————————————————
  if (!sec) {
    return (
      <View style={{ flex: 1, paddingHorizontal: padH, paddingTop: chrome.top }}>
        <ErrorState message="板块不存在或已改版，请回首页重新进入" />
      </View>
    );
  }

  const hasList = !!(items && items.length);

  // ———————————————— 正常态：页头 + 子标签 chips + 无限滚动网格 ————————————————
  return (
    <View style={{ flex: 1 }}>
      {/* 页头：返回 chip（回首页——dismissTo 弹回 (tabs) 组：POP_TO 语义，深链
          冷启时组不在栈内则替换当前屏，任何路径都成立）+ 板块大标题（NextWeb
          text-lg bold 口径 → RN fontSize 18/700） */}
      <View style={{ paddingHorizontal: padH, paddingTop: 12 + chrome.top, marginBottom: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Button variant="ghost" onPress={() => router.dismissTo('/')}>
          <ChevronLeft size={16} color={p.foreground} />
          <Text style={{ color: p.foreground, fontSize: 14, fontWeight: '500', includeFontPadding: false }}>
            首页
          </Text>
        </Button>
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 18, fontWeight: '700', color: p.foreground }}>
          {sec.title}
        </Text>
      </View>

      {/* 子标签 chips 行（仅带子标签的板块；本地 active 态，默认档「综合」高亮） */}
      {Array.isArray(sec.tabs) && sec.tabs.length > 0 ? (
        <View style={{ paddingHorizontal: padH, marginBottom: 16 }}>
          <ChipsBar
            items={sec.tabs.filter((t) => t && t.title != null).map((t) => ({ key: tabKey(t.id), label: String(t.title) }))}
            active={tab}
            onChange={changeTab}
          />
        </View>
      ) : null}

      {/* 列表主体：首屏骨架 / 失败重试 / 空态 / 网格 + 无限滚动 */}
      <View style={{ flex: 1, minHeight: 0, paddingHorizontal: padH }}>
        {loading ? (
          <VideoGrid loading={10} />
        ) : err && !items ? (
          <ErrorState message={err} onRetry={reload} />
        ) : !hasList ? (
          <EmptyState icon={VideoFrame} title="暂无视频" />
        ) : (
          <VideoGrid
            items={items}
            onPress={openVideo}
            onEndReached={loadMore}
            contentContainerStyle={{ paddingBottom: 12 + chrome.bottom }}
          />
        )}
      </View>

      {/* 列表底态条：加载更多失败（重试）/ 到底 / 加载中（与首页同款，见文件头） */}
      {hasList ? (
        <View style={{ paddingHorizontal: padH, paddingBottom: 12 + chrome.bottom }}>
          <ListFooter loading={loadingMore} error={err || ''} done={done} onRetry={loadMore} />
        </View>
      ) : null}
    </View>
  );
}
