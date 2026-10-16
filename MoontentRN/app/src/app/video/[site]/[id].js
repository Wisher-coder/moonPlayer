// ============================================================================
// 观看页（全站最重页面）：/video/[site]/[id]
// ----------------------------------------------------------------------------
// 移植自 NextWeb/app/video/[site]/[id]/page.js（1:1 同口径），RN 三端改造：
//
// 【路由与站点】site 一律用路由参数（useLocalSearchParams，深链直达不用站点
// 上下文）；页内标签/分类 chips 的能力判定按该站元数据计算（从 useSite().sites
// 查 siteParam 的 capabilities，查不到当全 false）。id 形态按站点各异（数字系/
// mongoid 系/资源站 vid-epN 合成集），非空安全字符集即可，非法 id 走无效态。
//
// 【布局】对齐 NextWeb 断点语义（lg=1024），叠加横屏（宽>高）判定：
//   - 横屏 ≥1024（land：桌面/网页宽窗/平板横屏/播放独立窗）：腾讯视频/爱奇艺
//     客户端形态——左列纯播放器铺满整列高（视频 contain 黑边居中，控制条铺满
//     左区），右栏常驻面板（信息 + 选集 + 推荐，402px / >=1536 452px）独立滚；
//   - 横屏 <1024（landfs：手机横屏）：沉浸全屏——AppShell 同步收顶栏，播放器
//     铺满整屏，右上角「选集」圆钮唤出右缘浮层面板（信息+选集+推荐）；
//   - 竖屏 ≥1024 且非剧场（two）：双列——左列（播放器 + 信息）页面滚，右栏
//     （选集面板 + 相关推荐）独立滚（NextWeb 右栏自带 max-h + 滚动）；
//   - 剧场模式：单列通栏——播放器全宽定高（16:9 且不超视口），信息与相关
//     限宽 1280 居中（theater-store 全局态，播放器控制条「剧场」按钮切换）；
//   - 竖屏 <1024（手机/窄平板）：播放器钉顶通栏（RN 无 CSS sticky，改为页面
//     结构钉顶——m.youtube 同款体感）+ 移动端返回箭头叠层 + 正文信息在下，
//     选集面板与相关依次铺排。手机画幅 AppShell 已整条隐藏顶栏底栏，钉顶
//     播放器垫顶部安全区；窄平板顶栏在位，钉顶位自然让出。
//
// 【播放】全部经 usePlayer().open(item) 驱动（Provider 常驻，跨页迷你续播）：
// 路由参数一到即 open（取流与详情并行，换源不等详情）；详情就绪再 open 一次补
// 标题/封面元信息（Provider 同 site/id 只刷元信息不重解析）；自动播放与续播
// 跳转（getProgress 档案）均由 Provider 内部处理。详情失败/无效 id 就地 close
// 销毁会话（防「僵尸声音」）。
//
// 【资源站集数归一化】CMS 多集片的可播放单元是 vid-epN（服务端 detail 恒回裸
// vid）：裸 vid 进页（首页/搜索/分类/深链）首开先查集数档案直达人集，详情就绪
// 再把会话 id 定案成 vid-epN（canon，仲裁规则见该 effect 注释）——此后会话 id
// 全程保持 vid-epN：选集面板命中在播集（currentId 用会话 id 非路由 id）、进度
// 档案按集存取（Provider 现有管线键随会话 id，零改动）、连播队列能在剧集片单
// 里定位当前项、集号随足迹落档案（history.js 的 splitEpId/集数档案配套）。
//
// 【连播】播完（Provider 广播 'ended'）且「自动连播」设置开且有下一项 → 播放
// 器内 5 秒圆环倒计时浮层（下一项封面/标题/取消），归零或点缩略图 router.push
// 跳下一个；下一项由 play-queue.pickNext 决定（量贩 → 合集 → 相关优先级）。
// 与 NextWeb 的差异：RN 播放事件总线只有 'ended'/'close'，无 seek/play 事件，
// 「倒计时中用户回看即取消」不做抢跳取消（取消钮/切集/关会话均取消）。
//
// 【选集面板】PackagePanel 三态：详情带 packageId 出「量贩」面板（资源站 cms
// 能力多集片 tag=「剧集」，packageId→剧集片单 vid-epN）、带 gathers 逐个叠放
// 「合集」面板；同站切集平滑过渡（见下）。
//
// 【切集平滑过渡（P0）】同站换集不做整页重置——旧详情原地保留到新详情就绪再
// 原子换装（detailFresh 按 detailSite 判新，不闪整页骨架）；播放器锚点常挂，
// 路由参数一到即换源；量贩/合集面板只认 pkgId/合集 id 签名，同包同合集切集
// 不重拉不回骨架仅挪在播标记；剧场态保留（复位 effect 只看 siteParam——选集
// 连播不打断浏览形态）；跨站导航旧详情的包/合集 id 对新站无意义，按冷启动走。
//
// 【其余】相关推荐 useInfiniteList 独立加载各自可重试；换源/播放失败如实报错
// 与重试（详情错在播放器框内错误态，播放错由 Provider 的 SurfaceCard 承载），
// 不静默吞。本页不读 useSearchParams 等查询参数（expo-router 深链全在路径段）。
//
// 【看板入口】播放器控制条「看板」钮（PlayerControls）经 wall-store 的入口
// 注入通道取数（组件嵌套太深 prop 递不进去，接线说明见 wall-store.js 文件头）：
// 本页注册「当前视频加入看板候选」提供器——t/d 实时读在播实例（进度通道的
// 最新内存值，比 15s 节流的落盘档案新），duration 优先取在播实例 duration
// （NextWeb ArtPlayer 语义 1:1），没有再退回详情；加入只入墙**不自动打开**
// 看板（NextWeb 同款，反馈由按钮的 Check 图标承载）；本页是 dock 停泊位（非
// 迷你态），迷你浮层不渲染控件层 → 天然不注入（NextWeb「迷你态不注入」同款）。
// ============================================================================
import {useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, BackHandler, Platform, Pressable, ScrollView, Text, View} from 'react-native';
import useDimensions from '../../../lib/use-dimensions.js';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Svg, Circle } from 'react-native-svg';
import { Verified, ChevronLeft, Playlist, Play, Close } from '../../../components/icons.js';
import { api } from '../../../lib/client.js';
import { useSite } from '../../../lib/site-context.jsx';
import { getLastEp, recordView, splitEpId } from '../../../lib/history.js';
import { getCardAuthor } from '../../../lib/card-author.js';
import { useInfiniteList, toPage } from '../../../hooks/use-infinite-list.js';
import { PlayerDock, usePlayer, usePlayerEvent } from '../../../lib/player-context.jsx';
import { setChromeEntry } from '../../../lib/player-chrome.js';
import EpisodesOverlay from '../../../components/player/EpisodesOverlay.jsx';
import GlassSurface from '../../../components/ui/GlassSurface.jsx';
import { DIMMING } from '../../../lib/higlass.js';
import { setWallEntry } from '../../../lib/wall-store.js';
import { useTheater } from '../../../lib/theater-store.js';
import { pickNext } from '../../../lib/play-queue.js';
import { refreshFavs } from '../../../lib/fav-store.js';
import FavButton from '../../../components/fav/FavButton.jsx';
import { getSettingsSnapshot, subscribeSettings } from '../../../lib/settings.js';
import { useOpenVideo } from '../../../lib/open-video.js';
import { useMiniWindow } from '../../../lib/mini-window-store.js';
import usePressVisual from '../../../lib/use-press-visual.js';
import { IS_PLAYER_WINDOW } from '../../../lib/desktop-bridge.js';
import { useForm, DESKTOP_MIN } from '../../../lib/use-form.js';
// 稳定设备形态(与窗口宽解耦,旋转不翻转):横屏布局分档/沉浸态判定用——
// form 按当前窗口宽分档,旋转瞬间跨 768 断点会翻转(大屏手机横屏误判 pad、
// 小平板竖屏误判 phone),设备类型语义必须恒定
import { isPadDevice, isImmersiveLandscape } from '../../../lib/device-class.js';
// 沉浸态悬浮底条与屏幕底缘的留白(选集浮层 bottomPad 与控制条抬升同口径)
import { FLOAT_GAP } from '../../../components/player/PlayerControls.jsx';
import { fmtDur } from '../../../lib/utils.js';
import { usePalette } from '../../../components/ui/palette.js';
import { coverUrl, useDataSaver } from '../../../components/ui/cover.js';
import Skeleton from '../../../components/ui/Skeleton.jsx';
import Button from '../../../components/ui/Button.jsx';
import DescriptionBox from '../../../components/video/DescriptionBox.jsx';
import PackagePanel from '../../../components/video/PackagePanel.jsx';
import RelatedList, { ErrorState } from '../../../components/video/RelatedList.jsx';
import { TOPBAR_H } from '../../../lib/chrome-metrics.js';

const REL_SIZE = 12;   // 猜你喜欢每页条数
const ULTRA_MIN = 1536;   // 右栏加宽断点（对齐 NextWeb 2xl：402 → 452）
const NEXT_DELAY = 5;     // 连播倒计时秒数
const RING_R = 18;        // 倒计时圆环半径（viewBox 48）
const RING_C = 2 * Math.PI * RING_R; // 圆环周长（dasharray/dashoffset 用）

