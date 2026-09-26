import { describe, expect, it } from "vitest";
import { sanitizeRemoteTodo } from "./sync";

describe("sanitizeRemoteTodo（远端条目校验）", () => {
  const base = {
    id: "a",
    text: "x",
    createdAt: 1,
    updatedAt: 1,
  };

  it("合法条目原样通过，缺省 completed 补 false", () => {
    const out = sanitizeRemoteTodo(base);
    expect(out).toMatchObject({ id: "a", completed: false });
  });

  it("必填字段缺失/类型不对 → 丢弃", () => {
    expect(sanitizeRemoteTodo(null)).toBeNull();
    expect(sanitizeRemoteTodo("x")).toBeNull();
    expect(sanitizeRemoteTodo({ ...base, id: "" })).toBeNull();
    expect(sanitizeRemoteTodo({ ...base, text: 1 })).toBeNull();
    expect(sanitizeRemoteTodo({ ...base, createdAt: "1" })).toBeNull();
    expect(sanitizeRemoteTodo({ ...base, updatedAt: NaN })).toBeNull();
    expect(sanitizeRemoteTodo({ ...base, completed: "yes" })).toBeNull();
    expect(sanitizeRemoteTodo({ ...base, deletedAt: "x" })).toBeNull();
  });

  it("可选字段非法按缺失清洗，不丢条", () => {
    const out = sanitizeRemoteTodo({
      ...base,
      category: 42,
      dueDate: "2026/09/26",
      order: "first",
      notified: "yes",
    });
    expect(out).not.toBeNull();
    expect(out!.category).toBeUndefined();
    expect(out!.dueDate).toBeUndefined();
    expect(out!.order).toBeUndefined();
    expect(out!.notified).toBeUndefined();
  });

  it("合法可选字段保留", () => {
    const out = sanitizeRemoteTodo({
      ...base,
      category: " 工作 ",
      dueDate: "2026-09-26",
      dueTime: "09:30",
      recurrence: "weekly",
      pinned: true,
      order: -3.5,
      notified: true,
      reminded: true,
      completed: true,
      deletedAt: 99,
    });
    expect(out).toMatchObject({
      category: "工作",
      dueDate: "2026-09-26",
      dueTime: "09:30",
      recurrence: "weekly",
      pinned: true,
      order: -3.5,
      notified: true,
      reminded: true,
      completed: true,
      deletedAt: 99,
    });
  });

  it("新字段（dueTime/recurrence/pinned/reminded）非法值清洗不丢条", () => {
    const out = sanitizeRemoteTodo({
      ...base,
      dueTime: "25:99",
      recurrence: "yearly",
      pinned: "yes",
      reminded: 1,
    });
    expect(out).not.toBeNull();
    expect(out!.dueTime).toBeUndefined();
    expect(out!.recurrence).toBeUndefined();
    expect(out!.pinned).toBeUndefined();
    expect(out!.reminded).toBeUndefined();
  });
});
