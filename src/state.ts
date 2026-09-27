import {
  advanceDate,
  dateOffset,
  isDeleted,
  isValidCategory,
  loadTodos,
  sameTodos,
  todayISO,
  topOrder,
  type Todo,
} from "./todo";
import { applyFilter, sortTodosByDue, type View } from "./ui";

export type SortMode = "manual" | "due";

const SORT_KEY = "my-tobo.sort";

/** 排序模式为设备本地显示偏好（不同步）；默认保持手动排序 */
function loadSortMode(): SortMode {
  try {
    return localStorage.getItem(SORT_KEY) === "due" ? "due" : "manual";
  } catch {
    return "manual";
  }
}

/**
 * 全局应用状态：唯一可变数据源，各功能模块从这里读写，main.ts 只负责装配与渲染。
 * 数据变更一律走 persist()（写存储 → 防抖同步 → 重渲染）；
 * 视图态（view/searchTerm/batchMode/editingId/sortMode）只影响渲染，不写存储、不触发同步。
 */
export const app = {
  todos: loadTodos(),
  view: { category: "__all__", status: "all" } as View,
  /** 行内编辑中的条目 id：编辑期间 render 跳过列表重建，防止编辑框被打断 */
  editingId: null as string | null,
  /** 文本搜索词（实时过滤当前视图，大小写不敏感） */
  searchTerm: "",
  /** 批量模式与已选条目 */
  batchMode: false,
  selectedIds: new Set<string>(),
  /** 排序模式：manual=手动（order 字段），due=按截止时间（近的在前） */
  sortMode: loadSortMode(),
};

/** 切换排序模式并持久化（设备本地偏好） */
export function setSortMode(mode: SortMode): void {
  app.sortMode = mode;
  try {
    localStorage.setItem(SORT_KEY, mode);
  } catch {
    /* 持久化失败不影响本次会话 */
  }
}

const MANUAL_CATEGORIES_KEY = "my-tobo.manual-categories";

/** 手动新建的分类：持久化（重启保留），与派生集合合并后进入各下拉框 */
export const manualCategories: Set<string> = loadManualCategories();

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

export function saveManualCategories(): void {
  try {
    localStorage.setItem(MANUAL_CATEGORIES_KEY, JSON.stringify([...manualCategories]));
  } catch {
    /* 写失败静默：下次添加分类时重写 */
  }
}

export interface AppServices {
  /** 全量待办写入存储（失败时调用方负责亮起存储警告） */
  save(): void;
  onLocalChange(): void;
  render(): void;
}

let services: AppServices | undefined;

/** main.ts 装配完成前不应有任何数据变更；保险起见 persist 静默忽略 */
export function initAppServices(s: AppServices): void {
  services = s;
}

/** 数据变更管线：写存储 → 触发同步防抖 → 重渲染 */
export function persist(): void {
  if (!services) return;
  services.save();
  services.onLocalChange();
  services.render();
}

/** 只写存储并触发同步防抖，不重渲染（行内文本编辑等原地更新的场景） */
export function saveOnly(): void {
  if (!services) return;
  services.save();
  services.onLocalChange();
}

/** 当前视图可见条目：视图过滤 → 文本/备注搜索 → 排序模式（拖动/键盘排序/批量共用同一份可见集） */
export function visibleTodos(): Todo[] {
  const list = applyFilter(app.todos, app.view);
  const term = app.searchTerm.trim().toLowerCase();
  const filtered = term
    ? list.filter(
        (t) => t.text.toLowerCase().includes(term) || (t.notes ?? "").toLowerCase().includes(term),
      )
    : list;
  // due 模式按截止时间排序（近的在前）；manual 模式保持手动顺序（order 字段）
  return app.sortMode === "due" ? sortTodosByDue(filtered) : filtered;
}

/**
 * 更新一条待办：patch 合并并 bump updatedAt（参与双端 LWW）。
 * 显式传 undefined 的字段会被清空；条目不存在返回 undefined，否则返回更新后的条目。
 */
export function updateTodo(id: string, patch: Partial<Todo>): Todo | undefined {
  const current = app.todos.find((t) => t.id === id);
  if (!current) return undefined;
  const next: Todo = { ...current, ...patch, updatedAt: Date.now() };
  app.todos = app.todos.map((t) => (t.id === id ? next : t));
  return next;
}

