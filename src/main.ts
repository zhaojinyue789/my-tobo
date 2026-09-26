import {
  deletedRecently,
  isDeleted,
  markDeleted,
  normalizeCategory,
  saveTodos,
} from "./todo";
import { buildToolbar, categoryOptions, renderList, syncFilterMenu, type Filter } from "./ui";
import {
  app,
  captureSnapshot,
  initAppServices,
  manualCategories,
  persist,
  saveManualCategories,
  undoSnapshot,
  visibleTodos,
} from "./state";
import { isDragging } from "./drag";
import { SyncController, type SyncStatus } from "./sync";
import { setupNewTodo } from "./new-todo";
import { setupListInteractions } from "./list-interactions";
import { setupBatch, syncBatchCategory } from "./batch";
import { setupBackup } from "./backup";
import { setupSyncModal } from "./sync-ui";
import { notifyDueBatch } from "./due-scan";
import { showUndoToast } from "./toast";
import { syncDueBanner } from "./banner";
import "./style.css";

// ---------- DOM 装配 ----------

const form = document.querySelector<HTMLFormElement>("#todo-form")!;
const input = document.querySelector<HTMLInputElement>("#todo-input")!;
const listEl = document.querySelector<HTMLUListElement>("#todo-list")!;
const { filterButton, filterMenu, searchInput, newCategoryInput, addCategoryBtn, categoryHint } =
  buildToolbar(listEl);
const footer = document.querySelector<HTMLElement>("#todo-footer")!;
const countEl = document.querySelector<HTMLSpanElement>("#todo-count")!;
const clearBtn = document.querySelector<HTMLButtonElement>("#clear-completed")!;
const clearAllBtn = document.querySelector<HTMLButtonElement>("#clear-all")!;
const batchToggleBtn = document.querySelector<HTMLButtonElement>("#batch-toggle")!;
const batchBar = document.querySelector<HTMLElement>("#batch-bar")!;
const batchCountEl = document.querySelector<HTMLElement>("#batch-count")!;
const batchAllBtn = document.querySelector<HTMLButtonElement>("#batch-all")!;
const batchDoneBtn = document.querySelector<HTMLButtonElement>("#batch-done")!;
const batchPinBtn = document.querySelector<HTMLButtonElement>("#batch-pin")!;
const batchDeleteBtn = document.querySelector<HTMLButtonElement>("#batch-delete")!;
const batchCategory = document.querySelector<HTMLSelectElement>("#batch-category")!;
const batchExitBtn = document.querySelector<HTMLButtonElement>("#batch-exit")!;
const exportBtn = document.querySelector<HTMLButtonElement>("#export-backup")!;
const importBtn = document.querySelector<HTMLButtonElement>("#import-backup")!;
const importFileInput = document.querySelector<HTMLInputElement>("#import-file")!;

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
const dueBannerRoot = document.querySelector<HTMLElement>("#due-banner")!;
const dueBannerText = document.querySelector<HTMLElement>("#due-banner-text")!;
const dueBannerViewBtn = document.querySelector<HTMLButtonElement>("#due-banner-view")!;
const dueBannerCloseBtn = document.querySelector<HTMLButtonElement>("#due-banner-close")!;

// ---------- 模块装配 ----------

const sync = new SyncController({
  onTodos: (merged) => {
    app.todos = merged;
    render();
  },
  onStatus: renderSyncStatus,
});

initAppServices({
  save: () => {
    // 写入失败（如配额超限）时亮起顶栏提示，恢复后自动隐藏
    storageWarning.classList.toggle("hidden", saveTodos(app.todos));
  },
  onLocalChange: () => sync.onLocalChange(),
  render: () => render(),
});

const { syncNewTodoCategory } = setupNewTodo(form, input);
setupListInteractions(listEl, { render });
setupBatch(
  {
    toggleBtn: batchToggleBtn,
    exitBtn: batchExitBtn,
    allBtn: batchAllBtn,
    doneBtn: batchDoneBtn,
    pinBtn: batchPinBtn,
    deleteBtn: batchDeleteBtn,
    categorySelect: batchCategory,
  },
  render,
);
setupBackup(exportBtn, importBtn, importFileInput);
setupSyncModal(
  {
    settingsBtn: syncSettingsBtn,
    modal,
    gistTokenInput,
    gistIdInput,
    modalError,
    gistCreateBtn,
    gistSaveBtn,
    gistDisconnectBtn,
    gistCloseBtn,
  },
  sync,
);

// ---------- 渲染 ----------

