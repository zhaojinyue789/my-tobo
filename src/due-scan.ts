import { isDueTomorrow, isOverdue, type Todo } from "./todo";
import { ensurePermission, notifyTodoDue, notifyTodoTomorrow } from "./notify";
import { app, markTodo, persist } from "./state";

/** 单条即时通知：过期且未通知 → 发送并标记 notified；未授权/发送失败不标记，下次触发重试 */
export async function notifyTodoOnce(todo: Todo): Promise<void> {
  if (todo.notified || !isOverdue(todo)) return;
  if (!(await ensurePermission())) return;
  try {
    await notifyTodoDue(todo);
  } catch {
    return; // 系统通知服务失败：静默降级，不阻塞主流程
  }
  markTodo(todo.id, { notified: true });
  persist();
}

/** 分钟级扫描：到期/过期通知（notified）+ 提前 1 天提醒（reminded）；
 *  权限未授予/发送失败不标记，下次扫描重试；标记均不 bump updatedAt（设备本地 UX 状态，不参与 LWW） */
export async function notifyDueBatch(): Promise<void> {
  const due = app.todos.filter((t) => isOverdue(t) && !t.notified);
  const ahead = app.todos.filter((t) => isDueTomorrow(t) && !t.reminded);
  if (due.length === 0 && ahead.length === 0) return;
  if (!(await ensurePermission())) return;
  let changed = false;
  for (const todo of due) {
    try {
      await notifyTodoDue(todo);
    } catch {
      continue;
    }
    markTodo(todo.id, { notified: true });
    changed = true;
  }
  for (const todo of ahead) {
    try {
      await notifyTodoTomorrow(todo);
    } catch {
      continue;
    }
    markTodo(todo.id, { reminded: true });
    changed = true;
  }
  if (changed) persist();
}
