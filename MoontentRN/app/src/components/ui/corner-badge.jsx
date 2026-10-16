// ============================================================================
// 右下角标本体（ui 内部共享件，不属于跨模块契约的八原语）
// ----------------------------------------------------------------------------
// 全站一个规格的缩略图右下黑底角标本体：视频时长（前置 12px 时钟图标）、
// 专区「N 部」、相册「N 张」共用——即 NextWeb 各卡片里的 badge-shape 形态。
// 规格 = YouTube badge-shape 实测值：
//   12px/500、行高 18、内边距 1px 4px、圆角 4px、底色 rgba(0,0,0,.6)（成品高 20px）；
//   时长角标前置 12px 时钟图标（12×12、图标与文字间距 4px）；
// 本组件只渲染胶囊本体，锚定位置（距右下 8px/4px、与 HD 并排等）由调用方
// 经外层 absolute 容器组合——网格卡 8px、行卡与专区/相册卡 4px（NextWeb 实测
// bottom-2 right-2 / bottom-1 right-1 两档）。
// 注意与 ui/Badge（中性小胶囊徽标）是两回事：那是内容区徽章，这是缩略图角标。
import { memo } from 'react';
import { Text, View } from 'react-native';
import { BADGE_BG } from './palette.js';
import { FSM_META } from '../../lib/text-fit.js';

function CornerBadge({ text, icon: Icon }) {
  return (
    <View
      style={{ pointerEvents: 'none',
      
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4, // 图标与文字间距 4px（YouTube 图标槽实测）
        backgroundColor: BADGE_BG,
        borderRadius: 4,
        paddingHorizontal: 4,
        paddingVertical: 1,
        minHeight: 20, // 成品高 20px（12px 字 + 行高 18 + 上下 1px 内边距）
        overflow: 'hidden',
      }}
    >
      {Icon ? <Icon size={12} color="#ffffff" /> : null}
      <Text
        numberOfLines={1}
        maxFontSizeMultiplier={FSM_META}
        style={{
          color: '#ffffff',
          fontSize: 12,
          fontWeight: '500',
          lineHeight: 18,
          fontVariant: ['tabular-nums'], // 时长/计数等宽数字，跳动不移位
          // 安卓默认字体内边距会把 20px 高的胶囊顶歪/顶高，关掉对齐 web 度量
          includeFontPadding: false,
        }}
      >
        {text}
      </Text>
    </View>
  );
}

// memo：纯展示件（黑底白字，与主题无关），网格父级重渲染时按 props 浅比较跳过
export default memo(CornerBadge);
