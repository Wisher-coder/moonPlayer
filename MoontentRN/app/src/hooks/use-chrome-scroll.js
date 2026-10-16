// ============================================================================
// use-chrome-scroll.js —— 壳层收放的方向守卫 hook + 页面安全间距
// ----------------------------------------------------------------------------
// 各 tab 页主滚动容器挂本 hook 返回的 onScroll（ScrollView 直挂；网格组件经
// onScroll/scrollEventThrottle 可选透传进 FlashList），向下滚收壳层、向上滚
// 放壳层（写入 chrome-store）。判定规则（防抖口径）：
//   · 微扰过滤：|dy| < 2 忽略；方向反转时同向累积量清零重计；
//   · 向下同向累计 ≥ HIDE_ACC（24px）→ 收起（顶部区 y ≤ 8 内不收）；
//   · 向上同向累计 ≤ -SHOW_ACC（12px）或回到顶部（y ≤ 8）→ 恢复——恢复
//     阈值比收起灵敏，滚动条微回拨即唤回导航；
//   · 短内容保护：内容高 ≤ 视口高 + 8 恒显示（骨架/空态页无谓收放）；
//   · iOS 回弹：y 负值 clamp 到 0 再参与方向计算。
// enabled=false（pad/PC 画幅）返回空对象——props 直接透传等于不挂事件。
// 只挂页面主纵滚容器；嵌套横滚轨道（板块 rail/专辑横架）不要挂。
//
// useChromeInsets：手机画幅下顶/底栏 overlay 悬浮于内容之上（AppShell），
// 页面内容全出血铺满整屏，滚动内容需自垫间距防止首末条目被栏盖住——
// contentContainerStyle 的 paddingTop/paddingBottom 加本值即可。垫在滚动
// 内容上意味着收起时垫高区随内容滚出视口、回顶时栏必显示，两端均无留白。
// 值 = 安全区 + 仅当对应栏在该页可见时的栏高（白名单口径见 chrome-routes）：
// pad/PC（栏在流内）/观看页/搜索页（沉浸自理）返回 0；白名单外页面只剩安
// 全区；tab 槽位页加底栏高；首页/我的两栏俱垫。页面无需感知白名单。
// 页面接入标准：ScrollView 类页面用 ScreenScrollView（内部即调本 hook，
// 勿再手写算术）；FlashList 网格页在 ListHeaderComponent/contentContainerStyle
// 手动加本值（见 index/zones/albums 等页）。静态检查 chrome-inset-check.mjs
// 按此口径防回归。
// ============================================================================
import { useMemo, useRef } from 'react';
import { usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { setChromeHidden } from '../lib/chrome-store.js';
import { hasPhoneBottomNav, hasPhoneTopBar, isSearchRoute, isWatchRoute } from '../lib/chrome-routes.js';
import { useForm } from '../lib/use-form.js';
import { TOPBAR_H as CHROME_TOP_H, BOTTOMNAV_H as CHROME_BOTTOM_H } from '../lib/chrome-metrics.js';

const HIDE_ACC = 24; // 向下同向累计阈值（px）
const SHOW_ACC = 12; // 向上同向累计阈值（px）——恢复更灵敏
const TOP_ZONE = 8; // 顶部区（含回弹）：恒显示
const MIN_DY = 2; // 微扰过滤下限
const SHORT_CONTENT = 8; // 内容仅高出视口此值内视为不可滚

export default function useChromeScroll(enabled) {
  // 方向记忆挂在 ref：onScroll 闭包跨渲染稳定，不触发页面重渲染
  const st = useRef({ lastY: 0, acc: 0 }).current;
  return useMemo(() => {
    if (!enabled) return {};
    const onScroll = (e) => {
      const ev = e && e.nativeEvent;
      if (!ev) return;
      const y = Math.max(0, (ev.contentOffset && ev.contentOffset.y) || 0);
      // 短内容（骨架/空态/刚挂载）：无可滚行程，恒显示
      const ch = ev.contentSize ? ev.contentSize.height : 0;
      const lh = ev.layoutMeasurement ? ev.layoutMeasurement.height : 0;
      if (ch > 0 && lh > 0 && ch <= lh + SHORT_CONTENT) {
        st.lastY = y;
        st.acc = 0;
        setChromeHidden(false);
        return;
      }
      const dy = y - st.lastY;
      st.lastY = y;
      if (Math.abs(dy) < MIN_DY) return; // 微扰
      st.acc = st.acc * dy > 0 ? st.acc + dy : dy; // 同向累计，反转清零
      if (y <= TOP_ZONE || st.acc <= -SHOW_ACC) {
        st.acc = 0;
        setChromeHidden(false);
      } else if (st.acc >= HIDE_ACC) {
        st.acc = 0;
        setChromeHidden(true);
      }
    };
    return { onScroll, scrollEventThrottle: 16 };
  }, [enabled, st]);
}

// 手机画幅滚动内容自垫间距（pad/PC 与观看/搜索页为 0）。口径与 AppShell 的
// showTopBar/showBottomNav 同源（chrome-routes 白名单）：安全区 + 仅当对应
// 栏在该页真的可见时的栏高——页面代码无需感知白名单，照常消费 chrome.top/
// chrome.bottom 即可。
export function useChromeInsets() {
  const { form } = useForm();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  if (form !== 'phone' || isWatchRoute(pathname) || isSearchRoute(pathname)) {
    return { top: 0, bottom: 0 };
  }
  return {
    top: insets.top + (hasPhoneTopBar(pathname) ? CHROME_TOP_H : 0),
    bottom: insets.bottom + (hasPhoneBottomNav(pathname) ? CHROME_BOTTOM_H : 0),
  };
}
