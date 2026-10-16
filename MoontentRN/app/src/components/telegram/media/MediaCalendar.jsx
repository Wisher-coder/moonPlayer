// ============================================================================
// MediaCalendar.jsx —— 共享媒体面板·媒体日历(全屏 Modal)
// ----------------------------------------------------------------------------
// 观感基准 = Telegram-iOS CalendarMessageScreen(月份面板垂直堆叠、最新月在
// 底部;月标题 semibold 17 居中 + 星期头 regular 10 + 7 列网格;日格圆形
// 缩略图内叠日期数字;今天高亮、未来日期禁用)。RN 侧落法:
//   · inverted FlatList(FlashList v2 不支持 inverted,见 chat/[id].js 头注;
//     FlatList 自动逐格翻正,子项无需手写 scaleY)——data=月份键数组(最新在
//     首),最新月恒渲染在底部,向视觉上端滚动即走向更旧;
//   · 数据面:GET /api/telegram/calendar {peer, month:'YYYY-MM', type:'media'}
//     → {days:[{date,count,lastMessageId,thumb}]}(thumb 为图片代理地址,经
//     normalize.js 绝对化;失败为 null)。每月一拉,打开预载当前(或
//     initialMonth)连三个月填满视口;
//   · 滚到旧端按月递推:FlatList onEndReached 追加更旧一个月;限速口径 =
//     「最旧月数据落定才允许再递推」(每追加一月必等一次往返,防风暴),
//     另设空月连击上限(连续 48 个月无任何内容即停,尽头出提示);
//   · 内容不足一屏时自动补月(onContentSizeChange 量测,同受上限约束);
//   · 点有内容日 → onPickDay({date,count,lastMessageId})(装配方重锚媒体
//     网格到当日);长按 → ContextMenu「在聊天中查看」→ onOpenChat
//     (lastMessageId)。
// 周起始取周日(与 search/CalendarPanel 同口径,注释明示);分日本地时区
// (服务端 calendar 已按本地时区对齐分日,extras.js ensureCalendarTimezone)。
// 失败如实呈现中文错误 + 显式重试,绝不自动重试(防风暴红线)。
// ============================================================================
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ABS_FILL } from '../../../lib/abs-fill.js';
import { api } from '../../../lib/tg-api.js';
import { usePalette } from '../../ui/palette.js';
import usePressVisual from '../../../lib/use-press-visual.js';
import { Close } from '../../icons.js';
import ContextMenu from '../context-menu/ContextMenu.jsx';
import { absolutizeMediaUrl } from './normalize.js';
import { monthLabelOf } from './MediaGrid.jsx';

const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六']; // getDay() 0=周日,首列对齐
const SIDE_INSET = 14;      // 网格左右留白(TI CalendarView 同值)
const CELL_GAP = 6;         // 日格间距(TI weekdaySpacing 同值)
const PRELOAD_MONTHS = 3;   // 打开预载月数(填满一屏,防 inverted 列表无内容可滚)
const EMPTY_MONTH_CAP = 48; // 空月连击上限(连续无内容月份数,达到即停止递推)
const CAL_MAX_W = 460;      // 面板内容最大宽(平板/桌面居中收束,iPad 同款观感)

// —— 'YYYY-MM' 工具(本地时区;与 CalendarPanel 同款语义) ——
function pad2(n) { return ('0' + n).slice(-2); }
function monthKeyOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
function parseMonthKey(s) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return new Date(Number(m[1]), mo - 1, 1);
}
function shiftMonthKey(key, delta) {
  const d = parseMonthKey(key);
  if (!d) return null;
  return monthKeyOf(new Date(d.getFullYear(), d.getMonth() + delta, 1));
}
function todayKeyOf() {
  const now = new Date();
  return monthKeyOf(now) + '-' + pad2(now.getDate());
}

