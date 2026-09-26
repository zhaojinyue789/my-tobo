export type ThemeMode = "auto" | "light" | "dark";

const THEME_KEY = "my-tobo.theme";
const MODES: ThemeMode[] = ["auto", "light", "dark"];

/** 三种模式的图标与文案（SVG 内联，与同步栏图标风格一致） */
const ICONS: Record<ThemeMode, string> = {
  auto: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" /></svg>`,
  light: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></svg>`,
  dark: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>`,
};

const LABELS: Record<ThemeMode, string> = { auto: "跟随系统", light: "浅色", dark: "深色" };

function loadMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw === "light" || raw === "dark" ? raw : "auto";
  } catch {
    return "auto";
  }
}

/** 应用主题模式：auto 移除 data-theme 跟随系统，light/dark 显式覆盖（CSS 按 data-theme 切换令牌） */
export function applyTheme(mode: ThemeMode): void {
  if (mode === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", mode);
}

/** 主题切换按钮：点击在 自动 → 浅色 → 深色 间循环，选择持久化 */
export function setupThemeToggle(btn: HTMLButtonElement): void {
  let mode = loadMode();
  applyTheme(mode);

  const render = (): void => {
    btn.innerHTML = ICONS[mode];
    btn.setAttribute("aria-label", `主题：${LABELS[mode]}，点击切换`);
    btn.title = `主题：${LABELS[mode]}`;
    btn.dataset.mode = mode;
  };
  render();

  btn.addEventListener("click", () => {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch {
      /* 持久化失败不影响本次会话的切换 */
    }
    applyTheme(mode);
    render();
  });
}
