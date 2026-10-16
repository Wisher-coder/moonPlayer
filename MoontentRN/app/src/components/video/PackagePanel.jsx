// ============================================================================
// PackagePanel.jsx —— 选集面板（YouTube 播放列表队列形态，量贩/合集/剧集共用）
// ----------------------------------------------------------------------------
// 移植自 NextWeb/app/video/[site]/[id]/PackagePanel.jsx（1:1 同口径），插在
// 观看页右栏顶部、相关推荐之上（手机单列画幅则在正文信息之下）：
//   - tag 区种标记（「量贩」/「合集」/「剧集」——资源站多集片），数据/重试
//     全部由父页持有（同 RelatedList 惯例，本组件只做呈现）；pkg=null 且非
//     加载/错误态时整块不渲染（视频不在该类包内=无面板）；
//   - 头部 = 区种标记 + 包名 + 当前序号/总数 + 折叠指示图标（默认展开，折叠
//     只剩头部；整条头部可点按收起/展开，不只右侧图标钮）；行 = 序号列（当前项换 ▶ 正在播放标记，品牌红——accent 的
//     「进度/在播」语义位）+ 168px 16:9 缩略图（右下全站统一时长角标，同
//     CompactCard sm 规格）+ 两行截断标题；整行链到 /video/{site}/{id}；
//   - 播放量/点赞等社交字段契约红线不输出，序号/时长即全部事实，不造假；
//   - 【队列高度】包可达 32 部，整包平铺会把「猜你喜欢」顶到很远之外——
//     故按 YouTube 队列的做法限高（约 5 行）+ 面板内滚动，并在挂载/切集/
//     展开时把在播项滚到面板中部（只动面板自身的滚动偏移，不触碰页面滚动）；
//     RN 侧行位置经每行 onLayout 记入坐标表，在播行换位后按坐标定位；
//   - 同包/同合集切集不重拉不回骨架（父页按 pkgId/合集签名持有数据，本组件
//     只随 currentId 挪在播标记——面板自身完全无请求逻辑）。
// 契约 props：{ site, pkg, currentId, loading, err, onRetry, style?, tag?,
//              fallbackTitle? }——pkg 为 { id, title, description, count,
// items:[VideoItem] } | null；tag 缺省「量贩」；fallbackTitle 为 pkg 未就绪时
// 的包名兜底（合集面板由 detail.gathers 先行携带名称时传入）。
// ============================================================================
import {memo, useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View} from 'react-native';
import useDimensions from '../../lib/use-dimensions.js';
import { useOpenVideo } from '../../lib/open-video.js';
import { Image } from 'expo-image';
import { ChevronDown, ChevronUp, VideoFrame, Play } from '../icons.js';
import Skeleton from '../ui/Skeleton.jsx';
import CornerBadge from '../ui/corner-badge.jsx';
import { usePalette } from '../ui/palette.js';
import { coverUrl, useDataSaver } from '../ui/cover.js';
import { fmtDur } from '../../lib/utils.js';
import { FSM_DENSE, FSM_META } from '../../lib/text-fit.js';
import usePressVisual from '../../lib/use-press-visual.js';
import { ErrorState } from './RelatedList.jsx';

const THUMB_W = 168; // 行卡缩略图宽（与 CompactCard sm 同规格，16:9 高约 94）

