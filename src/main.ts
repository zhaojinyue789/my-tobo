import {
  createTodo,
  isDeleted,
  isOverdue,
  isValidCategory,
  isValidDueDate,
  loadTodos,
  markDeleted,
  normalizeCategory,
  orderBetween,
  saveTodos,
  topOrder,
  withOrder,
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
import { attachDragReorder, isDragging } from "./drag";
import { ensurePermission, notifyTodoDue } from "./notify";
import { SyncController, loadSyncConfig, loadSyncGistId, type SyncStatus } from "./sync";
import "./style.css";

const form = document.querySelector<HTMLFormElement>("#todo-form")!;
const input = document.querySelector<HTMLInputElement>("#todo-input")!;
const listEl = document.querySelector<HTMLUListElement>("#todo-list")!;
const { filterButton, filterMenu, newCategoryInput, addCategoryBtn, categoryHint } =
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
/** 视图态：只影响渲染，不碰数据、不写存储、不触发同步 */
let view: View = { category: "__all__", status: "all" };
/** 行内编辑中的条目 id：编辑期间 render 跳过列表重建，防止编辑框被打断 */
let editingId: string | null = null;

const MANUAL_CATEGORIES_KEY = "my-tobo.manual-categories";

/** 手动新建的分类：持久化（重启保留），与派生集合合并后进入各下拉框 */
const manualCategories = loadManualCategories();

function loadManualCategories(): Set<string> {
  try {
    const raw = localStorage.getItem(MANUAL_CATEGORIES_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(arr)
        ? arr.filter((v): v is string => typeof v === "string" && isValidCategory(v))
        : [],
    );
  } catch {
    return new Set();
  }
}

function saveManualCategories(): void {
  try {
    localStorage.setItem(MANUAL_CATEGORIES_KEY, JSON.stringify([...manualCategories]));
  } catch {
    /* 写失败静默：下次添加分类时重写 */
  }
}

const sync = new SyncController({
  onTodos: (merged) => {
    todos = merged;
    render();
  },
  onStatus: renderSyncStatus,
});

function render(): void {
  // 拖动中重建列表会扯断拖动；拖完 onDrop → persist → render 会补上这次刷新
  if (isDragging()) return;
  // 派生分类与手动新建合并去重：手动分类被赋给条目后会同时出现在两个来源
  const categories = [...new Set([...categoryOptions(todos), ...manualCategories])].sort((a, b) =>
    a.localeCompare(b, "zh"),
  );
  syncFilter(categories);
  syncNewTodoCategory(categories);

  // 行内编辑中不重建列表（编辑框会被打断）；编辑结束经 persist/render 补上
  if (editingId == null) {
    renderList(
      listEl,
      applyFilter(todos, view),
      todos.some((t) => !isDeleted(t))
        ? "该筛选下暂无待办"
        : "这里空空如也，添加一条待办吧～",
      categories,
    );
  }

  const live = todos.filter((t) => !isDeleted(t));
  const remaining = live.filter((t) => !t.completed).length;
  countEl.textContent = `剩余 ${remaining} 项未完成`;
  footer.classList.toggle("hidden", live.length === 0);
  clearBtn.classList.toggle("hidden", !live.some((t) => t.completed));
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

/** 批量扫描：全部过期未通知条目各发一条；单条失败跳过，成功者统一落盘一次 */
async function notifyOverdueBatch(): Promise<void> {
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
  const rawDue = newTodoDue.value;
  const todo = createTodo(text);
  if (category) todo.category = category; // createdAt = updatedAt = now 已由 createTodo 设定
  if (isValidDueDate(rawDue)) todo.dueDate = rawDue;
  todo.order = topOrder(todos); // 新条目置顶：order 取现存最小值减 1
  todos.unshift(todo);
  input.value = ""; // 分类下拉保留当前选中，便于连续录入同一分类
  newTodoDue.value = ""; // 日期每次清空：通常一条一个截止日期
  newTodoDue.classList.add("is-empty");
  persist();
  // 即时到期检查：新建即带过期日期 → 立即通知并标记
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

// 新增表单的截止日期：空值收成日历图标，与列表行内日期同款交互
const newTodoDue = document.createElement("input");
newTodoDue.type = "date";
newTodoDue.id = "new-todo-due";
newTodoDue.className = "todo-due new-todo-due is-empty";
newTodoDue.setAttribute("aria-label", "新待办的截止日期");
form.insertBefore(
  newTodoDue,
  form.querySelector<HTMLButtonElement>("button[type=submit]"),
);
newTodoDue.addEventListener("change", () => {
  newTodoDue.classList.toggle("is-empty", !newTodoDue.value);
});

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
  if (target.classList.contains("todo-toggle")) {
    todos = todos.map((t) =>
      t.id === id ? { ...t, completed: !t.completed, updatedAt: Date.now() } : t,
    );
  } else if (target.classList.contains("todo-delete")) {
    todos = todos.map((t) => (t.id === id ? markDeleted(t) : t));
  } else if (target.classList.contains("todo-text")) {
    beginEdit(item, id);
    return;
  } else {
    return;
  }
  persist();
});

// ---------- 行内编辑文本 ----------

/** 单击文本进入编辑：span 换 input；Enter/失焦提交，Esc 还原。
 *  拖动结束的那次 click 已被 drag 层吞掉，不会误入编辑；编辑中 render 跳过列表重建。 */
function beginEdit(item: HTMLElement, id: string | undefined): void {
  if (editingId != null || !id) return;
  const todo = todos.find((t) => t.id === id);
  const span = item.querySelector<HTMLElement>(".todo-text");
  if (!todo || !span) return;
  editingId = id;
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
    if (done || editingId !== id) return;
    done = true;
    editingId = null;
    const next = input.value.trim();
    const current = todos.find((t) => t.id === id);
    if (save && current && !isDeleted(current) && next && next !== current.text) {
      todos = todos.map((t) => (t.id === id ? { ...t, text: next, updatedAt: Date.now() } : t));
      // 文本改动不影响顺序/统计/筛选：原地换 span 即可，不做整表重渲染——
      // 否则 blur 提交后的整表重建会把「点别处」的那次点击落到重建后的其他控件上
      saveTodos(todos);
      sync.onLocalChange();
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
  } else if (target.classList.contains("todo-due")) {
    const next = isValidDueDate(target.value) ? target.value : undefined; // 非法输入按清空处理，不报错
    if ((current.dueDate ?? undefined) === (next ?? undefined)) return;
    todos = todos.map((t) => {
      if (t.id !== current.id) return t;
      updated = { ...t, dueDate: next, updatedAt: Date.now() };
      return updated;
    });
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
  const from = todos.findIndex((t) => t.id === id);
  if (from < 0) return;
  const current = todos[from];
  const prev = prevId != null ? todos.find((t) => t.id === prevId) : undefined;
  const next = nextId != null ? todos.find((t) => t.id === nextId) : undefined;
  const order = orderBetween(prev, next, current.order ?? 0);
  if (order === current.order) return; // 原位（含 Esc 还原 / 仅剩一条）：不产生写入与同步
  const rest = todos.filter((t) => t.id !== id);
  const at =
    prevId != null
      ? rest.findIndex((t) => t.id === prevId) + 1
      : nextId != null
        ? rest.findIndex((t) => t.id === nextId)
        : from; // 前后都无邻条：数组位置不变
  rest.splice(at, 0, withOrder(current, order));
  todos = rest;
  persist();
}

attachDragReorder(listEl, {
  onDrop: (id, prevId, nextId) => {
    if (id) applyMove(id, prevId, nextId);
  },
});

// 键盘排序：焦点在条目内任意控件时 Alt+↑/↓ 与相邻可见条目换位（拖动的无障碍替代），
// 列表重建后把焦点放回同一条目的同类控件
listEl.addEventListener("keydown", (e) => {
  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
  const item = (e.target as HTMLElement).closest<HTMLElement>(".todo-item");
  const id = item?.dataset.id;
  if (!item || !id) return;
  e.preventDefault();
  const visible = applyFilter(todos, view);
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
    const target = (cls && li.querySelector<HTMLElement>(`.${cls}`)) || li.querySelector<HTMLElement>(".todo-toggle");
    target?.focus();
  }, 0);
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
  saveManualCategories();
  newCategoryInput.value = "";
  showCategoryHint(`已添加「${name}」`);
  render();
});

