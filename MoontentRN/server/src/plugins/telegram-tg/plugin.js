// ============================================================================
// plugin.js —— Telegram 站点插件(TDLib 唯一引擎;仅 Node 服务端运行)
// ----------------------------------------------------------------------------
// 形状对照已删除的旧 mtproto 插件同名类(SitePlugin 契约,base.js
// 文件头):id/name/capabilities/list/search/boards/boardList/related/detail/
// resolvePlay/image/warm 与 accountBound 账号型站源标记逐一保留;数据面不再
// 经「mtproto 实现 + tdlib 运行时接管」双轨,而是直连本目录 engine.js 的
// facade(getTdlibEngine())——原 engine.adoptPlugin/_pluginMethod 的映射语义
// (boardList→listPeerVideos、detail→getVideoDetail、search→searchVideos、
// image→serveImage、resolvePlay→signStream+包装、list/boards/related→
// media 域聚合、warm→静默确保引擎就绪)全部吸收进本类方法,单一实现。
//
// 能力面(全布尔,前端按此自适应;与旧实现完全一致):
//   list=true   —— 聚合「最近视频」:前 10 个可视频对话同页取数按时间归并;
//   search=true —— 全账号视频搜索(TDLib searchMessages);
//   boards=true —— 板块=对话(前 12 个,板块页 boardList 即对话翻页);
//   tg=true     —— Telegram 专属标记(前端据此出登录页/对话目录等专属 UI);
//   其余(home/hotwords/tags/dvds/bytag/sort)一律 false,Telegram 无此概念。
//
// 防风暴红线:聚合取数并发≤4 与单对话 fail-soft 丢弃由 media 域内建
// (mapLimitFailSoft,shared.js 单一实现);TgNotLoggedInError 如实上抛(前端
// 跳登录页);归一化列表不在插件层缓存(路由层 api-cache/site-method 网关已管);
// warm 失败静默不重试(engine.warm 内建)。插件方法内部排队至引擎 start()
// 完成,不返回半初始化数据。
// ============================================================================
import { SitePlugin } from '../base.js';
import { getTdlibEngine } from './engine.js';
import { parseVideoId } from './shared.js';

// 能力表(全布尔;Object.freeze 防调用方误改)
const CAPABILITIES = Object.freeze({
  home: false, hotwords: false, tags: false, dvds: false, bytag: false,
  sort: false, list: true, search: true, boards: true, tg: true,
});

// 数字参数安全转换:非法/非正数给默认值(与 site-method.js 同款语义)
function intParam(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}

export class TelegramPlugin extends SitePlugin {
  get id() { return 'telegram'; }
  get name() { return 'Telegram'; }
  get capabilities() { return CAPABILITIES; }
  // 账号型站源(base.js 可选标记):响应按登录账号个性化,登出/换号即语义
  // 失效——site-method 网关据此跳过公共缓存层与 public Cache-Control(no-store
  // 同口径,见 routes/telegram.js 专属端点)
  get accountBound() { return true; }

  // —— 最近视频聚合:media 域 pluginList(前 10 个可视频对话同页取数,
  //    并发≤4 fail-soft,按消息时间降序归并切页) ——
  async list(o = {}) {
    const E = await getTdlibEngine();
    return E.pluginList(o);
  }

  // —— 首页板块:media 域 pluginBoards(前 12 个可视频对话,每节第一页 12 条;
  //    无视频的对话不占板块位;无 tabs——对话没有子标签概念) ——
  async boards() {
    const E = await getTdlibEngine();
    return E.pluginBoards();
  }

  // —— 板块取数 = 对话视频翻页(peerKey 即板块 id;非法对话键由数据面抛中文错) ——
  async boardList(id, o = {}) {
    const E = await getTdlibEngine();
    return E.listPeerVideos(String(id == null ? '' : id), {
      page: intParam(o.page, 1),
      size: intParam(o.size, 24),
    });
  }

  // —— 全局视频搜索(空关键词回空结果,不发上游请求) ——
  async search(kw, o = {}) {
    const E = await getTdlibEngine();
    const page = intParam(o.page, 1);
    const size = intParam(o.size, 24);
    const k = String(kw || '').trim();
    if (!k) return { items: [], page, hasMore: false };
    return E.searchVideos(k, page, size);
  }

  // —— 相关推荐 = 同对话更多视频(media 域 pluginRelated:第一页多取 1 条滤
  //    掉自身再切 size 条;hasMore 恒 true——对话视频流没有「最后一页」的
  //    可靠信号,宁可多翻一页) ——
  async related(id, o = {}) {
    const E = await getTdlibEngine();
    return E.pluginRelated(id, o);
  }

  async detail(id) {
    const E = await getTdlibEngine();
    return E.getVideoDetail(id);
  }

  // —— 播放解析:本地现签 HMAC 短时令牌(不发上游请求;未登录不拦——签名
  //    校验在 stream 端点,真取数时才需要会话) ——
  async resolvePlay(id) {
    const E = await getTdlibEngine();
    parseVideoId(id); // 校验视频 id 形态,非法即抛中文错(shared.js 单一实现)
    const t = await E.signStream(id);
    return {
      type: 'mp4',
      url: '/api/telegram/stream?u=' + encodeURIComponent(id) + '&t=' + t,
      via: 'tg',
    };
  }

  // —— 图片代理(thumbToken/avatarToken 伪 URL → 明文字节;media 域 serveImage) ——
  async image(u) {
    const E = await getTdlibEngine();
    return E.serveImage(u);
  }

  // —— 启动预热:确保引擎就绪(无凭据/失败静默不重试,engine.warm 内建) ——
  async warm() {
    const E = await getTdlibEngine();
    await E.warm();
  }
}

// 插件单例:与 registry.js 注册实例(new TelegramPlugin())同形为默认;专属
// 端点与统一分发网关现在都直连 engine facade,不再依赖运行时接管。
export const telegramPlugin = new TelegramPlugin();
