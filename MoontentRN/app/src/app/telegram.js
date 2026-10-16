// ============================================================================
// telegram.js —— Telegram 专属页(顶层路由,同 board.js 层级)
// ----------------------------------------------------------------------------
// 账号型站源的独立入口页,四种形态按会话状态切换(登录态机四分支不降级,
// 蓝图一 §8.1-1):
//   ① 未配置凭据(session.creds === false)——明确文案指引到 server/.env 配
//      TELEGRAM_API_ID / TELEGRAM_API_HASH(my.telegram.org 申请);
//   ② 未登录——页内三步登录流程:手机号(发验证码)→ 验证码 → 两步验证密码;
//      phase==='code' 且 error 非空 = 验证码错误需重输;两步验证带 hint;
//      任意步骤可「取消」作废在途登录(cancel)回到手机号步;
//   ③ 已登录——对话列表(Telegram-iOS ChatListController 功能面):
//      筛选 chips 动态 tabs:全部 + 账号聊天文件夹(/dialogs 响应 folders 字段,
//      filter='folder:<id>')+ 归档(filter='archive';群组/频道/收藏旧档位对齐
//      官方移除,收藏伪对话已在全部列表内置顶);行(DialogRow 共享件,TI 行内
//      信息结构)
//      = 头像(经 /api/img 代理)| 名称+kind 徽标/时间(置顶加 Pin 角标)+
//      最后消息预览(出站「我: 」、群聊署名「名字: 」前缀,媒体出中文占位)|
//      未读气泡(静音灰调,@ 提醒);无限滚动;下拉刷新(RefreshControl);
//      聚焦静默刷新;行长按出上下文菜单(置顶/静音/标记已读未读/归档/删除,
//      增量端点 POST /api/telegram/dialog/update|delete,引擎不支持时契约
//      错误原文呈现);行点击进 /telegram/chat/<id>(聊天页,对话默认入口);
//   ④ 原位搜索(example ChatsScreen 头部形态):对话名对已载页客户端过滤
//      (服务端 dialogs 无 q 参数且契约不动);搜索词以「#」开头时追加全局
//      公开帖结果段(GET /api/telegram/search/global,增量端点,引擎不支持
//      契约化降级呈现);空态四文案差异化(搜索无果/键入提示/错误原文/无对话)。
//      共享媒体面板 /telegram/media/[id](媒体/文件/链接/语音)从聊天页头部
//      「头像+标题区」进入;头部提供退出登录(确认弹层)。
// 会话内搜索(官方式:聊天页头部搜索条+结果导航条,ChatSearchHeader)与
// 消息日历(CalendarPanel)由聊天页(chat/[id].js)装配,组件落在
// components/telegram/search/。
// 接口全部走 api('telegram', <method>)(GET /api/telegram/*,专属端点契约见
// server routes/telegram.js)与 tg-api.js 的 postJson(增量端点 POST 通道):
// session/login/verify/password/cancel/logout/dialogs + dialog/update、
// dialog/delete。注意:
//   · 登录三接口是服务端分钟级态机(等验证码相位 60s / 校验结论 90s 上限),
//     client 默认 20s 超时会提前掐断在途请求(前端见超时、后端态机仍在推进,
//     流程断裂)——传自定义 signal 时 client 不套默认超时(见 lib/client.js
//     rawGet),这里自给 95s 兜底;
//   · session 是易变态,不走 client 的 meta 缓存('session' 不在 META_METHODS,
//     每次都现拉);
//   · 失败如实上抛展示,绝不自动重试(防请求风暴,仓库红线)。
// ============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, RefreshControl, ScrollView, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { router, useFocusEffect } from 'expo-router';
import {
  ChevronLeft, Search, Send,
} from '../components/icons.js';
import { api } from '../lib/client.js';
import { postJson } from '../lib/tg-api.js';
import { useInfiniteList, toPage } from '../hooks/use-infinite-list.js';
import { useForm } from '../lib/use-form.js';
import { useChromeInsets } from '../hooks/use-chrome-scroll.js';
import { usePalette } from '../components/ui/palette.js';
import Button from '../components/ui/Button.jsx';
import Input from '../components/ui/Input.jsx';
import Dialog from '../components/ui/Dialog.jsx';
import Skeleton from '../components/ui/Skeleton.jsx';
import Spinner from '../components/ui/Spinner.jsx';
import ChipsBar from '../components/video/ChipsBar.jsx';
import EmptyState from '../components/home/EmptyState.jsx';
import ErrorState from '../components/home/ErrorState.jsx';
import ListFooter from '../components/home/ListFooter.jsx';
import { DialogRow } from '../components/telegram/index.js'; // 桶导入(蓝图二 §5.5-2;与 ForwardPanel 同一单源)
import SearchBar from '../components/telegram/search/SearchBar.jsx';
import GlobalSearchSection from '../components/telegram/search/GlobalSearchSection.jsx';
import ContextMenu from '../components/telegram/context-menu/ContextMenu.jsx';
import { dialogAbilities } from '../lib/telegram-actions/abilities.js';
import { buildDialogMenu } from '../lib/telegram-actions/message-menu.js';

