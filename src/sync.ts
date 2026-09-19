import { isValidDueDate, loadTodos, mergeTodos, normalizeCategory, normalizeOrder, purgeTombstones, saveTodos, sameTodos, type Todo } from "./todo";

export interface SyncConfig {
  gistId: string;
  token: string;
}

/** 旧版混存键（{gistId, token}），仅用于启动时一次性迁移 */
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

// ---------- 配置与 Token 存取 ----------
// Token 属敏感信息：Tauri 桌面端存 Store 插件文件（app_data_dir/my-tobo.json，与网页存储隔离，
// 清浏览器数据不丢失）；浏览器 / PWA 端回退 localStorage。gistId 非敏感，始终存 localStorage。
// CONFIG_KEY（旧版 {gistId, token} 混存键）仅用于启动时一次性迁移。

const GIST_ID_KEY = "my-tobo.sync.gistId";
const TOKEN_FALLBACK_KEY = "my-tobo.token";
const TOKEN_FILE_KEY = "github_token";

interface StoreLike {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
  save(): Promise<void>;
}

let tokenCache: string | null = null;
let storePromise: Promise<StoreLike | null> | undefined;

/** Tauri 环境才加载 Store；浏览器 / PWA 返回 null 走 localStorage 回退 */
function getStore(): Promise<StoreLike | null> {
  if (!("__TAURI_INTERNALS__" in window)) return Promise.resolve(null);
  storePromise ??= import("@tauri-apps/plugin-store")
    .then((m) => m.load("my-tobo.json", { autoSave: false }))
    .catch((err) => {
      console.error("[my-tobo] Store 初始化失败，Token 回退 localStorage：", err);
      return null;
    });
  return storePromise;
}

/** Token 读取：Store 优先，读失败按未保存处理（UI 引导重输），不抛错 */
async function vaultGet(): Promise<string | null> {
  const store = await getStore();
  if (!store) return safeGet(TOKEN_FALLBACK_KEY);
  try {
    const token = await store.get<string>(TOKEN_FILE_KEY);
    return typeof token === "string" && token !== "" ? token : null;
  } catch (err) {
    console.error("[my-tobo] Token Store 读取失败：", err);
    return null;
  }
}

/** Token 写入/清除：显式 save() 落盘；失败返回 false，由调用方决定提示 */
async function vaultSet(token: string | null): Promise<boolean> {
  const store = await getStore();
  if (!store) {
    if (token === null) safeRemove(TOKEN_FALLBACK_KEY);
    else return safeSet(TOKEN_FALLBACK_KEY, token);
    return true;
  }
  try {
    if (token === null) await store.delete(TOKEN_FILE_KEY);
    else await store.set(TOKEN_FILE_KEY, token);
    await store.save();
    return true;
  } catch (err) {
    console.error("[my-tobo] Token Store 写入失败：", err);
    return false;
  }
}

/** 启动时初始化：装载 Token 并迁移旧版混存配置（幂等；迁移失败保留旧键，下次重试） */
async function initSyncStorage(): Promise<void> {
  const storedToken = await vaultGet();
  const rawLegacy = safeGet(CONFIG_KEY);
  if (rawLegacy === null) {
    tokenCache = storedToken;
    return;
  }
  let legacyGistId = "";
  let legacyToken = "";
  try {
    const parsed: unknown = JSON.parse(rawLegacy);
    if (typeof parsed === "object" && parsed !== null) {
      const p = parsed as Partial<SyncConfig>;
      if (typeof p.gistId === "string") legacyGistId = p.gistId;
      if (typeof p.token === "string") legacyToken = p.token;
    }
  } catch (err) {
    console.warn("[my-tobo] 旧同步配置解析失败，忽略：", err);
  }
  tokenCache = storedToken ?? legacyToken;
  const persisted = tokenCache === null || (await vaultSet(tokenCache));
  if (persisted && (legacyGistId === "" || safeSet(GIST_ID_KEY, legacyGistId))) {
    safeRemove(CONFIG_KEY);
  } else {
    console.error("[my-tobo] 同步配置迁移未完成，保留旧键，下次启动重试");
  }
}

let storageReady: Promise<void> | undefined;

