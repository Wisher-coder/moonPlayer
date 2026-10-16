// ============================================================================
// play-queue.js —— 连播选队纯函数(量贩 → 合集 → 相关推荐的优先级仲裁)
// ----------------------------------------------------------------------------
// 与 NextWeb 观看页(app/video/[site]/[id]/page.js 的 nextUp 组装)同口径:
//   ① 本片在量贩包(含资源站剧集包)内 → 包内紧随其后的下一部;
//   ② 不在包但在合集内 → 首个已就绪合集的下一部(多个合集取先就绪者);
//   ③ 都不在 → 回退「相关推荐」第一个条目(跳过与当前同 id 的自荐);
//   ④ 三者皆空 → null(观看页不出 5 秒倒计时连播浮层)。
// 纯函数:不做任何请求、不改任何入参;数据由观看页取好后整包传入
// (packs={ package?, gathers?, related? }),失败/未就绪的来源直接不传即可。
// ============================================================================

// 从「片单条目」形态里防御式取出 items 数组(兼容三种形态):
//   ① videoPackage/gather 归一形态 { id, title, items:[...] };
//   ② 观看页加载中间态 { id, name, data:{ items }, loading, err }(NextWeb 同款);
//   ③ 裸数组(调用方图省事直接传 items)。
function itemsOf(entry) {
  if (!entry) return null;
  if (Array.isArray(entry)) return entry;
  if (Array.isArray(entry.items)) return entry.items;
  if (entry.data && Array.isArray(entry.data.items)) return entry.data.items;
  return null;
}

// 列表内找当前片,取紧随其后的下一部;不在列表内/已排末位 → null
function nextInList(items, currentId) {
  if (!Array.isArray(items) || currentId == null) return null;
  const i = items.findIndex((v) => v && v.id != null && String(v.id) === String(currentId));
  if (i < 0) return null;
  const nx = items[i + 1];
  return nx && nx.id != null ? nx : null;
}

/**
 * 选出自动连播的下一个视频。
 * @param {object|null} detail 当前片详情(至少含 id;量贩/合集/相关的判断
 *                             依据在 packs 里,不依赖 detail 的其余字段)
 * @param {object|null} packs  三路片源,均可缺省:
 *   package?: videoPackage 归一结果(或其中间态/裸 items)
 *   gathers?: 合集清单数组,元素为 gather 归一结果(或其中间态/裸 items),
 *             逐个按序找首个「已就绪且当前片之后还有下一部」的
 *   related?: 相关推荐条目数组(ListResult.items)
 * @returns {object|null} 下一个 VideoItem 形态条目({id,title,cover,...}),
 *                       无可连播项时 null;条目原样返回不复制(调用方按需补 site)
 */
export function pickNext(detail, packs) {
  const currentId = detail ? detail.id : null;
  const p = packs || {};

  // ① 量贩包内下一个(package 是保留字,但作为属性访问完全合法)
  const pkgNext = nextInList(itemsOf(p.package), currentId);
  if (pkgNext) return pkgNext;

  // ② 首个就绪合集的下一个
  const gathers = Array.isArray(p.gathers) ? p.gathers : [];
  for (let gi = 0; gi < gathers.length; gi++) {
    const nx = nextInList(itemsOf(gathers[gi]), currentId);
    if (nx) return nx;
  }

  // ③ 相关推荐第一个(防御跳过自荐:个别站相关列表会混入当前片)
  const related = Array.isArray(p.related) ? p.related : [];
  for (let ri = 0; ri < related.length; ri++) {
    const r = related[ri];
    if (r && r.id != null && String(r.id) !== String(currentId)) return r;
  }

  // ④ 无可连播项
  return null;
}
