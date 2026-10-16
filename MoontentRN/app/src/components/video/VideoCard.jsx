// 视频卡片（YouTube 网格卡形态，RN 三端移植，源：NextWeb VideoCard.jsx）
// ----------------------------------------------------------------------------
// 归一化 item = { id, title, cover, duration, hd, author? } → onPress(item)
// 由页面负责深链导航（expo-router），卡身只管展示与上报。
// 卡身规格（YouTube lockup 实测值）：
//   - 16:9 圆角封面（网格 12px 圆角），expo-image 双缓冲淡入（transition 200，
//     替代 NextWeb FadeImg），省流档封面收窄 320 宽（经 ui/cover.js）；
//   - 右下黑底时长角标（12px 时钟图标规格，badge-shape 实测）+ HD 并排其左，
//     无时长时 HD 顶替右下主位；角标距缩略图右下各 8px；
//   - 标题两行：16px/500/行高 22，与缩略图间距 12；
//   - 可选作者行：仅条目带 author 字段（avjb 等有真实作者体系的站点输出）时
//     渲染（头像 36 圆 + 名 14px、间距 8），无此字段不渲染任何头像/名称占位——
//     不为无作者站点造假频道行。
// 网格卡不做 hover 抬升/缩放（YouTube 仅侧栏与首页大卡有动画，网格静止）；
// 悬浮预览 = 全局浮层（HoverPreviewLayer.web，AppShell 挂载）：卡侧只挂
// use-hover-preview 钩子——Pressable 挂 onHoverIn/onHoverOut 上报 store，
// 缩略图 View 挂 elRef 供浮层锚定（web 端 View ref 直达 DOM div）。
// 契约 props：{ item, onPress }；rank（榜单编号角标）/onAuthor（作者行独立
// 点击）为可选扩展，只增不减。
import { memo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Clock, VideoFrame, StarSolid } from '../icons.js';
import { fmtDur } from '../../lib/utils.js';
import { usePalette, BADGE_BG } from '../ui/palette.js';
import { FSM_DENSE } from '../../lib/text-fit.js';
import usePressVisual from '../../lib/use-press-visual.js';
import { coverUrl, useDataSaver } from '../ui/cover.js';
import CornerBadge from '../ui/corner-badge.jsx';
import { useHoverPreview } from '../../hooks/use-hover-preview.js';
import { useFavKeys } from '../../lib/fav-store.js';
import { splitEpId } from '../../lib/history.js';

