// ============================================================================
// 月幕 MoontentRN 后端入口（Koa）
// ----------------------------------------------------------------------------
// 设计要点：
// - 导出 createApp(options)：组装中间件与路由并返回 Koa 实例，
//   供启动脚本 / 自检脚本（boot-check、smoke）复用；
// - dotenv 定位基于模块相对路径（import.meta.url 推导 server 根），
//   与启动时的 cwd 无关，任意目录下 `node .../src/index.js` 均可正确加载；
// - 直接运行本文件时在 3001 端口启动 HTTP 服务。
// ============================================================================

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

// —— 基于 import.meta.url 推导 server 根目录（src/ 的上一级） ——
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const SERVER_ROOT = path.resolve(__dirname, '..');

// —— 加载 server 根下的 .env（存在才加载；不覆盖已有环境变量） ——
import dotenv from 'dotenv';

const envPath = path.join(SERVER_ROOT, '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, quiet: true });
}

import Koa from 'koa';
import cors from '@koa/cors';
import bodyParser from 'koa-bodyparser';
import compress from 'koa-compress';
import serve from 'koa-static';
import { apiRouter } from './routes/index.js';
import { startShardServers } from './lib/shard-ports.js';
import { freePort } from './lib/free-port.js';

/**
 * 创建 Koa 应用实例
 * @param {{ distDir?: string }} [options] 可选配置：
 *   - distDir：前端静态产物目录（优先级高于环境变量 SERVE_DIST）；
 *     支持绝对路径，或相对 server 根的相对路径。传入后挂载 koa-static 托管。
 * @returns {import('koa').Application} Koa 应用实例
 */
