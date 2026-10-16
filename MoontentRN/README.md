# 月幕 MoontentRN

> 多源插件化纯净视频站的三端重制版：Expo React Native（iOS / Android / Web）+ Koa 后端。
> 无账号、无积分、无收藏点赞，只保留视频本身。**仅供站方授权测试使用。**

## 定位（与 NextWeb 的关系）

本工程是前代 Next.js 网页版（NextWeb，已移出本仓库）的**对等重制**：界面规格、插件化接口架构、
归一化数据契约、错误契约与本地数据语义全部与 NextWeb 对齐，差异只在客户端技术栈——

| | NextWeb | MoontentRN |
| --- | --- | --- |
| 前端 | Next.js 14 App Router（纯网页） | Expo（expo-router 文件路由）+ React Native + NativeWind v4（Tailwind 语法），`react-native-web` 支撑 Web 端 |
| 后端 | Next.js API Route 包装层 | **独立 Koa 服务**（`server/`，默认 3001 端口），接口与 NextWeb 完全一致 |
| 播放器 | Artplayer + hls.js | 原生端 `expo-video`（系统播放器，AES-128 由系统解密）；Web 端 hls.js + 原生 `<video>`（`VideoPlayer.js` / `VideoPlayer.web.js` metro 平台分流，对外 props 完全一致） |
| 本地存储 | localStorage | AsyncStorage（键语义一致，见「本地数据边界」） |
| 网络层 | 同源相对路径 `/api/...` | 三端 App 无同源概念：`src/lib/api-base.js` 管基址（默认 `http://localhost:3001`，可在「我的 → 设置 → 服务器地址」改），`src/lib/client.js` 统一拼绝对 URL 并把响应内的 `cover` 等相对地址**深遍历绝对化**（`absolutizeUrl`）后再喂给图片/播放组件 |

API 契约（与 NextWeb 逐字一致）：

- `GET /api/sites` → 站点清单裸数组 `[{id,name,capabilities,group}]`（`group: main` 主站 / `cms` 资源站，`zy_` 前缀 id 为资源站群）；
- `GET /api/{site}/{method}` → 归一化 JSON（方法集与数据形状 `VideoItem/ListResult/Detail/resolvePlay...` 详见插件基类 `server/src/plugins/base.js` 文件头）；
- 错误统一 `{__err:1,message}` + 502。

界面按 **YouTube 桌面版 + 移动版还原**（品牌红 `#f00`、交互蓝 `#065fd4`/`#3ea6ff`、深底 `#0f0f0f`/浅底 `#fff`、面板 `#272727`/`#f2f2f2`，无描边扁平；chip 32px 高 8px 圆角、按钮胶囊 40 高圆角 20、功能图标 24px、角标 12px 等详规见 `app/src/theme/tokens.js` 与各组件实现）。播放器 chrome 例外——整体去红口径：进度条/在用倍速档/激活图标/开关一律白色系，红仅保留错误语义（`#f00`）。三画幅断点：宽 <768 手机（底部四槽导航、单列卡）、768–1279 平板（迷你轨 72px）、≥1280 PC（导视侧栏 240px 可折叠）。

## 目录结构

```
MoontentRN/
├─ README.md                     # 本文件
├─ app/                          # Expo 前端工程（纯 JS，expo-router 路由目录 src/app/）
│  ├─ app.config.js              # Expo 配置（唯一事实源；web.output:'static' 静态导出）
│  ├─ babel.config.js / metro.config.js / tailwind.config.js（NativeWind v4）
│  ├─ scripts/syntax-check.mjs   # 语法自查：babel 全量转译 src/，任一失败 exit 1
│  └─ src/
│     ├─ app/                    # 路由（文件即页面）：index 首页 / category 分类 /
│     │                          # search 搜索 / zones 专区 / albums+album 相册 /
│     │                          # video/[site]/[id] 观看页 / package 量贩·合集整包 /
│     │                          # author 作者页 / mine 我的 / _layout 根布局
│     ├─ components/             # layout(AppShell/TopBar/Guide/BottomNav…) / video /
│     │                          # album / zones / home / mine / player / ui(基础原语)
│     ├─ hooks/                  # use-infinite-list / use-boards / use-grid-columns /
│     │                          # use-playback-progress / use-hover-preview
│     ├─ lib/                    # client(API 客户端+绝对化) / api-base(后端基址) /
│     │                          # site-context / theme-context / player-context(跨页不断流) /
│     │                          # settings / history / play-queue / theater-store…
│     └─ theme/                  # 语义 token（YouTube 亮/暗双主题）
└─ server/                       # Koa 后端工程（接口与 NextWeb 完全一致）
   ├─ src/index.js               # createApp(options)：中间件+路由+可选静态托管；
   │                             # 直接运行即在 3001 起 HTTP 服务
   ├─ src/routes/                # sites(清单) / site-method(统一分发) / img(图片代理) /
   │                             # telegram(账号站源专属端点)
   ├─ src/plugins/               # ★ 站点插件层：base / registry / yuese / avjb / aidou /
   │                             # hanxiucao / zimuquan / dsd / bf / llw / p91 /
   │                             # telegram/(账号站源) / cms/(资源站群)
   ├─ scripts/                   # boot-check(启动自检) / check-plugins(插件契约) /
   │                             # smoke(全站冒烟) / serve-check(静态托管验收)
   └─ .env.example               # 环境变量样例（上游入口/网关/会员态）
```

## 本地开发

后端（Koa，默认 3001）：