function VideoCard({ item, onPress, rank, onAuthor }) {
  const p = usePalette();
  const saver = useDataSaver(); // 省流档：封面收窄 320 宽（代理 w 档）
  // 悬浮预览上报（site 传 null → 钩子内回退站点上下文；web only，native no-op）
  const preview = useHoverPreview(null, item);
  // 已收藏角标：卡片内部订阅收藏清单（勿把整份 keys 塞进每卡 prop——网格里
  // 24+ 卡每卡一份 prop 数组会让父级 memo 失效），keys 变更时全部卡同步亮/灭
  const favKeys = useFavKeys();
  const [coverErr, setCoverErr] = useState(false); // 封面加载失败 → VideoFrame 占位，不出破图
  // 按压透明度反馈的事件 state（全仓约定：Pressable 样式零函数化——安卓端样式
  // 函数携带的样式不生效，见 lib/use-press-visual.js 头注；本链另有悬浮预览的
  // onHoverIn/Out 要挂，不整体展开 binds）
  const [pressed, setPressed] = useState(false);

  const v = item;
  if (!v || v.id == null) return null; // 脏数据防御：不渲染整卡
  // 收藏比对 id：条目 id 形如 vid-epN（剧集片单/合集卡）先归一为裸 vid——一部
  // 剧任一集合被收藏，全集合卡片都亮星，与详情页星标同口径
  const favVid = (() => {
    const se = splitEpId(v.id);
    return String(se ? se.vid : v.id);
  })();
  // keys 形如 "site:id"：条目不带 site（列表卡恒属所在页面的站点），按 id 后缀
  // 比对；跨站同 id 撞号的小概率误亮可接受（静默角标，非可操作状态）
  const isFav = favKeys.some((k) => typeof k === 'string' && k.endsWith(':' + favVid));
  const dur = fmtDur(v.duration);
  const a = v.author && v.author.id != null ? v.author : null; // 仅真实 author 字段才渲染作者行
  const src = v.cover && !coverErr ? coverUrl(v.cover, saver) : null;

  return (
    <View style={{ minWidth: 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={v.title || '视频'}
        onHoverIn={preview.onHoverIn}
        onHoverOut={preview.onHoverOut}
        onPress={() => onPress && onPress(v)}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        style={[{ opacity: pressed ? 0.9 : 1 }]}
      >
        {/* 缩略图：16:9 圆角（12px），占位底色 surface（无封面/加载失败时 VideoFrame 图标）；
            ref 供悬浮预览锚定（web 端 View ref 直达 DOM div，浮层按它贴位/跟随滚动） */}
        <View
          ref={preview.elRef}
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
              transition={200} // 双缓冲淡入（NextWeb FadeImg 语义，expo-image 原生支持）
              recyclingKey={String(v.id)} // FlashList 回收复用时的换源键
              onError={() => setCoverErr(true)}
            />
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <VideoFrame size={32} color={p.muted} opacity={0.4} />
            </View>
          )}
          {/* 榜单编号：克制版半透明黑底白字（YouTube 无此物，弱化为可读即可） */}
          {rank >= 1 ? (
            <View
              style={{ pointerEvents: 'none',
              
                position: 'absolute',
                left: 4,
                top: 4,
                borderRadius: 4,
                backgroundColor: 'rgba(0,0,0,0.6)',
                paddingHorizontal: 6,
                paddingVertical: 2,
              }}
            >
              <Text style={{ color: '#ffffff', fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'], includeFontPadding: false }}>
                {rank}
              </Text>
            </View>
          ) : null}
          {/* 已收藏角标：右上小实心星（与右下时长/HD 角标错位、与左上榜单编号对
              角；20px 黑底方块与角标胶囊同高同圆角，白星 12px）；未收藏零渲染 */}
          {isFav ? (
            <View
              style={{
                pointerEvents: 'none',
                position: 'absolute',
                right: 4,
                top: 4,
                width: 20,
                height: 20,
                borderRadius: 4,
                backgroundColor: BADGE_BG,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <StarSolid size={12} color="#ffffff" />
            </View>
          ) : null}
          {/* 右下角标组：时长为主位（前置 12px 时钟图标），HD 并排其左；距右下各 8px */}
          {dur || v.hd ? (
            <View style={{ pointerEvents: 'none',  position: 'absolute', bottom: 8, right: 8, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              {!!v.hd ? <CornerBadge text="HD" /> : null}
              {dur ? <CornerBadge text={dur} icon={Clock} /> : null}
            </View>
          ) : null}
        </View>
        {/* 标题两行（与缩略图同链，YouTube 网格：标题/缩略图一体可点） */}
        <Text numberOfLines={2} maxFontSizeMultiplier={FSM_DENSE} style={{ marginTop: 12, fontSize: 16, fontWeight: '500', lineHeight: 22, color: p.foreground, includeFontPadding: false }}>
          {v.title || '(无标题)'}
        </Text>
      </Pressable>
      {/* 作者行：独立可点（与视频链分离）；无 author 字段时整行不渲染。
          规格 = YouTube lockup 元信息行实测：头像 36、间距 8、文字 14/行高 20，
          与标题间距 2。布局纯静态（安卓样式函数陷阱，见 use-press-visual 头注）。 */}
      {a ? (
        <AuthorRowLink a={a} onAuthor={onAuthor} onPress={onPress} v={v} />
      ) : null}
    </View>
  );
}

// 作者行点按链（拆出来才能挂自己的按压 state，不污染卡身 memo 比较）
function AuthorRowLink({ a, onAuthor, onPress, v }) {
  const p = usePalette();
  const hv = usePressVisual();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={'作者 ' + (a.name || '')}
      onPress={() => (onAuthor ? onAuthor(v) : onPress && onPress(v))}
      {...hv.binds}
      style={[
        { marginTop: 2, flexDirection: 'row', alignItems: 'center', gap: 8 },
        { opacity: hv.pressed ? 0.85 : 1 },
      ]}
    >
      {a.avatar ? (
        <Image
          source={{ uri: coverUrl(a.avatar, true) }} // 头像恒取 320 档：展示 36px，一档到底最省
          style={{ width: 36, height: 36, borderRadius: 18 }}
          contentFit="cover"
          transition={200}
        />
      ) : (
        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: p.surface2 }} />
      )}
      <Text numberOfLines={1} maxFontSizeMultiplier={FSM_DENSE} style={{ flex: 1, fontSize: 14, lineHeight: 20, color: p.muted, includeFontPadding: false }}>
        {a.name || ''}
      </Text>
    </Pressable>
  );
}

// memo：列表页/无限滚动等网格父级重渲染时，props（item/onPress/rank）未变的
// 卡片按浅比较直接跳过重渲染——一屏 24+ 卡的网格里，父级一次状态更新不再全量 diff
export default memo(VideoCard);
