// ============================================================================
// 收藏域集成自测脚本（fav-test）
// ----------------------------------------------------------------------------
// 自举集成测试：createApp 起随机端口（port 0，与 boot-check.mjs 同款自举
// 手法），对 /api/fav/* 五端点走真实 HTTP 断言。三种模式：
//   node scripts/fav-test.mjs               # 正常模式（MySQL + Redis 均真实）
//   node scripts/fav-test.mjs --redis-down  # Redis 指到 6390（无人监听）：
//                                           # 全流程必须仍全过（静默降级直查 MySQL）
//   node scripts/fav-test.mjs --mysql-down  # MySQL 指到 3390（无人监听）：
//                                           # 收藏读写一律 503 {__err:1}，
//                                           # /api/sites 仍 200（故障不外溢）
// 环境变量覆盖时序红线：必须在动态 import ../src/index.js 之前设置——
// index.js 的 dotenv 不覆盖已有环境变量，redis.js/db.js 建连时才现读 env，
// 先设后 import 才能让覆盖值生效（.env 里的真实连接配置被我们保住的覆盖值
// 压住，不会被动还原）。
// 测试数据 site='yuese'、vid='favtest-001' 起，预清理与收尾都只删自身两条
// key（幂等可重跑）。红线：/api/fav/clear 是无条件整表删除——.env 指向的
// 可能是存有真实收藏的正式库，clear 仅在前置检查确认表内已无其他数据
// （专用测试库/空库）时才实调，否则跳过实调，防止自测清空全部真实收藏。
// 每步中文 ✓/✗，全过 exit 0，任一 ✗ exit 1。
// ============================================================================

const REDIS_DOWN = process.argv.includes('--redis-down');
const MYSQL_DOWN = process.argv.includes('--mysql-down');
const MODE = MYSQL_DOWN ? 'MySQL 降级模式' : (REDIS_DOWN ? 'Redis 降级模式' : '正常模式');

// —— 覆盖时序红线：先改 env，再动态 import 服务端（见文件头说明） ——
if (REDIS_DOWN) process.env.REDIS_PORT = '6390';
if (MYSQL_DOWN) process.env.MYSQL_PORT = '3390';

const { createApp } = await import('../src/index.js');

const TAG = '[fav-test]';
let failed = false;

// 单步断言：中文 ✓/✗，失败附细节并记总账
function step(name, ok, detail) {
  if (ok) {
    console.log(`✓ ${name}`);
  } else {
    failed = true;
    console.log(`✗ ${name}${detail ? '（' + detail + '）' : ''}`);
  }
}

// 起服务：port 0 = 内核分配随机空闲端口（避免与常驻服务冲突）
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

// 轻量 HTTP 客户端（fetch 走真实端口，连 bodyParser/错误契约路径一并覆盖）
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 体按 null 处理 */ }
  return { status: res.status, json, cc: res.headers.get('cache-control') };
}

// —— 测试数据：site='yuese'、vid='favtest-001' 起（收尾 remove 只删自身 key） ——
const SITE = 'yuese';
const V1 = 'favtest-001';
const V2 = 'favtest-002';
const K1 = `${SITE}:${V1}`;
const K2 = `${SITE}:${V2}`;

console.log(`${TAG} ${MODE}（端口 ${PORT}）`);

// —— 预清理：上次运行若中途被杀（如编排超时）会残留两条测试数据，先删
//    自身 key 再开测，保证幂等可重跑（只删 favtest 自己的 key，不动其他
//    收藏数据；MySQL 降级模式下此调用 503，不参与断言，无副作用） ——
await call('POST', '/api/fav/remove', { keys: [K1, K2] });

