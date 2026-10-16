// ============================================================================
// mine.js —— 「我的」页（YouTube You 标签形态）
// ----------------------------------------------------------------------------
// 源：NextWeb/src/components/tabs/MineTab.jsx（1:1 交互语义移植）。
// 五节结构：
//   ① 观看历史 —— 页题档 20px/700（本页无独立页头，「观看历史」即页面标题），
//      纯本地足迹（history.js，条目自带 site 应对两站 ID 撞号）；手机画幅
//      横滚架 / 平板与 PC 网格两态（同一张 HistoryCard 两栖）；管理态单删 +
//      Dialog 二次确认清空全部；
//   ② 我的收藏 —— 全局共享收藏清单（fav-store 镜像 + 落盘快照兜底，仅存自
//      部署服务端）：区块头计数随 store 实时，「查看全部」进收藏页
//      /favorites；最近收藏横滑最多 8 条（HistoryCard 横滚形态，含站名行）；
//   ③ 片源 —— 站源插件化的管理入口（单行 → /plugins 插件管理页）：站源改为
//      可加载/卸载的插件（SiteContext 的 loadedIds 集合，默认仅光速资源站），
//      本页不再平铺站点清单——平铺切站由 Guide 侧栏片源区承接（只剩已加载
//      站），逐站/批量启停在插件管理页（10 主站单行 + CMS 父子结构）；
//   ④ 设置 —— 外观三态（跟随系统/深色/浅色）、自动连播、省流模式（封面降档）、
//      服务器地址编辑（默认 http://localhost:3001，写入 settings.serverBase
//      即时生效——真机访问电脑后端就靠这里改局域网地址）、清除观看历史；
//   ⑤ 关于 —— 版本 / 定位声明 / 仅供站方授权测试使用。
// RN 化差异（相对 NextWeb）：
//   - 足迹刷新：localStorage 同步读 → AsyncStorage 异步读，挂载 + 路由聚焦
//     （useFocusEffect，观看页返回）+ AppState 回前台三时机；
//   - 断点判定：matchMedia → use-form 三画幅（phone 横滚架 / pad·pc 网格，
//     网格列数走 use-grid-columns 同一套容器列算法）；
//   - toast：sonner → 页内自绘轻量反馈条（RN 侧无全局 toast 设施）；
//   - PWA 安装行（InstallRow）不移植：三端 App 本就是安装态；
//   - 搜索记录管理入口不在此页：NextWeb 在搜索页内（SearchTab「最近的搜索
//     记录」含单删/清空），按原位置由搜索页承接，此处不重复造。
// 服务器地址联动：保存后 resetClientCache() 清旧基址缓存，并经 SiteContext
// 的 refreshSites() 重拉 /api/sites 刷新全站清单（site-context 只在挂载时拉
// 一次，基址变了要换新后端的站点列表——切站本身仍走上下文，Guide 侧栏随上
// 下文自动同步）。
// ============================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Check, Clapperboard, Send, Speed, Layers, Monitor, Sparkle, WinMaximize, Moon, PlayCircle, Pip, Plug, Server, Sun, Trash } from '../../components/icons.js';
import appConfig from '../../../app.config.js';
import { api, resetClientCache } from '../../lib/client.js';
import { DEFAULT_API_BASE, getApiBase, setApiBase } from '../../lib/api-base.js';
import { isGlassSupported } from '../../lib/glass.js';
import { useIsDesktopApp } from '../../lib/desktop-bridge.js';
import { useOpenVideo } from '../../lib/open-video.js';
import {
  getSettingsSnapshot, setSetting, subscribeSettings,
} from '../../lib/settings.js';
import { clearViews, getViews, removeView } from '../../lib/history.js';
import { useFavTotal, refreshFavs, readFavSnapshot } from '../../lib/fav-store.js';
import { useSite } from '../../lib/site-context.jsx';
import { useTheme } from '../../lib/theme-context.jsx';
import { useForm } from '../../lib/use-form.js';
import useGridColumns from '../../hooks/use-grid-columns.js';
import useChromeScroll from '../../hooks/use-chrome-scroll.js';
import { usePalette } from '../../components/ui/palette.js';
import Button from '../../components/ui/Button.jsx';
import Dialog from '../../components/ui/Dialog.jsx';
import Input from '../../components/ui/Input.jsx';
import HistoryCard from '../../components/mine/HistoryCard.jsx';
import SettingRow, { TogglePill } from '../../components/mine/SettingRow.jsx';
import ScreenScrollView from '../../components/layout/ScreenScrollView.jsx';

