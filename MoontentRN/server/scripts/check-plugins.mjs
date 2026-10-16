// ============================================================================
// check-plugins.mjs —— 插件层加载自检（不触网）
// ----------------------------------------------------------------------------
// 目的：
// - 逐个动态 import src/plugins 下全部插件文件与 cms 子模块，验证纯 Node /
//   Koa 运行时下模块图完整可加载（语法、依赖解析、JSON with 属性、node:
//   内置模块引用等）；
// - 断言 registry 契约导出（getPlugin / listSites / warmAll）与 10 个主站
//   注册齐全、SitePlugin 继承关系、核心契约方法面、cms 工厂导出形状；
// - 断言 cms 磁盘缓存路径由 import.meta.url 推导并落在 server 根目录
//   （与启动时 cwd 无关，从任意目录运行本脚本行为一致）。
// 约束：全程不触网——绝不调用 listSites / buildCmsPlugins / findCmsPlugin /
// warmAll（它们会触发后台清单拉取、健康探测或冷启动预热请求），也绝不以
// zy_ 前缀调用 getPlugin；仅做 import 与纯本地断言（读磁盘/内置快照除外）。
// 用法：node MoontentRN/server/scripts/check-plugins.mjs（任意 cwd 均可）
// 退出码：任一检查失败 → 1；全部通过 → 0。
// ============================================================================

import { readdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// —— 基于 import.meta.url 推导 server 根目录（scripts/ 的上一级），与 cwd 无关 ——
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const PLUGINS_DIR = path.join(SERVER_ROOT, 'src', 'plugins');

// 10 个主站 id（与 src/plugins/registry.js 静态注册表一致；zy_ 前缀为 cms 资源站群）
const MAIN_IDS = ['yuese', 'avjb', 'aidou', 'hanxiucao', 'zimuquan', 'dsd', 'bf', 'llw', '91pron', 'telegram'];

// 归一化契约的核心方法面（base.js 文件头契约：所有站点插件必须可承接，
// 未覆盖者由基类抛「不支持此接口」——方法本身必须存在于原型链上）
const CONTRACT_METHODS = ['list', 'search', 'detail', 'resolvePlay'];

let passed = 0;
let failed = 0;

// 记录单项检查结果：通过打 ✓，失败打 ✗ 并附原因
function report(ok, label, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`✓ ${label}`);
  } else {
    failed += 1;
    console.log(`✗ ${label}${detail ? ' → ' + detail : ''}`);
  }
}

// ============ ① 枚举并逐个动态 import 全部插件模块 ============

