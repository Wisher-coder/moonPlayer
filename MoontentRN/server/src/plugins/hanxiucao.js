// ============================================================
// hanxiucao.js —— 含羞草(fi11)站点插件(加密 JSON 网关,仅 Node 服务端运行)
//
// 逆向结论(2026-10-06 授权测试环境实测,移植自 CLI 取证版 hanxiucao_api.js / hanxiucao.js):
//   · 前端为 Vue3+Vite SPA(主包混淆),API 走独立网关域(静态资源另走
//     nasuiyile.com),网关池硬编码在主包 VITE_APP_SERVER_ADDRESS:
//     'https://a83k.aqx84.com,https://a48j.jot4v.com',轮换后需 --gw/环境变量指定;
//   · 全部 POST,请求体整体加密:{endata:加密参数,ents:加密时间戳},响应明文
//     {code:0,msg,data,traceId}。AES-256-CBC/Pkcs7,key='B77A9FF7F323B5404902102257503C2F'
//     (Utf8 传入,IV 取前 16 字节,CryptoJS 宽容超长 IV 的行为);
//   · ents=加密(本地秒+时区偏移+服务器偏移),启动先调 /base/getTimeStamp 校准,
//     未校准直接发本地秒会报 code 607「非法请求」(本插件校准失败静默降级,
//     命中 607 时强制重校准再试一轮);
//   · 游客请求头固定:Did:1 / source:1 / isShortChain:''(无需 Auth);
//   · 参数名为 key 而非 keyword(globalSearch/associationalWord),搜索须带 type:1;
//     分页字段 page/length(推荐接口 page 从 0 起,列表从 1 起);
//   · 专题模式(videos/getList 带 subjectId)实测必带 offset:0 且站方用
//     orderType:8,缺失报「参数类型错误: subjectId」;
//   · 板块体系(2026-10-06 实测,替代早前「专题合成分类」方案——站内浏览结构
//     本就不是简单分类,首页由 panel 布局块拼装,分类 tab 对本站整体移除):
//     /panel/get panelId=171(首页面板)Layouts 即板块清单,layoutCode:
//     banner=广告位(跳过)/rowHalf=左右双板块(新片速递+新片限免,拆两条)/
//     row=单行板块(猜你喜欢/正在热播/付费精选/会员精选)/rowGroup=带子标签
//     板块(国产/主播/日韩/欧美/动画热推,lables 为 class 型子标签)/
//     videoPackage=量贩合集包(16-32 部打包售钻石,与板块模型不符,首页布局块
//     不接;详情侧的量贩选集另见下方「量贩视频集」条,已接);
//     布局块取数参数(浏览器实抓解密):POST /videos/getList {page,length,offset,
//     orderType,typeIds:[...],payType:[...],tags:[]}——参数名是 typeIds 数组
//     而非 typeId;分页只认 offset(page 被上游忽略,页码换算 offset 发包);typeIds 为扁平 class id 空间:4国产 5自拍 6偷拍 7私拍
//     8在校学生 9迷奸 10角色扮演 · 11主播 12-16 · 17日韩 18-22,32 · 23欧美
//     24-28 · 29动画 30 3D 31同人 33萝莉 34中文字幕(子标签与大区同空间,
//     切子标签即单发子类 id);orderType:1最新 2热播 3推荐 4播放量 5点赞
//     6收藏 7综合 8专题;payType:1限免 3付费 4VIP;导航 12 面板 panelId:
//     171首页 209专题 173传媒 220量贩 172合集 182女优 180今日上新 175国产
//     176主播 177日韩 178欧美 179动漫;另:站方 PC 端部分请求已轮换动态
//     aes key(getApiVersion/forceConsumeEncrypt 协商),游客静态钥路径仍放行
//     (实测 typeIds 请求成功),本插件不受影响;
//   · 女优体系(2026-10-06 ycbz5.com 镜像实测,与 fi11 同白标同网关同密钥,
//     游客态全通):/user/getUpList 三形态——{uids:[id],page,length} 按 uid 精确
//     取资料({id,avatar,avatar_thumb,user_nicename,signature,fans,videoCount});
//     {page,length} 全量女优目录(count≈642);{uids:[],groupIds:[1],filterIds:[],
//     isManualBack:1,page,length} 当红女优分组(count=20,站方女优面板 182
//     upScroll 块同款)。女优片单走 /videos/getList {uid,page,length,offset,
//     orderType:1,payType:[]}(count=作品总数,offset 翻页同板块;播放页「女优
//     主题」行即此形态)。作者随行:getList 条目 userInfo、getInfo 的 info.uid+
//     info.userInfo(globalSearch 条目无 userInfo,按字段条件渲染不出现作者行);
//     头像 .aes 与封面同密钥同形态(AES-128-ECB→data:image base64),走同一
//     图片代理。站方 SPA 游客态女优卡无点击事件(个人中心不对游客开放),
//     「进入个人中心查看详情」由前端作者页(/author/{site}/{id})承接。
//   · 量贩视频集(2026-10-06 浏览器实抓,播放页右侧片单链路):/videos/getInfo 的
//     info.videoPackageId 标识本片所属量贩包(0/缺省=不在包);POST
//     /videoPackage/getDetail {videoPackageId} 游客可取,整包全量无分页:
//     data.info={videoPackageId,name,videoCount,description,coverImgUrl,videos:[
//     {id,name,coverImgUrl(.aes),length(秒),seeCount,likeCount,tags,isVertical,…}]}
//     (与 gather 合集是两套体系,油猴台只接了 gather 入口;point/discountPoint
//     等价格字段按契约红线不带出,条目走 normItem 白名单归一)
//   · 三区(2026-10-06 ycbz5.com 浏览器实抓,明文参数经 JSON.stringify 钩子捕获,
//     请求体仍走本插件加密层):站方导航 专题/量贩/合集 三专区,各自清单端点——
//     ① 专题:面板 209 的 layoutCode=subject 块 layoutContent.list 即专题 id 表,
//       卡片批量取 POST /subject/list {page,length,subjectIds}(orderType/orderMode
//       传 null 被 clean 删,站方同样不发)→ {list:[{id,name,coverImgUrl(.aes),
//       backgroundImgUrl,description,hotCount}],count}(上游无视频数字段,卡 count=0);
//       专题内视频 = getList 带 subjectId(page/length/offset/orderType,缺省 8=推荐档,
//       实测 最新=1 最热=2,站方 topicDet 页三 tab 同源);/subject/get {id} 只有
//       名称/描述,视频数仍无——故不单独做专题详情,卡直链 ?subject= 列表模式;
//     ② 量贩:POST /videoPackage/getList {orderType:1,length,page} → {list:[{
//       videoPackageId,name,coverImgUrl(.aes),description,videoCount,…}],count=211},
//       条目价格字段(point/discountPoint)红线不带出;整包详情走既有 getDetail;
//     ③ 合集:POST /gather/getList {page,length,gatherType:1} → {list:[{gatherId,
//       name,coverImgUrl(.aes),description,videoCount,videoSeeCount,buyCount,…}],
//       count};详情 POST /gather/getDetail {gatherId} 游客可读整包全量(info.videos
//       形态同量贩 getDetail,与 videoPackage 是两套体系)——站方合集卡是新窗口开
//       play/video/0?cid=&isGather=true 播放页(右栏「合集 (1/N)」选集队列即此数据),
//       游客态 SPA 卡片点击仅开新窗、不显式路由,故本插件按详情端点直读;
//       视频侧反查 POST /gather/getListByVideoId {videoId} → {list:[{gatherId,name}]},
//       detail 的可选 gathers 字段由此而来(播放页合集选集面板的数据源)。
//   · 封面 .aes 文件:base64(AES-128-ECB 密文),密钥 '46cc793c53dc451b'
//     (提取自主包 Ze() 函数),解密得 UTF-8 串,本体又是 data:image/...;base64
//     数据 URL——须服务端双层解开走图片代理;
//     (2026-10-06 补测:老片封面密文尾块为零填充而非 PKCS#7,须关自动填充
//     校验手动裁尾,否则老封面一律 502——新旧两代同钥同模式,仅收尾填充不同)
//   · 播放三级(移植自油猴取证台 pnk3n 插件的 resolvePlaylist 链,2026-10-06 复测):
//     ① /videos/v2/getUrl {videoId}:游客有权限的免费/已购视频直出全片签名 m3u8;
//     ② /videos/getPreUrl {videoId}:零鉴权(无/伪造 Auth 一律放行)出带 start/end
//        试看窗口的签名 URL——签名只校验参数存在、不校验其值,窗口改写
//        start=0&end=99999 重放即得全片媒体清单(切片随机名在清单内免枚举);
//     ③ 两级清单/切片/key.key 均 ACAO:* 浏览器 hls.js 直连,切片免签,
//        #EXT-X-KEY AES-128 层 hls.js 自动处理;
//     VIP 专享且试看入口关闭的视频(实测 #7024:isVip=1/isNeedLogin=1/getPreUrl
//     空串,同油猴台 14461-14470/28753 批次结论)游客侧无签名入口,属服务端
//     防线——如实报精确诊断;配 HXC_TOKEN(VIP 账号 token)后①级直读可播。
//   · CDN 签名设计缺陷(2026-10-06 实测,供站方加固):
//     ① sign 不绑路径——任一视频的有效 sign 原样搬到另一视频的清单路径照样
//        放行(#18796 的 sign 重放到 #78414 变体路径,返回 78414 真实 567 段);
//     ② start/end 只验存在不验值(已知,窗口改写即全片);
//     但两者均无法解锁「路径从未被签发」的视频:媒体路径 /read/{日期}/{8位随机}/
//     与 /vc/{目录}/{4位随机}.m3u8 的随机段 62^8/62^4 不可枚举、目录列表 404、
//     rand 无哈希规律,而 #7024 全邻域(6999-7100)试看全关——路径无任何游客
//     可见渠道泄露,渗透面收口于此。
//   · 越权边界地图(2026-10-06 对照实测,23 片采样):
//     可越权三类——免费片(canPlay=true,v2 直取)、开试看 VIP 片(getPreUrl+
//     窗口改宽,#78414:567 段/#18796:2857 段/#630(2018):704 段)、开试看金币片
//     (v2 2003 需购买照样走②级,#68431:204 段);偶发 getPreUrl 发地址但媒体
//     已清理 404(#35381/read/20220905)→ assertPlaylist 如实报错。
//     不可越权一类——试看签发关闭的 VIP 专享片(2019-2023 各年代均有,按片
//     服务端配置);判据上 getInfo 全字段无判别力(isSetPre/tStat/urlId 恒同,
//     canPrePlay 双向不可靠:#35381=false 却有地址、#57953=true 却没有),
//     唯一探测法即 getPreUrl 本身;PC 前端对 VIP 片零取流请求(video_play
//     分块仅 /videos/v2/getUrl,试看属 H5/APP 侧流程),故页面侧无新攻击面。
//   · 新老可播差异成因(2026-10-06 媒体路径断代实测):站方 2023-07-13~16 做
//     过老片批量重处理迁移(2018/2020 代可播片媒体全在 /read/2023071{3,4,6}/,
//     按上传年代顺序逐日迁);2022-2024 原生 /read/{上传日}/;2025+ 现行
//     /vc/{n}。#7024/#7463/#14237 被该批次跳过——媒体无现行 CDN 索引且无试看
//     资产,即「老片不能播」的根因;H5 壳(移动 UA 同网关同密钥)试看流程为
//     裸 getPreUrl{videoId},preBuy 仅价格预览、buy/downBuy 需登录,无绕过面。
//     播放源猜测面量化收口(2026-10-06):rand8/rand4 为真随机(md5/sha1/sha256/
//     b64 × 11 种输入构造 × 4 切片位公式族全未命中),rand8 空间 ≈3.9e13(观测
//     字符集 50);2019 原生路径形态零样本(该年代全关)不可观测;老片封面为
//     番号命名 hash 路径且不随迁移重生成,无日期 oracle——有界请求预算内
//     猜测必败,无界扫描属请求风暴不做。
//   · 账号层提权实测(2026-10-06,全部关闭):注册无邮箱验证无验证码
//     (captcha/getConfig → captchaTypes:[],UI 秒注秒得 token——账号卫生
//     问题供站方加固);userReg 需邮箱形态+密码双层密文(AES-128 key=iv=
//     '0123456789123456',主包 VITE_APP_AES_PASSWORD_KEY 弱硬编码,加固项);
//     token=base64(随机32hex会话钥|uid|P),opaque 非 JWT,uid/尾标篡改一律
//     700(会话与 uid 服务端绑定);userReg 与 /user/updateFields(fields 为
//     JSON 串形态)注入 vip/isVip/level/money/coin/userType 全被白名单忽略
//     (注入 code=0 但 levelInfo 恒 level 1,v2/getUrl 恒 2002);真实非 VIP
//     账号对 #7024 同为 2002/空——权限轴收口与 HXC_TOKEN 结论互证。
//   · 服务端输入面/IDOR/旁路通道检测(2026-10-06,检测级):搜索/联想/列表/
//     详情参数对 SQL 形态探针('、"、OR、UNION--、%、`)一律按字面量处理
//     (code=0 count=0,无任何 SQL 错误签名),数值字段严格类型校验(5001)——
//     参数化查询特征;用户域端点(getHistory/getBuy/getCollection/chargeLog)
//     带 uid 参数全被忽略,数据域锁 token 会话(IDOR 关闭);代理/创作者/
//     平台通道(/account/*、/platform/*、/own/*)本站网关 404 未部署。支付流
//     (prepareCharge/prepareVip/buySubscription)仅代码层梳理:购买需登录态
//     +余额,vipId 服务端校验(1015)——主动篡改金额/伪造回调属实际盗取,
//     越过授权测试边界,不做。
//   · 桌面客户端(Electron,站配置 exeDownUrl 指向静态域 update/ 分发,逆向自
//     解包 app.asar):electron/.env 同双网关(倒序)、getConfig.js 同 AES 钥
//     (仅更新器用)、渲染层播放端点仅 /videos/v2/getUrl(无试看流程);新端点
//     仅 /visitor/getStatus(游客 {status:0})与 /base/getImUrl(IM wss 地址),
//     创作者系 /own/* 端点在本站网关 404 未部署;Did/source 3/4/5/9 客户端
//     形态变体权限不变——三代客户端(PC/H5/exe)同后端同权限模型,无独立面。
//     (另:exe 生产包留有 Ctrl+Shift+B 开 DevTools 的调试后门,客户端向发现,
//     供站方加固。)
//
// 网关策略(三层来源,优先级从高到低):
//   ① 环境变量 HXC_GATEWAY 有值 → 单网关直连,【完全禁用】自动发现(人工指定最高优先);
//   ② 自动发现网关池 discoveredGateways(下方 discoverGateways 发现链:发布页入口
//      www.fi11.xyz/fi11.xyz → 中转页 copy-btn 最新前端域 → 前端主包提取网关池 →
//      /base/getTimeStamp 逐个验活;由 domain-refresh.js 统一调度——5 分钟周期轮 +
//      请求失败 urgent 触发;发现链移植自 CLI 取证版 Nodejs/hanxiucao.js);
//   ③ 内置 GATEWAYS 双网关(2026-10-06 提取自主包)——最终兜底,永不删除。
// 请求失败(HTTP≥400/网络错)换下一网关;业务错(code!==0)换网关无意义,直接抛;
// 全部网关网络错时先 urgent 刷新域名,changed 则用新网关池再走一轮(每请求至多一次)。
// 登录态(可选,同字母圈 ZMQ_COOKIE 模式):HXC_TOKEN=fi11.com 登录后 localStorage
// 的 token 值(带不带引号均可)→ 全部请求带 Auth 头,VIP 专享片由此走 v2/getUrl
// 直读(油猴台"站点登录态被动直读"的服务端等价物);游客留空行为不变。
const authToken = () => (process.env.HXC_TOKEN || '').trim().replace(/^["']+|["']+$/g, '');
// ============================================================
import crypto from 'node:crypto';
import { SitePlugin } from './base.js';
import { registerRefresher, requestUrgentRefresh } from './domain-refresh.js';

const GATEWAYS = ['https://a83k.aqx84.com', 'https://a48j.jot4v.com']; // 2026-10-06 提取自主包
// 自动发现的网关池(模块级,discoverGateways 写入):非空时优先于内置 GATEWAYS;
// 内置兜底永不删除(发现失败/未发现时最终落回 GATEWAYS)
let discoveredGateways = { at: 0, list: null };
const API_KEY = Buffer.from('B77A9FF7F323B5404902102257503C2F', 'utf8'); // 32B → AES-256
const API_IV = Buffer.from('B77A9FF7F323B5404902102257503C2F'.slice(0, 16), 'utf8'); // CryptoJS 只用 IV 前 16B
const IMG_KEY = Buffer.from('46cc793c53dc451b', 'utf8'); // .aes 封面独立密钥(AES-128-ECB)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;
const SYNC_TTL = 10 * 60 * 1000;   // 时间校准有效期(ents 时间帧漂移兜底)
const BOARDS_TTL = 10 * 60 * 1000; // 首页面板(板块清单)缓存有效期
const BOARDS_DATA_TTL = 60 * 1000; // boards() 聚合结果短缓存(板块页取标题/tabs 复用,防整组重拉)
const PANEL_HOME = 171;            // 首页面板 id(2026-10-06 实测;panel/list 实测返回空)
const PANEL_SUBJECTS = 209;        // 专题面板 id(布局 subject 块携带专题 id 表,详见文件头「三区」)
const PKG_TTL = 10 * 60 * 1000;    // 量贩包片单缓存有效期(包内容基本静态)
const ZONES_TTL = 10 * 60 * 1000;  // 专题 id 表缓存有效期(面板布局级数据,同面板节奏)
// 前端三档排序键 → 上游 orderType(1=最新 2=最热;缺省/推荐档=8=专题,站方 topicDet
// 页三 tab 同源:推荐8/最新1/最热2;人气无独立档,与最热并列走 2)
const ORDER = { post_date: 1, video_viewed: 4, most_popular: 4 };
const SUBJ_ORDER = { post_date: 1, video_viewed: 2, most_popular: 2 };

// ============ 加密层(与主包 ve()/Me() 逐字节对齐) ============

function ve(plain) { // AES-256-CBC/Pkcs7 → base64(请求体/时间戳共用)
  const c = crypto.createCipheriv('aes-256-cbc', API_KEY, API_IV);
  return Buffer.concat([c.update(Buffer.from(String(plain), 'utf8')), c.final()]).toString('base64');
}

// 主包预处理:删除值为 ''/null/undefined 的键(空参不发包;克隆后改,不动调用方对象)
function clean(obj) {
  const empty = ['', null, undefined];
  const out = { ...obj };
  for (const k in out) if (empty.includes(out[k])) delete out[k];
  return out;
}

// ents 帧换算:本地秒+时区偏移(分钟→秒)+服务器偏移;偏移由 getTimeStamp 定期校准
let srvOffset = 0;
let srvSyncAt = 0;
const entsNow = () => ve(Math.floor(Date.now() / 1000) + new Date().getTimezoneOffset() * 60 + srvOffset);

// 生效网关池:HXC_GATEWAY(有值即禁用自动发现)> 自动发现池 > 内置兜底
const gwList = () => (process.env.HXC_GATEWAY
  ? [String(process.env.HXC_GATEWAY).replace(/\/+$/, '')]
  : (Array.isArray(discoveredGateways.list) && discoveredGateways.list.length ? discoveredGateways.list : GATEWAYS));

// 温和重试(共 2 次隔 1.5s):本地代理对网关域偶发 TLS/连接抖动;仅网络错重试,防请求风暴勿加码
async function fetchRetry(fn, tries = 2, gapMs = 1500) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; if (i < tries - 1) await new Promise((r) => setTimeout(r, gapMs)); }
  }
  throw lastErr;
}

