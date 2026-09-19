import {
  createTodo,
  hasDuplicateOrders,
  isDeleted,
  isOverdue,
  isValidDueDate,
  loadTodos,
  markDeleted,
  nextAppendOrder,
  normalizeCategory,
  planRebalance,
  planReorder,
  saveTodos,
  sortTodos,
  todayISO,
  type Todo,
} from "./todo";
import {
  clearFocusState,
  computeFocusElapsed,
  formatHMS,
  loadTab,
  saveFocusState,
  saveTab,
  splitTodayOverdue,
  isTodayMember,
  todayMembers,
  type TodayTab,
} from "./today";
import {
  applyFilter,
  buildSelectOption,
  buildToolbar,
  categoryOptions,
  renderList,
  syncFilterMenu,
  type Filter,
  type View,
} from "./ui";
import { ensurePermission, notifyTodoDue } from "./notify";
import { SyncController, loadSyncConfig, loadSyncGistId, type SyncStatus } from "./sync";
import {
  CommandStack,
  applyForward,
  applyInverse,
  loadUndoState,
  makeClearAllCommand,
  makeCreateCommand,
  makeDeleteCommand,
  makeRebalanceCommand,
  makeReorderCommand,
  makeUpdateCommand,
} from "./undo";
import "./style.css";

const form = document.querySelector<HTMLFormElement>("#todo-form")!;
const input = document.querySelector<HTMLInputElement>("#todo-input")!;
const listEl = document.querySelector<HTMLUListElement>("#todo-list")!;
const listArea = document.querySelector<HTMLElement>("#list-area")!;
const overdueBox = document.querySelector<HTMLElement>("#overdue-box")!;
const overdueListEl = document.querySelector<HTMLUListElement>("#overdue-list")!;
const overdueTitle = document.querySelector<HTMLSpanElement>("#overdue-title")!;
const overdueToggle = document.querySelector<HTMLButtonElement>("#overdue-toggle")!;
const { filterButton, filterMenu, undoBtn, redoBtn, newCategoryInput, addCategoryBtn, categoryHint } =
  buildToolbar(overdueBox);
const footer = document.querySelector<HTMLElement>("#todo-footer")!;
const countEl = document.querySelector<HTMLSpanElement>("#todo-count")!;
const clearBtn = document.querySelector<HTMLButtonElement>("#clear-completed")!;
const clearAllBtn = document.querySelector<HTMLButtonElement>("#clear-all")!;
const todayDateText = document.querySelector<HTMLSpanElement>("#today-date-text")!;
const todayProgress = document.querySelector<HTMLSpanElement>("#today-progress")!;
const tabTodayBtn = document.querySelector<HTMLButtonElement>("#tab-today")!;
const tabAllBtn = document.querySelector<HTMLButtonElement>("#tab-all")!;
const tabTodayCount = document.querySelector<HTMLSpanElement>("#tab-today-count")!;

const syncDot = document.querySelector<HTMLElement>("#sync-dot")!;
const syncText = document.querySelector<HTMLElement>("#sync-text")!;
const syncNowBtn = document.querySelector<HTMLButtonElement>("#sync-now")!;
const syncSettingsBtn = document.querySelector<HTMLButtonElement>("#sync-settings")!;

const modal = document.querySelector<HTMLElement>("#sync-modal")!;
const gistTokenInput = document.querySelector<HTMLInputElement>("#gist-token")!;
const gistIdInput = document.querySelector<HTMLInputElement>("#gist-id")!;
const modalError = document.querySelector<HTMLElement>("#sync-modal-error")!;
const gistCreateBtn = document.querySelector<HTMLButtonElement>("#gist-create")!;
const gistSaveBtn = document.querySelector<HTMLButtonElement>("#gist-save")!;
const gistDisconnectBtn = document.querySelector<HTMLButtonElement>("#gist-disconnect")!;
const gistCloseBtn = document.querySelector<HTMLButtonElement>("#gist-close")!;
const storageWarning = document.querySelector<HTMLElement>("#storage-warning")!;

let todos: Todo[] = loadTodos();
/** 命令栈：仅本地持久化、不同步 Gist；命令应用与入栈见各交互处理器 */
const stack = new CommandStack(loadUndoState());
/** 视图态：只影响渲染，不碰数据、不触发同步；tab 记忆在 todoview_tab（默认 today） */
let view: View = { tab: loadTab(), category: "__all__", status: "all" };
/** 手动新建的分类：仅内存（不持久化，重启消失且无数据风险），与派生集合合并后进入各下拉框 */
const manualCategories = new Set<string>();

const sync = new SyncController({
  onTodos: (merged) => {
    todos = merged;
    render();
    scheduleRebalanceIfNeeded();
  },
  onStatus: renderSyncStatus,
});

const WEEKDAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 日期头文案：2026-09-20 → 「9月20日 周日」 */
function formatDateHeader(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const weekday = WEEKDAYS_ZH[new Date(y, (m ?? 1) - 1, d ?? 1).getDay()];
  return `${m}月${d}日 ${weekday}`;
}

