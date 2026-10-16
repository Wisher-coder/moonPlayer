// ============================================================================
// settings.js —— 本地设置（AsyncStorage 替代 localStorage，不上传任何数据）
// ----------------------------------------------------------------------------
// 契约：getSettings() / setSetting(k, v) / subscribeSettings(fn)
//   - getSettings()          → Promise<settings>（水合完成后返回当前全量设置）；
//   - setSetting(k, v)       → 写入 + 更新内存镜像 + 广播全部订阅者；
//   - subscribeSettings(fn)  → 返回取消函数；fn 收到 settings 快照对象。
// 键（键语义对齐 NextWeb README「本地数据边界」，RN 侧存 AsyncStorage）：
//   - autoplay    'moontent_autoplay'       '1'/'0'  自动连播，默认开；
//   - hover_preview 'moontent_hover_preview' '1'/'0'  悬浮预览（视频卡 web 悬停
//                                              弹全局预览层，见 HoverPreviewLayer.web），
//                                              默认开；
//   - datasaver   'moontent_datasaver'      '1'/'0'  省流模式（封面降档等），默认关；
//   - serverBase  'moontent_server'         字符串   后端基址，'' = 默认
//                                              （api-base 的 http://localhost:3001）；
//   - playerWindow 'moontent_player_window' 'single'/'multi' 桌面端视频播放独立窗
//                                              策略（单窗复用 / 每次新开），默认
//                                              'single'；仅 Electron 桌面壳消费
//                                              （lib/open-video.js → desktop 桥），
//                                              浏览器/原生端不显示不生效。
//   - liquidGlass 'moontent_liquid_glass'  '1'/'0'  液态玻璃（iOS 26+ 悬浮层
//                                              玻璃质感，渲染出口 GlassSurface），
//                                              默认开；仅 iOS 26+ 设备实际生效，
//                                              其余端设置在但无消费面。
//   - playerFill  'moontent_player_fill'   'fit'/'fill' 播放器全屏画面填充
//                                              （自适应=完整画面含对称黑边 /
//                                              满屏=裁切铺满；爱奇艺「AI满屏」
//                                              腾讯「撑满全屏」同款语义），默认
//                                              'fit'；仅全屏态生效（常态/迷你恒
//                                              contain——竖屏视频在 16:9 卡片里
//                                              cover 会裁掉大半画面）。
//   - miniOnExit  'moontent_mini_on_exit'  '1'/'0'  退出时悬浮播放（离开观看页
//                                              后视频缩为悬浮小窗继续播放），默认
//                                              开；关闭后一切退出路径（返回箭头/
//                                              硬返回/切 tab/URL 直跳）统一在
//                                              player-context 的路由相位 effect
//                                              close() 停止播放；控制条「小窗播放」
//                                              钮是显式操作，不受此键影响。
// AsyncStorage 是异步存储：模块加载即开始水合内存镜像，水合完成会广播一次，
// 已挂载的消费方（Guide 设置区等）借这次广播把 UI 对齐到本机偏好；
// 镜像未就绪期间 getSettingsSnapshot() 返回默认值（只作兜底，正式读取走
// getSettings()）。存储读写异常全程静默降级（与 NextWeb 隐私模式同语义）。
// ============================================================================
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// 逻辑键 → AsyncStorage 物理键
const KEYS = {
  autoplay: 'moontent_autoplay',
  hover_preview: 'moontent_hover_preview',
  datasaver: 'moontent_datasaver',
  serverBase: 'moontent_server',
  playerWindow: 'moontent_player_window',
  liquidGlass: 'moontent_liquid_glass',
  playerFill: 'moontent_player_fill',
  miniOnExit: 'moontent_mini_on_exit',
};

const DEFAULTS = { autoplay: true, hover_preview: true, datasaver: false, serverBase: '', playerWindow: 'single', liquidGlass: true, playerFill: 'fit', miniOnExit: true };

// 字符串型键及其归一（其余键一律布尔）。playerWindow 只取 'single'|'multi'、
// playerFill 只取 'fit'|'fill'，任何非法存量值一律回落默认，脏数据不外溢
const STRING_NORM = {
  serverBase: (v) => String(v == null ? '' : v).trim(),
  playerWindow: (v) => (v === 'multi' ? 'multi' : 'single'),
  playerFill: (v) => (v === 'fill' ? 'fill' : 'fit'),
};

