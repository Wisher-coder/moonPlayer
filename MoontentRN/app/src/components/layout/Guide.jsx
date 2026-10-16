// ============================================================================
// Guide.jsx —— 导视侧栏（YouTube 式导航清单，一套内容三种形态）
// ----------------------------------------------------------------------------
//   variant="full"    展开常驻（w-60 = 240px，PC 画幅）：主导航 + 片源 + 设置 + 关于
//   variant="mini"    迷你轨（w-[72px]，平板常驻 / PC 折叠态）：仅主导航竖排图标
//   variant="drawer"  抽屉（手机/平板/观看页汉堡拉起）：内容同 full，
//                     链接点击后经 onNavigate 关抽屉
// 分组：
//   主导航  首页/分类/相册(albums 能力)/女优(authors 能力)/专区(zones 能力)/
//           我的——女优槽在 /author/* 详情页也点亮、专区槽在 /package/*
//           包详情页也点亮（各体系唯一导航面）；板块型站点（boards 且无分类/
//           标签/相册任一面）去掉「分类」；搜索不在侧栏（唯一入口在顶栏）；
//   片源    站点即频道：订阅式行（首字圆形头像 + 站名）点击切换数据源，
//           只平铺已加载插件（加载/卸载在「我的」页 → 插件管理；顺序由
//           /api/sites 决定）；
//   设置    外观三选（system/dark/light，行尾 Check 标记当前项）、
//           自动连播（YouTube 同款自绘开关 pill，读写 settings.js）、
//           悬浮预览（同款开关 pill：视频卡 web 悬停弹全局预览层的总开关）、
//           清除观看历史（确认弹层，RN Modal 自绘——不依赖 ui 组件层）；
//   关于    → /mine。
// 行规格对齐 YouTube：展开态 h-10 圆角 10 按压灰面、图标 24px；迷你轨 64×56
// 竖排图标 + 10px 标签。
// ============================================================================
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import {
  Check, Home, HomeSolid, Gallery as ImageIcon, GallerySolid as ImageIconSolid, Info,
  Layers, LayersSolid, Category, CategorySolid, Send, Trash, User, UserSolid, Users, UsersSolid,
} from '../icons.js';
import TabIcon from './TabIcon.jsx';
import GlassSurface from '../ui/GlassSurface.jsx';
import { clearViews } from '../../lib/history.js';
import { getSettingsSnapshot, setSetting, subscribeSettings } from '../../lib/settings.js';
import { useGlassEnabled } from '../../lib/glass.js';
import { useSite } from '../../lib/site-context.jsx';
import { useTheme } from '../../lib/theme-context.jsx';
import { openTab } from '../../lib/tab-nav.js';
import { cn } from '../../lib/utils.js';
import { useColors } from '../../theme/index.js';

// 基础主导航（能力驱动的插槽在此基础上插入；iconActive 为激活态填充形对照）
const MAIN_ITEMS = [
  { href: '/', label: '首页', icon: Home, iconActive: HomeSolid },
  { href: '/category', label: '分类', icon: Category, iconActive: CategorySolid },
  { href: '/mine', label: '我的', icon: User, iconActive: UserSolid },
];

// 外观三选：值与 theme-context 的 mode 三态一一对应
const THEME_ITEMS = [
  { value: 'system', label: '使用系统主题' },
  { value: 'dark', label: '深色主题' },
  { value: 'light', label: '浅色主题' },
];

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

// YouTube 同款开关 pill：56×32 全圆角；开=foreground 底 + background 圆点，
// 关=line 底 + foreground 点（语义色随主题自动反档）
function TogglePill({ on }) {
  return (
    <View className={cn('h-8 w-14 shrink-0 justify-center rounded-full', on ? 'bg-foreground' : 'bg-line')}>
      <View className={cn('mx-1 h-6 w-6 rounded-full', on ? 'self-end bg-background' : 'self-start bg-foreground')} />
    </View>
  );
}

