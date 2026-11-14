// 开球时刻排期器 P3-A：赛历标签映射、时刻池、SQL 生成、插件赛程回填、约束回放。
// 这些是「一条数据录两遍」的收口处，映射错一格就会把时刻写到别的队身上，所以逐条钉死。

import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, sqlAll, sqlGet } from "./d1";
import {
  buildCalendarSql,
  buildBackfillSql,
  kickoffHours,
  mapCalendarCsv,
  mapLabel,
  normTeam,
  parseFixtureCsv,
  phaseForWeek,
  planBackfill,
  replayConstraints,
  timePool,
  tournamentName,
  type DbMatchRow,
} from "../worker/lib/kickoffCalendar";

describe("phaseForWeek", () => {
  it("按赛季语义切段", () => {
    expect(phaseForWeek(1)).toBe("summer");
    expect(phaseForWeek(7)).toBe("summer");
    expect(phaseForWeek(8)).toBe("autumn");
    expect(phaseForWeek(12)).toBe("autumn");
    expect(phaseForWeek(13)).toBe("winter");
    expect(phaseForWeek(18)).toBe("winter");
    expect(phaseForWeek(19)).toBe("spring");
    expect(phaseForWeek(23)).toBe("spring");
    expect(phaseForWeek(24)).toBe("summer");
    expect(phaseForWeek(31)).toBe("summer");
    expect(() => phaseForWeek(32)).toThrow();
  });
});

describe("mapLabel", () => {
  it("联赛轮次按赛事分派", () => {
    expect(mapLabel("顶级联赛9")).toEqual({ kind: "window", competition: "top", stream: "league", round: 9, leg: null });
    expect(mapLabel("次级联赛14")).toEqual({ kind: "window", competition: "sub", stream: "league", round: 14, leg: null });
  });

  it("次级 15–20 是冲刺组/挑战组的 6 轮", () => {
    expect(mapLabel("次级联赛15")).toEqual({ kind: "window", competition: "sub", stream: "playoff", round: 1, leg: null });
    expect(mapLabel("次级联赛20")).toEqual({ kind: "window", competition: "sub", stream: "playoff", round: 6, leg: null });
    expect(mapLabel("次级联赛21").kind).toBe("error");
  });

  it("附加赛用 round 0，两回合各自成窗", () => {
    expect(mapLabel("次级附加赛首回合")).toEqual({ kind: "window", competition: "sub", stream: "playoff", round: 0, leg: 1 });
    expect(mapLabel("次级附加赛次回合")).toEqual({ kind: "window", competition: "sub", stream: "playoff", round: 0, leg: 2 });
  });

  it("冠军杯小组赛与淘汰赛轮次互不干扰", () => {
    expect(mapLabel("冠军杯小组赛3")).toEqual({ kind: "window", competition: "cup", stream: "group", round: 3, leg: null });
    expect(mapLabel("冠军杯1/4赛首回合")).toEqual({ kind: "window", competition: "cup", stream: "elim", round: 1, leg: 1 });
    expect(mapLabel("冠军杯1/4赛次回合")).toEqual({ kind: "window", competition: "cup", stream: "elim", round: 1, leg: 2 });
    expect(mapLabel("冠军杯半决赛次回合")).toEqual({ kind: "window", competition: "cup", stream: "elim", round: 2, leg: 2 });
    expect(mapLabel("冠军杯决赛")).toEqual({ kind: "window", competition: "cup", stream: "elim", round: 3, leg: null });
  });

  it("超级杯与转会窗跳过，怪标签报错", () => {
    expect(mapLabel("超级杯").kind).toBe("skip");
    expect(mapLabel("季前转会窗").kind).toBe("skip");
    expect(mapLabel("友谊赛").kind).toBe("error");
    expect(mapLabel("").kind).toBe("error");
  });
});

const SAMPLE_CALENDAR = `season,week,day_start,day_end,label,category
S9,3,6,6,超级杯,杯赛
S9,5,6,7,顶级联赛1,顶级联赛
S9,5,5,6,次级联赛1,次级联赛
S9,12,2,3,冠军杯小组赛3,冠军杯
S9,30,2,3,次级附加赛首回合,次级联赛
S9,30,6,7,次级附加赛次回合,次级联赛
S9,31,6,6,冠军杯决赛,冠军杯
`;

describe("mapCalendarCsv", () => {
  it("解析窗口、跳过超级杯、算出周数", () => {
    const m = mapCalendarCsv(SAMPLE_CALENDAR);
    expect(m.season).toBe("S9");
    expect(m.weeks).toBe(31);
    expect(m.errors).toEqual([]);
    expect(m.skipped.map((s) => s.label)).toEqual(["超级杯"]);
    expect(m.windows).toHaveLength(6);
    const final = m.windows.find((w) => w.label === "冠军杯决赛");
    expect(final).toMatchObject({ competition: "cup", stream: "elim", round: 3, leg: null, week: 31, dayStart: 6, dayEnd: 6 });
  });

  it("赛季不一致与窗口重复都报错", () => {
    const bad = `season,week,day_start,day_end,label,category
S9,5,6,7,顶级联赛1,顶级联赛
S8,6,6,7,顶级联赛2,顶级联赛
S9,7,6,7,顶级联赛1,顶级联赛
`;
    const m = mapCalendarCsv(bad);
    expect(m.errors.some((e) => e.includes("不一致"))).toBe(true);
    expect(m.errors.some((e) => e.includes("窗口重复"))).toBe(true);
  });
});

