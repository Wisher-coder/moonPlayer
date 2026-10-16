// ============================================================================
// 加载指示器 —— ui 八原语之一
// ----------------------------------------------------------------------------
// 从 NextWeb src/components/ui/spinner.jsx 移植：旋转的 Loader，
// 品牌红着色（accent 语义位，深浅同值），尺寸由 size 数字 prop 控制。
// 旋转用 RN 内置 Animated（loop + linear 插值），三端通吃、零原生依赖；
// 组件卸载时 Animated 循环随节点一起失效，无需手动停表。
import { useEffect, useRef } from 'react';
import {Platform, Animated, Easing} from 'react-native';
import { Loader } from '../icons.js';
import { usePalette } from './palette.js';

function Spinner({ size = 18, color, style }) {
  const p = usePalette();
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // 800ms 一圈、线性匀速（YouTube 系加载圈是匀速旋转，不做缓动）
    const anim = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 800,
        easing: Easing.linear,
        useNativeDriver: Platform.OS !== 'web', // transform 旋转可走原生驱动
      })
    );
    anim.start();
    return () => anim.stop();
  }, [spin]);
  return (
    <Animated.View
      accessibilityRole="progressbar"
      accessibilityLabel="加载中"
      style={[
        {
          width: size,
          height: size,
          transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }],
        },
        style,
      ]}
    >
      <Loader size={size} color={color || p.accent} />
    </Animated.View>
  );
}

export default Spinner;
