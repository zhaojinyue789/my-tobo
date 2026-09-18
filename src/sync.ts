import { loadTodos, mergeTodos, purgeTombstones, saveTodos, sameTodos, type Todo } from "./todo";

export interface SyncConfig {
  gistId: string;
  token: string;
}

const CONFIG_KEY = "my-tobo.sync";
const LAST_SYNC_KEY = "my-tobo.sync.lastSync";
const GIST_FILENAME = "my-tobo.json";
const API = "https://api.github.com";
/** 本地变更后的防抖推送延时 */
const DEBOUNCE_MS = 3000;
/** 自动轮询间隔：常态拉取远端 */
const POLL_INTERVAL_MS = 30_000;
/** 失败重试：15s 起指数退避 */
const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = 120_000;
/** 单次请求超时：网络挂起（断连/代理卡死）时 fetch 可能长时间不返回，卡死整个同步循环 */
const REQUEST_TIMEOUT_MS = 15_000;

export type SyncState = "unconfigured" | "idle" | "syncing" | "ok" | "error";

export interface SyncStatus {
  state: SyncState;
  message: string;
  lastSync?: number;
}

export function loadSyncConfig(): SyncConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const cfg: unknown = JSON.parse(raw);
    if (
      typeof cfg !== "object" ||
      cfg === null ||
      typeof (cfg as SyncConfig).gistId !== "string" ||
      typeof (cfg as SyncConfig).token !== "string" ||
      (cfg as SyncConfig).gistId === "" ||
      (cfg as SyncConfig).token === ""
    ) {
      return null;
    }
    return cfg as SyncConfig;
  } catch {
    return null;
  }
}

export function saveSyncConfig(cfg: SyncConfig | null): void {
  if (cfg) localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  else localStorage.removeItem(CONFIG_KEY);
}

