// ============================================================================
// RelatedList.jsx —— 相关推荐列表（YouTube 侧栏形态，观看页右栏/正文下）
// ----------------------------------------------------------------------------
// 移植自 NextWeb/app/video/[site]/[id]/RelatedList.jsx（1:1 同口径）：
//   - 无标题头，直接 CompactCard(sm) 单列；
//   - 取数/重试全部由父页的 useInfiniteList 持有，本组件只做呈现、不碰数据；
//   - 无限滚动：RN 侧没有 IntersectionObserver 哨兵，由父级 ScrollView 的
//     onEndReached 直接调 list.loadMore()（hooks/use-infinite-list.js 契约）；
//   - 首屏骨架 6 张行卡；首屏失败整块错误态 + 手动重试（reload）；加载更多
//     失败保留列表续拉；空列表出空态。
// 契约 props：{ list, onPress, style? }——list 为父页 useInfiniteList 返回值
// 整体透传（{ items, loading, loadingMore, more, err, done, loadMore, reload }）；
// onPress(item) 为行卡点按（父页负责路由跳转）。
// 本文件另导出 ErrorState / EmptyState 两个小状态件（NextWeb 同名组件的 RN
// 版）：观看页三件套（本组件 / PackagePanel / 页面）共用，避免三份拷贝——
// ui/ 八原语契约里没有错误/空态件，此为观看页文件族内部共享件。
// ============================================================================
import { memo } from 'react';
import { Text, View } from 'react-native';
import { Inbox, Restart, Alert } from '../icons.js';
import CompactCard from './CompactCard.jsx';
import Skeleton from '../ui/Skeleton.jsx';
import Button from '../ui/Button.jsx';
import { usePalette } from '../ui/palette.js';

// 行卡骨架：形似 CompactCard(sm)——左 168px 缩略图 + 右两行半文案
function RowSkeleton() {
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <Skeleton style={{ width: 168, aspectRatio: 16 / 9, borderRadius: 8 }} />
      <View style={{ flex: 1, minWidth: 0, paddingVertical: 2 }}>
        <Skeleton style={{ height: 16 }} />
        <Skeleton style={{ height: 16, marginTop: 8, width: '66%' }} />
        <Skeleton style={{ height: 12, marginTop: 8, width: '33%' }} />
      </View>
    </View>
  );
}

// 错误态：警示图标 + 错误文案 + 可选重试按钮（NextWeb ErrorState 同形态）
// 供本组件 / PackagePanel / 观看页主体共用
export function ErrorState({ message, onRetry }) {
  const p = usePalette();
  return (
    <View style={{ paddingVertical: 48, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
      <Alert size={32} color="#f87171" opacity={0.8} />
      {message ? (
        <Text style={{ maxWidth: 420, color: p.muted, fontSize: 14, textAlign: 'center' }}>
          {message}
        </Text>
      ) : null}
      {onRetry ? (
        <Button variant="secondary" size="sm" onPress={onRetry} style={{ marginTop: 8, gap: 6 }}>
          <Restart size={14} color={p.foreground} />
          <Text style={{ color: p.foreground, fontSize: 12, fontWeight: '500' }}>重试</Text>
        </Button>
      ) : null}
    </View>
  );
}

// 空态：图标 + 标题 + 说明（NextWeb EmptyState 同形态）
export function EmptyState({ title = '暂无内容', desc }) {
  const p = usePalette();
  return (
    <View style={{ paddingVertical: 48, alignItems: 'center', justifyContent: 'center', gap: 6 }}>
      <Inbox size={40} color={p.muted} opacity={0.5} />
      <Text style={{ marginTop: 4, color: p.muted, fontSize: 14 }}>{title}</Text>
      {desc ? <Text style={{ color: p.muted, opacity: 0.7, fontSize: 12 }}>{desc}</Text> : null}
    </View>
  );
}

function RelatedList({ list, onPress, style }) {
  const p = usePalette();
  const l = list || {};
  const items = l.items;

  return (
    <View style={[{ gap: 8 }, style]}>
      {l.loading ? (
        // 首屏骨架：6 张形似新布局的行卡
        Array.from({ length: 6 }, (_, i) => <RowSkeleton key={i} />)
      ) : l.err && (!items || !items.length) ? (
        // 首屏失败：整块错误态 + 手动重试
        <ErrorState message={l.err} onRetry={l.reload} />
      ) : items && items.length ? (
        <>
          {items.map((v) => (
            <CompactCard key={String(v.id)} item={v} size="sm" onPress={onPress} />
          ))}
          {l.err ? (
            // 加载更多失败：列表保留，重试续拉
            <ErrorState message={l.err} onRetry={l.loadMore} />
          ) : l.done ? (
            <Text style={{ paddingVertical: 16, textAlign: 'center', fontSize: 12, color: p.muted, opacity: 0.6 }}>
              没有更多了
            </Text>
          ) : l.loadingMore ? (
            <Text style={{ paddingVertical: 12, textAlign: 'center', fontSize: 12, color: p.muted, opacity: 0.6 }}>
              正在加载…
            </Text>
          ) : null}
        </>
      ) : (
        <EmptyState title="暂无推荐" />
      )}
    </View>
  );
}

export default memo(RelatedList);
