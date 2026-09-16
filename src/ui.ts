import { isDeleted, type Todo } from "./todo";

export type Filter = "all" | "active" | "completed";

export function filterTodos(todos: Todo[], filter: Filter): Todo[] {
  // 已删除（墓碑未过期）的项不参与展示
  const live = todos.filter((t) => !isDeleted(t));
  if (filter === "active") return live.filter((t) => !t.completed);
  if (filter === "completed") return live.filter((t) => t.completed);
  return live;
}

export function renderList(listEl: HTMLElement, todos: Todo[], emptyMessage: string): void {
  const empty = document.createElement("li");
  empty.className = "todo-empty";
  empty.textContent = emptyMessage;

  if (todos.length === 0) {
    listEl.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const todo of todos) {
    const li = document.createElement("li");
    li.className = todo.completed ? "todo-item is-done" : "todo-item";
    li.dataset.id = todo.id;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "todo-toggle";
    toggle.setAttribute(
      "aria-label",
      todo.completed ? "标记为未完成" : "标记为已完成",
    );
    toggle.textContent = "✓";

    const label = document.createElement("span");
    label.className = "todo-text";
    label.textContent = todo.text;

    const del = document.createElement("button");
    del.type = "button";
    del.className = "todo-delete";
    del.setAttribute("aria-label", "删除");
    del.textContent = "✕";

    li.append(toggle, label, del);
    fragment.append(li);
  }
  listEl.replaceChildren(fragment);
}
