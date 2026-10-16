// metro 配置：以 Expo 默认配置为底，套 NativeWind v4 的 withNativeWind，
// 将 global.css 注入打包管线（className 构建期编译为原生样式）。
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

module.exports = withNativeWind(config, { input: './src/global.css' });
