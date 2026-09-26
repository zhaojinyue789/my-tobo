import { loadSyncConfig, loadSyncGistId, type SyncController } from "./sync";
import { setupModal } from "./modal";

export interface SyncModalRefs {
  settingsBtn: HTMLButtonElement;
  modal: HTMLElement;
  gistTokenInput: HTMLInputElement;
  gistIdInput: HTMLInputElement;
  modalError: HTMLElement;
  gistCreateBtn: HTMLButtonElement;
  gistSaveBtn: HTMLButtonElement;
  gistDisconnectBtn: HTMLButtonElement;
  gistCloseBtn: HTMLButtonElement;
}

/** 同步设置模态框：Token/Gist 录入、一键创建 Gist、断开、关闭（含点遮罩关闭） */
export function setupSyncModal(refs: SyncModalRefs, sync: SyncController): void {
  const {
    settingsBtn,
    modal,
    gistTokenInput,
    gistIdInput,
    modalError,
    gistCreateBtn,
    gistSaveBtn,
    gistDisconnectBtn,
    gistCloseBtn,
  } = refs;

  // 对话框通用行为：焦点陷阱 / Esc 关闭 / 归还焦点 / 点遮罩关闭
  const handle = setupModal(modal);

  function showModalError(message: string): void {
    modalError.textContent = message;
    modalError.classList.remove("hidden");
  }

  function setModalBusy(busy: boolean): void {
    for (const btn of [gistCreateBtn, gistSaveBtn, gistDisconnectBtn, gistCloseBtn]) {
      btn.disabled = busy;
    }
  }

  settingsBtn.addEventListener("click", () => {
    const cfg = loadSyncConfig();
    // Token 读不到时（Store 读取失败/换机等）保留 gistId 回填，用户只需重输 Token
    gistIdInput.value = cfg?.gistId ?? loadSyncGistId();
    gistTokenInput.value = cfg?.token ?? "";
    modalError.classList.add("hidden");
    if (!cfg && gistIdInput.value) showModalError("未读取到已保存的 Token，请重新输入");
    handle.open(gistTokenInput);
  });

  gistCloseBtn.addEventListener("click", handle.close);

  gistCreateBtn.addEventListener("click", async () => {
    const token = gistTokenInput.value.trim();
    if (!token) return showModalError("创建 Gist 前请先填入 Token");
    setModalBusy(true);
    try {
      const url = await sync.createGist(token);
      gistIdInput.value = loadSyncConfig()?.gistId ?? "";
      gistCloseBtn.textContent = "完成";
      console.info("已创建私密 Gist：", url);
    } catch (err) {
      showModalError(err instanceof Error ? err.message : String(err));
    } finally {
      setModalBusy(false);
    }
  });

  gistSaveBtn.addEventListener("click", async () => {
    const token = gistTokenInput.value.trim();
    const gistId = gistIdInput.value.trim();
    if (!token || !gistId) return showModalError("Token 和 Gist ID 都需要填写");
    setModalBusy(true);
    const ok = await sync.saveConfig({ token, gistId });
    setModalBusy(false);
    if (!ok) {
      showModalError("本地存储写入失败，配置未保存，请检查存储空间");
      return;
    }
    handle.close();
    void sync.syncNow();
  });

  gistDisconnectBtn.addEventListener("click", () => {
    void sync.saveConfig(null);
    gistTokenInput.value = "";
    gistIdInput.value = "";
    handle.close();
  });
}
