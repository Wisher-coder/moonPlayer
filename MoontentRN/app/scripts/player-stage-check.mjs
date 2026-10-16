#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const motionPath = path.join(root, 'src/lib/player-stage-motion.js');
const motionSource = await readFile(motionPath, 'utf8');
const {
  createStagePanMotion, stageRectWithPan, stageLayoutForTarget, stageDragOffset,
} = await import(`data:text/javascript;base64,${Buffer.from(motionSource).toString('base64')}`);
const playerSource = await readFile(path.join(root, 'src/lib/player-context.jsx'), 'utf8');
const ast = parse(playerSource, { sourceType: 'module', plugins: ['jsx'] });
function visit(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') fn(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => visit(child, fn));
    else if (value && typeof value === 'object') visit(value, fn);
  }
}
const declarations = new Map();
visit(ast, (node) => {
  if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
    declarations.set(node.id.name, node.init);
  }
});
function callback(name) {
  const node = declarations.get(name)?.arguments?.[0];
  assert.ok(node, `缺少 ${name} 回调`);
  return playerSource.slice(node.start, node.end);
}
function value(initial = 0) {
  let current = initial;
  return { __getValue: () => current, setValue: (v) => { current = v; }, stopAnimation() {} };
}
function runMock() {
  let done;
  return {
    start(cb) { done = cb; },
    stop() { done?.({ finished: false }); },
    finish(finished = true) { done?.({ finished }); },
  };
}
function animationHarness() {
  const runs = [];
  const Animated = {
    timing(node, { toValue }) {
      const run = runMock();
      run.apply = () => node.setValue(toValue);
      runs.push(run);
      return run;
    },
    parallel(children) {
      const run = runMock();
      run.apply = () => children.forEach((child) => child.apply());
      runs.push(run);
      return run;
    },
  };
  return { Animated, runs };
}
let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`[player-stage-check] 通过 ${name}`);
}

check('目标几何包含常驻偏移，展开/缩小/旋转不叠加第二份 pan', () => {
  for (const pan of [{ x: 0, y: -484 }, { x: 140, y: 270 }, { x: -80, y: -720 }]) {
    for (const target of [
      { x: 12, y: 56, w: 366, h: 206 },
      { x: 0, y: 103, w: 390, h: 219 },
      { x: 0, y: 0, w: 844, h: 390 },
    ]) {
      const layout = stageLayoutForTarget(target, pan.x, pan.y);
      assert.deepEqual(stageRectWithPan(layout, pan.x, pan.y), target);
    }
  }
});

check('连续拖动从当前偏移开始，不跳回布局基点', () => {
  const rect = { x: 12, y: 540, w: 366, h: 206 };
  const start = { x: 0, y: -484 };
  const next = stageDragOffset(rect, start, { dx: 3, dy: 40 }, 390, 844);
  assert.deepEqual(next, { x: 3, y: -444 });
  assert.equal(stageRectWithPan(rect, next.x, next.y).y, 96);
});

check('拖动钳制实际视觉位置，布局基点可以合法地在屏外', () => {
  const rect = { x: -150, y: 900, w: 366, h: 206 };
  for (const dx of [-10000, -1, 0, 1, 10000]) {
    for (const dy of [-10000, -1, 0, 1, 10000]) {
      const pan = stageDragOffset(rect, { x: 162, y: -844 }, { dx, dy }, 390, 844);
      const placed = stageRectWithPan(rect, pan.x, pan.y);
      assert.ok(placed.x >= 0 && placed.x + placed.w <= 390);
      assert.ok(placed.y >= 0 && placed.y + placed.h <= 844);
    }
  }
});

check('停止动画先作废轮次，同步 finished=false 和滞后 true 均不能落定', () => {
  const anim = { panX: value(), panY: value(), stageOpacity: value(1) };
  const motion = createStagePanMotion(anim);
  let oldCommits = 0;
  let newCommits = 0;
  const old = runMock();
  motion.start(old, () => oldCommits++);
  const next = runMock();
  motion.start(next, () => newCommits++);
  old.finish();
  assert.equal(oldCommits, 0);
  next.finish();
  next.finish();
  assert.equal(newCommits, 1);
});

