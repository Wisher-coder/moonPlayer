// ============================================================================
// 首页 —— 公告（可关闭）+ 分类 chips 横滚条 + 榜单 chips（最新/热播/人气，
// 能力驱动）+ 无限滚动 VideoGrid；板块型站点（boards 能力，如含羞草）整页
// 切换为 BoardsHome 板块书架。
// ----------------------------------------------------------------------------
// 交互语义 1:1 移植自 NextWeb/src/components/tabs/HomeTab.jsx，RN 三端适配点：
//   · 公告/分类条/榜单条作为列表上方的常驻横带（NextWeb 的 sticky 吸顶在
//     VideoGrid 契约组件上无透传通道；常驻横带等效保持 chips 恒可见）；
//   · 无限滚动底态（正在加载…/没有更多了/失败重试）为列表下方常驻条
//     （共享 VideoGrid 未透传 ListFooterComponent 槽）；
//   · fetcher 未就绪时解析空结果而非挂起——RN 版 useInfiniteList 的在途锁
//     没有 force 通道，挂起的 Promise 会永久占锁卡死后续加载（NextWeb 版
//     有 loadTo(1,true) 强制通道不受此限）。
// 数据面：caps.home（月色聚合）时导航/公告由独立 effect 单独拉一次，与
// 榜单 tab 数据解耦（切 tab 不弄丢 chips）；「最新」tab 第 1 页复用聚合接口
// 同一条数据流。板块模式（caps.boards）fetcher 解析空结果整页让位 BoardsHome。
// 竞态防护全部内聚在 useInfiniteList（epoch 世代号 + alive + 在途去重），
// 本页只声明 fetcher 与数据维度 deps。
// ============================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Clapperboard } from '../../components/icons.js';
import { api } from '../../lib/client.js';
import { useSite } from '../../lib/site-context.jsx';
import { useOpenVideo } from '../../lib/open-video.js';
import { useForm } from '../../lib/use-form.js';
import { usePalette } from '../../components/ui/palette.js';
import { useInfiniteList, toPage } from '../../hooks/use-infinite-list.js';
import useChromeScroll, { useChromeInsets } from '../../hooks/use-chrome-scroll.js';
import VideoGrid from '../../components/video/VideoGrid.jsx';
import ChipsBar from '../../components/video/ChipsBar.jsx';
import Skeleton from '../../components/ui/Skeleton.jsx';
import BoardsHome from '../../components/home/BoardsHome.jsx';
import NoticeBar from '../../components/home/NoticeBar.jsx';
import EmptyState from '../../components/home/EmptyState.jsx';
import ErrorState from '../../components/home/ErrorState.jsx';
import ListFooter from '../../components/home/ListFooter.jsx';

// 榜单三 tab：sort 直接对应站点排序键；「人气」即 most_popular 榜
const TABS = [
  { key: 'new', label: '最新', sort: 'post_date' },
  { key: 'hot', label: '热播', sort: 'video_viewed' },
  { key: 'pop', label: '人气', sort: 'most_popular' },
];
const PAGE_SIZE = 24;
const HOT_RANK_COUNT = 10; // 热播榜前 N 名带编号角标