// 面板行：v 为归一化 VideoItem；current=本行是当前播放片（高亮 + ▶ 代序号）；
// onLayout 上报行坐标（面板把在播行滚到中部用）
function PackageRow({ v, site, index, current, saver, onPress, onLayout }) {
  const p = usePalette();
  const dur = fmtDur(v.duration);
  const [coverErr, setCoverErr] = useState(false);
  const src = v.cover && !coverErr ? coverUrl(v.cover, saver) : null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={(v.title || '(无标题)') + (current ? '（正在播放）' : '')}
      onLayout={onLayout}
      onPress={() => onPress(v)}
      style={{
        position: 'relative',
        flexDirection: 'row',
        minWidth: 0,
        alignItems: 'center',
        gap: 8,
        borderRadius: 10,
        paddingHorizontal: 8,
        paddingVertical: 6,
        backgroundColor: current ? p.foreground + '1a' : 'transparent',
      }}
    >
      {/* 当前项左缘高亮竖条（品牌红 = 在播位，与播放器进度红同语义） */}
      {current ? (
        <View
          style={{ pointerEvents: 'none',
          
            position: 'absolute',
            left: 0,
            top: 4,
            bottom: 4,
            width: 2,
            borderRadius: 2,
            backgroundColor: p.accent,
          }}
        />
      ) : null}
      {/* 序号列：当前项换 ▶（YouTube 选集队列「正在播放」标记）；宽度容两位序号 */}
      <View style={{ width: 24, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}>
        {current ? (
          <Play size={12} color={p.accent} fill={p.accent} />
        ) : (
          <Text maxFontSizeMultiplier={FSM_META} style={{ fontSize: 12, color: p.muted, fontVariant: ['tabular-nums'], includeFontPadding: false }}>
            {index}
          </Text>
        )}
      </View>
      {/* 缩略图 + 时长角标（与 CompactCard sm 同规格；行卡距右下 4px） */}
      <View
        style={{
          position: 'relative',
          width: THUMB_W,
          aspectRatio: 16 / 9,
          flexShrink: 0,
          borderRadius: 8,
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
            recyclingKey={String(v.id)}
            onError={() => setCoverErr(true)}
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <VideoFrame size={24} color={p.muted} opacity={0.4} />
          </View>
        )}
        {dur ? (
          <View style={{ pointerEvents: 'none',  position: 'absolute', bottom: 4, right: 4 }}>
            <CornerBadge text={dur} />
          </View>
        ) : null}
      </View>
      {/* 标题：在播项不换色（YouTube 也在播项保持主文字色，状态由行底色+▶承载） */}
      <Text
        numberOfLines={2}
        maxFontSizeMultiplier={FSM_DENSE}
        style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: '500', lineHeight: 20, color: p.foreground, includeFontPadding: false }}
      >
        {v.title || '(无标题)'}
      </Text>
    </Pressable>
  );
}

