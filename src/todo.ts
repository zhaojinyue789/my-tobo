export interface Subtask {
  id: string;
  text: string;
  done: boolean;
}

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
  /** 截止时刻 HH:MM，仅 dueDate 存在时有意义；到点即提醒/过期 */
  dueTime?: string;
  /** 重复规则：完成当前实例后按 dueDate 生成下一条（未填不重复） */
  recurrence?: Recurrence;
  /** 置顶：展示时排在未置顶条目之前，组内仍按 order 排序 */
  pinned?: boolean;
  /** 排序权重：越小越靠前。新条目取现存最小值减 1，拖动取前后邻条中点；随 updatedAt 走 LWW */
  order?: number;
  /** 备注：多行文本（≤500 字符），空视为未填写 */
  notes?: string;
  /** 子任务清单：整组字段随 LWW 同步（组内不做行级合并） */
  subtasks?: Subtask[];
  /** 过期/到点通知已发送：设备本地 UX 状态；随数据同步但标记时不 bump updatedAt（不参与 LWW） */
  notified?: boolean;
  /** 「提前 1 天」提醒已发送（同 notified，独立标记） */
  reminded?: boolean;
}

export type Recurrence = "daily" | "weekly" | "monthly";

export const RECURRENCES: Recurrence[] = ["daily", "weekly", "monthly"];

export function isRecurrence(value: unknown): value is Recurrence {
  return value === "daily" || value === "weekly" || value === "monthly";
}

