import {
  cleanPriority,
  createTodo,
  dateOffset,
  isValidDueDate,
  isValidDueTime,
  normalizeCategory,
  RECURRENCES,
  todayISO,
  topOrder,
} from "./todo";
import { buildSelectOption, categoryOptions } from "./ui";
import { app, manualCategories, persist } from "./state";
import { notifyTodoOnce } from "./due-scan";

/**
 * 新建表单：主行只留输入框 + 添加按钮，分类/日期/时刻/重复收进第二行选项区；
 * 聚焦输入框滑出（pointerdown 覆盖鼠标/触屏，focus 覆盖 Tab 键盘进入），提交后收起。
 * 返回 syncNewTodoCategory 供每轮渲染同步分类下拉选项。
 */
export function setupNewTodo(form: HTMLFormElement, input: HTMLInputElement) {
  const formOptions = document.createElement("div");
  formOptions.id = "todo-form-options";
  formOptions.className = "todo-form-options";
  form.append(formOptions); // 放在提交按钮之后：主行永远是 输入框+添加，选项区独占第二行

  // 新增表单的分类选择器：选项每次渲染后同步更新
  const newTodoCategory = document.createElement("select");
  newTodoCategory.id = "new-todo-category";
  newTodoCategory.className = "new-todo-category";
  newTodoCategory.setAttribute("aria-label", "新待办的分类");
  formOptions.append(newTodoCategory);

  // 新增表单的截止日期：空值收成日历图标，与列表行内日期同款交互
  const newTodoDue = document.createElement("input");
  newTodoDue.type = "date";
  newTodoDue.id = "new-todo-due";
  newTodoDue.className = "todo-due new-todo-due is-empty";
  newTodoDue.setAttribute("aria-label", "新待办的截止日期");
  formOptions.append(newTodoDue);
  newTodoDue.addEventListener("change", () => {
    newTodoDue.classList.toggle("is-empty", !newTodoDue.value);
    newTodoTime.classList.toggle("hidden", !newTodoDue.value); // 时刻依赖日期才有意义
  });

  // 新增表单的截止时刻（默认隐藏，选了日期后出现）
  const newTodoTime = document.createElement("input");
  newTodoTime.type = "time";
  newTodoTime.id = "new-todo-time";
  newTodoTime.className = "new-todo-time hidden is-empty";
  newTodoTime.setAttribute("aria-label", "新待办的截止时刻");
  formOptions.append(newTodoTime);
  newTodoTime.addEventListener("change", () => {
    newTodoTime.classList.toggle("is-empty", !newTodoTime.value);
  });

  // 新增表单的重复规则
  const newTodoRepeat = document.createElement("select");
  newTodoRepeat.id = "new-todo-repeat";
  newTodoRepeat.className = "new-todo-repeat";
  newTodoRepeat.setAttribute("aria-label", "重复规则");
  newTodoRepeat.append(
    buildSelectOption("", "不重复"),
    ...RECURRENCES.map((r) =>
      buildSelectOption(r, r === "daily" ? "每天" : r === "weekly" ? "每周" : "每月"),
    ),
  );
  formOptions.append(newTodoRepeat);

  // 新增表单的优先级（默认无，每次提交后复位）
  const newTodoPriority = document.createElement("select");
  newTodoPriority.id = "new-todo-priority";
  newTodoPriority.className = "new-todo-priority";
  newTodoPriority.setAttribute("aria-label", "优先级");
  newTodoPriority.append(
    buildSelectOption("", "无优先"),
    buildSelectOption("high", "高优先"),
    buildSelectOption("medium", "中优先"),
    buildSelectOption("low", "低优先"),
  );
  formOptions.append(newTodoPriority);

  // 快捷日期：一键填充常用截止日（今天 / 明天 / 一周后）
  const quickDates = document.createElement("div");
  quickDates.className = "quick-dates";
  for (const [label, offset] of [
    ["今天", 0],
    ["明天", 1],
    ["一周", 7],
  ] as const) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "quick-date-btn";
    btn.textContent = label;
    btn.addEventListener("click", () => {
      newTodoDue.value = dateOffset(todayISO(), offset);
      newTodoDue.classList.remove("is-empty");
      newTodoTime.classList.remove("hidden"); // 时刻跟随日期出现
    });
    quickDates.append(btn);
  }
  formOptions.append(quickDates);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    // 极罕见竞态：选中的分类在提交前已消失（无引用且非手动新建）→ 降级为未分类，不丢待办
    const known = new Set([...categoryOptions(app.todos), ...manualCategories]);
    const rawCategory = newTodoCategory.value;
    const category =
      rawCategory && known.has(rawCategory) ? normalizeCategory(rawCategory) : undefined;
    const rawDue = newTodoDue.value;
    const rawTime = newTodoTime.value;
    const rawRepeat = newTodoRepeat.value;
    const todo = createTodo(text);
    if (category) todo.category = category; // createdAt = updatedAt = now 已由 createTodo 设定
    if (isValidDueDate(rawDue)) todo.dueDate = rawDue;
    if (todo.dueDate && isValidDueTime(rawTime)) todo.dueTime = rawTime; // 时刻依赖日期才有意义
    if (rawRepeat === "daily" || rawRepeat === "weekly" || rawRepeat === "monthly") {
      todo.recurrence = rawRepeat;
    }
    todo.priority = cleanPriority(newTodoPriority.value);
    todo.order = topOrder(app.todos); // 新条目置顶：order 取现存最小值减 1
    app.todos.unshift(todo);
    input.value = ""; // 分类下拉保留当前选中，便于连续录入同一分类
    newTodoDue.value = ""; // 日期/时刻每次清空：通常一条一个截止时间
    newTodoDue.classList.add("is-empty");
    newTodoTime.value = "";
    newTodoTime.classList.add("hidden"); // 时刻跟随日期隐藏
    newTodoRepeat.value = "";
    newTodoPriority.value = "";
    formOptions.classList.remove("open"); // 主行回归简洁：选项区提交后收起
    persist();
    // 即时到期检查：新建即带过期日期/时刻 → 立即通知并标记
    void notifyTodoOnce(todo);
  });

  // 部分内嵌浏览器不触发表单隐式提交，keydown 兜底；preventDefault 避免双重提交
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    form.requestSubmit();
  });

  // 聚焦输入框展开选项区；提交成功后收起（见 submit 处理器）
  input.addEventListener("pointerdown", () => formOptions.classList.add("open"));
  input.addEventListener("focus", () => formOptions.classList.add("open"));

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
      app.view.category !== "__all__" &&
      app.view.category !== "__uncat__" &&
      categories.includes(app.view.category)
        ? app.view.category
        : "";
    newTodoCategory.value = previous && categories.includes(previous) ? previous : fallback;
  }

  return { syncNewTodoCategory };
}
