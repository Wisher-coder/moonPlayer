#!/usr/bin/env node
// ============================================================================
// 语法自检脚本（syntax-check，脚手架阶段交付，后续各阶段共用）
// ----------------------------------------------------------------------------
// 职责：用工程内 @babel/core + babel-preset-expo（即 app/babel.config.js 全量
// 预设，含 NativeWind）逐个转译 src/ 下全部 .js/.jsx 文件，捕获语法错误。
// 约定：
// - cwd 固定为 app 工程根（由本文件位置推导，与调用方所在目录无关）；
// - 禁用一切缓存，每次全量转译；
// - 语法错误逐个文件打印（含行/列定位），任一失败即 exit 1；
// - src/ 下没有任何 .js/.jsx 视为异常（骨架至少有路由文件），同样 exit 1。
// 用法：node scripts/syntax-check.mjs（在 app/ 下执行 `npm run syntax-check` 等价）
// ============================================================================

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// 工程内依赖须以 app 根为基准解析（本脚本可能被仓库任意位置调用）
const require = createRequire(import.meta.url);

// —— 定位 app 工程根（scripts/ 的上一级），并把 cwd 切过去 ——
const __filename = fileURLToPath(import.meta.url);
const APP_ROOT = path.resolve(path.dirname(__filename), '..');
process.chdir(APP_ROOT);

const babel = require('@babel/core');

/** 递归收集目录下全部 .js/.jsx 文件 */
async function collect(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await collect(p)));
    } else if (/\.(js|jsx)$/.test(ent.name)) {
      out.push(p);
    }
  }
  return out;
}

const srcDir = path.join(APP_ROOT, 'src');
const files = (await collect(srcDir)).sort();

if (files.length === 0) {
  console.error('[syntax-check] 失败：src/ 下未找到任何 .js/.jsx 文件');
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const rel = path.relative(APP_ROOT, file).split(path.sep).join('/');
  try {
    const code = await readFile(file, 'utf8');
    await babel.transformAsync(code, {
      filename: file,
      cwd: APP_ROOT,
      // 只读工程内 babel.config.js（含 babel-preset-expo + NativeWind 预设），
      // 不读用户主目录配置；
      // 注：@babel/core 的 transformAsync 单次调用即为全量转译，
      // 本身不存在持久缓存（缓存属 babel-loader/babel-jest 等封装层），
      // 因此不传任何缓存选项即为严格意义上的「禁用缓存」
      babelrc: false,
      configFile: path.join(APP_ROOT, 'babel.config.js'),
    });
    console.log(`[syntax-check] 通过 ${rel}`);
  } catch (err) {
    failed += 1;
    const loc = err.loc ? `（第 ${err.loc.line} 行第 ${err.loc.column} 列）` : '';
    // 逐行打印错误信息（保留 babel 的代码帧提示）
    const lines = String(err.message).split('\n');
    console.error(`[syntax-check] 失败 ${rel}${loc}`);
    for (const line of lines) {
      if (line.trim() !== '') console.error(`    ${line}`);
    }
  }
}

if (failed > 0) {
  console.error(`[syntax-check] 结果：${failed}/${files.length} 个文件语法检查失败`);
  process.exit(1);
}

console.log(`[syntax-check] 结果：全部 ${files.length} 个文件语法检查通过`);
process.exit(0);