async function rawPost(gw, path, payload) {
  const res = await fetchRetry(() => fetch(gw + path, {
    method: 'POST',
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Accept': 'application/json, text/plain, */*',
      'Did': '1', 'source': '1', 'isShortChain': '', // 游客固定头(逆向自主包拦截器)
      ...(authToken() ? { Auth: authToken() } : {}),  // 登录态:主包拦截器同款 Auth 头
      'User-Agent': UA,
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    body: JSON.stringify({ endata: ve(JSON.stringify(clean(payload))), ents: entsNow() }),
  }));
  if (!res.ok) throw new Error('上游 HTTP ' + res.status + ' @' + gw);
  const j = await res.json();
  if (j.code !== 0) throw new Error('含羞草接口 code=' + j.code + ' ' + (j.msg || '') + ' @' + path);
  return j.data;
}

// 时间校准:getTimeStamp 拿服务器帧算残差;失败静默(校验宽松,残差 0 兜底)
async function ensureSync() {
  if (Date.now() - srvSyncAt < SYNC_TTL) return;
  for (const gw of gwList()) {
    try {
      const d = await rawPost(gw, '/base/getTimeStamp', {});
      if (d && d.timeStamp) {
        srvOffset = d.timeStamp - (Math.floor(Date.now() / 1000) + new Date().getTimezoneOffset() * 60);
      }
      srvSyncAt = Date.now();
      return;
    } catch (e) { /* 换下一网关 */ }
  }
}

// API 底座:先校准再发包;命中 607(时间帧漂移)强制重校准再试一轮
async function api(path, payload) {
  await ensureSync();
  try {
    return await apiOnce(path, payload);
  } catch (e) {
    if (!/code=607/.test(e.message)) throw e;
    srvSyncAt = 0;
    await ensureSync();
    return apiOnce(path, payload);
  }
}

// API 单轮:遍历网关池,网络错换下一网关;业务错(错误消息含「含羞草接口」)直接抛
async function apiOnceRound(path, payload) {
  let lastErr = null;
  for (const gw of gwList()) {
    try { return await rawPost(gw, path, payload); }
    catch (e) {
      if (/含羞草接口/.test(e.message)) throw e; // 业务错误换网关无意义
      lastErr = e;
    }
  }
  throw lastErr || new Error('含羞草全部网关不可达');
}

// apiOnce:全部网关网络错时,先 urgent 刷新入口域名(单站 60s 冷却/在途共享,见
// domain-refresh.js),changed 则用新 gwList() 再走一轮;仍失败抛原错误。
// 每次调用至多一次 urgent 重试;业务错不经过此钩子(与网关无关);fetchRetry
// 温和重试语义不动
async function apiOnce(path, payload) {
  try {
    return await apiOnceRound(path, payload);
  } catch (e) {
    if (/含羞草接口/.test(e.message)) throw e; // 双保险:业务错不做域名刷新
    try {
      const r = await requestUrgentRefresh('hanxiucao');
      if (r.changed) return await apiOnceRound(path, payload);
    } catch (e2) { /* urgent 刷新自身异常按未变更处理 */ }
    throw e;
  }
}

// ============ 入口域名自动发现(发布页 → 中转页 → 前端主包 → 网关池验活) ============
// 发现链移植自 CLI 取证版 Nodejs/hanxiucao.js(L84-129:跳转链解析/中转页签名/
// copy-btn 解析),并按取证版 hanxiucao_api.js 的主包结论多走一步:拉最新前端域的
// 主包文本提取 VITE_APP_SERVER_ADDRESS 网关池。全链串行、单请求 15s 超时;任一
// 环节落空一律 fail-soft 返回 {changed:false}(绝不把还能用的网关刷没)。

const PUBLISH_ENTRIES = ['www.fi11.xyz', 'fi11.xyz']; // 发布页入口(站群轮换,2026-10-06 实测,www 优先)
const DISCOVER_MAX_HOPS = 3;                          // 发布页→中转页 JS 跳转最大跟进层数(防循环,取证版同款)

// 发现链专用 HTML 抓取(浏览器头 + 15s 超时;与播放清单 fetchText 分开,互不影响)
async function fetchHtml(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow', // http 入口 302 自动跟(取证版同款);https 入口为 JS 壳页,靠下方跳转解析
      signal: ac.signal,
      cache: 'no-store',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

// 壳页 JS 跳转目标(location.href 赋值 / meta refresh 双保险,取证版 L84-88 同款)
const extractRedirect = (html) =>
  (html.match(/location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i) || [])[1]
  || (html.match(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']?\s*\d+\s*;\s*url\s*=\s*([^"'>\s]+)/i) || [])[1]
  || null;

