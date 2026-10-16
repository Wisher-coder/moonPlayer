// ============================================================================
// 搜索页 —— ?kw=<关键词> 驱动的 YouTube 搜索形态；未搜索时展示「最近的搜索
// 记录」（逐行列表，整行点击重搜、行尾 X 单条删、标题行「清除」Dialog 确认
// 后整页清空）+「热门搜索」热词 chips（有此能力的站）。
// ----------------------------------------------------------------------------
// 相册面（albums 能力站，如艾薇社区）：有结果时顶部出现「视频 / 相册」scope
// 切换 chips（?scope=album 深链），相册态走 albumsearch + AlbumGrid 方卡网格。
// 本地搜索历史按站点隔离（history.js 契约：addSearch/getSearches/clearSearches，
// AsyncStorage 键 moontent_search_{site}，去重置前、上限 10 条）。
// 交互语义 1:1 移植自 NextWeb/src/components/tabs/SearchTab.jsx，RN 三端适配点：
//   · 输入位按端分工（YouTube 形态，全应用任一时刻只有一个搜索输入框）：手机
//     端本页整页沉浸（AppShell 收起顶栏底栏），页面自绘「返回 + 输入」头，
//     每次裸进入都自动聚焦弹键盘（useFocusEffect 驱动，(tabs) 保活重进也生
//     效），提交收键盘看结果；平板/PC 顶栏胶囊即真输入框，本页不再渲染页内
//     输入行（NextWeb 桌面 md 分工同款）；顶栏输入位文字经 searchbar-store
//     与本页关键词联动（结果页输入框里就是当前关键词，离开即清空）；
//   · URL 参数读 useLocalSearchParams（expo-router 承接 useSearchParams），
//     push 进历史栈（逐级返回上一轮结果）、replace 切 scope，语义同 NextWeb；
//   · 视频结果自管 FlashList（行式 CompactCard 回收），底态条渲染在列表流内；
//     相册结果走共享 AlbumGrid（无 footer 槽），底态条与首页同款常驻位；
//   · fetcher 未就绪/未搜索解析空结果而非挂起（RN 版 useInfiniteList 的在途
//     锁无 force 通道，挂起会永久卡死，见 index.js 文件头说明）；
//   · 无 toast 通道（契约未含）：清空/空关键词以界面即时反馈替代提示文案；
//     单条删除经「清空 + 逆序回填」history.js 公开 API 重建（不绕过存储层）。
// ============================================================================
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, Clock, Gallery, Search as SearchIcon, SearchX, Trash, Close } from '../../components/icons.js';
import { api } from '../../lib/client.js';
import { useSite } from '../../lib/site-context.jsx';
import { useOpenVideo } from '../../lib/open-video.js';
import usePressVisual from '../../lib/use-press-visual.js';
import { useForm } from '../../lib/use-form.js';
import { usePalette } from '../../components/ui/palette.js';
import { addSearch, getSearches, clearSearches } from '../../lib/history.js';
import { setPageKw } from '../../lib/searchbar-store.js';
import { useInfiniteList, toPage } from '../../hooks/use-infinite-list.js';
import CompactCard from '../../components/video/CompactCard.jsx';
import AlbumGrid from '../../components/album/AlbumGrid.jsx';
import ChipsBar from '../../components/video/ChipsBar.jsx';
import Input from '../../components/ui/Input.jsx';
import Button from '../../components/ui/Button.jsx';
import Dialog from '../../components/ui/Dialog.jsx';
import GlassSurface from '../../components/ui/GlassSurface.jsx';
import Skeleton from '../../components/ui/Skeleton.jsx';
import EmptyState from '../../components/home/EmptyState.jsx';
import ErrorState from '../../components/home/ErrorState.jsx';
import ListFooter from '../../components/home/ListFooter.jsx';
import { useGlassEnabled } from '../../lib/glass.js';
import { TOPBAR_H } from '../../lib/chrome-metrics.js';

const SIZE = 24;
const SCOPE_ITEMS = [
  { key: 'video', label: '视频' },
  { key: 'album', label: '相册' },
];

