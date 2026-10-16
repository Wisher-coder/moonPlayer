// ============================================================================
// favorites.js —— 「我的收藏」页（/favorites，独立路由页，board.js 同款形态）
// ----------------------------------------------------------------------------
// 收藏域（fav-api.js / fav-store.js 基建）的全量管理面：
//   · 数据面：favList 分页清单（page/size=24 + hasMore 无限滚动）+ store 的
//     keys/total 镜像（进入与路由聚焦时 refreshFavs() 静默同步——收藏是多端
//     共享清单，最终一致；失败静默不清现有态，绝不弹错）；
//   · 筛选面：站点 chips（全部 + 出现过的站点，从 store keys 前缀推导，
//     切换即重载）+ 标题搜索框（~400ms 防抖 → favList({kw}) 重载，空 kw
//     恢复全量）；
//   · 管理面：「管理」模式卡片多选（FavGrid 勾选钮，视觉对齐 mine.js 历史
//     管理）→ 批量删除（favRemove 成功后 removeFavsLocal + 重载）→「清空
//     全部」Dialog 二次确认（对齐 mine.js 清空观看历史样式）；
//   · 兜底面：空态（无收藏大空态 + CTA「去逛逛」/ 筛选无结果小空态）、错误
//     态（重试按钮）、离线快照兜底（首屏拉取失败时 readFavSnapshot() 渲染 +
//     顶部「离线快照」横幅 + 本地 site/kw 过滤，不可翻页）、首屏骨架。
// 页面形态对齐 board.js：自绘页头（返回 chip + 标题，router.dismissTo('/') 回
// 首页）+ FlashList 网格；/favorites 不在 chrome-routes 白名单 → 手机画幅顶/
// 底栏整条收起，本页经 useChromeInsets 自垫安全区（白名单外页面只有安全区，
// 无栏高），列表 contentContainerStyle 垫底部安全区。静态导出评估期安全：
// 网络请求全部在 effect/事件里，store 模块加载只做 AsyncStorage 本地水合。
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { ChevronLeft, Search, SearchX, Star, Trash } from '../components/icons.js';
import { favClear, favList, favRemove } from '../lib/fav-api.js';
import {
  clearFavsLocal, readFavSnapshot, refreshFavs, removeFavsLocal,
  useFavKeys, useFavTotal,
} from '../lib/fav-store.js';
import { useSite } from '../lib/site-context.jsx';
import { useOpenVideo } from '../lib/open-video.js';
import { useForm } from '../lib/use-form.js';
import { usePalette } from '../components/ui/palette.js';
import { useInfiniteList, toPage } from '../hooks/use-infinite-list.js';
import { useChromeInsets } from '../hooks/use-chrome-scroll.js';
import Button from '../components/ui/Button.jsx';
import Dialog from '../components/ui/Dialog.jsx';
import Input from '../components/ui/Input.jsx';
import ChipsBar from '../components/video/ChipsBar.jsx';
import EmptyState from '../components/home/EmptyState.jsx';
import ErrorState from '../components/home/ErrorState.jsx';
import ListFooter from '../components/home/ListFooter.jsx';
import FavGrid from '../components/fav/FavGrid.jsx';

const SIZE = 24;                 // 分页尺寸（与服务端/首页口径一致）
const SEARCH_DEBOUNCE_MS = 400;  // 搜索防抖（~400ms）
const TOAST_MS = 2500;           // 页内反馈条自动消失时长（mine.js 同款）

