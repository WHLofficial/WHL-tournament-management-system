// 射手榜口径：总进球含点球，同球数点球少的排前（buildToplists 直连断言）。
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, createTestD1 } from "./d1";
import { buildToplists } from "../worker/lib/topstats";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const iso = "2026-01-01T00:00:00Z";
  sqlite.prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (1, '管理员', '', 'x', 'admin', 0, 0)").run();
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (10, 1, '红队', ?)").run(iso);
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (11, 1, '蓝队', ?)").run(iso);
  sqlite.prepare("INSERT INTO player (id, team_id, name) VALUES (100, 10, '张三')").run();
  sqlite.prepare("INSERT INTO player (id, team_id, name) VALUES (101, 11, '李四')").run();
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
  // 张三：运动战 2 + 点球 1 = 3；李四：3 球全是点球；王五：1 个运动战进球
  ev(900, 500, 100, "goal");
  ev(901, 500, 100, "goal");
  ev(902, 500, 100, "pen_goal");
  ev(903, 501, 101, "pen_goal");
  ev(904, 501, 101, "pen_goal");
  ev(905, 501, 101, "pen_goal");
  ev(906, 500, 102, "goal");
  return createTestD1(sqlite);
}

describe("射手榜：点球口径", () => {
  it("count 含点球、penGoals 单独给出（字段形状也要对）", async () => {
    const lists = await buildToplists(freshDb(), 7);
    const byName = new Map(lists.scorers.map((r) => [r.playerName, r]));
    expect(byName.get("张三")).toMatchObject({ teamName: "红队", count: 3, penGoals: 1 });
    expect(byName.get("李四")).toMatchObject({ teamName: "蓝队", count: 3, penGoals: 3 });
    expect(byName.get("王五")).toMatchObject({ count: 1, penGoals: 0 });
    // 蛇形行转驼峰漏了就会静默 undefined——逐行断言字段形状
    expect(lists.scorers.every((r) => Number.isInteger(r.penGoals))).toBe(true);
  });

  it("同球数点球少的排前：3(1) 在 3(3) 之前，进球少的在最后", async () => {
    const lists = await buildToplists(freshDb(), 7);
    expect(lists.scorers.map((r) => [r.playerName, r.count, r.penGoals])).toEqual([
      ["张三", 3, 1],
      ["李四", 3, 3],
      ["王五", 1, 0],
    ]);
  });
});
