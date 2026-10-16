// ============================================================================
// InlineKeyboard.jsx —— Telegram bot 内联键盘（气泡下方按钮组）
// ----------------------------------------------------------------------------
// 数据契约（归一化消息对象的 inlineKeyboard）：
//   [[{ type: 'callback'|'url'|'copy'|'game'|'unknown', text,
//       data?(base64), url?, copy?, password? }]] —— 外层数组=行，行内按钮
//   等宽并排（Telegram 布局），多行上下堆叠。
// 行为：
//   · callback → onCallback({ data, password? })——页面负责 POST /callback 并
//     用返回的更新消息重渲；onCallback 返回 Promise 时该按钮进入 loading
//     防连点，落定后恢复；
//   · game    → onCallback({ game: true })（同 callback 通道）；
//   · url     → onUrl(url) 页面接管（t.me/tg:// 深链应用内跳转等）；缺省
//               Linking.openURL（失败轻提示）；
//   · copy    → expo-clipboard 写入剪贴板 + 轻提示「已复制」；
//   · unknown → 灰显禁用（新按钮类型未支持时的安全兜底）。
// 纯展示组件：callback 动作全部由页面注入，组件不发请求。
// ============================================================================
import { memo, useCallback, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { usePalette } from '../ui/palette.js';
import usePressVisual from '../../lib/use-press-visual.js';
import Spinner from '../ui/Spinner.jsx';
import { useHint } from './HintPill.jsx';
import { toneColors } from './chat-helpers.js';
import { FSM_DENSE } from '../../lib/text-fit.js';

// 单按钮：行内等宽（flex:1），busy 出小 spinner 防连点
function InlineBtn({ btn, flex, tone, busy, onPress, onHint }) {
  const p = usePalette();
  const tc = toneColors(p, tone);
  const hv = usePressVisual();
  const { overlay } = useHint(onHint); // show 未用（url/copy 动作在父级统一处理）
  const unknown = !btn || btn.type === 'unknown' || !btn.text;
  const dimmed = unknown || busy;

  // url：直接系统打开（失败轻提示，不自动重试）
  const handle = useCallback(() => {
    if (dimmed || typeof onPress !== 'function') return;
    onPress();
  }, [dimmed, onPress]);

  // 各类型的实际动作由父级注入 onPress；url/copy 在本组件内就地处理时
  // 也统一走 onPress 回调（见 InlineKeyboard 组装），保持一处状态机

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={unknown ? '暂不支持的内联按钮 ' + ((btn && btn.text) || '') : (btn && btn.text) || '内联按钮'}
      disabled={dimmed}
      onPress={handle}
      {...hv.binds}
      style={[
        {
          position: 'relative',
          flex: flex == null ? 1 : flex,
          minWidth: 0,
          height: 34,
          borderRadius: 8,
          backgroundColor: tc.card,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: 6,
          paddingHorizontal: 8,
        },
        { opacity: dimmed ? 0.5 : hv.pressed ? 0.8 : 1 },
      ]}
    >
      {busy ? <Spinner size={12} color={tc.fg} /> : null}
      <Text numberOfLines={1} maxFontSizeMultiplier={FSM_DENSE} style={{ flexShrink: 1, fontSize: 13, fontWeight: '500', color: unknown ? tc.dim : tc.fg, includeFontPadding: false }}>
        {(btn && btn.text) || '(空按钮)'}
      </Text>
      {overlay}
    </Pressable>
  );
}

function InlineKeyboard({ rows, tone = 'in', onCallback, onUrl, onHint, style }) {
  const { show } = useHint(onHint);
  // 在途按钮键集（'r-c'），callback 的 Promise 落定后摘除（防连点）
  const [busyKeys, setBusyKeys] = useState(() => new Set());

  // callback/game 动作：页面回调优先返回 Promise；同步返回立即摘忙
  const runCallback = useCallback(
    (payload, key) => {
      if (busyKeys.has(key) || typeof onCallback !== 'function') return;
      setBusyKeys((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      let r = null;
      try {
        r = onCallback(payload);
      } catch (_e) {
        setBusyKeys((prev) => { const n = new Set(prev); n.delete(key); return n; });
        return;
      }
      if (r && typeof r.then === 'function') {
        r.finally(() => {
          setBusyKeys((prev) => { const n = new Set(prev); n.delete(key); return n; });
        });
      } else {
        setBusyKeys((prev) => { const n = new Set(prev); n.delete(key); return n; });
      }
    },
    [busyKeys, onCallback]
  );

  // url：onUrl 页面接管（应用内跳转分流）；缺省系统打开
  const openUrl = useCallback(
    (url) => {
      if (typeof onUrl === 'function') {
        onUrl(String(url == null ? '' : url));
        return;
      }
      Linking.openURL(String(url || '')).catch(() => show('无法打开链接'));
    },
    [onUrl, show]
  );
  // copy：剪贴板写入 + 轻提示
  const doCopy = useCallback(
    async (text) => {
      try {
        await Clipboard.setStringAsync(String(text == null ? '' : text));
        show('已复制');
      } catch (_e) {
        show('复制失败');
      }
    },
    [show]
  );

  if (!Array.isArray(rows) || rows.length === 0) return null;

  return (
    <View style={[{ gap: 4 }, style]}>
      {rows.map((row, r) =>
        Array.isArray(row) && row.length > 0 ? (
          <View key={r} style={{ flexDirection: 'row', gap: 4 }}>
            {row.map((btn, c) => {
              const key = r + '-' + c;
              const type = btn && btn.type;
              let onPress = null;
              if (type === 'callback') onPress = () => runCallback({ data: btn.data, password: btn.password }, key);
              else if (type === 'game') onPress = () => runCallback({ game: true }, key);
              else if (type === 'url') onPress = () => openUrl(btn.url);
              else if (type === 'copy') onPress = () => doCopy(btn.copy != null ? btn.copy : btn.text);
              return (
                <InlineBtn
                  key={key}
                  btn={btn}
                  tone={tone}
                  busy={busyKeys.has(key)}
                  onPress={onPress}
                  onHint={onHint}
                />
              );
            })}
          </View>
        ) : null
      )}
    </View>
  );
}

export default memo(InlineKeyboard);
