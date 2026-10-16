// ============================================================================
// VideoPlayer.web.js —— web 专用播放器(metro 平台分流:.web.js 优先于 .js)
// ----------------------------------------------------------------------------
// hls.js + 原生 <video> 元素(web 可直接用 DOM/React-DOM 原语):
//   - video 元素命令式创建、常驻 Provider 宿主内:换源只换 hls 实例/直挂 src,
//     元素本体不销毁(「跨页不断流」由 Provider 的 DOM 搬运保证,本组件只管播放);
//   - HLS:AES-128 由 hls.js 原生解密(#EXT-X-KEY 自动处理);环境不支持 MSE 时
//     回退浏览器原生 HLS(Safari 系),再不行如实报错;
//   - 致命错误先恢复一次(媒体错误 recoverMediaError/其余 startLoad,NextWeb
//     同策略),二次才放弃转错误态;
//   - 自动播放:被浏览器拦(有声自动播)→ 静音兜底 + 「点按取消静音」pill;
//   - 续播:startAt 在 loadedmetadata 后命中跳转;
//   - 控件层共用 PlayerControls(播放/暂停/进度 seek/音量/全屏/倍速/spinner/
//     错误重试/单击翻面双击播停);
//   - 全屏降级链:容器 requestFullscreen(成功确认后按视频画幅尝试
//     screen.orientation.lock,仅 Android Chrome 生效/iOS 静默)→ 不可用或
//     被拒(iPhone Safari)→ 伪全屏(经 onFakeFullscreenChange 上报 Provider
//     切舞台整窗几何,自定义控件全保留);伪全屏下横幅视频+竖屏视口时内容层
//     CSS 旋转 90°(B 站 iPhone web 模式,PlayerControls 以 rotated 对调手势轴)。
// 对外 props 与 VideoPlayer.js(native)基本一致:
//   { source:{type,url,key?}, poster, autoplay, startAt, controls, style, title,
//     onEnded, onProgress, onFlush, onRetry, instanceRef, player }
//   (player 为 native 端的共享实例注入位,web 端忽略——保持两端 props 形状一致;
//   另有 web 专属 onFakeFullscreenChange,Provider 只在 web 分支注入)
// ============================================================================
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { loadHls } from '../../lib/lazy-hls.js';
import PlayerControls from './PlayerControls.jsx';
import { useSettingsState } from '../../lib/settings.js';

