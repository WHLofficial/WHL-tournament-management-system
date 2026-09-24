// 快讯叙事三类目（易主/纪录/里程碑）此前零覆盖，而「叙事账本改走窄查询」正落在这条路径上：
// 账本的队名靠事件行的 entry_id 反推该场主客队名，窄查询一旦丢列或把 LEFT JOIN 写成 INNER，队名就会串。
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, createTestD1 } from "./d1";
import { buildFeed } from "../worker/lib/feedNews";
import { fetchFinishedWindow } from "../worker/lib/context";

// 单组三队四轮（全部完赛，按 finished_at 升序）：
//   795 蓝 1:0 黄    796 红 5:0 黄    797 蓝 1:0 红    798 黄 0:2 蓝
// 制造出三件事：797 榜首由红队易主给蓝队；蓝队 797 连续两场零封、798 三连胜；
// 红队 100 号在 796 打进第 5 球；蓝队 200 号在 798 由 4 球涨到 6 球、反超 100 号的 5 球登顶。
function narrativeDb() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const iso = "2026-01-01T00:00:00Z";

  sqlite
    .prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (1, '管理员', '', 'x', 'admin', 0, 0)")
    .run();
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (10, 1, '红队', ?)").run(iso);
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (11, 1, '蓝队', ?)").run(iso);
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (12, 1, '黄队', ?)").run(iso);
  sqlite.prepare("INSERT INTO player (id, team_id, name) VALUES (100, 10, '红前锋')").run();
  sqlite.prepare("INSERT INTO player (id, team_id, name) VALUES (200, 11, '蓝前锋')").run();
  sqlite.prepare("INSERT INTO player (id, team_id, name) VALUES (300, 12, '黄前锋')").run();
  sqlite
    .prepare("INSERT INTO tournament (id, org_id, name, format, status, created_by) VALUES (7, 1, '联赛', 'round_robin', 'running', 1)")
    .run();
  sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (70, 7, 'round_robin', 1)").run();
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (500, 7, 10, 1)").run();
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (501, 7, 11, 2)").run();
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (502, 7, 12, 3)").run();

  const match = sqlite.prepare(
    "INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, score_home, score_away, status, finished_at) VALUES (?, 70, ?, 1, ?, ?, ?, ?, 'finished', ?)",
  );
  match.run(795, 1, 501, 502, 1, 0, "2026-03-01T10:00:00Z");
  match.run(796, 2, 502, 500, 0, 5, "2026-03-02T10:00:00Z");
  match.run(797, 3, 501, 500, 1, 0, "2026-03-03T10:00:00Z");
  match.run(798, 4, 502, 501, 0, 2, "2026-03-04T10:00:00Z");

  const goal = sqlite.prepare(
    "INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, created_by) VALUES (?, ?, ?, ?, 'goal', ?, 1)",
  );
  goal.run(900, 795, 501, 200, 20);
  for (let i = 0; i < 5; i++) goal.run(910 + i, 796, 500, 100, 10 + i * 10);
  for (let i = 0; i < 3; i++) goal.run(920 + i, 797, 501, 200, 10 + i * 10);
  goal.run(930, 798, 501, 200, 20);
  goal.run(931, 798, 501, 200, 40);

  // 终局积分榜：蓝队 3 战全胜 9 分且一球未失；红队 2 战 3 分但净胜球高
  const standing = sqlite.prepare(
    "INSERT INTO standing (stage_id, entry_id, played, won, drawn, lost, pts, gf, ga) VALUES (70, ?, ?, ?, 0, ?, ?, ?, ?)",
  );
  standing.run(500, 2, 1, 1, 3, 5, 1);
  standing.run(501, 3, 3, 0, 9, 4, 0);
  standing.run(502, 3, 0, 3, 0, 0, 8);

  return createTestD1(sqlite);
}

