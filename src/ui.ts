import { deletedRecently, isDeleted, isOverdue, type Todo } from "./todo";

export type Filter = "all" | "active" | "completed" | "deleted";

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
 * 契约：纯函数；"deleted" 视图只看保留期内的墓碑（回收站）；其余视图已删条目恒不可见；
 * 不改数据、不写存储、不触发同步。复杂度 O(N)。
 */
export function applyFilter(todos: Todo[], v: View): Todo[] {
  if (v.status === "deleted") return todos.filter(deletedRecently);
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
  /** 复合筛选按钮：文字显示当前生效筛选，点击开合菜单 */
  filterButton: HTMLButtonElement;
  /** 复合筛选菜单（选项每次 render 由 syncFilterMenu 重建） */
  filterMenu: HTMLElement;
  /** 文本搜索框（实时过滤当前视图） */
  searchInput: HTMLInputElement;
  newCategoryInput: HTMLInputElement;
  addCategoryBtn: HTMLButtonElement;
  /** 新建分类的反馈行（空值/重复/成功提示） */
  categoryHint: HTMLElement;
}

/** 顶部工具栏：复合筛选 + 「新建分类」行内编辑；构建后插在列表容器之前 */
export function buildToolbar(before: HTMLElement): ToolbarRefs {
  const root = document.createElement("div");
  root.id = "toolbar";
  root.className = "toolbar";

  // 筛选行：复合筛选按钮（分类/状态二选一）+ 右侧「+ 新建分类」触发器
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

  // 文本搜索：实时过滤当前视图（Ctrl+F 聚焦由 main.ts 绑定）
  const searchInput = document.createElement("input");
  searchInput.id = "todo-search";
  searchInput.className = "search-input";
  searchInput.type = "search";
  searchInput.placeholder = "搜索待办…";
  searchInput.maxLength = 50;
  searchInput.setAttribute("aria-label", "搜索待办");

  // 「+ 新建分类」触发器：链接样式常驻筛选行右侧，默认收起不占行
  const trigger = document.createElement("button");
  trigger.className = "cat-trigger";
  trigger.type = "button";
  trigger.textContent = "新建分类";
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", "cat-editor");

  const categoryHint = document.createElement("span");
  categoryHint.id = "category-hint";
  categoryHint.className = "category-hint hidden";
  categoryHint.setAttribute("role", "status");
  // 提示放在筛选行内而非编辑区里：编辑区自动收起后「已添加」仍可见
  filters.append(filterWrap, searchInput, trigger, categoryHint);

  // 行内编辑区：默认收起（0 高度），点击触发器后在下方滑出输入框 + 确定按钮
  const editorWrap = document.createElement("div");
  editorWrap.className = "cat-editor-wrap";
  editorWrap.id = "cat-editor";

  const editor = document.createElement("div");
  editor.className = "cat-editor";
  const editorInner = document.createElement("div");
  editorInner.className = "cat-editor-inner";

  const newCategoryInput = document.createElement("input");
  newCategoryInput.id = "new-category";
  newCategoryInput.className = "new-category";
  newCategoryInput.type = "text";
  newCategoryInput.maxLength = 20;
  newCategoryInput.placeholder = "输入分类名，如：工作";

  const addCategoryBtn = document.createElement("button");
  addCategoryBtn.id = "add-category";
  addCategoryBtn.className = "btn btn-secondary";
  addCategoryBtn.type = "button";
  addCategoryBtn.textContent = "确定";

  editorInner.append(newCategoryInput, addCategoryBtn);
  editor.append(editorInner);
  editorWrap.append(editor);

  // 展开/收起：展开时聚焦输入框
  const setCatOpen = (open: boolean): void => {
    editorWrap.classList.toggle("open", open);
    trigger.setAttribute("aria-expanded", String(open));
    if (open) newCategoryInput.focus();
  };
  trigger.addEventListener("click", () => setCatOpen(!editorWrap.classList.contains("open")));

  // 点击触发器与编辑区以外的任意位置收起
  document.addEventListener("click", (e) => {
    const target = e.target as Node;
    if (editorWrap.contains(target) || trigger.contains(target)) return;
    if (editorWrap.classList.contains("open")) setCatOpen(false);
  });

  // Esc 收起；Enter 等同点击确定（复用主逻辑的校验与添加）
  newCategoryInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return setCatOpen(false);
    if (e.key !== "Enter") return;
    e.preventDefault();
    addCategoryBtn.click();
  });

  // 成功添加的标志：主逻辑把「非空输入」清空了（校验失败会保留原内容并提示）；
  // 延迟到主逻辑处理完再对比，成功则自动收起，空值/失败保持展开
  addCategoryBtn.addEventListener("click", () => {
    const before = newCategoryInput.value;
    setTimeout(() => {
      if (before && !newCategoryInput.value) setCatOpen(false);
    }, 0);
  });

  root.append(filters, editorWrap);
  before.before(root);
  return { root, filterButton, filterMenu, searchInput, newCategoryInput, addCategoryBtn, categoryHint };
}

