/**
 * node:test 目录汇总入口（server/scripts/tg-tests/index.js，ESM：server/package.json type=module）。
 *
 * 为什么需要它：工作流「服务端域测试（node:test）」门的命令是
 *   node --test <本目录绝对路径>
 * 本机 Node v24.14.0 实测（2026-10-12，/tmp 对照实验复证）不把 --test 的目录参数
 * 当「测试发现根」，而是当**单个测试条目**直接作为入口执行（子进程 `node <目录>`），
 * 目录内 *.test.mjs 不被发现 → MODULE_NOT_FOUND → 门红。目录参数的 glob/逐文件
 * 形态可用，但门命令文本不在本 lane 可写范围，故以本入口适配：Node 对
 * `node <目录>` 的解析顺序是 package.json#main → index.*，本文件被入口解析后，
 * 逐文件以独立子进程运行
 *   node --test <本目录>/*.test.mjs
 * 与等价的 glob 形态同构（每个文件独立进程、独立 node:test runner），任一文件
 * 失败/超时即整体非零退出，测试发现不受本文件影响（index.js 不是测试文件名模式）。
 *
 * 约定：
 * - 只汇总本目录顶层 *.test.mjs（自动发现，新增测试文件无需改这里）；fixtures/ 不含测试。
 * - 孙进程清掉 NODE_TEST_CONTEXT，按独立 runner 运行，不走外层运行器的子进程协议。
 * - 孙进程与汇总报告统一写 stderr，保持本进程 stdout 干净（外层门把本目录条目
 *   当单测试收集结果，干净 stdout 让其按退出码判定）。
 * - 若上层运行环境恢复了对目录的测试发现（如未来 Node 修正该行为），本文件不会被
 *   执行，门直接发现 *.test.mjs，两条路径等价。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PER_FILE_TIMEOUT_MS = 120_000; // 单文件上限；门整体超时 300s，逐文件卡死必须可见地失败而非无限挂起

const here = path.dirname(fileURLToPath(import.meta.url));
const files = fs
  .readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join(here, name));

if (files.length === 0) {
  console.error('[tg-tests] 未找到任何 *.test.mjs 测试文件，视为失败');
  process.exit(1);
}

const env = { ...process.env };
delete env.NODE_TEST_CONTEXT; // 独立运行，不走外层 node:test 的子进程事件协议

let failed = 0;
for (const file of files) {
  const label = path.basename(file);
  const result = spawnSync(process.execPath, ['--test', file], {
    // 孙进程 stdout/stderr 一并改道本进程 stderr（fd 2）：外层门把本目录条目当单个
    // 测试收集结果，保持 stdout 干净，让其按退出码判定。
    stdio: ['ignore', 2, 2],
    env,
    timeout: PER_FILE_TIMEOUT_MS,
  });
  if (result.error) {
    console.error(`[tg-tests] ✖ ${label} 无法启动：${result.error.message}`);
    failed += 1;
  } else if (result.signal) {
    console.error(`[tg-tests] ✖ ${label} 被信号 ${result.signal} 终止（疑似挂起，超过 ${PER_FILE_TIMEOUT_MS}ms）`);
    failed += 1;
  } else if (result.status !== 0) {
    console.error(`[tg-tests] ✖ ${label} 退出码 ${result.status}`);
    failed += 1;
  } else {
    console.error(`[tg-tests] ✔ ${label}`);
  }
}

console.error(`[tg-tests] 汇总：${files.length - failed}/${files.length} 个测试文件通过`);
process.exit(failed > 0 ? 1 : 0);
