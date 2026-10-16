// ============================================================================
// gen-icons.mjs —— 图标桶生成器（icons.config.mjs → src/components/icons.js）
// ----------------------------------------------------------------------------
// 数据源 @iconify-json/solar（IconifyJSON，离线），取每枚图标的 body（内层
// SVG 片段）编译为 react-native-svg 元素树。Metro 不做 tree-shaking，生成桶
// 只打入配置里实际选用的图标数据；不引入任何运行时图标库依赖。
//
// 编译期归一（让生成组件的 props 行为与 lucide 习惯对齐）：
//   1. 元素级 fill="none" 提升为根级默认（fill prop 可覆盖，如 ▶ 实心标记）；
//   2. 元素级 stroke="currentColor" 提升为根级 stroke=color（color prop 控制）；
//   3. 元素级 stroke-width 全等时提升为根级默认（strokeWidth prop 可覆盖）。
// 遇到不支持的元素 / 属性 / 多色填充直接报错退出，防止静默错图。
// 用法：npm run gen:icons（在 app/ 目录下执行）
// ============================================================================
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../icons.config.mjs';

const require = createRequire(import.meta.url);
const solar = require('@iconify-json/solar/icons.json');
const { getIconData } = require('@iconify/utils');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/components/icons.js');

// —— SVG 元素白名单：react-native-svg 组件一一对应 ——
const TAGS = new Set(['g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);

// —— 属性白名单：值透传 + kebab-case → camelCase 改写表 ——
const ATTR_CAMEL = {
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'stroke-dasharray': 'strokeDasharray',
  'stroke-dashoffset': 'strokeDashoffset',
  'stroke-opacity': 'strokeOpacity',
  'fill-opacity': 'fillOpacity',
  'fill-rule': 'fillRule',
  'clip-rule': 'clipRule',
};
const ATTRS = new Set([
  'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'x2', 'y1', 'y2',
  'width', 'height', 'points', 'transform', 'opacity',
  'fill', 'stroke', ...Object.keys(ATTR_CAMEL), ...Object.values(ATTR_CAMEL),
]);

// 解析 body（Iconify 的紧凑内层 SVG：无文本节点/注释/CDATA，属性值不含引号）
const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g;
const ATTR_RE = /([\w:-]+)="([^"]*)"/g;

function parseAttrs(raw, where, errors) {
  const p = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(raw))) {
    const [, k, v] = m;
    const key = ATTR_CAMEL[k] ?? k;
    if (!ATTRS.has(key)) {
      errors.push(`${where}: 不支持的属性 "${k}"（值 "${v}"）`);
      continue;
    }
    p[key] = v;
  }
  return p;
}

function parseBody(body, where, errors) {
  const root = { c: [] };
  const stack = [root];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(body))) {
    const [, close, tag, rawAttrs, selfClose] = m;
    if (!TAGS.has(tag)) {
      errors.push(`${where}: 不支持的元素 "<${tag}>"（多色/渐变/动画图标未纳入支持范围）`);
      continue;
    }
    if (close) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = { t: tag, p: parseAttrs(rawAttrs, where, errors) };
    const top = stack[stack.length - 1];
    top.c ??= [];
    top.c.push(node);
    if (!selfClose) stack.push(node);
  }
  if (stack.length !== 1) errors.push(`${where}: body 标签未闭合`);
  return root.c;
}

// 归一：收集并提升 fill/stroke/strokeWidth，返回根级描述
function normalize(nodes, where, errors) {
  const fills = new Set();
  const strokes = new Set();
  const sws = new Set();
  (function walk(list) {
    for (const n of list) {
      if (n.p.fill !== undefined) fills.add(n.p.fill);
      if (n.p.stroke !== undefined) strokes.add(n.p.stroke);
      if (n.p.strokeWidth !== undefined) sws.add(n.p.strokeWidth);
      if (n.c) walk(n.c);
    }
  })(nodes);

  const fillMode = fills.size === 0 ? 'none'
    : fills.size === 1 && fills.has('none') ? 'none'
      : fills.size === 1 && fills.has('currentColor') ? 'color'
        : 'mixed';
  const strokeMode = strokes.size === 0 ? 'off'
    : strokes.size === 1 && strokes.has('currentColor') ? 'color'
      : 'mixed';
  if (fillMode === 'mixed') errors.push(`${where}: 混合 fill 值 [${[...fills].join(', ')}]，疑似多色图标`);
  if (strokeMode === 'mixed') errors.push(`${where}: 混合 stroke 值 [${[...strokes].join(', ')}]`);
  if (sws.size > 1) errors.push(`${where}: stroke-width 不一致 [${[...sws].join(', ')}]，无法提升覆盖默认值`);
  const sw = sws.size ? Number([...sws][0]) : 1.5; // Solar linear 全系 1.5

  (function strip(list) {
    for (const n of list) {
      if (n.p.fill === 'none' || n.p.fill === 'currentColor') delete n.p.fill;
      if (n.p.stroke === 'currentColor') delete n.p.stroke;
      if (n.p.strokeWidth !== undefined) delete n.p.strokeWidth;
      if (n.c) strip(n.c);
    }
  })(nodes);

  return { fc: fillMode === 'color', st: strokeMode === 'color', sw };
}

