// 专区卡（RN 三端移植，源：NextWeb ZoneCard.jsx）
// ----------------------------------------------------------------------------
// 专题/量贩/合集三区通用（YouTube 网格卡的计数卡变体）：归一化
// item = { id, title, cover, count } → onPress(item) 由页面按区种给定深链
// （专题进列表模式、量贩/合集进整包片单页）。
// 计数角标走视频卡时长角标同规格（右下半透明黑底白字「N 部」，行卡档距右下
// 4px）；count=0（专题上游无视频数字段）不显角标。无封面回退 VideoFrame 图标占位
// （同 VideoCard）；网格卡不做 hover 动画（与 VideoCard 一致）。
// 契约 props：{ item, onPress }；props 只增不减。
import { memo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { VideoFrame } from '../icons.js';
import { usePalette } from '../ui/palette.js';
import usePressVisual from '../../lib/use-press-visual.js';
import { coverUrl, useDataSaver } from '../ui/cover.js';
import CornerBadge from '../ui/corner-badge.jsx';

function ZoneCard({ item, onPress }) {
  const p = usePalette();
  const hv = usePressVisual(); // 布局静态化 + 按压视觉态事件 state（安卓样式函数陷阱）
  const saver = useDataSaver();
  const [coverErr, setCoverErr] = useState(false);

  const z = item;
  if (!z || z.id == null) return null; // 脏数据防御：不渲染整卡
  const src = z.cover && !coverErr ? coverUrl(z.cover, saver) : null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={z.title || '专区'}
      onPress={() => onPress && onPress(z)}
      {...hv.binds}
      style={[{ minWidth: 0 }, { opacity: hv.pressed ? 0.9 : 1 }]}
    >
      {/* 封面：16:9 圆角（12px），占位底色 surface（与视频卡同形） */}
      <View
        style={{
          position: 'relative',
          aspectRatio: 16 / 9,
          borderRadius: 12,
          overflow: 'hidden',
          backgroundColor: p.surface,
        }}
      >
        {src ? (
          <Image
            source={{ uri: src }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            transition={200}
            recyclingKey={String(z.id)}
            onError={() => setCoverErr(true)}
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <VideoFrame size={32} color={p.muted} opacity={0.4} />
          </View>
        )}
        {z.count > 0 ? (
          <View style={{ pointerEvents: 'none',  position: 'absolute', bottom: 4, right: 4 }}>
            <CornerBadge text={z.count + ' 部'} />
          </View>
        ) : null}
      </View>
      {/* 标题两行（与视频卡同规格：16px/500/行高 22，与封面间距 12） */}
      <Text numberOfLines={2} style={{ marginTop: 12, fontSize: 16, fontWeight: '500', lineHeight: 22, color: p.foreground }}>
        {z.title || '(无标题)'}
      </Text>
    </Pressable>
  );
}

// memo：三区网格父级重渲染时，props 未变的卡按浅比较跳过
export default memo(ZoneCard);
