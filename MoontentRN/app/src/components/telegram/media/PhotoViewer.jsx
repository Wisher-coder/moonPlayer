// ============================================================================
// PhotoViewer.jsx —— 共享媒体面板·简版全屏看图器
// ----------------------------------------------------------------------------
// 媒体 tab 点照片的全屏查看(任务口径:简版):全屏 Modal + 纯黑遮罩 +
// Image contain 展示全档图(fullUrl 优先,缺失回中档 url),点击任意处
// 关闭;web 端 ESC/返回键经 onRequestClose 关闭。多图翻页/缩放/胶片条
// 等完整能力不在此件范围(聊天气泡已有 album/PhotoViewer 全功能版)。
// 契约 props:{ url, onClose }——url 已是归一后的绝对代理地址。
// ============================================================================
import { memo } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { Image } from 'expo-image';
import { ABS_FILL } from '../../../lib/abs-fill.js';

function PhotoViewer({ url, onClose }) {
  if (!url) return null;
  return (
    <Modal transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="关闭图片查看"
        onPress={onClose}
        style={[ABS_FILL, { backgroundColor: 'rgba(0,0,0,0.94)' }]}
      >
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }} pointerEvents="box-none">
          <Image
            source={{ uri: url }}
            style={{ width: '100%', height: '100%' }}
            contentFit="contain"
            transition={150}
            recyclingKey={String(url)}
          />
        </View>
      </Pressable>
    </Modal>
  );
}

export default memo(PhotoViewer);