const STORAGE_KEY = "my-tobo.todos";
/** 墓碑保留时长：超过后物理清除（另一端 30 天内未同步才会受影响） */
const TOMBSTONE_TTL = 30 * 24 * 60 * 60 * 1000;
/** 分类名上限（按 UTF-16 码元计，emoji/部分生僻字算 2） */
const CATEGORY_MAX_LENGTH = 20;
/** 分类名禁用字符：/ \ < > : " | ? * 及控制字符（U+0000–U+001F、U+007F） */
const CATEGORY_FORBIDDEN = /[/\\<>:"|?*\u0000-\u001f\u007f]/;
/** 备注长度上限（保存时静默截断） */
export const NOTES_MAX_LENGTH = 500;
/** 单条子任务文本长度上限 */
export const SUBTASK_MAX_LENGTH = 200;
/** 一次性迁移标记：category/dueDate 字段引入后，首次加载把迁移结果写回存储并置位，之后不再触发写回 */
const MIGRATION_KEY_CATEGORY_DUE_DATE = "my-tobo.migrated.category_due_date";
/** 一次性迁移标记：order 排序字段引入后，首次加载把补齐结果写回存储并置位 */
const MIGRATION_KEY_ORDER = "my-tobo.migrated.order";

export function isDeleted(todo: Todo): boolean {
  return todo.deletedAt != null;
}

/** 墓碑是否仍在保留期内（回收站可见范围）；过期墓碑会被 purgeTombstones 物理清除 */
export function deletedRecently(todo: Todo): boolean {
  return todo.deletedAt != null && todo.deletedAt > Date.now() - TOMBSTONE_TTL;
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

/** 截止时刻 HH:MM（24 小时制，合法范围 00:00–23:59） */
export function isValidDueTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [h, m] = value.split(":").map(Number);
  return h <= 23 && m <= 59;
}

/** 本地时区的 HH:MM（分钟级比较用） */
export function nowHM(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/** 本地时区的今天；toISOString() 是 UTC，时区边缘会让“今天”错一天 */
export function todayISO(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** 指定日期（默认今天）+ N 天的本地日期 YYYY-MM-DD；N 可为负 */
export function dateOffset(from: string, days: number): string {
  const [y, m, d] = from.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  const month = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${dt.getFullYear()}-${month}-${day}`;
}

/** 重复实例的下一个截止日期：日 +1、周 +7、月 +1 个月（月末溢出收紧到当月最后一天） */
export function advanceDate(dateISO: string, recurrence: Recurrence): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  if (recurrence === "daily") return dateOffset(dateISO, 1);
  if (recurrence === "weekly") return dateOffset(dateISO, 7);
  // 月末收紧：1 月 31 日 +1 个月 → 2 月 28/29 日
  // m 是 1-based：目标月（下个月）的 0-based 索引就是 m，其天数为 new Date(y, m + 1, 0).getDate()
  const lastDay = new Date(y, m + 1, 0).getDate();
  const target = new Date(y, m, Math.min(d, lastDay));
  const month = String(target.getMonth() + 1).padStart(2, "0");
  const day = String(target.getDate()).padStart(2, "0");
  return `${target.getFullYear()}-${month}-${day}`;
}

/** 已完成/已删除永不过期；无 dueDate 不过期；date-only 当天不算过期；带 dueTime 当天到点即过期 */
export function isOverdue(t: Todo, today: string = todayISO(), hm: string = nowHM()): boolean {
  if (t.completed || isDeleted(t) || !t.dueDate) return false;
  if (t.dueDate < today) return true;
  if (t.dueDate === today) return t.dueTime != null && t.dueTime <= hm;
  return false;
}

/** 「提前 1 天」提醒目标：明天到期、未完成、未删除 */
export function isDueTomorrow(t: Todo, today: string = todayISO()): boolean {
  if (t.completed || isDeleted(t) || !t.dueDate) return false;
  return t.dueDate === dateOffset(today, 1);
}

/** 「今天到期」智能视图：未完成、未删除、已过期或今天到期（date-only 当天也计入，到点与否不影响归类） */
export function isDueToday(t: Todo, today: string = todayISO()): boolean {
  if (t.completed || isDeleted(t) || !t.dueDate) return false;
  return t.dueDate <= today;
}

/** 「即将到期」智能视图：明天起 N 天（默认 7 天）内到期、未完成、未删除 */
export function isDueSoon(t: Todo, today: string = todayISO(), days = 7): boolean {
  if (t.completed || isDeleted(t) || !t.dueDate) return false;
  const end = dateOffset(today, days);
  return t.dueDate > today && t.dueDate <= end;
}

/** 损坏备份键：解析失败时把原文存这里，避免下次 persist 把原始数据彻底覆盖 */
const CORRUPT_BACKUP_KEY = "my-tobo.todos.corrupt-backup";

export function loadTodos(): Todo[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return []; // localStorage 不可用（隐私模式等）：按空列表起步，读不了也写不了，不影响页面
  }
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    // 数据损坏：备份原文后按空列表起步（下次保存会覆盖主键，但原文仍在备份键里可手工恢复）
    backupCorrupt(raw);
    console.error("[my-tobo] 待办数据 JSON 解析失败，原文已备份：", err);
    return [];
  }
  if (!Array.isArray(data)) {
    backupCorrupt(raw);
    console.error("[my-tobo] 待办数据不是数组，原文已备份");
    return [];
  }
  try {
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
    // 展示顺序统一以 order 为准（存储数组顺序不可信：迁移补 order / 远端旧数据都会打乱）
    return [...todos].sort(compareDisplay);
  } catch (err) {
    backupCorrupt(raw);
    console.error("[my-tobo] 待办数据处理失败，原文已备份：", err);
    return [];
  }
}

function backupCorrupt(raw: string): void {
  try {
    localStorage.setItem(CORRUPT_BACKUP_KEY, raw);
  } catch {
    /* 备份失败（配额满等）：只能放弃，主流程继续 */
  }
}

/** 展示顺序统一规则：置顶组在前，order 升序（缺 order 视为 +∞，保证全序可传递），同值回退 createdAt 降序。loadTodos 与 mergeTodos 共用 */
function compareDisplay(a: Todo, b: Todo): number {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  const ao = a.order ?? Number.POSITIVE_INFINITY;
  const bo = b.order ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao - bo;
  return b.createdAt - a.createdAt;
}

/** 备注清洗：trim 后非空才保留，超长静默截断 */
export function cleanNotes(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, NOTES_MAX_LENGTH);
}

/** 子任务清洗：逐条白名单重建（id/text/done），空白文本丢弃，空清单视为未填写 */
export function cleanSubtasks(value: unknown): Subtask[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Subtask[] = [];
  for (const s of value) {
    if (typeof s !== "object" || s === null) continue;
    const { id, text, done } = s as Partial<Subtask>;
    if (typeof id !== "string" || id === "" || typeof text !== "string" || !text.trim()) continue;
    out.push({ id, text: text.trim().slice(0, SUBTASK_MAX_LENGTH), done: done === true });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 字段白名单重建 + 非法值清洗：本地 migrate 与远端 sanitizeRemoteTodo 共用的唯一清洗实现。
 * 只保留模型声明字段，未知字段一律丢弃（防止脏字段随同步永久传播）；
 * 新字段非法值按未填写处理，条目保留。
 */
export function cleanTodoFields(t: Todo): Todo {
  return {
    id: t.id,
    text: t.text,
    completed: t.completed ?? false,
    createdAt: t.createdAt,
    updatedAt:
      typeof t.updatedAt === "number" && Number.isFinite(t.updatedAt) ? t.updatedAt : t.createdAt,
    deletedAt: typeof t.deletedAt === "number" ? t.deletedAt : undefined,
    category: normalizeCategory(t.category),
    dueDate: isValidDueDate(t.dueDate) ? t.dueDate : undefined,
    dueTime: isValidDueTime(t.dueTime) ? t.dueTime : undefined,
    recurrence: isRecurrence(t.recurrence) ? t.recurrence : undefined,
    pinned: t.pinned === true ? true : undefined,
    order: typeof t.order === "number" && Number.isFinite(t.order) ? t.order : undefined,
    notes: cleanNotes(t.notes),
    subtasks: cleanSubtasks(t.subtasks),
    notified: typeof t.notified === "boolean" ? t.notified : undefined,
    reminded: typeof t.reminded === "boolean" ? t.reminded : undefined,
  };
}

/** 旧版本数据缺新字段时读取补齐；清洗规则统一在 cleanTodoFields */
function migrate(item: Todo): Todo {
  return cleanTodoFields(item);
}

/**
 * 一次性迁移收尾：migrate 每次加载都幂等执行，这里只在首次（任一标记缺失时）把结果写回存储一次并置位。
 * 异常必须就地吞掉——若冒泡到 loadTodos 外层 catch，会把已加载的列表整表变成 []。
 */
function runStartupMigration(todos: Todo[]): void {
  try {
    if (
      localStorage.getItem(MIGRATION_KEY_CATEGORY_DUE_DATE) &&
      localStorage.getItem(MIGRATION_KEY_ORDER)
    ) {
      return;
    }
    ensureOrders(todos);
    saveTodos(todos);
    localStorage.setItem(MIGRATION_KEY_CATEGORY_DUE_DATE, "1");
    localStorage.setItem(MIGRATION_KEY_ORDER, "1");
  } catch {
    // 标记/写回失败（配额满、只读模式等）：静默忽略，不阻塞加载；下次启动重试
  }
}

/** 存量条目补 order：按既有展示顺序（createdAt 降序）赋位置序号，只补缺失项；返回是否有补 */
function ensureOrders(todos: Todo[]): boolean {
  let changed = false;
  let i = 0;
  for (const t of [...todos].sort((a, b) => b.createdAt - a.createdAt)) {
    if (t.order == null) {
      t.order = i;
      changed = true;
    }
    i++;
  }
  return changed;
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
 * 展示顺序：order 升序（拖动排序）；缺 order / 并列回退 createdAt 降序（旧数据与极端并列的兜底）。
 */
export function mergeTodos(local: Todo[], remote: Todo[]): Todo[] {
  const byId = new Map(local.map((t) => [t.id, t]));
  for (const r of remote) {
    const l = byId.get(r.id);
    if (!l || r.updatedAt > l.updatedAt) byId.set(r.id, r);
  }
  return [...byId.values()].sort(compareDisplay);
}

/** 新条目置顶的 order：现存最小值减 1（无条目从 0 起） */
export function topOrder(todos: Todo[]): number {
  let min = Infinity;
  for (const t of todos) {
    if (t.order != null && t.order < min) min = t.order;
  }
  return min === Infinity ? 0 : min - 1;
}

/** 拖动落点写回：只改被拖条目的 order（最小改动面），bump updatedAt 参与双端 LWW */
export function withOrder(todo: Todo, order: number): Todo {
  return { ...todo, order, updatedAt: Date.now() };
}

/** 移动落点的 order：两邻条取中点，缺一侧取另一侧 ±1，两侧都缺用 fallback */
export function orderBetween(
  prev: Todo | undefined,
  next: Todo | undefined,
  fallback: number,
): number {
  if (prev?.order != null && next?.order != null) return (prev.order + next.order) / 2;
  if (prev?.order != null) return prev.order + 1;
  if (next?.order != null) return next.order - 1;
  return fallback;
}

/** 稳定序列化：对象键按字典序重排后输出，属性插入顺序不同的等价对象得到相同字符串 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) out[k] = src[k];
      return out;
    }
    return v;
  });
}

export function sameTodos(a: Todo[], b: Todo[]): boolean {
  if (a.length !== b.length) return false;
  // 稳定键序序列化：不依赖对象属性插入顺序，远端旧条目未过同序清洗也不会误判不同
  const key = (t: Todo) => stableStringify(t);
  const sort = (list: Todo[]) => [...list].map(key).sort();
  const [sa, sb] = [sort(a), sort(b)];
  return sa.every((v, i) => v === sb[i]);
}
