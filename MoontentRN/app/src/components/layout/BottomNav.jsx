// ============================================================================
// BottomNav.jsx —— 底部导航（手机画幅三~六槽；平板/PC 起由 Guide 侧栏接管）
// ----------------------------------------------------------------------------
// 槽位：首页/分类|相册(albums 能力)|女优(authors 能力)|专区(zones 能力)|我的
// ——相册槽在 /album/* 详情页也点亮、女优槽在 /author/* 详情页也点亮、专区槽在
// /package/* 包详情页也点亮（各体系唯一浏览面）；板块型站点（boards 且无分类/
// 标签/相册任一面）不显示「分类」槽。搜索不在底栏（唯一入口在顶栏胶囊）。
// 图标统一 24px；标签 10px（玻璃端 11px）。槽位高：降级端 h-14（nativewind
// 1rem = 14 → 原生 49pt、web 56px），玻璃端显式 56pt——对齐 AppShell 的
// BOTTOMNAV_H 与 useChromeInsets 口径（浮动栏比降级端贴边栏略高，配合珠内缩
// 4 得珠/栏比 0.857，与参考图 0.861 一致）。
// iOS 26 玻璃端露珠指示器（几何与配色对齐用户给定参考图逐像素实测）：选中项
// = 一枚浅灰中性色圆角矩形**铺满整个槽位**（珠宽 = 槽宽 − 两侧内缩 4，四周
// 内缩均匀，圆角 20 ≈ 珠高 0.42、与栏身同半径），珠面自身无高光边——观感是
// 「栏玻璃上压了一层淡中性色」而非第二枚玻璃珠（且 HIG：glass cannot sample
// other glass），故实现为半透明中和层（浅色主题压黑 5%、深色主题提白 12%）
// 压在栏玻璃之上，栏身原有的边缘高光/折射从珠下透出。单珠 absolute 挂行内
//（zIndex 压在槽内容之下），量测各槽布局后 spring 滑移到选中槽（原生切换
// 动效 = 共享元素滑移，非逐项淡入淡出）。前景：选中 = 填充形图标 + 标签走
// foreground（参考图选中为纯黑，无 app tint 色），未选中 = 素图标走 muted、
// 标签同为 foreground（参考图两态标签均近黑，差别只在字重：选中侧 600）——
// 填充形交叉淡切 + 弹跳由 TabIcon 承担。主 tab 默认 ≤5（HIG），玻璃端溢出时
//「分类」收进抽屉（汉堡入口）。降级端贴边 + 顶缘 hairline，无露珠，视觉与
// 改造前一致。观看页整条隐藏（AppShell 判定）。
// ============================================================================
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Platform, Pressable, Text, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import {
  Home, HomeSolid, Gallery as ImageIcon, GallerySolid as ImageIconSolid, Layers, LayersSolid,
  Category, CategorySolid, User, UserSolid, Users, UsersSolid,
} from '../icons.js';
import TabIcon from './TabIcon.jsx';
import { useSite } from '../../lib/site-context.jsx';
import { openTab } from '../../lib/tab-nav.js';
import { useGlassEnabled } from '../../lib/glass.js';
import { useThemeSafe } from '../../lib/theme-context.jsx';
import { cn } from '../../lib/utils.js';
import { useColors } from '../../theme/index.js';
import { BOTTOMNAV_H } from '../../lib/chrome-metrics.js';

// 基础槽位（能力驱动插槽在此基础上插入；iconActive 为激活态填充形对照）
const NAV_ITEMS = [
  { href: '/', label: '首页', icon: Home, iconActive: HomeSolid },
  { href: '/category', label: '分类', icon: Category, iconActive: CategorySolid },
  { href: '/mine', label: '我的', icon: User, iconActive: UserSolid },
];

