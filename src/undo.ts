import {
  isDeleted,
  markDeleted,
  type OrderRestore,
  type OrderWrite,
  type RebalancePlan,
  type ReorderPlan,
  type Todo,
} from "./todo";

/**
 * undo/redo 命令栈：仅本地持久化（localStorage），不同步 Gist。
 * 命令统一形状 { type, payload, inverse }，JSON 可序列化；
 * 应用一律纯函数返回新数组；受影响条目 updatedAt 一律刷新为当前时间——
 * 同步层按 updatedAt 做整条 LWW，沿用旧时间戳会让撤销结果被远端覆盖（见 DECISIONS.md D4）。
 */

/** 栈上限：超出丢弃最旧（undo / redo 各自独立裁剪） */
export const UNDO_LIMIT = 50;

const UNDO_STORAGE_KEY = "my-tobo.undo";
const UNDO_STATE_VERSION = 1;

/** update 命令可修改的字段；null 表示清除该字段（还原为未填写/自动三态） */
export interface UpdateChanges {
  text?: string | null;
  completed?: boolean;
  category?: string | null;
  dueDate?: string | null;
  /** today 的 null = 还原为自动三态（undefined） */
  today?: boolean | null;
  /** allDay 的 null = 还原为缺省（undefined，视为全天） */
  allDay?: boolean | null;
}

export type Command =
  | { type: "create"; payload: { todo: Todo }; inverse: { id: string } }
  | {
      type: "update";
      payload: { id: string; changes: UpdateChanges };
      inverse: { id: string; changes: UpdateChanges };
    }
  | { type: "delete"; payload: { id: string }; inverse: { id: string; deletedAt: number | null } }
  | {
      type: "undelete";
      payload: { id: string };
      inverse: { id: string; deletedAt: number; updatedAt: number };
    }
  | {
      type: "clearAll";
      payload: { targets: Array<{ id: string }> };
      inverse: { restores: Array<{ id: string; deletedAt: number | null }> };
    }
  | {
      type: "reorder";
      payload: { id: string; writes: OrderWrite[] };
      inverse: { restores: OrderRestore[] };
    }
  | { type: "rebalance"; payload: { writes: OrderWrite[] }; inverse: { restores: OrderRestore[] } };

export interface UndoState {
  undo: Command[];
  redo: Command[];
}

// ---------- 持久化：旧数据无此 key / 结构损坏 → 空栈兜底，绝不抛错 ----------

export function loadUndoState(): UndoState {
  try {
    const raw = localStorage.getItem(UNDO_STORAGE_KEY);
    if (!raw) return { undo: [], redo: [] };
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return { undo: [], redo: [] };
    const { v, undo, redo } = data as { v?: unknown; undo?: unknown; redo?: unknown };
    if (v !== UNDO_STATE_VERSION || !Array.isArray(undo) || !Array.isArray(redo)) {
      return { undo: [], redo: [] };
    }
    return { undo: reviveCommands(undo), redo: reviveCommands(redo) };
  } catch {
    return { undo: [], redo: [] };
  }
}

export function saveUndoState(state: UndoState): boolean {
  try {
    localStorage.setItem(
      UNDO_STORAGE_KEY,
      JSON.stringify({ v: UNDO_STATE_VERSION, undo: state.undo, redo: state.redo }),
    );
    return true;
  } catch (err) {
    // 配额满等写失败：栈退化为会话内存态（本次会话仍可撤销），不阻塞主流程
    console.warn("[my-tobo] 撤销栈持久化失败（仅本次会话内有效）：", err);
    return false;
  }
}

const COMMAND_TYPES = new Set([
  "create",
  "update",
  "delete",
  "undelete",
  "clearAll",
  "reorder",
  "rebalance",
]);

/** 逐条结构校验：非法条目剔除（保留其余可用历史），整体损坏由上层空栈兜底 */
function reviveCommands(list: unknown[]): Command[] {
  return list.flatMap((raw) => {
    const cmd = reviveCommand(raw);
    return cmd ? [cmd] : [];
  });
}

function reviveCommand(raw: unknown): Command | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.type !== "string" || !COMMAND_TYPES.has(r.type)) return null;
  if (typeof r.payload !== "object" || r.payload === null) return null;
  if (typeof r.inverse !== "object" || r.inverse === null) return null;
  if (r.type === "reorder" || r.type === "rebalance") {
    const p = r.payload as { writes?: unknown };
    const inv = r.inverse as { restores?: unknown };
    if (!isValidOrderList(p.writes) || !isValidRestoreList(inv.restores)) return null;
  }
  return raw as Command;
}

