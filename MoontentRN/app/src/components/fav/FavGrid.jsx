// ============================================================================
// FavGrid.jsx —— 收藏页专用视频网格（VideoGrid 同款布局 + 管理多选槽位）
// ----------------------------------------------------------------------------
// 为什么不直接用 video/VideoGrid：共享 VideoGrid 的 renderItem 钉死渲染
// VideoCard（「props 只增不减」契约也未开放卡片包装槽），收藏页「管理」模式
// 需要在卡上叠多选勾选钮、卡下补跨站站名行，不动公共组件的前提下只能自建
// 网格。布局参数与 VideoGrid 逐像素一致（同一套 use-grid-columns 容器列算
// 法、列距 16 / 行距 36|16 两档、卡宽经外层 View 的 width/margin 落地、
// FlashList 回收），普通态观感与首页/板块网格无差；差异仅三点：
//   · key 用 "site:id"（收藏清单跨站混排，两站 id 撞号不串台——与 mine.js
//     历史卡 site_id 复合键同款考量）；
//   · selecting=true 时每卡封面左上叠 32px 勾选圆钮（形态对齐 mine.js 历史
//     管理态的删除圆钮：半透明黑底白图形；选中态反白勾），卡身点按切换选中
//     而非进观看页；
//   · 卡下站名行走 HistoryCard 网格档规格（14px muted，上距 2），跨站混排
//     时保留来源站信息（站名由页面经 siteNameOf 解析注入，解析不到退显原始
//     site id，HistoryCard 同口径）。
// loading > 0 渲染骨架网格（与 VideoGrid 骨架同形态：16:9 图 + 标题两行条）。
// 契约 props：{ items, onPress }（onPress(item) 进观看页，管理态不触发）；
// selecting / selected(Set<"site:id">) / onToggle(item) 为管理态扩展；
// onEndReached / onEndReachedThreshold / onScroll / scrollEventThrottle /
// ListHeaderComponent / ListFooterComponent / ListEmptyComponent /
// contentContainerStyle 为可选透传（对齐 VideoGrid 的透传口径）。
// ============================================================================
import { memo } from 'react';
import { Text, View } from 'react-native';
import useDimensions from '../../lib/use-dimensions.js';
import { FlashList } from '@shopify/flash-list';
import VideoCard from '../video/VideoCard.jsx';
import Skeleton from '../ui/Skeleton.jsx';
import { Check } from '../icons.js';
import { usePalette } from '../ui/palette.js';
import useGridColumns, { columnsFor, cardWidthFor } from '../../hooks/use-grid-columns.js';

// 骨架卡：与 VideoGrid 骨架同形态（16:9 图 + 标题两行条）
function GridSkeleton({ width }) {
  return (
    <View style={{ width }}>
      <Skeleton style={{ aspectRatio: 16 / 9, borderRadius: 12 }} />
      <View style={{ marginTop: 12, gap: 8 }}>
        <Skeleton style={{ height: 14 }} />
        <Skeleton style={{ height: 12, width: '33%' }} />
      </View>
    </View>
  );
}

// key 提取：site:id 复合键；脏条目（无 site/id）按序号补键，不炸列表
function keyOf(v, i) {
  return v && v.site != null && v.id != null
    ? String(v.site) + ':' + String(v.id)
    : 'x_' + i;
}

// 多选勾选圆钮：32px 圆形叠在封面左上（对齐 mine.js 管理态圆钮规格）；
// 未选中 = 半透明黑底 + 白空心圈，选中 = 主题 accent 底 + 白勾（YouTube
// 「稍后观看」多选蓝勾语义）。pointerEvents=none：点按穿透到卡身 Pressable
function SelectBadge({ selected }) {
  const p = usePalette();
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 8,
        top: 8,
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: selected ? p.accent : 'rgba(0,0,0,0.55)',
      }}
    >
      {selected ? (
        <Check size={16} color="rgba(255,255,255,0.95)" />
      ) : (
        <View
          style={{
            width: 14,
            height: 14,
            borderRadius: 7,
            borderWidth: 1.5,
            borderColor: 'rgba(255,255,255,0.9)',
          }}
        />
      )}
    </View>
  );
}

