#!/usr/bin/env node
// ============================================================
// api-cache-test.mjs —— L1+L2+SWR 公共缓存自测(直连 cachedGet,不起 HTTP)
//
// 用法:
//   node scripts/api-cache-test.mjs            默认模式:需 .env/环境变量指向
//                                              的真实 Redis(与服务端同一条
//                                              dotenv 加载路径)
//   node scripts/api-cache-test.mjs --no-redis 降级模式:REDIS_PORT 先指到
//                                              不可达端口再动态 import,验证
//                                              纯 L1 退化全流程可用
//   node scripts/api-cache-test.mjs --restart-child <key> <ttlMs>
//                                              内部子模式(⑤ 真进程重启验证
//                                              用,由父进程拉起,不单独使用)
//
// 覆盖(编号与施工规格一一对应):
//   ① miss → producer 恰跑 1 次 → L2('mnt:api:'+key)落键且 {out,at,ttl,hard}
//      字段完整、hard=min(ttl*10,30min) 换算正确
//   ② 二次调用命中缓存(producer 计数不变)
//   ③ SWR 软过期:ttl=60ms(hard=600ms),sleep 过窗后 5 路并发调用
//      全部立即回旧值、后台刷新恰触发 1 次(计数 1→2,防惊群)、刷新后 L2
//      已换新。「立即返回」的断言口径:延迟 ≤ 自适应预算且 < producer 时长
//      (1500ms)——即绝不等待后台刷新。预算 = min(max(30ms, 6×基线RTT+
//      200ms), 1400ms):本机 Redis 时基线 ~1ms,预算即回到规格的 30ms;
//      本仓 .env 指向的 Redis 为远端实例(实测单命令 RTT ~160ms、偶发尖刺
//      ~570ms),绝对 30ms 在物理上不可达,故按基线放宽(不等待 producer
//      的语义不变)。窗宽同理自适应:age 里含 rdSet/burst 两个网络往返,
//      远端 RTT 与 60/600ms 微缩窗同量级时窗被链路吞掉(age≥hard 落成
//      「硬过期视同 miss」同步回源),故 ③ 的 ttl 取 max(60, 基线RTT)、
//      sleep 取 ttl+半个基线,保证 age 恒落 (ttl, hard) 软过期窗内
//      (本机 Redis 仍回落到规格的 60ms/100ms 原设计)。
//   ④ (--no-redis)Redis 不可达:miss→produce→命中 全流程仍可用,L2 不落键
//   ⑤ (默认模式附加)真·进程重启:父进程产 key 落 L2 后拉起全新子进程
//      (L1 天然为空,即「重启后」),子进程调用直接 L2 新鲜命中回填,
//      producer 零执行——重启不丢的核心收益
//
// 测试键统一 'mnt:api:test:' 前缀,结束 rdDel 清理;全部通过 exit 0,任一
// 失败 exit 1(输出全中文)。
// ============================================================

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;

