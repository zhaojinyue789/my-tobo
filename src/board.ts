import { dateOffset, isDeleted, recurrenceLabel, todayISO, type Todo } from "./todo";
import { app, persist, updateTodo } from "./state";
import { PRIORITY_COLORS } from "./ui";
import { attachCardDrag } from "./card-drag";

/** 看板列的到期分桶（列语义 = 拖入后的改期结果） */
export type Bucket = "none" | "overdue" | "today" | "tomorrow" | "later";

export function bucketOf(t: Todo, today: string = todayISO()): Bucket {
  if (!t.dueDate) return "none";
  if (t.dueDate < today) return "overdue";
  if (t.dueDate === today) return "today";
  if (t.dueDate === dateOffset(today, 1)) return "tomorrow";
  return "later";
}

const BUCKETS: { key: Bucket; label: string }[] = [
  { key: "overdue", label: "已过期" },
  { key: "today", label: "今天" },
  { key: "tomorrow", label: "明天" },
  { key: "later", label: "以后" },
  { key: "none", label: "无日期" },
];

/** 各列的拖入改期语义：落到该列 = 截止日期改为对应值（无日期 = 清空截止） */
function bucketDate(key: Bucket, today: string): string | undefined {
  if (key === "none") return undefined;
  if (key === "overdue") return dateOffset(today, -1);
  if (key === "today") return today;
  if (key === "tomorrow") return dateOffset(today, 1);
  return dateOffset(today, 7); // 以后 → 一周后，落位后可再微调
}

function compareCards(a: Todo, b: Todo): number {
  const ka = a.dueDate ?? "";
  const kb = b.dueDate ?? "";
  if (ka !== kb) return ka < kb ? -1 : 1;
  const ta = a.dueTime ?? "99:99";
  const tb = b.dueTime ?? "99:99";
  if (ta !== tb) return ta < tb ? -1 : 1;
  const ao = a.order ?? Number.POSITIVE_INFINITY;
  const bo = b.order ?? Number.POSITIVE_INFINITY;
  return ao - bo;
}

export interface BoardHooks {
  onComplete(id: string): void;
  onDelete(id: string): void;
  isActive(): boolean;
}

function renderCard(todo: Todo, today: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "kb-card" + (todo.priority ? ` prio-${todo.priority}` : "");
  card.dataset.cardId = todo.id;
  if (todo.dueDate && todo.dueDate < today) card.classList.add("is-overdue");

  const head = document.createElement("div");
  head.className = "kb-card-head";
  const flag = document.createElement("span");
  flag.className = "kb-flag" + (todo.priority ? " is-set" : "");
  if (todo.priority) flag.style.color = PRIORITY_COLORS[todo.priority];
  flag.textContent = "⚑";
  const actions = document.createElement("span");
  actions.className = "kb-card-actions";
  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "kb-btn";
  doneBtn.setAttribute("aria-label", "完成");
  doneBtn.textContent = "✓";
  doneBtn.dataset.act = "complete";
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "kb-btn";
  delBtn.setAttribute("aria-label", "删除");
  delBtn.textContent = "✕";
  delBtn.dataset.act = "delete";
  actions.append(doneBtn, delBtn);
  head.append(flag, actions);

  const text = document.createElement("div");
  text.className = "kb-card-text";
  text.textContent = todo.text;

  const meta = document.createElement("div");
  meta.className = "kb-card-meta";
  if (todo.dueDate) {
    const due = document.createElement("span");
    due.className = "kb-chip" + (todo.dueDate < today ? " is-overdue" : "");
    due.textContent = `${todo.dueDate.slice(5)}${todo.dueTime ? " " + todo.dueTime : ""}`;
    meta.append(due);
  }
  if (todo.recurrence) {
    const repeat = document.createElement("span");
    repeat.className = "kb-chip";
    repeat.title = `${recurrenceLabel(todo.recurrence)}重复`;
    repeat.textContent = "↻";
    meta.append(repeat);
  }
  if (todo.subtasks) {
    const done = todo.subtasks.filter((s) => s.done).length;
    const chip = document.createElement("span");
    chip.className = "kb-chip";
    chip.textContent = `☑ ${done}/${todo.subtasks.length}`;
    meta.append(chip);
  }
  if (todo.notes) {
    const chip = document.createElement("span");
    chip.className = "kb-chip";
    chip.title = todo.notes;
    chip.textContent = "📝";
    meta.append(chip);
  }

  card.append(head, text, meta);
  if (meta.children.length > 0) card.append(meta);
  return card;
}

/** 看板视图：列 = 到期分桶，跨列拖拽卡片 = 改截止日期；列内保持截止时间序 */
export function renderBoard(
  container: HTMLElement,
  todos: Todo[],
  hooks: { onComplete(id: string): void; onDelete(id: string): void; isActive(): boolean },
): void {
  const today = todayISO();
  const board = document.createElement("div");
  board.className = "board";

  for (const { key, label } of BUCKETS) {
    const col = document.createElement("div");
    col.className = "board-col";
    col.dataset.drop = key;
    const cards = todos
      .filter((t) => !isDeleted(t) && !t.completed && bucketOf(t, today) === key)
      .sort(compareCards);

    const colHead = document.createElement("div");
    colHead.className = "board-col-head";
    const count = document.createElement("span");
    count.className = "board-count" + (key === "overdue" && cards.length > 0 ? " is-warn" : "");
    count.textContent = String(cards.length);
    colHead.append(document.createTextNode(label), count);

    const colCards = document.createElement("div");
    colCards.className = "board-cards";
    for (const t of cards) colCards.append(renderCard(t, today));

    col.append(colHead, colCards);
    board.append(col);
  }

  container.replaceChildren(board);

  // 卡片点击（完成/删除）
  board.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!btn) return;
    const card = btn.closest<HTMLElement>("[data-card-id]");
    if (!card) return;
    const id = card.dataset.cardId!;
    if (btn.dataset.act === "complete") hooks.onComplete(id);
    else if (btn.dataset.act === "delete") hooks.onDelete(id);
  });

  // 跨列拖拽 = 改截止日期
  attachCardDrag(board, {
    isActive: () => hooks.isActive(),
    canDrag: (el) => {
      const card = el.closest<HTMLElement>(".kb-card");
      return card?.dataset.cardId ? { id: card.dataset.cardId } : null;
    },
    onStart: () => {},
    onMove: (_id, x, y) => {
      const under = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]");
      board.querySelectorAll("[data-drop]").forEach((el) => {
        el.classList.toggle("drop-target", el === under);
      });
    },
    onDrop: (id, x, y) => {
      board.querySelectorAll("[data-drop]").forEach((el) => el.classList.remove("drop-target"));
      const under = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]");
      if (!under) return;
      const target = under.dataset.drop as Bucket;
      const todo = app.todos.find((t) => t.id === id);
      if (!todo || bucketOf(todo, today) === target) return; // 同列放置 = 无变化
      updateTodo(id, { dueDate: bucketDate(target, today) });
      persist();
    },
    onCancel: () => {
      board.querySelectorAll("[data-drop]").forEach((el) => el.classList.remove("drop-target"));
    },
  });
}