function render(): void {
  // 拖拽进行中不重建列表（防同步回调打断手势）；拖完由 finishDrag 统一刷新
  if (drag) return;
  const today = todayISO();
  const members = todayMembers(todos, today);

  // 日期头 + tab 态 + 计数（今日 X/Y = 已完成/成员总数）
  todayDateText.textContent = formatDateHeader(today);
  tabTodayBtn.classList.toggle("is-active", view.tab === "today");
  tabAllBtn.classList.toggle("is-active", view.tab === "all");
  tabTodayBtn.setAttribute("aria-selected", String(view.tab === "today"));
  tabAllBtn.setAttribute("aria-selected", String(view.tab === "all"));
  const doneToday = members.filter((t) => t.completed).length;
  todayProgress.textContent = members.length ? `今日 ${doneToday}/${members.length}` : "今天暂无待办";
  tabTodayCount.textContent = String(members.length - doneToday);

  const categories = [...categoryOptions(todos), ...manualCategories].sort((a, b) =>
    a.localeCompare(b, "zh"),
  );
  syncFilter(categories);
  syncNewTodoCategory(categories);

  // tab 是过滤层；排序仍由 sortTodos（order 主序）权威决定；「今天」tab 过期分组置顶（DECISIONS.md D15）
  const base = view.tab === "today" ? members : todos;
  const sorted = sortTodos(base);
  let mainItems: Todo[];
  if (view.tab === "today") {
    const { overdue, rest } = splitTodayOverdue(sorted, today);
    overdueBox.classList.toggle("hidden", overdue.length === 0);
    overdueTitle.textContent = `已过期 ${overdue.length} 项`;
    renderList(overdueListEl, overdue, "", categories, { focus: true });
    mainItems = rest;
  } else {
    overdueBox.classList.add("hidden");
    mainItems = sorted;
  }
  renderList(
    listEl,
    applyFilter(mainItems, view),
    base.length > 0
      ? "该筛选下暂无待办"
      : view.tab === "today"
        ? "今天没有待办，添加一条开始吧～"
        : "这里空空如也，添加一条待办吧～",
    categories,
    view.tab === "today" ? { focus: true } : undefined,
  );

  // 底部计数随 tab 作用域；清除按钮保持全局语义（DECISIONS.md U8）
  const baseLive = base.filter((t) => !isDeleted(t));
  countEl.textContent = `剩余 ${baseLive.filter((t) => !t.completed).length} 项未完成`;
  footer.classList.toggle("hidden", baseLive.length === 0);
  clearBtn.classList.toggle("hidden", !baseLive.some((t) => t.completed));
  undoBtn.disabled = !stack.canUndo;
  redoBtn.disabled = !stack.canRedo;
}

/** 复合筛选同步：分类消失（最后一条被删）时回退未筛选，再按当前视图态刷新按钮与菜单 */
function syncFilter(categories: string[]): void {
  if (
    view.category !== "__all__" &&
    view.category !== "__uncat__" &&
    !categories.includes(view.category)
  ) {
    view.category = "__all__";
  }
  syncFilterMenu(filterButton, filterMenu, categories, view);
}

function persist(): void {
  // 写入失败（如配额超限）时亮起顶栏提示，恢复后自动隐藏
  storageWarning.classList.toggle("hidden", saveTodos(todos));
  sync.onLocalChange();
  render();
}

// ---------- 批量重整（合并后序值冲突的归一） ----------

let rebalanceQueued = false;

/** 合并结果存在相等有效序值时调度重整；同一 tick 内多次触发经 queueMicrotask 去抖只重整一次 */
function scheduleRebalanceIfNeeded(): void {
  if (rebalanceQueued || !hasDuplicateOrders(todos)) return;
  rebalanceQueued = true;
  queueMicrotask(() => {
    rebalanceQueued = false;
    const plan = planRebalance(todos);
    if (!plan) return;
    todos = plan.todos;
    stack.push(makeRebalanceCommand(plan)); // 重整也是可撤销命令（DECISIONS.md D9）
    persist(); // 重整产生的全部序号写入经既有防抖链路合并为一次推送
  });
}

// ---------- 过期通知（阶段 5）----------

/** 单条即时通知：过期且未通知 → 发送并标记 notified；未授权/发送失败不标记，下次触发重试 */
async function notifyTodoOnce(todo: Todo): Promise<void> {
  if (todo.notified || !isOverdue(todo)) return;
  if (!(await ensurePermission())) return;
  try {
    await notifyTodoDue(todo);
  } catch {
    return; // 系统通知服务失败：静默降级，不阻塞主流程
  }
  // 标记不 bump updatedAt：通知是设备本地 UX 状态，不参与 LWW 竞争
  todos = todos.map((t) => (t.id === todo.id ? { ...t, notified: true } : t));
  persist();
}

/** 启动批量：全部过期未通知条目各发一条；单条失败跳过，成功者统一落盘一次 */
async function notifyOverdueStartup(): Promise<void> {
  const targets = todos.filter((t) => isOverdue(t) && !t.notified);
  if (targets.length === 0) return;
  if (!(await ensurePermission())) return;
  let changed = false;
  for (const todo of targets) {
    try {
      await notifyTodoDue(todo);
    } catch {
      continue;
    }
    todos = todos.map((t) => (t.id === todo.id ? { ...t, notified: true } : t));
    changed = true;
  }
  if (changed) persist();
}

