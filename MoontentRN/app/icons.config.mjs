// ============================================================================
// icons.config.mjs —— 图标选型清单（按 UI 功能逐一挑选，单一事实源）
// ----------------------------------------------------------------------------
// 数据源：Iconify 的 Solar 集（@iconify-json/solar），全站统一 Linear 线性
// 变体（1.5px 圆头描边，深浅色主题均清晰）。改图标 / 加图标：改本文件后
// 跑 `npm run gen:icons` 重新生成 src/components/icons.js（勿手改生成物）。
//
// 条目格式：导出名: ['solar:图标名', '功能说明（使用点）']
// 导出名以功能语义命名（不沿用旧图标库的形状名），同一功能多处共用一个
// 导出；后续换整体风格（如 Bold 实心）只需把后缀 -linear 批量替换。
// ============================================================================

export default {
  // —— 主导航（BottomNav 底栏 / Guide 侧栏共用） ——
  Home: ['solar:home-angle-2-linear', '首页 Tab；迷你播放窗「回主界面」'],
  Category: ['solar:grid-2x2-linear', '分类 Tab；分类/分区类空态'],
  Search: ['solar:magnifier-linear', '搜索 Tab；顶栏搜索框与搜索按钮'],
  User: ['solar:user-circle-linear', '我的 Tab（个人中心）'],
  Users: ['solar:users-group-rounded-linear', '女优 Tab；作者列表/空态'],
  Gallery: ['solar:gallery-linear', '相册 Tab；相册空态与封面占位；照片缩略条开关'],
  Layers: ['solar:layers-minimalistic-linear', '专区 Tab；插件页 CMS 分组；多窗口播放模式选项'],

  // —— 导航激活态（填充形，与上面的线性名一一对照；BottomNav/Guide 共用） ——
  HomeSolid: ['solar:home-angle-2-bold', '首页 Tab 激活态（Home 的填充对照）'],
  CategorySolid: ['solar:grid-2x2-bold', '分类 Tab 激活态（Category 的填充对照）'],
  SearchSolid: ['solar:magnifier-bold', '搜索 Tab 激活态（Search 的填充对照）'],
  UserSolid: ['solar:user-circle-bold', '我的 Tab 激活态（User 的填充对照）'],
  UsersSolid: ['solar:users-group-rounded-bold', '女优 Tab 激活态（Users 的填充对照）'],
  GallerySolid: ['solar:gallery-bold', '相册 Tab 激活态（Gallery 的填充对照）'],
  LayersSolid: ['solar:layers-minimalistic-bold', '专区 Tab 激活态（Layers 的填充对照）'],

  // —— 方向 ——
  ChevronLeft: ['solar:alt-arrow-left-linear', '页头返回；照片查看上一张'],
  ChevronRight: ['solar:alt-arrow-right-linear', '「查看全部」前进；照片下一张；展开指示'],
  ChevronUp: ['solar:alt-arrow-up-linear', '折叠指示（选集/面板收起）'],
  ChevronDown: ['solar:alt-arrow-down-linear', '展开指示（选集/面板展开）'],

  // —— 播放器 ——
  Play: ['solar:play-linear', '播放（中央大按钮/迷你条/封面占位 ▶/正在播放标记）'],
  Pause: ['solar:pause-linear', '暂停'],
  PlayCircle: ['solar:play-circle-linear', '设置行「自动连播」'],
  Next: ['solar:skip-next-linear', '选集「下一集」'],
  Forward: ['solar:forward-linear', '快进 HUD（双击/拖动快进反馈）'],
  Rewind: ['solar:rewind-back-linear', '快退 HUD'],
  Speed: ['solar:playback-speed-linear', '倍速按钮与倍速 HUD；设置行「省流模式」'],
  Playlist: ['solar:playlist-minimalistic-linear', '选集面板入口；视频页选集按钮'],
  Settings: ['solar:settings-minimalistic-linear', '播放器设置菜单'],
  Pip: ['solar:pip-2-linear', '画中画 / 迷你窗'],
  FullscreenEnter: ['solar:full-screen-linear', '进入全屏（四角外扩括号）'],
  FullscreenExit: ['solar:full-screen-square-linear', '退出全屏（收进框内的向心括号）'],
  VolumeUp: ['solar:volume-loud-linear', '有声状态；音量 HUD'],
  VolumeOff: ['solar:volume-cross-linear', '静音；点按取消静音提示'],
  Wall: ['solar:widget-2-linear', '看板（多视频墙）入口与标题'],
  WallAdd: ['solar:widget-add-linear', '播放器「添加到看板」（宫格 + 加号，线性 = 未添加）'],
  WallAdded: ['solar:widget-add-bold', '播放器「已在看板」状态（与 WallAdd 同形的填充变体）'],
  Restart: ['solar:restart-linear', '重试（加载失败/错误态按钮）；播完重播'],

  // —— 反馈与状态 ——
  Alert: ['solar:danger-triangle-linear', '错误态（红三角警示，各类加载失败）'],
  Loader: ['solar:refresh-circle-linear', '加载中旋转（Spinner 包裹旋转动画）'],
  Inbox: ['solar:inbox-linear', '通用空态兜底（EmptyState 默认图标）'],
  SearchX: ['solar:magnifier-close-linear', '搜索无结果；插件搜索无匹配'],
  VideoFrame: ['solar:video-frame-linear', '视频封面占位（胶片框，各类卡片封面兜底）'],
  Clapperboard: ['solar:clapperboard-linear', '视频内容空态（暂无内容/无观看记录）'],

  // —— 通用操作 ——
  Close: ['solar:close-linear', '关闭弹层/清除输入/移除条目/窗口关闭'],
  Check: ['solar:check-linear', '选项选中；已加入看板'],
  Trash: ['solar:trash-bin-minimalistic-linear', '清除历史/搜索记录；移除看板瓦片'],
  Copy: ['solar:copy-linear', '窗口「还原」（两叠方框，Windows 惯例）'],
  Minus: ['solar:minus-linear', '窗口「最小化」'],
  WinMaximize: ['solar:maximize-square-linear', '窗口「最大化」；设置行「播放窗口模式」'],
  Verified: ['solar:verified-check-linear', '认证作者徽章'],
  Clock: ['solar:clock-circle-linear', '时长角标；搜索历史行'],
  Info: ['solar:info-circle-linear', '侧栏「关于」'],
  Notice: ['solar:bell-ring-linear', '公告栏（站点公告，铃铛=通知）'],
  More: ['solar:menu-dots-vertical-linear', '卡片「更多操作」竖三点'],
  Menu: ['solar:hamburger-menu-linear', '侧栏开关（三横线）'],
  Pin: ['solar:pin-linear', '迷你播放窗「置顶」（线性 = 未置顶）'],
  PinSolid: ['solar:pin-bold', '迷你播放窗「已置顶」状态（与 Pin 同形的填充变体）'],
  Star: ['solar:star-linear', '收藏星标（详情页/卡片收藏钮，线性 = 未收藏）'],
  StarSolid: ['solar:star-bold', '「已收藏」状态（与 Star 同形的填充变体，命名对齐 Home/HomeSolid）'],

  // —— 片源/设置行 ——
  Globe: ['solar:global-linear', '插件页「站源插件」行'],
  Send: ['solar:plane-2-linear', 'Telegram 入口（纸飞机，对话列表/登录页/设置行）'],
  Tv: ['solar:tv-linear', '插件页「CMS 资源站」行'],
  Plug: ['solar:plug-circle-linear', '设置行「插件管理」（插头=插件）'],
  Server: ['solar:server-linear', '设置行「服务器地址」'],
  Monitor: ['solar:monitor-linear', '外观「使用系统」；单窗口模式选项'],
  Sun: ['solar:sun-2-linear', '浅色主题切换；播放器亮度 HUD'],
  Moon: ['solar:moon-stars-linear', '深色主题切换'],
  Sparkle: ['solar:star-shine-linear', '设置行「液态玻璃」（iOS 26 玻璃质感）'],

  // —— Telegram 聊天（消息组件族 components/telegram/） ——
  File: ['solar:file-linear', '聊天文件卡（Telegram 文档附件图标）'],
  Poll: ['solar:list-check-linear', '聊天投票卡（Telegram 投票/测验头部图标）'],
  Keyboard: ['solar:keyboard-linear', 'bot 回复键盘（收起/展开钮，聊天输入区上方）'],
  Mic: ['solar:microphone-2-linear', '聊天语音消息卡（Telegram 语音条）'],
  MusicNote: ['solar:music-note-2-linear', '聊天音频文件卡（音频附件）'],
  Sticker: ['solar:sticker-smile-square-linear', '聊天贴纸（无图占位/静态展示标识）'],
  Location: ['solar:map-point-linear', '聊天位置消息卡（地理坐标）'],
  Reply: ['solar:undo-left-round-linear', '消息长按菜单「回复」；引用条操作'],
  Calendar: ['solar:calendar-linear', '聊天搜索条「按日期跳转」（打开消息日历面板）'],
};
