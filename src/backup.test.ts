import { describe, expect, it } from "vitest";
import { analyzeImport } from "./backup";
import type { Todo } from "./todo";

const t = (over: Partial<Todo> = {}): Todo => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  text: over.text ?? "x",
  completed: over.completed ?? false,
  createdAt: 1000,
  updatedAt: over.updatedAt ?? 1000,
  ...over,
});

describe("analyzeImport（导入冲突预览）", () => {
  it("按 id/updatedAt 估算新增、更新、跳过", () => {
    const current = [
      t({ id: "same", updatedAt: 100 }),
      t({ id: "local-newer", updatedAt: 200 }),
      t({ id: "backup-newer", updatedAt: 100 }),
    ];
    const imported = [
      t({ id: "brand-new", updatedAt: 1 }),
      t({ id: "same", updatedAt: 100 }),
      t({ id: "local-newer", updatedAt: 50 }),
      t({ id: "backup-newer", updatedAt: 300 }),
    ];
    expect(analyzeImport(current, imported)).toEqual({
      newCount: 1,
      updateCount: 1,
      skipCount: 2,
    });
  });
  it("空本地数据：全部计为新增", () => {
    expect(analyzeImport([], [t(), t()])).toEqual({ newCount: 2, updateCount: 0, skipCount: 0 });
  });
  it("updatedAt 相同按跳过处理（不覆盖）", () => {
    expect(analyzeImport([t({ id: "a", updatedAt: 100 })], [t({ id: "a", updatedAt: 100 })])).toEqual({
      newCount: 0,
      updateCount: 0,
      skipCount: 1,
    });
  });
});