function renderSyncStatus(status: SyncStatus): void {
  syncDot.className = "sync-dot";
  switch (status.state) {
    case "unconfigured":
      syncDot.classList.add("is-unconfigured");
      syncText.textContent = "未开启同步";
      syncNowBtn.disabled = true;
      break;
    case "syncing":
      syncDot.classList.add("is-syncing");
      syncText.textContent = "同步中…";
      syncNowBtn.disabled = true;
      break;
    case "ok":
      syncDot.classList.add("is-ok");
      syncText.textContent = status.lastSync
        ? `已同步 ${new Date(status.lastSync).toLocaleTimeString()}`
        : "已同步";
      syncNowBtn.disabled = false;
      break;
    case "error":
      syncDot.classList.add("is-error");
      syncText.textContent = `同步失败：${status.message}`;
      syncText.title = status.message;
      syncNowBtn.disabled = false;
      break;
    default:
      syncText.textContent = "";
      syncNowBtn.disabled = false;
  }
}

// ---------- 待办交互 ----------

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  // 极罕见竞态：选中的分类在提交前已消失（无引用且非手动新建）→ 降级为未分类，不丢待办
  const known = new Set([...categoryOptions(todos), ...manualCategories]);
  const rawCategory = newTodoCategory.value;
  const category = rawCategory && known.has(rawCategory) ? normalizeCategory(rawCategory) : undefined;
  const todo = createTodo(text);
  if (category) todo.category = category; // createdAt = updatedAt = now 已由 createTodo 设定
  // 新项默认排末尾：创建即赋末序（末项 + STEP，空表从 STEP 起，任务书 ⑤）
  todo.order = nextAppendOrder(todos);
  // 「今天」tab 下快速新建默认进今天（任务书 B③）；「全部」tab 走三态自动规则
  if (view.tab === "today") todo.today = true;
  // 追加到数组末尾：显示顺序由 sortTodos（order/createdAt 升序）权威决定（DECISIONS.md D1）
  todos.push(todo);
  stack.push(makeCreateCommand(todo));
  input.value = ""; // 分类下拉保留当前选中，便于连续录入同一分类
  persist();
  // 即时到期检查：新建表单暂无日期输入，当前恒不触发；为后续表单扩展预留（任务 D）
  void notifyTodoOnce(todo);
});

// 部分内嵌浏览器不触发表单隐式提交，keydown 兜底；preventDefault 避免双重提交
input.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  form.requestSubmit();
});

// 新增表单的分类选择器：插在输入框与提交按钮之间，选项每次渲染后同步更新
const newTodoCategory = document.createElement("select");
newTodoCategory.id = "new-todo-category";
newTodoCategory.className = "new-todo-category";
newTodoCategory.setAttribute("aria-label", "新待办的分类");
form.insertBefore(
  newTodoCategory,
  form.querySelector<HTMLButtonElement>("button[type=submit]"),
);

/** 选项 = 未分类("") + 派生分类 + 手动新建；保留当前选中（连续录入），无则按视图态默认 */
function syncNewTodoCategory(categories: string[]): void {
  const previous = newTodoCategory.value;
  newTodoCategory.replaceChildren();
  const uncat = buildSelectOption("", "未分类");
  newTodoCategory.append(
    uncat,
    ...categories.map((name) => buildSelectOption(name, name)),
  );
  const fallback =
    view.category !== "__all__" &&
    view.category !== "__uncat__" &&
    categories.includes(view.category)
      ? view.category
      : "";
  newTodoCategory.value = previous && categories.includes(previous) ? previous : fallback;
}

listArea.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const item = target.closest<HTMLElement>(".todo-item");
  if (!item) return;
  const id = item.dataset.id;
  if (id === undefined) return;
  const current = todos.find((t) => t.id === id);
  if (!current) return;
  if (target.classList.contains("todo-toggle")) {
    const completed = !current.completed;
    todos = todos.map((t) => (t.id === id ? { ...t, completed, updatedAt: Date.now() } : t));
    stack.push(makeUpdateCommand(id, { completed: current.completed }, { completed }));
  } else if (target.classList.contains("todo-focus")) {
    startFocus(id);
    return; // startFocus 内部已本地落盘
  } else if (target.classList.contains("todo-today-pin")) {
    // 三态翻转：在今日（手动或自动）→ 移出；不在 → 加入（DECISIONS.md D12）
    const next = !isTodayMember(current, todayISO());
    todos = todos.map((t) => (t.id === id ? { ...t, today: next, updatedAt: Date.now() } : t));
    stack.push(makeUpdateCommand(id, { today: current.today ?? null }, { today: next }));
  } else if (target.classList.contains("todo-delete")) {
    if (isDeleted(current)) return;
    todos = todos.map((t) => (t.id === id ? markDeleted(t) : t));
    stack.push(makeDeleteCommand(current));
  } else {
    return;
  }
  persist();
});