// —— 单日格:有 thumb → 圆形缩略图叠白字日期;有内容无 thumb → 灰圈前景字;
//    无内容 → 灰圈 muted 字(不可点);今天 → 交互蓝描边高亮;未来 → 禁用降透明 ——
function DayCell({ monthKey, day, info, todayKey, onPickDay, onLongPressDay }) {
  const p = usePalette();
  const hv = usePressVisual();
  const key = monthKey + '-' + pad2(day);
  const has = !!(info && info.count > 0 && info.lastMessageId > 0);
  const isToday = key === todayKey;
  const isFuture = key > todayKey; // 'YYYY-MM-DD' 字典序即日期序
  const onPhoto = has && !!info.thumb;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={!has}
      accessibilityLabel={
        has
          ? monthKey + '-' + pad2(day) + ',当日 ' + info.count + ' 项媒体(点击查看,长按可在聊天中查看)'
          : monthKey + '-' + pad2(day)
      }
      onPress={() => has && onPickDay(info)}
      onLongPress={() => has && onLongPressDay(info)}
      delayLongPress={400}
      {...hv.binds}
      style={[{ flex: 1, aspectRatio: 1, padding: CELL_GAP / 2 }, { opacity: hv.pressed && has ? 0.75 : 1 }]}
    >
      <View
        style={{
          flex: 1,
          borderRadius: 999,
          overflow: 'hidden',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: p.surface2,
          borderWidth: isToday ? 1.5 : 0,
          borderColor: p.link,
          opacity: isFuture ? 0.45 : 1,
        }}
      >
        {onPhoto ? (
          <Image
            source={{ uri: info.thumb }}
            style={ABS_FILL}
            contentFit="cover"
            transition={150}
            recyclingKey={String(info.thumb)}
          />
        ) : null}
        <Text
          style={{
            fontSize: 15,
            fontWeight: has ? '600' : '400',
            color: isFuture
              ? p.muted
              : onPhoto
                ? '#ffffff'
                : has ? p.foreground : p.muted,
            textShadowColor: onPhoto ? 'rgba(0,0,0,0.55)' : 'transparent',
            textShadowOffset: { width: 0, height: 1 },
            textShadowRadius: onPhoto ? 2 : 0,
            includeFontPadding: false,
          }}
        >
          {day}
        </Text>
      </View>
    </Pressable>
  );
}

// —— 月份面板:月标题(semibold 17 居中)+ 星期头 + 7 列日格;失败出错误+重试 ——
function MonthPanel({ monthKey, entry, todayKey, onPickDay, onLongPressDay, onRetry }) {
  const p = usePalette();
  const retryHv = usePressVisual(); // 重试钮按压视觉(Android 样式函数陷阱,见 use-press-visual 头注)
  const first = parseMonthKey(monthKey) || new Date();
  const dim = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const lead = first.getDay(); // 周日起始:首行前导空格数
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= dim; d++) cells.push(d);
  while (cells.length % 7) cells.push(null); // 尾行补位占满 7 槽:日格 flex:1 才与星期头 7×flex:1 同列宽(否则末行不足 7 格被撑大;同目录 MediaGrid.jsx buildGridRows 同口径)

  return (
    <View style={{ paddingHorizontal: SIDE_INSET, marginBottom: 24 }}>
      <Text style={{ fontSize: 17, fontWeight: '600', textAlign: 'center', color: p.foreground, includeFontPadding: false }}>
        {monthLabelOf(monthKey)}
      </Text>
      {/* 星期头(周日起始,regular 10,TI 同规格) */}
      <View style={{ flexDirection: 'row', paddingVertical: 10 }}>
        {WEEK_LABELS.map((w) => (
          <View key={w} style={{ flex: 1, alignItems: 'center' }}>
            <Text style={{ fontSize: 10, color: p.muted, includeFontPadding: false }}>{w}</Text>
          </View>
        ))}
      </View>
      {entry && entry.err ? (
        <View style={{ gap: 8, paddingVertical: 12, alignItems: 'center' }}>
          {/* 契约错误原文呈现;重试仅显式触发,绝不自动重试 */}
          <Text style={{ fontSize: 13, lineHeight: 18, color: p.accent, textAlign: 'center' }}>{entry.err}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={'重试加载 ' + monthLabelOf(monthKey)}
            hitSlop={6}
            onPress={() => onRetry(monthKey)}
            {...retryHv.binds}
            style={[{ padding: 4 }, { opacity: retryHv.pressed ? 0.7 : 1 }]}
          >
            <Text style={{ fontSize: 13, fontWeight: '500', color: p.link }}>重试</Text>
          </Pressable>
        </View>
      ) : !entry ? (
        <View style={{ paddingVertical: 24, alignItems: 'center' }}>
          <ActivityIndicator color={p.link} />
        </View>
      ) : (
        Array.from({ length: Math.ceil(cells.length / 7) }, (_, w) => (
            <View key={w} style={{ flexDirection: 'row' }}>
              {cells.slice(w * 7, w * 7 + 7).map((d, i) => {
                if (d == null) return <View key={'e' + i} style={{ flex: 1, aspectRatio: 1 }} />;
                return (
                  <DayCell
                    key={d}
                    monthKey={monthKey}
                    day={d}
                    info={(entry && entry.days && entry.days[monthKey + '-' + pad2(d)]) || null}
                    todayKey={todayKey}
                    onPickDay={onPickDay}
                    onLongPressDay={onLongPressDay}
                  />
                );
              })}
            </View>
          ))
        )}
    </View>
  );
}

