// ============================================================
// base.js —— 站点插件基类与统一归一化契约(仅 Node 服务端运行)
//
// 【统一归一化契约】(与前端契约同构,所有插件输出必须严格同构):
//   VideoItem : { id, title, cover, duration(整数秒|null), hd(bool),
//                 author?:{ id:字符串, name, avatar, verified:bool } }
//               —— cover 必须是浏览器可直接 <img> 的 URL;
//                  需要服务端解密/代理的图(如月色 .aes)必须写成
//                  '/api/img/{site}?u='+encodeURIComponent(原图地址)
//                  author 为可选字段:仅「有真实作者体系」的站点输出(前端按此
//                  条件渲染作者行,无此字段的条目不出现任何作者 icon/名称);
//                  avatar 同须浏览器可直 <img>
//   ListResult: { items:[VideoItem], page:int, hasMore:bool }
//   categories / tags 返回: [{ id:字符串, name, count:int }]
//               —— categories 条目可带可选 children:[{ id, name, count }]
//                  (站点分类为两级时输出,如 bf 模块→板块;一级站点不带此字段,
//                  前端按字段条件渲染子分类 chips;list(o.category) 须同时接受
//                  父与子 id——子 id 由插件内部路由到上游对应端点)
//   Detail    : { id, title, cover, duration, hd, resolution, uploadDate,
//                 tags:[{ id:字符串|null, name }], categories:[{ id, name }],
//                 author?:同 VideoItem.author, packageId?:int|null,
//                 gathers?:[{ id:字符串, name }] }
//               —— 不得输出任何收藏/点赞/金币/VIP/订阅价格 等社交付费字段
//                  (作者的订阅档位/金币价属付费面,一律不带出);
//                  packageId 为可选结构字段:仅存在「量贩/合集包」体系的站点输出
//                  (0/缺省=不在包,null),观看页右侧选集面板据此取片单;
//                  gathers 为可选字段:视频所属合集清单(0..n,仅含羞草;反查失败/
//                  为空不带字段),观看页合集选集面板据此逐个取整包
//   videoPackage : { id, title, description:字符串, count:int, items:[VideoItem] }
//               —— 可选方法(仅含羞草):量贩包整包片单(全量无分页),Detail.packageId
//                  指向的包;购买价/折扣价属付费面,契约红线不带出
//   author    : { id, name, avatar, verified:bool, videoCount:int }
//               —— 作者资料(authorId → 头像/名称/验证标/视频数,仅内容元数据)
//   byauthor  : ListResult(某作者的视频列表,分页)
//   authors   : { items:[AuthorItem], page, hasMore } o:{page,size,group?}
//               —— 作者/女优目录分页(仅 authors 能力站点,前端按此渲染频道目录页;
//                  AuthorItem 同 author 资料对象形态 {id,name,avatar,verified,
//                  videoCount};group 为站点自有分档(如含羞草「当红女优」分组),
//                  缺省=全量目录;fans/签名等社交字段同红线不带出)
//   home      : { notice:字符串, nav:[{ id, title }], list:ListResult }
//   hotwords  : [字符串]
//   boards    : { sections:[{ id:字符串, title, tabs?:[{ id:字符串|null, title }],
//                 list:ListResult }] }
//               —— 首页板块中间件数据源(capabilities.boards 门控,前端 boards 模式
//                  首页按 sections 渲染;tabs 为板块内子标签,id=null 表示默认档
//                  「综合/全部」;banner/合集包等非视频板块由插件自行过滤,不出现在
//                  sections;单板块取数失败由插件自行丢弃该节,fail-soft)
//   boardList : ListResult(某板块的翻页/切子标签取数,o:{page,size,tab};
//                tab 为 boards().tabs[].id,缺省/null=板块默认档)
//   dvds      : { items:[{ id, title, cover, count }], page, hasMore }
//   resolvePlay : { type:'hls'|'mp4', url, via }
//               —— url 必须是浏览器 hls.js / 原生 video 可直接消费的地址
//   refreshDomains : { changed:boolean }(可选方法,域名自动刷新)
//               —— 重跑本站入口域名/网关发现链并更新插件内基址缓存;新旧基址
//                  不同才 changed:true,刷新失败必须 fail-soft 保留旧基址。
//                  接入站点须同时在自己模块文件加载时调用 domain-refresh.js 的
//                  registerRefresher(siteId, fn) 注册同一刷新函数(5 分钟周期轮
//                  + 请求失败 urgent 触发由调度器统一节流);【未实现该方法 =
//                  该站未接入自动刷新】,list/search/detail/resolvePlay 等数据面
//                  契约与 502 错误契约不受影响
//
// —— 三区面(可选能力 zones;站方导航存在「专题/量贩/合集」类专区时实现,前端按
//    caps.zones 门控渲染专区页;仅含羞草) ——
//   subjects/packages/gathers : { items:[ZoneCard], page, hasMore }
//               —— ZoneCard: { id:字符串, title, cover, count:int }
//                  (count=区内视频数,上游无此数据时 0,前端不显角标;播放/购买等
//                  社交统计与价格字段红线不带出)
//   bysubject : ListResult(某专题的视频列表,o:{page,size,sort})
//   gather    : { id, title, description:字符串, count:int, items:[VideoItem] }
//               —— 合集整包片单(全量无分页,形态同 videoPackage;游客可读,
//                  Detail.gathers[].id 指向的合集)
//
// —— 相册面(可选能力 albums;仅站点存在相册专区时实现,前端按 caps.albums 门控) ——
//   AlbumItem : { id, title, cover, count:int, added?:字符串 }
//               —— cover 必须浏览器可直接 <img>(同 VideoItem 约定)
//   AlbumDetail : { id, title, cover, count:int, uploadDate:字符串, description:字符串,
//                   tags:[{ id:字符串|null, name }], categories:[{ id, name }],
//                   author?:同 VideoItem.author,
//                   photos:[{ url, thumb }], related?:[AlbumItem] }
//               —— photos.url=原图(看图器用)、photos.thumb=网格缩略图(瀑布流用),
//                  二者都必须浏览器可直接 <img>;related 为可选字段(详情页顺带
//                  解析出相关相册时才输出,前端按此条件渲染)
//   albumList     : ListResult(items:[AlbumItem];o.category 为相册分类 id)
//   albumSearch   : ListResult(相册搜索)
//   albumCategories : [{ id, name, count }]
//
// SitePlugin:capabilities 声明站点能力(前端按能力自适应 UI);
// 未覆盖的方法默认抛「该站点不支持此接口」——包装层捕获后回 502,
// 正常情况下前端按 capabilities 自适应不会调到不支持的方法。
// ============================================================