// expo-router 参数值防御式归一：可能为 string | string[] | undefined，一律取首值字符串
const one = (v) => {
  const x = Array.isArray(v) ? v[0] : v;
  return x == null ? '' : String(x);
};

// 热词防御式提取：字符串直取；对象取 word/name
const wordOf = (x) => (typeof x === 'string' ? x.trim() : x && typeof x === 'object' ? String(x.word ?? x.name ?? '').trim() : '');

// 结果行键：脏条目（无 id）按序号补键，不炸列表
const keyOf = (v, i) => (v && v.id != null ? String(v.id) : 'x_' + i);

// 搜索输入行：胶囊输入框 + 圆形搜索钮（NextWeb 移动端吸顶搜索行的 RN 版）。
// 仅手机端渲染——平板/PC 顶栏胶囊即真输入框，本页不再放第二个输入位。
// autoFocus 只管首挂载即时落焦；(tabs) 保活下每次进入的聚焦由页级
// useFocusEffect 经 inputRef 主动 focus() 驱动（见组件内说明）。
function SearchInputRow({ value, onChange, onSubmit, autoFocus, inputRef }) {
  const p = usePalette();
  // 玻璃端：输入胶囊浮在玻璃工具条上——HIG 玻璃上禁叠玻璃，内嵌控件走
  // 透明/fill；输入底改透明吃玻璃材质（描边保留），降级端不透明底原样
  const glass = useGlassEnabled();
  // 布局纯静态 + 视觉态事件 state（安卓端 Pressable 样式函数携带的布局属性
  // 不生效，见 lib/use-press-visual.js 头注）
  const hv = usePressVisual();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Input
        ref={inputRef}
        value={value}
        onChangeText={onChange}
        placeholder="输入关键词，回车搜索"
        returnKeyType="search"
        onSubmitEditing={onSubmit}
        autoFocus={autoFocus}
        clearButtonMode="while-editing" // iOS 原生清除钮（YouTube 输入框形态；安卓忽略）
        style={{
          flex: 1,
          height: 40,
          borderRadius: 20, // 胶囊（与搜索钮同高同圆角；chip 的 8px 圆角不用于输入框）
          paddingHorizontal: 16,
          borderWidth: 1,
          borderColor: p.line,
          backgroundColor: glass ? 'transparent' : p.background,
          fontSize: 16,
        }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="搜索"
        onPress={onSubmit}
        {...hv.binds}
        style={[
          { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
          { backgroundColor: hv.hovered ? p.line : p.surface2, opacity: hv.pressed ? 0.85 : 1 },
        ]}
      >
        <SearchIcon size={16} color={p.muted} />
      </Pressable>
    </View>
  );
}

// 结果列表骨架：CompactCard(md) 形态的行式占位（缩略宽随画幅三档，与卡片同步）
function ResultSkeleton() {
  const { form } = useForm();
  const w = form === 'pc' ? 500 : form === 'pad' ? 246 : 168;
  return (
    <View style={{ gap: 16 }}>
      {Array.from({ length: 8 }, (_, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: form === 'phone' ? 8 : 16 }}>
          <Skeleton style={{ width: w, aspectRatio: 16 / 9, borderRadius: 12 }} />
          <View style={{ flex: 1, minWidth: 0, gap: 8, paddingVertical: 2 }}>
            <Skeleton style={{ height: 18 }} />
            <Skeleton style={{ height: 18, width: '60%' }} />
            <Skeleton style={{ height: 14, width: 96 }} />
          </View>
        </View>
      ))}
    </View>
  );
}

