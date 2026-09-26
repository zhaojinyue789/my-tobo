import { describe, expect, it } from "vitest";
import { applyFilter, STATUS_LABEL, type View } from "./ui";
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
