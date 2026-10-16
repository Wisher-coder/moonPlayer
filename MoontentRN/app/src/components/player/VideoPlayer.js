// ============================================================================
// VideoPlayer.js —— iOS/Android 播放器(metro 平台分流:web 走 VideoPlayer.web.js)
// ----------------------------------------------------------------------------
// expo-video 的 VideoView/useVideoPlayer/共享实例:
//   - HLS 交给系统播放器(iOS AVPlayer/Android ExoPlayer,AES-128 由系统解密),
//     URL 无 .m3u8 扩展时显式带 contentType:'hls'(iOS 识别 HLS 的前提);
//   - 「跨页不断流」:播放实例上提到 Provider(共享实例经 player prop 传入),
//     本组件只是渲染它的「窗」——观看页 dock 与迷你浮层各自挂一个 VideoView,
//     页面切换时窗换、实例不变,音频全程不断;
//   - 未收到共享实例时(契约独立使用形态)内部自建实例(useVideoPlayer,
//     随组件卸载自动释放);
//   - 控件层共用 PlayerControls;native 基础手势(双击暂停/长按/拖动/竖滑)
//     在其中实现;音量为播放实例音量(expo-video player.volume,App 内音量与
//     系统媒体音量相乘),亮度为系统亮度(expo-brightness,卸载还原);
//   - 全屏为「应用内全屏」:fullscreen/onToggleFullscreen props 由宿主
//     (player-context)注入——舞台不动,观看页沉浸布局铺满整屏 + Provider 按
//     视频画幅锁屏幕方向。不再走 VideoView.enterFullscreen(原生呈现层盖在
//     RN 之上,自定义控件层跟不过去,Android 下 JS 还会被暂停);
//     画面填充按 settings.playerFill:自适应(contain,黑边=视频与屏幕比例差
//     两侧对称)/满屏(cover 裁切铺满),仅全屏态生效(常态/迷你恒 contain);
//   - 续播:startAt 在 readyToPlay 首次就绪时命中跳转;播完/切后台即时 onFlush。
// 对外 props 与 VideoPlayer.web.js 完全一致:
//   { source:{type,url,key?}, poster, autoplay, startAt, controls, style, title,
//     onEnded, onProgress, onFlush, onRetry, instanceRef, player }
//   (player 为 Provider 注入的共享播放实例,web 端同名 prop 存在但被忽略;
//    native 另由 Provider 注入 fullscreen/onToggleFullscreen——web 的全屏由
//    VideoPlayer.web.js 容器 requestFullscreen 自管,不注入)
// ============================================================================
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import * as Brightness from 'expo-brightness';
import PlayerControls from './PlayerControls.jsx';
import { ABS_FILL } from '../../lib/abs-fill.js';
import { useSettingsState } from '../../lib/settings.js';

// 组装 expo-video 的 VideoSource:HLS 显式 contentType(iOS 对无扩展名清单必需)
function makeVideoSource(source) {
  if (!source || !source.url) return null;
  if (source.type === 'hls') return { uri: source.url, contentType: 'hls' };
  return { uri: source.url };
}

