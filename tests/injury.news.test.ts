// 新闻层伤情：按轮伤情快讯条（injury）+ 周报伤情节（weekly.injuries 与正文尾巴）。
// 口径直连 buildFeed / buildWeekly：比赛必须落在「本周」窗口内，故完赛时刻取运行时刻。
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, createTestD1 } from "./d1";
import { buildFeed, buildRoundRecap, buildWeekly } from "../worker/lib/feedNews";

interface FixtureOpts {
  /** 挂伤病事件与登记；false 时整块不建（测无伤情） */
  injury?: boolean;
  /** 勾选为缺阵的场次：'finished' 只勾已完赛场、'both' 再加一场未开赛（制造「仍在伤停」） */
  miss?: "finished" | "both";
  /** 同一轮再给同一名球员记一次重伤事件（线上真出现过：一轮多场同一人两次受伤） */
  dup?: boolean;
}

// 单届联赛：红 3:1 蓝（刚刚完赛，落在本周）+ 同轮一场未开赛（供勾缺阵）
function freshDb(opts: FixtureOpts = {}) {
  const { injury = true, miss = "both" } = opts;
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const iso = "2026-01-01T00:00:00Z";
  const finishedAt = new Date().toISOString();

  sqlite.prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (1, '管理员', '', 'x', 'admin', 0, 0)").run();
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (10, 1, '红队', ?)").run(iso);
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (11, 1, '蓝队', ?)").run(iso);
  sqlite.prepare("INSERT INTO player (id, team_id, name) VALUES (100, 10, '张三')").run();
  sqlite
    .prepare("INSERT INTO tournament (id, org_id, name, format, status, created_by) VALUES (7, 1, '联赛', 'round_robin', 'running', 1)")
    .run();
  sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (70, 7, 'round_robin', 1)").run();
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (500, 7, 10, 1)").run();
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (501, 7, 11, 2)").run();
  sqlite
    .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, score_home, score_away, status, finished_at) VALUES (800, 70, 1, 1, 500, 501, 3, 1, 'finished', ?)")
    .run(finishedAt);
  sqlite
    .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status) VALUES (801, 70, 2, 1, 501, 500, 'pending')")
    .run();
  if (injury) {
    sqlite
      .prepare("INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, created_by) VALUES (900, 800, 500, 100, 'injury_minor', 30, 1)")
      .run();
    sqlite
      .prepare("INSERT INTO injury (id, team_id, player_id, event_id, injury_name, created_by, created_at) VALUES (950, 10, 100, 900, '轻微扭伤', 1, ?)")
      .run(finishedAt);
    sqlite.prepare("INSERT INTO injury_miss (injury_id, match_id) VALUES (950, 800)").run();
    if (miss === "both") sqlite.prepare("INSERT INTO injury_miss (injury_id, match_id) VALUES (950, 801)").run();
    if (opts.dup)
      sqlite
        .prepare("INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, created_by) VALUES (901, 800, 500, 100, 'injury_major', 70, 1)")
        .run();
  }
  return { db: createTestD1(sqlite), sqlite };
}

describe("伤情快讯与周报", () => {
  it("整轮完赛后出伤情条：按轮成条、正文逐名简列、带缺阵尾巴", async () => {
    const { db } = freshDb();
    const items = await buildFeed(db);
    const inj = items.find((i) => i.kind === "injury");
    expect(inj).toBeTruthy();
    expect(inj!.id).toBe("injury:70:1");
    expect(inj!.stageId).toBe(70);
    expect(inj!.round).toBe(1);
    expect(inj!.tournamentId).toBe(7);
    // 标题来自句库，均含轮次文案（联赛 第 1 轮）
    expect(inj!.title).toContain("联赛 第 1 轮");
    // 正文：谁（队 · 轻重 · 伤名）+ 仍缺阵人数尾巴
    expect(inj!.body).toContain("张三（红队 · 轻伤 · 轻微扭伤）");
    expect(inj!.body).toContain("另有 1 人仍在伤停");
    // 点击去综述页
    expect(inj!.at).toBeTruthy();
  });

  it("无人继续缺阵时尾巴改口径（不替登记下伤愈结论）", async () => {
    const { db } = freshDb({ miss: "finished" });
    const items = await buildFeed(db);
    const inj = items.find((i) => i.kind === "injury");
    expect(inj!.body).toContain("张三（红队 · 轻伤 · 轻微扭伤）");
    expect(inj!.body).toContain("无人继续缺阵");
  });

  it("同一轮同一人两次受伤只算一个人：标题人数、正文简列都不重复", async () => {
    const { db } = freshDb({ dup: true });
    const items = await buildFeed(db);
    const inj = items.find((i) => i.kind === "injury");
    expect(inj).toBeTruthy();
    expect(inj!.title).not.toContain("2 人");
    expect(inj!.title).toContain("1 人");
    // 留的是后一条事件（901 重伤），所以标题带重伤口径
    expect(inj!.title).toMatch(/重伤|伤得不轻|伤势较重|短期难回/);
    // 正文里张三只出现一次，且按后一条事件的轻重写
    expect(inj!.body.split("张三").length - 1).toBe(1);
    expect(inj!.body).toContain("张三（红队 · 重伤）");
    // 周报同理：同一周同一人也只算一条
    const wk = await buildWeekly(db);
    expect(wk.injuries).toHaveLength(1);
    expect(wk.injuries![0].severity).toBe("major");
  });

  it("轮次综述带本轮伤情：与快讯条同一份去重结果（点进去看得见）", async () => {
    const { db } = freshDb();
    const recap = await buildRoundRecap(db, 7, 70, 1);
    expect(recap.injuries).toHaveLength(1);
    expect(recap.injuries![0]).toMatchObject({
      playerId: 100,
      playerName: "张三",
      teamName: "红队",
      tournamentId: 7,
      severity: "minor",
      injuryName: "轻微扭伤",
      outMatches: 1,
    });
    // 同一人一轮两次受伤仍只列一条，轻重按后一次
    const dup = await buildRoundRecap(freshDb({ dup: true }).db, 7, 70, 1);
    expect(dup.injuries).toHaveLength(1);
    expect(dup.injuries![0].severity).toBe("major");
    // 本轮无人受伤则是空数组，页面据此不渲染
    const none = await buildRoundRecap(freshDb({ injury: false }).db, 7, 70, 1);
    expect(none.injuries ?? []).toHaveLength(0);
  });

  it("周报带伤情节：injuries 去重逐名 + 正文尾巴", async () => {
    const { db } = freshDb();
    const wk = await buildWeekly(db);
    expect(wk.injuries).toHaveLength(1);
    expect(wk.injuries![0]).toMatchObject({
      playerId: 100,
      playerName: "张三",
      teamName: "红队",
      tournamentId: 7,
      severity: "minor",
      injuryName: "轻微扭伤",
      outMatches: 1,
    });
    const items = await buildFeed(db);
    const weekly = items.find((i) => i.kind === "weekly");
    expect(weekly).toBeTruthy();
    expect(weekly!.body).toContain("1 人受伤，其中 1 人仍在伤停");
  });

  it("本周无人受伤：伤情条与周报伤情节都不出现", async () => {
    const { db } = freshDb({ injury: false });
    const items = await buildFeed(db);
    expect(items.some((i) => i.kind === "injury")).toBe(false);
    expect(items.find((i) => i.kind === "weekly")!.body).not.toContain("人受伤");
    const wk = await buildWeekly(db);
    expect(wk.injuries ?? []).toHaveLength(0);
  });
});
