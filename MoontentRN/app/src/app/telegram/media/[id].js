// ============================================================================
// telegram/media/[id].js —— Telegram 共享媒体面板(/telegram/media/<peerKey>)
// ----------------------------------------------------------------------------
// 官方 Telegram 共享媒体形态(TI SharedMediaScreen):对话的媒体/文件/链接/
// 语音四档浏览,id = 对话键 peerKey(c<频道/超群id>|g<普通群id>|u<用户id>|
// saved 我的收藏)。入口 = 聊天页(chat/[id].js)头部「头像+标题区」点按,
// 路由参数对齐聊天页惯例(id 必填;name/avatar/kind 可选,冷深链缺参时拉一次
// 对话表第一页兜底补齐——旧视频库页同款口径,失败静默退化)。
// 数据面全部走 GET /api/telegram/search {peer, q:'', filter, limit, offsetId,
// minDate?, maxDate?}(增量端点契约;四 tab 各持一份 offsetId 游标分页 feed,
// use-media-feed 承载,切 tab 不重拉、已载数据保留;tab 选择本次会话内记忆):
//   · 媒体(photoVideo):三列方格 + 月份分隔头(本地时区分组);照片点击
//     PhotoViewer 全屏查看(简版),视频点击 useOpenVideo('telegram',
//     media.video.videoId) 进观看页(现有播放链路);
//   · 文件(document)/链接(url)/语音(voice):列表行(图标+标题+元信息+
//     日期),行点击跳聊天页对应消息(router.push 带 anchor);
//   · 媒体 tab「日历」按钮 → MediaCalendar 全屏媒体日历(月份堆叠/圆形
//     缩略日格,观感对齐 TI CalendarMessageScreen):点有内容日 → 网格重锚
//     为当日媒体(minDate/maxDate 只进首页请求,后续 offsetId 翻页继续向旧
//     浏览,时间线不被窗口截断);长按日 → 「在聊天中查看」跳聊天页。
// 未登录:错误态加重「去登录」跳 /telegram,返回聚焦自动重拉。失败如实
// 呈现中文错误 + 显式重试,绝不自动重试(防风暴红线)。
// 壳层避让:手机画幅页根垫 useChromeInsets().top、列表垫 .bottom(pad/PC
// 恒 0);桌面/平板内容列 860 收束居中(聊天页同宽)。
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Calendar, ChevronLeft, Close, File, Gallery, Globe, Mic, Send } from '../../../components/icons.js';
import { api } from '../../../lib/tg-api.js';
import { one } from '../../../lib/router-params.js';
import { useOpenVideo } from '../../../lib/open-video.js';
import { useForm } from '../../../lib/use-form.js';
import { useChromeInsets } from '../../../hooks/use-chrome-scroll.js';
import { toDate } from '../../../components/telegram/chat-helpers.js';
import { TgAvatar, KindBadge } from '../../../components/telegram/index.js';
import { usePalette } from '../../../components/ui/palette.js';
import usePressVisual from '../../../lib/use-press-visual.js';
import Button from '../../../components/ui/Button.jsx';
import Skeleton from '../../../components/ui/Skeleton.jsx';
import { EmptyState, ErrorState, LoadMoreBar } from '../../../components/zones/PageStates.jsx';
import MediaTabs from '../../../components/telegram/media/MediaTabs.jsx';
import MediaGrid from '../../../components/telegram/media/MediaGrid.jsx';
import MediaListRow from '../../../components/telegram/media/MediaListRow.jsx';
import MediaCalendar from '../../../components/telegram/media/MediaCalendar.jsx';
import PhotoViewer from '../../../components/telegram/media/PhotoViewer.jsx';
import { useMediaFeed } from '../../../components/telegram/media/use-media-feed.js';

const PAGE_MAX_W = 860; // 桌面/平板内容列收束宽(聊天页 CHAT_MAX_W 同宽)