// 中转页壳签名(取证版 L91-94):标题含「中转页」或存在 data-clipboard-text 地址属性
const isTransit = (html) =>
  /<title>[^<]*中转页[^<]*<\/title>/i.test(html) ||
  /data-clipboard-text\s*=\s*["']https?:\/\//i.test(html);

// data-clipboard-text 的值可能裸域无协议,统一补 https://(取证版 normalizeUrl 同款)
const normalizeOrigin = (u) => (/^https?:\/\//i.test(u) ? u : 'https://' + u);

// 中转页 → 最新前端域数组(copy-btn 的 data-copy-prefix 标签 + data-clipboard-text
// 地址逐个配对,取证版 L100-129 同款;站方日后加备用地址行会自动多收)
function parseTransitOrigins(html) {
  const out = [];
  const btnRe = /<div[^>]*class="[^"]*copy-btn[^"]*"[^>]*>/gi;
  let m;
  while ((m = btnRe.exec(html))) {
    const raw = (m[0].match(/data-clipboard-text\s*=\s*"([^"]*)"/) || [])[1] || '';
    if (raw.trim()) out.push(normalizeOrigin(raw.trim()));
  }
  return [...new Set(out)];
}

// 单入口全链路:https 失败再试 http(串行);跳转链最多 DISCOVER_MAX_HOPS 层;
// 返回中转页解析出的最新前端域数组(发布页根本身即中转页的形态也兼容);
// 失败抛错由调用方换下一入口
async function resolveEntryOrigins(host) {
  let lastErr = null;
  for (const scheme of ['https', 'http']) {
    try {
      let url = scheme + '://' + host + '/';
      let r = await fetchHtml(url);
      if (r.status >= 400) throw new Error('入口 HTTP ' + r.status);
      for (let hop = 0; hop <= DISCOVER_MAX_HOPS; hop++) {
        if (isTransit(r.text)) {
          const origins = parseTransitOrigins(r.text);
          if (origins.length) return origins;
          throw new Error('中转页无最新地址数据');
        }
        const next = extractRedirect(r.text);
        if (!next) throw new Error('页面无跳转目标(HTTP ' + r.status + ')');
        url = next;
        r = await fetchHtml(url);
      }
      throw new Error('跳转层级超过 ' + DISCOVER_MAX_HOPS + '(疑似循环)');
    } catch (e) { lastErr = e; /* 换下一协议 */ }
  }
  throw lastErr || new Error(host + ' 全协议失败');
}

// 主包文本 → 网关候选池(两种策略都试;主包经 javascript-obfuscator 混淆,提取
// 可能落空——落空由调用方 fail-soft):
// ① SERVER_ADDRESS 常量串定位,取其附近窗口内的 https 地址(混淆后变量名不可认);
// ② 逗号相连的 https 域名字面量(网关池硬编码形态 'https://a.b.com,https://c.d.com')
function extractGatewaysFromBundle(js) {
  const urlRe = /https:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/gi;
  const found = [];
  const push = (u) => { const v = u.trim().replace(/\/+$/, ''); if (v && !found.includes(v)) found.push(v); };
  const idx = js.search(/SERVER_ADDRESS/i);
  if (idx >= 0) {
    const win = js.slice(Math.max(0, idx - 400), idx + 400);
    for (const m of win.matchAll(urlRe)) push(m[0]);
  }
  for (const m of js.matchAll(/https:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\s*,\s*https:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,})+/gi)) {
    for (const part of m[0].split(',')) push(part);
  }
  return found;
}