```bash
cd MoontentRN/server
npm install
cp .env.example .env       # Windows: copy .env.example .env（可选，均有内置默认）
npm start                  # http://localhost:3001
```

前端（Expo dev server）：

```bash
cd MoontentRN/app
npm install
npx expo start             # 交互式：按 w 开浏览器（Web 端）
```

开发自检脚本：

| 脚本 | 用途 |
| --- | --- |
| `node server/scripts/boot-check.mjs` | 起服务断言 `GET /api/sites` 200 |
| `node server/scripts/check-plugins.mjs` | 插件契约自检（不触网） |
| `node server/scripts/smoke.mjs all` | 全站冒烟（9 主站 + zy 资源站抽样，上游真实请求） |
| `node server/scripts/serve-check.mjs` | 静态托管验收（见「生产部署」） |
| `npm --prefix MoontentRN/app run syntax-check` | app 侧语法自查（babel 全量转译 src/） |
| `npm --prefix MoontentRN/app run gen:icons` | 重新生成图标桶（见下「图标体系」） |

图标体系（2026-10 自 lucide-react-native 迁移至 **Iconify（Solar 集）**）：全站统一
Solar 线性变体（1.5px 圆头描边），选型按 UI 功能逐点挑选、导出名语义化（如 `Retry`/
`Playlist`/`WallAdd`），同一功能多处共用一个导出；成对状态用同形线性/填充对照（如
`WallAdd`↔`WallAdded`、`Pin`↔`PinSolid`，填充=已激活；导航 Tab 激活态同款——`Home`↔`HomeSolid` 等 7 对，经 layout/TabIcon.jsx 交叉淡切+弹跳切换）。**改图标/加图标**：改
`app/icons.config.mjs`（每条带功能注释的单一事实源）后在 app/ 下跑 `npm run gen:icons`
重新生成 `src/components/icons.js`（生成物勿手改；生成器对不存在的图标名/不支持的
SVG 元素直接报错）。链路：`@iconify-json/solar`（devDep，离线数据）→
`scripts/gen-icons.mjs` 编译为 react-native-svg 元素树 → 桶内共享 `createIcon` 工厂
（props 与 lucide 习惯对齐：`size`/`color`/`strokeWidth`/`fill`/`opacity`）。Metro 不做
tree-shaking，桶只含配置里实际选用的图标数据（63 枚 ≈ 54KB 源码），无任何运行时图标
库依赖、不触网。HoverPreviewLayer.web.js 因「全原生 DOM 门户树」架构约束例外内联了
Solar 音量图标路径（与桶同源）。

样式约定：覆盖层/占位层的「绝对铺满」统一展开 `app/src/lib/abs-fill.js` 的 `ABS_FILL`，
**不要写 `...StyleSheet.absoluteFillObject`**——RN 0.86 已删除该键，展开得 `undefined`：
position/top/left/right/bottom 全丢、元素退回普通流（覆盖层塌成内容高一条带；曾表现为
「解析播放地址中的遮罩没盖住播放器」与「舞台内层不铺满 → 黑屏有声」）。react-native-web
的 `StyleSheet.absoluteFill` 是编译后样式对象（`{...}` 展开得到类名映射）不能反用——两端
自带常量都不能跨端，故自持。

## 三端运行指引

Web、iOS、Android 三端共用一套代码，`npx expo start` 起来后：

- **Web**：dev 交互界面按 `w`（或直接 `npm run web`），浏览器打开 Expo dev server 地址。
- **iOS / Android 真机**：手机安装 **Expo Go** App（App Store / Google Play），与电脑同一局域网，扫描终端里的二维码即可加载。**关键一步**：真机上 `localhost` 指手机自己——进 App 的「我的 → 设置 → 服务器地址」改为 `http://<电脑局域网IP>:3001`（如 `http://192.168.1.100:3001`），保存即生效（内存基址立即切换并重拉站点清单，无需重启 App）。
- 局域网连不上时先确认电脑防火墙放行 3001 端口。

## 生产部署（expo export 后由 server 单服务托管）

前端静态导出，后端 Koa 一并托管，**单服务、单端口**对外：

```bash
cd MoontentRN/app
npm run export              # expo export --platform web → 产出 app/dist/
cd ../server
SERVE_DIST=../app/dist npm start   # Windows(cmd): set SERVE_DIST=..\app\dist && npm start
```

`createApp` 读取 `SERVE_DIST`（相对 server 根或绝对路径）挂 `koa-static` 托管前端产物，
`GET /` 直接回 `dist/index.html`（应用根挂载点 `<div id="root">`），API 与静态资源同源同端口。
可用 `PORT` 环境变量改端口（默认 3001）。

部署验收：`node server/scripts/serve-check.mjs` —— 以 `SERVE_DIST=../app/dist` 起服务，
断言 `GET /` 200 且 HTML 含根挂载点、`GET /api/sites` 200，两项全过打印 OK。

## 桌面端与 CLI

除浏览器与三端原生流程外，本工程另附 **Electron 桌面壳**（`desktop/`）与**统一入口
CLI**（`MoontentRN/cli.js`，纯 Node 零第三方依赖、内部路径基于自身位置解析，直接
`node cli.js` 运行），把本地运行、构建与打包收敛为一套命令。

### Electron 桌面架构

- 主进程（`desktop/main.js`）**内嵌 Koa 后端**（动态 `import server/src/index.js` 的
  `createApp({ distDir: webDist })`）并**托管 web 静态产物**（expo export 输出），
  随后窗口直接加载 `http://127.0.0.1:3001` —— API 与页面同源同端口，单进程组。
