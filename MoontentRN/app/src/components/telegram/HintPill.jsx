// ============================================================================
// HintPill.jsx —— 组件内轻提示（消息组件族共用）
// ----------------------------------------------------------------------------
// RN 侧无全局 toast 设施（plugins.js / mine.js 都是页内自绘反馈条）；消息
// 组件族是纯展示件，不便各自养一套反馈条——这里统一为「气泡内轻提示」：
//   useHint(onHint?) → { show(msg), overlay }
//     · 页面传了 onHint(msg) 回调 → show 直接转发，由页面自己的 toast 承接
//       （推荐：聊天页通常已有页内提示条）；
//     · 未传 → 组件自管：show 置文案，overlay（绝对铺满 + 居中胶囊，
//       pointerEvents none 不挡交互）挂到组件根节点上，1.8s 自动消失。
// 定时器 setState 都在异步回调里（React Compiler 红线：effect 体内不得
// 同步 setState），卸载时清表。
// ============================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { BADGE_BG } from '../ui/palette.js';
import { FSM_META } from '../../lib/text-fit.js';
import { ABS_FILL } from '../../lib/abs-fill.js';

const HINT_MS = 1800; // 轻提示自动消失时长（页内 toast 同量级）

// 胶囊本体：黑底白字角标规格（与时长角标同款结构色，主题无关）
function HintPill({ text }) {
  return (
    <View
      style={{
        backgroundColor: BADGE_BG,
        borderRadius: 999,
        paddingHorizontal: 12,
        paddingVertical: 6,
        maxWidth: 260,
      }}
    >
      <Text
        numberOfLines={2}
        maxFontSizeMultiplier={FSM_META}
        style={{ color: '#ffffff', fontSize: 12, lineHeight: 17, includeFontPadding: false }}
      >
        {text}
      </Text>
    </View>
  );
}

// 轻提示钩子：见文件头注释
export function useHint(onHint) {
  const [text, setText] = useState('');
  const timer = useRef(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const show = useCallback(
    (msg) => {
      if (!msg) return;
      if (onHint) { onHint(msg); return; } // 页面自有 toast：直接转发
      setText(msg);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setText(''), HINT_MS);
    },
    [onHint]
  );

  // 覆盖层：铺满宿主自身盒（不越界、无跨层级裁切问题），居中胶囊不挡触摸
  const overlay = text ? (
    <View style={[ABS_FILL, { alignItems: 'center', justifyContent: 'center' }]} pointerEvents="none">
      <HintPill text={text} />
    </View>
  ) : null;

  return { show, overlay };
}

export default HintPill;