const DLG_SIZE = 30;            // 对话列表每页条数
const LOGIN_TIMEOUT_MS = 95000; // 登录态机接口的前端兜底超时(> 服务端 90s 等待上限)

// 筛选 tabs 固定档:key 直连后端 filter 参数。中段动态插账号自建聊天文件夹
// (数据来自 /dialogs 响应 folders 字段,契约 [{id,title,emoji}],可能为空数组
// ——空时仅「全部+归档」);「收藏」不再是 tab(saved 伪对话已在全部列表内置
// 顶),群组/频道类型筛选对齐官方移除。
const TAB_ALL = { key: 'all', label: '全部' };
const TAB_ARCHIVE = { key: 'archive', label: '归档' };

// folders 原始数组 → tab 段:key 即后端 filter 取值('folder:'+id);脏条目
// (缺 id/非数字 id)跳过;emoji 与标题拼展示标签(官方文件夹名同款形态)
function folderTabs(folders) {
  const tabs = [];
  for (const f of Array.isArray(folders) ? folders : []) {
    if (!f || f.id == null) continue;
    const id = Number(f.id);
    if (!Number.isFinite(id)) continue;
    const title = typeof f.title === 'string' && f.title.trim() ? f.title.trim() : '文件夹';
    const emoji = typeof f.emoji === 'string' ? f.emoji.trim() : '';
    tabs.push({ key: 'folder:' + id, label: emoji ? emoji + ' ' + title : title });
  }
  return tabs;
}

// 登录态机接口的慢通道:自定义 signal 绕开 client 默认 20s 超时(client 契约:
// 传 signal 即不设兜底),自给 95s;AbortController 不可用的远古环境退化为不设限
function loginApi(method, params) {
  if (typeof AbortController === 'undefined') return api('telegram', method, params);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LOGIN_TIMEOUT_MS);
  return api('telegram', method, params, { signal: ctl.signal }).finally(() => clearTimeout(timer));
}

// —— 头像 / kind 徽标 / 对话行:共享件 DialogRow(与聊天页同源视觉,行内
// 信息结构与未读/置顶/静音语义见其文件头) ——

