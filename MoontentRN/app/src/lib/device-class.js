// ============================================================================
// device-class.js —— 稳定设备形态判定（与窗口宽解耦）
// ----------------------------------------------------------------------------
// 背景：use-form 的 form 按「当前窗口宽」分档（<768 手机 / 768–1279 平板），
// 设备旋转时宽度跨过 768 断点，form 随之翻转——大屏手机横屏（844~932pt）被
// 误判成平板、小平板竖屏（iPad mini 744pt / 8 寸安卓板 600dp）被误判成手机。
// 凡「设备类型」语义的判定（旋转↔全屏联动、手机横屏沉浸态、观看页横屏布局
// 分档）必须用本模块的稳定口径；form 仅服务宽度自适应 UI（导航形态/卡片栅格）：
//   · iOS     Platform.isPad；
//   · Android Dimensions.get('screen') 短边 ≥600dp（sw600dp 平板口径；折叠屏
//             展开短边即上 600dp，按平板处理合理。读 screen 而非 window——
//             旋转/分屏不改值，判定稳定）；
//   · web     沿用宽度口径（窗口即形态，与 formFor 完全一致，web 行为不变）。
// native 侧判定与传入宽度无关（参数仅为 web 兜底），旋转全程恒定。
// ============================================================================
import { Dimensions, Platform } from 'react-native';
import { DESKTOP_MIN, formFor } from './use-form.js';

// 是否平板设备（native 恒定；web 按传入窗口宽推导，缺省读当前窗口）
export function isPadDevice(width) {
  if (Platform.OS === 'ios') return !!Platform.isPad;
  if (Platform.OS === 'android') {
    try {
      const s = Dimensions.get('screen');
      return Math.min(s.width, s.height) >= 600;
    } catch (_e) {
      return false; // Dimensions 异常按手机兜底（联动多开一门，布局走 landfs 也不失可用）
    }
  }
  // web：窗口即形态（与 formFor 同口径）
  let w = width;
  if (!(w > 0)) {
    try {
      w = Dimensions.get('window').width;
    } catch (_e) {
      w = 0;
    }
  }
  return formFor(w) !== 'phone';
}

// 手机横屏沉浸态统一判定（landfs 布局 / AppShell 收顶栏 / 控件自垫安全区三方
// 共用，替代散落各处易漂移的 form==='phone' && width>height && width<1024）：
// 手机设备 + 横屏 + 宽<1024（≥1024 的横窗口按桌面画幅走分栏，不沉浸）。
// 平板横屏是常态使用姿势（land 分栏），恒不沉浸。
export function isImmersiveLandscape(width, height) {
  return (
    !isPadDevice(width) &&
    width > 0 &&
    height > 0 &&
    width > height &&
    width < DESKTOP_MIN
  );
}
