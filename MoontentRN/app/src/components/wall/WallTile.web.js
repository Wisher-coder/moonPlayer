// ============================================================================
// WallTile.web.js —— 视频墙单格(web 专用;metro 平台分流:.web.js 优先于 .js)
// ----------------------------------------------------------------------------
// 移植自 NextWeb/src/components/wall/WallTile.jsx,行为 1:1,RN-web 适配点:
//   - NextWeb 用 JSX <video> + <img>;RN-web 的 JSX 只认 RN 组件,故照
//     VideoPlayer.web.js 先例命令式 document.createElement('video') 插进容器
//     最前(RN 渲染的浮层自然盖在其上),封面用 expo-image,hls.js 走动态 import
//     (lib/lazy-hls.js,对齐 NextWeb 原版懒加载;Safari 原生分支不触发);
//   - 进度条拖动:NextWeb 拖动中 ref 直写 width 不 setState;RN 版改用
//     PlayerControls 同款 PanResponder + dragT state(项目惯用法,web 上重渲染
//     一枚 2px 小条的代价可忽略),松手 currentTime 落点 + 权威回写语义不变;
//   - hover 浮层:NextWeb 用 group-hover CSS;RN-web 用 onHoverIn/Out
//     (PlayerControls hoverProps 同款),渐变黑带降级为半透明黑条(RN 无渐变
//     原语、不引新依赖);
//   - 【黑带显形双保险(barHover),修静音/移除钮悬停闪烁】RN-web 的 Pressable
//     内部带 contain 独占 hover:内层钮(也是 Pressable)开始 hover 时经冒泡的
//     react-gui:hover:lock 自定义事件强制结束祖先 Pressable 的 hover——鼠标
//     移到钮上会令根格 hovered=false → 黑带隐藏(pointerEvents:none)→ 钮失
//     hover 发 unlock → 根恢复 → 黑带重现 → 钮又 lock……鼠标微动即高频闪烁、
//     点击全落空(2026-10 桌面端实测复现)。修法:黑带本体挂原生
//     onMouseEnter/Leave(RN-web View 直接转发,enter/leave 不冒泡,不会因子
//     元素进出误触)维护 barHover,显形条件放宽为 hovered||barHover——指针在
//     钮上时 barHover 钉住黑带,lock 只把根 hovered 压 false 一次,循环断开。
// 行为契约(照搬 NextWeb 文件头):
//   · 取流:每格独立 getWallSrc(site,id)(wall-src 的 LRU+TTL 缓存,addToWall 时
//     已后台预解析,首开命中热缓存免服务端往返),解析/挂流失败自动重试 ≤5 次
//     (递增退避 1~5s,重试轮 force 现取新地址不复读缓存死链;计数只随换 key/
//     手动重试清零),5 次后亮错误态给手动重试;hls 走 Safari 原生优先分支,
//     其余 hls.js 四档瘦身(见媒体 effect 内配置):短缓冲 maxBufferLength:6、
//     capLevelToPlayerSize 格子多小拉多清、startLevel:0 起播最低清、
//     backBufferLength:30 已播即驱逐;致命错误先恢复一次、二次清 wall-src
//     缓存项再亮错误态;
//   · 卡死看门狗:带宽饿死/解码器不足的「慢冻结」不产生任何 error 事件,重试
//     梯永远不触发——满墙时「放着放着就不动了」的根因。5s 一拍监测 currentTime,
//     应播态连续 10s 无进展即阶梯自愈(压最低清+续拉 → 复位解码器 → 走重试梯),
//     详见媒体 effect 内 watchdog 注释;
//   · 保活(秒开):媒体管线随挂载即启动(入场即预载——刷新后未开过看板也会
//     载清单并预缓冲 ~6s;关闭态不 play,无声不烧解码)。看板关闭/最小化只
//     pause 不拆流(hls 实例、缓冲、进度全保留),重开零加载从原位置续播;
//     销毁只发生在移除/清空/换源;
//   · 播放:默认**有声**自动播(打开看板的点击手势就是用户激活;被浏览器策略
//     拒绝就降级为静音续播);每格独立声音开关(点格本体/喇叭钮切换本格静音);
//     masterPaused 全局停/续只 pause/play 不拆流;**循环播放**:loop,播完自动
//     从头续播;进度账本只记最远点,绕圈回片头被防倒退守卫拦住不回写;
//   · 进度两本账:loadedmetadata 续播 item.t(片头 3s 内/片尾 10s 内不续,直接
//     重头);timeupdate 双节流——进度条镜像 ≥1s 一拍、wall-store 回写 ≥5s 一拍
//     (带防倒退守卫:大幅回退只可能是 seek 偶发失效/流重置,跳过保住进度),
//     绝不碰 history.js(墙进度与主播放进度互不踩);
//   · 比例收敛:metadata 里取 videoWidth/Height,与登记 ratio 差 > 0.02 才
//     updateWallRatio 回写,外层重排一次性收敛;
//   · 销毁:epoch 守卫(项目惯用法)——换 key/重试/卸载自增流水号,在途异步链
//     全部作废;teardown 完整序列 hls.destroy → pause → removeAttribute('src')
//     → load(),卸载前顺手补写最后一段进度。
// 并发流闸门(lib/wall/stream-gate.js,与 native 版共用同一模块):「挂流」
// (此处 = v.src 赋值 / hls.loadSource)前 acquireStream 过闸;上限 ≥ 格子数
// (缺省 16)时同步直通零开销,行为与无闸门完全一致;上限被服务端压低时超额
// 格子 FIFO 排队,移除/错误烧穿/看板关闭即释放,重开按 FIFO 复活(绑定态下
// 看板关闭进入「休眠」:还闸位 + 完整 teardown 拆流,默认档恒不触发,停车场
// 保活语义不动)。
// ============================================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Restart, VolumeUp, VolumeOff, Close } from '../icons.js';
import { loadHls } from '../../lib/lazy-hls.js';
import Spinner from '../ui/Spinner.jsx';
import { dropWallSrc, getWallSrc } from '../../lib/wall-src.js';
import { updateWallProgress, updateWallRatio, useWallOpen } from '../../lib/wall-store.js';
import { acquireStream, isStreamGateBinding } from '../../lib/wall/stream-gate.js';
import { ABS_FILL } from '../../lib/abs-fill.js';

