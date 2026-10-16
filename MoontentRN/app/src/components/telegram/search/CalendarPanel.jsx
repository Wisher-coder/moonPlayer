// ============================================================================
// CalendarPanel.jsx —— 消息日历面板(Modal,CalendarMessageScreen 语义)
// ----------------------------------------------------------------------------
// 页面蓝图 §5.3-C 契约(挂载方=聊天页 M1,宿主页内 Modal 浮层,非路由屏):
//   { peer, visible, onClose, onJump(msgId), initialMonth? }
// 数据面:GET /api/telegram/calendar?peer=&month=YYYY-MM(增量端点契约页面
// 蓝图 §4.2-③,双引擎可用)→ {month, days:[{date:'YYYY-MM-DD',count,
// lastMessageId}]}。点击有消息的日 → onJump(day.lastMessageId)——跳转执行
// (窗口内 jumpToRow / 窗口外 loadInitial)由装配方(页面-历史双后端)实现,
// 本组件只上抛消息 id 并关闭。
// 交互口径:
//   · 月切换单飞锁:在途请求未返回前忽略再次翻月(防风暴红线);
//   · 失败如实呈现契约错误原文 + 显式重试,绝不自动重试;
//   · 长按日预览当日消息(TI previewDay)裁剪 v1(缺口注明,后续增量);
//   · threadId 参数 v1 两引擎均不消费(服务端契约注释)。
// 周起始取周日(中国区习惯周一亦可,取实现最简口径,注释明示)。
// ============================================================================
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../../../lib/tg-api.js';
import { ABS_FILL } from '../../../lib/abs-fill.js';
import { usePalette } from '../../ui/palette.js';
import { ChevronLeft, ChevronRight, Close } from '../../icons.js';

const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六']; // getDay() 0=周日,首列对齐

// 'YYYY-MM' 工具:当前月 / 月加减 / 合法性(防御式,非法回 null)
function pad2(n) { return ('0' + n).slice(-2); }
function monthKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
function parseMonth(s) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return new Date(y, mo - 1, 1);
}
function shiftMonth(key, delta) {
  const d = parseMonth(key);
  if (!d) return null;
  return monthKey(new Date(d.getFullYear(), d.getMonth() + delta, 1));
}

