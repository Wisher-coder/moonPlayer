// ============================================================================
// package/[site]/[id].js —— 量贩包/合集整包片单页（?k=gather 切合集数据源）
// ----------------------------------------------------------------------------
// 逐条移植 NextWeb app/package/[site]/[id]/page.js。三区整包片单的浏览面——
// 量贩包（videoPackage/getDetail）与合集（gather/getDetail）上游同构（整包全量
// 无分页，游客可读），共用本页呈现，?k=gather 切换数据源与返回目标
// （k 缺省=量贩）。头部 = 返回 chip 链回 /zones 对应 tab + 包名 + N 部 +
// 描述（两行截断，无描述不占行）；内容 = VideoGrid 卡片网格（条目即归一化
// VideoItem，深链观看页 /video/{site}/{id}；观看页内另有选集队列面板承接连播）。
// site 取路由参数（深链直达，不用站点上下文）；含羞草两套包体系 id 均为正整数，
// 非法 id 走无效态。整包全量无分页 → 无限滚动不接，网格即全量。
// ============================================================================
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft, Clapperboard } from '../../../components/icons.js';
import { api } from '../../../lib/client.js';
import { useForm } from '../../../lib/use-form.js';
import { useOpenVideo } from '../../../lib/open-video.js';
import VideoGrid from '../../../components/video/VideoGrid.jsx';
import { EmptyState, ErrorState } from '../../../components/zones/PageStates.jsx';
import { usePalette } from '../../../components/ui/palette.js';
import usePressVisual from '../../../lib/use-press-visual.js';
import Button from '../../../components/ui/Button.jsx';
import { useChromeInsets } from '../../../hooks/use-chrome-scroll.js';

export default function PackagePage() {
  const params = useLocalSearchParams();
  const siteParam = params.site ? String(params.site) : '';
  // 视频跳转统一口径（lib/open-video.js）：桌面壳主窗弹独立播放窗
  const goVideo = useOpenVideo();
  const rawId = params.id ? String(params.id) : '';
  // 含羞草两套包体系 id 均为正整数；非法 id 走无效态
  const id = /^\d{1,10}$/.test(rawId) ? rawId : null;
  const isGather = params.k === 'gather';
  const { width } = useForm();
  const p = usePalette();
  const backHv = usePressVisual(); // 布局静态化（安卓样式函数陷阱，见 use-press-visual 头注）
  const padH = width >= 768 ? 24 : 12; // 主区留白约定：px-3 / md:px-6
  const padB = width >= 768 ? 48 : 16; // md:pb-12 档，手机紧凑
  // 壳层避让：手机画幅顶/底栏悬浮于内容之上，首末内容需自垫（pad/PC 恒 0）
  const chrome = useChromeInsets();
  const kind = isGather ? '合集' : '量贩包';

  // 整包取数：两源同构 {id,title,description,count,items}，一次拉全量无分页
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  useEffect(() => {
    if (id == null) return;
    let alive = true;
    setLoading(true);
    setErr('');
    setData(null);
    api(siteParam, isGather ? 'gather' : 'package', { id })
      .then((d) => {
        if (!alive) return;
        if (!d || d.id == null) throw new Error('包数据形态异常');
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setErr((e && e.message) || '加载失败');
        setLoading(false);
      });
    return () => { alive = false; };
  }, [siteParam, id, isGather, retryKey]);

  // 无效 id：无效态 + 回专区；顶部避让悬浮顶栏
  if (id == null) {
    return (
      <View style={{ flex: 1, backgroundColor: p.background, paddingHorizontal: padH, paddingTop: chrome.top }}>
        <ErrorState message={kind + ' ID 无效'} />
        <View style={{ alignItems: 'center', marginTop: -48 }}>
          {/* 布局静态化的共用按钮（安卓样式函数陷阱由 Button 内部统一规避） */}
          <Button size="sm" variant="secondary" onPress={() => router.dismissTo({ pathname: '/zones', params: { tab: isGather ? 'gather' : 'package' } })}>回专区</Button>
        </View>
      </View>
    );
  }

  const title = (data && data.title) || '';
  const count = data ? data.count || (data.items ? data.items.length : 0) : 0;

  // 页头：返回 chip 链回对应专区 tab + 包名 + 部数 + 描述（两行截断；
  // 随内容滚动，作网格 ListHeaderComponent）。外层统一垫 chrome.top：
  // ListHeader 与三条非网格分支（骨架/错误/空态）共用
  const header = (
    <View style={{ paddingTop: chrome.top }}>
      <View style={{ marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="回专区"
          onPress={() => router.dismissTo({ pathname: '/zones', params: { tab: isGather ? 'gather' : 'package' } })}
          {...backHv.binds}
          style={[
            { flexDirection: 'row', alignItems: 'center', gap: 4, height: 40, borderRadius: 20, paddingHorizontal: 12 },
            { backgroundColor: backHv.hovered ? p.surface2 : 'transparent', opacity: backHv.pressed ? 0.85 : 1 },
          ]}
        >
          <ChevronLeft size={16} color={p.foreground} />
          <Text style={{ color: p.foreground, fontSize: 14, fontWeight: '500', includeFontPadding: false }}>专区</Text>
        </Pressable>
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 18, fontWeight: '700', color: p.foreground }}>
          {title || kind}
        </Text>
        {!loading ? (
          <Text style={{ fontSize: 14, color: p.muted, fontVariant: ['tabular-nums'], includeFontPadding: false }}>
            {count} 部
          </Text>
        ) : null}
      </View>
      {/* 描述：两行截断（与描述盒克制同档，无描述不占行） */}
      {!!data && !!data.description ? (
        <Text numberOfLines={2} style={{ marginBottom: 16, fontSize: 14, lineHeight: 22, color: p.muted }}>
          {data.description}
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: p.background, paddingHorizontal: padH }}>
      {loading ? (
        // 首屏：页头 + 网格骨架（无数据可回收，普通布局即可）
        <View style={{ paddingBottom: padB + chrome.bottom }}>
          {header}
          <VideoGrid loading={10} />
        </View>
      ) : err ? (
        <View style={{ paddingBottom: padB + chrome.bottom }}>
          {header}
          <ErrorState message={kind + '加载失败：' + err} onRetry={() => setRetryKey((k) => k + 1)} />
        </View>
      ) : !data || !data.items || !data.items.length ? (
        <View style={{ paddingBottom: padB + chrome.bottom }}>
          {header}
          <EmptyState icon={Clapperboard} title="包内暂无视频" />
        </View>
      ) : (
        // 整包全量：VideoGrid（FlashList 回收）+ 页头随内容滚动；卡片深链口径
        // 统一 useOpenVideo（桌面壳主窗弹独立播放窗）
        <VideoGrid
          items={data.items}
          ListHeaderComponent={header}
          contentContainerStyle={{ paddingBottom: padB + chrome.bottom }}
          onPress={(v) => {
            if (v && v.id != null) goVideo(siteParam, String(v.id));
          }}
        />
      )}
    </View>
  );
}