// 上传时间展示：ISO 串截 YYYY-MM-DD；秒/毫秒时间戳换算（形态不确定，防御处理）
function fmtDate(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string') return v.replace('T', ' ').slice(0, 10);
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return '';
  const d = new Date(n > 1e12 ? n : n * 1000);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

// 路由参数归一：expo-router 理论上恒字符串，数组形态防御取首个
function normParam(v) {
  if (Array.isArray(v)) return String(v[0] == null ? '' : v[0]);
  return v == null ? '' : String(v);
}

// ScrollView 触底加载（FlatList 的 onEndReached 在 ScrollView 上不存在，以
// onScroll 手工判定触底；useInfiniteList.loadMore 自带在途去重，重复触发无害）
function endReachedProps(onEnd) {
  return {
    scrollEventThrottle: 160,
    onScroll: (e) => {
      const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
      if (
        contentSize && contentSize.height > 0 &&
        layoutMeasurement.height + contentOffset.y >= contentSize.height - 140
      ) {
        if (typeof onEnd === 'function') onEnd();
      }
    },
  };
}

// 「自动连播」设置订阅（settings.js 契约）：初值同步快照，随广播跟随
//（水合完成的广播会把本机真值推上来，无需 await getSettings）
function useAutoplaySetting() {
  const [on, setOn] = useState(() => {
    try {
      return getSettingsSnapshot().autoplay !== false;
    } catch (_e) {
      return true;
    }
  });
  useEffect(() => {
    let off = null;
    try {
      off = subscribeSettings((s) => {
        const v = s && typeof s === 'object' ? s.autoplay : undefined;
        if (v != null) setOn(!!v);
        else {
          try {
            setOn(getSettingsSnapshot().autoplay !== false);
          } catch (_e) {
            /* 载荷不含该键且快照异常：保持现值 */
          }
        }
      });
    } catch (_e) {
      /* 订阅通道异常：保持快照值（开关仍是运行期可读的持久化键） */
    }
    return () => {
      if (typeof off === 'function') off();
    };
  }, []);
  return on;
}

// 频道行：有作者数据（详情 author 字段，或 avjb 的卡片随行作者）时显示真实作者
//（头像 40 + 名 + 验证勾，链到 /author/{site}/{authorId}）；无作者数据不渲染
// 任何频道占位（不为无作者站点/视频造假频道行）——产品原则无订阅按钮
function ChannelRow({ site, author }) {
  const p = usePalette();
  const router = useRouter();
  const saver = useDataSaver();
  // 布局纯静态 + 按压视觉态事件 state（安卓样式函数陷阱，见 use-press-visual 头注）
  const hv = usePressVisual();
  if (!author || author.id == null) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={'作者 ' + (author.name || '')}
      onPress={() => router.push('/author/' + site + '/' + author.id)}
      {...hv.binds}
      style={[
        { flexDirection: 'row', minWidth: 0, alignItems: 'center', gap: 12 },
        { opacity: hv.pressed ? 0.8 : 1 },
      ]}
    >
      {author.avatar ? (
        <Image
          source={{ uri: coverUrl(author.avatar, saver) }}
          style={{ width: 40, height: 40, borderRadius: 20, flexShrink: 0 }}
          contentFit="cover"
          transition={200}
        />
      ) : (
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: p.surface2, flexShrink: 0 }} />
      )}
      <View style={{ flexDirection: 'row', minWidth: 0, alignItems: 'center', gap: 4 }}>
        {/* 名字可收缩（native 陷阱：row 主轴内 Text 不给 flexShrink 时安卓溢出
            会把验证图标挤出屏而不是截断，web 则按 min-content 收缩——两端行为
            不一致，显式声明对齐） */}
        <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '500', color: p.foreground, flexShrink: 1 }}>
          {author.name}
        </Text>
        {!!author.verified && <Verified size={16} color={p.muted} />}
      </View>
    </Pressable>
  );
}

// 移动端返回箭头（m.youtube 叠在播放器上）：栈里有上一级就 back（含站外来路），
// 直达（冷启动深链/清栈）回首页。布局纯静态 + hover 视觉态事件 state（安卓
// 样式函数陷阱，见 use-press-visual 头注）
function PlayerBackBtn({ back }) {
  const [hovered, setHovered] = useState(false);
  // 沉浸态舞台 edge-to-edge（视频 letterbox 吸收刘海），按钮自读安全区避让
  // 刘海/灵动岛——left/top 各垫 insets（非沉浸舞台 insets 很小，视觉不变）
  const insets = useSafeAreaInsets();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="返回"
      onPress={back}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[
        {
          position: 'absolute',
          left: 8 + insets.left,
          top: 8 + insets.top,
          zIndex: 50,
          elevation: 50,
        },
      ]}
    >
      {/* iOS 26 玻璃端:clear 玻璃圆钮叠视频上(HIG 口径:35% 暗化层替代旧透染);
          降级端半透明黑(hover 提亮) 原样 */}
      <GlassSurface
        glassStyle="clear"
        dark
        dimming={DIMMING}
        interactive
        className="h-10 w-10 items-center justify-center rounded-full"
        fallbackStyle={{ backgroundColor: hovered ? 'rgba(0,0,0,0.8)' : 'rgba(0,0,0,0.6)' }}
      >
        <ChevronLeft size={24} color="#ffffff" />
      </GlassSurface>
    </Pressable>
  );
}

// 横屏窄幅（landfs）「选集/详情」唤出钮：右上角 40px 圆钮，与 PlayerBackBtn
// 同规格（黑底半透明白图标，YouTube 图标钮统一体）；仅面板关时渲染（面板自带
// 关闭钮，两钮并存会打架）
function LandPanelBtn({ onPress }) {
  const [hovered, setHovered] = useState(false);
  // 同 PlayerBackBtn：舞台 edge-to-edge，按钮自读安全区避让横屏刘海侧
  const insets = useSafeAreaInsets();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="选集与详情"
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[
        {
          position: 'absolute',
          right: 8 + insets.right,
          top: 8 + insets.top,
          zIndex: 50,
          elevation: 50,
        },
      ]}
    >
      {/* 同 PlayerBackBtn:玻璃端 clear 圆钮 + 35% 暗化层,降级端半透明黑(hover 提亮) */}
      <GlassSurface
        glassStyle="clear"
        dark
        dimming={DIMMING}
        interactive
        className="h-10 w-10 items-center justify-center rounded-full"
        fallbackStyle={{ backgroundColor: hovered ? 'rgba(0,0,0,0.8)' : 'rgba(0,0,0,0.6)' }}
      >
        <Playlist size={24} color="#ffffff" />
      </GlassSurface>
    </Pressable>
  );
}

// 横屏窄幅浮层面板：右缘全高（背景底 + 左边框），头部「详情 · 选集」+ 关闭钮，
// 正文整栏滚动（信息 → 选集 → 推荐）；zIndex 压过播放器控件层（PlayerControls
// zIndex 2）与返回/唤出钮（50）。safeRight 垫横屏右缘安全区（刘海侧）；
// 底部垫 insets.bottom——面板全高贴屏幕底缘，不垫会被 Home 指示条遮尾行
function LandPanel({ width: w, safeRight = 0, onClose, onEnd, children }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: w,
        zIndex: 60,
        elevation: 60,
        backgroundColor: p.background,
        borderLeftWidth: 1,
        borderLeftColor: p.line,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: 12,
          paddingRight: 4 + safeRight,
          height: 44,
          borderBottomWidth: 1,
          borderBottomColor: p.line,
        }}
      >
        <Text style={{ fontSize: 14, fontWeight: '600', color: p.foreground }}>详情 · 选集</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭面板"
          onPress={onClose}
          style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}
        >
          <Close size={20} color={p.foreground} />
        </Pressable>
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 24 + insets.bottom }}
        {...endReachedProps(onEnd)}
      >
        {children}
      </ScrollView>
    </View>
  );
}

