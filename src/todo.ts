export interface Todo {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
  /** 最后一次修改时间，双端同步按此项做 LWW 合并 */
  updatedAt: number;
  /** 删除墓碑：有值表示已删除，保留 30 天后物理清除，防止删除被同步复活 */
  deletedAt?: number;
}

const STORAGE_KEY = "my-tobo.todos";
/** 墓碑保留时长：超过后物理清除（另一端 30 天内未同步才会受影响） */
const TOMBSTONE_TTL = 30 * 24 * 60 * 60 * 1000;

export function isDeleted(todo: Todo): boolean {
  return todo.deletedAt != null;
}

export function loadTodos(): Todo[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .filter(
        (item): item is Todo =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Todo).id === "string" &&
          typeof (item as Todo).text === "string" &&
          typeof (item as Todo).completed === "boolean",
      )
      .map(migrate);
  } catch {
    return [];
  }
}

/** 旧版本数据没有 updatedAt/deletedAt，读取时补齐 */
function migrate(item: Todo): Todo {
  return {
    ...item,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : item.createdAt,
    deletedAt: typeof item.deletedAt === "number" ? item.deletedAt : undefined,
  };
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
