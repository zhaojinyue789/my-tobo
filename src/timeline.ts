import { dateOffset, isDeleted, todayISO, type Todo } from "./todo";
import { PRIORITY_COLORS } from "./ui";

/**
 * 时间线视图：垂直议程——已过期组置顶，其后按日期分组（未来 14 天逐日，更远合并），
 * 每条任务带时刻徽标与左侧轨道圆点，近截止在上。
 */
export function renderTimeline(container: HTMLElement, todos: Todo[]): void {
  const today = todayISO();
  const live = todos.filter((t) => !isDeleted(t) && !t.completed);

  const withDue = live.filter((t) => t.dueDate).sort((a, b) => {
    const ka = `${a.dueDate}T${a.dueTime ?? "23:59"}`;
    const kb = `${b.dueDate}T${b.dueTime ?? "23:59"}`;
    return ka < kb ? -1 : 1;
  });
  const undated = live.filter((t) => !t.dueDate);

  const groups: { label: string; cls: string; items: Todo[] }[] = [];
  const overdue = withDue.filter((t) => (t.dueDate as string) < today);
  if (overdue.length > 0) groups.push({ label: "已过期", cls: "is-overdue", items: overdue });
  for (let i = 0; i < 14; i++) {
    const date = dateOffset(today, i);
    const items = withDue.filter((t) => t.dueDate === date);
    if (items.length === 0) continue;
    const [y, m, d] = date.split("-").map(Number);
    const wd = "日一二三四五六"[new Date(y, m - 1, d).getDay()];
    groups.push({
      label: i === 0 ? `今天 · ${m}/${d} 周${wd}` : i === 1 ? `明天 · ${m}/${d} 周${wd}` : `${m}/${d} 周${wd}`,
      cls: i === 0 ? "is-today" : "",
      items,
    });
  }
  const later = withDue.filter((t) => (t.dueDate as string) > dateOffset(today, 13));
  if (later.length > 0) groups.push({ label: "更远", cls: "", items: later });
  if (undated.length > 0) groups.push({ label: "无日期", cls: "is-muted", items: undated });

  const root = document.createElement("div");
  root.className = "timeline";

  if (groups.length === 0) {
    const empty = document.createElement("div");
    empty.className = "timeline-empty";
    empty.textContent = "没有未完成的待办";
    root.append(empty);
    container.replaceChildren(root);
    return;
  }

  for (const g of groups) {
    const section = document.createElement("section");
    section.className = `tl-group ${g.cls}`;

    const head = document.createElement("h3");
    head.className = "tl-group-head";
    head.textContent = g.label;
    section.append(head);

    for (const t of g.items) {
      const item = document.createElement("div");
      item.className = "tl-item";
      if (t.priority) item.style.setProperty("--tl-flag", PRIORITY_COLORS[t.priority]);

      const dot = document.createElement("span");
      dot.className = "tl-dot";
      if (t.priority) dot.style.background = PRIORITY_COLORS[t.priority];

      const time = document.createElement("span");
      time.className = "tl-time" + (t.dueTime ? "" : " is-allday");
      time.textContent = t.dueTime ?? "全天";

      const text = document.createElement("span");
      text.className = "tl-text";
      text.textContent = t.text;

      item.append(dot, time, text);
      section.append(item);
    }
    root.append(section);
  }

  container.replaceChildren(root);
}
