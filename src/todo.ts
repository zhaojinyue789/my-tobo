export interface Todo {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
  /** 最后一次修改时间，双端同步按此项做 LWW 合并 */
  updatedAt: number;
  /** 删除墓碑：有值表示已删除，保留 30 天后物理清除，防止删除被同步复活 */
  deletedAt?: number;
  /** 自由文本分类，未分类为 undefined（合法值经 normalizeCategory 清洗） */
  category?: string;
  /** 截止日期 YYYY-MM-DD，未设置为 undefined */
  dueDate?: string;
  /** 过期通知已发送：设备本地 UX 状态；随数据同步但标记时不 bump updatedAt（不参与 LWW） */
  notified?: boolean;
  /** 手动排序序号（升序 = 界面自上而下）：旧数据缺失时显示按 createdAt 稳定推导，首次拖拽才物化 */
  order?: number;
}

const STORAGE_KEY = "my-tobo.todos";
/** 墓碑保留时长：超过后物理清除（另一端 30 天内未同步才会受影响） */
const TOMBSTONE_TTL = 30 * 24 * 60 * 60 * 1000;
/** 分类名上限（按 UTF-16 码元计，emoji/部分生僻字算 2） */
const CATEGORY_MAX_LENGTH = 20;
/** 分类名禁用字符：/ \ < > : " | ? * 及控制字符（U+0000–U+001F、U+007F） */
const CATEGORY_FORBIDDEN = /[/\\<>:"|?*\u0000-\u001f\u007f]/;
/** 一次性迁移标记：category/dueDate 字段引入后，首次加载把迁移结果写回存储并置位，之后不再触发写回 */
const MIGRATION_KEY_CATEGORY_DUE_DATE = "my-tobo.migrated.category_due_date";

export function isDeleted(todo: Todo): boolean {
  return todo.deletedAt != null;
}

/** order 清洗：仅接受安全整数；非整数 / NaN / ±Infinity / 越界一律视为缺失（走 createdAt 推导分支） */
export function normalizeOrder(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** 排序步长：相邻序值的基础间隔；取 2 的幂保证连续取中点仍为整数（防精度塌陷） */
export const ORDER_STEP = 1024;

/** 重整阈值：插入后前后间距不足此值时整体重编号，留足后续对半拆分余量 */
export const REBALANCE_THRESHOLD = 256;

/**
 * 推导序：缺 order 的条目按「createdAt 升序名次」× STEP 取值，与显式值同刻度、可安全混比。
 * 相对顺序只由 createdAt 决定（推导值随名次单调），列表构成变化只平移绝对值、不改变相对次序。
 */
function derivedOrderMap(todos: Todo[]): Map<string, number> {
  const ranked = [...todos].sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const map = new Map<string, number>();
  ranked.forEach((t, i) => map.set(t.id, (i + 1) * ORDER_STEP));
  return map;
}

/**
 * 稳定排序（显示顺序的唯一权威）：order（缺失用推导值）为主键升序，相等比 createdAt，再相等比 id。
 * 全序确定 → 同数据必得同顺序，双端一致且列表不闪烁。
 */
export function sortTodos(todos: Todo[]): Todo[] {
  const derived = derivedOrderMap(todos);
  const eff = (t: Todo): number => t.order ?? derived.get(t.id) ?? 0;
  return [...todos].sort(
    (a, b) => eff(a) - eff(b) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
  );
}

/** order 写入项（拖拽/重整产生的显式序号赋值） */
export interface OrderWrite {
  id: string;
  order: number;
}

/** order 还原项；order = null 表示该条目此前没有 order 字段，撤销时移除该字段 */
export interface OrderRestore {
  id: string;
  order: number | null;
}

/** 一次拖拽的完整重排计划：writes 汇聚全部序号写入（含首次物化与内联重整），一次撤销可完整还原 */
export interface ReorderPlan {
  id: string;
  writes: OrderWrite[];
  restores: OrderRestore[];
  /** 应用写入后的全量新数组（受影响条目 updatedAt 已刷新） */
  todos: Todo[];
}

/** 一次独立批量重整的计划 */
export interface RebalancePlan {
  writes: OrderWrite[];
  restores: OrderRestore[];
  todos: Todo[];
}

/** 新项序值 = 末项（现存条目最大有效序值）+ STEP；空表从 STEP 起（新项默认排末尾） */
export function nextAppendOrder(todos: Todo[]): number {
  const derived = derivedOrderMap(todos);
  let max: number | undefined;
  for (const t of todos) {
    if (isDeleted(t)) continue;
    const o = t.order ?? derived.get(t.id) ?? 0;
    if (max === undefined || o > max) max = o;
  }
  return (max ?? 0) + ORDER_STEP;
}

/** 把 order 写入应用到全量数组：写到的条目 bump updatedAt（order 是数据变更，须参与 LWW 同步） */
function withOrderWrites(todos: Todo[], writes: OrderWrite[]): Todo[] {
  const byId = new Map(writes.map((w) => [w.id, w.order]));
  const now = Date.now();
  return todos.map((t) => (byId.has(t.id) ? { ...t, order: byId.get(t.id), updatedAt: now } : t));
}

/**
 * 物化：给全部现存条目按当前有效顺序写入显式序号 (名次+1)×STEP（DECISIONS.md D2）。
 * 只返回需要变化的部分；restores 记录写入前旧值（缺失记 null），供撤销精确还原。
 */
function materializeOrders(todos: Todo[]): { writes: OrderWrite[]; restores: OrderRestore[] } {
  const live = sortTodos(todos.filter((t) => !isDeleted(t)));
  const writes: OrderWrite[] = [];
  const restores: OrderRestore[] = [];
  live.forEach((t, i) => {
    const target = (i + 1) * ORDER_STEP;
    if (t.order === target) return;
    writes.push({ id: t.id, order: target });
    restores.push({ id: t.id, order: t.order ?? null });
  });
  return { writes, restores };
}

/**
 * 重编号：ordered 顺序下重写为 (名次+1)×STEP；未变化的条目不写入。
 */
function renumber(
  todos: Todo[],
  ordered: Todo[],
): { writes: OrderWrite[]; restores: OrderRestore[]; todos: Todo[] } {
  const writes: OrderWrite[] = [];
  const restores: OrderRestore[] = [];
  ordered.forEach((t, i) => {
    const target = (i + 1) * ORDER_STEP;
    if (t.order === target) return;
    writes.push({ id: t.id, order: target });
    restores.push({ id: t.id, order: t.order ?? null });
  });
  return { writes, restores, todos: withOrderWrites(todos, writes) };
}

/**
 * 重整现存条目：draggedId 非空时把被拖项插到 predId（应为其前面的可见邻居）之后；均空则纯重编号。
 */
function rebalanceLive(
  todos: Todo[],
  draggedId: string | null,
  predId: string | null,
): { writes: OrderWrite[]; restores: OrderRestore[]; todos: Todo[] } {
  const live = sortTodos(todos.filter((t) => !isDeleted(t)));
  if (draggedId === null) return renumber(todos, live);
  const rest = live.filter((t) => t.id !== draggedId);
  const dragged = live.find((t) => t.id === draggedId);
  if (!dragged) return renumber(todos, live);
  const insertAt = predId === null ? 0 : rest.findIndex((t) => t.id === predId) + 1;
  const ordered = [...rest.slice(0, insertAt), dragged, ...rest.slice(insertAt)];
  return renumber(todos, ordered);
}

/** writes 按 id 去重取后者（与 Map 应用语义一致）；restores 保留首条（旧值唯一真相） */
function dedupeWrites(writes: OrderWrite[]): OrderWrite[] {
  return [...new Map(writes.map((w) => [w.id, w.order]))].map(([id, order]) => ({ id, order }));
}

function dedupeRestores(restores: OrderRestore[]): OrderRestore[] {
  const map = new Map<string, number | null>();
  for (const r of restores) if (!map.has(r.id)) map.set(r.id, r.order);
  return [...map].map(([id, order]) => ({ id, order }));
}

/**
 * 规划一次拖拽重排：在可见列表 visibleSorted 中把 id 移到「剔除自身后」的 targetIndex 位置。
 * 返回 null = 原位放下或参数非法（不产生命令）。
 * 写入范围 = 首次物化 + 被拖项新序值 +（间距不足 / 序值冲突时的）内联重整，全并入同一条命令。
 */
export function planReorder(
  todos: Todo[],
  id: string,
  targetIndex: number,
  visibleSorted: Todo[],
): ReorderPlan | null {
  const dragged = todos.find((t) => t.id === id);
  if (!dragged || isDeleted(dragged)) return null;
  const currentIndex = visibleSorted.findIndex((t) => t.id === id);
  const others = visibleSorted.filter((t) => t.id !== id);
  if (currentIndex < 0 || targetIndex < 0 || targetIndex > others.length) return null;
  if (targetIndex === currentIndex) return null;

  // 首次拖拽物化：现存条目全部获得显式序号，此后 eff 直接读显式值
  const mat = materializeOrders(todos);
  const materialized = new Map(mat.writes.map((w) => [w.id, w.order]));
  const eff = (t: Todo): number => materialized.get(t.id) ?? t.order ?? 0;

  let newOrder: number;
  let rebalance = false;
  if (others.length === 0) {
    newOrder = ORDER_STEP;
  } else if (targetIndex === 0) {
    newOrder = eff(others[0]) - ORDER_STEP; // 首项 − STEP
  } else if (targetIndex === others.length) {
    newOrder = eff(others[others.length - 1]) + ORDER_STEP; // 末项 + STEP
  } else {
    const prev = eff(others[targetIndex - 1]);
    const next = eff(others[targetIndex]);
    newOrder = Math.floor((prev + next) / 2); // 插入取前后平均、向下取整
    if (next - prev < REBALANCE_THRESHOLD) rebalance = true;
  }

  if (!rebalance) {
    const occupied = new Set(
      sortTodos(todos.filter((t) => !isDeleted(t) && t.id !== id)).map((t) =>
        materialized.get(t.id) ?? t.order ?? 0,
      ),
    );
    if (occupied.has(newOrder)) rebalance = true; // 与隐藏条目序值相等：触发重整避免重复
  }

  const writes: OrderWrite[] = [...mat.writes];
  const restores: OrderRestore[] = [...mat.restores];
  let nextTodos = withOrderWrites(todos, mat.writes);
  if (rebalance) {
    // 全量重整，被拖项插到「应排其前面的可见邻居」之前
    const pred = targetIndex > 0 ? others[targetIndex - 1] : null;
    const plan = rebalanceLive(nextTodos, id, pred ? pred.id : null);
    writes.push(...plan.writes);
    restores.push(...plan.restores);
    nextTodos = plan.todos;
  } else {
    writes.push({ id, order: newOrder });
    restores.push({ id, order: dragged.order ?? null });
    nextTodos = withOrderWrites(nextTodos, [{ id, order: newOrder }]);
  }
  return {
    id,
    writes: dedupeWrites(writes),
    restores: dedupeRestores(restores),
    todos: nextTodos,
  };
}

/** 独立批量重整（无拖拽）：现存条目整体重编号；无变化返回 null */
export function planRebalance(todos: Todo[]): RebalancePlan | null {
  const { writes, restores, todos: next } = rebalanceLive(todos, null, null);
  if (writes.length === 0) return null;
  return { writes, restores, todos: next };
}

/** 合并后检测：现存条目是否存在相等有效序值（去抖重整的触发条件） */
export function hasDuplicateOrders(todos: Todo[]): boolean {
  const derived = derivedOrderMap(todos);
  const seen = new Set<number>();
  for (const t of todos) {
    if (isDeleted(t)) continue;
    const o = t.order ?? derived.get(t.id) ?? 0;
    if (seen.has(o)) return true;
    seen.add(o);
  }
  return false;
}

/** 分类清洗：trim 后非空、≤20 字符、无禁用字符才合法；否则视为未填写 */
export function normalizeCategory(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > CATEGORY_MAX_LENGTH || CATEGORY_FORBIDDEN.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function isValidCategory(value: unknown): boolean {
  return normalizeCategory(value) !== undefined;
}

export function isValidDueDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** 本地时区的今天；toISOString() 是 UTC，时区边缘会让“今天”错一天 */
export function todayISO(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** 已完成/已删除永不过期；无 dueDate 不过期；当天不算过期（严格小于） */
export function isOverdue(t: Todo, today: string = todayISO()): boolean {
  if (t.completed || isDeleted(t) || !t.dueDate) return false;
  return t.dueDate < today;
}

export function loadTodos(): Todo[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const todos = data
      .filter(
        (item): item is Todo =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Todo).id === "string" &&
          typeof (item as Todo).text === "string" &&
          typeof (item as Todo).completed === "boolean",
      )
      .map(migrate);
    runStartupMigration(todos);
    return todos;
  } catch {
    return [];
  }
}

/** 旧版本数据没有 updatedAt/deletedAt/category/dueDate/notified/order，读取时补齐；新字段非法值按未填写处理，条目保留 */
function migrate(item: Todo): Todo {
  return {
    ...item,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : item.createdAt,
    deletedAt: typeof item.deletedAt === "number" ? item.deletedAt : undefined,
    category: normalizeCategory(item.category),
    dueDate: isValidDueDate(item.dueDate) ? item.dueDate : undefined,
    notified: typeof item.notified === "boolean" ? item.notified : false,
    order: normalizeOrder(item.order),
  };
}

/**
 * 一次性迁移收尾：migrate 每次加载都幂等执行，这里只在首次（无标记时）把结果写回存储一次并置位。
 * 异常必须就地吞掉——若冒泡到 loadTodos 外层 catch，会把已加载的列表整表变成 []。
 */
function runStartupMigration(todos: Todo[]): void {
  try {
    if (localStorage.getItem(MIGRATION_KEY_CATEGORY_DUE_DATE)) return;
    saveTodos(todos);
    localStorage.setItem(MIGRATION_KEY_CATEGORY_DUE_DATE, "1");
  } catch {
    // 标记/写回失败（配额满、只读模式等）：静默忽略，不阻塞加载；下次启动重试
  }
}

export function saveTodos(todos: Todo[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(purgeTombstones(todos)));
    return true;
  } catch (err) {
    console.error("待办保存失败（localStorage 写入异常）：", err);
    return false;
  }
}

export function purgeTombstones(todos: Todo[]): Todo[] {
  const cutoff = Date.now() - TOMBSTONE_TTL;
  return todos.filter((t) => t.deletedAt == null || t.deletedAt > cutoff);
}

export function createTodo(text: string): Todo {
  const now = Date.now();
  return { id: crypto.randomUUID(), text, completed: false, createdAt: now, updatedAt: now };
}

/** 删除 = 打墓碑（同步层需要 tombstone 而非物理删除） */
export function markDeleted(todo: Todo): Todo {
  const now = Date.now();
  return { ...todo, deletedAt: now, updatedAt: now };
}

/**
 * 双端合并：按 id 对齐，逐项按 updatedAt 最后写入胜出；
 * 单端独有的项（含墓碑）直接收编。
 */
export function mergeTodos(local: Todo[], remote: Todo[]): Todo[] {
  const byId = new Map(local.map((t) => [t.id, t]));
  for (const r of remote) {
    const l = byId.get(r.id);
    if (!l || r.updatedAt > l.updatedAt) byId.set(r.id, r);
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function sameTodos(a: Todo[], b: Todo[]): boolean {
  if (a.length !== b.length) return false;
  const key = (t: Todo) => JSON.stringify(t);
  const sort = (list: Todo[]) => [...list].map(key).sort();
  const [sa, sb] = [sort(a), sort(b)];
  return sa.every((v, i) => v === sb[i]);
}
