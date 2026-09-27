import {
  dateOffset,
  daysBetween,
  deletedRecently,
  isDeleted,
  isDueSoon,
  isDueToday,
  isOverdue,
  recurrenceLabel,
  todayISO,
  type Priority,
  type Todo,
} from "./todo";

export type Filter = "all" | "active" | "completed" | "deleted" | "today" | "soon";

/** 状态筛选的展示名（筛选菜单选项与按钮文字共用） */
export const STATUS_LABEL: Record<Filter, string> = {
  all: "全部待办",
  active: "未完成",
  completed: "已完成",
  deleted: "最近删除",
  today: "今天到期",
  soon: "即将到期",
};

/** 视图态：纯渲染层状态，与数据无关，不写存储、不触发同步 */
export type View = { status: Filter };

/** 视图模式：列表 / 看板 / 日历 / 时间线 */
export type ViewMode = "list" | "board" | "calendar" | "timeline";

export function filterTodos(todos: Todo[], filter: Filter): Todo[] {
  // 已删除（墓碑未过期）的项不参与展示
  const live = todos.filter((t) => !isDeleted(t));
  if (filter === "active") return live.filter((t) => !t.completed);
  if (filter === "completed") return live.filter((t) => t.completed);
  return live;
}

/**
 * 视图过滤：输入全量列表（含墓碑），输出当前视图可见条目（保持原顺序）。
 * 契约：纯函数；"deleted" 视图只看保留期内的墓碑（回收站）；其余视图已删条目恒不可见；
 * 不改数据、不写存储、不触发同步。复杂度 O(N)。
 */
export function applyFilter(todos: Todo[], v: View, today: string = todayISO()): Todo[] {
  if (v.status === "deleted") return todos.filter(deletedRecently);
  let live: Todo[];
  if (v.status === "today") live = todos.filter((t) => isDueToday(t, today));
  else if (v.status === "soon") live = todos.filter((t) => isDueSoon(t, today));
  else live = filterTodos(todos, v.status);
  return live;
}

export function buildSelectOption(value: string, label: string): HTMLOptionElement {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  return opt;
}

export interface ToolbarRefs {
  root: HTMLElement;
  /** 复合筛选按钮：文字显示当前生效筛选，点击开合菜单 */
  filterButton: HTMLButtonElement;
  /** 复合筛选菜单（选项每次 render 由 syncFilterMenu 重建） */
  filterMenu: HTMLElement;
  /** 排序模式切换按钮：手动 ⇄ 按截止时间（图标反映当前模式） */
  sortToggle: HTMLButtonElement;
  /** 视图模式切换（列表/看板/日历/时间线） */
  viewSwitch: HTMLElement;
  /** 文本搜索框（实时过滤当前视图） */
  searchInput: HTMLInputElement;
}