// 行内控件（分类 select / 日期 input）：change 才写数据并落盘；渲染时直接赋 .value 不触发事件，无回写死循环
listArea.addEventListener("change", (e) => {
  const target = e.target as HTMLSelectElement | HTMLInputElement;
  const item = target.closest<HTMLElement>(".todo-item");
  if (!item) return;
  const current = todos.find((t) => t.id === item.dataset.id);
  if (!current) return;
  let updated: Todo | undefined;

  if (target.classList.contains("todo-category")) {
    const next = target.value === "__uncat__" ? undefined : normalizeCategory(target.value);
    if ((current.category ?? undefined) === (next ?? undefined)) return;
    todos = todos.map((t) => {
      if (t.id !== current.id) return t;
      updated = { ...t, category: next, updatedAt: Date.now() };
      return updated;
    });
    stack.push(
      makeUpdateCommand(
        current.id,
        { category: current.category ?? null },
        { category: next ?? null },
      ),
    );
  } else if (target.classList.contains("todo-due")) {
    const next = isValidDueDate(target.value) ? target.value : undefined; // 非法输入按清空处理，不报错
    if ((current.dueDate ?? undefined) === (next ?? undefined)) return;
    todos = todos.map((t) => {
      if (t.id !== current.id) return t;
      updated = { ...t, dueDate: next, updatedAt: Date.now() };
      return updated;
    });
    stack.push(
      makeUpdateCommand(current.id, { dueDate: current.dueDate ?? null }, { dueDate: next ?? null }),
    );
  } else {
    return;
  }
  persist();
  // 即时到期检查：改日期为过期值 → 立即通知并标记；改分类时 isOverdue 恒为否、自然跳过
  if (updated) void notifyTodoOnce(updated);
});

// ---------- 撤销 / 重做 ----------

function doUndo(): void {
  const cmd = stack.popUndo();
  if (!cmd) return; // 空栈无副作用不报错
  todos = applyInverse(cmd, todos);
  stack.pushRedo(cmd);
  persist();
}

function doRedo(): void {
  const cmd = stack.popRedo();
  if (!cmd) return;
  todos = applyForward(cmd, todos);
  stack.push(cmd); // push 清空 redo：重做后产生新动作即分叉的正常语义
  persist();
}

undoBtn.addEventListener("click", doUndo);
redoBtn.addEventListener("click", doRedo);

// 全局快捷键：Ctrl+Z / Ctrl+Shift+Z（Mac 兼容 Cmd）；输入框聚焦时交给原生文本撤销，屏蔽全局撤销
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (e.key.toLowerCase() !== "z") return;
  const el = document.activeElement;
  const typing =
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLElement && el.isContentEditable);
  if (typing) return;
  e.preventDefault();
  if (e.shiftKey) doRedo();
  else doUndo();
});

// ---------- 拖拽排序（原生 Drag & Drop；触摸降级见 touch 段） ----------
// 原则：dragover 只移动占位节点、绝不重渲染列表；松手后一次性提交 reorder 命令（可撤销）

interface DragState {
  id: string;
  placeholder: HTMLLIElement;
  /** 占位符当前插入位（所在分组剔除被拖项后的索引） */
  lastIndex: number;
  /** 拖起时的原始位置（Esc 取消 / 原位判定用） */
  originalIndex: number;
  pointerY: number;
  raf: number;
  /** 被拖项所属分组 UL：拖拽按组隔离（DECISIONS.md D15） */
  homeList: HTMLElement;
}

let drag: DragState | null = null;

/** 视口上下沿自动滚动触发区与速度 */
const EDGE_SCROLL_ZONE = 48;
const EDGE_SCROLL_SPEED = 12;

/** 被拖项所在分组的可见列表（今天 tab：过期组/正常组；全部 tab：全量可见） */
function dragSectionList(item: HTMLElement): Todo[] {
  if (view.tab !== "today") return applyFilter(sortTodos(todos), view);
  const { overdue, rest } = splitTodayOverdue(todayMembers(todos, todayISO()), todayISO());
  return sortTodos(item.parentElement === overdueListEl ? overdue : rest);
}

listArea.addEventListener("dragstart", (e) => {
  const dragEvent = e as DragEvent;
  // 触摸长按流程已接管（或正在拖拽）：禁用原生拖拽避免双轨（安卓 Chrome 支持原生 DnD）
  if (drag || touchPending) {
    dragEvent.preventDefault();
    if (touchPending) {
      clearTimeout(touchPending.timer);
      touchPending = null;
    }
    return;
  }
  const target = dragEvent.target as HTMLElement;
  // 行内控件（下拉/日期/按钮）交互优先，不误起拖拽
  if (target.closest("select, input, button")) {
    dragEvent.preventDefault();
    return;
  }
  const item = target.closest<HTMLElement>(".todo-item");
  const id = item?.dataset.id;
  if (!item || !id || !item.parentElement) return;
  const visible = dragSectionList(item);
  if (visible.length < 2) return; // 组内无可移动空间，不起拖
  const originalIndex = visible.findIndex((t) => t.id === id);
  if (originalIndex < 0) return;

  item.classList.add("dragging");
  // Firefox 需要 setData 才会进入拖拽；id 即拖拽数据
  dragEvent.dataTransfer?.setData("text/plain", id);
  if (dragEvent.dataTransfer) dragEvent.dataTransfer.effectAllowed = "move";

  const placeholder = document.createElement("li");
  placeholder.className = "drag-placeholder";
  placeholder.style.height = `${item.offsetHeight}px`;
  item.before(placeholder); // 初始占位 = 原位

  drag = {
    id,
    placeholder,
    lastIndex: originalIndex,
    originalIndex,
    pointerY: dragEvent.clientY,
    raf: 0,
    homeList: item.parentElement,
  };
  startAutoScroll();
});

listArea.addEventListener("dragover", (e) => {
  const dragEvent = e as DragEvent;
  if (!drag) return;
  dragEvent.preventDefault(); // 允许放置
  if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = "move";
  drag.pointerY = dragEvent.clientY;
  const index = insertionIndex(drag.homeList);
  if (index !== drag.lastIndex) movePlaceholder(index, drag.homeList);
});

