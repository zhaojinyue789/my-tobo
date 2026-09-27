import {
  dateOffset,
  todayISO,
  type Priority,
  type Recurrence,
} from "./todo";

/**
 * 中文自然语言快速添加解析（滴答/Todoist 式输入的轻量子集，纯正则无 AI）：
 *   明天下午3点 开会 !高        → 标题「开会」+ 明天 15:00 + 高优先
 *   每周二四 背单词              → 标题「背单词」+ 下一个周二起 + 每周二、四
 * 解析出的片段从文本中剥离，剩余为标题。解析失败的部分原样保留，不做任何猜测提示。
 */
export interface NLResult {
  /** 剥离解析片段后的标题（可能为空，调用方回退原文本） */
  text: string;
  date?: string;
  time?: string;
  recurrence?: Recurrence;
  priority?: Priority;
}

const WEEKDAY_CHARS: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

/** 从「每周/周X」片段中提取周几集合（支持 二四 连写、二、四 分隔、数字 2,4） */
function parseWeekdayList(segment: string): number[] {
  const days = new Set<number>();
  for (const ch of segment) {
    if (ch in WEEKDAY_CHARS) days.add(WEEKDAY_CHARS[ch]);
    else if (/^[1-7]$/.test(ch)) days.add(Number(ch) % 7);
  }
  return [...days].sort((a, b) => a - b);
}

/** 下一个「周X」的日期：最近的未来（今天匹配算今天） */
function nextWeekday(today: string, weekday: number, forceNextWeek = false): string {
  const [y, m, d] = today.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  let delta = (weekday - dow + 7) % 7;
  if (delta === 0 && forceNextWeek) delta = 7;
  return dateOffset(today, delta);
}

/** 下周一（用于「下周X」：下周三 = 下周一 + 2） */
function nextMonday(today: string): { date: string; dow: number } {
  const [y, m, d] = today.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  const delta = ((8 - dow) % 7) || 7;
  return { date: dateOffset(today, delta), dow };
}

export function parseNaturalLanguage(rawInput: string, today: string = todayISO()): NLResult {
  const out: NLResult = { text: "" };
  let s = rawInput;

  const eat = (pattern: RegExp): RegExpMatchArray | null => {
    const m = s.match(pattern);
    if (m) s = s.replace(m[0], " ");
    return m;
  };

  // 1) 优先级：!高 / !中 / !低
  const pm = eat(/!\s*([高中低])/);
  if (pm) out.priority = pm[1] === "高" ? "high" : pm[1] === "中" ? "medium" : "low";

  // 3) 每月X号：日期 = 本月/下月 X 号 + monthly
  const mm = eat(/每月\s*(\d{1,2})\s*[号日]?/);
  if (mm) {
    const day = Math.min(Number(mm[1]), 31);
    const [y, m] = today.split("-").map(Number);
    const probe = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    out.date = probe >= today ? probe : dateOffset(probe, 31).slice(0, 8) + String(day).padStart(2, "0");
    out.recurrence = "monthly";
  }

  // 4) 每周X...（含多选周几）
  const wm = eat(/每周\s*([一二三四五六日天\d，,\s、]*)/);
  if (wm) {
    const days = parseWeekdayList(wm[1]);
    out.recurrence = days.length > 0 ? { kind: "weekly", byDay: days } : "weekly";
    // 截止日：下一个选中周几（规则未定具体日时用下一个今天）
    if (!out.date) {
      if (days.length > 0) {
        const nm = nextMonday(today);
        for (let i = 0; i < 7; i++) {
          const cand = dateOffset(nm.date, i);
          const [y, m, d] = cand.split("-").map(Number);
          if (days.includes(new Date(y, m - 1, d).getDay())) {
            out.date = cand;
            break;
          }
        }
      } else {
        out.date = today;
      }
    }
  }

  // 5) 工作日 / 每天
  if (eat(/工作日/)) {
    out.recurrence = { kind: "weekly", byDay: [1, 2, 3, 4, 5] };
    if (!out.date) out.date = nextWeekday(today, new Date().getDay(), false) || today;
    if (!out.date) out.date = today;
  }
  if (eat(/每天|每日/)) {
    out.recurrence = "daily";
    if (!out.date) out.date = today;
  }

  // 6) 大后天 / 后天 / 明天 / 今天
  if (eat(/大后天/)) out.date ??= dateOffset(today, 3);
  if (eat(/后天/)) out.date ??= dateOffset(today, 2);
  if (eat(/明天/)) out.date ??= dateOffset(today, 1);
  if (eat(/今天|今日/)) out.date ??= today;

  // 7) 下周X（下周一 = 下一个周一；周三 = 下周一 + 2）
  const nwm = eat(/下(周|星期|礼拜)\s*([一二三四五六日天])/);
  if (nwm) {
    const wd = WEEKDAY_CHARS[nwm[2]];
    const nm = nextMonday(today);
    const offset = wd === 0 ? 6 : wd - 1;
    out.date ??= dateOffset(nm.date, offset);
  }

  // 8) 周X / 星期X / 礼拜X（最近未来，今天匹配算今天）
  const wm2 = eat(/(周|星期|礼拜)\s*([一二三四五六日天])/);
  if (wm2) out.date ??= nextWeekday(today, WEEKDAY_CHARS[wm2[2]]);

  // 9) X月X日 / X月X号（本年内，已过则明年）
  const dm = eat(/(\d{1,2})月(\d{1,2})[号日]/);
  if (dm) {
    const [y] = today.split("-").map(Number);
    const mm2 = String(Number(dm[1])).padStart(2, "0");
    const dd = String(Number(dm[2])).padStart(2, "0");
    const probe = `${y}-${mm2}-${dd}`;
    out.date ??= probe >= today ? probe : `${Number(y) + 1}-${mm2}-${dd}`;
  }

  // 10) 完整 ISO 日期 YYYY-MM-DD
  const iso = eat(/\d{4}-\d{2}-\d{2}/);
  if (iso) out.date ??= iso[0];

  // 11) 时刻：HH:MM
  const hm = eat(/([01]?\d|2[0-3]):([0-5]\d)/);
  if (hm) out.time = `${hm[1].padStart(2, "0")}:${hm[2]}`;

  // 12) 时刻：X点半 / X点YY分 / X点（上午/中午/下午/晚上 修饰）
  const cm2 = eat(/(上午|早上|早晨|中午|下午|晚上|傍晚)?\s*(\d{1,2})\s*点\s*(半|([0-5]?\d)\s*分)?/);
  if (cm2) {
    let h = Number(cm2[2]);
    const period = cm2[1] ?? "";
    if ((period === "下午" || period === "晚上" || period === "傍晚") && h < 12) h += 12;
    if (period === "中午" && h === 12) h = 12;
    const minutes = cm2[3] === "半" ? "30" : cm2[4] ? String(Number(cm2[4])).padStart(2, "0") : "00";
    out.time = `${String(h).padStart(2, "0")}:${minutes}`;
  }

  // 收尾：时刻有值但无日期 → 今天；重复无日期 → 今天（daily/weekly 已设，兜底）
  if (out.time && !out.date) out.date = today;
  if (out.recurrence && !out.date) out.date = today;

  out.text = s.replace(/\s+/g, " ").trim();
  return out;
}
