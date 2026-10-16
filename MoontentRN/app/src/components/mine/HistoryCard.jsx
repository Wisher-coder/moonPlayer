// ============================================================================
// HistoryCard.jsx —— 观看历史卡（「我的」页辅助件，RN 三端移植）
// ----------------------------------------------------------------------------
// 源：NextWeb/src/components/mine/HistoryCard.jsx（1:1 交互语义）。
// 封面卡两栖同卡——手机画幅横滚架（176px 定宽，缩略图 16:9 圆角 12 + 标题
// 14/500 两行 + 站名 12px）；平板/PC 网格里撑满列宽（父级给 width），字号/
// 间距切网格卡规格（标题 16/500/行高 22、标题与缩略图间距 12、站名 14px）
// = YouTube 网格卡实测值。两栖经 grid 布尔 prop 显式切换（RN 无 CSS 断点
// 变体，画幅判定由页面 use-form 承担）。
// 跨站条目深链 /video/{site}/{id}（onOpen 上抛，页面负责路由）；managing 态
// 在封面右上出删除圆钮（32px 触面）拦住卡身点按，仅删本条记录。
// 封面：expo-image 双缓冲淡入（transition 200，FadeImg 语义）+ 省流档收窄
// 320 宽（ui/cover.js 统一口径）；时长角标 12px 时钟图标规格（badge-shape），
// 距缩略图右下各 4px（NextWeb 历史卡 bottom-1 right-1 实测档）。
// 足迹条目自带 site（两站 id 撞号也不串台）；站名从站点上下文解析（解析
// 不到退显原始 site id）。悬浮预览 = 全局浮层（HoverPreviewLayer.web）：卡侧
// 挂 use-hover-preview（条目自带 site 显式传入，NextWeb 同款）——Pressable 挂
// onHoverIn/onHoverOut 上报 store，缩略图 View 挂 elRef 供浮层锚定（web only）。
import { memo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Clock, VideoFrame, Close } from '../icons.js';
import { fmtDur } from '../../lib/utils.js';
import { useSite } from '../../lib/site-context.jsx';
import { FSM_DENSE, FSM_META } from '../../lib/text-fit.js';
import { usePalette } from '../ui/palette.js';
import { coverUrl, useDataSaver } from '../ui/cover.js';
import CornerBadge from '../ui/corner-badge.jsx';
import { useHoverPreview } from '../../hooks/use-hover-preview.js';

// 手机横滚架定宽：NextWeb w-44（176px）
export const HISTORY_CARD_W = 176;

function HistoryCard({ v, grid = false, width, managing = false, onOpen, onRemove, style }) {
  const p = usePalette();
  const saver = useDataSaver(); // 省流档：封面收窄 320 宽（代理 w 档）
  const { sites } = useSite(); // 站名解析：条目自带 site，跨站足迹也显示正确站名
  // 悬浮预览上报：历史条目自带 site 显式传入（web only，native no-op）
  const preview = useHoverPreview(v && v.site, v);
  const [coverErr, setCoverErr] = useState(false); // 封面失败 → VideoFrame 占位，不出破图
  // 按压透明度反馈的事件 state（全仓约定：Pressable 样式零函数化——安卓端样式
  // 函数携带的样式不生效，见 lib/use-press-visual.js 头注；本链另有悬浮预览的
  // onHoverIn/Out 要挂，不整体展开 binds）
  const [pressed, setPressed] = useState(false);

  if (!v || v.id == null) return null; // 脏数据防御
  const siteName = ((sites || []).find((s) => s && s.id === v.site) || {}).name || v.site;
  const dur = fmtDur(v.duration);
  const src = v.cover && !coverErr ? coverUrl(v.cover, saver) : null;
  const cardWidth = grid ? width : HISTORY_CARD_W;

  return (
    <View style={[{ width: cardWidth || undefined, minWidth: 0 }, !grid && { flexShrink: 0 }, style]}>
      {/* 卡身：整卡可点，深链观看页（site+id 随条目走） */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={v.title || '历史记录'}
        onHoverIn={preview.onHoverIn}
        onHoverOut={preview.onHoverOut}
        onPress={() => onOpen && onOpen(v)}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        style={[{ opacity: pressed ? 0.9 : 1 }]}
      >
        {/* 缩略图：16:9 圆角 12，占位底色 surface（无封面/失败时 VideoFrame 图标）；
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
              transition={200}
              recyclingKey={String(v.site) + '_' + String(v.id)}
              onError={() => setCoverErr(true)}
            />
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <VideoFrame size={32} color={p.muted} opacity={0.4} />
            </View>
          )}
          {/* 时长角标：黑底白字 + 12px 时钟图标（全站唯一规格），距右下 4px */}
          {dur ? (
            <View style={{ position: 'absolute', bottom: 4, right: 4, pointerEvents: 'none' }}>
              <CornerBadge text={dur} icon={Clock} />
            </View>
          ) : null}
        </View>
        {/* 标题两行：横滚卡 14/20，网格卡 16/22（YouTube 两档实测值）；
            includeFontPadding/maxFontSizeMultiplier 对齐三端文字盒（安卓专属坑，
            见 lib/text-fit.js 头注） */}
        <Text
          numberOfLines={2}
          maxFontSizeMultiplier={FSM_DENSE}
          style={{
            marginTop: grid ? 12 : 6,
            fontSize: grid ? 16 : 14,
            fontWeight: '500',
            lineHeight: grid ? 22 : 20,
            color: p.foreground,
            includeFontPadding: false,
          }}
        >
          {v.title || '(无标题)'}
        </Text>
        {/* 站名行：横滚卡 12px，网格卡 14px */}
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={FSM_META}
          style={{ marginTop: 2, fontSize: grid ? 14 : 12, lineHeight: grid ? 20 : 16, color: p.muted, includeFontPadding: false }}
        >
          {siteName}
        </Text>
      </Pressable>
      {/* 管理态删除钮：右上 32px 圆钮，叠在封面上拦住卡身点按，仅删本条；
          布局纯静态 + 按压底色走事件 state（安卓样式函数陷阱，见
          use-press-visual 头注） */}
      {managing ? (
        <DelButton v={v} onRemove={onRemove} />
      ) : null}
    </View>
  );
}

// 删除钮（拆出来挂自己的按压 state，不污染卡身 memo）
function DelButton({ v, onRemove }) {
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="删除该记录"
      hitSlop={4}
      onPress={() => onRemove && onRemove(v)}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[
        {
          position: 'absolute',
          right: 8,
          top: 8,
          width: 32,
          height: 32,
          borderRadius: 16,
          alignItems: 'center',
          justifyContent: 'center',
        },
        { backgroundColor: pressed ? 'rgba(0,0,0,0.85)' : 'rgba(0,0,0,0.7)' },
      ]}
    >
      <Close size={16} color="rgba(255,255,255,0.85)" />
    </Pressable>
  );
}

// memo：管理态切换 / 弹窗开合 / 主题切换等父级重渲染时，props 未变的历史卡
// 按浅比较跳过——长足迹列表（上限 50）不再全量 diff
export default memo(HistoryCard);
