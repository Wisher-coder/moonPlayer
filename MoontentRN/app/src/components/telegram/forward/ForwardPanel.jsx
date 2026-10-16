// ============================================================================
// ForwardPanel.jsx —— 转发面板（目标多选 → 选项 → 确认 POST，蓝图二 §5.4）
// ----------------------------------------------------------------------------
// ChatControllerForwardMessages 的呈现面等价：Modal 三步流（宿主页内浮层，
// 非路由屏——蓝图二 §0.3-1）。装配契约（M1，蓝图二 §5.1-C）：
//   <ForwardPanel
//     visible        受控可见（页面 forward 态驱动；建议按需挂载/换 key 重挂，
//                    每次打开即全新面板——目标多选是会话内瞬态,不复用上次选择）
//     onClose        手动关闭（遮罩/返回键/取消钮）
//     fromPeer       源会话 peerKey（POST /forward 的 peer）
//     msgIds         待转发消息 id（content-state forward.ids）
//     abilities      forwardAbilities(ids, msgs) 结果——hideNames/hideCaptions
//                    开关按可用性直接隐藏（TI 的 .disabled 态无数据面,v1 隐藏）
//     initialOptions 恢复态选项（content-state forward 的 hideNames/hideCaptions,
//                    可省）——变更经 onOptionsChange(next) 回写装配层
//     onHint         页内轻提示（成功 toast「已转发给 N 个对话」由页面承接,
//                    面板关闭后仍可见;缺省退面板内自管胶囊）
//     onDone(n)      POST 成功后回调（n=送达目标数）——页面负责清 forward 态
//                    + 关面板（contentState clearForward,蓝图二 §5.4 步骤③）
//   />
// 数据面：目标列表复用 useInfiniteList 拉 GET /dialogs（30/页,toPage 适配,
// 与对话列表页同源）+ M3 抽出的 DialogRow 只读消费（selected 选中态,
// 桶导出——依赖 M3 落地后经 components/telegram/index.js 提供）；「我的收藏」
// saved 行必列（列表页未返回时客户端合成同形行,头像走 §4.1 avatarToken 令牌
// 代理,与 dialogs 响应同构）。
// 行为红线：确认 → POST 一次；失败红字留面板（不自动重试,重试=用户再点）；
// 绝不逐条回源。成功 toast 先发（经 onHint 透传页面）再回调 onDone。
// ============================================================================
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { Check } from '../../icons.js';
import { api, postJson } from '../../../lib/tg-api.js';
import { useInfiniteList, toPage } from '../../../hooks/use-infinite-list.js';
import { buildForwardPayload, sentTargetCount, isPeerKey } from '../../../lib/telegram-forward.js';
import usePressVisual from '../../../lib/use-press-visual.js';
import { usePalette } from '../../ui/palette.js';
import Dialog from '../../ui/Dialog.jsx';
import Button from '../../ui/Button.jsx';
import Spinner from '../../ui/Spinner.jsx';
import { DialogRow, useHint } from '../index.js';

const FORWARD_DLG_SIZE = 30; // 目标列表每页条数（与对话列表页 DLG_SIZE 同档）

// 「我的收藏」合成行（saved 必列）：形状与 GET /dialogs 条目同构；头像令牌
// 格式为蓝图一 §4.1 不变式 avatarToken(peerKey)='https://tg.local/a/<peerKey>'，
// 经 /api/img/telegram 代理（与 use-chat-timeline normalizeDeep 的包装口径一致）
const SAVED_ROW = {
  id: 'saved',
  name: '我的收藏',
  kind: 'saved',
  avatar: '/api/img/telegram?u=' + encodeURIComponent('https://tg.local/a/saved'),
  unreadCount: 0,
  unreadMentionsCount: 0,
  muted: false,
  pinned: false,
  lastMessage: null,
  lastAt: null,
};

// 行装配：saved 已在数据里就用服务端行,否则把合成行钉在最前
function buildTargetRows(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.some((x) => x && x.id === 'saved')) return list;
  return [SAVED_ROW].concat(list);
}

