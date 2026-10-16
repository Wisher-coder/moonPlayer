// ============================================================================
// verify-menu.mjs —— 菜单独立子窗 CDP 验证脚本（开发自测，一次性）
// ----------------------------------------------------------------------------
// 连 electron --remote-debugging-port=9222，在既有的播放窗（/video/...）上：
//   1. 读「倍速」钮位置，CDP 合成 mousemove 触发 hover（不动真实光标）；
//   2. 等 /menu?win=menu 目标出现，读菜单窗的屏幕位置与外廓；
//   3. 与「倍速」钮屏幕坐标比对：菜单右缘 ≈ 钮右缘、菜单底边 ≈ 钮顶边
//     （±24px 容差），并确认面板文本渲染（含 2X）。
// 注意：合成事件不触发后续 mouseleave（真实指针没动），菜单会保持可见直到
// 下一次真实交互——不影响测量；「指针停在菜单上不收起」由主进程读全局光标
// 的地面真值裁决，自动模拟不了，留人肉验证。
// ============================================================================
const CDP = 'http://127.0.0.1:9222';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const res = await fetch(CDP + '/json/list');
  return res.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let seq = 0;
    const timer = setTimeout(() => reject(new Error('ws 连接超时')), 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve({
        send(method, params = {}) {
          const id = ++seq;
          return new Promise((res2, rej2) => {
            const t = setTimeout(() => {
              pending.delete(id);
              rej2(new Error(method + ' 超时'));
            }, 10000);
            pending.set(id, {
              res2: (v) => { clearTimeout(t); res2(v); },
              rej2: (v) => { clearTimeout(t); rej2(v); },
            });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close: () => ws.close(),
      });
    };
    ws.onerror = () => reject(new Error('ws error'));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res2, rej2 } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej2(new Error(JSON.stringify(msg.error)));
        else res2(msg.result);
      }
    };
  });
}

async function evalIn(c, expression) {
  const r = await c.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error('eval 失败: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  }
  return r.result.value;
}

async function main() {
  let list = await targets();
  let owner = list.find((t) => t.type === 'page' && /\/video\//.test(t.url) && !t.url.includes('win=menu'));
  if (!owner) {
    // 没有现成播放窗：借主窗（首页/我的等非播放窗）导航到一个视频页
    const main = list.find(
      (t) => t.type === 'page' && /localhost:8081\/?$|localhost:8081\/(mine|albums|zones|category)/.test(t.url)
    ) || list.find((t) => t.type === 'page' && !t.url.includes('win=menu'));
    if (!main) throw new Error('没有任何可用的页面目标: ' + JSON.stringify(list.map((t) => t.url)));
    const c0 = await connect(main.webSocketDebuggerUrl);
    await c0.send('Runtime.enable');
    await c0.send('Page.enable');
    // 视频卡在桌面端走 bridge 开窗(不是 <a> 链接)——直接问后端要第一个视频 id
    const api = await fetch('http://127.0.0.1:3001/api/yuese/list?page=1').then((r) => r.json());
    const vid = api && Array.isArray(api.items) && api.items[0] && api.items[0].id;
    if (!vid) throw new Error('API 没取到视频 id: ' + JSON.stringify(api).slice(0, 120));
    const videoHref = '/video/yuese/' + vid;
    console.log('[verify] 借主窗导航到:', videoHref);
    await c0.send('Page.navigate', { url: 'http://localhost:8081' + videoHref });
    c0.close();
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      list = await targets();
      owner = list.find((t) => t.type === 'page' && /\/video\//.test(t.url) && !t.url.includes('win=menu'));
      if (owner) break;
    }
    if (!owner) throw new Error('导航后没有视频页目标');
  }
  const c = await connect(owner.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  console.log('[verify] 播放窗:', owner.url);

  // 等控制条出现:控件 3s 自动隐藏,每轮先合成一次 mousemove 唤出控件再找钮
  //(出错态则拿不到钮,超时附页面文本辅助判断)
  let btn = null;
  let diag = '';
  for (let i = 0; i < 25 && !btn; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 300 });
    await sleep(400);
    const probe = await evalIn(c, `(() => {
      const el = document.querySelector('[aria-label="倍速"]');
      const r = el && el.getBoundingClientRect();
      return {
        btn: el && r ? { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.left, right: r.right, top: r.top } : null,
        text: document.body.innerText.slice(0, 60),
      };
    })()`);
    btn = probe.btn;
    diag = probe.text;
    if (!btn) await sleep(600);
  }
  if (!btn) throw new Error('控制条上没找到「倍速」钮;页面文本: ' + JSON.stringify(diag));
  console.log('[verify] 倍速钮(视口):', JSON.stringify(btn));
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(btn.x), y: Math.round(btn.y) });
  await sleep(250);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(btn.x), y: Math.round(btn.y - 2) });

  let menu = null;
  for (let i = 0; i < 20 && !menu; i++) {
    list = await targets();
    menu = list.find((t) => t.type === 'page' && t.url.includes('win=menu'));
    if (!menu) await sleep(500);
  }
  if (!menu) throw new Error('菜单窗目标没出现（menu-show 没走到？）');
  const cm = await connect(menu.webSocketDebuggerUrl);
  await cm.send('Runtime.enable');
  await sleep(600); // 等 menu-state 推送 + 内容渲染 + sized
  const info = await evalIn(cm, `(() => ({
    screenX: window.screenX, screenY: window.screenY,
    outerW: window.outerWidth, outerH: window.outerHeight,
    vis: document.visibilityState,
    text: document.body.innerText.slice(0, 40),
  }))()`);
  const own = await evalIn(c, '({sx: window.screenX, sy: window.screenY, iw: window.innerWidth, ow: window.outerWidth})');
  const scale = own.ow / own.iw;
  const btnScreen = {
    right: own.sx + btn.right * scale,
    top: own.sy + btn.top * scale,
  };
  const menuRight = info.screenX + info.outerW;
  const menuBottom = info.screenY + info.outerH;
  console.log('[verify] 菜单窗:', JSON.stringify(info));
  console.log('[verify] 钮屏幕(右/顶):', btnScreen.right.toFixed(0), btnScreen.top.toFixed(0));
  console.log('[verify] 菜单(右/底):', menuRight.toFixed(0), menuBottom.toFixed(0));
  const dRight = Math.abs(menuRight - btnScreen.right);
  const dBottom = Math.abs(menuBottom - btnScreen.top);
  console.log(`[verify] 对齐偏差: 右缘 ${dRight.toFixed(0)}px / 底边 ${dBottom.toFixed(0)}px ${dRight < 24 && dBottom < 24 ? '✓' : '✗ 超差'}`);
  console.log('[verify] 面板内容:', /2X/.test(info.text) ? '✓ 含 2X 档位' : '✗ 未见 2X: ' + JSON.stringify(info.text));
  c.close();
  cm.close();
  console.log('[verify] 完成');
}

main().catch((e) => {
  console.error('[verify] FAIL:', e.message);
  process.exit(1);
});
