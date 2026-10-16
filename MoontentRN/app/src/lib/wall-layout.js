// ============================================================================
// wall-layout.js —— 「视频大屏看板」混合宽高比视频墙布局算法
// ----------------------------------------------------------------------------
// 移植自 NextWeb/src/lib/wall-layout.js,逐行照搬:纯函数,无 React/RN/DOM 依赖
// (RN 三端与 web 共用同一份,输入 n 个 tile 的宽高比数组与内容盒尺寸,输出
// 每个 tile 的绝对定位(x/y/w/h)与布局总高;观看侧 WallOverlay 用 RN 的
// onLayout 测量内容盒替代 ResizeObserver,喂进来的数值语义与 web 完全一致)。
// 设计目标(四条,按优先级):
//   ① 每个 tile 精确保持自身宽高比,绝不拉伸也不裁切——由构造保证(宽 = 行高×
//      比例),不是数值近似,视频 contain 原样铺;② 各 tile 面积近似均等
//      (视觉权重一致);③ 水平方向行内零黑边,每行行内两端对齐、行宽正好铺满
//      W;④ 整屏不溢出、格间零缝隙——垂直超出整体等比缩放(比例不变,行变窄
//      → 整体水平居中,黑边收在左右外侧),垂直不足整组垂直居中(黑边收在上下
//      外侧);**绝不摊大行距**(格间黑带最难看),也绝不放大破坏比例。
// 算法 = Flickr justified-layout 思想(按行聚合宽高比、行内统一行高)+ 经典
// linear-partition 动态规划求全局最优行划分(贪心逐行塞会导致后面几行比例
// 失衡,DP 才能全局权衡):
//   1) 等面积目标:单 tile 目标面积 A = W·H/n,目标尺寸 w=√(A·r)、h=√(A/r);
//   2) 行数 k=1..n 逐个尝试:理想均分行高 targetH_k=(H-gap·(k-1))/k,用 DP 把
//      序列切成 k 条连续行(保持原顺序),最小化 cost=Σ(行高-targetH_k)²,
//      所有 k 里取代价最小者;k 行的行距就吃掉 gap·(k-1),剩余高度不够分的 k
//      直接跳过;单行严重超高也允许(k=1 永远候选),交给第 4 步缩放兜底;
//   3) 行内两端对齐:行高由「行内比例和填满行宽」反解 h=(W-gap·(m-1))/Σr,
//      tile 宽 = h·r_i,行内依序排开间距 gap——行宽构造性等于 W;
//   4) 垂直装配:总高 Σh+gap·(k-1) > H → 行高整体等比缩放 scale=
//      (H-gap·(k-1))/(Σh)(只缩不放,比例不变),行距不变,行宽不再满 W,
//      整体水平居中(黑边收在左右外侧);总高 < H → 整组垂直居中 y0=
//      (H-总高)/2(黑边收在上下外侧,不摊行距);
//   5) 数值防御:非法参数/空数组返回 { tiles: [], height: 0 },行高、缩放系数
//      等中间量一律钳到有限正数;n=1 时行高自然收敛为 min(H, W/r)。
// 复杂度:每个 k 的 DP 是 O(n²),总 O(n³),n≤16(看板上限)时微不足道;
// 调用时机:看板开面板、增删项、ratio 回写导致比例签名变化时重算一次。
// ============================================================================
export function computeWallLayout(ratios, W, H, gap) {
  // —— 参数防御:数组空/尺寸非正/gap 负 → 空布局,调用方按 0 格处理 ——
  if (!Array.isArray(ratios) || ratios.length === 0) return { tiles: [], height: 0 };
  if (!isFinite(W) || W <= 0 || !isFinite(H) || H <= 0) return { tiles: [], height: 0 };
  if (!isFinite(gap) || gap < 0) gap = 0;
  const rs = ratios.map((r) => (isFinite(r) && r > 0 ? r : 16 / 9)); // 单点非法比例回退 16:9
  const n = rs.length;

  // ratio 前缀和:S[j] = 前 j 个 ratio 之和,一行 [a,b) 的比例和即 S[b]-S[a]
  const S = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) S[i + 1] = S[i] + rs[i];

  // 单行 [a,b) 的行高:行内 tile 宽 = 行高×r,Σ宽 + gap·(b-a-1) = W 反解。
  // 可用宽非正(gap 太大、行太长)返回 NaN 表示该行不可行。
  const rowHeight = (a, b) => {
    const uw = W - gap * (b - a - 1);
    if (!(uw > 0)) return NaN;
    return uw / (S[b] - S[a]);
  };

  // 把序列切成 k 条连续行、最小化 Σ(行高-targetH)² 的 DP:
  // dp[m][j] = 前 j 个切成 m 行的最小代价,pick[m][j] 记最优切点供回溯。
  // j 的上界 n-(k-m) 保证后面每行至少还剩 1 个元素可切。
  const partitionBest = (k, targetH) => {
    const INF = Infinity;
    const dp = [], pick = [];
    for (let m = 0; m <= k; m++) {
      dp.push(new Float64Array(n + 1).fill(INF));
      pick.push(new Int32Array(n + 1).fill(-1));
    }
    dp[0][0] = 0;
    for (let m = 1; m <= k; m++) {
      for (let j = m; j <= n - (k - m); j++) {
        let best = INF, arg = -1;
        for (let a = m - 1; a < j; a++) {
          const prev = dp[m - 1][a];
          if (prev === INF) continue;
          const h = rowHeight(a, j);
          if (!isFinite(h)) continue; // 该行放不下(gap 吃光行宽)
          const cost = prev + (h - targetH) * (h - targetH);
          if (cost < best) { best = cost; arg = a; }
        }
        dp[m][j] = best;
        pick[m][j] = arg;
      }
    }
    if (dp[k][n] === INF) return null;
    const rows = [];
    let j = n;
    for (let m = k; m >= 1; m--) {
      const a = pick[m][j];
      rows.push([a, j]);
      j = a;
    }
    return rows.reverse(); // [[a0,b0],[a1,b1],...] 按原顺序的行划分
  };

  // —— 第 2 步:对每个可行行数 k 跑 DP,取代价最小的行数 ——
  let bestRows = null, bestCost = Infinity;
  for (let k = 1; k <= n; k++) {
    const vgaps = gap * (k - 1);
    if (H - vgaps <= 0) break; // 行距已超总高,更大的 k 更不可行
    const targetH = (H - vgaps) / k;
    const rows = partitionBest(k, targetH);
    if (!rows) continue;
    let cost = 0;
    for (const [a, b] of rows) {
      const dh = rowHeight(a, b) - targetH;
      cost += dh * dh;
    }
    if (cost < bestCost) { bestCost = cost; bestRows = rows; }
  }
  // 兜底:极端参数下所有 k 都不可行(W>0 时单 tile 行理论恒可行,纯防御),
  // 退化成单行,行高给个极小正值,后续缩放路径保证不溢出
  if (!bestRows) bestRows = [[0, n]];

  // —— 行高数组(全部钳到有限正数,防御 NaN/0 混入装配阶段)——
  const k = bestRows.length;
  const hs = bestRows.map(([a, b]) => {
    const h = rowHeight(a, b);
    return isFinite(h) && h > 0 ? h : 1e-6;
  });

  // —— 第 4 步:垂直装配的缩放/居中两种姿态(绝不摊行距、绝不放大)——
  const totalH = hs.reduce((s, h) => s + h, 0) + gap * (k - 1);
  let scale = 1, y0 = 0;
  if (totalH > H) {
    // 垂直溢出:Σ行高 等比缩放到 H-gap·(k-1)(行距不变,比例不变),只缩不放;
    // 行宽随之不足 W,装配时整体水平居中——黑边收在左右外侧
    const inner = totalH - gap * (k - 1);
    scale = inner > 0 ? (H - gap * (k - 1)) / inner : 1;
    if (!isFinite(scale) || scale <= 0) scale = 1e-6;
    if (scale > 1) scale = 1;
  } else if (totalH < H) {
    // 垂直不足:整组垂直居中——黑边收在上下外侧;不摊大行距(格间黑带最难看),
    // 不放大(会破坏精确比例/满行宽)
    y0 = (H - totalH) / 2;
  }

  // —— 第 3 步 + 装配:逐行排 tile ——
  const tiles = new Array(n);
  let y = y0;
  for (let ri = 0; ri < k; ri++) {
    const [a, b] = bestRows[ri];
    const h = hs[ri] * scale;
    const gaps = gap * (b - a - 1);
    let rowW = gaps;
    for (let i = a; i < b; i++) rowW += h * rs[i];
    // 未缩放时 rowW 构造性等于 W,起点直接取 0(消除浮点残差导致的 -1e-13 越界);
    // 缩放后行宽不足 W,整体水平居中(黑边收在左右外侧)
    let x = scale < 1 ? (W - rowW) / 2 : 0;
    if (!(x > 0)) x = 0;
    for (let i = a; i < b; i++) {
      const w = h * rs[i];
      tiles[i] = { i, x, y, w, h };
      x += w + gap;
    }
    y += h + gap;
  }
  // 溢出缩放/垂直居中两种姿态下 y 都是 y0+总高 ≤ H(末行多累一次 gap,扣除)
  return { tiles, height: y - gap };
}
