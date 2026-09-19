import {
  createTodo,
  isDeleted,
  loadTodos,
  markDeleted,
  saveTodos,
  type Todo,
} from "./todo";
import { filterTodos, renderList, type Filter } from "./ui";
import { SyncController, loadSyncConfig, loadSyncGistId, type SyncStatus } from "./sync";
import "./style.css";

const form = document.querySelector<HTMLFormElement>("#todo-form")!;
const input = document.querySelector<HTMLInputElement>("#todo-input")!;
const listEl = document.querySelector<HTMLUListElement>("#todo-list")!;
const filtersEl = document.querySelector<HTMLElement>("#filters")!;
const footer = document.querySelector<HTMLElement>("#todo-footer")!;
const countEl = document.querySelector<HTMLSpanElement>("#todo-count")!;
const clearBtn = document.querySelector<HTMLButtonElement>("#clear-completed")!;

const syncDot = document.querySelector<HTMLElement>("#sync-dot")!;
const syncText = document.querySelector<HTMLElement>("#sync-text")!;
const syncNowBtn = document.querySelector<HTMLButtonElement>("#sync-now")!;
const syncSettingsBtn = document.querySelector<HTMLButtonElement>("#sync-settings")!;

const modal = document.querySelector<HTMLElement>("#sync-modal")!;
const gistTokenInput = document.querySelector<HTMLInputElement>("#gist-token")!;
const gistIdInput = document.querySelector<HTMLInputElement>("#gist-id")!;
const modalError = document.querySelector<HTMLElement>("#sync-modal-error")!;
const gistCreateBtn = document.querySelector<HTMLButtonElement>("#gist-create")!;
const gistSaveBtn = document.querySelector<HTMLButtonElement>("#gist-save")!;
const gistDisconnectBtn = document.querySelector<HTMLButtonElement>("#gist-disconnect")!;
const gistCloseBtn = document.querySelector<HTMLButtonElement>("#gist-close")!;
const storageWarning = document.querySelector<HTMLElement>("#storage-warning")!;

let todos: Todo[] = loadTodos();
let filter: Filter = "all";

const sync = new SyncController({
  onTodos: (merged) => {
    todos = merged;
    render();
  },
  onStatus: renderSyncStatus,
});

function render(): void {
  const visible = filterTodos(todos, filter);
  renderList(
    listEl,
    visible,
    todos.some((t) => !isDeleted(t))
      ? "该筛选下暂无待办"
      : "这里空空如也，添加一条待办吧～",
  );

  const live = todos.filter((t) => !isDeleted(t));
  const remaining = live.filter((t) => !t.completed).length;
  countEl.textContent = `剩余 ${remaining} 项未完成`;
  footer.classList.toggle("hidden", live.length === 0);
  clearBtn.classList.toggle("hidden", !live.some((t) => t.completed));

  for (const btn of filtersEl.querySelectorAll<HTMLButtonElement>(".filter")) {
    btn.classList.toggle("is-active", btn.dataset.filter === filter);
  }
}

function persist(): void {
  // 写入失败（如配额超限）时亮起顶栏提示，恢复后自动隐藏
  storageWarning.classList.toggle("hidden", saveTodos(todos));
  sync.onLocalChange();
  render();
}

function renderSyncStatus(status: SyncStatus): void {
  syncDot.className = "sync-dot";
  switch (status.state) {
    case "unconfigured":
      syncDot.classList.add("is-unconfigured");
      syncText.textContent = "未开启同步";
      syncNowBtn.disabled = true;
      break;
    case "syncing":
      syncDot.classList.add("is-syncing");
      syncText.textContent = "同步中…";
      syncNowBtn.disabled = true;
      break;
    case "ok":
      syncDot.classList.add("is-ok");
      syncText.textContent = status.lastSync
        ? `已同步 ${new Date(status.lastSync).toLocaleTimeString()}`
        : "已同步";
      syncNowBtn.disabled = false;
      break;
    case "error":
      syncDot.classList.add("is-error");
      syncText.textContent = `同步失败：${status.message}`;
      syncText.title = status.message;
      syncNowBtn.disabled = false;
      break;
    default:
      syncText.textContent = "";
      syncNowBtn.disabled = false;
  }
}