- 端口首选 3001；生产模式 **listen 之前先主动探测** `http://127.0.0.1:3001/api/sites`，
  可达则直接复用已在跑的服务（Windows 上外部进程绑 `0.0.0.0:3001` 时本进程仍能
  成功绑 `127.0.0.1:3001`，EADDRINUSE 不会触发，故复用判定不依赖 listen 报错）；
  探测不可复用且 3001 确被占（EADDRINUSE 兜底）时换空闲端口并在加载 URL 追加
  `?api=<实际后端基址>` —— web 端 `src/lib/api-base.js` 模块加载时读取该参数作为
  初始基址（`typeof window` 守卫，原生三端与无参数的 web 行为完全不变）。
- web 产物路径解析：已打包从 `process.resourcesPath` 读取随安装包带入的
  `server/` 与 `web/` 整目录（electron-builder extraResources）；未打包依次回落
  `desktop/../dist/web` → `desktop/../app/dist`。
- `--dev` 模式不内嵌起服务，直接加载 Expo web dev server `http://localhost:8081`
  （前端 8081 与后端 3001 均由 cli 预先拉起）；`--selftest` 模式不建窗口，走生产
  装配自检（断言 `GET /` HTML 含 `id="root"` 且 `GET /api/sites` 返回非空 JSON 数组），
  全过打印 `[desktop-selftest] OK` 退出 0，任一失败打印原因退出 1。
- 窗口 1440×900（最小 960×640）、`autoHideMenuBar`、背景色 `#0f0f0f` 与应用深色
  主题一致；请求单实例锁；退出时关闭内嵌服务。
- **菜单独立子窗**（`moontent:menu-*`，腾讯视频形态）：播放器的倍速/音量/设置
  弹层在桌面壳浮出为无边框透明置顶小窗（`/menu?win=menu` 深链，内容根
  `MenuWindowRoot` 复用 PlayerPopup 弹层语言），锚在触发钮屏幕坐标旁——不受
  播放器表面 `overflow:hidden` 裁剪，小窗播放（520×300）下长菜单也放得下。
  每 owner 窗一个会话、惰性创建常驻隐藏复用（PlayerControls 挂载即预热）；
  指针在「控制条 ↔ 菜单窗」间穿行有 450ms 宽限、移到别处到点即收，选档/点
  空白/owner 移动缩放立即收；选择动作经主进程回流 owner 窗落地（单一漏斗）。
  macOS 全屏（fullscreen 空间不允许他窗悬浮）与浏览器/原生端回落窗口内弹层，
  两形态外观/行为一致（悬停即开、移出宽限收、音量横条带百分比）。

### cli.js 用法

交互菜单：不带参数直接运行进入（无参数且 stdout 非 TTY——重定向/管道场景——只打印
帮助退出码 1，不进菜单）；cli 退出（含 Ctrl-C）会清理它拉起的全部子进程。

```bash
node MoontentRN/cli.js
```

非交互用法（自动化/CI 首选；`list` 打印本机受支持的运行/打包目标清单后退出码 0，
不出现本机不支持的目标；未知目标打印帮助退出码 1）：

| 命令 | 说明 |
| --- | --- |
| `node cli.js list` | 打印本机受支持的运行/打包目标清单 |
| `node cli.js run android` | 3001 未起则后台自动起后端 + Expo dev server；额外打印局域网 IP 与「我的 → 设置 → 服务器地址」改址指引（真机上 `localhost` 不是电脑） |
| `node cli.js run web` | 前台 expo web dev（不自动开浏览器）；后端同样未起自动后台拉起 |
| `node cli.js run ios` | 后台自动拉起后端 + Metro（`--dev-client`，注入局域网 `EXPO_PUBLIC_API_BASE`）→ 就绪后带 Metro 地址自动拉起手机上的 debug 包 → 前台等待（Ctrl-C 退出）；配合 `build ios --debug` 使用（仅 mac 宿主机） |
| `node cli.js run desktop` | 后台起后端与 expo web dev（8081、等端口就绪），前台启动桌面壳 `electron . --dev`（mac/Windows 宿主机同链路：Electron 随本机平台运行，原 `run win` / `run macos` 已合并为此目标） |
| `node cli.js build web` | `expo export --platform web` → `dist/web/` |
| `node cli.js build android` | 先检测 JDK/Android SDK（见下），`expo prebuild -p android` + gradle assembleRelease（release 缺失回落 assembleDebug），拷贝 apk → `dist/android/` 并打印路径 |
| `node cli.js build win` | dist/web 缺失先自动 build web、desktop 依赖缺失先自动安装，`electron-builder --win nsis portable` → `dist/win/`（结束校验含 .exe） |
| `node cli.js build macos` | `electron-builder --mac dmg` → `dist/macos/`（仅 mac 宿主机） |
| `node cli.js build ios` | 完整真机链路（仅 mac 宿主机）：prebuild（已有且不落后于 `app.config.js`/依赖则跳过，`--fresh` 无条件强制）→ pod install（Pods 与 Podfile 同步则跳过）→ xcodebuild 自动签名（团队从 Xcode 已登录账号探测，`IOS_TEAM_ID` 覆盖）→ `devicectl` 安装到已配对真机并拉起。`--release`（默认）演示包：JS 内嵌独立运行、API 内联为 `deploy.config.json` 部署服务器（`--api <url>` 覆盖），出门演示无需电脑；`--debug` 调试包：配合 `run ios` 的 Metro 热更新，API 指向本机局域网后端。`IOS_DEVICE` 按名称/id 选真机、`POD_BIN` 指定 pod 路径 |
| `node cli.js build all` | 按本机受支持目标顺序构建，单项失败不中断，最后打印汇总表 |
| `node cli.js deploy server` | 后端发布到服务器：打包 server 源码（不含 node_modules，sharp 等平台二进制在服务器上 `npm ci` 安装）→ scp 上传 → systemd 常驻 + 健康检查（`/api/sites`）+ 失败自动回滚（见「服务器部署」） |
| `node cli.js deploy web` | web 站点发布：先自动 `expo export` 构建最新静态产物 → 打包上传到远端 `web/` 目录 → 重启服务并由后端单服务托管 → 探活首页含根挂载点 + `/api/sites` |
| `node cli.js install android` | 把 `dist/android/` 下最新 APK 经 adb 装到已连接安卓真机（`install -r` 保留应用数据，装完自动拉起 App，`--no-launch` 跳过）。adb 自动定位（`ADB_BIN`/`ANDROID_HOME`/平台默认 SDK 路径/PATH）；只剩未授权设备时轮询等待手机确认授权弹窗；多设备用 `ANDROID_DEVICE=<序列号>` 指定。iOS 无需此命令：`build ios` 已装机拉起 |
| `--quiet`（build/deploy/install 可选） | 子进程输出仅缓存、结束时只打印最后 200 行（自动化调用用） |