// 露珠几何（对齐参考图实测比例：珠高/栏高 ≈ 0.85 → 栏高 56 上下各缩 4 = 48，
// 圆角 20 ≈ 珠高 0.42（与栏身同半径，参考图两形状同一半径档）；珠宽 = 槽宽 −
// 两侧各 4（参考图珠铺满槽位，非内容加固定边距）；珠面 = 中性色中和层：
// 浅色主题压黑 5%（参考图珠相对栏底 ≈ 0.95 倍亮度）、深色主题提白 12%
const BEAD_INSET = 4;
const BEAD_RADIUS = 20;
const BEAD_TINT = { light: 'rgba(0,0,0,0.05)', dark: 'rgba(255,255,255,0.12)' };

// 激活判定：/ 精确匹配；相册/女优/专区详情页也点亮对应槽位；其余前缀匹配
function makeIsActive(pathname) {
  return (href) => {
    if (!pathname) return false;
    if (href === '/') return pathname === '/';
    if (href === '/albums') return pathname.startsWith('/albums') || pathname.startsWith('/album/');
    if (href === '/authors') return pathname.startsWith('/authors') || pathname.startsWith('/author/');
    if (href === '/zones') return pathname.startsWith('/zones') || pathname.startsWith('/package/');
    return pathname.startsWith(href);
  };
}

