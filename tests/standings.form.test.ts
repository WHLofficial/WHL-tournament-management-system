// 积分榜末列「近 5 场」：worker/lib/standings.ts 的 readTournamentForm 与 readStageStandings 挂载。
// 钉六件事：
//   1) 统计范围 = 本赛事全部已完赛场次，跨阶段合并（小组赛 + 循环赛 + 淘汰赛），只留最近 5 场
//   2) 取最近 5 场按轮次倒序，下发时反转成正序：左边最早、最近一场在最右
//   3) 未开打、轮空（note）、对手位为空的场次都不计
//   4) 结果判定：胜/平/负；平分看点球决胜；双弃权双方记负
//   5) 不足 5 场按实际场次下发；一场未打的队不在 Map 里（展示层兜底成空数组）
//   6) 小组赛与循环赛的榜行都挂 form（淘汰赛没有积分榜，不涉及）
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, createTestD1 } from "./d1";
import { readStageStandings, readTournamentForm } from "../worker/lib/standings";

// 赛事 20「联赛」：小组赛(sort 1) + 排名赛循环(sort 2) + 淘汰赛(sort 3) ⇒ 钉跨阶段合并与「只留最近 5 场」
// 赛事 21「杯赛」：小组赛(sort 1) + 淘汰赛(sort 2) ⇒ 钉排除条件、点球、双弃权，并跑一次 readStageStandings
function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  sqlite
    .prepare(
      "INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(1, "管理员", "", "x", "admin", 0, 0);

  const iso = "2026-01-01T00:00:00Z";
  for (const [id, name] of [[10, "甲队"], [11, "乙队"], [12, "丙队"], [13, "丁队"]] as const) {
    sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (?, 1, ?, ?)").run(id, name, iso);
  }
  for (const [id, name, format] of [
    [20, "联赛", "round_robin"],
    [21, "杯赛", "group_knockout"],
  ] as const) {
    sqlite
      .prepare(
        "INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (?, 1, ?, ?, 'running', 1, ?)"
      )
      .run(id, name, format, iso);
  }
  for (const [id, tid, kind, sort, name] of [
    [200, 20, "group", 1, "小组赛"],
    [201, 20, "round_robin", 2, "排名赛"],
    [202, 20, "elim", 3, "淘汰赛"],
    [210, 21, "group", 1, "小组赛"],
    [211, 21, "elim", 2, "淘汰赛"],
  ] as const) {
    sqlite
      .prepare("INSERT INTO stage (id, tournament_id, kind, sort_order, name) VALUES (?, ?, ?, ?, ?)")
      .run(id, tid, kind, sort, name);
  }
  for (const [id, tid, team, seed] of [
    [400, 20, 10, 1], [401, 20, 11, 2], [402, 20, 12, 3], [403, 20, 13, 4],
    [410, 21, 10, 1], [411, 21, 11, 2], [412, 21, 12, 3], [413, 21, 13, 4],
  ] as const) {
    sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (?, ?, ?, ?)").run(id, tid, team, seed);
  }

  type MatchOpts = {
    pen?: [number, number];
    walkover?: string;
    note?: string;
    pending?: boolean;
    finishedAt?: string;
  };
  const m = (
    id: number,
    stage: number,
    round: number,
    slot: number,
    home: number | null,
    away: number | null,
    sh: number | null,
    sa: number | null,
    opts: MatchOpts = {}
  ) =>
    sqlite
      .prepare(
        `INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id,
           score_home, score_away, pen_home, pen_away, walkover_side, status, note, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id, stage, round, slot, home, away, sh, sa,
        opts.pen?.[0] ?? null, opts.pen?.[1] ?? null,
        opts.walkover ?? "", opts.pending ? "pending" : "finished", opts.note ?? null,
        opts.finishedAt ?? null
      );

  // 甲队(entry 400) 视角的六场，按轮次从旧到新：
  //   小组赛 r1s1 胜 5:0（第 6 老，应被丢掉）→ 小组赛 r1s2 客负 → 小组赛 r2s1 平
  //   → 排名赛 r1s1 客胜 → 排名赛 r2s1 平后点球胜 → 淘汰赛 r1s1 负
  m(500, 200, 1, 1, 400, 402, 5, 0, { finishedAt: "2026-02-01T10:00:00Z" });
  m(501, 200, 1, 2, 401, 400, 1, 0, { finishedAt: "2026-06-01T10:00:00Z" });
  m(502, 200, 2, 1, 400, 403, 2, 2, { finishedAt: "2026-03-01T10:00:00Z" });
  m(503, 201, 1, 1, 402, 400, 0, 1);
  m(504, 201, 2, 1, 400, 401, 3, 3, { pen: [5, 4] });
  m(505, 202, 1, 1, 400, 403, 1, 2);

  // 杯赛：正常场 + 双弃权 + 未开打 + 轮空 + 对手位为空 + 点球分胜负
  m(520, 210, 1, 1, 410, 411, 2, 1);
  m(521, 210, 2, 1, 410, 412, 0, 0, { walkover: "both" });
  m(522, 210, 3, 1, 410, 411, null, null, { pending: true });
  m(523, 210, 3, 2, 410, 411, 3, 0, { note: "轮空" });
  m(524, 210, 3, 3, 410, null, 3, 0);
  m(525, 211, 1, 1, 410, 411, 1, 1, { pen: [3, 5] });

  // 小组赛榜行（readStageStandings 只读 standing 表，榜单本身怎么算的与本文件无关）
  for (const [entry, played, won, drawn, lost, pts, gf, ga] of [
    [410, 3, 1, 1, 1, 4, 3, 1],
    [411, 2, 0, 0, 2, 0, 1, 6],
    [412, 1, 0, 0, 1, 0, 0, 2],
    [413, 0, 0, 0, 0, 0, 0, 0],
  ] as const) {
    sqlite
      .prepare(
        `INSERT INTO standing (stage_id, group_id, entry_id, played, won, drawn, lost, pts, gf, ga, pen_won, pen_lost)
         VALUES (210, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`
      )
      .run(entry, played, won, drawn, lost, pts, gf, ga);
  }

  return { db: createTestD1(sqlite) };
}

describe("积分榜近 5 场取数", () => {
  it("跨阶段合并、按轮次取最近 5 场、正序下发，且顺序键是轮次不是完赛时间", async () => {
    const { db } = freshEnv();
    const form = await readTournamentForm(db, 20);
    // 丢掉的是轮次最靠前的 5:0（虽然它的完赛时间比 r1s2 那场更早、updated_at 也早）
    expect(form.get(400)).toEqual(["L", "D", "W", "W", "L"]);
    // 只有两场就下发两场；淘汰赛的场次也算进队 400 的序列
    expect(form.get(402)).toEqual(["L", "L"]);
    expect(form.get(403)).toEqual(["D", "W"]);
  });

  it("未开打、轮空、对手位为空的场次不计；点球分胜负；双弃权双方记负", async () => {
    const { db } = freshEnv();
    const form = await readTournamentForm(db, 21);
    expect(form.get(410)).toEqual(["W", "L", "L"]);
    expect(form.get(411)).toEqual(["L", "W"]);
    expect(form.get(412)).toEqual(["L"]);
    // 一场未完的队不进 Map（调用方 readStageStandings 兜底成空数组）
    expect(form.has(413)).toBe(false);
  });

  it("单赛事隔离：赛事 21 的场次不会漏进赛事 20 的状态里", async () => {
    const { db } = freshEnv();
    const form = await readTournamentForm(db, 20);
    expect(form.has(410)).toBe(false);
    expect(form.get(400)).toHaveLength(5);
  });
});

describe("近 5 场挂到积分榜行上", () => {
  it("小组赛榜行带 form，含没打过球的行（空数组）", async () => {
    const { db } = freshEnv();
    const boards = await readStageStandings(db, 21);
    // 淘汰赛阶段没有积分榜，只有小组赛一块榜
    expect(boards.map((b) => b.stageId)).toEqual([210]);
    const rows = boards[0].groups.flatMap((g) => g.rows);
    expect(rows.find((r) => r.entryId === 410)?.form).toEqual(["W", "L", "L"]);
    expect(rows.find((r) => r.entryId === 411)?.form).toEqual(["L", "W"]);
    expect(rows.find((r) => r.entryId === 413)?.form).toEqual([]);
  });
});