if (!MYSQL_DOWN) {
  // —— 1. toggle 添加：fav:1 + no-store 响应头 ——
  let r = await call('POST', '/api/fav/toggle', {
    site: SITE, id: V1, title: 'FavTest 收藏甲', cover: '/api/img/yuese?u=favtest-001.png',
    duration: 123, hd: true,
  });
  step('toggle 添加 favtest-001 → fav:1', r.status === 200 && r.json && r.json.fav === 1,
    `status=${r.status} body=${JSON.stringify(r.json)}`);
  step('toggle 响应 no-store', r.cc === 'no-store', `cache-control=${r.cc}`);

  r = await call('POST', '/api/fav/toggle', {
    site: SITE, id: V2, title: 'FavTest 收藏乙', duration: null, hd: false,
  });
  step('toggle 添加 favtest-002 → fav:1', r.status === 200 && r.json && r.json.fav === 1,
    `status=${r.status} body=${JSON.stringify(r.json)}`);

  // —— 2. ids：含新收藏 key，total 对得上 ——
  r = await call('GET', '/api/fav/ids');
  step('ids 含 yuese:favtest-001', r.status === 200 && Array.isArray(r.json && r.json.ids)
    && r.json.ids.includes(K1), `status=${r.status} body=${JSON.stringify(r.json)}`);
  step('ids total ≥ 2 且 at 为毫秒时间戳', r.json && r.json.total >= 2
    && typeof r.json.at === 'number', `total=${r.json && r.json.total} at=${r.json && r.json.at}`);

  // —— 3. list 首页：刚收藏的必在首页（created_at 倒序），快照字段完整 ——
  r = await call('GET', '/api/fav/list');
  const it1 = r.json && Array.isArray(r.json.items)
    ? r.json.items.find((it) => it.site === SITE && it.id === V1) : null;
  step('list 首页含 favtest-001 且快照字段完整', Boolean(it1)
    && it1.title === 'FavTest 收藏甲' && it1.cover === '/api/img/yuese?u=favtest-001.png'
    && it1.duration === 123 && it1.hd === true && typeof it1.at === 'number',
    `item=${JSON.stringify(it1)}`);
  step('list 分页字段齐全（page/size/hasMore/total）', r.json && r.json.page === 1
    && r.json.size === 24 && typeof r.json.hasMore === 'boolean' && r.json.total >= 2,
    `body=${JSON.stringify(r.json && { page: r.json.page, size: r.json.size, hasMore: r.json.hasMore, total: r.json.total })}`);

  // —— 4. 过滤：kw 大小写不敏感（小写关键词命中大写标题前缀）+ site 精确 ——
  r = await call('GET', `/api/fav/list?kw=${encodeURIComponent('favtest')}`);
  step('list kw=favtest（小写）命中两条测试数据', r.json && r.json.total === 2
    && r.json.items && r.json.items.length === 2, `total=${r.json && r.json.total}`);
  r = await call('GET', `/api/fav/list?site=${SITE}&kw=${encodeURIComponent('favtest')}`);
  step('list site=yuese 过滤命中', r.json && r.json.total === 2, `total=${r.json && r.json.total}`);
  r = await call('GET', '/api/fav/list?site=notexistsite');
  step('list site=notexistsite 过滤为空', r.json && r.json.total === 0
    && Array.isArray(r.json.items) && r.json.items.length === 0,
    `total=${r.json && r.json.total}`);

  // —— 5. toggle 取消：fav:0，ids 不再含 ——
  r = await call('POST', '/api/fav/toggle', { site: SITE, id: V1 });
  step('toggle 再点 favtest-001 → fav:0（取消收藏）', r.status === 200 && r.json
    && r.json.fav === 0, `status=${r.status} body=${JSON.stringify(r.json)}`);
  r = await call('GET', '/api/fav/ids');
  step('取消后 ids 不含 favtest-001', r.json && Array.isArray(r.json.ids)
    && !r.json.ids.includes(K1), `ids=${JSON.stringify(r.json && r.json.ids)}`);

  // —— 6. remove 批量：补回两条后按 key 批删 ——
  await call('POST', '/api/fav/toggle', { site: SITE, id: V1, title: 'FavTest 收藏甲' });
  r = await call('POST', '/api/fav/remove', { keys: [K1, K2] });
  step('remove 批量删除两条 → removed:2', r.status === 200 && r.json
    && r.json.removed === 2, `status=${r.status} body=${JSON.stringify(r.json)}`);
  r = await call('GET', '/api/fav/ids');
  step('remove 后测试数据已清（ids 不含两条 key）', r.json && Array.isArray(r.json.ids)
    && !r.json.ids.includes(K1) && !r.json.ids.includes(K2),
    `ids=${JSON.stringify(r.json && r.json.ids)}`);

  // —— 7. clear 契约：前置检查表内已无其他数据才实调（favClear 是无条件
  //    整表删除，第 6 步已删净测试 key，此时 ids 里若仍有别的 key 就是真实
  //    收藏——真调 clear 会整表全删且不可恢复；跳过实调只留说明，clear
  //    契约留待专用一次性测试库上验证） ——
  r = await call('GET', '/api/fav/ids');
  const others = (r.status === 200 && Array.isArray(r.json && r.json.ids)
    ? r.json.ids : []).filter((k) => k !== K1 && k !== K2);
  if (r.status === 200 && others.length === 0) {
    r = await call('POST', '/api/fav/clear');
    step('clear → { total: 0 }（表内已无其他数据，安全实调）', r.status === 200 && r.json
      && r.json.total === 0, `status=${r.status} body=${JSON.stringify(r.json)}`);
  } else {
    console.log(`- clear 实调跳过：ids 仍含 ${others.length} 条非本脚本 key（status=${r.status}），防整表误删真实收藏；clear 契约请在专用一次性测试库上验证`);
  }

  // —— 8. 非法参数：一律 400 {__err:1}（site/id/key 三面） ——
  r = await call('POST', '/api/fav/toggle', { site: 'bad site!', id: 'x' });
  step('toggle site 含空格 → 400 {__err:1}', r.status === 400 && r.json
    && r.json.__err === 1, `status=${r.status} body=${JSON.stringify(r.json)}`);
  r = await call('POST', '/api/fav/toggle', { site: SITE, id: 'a b' });
  step('toggle id 含空格 → 400 {__err:1}', r.status === 400 && r.json
    && r.json.__err === 1, `status=${r.status} body=${JSON.stringify(r.json)}`);
  r = await call('GET', `/api/fav/list?site=${encodeURIComponent('%%')}`);
  step('list site 含非法字符 → 400 {__err:1}', r.status === 400 && r.json
    && r.json.__err === 1, `status=${r.status} body=${JSON.stringify(r.json)}`);
  r = await call('POST', '/api/fav/remove', { keys: [K1, 'bad!key:x'] });
  step('remove key 含非法 site 段 → 400 {__err:1}', r.status === 400 && r.json
    && r.json.__err === 1, `status=${r.status} body=${JSON.stringify(r.json)}`);
  r = await call('POST', '/api/fav/remove', { keys: [SITE] });
  step('remove key 缺冒号分隔 → 400 {__err:1}', r.status === 400 && r.json
    && r.json.__err === 1, `status=${r.status} body=${JSON.stringify(r.json)}`);

  // —— 收尾兜底清理：与预清理同款只删自身两条 key（正常路径第 6 步已删
  //    净，此处兜中间断言失败/进程被杀的残留；不参与断言，绝不动他人数据） ——
  await call('POST', '/api/fav/remove', { keys: [K1, K2] });
} else {
  // —— MySQL 降级模式：收藏读写一律 503 固定文案，进程不崩、故障不外溢 ——
  let r = await call('POST', '/api/fav/toggle', { site: SITE, id: V1, title: 'x' });
  step('toggle（MySQL 不可用）→ 503 {__err:1,"收藏服务暂不可用"}', r.status === 503
    && r.json && r.json.__err === 1 && r.json.message === '收藏服务暂不可用',
    `status=${r.status} body=${JSON.stringify(r.json)}`);
  r = await call('GET', '/api/fav/ids');
  step('ids → 503 {__err:1}', r.status === 503 && r.json && r.json.__err === 1,
    `status=${r.status} body=${JSON.stringify(r.json)}`);
  r = await call('GET', '/api/fav/list');
  step('list → 503 {__err:1}', r.status === 503 && r.json && r.json.__err === 1,
    `status=${r.status} body=${JSON.stringify(r.json)}`);
  r = await call('POST', '/api/fav/remove', { keys: [K1] });
  step('remove → 503 {__err:1}', r.status === 503 && r.json && r.json.__err === 1,
    `status=${r.status} body=${JSON.stringify(r.json)}`);
  r = await call('POST', '/api/fav/clear');
  step('clear → 503 {__err:1}', r.status === 503 && r.json && r.json.__err === 1,
    `status=${r.status} body=${JSON.stringify(r.json)}`);
  // 参数校验先于 DB（400 照常给出,不因 MySQL 故障变成 503）
  r = await call('POST', '/api/fav/toggle', { site: 'bad site!', id: 'x' });
  step('非法参数仍 400（校验先于 DB）', r.status === 400 && r.json && r.json.__err === 1,
    `status=${r.status} body=${JSON.stringify(r.json)}`);
  // 收藏域故障不外溢:站点清单依旧 200
  r = await call('GET', '/api/sites');
  step('/api/sites 仍 200（故障不外溢主链路）', r.status === 200 && Array.isArray(r.json),
    `status=${r.status}`);
}

// —— 收尾：关连接、按结果退出（Windows 兼容手法与 boot-check.mjs 一致；
//    降级模式下 ioredis 后台重连定时器仍活着,必须显式 process.exit） ——
server.closeAllConnections?.();
await new Promise((resolve) => server.close(() => resolve()));
console.log(`${TAG} ${MODE}${failed ? ' 存在失败项' : ' 全部通过'}`);
process.exit(failed ? 1 : 0);