describe("快讯叙事三类目", () => {
  it("易主/纪录/里程碑都出条，且队名取自事件行反推的主客队", async () => {
    const items = await buildFeed(narrativeDb(), { limit: 15 });
    const ids = items.map((i) => i.id);

    // 797 蓝队 1:0 红队后登顶（赛前红队 3 分净胜球 +4 领先，蓝队 3 分 +1）——榜首易主
    expect(ids).toContain("leader:797");

    // 蓝队 797 连续两场零封（795、797 都是 1:0）；798 三连胜
    expect(ids).toContain("streak:797:501");
    expect(ids).toContain("streak:798:501");

    // 红队 100 号在 796 打进第 5 球；蓝队 200 号在 798 以 3 球登顶射手榜
    expect(ids).toContain("milestone:796:100");
    expect(ids).toContain("milestone:798:200");

    // 首轮 795 是首个比赛日，三项都不成立
    const first = items.filter((i) => i.kind === "leader" || i.kind === "streak" || i.kind === "milestone");
    expect(first.map((i) => i.matchId)).not.toContain(795);
  });

  it("里程碑的队名跟着进球者的 entry_id 走，不是该场主队", async () => {
    const items = await buildFeed(narrativeDb(), { limit: 15 });
    const at796 = items.find((i) => i.id === "milestone:796:100");
    const at798 = items.find((i) => i.id === "milestone:798:200");
    expect(at796).toBeDefined();
    expect(at798).toBeDefined();

    // 796 是「黄队主场、红队客场」，进球者 100 号属于客队红队 —— 队名若误取主队名就会写成黄队
    expect(at796!.title).toContain("红前锋");
    expect(at796!.body).toContain("红队");
    expect(at796!.body).not.toContain("黄队");
    // 798 是「登顶射手榜」分支，标题带射手名（该分支句库不含队名，队名覆盖靠上面那条）
    expect(at798!.title).toContain("蓝前锋");
  });
});

// 五轮循环赛（四队两场/轮，共 10 场完赛），胜负交替以避开连胜/不败/零封纪录，无事件故无里程碑。
// 轮次越新 finished_at 越大；每轮最后一场 12:00 收，综述条的 at 就等于这个时刻。
function fiveRoundDb() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const iso = "2026-01-01T00:00:00Z";

  sqlite
    .prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (1, '管理员', '', 'x', 'admin', 0, 0)")
    .run();
  for (const [id, name] of [
    [10, "红队"],
    [11, "蓝队"],
    [12, "黄队"],
    [13, "绿队"],
  ] as const) {
    sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (?, 1, ?, ?)").run(id, name, iso);
  }
  sqlite
    .prepare("INSERT INTO tournament (id, org_id, name, format, status, created_by) VALUES (7, 1, '联赛', 'round_robin', 'running', 1)")
    .run();
  sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (70, 7, 'round_robin', 1)").run();
  for (const [id, team, seed] of [
    [500, 10, 1],
    [501, 11, 2],
    [502, 12, 3],
    [503, 13, 4],
  ] as const) {
    sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (?, 7, ?, ?)").run(id, team, seed);
  }

  const match = sqlite.prepare(
    "INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, score_home, score_away, status, finished_at) VALUES (?, 70, ?, ?, ?, ?, ?, ?, 'finished', ?)",
  );
  for (let r = 1; r <= 5; r++) {
    const [sh, sa] = r % 2 === 1 ? [2, 1] : [1, 2];
    match.run(800 + r * 10 + 1, r, 1, 500, 501, sh, sa, `2026-03-0${r}T10:00:00Z`);
    match.run(800 + r * 10 + 2, r, 2, 502, 503, sh, sa, `2026-03-0${r}T12:00:00Z`);
  }
  return createTestD1(sqlite);
}

describe("快讯综述按 cap 截断", () => {
  it("cutoff 生效时不会留下早于第 cap 条窗口项的轮次；窗口不足 cap 时守卫原样返回", async () => {
    const db = fiveRoundDb();
    const cap = 8;
    const items = await buildFeed(db, { limit: cap });
    expect(items.length).toBeLessThanOrEqual(cap);

    // 复算 cutoff：与 buildFeed 内部同一来源（fetchFinishedWindow + 同一个 cap），确保守卫没有提前返回
    const window = await fetchFinishedWindow(db, Math.max(cap * 3, 40));
    expect(window.length).toBeGreaterThanOrEqual(cap);
    const cutoff = window[cap - 1].finishedAt;
    expect(cutoff).toBeTruthy();

    const recaps = items.filter((i) => i.kind === "recap");
    expect(recaps.length).toBeGreaterThan(0);
    for (const r of recaps) expect(r.at! >= cutoff!).toBe(true);
    expect(recaps.map((r) => (r as unknown as { round: number }).round)).not.toContain(1);

    // 对照组：cap 大于可用场次数 ⇒ window.length < cap ⇒ 守卫原样返回，最老一轮的综述重新出现
    const all = await buildFeed(db, { limit: 50 });
    expect(all.filter((i) => i.kind === "recap").map((i) => (i as unknown as { round: number }).round)).toContain(1);
  });
});
