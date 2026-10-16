// ============================================================================
// plugins.js —— 「插件管理」页（站源插件的加载/卸载，纯前端状态）
// ----------------------------------------------------------------------------
// 站源插件模型（父子结构，数据全部来自 SiteContext 的全量清单 sites，不发新请求）：
//   · 主站插件（group=main，月色/艾薇/爱豆/含羞草…9 个）——每个插件只提供一个
//     站点，平铺为独立行，行尾开关即该站加载/卸载；
//   · 资源站插件（group=cms，zy_ 前缀 72+ 站）——CMS 是一个父插件，下挂全部
//     资源站为子行：父行可折叠（默认折叠）、父行开关三态（全开/全关/部分混合，
//     点按 = 非全开 → 一键全部加载，全开 → 全部卸载），子行逐站开关。
// 交互语义（与 mine.js / Guide 片源区同源）：
//   · 开关 → SiteContext.setPluginLoaded / setManyLoaded（AsyncStorage 持久化，
//     Guide 片源区即时只剩已加载站）；「至少保留一个已加载站源」守卫由上下文
//     拒绝并在此 toast；卸载当前在用站由上下文自动切换，这里补 toast 说明；
//   · 行本体点按 = 已加载站切换为当前站（未加载先提示加载——切换入口不止
//     Guide 片源区一处，手机上不必绕回侧栏抽屉）；
//   · 搜索（名称/id 包含匹配）自动展开 CMS 父项并过滤子行。
// 行结构：行本体与开关为两个并列 Pressable（行本体非按钮包按钮，与 SettingRow
// 「行尾自带控件的行根为普通 View」同款约束）；两者之间另有测速位（亦为并列
// Pressable，见 SpeedCell）——无结果=ghost 圆钮 / 测试中=Spinner / 有结果=2×2
// 指标 / 失败=「失败」，点按即（重）测该站。测速为纯前端、纯静默（不导航、
// 不碰舞台播放器、不操作任何页面，编排见 lib/speedtest.js），结果经
// lib/speedtest-store.js 落 AsyncStorage，进页回显上次结果；页头「全部测速」
// 对全部已加载站源串行逐测，与行内单测全局互斥（同一时刻只跑一个）。
// toast 为页内自绘轻量反馈条（RN 侧无全局 toast 设施，mine.js 同款）。返回
// chip 用 router.dismissTo('/mine') 弹回 (tabs) 组：POP_TO 语义，深链冷启时
// 组不在栈内则替换当前屏，任何路径都成立（board 页同款；此前 push 会往根栈
// 再压一份 (tabs) 实例，保活组全体重挂重拉，必须避开——见 lib/tab-nav.js）。
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { ChevronDown, ChevronLeft, ChevronRight, Globe, Layers, SearchX, Send, Speed, Tv } from '../components/icons.js';
import { api } from '../lib/client.js';
import { useSite } from '../lib/site-context.jsx';
import { useForm } from '../lib/use-form.js';
import { usePalette } from '../components/ui/palette.js';
import Button from '../components/ui/Button.jsx';
import Input from '../components/ui/Input.jsx';
import Spinner from '../components/ui/Spinner.jsx';
import EmptyState from '../components/home/EmptyState.jsx';
import ScreenScrollView from '../components/layout/ScreenScrollView.jsx';
import { useChromeInsets } from '../hooks/use-chrome-scroll.js';
import { TogglePill } from '../components/mine/SettingRow.jsx';
import usePressVisual from '../lib/use-press-visual.js';
import { runSiteSpeedTest } from '../lib/speedtest.js';
import { getSpeedResults, saveSpeedResult } from '../lib/speedtest-store.js';

// toast 自动消失时长（ms；mine.js 同款）
const TOAST_MS = 2500;

// telegram 登录状态小标(账号型站源行尾):null=未知(拿不到 session 时整标
// 静默不显,不因此挂页)/ 其余两态文案
function TgStatusBadge({ status }) {
  const p = usePalette();
  if (!status) return null;
  return (
    <View style={{ borderRadius: 999, backgroundColor: p.surface2, paddingHorizontal: 8, paddingVertical: 3, maxWidth: 120 }}>
      <Text numberOfLines={1} style={{ fontSize: 10, lineHeight: 14, color: status.on ? p.foreground : p.muted, includeFontPadding: false }}>
        {status.on ? '已登录' + (status.name ? ' · ' + status.name : '') : '未登录'}
      </Text>
    </View>
  );
}

