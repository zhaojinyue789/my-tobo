import { describe, expect, it } from "vitest";
import {
  advanceDate,
  createTodo,
  isDeleted,
  isDueTomorrow,
  isOverdue,
  isValidCategory,
  isValidDueDate,
  isValidDueTime,
  markDeleted,
  mergeTodos,
  normalizeCategory,
  orderBetween,
  purgeTombstones,
  sameTodos,
  topOrder,
  withOrder,
  type Todo,
} from "./todo";

const t = (over: Partial<Todo> = {}): Todo => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  text: over.text ?? "x",
  completed: over.completed ?? false,
  createdAt: over.createdAt ?? 1000,
  updatedAt: over.updatedAt ?? 1000,
  ...over,
});

describe("normalizeCategory", () => {
  it("trim 后合法值保留", () => {
    expect(normalizeCategory("  工作  ")).toBe("工作");
  });
  it("空值/非字符串返回 undefined", () => {
    expect(normalizeCategory("   ")).toBeUndefined();
    expect(normalizeCategory(undefined)).toBeUndefined();
    expect(normalizeCategory(42)).toBeUndefined();
  });
  it("超长（>20 码元）拒绝", () => {
    expect(normalizeCategory("a".repeat(20))).toBe("a".repeat(20));
    expect(normalizeCategory("a".repeat(21))).toBeUndefined();
  });
  it("禁用字符拒绝", () => {
    for (const ch of ['/\\<>:"|?*']) {
      expect(normalizeCategory(`a${ch}b`)).toBeUndefined();
    }
    expect(normalizeCategory("a\u0000b")).toBeUndefined();
    expect(normalizeCategory("a\u007fb")).toBeUndefined();
  });
  it("isValidCategory 与 normalizeCategory 一致", () => {
    expect(isValidCategory(" 工作 ")).toBe(true);
    expect(isValidCategory("")).toBe(false);
  });
});

describe("isValidDueDate / isOverdue", () => {
  it("日期格式校验", () => {
    expect(isValidDueDate("2026-09-26")).toBe(true);
    expect(isValidDueDate("2026-9-6")).toBe(false);
    expect(isValidDueDate(undefined)).toBe(false);
  });
  it("过期判定：当天不算过期，已完成/已删除/无日期永不过期", () => {
    expect(isOverdue({ ...t(), dueDate: "2026-09-25" }, "2026-09-26")).toBe(true);
    expect(isOverdue({ ...t(), dueDate: "2026-09-26" }, "2026-09-26")).toBe(false);
    expect(isOverdue({ ...t(), dueDate: "2026-09-25", completed: true }, "2026-09-26")).toBe(false);
    expect(isOverdue({ ...t(), dueDate: "2026-09-25", deletedAt: 1 }, "2026-09-26")).toBe(false);
    expect(isOverdue({ ...t() }, "2026-09-26")).toBe(false);
  });
});

describe("orderBetween / topOrder / withOrder", () => {
  it("两邻条取中点", () => {
    expect(orderBetween({ ...t(), order: 0 }, { ...t(), order: 1 }, 99)).toBe(0.5);
  });
  it("缺一侧取另一侧 ±1", () => {
    expect(orderBetween(undefined, { ...t(), order: 3 }, 99)).toBe(2);
    expect(orderBetween({ ...t(), order: 3 }, undefined, 99)).toBe(4);
  });
  it("两侧都缺用 fallback", () => {
    expect(orderBetween(undefined, undefined, 7)).toBe(7);
    expect(orderBetween({ ...t() }, { ...t() }, 7)).toBe(7); // 无 order 的邻条视同缺失
  });
  it("topOrder：最小值减 1，空列表 0", () => {
    expect(topOrder([])).toBe(0);
    expect(topOrder([{ ...t(), order: -5 }, { ...t(), order: 2 }])).toBe(-6);
  });
  it("withOrder 只改 order 并 bump updatedAt", () => {
    const before = t({ order: 1, updatedAt: 100 });
    const after = withOrder(before, 2.5);
    expect(after.order).toBe(2.5);
    expect(after.updatedAt).toBeGreaterThan(100);
  });
});