// 前端域 → 首页 HTML → 主包 script src(形如 /assets/index-<hash>.js 的 module
// script)→ 主包文本提取候选网关;任一步落空抛错由调用方换下一前端域
async function fetchBundleGateways(origin) {
  const home = await fetchHtml(origin);
  if (home.status >= 400) throw new Error('前端首页 HTTP ' + home.status);
  const m = home.text.match(/<script[^>]+src="([^"]*\/assets\/index-[a-z0-9_-]+\.js[^"]*)"/i);
  if (!m) throw new Error('首页未找到主包 script');
  const js = await fetchHtml(new URL(m[1], origin + '/').href);
  if (js.status >= 400) throw new Error('主包 HTTP ' + js.status);
  return extractGatewaysFromBundle(js.text);
}

// 域名刷新函数(注册给 domain-refresh.js 调度):发布页入口 → 中转页最新前端域 →
// 主包网关候选 → POST /base/getTimeStamp 逐个验活(rawPost 复用,活的按序收录)。
// HXC_GATEWAY 有值时完全禁用;入口/前端域/主包提取落空、候选为空或全部验活
// 失败 → fail-soft 返回 {changed:false} 保留现状(内置 GATEWAYS 兜底永不删除)
async function discoverGateways() {
  if (process.env.HXC_GATEWAY) return { changed: false };
  // ① 入口 → 最新前端域(入口串行,https→http,首个成功入口即止,取证版同款)
  const origins = [];
  for (const host of PUBLISH_ENTRIES) {
    try {
      origins.push(...await resolveEntryOrigins(host));
      break;
    } catch (e) { /* 换下一入口 */ }
  }
  if (!origins.length) return { changed: false };
  // ② 前端域 → 主包网关候选(串行,首个提出非空候选池即止)
  let candidates = [];
  for (const org of origins) {
    try {
      const gws = await fetchBundleGateways(org);
      if (gws.length) { candidates = gws; break; }
    } catch (e) { /* 换下一前端域 */ }
  }
  if (!candidates.length) return { changed: false };
  // ③ 候选逐个验活(串行;rawPost 自带 15s 超时与温和重试,验活不过即弃)
  const alive = [];
  for (const gw of candidates) {
    try { await rawPost(gw, '/base/getTimeStamp', {}); alive.push(gw); } catch (e) { /* 换下一候选 */ }
  }
  if (!alive.length) return { changed: false };
  const prev = Array.isArray(discoveredGateways.list) && discoveredGateways.list.length
    ? discoveredGateways.list : GATEWAYS;
  discoveredGateways = { at: Date.now(), list: alive };
  return { changed: JSON.stringify(alive) !== JSON.stringify(prev) };
}
registerRefresher('hanxiucao', discoverGateways);

