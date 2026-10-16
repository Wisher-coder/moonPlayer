// 站点头像（RN 三端移植，源：NextWeb SiteAvatar.jsx）
// ----------------------------------------------------------------------------
// 数据层无作者字段，以「片源站」充当 YouTube 频道头像——固定色圆 + 站名首字，
// 颜色按站点 id 稳定映射、与主题无关（亮暗下同色）。
// 契约（跨模块上下文）：site 缺省用站点上下文当前站（useSite() → {site,sites}）；
// 16/24/36/80px 各档字号 = 直径 45% 且下限 9px，保证 16px 小档首字仍可辨。
// props：{ site?, size = 36(px 数值) }；只增不减。
import { memo, useContext } from 'react';
import { Text, View } from 'react-native';
import { SiteContext } from '../../lib/site-context.jsx';

// 已知站点的固定色；未知站点按 id 哈希落到备用色环
const SITE_COLORS = { yuese: '#8b5cf6', avjb: '#3b82f6' };
const FALLBACK = ['#f97316', '#10b981', '#ef4444', '#06b6d4', '#a855f7'];

function colorOf(id) {
  if (SITE_COLORS[id]) return SITE_COLORS[id];
  let h = 0;
  const s = String(id == null ? '' : id);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.codePointAt(i)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}

function SiteAvatar({ site, size = 36 }) {
  // 站点上下文防御式读取：Provider 尚未挂载/站点未就绪时退化为占位色圆。
  // 用原生 context + useContext 直读（恒不抛错）——useSite() 包 try/catch 会
  // 构成条件钩子调用（rules-of-hooks）
  const ctx = useContext(SiteContext) || {};
  const sid = site || ctx.site || '';
  const name = ((ctx.sites || []).find((s) => s && s.id === sid) || {}).name || sid || '?';
  return (
    <View
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: sid ? colorOf(sid) : '#9ca3af',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        style={{
          color: '#ffffff',
          fontWeight: '500',
          fontSize: Math.max(9, Math.round(size * 0.45)), // 直径 45% 且下限 9px
          includeFontPadding: false,
        }}
      >
        {String(name).slice(0, 1)}
      </Text>
    </View>
  );
}

// memo：纯展示件（色环 + 首字，无状态），片源列表/侧栏等父级重渲染时按 props
// （site/size）浅比较跳过，纯装饰元素不值得反复协调
export default memo(SiteAvatar);
