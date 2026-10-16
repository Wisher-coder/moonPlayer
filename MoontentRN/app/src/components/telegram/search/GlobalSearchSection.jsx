// ============================================================================
// GlobalSearchSection.jsx —— 列表页 #话题 全局搜索结果段
// ----------------------------------------------------------------------------
// 页面蓝图 §5.3-D:列表页搜索词以「#」开头时,在本页搜索区追加全局公开帖
// 结果段(GET /api/telegram/search/global,增量端点契约见页面蓝图 §4.2-②)。
// 契约:
//   { query, resolveChat?, onOpenMessage?, limit? }
//   · query        外部受控搜索词(本段内部做 250ms 防抖,防风暴红线);
//   · resolveChat(peerKey) → {name,kind,avatar}|null:对话名解析器(宿主页
//     用已载对话表注入;未命中行内退「对话 <peerKey>」兜底——增量端点不回
//     源对话名,绝不逐条回源是仓库红线);
//   · onOpenMessage(msg):行点击回调(宿主页组装跳转:push 聊天页带 anchor);
//   · limit        单页条数(服务端上限 50,缺省 20)。
// 分页双轨(TD/MTProto 引擎差异在响应侧消化):TDLib 响应带加性字段
// nextOffset(不透明令牌)原样回传;MTProto 无令牌,用上一页最后一条消息的
// (date 秒,peerKey,id)三元组。「加载更多」为显式点按,绝不自动连打。
// 引擎不支持 → 契约错误 {__err:1,message:'该引擎暂不支持全局搜索…'} 原文
// 呈现 + 显式重试,绝不轮询重试(防风暴红线)。
// ============================================================================
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { api } from '../../../lib/tg-api.js';
import { usePalette } from '../../ui/palette.js';
import TgAvatar from '../PeerBadge.jsx';
import { fmtChatDate } from '../chat-helpers.js';
import { msgSnippet } from './snippet.js';

const DEBOUNCE_MS = 250;

