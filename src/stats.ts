import {
  dateOffset,
  isDeleted,
  isDueToday,
  isOverdue,
  timestampToISO,
  todayISO,
  type Todo,
} from "./todo";
import { setupModal } from "./modal";

export interface StatsSummary {
  total: number;
  active: number;
  completed: number;
  overdue: number;
  dueToday: number;
  /** 连续完成天数：今天（或昨天）起每天都有完成任务 */
  streak: number;
  /** 近 7 天每日完成数（含今天，index 6 = 今天） */
  days: { date: string; count: number }[];
}

/** 统计口径：墓碑（回收站条目）一律不计入；today 可注入便于测试 */
export function computeStats(todos: Todo[], today: string = todayISO()): StatsSummary {
  const live = todos.filter((t) => !isDeleted(t));
  const completed = live.filter((t) => t.completed).length;
  const overdue = live.filter((t) => isOverdue(t)).length;
  const dueToday = live.filter((t) => isDueToday(t, today)).length;

  const days: { date: string; count: number }[] = [];
  const byDate = new Map<string, { date: string; count: number }>();
  for (let i = 6; i >= 0; i--) {
    const date = dateOffset(today, -i);
    const bucket = { date, count: 0 };
    days.push(bucket);
    byDate.set(date, bucket);
  }
  const completionDates = new Set<string>();
  for (const t of live) {
    if (!t.completed || t.completedAt == null) continue;
    const date = timestampToISO(t.completedAt);
    completionDates.add(date);
    const bucket = byDate.get(date);
    if (bucket) bucket.count++;
  }

  // 连续完成天数：今天有完成从今天数，否则从昨天数（今天还没动手不打断连击）
  let streak = 0;
  let cursor = completionDates.has(today) ? today : dateOffset(today, -1);
  while (completionDates.has(cursor)) {
    streak++;
    cursor = dateOffset(cursor, -1);
  }

  return {
    total: live.length,
    active: live.length - completed,
    completed,
    overdue,
    dueToday,
    streak,
    days,
  };
}

export interface StatsRefs {
  toggleBtn: HTMLButtonElement;
  modal: HTMLElement;
  closeBtn: HTMLButtonElement;
  body: HTMLElement;
}

/** 统计面板：每次打开按当前数据重建（打开期间数据变化在下次打开时体现） */
export function setupStats(refs: StatsRefs, getTodos: () => Todo[]): void {
  const { toggleBtn, modal, closeBtn, body } = refs;
  const handle = setupModal(modal);

  toggleBtn.addEventListener("click", () => {
    renderStats(body, computeStats(getTodos()));
    handle.open();
  });
  closeBtn.addEventListener("click", handle.close);
}

function renderStats(body: HTMLElement, s: StatsSummary): void {
  body.replaceChildren();

  // 概览卡片
  const grid = document.createElement("div");
  grid.className = "stats-grid";
  const card = (label: string, value: number, cls = ""): HTMLElement => {
    const el = document.createElement("div");
    el.className = "stat-card " + cls;
    const num = document.createElement("span");
    num.className = "stat-num";
    num.textContent = String(value);
    const lab = document.createElement("span");
    lab.className = "stat-label";
    lab.textContent = label;
    el.append(num, lab);
    return el;
  };
  grid.append(
    card("总计", s.total),
    card("未完成", s.active),
    card("已完成", s.completed),
    card("已过期", s.overdue, s.overdue > 0 ? "is-warn" : ""),
    card("今天到期", s.dueToday),
  );
  body.append(grid);

  // 连续完成徽章（有连击才显示）
  if (s.streak > 0) {
    const badge = document.createElement("div");
    badge.className = "stats-streak";
    badge.textContent = `🔥 连续完成 ${s.streak} 天`;
    body.append(badge);
  }

  // 近 7 天完成趋势
  const trend = document.createElement("section");
  trend.className = "stats-section";
  const trendTitle = document.createElement("h3");
  trendTitle.className = "stats-title";
  trendTitle.textContent = "近 7 天完成";
  const max = Math.max(1, ...s.days.map((d) => d.count));
  const bars = document.createElement("div");
  bars.className = "stats-trend";
  for (const d of s.days) {
    const col = document.createElement("div");
    col.className = "stats-trend-col";
    const bar = document.createElement("div");
    bar.className = "stats-trend-bar";
    bar.style.height = `${Math.round((d.count / max) * 64) + 4}px`;
    bar.title = `${d.date} 完成 ${d.count} 项`;
    if (d.count > 0) bar.classList.add("has-data");
    const lab = document.createElement("span");
    lab.className = "stats-trend-label";
    lab.textContent = d.date.slice(5); // MM-DD
    col.append(bar, lab);
    bars.append(col);
  }
  trend.append(trendTitle, bars);
  body.append(trend);
}