function getLastSync(): number | undefined {
  const raw = localStorage.getItem(LAST_SYNC_KEY);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

async function gistRequest(
  cfg: SyncConfig,
  method: "GET" | "PATCH" | "POST",
  body?: unknown,
): Promise<Record<string, unknown>> {
  const url = method === "POST" ? `${API}/gists` : `${API}/gists/${cfg.gistId}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json())?.message ?? "";
      } catch {
        /* 忽略非 JSON 响应体 */
      }
      if (res.status === 401) throw new Error("Token 无效或已过期（401）");
      if (res.status === 404) throw new Error("Gist 不存在，或 Token 无权访问它（404）");
      if (res.status === 403 && detail.includes("rate limit"))
        throw new Error("超出 GitHub API 速率限制，请稍后再试（403）");
      throw new Error(`GitHub API 错误 ${res.status}${detail ? `：${detail}` : ""}`);
    }
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

function parseRemoteTodos(gist: Record<string, unknown>): Todo[] {
  const files = gist.files as Record<string, { content?: string }> | undefined;
  const content = files?.[GIST_FILENAME]?.content;
  if (!content) return [];
  const data: unknown = JSON.parse(content);
  const todos = (data as { todos?: unknown })?.todos;
  return Array.isArray(todos) ? (todos as Todo[]) : [];
}

function gistPayload(todos: Todo[]): string {
  return JSON.stringify({ version: 1, todos: purgeTombstones(todos) });
}

interface SyncHooks {
  /** 合并结果写回本地后回调，UI 用它刷新列表 */
  onTodos: (todos: Todo[]) => void;
  onStatus: (status: SyncStatus) => void;
}

export class SyncController {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private rerun = false;
  private lastSync: number | undefined = getLastSync();
  private status: SyncStatus = { state: "idle", message: "" };
  private autoTimer: ReturnType<typeof setTimeout> | undefined;
  private failureCount = 0;

  constructor(private hooks: SyncHooks) {}

  hasConfig(): boolean {
    return loadSyncConfig() !== null;
  }

  saveConfig(cfg: SyncConfig | null): void {
    saveSyncConfig(cfg);
    this.emit(cfg ? { state: "idle", message: "" } : { state: "unconfigured", message: "" });
  }

  /** 本地数据变更后调用：防抖自动同步 */
  onLocalChange(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.syncNow(), DEBOUNCE_MS);
  }

  /**
   * 自动同步循环：常态每 30 秒拉一次远端（手机端的改动电脑端才能自动感知），
   * 失败时指数退避（15s 起，封顶 2 分钟），成功后恢复 30 秒节奏。
   */
  startAutoSync(): void {
    this.scheduleNext(POLL_INTERVAL_MS);
  }

  private scheduleNext(delay: number): void {
    clearTimeout(this.autoTimer);
    this.autoTimer = setTimeout(() => void this.autoTick(), delay);
  }

  private async autoTick(): Promise<void> {
    await this.syncNow();
    if (this.status.state === "error") {
      this.failureCount = Math.min(this.failureCount + 1, 4);
      this.scheduleNext(Math.min(RETRY_BASE_MS * 2 ** this.failureCount, RETRY_MAX_MS));
    } else {
      this.failureCount = 0;
      this.scheduleNext(POLL_INTERVAL_MS);
    }
  }

  /** 启动时拉取 + 手动同步共用 */
  async syncNow(): Promise<void> {
    const cfg = loadSyncConfig();
    if (!cfg) {
      this.emit({ state: "unconfigured", message: "" });
      return;
    }
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    this.emit({ state: "syncing", message: "同步中…" });
    try {
      const remoteGist = await gistRequest(cfg, "GET");
      const remote = parseRemoteTodos(remoteGist);
      const local = loadTodos();
      let merged = purgeTombstones(mergeTodos(local, remote));

      // 远端与合并结果不同则推回；本地与合并结果不同则落库刷新
      if (!sameTodos(merged, remote)) {
        await gistRequest(cfg, "PATCH", { files: { [GIST_FILENAME]: { content: gistPayload(merged) } } });
      }
      // PATCH 往返期间用户可能又改了本地：写回前重读一次再合并，
      // 避免用过期快照覆盖用户新输入（否则新待办会凭空消失）
      const fresh = loadTodos();
      const localChanged = !sameTodos(fresh, local);
      if (localChanged) {
        merged = purgeTombstones(mergeTodos(fresh, merged));
      }
      if (!sameTodos(merged, fresh)) {
        saveTodos(merged);
        this.hooks.onTodos(merged);
      }
      if (localChanged) {
        // 期间的用户改动尚未推到远端，防抖后补推
        this.onLocalChange();
      }
      this.lastSync = Date.now();
      localStorage.setItem(LAST_SYNC_KEY, String(this.lastSync));
      this.emit({ state: "ok", message: "", lastSync: this.lastSync });
    } catch (err) {
      const message =
        err instanceof DOMException && err.name === "AbortError"
          ? "网络超时，稍后自动重试"
          : err instanceof TypeError
            ? "网络不可用，稍后自动重试"
            : err instanceof Error
              ? err.message
              : String(err);
      this.emit({ state: "error", message, lastSync: this.lastSync });
    } finally {
      this.running = false;
      if (this.rerun) {
        this.rerun = false;
        this.onLocalChange();
      }
    }
  }

  /** 用当前本地待办创建一个私密 Gist 并保存配置，返回 Gist 地址 */
  async createGist(token: string): Promise<string> {
    const created = (await gistRequest({ gistId: "", token }, "POST", {
      description: "my-tobo 待办同步数据",
      public: false,
      files: { [GIST_FILENAME]: { content: gistPayload(loadTodos()) } },
    })) as { id?: string; html_url?: string };
    if (!created.id) throw new Error("创建 Gist 失败：响应中没有 id");
    this.saveConfig({ gistId: created.id, token });
    return created.html_url ?? `https://gist.github.com/${created.id}`;
  }

  private emit(status: SyncStatus): void {
    this.status = status;
    this.hooks.onStatus(status);
  }

  get currentStatus(): SyncStatus {
    return this.status;
  }
}