export default function BottomNav() {
  const router = useRouter();
  const pathname = usePathname();
  const { caps } = useSite();
  const C = useColors();
  // 液态玻璃（iOS 26+）：AppShell 的玻璃 wrapper 已提供材质，根部去掉不透明
  // 底与顶缘 hairline（玻璃自带高光边缘）；降级端维持原样（本组件只在手机
  // 画幅存在，无需画幅分支）
  const glass = useGlassEnabled();
  const { resolved } = useThemeSafe();

  // 槽位清单：albums 能力在分类后插「相册」；authors 能力在我的前插「女优」
  //（/author/{site}/{id} 详情页也点亮）；zones 能力在我的前插「专区」（女优在
  // 前、专区贴我的，顺序同 NextWeb BottomNav）；板块型站点去掉「分类」
  const items = useMemo(() => {
    let list = NAV_ITEMS;
    if (caps.albums) {
      list = [
        ...list.slice(0, 2),
        { href: '/albums', label: '相册', icon: ImageIcon, iconActive: ImageIconSolid },
        ...list.slice(2),
      ];
    }
    if (caps.authors) {
      const i = list.findIndex((x) => x.href === '/mine');
      list = [...list.slice(0, i), { href: '/authors', label: '女优', icon: Users, iconActive: UsersSolid }, ...list.slice(i)];
    }
    if (caps.zones) {
      const i = list.findIndex((x) => x.href === '/mine');
      list = [...list.slice(0, i), { href: '/zones', label: '专区', icon: Layers, iconActive: LayersSolid }, ...list.slice(i)];
    }
    if (caps.boards && !caps.tags && !caps.dvds && !caps.albums) {
      list = list.filter((x) => x.href !== '/category');
    }
    // HIG Tab Bars：默认主 tab ≤5。全能力站会到 6 槽（首页/分类/相册/女优/
    // 专区/我的）——玻璃端把「分类」收进抽屉（汉堡随时可达），降级端槽位
    // 照旧（能力展示不受设计规范约束）
    if (glass && list.length > 5) {
      list = list.filter((x) => x.href !== '/category');
    }
    return list;
  }, [caps, glass]);

  const isActive = makeIsActive(pathname);
  const activeIndex = items.findIndex((it) => isActive(it.href));

  // —— 露珠滑移（玻璃端）：量测各槽 x/宽，spring 滑到选中槽 ——
  // slots[i] = { x, width }；onLayout 值比对后 bump tick 驱动 effect
  //（避免每帧 setState 循环）。首测直落（无动画，整页进场不抢戏），此后
  // spring 滑移（速度/弹跳与 TabIcon 弹跳同档体感）
  const slots = useRef([]);
  const [layoutTick, setLayoutTick] = useState(0);
  const [bead, setBead] = useState(null); // { width }——首测完成后才有珠
  const beadX = useRef(new Animated.Value(0)).current;
  const primed = useRef(false);

  const noteSlot = (i, patch) => {
    const prev = slots.current[i] || {};
    let dirty = false;
    for (const k of Object.keys(patch)) {
      if (prev[k] !== patch[k]) dirty = true;
    }
    if (!dirty) return;
    slots.current[i] = { ...prev, ...patch };
    setLayoutTick((t) => t + 1);
  };

  useEffect(() => {
    const s = slots.current[activeIndex];
    if (!s || s.width == null) return;
    const w = Math.max(0, Math.ceil(s.width) - BEAD_INSET * 2);
    const left = s.x + BEAD_INSET;
    if (!primed.current) {
      primed.current = true;
      beadX.setValue(left);
      setBead({ width: w });
      return;
    }
    setBead((b) => (b && b.width === w ? b : { width: w }));
    Animated.spring(beadX, {
      toValue: left,
      speed: 20,
      bounciness: 6,
      useNativeDriver: Platform.OS !== 'web', // transform-only：祖先平移对玻璃安全（同壳层收放）
    }).start();
  }, [activeIndex, layoutTick, beadX]);

  return (
    <View accessibilityLabel="底部导航" className={cn('flex-row', !glass && 'border-t border-line bg-background')}>
      {/* 露珠（玻璃端中和层）：浅色主题压黑 5% / 深色提白 12% 的半透明圆角
          矩形压于栏玻璃之上——栏身自带的高光边与折射从珠下透出，观感即参考
          图那层「玻璃面上的一层淡淡中和」（比再挂一枚玻璃珠更贴参考图，也
          避开 glass cannot sample other glass 的渲染不一致）；absolute +
          zIndex 0 压在槽内容（zIndex 1）之下，icon/label 浮于珠面；
          pointerEvents none（纯指示器，触摸全部落槽）。降级端不渲染 */}
      {glass && bead && activeIndex >= 0 ? (
        <Animated.View
          style={{
            position: 'absolute',
            top: BEAD_INSET,
            bottom: BEAD_INSET,
            left: 0,
            zIndex: 0,
            transform: [{ translateX: beadX }],
            pointerEvents: 'none',
          }}
        >
          <View
            style={{
              height: '100%',
              width: bead.width,
              borderRadius: BEAD_RADIUS,
              backgroundColor: BEAD_TINT[resolved === 'dark' ? 'dark' : 'light'],
            }}
          />
        </Animated.View>
      ) : null}
      {items.map(({ href, label, icon: Icon, iconActive: IconSolid }, i) => {
        const active = isActive(href);
        // 槽位高：玻璃端显式 56pt——nativewind 的 1rem = 14，h-14 在原生端
        // 只渲染 49pt（web 端仍是 56px），而玻璃端要对齐 AppShell BOTTOMNAV_H /
        // useChromeInsets 的 56 口径（浮动栏比降级端贴边栏略高，与上方的珠
        // 内缩 4 一起给出与参考图一致的珠/栏比 0.857），故显式给值消歧义；
        // 降级端维持 h-14 原样，视觉与改造前一致
        return (
          <Pressable
            key={href}
            onPress={() => openTab(router, pathname, href)}
            accessibilityLabel={label}
            accessibilityRole="button"
            className={cn('flex-1 items-center justify-center', !glass && 'h-14')}
            style={{ zIndex: 1, height: glass ? BOTTOMNAV_H : undefined }} // 槽内容浮于露珠之上
            onLayout={(e) => {
              const { x, width } = e.nativeEvent.layout;
              noteSlot(i, { x, width });
            }}
          >
            {/* 内容列（icon+label）：gap 3（原生 icon-label 紧凑间距观感） */}
            <View style={{ alignItems: 'center', justifyContent: 'center', gap: 3 }}>
              <TabIcon active={active} icon={Icon} iconActive={IconSolid} size={24} color={active ? C.foreground : C.muted} />
              {/* 标签配色（参考图口径）：玻璃端两态均 foreground、选中侧加粗
                  （参考图两态标签近黑，差别只在字重）；降级端维持改造前的
                  选中 foreground / 未选中 muted */}
              <Text
                style={{
                  color: active || !glass ? C.foreground : C.muted,
                  fontSize: glass ? 11 : 10,
                  lineHeight: glass ? 13 : 10,
                  fontWeight: glass && active ? '600' : undefined,
                }}
              >
                {label}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