// 内存镜像：唯一同步读取入口（getSettingsSnapshot / api-base 的 getApiBase）
let cache = { ...DEFAULTS };
const subs = new Set();
let hydratePromise = null;

function emit() {
  const snap = { ...cache };
  for (const fn of subs) {
    try { fn(snap); } catch (_e) { /* 单个订阅异常不影响其它订阅 */ }
  }
}

// 水合（幂等，模块加载即触发一次）
export function ensureSettings() {
  if (!hydratePromise) {
    hydratePromise = (async () => {
      try {
        const [a, hp, d, s, pw, lg, pf, mo] = await Promise.all([
          AsyncStorage.getItem(KEYS.autoplay),
          AsyncStorage.getItem(KEYS.hover_preview),
          AsyncStorage.getItem(KEYS.datasaver),
          AsyncStorage.getItem(KEYS.serverBase),
          AsyncStorage.getItem(KEYS.playerWindow),
          AsyncStorage.getItem(KEYS.liquidGlass),
          AsyncStorage.getItem(KEYS.playerFill),
          AsyncStorage.getItem(KEYS.miniOnExit),
        ]);
        if (a !== null) cache.autoplay = a !== '0';
        if (hp !== null) cache.hover_preview = hp !== '0'; // '0' 为 false 其余 true（对齐 autoplay 语义）
        if (d !== null) cache.datasaver = d === '1';
        if (typeof s === 'string') cache.serverBase = s;
        if (typeof pw === 'string') cache.playerWindow = STRING_NORM.playerWindow(pw);
        if (lg !== null) cache.liquidGlass = lg !== '0'; // 同 autoplay 语义：默认开
        if (typeof pf === 'string') cache.playerFill = STRING_NORM.playerFill(pf);
        if (mo !== null) cache.miniOnExit = mo !== '0'; // 同 autoplay 语义：默认开
      } catch (_e) { /* 存储不可用：用默认值 */ }
      emit(); // 水合完成广播：已挂载的消费方对齐本机偏好
    })();
  }
  return hydratePromise;
}

// 读全量设置（等水合；返回新对象，调用方改了不污染镜像）
export async function getSettings() {
  await ensureSettings();
  return { ...cache };
}

// 同步快照（镜像未水合时是默认值；仅在无法等待的兜底场景用）
export function getSettingsSnapshot() {
  return { ...cache };
}

// 写单键：更新镜像 → 持久化 → 广播（持久化失败按会话级设置处理，不回滚镜像）
export async function setSetting(k, v) {
  if (!Object.prototype.hasOwnProperty.call(KEYS, k)) return;
  const norm = STRING_NORM[k];
  if (norm) cache[k] = norm(v); // 字符串键：先归一（playerWindow 收敛合法档位）
  else cache[k] = !!v;
  try {
    await AsyncStorage.setItem(KEYS[k], norm ? cache[k] : cache[k] ? '1' : '0');
  } catch (_e) { /* 存不进就当会话级设置 */ }
  emit();
}

// 订阅变更：返回取消函数（Guide 设置区、播放器连播逻辑等在 effect 里挂/卸）
export function subscribeSettings(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

// 订阅 hook（组件态）：初值同步快照，订阅广播跟随（水合完成的那次广播会把
// 本机持久化真值推上来）。此前是 PlayerMenu 内私有实现，playerFill 的消费方
// 扩到两端 VideoPlayer，上提至此共用
export function useSettingsState() {
  const [s, setS] = useState(() => {
    try {
      return getSettingsSnapshot();
    } catch (_e) {
      return {};
    }
  });
  useEffect(() => {
    let off = null;
    try {
      off = subscribeSettings((snap) => {
        if (snap && typeof snap === 'object') setS(snap);
      });
    } catch (_e) {
      /* 订阅通道异常：保持快照值 */
    }
    return () => {
      if (typeof off === 'function') off();
    };
  }, []);
  return s;
}

// 模块加载即开始水合（import 本模块的任何入口都会触发一次）
ensureSettings();
