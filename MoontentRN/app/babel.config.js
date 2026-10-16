// babel 配置：NativeWind v4 官方指南要求——
// - babel-preset-expo 的 jsxImportSource 指向 nativewind（className 支持）
// - 追加 nativewind/babel 预设
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
  };
};
