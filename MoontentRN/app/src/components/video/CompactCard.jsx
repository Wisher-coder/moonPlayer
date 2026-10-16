// 紧凑卡片（RN 三端移植，源：NextWeb CompactCard.jsx）
// ----------------------------------------------------------------------------
// 左缩略图右文案的行式卡（相关推荐/搜索结果用），YouTube 形态。
// 契约 props：{ item, onPress }——item 为归一化视频条目；
// size（可选扩展）：
//   - 'sm'（默认）相关侧栏：缩略 168×94、标题 14/500/行高 20、作者头像 16；
//   - 'md' 搜索结果行：缩略按画幅三档（手机 168 / 平板 246 / PC 500，即
//     NextWeb w-[168px] sm:w-[246px] lg:w-[500px] 的 RN 等价——经 useForm 画幅
//     断点取档）、标题 18/400/行高 26、作者头像 24（YouTube 桌面搜索结果实测值）；
//     行序照 YouTube：标题 → meta（时长 · HD）→ 作者行。
// 数据层无播放量/日期，meta 行只放我们有的事实（时长 · HD），不造假。
// 作者行 = 条目自带 author 字段时渲染（头像 + 名，整行在卡链内不单链）；无此
// 字段的条目不出现任何头像/名称占位。
// showKebab（默认 false）渲染右侧 More 占位小钮（放主链外层，避免
// 嵌套抢占手势；onKebab 可选回调）。props 只增不减。
import { memo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { VideoFrame, More } from '../icons.js';
import { fmtDur } from '../../lib/utils.js';
import { useForm } from '../../lib/use-form.js';
import { FSM_DENSE, FSM_META } from '../../lib/text-fit.js';
import { usePalette } from '../ui/palette.js';
import { coverUrl, useDataSaver } from '../ui/cover.js';
import CornerBadge from '../ui/corner-badge.jsx';
import { useHoverPreview } from '../../hooks/use-hover-preview.js';

// md 档缩略宽的三画幅断点（对应 NextWeb 的 sm:640 / lg:1024 两档）
function mdThumbWidth(form) {
  if (form === 'pc') return 500;
  if (form === 'pad') return 246;
  return 168;
}

function CompactCard({ item, onPress, size = 'sm', showKebab = false, onKebab }) {
  const p = usePalette();
  const saver = useDataSaver();
  const { form } = useForm() || {};
  // 悬浮预览上报（site 传 null → 钩子内回退站点上下文；web only，native no-op）
  const preview = useHoverPreview(null, item);
  const [coverErr, setCoverErr] = useState(false);
  // 按压透明度反馈的事件 state（布局已全部静态化——安卓端 Pressable 样式函数
  // 携带的布局属性不生效，见 lib/use-press-visual.js 头注；本链另有悬浮预览
  // 的 onHoverIn/Out 要挂，binds 不整体展开，只接按压两事件）
  const [pressed, setPressed] = useState(false);
  const [kebabHover, setKebabHover] = useState(false);
  const [kebabPressed, setKebabPressed] = useState(false);

  const v = item;
  if (!v || v.id == null) return null; // 脏数据防御
  const md = size === 'md';
  const thumb = md ? mdThumbWidth(form) : 168;
  const dur = fmtDur(v.duration);
  const a = v.author && v.author.id != null ? v.author : null;
  const src = v.cover && !coverErr ? coverUrl(v.cover, saver) : null;

  return (
    // native 陷阱（两代演进，皆为安卓 Fabric/Yoga 与 web 的 flex 解析差异）：
    // ① Pressable 的 style 函数里 flex:1 在 RN 侧不生效（web 正常）；
    // ② flex 挂在 row 方向的外层 View 上也不够——Pressable 作为 row 主轴子项
    //   没有 flex/宽度（shrink-to-fit），文案列 flex:1（flexBasis 0%）挂在
    //   自适应宽度的父级上，安卓上文案列会被 Yoga 塌成窄条 → 标题逐字竖排换行
    //   （web 的 CSS 引擎按 max-content 贡献解析 grow 子项，故 web 正常）。
    // 终版范式（plugins/search 页同款承重墙）：外层 row View 只管排 kebab，
    // 承重墙普通 View 在其中拿 flex:1，Pressable 在 column 承重墙里靠默认
    // stretch 获得有界宽度——宽度链不再依赖任何「自适应父级 + grow 子项」组合。
    <View style={{ flexDirection: 'row', minWidth: 0, gap: md ? 16 : 8 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={v.title || '视频'}
          onHoverIn={preview.onHoverIn}
          onHoverOut={preview.onHoverOut}
          onPress={() => onPress && onPress(v)}
          onPressIn={() => setPressed(true)}
          onPressOut={() => setPressed(false)}
          style={[
            { flexDirection: 'row', minWidth: 0, gap: md ? 16 : 8 },
            { opacity: pressed ? 0.9 : 1 },
          ]}
        >
          {/* 缩略图：16:9、定宽三档、圆角（sm 8px / md 12px）；
              ref 供悬浮预览锚定（web 端 View ref 直达 DOM div，浮层按它贴位/跟随滚动） */}
          <View
            ref={preview.elRef}
            style={{
              position: 'relative',
              width: thumb,
              aspectRatio: 16 / 9,
              borderRadius: md ? 12 : 8,
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
            {/* 时长角标：右下（badge-shape 同规格，行卡距右下 4px） */}
            {dur ? (
              <View style={{ position: 'absolute', bottom: 4, right: 4, pointerEvents: 'none' }}>
                <CornerBadge text={dur} />
              </View>
            ) : null}
          </View>
          {/* 文案区 */}
          <View style={{ flex: 1, minWidth: 0, paddingVertical: 2 }}>
            <Text numberOfLines={2} maxFontSizeMultiplier={FSM_DENSE} style={md ? { fontSize: 18, lineHeight: 26, color: p.foreground, includeFontPadding: false } : { fontSize: 14, fontWeight: '500', lineHeight: 20, color: p.foreground, includeFontPadding: false }}>
              {v.title || '(无标题)'}
            </Text>
            {md ? (
              <>
                {/* 搜索行 meta：时长 · HD（只放我们有的事实） */}
                {dur || v.hd ? (
                  <Text maxFontSizeMultiplier={FSM_META} style={{ marginTop: 4, fontSize: 12, color: p.muted, includeFontPadding: false }}>
                    {dur}
                    {dur && v.hd ? ' · ' : ''}
                    {v.hd ? 'HD' : ''}
                  </Text>
                ) : null}
                {a ? <AuthorRow a={a} saver={saver} avatar={24} gap={8} /> : null}
              </>
            ) : (
              a ? <AuthorRow a={a} saver={saver} avatar={16} gap={6} /> : null
            )}
          </View>
        </Pressable>
      </View>
      {showKebab ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="更多操作"
          onPress={() => onKebab && onKebab(v)}
          hitSlop={8}
          onHoverIn={() => setKebabHover(true)}
          onHoverOut={() => setKebabHover(false)}
          onPressIn={() => setKebabPressed(true)}
          onPressOut={() => setKebabPressed(false)}
          style={[
            {
              marginTop: 2,
              width: 32,
              height: 32,
              borderRadius: 16,
              alignItems: 'center',
              justifyContent: 'center',
            },
            {
              backgroundColor: kebabHover ? p.surface2 : 'transparent', // hover 才出灰面（web only）
              opacity: kebabPressed ? 0.85 : 1,
            },
          ]}
        >
          <More size={16} color={p.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

// 作者行：头像 + 名（YouTube 侧栏作者名为纯文本不单链，整行在卡链内）；
// 头像恒取 320 档（16/24px 展示位一档到底最省）
function AuthorRow({ a, saver, avatar, gap }) {
  const p = usePalette();
  return (
    <View style={{ marginTop: 4, flexDirection: 'row', alignItems: 'center', gap }}>
      {a.avatar ? (
        <Image
          source={{ uri: coverUrl(a.avatar, true) }}
          style={{ width: avatar, height: avatar, borderRadius: avatar / 2 }}
          contentFit="cover"
          transition={200}
        />
      ) : (
        <View style={{ width: avatar, height: avatar, borderRadius: avatar / 2, backgroundColor: p.surface2 }} />
      )}
      <Text numberOfLines={1} maxFontSizeMultiplier={FSM_DENSE} style={{ flex: 1, fontSize: 12, color: p.muted, includeFontPadding: false }}>
        {a.name || ''}
      </Text>
    </View>
  );
}

// memo：相关推荐侧栏/搜索结果列表父级重渲染时，props 未变的行卡按浅比较跳过
export default memo(CompactCard);
