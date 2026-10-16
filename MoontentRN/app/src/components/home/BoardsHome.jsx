// ============================================================================
// BoardsHome.jsx —— 板块书架首页（仅 boards 能力站点，如含羞草）
// ----------------------------------------------------------------------------
// NextWeb src/components/video/BoardsHome.jsx 的 RN 三端移植。首页按 caps.boards
// 整页切换到此（经典「chips+无限流」路径不参与渲染）。数据经 use-boards 中间件
// 一次拉全；每板块按 YouTube 书架版式呈现：
//   书架头（标题 20px/700/行高 28 = ytd-rich-shelf-renderer 实测 +「查看全部」
//   深链钮——已接通 /board 板块页（app/board.js，源 NextWeb/app/board/page.js），
//   phone/pad/pc 全形态都显示，与 NextWeb 一致）
//   + 子标签 chips（rowGroup 型板块；本地 active 态，切换走 api board 就地换行
//   数据，按 (板块, 子标签) 缓存切回不重拉，失败后重按当前档即重试）
//   + 内容区同一份数据按画幅切形态：
//     phone  两列多行网格（移动端不做横滑书架：一屏只露两张发现性差，多行
//            网格让分组内容随页面纵滚自然铺开；列距 12/行距 16 紧凑档）；
//     pad/pc 桌面书架横滚轨道（卡宽 = 同页网格列宽口径 use-grid-columns 按
//            容器实测宽算出，未测到前退化 272；snap 吸附 + 隐藏滚动条；
//            NextWeb 的悬停翻页箭头/滚轮接管是 web 鼠标交互，触屏三端App
//            以横滑手势为原生路径，不搬运）。
// 竞态防护：子标签切换用世代号（迟到的旧响应丢弃），与全站 hook 手法一致。
// ============================================================================
import React, { useCallback, useRef, useState } from 'react';
import {Pressable, ScrollView, Text, View} from 'react-native';
import useDimensions from '../../lib/use-dimensions.js';
import { useRouter } from 'expo-router';
import { Clapperboard, ChevronRight } from '../icons.js';
import { api } from '../../lib/client.js';
import useBoards from '../../hooks/use-boards.js';
import { useOpenVideo } from '../../lib/open-video.js';
import useGridColumns, { columnsFor, cardWidthFor } from '../../hooks/use-grid-columns.js';
import { useForm } from '../../lib/use-form.js';
import { usePalette } from '../ui/palette.js';
import VideoCard from '../video/VideoCard.jsx';
import ChipsBar from '../video/ChipsBar.jsx';
import Skeleton from '../ui/Skeleton.jsx';
import ErrorState from './ErrorState.jsx';
import EmptyState from './EmptyState.jsx';
import usePressVisual from '../../lib/use-press-visual.js';

// 子标签键归一：null/undefined/'' 一律折叠到 ''（默认档「综合」）
const tabKey = (id) => (id == null || id === '' ? '' : String(id));

// —— 骨架卡位:16:9 封面 + 两行标题条(与 VideoCard/VideoGrid 骨架同形态,
// 加载完成后不发生纵向跳变)——
function SkeletonCell({ width }) {
  return (
    <View style={{ width }}>
      <Skeleton style={{ aspectRatio: 16 / 9, borderRadius: 12 }} />
      <View style={{ marginTop: 12, gap: 8 }}>
        <Skeleton style={{ height: 14 }} />
        <Skeleton style={{ height: 12, width: '66%' }} />
      </View>
    </View>
  );
}

