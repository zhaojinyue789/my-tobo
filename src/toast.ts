/** 撤销 Toast 常驻时长：期间点「撤销」回滚，超时自动消失 */
const TOAST_MS = 6000;

let root: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * 破坏性操作后的撤销提示条（单例）：新的 toast 会替换旧的，旧操作失去撤销机会。
 * onUndo 由调用方闭包携带回滚所需快照；role=status 供屏幕阅读器播报。
 */
export function showUndoToast(message: string, onUndo: () => void): void {
  dismiss();
  root = document.createElement("div");
  root.className = "toast";
  root.setAttribute("role", "status");

  const msg = document.createElement("span");
  msg.className = "toast-message";
  msg.textContent = message;

  const undoBtn = document.createElement("button");
  undoBtn.type = "button";
  undoBtn.className = "toast-undo";
  undoBtn.textContent = "撤销";
  undoBtn.addEventListener("click", () => {
    dismiss();
    onUndo();
  });

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "toast-close";
  closeBtn.setAttribute("aria-label", "关闭提示");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", dismiss);

  root.append(msg, undoBtn, closeBtn);
  document.body.append(root);
  timer = setTimeout(dismiss, TOAST_MS);
}

export function dismiss(): void {
  clearTimeout(timer);
  root?.remove();
  root = null;
}
