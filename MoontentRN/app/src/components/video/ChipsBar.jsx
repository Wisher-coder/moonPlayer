// chips 横滚条（RN 三端移植，源：NextWeb ChipsBar.jsx）
// ----------------------------------------------------------------------------
// YouTube 话题 chip 横滚条：规格取 YouTube 实测（chip-shape 元素计算样式）——
// 32 高、圆角 8（不是胶囊！）、左右内边距 12、字号 14、字重 500；非激活
// surface-2 底 hover 提亮，激活反色（foreground 底 background 字，深浅主题各自
// 取反）。条内间距 12 同为 YouTube 实测值。全站 chip（首页分类/榜单、分类页
// pill 云与筛选、搜索热词、相册分类、scope 切换）一律走本组件或 CHIP_STYLE
// 常量，保证同一元素全站一个规格。
// 契约 props：{ items, active, onChange }——
//   items: [{ key, label }]（纯字符串项防御式兼容，键 = 文案）；
//   active: 当前选中 key；onChange(key) 切换回调。
// hover 态只对 web 生效（ui/Chip 内 Pressable hovered，native 恒 false）。
import { ScrollView } from 'react-native';
import Chip, { CHIP_STYLE } from '../ui/Chip.jsx';

// 统一 chip 样式常量再导出：本模块是「chip 唯一规格」的对外出口，其他组件
// 需要拼 chip 形态时从这里取（不要手写数值）
export { CHIP_STYLE };

// 条目归一化：容忍纯字符串项与缺 label 项（脏条目跳过不渲染）
const norm = (it, i) =>
  typeof it === 'string'
    ? { key: it, label: it }
    : it && it.key != null
      ? { key: it.key, label: it.label != null ? String(it.label) : String(it.key) }
      : it && it.label != null
        ? { key: i, label: String(it.label) }
        : null;

export default function ChipsBar({ items = [], active, onChange, style, contentContainerStyle }) {
  const list = (items || []).map(norm).filter(Boolean);
  if (!list.length) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false} // no-scrollbar 语义：横滚条不占位
      style={style}
      contentContainerStyle={[
        { flexDirection: 'row', gap: 12, paddingVertical: 2 }, // 条内间距 12（YouTube 实测）
        contentContainerStyle,
      ]}
    >
      {list.map((it) => (
        <Chip
          key={String(it.key)}
          active={it.key === active}
          label={it.label}
          onPress={() => onChange && onChange(it.key)}
        />
      ))}
    </ScrollView>
  );
}