// drop 的提交统一在 dragend 里做（dragend 在 drop 后必触发，取消拖拽也会触发）
listArea.addEventListener("drop", (e) => e.preventDefault());

listArea.addEventListener("dragend", () => finishDrag());

/** 计算占位符应处的插入位：指针 Y 与各项几何中点比较（剔除被拖项；仅在本组内） */
function insertionIndex(scope: HTMLElement): number {
  if (!drag) return 0;
  const items = [...scope.querySelectorAll<HTMLElement>(".todo-item:not(.dragging)")];
  for (let i = 0; i < items.length; i++) {
    const rect = items[i].getBoundingClientRect();
    if (drag.pointerY < rect.top + rect.height / 2) return i;
  }
  return items.length;
}

/** 只移动占位节点（不重渲染）；位次未变时调用方跳过，避免高频 dragover 重复操作 DOM */
function movePlaceholder(index: number, scope: HTMLElement): void {
  if (!drag) return;
  const items = [...scope.querySelectorAll<HTMLElement>(".todo-item:not(.dragging)")];
  drag.lastIndex = index;
  if (index >= items.length) scope.append(drag.placeholder);
  else items[index].before(drag.placeholder);
}

/** 收尾：清理占位与浮起样式；占位位置 ≠ 原位则一次性提交 reorder 命令 */
function finishDrag(): void {
  if (!drag) return;
  const { id, placeholder, lastIndex, homeList } = drag;
  cancelAnimationFrame(drag.raf);
  placeholder.remove();
  listArea.querySelector<HTMLElement>(".todo-item.dragging")?.classList.remove("dragging");
  drag = null;

  // 邻居来源 = 所在分组的当前列表（planReorder 取中点数学与 Phase 1 一致，DECISIONS.md D15）
  const visible =
    view.tab === "today"
      ? sortTodos(splitTodayOverdue(todayMembers(todos, todayISO()), todayISO())[homeList === overdueListEl ? "overdue" : "rest"])
      : applyFilter(sortTodos(todos), view);
  const currentIndex = visible.findIndex((t) => t.id === id);
  if (currentIndex < 0 || lastIndex === currentIndex) return; // 原位放下：无命令无渲染
  const plan = planReorder(todos, id, lastIndex, visible);
  if (!plan) return;
  todos = plan.todos;
  stack.push(makeReorderCommand(plan));
  persist();
}

/** 边缘自动滚动：拖拽期间 rAF 循环，指针接近视口上下沿时逐帧滚动，并跟随滚动刷新占位位次 */
function startAutoScroll(): void {
  if (!drag) return;
  const step = (): void => {
    if (!drag) return;
    if (drag.pointerY < EDGE_SCROLL_ZONE) window.scrollBy(0, -EDGE_SCROLL_SPEED);
    else if (drag.pointerY > window.innerHeight - EDGE_SCROLL_ZONE) {
      window.scrollBy(0, EDGE_SCROLL_SPEED);
    }
    const index = insertionIndex(drag.homeList);
    if (index !== drag.lastIndex) movePlaceholder(index, drag.homeList);
    drag.raf = requestAnimationFrame(step);
  };
  drag.raf = requestAnimationFrame(step);
}

// Esc 取消拖拽：占位复位到原位后正常收尾（原位判定 ⇒ 不产生命令）
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !drag) return;
  movePlaceholder(drag.originalIndex, drag.homeList);
  finishDrag();
});

// ---------- 触摸降级：移动端无原生 DnD 事件，用 touch 三事件模拟 ----------
// 长按激活（防吞滚动）；落点计算/占位符/提交与桌面复用同一套代码（DECISIONS.md D10）

const TOUCH_LONG_PRESS_MS = 250;
/** 长按生效前位移超过该值视为滚动意图，取消激活 */
const TOUCH_MOVE_CANCEL_PX = 10;

interface TouchPending {
  id: string;
  item: HTMLElement;
  startX: number;
  startY: number;
  timer: ReturnType<typeof setTimeout>;
}

let touchPending: TouchPending | null = null;

listArea.addEventListener(
  "touchstart",
  (e) => {
    if (drag) return;
    const target = e.target as HTMLElement;
    if (target.closest("select, input, button")) return; // 控件交互优先，永不激活拖拽
    const item = target.closest<HTMLElement>(".todo-item");
    const id = item?.dataset.id;
    if (!item || !id || !item.parentElement) return;
    const visible = dragSectionList(item);
    if (visible.length < 2) return;
    const originalIndex = visible.findIndex((t) => t.id === id);
    if (originalIndex < 0) return;
    const touch = e.touches[0];
    if (!touch) return;
    const timer = setTimeout(
      () => beginTouchDrag(id, item, originalIndex, touch.clientY),
      TOUCH_LONG_PRESS_MS,
    );
    touchPending = { id, item, startX: touch.clientX, startY: touch.clientY, timer };
  },
  { passive: true },
);

/** 长按生效：进入拖拽态（若原生拖拽已接管则放弃，防双占位符） */
function beginTouchDrag(
  id: string,
  item: HTMLElement,
  originalIndex: number,
  clientY: number,
): void {
  touchPending = null;
  if (drag || !item.parentElement) return;
  item.classList.add("dragging");
  const placeholder = document.createElement("li");
  placeholder.className = "drag-placeholder";
  placeholder.style.height = `${item.offsetHeight}px`;
  item.before(placeholder);
  drag = {
    id,
    placeholder,
    lastIndex: originalIndex,
    originalIndex,
    pointerY: clientY,
    raf: 0,
    homeList: item.parentElement,
  };
  startAutoScroll();
}