export default function GlobalSearchSection({ query, resolveChat, onOpenMessage, limit = 20 }) {
  const p = usePalette();
  const [phase, setPhase] = useState('idle'); // idle | loading | done | error
  const [messages, setMessages] = useState([]);
  const [completed, setCompleted] = useState(true);
  const [cursor, setCursor] = useState(null); // 下页游标:{offset} 或 {offsetDate,offsetPeer,offsetId}
  const [err, setErr] = useState('');
  const [moreBusy, setMoreBusy] = useState(false);

  const aliveRef = useRef(true);
  const abortRef = useRef(null);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  const q = typeof query === 'string' ? query.trim() : '';
  const isTag = q.startsWith('#') && q.length > 1;

  const fetchPage = useCallback(async (want, cur, isLoadMore) => {
    if (abortRef.current) abortRef.current.abort();
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    abortRef.current = ctl;
    const params = { q: want, limit };
    if (cur) Object.assign(params, cur);
    if (isLoadMore) setMoreBusy(true);
    else setPhase('loading');
    try {
      const r = await api('telegram', 'search/global', params, { signal: ctl ? ctl.signal : undefined });
      if (!aliveRef.current) return;
      const msgs = Array.isArray(r && r.messages) ? r.messages.filter(Boolean) : [];
      const last = msgs.length ? msgs[msgs.length - 1] : null;
      // 下页游标:优先 TDLib nextOffset 令牌;无令牌(MTProto)用最后一条的
      // 三元组——三元组必须齐备(date 缺失则视为到底,不再提供翻页)
      let nextCur = null;
      if (r && r.nextOffset) {
        nextCur = { offset: r.nextOffset };
      } else if (last && last.peerKey && last.id != null && last.date) {
        const sec = Math.floor(new Date(last.date).getTime() / 1000);
        if (Number.isFinite(sec) && sec > 0) {
          nextCur = { offsetDate: sec, offsetPeer: String(last.peerKey), offsetId: Number(last.id) };
        }
      }
      setMessages((prev) => {
        if (!isLoadMore) return msgs;
        const seen = new Set(prev.map((x) => x && x.id != null ? String(x.peerKey) + ':' + String(x.id) : ''));
        return prev.concat(msgs.filter((x) => x && !seen.has(String(x.peerKey) + ':' + String(x.id))));
      });
      setCompleted(r ? Boolean(r.completed) && !nextCur : true);
      setCursor(nextCur);
      setErr('');
      setPhase('done');
    } catch (e) {
      if (!aliveRef.current) return;
      if (e && e.name === 'AbortError') return; // 换词/卸载掐断:静默
      setErr((e && e.message) || '搜索失败,请重试');
      // 翻页失败保留已载结果(仅标错误),首页失败才进整段错误态
      if (!isLoadMore) setPhase('error');
    } finally {
      if (isLoadMore) setMoreBusy(false);
    }
  }, [limit]);

  // 关键词变化:250ms 防抖后拉第一页;非 # 词不做任何取数(本段直接不渲染,
  // 渲染层已 return null,残留结果态不会外露;再入 # 词时 fetchPage 全量重置)
  useEffect(() => {
    if (!isTag) return undefined;
    const t = setTimeout(() => { fetchPage(q, null, false); }, DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  if (!isTag) return null;

  const chatMetaOf = (msg) => {
    const pk = msg && msg.peerKey != null ? String(msg.peerKey) : '';
    const meta = typeof resolveChat === 'function' ? resolveChat(pk) : null;
    return {
      name: (meta && meta.name) || (pk ? '对话 ' + pk : '(未知对话)'),
      avatar: (meta && meta.avatar) || '',
      kind: (meta && meta.kind) || '',
    };
  };

  return (
    <View>
      <Text style={{ fontSize: 13, fontWeight: '600', color: p.muted, paddingHorizontal: 16, paddingVertical: 8 }}>
        全局公开帖
      </Text>

      {phase === 'loading' ? (
        <View style={{ paddingVertical: 28, alignItems: 'center' }}>
          <ActivityIndicator color={p.link} />
        </View>
      ) : phase === 'error' ? (
        <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 8 }}>
          {/* 契约错误原文呈现(引擎不支持等);重试仅显式触发,绝不自动重试 */}
          <Text style={{ fontSize: 13, lineHeight: 18, color: p.accent }}>{err}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="重试全局搜索" hitSlop={6}
            onPress={() => fetchPage(q, null, false)} style={({ pressed }) => ({ alignSelf: 'flex-start', opacity: pressed ? 0.7 : 1 })}>
            <Text style={{ fontSize: 13, fontWeight: '500', color: p.link }}>重试</Text>
          </Pressable>
        </View>
      ) : messages.length === 0 ? (
        <Text style={{ fontSize: 13, color: p.muted, paddingHorizontal: 16, paddingVertical: 12 }}>
          未找到包含 {q} 的公开消息
        </Text>
      ) : (
        <View>
          {messages.map((msg) => {
            const meta = chatMetaOf(msg);
            const snippet = msgSnippet(msg) || '(无文本内容)';
            return (
              <Pressable
                key={String(msg.peerKey) + ':' + String(msg.id)}
                accessibilityRole="button"
                accessibilityLabel={'打开消息所在的对话 ' + meta.name}
                onPress={() => { if (typeof onOpenMessage === 'function') onOpenMessage(msg); }}
                style={({ pressed }) => ({
                  flexDirection: 'row', alignItems: 'center', gap: 12,
                  paddingHorizontal: 16, paddingVertical: 9, opacity: pressed ? 0.7 : 1,
                })}
              >
                <TgAvatar uri={meta.avatar} name={meta.name} seed={msg.peerKey} size={40} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 14, fontWeight: '500', color: p.foreground }}>
                      {meta.name}
                    </Text>
                    <Text numberOfLines={1} style={{ fontSize: 11, color: p.muted, includeFontPadding: false }}>
                      {fmtChatDate(msg.date)}
                    </Text>
                  </View>
                  <Text numberOfLines={1} style={{ marginTop: 2, fontSize: 12, color: p.muted }}>{snippet}</Text>
                </View>
              </Pressable>
            );
          })}
          {!completed && cursor ? (
            <View>
              {/* 翻页失败:已载结果保留,错误原文 + 显式重试(绝不自动重试) */}
              {err && phase === 'done' ? (
                <Text style={{ fontSize: 12, lineHeight: 17, color: p.accent, paddingHorizontal: 16, paddingVertical: 4 }}>
                  {err}
                </Text>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="加载更多全局搜索结果"
                disabled={moreBusy}
                onPress={() => fetchPage(q, cursor, true)}
                style={({ pressed }) => ({ paddingVertical: 12, alignItems: 'center', opacity: pressed || moreBusy ? 0.6 : 1 })}
              >
                {moreBusy ? (
                  <ActivityIndicator size="small" color={p.link} />
                ) : (
                  <Text style={{ fontSize: 13, fontWeight: '500', color: p.link }}>加载更多结果</Text>
                )}
              </Pressable>
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}