// ===== 测速数值格式 =====
// 毫秒:整数如 230ms,≥1s 一位小数如 1.2s;速度一位小数如 2.4M/s;失败/无值 —
function fmtSpeedMs(v) {
  if (v == null || !isFinite(v)) return '—';
  return v < 1000 ? Math.round(v) + 'ms' : (v / 1000).toFixed(1) + 's';
}

function fmtSpeedMbps(v) {
  if (v == null || !isFinite(v)) return '—';
  return v.toFixed(1) + 'M/s';
}

// 测速指标单格:标签 + 值纵向紧凑排列(fontSize 10)
function MetricCell({ label, value }) {
  const p = usePalette();
  return (
    <View style={{ width: 46 }}>
      <Text numberOfLines={1} style={{ fontSize: 10, lineHeight: 12, color: p.muted, includeFontPadding: false }}>
        {label}
      </Text>
      <Text numberOfLines={1} style={{ fontSize: 10, lineHeight: 12, color: p.foreground, includeFontPadding: false }}>
        {value}
      </Text>
    </View>
  );
}

// 行内测速位（与行本体、开关并列的兄弟节点，不嵌进 body 的 Pressable——
//   Android 嵌套按钮陷阱）：
//   无结果=ghost 圆钮（Speed 图标）/ 测试中=Spinner / 有结果=紧凑 1 行 3 格
//   指标（接口/图片/速度）/ 失败=「失败」（accent 色）。指标区与失败态整体可点按重测。
function SpeedCell({ result, testing, onPress }) {
  const p = usePalette();
  if (testing) {
    return (
      <View style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}>
        <Spinner size={18} />
      </View>
    );
  }
  if (!result) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="站源测速"
        hitSlop={8}
        onPress={onPress}
        style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }}
      >
        <Speed size={18} color={p.muted} />
      </Pressable>
    );
  }
  if (result.err) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="重新测速"
        hitSlop={8}
        onPress={onPress}
        style={{ justifyContent: 'center' }}
      >
        <Text style={{ fontSize: 12, color: p.accent, includeFontPadding: false }}>失败</Text>
      </Pressable>
    );
  }
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="重新测速" hitSlop={4} onPress={onPress}>
      <View style={{ gap: 2 }}>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <MetricCell label="接口" value={fmtSpeedMs(result.apiMs)} />
          <MetricCell label="图片" value={fmtSpeedMs(result.imgMs)} />
          <MetricCell label="速度" value={fmtSpeedMbps(result.mbps)} />
        </View>
      </View>
    </Pressable>
  );
}

// 插件行：图标 + 名称（当前站标「· 使用中」）+ 次行 desc + 测速位 + 行尾槽 +
// 开关 pill。行本体（切换/展开）与 pill（加载/卸载）、测速位是三个并列的
// Pressable——不嵌套按钮。
function PluginRow({ icon: Icon, label, desc, active, pillOn, pillMixed, onBodyPress, onToggle, indent = 0, trailing, speedSlot }) {
  const p = usePalette();
  const bodyHv = usePressVisual(); // 布局静态化（安卓样式函数陷阱，见 use-press-visual 头注）
  return (
    <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 }}>
      {/* native 陷阱：Pressable 的 style 函数里 flex:1 在 RN 侧不生效（web 正常），
          flex 挂普通 View 包装、样式函数只留视觉态——search/CompactCard 同款修复 */}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={onBodyPress}
          {...bodyHv.binds}
          style={[
            { flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: indent },
            { opacity: bodyHv.pressed ? 0.85 : 1 },
          ]}
        >
          {Icon ? <Icon size={20} color={p.muted} /> : null}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ fontSize: 14, color: p.foreground, lineHeight: desc ? 20 : undefined }}>
              {label}
              {active ? <Text style={{ color: p.accent, fontWeight: '600' }}> · 使用中</Text> : null}
            </Text>
            {desc ? (
              <Text numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, color: p.muted }}>{desc}</Text>
            ) : null}
          </View>
          {trailing}
        </Pressable>
      </View>
      {/* 测速位：行本体与开关之间的兄弟节点（不嵌进 body 的 Pressable） */}
      {speedSlot}
      <Pressable
        accessibilityRole="switch"
        accessibilityLabel={(typeof label === 'string' ? label : '') + (pillMixed ? '（部分已加载）' : '加载开关')}
        accessibilityState={{ checked: pillMixed ? 'mixed' : !!pillOn }}
        hitSlop={8}
        onPress={onToggle}
      >
        <TogglePill on={pillOn} mixed={pillMixed} />
      </Pressable>
    </View>
  );
}

