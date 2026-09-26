import { buildSelectOption } from "./ui";
import { isDeleted, markDeleted, normalizeCategory } from "./todo";
import { app, persist, setCompleted, visibleTodos } from "./state";

export interface BatchRefs {
  toggleBtn: HTMLButtonElement;
  exitBtn: HTMLButtonElement;
  allBtn: HTMLButtonElement;
  doneBtn: HTMLButtonElement;
  deleteBtn: HTMLButtonElement;
  categorySelect: HTMLSelectElement;
}

/** 批量操作：全选/批量完成/批量删除/批量改分类/退出（批量条与 footer 的互斥显隐由 render 控制） */
export function setupBatch(refs: BatchRefs, render: () => void): void {
  refs.toggleBtn.addEventListener("click", () => {
    app.batchMode = true;
    app.selectedIds.clear();
    render();
  });
  refs.exitBtn.addEventListener("click", () => {
    app.batchMode = false;
    app.selectedIds.clear();
    render();
  });
  refs.allBtn.addEventListener("click", () => {
    const visible = visibleTodos();
    const allSelected = visible.length > 0 && visible.every((t) => app.selectedIds.has(t.id));
    app.selectedIds.clear();
    if (!allSelected) for (const t of visible) app.selectedIds.add(t.id);
    render();
  });
  refs.doneBtn.addEventListener("click", () => {
    let changed = false;
    for (const id of [...app.selectedIds]) changed = setCompleted(id, true) || changed;
    if (changed) {
      app.selectedIds.clear();
      persist();
    }
  });
  refs.deleteBtn.addEventListener("click", () => {
    if (app.selectedIds.size === 0) return;
    const ids = new Set(app.selectedIds);
    app.todos = app.todos.map((t) => (ids.has(t.id) && !isDeleted(t) ? markDeleted(t) : t));
    app.selectedIds.clear();
    persist();
  });
  refs.categorySelect.addEventListener("change", () => {
    const next = normalizeCategory(refs.categorySelect.value);
    if (!next || app.selectedIds.size === 0) return;
    const ids = new Set(app.selectedIds);
    app.todos = app.todos.map((t) =>
      ids.has(t.id) && !isDeleted(t) && t.category !== next
        ? { ...t, category: next, updatedAt: Date.now() }
        : t,
    );
    refs.categorySelect.value = "";
    app.selectedIds.clear();
    persist();
  });
}

/** 批量改分类的下拉：每次渲染同步选项（未选中的占位值 ""） */
export function syncBatchCategory(categories: string[], select: HTMLSelectElement): void {
  const previous = select.value;
  select.replaceChildren(buildSelectOption("", "改分类…"));
  for (const name of categories) select.append(buildSelectOption(name, name));
  select.value = previous && categories.includes(previous) ? previous : "";
}