function render(): void {
  // 拖动中重建列表会扯断拖动；拖完 onDrop → persist → render 会补上这次刷新
  if (isDragging()) return;
  // 页内过期提醒横幅（纯浏览器无系统通知的兜底路径）
  syncDueBanner(
    { root: dueBannerRoot, text: dueBannerText, viewBtn: dueBannerViewBtn, closeBtn: dueBannerCloseBtn },
    () => {
      app.view = { category: "__all__", status: "today" };
      render();
    },
  );
  // 派生分类与手动新建合并去重：手动分类被赋给条目后会同时出现在两个来源
  const categories = [...new Set([...categoryOptions(app.todos), ...manualCategories])].sort(
    (a, b) => a.localeCompare(b, "zh"),
  );
  syncFilter(categories);
  syncNewTodoCategory(categories);
  syncBatchCategory(categories, batchCategory);

  const deletedView = app.view.status === "deleted";
  form.classList.toggle("hidden", deletedView);
  batchBar.classList.toggle("hidden", !app.batchMode || deletedView);
  footer.classList.toggle("hidden", deletedView || app.batchMode);

  // 行内编辑中不重建列表（编辑框会被打断）；编辑结束经 persist/render 补上
  if (app.editingId == null) {
    renderList(
      listEl,
      visibleTodos(),
      deletedView
        ? "回收站是空的"
        : app.todos.some((t) => !isDeleted(t))
          ? "该筛选下暂无待办"
          : "这里空空如也，添加一条待办吧～",
      categories,
      { deleted: deletedView, batch: app.batchMode, selected: app.selectedIds },
    );
  }

  const live = app.todos.filter((t) => !isDeleted(t));
  const deletedCount = app.todos.filter((t) => deletedRecently(t)).length;
  if (deletedView) {
    countEl.textContent = `回收站 ${deletedCount} 项，保留 30 天后自动清除`;
  } else {
    const remaining = live.filter((t) => !t.completed).length;
    countEl.textContent = `剩余 ${remaining} 项未完成`;
    clearBtn.classList.toggle("hidden", !live.some((t) => t.completed));
    batchToggleBtn.classList.toggle("hidden", live.length === 0);
  }
  batchCountEl.textContent = `已选 ${app.selectedIds.size} 项`;
}

/** 复合筛选同步：分类消失（最后一条被删）时回退未筛选，再按当前视图态刷新按钮与菜单 */
function syncFilter(categories: string[]): void {
  if (
    app.view.category !== "__all__" &&
    app.view.category !== "__uncat__" &&
    !categories.includes(app.view.category)
  ) {
    app.view.category = "__all__";
  }
  syncFilterMenu(filterButton, filterMenu, categories, app.view);
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

// ---------- 清除动作（footer，均带撤销窗口） ----------

clearBtn.addEventListener("click", () => {
  const count = app.todos.filter((t) => !isDeleted(t) && t.completed).length;
  if (count === 0) return;
  const snapshot = captureSnapshot();
  const now = Date.now();
  app.todos = app.todos.map((t) =>
    !isDeleted(t) && t.completed ? { ...t, deletedAt: now, updatedAt: now } : t,
  );
  persist();
  showUndoToast(`已清除 ${count} 项已完成`, () => undoSnapshot(snapshot));
});

// 清除全部：confirm 二次确认 + 撤销窗口双保险（不能物理清空数组，
// 否则远端仍存有这些条目，下次同步会按 LWW 全部复活）；persist() 内部触发防抖自动同步
clearAllBtn.addEventListener("click", () => {
  if (!confirm("确定要清除全部待办吗？清除后不可恢复")) return;
  const snapshot = captureSnapshot();
  app.todos = app.todos.map((t) => (isDeleted(t) ? t : markDeleted(t)));
  persist();
  showUndoToast("已清除全部待办", () => undoSnapshot(snapshot));
});

// ---------- 复合筛选（分类/状态二选一） ----------

function closeFilterMenu(): void {
  filterMenu.classList.remove("open");
  filterButton.setAttribute("aria-expanded", "false");
}

// 按钮：开合菜单；展开时把焦点放到选中项（无则首项），符合 listbox 键盘模型
filterButton.addEventListener("click", () => {
  const open = !filterMenu.classList.contains("open");
  filterMenu.classList.toggle("open", open);
  filterButton.setAttribute("aria-expanded", String(open));
  if (open) {
    const target =
      filterMenu.querySelector<HTMLElement>("[aria-selected='true']") ??
      filterMenu.querySelector<HTMLElement>("[role='option']");
    target?.focus();
  }
});

// 选项：设置视图态后立即重渲染；同项再点 = 取消筛选恢复「全部待办」
// （不用 rAF：后台/无焦点面板会暂停 rAF，导致切筛选后界面不刷新）
filterMenu.addEventListener("click", (e) => {
  const opt = (e.target as HTMLElement).closest<HTMLElement>("[data-kind]");
  if (!opt) return;
  const kind = opt.dataset.kind;
  const value = opt.dataset.value ?? "";
  const isActive =
    kind === "category"
      ? app.view.category === value && app.view.status === "all"
      : kind === "status" && app.view.status === value && app.view.category === "__all__";
  app.view = isActive
    ? { category: "__all__", status: "all" }
    : kind === "category"
      ? { category: value, status: "all" }
      : { category: "__all__", status: value as Filter };
  closeFilterMenu();
  render();
});

// 键盘可达：Enter/Space 视同点击；方向键/Home/End 在选项间移动（标准 listbox 模型）；
// Esc 收起并把焦点还给按钮
filterMenu.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.stopPropagation(); // 全局 Esc 只做收起，这里的收起还带焦点归还
    closeFilterMenu();
    filterButton.focus();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
    e.preventDefault();
    const opts = [...filterMenu.querySelectorAll<HTMLElement>("[data-kind]")];
    if (opts.length === 0) return;
    const i = opts.indexOf(document.activeElement as HTMLElement);
    const j =
      e.key === "ArrowDown"
        ? i < 0
          ? 0
          : Math.min(i + 1, opts.length - 1)
        : e.key === "ArrowUp"
          ? i < 0
            ? 0
            : Math.max(i - 1, 0)
          : e.key === "Home"
            ? 0
            : opts.length - 1;
    opts[j].focus();
    return;
  }
  if (e.key !== "Enter" && e.key !== " ") return;
  const opt = (e.target as HTMLElement).closest<HTMLElement>("[data-kind]");
  if (!opt) return;
  e.preventDefault();
  opt.click();
});

