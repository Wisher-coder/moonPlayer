// ============================================================================
// ContextMenu.jsx —— 通用长按菜单容器（M4·页面-菜单动作，蓝图二 §5.1-A）
// ----------------------------------------------------------------------------
// 契约（纯受控，消息菜单/会话行菜单/调试菜单共用）：
//   <ContextMenu visible={bool} onClose={fn} items={[…]} />
//   items: [{ key, label, icon?, destructive?, disabled?, onPress } | 'sep']
//     · icon：图标名串，经下方 MENU_ICONS 注册表解析为 icons.js 生成件
//       （Solar 图标桶，勿手改 icons.js）；未知名/缺省 = 无图标（占位槽保留，
//       行仍对齐）。菜单项目录侧的键名在 lib/telegram-actions/message-menu.js，
//       两处键名须同步。
//     · destructive=true → 品牌红（p.accent；TI textColor destructive 映射）；
//       disabled=true → 置灰不可点（TI disabled 置灰）。
//     · 'sep' 字符串 → 1px 分隔线（ContextMenuItem = action | separator）。
// TI 映射与裁剪（蓝图二 §3.5）：ContextMenuActionItem 的 text→label（中文）、
//   icon 闭包→icons.js 生成件、badge/textLayout(twoLinesMax)/animationName
//   (Lottie) v1 不移植；custom node 协议裁剪；液态变形菜单与 take/put-back
//   抽取预览（ReferenceViewInfo）裁剪——RN 无共享元素转场管道，等价为常规
//   长按菜单（§0.1-1）。
// 形态：居中 Modal + 遮罩淡入（既有 MessageBubble 内建菜单 Modal 形态
//   :342-359 升级为通用容器）；长按触发源 = MessageBubble 长按外抛
//   onLongPress(msg)（M2；未注入时气泡退内建菜单，向后兼容）。装配链
//   （M1，蓝图二 §5.1-C）：
//     MessageBubble onLongPress(msg)
//       → 多选态：toggleSelect(msg.id)
//       → 否则 setMenuTarget(msg)
//       → <ContextMenu visible items={buildMessageMenuFor(msg, ctx, actions)} />
//   遮罩点击 / Android 返回键（onRequestClose）关闭；项点按先 onClose 再执行
//   动作（TI 语义：菜单先收起，动作在宿主面上进行）。
// 取色 usePalette 语义键（亮暗双主题）；a11y：容器 role=menu、项 role=menuitem
//   且逐项 accessibilityLabel；超长项列表内滚动（height 60% 上限）。
// ============================================================================
import { memo } from 'react';
import { Dimensions, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { usePalette, SCRIM_BG } from '../../ui/palette.js';
import usePressVisual from '../../../lib/use-press-visual.js';
import {
  Reply, Copy, Send, Trash, Check, Restart, Close,
  Pin, PinSolid, VolumeOff, VolumeUp, Inbox, Layers,
  Globe, Monitor, User, Search, Clock, Keyboard,
} from '../../icons.js';

// 图标名 → icons.js 生成件注册表（与 message-menu.js 的 icon 键名同步）
const MENU_ICONS = {
  reply: Reply,        // 回复
  copy: Copy,          // 复制（文本/链接/号码/提及）
  forward: Send,       // 转发（纸飞机，Telegram 通用转发/分享语义）
  delete: Trash,       // 删除（消息/对话）
  select: Check,       // 多选
  retry: Restart,      // 重新发送
  cancel: Close,       // 取消发送
  pin: Pin,            // 置顶
  unpin: PinSolid,     // 取消置顶（实心区分）
  mute: VolumeOff,     // 静音
  unmute: VolumeUp,    // 取消静音
  markUnread: Inbox,   // 标记为未读
  markRead: Check,     // 标记为已读
  archive: Layers,     // 归档
  link: Globe,         // 打开链接
  external: Monitor,   // 外部打开
  user: User,          // 打开对话（@提及）
  search: Search,      // 会话内搜索
  global: Globe,       // 全局搜索
  calendar: Clock,     // 在日历中打开（无日历类生成图标，取时钟近似）
  command: Keyboard,   // 填入输入框（/命令）
};

const CARD_MAX_W = 270;               // 菜单卡最大宽（既有气泡内建菜单 260 的同档）
const ITEM_H = 44;                    // 项行高（iOS 上下文菜单档位）
const LIST_MAX_RATIO = 0.6;           // 项过多时滚动上限占窗口高比例

// —— 菜单项行：图标槽 + 文案（hover 灰面 / 按压透明度，视觉态经钩子）——
function MenuRow({ item, onClose }) {
  const p = usePalette();
  const hv = usePressVisual();
  const Icon = MENU_ICONS[item.icon];
  const color = item.disabled ? p.muted : (item.destructive ? p.accent : p.foreground);
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityLabel={item.label}
      accessibilityState={item.disabled ? { disabled: true } : undefined}
      disabled={!!item.disabled}
      onPress={() => {
        if (item.disabled) return;
        onClose();
        if (typeof item.onPress === 'function') item.onPress();
      }}
      {...hv.binds}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          height: ITEM_H,
          borderRadius: 10,
          paddingHorizontal: 12,
        },
        { backgroundColor: hv.hovered ? p.surface2 : 'transparent', opacity: hv.pressed ? 0.8 : 1 },
      ]}
    >
      <View style={{ width: 22, alignItems: 'center' }}>
        {Icon ? <Icon size={19} color={color} /> : null}
      </View>
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 15, color, includeFontPadding: false }}>
        {item.label}
      </Text>
    </Pressable>
  );
}

function ContextMenu({ visible, onClose, items }) {
  const p = usePalette();
  const list = Array.isArray(items) ? items : [];
  const maxH = Math.round(Dimensions.get('window').height * LIST_MAX_RATIO);
  if (!visible || !list.length) return null;
  return (
    <Modal
      transparent
      animationType="fade"
      statusBarTranslucent
      supportedOrientations={['portrait', 'landscape']}
      onRequestClose={onClose}
    >
      {/* 遮罩：点击空白关闭（中心菜单卡上的触摸被吃掉，不透传关闭） */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="关闭菜单"
        onPress={onClose}
        style={{ flex: 1, backgroundColor: SCRIM_BG, alignItems: 'center', justifyContent: 'center', padding: 24 }}
      >
        <Pressable
          onStartShouldSetResponder={() => true}
          accessibilityRole="menu"
          style={{
            width: '100%',
            maxWidth: CARD_MAX_W,
            borderRadius: 14,
            backgroundColor: p.surface,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: p.line,
            paddingVertical: 6,
            shadowColor: '#000',
            shadowOpacity: 0.18,
            shadowRadius: 18,
            shadowOffset: { width: 0, height: 6 },
            elevation: 12,
          }}
        >
          <ScrollView style={{ maxHeight: maxH }} nestedScrollEnabled bounces={false} showsVerticalScrollIndicator={false}>
            {list.map((it, i) => {
              if (it === 'sep' || (it && typeof it === 'object' && it.sep)) {
                return (
                  <View
                    key={'sep' + i}
                    style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.line, marginHorizontal: 12, marginVertical: 5 }}
                  />
                );
              }
              if (!it || typeof it !== 'object') return null;
              return <MenuRow key={(it && it.key) || 'item' + i} item={it} onClose={onClose} />;
            })}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export default memo(ContextMenu);
