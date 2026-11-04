// P5：归档快照（payload v2）与归档榜单口径。
//
// 钉四件事：
//   1. 「待过」= 参赛队 ∩（履历与赛事时间窗有交集 ∪ 事件队），A→B→A 只出现一次；
//   2. 归档前置检查 fail-closed：有事件球员履历没回填 → 409 且不归档、不写快照；
//   3. 快照与状态同事务提交，归档后改名/转会不再影响历史榜单；
//   4. 旧归档没有快照时按事件队推导，不报错。
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { applyMigrations, createTestD1, createTestKV, insertPlayer, sqlAll, sqlGet } from "./d1";
import { buildSnapshot, countUnsyncedPlayers } from "../worker/lib/tournamentSnapshot";
import { buildToplists } from "../worker/lib/topstats";

// 联赛 7（running）：红队 10 / 蓝队 11，两场已完赛（03-01、03-10）。
// 张三 100：履历 10（02-15 起）+ 一段非参赛队 12 的履历（必须被过滤）
// 李四 101：11 → 10 → 11（A→B→A），事件在 11
// 王五 102：没有参赛队履历，只作为助攻出现在红队事件里（事件兜底）
function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  sqlite
    .prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (1, '管理员', '', 'x', 'admin', 0, 0)")
    .run();
  const iso = "2026-01-01T00:00:00Z";
  for (const [id, name] of [
    [10, "红队"],
    [11, "蓝队"],
    [12, "黄队"],
  ] as const) {
    sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (?, 1, ?, ?)").run(id, name, iso);
  }
  insertPlayer(sqlite, { id: 100, teamId: 10, name: "张三", joinedAt: "2026-02-15T00:00:00Z" });
  insertPlayer(sqlite, { id: 101, teamId: 11, name: "李四", joinedAt: "2026-02-01T00:00:00Z" });
  insertPlayer(sqlite, { id: 102, teamId: 12, name: "王五", number: "9" });
  // 100 在非参赛队 12 也待过一段：不该出现在快照里
  sqlite
    .prepare("INSERT INTO player_team_history (player_id, team_id, joined_at, left_at) VALUES (100, 12, '2026-03-02T00:00:00Z', '2026-03-05T00:00:00Z')")
    .run();
  // 101：11（02-01→03-04）→ 10（03-04→03-06）→ 11（03-06 至今）
  sqlite.prepare("UPDATE player_team_history SET left_at = '2026-03-04T00:00:00Z' WHERE player_id = 101").run();
  sqlite
    .prepare("INSERT INTO player_team_history (player_id, team_id, joined_at, left_at) VALUES (101, 10, '2026-03-04T00:00:00Z', '2026-03-06T00:00:00Z')")
    .run();
  sqlite
    .prepare("INSERT INTO player_team_history (player_id, team_id, joined_at) VALUES (101, 11, '2026-03-06T00:00:00Z')")
    .run();

  sqlite
    .prepare(
      "INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (7, 1, '联赛', 'round_robin', 'running', 1, '2026-01-01T00:00:00Z')"
    )
    .run();
  sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (70, 7, 'round_robin', 1)").run();
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (500, 7, 10, 1)").run();
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (501, 7, 11, 2)").run();
  const match = sqlite.prepare(
    "INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, score_home, score_away, status, finished_at) VALUES (?, 70, ?, 1, 500, 501, 1, 0, 'finished', ?)"
  );
  match.run(800, 1, "2026-03-01T10:00:00Z");
  match.run(801, 2, "2026-03-10T10:00:00Z");
  sqlite
    .prepare("INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, created_by) VALUES (900, 800, 500, 100, 'goal', 10, 1)")
    .run();
  sqlite
    .prepare(
      "INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, created_by, assist_player_id) VALUES (901, 800, 500, 100, 'goal', 20, 1, 102)"
    )
    .run();
  sqlite
    .prepare("INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, created_by) VALUES (902, 801, 501, 101, 'goal', 30, 1)")
    .run();

  const env: Record<string, unknown> = {
    DB: createTestD1(sqlite),
    KV: createTestKV(new Map([["sess:tok-admin", JSON.stringify({ userId: 1 })]])) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
  };
  return { sqlite, env };
}