check('异常完成不提交角落；中断甩关恢复透明度且不会关闭会话', () => {
  const anim = { panX: value(), panY: value(), stageOpacity: value(1) };
  const motion = createStagePanMotion(anim);
  let closes = 0;
  const failed = runMock();
  motion.start(failed, () => closes++);
  failed.finish(false);
  assert.equal(closes, 0);
  const dismiss = runMock();
  motion.start(dismiss, () => closes++, { dismiss: true });
  anim.stageOpacity.setValue(0.2);
  motion.stop();
  dismiss.finish();
  assert.equal(closes, 0);
  assert.equal(anim.stageOpacity.__getValue(), 1);
  const completed = runMock();
  motion.start(completed, () => closes++, { dismiss: true });
  completed.finish();
  assert.equal(closes, 1);
});

check('真实吸附/落定回调不改 rect、不清零 pan、不启动 FLIP', () => {
  const { Animated, runs } = animationHarness();
  const anim = { panX: value(0), panY: value(-430), stageOpacity: value(1), ctrl: value(0) };
  const rect = { x: 12, y: 540, w: 366, h: 206, r: 12 };
  const rectRef = { current: rect };
  const phaseRef = { current: 'mini' };
  const miniCornerRef = { current: 'br' };
  const miniRectOf = (corner) => ({ ...rect, y: corner[0] === 't' ? 56 : 540 });
  const panMotion = createStagePanMotion(anim);
  const context = vm.createContext({
    Animated, anim, rectRef, phaseRef, miniCornerRef, miniRectOf, panMotion,
    SNAP_MS: 240, NATIVE: true, Easing: { out: (v) => v, cubic: 'cubic' },
  });
  const commitMini = vm.runInContext(`(${callback('commitMini')})`, context);
  context.commitMini = commitMini;
  const snapToCorner = vm.runInContext(`(${callback('snapToCorner')})`, context);
  snapToCorner(12, 110);
  const snap = runs.at(-1);
  snap.apply();
  snap.finish();
  assert.equal(miniCornerRef.current, 'tl');
  assert.strictEqual(rectRef.current, rect);
  assert.equal(anim.panY.__getValue(), -484);
  assert.equal(stageRectWithPan(rect, 0, anim.panY.__getValue()).y, 56);
  phaseRef.current = 'docked';
  commitMini('br');
  assert.equal(miniCornerRef.current, 'tl');
});

check('相位/视口变化作废旧吸附，不会晚提交旧角落', () => {
  const { Animated, runs } = animationHarness();
  const anim = { panX: value(), panY: value(), stageOpacity: value(1) };
  const rectRef = { current: { x: 12, y: 540, w: 366, h: 206 } };
  const phaseRef = { current: 'mini' };
  const panMotion = createStagePanMotion(anim);
  let commits = 0;
  const context = vm.createContext({
    Animated, anim, rectRef, phaseRef, panMotion, commitMini: () => commits++,
    miniRectOf: () => ({ x: 12, y: 56, w: 366, h: 206 }),
    SNAP_MS: 240, Easing: { out: (v) => v, cubic: 'cubic' },
  });
  const snapToCorner = vm.runInContext(`(${callback('snapToCorner')})`, context);
  snapToCorner(12, 56);
  const obsolete = runs.at(-1);
  panMotion.stop();
  obsolete.finish();
  assert.equal(commits, 0);
  snapToCorner(12, 56);
  phaseRef.current = 'expanding';
  runs.at(-1).finish();
  assert.equal(commits, 0);
});

check('L1 的两个平移绑定跨相位常驻，不回退静态零值', () => {
  let transform;
  visit(ast, (node) => {
    if (node.type !== 'JSXOpeningElement' || node.name.type !== 'JSXMemberExpression' ||
        node.name.object.name !== 'Animated' || node.name.property.name !== 'View') return;
    const style = node.attributes.find((a) => a.type === 'JSXAttribute' && a.name.name === 'style');
    const elements = style?.value?.expression?.elements;
    if (elements?.[0]?.type !== 'MemberExpression' || elements[0].property.name !== 'layer1') return;
    transform = elements[1].properties.find((p) => p.key.name === 'transform')?.value;
  });
  assert.equal(transform?.type, 'ArrayExpression');
  assert.equal(transform.elements[0].properties[0].value.property.name, 'panX');
  assert.equal(transform.elements[1].properties[0].value.name, 'panYScroll');
  assert.ok(!declarations.has('panActive'));
});

console.log(`[player-stage-check] 结果：${passed} 项回归检查全部通过`);
