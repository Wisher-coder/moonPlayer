// ============================================================================
// use-keyboard-inset.js —— 键盘内边距钩子(聊天输入区避让用)
// ----------------------------------------------------------------------------
// 契约(唯一导出):
//   useKeyboardInset() → { height:number, visible:boolean }
//     · iOS:keyboardWillShow/WillHide(动画前即出值,输入条跟手不跳动);
//     · Android:keyboardDidShow/DidHide(系统 resize 窗口后才派发,Will 系
//       事件不存在——订阅了也永不触发);
//     · web:恒 {height:0, visible:false},不订阅任何事件(键盘概念不存在);
//     · height 取事件 endCoordinates.height(像素),隐藏归 0。
// 事件订阅在挂载 effect 内做,卸载即摘除;订阅前按 Platform.OS 分流,web 分支
// 直接跳过——全程不触碰 DOM/RN 全局对象,SSG 静态导出评估安全(口径同
// lib/use-dimensions.js 的平台守卫)。
// ============================================================================
import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

export function useKeyboardInset() {
  const [height, setHeight] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // web 无键盘概念:恒 0/不可见,不订阅(防静态导出评估触任何平台 API)
    if (Platform.OS === 'web') return undefined;
    // iOS:Will 系(动画前即出值);Android:Did 系(Will 系不存在,订阅也永不触发)
    const showName = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideName = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = (e) => {
      const h = e && e.endCoordinates && Number(e.endCoordinates.height);
      setHeight(Number.isFinite(h) && h > 0 ? h : 0);
      setVisible(true);
    };
    const onHide = () => {
      setHeight(0);
      setVisible(false);
    };
    // RN 0.86:addListener 返回订阅对象(带 remove),卸载统一摘除
    const subs = [
      Keyboard.addListener(showName, onShow),
      Keyboard.addListener(hideName, onHide),
    ];
    return () => {
      for (const s of subs) {
        if (s && typeof s.remove === 'function') s.remove();
      }
    };
  }, []);

  return { height, visible };
}

export default useKeyboardInset;
