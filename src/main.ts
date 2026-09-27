import {
  deletedRecently,
  isDeleted,
  markDeleted,
  saveTodos,
} from "./todo";
import {
  buildToolbar,
  renderList,
  syncFilterMenu,
  syncSortToggle,
  syncViewSwitch,
  type Filter,
  type ViewMode,
} from "./ui";
import { renderBoard } from "./board";
import { renderCalendar } from "./calendar-view";
import { renderTimeline } from "./timeline";
import {
  app,
  captureSnapshot,
  initAppServices,
  persist,
  setCompleted,
  setSortMode,
  setViewMode,
  undoSnapshot,
  updateTodo,
  visibleTodos,
} from "./state";
import { isDragging } from "./drag";
import { SyncController, type SyncStatus } from "./sync";
import { setupNewTodo } from "./new-todo";
import { setupListInteractions } from "./list-interactions";
import { attachSwipeActions } from "./swipe";
import { snoozeTodo } from "./due-scan";
import { setupBatch } from "./batch";
import { setupBackup } from "./backup";
import { setupSyncModal } from "./sync-ui";
import { setupStats } from "./stats";
import { setupThemeToggle } from "./theme";
import { setupShortcuts } from "./shortcuts";
import { notifyDueBatch } from "./due-scan";
import { showUndoToast } from "./toast";
import { syncDueBanner } from "./banner";
import "./style.css";

// ---------- DOM 装配 ----------

const form = document.querySelector<HTMLFormElement>("#todo-form")!;
const input = document.querySelector<HTMLInputElement>("#todo-input")!;
const listEl = document.querySelector<HTMLUListElement>("#todo-list")!;
const { filterButton, filterMenu, sortToggle, viewSwitch, searchInput } = buildToolbar(listEl);

// 全部完成庆祝条 + 完成进度线：toolbar 与列表之间
const progressLine = document.createElement("div");
progressLine.id = "progress-line";
progressLine.className = "progress-line hidden";
progressLine.setAttribute("aria-hidden", "true");
const progressFill = document.createElement("div");
progressFill.className = "progress-line-fill";
progressLine.append(progressFill);
listEl.before(progressLine);

const allDoneBanner = document.createElement("div");
allDoneBanner.id = "all-done";
allDoneBanner.className = "all-done hidden";
allDoneBanner.setAttribute("role", "status");
allDoneBanner.textContent = "🎉 全部完成！歇口气，或者添加新的待办吧";
listEl.before(allDoneBanner);
const footer = document.querySelector<HTMLElement>("#todo-footer")!;
const countEl = document.querySelector<HTMLSpanElement>("#todo-count")!;
const clearBtn = document.querySelector<HTMLButtonElement>("#clear-completed")!;
const clearAllBtn = document.querySelector<HTMLButtonElement>("#clear-all")!;
const statsToggleBtn = document.querySelector<HTMLButtonElement>("#stats-toggle")!;
const statsModal = document.querySelector<HTMLElement>("#stats-modal")!;
const statsCloseBtn = document.querySelector<HTMLButtonElement>("#stats-close")!;
const statsBody = document.querySelector<HTMLElement>("#stats-body")!;
const shortcutsModal = document.querySelector<HTMLElement>("#shortcuts-modal")!;
const shortcutsCloseBtn = document.querySelector<HTMLButtonElement>("#shortcuts-close")!;
const shortcutsToggleBtn = document.querySelector<HTMLButtonElement>("#shortcuts-toggle")!;
const batchToggleBtn = document.querySelector<HTMLButtonElement>("#batch-toggle")!;
const batchBar = document.querySelector<HTMLElement>("#batch-bar")!;
const batchCountEl = document.querySelector<HTMLElement>("#batch-count")!;
const batchAllBtn = document.querySelector<HTMLButtonElement>("#batch-all")!;
const batchDoneBtn = document.querySelector<HTMLButtonElement>("#batch-done")!;
const batchPinBtn = document.querySelector<HTMLButtonElement>("#batch-pin")!;
const batchDeleteBtn = document.querySelector<HTMLButtonElement>("#batch-delete")!;
const batchExitBtn = document.querySelector<HTMLButtonElement>("#batch-exit")!;
const exportBtn = document.querySelector<HTMLButtonElement>("#export-backup")!;
const importBtn = document.querySelector<HTMLButtonElement>("#import-backup")!;
const importFileInput = document.querySelector<HTMLInputElement>("#import-file")!;

const syncDot = document.querySelector<HTMLElement>("#sync-dot")!;
const syncText = document.querySelector<HTMLElement>("#sync-text")!;
const syncNowBtn = document.querySelector<HTMLButtonElement>("#sync-now")!;
const syncSettingsBtn = document.querySelector<HTMLButtonElement>("#sync-settings")!;
const themeToggleBtn = document.querySelector<HTMLButtonElement>("#theme-toggle")!;