function isValidOrderList(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every(
      (w) =>
        typeof w === "object" &&
        w !== null &&
        typeof (w as OrderWrite).id === "string" &&
        typeof (w as OrderWrite).order === "number",
    )
  );
}

function isValidRestoreList(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every((r) => {
      if (typeof r !== "object" || r === null) return false;
      const order = (r as OrderRestore).order;
      return typeof (r as OrderRestore).id === "string" && (order === null || typeof order === "number");
    })
  );
}

// ---------- 命令应用（纯函数：返回新数组，不改入参） ----------

const now = (): number => Date.now();

/** changes 里的 null 还原为 undefined（JSON 序列化无 undefined，用 null 表示「清除字段」） */
function resolveChanges(changes: UpdateChanges): Partial<Todo> {
  const out: Partial<Todo> = {};
  if (changes.completed !== undefined) out.completed = changes.completed;
  if (changes.text !== undefined && changes.text !== null) out.text = changes.text;
  if (changes.category !== undefined) {
    out.category = changes.category === null ? undefined : changes.category;
  }
  if (changes.dueDate !== undefined) {
    out.dueDate = changes.dueDate === null ? undefined : changes.dueDate;
  }
  if (changes.today !== undefined) {
    out.today = changes.today === null ? undefined : changes.today;
  }
  if (changes.allDay !== undefined) {
    out.allDay = changes.allDay === null ? undefined : changes.allDay;
  }
  return out;
}

function applyOrderWrites(todos: Todo[], writes: OrderWrite[]): Todo[] {
  const byId = new Map(writes.map((w) => [w.id, w.order]));
  return todos.map((t) => (byId.has(t.id) ? { ...t, order: byId.get(t.id), updatedAt: now() } : t));
}

function applyOrderRestores(todos: Todo[], restores: OrderRestore[]): Todo[] {
  const byId = new Map(restores.map((r) => [r.id, r.order]));
  return todos.map((t) => {
    if (!byId.has(t.id)) return t;
    const order = byId.get(t.id);
    const next: Todo = { ...t, updatedAt: now() };
    if (order === null) delete next.order;
    else next.order = order;
    return next;
  });
}

/** 正向应用（新动作 / 重做）；引用的 id 已不存在时逐条跳过，不报错 */
export function applyForward(cmd: Command, todos: Todo[]): Todo[] {
  switch (cmd.type) {
    case "create": {
      const existing = todos.find((t) => t.id === cmd.payload.todo.id);
      if (!existing) return [...todos, cmd.payload.todo];
      if (!isDeleted(existing)) return todos; // 已存在且未删：幂等跳过
      return todos.map((t) =>
        t.id === existing.id ? { ...t, deletedAt: undefined, updatedAt: now() } : t,
      );
    }
    case "update": {
      const changes = resolveChanges(cmd.payload.changes);
      return todos.map((t) => (t.id === cmd.payload.id ? { ...t, ...changes, updatedAt: now() } : t));
    }
    case "delete":
      return todos.map((t) => (t.id === cmd.payload.id && !isDeleted(t) ? markDeleted(t) : t));
    case "undelete":
      return todos.map((t) =>
        t.id === cmd.payload.id && isDeleted(t) ? { ...t, deletedAt: undefined, updatedAt: now() } : t,
      );
    case "clearAll": {
      const ids = new Set(cmd.payload.targets.map((x) => x.id));
      return todos.map((t) => (ids.has(t.id) && !isDeleted(t) ? markDeleted(t) : t));
    }
    case "reorder":
    case "rebalance":
      return applyOrderWrites(todos, cmd.payload.writes);
  }
}

