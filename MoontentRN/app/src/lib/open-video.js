// ============================================================================
// open-video.js —— 视频页跳转统一口径（useOpenVideo）
// ----------------------------------------------------------------------------
// 全应用所有「进入视频播放页」的跳转收敛到这一个 hook：
//   - Electron 桌面壳·主窗 → desktopOpenVideo 派发主进程开「播放独立窗」
//     （mode 读设置 playerWindow：'single' 复用一窗 / 'multi' 每次新开，
//     见 settings.js 与 mine.js 设置行）；
//   - Electron 桌面壳·播放窗内 → 窗口内 router.push（选集/自动连播/相关
//     推荐都留在播放窗里，不再派生新窗）；
//   - 普通浏览器 / 原生三端 → router.push，与既有行为完全一致。
// opts.method='navigate' 时窗口内回落 router.navigate（mine.js 观看历史的
// 既有语义——不往栈里再压一层）。派发失败（主进程校验拒绝等）自动回落
// 窗口内跳转，绝不静默丢点击。
// ============================================================================
import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { isDesktopApp, IS_PLAYER_WINDOW, desktopOpenVideo } from './desktop-bridge.js';
import { getSettingsSnapshot } from './settings.js';

/** 视频页路由（id 走 encodeURIComponent，与既有各调用点一致） */
export function videoPath(site, id) {
  return '/video/' + site + '/' + encodeURIComponent(String(id));
}

/**
 * 进入视频播放页（桌面主窗弹独立播放窗，其余环境窗口内跳转）
 * @returns {(site: string, id: string, opts?: {method?: 'push'|'navigate'}) => void}
 */
export function useOpenVideo() {
  const router = useRouter();
  return useCallback(async (site, id, opts) => {
    const method = opts && opts.method === 'navigate' ? 'navigate' : 'push';
    if (isDesktopApp() && !IS_PLAYER_WINDOW) {
      // 设置镜像未水合时快照即默认 'single'（设置水合在首批界面渲染前完成）
      const mode = getSettingsSnapshot().playerWindow === 'multi' ? 'multi' : 'single';
      const ok = await desktopOpenVideo({ site: String(site), id: String(id), mode });
      if (ok) return;
    }
    const path = videoPath(site, id);
    if (method === 'navigate') router.navigate(path);
    else router.push(path);
  }, [router]);
}
