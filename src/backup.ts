import { sanitizeRemoteTodo } from "./sync";
import { loadTodos, mergeTodos, todayISO, type Todo } from "./todo";
import { app, persist } from "./state";

/**
 * 解析备份文件内容：兼容 gistPayload 结构 {version, todos} 与裸数组两种格式，
 * 逐条走远端同款校验清洗（sanitizeRemoteTodo），无可导入数据时抛错。
 * 导出供单元测试与导入预览使用。
 */
export function parseBackupTodos(data: unknown): Todo[] {
  const raw = Array.isArray(data)
    ? data
    : typeof data === "object" &&
        data !== null &&
        Array.isArray((data as { todos?: unknown }).todos)
      ? (data as { todos: unknown[] }).todos
      : null;
  if (!raw) throw new Error("文件里没有待办数组");
  const imported = raw.map(sanitizeRemoteTodo).filter((t): t is Todo => t !== null);
  if (imported.length === 0) throw new Error("没有可导入的有效条目");
  return imported;
}

/** 本地 JSON 备份导出（含墓碑：备份保真，导入端按 LWW 合并）与导入 */
export function setupBackup(
  exportBtn: HTMLButtonElement,
  importBtn: HTMLButtonElement,
  importFileInput: HTMLInputElement,
): void {
  exportBtn.addEventListener("click", () => {
    const payload = {
      version: 4,
      exportedAt: new Date().toISOString(),
      todos: app.todos, // 含墓碑：备份保真，导入端按 LWW 合并
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `my-tobo-backup-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  importBtn.addEventListener("click", () => importFileInput.click());
  importFileInput.addEventListener("change", () => {
    const file = importFileInput.files?.[0];
    importFileInput.value = ""; // 允许重复选择同一文件
    if (!file) return;
    void (async () => {
      try {
        const data: unknown = JSON.parse(await file.text());
        const imported = parseBackupTodos(data);
        app.todos = mergeTodos(loadTodos(), imported);
        persist();
        alert(`已导入 ${imported.length} 条（按修改时间合并，未覆盖现有改动）`);
      } catch (err) {
        alert(`导入失败：${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });
}
