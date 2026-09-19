import { isDeleted, todayISO, type Todo } from "./todo";

/**
 * 「今天」视图与本地视图状态（tab / 每日日志 / 专注会话）。
 * 本模块全部状态仅存 localStorage、不进 Gist（DECISIONS.md D13）。
 */

// ---------- 「今天」成员判定（三态，DESIGN P2-2） ----------

/** true=手动加入；false=手动移出（不再自动拉回）；缺省=自动（dueDate≤今天，含过期） */
export function isTodayMember(t: Todo, today: string = todayISO()): boolean {
  if (isDeleted(t)) return false;
  if (t.today === true) return true;
  if (t.today === false) return false;
  return t.dueDate != null && t.dueDate <= today;
}

export function todayMembers(todos: Todo[], today: string = todayISO()): Todo[] {
  return todos.filter((t) => isTodayMember(t, today));
}

/** 今天 tab 分组：过期（未完成且 dueDate<今天）置顶组 + 其余（含已完成的历史过期项） */
export function splitTodayOverdue(
  members: Todo[],
  today: string = todayISO(),
): { overdue: Todo[]; rest: Todo[] } {
  const isOverdueItem = (t: Todo): boolean => !t.completed && t.dueDate != null && t.dueDate < today;
  return { overdue: members.filter(isOverdueItem), rest: members.filter((t) => !isOverdueItem(t)) };
}

/** 本地日期平移：明天 = dateShift(todayISO(), 1)；输入输出均为 YYYY-MM-DD */
export function dateShift(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, (m ?? 1) - 1, (d ?? 1) + days);
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

// ---------- tab 持久化 ----------

export type TodayTab = "today" | "all";

const TAB_KEY = "todoview_tab";

export function loadTab(): TodayTab {
  try {
    return localStorage.getItem(TAB_KEY) === "all" ? "all" : "today";
  } catch {
    return "today";
  }
}

export function saveTab(tab: TodayTab): void {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    /* 写失败仅影响记忆，功能不受损 */
  }
}

// ---------- 每日日志（单日对象 + 30 天滚动清理，DECISIONS.md U5） ----------

export interface DailyLog {
  date: string;
  completedIds: string[];
  skippedIds: string[];
}

const DAILY_KEY = "todoview_daily";
/** 日志保留窗口：早于 today-N 天的陈旧日志整体丢弃（只清日志，不碰 todos） */
const DAILY_TTL_DAYS = 30;

function normalizeDaily(raw: unknown, today: string): DailyLog | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Partial<DailyLog>;
  if (typeof o.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.date)) return null;
  // 30 天滚动清理：陈旧日期直接视为无日志
  if (o.date < dateShift(today, -DAILY_TTL_DAYS)) return null;
  const ids = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return { date: o.date, completedIds: ids(o.completedIds), skippedIds: ids(o.skippedIds) };
}

export function loadDaily(today: string = todayISO()): DailyLog | null {
  try {
    const raw = localStorage.getItem(DAILY_KEY);
    if (!raw) return null;
    return normalizeDaily(JSON.parse(raw), today);
  } catch {
    return null;
  }
}

export function saveDaily(log: DailyLog): void {
  try {
    localStorage.setItem(DAILY_KEY, JSON.stringify(log));
  } catch {
    /* 日志写失败不影响主流程 */
  }
}

/** 关闭回顾 = 换日：写入今天的空日志，当天不再弹（DECISIONS.md D17） */
export function promoteDaily(today: string = todayISO()): void {
  saveDaily({ date: today, completedIds: [], skippedIds: [] });
}

function mutateDaily(today: string, fn: (log: DailyLog) => void): void {
  // 日志不是今天的（昨日残留且回顾尚未关闭）：直接开新日志，避免把今天的完成写进昨日条目
  const existing = loadDaily(today);
  const log = existing && existing.date === today ? existing : { date: today, completedIds: [], skippedIds: [] };
  fn(log);
  saveDaily(log);
}

export function appendDailyCompletion(id: string, today: string = todayISO()): void {
  mutateDaily(today, (log) => {
    if (!log.completedIds.includes(id)) log.completedIds.push(id);
  });
}

export function removeDailyCompletion(id: string, today: string = todayISO()): void {
  mutateDaily(today, (log) => {
    log.completedIds = log.completedIds.filter((x) => x !== id);
  });
}

export function appendDailySkip(id: string, today: string = todayISO()): void {
  mutateDaily(today, (log) => {
    if (!log.skippedIds.includes(id)) log.skippedIds.push(id);
  });
}

// ---------- 专注会话（权威运行态，DECISIONS.md D14） ----------

export interface FocusSession {
  id: string;
  /** 运行中 = 起始时间戳；暂停 = null */
  startedAt: number | null;
  /** 已暂停累计的毫秒数 */
  accumulatedMs: number;
  /** 最近一次写状态的时间（跨日恢复判断用） */
  savedAt: number;
}

const FOCUS_KEY = "todoview_focus";

export function loadFocusState(): FocusSession | null {
  try {
    const raw = localStorage.getItem(FOCUS_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<FocusSession>;
    if (typeof o.id !== "string" || typeof o.accumulatedMs !== "number" || !Number.isFinite(o.accumulatedMs)) {
      return null;
    }
    return {
      id: o.id,
      startedAt: typeof o.startedAt === "number" && Number.isFinite(o.startedAt) ? o.startedAt : null,
      accumulatedMs: Math.max(0, Math.round(o.accumulatedMs)),
      savedAt: typeof o.savedAt === "number" && Number.isFinite(o.savedAt) ? o.savedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function saveFocusState(session: FocusSession): void {
  try {
    localStorage.setItem(FOCUS_KEY, JSON.stringify({ ...session, savedAt: Date.now() }));
  } catch {
    /* 恢复镜像写失败不影响当前会话 */
  }
}

export function clearFocusState(): void {
  try {
    localStorage.removeItem(FOCUS_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 差值法计时：与 tick 无关，后台降频/休眠/时钟回拨免疫（DECISIONS.md D18） */
export function computeFocusElapsed(accumulatedMs: number, startedAt: number | null, now: number = Date.now()): number {
  const running = startedAt != null ? Math.max(0, now - startedAt) : 0;
  return Math.max(0, accumulatedMs) + running;
}

/** 毫秒 → HH:MM:SS（时/分/秒各两位补零） */
export function formatHMS(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}