/** 复合筛选同步：按当前视图态重建菜单选项、标记选中项并更新按钮文字 */
export function syncFilterMenu(
  button: HTMLButtonElement,
  menu: HTMLElement,
  categories: string[],
  view: View,
): void {
  // 当前生效筛选（复合 UI 一次只激活一个维度，状态优先展示）
  let activeKind: "category" | "status" | null = null;
  let activeValue = "";
  if (view.status !== "all") {
    activeKind = "status";
    activeValue = view.status;
  } else if (view.category !== "__all__") {
    activeKind = "category";
    activeValue = view.category;
  }

  const group = (label: string): HTMLElement => {
    const g = document.createElement("div");
    g.className = "filter-menu-group";
    g.textContent = label;
    return g;
  };
  const option = (kind: "category" | "status", value: string, label: string): HTMLElement => {
    const selected = activeKind === kind && activeValue === value;
    const opt = document.createElement("div");
    opt.className = "filter-menu-option" + (selected ? " is-selected" : "");
    opt.setAttribute("role", "option");
    opt.setAttribute("aria-selected", String(selected));
    opt.tabIndex = 0;
    opt.dataset.kind = kind;
    opt.dataset.value = value;
    opt.textContent = label;
    return opt;
  };

  menu.replaceChildren(
    group("分类"),
    option("category", "__uncat__", "未分类"),
    ...categories.map((name) => option("category", name, name)),
    group("状态"),
    option("status", "active", "未完成"),
    option("status", "completed", "已完成"),
    option("status", "deleted", "最近删除"),
  );

  const text = button.querySelector<HTMLElement>(".filter-button-text")!;
  text.textContent =
    activeKind === "category"
      ? activeValue === "__uncat__"
        ? "未分类"
        : activeValue
      : activeKind === "status"
        ? activeValue === "active"
          ? "未完成"
          : activeValue === "completed"
            ? "已完成"
            : "最近删除"
        : "全部待办";
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

const REPEAT_LABEL: Record<string, string> = { daily: "每天", weekly: "每周", monthly: "每月" };

export interface RenderOptions {
  /** 回收站模式：只显示文本 + 恢复按钮 */
  deleted?: boolean;
  /** 批量模式：勾选框替代完成按钮 */
  batch?: boolean;
  /** 批量模式已选 id 集合（渲染时勾选态以此为准） */
  selected?: Set<string>;
}

export function renderList(
  listEl: HTMLElement,
  todos: Todo[],
  emptyMessage: string,
  categories: string[] = [],
  opts: RenderOptions = {},
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
    // 过期标记（含当天到点）；置顶与回收站各有专属类名，样式由 style.css 定义
    li.className =
      `todo-item${todo.completed ? " is-done" : ""}${isOverdue(todo) ? " overdue" : ""}` +
      `${todo.pinned ? " is-pinned" : ""}${opts.deleted ? " is-deleted" : ""}`;
    li.dataset.id = todo.id;

    if (opts.deleted) {
      const label = document.createElement("span");
      label.className = "todo-text";
      label.textContent = todo.text;

      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "todo-restore";
      restore.setAttribute("aria-label", "恢复");
      restore.textContent = "恢复";

      li.append(label, restore);
      fragment.append(li);
      continue;
    }

    // 批量模式：勾选框替代完成按钮
    if (opts.batch) {
      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "todo-check";
      check.setAttribute("aria-label", "选择");
      check.checked = opts.selected?.has(todo.id) ?? false;
      li.append(check);
    } else {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "todo-toggle";
      toggle.setAttribute("aria-label", todo.completed ? "标记为未完成" : "标记为已完成");
      toggle.textContent = "✓";
      li.append(toggle);
    }

    const label = document.createElement("span");
    label.className = "todo-text";
    label.textContent = todo.text;

    const categorySelect = buildCategorySelect(todo, categories);

    // 截止时刻：仅设置了截止日期时出现（时刻依赖日期才有意义）
    let timeInput: HTMLInputElement | null = null;
    if (todo.dueDate) {
      timeInput = document.createElement("input");
      timeInput.type = "time";
      timeInput.className = "todo-due-time";
      timeInput.setAttribute("aria-label", "截止时刻");
      timeInput.value = todo.dueTime ?? "";
    }

    const dueInput = document.createElement("input");
    dueInput.type = "date";
    dueInput.className = "todo-due";
    dueInput.setAttribute("aria-label", "截止日期");
    dueInput.value = todo.dueDate ?? ""; // 属性赋值不触发 change，无回写死循环
    if (!todo.dueDate) dueInput.classList.add("is-empty"); // 空值时 CSS 只显示日历图标

    const meta = document.createElement("div");
    meta.className = "todo-meta";
    meta.append(categorySelect);
    if (timeInput) meta.append(timeInput);
    meta.append(dueInput);
    if (todo.recurrence) {
      const repeat = document.createElement("span");
      repeat.className = "todo-repeat";
      repeat.title = `${REPEAT_LABEL[todo.recurrence] ?? todo.recurrence}重复`;
      repeat.textContent = "↻";
      meta.append(repeat);
    }

    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = `todo-pin${todo.pinned ? " is-pinned" : ""}`;
    pin.setAttribute("aria-label", todo.pinned ? "取消置顶" : "置顶");
    pin.title = todo.pinned ? "取消置顶" : "置顶";
    pin.textContent = "★";

    const del = document.createElement("button");
    del.type = "button";
    del.className = "todo-delete";
    del.setAttribute("aria-label", "删除");
    del.textContent = "✕";

    li.append(label, meta, pin, del);
    fragment.append(li);
  }
  listEl.replaceChildren(fragment);
}
