// ============================================================================
// ScreenScrollView.jsx —— 非沉浸页主滚动容器的标准基元
// ----------------------------------------------------------------------------
// 手机画幅下顶/底栏是 AppShell 的悬浮 overlay（内容从栏底下滚过），滚动内容
// 必须自垫「安全区 + 栏高」避让（口径见 use-chrome-scroll 头注）。ScrollView
// 类页面一律用本组件代替裸 ScrollView，内部自动合并 chrome insets——页面只
// 传自己的呼吸间距 topGap/bottomGap，禁止再手写 `16 + chromeInsets.top` 这类
// 算术（漏写就是「顶部被顶栏盖住」的回归，plugins/board 等页的历史病灶）。
// pad/PC（栏在流内）与沉浸页（video/search，chromeInsets 恒 0）自动零垫高。
// FlashList 网格页不用本组件，在 ListHeaderComponent/contentContainerStyle
// 手动加 useChromeInsets() 的值（网格结构无法整体包装）。
// 其余 props（onScroll/keyboardShouldPersistTaps/...）原样透传 ScrollView；
// contentContainerStyle 以数组后置合并，页面同名键可覆盖。
// ============================================================================
import { ScrollView } from 'react-native';
import { useChromeInsets } from '../../hooks/use-chrome-scroll.js';

export default function ScreenScrollView({
  topGap = 12, // 栏下呼吸间距（叠加在 chrome insets 之上）
  bottomGap = 16,
  contentContainerStyle,
  ...rest
}) {
  const chrome = useChromeInsets();
  return (
    <ScrollView
      {...rest}
      contentContainerStyle={[
        { paddingTop: topGap + chrome.top, paddingBottom: bottomGap + chrome.bottom },
        contentContainerStyle,
      ]}
    />
  );
}
