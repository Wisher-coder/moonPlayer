// ============================================================================
// WallTile.js —— 视频墙单格(iOS/Android 专用;metro 平台分流:web 走 .web.js)
// ----------------------------------------------------------------------------
// NextWeb WallTile.jsx 的 expo-video 移植版,语义对齐 web 版(文件头互见):
//   · 每格独立播放器实例:useVideoPlayer(source) 自建(项目惯用法,对齐
//     VideoPlayer.js 的独立使用形态),source 换 key 重建(hook 内部按 source
//     序列化值释放旧实例建新实例); HLS 交给系统播放器(iOS AVPlayer/Android
//     ExoPlayer),URL 无 .m3u8 扩展时显式 contentType:'hls'(iOS 识别前提);
//   · loop = true 循环播放(墙是氛围位,播完自动从头续播不黑格);
//   · 每格独立 muted(默认**有声**同播,点格本体/喇叭钮切换本格静音,互不牵连);
//   · 取流同 getWallSrc(wall-src 的 LRU+TTL 缓存,addToWall 时已后台预解析),
//     解析失败/播放错误自动重试 ≤5 次(递增退避 1~5s,重试轮 force 现取新地址
//     不复读缓存死链;计数只随换 key/手动重试清零),5 次后亮错误态(黑格 +
//     Restart 重试钮)给手动重试;
//   · 有声自动播:打开看板的用户手势链路内 player.play();被系统拒绝就降级
//     muted 续播(对齐 web 版语义;expo-video 的 play() 无 Promise,用 try/catch
//     兜底,喇叭钮仍可手动开声);
//   · 保活(秒开):挂载即取流预缓冲(停车场形态也在);看板关闭/全局暂停只
//     player.pause()(expo-video 无 paused 可写属性,pause()/play() 即等价物),
//     **不换 source 不销毁实例**,重开零加载从原位置续播;销毁只发生在移除/
//     清空/换源;
//   · 进度两本账:readyToPlay 首次就绪先续播(item.t 起播,片头 3s 内/片尾 10s
//     内不续;起播 seek 用 player.currentTime 赋值,对齐 VideoPlayer.js 写法)
//     再 play;timeUpdate(0.5s 一拍)双节流——进度条镜像 ≥1s、wall-store 回写
//     ≥5s(带防倒退守卫),绝不碰 history.js;卸载/换源前用 timeUpdate 维护的
//     镜像补写最后一段进度(此时实例可能已释放,不能直接读 player);
//   · 比例收敛:sourceLoad/videoTrackChange 里读 player.videoTrack.size
//     (VideoTrack.size.width/height,expo-video .d.ts 契约;iOS 走 HLS 需
//     contentType:'hls' 才有 videoTrack),与登记 ratio 差 > 0.02 才回写
//     updateWallRatio;拿不到 track 尺寸(个别源/平台不报)保 16:9 不回写;
//   · 与 web 版的克制差异:顶部信息带常显(触屏无 hover,藏起来就无路可点);
//     底部进度条纯展示不做拖拽 seek(触屏横拖与点格静音切换极易误触)。
// 并发流闸门(lib/wall/stream-gate.js,与 web 版共用同一模块):「挂流」(此处
// = setSrc 驱动 useVideoPlayer 建 source)前 acquireStream 过闸;上限 ≥ 格子
// 数(缺省 16)时同步直通零开销,行为与无闸门完全一致;上限被服务端压低时
// 超额格子 FIFO 排队,移除/错误烧穿/看板关闭即释放,重开按 FIFO 复活(绑定
// 态下看板关闭进入「休眠」:还闸位 + setSrc(null) 拆流,默认档恒不触发,
// 停车场保活语义不动)。
// ============================================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Restart, VolumeUp, VolumeOff, Close } from '../icons.js';
import Spinner from '../ui/Spinner.jsx';
import { getWallSrc } from '../../lib/wall-src.js';
import { updateWallProgress, updateWallRatio, useWallOpen } from '../../lib/wall-store.js';
import { acquireStream, isStreamGateBinding } from '../../lib/wall/stream-gate.js';
import { ABS_FILL } from '../../lib/abs-fill.js';

const RED = '#ff0000'; // 进度条已播(品牌红,与 PlayerControls 同源)