const modal = document.querySelector<HTMLElement>("#sync-modal")!;
const gistTokenInput = document.querySelector<HTMLInputElement>("#gist-token")!;
const gistIdInput = document.querySelector<HTMLInputElement>("#gist-id")!;
const modalError = document.querySelector<HTMLElement>("#sync-modal-error")!;
const gistCreateBtn = document.querySelector<HTMLButtonElement>("#gist-create")!;
const gistSaveBtn = document.querySelector<HTMLButtonElement>("#gist-save")!;
const gistDisconnectBtn = document.querySelector<HTMLButtonElement>("#gist-disconnect")!;
const gistCloseBtn = document.querySelector<HTMLButtonElement>("#gist-close")!;
const storageWarning = document.querySelector<HTMLElement>("#storage-warning")!;
const fabAdd = document.querySelector<HTMLButtonElement>("#fab-add")!;
const dueBannerRoot = document.querySelector<HTMLElement>("#due-banner")!;
const dueBannerText = document.querySelector<HTMLElement>("#due-banner-text")!;
const dueBannerViewBtn = document.querySelector<HTMLButtonElement>("#due-banner-view")!;
const dueBannerCloseBtn = document.querySelector<HTMLButtonElement>("#due-banner-close")!;

// ---------- 模块装配 ----------

setupThemeToggle(themeToggleBtn);

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

setupNewTodo(form, input);
setupListInteractions(listEl, { render });

// 移动端滑动操作：右滑完成、左滑删除（批量模式/回收站/行内编辑中停用）
attachSwipeActions(listEl, {
  onComplete: (id) => {
    if (setCompleted(id, true)) persist();
  },
  onDelete: (id) => {
    const current = app.todos.find((t) => t.id === id);
    if (!current || isDeleted(current)) return;
    const snapshot = captureSnapshot();
    updateTodo(id, { deletedAt: Date.now() });
    persist();
    showUndoToast(`已删除「${current.text}」`, () => undoSnapshot(snapshot));
  },
  isActive: () => !app.batchMode && app.view.status !== "deleted" && app.editingId == null,
});
setupBatch(
  {
    toggleBtn: batchToggleBtn,
    exitBtn: batchExitBtn,
    allBtn: batchAllBtn,
    doneBtn: batchDoneBtn,
    pinBtn: batchPinBtn,
    deleteBtn: batchDeleteBtn,
  },
  render,
);
setupBackup(exportBtn, importBtn, importFileInput, {
  modal: document.querySelector<HTMLElement>("#import-modal")!,
  errorEl: document.querySelector<HTMLElement>("#import-error")!,
  summaryEl: document.querySelector<HTMLElement>("#import-summary")!,
  newEl: document.querySelector<HTMLElement>("#import-new")!,
  updateEl: document.querySelector<HTMLElement>("#import-update")!,
  skipEl: document.querySelector<HTMLElement>("#import-skip")!,
  confirmBtn: document.querySelector<HTMLButtonElement>("#import-confirm")!,
  cancelBtn: document.querySelector<HTMLButtonElement>("#import-cancel")!,
});
setupStats(
  { toggleBtn: statsToggleBtn, modal: statsModal, closeBtn: statsCloseBtn, body: statsBody },
  () => app.todos,
);
setupShortcuts({
  newTodoInput: input,
  searchInput,
  helpModal: shortcutsModal,
  helpCloseBtn: shortcutsCloseBtn,
  helpToggleBtn: shortcutsToggleBtn,
});
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
      app.view = { status: "today" };
      render();
    },
  );
  syncFilter();

  const deletedView = app.view.status === "deleted";
  const listView = app.viewMode === "list";
  form.classList.toggle("hidden", deletedView);
  // FAB 与新建表单互斥显示（回收站不提供新建）
  fabAdd.classList.toggle("hidden", deletedView);
  // 批量条是列表视图专属；非列表视图显示的是全部未完成任务，状态筛选不参与
  batchBar.classList.toggle("hidden", !app.batchMode || deletedView || !listView);
  footer.classList.toggle("hidden", deletedView || (app.batchMode && listView));

  syncViewSwitch(viewSwitch, app.viewMode);

  if (app.viewMode !== "list") {
    // 看板/日历/时间线：展示全部未完成任务（状态筛选是列表视图概念）
    renderAlternateView(listEl);
  } else if (app.editingId == null) {
    // 行内编辑中不重建列表（编辑框会被打断）；编辑结束经 persist/render 补上
    renderList(
      listEl,
      visibleTodos(),
      deletedView
        ? "回收站是空的"
        : app.todos.some((t) => !isDeleted(t))
          ? "没有匹配的待办，试试调整筛选或搜索词"
          : "这里空空如也，添加一条待办吧～",
      {
        deleted: deletedView,
        batch: app.batchMode,
        selected: app.selectedIds,
        emptyIcon: deletedView ? "🗑" : app.todos.some((t) => !isDeleted(t)) ? "🔍" : "🌱",
        // 「即将到期」视图按天分组（Todoist Upcoming 风）
        groupByDue: app.view.status === "soon" && !app.batchMode,
      },
    );
  }

  // 完成进度线：现存条目的完成占比（回收站/批量模式隐藏）
  const live = app.todos.filter((t) => !isDeleted(t));
  const deletedCount = app.todos.filter((t) => deletedRecently(t)).length;
  const doneCount = live.filter((t) => t.completed).length;
  const showProgress = !deletedView && !app.batchMode && live.length > 0;
  progressLine.classList.toggle("hidden", !showProgress);
  if (showProgress) {
    progressFill.style.width = `${Math.round((doneCount / live.length) * 100)}%`;
    progressLine.title = `已完成 ${doneCount}/${live.length}`;
  }
  if (deletedView) {
    countEl.textContent = `回收站 ${deletedCount} 项，保留 30 天后自动清除`;
  } else {
    const remaining = live.filter((t) => !t.completed).length;
    countEl.textContent = `剩余 ${remaining} 项未完成`;
    clearBtn.classList.toggle("hidden", !live.some((t) => t.completed));
    batchToggleBtn.classList.toggle("hidden", live.length === 0);
  }
  // 全部完成庆祝：有未删条目且全部已完成时亮起（回收站/批量模式不显示）
  const allDone = !deletedView && !app.batchMode && live.length > 0 && live.every((t) => t.completed);
  allDoneBanner.classList.toggle("hidden", !allDone);
  batchCountEl.textContent = `已选 ${app.selectedIds.size} 项`;
}

