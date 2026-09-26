import { loadSyncConfig, loadSyncGistId, type SyncController } from "./sync";

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

  /** 关闭前的焦点元素：关闭后归还，屏幕阅读器/键盘用户回到触发按钮 */
  let lastFocused: HTMLElement | null = null;

  function openModal(): void {
    lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const cfg = loadSyncConfig();
    // Token 读不到时（Store 读取失败/换机等）保留 gistId 回填，用户只需重输 Token
    gistIdInput.value = cfg?.gistId ?? loadSyncGistId();
    gistTokenInput.value = cfg?.token ?? "";
    modalError.classList.add("hidden");
    if (!cfg && gistIdInput.value) showModalError("未读取到已保存的 Token，请重新输入");
    modal.classList.remove("hidden");
    gistTokenInput.focus();
  }

  function closeModal(): void {
    modal.classList.add("hidden");
    lastFocused?.focus();
    lastFocused = null;
  }

  function showModalError(message: string): void {
    modalError.textContent = message;
    modalError.classList.remove("hidden");
  }

  function setModalBusy(busy: boolean): void {
    for (const btn of [gistCreateBtn, gistSaveBtn, gistDisconnectBtn, gistCloseBtn]) {
      btn.disabled = busy;
    }
  }

  settingsBtn.addEventListener("click", openModal);

  gistCloseBtn.addEventListener("click", closeModal);

  // 点击遮罩关闭
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  // 对话框键盘模型：Tab 循环限制在弹窗内（焦点陷阱），Esc 关闭并归还焦点
  modal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation(); // 不触发全局 Esc（只关筛选菜单）的语义混叠
      closeModal();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = [
      ...modal.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select, a[href], [tabindex]:not([tabindex='-1'])",
      ),
    ].filter((el) => el.offsetParent !== null); // offsetParent 为 null = 不可见
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const outside = !(active instanceof HTMLElement) || !modal.contains(active);
    if (e.shiftKey) {
      if (active === first || outside) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || outside) {
      e.preventDefault();
      first.focus();
    }
  });

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
    closeModal();
    void sync.syncNow();
  });

  gistDisconnectBtn.addEventListener("click", () => {
    void sync.saveConfig(null);
    gistTokenInput.value = "";
    gistIdInput.value = "";
    closeModal();
  });
}