listArea.addEventListener(
  "touchmove",
  (e) => {
    const touch = e.touches[0];
    if (!drag) {
      // 未激活：位移超阈值取消长按计时，放行为页面滚动
      if (touchPending && touch) {
        const dx = touch.clientX - touchPending.startX;
        const dy = touch.clientY - touchPending.startY;
        if (Math.hypot(dx, dy) > TOUCH_MOVE_CANCEL_PX) {
          clearTimeout(touchPending.timer);
          touchPending = null;
        }
      }
      return;
    }
    e.preventDefault(); // 拖拽中阻止页面滚动（本监听为非 passive）
    if (touch) drag.pointerY = touch.clientY;
    const index = insertionIndex(drag.homeList);
    if (index !== drag.lastIndex) movePlaceholder(index, drag.homeList);
  },
  { passive: false },
);

function endTouchDrag(): void {
  if (touchPending) {
    clearTimeout(touchPending.timer);
    touchPending = null;
  }
  if (drag) finishDrag();
}

listArea.addEventListener("touchend", endTouchDrag);
listArea.addEventListener("touchcancel", endTouchDrag);

// ---------- 过期置顶折叠组 ----------

let overdueOpen = true;
overdueToggle.addEventListener("click", () => {
  overdueOpen = !overdueOpen;
  overdueBox.classList.toggle("is-collapsed", !overdueOpen);
  overdueToggle.setAttribute("aria-expanded", String(overdueOpen));
});

// ---------- 专注模式（第二幕）：一次只做一件事，差值法计时（DECISIONS.md D14/D18） ----------

const focusOverlay = document.querySelector<HTMLElement>("#focus-overlay")!;
const focusCategoryEl = document.querySelector<HTMLElement>("#focus-category")!;
const focusTextEl = document.querySelector<HTMLElement>("#focus-text")!;
const focusDueEl = document.querySelector<HTMLElement>("#focus-due")!;
const focusTimerEl = document.querySelector<HTMLElement>("#focus-timer")!;
const focusDoneBtn = document.querySelector<HTMLButtonElement>("#focus-done")!;
const focusPauseBtn = document.querySelector<HTMLButtonElement>("#focus-pause")!;
const focusSkipBtn = document.querySelector<HTMLButtonElement>("#focus-skip")!;
const focusExitBtn = document.querySelector<HTMLButtonElement>("#focus-exit")!;

/** 当前专注会话（内存态）；权威镜像在 todoview_focus */
let focusSession: { id: string; startedAt: number | null; accumulatedMs: number } | null = null;
let focusTimerId: ReturnType<typeof setInterval> | undefined;

function focusTarget(): Todo | undefined {
  return focusSession ? todos.find((t) => t.id === focusSession!.id) : undefined;
}

function focusElapsedMs(now: number = Date.now()): number {
  return focusSession
    ? computeFocusElapsed(focusSession.accumulatedMs, focusSession.startedAt, now)
    : 0;
}

/** focus 字段属本地状态：只写 localStorage 与渲染，不走同步推送（DECISIONS.md D13） */
function persistLocalOnly(): void {
  storageWarning.classList.toggle("hidden", saveTodos(todos));
  render();
}

/** 暂停：已计时长并入会话累计，运行态保留（可继续） */
function pauseFocus(): void {
  if (!focusSession || focusSession.startedAt == null) return;
  focusSession.accumulatedMs += Math.max(0, Date.now() - focusSession.startedAt);
  focusSession.startedAt = null;
  todos = todos.map((t) => (t.id === focusSession!.id ? { ...t, focusStartedAt: undefined } : t));
  saveFocusState({
    id: focusSession.id,
    startedAt: null,
    accumulatedMs: focusSession.accumulatedMs,
    savedAt: Date.now(),
  });
  persistLocalOnly();
}

/** 继续：从当前时刻起算（差值法，中断时长不计时） */
function resumeFocus(): void {
  if (!focusSession || focusSession.startedAt != null) return;
  focusSession.startedAt = Date.now();
  todos = todos.map((t) =>
    t.id === focusSession!.id ? { ...t, focusStartedAt: focusSession!.startedAt! } : t,
  );
  saveFocusState({
    id: focusSession.id,
    startedAt: focusSession.startedAt,
    accumulatedMs: focusSession.accumulatedMs,
    savedAt: Date.now(),
  });
  persistLocalOnly();
}

/** 结算：会话时长并入条目 focusTotalMs，清空运行态（不 bump updatedAt——本地状态不参与 LWW） */
function settleFocus(now: number = Date.now()): void {
  if (!focusSession) return;
  const { id, startedAt, accumulatedMs } = focusSession;
  const elapsed = computeFocusElapsed(accumulatedMs, startedAt, now);
  todos = todos.map((t) =>
    t.id === id
      ? {
          ...t,
          focusTotalMs: elapsed > 0 ? (t.focusTotalMs ?? 0) + elapsed : t.focusTotalMs,
          focusStartedAt: undefined,
        }
      : t,
  );
  focusSession = null;
  clearFocusState();
  stopFocusTimer();
}