// 外观三档：key 与 theme-context 的 mode 三态一一对应
const THEMES = [
  { key: 'system', label: '使用系统', icon: Monitor },
  { key: 'dark', label: '深色', icon: Moon },
  { key: 'light', label: '浅色', icon: Sun },
];

// 播放独立窗策略两档（key 对齐 settings.playerWindow；仅桌面 Electron 壳
// 显示该设置，浏览器/原生端视频本就窗口内打开、无此概念）
const PLAYER_WINDOWS = [
  { key: 'single', label: '单窗口', desc: '始终复用一个播放窗，点新视频直接切换', icon: Monitor },
  { key: 'multi', label: '多窗口', desc: '每个视频新开一个独立播放窗，可多窗同播', icon: Layers },
];

// toast 自动消失时长（ms）
const TOAST_MS = 2500;

// 「我的收藏」最近横滑条数上限
const FAV_RECENT_MAX = 8;

export default function Mine() {
  const p = usePalette();
  const { form } = useForm(); // phone 横滚架 / pad·pc 网格
  const { site, sites, visibleSites, refreshSites } = useSite();
  const { mode, setMode } = useTheme();
  const grid = useGridColumns(); // 与首页 VideoGrid 同一套容器列算法

  // ===== 观看足迹（纯本地，AsyncStorage 异步读）=====
  const [views, setViews] = useState([]);
  const [viewsLoaded, setViewsLoaded] = useState(false); // 首读完成前不出空态（防闪）
  const [managing, setManaging] = useState(false); // 管理态：卡上删除 X + 清空全部

  const refreshViews = useCallback(() => {
    let alive = true;
    getViews()
      .then((list) => { if (alive) { setViews(list); setViewsLoaded(true); } })
      .catch(() => { if (alive) setViewsLoaded(true); }); // 读失败按空处理，不卡页面
    return () => { alive = false; };
  }, []);

  // 挂载 + 回前台（AppState，对应 web visibilitychange）+ 路由聚焦（从观看页
  // 返回不再重挂组件，靠这里拿最新足迹）
  useEffect(() => {
    const offRefresh = refreshViews();
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') refreshViews(); });
    return () => { offRefresh(); sub.remove(); };
  }, [refreshViews]);
  useFocusEffect(useCallback(() => { refreshViews(); }, [refreshViews]));

  // 单删一条（HistoryCard memo 化，回调引用稳定防全量重渲染）
  const onRemove = useCallback((v) => {
    removeView(v.site, v.id)
      .then(() => getViews())
      .then((list) => setViews(list))
      .catch(() => {});
  }, []);

  // ===== 我的收藏（fav-store 全局清单镜像：服务端同一份收藏，跨设备共享）=====
  // 区块头计数直接订阅 store（详情页点星/收藏页增删即变）；最近横滑取自落盘
  // 快照 items——挂载/聚焦先读快照出内容（离线兜底，毫秒级），再 refreshFavs
  // 静默同步服务端（失败不清现有态、绝不抛错），同步成功快照已重落盘，重读
  // 一次刷新横滑
  const favTotal = useFavTotal();
  const [recentFavs, setRecentFavs] = useState(null); // null=快照未读到（不出空态防闪）
  const syncFavs = useCallback(() => {
    let alive = true;
    const read = () => {
      readFavSnapshot()
        .then((snap) => { if (alive) setRecentFavs(snap && snap.items ? snap.items.slice(0, FAV_RECENT_MAX) : []); })
        .catch(() => { if (alive) setRecentFavs([]); }); // 读失败按空处理，不卡页面
    };
    read();
    refreshFavs().then(read);
    return () => { alive = false; };
  }, []);
  useEffect(() => syncFavs(), [syncFavs]);
  useFocusEffect(useCallback(() => syncFavs(), [syncFavs]));

  // ===== 本地开关（settings.js 统一入口，事件广播保证多处消费方一致）=====
  const [autoplay, setAutoplayState] = useState(() => !!getSettingsSnapshot().autoplay);
  // 退出时悬浮播放（离开观看页缩为悬浮小窗续播；默认开，!== false 兜水合未就绪）
  const [miniOnExit, setMiniOnExitState] = useState(() => getSettingsSnapshot().miniOnExit !== false);
  const [datasaver, setDatasaverState] = useState(() => !!getSettingsSnapshot().datasaver);
  // 播放独立窗策略（仅桌面壳显示的设置；SSG 期 window 未定，快照默认 'single'）
  const [playerWindow, setPlayerWindowState] = useState(
    () => (getSettingsSnapshot().playerWindow === 'multi' ? 'multi' : 'single'),
  );
  const [pwOpen, setPwOpen] = useState(false);
  // 液态玻璃（仅 iOS 26+ 设备显示该行；能力检测同步缓存，非支持端恒 false
  // 不渲染行也不订阅）；开关态经 settings 广播与各玻璃表面同步翻转
  const glassSupported = isGlassSupported();
  const [liquidGlass, setLiquidGlassState] = useState(() => !!getSettingsSnapshot().liquidGlass);
  // hook 形态保 SSG 水合对齐（web 首帧恒 false，见 lib/desktop-bridge.js）
  const desktop = useIsDesktopApp();
  // web 静态导出（SSG）期无 window，getApiBase() 取不到站点同源地址，直接渲染
  // 会把兜底默认（localhost:3001）烙进 mine.html；挂载后再显示真实值。原生端
  // 无 SSG，首帧即显示。
  const [showServerBase, setShowServerBase] = useState(Platform.OS !== 'web');
  useEffect(() => {
    if (Platform.OS === 'web') setShowServerBase(true);
  }, []);
  useEffect(() => {
    const off = subscribeSettings((s) => {
      if (!s) return;
      setAutoplayState(!!s.autoplay);
      setMiniOnExitState(s.miniOnExit !== false);
      setDatasaverState(!!s.datasaver);
      setPlayerWindowState(s.playerWindow === 'multi' ? 'multi' : 'single');
      setLiquidGlassState(!!s.liquidGlass);
    });
    return off;
  }, []);

  // 本地态立即翻转 + settings 落盘广播（存不进也保持会话内一致）
  const toggleAutoplay = () => {
    const next = !autoplay;
    setAutoplayState(next);
    setSetting('autoplay', next);
  };
  const toggleMiniOnExit = () => {
    const next = !miniOnExit;
    setMiniOnExitState(next);
    setSetting('miniOnExit', next);
  };
  const toggleDataSaver = () => {
    const next = !datasaver;
    setDatasaverState(next);
    setSetting('datasaver', next);
  };
  const toggleLiquidGlass = () => {
    const next = !liquidGlass;
    setLiquidGlassState(next);
    setSetting('liquidGlass', next);
  };

  // ===== Telegram 登录态（设置区状态行;轻量 GET session,失败按未登录展示,
  // 点击进专属页可见真实错误——不让本行挂页）=====
  // ''=检查中 string=已登录账号名 null=未登录;路由聚焦时重拉(从 /telegram
  // 登录返回即刷新本行)
  const [tgName, setTgName] = useState('');
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      api('telegram', 'session')
        .then((s) => {
          if (alive) setTgName(s && s.authorized && s.me ? (s.me.name || s.me.phone || 'Telegram 用户') : null);
        })
        .catch(() => { if (alive) setTgName(null); }); // 探测失败按未登录(专属页承载真实错误)
      return () => { alive = false; };
    }, [])
  );

  // ===== 服务器地址（settings.serverBase，保存即生效）=====
  const [serverOpen, setServerOpen] = useState(false);
  const [serverDraft, setServerDraft] = useState('');
  const openServerDialog = () => {
    setServerDraft(getApiBase());
    setServerOpen(true);
  };
  // 保存：归一化 → 写内存（后续请求即刻走新基址）→ 落盘广播 → 清旧基址缓存 →
  // 经上下文重拉站点清单（Guide 片源区/插件管理页换新后端列表；切站仍走
  // SiteContext）
  const applyServerBase = async (url) => {
    const base = await setApiBase(url);
    resetClientCache();
    setServerOpen(false);
    showToast('服务器地址已切换：' + base);
    refreshSites();
  };

  // ===== 清空历史确认（历史节管理态与设置节共用同一确认弹层）=====
  const [clearOpen, setClearOpen] = useState(false);
  const onClear = () => {
    setClearOpen(false);
    clearViews()
      .then(() => { setViews([]); showToast('已清空观看历史'); })
      .catch(() => {});
  };

  // ===== 切站入口收进插件管理页（/plugins）：本页不再平铺站点清单 =====

  // ===== 页内轻量 toast（对应 NextWeb sonner；自动消失）=====
  const [toastMsg, setToastMsg] = useState('');
  const toastTimer = useRef(null);
  const showToast = useCallback((msg) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), TOAST_MS);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // 当前站名与已加载计数（插件管理入口行的 desc）
  const currentName = (sites.find((s) => s && s.id === site) || {}).name || site;

  // 深链观看页：跨站条目带各自 site。多集片条目带 ep（recordView 归档的集号）→
  // 直达 vid-epN：进页即在播最后播放集 + 该集进度续播（免裸 vid 先闪第 1 集，
  // 也省一次归一化重解析）；无 ep（单集片/他站/旧数据）保持裸 id 由观看页处理。
  // 跳转口径统一 useOpenVideo（桌面壳主窗弹独立播放窗；navigate 语义保留——
  // 不往返回栈再压一层）
  const goVideo = useOpenVideo();
  const openVideo = useCallback((v) => {
    if (!v || v.id == null) return;
    const target = v.ep > 0 ? v.id + '-ep' + v.ep : v.id;
    goVideo(v.site, target, { method: 'navigate' });
  }, [goVideo]);

  // 内容水平留白：phone px-3 / pad·pc px-6（AppShell 主区同款约定）
  const padH = form === 'phone' ? 12 : 24;

  // 手机画幅壳层收放：本页主纵滚方向判定挂载
  const chromeScroll = useChromeScroll(form === 'phone');
  // 网格（pad·pc）：未测到容器宽（首帧）先不铺——AsyncStorage 首读极快，等一帧
  const columns = grid.columns;
  const cardWidth = grid.cardWidth;
  const gridReady = columns > 0 && cardWidth > 0;

  return (
    <View className="flex-1 bg-background">
      <ScreenScrollView
        className="flex-1"
        onScroll={chromeScroll.onScroll}
        scrollEventThrottle={chromeScroll.scrollEventThrottle}
        topGap={16}
        bottomGap={48}
        contentContainerStyle={{ paddingHorizontal: padH, gap: 32 }}
        showsVerticalScrollIndicator={false}
      >
        {/* ① 观看历史（页题档 20px/700；本页无独立页头，首个区块标题即页面标题） */}
        <View>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
            <Text style={{ flex: 1, minWidth: 0, fontSize: 20, fontWeight: '700', lineHeight: 28, color: p.foreground }}>
              观看历史
            </Text>
            {views.length > 0 ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                {managing ? (
                  <Button variant="ghost" onPress={() => setClearOpen(true)}>
                    <Trash size={16} color={p.accent} />
                    <Text style={{ fontSize: 14, fontWeight: '500', color: p.accent }}>清空全部</Text>
                  </Button>
                ) : null}
                {/* 管理/完成 = YouTube 控制行同款文字钮；管理态用灰面填充标出「已进入」 */}
                <Button
                  variant={managing ? 'secondary' : 'ghost'}
                  onPress={() => setManaging((m) => !m)}
                >
                  {managing ? '完成' : '管理'}
                </Button>
              </View>
            ) : null}
          </View>

          {views.length ? (
            form === 'phone' ? (
              // 手机画幅：横滚架（负外边距出血到屏幕边，首卡与内容左对齐、
              // 右侧卡片可滑出屏幕边——NextWeb -mx-3 px-3 同款手法）。
              // native 陷阱：内边距必须写 contentContainerStyle——写在 ScrollView
              // style 上时安卓的视口/内容测距与 web 不同（已知坑），会牵连子项
              // 宽度测量；出血只留负 margin 在 style 上
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ marginHorizontal: -padH }}
                contentContainerStyle={{ paddingHorizontal: padH, gap: 12, paddingBottom: 4 }}
              >
                {views.map((v) => (
                  <HistoryCard key={v.site + '_' + v.id} v={v} managing={managing} onOpen={openVideo} onRemove={onRemove} />
                ))}
              </ScrollView>
            ) : (
              // 平板/PC：网格（与首页同一套容器列算法；列距 16 / 行距 36，卡片撑满列宽）
              <View onLayout={grid.onLayout} style={gridReady ? { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 36 } : null}>
                {gridReady
                  ? views.map((v) => (
                    <HistoryCard key={v.site + '_' + v.id} v={v} grid width={cardWidth} managing={managing} onOpen={openVideo} onRemove={onRemove} />
                  ))
                  : null}
              </View>
            )
          ) : viewsLoaded ? (
            // 空态：图标 + 标题 + 说明 + 引导按钮（NextWeb EmptyState 同形态）
            <View style={{ paddingVertical: 64, alignItems: 'center', gap: 6 }}>
              <Clapperboard size={40} color={p.muted} opacity={0.5} />
              <Text style={{ marginTop: 4, fontSize: 14, color: p.muted }}>还没有观看记录</Text>
              <Text style={{ fontSize: 12, color: p.muted, opacity: 0.7 }}>去首页挑一部吧</Text>
              <View style={{ marginTop: 12 }}>
                <Button onPress={() => router.navigate('/')}>去逛逛</Button>
              </View>
            </View>
          ) : null}
        </View>

        {/* ② 我的收藏：全局共享清单（仅存自部署服务端，观看页星标收进同一份）；
            横滑最多 8 条，卡片对齐 HistoryCard 横滚形态（含站名行，点按直达
            观看页）；空态一行引导；「查看全部」进收藏页 /favorites 分页管理 */}
        <View>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
            <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
              <Text style={{ fontSize: 16, fontWeight: '500', color: p.foreground }}>我的收藏</Text>
              {favTotal > 0 ? (
                <Text style={{ fontSize: 13, color: p.muted }}>{favTotal}</Text>
              ) : null}
            </View>
            <Button variant="ghost" size="sm" onPress={() => router.push('/favorites')}>查看全部</Button>
          </View>
          {recentFavs && recentFavs.length ? (
            // 横滑架与①观看历史手机画幅同款：负外边距出血到屏幕边（内边距写
            // contentContainerStyle——安卓视口/内容测距坑，见上方注释）
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginHorizontal: -padH }}
              contentContainerStyle={{ paddingHorizontal: padH, gap: 12, paddingBottom: 4 }}
            >
              {recentFavs.map((f) => (
                <HistoryCard key={f.site + '_' + f.id} v={f} onOpen={openVideo} />
              ))}
            </ScrollView>
          ) : recentFavs ? (
            <Text style={{ fontSize: 13, color: p.muted }}>暂无收藏，去视频页点亮星标</Text>
          ) : null}
        </View>

        {/* ③ 片源：站源插件化管理入口（默认仅光速资源站；加载/卸载/切换在
            插件管理页——9 主站单行 + CMS 父子结构；平铺切站见 Guide 片源区） */}
        <View>
          <Text style={{ marginBottom: 12, fontSize: 16, fontWeight: '500', color: p.foreground }}>片源</Text>
          <SettingRow
            icon={Plug}
            label="插件管理"
            desc={'当前：' + currentName + ' · 已加载 ' + visibleSites.length + ' 个站源'}
            onPress={() => router.push('/plugins')}
          />
        </View>

        {/* ④ 设置：外观三档 / 自动连播 / 退出时悬浮播放 / 省流模式 / 服务器地址 /
            清除观看历史（PWA「安装应用」行不移植：三端 App 本就是安装态） */}
        <View>
          <Text style={{ marginBottom: 12, fontSize: 16, fontWeight: '500', color: p.foreground }}>设置</Text>
          <View>
            {THEMES.map((t) => (
              <SettingRow
                key={t.key}
                icon={t.icon}
                label={t.label}
                onPress={() => setMode(t.key)}
                right={mode === t.key ? <Check size={16} color={p.foreground} /> : null}
              />
            ))}
            {/* 液态玻璃（仅 iOS 26+ 设备显示）：悬浮层系统玻璃质感，关 = 回到
                不透明底；系统「减弱透明度」开启时也会自动降级（glass.js 判定） */}
            {glassSupported ? (
              <SettingRow
                icon={Sparkle}
                label="液态玻璃"
                desc="顶栏/底栏/播放器控件等悬浮层的玻璃质感"
                right={(
                  <Pressable
                    accessibilityRole="switch"
                    accessibilityLabel="液态玻璃"
                    accessibilityState={{ checked: liquidGlass }}
                    hitSlop={8}
                    onPress={toggleLiquidGlass}
                  >
                    <TogglePill on={liquidGlass} />
                  </Pressable>
                )}
              />
            ) : null}
            {/* 开关行：行尾 Pressable 承担点按（行本体非按钮，避免嵌套按钮） */}
            <SettingRow
              icon={PlayCircle}
              label="自动连播"
              right={(
                <Pressable
                  accessibilityRole="switch"
                  accessibilityLabel="自动连播"
                  accessibilityState={{ checked: autoplay }}
                  hitSlop={8}
                  onPress={toggleAutoplay}
                >
                  <TogglePill on={autoplay} />
                </Pressable>
              )}
            />
            {/* 退出时悬浮播放：退出观看页后视频缩为悬浮小窗继续播放（默认开=
                既有行为）；关闭 = 退出即停止播放（player-context 路由相位 effect
                收敛 close()，观看页返回编排同步跳过）。控制条「小窗播放」钮是
                显式操作，不受此开关影响 */}
            <SettingRow
              icon={Pip}
              label="退出时悬浮播放"
              desc="退出播放页后视频缩为悬浮小窗继续播放，关闭则退出即停止播放"
              right={(
                <Pressable
                  accessibilityRole="switch"
                  accessibilityLabel="退出时悬浮播放"
                  accessibilityState={{ checked: miniOnExit }}
                  hitSlop={8}
                  onPress={toggleMiniOnExit}
                >
                  <TogglePill on={miniOnExit} />
                </Pressable>
              )}
            />
            {/* 省流模式：封面统一 320 宽降档小图（RN 侧实际生效面） */}
            <SettingRow
              icon={Speed}
              label="省流模式"
              desc="封面统一改用 320 宽小图，节省流量"
              right={(
                <Pressable
                  accessibilityRole="switch"
                  accessibilityLabel="省流模式"
                  accessibilityState={{ checked: datasaver }}
                  hitSlop={8}
                  onPress={toggleDataSaver}
                >
                  <TogglePill on={datasaver} />
                </Pressable>
              )}
            />
            {/* 播放窗口模式（仅桌面 Electron 壳显示）：视频播放页开独立窗，
                single=复用一个播放窗 / multi=每视频一新窗（desktop/main.js 消费） */}
            {desktop ? (
              <SettingRow
                icon={WinMaximize}
                label="播放窗口模式"
                desc="视频在独立播放窗口打开（仅桌面端）"
                right={(
                  <Text numberOfLines={1} style={{ fontSize: 13, color: p.muted }}>
                    {playerWindow === 'multi' ? '多窗口' : '单窗口'}
                  </Text>
                )}
                onPress={() => setPwOpen(true)}
              />
            ) : null}
            {/* 服务器地址：web 生产默认=站点同源地址，dev/原生默认=localhost:3001；
                真机访问电脑后端改这里。desc 挂载后才取值（见 showServerBase 注释） */}
            <SettingRow
              icon={Server}
              label="服务器地址"
              desc={showServerBase ? getApiBase() : '（进入后显示）'}
              onPress={openServerDialog}
            />
            {/* Telegram 登录状态行:已登录显账号名,未登录显「去登录」;
                点击进 /telegram 专属页(登录流程 + 对话列表) */}
            <SettingRow
              icon={Send}
              label="Telegram"
              desc={tgName === '' ? '正在检查登录状态…' : tgName ? '已登录:' + tgName : '未登录,点击去登录'}
              onPress={() => router.push('/telegram')}
            />
            <SettingRow icon={Trash} label="清除观看历史" onPress={() => setClearOpen(true)} />
          </View>
        </View>

        {/* ⑤ 关于：版本 / 定位声明 / 仅供站方授权测试使用 */}
        <View>
          <Text style={{ marginBottom: 12, fontSize: 16, fontWeight: '500', color: p.foreground }}>关于</Text>
          <View style={{ borderRadius: 12, backgroundColor: p.surface, padding: 16 }}>
            <Text style={{ fontSize: 14, lineHeight: 24, color: p.muted }}>
              月幕 Moontent 是一个多源插件化的纯净视频站：无账号、无积分，只保留视频本身。观看足迹与播放进度仅存于本机设备，不上传任何数据；收藏则是全设备共享的同一份清单，仅存于你自部署的服务端，不上传任何第三方。{'\n'}
              版本 {(appConfig && appConfig.expo && appConfig.expo.version) || '—'}。本应用仅供站方授权测试使用。
            </Text>
          </View>
        </View>
      </ScreenScrollView>

      {/* 页内轻量反馈条（toast）：底部居中，自动消失 */}
      {toastMsg ? (
        <View style={{ position: 'absolute', bottom: 24, left: 0, right: 0, alignItems: 'center', pointerEvents: 'none' }}>
          <View style={{ borderRadius: 8, backgroundColor: p.surface2, paddingHorizontal: 16, paddingVertical: 10, maxWidth: '86%' }}>
            <Text numberOfLines={2} style={{ fontSize: 14, color: p.foreground }}>{toastMsg}</Text>
          </View>
        </View>
      ) : null}

      {/* 清空观看历史确认（历史节「清空全部」与设置节共用） */}
      <Dialog visible={clearOpen} onClose={() => setClearOpen(false)} title="清空观看历史">
        <Text style={{ fontSize: 14, lineHeight: 20, color: p.muted }}>
          确定清空全部观看历史？此操作不可撤销。
        </Text>
        <View style={{ marginTop: 20, flexDirection: 'row', justifyContent: 'flex-end', gap: 12 }}>
          <Button variant="secondary" onPress={() => setClearOpen(false)}>取消</Button>
          {/* 危险操作 = 品牌红实心胶囊（与 Guide 清除历史确认弹层同款） */}
          <Button onPress={onClear} style={{ backgroundColor: p.accent }}>
            <Text style={{ fontSize: 14, fontWeight: '500', color: '#ffffff' }}>清空</Text>
          </Button>
        </View>
      </Dialog>

      {/* 播放窗口模式二选一（仅桌面壳显示的设置；写 settings.playerWindow，
          lib/open-video.js 跳转时读快照派发给主进程） */}
      <Dialog visible={pwOpen} onClose={() => setPwOpen(false)} title="播放窗口模式">
        <Text style={{ fontSize: 14, lineHeight: 20, color: p.muted }}>
          在主窗口点击视频时的打开方式。
        </Text>
        <View style={{ marginTop: 12 }}>
          {PLAYER_WINDOWS.map((w) => (
            <SettingRow
              key={w.key}
              icon={w.icon}
              label={w.label}
              desc={w.desc}
              onPress={() => {
                setPlayerWindowState(w.key);
                setSetting('playerWindow', w.key);
                setPwOpen(false);
              }}
              right={playerWindow === w.key ? <Check size={16} color={p.foreground} /> : null}
            />
          ))}
        </View>
      </Dialog>

      {/* 服务器地址编辑：保存即生效（内存基址立即切换 + 落盘 serverBase） */}
      <Dialog visible={serverOpen} onClose={() => setServerOpen(false)} title="服务器地址">
        <Text style={{ fontSize: 14, lineHeight: 20, color: p.muted }}>
          后端 Koa 服务地址。真机访问电脑后端时，改为电脑的局域网地址（如 http://192.168.1.100:3001）。
        </Text>
        <Input
          value={serverDraft}
          onChangeText={setServerDraft}
          placeholder={DEFAULT_API_BASE}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={{ marginTop: 16 }}
        />
        <View style={{ marginTop: 20, flexDirection: 'row', justifyContent: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <Button variant="ghost" onPress={() => { applyServerBase(''); }}>
            <Text style={{ fontSize: 14, fontWeight: '500', color: p.muted }}>恢复默认</Text>
          </Button>
          <Button variant="secondary" onPress={() => setServerOpen(false)}>取消</Button>
          <Button onPress={() => { applyServerBase(serverDraft); }}>保存</Button>
        </View>
      </Dialog>
    </View>
  );
}