// 单项断言:统一中文输出,✓/✗ 前缀 + 失败时附细节
function check(name, cond, detail = '') {
  const ok = cond === true;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `(${detail})` : ''}`);
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

// 与服务端同路径加载 server/.env(dotenv 不覆盖已有环境变量)
function loadEnv() {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  dotenv.config({ path: envPath, quiet: true });
}

// —— ⑤ 子模式:全新进程 = 全新 L1(重启后),单次调用并把结果打给父进程 ——
if (process.argv[2] === '--restart-child') {
  loadEnv();
  const key = process.argv[3];
  const ttlMs = Number(process.argv[4]) || 60000;
  const { cachedGet } = await import('../src/lib/api-cache.js');
  let calls = 0;
  const producer = async () => { calls++; return { gen: calls }; };
  const r = await cachedGet(key, ttlMs, producer);
  console.log(`CHILD_HIT=${r.hit ? 1 : 0}`);
  console.log(`CHILD_GEN=${r.out && r.out.gen}`);
  console.log(`CHILD_CALLS=${calls}`);
  process.exit(0);
}

const noRedis = process.argv.includes('--no-redis');

if (noRedis) {
  // ============================================================
  // ④ --no-redis:先把 REDIS_PORT 指到不可达端口(本机 1 端口无监听,
  // 建连即刻被拒),再动态 import——redis.js 惰性建连,配置在首次命令时
  // 才读取,但按规格要求先改 env 再加载模块
  // ============================================================
  process.env.REDIS_HOST = '127.0.0.1';
  process.env.REDIS_PORT = '1';
  delete process.env.REDIS_USERNAME;
  delete process.env.REDIS_PASSWORD;
  delete process.env.REDIS_DB;
  console.log('注:本模式 Redis 不可达,redis.js 会对连接异常 warn 一次,属预期日志');

  const { cachedGet } = await import('../src/lib/api-cache.js');
  const { rdGet, rdDel, redisOn } = await import('../src/lib/redis.js');

  section('④ --no-redis:纯 L1 退化全流程');
  let calls = 0;
  const producer = async () => { calls++; return { gen: calls }; };
  const K = 'test:no-redis';
  const r1 = await cachedGet(K, 60000, producer);
  check('miss 正常走 producer', r1.hit === false && r1.out.gen === 1);
  check('producer 恰跑 1 次', calls === 1, `calls=${calls}`);
  const r2 = await cachedGet(K, 60000, producer);
  check('二次调用命中 L1 缓存', r2.hit === true && r2.out.gen === 1);
  check('命中后 producer 计数不变', calls === 1, `calls=${calls}`);
  check('Redis 保持不可用(降级判定生效)', redisOn() === false);
  // rdGet 的 null 无法区分 miss/不可用(冻结接口已知缺口):此处结合上一条
  // redisOn()===false(短路后写入本就不可能发生)佐证 L2 确未落键
  const rawN = await rdGet('mnt:api:' + K);
  check('L2 未落键(纯 L1 退化)', rawN === null);
  await rdDel('mnt:api:' + K); // 兜底清理(预期本就无键)

  console.log(failed === 0 ? '\n④ --no-redis 模式:全部通过' : `\n④ --no-redis 模式:${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

// ============================================================
// 默认模式:真实 Redis 验证 L2/SWR
// ============================================================
import dotenv from 'dotenv';
loadEnv();

const { cachedGet, TTL_META, TTL_LIST } = await import('../src/lib/api-cache.js');
const { rdGet, rdDel, redisOn } = await import('../src/lib/redis.js');

section('前置:真实 Redis 可用性');
// rdGet 的 null 无法区分 miss/不可用(冻结接口已知缺口):先逼一次建连,
// 再用 redisOn() 健康镜像判定
await rdGet('mnt:api:test:__ping__');
if (!redisOn()) {
  console.log('  ✗ Redis 不可用(检查 REDIS_HOST/REDIS_PORT 配置),默认模式无法验证 L2/SWR');
  process.exit(1);
}
console.log('  ✓ Redis 连接可用(redisOn()=true)');
check('TTL 档位常量未被改动', TTL_META === 300000 && TTL_LIST === 30000);

// 基线 RTT:3 次串行 rdGet 取中位数,作为「立即返回」的自适应预算基准
// (本机 Redis ~1ms;本仓 .env 指向远端实例,实测 ~160ms/尖刺 ~570ms)。
// 放在一切场景之前测量:③ 的 L2 键 Redis 侧 TTL 仅 1s(ttl=60ms →
// ceil(hard/1000)=1s),基线测量若插在中间会把键耗死成 miss
async function baselineRtt() {
  const ts = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    await rdGet('mnt:api:test:__ping__');
    ts.push(performance.now() - t);
  }
  ts.sort((a, b) => a - b);
  return ts[1];
}
const base = await baselineRtt();
console.log(`  ✓ 基线 RTT ${base.toFixed(1)}ms(本机 Redis 约 1ms级,当前实例为远端链路)`);

// —— ① miss → produce 1 次 → L2 落键 ——
section('① miss → produce → L2 落键');
let calls1 = 0;
const p1 = async () => { calls1++; return { gen: calls1 }; };
const r1 = await cachedGet('test:miss-basic', 60000, p1);
check('首次调用走 producer(hit=false)', r1.hit === false);
check('producer 恰跑 1 次', calls1 === 1, `calls=${calls1}`);
const raw1 = await rdGet('mnt:api:test:miss-basic');
let j1 = null;
try { j1 = raw1 ? JSON.parse(raw1) : null; } catch { j1 = null; }
check('L2 落键且值可解析', !!j1 && j1.out && j1.out.gen === 1);
check('L2 字段完整且 hard 换算正确',
  !!j1 && j1.ttl === 60000 && j1.hard === Math.min(60000 * 10, 30 * 60 * 1000),
  j1 ? `ttl=${j1.ttl} hard=${j1.hard}` : '无值');
check('L2 写入时刻为近期', !!j1 && Number.isFinite(j1.at) && Date.now() - j1.at >= 0 && Date.now() - j1.at < 30000);

// —— ② 二次调用命中,producer 计数不变 ——
section('② 二次调用命中缓存');
const r2 = await cachedGet('test:miss-basic', 60000, p1);
check('二次调用命中(hit=true)且数据一致', r2.hit === true && r2.out.gen === 1);
check('producer 计数不变', calls1 === 1, `calls=${calls1}`);