// ============================================================================
// 登录面板:手机号 → 验证码 →(两步验证密码)三步态机
// (AuthScreen 设计质量保留现状,四分支不变;三步态机与 95s 慢通道契约不动,
// 蓝图一 §8.1-1/2)
// ============================================================================
function LoginPanel({ onDone }) {
  const p = usePalette();
  const [step, setStep] = useState('phone'); // phone | qr | code | password
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [hint, setHint] = useState(''); // 两步验证密码提示(服务端下发)
  const [qrImg, setQrImg] = useState(''); // QR 扫码登录:服务端渲染的 PNG dataURL
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const go = useCallback(async (fn) => {
    if (busy) return; // 在途防重入(按钮另有 disabled,双保险)
    setBusy(true);
    setErr('');
    try {
      await fn();
    } catch (e) {
      if (aliveRef.current) setErr((e && e.message) || '操作失败,请重试');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [busy]);

  // —— QR 扫码登录(teleproto 引擎新增):/qr 取服务端渲染的二维码 PNG,
  //    手机端 Telegram「设置→设备→登录桌面设备」扫码确认;前端轮询 /session
  //    等相位变 ok(服务端内部每 3s 轮询 ExportLoginToken,前端 3s 对齐) ——
  const startQr = useCallback(() => {
    go(async () => {
      const r = await loginApi('qr');
      if (r && r.phase === 'ok') { onDone(); return; } // 极速完成(已授权回声)
      if (r && r.phase === 'qr' && r.qr) {
        setQrImg(r.qr);
        setStep('qr');
        return;
      }
      throw new Error((r && r.error) || '二维码获取失败,请重试');
    });
  }, [go, onDone]);

  // QR 轮询:step==='qr' 期间每 3s 拉 /session;authorized 即完成。离开该步/
  // 卸载即停(服务端另有 10min 登录闲置自毁兜底)
  useEffect(() => {
    if (step !== 'qr') return undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const s = await api('telegram', 'session');
        if (stopped) return;
        if (s && s.authorized) { onDone(); return; }
        if (s && s.phase && s.phase !== 'qr') {
          // 服务端相位漂移(超时作废/中断):回手机号步如实重开
          setStep('phone');
          setQrImg('');
          if (s.error) setErr(s.error);
        }
      } catch (_e) { /* 单次轮询失败静默:下一轮再试(面板错误以显式动作为准) */ }
    };
    const timer = setInterval(poll, 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, [step, onDone]);

  // ① 发起登录(发送验证码):成功进 code 步
  const submitPhone = useCallback(() => {
    go(async () => {
      if (!/^\+?\d{6,16}$/.test(phone.trim())) throw new Error('手机号格式不正确(应含国际区号,如 +8613800138000)');
      await loginApi('login', { phone: phone.trim() });
      setCode('');
      setStep('code');
    });
  }, [go, phone]);

  // ② 提交验证码:phase ok=完成 / password=进两步验证 / code(带 error)=验证码错重输
  const submitCode = useCallback(() => {
    go(async () => {
      const r = await loginApi('verify', { code: code.trim() });
      if (r && r.phase === 'ok') { onDone(); return; }
      if (r && r.phase === 'password') {
        setHint((r && r.hint) || '');
        setPw('');
        setStep('password');
        return;
      }
      // 验证码错误:留在本步清空重输
      setCode('');
      throw new Error((r && r.error) || '验证码不正确,请重试');
    });
  }, [go, code, onDone]);

  // ③ 提交两步验证密码:phase ok=完成 / password(带 error)=密码错重输
  const submitPw = useCallback(() => {
    go(async () => {
      const r = await loginApi('password', { pw });
      if (r && r.phase === 'ok') { onDone(); return; }
      setPw('');
      throw new Error((r && r.error) || '密码不正确,请重试');
    });
  }, [go, pw, onDone]);

  // 取消:作废在途登录态机(手机流/QR 流通用),回到手机号步
  const doCancel = useCallback(() => {
    go(async () => { await api('telegram', 'cancel'); });
    setStep('phone');
    setCode('');
    setPw('');
    setHint('');
    setQrImg('');
  }, [go]);

  const stepLabel = step === 'phone' ? '登录 Telegram'
    : step === 'qr' ? '扫码登录'
      : step === 'code' ? '输入验证码' : '两步验证';

  return (
    <View style={{ maxWidth: 460, width: '100%', alignSelf: 'center', paddingTop: 32 }}>
      {/* 步骤头:纸飞机 + 当前步骤名 */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Send size={28} color={p.foreground} />
        <Text style={{ fontSize: 20, fontWeight: '700', color: p.foreground }}>{stepLabel}</Text>
      </View>
      <Text style={{ marginTop: 8, fontSize: 13, lineHeight: 19, color: p.muted }}>
        用你自己的 Telegram 账号登录,即可浏览已加入群组 / 频道 / 我的收藏里的视频。会话仅保存在服务端本机。
      </Text>

      <View style={{ marginTop: 24, gap: 12 }}>
        {step === 'phone' ? (
          <>
            <Text style={{ fontSize: 13, color: p.muted }}>手机号(含国际区号)</Text>
            <Input
              value={phone}
              onChangeText={setPhone}
              placeholder="+8613800138000"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="phone-pad"
              onSubmitEditing={submitPhone}
              returnKeyType="send"
            />
            <Button onPress={submitPhone} disabled={busy || !phone.trim()}>
              {busy ? <Spinner size={14} color={p.background} /> : null}
              <Text style={{ fontSize: 14, fontWeight: '500', color: p.background, includeFontPadding: false }}>
                {busy ? '正在发送验证码…' : '发送验证码'}
              </Text>
            </Button>
            <Button variant="ghost" onPress={startQr} disabled={busy}>
              <Text style={{ fontSize: 13, color: p.muted }}>扫码登录(手机端 Telegram 确认)</Text>
            </Button>
          </>
        ) : step === 'qr' ? (
          <>
            <Text style={{ fontSize: 13, color: p.muted, lineHeight: 19 }}>
              打开手机端 Telegram → 设置 → 设备 → 登录桌面设备,扫描下方二维码确认登录。
            </Text>
            {qrImg ? (
              <View style={{
                alignSelf: 'center', width: 232, height: 232, borderRadius: 12,
                backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center',
              }}>
                <Image
                  source={{ uri: qrImg }}
                  style={{ width: 220, height: 220 }}
                  resizeMode="contain"
                />
              </View>
            ) : null}
            <Button variant="ghost" onPress={doCancel} disabled={busy}>
              <Text style={{ fontSize: 13, color: p.muted }}>取消登录</Text>
            </Button>
          </>
        ) : step === 'code' ? (
          <>
            <Text style={{ fontSize: 13, color: p.muted }} numberOfLines={1}>
              验证码已发送至 {phone.trim() || '你的手机号'},请查收 Telegram 官方消息。
            </Text>
            <Input
              value={code}
              onChangeText={setCode}
              placeholder="登录验证码"
              keyboardType="number-pad"
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={submitCode}
              returnKeyType="send"
            />
            <Button onPress={submitCode} disabled={busy || !code.trim()}>
              {busy ? <Spinner size={14} color={p.background} /> : null}
              <Text style={{ fontSize: 14, fontWeight: '500', color: p.background, includeFontPadding: false }}>
                {busy ? '正在验证…' : '提交验证码'}
              </Text>
            </Button>
            <Button variant="ghost" onPress={doCancel} disabled={busy}>
              <Text style={{ fontSize: 13, color: p.muted }}>取消登录</Text>
            </Button>
          </>
        ) : (
          <>
            <Text style={{ fontSize: 13, color: p.muted }}>该账号开启了两步验证,请输入云密码。</Text>
            {hint ? (
              <Text style={{ fontSize: 12, color: p.muted, opacity: 0.8 }} numberOfLines={1}>
                密码提示:{hint}
              </Text>
            ) : null}
            <Input
              value={pw}
              onChangeText={setPw}
              placeholder="两步验证密码"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={submitPw}
              returnKeyType="send"
            />
            <Button onPress={submitPw} disabled={busy || !pw}>
              {busy ? <Spinner size={14} color={p.background} /> : null}
              <Text style={{ fontSize: 14, fontWeight: '500', color: p.background, includeFontPadding: false }}>
                {busy ? '正在验证…' : '提交密码'}
              </Text>
            </Button>
            <Button variant="ghost" onPress={doCancel} disabled={busy}>
              <Text style={{ fontSize: 13, color: p.muted }}>取消登录</Text>
            </Button>
          </>
        )}

        {/* 步骤内错误(验证码错/密码错/网络错):红字如实展示,不自动重试 */}
        {err ? (
          <Text style={{ fontSize: 13, lineHeight: 18, color: p.accent }}>{err}</Text>
        ) : null}
      </View>
    </View>
  );
}

// ============================================================================
// 已登录:对话列表(筛选 chips + 无限滚动 + 下拉刷新 + 原位搜索 + 行上下文菜单
// + 聚焦静默刷新)
// ============================================================================
function DialogsView({ me, onLoggedOut }) {
  const p = usePalette();
  const { form } = useForm();
  const padH = form === 'phone' ? 12 : 24; // 主区留白约定:px-3 / md:px-6
  const chrome = useChromeInsets();        // 手机画幅顶/底栏悬浮避让(pad/PC 恒 0)
  const [filter, setFilter] = useState('all');
  // 账号聊天文件夹(动态 tabs 数据源;null=尚未见过 folders 字段,[]=账号无文件夹)
  const [folders, setFolders] = useState(null);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [error, setError] = useState(''); // 页内轻提示(登出/对话动作失败),不打断列表

  // —— 原位搜索(example ChatsScreen 头部形态:头部整行换成搜索条+取消)——
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');

  // —— 行上下文菜单(域 5:置顶/静音/标记已读未读/归档/删除)——
  const [menuRow, setMenuRow] = useState(null); // 菜单目标行(item)
  const [menuBusy, setMenuBusy] = useState(false);
  const [delRow, setDelRow] = useState(null);   // 删除确认目标行
  const [delBusy, setDelBusy] = useState(false);
  // 本地移除集合(删除对话/归档成功后行即时退场;服务端真相由静默刷新回流,
  // 上游仍列出该对话时重挂页面即回显——不为「看起来删掉」篡改服务端真相)
  const [removedIds, setRemovedIds] = useState(() => new Set());

  // folders 字段捕获:/dialogs 响应顶层新增 folders(文件夹目录,可与任意
  // filter/页码同回);字段缺席(服务端未具备该能力或该页未带)不更新——
  // 不把「未下发」误当「已清空」。文件夹是账号级元数据,与 filter 无关,
  // 被作废旧世代的响应覆写同值无害。
  const captureFolders = useCallback((res) => {
    if (!res || !Array.isArray(res.folders)) return;
    setFolders(res.folders);
  }, []);

  // 筛选 tabs = 全部 + 文件夹段 + 归档(folders 未到位/为空时仅两档)
  const tabs = useMemo(() => [TAB_ALL, ...folderTabs(folders), TAB_ARCHIVE], [folders]);

  // 对话分页取数(切筛选由 deps 重置回第 1 页);失败如实上抛(err 态给重试)
  const fetchPage = useCallback(
    (page) => api('telegram', 'dialogs', { page, size: DLG_SIZE, filter }).then((res) => {
      captureFolders(res); // 顺带收 folders(toPage 只留 items/hasMore,须先取)
      return toPage(res);
    }),
    [filter, captureFolders]
  );
  const { items, loading, loadingMore, err, done, loadMore, reload } =
    useInfiniteList(fetchPage, [filter]);

  // 卸载标记:共享的静默刷新在卸载后丢弃迟到响应
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // 静默刷新快照(聚焦回列表 / 对话动作成功后共用):重拉第 1 页按 id 覆盖
  // 行内展示字段(未读数/最后消息/置顶/静音等水位),失败静默吞掉不弹错
  // (容错红线);不走 reload——reload 会整页回骨架屏,非「静默」。
  const [fresh, setFresh] = useState(null); // { filter, byId } 快照(按 id 覆盖)
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const silentRefresh = useCallback(() => {
    const want = filterRef.current; // 请求时的筛选(响应到达时筛选可能已切)
    api('telegram', 'dialogs', { page: 1, size: DLG_SIZE, filter: want })
      .then((res) => { captureFolders(res); return toPage(res); })
      .then((r) => {
        if (!aliveRef.current || !r || !Array.isArray(r.items)) return;
        const byId = {};
        for (const d of r.items) {
          if (d && d.id != null) byId[d.id] = d;
        }
        setFresh({ filter: want, byId });
      })
      .catch(() => {}); // 静默:刷新失败不打扰列表
  }, [captureFolders]);

  // 聚焦静默刷新(现状机制保留):首次聚焦跳过(挂载时 useInfiniteList 正在
  // 拉第 1 页,重复请求无益);从聊天页返回时水位即刷新。
  const firstFocusRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocusRef.current) {
        firstFocusRef.current = false;
        return undefined;
      }
      silentRefresh();
      return undefined;
    }, [silentRefresh])
  );

  // 行数据 = 已加载列表 + 同筛选的静默快照按 id 覆盖(只补水位,不动分页结构)
  // − 本地移除集合。快照缺的深页行保持原数据,滚动加载新页时自然换新。
  const rows = useMemo(() => {
    let base = items;
    if (base && fresh && fresh.filter === filter) {
      base = base.map((x) => (x && fresh.byId[x.id]) || x);
    }
    if (base && removedIds.size) {
      base = base.filter((x) => x && !removedIds.has(x.id));
    }
    return base;
  }, [items, fresh, filter, removedIds]);

  // 对话名索引:全部已载行(跨筛选)并入 Map,供全局搜索段解析对话名
  // (增量端点不回源对话名,绝不逐条回源是仓库红线;未命中行退 peerKey 兜底)
  const dialogIndexRef = useRef(new Map());
  useEffect(() => {
    const map = dialogIndexRef.current;
    for (const d of rows || []) {
      if (d && d.id != null) {
        map.set(String(d.id), {
          name: typeof d.name === 'string' ? d.name : '',
          kind: typeof d.kind === 'string' ? d.kind : '',
          avatar: typeof d.avatar === 'string' ? d.avatar : '',
        });
      }
    }
  }, [rows]);
  const resolveChat = useCallback(
    (pk) => dialogIndexRef.current.get(String(pk)) || null,
    []
  );

  // 行点击:进对话聊天页(对话默认入口);头部元数据(名称/头像/kind)随路由
  // 参数带给聊天页,免其冷深链重复拉对话表(expo-router params 均为字符串)
  const openPeer = useCallback((d) => {
    if (!d || d.id == null) return;
    router.push({
      pathname: '/telegram/chat/[id]',
      params: {
        id: String(d.id),
        name: typeof d.name === 'string' ? d.name : '',
        avatar: typeof d.avatar === 'string' ? d.avatar : '',
        kind: typeof d.kind === 'string' ? d.kind : '',
      },
    });
  }, []);

  // 行长按:上下文菜单(域 5 会话行动作;DialogRow onLongPress 外抛)
  const openRowMenu = useCallback((item) => {
    setMenuRow(item);
  }, []);

  // 全局搜索段(# 词)结果跳转:push 聊天页带 anchor 定位到该消息(有已载
  // 元数据则一并带,冷对话由聊天页首屏响应补齐)
  const openSearchMessage = useCallback((msg) => {
    if (!msg || msg.peerKey == null || msg.id == null) return;
    const pk = String(msg.peerKey);
    const meta = dialogIndexRef.current.get(pk) || null;
    router.push({
      pathname: '/telegram/chat/[id]',
      params: {
        id: pk,
        name: (meta && meta.name) || '',
        avatar: (meta && meta.avatar) || '',
        kind: (meta && meta.kind) || '',
        anchor: String(msg.id),
      },
    });
  }, []);

  // 对话动作(单字段/次,多字段由服务端 400 拒绝):先关菜单,成功后乐观落地
  // 行内状态 + 静默刷新取服务端真相;失败红字如实呈现(不自动重试)。
  // 说明:标记未读/归档在行上无对应展示字段(unread 标志/归档夹),视觉反馈
  // 以静默刷新与列表真序为准;mtproto 目录迭代含归档夹,归档行可能仍被上游
  // 列出(tdlib 归档即从主列表移除),本地先按移除呈现。
  const runDialogUpdate = useCallback((item, patch) => {
    setMenuRow(null);
    if (menuBusy || !item || item.id == null) return;
    setMenuBusy(true);
    postJson('/api/telegram/dialog/update', { peer: item.id, ...patch })
      .then(() => {
        setFresh((prev) => {
          const want = filterRef.current;
          const base = prev && prev.filter === want ? prev.byId : {};
          return { filter: want, byId: { ...base, [item.id]: { ...item, ...patch } } };
        });
        if (patch.archived) {
          setRemovedIds((prev) => new Set(prev).add(item.id));
        }
        silentRefresh();
      })
      .catch((e) => {
        setError((x) => x || (e && e.message) || '操作失败,请重试');
      })
      .finally(() => setMenuBusy(false));
  }, [menuBusy, silentRefresh]);

  // 删除对话(确认弹层后执行):从列表移除并清空历史,不退出群组/频道本身
  // (TI 行 Delete 的 leave+delete 语义降级,确认文案如实描述——页面蓝图 §4.2-10)
  const runDialogDelete = useCallback(() => {
    const item = delRow;
    setDelRow(null);
    if (delBusy || !item || item.id == null) return;
    setDelBusy(true);
    postJson('/api/telegram/dialog/delete', { peer: item.id })
      .then(() => {
        setRemovedIds((prev) => new Set(prev).add(item.id));
        silentRefresh();
      })
      .catch((e) => {
        setError((x) => x || (e && e.message) || '删除失败,请重试');
      })
      .finally(() => setDelBusy(false));
  }, [delBusy, delRow, silentRefresh]);

  // 菜单项目录(可用性推导在 telegram-actions/abilities.js 的 dialogAbilities,
  // 域 3 EnabledContextActions;置顶/静音/未读按行现态出反义标签):
  // 注 1:行数据无「已归档」字段,归档只出单向「归档」项(取消归档无入口,
  //   与现有列表信息面一致,如实降级);
  // 注 2:abilities 读 item.peerKey,dialogs 行契约字段是 id——装配层适配;
  // 注 3:icon 传 M4 注册表的 string 键(context-menu MENU_ICONS,非组件)。
  // 注 4:项目录收敛为 M4 的 buildDialogMenu 单一来源(2026-10-12 复核,消除
  //   与 message-menu.js 的双份目录漂移面;标签/图标键逐字同源)
  const menuItems = useMemo(() => {
    if (!menuRow) return [];
    const row = { ...menuRow, peerKey: menuRow.id };
    return buildDialogMenu(row, dialogAbilities(row, {}), {
      onTogglePin: (_item, pinned) => runDialogUpdate(menuRow, { pinned }),
      onToggleMute: (_item, muted) => runDialogUpdate(menuRow, { muted }),
      onMarkUnread: (_item, makeUnread) => runDialogUpdate(menuRow, { unread: makeUnread }),
      onArchive: () => runDialogUpdate(menuRow, { archived: true }),
      onDelete: () => { setDelRow(menuRow); setMenuRow(null); },
    });
  }, [menuRow, runDialogUpdate]);

  // 搜索模式:对已载页客户端过滤对话名(服务端 dialogs 无 q 参数且契约不动,
  // 页面蓝图 §5.3-D);# 词追加全局公开帖段
  const q = query.trim();
  const isTag = q.startsWith('#') && q.length > 1;
  const searchRows = useMemo(() => {
    if (!q) return [];
    const kw = q.toLowerCase();
    return (rows || []).filter((x) => String((x && x.name) || '').toLowerCase().includes(kw));
  }, [rows, q]);

  // 退出登录:确认弹层 → logout → 回到登录态(父层重拉 session)
  const doLogout = useCallback(() => {
    if (logoutBusy) return;
    setLogoutBusy(true);
    api('telegram', 'logout')
      .then(() => { setLogoutOpen(false); onLoggedOut(); })
      .catch((e) => {
        setLogoutOpen(false);
        if (e && e.message) {
          // 登出失败如实提示:留在列表态,不强行清 UI
          setError((x) => x || e.message);
        }
      })
      .finally(() => setLogoutBusy(false));
  }, [logoutBusy, onLoggedOut]);

  // 对话行渲染:行组件独立(共享件 DialogRow;列表/搜索两处同款)
  const renderRow = useCallback(
    ({ item }) => <DialogRow item={item} onOpen={openPeer} onLongPress={openRowMenu} />,
    [openPeer, openRowMenu]
  );

  const hasList = !!(rows && rows.length);

  // 返回:栈里有上一级就 back(任何进入路径都成立);冷启动深链直达无下垫,
  // 回首页兜底(观看页 back() 同款口径)
  const back = useCallback(() => {
    try {
      if (typeof router.canGoBack === 'function' && router.canGoBack()) {
        router.back();
        return;
      }
    } catch (_e) { /* 判定异常走兜底 */ }
    router.replace('/');
  }, []);

  // 关闭搜索:清词退回列表态
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery('');
  }, []);

  return (
    <View style={{ flex: 1 }}>
      {/* 页头:搜索态=搜索条+取消(example ChatsScreen 形态);常规态=返回 chip
          + 标题 + 账号 + 搜索入口 + 退出(手机画幅垫悬浮顶栏) */}
      {searchOpen ? (
        <View style={{ paddingHorizontal: padH, paddingTop: 12 + chrome.top, marginBottom: 12 }}>
          <SearchBar value={query} onChange={setQuery} autoFocus onCancel={closeSearch} />
        </View>
      ) : (
        <View
          style={{
            paddingHorizontal: padH,
            paddingTop: 12 + chrome.top,
            marginBottom: 12,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <Button variant="ghost" onPress={back}>
            <ChevronLeft size={16} color={p.foreground} />
            <Text style={{ color: p.foreground, fontSize: 14, fontWeight: '500', includeFontPadding: false }}>
              返回
            </Text>
          </Button>
          <Send size={22} color={p.foreground} />
          <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 18, fontWeight: '700', color: p.foreground }}>
            Telegram
          </Text>
          <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 12, color: p.muted, textAlign: 'right' }}>
            {(me && (me.name || me.phone)) || ''}
          </Text>
          <Button variant="ghost" size="sm" onPress={() => setSearchOpen(true)}>
            <Search size={16} color={p.foreground} />
          </Button>
          <Button variant="ghost" size="sm" onPress={() => setLogoutOpen(true)}>
            <Text style={{ fontSize: 12, fontWeight: '500', color: p.muted, includeFontPadding: false }}>退出登录</Text>
          </Button>
        </View>
      )}

      {/* 筛选 chips:全部 + 账号文件夹 + 归档(动态 tabs,key 直连后端 filter;
          ChipsBar 本就是横向 ScrollView,多 tab 天然横滚);搜索态隐藏 */}
      {!searchOpen ? (
        <View style={{ paddingHorizontal: padH, marginBottom: 12 }}>
          <ChipsBar items={tabs} active={filter} onChange={setFilter} />
        </View>
      ) : null}

      {/* 页内提示条(登出/对话动作失败等):轻量红字,不打断列表 */}
      {error ? (
        <View style={{ paddingHorizontal: padH, marginBottom: 4 }}>
          <Text numberOfLines={2} style={{ fontSize: 12, color: p.accent }}>{error}</Text>
        </View>
      ) : null}

      {/* 列表主体:常规态=骨架/失败重试/空态/行列表 + 无限滚动 + 下拉刷新;
          搜索态=名称过滤行 + (#词)全局公开帖段,空态四文案差异化 */}
      <View style={{ flex: 1, minHeight: 0, paddingHorizontal: padH }}>
        {!searchOpen ? (
          loading ? (
            <View style={{ gap: 4 }}>
              {Array.from({ length: 8 }, (_, i) => (
                <View key={i} style={{ maxWidth: 860, width: '100%', alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 10, paddingHorizontal: 8 }}>
                  <Skeleton style={{ width: 52, height: 52, borderRadius: 26 }} />
                  <View style={{ flex: 1, gap: 8 }}>
                    <Skeleton style={{ height: 14, width: '46%' }} />
                    <Skeleton style={{ height: 12, width: '28%' }} />
                  </View>
                </View>
              ))}
            </View>
          ) : err && !items ? (
            <ErrorState message={err} onRetry={reload} />
          ) : !hasList ? (
            <EmptyState
              icon={Send}
              title={filter === 'all' ? '暂无对话' : filter === 'archive' ? '没有归档的对话' : '该文件夹暂无对话'}
              desc={filter === 'all' ? '加入 Telegram 群组或频道后,这里就能看到它们' : undefined}
            />
          ) : (
            <FlashList
              data={rows}
              keyExtractor={(x) => (x && x.id != null ? String(x.id) : 'x')}
              estimatedItemSize={72}
              showsVerticalScrollIndicator={false}
              scrollEventThrottle={16} // FlashList v2 内部恒挂 onScroll,不传会被 RNW 逐滚动事件打提示
              onEndReached={loadMore}
              onEndReachedThreshold={0.5}
              contentContainerStyle={{ paddingBottom: 12 + chrome.bottom }}
              renderItem={renderRow}
              // 下拉刷新(页面蓝图 §5.5-1):RefreshControl → reload;tint 走
              // link 语义色。reload 即回第 1 页(经骨架屏,与现有刷新口径一致;
              // 与聚焦静默刷新叠加无害)
              refreshControl={
                <RefreshControl
                  refreshing={!!loading}
                  onRefresh={reload}
                  tintColor={p.link}
                  colors={[p.link]}
                />
              }
            />
          )
        ) : (
          <ScrollView
            keyboardShouldPersistTaps="handled"
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: 12 + chrome.bottom }}
          >
            {!q ? (
              /* 键入提示(搜索空词态) */
              <EmptyState
                icon={Search}
                title="输入关键词搜索"
                desc="按对话名过滤已加载的对话;输入 #话题 可搜索全局公开帖"
              />
            ) : (
              <>
                {searchRows.length ? (
                  <View>
                    {searchRows.map((item) => (
                      <DialogRow key={String(item.id)} item={item} onOpen={openPeer} onLongPress={openRowMenu} />
                    ))}
                  </View>
                ) : (
                  /* 搜索无果(对话名过滤) */
                  <Text style={{ fontSize: 13, color: p.muted, paddingHorizontal: 8, paddingVertical: 12 }}>
                    未找到匹配的对话
                  </Text>
                )}
                {isTag ? (
                  <View style={{ marginTop: 8 }}>
                    {/* 全局公开帖段(仅 # 话题;加载/空态/契约错误原文由段内呈现) */}
                    <GlobalSearchSection
                      query={q}
                      resolveChat={resolveChat}
                      onOpenMessage={openSearchMessage}
                    />
                  </View>
                ) : null}
              </>
            )}
          </ScrollView>
        )}
      </View>

      {/* 列表底态条(与 board 页同款:加载更多失败重试 / 到底 / 加载中);
          搜索态不参与分页,不渲染 */}
      {!searchOpen && hasList ? (
        <View style={{ paddingHorizontal: padH, paddingBottom: 12 + chrome.bottom }}>
          <ListFooter loading={loadingMore} error={err || ''} done={done} onRetry={loadMore} />
        </View>
      ) : null}

      {/* 行上下文菜单(置顶/静音/标记已读未读/归档/删除;M4 通用容器) */}
      <ContextMenu visible={!!menuRow} onClose={() => setMenuRow(null)} items={menuItems} />

      {/* 删除对话确认(危险操作二次确认;文案如实描述降级语义) */}
      <Dialog visible={!!delRow} onClose={() => setDelRow(null)} title="删除对话">
        <Text style={{ fontSize: 14, lineHeight: 20, color: p.muted }}>
          将从对话列表移除「{(delRow && delRow.name) || ''}」并清空历史消息记录;不会退出群组/频道本身。确定删除?
        </Text>
        <View style={{ marginTop: 20, flexDirection: 'row', justifyContent: 'flex-end', gap: 12 }}>
          <Button variant="secondary" onPress={() => setDelRow(null)}>取消</Button>
          <Button onPress={runDialogDelete} disabled={delBusy} style={{ backgroundColor: p.accent }}>
            <Text style={{ fontSize: 14, fontWeight: '500', color: '#ffffff' }}>
              {delBusy ? '删除中…' : '删除'}
            </Text>
          </Button>
        </View>
      </Dialog>

      {/* 退出登录确认(危险操作二次确认,mine.js 清空历史同款形态) */}
      <Dialog visible={logoutOpen} onClose={() => setLogoutOpen(false)} title="退出 Telegram 登录">
        <Text style={{ fontSize: 14, lineHeight: 20, color: p.muted }}>
          退出后需要重新验证手机号才能再次浏览,确定退出?
        </Text>
        <View style={{ marginTop: 20, flexDirection: 'row', justifyContent: 'flex-end', gap: 12 }}>
          <Button variant="secondary" onPress={() => setLogoutOpen(false)}>取消</Button>
          <Button onPress={doLogout} disabled={logoutBusy} style={{ backgroundColor: p.accent }}>
            <Text style={{ fontSize: 14, fontWeight: '500', color: '#ffffff' }}>
              {logoutBusy ? '退出中…' : '退出登录'}
            </Text>
          </Button>
        </View>
      </Dialog>
    </View>
  );
}

