// 增量 40：管理端逐队扇出收口 —— 三个新聚合端点。
//
// 钉两件事：
//   1. 新端点的每一段与它取代的逐 id 原端点**逐字一致**（共用同一批构造器，防日后只改一边而漂移）；
//   2. 赛事作用域的批量端点只覆盖「本赛事参赛队」，不是全站球队。
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { applyMigrations, createTestD1, createTestKV } from "./d1";

// 认证中心的极简镜像：teamCodes / teamMembers 只跑裸 SQL（worker/lib/authClient.ts:112-142）
function authDb(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    `CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
     CREATE TABLE team (id INTEGER PRIMARY KEY, name TEXT NOT NULL, tour_team_id INTEGER);
     CREATE TABLE team_binding (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, team_id INTEGER NOT NULL, bound_at TEXT NOT NULL);
     CREATE TABLE team_bind_code (id INTEGER PRIMARY KEY, team_id INTEGER, expires_at TEXT, used_by INTEGER, used_at TEXT, created_at TEXT NOT NULL);`,
  );
  sqlite.prepare("INSERT INTO account (id, name) VALUES (1, '教练甲')").run();
  sqlite.prepare("INSERT INTO team (id, name, tour_team_id) VALUES (1, '红队', 10)").run();
  sqlite
    .prepare("INSERT INTO team_binding (id, account_id, team_id, bound_at) VALUES (1, 1, 1, '2026-01-01T00:00:00Z')")
    .run();
  sqlite
    .prepare("INSERT INTO team_bind_code (id, team_id, expires_at, used_by, used_at, created_at) VALUES (1, 1, '2026-06-01T00:00:00Z', NULL, NULL, '2026-01-02T00:00:00Z')")
    .run();
  return createTestD1(sqlite);
}

// 三队两赛事：
//   联赛 7：红队(10) / 蓝队(11)；冠军杯 9：红队(10) / 黄队(12)  ⇒ 黄队不进联赛 7
//   伤停：红队张三（联赛 7）、黄队赵六（冠军杯 9）
function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  sqlite
    .prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(1, "管理员", "", "x", "admin", 0, 0);

  const iso = "2026-01-01T00:00:00Z";
  for (const [id, name] of [
    [10, "红队"],
    [11, "蓝队"],
    [12, "黄队"],
  ] as const) {
    sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (?, 1, ?, ?)").run(id, name, iso);
  }
  for (const [pid, tid, name, num] of [
    [100, 10, "张三", "7"],
    [101, 10, "李四", "9"],
    [102, 11, "王五", "1"],
    [103, 12, "赵六", null],
  ] as const) {
    sqlite.prepare("INSERT INTO player (id, team_id, name, number) VALUES (?, ?, ?, ?)").run(pid, tid, name, num);
  }
  const t = sqlite.prepare(
    "INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (?, 1, ?, 'round_robin', 'running', 1, ?)",
  );
  t.run(7, "联赛", "2026-01-01T00:00:00Z");
  t.run(9, "冠军杯", "2026-02-01T00:00:00Z");
  const s = sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (?, ?, 'round_robin', 1)");
  s.run(70, 7);
  s.run(90, 9);
  const e = sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (?, ?, ?, ?)");
  e.run(500, 7, 10, 1);
  e.run(501, 7, 11, 2);
  e.run(600, 9, 10, 1);
  e.run(601, 9, 12, 2);
  const m = sqlite.prepare(
    "INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, score_home, score_away, status, finished_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)",
  );
  m.run(800, 70, 1, 500, 501, 3, 1, "finished", "2026-03-01T10:00:00Z");
  m.run(801, 70, 2, 501, 500, 0, 0, "pending", null);
  m.run(810, 90, 1, 600, 601, 0, 0, "pending", null);
  const ev = sqlite.prepare(
    "INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, created_by) VALUES (?, ?, ?, ?, ?, ?, 1)",
  );
  ev.run(900, 800, 500, 100, "injury_minor", 30);
  ev.run(901, 810, 601, 103, "injury_major", 20);
  const inj = sqlite.prepare(
    "INSERT INTO injury (id, team_id, player_id, event_id, injury_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
  );
  inj.run(950, 10, 100, 900, "踝关节扭伤", "2026-03-01T10:05:00Z");
  inj.run(951, 12, 103, 901, "股四头肌拉伤", "2026-03-02T10:05:00Z");
  sqlite.prepare("INSERT INTO injury_miss (injury_id, match_id) VALUES (950, 801)").run();
  sqlite.prepare("INSERT INTO injury_miss (injury_id, match_id) VALUES (951, 810)").run();

  const kv = new Map<string, string>([["sess:tok-admin", JSON.stringify({ userId: 1 })]]);
  const env: Record<string, unknown> = {
    DB: createTestD1(sqlite),
    AUTH_DB: authDb(),
    KV: createTestKV(kv) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
  };
  return { env, sqlite };
}

