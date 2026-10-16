// ============================================================================
// 骨架屏 —— ui 八原语之一
// ----------------------------------------------------------------------------
// 从 NextWeb src/components/ui/skeleton.jsx 移植：呼吸式占位块（Tailwind
// animate-pulse 语义），尺寸形状由调用方经 style/className 决定；默认 surface-2
// 底、8px 圆角。透明度呼吸用 RN 内置 Animated 循环，三端通吃。
import { memo, useEffect, useRef } from 'react';
import {Platform, Animated} from 'react-native';
import { usePalette } from './palette.js';

function Skeleton({ style }) {
  const p = usePalette();
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    // animate-pulse 语义：1 ↔ 0.55 往返循环（2s 节奏，与 Tailwind 默认档一致）
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.55, duration: 1000, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(pulse, { toValue: 1, duration: 1000, useNativeDriver: Platform.OS !== 'web' }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [pulse]);
  return (
    <Animated.View
      style={[
        {
          borderRadius: 8,
          backgroundColor: p.surface2,
          opacity: pulse,
        },
        style,
      ]}
    />
  );
}

export default memo(Skeleton);
