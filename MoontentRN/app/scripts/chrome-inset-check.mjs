#!/usr/bin/env node
// ============================================================================
// chrome-inset-check.mjs —— 壳层避让静态检查（防「页面被悬浮顶/底栏盖住」回归）
// ----------------------------------------------------------------------------
// 背景：手机画幅下顶/底栏是 AppShell 的 overlay 悬浮条（内容全出血铺满整屏），
// 页面滚动内容必须自垫避让（useChromeInsets / ScreenScrollView），漏垫就是
// 「插件管理页顶栏盖内容」这类回归（plugins/board/album/author/package 页的
// 历史病灶）。
// 规则：src/app/** 下每个页面文件必须满足其一——
//   · import use-chrome-scroll（useChromeInsets / useChromeScroll）；
//   · import ScreenScrollView（内部即调 useChromeInsets）；
//   · import react-native-safe-area-context（沉浸页自管安全区：video/search）。
// 例外（ALLOWLIST）：_*/+* 前缀框架文件（_layout 布局壳、+html 导出模板）；
// menu.js（Electron 菜单子窗，AppShell 外渲染，无悬浮栏）。新页面都不满足 →
// 报错；接入方式见 src/hooks/use-chrome-scroll.js 头注。
// ============================================================================
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(root, 'src/app');
const PASS_MARKS = [
  'use-chrome-scroll',
  'ScreenScrollView',
  'react-native-safe-area-context',
];
const ALLOWLIST = new Set([
  'menu.js', // Electron 菜单子窗，AppShell 外渲染，无悬浮栏
]);

async function collect(dir, out = []) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) await collect(p, out);
    else if (/\.[jt]sx?$/.test(ent.name) && !/^[_+]/.test(ent.name)) out.push(p);
  }
  return out;
}

const files = await collect(APP_DIR);
const offenders = [];
for (const f of files) {
  if (ALLOWLIST.has(path.basename(f))) continue;
  const src = await readFile(f, 'utf8');
  if (!PASS_MARKS.some((m) => src.includes(m))) offenders.push(path.relative(root, f));
}

if (offenders.length) {
  console.error('以下页面未接入壳层避让体系（useChromeInsets / ScreenScrollView / 自管 safe-area）：');
  for (const rel of offenders) console.error('  - ' + rel);
  console.error('接入方式见 src/hooks/use-chrome-scroll.js 头注；确属例外（壳外渲染）请加进本脚本 ALLOWLIST。');
  process.exit(1);
}
console.log(`chrome-inset-check: ${files.length} 个页面文件全部接入壳层避让体系 ✓`);
