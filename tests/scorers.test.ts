// 射手榜并列口径在叙事侧的对齐：赛前榜（scorersBefore）与榜单同规则——同球数点球少的排前。
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, createTestD1 } from "./d1";
import { fetchScorerTotals, scorersBefore, rankOf, type ScorerTotal } from "../worker/lib/context";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const iso = "2026-01-01T00:00:00Z";
  sqlite.prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (1, '管理员', '', 'x', 'admin', 0, 0)").run();
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (10, 1, '红队', ?)").run(iso);
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (11, 1, '蓝队', ?)").run(iso);
  sqlite.prepare("INSERT INTO player (id, team_id, name) VALUES (100, 10, '安七')").run();
  sqlite.prepare("INSERT INTO player (id, team_id, name) VALUES (101, 11, '赵六')").run();
  sqlite.prepare("INSERT INTO player (id, team_id, name) VALUES (102, 10, '王五')").run();
  sqlite
    .prepare("INSERT INTO tournament (id, org_id, name, format, status, created_by) VALUES (7, 1, '联赛', 'round_robin', 'running', 1)")
    .run();
  sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (70, 7, 'round_robin', 1)").run();
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (500, 7, 10, 1)").run();
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (501, 7, 11, 2)").run();
  sqlite
    .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, score_home, score_away, status, finished_at) VALUES (800, 70, 1, 1, 500, 501, 4, 3, 'finished', ?)")
    .run(iso);
  const ev = (id: number, entryId: number, playerId: number, type: string) =>
    sqlite
      .prepare("INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, created_by) VALUES (?, 800, ?, ?, ?, 10, 1)")
      .run(id, entryId, playerId, type);
  // 安七：运动战 2 + 点球 1 = 3；赵六：3 球全是点球；王五：1 个运动战进球
  ev(900, 500, 100, "goal");
  ev(901, 500, 100, "goal");
  ev(902, 500, 100, "pen_goal");
  ev(903, 501, 101, "pen_goal");
  ev(904, 501, 101, "pen_goal");
  ev(905, 501, 101, "pen_goal");
  ev(906, 500, 102, "goal");
  return sqlite;
}

describe("射手榜并列口径（叙事侧对齐）", () => {
  it("fetchScorerTotals：采集点球数，同球数点球少的排前", async () => {
    const db = createTestD1(freshDb());
    const totals = await fetchScorerTotals(db, 7);
    expect(totals.every((t) => Number.isInteger(t.penGoals))).toBe(true);
    expect(totals.map((t) => [t.name, t.goals, t.penGoals])).toEqual([
      ["安七", 3, 1],
      ["赵六", 3, 3],
      ["王五", 1, 0],
    ]);
  });

  it("scorersBefore：扣掉本场进球后仍并列时，点球少的在前（不再退回姓名序）", () => {
    const totals: ScorerTotal[] = [
      { playerId: 100, name: "张三", teamName: "红队", goals: 4, penGoals: 1 },
      { playerId: 101, name: "阿李", teamName: "蓝队", goals: 4, penGoals: 3 },
    ];
    // 本场两人各进一个运动战球 → 赛前同为 3 球；姓名序会把「阿李」排前，对齐后应是点球少的「张三」
    const before = scorersBefore(totals, [
      { playerId: 100, pen: false },
      { playerId: 101, pen: false },
    ]);
    expect(before.map((t) => [t.name, t.goals, t.penGoals])).toEqual([
      ["张三", 3, 1],
      ["阿李", 3, 3],
    ]);
    expect(rankOf(before, 100)).toBe(1);
    expect(rankOf(before, 101)).toBe(2);
  });

  it("scorersBefore：点球数一并扣减，扣到 0 球的球员移出赛前榜", () => {
    const totals: ScorerTotal[] = [
      { playerId: 100, name: "张三", teamName: "红队", goals: 3, penGoals: 1 },
      { playerId: 101, name: "李四", teamName: "蓝队", goals: 2, penGoals: 2 },
    ];
    const before = scorersBefore(totals, [
      { playerId: 100, pen: true },
      { playerId: 100, pen: false },
      { playerId: 101, pen: true },
      { playerId: 101, pen: true },
    ]);
    expect(before.map((t) => [t.name, t.goals, t.penGoals])).toEqual([["张三", 1, 0]]);
    expect(rankOf(before, 101)).toBe(0);
  });
});
