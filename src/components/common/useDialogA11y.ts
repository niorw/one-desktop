import { useEffect, useRef } from "react";

/**
 * Dialog accessibility helper (WCAG AA).
 *
 * - Moves focus into the dialog on open and restores it to the previously
 *   focused element on close.
 * - Closes the dialog when Escape is pressed (only the topmost of nested
 *   dialogs/drawers responds, so an inner drawer doesn't also close its parent).
 * - Traps Tab / Shift+Tab so focus cannot leave the dialog.
 *
 * Wire the returned ref to the dialog container and mark it with
 * `role="dialog" aria-modal="true"`.
 *
 * Pass `open` (the dialog's mounted/visible state). The effect only depends on
 * `open`, so an unstable `onClose` callback will not thrash focus.
 */

// 嵌套模态栈：数组尾 = 最晚打开（最上层）。仅栈顶对话框响应 Escape，
// 避免产物预览抽屉里的轨迹下钻抽屉被 Escape 一并关掉（P1 溯源场景）。
const modalStack: Array<() => void> = [];

export function useDialogA11y<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // 入栈为本层对话框的关闭句柄（读取最新 onClose）。
    const closeSelf = () => onCloseRef.current();
    modalStack.push(closeSelf);

    const getFocusable = () =>
      node
        ? Array.from(
            node.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((el) => el.offsetParent !== null)
        : [];

    // Focus the first focusable element, falling back to the dialog itself.
    const focusables = getFocusable();
    (focusables[0] ?? node)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // 仅栈顶（最晚打开）对话框响应 Escape；内层抽屉关掉后，外层会自动成为新栈顶。
        if (modalStack[modalStack.length - 1] !== closeSelf) return;
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !node) return;

      const items = getFocusable();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const idx = modalStack.indexOf(closeSelf);
      if (idx >= 0) modalStack.splice(idx, 1);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  return ref;
}