/** 非列表视图分发：看板 / 日历 / 时间线 */
function renderAlternateView(container: HTMLElement): void {
  const mode: ViewMode = app.viewMode;
  const hooks = {
    onComplete: (id: string) => {
      if (setCompleted(id, true)) persist();
    },
    onDelete: (id: string) => {
      const current = app.todos.find((t) => t.id === id);
      if (!current || isDeleted(current)) return;
      const snapshot = captureSnapshot();
      updateTodo(id, { deletedAt: Date.now() });
      persist();
      showUndoToast(`已删除「${current.text}」`, () => undoSnapshot(snapshot));
    },
    isActive: () => app.editingId == null,
  };
  const calendarHooks = {
    ...hooks,
    onPickDate: (date: string) => {
      // 快速排程：填入日期并聚焦输入框（回列表视图完成输入）
      const due = document.querySelector<HTMLInputElement>("#new-todo-due");
      if (due) {
        due.value = date;
        due.classList.remove("is-empty");
        document.querySelector<HTMLInputElement>("#todo-input")?.focus();
      }
    },
  };
  if (mode === "board") {
    renderBoard(container, app.todos, hooks);
  } else if (mode === "calendar") {
    renderCalendar(container, app.todos, calendarHooks);
  } else {
    renderTimeline(container, app.todos);
  }
}

/** 复合筛选同步：按当前视图态刷新按钮与菜单 */
function syncFilter(): void {
  syncFilterMenu(filterButton, filterMenu, app.view);
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

// ---------- 底部快速添加 FAB（仅移动端显示） ----------

// 点击：滚回顶部并聚焦输入框（聚焦会自动滑出分类/日期选项区）
fabAdd.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
  input.focus();
});

// ---------- 排序模式 ----------

// 手动（拖动/键盘排序）⇄ 按截止时间（近的在前）；偏好持久化在设备本地
sortToggle.addEventListener("click", () => {
  setSortMode(app.sortMode === "due" ? "manual" : "due");
  syncSortToggle(sortToggle, app.sortMode);

// 视图模式切换（设备本地偏好）
viewSwitch.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-vm]");
  if (!btn) return;
  setViewMode(btn.dataset.vm as ViewMode);
  syncViewSwitch(viewSwitch, app.viewMode);
  render();
});
syncViewSwitch(viewSwitch, app.viewMode);
  render();
});
syncSortToggle(sortToggle, app.sortMode);

// 视图模式切换（设备本地偏好）
viewSwitch.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-vm]");
  if (!btn) return;
  setViewMode(btn.dataset.vm as ViewMode);
  syncViewSwitch(viewSwitch, app.viewMode);
  render();
});
syncViewSwitch(viewSwitch, app.viewMode);

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
  const value = opt.dataset.value ?? "";
  const isActive = app.view.status === value;
  app.view = isActive ? { status: "all" } : { status: value as Filter };
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

// PWA：仅在 http(s) 生产环境注册（file:// 与 Tauri 自定义协议下跳过）。
// dev 模式绝不注册：SW 对同源静态资源是缓存优先，会把 Vite 的模块与 HMR 更新永久钉在旧版本。
if ("serviceWorker" in navigator && !import.meta.env.DEV && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("./sw.js").catch(() => {
    /* 注册失败不影响功能 */
  });
}

// 到期通知操作按钮的回传：SW notificationclick → postMessage → 这里落地
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    const msg = e.data as { type?: string; id?: string } | undefined;
    if (!msg || typeof msg.id !== "string") return;
    if (msg.type === "notify-complete") {
      if (setCompleted(msg.id, true)) persist();
    } else if (msg.type === "notify-snooze") {
      snoozeTodo(msg.id);
    }
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