describe("timePool", () => {
  it("春季回落秋季池，冬季独立（周末下午场，三档各容两场）", () => {
    expect(timePool("spring", "top")).toEqual(timePool("autumn", "top"));
    expect(timePool("spring", "sub")).toEqual(timePool("autumn", "sub"));
    expect(timePool("winter", "top")[6]!.map((s) => s.time)).toEqual(["12:30", "14:30", "16:30"]);
    expect(timePool("winter", "top")[6]!.every((s) => s.cap === 2)).toBe(true);
    expect(timePool("winter", "top")[7]!.map((s) => s.time)).toEqual(["12:30", "14:30", "16:30"]);
    expect(timePool("winter", "sub")[7]!.map((s) => s.time)).toEqual(["14:00", "16:00"]);
    expect(timePool("winter", "cup")).toEqual(timePool("autumn", "cup"));
  });

  it("杯赛按容量给批次，联赛默认每档 1 场、实测同刻开球的档位容 2 场", () => {
    const cup = timePool("autumn", "cup")[2];
    expect(cup).toEqual([
      { time: "18:30", cap: 3 },
      { time: "21:00", cap: 2 },
    ]);
    const top = timePool("autumn", "top")[6];
    expect(top.every((s) => s.cap === 1)).toBe(true);
    const summerSunday = timePool("summer", "top")[7];
    expect(summerSunday.every((s) => s.cap === 2)).toBe(true);
  });
});

