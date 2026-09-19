import {
  createTodo,
  isDeleted,
  isOverdue,
  isValidDueDate,
  loadTodos,
  markDeleted,
  nextAppendOrder,
  normalizeCategory,
  saveTodos,
  sortTodos,
  type Todo,
} from "./todo";
import {
  applyFilter,
  buildSelectOption,
  buildToolbar,
  categoryOptions,
  renderList,
  syncFilterMenu,
  type Filter,
  type View,
} from "./ui";
import { ensurePermission, notifyTodoDue } from "./notify";
import { SyncController, loadSyncConfig, loadSyncGistId, type SyncStatus } from "./sync";
import {
  CommandStack,
  applyForward,
  applyInverse,
  loadUndoState,
  makeClearAllCommand,
  makeCreateCommand,
  makeDeleteCommand,
  makeUpdateCommand,
} from "./undo";
import "./style.css";

const form = document.querySelector<HTMLFormElement>("#todo-form")!;
const input = document.querySelector<HTMLInputElement>("#todo-input")!;
const listEl = document.querySelector<HTMLUListElement>("#todo-list")!;
const { filterButton, filterMenu, undoBtn, redoBtn, newCategoryInput, addCategoryBtn, categoryHint } =
  buildToolbar(listEl);
const footer = document.querySelector<HTMLElement>("#todo-footer")!;
const countEl = document.querySelector<HTMLSpanElement>("#todo-count")!;
const clearBtn = document.querySelector<HTMLButtonElement>("#clear-completed")!;
const clearAllBtn = document.querySelector<HTMLButtonElement>("#clear-all")!;

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
/** 命令栈：仅本地持久化、不同步 Gist；命令应用与入栈见各交互处理器 */
const stack = new CommandStack(loadUndoState());
/** 视图态：只影响渲染，不碰数据、不写存储、不触发同步 */
let view: View = { category: "__all__", status: "all" };
/** 手动新建的分类：仅内存（不持久化，重启消失且无数据风险），与派生集合合并后进入各下拉框 */
const manualCategories = new Set<string>();

const sync = new SyncController({
  onTodos: (merged) => {
    todos = merged;
    render();
  },
  onStatus: renderSyncStatus,
});

function render(): void {
  const categories = [...categoryOptions(todos), ...manualCategories].sort((a, b) =>
    a.localeCompare(b, "zh"),
  );
  syncFilter(categories);
  syncNewTodoCategory(categories);

  renderList(
    listEl,
    applyFilter(sortTodos(todos), view),
    todos.some((t) => !isDeleted(t))
      ? "该筛选下暂无待办"
      : "这里空空如也，添加一条待办吧～",
    categories,
  );

  const live = todos.filter((t) => !isDeleted(t));
  const remaining = live.filter((t) => !t.completed).length;
  countEl.textContent = `剩余 ${remaining} 项未完成`;
  footer.classList.toggle("hidden", live.length === 0);
  clearBtn.classList.toggle("hidden", !live.some((t) => t.completed));
  undoBtn.disabled = !stack.canUndo;
  redoBtn.disabled = !stack.canRedo;
}

/** 复合筛选同步：分类消失（最后一条被删）时回退未筛选，再按当前视图态刷新按钮与菜单 */
function syncFilter(categories: string[]): void {
  if (
    view.category !== "__all__" &&
    view.category !== "__uncat__" &&
    !categories.includes(view.category)
  ) {
    view.category = "__all__";
  }
  syncFilterMenu(filterButton, filterMenu, categories, view);
}

function persist(): void {
  // 写入失败（如配额超限）时亮起顶栏提示，恢复后自动隐藏
  storageWarning.classList.toggle("hidden", saveTodos(todos));
  sync.onLocalChange();
  render();
}

// ---------- 过期通知（阶段 5）----------

/** 单条即时通知：过期且未通知 → 发送并标记 notified；未授权/发送失败不标记，下次触发重试 */
async function notifyTodoOnce(todo: Todo): Promise<void> {
  if (todo.notified || !isOverdue(todo)) return;
  if (!(await ensurePermission())) return;
  try {
    await notifyTodoDue(todo);
  } catch {
    return; // 系统通知服务失败：静默降级，不阻塞主流程
  }
  // 标记不 bump updatedAt：通知是设备本地 UX 状态，不参与 LWW 竞争
  todos = todos.map((t) => (t.id === todo.id ? { ...t, notified: true } : t));
  persist();
}

