/**
 * 移动端滑动操作（滴答/Todoist 式手势）：条目右滑露出绿色完成、左滑露出红色删除。
 * 仅触屏（pointerType=touch）启用，桌面鼠标不受影响。
 * 与拖动排序共存：拖动在长按 300ms 后接管（拖动进行中滑动立即让位），
 * 而横向滑动会让拖动的长按取消（touch 位移 >6px 即视为滚动意图），两者天然互斥。
 */
import { isDragging } from "./drag";

const ENGAGE_PX = 14; // 进入滑动的最小横向位移
const ANGLE_RATIO = 1.4; // |dx| 须达到 |dy| 的倍数（斜向视为滚动，不进入滑动）
const ACTION_PX = 88; // 松手触发动作的距离
const MAX_PX = 132; // 跟手位移上限

export interface SwipeHooks {
  onComplete(id: string): void;
  onDelete(id: string): void;
  /** 滑动是否可用（批量模式 / 回收站 / 行内编辑中不可用） */
  isActive(): boolean;
}

export function attachSwipeActions(listEl: HTMLElement, hooks: SwipeHooks): void {
  let state: {
    li: HTMLElement;
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    dx: number;
    engaged: boolean;
  } | null = null;

  const reset = (li: HTMLElement): void => {
    li.classList.remove("is-swiping", "swipe-complete", "swipe-delete");
    li.style.transform = "";
    li.style.background = "";
  };

  /** 松手后的回弹：底色与位移过渡归零 */
  const settle = (li: HTMLElement): void => {
    li.style.transition = "transform 0.16s ease, background 0.16s ease";
    requestAnimationFrame(() => {
      reset(li);
      setTimeout(() => {
        li.style.transition = "";
      }, 180);
    });
  };

  listEl.addEventListener("pointerdown", (e) => {
    if (state || isDragging()) return;
    if (e.pointerType !== "touch") return;
    const target = e.target as HTMLElement;
    // 交互控件上按下不进入滑动（勾选 / 分类 / 日期）
    if (target.closest("button, select, input, option, a, label")) return;
    const li = target.closest<HTMLElement>(".todo-item");
    if (!li?.dataset.id) return;
    if (!hooks.isActive()) return;
    state = {
      li,
      id: li.dataset.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      dx: 0,
      engaged: false,
    };
  });

  window.addEventListener("pointermove", (e) => {
    if (!state || e.pointerId !== state.pointerId) return;
    if (isDragging()) {
      state = null; // 长按拖动接管：立即让位
      return;
    }
    const dx = e.clientX - state.startX;
    const dy = e.clientY - state.startY;
    if (!state.engaged) {
      if (Math.abs(dx) < ENGAGE_PX || Math.abs(dx) < Math.abs(dy) * ANGLE_RATIO) return;
      state.engaged = true;
      try {
        listEl.setPointerCapture(e.pointerId);
      } catch {
        /* 指针已释放等：move/up 监听在 window 上仍能兜底 */
      }
      state.li.classList.add("is-swiping");
    }
    state.dx = Math.max(-MAX_PX, Math.min(MAX_PX, dx));
    state.li.style.transform = `translateX(${state.dx}px)`;
    state.li.classList.toggle("swipe-complete", state.dx > ACTION_PX * 0.6);
    state.li.classList.toggle("swipe-delete", state.dx < -ACTION_PX * 0.6);
  });

  window.addEventListener(
    "pointerup",
    (e) => {
      if (!state || e.pointerId !== state.pointerId) return;
      const { li, dx, engaged, id } = state;
      state = null;
      if (!engaged) return;
      const acted: "complete" | "delete" | null =
        dx > ACTION_PX ? "complete" : dx < -ACTION_PX ? "delete" : null;
      settle(li);
      if (!acted) return;
      // 吞掉滑动结束的合成 click：防止落到行内文本（误入编辑）或按钮上
      listEl.addEventListener(
        "click",
        (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
        },
        { capture: true, once: true },
      );
      if (acted === "complete") hooks.onComplete(id);
      else hooks.onDelete(id);
    },
  );
  window.addEventListener("pointercancel", (e) => {
    if (!state || e.pointerId !== state.pointerId) return;
    const { li, engaged } = state;
    state = null;
    if (engaged) settle(li);
  });
}