/** 逆向应用（撤销）；同上，失效 id 静默跳过 */
export function applyInverse(cmd: Command, todos: Todo[]): Todo[] {
  switch (cmd.type) {
    case "create":
      // 撤销新建 = 打墓碑（物理删除会被远端合并复活）；条目已不在则跳过
      return todos.map((t) => (t.id === cmd.inverse.id && !isDeleted(t) ? markDeleted(t) : t));
    case "update": {
      const changes = resolveChanges(cmd.inverse.changes);
      return todos.map((t) => (t.id === cmd.inverse.id ? { ...t, ...changes, updatedAt: now() } : t));
    }
    case "delete":
      return todos.map((t) => {
        if (t.id !== cmd.inverse.id || !isDeleted(t)) return t;
        return { ...t, deletedAt: cmd.inverse.deletedAt ?? undefined, updatedAt: now() };
      });
    case "undelete":
      return todos.map((t) =>
        t.id === cmd.inverse.id && !isDeleted(t)
          ? { ...t, deletedAt: cmd.inverse.deletedAt, updatedAt: now() }
          : t,
      );
    case "clearAll": {
      const byId = new Map(cmd.inverse.restores.map((r) => [r.id, r.deletedAt]));
      return todos.map((t) => {
        if (!byId.has(t.id) || !isDeleted(t)) return t;
        return { ...t, deletedAt: byId.get(t.id) ?? undefined, updatedAt: now() };
      });
    }
    case "reorder":
    case "rebalance":
      return applyOrderRestores(todos, cmd.inverse.restores);
  }
}

// ---------- 命令工厂（动作发生前捕获旧值） ----------

export function makeCreateCommand(todo: Todo): Command {
  return { type: "create", payload: { todo }, inverse: { id: todo.id } };
}

export function makeUpdateCommand(
  id: string,
  before: UpdateChanges,
  after: UpdateChanges,
): Command {
  return { type: "update", payload: { id, changes: after }, inverse: { id, changes: before } };
}

/** target 须为现存（未删）条目 */
export function makeDeleteCommand(target: Todo): Command {
  return { type: "delete", payload: { id: target.id }, inverse: { id: target.id, deletedAt: null } };
}

/** 预留命令（当前无 UI 触发）；target 须为已删条目 */
export function makeUndeleteCommand(target: Todo): Command {
  return {
    type: "undelete",
    payload: { id: target.id },
    inverse: {
      id: target.id,
      deletedAt: target.deletedAt as number,
      updatedAt: target.updatedAt,
    },
  };
}

/** targets 须为操作时的现存条目；清除全部 / 清除已完成共用此单条命令 */
export function makeClearAllCommand(targets: Todo[]): Command {
  return {
    type: "clearAll",
    payload: { targets: targets.map((t) => ({ id: t.id })) },
    inverse: { restores: targets.map((t) => ({ id: t.id, deletedAt: null })) },
  };
}

/** 一次拖拽 = 一条 reorder 命令（writes 已含首次物化与内联重整，一次撤销完整还原） */
export function makeReorderCommand(plan: ReorderPlan): Command {
  return {
    type: "reorder",
    payload: { id: plan.id, writes: plan.writes },
    inverse: { restores: plan.restores },
  };
}

/** 独立批量重整命令 */
export function makeRebalanceCommand(plan: RebalancePlan): Command {
  return {
    type: "rebalance",
    payload: { writes: plan.writes },
    inverse: { restores: plan.restores },
  };
}

// ---------- 命令栈 ----------

/** 栈本身只管进出与持久化；命令如何应用到数据由 main.ts 调用 apply* 完成 */
export class CommandStack {
  private undoList: Command[];
  private redoList: Command[];

  constructor(state: UndoState = { undo: [], redo: [] }) {
    this.undoList = state.undo;
    this.redoList = state.redo;
  }

  get canUndo(): boolean {
    return this.undoList.length > 0;
  }

  get canRedo(): boolean {
    return this.redoList.length > 0;
  }

  /** 新动作入栈：清空 redo（新分叉），超限丢最旧 */
  push(cmd: Command): void {
    this.undoList.push(cmd);
    if (this.undoList.length > UNDO_LIMIT) this.undoList.shift();
    this.redoList = [];
    this.persist();
  }

  /** 撤销：弹出待撤销命令（调用方应用 inverse 后须 pushRedo） */
  popUndo(): Command | null {
    const cmd = this.undoList.pop();
    if (cmd) this.persist();
    return cmd ?? null;
  }

  /** 撤销后命令进入 redo 栈，超限丢最旧 */
  pushRedo(cmd: Command): void {
    this.redoList.push(cmd);
    if (this.redoList.length > UNDO_LIMIT) this.redoList.shift();
    this.persist();
  }

  /** 重做：弹出待重做命令（调用方应用 payload 后须 push 回 undo 栈） */
  popRedo(): Command | null {
    const cmd = this.redoList.pop();
    if (cmd) this.persist();
    return cmd ?? null;
  }

  private persist(): void {
    saveUndoState({ undo: this.undoList, redo: this.redoList });
  }
}
