// ============================================================================
// PageStates.jsx —— 专区/相册/作者页共用空态与错误态（zones 模块内共享件）
// ----------------------------------------------------------------------------
// 逐条移植 NextWeb src/components/video/EmptyState.jsx 与 ErrorState.jsx
// （图标 + 标题 + 说明 + 可选重试钮 / 警示图标 + 错误文案 + 重试钮，居中列布局）。
// RN 工程的跨模块八原语契约（src/components/ui/*）不含这两个状态件，而本组
// 页面（zones/package/albums/album/author）都按 NextWeb 语义需要「空态 + 失败
// 重试态」，故在本模块（我方所有）内落地一份，供本组页面共用；不越界改
// ui/ 契约目录。
// 交互语义与 NextWeb 完全一致：
//   EmptyState —— 图标 40 + 标题 14 + 说明 12（可选），py-16 居中；
//   ErrorState —— 警示图标（红 80% 透明）+ 错误文案（长文换行）+ 胶囊重试钮
//                 （secondary 小号 32 高，钮内 16px 旋转图标与文字）。
// ============================================================================
import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Inbox, Restart, Alert } from '../icons.js';
import { usePalette } from '../ui/palette.js';
import GlassSurface from '../ui/GlassSurface.jsx';
import usePressVisual from '../../lib/use-press-visual.js';
import Spinner from '../ui/Spinner.jsx';
import { RADIUS } from '../../lib/higlass.js';
import { useChromeInsets } from '../../hooks/use-chrome-scroll.js';

// —— 空态：图标 + 标题 + 说明 + 可选操作 ——
function EmptyStateInner({ icon: Icon = Inbox, title = '暂无内容', desc, action }) {
  const p = usePalette();
  return (
    <View style={{ paddingVertical: 64, alignItems: 'center', justifyContent: 'center', gap: 6 }}>
      <Icon size={40} color={p.muted} opacity={0.5} />
      <Text style={{ marginTop: 4, fontSize: 14, color: p.muted, textAlign: 'center' }}>{title}</Text>
      {desc ? (
        <Text style={{ fontSize: 12, color: p.muted, opacity: 0.7, textAlign: 'center', maxWidth: 320, lineHeight: 16 }}>
          {desc}
        </Text>
      ) : null}
      {action ? <View style={{ marginTop: 12 }}>{action}</View> : null}
    </View>
  );
}

// —— 错误态：警示图标 + 错误文案 + 重试按钮（onRetry 缺省时只展示文案）——
function ErrorStateInner({ message, onRetry }) {
  const p = usePalette();
  const hv = usePressVisual(); // 布局静态化 + 视觉态事件 state（安卓样式函数陷阱）
  return (
    <View style={{ paddingVertical: 64, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
      <Alert size={32} color="rgba(248,113,113,0.8)" />
      {message ? (
        <Text style={{ maxWidth: 448, fontSize: 14, color: p.muted, textAlign: 'center', lineHeight: 20 }}>
          {message}
        </Text>
      ) : null}
      {onRetry ? (
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          {...hv.binds}
          style={[
            { marginTop: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 32, borderRadius: 16, paddingHorizontal: 12 },
            { backgroundColor: hv.hovered ? p.line : p.surface2, opacity: hv.pressed ? 0.85 : 1 },
          ]}
        >
          <Restart size={16} color={p.foreground} />
          <Text style={{ color: p.foreground, fontSize: 12, fontWeight: '500', includeFontPadding: false }}>重试</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export const EmptyState = memo(EmptyStateInner);
export const ErrorState = memo(ErrorStateInner);

// —— 加载更多态底条（无限滚动页共用）——
// 背景：VideoGrid/AlbumGrid（跨模块契约件，不可改）不透传 ListFooterComponent，
// 「正在加载…/加载更多失败重试」无法作列表尾部流内元素渲染；本组件以页底
// 浮层承接同一语义——触发加载更多的时刻用户必在列表底端，浮层恰在视线处；
// pointerEvents box-none 不挡列表滚动，仅按钮可点。
// 用法：{LoadMoreBar({ loadingMore, err: moreErr, onRetry: loadMore })}，
// 无事时渲染 null。
function LoadMoreBarInner({ loadingMore, err, onRetry }) {
  const p = usePalette();
  // 壳层避让：手机画幅页底浮层需抬起悬浮底栏高度（pad/PC 恒 0）
  const chrome = useChromeInsets();
  if (err) {
    return (
      <View
        style={{ pointerEvents: 'box-none',

          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 12 + chrome.bottom,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* iOS 26 玻璃端浮层卡换玻璃（悬浮于列表之上，colorScheme 跟主题；
            圆角走 HIG 控件面令牌）；降级端 background 面原样 */}
        <GlassSurface
          style={{ borderRadius: 12, padding: 4 }}
          glassOnlyStyle={{ borderRadius: RADIUS.control }}
          fallbackStyle={{ backgroundColor: p.background }}
        >
          <ErrorState message={err} onRetry={onRetry} />
        </GlassSurface>
      </View>
    );
  }
  if (!loadingMore) return null;
  return (
    <View
      style={{ pointerEvents: 'box-none',

        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 16 + chrome.bottom,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* 底部悬浮加载胶囊：玻璃端玻璃材质折射底下滚过的列表；降级端原样 */}
      <GlassSurface
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 16,
          paddingVertical: 8,
          borderRadius: 16,
        }}
        fallbackStyle={{ backgroundColor: p.background }}
      >
        <Spinner size={16} />
        <Text style={{ fontSize: 12, color: p.muted }}>正在加载…</Text>
      </GlassSurface>
    </View>
  );
}
export const LoadMoreBar = memo(LoadMoreBarInner);