/** 启动批量：全部过期未通知条目各发一条；单条失败跳过，成功者统一落盘一次 */
async function notifyOverdueStartup(): Promise<void> {
  const targets = todos.filter((t) => isOverdue(t) && !t.notified);
  if (targets.length === 0) return;
  if (!(await ensurePermission())) return;
  let changed = false;
  for (const todo of targets) {
    try {
      await notifyTodoDue(todo);
    } catch {
      continue;
    }
    todos = todos.map((t) => (t.id === todo.id ? { ...t, notified: true } : t));
    changed = true;
  }
  if (changed) persist();
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
  // 极罕见竞态：选中的分类在提交前已消失（无引用且非手动新建）→ 降级为未分类，不丢待办
  const known = new Set([...categoryOptions(todos), ...manualCategories]);
  const rawCategory = newTodoCategory.value;
  const category = rawCategory && known.has(rawCategory) ? normalizeCategory(rawCategory) : undefined;
  const todo = createTodo(text);
  if (category) todo.category = category; // createdAt = updatedAt = now 已由 createTodo 设定
  // 新项默认排末尾：创建即赋末序（末项 + STEP，空表从 STEP 起，任务书 ⑤）
  todo.order = nextAppendOrder(todos);
  // 追加到数组末尾：显示顺序由 sortTodos（order/createdAt 升序）权威决定（DECISIONS.md D1）
  todos.push(todo);
  stack.push(makeCreateCommand(todo));
  input.value = ""; // 分类下拉保留当前选中，便于连续录入同一分类
  persist();
  // 即时到期检查：新建表单暂无日期输入，当前恒不触发；为后续表单扩展预留（任务 D）
  void notifyTodoOnce(todo);
});

// 部分内嵌浏览器不触发表单隐式提交，keydown 兜底；preventDefault 避免双重提交
input.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  form.requestSubmit();
});

// 新增表单的分类选择器：插在输入框与提交按钮之间，选项每次渲染后同步更新
const newTodoCategory = document.createElement("select");
newTodoCategory.id = "new-todo-category";
newTodoCategory.className = "new-todo-category";
newTodoCategory.setAttribute("aria-label", "新待办的分类");
form.insertBefore(
  newTodoCategory,
  form.querySelector<HTMLButtonElement>("button[type=submit]"),
);

/** 选项 = 未分类("") + 派生分类 + 手动新建；保留当前选中（连续录入），无则按视图态默认 */
function syncNewTodoCategory(categories: string[]): void {
  const previous = newTodoCategory.value;
  newTodoCategory.replaceChildren();
  const uncat = buildSelectOption("", "未分类");
  newTodoCategory.append(
    uncat,
    ...categories.map((name) => buildSelectOption(name, name)),
  );
  const fallback =
    view.category !== "__all__" &&
    view.category !== "__uncat__" &&
    categories.includes(view.category)
      ? view.category
      : "";
  newTodoCategory.value = previous && categories.includes(previous) ? previous : fallback;
}

listEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const item = target.closest<HTMLElement>(".todo-item");
  if (!item) return;
  const id = item.dataset.id;
  if (id === undefined) return;
  const current = todos.find((t) => t.id === id);
  if (!current) return;
  if (target.classList.contains("todo-toggle")) {
    const completed = !current.completed;
    todos = todos.map((t) => (t.id === id ? { ...t, completed, updatedAt: Date.now() } : t));
    stack.push(makeUpdateCommand(id, { completed: current.completed }, { completed }));
  } else if (target.classList.contains("todo-delete")) {
    if (isDeleted(current)) return;
    todos = todos.map((t) => (t.id === id ? markDeleted(t) : t));
    stack.push(makeDeleteCommand(current));
  } else {
    return;
  }
  persist();
});

// 行内控件（分类 select / 日期 input）：change 才写数据并落盘；渲染时直接赋 .value 不触发事件，无回写死循环
listEl.addEventListener("change", (e) => {
  const target = e.target as HTMLSelectElement | HTMLInputElement;
  const item = target.closest<HTMLElement>(".todo-item");
  if (!item) return;
  const current = todos.find((t) => t.id === item.dataset.id);
  if (!current) return;
  let updated: Todo | undefined;

  if (target.classList.contains("todo-category")) {
    const next = target.value === "__uncat__" ? undefined : normalizeCategory(target.value);
    if ((current.category ?? undefined) === (next ?? undefined)) return;
    todos = todos.map((t) => {
      if (t.id !== current.id) return t;
      updated = { ...t, category: next, updatedAt: Date.now() };
      return updated;
    });
    stack.push(
      makeUpdateCommand(
        current.id,
        { category: current.category ?? null },
        { category: next ?? null },
      ),
    );
  } else if (target.classList.contains("todo-due")) {
    const next = isValidDueDate(target.value) ? target.value : undefined; // 非法输入按清空处理，不报错
    if ((current.dueDate ?? undefined) === (next ?? undefined)) return;
    todos = todos.map((t) => {
      if (t.id !== current.id) return t;
      updated = { ...t, dueDate: next, updatedAt: Date.now() };
      return updated;
    });
    stack.push(
      makeUpdateCommand(current.id, { dueDate: current.dueDate ?? null }, { dueDate: next ?? null }),
    );
  } else {
    return;
  }
  persist();
  // 即时到期检查：改日期为过期值 → 立即通知并标记；改分类时 isOverdue 恒为否、自然跳过
  if (updated) void notifyTodoOnce(updated);
});