function PackagePanel({ site, pkg, currentId, loading, err, onRetry, style, tag = '量贩', fallbackTitle }) {
  const p = usePalette();
  const saver = useDataSaver();
  const { height: vh } = useDimensions();
  const [open, setOpen] = useState(true);
  // 头部整行点按的视觉态（布局纯静态——安卓样式函数陷阱，见 use-press-visual 头注）
  const hv = usePressVisual();

  const boxRef = useRef(null);      // 队列滚动容器
  const boxHRef = useRef(0);        // 队列可视高度（onLayout 记录）
  const rowsRef = useRef({});       // 行坐标表：index → { y, h }（挂载时逐行记录）
  const lastSigRef = useRef('');    // 已滚过的签名（pkgId|currentId|open），防重复抢滚

  const pkgId = pkg ? pkg.id : null;

  // 在播项滚到队列中部：挂载/切包/切集/展开时执行一次，之后用户自己滚不抢；
  // 只改面板自身滚动偏移（scrollTo），不触碰页面与右栏滚动
  const tryCenter = useCallback(
    (curIdx) => {
      const box = boxRef.current;
      if (!box || !open || boxHRef.current <= 0) return;
      const pos = rowsRef.current[curIdx];
      if (!pos || pos.y <= 0) return; // 在播行尚未布局
      const sig = String(pkgId) + '|' + String(currentId) + '|' + (open ? 1 : 0);
      if (lastSigRef.current === sig) return;
      lastSigRef.current = sig;
      // 行顶 − 半个可视高度（补偿行高）即把该行摆到面板中部
      const target = pos.y - (boxHRef.current - pos.h) / 2;
      box.scrollTo({ y: Math.max(0, target), animated: false });
    },
    [open, pkgId, currentId]
  );

  // 行点按：链到对应观看页（同包切集，父页按 pkgId 持有数据不重拉）；
  // 跳转口径统一 useOpenVideo——在桌面播放独立窗内即窗内切集（不派生新窗）
  const openVideoNav = useOpenVideo();
  const goVideo = useCallback(
    (v) => {
      openVideoNav(site, v.id);
    },
    [openVideoNav, site]
  );

  // 不在该类包内（且无加载/错误）：整块不渲染
  if (!pkg && !loading && !err) return null;

  const items = (pkg && pkg.items) || [];
  const total = (pkg && pkg.count) || items.length;
  const curIdx = items.findIndex((v) => String(v.id) === String(currentId));
  const counter = curIdx >= 0 ? curIdx + 1 + '/' + total : total + ' 部';

  // 队列可视高度上限：约 5 行（106px/行），矮屏按 60vh 收（NextWeb 同口径）
  const queueMaxH = Math.min(Math.round(vh * 0.6), 560);

  return (
    // 容器与描述盒同规格（rounded-xl + surface-2，无描边——全站扁平形态）
    <View style={[{ borderRadius: 12, backgroundColor: p.surface2, overflow: 'hidden' }, style]}>
      {/* 头部：整行可点按收起/展开（不只右侧图标钮——40px 圆钮在手机上太难点，
          区种标记 + 包名 + 序号/总数 + 折叠指示图标一体为点按目标）。布局纯
          静态对象 + 视觉态事件 state（安卓端 Pressable 样式函数携带的布局
          属性不生效——flexDirection 丢失即整行塌竖排，见 use-press-visual 头注） */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={open ? '收起选集' : '展开选集'}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
        {...hv.binds}
        style={[
          {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingVertical: 6,
            paddingLeft: 12,
            paddingRight: 6,
          },
          {
            // web hover / 按压轻灰面（面板底 surface-2 之上提亮一档到 line）
            backgroundColor: hv.hovered || hv.pressed ? p.line : 'transparent',
          },
        ]}
      >
        <View style={{ borderRadius: 4, backgroundColor: p.foreground + '1a', paddingHorizontal: 6, paddingVertical: 1 }}>
          <Text maxFontSizeMultiplier={FSM_META} style={{ fontSize: 12, fontWeight: '500', color: p.foreground, includeFontPadding: false }}>{tag}</Text>
        </View>
        {loading ? (
          <Skeleton style={{ height: 16, width: 160 }} />
        ) : (
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={FSM_DENSE}
            style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: '500', color: p.foreground, includeFontPadding: false }}
          >
            {(pkg && pkg.title) || fallbackTitle || tag + '选集'}
          </Text>
        )}
        {loading ? (
          <Skeleton style={{ height: 12, width: 40, flexShrink: 0 }} />
        ) : (
          <Text maxFontSizeMultiplier={FSM_META} style={{ flexShrink: 0, fontSize: 12, color: p.muted, fontVariant: ['tabular-nums'], includeFontPadding: false }}>
            {counter}
          </Text>
        )}
        {/* 折叠指示图标（40px 槽位/24px 图标）：纯视觉件，点按由整行承担 */}
        <View style={{ marginLeft: 'auto', width: 40, height: 40, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}>
          {open ? <ChevronUp size={24} color={p.muted} /> : <ChevronDown size={24} color={p.muted} />}
        </View>
      </Pressable>
      {open ? (
        loading ? (
          // 骨架：4 行形似面板行
          <View style={{ gap: 4, paddingHorizontal: 4, paddingBottom: 8 }}>
            {Array.from({ length: 4 }, (_, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingVertical: 6 }}>
                <Skeleton style={{ width: 16, height: 12, flexShrink: 0 }} />
                <Skeleton style={{ width: THUMB_W, aspectRatio: 16 / 9, borderRadius: 8, flexShrink: 0 }} />
                <View style={{ flex: 1, minWidth: 0, paddingVertical: 2 }}>
                  <Skeleton style={{ height: 16 }} />
                  <Skeleton style={{ height: 16, marginTop: 8, width: '66%' }} />
                </View>
              </View>
            ))}
          </View>
        ) : err ? (
          // 取数失败：面板内错误态 + 手动重试（选集是辅助面，不打断页面其余部分）
          <View style={{ paddingHorizontal: 4, paddingBottom: 8 }}>
            <ErrorState message={err} onRetry={onRetry} />
          </View>
        ) : items.length ? (
          <ScrollView
            ref={boxRef}
            nestedScrollEnabled // 手机画幅嵌在页面滚动内时允许直接滚本面板（Android 必需）
            onLayout={(e) => {
              boxHRef.current = e.nativeEvent.layout.height;
              tryCenter(curIdx);
            }}
            style={{ maxHeight: queueMaxH }}
            contentContainerStyle={{ gap: 4, paddingHorizontal: 4, paddingBottom: 8 }}
          >
            {items.map((v, i) => (
              <PackageRow
                key={String(v.id)}
                v={v}
                site={site}
                index={i + 1}
                current={i === curIdx}
                saver={saver}
                onPress={goVideo}
                onLayout={(e) => {
                  // 行坐标记账：换集后在播行换位，据此把新在播行滚到中部
                  rowsRef.current[i] = {
                    y: e.nativeEvent.layout.y,
                    h: e.nativeEvent.layout.height,
                  };
                  if (i === curIdx) tryCenter(curIdx);
                }}
              />
            ))}
          </ScrollView>
        ) : (
          <View style={{ paddingHorizontal: 12, paddingBottom: 12 }}>
            <Text style={{ fontSize: 12, color: p.muted, opacity: 0.6 }}>{tag}内暂无视频</Text>
          </View>
        )
      ) : null}
    </View>
  );
}

export default memo(PackagePanel);