产物目录约定（cli.js 统一构建输出根，已被 `.gitignore` 忽略）：

```
MoontentRN/dist/
├─ web/       # expo export 静态产物（build win / macos 的输入）
├─ android/   # apk 构建产物
├─ win/       # Windows 产物（.exe：nsis 安装包 + portable）
├─ macos/     # macOS 产物（.dmg）
└─ ios/       # iOS 产物目录说明：build ios 直接装真机不落 dist，.app 保留在
              #   app/ios/build/Build/Products/{Debug,Release}-iphoneos/
```

### 服务器部署（deploy server / deploy web）

部署目标机与凭据写在 `MoontentRN/deploy.config.json`（模板 `deploy.config.example.json`，
含明文密码、已入 `.gitignore`；`DEPLOY_HOST/DEPLOY_USER/DEPLOY_PASSWORD` 等环境变量可覆盖）。
两个字段约定远端布局：`remoteDir`（默认 `/opt/moontent`）下分 `server/`（后端）与
`web/`（静态产物）；`appName`（默认 `moontent`）为 systemd 服务名，`appPort`（默认
3001）为对外端口，`nodeVer` 为服务器无 Node 时自动安装的版本。

```bash
node cli.js deploy server   # 单独部署后端（首次自动装 Node + 生产依赖，systemd 守护）
node cli.js deploy web      # 部署 web 站点（总是重新 expo export，随后端单服务托管）
```

- 免交互密码沿用 SSH_ASKPASS 方案（要求 OpenSSH ≥ 8.4；Windows 优先用 Git 自带
  的 ssh/scp，macOS/Linux 用系统的即可），无第三方依赖；
- 两个命令均幂等：旧版本先备份为 `server.bak` / `web.bak`，健康检查不过自动回滚，
  故障版本保留在 `server.rollback-keep` / `web.rollback-keep` 供排查；
- 部署顺序：先 `deploy server` 再 `deploy web`（web 产物由后端 koa-static 托管，
  服务未部署时 web 只就位不生效，脚本会提示）；
- 部署完成后的访问形态：`http://<服务器IP>:<appPort>/` 即 web 站点，`/api/*` 为
  API；App 真机在「我的 → 设置 → 服务器地址」填同一地址。服务器侧运维：
  `systemctl status|restart moontent`、日志 `journalctl -u moontent -f`；
- 插件级环境变量（`HXC_TOKEN`、`ZMQ_COOKIE` 等，见下表）如需在生产生效，在本地
  `server/.env` 写好后随 `deploy server` 一并上传。

### 环境前置

- **桌面打包**：`desktop/` 的 Electron / electron-builder 依赖由 cli 在打包前自动
  安装（无需手动 `npm install`）；`desktop/node_modules` 不入库。
- **Android 本地打包**：需 JDK 17+（`JAVA_HOME`）与 Android SDK（`ANDROID_HOME` /
  `ANDROID_SDK_ROOT`，或已有 `app/android/local.properties`）；缺失时 cli 只打印
  安装指引并以退出码 2 结束，不触发构建。
- **iOS / macOS 目标仅 mac 宿主机提供**（依赖 Xcode 与 macOS 工具链）；Windows
  宿主机上 cli 的菜单/list 不显示相关目标，也不接受相关命令参数。

## 国内加速说明（本机已配置，2026-10-07）

本机（Windows 网吧环境）直连 Google/Maven Central/Gradle 官方源极慢且易断，
已按下述三层全部切换国内镜像；**新增项目 / 重装环境照此办理**：