const get = (env: Record<string, unknown>, path: string) =>
  app.request(path, { headers: { Cookie: "whl_session=tok-admin" } }, env);
const json = async <T>(env: Record<string, unknown>, path: string): Promise<T> => {
  const res = await get(env, path);
  expect(res.status, `${path} 应为 200`).toBe(200);
  return (await res.json()) as T;
};

describe("赛事作用域批量端点（增量 40）", () => {
  it("team-players：只回本赛事参赛队的名单，且与逐队 /api/admin/teams/:id 逐字一致", async () => {
    const { env } = freshEnv();
    const b = await json<{ playersByTeam: Record<string, { id: number; name: string; number: string | null }[]> }>(
      env,
      "/api/admin/tournaments/7/team-players",
    );
    // 黄队(12) 只打冠军杯 9，不该出现在联赛 7 的批量结果里
    expect(Object.keys(b.playersByTeam).sort()).toEqual(["10", "11"]);
    for (const tid of [10, 11]) {
      const one = await json<{ players: unknown[] }>(env, `/api/admin/teams/${tid}`);
      expect(b.playersByTeam[String(tid)]).toEqual(one.players);
    }
    // 名单内的队序与排序表达式：无号（NULL）排最后
    expect(b.playersByTeam["10"].map((p) => p.name)).toEqual(["张三", "李四"]);

    const b9 = await json<{ playersByTeam: Record<string, unknown[]> }>(env, "/api/admin/tournaments/9/team-players");
    expect(Object.keys(b9.playersByTeam).sort()).toEqual(["10", "12"]);
  });

  it("team-injuries：按队分组，且与逐队 /api/admin/injuries?teamId= 逐字一致", async () => {
    const { env } = freshEnv();
    const b = await json<{ injuriesByTeam: Record<string, unknown[]> }>(env, "/api/admin/tournaments/7/team-injuries");
    // 联赛 7 只有红队那条；黄队的伤情属冠军杯 9
    expect(Object.keys(b.injuriesByTeam).sort()).toEqual(["10"]);
    const one = await json<{ injuries: unknown[] }>(env, "/api/admin/injuries?teamId=10");
    expect(b.injuriesByTeam["10"]).toEqual(one.injuries);
    expect(b.injuriesByTeam["10"]).toHaveLength(1);

    const b9 = await json<{ injuriesByTeam: Record<string, unknown[]> }>(env, "/api/admin/tournaments/9/team-injuries");
    expect(Object.keys(b9.injuriesByTeam).sort()).toEqual(["10", "12"]);
    const one12 = await json<{ injuries: unknown[] }>(env, "/api/admin/injuries?teamId=12");
    expect(b9.injuriesByTeam["12"]).toEqual(one12.injuries);

    // 没有伤情的队不出键（前端按 map 取值，缺键即空）
    expect(b.injuriesByTeam["11"]).toBeUndefined();
    const empty11 = await json<{ injuries: unknown[] }>(env, "/api/admin/injuries?teamId=11");
    expect(empty11.injuries).toEqual([]);
  });

  it("两个批量端点对不存在的赛事回 404", async () => {
    const { env } = freshEnv();
    for (const p of ["/api/admin/tournaments/999/team-players", "/api/admin/tournaments/999/team-injuries"]) {
      const res = await get(env, p);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { message: string }).message).toBe("赛事不存在");
    }
  });
});

describe("球队详情一次取齐 /api/admin/teams/:id/context（增量 40）", () => {
  it("五段与四个原端点逐字一致（team/players/codes/members/injuries）", async () => {
    const { env } = freshEnv();
    const ctx = await json<{
      team: unknown;
      players: unknown[];
      codes: unknown[];
      members: unknown[];
      injuries: unknown[];
    }>(env, "/api/admin/teams/10/context");
    const detail = await json<{ team: unknown; players: unknown[] }>(env, "/api/admin/teams/10");
    expect(ctx.team).toEqual(detail.team);
    expect(ctx.players).toEqual(detail.players);
    expect(ctx.codes).toEqual((await json<{ codes: unknown[] }>(env, "/api/admin/teams/10/auth-codes")).codes);
    expect(ctx.members).toEqual((await json<{ members: unknown[] }>(env, "/api/admin/teams/10/members")).members);
    expect(ctx.injuries).toEqual((await json<{ injuries: unknown[] }>(env, "/api/admin/injuries?teamId=10")).injuries);
    // 认证中心那两段确实取到了数据（不是空数组掩盖了失败）
    expect(ctx.codes).toHaveLength(1);
    expect(ctx.members).toHaveLength(1);
    expect(ctx.injuries).toHaveLength(1);
  });

  it("不存在的球队回 404 球队不存在", async () => {
    const { env } = freshEnv();
    const res = await get(env, "/api/admin/teams/999/context");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { message: string }).message).toBe("球队不存在");
  });
});
