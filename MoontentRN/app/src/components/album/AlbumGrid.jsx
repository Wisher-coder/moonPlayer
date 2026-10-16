// 相册网格（RN 三端移植，源：NextWeb AlbumGrid.jsx）
// ----------------------------------------------------------------------------
// 方卡网格：与 VideoGrid 同手法（容器实测宽 → 列数 → 卡宽），但方卡视觉密度
// 高，默认最小卡宽收窄到 208px（NextWeb auto-fill minmax(208px) 的 RN 等价）；
// 手机档固定 2 列（NextWeb grid-cols-2 移动端同形——相册不做单列大卡），
// 上限 8 列（1920 宽 auto-fill(208) 的自然列数）。列距 16 / 行距 32
// （NextWeb gap-x-4 gap-y-8 桌面档；手机 gap-3 gap-4 ≈ 12/16，RN 侧统一取
// 桌面档并按手机档收窄）。
// 长列表治理同 VideoGrid：FlashList 回收，**不挂 key={cols}**（换 key 整表重挂
// 清滚动；v2 支持列数原地重排）；loading > 0 时渲染 N 个骨架卡（方图 + 两行标题条）。
// 契约 props：{ items, onPress }；min/onEndReached 等为可选扩展，只增不减。
// onScroll/scrollEventThrottle 亦为可选透传（手机画幅壳层收放方向判定挂载口，
// 见 use-chrome-scroll）。
import {View} from 'react-native';
import useDimensions from '../../lib/use-dimensions.js';
import { FlashList } from '@shopify/flash-list';
import AlbumCard from './AlbumCard.jsx';
import Skeleton from '../ui/Skeleton.jsx';
import useGridColumns from '../../hooks/use-grid-columns.js';

// 方卡列数：容器宽 → clamp(2, floor((W+16)/(min+16)), 8)；手机小宽由下限 2 托底
export function albumColumnsFor(containerWidth, min = 208) {
  if (!(containerWidth > 0)) return 0;
  const n = Math.floor((containerWidth + 16) / (min + 16));
  return Math.max(2, Math.min(8, n));
}

// 方卡卡宽：容器宽 + 列数 → 单卡宽（列距 16 同视频网格）
export function albumCardWidthFor(containerWidth, cols) {
  if (!(containerWidth > 0) || !(cols > 0)) return 0;
  return (containerWidth - 16 * (cols - 1)) / cols;
}

// 骨架卡：方图 + 两行标题条（与新卡形态对齐）
function GridSkeleton({ width }) {
  return (
    <View style={{ width }}>
      <Skeleton style={{ aspectRatio: 1, borderRadius: 12 }} />
      <View style={{ marginTop: 12, gap: 8 }}>
        <Skeleton style={{ height: 14 }} />
        <Skeleton style={{ height: 12, width: '33%' }} />
      </View>
    </View>
  );
}

function keyOf(a, i) {
  return a && a.id != null ? String(a.id) : 'x_' + i;
}

export default function AlbumGrid({ items, onPress, loading = 0, min = 208, onEndReached, onEndReachedThreshold, onScroll, scrollEventThrottle = 16, ListHeaderComponent, ListEmptyComponent, contentContainerStyle }) {
  const { containerWidth, onLayout } = useGridColumns();
  const winWidth = useDimensions().width;
  const width = containerWidth || winWidth;
  const cols = albumColumnsFor(width, min) || albumColumnsFor(winWidth, min) || 2;
  const card = albumCardWidthFor(width, cols) || width / cols;
  const compact = width < 768; // 手机档：间距收窄（NextWeb 移动端 gap-3 gap-4）
  const gap = compact ? 12 : 16;
  const rowGap = compact ? 16 : 32;

  if (loading) {
    const n = typeof loading === 'number' ? loading : 10;
    return (
      <View onLayout={onLayout} style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: gap, rowGap }}>
        {Array.from({ length: n }, (_, i) => (
          <GridSkeleton key={i} width={card} />
        ))}
      </View>
    );
  }
  if (!items) return null; // 无数据引用：不渲染
  if (!items.length && !ListEmptyComponent) return null; // 空态默认由页面统一渲染；给了 ListEmptyComponent 则交给 FlashList 出空态

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
      ListEmptyComponent={ListEmptyComponent}
      estimatedItemSize={card + 100}
      renderItem={({ item, index }) => (
        <View
          style={{
            width: card,
            marginRight: index % cols !== cols - 1 ? gap : 0,
            marginBottom: rowGap,
          }}
        >
          <AlbumCard item={item} onPress={onPress} />
        </View>
      )}
    />
  );
}
