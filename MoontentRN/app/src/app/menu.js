// ============================================================================
// menu.js —— 菜单独立子窗路由（桌面 Electron 专用，深链 /menu?win=menu 由
// desktop/main.js 的菜单会话建窗注入）
// ----------------------------------------------------------------------------
// 屏内容 = MenuWindowRoot（透明窗底色自理，外观/行为见该文件头）。菜单窗
// 分支的根布局（_layout.js）不带 AppShell/播放窗壳，也不带主题/站点/播放器
// Provider——面板全是固定深灰弹层语言，不依赖任何上下文。
// 普通窗口误入（浏览器直达 /menu，无菜单会话可挂）：回落首页，不留白屏死角。
// ============================================================================
import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { IS_MENU_WINDOW } from '../lib/desktop-bridge.js';
import MenuWindowRoot from '../components/player/MenuWindowRoot.jsx';

export default function MenuScreen() {
  const router = useRouter();
  useEffect(() => {
    if (!IS_MENU_WINDOW) router.replace('/');
  }, [router]);
  return IS_MENU_WINDOW ? <MenuWindowRoot /> : null;
}
