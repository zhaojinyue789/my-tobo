import { setupModal } from "./modal";

export interface ShortcutRefs {
  newTodoInput: HTMLInputElement;
  searchInput: HTMLInputElement;
  helpModal: HTMLElement;
  helpCloseBtn: HTMLButtonElement;
  /** 页面上的「快捷键」入口按钮（可选）：点击打开帮助弹窗 */
  helpToggleBtn?: HTMLButtonElement;
}

/**
 * 全局键盘快捷键：N 聚焦新建、/ 聚焦搜索、? 打开帮助弹窗。
 * 输入类控件聚焦时不拦截（避免干扰打字）；组合键（Ctrl/Cmd/Alt）不处理，各归各的处理器。
 */
export function setupShortcuts(refs: ShortcutRefs): { openHelp(): void } {
  const handle = setupModal(refs.helpModal);
  refs.helpCloseBtn.addEventListener("click", handle.close);
  refs.helpToggleBtn?.addEventListener("click", () => handle.open(refs.helpCloseBtn));

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target.isContentEditable;
    if (typing) return;
    if (e.key === "n" || e.key === "N") {
      e.preventDefault();
      refs.newTodoInput.focus();
    } else if (e.key === "/") {
      e.preventDefault();
      refs.searchInput.focus();
      refs.searchInput.select();
    } else if (e.key === "?") {
      e.preventDefault();
      handle.open(refs.helpCloseBtn);
    }
  });

  return { openHelp: () => handle.open(refs.helpCloseBtn) };
}