function VideoPlayer({
  source = null, // { type:'hls'|'mp4', url, key? }(key 为重试轮次,同 url 强制换源用)
  poster = '',
  autoplay = true,
  startAt = 0, // 续播起点(秒;≤0 从头)
  controls = true, // 是否渲染控件层(迷你浮层传 false)
  style,
  title = '',
  onEnded,
  onProgress, // (sec, dur) 高频进度回调
  onFlush, // 播完/切后台等离散时机回调(Provider 即时落进度用)
  onRetry, // 播放失败重试(交 Provider 重新解析)
  onPlayingChange, // (playing) 播放/暂停态翻转回调(舞台迷你钮图标用)
  instanceRef, // 共享实例 ref:Provider 经它 play/pause/读进度
  player: sharedPlayer = null, // Provider 的共享播放实例(实例上提,跨页不断流)
  fullscreen = false, // 应用内全屏态(Provider 注入;缺省 false=独立使用形态)
  onToggleFullscreen, // () => 进/退应用内全屏(Provider 注入;缺省则全屏钮不渲染)
  immersive = false, // 舞台 edge-to-edge 沉浸态(全屏钮或手机横屏 landfs;控件层自垫安全区用)
}) {
  // 自有实例:仅当没拿到共享实例时创建(独立使用形态;源变化时 hook 自建新实例)
  const ownSource = sharedPlayer ? null : makeVideoSource(source);
   
  const ownPlayer = useVideoPlayer(ownSource, (p) => {
    try {
      p.timeUpdateEventInterval = 0.5; // 进度回调节拍(秒)
    } catch (_e) {
      /* 忽略 */
    }
  });
  const player = sharedPlayer || ownPlayer;

  // 画面填充偏好(全屏态生效):'fill'=cover 裁切铺满,否则 contain 完整画面
  const settings = useSettingsState();

  const startedRef = useRef(false); // 本轮源是否已做过 起播/续播
  // 共享实例换源在途标记:replaceAsync 异步装载期间,旧片(A)仍挂在实例上——
  // 挂载/换轮时桥事件可能带回旧片的陈旧 readyToPlay/timeUpdate,不拦的话会
  // 把旧片重新 play 出来(用户看到「先播A再跳B」)、旧片进度还会写进新片
  // 档案。在途期间这类事件全部按陈旧忽略,起播由 replaceAsync 完成回调驱动
  const switchingRef = useRef(false);

  // seek 在途守卫:iOS 精确 seek(tolerance 0)跨段加载完成前,timeUpdate 仍报
  // 旧位置,会把乐观落位的进度条打回旧位(「跳转后进度先回旧位,加载完才到
  // 目标」的观感)。pending 期间偏差过大的拍整拍丢弃,报到目标附近或超时
  // (网络极慢兜底)即恢复常态
  const SEEK_PENDING_MS = 8000; // seek 在途窗(毫秒)
  const SEEK_PENDING_EPS = 1; // 「已到目标」判定容差(秒,timeUpdate 节拍 0.5s)
  const pendingSeekRef = useRef(null); // { target, until }

  // 最新 props 镜像(事件回调闭包防过期)
  const cbRef = useRef({});
  cbRef.current = { onEnded, onProgress, onFlush, onRetry, onPlayingChange };
  const startAtRef = useRef(startAt);
  startAtRef.current = startAt;
  const autoplayRef = useRef(autoplay);
  autoplayRef.current = autoplay;

  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [ended, setEnded] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1); // 播放实例音量(右半竖滑手势调)
  const [muted, setMuted] = useState(false); // 播放实例静音(音量钮开关)
  const [brightness, setBrightness] = useState(1); // 系统亮度镜像(左半竖滑手势调)
  const [error, setError] = useState('');
  const [showPoster, setShowPoster] = useState(!!poster); // 首帧前盖封面

  // ===== 封面撤除兜底:onFirstFrameRender 之外再挂两道到点保险——起播(已有
  // 声)后短延时、就绪后长延时。iOS 上首帧回调偶发不达时,封面层(底色#000)
  // 会以纯黑形式永久压住画面(表现即「有声音无画面」),到点强撤 =====
  const posterTimerRef = useRef(null);
  const armPosterFallback = useCallback((delay) => {
    if (posterTimerRef.current) return; // 已有一道在途,先到先撤
    posterTimerRef.current = setTimeout(() => {
      posterTimerRef.current = null;
      setShowPoster(false);
    }, delay);
  }, []);
  const clearPoster = useCallback(() => {
    if (posterTimerRef.current) {
      clearTimeout(posterTimerRef.current);
      posterTimerRef.current = null;
    }
    setShowPoster(false);
  }, []);
  useEffect(
    () => () => {
      if (posterTimerRef.current) clearTimeout(posterTimerRef.current);
    },
    []
  );

  // ===== 亮度手势基线:挂载读系统初值,卸载还原(不给下个页面留下压暗的屏);
  // 系统 API 全程 try/catch——权限缺失/平台不可用时手势仅 HUD 变化无副作用 =====
  const brightInitRef = useRef(null);
  useEffect(() => {
    let alive = true;
    Brightness.getBrightnessAsync()
      .then((v) => {
        if (alive && typeof v === 'number' && v > 0) brightInitRef.current = v;
      })
      .catch(() => { /* 读不到初值:卸载时跳过还原 */ });
    return () => {
      alive = false;
      const init = brightInitRef.current;
      if (init != null) Brightness.setBrightnessAsync(init).catch(() => {});
    };
  }, []);

  // ===== 换源轮重置(共享实例路径的 replace 在下面的 effect;自建实例路径由
  // useVideoPlayer 换实例天然重置,这里只重置 React 态与一次性标记)=====
  useEffect(() => {
    startedRef.current = false;
    setError('');
    setLoading(true);
    setEnded(false);
    setCurrentTime(0);
    setBuffered(0);
    setShowPoster(!!poster);
    if (posterTimerRef.current) {
      clearTimeout(posterTimerRef.current);
      posterTimerRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source && source.url, source && source.key, source && source.type]);

  // ===== 共享实例换源:replaceAsync 异步装载(不重建实例)=====
  // 在途全程 switchingRef 把旧片事件按陈旧忽略(见事件桥);起播不在
  // statusChange 里赌时序,统一由完成回调驱动(实例已就绪则立即起播,
  // 否则等 readyToPlay 事件——两路经 startedRef 去重)
  useEffect(() => {
    if (!sharedPlayer || !source || !source.url) return;
    let alive = true;
    const next = makeVideoSource(source);
    switchingRef.current = true;
    pendingSeekRef.current = null; // 旧片的 seek 在途守卫随换源作废(目标属旧时间轴)
    try {
      sharedPlayer.pause(); // 先停旧片:装载窗口不再出旧片的画面/声音
    } catch (_e) {
      /* 忽略 */
    }
    sharedPlayer
      .replaceAsync(next)
      .then(() => {
        if (!alive) return;
        switchingRef.current = false;
        let st = null;
        try {
          st = sharedPlayer.status;
        } catch (_e) {
          /* 忽略 */
        }
        if (st === 'readyToPlay') startPlayback(); // 已就绪:立即起播(未就绪等事件)
      })
      .catch((e) => {
        if (!alive) return;
        switchingRef.current = false;
        setError('播放地址加载失败' + (e && e.message ? ':' + e.message : ''));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedPlayer, source && source.url, source && source.key, source && source.type]);

  // ===== 本轮源起播(续播跳转+自动播放,只做一次;statusChange 与 =====
  // replaceAsync 完成回调两路驱动,startedRef 去重——谁先到位谁起播)
  const startPlayback = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (startAtRef.current > 0) {
      try {
        player.currentTime = startAtRef.current;
      } catch (_e) {
        /* 忽略 */
      }
    }
    if (autoplayRef.current) {
      try {
        player.play();
      } catch (_e) {
        /* 忽略 */
      }
    }
  }, [player]);

  // ===== 实例事件桥(SharedObject 事件 → React 状态 / 外部回调)=====
  useEffect(() => {
    if (!player || !player.addListener) return;
    try {
      player.timeUpdateEventInterval = 0.5;
    } catch (_e) {
      /* 忽略 */
    }
    const subs = [];
    subs.push(
      player.addListener('statusChange', (payload) => {
        const st = payload && payload.status;
        if (__DEV__) console.log('[player] statusChange:', st);
        if (st === 'loading') {
          setLoading(true);
          return;
        }
        setLoading(false);
        if (st === 'error') {
          setError((payload.error && payload.error.message) || '播放失败,请重试');
          return;
        }
        if (st === 'readyToPlay') {
          // 换源在途:这是旧片的陈旧就绪(或新片就绪但起播统一由 replaceAsync
          // 完成回调驱动),不在这里动播放态/封面
          if (switchingRef.current) return;
          // 就绪后长延时兜底撤封面(与起播短延时取先到)
          armPosterFallback(2500);
          try {
            setDuration(player.duration || 0);
          } catch (_e) {
            /* 忽略 */
          }
          // 本轮源首次就绪:先续播跳转,再自动播放(只做一次)
          startPlayback();
        }
      })
    );
    subs.push(
      player.addListener('playingChange', (payload) => {
        const isPlaying = !!(payload && payload.isPlaying);
        setPlaying(isPlaying);
        if (cbRef.current.onPlayingChange) cbRef.current.onPlayingChange(isPlaying);
        if (isPlaying) {
          setEnded(false);
          // 已在出声:画面理应就绪,短延时后强撤封面(防首帧回调不达的黑盖);
          // 换源在途的旧片playing事件不撤(封面要盖到新片起播)
          if (!switchingRef.current) armPosterFallback(1200);
        }
      })
    );
    subs.push(
      player.addListener('timeUpdate', (payload) => {
        // 换源在途:旧片的残余进度回调——既不刷进度条也不落盘(否则会按
        // 新片会话存档,污染新片续播位)
        if (switchingRef.current) return;
        const t = (payload && payload.currentTime) || 0;
        // seek 在途(pendingSeekRef,见声明处注释):旧位置拍整拍丢弃,
        // 进度条维持乐观目标位;到目标附近/超时即清守卫恢复常态
        const ps = pendingSeekRef.current;
        if (ps) {
          if (Math.abs(t - ps.target) <= SEEK_PENDING_EPS) {
            pendingSeekRef.current = null;
          } else if (Date.now() < ps.until) {
            return;
          } else {
            pendingSeekRef.current = null;
          }
        }
        const b = payload && payload.bufferedPosition > 0 ? payload.bufferedPosition : 0;
        let d = 0;
        try {
          d = player.duration || 0;
        } catch (_e) {
          d = 0;
        }
        setCurrentTime(t);
        setBuffered(b);
        if (cbRef.current.onProgress) cbRef.current.onProgress(t, d);
      })
    );
    subs.push(
      player.addListener('playToEnd', () => {
        setPlaying(false);
        if (cbRef.current.onPlayingChange) cbRef.current.onPlayingChange(false);
        setEnded(true);
        if (cbRef.current.onFlush) cbRef.current.onFlush();
        if (cbRef.current.onEnded) cbRef.current.onEnded();
      })
    );
    subs.push(
      player.addListener('playbackRateChange', (payload) => {
        setRate((payload && payload.playbackRate) || 1);
      })
    );
    // 切后台:即时落一次进度(实例随即被系统暂停,后续不再有 timeUpdate)
    const onAppState = (s) => {
      if (s !== 'active' && cbRef.current.onFlush) cbRef.current.onFlush();
    };
    const appSub = AppState.addEventListener('change', onAppState);
    return () => {
      subs.forEach((s) => {
        try {
          s.remove();
        } catch (_e) {
          /* 忽略 */
        }
      });
      appSub.remove();
    };
  }, [player, armPosterFallback, startPlayback]);

  // ===== 共享实例 ref 暴露(Provider 经它控制/读进度)=====
  useEffect(() => {
    if (!instanceRef || !player) return;
    instanceRef.current = {
      play: () => {
        try {
          player.play();
        } catch (_e) {
          /* 忽略 */
        }
      },
      pause: () => {
        try {
          player.pause();
        } catch (_e) {
          /* 忽略 */
        }
      },
      seek: (t) => {
        try {
          player.currentTime = t;
        } catch (_e) {
          /* 忽略 */
        }
      },
      get currentTime() {
        try {
          return player.currentTime || 0;
        } catch (_e) {
          return 0;
        }
      },
      get duration() {
        try {
          return player.duration || 0;
        } catch (_e) {
          return 0;
        }
      },
      get playing() {
        try {
          return !!player.playing;
        } catch (_e) {
          return false;
        }
      },
    };
    return () => {
      instanceRef.current = null;
    };
  }, [player, instanceRef]);

  // ===== 控件动作 =====
  const seekTo = useCallback(
    (t) => {
      if (!player) return;
      let d = 0;
      try {
        d = player.duration || 0;
      } catch (_e) {
        d = 0;
      }
      const tt = d > 0 ? Math.max(0, Math.min(d, t)) : Math.max(0, t);
      if (!isFinite(tt)) return; // NaN 防线:两端内核都会把 NaN 钳成 0 跳片头
      try {
        player.currentTime = tt;
        // 在途标记 + 乐观落位:加载完成前的陈旧 timeUpdate 由事件桥内守卫丢弃
        pendingSeekRef.current = { target: tt, until: Date.now() + SEEK_PENDING_MS };
        setCurrentTime(tt); // 乐观落位:timeUpdate 间隔 0.5s,不等它进度条会闪回旧位
        setEnded(false);
      } catch (_e) {
        /* 忽略 */
      }
    },
    [player]
  );

  const onToggle = useCallback(() => {
    if (!player) return;
    try {
      if (ended) {
        player.replay(); // 回到开头
        player.play();
        setEnded(false);
        return;
      }
      if (player.playing) player.pause();
      else player.play();
    } catch (_e) {
      /* 忽略 */
    }
  }, [player, ended]);

  const onSeekBy = useCallback(
    (d) => {
      let t = 0;
      try {
        t = player ? player.currentTime || 0 : 0;
      } catch (_e) {
        t = 0;
      }
      seekTo(t + d);
    },
    [seekTo, player]
  );

  const onSetRate = useCallback(
    (r) => {
      if (!player) return;
      try {
        player.playbackRate = r; // preservesPitch 默认开:变速不变调
      } catch (_e) {
        /* 忽略 */
      }
    },
    [player]
  );

  // 音量(右半竖滑手势):写播放实例音量(0~1,与系统媒体音量相乘),>0 顺带解除静音
  const onSetVolume = useCallback(
    (x) => {
      if (!player) return;
      const v = Math.max(0, Math.min(1, x));
      try {
        player.volume = v;
        if (v > 0 && player.muted) {
          player.muted = false;
          setMuted(false);
        }
        setVolume(v);
      } catch (_e) {
        /* 忽略 */
      }
    },
    [player]
  );

  // 音量钮静音开关(canVolume 开后控件钮在 native 也会出现,补齐接线)
  const onToggleMute = useCallback(() => {
    if (!player) return;
    try {
      player.muted = !player.muted;
      setMuted(!!player.muted);
    } catch (_e) {
      /* 忽略 */
    }
  }, [player]);

  // 亮度(左半竖滑手势):系统亮度,失败(权限/平台)仅 HUD 变化
  const onSetBrightness = useCallback((x) => {
    const v = Math.max(0.05, Math.min(1, x));
    setBrightness(v);
    Brightness.setBrightnessAsync(v).catch(() => {});
  }, []);

  return (
    <View style={[styles.root, style]}>
      {/* 系统播放器视图:nativeControls 关掉走统一控件层;首帧回调撤封面。
          key 随源换代强制重挂视图:共享实例 replaceAsync 换源后复用旧视图,
          iOS 有画面层不随重挂同步的已知问题(黑屏有声),整视图重建即愈 */}
      <VideoView
        key={source && source.url ? source.url + '#' + (source.key != null ? source.key : 0) : 'empty'}
        player={player}
        nativeControls={false}
        contentFit={fullscreen && settings.playerFill === 'fill' ? 'cover' : 'contain'}
        style={styles.fill}
        onFirstFrameRender={() => {
          if (__DEV__) console.log('[player] firstFrameRender');
          clearPoster();
        }}
      />
      {/* 封面占位:首帧渲染前盖住黑屏(VideoView 无 poster 概念,自补);
          expo-image 的适配 prop 是 contentFit(resizeMode 无效);加载失败立即
          撤——失败图只剩 #000 底色,盖着即「黑屏」 */}
      {showPoster && poster ? (
        <Image
          source={{ uri: poster }}
          style={styles.poster}
          contentFit="cover"
          onError={clearPoster}
        />
      ) : null}
      {controls ? (
        <PlayerControls
          playing={playing}
          loading={loading}
          ended={ended}
          currentTime={currentTime}
          duration={duration}
          buffered={buffered}
          rate={rate}
          volume={volume}
          brightness={brightness}
          muted={muted}
          fullscreen={fullscreen}
          edgeToEdge={immersive}
          canVolume // native 也接播放实例音量(竖滑手势/控件钮共用)
          error={error}
          title={title}
          onToggle={onToggle}
          onSeek={seekTo}
          onSeekBy={onSeekBy}
          onSetRate={onSetRate}
          onSetVolume={onSetVolume}
          onSetBrightness={onSetBrightness}
          onToggleMute={onToggleMute}
          onToggleFullscreen={onToggleFullscreen}
          onRetry={onRetry}
        />
      ) : null}
    </View>
  );
}

// memo:舞台 rect 提交/相位切换的重渲止步于本组件(形变起点的整树重渲是
// 卡顿源之一)。宿主唯一(舞台),props 全稳定——videoProps 各字段 memo 于
// Provider、controls 为布尔、onPlayingChange 为 setState,仅换源/控件显隐
// 会真正进来重渲
export default memo(VideoPlayer);

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  fill: {
    flex: 1,
  },
  poster: {
    ...ABS_FILL,
    backgroundColor: '#000',
  },
});
