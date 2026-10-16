// ============================================================
// redis.js —— Redis 连接层(ioredis 单例,仅 Node 服务端运行)
//
// 定位:可选的共享缓存(kv get/set/del),给收藏计数、热点片单等
// 跨进程数据做轻量暂存。与 api-cache.js 的分层关系:api-cache 缓存
// 「上游归一化响应」(进程内、挂了只影响性能),本层面向未来的跨进程
// 状态;两者都遵循同一条铁律——Redis 是加速器不是依赖项,连不上必须
// 静默降级(rdGet 回 null / rdSet no-op),绝不让主链路 5xx。
//
// 语义要点:
//   · import 零副作用零网络:不读 env 以外的任何东西、不建连、不监听,
//     首次调用 rdGet/rdSet/rdDel 才发起连接(lazyConnect),保证
//     check-plugins / boot-check 等无 DB 环境可照常 import 本模块;
//   · 未就绪即刻降级:进程内首次调用放行一次(由该条命令触发惰性建连,
//     连接成败落到 state 镜像),此后连接状态非 ready(连接中/断线重连中)
//     一律 rdGet 回 null、rdSet/rdDel no-op——绝不把命令排进离线队列去
//     等下一次重连尝试(退避封顶 30s,排队等于挂住调用方;重连成功后
//     state 镜像自动翻真,无需干预);
//   · 单例挂 globalThis:桌面嵌入会重复组装 createApp、自检脚本可能经
//     不同模块树重复加载本文件,模块级变量不足以跨副本去重,挂到
//     globalThis 以「进程」为单位唯一化——同进程至多一条 Redis 连接;
//   · 断线指数退避重连(1s 起步、30s 封顶),恢复后自动回到可用态;
//   · 连接类错误只 warn 一次:重连期间同一故障反复刷屏没有信息量,
//     ready 后重置标记,下次断线再提示一轮;绝不向调用方抛出。
// ============================================================

import Redis from 'ioredis';

// globalThis 挂载键(Symbol.for 跨模块副本共享同一个引用)
const REDIS_SLOT = Symbol.for('moontent.server.redis');

// 读取连接配置:每次建连时现读 env,默认本机回环,账号密码可空
// (空串统一转 undefined,避免 ioredis 把 '' 当作用户名下发 HELLO AUTH)
function readRedisConfig() {
  return {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB) || 0,
  };
}

// 惰性取/建客户端:globalThis 上无实例才创建,事件接线一次到位。
// 返回 { client, state },state.ok 即「连接健康」的实时镜像。
function ensureClient() {
  let box = globalThis[REDIS_SLOT];
  if (!box || !box.client) {
    const cfg = readRedisConfig();
    const client = new Redis({
      ...cfg,
      lazyConnect: true,        // 首条命令才真正建连:import 阶段零网络
      maxRetriesPerRequest: 1, // 命令断线即 reject(默认 20 次重发会挂住调用方),
                               // 缓存语义宁快降级不长等待
      connectTimeout: 5000,    // 不可达场景 5s 内给出结论,不拖满默认 10s
      retryStrategy(times) {   // 指数退避:1s,2s,4s,... 封顶 30s,永不放弃
        return Math.min(1000 * 2 ** (times - 1), 30000);
      },
    });
    const state = { ok: false, warned: false, tried: false };
    // ready/close/end 三态维护健康镜像:断线自动 false、恢复自动 true,
    // redisOn() 只需同步读标志,不触发任何连接动作
    client.on('ready', () => {
      state.ok = true;
      state.warned = false; // 恢复后重置:下次断线允许再 warn 一轮
    });
    client.on('close', () => { state.ok = false; }); // 断线(含每次重连失败)
    client.on('end', () => { state.ok = false; });   // 主动 quit/disconnect
    // error 必须监听:ioredis 无监听时会以 uncaughtException 冒泡
    client.on('error', (err) => {
      if (!state.warned) {
        state.warned = true;
        console.warn(`[redis] 连接异常(${cfg.host}:${cfg.port} 库${cfg.db}):${err.message}`);
      }
    });
    box = { client, state };
    globalThis[REDIS_SLOT] = box;
  }
  return box;
}

// 取「可用客户端」入口:进程内首次调用放行一次——lazyConnect 下由该条
// 命令触发建连,连接成败都会落到 state 镜像;此后严格按镜像判定,非 ready
// (连接中/断线重连中)返回 null,调用方即刻降级。没有这道门,断线期间发出
// 的命令会排进 ioredis 离线队列,直到下一次重连尝试失败才 reject——退避
// 封顶 30s 后每条命令都可能挂住调用方半分钟(收藏链路 Redis 降级自测超时
// 的根因),与文件头「加速器不是依赖项」的铁律相悖。
function usable() {
  const box = ensureClient();
  if (box.state.tried) return box.state.ok ? box.client : null;
  box.state.tried = true; // 首次放行:触发建连,成败由 ready/close 镜像反映
  return box.client;
}

/**
 * Redis 是否健康(同步、零副作用、不触发建连)
 * 尚未建连(从未用过)视为不可用;断线自动 false、恢复自动 true
 * @returns {boolean}
 */
export function redisOn() {
  const box = globalThis[REDIS_SLOT];
  return Boolean(box && box.state.ok);
}

/**
 * 读缓存:key 不存在、Redis 不可用、超时等一切异常统一返回 null,
 * 调用方无需(也不应)区分「未缓存」与「缓存故障」
 * @param {string} key
 * @returns {Promise<string|null>}
 */
export async function rdGet(key) {
  try {
    const client = usable(); // 未就绪即刻 null:绝不等待重连(见文件头)
    if (!client) return null;
    const v = await client.get(key);
    return typeof v === 'string' ? v : null;
  } catch {
    return null; // 不可用即视为 miss,静默降级
  }
}

/**
 * 写缓存(字符串值)。ttlSeconds 为正数时带过期,否则永久;
 * Redis 不可用时 no-op——写失败不影响主链路,只是下次读不到
 * @param {string} key
 * @param {string} value
 * @param {number} [ttlSeconds] 过期秒数,不传或非正数则不过期
 */
export async function rdSet(key, value, ttlSeconds) {
  try {
    const client = usable(); // 未就绪即刻 no-op:绝不等待重连
    if (!client) return;
    const s = String(value);
    if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
      await client.set(key, s, 'EX', Math.floor(ttlSeconds));
    } else {
      await client.set(key, s);
    }
  } catch {
    // no-op:缓存写失败静默吞掉(见文件头「Redis 是加速器不是依赖项」)
  }
}

/**
 * 删缓存:返回实际删除的 key 数;不可用时返回 0(等效于没删掉,
 * 由 key 的 TTL 兜底过期),不抛错
 * @param {...string} keys
 * @returns {Promise<number>}
 */
export async function rdDel(...keys) {
  if (keys.length === 0) return 0;
  try {
    const client = usable(); // 未就绪即刻返回 0:绝不等待重连
    if (!client) return 0;
    return await client.del(...keys);
  } catch {
    return 0;
  }
}