export default function Favorites() {
  const p = usePalette();
  const { form } = useForm();
  const { sites } = useSite(); // 站名解析（全量清单，未加载站也查得到）
  const padH = form === 'phone' ? 12 : 24; // 页边距：px-3 / md:px-6
  // 壳层避让：手机画幅顶/底栏悬浮于内容之上（白名单外页面自垫安全区）
  const chrome = useChromeInsets();

  // ===== store 镜像（keys/total 随 refreshFavs 与 toggleFav 自动同步）=====
  const keys = useFavKeys();
  const total = useFavTotal();

  // ===== 筛选与搜索 =====
  const [siteFilter, setSiteFilter] = useState(''); // '' = 全部
  const [kw, setKw] = useState('');                 // 即时输入值
  const [kwDebounced, setKwDebounced] = useState(''); // 防抖后值（驱动重载）

  // ===== 管理态（多选/批量删除/清空）=====
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState(() => new Set()); // key = "site:id"
  const [clearOpen, setClearOpen] = useState(false);
  const [busy, setBusy] = useState(false); // 批量删/清空在途（防重复提交）

  // 搜索防抖：到点落 kwDebounced 触发列表重载，同时清空选中（选中项可能已
  // 不在新结果内；setState 在异步回调内，非 effect 体内直调）
  useEffect(() => {
    const t = setTimeout(() => {
      setKwDebounced(kw.trim());
      setSelected(new Set());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [kw]);

  // ===== 页内轻量反馈条（mine.js 同款：底部居中，自动消失）=====
  const [toastMsg, setToastMsg] = useState('');
  const toastTimer = useRef(null);
  const showToast = useCallback((msg) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), TOAST_MS);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // ===== 分页清单（切站点/搜索词由 deps 重置回第 1 页）=====
  const fetcher = useCallback(
    (page) => {
      const params = { page, size: SIZE };
      if (siteFilter) params.site = siteFilter;
      if (kwDebounced) params.kw = kwDebounced;
      return favList(params).then(toPage); // favList 返回 {items, hasMore}，toPage 天然兼容
    },
    [siteFilter, kwDebounced]
  );
  const { items, loading, loadingMore, err, done, loadMore, reload } =
    useInfiniteList(fetcher, [siteFilter, kwDebounced]);

  // 进入与路由聚焦：静默同步服务端清单（多端共享清单最终一致；失败静默，
  // 现有态/离线快照原样保留，绝不弹错）
  useFocusEffect(useCallback(() => { refreshFavs(); }, []));

  // ===== 离线快照兜底：挂载预读一次（首屏拉取失败时渲染 + 顶部横幅）=====
  const [snap, setSnap] = useState(null); // { ids, items, at } | null
  useEffect(() => {
    let alive = true;
    readFavSnapshot()
      .then((s) => { if (alive) setSnap(s); })
      .catch(() => { /* 坏数据/无快照按 null 处理 */ });
    return () => { alive = false; };
  }, []);

  // 快照条目的本地过滤（对齐服务端口径：site 精确 / kw 标题大小写不敏感）
  const snapItems = useMemo(() => {
    if (!snap || !Array.isArray(snap.items)) return [];
    let list = snap.items;
    if (siteFilter) list = list.filter((it) => it && it.site === siteFilter);
    if (kwDebounced) {
      const q = kwDebounced.toLowerCase();
      list = list.filter((it) => it && typeof it.title === 'string' && it.title.toLowerCase().indexOf(q) >= 0);
    }
    return list;
  }, [snap, siteFilter, kwDebounced]);

  // 离线快照模式：首屏拉取失败（无列表数据）但快照过滤后有内容 → 快照渲染 +
  // 横幅 + 重试（离线不可翻页/不可管理——删除/清空都要服务端可用）
  const offlineMode = !loading && items == null && !!err && snapItems.length > 0;

  // ===== 站点筛选 chips：全部 + 出现过的站点（store keys 前缀推导，序=最新收藏首见）=====
  const siteChips = useMemo(() => {
    const seen = [];
    for (const k of keys) {
      const i = k.indexOf(':');
      const s = i > 0 ? k.slice(0, i) : '';
      if (s && seen.indexOf(s) < 0) seen.push(s);
    }
    return seen;
  }, [keys]);
  // 站名解析：解析不到退显原始 site id（HistoryCard 同口径）
  const siteNameOf = useCallback(
    (sid) => (((sites || []).find((s) => s && s.id === sid) || {}).name) || (sid == null ? '' : String(sid)),
    [sites]
  );
  const chipItems = useMemo(
    () => [{ key: '', label: '全部' }].concat(siteChips.map((s) => ({ key: s, label: siteNameOf(s) }))),
    [siteChips, siteNameOf]
  );

  // 筛选站被删空（该站收藏全部移除后 chip 消失）→ 自动回「全部」（派生状态
  // 校正 effect，zones.js 的 tab 参数对齐同模式）
  useEffect(() => {
    if (siteFilter && siteChips.indexOf(siteFilter) < 0) setSiteFilter('');
  }, [siteFilter, siteChips]);

  // 离线模式禁管理（删除/清空依赖服务端）：强制退出管理态
  useEffect(() => {
    if (offlineMode && managing) {
      setManaging(false);
      setSelected(new Set());
    }
  }, [offlineMode, managing]);

  // 切站点筛选：本地状态先行清选中（列表随 deps 重载，选中项可能不在新站内）
  const changeSite = useCallback((k) => {
    setSiteFilter(k);
    setSelected(new Set());
  }, []);

  // ===== 深链观看页（跳转口径统一 useOpenVideo；条目带 ep 时自动 -ep{N}）=====
  const goVideo = useOpenVideo();
  const openVideo = useCallback(
    (v) => {
      if (!v || v.id == null) return;
      const target = v.ep > 0 ? v.id + '-ep' + v.ep : v.id;
      goVideo(v.site, target);
    },
    [goVideo]
  );

  // 管理态切换（退出时清空选中，对齐 mine.js 管理/完成文字钮形态）
  const toggleManaging = useCallback(() => {
    setManaging((m) => !m);
    setSelected(new Set());
  }, []);

  // 卡片选中切换（管理态卡身点按；key 与 FavGrid 网格键同口径）
  const toggleSelected = useCallback((v) => {
    if (!v || v.site == null || v.id == null) return;
    const key = String(v.site) + ':' + String(v.id);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // 批量删除选中项：favRemove → removeFavsLocal（本地清单同步）→ 清选中 →
  // 重载列表；失败 toast 错误原文（如「收藏服务暂不可用」）
  const onRemoveSelected = useCallback(async () => {
    const arr = Array.from(selected);
    if (!arr.length || busy) return;
    setBusy(true);
    try {
      const res = await favRemove(arr);
      removeFavsLocal(arr);
      setSelected(new Set());
      if (!res || !res.total) setManaging(false); // 全删光：退出管理态
      showToast('已删除 ' + (res && res.removed != null ? res.removed : arr.length) + ' 条收藏');
      reload();
    } catch (e) {
      showToast((e && e.message) || '删除失败，请重试');
    } finally {
      setBusy(false);
    }
  }, [selected, busy, reload, showToast]);

  // 清空全部（Dialog 二次确认后执行）：favClear → clearFavsLocal → 退出管理态 → 重载
  const onClear = useCallback(async () => {
    setClearOpen(false);
    if (busy) return;
    setBusy(true);
    try {
      await favClear();
      clearFavsLocal();
      setManaging(false);
      setSelected(new Set());
      showToast('已清空收藏');
      reload();
    } catch (e) {
      showToast((e && e.message) || '清空失败，请重试');
    } finally {
      setBusy(false);
    }
  }, [busy, reload, showToast]);

  // 离线横幅重试：静默重拉服务端清单 + 列表重载（任一成功即脱困）
  const retryOnline = useCallback(() => {
    refreshFavs();
    reload();
  }, [reload]);

  const hasList = !!(items && items.length);
  const filtered = !!siteFilter || !!kwDebounced; // 是否处于筛选/搜索口径

  // ———————————————— 列表主体四分支：骨架 / 离线快照 / 错误重试 / 正常态 ————————————————
  const body = (() => {
    if (loading) return <FavGrid loading={10} />;
    if (offlineMode) {
      // 离线快照：本地过滤后的首屏兜底（上限 64 条，不可翻页不可管理）
      return (
        <FavGrid
          items={snapItems}
          onPress={openVideo}
          siteNameOf={siteNameOf}
          contentContainerStyle={{ paddingBottom: 16 + chrome.bottom }}
        />
      );
    }
    if (err && !items) return <ErrorState message={err} onRetry={retryOnline} />;
    if (!hasList) {
      // 空态两档：无任何筛选 → 大空态 + CTA 回首页；筛选/搜索无结果 → 小空态
      if (!filtered) {
        return (
          <EmptyState
            icon={Star}
            title="还没有收藏"
            desc="看视频时点亮星标，就能在这里找到它"
            action={<Button onPress={() => router.navigate('/')}>去逛逛</Button>}
          />
        );
      }
      return <EmptyState icon={SearchX} title="没有匹配的收藏" desc="换个关键词或站点试试" />;
    }
    return (
      <FavGrid
        items={items}
        onPress={openVideo}
        selecting={managing}
        selected={selected}
        onToggle={toggleSelected}
        siteNameOf={siteNameOf}
        onEndReached={loadMore}
        ListFooterComponent={
          <ListFooter loading={loadingMore} error={err || ''} done={done} onRetry={loadMore} />
        }
        contentContainerStyle={{ paddingBottom: 16 + chrome.bottom }}
      />
    );
  })();

  return (
    <View style={{ flex: 1, backgroundColor: p.background }}>
      {/* 页头：返回 chip（dismissTo 弹回 (tabs) 组，board.js 同款）+ 标题与总数 +
          管理/完成（有收藏才有管理入口，mine.js 同款文字钮形态） */}
      <View
        style={{
          paddingHorizontal: padH,
          paddingTop: 12 + chrome.top,
          marginBottom: 12,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <Button variant="ghost" onPress={() => router.dismissTo('/')}>
          <ChevronLeft size={16} color={p.foreground} />
          <Text style={{ color: p.foreground, fontSize: 14, fontWeight: '500', includeFontPadding: false }}>
            首页
          </Text>
        </Button>
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 18, fontWeight: '700', color: p.foreground }}>
          我的收藏
        </Text>
        {total > 0 ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Text style={{ fontSize: 12, color: p.muted }}>共 {total} 条</Text>
            <Button
              variant={managing ? 'secondary' : 'ghost'}
              onPress={toggleManaging}
              disabled={offlineMode}
            >
              {managing ? '完成' : '管理'}
            </Button>
          </View>
        ) : null}
      </View>

      {/* 管理态操作行：删除(N)（选中数>0 才可点）+ 清空全部（mine.js 同款 accent
          文字钮）；列表在重载（骨架）或离线时不显示 */}
      {managing && hasList && !offlineMode ? (
        <View
          style={{
            paddingHorizontal: padH,
            marginBottom: 12,
            flexDirection: 'row',
            justifyContent: 'flex-end',
            gap: 4,
          }}
        >
          <Button
            variant="secondary"
            disabled={!selected.size || busy}
            onPress={onRemoveSelected}
          >
            <Trash size={16} color={p.foreground} />
            <Text style={{ fontSize: 14, fontWeight: '500', color: p.foreground }}>
              删除{selected.size ? '(' + selected.size + ')' : ''}
            </Text>
          </Button>
          <Button variant="ghost" disabled={busy} onPress={() => setClearOpen(true)}>
            <Trash size={16} color={p.accent} />
            <Text style={{ fontSize: 14, fontWeight: '500', color: p.accent }}>清空全部</Text>
          </Button>
        </View>
      ) : null}

      {/* 工具区：搜索框（防抖重载）+ 站点筛选 chips；有收藏（或首屏加载中）才展示 */}
      {total > 0 || loading ? (
        <View style={{ paddingHorizontal: padH, gap: 12, marginBottom: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Search size={16} color={p.muted} />
            <Input
              style={{ flex: 1 }}
              value={kw}
              onChangeText={setKw}
              placeholder="搜索收藏标题"
              returnKeyType="search"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          {siteChips.length > 0 ? (
            <ChipsBar
              items={chipItems}
              active={siteFilter}
              onChange={changeSite}
            />
          ) : null}
        </View>
      ) : null}

      {/* 离线快照横幅：未连上服务器时提示 + 重试（快照数据在下方网格渲染） */}
      {offlineMode ? (
        <View
          style={{
            marginHorizontal: padH,
            marginBottom: 12,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            borderRadius: 8,
            backgroundColor: p.surface2,
            paddingHorizontal: 12,
            paddingVertical: 10,
          }}
        >
          <Star size={16} color={p.muted} />
          <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 13, color: p.muted }}>
            离线快照 · 未连接服务器，正在展示本地缓存
          </Text>
          <Button variant="secondary" size="sm" onPress={retryOnline}>
            重试
          </Button>
        </View>
      ) : null}

      {/* 列表主体 */}
      <View style={{ flex: 1, minHeight: 0, paddingHorizontal: padH }}>{body}</View>

      {/* 页内轻量反馈条（toast）：底部居中，自动消失 */}
      {toastMsg ? (
        <View style={{ position: 'absolute', bottom: 24, left: 0, right: 0, alignItems: 'center', pointerEvents: 'none' }}>
          <View style={{ borderRadius: 8, backgroundColor: p.surface2, paddingHorizontal: 16, paddingVertical: 10, maxWidth: '86%' }}>
            <Text numberOfLines={2} style={{ fontSize: 14, color: p.foreground }}>{toastMsg}</Text>
          </View>
        </View>
      ) : null}

      {/* 清空全部二次确认（对齐 mine.js 清空观看历史弹层样式） */}
      <Dialog visible={clearOpen} onClose={() => setClearOpen(false)} title="清空收藏">
        <Text style={{ fontSize: 14, lineHeight: 20, color: p.muted }}>
          确定清空全部 {total > 0 ? total + ' 条' : ''}收藏？此操作不可撤销。
        </Text>
        <View style={{ marginTop: 20, flexDirection: 'row', justifyContent: 'flex-end', gap: 12 }}>
          <Button variant="secondary" onPress={() => setClearOpen(false)}>取消</Button>
          {/* 危险操作 = 品牌红实心胶囊（mine.js 清空确认同款） */}
          <Button onPress={onClear} disabled={busy} style={{ backgroundColor: p.accent }}>
            <Text style={{ fontSize: 14, fontWeight: '500', color: '#ffffff' }}>清空</Text>
          </Button>
        </View>
      </Dialog>
    </View>
  );
}
