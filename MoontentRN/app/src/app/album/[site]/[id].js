// ============================================================================
// album/[site]/[id].js —— 相册详情页（看图落地页，?p=N 看图器深链）
// ----------------------------------------------------------------------------
// 逐条移植 NextWeb app/album/[site]/[id]/page.js。路由对齐观看页
// （/album/{site}/{id}，site 取自路径参数，深链友好）；?p=N 为看图器深链
// （1 起；详情就绪后自动打开到该张，仅消费一次）。
// 结构：页头（返回「相册」链 + 标题 + 「N 张照片 · 时间」+ 作者行 + 描述 +
// 分类 chip）/ 原比例瀑布流（多列最短路分配，无裁切；200x150 缩略图——原图
// 数 MB 级只进看图器按需加载）/ 相关相册（契约 related 可选字段，有才渲染）。
// 点击任一照片 → PhotoViewer 全屏看图器（Google Photos 级交互，YouTube 皮）。
// 相册不进观看历史（本机足迹按视频卡片建模，混入相册会污染历史卡形态）。
// 瀑布流列数对齐 NextWeb CSS columns 断点：2 列（手机）→ sm 3 → md 4 → xl 5
// → 2xl 6；列内条目高随图片真实比例落地（默认 4:3，onLoad 后按原图比例重排）。
// ============================================================================
import React, { Suspense, useEffect, useRef, useState } from 'react';
import {Pressable, Text, View} from 'react-native';
import useDimensions from '../../../lib/use-dimensions.js';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft, Gallery } from '../../../components/icons.js';
import { api, absolutizeUrl } from '../../../lib/client.js';
import { useSite } from '../../../lib/site-context.jsx';
import { useForm } from '../../../lib/use-form.js';
import AlbumCard from '../../../components/album/AlbumCard.jsx';
import { albumCardWidthFor, albumColumnsFor } from '../../../components/album/AlbumGrid.jsx';
import Chip from '../../../components/ui/Chip.jsx';
import Skeleton from '../../../components/ui/Skeleton.jsx';
import { usePalette } from '../../../components/ui/palette.js';
import usePressVisual from '../../../lib/use-press-visual.js';
import { coverUrl, useDataSaver } from '../../../components/ui/cover.js';
import { EmptyState, ErrorState } from '../../../components/zones/PageStates.jsx';
import ScreenScrollView from '../../../components/layout/ScreenScrollView.jsx';
import { useChromeInsets } from '../../../hooks/use-chrome-scroll.js';
// PhotoViewer 懒加载：它独占 reanimated+worklets 运行时（~800KB），静态导入
// 会被 metro 提进 __common 首屏 chunk；lazy 后随动态 chunk 只在首次点开照片
// 时加载（原生端 async require 本地解析，同样成立）。fallback=null：点开首张
// 照片到 chunk 就绪之间的极短窗口保持底下的网格不动，不出闪烁占位。
const PhotoViewer = React.lazy(() => import('../../../components/album/PhotoViewer.jsx'));

// 瀑布流列数：容器宽 → 列数（NextWeb CSS columns 断点：sm 640 / md 768 /
// xl 1280 / 2xl 1536，之下手机 2 列起步）
function wallColumnsFor(w) {
  if (!(w > 0)) return 2;
  if (w < 640) return 2;
  if (w < 768) return 3;
  if (w < 1280) return 4;
  if (w < 1536) return 5;
  return 6;
}