// —— 顶部使用提示(inverted 首子项=视觉底端);底部垫 insets.bottom 让位
//    手势条(Modal statusBarTranslucent 全屏铺开;web/桌面恒 0 原形态) ——
function CalendarHint() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ paddingHorizontal: SIDE_INSET, paddingBottom: 16 + insets.bottom }}>
      <Text style={{ fontSize: 11, lineHeight: 16, color: p.muted, textAlign: 'center' }}>
        点击日期查看当天媒体;长按日期可在聊天中查看
      </Text>
    </View>
  );
}

function MediaCalendar({ peer, visible, onClose, onPickDay, onOpenChat, initialMonth }) {
  const p = usePalette();
  // 系统栏让位(Modal statusBarTranslucent,内容铺到状态栏之下;web/桌面恒 0,
  // 同 album/PhotoViewer.jsx 顶栏垫法)
  const insets = useSafeAreaInsets();
  const closeHv = usePressVisual(); // 关闭钮按压视觉(Android 样式函数陷阱,见 use-press-visual 头注)
  const [months, setMonths] = useState([]); // 月份键数组,最新月在首(inverted 渲染在底部)
  const [data, setData] = useState({});     // monthKey → {days:{'YYYY-MM-DD':{count,lastMessageId,thumb}}} | {err}
  const [menuDay, setMenuDay] = useState(null); // 长按菜单目标 {date,count,lastMessageId}
  const [reachedLimit, setReachedLimit] = useState(false); // 空月连击达上限(旧端出提示)
  const [retryTick, setRetryTick] = useState(0);           // 单月失败显式重试计数

  const todayKey = todayKeyOf();
  const aliveRef = useRef(true);
  const openSeqRef = useRef(0);      // 打开纪元(关闭重开作废在途响应)
  const requestedRef = useRef(new Set()); // 已请求月份(去重;失败可回退重试)
  const monthsRef = useRef(months);
  monthsRef.current = months;
  const dataRef = useRef(data);
  dataRef.current = data;
  const limitRef = useRef(false);
  limitRef.current = reachedLimit;
  const contentHRef = useRef(0); // inverted 列表内容总高(量测)
  const viewHRef = useRef(0);    // 可视高(量测)

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // 打开即重置:预载 initialMonth(缺省当前月)连三个月;关闭不作状态保留(TI 同口径)
  useLayoutEffect(() => {
    if (!visible) return;
    openSeqRef.current += 1;
    requestedRef.current = new Set();
    setReachedLimit(false);
    setMenuDay(null);
    const init = parseMonthKey(initialMonth) ? String(initialMonth) : monthKeyOf(new Date());
    const list = [];
    let mk = init;
    for (let i = 0; i < PRELOAD_MONTHS; i++) {
      if (!mk || list.indexOf(mk) !== -1) break;
      list.push(mk);
      mk = shiftMonthKey(mk, -1);
    }
    setMonths(list);
    setData({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // 月份缺口补拉(打开/递推/重试都会落到这):每月份至多一请求;失败回退
  // requested 允许显式重试;绝不自动重试(防风暴红线)
  useEffect(() => {
    if (!visible || !peer) return;
    const seq = openSeqRef.current;
    for (const mk of months) {
      if (requestedRef.current.has(mk)) continue;
      requestedRef.current.add(mk);
      api('telegram', 'calendar', { peer, month: mk, type: 'media' })
        .then((r) => {
          if (!aliveRef.current || seq !== openSeqRef.current) return;
          const days = {};
          for (const d of Array.isArray(r && r.days) ? r.days : []) {
            if (d && typeof d.date === 'string') {
              days[d.date] = {
                count: Math.max(0, Math.floor(Number(d.count)) || 0),
                lastMessageId: Number(d.lastMessageId) || 0,
                thumb: typeof d.thumb === 'string' && d.thumb ? absolutizeMediaUrl(d.thumb) : null,
              };
            }
          }
          setData((prev) => ({ ...prev, [mk]: { days } }));
        })
        .catch((e) => {
          if (!aliveRef.current || seq !== openSeqRef.current) return;
          requestedRef.current.delete(mk); // 失败允许显式重试
          setData((prev) => ({ ...prev, [mk]: { err: (e && e.message) || '日历加载失败,请重试' } }));
        });
    }
  }, [visible, peer, months, retryTick]);

  // 数据落地 → 空月连击重算(自最旧月向新数连续无内容月数;未落定段停数)
  useEffect(() => {
    const list = monthsRef.current;
    let streak = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = dataRef.current[list[i]];
      if (!entry || !entry.days) break; // 未落定/失败:停在已判定段
      const has = Object.keys(entry.days).some((k) => entry.days[k].count > 0);
      if (has) break;
      streak++;
    }
    setReachedLimit(streak >= EMPTY_MONTH_CAP);
  }, [data]);

  // 内容不足一屏 → 自动补更旧一月(inverted 列表内容矮于视口无法滚动,
  // 不补月就永远触不到 onEndReached;受空月上限约束)
  useEffect(() => {
    if (!visible) return;
    if (viewHRef.current > 0 && contentHRef.current > 0 && contentHRef.current <= viewHRef.current + 40) {
      loadOlderRef.current();
    }
  }, [data, months, visible]);

  // 递推更旧一月:最旧月数据落定才允许(每追加一月必等一次往返,防滚动
  // 事件连打的请求风暴);连击上限后停
  const loadOlder = useCallback(() => {
    if (!visible || limitRef.current) return;
    const list = monthsRef.current;
    const oldest = list[list.length - 1];
    if (!oldest) return;
    if (!dataRef.current[oldest]) return; // 在途/未落定:等这一月落定再递推
    const prev = shiftMonthKey(oldest, -1);
    if (!prev || list.indexOf(prev) !== -1) return;
    setMonths((cur) => (cur.indexOf(prev) !== -1 ? cur : cur.concat(prev)));
  }, [visible]);
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;

  // 点日:上抛当日信息(装配方重锚媒体网格)并关闭;长按:出「在聊天中查看」菜单
  const pickDay = useCallback(
    (info) => {
      if (!info || !(info.lastMessageId > 0)) return;
      if (typeof onPickDay === 'function') onPickDay(info);
      onClose();
    },
    [onPickDay, onClose]
  );
  const longPressDay = useCallback((info) => {
    if (info && info.lastMessageId > 0) setMenuDay(info);
  }, []);
  const menuItems = menuDay
    ? [
        {
          key: 'in-chat',
          label: '在聊天中查看',
          onPress: () => {
            const id = menuDay.lastMessageId;
            setMenuDay(null);
            if (typeof onOpenChat === 'function') onOpenChat(id);
          },
        },
      ]
    : [];

  if (!visible) return null;

  return (
    <Modal transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={[ABS_FILL, { backgroundColor: p.background }]}>
        {/* 顶栏:关闭 + 标题(TI CalendarScreen 导航栏形态;垫状态栏高) */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingTop: 12 + insets.top, paddingBottom: 8 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭媒体日历"
            hitSlop={8}
            onPress={onClose}
            {...closeHv.binds}
            style={[{ padding: 6 }, { opacity: closeHv.pressed ? 0.6 : 1 }]}
          >
            <Close size={18} color={p.foreground} />
          </Pressable>
          <Text style={{ flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600', color: p.foreground }}>
            媒体日历
          </Text>
          {/* 右侧占位:标题真居中 */}
          <View style={{ width: 30 }} />
        </View>

        {/* 月份堆叠:最新月在底部(inverted),向视觉上端滚向更旧;递推按月 */}
        <FlatList
          data={months}
          inverted
          keyExtractor={(mk) => String(mk)}
          showsVerticalScrollIndicator={false}
          onEndReached={loadOlder}
          onEndReachedThreshold={0.5}
          onLayout={(e) => { viewHRef.current = e.nativeEvent.layout.height; }}
          onContentSizeChange={(w, h) => { contentHRef.current = h; }}
          style={{ flex: 1, maxWidth: CAL_MAX_W, width: '100%', alignSelf: 'center' }} // 居中收束挂 style(contentContainer 挂 maxWidth/width/alignSelf 属脆弱用法;inverted 变换在本层,收束外移布局不回归)
          ListHeaderComponent={<CalendarHint />}
          ListFooterComponent={
            reachedLimit ? (
              <View style={{ paddingVertical: 14, paddingHorizontal: SIDE_INSET }}>
                <Text style={{ fontSize: 11, color: p.muted, textAlign: 'center' }}>没有更早的媒体了</Text>
              </View>
            ) : months.length && data[months[months.length - 1]] == null ? (
              // 旧端最后一月在途:顶端出加载指示(落定后让位)
              <View style={{ paddingVertical: 10, alignItems: 'center' }}>
                <ActivityIndicator size="small" color={p.link} />
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <MonthPanel
              monthKey={item}
              entry={data[item] || null}
              todayKey={todayKey}
              onPickDay={pickDay}
              onLongPressDay={longPressDay}
              onRetry={(mk) => setRetryTick((t) => t + 1)}
            />
          )}
        />
        {/* 长按日菜单:「在聊天中查看」(M4 通用容器复用;嵌套 Modal 自然置顶) */}
        <ContextMenu visible={!!menuDay} onClose={() => setMenuDay(null)} items={menuItems} />
      </View>
    </Modal>
  );
}

export default memo(MediaCalendar);
