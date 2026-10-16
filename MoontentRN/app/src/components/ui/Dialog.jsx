// ============================================================================
// 对话框 —— ui 八原语之一
// ----------------------------------------------------------------------------
// 从 NextWeb src/components/ui/dialog.jsx 移植（Radix Dialog → RN Modal）：
// 居中卡片 + 半透明黑遮罩，自带右上角关闭钮；点遮罩关闭；Android 返回键
// 经 onRequestClose 关闭。
// 契约 props：{ visible, onClose, title, children }——受控可见态，标题 16px/600，
// 内容随意；其余 props 只增不减。
import { memo, useEffect, useState } from 'react';
import { Modal, Pressable, Text } from 'react-native';
import { Close } from '../icons.js';
import { usePalette } from './palette.js';
import GlassSurface from './GlassSurface.jsx';
import { useGlassEnabled } from '../../lib/glass.js';
import { RADIUS } from '../../lib/higlass.js';
import usePressVisual from '../../lib/use-press-visual.js';

function Dialog({ visible, onClose, title, children, style, maxWidth = 448 }) {
  const p = usePalette();
  const closeHv = usePressVisual(); // 关闭钮视觉态（布局静态化，安卓样式函数陷阱）
  // iOS 26 玻璃卡片：Modal 的 fade 过渡把整层（玻璃的祖先）opacity 从 0 起动
  // 画——撞玻璃 opacity=0 禁区（效果永久失效），玻璃态改无动画直出；降级端
  // fade 原样
  const glass = useGlassEnabled();
  // 玻璃端入场 materialize（HIG：显隐靠调制折光而非 opacity）：Modal 挂载后
  // 下一拍把 glassEffectStyle 从 'none' 切到目标样式（animate），玻璃物化而入；
  // 退场仍随 Modal 卸载（RN Modal 无退出钩子，不做退场动画）。降级端 shown
  // 恒 undefined（不走 null 分支，视觉原样）
  const [materialized, setMaterialized] = useState(false);
  useEffect(() => {
    if (!visible) { setMaterialized(false); return undefined; }
    const t = setTimeout(() => setMaterialized(true), 30);
    return () => clearTimeout(t);
  }, [visible]);
  return (
    <Modal visible={!!visible} transparent animationType={glass ? 'none' : 'fade'} onRequestClose={onClose} statusBarTranslucent>
      {/* 遮罩：半透明黑（YouTube 弹层遮罩档），点按即关闭 */}
      <Pressable
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.7)',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24, // 92vw 语义：小屏两侧各留 24px
        }}
      >
        {/* 卡片：包一层 Pressable 挡住遮罩的点按关闭；iOS 26 玻璃端卡片为
            regular 玻璃（colorScheme 跟应用主题，HIG：alert/sheet 归 Regular
            变体；圆角加大到 RADIUS.dialog——HIG 新设计更圆的弹层圆角），
            降级端 surface 面原样 */}
        <Pressable
          onStartShouldSetResponder={() => true} // 吃掉落在卡片上的触摸，不透传给遮罩
          style={[{ width: '100%', maxWidth }, style]}
        >
          <GlassSurface
            style={{ borderRadius: 16, padding: 24 }}
            glassOnlyStyle={{ borderRadius: RADIUS.dialog }}
            fallbackStyle={{ backgroundColor: p.surface }}
            shown={glass ? materialized : undefined}
          >
            {title != null ? (
              <Text style={{ color: p.foreground, fontSize: 16, fontWeight: '600', marginBottom: 16, includeFontPadding: false }}>
                {title}
              </Text>
            ) : null}
            {children}
            {/* 右上角关闭：ghost 风格小方块（hover 才出灰面，web only） */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭"
              onPress={onClose}
              {...closeHv.binds}
              style={[
                { position: 'absolute', right: 16, top: 16, width: 28, height: 28, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
                { backgroundColor: closeHv.hovered ? p.surface2 : 'transparent' },
              ]}
            >
              <Close size={16} color={p.muted} />
            </Pressable>
          </GlassSurface>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export default memo(Dialog);
