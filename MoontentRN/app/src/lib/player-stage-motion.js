// 舞台布局基点与常驻 pan 分开保存；吸附完成不重基布局、不摘挂动画节点。
export function stageRectWithPan(rect, x, y) {
  return rect ? { ...rect, x: rect.x + x, y: rect.y + y } : null;
}

export function stageLayoutForTarget(target, x, y) {
  return { ...target, x: target.x - x, y: target.y - y };
}

export function stageDragOffset(rect, start, gesture, width, height) {
  const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
  return {
    x: clamp(start.x + gesture.dx, -rect.x, Math.max(0, width - rect.w) - rect.x),
    y: clamp(start.y + gesture.dy, -rect.y, Math.max(0, height - rect.h) - rect.y),
  };
}

export function createStagePanMotion(anim) {
  let generation = 0;
  let active = null;

  const stop = () => {
    // stop/setValue 都可能同步触发旧完成回调，必须先作废旧轮次。
    generation += 1;
    const previous = active;
    active = null;
    if (previous) previous.run.stop();
    anim.panX.stopAnimation();
    anim.panY.stopAnimation();
    if (previous?.dismiss) anim.stageOpacity.setValue(1);
  };

  return {
    stop,
    start(run, onDone, { dismiss = false } = {}) {
      stop();
      const ticket = generation;
      active = { run, dismiss };
      run.start(({ finished }) => {
        if (ticket !== generation || active?.run !== run) return;
        active = null;
        if (finished) onDone();
        else if (dismiss) anim.stageOpacity.setValue(1);
      });
    },
  };
}