// 收集 plugins 顶层 *.js 与 cms/ 子目录 *.js（排序保证输出顺序稳定）
function listPluginFiles() {
  const out = [];
  for (const name of readdirSync(PLUGINS_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (name.isFile() && name.name.endsWith('.js')) out.push(path.join(PLUGINS_DIR, name.name));
  }
  const cmsDir = path.join(PLUGINS_DIR, 'cms');
  for (const name of readdirSync(cmsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (name.isFile() && name.name.endsWith('.js')) out.push(path.join(cmsDir, name.name));
  }
  return out;
}

console.log(`[check-plugins] 插件目录：${PLUGINS_DIR}`);
console.log('[check-plugins] 阶段 1/3：逐模块动态 import（不触网）');

const files = listPluginFiles();
report(files.length >= 15, '插件模块枚举数量符合预期（顶层 12 个 + cms 子模块 4 个；telegram/ 子目录不经此枚举，经 registry 传递导入）', `实际 ${files.length} 个`);

// relPath（相对 plugins 目录）→ 模块命名空间，供后续阶段取导出
const mods = new Map();
for (const abs of files) {
  const rel = path.relative(PLUGINS_DIR, abs).split(path.sep).join('/');
  let ns = null;
  let err = null;
  try {
    ns = await import(pathToFileURL(abs).href);
  } catch (e) {
    err = e;
  }
  if (err) {
    report(false, `import ${rel}`, `${err.code || err.name || 'Error'}: ${err.message}`);
  } else {
    mods.set(rel, ns);
    report(true, `import ${rel}`);
  }
}

// ============ ② registry 契约导出与主站注册断言 ============

console.log('[check-plugins] 阶段 2/3：registry 契约导出与主站注册');

const registryNs = mods.get('registry.js');
const baseNs = mods.get('base.js');
const cmsIndexNs = mods.get('cms/index.js');

report(!!registryNs, 'registry.js 加载成功');
report(!!baseNs, 'base.js 加载成功');
report(!!cmsIndexNs, 'cms/index.js 加载成功');

if (registryNs && baseNs) {
  const { registry, getPlugin, listSites, warmAll } = registryNs;
  const { SitePlugin } = baseNs;

  // —— 契约导出形状 ——
  report(registry && typeof registry === 'object', 'registry 导出存在');
  report(typeof getPlugin === 'function', '契约导出 getPlugin 为函数');
  report(typeof listSites === 'function', '契约导出 listSites 为函数');
  report(typeof warmAll === 'function', '契约导出 warmAll 为函数');
  report(typeof SitePlugin === 'function', 'base.js 导出 SitePlugin 基类');

  // —— 10 主站注册齐全，且 id 集合与预期完全一致（不多不少） ——
  const regIds = Object.keys(registry).sort();
  report(
    regIds.join(',') === [...MAIN_IDS].sort().join(','),
    'registry 主站 id 集合与预期一致（10 站）',
    `实际：[${regIds.join(', ')}]`
  );

  // —— 逐站断言：继承关系 / id·name·capabilities 自洽 / 核心契约方法面 ——
  for (const id of MAIN_IDS) {
    const p = registry[id];
    if (!p) { report(false, `主站 ${id} 已注册`); continue; }
    const label = `主站 ${id}`;
    report(p instanceof SitePlugin, `${label} 为 SitePlugin 子类实例`);
    report(p.id === id, `${label} id 自洽`, `实际 id=${String(p.id)}`);
    report(typeof p.name === 'string' && p.name.length > 0, `${label} name 非空`, `实际 name=${String(p.name)}`);
    const caps = p.capabilities;
    report(
      !!caps && typeof caps === 'object' && !Array.isArray(caps)
        && Object.keys(caps).length > 0
        && Object.entries(caps).every(([, v]) => typeof v === 'boolean'),
      `${label} capabilities 为非空布尔能力表`,
      `实际：${JSON.stringify(caps)}`
    );
    const missing = CONTRACT_METHODS.filter((m) => typeof p[m] !== 'function');
    report(missing.length === 0, `${label} 核心契约方法面齐全（list/search/detail/resolvePlay）`, `缺失：${missing.join(', ')}`);
  }

  // —— getPlugin 分发（仅同步命中主站与未知 id 两条安全路径；
  //    zy_ 前缀会走 findCmsPlugin → ensureInit → 后台探测触网，本脚本禁止调用） ——
  for (const id of MAIN_IDS) {
    let p = null; let err = null;
    try { p = await getPlugin(id); } catch (e) { err = e; }
    report(!err && p === registry[id], `getPlugin('${id}') 返回对应插件实例`, err ? err.message : '');
  }
  let unknown = 'sentinel'; let unkErr = null;
  try { unknown = await getPlugin('no-such-site'); } catch (e) { unkErr = e; }
  report(!unkErr && unknown === null, "getPlugin 未知 id 返回 null", unkErr ? unkErr.message : `实际返回 ${String(unknown)}`);

  // —— cms 工厂导出形状（只验存在与类型，不调用——调用即触网） ——
  if (cmsIndexNs) {
    const { buildCmsPlugins, findCmsPlugin, cmsSitesMeta } = cmsIndexNs;
    report(typeof buildCmsPlugins === 'function', 'cms 工厂导出 buildCmsPlugins 为函数');
    report(typeof findCmsPlugin === 'function', 'cms 工厂导出 findCmsPlugin 为函数');
    report(typeof cmsSitesMeta === 'function', 'cms 工厂导出 cmsSitesMeta 为函数');
  }
}

// ============ ③ cms 磁盘缓存落点与离线种子断言 ============

console.log('[check-plugins] 阶段 3/3：cms 磁盘缓存落点（cwd 无关）与离线种子');

const sourceNs = mods.get('cms/source.js');
if (sourceNs) {
  // 离线种子：loadSeed 只读磁盘缓存/内置快照（fallback-sources.json），不触网
  let seed = null; let err = null;
  try { seed = await sourceNs.loadSeed(); } catch (e) { err = e; }
  report(!err && !!seed && Array.isArray(seed.entries) && seed.entries.length > 0,
    'cms 离线种子可用（loadSeed 不触网且条目非空）',
    err ? err.message : `条目数=${seed && seed.entries ? seed.entries.length : 0}`);

  // 纯函数抽测：清单校验/排序行为
  try {
    const v = sourceNs.validateEntries([{ name: 'x', api: 'https://a.com/api.php' }, { name: '', api: 'https://b.com' }, 'junk']);
    const s = sourceNs.sortEntries(v);
    report(v.length === 1 && s.length === 1, 'cms validateEntries/sortEntries 纯函数可用');
  } catch (e) {
    report(false, 'cms validateEntries/sortEntries 纯函数可用', e.message);
  }

  // 落点验证：saveDisk 后缓存文件必须出现在 server 根（import.meta.url 推导），
  // 与当前 cwd 无关；验证完即清理，不留测试产物
  const cachePath = path.join(SERVER_ROOT, '.cms-sources.json');
  try {
    if (seed && seed.entries && seed.entries.length) {
      await sourceNs.saveDisk(seed.entries, 0);
      report(existsSync(cachePath), 'cms 磁盘缓存落点位于 server 根目录（.cms-sources.json，cwd 无关）',
        `期望：${cachePath}`);
    }
  } catch (e) {
    report(false, 'cms 磁盘缓存写入', e.message);
  } finally {
    try { rmSync(cachePath); } catch (e) { /* 不存在即无需清理 */ }
  }
} else {
  report(false, 'cms/source.js 加载成功（阶段 3 依赖它）');
}

// ============ 汇总 ============

console.log('------------------------------------------------------------');
console.log(`[check-plugins] 结果：${passed} 项通过，${failed} 项失败`);
if (failed > 0) {
  console.error('[check-plugins] 自检未通过');
  process.exit(1);
}
console.log('[check-plugins] 自检通过');
process.exit(0);
