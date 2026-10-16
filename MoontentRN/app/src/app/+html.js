// ============================================================================
// +html.js —— expo-router 自定义根 HTML 文档（web 专属；native 不参与构建）
// ----------------------------------------------------------------------------
// 唯一职责：注入 <meta name="referrer" content="no-referrer">。
// 动机：bf / 91pron 系上游的 ts 切片 CDN 按 Referer 拦截（带任何页面的
// Referer 一律 403，裸请求 200），浏览器同源页面发跨源 XHR 时会自动携带
// 本页 Referer，hls.js 直连拉切片即被拒。全局 no-referrer 后：
//   - 切片/密钥 XHR 不再带 Referer → 上游放行（Origin 实测不受影响）；
//   - 本站 /api 与图片代理不校验 Referer，零影响。
// 其余结构严格照抄 expo-router 默认根文档（children 即根渲染点，静态导出
// 的 HTML 依赖该结构做 SSG 与水合，勿改层级）。
// 追加职责：注入桌面壳拖拽区全局 CSS。Electron 无边框窗口（desktop/main.js
// frame:false）的移动/双击最大化依赖 -webkit-app-region——react-native-web
// 样式白名单不含该属性，故以全局类提供，由自绘标题栏（TopBar / 播放窗外壳）
// 通过 className 挂到对应元素上。普通浏览器忽略该属性，零副作用。
// ============================================================================
import { ScrollViewStyleReset } from 'expo-router/html';

// -webkit-app-region 仅 Chromium（Electron）认识；drag 区内可交互元素必须
// 显式 no-drag 才能正常点击/输入
const DESKTOP_REGION_CSS = '.app-drag{-webkit-app-region:drag}.app-nodrag{-webkit-app-region:no-drag}';

export default function Root({ children }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        {/* 关键：全站请求不发 Referer（上游切片 CDN 按 Referer 拦截） */}
        <meta name="referrer" content="no-referrer" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        <ScrollViewStyleReset />
        {/* 桌面壳无边框窗口拖拽区（见文件头说明；浏览器端无效不生效） */}
        <style dangerouslySetInnerHTML={{ __html: DESKTOP_REGION_CSS }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