// ============ 首页面板 → 板块清单(boards 数据源,模块级缓存) ============

let homePanelCache = { at: 0, defs: null };
let boardsCache = { at: 0, out: null };
const pkgCache = new Map(); // 量贩包 id → {at, out}(PKG_TTL 过期,防同包视频间跳转整组重拉)
const gatherCache = new Map(); // 合集 id → {at, out}(同量贩包:整包静态,同合集跳转免重拉)
let subjectIdsCache = { at: 0, ids: null }; // 专题 id 表(面板 209 布局级数据,ZONES_TTL)

// layoutContent → 板块定义;解析失败的块跳过(布局改版单块自愈)。
// rowHalf 的 left/right 各拆一条(id 加 L/R 后缀保持稳定);banner=广告位、
// videoPackage=量贩合集包(模型不符)在 loadHomePanel 里直接不接
function defFromLayout(l, half) {
  let c;
  try { c = JSON.parse(l.layoutContent); } catch (e) { return null; }
  if (!c || typeof c !== 'object') return null;
  const side = half === 'left' ? c.left : half === 'right' ? c.right : c;
  if (!side || !side.title) return null;
  // 子标签(rowGroup lables)→ tabs;首档「综合」= null(缺省时发板块大区
  // typeIds,即布局 classs 数组)。两种形态:标准 {id,name,type:'class'};
  // 动画板块旧形态单键对象 {"30":"3D"}(键=id 值=名);裸字符串("剧情")无 id
  // 不可取数,跳过
  const tabs = [];
  for (const x of (Array.isArray(side.lables) ? side.lables : [])) {
    if (x && x.id != null && x.name) tabs.push({ id: String(x.id), title: String(x.name) });
    else if (x && typeof x === 'object') {
      for (const [kid, nm] of Object.entries(x)) {
        if (Number.isFinite(Number(kid)) && nm) tabs.push({ id: String(Number(kid)), title: String(nm) });
        break; // 单键对象只取一项
      }
    }
  }
  return {
    id: String(l.layoutId) + (half === 'left' ? 'L' : half === 'right' ? 'R' : ''),
    title: String(side.title),
    tabs: tabs.length ? [{ id: null, title: '综合' }, ...tabs] : null,
    params: {
      orderType: Number(side.orderType) || 1,
      typeIds: (Array.isArray(side.classs) ? side.classs : []).map(Number).filter(Number.isFinite),
      payType: (Array.isArray(side.payType) ? side.payType : []).map(Number).filter(Number.isFinite),
    },
  };
}

async function loadHomePanel() {
  if (homePanelCache.defs && Date.now() - homePanelCache.at < BOARDS_TTL) return homePanelCache.defs;
  const p = await api('/panel/get', { panelId: PANEL_HOME });
  const defs = [];
  for (const l of (p && p.info && Array.isArray(p.info.Layouts) ? p.info.Layouts : [])) {
    const code = String(l.layoutCode || '');
    const ds = code === 'row' || code === 'rowGroup' ? [defFromLayout(l)]
      : code === 'rowHalf' ? [defFromLayout(l, 'left'), defFromLayout(l, 'right')] : null;
    for (const d of ds || []) if (d && d.title) defs.push(d);
  }
  homePanelCache = { at: Date.now(), defs };
  return defs;
}

// 专题 id 表:面板 209 的 subject 布局块携带(layoutContent.list)。站方把专题
// 清单配置在面板里而非独立目录端点,改版丢块时如实报错(由调用方局部呈现)
async function loadSubjectIds() {
  if (subjectIdsCache.ids && Date.now() - subjectIdsCache.at < ZONES_TTL) return subjectIdsCache.ids;
  const p = await api('/panel/get', { panelId: PANEL_SUBJECTS });
  const layouts = p && p.info && Array.isArray(p.info.Layouts) ? p.info.Layouts : [];
  for (const l of layouts) {
    if (String(l.layoutCode || '') !== 'subject') continue;
    try {
      const c = JSON.parse(l.layoutContent);
      const ids = (Array.isArray(c && c.list) ? c.list : []).map(Number).filter(Number.isFinite);
      if (ids.length) {
        subjectIdsCache = { at: Date.now(), ids };
        return ids;
      }
    } catch (e) { /* 布局内容非 JSON:换下一块 */ }
  }
  throw new Error('含羞草专题面板布局已改版(未找到 subject 块,稍后重试)');
}

// 板块取数:tab 为子标签 id(null/缺省=默认档发大区 typeIds)。子标签与大区
// 同属扁平 typeIds 空间,单发子类 id 即可(2026-10-06 实测 [4] 全量成功;
// 若站方改语义需叠发 [大类,子类] 再调整此处)。分页实测只认 offset——
// 带 typeIds/payType 过滤的 getList 里 page 参数被上游忽略(page=1/2 同页),
// 页码换算 offset=(page-1)*length 发包
async function fetchSection(def, o = {}) {
  const page = Math.max(1, parseInt(o.page, 10) || 1);
  const size = Math.max(1, parseInt(o.size, 10) || 12);
  const tab = o.tab != null && o.tab !== '' ? Number(o.tab) : NaN;
  return normList(await api('/videos/getList', {
    page,
    length: size,
    offset: (page - 1) * size,
    orderType: def.params.orderType,
    typeIds: Number.isFinite(tab) ? [tab] : def.params.typeIds,
    payType: def.params.payType,
    tags: [],
  }), page, size);
}

// ============ 归一化(上游字段 → 前端契约,白名单构造,社交付费字段一律不带) ============

// 含羞草图源为 .aes 加密图,必须走服务端解密代理
const imgProxy = (u) => (u ? '/api/img/hanxiucao?u=' + encodeURIComponent(u) : '');

