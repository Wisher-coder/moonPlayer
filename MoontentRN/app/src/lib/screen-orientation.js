// ============================================================================
// screen-orientation.js —— native 端屏幕方向控制器（原生实现）
// ----------------------------------------------------------------------------
// 播放器「应用内全屏」的方向策略层（对标 NewPipe / af-video-player /
// video.js mobile-ui 的成熟写法）：
//   · 进全屏按视频画幅锁向：横幅 lockAsync(LANDSCAPE)（传感器双向），
//     竖幅 lockAsync(PORTRAIT_UP)（不旋转，竖屏铺满）。
//   · 退全屏恢复「进入前方向」：竖屏进入 → 先锁回 PORTRAIT_UP 再延迟 ~1s
//     unlockAsync 放开传感器（旋转动画期间传感器回翻的竞态由此避开，
//     af-video-player 的 1500ms 同款思路）；横屏进入 → 直接 unlockAsync。
//     延迟解锁挂在可取消的定时器上——期间用户再次进全屏即作废。
//   · subscribeOrientation：addOrientationChangeListener 包装，供「物理旋转
//     ↔ 全屏联动」消费（只在竖↔横翻转时回调）。
// 与 native-player.js 同款平台分流：expo-screen-orientation 只进原生图谱——
// web 端全屏走容器 requestFullscreen（VideoPlayer.web.js），方向锁在全屏
// 上下文内自行尝试（screen.orientation.lock，仅 Android Chrome 生效）。
// 加载 gating：包入口在模块求值期就 requireNativeModule（原生侧缺失即抛错），
// 且 Expo 版 Metro require 会把模块初始化错误当「致命错误」上报（RedBox），
// 外层 try/catch 拦不住——必须先用 requireOptionalNativeModule（查不到返
// null、不抛错、不上报）探测原生侧存在，再 require 包本体。旧调试包（未含
// 本模块的原生侧）热更新 JS 时由此降级为「方向锁不可用」：全屏沉浸照常，
// 仅不旋转；重建原生包（pod install/gradle 同步自动链接）后自然恢复。
// ============================================================================
import { requireOptionalNativeModule } from 'expo-modules-core';

let mod = null;
let resolved = false;
function sdk() {
  if (!resolved) {
    resolved = true;
    // 探测在前：原生侧不存在时绝不 require 包本体（require 即致命错误）
    if (requireOptionalNativeModule('ExpoScreenOrientation')) {
      try {
        mod = require('expo-screen-orientation');
      } catch (_e) {
        mod = null; // 理论不可达（探测已过）：兜底静默
      }
    }
  }
  return mod;
}

// 方向值横屏判定：兼容两种载荷——数值枚举（addOrientationChangeListener 的
// orientationInfo.orientation 是 Orientation 数值枚举：1=竖上/2=竖下/3=横左/
// 4=横右，见 ScreenOrientation.types.d.ts）与字符串名。旧版统一 String() 后
// 与字符串名比较，数值载荷恒不匹配——「旋转自动进全屏」因此从未生效
function isLandscapeEnum(orientation) {
  if (typeof orientation === 'number') return orientation === 3 || orientation === 4;
  return orientation === 'LANDSCAPE_LEFT' || orientation === 'LANDSCAPE_RIGHT';
}

// Orientation 数值枚举 → 名字（getOrientationAsync 对外统一吐字符串名，
// 防消费方再踩数值/字符串不一致的坑）
const ORIENTATION_NAMES = ['UNKNOWN', 'PORTRAIT_UP', 'PORTRAIT_DOWN', 'LANDSCAPE_LEFT', 'LANDSCAPE_RIGHT'];

// 当前屏幕方向（Orientation 枚举字符串；模块不可用返回 null——调用方以
// useWindowDimensions 的宽高比兜底即可，两者语义一致）
export function getOrientationAsync() {
  const m = sdk();
  if (!m) return Promise.resolve(null);
  try {
    return m
      .getOrientationAsync()
      .then((o) => {
        if (o == null) return null;
        if (typeof o === 'number') return ORIENTATION_NAMES[o] || String(o);
        return String(o);
      })
      .catch(() => null);
  } catch (_e) {
    return Promise.resolve(null);
  }
}

