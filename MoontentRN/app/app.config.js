// ============================================================================
// Expo 应用配置（app.config.js）
// ----------------------------------------------------------------------------
// 本文件存在时 Expo 完全以它为准（app.json 会被忽略，故 app.json 已清空为
// 最小占位，避免两份事实源）。用 JS 而非 JSON 是为了能写中文注释。
// 要点：
// - userInterfaceStyle: 'automatic' —— 允许亮/暗双主题；App 内 ThemeProvider
//   （src/lib/theme-context.jsx）再按用户三态偏好经 nativewind 的 colorScheme.set
//   全局覆写，两者不冲突（automatic 只是声明原生层不锁死单一外观）；
// - orientation: 'default' —— 平板/PC 画幅允许横竖自由（看片场景横屏合理），
//   手机端不锁死竖屏由页面自行适配三画幅（src/lib/use-form.js）；
// - web.output: 'static' + bundler metro —— react-native-web 静态导出，
//   expo-router 全路由可导出（npm run export）；
// - plugins 与已装原生模块一一对应（expo-router 路由 / expo-video 播放 /
//   expo-image 图片），新增原生模块时在此登记。
// ============================================================================
export default {
  expo: {
    name: '月幕',
    slug: 'moontentrn',
    version: '0.1.0',
    orientation: 'default',
    icon: './assets/icon.png',
    userInterfaceStyle: 'automatic',
    scheme: 'moontent',
    ios: {
      // 平板全屏运行（配合 orientation: 'default' 支持横屏画幅）
      supportsTablet: true,
      // 禁用 iPad 多窗口（Split View/Slide Over）——开启时方向锁 API 在分屏
      // 态静默失效（expo-screen-orientation 文档明示），播放器全屏锁横/竖屏
      // 依赖它；需重建原生包（prebuild）才生效
      requireFullScreen: true,
      // 包标识（expo prebuild -p ios 生成原生工程所需；动态配置无法自动写入）
      bundleIdentifier: 'com.moontent.app',
      // 放行 iOS ATS：后端基址就是 http://（局域网 Koa / 线上 VPS），默认 ATS 只豁免
      // 局域网（NSAllowsLocalNetworking），公网明文 IP 会被原生层拦截报 fetch failed；
      // 与 android 的 usesCleartextTraffic: true 保持对齐。线上转 HTTPS 后应收回。
      infoPlist: {
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: true,
        },
      },
    },
    android: {
      // 应用包名（expo prebuild -p android 生成原生工程所需；动态配置无法自动写入）
      package: 'com.moontent.app',
      adaptiveIcon: {
        backgroundColor: '#E6F4FE',
        foregroundImage: './assets/android-icon-foreground.png',
        backgroundImage: './assets/android-icon-background.png',
        monochromeImage: './assets/android-icon-monochrome.png',
      },
    },
    web: {
      favicon: './assets/favicon.png',
      bundler: 'metro',
      output: 'static',
    },
    // （历史注）react-native-tdlib 原生模块已随服务端 TDLib → teleproto 引擎
    // 替换一并移除（2026-10）：Telegram 数据面全部经服务端 HTTP API，app 端
    // 无任何直连 Telegram 的路径；本目录 ./modules/ 现无本地原生模块，
    // nativeModulesDir 发现通道为空集，无插件项可配。
    plugins: [
      // asyncRoutes: { web: true } —— web 端路由级代码分割：每条路由懒加载成
      // 独立 chunk（metro 动态 import 在 web 静态导出下为真实分包），首屏 entry
      // 不再背全站 15 个页面与重依赖（hls.js/相册 reanimated 等）。对象形式按
      // 平台取值（CLI 的 getAsyncRoutesFromExpoConfig：asyncRoutes[platform]
      // ?? default），不写 default 即 native 保持同步加载（原生分包无收益且
      // 拖慢启动）；web dev/prod 一致开启，便于本地复现分包行为。
      ['expo-router', { asyncRoutes: { web: true } }],
      'expo-status-bar',
      'expo-video',
      'expo-image',
      // 屏幕方向锁（native 播放器全屏：按视频画幅锁横/竖屏，退出恢复进入前
      // 方向；无 initialOrientation 参数时插件不动 plist）
      'expo-screen-orientation',
      // 允许明文 HTTP：三端 App 的后端基址就是 http:// 局域网地址（真机访问
      // 电脑上的 Koa 服务），Android 9+ 默认禁明文，不开则 release 包所有
      // http 请求直接失败
      [
        'expo-build-properties',
        {
          android: { usesCleartextTraffic: true },
        },
      ],
    ],
  },
};