describe("buildCalendarSql", () => {
  it("能跑通、可重复执行、杯赛第三轮带窗口覆盖", () => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(sqlite);
    sqlite.prepare("INSERT INTO user (id, name, password_hash) VALUES (1, 'admin', 'x')").run();
    const t = sqlite.prepare(
      "INSERT INTO tournament (id, org_id, name, format, status, created_by) VALUES (?, 1, ?, 'round_robin', 'running', 1)",
    );
    t.run(11, tournamentName("S9", "top"));
    t.run(12, tournamentName("S9", "sub"));
    t.run(13, tournamentName("S9", "cup"));

    const sql = buildCalendarSql(mapCalendarCsv(SAMPLE_CALENDAR));
    sqlite.exec(sql);

    expect(sqlGet<{ weeks: number }>(sqlite, "SELECT weeks FROM season WHERE name = 'S9'")?.weeks).toBe(31);
    expect(sqlGet<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM season_week")?.n).toBe(31);
    expect(sqlGet<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM time_pool")?.n).toBe(36);
    expect(sqlGet<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM round_window")?.n).toBe(6);

    const cupR3 = sqlGet<{ week: number; day_start: number; slot_override: string | null }>(
      sqlite,
      "SELECT week, day_start, slot_override FROM round_window WHERE tournament_id = 13 AND stream = 'group' AND round = 3",
    );
    expect(cupR3?.week).toBe(12);
    // 小组赛第 3 轮窗口是两天，历史 10 场全压在第二天 21:00
    expect(JSON.parse(cupR3?.slot_override ?? "null")).toEqual({
      day: 3,
      slots: [{ time: "21:00", cap: 10 }],
    });

    const playoffLegs = sqlAll<{ leg: number }>(
      sqlite,
      "SELECT leg FROM round_window WHERE tournament_id = 12 AND stream = 'playoff' AND round = 0 ORDER BY leg",
    );
    expect(playoffLegs.map((r) => r.leg)).toEqual([1, 2]);

    // 重跑不该插重：唯一索引 + upsert
    sqlite.exec(sql);
    expect(sqlGet<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM round_window")?.n).toBe(6);
  });

  it("有映射错误时拒绝生成 SQL", () => {
    const bad = `season,week,day_start,day_end,label,category
S9,5,6,7,友谊赛,其他
`;
    expect(() => buildCalendarSql(mapCalendarCsv(bad))).toThrow();
  });
});

describe("parseFixtureCsv / normTeam", () => {
  it("读六列并校验时间", () => {
    const csv = `轮次,主队,客队,周,天,时间
顶级联赛1,皇家贝蒂斯,巴塞罗那,5,6,17:30
顶级联赛1,曼城,AC米兰,5,6,25:00
`;
    const { rows, errors } = parseFixtureCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "顶级联赛1", week: 5, day: 6, time: "17:30" });
    expect(errors[0]).toContain("时间非法");
  });

  it("队名去掉 CPU 标记", () => {
    expect(normTeam("AC米兰(CPU)")).toBe("AC米兰");
    expect(normTeam("曼城（CPU）")).toBe("曼城");
    expect(normTeam("  曼城  ")).toBe("曼城");
  });
});

describe("planBackfill", () => {
  const dbRows: DbMatchRow[] = [
    { id: 1, tournament_name: "S9 | 顶级联赛", stage_id: 10, stage_sort: 1, stage_kind: "round_robin", round: 1, leg: null, home_name: "皇家贝蒂斯", away_name: "巴塞罗那" },
    { id: 2, tournament_name: "S9 | 顶级联赛", stage_id: 10, stage_sort: 1, stage_kind: "round_robin", round: 1, leg: null, home_name: "曼城(CPU)", away_name: "AC米兰" },
    { id: 3, tournament_name: "S9 | 次级联赛", stage_id: 20, stage_sort: 1, stage_kind: "round_robin", round: 1, leg: null, home_name: "甲队", away_name: "乙队" },
    { id: 4, tournament_name: "S9 | 次级联赛", stage_id: 21, stage_sort: 2, stage_kind: "round_robin", round: 1, leg: null, home_name: "丙队", away_name: "丁队" },
    { id: 5, tournament_name: "S9 | 冠军杯", stage_id: 30, stage_sort: 1, stage_kind: "group", round: 1, leg: null, home_name: "戊队", away_name: "己队" },
  ];

  function fixtures(...lines: string[]) {
    return parseFixtureCsv(`轮次,主队,客队,周,天,时间\n${lines.join("\n")}`).rows;
  }

  it("命中主阶段、归一队名、跳过与主客反都分开报", () => {
    const plan = planBackfill(
      fixtures(
        "顶级联赛1,皇家贝蒂斯,巴塞罗那,5,6,17:30",
        "顶级联赛1,曼城,AC米兰,5,6,19:30",
        "次级联赛1,甲队,乙队,5,5,19:30",
        "次级联赛1,丙队,丁队,5,5,20:00",
        "顶级联赛1,巴塞罗那,皇家贝蒂斯,6,6,18:00",
        "超级杯,甲队,乙队,3,6,20:00",
      ),
      dbRows,
    );
    expect(plan.updates.map((u) => u.matchId)).toEqual([1, 2, 3]);
    const reasons = plan.unmatched.map((u) => u.reason);
    // 丙/丁 在挑战组（stage 21），而 次级联赛1 只该对主阶段 stage 20
    expect(reasons.some((r) => r.includes("没有对得上的场次"))).toBe(true);
    expect(reasons.some((r) => r.includes("主客反了"))).toBe(true);
    expect(reasons.some((r) => r.includes("tour 不建超级杯"))).toBe(true);
  });

  it("同一场被匹配两次直接抛错", () => {
    // parseFixtureCsv 已按「轮次+主客」去重，这里是二道防线：手工构造两行同场
    expect(() =>
      planBackfill(
        [
          { label: "顶级联赛1", home: "皇家贝蒂斯", away: "巴塞罗那", week: 5, day: 6, time: "17:30" },
          { label: "顶级联赛1", home: "皇家贝蒂斯", away: "巴塞罗那", week: 6, day: 6, time: "18:00" },
        ],
        dbRows,
      ),
    ).toThrow(/同一场被匹配两次/);
  });

  it("生成定点 UPDATE", () => {
    const plan = planBackfill(fixtures("顶级联赛1,皇家贝蒂斯,巴塞罗那,5,6,17:30"), dbRows);
    expect(buildBackfillSql(plan)).toBe(
      "UPDATE match SET kickoff_week = 5, kickoff_day = 6, kickoff_time = '17:30' WHERE id = 1;",
    );
  });
});

describe("replayConstraints", () => {
  it("虚拟轴上日 1 = 周一，间隔按开球到开球算", () => {
    // W5 D6 17:30 与 W6 D6 17:30 相隔 7 天
    expect(kickoffHours(6, 6, "17:30") - kickoffHours(5, 6, "17:30")).toBe(168);
    expect(kickoffHours(1, 1, "00:00")).toBe(0);
  });

  it("同队间隔不足 48h 会被抓出来", () => {
    const replay = replayConstraints([
      { matchId: 1, home: "甲队", away: "乙队", week: 5, day: 6, time: "17:30" },
      { matchId: 2, home: "丙队", away: "甲队", week: 5, day: 7, time: "18:00" },
    ]);
    expect(replay.under48).toHaveLength(1);
    expect(replay.under48[0]).toMatchObject({ team: "甲队", firstMatchId: 1, secondMatchId: 2, gapHours: 24.5 });
    expect(replay.minGapHours).toBe(24.5);
  });

  it("正常一周一场不报", () => {
    const replay = replayConstraints([
      { matchId: 1, home: "甲队", away: "乙队", week: 5, day: 6, time: "17:30" },
      { matchId: 2, home: "甲队", away: "丙队", week: 6, day: 6, time: "17:30" },
    ]);
    expect(replay.under48).toEqual([]);
    expect(replay.minGapHours).toBe(168);
    expect(replay.under72).toBe(0);
  });
});