describe("mergeTodos（LWW + 展示顺序）", () => {
  it("按 updatedAt 最后写入胜出", () => {
    const local = [t({ id: "a", text: "旧", updatedAt: 100, createdAt: 100 })];
    const remote = [t({ id: "a", text: "新", updatedAt: 200, createdAt: 100 })];
    expect(mergeTodos(local, remote)[0].text).toBe("新");
    // 时间戳相等保留本地
    expect(mergeTodos(remote, [{ ...remote[0], text: "平" }])[0].text).toBe("新");
  });
  it("单端独有条目（含墓碑）收编", () => {
    const local = [t({ id: "a" })];
    const remote = [t({ id: "b", deletedAt: 123 })];
    const merged = mergeTodos(local, remote);
    expect(merged.map((x) => x.id).sort()).toEqual(["a", "b"]);
    expect(merged.find((x) => x.id === "b")).toBeTruthy();
    expect(isDeleted(merged.find((x) => x.id === "b")!)).toBe(true);
  });
  it("展示顺序：order 升序，缺 order 回退 createdAt 降序", () => {
    const merged = mergeTodos(
      [
        t({ id: "late", createdAt: 300, updatedAt: 300 }),
        t({ id: "mid", createdAt: 200, updatedAt: 200, order: 5 }),
        t({ id: "early", createdAt: 100, updatedAt: 100, order: 1 }),
      ],
      [],
    );
    expect(merged.map((x) => x.id)).toEqual(["early", "mid", "late"]);
  });
});

describe("墓碑与比较", () => {
  it("purgeTombstones 清过期墓碑、保留新鲜墓碑", () => {
    const now = Date.now();
    const todos = [
      t({ id: "fresh", deletedAt: now - 1000 }),
      t({ id: "stale", deletedAt: now - 31 * 24 * 60 * 60 * 1000 }),
      t({ id: "alive" }),
    ];
    const purged = purgeTombstones(todos);
    expect(purged.map((x) => x.id).sort()).toEqual(["alive", "fresh"]);
  });
  it("markDeleted 打墓碑并 bump updatedAt", () => {
    const before = t({ updatedAt: 100 });
    const after = markDeleted(before);
    expect(isDeleted(after)).toBe(true);
    expect(after.updatedAt).toBeGreaterThan(100);
  });
  it("sameTodos 与数组顺序无关", () => {
    expect(sameTodos([t({ id: "a" }), t({ id: "b" })], [t({ id: "b" }), t({ id: "a" })])).toBe(true);
    expect(sameTodos([t({ id: "a", order: 1 })], [t({ id: "a", order: 2 })])).toBe(false);
  });
  it("createTodo 生成 id 且 createdAt = updatedAt", () => {
    const todo = createTodo("hi");
    expect(todo.text).toBe("hi");
    expect(todo.id).toBeTruthy();
    expect(todo.createdAt).toBe(todo.updatedAt);
  });
});

describe("advanceDate / isDueTomorrow（重复与提前提醒）", () => {
  it("daily +1 天、weekly +7 天", () => {
    expect(advanceDate("2026-09-26", "daily")).toBe("2026-09-27");
    expect(advanceDate("2026-09-26", "weekly")).toBe("2026-10-03");
  });
  it("monthly 月末收紧：1 月 31 日 → 2 月 28/29 日", () => {
    expect(advanceDate("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(advanceDate("2024-01-31", "monthly")).toBe("2024-02-29"); // 闰年
    expect(advanceDate("2026-01-15", "monthly")).toBe("2026-02-15");
  });
  it("isDueTomorrow 只认明天", () => {
    const t1 = { ...t(), dueDate: "2026-09-27" };
    expect(isDueTomorrow(t1, "2026-09-26")).toBe(true);
    expect(isDueTomorrow(t1, "2026-09-25")).toBe(false);
    expect(isDueTomorrow({ ...t(), completed: true, dueDate: "2026-09-27" }, "2026-09-26")).toBe(false);
    expect(isDueTomorrow({ ...t(), deletedAt: 1, dueDate: "2026-09-27" }, "2026-09-26")).toBe(false);
  });
  it("isOverdue 时刻感知：当天到点即过期", () => {
    expect(isOverdue({ ...t(), dueDate: "2026-09-26" }, "2026-09-26", "10:00")).toBe(false);
    expect(isOverdue({ ...t(), dueDate: "2026-09-26", dueTime: "09:30" }, "2026-09-26", "10:00")).toBe(true);
    expect(isOverdue({ ...t(), dueDate: "2026-09-26", dueTime: "10:00" }, "2026-09-26", "10:00")).toBe(true);
    expect(isOverdue({ ...t(), dueDate: "2026-09-26", dueTime: "23:00" }, "2026-09-26", "10:00")).toBe(false);
  });
  it("置顶条目排在最前（mergeTodos 展示顺序）", () => {
    const merged = mergeTodos(
      [
        t({ id: "a", order: 1 }),
        t({ id: "b", order: 2, pinned: true }),
        t({ id: "c", order: 3, pinned: true }),
      ],
      [],
    );
    expect(merged.map((x) => x.id)).toEqual(["b", "c", "a"]);
  });
  it("isValidDueTime 校验", () => {
    expect(isValidDueTime("09:30")).toBe(true);
    expect(isValidDueTime("23:59")).toBe(true);
    expect(isValidDueTime("24:00")).toBe(false);
    expect(isValidDueTime("9:30")).toBe(false);
    expect(isValidDueTime(undefined)).toBe(false);
  });
});