// ============================================================================
// 页面外壳:session 探测 → 凭据缺失指引 / 登录面板 / 对话列表
// ----------------------------------------------------------------------------
// tick(重试/登录完成/登出)变化即换 key 整体重挂会话体——初始态天然回到
// 「探测中」骨架,会话体 effect 内只在异步回调 setState(不在 effect 体内
// 同步 setState,React Compiler 诊断红线),语义与「重置状态再拉」完全等价。
// ============================================================================
export default function TelegramPage() {
  const [tick, setTick] = useState(0);
  return <TelegramSession key={tick} onCycle={() => setTick((t) => t + 1)} />;
}

function TelegramSession({ onCycle }) {
  const p = usePalette();
  const { form } = useForm();
  const padH = form === 'phone' ? 12 : 24;
  const chrome = useChromeInsets();

  const [session, setSession] = useState(null); // null = 探测中
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    api('telegram', 'session')
      .then((s) => { if (alive) setSession(s || {}); })
      .catch((e) => { if (alive) setErr((e && e.message) || '登录状态获取失败'); });
    return () => { alive = false; };
  }, []);

  // session 探测失败:整页错误态 + 重试
  if (err) {
    return (
      <View style={{ flex: 1, paddingHorizontal: padH, paddingTop: chrome.top }}>
        <ErrorState message={'登录状态获取失败:' + err} onRetry={onCycle} />
      </View>
    );
  }

  // 探测中:页头骨架(标题行 + chips + 首屏行)
  if (!session) {
    return (
      <View style={{ flex: 1, paddingHorizontal: padH, paddingTop: 12 + chrome.top, gap: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Skeleton style={{ height: 32, width: 160, borderRadius: 8 }} />
        </View>
        <View style={{ flexDirection: 'row', gap: 12, paddingVertical: 2 }}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} style={{ height: 32, width: 64, borderRadius: 8 }} />
          ))}
        </View>
        <View style={{ gap: 4 }}>
          {Array.from({ length: 6 }, (_, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 10, paddingHorizontal: 8 }}>
              <Skeleton style={{ width: 52, height: 52, borderRadius: 26 }} />
              <View style={{ flex: 1, gap: 8 }}>
                <Skeleton style={{ height: 14, width: '46%' }} />
                <Skeleton style={{ height: 12, width: '28%' }} />
              </View>
            </View>
          ))}
        </View>
      </View>
    );
  }

  // 凭据缺失:明确文案指引配置(此时登录/数据面均不可用)
  if (session.creds === false) {
    return (
      <View style={{ flex: 1, paddingHorizontal: padH, paddingTop: 32 + chrome.top }}>
        <View style={{ maxWidth: 460, width: '100%', alignSelf: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Send size={28} color={p.foreground} />
            <Text style={{ fontSize: 20, fontWeight: '700', color: p.foreground }}>Telegram</Text>
          </View>
          <View style={{ marginTop: 16, borderRadius: 12, backgroundColor: p.surface, padding: 16, gap: 8 }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: p.foreground }}>服务端尚未配置 Telegram 凭据</Text>
            <Text style={{ fontSize: 13, lineHeight: 20, color: p.muted }}>
              请在服务端 server/.env 配置 TELEGRAM_API_ID 与 TELEGRAM_API_HASH(在 my.telegram.org 的「API development tools」申请),重启后端后重试。
            </Text>
          </View>
          <View style={{ marginTop: 16 }}>
            <Button variant="secondary" onPress={onCycle}>我已配置,重试</Button>
          </View>
        </View>
      </View>
    );
  }

  // 已登录 → 对话列表;未登录 → 三步登录面板(完成/登出都重拉 session 切形态)
  if (session.authorized) {
    return <DialogsView me={session.me} onLoggedOut={onCycle} />;
  }
  return (
    <View style={{ flex: 1, paddingHorizontal: padH, paddingTop: chrome.top }}>
      <LoginPanel onDone={onCycle} />
    </View>
  );
}