// —— 目标多选列表（仅面板可见时挂载:useInfiniteList 挂载即拉第 1 页,藏在
//    visible=false 之下会白发请求,故由父层条件渲染） ——
function TargetPicker({ selected, onToggle }) {
  const p = usePalette();
  const fetchPage = useCallback(
    (page) => api('telegram', 'dialogs', { page, size: FORWARD_DLG_SIZE }).then(toPage),
    []
  );
  // deps 空表:选择器生命周期与面板一致（按需挂载）,无「换数据源」语义
  const list = useInfiniteList(fetchPage, []);
  const rows = useMemo(() => buildTargetRows(list.items), [list.items]);

  if (list.err && list.items == null) {
    return (
      <View style={{ alignItems: 'center', paddingVertical: 18, gap: 8 }}>
        <Text numberOfLines={2} style={{ fontSize: 12, color: p.accent, textAlign: 'center' }}>
          {'对话列表加载失败:' + list.err}
        </Text>
        <Button variant="secondary" size="sm" onPress={list.reload}>重试</Button>
      </View>
    );
  }
  if (list.items == null) {
    return (
      <View style={{ height: 120, alignItems: 'center', justifyContent: 'center' }}>
        <Spinner size={18} color={p.muted} />
      </View>
    );
  }
  return (
    <FlatList
      data={rows}
      keyExtractor={(x) => (x && x.id != null ? String(x.id) : 'x')}
      renderItem={({ item }) => (
        <DialogRow
          item={item}
          onOpen={(it) => onToggle(it && it.id)}
          selected={!!(item && selected.has(String(item.id)))}
        />
      )}
      onEndReached={list.loadMore}
      onEndReachedThreshold={0.5}
      style={{ maxHeight: 320 }}
      showsVerticalScrollIndicator={false}
      ListEmptyComponent={
        <Text style={{ fontSize: 12, color: p.muted, textAlign: 'center', paddingVertical: 18 }}>
          暂无可选对话
        </Text>
      }
      ListFooterComponent={
        list.loadingMore ? (
          <View style={{ alignItems: 'center', paddingVertical: 8 }}>
            <Spinner size={13} color={p.muted} />
          </View>
        ) : null
      }
    />
  );
}

