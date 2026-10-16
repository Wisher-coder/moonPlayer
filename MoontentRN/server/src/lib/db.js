// ============================================================
// db.js —— MySQL 连接层(mysql2/promise 连接池,仅 Node 服务端运行)
//
// 定位:收藏库等持久化数据的唯一 SQL 出入口。与 redis.js 的本质区别:
// Redis 是加速器、连不上必须静默降级;MySQL 是数据本体,「连不上还装作
// 成功」等于悄悄丢用户数据——所以 q() 在池不可用时抛带中文上下文的
// Error 绝不静默吞,由路由层按 {__err:1,message} 契约回 502。
//
// 语义要点:
//   · import 零副作用零建池:首次 q() 才创建池(mysql2 池本身惰性,
//     getConnection 才真连),check-plugins / boot-check 等无 DB 环境
//     可照常 import 本模块;
//   · 池挂 globalThis(Symbol.for):桌面嵌入重复组装 createApp、脚本
//     重复加载本文件时仍以进程为单位唯一复用,不泄漏连接;
//   · connectionLimit 8 + waitForConnections:1GB 内存部署机的收敛值,
//     超并发排队而非开新连接;
//   · charset utf8mb4 + timezone 'Z':池层统一字符集与 UTC 时区,
//     TIMESTAMP(3) 读写不漂移,业务代码不再各自处理时差。
// ============================================================

import mysql from 'mysql2/promise';

// globalThis 挂载键(Symbol.for 跨模块副本共享同一个引用)
const POOL_SLOT = Symbol.for('moontent.server.mysqlPool');

// 读取连接配置:每次建池时现读 env,默认本机回环+moontent 库(库名默认值
// 与 scripts/init-db.mjs、README 环境变量表对齐——此前默认 undefined 时
// 未显式配置的部署所有裸表名 SQL 会报 No database selected)
function readMysqlConfig() {
  return {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'moontent',
  };
}

// 惰性取/建连接池:globalThis 上无实例才创建
function ensurePool() {
  let box = globalThis[POOL_SLOT];
  if (!box || !box.pool) {
    const cfg = readMysqlConfig();
    const pool = mysql.createPool({
      ...cfg,
      connectionLimit: 8,      // 小内存部署机收敛值,超发排队不开新连
      waitForConnections: true,
      charset: 'utf8mb4',      // 全 Unicode(emoji/生僻字),与建库字符集一致
      timezone: 'Z',           // 池层统一 UTC,TIMESTAMP 不做本地时区换算
    });
    box = { pool, cfg };
    globalThis[POOL_SLOT] = box;
  }
  return box;
}

/**
 * 执行 SQL(参数化)。SELECT 返回 rows 数组,写操作(INSERT/UPDATE/
 * DELETE/DDL)返回 result;两者都是 mysql2 结果元组的第一元素,
 * 调用方按语句类型自行取用,无需在此分支。
 * 池不可用(连不上/账号错/库不存在)时抛带中文上下文的 Error,
 * 原始错误挂 cause 保留——绝不静默吞。
 * @param {string} sql 带 ? 占位符的 SQL
 * @param {Array} [params] 占位参数
 * @returns {Promise<Array|object>}
 */
export async function q(sql, params = []) {
  const { pool, cfg } = ensurePool(); // 首次调用在此触发建池
  try {
    const [rows] = await pool.query(sql, params);
    return rows;
  } catch (err) {
    // 包一层连接上下文:排障时一眼看出连的是哪台/哪个库/哪个账号
    throw new Error(
      `MySQL 请求失败(${cfg.host}:${cfg.port} 库=${cfg.database} 账号=${cfg.user}):${err.message}`,
      { cause: err },
    );
  }
}

/**
 * 探活:真实走一次 SELECT 1 验证池可用(建池 + 建连 + 查询全链路)。
 * 只回答健康与否,错误细节已由 q() 的中文包装给出
 * @returns {Promise<boolean>}
 */
export async function dbReady() {
  try {
    await q('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
