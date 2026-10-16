// ============================================================
// registry.js —— 站点插件注册表(仅 Node 服务端运行)
//
// 新增站点 = 写一个 SitePlugin 子类 + 在此注册一行;
// 注册顺序即声明顺序,无启动副作用(插件均为惰性请求)。
//
// 资源站(Apple CMS 采集接口)例外:cms/ 模块按资源族清单批量产【插件数组】
// (buildCmsPlugins,见 ./cms/index.js),getPlugin/listSites 以 await 动态
// 合并——静态站仍同步命中;资源站 id 一律 zy_ 前缀。
// ============================================================
import { YuesePlugin } from './yuese.js';
import { AvjbPlugin } from './avjb.js';
import { AidouPlugin } from './aidou.js';
import { HanxiucaoPlugin } from './hanxiucao.js';
import { ZimuquanPlugin } from './zimuquan.js';
import { DsdPlugin } from './dsd.js';
import { BfPlugin } from './bf.js';
import { LlwPlugin } from './llw.js';
import { P91Plugin } from './p91.js';
import { TelegramPlugin } from './telegram-tg/plugin.js';
import { findCmsPlugin, cmsSitesMeta } from './cms/index.js';

// telegram 为账号绑定站点:数据面需已登录(未登录回 502 needLogin,专属端点见 routes/telegram.js)
export const registry = { yuese: new YuesePlugin(), avjb: new AvjbPlugin(), aidou: new AidouPlugin(), hanxiucao: new HanxiucaoPlugin(), zimuquan: new ZimuquanPlugin(), dsd: new DsdPlugin(), bf: new BfPlugin(), llw: new LlwPlugin(), '91pron': new P91Plugin(), telegram: new TelegramPlugin() };

// 按 id 取插件(只认自有属性,防原型链误命中);未注册返回 null;
// zy_ 前缀走资源站插件群(异步:首访初始化只读磁盘,不碰网络)
export async function getPlugin(id) {
  if (Object.prototype.hasOwnProperty.call(registry, id)) return registry[id];
  if (typeof id === 'string' && id.startsWith('zy_')) return findCmsPlugin(id);
  return null;
}

// 站点能力清单:GET /api/sites 的数据源;
// group 字段区分主站('main')/资源站('cms'),资源站按健康态动态增减、排后
export async function listSites() {
  const main = Object.values(registry).map((p) => ({ id: p.id, name: p.name, capabilities: p.capabilities, group: 'main' }));
  const cms = await cmsSitesMeta();
  return [...main, ...cms];
}

// —— 启动预热(冷链路提前)(2026-10-06) ——
// 动机:最重的冷启动链路原先全部惰性发生在「首个用户请求」里(如 bf:guest
// 登录 → 网关三线并发 ping → /modules/list → 各模块并发探测子分类,叠加插件
// 15s 超时,首个访客极易吃满整段等待)。warmAll 把这些链路挪到进程启动后
// 的后台完成,首个真实用户到来时命中的已是热缓存。
// 语义:fire-and-forget——调用方不 await(预热不该挡任何请求);模块级
// warmed 标志保证进程内只跑一次;仅遍历静态注册表且有 warm() 方法的插件
// (目前 bf 与 telegram——后者有会话才连、失败静默;其余插件冷启动轻或已有
// 自愈机制——cms 资源站群在 listSites/
// cmsSitesMeta 的 ensureInit + 后台 cycle 里已覆盖,不重复预热);warm 内部
// 自行吞错(预热失败静默:真实用户请求会重走完整链路并如实报错,预热只是
// 提前、不是正确性依赖)。触发点:站点清单接口 GET /api/sites(前端任何页面
// 首访都会拉站点清单,等价于「进程启动后不久必然触发」;由路由层调用,
// 与具体 Web 框架无关)。
let warmed = false;
export function warmAll() {
  if (warmed) return;
  warmed = true;
  for (const p of Object.values(registry)) {
    if (typeof p.warm === 'function') p.warm().catch(() => {});   // 各插件自兜错误,预热失败不影响服务
  }
}
