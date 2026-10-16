// ============================================================================
// 分片端口(shard ports):自动分片 + 自动发现(仅 Node 服务端运行)
// ----------------------------------------------------------------------------
// 背景:HTTP/1.1 浏览器对同一 host:port 的并发连接有上限(Chromium 系 6 条),
// Telegram 视频流(长时 Range 字节流)占满同源连接槽后,/api/* 短请求全部
// 排在其后——清单/CMS 等数据请求被长流「饿死」(连接饥饿)。解法:主端口
// 之外再绑 N 个分片端口,同一个 HTTP 回调全部挂上;前端从 GET /api/sites
// 的 telegram 条目读到可选字段 shardPorts(实际绑定端口,主端口在前)与
// streamSlots(缺省 16),把视频流分散到分片端口拉取。
//
// 行为契约(防御式:任一失败绝不影响主服务):
//   startShardServers(httpCallback, mainPort, host?)
//     依次尝试绑定 mainPort+1 .. mainPort+N(N = env TG_SHARD_PORTS,
//     缺省 9,钳 0..9;0 = 显式关闭分片);每端口独立
//     http.createServer(httpCallback).listen(port, host);EADDRINUSE/其它
//     listen 异常只 console.warn 一条并跳过该端口,不上抛、不影响主服务。
//     幂等:进程内只启动一次,重复调用返回首次的分片服务表(主端口不同则
//     warn 后忽略)。返回已创建的分片 http.Server 数组(含 listen 在途者,
//     供调用方退出时尽力关闭;数组引用稳定)。
//   getShardInfo()
//     → { ports: number[](实际绑定端口,主端口在前;从未启动过为 []),
//        streamSlots: number }(env TG_STREAM_SLOTS,缺省 16),
//        settled: boolean }(全部分片 listen 成败已到齐;服务端内部提示,
//        不出网——/api/sites 客户端契约字段仍只有 shardPorts/streamSlots)。
//     ports 只收 listen 成功的端口——如实上报,不虚报意图。
// ============================================================================

import http from 'node:http';

const MAX_SHARD_PORTS = 9;        // 分片端口数上限(与 deploy/remote-server.sh 的 ufw 端口段同口径)
const DEFAULT_SHARD_PORTS = 9;
const DEFAULT_STREAM_SLOTS = 16;

// 环境整数:非法(NaN)回默认值,再钳到 [min,max]
function envClampedInt(name, dflt, min, max) {
  const n = parseInt(process.env[name], 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// 环境正整数:非法/非正回默认值
function envPositiveInt(name, dflt) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

let startedMainPort = null;  // 首次(且唯一一次)启动时的主端口;null = 尚未启动
const shardServers = [];     // 已创建的分片 http.Server(listen 在途/失败也在内,退出清理统一兜错)
const boundShardPorts = [];  // 已成功 listen 的分片端口(升序)
let pendingSettle = 0;       // 尚未结算(listen 成功/失败未到齐)的分片数;恒 ≥0,0 = 已结算

export function startShardServers(httpCallback, mainPort, host) {
  // 幂等:进程内只启动一次(桌面端/直接运行各自只会调一次;重复调用以首次为准)
  if (startedMainPort != null) {
    if (startedMainPort !== mainPort) {
      console.warn(`[分片端口] 分片已随主端口 ${startedMainPort} 启动,忽略重复调用(主端口 ${mainPort})`);
    }
    return shardServers;
  }
  if (typeof httpCallback !== 'function') {
    console.warn('[分片端口] 未提供有效的 http 回调,跳过分片启动');
    return shardServers;
  }
  if (!Number.isFinite(mainPort) || mainPort <= 0) {
    console.warn(`[分片端口] 主端口非法(${mainPort}),跳过分片启动`);
    return shardServers;
  }
  startedMainPort = mainPort;
  const n = envClampedInt('TG_SHARD_PORTS', DEFAULT_SHARD_PORTS, 0, MAX_SHARD_PORTS);
  // 结算一个分片(listen 成/败到齐);全部到齐时补一条就绪汇总——成功路径
  // 本就无逐端口输出,缺这条汇总的话「尝试绑定」之后一片安静,冷启动像卡死。
  const settleShard = () => {
    if (pendingSettle > 0) pendingSettle--;
    if (pendingSettle === 0) {
      const bound = boundShardPorts.join('、') || '无';
      console.log(`[分片端口] 就绪：分片绑定 ${boundShardPorts.length}/${n}（${bound}）`);
    }
  };
  for (let i = 1; i <= n; i++) {
    const port = mainPort + i;
    const srv = http.createServer(httpCallback);
    shardServers.push(srv);
    pendingSettle++; // 每个分片必经 listening/error 事件之一结算,两处各自递减
    srv.once('error', (err) => {
      // EADDRINUSE/权限等:跳过该端口,绝不影响主服务
      const why = err && err.code ? err.code : (err && err.message) || String(err);
      console.warn(`[分片端口] 分片端口 ${port} 不可用,跳过(${why})`);
      settleShard();
    });
    srv.listen(port, host, () => {
      boundShardPorts.push(port);
      settleShard();
    });
  }
  if (n > 0) {
    console.log(`[分片端口] 尝试绑定 ${mainPort + 1}-${mainPort + n} 共 ${n} 个分片端口(TG_SHARD_PORTS=${n})`);
  }
  return shardServers;
}

export function getShardInfo() {
  const ports = startedMainPort == null ? [] : [startedMainPort, ...boundShardPorts];
  return {
    ports,
    streamSlots: envPositiveInt('TG_STREAM_SLOTS', DEFAULT_STREAM_SLOTS),
    // settled:全部分片 listen 成败已到齐(从未启动也视为已结算)——服务端
    // 内部提示,消费方(sites.js)据此避开「冷启动竞态把缺分片形态钉进
    // Redis 60s」;不出网,客户端契约字段仍只有 shardPorts/streamSlots。
    settled: pendingSettle === 0,
  };
}