| 层 | 配置 | 位置 / 生效范围 |
| --- | --- | --- |
| 全局 | Gradle 仓库阿里云镜像（google/public/gradle-plugin 三仓，追加在项目仓库之后兜底） | `~/.gradle/init.gradle`，本机所有 Gradle 构建 |
| 全局 | npm 镜像 | `npm config set registry https://registry.npmmirror.com` |
| 全局 | 环境变量（用户级已 setx） | `JAVA_HOME=C:\Users\Administrator\AppData\Local\Java\jdk-17`（微软 OpenJDK 17 zip 免安装版）；`ANDROID_HOME`=`ANDROID_SDK_ROOT`=`%LOCALAPPDATA%\Android\Sdk`；JDK/Gradle/SDK platform-tools 已入用户 PATH |
| 工程 | cli.js 提速补丁（幂等，`build android` 自动应用，文件带 `moontent-fast-build` 标记） | 见下「cli 打包提速」 |
| 一次性 | SDK/NDK 大件走腾讯 `AndroidSDK` 镜像 | https://mirrors.cloud.tencent.com/AndroidSDK/ （实测 ~5MB/s，官方 dl.google.com 波动在 KB/s 级） |

**cli 打包提速**（`node cli.js build android`，均已内置于 cli.js）：

- android/ 工程已存在**且不落后于 app 配置**时跳过 expo prebuild（每次省数十秒）；
  prebuild 自身加 `--no-install` 跳过包安装。「落后」以 mtime 实测判定：
  `app.config.js` / `app.json` / `package.json` / `package-lock.json` 之一新于原生
  工程关键生成物（ios/Podfile、android 主 AndroidManifest.xml）即自动补跑
  prebuild；`--fresh` 仍可无条件强制。**这条防线是必需的**：prebuild 是唯一把
  `app.config.js` 的原生配置（iOS ATS 明文放行、Android `usesCleartextTraffic`
  等）写进 native 工程的环节，跳过它会静默产出「配置陈旧」的包——release 演示包
  的 API 是公网明文 http://，ATS 未放行时请求被系统原生层拦下，JS 侧只看到
  `fetch failed`（栈顶落在 expo-modules-core 的 `Promise.swift`），表象离病因很远
  （2026-10-08 实案：ios/ 是旧模板产物且被 expo 判为 malformed，prebuild 顺手清空
  重建后才带上 ATS 放行）。配套两点：prebuild 改写 Podfile 后 Podfile.lock 即
  过期，此时自动补 `pod install`（命令在 ios/ 目录内执行——本机 CocoaPods 1.17
  只认 `--project-directory=<dir>` 等号形式，空格分隔报 Unknown option）；
  `--no-install` 下 prebuild 只产 .xcodeproj，`.xcworkspace` 由 pod install 生成，
  故「找 .xcworkspace」必须排在 pod install 之后——旧代码顺序反了，会在 prebuild
  成功后静默返回失败（已修）；
- gradle wrapper 分发地址自动换腾讯镜像（`mirrors.cloud.tencent.com/gradle/`）；
  注意 properties 里 URL 常为 `https\://` 转义形式，按「整行替换」处理而非精确
  URL 匹配；另 properties 不支持行尾注释（会并进值里导致 404），标记一律独立成行；
- 各 gradle 脚本 `google()`/`mavenCentral()` 前插阿里云镜像（官方源保留兜底）；
- gradle.properties：jvmargs 扩 4g + `org.gradle.parallel` + `org.gradle.caching`；
  模板文件末行常无换行符，追加前必须先补 `\n`（否则新属性粘进上一行值里）；
- ABI 收敛 `reactNativeArchitectures=x86_64`（本机目标为雷电模拟器 Android 14
  x86_64，跳过全部 ARM 原生编译）。出全架构包改回四架构——注意 reanimated 的
  CMake 在 Windows 的 32 位 ARM（armeabi-v7a）上有「manifest still dirty after
  100 tries」glob 死循环问题，届时优先 arm64-v8a + x86_64 双架构。

