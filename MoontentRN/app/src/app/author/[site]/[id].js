// ============================================================================
// author/[site]/[id].js —— 作者页（YouTube 频道页形态，仅 author 能力站点）
// ----------------------------------------------------------------------------
// 逐条移植 NextWeb app/author/[site]/[id]/page.js。头部作者资料（头像/名称/
// 验证勾/视频数）+ 无限滚动片单。site 一律用路由参数（深链直达，不用站点
// 上下文）。数据：author（资料）与 byauthor（片单分页）互相独立加载、各自
// 可重试（同观看页「详情/相关」的解耦模式）。该站无 author 能力时错误态
// （深链防御）+ 回首页；站点元数据未就绪时整页骨架，避免 caps 未定时误闪
// 错误态。产品原则：无 banner、无订阅按钮、无社交数据；其他站点在卡片/
// 详情页不出现任何作者入口。
// ============================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { Verified } from '../../../components/icons.js';
import { api, absolutizeUrl } from '../../../lib/client.js';
import { useSite } from '../../../lib/site-context.jsx';
import { useForm } from '../../../lib/use-form.js';
import { useOpenVideo } from '../../../lib/open-video.js';
import { useInfiniteList, toPage } from '../../../hooks/use-infinite-list.js';
import VideoGrid from '../../../components/video/VideoGrid.jsx';
import { EmptyState, ErrorState, LoadMoreBar } from '../../../components/zones/PageStates.jsx';
import Skeleton from '../../../components/ui/Skeleton.jsx';
import Button from '../../../components/ui/Button.jsx';
import { usePalette } from '../../../components/ui/palette.js';
import { useChromeInsets } from '../../../hooks/use-chrome-scroll.js';

const PAGE_SIZE = 24;

// 头部骨架：头像圆 + 名称/meta 两行（与资料区形态对齐）
function HeadSkeleton() {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 24 }}>
      <Skeleton style={{ width: 80, height: 80, borderRadius: 40 }} />
      <View style={{ gap: 8 }}>
        <Skeleton style={{ height: 24, width: 160 }} />
        <Skeleton style={{ height: 16, width: 96 }} />
      </View>
    </View>
  );
}