// 对话键形态(与服务端 isPeerKey 同口径;非法 id 走无效态)
const PEER_RE = /^(c\d+|g\d+|u\d+|saved)$/;

// 四档 tabs:key 即 feed 档位,filter 直连 /search 媒体过滤参数
const TABS = [
  { key: 'media', label: '媒体', filter: 'photoVideo', icon: Gallery },
  { key: 'file', label: '文件', filter: 'document', icon: File },
  { key: 'link', label: '链接', filter: 'url', icon: Globe },
  { key: 'voice', label: '语音', filter: 'voice', icon: Mic },
];

// 本次会话内记住当前 tab(模块级,页面重挂载也延续;无效值回媒体档)
let SESSION_TAB = 'media';

// tab key → 列表行 kind(MediaListRow 三档分流)
const LIST_KIND = { file: 'document', link: 'url', voice: 'voice' };

// 本地时区 'YYYY-MM'(日历 initialMonth 口径)
function monthKeyOfDate(v) {
  const d = toDate(v);
  if (!d) return '';
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
}

// 当日窗口(unix 秒,本地时区):minDate=当日 0 点,maxDate=当日末——与
// 服务端日历的本地时区分日口径一致(ensureCalendarTimezone)
function dayWindow(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  return {
    minDate: Math.floor(new Date(y, mo, d, 0, 0, 0).getTime() / 1000),
    maxDate: Math.floor(new Date(y, mo, d, 23, 59, 59).getTime() / 1000),
  };
}

// —— 列表 tab 骨架(行形态:图标方 + 两行文字条) ——
function ListSkeleton() {
  return (
    <View style={{ gap: 4 }}>
      {Array.from({ length: 8 }, (_, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 }}>
          <Skeleton style={{ width: 44, height: 44, borderRadius: 10 }} />
          <View style={{ flex: 1, gap: 8 }}>
            <Skeleton style={{ height: 14, width: '46%' }} />
            <Skeleton style={{ height: 12, width: '30%' }} />
          </View>
        </View>
      ))}
    </View>
  );
}

// —— 重锚横条右端的「退回全量」小钮 ——
function ExitDayButton({ onPress }) {
  const p = usePalette();
  const hv = usePressVisual();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="退回全部媒体"
      hitSlop={8}
      onPress={onPress}
      {...hv.binds}
      style={[{ padding: 4 }, { opacity: hv.pressed ? 0.6 : 1 }]}
    >
      <Close size={13} color={p.muted} />
    </Pressable>
  );
}

