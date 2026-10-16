// ============================================================================
// SiteRow.jsx —— 片源行（「我的」页辅助件，RN 三端移植）
// ----------------------------------------------------------------------------
// 源：NextWeb/src/components/tabs/MineTab.jsx 的片源节内联行（1:1 交互语义）。
// 「频道」= 片源站：首字圆形站头像（40px）+ 站名（14px 单行截断）+ 行尾状态
// 胶囊——使用中（foreground 反色底实心胶囊）/ 切换（line 描边胶囊，hover 转
// 交互蓝）。整行为一个点按目标（与 NextWeb button 行一致）；重复点击当前站
// 不提示、不动作。
// 规格对齐 NextWeb：行 h-12（48）、rounded-lg（8）、px-2（8）、gap-4（16）；
// 胶囊 h-9（36）rounded-full px-4 text-sm/500。
// 站点清单含 main 主站与 cms 资源站群（zy_ 前缀）全部平铺，顺序由 /api/sites
// 决定——本行不区分分组，只按传入条目渲染。
import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import SiteAvatar from '../video/SiteAvatar.jsx';
import { usePalette } from '../ui/palette.js';
import { FSM_DENSE } from '../../lib/text-fit.js';
import usePressVisual from '../../lib/use-press-visual.js';

// 行尾状态胶囊：实心（使用中）或描边（切换）；hovered 仅 web 生效
function Pill({ solid, hovered, children }) {
  const p = usePalette();
  return (
    <View
      style={{ pointerEvents: 'none',
      
        height: 36,
        borderRadius: 18,
        paddingHorizontal: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: solid ? p.foreground : 'transparent',
        borderWidth: solid ? 0 : 1,
        borderColor: hovered ? p.link + '66' : p.line, // hover：交互蓝 40% 透明度
      }}
    >
      <Text style={{ fontSize: 14, fontWeight: '500', color: solid ? p.background : hovered ? p.link : p.muted }}>
        {children}
      </Text>
    </View>
  );
}

function SiteRow({ entry, active, onPress }) {
  const p = usePalette();
  // 布局纯静态 + 视觉态事件 state（安卓端 Pressable 样式函数携带的布局属性
  // 不生效，见 lib/use-press-visual.js 头注；native 无悬停事件，hovered 恒 false）
  const hv = usePressVisual();
  if (!entry || !entry.id) return null; // 脏数据防御
  const rowBody = {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={active ? entry.name + '（使用中）' : '切换到 ' + entry.name}
      accessibilityState={{ selected: !!active }}
      onPress={() => onPress && onPress(entry)}
      {...hv.binds}
      style={[
        rowBody,
        {
          backgroundColor: hv.hovered ? p.surface2 : 'transparent',
          opacity: hv.pressed ? 0.85 : 1,
        },
      ]}
    >
      <SiteAvatar site={entry.id} size={40} />
      <Text numberOfLines={1} maxFontSizeMultiplier={FSM_DENSE} style={{ flex: 1, minWidth: 0, fontSize: 14, color: p.foreground, includeFontPadding: false }}>
        {entry.name || entry.id}
      </Text>
      <Pill solid={active} hovered={hv.hovered}>
        {active ? '使用中' : '切换'}
      </Pill>
    </Pressable>
  );
}

// memo：片源列表可达数十个资源站，页内其它状态（开关/弹窗）变化时按 props
// 浅比较跳过未变行
export default memo(SiteRow);
