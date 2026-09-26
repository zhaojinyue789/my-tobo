/**
 * 对话框通用行为：打开时记录触发元素（关闭后归还焦点）、Tab 焦点陷阱、Esc 关闭、点遮罩关闭。
 * 同步设置与统计面板共用；打开后的内容填充由各调用方负责。
 */
export interface ModalHandle {
  /** open 可指定初始焦点元素；不指定则聚焦弹窗内第一个可聚焦元素（a11y：焦点必须进入对话框） */
  open(focus?: HTMLElement): void;
  close(): void;
}

export function setupModal(modal: HTMLElement): ModalHandle {
  let lastFocused: HTMLElement | null = null;

  const open = (focus?: HTMLElement): void => {
    lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modal.classList.remove("hidden");
    (focus ??
      modal.querySelector<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select, a[href], [tabindex]:not([tabindex='-1'])",
      ))?.focus();
  };

  const close = (): void => {
    modal.classList.add("hidden");
    lastFocused?.focus();
    lastFocused = null;
  };

  // 对话框键盘模型：Tab 循环限制在弹窗内（焦点陷阱），Esc 关闭并归还焦点
  modal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation(); // 不触发全局 Esc（只关筛选菜单）的语义混叠
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = [
      ...modal.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select, a[href], [tabindex]:not([tabindex='-1'])",
      ),
    ].filter((el) => el.offsetParent !== null); // offsetParent 为 null = 不可见
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const outside = !(active instanceof HTMLElement) || !modal.contains(active);
    if (e.shiftKey) {
      if (active === first || outside) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || outside) {
      e.preventDefault();
      first.focus();
    }
  });

  // 点击遮罩关闭
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });

  return { open, close };
}
