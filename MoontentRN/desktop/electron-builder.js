// ============================================================================
// 月幕 MoontentRN 桌面端 —— electron-builder 打包配置
// ----------------------------------------------------------------------------
// - extraResources 把后端（../server，含 node_modules：sharp 等原生依赖随包
//   分发）与前端静态产物（../dist/web）整目录带入安装包 resources/ 下；
//   main.js 已打包路径按 resourcesPath/server 与 resourcesPath/web 解析；
// - icon 复用 app 的 1024x1024 图标（electron-builder 自动转 ico/icns）；
// - 输出目录不在本文件写死：构建时由 cli.js 用
//   --config.directories.output=../dist/win（或 ../dist/macos）覆盖。
// - 前身为 electron-builder.yml；为承载 mac.sign 签名钩子迁移为 JS（yml
//   无法表达函数；且 yml 在 electron-builder 的配置搜索顺序中优先于 js，
//   旧 yml 已删除，避免两份配置并存时 js 被静默忽略）。文件名注意：26.x
//   实际搜索 electron-builder.{yml,yaml,json,json5,toml,js,cjs,ts}，不含
//   文档提及的 electron-builder.config.js 变体，勿改回。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { signAsync } from '@electron/osx-sign';

/**
 * afterPack 装配断言（extraResources 拷贝完成后、签名前对产物做文件级校验）
 * ----------------------------------------------------------------------------
 * 历史事故：electron-builder 的拷贝过滤器（app-builder-lib/out/util/filter.js
 * createFilter）会无条件跳过「拷贝源根层的 node_modules」——extraResources
 * 只拷 ../server 一条时，安装包内 server 没有 node_modules，启动即
 * ERR_MODULE_NOT_FOUND。这类纯打包层问题，仓库态 selftest（走仓库回落路径）
 * 拦不住，只有对着装配出来的产物断言才有效。任一关键文件缺失即抛错，
 * electron-builder 构建失败退出非 0（坏包不入库）。
 * 注意：AfterPackContext 的字段是 appOutDir（含 .app 的输出目录，如
 * mac-arm64/），不是 .app 包本身——mac 需先在目录下找 .app 再进 Resources。
 * @param {{ appOutDir?: string, packagedAppPath?: string, electronPlatformName: string }} context
 */
async function assertPackagedAssembly(context) {
  const appOutDir = context.appOutDir || context.packagedAppPath;
  const isDarwin = context.electronPlatformName === 'darwin';
  let appPath = appOutDir;
  if (isDarwin) {
    const bundle = fs.readdirSync(appOutDir).find((n) => n.endsWith('.app'));
    if (!bundle) throw new Error(`afterPack 断言失败：${appOutDir} 下未找到 .app`);
    appPath = path.join(appOutDir, bundle);
  }
  const resourcesDir = isDarwin
    ? path.join(appPath, 'Contents', 'Resources')
    : path.join(appPath, 'resources');
  const missing = [];
  const mustExist = (rel) => {
    if (!fs.existsSync(path.join(resourcesDir, rel))) missing.push(rel);
  };

  // —— server 骨架与运行时依赖（node_modules 关键包点名断言；teleproto 纯
  //    JS MTProto 引擎，无原生平台二进制——TDLib/koffi 已随引擎替换移除） ——
  mustExist('server/src/index.js');
  mustExist('server/package.json');
  const SERVER_PKGS = ['dotenv', 'koa', '@koa/cors', 'koa-bodyparser',
    'koa-compress', 'koa-static', 'sharp', 'teleproto', 'qrcode'];
  for (const pkg of SERVER_PKGS) {
    mustExist(path.join('server', 'node_modules', pkg));
  }

  // —— 前端产物：index.html 必须在且是应用挂载壳（与桌面端 backendUsable /
  //    selftest 的 id="root" 口径一致） ——
  const webIndex = path.join(resourcesDir, 'web', 'index.html');
  let shellOk = false;
  try {
    shellOk = fs.readFileSync(webIndex, 'utf8').includes('id="root"');
  } catch { /* 缺文件并入 missing */ }
  if (!shellOk) missing.push('web/index.html（缺失或不含 id="root"）');

  if (missing.length) {
    throw new Error(`安装包装配不完整（afterPack 断言失败）：\n  - ${missing.join('\n  - ')}`);
  }
  console.log('[afterPack] 装配断言通过：server（含 node_modules 关键包）+ web 产物齐备');
}

export default {
  appId: 'com.moontent.desktop',
  productName: '月幕',
  asar: true,
  icon: '../app/assets/icon.png',

  // Windows：安装版（NSIS）+ 免安装单文件（portable）
  win: {
    target: ['nsis', 'portable'],
  },

  // macOS：dmg 磁盘映像
  mac: {
    target: ['dmg'],
    // —— 签名钩子：规避 electron-builder 26.15.3 的同名证书 ambiguous 回归 ——
    // 默认签名路径（macPackager.doSign）会把 buildSignOptions 中已解析好的
    // SHA-1 哈希身份覆盖回“证书显示名”，且 identityValidation:false 直传
    // codesign；一旦钥匙串存在两张同名同有效的证书（如重复签发的 Apple
    // Development），codesign 按名解析身份即报 ambiguous 使构建失败。
    // custom sign 收到的 opts.identity 恰是解析好的哈希（ad-hoc 时为 "-"），
    // 原样转发 osx-sign 即按哈希签名——与默认行为仅差身份的指定方式。
    // 依赖解析：@electron/osx-sign 是 app-builder-lib 自身的签名内核（锁文件
    // 内既有，随其安装），这里与 electron-builder 用的是同一份模块。
    // 重试：默认 sign() 外层的 retry(3, interval 5s, backoff 5s) 必须复刻——
    // 逐文件 --timestamp 要访问 Apple 时间戳服务器，海量小资源文件签名时
    // 会被间歇性限流/断连（"The timestamp service is not available"）。
    async sign(opts) {
      const RETRIES = 3;
      for (let attempt = 0; ; attempt++) {
        try {
          return await signAsync(opts);
        } catch (err) {
          if (attempt >= RETRIES) throw err;
          await new Promise((resolve) => setTimeout(resolve, 5000 + 5000 * attempt));
        }
      }
    },
  },

  // 整目录带入：server（后端工程）与 dist/web（expo 静态导出产物）。
  // 注意：electron-builder 的拷贝过滤器（app-builder-lib/out/util/filter.js
  // createFilter）会无条件跳过「拷贝源根层的 node_modules」目录——所以单靠
  // ../server 一条只会带入 src/scripts/vendor/package*.json（曾导致安装包内
  // 缺依赖、启动即 ERR_MODULE_NOT_FOUND）。node_modules 必须单独作为拷贝根
  // 再带一份；server 无 devDependencies，整目录即全部运行时依赖（sharp 等
  // 平台二进制与 teleproto（纯 JS MTProto）随包分发）。
  extraResources: [
    { from: '../server', to: 'server' },
    { from: '../server/node_modules', to: 'server/node_modules' },
    { from: '../dist/web', to: 'web' },
  ],

  // 装配完整性断言（见上方 assertPackagedAssembly）：拦截 node_modules /
  // web 产物未进包这类打包层事故，坏包直接构建失败
  afterPack: assertPackagedAssembly,
};
