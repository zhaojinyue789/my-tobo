import {
  isPermissionGranted,
  requestPermission,
  sendNotification as tauriSendNotification,
} from "@tauri-apps/plugin-notification";
import type { Todo } from "./todo";

/** 已授予缓存：只缓存肯定结果；拒绝/未决每次重查（用户可能随后在系统设置里放行） */
let permissionGranted = false;

/** Tauri 环境判断：纯浏览器（PWA）走 Web Notification 路径 */
function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

/** 通知附加负载：tag 去重同条目、data 携带任务 id（SW notificationclick 回传）、actions 为通知栏按钮 */
export interface NotificationPayload {
  icon?: string;
  tag?: string;
  data?: Record<string, unknown>;
  actions?: { action: string; title: string }[];
}

/** 权限检查 + 请求（仅在未授权时弹系统授权框）；任何失败返回 false，不抛错 */
export async function ensurePermission(): Promise<boolean> {
  if (permissionGranted) return true;
  try {
    if (isTauriRuntime()) {
      if (await isPermissionGranted()) {
        permissionGranted = true;
        return true;
      }
      if ((await requestPermission()) === "granted") {
        permissionGranted = true;
        return true;
      }
      return false;
    }
    // 浏览器 / PWA：Web Notification API
    if (typeof window === "undefined" || !("Notification" in window)) return false;
    if (Notification.permission === "granted") {
      permissionGranted = true;
      return true;
    }
    if (Notification.permission === "denied") return false;
    if ((await Notification.requestPermission()) === "granted") {
      permissionGranted = true;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 发送通知；IPC/系统层失败向上抛，由调用方决定降级。
 *  Tauri 端仅支持标题/正文/图标；浏览器 PWA 端经 ServiceWorker 发送（支持 tag/data/actions）。 */
export async function sendNotification(
  title: string,
  body: string,
  payload: NotificationPayload = {},
): Promise<void> {
  if (isTauriRuntime()) {
    await tauriSendNotification({ title, body, ...(payload.icon ? { icon: payload.icon } : {}) });
    return;
  }
  if (typeof window === "undefined" || !("Notification" in window)) {
    throw new Error("当前环境不支持通知");
  }
  // 经 SW 注册器发送才支持 actions（Android 通知栏按钮）；无 SW 时回退构造器（仅正文）
  if ("serviceWorker" in navigator) {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) {
      // DOM lib 的 NotificationOptions 类型声明不含 actions（SW 通道运行时支持）
      const swOptions = {
        body,
        icon: payload.icon,
        tag: payload.tag,
        data: payload.data,
        actions: payload.actions,
      } as unknown as NotificationOptions;
      await reg.showNotification(title, swOptions);
      return;
    }
  }
  const { actions: _actions, data: _data, tag: _tag, ...rest } = payload;
  new Notification(title, { body, ...rest });
}

/** 待办到期通知（调用方须先 ensurePermission）；通知带「完成 / 稍后」操作按钮 */
export async function notifyTodoDue(todo: Todo): Promise<void> {
  const body = todo.category ? `${todo.category}：${todo.text} 已到期` : `${todo.text} 已到期`;
  await sendNotification("待办已到期", body, {
    icon: "./icons/icon-256.png",
    tag: `my-tobo-due-${todo.id}`,
    data: { id: todo.id },
    actions: [
      { action: "complete", title: "✓ 完成" },
      { action: "snooze", title: "⏰ 稍后" },
    ],
  });
}

/** 「提前 1 天」到期提醒（调用方须先 ensurePermission） */
export async function notifyTodoTomorrow(todo: Todo): Promise<void> {
  const body = todo.category ? `${todo.category}：${todo.text} 明天到期` : `${todo.text} 明天到期`;
  await sendNotification("待办提醒", body, {
    icon: "./icons/icon-256.png",
    tag: `my-tobo-ahead-${todo.id}`,
  });
}
