// ============================================================================
// TopBar.jsx —— 顶栏（高 TOPBAR_H=56，三段式）
// ----------------------------------------------------------------------------
// 左：汉堡（行为由 AppShell 经 onMenuClick 注入：PC 展开↔迷你切换 / 其余开抽屉）
//     + 红底播放键 Logo + 月幕字标（点按回首页）；
// 中：搜索位（按端分工，全应用任一时刻只有一个搜索输入框）——平板/PC 是
//     真输入框：限宽 560 居中 + 融合搜索钮（YouTube 桌面形态），回车/点钮
//     push 进搜索页；文字经 searchbar-store 回填（结果页输入框里就是当前
//     关键词，离开搜索页不跟随清空、保留上次词）；手机是入口胶囊：点击进
//     搜索页，输入在搜索页自绘头部进行（AppShell 在 /search 整条收起本顶栏），
//     胶囊文字随搜索页关键词联动；
// 右：主题切换按钮（light/dark 间快捷切换，system 起点落到显式反色）。
// 看板入口（NextWeb 同位移植）：品牌右侧胶囊——useWallCount 有内容才出现，
// Wall + 「看板」字样 + accent 计数气泡，点按 setWallOpen(true) 打开
// 全局视频看板覆盖层（AppShell 挂的单例 WallOverlay）。这是 RN 端看板的
// 唯一打开路径（播放器控制条的「添加到看板」只入墙不开墙，语义同 NextWeb）。
// 无描边扁平：图标钮圆形按压灰面（surface-2），搜索胶囊 surface-2 底。
// 手机端观看页（/video/*）整条隐藏（由 AppShell 判定，本组件不感知）；
// 顶部安全区（刘海/灵动岛）由 AppShell 传入 topInset 垫高。
// ============================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { Menu, Wall, Moon, Search, Sun } from '../icons.js';
import { BrandWord, Logo } from './Logo.jsx';
import Input from '../ui/Input.jsx';
// 平台分流（必须无后缀 import：metro 平台解析只对无后缀请求生效，显式 .js
// 会直取原生 stub——web 端就拿不到按钮；web=自绘窗口控件三钮（Electron
// 无边框壳），native=WindowControls.js 为 null stub）
import WindowControls from './WindowControls';
import { useTheme } from '../../lib/theme-context.jsx';
import { useGlassEnabled } from '../../lib/glass.js';
import { useSearchBar } from '../../lib/searchbar-store.js';
import { useWallCount, setWallOpen } from '../../lib/wall-store.js';
import { useForm } from '../../lib/use-form.js';
import { openTab } from '../../lib/tab-nav.js';
import { cn } from '../../lib/utils.js';
import { useColors } from '../../theme/index.js';
import { useIsDesktopApp, useNativeTrafficLights, TRAFFIC_LIGHT_W } from '../../lib/desktop-bridge.js';
import usePressVisual from '../../lib/use-press-visual.js';
import { TOPBAR_H } from '../../lib/chrome-metrics.js';

// 桌面壳自绘窗口控件区：三钮 46 宽贴右上角（顶部整条为拖拽区，控件区
// 覆盖其上且整体 no-drag），行内右侧预留同宽 + 间距防主题钮被压。macOS
// 红绿灯适配：原生钮在左（titleBarStyle:'hidden'），三钮与右预留都不需要，
// 改为左侧按 TRAFFIC_LIGHT_W 让位防汉堡钮被压
const WIN_CTRL_W = 46 * 3;

