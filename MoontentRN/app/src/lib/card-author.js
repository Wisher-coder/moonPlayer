// ============================================================================
// card-author.js —— 卡片作者随行（avjb 游客态详情页不带作者，从列表卡随行）
// ----------------------------------------------------------------------------
// 语义同 NextWeb/src/lib/card-author.js：仅真实作者体系站点的列表卡片带 author
// 字段，从卡片进入观看页时把该作者暂存于此，观看页作者行读它展示（深链直达
// 无此数据则不显示，与「无作者站点不出现作者占位」同一原则，不造假）。
// 键 'moontent_card_author'（AsyncStorage），形态 { "{site}:{id}": author }，
// 条目上限 200（对象键插入序即最近访问序，超限丢最旧）。
// RN 化：AsyncStorage 异步 → 读写均返回 Promise。
// ============================================================================
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'moontent_card_author';
const MAX = 200;

async function readAll() {
  try {
    const v = await AsyncStorage.getItem(KEY);
    const j = JSON.parse(v || '{}');
    return j && typeof j === 'object' ? j : {};
  } catch (_e) {
    return {}; // JSON 损坏等异常按空处理
  }
}

// 记住一条「视频 → 作者」（无 author 字段的条目静默跳过）
export async function rememberCardAuthor(site, v) {
  if (!site || !v || v.id == null || !v.author || v.author.id == null) return;
  try {
    const all = await readAll();
    delete all[site + ':' + v.id]; // 重插到尾部，维持插入序=最近访问序
    all[site + ':' + v.id] = v.author;
    const keys = Object.keys(all);
    if (keys.length > MAX) for (const k of keys.slice(0, keys.length - MAX)) delete all[k];
    await AsyncStorage.setItem(KEY, JSON.stringify(all));
  } catch (_e) { /* 存储不可用：静默降级为不展示 */ }
}

// 取某视频的随行作者（无则 null）
export async function getCardAuthor(site, id) {
  if (!site || id == null) return null;
  const all = await readAll();
  return all[site + ':' + id] || null;
}
