// ============================================================================
// desktop-bridge.js —— Electron 桌面壳桥（前端侧）
// ----------------------------------------------------------------------------
// 与 desktop/preload.js 注入的 window.moontentDesktop 对接。四类能力：
//   1) 识别：isDesktopApp() —— 是否运行在 Electron 桌面壳里（web 浏览器 /
//      原生三端恒 false）；desktopPlatform()/useDesktopPlatform() —— 宿主
//      平台（macOS 红绿灯适配判定 useNativeTrafficLights）；
//   2) 播放独立窗：desktopOpenVideo({site,id,mode}) → 主进程建窗/复用
//      （见 desktop/main.js moontent:open-video）；subscribeNavigate(cb) ——
//      单窗复用切集指令（仅播放窗会收到）；
//   2b) 播放窗浮钮：desktopOpenMain()（左上「打开主界面」——把主窗置前）/
//      winControls.toggleAlwaysOnTop()·isAlwaysOnTop()（右上「窗口置顶」开关，
//      桌面端专属）；
//   3) 窗口自控：winControls（自绘标题栏三钮 + 最大化状态订阅 + 置顶开关）；
//   4) 看板跨窗同步：wallBroadcast(items) / subscribeWallChanged(cb) ——
//      播放窗与主窗是两个渲染进程，各自的 wall-store 单例互不可见，加入/
//      移除/进度回写经主进程转发互通（消费方 wall-store.js 的 setItems/
//      applyExternalItems，主进程侧见 moontent:wall-broadcast）；
//   5) 菜单独立子窗：menuWindow（腾讯式弹层窗——倍速/音量/设置浮出为独立
//      小窗，owner 侧开/收/热区/状态反推 + onAction/onClosed 订阅，菜单窗侧
//      ready/sized/action + onState 订阅；建窗/摆位/收起在 desktop/main.js
//      的菜单会话区，owner 侧锚点换算编排在 lib/menu-window.js）。
// IS_PLAYER_WINDOW / IS_MENU_WINDOW：模块加载时读一次 location.search 的
// win=player / win=menu（深链由主进程拼装，对齐 api-base 的 ?api= 注入模
// 式）——必须加载期定格：弹窗内后续 SPA 跳转（选集/自动连播）会改写 URL，
// 届时查询参数已不在。
// 原生端 / 浏览器端守卫降级：所有函数均可安全调用，无效环境返回 false/
// null/空订阅，绝不抛错。
// ============================================================================
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

// —— 是否运行在 Electron 桌面壳（preload 注入的标识）——
export function isDesktopApp() {
  return typeof window !== 'undefined' && !!window.moontentDesktop;
}

/**
 * 桌面壳识别 hook（组件渲染用，替代直接调 isDesktopApp()）：
 * web 首帧恒 false——SSG 导出在 Node 里渲染（无 window，桥必然缺席），首帧
 * 若直接取真实值会与预渲染 HTML 水合不匹配（desktop 相关 UI 烙不进首屏），
 * 挂载后一帧放行真实值（口径同 lib/use-form.js 的水合对齐）；native 无 SSG，
 * 首帧即真值。
 */
export function useIsDesktopApp() {
  const [yes, setYes] = useState(() => (Platform.OS === 'web' ? false : isDesktopApp()));
  useEffect(() => { setYes(isDesktopApp()); }, []);
  return yes;
}

// —— 桌面壳宿主平台（preload 注入的 process.platform；非桌面恒 null）——
export function desktopPlatform() {
  return isDesktopApp() ? window.moontentDesktop.platform || null : null;
}

// macOS 原生红绿灯让位宽度：三颗 12px 圆钮、8px 间距、x=8 起整组宽 52px
// （对齐 desktop/main.js 的 trafficLightPosition 口径），再留 16px 呼吸位
export const TRAFFIC_LIGHT_W = 78;

/**
 * 桌面壳平台 hook（SSG 水合对齐，口径同 useIsDesktopApp）：web 首帧 null，
 * 挂载后放行真值（'darwin' | 'win32' | …）；非桌面恒 null
 */
export function useDesktopPlatform() {
  const [platform, setPlatform] = useState(() => (Platform.OS === 'web' ? null : desktopPlatform()));
  useEffect(() => { setPlatform(desktopPlatform()); }, []);
  return platform;
}

/**
 * 窗口钮是否由系统原生承担（macOS 红绿灯：壳层 titleBarStyle:'hidden' 保留
 * 原生钮，见 desktop/main.js）：true 时前端不渲染自绘三钮、标题栏左侧按
 * TRAFFIC_LIGHT_W 让位；与 useIsDesktopApp 同拍放行真值，无先显后隐闪烁
 */
export function useNativeTrafficLights() {
  return useDesktopPlatform() === 'darwin';
}