/** 进入专注：同项重入只重开遮罩（防重复累加）；换项先结算当前会话（一次只做一件事） */
function startFocus(id: string): void {
  if (focusSession?.id === id) {
    openFocusOverlay();
    return;
  }
  if (focusSession) settleFocus();
  const todo = todos.find((t) => t.id === id && !isDeleted(t) && !t.completed);
  if (!todo) return;
  focusSession = { id, startedAt: Date.now(), accumulatedMs: 0 };
  todos = todos.map((t) => (t.id === id ? { ...t, focusStartedAt: focusSession!.startedAt! } : t));
  saveFocusState({ id, startedAt: focusSession.startedAt, accumulatedMs: 0, savedAt: Date.now() });
  persistLocalOnly();
  openFocusOverlay();
}

/** 完成：completed=true 走 update 命令（可撤销）；时长结算后清会话 */
function focusDone(): void {
  const target = focusTarget();
  if (!target) return;
  settleFocus();
  todos = todos.map((t) => (t.id === target.id ? { ...t, completed: true, updatedAt: Date.now() } : t));
  stack.push(makeUpdateCommand(target.id, { completed: target.completed }, { completed: true }));
  persist();
  closeFocusOverlay();
}

/** 跳过：移出今天（update 命令，可撤销）；已计时长照记 */
function focusSkip(): void {
  const target = focusTarget();
  if (!target) return;
  settleFocus();
  todos = todos.map((t) => (t.id === target.id ? { ...t, today: false, updatedAt: Date.now() } : t));
  stack.push(makeUpdateCommand(target.id, { today: target.today ?? null }, { today: false }));
  persist();
  closeFocusOverlay();
}

function openFocusOverlay(): void {
  updateFocusOverlay();
  focusOverlay.classList.remove("hidden");
  startFocusTimer();
}

function closeFocusOverlay(): void {
  focusOverlay.classList.add("hidden");
  stopFocusTimer();
}

function updateFocusOverlay(): void {
  const t = focusTarget();
  if (!t) {
    closeFocusOverlay();
    return;
  }
  focusCategoryEl.textContent = t.category ?? "未分类";
  focusTextEl.textContent = t.text;
  focusDueEl.textContent = t.dueDate
    ? `截止 ${formatDueZh(t.dueDate)}${isOverdue(t) ? " · 已逾期" : ""}`
    : "无截止日期";
  focusPauseBtn.textContent = focusSession?.startedAt != null ? "暂停" : "继续";
  focusTimerEl.textContent = formatHMS(focusElapsedMs());
}

