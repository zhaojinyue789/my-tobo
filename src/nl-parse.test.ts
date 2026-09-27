import { describe, expect, it } from "vitest";
import { parseNaturalLanguage } from "./nl-parse";

const T = "2026-09-27"; // 周日

describe("parseNaturalLanguage（自然语言快速添加）", () => {
  it("明天 + 时刻 + 优先级，全部剥离后剩余为标题", () => {
    const r = parseNaturalLanguage("明天下午3点 开会 !高", T);
    expect(r.text).toBe("开会");
    expect(r.date).toBe("2026-09-28");
    expect(r.time).toBe("15:00");
    expect(r.priority).toBe("high");
  });

  it("每周二四 → 结构化 weekly + 下一个周二", () => {
    const r = parseNaturalLanguage("每周二四 背单词", T);
    expect(r.text).toBe("背单词");
    expect(r.recurrence).toEqual({ kind: "weekly", byDay: [2, 4] });
    // 2026-09-27 是周日，下周一 09-28 → 下一个周二 09-29
    expect(r.date).toBe("2026-09-29");
  });

  it("周X 指最近的未来（今天匹配算今天）", () => {
    expect(parseNaturalLanguage("周日 散步", T).date).toBe("2026-09-27");
    // 周三：从周日往后 3 天
    expect(parseNaturalLanguage("周三 交报告", T).date).toBe("2026-09-30");
  });

  it("下周X 基于下周一", () => {
    // 下周一 = 09-28，下周三 = 09-30
    expect(parseNaturalLanguage("下周三 体检", T).date).toBe("2026-09-30");
  });

  it("相对日：今天/明天/后天/大后天", () => {
    expect(parseNaturalLanguage("今天 买牛奶", T).date).toBe("2026-09-27");
    expect(parseNaturalLanguage("明天 买牛奶", T).date).toBe("2026-09-28");
    expect(parseNaturalLanguage("后天 买牛奶", T).date).toBe("2026-09-29");
    expect(parseNaturalLanguage("大后天 买牛奶", T).date).toBe("2026-09-30");
  });

  it("X月X日：今年未过用今年，已过用明年", () => {
    expect(parseNaturalLanguage("9月30日 交税", T).date).toBe("2026-09-30");
    expect(parseNaturalLanguage("1月1日 元旦", T).date).toBe("2027-01-01");
  });

  it("每天/每日 → daily，截止为今天", () => {
    const r2 = parseNaturalLanguage("每天 跑步", T);
    expect(r2.recurrence).toBe("daily");
    expect(r2.date).toBe("2026-09-27");
    expect(r2.text).toBe("跑步");
  });

  it("每月X号 → 当月/次月的该日 + monthly", () => {
    expect(parseNaturalLanguage("每月5号 交房租", T).date).toBe("2026-10-05");
    expect(parseNaturalLanguage("每月5号 交房租", T).recurrence).toBe("monthly");
  });

  it("时刻解析：X点半 / X点YY分 / HH:MM / 晚上8点", () => {
    // 裸「X点」按 24 小时制（滴答同款约定）；上/下午需显式修饰
    expect(parseNaturalLanguage("明天3点半 开会", T).time).toBe("03:30");
    expect(parseNaturalLanguage("明天下午3点半 开会", T).time).toBe("15:30");
    expect(parseNaturalLanguage("明天8点20分 上课", T).time).toBe("08:20");
    expect(parseNaturalLanguage("明天 14:30 复盘", T).time).toBe("14:30");
    expect(parseNaturalLanguage("明天晚上8点 看剧", T).time).toBe("20:00");
  });

  it("只有时刻没有日期 → 今天", () => {
    const r = parseNaturalLanguage("18:00 吃晚饭", T);
    expect(r.date).toBe("2026-09-27");
    expect(r.time).toBe("18:00");
  });

  it("无解析内容：文本原样保留", () => {
    const r = parseNaturalLanguage("买一张返程票", T);
    expect(r.text).toBe("买一张返程票");
    expect(r.date).toBeUndefined();
  });

  it("工作日 → 周一至周五", () => {
    const r = parseNaturalLanguage("工作日 站会", T);
    expect(r.recurrence).toEqual({ kind: "weekly", byDay: [1, 2, 3, 4, 5] });
  });
});