// —— 本窗口是否为「视频播放独立窗」（加载期定格，见文件头）——
let playerWindowFlag = false;
if (typeof window !== 'undefined' && window.location) {
  try {
    playerWindowFlag = new URLSearchParams(window.location.search).get('win') === 'player';
  } catch (_) {
    // 异常环境视同非播放窗
  }
}
export const IS_PLAYER_WINDOW = playerWindowFlag;

// —— 本窗口是否为「菜单独立子窗」（加载期定格，见文件头）——
let menuWindowFlag = false;
if (typeof window !== 'undefined' && window.location) {
  try {
    menuWindowFlag = new URLSearchParams(window.location.search).get('win') === 'menu';
  } catch (_) {
    // 异常环境视同非菜单窗
  }
}
export const IS_MENU_WINDOW = menuWindowFlag;

/**
 * 打开视频播放独立窗（仅桌面壳有效；mode 'single'|'multi'，缺省 single）
 * @returns {Promise<boolean>} 是否成功派发（非桌面环境恒 false）
 */
export async function desktopOpenVideo({ site, id, mode }) {
  if (!isDesktopApp() || !window.moontentDesktop.openVideo) return false;
  try {
    await window.moontentDesktop.openVideo({ site, id, mode });
    return true;
  } catch (_) {
    // 主进程校验拒绝等：静默失败，调用方（open-video.js）回落窗口内跳转
    return false;
  }
}

/**
 * 订阅单窗复用切集指令（仅播放窗会收到 {site,id}）
 * @returns {() => void} 取消订阅（非桌面环境为空函数）
 */
export function subscribeNavigate(cb) {
  if (!isDesktopApp() || !window.moontentDesktop.onNavigate) return () => {};
  return window.moontentDesktop.onNavigate(cb) || (() => {});
}

/**
 * 打开（聚焦）主界面窗口（播放窗左上「打开主界面」钮——把主窗置前）
 * @returns {Promise<boolean>} 是否成功（非桌面环境/主窗不在恒 false）
 */
export async function desktopOpenMain() {
  if (!isDesktopApp() || !window.moontentDesktop.openMain) return false;
  try {
    return !!(await window.moontentDesktop.openMain());
  } catch (_) {
    return false;
  }
}

// —— 看板跨窗同步（wall-store 消费；非桌面环境全为 no-op / 空订阅）——
/**
 * 把本窗看板 items 变更广播给其余窗口（fire-and-forget，无回执）
 * @param {Array} items 看板条目数组（wall-store 的 state.items）
 */
export function wallBroadcast(items) {
  if (!isDesktopApp() || !window.moontentDesktop.wall) return;
  try {
    window.moontentDesktop.wall.broadcast({ items });
  } catch (_) {
    // 桥异常（旧版壳无 wall 命名空间等）：静默，退化为单窗看板
  }
}

/**
 * 订阅其它窗口发来的看板变更（payload 形如 { items }）
 * @returns {() => void} 取消订阅（非桌面环境为空函数）
 */
export function subscribeWallChanged(cb) {
  const sub = window.moontentDesktop?.wall?.onChanged;
  if (!isDesktopApp() || typeof sub !== 'function') return () => {};
  return sub(cb) || (() => {});
}

// —— 窗口自控（自绘标题栏用；非桌面环境全为 no-op / 恒 false）——
export const winControls = {
  minimize() {
    window.moontentDesktop?.win?.minimize?.();
  },
  toggleMaximize() {
    window.moontentDesktop?.win?.toggleMaximize?.();
  },
  close() {
    window.moontentDesktop?.win?.close?.();
  },
  /** 当前最大化状态（同步近似值：模块加载后由订阅持续校正，见用法方） */
  async getState() {
    try {
      const s = await window.moontentDesktop?.win?.getState?.();
      return !!s?.maximized;
    } catch (_) {
      return false;
    }
  },
  /** 订阅最大化状态变更；返回取消函数 */
  onStateChange(cb) {
    const sub = window.moontentDesktop?.win?.onStateChange;
    if (!isDesktopApp() || typeof sub !== 'function') return () => {};
    return sub(cb) || (() => {});
  },
  /**
   * 切换本窗置顶（always-on-top；桌面端专属，播放窗右上浮钮用）
   * @returns {Promise<boolean>} 切换后的置顶态（非桌面/桥异常恒 false）
   */
  async toggleAlwaysOnTop() {
    if (!isDesktopApp()) return false;
    try {
      return !!(await window.moontentDesktop?.win?.toggleAlwaysOnTop?.());
    } catch (_) {
      return false;
    }
  },
  /**
   * 本窗当前是否置顶（浮钮初值）
   * @returns {Promise<boolean>}（非桌面/桥异常恒 false）
   */
  async isAlwaysOnTop() {
    if (!isDesktopApp()) return false;
    try {
      return !!(await window.moontentDesktop?.win?.isAlwaysOnTop?.());
    } catch (_) {
      return false;
    }
  },
  /**
   * 切换「小窗播放」（桌面端专属：主进程把本窗缩成右下角小窗并置顶）
   * @returns {Promise<boolean>} 切换后的小窗态（非桌面/桥异常恒 false）
   */
  async toggleMini() {
    if (!isDesktopApp()) return false;
    try {
      return !!(await window.moontentDesktop?.win?.toggleMini?.());
    } catch (_) {
      return false;
    }
  },
  /**
   * 本窗当前是否处于小窗播放态（挂载对齐用）
   * @returns {Promise<boolean>}（非桌面/桥异常恒 false）
   */
  async isMini() {
    if (!isDesktopApp()) return false;
    try {
      return !!(await window.moontentDesktop?.win?.isMini?.());
    } catch (_) {
      return false;
    }
  },
};