// 内部 helper:构造「不支持」错误,消息含插件 id 与方法名
function unsupported(plugin, method) {
  const id = plugin && plugin.id ? plugin.id : '?';
  return new Error('站点 ' + id + ' 不支持此接口:' + method);
}

export class SitePlugin {
  get id() { throw new Error('插件必须声明 id'); }
  get name() { throw new Error('插件必须声明 name'); }
  get capabilities() { return {}; }
  // 账号型站源标记(可选覆写,默认 false):true = 响应对应登录账号、登出/换号
  // 即语义失效——统一分发网关(site-method.js)据此跳过公共缓存层与 public
  // Cache-Control(改发 no-store,与账号型站源的专属端点同口径)。带账号体系
  // 的站点(如 telegram)必须覆写为 true。
  get accountBound() { return false; }

  async list(o) { throw unsupported(this, 'list'); }           // o: {page,size,sort,category}
  async search(kw, o) { throw unsupported(this, 'search'); }   // o: {page,size}
  async categories() { throw unsupported(this, 'categories'); }
  async detail(id) { throw unsupported(this, 'detail'); }
  async related(id, o) { throw unsupported(this, 'related'); } // o: {page,size}
  async home() { throw unsupported(this, 'home'); }
  async boards() { throw unsupported(this, 'boards'); }         // 首页板块清单(仅 boards 能力站点)
  async boardList(id, o) { throw unsupported(this, 'boardList'); } // 板块取数 o: {page,size,tab}
  async hotwords() { throw unsupported(this, 'hotwords'); }
  async tags() { throw unsupported(this, 'tags'); }
  async dvds(o) { throw unsupported(this, 'dvds'); }           // o: {page,size}
  async bydvd(dvd, o) { throw unsupported(this, 'bydvd'); }    // o: {page,size}
  async bytag(tag, o) { throw unsupported(this, 'bytag'); }    // o: {page,size}
  async author(id) { throw unsupported(this, 'author'); }      // 作者资料(仅 author 能力站点)
  async byauthor(author, o) { throw unsupported(this, 'byauthor'); } // o: {page,size}
  async authors(o) { throw unsupported(this, 'authors'); }     // 作者目录(仅 authors 能力站点) o: {page,size,group}
  async resolvePlay(id) { throw unsupported(this, 'resolvePlay'); }
  async subjects(o) { throw unsupported(this, 'subjects'); }       // 专题卡清单(仅 zones 能力站点) o: {page,size}
  async bysubject(id, o) { throw unsupported(this, 'bysubject'); } // 专题内视频 o: {page,size,sort}
  async packages(o) { throw unsupported(this, 'packages'); }       // 量贩包卡清单(仅 zones 能力站点) o: {page,size}
  async gathers(o) { throw unsupported(this, 'gathers'); }         // 合集卡清单(仅 zones 能力站点) o: {page,size}
  async gather(id) { throw unsupported(this, 'gather'); }          // 合集整包片单(仅 zones 能力站点)
  async albumList(o) { throw unsupported(this, 'albumList'); }         // 相册列表(仅 albums 能力站点) o: {page,size,category}
  async albumSearch(kw, o) { throw unsupported(this, 'albumSearch'); } // 相册搜索 o: {page,size}
  async albumCategories() { throw unsupported(this, 'albumCategories'); }
  async albumDetail(id) { throw unsupported(this, 'albumDetail'); }    // 相册详情(照片清单)
  async refreshDomains() { throw unsupported(this, 'refreshDomains'); } // 可选:域名自动刷新(未实现=该站未接入,见文件头)
}
