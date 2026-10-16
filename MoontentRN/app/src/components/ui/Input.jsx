// ============================================================================
// 输入框 —— ui 八原语之一
// ----------------------------------------------------------------------------
// 从 NextWeb src/components/ui/input.jsx 移植：搜索框形态——1px line 描边 +
// 8px 圆角，聚焦转交互蓝描边（link 语义位）；字号三端统一 16px：
// react-native-web 在 iOS Safari 上对 font-size < 16px 的输入框聚焦时会自动
// 放大整页且失焦不复位（PWA/App 体验大忌），16px 是根治手段（NextWeb 侧
// text-base md:text-sm 的移动端档在这里三端一档到底）。
// 契约 props：无钉死必填项；ref 显式透传到 TextInput（聚焦控制方——如搜索页
// 的 useFocusEffect 主动 focus() 弹键盘）；其余 TextInput 原生 props（value/
// onChangeText/placeholder/onSubmitEditing/returnKeyType…）原样透传。
import { memo, useState } from 'react';
import { TextInput } from 'react-native';
import { usePalette } from './palette.js';

function Input({ style, onFocus, onBlur, disabled = false, ref, ...rest }) {
  const p = usePalette();
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={p.muted}
      editable={!disabled}
      onFocus={(e) => {
        setFocused(true);
        if (onFocus) onFocus(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        if (onBlur) onBlur(e);
      }}
      style={[
        {
          height: 36, // h-9
          borderRadius: 8,
          borderWidth: 1,
          borderColor: focused ? p.link : p.line,
          backgroundColor: p.surface,
          paddingHorizontal: 12,
          fontSize: 16, // 见文件头：防 iOS web 聚焦缩放的根治字号
          color: p.foreground,
          opacity: disabled ? 0.5 : 1,
          paddingVertical: 0, // 抹平安卓默认内边距，高度严格 36
        },
        style,
      ]}
      {...rest}
    />
  );
}

export default memo(Input);