**SDK/NDK 手动镜像安装要点**：sdkmanager 本身无镜像参数，小件（platform-tools/
platforms/build-tools）官方直装可忍；大件手动装——NDK r27b（27.1.12297006）zip
解压后目录改名为 `27.1.12297006` 放入 `%ANDROID_HOME%\ndk\`（`source.properties`
的 `Pkg.Revision` 必须与 gradle 要求一致），AGP 见目录存在即不再自动下载。

**本机踩坑记录**：winget 在本机崩溃（0xC0000005），装 JDK/Gradle 一律用 zip
直链免安装版（微软 aka.ms JDK / 腾讯 gradle 镜像）；本仓库工具链 shell 非登录
shell，不 source `.bashrc`/`.bash_profile`，需要环境变量时显式 `source`。

**实测**（2026-10-07）：环境全程 zip 镜像安装（NDK 781MB 腾讯镜像约 4 分钟，
官方渠道一小时级）；首次全量构建约 25 分钟（含全部依赖下载与 C++ 编译）；
二次构建 **1 分 45 秒**（530 任务中 476 个 up-to-date/FROM-CACHE）。


## 环境变量

后端 `server/.env`（复制自 `.env.example`，均有内置默认可整文件省略）。上游站点入口
轮换频繁，失败时按注释里的取证 CLI 查最新地址写入后重启：

| 变量 | 说明 |
| --- | --- |
| `YS_API_TARGET` | 月色插件上游（留空走发布页 yuese04/05/06.cc 自动解析；查址 `node ../Nodejs/yuese.js`） |
| `AVJB_BASE` | 艾薇社区入口域（默认 `https://avjb.cc`，同壳同源可替换） |
| `AIDOU_BASE` | 爱豆插件基址（留空走发布页 w1/w2/w3.aido1.cc 自动解析） |
| `HXC_GATEWAY` | 含羞草插件网关（留空用内置双网关，轮换后在此指定） |
| `HXC_TOKEN` | 含羞草登录态 token（可选，VIP 专享片直读用；游客态留空） |
| `ZMQ_BASE` | 字母圈入口域（默认 `https://www2.zimuquan16.com`，站群同壳同库可替换） |
| `ZMQ_COOKIE` | 字母圈会员态 Cookie 头（可选，VIP/金币片真实播放用；游客态留空） |
| `DSD_BASE` | 懂色帝入口域（留空走发布页 dsd.name → /go1~/go3 自动解析） |
| `BF_BASE` | bf 插件 API 网关（留空内置候选自动 ping 优选，轮换后在此指定） |
| `P91_BASE` | 91pron 插件 API 网关（留空内置候选自动 ping 优选；同 bf 协议姊妹站） |
| `LLW_BASE` | 萝莉窝入口域（站内无发布页可解析，入口轮换后在此指定） |
| `ZIYUANZU_URL` | 资源站群（cms/）清单源（留空用资源族默认；清单 12h 自动重拉 + 健康探测剔除丢包站，全离线时回退内置快照） |
| `TELEGRAM_API_ID` | Telegram 应用凭据 id（my.telegram.org「API development tools」申请，与 `TELEGRAM_API_HASH` 成对；详见「Telegram 接入」） |
| `TELEGRAM_API_HASH` | Telegram 应用凭据 hash（与 `TELEGRAM_API_ID` 成对配置，缺一即登录/数据面报中文错误） |
| `TELEGRAM_PROXY` | Telegram 出口 SOCKS5 代理（`socks5://[user:pass@]host:port`，可选；teleproto 全部连接（主会话+媒体多连接）共用该出口，部署机对 Telegram DC 直连受限/限速时设置，留空直连；非法值启动即报中文错误） |
| `TELEGRAM_SESSION` | MTProto 会话串直填（优先于会话文件；等同账号密码，勿入库） |
| `TELEGRAM_SESSION_FILE` | MTProto 会话文件路径覆盖（默认 `server/.telegram-session.json`；Web 端 `/api/telegram/login` 三步流、`/qr` 扫码流或 `node server/scripts/mtproto-login.mjs` 登录生成） |
| `TG_MEDIA_SESSIONS` | 视频/媒体下载每 DC 媒体会话数（teleproto downloadPool，默认 16=理论上限 kMaxMediaDcCount；与 `TG_MEDIA_INFLIGHT` 相乘即并发块数，见「Telegram 视频提速」） |
| `TG_MEDIA_INFLIGHT` | 每媒体会话在途请求数（默认 4；16×4=64 并发 512KB 块=在飞预算 32MiB） |
| `TG_MEDIA_CONCURRENCY` | 媒体全局在途 `upload.GetFile` 上限（默认 = `TG_MEDIA_SESSIONS×TG_MEDIA_INFLIGHT`；小内存实例可显式压低） |
| `TG_SHARD_PORTS` | 分片端口数（默认 9，钳 0..9）：主端口外自动再绑 N 个分片端口并经 `/api/sites` 下发 `shardPorts`，浏览器按 origin 独立 6 连接，视频流/图片自动轮询分流；0=关闭（见「Telegram 视频提速」） |
| `TG_STREAM_SLOTS` | 看板并发活跃视频流上限（默认 16 = 看板格子上限即不约束；经 `/api/sites` 的 `streamSlots` 下发，前端挂流前过闸消费） |

> **引擎形态（2026-10）**：Telegram 服务端已从 TDLib 全量切换为 **teleproto**（纯 JS MTProto，`server/src/plugins/telegram-tg/`）——登录（手机号+验证码+2FA 与 **QR 扫码**）、对话/消息/写侧/更新事件/图片与视频字节流全部走**单客户端单会话**（`server/.telegram-session.json`，`TELEGRAM_SESSION`/`TELEGRAM_SESSION_FILE` 复用旧口径）；无原生二进制依赖（koffi/prebuilt-tdlib/vendor 已移除），登录走 Web 端 `/api/telegram/login|verify|password|qr` 或 `node server/scripts/mtproto-login.mjs`。旧 `.tdlib-data/` 登录态无法迁移，替换后需重新登录一次（已有 `.telegram-session.json` 则直接复用）。
| `MYSQL_HOST` | 收藏库 MySQL 主机（默认 `127.0.0.1`；收藏域唯一持久层，库表用 `node server/scripts/init-db.mjs` 幂等初始化） |
| `MYSQL_PORT` | 收藏库 MySQL 端口（默认 `3306`） |
| `MYSQL_USER` | 收藏库 MySQL 账号（默认 `root`） |
| `MYSQL_PASSWORD` | 收藏库 MySQL 密码（默认空；实际值写 `server/.env`，勿在文档/仓库提交明文） |
| `MYSQL_DATABASE` | 收藏库 MySQL 库名（默认 `moontent`，utf8mb4/utf8mb4_unicode_ci，`favorites` 表所在库） |
| `REDIS_HOST` | 收藏热缓存 Redis 主机（默认 `127.0.0.1`；纯加速件，连不上自动静默降级直查 MySQL） |
| `REDIS_PORT` | 收藏热缓存 Redis 端口（默认 `6379`） |
| `REDIS_USERNAME` | 收藏热缓存 Redis 账号（可选，默认无） |
| `REDIS_PASSWORD` | 收藏热缓存 Redis 密码（可选，默认无；实际值写 `server/.env`，勿提交明文） |
| `REDIS_DB` | 收藏热缓存 Redis 库号（默认 `0`） |
| `PORT` | 服务监听端口（默认 3001） |
| `SERVE_DIST` | 前端静态产物目录（生产托管用；见「生产部署」） |