// 组装 expo-video 的 VideoSource:HLS 显式 contentType(iOS 对无扩展名清单必需,
// videoTrack(比例收敛用)也依赖它)
function makeVideoSource(src) {
  if (!src || !src.url) return null;
  if (src.type === 'hls') return { uri: src.url, contentType: 'hls' };
  return { uri: src.url };
}

// 秒 → mm:ss 徽标(两位分钟,与卡面 "58:26" 形态对齐)
function mmss(n) {
  const s = Math.max(0, Math.floor(Number(n) || 0));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

export default function WallTile({ item, masterPaused, onRemove }) {
  const open = useWallOpen(); // 看板开合(保活联动:关=暂停,开=续播)
  const epochRef = useRef(0);       // 媒体流水号:换源/重试/卸载后旧异步链全部作废
  const autoRetryRef = useRef(0);   // 解析/播放失败自动重试计数(≤5,换 key/手动重试清零)
  const pauseRef = useRef(masterPaused); // 全局暂停镜像(readyToPlay 闭包读最新值)
  const lastWriteRef = useRef(0);   // 上次回写 store 的时刻(≥5s 节流)
  const lastUiRef = useRef(0);      // 上次刷新进度条镜像的时刻(≥1s 节流)
  const startedRef = useRef(false); // 本轮源是否已做过 续播跳转/起播(只做一次)
  // 卸载补写镜像:timeUpdate 持续维护,卸载/换源 cleanup 时实例可能已被 hook
  // 释放,不能直接读 player.currentTime,从这里取最后快照
  const lastSnapRef = useRef({ t: 0, d: 0 });
  const itemRef = useRef(item);     // item 最新镜像(事件闭包防过期)
  itemRef.current = item;
  const gateRef = useRef(null);     // 当前闸位句柄(未持有时 null;错误烧穿即还)

  const [soundOn, setSoundOn] = useState(true);  // 本格独立声音开关(默认有声)
  const [src, setSrc] = useState(null);        // { type, url } 解析结果
  const [failed, setFailed] = useState(false); // 解析/播放失败(重试用)
  const [retryKey, setRetryKey] = useState(0); // 重试流水:变化即重跑媒体 effect
  const [t, setT] = useState(0);               // currentTime 节流镜像(进度条)
  const [d, setD] = useState(0);               // duration 镜像(readyToPlay/sourceLoad)
  const [dormant, setDormant] = useState(false); // 闸门绑定态的休眠档(见开合联动 effect)
  const [showCover, setShowCover] = useState(!!item.cover); // 首帧前盖封面(休眠复活也重新盖)

  pauseRef.current = masterPaused || !open;

  // 还闸位(幂等):错误烧穿/换轮清理统一出口——重试梯的退避间隙与终态错误
  // 格都不占闸位,排队格子顶上
  const releaseGate = () => {
    const g = gateRef.current;
    if (!g) return;
    gateRef.current = null;
    g.release();
  };

  // ===== 取流流水线:过闸(stream-gate;上限内直通零开销,超额 FIFO 排队)→
  //       解析(wall-src 缓存,重试轮 force)→ setSrc 驱动 useVideoPlayer
  //       换源重建;依赖只取 item.key(+retryKey+dormant)——进度回写每 5s 换
  //       item 对象身份,媒体绝不能跟着重挂;**关闭/重开看板在默认档(上限 ≥
  //       格子数)绝不进这里**(保活),仅闸门绑定态经休眠档进(见下方开合
  //       联动 effect)=====
  useEffect(() => {
    if (dormant) {
      // 休眠档(仅闸门绑定态的看板关闭):闸位已在上一轮 cleanup 还掉,这里只
      // 拆流归位——setSrc(null) 驱动 useVideoPlayer 释放实例;重开(dormant=
      // false)本 effect 重跑,重新过闸按 FIFO 复活(setFailed 复位与 web 版
      // 休眠分支对齐)
      setSrc(null);
      setFailed(false);
      if (item.cover) setShowCover(true); // 复活解析期间重新盖封面(首帧回调会再撤)
      return undefined;
    }
    const epoch = ++epochRef.current;
    setSrc(null);
    setFailed(false);
    setT(item.t && item.t > 3 ? item.t : 0); // 起播点先垫给进度条,免 0→t 跳变
    setD(item.d || 0);
    lastWriteRef.current = 0;
    lastUiRef.current = 0;
    lastSnapRef.current = { t: 0, d: 0 };

    // 失败统一出口:自动重试 ≤5 次(递增退避 1~5s,重试轮 getWallSrc 带 force
    // 现取新地址),5 次仍失败才亮错误态给手动重试;epoch 守卫防过期轮次补枪
    const failTile = () => {
      if (epoch !== epochRef.current) return;
      releaseGate(); // 错误烧穿:先还闸位(退避间隙/终态错误格不占位)
      if (autoRetryRef.current < 5) {
        autoRetryRef.current += 1;
        setTimeout(() => { if (epoch === epochRef.current) setRetryKey((k) => k + 1); }, 1000 * autoRetryRef.current);
        return;
      }
      setFailed(true);
    };

    // 过闸:上限内直通(wait=null 零开销);超额 FIFO 排队,await 复活
    const gate = acquireStream();
    gateRef.current = gate;

    (async () => {
      try {
        if (gate.wait) await gate.wait; // 排队等到闸位才继续(等待中被换轮=作废)
        if (epoch !== epochRef.current) return;
        const r = await getWallSrc(item.site, item.id, retryKey > 0 ? { force: true } : undefined);
        if (epoch !== epochRef.current) return;
        if (!r || !r.url) throw new Error('播放地址为空');
        setSrc({ type: r.type, url: r.url });
      } catch (_e) {
        failTile(); // 自动重试兜底,5 次后亮错误态(封面仍打底)
      }
    })();

    return () => {
      releaseGate(); // 还闸位/撤队(幂等;错误烧穿已还过则空操作)
      epochRef.current++; // 本轮作废(重试/换 key/卸载后,在途异步链全部失效)
      // 卸载/换源前补写最后一段进度:只走 wall-store,绝不碰 history.js;同带
      // 防倒退守卫;读镜像不碰 player(此时实例可能已释放)
      const snap = lastSnapRef.current;
      if (snap.t > 2 && !(snap.t + 3 < item.t)) {
        updateWallProgress(item.key, Math.floor(snap.t), Math.floor(snap.d) || item.d);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.key, retryKey, dormant]);

  // 自动重试计数清零:只随换 key;retryKey 变化(重试轮)不清,否则退化成无限重试
  useEffect(() => { autoRetryRef.current = 0; }, [item.key]);

  // ===== 闸门开合联动:绑定态(上限 < 格子数,服务端 streamSlots)看板关闭即
  //       休眠(还闸位+拆流),重开重走媒体 effect 按 FIFO 复活。无条件收敛而
  //       非「非绑定直接 return」:上限迁移(清单重拉收回字段 → 回缺省 16)后
  //       重开看板,也能把绑定期残留的 dormant 收回 false 触发媒体 effect 复活,
  //       休眠格不会永久卡 spinner;非绑定档恒收敛 false(与 useState 初始值
  //       同,React 等值 bail-out),停车场保活(关=只 pause 不拆流)语义分毫
  //       不动 =====
  useEffect(() => {
    setDormant(isStreamGateBinding() && !open);
  }, [open]);

  // ===== 播放实例:useVideoPlayer 自建(source 换 url 重建);loop 循环 + 0.5s
  //       进度节拍(VideoPlayer.js 同款 setup)=====
  const ownSource = useMemo(() => makeVideoSource(src), [src && src.url, src && src.type]);
   
  const player = useVideoPlayer(ownSource, (p) => {
    p.loop = true; // 循环播放:播完自动从头续播
    try {
      p.timeUpdateEventInterval = 0.5; // 进度回调节拍(秒)
    } catch (_e) {
      /* 个别平台不支持该属性:默认节拍也可用 */
    }
  });

  // 换实例(换源重建)时重置「本轮源首次就绪」标记
  useEffect(() => {
    startedRef.current = false;
  }, [player]);

  // 有声起播 + 静音降级兜底(对齐 web 版语义):被系统拒绝就 muted 续播,
  // 喇叭钮仍可手动开声(用户手势下 unmute 合法)
  const attemptPlay = () => {
    try {
      player.play();
    } catch (_e) {
      try {
        setSoundOn(false);
        player.muted = true;
        player.play();
      } catch (_e2) { /* 低电量/占用连静音播都拒:停在暂停位 */ }
    }
  };

  // statusChange error → 媒体轮梯子(事件桥闭包经 ref 调,防重建循环;声明在
  // 事件桥之前,当前值每次渲染刷新)
  const failFromErrorRef = useRef(() => {});
  failFromErrorRef.current = () => {
    releaseGate(); // 错误烧穿:先还闸位,退避间隙与终态错误格不占位(幂等)
    if (autoRetryRef.current < 5) {
      autoRetryRef.current += 1;
      setTimeout(() => setRetryKey((k) => k + 1), 1000 * autoRetryRef.current);
      return;
    }
    setFailed(true);
  };

  // ===== 实例事件桥:readyToPlay(续播+起播)/timeUpdate(双节流回写)/
  //       sourceLoad·videoTrackChange(比例收敛)/statusChange(错误走重试梯)=====
  useEffect(() => {
    if (!player || !player.addListener) return;
    const subs = [];
    subs.push(
      player.addListener('statusChange', (payload) => {
        const st = payload && payload.status;
        if (st === 'error') {
          // 播放挂死/挂流失败与解析失败同一梯子(起播前后都走重试——格子的使命
          // 就是出画面;重试轮 force 现取新地址,见媒体 effect)
          failFromErrorRef.current();
          return;
        }
        if (st === 'readyToPlay') {
          let dur = 0;
          try {
            dur = player.duration || 0;
          } catch (_e) {
            dur = 0;
          }
          if (dur > 0) setD(dur);
          // 本轮源首次就绪:先续播跳转,再有声起播(只做一次)
          if (startedRef.current) return;
          startedRef.current = true;
          const it = itemRef.current;
          const t0 = it.t || 0;
          // 续播:添加时带来的进度就是起播点(片头 3s 内/片尾 10s 内不续,重头放)
          if (t0 > 3 && (!it.d || t0 < it.d - 10)) {
            try {
              player.currentTime = t0; // 起播 seek:对齐项目现有写法(currentTime 赋值)
            } catch (_e) {
              /* 个别实现拒 seek:忽略,从头播 */
            }
          }
          if (!pauseRef.current) attemptPlay();
        }
      })
    );
    subs.push(
      player.addListener('timeUpdate', (payload) => {
        const ct = (payload && payload.currentTime) || 0;
        const it = itemRef.current;
        let dur = 0;
        try {
          dur = player.duration || 0;
        } catch (_e) {
          dur = 0;
        }
        lastSnapRef.current = { t: ct, d: dur }; // 卸载补写镜像
        const now = Date.now();
        if (now - lastUiRef.current >= 1000) {
          lastUiRef.current = now;
          setT(ct);
        }
        if (now - lastWriteRef.current >= 5000) {
          lastWriteRef.current = now;
          // 防倒退:大幅低于已记录进度只可能是 seek 偶发失效/流重置,跳过保住进度
          if (!(ct + 3 < it.t)) {
            updateWallProgress(it.key, Math.floor(ct), Math.floor(dur) || it.d);
          }
        }
      })
    );
    // 比例收敛:videoTrack.size(VideoTrack.size.width/height);iOS 走 HLS 需
    // contentType:'hls'(makeVideoSource 已带);个别源不报 track → 拿不到就保
    // 16:9 不回写(外层不重排,格内 Letterbox 由 contentFit contain 兜住)
    const ratioFromTrack = () => {
      try {
        const vt = player.videoTrack;
        const w = vt && vt.size ? vt.size.width : 0;
        const h = vt && vt.size ? vt.size.height : 0;
        if (w > 0 && h > 0) {
          const r = w / h;
          const it = itemRef.current;
          if (Math.abs(r - (it.ratio || 16 / 9)) > 0.02) updateWallRatio(it.key, r);
        }
      } catch (_e) {
        /* track 未就绪/实例异常:等下一个事件 */
      }
    };
    subs.push(player.addListener('sourceLoad', ratioFromTrack));
    subs.push(player.addListener('videoTrackChange', ratioFromTrack));
    return () => {
      subs.forEach((s) => {
        try {
          s.remove();
        } catch (_e) {
          /* 实例已释放:忽略 */
        }
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player]);

  // ===== 声音/开合/全局暂停联动:每格独立 muted;关闭/全局暂停只 pause 不拆流
  //       (缓冲保留,重开零加载续播);续播走 attemptPlay(带静音降级兜底)=====
  useEffect(() => {
    if (!player) return;
    try {
      player.muted = !soundOn;
    } catch (_e) {
      /* 忽略 */
    }
    if (masterPaused || !open) {
      try {
        player.pause(); // 保活:只暂停,不换 source 不销毁实例
      } catch (_e) {
        /* 忽略 */
      }
    } else {
      attemptPlay();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, soundOn, masterPaused, open]);

  const onSoundBtn = () => setSoundOn((s) => !s);
  const onRemoveBtn = () => onRemove(item.key);
  const onRetry = () => {
    autoRetryRef.current = 0; // 手动重试清零,重给完整 5 轮自动梯
    setRetryKey((k) => k + 1);
  };

  const total = d || item.d || 0;
  const pct = total > 0 ? Math.min(100, (t / total) * 100) : 0;
  // 右下时长徽标:优先实播总时长 d(秒),退回卡面 duration
  const durBadge = item.d || item.duration;
  const badge = typeof durBadge === 'number' && isFinite(durBadge) && durBadge > 0 ? mmss(durBadge) : durBadge || '';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={soundOn ? '静音本格' : '开启本格声音'}
      onPress={() => setSoundOn((s) => !s)}
      style={styles.root}
    >
      {/* 系统播放器视图:nativeControls 关掉(控件自绘克制版);首帧回调撤封面 */}
      <VideoView
        player={player}
        nativeControls={false}
        contentFit="contain"
        style={styles.fill}
        onFirstFrameRender={() => setShowCover(false)}
      />
      {/* 封面占位:首帧渲染前盖住黑屏(VideoView 无 poster 概念,自补) */}
      {showCover && item.cover ? (
        <Image source={{ uri: item.cover }} style={styles.cover} contentFit="cover" />
      ) : null}
      {/* 解析中:封面打底 + 居中 spinner */}
      {!src && !failed ? (
        <View style={styles.loading} pointerEvents="none">
          <Spinner size={22} />
        </View>
      ) : null}
      {/* 解析/播放失败:覆盖式错误态(黑格 + Restart 重试钮;内层 Pressable 赢
          手势,不触发静音切换) */}
      {failed ? (
        <View style={styles.failed}>
          <Text style={styles.failedText}>解析失败</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="重试"
            onPress={onRetry}
            style={styles.retryPill}
          >
            <Restart size={14} color="#ffffff" />
            <Text style={styles.retryText}>重试</Text>
          </Pressable>
        </View>
      ) : null}
      {/* 顶部信息带:静音/移除小圆钮(无标题——用户要求格子顶部不展示视频标题,
          web 版同口径)。触屏无 hover,藏起来就无路可点,故常显(半透明黑带克制
          处理,web 版为 hover 显隐——平台差异,见文件头) */}
      <View style={styles.topBand}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={soundOn ? '静音' : '开声音'}
          onPress={onSoundBtn}
          style={styles.bandBtn}
        >
          {soundOn ? <VolumeUp size={16} color="#ffffff" /> : <VolumeOff size={16} color="#ffffff" />}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="从看板移除"
          onPress={onRemoveBtn}
          style={styles.bandBtn}
        >
          <Close size={16} color="#ffffff" />
        </Pressable>
      </View>
      {/* 底部进度条:纯展示(白轨 + 品牌红已播);触屏不做拖拽 seek——横拖与点格
          静音切换极易误触,seek 语义由 web 端进度条承载 */}
      <View style={styles.barHit} pointerEvents="none">
        <View style={styles.barTrack}>
          <View style={[styles.barFill, { width: pct + '%' }]} />
        </View>
      </View>
      {/* 右下时长徽标(mm:ss) */}
      {badge ? (
        <View style={styles.badge} pointerEvents="none">
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
    height: '100%',
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  fill: {
    flex: 1,
  },
  cover: {
    ...ABS_FILL,
  },
  loading: {
    ...ABS_FILL,
    alignItems: 'center',
    justifyContent: 'center',
  },
  failed: {
    ...ABS_FILL,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  failedText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.8)',
  },
  retryPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  retryText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.9)',
  },
  topBand: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  bandBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
  },
  barHit: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 4,
    justifyContent: 'flex-end',
  },
  barTrack: {
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  barFill: {
    height: 2,
    backgroundColor: RED,
  },
  badge: {
    position: 'absolute',
    right: 4,
    bottom: 6,
    borderRadius: 4,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  badgeText: {
    fontSize: 10,
    lineHeight: 14,
    color: '#ffffff',
  },
});
