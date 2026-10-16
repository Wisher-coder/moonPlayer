// 女优网格（RN 三端移植，源：NextWeb/src/components/author/AuthorGrid.jsx）
// ----------------------------------------------------------------------------
// 圆形头像 lockup 网格（YouTube 频道目录形态）：与 AlbumGrid 同手法（容器实测
// 宽 → 列数 → 卡宽），但圆头像密度更高——最小卡宽收窄到 144px（NextWeb
// auto-fill minmax(144px,1fr) 的 RN 等价），手机档恒 4 列（NextWeb grid-cols-4
// 移动端同形，sm: 640 断点之下）；上限 12 列（1920 宽 auto-fill(144) 的自然
// 列数，取值思路同 AlbumGrid 的「上限 = 1920 自然列数」）。列距/行距照
// NextWeb 两档：<640 为 gap-x-3 gap-y-5（12/20），之上 gap-x-4 gap-y-8（16/32）。
// 长列表治理同 AlbumGrid/ZoneGrid：FlashList 回收，**不挂 key={cols}**（换 key
// 整表重挂清滚动；v2 支持列数原地重排）；loading > 0 时渲染 N 个骨架卡（圆 +
// 居中两行名称条，NextWeb GridSkeleton 同形态）。
// 契约 props：{ items, onPress }；onEndReached/onEndReachedThreshold/
// ListHeaderComponent/ListFooterComponent/ListEmptyComponent/contentContainerStyle
// 为可选透传，props 只增不减。onScroll/scrollEventThrottle 亦为可选透传
//（手机画幅壳层收放方向判定挂载口，见 use-chrome-scroll）。
import { View } from 'react-native';
import useDimensions from '../../lib/use-dimensions.js';
import { FlashList } from '@shopify/flash-list';
import AuthorCard from './AuthorCard.jsx';
import Skeleton from '../ui/Skeleton.jsx';
import useGridColumns from '../../hooks/use-grid-columns.js';

// 圆头像最小卡宽（NextWeb --au-min 默认 144 的等价值）
export const AUTHOR_MIN_CARD = 144;
// 手机档分界（NextWeb sm: 断点 640——之下恒 4 列 grid-cols-4）
export const AUTHOR_PHONE_MAX = 640;
// 列数上限（1920 宽 auto-fill(144) 的自然列数，同 AlbumGrid 上限取值思路）
export const AUTHOR_MAX_COLS = 12;

// 圆头像列数：容器宽 → 列数（<640 恒 4 列；之上 auto-fill 同式，clamp(4,·,12)，
// 下限 4 托底窄桌面窗，恰与 640 档 auto-fill 值衔接不跳变）
export function authorColumnsFor(containerWidth, min = AUTHOR_MIN_CARD) {
  if (!(containerWidth > 0)) return 0;
  if (containerWidth < AUTHOR_PHONE_MAX) return 4;
  const n = Math.floor((containerWidth + 16) / (min + 16));
  return Math.max(4, Math.min(AUTHOR_MAX_COLS, n));
}

// 圆头像卡宽：容器宽 + 列数 + 列距 → 单卡宽（RN 无 1fr，显式宽落地）
export function authorCardWidthFor(containerWidth, cols, gap) {
  if (!(containerWidth > 0) || !(cols > 0)) return 0;
  return (containerWidth - gap * (cols - 1)) / cols;
}

// 骨架卡：圆 + 居中两行名称条（NextWeb GridSkeleton：圆 w-full + h-3.5 w-2/3
// + h-3 w-1/3，pt-3 / space-y-2 的 RN 等价）
function GridSkeleton({ width }) {
  return (
    <View style={{ width }}>
      <Skeleton style={{ aspectRatio: 1, borderRadius: 9999 }} />
      <View style={{ marginTop: 12, gap: 8, alignItems: 'center' }}>
        <Skeleton style={{ height: 14, width: '66%' }} />
        <Skeleton style={{ height: 12, width: '33%' }} />
      </View>
    </View>
  );
}

// 键提取：脏条目（无 id）按序号补键（与 AlbumGrid/ZoneGrid 同式）
function keyOf(a, i) {
  return a && a.id != null ? String(a.id) : 'x_' + i;
}

export default function AuthorGrid({
  items,
  onPress,
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
  // 容器实测宽（use-grid-columns 的 onLayout）；未测到（首帧）按窗口宽估列
  const { containerWidth, onLayout } = useGridColumns();
  const winWidth = useDimensions().width;
  const width = containerWidth || winWidth;
  const compact = width < AUTHOR_PHONE_MAX; // 手机档：间距收窄（NextWeb 移动端 gap-3/gap-y-5）
  const gap = compact ? 12 : 16;
  const rowGap = compact ? 20 : 32;
  const cols = authorColumnsFor(width) || 4;
  const card = authorCardWidthFor(width, cols, gap) || width / cols;

  // 骨架态（首屏加载中 / loading 显式给数）：flex-wrap 网格即可（无数据可回收）
  if (loading) {
    const n = typeof loading === 'number' ? loading : 12;
    return (
      <View onLayout={onLayout} style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: gap, rowGap }}>
        {Array.from({ length: n }, (_, i) => (
          <GridSkeleton key={i} width={card} />
        ))}
      </View>
    );
  }
  if (!items) return null; // 无数据引用：不渲染
  if (!items.length && !ListEmptyComponent) return null; // 空态默认由页面统一渲染；给了空态组件则交给 FlashList

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
      estimatedItemSize={card + 60} // 圆头像 + 名称行 + meta 行估高（仅影响回收预注册）
      renderItem={({ item, index }) => (
        // 每卡外包一层：定宽 + 列距/行距由 margin 落地（FlashList 网格模式的
        // separator 布局行为随版本有差，margin 组合最稳——同 AlbumGrid 手法）
        <View
          style={{
            width: card,
            marginRight: index % cols !== cols - 1 ? gap : 0,
            marginBottom: rowGap,
          }}
        >
          <AuthorCard item={item} onPress={onPress} />
        </View>
      )}
    />
  );
}