const post = (env: Record<string, unknown>, path: string) =>
  app.request(
    path,
    {
      method: "POST",
      headers: { Cookie: "whl_session=tok-admin", "content-type": "application/json" },
      body: JSON.stringify({ to: "archived" }),
    },
    env
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildSnapshot：待过哪些参赛队", () => {
  it("履历∩参赛队、A→B→A 去重、事件兜底、非参赛队过滤", async () => {
    const { sqlite } = freshEnv();
    const snap = await buildSnapshot(createTestD1(sqlite), 7);

    expect(snap.v).toBe(2);
    const byId = new Map(snap.players.map((p) => [p.playerId, p]));
    expect(byId.get(100)!.teams).toEqual([{ teamId: 10, teamName: "红队" }]);
    // 11 的最早重叠段从 02-01 开始，10 从 03-04 开始；A→B→A 的 11 只出现一次
    expect(byId.get(101)!.teams).toEqual([
      { teamId: 11, teamName: "蓝队" },
      { teamId: 10, teamName: "红队" },
    ]);
    // 履历里没有参赛队，但事件（助攻）代表红队出现过
    expect(byId.get(102)!.teams).toEqual([{ teamId: 10, teamName: "红队" }]);
    expect(snap.teams).toEqual([
      { teamId: 10, teamName: "红队" },
      { teamId: 11, teamName: "蓝队" },
    ]);
  });

  it("countUnsyncedPlayers：只数有事件且履历未回填的人", async () => {
    const { sqlite } = freshEnv();
    const db = createTestD1(sqlite);

    expect(await countUnsyncedPlayers(db, 7)).toBe(3);
    sqlite.prepare("UPDATE player SET history_synced_at = '2026-03-11T00:00:00Z' WHERE id IN (100, 101)").run();
    expect(await countUnsyncedPlayers(db, 7)).toBe(1);
    sqlite.prepare("UPDATE player SET history_synced_at = '2026-03-11T00:00:00Z' WHERE id = 102").run();
    expect(await countUnsyncedPlayers(db, 7)).toBe(0);
  });
});

describe("归档前置检查与事务", () => {
  it("有事件球员履历未回填 → 409，不归档、不写快照", async () => {
    const { env, sqlite } = freshEnv();

    const res = await post(env, "/api/admin/tournaments/7/transition");

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "history_incomplete", missing: 3 });
    expect(sqlGet(sqlite, "SELECT status FROM tournament WHERE id = 7")).toEqual({ status: "running" });
    expect(sqlGet(sqlite, "SELECT COUNT(*) AS n FROM tournament_snapshot")).toEqual({ n: 0 });
  });

  it("回填齐了 → 快照与状态一次提交，归档后改名/转会不影响榜单", async () => {
    const { env, sqlite } = freshEnv();
    const db = createTestD1(sqlite);
    sqlite.prepare("UPDATE player SET history_synced_at = '2026-03-11T00:00:00Z'").run();

    const res = await post(env, "/api/admin/tournaments/7/transition");

    expect(res.status).toBe(200);
    expect(sqlGet(sqlite, "SELECT status FROM tournament WHERE id = 7")).toEqual({ status: "archived" });
    const snapRow = sqlGet<{ payload_json: string }>(
      sqlite,
      "SELECT payload_json FROM tournament_snapshot WHERE tournament_id = 7"
    );
    expect(snapRow).toBeDefined();
    expect(JSON.parse(snapRow!.payload_json).v).toBe(2);

    // 归档后改名 + 转会：快照冻结，榜单还是归档瞬间的名字与归属
    sqlite.prepare("UPDATE team SET name = '红队新名' WHERE id = 10").run();
    sqlite
      .prepare("UPDATE player_team_history SET left_at = '2026-04-01T00:00:00Z' WHERE player_id = 100 AND left_at IS NULL")
      .run();
    sqlite
      .prepare("INSERT INTO player_team_history (player_id, team_id, joined_at) VALUES (100, 12, '2026-04-01T00:00:00Z')")
      .run();
    sqlite.prepare("UPDATE player SET name = '张三改' WHERE id = 100").run();

    const lists = await buildToplists(db, 7);
    const byName = new Map(lists.scorers.map((r) => [r.playerName, r]));
    expect(byName.get("张三")).toMatchObject({ teamName: "红队", count: 2 });
    expect(byName.get("李四")).toMatchObject({ teamName: "蓝队 / 红队" });
    expect(lists.assists.find((r) => r.playerId === 102)).toMatchObject({ teamName: "红队" });
    expect(byName.has("张三改")).toBe(false);
  });

  it("归档但无快照（旧数据）→ 按事件队推导，不抛错", async () => {
    const { sqlite } = freshEnv();
    sqlite.prepare("UPDATE tournament SET status = 'archived' WHERE id = 7").run();

    const lists = await buildToplists(createTestD1(sqlite), 7);

    const byName = new Map(lists.scorers.map((r) => [r.playerName, r]));
    // 事件里 101 只代表蓝队出场；没有快照时不拿履历补，避免「看起来像实时口径」
    expect(byName.get("李四")).toMatchObject({ teamName: "蓝队" });
    expect(lists.assists.find((r) => r.playerId === 102)).toMatchObject({ teamName: "红队" });
    expect(sqlAll(sqlite, "SELECT COUNT(*) AS n FROM tournament_snapshot")).toEqual([{ n: 0 }]);
  });
});
