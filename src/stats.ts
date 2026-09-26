import {
  dateOffset,
  isDeleted,
  isDueToday,
  isOverdue,
  timestampToISO,
  todayISO,
  type Todo,
} from "./todo";
import { categoryColor } from "./ui";
import { setupModal } from "./modal";

export interface StatsSummary {
  total: number;
  active: number;
  completed: number;
  overdue: number;
  dueToday: number;
  /** 近 7 天每日完成数（含今天，index 6 = 今天） */
  days: { date: string; count: number }[];
  /** 分类分布：[分类名或"__uncat__", 数量]，按数量降序 */
  categories: [string, number][];
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
  for (const t of live) {
    if (!t.completed || t.completedAt == null) continue;
    const bucket = byDate.get(timestampToISO(t.completedAt));
    if (bucket) bucket.count++;
  }

  const catMap = new Map<string, number>();
  for (const t of live) {
    const key = t.category ?? "__uncat__";
    catMap.set(key, (catMap.get(key) ?? 0) + 1);
  }
  const categories = [...catMap.entries()].sort((a, b) => b[1] - a[1]);

  return {
    total: live.length,
    active: live.length - completed,
    completed,
    overdue,
    dueToday,
    days,
    categories,
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

  // 分类分布
  const dist = document.createElement("section");
  dist.className = "stats-section";
  const distTitle = document.createElement("h3");
  distTitle.className = "stats-title";
  distTitle.textContent = "分类分布";
  dist.append(distTitle);
  if (s.categories.length === 0) {
    const empty = document.createElement("p");
    empty.className = "stats-empty";
    empty.textContent = "还没有待办";
    dist.append(empty);
  } else {
    const total = s.categories.reduce((sum, [, n]) => sum + n, 0);
    const rows = document.createElement("div");
    rows.className = "stats-dist";
    for (const [name, count] of s.categories) {
      const row = document.createElement("div");
      row.className = "stats-dist-row";
      const label = document.createElement("span");
      label.className = "stats-dist-label";
      label.textContent = name === "__uncat__" ? "未分类" : name;
      const track = document.createElement("span");
      track.className = "stats-dist-track";
      const fill = document.createElement("span");
      fill.className = "stats-dist-fill";
      fill.style.width = `${Math.round((count / total) * 100)}%`;
      if (name !== "__uncat__") fill.style.background = categoryColor(name);
      const num = document.createElement("span");
      num.className = "stats-dist-num";
      num.textContent = String(count);
      track.append(fill);
      row.append(label, track, num);
      rows.append(row);
    }
    dist.append(rows);
  }
  body.append(dist);
}
