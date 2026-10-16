// ============================================================================
// SurfaceCard.jsx —— 播放器表面占位卡(解析中 / 解析失败)
// ----------------------------------------------------------------------------
// Provider 解析 resolvePlay 期间与失败时,dock(web 常驻宿主内)/PlayerDock(native)/
// MiniPlayer 共用的表面状态卡:
//   - loading:居中 spinner + 文案(默认「解析播放地址中…」);
//   - errMsg:如实显示错误信息 + 「重试」胶囊钮(交 Provider 重新解析);
//   - small:迷你浮层里的紧凑档(小图标小 spinner)。
// 播放器 chrome 恒深色(不随主题翻转),与 PlayerControls 同口径。
// ============================================================================
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Restart, Alert } from '../icons.js';
import GlassSurface from '../ui/GlassSurface.jsx';
import { DIMMING } from '../../lib/higlass.js';
import { ABS_FILL } from '../../lib/abs-fill.js';

const RED = '#ff0000'; // 错误三角的语义红（播放器整体去红口径下唯一保留：红只表达「出错」）

export function SurfaceCard({ loading = false, label = '', errMsg = '', onRetry = null, small = false }) {
  return (
    <View style={[styles.root, small && styles.rootSmall]}>
      {loading ? (
        <ActivityIndicator size={small ? 'small' : 'large'} color="#fff" />
      ) : (
        <Alert size={small ? 20 : 32} color={RED} />
      )}
      {errMsg ? (
        <Text style={[styles.msg, small && styles.msgSmall]} numberOfLines={small ? 2 : 3}>
          {errMsg}
        </Text>
      ) : label ? (
        <Text style={[styles.msg, small && styles.msgSmall]}>{label}</Text>
      ) : null}
      {!loading && errMsg && onRetry ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="重试"
          onPress={onRetry}
        >
          {/* iOS 26 玻璃端重试胶囊换 clear 玻璃 + HIG 35% 暗化层；降级端 #272727 原样 */}
          <GlassSurface
            glassStyle="clear"
            dark
            dimming={DIMMING}
            interactive
            style={styles.retry}
            fallbackStyle={{ backgroundColor: '#272727' }}
          >
            <Restart size={small ? 14 : 16} color="#fff" />
            <Text style={styles.retryText}>重试</Text>
          </GlassSurface>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...ABS_FILL,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 16,
  },
  rootSmall: {
    backgroundColor: 'rgba(0,0,0,0.9)',
  },
  msg: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
    textAlign: 'center',
  },
  msgSmall: {
    fontSize: 11,
  },
  retry: {
    height: 40, // 按钮胶囊规格:40 高圆角 20（底色走 GlassSurface 两端分持）
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
  },
  retryText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
});

export default SurfaceCard;