const RED = '#ff0000'; // 进度条已播(品牌红,与 PlayerControls 同源)

// 秒 → mm:ss 徽标(两位分钟,与卡面 "58:26" 形态对齐)
function mmss(n) {
  const s = Math.max(0, Math.floor(Number(n) || 0));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

export default function WallTile({ item, masterPaused, onRemove }) {
  const open = useWallOpen(); // 看板开合(保活联动:关=暂停,开=续播)
  const videoBoxRef = useRef(null); // video 元素宿主(RN View,ref 直达 DOM div)
  const videoRef = useRef(null);    // 命令式创建的 <video>(常驻,换源不销毁)
  const hlsRef = useRef(null);      // 当前 hls.js 实例(随换源销毁重建)
  const epochRef = useRef(0);       // 媒体流水号:换源/重试/卸载后旧异步链全部作废
  const soundRef = useRef(true);    // 声音镜像(默认有声):异步挂流完成时读最新值
  const pauseRef = useRef(masterPaused); // 全局暂停镜像(effect 依赖不含它,靠 ref 透传)
  const lastWriteRef = useRef(0);   // 上次回写 store 的时刻(≥5s 节流)
  const lastUiRef = useRef(0);      // 上次刷新进度条镜像的时刻(≥1s 节流,免逐帧重渲)
  const dragRef = useRef(false);    // 拖动进行中(timeupdate 暂停刷 UI 镜像)
  const autoRetryRef = useRef(0);   // 解析/挂流失败自动重试计数(≤5,换 key/手动重试清零)
  const failTileRef = useRef(null); // 失败统一出口镜像(挂载 effect 的 DOM onError 经它调媒体轮的梯子)
  const itemRef = useRef(item);     // item 最新镜像(DOM 事件闭包防过期;进度回写每 5s 换 item 身份)
  itemRef.current = item;
  const gateRef = useRef(null);     // 当前闸位句柄(未持有时 null;错误烧穿即还)

  const [soundOn, setSoundOn] = useState(true);  // 本格独立声音开关(默认有声)
  const [hovered, setHovered] = useState(false); // 鼠标悬停(浮层显形;触屏无 hover 不受影响)
  const [barHover, setBarHover] = useState(false); // 黑带本体悬停(含钮):钉住显形,断 contain 独占 hover 的闪烁环(见文件头)
  const [src, setSrc] = useState(null);        // { type, url } 解析结果
  const [failed, setFailed] = useState(false); // 解析/播放链失败(重试用)
  const [retryKey, setRetryKey] = useState(0); // 重试流水:变化即重跑媒体 effect
  const [t, setT] = useState(0);               // currentTime 节流镜像(进度条)
  const [d, setD] = useState(0);               // duration 镜像(metadata/durationchange)
  const [dragT, setDragT] = useState(null);    // 进度条拖拽中的位置(秒;null=非拖拽)
  const [dormant, setDormant] = useState(false); // 闸门绑定态的休眠档(见开合联动 effect)

  // 还闸位(幂等):错误烧穿/换轮清理统一出口——重试梯的退避间隙与终态错误
  // 格都不占闸位,排队格子顶上
  const releaseGate = () => {
    const g = gateRef.current;
    if (!g) return;
    gateRef.current = null;
    g.release();
  };

  // 进度条几何镜像(PanResponder 换算用,PlayerControls 同款)
  const barWRef = useRef(0);
  const barXRef = useRef(0);
  const dragTRef = useRef(null);

  // ===== 常驻 video 元素:挂载即建、卸载才销毁;DOM 事件在此桥接 =====
  // 事件闭包经 itemRef/dragRef 读当下值(item 每 5s 换身份,不随渲染重绑)
  useEffect(() => {
    const box = videoBoxRef.current;
    if (!box) return;
    const v = document.createElement('video');
    v.playsInline = true;
    v.setAttribute('playsinline', ''); // iOS Safari 属性名兼容
    v.muted = true;                    // 创建期先静音,挂流完成按 soundRef 起播
    v.loop = true;                     // 墙是氛围位:播完自动从头续播,不黑格挂着
    v.preload = 'auto';                // 入场即预载(秒开第二半:停车场也在缓冲)
    v.style.cssText =
      'position:absolute;left:0;top:0;width:100%;height:100%;background:#000;object-fit:contain;';
    videoRef.current = v;
    // 插到容器最前(VideoPlayer.web.js 同款):RN 渲染的浮层天然盖在其上
    box.insertBefore(v, box.firstChild || null);

    // 续播 + 比例收敛(metadata 就绪一次)
    const onLoadedMetadata = () => {
      const it = itemRef.current;
      const t0 = it.t || 0;
      // 续播:添加时带来的进度就是起播点(片头 3s 内/片尾 10s 内不续,重头放)
      if (t0 > 3 && (!it.d || t0 < it.d - 10)) {
        try { v.currentTime = t0; } catch (_e) { /* 个别浏览器拒 seek,忽略 */ }
      }
      // 比例收敛:实播宽高与登记比例差 > 0.02 才回写(触发外层重排,一次性收敛)
      if (v.videoWidth && v.videoHeight) {
        const r = v.videoWidth / v.videoHeight;
        if (Math.abs(r - (it.ratio || 16 / 9)) > 0.02) updateWallRatio(it.key, r);
      }
      if (v.duration && isFinite(v.duration)) setD(v.duration);
    };
    // 进度条镜像 1s / store 回写 5s 双节流 + 防倒退守卫
    const onTimeUpdate = () => {
      const it = itemRef.current;
      const now = performance.now();
      if (!dragRef.current && now - lastUiRef.current >= 1000) {
        lastUiRef.current = now;
        setT(v.currentTime); // 拖动中不刷镜像:红条宽度由拖动态顶着,别被回放态顶回去
      }
      if (now - lastWriteRef.current >= 5000) {
        lastWriteRef.current = now;
        // 防倒退:大幅低于已记录进度只可能是 seek 偶发失效/流重置,跳过本次回写
        if (!(v.currentTime + 3 < it.t)) {
          updateWallProgress(it.key, Math.floor(v.currentTime), Math.floor(v.duration) || it.d);
        }
      }
    };
    const onDurationChange = () => {
      const dd = v.duration;
      if (dd && isFinite(dd)) setD(dd);
    };
    // 直挂源(mp4/Safari 原生 HLS)的元素级错误:走同一重试梯(hls.js 路径的
    // 错误由 hls fatal 分支管,此处让路防双计;重试间隙媒体轮已作废,守空引用)
    const onError = () => {
      if (hlsRef.current) return;
      const fn = failTileRef.current;
      if (fn) fn();
    };
    v.addEventListener('loadedmetadata', onLoadedMetadata);
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('durationchange', onDurationChange);
    v.addEventListener('error', onError);
    return () => {
      v.removeEventListener('loadedmetadata', onLoadedMetadata);
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('durationchange', onDurationChange);
      v.removeEventListener('error', onError);
      // 只摘元素不置空 videoRef:卸载时本 cleanup 先于媒体 effect 的 cleanup 执行,
      // 媒体 cleanup 还要读该(已摘离)元素补写最后一段进度/pause/清 src——摘离
      // DOM 后属性仍可读,顺序不能反
      if (v.parentNode === box) box.removeChild(v);
    };
     
  }, []);

  // ===== 媒体流水线:过闸(stream-gate;上限内直通零开销,超额 FIFO 排队)→
  //       取流(wall-src 缓存)→ 挂流(Safari 原生 HLS 优先 / hls.js /
  //       mp4 直挂)→ 有声自动播;挂载即启动(入场预载,关闭态由 pause 联动不
  //       play);卡死看门狗同轮创建(cleanup 一并清理,见下方 watchdog 注释);
  //       换 key/重试/卸载统一走 cleanup 的完整 teardown——**关闭/最小化在
  //       默认档(上限 ≥ 格子数)不进这里**(保活),仅闸门绑定态经休眠档进
  //       (见下方开合联动 effect)。依赖只取 item.key(+retryKey+dormant):
  //       进度回写每 5s 换 item 对象身份,媒体绝不能跟着重挂 =====
  useEffect(() => {
    if (dormant) {
      // 休眠档(仅闸门绑定态的看板关闭):闸位已在上一轮 cleanup 还掉、元素已
      // teardown,这里只归位 UI 态;重开(dormant=false)本 effect 重跑,重新
      // 过闸按 FIFO 复活
      setSrc(null);
      setFailed(false);
      return undefined;
    }
    const epoch = ++epochRef.current;
    setSrc(null);
    setFailed(false);
    setT(item.t && item.t > 3 ? item.t : 0); // 起播点先垫给进度条,免 0→t 跳变
    setD(item.d || 0);
    lastWriteRef.current = 0;
    lastUiRef.current = 0;

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
    failTileRef.current = failTile; // DOM onError 桥(挂载 effect 闭包里经 ref 调)

    let hls = null; // 登记前的半成品引用(cleanup 兜底销毁)
    let wdtArmed = false; // 看门狗布防:源已挂上(hls attach 或 v.src 赋值)后才判定,
                          // 取流解析/加载库期间的 0 进度不算卡死
    // 过闸:上限内直通(wait=null 零开销);超额 FIFO 排队,await 复活
    const gate = acquireStream();
    gateRef.current = gate;
    (async () => {
      try {
        if (gate.wait) await gate.wait; // 排队等到闸位才继续(等待中被换轮=作废)
        if (epoch !== epochRef.current) return;
        // 重试轮(retryKey>0)force 绕过缓存现取新地址:缓存 TTL 内地址死掉时,
        // 不 force 会复读同一条死链,重试永远无效
        const r = await getWallSrc(item.site, item.id, retryKey > 0 ? { force: true } : undefined);
        if (epoch !== epochRef.current) return;
        if (!r || !r.url) throw new Error('播放地址为空');
        setSrc({ type: r.type, url: r.url });
        const v = videoRef.current;
        if (!v) return;
        // Safari 原生 HLS 判定不能只信 canPlayType:部分 Chromium 对该 MIME 也
        // 返回 'maybe'(truthy),会误入原生分支——原生路径对 AES-128/VOD 流会
        // 跳段拉流后停滞。对齐 NextWeb 的稳妥判定:必须同时存在 WebKit 投屏
        // 事件(Safari 独有)才走原生,其余一律 hls.js(MSE)。
        const canNativeHls =
          typeof window !== 'undefined' &&
          !!window.WebKitPlaybackTargetPickerEvent &&
          !!v.canPlayType('application/vnd.apple.mpegurl');
        if (r.type === 'hls' && !canNativeHls) {
          // hls.js 动态加载(asyncRoutes 分包,独立 chunk 不进首屏;Safari 原生
          // 分支不触发);加载期间本 tile 已换轮/卸载则放弃本轮
          const Hls = await loadHls();
          if (epoch !== epochRef.current) return;
          if (!Hls.isSupported()) throw new Error('当前环境不支持 HLS 播放');
          // 多路墙的 hls 四档瘦身(满墙 16 格时每格只有几百像素宽):
          //   maxBufferLength:6   短缓冲省流量(原有);
          //   capLevelToPlayerSize 格子多小拉多清——ABR 不再把小格拉到 1080p,
          //                       16 路解码与带宽(代理站全量过服务器)双降,
          //                       小格上低清与高清肉眼无差;
          //   startLevel:0        起播最低清,避开满墙同开瞬间全路顶格抢带宽;
          //   backBufferLength:30 已播 30s 即驱逐——默认 Infinity 时 loop 循环
          //                       长播会让播放点后的已播缓冲无限积压内存。
          // 单 rendition 清单(无 master playlist)没有档位可选,后三档自动无效,
          // 行为不变——这类源由卡死看门狗兜底。
          hls = new Hls({
            maxBufferLength: 6,
            capLevelToPlayerSize: true,
            startLevel: 0,
            backBufferLength: 30,
          });
          let recovered = false;
          hls.on(Hls.Events.ERROR, (_evt, data) => {
            if (epoch !== epochRef.current || !data || !data.fatal) return;
            if (!recovered) {
              // 致命错误先恢复一次(对齐 NextWeb 预算),二次亮错误态
              recovered = true;
              if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
              else hls.startLoad();
              return;
            }
            dropWallSrc(item.site, item.id); // 二次仍挂:缓存项大概率是 TTL 内死链,清掉让重试现解析
            failTile();
          });
          hls.loadSource(r.url);
          hls.attachMedia(v);
          hlsRef.current = hls;
        } else {
          v.src = r.url; // mp4 直挂 / Safari 原生 HLS
        }
        if (epoch !== epochRef.current) return;
        wdtArmed = true; // 源已挂上:看门狗自此布防(下方先于起播赋值)
        v.muted = !soundRef.current; // 挂完流以最新声音态起播(默认全有声)
        if (!pauseRef.current) {
          const p = v.play();
          if (p && p.catch) {
            p.catch(() => {
              // 非静音 autoplay 被浏览器策略拒收的兜底:就地降级为静音续播,画面不断,
              // 喇叭钮仍可手动开声(点按手势下 unmute 合法)
              if (epoch !== epochRef.current || !videoRef.current) return;
              if (!v.muted) { setSoundOn(false); v.muted = true; v.play().catch(() => {}); }
            });
          }
        }
      } catch (_e) {
        failTile(); // 自动重试兜底,5 次后亮错误态(封面仍打底)
      }
    })();

    // ===== 卡死看门狗(与 hls 同轮创建/清理,epoch 守卫天然生效) =====
    // 「慢冻结」(带宽饿死/解码器池耗尽)不触发任何 error 事件,现有重试梯(只挂
    // hls fatal/元素 error)永远不点火——满墙放着放着部分格子就不动了、且资源
    // 占用看似正常,正是这个形态。判定:源已挂上(wdtArmed)、本格应播(看板开
    // 着且非全局暂停)、非 seeking、非拖拽、出过画面(wdtHadFrames 闩,初载慢
    // 不算)时,currentTime 连续 ~10s 无任何变化即卡死;loop 绕回片头的
    // currentTime 大跳变按「有变化=活着」处理不受影响。恢复阶梯每级间隔一个
    // 判定周期(~10s),任何进度都清零重来:
    //   ① 轻推:压最低清(autoLevelCapping=0,带宽饿死时高码率永远追不上)+
    //      startLoad 续拉 + 补 play(顺带覆盖 autoplay 被静默拒收的停摆);
    //   ② 复位解码器(recoverMediaError):画面冻但缓冲还在涨的解码器挂死;
    //   ③ 仍卡:dropWallSrc 清缓存走既有重试梯(force 现解析新地址)。
    // ①~② 每级只出手一次(阶梯步进保证,有进展即归零重来),防每拍重复
    // startLoad/recover 干扰 ABR 与正常播放。
    let wdtLastT = -1;   // 上一拍的 currentTime(-1=刚进入不应播态,重置)
    let wdtStuckAt = 0;  // 首次发现无进展的时刻(0=当前有进展)
    let wdtStep = 0;     // 阶梯步数(有进展即归零)
    let wdtHadFrames = false; // 出过画面/缓冲到帧数据(readyState≥2):初次加载慢
                              // (拥塞下首段 10~30s 很常见)不算卡死,重载只会更堵
    const watchdog = setInterval(() => {
      if (epoch !== epochRef.current || !wdtArmed) return;
      const v = videoRef.current;
      if (!v || pauseRef.current || v.seeking || dragRef.current) {
        wdtLastT = -1; wdtStuckAt = 0; return; // 不应播/拖拽/seek 中:不判定不累计
      }
      if (v.readyState >= 2 || v.videoWidth > 0) wdtHadFrames = true; // 帧到位即闩上
      const cur = v.currentTime;
      const now = Date.now();
      if (wdtLastT < 0 || cur !== wdtLastT) {
        wdtLastT = cur; wdtStuckAt = 0; wdtStep = 0; return; // 活着
      }
      if (!wdtStuckAt) { wdtStuckAt = now; return; }
      if (now - wdtStuckAt < 10000) return; // 连续 10s 无进展才动手
      if (!wdtHadFrames) { wdtStuckAt = now; return; } // 初载未出画面:只续期耐心不升级
      wdtStuckAt = now; // 本级已出手,下一级再等一个判定周期
      wdtStep += 1;
      const h = hlsRef.current;
      try {
        if (wdtStep === 1) {
          if (h) { h.autoLevelCapping = 0; h.startLoad(); } // 直挂源(mp4/Safari 原生)无 hls:只补 play
          const p = v.play();
          if (p && p.catch) p.catch(() => {});
        } else if (wdtStep === 2 && h) {
          h.recoverMediaError();
        } else {
          dropWallSrc(item.site, item.id); // 地址大概率已死(TTL 过期/上游换链):清缓存重解析
          failTile();
        }
      } catch (_e) { /* 本级手术失败:下拍走下一级 */ }
    }, 5000);

    return () => {
      releaseGate(); // 还闸位/撤队(幂等;错误烧穿已还过则空操作)
      clearInterval(watchdog);
      epochRef.current++; // 本轮作废(重试/换 key/卸载后,在途异步链全部失效)
      failTileRef.current = null;
      if (hls && hls !== hlsRef.current) {
        try { hls.destroy(); } catch (_e) { /* 忽略 */ }
      }
      if (hlsRef.current) {
        try { hlsRef.current.destroy(); } catch (_e) { /* 忽略 */ }
        hlsRef.current = null;
      }
      const el = videoRef.current;
      if (el) {
        // 卸载/换源前把最后一段进度补进 store(关看板/移除时不丢;key 已被移除时
        // store 端自然落空)。同样带防倒退守卫。只走 wall-store,绝不碰 history.js
        if (el.currentTime > 2 && !(el.currentTime + 3 < item.t)) {
          updateWallProgress(item.key, Math.floor(el.currentTime), Math.floor(el.duration) || item.d);
        }
        try { el.pause(); } catch (_e) { /* 忽略 */ }
        el.removeAttribute('src');
        try { el.load(); } catch (_e) { /* 忽略 */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.key, retryKey, dormant]);

  // 自动重试计数清零:只随换 key(新视频/新格子);retryKey 变化(重试轮)不清,
  // 否则每轮重置会退化成无限重试
  useEffect(() => { autoRetryRef.current = 0; }, [item.key]);

  // ===== 闸门开合联动:绑定态(上限 < 格子数,服务端 streamSlots)看板关闭即
  //       休眠(还闸位+完整 teardown 拆流),重开重走媒体 effect 按 FIFO 复活。
  //       无条件收敛而非「非绑定直接 return」:上限迁移(清单重拉收回字段 →
  //       回缺省 16)后重开看板,也能把绑定期残留的 dormant 收回 false 触发
  //       媒体 effect 复活,休眠格不会永久卡 spinner;非绑定档恒收敛 false
  //       (与 useState 初始值同,React 等值 bail-out),停车场保活(关=只
  //       pause 不拆流)语义分毫不动 =====
  useEffect(() => {
    setDormant(isStreamGateBinding() && !open);
  }, [open]);

  // ===== 声音/开合/全局暂停联动:每格独立声音开关(点格本体/喇叭钮切换本格静音,
  //       互不牵连);看板关闭/最小化 → pause 保活(缓冲保留,重开零加载续播);
  //       masterPaused 统一停/续 =====
  useEffect(() => {
    soundRef.current = soundOn;
    pauseRef.current = masterPaused || !open;
    const v = videoRef.current;
    if (!v) return;
    v.muted = !soundOn;
    if (masterPaused || !open) v.pause();
    else {
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    }
  }, [soundOn, masterPaused, open]);

  // ===== 进度条拖动 seek:hit 区比视觉条高(12px)易点;松手 currentTime 落点 +
  //       权威回写 store(绕开 timeupdate 防倒退守卫);拖动优先于格子静音切换
  //       (内层 PanResponder 赢得手势协商,天然不冒泡到根 Pressable)。
  //       PanResponder 只建一次,seekable/total 经 ref 读当下值(闭包防过期)=====
  const total = d || item.d || 0;
  const seekable = !!src && !failed && total > 0; // 未挂源/解析失败/时长未知:纯展示
  const seekableRef = useRef(seekable);
  seekableRef.current = seekable;
  const latestTotalRef = useRef(total);
  latestTotalRef.current = total;
  const barPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => seekableRef.current,
        onMoveShouldSetPanResponder: () => false, // 只从按下处接管,不抢悬停滑入
        onPanResponderGrant: (e) => {
          barXRef.current = e.nativeEvent.pageX - e.nativeEvent.locationX;
          const w = barWRef.current || 1;
          const frac = Math.max(0, Math.min(1, e.nativeEvent.locationX / w));
          dragRef.current = true;
          const tt = frac * (latestTotalRef.current || 0);
          dragTRef.current = tt;
          setDragT(tt);
        },
        onPanResponderMove: (e, g) => {
          const w = barWRef.current || 1;
          const frac = Math.max(0, Math.min(1, (g.pageX - barXRef.current) / w));
          const tt = frac * (latestTotalRef.current || 0);
          dragTRef.current = tt;
          setDragT(tt);
        },
        onPanResponderRelease: () => {
          const tt = dragTRef.current;
          dragTRef.current = null;
          setDragT(null);
          dragRef.current = false;
          const v = videoRef.current;
          const dur = v && isFinite(v.duration) && v.duration > 0 ? v.duration : latestTotalRef.current;
          if (tt == null || !v || !(dur > 0)) return;
          try { v.currentTime = tt; } catch (_e) { /* 个别浏览器拒 seek,忽略 */ }
          setT(tt);
          // 权威回写新进度:不等 5s 节流,也不走防倒退守卫(那是防流重置的)
          updateWallProgress(itemRef.current.key, Math.floor(tt), Math.floor(dur) || itemRef.current.d);
        },
        onPanResponderTerminate: () => {
          // 被系统手势打断:放弃本次拖拽不 seek(宁可不跳也不错跳)
          dragTRef.current = null;
          setDragT(null);
          dragRef.current = false;
        },
      }),
    []
  );

  const onSoundBtn = () => setSoundOn((s) => !s);
  const onRemoveBtn = () => onRemove(item.key);
  const onRetry = () => {
    autoRetryRef.current = 0; // 手动重试清零,重给完整 5 轮自动梯
    setRetryKey((k) => k + 1);
  };

  const pos = dragT != null ? dragT : t;
  const pct = total > 0 ? Math.min(100, (pos / total) * 100) : 0;
  // 右下时长徽标:优先实播总时长 d(秒),退回卡面 duration
  const durBadge = item.d || item.duration;
  const badge = typeof durBadge === 'number' && isFinite(durBadge) && durBadge > 0 ? mmss(durBadge) : durBadge || '';

  return (
    // 格身不能带 accessibilityRole="button":RN-web 会把带该 role 的 Pressable
    // 渲染成 <button>,而格内还嵌着 重试/喇叭/移除 三个真按钮,HTML 禁止 button
    // 嵌 button(真机 web 实测触发 validateDOMNesting 报错)。降级为 div 承载
    // 点击(NextWeb 原版同款:格身 div+onClick,真按钮只留给小控件);键盘可达
    // 性由 hover 条上的喇叭钮承担。native 版(WallTile.js)无此约束,保持 button。
    <Pressable
      accessibilityLabel={soundOn ? '静音本格' : '开启本格声音'}
      onPress={() => setSoundOn((s) => !s)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={styles.root}
    >
      {/* 封面打底:解析/加载中可见;起播后被 video 帧盖住 */}
      {item.cover ? (
        <Image source={{ uri: item.cover }} style={styles.cover} contentFit="cover" />
      ) : null}
      {/* 视频宿主:命令式 <video> 插在其内(absolute inset-0 contain) */}
      <View ref={videoBoxRef} style={styles.videoBox} collapsable={false} />
      {/* 解析中:封面打底 + 居中 spinner */}
      {!src && !failed ? (
        <View style={styles.loading} pointerEvents="none">
          <Spinner size={22} />
        </View>
      ) : null}
      {/* 解析失败:封面常驻 + 错误文案 + 重试(内层 Pressable 赢手势,不触发静音切换) */}
      {failed ? (
        <View style={styles.failed}>
          <Text style={styles.failedText}>解析失败</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="重试"
            onPress={onRetry}
            style={({ hovered: h }) => [styles.retryPill, h && styles.pillHover]}
          >
            <Restart size={14} color="#ffffff" />
            <Text style={styles.retryText}>重试</Text>
          </Pressable>
        </View>
      ) : null}
      {/* hover 浮层:顶部黑带(右静音/移除小圆钮,无标题——用户要求格子顶部
          不展示视频标题);本体点击在根节点上(切换本格声音);未悬停时整条断
          指针纯透明(触屏无 hover,靠点格切静音)。显形=根 hovered 或黑带自身
          barHover:后者钉住按钮区,防 contain 独占 hover 把根 unhover 时黑带
          塌掉(见文件头闪烁根因记录) */}
      <View
        style={[styles.hoverBar, { opacity: hovered || barHover ? 1 : 0 }]}
        pointerEvents={hovered || barHover ? 'auto' : 'none'}
        onMouseEnter={() => setBarHover(true)}
        onMouseLeave={() => setBarHover(false)}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={soundOn ? '静音' : '开声音'}
          onPress={onSoundBtn}
          style={styles.hoverBtn}
        >
          {soundOn ? <VolumeUp size={16} color="#ffffff" /> : <VolumeOff size={16} color="#ffffff" />}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="从看板移除"
          onPress={onRemoveBtn}
          style={styles.hoverBtn}
        >
          <Close size={16} color="#ffffff" />
        </Pressable>
      </View>
      {/* 底部进度条:白轨 + 品牌红已播;hit 区比视觉条高易点;不可拖(未挂源/
          时长未知/解析失败)时断指针纯展示;拖动时间气泡跟随 */}
      <View
        style={styles.barHit}
        pointerEvents={seekable ? 'auto' : 'none'}
        onLayout={(e) => {
          barWRef.current = e.nativeEvent.layout.width;
        }}
        {...barPan.panHandlers}
      >
        <View style={styles.barTrack}>
          <View style={[styles.barFill, { width: pct + '%' }]} />
        </View>
        {dragT != null ? (
          <View style={styles.bubble}>
            <Text style={styles.bubbleText}>{mmss(dragT)}</Text>
          </View>
        ) : null}
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
  cover: {
    ...ABS_FILL,
  },
  videoBox: {
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
  pillHover: {
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  retryText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.9)',
  },
  // hover 黑带:NextWeb 用渐变,RN 无渐变原语不引新依赖,降级半透明黑条;
  // 无标题后钮靠右(justifyContent flex-end),整条仍是钮的悬停锚区(barHover)
  hoverBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
    paddingHorizontal: 8,
    paddingTop: 6,
    paddingBottom: 24,
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  hoverBtn: {
    width: 28,
    height: 28,
    marginTop: 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
  },
  barHit: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 12,
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
  bubble: {
    position: 'absolute',
    bottom: 12,
    borderRadius: 4,
    backgroundColor: 'rgba(0,0,0,0.75)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignSelf: 'center',
  },
  bubbleText: {
    fontSize: 10,
    color: '#ffffff',
  },
  badge: {
    position: 'absolute',
    right: 4,
    bottom: 4,
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