// —— 菜单独立子窗（owner 侧开/收 + 菜单窗侧收发；非桌面全 no-op/空订阅，
//    语义见 desktop/main.js 菜单会话区与 lib/menu-window.js 文件头）——
export const menuWindow = {
  /** 预热：owner 侧 PlayerControls 挂载即调（菜单窗提前整树启动，hover 零延迟） */
  prewarm() {
    try {
      window.moontentDesktop?.menu?.prewarm?.();
    } catch (_) {
      /* 桥异常：静默（回落首次打开惰性建窗） */
    }
  },
  /**
   * 打开菜单（payload {kind,anchor,state}，锚点屏幕坐标由 lib/menu-window.js
   * 换算；macOS 全屏等场景主进程返回 fallback）
   * @returns {Promise<'window'|'local'>} 实际走向（非桌面恒 'local'）
   */
  async show(payload) {
    if (!isDesktopApp() || typeof window.moontentDesktop?.menu?.show !== 'function') {
      return 'local';
    }
    try {
      const r = await window.moontentDesktop.menu.show(payload);
      return r && r.fallback === 'local' ? 'local' : 'window';
    } catch (_) {
      return 'local';
    }
  },
  /** 立即收起（选档完成/点空白/控件隐藏） */
  hide() {
    try {
      window.moontentDesktop?.menu?.hide?.();
    } catch (_) { /* 静默 */ }
  },
  /** 指针进控制条热区：撤销宽限收起（桌面路径 hover 保持的中央定时器） */
  enter() {
    try {
      window.moontentDesktop?.menu?.enter?.();
    } catch (_) { /* 静默 */ }
  },
  /** 指针出热区：起 450ms 宽限收起（主进程中央定时器，菜单窗 enter 可撤销） */
  leave() {
    try {
      window.moontentDesktop?.menu?.leave?.();
    } catch (_) { /* 静默 */ }
  },
  /** owner 侧状态反推（菜单开着时倍速/音量被手势等改动）：刷新菜单窗快照 */
  update(state) {
    try {
      window.moontentDesktop?.menu?.update?.({ state });
    } catch (_) { /* 静默 */ }
  },
  /** 菜单窗挂载报到（主进程补推 lastState，拉齐建窗初期竞态） */
  ready() {
    try {
      window.moontentDesktop?.menu?.ready?.();
    } catch (_) { /* 静默 */ }
  },
  /** 菜单窗内容尺寸回报（onLayout，含外圈留白；主进程据此摆位/显示） */
  sized(payload) {
    try {
      window.moontentDesktop?.menu?.sized?.(payload);
    } catch (_) { /* 静默 */ }
  },
  /** 菜单窗选择动作回流 owner（payload {type,value,key}） */
  action(payload) {
    try {
      window.moontentDesktop?.menu?.action?.(payload);
    } catch (_) { /* 静默 */ }
  },
  /** owner 侧订阅菜单动作（payload {type:'rate'|'volume'|'setting',value,key}） */
  subscribeAction(cb) {
    const sub = window.moontentDesktop?.menu?.onAction;
    if (!isDesktopApp() || typeof sub !== 'function') return () => {};
    return sub(cb) || (() => {});
  },
  /** owner 侧订阅菜单收起通知（清开窗标记用） */
  subscribeClosed(cb) {
    const sub = window.moontentDesktop?.menu?.onClosed;
    if (!isDesktopApp() || typeof sub !== 'function') return () => {};
    return sub(cb) || (() => {});
  },
  /** 菜单窗侧订阅菜单状态（payload {kind:'rate'|'vol'|'settings',state}） */
  subscribeState(cb) {
    const sub = window.moontentDesktop?.menu?.onState;
    if (!isDesktopApp() || typeof sub !== 'function') return () => {};
    return sub(cb) || (() => {});
  },
};
