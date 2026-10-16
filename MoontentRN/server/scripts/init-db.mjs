// ============================================================================
// 收藏库初始化脚本（init-db）
// ----------------------------------------------------------------------------
// 职责：在远端 MySQL 上幂等建库（moontent，utf8mb4/utf8mb4_unicode_ci）+
// 建表（favorites，结构与 src/lib/db.js 的收藏读写约定一一对应），
// 并顺带对 Redis 做一次 PING 连通性报告。
// 特性：
//   - 自载 .env（dotenv 路径按 import.meta.url 推导 server 根，与 cwd 无关）；
//   - 幂等可重跑（CREATE DATABASE/TABLE IF NOT EXISTS）；
//   - 逐项打中文 ✓/✗ 与原因，全成 exit 0，任一失败 exit 1；
//   - 建库权限不足时打印「用已有库重跑」的明确指引。
// 用法：node MoontentRN/server/scripts/init-db.mjs
// ============================================================================

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import Redis from 'ioredis';

// —— 基于 import.meta.url 推导 server 根目录（scripts/ 的上一级） ——
const __filename = fileURLToPath(import.meta.url);
const SERVER_ROOT = path.resolve(path.dirname(__filename), '..');

// —— 自载 server 根下的 .env（存在才加载；不覆盖已有环境变量） ——
const envPath = path.join(SERVER_ROOT, '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, quiet: true });
}

const TAG = '[init-db]';

// 连接参数（与 src/lib/db.js、src/lib/redis.js 的 env 约定一致）
const MYSQL = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT) || 3306,
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'moontent',
};
const REDIS = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT) || 6379,
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
  db: Number(process.env.REDIS_DB) || 0,
};

let failed = false;

// MySQL 权限类错误码（errno 1044/1045 家族）：触发「用已有库重跑」指引
function isAccessDenied(err) {
  return ['ER_DBACCESS_DENIED_ERROR', 'ER_ACCESS_DENIED_ERROR', 'ER_SPECIFIC_ACCESS_DENIED_ERROR']
    .includes(err?.code);
}

// —— 第 1 步：连 MySQL（不带默认库；建库前库还不存在） ——
let conn = null;
process.stdout.write(`${TAG} 连接 MySQL ${MYSQL.user}@${MYSQL.host}:${MYSQL.port} ... `);
try {
  conn = await mysql.createConnection({
    host: MYSQL.host,
    port: MYSQL.port,
    user: MYSQL.user,
    password: MYSQL.password,
    charset: 'utf8mb4',
    timezone: 'Z',
    connectTimeout: 10000,
  });
  console.log('✓');
} catch (err) {
  console.log(`✗（${err.message}）`);
  failed = true;
}

// —— 第 2 步：建库（幂等；库名来自 MYSQL_DATABASE，反引号防保留字） ——
const dbName = MYSQL.database.replace(/`/g, '``');
if (conn) {
  process.stdout.write(`${TAG} 建库 ${MYSQL.database}（utf8mb4/utf8mb4_unicode_ci）... `);
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    console.log('✓');
  } catch (err) {
    console.log(`✗（${err.message}）`);
    if (isAccessDenied(err)) {
      console.log(`${TAG} 权限不足：当前账号 ${MYSQL.user} 无建库权限。`);
      console.log(`${TAG} 若目标库已由管理员在服务端建好并授权，可用已有库重跑：`);
      console.log(`${TAG}   MYSQL_DATABASE=<已有库名> node scripts/init-db.mjs`);
    }
    failed = true;
  }
}

// —— 第 3 步：切库建表（幂等；结构与收藏读写约定一一对应） ——
if (conn && !failed) {
  process.stdout.write(`${TAG} 建表 ${MYSQL.database}.favorites ... `);
  try {
    await conn.changeUser({ database: MYSQL.database });
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`favorites\` (
        \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`site\` VARCHAR(32) NOT NULL,
        \`vid\` VARCHAR(64) NOT NULL,
        \`title\` VARCHAR(512) NOT NULL DEFAULT '',
        \`cover\` VARCHAR(1024) NOT NULL DEFAULT '',
        \`duration\` INT NULL,
        \`hd\` TINYINT(1) NOT NULL DEFAULT 0,
        \`created_at\` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY \`uk_fav\` (\`site\`, \`vid\`),
        KEY \`idx_created\` (\`created_at\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✓');
  } catch (err) {
    console.log(`✗（${err.message}）`);
    if (isAccessDenied(err)) {
      console.log(`${TAG} 权限不足：当前账号 ${MYSQL.user} 对库 ${MYSQL.database} 无建表权限，`);
      console.log(`${TAG} 可让管理员授权后重跑，或换已有授权库：MYSQL_DATABASE=<已有库名> node scripts/init-db.mjs`);
    }
    failed = true;
  }
}

// —— 第 4 步：Redis 连通性（一次性 PING，独立于 MySQL 结果） ——
{
  const rc = new Redis({
    ...REDIS,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 10000,
  });
  // 挂空 error 监听:认证失败等信息由下方 ping 的 catch 统一报告,
  // 避免 ioredis 因无监听把同一错误再打一遍「Unhandled error event」
  rc.on('error', () => {});
  process.stdout.write(`${TAG} Redis PING ${REDIS.username || '默认账号'}@${REDIS.host}:${REDIS.port} 库${REDIS.db} ... `);
  try {
    const pong = await rc.ping();
    if (pong === 'PONG') {
      console.log('✓（PONG）');
    } else {
      console.log(`✗（响应异常：${pong}）`);
      failed = true;
    }
  } catch (err) {
    console.log(`✗（${err.message}）`);
    failed = true;
  } finally {
    rc.disconnect(); // 一次性连接：无论成败直接断开，不等优雅 quit
  }
}

// —— 收尾：关连接、按结果退出（0=全成，1=有失败项） ——
if (conn) {
  await conn.end().catch(() => {});
}
console.log(`${TAG} ${failed ? '存在失败项，请按上方提示处理后重跑' : '初始化完成（幂等，可随时重跑）'}`);
process.exit(failed ? 1 : 0);