export default function TopBar({ onMenuClick }) {
  const router = useRouter();
  const pathname = usePathname();
  const { resolved, toggle } = useTheme();
  const { pageKw } = useSearchBar();
  const { form } = useForm();
  const C = useColors();
  const searchHv = usePressVisual(); // 桌面搜索钮视觉态（布局静态化，安卓样式函数陷阱）
  const wallHv = usePressVisual(); // 看板入口 pill 按压视觉态
  const wallCount = useWallCount();
  // Electron 桌面壳：顶栏整条即自定义标题栏（拖拽区 + 自绘窗口控件，
  // 腾讯视频形态）；普通浏览器/原生端零变化。hook 形态保 SSG 水合对齐
  //（web 首帧恒 false，见 lib/desktop-bridge.js）
  const desktop = useIsDesktopApp();
  // macOS 红绿灯让位（与 desktop 同拍放行真值，水合安全见 desktop-bridge.js）
  const nativeLights = useNativeTrafficLights();
  // 液态玻璃（iOS 26+）：仅手机画幅 overlay 形态参与——AppShell 的玻璃 wrapper
  // 已提供材质，根部须透明（不透明底会盖死玻璃折射）；pad/PC 流内形态与
  // 降级端维持自带 bg-background
  const chromeGlass = useGlassEnabled() && form === 'phone';

  // 平板/PC 顶栏输入框本地编辑态：pageKw 回填（YouTube：结果页搜索框里就是
  // 当前关键词）；离开搜索页 pageKw 置空时保留已输入词，不跟随清空
  const [edit, setEdit] = useState(pageKw);
  const [editFocus, setEditFocus] = useState(false);
  useEffect(() => { if (pageKw) setEdit(pageKw); }, [pageKw]);

  // 提交：进搜索页（空词也进——看历史/热词，NextWeb 同语义）；同词已在结果页
  //（含裸 /search 上再空提交）不重复跳。tab 级目标统一走 openTab（详情页里
  // 提交 = dismissTo 弹回 (tabs) 组再切搜索；tab 里提交 = 组内 JUMP_TO）
  const submitEdit = useCallback(() => {
    const w = edit.trim();
    if (pathname === '/search' && w === pageKw) return;
    openTab(router, pathname, w ? '/search?kw=' + encodeURIComponent(w) : '/search');
  }, [edit, pageKw, pathname, router]);

  // 看板入口胶囊（有内容才渲染）。HIG Toolbars（玻璃端手机画幅重排）：栏内
  // ≤3 组——[leading 汉堡+品牌][flex 搜索位][trailing 主题+看板控件组]；胶囊
  // 从品牌旁挪进 trailing 组（与主题钮同组，符号钮语义）。降级端原位（品牌旁）
  const wallEntry = wallCount > 0 ? (
    <Pressable
      onPress={() => setWallOpen(true)}
      accessibilityLabel="打开视频看板"
      accessibilityRole="button"
      className={cn(
        'h-8 flex-row shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5',
        desktop && 'app-nodrag'
      )}
      {...wallHv.binds}
      style={wallHv.pressed ? [{ backgroundColor: C.surface2 }] : undefined}
    >
      <Wall size={16} color={C.foreground} />
      {form !== 'phone' ? (
        <Text selectable={false} className="text-xs font-medium text-foreground">
          看板
        </Text>
      ) : null}
      <View className="h-4 min-w-[16px] items-center justify-center rounded-full bg-accent px-1">
        <Text
          allowFontScaling={false}
          selectable={false}
          style={{ color: '#ffffff', fontSize: 10, fontWeight: '600', lineHeight: 12, includeFontPadding: false }}
        >
          {wallCount}
        </Text>
      </View>
    </Pressable>
  ) : null;

  return (
    <View className={cn(!chromeGlass && 'bg-background')}>
      {/* 内容行恒高 TOPBAR_H（显式样式：nativewind h-14 原生端仅 49pt——1rem=14，
          须对齐 chrome-metrics 三端统一口径，悬浮避让值才精确）；顶部安全区由
          外层（AppShell）垫高。桌面壳：整行挂
          app-drag 成为拖拽标题栏（移动/双击最大化由 Electron 原生行为承担），
          行内可交互元素全部显式 app-nodrag；右侧为窗口控件区预留空间，
          macOS 红绿灯则改左侧让位（原生钮在左） */}
      <View
        className={cn('w-full flex-row items-center gap-3 px-3', desktop && 'app-drag')}
        style={{
          height: TOPBAR_H,
          paddingLeft: desktop && nativeLights ? TRAFFIC_LIGHT_W : undefined,
          paddingRight: desktop && !nativeLights ? WIN_CTRL_W + 12 : undefined,
        }}
      >
        {/* 左：菜单钮 + 品牌（搜索聚焦时保持原位不动——YouTube 行为） */}
        <Pressable
          onPress={onMenuClick}
          accessibilityLabel="打开菜单"
          accessibilityRole="button"
          hitSlop={8}
          className={cn('h-10 w-10 items-center justify-center rounded-full', desktop && 'app-nodrag')}
        >
          {({ pressed }) => (
            <View
              className={cn(
                'h-10 w-10 items-center justify-center rounded-full',
                pressed && 'bg-surface-2'
              )}
            >
              <Menu size={24} color={C.foreground} />
            </View>
          )}
        </Pressable>
        <Pressable
          accessibilityLabel="回首页"
          accessibilityRole="button"
          className={cn('flex-row items-center gap-2', desktop && 'app-nodrag')}
          onPress={() => openTab(router, pathname, '/')}
        >
          <Logo size={30} />
          <BrandWord showEn={form !== 'phone'} />
        </Pressable>

        {/* 看板入口（降级端/流内形态）：品牌旁 YouTube 式胶囊 + accent 计数
            气泡（NextWeb TopBar 同款；手机画幅藏「看板」字样只留图标+计数省
            宽）。结构对齐本文件其它图标钮的惯用法：直接子元素 + style 回调按
            压态——不用「按压时挂载 absolute 覆盖层」的反馈（真机 web 实测：
            按下瞬间覆盖层罩住内容区，mouseup 落在新节点，click 被浏览器取消，
            表现为点文字无效、只有边缘 padding 可点）；文字一律
            selectable={false} 防选择态吞点击。玻璃端手机画幅改挂 trailing
            控件组（HIG ≤3 组重排，见 wallEntry 定义处注释） */}
        {!chromeGlass ? wallEntry : null}

        {/* 中：搜索位——平板/PC 真输入框（限宽 560 居中 + 融合搜索钮）；手机
            入口胶囊（点击进搜索页，输入在搜索页自绘头部进行） */}
        <View className="min-w-0 flex-1 flex-row justify-center">
          {form === 'phone' ? (
            <Pressable
              accessibilityLabel="搜索"
              accessibilityRole="search"
              className={cn(
                'h-10 flex-1 flex-row items-center gap-2 rounded-full bg-surface-2 px-4',
                desktop && 'app-nodrag'
              )}
              // 恒开全新搜索（YouTube 语义）：带空 kw 覆写保活 tab 残留的上一轮
              // ?kw（TabRouter 参数合并），落地即裸搜索态 + 聚焦弹键盘（搜索
              // 唯一入口在本顶栏，底栏/侧栏均无搜索槽）
              onPress={() => openTab(router, pathname, '/search?kw=')}
            >
              <Search size={20} color={C.muted} />
              <Text numberOfLines={1} className="min-w-0 flex-1 text-base text-muted">
                {pageKw || '搜索'}
              </Text>
            </Pressable>
          ) : (
            <View
              className="h-10 w-[560px] max-w-full flex-row items-stretch bg-background"
              style={{
                borderWidth: 1,
                borderRadius: 20,
                borderColor: editFocus ? C.link : C.line,
                overflow: 'hidden', // 融合搜索钮右缘裁成胶囊头
              }}
            >
              <Input
                value={edit}
                onChangeText={setEdit}
                placeholder="搜索"
                returnKeyType="search"
                onSubmitEditing={submitEdit}
                onFocus={() => setEditFocus(true)}
                onBlur={() => setEditFocus(false)}
                className={desktop ? 'app-nodrag' : undefined}
                style={{
                  flex: 1,
                  height: 40,
                  borderWidth: 0, // 描边由外层胶囊统一持有（聚焦变色也在此）
                  borderRadius: 20,
                  paddingHorizontal: 16,
                  backgroundColor: 'transparent',
                }}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="搜索"
                onPress={submitEdit}
                className={desktop ? 'app-nodrag' : undefined}
                {...searchHv.binds}
                style={[
                  { width: 64, alignItems: 'center', justifyContent: 'center', borderLeftWidth: 1, borderLeftColor: C.line },
                  { backgroundColor: searchHv.hovered ? C.line : C.surface2, opacity: searchHv.pressed ? 0.85 : 1 },
                ]}
              >
                <Search size={20} color={C.muted} />
              </Pressable>
            </View>
          )}
        </View>

        {/* 右：trailing 控件组（HIG Toolbars）。玻璃端手机画幅收编看板胶囊
            （与主题钮同组，≤3 组纪律）；降级端仅主题钮（原样） */}
        {chromeGlass ? wallEntry : null}
        <Pressable
          onPress={toggle}
          accessibilityLabel="切换主题"
          accessibilityRole="button"
          hitSlop={8}
          className={cn('h-10 w-10 items-center justify-center rounded-full', desktop && 'app-nodrag')}
        >
          {({ pressed }) => (
            <View
              className={cn(
                'h-10 w-10 items-center justify-center rounded-full',
                pressed && 'bg-surface-2'
              )}
            >
              {resolved === 'dark' ? (
                <Sun size={24} color={C.foreground} />
              ) : (
                <Moon size={24} color={C.foreground} />
              )}
            </View>
          )}
        </Pressable>
      </View>

      {/* 桌面壳：自绘窗口控件（最小化/最大化/关闭）贴右上角，压在拖拽行
          之上且整体 no-drag；非桌面环境 WindowControls 自身渲染 null */}
      <View
        className="app-nodrag"
        pointerEvents={desktop ? 'auto' : 'none'}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: WIN_CTRL_W,
          height: TOPBAR_H,
          flexDirection: 'row',
        }}
      >
        {desktop ? <WindowControls /> : null}
      </View>
    </View>
  );
}