// 女优随行(userInfo,getList 条目/getInfo 携带)→ 可选 author 字段(VideoItem/
// Detail 契约形态,无 videoCount);avatar_thumb 为站点卡片用小图,缺失回退
// avatar,头像 .aes 同封面走图片代理;解析不出返回 null(条目不带 author 字段)
function normAuthor(u) {
  if (!u || u.id == null || !u.user_nicename) return null;
  return {
    id: String(u.id),
    name: String(u.user_nicename),
    avatar: imgProxy(u.avatar_thumb || u.avatar),
    verified: false,
  };
}

// getUpList 女优条目 → AuthorItem(作者资料/目录共用;fans/signature 属社交
// 数据,契约红线不带出)
function normUp(u) {
  const a = normAuthor(u);
  if (!a) return null;
  return { ...a, videoCount: Number(u.videoCount) > 0 ? Number(u.videoCount) : 0 };
}

function normItem(v) {
  if (!v || v.id == null) return null;
  const it = {
    id: v.id,
    title: String(v.name || ''),
    cover: imgProxy(v.coverImgUrl),
    duration: Number(v.length) > 0 ? Number(v.length) : null,
    hd: false,
  };
  const a = normAuthor(v.userInfo);
  if (a) it.author = a;
  return it;
}

// 列表信封 {count,list|infos} → ListResult(响应不回显页码,page/size 由调用方传入)
function normList(x, page, size, listKey = 'list') {
  const arr = x && Array.isArray(x[listKey]) ? x[listKey] : [];
  const count = (x && Number(x.count)) || 0;
  return { items: arr.map(normItem).filter(Boolean), page, hasMore: arr.length > 0 && page * size < count };
}

// 三区卡条目 → 契约卡形态 {id,title,cover,count}(countKey 缺省=上游无视频数,如
// 专题,恒 0 由前端不显角标;播放/购买等社交统计与价格字段按红线不带)
function normZoneCard(x, idKey, countKey) {
  if (!x || x[idKey] == null) return null;
  return {
    id: String(x[idKey]),
    title: String(x.name || ''),
    cover: imgProxy(x.coverImgUrl),
    count: Number(x[countKey]) > 0 ? Number(x[countKey]) : 0,
  };
}

// 三区卡清单信封 → ListResult 形态(count 缺失时退化为「满页即有更多」,防静默截断)
function normZoneList(x, page, size, idKey, countKey) {
  const arr = x && Array.isArray(x.list) ? x.list : [];
  const count = (x && Number(x.count)) || 0;
  const items = arr.map((it) => normZoneCard(it, idKey, countKey)).filter(Boolean);
  return { items, page, hasMore: count > 0 ? page * size < count : items.length >= size };
}

// 视频详情原始数据:videoSort 上游未给枚举,列表样本恒为 1;1 失败时降序试 2/3(仅错误路径多请求)
async function fetchInfoRaw(vid) {
  let lastErr = null;
  for (const sort of [1, 2, 3]) {
    try {
      const d = await api('/videos/getInfo', { videoSort: sort, videoId: vid });
      if (d && (d.info || d.id != null)) return d;
      lastErr = new Error('含羞草 detail 无数据 id=' + vid);
    } catch (e) {
      lastErr = e;
      if (!/含羞草接口/.test(e.message)) throw e; // 网络错:直接抛(换 sort 无意义)
    }
  }
  throw lastErr;
}

// ============ 播放清单解析(master 剥壳 + 试看窗口改写,详见文件头「播放三级」) ============

async function fetchText(url, timeoutMs = TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      cache: 'no-store',
      headers: { 'User-Agent': UA, 'Accept': 'application/vnd.apple.mpegurl,*/*;q=0.8' },
    });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

// 清单可用性校验:CDN 会用 HTTP 200 包 JSON 错误体(如 703 地址过期),必须验 #EXTM3U 头
function assertPlaylist(r, tag) {
  if (r.status < 400 && r.text.trimStart().startsWith('#EXTM3U')) return;
  let srv = '';
  try { const j = JSON.parse(r.text); srv = ((j.code || '') + ' ' + (j.msg || '')).trim(); } catch (e) { srv = r.text.slice(0, 60); }
  throw new Error('含羞草' + tag + '不可用(HTTP ' + r.status + (srv ? ':' + srv : '') + ')');
}

// 试看窗口参数改宽:签名只校验 start/end 存在、不校验其值(实测改 0/99999 放行全片)
const widenWin = (u) => u
  .replace(/([?&])start=\d+/, '$1start=0')
  .replace(/([?&])end=\d+/, '$1end=99999');

// master 剥壳:逐级取最高分辨率变体(变体行可能裸名,须继承 master 的
// sign/rSign/start/end),到媒体清单层改宽窗口,复核后交浏览器直连
async function widenPreview(masterUrl) {
  let cur = masterUrl;
  for (let hop = 0; hop < 2; hop++) {
    const r = await fetchText(cur);
    assertPlaylist(r, '播放清单');
    const lines = r.text.split('\n').map((l) => l.trim()).filter(Boolean);
    let best = null; // {h, url}
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const rel = lines[i + 1];
      if (!rel || rel.startsWith('#')) continue;
      const h = Number((lines[i].match(/RESOLUTION=\d+x(\d+)/) || [])[1]) || 0;
      let vu;
      try { vu = new URL(rel, cur).href; } catch (e) { continue; }
      // 变体行缺签名参数时继承 master 的(实测 CDN 对 m3u8 强校验 sign/rSign)
      if (!/[?&](sign|rSign)=/.test(vu) && /[?&](sign|rSign)=/.test(cur)) {
        const vp = new URL(vu).searchParams;
        const mp = new URL(cur).searchParams;
        for (const k of ['sign', 'rSign', 'start', 'end']) {
          const v = mp.get(k);
          if (v != null && !vp.has(k)) vp.set(k, v);
        }
        vu = vu.split('?')[0] + '?' + vp.toString();
      }
      if (!best || h > best.h) best = { h, url: vu };
    }
    if (!best) break; // 已是媒体清单:就地改宽
    cur = best.url;
  }
  const widened = widenWin(cur);
  // 改宽复核:站点若收紧窗口参数校验(改宽 404)则如实报错,不静默降级 30s 试看
  assertPlaylist(await fetchText(widened), '全片清单(窗口改写失败,站点可能已收紧校验)');
  return { type: 'hls', url: widened, via: 'pre' };
}

// ============ 插件类 ============

export class HanxiucaoPlugin extends SitePlugin {
  get id() { return 'hanxiucao'; }
  get name() { return '含羞草'; }
  // 板块=首页面板体系(boards/boardList 即 panel 171 布局块,详见文件头「板块体系」);
  // 分类体系已整体移除(无 categories/home 聚合);无标签过滤/专辑端点;
  // 排序仅两档真实(人气并列最热);作者体系=女优(getUpList/getList uid 过滤,
  // 详见文件头「女优体系」):author=资料+片单,authors=女优目录(当红/全量);
  // 三区(专题/量贩/合集)=站方导航专区,详见文件头「三区」:subjects/bysubject
  // 走面板 209+subject/list+getList subject 模式,packages/gathers/gather 走
  // videoPackage 与 gather 两套包体系
  get capabilities() { return { home: false, boards: true, hotwords: true, tags: false, dvds: false, bytag: false, sort: true, author: true, authors: true, zones: true }; }