/** 设备本地 UX 标记（notified/reminded 等）：不 bump updatedAt，不参与 LWW */
export function markTodo(id: string, patch: Partial<Todo>): void {
  app.todos = app.todos.map((t) => (t.id === id ? { ...t, ...patch } : t));
}

/** 捕获撤销快照：破坏性操作（删除/清除）前调用，浅拷贝每条（字段值均不可变，浅拷贝足够） */
export function captureSnapshot(): Todo[] {
  return app.todos.map((t) => ({ ...t }));
}

/**
 * 撤销快照回滚：有差异的条目以快照为准并 bump updatedAt——这样撤销改动在双端 LWW 中
 * 获胜（包括复活已同步到远端的删除）；快照之后新增的条目默认保留。
 * removeIds（可选，如导入带来的全新条目）：对这些条目打墓碑而非物理删除——若撤销前
 * 同步已把它们推到远端，物理删除会被远端重新收编复活；墓碑按 LWW 获胜，进回收站，
 * 语义与普通删除一致。
 */
export function undoSnapshot(snapshot: Todo[], removeIds?: ReadonlySet<string>): void {
  const now = Date.now();
  let changed = false;

  if (
    removeIds &&
    removeIds.size > 0 &&
    app.todos.some((t) => removeIds.has(t.id) && !isDeleted(t))
  ) {
    app.todos = app.todos.map((t) =>
      removeIds.has(t.id) && !isDeleted(t) ? { ...t, deletedAt: now, updatedAt: now } : t,
    );
    changed = true;
  }

  const current = new Map(app.todos.map((t) => [t.id, t]));
  const restored = new Map<string, Todo>();
  for (const s of snapshot) {
    const c = current.get(s.id);
    if (c && sameTodos([c], [s])) continue; // 无差异不 bump，避免多余的同步写入
    restored.set(s.id, { ...s, updatedAt: now });
  }
  if (restored.size > 0) {
    changed = true;
    app.todos = app.todos.map((t) => restored.get(t.id) ?? t);
    const currentIds = new Set(app.todos.map((t) => t.id));
    for (const [id, t] of restored) {
      if (!currentIds.has(id)) app.todos.push(t); // 快照有、当前无（墓碑被物理清除）：收回
    }
  }
  if (changed) persist();
}

/** 克隆待办：重置 id/完成态/通知标记，其余字段（分类/日期/重复/备注/子任务）照搬，置顶插入 */
export function cloneTodo(id: string): boolean {
  const source = app.todos.find((t) => t.id === id);
  if (!source) return false;
  const now = Date.now();
  const copy: Todo = {
    ...source,
    id: crypto.randomUUID(),
    completed: false,
    completedAt: undefined,
    notified: undefined,
    reminded: undefined,
    createdAt: now,
    updatedAt: now,
    order: topOrder(app.todos),
    subtasks: source.subtasks?.map((s) => ({ ...s, id: crypto.randomUUID(), done: false })),
  };
  app.todos.unshift(copy);
  return true;
}

/** 完成/取消完成；重复任务被完成时按 dueDate 生成下一实例置顶（取消完成不回收已生成的实例）。
 *  完成同时记录 completedAt 供统计；返回是否有变更（调用方据此决定是否 persist）。 */
export function setCompleted(id: string, completed: boolean): boolean {
  const t = app.todos.find((x) => x.id === id);
  if (!t || t.completed === completed) return false;
  app.todos = app.todos.map((x) =>
    x.id === id
      ? {
          ...x,
          completed,
          completedAt: completed ? Date.now() : undefined,
          updatedAt: Date.now(),
        }
      : x,
  );
  if (completed && t.recurrence) {
    const rule = t.recurrence;
    const fromCompletion = typeof rule === "object" && rule.kind === "fromCompletion";
    // 「完成后 N 天」：以完成日为基准生成（无截止日期的重复任务也适用）；其余按 dueDate 推进
    if (t.dueDate || fromCompletion) {
      const now = Date.now();
      const nextDue = fromCompletion
        ? dateOffset(todayISO(), rule.everyN ?? 1)
        : advanceDate(t.dueDate as string, rule);
      app.todos.unshift({
        ...t,
        id: crypto.randomUUID(),
        completed: false,
        completedAt: undefined,
        notified: undefined,
        reminded: undefined,
        dueDate: nextDue,
        createdAt: now,
        updatedAt: now,
        order: topOrder(app.todos),
        subtasks: t.subtasks?.map((s) => ({ ...s, id: crypto.randomUUID(), done: false })),
      });
    }
  }
  return true;
}
