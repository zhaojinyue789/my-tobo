/**
 * 列表拖动排序：pointer 事件统一鼠标 / 触控笔 / 触屏。
 * 不用 HTML5 DnD——Tauri dragDropEnabled 会接管原生拖放，移动端 WebView 对其支持残缺。
 *
 * 触发：鼠标 / 触控笔按下后移动 ≥ 阈值；触屏长按（避免与列表滚动冲突，进入后拦截 touchmove）。
 * 拖动中：指针越过相邻条目中线就把条目移过去，贴近视口上下边缘自动滚动。
 * 松手：回调 onDrop(被拖条目 id, 前邻 id, 后邻 id)，由调用方换算 order 并落库；
 *       Esc 按下则还原原始位置后再回调（调用方按原邻条算出原值 order，不会产生写入）。
 */

const LONG_PRESS_MS = 300;
const MOUSE_THRESHOLD_PX = 6;
const EDGE_SCROLL_PX = 48;
const EDGE_SCROLL_SPEED = 12;

interface DragState {
  li: HTMLElement;
  pointerId: number;
  originalNext: Element | null;
  lastY: number;
}

let dragging: DragState | null = null;

/** 拖动进行中：主渲染须跳过列表重建，否则被拖节点被替换、拖动中断 */
export function isDragging(): boolean {
  return dragging !== null;
}

export interface DragHooks {
  onDrop: (id: string, prevId: string | null, nextId: string | null) => void;
}

export function attachDragReorder(listEl: HTMLElement, hooks: DragHooks): void {
  let pending: {
    li: HTMLElement;
    pointerId: number;
    pointerType: string;
    startX: number;
    startY: number;
    timer?: ReturnType<typeof setTimeout>;
  } | null = null;

  const clearPending = (): void => {
    if (pending?.timer) clearTimeout(pending.timer);
    pending = null;
  };

  const midOf = (el: Element): number => {
    const r = el.getBoundingClientRect();
    return r.top + r.height / 2;
  };

  const startDrag = (li: HTMLElement, pointerId: number, startY: number): void => {
    dragging = { li, pointerId, originalNext: li.nextElementSibling, lastY: startY };
    li.classList.add("is-dragging");
    document.body.classList.add("is-reordering");
    try {
      li.setPointerCapture(pointerId);
    } catch {
      /* 指针已释放等：忽略，move/up 监听在 window 上仍能兜底 */
    }
    requestAnimationFrame(autoScroll);
  };

  const autoScroll = (): void => {
    if (!dragging) return;
    const y = dragging.lastY;
    const h = window.innerHeight;
    if (y < EDGE_SCROLL_PX) window.scrollBy(0, -EDGE_SCROLL_SPEED);
    else if (y > h - EDGE_SCROLL_PX) window.scrollBy(0, EDGE_SCROLL_SPEED);
    requestAnimationFrame(autoScroll);
  };

  /** commit=false 仅用于 Esc：先还原原始 DOM 位置，让调用方算出原值 order 而不产生写入 */
  const endDrag = (commit: boolean): void => {
    if (!dragging) return;
    const { li, originalNext, pointerId } = dragging;
    if (!commit) listEl.insertBefore(li, originalNext);
    li.classList.remove("is-dragging");
    document.body.classList.remove("is-reordering");
    try {
      li.releasePointerCapture(pointerId);
    } catch {
      /* 已随指针释放：忽略 */
    }
    dragging = null;
    // 吞掉拖动结束的那次 click：松手位置恰在行内按钮（如删除）上时会误触发
    li.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
      },
      { capture: true, once: true },
    );
    if (!commit) return;
    const prevId = li.previousElementSibling?.getAttribute("data-id") ?? null;
    const nextId = li.nextElementSibling?.getAttribute("data-id") ?? null;
    hooks.onDrop(li.dataset.id ?? "", prevId, nextId);
  };

  // 长按与拖动期间屏蔽系统右键菜单（触屏长按可能触发）
  listEl.addEventListener("contextmenu", (e) => {
    if (dragging || pending) e.preventDefault();
  });

  listEl.addEventListener(
    "touchmove",
    (e) => {
      if (dragging) e.preventDefault(); // 拖动中禁止页面滚动接管手势
    },
    { passive: false },
  );

  // 文本拖拽与拖动排序冲突：条目已 user-select:none，这里再兜一层
  listEl.addEventListener("dragstart", (e) => e.preventDefault());

  listEl.addEventListener("pointerdown", (e) => {
    if (dragging || pending) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const target = e.target as HTMLElement;
    // 交互控件上按下不进入拖动（勾选 / 删除 / 分类 / 日期）
    if (target.closest("button, select, input, option, a, label")) return;
    const li = target.closest<HTMLElement>(".todo-item");
    if (!li) return;
    pending = {
      li,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      startX: e.clientX,
      startY: e.clientY,
      // 触屏长按进入拖动；期间位移视为滚动意图，由 pointercancel / move 阈值取消
      timer:
        e.pointerType === "touch"
          ? setTimeout(() => {
              const p = pending;
              if (!p) return;
              pending = null;
              startDrag(p.li, p.pointerId, p.startY);
            }, LONG_PRESS_MS)
          : undefined,
    };
  });

  window.addEventListener("pointermove", (e) => {
    if (pending && !dragging) {
      if (e.pointerId !== pending.pointerId) return;
      const dist = Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY);
      // 触屏未长按前就移动 = 滚动意图，取消长按；鼠标 / 触控笔位移达标即进入拖动
      if (pending.pointerType === "touch") {
        if (dist > MOUSE_THRESHOLD_PX) clearPending();
        return;
      }
      if (dist < MOUSE_THRESHOLD_PX) return;
      const { li } = pending;
      clearPending();
      startDrag(li, e.pointerId, e.clientY);
    }
    if (!dragging || e.pointerId !== dragging.pointerId) return;
    dragging.lastY = e.clientY;
    const li = dragging.li;
    const y = e.clientY;
    // 越过相邻条目中线就移过去一格，循环推进直到落点稳定（快速甩动也不掉队）
    for (;;) {
      const next = li.nextElementSibling;
      const prev = li.previousElementSibling;
      if (next && y > midOf(next)) listEl.insertBefore(next, li);
      else if (prev && y < midOf(prev)) listEl.insertBefore(li, prev);
      else break;
    }
  });

  window.addEventListener("pointerup", (e) => {
    if (dragging && e.pointerId === dragging.pointerId) endDrag(true);
    else clearPending();
  });
  window.addEventListener("pointercancel", (e) => {
    if (dragging && e.pointerId === dragging.pointerId) endDrag(true);
    else clearPending();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dragging) endDrag(false);
  });
}
