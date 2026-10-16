// ============================================================================
// preload.cjs —— 预加载桥（CommonJS）
// ----------------------------------------------------------------------------
// 后缀契约：必须 .cjs——desktop/package.json 是 type:module，沙箱渲染器的
// preload 只能是 CommonJS，.js 后缀会被按 ESM 解析而加载失败（桥整体不注入，
// 前端 isDesktopApp() 恒 false：自绘窗口控件/独立播放窗全部失效）。
// 职责：向页面注入 window.moontentDesktop 桌面桥——
//   - desktop: true           桌面壳标识（前端识别「运行在 Electron 里」）；
//   - platform                宿主平台 process.platform（macOS 红绿灯适配用）；
//   - openVideo({site,id,mode}) 打开视频播放独立窗（主进程建窗/复用，见
//                             main.js 的 moontent:open-video）；
//   - win.*                  自绘标题栏的窗口自控（最小化/最大化切换/关闭/
//                             状态查询/状态变更订阅），各窗只控自己；
//   - onNavigate(cb)         播放窗接收主进程的单窗复用切集指令
//                             （moontent:navigate → SPA 内 router.push）；
//   - wall.*                 看板跨窗同步：broadcast 把本窗看板 items 变更交
//                             主进程转发给其余窗（moontent:wall-broadcast →
//                             moontent:wall-changed，fire-and-forget 用 send），
//                             onChanged 订阅其它窗发来的变更（前端 wall-store
//                             的 setItems 统一出口触发/消费）；
//   - menu.*                 播放器菜单独立子窗（腾讯式弹层窗，main.js 的
//                             「菜单独立子窗」区）：owner 侧 show/hide/enter/
//                             leave/update/prewarm + onAction/onClosed 订阅；
//                             菜单窗侧 ready/sized/action + onState 订阅。
//                             同一组通道按发起窗各就各位（主进程按 sender
//                             反查归属），不串扰。
// 安全基线：contextIsolation 保持 Electron 默认开启、nodeIntegration 保持
// 默认关闭（main.js 的 webPreferences 未做任何放宽）；不把 ipcRenderer 或
// 任何 Node/Electron 原生对象直接暴露到页面——所有能力收窄为上面这份
// 白名单（invoke 定向通道 + 两个订阅通道，订阅句柄返回取消函数）。
// 沙箱预加载环境提供的 require 仅为 Electron 注入的子集，只取要用到的两个。
// ============================================================================

const { contextBridge, ipcRenderer } = require('electron');

// 订阅通道统一封装：返回取消函数，避免把 ipcRenderer 原样交出去
function subscribe(channel, cb) {
  if (typeof cb !== 'function') return () => {};
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('moontentDesktop', {
  desktop: true,
  // 宿主平台（process.platform，沙箱预加载环境可用）：前端判定 macOS 红绿灯
  // 适配——原生钮让位/隐藏自绘三钮（app/src/lib/desktop-bridge.js）
  platform: process.platform,
  // 打开播放独立窗：mode ∈ 'single' | 'multi'（缺省 single，见 main.js）
  openVideo: ({ site, id, mode }) => ipcRenderer.invoke('moontent:open-video', { site, id, mode }),
  // 播放窗浮钮：打开（聚焦）主界面窗口（左上）/ 窗口置顶开关（右上，桌面端专属）
  openMain: () => ipcRenderer.invoke('moontent:open-main'),
  win: {
    minimize: () => ipcRenderer.invoke('moontent:win-min'),
    toggleMaximize: () => ipcRenderer.invoke('moontent:win-toggle-max'),
    close: () => ipcRenderer.invoke('moontent:win-close'),
    getState: () => ipcRenderer.invoke('moontent:win-state'), // → { maximized }
    // 置顶开关（桌面端专属；toggle 回切换后的状态，is 查当前态）
    toggleAlwaysOnTop: () => ipcRenderer.invoke('moontent:win-toggle-top'),
    isAlwaysOnTop: () => ipcRenderer.invoke('moontent:win-top'),
    // 小窗播放开关（桌面端专属；toggle 回切换后的小窗态，is 查当前态）
    toggleMini: () => ipcRenderer.invoke('moontent:win-toggle-mini'),
    isMini: () => ipcRenderer.invoke('moontent:win-mini'),
    // 最大化状态变更（每窗各自接收，自绘标题栏图标切换用）
    onStateChange: (cb) => subscribe('moontent:win-state-changed', cb),
  },
  // 单窗复用切集指令（仅播放窗会收到）
  onNavigate: (cb) => subscribe('moontent:navigate', cb),
  // 看板跨窗同步（broadcast 无回执：send 即忘，失败静默；onChanged 见上注）
  wall: {
    broadcast: ({ items }) => ipcRenderer.send('moontent:wall-broadcast', { items }),
    onChanged: (cb) => subscribe('moontent:wall-changed', cb),
  },
  // 菜单独立子窗（owner 侧开/收/热区/状态反推 + 订阅动作与收起通知；菜单窗
  // 侧 ready/sized/action + 订阅状态。通道语义见 main.js 菜单会话区注释）
  menu: {
    // —— owner 侧（播放器所在窗调用）——
    show: (payload) => ipcRenderer.invoke('moontent:menu-show', payload), // → {ok}|{fallback:'local'}
    hide: () => ipcRenderer.invoke('moontent:menu-hide'),
    enter: () => ipcRenderer.invoke('moontent:menu-enter'), // 指针进控制条热区（撤销宽限收起）
    leave: () => ipcRenderer.invoke('moontent:menu-leave'), // 指针出热区（起 450ms 宽限收起）
    update: (payload) => ipcRenderer.invoke('moontent:menu-update', payload), // 状态反推刷新菜单窗
    prewarm: () => ipcRenderer.invoke('moontent:menu-prewarm'), // 预热（挂载即调，hover 零延迟）
    onAction: (cb) => subscribe('moontent:menu-action', cb), // 菜单选择动作（owner 落地）
    onClosed: (cb) => subscribe('moontent:menu-closed', cb), // 菜单已被收起（清开窗标记）
    // —— 菜单窗侧（/menu?win=menu 窗内调用）——
    ready: () => ipcRenderer.invoke('moontent:menu-ready'), // 挂载报到（主进程补推状态）
    sized: (payload) => ipcRenderer.invoke('moontent:menu-sized', payload), // 内容尺寸回报
    action: (payload) => ipcRenderer.invoke('moontent:menu-action', payload), // 选择动作回流 owner
    onState: (cb) => subscribe('moontent:menu-state', cb), // {kind,state} 菜单内容状态
  },
});