// 点击按钮/菜单以外或按 Esc 收起菜单
document.addEventListener("click", (e) => {
  const target = e.target as Node;
  if (filterMenu.contains(target) || filterButton.contains(target)) return;
  closeFilterMenu();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeFilterMenu();
});

// ---------- 文本搜索（120ms 防抖：每键全量重渲染在数百条时会卡顿） ----------

let searchTimer: ReturnType<typeof setTimeout> | undefined;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    app.searchTerm = searchInput.value;
    render();
  }, 120);
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  e.stopPropagation(); // 不触发全局 Esc（只关筛选菜单）的语义混叠
  clearTimeout(searchTimer);
  searchInput.value = "";
  app.searchTerm = "";
  render();
  searchInput.blur();
});
// Ctrl/Cmd+F 聚焦搜索
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

// ---------- 新建分类 ----------

// 新建分类：不产生独立实体，仅加入内存集合；空值/重复拒绝
let hintTimer: ReturnType<typeof setTimeout> | undefined;
function showCategoryHint(message: string): void {
  categoryHint.textContent = message;
  categoryHint.classList.remove("hidden");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => categoryHint.classList.add("hidden"), 2500);
}

addCategoryBtn.addEventListener("click", () => {
  const name = normalizeCategory(newCategoryInput.value);
  if (!name) return showCategoryHint("分类名不能为空或含非法字符");
  if (manualCategories.has(name) || categoryOptions(app.todos).includes(name)) {
    return showCategoryHint(`分类「${name}」已存在`);
  }
  manualCategories.add(name);
  saveManualCategories();
  newCategoryInput.value = "";
  showCategoryHint(`已添加「${name}」`);
  render();
});

// ---------- 同步 ----------

syncNowBtn.addEventListener("click", () => void sync.syncNow());

// ---------- 启动 ----------

input.focus();
render();
// 启动批量过期通知：N 条过期未通知各发一条；权限未授予/失败静默降级
void notifyDueBatch();
// 运行中分钟级扫描：跨天报过期、到点报到期、前一天提醒（应用长期开着也不漏）
const DUE_POLL_MS = 60 * 1000;
setInterval(() => void notifyDueBatch(), DUE_POLL_MS);
// 启动即拉取一次远端（未配置时静默显示“未开启同步”）
void sync.syncNow();
// 自动同步循环：30 秒轮询 + 失败退避重试
sync.startAutoSync();
// 窗口回到前台立即拉一次（手机切回 App、电脑切回窗口时感知另一端改动），顺带扫到期
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void sync.syncNow();
    void notifyDueBatch();
  }
});
// 网络恢复立即同步
window.addEventListener("online", () => void sync.syncNow());

// PWA：仅在 http(s) 环境注册（file:// 与 Tauri 自定义协议下跳过）
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("./sw.js").catch(() => {
    /* 注册失败不影响功能 */
  });
}

// 桌面快速添加：全局快捷键 Alt+Shift+T 唤起/隐藏窗口并聚焦输入框（仅 Tauri 端，浏览器无此 API）
if ("__TAURI_INTERNALS__" in window) {
  void (async () => {
    try {
      const [{ register }, { getCurrentWindow }] = await Promise.all([
        import("@tauri-apps/plugin-global-shortcut"),
        import("@tauri-apps/api/window"),
      ]);
      const win = getCurrentWindow();
      await register("Alt+Shift+T", async () => {
        try {
          if (await win.isVisible()) {
            await win.hide();
          } else {
            await win.show();
            await win.setFocus();
            input.focus();
          }
        } catch {
          /* 窗口操作失败静默 */
        }
      });
    } catch (err) {
      console.warn("[my-tobo] 全局快捷键注册失败（不影响其他功能）：", err);
    }
  })();
}
