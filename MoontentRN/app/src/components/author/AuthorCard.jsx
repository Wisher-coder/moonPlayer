// 女优卡片（RN 三端移植，源：NextWeb/src/components/author/AuthorCard.jsx）
// ----------------------------------------------------------------------------
// YouTube 频道目录形态：归一化 a = { id, name, avatar, verified, videoCount } →
// onPress(a) 由页面深链作者页（个人中心 /author/{site}/{id}）。圆形大头像 +
// 居中名称（单行截断，16px/500/行高 22、间距 12 = NextWeb pt-3 同档）+
// 「N 个视频」居中 meta 行（14px/行高 20 muted，videoCount > 0 才出，与作者页
// 头部口径一致）；verified 本站恒 false，目录卡不放验证勾（作者页头部有）。
// RN 适配点：Link → Pressable 契约 { item, onPress }（site 由页面闭包收口）；
// FadeImg → expo-image（recyclingKey 对位复用池）；头像 URL 过 coverUrl()
// （绝对化 + 省流档 320 宽，头像展示位比封面更小，收窄只会更省）；
// 无头像 / 加载失败渲染 surface2 占位圆（不造假图，与作者页头部占位同款）。
// 契约 props：{ item, onPress }；props 只增不减。
import { memo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { usePalette } from '../ui/palette.js';
import usePressVisual from '../../lib/use-press-visual.js';
import { coverUrl, useDataSaver } from '../ui/cover.js';

function AuthorCard({ item, onPress }) {
  const p = usePalette();
  const hv = usePressVisual(); // 布局静态化 + 按压视觉态事件 state（安卓样式函数陷阱）
  const saver = useDataSaver();
  const [avatarErr, setAvatarErr] = useState(false);

  const a = item;
  if (!a || a.id == null) return null; // 脏数据防御：不渲染整卡
  const src = a.avatar && !avatarErr ? coverUrl(a.avatar, saver) : null;

  return (
    <View style={{ minWidth: 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={a.name || '女优'}
        onPress={() => onPress && onPress(a)}
        {...hv.binds}
        style={[{ minWidth: 0 }, { opacity: hv.pressed ? 0.9 : 1 }]}
      >
        {/* 头像：圆形裁切，占位底色 surface2（规格 = YouTube 频道目录圆头像） */}
        <View
          style={{
            position: 'relative',
            aspectRatio: 1,
            borderRadius: 9999,
            overflow: 'hidden',
            backgroundColor: p.surface2,
          }}
        >
          {src ? (
            <Image
              source={{ uri: src }}
              style={{ width: '100%', height: '100%' }}
              contentFit="cover"
              transition={200}
              recyclingKey={String(a.id)}
              onError={() => setAvatarErr(true)}
            />
          ) : null}
        </View>
        {/* 名称：单行截断居中（NextWeb truncate 同规格；空名兜底「(未知女优)」） */}
        <Text
          numberOfLines={1}
          style={{ marginTop: 12, textAlign: 'center', fontSize: 16, fontWeight: '500', lineHeight: 22, color: p.foreground }}
        >
          {a.name || '(未知女优)'}
        </Text>
        {/* meta：「N 个视频」（YouTube lockup 元信息行同档，>0 才渲染） */}
        {a.videoCount > 0 ? (
          <Text numberOfLines={1} style={{ marginTop: 2, textAlign: 'center', fontSize: 14, lineHeight: 20, color: p.muted }}>
            {a.videoCount} 个视频
          </Text>
        ) : null}
      </Pressable>
    </View>
  );
}

// memo：网格父级重渲染时，props 未变的卡按浅比较跳过（与 AlbumCard 同手法）
export default memo(AuthorCard);