// 收藏卡：VideoCard 卡身 + 管理态勾选钮 + 站名行。memo 化——selected 是页面
// 预算好的布尔值，选中态翻转只重渲染受影响的那张卡
const FavCard = memo(function FavCard({ item, selecting, selected, onPress, onToggle, siteName }) {
  const p = usePalette();
  if (!item || item.id == null) return null; // 脏数据防御：不渲染整卡
  return (
    <View style={{ minWidth: 0 }}>
      {/* 封面+标题链由 VideoCard 自带（含按压反馈/悬浮预览）；管理态点按改走
          onToggle（切选中），普通态照常 onPress（进观看页） */}
      <View style={{ position: 'relative' }}>
        <VideoCard item={item} onPress={selecting ? onToggle : onPress} />
        {selecting ? <SelectBadge selected={!!selected} /> : null}
      </View>
      {/* 站名行：HistoryCard 网格档规格（14/20，上距 2）；跨站混排的来源信息 */}
      {siteName ? (
        <Text
          numberOfLines={1}
          style={{ marginTop: 2, fontSize: 14, lineHeight: 20, color: p.muted, includeFontPadding: false }}
        >
          {siteName}
        </Text>
      ) : null}
    </View>
  );
});

export default function FavGrid({
  items,
  onPress,
  selecting = false,
  selected,
  onToggle,
  siteNameOf,
  loading = 0,
  onEndReached,
  onEndReachedThreshold,
  onScroll,
  scrollEventThrottle = 16, // 默认 16:FlashList v2 内部恒挂 onScroll,缺 throttle 时 RNW 逐滚动事件打提示(iOS 亦为官方推荐值)
  ListHeaderComponent,
  ListFooterComponent,
  ListEmptyComponent,
  contentContainerStyle,
}) {
  const { columns, containerWidth, onLayout } = useGridColumns();
  const winWidth = useDimensions().width;
  // 实测列优先；未测到（首帧）按窗口宽估列（与 VideoGrid 同款口径）
  const width = containerWidth || winWidth;
  const cols = columns || columnsFor(winWidth) || 1;
  const card = cardWidthFor(width, cols) || width / cols;
  // 行距：≥768（md+）36 / 手机紧凑档 16（VideoGrid 同款）
  const rowGap = width >= 768 ? 36 : 16;
  const selSet = selected instanceof Set ? selected : null;

  // 骨架态（首屏加载中）：普通 flex-wrap 网格即可（无数据可回收）
  if (loading) {
    const n = typeof loading === 'number' ? loading : 10;
    return (
      <View
        onLayout={onLayout}
        style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap }}
      >
        {Array.from({ length: n }, (_, i) => (
          <GridSkeleton key={i} width={card} />
        ))}
      </View>
    );
  }
  if (!items) return null; // 无数据引用：不渲染
  if (!items.length && !ListEmptyComponent) return null; // 空态默认由页面统一渲染

  return (
    <FlashList
      data={items}
      numColumns={cols}
      onLayout={onLayout}
      keyExtractor={keyOf}
      showsVerticalScrollIndicator={false}
      onEndReached={onEndReached}
      onEndReachedThreshold={onEndReachedThreshold == null ? 0.5 : onEndReachedThreshold}
      onScroll={onScroll}
      scrollEventThrottle={scrollEventThrottle}
      contentContainerStyle={contentContainerStyle}
      ListHeaderComponent={ListHeaderComponent}
      ListFooterComponent={ListFooterComponent}
      ListEmptyComponent={ListEmptyComponent}
      estimatedItemSize={Math.floor((card * 9) / 16) + 130} // 16:9 缩略 + 标题区 + 站名行估高（仅影响回收预注册）
      renderItem={({ item, index }) => {
        const key = item && item.site != null && item.id != null
          ? String(item.site) + ':' + String(item.id)
          : 'x_' + index;
        return (
          // 每卡外包一层：定宽（卡宽 = 容器/列数 - 列距）+ 列距/行距由 margin
          // 落地（FlashList 网格模式的 separator 布局行为随版本有差，margin
          // 组合最稳——VideoGrid 同款手法）
          <View
            style={{
              width: card,
              marginRight: index % cols !== cols - 1 ? 16 : 0,
              marginBottom: rowGap,
            }}
          >
            <FavCard
              item={item}
              selecting={selecting}
              selected={!!(selSet && selSet.has(key))}
              onPress={onPress}
              onToggle={onToggle}
              siteName={siteNameOf ? siteNameOf(item && item.site) : ''}
            />
          </View>
        );
      }}
    />
  );
}
