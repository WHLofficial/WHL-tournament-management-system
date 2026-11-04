// P3 读端回归：名单/人数/榜单/伤停都按 player_team_history 的开放窗口判断现役。
// 场景覆盖第 25 项（伤停跟人走）与解约清退：
//   红队(10)：张三 100、李四 101；蓝队(11)：王五 102；赵六 103 由红转蓝（归属只由履历窗口表达）。
//   张三在红队时受伤，随后转去蓝队：公开/教练跟蓝队，比赛缺阵与管理端全量仍按登记队红队。
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import type { D1Database } from "@cloudflare/workers-types";
import { listActiveInjuries, listAllInjuries, listMatchAbsences } from "../worker/lib/injury";
import { applyMigrations, createTestD1, createTestKV, insertPlayer } from "./d1";

function authDb(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    `CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
     CREATE TABLE team (id INTEGER PRIMARY KEY, name TEXT NOT NULL, tour_team_id INTEGER);
     CREATE TABLE team_binding (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, team_id INTEGER NOT NULL, bound_at TEXT NOT NULL);`,
  );
  sqlite.prepare("INSERT INTO account (id, name) VALUES (2, '教练甲')").run();
  sqlite.prepare("INSERT INTO team (id, name, tour_team_id) VALUES (1, '红队', 10)").run();
  sqlite
    .prepare("INSERT INTO team_binding (id, account_id, team_id, bound_at) VALUES (1, 2, 1, '2026-01-01T00:00:00Z')")
    .run();
  return createTestD1(sqlite);
}

function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const u = sqlite.prepare(
    "INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, '', 'x', ?, 0, 0)",
  );
  u.run(1, "管理员", "admin");
  u.run(2, "教练甲", "coach");
  const iso = "2026-01-01T00:00:00Z";
  for (const [id, name] of [
    [10, "红队"],
    [11, "蓝队"],
  ] as const) {
    sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (?, 1, ?, ?)").run(id, name, iso);
  }
  for (const [pid, tid, name, number] of [
    [100, 10, "张三", "9"],
    [101, 10, "李四", "7"],
    [102, 11, "王五", "1"],
    [103, 10, "赵六", "11"],
  ] as const) {
    insertPlayer(sqlite, { id: pid, teamId: tid, name, number });
  }
  // 赵六：红 → 蓝。读端必须只看履历窗口。
  sqlite
    .prepare("UPDATE player_team_history SET left_at = '2026-02-01T00:00:00Z' WHERE player_id = 103")
    .run();
  sqlite
    .prepare(
      "INSERT INTO player_team_history (player_id, team_id, joined_at, source) VALUES (103, 11, '2026-02-01T00:00:00Z', 'transfer')",
    )
    .run();

  sqlite
    .prepare("INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (7, 1, '联赛', 'round_robin', 'running', 1, ?)")
    .run(iso);
  sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (70, 7, 'round_robin', 1)").run();
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (500, 7, 10, 1)").run();
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (501, 7, 11, 2)").run();
  const m = sqlite.prepare(
    "INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status, finished_at) VALUES (?, 70, ?, 1, 500, 501, ?, ?)",
  );
  m.run(800, 1, "finished", "2026-01-10T10:00:00Z");
  m.run(801, 2, "pending", null);
  const ev = sqlite.prepare(
    "INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, created_by) VALUES (?, ?, 500, ?, ?, 20, 1)",
  );
  ev.run(900, 800, 100, "goal"); // 张三在红队时进球
  ev.run(901, 800, 103, "goal"); // 赵六在红队时进球（现已转蓝）
  ev.run(902, 800, 100, "injury_minor"); // 张三在红队时受伤
  sqlite
    .prepare("INSERT INTO injury (id, team_id, player_id, event_id, injury_name) VALUES (950, 10, 100, 902, '踝关节扭伤')")
    .run();
  sqlite.prepare("INSERT INTO injury_miss (injury_id, match_id) VALUES (950, 801)").run();
  // 张三随后也转去蓝队（伤停跟人走）
  sqlite.prepare("UPDATE player_team_history SET left_at = '2026-02-01T00:00:00Z' WHERE player_id = 100").run();
  sqlite
    .prepare(
      "INSERT INTO player_team_history (player_id, team_id, joined_at, source) VALUES (100, 11, '2026-02-01T00:00:00Z', 'transfer')",
    )
    .run();

  const kv = new Map<string, string>([
    ["sess:tok-admin", JSON.stringify({ userId: 1 })],
    ["sess:tok-coach", JSON.stringify({ userId: 2 })],
  ]);
  const env: Record<string, unknown> = {
    DB: createTestD1(sqlite),
    AUTH_DB: authDb(),
    KV: createTestKV(kv) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
  };
  return { env, sqlite, db: env.DB as D1Database };
}

