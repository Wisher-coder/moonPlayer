// ============================================================================
// PlayerMenu.jsx —— 播放设置菜单（底部控制条「设置」齿轮；内容体与菜单独立
// 子窗共用；本组件只出面板本体，锚位由调用方摆）
// ----------------------------------------------------------------------------
// 外观走 PlayerPopup 统一口径（深灰圆角面板 + 整行项，站方播放器形态）：
//   · 自动连播   —— settings.autoplay（连播倒计时/自动跳下一个的总开关，与
//                    「我的」页设置共用同一持久化键）；
//   · 播放窗口   —— settings.playerWindow（桌面壳专用：单窗复用 ↔ 每次新开，
//                    与 open-video.js 读取的口径同源；浏览器/原生端不显示）。
// 结构分两层：
//   · PlayerMenuContent —— 纯内容行（值与切换回调全由调用方供给）。窗口内
//     弹层（默认导出）用 settings.js 持久化通道直读直写；菜单独立子窗
//     （MenuWindowRoot）用主进程推来的快照供值、选择经 IPC 回流 owner 落地
//     （单一漏斗，见 desktop/main.js 菜单会话区）——两处同一外观同一行为。
// 开关打开态走白色系（播放器整体去红口径：弹层家族不出现品牌红）。
// ============================================================================
import { Text, View } from 'react-native';
import { setSetting, useSettingsState } from '../../lib/settings.js';
import { useIsDesktopApp } from '../../lib/desktop-bridge.js';
import { PlayerPopup, PlayerPopupRow } from './PlayerPopup.jsx';

// 迷你开关（20×36 圆角轨 + 16px 圆钮；不用 RN Switch——两端/web 外观差异大，
// 自绘三端一致。打开态白色系高亮，播放器整体去红口径）
function Switch({ on }) {
  return (
    <View
      className="h-5 w-9 justify-center rounded-full"
      style={{ backgroundColor: on ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.28)' }}
    >
      <View className="absolute size-4 rounded-full" style={{ left: on ? 18 : 2, backgroundColor: on ? '#1c1c1c' : '#fff' }} />
    </View>
  );
}

/**
 * 播放设置菜单内容体（行项，不带面板壳；窗口内弹层与菜单独立子窗共用）
 * @param {{ autoplay?: boolean, multi?: boolean, fill?: 'fit'|'fill',
 *   onSet?: (key:'autoplay'|'playerWindow'|'playerFill', value:any) => void }} props
 *   值与切换回调由调用方供给（本地=setSetting 直写；独立子窗=经 IPC 回流 owner
 *   落地）。fill 为 undefined 时「画面填充」行不渲染——桌面独立菜单窗
 *   （MenuWindowRoot）不传该 prop 自动缺席，desktop/main.js 零改动。
 */
export function PlayerMenuContent({ autoplay = true, multi = false, fill, onSet }) {
  const desktop = useIsDesktopApp();
  const set = (k, v) => {
    if (typeof onSet === 'function') onSet(k, v);
  };
  return (
    <>
      <PlayerPopupRow
        label="自动连播"
        onPress={() => set('autoplay', !autoplay)}
        right={<Switch on={autoplay} />}
      />
      {desktop ? (
        <PlayerPopupRow
          label="播放窗口"
          onPress={() => set('playerWindow', multi ? 'single' : 'multi')}
          right={
            <View className="flex-row items-center gap-2">
              <Text className="text-xs text-white/60" allowFontScaling={false}>
                {multi ? '每次新开' : '单窗复用'}
              </Text>
              <Switch on={multi} />
            </View>
          }
        />
      ) : null}
      {fill != null ? (
        // 画面填充（全屏态生效）：自适应=完整画面（黑边为视频与屏幕的比例差，
        // 两侧对称）；满屏=裁切铺满（爱奇艺「AI满屏」/腾讯「撑满全屏」同款）。
        // 右侧文字示当前档，点击在两档间切换（与「播放窗口」行同交互）
        <PlayerPopupRow
          label="画面填充"
          onPress={() => set('playerFill', fill === 'fill' ? 'fit' : 'fill')}
          right={
            <Text className="text-xs text-white/60" allowFontScaling={false}>
              {fill === 'fill' ? '满屏' : '自适应'}
            </Text>
          }
        />
      ) : null}
    </>
  );
}

/**
 * 播放设置菜单面板（窗口内弹层形态：settings.js 直读直写）
 * @param {{ shown?: boolean }} props shown：materialize 显隐（透传 PlayerPopup；
 *   调用方保持挂载时须给外层包裹同步 pointerEvents）
 */
export default function PlayerMenu({ shown }) {
  const s = useSettingsState();
  return (
    <PlayerPopup minWidth={196} shown={shown}>
      <PlayerMenuContent
        autoplay={s.autoplay !== false}
        multi={s.playerWindow === 'multi'}
        fill={s.playerFill === 'fill' ? 'fill' : 'fit'}
        onSet={(key, value) => setSetting(key, value)}
      />
    </PlayerPopup>
  );
}