// —— 转发选项开关行（勾选框视觉走语义 token,选中=交互蓝） ——
function OptionToggle({ label, desc, value, onToggle }) {
  const p = usePalette();
  const hv = usePressVisual();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: !!value }}
      accessibilityLabel={label}
      onPress={onToggle}
      {...hv.binds}
      style={[
        { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, borderRadius: 8 },
        { opacity: hv.pressed ? 0.85 : 1 },
      ]}
    >
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 6,
          borderWidth: 1.5,
          borderColor: value ? p.link : p.line,
          backgroundColor: value ? p.link : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {value ? <Check size={13} color={p.background} /> : null}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: '500', color: p.foreground, includeFontPadding: false }}>
          {label}
        </Text>
        {desc ? (
          <Text numberOfLines={1} style={{ fontSize: 11, color: p.muted, marginTop: 1, includeFontPadding: false }}>
            {desc}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

// ============================================================================
// 面板本体（props 契约见文件头）
// ============================================================================
export default function ForwardPanel({
  visible,
  onClose,
  fromPeer,
  msgIds,
  abilities,
  initialOptions,
  onOptionsChange,
  onHint,
  onDone,
}) {
  const p = usePalette();
  const { show: toast, overlay: hintOverlay } = useHint(onHint);
  const [selected, setSelected] = useState(() => new Set()); // 目标 peerKey 集合
  const [hideNames, setHideNames] = useState(!!(initialOptions && initialOptions.hideNames));
  const [hideCaptions, setHideCaptions] = useState(!!(initialOptions && initialOptions.hideCaptions));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const idList = useMemo(
    () => (Array.isArray(msgIds) ? msgIds.filter((n) => Number(n) > 0) : []),
    [msgIds]
  );
  const ab = abilities && typeof abilities === 'object' ? abilities : {};
  const fromOk = isPeerKey(fromPeer);
  const canConfirm = fromOk && idList.length > 0 && selected.size > 0 && !busy;

  const toggleTarget = useCallback((key) => {
    const k = key == null ? '' : String(key);
    if (!k) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  // 选项变更:本地态 + 可选回写装配层（content-state updateForwardOptions）
  const changeOptions = useCallback(
    (patch) => {
      const next = {
        hideNames: patch.hideNames === undefined ? hideNames : !!patch.hideNames,
        hideCaptions: patch.hideCaptions === undefined ? hideCaptions : !!patch.hideCaptions,
      };
      setHideNames(next.hideNames);
      setHideCaptions(next.hideCaptions);
      if (onOptionsChange) onOptionsChange(next);
    },
    [hideNames, hideCaptions, onOptionsChange]
  );

  // 关闭统一走 busy 门闩:POST 在途不允许中途关面板（关了 onDone 就没人收到,
  // 页面 forward 态会悬着;失败态红字留在面板里再关才安全）
  const requestClose = useCallback(() => {
    if (busy || !onClose) return;
    onClose();
  }, [busy, onClose]);

  // 确认:组装 payload（防御校验失败红字）→ POST 一次 → 成功 toast + onDone;
  // 失败红字留面板,绝不自动重试（防风暴红线,重试=用户再点）
  const confirm = useCallback(async () => {
    if (busy) return;
    let body;
    try {
      body = buildForwardPayload({
        peer: fromPeer,
        toPeerIds: Array.from(selected),
        ids: idList,
        opts: { hideNames, hideCaptions },
      });
    } catch (e) {
      setErr((e && e.message) || '转发参数无效');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const res = await postJson('/api/telegram/forward', body);
      const n = sentTargetCount(res);
      toast('已转发给 ' + n + ' 个对话');
      if (onDone) onDone(n);
    } catch (e) {
      // 多目标逐条转发中途失败时,前面的目标已实际送达(契约无部分成功通道):
      // 红字如实提示,避免用户重试造成对已成功目标的重复转发(2026-10-12 复核)
      setErr((e && e.message) || '转发失败,请重试;注意部分对话可能已转发成功,重试前请先确认');
    } finally {
      setBusy(false);
    }
  }, [busy, fromPeer, selected, idList, hideNames, hideCaptions, toast, onDone]);

  return (
    <>
      <Dialog visible={!!visible} onClose={requestClose} title="转发" maxWidth={480}>
        {!visible ? null : (
          <View style={{ gap: 10 }}>
            <Text style={{ fontSize: 12, color: p.muted, includeFontPadding: false }}>
              {idList.length > 0
                ? '选择要转发到的对话（可多选,共 ' + idList.length + ' 条消息）'
                : '没有可转发的消息'}
            </Text>

            <TargetPicker selected={selected} onToggle={toggleTarget} />

            {/* 选项区:按 abilities 直接隐藏不可用项（蓝图二 §5.4,v1 不做禁用态） */}
            {ab.hideNames || ab.hideCaptions ? (
              <View style={{ borderTopWidth: 1, borderTopColor: p.line, paddingTop: 6, gap: 2 }}>
                {ab.hideNames ? (
                  <OptionToggle
                    label="隐藏发送者名字"
                    desc="转发后不显示原发送者信息"
                    value={hideNames}
                    onToggle={() => changeOptions({ hideNames: !hideNames })}
                  />
                ) : null}
                {ab.hideCaptions ? (
                  <OptionToggle
                    label="摘除媒体说明"
                    desc="不随图片 / 视频转发原说明文字"
                    value={hideCaptions}
                    onToggle={() => changeOptions({ hideCaptions: !hideCaptions })}
                  />
                ) : null}
              </View>
            ) : null}

            {/* 失败红字如实留面板（不自动重试）;红=错误色,仓库播放器外惯例同款 */}
            {err ? (
              <Text numberOfLines={2} style={{ fontSize: 12, lineHeight: 17, color: p.accent }}>
                {err}
              </Text>
            ) : null}

            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 2 }}>
              <Button variant="ghost" size="sm" onPress={requestClose} disabled={busy}>取消</Button>
              <Button size="sm" onPress={confirm} disabled={!canConfirm}>
                {busy ? <Spinner size={13} color={p.background} /> : null}
                <Text style={{ fontSize: 13, fontWeight: '500', color: p.background, includeFontPadding: false }}>
                  {selected.size > 0 ? '发送（' + selected.size + '）' : '发送'}
                </Text>
              </Button>
            </View>
          </View>
        )}
      </Dialog>
      {/* 面板内兜底轻提示（页面未传 onHint 时自管;常规路径经页面 toast 承接） */}
      {hintOverlay}
    </>
  );
}
