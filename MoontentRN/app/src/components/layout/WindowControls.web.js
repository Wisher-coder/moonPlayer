// ============================================================================
// WindowControls.web.js —— 自绘窗口控件三钮（web 实现；原生由同名 .js stub 顶替）
// ----------------------------------------------------------------------------
// Electron 无边框窗口（desktop/main.js frame:false）的最小化/最大化-还原/
// 关闭：腾讯视频/爱奇艺形态的自绘按钮。经 preload 窄通道（moontent:win-*）
// 由本窗口自控（主窗/播放窗共用）；最大化图标随 moontent:win-state-changed
// 事件切换。
// 尺寸规格（对齐 Windows 原生标题栏控件观感）：每钮 46px 宽、撑满宿主行高
//（主窗 56 / 播放窗 36），图标 16-20px 居中；普通钮 hover 灰面、按压加深，
// 关闭钮 hover/按压红底（#e81123，Windows 惯例）白图标。
// 仅在 Electron 桌面壳内渲染（isDesktopApp），普通浏览器调用处直接得 null；
// macOS 例外：壳层 titleBarStyle:'hidden' 保留原生红绿灯（desktop/main.js），
// 本组件同样渲染 null，由宿主标题栏左侧让位（TRAFFIC_LIGHT_W）。
// 双击标题栏最大化/还原、拖拽移动由 Electron 对 -webkit-app-region:drag
// 区域的原生行为提供（拖拽区类名由宿主容器挂 app-drag，本组件只挂
// app-nodrag 保证按钮可点）。
// 样式约定（987c4d0）：布局属性留静态样式段，hover/pressed 只保视觉态。
// ============================================================================
import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Copy, Minus, WinMaximize, Close } from '../icons.js';
import { useTheme } from '../../lib/theme-context.jsx';
import { useIsDesktopApp, useNativeTrafficLights, winControls } from '../../lib/desktop-bridge.js';

const CLOSE_RED = '#e81123'; // Windows 标题栏关闭钮悬停红
const BTN_W = 46;            // 单钮宽（Windows 原生 caption 同宽）

/** 单个控件钮：46 宽撑满行高；图标随主题取色，关闭钮悬停换白 */
function CtrlButton({ onPress, label, danger = false, children }) {
  const { resolved } = useTheme();
  const iconColor = (hovered) =>
    danger && hovered ? '#ffffff' : resolved === 'dark' ? '#e8e8e8' : '#1f1f1f';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      className="app-nodrag" // 拖拽区内的可点元素必须显式 no-drag
      style={[
        // 布局（静态段）：46 宽 × 满高，图标居中
        { width: BTN_W, height: '100%', alignItems: 'center', justifyContent: 'center' },
        // 视觉态（样式函数段）：普通钮 hover 灰面/按压加深；关闭钮红底
        ({ hovered, pressed }) => ({
          backgroundColor: danger
            ? hovered || pressed ? CLOSE_RED : 'transparent'
            : pressed
              ? 'rgba(130,130,130,0.30)'
              : hovered
                ? 'rgba(130,130,130,0.18)'
                : 'transparent',
        }),
      ]}
    >
      {({ hovered }) => children(hovered, iconColor(hovered))}
    </Pressable>
  );
}

/**
 * 自绘窗口控件组：最小化 / 最大化-还原（图标随窗口状态切换）/ 关闭
 */
export default function WindowControls() {
  const desktop = useIsDesktopApp();
  // macOS 红绿灯由系统原生承担，不再画 Windows 风三钮；两 hook 同拍放行
  // 真值（web 首帧恒 false/null），不会出现「先显后隐」闪烁
  const nativeLights = useNativeTrafficLights();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!desktop) return undefined;
    let alive = true;
    winControls.getState().then((m) => { if (alive) setMaximized(m); });
    const unsub = winControls.onStateChange(({ maximized: m }) => setMaximized(!!m));
    return () => { alive = false; unsub(); };
  }, [desktop]);
  if (!desktop || nativeLights) return null;
  return (
    <View className="app-nodrag" style={{ flexDirection: 'row', height: '100%' }}>
      <CtrlButton onPress={winControls.minimize} label="最小化">
        {(_h, color) => <Minus size={18} color={color} strokeWidth={1.8} />}
      </CtrlButton>
      <CtrlButton onPress={winControls.toggleMaximize} label={maximized ? '还原' : '最大化'}>
        {(_h, color) =>
          maximized ? <Copy size={16} color={color} strokeWidth={1.8} /> : <WinMaximize size={15} color={color} strokeWidth={1.8} />}
      </CtrlButton>
      <CtrlButton onPress={winControls.close} label="关闭" danger>
        {(_h, color) => <Close size={20} color={color} strokeWidth={1.8} />}
      </CtrlButton>
    </View>
  );
}