// —— 单板块行：书架头 + 子标签 chips + 内容区（phone 两列网格 / pad+ 横滚轨道）——
function BoardSection({ site, sec, railCard, phoneCard, railCount }) {
  const router = useRouter();
  const p = usePalette();
  const allHv = usePressVisual(); // 布局静态化 + 按压视觉态事件 state（安卓样式函数陷阱）
  const { form } = useForm();
  const [tab, setTab] = useState(null);                        // 当前子标签键（null=默认档）
  const [rows, setRows] = useState(() => ({ '': sec.items })); // 子标签键 → items 缓存
  const [pending, setPending] = useState(null);                 // 在途子标签键（null=无；'' 会误判默认档在途）
  const [failed, setFailed] = useState('');
  const seqRef = useRef(0);

  // 子标签切换：重复点当前档不动作（失败档重按 = 重试）；已缓存直接切不重拉
  const switchTab = useCallback((k) => {
    const same = k === tabKey(tab);
    if (same && !failed) return;
    setTab(k);
    setFailed('');
    if (rows[k]) return; // 已缓存：直接切，不重拉
    setPending(k);
    const seq = ++seqRef.current;
    api(site, 'board', { id: sec.id, tab: k || undefined, page: 1, size: 12 })
      .then((res) => {
        if (seq !== seqRef.current) return; // 迟到的旧响应：丢弃
        const items = (res && Array.isArray(res.items) ? res.items : []).filter(Boolean);
        setRows((prev) => ({ ...prev, [k]: items }));
        setPending((prev) => (prev === k ? '' : prev));
      })
      .catch((e) => {
        if (seq !== seqRef.current) return;
        setFailed((e && e.message) || '子标签加载失败');
        setPending((prev) => (prev === k ? '' : prev));
      });
  }, [site, sec.id, tab, rows, failed]);

  const k = tabKey(tab);
  const items = rows[k] || [];
  const loading = pending === k; // 未缓存在途：骨架行；已缓存档即时切，不闪骨架

  // 卡片深链观看页（封面/标题一体可点；作者行回退同链——VideoGrid 未透传 onAuthor）；
  // 跳转口径统一 useOpenVideo（桌面壳主窗弹独立播放窗）
  const goVideo = useOpenVideo();
  const openVideo = useCallback((v) => {
    if (v && v.id != null) goVideo(site, v.id);
  }, [site, goVideo]);

  return (
    <View>
      {/* 书架头：YouTube 惯例标题左对齐 20/700/28 +「查看全部 ›」深链钮（全形态
          都显示，深链 /board?section= 板块页承接；标题 flex:1 截断，钮不被挤走） */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 20, fontWeight: '700', lineHeight: 28, color: p.foreground }}>
          {sec.title}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={'查看全部：' + sec.title}
          onPress={() => router.push({ pathname: '/board', params: { section: String(sec.id) } })}
          {...allHv.binds}
          style={[{ opacity: allHv.pressed ? 0.6 : 1 }]}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <Text style={{ fontSize: 14, color: p.muted }}>查看全部</Text>
            <ChevronRight size={16} color={p.muted} />
          </View>
        </Pressable>
      </View>
      {sec.tabs ? (
        <View style={{ marginBottom: 12 }}>
          <ChipsBar
            items={(sec.tabs || []).map((t) => ({ key: tabKey(t.id), label: t.title }))}
            active={k}
            onChange={switchTab}
          />
        </View>
      ) : null}
      {failed ? (
        <View style={{ paddingBottom: 8 }}>
          <Text style={{ fontSize: 12, color: p.muted }}>{failed + '，可点击当前子标签重试'}</Text>
        </View>
      ) : null}
      {loading ? (
        // 未缓存在途:骨架行(形态与正式内容区一致;pad 轨道块数按可视宽截断
        // + overflow hidden,骨架不冲出右缘)
        <View
          style={
            form === 'phone'
              ? { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 16 }
              : { flexDirection: 'row', gap: 16, overflow: 'hidden' }
          }
        >
          {Array.from({ length: form === 'phone' ? 6 : railCount }, (_, i) => (
            <SkeletonCell key={i} width={form === 'phone' ? phoneCard || 160 : railCard} />
          ))}
        </View>
      ) : items.length ? (
        form === 'phone' ? (
          // phone：两列多行网格（列距 12/行距 16 紧凑档），内容随页面纵滚铺开
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 16 }}>
            {items.map((v) => (
              <View key={String(v && v.id)} style={{ width: phoneCard }}>
                <VideoCard item={v} onPress={openVideo} />
              </View>
            ))}
          </View>
        ) : (
          // pad/pc：桌面书架横滚轨道（卡宽 = 网格列宽口径；snap 吸附整卡对齐）
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            snapToAlignment="start"
            snapToInterval={railCard + 16}
            decelerationRate="fast"
            contentContainerStyle={{ gap: 16 }}
          >
            {items.map((v) => (
              <View key={String(v && v.id)} style={{ width: railCard }}>
                <VideoCard item={v} onPress={openVideo} />
              </View>
            ))}
          </ScrollView>
        )
      ) : (
        failed ? null : (
          <Text style={{ paddingVertical: 8, fontSize: 12, color: p.muted }}>该子标签暂无内容</Text>
        )
      )}
    </View>
  );
}

