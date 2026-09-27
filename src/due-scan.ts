import { isDueTomorrow, isOverdue, type Todo } from "./todo";
import { ensurePermission, notifyTodoDue, notifyTodoTomorrow } from "./notify";
import { app, markTodo, persist } from "./state";

/** 「稍后」贪睡：1 小时内扫描跳过该条（到期通知的操作按钮触发） */
const SNOOZE_MS = 60 * 60 * 1000;
const snoozeUntil = new Map<string, number>();

/** 通知里点「稍后」：清掉已通知标记，1 小时后由下一次扫描重新提醒 */
export function snoozeTodo(id: string): void {
  snoozeUntil.set(id, Date.now() + SNOOZE_MS);
  markTodo(id, { notified: false });
}

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
  const now = Date.now();
  const due = app.todos.filter(
    (t) => isOverdue(t) && !t.notified && (snoozeUntil.get(t.id) ?? 0) <= now,
  );
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