// 锁方向：横屏视频锁 LANDSCAPE（随传感器左右横转），竖屏视频锁 PORTRAIT_UP。
// 任何显式落锁前先取消在途的延迟解锁——否则退全屏起的 ~1s unlockAsync 定时
// 器会把刚落的新锁当场放掉（如退全屏后 1s 内进入聊天页，竖屏锁被迟到的
// 解锁放开、设备随即转横）。不可用/失败静默——沉浸布局仍铺满整屏，只是不旋转
export function lockOrientation(videoLandscape) {
  cancelPendingUnlock();
  const m = sdk();
  if (!m) return Promise.resolve();
  try {
    const lock = videoLandscape
      ? m.OrientationLock.LANDSCAPE
      : m.OrientationLock.PORTRAIT_UP;
    return m.lockAsync(lock).catch(() => {});
  } catch (_e) {
    return Promise.resolve();
  }
}

// 延迟解锁定时器：退出全屏的「锁回竖屏 → 1s 后放开传感器」在途段。用户
// 在窗口期内再次进全屏必须取消——否则迟到的 unlockAsync 会把新全屏的
// 横屏锁当场放掉（表现为「刚进全屏又弹回竖屏」）
let restoreUnlockTimer = null;
function cancelPendingUnlock() {
  if (restoreUnlockTimer != null) {
    clearTimeout(restoreUnlockTimer);
    restoreUnlockTimer = null;
  }
}

function unlockQuiet() {
  const m = sdk();
  if (!m) return;
  try {
    m.unlockAsync().catch(() => {});
  } catch (_e) {
    /* 忽略 */
  }
}

// 退全屏的方向恢复（preLandscape = 进入全屏前屏幕是否横屏）：
//   竖屏进入 → 锁回 PORTRAIT_UP（app 立即转竖）+ 1s 后 unlockAsync 放开
//     传感器（交还系统自动旋转；拿横屏姿势等传感器自己翻，不会突兀）。
//   横屏进入（landfs 物理旋转场景）→ 直接 unlockAsync（本来就是横的，无需
//     折腾；跟随用户后续姿势）。
// 再次进全屏时先 cancelPendingUnlock()（见 lockOrientation 入口）。
export function restoreAfterFullscreen(preLandscape) {
  cancelPendingUnlock();
  if (preLandscape) {
    unlockQuiet();
    return;
  }
  const m = sdk();
  if (!m) return;
  try {
    m.lockAsync(m.OrientationLock.PORTRAIT_UP)
      .then(() => {
        restoreUnlockTimer = setTimeout(() => {
          restoreUnlockTimer = null;
          unlockQuiet();
        }, 1000);
      })
      .catch(() => {});
  } catch (_e) {
    /* 忽略 */
  }
}

// 锁向与恢复统一入口：进全屏前先取消在途的延迟解锁（与 restoreAfterFullscreen
// 的定时器互斥），再落新锁
export function lockForVideo(videoLandscape) {
  cancelPendingUnlock();
  return lockOrientation(videoLandscape);
}

// 方向变化订阅（只在竖↔横翻转时触发；expo-screen-orientation 的语义）。
// cb(landscape: boolean)。返回取消函数；模块不可用返回 no-op。
export function subscribeOrientation(cb) {
  const m = sdk();
  if (!m || !m.addOrientationChangeListener) return () => {};
  let sub = null;
  try {
    sub = m.addOrientationChangeListener((e) => {
      const o =
        e && e.orientationInfo && e.orientationInfo.orientation != null
          ? e.orientationInfo.orientation
          : null;
      if (o == null) return;
      // UNKNOWN(0，设备平放桌面等)不派发——横屏全屏中平放手机会被误判「回竖」
      // 而退出（字符串载荷无此值，天然跳过）
      if (typeof o === 'number' && o === 0) return;
      cb(isLandscapeEnum(o));
    });
  } catch (_e) {
    return () => {};
  }
  return () => {
    try {
      if (sub && sub.remove) sub.remove();
    } catch (_e) {
      /* 忽略 */
    }
  };
}