export default function CalendarPanel({ peer, visible, onClose, onJump, initialMonth }) {
  const p = usePalette();
  // 系统栏让位(Modal statusBarTranslucent,内容铺到状态栏之下;web/桌面恒 0,
  // 同 album/PhotoViewer.jsx 顶栏垫法)
  const insets = useSafeAreaInsets();
  const [month, setMonth] = useState(monthKey(new Date()));
  const [days, setDays] = useState({}); // { 'YYYY-MM-DD': {count,lastMessageId} }
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const aliveRef = useRef(true);
  const inflightRef = useRef(false); // 月切换单飞锁:在途忽略再次翻月
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // 打开即重置到 initialMonth(缺省当前月)并拉取;关闭不作状态保留(TI 同口径)。
  // 重置走 useLayoutEffect(paint 前完成,避免重开时旧月份闪一帧)。
  useLayoutEffect(() => {
    if (!visible) return;
    const init = parseMonth(initialMonth) ? String(initialMonth) : monthKey(new Date());
    setMonth(init);
    setDays({});
    setErr('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const fetchMonth = useCallback(async (want) => {
    if (inflightRef.current) return; // 单飞锁:上一月请求在途,忽略本次切换
    inflightRef.current = true;
    setLoading(true);
    setErr('');
    try {
      const r = await api('telegram', 'calendar', { peer, month: want });
      if (!aliveRef.current) return;
      const map = {};
      const list = Array.isArray(r && r.days) ? r.days : [];
      for (const d of list) {
        if (d && typeof d.date === 'string') {
          map[d.date] = { count: Math.max(0, Math.floor(Number(d.count) || 0)), lastMessageId: Number(d.lastMessageId) || 0 };
        }
      }
      setDays(map);
    } catch (e) {
      if (!aliveRef.current) return;
      setDays({});
      setErr((e && e.message) || '日历加载失败,请重试');
    } finally {
      if (aliveRef.current) setLoading(false);
      inflightRef.current = false;
    }
  }, [peer]);

  // month 变化(打开重置/翻月)即拉取该月
  useEffect(() => {
    if (!visible || !peer) return;
    fetchMonth(month);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, visible, peer]);

  const goMonth = useCallback((delta) => {
    const next = shiftMonth(month, delta);
    if (next) setMonth(next); // 在途时 fetchMonth 内单飞锁会忽略本次拉取
  }, [month]);

  const pickDay = useCallback((info) => {
    if (!info || !(info.lastMessageId > 0)) return;
    if (typeof onJump === 'function') onJump(info.lastMessageId);
    onClose();
  }, [onJump, onClose]);

  if (!visible) return null;

  // 该月网格:首日 getDay() 个前导空格 + 当月逐日 + 尾行补空位(占位格
  // flex:1 保列宽,防末行不足 7 格被撑大与星期头错位;media/MediaGrid.jsx
  // buildGridRows 同口径)
  const first = parseMonth(month) || new Date();
  const dim = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const lead = first.getDay();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= dim; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);

  const ym = first.getFullYear() + ' 年 ' + (first.getMonth() + 1) + ' 月';
  const dayKeyOf = (d) => month + '-' + pad2(d);
  // 「今天」高亮按本地时区取;但服务端消息分日是 UTC 口径(两引擎 ymdOf/
  // monthWindowUtc 均以 toISOString 切日)——UTC+8 的 0-8 点消息会计入
  // 前一日格子,今天框计数不含当天凌晨消息。属跨时区语义取舍,按 TI 本地
  // 日历对齐需服务端双引擎同步加分日时区参数,当前如实注明不掩盖
  // (2026-10-12 复核留痕)。
  const todayKey = monthKey(new Date()) + '-' + pad2(new Date().getDate());

  return (
    <Modal transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={[ABS_FILL, { backgroundColor: p.background }]}>
        {/* 顶栏:关闭 + 月份标题 + 翻月(垫状态栏高) */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingTop: 12 + insets.top, paddingBottom: 8 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭日历" hitSlop={8} onPress={onClose}
            style={({ pressed }) => ({ padding: 6, opacity: pressed ? 0.6 : 1 })}>
            <Close size={18} color={p.foreground} />
          </Pressable>
          <Text style={{ flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600', color: p.foreground }}>{ym}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="上一月" hitSlop={8} disabled={loading}
            onPress={() => goMonth(-1)} style={({ pressed }) => ({ padding: 6, opacity: pressed || loading ? 0.5 : 1 })}>
            <ChevronLeft size={18} color={p.foreground} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="下一月" hitSlop={8} disabled={loading}
            onPress={() => goMonth(1)} style={({ pressed }) => ({ padding: 6, opacity: pressed || loading ? 0.5 : 1 })}>
            <ChevronRight size={18} color={p.foreground} />
          </Pressable>
        </View>

        {/* 周表头 */}
        <View style={{ flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 6 }}>
          {WEEK_LABELS.map((w) => (
            <View key={w} style={{ flex: 1, alignItems: 'center' }}>
              <Text style={{ fontSize: 11, color: p.muted, includeFontPadding: false }}>{w}</Text>
            </View>
          ))}
        </View>

        {/* 加载态占满中段;网格滚动区底部垫 insets.bottom 让位手势条(web/桌面恒 0 原形态) */}
        {loading ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={p.link} />
          </View>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 24 + insets.bottom }}>
            {err ? (
              <View style={{ gap: 8, paddingVertical: 12 }}>
                {/* 契约错误原文呈现(引擎不支持等);重试仅显式触发,绝不自动重试 */}
                <Text style={{ fontSize: 13, lineHeight: 18, color: p.accent }}>{err}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="重试加载日历" hitSlop={6}
                  onPress={() => fetchMonth(month)} style={({ pressed }) => ({ alignSelf: 'flex-start', opacity: pressed ? 0.7 : 1 })}>
                  <Text style={{ fontSize: 13, fontWeight: '500', color: p.link }}>重试</Text>
                </Pressable>
              </View>
            ) : null}
            {Array.from({ length: Math.ceil(cells.length / 7) }, (_, w) => (
              <View key={w} style={{ flexDirection: 'row' }}>
                {cells.slice(w * 7, w * 7 + 7).map((d, i) => {
                  if (d == null) return <View key={'e' + i} style={{ flex: 1, aspectRatio: 1 }} />;
                  const info = days[dayKeyOf(d)] || null;
                  const has = !!(info && info.count > 0 && info.lastMessageId > 0);
                  const isToday = dayKeyOf(d) === todayKey;
                  return (
                    <View key={d} style={{ flex: 1, aspectRatio: 1, padding: 2 }}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={has ? month + '-' + pad2(d) + ' 有 ' + info.count + ' 条消息,点击跳转' : month + '-' + pad2(d)}
                        disabled={!has}
                        onPress={() => pickDay(info)}
                        style={({ pressed }) => ({
                          flex: 1, borderRadius: 10, alignItems: 'center', justifyContent: 'center', gap: 2,
                          backgroundColor: has ? (pressed ? p.surface2 : p.background) : 'transparent',
                          borderWidth: isToday ? 1 : 0, borderColor: p.line,
                        })}
                      >
                        <Text style={{ fontSize: 14, fontWeight: has ? '600' : '400', color: has ? p.foreground : p.muted, includeFontPadding: false }}>
                          {d}
                        </Text>
                        {has ? (
                          <Text style={{ fontSize: 9, color: p.link, includeFontPadding: false }}>
                            {info.count > 99 ? '99+' : info.count}
                          </Text>
                        ) : null}
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            ))}
            <Text style={{ fontSize: 11, lineHeight: 16, color: p.muted, textAlign: 'center', marginTop: 12 }}>
              点击有消息的日期跳转到当天最后一条消息
            </Text>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}
