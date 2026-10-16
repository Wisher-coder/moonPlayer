// ============================================================================
// MessageMedia.jsx —— Telegram 消息媒体分发渲染（气泡内媒体卡总入口）
// ----------------------------------------------------------------------------
// 数据契约（归一化消息对象的 media 子对象，按 kind 分发）：
//   photo     { w, h, url(中档), fullUrl(全档) }——单图按 w/h 适配气泡宽
//             （上限约 280，见 chat-helpers.fitPhotoBox），点击开全屏看图器；
//   video     { videoId, cover, duration, w, h, size, round }——封面 + 时长
//             角标 + 播放图标，点击 onOpenVideo(videoId)；round=true 圆形
//             视频按小圆窗渲染（同点击口径）；
//   document  { name, size, mime, thumb }——文件卡（图标/预览 + 文件名 +
//             人类可读大小），纯展示；
//   sticker   { emoji, animated, url, w, h }——无气泡底图（MessageBubble 侧
//             判 bare），animated 也只静态展示（本期不做动画贴纸）；
//   voice     { duration, size, mime }——语音卡，点击轻提示「暂不支持播放」；
//   audio     { duration, size, mime, name, performer }——音频卡（多名字/演唱者）；
//   webpage   { url, title, description, siteName, photo }——网页预览卡，
//             点击 Linking.openURL；
//   poll      → PollCard（透传 onVote）；
//   geo       { lat, long, title?, address? }——位置简卡；
//   contact   { name, phone }——联系人简卡；
//   unsupported { note }——UnsupportedPill 胶囊（TI UnsupportedContentPill
//   等价，几何常量逐字；未知 kind 同走此兜底）。
// 相册：页面把相邻同 groupedId 的消息合成一条传入——album 属性给全体媒体
//   成员 tiles：图片 { kind:'photo', w, h, url, fullUrl } / 视频
//   { kind:'video', videoId, cover, duration, w, h }（≥2 时出 2 列混合
//   网格，head 自身的单媒体卡不再单独渲染，head 是视频也一样）；点击图片
//   格开看图器（photos 只收图片成员，起始下标按图片子集内序号，可左右
//   翻页），点击视频格 onOpenVideo(videoId) 进观看页。
// 全屏看图直接复用 components/album/PhotoViewer.jsx（渐进加载/双击缩放/胶片
// 条全都有，不重写）：photos=[{url: fullUrl, thumb: url}]。
// 媒体地址链路：url/fullUrl/cover/thumb 全是页面 normalizeDeep 归一后的
//   /api/img/telegram 代理地址（tg.local 令牌在 hook 层已换代理），视频走
//   videoId 直通观看页——本组件不做任何二次地址加工。
// 交互：interactive=false（多选/菜单态）时媒体整体 pointerEvents none——
//   点按穿透到气泡层做选择切换，看图器/播放不抢触（TI selection 态同语义）。
// 下载态机不移植（蓝图二 §1.2 裁定）：媒体经代理地址按需加载，无客户端
//   下载进度事件面；角标只保留时长/播放等视觉件。
// 纯展示组件：视频跳转/投票/轻提示全部回调注入，组件不发请求不感知路由。
// ============================================================================
import { memo, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import PhotoViewer from '../album/PhotoViewer.jsx';
import { usePalette, BADGE_BG } from '../ui/palette.js';
import usePressVisual from '../../lib/use-press-visual.js';
import { fmtDur } from '../../lib/utils.js';
import {
  File, Gallery, Location, Mic, MusicNote, Play, Sticker as StickerIcon, User, VideoFrame,
} from '../icons.js';
import { useHint } from './HintPill.jsx';
import { toneColors, fitPhotoBox, fmtBytes, ALBUM_CELL, BUBBLE_MEDIA_MAX_W } from './chat-helpers/index.js';
import PollCard from './PollCard.jsx';
import UnsupportedPill from './UnsupportedPill.jsx';
import { FSM_DENSE, FSM_META } from '../../lib/text-fit.js';

// —— 图片加载失败/缺 URL 的占位格（表面底 + 图标，保持原占位尺寸不跳版式）——
function ImgFallback({ width, height, radius = 8, Icon = Gallery }) {
  const p = usePalette();
  return (
    <View
      style={{
        width,
        height,
        borderRadius: radius,
        backgroundColor: p.surface2,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon size={Math.min(28, Math.round(width / 3))} color={p.muted} />
    </View>
  );
}

// —— 单图：按 w/h 适配（上限 280×340），点击开看图器 ——
// 两段式加载（example MessagePhoto 语义）：miniThumb（base64 dataURL，
// tdlib 引擎加性字段，mtproto 路径恒缺省）先出模糊占位（blur 12）→ 中档
// url 就绪替换 → onLoad 后台升级 fullUrl 全档（渐显）。URL 均为页面
// normalizeDeep 归一后的代理地址，本组件不再加工。
function MediaPhoto({ photo, onOpen, aLabel }) {
  const hv = usePressVisual();
  const [bad, setBad] = useState(false);
  const [hiRes, setHiRes] = useState(false); // url 加载完成后升级 fullUrl
  const ph = photo || {};
  const box = fitPhotoBox(ph.w, ph.h, BUBBLE_MEDIA_MAX_W, 340);
  const mini = ph.miniThumb && typeof ph.miniThumb === 'string' && ph.miniThumb.startsWith('data:') ? ph.miniThumb : null;
  if ((!ph.url && !mini) || bad) return <ImgFallback width={box.width} height={box.height} />;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={aLabel || '查看图片'}
      onPress={onOpen}
      {...hv.binds}
      style={[{ borderRadius: 10, overflow: 'hidden' }, { opacity: hv.pressed ? 0.9 : 1 }]}
    >
      <Image
        source={{ uri: (hiRes && ph.fullUrl) || ph.url || mini }}
        placeholder={mini ? { uri: mini } : undefined}
        blurRadius={ph.url ? undefined : 12}
        style={{ width: box.width, height: box.height }}
        contentFit="cover"
        transition={200}
        recyclingKey={String(ph.url || mini)}
        onLoad={() => { if (ph.fullUrl && !hiRes) setHiRes(true); }}
        onError={() => setBad(true)}
      />
    </Pressable>
  );
}

// —— 相册网格：2 列方格（相邻同 groupedId 由页面合成 tiles 传入；图片与
//    视频混排——图片格开看图器，视频格 onOpenVideo(videoId) 进观看页）——
function AlbumGrid({ tiles, onOpenPhoto, onOpenVideo }) {
  let photoIdx = -1; // 图片子集内序号：看图器只收图片成员，起始下标按子集映射
  const cells = tiles.map((t, i) => {
    if (t && t.kind === 'video') {
      return <AlbumVideoCell key={'v' + (t.videoId != null ? t.videoId : i)} tile={t} onOpen={onOpenVideo} />;
    }
    photoIdx++;
    return <AlbumCell key={(t && (t.url || t.fullUrl)) || 'p' + i} photo={t} index={i} photoIndex={photoIdx} onOpen={onOpenPhoto} />;
  });
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 2, width: ALBUM_CELL * 2 + 2, borderRadius: 10, overflow: 'hidden' }}>
      {cells}
    </View>
  );
}