// 节点树序列化为带缩进的 JS 字面量
function fmtNodes(nodes, indent) {
  const inner = ' '.repeat(indent + 2);
  const one = (n) => {
    const p = Object.keys(n.p).length ? `p: ${JSON.stringify(n.p)}, ` : '';
    if (!n.c || !n.c.length) return `${inner}{ t: '${n.t}', ${p}},`;
    return `${inner}{ t: '${n.t}', ${p}c: [\n${n.c.map(one).join('\n')}\n${inner}]},`;
  };
  return `[\n${nodes.map(one).join('\n')}\n${' '.repeat(indent)}],`;
}

const errors = [];
const entries = [];
for (const [exportName, [iconName, note]] of Object.entries(config)) {
  const where = `${exportName} ← ${iconName}`;
  const [prefix, name] = iconName.split(':');
  if (prefix !== 'solar') {
    errors.push(`${where}: 目前仅支持 solar 集前缀`);
    continue;
  }
  const data = getIconData(solar, name);
  if (!data) {
    errors.push(`${where}: solar 集中不存在该图标（名字或变体后缀有误）`);
    continue;
  }
  const nodes = parseBody(data.body, where, errors);
  const { fc, st, sw } = normalize(nodes, where, errors);
  const vb = `0 0 ${data.width ?? 24} ${data.height ?? 24}`;
  entries.push({ exportName, note, vb, fc, st, sw, nodes });
}

if (errors.length) {
  console.error(`\n[gen-icons] 生成失败，共 ${errors.length} 处问题：`);
  for (const e of errors) console.error('  ✗ ' + e);
  process.exit(1);
}

const banner = `// ============================================================================
// icons.js —— Iconify(Solar) 图标桶（由 scripts/gen-icons.mjs 生成，勿手改）
// ----------------------------------------------------------------------------
// 选型清单与功能理由见 app/icons.config.mjs；改图标 / 加图标：改配置后在
// app/ 下跑 \`npm run gen:icons\` 重新生成本文件。数据源 @iconify-json/solar
// 经编译期转换为 react-native-svg 元素树，无任何运行时图标库依赖；Metro
// 不做 tree-shaking，本桶只含实际选用的图标数据。
//
// 组件 props（与 lucide 习惯对齐）：size / color / strokeWidth / fill /
// opacity，其余属性透传 react-native-svg（如 style）。
// ============================================================================`;

const factory = `import React from 'react';
import { Svg, G, Path, Circle, Ellipse, Rect, Line, Polyline, Polygon } from 'react-native-svg';

const TAGS = { g: G, path: Path, circle: Circle, ellipse: Ellipse, rect: Rect, line: Line, polyline: Polyline, polygon: Polygon };

function renderNode(node, key) {
  const Comp = TAGS[node.t];
  const kids = node.c ? node.c.map((k, i) => renderNode(k, key + '-' + i)) : null;
  return <Comp key={key} {...node.p}>{kids}</Comp>;
}

function createIcon(name, def) {
  const Icon = React.forwardRef(function Icon({ size = 24, color, fill, strokeWidth, ...rest }, ref) {
    return (
      <Svg
        ref={ref}
        width={size}
        height={size}
        viewBox={def.vb}
        fill={fill != null ? fill : def.fc ? color : 'none'}
        stroke={def.st ? color : undefined}
        strokeWidth={strokeWidth != null ? strokeWidth : def.sw}
        {...rest}
      >
        {def.n.map((node, i) => renderNode(node, String(i)))}
      </Svg>
    );
  });
  Icon.displayName = name;
  return Icon;
}
`;

const body = entries.map((e) => {
  const head = `// ${e.note}\nexport const ${e.exportName} = createIcon('${e.exportName}', {\n`
    + `  vb: '${e.vb}', fc: ${e.fc}, st: ${e.st}, sw: ${e.sw},\n`
    + `  n: ${fmtNodes(e.nodes, 2).trimEnd()}\n`
    + `});`;
  return head;
}).join('\n\n');

const out = `${banner}\n\n${factory}\n${body}\n`;
writeFileSync(OUT, out);

const bytes = Buffer.byteLength(out);
console.log(`[gen-icons] 已生成 ${entries.length} 枚图标 → ${OUT}`);
console.log(`[gen-icons] 文件体积 ${(bytes / 1024).toFixed(1)} KB（Solar linear · stroke-width ${[...new Set(entries.map((e) => e.sw))].join('/')}）`);
