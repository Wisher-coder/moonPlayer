// ============================================================================
// PollCard.jsx —— Telegram 投票/测验卡（气泡内媒体卡）
// ----------------------------------------------------------------------------
// 数据契约（归一化消息对象的 media.poll）：
//   { id, question, options: [{ text, option(base64) }],
//     results: { total, per: [{ option, voters, chosen, correct }], solution },
//     closed, multipleChoice, quiz }
// 交互：
//   · 未投且未关闭（且页面给了 onVote）→ 可投票：单选点选项即投
//     onVote([optionBase64])；多选本地勾选 + 「投票」确认钮 → onVote([.., ..])；
//   · 已投（results.per 任一项 chosen）或已关闭 → 结果态：票数条 + 百分比，
//     quiz 的 correct 项品牌红高亮、chosen 项打勾；
//   · quiz 带 solution（解析）时折叠展示，「查看解析」切换。
// onVote 返回 Promise 时按钮进入 busy 防连点，resolve/reject 后恢复（页面
// 投票失败会保留原消息，用户可重点）；同步返回则立即恢复（页面乐观更新）。
// 纯展示组件：投票动作完全由页面注入，组件不发任何请求。
// ============================================================================
import { memo, useCallback, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Check, Poll } from '../icons.js';
import { usePalette } from '../ui/palette.js';
import usePressVisual from '../../lib/use-press-visual.js';
import Spinner from '../ui/Spinner.jsx';
import { toneColors } from './chat-helpers.js';
import { FSM_DENSE, FSM_META } from '../../lib/text-fit.js';

// 选项行（结果态）：进度条 + 文案 + 百分比；chosen/correct 标记
function ResultRow({ label, percent, chosen, correct, tc, p }) {
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text
          numberOfLines={2}
          maxFontSizeMultiplier={FSM_DENSE}
          style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 18, color: correct ? p.accent : tc.fg, fontWeight: correct || chosen ? '600' : '400', includeFontPadding: false }}
        >
          {label}
        </Text>
        {/* 勾选标记：chosen=本人所投（交互蓝），correct=测验正确答案（品牌红）；
            同时候选时正确答案红勾优先（已投对/投错一目了然） */}
        {chosen || correct ? (
          <Check size={13} color={correct ? p.accent : tc.out ? tc.fg : p.link} />
        ) : null}
        <Text
          maxFontSizeMultiplier={FSM_META}
          style={{ fontSize: 12, color: tc.dim, opacity: tc.dimOpacity, fontVariant: ['tabular-nums'], includeFontPadding: false }}
        >
          {percent + '%'}
        </Text>
      </View>
      {/* 票数条：底轨 tc.track；填充 chosen=交互蓝 / correct=品牌红 / 普通=前景弱化 */}
      <View style={{ height: 6, borderRadius: 3, backgroundColor: tc.track, overflow: 'hidden' }}>
        <View
          style={{
            width: percent + '%',
            height: '100%',
            borderRadius: 3,
            backgroundColor: correct ? p.accent : chosen ? (tc.out ? tc.fg : p.link) : tc.fg,
            opacity: correct || chosen ? 1 : 0.22,
          }}
        />
      </View>
    </View>
  );
}

// 可投票选项行（单选/多选共用壳，多选带勾选框位）
function VoteRow({ label, checked, multiple, tc, onPress, aLabel }) {
  const p = usePalette();
  const hv = usePressVisual();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={aLabel}
      onPress={onPress}
      {...hv.binds}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: checked ? (tc.out ? tc.fg : p.link) : tc.track,
          backgroundColor: checked ? tc.card : 'transparent',
          paddingHorizontal: 10,
          height: 34,
        },
        { opacity: hv.pressed ? 0.8 : 1 },
      ]}
    >
      {/* 多选勾选框：实心=已选；单选空心圆点示意 */}
      <View
        style={{
          width: 16,
          height: 16,
          borderRadius: multiple ? 4 : 8,
          borderWidth: 1.5,
          borderColor: checked ? (tc.out ? tc.fg : p.link) : tc.dim,
          backgroundColor: checked ? (tc.out ? tc.fg : p.link) : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked ? <Check size={11} color={tc.out ? p.link : p.background} /> : null}
      </View>
      <Text numberOfLines={1} maxFontSizeMultiplier={FSM_DENSE} style={{ flex: 1, minWidth: 0, fontSize: 13, color: tc.fg, includeFontPadding: false }}>
        {label}
      </Text>
    </Pressable>
  );
}

