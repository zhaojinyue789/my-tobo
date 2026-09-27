import {
  cleanPriority,
  createTodo,
  dateOffset,
  isValidDueDate,
  isValidDueTime,
  RECURRENCES,
  recurrenceLabel,
  todayISO,
  topOrder,
} from "./todo";
import { buildSelectOption } from "./ui";
import { parseNaturalLanguage, type NLResult } from "./nl-parse";
import { app, persist } from "./state";
import { notifyTodoOnce } from "./due-scan";

/**
 * 新建表单：主行只留输入框 + 添加按钮，日期/时刻/重复/优先级收进第二行选项区；
 * 聚焦输入框滑出（pointerdown 覆盖鼠标/触屏，focus 覆盖 Tab 键盘进入），提交后收起。
 */
export function setupNewTodo(form: HTMLFormElement, input: HTMLInputElement) {
  const formOptions = document.createElement("div");
  formOptions.id = "todo-form-options";
  formOptions.className = "todo-form-options";
  form.append(formOptions); // 放在提交按钮之后：主行永远是 输入框+添加，选项区独占第二行

  // 自然语言解析 chips：输入实时解析（明天3点/每周二/!高），Todoist 式预览将应用的字段
  const nlChips = document.createElement("div");
  nlChips.id = "nl-chips";
  nlChips.className = "nl-chips hidden";
  formOptions.before(nlChips);

  function chipDateLabel(date: string): string {
    const t = todayISO();
    if (date === t) return "今天";
    if (date === dateOffset(t, 1)) return "明天";
    return date.slice(5);
  }

  function renderChips(nl: NLResult | null): void {
    if (!nl) {
      nlChips.replaceChildren();
      nlChips.classList.add("hidden");
      return;
    }
    const parts: HTMLElement[] = [];
    if (nl.date) {
      const chip = document.createElement("span");
      chip.className = "nl-chip";
      chip.textContent = `📅 ${chipDateLabel(nl.date)}${nl.time ? " " + nl.time : ""}`;
      parts.push(chip);
    }
    if (nl.recurrence) {
      const chip = document.createElement("span");
      chip.className = "nl-chip";
      chip.textContent = `↻ ${recurrenceLabel(nl.recurrence)}`;
      parts.push(chip);
    }
    if (nl.priority) {
      const chip = document.createElement("span");
      chip.className = "nl-chip";
      chip.textContent = `⚑ ${nl.priority === "high" ? "高优先" : nl.priority === "medium" ? "中优先" : "低优先"}`;
      parts.push(chip);
    }
    nlChips.replaceChildren(...parts);
    nlChips.classList.toggle("hidden", parts.length === 0);
  }

  let nlTimer: ReturnType<typeof setTimeout> | undefined;
  let nl: NLResult | null = null;
  input.addEventListener("input", () => {
    clearTimeout(nlTimer);
    nlTimer = setTimeout(() => {
      const raw = input.value.trim();
      nl = raw ? parseNaturalLanguage(raw) : null;
      renderChips(nl);
    }, 120);
  });

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
    const rawText = input.value.trim();
    if (!rawText) return;
    // 自然语言解析：剥离出的片段作为字段应用，剩余为标题（无解析结果时整句为标题）
    nl = rawText ? parseNaturalLanguage(rawText) : null;
    const text = nl?.text || rawText;
    if (!text) return;
    const rawDue = newTodoDue.value;
    const rawTime = newTodoTime.value;
    const rawRepeat = newTodoRepeat.value;
    const todo = createTodo(text);
    if (isValidDueDate(rawDue)) todo.dueDate = rawDue;
    if (todo.dueDate && isValidDueTime(rawTime)) todo.dueTime = rawTime; // 时刻依赖日期才有意义
    if (rawRepeat === "daily" || rawRepeat === "weekly" || rawRepeat === "monthly") {
      todo.recurrence = rawRepeat;
    }
    todo.priority = cleanPriority(newTodoPriority.value);
    // NL 解析结果覆盖手动选择（更明确的表达）
    if (nl) {
      if (nl.date) todo.dueDate = nl.date;
      if (nl.time && todo.dueDate) todo.dueTime = nl.time;
      if (nl.recurrence) todo.recurrence = nl.recurrence;
      if (nl.priority) todo.priority = nl.priority;
    }
    todo.order = topOrder(app.todos); // 新条目置顶：order 取现存最小值减 1
    app.todos.unshift(todo);
    input.value = "";
    renderChips(null);
    nl = null;
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

  return {};
}
