import { describe, expect, it } from "vitest";
import { computeStats } from "./stats";
import type { Todo } from "./todo";

const t = (over: Partial<Todo> = {}): Todo => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  text: over.text ?? "x",
  completed: over.completed ?? false,
  createdAt: over.createdAt ?? 1000,
  updatedAt: over.updatedAt ?? 1000,
  ...over,
});

describe("computeStats", () => {
  const today = "2026-09-27";
  const at = (dayOffset: number, hour = 12): number =>
    new Date(2026, 8, 27 + dayOffset, hour).getTime(); // 本地时区 2026-09-27 ± N 天

  it("概览计数：墓碑不计入，过期/今天到期正确", () => {
    const todos = [
      t({ id: "a" }),
      t({ id: "b", completed: true, completedAt: at(0) }),
      t({ id: "c", dueDate: "2026-09-25" }), // 过期
      t({ id: "d", dueDate: "2026-09-27" }), // 今天
      t({ id: "e", deletedAt: Date.now() }), // 墓碑不计
    ];
    const s = computeStats(todos, today);
    expect(s.total).toBe(4);
    expect(s.active).toBe(3);
    expect(s.completed).toBe(1);
    expect(s.overdue).toBe(1);
    expect(s.dueToday).toBe(2); // 过期 + 今天
  });

  it("近 7 天完成趋势：completedAt 落入对应日期桶，7 天外不计", () => {
    const todos = [
      t({ id: "a", completed: true, completedAt: at(0) }),
      t({ id: "b", completed: true, completedAt: at(-2) }),
      t({ id: "c", completed: true, completedAt: at(-2) }),
      t({ id: "d", completed: true, completedAt: at(-9) }), // 窗口外
      t({ id: "e", completed: true }), // 无 completedAt（历史数据）
    ];
    const s = computeStats(todos, today);
    expect(s.days.map((d) => d.count)).toEqual([0, 0, 0, 0, 2, 0, 1]);
  });

  it("分类分布按数量降序，未分类聚合", () => {
    const todos = [
      t({ id: "a", category: "工作" }),
      t({ id: "b", category: "工作" }),
      t({ id: "c", category: "生活" }),
      t({ id: "d" }),
      t({ id: "e", category: "工作", deletedAt: Date.now() }),
    ];
    const s = computeStats(todos, today);
    expect(s.categories).toEqual([
      ["工作", 2],
      ["生活", 1],
      ["__uncat__", 1],
    ]);
  });
});