  // 首页板块清单:面板布局 + 各板块第一页(单板块失败丢弃该节,fail-soft);
  // 结果 60s 短缓存——板块页(/board)只取标题/tabs 复用同构数据,不必整组重拉
  async boards() {
    if (boardsCache.out && Date.now() - boardsCache.at < BOARDS_DATA_TTL) return boardsCache.out;
    const defs = await loadHomePanel();
    const out = await Promise.all(defs.map(async (d) => {
      try {
        const list = await fetchSection(d, { page: 1, size: 12 });
        if (!list.items.length) return null; // 空板块不占位
        return { id: d.id, title: d.title, ...(d.tabs ? { tabs: d.tabs } : {}), list };
      } catch (e) { return null; /* 换下一板块 */ }
    }));
    const res = { sections: out.filter(Boolean) };
    boardsCache = { at: Date.now(), out: res };
    return res;
  }

  // 板块取数(首页行内切子标签 / 板块页翻页):面板缓存里查定义
  async boardList(id, o = {}) {
    const key = String(id == null ? '' : id);
    const defs = homePanelCache.defs && Date.now() - homePanelCache.at < BOARDS_TTL
      ? homePanelCache.defs : await loadHomePanel();
    const def = defs.find((d) => d.id === key);
    if (!def) throw new Error('含羞草未知板块 id=' + key + '(面板布局可能已改版,稍后重试)');
    return fetchSection(def, o);
  }

