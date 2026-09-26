import {
  advanceDate,
  isValidCategory,
  loadTodos,
  sameTodos,
  topOrder,
  type Todo,
} from "./todo";
import { applyFilter, type View } from "./ui";

/**
 * 全局应用状态：唯一可变数据源，各功能模块从这里读写，main.ts 只负责装配与渲染。
 * 数据变更一律走 persist()（写存储 → 防抖同步 → 重渲染）；
 * 视图态（view/searchTerm/batchMode/editingId）只影响渲染，不写存储、不触发同步。
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
};

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

/** 当前视图可见条目：视图过滤 + 文本/备注搜索（拖动/键盘排序/批量共用同一份可见集） */
export function visibleTodos(): Todo[] {
  const list = applyFilter(app.todos, app.view);
  const term = app.searchTerm.trim().toLowerCase();
  if (!term) return list;
  return list.filter(
    (t) => t.text.toLowerCase().includes(term) || (t.notes ?? "").toLowerCase().includes(term),
  );
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
 * 获胜（包括复活已同步到远端的删除）；快照之后新增的条目保留；无差异条目不 bump，
 * 避免一次撤销触发全量推送。
 */
export function undoSnapshot(snapshot: Todo[]): void {
  const now = Date.now();
  const current = new Map(app.todos.map((t) => [t.id, t]));
  const restored = new Map<string, Todo>();
  for (const s of snapshot) {
    const c = current.get(s.id);
    if (c && sameTodos([c], [s])) continue;
    restored.set(s.id, { ...s, updatedAt: now });
  }
  if (restored.size === 0) return;
  app.todos = app.todos.map((t) => restored.get(t.id) ?? t);
  const currentIds = new Set(app.todos.map((t) => t.id));
  for (const [id, t] of restored) {
    if (!currentIds.has(id)) app.todos.push(t); // 快照有、当前无（墓碑被物理清除）：收回
  }
  persist();
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
  if (completed && t.recurrence && t.dueDate) {
    const now = Date.now();
    app.todos.unshift({
      id: crypto.randomUUID(),
      text: t.text,
      category: t.category,
      dueDate: advanceDate(t.dueDate, t.recurrence),
      dueTime: t.dueTime,
      recurrence: t.recurrence,
      completed: false,
      createdAt: now,
      updatedAt: now,
      order: topOrder(app.todos),
    });
  }
  return true;
}
