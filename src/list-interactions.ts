import {
  isDeleted,
  isValidDueDate,
  isValidDueTime,
  normalizeCategory,
  NOTES_MAX_LENGTH,
  orderBetween,
  withOrder,
} from "./todo";
import {
  app,
  captureSnapshot,
  persist,
  saveOnly,
  setCompleted,
  undoSnapshot,
  updateTodo,
  visibleTodos,
} from "./state";
import { attachDragReorder } from "./drag";
import { notifyTodoOnce } from "./due-scan";
import { showUndoToast } from "./toast";
import type { Todo } from "./todo";

/**
 * 列表交互：点击（完成/删除/置顶/恢复/勾选）、行内文本编辑、行内控件修改（分类/日期/时刻）、
 * 拖动与键盘（Alt+↑/↓）排序。全部通过事件委托绑定在列表元素上。
 */
export function setupListInteractions(
  listEl: HTMLElement,
  deps: { render(): void },
): void {
  listEl.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const item = target.closest<HTMLElement>(".todo-item");
    if (!item) return;
    const id = item.dataset.id;
    if (target.classList.contains("todo-toggle")) {
      if (id) setCompleted(id, !app.todos.find((t) => t.id === id)?.completed);
    } else if (target.classList.contains("todo-delete")) {
      if (id) {
        const current = app.todos.find((t) => t.id === id);
        if (current && !isDeleted(current)) {
          const snapshot = captureSnapshot();
          updateTodo(id, { deletedAt: Date.now() });
          showUndoToast(`已删除「${current.text}」`, () => undoSnapshot(snapshot));
        }
      }
    } else if (target.classList.contains("todo-text")) {
      beginEdit(item, id);
      return;
    } else if (target.classList.contains("todo-pin")) {
      if (id) {
        const current = app.todos.find((t) => t.id === id);
        if (current) updateTodo(id, { pinned: !current.pinned });
      }
    } else if (target.classList.contains("todo-restore")) {
      // 恢复 = 撤销墓碑（updatedAt 更新会按 LWW 复活远端同条目）；重置两个通知标记防误报
      if (id) {
        const current = app.todos.find((t) => t.id === id);
        if (current && isDeleted(current)) {
          updateTodo(id, { deletedAt: undefined, notified: false, reminded: false });
        }
      }
    } else if (target.classList.contains("todo-check")) {
      if (!id) return;
      if (app.selectedIds.has(id)) app.selectedIds.delete(id);
      else app.selectedIds.add(id);
      deps.render();
      return;
    } else if (
      target.classList.contains("todo-notes") ||
      target.classList.contains("todo-notes-add")
    ) {
      beginNotesEdit(item, id);
      return;
    } else if (target.classList.contains("todo-sub-add")) {
      beginSubAdd(item, id);
      return;
    } else if (target.classList.contains("sub-del")) {
      const subId = target.closest<HTMLElement>(".todo-subtask")?.dataset.subId;
      if (!id || !subId) return;
      const current = app.todos.find((t) => t.id === id);
      if (!current?.subtasks) return;
      const next = current.subtasks.filter((s) => s.id !== subId);
      updateTodo(id, { subtasks: next.length > 0 ? next : undefined });
    } else {
      return;
    }
    persist();
  });

  // ---------- 行内编辑文本 ----------

  /** 单击文本进入编辑：span 换 input；Enter/失焦提交，Esc 还原。
   *  拖动结束的那次 click 已被 drag 层吞掉，不会误入编辑；编辑中 render 跳过列表重建。 */
  function beginEdit(item: HTMLElement, id: string | undefined): void {
    if (app.editingId != null || !id) return;
    const todo = app.todos.find((t) => t.id === id);
    const span = item.querySelector<HTMLElement>(".todo-text");
    if (!todo || !span) return;
    app.editingId = id;
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 200; // 与新建输入框一致
    input.className = "todo-edit";
    input.setAttribute("aria-label", "编辑待办");
    input.value = todo.text;
    span.replaceWith(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    let done = false;
    const endEdit = (save: boolean): void => {
      if (done || app.editingId !== id) return;
      done = true;
      app.editingId = null;
      const next = input.value.trim();
      const current = app.todos.find((t) => t.id === id);
      if (save && current && !isDeleted(current) && next && next !== current.text) {
        updateTodo(id, { text: next });
        // 文本改动不影响顺序/统计/筛选：原地换 span 即可，不做整表重渲染——
        // 否则 blur 提交后的整表重建会把「点别处」的那次点击落到重建后的其他控件上
        saveOnly();
        span.textContent = next;
      }
      input.replaceWith(span);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        endEdit(true); // 直接提交，不依赖 blur（部分内嵌 WebView 无窗口焦点时不派发 blur）
      } else if (e.key === "Escape") {
        endEdit(false);
      }
    });
    input.addEventListener("blur", () => endEdit(true));
  }

  // ---------- 行内备注编辑 ----------

  /** 单击备注预览或「＋备注」进入编辑：换成 textarea；Ctrl/Cmd+Enter 或失焦提交，Esc 取消。
   *  复用 editingId 守卫防止编辑中列表重建；提交不整表重渲染（备注不影响顺序/统计）。 */
  function beginNotesEdit(item: HTMLElement, id: string | undefined): void {
    if (app.editingId != null || !id) return;
    const todo = app.todos.find((t) => t.id === id);
    if (!todo) return;
    const anchor =
      item.querySelector<HTMLElement>(".todo-notes") ??
      item.querySelector<HTMLElement>(".todo-notes-add");
    if (!anchor) return;
    app.editingId = id;
    const ta = document.createElement("textarea");
    ta.className = "todo-notes-edit";
    ta.maxLength = NOTES_MAX_LENGTH;
    ta.rows = 3;
    ta.placeholder = "输入备注，Ctrl+Enter 保存，Esc 取消";
    ta.setAttribute("aria-label", "编辑备注");
    ta.value = todo.notes ?? "";
    anchor.replaceWith(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    let done = false;
    const endEdit = (save: boolean): void => {
      if (done || app.editingId !== id) return;
      done = true;
      app.editingId = null;
      const next = ta.value.trim();
      const live = app.todos.find((t) => t.id === id);
      if (save && live && !isDeleted(live) && next !== (live.notes ?? "")) {
        updateTodo(id, { notes: next || undefined }); // 清空 = 删除备注
        saveOnly();
      }
      // 原地还原：有备注显示预览，无备注显示「＋备注」
      const latest = app.todos.find((t) => t.id === id);
      if (latest?.notes) {
        const span = document.createElement("span");
        span.className = "todo-notes";
        span.textContent = latest.notes;
        span.title = "点击编辑备注";
        ta.replaceWith(span);
      } else {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "todo-notes-add";
        btn.textContent = "＋备注";
        ta.replaceWith(btn);
      }
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        endEdit(true); // 直接提交，不依赖 blur（与文本编辑同因）
      } else if (e.key === "Escape") {
        e.stopPropagation(); // 不触发全局 Esc（只关筛选菜单）的语义混叠
        endEdit(false);
      }
    });
    ta.addEventListener("blur", () => endEdit(true));
  }

  // ---------- 子任务 ----------

  /** 点「＋子任务」：按钮换成输入框（有子任务的条目自带常驻输入框，不走这里） */
  function beginSubAdd(item: HTMLElement, id: string | undefined): void {
    if (!id || app.editingId != null) return;
    const btn = item.querySelector<HTMLElement>(".todo-sub-add");
    if (!btn || item.querySelector(".sub-add")) return;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "sub-add";
    input.maxLength = 200;
    input.placeholder = "添加子任务，回车确认";
    input.setAttribute("aria-label", "添加子任务");
    btn.replaceWith(input);
    input.focus();
  }

  // 子任务输入框：Enter 追加一条（支持连续录入），Esc 还原
  listEl.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (!target.classList.contains("sub-add")) return;
    if (e.key !== "Enter" && e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    const item = target.closest<HTMLElement>(".todo-item");
    const id = item?.dataset.id;
    if (e.key === "Escape" || !id) {
      deps.render(); // 重建列表即还原为初始形态
      return;
    }
    const text = (target as HTMLInputElement).value.trim();
    if (!text) return;
    const current = app.todos.find((t) => t.id === id);
    if (!current) return;
    const next = [...(current.subtasks ?? []), { id: crypto.randomUUID(), text, done: false }];
    updateTodo(id, { subtasks: next });
    persist();
    // 重渲染后把焦点还给该条目的子任务输入框，连续录入不丢焦点
    setTimeout(() => {
      const li = listEl.querySelector<HTMLElement>(`.todo-item[data-id="${CSS.escape(id)}"]`);
      li?.querySelector<HTMLInputElement>(".sub-add")?.focus();
    }, 0);
  });

  // 行内控件（分类 select / 日期 input / 子任务勾选）：change 才写数据并落盘；渲染时直接赋 .value 不触发事件，无回写死循环
  listEl.addEventListener("change", (e) => {
    const target = e.target as HTMLSelectElement | HTMLInputElement;
    const item = target.closest<HTMLElement>(".todo-item");
    if (!item) return;
    const current = app.todos.find((t) => t.id === item.dataset.id);
    if (!current) return;
    let updated: Todo | undefined;

    if (target.classList.contains("sub-check")) {
      const subId = target.closest<HTMLElement>(".todo-subtask")?.dataset.subId;
      if (!subId || !current.subtasks) return;
      const done = (target as HTMLInputElement).checked;
      updated = updateTodo(current.id, {
        subtasks: current.subtasks.map((s) => (s.id === subId ? { ...s, done } : s)),
      });
    } else if (target.classList.contains("todo-category")) {
      const next = target.value === "__uncat__" ? undefined : normalizeCategory(target.value);
      if ((current.category ?? undefined) === (next ?? undefined)) return;
      updated = updateTodo(current.id, { category: next });
    } else if (target.classList.contains("todo-due")) {
      const next = isValidDueDate(target.value) ? target.value : undefined; // 非法输入按清空处理，不报错
      if ((current.dueDate ?? undefined) === (next ?? undefined)) return;
      // 清日期时连时刻一起清（时刻依赖日期才有意义）
      updated = updateTodo(current.id, {
        dueDate: next,
        dueTime: next ? current.dueTime : undefined,
      });
    } else if (target.classList.contains("todo-due-time")) {
      const next = isValidDueTime(target.value) ? target.value : undefined;
      if ((current.dueTime ?? undefined) === (next ?? undefined)) return;
      updated = updateTodo(current.id, { dueTime: next });
    } else {
      return;
    }
    persist();
    // 即时到期检查：改日期为过期值 → 立即通知并标记；改分类时 isOverdue 恒为否、自然跳过
    if (updated) void notifyTodoOnce(updated);
  });

  // ---------- 拖动/键盘排序 ----------

  /** 把 id 条目移到 prevId/nextId 之间（拖动落点与键盘移动共用）：
   *  order 取邻条中点（缺邻取另一侧 ±1），数组同步重排（渲染顺序跟数组走），只写这一条 → LWW 改动面最小。
   *  筛选视图下邻条以可见集为准（被隐藏条目夹在中间属预期）。 */
  function applyMove(id: string, prevId: string | null, nextId: string | null): void {
    const from = app.todos.findIndex((t) => t.id === id);
    if (from < 0) return;
    const current = app.todos[from];
    const prev = prevId != null ? app.todos.find((t) => t.id === prevId) : undefined;
    const next = nextId != null ? app.todos.find((t) => t.id === nextId) : undefined;
    const order = orderBetween(prev, next, current.order ?? 0);
    if (order === current.order) return; // 原位（含 Esc 还原 / 仅剩一条）：不产生写入与同步
    const rest = app.todos.filter((t) => t.id !== id);
    const at =
      prevId != null
        ? rest.findIndex((t) => t.id === prevId) + 1
        : nextId != null
          ? rest.findIndex((t) => t.id === nextId)
          : from; // 前后都无邻条：数组位置不变
    rest.splice(at, 0, withOrder(current, order));
    app.todos = rest;
    persist();
  }

  attachDragReorder(listEl, {
    onDrop: (id, prevId, nextId) => {
      if (id && app.view.status !== "deleted") applyMove(id, prevId, nextId); // 回收站内不排序
    },
  });

  // 键盘排序：焦点在条目内任意控件时 Alt+↑/↓ 与相邻可见条目换位（拖动的无障碍替代），
  // 列表重建后把焦点放回同一条目的同类控件
  listEl.addEventListener("keydown", (e) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    if (app.view.status === "deleted") return; // 回收站内不排序
    const item = (e.target as HTMLElement).closest<HTMLElement>(".todo-item");
    const id = item?.dataset.id;
    if (!item || !id) return;
    e.preventDefault();
    const visible = visibleTodos();
    const i = visible.findIndex((t) => t.id === id);
    if (i < 0) return;
    const up = e.key === "ArrowUp";
    const j = up ? i - 1 : i + 1;
    if (!visible[j]) return;
    const prev = up ? (visible[j - 1] ?? null) : visible[j];
    const next = up ? visible[j] : (visible[j + 1] ?? null);
    const hadFocus = document.activeElement;
    applyMove(id, prev?.id ?? null, next?.id ?? null);
    // 列表已重建，把焦点放回同一条目的同类控件；rAF 在后台标签页会被暂停，用 setTimeout
    setTimeout(() => {
      const li = listEl.querySelector<HTMLElement>(`.todo-item[data-id="${CSS.escape(id)}"]`);
      if (!li || !(hadFocus instanceof HTMLElement)) return;
      const cls = [...hadFocus.classList].find((c) => c.startsWith("todo-"));
      const target =
        (cls && li.querySelector<HTMLElement>(`.${cls}`)) ||
        li.querySelector<HTMLElement>(".todo-toggle");
      target?.focus();
    }, 0);
  });
}
