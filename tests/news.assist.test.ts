// 新闻层助攻口径：只给关键节点进球提助攻（首开纪录/扳平/反超），且助攻写在进球之前。
// 数据里几乎每个进球都记了助攻，逐个写太机械；口径直连 buildFeed（快讯/综述/周报同源）与 buildMatchReport（战报）。
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, createTestD1 } from "./d1";
import { buildFeed } from "../worker/lib/feedNews";
import { buildMatchReport } from "../worker/lib/report";

// 助攻句库是散的（送出助攻/送出妙传/贡献一记助攻…），断言按「助球员名 + 逗号 + 进球者名」的语序形状，不钉死某一句
const BEFORE = (assist: string, scorer: string) => new RegExp(`${assist}[^，]{0,8}，${scorer}`);

// 单届联赛：红 3:1 蓝，四球全带助攻——客队首开（关键）、主队扳平（关键）、主队反超（关键）、主队扩大（非关键）
function fourGoalDb() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const iso = "2026-01-01T00:00:00Z";
  const finishedAt = new Date().toISOString();

  sqlite.prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (1, '管理员', '', 'x', 'admin', 0, 0)").run();
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (10, 1, '红队', ?)").run(iso);
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (11, 1, '蓝队', ?)").run(iso);
  for (const [id, team, name] of [
    [100, 10, "红前锋"],
    [101, 10, "红中场"],
    [102, 10, "红边锋"],
    [103, 10, "红后卫甲"],
    [104, 10, "红后卫乙"],
    [200, 11, "蓝前锋"],
    [201, 11, "蓝中场"],
  ] as const) {
    sqlite.prepare("INSERT INTO player (id, team_id, name) VALUES (?, ?, ?)").run(id, team, name);
  }
  sqlite
    .prepare("INSERT INTO tournament (id, org_id, name, format, status, created_by) VALUES (7, 1, '联赛', 'round_robin', 'running', 1)")
    .run();
  sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (70, 7, 'round_robin', 1)").run();
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (500, 7, 10, 1)").run();
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (501, 7, 11, 2)").run();
  sqlite
    .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, score_home, score_away, status, finished_at) VALUES (800, 70, 1, 1, 500, 501, 3, 1, 'finished', ?)")
    .run(finishedAt);
  const goal = sqlite.prepare(
    "INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, assist_player_id, created_by) VALUES (?, 800, ?, ?, 'goal', ?, ?, 1)",
  );
  goal.run(900, 501, 200, 5, 201); // 0:1 客队首开纪录 —— 关键
  goal.run(901, 500, 100, 30, 101); // 1:1 主队扳平 —— 关键
  goal.run(902, 500, 102, 60, 103); // 2:1 主队反超 —— 关键
  goal.run(903, 500, 100, 80, 104); // 3:1 主队扩大优势 —— 非关键
  return createTestD1(sqlite);
}

// 只有一个进球的比赛（走快讯的单球分支）：首开纪录本身是关键节点，助攻照写
function singleGoalDb() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const iso = "2026-01-01T00:00:00Z";
  sqlite.prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (1, '管理员', '', 'x', 'admin', 0, 0)").run();
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (10, 1, '红队', ?)").run(iso);
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (11, 1, '蓝队', ?)").run(iso);
  sqlite.prepare("INSERT INTO player (id, team_id, name) VALUES (100, 10, '红前锋')").run();
  sqlite.prepare("INSERT INTO player (id, team_id, name) VALUES (101, 10, '红中场')").run();
  sqlite
    .prepare("INSERT INTO tournament (id, org_id, name, format, status, created_by) VALUES (7, 1, '联赛', 'round_robin', 'running', 1)")
    .run();
  sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (70, 7, 'round_robin', 1)").run();
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (500, 7, 10, 1)").run();
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (501, 7, 11, 2)").run();
  sqlite
    .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, score_home, score_away, status, finished_at) VALUES (800, 70, 1, 1, 500, 501, 1, 0, 'finished', ?)")
    .run(new Date().toISOString());
  sqlite
    .prepare("INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, assist_player_id, created_by) VALUES (900, 800, 500, 100, 'goal', 40, 101, 1)")
    .run();
  return createTestD1(sqlite);
}

describe("新闻助攻口径", () => {
  it("快讯：关键节点提助攻（写在进球前），扩大比分的进球不提", async () => {
    const items = await buildFeed(fourGoalDb());
    const item = items.find((i) => i.kind === "match" && i.matchId === 800);
    expect(item).toBeTruthy();
    const text = item!.paragraphs?.[0] ?? item!.body;
    // 三粒关键球：助球员名紧接在进球者名之前
    expect(text).toMatch(BEFORE("蓝中场", "蓝前锋"));
    expect(text).toMatch(BEFORE("红中场", "红前锋"));
    expect(text).toMatch(BEFORE("红后卫甲", "红边锋"));
    // 3:1 那粒只是扩大优势：助攻者名字整篇不出现
    expect(text).not.toContain("红后卫乙");
    // 旧语序（进球在前、助攻在后）不再出现
    expect(text).not.toMatch(/红前锋[^。]{0,20}红中场/);
  });

  it("战报：同一场比赛的叙述句同口径", async () => {
    const rep = await buildMatchReport(fourGoalDb(), 800);
    expect(rep).toBeTruthy();
    const text = rep!.paragraphs.join("");
    expect(text).toMatch(BEFORE("蓝中场", "蓝前锋"));
    expect(text).toMatch(BEFORE("红中场", "红前锋"));
    expect(text).toMatch(BEFORE("红后卫甲", "红边锋"));
    expect(text).not.toContain("红后卫乙");
    // 数据框仍保留全部助攻（只是正文不再逐个写），语序改动不波及数据面
    expect(rep!.goals.map((g) => g.assistPlayerName)).toEqual(["蓝中场", "红中场", "红后卫甲", "红后卫乙"]);
  });

  it("单球比赛：首开纪录是关键节点，助攻照写", async () => {
    const db = singleGoalDb();
    const item = (await buildFeed(db)).find((i) => i.kind === "match" && i.matchId === 800);
    expect(item).toBeTruthy();
    expect(item!.paragraphs?.[0] ?? item!.body).toMatch(BEFORE("红中场", "红前锋"));
    const rep = await buildMatchReport(db, 800);
    expect(rep!.paragraphs.join("")).toMatch(BEFORE("红中场", "红前锋"));
  });
});
