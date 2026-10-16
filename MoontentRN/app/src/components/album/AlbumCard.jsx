// 相册卡片（RN 三端移植，源：NextWeb AlbumCard.jsx）
// ----------------------------------------------------------------------------
// 方形网格形态：归一化 item = { id, title, cover, count, added? } →
// onPress(item) 由页面深链相册详情页。
// 方形裁切封面（Google Photos 相册网格同款，用户选定）+ 右下「N 张」黑底角标
// （复刻视频卡时长角标位与样式，距右下 4px）；标题两行与视频卡同规格
// （16px/500/行高 22、间距 12）。相册卡片无作者体系（契约 AlbumItem 无 author
// 字段），不渲染作者行；added 为可选发布时间（小字灰）。
// 契约 props：{ item, onPress }；props 只增不减。
import { memo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Gallery as ImageIcon } from '../icons.js';
import { usePalette } from '../ui/palette.js';
import usePressVisual from '../../lib/use-press-visual.js';
import { coverUrl, useDataSaver } from '../ui/cover.js';
import CornerBadge from '../ui/corner-badge.jsx';

function AlbumCard({ item, onPress }) {
  const p = usePalette();
  const hv = usePressVisual(); // 布局静态化 + 按压视觉态事件 state（安卓样式函数陷阱）
  const saver = useDataSaver();
  const [coverErr, setCoverErr] = useState(false);

  const a = item;
  if (!a || a.id == null) return null; // 脏数据防御：不渲染整卡
  const src = a.cover && !coverErr ? coverUrl(a.cover, saver) : null;

  return (
    <View style={{ minWidth: 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={a.title || '相册'}
        onPress={() => onPress && onPress(a)}
        {...hv.binds}
        style={[{ minWidth: 0 }, { opacity: hv.pressed ? 0.9 : 1 }]}
      >
        {/* 封面：方形裁切圆角（12px），占位底色 surface（无封面时 ImageIcon 兜底） */}
        <View
          style={{
            position: 'relative',
            aspectRatio: 1,
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
              recyclingKey={String(a.id)}
              onError={() => setCoverErr(true)}
            />
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <ImageIcon size={32} color={p.muted} opacity={0.4} />
            </View>
          )}
          {/* 右下角标：张数（与视频卡时长角标同规格，badge-shape 实测） */}
          {!!a.count ? (
            <View style={{ position: 'absolute', bottom: 4, right: 4, pointerEvents: 'none' }}>
              <CornerBadge text={a.count + '张'} />
            </View>
          ) : null}
        </View>
        {/* 标题两行（与封面同链，YouTube 网格：标题/封面一体可点） */}
        <Text numberOfLines={2} style={{ marginTop: 12, fontSize: 16, fontWeight: '500', lineHeight: 22, color: p.foreground }}>
          {a.title || '(无标题)'}
        </Text>
      </Pressable>
      {a.added ? (
        <Text style={{ marginTop: 2, fontSize: 12, color: p.muted }}>{a.added}</Text>
      ) : null}
    </View>
  );
}

// memo：相册网格父级重渲染时，props 未变的卡按浅比较跳过
export default memo(AlbumCard);
