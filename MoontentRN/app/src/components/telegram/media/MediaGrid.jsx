// ============================================================================
// MediaGrid.jsx —— 共享媒体面板·媒体 tab 三列方格(TI SharedMediaSection 观感)
// ----------------------------------------------------------------------------
// 数据面纯受控:入参 items = 归一化消息数组(id 降序,photo→media.photo.url
// /fullUrl,video→media.video.cover/duration/videoId);本组件只做:
//   · 月份分隔头:按 msg.date 本地时区分组(「YYYY 年 M 月」小节头,
//     TI shared media 分段口径);
//   · 三列方格(间距 2):photo 出中档图,video 出封面 + 右下时长角标
//     (黑底白字胶囊,MessageMedia 相册视频格同规格);非照片/视频的占位
//     条目出灰底图标格(点击跳聊天对应消息);
//   · 渲染行打平:月份头行 + 三格行(尾行不足三格补空位)作 FlashList
//     条目(FlashList 网格模式不支持跨列头行,打平行是唯一解);
//   · loading=true 出骨架方格;onEndReached 透传(offsetId 无限滚动由
//     use-media-feed 承载)。
// 点击分流(onOpenPhoto(msg)/onOpenVideo(videoId)/onOpenMessage(msgId))
// 全部回调注入,本组件不取数不感知路由。
// ============================================================================
import { memo, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { ABS_FILL } from '../../../lib/abs-fill.js';
import { fmtDur } from '../../../lib/utils.js';
import { usePalette, BADGE_BG } from '../../ui/palette.js';
import usePressVisual from '../../../lib/use-press-visual.js';
import Skeleton from '../../ui/Skeleton.jsx';
import { toDate } from '../chat-helpers.js';
import { Gallery, VideoFrame } from '../../icons.js';

const COLS = 3;  // 三列方格(任务口径)
const GAP = 2;   // 格间距(1-2 取 2,TI shared media 紧凑网格)

// —— 本地时区月份键:msg.date(ISO)→ 'YYYY-MM';解析失败回 ''(不插头) ——
function monthKeyOfMsg(m) {
  const d = toDate(m && m.date);
  if (!d) return '';
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
}

// 月份键 → 小节头文案('2026 年 10 月')
export function monthLabelOf(monthKey) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ''));
  if (!m) return String(monthKey || '');
  return Number(m[1]) + ' 年 ' + Number(m[2]) + ' 月';
}

// items → 渲染行描述符:{t:'head',key,label} | {t:'cells',key,cells:[msg|null×3]}
// 月份变化处插头;cells 恒补齐三槽(空位渲染透明占位,保持列宽一致)
export function buildGridRows(items) {
  const rows = [];
  let lastMonth = '';
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const cells = buf.slice(0, COLS);
    while (cells.length < COLS) cells.push(null);
    rows.push({ t: 'cells', key: 'cells-' + (buf[0] && buf[0].id) + '-' + buf.length, cells });
    buf = buf.slice(COLS);
    if (buf.length) flush(); // 递归排完积压(每组恰三格,最多一层)
  };
  for (const m of items || []) {
    if (!m || m.id == null) continue;
    const mk = monthKeyOfMsg(m);
    if (mk && mk !== lastMonth) {
      flush();
      rows.push({ t: 'head', key: 'head-' + mk, label: monthLabelOf(mk) });
      lastMonth = mk;
    }
    buf.push(m);
  }
  flush();
  return rows;
}