// —— ③ SWR 软过期:旧值秒回 + 后台刷新防惊群 ——
// producer 刻意慢(1500ms):证明秒回的确实是旧值,也保证 5 路并发的 L2 读
// 全部在后台刷新落键之前完成(消除远端 RTT 尖刺下的读-写竞态)
// 窗宽自适应(见文件头 ③ 说明):age = rdSet RTT + sleep + burst RTT,
// ttl ≥ 基线 RTT、sleep = ttl + 半个基线时,age 恒落 (ttl, 10×ttl) 窗内
const SWR_TTL = Math.max(60, Math.ceil(base));            // 本机 60ms 原设计,远端 ≈1×RTT
const SWR_HARD = SWR_TTL * 10;                            // hard 换算与 hardTtl() 同式
section(`③ SWR 软过期(ttl=${SWR_TTL}ms/hard=${SWR_HARD}ms)`);
let calls3 = 0;
const p3 = async () => { calls3++; await sleep(1500); return { gen: calls3 }; };
const r3a = await cachedGet('test:swr', SWR_TTL, p3);
check('首次 produce 落 L1+L2', r3a.hit === false && r3a.out.gen === 1 && calls3 === 1);
// sleep 取 ttl+半个基线:把 age 推过 ttl 进软过期窗,且留出 burst RTT 下浮
// 余量(age_min = sleep + burstRTT ≥ ttl + 基线 > ttl);不得再插入任何
// rdGet(那会吃掉窗内余量甚至把键耗过 hard 窗)
await sleep(SWR_TTL + Math.ceil(base / 2)); // age 已进软过期窗(ttl ≤ age < hard)
const budget = Math.min(Math.max(30, base * 6 + 200), 1400); // 本机 Redis 即 30ms;远端按基线放宽,上限 1400(仍 < producer 1500ms)
const t0 = performance.now();
const burst = await Promise.all(Array.from({ length: 5 }, () => cachedGet('test:swr', SWR_TTL, p3)));
const dt = performance.now() - t0;
check(`5 路并发立即回旧值(预算 ${budget.toFixed(0)}ms)`, dt < budget, `耗时 ${dt.toFixed(1)}ms,基线RTT ${base.toFixed(1)}ms`);
check('未等待后台 producer(1500ms)', dt < 1500, `耗时 ${dt.toFixed(1)}ms`);
check('5 路全部命中且拿到旧值 gen=1', burst.every((r) => r.hit === true && r.out.gen === 1));
check('后台刷新恰触发 1 次(防惊群,计数 1→2)', calls3 === 2, `calls=${calls3}`);
// 轮询等刷新真正落盘:producer 计数在 sleep 前自增,只等计数会读到旧信封;
// 每轮 1 次 rdGet 兼作节流(远端 RTT ~160ms,producer 1500ms+写 RTT 约 2s 内必达)
let j3b = null;
let landed = false;
for (let i = 0; i < 45 && !landed; i++) {
  await sleep(20);
  const raw3b = await rdGet('mnt:api:test:swr');
  try { j3b = raw3b ? JSON.parse(raw3b) : null; } catch { j3b = null; }
  landed = !!j3b && j3b.out && j3b.out.gen === 2;
}
check(`刷新后 L2 已换新(gen=2)且 hard 换算正确(${SWR_HARD})`,
  landed && j3b.ttl === SWR_TTL && j3b.hard === SWR_HARD,
  j3b ? `gen=${j3b.out && j3b.out.gen} ttl=${j3b.ttl} hard=${j3b.hard}` : '未读到新值');

// —— ⑤ 真·进程重启:子进程 L1 天然为空,L2 新鲜命中直接回 ——
section('⑤ 进程重启后 L2 命中(重启不丢)');
import { spawnSync } from 'node:child_process';
const K5 = 'test:restart-' + process.pid + '-' + Date.now();
let calls5 = 0;
const p5 = async () => { calls5++; return { gen: calls5 }; };
const r5a = await cachedGet(K5, 60000, p5);
check('父进程首次 produce 落 L2', r5a.hit === false && r5a.out.gen === 1 && calls5 === 1);
const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--restart-child', K5, '60000'], {
  encoding: 'utf8',
  env: process.env, // 继承已加载的 REDIS_* 配置,子进程连同一个 Redis
  timeout: 30000,   // 远端链路握手 + 1 次读足够;挂死视为失败
});
const marker = (k) => {
  const m = (child.stdout || '').match(new RegExp(k + '=(\\S+)'));
  return m ? m[1] : null;
};
check('子进程(重启后)退出码 0', child.status === 0, `status=${child.status}`);
check('重启后直接 L2 命中回填(hit=true)', marker('CHILD_HIT') === '1',
  `HIT=${marker('CHILD_HIT')} GEN=${marker('CHILD_GEN')} CALLS=${marker('CHILD_CALLS')}`);
check('重启后数据一致(gen=1)且 producer 零执行', marker('CHILD_GEN') === '1' && marker('CHILD_CALLS') === '0');

// —— 清理:rdDel 删除全部测试键 ——
// 注:test:swr 的 L2 键 Redis 侧 TTL = ceil(hard/1000) 秒(本机 1s、远端按
// 自适应窗放宽),跑到清理阶段通常已自然过期,删除数 ≥2 即视为清理完成
// (miss-basic/K5 均为长 TTL 必在)
section('清理');
const allKeys = ['mnt:api:test:miss-basic', 'mnt:api:test:swr', 'mnt:api:' + K5];
const delCount = await rdDel(...allKeys);
check('测试键已清理', delCount >= 2, `rdDel 删除 ${delCount}/${allKeys.length} 个键(短 TTL 键可已自然过期)`);

console.log(failed === 0 ? '\n默认模式:全部通过' : `\n默认模式:${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
