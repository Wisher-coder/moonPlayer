// ============================================================================
// DescriptionBox.jsx —— 描述盒（YouTube 式，观看页信息区）
// ----------------------------------------------------------------------------
// 移植自 NextWeb/app/video/[site]/[id]/DescriptionBox.jsx（1:1 同口径）：
//   - 首行 meta（时长 · HD · 分辨率 · 日期，font-medium）+ 标签/分类 chips
//     收进盒内；chips 默认随盒折叠两行，「...更多」仅在实际超两行（隐形
//     测量层实测溢出）时出现、展开为完整内容、文案变「收起」
//     （折叠两行在 RN 侧用外层 Text numberOfLines=2 承接，
//     chips 为内嵌 Text 行内排列，与 line-clamp-2 同语义）；
//   - chips 统一 YouTube 标签态：交互蓝 + 点按跳转；
//   - href 能力判定沿用 NextWeb 逻辑：站点有 bytag 能力 → /category?tag=id，
//     否则标签退到 /search?kw=名称；分类恒链 /category?cat=id
//     （expo-router 以 pathname+params 承接，深链路径与 NextWeb 一致）；
//   - 底色 surface-2（浅 #f2f2f2 / 深 #272727），与 YouTube 描述面板取色一致。
// 契约 props：{ metaParts, tags, cats, siteCaps, style? }——metaParts 为已拼好的
// meta 片段数组；tags/cats 为 {id?,name} 形态；siteCaps 为路由站点能力元数据。
// 展开态不持久化：父页以 key={site|id} 挂载本组件，换视频即重置（NextWeb 同款）。
// ============================================================================
import { memo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { usePalette } from '../ui/palette.js';

function DescriptionBox({ metaParts = [], tags = [], cats = [], siteCaps = {}, style }) {
  const p = usePalette();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const hasChips = tags.length > 0 || cats.length > 0; // 无 chips 不渲染 chips 区
  // 溢出实测（「...更多」显隐依据）：只要有 chips 就显按钮会在单行 chips
  //（如仅一个分类）时误报「有更多」——折叠时挂一个不裁切的隐形测量层（同
  // 字号/行高/满宽），高度超过两行才算真的折叠了；展开态按钮恒显（「收起」）。
  // 行数判定用 onLayout 高度而非 onTextLayout：react-native-web 无该事件实现
  const [overflow, setOverflow] = useState(false);
  const showToggle = hasChips && (open || overflow);

  // chip 跳转：bytag 能力 → 分类页 tag 过滤；否则退到搜索页关键词检索。
  // 观看页在 (tabs) 组之上的根栈层，跳 tab 级路由用 dismissTo（POP_TO 弹回
  // 组内再切 tab；navigate/push 会把整个 (tabs) 组当新屏再压一份）
  const goTag = (t) => {
    if (t.id != null && siteCaps.bytag) {
      router.dismissTo({ pathname: '/category', params: { tag: String(t.id) } });
    } else {
      router.dismissTo({ pathname: '/search', params: { kw: t.name } });
    }
  };
  // 分类 chip：恒链分类页 cat 过滤
  const goCat = (c) => {
    router.dismissTo({ pathname: '/category', params: { cat: String(c.id) } });
  };
  // chips 行内片段（可见层带点按；测量层复用同一内容但不带，避免隐形层误触）
  const chipSpans = (interactive) => [
    ...tags.map((t, i) => (
      <Text
        key={'tag_' + i}
        onPress={interactive ? () => goTag(t) : undefined}
        style={{ color: p.link, marginRight: 6 }}
      >
        {'#' + t.name}
      </Text>
    )),
    ...cats.map((c, i) => (
      <Text
        key={'cat_' + i}
        onPress={interactive ? () => goCat(c) : undefined}
        style={{ color: p.link, marginRight: 6 }}
      >
        {c.name}
      </Text>
    )),
  ];

  return (
    // 底色 surface-2：浅色 #f2f2f2 / 深色 #272727（rounded-xl + p-3 + text-sm）
    <View style={[{ borderRadius: 12, backgroundColor: p.surface2, padding: 12 }, style]}>
      {/* 首行 meta（时长 · HD · 分辨率 · 日期，YouTube 同款加粗首行） */}
      {metaParts.length > 0 ? (
        <Text style={{ fontSize: 14, fontWeight: '500', lineHeight: 20, color: p.foreground }}>
          {metaParts.join(' · ')}
        </Text>
      ) : null}

      {/* chips 区：折叠时按行裁切（两行），展开为全部；chips 为行内 Text，
          交互蓝色、其余基色 muted（NextWeb 同款 chipCls 语义） */}
      {hasChips ? (
        <>
          <Text
            numberOfLines={open ? undefined : 2}
            style={{
              marginTop: metaParts.length > 0 ? 8 : 0,
              lineHeight: 24,
              color: p.muted,
              fontSize: 14,
            }}
          >
            {chipSpans(true)}
          </Text>
          {/* 隐形测量层：不裁切、absolute 满宽不占布局、pointerEvents none
              （叠在正文上不挡点按）、对读屏隐藏；高度超两行即置 overflow。
              包一层 View 承接 onLayout/pointerEvents（两端对 Text 的
              style.pointerEvents 支持不一致，View 上是稳的） */}
          {!open ? (
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              onLayout={(e) => {
                const h = e.nativeEvent.layout.height;
                setOverflow(h > 24 * 2 + 1);
              }}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 0,
                opacity: 0,
                pointerEvents: 'none',
              }}
            >
              <Text
                style={{
                  marginTop: metaParts.length > 0 ? 8 : 0,
                  lineHeight: 24,
                  color: p.muted,
                  fontSize: 14,
                }}
              >
                {chipSpans(false)}
              </Text>
            </View>
          ) : null}
        </>
      ) : null}

      {/* 展开/收起：YouTube 放在描述内容末尾（折叠截断处），不放右上角 */}
      {showToggle ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={open ? '收起描述' : '展开描述'}
          onPress={() => setOpen((o) => !o)}
          hitSlop={4}
          style={{ marginTop: 4, alignSelf: 'flex-start' }}
        >
          {({ hovered }) => (
            <Text
              style={{
                fontSize: 12,
                fontWeight: '500',
                color: hovered ? p.foreground : p.muted,
              }}
            >
              {open ? '收起' : '...更多'}
            </Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

export default memo(DescriptionBox);