export function createApp(options = {}) {
  const app = new Koa();

  // —— 跨域：开发期前端（Expo Web / 本机设备）直连后端 ——
  app.use(cors());

  // —— 统一错误处理中间件:兜住下游所有异常 ——
  // 与 NextWeb 网关错误契约一致:统一 {__err:1,message} + 502(前端 src/lib
  // 的 client 依此把响应转成异常)。路由层已各自捕获并回包(含分发层 4xx 的
  // ApiError 语义),这里是「响应尚未写出前的最后兜底」——例如流式转发中途
  // 上游断流、序列化失败等路由层没能覆盖的路径。已经写出响应头(流已在传)
  // 时无法再改状态码,只能交给 Koa 的 error 事件在终端留痕。
  // 位置红线:必须在 bodyParser 之前——koa-bodyparser 解析失败(畸形 JSON
  // 400 / 超限 413)在自身阶段抛错,挂在它内层则按洋葱模型直达 Koa 核心,
  // 回成 text/plain "Bad Request",绕过 {__err:1} 契约。
  app.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      ctx.app.emit('error', err, ctx);
      if (ctx.headerSent) return;   // 流式响应已在传输:不再覆写状态码/响应体
      ctx.status = err.status || 502;
      ctx.type = 'application/json';
      ctx.body = { __err: 1, message: err.message || '服务器内部错误' };
    }
  });

  // —— POST 请求体解析（聊天写侧 /api/telegram/send|callback|vote|read 收
  //    JSON）：仅启用 json 且 128KB 上限——纯文本消息/回调/投票载荷远小于此，
  //    超限直接 413 拒绝，不进业务层；表单/文本体不解析（本项目无此面）；
  //    解析失败按上方位置红线交错误中间件统一回契约体 ——
  app.use(bodyParser({ enableTypes: ['json'], jsonLimit: '128kb' }));

  // —— 响应压缩（br/gzip/zstd 按客户端 Accept-Encoding 协商，zstd 需 Node ≥22.15）：
  //    静态导出的 entry JS 明文 5MB+，不压缩时弱网首屏要 20s 级；默认 filter 走
  //    compressible（JS/CSS/HTML/JSON 压，图片/视频流不重复压），阈值 1024B。
  app.use(compress({ threshold: 1024 }));

  // —— API 路由:/api/sites(清单)、/api/img/:site(图片代理)、
  //    /api/:site/:method(统一分发网关),见 src/routes/ ——
  app.use(apiRouter.routes());
  app.use(apiRouter.allowedMethods());

  // —— 静态托管前端产物（app 的 expo export --platform web 输出） ——
  const distDir = options.distDir || process.env.SERVE_DIST || null;
  let staticReady = false; // index.html 已就位、页面可托管
  if (distDir) {
    const absDist = path.isAbsolute(distDir)
      ? distDir
      : path.resolve(SERVER_ROOT, distDir);
    if (fs.existsSync(absDist)) {
      // —— 产物文件长缓存：/_expo/static/**（entry-<hash>.js、*.css）文件名带
      //    内容哈希，发版即新地址，可放心一年 immutable（二次访问零下载）；
      //    /assets/** 不带哈希但内容稳定，给 1 天。HTML 仍由下方 SPA 回退层
      //    维持 no-cache，保证发布即生效。挂在 koa-static 之前，next() 回来
      //    再补头（Koa 在中间件链收尾才真正写出响应头，此处仍来得及）。 ——
      app.use(async (ctx, next) => {
        await next();
        if ((ctx.method !== 'GET' && ctx.method !== 'HEAD') || ctx.status !== 200) return;
        if (ctx.path.startsWith('/_expo/static/')) {
          ctx.set('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (ctx.path.startsWith('/assets/')) {
          ctx.set('Cache-Control', 'public, max-age=86400');
        }
      });
      app.use(serve(absDist));
      // —— SPA 解析层（koa-static 未命中后的补位），三级降级 ——
      // 背景：expo-router 静态导出只产出「静态路由.html + 动态路由模式壳」，
      // 真实 URL 在 koa-static 默认配置下会 miss。若一律回 index.html 会踩
      // 水合不匹配：index.html 的 SSR 内容是首页，客户端按实际路由（如
      // /video/x/y）水合 → React #418 未捕获异常刷控制台（每次深链/刷新
      // 一条）。因此：
      //   1) 路径 + '.html' 存在（/category → category.html 等静态路由）：
      //      原样直出——壳的 SSR 内容与客户端路由一致，正常水合；
      //   2) 其余（动态路由深链 /video/[site]/[id] 等）：回 index.html 的
      //      「客户端渲染壳」——把 <script>globalThis.__EXPO_ROUTER_HYDRATE__
      //      =true;</script> 摘掉（runApplication 读该标记决定 hydrateRoot
      //      还是 createRoot），客户端纯渲染接管，无水合即无 #418。
      const indexPath = path.join(absDist, "index.html");
      staticReady = fs.existsSync(indexPath);
      if (staticReady) {
        let shellCache = null; // 客户端渲染壳（去水合标记）缓存，随 mtime 失效
        let shellMtimeMs = 0;
        const CLIENT_RENDER_MARK = "globalThis.__EXPO_ROUTER_HYDRATE__=true;";
        app.use(async (ctx) => {
          if (ctx.method !== "GET" && ctx.method !== "HEAD") return;
          if (ctx.path.startsWith("/api/")) return; // API 404 原样返回，不吞
          if (ctx.body || ctx.status !== 404) return; // 已有响应的不覆盖
          // 1) 静态路由壳：/category → <dist>/category.html（限制在 dist 内，
          //    防路径穿越；尾斜杠归一后拼 .html）
          const clean = ctx.path.replace(/\/+$/, "") || "/";
          const tryPath = clean === "/" ? null : path.resolve(absDist, "." + clean + ".html");
          if (tryPath && tryPath.startsWith(absDist + path.sep) && fs.existsSync(tryPath)) {
            ctx.type = "html";
            ctx.set("Cache-Control", "no-cache");
            ctx.body = fs.readFileSync(tryPath);
            return;
          }
          // 2) 动态路由深链：客户端渲染壳（index.html 去水合标记）
          const st = fs.statSync(indexPath);
          if (!shellCache || st.mtimeMs !== shellMtimeMs) {
            const raw = fs.readFileSync(indexPath, "utf8");
            shellCache = Buffer.from(
              raw.includes(CLIENT_RENDER_MARK)
                ? raw.split(CLIENT_RENDER_MARK).join("")
                : raw,
              "utf8"
            );
            shellMtimeMs = st.mtimeMs;
          }
          ctx.type = "html";
          ctx.set("Cache-Control", "no-cache"); // 壳页不缓存，保证发布即生效
          ctx.body = shellCache;
        });
      }
    } else {
      // 目录不存在时仅告警不中断（例如后端先行启动、前端尚未导出）
      console.warn(`[月幕后端] 静态目录不存在，暂不托管：${absDist}`);
    }
  }

  // —— 页面未托管时的根路径诊断提示（保持 404 状态码，刻意不返回 200：
  //    桌面端 backendUsable 以「GET / 返回含 id="root" 的 200 HTML」判定
  //    3001 上的服务可复用，此处返回 200 会让裸后端被误复用成 404 白屏）。
  //    裸起 server（无 SERVE_DIST/distDir）的场景 API 一切正常，但页面访问
  //    / 只会看到 Koa 默认 404 纯文本、无从排查——补一条中文 JSON 说明。
  if (!staticReady) {
    app.use(async (ctx) => {
      if (ctx.path !== "/" || (ctx.method !== "GET" && ctx.method !== "HEAD")) return;
      if (ctx.body || ctx.status !== 404) return; // 已有响应的不覆盖
      ctx.status = 404;
      ctx.body = {
        __err: 1,
        message:
          "前端产物未挂载，本服务仅 API 可用（如 /api/sites）。直接运行 server 请设置 SERVE_DIST 指向 expo export 产物目录，或先执行 node MoontentRN/cli.js build web；桌面端请通过应用窗口访问。",
      };
    });
  }

  // —— 统一的应用级错误日志(断连风暴降噪) ——
  // 流式出口(telegram stream 等)上客户端断连会成串抛 EPIPE/ECONNRESET/
  // ECONNABORTED/ERR_STREAM_PREMATURE_CLOSE——同一 code 的错误 60 秒窗口内
  // 只打一条(窗口开启时的首条),窗口收口时若窗口内还有被静默计数的同类
  // 错误,补一条带总次数的汇总;其余错误照旧逐条全量打印。所有行都带
  // err.code 便于归类。窗口计时器 unref:降噪器绝不拖住进程退出。
  const NOISE_WINDOW_MS = 60_000;
  const NOISY_ERR_CODES = new Set([
    'EPIPE', 'ECONNRESET', 'ECONNABORTED', 'ERR_STREAM_PREMATURE_CLOSE',
  ]);
  const noiseWindows = new Map(); // code → { count, timer }
  app.on('error', (err) => {
    const code = err && err.code;
    const tag = code ? `${err.message}（code=${code}）` : err.message;
    if (!code || !NOISY_ERR_CODES.has(code)) {
      console.error(`[月幕后端] 应用级错误：${tag}`);
      return;
    }
    let w = noiseWindows.get(code);
    if (w) { w.count++; return; } // 窗口内:静默聚合计数
    w = { count: 1, timer: null };
    noiseWindows.set(code, w);
    console.error(`[月幕后端] 应用级错误：${tag}`);
    w.timer = setTimeout(() => {
      noiseWindows.delete(code);
      if (w.count > 1) {
        console.error(`[月幕后端] 应用级错误：近 60 秒 ${code} 共 ${w.count} 条（已聚合计数）`);
      }
    }, NOISE_WINDOW_MS);
    if (typeof w.timer.unref === 'function') w.timer.unref();
  });

  return app;
}