/** 顶部工具栏：复合筛选 + 「新建分类」行内编辑；构建后插在列表容器之前 */
export function buildToolbar(before: HTMLElement): ToolbarRefs {
  const root = document.createElement("div");
  root.id = "toolbar";
  root.className = "toolbar";

  // 筛选行：复合筛选按钮 + 排序切换 + 搜索
  const filters = document.createElement("div");
  filters.className = "toolbar-filters";

  const filterWrap = document.createElement("div");
  filterWrap.className = "filter-dd";

  const filterButton = document.createElement("button");
  filterButton.id = "filter-button";
  filterButton.className = "filter-button";
  filterButton.type = "button";
  filterButton.setAttribute("aria-haspopup", "listbox");
  filterButton.setAttribute("aria-expanded", "false");
  const buttonText = document.createElement("span");
  buttonText.className = "filter-button-text";
  buttonText.textContent = "全部待办";
  filterButton.append(buttonText);

  const filterMenu = document.createElement("div");
  filterMenu.id = "filter-menu";
  filterMenu.className = "filter-menu";
  filterMenu.setAttribute("role", "listbox");
  filterMenu.setAttribute("aria-label", "筛选选项");

  filterWrap.append(filterButton, filterMenu);

  // 排序模式切换：⇅ 手动（拖动/键盘排序）⇄ 🕒 按截止时间（近的在前）。
  // 图标反映当前模式，点击切换；持久化为设备本地偏好（main.ts 绑定点击）
  const sortToggle = document.createElement("button");
  sortToggle.className = "sort-toggle";
  sortToggle.type = "button";
  sortToggle.setAttribute("aria-pressed", "false");
  sortToggle.setAttribute("aria-label", "排序模式");
  sortToggle.title = "排序：手动";

  // 文本搜索：实时过滤当前视图（Ctrl+F 聚焦由 main.ts 绑定）
  const searchInput = document.createElement("input");
  searchInput.id = "todo-search";
  searchInput.className = "search-input";
  searchInput.type = "search";
  searchInput.placeholder = "搜索待办…";
  searchInput.maxLength = 50;
  searchInput.setAttribute("aria-label", "搜索待办");

  // 视图模式切换：列表/看板/日历/时间线（图标 + 选中态，点击由 main 绑定）
  const viewSwitch = document.createElement("div");
  viewSwitch.className = "view-switch";
  viewSwitch.setAttribute("role", "group");
  viewSwitch.setAttribute("aria-label", "视图模式");
  const VIEW_MODE_META: { key: ViewMode; label: string; icon: string }[] = [
    {
      key: "list",
      label: "列表",
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10" /></svg>`,
    },
    {
      key: "board",
      label: "看板",
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="10" rx="1" /><rect x="17" y="4" width="4" height="13" rx="1" /></svg>`,
    },
    {
      key: "calendar",
      label: "日历",
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /></svg>`,
    },
    {
      key: "timeline",
      label: "时间线",
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 3v18" /><circle cx="12" cy="7" r="2" /><circle cx="14" cy="13" r="2" /><circle cx="11" cy="19" r="2" /></svg>`,
    },
  ];
  for (const m of VIEW_MODE_META) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "view-switch-btn";
    btn.dataset.vm = m.key;
    btn.title = `${m.label}视图`;
    btn.setAttribute("aria-label", `${m.label}视图`);
    btn.innerHTML = `${m.icon}<span>${m.label}</span>`;
    viewSwitch.append(btn);
  }
  filters.append(filterWrap, sortToggle, viewSwitch, searchInput);

  root.append(filters);
  before.before(root);
  return { root, filterButton, filterMenu, sortToggle, viewSwitch, searchInput };
}

/** 同步视图切换的选中态 */
export function syncViewSwitch(container: HTMLElement, mode: ViewMode): void {
  container.querySelectorAll<HTMLElement>("[data-vm]").forEach((btn) => {
    btn.classList.toggle("is-selected", btn.dataset.vm === mode);
    btn.setAttribute("aria-pressed", String(btn.dataset.vm === mode));
  });
}