## Telegram 接入

与上游视频站并列的**账号型站源**（站点 id `telegram`，插件 `server/src/plugins/telegram-tg/`——teleproto 纯 JS MTProto 引擎（`engine.js` facade + `tg-client.js` 客户端基座 + auth/dialogs/messages/writes/media/updates/normalize/extras 各域 + `plugin.js` 站点插件）+ 专属端点 `routes/telegram.js` / `routes/telegram-extras.js`，走 MTProto 用户客户端而非站点爬取；无原生二进制依赖）：

- **凭据申请**：到 [my.telegram.org](https://my.telegram.org) →「API development tools」创建应用，得到 `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`，写入 `server/.env` 重启即可。凭据缺失时前端 Telegram 页与数据面都会给出明确中文指引。
- **登录入口**：前端 `/telegram` 页页内三步登录——手机号（含国际区号，发验证码）→ 验证码 → 两步验证密码（未开启 2FA 的账号跳过此步；验证码/密码错误原地重输）；也支持扫码登录与服务端渲染的 QR PNG。登录成功后登录态持久化在 `server/.telegram-session.json`（`TELEGRAM_SESSION_FILE` 可覆盖，亦可 `node server/scripts/mtproto-login.mjs` 命令行登录生成），之后免登录直用，页头可退出登录。
- **能力**：完整聊天 + 视频两层，**聊天页是对话的默认入口**：
  - **对话列表 → 聊天页（默认入口）**：列表（我的收藏恒置顶，可按 群组/频道/收藏 筛选）点击进入即聊天页；消息时间线双向翻页——上滑加载更早、下拉检查新消息；首屏锚定链「深链锚点 → 本地阅读位置 → 服务端已读水位（readInboxMaxId）→ 最新页」，并在锚点上方插「未读消息」分隔线；
  - **消息卡片**：富文本（链接/提及/代码等实体）、照片与相册（点击全屏看图）、视频（点击直通标准观看页，圆形视频留言同口径）、贴纸（动图贴纸也静态展示）、语音/音频、文件、网页预览、投票、位置、联系人、服务消息（建群/置顶/通话等中文映射）、转发头/回复引用/频道署名与浏览量；识别不了的媒体类型灰字占位，不炸整页；
  - **bot 交互按钮**：内联键盘（callback/url/copy/game 四种可点）与回复键盘（快捷回复按钮行，可收起）均渲染可点；
  - **发送文本**：纯文本消息（可指定回复目标），前端乐观插入、失败标记可重发；原文所见即所得（不做 Markdown 改写、不抓链接预览）；
  - **投票**：单选/多选/测验均可参与，投票后原位刷新结果与解析；
  - **已读同步**：读到哪同步到哪（`POST /api/telegram/read`），会话内未读分隔线边界固定、不随阅读推进移动；
  - **阅读位置记忆**：每对话最后阅读到的消息 id 存本机 AsyncStorage（`moontent_tg_read`），再进该对话自动锚回上次位置（详见「本地数据边界」）；
  - **手机竖屏锁**：聊天页在手机端锁定竖屏（聊天阅读形态），平板/桌面不受影响；
  - **视频网格从聊天页进入**：聊天页的视频入口进该对话的视频网格页，卡片点击走标准观看页 `/video/telegram/<id>`，与其它站点同款播放器——倍速、连播、**加入视频墙**等能力一应可用；另有跨对话的全局视频搜索；
  - **不在当前版本**：语音/动画贴纸播放（静态卡占位，点击提示暂不支持）、媒体上传（发送仅限文本）。
- **专属端点**（`routes/telegram.js`，前缀 `/api/telegram/*`，须先于统一分发网关注册）：登录态机 `session` / `login` / `verify` / `password` / `cancel` / `logout`、对话目录 `dialogs`、对话视频 `videos`、视频字节流 `stream` 之外，本次新增聊天域 6 个端点（归一化与游标语义在 `plugins/telegram-tdlib/messages.js`）：
  - `GET /api/telegram/messages?peer=&anchor=&dir=&limit=` → 聊天页双向分页（`dir=around` 定位首屏且附带对话头部 peer / `older` 往旧一页 / `newer` 拉新一页）；
  - `GET /api/telegram/message?peer=&id=` → 单条消息（强制穿透缓存强拉）；
  - `POST /api/telegram/send`，JSON body `{peer,text,replyTo?}` → 发送纯文本，回 `{message}`；
  - `POST /api/telegram/callback`，JSON body `{peer,msgId,data?|game?}` → bot 内联键盘回调，回 `{answer,message}`（bot 回调常编辑原消息，message 供原位刷新）；
  - `POST /api/telegram/vote`，JSON body `{peer,msgId,options}`（base64 选项数组，多选传多个）→ 投票，回 `{message}`；
  - `POST /api/telegram/read`，JSON body `{peer,maxId}` → 已读同步，回 `{ok:true}`。

  POST 端点请求体必须是 JSON 对象（app 级 koa-bodyparser 解析，128KB 上限）；错误契约与统一分发同构（`{__err:1,message}` 中文提示 + 502 兜底，写侧错误码已映射中文）。
- **风控提示**：这是**用户账号自动化**——浏览、发送文本、bot 交互/投票与已读同步都是代替账号调 MTProto 接口（含写接口）。写操作（发送/回调/投票）失败**一律不自动重试**（防请求风暴），常见错误已映射中文提示（慢速模式约 N 秒/无权限/超 4096 字等），请按提示等待或换对话再试；**测试发送建议在「我的收藏」里进行**（只写给自己，不扰他人）。请遵守 Telegram 限流：遇 `FLOOD_WAIT` 服务端会转成中文提示（约 N 秒后再试）且不自动重试，请如实等待，勿高频刷新压测。
- **诊断 CLI**：链路异常时跑 `node Nodejs/telegram.js`（login/me/dialogs/videos/dl/thumb 子命令，会话独立于服务端；注意 MTProto 同一 auth key 双端并发在线可能互踢，诊断前先停服务端）。

### Telegram 视频提速（可选）

TG 看板/播放拉视频卡顿时的提速手段（服务端分片默认即开，补丁版需手动启用；字段缺失/不启用时全部回落现有单基址行为，零变化）：

- **MTProto 多连接视频字节源（默认启用）**：视频流走 teleproto MediaScheduler 直连 MTProto 拆块拉取——每 DC `TG_MEDIA_SESSIONS`（默认 16，理论上限）条媒体专用连接 × 每连接 `TG_MEDIA_INFLIGHT`（默认 4）在途 = **64 并发 512KB 块、在飞预算 32MiB**（对齐并超过 patched TDLib 的 Premium 档 8 会话/16MiB；Turrit 类「解除客户端并发封顶」机制的服务端等价物），512KB 块 + 128MB 进程内 LRU 块缓存（满墙 16 路复用、任意 offset 随机访问）+ 消费驱动滑动窗预读 + moov 尾块预取，FLOOD_WAIT 内建等待、file_reference 失效自动重拉恰一次。**风险口径**：仅限站方授权测试账号——Telegram 服务端按账号做软限速，并发档位只是让客户端不再成为瓶颈、不改变服务端配额；实测不满意可 `TG_MEDIA_SESSIONS=8`（或 4）降档。
- **分片端口（自动发现，用户无需改配置）**：HTTP/1.1 浏览器对同一 origin（协议+主机+端口）的并发连接有上限（Chromium 系 6 条），Telegram 长时视频流占满后 `/api/*` 短请求被挤到队尾「饿死」。服务端启动时在主端口外自动再绑 N 个分片端口（`TG_SHARD_PORTS`，默认 9），实际绑定端口经 `GET /api/sites` telegram 条目的 `shardPorts` 下发；前端把视频流（`/api/telegram/stream`）与代理图片（`/api/img`）在池内 origin 间自动轮询分流——播放页主视频走池首（主端口），看板格按格子 key 稳定哈希轮询、封面按 URL 稳定哈希轮询，浏览器对每个 origin 独立计 6 连接，长流不再挤占主端口。看板并发活跃流数另由同条目 `streamSlots`（`TG_STREAM_SLOTS`，默认 16，≥ 格子数即不约束）闸门约束，超额格子 FIFO 排队。`TG_SHARD_PORTS=0` 可显式关闭。
- **部署注意**：`deploy/remote-server.sh` 已按主端口起连续 10 个端口（`APP_PORT`~`APP_PORT+9`，覆盖默认分片段）一条 ufw 范围规则放行，自建防火墙/云安全组需同口径放行；`deploy server` 发布包含 `server/.telegram-session.json`（存在即带）；teleproto 为纯 JS，远端 `npm ci` 即装（无 TDLib 二进制/现场构建步骤）。

## 本地数据边界（AsyncStorage）

观看足迹（`moontent_views`，上限 50，含站点字段）、播放进度（`moontent_progress`，续播用，
上限 200）、搜索历史（`moontent_search_{site}`，上限 10）、Telegram 聊天阅读位置
（`moontent_tg_read`，按对话键记最后阅读到的消息 id，上限 200 对话、按活跃度淘汰，
聊天页重进时据此锚定回上次位置）、自动连播（`moontent_autoplay`）、
省流模式（`moontent_datasaver`）、后端基址（`moontent_server`，'' = 默认
`http://localhost:3001`）——全部存本机 AsyncStorage，不上传、不同步、按站点（或
Telegram 对话）隔离；
主题与基址为全局偏好。键语义对齐 NextWeb 的 localStorage（NextWeb README「本地数据边界」）。

## 已知限制

- **投屏（AirPlay / Google Cast）未纳入本版**：原生端需接入系统投屏框架（iOS
  `AVRoutePickerView` / Android Google Cast SDK），Web 端沿用 NextWeb 的投屏实现也需
  HTTPS 等前置条件，均留待后续版本。
- **PWA / Service Worker 未纳入本版**：Web 端以静态导出 + Koa 托管形态运行，不做
  manifest、离线缓存与「安装为应用」（NextWeb 有完整 PWA 体系，可对照后续移植）。
- **上游入口轮换**：10 个主站插件的入口域/网关轮换频繁，插件内置发布页解析、
  网关 ping 优选、清单重拉等多级自动应对；某单站失败时（NextWeb 同口径）按
  「环境变量」表的取证 CLI 查最新地址写入 `.env` 重启，或等上游恢复——属上游侧变化，
  不是本工程的代码问题。资源站群另有健康探测自动剔除/恢复机制。
- expo-doctor 未安装为工程依赖（`npm run doctor` 需先安装）；依赖体检可用
  `npx expo-doctor`（联网拉取）或维持 `syntax-check` + `export` 构建门禁。