// —— 单格:photo 图 / video 封面+时长角标 / 占位图标格 ——
function MediaCell({ msg, onOpenPhoto, onOpenVideo, onOpenMessage }) {
  const p = usePalette();
  const hv = usePressVisual();
  const [bad, setBad] = useState(false);
  const media = msg && msg.media;
  const kind = media && media.kind;
  let img = '';
  let dur = '';
  if (kind === 'photo') {
    img = (media.photo && (media.photo.url || media.photo.fullUrl)) || '';
  } else if (kind === 'video') {
    img = (media.video && media.video.cover) || '';
    dur = fmtDur(media.video && media.video.duration);
  }
  const Icon = kind === 'video' ? VideoFrame : Gallery;
  const press = () => {
    if (kind === 'photo') onOpenPhoto(msg);
    else if (kind === 'video' && media.video) onOpenVideo(media.video.videoId);
    else onOpenMessage(msg.id); // 占位/未知条目:跳聊天对应消息
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        kind === 'photo' ? '查看图片'
          : kind === 'video' ? '播放视频' + (dur ? ',时长 ' + dur : '')
            : '在聊天中查看'
      }
      onPress={press}
      {...hv.binds}
      style={[
        { flex: 1, aspectRatio: 1, borderRadius: 4, overflow: 'hidden', backgroundColor: p.surface2 },
        { opacity: hv.pressed ? 0.85 : 1 },
      ]}
    >
      {img && !bad ? (
        <Image
          source={{ uri: img }}
          style={ABS_FILL}
          contentFit="cover"
          transition={200}
          recyclingKey={String(img)}
          onError={() => setBad(true)}
        />
      ) : (
        <View style={[ABS_FILL, { alignItems: 'center', justifyContent: 'center' }]}>
          <Icon size={22} color={p.muted} />
        </View>
      )}
      {/* 右下时长角标:黑底白字胶囊(相册视频格同规格) */}
      {kind === 'video' && dur ? (
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

// —— 三格行(空位透明占位保持列宽) ——
function CellsRow({ cells, onOpenPhoto, onOpenVideo, onOpenMessage }) {
  return (
    <View style={{ flexDirection: 'row', gap: GAP, marginBottom: GAP }}>
      {cells.map((m, i) =>
        m ? (
          <MediaCell
            key={'c' + m.id + '_' + i}
            msg={m}
            onOpenPhoto={onOpenPhoto}
            onOpenVideo={onOpenVideo}
            onOpenMessage={onOpenMessage}
          />
        ) : (
          <View key={'e' + i} style={{ flex: 1, aspectRatio: 1 }} />
        )
      )}
    </View>
  );
}

// —— 月份小节头 ——
function MonthHead({ label }) {
  const p = usePalette();
  return (
    <View style={{ paddingVertical: 10, paddingBottom: 8 }}>
      <Text style={{ fontSize: 13, fontWeight: '600', color: p.foreground, includeFontPadding: false }}>
        {label}
      </Text>
    </View>
  );
}

function MediaGrid({ items, loading, onEndReached, onOpenPhoto, onOpenVideo, onOpenMessage, contentContainerStyle }) {
  const rows = useMemo(() => buildGridRows(items || []), [items]);

  // 首屏骨架:三列方格阵(无数据可回收,固定行阵即可)
  if (loading) {
    return (
      <View>
        {Array.from({ length: 4 }, (_, r) => (
          <View key={r} style={{ flexDirection: 'row', gap: GAP, marginBottom: GAP }}>
            {Array.from({ length: COLS }, (_, c) => (
              <Skeleton key={c} style={{ flex: 1, aspectRatio: 1, borderRadius: 4 }} />
            ))}
          </View>
        ))}
      </View>
    );
  }
  if (!items) return null;

  return (
    <FlashList
      data={rows}
      keyExtractor={(r) => (r ? r.key : 'x')}
      estimatedItemSize={150} // 格行(约容器 1/3 见方)与小节头混合,均值提示
      showsVerticalScrollIndicator={false}
      scrollEventThrottle={16} // FlashList v2 内部恒挂 onScroll,不传会被 RNW 逐滚动事件打提示
      onEndReached={onEndReached}
      onEndReachedThreshold={0.5}
      contentContainerStyle={contentContainerStyle}
      renderItem={({ item }) => {
        if (!item) return null;
        if (item.t === 'head') return <MonthHead label={item.label} />;
        return (
          <CellsRow
            cells={item.cells}
            onOpenPhoto={onOpenPhoto}
            onOpenVideo={onOpenVideo}
            onOpenMessage={onOpenMessage}
          />
        );
      }}
    />
  );
}

export default memo(MediaGrid);
