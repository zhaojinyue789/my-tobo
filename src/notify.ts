import {
  isPermissionGranted,
  requestPermission,
  sendNotification as tauriSendNotification,
} from "@tauri-apps/plugin-notification";
import type { Todo } from "./todo";

/** 已授予缓存：只缓存肯定结果；拒绝/未决每次重查（用户可能随后在系统设置里放行） */
let permissionGranted = false;

/** Tauri 环境判断：纯浏览器（vite dev / PWA）下静默降级，不抛错 */
function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

/** 权限检查 + 请求（仅在未授权时弹系统授权框）；任何失败返回 false，不抛错 */
export async function ensurePermission(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  if (permissionGranted) return true;
  try {
    if (await isPermissionGranted()) {
      permissionGranted = true;
      return true;
    }
    if ((await requestPermission()) === "granted") {
      permissionGranted = true;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 发送通知；IPC/系统层失败向上抛，由调用方决定降级 */
export async function sendNotification(title: string, body: string, icon?: string): Promise<void> {
  await tauriSendNotification({ title, body, ...(icon ? { icon } : {}) });
}

/** 待办到期通知（调用方须先 ensurePermission） */
export async function notifyTodoDue(todo: Todo): Promise<void> {
  const body = todo.category ? `${todo.category}：${todo.text} 已到期` : `${todo.text} 已到期`;
  await sendNotification("待办已到期", body);
}
