// ============================================================================
// FavButton.jsx —— 收藏星标钮（观看页元信息动作区）
// ----------------------------------------------------------------------------
// Star（线性=未收藏）/ StarSolid（实心=已收藏）随 fav-store 的 useIsFav(site,id)
// 切换（store 内部经 splitEpId 把 vid-epN 归一为裸 vid——一部剧全集合共用同一
// 颗星，选集切集不换星）；点按走 toggleFav：本地乐观翻转零延迟，失败 store
// 整组回滚（星标自动退回），此处只负责呈现结果。
// 轻反馈：仓库无全局 toast 基建（约定不引入），页面内自绘——点按后按钮旁
// 短暂浮出「已收藏/已取消收藏」，失败浮出服务端 message 原文（如「收藏已满
// (5000)」「收藏服务暂不可用」），1.6s 自动消失；气泡绝对定位不占布局（不推
// 挤标题/频道行）。
// 契约 props：{ site, item, iconSize? }；item = { id, title?, cover?, duration?,
// hd? }（与 toggleFav 入参同构，元信息随收藏快照落服务端，收藏页/「我的」页
// 横滑直接可展示）。
// ============================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Star, StarSolid } from '../icons.js';
import Button from '../ui/Button.jsx';
import { usePalette } from '../ui/palette.js';
import { useIsFav, toggleFav } from '../../lib/fav-store.js';

// 轻反馈自动消失时长（ms）
const FLASH_MS = 1600;

function FavButton({ site, item, iconSize = 20 }) {
  const p = usePalette();
  // site/id 为空时 useIsFav 恒 false（钩子内部守卫），此处照常渲染线性星
  const isFav = useIsFav(site, item && item.id);
  const [flash, setFlash] = useState('');
  const timer = useRef(null);

  // 卸载清计时器（防卸载后 setState）
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const showFlash = useCallback((msg) => {
    setFlash(msg);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlash(''), FLASH_MS);
  }, []);

  const onToggle = useCallback(() => {
    toggleFav(site, item)
      .then((res) => showFlash(res && res.fav === 1 ? '已收藏' : '已取消收藏'))
      .catch((e) => showFlash((e && e.message) || '收藏操作失败')); // 失败 store 已回滚，星标退回原状
  }, [site, item, showFlash]);

  if (!site || !item || item.id == null) return null; // 脏数据防御：不渲染

  return (
    <View style={{ position: 'relative', flexShrink: 0 }}>
      {/* ghost icon 圆钮：常态只出星标，hover 才出灰面（YouTube 控制行钮常态） */}
      <Button
        variant="ghost"
        size="icon"
        accessibilityLabel={isFav ? '取消收藏' : '收藏'}
        onPress={onToggle}
      >
        {isFav ? <StarSolid size={iconSize} color={p.foreground} /> : <Star size={iconSize} color={p.muted} />}
      </Button>
      {/* 轻反馈气泡：锚在按钮左侧绝对浮出（surface2 底，深浅色都可读） */}
      {flash ? (
        <View
          style={{
            position: 'absolute',
            right: 46,
            top: 9,
            maxWidth: 220,
            borderRadius: 8,
            backgroundColor: p.surface2,
            paddingHorizontal: 10,
            paddingVertical: 6,
          }}
        >
          <Text numberOfLines={1} style={{ fontSize: 13, color: p.foreground }}>{flash}</Text>
        </View>
      ) : null}
    </View>
  );
}

export default FavButton;