/** 2026-09-25 → 「9月25日」 */
function formatDueZh(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${m}月${d}日`;
}

function renderFocusTimer(): void {
  focusTimerEl.textContent = formatHMS(focusElapsedMs());
}

function startFocusTimer(): void {
  stopFocusTimer();
  focusTimerId = setInterval(renderFocusTimer, 1000);
}

function stopFocusTimer(): void {
  if (focusTimerId) {
    clearInterval(focusTimerId);
    focusTimerId = undefined;
  }
}

focusDoneBtn.addEventListener("click", focusDone);
focusSkipBtn.addEventListener("click", focusSkip);
focusExitBtn.addEventListener("click", () => {
  pauseFocus(); // 退出 = 暂停：会话保留，重进可继续
  closeFocusOverlay();
});
focusPauseBtn.addEventListener("click", () => {
  if (focusSession?.startedAt != null) pauseFocus();
  else resumeFocus();
  updateFocusOverlay();
});

// Esc 退出专注 = 暂停并关遮罩；drag 未激活时互不影响，不触发撤销（验收 7）
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !focusSession || focusOverlay.classList.contains("hidden")) return;
  pauseFocus();
  closeFocusOverlay();
});

// ---------- 视图 tab（今天/全部） ----------

function setTab(tab: TodayTab): void {
  if (view.tab === tab) return;
  view.tab = tab;
  saveTab(tab);
  render();
}

tabTodayBtn.addEventListener("click", () => setTab("today"));
tabAllBtn.addEventListener("click", () => setTab("all"));

// ---------- 复合筛选（分类/状态二选一） ----------

function closeFilterMenu(): void {
  filterMenu.classList.remove("open");
  filterButton.setAttribute("aria-expanded", "false");
}

// 按钮：开合菜单
filterButton.addEventListener("click", () => {
  const open = !filterMenu.classList.contains("open");
  filterMenu.classList.toggle("open", open);
  filterButton.setAttribute("aria-expanded", String(open));
});

// 选项：设置视图态后 rAF 重渲染；同项再点 = 取消筛选恢复「全部待办」
filterMenu.addEventListener("click", (e) => {
  const opt = (e.target as HTMLElement).closest<HTMLElement>("[data-kind]");
  if (!opt) return;
  const kind = opt.dataset.kind;
  const value = opt.dataset.value ?? "";
  const isActive =
    kind === "category"
      ? view.category === value && view.status === "all"
      : kind === "status" && view.status === value && view.category === "__all__";
  view = isActive
    ? { tab: view.tab, category: "__all__", status: "all" }
    : kind === "category"
      ? { tab: view.tab, category: value, status: "all" }
      : { tab: view.tab, category: "__all__", status: value as Filter };
  closeFilterMenu();
  requestAnimationFrame(render);
});

// 键盘可达：选项获得焦点时 Enter/Space 视同点击
filterMenu.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const opt = (e.target as HTMLElement).closest<HTMLElement>("[data-kind]");
  if (!opt) return;
  e.preventDefault();
  opt.click();
});

// 点击按钮/菜单以外或按 Esc 收起菜单
document.addEventListener("click", (e) => {
  const target = e.target as Node;
  if (filterMenu.contains(target) || filterButton.contains(target)) return;
  closeFilterMenu();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeFilterMenu();
});

// 新建分类：不产生独立实体，仅加入内存集合；空值/重复拒绝
let hintTimer: ReturnType<typeof setTimeout> | undefined;
function showCategoryHint(message: string): void {
  categoryHint.textContent = message;
  categoryHint.classList.remove("hidden");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => categoryHint.classList.add("hidden"), 2500);
}

addCategoryBtn.addEventListener("click", () => {
  const name = normalizeCategory(newCategoryInput.value);
  if (!name) return showCategoryHint("分类名不能为空或含非法字符");
  if (manualCategories.has(name) || categoryOptions(todos).includes(name)) {
    return showCategoryHint(`分类「${name}」已存在`);
  }
  manualCategories.add(name);
  newCategoryInput.value = "";
  showCategoryHint(`已添加「${name}」`);
  render();
});

clearBtn.addEventListener("click", () => {
  // 批量清除记为单条命令（可一次撤销恢复）；无已完成条目时不产生命令
  const targets = todos.filter((t) => !isDeleted(t) && t.completed);
  if (targets.length === 0) return;
  todos = todos.map((t) => (!isDeleted(t) && t.completed ? markDeleted(t) : t));
  stack.push(makeClearAllCommand(targets));
  persist();
});

// 清除全部：confirm 二次确认后给全部现存条目打墓碑（不能物理清空数组，
// 否则远端仍存有这些条目，下次同步会按 LWW 全部复活）；记为单条命令，一次撤销可全部恢复
clearAllBtn.addEventListener("click", () => {
  if (!confirm("确定要清除全部待办吗？清除后可通过撤销恢复")) return;
  const targets = todos.filter((t) => !isDeleted(t));
  todos = todos.map((t) => (isDeleted(t) ? t : markDeleted(t)));
  stack.push(makeClearAllCommand(targets));
  persist();
});

// ---------- 同步交互 ----------

syncNowBtn.addEventListener("click", () => void sync.syncNow());

function openModal(): void {
  const cfg = loadSyncConfig();
  // Token 读不到时（Store 读取失败/换机等）保留 gistId 回填，用户只需重输 Token
  gistIdInput.value = cfg?.gistId ?? loadSyncGistId();
  gistTokenInput.value = cfg?.token ?? "";
  modalError.classList.add("hidden");
  if (!cfg && gistIdInput.value) showModalError("未读取到已保存的 Token，请重新输入");
  modal.classList.remove("hidden");
  gistTokenInput.focus();
}

function showModalError(message: string): void {
  modalError.textContent = message;
  modalError.classList.remove("hidden");
}

function setModalBusy(busy: boolean): void {
  for (const btn of [gistCreateBtn, gistSaveBtn, gistDisconnectBtn, gistCloseBtn]) {
    btn.disabled = busy;
  }
}

syncSettingsBtn.addEventListener("click", openModal);

gistCloseBtn.addEventListener("click", () => modal.classList.add("hidden"));

// 点击遮罩关闭
modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.classList.add("hidden");
});

gistCreateBtn.addEventListener("click", async () => {
  const token = gistTokenInput.value.trim();
  if (!token) return showModalError("创建 Gist 前请先填入 Token");
  setModalBusy(true);
  try {
    const url = await sync.createGist(token);
    gistIdInput.value = loadSyncConfig()?.gistId ?? "";
    gistCloseBtn.textContent = "完成";
    console.info("已创建私密 Gist：", url);
  } catch (err) {
    showModalError(err instanceof Error ? err.message : String(err));
  } finally {
    setModalBusy(false);
  }
});

gistSaveBtn.addEventListener("click", async () => {
  const token = gistTokenInput.value.trim();
  const gistId = gistIdInput.value.trim();
  if (!token || !gistId) return showModalError("Token 和 Gist ID 都需要填写");
  setModalBusy(true);
  const ok = await sync.saveConfig({ token, gistId });
  setModalBusy(false);
  if (!ok) {
    showModalError("本地存储写入失败，配置未保存，请检查存储空间");
    return;
  }
  modal.classList.add("hidden");
  void sync.syncNow();
});

gistDisconnectBtn.addEventListener("click", () => {
  void sync.saveConfig(null);
  gistTokenInput.value = "";
  gistIdInput.value = "";
  modal.classList.add("hidden");
});

// ---------- 启动 ----------

input.focus();
render();
// 启动批量过期通知：N 条过期未通知各发一条；权限未授予/失败静默降级
void notifyOverdueStartup();
// 启动即拉取一次远端（未配置时静默显示“未开启同步”）
void sync.syncNow();
// 自动同步循环：30 秒轮询 + 失败退避重试
sync.startAutoSync();
// 窗口回到前台立即拉一次（手机切回 App、电脑切回窗口时感知另一端改动）
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void sync.syncNow();
});
// 网络恢复立即同步
window.addEventListener("online", () => void sync.syncNow());

// PWA：仅在 http(s) 环境注册（file:// 与 Tauri 自定义协议下跳过）
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("./sw.js").catch(() => {
    /* 注册失败不影响功能 */
  });
}
