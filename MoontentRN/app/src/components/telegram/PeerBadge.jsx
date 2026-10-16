// ============================================================================
// PeerBadge.jsx —— Telegram 对话元数据展示件(头像 + kind 徽标)
// ----------------------------------------------------------------------------
// telegram.js(对话列表页)与 chat/[id].js(聊天页头部)原先各持一份同款
// TgAvatar / KindBadge / KIND_LABEL 拷贝,已收拢到这里并完成两页迁移(本地
// 拷贝删除,统一经组件族桶导出取用)。纯展示组件:不取数、不感知路由。
// TgAvatar 升级（蓝图一 §5.2/§5.3，example ChatAvatar 设计基线）：
//   · 占位底色 = avatarColor(seed)（chat-helpers 哈希 8 色板，h*31 散列，
//     同一 peer 恒定同色，亮暗通用）；白字双首字母 initialsOf（首词+末词，
//     字号 size*0.38）；
//   · uri（兼容旧 prop）/ url 二选一：有值出图（经 /api/img 代理的绝对
//     地址），加载就绪渐显替换占位；onError 退哈希占位；
//   · muted：静音会话灰调（列表行消费，整体降不透明度）；不传无副作用。
// ============================================================================
import { memo, useState } from 'react';
import { Text, View } from 'react-native';
import { Image } from 'expo-image';
import { usePalette } from '../ui/palette.js';
import { ABS_FILL } from '../../lib/abs-fill.js';
import { avatarColor, initialsOf } from './chat-helpers/index.js';

// kind → 徽标文案(group/channel/saved/user;未知 kind 不出徽标)
export const KIND_LABEL = { group: '群组', channel: '频道', saved: '收藏', user: '私聊' };

// —— 头像:哈希底 + 双首字母占位;url/uri 有值出图(就绪后渐显盖在占位上,
//    onError 退纯占位) ——
function TgAvatar({ uri, url, name, seed, size = 40, muted }) {
  const [bad, setBad] = useState(false);
  const src = uri || url;
  const st = { width: size, height: size, borderRadius: size / 2 };
  const hash = avatarColor(seed != null ? seed : name);
  return (
    <View
      style={[
        st,
        {
          backgroundColor: hash,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          opacity: muted ? 0.55 : 1,
        },
      ]}
    >
      <Text style={{ fontSize: size * 0.38, fontWeight: '600', color: '#ffffff', includeFontPadding: false }}>
        {initialsOf(name)}
      </Text>
      {src && !bad ? (
        <Image
          source={{ uri: src }}
          style={ABS_FILL}
          contentFit="cover"
          transition={200}
          recyclingKey={String(src)}
          onError={() => setBad(true)}
          accessibilityLabel={(name || '') + ' 的头像'}
        />
      ) : null}
    </View>
  );
}

// —— kind 徽标:小圆角 chip(surface2 底 + muted 字);未知 kind 不出 ——
function KindBadge({ kind }) {
  const p = usePalette();
  const label = KIND_LABEL[kind];
  if (!label) return null;
  return (
    <View style={{ borderRadius: 4, backgroundColor: p.surface2, paddingHorizontal: 5, paddingVertical: 1 }}>
      <Text style={{ fontSize: 10, lineHeight: 14, color: p.muted, includeFontPadding: false }}>{label}</Text>
    </View>
  );
}

export default memo(TgAvatar);
export { KindBadge };