  async list(o = {}) {
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 24);
    return normList(await api('/videos/getList', { page, length: size, orderType: ORDER[o.sort] || 1 }), page, size);
  }

  async search(kw, o = {}) {
    const k = String(kw || '').trim();
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 24);
    if (!k) return { items: [], page: 1, hasMore: false };
    // 参数名是 key(传 keyword 会被忽略变全库);type:1=视频;结果信封键为 infos
    const x = await api('/base/globalSearch', { key: k, videoSort: 1, type: 1, page, length: size });
    return normList(x, page, size, 'infos');
  }

  async hotwords() {
    const x = await api('/base/hotWord', {});
    // 站方固定热词榜 {word:[...]};形态不符一律回 []
    return Array.isArray(x && x.word) ? x.word.map((w) => String(w || '').trim()).filter(Boolean) : [];
  }

  async detail(id) {
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('含羞草 detail 缺少有效视频 id');
    // 所属合集反查与主取数并行(只依赖 vid);失败/为空不带 gathers 字段,
    // 绝不阻塞主链——播放页合集选集面板的数据源
    const [d, gathers] = await Promise.all([
      fetchInfoRaw(vid),
      api('/gather/getListByVideoId', { videoId: vid })
        .then((g) => (Array.isArray(g && g.list) ? g.list : [])
          .map((x) => (x && (x.gatherId ?? x.id) != null && x.name
            ? { id: String(x.gatherId ?? x.id), name: String(x.name) } : null))
          .filter(Boolean))
        .catch(() => null),
    ]);
    const i = (d && d.info) || d;
    // 标签为逗号串(无 id,详情页 chip 退化为搜索链);分类体系已移除,
    // 所属专题 subjectInfos 不再带出(专题 chip 链的是已删除的 category 面)
    const tags = String(i.tags || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((t) => ({ id: null, name: t }));
    // 白名单构造:point/isVip/canDownload/统计计数等社交付费字段一律不带出;
    // 作者(女优)随行:getInfo 的 info.userInfo 携带完整资料(观看页频道行
    // 数据源,深链直达也有作者,无需卡片随行兜底)
    const a = normAuthor(i.userInfo);
    return {
      id: i.id != null ? i.id : vid,
      title: String(i.name || ''),
      cover: imgProxy(i.coverImgUrl),
      duration: Number(i.length) > 0 ? Number(i.length) : null,
      hd: false,
      resolution: i.width && i.height ? i.width + 'x' + i.height : '',
      uploadDate: String(i.addTime || ''),
      // 所属量贩包 id(0/缺省=不在包;仅本站输出,观看页右侧选集面板据此取片单)
      packageId: Number(i.videoPackageId) > 0 ? Number(i.videoPackageId) : null,
      // 所属合集(0..n 个,仅本站输出;观看页合集选集面板据此取整包,详见文件头「三区」③)
      ...(gathers && gathers.length ? { gathers } : {}),
      tags,
      ...(a ? { author: a } : {}),
    };
  }

  async related(id, o = {}) {
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('含羞草 related 缺少有效视频 id');
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 8);
    // 上游推荐分页从 0 起(与其他列表从 1 起不同),此处换算;信封键为 info(非 list)
    const x = await api('/videos/getRecommendListByVideoId', { videoId: vid, page: page - 1, length: size });
    return normList(x, page, size, 'info');
  }

  // 量贩视频集片单(链路详见文件头「量贩视频集」):getDetail 整包全量无分页;
  // 按包 id 缓存 PKG_TTL(同包视频间跳转免整组重拉);条目 normItem 白名单归一,
  // 价格/社交字段不带出
  async videoPackage(id) {
    const pid = parseInt(id, 10);
    if (!Number.isFinite(pid) || pid <= 0) throw new Error('含羞草 videoPackage 缺少有效量贩包 id');
    const hit = pkgCache.get(pid);
    if (hit && Date.now() - hit.at < PKG_TTL) return hit.out;
    const x = await api('/videoPackage/getDetail', { videoPackageId: pid });
    const info = (x && x.info) || {};
    const vids = Array.isArray(info.videos) ? info.videos : [];
    const out = {
      id: info.videoPackageId != null ? info.videoPackageId : pid,
      title: String(info.name || ''),
      description: String(info.description || ''),
      count: Number(info.videoCount) || vids.length,
      items: vids.map(normItem).filter(Boolean),
    };
    pkgCache.set(pid, { at: Date.now(), out });
    return out;
  }

  // ============ 三区(专题/量贩/合集,接口形态详见文件头「三区」) ============

  // 专题卡清单:面板 209 的 id 表批量取(上游条目无视频数,count=0 不显角标)
  async subjects(o = {}) {
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 24);
    const ids = await loadSubjectIds();
    return normZoneList(await api('/subject/list', { page, length: size, subjectIds: ids }), page, size, 'id');
  }

  // 专题内视频:getList subject 模式(offset 必带;orderType 缺省 8=站方推荐档,
  // 最新1/最热2,topicDet 页三 tab 同源)
  async bysubject(id, o = {}) {
    const sid = parseInt(id, 10);
    if (!Number.isFinite(sid) || sid <= 0) throw new Error('含羞草 bysubject 缺少有效专题 id');
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 24);
    return normList(await api('/videos/getList', {
      page, length: size, offset: (page - 1) * size,
      orderType: SUBJ_ORDER[o.sort] || 8, subjectId: sid,
    }), page, size);
  }

  // 量贩包卡清单(价格字段红线不带;整包详情走既有 videoPackage)
  async packages(o = {}) {
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 24);
    return normZoneList(await api('/videoPackage/getList', { page, length: size, orderType: 1 }), page, size, 'videoPackageId', 'videoCount');
  }

  // 合集卡清单(gatherType:1=站方合集专区同款参数)
  async gathers(o = {}) {
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 24);
    return normZoneList(await api('/gather/getList', { page, length: size, gatherType: 1 }), page, size, 'gatherId', 'videoCount');
  }

  // 合集整包片单(与量贩包同形态,游客可读;站方播放页「合集 (1/N)」选集队列
  // 即此数据;按合集 id 缓存 PKG_TTL,同合集视频间跳转免重拉)
  async gather(id) {
    const gid = parseInt(id, 10);
    if (!Number.isFinite(gid) || gid <= 0) throw new Error('含羞草 gather 缺少有效合集 id');
    const hit = gatherCache.get(gid);
    if (hit && Date.now() - hit.at < PKG_TTL) return hit.out;
    const x = await api('/gather/getDetail', { gatherId: gid });
    const info = (x && x.info) || {};
    const vids = Array.isArray(info.videos) ? info.videos : [];
    const out = {
      id: info.gatherId != null ? info.gatherId : gid,
      title: String(info.name || ''),
      description: String(info.description || ''),
      count: Number(info.videoCount) || vids.length,
      items: vids.map(normItem).filter(Boolean),
    };
    gatherCache.set(gid, { at: Date.now(), out });
    return out;
  }

  // ============ 作者(女优)体系(接口形态详见文件头「女优体系」) ============

  // 女优资料:getUpList 按 uids 精确取;不存在/已下架如实报错(深链防御)
  async author(id) {
    const uid = parseInt(id, 10);
    if (!Number.isFinite(uid) || uid <= 0) throw new Error('含羞草 author 缺少有效女优 id');
    const x = await api('/user/getUpList', { uids: [uid], page: 1, length: 1 });
    const a = normUp((x && Array.isArray(x.list) ? x.list : [])[0]);
    if (!a) throw new Error('含羞草女优不存在(id=' + uid + ',可能已下架)');
    return a;
  }

  // 女优片单:getList 带 uid 过滤(count=作品总数;分页只认 offset,与板块
  // 取数同款换算;站方播放页「女优主题」行即此请求形态,条目自带作者随行)
  async byauthor(id, o = {}) {
    const uid = parseInt(id, 10);
    if (!Number.isFinite(uid) || uid <= 0) throw new Error('含羞草 byauthor 缺少有效女优 id');
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 24);
    return normList(await api('/videos/getList', {
      uid, page, length: size, offset: (page - 1) * size, orderType: 1, payType: [],
    }), page, size);
  }

  // 女优目录:getUpList 缺省全量分页;o.group=当红女优分组(站方女优面板
  // upScroll 块同款参数形态;空数组参数 clean() 不删,保持与站方一致)
  async authors(o = {}) {
    const page = Math.max(1, parseInt(o.page, 10) || 1);
    const size = Math.max(1, parseInt(o.size, 10) || 24);
    const payload = o.group
      ? { uids: [], groupIds: [1], filterIds: [], isManualBack: 1, page, length: size }
      : { page, length: size };
    const x = await api('/user/getUpList', payload);
    const arr = x && Array.isArray(x.list) ? x.list : [];
    const count = (x && Number(x.count)) || 0;
    const items = arr.map(normUp).filter(Boolean);
    return { items, page, hasMore: items.length > 0 && page * size < count };
  }

  // 播放解析三级:① v2/getUrl 正片直取(免费/已购/HXC_TOKEN 有权限账号)→
  // ② getPreUrl 零鉴权试看签名窗口改写全片 → ③ 全败精确诊断(详见文件头「播放三级」)
  async resolvePlay(id) {
    const vid = parseInt(id, 10);
    if (!Number.isFinite(vid) || vid <= 0) throw new Error('含羞草 resolvePlay 缺少有效视频 id');
    // ① 正片直取:code 2002 无权限 / 2003 需购买 落第②级;700 登录态失效也落②级
    // (getPreUrl 零鉴权不受影响,末位诊断再提示换 token),其余业务错直接抛
    let authStale = false;
    try {
      const x = await api('/videos/v2/getUrl', { videoId: vid });
      if (x && x.url) return { type: 'hls', url: x.url, via: 'api' };
    } catch (e) {
      if (/code=700/.test(e.message)) authStale = true;
      else if (!/code=200[23]/.test(e.message)) throw e;
    }
    // ② 试看签名改写:getPreUrl 零鉴权,无 url = 服务端未签发试看地址(服务端防线)
    const pre = await api('/videos/getPreUrl', { videoId: vid });
    if (!pre || !pre.url) {
      // ③ 精确诊断:getInfo 区分 VIP 专享/金币片/需登录形态(实测 #7024:
      // isVip=1+isNeedLogin=1+getPreUrl 空串;canPrePlay=true 与是否发地址无关,以行为为准)
      let why = '服务端未签发试看地址';
      try {
        const d = await api('/videos/getInfo', { videoSort: 1, videoId: vid });
        const i = (d && d.info) || {};
        const bits = [];
        if (i.isVip === 1) bits.push('VIP 专享');
        if (Number(i.point) > 0) bits.push('金币片 ' + i.point + ' 点');
        if (i.isNeedLogin === 1) bits.push('需登录');
        if (bits.length) why = bits.join(' + ') + ',服务端未签发试看地址';
      } catch (e) { /* 诊断探针失败:沿用默认表述(token 失效时 getInfo 亦 700) */ }
      throw new Error('含羞草视频 ' + vid + ' 无可用播放地址(' + why
        + (authStale ? ';当前 HXC_TOKEN 已失效(登录态过期),更新后重启'
          : authToken() ? ';当前账号无此片权限' : ';游客侧无入口,可配 HXC_TOKEN=VIP账号token(.env.local)直读') + ')');
    }
    return widenPreview(pre.url);
  }

  // 域名自动刷新(可选能力,契约见 base.js):手动触发一次发现链;domain-refresh.js
  // 的 5 分钟周期轮与请求失败 urgent 触发亦走同一函数;HXC_GATEWAY 有值时为 no-op
  async refreshDomains() { return discoverGateways(); }

  // 静态图片能力:供 /api/img/hanxiucao 代理调用,返回明文图片 Buffer
  async image(u) {
    if (!/^https?:\/\//.test(u || '')) throw new Error('含羞草图片代理需要合法 http(s) 地址');
    const r = await fetch(u, {
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Did': '1', 'source': '1' },
    });
    if (!r.ok) throw new Error('图片 HTTP ' + r.status);
    const text = (await r.text()).trim();
    // .aes 本体是 base64(密文) → AES-128-ECB → UTF-8 串,该串又是 data:image/...;base64 数据 URL。
    // 收尾填充两代并存(2026-10-06 补测):新片封面为 PKCS#7,2023 前老片封面为零填充
    // (明文尾随 0x00)——统一关自动填充校验后手动裁尾,否则老封面一律 bad decrypt 502
    let out;
    try {
      const d = crypto.createDecipheriv('aes-128-ecb', IMG_KEY, null);
      d.setAutoPadding(false);
      const raw = Buffer.concat([d.update(Buffer.from(text, 'base64')), d.final()]);
      let end = raw.length;
      while (end > 0 && raw[end - 1] === 0) end--; // 零填充(老片)
      const pad = end > 0 ? raw[end - 1] : 0;
      if (pad >= 1 && pad <= 16 && end - pad >= 0 && raw.slice(end - pad, end).every((b) => b === pad)) end -= pad; // PKCS#7(新片)
      out = raw.slice(0, end).toString('utf8').trim();
    } catch (e) {
      throw new Error('含羞草封面解密失败(密钥可能已轮换):' + e.message);
    }
    const m = out.match(/^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw new Error('含羞草封面解密后非 data URL 形态');
    return Buffer.from(m[1], 'base64');
  }
}