// 片源行首字圆形头像（站点色相环取色：id 散列 → hue，同站恒同色）
function SiteGlyph({ siteId, size = 24 }) {
  let hash = 0;
  for (let i = 0; i < siteId.length; i += 1) hash = (hash * 31 + siteId.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return (
    <View
      className="items-center justify-center rounded-full"
      style={{ width: size, height: size, backgroundColor: 'hsl(' + hue + ', 45%, 45%)' }}
    >
      <Text className="text-xs font-semibold text-white">{siteId.charAt(0).toUpperCase()}</Text>
    </View>
  );
}

export default function Guide({ variant = 'full', onNavigate }) {
  const router = useRouter();
  const pathname = usePathname();
  const { site, visibleSites, setSite, caps } = useSite();
  const { mode, setMode } = useTheme();
  const C = useColors();
  const [autoplay, setAutoplayState] = useState(() => getSettingsSnapshot().autoplay);
  const [hoverPreview, setHoverPreviewState] = useState(() => getSettingsSnapshot().hover_preview);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // 液态玻璃（iOS 26+）：确认弹层卡片玻璃化 + 规避 Modal fade 的 opacity 禁区
  const glass = useGlassEnabled();
  const compact = variant === 'mini';

  // 自动连播 / 悬浮预览：挂载对齐本机偏好 + 订阅广播（其它入口改了也即时同步）
  useEffect(() => {
    setAutoplayState(getSettingsSnapshot().autoplay);
    setHoverPreviewState(getSettingsSnapshot().hover_preview);
    const unsubscribe = subscribeSettings((s) => {
      setAutoplayState(!!s.autoplay);
      setHoverPreviewState(!!s.hover_preview);
    });
    return unsubscribe;
  }, []);

  // 主导航清单：能力驱动插槽（顺序同 NextWeb Guide）——albums 在分类之后插
  // 「相册」（/album 详情页也点亮）；authors 在我的之前插「女优」
  // （/author/{site}/{id} 详情页也点亮，女优体系唯一导航面）；zones 在我的之前
  // 插「专区」（/package 包详情页也点亮）；板块型站点去掉「分类」
  const mainItems = useMemo(() => {
    let items = MAIN_ITEMS;
    if (caps.albums) {
      items = [
        ...items.slice(0, 2),
        { href: '/albums', label: '相册', icon: ImageIcon, iconActive: ImageIconSolid },
        ...items.slice(2),
      ];
    }
    if (caps.authors) {
      const i = items.findIndex((x) => x.href === '/mine');
      items = [...items.slice(0, i), { href: '/authors', label: '女优', icon: Users, iconActive: UsersSolid }, ...items.slice(i)];
    }
    if (caps.zones) {
      const i = items.findIndex((x) => x.href === '/mine');
      items = [...items.slice(0, i), { href: '/zones', label: '专区', icon: Layers, iconActive: LayersSolid }, ...items.slice(i)];
    }
    if (caps.boards && !caps.tags && !caps.dvds && !caps.albums) {
      items = items.filter((x) => x.href !== '/category'); // 板块型站点：首页即板块流
    }
    return items;
  }, [caps]);

  const isActive = makeIsActive(pathname);

  const go = (href) => {
    if (onNavigate) onNavigate();
    openTab(router, pathname, href);
  };

  const pickSite = (s) => {
    if (s.id === site) return;
    setSite(s.id); // 切站：全站请求随之切换；不关抽屉，便于连续对比
  };

  const toggleAutoplay = () => {
    setSetting('autoplay', !autoplay); // 写入 + 广播，本实例订阅回调同步 state
  };

  // 悬浮预览开关：写 settings 的 hover_preview 键（web 端视频卡悬停弹预览层的
  // 总开关，native 无悬停概念恒不生效）
  const toggleHoverPreview = () => {
    setSetting('hover_preview', !hoverPreview);
  };

  // 清除观看历史：确认后清空本机足迹
  const doClear = () => {
    clearViews();
    setConfirmOpen(false);
  };

  // —— 迷你轨：仅主导航，竖排 64×56 圆角块 ——
  if (compact) {
    return (
      <View className="flex-1 items-center gap-1 py-1" accessibilityLabel="主导航">
        {mainItems.map(({ href, label, icon: Icon, iconActive: IconSolid }) => (
          <Pressable
            key={href}
            onPress={() => go(href)}
            accessibilityLabel={label}
            accessibilityRole="button"
            className={cn('h-14 w-16 items-center justify-center gap-1 rounded-[10px]', isActive(href) && 'bg-surface-2')}
          >
            <TabIcon active={isActive(href)} icon={Icon} iconActive={IconSolid} size={24} color={C.foreground} />
            <Text className="text-[10px] leading-none text-foreground">{label}</Text>
          </Pressable>
        ))}
      </View>
    );
  }

  // —— 展开态 / 抽屉：完整清单（长片源列表可滚动） ——
  return (
    <View className="flex-1">
      <ScrollView className="flex-1" contentContainerClassName="pb-3" nestedScrollEnabled>
        {/* 主导航 */}
        <View accessibilityLabel="主导航">
          {mainItems.map(({ href, label, icon: Icon, iconActive: IconSolid }) => (
            <Pressable
              key={href}
              onPress={() => go(href)}
              accessibilityLabel={label}
              accessibilityRole="button"
              className={cn(
                'mx-3 flex h-10 flex-row items-center gap-6 rounded-[10px] px-3',
                isActive(href) && 'bg-surface-2'
              )}
            >
              <TabIcon active={isActive(href)} icon={Icon} iconActive={IconSolid} size={24} color={C.foreground} />
              <Text className="text-sm font-medium text-foreground">{label}</Text>
            </Pressable>
          ))}
        </View>

        <View className="mx-3 my-3 border-t border-line" />

        {/* 片源：站点即频道，订阅式行切换数据源——只列已加载插件（加载/卸载
            见「我的」页 → 插件管理），顺序由 /api/sites 决定 */}
        <Text className="px-6 pb-1 pt-1 text-base font-medium text-foreground">片源</Text>
        {visibleSites.map((s) => {
          // Telegram 是账号型站源（对话/收藏随登录账号而变，浏览面在自己的
          // 专属页），不参与「切站」语义——点击不 pickSite，直达 /telegram
          // （登录 + 对话列表），避免把全站数据源切到需要登录态的站点上。
          if (s.capabilities && s.capabilities.tg) {
            return (
              <Pressable
                key={s.id}
                onPress={() => {
                  if (onNavigate) onNavigate();
                  router.push('/telegram');
                }}
                accessibilityLabel={'打开 ' + s.name}
                accessibilityRole="button"
                className={cn(
                  'mx-3 flex h-10 flex-row items-center gap-6 rounded-[10px] px-3',
                  !!pathname && pathname.startsWith('/telegram') && 'bg-surface-2'
                )}
              >
                <Send size={24} color={C.foreground} />
                <Text numberOfLines={1} className="text-sm text-foreground">{s.name}</Text>
              </Pressable>
            );
          }
          return (
            <Pressable
              key={s.id}
              onPress={() => pickSite(s)}
              accessibilityLabel={'切换到 ' + s.name}
              accessibilityRole="button"
              className={cn(
                'mx-3 flex h-10 flex-row items-center gap-6 rounded-[10px] px-3',
                s.id === site && 'bg-surface-2'
              )}
            >
              <SiteGlyph siteId={s.id} />
              <Text numberOfLines={1} className="text-sm text-foreground">{s.name}</Text>
            </Pressable>
          );
        })}

        <View className="mx-3 my-3 border-t border-line" />

        {/* 设置：外观 / 自动连播 / 悬浮预览 / 清除观看历史 */}
        <Text className="px-6 pb-1 pt-1 text-base font-medium text-foreground">设置</Text>
        <Text className="px-6 py-1 text-sm text-muted">外观</Text>
        {THEME_ITEMS.map(({ value, label }) => (
          <Pressable
            key={value}
            onPress={() => setMode(value)}
            accessibilityLabel={label}
            accessibilityRole="button"
            className="mx-3 flex h-10 flex-row items-center rounded-[10px] px-3"
          >
            <Text numberOfLines={1} className="text-sm text-foreground">{label}</Text>
            {mode === value && <View className="ml-auto"><Check size={20} color={C.foreground} /></View>}
          </Pressable>
        ))}

        <Pressable
          onPress={toggleAutoplay}
          accessibilityLabel="自动连播"
          accessibilityRole="switch"
          accessibilityState={{ checked: autoplay }}
          className="mx-3 flex h-10 flex-row items-center justify-between rounded-[10px] px-3"
        >
          <Text className="text-sm text-foreground">自动连播</Text>
          <TogglePill on={autoplay} />
        </Pressable>

        {/* 悬浮预览开关：与自动连播同款 YouTube 式开关 pill（结构复用上一行） */}
        <Pressable
          onPress={toggleHoverPreview}
          accessibilityLabel="悬浮预览"
          accessibilityRole="switch"
          accessibilityState={{ checked: hoverPreview }}
          className="mx-3 flex h-10 flex-row items-center justify-between rounded-[10px] px-3"
        >
          <Text className="text-sm text-foreground">悬浮预览</Text>
          <TogglePill on={hoverPreview} />
        </Pressable>

        <Pressable
          onPress={() => setConfirmOpen(true)}
          accessibilityLabel="清除观看历史"
          accessibilityRole="button"
          className="mx-3 flex h-10 flex-row items-center gap-6 rounded-[10px] px-3"
        >
          <Trash size={24} color={C.foreground} />
          <Text className="text-sm text-foreground">清除观看历史</Text>
        </Pressable>

        <View className="mx-3 my-3 border-t border-line" />

        {/* 关于 */}
        <Pressable
          onPress={() => go('/mine')}
          accessibilityLabel="关于"
          accessibilityRole="button"
          className="mx-3 flex h-10 flex-row items-center gap-6 rounded-[10px] px-3"
        >
          <Info size={24} color={C.foreground} />
          <Text className="text-sm text-foreground">关于</Text>
        </Pressable>
      </ScrollView>

      {/* 清除历史确认弹层（RN Modal 自绘，YouTube 式表面面板形态）。iOS 26
          玻璃端卡片换玻璃（Modal fade 会把玻璃祖先 opacity 从 0 起动画——
          玻璃 opacity=0 禁区，玻璃态改无动画直出；降级端 fade + surface 原样） */}
      <Modal visible={confirmOpen} transparent animationType={glass ? 'none' : 'fade'} onRequestClose={() => setConfirmOpen(false)}>
        <Pressable className="flex-1 items-center justify-center bg-black/50 px-6" onPress={() => setConfirmOpen(false)}>
          <GlassSurface className="w-full max-w-sm rounded-xl p-6" fallbackClassName="bg-surface">
            <Text className="text-lg font-semibold text-foreground">清除观看历史</Text>
            <Text className="mt-2 text-sm leading-5 text-muted">
              将清空本机保存的全部观看足迹，该操作无法撤销。
            </Text>
            <View className="mt-5 flex-row justify-end gap-3">
              <Pressable
                onPress={() => setConfirmOpen(false)}
                className="h-10 items-center justify-center rounded-full bg-surface-2 px-4"
              >
                <Text className="text-sm font-medium text-foreground">取消</Text>
              </Pressable>
              <Pressable
                onPress={doClear}
                className="h-10 items-center justify-center rounded-full bg-accent px-4"
              >
                <Text className="text-sm font-medium text-white">清除</Text>
              </Pressable>
            </View>
          </GlassSurface>
        </Pressable>
      </Modal>
    </View>
  );
}