function PollCard({ poll, tone = 'in', onVote, style }) {
  const p = usePalette();
  const tc = toneColors(p, tone);
  const [picked, setPicked] = useState(() => new Set()); // 多选本地勾选（选项下标）
  const [busy, setBusy] = useState(false);    // 投票请求在途（防连点）
  const [showSolution, setShowSolution] = useState(false); // quiz 解析折叠态
  const submitHv = usePressVisual(); // 多选「投票」确认钮视觉态（钩子须顶层：按钮按态条件渲染）

  const data = poll || {};
  // options 缓存（useMemo）：提交回调的 useCallback 依赖它，避免每帧换引用
  const options = useMemo(
    () => (Array.isArray(data.options) ? data.options : []),
    [data.options]
  );
  const results = data.results || {};
  const per = Array.isArray(results.per) ? results.per : [];
  const total = Math.max(0, Math.floor(Number(results.total) || 0));
  const chosenAny = per.some((x) => x && x.chosen);
  const closed = !!data.closed;
  const quiz = !!data.quiz;
  const multiple = !!data.multipleChoice;
  // 结果判定：已投或已关闭都出结果条（Telegram 口径：投票不可撤销）
  const showResults = closed || chosenAny;
  const canVote = !showResults && typeof onVote === 'function';

  // 投票动作：busy 在 onVote 返回 Promise 时等它落定；同步返回立即恢复
  const vote = useCallback(
    (opts) => {
      if (busy || !opts || !opts.length) return;
      setBusy(true);
      let r = null;
      try {
        r = onVote(opts);
      } catch (_e) {
        setBusy(false); // 同步抛错：恢复可点（页面自行提示）
        return;
      }
      if (r && typeof r.then === 'function') {
        r.finally(() => setBusy(false));
      } else {
        setBusy(false);
      }
    },
    [busy, onVote]
  );

  // 单选：点选项即投
  const voteSingle = useCallback(
    (opt) => { if (!busy) vote([opt]); },
    [busy, vote]
  );

  // 多选：勾选/去选 + 底部确认钮提交
  const togglePick = useCallback((idx) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);
  const submitMulti = useCallback(() => {
    const opts = options.filter((_, i) => picked.has(i)).map((o) => o && o.option).filter((x) => x != null);
    if (!opts.length) return;
    vote(opts);
    setPicked(new Set()); // 提交后清勾选（成功则换结果态，失败重来也是干净态）
  }, [options, picked, vote]);

  // 选项文案：per 与 options 按_option 基串对齐（服务端契约:两者同为 base64）
  const perByOption = new Map();
  for (const r of per) if (r && r.option != null) perByOption.set(String(r.option), r);
  const percentOf = (opt) => {
    if (total <= 0) return 0;
    const r = perByOption.get(String(opt));
    const v = Math.max(0, Math.floor(Number(r && r.voters) || 0));
    return Math.round((v / total) * 100);
  };

  return (
    <View
      style={[
        { borderRadius: 10, backgroundColor: tc.card, padding: 10, gap: 10, minWidth: 220, maxWidth: 280 },
        style,
      ]}
    >
      {/* 头部：投票图标 + 问题 + 徽标（测验/多选/已结束） */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
        <View style={{ width: 20, alignItems: 'center', marginTop: 1 }}>
          <Poll size={16} color={tc.dim} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <Text maxFontSizeMultiplier={FSM_DENSE} style={{ fontSize: 14, fontWeight: '600', lineHeight: 19, color: tc.fg, includeFontPadding: false }}>
            {data.question || '(无题投票)'}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
            {quiz ? <BadgeChip text="测验" tc={tc} /> : null}
            {multiple ? <BadgeChip text="多选" tc={tc} /> : null}
            {closed ? <BadgeChip text="已结束" tc={tc} /> : null}
          </View>
        </View>
      </View>

      {/* 选项区：结果态票数条 / 可投票态点选 */}
      <View style={{ gap: 6 }}>
        {options.map((o, i) => {
          const label = (o && o.text) || '(空选项)';
          if (!canVote) {
            const r = perByOption.get(String(o && o.option)) || {};
            return (
              <ResultRow
                key={i}
                label={label}
                percent={percentOf(o && o.option)}
                chosen={!!r.chosen}
                correct={quiz && !!r.correct}
                tc={tc}
                p={p}
              />
            );
          }
          return (
            <VoteRow
              key={i}
              label={label}
              checked={picked.has(i)}
              multiple={multiple}
              tc={tc}
              aLabel={multiple ? '勾选选项 ' + label : '投给 ' + label}
              onPress={multiple ? () => togglePick(i) : () => voteSingle(o && o.option)}
            />
          );
        })}
        {/* 多选确认钮：本地勾选 ≥1 才可提交；在途出 spinner 防连点 */}
        {canVote && multiple ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="提交投票"
            disabled={busy || picked.size === 0}
            onPress={submitMulti}
            {...submitHv.binds}
            style={[
              {
                height: 32,
                borderRadius: 8,
                alignItems: 'center',
                justifyContent: 'center',
                flexDirection: 'row',
                gap: 6,
                backgroundColor: tc.out ? 'rgba(0,0,0,0.18)' : p.background,
                borderWidth: 1,
                borderColor: tc.out ? tc.fg : p.link,
              },
              { opacity: busy || picked.size === 0 ? 0.5 : 1 },
            ]}
          >
            {busy ? <Spinner size={13} color={tc.fg} /> : null}
            <Text style={{ fontSize: 13, fontWeight: '500', color: tc.out ? tc.fg : p.link, includeFontPadding: false }}>
              {busy ? '投票中…' : '投票（已选 ' + picked.size + ' 项）'}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {/* 底部 meta：总票数（可投票态提示点选投票） */}
      <Text maxFontSizeMultiplier={FSM_META} style={{ fontSize: 11, color: tc.dim, opacity: tc.dimOpacity, includeFontPadding: false }}>
        {canVote
          ? (multiple ? '勾选后点「投票」提交' : '点击选项即可投票') + (total > 0 ? ' · 已有 ' + total + ' 人投票' : '')
          : total > 0 ? '共 ' + total + ' 人投票' : '暂无投票'}
      </Text>

      {/* quiz 解析折叠（结果态且有 solution 才出） */}
      {quiz && !canVote && results.solution ? (
        <View style={{ gap: 6 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={showSolution ? '收起解析' : '查看解析'}
            onPress={() => setShowSolution((v) => !v)}
            hitSlop={4}
          >
            {({ hovered }) => (
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: '500',
                  alignSelf: 'flex-start',
                  color: hovered ? tc.fg : (tc.out ? tc.fg : p.link),
                  opacity: hovered ? 1 : 0.9,
                  includeFontPadding: false,
                }}
              >
                {showSolution ? '收起解析' : '查看解析'}
              </Text>
            )}
          </Pressable>
          {showSolution ? (
            <View style={{ borderRadius: 8, backgroundColor: tc.track, paddingHorizontal: 8, paddingVertical: 6 }}>
              <Text style={{ fontSize: 12, lineHeight: 17, color: tc.fg }}>{results.solution}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// 小徽标 chip（测验/多选/已结束）：中性底 + 次级字（KindBadge 同款形态）
function BadgeChip({ text, tc }) {
  return (
    <View style={{ borderRadius: 4, backgroundColor: tc.track, paddingHorizontal: 5, paddingVertical: 1 }}>
      <Text style={{ fontSize: 10, lineHeight: 14, color: tc.dim, opacity: tc.dimOpacity, includeFontPadding: false }}>
        {text}
      </Text>
    </View>
  );
}

export default memo(PollCard);
