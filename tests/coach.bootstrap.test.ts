// 教练首屏聚合端点 /api/coach/bootstrap（增量 39）：
// 战术板首屏原来 4 个 effect 各发一次请求（本队名单 / 战术存档 / 待选比赛 / 代打授权），
// 合成一个端点后前端首屏请求从 4 降到 1。这里钉两件事：
//   1. 四段的形状与内容跟拆开的四个端点**逐字一致**（共用同一批构造器，防日后只改一边而漂移）；
//   2. 未绑队时四段各自退化成 null / 空数组，不抛错。
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { applyMigrations, createTestD1, createTestKV } from "./d1";

// 认证中心的极简镜像：boundTeamId / teamMembers / boundAccounts 只跑裸 SQL（worker/lib/authClient.ts）
function authDb(bindTourTeamId: number | null): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    `CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
     CREATE TABLE team (id INTEGER PRIMARY KEY, name TEXT NOT NULL, tour_team_id INTEGER);
     CREATE TABLE team_binding (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, team_id INTEGER NOT NULL, bound_at TEXT NOT NULL);`,
  );
  sqlite.prepare("INSERT INTO account (id, name) VALUES (1, '教练甲')").run();
  sqlite.prepare("INSERT INTO team (id, name, tour_team_id) VALUES (1, '红队', ?)").run(bindTourTeamId);
  if (bindTourTeamId != null) {
    sqlite
      .prepare("INSERT INTO team_binding (id, account_id, team_id, bound_at) VALUES (1, 1, 1, '2026-01-01T00:00:00Z')")
      .run();
  }
  return createTestD1(sqlite);
}

function freshEnv(bind: number | null) {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  sqlite
    .prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(1, "教练甲", "", "x", "coach", 0, 0);

  const iso = "2026-01-01T00:00:00Z";
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (10, 1, '红队', ?)").run(iso);
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (11, 1, '蓝队', ?)").run(iso);
  for (const [pid, tid, name, num] of [
    [100, 10, "张三", "7"],
    [101, 10, "李四", "9"],
    [102, 11, "王五", "1"],
  ] as const) {
    sqlite.prepare("INSERT INTO player (id, team_id, name, number) VALUES (?, ?, ?, ?)").run(pid, tid, name, num);
  }
  // 联赛 7（在打）、草稿 8（不该进待赛列表）
  const t = sqlite.prepare(
    "INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (?, 1, ?, 'round_robin', ?, 1, ?)",
  );
  t.run(7, "联赛", "running", "2026-01-01T00:00:00Z");
  t.run(8, "筹备中的杯赛", "draft", "2026-03-01T00:00:00Z");
  const s = sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (?, ?, 'round_robin', 1)");
  s.run(70, 7);
  s.run(80, 8);
  const e = sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (?, ?, ?, ?)");
  e.run(500, 7, 10, 1);
  e.run(501, 7, 11, 2);
  e.run(700, 8, 10, 1);
  const m = sqlite.prepare(
    "INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status, finished_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)",
  );
  m.run(800, 70, 1, 500, 501, "finished", "2026-01-10T10:00:00Z");
  m.run(801, 70, 2, 501, 500, "pending", null);
  m.run(820, 80, 1, 700, null, "pending", null);
  sqlite
    .prepare("INSERT INTO tactic (id, team_id, created_by, code, form, buildup, line_height, note, created_at) VALUES (1, 10, 1, '12345678901', '433', 'balanced', 50, '首轮', ?)")
    .run("2026-01-05T00:00:00Z");
  sqlite
    .prepare("INSERT INTO lineup_proxy_grant (id, match_id, team_id, grantee_user_id, granted_by, created_at) VALUES (1, 801, 10, 1, 1, ?)")
    .run(iso);

  const env: Record<string, unknown> = {
    DB: createTestD1(sqlite),
    KV: createTestKV(new Map([["sess:tok-coach", JSON.stringify({ userId: 1 })]])) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
    AUTH_DB: authDb(bind),
  };
  return env;
}

const get = (env: Record<string, unknown>, path: string) =>
  app.request(path, { headers: { Cookie: "whl_session=tok-coach" } }, env);

describe("教练首屏聚合 /api/coach/bootstrap", () => {
  it("四段与拆开的四个端点逐字一致", async () => {
    const env = freshEnv(10);
    const res = await get(env, "/api/coach/bootstrap");
    expect(res.status).toBe(200);
    const boot = (await res.json()) as {
      team: unknown;
      tactics: unknown[];
      matches: unknown[];
      sessions: unknown[];
    };

    const [meTeam, tactics, matches, sessions] = await Promise.all([
      get(env, "/api/coach/me/team").then((r) => r.json()),
      get(env, "/api/coach/tactics").then((r) => r.json()),
      get(env, "/api/coach/me/matches").then((r) => r.json()),
      get(env, "/api/coach/proxy/sessions").then((r) => r.json()),
    ]);

    expect(boot.team).toEqual((meTeam as { team: unknown }).team);
    expect(boot.tactics).toEqual((tactics as { tactics: unknown[] }).tactics);
    expect(boot.matches).toEqual((matches as { matches: unknown[] }).matches);
    expect(boot.sessions).toEqual((sessions as { sessions: unknown[] }).sessions);
  });

  it("内容本身也对：本队名单、存档、待赛（草稿赛事不进）、代打授权", async () => {
    const env = freshEnv(10);
    const res = await get(env, "/api/coach/bootstrap");
    const boot = (await res.json()) as {
      team: { id: number; name: string; players: { id: number; name: string }[] } | null;
      tactics: { code: string; form: string }[];
      matches: { id: number; side: string; opponentName: string | null }[];
      sessions: { matchId: number }[];
    };

    expect(boot.team).toMatchObject({ id: 10, name: "红队" });
    expect(boot.team?.players.map((p) => p.name)).toEqual(["张三", "李四"]);
    expect(boot.tactics).toHaveLength(1);
    expect(boot.tactics[0]).toMatchObject({ code: "12345678901", form: "433" });
    // 801 里红队是客队；820 属草稿赛事，不进待赛列表
    expect(boot.matches).toHaveLength(1);
    expect(boot.matches[0]).toMatchObject({ id: 801, side: "away", opponentName: "蓝队" });
    expect(boot.sessions.map((s) => s.matchId)).toEqual([801]);
  });

  it("未绑队时本队三段退化成 null / 空数组；代打授权照常返回（与被代打队的绑定无关）", async () => {
    const env = freshEnv(null);
    const res = await get(env, "/api/coach/bootstrap");
    expect(res.status).toBe(200);
    const boot = (await res.json()) as {
      team: unknown;
      tactics: unknown[];
      matches: unknown[];
      sessions: { matchId: number }[];
    };
    expect(boot.team).toBeNull();
    expect(boot.tactics).toEqual([]);
    expect(boot.matches).toEqual([]);
    // 代打者是另一个账号、本来就不必绑定任何球队，所以这一段的门是「有授权」而不是「绑了队」
    expect(boot.sessions.map((s) => s.matchId)).toEqual([801]);
    const solo = (await (await get(env, "/api/coach/proxy/sessions")).json()) as { sessions: unknown[] };
    expect(boot.sessions).toEqual(solo.sessions);
  });
});
