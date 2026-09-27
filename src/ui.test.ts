import { describe, expect, it } from "vitest";
import { applyFilter, compareByDue, dueStatus, sortTodosByDue, STATUS_LABEL, type View } from "./ui";
import type { Todo } from "./todo";

const t = (over: Partial<Todo> = {}): Todo => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  text: over.text ?? "x",
  completed: over.completed ?? false,
  createdAt: over.createdAt ?? 1000,
  updatedAt: over.updatedAt ?? 1000,
  ...over,
});

const view = (status: View["status"], category: View["category"] = "__all__"): View => ({
  status,
  category,
});

describe("applyFilter：智能视图（today/soon）", () => {
  const today = "2026-09-27";
  const todos: Todo[] = [
    t({ id: "overdue", dueDate: "2026-09-25" }),
    t({ id: "due-today", dueDate: "2026-09-27" }),
    t({ id: "due-soon", dueDate: "2026-10-01" }),
    t({ id: "far", dueDate: "2026-10-20" }),
    t({ id: "done", dueDate: "2026-09-25", completed: true }),
    t({ id: "deleted", dueDate: "2026-09-25", deletedAt: Date.now() }),
    t({ id: "nodue" }),
  ];

  it("今天到期 = 过期 + 当天（不含已完成/已删除/无日期）", () => {
    expect(applyFilter(todos, view("today"), today).map((x) => x.id)).toEqual([
      "overdue",
      "due-today",
    ]);
  });
  it("即将到期 = 明天起 7 天内", () => {
    expect(applyFilter(todos, view("soon"), today).map((x) => x.id)).toEqual(["due-soon"]);
  });
  it("智能视图可与分类筛选叠加", () => {
    const cats = todos.map((x) =>
      x.id === "overdue" ? { ...x, category: "工作" } : { ...x, category: undefined },
    );
    expect(applyFilter(cats, view("today", "工作"), today).map((x) => x.id)).toEqual(["overdue"]);
    expect(applyFilter(cats, view("today", "__uncat__"), today).map((x) => x.id)).toEqual([
      "due-today",
    ]);
  });
  it("状态筛选展示名覆盖全部 Filter 值", () => {
    for (const f of ["all", "active", "completed", "deleted", "today", "soon"] as const) {
      expect(STATUS_LABEL[f]).toBeTruthy();
    }
  });
});

describe("dueStatus（友好日期状态）", () => {
  const today = "2026-09-27";
  it("过期显示天数，今天/明天单独标记，其余为 null", () => {
    expect(dueStatus({ ...t(), dueDate: "2026-09-25" }, today)).toEqual({
      label: "已过期 2 天",
      kind: "overdue",
    });
    expect(dueStatus({ ...t(), dueDate: "2026-09-27" }, today)).toEqual({ label: "今天", kind: "today" });
    expect(dueStatus({ ...t(), dueDate: "2026-09-28" }, today)).toEqual({
      label: "明天",
      kind: "tomorrow",
    });
    expect(dueStatus({ ...t(), dueDate: "2026-10-10" }, today)).toBeNull();
  });
  it("已完成/已删除/无日期不显示", () => {
    expect(dueStatus({ ...t(), dueDate: "2026-09-25", completed: true }, today)).toBeNull();
    expect(dueStatus({ ...t(), dueDate: "2026-09-25", deletedAt: 1 }, today)).toBeNull();
    expect(dueStatus({ ...t() }, today)).toBeNull();
  });
});

describe("compareByDue / sortTodosByDue（截止时间排序）", () => {
  const t = (over: Partial<Todo> = {}): Todo => ({
    id: over.id ?? Math.random().toString(36).slice(2),
    text: over.text ?? "x",
    completed: over.completed ?? false,
    createdAt: over.createdAt ?? 1000,
    updatedAt: over.updatedAt ?? 1000,
    ...over,
  });

  it("带时刻的条目按 (日期, 时刻) 升序，过期自然最前", () => {
    const a = t({ id: "today-18", dueDate: "2026-09-27", dueTime: "18:00" });
    const b = t({ id: "today-09", dueDate: "2026-09-27", dueTime: "09:00" });
    const c = t({ id: "yesterday", dueDate: "2026-09-26", dueTime: "23:00" });
    const d = t({ id: "tomorrow", dueDate: "2026-09-28", dueTime: "09:00" });
    expect([a, b, c, d].sort(compareByDue).map((x) => x.id)).toEqual([
      "yesterday",
      "today-09",
      "today-18",
      "tomorrow",
    ]);
  });

  it("date-only 视为当天 23:59，晚于当天有时刻的条目", () => {
    const timed = t({ id: "timed", dueDate: "2026-09-27", dueTime: "09:00" });
    const dateOnly = t({ id: "date-only", dueDate: "2026-09-27" });
    expect([dateOnly, timed].sort(compareByDue).map((x) => x.id)).toEqual(["timed", "date-only"]);
  });

  it("无截止条目排在有截止之后，组内保持手动顺序（order）", () => {
    const dated = t({ id: "dated", dueDate: "2026-09-27" });
    const plain1 = t({ id: "plain-1", order: 5 });
    const plain2 = t({ id: "plain-2", order: 2 });
    expect([plain1, dated, plain2].sort(compareByDue).map((x) => x.id)).toEqual([
      "dated",
      "plain-2",
      "plain-1",
    ]);
  });

  it("视图排序：置顶组在前、已完成沉底，组内近截止在前", () => {
    const todos = [
      t({ id: "done-old", completed: true, dueDate: "2026-09-25" }),
      t({ id: "normal-tomorrow", dueDate: "2026-09-28" }),
      t({ id: "done-today", completed: true, dueDate: "2026-09-27" }),
      t({ id: "normal-today", dueDate: "2026-09-27", dueTime: "17:00" }),
      t({ id: "pinned-late", pinned: true, dueDate: "2026-09-30" }),
      t({ id: "undated", order: 1 }),
    ];
    expect(sortTodosByDue(todos).map((x) => x.id)).toEqual([
      "pinned-late",
      "normal-today",
      "normal-tomorrow",
      "undated",
      "done-old",
      "done-today",
    ]);
  });
});

describe("applyFilter：原有视图回归", () => {
  const todos: Todo[] = [
    t({ id: "a", completed: false }),
    t({ id: "b", completed: true }),
    t({ id: "c", deletedAt: Date.now() }),
  ];
  it("all/active/completed 排除墓碑", () => {
    expect(applyFilter(todos, view("all")).map((x) => x.id)).toEqual(["a", "b"]);
    expect(applyFilter(todos, view("active")).map((x) => x.id)).toEqual(["a"]);
    expect(applyFilter(todos, view("completed")).map((x) => x.id)).toEqual(["b"]);
  });
  it("deleted 只看保留期内墓碑", () => {
    expect(applyFilter(todos, view("deleted")).map((x) => x.id)).toEqual(["c"]);
  });
});