clearBtn.addEventListener("click", () => {
  const now = Date.now();
  todos = todos.map((t) =>
    !isDeleted(t) && t.completed ? { ...t, deletedAt: now, updatedAt: now } : t,
  );
  persist();
});

// 清除全部：confirm 二次确认后给全部现存条目打墓碑（不能物理清空数组，
// 否则远端仍存有这些条目，下次同步会按 LWW 全部复活）；persist() 内部触发防抖自动同步
clearAllBtn.addEventListener("click", () => {
  if (!confirm("确定要清除全部待办吗？清除后不可恢复")) return;
  todos = todos.map((t) => (isDeleted(t) ? t : markDeleted(t)));
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
void notifyOverdueBatch();
// 运行中定期扫描：应用长期开着跨天后也能报过期（每小时一次 + 切回前台时）
const OVERDUE_POLL_MS = 60 * 60 * 1000;
setInterval(() => void notifyOverdueBatch(), OVERDUE_POLL_MS);
// 启动即拉取一次远端（未配置时静默显示“未开启同步”）
void sync.syncNow();
// 自动同步循环：30 秒轮询 + 失败退避重试
sync.startAutoSync();
// 窗口回到前台立即拉一次（手机切回 App、电脑切回窗口时感知另一端改动），顺带扫过期
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void sync.syncNow();
    void notifyOverdueBatch();
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
