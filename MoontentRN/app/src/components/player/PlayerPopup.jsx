// ============================================================================
// PlayerPopup.jsx —— 播放器交互弹层统一外观（站方播放器形态，用户指定口径）
// ----------------------------------------------------------------------------
// 参考形态（腾讯视频/iQiyi 播放器）：深灰圆角面板 + 逐行文本，当前项整行提亮
//（浅灰底 + 半粗），无描边、无图标、无分组标题。倍速/清晰度菜单直接用它；
// 播放设置菜单（PlayerMenu）与选集浮层复用同一套底色/圆角，保持一个语言。
// iOS 26 玻璃端（HIG 口径）：弹层归 Regular 变体（HIG Materials：文本量大的
// popovers/menus 用 Regular——磨砂 + 亮度自适应保前景可读）+ colorScheme 恒
// dark（播放器 chrome 契约），不叠 tint（HIG：tint 只留给主操作强调）；圆角
// 走 RADIUS.popup（大表面圆角矩形），行项玻璃端做同心内缩胶囊（concentric：
// 父半径 − 边距）；显隐走 materialize（GlassSurface 的 shown 透传，HIG：靠
// 调制折光而非 opacity 淡入淡出）。降级端（web/Android/旧 iOS 等）维持
// PANEL_BG 不透明深灰 + 8px 圆角整行提亮——Electron 菜单独立子窗
//（MenuWindowRoot）复用本组件，走降级路径视觉不变。
// 面板本体（PlayerPopup）与整行项（PlayerPopupRow）两个导出：
//   - PlayerPopup：面板容器（默认内容垂直居中，minWidth 108；可覆盖 style）；
//   - PlayerPopupRow：整行项——默认整行居中文本（菜单项）；给 right（如开关）
//     则改左标签右控件布局（设置菜单用）。
// ============================================================================
import { Pressable, Text } from 'react-native';
import GlassSurface from '../ui/GlassSurface.jsx';
import { useGlassEnabled } from '../../lib/glass.js';
import { RADIUS, concentric } from '../../lib/higlass.js';

// 面板底色（半透明深灰，压在画面上略有通透感；导出供 PlayerMenu/选集浮层复用；
// 降级端专用——玻璃端不叠不透明底）
export const PANEL_BG = 'rgba(58,58,58,0.96)';
// 播放器系玻璃深色透染口径已废弃：HIG Clear 变体的暗化职责改由 GlassSurface
// 的 dimming 层承担（35% 黑暗化层，lib/higlass.js DIMMING）；弹层类改
// Regular + dark。旧导出 PLAYER_GLASS_TINT 已删除，勿再引用。
// 当前项整行提亮底色
export const ROW_ACTIVE_BG = 'rgba(255,255,255,0.18)';
// 倍速档位展示序（站方形态：由快到慢自上而下；PlayerControls 窗口内弹层与
// 菜单独立子窗共用同一口径，避免两处列表漂移）
export const RATES_DESC = [2, 1.5, 1.25, 1, 0.75, 0.5];

/**
 * 弹层面板容器
 * @param {{ minWidth?: number, style?: object, shown?: boolean, children?: any }} props
 *   shown：materialize 显隐（玻璃端动画调制折光；降级端等价条件挂载）——
 *   调用方保持挂载时须给外层包裹同步 pointerEvents
 */
export function PlayerPopup({ minWidth = 108, style, shown, children }) {
  return (
    <GlassSurface
      glassStyle="regular"
      dark
      shown={shown}
      style={[
        {
          minWidth,
          paddingVertical: 6,
          borderRadius: 8,
          overflow: 'hidden',
          boxShadow: '0px 6px 20px rgba(0,0,0,0.45)',
        },
        style,
      ]}
      // 玻璃端专属：HIG 大表面圆角（16pt 级）+ 去自定义投影（材质自带
      // 随背景自适应的阴影，再叠会闷）
      glassOnlyStyle={{ borderRadius: RADIUS.popup, boxShadow: 'none' }}
      fallbackStyle={{ backgroundColor: PANEL_BG }}
    >
      {children}
    </GlassSurface>
  );
}

/**
 * 弹层整行项
 * @param {{ label?: string, active?: boolean, onPress?: () => void, right?: any,
 *   children?: any }} props label：文本（也可用 children 自定义行体）；
 *   active：当前项（整行提亮 + 半粗）；right：右侧控件（给了就走左右两端布局）
 */
export function PlayerPopupRow({ label, active = false, onPress, right, children }) {
  const spread = !!right;
  // 玻璃端：行项改同心内缩胶囊（HIG concentricity：面板圆角 − 边距，避免
  // 过紧/外翻圆角；也免得整行高亮顶到面板大圆角边缘）；降级端原样整行通栏
  const glass = useGlassEnabled();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={typeof onPress !== 'function'}
      className={
        'min-h-[38px] flex-row items-center gap-3 px-4 ' +
        (spread ? 'justify-between' : 'justify-center') +
        (glass ? ' mx-1.5' : '')
      }
      style={({ hovered, pressed }) => ({
        borderRadius: glass ? concentric(RADIUS.popup, 6) : 0,
        backgroundColor: active
          ? ROW_ACTIVE_BG
          : pressed
            ? 'rgba(255,255,255,0.22)'
            : hovered
              ? 'rgba(255,255,255,0.1)'
              : 'transparent',
      })}
    >
      {children || (
        <Text
          allowFontScaling={false}
          className="text-sm text-white"
          style={{ fontWeight: active ? '600' : '400', textAlign: 'center' }}
        >
          {label}
        </Text>
      )}
      {right || null}
    </Pressable>
  );
}