// ---------- 撤销 / 重做 ----------

function doUndo(): void {
  const cmd = stack.popUndo();
  if (!cmd) return; // 空栈无副作用不报错
  todos = applyInverse(cmd, todos);
  stack.pushRedo(cmd);
  persist();
}

function doRedo(): void {
  const cmd = stack.popRedo();
  if (!cmd) return;
  todos = applyForward(cmd, todos);
  stack.push(cmd); // push 清空 redo：重做后产生新动作即分叉的正常语义
  persist();
}

undoBtn.addEventListener("click", doUndo);
redoBtn.addEventListener("click", doRedo);

// 全局快捷键：Ctrl+Z / Ctrl+Shift+Z（Mac 兼容 Cmd）；输入框聚焦时交给原生文本撤销，屏蔽全局撤销
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (e.key.toLowerCase() !== "z") return;
  const el = document.activeElement;
  const typing =
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLElement && el.isContentEditable);
  if (typing) return;
  e.preventDefault();
  if (e.shiftKey) doRedo();
  else doUndo();
});

// ---------- 复合筛选（分类/状态二选一） ----------

function closeFilterMenu(): void {
  filterMenu.classList.remove("open");
  filterButton.setAttribute("aria-expanded", "false");
}

// 按钮：开合菜单
filterButton.addEventListener("click", () => {
  const open = !filterMenu.classList.contains("open");
  filterMenu.classList.toggle("open", open);
  filterButton.setAttribute("aria-expanded", String(open));
});

// 选项：设置视图态后 rAF 重渲染；同项再点 = 取消筛选恢复「全部待办」
filterMenu.addEventListener("click", (e) => {
  const opt = (e.target as HTMLElement).closest<HTMLElement>("[data-kind]");
  if (!opt) return;
  const kind = opt.dataset.kind;
  const value = opt.dataset.value ?? "";
  const isActive =
    kind === "category"
      ? view.category === value && view.status === "all"
      : kind === "status" && view.status === value && view.category === "__all__";
  view = isActive
    ? { category: "__all__", status: "all" }
    : kind === "category"
      ? { category: value, status: "all" }
      : { category: "__all__", status: value as Filter };
  closeFilterMenu();
  requestAnimationFrame(render);
});

// 键盘可达：选项获得焦点时 Enter/Space 视同点击
filterMenu.addEventListener("keydown", (e) => {
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
  if (manualCategories.has(name) || categoryOptions(todos).includes(name)) {
    return showCategoryHint(`分类「${name}」已存在`);
  }
  manualCategories.add(name);
  newCategoryInput.value = "";
  showCategoryHint(`已添加「${name}」`);
  render();
});

clearBtn.addEventListener("click", () => {
  // 批量清除记为单条命令（可一次撤销恢复）；无已完成条目时不产生命令
  const targets = todos.filter((t) => !isDeleted(t) && t.completed);
  if (targets.length === 0) return;
  todos = todos.map((t) => (!isDeleted(t) && t.completed ? markDeleted(t) : t));
  stack.push(makeClearAllCommand(targets));
  persist();
});

// 清除全部：confirm 二次确认后给全部现存条目打墓碑（不能物理清空数组，
// 否则远端仍存有这些条目，下次同步会按 LWW 全部复活）；记为单条命令，一次撤销可全部恢复
clearAllBtn.addEventListener("click", () => {
  if (!confirm("确定要清除全部待办吗？清除后可通过撤销恢复")) return;
  const targets = todos.filter((t) => !isDeleted(t));
  todos = todos.map((t) => (isDeleted(t) ? t : markDeleted(t)));
  stack.push(makeClearAllCommand(targets));
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
// 启动批量过期通知：N 条过期未通知各发一条；权限未授予/失败静默降级
void notifyOverdueStartup();
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