// —— 直接运行本文件时启动 HTTP 服务（默认 3001 端口）。
//    listen 前先自动清理端口上的旧监听进程（上一轮 npm start 的残留实例，
//    见 src/lib/free-port.js）；清理失败（无权限/未知占用者）明确报错退出，
//    不再裸抛 EADDRINUSE。清理与 listen 之间端口被抢占的极小竞态，由
//    EADDRINUSE 兜底再清一次重试（只重试一次，防两个实例互杀死循环）。
//    主 listen 成功后再起分片端口（主端口+1..+N，见 src/lib/shard-ports.js）：
//    把视频流分散到分片端口拉取，防同源 HTTP/1.1 连接上限把 /api/* 短请求
//    饿死；任一分片绑定失败只 warn 一条，绝不影响主服务 ——
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const PORT = Number(process.env.PORT || 3001);
  void (async () => {
    const app = createApp();
    if (!(await freePort(PORT))) process.exit(1);
    let retried = false; // EADDRINUSE 兜底重试只做一次
    const start = () => {
      const server = app.listen(PORT, () => {
        console.log(`[月幕后端] 已启动：http://localhost:${PORT}`);
        try {
          startShardServers(app.callback(), PORT);
        } catch (e) { /* 分片失败绝不影响主服务 */ }
      });
      server.on('error', (err) => {
        if (err.code !== 'EADDRINUSE' || retried) {
          console.error(`[月幕后端] 启动失败：${err.message}（端口 ${PORT}）`);
          process.exit(1);
        }
        retried = true;
        void (async () => {
          if (await freePort(PORT)) start();
          else process.exit(1);
        })();
      });
    };
    start();
  })();
}