// 从 video.buffered 里取「包含当前播放位置的分段」的末端(进度条缓冲长度)
function bufferedEnd(v) {
  try {
    const b = v.buffered;
    if (!b || !b.length) return 0;
    for (let i = 0; i < b.length; i++) {
      if (v.currentTime >= b.start(i) && v.currentTime <= b.end(i)) return b.end(i);
    }
    return b.end(b.length - 1);
  } catch (_e) {
    return 0;
  }
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
  onFlush, // 暂停/播完/隐藏等离散时机回调(Provider 即时落进度用)
  onRetry, // 播放失败重试(交 Provider 重新解析)
  onPlayingChange, // (playing) 播放/暂停态翻转回调(舞台迷你钮图标用)
  instanceRef, // 共享实例 ref:Provider 经它 play/pause/读进度
  player: _sharedPlayer = null, // native 端的共享实例注入位;web 端实例即本组件的 video 元素,此 prop 忽略(保持两端 props 形状一致)
  onFakeFullscreenChange, // (bool) 伪全屏几何上报:Provider 据此把舞台切整窗 rect/回 dock——容器内自行 fixed 铺满不可靠(舞台 L1 恒挂 transform,fixed 子元素被劫持为相对舞台定位)
}) {
  const boxRef = useRef(null); // 根容器(RN-web 的 View,ref 直达 DOM div)
  const fsLayerRef = useRef(null); // 伪全屏内容层(video+遮罩+控件;CSS 旋转挂这层)
  const videoRef = useRef(null); // 命令式创建的 <video>(常驻,换源不销毁)
  const hlsRef = useRef(null); // 当前 hls.js 实例(随换源销毁重建)
  const recoverRef = useRef(0); // 致命错误已恢复次数(一次为限)
  const startedRef = useRef(false); // 本轮源是否已做过 起播/续播
  const videoLandscapeRef = useRef(null); // 画幅镜像(全屏事件的闭包读最新值)
  const orientLockedRef = useRef(false); // 本轮真全屏是否成功锁过 screen.orientation(退出才需 unlock;仅 Android Chrome 能锁)

  // 最新 props 镜像(事件回调闭包防过期)
  const cbRef = useRef({});
  cbRef.current = { onEnded, onProgress, onFlush, onRetry, onPlayingChange, onFakeFullscreenChange };
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
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [fakeFs, setFakeFs] = useState(false); // 伪全屏(requestFullscreen 不可用/被拒时的兜底形态)
  const [videoLandscape, setVideoLandscape] = useState(null); // 画幅:null 未知/true 横/false 竖(方向锁/伪全屏旋转的决策输入)
  const [error, setError] = useState('');
  const [autoMuted, setAutoMuted] = useState(false);
  // 亮度(触屏左半竖滑手势):浏览器动不了系统亮度,用「视频区黑色遮罩」等价
  // 体验(1=全亮不渲染遮罩;下限 0.05 与手势侧一致),会话级不持久化
  const [brightness, setBrightness] = useState(1);

  // 画面填充偏好(全屏态生效):'fill'=cover 裁切铺满,否则 contain 完整画面
  //——与 native VideoPlayer.contentFit 同款口径(设置菜单「画面填充」)
  const settings = useSettingsState();

  // 全屏画面填充:满屏=object-fit cover(裁切铺满,黑边消除),自适应/常态=
  // contain(完整画面,黑边为视频与屏幕比例差)。常驻 video 由命令式 cssText
  // 建出(初值 contain),在此按态切换(真全屏与伪全屏同口径)
  const fsActive = fullscreen || fakeFs;
  const fillMode = fsActive && settings.playerFill === 'fill' ? 'cover' : 'contain';
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.style.objectFit = fillMode;
  }, [fillMode]);

  const onSetBrightness = useCallback((x) => {
    setBrightness(Math.max(0.05, Math.min(1, x)));
  }, []);

  // 起播(含静音兜底):有声自动播被拦 → 静音重试 + pill
  const attemptPlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const p = v.play();
    if (p && p.catch) {
      p.catch(() => {
        try {
          v.muted = true;
          setMuted(true);
          setAutoMuted(true);
        } catch (_e) {
          /* 忽略 */
        }
        const p2 = v.play();
        if (p2 && p2.catch) p2.catch(() => { /* 低电量连静音播都拒:停在暂停位 */ });
      });
    }
  }, []);

  // ===== 常驻 video 元素:挂载即建、卸载才销毁;全部 DOM 事件在此桥接 =====
  useEffect(() => {
    const layer = fsLayerRef.current;
    if (!layer) return;
    const v = document.createElement('video');
    v.playsInline = true;
    v.setAttribute('playsinline', ''); // iOS Safari 属性名兼容
    v.preload = 'auto';
    v.style.cssText =
      'position:absolute;left:0;top:0;width:100%;height:100%;background:#000;object-fit:contain;';
    videoRef.current = v;
    // 必须插到内容层最前而不是 appendChild:控件层(React 渲染)与 video 同为绝对
    // 定位,DOM 靠后者绘制在上——追加到末尾会把整个控件层(进度条/按钮)盖在
    // 视频之下,表现为「播放器没有控件」。插到 firstChild 之前让视频永远垫底
    // (React 只调和自己渲染的子树,不会挪动这个外部节点)。
    layer.insertBefore(v, layer.firstChild || null);

    // —— 事件桥(DOM → React 状态 / 外部回调)——
    const onPlay = () => {
      setPlaying(true);
      setEnded(false);
      if (cbRef.current.onPlayingChange) cbRef.current.onPlayingChange(true);
    };
    const onPause = () => {
      setPlaying(false);
      if (cbRef.current.onPlayingChange) cbRef.current.onPlayingChange(false);
      // 暂停即用户主动离开播放位:即时通知 Provider 落一次进度
      if (cbRef.current.onFlush) cbRef.current.onFlush();
    };
    const onEndedEv = () => {
      setPlaying(false);
      if (cbRef.current.onPlayingChange) cbRef.current.onPlayingChange(false);
      setEnded(true);
      if (cbRef.current.onFlush) cbRef.current.onFlush();
      if (cbRef.current.onEnded) cbRef.current.onEnded();
    };
    const onTimeUpdate = () => {
      const d = isFinite(v.duration) ? v.duration : 0;
      setCurrentTime(v.currentTime || 0);
      setBuffered(bufferedEnd(v));
      if (cbRef.current.onProgress) cbRef.current.onProgress(v.currentTime || 0, d);
    };
    const onDurChg = () => {
      setDuration(isFinite(v.duration) ? v.duration : 0);
    };
    const onWaiting = () => setLoading(true);
    const onPlaying = () => setLoading(false);
    const onCanPlay = () => setLoading(false);
    const onVolChg = () => {
      setVolume(v.volume != null ? v.volume : 1);
      setMuted(!!v.muted);
      if (!v.muted) setAutoMuted(false); // 用户主动取消静音:撤 pill
    };
    const onRateChg = () => {
      setRate(v.playbackRate || 1);
    };
    const onLoadedMeta = () => {
      setLoading(false);
      onDurChg();
      readAspect();
      // 本轮源首次就绪:先续播跳转,再自动播放(只做一次)
      if (startedRef.current) return;
      startedRef.current = true;
      const at = startAtRef.current;
      if (at > 0) {
        try {
          v.currentTime = at;
        } catch (_e) {
          /* 忽略 */
        }
      }
      if (autoplayRef.current) attemptPlay();
    };
    const onError = () => {
      // 原生直挂源(hls.js 之外的路径)的元素级错误
      if (hlsRef.current) return;
      setError('播放失败,请重试');
      setLoading(false);
    };
    // 画幅追踪:metadata/resize 时机读 videoWidth/Height(0×0 忽略——个别源
    // 首个事件未就绪;换片画幅翻转由 resize 事件覆盖)
    const readAspect = () => {
      const w = v.videoWidth || 0;
      const h = v.videoHeight || 0;
      if (w > 0 && h > 0 && videoLandscapeRef.current !== w > h) {
        videoLandscapeRef.current = w > h;
        setVideoLandscape(w > h);
      }
    };
    const onFsChg = () => {
      const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
      setFullscreen(on);
      // 进入确认后再锁方向(vidstack 模式:screen.orientation.lock 只在全屏
      // 上下文内合法,不能在 requestFullscreen 之后立刻调)。仅锁「与当前
      // 方向不同且画幅已知」的场景,失败静默——iOS Safari 全系不支持 lock,
      // 行为退化为「全屏跟设备方向」(与 YouTube 移动 web 一致,可接受)
      if (on) {
        try {
          const so = window.screen && window.screen.orientation;
          if (so && typeof so.lock === 'function' && videoLandscapeRef.current != null) {
            const want = videoLandscapeRef.current ? 'landscape' : 'portrait';
            const cur = so.type || '';
            if (!cur.startsWith(want)) {
              so.lock(want)
                .then(() => {
                  orientLockedRef.current = true;
                })
                .catch(() => {});
            }
          }
        } catch (_e) {
          /* 忽略 */
        }
      } else if (orientLockedRef.current) {
        orientLockedRef.current = false;
        try {
          const so = window.screen && window.screen.orientation;
          if (so && typeof so.unlock === 'function') so.unlock();
        } catch (_e) {
          /* 忽略 */
        }
      }
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden' && cbRef.current.onFlush) {
        cbRef.current.onFlush(); // 切后台:最后可靠写入窗口
      }
    };

    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEndedEv);
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('durationchange', onDurChg);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('canplay', onCanPlay);
    v.addEventListener('volumechange', onVolChg);
    v.addEventListener('ratechange', onRateChg);
    v.addEventListener('loadedmetadata', onLoadedMeta);
    v.addEventListener('error', onError);
    v.addEventListener('resize', readAspect);
    document.addEventListener('fullscreenchange', onFsChg);
    document.addEventListener('webkitfullscreenchange', onFsChg);
    document.addEventListener('visibilitychange', onVis);

    // 共享实例 ref(Provider 经它控制/读进度)
    if (instanceRef) {
      instanceRef.current = {
        play: () => {
          const p = v.play();
          if (p && p.catch) p.catch(() => {});
        },
        pause: () => {
          try {
            v.pause();
          } catch (_e) {
            /* 忽略 */
          }
        },
        seek: (t) => {
          try {
            v.currentTime = t;
          } catch (_e) {
            /* 忽略 */
          }
        },
        get currentTime() {
          return v.currentTime || 0;
        },
        get duration() {
          return isFinite(v.duration) ? v.duration : 0;
        },
        get playing() {
          return !v.paused && !v.ended;
        },
      };
    }

    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEndedEv);
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('durationchange', onDurChg);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('canplay', onCanPlay);
      v.removeEventListener('volumechange', onVolChg);
      v.removeEventListener('ratechange', onRateChg);
      v.removeEventListener('loadedmetadata', onLoadedMeta);
      v.removeEventListener('error', onError);
      v.removeEventListener('resize', readAspect);
      document.removeEventListener('fullscreenchange', onFsChg);
      document.removeEventListener('webkitfullscreenchange', onFsChg);
      document.removeEventListener('visibilitychange', onVis);
      if (cbRef.current.onFlush) cbRef.current.onFlush(); // 卸载兜底落进度
      // 销毁顺序:先 hls 后元素(清残留防幽灵声音)
      if (hlsRef.current) {
        try {
          hlsRef.current.destroy();
        } catch (_e) {
          /* 忽略 */
        }
        hlsRef.current = null;
      }
      try {
        v.pause();
        v.removeAttribute('src');
        v.load();
      } catch (_e) {
        /* 忽略 */
      }
      if (v.parentNode === layer) layer.removeChild(v);
      videoRef.current = null;
      if (instanceRef) instanceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ===== 换源(元素常驻不动,只换 hls 实例/直挂 src)=====
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let alive = true; // hls.js 模块在途期间换源/卸载:本轮作废(防旧流迟挂)
    // 本轮重置
    recoverRef.current = 0;
    startedRef.current = false;
    setError('');
    setLoading(true);
    setEnded(false);
    setAutoMuted(false);
    setPlaying(false);
    setCurrentTime(0);
    setBuffered(0);
    // 旧 hls 先毁(新流解析前清干净,防幽灵声音)
    if (hlsRef.current) {
      try {
        hlsRef.current.destroy();
      } catch (_e) {
        /* 忽略 */
      }
      hlsRef.current = null;
    }
    if (!source || !source.url) {
      try {
        v.pause();
        v.removeAttribute('src');
        v.load();
      } catch (_e) {
        /* 忽略 */
      }
      setLoading(false);
      return;
    }

    // 换源主体抽成闭包:Hls 为动态加载到位的 hls.js 模块(mp4 分支传 null,
    // 不触碰)。行为与旧静态 import 完全一致:MSE 优先(Safari 也不特殊化),
    // AES-128 由 hls.js 原生解密,无 MSE 环境回落 Safari 原生 HLS。
    const applySource = (Hls) => {
      let nativeSrc = false; // 是否直接挂 video.src
      if (source.type === 'hls') {
        if (Hls && Hls.isSupported()) {
          // hls.js(MSE):AES-128 HLS 原生解密;切片跨源需 CORS,挂匿名跨源属性
          try {
            v.crossOrigin = 'anonymous';
          } catch (_e) {
            /* 忽略 */
          }
          const hls = new Hls({ maxBufferLength: 30 });
          hlsRef.current = hls;
          hls.on(Hls.Events.ERROR, (_evt, data) => {
            if (!data || !data.fatal) return;
            // 致命错误先恢复一次(媒体错误 recoverMediaError,其余 startLoad)
            if (!recoverRef.current) {
              recoverRef.current = 1;
              try {
                if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
                else hls.startLoad();
              } catch (_e) {
                /* 忽略 */
              }
              return;
            }
            setError('播放中断,请重试');
            setLoading(false);
            try {
              v.pause();
            } catch (_e) {
              /* 忽略 */
            }
          });
          hls.loadSource(source.url);
          hls.attachMedia(v);
        } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
          nativeSrc = true; // Safari 系原生 HLS(无 MSE 环境)
        } else {
          setLoading(false);
          setError('当前环境不支持 HLS 播放');
          return;
        }
      } else {
        // mp4 直挂(不需要 CORS 属性,带上反而挑剔无 ACAO 头的直链)
        try {
          v.removeAttribute('crossorigin');
        } catch (_e) {
          /* 忽略 */
        }
        nativeSrc = true;
      }
      if (nativeSrc) {
        try {
          v.src = source.url;
          v.load();
        } catch (_e) {
          /* 忽略 */
        }
      }
    };

    if (source.type === 'hls') {
      // hls.js 动态加载(asyncRoutes 分包后独立 chunk,不进首屏;lib/lazy-hls.js
      // 全 App 共享一份模块 Promise)。加载期间换源/卸载由 alive 作废本轮,
      // 防旧流迟挂(幽灵声音)——与上方「先毁后建」同一不变量。
      loadHls()
        .then((Hls) => {
          if (alive) applySource(Hls);
        })
        .catch(() => {
          if (!alive) return;
          setLoading(false);
          setError('HLS 组件加载失败,请重试');
        });
    } else {
      applySource(null); // mp4 无需等待
    }
    return () => {
      alive = false;
    };
  }, [source && source.url, source && source.key, source && source.type]);

  // 海报单独同步(不触发换源:封面晚到只补属性)
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (poster) v.poster = poster;
    else v.removeAttribute('poster');
  }, [poster]);

  // ===== 控件动作 =====
  const seekTo = useCallback((t) => {
    const v = videoRef.current;
    if (!v) return;
    const d = isFinite(v.duration) ? v.duration : 0;
    const tt = d > 0 ? Math.max(0, Math.min(d, t)) : Math.max(0, t);
    if (!isFinite(tt)) return; // NaN 防线:HTML seek 算法会把 NaN 归零跳片头
    try {
      v.currentTime = tt;
      setCurrentTime(tt); // 乐观落位:timeupdate 异步,先让进度条到位不闪回旧位
      setEnded(false);
    } catch (_e) {
      /* 忽略 */
    }
  }, []);

  const onToggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (ended) {
      seekTo(0);
      attemptPlay();
      return;
    }
    if (v.paused) attemptPlay();
    else v.pause();
  }, [ended, seekTo, attemptPlay]);

  const onSeekBy = useCallback(
    (d) => {
      const v = videoRef.current;
      if (!v) return;
      seekTo((v.currentTime || 0) + d);
    },
    [seekTo]
  );

  const onSetRate = useCallback((r) => {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.playbackRate = r;
      setRate(r);
    } catch (_e) {
      /* 忽略 */
    }
  }, []);

  const onSetVolume = useCallback((x) => {
    const v = videoRef.current;
    if (!v) return;
    const vv = Math.max(0, Math.min(1, x));
    try {
      v.volume = vv;
      if (vv > 0 && v.muted) v.muted = false;
      setVolume(vv);
      if (vv > 0) setMuted(false);
    } catch (_e) {
      /* 忽略 */
    }
  }, []);

  const onToggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.muted = !v.muted;
      setMuted(!!v.muted);
    } catch (_e) {
      /* 忽略 */
    }
  }, []);

  const onUnmute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.muted = false;
      v.volume = 0.7; // 与 NextWeb 同款:恢复到 0.7 听感音量
      setMuted(false);
      setVolume(0.7);
    } catch (_e) {
      /* 忽略 */
    }
    setAutoMuted(false);
  }, []);

  // ===== 全屏降级链(video.js/vidstack 模式)=====
  // 真全屏:容器 requestFullscreen(桌面/Android Chrome;成功确认后按画幅锁
  // 方向,见 onFsChg)→ 不可用/被拒(iPhone Safari 对任意元素一律拒绝)→
  // 伪全屏(fake fullscreen):上报 Provider 把舞台几何切整窗,自定义控件全
  // 保留(video.js enterFullWindow 同款思路;旧 webkitEnterFullscreen 原生
  // 兜底弃用——进系统播放器后控件全丢)
  const enterFakeFullscreen = useCallback(() => {
    setFakeFs(true);
    if (cbRef.current.onFakeFullscreenChange) cbRef.current.onFakeFullscreenChange(true);
  }, []);
  const exitFakeFullscreen = useCallback(() => {
    setFakeFs(false);
    if (cbRef.current.onFakeFullscreenChange) cbRef.current.onFakeFullscreenChange(false);
  }, []);
  const onToggleFullscreen = useCallback(() => {
    if (fakeFs) {
      exitFakeFullscreen();
      return;
    }
    const fe = document.fullscreenElement || document.webkitFullscreenElement;
    if (fe) {
      // 退出(兼容 webkit 前缀);锁过方向的先解锁
      if (orientLockedRef.current) {
        orientLockedRef.current = false;
        try {
          const so = window.screen && window.screen.orientation;
          if (so && typeof so.unlock === 'function') so.unlock();
        } catch (_e) {
          /* 忽略 */
        }
      }
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      return;
    }
    const box = boxRef.current;
    const req = box && (box.requestFullscreen || box.webkitRequestFullscreen);
    if (req) {
      try {
        const p = req.call(box);
        // 被拒(非用户手势/策略禁用等)落伪全屏;promise 版按 reject 兜底
        if (p && p.catch) p.catch(() => enterFakeFullscreen());
      } catch (_e) {
        enterFakeFullscreen();
      }
      return;
    }
    enterFakeFullscreen();
  }, [fakeFs, enterFakeFullscreen, exitFakeFullscreen]);

  // 控件收起(小窗化/会话离场)时伪全屏同步撤——Provider 侧按相位兜底之外
  // 的双保险,防「舞台回 dock 而控件态仍全屏」的错位
  useEffect(() => {
    if (!controls && fakeFs) exitFakeFullscreen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controls]);

  // 伪全屏 CSS 旋转(B 站 iPhone web 模式):伪全屏 + 横幅视频 + 竖屏视口 →
  // 内容层以「视口高为宽、视口宽为高」居中旋转 90°,铺满竖屏持机的屏幕。
  // 控件布局在旋转层内自洽(表面 onLayout 测得旋转后宽高);手势坐标轴由
  // PlayerControls 的 rotated prop 对调(PanResponder 的 dx/dy 是屏幕坐标)
  const { width: winW, height: winH } = useWindowDimensions();
  const rotFs = fakeFs && videoLandscape === true && winH > winW;
  const fsLayerStyle = rotFs
    ? {
        position: 'absolute',
        width: winH,
        height: winW,
        left: (winW - winH) / 2,
        top: (winH - winW) / 2,
        transform: [{ rotate: '90deg' }],
      }
    : null;

  return (
    <View ref={boxRef} style={[{ flex: 1, backgroundColor: '#000', overflow: 'hidden' }, style]}>
      <View ref={fsLayerRef} style={[{ flex: 1 }, fsLayerStyle]}>
        {/* 亮度遮罩(触屏左半竖滑调低时出现):压在视频之上、控件层(zIndex 2)
            之下,pointerEvents none 不拦交互;1=全亮不渲染 */}
        {brightness < 1 ? (
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: '#000',
              opacity: 1 - brightness,
              zIndex: 1,
              pointerEvents: 'none',
            }}
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
            fullscreen={fsActive}
            rotated={rotFs}
            canVolume // web 恒有音量控件
            autoMuted={autoMuted}
            error={error}
            title={title}
            onToggle={onToggle}
            onSeek={seekTo}
            onSeekBy={onSeekBy}
            onSetRate={onSetRate}
            onSetVolume={onSetVolume}
            onSetBrightness={onSetBrightness}
            onToggleMute={onToggleMute}
            onUnmute={onUnmute}
            onToggleFullscreen={onToggleFullscreen}
            onRetry={onRetry}
          />
        ) : null}
      </View>
    </View>
  );
}

// memo:舞台 rect 提交/相位切换的重渲止步于本组件(形变起点的整树重渲是
// 卡顿源之一)。宿主唯一(舞台),props 全稳定——videoProps 各字段 memo 于
// Provider、controls 为布尔、onPlayingChange 为 setState,仅换源/控件显隐
// 会真正进来重渲
export default memo(VideoPlayer);
