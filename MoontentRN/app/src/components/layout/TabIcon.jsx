// ============================================================================
// TabIcon.jsx —— 导航 Tab 图标（激活态填充形 + 切换动画）
// ----------------------------------------------------------------------------
// 线性（未激活）↔ 填充（激活）为 Solar 同形 linear/bold 对照；切换时双图标
// 交叉淡切（160ms），激活侧另加一次弹跳（scale 0.82→1 轻量 spring）。
// BottomNav 底栏与 Guide 侧栏（含迷你轨）共用；首挂不弹跳（避免整页进场
// 时激活槽多余跳动），仅状态翻转时动画。RN 内置 Animated，无新增依赖。
// ============================================================================
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Platform } from 'react-native';

function TabIcon({ active, icon: Icon, iconActive: IconSolid, size = 24, color, activeColor }) {
  const fade = useRef(new Animated.Value(active ? 1 : 0)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const firstMount = useRef(true);

  useEffect(() => {
    if (firstMount.current) {
      firstMount.current = false; // 首挂：fade 初值已对齐 active，不动画
      return;
    }
    Animated.timing(fade, {
      toValue: active ? 1 : 0,
      duration: 160,
      easing: Easing.out(Easing.quad),
      useNativeDriver: Platform.OS !== 'web',
    }).start();
    if (active) {
      scale.setValue(0.82);
      Animated.spring(scale, {
        toValue: 1,
        speed: 22,
        bounciness: 6,
        useNativeDriver: Platform.OS !== 'web',
      }).start();
    }
  }, [active, fade, scale]);

  return (
    <Animated.View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center', transform: [{ scale }] }}>
      <Icon size={size} color={color} />
      <Animated.View
        style={{ position: 'absolute', top: 0, left: 0, width: size, height: size, alignItems: 'center', justifyContent: 'center', opacity: fade, pointerEvents: 'none' }}
      >
        <IconSolid size={size} color={activeColor ?? color} />
      </Animated.View>
    </Animated.View>
  );
}

export default React.memo(TabIcon);
