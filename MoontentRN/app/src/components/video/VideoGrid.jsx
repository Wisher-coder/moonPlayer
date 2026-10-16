// 视频网格（RN 三端移植，源：NextWeb VideoGrid.jsx）
// ----------------------------------------------------------------------------
// YouTube 桌面版富网格口径——列数由容器实测宽度算出（use-grid-columns：三档
// 最小卡宽 420/320/285 + 上限 6 列），卡宽 = 容器宽/列数 - 16 自动落地；列距恒
// 16px；行距 36px（容器 ≥768 即 md+ 档，手机保持 16 的紧凑档）；手机单列
// （m.youtube 形态，算法在 <586 宽天然收敛到 1 列）。
// 长列表治理：NextWeb 用 content-visibility + memo，RN 侧换 FlashList 回收
// （虚拟化窗口外的卡整个卸载，等效跳过渲染）。**不挂 key={cols}**：换 key 是
// 整表卸载重挂，滚动清零；FlashList v2 的 GridLayoutManager 支持列数原地重排
// （updateLayoutParams 按 maxColumns 重算全部布局），resize 只重排不清位。
// 未测到容器宽度前（首帧）拿窗口宽估列数——比渲染骨架少一跳；onLayout 到位
// 后修正（web 上 PC 首帧估列与实测列可能差一列，与 YouTube 首屏列数跳动同观感）。
// loading > 0 时渲染 N 个骨架卡（16:9 缩略图 + 两行文字条，与 VideoCard 同形态）。
// rankCount > 0 时给前 N 张卡传榜单编号。
// 契约 props：{ items, onPress }；onEndReached/onEndReachedThreshold/
// ListHeaderComponent/ListFooterComponent/ListEmptyComponent/
// contentContainerStyle 为可选透传，props 只增不减。onScroll/
// scrollEventThrottle 亦为可选透传（手机画幅壳层收放方向判定挂载口，
// 见 use-chrome-scroll）。
import {View} from 'react-native';
import useDimensions from '../../lib/use-dimensions.js';
import { FlashList } from '@shopify/flash-list';
import VideoCard from './VideoCard.jsx';
import Skeleton from '../ui/Skeleton.jsx';
import useGridColumns, { columnsFor, cardWidthFor } from '../../hooks/use-grid-columns.js';

// 骨架卡：与新卡形态对齐（16:9 图 + 标题两行条；作者行不占位——新卡无 author
// 字段时不渲染头像/名称）
function GridSkeleton({ width, rowGap }) {
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

// key 提取：脏条目（无 id）按序号补键，不炸列表
function keyOf(v, i) {
  return v && v.id != null ? String(v.id) : 'x_' + i;
}

export default function VideoGrid({
  items,
  onPress,
  rankCount = 0,
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
  // 实测列优先；未测到（首帧）按窗口宽估列（PC 上窗口宽于容器会略偏多，修正即收敛）
  const width = containerWidth || winWidth;
  const cols = columns || columnsFor(winWidth) || 1;
  const card = cardWidthFor(width, cols) || width / cols;
  // 行距：≥768（md+）走 YouTube --ytd-rich-grid-row-margin 实测 36，手机紧凑档 16
  const rowGap = width >= 768 ? 36 : 16;

  // 骨架态（首屏加载中 / loading 显式给数）：普通 flex-wrap 网格即可（无数据可回收）
  if (loading) {
    const n = typeof loading === 'number' ? loading : 10;
    return (
      <View
        onLayout={onLayout}
        style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap }}
      >
        {Array.from({ length: n }, (_, i) => (
          <GridSkeleton key={i} width={card} rowGap={rowGap} />
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
      ListFooterComponent={ListFooterComponent}
      ListEmptyComponent={ListEmptyComponent}
      estimatedItemSize={(card * 9) / 16 + 100} // 16:9 缩略 + 标题区估高（仅影响回收预注册）
      renderItem={({ item, index }) => (
        // 每卡外包一层：定宽（卡宽 = 容器/列数 - 列距）+ 列距/行距由 margin 落地
        //（FlashList 网格模式的 separator 布局行为随版本有差，margin 组合最稳）
        <View
          style={{
            width: card,
            marginRight: index % cols !== cols - 1 ? 16 : 0,
            marginBottom: rowGap,
          }}
        >
          <VideoCard
            item={item}
            onPress={onPress}
            rank={rankCount > 0 && index < rankCount ? index + 1 : undefined}
          />
        </View>
      )}
    />
  );
}
