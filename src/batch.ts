import { isDeleted, markDeleted } from "./todo";
import { app, captureSnapshot, persist, setCompleted, undoSnapshot, visibleTodos } from "./state";
import { showUndoToast } from "./toast";

export interface BatchRefs {
  toggleBtn: HTMLButtonElement;
  exitBtn: HTMLButtonElement;
  allBtn: HTMLButtonElement;
  doneBtn: HTMLButtonElement;
  pinBtn: HTMLButtonElement;
  deleteBtn: HTMLButtonElement;
}

/** 批量操作：全选/批量完成/批量置顶/批量删除/退出（批量条与 footer 的互斥显隐由 render 控制） */
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
  // 批量置顶：选中项里混有已置顶时整体置顶；全部已置顶则整体取消（按多数语义翻转）
  refs.pinBtn.addEventListener("click", () => {
    if (app.selectedIds.size === 0) return;
    const ids = new Set(app.selectedIds);
    const targets = app.todos.filter((t) => ids.has(t.id) && !isDeleted(t));
    if (targets.length === 0) return;
    const allPinned = targets.every((t) => t.pinned === true);
    app.todos = app.todos.map((t) =>
      ids.has(t.id) && !isDeleted(t)
        ? { ...t, pinned: allPinned ? undefined : true, updatedAt: Date.now() }
        : t,
    );
    app.selectedIds.clear();
    persist();
  });
  refs.deleteBtn.addEventListener("click", () => {
    if (app.selectedIds.size === 0) return;
    const ids = new Set(app.selectedIds);
    const targets = app.todos.filter((t) => ids.has(t.id) && !isDeleted(t));
    if (targets.length === 0) return;
    const snapshot = captureSnapshot();
    app.todos = app.todos.map((t) => (ids.has(t.id) && !isDeleted(t) ? markDeleted(t) : t));
    app.selectedIds.clear();
    persist();
    showUndoToast(`已删除 ${targets.length} 项`, () => undoSnapshot(snapshot));
  });
}