/** 排序切换按钮的图标与文案（SVG 与同步栏图标同风格） */
const SORT_ICONS = {
  manual: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v13M7 4L4 7M7 4l3 3" /><path d="M17 20V7M17 20l-3-3M17 20l3-3" /></svg>`,
  due: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></svg>`,
} as const;

/** 按当前排序模式同步切换按钮的图标 / 按下态 / 提示文案 */
export function syncSortToggle(btn: HTMLButtonElement, mode: "manual" | "due"): void {
  btn.innerHTML = SORT_ICONS[mode];
  btn.setAttribute("aria-pressed", String(mode === "due"));
  btn.title =
    mode === "due" ? "排序：按截止时间，近的在前（点击切回手动）" : "排序：手动（点击改为按截止时间）";
}

/** 复合筛选同步：按当前视图态重建菜单选项、标记选中项并更新按钮文字 */
export function syncFilterMenu(
  button: HTMLButtonElement,
  menu: HTMLElement,
  view: View,
): void {
  const selected = view.status !== "all";

  const group = (label: string): HTMLElement => {
    const g = document.createElement("div");
    g.className = "filter-menu-group";
    g.textContent = label;
    return g;
  };
  const option = (value: Filter, label: string): HTMLElement => {
    const isSelected = view.status === value;
    const opt = document.createElement("div");
    opt.className = "filter-menu-option" + (isSelected ? " is-selected" : "");
    opt.setAttribute("role", "option");
    opt.setAttribute("aria-selected", String(isSelected));
    // listbox 漫游 tabindex：只有选中项（无选中则首项）可 Tab 进入，其余靠方向键导航
    opt.tabIndex = isSelected ? 0 : -1;
    opt.dataset.kind = "status";
    opt.dataset.value = value;
    opt.textContent = label;
    return opt;
  };

  menu.replaceChildren(
    group("状态"),
    option("today", STATUS_LABEL.today),
    option("soon", STATUS_LABEL.soon),
    option("active", STATUS_LABEL.active),
    option("completed", STATUS_LABEL.completed),
    option("deleted", STATUS_LABEL.deleted),
  );
  // 无激活筛选时首项可 Tab 进入
  if (!selected) {
    const first = menu.querySelector<HTMLElement>("[role='option']");
    if (first) first.tabIndex = 0;
  }

  button.querySelector<HTMLElement>(".filter-button-text")!.textContent = selected
    ? (STATUS_LABEL[view.status] ?? "全部待办")
    : "全部待办";
}

/**
 * 日期状态的友好文案：已过期 N 天 / 今天 / 明天；其余日期由原生控件呈现，不另加标签。
 * 已完成/已删除不显示。
 */
export function dueStatus(
  t: Todo,
  today: string = todayISO(),
): { label: string; kind: "overdue" | "today" | "tomorrow" } | null {
  if (!t.dueDate || t.completed || isDeleted(t)) return null;
  if (t.dueDate < today) {
    return { label: `已过期 ${daysBetween(today, t.dueDate)} 天`, kind: "overdue" };
  }
  if (t.dueDate === today) return { label: "今天", kind: "today" };
  if (t.dueDate === dateOffset(today, 1)) return { label: "明天", kind: "tomorrow" };
  return null;
}

/** 优先级旗标配色（滴答式：高红/中黄/低蓝；无优先级灰色） */
export const PRIORITY_COLORS: Record<Priority, string> = {
  high: "#ef4444",
  medium: "#f59e0b",
  low: "#3b82f6",
};

const PRIORITY_LABEL: Record<Priority, string> = { high: "高优先", medium: "中优先", low: "低优先" };

/** 优先级循环：点击旗标 高 → 中 → 低 → 无 → 高 */
export function nextPriority(p: Priority | undefined): Priority | undefined {
  return p === "high" ? "medium" : p === "medium" ? "low" : p === "low" ? undefined : "high";
}

/**
 * 截止时间排序键：date-only 视为当天 23:59（当天最后一刻到期）；
 * 字符串比较即时间先后（YYYY-MM-DDTHH:MM 字典序=时间序）。
 */
function dueSortKey(t: Todo): string | null {
  if (!t.dueDate) return null;
  return `${t.dueDate}T${t.dueTime ?? "23:59"}`;
}

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

function priorityRank(t: Todo): number {
  return t.priority ? PRIORITY_RANK[t.priority] : 3;
}

/**
 * 截止时间比较：近的在前。已过期（日期更早）自然排最前；
 * 同截止时刻时高优先级在前；无截止条目排在所有有截止条目之后，
 * 组内保持手动顺序（order 升序，回退 createdAt 降序）。
 */
export function compareByDue(a: Todo, b: Todo): number {
  const ka = dueSortKey(a);
  const kb = dueSortKey(b);
  if (ka && kb) {
    if (ka !== kb) return ka < kb ? -1 : 1;
    const pr = priorityRank(a) - priorityRank(b);
    if (pr !== 0) return pr;
    return 0;
  }
  if (ka) return -1;
  if (kb) return 1;
  const ao = a.order ?? Number.POSITIVE_INFINITY;
  const bo = b.order ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao - bo;
  return b.createdAt - a.createdAt;
}

/**
 * 按截止时间的视图排序：置顶未完成组 → 未完成组 → 已完成组，
 * 组内近截止在前（已完成沉底，避免过期已完成条目插队到待办前面）。
 */
export function sortTodosByDue(todos: Todo[]): Todo[] {
  const rank = (t: Todo): number => (t.completed ? 2 : t.pinned ? 0 : 1);
  return [...todos].sort((a, b) => {
    const r = rank(a) - rank(b);
    return r !== 0 ? r : compareByDue(a, b);
  });
}

export interface RenderOptions {
  /** 回收站模式：只显示文本 + 恢复按钮 */
  deleted?: boolean;
  /** 批量模式：勾选框替代完成按钮 */
  batch?: boolean;
  /** 批量模式已选 id 集合（渲染时勾选态以此为准） */
  selected?: Set<string>;
  /** 空状态装饰图标（emoji） */
  emptyIcon?: string;
  /** 按截止日期分组展示（「即将到期」视图）：插入 今天/明天/周X 组头 */
  groupByDue?: boolean;
}

/** 分组头文案：今天 / 明天 / M/D 周X */
export function dueGroupLabel(date: string, today: string = todayISO()): string {
  if (date === today) return "今天";
  if (date === dateOffset(today, 1)) return "明天";
  const [y, m, d] = date.split("-").map(Number);
  const wd = new Date(y, m - 1, d).getDay();
  return `${m}/${d} 周${"日一二三四五六"[wd]}`;
}

export function renderList(
  listEl: HTMLElement,
  todos: Todo[],
  emptyMessage: string,
  opts: RenderOptions = {},
): void {
  const empty = document.createElement("li");
  empty.className = "todo-empty";
  if (opts.emptyIcon) {
    const icon = document.createElement("span");
    icon.className = "todo-empty-icon";
    icon.textContent = opts.emptyIcon;
    icon.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "todo-empty-text";
    text.textContent = emptyMessage;
    empty.append(icon, text);
  } else {
    empty.textContent = emptyMessage;
  }

  if (todos.length === 0) {
    listEl.replaceChildren(empty);
    return;
  }

  // 「即将到期」视图按天分组：组内按截止时间升序，插入今天/明天/周X 组头
  if (opts.groupByDue) {
    const sorted = sortTodosByDue(todos);
    const today = todayISO();
    const fragment = document.createDocumentFragment();
    let lastDate: string | null = null;
    for (const todo of sorted) {
      const label = todo.dueDate ? dueGroupLabel(todo.dueDate, today) : "";
      if (todo.dueDate && label !== lastDate) {
        lastDate = label;
        const header = document.createElement("li");
        header.className = "group-header";
        header.textContent = label;
        header.setAttribute("role", "presentation");
        fragment.append(header);
      }
      fragment.append(renderTodoItem(todo, opts));
    }
    listEl.replaceChildren(fragment);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const todo of todos) {
    fragment.append(renderTodoItem(todo, opts));
  }
  listEl.replaceChildren(fragment);
}

/** 构建单条待办的 li：主行（勾选/文本/行动按钮）+ 元信息行（优先级/分类/日期/状态）+ 附加行（备注/子任务） */
function renderTodoItem(todo: Todo, opts: RenderOptions): HTMLElement {
  const li = document.createElement("li");
    // 过期标记（含当天到点）；置顶与回收站各有专属类名，样式由 style.css 定义
    li.className =
      `todo-item${todo.completed ? " is-done" : ""}${isOverdue(todo) ? " overdue" : ""}` +
      `${todo.pinned ? " is-pinned" : ""}${opts.deleted ? " is-deleted" : ""}`;
    li.dataset.id = todo.id;

    // 两行布局：第一行 主操作+文本+行动按钮，第二行 元信息控件（分类/时刻/日期/状态），
    // 第三行 备注/子任务——文本不再被控件挤压换行
    const main = document.createElement("div");
    main.className = "todo-main";

    if (opts.deleted) {
      const label = document.createElement("span");
      label.className = "todo-text";
      label.textContent = todo.text;

      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "todo-restore";
      restore.setAttribute("aria-label", "恢复");
      restore.textContent = "恢复";

      main.append(label, restore);
      li.append(main);
      return li;
    }

    // 批量模式：勾选框替代完成按钮
    if (opts.batch) {
      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "todo-check";
      check.setAttribute("aria-label", `选择：${todo.text}`);
      check.checked = opts.selected?.has(todo.id) ?? false;
      main.append(check);
    } else {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "todo-toggle";
      toggle.setAttribute("aria-label", todo.completed ? "标记为未完成" : "标记为已完成");
      toggle.textContent = "✓";
      main.append(toggle);
    }

    const label = document.createElement("span");
    label.className = "todo-text";
    label.textContent = todo.text;
    main.append(label);

    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = `todo-pin${todo.pinned ? " is-pinned" : ""}`;
    pin.setAttribute("aria-label", todo.pinned ? "取消置顶" : "置顶");
    pin.title = todo.pinned ? "取消置顶" : "置顶";
    pin.textContent = "★";

    const clone = document.createElement("button");
    clone.type = "button";
    clone.className = "todo-clone";
    clone.setAttribute("aria-label", "克隆待办");
    clone.title = "克隆";
    clone.textContent = "⧉";

    const del = document.createElement("button");
    del.type = "button";
    del.className = "todo-delete";
    del.setAttribute("aria-label", "删除");
    del.textContent = "✕";

    main.append(pin, clone, del);
    li.append(main);

    if (!opts.batch) {
      // 第二行：元信息控件（优先级/时刻/日期/状态），与文本左缘对齐
      const meta = document.createElement("div");
      meta.className = "todo-meta";

      // 优先级旗标：点击循环 高→中→低→无
      const prio = document.createElement("button");
      prio.type = "button";
      prio.className = "todo-priority" + (todo.priority ? " is-set" : "");
      if (todo.priority) {
        prio.style.color = PRIORITY_COLORS[todo.priority];
        prio.title = `${PRIORITY_LABEL[todo.priority]}（点击调整）`;
      } else {
        prio.title = "无优先级（点击设为高）";
      }
      prio.setAttribute("aria-label", "优先级");
      prio.textContent = "⚑";
      meta.append(prio);

      // 截止时刻：仅设置了截止日期时出现（时刻依赖日期才有意义）；空值收成时钟图标
      if (todo.dueDate) {
        const timeInput = document.createElement("input");
        timeInput.type = "time";
        timeInput.className = "todo-due-time";
        timeInput.setAttribute("aria-label", "截止时刻");
        timeInput.value = todo.dueTime ?? "";
        if (!todo.dueTime) timeInput.classList.add("is-empty");
        meta.append(timeInput);
      }

      const dueInput = document.createElement("input");
      dueInput.type = "date";
      dueInput.className = "todo-due";
      dueInput.setAttribute("aria-label", "截止日期");
      dueInput.value = todo.dueDate ?? ""; // 属性赋值不触发 change，无回写死循环
      if (!todo.dueDate) dueInput.classList.add("is-empty"); // 空值时 CSS 只显示日历图标
      meta.append(dueInput);

      // 友好日期状态：已过期 N 天 / 今天 / 明天（其余日期原生控件已可读，不重复）
      const status = dueStatus(todo);
      if (status) {
        const chip = document.createElement("span");
        chip.className = `due-chip is-${status.kind}`;
        chip.textContent = status.label;
        meta.append(chip);
      }

      if (todo.recurrence) {
        const repeat = document.createElement("span");
        repeat.className = "todo-repeat";
        repeat.title = `${recurrenceLabel(todo.recurrence)}重复`;
        repeat.textContent = "↻";
        meta.append(repeat);
      }

      li.append(meta);

      // 第三行：备注与子任务（无备注无子任务时仍给出「＋备注 / ＋子任务」入口）
      const extras = buildExtras(todo);
      if (extras) li.append(extras);
    }

    return li;
}

/** 备注与子任务附加区：两者都为空时按钮并排一行（不浪费纵向空间），否则竖排内容区 */
function buildExtras(todo: Todo): HTMLElement | null {
  if (!todo.notes && !todo.subtasks) {
    const actions = document.createElement("div");
    actions.className = "todo-extras is-actions";
    const addNotes = document.createElement("button");
    addNotes.type = "button";
    addNotes.className = "todo-notes-add";
    addNotes.textContent = "＋备注";
    const addSub = document.createElement("button");
    addSub.type = "button";
    addSub.className = "todo-sub-add";
    addSub.textContent = "＋子任务";
    actions.append(addNotes, addSub);
    return actions;
  }

  const extras = document.createElement("div");
  extras.className = "todo-extras";

  if (todo.notes) {
    const notes = document.createElement("span");
    notes.className = "todo-notes";
    notes.textContent = todo.notes;
    notes.title = "点击编辑备注";
    extras.append(notes);
  } else {
    const addNotes = document.createElement("button");
    addNotes.type = "button";
    addNotes.className = "todo-notes-add";
    addNotes.textContent = "＋备注";
    extras.append(addNotes);
  }

  if (todo.subtasks) {
    const doneCount = todo.subtasks.filter((s) => s.done).length;
    const chip = document.createElement("span");
    chip.className = "todo-subchip" + (doneCount === todo.subtasks.length ? " is-all-done" : "");
    chip.textContent = `${doneCount}/${todo.subtasks.length}`;
    chip.title = "子任务完成进度";
    extras.append(chip);

    const subList = document.createElement("div");
    subList.className = "todo-subtasks";
    for (const s of todo.subtasks) {
      const row = document.createElement("div");
      row.className = "todo-subtask" + (s.done ? " is-done" : "");
      row.dataset.subId = s.id;
      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "sub-check";
      check.checked = s.done;
      check.setAttribute("aria-label", `子任务：${s.text}`);
      const txt = document.createElement("span");
      txt.className = "sub-text";
      txt.textContent = s.text;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "sub-del";
      del.setAttribute("aria-label", `删除子任务：${s.text}`);
      del.textContent = "✕";
      row.append(check, txt, del);
      subList.append(row);
    }
    const addInput = document.createElement("input");
    addInput.type = "text";
    addInput.className = "sub-add";
    addInput.placeholder = "添加子任务，回车确认";
    addInput.maxLength = 200;
    addInput.setAttribute("aria-label", "添加子任务");
    subList.append(addInput);
    extras.append(subList);
  } else {
    const addSub = document.createElement("button");
    addSub.type = "button";
    addSub.className = "todo-sub-add";
    addSub.textContent = "＋子任务";
    extras.append(addSub);
  }

  return extras;
}
