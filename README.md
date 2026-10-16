# moonPlayer（月幕）

> 多源插件化视频播放器三端套件：Expo React Native（iOS / Android / Web）+ Koa 后端 + Electron 桌面壳，
> 外加根目录的 Tampermonkey 站点解析脚本。界面按 YouTube 桌面版/移动版还原，无账号、无积分，只保留视频本身。

> [!IMPORTANT]
> 本仓库采用**受限许可**（见 [LICENSE](./LICENSE)）：仅限个人学习/调试/研究用途，
> **禁止商业使用，未经书面许可禁止再分发、转载或二次发布**。

## 仓库结构

| 目录 | 说明 |
| --- | --- |
| `MoontentRN/app/` | Expo SDK 57 / React Native 0.86 / React 19 / NativeWind v4 客户端（iOS / Android / Web），expo-router 文件路由 |
| `MoontentRN/server/` | Node >=20 ESM Koa 后端：`src/plugins/` 站点插件层 + `src/routes/` API 分发（默认 3001 端口） |
| `MoontentRN/desktop/` | Electron 壳：内嵌 Koa 后端 + 托管 Expo Web 导出，单端口单进程 |
| `MoontentRN/cli.js` | 统一 run / build / install / deploy 入口 |
| `Nodejs/` | 各站点独立取证 CLI（与 server 插件同源实现，用于排查上游入口轮换） |
| `pnk3n_pentest_tool.user.js` | Tampermonkey 站点解析脚本（授权测试用途，规则见 `AGENTS.md`） |

详细架构、界面规格与部署细节见 [MoontentRN/README.md](./MoontentRN/README.md)。

## 快速开始

三个子包相互独立，各自 `npm ci` 安装（无根 package.json）。

后端（Koa，默认 `http://localhost:3001`）：

```bash
cd MoontentRN/server
npm ci
cp .env.example .env   # 可选，全部环境变量均有内置默认
npm start
```

前端（Expo dev server，按 `w` 开浏览器）：

```bash
cd MoontentRN/app
npm ci
npx expo start
```

一键起「后端 + Expo Web」开发环境（仓库根目录执行）：

```bash
node MoontentRN/cli.js list    # 查看本机支持的目标
node MoontentRN/cli.js run web
```

离线自检（不触网）：

```bash
npm --prefix MoontentRN/app run syntax-check   # app 侧 babel 全量语法检查
node MoontentRN/server/scripts/check-plugins.mjs # 插件契约检查（会重建 .cms-sources.json 缓存）
node MoontentRN/server/scripts/boot-check.mjs    # 起服务断言 /api/sites
```

## 站点源

- **固定站点插件**（`server/src/plugins/`，`registry.js` 注册）：每个插件实现 `base.js` 的
  `SitePlugin` 契约（`list` / `search` / `detail` / `resolvePlay`），统一经
  `GET /api/{site}/{method}` 返回归一化数据，错误统一 502 + `{__err:1,message}`。
  上游入口域轮换频繁，各站支持发布页/网关自动发现，亦可用 `<SITE>_BASE` 等环境变量覆盖
  （完整变量表见 [MoontentRN/README.md](./MoontentRN/README.md)「环境变量」）。
- **CMS 资源站群**（`plugins/cms/`，`zy_*` 前缀 id）：Apple-CMS 采集源清单定时拉取 +
  健康探测剔除坏站，全离线时回退内置快照 `fallback-sources.json`。
- **Telegram 账号源**（`plugins/telegram-tg/`，站点 id `telegram`）：基于 [teleproto](https://www.npmjs.com/package/teleproto)
  纯 JS MTProto 客户端的完整聊天域——手机号/2FA/扫码登录、对话与消息流、发送与 bot 交互、
  已读同步，以及多连接调度的视频/图片字节流。凭据到 [my.telegram.org](https://my.telegram.org)
  申请 `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` 写入 `server/.env`，会话文件
  `server/.telegram-session.json` 等同账号密码，已 gitignore。详见
  [MoontentRN/README.md](./MoontentRN/README.md)「Telegram 接入」。

## 桌面端

Electron 壳把 Koa 后端与 Expo Web 静态导出合并到单一 localhost 端口；渲染进程与主进程
IPC 走 allowlist 的 `preload.cjs` 桥。生产装配自检（需先有 Web 产物）：

```bash
npm --prefix MoontentRN/desktop run selftest
```

## 生产部署

部署目标机与凭据写在 `MoontentRN/deploy.config.json`（**不入库**，从模板
`deploy.config.example.json` 复制填写；`DEPLOY_HOST/DEPLOY_USER/DEPLOY_PASSWORD`
环境变量可覆盖）：

```bash
cp MoontentRN/deploy.config.example.json MoontentRN/deploy.config.json
node MoontentRN/cli.js deploy server   # 后端（自动装 Node + systemd 守护）
node MoontentRN/cli.js deploy web      # web 站点（expo export 后单服务托管）
```

## 许可

见 [LICENSE](./LICENSE)：版权所有 © 2026 Wisher-coder。仅限个人学习、调试与研究用途；
禁止商业使用；未经书面许可禁止再分发、转载、镜像或二次发布。