// ---------- 待办交互 ----------

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  todos.unshift(createTodo(text));
  input.value = "";
  persist();
});

// 部分内嵌浏览器不触发表单隐式提交，keydown 兜底；preventDefault 避免双重提交
input.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  form.requestSubmit();
});

listEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const item = target.closest<HTMLElement>(".todo-item");
  if (!item) return;
  const id = item.dataset.id;
  if (target.classList.contains("todo-toggle")) {
    todos = todos.map((t) =>
      t.id === id ? { ...t, completed: !t.completed, updatedAt: Date.now() } : t,
    );
  } else if (target.classList.contains("todo-delete")) {
    todos = todos.map((t) => (t.id === id ? markDeleted(t) : t));
  } else {
    return;
  }
  persist();
});

filtersEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".filter");
  if (!btn) return;
  filter = btn.dataset.filter as Filter;
  render();
});

clearBtn.addEventListener("click", () => {
  const now = Date.now();
  todos = todos.map((t) =>
    !isDeleted(t) && t.completed ? { ...t, deletedAt: now, updatedAt: now } : t,
  );
  persist();
});

// ---------- 同步交互 ----------

syncNowBtn.addEventListener("click", () => void sync.syncNow());

function openModal(): void {
  const cfg = loadSyncConfig();
  // Token 读不到时（Store 读取失败/换机等）保留 gistId 回填，用户只需重输 Token
  gistIdInput.value = cfg?.gistId ?? loadSyncGistId();
  gistTokenInput.value = cfg?.token ?? "";
  modalError.classList.add("hidden");
  if (!cfg && gistIdInput.value) showModalError("未读取到已保存的 Token，请重新输入");
  modal.classList.remove("hidden");
  gistTokenInput.focus();
}

function showModalError(message: string): void {
  modalError.textContent = message;
  modalError.classList.remove("hidden");
}

function setModalBusy(busy: boolean): void {
  for (const btn of [gistCreateBtn, gistSaveBtn, gistDisconnectBtn, gistCloseBtn]) {
    btn.disabled = busy;
  }
}

syncSettingsBtn.addEventListener("click", openModal);

gistCloseBtn.addEventListener("click", () => modal.classList.add("hidden"));

// 点击遮罩关闭
modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.classList.add("hidden");
});

gistCreateBtn.addEventListener("click", async () => {
  const token = gistTokenInput.value.trim();
  if (!token) return showModalError("创建 Gist 前请先填入 Token");
  setModalBusy(true);
  try {
    const url = await sync.createGist(token);
    gistIdInput.value = loadSyncConfig()?.gistId ?? "";
    gistCloseBtn.textContent = "完成";
    console.info("已创建私密 Gist：", url);
  } catch (err) {
    showModalError(err instanceof Error ? err.message : String(err));
  } finally {
    setModalBusy(false);
  }
});

gistSaveBtn.addEventListener("click", async () => {
  const token = gistTokenInput.value.trim();
  const gistId = gistIdInput.value.trim();
  if (!token || !gistId) return showModalError("Token 和 Gist ID 都需要填写");
  setModalBusy(true);
  const ok = await sync.saveConfig({ token, gistId });
  setModalBusy(false);
  if (!ok) {
    showModalError("本地存储写入失败，配置未保存，请检查存储空间");
    return;
  }
  modal.classList.add("hidden");
  void sync.syncNow();
});

gistDisconnectBtn.addEventListener("click", () => {
  void sync.saveConfig(null);
  gistTokenInput.value = "";
  gistIdInput.value = "";
  modal.classList.add("hidden");
});

// ---------- 启动 ----------

input.focus();
render();
// 启动即拉取一次远端（未配置时静默显示“未开启同步”）
void sync.syncNow();
// 自动同步循环：30 秒轮询 + 失败退避重试
sync.startAutoSync();
// 窗口回到前台立即拉一次（手机切回 App、电脑切回窗口时感知另一端改动）
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void sync.syncNow();
});
// 网络恢复立即同步
window.addEventListener("online", () => void sync.syncNow());

// PWA：仅在 http(s) 环境注册（file:// 与 Tauri 自定义协议下跳过）
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("./sw.js").catch(() => {
    /* 注册失败不影响功能 */
  });
}