const asAdmin = { Cookie: "whl_session=tok-admin" };
const asCoach = { Cookie: "whl_session=tok-coach" };
// 公开端挂了 pubCache（caches.default + executionCtx.waitUntil），测试环境补最小桩
(globalThis as unknown as { caches: unknown }).caches = {
  default: { match: async () => undefined, put: async () => {} },
};
const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

describe("P3 读端：现役口径只看履历开放窗口", () => {
  it("管理端名单与人数、教练首屏都按开放窗口，解约（关窗）后立即消失", async () => {
    const { env, sqlite } = freshEnv();
    const list = async () => {
      const r = await app.request("/api/admin/teams", { headers: asAdmin }, env);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { teams: Array<{ id: number; playerCount: number }> };
      return body.teams;
    };
    expect((await list()).find((t) => t.id === 10)?.playerCount).toBe(1); // 只剩李四
    expect((await list()).find((t) => t.id === 11)?.playerCount).toBe(3); // 王五 + 转来的赵六、张三

    const detail = await app.request("/api/admin/teams/10", { headers: asAdmin }, env);
    const { players } = (await detail.json()) as { players: Array<{ id: number }> };
    expect(players.map((p) => p.id)).toEqual([101]); // 张三、赵六都已关窗

    const boot = await app.request("/api/coach/bootstrap", { headers: asCoach }, env);
    expect(boot.status).toBe(200);
    const coach = (await boot.json()) as { team: { players: Array<{ id: number }> } | null };
    expect(coach.team?.players.map((p) => p.id)).toEqual([101]);

    // 李四解约：关窗即可，不删人（match_event 外键仍指着历史事件）
    sqlite.prepare("UPDATE player_team_history SET left_at = '2026-03-01T00:00:00Z' WHERE player_id = 101").run();
    expect((await list()).find((t) => t.id === 10)?.playerCount).toBe(0);
    const after = await app.request("/api/admin/teams/10", { headers: asAdmin }, env);
    expect(((await after.json()) as { players: unknown[] }).players).toEqual([]);
  });

  it("赛事页 playerCount 同口径：转出者算新队，旧窗不参与", async () => {
    const { env } = freshEnv();
    const r = await app.request("/api/public/tournaments/7", {}, env, execCtx as never);
    expect(r.status).toBe(200);
    const { entries } = (await r.json()) as { entries: Array<{ teamId: number; playerCount: number }> };
    expect(entries.map((e) => [e.teamId, e.playerCount])).toEqual([
      [10, 1], // 张三、赵六已转出，只剩李四
      [11, 3], // 王五 + 张三 + 赵六
    ]);
  });

  it("射手榜队名跟当前窗口；已无窗口的离队球员事件仍显示，队名回退「-」", async () => {
    const { env, sqlite } = freshEnv();
    const toplists = async () => {
      const r = await app.request("/api/public/tournaments/7/toplists", {}, env, execCtx as never);
      expect(r.status).toBe(200);
      return (await r.json()) as { scorers: Array<{ playerName: string; teamName: string }> };
    };
    const byName = async () => new Map((await toplists()).scorers.map((s) => [s.playerName, s]));
    let list = await byName();
    expect(list.get("张三")?.teamName).toBe("蓝队"); // 进球时在红队，现在人在蓝队
    expect(list.get("赵六")?.teamName).toBe("蓝队");

    // 张三彻底解约（关窗）：历史进球仍保留，队名回退「-」
    sqlite.prepare("UPDATE player_team_history SET left_at = '2026-04-01T00:00:00Z' WHERE player_id = 100").run();
    list = await byName();
    expect(list.get("张三")?.teamName).toBe("-");
    expect(list.get("张三")).toBeTruthy();
  });

  it("伤停跟现役窗口：公开/教练筛新队，比赛缺阵与管理端全量仍按登记队", async () => {
    const { db } = freshEnv();
    const all = await listActiveInjuries(db);
    expect(all.map((x) => [x.playerName, x.teamName])).toEqual([["张三", "蓝队"]]);
    expect(await listActiveInjuries(db, 10)).toEqual([]);
    expect((await listActiveInjuries(db, 11)).map((x) => x.playerName)).toEqual(["张三"]);

    // 比赛缺阵（红队主场那场）仍按登记时的队红队出，不随转会漂走
    const absences = await listMatchAbsences(db, 801, 10, 11);
    expect(absences.home.map((x) => x.playerName)).toEqual(["张三"]);
    expect(absences.away).toEqual([]);
    // 管理端集中页保留登记队名
    expect((await listAllInjuries(db)).map((x) => [x.playerName, x.teamName])).toEqual([["张三", "红队"]]);
  });
});
