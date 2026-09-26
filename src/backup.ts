import { sanitizeRemoteTodo } from "./sync";
import { loadTodos, mergeTodos, todayISO, type Todo } from "./todo";
import { app, captureSnapshot, persist, undoSnapshot } from "./state";
import { setupModal } from "./modal";
import { showUndoToast } from "./toast";

export interface ImportPreview {
  /** 本地没有的条目数（将新增） */
  newCount: number;
  /** 备份中 updatedAt 较新的条目数（将按 LWW 覆盖本地） */
  updateCount: number;
  /** 本地较新或内容相同的条目数（跳过） */
  skipCount: number;
}

/**
 * 导入预览分析：与本地数据按 id / updatedAt（LWW 规则）对比，估算导入影响。
 * 纯函数，与 mergeTodos 的合并结果一一对应。
 */
export function analyzeImport(current: Todo[], imported: Todo[]): ImportPreview {
  const currentById = new Map(current.map((t) => [t.id, t]));
  let newCount = 0;
  let updateCount = 0;
  let skipCount = 0;
  for (const item of imported) {
    const cur = currentById.get(item.id);
    if (!cur) newCount++;
    else if (item.updatedAt > cur.updatedAt) updateCount++;
    else skipCount++;
  }
  return { newCount, updateCount, skipCount };
}

/** 解析备份文件内容：兼容 gistPayload 结构 {version, todos} 与裸数组两种格式，
 *  逐条走远端同款校验清洗（sanitizeRemoteTodo），无可导入数据时抛错。导出供单元测试使用。 */
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

/** 本地 JSON 备份导出（含墓碑：备份保真，导入端按 LWW 合并）与导入（带冲突预览弹窗） */
export function setupBackup(
  exportBtn: HTMLButtonElement,
  importBtn: HTMLButtonElement,
  importFileInput: HTMLInputElement,
  previewRefs: {
    modal: HTMLElement;
    errorEl: HTMLElement;
    summaryEl: HTMLElement;
    newEl: HTMLElement;
    updateEl: HTMLElement;
    skipEl: HTMLElement;
    confirmBtn: HTMLButtonElement;
    cancelBtn: HTMLButtonElement;
  },
): void {
  exportBtn.addEventListener("click", () => {
    const payload = {
      version: 5,
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

  const { modal, errorEl, summaryEl, newEl, updateEl, skipEl, confirmBtn, cancelBtn } = previewRefs;
  const handle = setupModal(modal);
  let pending: Todo[] | null = null;
  let pendingPreview: ImportPreview | null = null;

  function showError(message: string): void {
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
    summaryEl.classList.add("hidden");
    confirmBtn.disabled = true;
  }

  importBtn.addEventListener("click", () => importFileInput.click());

  importFileInput.addEventListener("change", () => {
    const file = importFileInput.files?.[0];
    importFileInput.value = ""; // 允许重复选择同一文件
    if (!file) return;
    void (async () => {
      try {
        const data: unknown = JSON.parse(await file.text());
        const imported = parseBackupTodos(data);
        const preview = analyzeImport(loadTodos(), imported);
        pending = imported;
        pendingPreview = preview;
        newEl.textContent = String(preview.newCount);
        updateEl.textContent = String(preview.updateCount);
        skipEl.textContent = String(preview.skipCount);
        errorEl.classList.add("hidden");
        summaryEl.classList.remove("hidden");
        confirmBtn.disabled = false;
        handle.open(confirmBtn);
      } catch (err) {
        pending = null;
        showError(`导入失败：${err instanceof Error ? err.message : String(err)}`);
        handle.open(cancelBtn);
      }
    })();
  });

  cancelBtn.addEventListener("click", () => {
    pending = null;
    pendingPreview = null;
    handle.close();
    importBtn.focus(); // 归还焦点到同步弹窗内的导入按钮
  });

  confirmBtn.addEventListener("click", () => {
    if (!pending) return;
    const imported = pending;
    const preview = pendingPreview;
    pending = null;
    pendingPreview = null;
    const current = loadTodos();
    // 导入带来的全新条目记录下来：撤销导入时打墓碑移除（物理删除会被远端收编复活）
    const removeIds = new Set(
      imported.filter((t) => !current.some((c) => c.id === t.id)).map((t) => t.id),
    );
    const snapshot = captureSnapshot();
    app.todos = mergeTodos(current, imported);
    persist();
    handle.close();
    importBtn.focus();
    const summary = preview
      ? `新增 ${preview.newCount} 条、更新 ${preview.updateCount} 条`
      : `共 ${imported.length} 条`;
    showUndoToast(`已导入：${summary}`, () => undoSnapshot(snapshot, removeIds));
  });
}