// 自动连播倒计时浮层（NextWeb ArtPlayer 内嵌浮层的 RN 版，浮在播放器框上）：
// 下一项封面（点按即跳）/「即将播放」/标题/取消钮 + 5 秒圆环倒计时（品牌红
// 描边、中心剩余秒数）；取消留在结尾帧
function CountdownOverlay({ next, saver, onCancel, onGo }) {
  const p = usePalette();
  const src = next.cover ? coverUrl(next.cover, saver) : null;
  // 封面点按钮的视觉态（布局纯静态——安卓样式函数陷阱，见 use-press-visual 头注）
  const covHv = usePressVisual();
  return (
    <View
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.8)',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        zIndex: 30,
        elevation: 30,
      }}
    >
      <View style={{ width: '100%', maxWidth: 384, alignItems: 'center', gap: 12 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={'播放下一个:' + next.title}
          onPress={onGo}
          {...covHv.binds}
          style={[
            { width: 160, aspectRatio: 16 / 9, borderRadius: 8, overflow: 'hidden' },
            {
              backgroundColor: covHv.hovered ? p.line : p.surface2,
              opacity: covHv.pressed ? 0.85 : 1,
            },
          ]}
        >
          {src ? (
            <Image source={{ uri: src }} style={{ width: '100%', height: '100%' }} contentFit="cover" transition={200} />
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <Play size={32} color="rgba(255,255,255,0.7)" />
            </View>
          )}
        </Pressable>
        <Text style={{ fontSize: 14, color: 'rgba(255,255,255,0.7)' }}>即将播放</Text>
        <Text
          numberOfLines={1}
          style={{ width: '100%', textAlign: 'center', fontSize: 14, fontWeight: '500', color: '#fff' }}
        >
          {next.title}
        </Text>
        <View style={{ marginTop: 4, flexDirection: 'row', alignItems: 'center', gap: 20 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="取消自动连播"
            hitSlop={8}
            onPress={onCancel}
          >
            {({ hovered }) => (
              <Text style={{ paddingVertical: 4, fontSize: 14, color: hovered ? '#fff' : 'rgba(255,255,255,0.6)' }}>
                取消
              </Text>
            )}
          </Pressable>
          {/* 圆环倒计时：r=18 描边品牌红，dashoffset 随秒递减，中心为剩余秒数 */}
          <View
            style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}
            accessibilityLabel={'倒计时 ' + next.count + ' 秒'}
          >
            <Svg
              width={48}
              height={48}
              viewBox="0 0 48 48"
              style={{ position: 'absolute', top: 0, left: 0, transform: [{ rotate: '-90deg' }] }}
            >
              <Circle
                cx={24}
                cy={24}
                r={RING_R}
                fill="none"
                stroke="#ff0000"
                strokeWidth={3}
                strokeDasharray={RING_C}
                strokeDashoffset={RING_C * (1 - next.count / NEXT_DELAY)}
              />
            </Svg>
            <Text style={{ fontSize: 14, fontWeight: '600', color: '#fff' }}>{next.count}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

// 观看页挂载计数（模块级）：push 链中被压住的上一观看页保活挂载，计数 ≥2
// 即「本页之下还压着视频页」——back() 据此直接 pop 舞台不动（三端确定，
// 不依赖导航 state 形态）；栈底观看页计数=1，走缩小成悬浮窗的编排返回。
// 务必成对 ++/--（卸载 cleanup），计数漂移会让 back() 误判。
const mountedVideoPagesRef = { current: 0 };

export default function VideoPage() {
  const router = useRouter();
  // 视频跳转统一口径（lib/open-video.js）：桌面播放独立窗内 = 窗口内 push
  // （选集/自动连播/相关推荐都留在本窗），浏览器/原生 = 普通路由 push。
  // video→video 换片压栈保活，返回逐级 pop 回上一观看页（舞台原地换源不动）
  const goVideo = useOpenVideo();
  // 挂载计数登记（见模块级 mountedVideoPagesRef 注释）
  useEffect(() => {
    mountedVideoPagesRef.current += 1;
    return () => {
      mountedVideoPagesRef.current -= 1;
    };
  }, []);
  const params = useLocalSearchParams();
  const siteParam = normParam(params.site);
  const rawId = normParam(params.id);
  // id 形态按站点各异（数字系/mongoid 系/资源站 vid-epN）：非空安全字符集即可
  const id = /^[0-9A-Za-z_-]{1,64}$/.test(rawId || '') ? rawId : null; // 非法 id 走无效态

  // 路由站点的能力：标签 chips 有 bytag 能力才链到分类页 tag 过滤，否则退到搜索
  const { sites } = useSite();
  const siteMeta = sites.find((s) => s.id === siteParam);
  const siteCaps = (siteMeta && siteMeta.capabilities) || {};

  const { width, form } = useForm();
  const { height: vh } = useDimensions();
  const insets = useSafeAreaInsets();
  const p = usePalette();
  const saver = useDataSaver();

  const [detail, setDetail] = useState(null);
  const [detailSite, setDetailSite] = useState(''); // detail 归属站点（切集保旧详情，跨站判新的唯一依据）
  const [err, setErr] = useState('');
  const [errKey, setErrKey] = useState(''); // 错误归属 'site|id'（stale 错误不误关新会话）
  const [retryKey, setRetryKey] = useState(0); // 详情重试
  // 横屏窄幅（landfs）「选集/详情」浮层面板开合：回竖屏/换布局即随分支卸载，
  // 切集不收（面板开着连选顺手）；跨站换片收掉（旧站的选集对新站无意义）
  const [panelOpen, setPanelOpen] = useState(false);
  // 桌面控制条「选集」浮层开合（压在播放器之上的序号格面板，腾讯视频同款）：
  // 跨站换片收掉（旧站选集对新站无意义），同站切集保留（连选顺手）
  const [epOpen, setEpOpen] = useState(false);

  // detail 是否属于当前站点：同站切集过渡期旧详情继续顶班（平滑换装，UI 不清空）；
  // 跨站导航一律视为无数据——旧站的 packageId/gathers/标题对新站毫无意义，
  // 据此拉数必错，须回冷启动骨架。render 期判新，不依赖 effect 执行顺序
  const detailFresh = !!detail && detailSite === siteParam;
  // 错误是否属于当前路由参数：同站换集时上一集的失败文案不拦新会话
  const errHere = !!err && id != null && errKey === siteParam + '|' + id;
  // Telegram 未登录(仅 caps.tg 站点):详情错误消息含「未登录」(服务端
  // TgNotLoggedInError 的中文口径)时,错误态之上加「去登录」动作跳专属页
  const tgNeedLogin = !!siteCaps.tg && errHere && err.indexOf('未登录') !== -1;

  // 卡片作者随行：上游详情不带 author（avjb 作者仅存在于列表卡片）时，频道行读
  // 进页前卡片留下的真实作者（键含站点+视频 id，不会串；深链直达无数据则不显示）
  const [cardAuthor, setCardAuthor] = useState(null);
  useEffect(() => {
    let alive = true;
    getCardAuthor(siteParam, id)
      .then((a) => {
        if (alive) setCardAuthor(a);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [siteParam, id]);

  // 收藏清单静默同步（fav-store 契约：失败不清现有态、绝不抛错）：挂载拉一次
  // 服务端真值对齐星标（本地快照水合先行，无「先灭后亮」闪变）；此后星标翻转
  // 由 toggleFav 的乐观更新/校准实时驱动，无需再刷
  useEffect(() => {
    refreshFavs();
  }, []);

  // 剧场模式（全局 store，播放器控制条「剧场」按钮经 toggle 切换）：不进 URL，
  // 进页/跨站重置为默认态；同站切集保留（deps 只看 siteParam——切集连播不打断
  // 浏览形态，跨站/重新进页照旧复位）
  const { theater, set: setTheater } = useTheater();
  // 小窗播放态（桌面壳专属，站方播放器右下「小窗」钮切换；见 mini-window-store）：
  // 小窗里只留视频——右侧面板收起（窗小、面板挤不下），外壳补顶部片名
  const miniWin = useMiniWindow();
  useEffect(() => {
    setTheater(false);
  }, [siteParam, setTheater]);

  // landfs 浮层面板：跨站换片收掉（旧站选集对新站无意义；同站切集保留）
  useEffect(() => {
    setPanelOpen(false);
    setEpOpen(false);
  }, [siteParam]);

  const { open, close, videoProps, current: playerSession } = usePlayer();
  // 舞台编排面:uiPhase 驱动本页内容淡入淡出;beginShrinkThenBack 编排返回;
  // reportDockScroll/endDockScroll 把主滚动器的滚动差喂给舞台(播放器随页滚)
  const { uiPhase, beginShrinkThenBack, setDockOverlay, clearDockOverlay, reportDockScroll, endDockScroll, playerFs, webFs } = usePlayer();
  // playerSession/videoProps:看板入口候选提供器要读在播实例的进度/时长
  //(videoProps.instanceRef.current 暴露 currentTime/duration,web=常驻 video
  // 元素包装、native=Provider 共享 expo-video 实例包装,两端同契约)

  // 会话镜像（render 期刷新，不入任何 effect deps）：归一化要读「当前在播会话
  // id」判定是否已定案，而 playerSession 对象每次 open 都换新引用——直接入
  // deps 会与 open→新 session→effect 重跑形成死循环，一律经 ref 快照读取
  const sessionRef = useRef(null);
  sessionRef.current = playerSession;
  // 本页最后写进全局会话的片（site + id + 元信息快照）：video→video push 后
  // 返回聚焦时，靠它判定「全局会话是否已被更上层视频页换片」（会话归属守卫）
  const ownOpenRef = useRef(null);
  // 在播会话 id（选集面板高亮/连播队列「当前项」的唯一依据）：跟随 Provider
  // 会话——资源站为归一后的 vid-epN，与剧集片单条目同形态可命中；他站即
  // detail.id，与量贩/合集条目精确匹配。会话未建立/跨站过渡期退路由 id
  const currentPlayId =
    playerSession && playerSession.site === siteParam ? String(playerSession.id) : String(id);

  // 详情加载：id/site 变化重拉；同站切集【不清旧详情】——旧内容原地保留，新
  // 详情就绪原子换装（不闪整页骨架）；跨站由 detailFresh 在 render 期自动判新。
  // alive 防卸载后 setState；错误记归属键（errKey），stale 错误不拦新会话
  useEffect(() => {
    if (id == null) return;
    let alive = true;
    setErr('');
    setErrKey('');
    (async () => {
      try {
        const d = await api(siteParam, 'detail', { id });
        if (!alive) return;
        if (!d || d.id == null) throw new Error('详情数据形态异常');
        setDetail(d);
        setDetailSite(siteParam);
      } catch (e) {
        if (!alive) return;
        setErr((e && e.message) || '详情加载失败');
        setErrKey(siteParam + '|' + id);
      }
    })();
    return () => {
      alive = false;
    };
  }, [siteParam, id, retryKey]);

  // 会话写入（契约 open）：路由参数一到即换源——取流只认 site/id，与详情并行，
  // 不等详情；标题/封面先空着（Provider 解析期间 SurfaceCard 顶班）。
  // 资源站（cms 能力）裸 vid 且集数档案有记录 → 先读档案（AsyncStorage 毫秒级）
  // 直接以 vid-epN 起播：回看用户进页即达最后播放集，免「先闪第 1 集再跳」；
  // 无档案/能力未知（冷深链站点清单未到时 cms=false）按裸 vid 开，由详情就绪
  // 的归一化兜底收敛。siteCaps.cms 入 deps：清单到位能力翻真后自动补跑归一
  useEffect(() => {
    if (id == null) return;
    let alive = true;
    (async () => {
      let openId = id;
      if (siteCaps.cms && !splitEpId(id)) {
        try {
          const rec = await getLastEp(siteParam, id);
          if (alive && rec && rec.ep > 0) openId = id + '-ep' + rec.ep;
        } catch (_e) {
          /* 档案读取失败：按裸 vid 走，详情归一化兜底 */
        }
      }
      if (!alive) return;
      ownOpenRef.current = { site: siteParam, id: openId, meta: null };
      open({ site: siteParam, id: openId, title: '', cover: '' });
    })();
    return () => {
      alive = false;
    };
  }, [siteParam, id, open, siteCaps.cms]);

  // 详情就绪：定案播放会话 id（canon）+ 补会话元信息 + 观看足迹。
  // canon 仲裁（资源站集数归一化的定案点，选集命中/按集进度/连播定位全靠它）：
  //   ① 路由 id 带 -epN → 路由 id（选集面板点集/历史直达进来；与首开同 id，
  //      Provider 同片只刷元信息不重解析——修复「详情二次 open 用 detail.id
  //      （服务端恒回裸 vid）把播放弹回第 1 集」）；
  //   ② 在播会话已归一为同片 vid-epN（首开档案先行已定案）→ 沿用会话 id；
  //   ③ cms 多集片（packageId 在）裸 vid 进 → 读集数档案定 vid-ep{lastEp||1}
  //      （首次观看收敛 ep1，与首开裸 vid 不同 id 会重解析一次同 URL——一次性
  //      成本换按集存档与选集命中，此后档案在位不再发生）；
  //   ④ 其余（单集片/他站）→ detail.id（原行为）。
  // recordView 一并带 canon：history 内部拆 -epN 按片归档并落集数档案（纯本地
  // 去重幂等，与 Provider 解析成功顺手记的那条不冲突——两边都归一到同片+集）。
  // 跨站过渡期旧详情不算数，须 detailFresh 才落笔（否则旧片会记到新站名下）
  useEffect(() => {
    if (!detail || !detailFresh) return;
    let alive = true;
    (async () => {
      let canon = detail.id;
      const routeEp = splitEpId(id);
      if (routeEp) {
        canon = routeEp.vid + '-ep' + routeEp.ep;
      } else {
        const cur =
          sessionRef.current && sessionRef.current.site === siteParam ? splitEpId(sessionRef.current.id) : null;
        if (cur && cur.vid === String(detail.id)) {
          canon = String(sessionRef.current.id);
        } else if (siteCaps.cms && detail.packageId != null) {
          try {
            const rec = await getLastEp(siteParam, detail.id);
            if (alive) canon = String(detail.id) + '-ep' + (rec && rec.ep > 0 ? rec.ep : 1);
          } catch (_e) {
            /* 档案读取失败：退 detail.id，集数记忆本次缺席 */
          }
        }
      }
      if (!alive) return;
      ownOpenRef.current = {
        site: siteParam,
        id: canon,
        meta: {
          title: detail.title || '',
          cover: detail.cover || '',
          duration: detail.duration ?? null,
          hd: !!detail.hd,
        },
      };
      open({
        site: siteParam,
        id: canon,
        title: detail.title || '',
        cover: detail.cover || '',
        duration: detail.duration ?? null,
        hd: !!detail.hd,
      });
      recordView(siteParam, {
        id: canon,
        title: detail.title || '',
        cover: detail.cover || '',
        duration: detail.duration ?? null,
        hd: !!detail.hd,
      });
    })();
    return () => {
      alive = false;
    };
  }, [detail, detailFresh, siteParam, id, open, siteCaps.cms]);

  // 详情失败/无效 id：本页没有 Dock 会话可言，若还有活跃会话（别页迷你卡带来的）
  // 会变成隐藏播放的「僵尸声音」——就地销毁（close → 内核停播并自动存进度）
  useEffect(() => {
    if (id == null || errHere) close();
  }, [id, errHere, close]);

  // 会话归属守卫（video→video push 后返回）：全局播放会话是单例，本页被更上层
  // 视频页（相关推荐/自动连播 push 出去的新观看页实例）压住期间，会话已被那页
  // 换片——返回聚焦时若会话不再属于本页最后打开的片（ownOpenRef 快照比对），
  // 重开本页会话接管播放：续播位置由 Provider 内部按进度档案处理；有定案 canon
  // 元信息时直开（Provider 同片 open 只补元信息不重解析），否则按路由首开 id
  // 开、详情就绪后 canon effect 照常定案。挂载首聚时 ownOpenRef 尚未落笔（首开
  // effect 异步在途），守卫空过，会话由首开 effect 建立。会话已遭销毁（上层页
  // 详情失败就地 close/迷你窗被手动关闭）同样重开接管——直接放行的话舞台整个
  // 卸载，本页只剩黑框。
  useFocusEffect(
    useCallback(() => {
      // 焦点恢复先重测锚点:本页曾被更上层视频页压住,舞台 rect/滚动差停留在
      // 那页状态(或本页滚动位已变)——nudge 触发 PlayerDock 重测归位
      endDockScroll();
      const own = ownOpenRef.current;
      if (!own) return;
      const s = sessionRef.current;
      if (s && s.site === own.site && String(s.id) === String(own.id)) return;
      open(own.meta
        ? { site: own.site, id: own.id, ...own.meta }
        : { site: own.site, id: own.id, title: '', cover: '' });
    }, [open, endDockScroll]),
  );

  // ===== 看板入口注入：向 wall-store 注册「当前视频加入看板候选」提供器 =====
  // PlayerControls 的「看板」钮经注入通道调它（接线背景见文件头【看板入口】）。
  // 组账语义对齐 NextWeb ArtPlayer 的 addToWallCurrent：t/d 点击瞬间实时读
  // 在播实例（instanceRef 句柄，进度通道的最新内存值）；duration 优先取在播
  // 实例的 duration（最准），没有再退回详情/会话的 duration；hd 恒 false
  // （NextWeb 同款）。加入只入墙不自动开看板；提供器随路由参数/详情/句柄变化
  // 重注册（闭包永远读得到最新值），卸载/无效 id 注销（迷你浮层不渲染控件层，
  // 离开观看页即无入口——「迷你态不注入」的 RN 等价实现）。
  useEffect(() => {
    if (id == null) {
      setWallEntry(null);
      return;
    }
    const provide = () => {
      const inst = videoProps && videoProps.instanceRef ? videoProps.instanceRef.current : null;
      let t = 0;
      let liveD = 0;
      try {
        if (inst) {
          t = inst.currentTime || 0;
          const dv = inst.duration;
          if (isFinite(dv) && dv > 0) liveD = dv;
        }
      } catch (_e) {
        /* 实例不在/已销毁:进度退 0,duration 退详情 */
      }
      const fresh = detailFresh ? detail : null;
      const title = (fresh && fresh.title) || (playerSession && playerSession.title) || '';
      const cover = (fresh && fresh.cover) || (playerSession && playerSession.cover) || '';
      let fallbackDur = null;
      if (fresh && fresh.duration != null) fallbackDur = fresh.duration;
      else if (playerSession && playerSession.duration != null) fallbackDur = playerSession.duration;
      return {
        site: siteParam,
        id,
        title,
        cover,
        duration: liveD > 0 ? liveD : fallbackDur,
        hd: false,
        t: Math.floor(t),
        d: Math.floor(liveD),
      };
    };
    setWallEntry(provide);
    return () => {
      // 依赖变化时:先注销再由新 effect 立即重注册(同一提交内完成,无空窗);
      // 卸载时:唯一注册方离开,清干净
      setWallEntry(null);
    };
  }, [siteParam, id, detail, detailFresh, videoProps, playerSession]);

  // 猜你喜欢：独立于详情加载，deps 只看路由参数；无效 id 挂起（不出错态，
  // 页面由无效态统一承载）
  const relFetcher = useCallback(
    (page) => {
      if (id == null) return new Promise(() => {});
      return api(siteParam, 'related', { id, page, size: REL_SIZE }).then(toPage);
    },
    [siteParam, id]
  );
  const rel = useInfiniteList(relFetcher, [siteParam, id]);

  // 选集面板取数（含羞草量贩包 / 资源站剧集片单）：详情带 packageId（本片在
  // 量贩包内/多集片）才拉整包片单，独立于相关推荐加载；失败只出面板内错误态，
  // 不打断页面其余部分。同包视频间切集时旧详情顶班 → pkgId 全程不变，effect 不
  // 重跑：面板不卸载、不回骨架、连请求都不发，仅 currentId 挪在播标记；跨站/
  // 换包（pkgId 变化）才整组重置重拉
  const [pkg, setPkg] = useState(null);
  const [pkgLoading, setPkgLoading] = useState(false);
  const [pkgErr, setPkgErr] = useState('');
  const [pkgRetry, setPkgRetry] = useState(0);
  const pkgId = detailFresh && detail.packageId != null ? detail.packageId : null;
  // 面板区种标记：资源站（cms 能力）多集片为「剧集」，其余站缺省「量贩」
  const pkgTag = siteCaps.cms ? '剧集' : '量贩';
  useEffect(() => {
    if (pkgId == null) {
      setPkg(null);
      setPkgErr('');
      setPkgLoading(false);
      return;
    }
    let alive = true;
    setPkgLoading(true);
    setPkgErr('');
    setPkg(null);
    api(siteParam, 'package', { id: pkgId })
      .then((pd) => {
        if (!alive) return;
        setPkg(pd);
        setPkgLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setPkgErr((e && e.message) || pkgTag + '列表加载失败');
        setPkgLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [siteParam, pkgId, pkgRetry]);

  // 源集数缩水兜底：剧集片单就绪后若在播集号超出实际集数（上游删集/换源），
  // 会话 id 的 -epN 命不中任何条目——面板高亮与连播定位再次落空。收敛到末集
  // 重开（服务端 resolvePlay 对越界集号本就钳制到末集，此处把会话 id 也对齐，
  // 面板即可命中；重开后 recordView 会把集数档案一并修正）。仅会话 id 带
  // -epN 时可能触发（他站/单集片天然不进）；sessionRef 读取不入 deps——
  // open 后 session 换新对象，入 deps 会在每次会话变化时反复重跑本仲裁
  useEffect(() => {
    if (!pkg || !Array.isArray(pkg.items) || !pkg.items.length) return;
    const s = sessionRef.current;
    const se = s && s.site === siteParam ? splitEpId(s.id) : null;
    if (se && String(se.vid) === String(pkg.id) && se.ep > pkg.items.length) {
      open({
        site: siteParam,
        id: se.vid + '-ep' + pkg.items.length,
        title: s.title || '',
        cover: s.cover || '',
        duration: s.duration ?? null,
        hd: !!s.hd,
      });
    }
  }, [pkg, siteParam, open]);

  // 合集选集（仅含羞草，与量贩面板同形态）：详情带 gathers（本片所在合集，
  // 0..n 个）逐个拉整包片单，右栏在量贩面板之下依次叠放——站方播放页「合集
  // (1/N)」选集队列的等价物。单个失败只出该面板内错误态。重拉只认「合集 id
  // 签名」：同站切集 detail 换了对象但签名不变 → effect 不重跑，面板原地保住、
  // 只挪在播标记；换合集/跨站（detailFresh 置 false → 签名清空）才整组重置重拉
  const [gathers, setGathers] = useState([]); // [{ id, name, data, loading, err }]
  const [gatherRetry, setGatherRetry] = useState(0);
  const gatherList = detailFresh && Array.isArray(detail.gathers) ? detail.gathers : [];
  const gatherSig = gatherList.map((g) => (g && g.id != null ? String(g.id) : '')).join(',');
  useEffect(() => {
    if (!gatherSig) {
      setGathers([]);
      return;
    }
    const list = gatherList; // 闭包冻结本签名对应的名单（effect 只在签名变化时跑）
    let alive = true;
    setGathers(list.map((g) => ({ id: String(g.id), name: g.name || '', data: null, loading: true, err: '' })));
    list.forEach((g) => {
      api(siteParam, 'gather', { id: g.id })
        .then((pd) => {
          if (!alive) return;
          setGathers((prev) => prev.map((x) => (x.id === String(g.id) ? { ...x, data: pd, loading: false } : x)));
        })
        .catch((e) => {
          if (!alive) return;
          setGathers((prev) =>
            prev.map((x) => (x.id === String(g.id) ? { ...x, err: (e && e.message) || '合集选集加载失败', loading: false } : x))
          );
        });
    });
    return () => {
      alive = false;
    };
  }, [siteParam, gatherSig, gatherRetry]);

  // ===== 自动连播：nextUp 组装（play-queue 纯函数仲裁）=====
  // 优先量贩包内下一部 → 首个就绪合集的下一部 → 相关推荐第一个；皆空传 null。
  // 「当前项」用在播会话 id（资源站为 vid-epN）——剧集片单条目即 vid-epN 形态，
  // 用 detail.id（裸 vid）找位置必落空，剧集连播曾因此永远退到相关推荐第一个
  const nextFrom = pickNext(detailFresh ? { ...detail, id: currentPlayId } : null, {
    package: pkg,
    gathers: gathers,
    related: rel.items || [],
  });
  const nextUp =
    nextFrom && nextFrom.id != null
      ? { id: String(nextFrom.id), title: nextFrom.title || '(无标题)', cover: nextFrom.cover || '' }
      : null;
  const nextUpRef = useRef(null);
  nextUpRef.current = nextUp;

  // ===== 播放器 chrome 注入（player-chrome）：控制条钮的供数口 =====
  // 底部控制条（PlayerControls，嵌在舞台→播放内核内层）拿不到本页的数据与动作，
  // 经该通道供数（接线背景见 lib/player-chrome.js 文件头）：下一集（连播选队结果，
  // 与播完 5 秒倒计时同一口径，独立于「自动连播」开关）/ 选集（浮层开合）/
  // 供数走「渲染期刷新快照 + 键变化才重注册」：nextUp/epPack 每次渲染都是新
  // 对象，直接进 deps 会导致每次渲染重注册（消费方无谓重渲染），故按语义键判变
  const epPack = useMemo(() => {
    const items = pkg && Array.isArray(pkg.items) && pkg.items.length ? pkg.items : null;
    if (items) return { title: pkg.title || '', items };
    const g = gathers.find((x) => x && x.data && Array.isArray(x.data.items) && x.data.items.length);
    return g ? { title: g.data.title || g.name || '', items: g.data.items } : null;
  }, [pkg, gathers]);
  const chromeRef = useRef(null);
  chromeRef.current = {
    title: detailFresh && detail && detail.title ? String(detail.title) : (playerSession && playerSession.title) || '',
    // 右侧面板宽（外壳浮钮锚点）：land 画幅才有面板（横屏宽幅且非剧场；
    // 402 / ≥1536 为 452，与下方布局段 asideW 同口径）；小窗态收面板 → 0
    sideW: miniWin
      ? 0
      : width >= DESKTOP_MIN && vh > 0 && width > vh && !theater
        ? (width >= ULTRA_MIN ? 452 : 402)
        : 0,
    next:
      nextUp && nextUp.id != null
        ? {
            title: nextUp.title,
            go: () => goVideo(siteParam, nextUp.id),
          }
        : null,
    episodes: epPack
      ? {
          count: epPack.items.length,
          open: epOpen,
          toggle: () => setEpOpen((v) => !v),
        }
      : null,
    // 小窗播放（控制条钮）：舞台缩小成应用内悬浮小窗 + 退出整条观看链落回
    // 链底来路页（首页/我的/专辑等）——不能落在上一观看页：isWatch 恒 true
    // 会让路由相位 effect 把舞台 expanding 拉回观看位，小窗钮失效。动作定义
    // 在下方 back() 旁，go 惰性引用避开 TDZ。桌面壳不消费本字段（钮位分流
    // 先走 winControls.toggleMini 的窗口小窗形态）
    mini: { go: () => beginShrinkThenBack(exitWatchChain) },
  };
  const chromeKey = [
    chromeRef.current.title,
    String(chromeRef.current.sideW),
    nextUp ? String(nextUp.id) : '',
    epPack ? String(epPack.items.length) + '|' + epPack.title : '',
    epOpen ? '1' : '0',
    playerSession ? '1' : '0',
  ].join('~');
  useEffect(() => {
    setChromeEntry(() => chromeRef.current);
    return () => setChromeEntry(null);
  }, [chromeKey]);

  // 选集浮层（控制条「选集」钮唤出）：压在播放器上的序号格面板，点选即窗内切集
  //（useOpenVideo 口径——桌面播放窗内不派生新窗）。经 dock 覆盖槽注册进舞台渲染
  //（留在页面内会被舞台 zIndex 压住）。bottomPad 镜像控件层沉浸悬浮底条的抬升
  // （全屏或手机横屏 landfs）：底条悬浮于安全区之上（insets.bottom + FLOAT_GAP），
  // 浮层同步上移，保持让位
  const epBottomPad =
    playerFs || isImmersiveLandscape(width, vh) ? insets.bottom + FLOAT_GAP : 0;
  const episodesNode = useMemo(
    () =>
      epOpen && epPack ? (
        <EpisodesOverlay
          title={epPack.title}
          items={epPack.items}
          currentId={currentPlayId}
          bottomPad={epBottomPad}
          onPick={(v) => {
            setEpOpen(false);
            if (v && v.id != null) goVideo(siteParam, v.id);
          }}
          onClose={() => setEpOpen(false)}
        />
      ) : null,
    [epOpen, epPack, currentPlayId, epBottomPad, goVideo, siteParam]
  );
  useEffect(() => {
    setDockOverlay('episodes', episodesNode);
    return () => setDockOverlay('episodes', null);
  }, [episodesNode, setDockOverlay]);

  const autoplayOn = useAutoplaySetting();
  const [cd, setCd] = useState(null); // 倒计时态：{ id, title, cover, count } | null
  const cdRef = useRef(null);
  cdRef.current = cd;

  // 播完起步（Provider 广播 'ended'）：设置关或无下一项不出倒计时（NextWeb 同款）
  usePlayerEvent('ended', () => {
    if (!autoplayOn) return;
    const nx = nextUpRef.current;
    if (nx && nx.id != null) setCd({ ...nx, count: NEXT_DELAY });
  });
  // 会话销毁清倒计时
  usePlayerEvent('close', () => setCd(null));
  // 切集/跨站清倒计时（新片起播即无倒计时语义）
  useEffect(() => {
    setCd(null);
  }, [siteParam, id]);

  // web 端窗口标题联动片名（Electron 播放独立窗的任务栏/窗口标题；浏览器
  // 标签页同步受益）；跨站过渡期旧详情不顶标题（detailFresh 判新，同呈现口径）
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const t = detailFresh && detail && detail.title ? String(detail.title) : '';
    document.title = t ? t + ' · 月幕' : '月幕 · 视频播放';
  }, [detail, detailFresh]);

  // 倒计时步进：每秒 -1，归零跳下一个（与 NextWeb 同 push 语义，保留返回栈）；
  // setTimeout 链随 cd 变化重建，卸载/取消即停
  useEffect(() => {
    if (!cd) return;
    const t = setTimeout(() => {
      if (cd.count > 1) {
        setCd({ ...cd, count: cd.count - 1 });
      } else {
        setCd(null);
        goVideo(siteParam, cd.id);
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [cd, goVideo, siteParam]);

  const cancelCd = useCallback(() => setCd(null), []);
  const goNext = useCallback(() => {
    const nx = cdRef.current;
    setCd(null);
    if (nx && nx.id != null) goVideo(siteParam, nx.id);
  }, [goVideo, siteParam]);

  // ===== 页面内容随舞台相位淡入淡出(YouTube 手感) =====
  // 展开期(expanding/mini 进页)内容隐去,舞台放大落定后淡入;编排返回
  // (shrinking)先淡出再让舞台缩小——整段过渡只有播放器在动,没有整页切换感。
  // 新会话直开(entering)内容随后浮现(播放器在观看位淡入,内容晚一点跟上)。
  const pageFadeRef = useRef(null);
  if (pageFadeRef.current == null) {
    pageFadeRef.current = new Animated.Value(
      uiPhase === 'mini' || uiPhase === 'expanding' ? 0 : 1
    );
  }
  const pageFade = pageFadeRef.current;
  useEffect(() => {
    if (uiPhase === 'mini' || uiPhase === 'expanding') {
      pageFade.setValue(0);
    } else if (uiPhase === 'shrinking') {
      Animated.timing(pageFade, { toValue: 0, duration: 130, useNativeDriver: Platform.OS !== 'web' }).start();
    } else if (uiPhase === 'docked') {
      Animated.timing(pageFade, { toValue: 1, duration: 240, delay: 80, useNativeDriver: Platform.OS !== 'web' }).start();
    } else if (uiPhase === 'entering') {
      Animated.timing(pageFade, { toValue: 1, duration: 240, delay: 140, useNativeDriver: Platform.OS !== 'web' }).start();
    }
  }, [uiPhase, pageFade]);

  // 移动端返回箭头（m.youtube 叠在播放器上）：编排返回——内容淡出+舞台缩小成
  // 悬浮窗完成后再真正导航（全程无整页切换动画）。舞台未停泊(解析中/进场中)
  // 时 beginShrinkThenBack 内部直接放行返回。「退出时悬浮播放」关闭
  // (settings.miniOnExit)时不走缩小编排,直接 pop,由 Provider 路由相位
  // effect 兜底 close() 停止播放。
  // 例外：video→video 返回（相关推荐/自动连播/选集 push 出去的上一观看页还
  // 压在栈里保活）不走缩小编排——与 push 方向「docked 同栈换片原地换源不动」
  // （Provider 路由相位 effect 的既定口径）对称，直接 pop 舞台不动；否则演出
  // 「缩到右下角 → pop → 会话换片又从角落 expanding 飞回」的错误下滑。判定用
  // 模块级挂载计数（mountedVideoPagesRef ≥2 = 本页之下还压着观看页）：三端
  // 确定，不依赖导航 state 形态。
  // 弹层一律 router.back() 回来路页（首页/我的 tab/上一观看页——(tabs) 组保活
  // tab 不丢；不用 dismissTo，其 POP_TO 在 web 叠整页「左拉」动画且一刀切回
  // 首页 tab）；冷启动深链直达（视频页即栈底、无下垫）走 replace('/')。
  const back = useCallback(() => {
    const pop = () => {
      try {
        if (typeof router.canGoBack === 'function' && router.canGoBack()) {
          router.back();
          return;
        }
      } catch (_e) {
        /* 判定异常走兜底 */
      }
      router.replace('/');
    };
    if (mountedVideoPagesRef.current >= 2) {
      pop();
      return;
    }
    // 退出时悬浮播放关闭:直接返回(无缩小动画),Provider 路由相位 effect
    // 兜底 close()——暂停+落进度+清会话,不出悬浮小窗
    if (getSettingsSnapshot().miniOnExit === false) {
      pop();
      return;
    }
    beginShrinkThenBack(pop);
  }, [router, beginShrinkThenBack]);

  // 小窗播放钮的退出动作：弹出整条观看链（已挂载观看页数 = 栈中观看屏数），
  // 落到链底来路页（非观看页）——悬浮小窗才能留在那儿（落在观看页会被路由
  // 相位 effect expanding 拉回观看位）。dismiss 一次性弹 n 层；判定/派发
  // 异常兜底 replace('/')。
  const exitWatchChain = useCallback(() => {
    try {
      const n = mountedVideoPagesRef.current;
      if (n > 0 && typeof router.canGoBack === 'function' && router.canGoBack()) {
        router.dismiss(n);
        return;
      }
    } catch (_e) {
      /* 派发异常走兜底 */
    }
    router.replace('/');
  }, [router]);

  // Android 硬返回:同一编排(不落系统默认整页 pop 动画)
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      back();
      return true;
    });
    return () => sub.remove();
  }, [back]);

  // ===== 无效 id 的无效态渲染在文件尾（全部 hooks 调用完毕后再提前返回——
  // 本页 back/panelBtn/panel/countdown 等覆盖槽 effect 都在其后，提前 return
  // 必须排在它们之后，否则构成条件钩子）=====

  // 详情字段防御式提取 + 标签/分类 chips 组装（条目可能是字符串或 {id,name} 对象）；
  // 跨站过渡期旧详情不参与呈现（detailFresh 判新），poster/标题/作者全按无数据处理
  const d = detailFresh ? detail : {};
  const duration = fmtDur(d.duration);
  const tagChips = [];
  if (Array.isArray(d.tags)) {
    for (const t of d.tags) {
      if (typeof t === 'string') {
        if (t.trim()) tagChips.push({ name: t.trim() });
      } else if (t && typeof t === 'object') {
        const name = String(t.name != null ? t.name : t.tag != null ? t.tag : '').trim();
        if (name) tagChips.push({ id: t.id != null ? t.id : t.tag_id, name });
      }
    }
  }
  const catChips = [];
  if (Array.isArray(d.categories)) {
    for (const c of d.categories) {
      if (c && typeof c === 'object' && (c.id != null || c.category_id != null)) {
        const name = String(c.name != null ? c.name : c.title != null ? c.title : '').trim();
        if (name) catChips.push({ id: String(c.id != null ? c.id : c.category_id), name });
      }
    }
  }

  // meta 组装：描述盒首行含日期（移动端媒体信息统一归描述盒，不另做快览 pill）
  const date = fmtDate(d.uploadDate);
  const metaParts = [duration, !!d.hd && 'HD', d.resolution || '', date].filter(Boolean);

  // ===== 布局形态（横屏左右分栏 land/landfs / 常态双列 two / 剧场 theater / 窄幅钉顶 single）=====
  // 横屏（宽>高，旋转/改窗即时跟随）：≥1024 走 land（左纯播放器 + 右常驻面板，
  // 腾讯/爱奇艺客户端形态）；手机 <1024 走 landfs（手机横屏沉浸全屏 + 浮层面板，
  // 剧场无意义忽略）；平板 <1024 同样走 land（平板横屏是常态使用姿势而非全屏
  // 诉求——沉浸态面板退成浮层，右栏收窄为 320 适配）。竖屏维持原三态。
  // 平板判定用稳定设备形态 isPadDevice（device-class）：按 form 会在旋转瞬间
  // 翻转——大屏手机（横屏宽 844~932）误入 land 分栏进不了沉浸、小平板（竖屏
  // 宽<768）竖屏时被当手机参与旋转联动突然进全屏
  const wide = width >= DESKTOP_MIN;
  const landscape = width > 0 && vh > 0 && width > vh;
  const layout = landscape
    ? wide
      ? theater ? 'theater' : 'land'
      : isPadDevice(width)
        ? 'land'
        : 'landfs'
    : wide
      ? theater ? 'theater' : 'two'
      : 'single';
  // 应用内全屏（native 全屏钮 playerFs / web 伪全屏 webFs）：观看页整体进
  // 沉浸态——播放器铺满整屏（复用 landfs 形态）。native 横屏画幅的方向已被
  // Provider 锁成横屏（layout 自然=landfs）；竖屏画幅保持竖屏铺满（TikTok 式）。
  // AppShell 亦按 playerFs||webFs 同步收顶栏
  const fsImmersive = !!(playerFs || webFs);
  // 剧场定高：16:9 且不超视口（扣顶栏总高/手机扣安全区——顶栏在位时其在页面外）
  const theaterH = Math.min(
    Math.round((width * 9) / 16),
    Math.round(vh - (form === 'phone' ? insets.top : TOPBAR_H + insets.top))
  );
  // 右栏宽：超宽 452 / 宽幅 402；平板窄幅横屏（<1024 的 land）收窄为 320，
  // 播放器列保住 ≥60% 画幅（two 布局恒宽幅，不受末档影响）
  const asideW = width >= ULTRA_MIN ? 452 : wide ? 402 : 320;
  // landfs 浮层面板宽：上限 400，画幅窄按 46% 收（面板不吞掉播放器）
  const landPanelW = Math.min(400, Math.round(width * 0.46));

  // 播放器外框：常态桌面圆角、窄幅（<1024）通栏钉顶、剧场全宽定高、横屏
  // （land/landfs）铺满所在列高（视频 contain 黑边居中，爱奇艺形态）。框内只留
  // PlayerDock 透明锚点（把窗口坐标上报给舞台，播放器本体常驻 Provider 舞台，
  // 恰好盖满外框）；叠在播放器上的浮层（返回箭头/选集唤出钮/倒计时/landfs
  // 浮层面板）改经 setDockOverlay 注册进舞台渲染——留在页面内会被舞台 zIndex
  // 压住，看得见点不到。桌面小窗模式（miniWin）按形态处理：只留视频铺满，
  // 任何布局/尺寸都不出面板
  const landLike = layout === 'land' || layout === 'landfs' || fsImmersive || miniWin;
  const playerFrame = (
    <View
      style={{
        position: 'relative',
        width: '100%',
        backgroundColor: '#000',
        overflow: 'hidden',
        ...(layout === 'two' && !fsImmersive && !miniWin ? { borderRadius: 12 } : {}),
        ...(layout === 'theater' && !miniWin
          ? { height: theaterH }
          : landLike
            ? { height: '100%' }
            : { aspectRatio: 16 / 9 }),
      }}
    >
      {err ? (
        // 详情失败：框内错误态 + 手动重试（文案与 NextWeb 一致）
        <View style={{ width: '100%', height: '100%', justifyContent: 'center' }}>
          <ErrorState message={'详情加载失败:' + err} onRetry={() => setRetryKey((k) => k + 1)} />
          {/* telegram 未登录:加「去登录」动作(完成登录后回来重试即恢复) */}
          {tgNeedLogin ? (
            <View style={{ alignItems: 'center', marginTop: 4 }}>
              <Button size="sm" onPress={() => router.push('/telegram')}>去登录</Button>
            </View>
          ) : null}
        </View>
      ) : (
        <PlayerDock style={{ width: '100%', height: '100%' }} radius={layout === 'two' ? 12 : 0} />
      )}
    </View>
  );

  // ===== dock 覆盖槽注册：叠在播放器上的浮层全部渲染进舞台（docked 态） =====
  // 返回箭头（<1024 画幅，40px 圆钮 YouTube 图标钮规格）；桌面播放独立窗不出
  // ——独立窗无「返回」语义（点了会落到无壳 tabs 页），关闭窗即退出
  const showBackBtn = !wide && !IS_PLAYER_WINDOW;
  // 返回箭头按焦点注册（非 useEffect）：video→video 压栈期间全局槽位被上层页
  // 覆盖、上层页卸载清理又置 null，本页 effect 依赖未变不会重跑——返回后箭头
  // 永久消失；聚焦重挂即恢复。blur 时【不】清（react-navigation focus/blur 派发
  // 顺序无保证，blur 清会把新聚焦页刚挂的节点顶掉），只在卸载时按属主条件清
  //（槽里还是本页注册的节点才清，clearDockOverlay）——各顺序下均安全：
  // 压栈: B 聚焦挂 node_B,A 失焦不清；返回: B 卸载清 node_B(或被 A 的新节点
  // 顶住不动) + A 聚焦重挂。
  const backNodeRef = useRef(null);
  useFocusEffect(
    useCallback(() => {
      const node = showBackBtn ? <PlayerBackBtn back={back} /> : null;
      backNodeRef.current = node;
      setDockOverlay('back', node);
    }, [showBackBtn, back, setDockOverlay]),
  );
  useEffect(
    () => () => {
      if (backNodeRef.current != null) clearDockOverlay('back', backNodeRef.current);
    },
    [clearDockOverlay],
  );
  // 横屏全屏态（landfs）「选集」唤出钮（面板关时出现，两钮并存会打架）。
  // 横屏全屏态（landfs/应用内全屏横屏画幅）「选集」唤出钮（面板关时出现，两钮
  // 并存会打架）。竖屏应用内全屏不出：纯观看形态，选集退全屏走页面正文。
  // 小窗播放态不出：小窗右上是窗口级浮钮的地盘（置顶），且小窗里 520 宽的
  // 画幅本就只想看视频，选集走控制条「选集」钮
  const fsLandscape = layout === 'landfs' || (fsImmersive && landscape);
  const showPanelBtn = fsLandscape && !panelOpen && !miniWin;
  useEffect(() => {
    setDockOverlay('panelBtn', showPanelBtn ? <LandPanelBtn onPress={() => setPanelOpen(true)} /> : null);
    return () => setDockOverlay('panelBtn', null);
  }, [showPanelBtn, setDockOverlay]);
  // landfs 右缘浮层面板节点在 asideBlock 之后组装（见下方覆盖槽注册）
  // 自动连播倒计时浮层（播完 5s 圆环；取消留结尾帧）——cd 每秒步进,随注册更新
  useEffect(() => {
    setDockOverlay(
      'countdown',
      cd ? <CountdownOverlay next={cd} saver={saver} onCancel={cancelCd} onGo={goNext} /> : null
    );
    return () => setDockOverlay('countdown', null);
  }, [cd, saver, cancelCd, goNext, setDockOverlay]);

  // ===== 播放器随页滚动（two/theater 布局，锚点在滚动器内）=====
  // 滚动差实时喂舞台（docked 时舞台 translateY 跟随，纯 transform 零重排）；
  // 滚动结束触发锚点重测（dockNudge → measure → rect 归位、滚动差清零）。
  // land/landfs/single 播放器不在滚动器内（铺满列高/钉顶），不接线
  const dockScrollProps =
    layout === 'two' || layout === 'theater'
      ? {
          scrollEventThrottle: 16,
          onScroll: (e) => reportDockScroll(e.nativeEvent.contentOffset.y),
          onScrollEndDrag: endDockScroll,
          onMomentumScrollEnd: endDockScroll,
        }
      : null;

  // 冷启动骨架（初访/跨站）：标题条 + 频道行圆块（头像/站名）+ 描述盒行；
  // 同站切集不走此处——旧详情顶班到新详情就绪原子换装，不闪整页骨架；
  // 首判 err：初访加载失败不出「永远转不完的骨架」，错误态由播放器框统一承载
  const infoSkeleton = (
    <View style={{ marginTop: 12 }}>
      <Skeleton style={{ height: wide ? 24 : 20, width: '66%' }} />
      <View style={{ marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Skeleton style={{ width: 40, height: 40, borderRadius: 20 }} />
        <Skeleton style={{ height: 16, width: 80 }} />
      </View>
      <View style={{ marginTop: 12, borderRadius: 12, backgroundColor: p.surface, padding: 12 }}>
        <Skeleton style={{ height: 16, width: '33%' }} />
        <Skeleton style={{ height: 16, marginTop: 8, width: '66%' }} />
      </View>
    </View>
  );

  // 收藏星标入参（详情元信息快照，与 recordView 同口径）：id 用 detail.id——
  // 服务端 detail 恒回裸 vid，与收藏键 (site,vid) 天然对齐（FavButton/store 内
  // 部对 vid-epN 形态亦会归一，双保险）；跨站过渡期（detailFresh=false）置
  // null 不出星标
  const favItem = useMemo(
    () => (detailFresh && detail
      ? {
        id: String(detail.id),
        title: detail.title || '',
        cover: detail.cover || '',
        duration: detail.duration ?? null,
        hd: !!detail.hd,
      }
      : null),
    [detail, detailFresh],
  );

  // 主列信息：标题 → 频道行 → 描述盒
  const author = d.author || cardAuthor;
  const infoBlock = (
    <View style={{ minWidth: 0 }}>
      {err ? null : !detailFresh ? (
        infoSkeleton
      ) : (
        <>
          {/* 标题行：标题 + 收藏星标钮（各布局共通——single/two/land 右栏/landfs
              浮层面板/theater 均复用本 infoBlock；FavButton 内部订阅 fav-store，
              星标随清单即时翻转）。标题：不做点击展开（桌面 20px/700 行高 28，
              手机 16px/700，YouTube 定值；横屏右栏 402 宽折中 18px）；行内 Text
              显式收缩（native 陷阱：安卓 row 主轴不收缩会把星标挤出屏） */}
          <View style={{ marginTop: 12, flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
            <Text
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: layout === 'land' ? 18 : wide ? 20 : 16,
                lineHeight: layout === 'land' ? 24 : wide ? 28 : 20,
                fontWeight: '700',
                color: p.foreground,
              }}
            >
              {d.title || '(无标题)'}
            </Text>
            <FavButton site={siteParam} item={favItem} />
          </View>

          {/* 频道行：有作者才出现（宽窄幅同构，单独一行）。
              作者来源 = detail.author（上游详情带作者字段的站点）→ 卡片随行
             （avjb：作者仅存在于列表卡片）→ 无，不渲染 */}
          {author ? (
            <View style={{ marginTop: 12 }}>
              <ChannelRow site={siteParam} author={author} />
            </View>
          ) : null}

          {/* 描述盒：meta 首行 + 标签/分类 chips（默认折叠两行，「...更多」展开）；
              key 随视频变化，展开态随之重置 */}
          <DescriptionBox
            key={siteParam + '_' + id}
            style={{ marginTop: 12 }}
            metaParts={metaParts}
            tags={tagChips}
            cats={catChips}
            siteCaps={siteCaps}
          />
        </>
      )}
    </View>
  );

  // 右栏内容：选集面板（量贩/剧集 + 合集逐个叠放，详情带 packageId/gathers 时
  // 出现，YouTube 选集队列形态，置于相关推荐之上）+ 相关推荐（无标题头，
  // CompactCard 单列 + 无限滚动，数据逻辑全在上方 hook）。横屏面板里跟在信息
  // 块之后要留分隔（two 右栏顶头即选集面板不需要）
  const asideBlock = (
    <View style={{ minWidth: 0, marginTop: layout === 'two' ? 0 : landLike ? 16 : 24 }}>
      <PackagePanel
        site={siteParam}
        tag={pkgTag}
        pkg={pkg}
        currentId={currentPlayId}
        loading={pkgLoading}
        err={pkgErr}
        onRetry={() => setPkgRetry((k) => k + 1)}
        style={{ marginBottom: 16 }}
      />
      {gathers.map((g) => (
        <PackagePanel
          key={g.id}
          site={siteParam}
          tag="合集"
          fallbackTitle={g.name}
          pkg={g.data}
          currentId={currentPlayId}
          loading={g.loading}
          err={g.err}
          onRetry={() => setGatherRetry((k) => k + 1)}
          style={{ marginBottom: 16 }}
        />
      ))}
      <RelatedList
        list={rel}
        onPress={(v) => { if (v && v.id != null) goVideo(siteParam, v.id); }}
        style={{ gap: wide ? 8 : 12, paddingBottom: wide ? 0 : 16 }}
      />
    </View>
  );

  // landfs/应用内全屏横屏 右缘浮层面板（信息 → 选集 → 推荐；播放器铺满整屏，
  // 面板相对播放器定位与相对页面等价）——节点须在 infoBlock/asideBlock 组装完再建
  const panelNode =
    fsLandscape && panelOpen ? (
      <LandPanel
        width={landPanelW}
        safeRight={insets.right}
        onClose={() => setPanelOpen(false)}
        onEnd={rel.loadMore}
      >
        {infoBlock}
        {asideBlock}
      </LandPanel>
    ) : null;
  useEffect(() => {
    setDockOverlay('panel', panelNode);
    return () => setDockOverlay('panel', null);
  }, [panelNode, setDockOverlay]);

  // 无效 id：无效态（全部 hooks 已调用完毕后的提前返回位）
  if (id == null) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <ErrorState message="视频 ID 无效" />
        <Button variant="secondary" size="sm" onPress={() => router.replace('/')}>
          回首页
        </Button>
      </View>
    );
  }

  return (
    <Animated.View style={{ flex: 1, opacity: pageFade, backgroundColor: p.background }}>
      {fsImmersive || miniWin || layout === 'landfs' ? (
        // 沉浸全屏：手机横屏 landfs（物理旋转）或应用内全屏（playerFs——横屏
        // 画幅已被 Provider 锁成横屏；竖屏画幅保持竖屏铺满，TikTok 式）。
        // 桌面小窗模式（miniWin，桌面壳播放窗的「小窗播放」开关态）同走此分
        // 支——小窗是一种模式而非尺寸档：不论窗口任何尺寸都只留视频铺满，
        // 面板/信息区一概不出（land 分支收右栏语义的推广）。
        // AppShell 已同步收顶栏——播放器 edge-to-edge 铺满整屏（舞台含到屏幕
        // 边缘，视频 letterbox/裁切自然吸收刘海，黑边只剩视频自身比例差且两侧
        // 对称）；返回/选集钮自读安全区避开刘海；「选集」圆钮唤出右缘浮层
        // 面板（仅横屏）
        <View style={{ flex: 1 }}>{playerFrame}</View>
      ) : layout === 'land' ? (
        // 横屏分栏（宽幅≥1024，或平板窄幅横屏）：腾讯视频/爱奇艺客户端形态——
        // 左列纯播放器铺满整列高（视频 contain 黑边居中、控制条铺满左区），右栏
        // 常驻面板（信息 → 选集 → 推荐）独立滚动，左边框分隔；相关推荐触底加载
        // 由右栏驱动。小窗播放态收掉右栏（小窗里只留视频，站方小窗形态）
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <View style={{ flex: 1, minWidth: 0 }}>{playerFrame}</View>
          {miniWin ? null : (
            <View style={{ width: asideW, flexShrink: 0, borderLeftWidth: 1, borderLeftColor: p.line }}>
              <ScrollView
                style={{ flex: 1 }}
                // 播放独立窗：右栏内容下移让开顶部浮条（该窗无独立标题栏，控制钮
                // 压在画面顶部；主窗 land 用 AppShell 顶栏，不需要让位）
                contentContainerStyle={{
                  paddingTop: IS_PLAYER_WINDOW ? 52 : 12,
                  paddingBottom: 16,
                  paddingHorizontal: 16,
                }}
                {...endReachedProps(rel.loadMore)}
              >
                {infoBlock}
                {asideBlock}
              </ScrollView>
            </View>
          )}
        </View>
      ) : layout === 'two' ? (
        // 常态宽幅双列：左列（播放器+信息）页面滚；右栏独立滚（NextWeb 右栏
        // max-h + overflow-y-auto 的等价形态），相关推荐的无限滚动由右栏驱动
        <View style={{ flex: 1, flexDirection: 'row', gap: 24 }}>
          <ScrollView
            style={{ flex: 1, minWidth: 0 }}
            contentContainerStyle={{ padding: 24 }}
            {...dockScrollProps}
          >
            {playerFrame}
            {infoBlock}
          </ScrollView>
          <View style={{ width: asideW, flexShrink: 0 }}>
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingBottom: 16, paddingRight: 4 }}
              {...endReachedProps(rel.loadMore)}
            >
              {asideBlock}
            </ScrollView>
          </View>
        </View>
      ) : layout === 'theater' ? (
        // 剧场单列：播放器通栏定高出血，信息与相关限宽 1280 居中，整页滚动
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 24 }}
          {...dockScrollProps}
          {...endReachedProps(rel.loadMore)}
        >
          {playerFrame}
          <View style={{ width: '100%', maxWidth: 1280, alignSelf: 'center', paddingHorizontal: 24 }}>
            {infoBlock}
            {asideBlock}
          </View>
        </ScrollView>
      ) : (
        // 窄幅（<1024）：播放器钉顶通栏（手机画幅顶栏底栏已被 AppShell 整条隐藏，
        // 此处垫顶部安全区）+ 正文滚动（信息 → 选集面板 → 相关推荐）
        <View style={{ flex: 1 }}>
          <View style={{ paddingTop: form === 'phone' ? insets.top : 0 }}>{playerFrame}</View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{
              paddingHorizontal: form === 'phone' ? 12 : 24,
              paddingBottom: 32,
            }}
            {...endReachedProps(rel.loadMore)}
          >
            {infoBlock}
            {asideBlock}
          </ScrollView>
        </View>
      )}
    </Animated.View>
  );
}
