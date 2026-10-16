// ============================================================================
// MenuWindowRoot.jsx —— 菜单独立子窗内容根（桌面 Electron 专用，/menu?win=menu）
// ----------------------------------------------------------------------------
// 承载 desktop/main.js 菜单会话浮出的三类弹层（倍速/音量/设置），外观完全
// 复用 PlayerPopup 家族（同一深灰半透明面板语言，与窗口内回落形态一字不差）。
// 为什么独立窗：弹层原是播放器表面内的绝对定位子节点，被 VideoPlayer 容器
// 与舞台层的 overflow:hidden 双重裁剪——小窗播放（520x300）里六档倍速菜单放
// 不下；腾讯视频同款做法是菜单独立成窗（见 main.js「菜单独立子窗」区）。
// 数据流全 IPC（桌面壳桥 menu.*）：
//   · 订阅 moontent:menu-state（{kind,state}）——主进程在每次打开/状态反推
//     时推送；挂载时主动 ready() 报到，主进程补推 lastState（建窗初期 send
//     早于渲染端订阅会丢，这里拉齐竞态）；
//   · 根 onLayout → sized 回报内容尺寸（外圈 12px 留白含在内，兼作 hover
//     桥）——主进程据此精确摆位（右下角对齐触发钮右上角）并显示；
//   · 指针进/出窗 → enter/leave（主进程 450ms 宽限定时器统一收合，与 owner
//     控制条两侧共用）；
//   · 选择动作 → action 回流 owner 窗落地（倍速选档即收；音量拖动 ~40ms
//     节流实时；设置切换保持开窗，owner 应用后反推最新快照）。
// 透明窗口：html/body/#root 底色全部置 transparent，仅面板本体不透明——
// 圆角与阴影由面板 CSS 画（窗体 transparent，系统阴影已关）。
// ============================================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Platform, Text, View } from 'react-native';
import { menuWindow } from '../../lib/desktop-bridge.js';
import { PlayerPopup, PlayerPopupRow, RATES_DESC } from './PlayerPopup.jsx';
import { PlayerMenuContent } from './PlayerMenu.jsx';

const VOL_W = 96; // 音量条宽（与 PlayerControls 窗口内形态同口径）
const VOL_SEND_MS = 40; // 音量拖动 IPC 节流间隔（主进程只转发，够密不刷屏）

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

