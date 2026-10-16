// ============================================================================
// SelectionBar.jsx —— 多选动作条（M4·页面-菜单动作,蓝图二 §5.1-C）
// ----------------------------------------------------------------------------
// 多选态在输入区位置浮出的动作条（TI ChatControllerSelectionView 的
// panel 等价件裁剪版）:全选（已载窗口）/ 转发（多条,进 ForwardPanel）/
// 删除（多条）/ 退出多选。纯展示组件:数据与动作全部 props 注入。
//   { count,      选中条数（>0 才有意义,由装配方条件渲染）
//     busy,       删除/转发等动作在途（防连点,按钮置灰）
//     onForward,  () => void   多条转发入口
//     onDelete,   () => void   多条删除入口（确认弹层由装配方承载）
//     onSelectAll,() => void   全选已载窗口
//     onExit,     () => void   退出多选
//   }
// 取色 usePalette 语义键;a11y:容器 role=toolbar,逐钮 accessibilityLabel。
// 蓝图二 §3.3 Select/Select All/§5.4「SelectionBar『转发』（多条）」的装配落点;
// 反应(reactions)按蓝图裁剪(§3.3,三处端点缺口)。
// ============================================================================
import { Text, View } from 'react-native';
import { usePalette } from '../ui/palette.js';
import Button from '../ui/Button.jsx';
import { Check, Close, Send, Trash } from '../icons.js';

export default function SelectionBar({ count, busy = false, onSelectAll, onForward, onDelete, onExit }) {
  const p = usePalette();
  return (
    <View
      accessibilityRole="toolbar"
      accessibilityLabel={'已选中 ' + count + ' 条消息'}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 12,
        backgroundColor: p.surface,
        borderWidth: 1,
        borderColor: p.line,
      }}
    >
      <Text style={{ fontSize: 13, fontWeight: '600', color: p.foreground, includeFontPadding: false }}>
        已选 {count} 条
      </Text>
      <View style={{ flex: 1 }} />
      <Button variant="ghost" size="sm" onPress={onSelectAll} disabled={busy} accessibilityLabel="全选已载消息">
        <Check size={13} color={p.foreground} />
        <Text style={{ fontSize: 12, color: p.foreground }}>全选</Text>
      </Button>
      <Button variant="secondary" size="sm" onPress={onForward} disabled={busy} accessibilityLabel="转发选中消息">
        <Send size={13} color={p.foreground} />
        <Text style={{ fontSize: 12, color: p.foreground }}>转发</Text>
      </Button>
      <Button variant="secondary" size="sm" onPress={onDelete} disabled={busy} accessibilityLabel="删除选中消息">
        <Trash size={13} color={p.accent} />
        <Text style={{ fontSize: 12, color: p.accent }}>删除</Text>
      </Button>
      <Button variant="ghost" size="icon" onPress={onExit} accessibilityLabel="退出多选">
        <Close size={16} color={p.muted} />
      </Button>
    </View>
  );
}