export default function TelegramMediaPage() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const rawId = one(params.id);
  const id = PEER_RE.test(rawId) ? rawId : null;
  const nameParam = one(params.name);
  const avatarParam = one(params.avatar);
  const kindParam = one(params.kind);

  const p = usePalette();
  const { form } = useForm();
  const padH = form === 'phone' ? 12 : 24; // 主区留白约定:px-3 / md:px-6
  const padB = form === 'phone' ? 16 : 48;
  // 壳层避让:手机画幅顶/底栏悬浮于内容之上,首末内容需自垫(pad/PC 恒 0)
  const chrome = useChromeInsets();

  // —— tab 态(会话内记忆)+ 日历/看图/重锚态 ——
  const [tab, setTab] = useState(() => (TABS.some((t) => t.key === SESSION_TAB) ? SESSION_TAB : 'media'));
  const [calOpen, setCalOpen] = useState(false);
  const [viewer, setViewer] = useState(null);   // {url} | null(简版看图器)
  const [dayPick, setDayPick] = useState(null); // {date,count} | null(媒体网格重锚)

  // 头部元数据:路由参数先行;冷深链缺名时拉一次对话表第一页补齐(失败静默
  // 退化,名称回退对话键文案——旧视频库页同款口径,不为群头再发更多请求)
  const [meta, setMeta] = useState({ name: nameParam, avatar: avatarParam });
  useEffect(() => {
    if (id == null || meta.name) return;
    let alive = true;
    api('telegram', 'dialogs', { page: 1, size: 50 })
      .then((d) => {
        if (!alive) return;
        const hit = (d && Array.isArray(d.items) ? d.items : []).find((x) => x && String(x.id) === String(id));
        if (hit) {
          setMeta((cur) => ({
            name: typeof hit.name === 'string' ? hit.name : cur.name,
            avatar: typeof hit.avatar === 'string' && hit.avatar ? hit.avatar : cur.avatar,
          }));
        }
      })
      .catch(() => { /* 未登录/网络失败:头部退化展示,列表错误态统一承载 */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const title = meta.name || (id === 'saved' ? '我的收藏' : '对话 ' + (id || ''));
  const avatarSrc = meta.avatar || '';
  const kind = kindParam || '';

  // —— 四档 feed(各持各的游标;active 档位惰性首拉,切走保留已载数据) ——
  // 媒体档的日期窗口只在重锚时非空(日历点日);use-media-feed 内部只把
  // 窗口塞进首页请求,后续 offsetId 翻页继续向旧浏览(时间线不截断)
  const dayWin = useMemo(() => (dayPick ? dayWindow(dayPick.date) : null), [dayPick]);
  const mediaFeed = useMediaFeed({ peer: id, filter: 'photoVideo', active: tab === 'media', dates: dayWin });
  const fileFeed = useMediaFeed({ peer: id, filter: 'document', active: tab === 'file' });
  const linkFeed = useMediaFeed({ peer: id, filter: 'url', active: tab === 'link' });
  const voiceFeed = useMediaFeed({ peer: id, filter: 'voice', active: tab === 'voice' });
  const feeds = { media: mediaFeed, file: fileFeed, link: linkFeed, voice: voiceFeed };
  const feed = feeds[tab] || mediaFeed;

  // 从登录页返回聚焦:此前因未登录失败的当前档自动重拉(登录态已在服务端就绪)
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const feedErrRef = useRef(feed.err);
  feedErrRef.current = feed.err;
  useFocusEffect(
    useCallback(() => {
      if (feedErrRef.current && feedErrRef.current.indexOf('未登录') !== -1) feedRef.current.reload();
    }, [])
  );

  // —— 返回:栈里有上一级(通常是聊天页)就 back;冷深链回 Telegram 列表页 ——
  const back = useCallback(() => {
    try {
      if (typeof router.canGoBack === 'function' && router.canGoBack()) {
        router.back();
        return;
      }
    } catch (_e) { /* 判定异常走兜底 */ }
    router.replace('/telegram');
  }, [router]);

  // 去登录:跳 Telegram 专属页完成登录(back 回本页自动重拉)
  const goLogin = useCallback(() => {
    router.push('/telegram');
  }, [router]);

  // —— tab 切换(会话内记忆) ——
  const switchTab = useCallback((k) => {
    if (!TABS.some((t) => t.key === k)) return;
    SESSION_TAB = k;
    setTab(k);
  }, []);

  // —— 视频消息 → 观看页(site 固定 'telegram',id = media.video.videoId) ——
  const goVideo = useOpenVideo();
  const openVideo = useCallback(
    (videoId) => {
      if (videoId != null && videoId !== '') goVideo('telegram', String(videoId));
    },
    [goVideo]
  );

  // —— 照片 → 简版全屏看图器(fullUrl 全档优先,缺失回中档 url) ——
  const openPhoto = useCallback((msg) => {
    const ph = msg && msg.media && msg.media.photo;
    const url = ph && (ph.fullUrl || ph.url);
    if (url) setViewer({ url });
  }, []);

  // —— 行点击/日历「在聊天中查看」→ 聊天页对应消息(带 anchor;元数据随行
  //    带齐免聊天页冷启动重复拉对话表) ——
  const openMessage = useCallback(
    (msgId) => {
      if (msgId == null || !(Number(msgId) > 0) || id == null) return;
      router.push({
        pathname: '/telegram/chat/[id]',
        params: {
          id: String(id),
          name: typeof title === 'string' ? title : '',
          avatar: avatarSrc || '',
          kind,
          anchor: String(Math.floor(Number(msgId))),
        },
      });
    },
    [router, id, title, avatarSrc, kind]
  );

  // —— 媒体日历:初始月 = 已载媒体最新一条的所属月(无则当前月);点日 →
  //    网格重锚当日(日期窗口变化 → use-media-feed 重拉首页);长按 → 跳聊天 ——
  const calInitialMonth = useMemo(() => {
    const it = mediaFeed.items && mediaFeed.items[0];
    return monthKeyOfDate(it && it.date);
  }, [mediaFeed.items]);
  const openCalendar = useCallback(() => {
    setCalOpen(true);
  }, []);
  const pickCalendarDay = useCallback((info) => {
    // info:{date,count,lastMessageId}(MediaCalendar 已校验 lastMessageId>0)
    const date = String(info.date || '');
    if (!dayWindow(date)) return; // 非法日期串:不重锚(防御,服务端契约恒 'YYYY-MM-DD')
    setDayPick({ date, count: Math.max(0, Math.floor(Number(info.count)) || 0) });
    if (SESSION_TAB !== 'media') {
      SESSION_TAB = 'media';
      setTab('media'); // 日历入口只在媒体档,此处兜底防外部态漂移
    }
  }, []);
  const exitDayPick = useCallback(() => {
    setDayPick(null); // 退出重锚:窗口清空 → feed 重拉回全量最新页
  }, []);

  // 无效对话键:无效态(全部 hooks 已调用完毕后的提前返回位)
  if (id == null) {
    return (
      <View style={{ flex: 1, backgroundColor: p.background, paddingTop: 8 + chrome.top, paddingHorizontal: padH }}>
        <ErrorState message="对话 ID 无效" />
        <View style={{ alignItems: 'center', marginTop: -48 }}>
          <Button size="sm" variant="secondary" onPress={() => router.replace('/telegram')}>回 Telegram</Button>
        </View>
      </View>
    );
  }

  // —— 主体渲染(按 tab 分流;骨架/错误/空态对齐站内模式) ——
  const activeListKind = LIST_KIND[tab] || '';
  const emptyOf = {
    media: { icon: Gallery, title: '该对话暂无媒体内容' },
    file: { icon: File, title: '暂无文件', desc: '对话里发送的文件会出现在这里' },
    link: { icon: Globe, title: '暂无链接', desc: '对话里分享过的链接会出现在这里' },
    voice: { icon: Mic, title: '暂无语音消息', desc: '对话里的语音会出现在这里' },
  }[tab] || { icon: Send, title: '暂无内容' };

  const body = (() => {
    if (feed.loading) {
      return tab === 'media' ? (
        <MediaGrid items={null} loading />
      ) : (
        <ListSkeleton />
      );
    }
    if (feed.err && feed.items == null) {
      return (
        <View style={{ flex: 1 }}>
          <ErrorState message={feed.err} onRetry={feed.reload} />
          {feed.needLogin ? (
            <View style={{ alignItems: 'center', marginTop: -48 }}>
              <Button size="sm" onPress={goLogin}>去登录</Button>
            </View>
          ) : null}
        </View>
      );
    }
    if (!feed.items || !feed.items.length) {
      return <EmptyState icon={emptyOf.icon} title={emptyOf.title} desc={emptyOf.desc} />;
    }
    if (tab === 'media') {
      return (
        <MediaGrid
          items={feed.items}
          onEndReached={feed.loadMore}
          onOpenPhoto={openPhoto}
          onOpenVideo={openVideo}
          onOpenMessage={openMessage}
          contentContainerStyle={{ paddingBottom: padB + chrome.bottom }}
        />
      );
    }
    return (
      <FlashList
        data={feed.items}
        keyExtractor={(m) => (m && m.id != null ? String(m.id) : 'x')}
        estimatedItemSize={62}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16} // FlashList v2 内部恒挂 onScroll,不传会被 RNW 逐滚动事件打提示
        onEndReached={feed.loadMore}
        onEndReachedThreshold={0.5}
        contentContainerStyle={{ paddingBottom: padB + chrome.bottom }}
        renderItem={({ item }) => (
          <MediaListRow msg={item} kind={activeListKind} onPress={openMessage} />
        )}
      />
    );
  })();

  // 日历重锚横条(只属于媒体档):当日媒体浏览中,× 退回全量
  const dayBanner = tab === 'media' && dayPick ? (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderRadius: 10,
        backgroundColor: p.surface,
        borderWidth: 1,
        borderColor: p.line,
        paddingVertical: 6,
        paddingHorizontal: 10,
      }}
    >
      <Calendar size={12} color={p.link} />
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 12, color: p.muted, includeFontPadding: false }}>
        {dayPick.date + ' 的媒体' + (feed.items && feed.items.length ? ' · ' + feed.items.length + ' 项' : '')}
      </Text>
      <ExitDayButton onPress={exitDayPick} />
    </View>
  ) : null;

  return (
    <View style={{ flex: 1, backgroundColor: p.background, paddingTop: 8 + chrome.top }}>
      <View style={{ flex: 1, maxWidth: PAGE_MAX_W, width: '100%', alignSelf: 'center', paddingHorizontal: padH }}>
        {/* 头部:返回 + 头像 + 名称/kind 徽标(聊天页头部同形态) */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Button variant="ghost" size="icon" onPress={back} accessibilityLabel="返回">
            <ChevronLeft size={22} color={p.foreground} />
          </Button>
          <TgAvatar uri={avatarSrc} name={title} size={30} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 16, fontWeight: '600', color: p.foreground }}>
              {title}
            </Text>
            <KindBadge kind={kind} />
          </View>
          <Text numberOfLines={1} style={{ fontSize: 12, color: p.muted }}>共享媒体</Text>
        </View>

        {/* 分段 tabs + 媒体档专属「日历」入口 */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <View style={{ flex: 1 }}>
            <MediaTabs tabs={TABS} active={tab} onChange={switchTab} />
          </View>
          {tab === 'media' ? (
            <Button variant="secondary" size="sm" onPress={openCalendar} accessibilityLabel="打开媒体日历">
              <Calendar size={14} color={p.foreground} />
              <Text style={{ fontSize: 12, fontWeight: '500', color: p.foreground, includeFontPadding: false }}>日历</Text>
            </Button>
          ) : null}
        </View>

        {/* 日历重锚横条 */}
        {dayBanner ? <View style={{ marginBottom: 10 }}>{dayBanner}</View> : null}

        {/* 主体 */}
        <View style={{ flex: 1, minHeight: 0 }}>{body}</View>

        {/* 加载更多态:页底浮层(网格/列表共用语义,见 LoadMoreBar 注释) */}
        {feed.items && feed.items.length ? (
          <LoadMoreBar loadingMore={feed.loadingMore} err={feed.err} onRetry={feed.loadMore} />
        ) : null}
      </View>

      {/* 简版全屏看图器(照片点击) */}
      {viewer ? <PhotoViewer url={viewer.url} onClose={() => setViewer(null)} /> : null}

      {/* 媒体日历(月份堆叠/圆形缩略日格;点日重锚网格,长按跳聊天) */}
      <MediaCalendar
        peer={id || ''}
        visible={calOpen}
        onClose={() => setCalOpen(false)}
        onPickDay={pickCalendarDay}
        onOpenChat={openMessage}
        initialMonth={calInitialMonth}
      />
    </View>
  );
}