// —— 板块首屏骨架：与真实板块同构——书架头 + 子标签 chips 占位行 + 卡位
// (16:9 + 两行标题条)。含羞草类板块几乎都带子标签(服务端强制拼「综合」
// 档),骨架补齐 chips 行与标题条,加载完成整页不跳位 ——
function BoardsSkeleton({ form, phoneCard, railCard, railCount }) {
  return (
    <View style={{ paddingHorizontal: form === 'phone' ? 12 : 24, paddingVertical: 12, gap: 32 }}>
      {Array.from({ length: 2 }, (_, i) => (
        <View key={i}>
          <Skeleton style={{ marginBottom: 12, height: 28, width: 160 }} />
          {/* chips 占位:h-8 胶囊 ×4(同 ChipsBar 高度口径) */}
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12, paddingVertical: 2 }}>
            {Array.from({ length: 4 }, (_, j) => (
              <Skeleton key={j} style={{ height: 32, width: 64, borderRadius: 8 }} />
            ))}
          </View>
          <View
            style={
              form === 'phone'
                ? { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 16 }
                : { flexDirection: 'row', gap: 16, overflow: 'hidden' }
            }
          >
            {Array.from({ length: form === 'phone' ? 6 : railCount }, (_, j) => (
              <SkeletonCell key={j} width={form === 'phone' ? phoneCard || 160 : railCard} />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

// —— 板块首页本体 ——
// 可选 onScroll/scrollEventThrottle 透传给主纵滚 ScrollView（手机画幅壳层
// 收放方向判定挂载口，见 use-chrome-scroll）；内部横滚轨道不接。
// 可选 topInset/bottomInset：手机画幅内容全出血（栏 overlay），滚动内容与
// 骨架自垫的顶/底安全间距（useChromeInsets 口径，pad/PC 为 0）。
export default function BoardsHome({ site, onScroll, scrollEventThrottle, topInset = 0, bottomInset = 0 }) {
  const { form } = useForm();
  const { sections, loading, error, retry } = useBoards(site);
  // 书架卡宽 = 与首页网格同一套列算法（容器实测宽 → 列宽），挂在纵向滚动容器上测宽
  const { containerWidth, onLayout } = useGridColumns();
  const winWidth = useDimensions().width;

  const padH = form === 'phone' ? 12 : 24; // 页边距：px-3 / md:px-6
  // 净内容宽：容器实测宽优先；未测到（首帧）按窗口宽估算（侧栏占宽在窗口宽
  // 中被忽略，onLayout 到位后即修正），杜绝首帧 0 宽卡
  const cw = Math.max(0, (containerWidth || winWidth) - padH * 2);
  const railCols = columnsFor(cw);
  const railCard = railCols ? cardWidthFor(cw, railCols) || 272 : 272; // 未测到前退化 272（NextWeb 同款兜底）
  // 两列、列距 12;取整与 cardWidthFor 同口径——Yoga 按像素栅格取整后
  // 「两卡×小数宽 + 整数列距」可能超出容器零点几像素,行尾卡被挤到下一行
  // (iPhone 393/375 逻辑宽必出小数,iOS/Android 同陷阱)
  const phoneCard = cw > 12 ? Math.floor((cw - 12) / 2) : 0;
  // pad/pc 骨架轨道块数:铺满可视宽 +1(与横滚轨道「露两张半」视觉一致)
  const railCount = railCard > 0 ? Math.ceil(cw / (railCard + 16)) + 1 : 3;

  if (loading) {
    // 骨架也挂测量容器:与加载完成的 ScrollView 同一实测宽口径(pad 迷你轨
    // 72px 占宽时窗口宽≠容器宽,两套口径会让骨架与正式内容宽不一致)
    return (
      <View style={{ flex: 1, paddingTop: topInset }} onLayout={onLayout}>
        <BoardsSkeleton form={form} phoneCard={phoneCard} railCard={railCard} railCount={railCount} />
      </View>
    );
  }
  if (error) {
    return (
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: padH, paddingTop: 12 + topInset, paddingBottom: 12 + bottomInset }}
      >
        <ErrorState message={error} onRetry={retry} />
      </ScrollView>
    );
  }
  if (!sections || !sections.length) {
    return (
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: padH, paddingTop: 12 + topInset, paddingBottom: 12 + bottomInset }}
      >
        <EmptyState icon={Clapperboard} title="暂无内容" />
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      onLayout={onLayout}
      onScroll={onScroll}
      scrollEventThrottle={scrollEventThrottle}
      contentContainerStyle={{ paddingHorizontal: padH, paddingTop: 12 + topInset, paddingBottom: 12 + bottomInset, gap: 32 }} // space-y-8
    >
      {sections.map((sec) => (
        <BoardSection key={sec.id} site={site} sec={sec} railCard={railCard} phoneCard={phoneCard} railCount={railCount} />
      ))}
    </ScrollView>
  );
}