// 返回钮（手机端自绘搜索头）：布局纯静态 + 悬停/按压视觉态事件 state（安卓
// 端 Pressable 样式函数携带的布局属性不生效，见 lib/use-press-visual.js 头注）
function BackBtn({ goBack }) {
  const p = usePalette();
  const hv = usePressVisual();
  return (
    <Pressable
      onPress={goBack}
      accessibilityRole="button"
      accessibilityLabel="返回"
      hitSlop={8}
      {...hv.binds}
      style={[
        { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
        { backgroundColor: hv.hovered || hv.pressed ? p.surface2 : 'transparent' },
      ]}
    >
      <ChevronLeft size={24} color={p.foreground} />
    </Pressable>
  );
}

// 搜索历史行：词条主体（flex 承重墙内 stretch）+ 行尾删除小钮。承重墙范式
//（flex 挂普通 View）保留，样式全部静态对象，视觉态走事件 state。
function HistRow({ w, onSearch, onRemove }) {
  const p = usePalette();
  const rowHv = usePressVisual();
  const delHv = usePressVisual();
  return (
    <>
      <View style={{ flex: 1, minWidth: 0, height: '100%' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={'搜索 ' + w}
          onPress={() => onSearch(w)}
          {...rowHv.binds}
          style={[
            { height: '100%', justifyContent: 'center', borderRadius: 8 },
            { backgroundColor: rowHv.hovered ? p.surface2 : 'transparent' },
          ]}
        >
          <Text numberOfLines={1} style={{ fontSize: 14, color: p.foreground }}>{w}</Text>
        </Pressable>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={'删除记录：' + w}
        hitSlop={6}
        onPress={() => onRemove(w)}
        {...delHv.binds}
        style={[
          { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
          { backgroundColor: delHv.hovered ? p.line : 'transparent' },
        ]}
      >
        <Close size={16} color={p.muted} />
      </Pressable>
    </>
  );
}

export default function Search() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const p = usePalette();
  const { form } = useForm();
  const { site, caps, ready } = useSite();
  const insets = useSafeAreaInsets();

  const padH = form === 'phone' ? 12 : 24; // 页边距：px-3 / md:px-6

  // —— URL → 搜索状态（唯一事实源；kw 变化自动重搜，scope 仅 albums 能力站生效）——
  const kw = one(params.kw).trim();
  const scope = caps.albums && one(params.scope) === 'album' ? 'album' : 'video';

  // 首帧初始词（ref 固定）：裸进入自动聚焦弹键盘；带词深链（视频页标签）不抢焦点
  const initialKw = useRef(kw).current;
  const inputRef = useRef(null);

  // 进入即聚焦（YouTube 行为）：autoFocus 仅首次挂载生效，(tabs) 保活下再次进
  // 入不重挂载，且挂载可能早于页切换完成（焦点被吞）——改由 useFocusEffect 在
  // 每次获得焦点时显式 focus()。仅手机端 + 裸进入（无 kw）执行：带词深链/保
  // 留的上一轮结果不抢焦点弹键盘；延时等切换过渡收尾，键盘才能稳定弹出
  useFocusEffect(
    useCallback(() => {
      if (form !== 'phone' || kw) return;
      const t = setTimeout(() => inputRef.current && inputRef.current.focus(), 150);
      return () => clearTimeout(t);
    }, [form, kw])
  );

  const [input, setInput] = useState(kw); // 输入框本地态：未提交前不影响 kw，不触发搜索
  useEffect(() => { setInput(kw); }, [kw]); // 地址栏 kw 变化（后退/热词点击）回填输入框

  // 顶栏搜索胶囊联动（YouTube：结果页搜索框里就是当前关键词）；离开搜索页
  // （本屏卸载/被换下）清空顶栏残留
  useEffect(() => {
    setPageKw(kw);
    return () => setPageKw('');
  }, [kw]);

  // —— 本地历史：挂载/切站后读取（AsyncStorage 异步；失败按空处理）——
  const [hist, setHist] = useState([]);
  useEffect(() => {
    let alive = true;
    getSearches(site)
      .then((a) => { if (alive) setHist(a); })
      .catch(() => {});
    return () => { alive = false; };
  }, [site]);

  // —— 热词（仅 hotwords 能力的站；与输入无关；meta 层有 5 分钟缓存）——
  const [hot, setHot] = useState({ loading: true, error: '', words: [] });
  useEffect(() => {
    if (!ready || !caps.hotwords) return;
    let alive = true;
    setHot({ loading: true, error: '', words: [] });
    api(site, 'hotwords')
      .then((d) => {
        if (!alive) return;
        const raw = Array.isArray(d) ? d : (d && Array.isArray(d.items) ? d.items : []);
        setHot({ loading: false, error: '', words: raw.map(wordOf).filter(Boolean) });
      })
      .catch((e) => {
        if (!alive) return;
        setHot({ loading: false, error: (e && e.message) || String(e), words: [] });
      });
    return () => { alive = false; };
  }, [site, ready, caps.hotwords]);
  // 热词 chips 条目（key 去重后缀；点击经 key 反查文案再搜）
  const hotItems = hot.words.map((w, i) => ({ key: w + '_' + i, label: w }));

  // —— 结果：kw 变化自动重搜（deps 含 site，切站自动换源重搜）——
  const fetcher = useCallback(
    (page) => {
      if (!ready || !kw) return Promise.resolve({ items: [], hasMore: false }); // 未就绪/未搜索
      if (scope === 'album') return api(site, 'albumsearch', { kw, page, size: SIZE }).then(toPage);
      return api(site, 'search', { kw, page, size: SIZE }).then(toPage);
    },
    [site, kw, ready, scope]
  );
  const { items, loading, loadingMore, err, done, loadMore, reload } =
    useInfiniteList(fetcher, [site, kw, ready, scope]);

  // scope 切换：保留 kw，增删 ?scope=album（replace 不新增历史项）；导航后由
  // useLocalSearchParams 落回本地状态
  const switchScope = useCallback(
    (s) => {
      if (s === scope) return;
      router.replace('/search?kw=' + encodeURIComponent(kw) + (s === 'album' ? '&scope=album' : ''));
    },
    [kw, scope, router]
  );

  // 触发搜索：提交输入框 / 点击热词 / 点击历史；写本地历史（去重置前、上限 10）。
  // 本页在 (tabs) 保活组内，push 到带参本 tab 由 TabRouter 原地替换 ?kw=（kw
  // 变化经 useLocalSearchParams 自动重搜，无历史栈叠加）；相同关键词不重复导航
  const doSearch = useCallback(
    (word) => {
      const w = (word == null ? input : word).trim();
      if (!w) return; // 空关键词：忽略（无 toast 通道，不打扰）
      Keyboard.dismiss(); // 提交即收键盘看结果（YouTube 行为）
      setInput(w);
      addSearch(site, w)
        .then(() => getSearches(site))
        .then((a) => setHist(a))
        .catch(() => {});
      if (kw !== w) router.push('/search?kw=' + encodeURIComponent(w));
    },
    [input, kw, router, site]
  );

  // 单条删除：history.js 契约未提供单删接口，经「清空 + 逆序回填」公开 API 重建
  // （全部任务走同一条串行写链，不绕过存储层；addSearch 去重置前，旧→新逐条
  // 插入后数组即恢复原顺序）
  const removeHistOne = useCallback(
    (w) => {
      const rest = hist.filter((x) => x !== w);
      setHist(rest); // 乐观更新
      clearSearches(site)
        .then(() => Promise.all(rest.slice().reverse().map((x) => addSearch(site, x))))
        .then(() => getSearches(site))
        .then((a) => setHist(a))
        .catch(() => {});
    },
    [hist, site]
  );

  // 整页清空（Dialog 确认后执行）
  const [confirmClear, setConfirmClear] = useState(false);
  const clearHist = useCallback(() => {
    setConfirmClear(false);
    setHist([]);
    clearSearches(site).catch(() => {});
  }, [site]);

  // 卡片深链：视频进观看页 / 相册进相册详情页（URL 均携带站点）；视频跳转
  // 口径统一 useOpenVideo（桌面壳主窗弹独立播放窗）
  const goVideo = useOpenVideo();
  const openVideo = useCallback(
    (v) => {
      if (v && v.id != null) goVideo(site, v.id);
    },
    [site, goVideo]
  );
  const openAlbum = useCallback(
    (a) => {
      if (a && a.id != null) router.push('/album/' + site + '/' + encodeURIComponent(String(a.id)));
    },
    [site, router]
  );

  // ———————————————— 手机端沉浸头部与键盘适配（YouTube App 形态）————————————
  // 返回：有栈回退，直达（冷启动深链/清栈）回首页（video 页同款语义）
  const goBack = useCallback(() => {
    if (typeof router.canGoBack === 'function' && router.canGoBack()) router.back();
    else router.navigate('/');
  }, [router]);

  // 底部安全区垫高：手机端本页无底栏（整页沉浸），滚动内容自垫手势条高度
  const padB = form === 'phone' ? insets.bottom : 0;
  // 键盘避让：iOS 用 padding（输入行居顶、下方内容不被遮）；Android 交给
  // adjustResize；web 无软键盘无感
  const kbBehavior = Platform.OS === 'ios' ? 'padding' : undefined;

  // 自绘搜索头：安全区垫高 + 返回钮 + 输入行（替代被 AppShell 收起的顶栏，
  // 本页唯一输入位；仅手机端渲染）。iOS 26 玻璃端按 HIG 重排为玻璃工具条：
  // absolute 浮在内容之上（玻璃属「功能层」，内容从底下滚过被折射），
  // 返回钮/输入胶囊为玻璃上的内嵌控件走 fill/透明（HIG 禁 glass-on-glass）；
  // 各滚动分支自垫 bodyTop 让初始内容落在工具条下方。降级端流内原样
  const glass = useGlassEnabled();
  const glassHeader = glass && form === 'phone';
  const headerH = insets.top + TOPBAR_H; // 安全区 + 顶栏高（chrome-metrics 同口径）
  const bodyTop = glassHeader ? headerH : 0; // 玻璃端：滚动内容自垫工具条高度
  const headerRow = (
    <View
      style={{
        height: TOPBAR_H, // 与顶栏同高（chrome-metrics）
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 8,
      }}
    >
      <BackBtn goBack={goBack} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <SearchInputRow
          value={input}
          onChange={setInput}
          onSubmit={() => doSearch()}
          autoFocus={!initialKw}
          inputRef={inputRef}
        />
      </View>
    </View>
  );
  const searchHeader = glassHeader ? (
    <GlassSurface
      style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 30, pointerEvents: 'box-none' }}
      glassOnlyStyle={{ paddingTop: insets.top }}
    >
      {headerRow}
    </GlassSurface>
  ) : form === 'phone' ? (
    <View style={{ paddingTop: insets.top }}>{headerRow}</View>
  ) : null;

  const hasList = !!(items && items.length);
  const footer = (
    <ListFooter loading={loadingMore} error={err || ''} done={done} onRetry={loadMore} />
  );

  // ———————————————— 上下文未就绪：头部照常 + 结果骨架 ————————————————
  if (!ready) {
    return (
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={kbBehavior}>
        {searchHeader}
        <View style={{ paddingHorizontal: padH, paddingTop: form === 'phone' ? 4 + bodyTop : 16 }}>
          <ResultSkeleton />
        </View>
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={kbBehavior}>
      {/* 手机端自绘搜索头（返回 + 输入）；平板/PC 顶栏即输入位，本页无输入行 */}
      {searchHeader}

      {!kw ? (
        // ———————————————— 未搜索：最近的搜索记录 + 热门搜索 ————————————————
        <ScrollView
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: padH, paddingTop: 16 + bodyTop, paddingBottom: 16 + padB, gap: 24 }}
        >
          <View>
            <View style={{ marginBottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 16, fontWeight: '500', color: p.foreground }}>最近的搜索记录</Text>
              {hist.length > 0 ? (
                <Button variant="ghost" size="sm" onPress={() => setConfirmClear(true)}>
                  <Trash size={14} color={p.foreground} />
                  <Text style={{ color: p.foreground, fontSize: 12, fontWeight: '500', includeFontPadding: false }}>清除</Text>
                </Button>
              ) : null}
            </View>
            {hist.length ? (
              <View>
                {hist.map((w, i) => (
                  <View
                    key={w + '_' + i}
                    style={{ height: 40, flexDirection: 'row', alignItems: 'center', gap: 16 }}
                  >
                    <Clock size={16} color={p.muted} />
                    <HistRow w={w} onSearch={doSearch} onRemove={removeHistOne} />
                  </View>
                ))}
              </View>
            ) : (
              <Text style={{ paddingHorizontal: 8, fontSize: 12, color: p.muted }}>还没有搜索记录</Text>
            )}
          </View>

          {caps.hotwords ? (
            <View>
              <Text style={{ marginBottom: 12, fontSize: 16, fontWeight: '500', color: p.foreground }}>热门搜索</Text>
              {hot.loading ? (
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  {Array.from({ length: 8 }, (_, i) => (
                    <Skeleton key={i} style={{ height: 32, width: 80, borderRadius: 8 }} />
                  ))}
                </View>
              ) : hot.error ? (
                <Text style={{ paddingHorizontal: 8, fontSize: 12, color: p.muted }}>
                  {'热词加载失败：' + hot.error}
                </Text>
              ) : hot.words.length ? (
                <ChipsBar
                  items={hotItems}
                  onChange={(k) => {
                    const it = hotItems.find((x) => x.key === k);
                    if (it) doSearch(it.label);
                  }}
                />
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      ) : loading ? (
        // ———————————————— 首屏加载骨架 ————————————————
        <View style={{ flex: 1, paddingHorizontal: padH, paddingTop: 16 + bodyTop }}>
          {scope === 'album' ? (
            <View style={{ gap: 16 }}>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <Skeleton style={{ height: 32, width: 64, borderRadius: 8 }} />
                <Skeleton style={{ height: 32, width: 64, borderRadius: 8 }} />
              </View>
              <AlbumGrid loading={12} />
            </View>
          ) : (
            <ResultSkeleton />
          )}
        </View>
      ) : err && !items ? (
        // ———————————————— 首屏失败 ————————————————
        <ScrollView
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: padH, paddingTop: bodyTop, paddingBottom: padB }}
        >
          <ErrorState message={err} onRetry={reload} />
        </ScrollView>
      ) : !hasList ? (
        // ———————————————— 无结果空态 ————————————————
        <ScrollView
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: padH, paddingTop: bodyTop, paddingBottom: padB }}
        >
          {scope === 'album' ? (
            <EmptyState icon={Gallery} title="未找到相关相册" desc="换个关键词试试" />
          ) : (
            <EmptyState icon={SearchX} title="未找到相关视频" desc="换个关键词试试" />
          )}
        </ScrollView>
      ) : scope === 'album' ? (
        // ———————————————— 相册结果：scope chips + 方卡网格（与 /albums 浏览页同形态）————————————————
        <View style={{ flex: 1 }}>
          {caps.albums ? (
            <View style={{ paddingHorizontal: padH, paddingTop: 16 + bodyTop, paddingBottom: 4 }}>
              <ChipsBar items={SCOPE_ITEMS} active="album" onChange={switchScope} />
            </View>
          ) : null}
          <View style={{ flex: 1, minHeight: 0, paddingHorizontal: padH }}>
            <AlbumGrid items={items} onPress={openAlbum} onEndReached={loadMore} />
          </View>
          <View style={{ paddingHorizontal: padH, paddingBottom: padB }}>{footer}</View>
        </View>
      ) : (
        // ———————————————— 视频结果：scope chips + CompactCard 行式纵排 ————————————————
        <FlashList
          data={items}
          keyExtractor={keyOf}
          estimatedItemSize={220}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16} // FlashList v2 内部恒挂 onScroll,不传会被 RNW 逐滚动事件打提示
          keyboardShouldPersistTaps="handled"
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          contentContainerStyle={{ paddingHorizontal: padH, paddingTop: 16 + bodyTop, paddingBottom: 12 + padB }}
          ListHeaderComponent={
            caps.albums ? (
              <View style={{ marginBottom: 16 }}>
                <ChipsBar items={SCOPE_ITEMS} active="video" onChange={switchScope} />
              </View>
            ) : null
          }
          ListFooterComponent={footer}
          renderItem={({ item }) => (
            <CompactCard item={item} size="md" onPress={openVideo} />
          )}
        />
      )}

      {/* 清空搜索历史确认框 */}
      <Dialog
        visible={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="清空搜索历史"
      >
        <Text style={{ fontSize: 14, color: p.muted, lineHeight: 20 }}>
          确定清空全部搜索历史？此操作不可撤销。
        </Text>
        <View style={{ marginTop: 16, flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="secondary" onPress={() => setConfirmClear(false)}>取消</Button>
          <Button onPress={clearHist}>清空</Button>
        </View>
      </Dialog>
    </KeyboardAvoidingView>
  );
}
