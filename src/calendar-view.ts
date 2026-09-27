import { isDeleted, todayISO, type Todo } from "./todo";
import { app, persist, updateTodo } from "./state";
import { PRIORITY_COLORS } from "./ui";
import { attachCardDrag } from "./card-drag";

/** 月视图状态（模块级：切换视图往返时保留月份位置） */
let calYear: number | null = null;
let calMonth: number | null = null; // 0-based

function ensureMonth(today: string): void {
  if (calYear !== null && calMonth !== null) return;
  const [y, m] = today.split("-").map(Number);
  calYear = y;
  calMonth = m - 1;
}

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"]; // 周一开头

export interface CalendarHooks {
  onComplete(id: string): void;
  onDelete(id: string): void;
  /** 点日期空白：把该日期填进新建表单（快速排程入口） */
  onPickDate(date: string): void;
  isActive(): boolean;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 渲染日历月视图：任务 chip 可拖拽到任意日期格改期；点日期空白 = 预填新建日期 */
export function renderCalendar(
  container: HTMLElement,
  todos: Todo[],
  hooks: CalendarHooks,
): void {
  const today = todayISO();
  ensureMonth(today);
  const year = calYear as number;
  const month = calMonth as number;

  const dated = todos
    .filter((t) => !isDeleted(t) && !t.completed && t.dueDate)
    .sort((a, b) =>
      (a.dueDate + (a.dueTime ?? "")) < (b.dueDate + (b.dueTime ?? "")) ? -1 : 1,
    );
  const byDate = new Map<string, Todo[]>();
  for (const t of dated) {
    const list = byDate.get(t.dueDate as string) ?? [];
    list.push(t);
    byDate.set(t.dueDate as string, list);
  }

  const root = document.createElement("div");
  root.className = "cal";

  // 标题与导航
  const head = document.createElement("div");
  head.className = "cal-head";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "cal-nav";
  prev.textContent = "‹";
  prev.setAttribute("aria-label", "上个月");
  const title = document.createElement("span");
  title.className = "cal-title";
  title.textContent = `${year} 年 ${month + 1} 月`;
  const todayBtn = document.createElement("button");
  todayBtn.type = "button";
  todayBtn.className = "cal-nav cal-today";
  todayBtn.textContent = "今天";
  const next = document.createElement("button");
  next.type = "button";
  next.className = "cal-nav";
  next.textContent = "›";
  next.setAttribute("aria-label", "下个月");
  head.append(prev, title, next, todayBtn);

  // 星期表头（周一开头）
  const gridHead = document.createElement("div");
  gridHead.className = "cal-grid cal-grid-head";
  for (const w of WEEKDAYS) {
    const cell = document.createElement("div");
    cell.className = "cal-weekday";
    cell.textContent = w;
    gridHead.append(cell);
  }

  // 日期格：6 行 × 7 列
  const firstDow = new Date(year, month, 1).getDay();
  const gridStartOffset = (firstDow + 6) % 7; // 距周一的偏移
  const grid = document.createElement("div");
  grid.className = "cal-grid cal-grid-body";

  const makeCell = (date: string, dayNum: number, inMonth: boolean): HTMLElement => {
    const cell = document.createElement("div");
    cell.className = "cal-cell";
    cell.dataset.calDate = date;
    if (date === today) cell.classList.add("is-today");
    if (!inMonth) cell.classList.add("is-outside");

    const num = document.createElement("span");
    num.className = "cal-daynum";
    num.textContent = String(dayNum);
    cell.append(num);

    const list = byDate.get(date) ?? [];
    list.slice(0, 3).forEach((t) => {
      const chip = document.createElement("div");
      chip.className = "cal-chip";
      chip.dataset.cardId = t.id;
      if (t.priority) chip.style.borderColor = PRIORITY_COLORS[t.priority];
      if (date < today) chip.classList.add("is-overdue");
      const flag = t.priority ? "⚑ " : "";
      const time = t.dueTime ? `${t.dueTime} ` : "";
      chip.textContent = `${flag}${time}${t.text}`;
      chip.title = t.text;
      cell.append(chip);
    });
    if (list.length > 3) {
      const more = document.createElement("span");
      more.className = "cal-more";
      more.textContent = `+${list.length - 3}`;
      cell.append(more);
    }
    return cell;
  };

  for (let i = 0; i < 42; i++) {
    const dayDate = new Date(year, month, 1 - gridStartOffset + i);
    const date = `${dayDate.getFullYear()}-${pad2(dayDate.getMonth() + 1)}-${pad2(dayDate.getDate())}`;
    const inMonth = dayDate.getMonth() === month;
    grid.append(makeCell(date, dayDate.getDate(), inMonth));
  }

  root.append(head, gridHead, grid);
  container.replaceChildren(root);

  const rerender = (): void => renderCalendar(container, todos, hooks);

  // 月份导航
  head.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[class^='cal-nav']");
    if (!btn) return;
    if (btn === prev) {
      calMonth = (calMonth as number) - 1;
      if ((calMonth as number) < 0) {
        calMonth = 11;
        calYear = (calYear as number) - 1;
      }
    } else if (btn === next) {
      calMonth = (calMonth as number) + 1;
      if ((calMonth as number) > 11) {
        calMonth = 0;
        calYear = (calYear as number) + 1;
      }
    } else if (btn === todayBtn) {
      const [y, m] = today.split("-").map(Number);
      calYear = y;
      calMonth = m - 1;
    }
    rerender();
  });

  // 点日期空白：预填新建日期（点在 chip 上不触发）
  grid.addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest(".cal-chip");
    if (chip) return;
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-cal-date]");
    if (!cell) return;
    if (cell.dataset.calDate) hooks.onPickDate(cell.dataset.calDate);
  });

  // 拖拽改期：chip 拖到任意日期格
  attachCardDrag(grid, {
    isActive: () => hooks.isActive(),
    canDrag: (el) => {
      const chip = el.closest<HTMLElement>(".cal-chip");
      return chip?.dataset.cardId ? { id: chip.dataset.cardId } : null;
    },
    onStart: () => {},
    onMove: (_id, x, y) => {
      const under = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-cal-date]");
      grid.querySelectorAll("[data-cal-date]").forEach((el) => {
        el.classList.toggle("drop-target", el === under);
      });
    },
    onDrop: (id, x, y) => {
      grid.querySelectorAll("[data-cal-date]").forEach((el) => el.classList.remove("drop-target"));
      const under = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-cal-date]");
      if (!under) return;
      const date = under.dataset.calDate;
      const todo = app.todos.find((t) => t.id === id);
      if (!date || !todo || todo.dueDate === date) return;
      updateTodo(id, { dueDate: date });
      persist();
    },
    onCancel: () => {
      grid.querySelectorAll("[data-cal-date]").forEach((el) => el.classList.remove("drop-target"));
    },
  });
}
