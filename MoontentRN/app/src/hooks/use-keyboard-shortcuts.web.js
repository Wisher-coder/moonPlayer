// ============================================================================
// use-keyboard-shortcuts.web.js —— Telegram 快捷键·web/桌面实现
// ----------------------------------------------------------------------------
// 键位表 v1（蓝图二 §5.6,对照 Telegram-iOS ChatControllerKeyShortcuts 取子集）：
//   Esc          关闭最上层浮层（onEscape;浮层栈由页面聚合各 Modal 的 visible——
//                菜单→转发→日历→搜索→多选退出→清回复;handler 返回 truthy 才
//                preventDefault,无浮层可关时不吞事件）
//   ⌘/Ctrl+F     聚焦会话内搜索（onFocusSearch;preventDefault 压掉浏览器查找）
//   Enter        发送（onSend;仅当焦点在输入控件时;Shift+Enter=换行放行——
//                TI sendWithCmdEnter 缺省语义;⌘/Ctrl+Enter 同发送,桌面惯例,
//                文本域内该组合无默认行为,拦截无害）
//   裁剪项（TI 出处与理由,蓝图二 §5.6 同款）：
//     · ⌘B/I/U/⇧⌘M/⌘U/⇧⌘X/⇧⌘P/⌘K/⇧⌘N 格式化组——发送管线 parseMode:false,
//       无实体写入面（chat.js:861 注释）；
//     · ⌥⌘↑/↓ 移动回复目标、↑ 空输入编辑上一条、⌃⌘I 信息、⌘/ 媒体面板、
//       ⌘W 关窗口——v1 无对应界面/动作；
//     · 复制：无自定义键位——⌘C 走系统原生文本选择,消息复制走长按菜单
//       （MessageBubble 内建菜单,与 TI「同一动作双入口」中保留的菜单入口一致）。
// 实现要点：
//   · window keydown 挂载于 useEffect（蓝图二 §5.6 契约）;handlers 经 latest-ref
//     镜像,订阅只挂一次,回调闭包不陈旧;
//   · 焦点门闩：栈导航下多层聊天页同挂载（push 视频库页后本屏仍活着）,keydown
//     挂 window 会双派发——失焦页一律不响应（useFocusEffect 维护门闩 ref,
//     与 use-infinite-list 的焦点门闩同款手法）;
//   · IME 安全：中文输入法选词回车（isComposing / keyCode 229）不触发发送,
//     防「打字选词误发消息」;
//   · Enter 只拦截焦点在 input/textarea/contentEditable 的按键——按钮/可点行
//     的原生 Enter 激活不受影响（a11y 不回退）。
// 平台拆分：本文件仅 web 生效（Metro 平台后缀,模块加载期冻结）;原生端为
// use-keyboard-shortcuts.js 空实现,签名一致,装配层无平台分支。
// ============================================================================
import { useCallback, useEffect, useRef } from 'react';
import { useFocusEffect } from 'expo-router';

// 焦点是否在文本输入控件（Enter 拦截的前置条件;按钮等可聚焦元素不拦）
function isEditableTarget(t) {
  if (!t || typeof t !== 'object') return false;
  const tag = typeof t.tagName === 'string' ? t.tagName.toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea') return true;
  return !!t.isContentEditable;
}

export function useTelegramShortcuts(handlers) {
  // handlers 镜像:在 effect 提交后同步（键盘事件只发生在提交后的用户交互,
  // 无渲染期读 ref 的必要——比渲染期写 ref 的 latest-ref 惯用法更干净）
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers || {};
  });
  const focusedRef = useRef(true); // 焦点门闩（见文件头;初值 true 同 use-infinite-list 口径）
  const detachRef = useRef(null);  // 当前订阅的注销函数（返回给调用方的通道）

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      return () => {
        focusedRef.current = false;
      };
    }, [])
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.addEventListener) return undefined;
    const onKey = (e) => {
      if (!focusedRef.current) return; // 失焦页不响应（防栈内双派发）
      const h = handlersRef.current || {};
      const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';

      if (key === 'escape') {
        const handled = h.onEscape ? h.onEscape(e) : false;
        if (handled) e.preventDefault(); // 仅在确实关掉了东西时吞事件
        return;
      }
      // ⌘/Ctrl+F：压掉浏览器查找,聚焦页内搜索（无 handler 不抢浏览器行为）
      if ((e.metaKey || e.ctrlKey) && !e.altKey && key === 'f') {
        if (h.onFocusSearch) {
          e.preventDefault();
          h.onFocusSearch();
        }
        return;
      }
      // Enter 发送：仅输入控件内、非换行组合;IME 选词回车放行（见文件头）
      if (key === 'enter' && !e.shiftKey && !e.altKey && isEditableTarget(e.target)) {
        if (e.isComposing || e.keyCode === 229) return;
        if (h.onSend) {
          e.preventDefault(); // 压掉文本域内插入换行的默认行为
          h.onSend();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    const detach = () => window.removeEventListener('keydown', onKey);
    detachRef.current = detach;
    return () => {
      detachRef.current = null;
      detach();
    };
  }, []);

  // 契约返回值:注销函数（幂等;提前注销后 effect 卸载清理再调一次无害）
  return useCallback(() => {
    if (detachRef.current) {
      detachRef.current();
      detachRef.current = null;
    }
  }, []);
}

export default useTelegramShortcuts;
