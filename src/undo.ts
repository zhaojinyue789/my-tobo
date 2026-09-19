import type { Todo } from "./todo";

/**
 * undo/redo 命令栈：仅本地持久化（localStorage），不同步 Gist。
 * 命令统一形状 { type, payload, inverse }，JSON 可序列化；
 * 应用逻辑（applyForward/applyInverse）与命令工厂见本模块下方与后续提交。
 */

/** 栈上限：超出丢弃最旧（undo / redo 各自独立裁剪） */
export const UNDO_LIMIT = 50;

const UNDO_STORAGE_KEY = "my-tobo.undo";
const UNDO_STATE_VERSION = 1;

/** update 命令可修改的字段；null 表示清除该字段（还原为未填写） */
export interface UpdateChanges {
  text?: string | null;
  completed?: boolean;
  category?: string | null;
  dueDate?: string | null;
}

/** order 写入项（reorder/rebalance 正向应用） */
export interface OrderWrite {
  id: string;
  order: number;
}

/** order 还原项；order = null 表示该条目此前没有 order 字段，撤销时移除 */
export interface OrderRestore {
  id: string;
  order: number | null;
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
