/**
 * 卡片拖拽引擎（看板/日历等非列表视图共用）：
 * 按下卡片 → 拖拽未开始前不干扰页面；达到阈值后创建跟手幽灵卡，原卡半透明占位；
 * 视图通过 onMove/onDrop 钩子用 elementFromPoint 解析悬停目标（列 / 日期格）。
 * 触屏长按 300ms 进入（避免与列表滚动冲突），鼠标位移 ≥6px 即进入——与列表拖动排序同款约定。
 * 视图每次重渲染会重建容器并重新 attach，因此 window 级监听只在模块内绑定一次，
 * 钩子通过 attach 调用替换为最新视图的实现。
 */

const LONG_PRESS_MS = 300;
const MOUSE_THRESHOLD_PX = 6;

export interface CardDragHooks {
  /** 当前是否允许拖拽（弹窗打开/行内编辑中等场景禁用） */
  isActive(): boolean;
  /** 该元素是否可作为拖拽起点（视图决定哪些节点是卡片），返回卡片的任务 id */
  canDrag(el: HTMLElement): { id: string } | null;
  /** 拖拽开始（视图可加高亮） */
  onStart(id: string): void;
  /** 拖拽移动（视图在此做悬停目标高亮） */
  onMove(id: string, x: number, y: number): void;
  /** 松手：视图解析落点并应用（无有效落点 = 取消） */
  onDrop(id: string, x: number, y: number): void;
  /** Esc / pointercancel 取消 */
  onCancel(id: string): void;
}

interface DragState {
  id: string;
  source: HTMLElement;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  /** 是否已进入拖拽（touch 长按后 / mouse 位移达标后） */
  engaged: boolean;
  /** 触屏长按计时器 */
  timer?: ReturnType<typeof setTimeout>;
}

let hooks: CardDragHooks | null = null;
let rootEl: HTMLElement | null = null;
let state: DragState | null = null;
let ghost: HTMLElement | null = null;
let windowBound = false;

function clearState(): void {
  state = null;
}

function removeGhost(): void {
  ghost?.remove();
  ghost = null;
}

function engage(x: number, y: number): void {
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.engaged = true;
  const rect = state.source.getBoundingClientRect();
  ghost = state.source.cloneNode(true) as HTMLElement;
  ghost.className = `drag-ghost ${state.source.className}`;
  ghost.style.width = `${rect.width}px`;
  state.offsetX = x - rect.left;
  state.offsetY = y - rect.top;
  ghost.style.left = `${x - state.offsetX}px`;
  ghost.style.top = `${y - state.offsetY}px`;
  document.body.append(ghost);
  state.source.classList.add("card-drag-source");
  try {
    rootEl?.setPointerCapture(state.pointerId);
  } catch {
    /* 指针已释放等：move/up 监听在 window 上仍能兜底 */
  }
  hooks?.onStart(state.id);
}

/** 松手/取消后的收尾：去幽灵、还原原卡 */
function teardown(): void {
  if (state?.timer) clearTimeout(state.timer);
  removeGhost();
  if (state) state.source.classList.remove("card-drag-source");
  clearState();
}

function bindWindow(): void {
  if (windowBound) return;
  windowBound = true;

  window.addEventListener(
    "touchmove",
    (e) => {
      if (state?.engaged) e.preventDefault(); // 拖拽中禁止页面滚动接管手势
    },
    { passive: false },
  );

  window.addEventListener("pointermove", (e) => {
    if (!state || e.pointerId !== state.pointerId) return;
    if (!state.engaged) {
      const dist = Math.hypot(e.clientX - state.startX, e.clientY - state.startY);
      if (state.pointerType === "touch") {
        // 触屏未长按就移动 = 滚动意图，取消
        if (dist > MOUSE_THRESHOLD_PX) teardown();
        return;
      }
      if (dist < MOUSE_THRESHOLD_PX) return;
      engage(e.clientX, e.clientY);
      return;
    }
    if (!ghost) return;
    ghost.style.left = `${e.clientX - state.offsetX}px`;
    ghost.style.top = `${e.clientY - state.offsetY}px`;
    hooks?.onMove(state.id, e.clientX, e.clientY);
  });

  window.addEventListener("pointerup", (e) => {
    if (!state || e.pointerId !== state.pointerId) return;
    const { id, engaged } = state;
    const wasEngaged = engaged;
    teardown();
    if (!wasEngaged) return;
    // 吞掉拖拽结束的合成 click：防止落到卡片内按钮上
    rootEl?.addEventListener(
      "click",
      (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      },
      { capture: true, once: true },
    );
    hooks?.onDrop(id, e.clientX, e.clientY);
  });

  window.addEventListener("pointercancel", (e) => {
    if (!state || e.pointerId !== state.pointerId) return;
    const wasEngaged = state.engaged;
    const id = state.id;
    teardown();
    if (wasEngaged) hooks?.onCancel(id);
  });

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !state?.engaged) return;
    const id = state.id;
    teardown();
    hooks?.onCancel(id);
  });
}

export function attachCardDrag(root: HTMLElement, h: CardDragHooks): void {
  bindWindow();
  rootEl = root;
  hooks = h;
  root.addEventListener("pointerdown", (e) => {
    if (state) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const target = e.target as HTMLElement;
    const hit = hooks?.canDrag(target);
    if (!hit) return;
    const source = target.closest<HTMLElement>("[data-card-id]");
    if (!source) return;
    if (!hooks?.isActive()) return;
    state = {
      id: hit.id,
      source,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: 0,
      offsetY: 0,
      engaged: false,
    };
    // 触屏长按进入拖拽
    if (e.pointerType === "touch") {
      state.timer = setTimeout(() => {
        if (state && !state.engaged && state.pointerId === e.pointerId) {
          engage(e.clientX, e.clientY);
        }
      }, LONG_PRESS_MS);
    }
  });
}