export default function MenuWindowRoot() {
  // 主进程推来的菜单态：{kind:'rate'|'vol'|'settings', state:{...快照}}
  const [st, setSt] = useState(null);
  // 拖动中的本地音量（null=用推送值）：拖动期本地乐观显示，释放回落推送值
  const [volLocal, setVolLocal] = useState(null);

  // 透明窗底色：html/body/#root 全 transparent（面板才是不透明的）；#root
  // 需显式高宽 100% 承接内容布局，根视图本身 content 尺寸（见 return）
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    try {
      document.documentElement.style.background = 'transparent';
      document.body.style.background = 'transparent';
      const root = document.getElementById('root');
      if (root) {
        root.style.background = 'transparent';
        root.style.width = '100%';
        root.style.height = '100%';
      }
    } catch (_e) {
      /* DOM 异常：保持默认（窗仍可用，仅底色不透明） */
    }
  }, []);

  // 状态订阅 + 启动报到（主进程补推 lastState）；kind 切换时清拖动本地值
  useEffect(() => {
    const off = menuWindow.subscribeState((payload) => {
      if (payload && typeof payload === 'object') {
        setSt(payload);
        setVolLocal(null);
      }
    });
    menuWindow.ready();
    return off;
  }, []);

  const kind = st && st.kind;
  const s = (st && st.state) || {};
  const vol = volLocal != null ? volLocal : clamp01(s.volume);

  // 音量条拖动（页宽换算，同 PlayerControls 的 volPan 口径；发送 ~40ms 节流，
  // 释放兜底直发最终值）
  const lastSendRef = useRef(0);
  const volPan = useMemo(() => {
    let x0 = 0; // 音量条在页面上的 x
    let cur = 0; // 最近一次计算的值（释放时兜底直发）
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        x0 = e.nativeEvent.pageX - e.nativeEvent.locationX;
        cur = clamp01(e.nativeEvent.locationX / (VOL_W || 1));
        setVolLocal(cur);
        menuWindow.action({ type: 'volume', value: cur });
        lastSendRef.current = Date.now();
      },
      onPanResponderMove: (_e, g) => {
        cur = clamp01((g.pageX - x0) / (VOL_W || 1));
        setVolLocal(cur);
        const now = Date.now();
        if (now - lastSendRef.current >= VOL_SEND_MS) {
          lastSendRef.current = now;
          menuWindow.action({ type: 'volume', value: cur });
        }
      },
      onPanResponderRelease: () => {
        menuWindow.action({ type: 'volume', value: cur }); // 释放兜底直发
        setVolLocal(null);
      },
      onPanResponderTerminate: () => {
        menuWindow.action({ type: 'volume', value: cur });
        setVolLocal(null);
      },
    });
  }, []);

  // ===== 按 kind 出内容（PlayerPopup 家族，与窗口内形态同构）=====
  let content = null;
  if (kind === 'rate') {
    const cur = Number(s.rate) || 1;
    content = (
      <PlayerPopup minWidth={112}>
        {RATES_DESC.map((r) => (
          <PlayerPopupRow
            key={r}
            label={r + 'X'}
            active={Math.abs(cur - r) < 0.01}
            onPress={() => {
              menuWindow.action({ type: 'rate', value: r });
              menuWindow.hide(); // 选档即收（站方体感）
            }}
          />
        ))}
      </PlayerPopup>
    );
  } else if (kind === 'vol') {
    const pct = Math.round((s.muted ? 0 : vol) * 100);
    content = (
      <PlayerPopup
        minWidth={0}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12 }}
      >
        <Text className="w-7 text-right text-xs text-white/85" allowFontScaling={false}>
          {pct}
        </Text>
        <View
          className="h-1 rounded-full bg-white/30"
          style={{ width: VOL_W }}
          {...volPan.panHandlers}
        >
          <View
            className="absolute left-0 top-0 h-1 rounded-full bg-white"
            style={{ width: vol * VOL_W }}
          />
        </View>
      </PlayerPopup>
    );
  } else if (kind === 'settings') {
    content = (
      <PlayerPopup minWidth={196}>
        <PlayerMenuContent
          autoplay={s.autoplay !== false}
          multi={s.multi === true}
          onSet={(key, value) => menuWindow.action({ type: 'setting', key, value })}
        />
      </PlayerPopup>
    );
  }

  // 根：content 尺寸（不撑满窗——窗体初始是兜底尺寸，sized 后才收拢到内容
  // 实测大小；alignSelf 防被 #root 的 column-flex 拉伸）+ 外圈留白容纳面板
  // CSS 阴影（底边加厚到 20：贴着触发钮的方向多留一段悬停桥，指针从钮上移
  // 进窗即命中热区）。enter/leave 同时挂在根与内容两层——任何一层收到
  // mouseenter 都撤销宽限收起，杜绝子元素过渡误判成「移出」
  const hoverProps = {
    onHoverIn: menuWindow.enter,
    onHoverOut: menuWindow.leave,
  };
  return (
    <View
      style={{ paddingTop: 12, paddingLeft: 12, paddingRight: 12, paddingBottom: 20, alignSelf: 'flex-start' }}
      onLayout={(e) => {
        if (!kind) return;
        const { width, height } = e.nativeEvent.layout;
        if (width > 0 && height > 0) {
          menuWindow.sized({ kind, w: Math.round(width), h: Math.round(height) });
        }
      }}
      {...hoverProps}
    >
      <View {...hoverProps}>{content}</View>
    </View>
  );
}