/** 首次用到配置前确保 Token 已装载；同步读缓存的调用方无需感知异步 */
function ensureStorageReady(): Promise<void> {
  storageReady ??= initSyncStorage();
  return storageReady;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    console.error("[my-tobo] localStorage 写入失败：", key, err);
    return false;
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

export function loadSyncConfig(): SyncConfig | null {
  const gistId = safeGet(GIST_ID_KEY)?.trim() ?? "";
  if (gistId === "" || tokenCache === null || tokenCache === "") return null;
  return { gistId, token: tokenCache };
}

/** gistId 与 Token 分开读：Token 丢失时设置弹窗仍能回填 gistId，用户只需重输 Token */
export function loadSyncGistId(): string {
  return safeGet(GIST_ID_KEY)?.trim() ?? "";
}

export async function saveSyncConfig(cfg: SyncConfig | null): Promise<boolean> {
  try {
    if (cfg) {
      if (!safeSet(GIST_ID_KEY, cfg.gistId)) return false;
      tokenCache = cfg.token;
      return await vaultSet(cfg.token);
    }
    tokenCache = null;
    safeRemove(GIST_ID_KEY);
    return await vaultSet(null);
  } catch (err) {
    console.error("同步配置写入失败：", err);
    return false;
  }
}

/** 容错：用户可能直接粘贴 Gist 页面地址（如 https://gist.github.com/<user>/<id>），提取末尾的 Gist ID */
function normalizeGistId(raw: string): string {
  const input = raw.trim();
  if (!/gist\.github\.com/i.test(input)) return input;
  const path = input.split(/[?#]/, 1)[0];
  const segments = path.split(/[\s/]+/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : input;
}

function getLastSync(): number | undefined {
  const raw = safeGet(LAST_SYNC_KEY);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

// ---------- Gist 响应缓存（ETag 条件请求） ----------
// 缓存上次 GET 的 ETag 与响应体：下次 GET 带 If-None-Match，远端未变化时
// GitHub 返回 304（无响应体），直接复用缓存，省流量且对配额友好。
const ETAG_KEY = "my-tobo.sync.etag";
const GIST_CACHE_KEY = "my-tobo.sync.gistCache";

function readEtag(): string | null {
  const etag = safeGet(ETAG_KEY);
  return etag ? etag : null;
}

function writeEtag(etag: string | null): void {
  if (etag === null) safeRemove(ETAG_KEY);
  else safeSet(ETAG_KEY, etag);
}

function readGistCache(): Record<string, unknown> | null {
  const raw = safeGet(GIST_CACHE_KEY);
  if (!raw) return null;
  try {
    const data: unknown = JSON.parse(raw);
    return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function writeGistCache(gist: Record<string, unknown>): void {
  safeSet(GIST_CACHE_KEY, JSON.stringify(gist));
}

async function gistRequest(
  cfg: SyncConfig,
  method: "GET" | "PATCH" | "POST",
  body?: unknown,
): Promise<Record<string, unknown>> {
  const url = method === "POST" ? `${API}/gists` : `${API}/gists/${cfg.gistId}`;
  const isGet = method === "GET";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  // 条件请求：带上次 ETag，远端未变化时服务端返回 304
  const cachedEtag = isGet ? readEtag() : null;
  if (cachedEtag) headers["If-None-Match"] = cachedEtag;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (isGet && res.status === 304) {
      const cached = readGistCache();
      if (cached) return cached;
      // 防御：有 ETag 却无缓存（异常场景）时清掉 ETag，下轮直接拉全量
      writeEtag(null);
      throw new Error("本地响应缓存缺失，已改为重新拉取");
    }
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
    const data = (await res.json()) as Record<string, unknown>;
    if (isGet) {
      const etag = res.headers.get("ETag");
      if (etag) {
        // 先写响应缓存再写 ETag：中途崩溃最多浪费一次全量请求，不会出现“有 ETag 无缓存”
        writeGistCache(data);
        writeEtag(etag);
      }
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 远端条目校验：id/text/createdAt/updatedAt 必填且类型正确，completed/deletedAt 可选但类型须对；
 * category/dueDate/notified 可选：类型或内容非法时按未填写清空，不作为丢弃依据；
 * 脏数据（Gist 被手动改坏等）返回 null 丢弃，防止污染渲染与本地存储。
 */
function sanitizeRemoteTodo(item: unknown): Todo | null {
  if (typeof item !== "object" || item === null) return null;
  const t = item as Todo;
  if (
    typeof t.id !== "string" ||
    t.id === "" ||
    typeof t.text !== "string" ||
    typeof t.createdAt !== "number" ||
    !Number.isFinite(t.createdAt) ||
    typeof t.updatedAt !== "number" ||
    !Number.isFinite(t.updatedAt) ||
    (t.completed !== undefined && typeof t.completed !== "boolean") ||
    (t.deletedAt != null && typeof t.deletedAt !== "number")
  ) {
    return null;
  }
  return {
    ...t,
    completed: t.completed ?? false,
    category: normalizeCategory(t.category),
    dueDate: isValidDueDate(t.dueDate) ? t.dueDate : undefined,
    notified: typeof t.notified === "boolean" ? t.notified : undefined,
    order: normalizeOrder(t.order),
  };
}

function parseRemoteTodos(gist: Record<string, unknown>): Todo[] {
  const files = gist.files as Record<string, { content?: string }> | undefined;
  const content = files?.[GIST_FILENAME]?.content;
  if (!content) return [];
  const data: unknown = JSON.parse(content);
  const { version } = (data ?? {}) as { version?: unknown };
  // 版本契约：无 version 的历史 payload 与已知版本（v1–v2，须与 gistPayload 同步）照常解析；
  // 未来/未知版本号只警告不拒绝，唯一整批放弃条件是 todos 非数组。
  if (version !== undefined && version !== 1 && version !== 2) {
    console.warn("[my-tobo] 远端数据版本号未识别（本机支持 v1–v2），仍尝试解析 todos：", version);
  }
  const todos = (data as { todos?: unknown })?.todos;
  if (!Array.isArray(todos)) return [];
  return todos.flatMap((item) => {
    const todo = sanitizeRemoteTodo(item);
    if (!todo) {
      console.error("[my-tobo] 同步数据中存在无效条目，已丢弃：", item);
      return [];
    }
    return [todo];
  });
}

function gistPayload(todos: Todo[]): string {
  return JSON.stringify({ version: 2, todos: purgeTombstones(todos) });
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

  async saveConfig(cfg: SyncConfig | null): Promise<boolean> {
    // 入库前做 Gist ID 容错，支持直接粘贴完整 Gist 地址
    if (cfg) cfg = { ...cfg, gistId: normalizeGistId(cfg.gistId) };
    if (!(await saveSyncConfig(cfg))) return false;
    this.emit(cfg ? { state: "idle", message: "" } : { state: "unconfigured", message: "" });
    return true;
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
    await ensureStorageReady();
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
      safeSet(LAST_SYNC_KEY, String(this.lastSync));
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
    if (!(await this.saveConfig({ gistId: created.id, token }))) {
      throw new Error("Gist 已创建，但 Token 本地保存失败，请在设置中重新保存");
    }
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
