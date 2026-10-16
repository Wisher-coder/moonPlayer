// ============================================================================
// EpisodesOverlay.jsx —— 选集浮层（桌面控制条「选集」钮唤出，压在播放器之上）
// ----------------------------------------------------------------------------
// 形态对齐站方播放器（腾讯视频「选集」浮层）：贴着播放器右缘的半透明暗面板
//（恒深色 chrome 不随主题翻转）——头部「选集 · N 集」+ 关闭钮，正文 5 列序号
// 格（在播项整格半透明白提亮，与 PlayerPopup 当前项同语言——播放器整体去红
// 口径，弹层家族不出现品牌红），整块限高内滚。
// 数据/动作全由观看页持有（items=量贩/合集/剧集片单、currentId=在播会话 id、
// onPick=切集跳转），本组件只做呈现与开合，不发起任何请求。
// 渲染位：经 setDockOverlay('episodes', …) 注册进舞台（见 player-context 的
// PlayerStage 覆盖槽）——留在观看页里会被舞台 zIndex 压住，看得见点不到。
// ============================================================================
import { ScrollView, Pressable, Text, View } from 'react-native';
import { Close } from '../icons.js';
import GlassSurface from '../ui/GlassSurface.jsx';
import { PANEL_BG, ROW_ACTIVE_BG } from './PlayerPopup.jsx';
import { RADIUS } from '../../lib/higlass.js';

const TILE_W = 52; // 序号格宽（5 列 + 8px 间距 = 292，适配 340 面板宽）
const TILE_H = 40;

/**
 * @param {{ title?: string, items: Array<{id:any, title?:string}>, currentId?: any,
 *   bottomPad?: number,
 *   onPick: (item:object) => void, onClose: () => void }} props
 *   title：面板标题（片单名，可空）；items：选集条目（顺序即集号）；
 *   currentId：在播条目 id（命中即高亮）；onPick：点选回调（切集后由调用方收合）；
 *   bottomPad：下缘额外让位（沉浸态控制条被 Home 指示条安全区抬高时同步上移）
 */
export default function EpisodesOverlay({ title, items, currentId, bottomPad = 0, onPick, onClose }) {
  const list = Array.isArray(items) ? items : [];
  const cur = currentId == null ? '' : String(currentId);
  return (
    <GlassSurface
      glassStyle="regular"
      dark
      style={{
        position: 'absolute',
        right: 12,
        top: 12,
        // 下缘让开底部控制条(宽幅三行条约 88px;浮层唤起钮只在宽幅出现)
        bottom: 96 + bottomPad,
        width: 340,
        maxWidth: '72%',
        borderRadius: 8,
        overflow: 'hidden',
        boxShadow: '0px 6px 20px rgba(0,0,0,0.45)',
        zIndex: 40,
        elevation: 40,
      }}
      // 玻璃端专属：HIG 弹层归 Regular 变体（文本多）+ 恒深色 chrome 契约，
      // 大表面圆角（RADIUS.popup）+ 去自定义投影（材质自带自适应阴影）
      glassOnlyStyle={{ borderRadius: RADIUS.popup, boxShadow: 'none' }}
      // 弹层统一外观（PlayerPopup 同源：玻璃端 Regular 液态玻璃，降级端深灰面板）
      fallbackStyle={{ backgroundColor: PANEL_BG }}
    >
      {/* 头部：选集 · N 集 + 关闭（与站方浮层同构） */}
      <View className="h-11 flex-row items-center justify-between pl-4 pr-1.5">
        <View className="flex-row items-baseline gap-2" style={{ minWidth: 0 }}>
          <Text className="text-sm font-medium text-white" allowFontScaling={false}>
            选集
          </Text>
          <Text className="text-xs text-white/55" allowFontScaling={false}>
            共 {list.length} 集{title ? ' · ' + title : ''}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭选集"
          onPress={onClose}
          className="h-8 w-8 items-center justify-center rounded-full"
          style={({ hovered }) => ({
            backgroundColor: hovered ? 'rgba(255,255,255,0.16)' : 'transparent',
          })}
        >
          <Close size={18} color="#fff" />
        </Pressable>
      </View>
      <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.1)' }} />
      {/* 正文：序号格（5 列，在播项整格提亮；点按即切集） */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 12, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}
      >
        {list.map((v, i) => {
          const active = v && v.id != null && String(v.id) === cur;
          return (
            <Pressable
              key={v && v.id != null ? String(v.id) : 'i' + i}
              accessibilityRole="button"
              accessibilityLabel={
                (v && v.title ? v.title : '第 ' + (i + 1) + ' 集') + (active ? '（正在播放）' : '')
              }
              onPress={() => onPick(v)}
              className="items-center justify-center rounded-md"
              style={({ hovered, pressed }) => ({
                width: TILE_W,
                height: TILE_H,
                backgroundColor: active
                  ? ROW_ACTIVE_BG
                  : pressed
                    ? 'rgba(255,255,255,0.28)'
                    : hovered
                      ? 'rgba(255,255,255,0.2)'
                      : 'rgba(255,255,255,0.1)',
              })}
            >
              <Text
                className="text-sm"
                style={{ color: active ? '#fff' : 'rgba(255,255,255,0.9)', fontWeight: active ? '700' : '400' }}
                allowFontScaling={false}
              >
                {i + 1}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </GlassSurface>
  );
}