export default function AlbumPage() {
  const params = useLocalSearchParams();
  const siteParam = params.site ? String(params.site) : '';
  const rawId = params.id ? String(params.id) : '';
  const id = /^[0-9A-Za-z_-]{1,64}$/.test(rawId) ? rawId : null;
  const { width: winW } = useForm();
  const win = useDimensions();
  const p = usePalette();
  const backHv = usePressVisual(); // 布局静态化（安卓样式函数陷阱，见 use-press-visual 头注）
  const saver = useDataSaver(); // 省流档：缩略图收窄 320 宽
  const padH = winW >= 768 ? 24 : 12; // 主区留白约定：px-3 / md:px-6
  const padB = winW >= 768 ? 48 : 16;
  // 壳层避让：手机画幅顶/底栏悬浮于内容之上（滚动容器走 ScreenScrollView，
  // 下面的守卫态提前 return 是普通 View，需自行垫顶）
  const chrome = useChromeInsets();

  // 路由站点能力：非 albums 能力站点直达时给空态（不造假）
  const { sites } = useSite();
  const siteMeta = sites.find((s) => s.id === siteParam);
  const siteCaps = (siteMeta && siteMeta.capabilities) || {};

  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const [viewer, setViewer] = useState(-1); // -1=关；≥0=看图器当前张序号
  const pOnce = useRef(false);              // ?p 深链只消费一次

  // 详情加载：id/site 变化全量重置重拉（alive 防卸载后 setState）
  useEffect(() => {
    if (id == null) return;
    let alive = true;
    setLoading(true);
    setErr('');
    setDetail(null);
    setViewer(-1);
    pOnce.current = false;
    api(siteParam, 'album', { id })
      .then((d) => {
        if (!alive) return;
        if (!d || d.id == null) throw new Error('相册数据形态异常');
        setDetail(d);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setErr((e && e.message) || '相册加载失败');
        setLoading(false);
      });
    return () => { alive = false; };
  }, [siteParam, id, retryKey]);

  // ?p=N 深链：详情就绪后自动打开看图器到该张（仅一次）
  useEffect(() => {
    if (!detail || pOnce.current) return;
    pOnce.current = true;
    const i = parseInt(params.p, 10);
    if (Number.isFinite(i) && i >= 1 && i <= (detail.photos || []).length) setViewer(i - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);

  // —— 瀑布流状态（hooks 必须在下方无效态提前 return 之前调用）——
  // 容器实测宽 → 列数/列宽；已知比例表（序号 → 宽高比，onLoad 修正，默认 4:3）
  const [wallW, setWallW] = useState(0);
  const [aspects, setAspects] = useState({});

  // 无效 id / 无相册能力的站点
  if (id == null) {
    return (
      <View style={{ flex: 1, backgroundColor: p.background, paddingHorizontal: padH, paddingTop: chrome.top }}>
        <ErrorState message="无效的相册地址" />
      </View>
    );
  }
  if (!loading && !err && siteCaps && siteCaps.albums === false) {
    return (
      <View style={{ flex: 1, backgroundColor: p.background, paddingHorizontal: padH, paddingTop: chrome.top }}>
        <EmptyState icon={Gallery} title="当前站点没有相册专区" desc="此相册来自支持相册的站点（如艾薇社区）" />
      </View>
    );
  }

  const d = detail;
  const photos = (d && d.photos) || [];
  const related = (d && d.related) || [];

  // —— 瀑布流：容器实测宽 → 列数/列宽；条目高按真实比例（默认 4:3，onLoad 修正） ——
  const cols = wallColumnsFor(wallW || win.width);
  const gap = 8; // gap-2（NextWeb 瀑布流同值）
  const colW = ((wallW || win.width) - gap * (cols - 1)) / cols;
  // 已知比例表（序号 → 宽高比）；上游缩略图恒 200x150，默认 4:3
  const noteAspect = (i, w, h) => {
    if (!(w > 0) || !(h > 0)) return;
    setAspects((prev) => (prev[i] === w / h ? prev : { ...prev, [i]: w / h }));
  };
  // 最短路分配：按已知/默认比例的估高，逐张放进当前最矮列（CSS columns 语义）
  const wallCols = (() => {
    const buckets = Array.from({ length: cols }, () => []);
    const totals = new Array(cols).fill(0);
    photos.forEach((ph, i) => {
      const ar = aspects[i] || 4 / 3;
      const h = colW / ar;
      let k = 0;
      for (let j = 1; j < cols; j++) if (totals[j] < totals[k]) k = j;
      buckets[k].push({ ph, i });
      totals[k] += h + gap;
    });
    return buckets;
  })();

  const author = d && d.author && d.author.id != null ? d.author : null;

  return (
    <View style={{ flex: 1, backgroundColor: p.background }}>
      <ScreenScrollView
        showsVerticalScrollIndicator={false}
        topGap={4}
        bottomGap={padB}
        contentContainerStyle={{ paddingHorizontal: padH }}
      >
        {/* —— 页头：返回 + 标题 + 元信息 + 作者行 + 描述 + 分类 —— */}
        <View style={{ marginBottom: 16, gap: 8 }}>
          {/* 返回链：muted 色文字钮（NextWeb hover 提亮的 RN 等价 = 按下态反馈） */}
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="返回相册列表"
            onPress={() => router.dismissTo('/albums')}
            {...backHv.binds}
            style={[
              { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingHorizontal: 6, paddingVertical: 4 },
              { opacity: backHv.pressed ? 0.7 : 1 },
            ]}
          >
            <ChevronLeft size={16} color={p.muted} />
            <Text style={{ fontSize: 14, color: p.muted }}>相册</Text>
          </Pressable>
          {loading ? (
            <View style={{ gap: 8, paddingTop: 4 }}>
              <Skeleton style={{ height: 24, width: '75%' }} />
              <Skeleton style={{ height: 16, width: '33%' }} />
            </View>
          ) : err ? (
            <ErrorState message={err} onRetry={() => setRetryKey((k) => k + 1)} />
          ) : d ? (
            <>
              <Text style={{ fontSize: 20, fontWeight: '700', lineHeight: 28, color: p.foreground }}>
                {d.title || '(无标题)'}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 4 }}>
                <Text style={{ fontSize: 14, color: p.muted, fontVariant: ['tabular-nums'] }}>
                  {d.count || photos.length} 张照片
                </Text>
                {d.uploadDate ? <Text style={{ fontSize: 14, color: p.muted }}>{d.uploadDate}</Text> : null}
              </View>
              {/* 作者行：契约可选字段（相册上传者；头像上游常缺，灰圆兜底） */}
              {author ? (
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={'查看作者 ' + (author.name || '')}
                  onPress={() =>
                    router.push({ pathname: '/author/[site]/[id]', params: { site: siteParam, id: String(author.id) } })
                  }
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 12, alignSelf: 'flex-start', paddingVertical: 4, paddingRight: 8 }}
                >
                  {author.avatar ? (
                    <Image
                      source={{ uri: coverUrl(absolutizeUrl(author.avatar), saver) }}
                      style={{ width: 40, height: 40, borderRadius: 20 }}
                      contentFit="cover"
                      transition={200}
                    />
                  ) : (
                    <View
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 20,
                        backgroundColor: p.surface2,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Gallery size={20} color={p.muted} opacity={0.6} />
                    </View>
                  )}
                  <Text style={{ fontSize: 14, fontWeight: '500', color: p.foreground }}>{author.name}</Text>
                </Pressable>
              ) : null}
              {d.description ? (
                <Text style={{ fontSize: 14, lineHeight: 22, color: p.muted }}>{d.description}</Text>
              ) : null}
              {(d.categories || []).length > 0 ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 4 }}>
                  {(d.categories || []).map((c) => (
                    <Chip
                      key={String(c.id)}
                      label={c.name || String(c.id)}
                      onPress={() => router.dismissTo({ pathname: '/albums', params: { cat: String(c.id) } })}
                    />
                  ))}
                </View>
              ) : null}
            </>
          ) : null}
        </View>

        {/* —— 照片瀑布流：原比例无裁切，点击进看图器 —— */}
        <View
          onLayout={(e) => setWallW(e.nativeEvent.layout.width)}
          style={{ flexDirection: 'row', alignItems: 'flex-start', gap }}
        >
          {loading ? (
            // 骨架：按列铺 3:4 / 4:3 交替占位（与真实瀑布形态对齐）
            Array.from({ length: cols }, (_, c) => (
              <View key={'sk' + c} style={{ flex: 1, gap }}>
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} style={{ width: '100%', aspectRatio: (i + c) % 3 === 0 ? 3 / 4 : 4 / 3, borderRadius: 8 }} />
                ))}
              </View>
            ))
          ) : err ? null : photos.length ? (
            wallCols.map((bucket, c) => (
              <View key={'col' + c} style={{ width: colW, gap }}>
                {bucket.map(({ ph, i }) => (
                  <Pressable
                    key={(ph && (ph.url || ph.thumb)) || i}
                    accessibilityRole="imagebutton"
                    accessibilityLabel={'查看第' + (i + 1) + '张照片'}
                    onPress={() => setViewer(i)}
                    style={{ width: '100%', borderRadius: 8, overflow: 'hidden', backgroundColor: p.surface }}
                  >
                    {({ pressed }) => (
                      <View style={{ opacity: pressed ? 0.9 : 1 }}>
                    <Image
                      source={{ uri: coverUrl(ph.thumb || ph.url, saver) }}
                      style={{ width: '100%', aspectRatio: aspects[i] || 4 / 3 }}
                      contentFit="cover"
                      transition={200}
                      recyclingKey={'wall-' + i}
                      onLoad={(e) => {
                        const s = e && e.source;
                        if (s) noteAspect(i, s.width, s.height);
                      }}
                    />
                      </View>
                    )}
                  </Pressable>
                ))}
              </View>
            ))
          ) : null}
        </View>
        {!loading && !err && !photos.length ? <EmptyState icon={Gallery} title="相册内没有照片" /> : null}

        {/* —— 相关相册（契约可选字段，有才渲染；方卡 wrap 网格） —— */}
        {!loading && !err && related.length > 0 ? (
          <View style={{ marginTop: 40, gap: 12 }}>
            <Text style={{ fontSize: 16, fontWeight: '500', color: p.foreground }}>相关相册</Text>
            <RelatedRow related={related} site={siteParam} />
          </View>
        ) : null}
      </ScreenScrollView>

      {/* —— 全屏看图器（渐进加载/缩放平移/胶片条/返回键关闭；懒加载见上） —— */}
      {viewer >= 0 && photos.length > 0 ? (
        <Suspense fallback={null}>
          <PhotoViewer
            photos={photos}
            index={viewer}
            onIndexChange={setViewer}
            onClose={() => setViewer(-1)}
            title={d ? d.title : ''}
          />
        </Suspense>
      ) : null}
    </View>
  );
}

// 相关相册行：方卡 wrap 网格（复用 AlbumGrid 的列算法常量；数量少，直接铺不虚拟化）
function RelatedRow({ related, site }) {
  const p = usePalette();
  const [w, setW] = useState(0);
  const win = useDimensions();
  const width = w || win.width;
  const cols = albumColumnsFor(width) || 2;
  const card = albumCardWidthFor(width, cols) || width / cols;
  const compact = width < 768;
  const gap = compact ? 12 : 16;
  const rowGap = compact ? 16 : 32;
  return (
    <View
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
      style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: gap, rowGap }}
    >
      {related.map((a, i) => (
        <View
          key={a && a.id != null ? String(a.id) : 'x_' + i}
          style={{ width: card, backgroundColor: p.background }} // 间距由外层 columnGap/rowGap 落地
        >
          <AlbumCard
            item={a}
            onPress={(it) =>
              it && router.push({ pathname: '/album/[site]/[id]', params: { site, id: String(it.id) } })
            }
          />
        </View>
      ))}
    </View>
  );
}