function AlbumCell({ photo, index, photoIndex, onOpen }) {
  const hv = usePressVisual();
  const [bad, setBad] = useState(false);
  const ph = photo || {};
  if (!ph.url || bad) {
    return (
      <View style={{ width: ALBUM_CELL, height: ALBUM_CELL }}>
        <ImgFallback width={ALBUM_CELL} height={ALBUM_CELL} radius={0} />
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={'查看相册第 ' + (index + 1) + ' 张'}
      onPress={() => onOpen(photoIndex)}
      {...hv.binds}
      style={[{ width: ALBUM_CELL, height: ALBUM_CELL }, { opacity: hv.pressed ? 0.9 : 1 }]}
    >
      <Image
        source={{ uri: ph.url }}
        style={{ width: '100%', height: '100%' }}
        contentFit="cover"
        transition={200}
        recyclingKey={'album-' + index}
        onError={() => setBad(true)}
      />
    </Pressable>
  );
}

// —— 相册视频格：封面 + 中央播放钮 + 右下时长角标（视觉同单视频卡 VideoCard
//    的封面语言，收进 ALBUM_CELL 方格；点击 onOpenVideo(videoId)）——
function AlbumVideoCell({ tile, onOpen }) {
  const hv = usePressVisual();
  const [bad, setBad] = useState(false);
  const v = tile || {};
  const dur = fmtDur(v.duration);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={'播放相册视频' + (dur ? '，时长 ' + dur : '')}
      onPress={() => onOpen && onOpen(v.videoId)}
      {...hv.binds}
      style={[{ width: ALBUM_CELL, height: ALBUM_CELL }, { opacity: hv.pressed ? 0.9 : 1 }]}
    >
      {v.cover && !bad ? (
        <Image
          source={{ uri: v.cover }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          transition={200}
          recyclingKey={String(v.cover)}
          onError={() => setBad(true)}
        />
      ) : (
        <ImgFallback width={ALBUM_CELL} height={ALBUM_CELL} radius={0} Icon={VideoFrame} />
      )}
      {/* 中央播放钮：黑底半透明圆 + 白色播放符（与单视频卡同语言） */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: BADGE_BG,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Play size={20} color="#ffffff" />
        </View>
      </View>
      {/* 右下时长角标：黑底白字胶囊（单视频卡同规格，本地实现以钉右下） */}
      {dur ? (
        <View
          pointerEvents="none"
          style={{ position: 'absolute', right: 4, bottom: 4, backgroundColor: BADGE_BG, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 }}
        >
          <Text style={{ color: '#ffffff', fontSize: 12, fontWeight: '500', lineHeight: 17, fontVariant: ['tabular-nums'], includeFontPadding: false }}>
            {dur}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

// —— 视频卡：封面 + 中央播放钮 + 右下时长角标；round=true 圆形小窗 ——
function VideoCard({ video, onOpen }) {
  const hv = usePressVisual();
  const [bad, setBad] = useState(false);
  const v = video || {};
  const round = !!v.round;
  const box = round
    ? { width: 180, height: 180, radius: 90 }
    : fitPhotoBox(v.w, v.h, BUBBLE_MEDIA_MAX_W, 340);
  const radius = round ? 90 : 10;
  const dur = fmtDur(v.duration);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={'播放视频' + (dur ? '，时长 ' + dur : '')}
      disabled={!onOpen}
      onPress={() => onOpen && onOpen(v.videoId)}
      {...hv.binds}
      style={[{ borderRadius: radius, overflow: 'hidden' }, { opacity: hv.pressed ? 0.9 : 1 }]}
    >
      <View style={{ width: box.width, height: box.height, borderRadius: radius, overflow: 'hidden' }}>
        {v.cover && !bad ? (
          <Image
            source={{ uri: v.cover }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            transition={200}
            recyclingKey={String(v.cover)}
            onError={() => setBad(true)}
          />
        ) : (
          <ImgFallback width={box.width} height={box.height} radius={0} Icon={VideoFrame} />
        )}
        {/* 中央播放钮：黑底半透明圆 + 白色播放符（与全站视频封面占位同语言） */}
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <View
            style={{
              width: round ? 44 : 48,
              height: round ? 44 : 48,
              borderRadius: round ? 22 : 24,
              backgroundColor: BADGE_BG,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Play size={round ? 20 : 22} color="#ffffff" />
          </View>
        </View>
        {/* 右下时长角标：黑底白字胶囊（corner-badge 同规格，本地实现以钉右下） */}
        {dur ? (
          <View
            pointerEvents="none"
            style={{ position: 'absolute', right: 6, bottom: 6, backgroundColor: BADGE_BG, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 }}
          >
            <Text style={{ color: '#ffffff', fontSize: 12, fontWeight: '500', lineHeight: 17, fontVariant: ['tabular-nums'], includeFontPadding: false }}>
              {dur}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

// —— 文件卡：缩略图(有则)/文件图标 + 文件名 + 大小(mime)，纯展示不提供下载 ——
function DocumentCard({ doc, tc }) {
  const [bad, setBad] = useState(false);
  const d = doc || {};
  const meta = [fmtBytes(d.size), d.mime].filter((x) => !!x).join(' · ');
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 10, backgroundColor: tc.card, padding: 10, maxWidth: BUBBLE_MEDIA_MAX_W }}>
      {/* 左槽：文档缩略图（文件预览）优先，无图/失败退文件图标 */}
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 8,
          backgroundColor: tc.track,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {d.thumb && !bad ? (
          <Image
            source={{ uri: d.thumb }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            transition={200}
            recyclingKey={String(d.thumb)}
            onError={() => setBad(true)}
          />
        ) : (
          <File size={22} color={tc.dim} />
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={2} maxFontSizeMultiplier={FSM_DENSE} style={{ fontSize: 13, lineHeight: 18, fontWeight: '500', color: tc.fg, includeFontPadding: false }}>
          {d.name || '未命名文件'}
        </Text>
        {meta ? (
          <Text maxFontSizeMultiplier={FSM_META} style={{ marginTop: 2, fontSize: 11, color: tc.dim, opacity: tc.dimOpacity, includeFontPadding: false }}>
            {meta}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

// —— 贴纸：无气泡底图直接展示；animated 只静态首帧（本期不做动画）——
function StickerView({ sticker }) {
  const p = usePalette();
  const [bad, setBad] = useState(false);
  const s = sticker || {};
  const box = fitPhotoBox(s.w, s.h, 160, 160, 120);
  if (s.url && !bad) {
    return (
      <Image
        source={{ uri: s.url }}
        style={{ width: box.width, height: box.height }}
        contentFit="contain"
        transition={200}
        recyclingKey={String(s.url)}
        onError={() => setBad(true)}
        accessibilityLabel="贴纸"
      />
    );
  }
  // 无图（或加载失败）：emoji 大字优先，其次贴纸图标占位
  return (
    <View
      style={{
        width: box.width,
        height: box.height,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 12,
        backgroundColor: p.surface2,
      }}
    >
      {s.emoji ? (
        <Text style={{ fontSize: 40 }}>{s.emoji}</Text>
      ) : (
        <StickerIcon size={40} color={p.muted} />
      )}
    </View>
  );
}

// —— 语音/音频卡：图标 + 时长 + 大小（本期不做播放，点击轻提示）——
function VoiceCard({ data, kind, tc, onHint }) {
  const p = usePalette();
  const hv = usePressVisual();
  const { show, overlay } = useHint(onHint);
  const isAudio = kind === 'audio';
  const meta = [fmtDur(data && data.duration), fmtBytes(data && data.size)].filter((x) => !!x).join(' · ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={(isAudio ? '音频' : '语音') + '消息' + (meta ? '，' + meta : '') + '，暂不支持播放'}
      onPress={() => show('暂不支持播放')}
      {...hv.binds}
      style={[
        {
          position: 'relative',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          borderRadius: 10,
          backgroundColor: tc.card,
          paddingHorizontal: 12,
          height: 44,
          minWidth: 180,
        },
        { opacity: hv.pressed ? 0.85 : 1 },
      ]}
    >
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 14,
          // 图标槽底：出站用 tc.track（气泡底上的中性透明叠层，亮暗双档自适应），
          // 入站用 background 微对比
          backgroundColor: tc.out ? tc.track : p.background,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {isAudio ? <MusicNote size={15} color={tc.fg} /> : <Mic size={15} color={tc.fg} />}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        {isAudio && (data.name || data.performer) ? (
          <Text numberOfLines={1} maxFontSizeMultiplier={FSM_DENSE} style={{ fontSize: 13, fontWeight: '500', color: tc.fg, includeFontPadding: false }}>
            {[data.name, data.performer].filter(Boolean).join(' - ')}
          </Text>
        ) : null}
        <Text maxFontSizeMultiplier={FSM_META} style={{ fontSize: 11, color: tc.dim, opacity: tc.dimOpacity, includeFontPadding: false }}>
          {isAudio ? '音频' : '语音'}{meta ? ' · ' + meta : ''} · 点击播放（暂不支持）
        </Text>
      </View>
      {overlay}
    </Pressable>
  );
}

// —— 网页预览卡：可选头图 + 站名/标题/描述，整卡点击走 onUrl 分流（页面
//    openUrl：t.me 深链应用内承接，其余外开）；未注入退 Linking.openURL ——
function WebpageCard({ page, tc, onHint, onUrl }) {
  const p = usePalette();
  const hv = usePressVisual();
  const [bad, setBad] = useState(false);
  const { show, overlay } = useHint(onHint);
  const g = page || {};
  const open = () => {
    if (!g.url) return;
    if (typeof onUrl === 'function') { onUrl(g.url, 'url'); return; }
    Linking.openURL(g.url).catch(() => show('无法打开链接'));
  };
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={'打开网页预览：' + (g.title || g.url || '')}
      disabled={!g.url}
      onPress={open}
      {...hv.binds}
      style={[
        {
          position: 'relative',
          borderRadius: 10,
          backgroundColor: tc.card,
          overflow: 'hidden',
          maxWidth: BUBBLE_MEDIA_MAX_W,
        },
        { opacity: hv.pressed ? 0.9 : 1 },
      ]}
    >
      {g.photo && !bad ? (
        <Image
          source={{ uri: g.photo }}
          style={{ width: '100%', height: 140 }}
          contentFit="cover"
          transition={200}
          recyclingKey={String(g.photo)}
          onError={() => setBad(true)}
        />
      ) : null}
      <View style={{ padding: 10, gap: 4 }}>
        {g.siteName ? (
          <Text numberOfLines={1} maxFontSizeMultiplier={FSM_META} style={{ fontSize: 11, color: tc.dim, opacity: tc.dimOpacity, includeFontPadding: false }}>
            {g.siteName}
          </Text>
        ) : null}
        {g.title ? (
          <Text numberOfLines={2} maxFontSizeMultiplier={FSM_DENSE} style={{ fontSize: 14, fontWeight: '500', lineHeight: 19, color: tc.fg, includeFontPadding: false }}>
            {g.title}
          </Text>
        ) : null}
        {g.description ? (
          <Text numberOfLines={3} maxFontSizeMultiplier={FSM_META} style={{ fontSize: 12, lineHeight: 17, color: tc.dim, opacity: tc.dimOpacity, includeFontPadding: false }}>
            {g.description}
          </Text>
        ) : null}
        {g.url ? (
          <Text numberOfLines={1} maxFontSizeMultiplier={FSM_META} style={{ fontSize: 11, color: tc.out ? tc.fg : p.link, textDecorationLine: tc.out ? 'underline' : 'none', opacity: 0.9, includeFontPadding: false }}>
            {g.url}
          </Text>
        ) : null}
      </View>
      {overlay}
    </Pressable>
  );
}

// —— 位置简卡：图标 + 标题/地址（无则坐标），纯展示 ——
function GeoCard({ geo, tc }) {
  const g = geo || {};
  const line = g.title || g.address
    ? [g.title, g.address].filter(Boolean).join(' · ')
    : (Number.isFinite(Number(g.lat)) && Number.isFinite(Number(g.long)) ? Number(g.lat).toFixed(5) + ', ' + Number(g.long).toFixed(5) : '位置消息');
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 10, backgroundColor: tc.card, paddingHorizontal: 12, height: 44, minWidth: 180 }}>
      <Location size={18} color={tc.dim} />
      <Text numberOfLines={1} maxFontSizeMultiplier={FSM_DENSE} style={{ flex: 1, minWidth: 0, fontSize: 13, color: tc.fg, includeFontPadding: false }}>
        {line}
      </Text>
    </View>
  );
}

// —— 联系人简卡：首字头像 + 姓名 + 电话，纯展示 ——
function ContactCard({ contact, tc }) {
  const p = usePalette();
  const c = contact || {};
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 10, backgroundColor: tc.card, paddingHorizontal: 12, height: 52, minWidth: 200 }}>
      <View
        style={{
          width: 34,
          height: 34,
          borderRadius: 17,
          backgroundColor: tc.track,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ fontSize: 15, fontWeight: '600', color: tc.fg, includeFontPadding: false }}>
          {(c.name || '?').charAt(0).toUpperCase()}
        </Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} maxFontSizeMultiplier={FSM_DENSE} style={{ fontSize: 13, fontWeight: '500', color: tc.fg, includeFontPadding: false }}>
          {c.name || '联系人'}
        </Text>
        {c.phone ? (
          <Text numberOfLines={1} maxFontSizeMultiplier={FSM_META} style={{ fontSize: 11, color: tc.dim, opacity: tc.dimOpacity, includeFontPadding: false }}>
            {c.phone}
          </Text>
        ) : null}
      </View>
      <User size={16} color={p.muted} />
    </View>
  );
}

// ============================================================================
// 总入口：kind 分发
// ============================================================================
function MessageMedia({ media, album, tone = 'in', onOpenVideo, onVote, onHint, onUrl, interactive = true, viewerTitle = '', style }) {
  const p = usePalette();
  const tc = toneColors(p, tone);
  // 看图器开态：null 关闭，number=起始下标（相册=全体，单图=0）
  const [viewerIndex, setViewerIndex] = useState(null);

  if (!media || !media.kind) return null;

  // 看图器数据：相册只收图片成员（视频格走 onOpenVideo 进观看页，不进图片
  // 查看器；起始下标由网格按图片子集内序号传入），单图给一张；thumb=气泡内中档图
  const albumList = Array.isArray(album) && album.length > 1 ? album : null;
  const viewerPhotos = albumList
    ? albumList
        .filter((x) => x && x.kind === 'photo')
        .map((x) => ({ url: x.fullUrl || x.url || '', thumb: x.url || '' }))
    : [{ url: (media.photo && (media.photo.fullUrl || media.photo.url)) || '', thumb: (media.photo && media.photo.url) || '' }];

  let body = null;
  switch (media.kind) {
    case 'photo':
    case 'video': {
      // 混合相册（≥2 媒体成员，图片/视频混排）：网格承载全体成员，head
      // 自身的单媒体卡不再单独渲染（否则与网格重复，head 是视频也一样）；
      // 单图/单视频路径保持原样
      if (albumList) {
        body = <AlbumGrid tiles={albumList} onOpenPhoto={setViewerIndex} onOpenVideo={onOpenVideo} />;
        break;
      }
      if (media.kind === 'photo') {
        body = <MediaPhoto photo={media.photo || {}} onOpen={() => setViewerIndex(0)} aLabel="查看图片" />;
      } else {
        body = <VideoCard video={media.video} onOpen={onOpenVideo} />;
      }
      break;
    }
    case 'document':
      body = <DocumentCard doc={media.document} tc={tc} />;
      break;
    case 'sticker':
      body = <StickerView sticker={media.sticker} />;
      break;
    case 'voice':
      body = <VoiceCard data={media.voice} kind="voice" tc={tc} onHint={onHint} />;
      break;
    case 'audio':
      body = <VoiceCard data={media.audio} kind="audio" tc={tc} onHint={onHint} />;
      break;
    case 'webpage':
      body = <WebpageCard page={media.webpage} tc={tc} onHint={onHint} onUrl={onUrl} />;
      break;
    case 'poll':
      body = <PollCard poll={media.poll} tone={tone} onVote={onVote} style={{ minWidth: 0, maxWidth: BUBBLE_MEDIA_MAX_W }} />;
      break;
    case 'geo':
      body = <GeoCard geo={media.geo} tc={tc} />;
      break;
    case 'contact':
      body = <ContactCard contact={media.contact} tc={tc} />;
      break;
    default:
      // unsupported 及未知 kind：UnsupportedPill 胶囊（TI UnsupportedContentPill
      // 等价，替换旧灰字占位；note=服务端降级说明，如「暂不支持的媒体类型(xxx)」）
      body = <UnsupportedPill note={(media.unsupported && media.unsupported.note) || ''} onHint={onHint} />;
  }

  return (
    <View
      style={[{ position: 'relative', alignSelf: 'flex-start' }, style]}
      // 多选/菜单态：媒体不抢触（点按穿透到气泡层做选择切换；看图器/播放
      // 同步冻结，TI selection 态同语义）
      pointerEvents={interactive ? 'auto' : 'none'}
    >
      {body}
      {/* 全屏看图器：复用 album/PhotoViewer（渐进加载/缩放/胶片条全套） */}
      {viewerIndex != null && viewerPhotos.length > 0 ? (
        <PhotoViewer
          photos={viewerPhotos}
          index={viewerIndex}
          onIndexChange={setViewerIndex}
          onClose={() => setViewerIndex(null)}
          title={viewerTitle}
        />
      ) : null}
    </View>
  );
}

export default memo(MessageMedia);
