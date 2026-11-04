import { describe, expect, it } from "vitest";
import {
  absHours,
  scheduleWindow,
  splitByDay,
  validatePlacement,
  type History,
} from "../worker/lib/kickoffScheduler";

const pool = (times: string[], cap = 1) => times.map((time) => ({ time, cap }));
const dayPool = (day: number, times: string[], cap = 1) => ({ [day]: pool(times, cap) });

describe("虚拟时间轴", () => {
  it("第 1 周周一 00:00 = 0，第 5 周周六 17:30 = 809.5h", () => {
    expect(absHours(1, 1, "00:00")).toBe(0);
    expect(absHours(5, 6, "17:30")).toBe(809.5);
    expect(absHours(5, 6, "17:30") - absHours(5, 5, "20:00")).toBe(21.5);
  });
});

describe("拆天", () => {
  const ms = (n: number) => Array.from({ length: n }, (_, i) => ({ slot: i + 1 }));

  it("6 场 → 3+3；4 场 → 2+2；2 场 → 1+1", () => {
    expect(splitByDay(ms(6), 6, 7).map((d) => d.matches.length)).toEqual([3, 3]);
    expect(splitByDay(ms(6), 5, 6).map((d) => d.matches.length)).toEqual([3, 3]);
    expect(splitByDay(ms(4), 2, 3).map((d) => d.matches.length)).toEqual([2, 2]);
    expect(splitByDay(ms(2), 2, 3).map((d) => d.matches.length)).toEqual([1, 1]);
  });

  it("窗口只有一天就全放 day_start", () => {
    const days = splitByDay(ms(1), 6, 6);
    expect(days).toHaveLength(1);
    expect(days[0].day).toBe(6);
    expect(days[0].matches).toHaveLength(1);
  });
});

describe("选档", () => {
  it("越疲劳越先拿，先拿的人拿最晚的档", () => {
    const history: History = new Map([
      [1, { lastStartHours: absHours(4, 4, "20:00"), lastWasHome: true }],
      [2, { lastStartHours: absHours(4, 4, "20:00"), lastWasHome: false }],
      [3, { lastStartHours: absHours(4, 1, "20:00"), lastWasHome: true }],
      [4, { lastStartHours: absHours(4, 1, "20:00"), lastWasHome: false }],
    ]);
    const { assignments, conflicts } = scheduleWindow({
      week: 5,
      dayStart: 6,
      dayEnd: 6,
      pool: dayPool(6, ["18:00", "20:00"]),
      matches: [
        { id: 11, slot: 1, homeTeamId: 1, awayTeamId: 2 },
        { id: 12, slot: 2, homeTeamId: 3, awayTeamId: 4 },
      ],
      history,
    });
    expect(conflicts).toEqual([]);
    expect(assignments.find((a) => a.matchId === 11)?.time).toBe("20:00");
    expect(assignments.find((a) => a.matchId === 12)?.time).toBe("18:00");
  });

  it("同一档位不能超过容量，满了就落早一档", () => {
    const { assignments, conflicts } = scheduleWindow({
      week: 8,
      dayStart: 2,
      dayEnd: 2,
      pool: {
        2: [
          { time: "18:30", cap: 2 },
          { time: "21:00", cap: 2 },
        ],
      },
      matches: [
        { id: 1, slot: 1, homeTeamId: 1, awayTeamId: 2 },
        { id: 2, slot: 2, homeTeamId: 3, awayTeamId: 4 },
        { id: 3, slot: 3, homeTeamId: 5, awayTeamId: 6 },
        { id: 4, slot: 4, homeTeamId: 7, awayTeamId: 8 },
      ],
      history: new Map(),
    });
    expect(conflicts).toEqual([]);
    expect(assignments.map((a) => a.time)).toEqual(["21:00", "21:00", "18:30", "18:30"]);
  });

  it("48–64h 之间：降到硬约束并记一条 soft", () => {
    const history: History = new Map([
      [1, { lastStartHours: absHours(5, 4, "06:00"), lastWasHome: false }],
      [2, { lastStartHours: absHours(5, 4, "06:00"), lastWasHome: false }],
    ]);
    const { assignments, conflicts } = scheduleWindow({
      week: 5,
      dayStart: 6,
      dayEnd: 6,
      pool: dayPool(6, ["18:00", "20:00"]),
      matches: [{ id: 1, slot: 1, homeTeamId: 1, awayTeamId: 2 }],
      history,
    });
    expect(assignments[0].time).toBe("20:00");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].level).toBe("soft");
    expect(conflicts[0].reason).toContain("62.0h");
  });

  it("两连主的队只用 48h 门槛", () => {
    const history: History = new Map([
      [1, { lastStartHours: absHours(5, 4, "06:00"), lastWasHome: true }],
      [2, { lastStartHours: absHours(5, 4, "06:00"), lastWasHome: false }],
    ]);
    const { conflicts } = scheduleWindow({
      week: 5,
      dayStart: 6,
      dayEnd: 6,
      pool: dayPool(6, ["20:00"]),
      matches: [{ id: 1, slot: 1, homeTeamId: 1, awayTeamId: 2 }],
      history,
    });
    // 客队不是两连主，62h 仍要记一条 soft
    expect(conflicts.filter((c) => c.level === "soft")).toHaveLength(1);
  });

  it("硬约束也满足不了：仍落档，但记 hard", () => {
    const history: History = new Map([
      [1, { lastStartHours: absHours(5, 5, "04:00"), lastWasHome: false }],
      [2, { lastStartHours: absHours(5, 5, "04:00"), lastWasHome: false }],
    ]);
    const { assignments, conflicts } = scheduleWindow({
      week: 5,
      dayStart: 6,
      dayEnd: 6,
      pool: dayPool(6, ["20:00"]),
      matches: [{ id: 1, slot: 1, homeTeamId: 1, awayTeamId: 2 }],
      history,
    });
    expect(assignments).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ level: "hard" });
    expect(conflicts[0].reason).toContain("40.0h");
  });
});

describe("排期体检", () => {
  const options = { week: 5, dayStart: 6, dayEnd: 6, pool: pool(["18:00", "20:00"]) };

  it("同队两场间隔不足 48h 报 hard", () => {
    const out = validatePlacement(
      [
        { id: 1, slot: 1, homeTeamId: 1, awayTeamId: 2, week: 5, day: 6, time: "18:00" },
        { id: 2, slot: 2, homeTeamId: 1, awayTeamId: 3, week: 5, day: 6, time: "20:00" },
      ],
      options
    );
    expect(out.some((v) => v.level === "hard" && v.reason.includes("2.0h"))).toBe(true);
  });

  it("时刻不在池子 / 不在窗口天数都报 hard", () => {
    const out = validatePlacement(
      [
        { id: 1, slot: 1, homeTeamId: null, awayTeamId: null, week: 5, day: 5, time: "12:00" },
      ],
      options
    );
    expect(out.filter((v) => v.level === "hard")).toHaveLength(2);
  });

  it("超容量报 hard", () => {
    const out = validatePlacement(
      [
        { id: 1, slot: 1, homeTeamId: 1, awayTeamId: 2, week: 5, day: 6, time: "18:00" },
        { id: 2, slot: 2, homeTeamId: 3, awayTeamId: 4, week: 5, day: 6, time: "18:00" },
      ],
      { ...options, pool: dayPool(6, ["18:00"]) }
    );
    expect(out.some((v) => v.reason.includes("超出容量 2/1"))).toBe(true);
  });
});
