import { isDeleted, isOverdue, type Todo } from "./todo";

export type Filter = "all" | "active" | "completed";

/** 分类筛选值：__all__=全部、__uncat__=未分类，其余为具体分类名（已归一化） */
export type CategoryFilter = "__all__" | "__uncat__" | string;

/** 视图态：纯渲染层状态，与数据无关，不写存储、不触发同步 */
export type View = { category: CategoryFilter; status: Filter };

export function filterTodos(todos: Todo[], filter: Filter): Todo[] {
  // 已删除（墓碑未过期）的项不参与展示
  const live = todos.filter((t) => !isDeleted(t));
  if (filter === "active") return live.filter((t) => !t.completed);
  if (filter === "completed") return live.filter((t) => t.completed);
  return live;
}

/**
 * 视图过滤：输入全量列表（含墓碑），输出当前视图可见条目（保持原顺序）。
 * 契约：纯函数；已删条目恒不可见；不改数据、不写存储、不触发同步。
 * 复杂度 O(N)：复用 filterTodos 做状态过滤，再做一次分类过滤。
 */
export function applyFilter(todos: Todo[], v: View): Todo[] {
  const live = filterTodos(todos, v.status);
  if (v.category === "__all__") return live;
  if (v.category === "__uncat__") return live.filter((t) => t.category == null);
  return live.filter((t) => t.category === v.category);
}

/**
 * 分类候选集：从现存有效条目派生（已删不计入），去重后按 zh 排序。
 * 纯函数，O(N) 派生 + O(K log K) 排序（K = 去重后分类数 ≤ N）。
 */
export function categoryOptions(todos: Todo[]): string[] {
  const set = new Set<string>();
  for (const t of todos) {
    if (!isDeleted(t) && t.category) set.add(t.category);
  }
  return [...set].sort((a, b) => a.localeCompare(b, "zh"));
}

export function buildSelectOption(value: string, label: string): HTMLOptionElement {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  return opt;
}

export interface ToolbarRefs {
  root: HTMLElement;
  /** 分类筛选下拉（选项由 render 每次同步） */
  filterCategory: HTMLSelectElement;
  /** 状态筛选下拉：全部/未完成/已完成（复用既有 Filter 语义） */
  filterStatus: HTMLSelectElement;
  newCategoryInput: HTMLInputElement;
  addCategoryBtn: HTMLButtonElement;
  /** 新建分类的反馈行（空值/重复/成功提示） */
  categoryHint: HTMLElement;
}

/** 顶部工具栏：构建后插在列表容器之前 */
export function buildToolbar(before: HTMLElement): ToolbarRefs {
  const root = document.createElement("div");
  root.id = "toolbar";
  root.className = "toolbar";

  const filterCategory = document.createElement("select");
  filterCategory.id = "filter-category";
  filterCategory.className = "filter-select";
  filterCategory.setAttribute("aria-label", "按分类筛选");

  const filterStatus = document.createElement("select");
  filterStatus.id = "filter-status";
  filterStatus.className = "filter-select";
  filterStatus.setAttribute("aria-label", "按状态筛选");
  filterStatus.append(
    buildSelectOption("all", "全部"),
    buildSelectOption("active", "未完成"),
    buildSelectOption("completed", "已完成"),
  );

  const newCategoryInput = document.createElement("input");
  newCategoryInput.id = "new-category";
  newCategoryInput.className = "new-category";
  newCategoryInput.type = "text";
  newCategoryInput.maxLength = 20;
  newCategoryInput.placeholder = "新建分类";

  const addCategoryBtn = document.createElement("button");
  addCategoryBtn.id = "add-category";
  addCategoryBtn.className = "add-category";
  addCategoryBtn.type = "button";
  addCategoryBtn.textContent = "添加分类";

  const categoryHint = document.createElement("span");
  categoryHint.id = "category-hint";
  categoryHint.className = "category-hint hidden";
  categoryHint.setAttribute("role", "status");

  root.append(filterCategory, filterStatus, newCategoryInput, addCategoryBtn, categoryHint);
  before.before(root);
  return { root, filterCategory, filterStatus, newCategoryInput, addCategoryBtn, categoryHint };
}

/** 单条待办的分类下拉：未分类 + 全部现有分类；存量脏值防御性兜底显示 */
function buildCategorySelect(todo: Todo, categories: string[]): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "todo-category";
  select.setAttribute("aria-label", "分类");
  select.append(buildSelectOption("__uncat__", "未分类"));
  for (const name of categories) select.append(buildSelectOption(name, name));
  if (todo.category && !categories.includes(todo.category)) {
    select.append(buildSelectOption(todo.category, todo.category));
  }
  select.value = todo.category ?? "__uncat__";
  return select;
}

export function renderList(
  listEl: HTMLElement,
  todos: Todo[],
  emptyMessage: string,
  categories: string[] = [],
): void {
  const empty = document.createElement("li");
  empty.className = "todo-empty";
  empty.textContent = emptyMessage;

  if (todos.length === 0) {
    listEl.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const todo of todos) {
    const li = document.createElement("li");
    // 过期标记：仅 未完成+未删除+dueDate<今天；当天不算过期（isOverdue 保证）。样式由 style.css 另行定义
    li.className = `todo-item${todo.completed ? " is-done" : ""}${isOverdue(todo) ? " overdue" : ""}`;
    li.dataset.id = todo.id;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "todo-toggle";
    toggle.setAttribute(
      "aria-label",
      todo.completed ? "标记为未完成" : "标记为已完成",
    );
    toggle.textContent = "✓";

    const label = document.createElement("span");
    label.className = "todo-text";
    label.textContent = todo.text;

    const categorySelect = buildCategorySelect(todo, categories);

    const dueInput = document.createElement("input");
    dueInput.type = "date";
    dueInput.className = "todo-due";
    dueInput.setAttribute("aria-label", "截止日期");
    dueInput.value = todo.dueDate ?? ""; // 属性赋值不触发 change，无回写死循环

    const del = document.createElement("button");
    del.type = "button";
    del.className = "todo-delete";
    del.setAttribute("aria-label", "删除");
    del.textContent = "✕";

    li.append(toggle, label, categorySelect, dueInput, del);
    fragment.append(li);
  }
  listEl.replaceChildren(fragment);
}