export default function AuthorPage() {
  const params = useLocalSearchParams();
  const siteParam = params.site ? String(params.site) : '';
  // 视频跳转统一口径（lib/open-video.js）：桌面壳主窗弹独立播放窗
  const goVideo = useOpenVideo();
  const rawId = params.id ? String(params.id) : '';
  // 作者 id 形态按站点各异（数字系/字符串系）：非空安全字符集即可，原样当字符串用
  const id = /^[0-9A-Za-z_-]{1,64}$/.test(rawId) ? rawId : null;
  const { width } = useForm();
  const p = usePalette();
  const padH = width >= 768 ? 24 : 12; // 主区留白约定：px-3 / md:px-6
  const padB = width >= 768 ? 48 : 16;
  // 壳层避让：手机画幅顶/底栏悬浮于内容之上，首末内容需自垫（pad/PC 恒 0）
  const chrome = useChromeInsets();
  const big = width >= 1024; // lg 档：头像 128（NextWeb lg:size-32），其余 80

  // 路由站点的能力：author 能力判定（查不到当全 false）
  const { sites, ready } = useSite();
  const siteMeta = sites.find((s) => s.id === siteParam);
  const siteCaps = (siteMeta && siteMeta.capabilities) || {};
  const capsAuthor = !!siteCaps.author;

  // 作者资料：独立加载/重试，不与片单耦合
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  useEffect(() => {
    if (id == null || !ready || !capsAuthor) return;
    let alive = true;
    setLoading(true);
    setErr('');
    setInfo(null);
    api(siteParam, 'author', { id })
      .then((a) => {
        if (!alive) return;
        if (!a || a.id == null) throw new Error('作者数据形态异常');
        setInfo(a);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setErr((e && e.message) || '作者加载失败');
        setLoading(false);
      });
    return () => { alive = false; };
  }, [siteParam, id, retryKey, ready, capsAuthor]);

  // 片单：无限滚动（条件未齐时挂起，条件翻转后 deps 变化自动重拉）
  const fetchPage = useCallback(
    (page) => {
      if (id == null || !ready || !capsAuthor) return new Promise(() => {});
      return api(siteParam, 'byauthor', { author: id, page, size: PAGE_SIZE }).then(toPage);
    },
    [siteParam, id, ready, capsAuthor]
  );
  const {
    items, loading: listLoading, loadingMore,
    err: listErr, loadMore, reload,
  } = useInfiniteList(fetchPage, [siteParam, id, ready, capsAuthor]);

  // 深链防御态：错误文案 + 回首页（小号胶囊钮）；顶部避让悬浮顶栏
  const guard = (message) => (
    <View style={{ flex: 1, backgroundColor: p.background, paddingHorizontal: padH, paddingTop: chrome.top }}>
      <ErrorState message={message} />
      <View style={{ alignItems: 'center', marginTop: -48 }}>
        {/* 布局静态化的共用按钮（安卓样式函数陷阱由 Button 内部统一规避） */}
        <Button size="sm" variant="secondary" onPress={() => router.dismissTo('/')}>回首页</Button>
      </View>
    </View>
  );

  // 无效 id：无效态（全部 hooks 已调用完毕后再提前返回）
  if (id == null) return guard('作者 ID 无效');

  // 站点元数据未就绪：整页骨架（避免 caps 未定时误闪错误态）；顶部避让悬浮顶栏
  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: p.background, paddingHorizontal: padH, paddingTop: chrome.top }}>
        <HeadSkeleton />
        <VideoGrid loading={10} />
      </View>
    );
  }

  // 该站不支持作者体系（深链防御）
  if (!capsAuthor) return guard(siteMeta ? '该站点不支持作者页' : '未知站点 ' + siteParam);

  // 头部：作者资料（YouTube 频道页：头像 + 名称 + 验证勾 + 视频数；
  // 无 banner、无订阅按钮——产品原则）；随内容滚动作网格 ListHeaderComponent。
  // 外层统一垫 chrome.top：ListHeader 与三条非网格分支（骨架/错误/空态）共用
  const avatarSize = big ? 128 : 80;
  const header = (
    <View style={{ paddingTop: chrome.top }}>
      {loading ? (
        <HeadSkeleton />
      ) : err ? (
        <ErrorState message={'作者加载失败：' + err} onRetry={() => setRetryKey((k) => k + 1)} />
      ) : info ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: big ? 24 : 16, paddingVertical: 24 }}>
          {info.avatar ? (
            <Image
              source={{ uri: absolutizeUrl(info.avatar) }}
              style={{ width: avatarSize, height: avatarSize, borderRadius: avatarSize / 2 }}
              contentFit="cover"
              transition={200}
            />
          ) : (
            <View
              style={{
                width: avatarSize,
                height: avatarSize,
                borderRadius: avatarSize / 2,
                backgroundColor: p.surface2,
              }}
            />
          )}
          <View style={{ minWidth: 0, flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text
                numberOfLines={1}
                style={{ flexShrink: 1, fontSize: big ? 24 : 18, fontWeight: '700', color: p.foreground }}
              >
                {info.name || '(未知作者)'}
              </Text>
              {!!info.verified ? (
                <Verified size={20} color={p.muted} accessibilityLabel="认证作者" />
              ) : null}
            </View>
            <Text style={{ marginTop: 4, fontSize: 14, color: p.muted }}>
              {(siteMeta && siteMeta.name) || siteParam}
              {info.videoCount > 0 ? ' · ' + info.videoCount + ' 个视频' : ''}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );

  const body = (() => {
    if (listLoading) {
      return (
        <View style={{ paddingBottom: padB + chrome.bottom }}>
          {header}
          <VideoGrid loading={10} />
        </View>
      );
    }
    if (listErr && !items) {
      return (
        <View style={{ paddingBottom: padB + chrome.bottom }}>
          {header}
          <ErrorState message={listErr} onRetry={reload} />
        </View>
      );
    }
    if (!items || !items.length) {
      return (
        <View style={{ paddingBottom: padB + chrome.bottom }}>
          {header}
          <EmptyState title="该作者暂无视频" />
        </View>
      );
    }
    return (
      <VideoGrid
        items={items}
        ListHeaderComponent={header}
        onEndReached={loadMore}
        contentContainerStyle={{ paddingBottom: padB + chrome.bottom }}
        onPress={(v) => {
          // 深链口径统一 useOpenVideo（桌面壳主窗弹独立播放窗）
          if (v && v.id != null) goVideo(siteParam, String(v.id));
        }}
      />
    );
  })();

  return (
    <View style={{ flex: 1, backgroundColor: p.background, paddingHorizontal: padH }}>
      {body}
      {/* 加载更多态：页底浮层（共享网格不透传列表尾部，见 LoadMoreBar 注释） */}
      {items && items.length ? (
        <LoadMoreBar loadingMore={loadingMore} err={listErr} onRetry={loadMore} />
      ) : null}
    </View>
  );
}