export default function Plugins() {
  const p = usePalette();
  const { form } = useForm(); // phone px-3 / pad·pc px-6（AppShell 主区同款约定）
  const { site, sites, visibleSites, loadedIds, setSite, setPluginLoaded, setManyLoaded } = useSite();
  const [query, setQuery] = useState('');
  const [cmsOpen, setCmsOpen] = useState(false); // CMS 父插件默认折叠

  // ===== Telegram 登录态小标（telegram 行尾;拿不到 session 静默不显）=====
  // null=未知(请求失败/未返回) {on,name}=已登录账号名 / {on:false}=未登录;
  // 路由聚焦时重拉（从 /telegram 登录返回即刷新）
  const [tgStatus, setTgStatus] = useState(null);
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      api('telegram', 'session')
        .then((s) => {
          if (alive) {
            setTgStatus(s && s.authorized
              ? { on: true, name: s.me ? (s.me.name || '') : '' }
              : { on: false });
          }
        })
        .catch(() => { if (alive) setTgStatus(null); }); // 静默:状态标缺席不影响本页
      return () => { alive = false; };
    }, [])
  );

  // ===== 页内轻量 toast（mine.js 同款；自动消失）=====
  const [toastMsg, setToastMsg] = useState('');
  const toastTimer = useRef(null);
  const showToast = useCallback((msg) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), TOAST_MS);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // ===== 站源测速（纯前端静默；编排见 lib/speedtest.js）=====
  const [speedResults, setSpeedResults] = useState({}); // siteId → 上次/最新结果
  const [speedTestingId, setSpeedTestingId] = useState(null); // 当前在测的站（行内 Spinner）
  const [allTesting, setAllTesting] = useState(false); // 「全部测速」进行中（按钮态）
  const speedBusyRef = useRef(false); // 全局互斥：行内单测与全测同一时刻只允许一个
  const speedAbortRef = useRef(null); // 在途测速的中止信号（离页时触发）
  const aliveRef = useRef(true); // 卸载后不再回显（测速链路可能长于页面寿命）

  // 进页回显上次测速结果；离页中止在途测速（串行全测可能跑很久）
  useEffect(() => {
    getSpeedResults()
      .then((m) => { if (aliveRef.current) setSpeedResults(m); })
      .catch(() => {});
    return () => {
      aliveRef.current = false;
      if (speedAbortRef.current) speedAbortRef.current.abort();
    };
  }, []);

  // 测单站并立即回显 + 落 store（永不抛错，失败也产出 err 结果对象）
  const runSpeedTest = useCallback(async (s, ctl) => {
    let r = null;
    try {
      r = await runSiteSpeedTest(s.id, { signal: ctl.signal });
    } catch (e) {
      r = { apiMs: null, imgMs: null, mbps: null, at: Date.now(), err: (e && e.message) || '测速失败' };
    }
    if (aliveRef.current) setSpeedResults((prev) => ({ ...prev, [s.id]: r }));
    saveSpeedResult(s.id, r);
  }, []);

  // 行内单测（与全测互斥）;telegram(caps.tg)账号型站源未登录必挂,不参与测速
  const testOne = (s) => {
    if (s && s.capabilities && s.capabilities.tg) return;
    if (speedBusyRef.current) {
      showToast('测速进行中，请稍候');
      return;
    }
    speedBusyRef.current = true;
    const ctl = new AbortController();
    speedAbortRef.current = ctl;
    setSpeedTestingId(s.id);
    runSpeedTest(s, ctl)
      .catch(() => {})
      .finally(() => {
        speedAbortRef.current = null;
        setSpeedTestingId(null);
        speedBusyRef.current = false;
      });
  };

  // 全部测速：对所有已加载站源（含 CMS 子行 zy_*）串行逐测，每测完一行立即
  // 回显并写 store（与行内单测互斥；离页中止即停）
  const testAll = async () => {
    if (speedBusyRef.current) return;
    const targets = loadedIds
      .map((id) => sites.find((x) => x && x.id === id))
      .filter(Boolean)
      // telegram(caps.tg)是账号型站源:list 依赖登录态,未登录测速必挂——跳过
      .filter((s) => !(s.capabilities && s.capabilities.tg));
    if (!targets.length) {
      showToast('暂无已加载站源');
      return;
    }
    speedBusyRef.current = true;
    setAllTesting(true);
    const ctl = new AbortController();
    speedAbortRef.current = ctl;
    let done = 0;
    for (const s of targets) {
      if (ctl.signal.aborted) break; // 离页中止：不再起新站
      setSpeedTestingId(s.id);
      await runSpeedTest(s, ctl);
      done += 1;
    }
    speedAbortRef.current = null;
    setSpeedTestingId(null);
    setAllTesting(false);
    speedBusyRef.current = false;
    if (!ctl.signal.aborted) showToast('已测完 ' + done + ' 个站源');
  };

  // ===== 目录分组：主站插件（一插件一站）/ CMS 资源站群（一父插件 + 全部 zy_ 子站）=====
  const mainSites = useMemo(() => sites.filter((s) => s && s.group !== 'cms'), [sites]);
  const cmsSites = useMemo(() => sites.filter((s) => s && s.group === 'cms'), [sites]);

  // ===== 搜索过滤（名称/id 不区分大小写包含）；搜索期间自动展开 CMS 父项 =====
  const q = query.trim().toLowerCase();
  const searching = q !== '';
  const match = useCallback((s) => !q
    || (s.name || '').toLowerCase().includes(q)
    || (s.id || '').toLowerCase().includes(q), [q]);
  const mainShown = useMemo(() => mainSites.filter(match), [mainSites, match]);
  const cmsShown = useMemo(() => cmsSites.filter(match), [cmsSites, match]);
  const cmsExpanded = cmsOpen || searching;

  // ===== CMS 父开关三态：全开 / 全关 / 部分混合 =====
  const loadedSet = useMemo(() => new Set(loadedIds), [loadedIds]);
  const cmsLoadedCount = useMemo(
    () => cmsSites.reduce((n, s) => n + (loadedSet.has(s.id) ? 1 : 0), 0),
    [cmsSites, loadedSet]
  );
  const cmsAllOn = cmsSites.length > 0 && cmsLoadedCount === cmsSites.length;
  const cmsMixed = cmsLoadedCount > 0 && !cmsAllOn;

  // 当前站名（概要行显示）
  const currentName = (sites.find((s) => s && s.id === site) || {}).name || site;

  // ===== 行本体点按：已加载站 = 切换为当前站（Guide 片源区同语义）=====
  const pickSite = (s) => {
    // 账号型站源(telegram)不参与切站——未登录会把全站数据源切进 502,
    // 与 Guide 片源区同口径直达专属页
    if (s.capabilities && s.capabilities.tg) {
      router.push('/telegram');
      return;
    }
    if (s.id === site) return;
    if (!loadedSet.has(s.id)) {
      showToast('请先加载 ' + s.name + ' 再切换');
      return;
    }
    setSite(s.id);
    showToast('已切换到 ' + s.name);
  };

  // ===== 单站加载/卸载（卸载当前站由上下文自动切换，这里只负责反馈）=====
  const toggleOne = (s) => {
    const on = loadedSet.has(s.id);
    const r = setPluginLoaded(s.id, !on);
    if (!r.ok) {
      showToast(r.reason);
      return;
    }
    if (!on && r.switchedTo) showToast('已卸载 ' + s.name + '，已切换到 ' + r.switchedTo.name);
    else showToast(on ? '已卸载 ' + s.name : '已加载 ' + s.name);
  };

  // ===== CMS 父开关：非全开 → 一键全部加载；全开 → 全部卸载（守卫在上下文）=====
  const toggleCmsAll = () => {
    const r = setManyLoaded(cmsSites.map((s) => s.id), !cmsAllOn);
    if (!r.ok) {
      showToast(r.reason);
      return;
    }
    if (!cmsAllOn) showToast('已加载全部资源站');
    else if (r.switchedTo) showToast('已卸载全部资源站，已切换到 ' + r.switchedTo.name);
    else showToast('已卸载全部资源站');
  };

  // 内容水平留白：phone px-3 / pad·pc px-6（AppShell 主区同款约定）
  const padH = form === 'phone' ? 12 : 24;
  // 壳层避让：手机画幅悬浮顶/底栏下滚动内容自垫（ScreenScrollView 内部处理；
  // toast 是 absolute 定位需自行避让底栏）
  const chrome = useChromeInsets();

  return (
    <View className="flex-1 bg-background">
      <ScreenScrollView
        className="flex-1"
        topGap={16}
        bottomGap={48}
        contentContainerStyle={{ paddingHorizontal: padH, gap: 32 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* 页头：返回 chip + 标题（board 页同款形态；本页无独立页头组件） */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Button variant="ghost" onPress={() => router.dismissTo('/mine')}>
            <ChevronLeft size={16} color={p.foreground} />
            <Text style={{ color: p.foreground, fontSize: 14, fontWeight: '500', includeFontPadding: false }}>
              我的
            </Text>
          </Button>
          <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 20, fontWeight: '700', color: p.foreground }}>
            插件管理
          </Text>
          {/* 全部测速：已加载站源串行逐测；运行中禁用 */}
          <Button variant="ghost" size="sm" disabled={allTesting} onPress={testAll}>
            <Speed size={14} color={p.muted} />
            <Text style={{ fontSize: 12, fontWeight: '500', color: p.foreground, includeFontPadding: false }}>
              {allTesting ? '测速中…' : '全部测速'}
            </Text>
          </Button>
        </View>

        {/* 概要 + 搜索：全量目录内按名称/id 过滤（72+ 资源站必需） */}
        <View style={{ gap: 12 }}>
          <Text style={{ fontSize: 14, color: p.muted }}>
            已加载 {visibleSites.length} / {sites.length} 个站源 · 当前：{currentName}
          </Text>
          <Input
            value={query}
            onChangeText={setQuery}
            placeholder="搜索站源名称或 id"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        {searching && !mainShown.length && !cmsShown.length ? (
          // 搜索无匹配：全页单空态（两节都空才显示）
          <EmptyState icon={SearchX} title="没有匹配的站源" desc="换个名称或 id 试试" />
        ) : (
          <>
            {/* 主站插件：一插件一站，平铺独立行 */}
            {mainShown.length ? (
              <View>
                <Text style={{ marginBottom: 12, fontSize: 16, fontWeight: '500', color: p.foreground }}>主站插件</Text>
                <View>
                  {mainShown.map((s) => {
                    // telegram(caps.tg)是账号型站源:行尾挂登录状态小标;
                    // 未登录时 list 必 502,测速入口(行内测速位)对其跳过
                    const isTg = !!(s.capabilities && s.capabilities.tg);
                    return (
                      <PluginRow
                        key={s.id}
                        icon={isTg ? Send : Globe}
                        label={s.name}
                        desc={s.id}
                        active={s.id === site}
                        pillOn={loadedSet.has(s.id)}
                        onBodyPress={() => pickSite(s)}
                        onToggle={() => toggleOne(s)}
                        trailing={isTg ? <TgStatusBadge status={tgStatus} /> : undefined}
                        speedSlot={isTg ? null : (
                          <SpeedCell
                            result={speedResults[s.id]}
                            testing={speedTestingId === s.id}
                            onPress={() => testOne(s)}
                          />
                        )}
                      />
                    );
                  })}
                </View>
              </View>
            ) : null}

            {/* 资源站插件（CMS 父插件）：父行折叠/展开 + 三态开关批量启停 */}
            <View>
              <Text style={{ marginBottom: 12, fontSize: 16, fontWeight: '500', color: p.foreground }}>资源站插件</Text>
              <View>
                <PluginRow
                  icon={Layers}
                  label="CMS 资源站"
                  desc={'共 ' + cmsSites.length + ' 个站源 · 已加载 ' + cmsLoadedCount}
                  pillOn={cmsAllOn}
                  pillMixed={cmsMixed}
                  onBodyPress={() => setCmsOpen((v) => !v)}
                  onToggle={toggleCmsAll}
                  trailing={cmsExpanded
                    ? <ChevronDown size={16} color={p.muted} />
                    : <ChevronRight size={16} color={p.muted} />}
                />
                {cmsExpanded ? (
                  cmsShown.length ? (
                    cmsShown.map((s) => (
                      <PluginRow
                        key={s.id}
                        icon={Tv}
                        label={s.name}
                        desc={s.id}
                        indent={28}
                        active={s.id === site}
                        pillOn={loadedSet.has(s.id)}
                        onBodyPress={() => pickSite(s)}
                        onToggle={() => toggleOne(s)}
                        speedSlot={(
                          <SpeedCell
                            result={speedResults[s.id]}
                            testing={speedTestingId === s.id}
                            onPress={() => testOne(s)}
                          />
                        )}
                      />
                    ))
                  ) : (
                    <Text style={{ paddingVertical: 20, textAlign: 'center', fontSize: 12, color: p.muted }}>
                      没有匹配的资源站
                    </Text>
                  )
                ) : null}
              </View>
            </View>
          </>
        )}
      </ScreenScrollView>

      {/* 页内轻量反馈条（toast）：底部居中，自动消失（mine.js 同款）；手机端
          需避让悬浮底栏（chrome.bottom） */}
      {toastMsg ? (
        <View style={{ position: 'absolute', bottom: 24 + chrome.bottom, left: 0, right: 0, alignItems: 'center', pointerEvents: 'none' }}>
          <View style={{ borderRadius: 8, backgroundColor: p.surface2, paddingHorizontal: 16, paddingVertical: 10, maxWidth: '86%' }}>
            <Text numberOfLines={2} style={{ fontSize: 14, color: p.foreground }}>{toastMsg}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}
