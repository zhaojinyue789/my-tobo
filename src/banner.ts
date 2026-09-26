import { isOverdue } from "./todo";
import { app } from "./state";

/**
 * 页内过期提醒横幅：纯浏览器/PWA 端没有系统通知（notify 静默降级），这里是兜底提醒路径；
 * 桌面端系统通知与它并存（进应用也能一眼看到）。
 * 显示规则：过期未完成数比上次关闭时多（有新到期）就亮起；完成/恢复导致减少则不再打扰。
 */
let dismissedAtCount = 0;

export interface DueBannerRefs {
  root: HTMLElement;
  text: HTMLElement;
  viewBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
}

/** 每轮渲染调用：同步横幅显隐与文案 */
export function syncDueBanner(refs: DueBannerRefs, onJump: () => void): void {
  const { root, text, viewBtn, closeBtn } = refs;
  const count = app.todos.filter((t) => isOverdue(t)).length;
  const show = count > dismissedAtCount;
  root.classList.toggle("hidden", !show);
  if (show) {
    text.textContent =
      count === 1 ? "有 1 项待办已到期" : `有 ${count} 项待办已到期或过期`;
    viewBtn.onclick = () => onJump();
    closeBtn.onclick = () => {
      dismissedAtCount = count;
      root.classList.add("hidden");
    };
  }
}

/** 测试辅助：重置会话内关闭状态 */
export function resetDueBanner(): void {
  dismissedAtCount = 0;
}