// 公告内容防御式提取：字符串/数字直取；对象依次取 content/title/text；取不到返回空串
function pickNotice(n) {
  if (n == null) return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n).trim();
  if (typeof n === 'object') {
    for (const k of ['content', 'title', 'text']) {
      const v = n[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return '';
}

export default function Home() {
  const router = useRouter();
  const p = usePalette();
  const { form } = useForm();
  const { site, caps, ready } = useSite();
  const [tab, setTab] = useState('new');
  const [navList, setNavList] = useState([]);   // 分类导航（聚合首页能力的站）
  const [noticeText, setNoticeText] = useState('');
  const [noticeClosed, setNoticeClosed] = useState(false);

  const padH = form === 'phone' ? 12 : 24; // 页边距：px-3 / md:px-6

  // 手机画幅壳层收放：主滚动容器方向判定挂载（经典网格 / 板块书架两路径）
  const chromeScroll = useChromeScroll(form === 'phone');
  // 手机画幅内容全出血（栏 overlay 悬浮其上）：滚动内容自垫安全间距
  const chromeInsets = useChromeInsets();

  // 聚合首屏的导航/公告：与榜单 tab 无关，仅随 site 变化重拉（切 tab 不弄丢
  // chips）；失败静默——公告/导航不挡主列表。无聚合能力的站保持空态。
  useEffect(() => {
    if (!ready || !caps.home) {
      setNavList([]);
      setNoticeText('');
      return;
    }
    let alive = true;
    api(site, 'home')
      .then((h) => {
        if (!alive) return;
        const nav = Array.isArray(h && h.nav) ? h.nav.slice() : [];
        nav.sort((a, b) => ((a && a.display_order) || 0) - ((b && b.display_order) || 0));
        setNavList(
          nav
            .filter((n) => n && (n.id ?? n.category_id) != null && n.nav_type !== 'home' && n.type !== 'home')
            .map((n) => ({ id: n.id ?? n.category_id, title: (n.title || n.name) || '分类' }))
        );
        setNoticeText(pickNotice(h && h.notice));
        setNoticeClosed(false);
      })
      .catch(() => {
        if (!alive) return;
        setNavList([]);
        setNoticeText('');
      });
    return () => { alive = false; };
  }, [site, ready, caps.home]);

  // 列表 fetcher：聚合站「最新」tab 第 1 页复用聚合接口；其余（含翻页）走普通
  // 列表；未就绪/板块模式解析空结果让位（见文件头 RN 适配点说明——绝不挂起）
  const fetcher = useCallback(
    (page) => {
      if (!ready || caps.boards) return Promise.resolve({ items: [], hasMore: false });
      if (caps.home && tab === 'new' && page === 1) {
        return api(site, 'home').then((h) => toPage(h && h.list));
      }
      const t = TABS.find((x) => x.key === tab) || TABS[0];
      return api(site, 'list', { page, size: PAGE_SIZE, sort: t.sort }).then(toPage);
    },
    [site, tab, ready, caps.home, caps.boards]
  );

  // deps = 「换一页数据」的全部维度：站点 / 榜单 tab / 上下文就绪
  const { items, loading, loadingMore, err, done, loadMore, reload } =
    useInfiniteList(fetcher, [site, tab, ready]);

  // 切 tab：状态重置由 hook deps 完成，这里只切值（重复点当前 tab 不重拉）
  const switchTab = useCallback((k) => { if (k && k !== tab) setTab(k); }, [tab]);

  // 分类 chips 条目：「推荐」复位榜单 tab（本页即首页，恒激活），其余进对应分类
  //（navigate = (tabs) 组内 JUMP_TO：分类 tab 常驻保活，参数原地替换触发重拉）
  const onCatChange = useCallback(
    (key) => {
      if (key === 'home') {
        switchTab('new');
        return;
      }
      router.navigate('/category?cat=' + encodeURIComponent(String(key)));
    },
    [switchTab, router]
  );

  // 卡片深链观看页（URL 携带站点，深链可回放）；跳转口径统一走 useOpenVideo
  //（桌面壳主窗弹独立播放窗，浏览器/原生窗口内 push）
  const goVideo = useOpenVideo();
  const openVideo = useCallback(
    (v) => {
      if (v && v.id != null) goVideo(site, v.id);
    },
    [site, goVideo]
  );

  // ———————————————— 未就绪：整页骨架 ————————————————
  if (!ready) {
    return (
      <View style={{ flex: 1, paddingHorizontal: padH, paddingTop: 12 + chromeInsets.top, gap: 16 }}>
        <Skeleton style={{ height: 44, borderRadius: 12 }} />
        <View style={{ flexDirection: 'row', gap: 12 }}>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} style={{ height: 32, width: 80, borderRadius: 8 }} />
          ))}
        </View>
        <VideoGrid loading={10} />
      </View>
    );
  }

  // ———————————————— 板块型站点：整页切换为板块书架 ————————————————
  if (caps.boards) {
    return (
      <BoardsHome
        site={site}
        onScroll={chromeScroll.onScroll}
        scrollEventThrottle={chromeScroll.scrollEventThrottle}
        topInset={chromeInsets.top}
        bottomInset={chromeInsets.bottom}
      />
    );
  }

  const hasList = !!(items && items.length);

  // 页头三行（公告 / 分类条 / 榜单条）随内容一起滚出视口、回顶滚回——
  // 手机画幅壳层收起时不再常驻画面（YouTube 同款）；挂进网格 ListHeader。
  // 槽位已有 padH 横向留白，行内不再重复；分类条通栏（含底部分隔线）
  // 负边距吃到槽外全宽。手机画幅内容全出血：首行垫 useChromeInsets 顶距
  // 防被 overlay 顶栏盖住（pad/PC 为 0，观感与旧版一致）
  const listHeader = (
    <View style={{ paddingTop: chromeInsets.top }}>
      {/* 公告条（可关闭；仅聚合首页能力的站有；无公告时不占位） */}
      {!!noticeText && !noticeClosed ? (
        <View style={{ paddingTop: 12 }}>
          <NoticeBar text={noticeText} onClose={() => setNoticeClosed(false)} />
        </View>
      ) : null}

      {/* 分类 chips 横滚条（YouTube 式通栏带）：「推荐」+ 各分类；底部分隔线 */}
      {navList.length > 0 ? (
        <View
          style={{
            marginHorizontal: -padH,
            paddingHorizontal: padH,
            paddingVertical: 10, // chip 带 56 高口径：chip 32 + 上下各 12（含 ChipsBar 自带 2）
            borderBottomWidth: 1,
            borderBottomColor: p.line,
          }}
        >
          <ChipsBar
            items={[
              { key: 'home', label: '推荐' },
              ...navList.map((n) => ({ key: n.id, label: n.title })),
            ]}
            active="home"
            onChange={onCatChange}
          />
        </View>
      ) : null}

      {/* 榜单切换（YouTube 无 Tabs 控件，用第二层 chips 代替；无排序能力的站退化
          为书架标题——20px/700/行高 28 为 YouTube 书架标题实测值） */}
      <View style={{ paddingVertical: 10 }}>
        {caps.sort ? (
          <ChipsBar
            items={TABS.map((t) => ({ key: t.key, label: t.label }))}
            active={tab}
            onChange={switchTab}
          />
        ) : (
          <Text style={{ fontSize: 20, fontWeight: '700', lineHeight: 28, color: p.foreground }}>
            最新视频
          </Text>
        )}
      </View>
    </View>
  );

  // ———————————————— 经典路径：页头（滚出）+ 无限流 + 底态（随列表尾） ————————————————
  return (
    <View style={{ flex: 1 }}>
      {/* 视频流：首屏骨架 / 失败重试 / 空态 / 网格 + 无限滚动 */}
      <View style={{ flex: 1, minHeight: 0, paddingHorizontal: padH }}>
        {loading ? (
          <View style={{ paddingTop: chromeInsets.top }}>
            <VideoGrid loading={10} />
          </View>
        ) : err && !items ? (
          <ErrorState message={err} onRetry={reload} />
        ) : !hasList ? (
          <EmptyState icon={Clapperboard} title="暂无内容" />
        ) : (
          <VideoGrid
            items={items}
            onPress={openVideo}
            onEndReached={loadMore}
            onScroll={chromeScroll.onScroll}
            scrollEventThrottle={chromeScroll.scrollEventThrottle}
            rankCount={tab === 'hot' ? HOT_RANK_COUNT : 0}
            ListHeaderComponent={listHeader}
            ListFooterComponent={
              /* 列表底态：加载更多失败（重试）/ 到底 / 加载中（见文件头说明）。
                 尾部随列表滚入；底距垫 inset 防被 overlay 底栏盖住 */
              <ListFooter
                loading={loadingMore}
                error={err || ''}
                done={done}
                onRetry={loadMore}
              />
            }
            contentContainerStyle={{ paddingBottom: 12 + chromeInsets.bottom }}
          />
        )}
      </View>
    </View>
  );
}
