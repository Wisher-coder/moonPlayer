// ============================================================================
// ZoneGrid.jsx —— 专区卡网格（专题/量贩/合集三区共用，zones 模块）
// ----------------------------------------------------------------------------
// 逐条移植 NextWeb ZonesTab 的 GRID_CLS 网格（auto-fill/minmax(240px,1fr)）：
// 专区卡是「整包/合集」这层实体，密度自持（最小卡宽 240，比首页视频卡的列算法
// 更密一档），不跟 VideoGrid 的列数走；专区卡无作者行，行距收小一档。
// RN 侧列算法：
//   容器宽 < 640（手机档，对应 NextWeb grid-cols-1）→ 单列、行距 12（gap-y-3）；
//   容器宽 ≥ 640 → 列数 = clamp(1, floor((W+16)/(240+16)), 8)，列距 16、行距 32
//   （gap-x-4 / gap-y-8）。
// 长列表治理与 VideoGrid/AlbumGrid 同手法：FlashList 回收，**不挂 key={cols}**
// （换 key 整表重挂清滚动；v2 支持列数原地重排）；未测到容器宽（首帧）拿窗口宽估列。
// loading > 0 时渲染 N 个骨架卡（16:9 图 + 两行标题条，与 ZoneCard 同形态）。
// 契约 props：{ items, onPress }；onEndReached/onEndReachedThreshold/
// ListHeaderComponent/ListEmptyComponent/ListFooterComponent/contentContainerStyle
// 为可选透传，props 只增不减。onScroll/scrollEventThrottle 亦为可选透传
//（手机画幅壳层收放方向判定挂载口，见 use-chrome-scroll）。
// ============================================================================
import {View} from 'react-native';
import useDimensions from '../../lib/use-dimensions.js';
import { FlashList } from '@shopify/flash-list';
import { useCallback, useState } from 'react';
import ZoneCard from '../video/ZoneCard.jsx';
import Skeleton from '../ui/Skeleton.jsx';

// 专区卡最小卡宽（NextWeb zones 网格 auto-fill minmax(240px,1fr) 的下限值）
export const ZONE_MIN_CARD = 240;
// 手机档分界（NextWeb sm: 断点 640——之下恒单列）
export const ZONE_PHONE_MAX = 640;

// 专区卡列数：容器宽 → 列数（<640 恒 1 列；之上 auto-fill 同式，上限 8）
export function zoneColumnsFor(containerWidth) {
  if (!(containerWidth > 0)) return 0;
  if (containerWidth < ZONE_PHONE_MAX) return 1;
  const n = Math.floor((containerWidth + 16) / (ZONE_MIN_CARD + 16));
  return Math.max(1, Math.min(8, n));
}

// 专区卡卡宽：容器宽 + 列数 → 单卡宽（列距 16）。取整同 use-grid-columns
// cardWidthFor 口径:Yoga 像素栅格取整下小数卡宽会让 flexWrap 行尾卡溢出
// 换行、FlashList 定宽卡错位（iOS 393/375 类逻辑宽必出小数）
export function zoneCardWidthFor(containerWidth, cols) {
  if (!(containerWidth > 0) || !(cols > 0)) return 0;
  return Math.floor((containerWidth - 16 * (cols - 1)) / cols);
}

// 骨架卡：与卡形态对齐（16:9 封面 + 两行标题条）
function GridSkeleton({ width }) {
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

// 键提取：脏条目（无 id）按序号补键
function keyOf(z, i) {
  return z && z.id != null ? String(z.id) : 'x_' + i;
}

export default function ZoneGrid({
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
  // 容器实测宽（onLayout）；未测到（首帧）按窗口宽估列
  const [containerWidth, setWidth] = useState(0);
  const onLayout = useCallback((e) => {
    const w = e && e.nativeEvent && e.nativeEvent.layout ? e.nativeEvent.layout.width : 0;
    setWidth((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
  }, []);
  const winWidth = useDimensions().width;
  const width = containerWidth || winWidth;
  const cols = zoneColumnsFor(width) || 1;
  const card = zoneCardWidthFor(width, cols) || width / cols;
  // 行距：<640 单列档 12（gap-y-3），之上 32（gap-y-8）；列距恒 16
  const rowGap = width < ZONE_PHONE_MAX ? 12 : 32;

  // 骨架态（首屏加载中 / loading 显式给数）：flex-wrap 网格即可（无数据可回收）
  if (loading) {
    const n = typeof loading === 'number' ? loading : 10;
    return (
      <View onLayout={onLayout} style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap }}>
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
      estimatedItemSize={(card * 9) / 16 + 60} // 16:9 封面 + 两行标题估高（仅影响回收预注册）
      renderItem={({ item, index }) => (
        // 每卡外包一层：定宽 + 列距/行距由 margin 落地（FlashList 网格模式
        // 的 separator 布局行为随版本有差，margin 组合最稳——同 VideoGrid 手法）
        <View
          style={{
            width: card,
            marginRight: index % cols !== cols - 1 ? 16 : 0,
            marginBottom: rowGap,
          }}
        >
          <ZoneCard item={item} onPress={onPress} />
        </View>
      )}
    />
  );
}
