// 排期器管理端接口（P3-B）：预览 → 提交 → 公布 → 解锁 → 单场改期 / 清空。
// 钉的是「预览不改库、指纹对不上就拒、公布即锁定、单场改期留 override 标记」。
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { applyMigrations, createTestD1, createTestKV } from "./d1";

const iso = "2026-01-01T00:00:00Z";

function freshEnv(withFinished = false) {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  sqlite
    .prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (1, '管理员', '', 'x', 'admin', 0, 0)")
    .run();
  sqlite
    .prepare("INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (13, 1, 'S9 | 顶级联赛', 'round_robin', 'running', 1, ?)")
    .run(iso);
  sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (131, 13, 'round_robin', 1)").run();
  for (const [id, name] of [
    [1, "红队"],
    [2, "蓝队"],
    [3, "黄队"],
    [4, "绿队"],
  ] as const) {
    sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (?, 1, ?, ?)").run(id, name, iso);
    sqlite
      .prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (?, 13, ?, ?)")
      .run(900 + id, id, id);
  }
  const m = sqlite.prepare(
    "INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status) VALUES (?, 131, 11, ?, ?, ?, ?)"
  );
  m.run(1, 1, 901, 902, "pending");
  m.run(2, 2, 903, 904, "pending");
  if (withFinished) m.run(3, 3, 901, 903, "finished");

  sqlite.prepare("INSERT INTO season (id, name, weeks) VALUES (1, 'S9', 31)").run();
  sqlite
    .prepare(
      `INSERT INTO round_window (id, season_id, tournament_id, stream, round, leg, week, day_start, day_end)
       VALUES (10, 1, 13, 'league', 11, NULL, 12, 6, 7)`
    )
    .run();
  // 第 12 轮是本赛季/本 stream 的末轮 → 必须同时开球
  sqlite
    .prepare(
      `INSERT INTO round_window (id, season_id, tournament_id, stream, round, leg, week, day_start, day_end)
       VALUES (11, 1, 13, 'league', 12, NULL, 12, 6, 7)`
    )
    .run();
  sqlite
    .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status) VALUES (?, 131, 12, ?, ?, ?, 'pending')")
    .run(4, 1, 901, 904);
  sqlite
    .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status) VALUES (?, 131, 12, ?, ?, ?, 'pending')")
    .run(5, 2, 902, 903);

  const pool = sqlite.prepare(
    "INSERT INTO time_pool (season_id, phase, competition, day, slots) VALUES (1, 'autumn', 'top', ?, ?)"
  );
  pool.run(6, JSON.stringify([
    { time: "12:30", cap: 1 },
    { time: "17:30", cap: 1 },
    { time: "20:00", cap: 1 },
  ]));
  pool.run(7, JSON.stringify([
    { time: "14:00", cap: 1 },
    { time: "20:00", cap: 1 },
  ]));

  const kv = new Map<string, string>([["sess:tok-admin", JSON.stringify({ userId: 1 })]]);
  const env: Record<string, unknown> = {
    DB: createTestD1(sqlite),
    KV: createTestKV(kv) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
  };
  return { env, sqlite };
}

const call = (env: Record<string, unknown>, path: string, init?: RequestInit) =>
  app.request(path, { ...init, headers: { "Content-Type": "application/json", Cookie: "whl_session=tok-admin" } }, env);

const post = (env: Record<string, unknown>, path: string, body?: unknown) =>
  call(env, path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

type Dto = { matchId: number; week: number | null; day: number | null; time: string | null; override: boolean };

describe("排期窗口接口", () => {
  it("窗口清单带上有场次数与可排数", async () => {
    const { env } = freshEnv();
    const res = await call(env, "/api/admin/tournaments/13/windows");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { windows: Array<Record<string, number>> };
    expect(body.windows).toHaveLength(2);
    expect(body.windows[0].matchCount).toBe(2);
    expect(body.windows[0].scheduledCount).toBe(0);
  });

  it("预览只出提案不动库", async () => {
    const { env, sqlite } = freshEnv();
    const res = await post(env, "/api/admin/tournaments/13/windows/10/schedule/preview");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposalHash: string; matches: Dto[]; unscheduled: number[] };
    expect(body.proposalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.matches.filter((m) => m.time != null)).toHaveLength(2);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM match WHERE kickoff_time IS NOT NULL").get()).toEqual({ n: 0 });
  });

  it("指纹不匹配 409，匹配则落库并留快照", async () => {
    const { env, sqlite } = freshEnv();
    const bad = await post(env, "/api/admin/tournaments/13/windows/10/schedule/commit", { proposalHash: "nope" });
    expect(bad.status).toBe(409);

    const preview = (await (await post(env, "/api/admin/tournaments/13/windows/10/schedule/preview")).json()) as {
      proposalHash: string;
    };
    const ok = await post(env, "/api/admin/tournaments/13/windows/10/schedule/commit", {
      proposalHash: preview.proposalHash,
    });
    expect(ok.status).toBe(200);
    const rows = sqlite.prepare("SELECT id, kickoff_week, kickoff_day, kickoff_time FROM match WHERE round = 11 ORDER BY id").all() as Array<{
      id: number;
      kickoff_week: number | null;
      kickoff_day: number | null;
      kickoff_time: string | null;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].kickoff_week).toBe(12);
    expect(rows[0].kickoff_time).not.toBeNull();
    expect(rows[1].kickoff_time).not.toBeNull();
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM schedule_snapshot").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'kickoff_commit'").get()).toEqual({ n: 1 });
  });

  it("末轮同时开球：全部压在同一天同一刻", async () => {
    const { env } = freshEnv();
    const res = await post(env, "/api/admin/tournaments/13/windows/11/schedule/preview");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matches: Dto[]; conflicts: unknown[] };
    const placedNow = body.matches.filter((m) => m.time != null);
    expect(placedNow).toHaveLength(2);
    expect(new Set(placedNow.map((m) => `${m.day}|${m.time}`)).size).toBe(1);
    expect(body.conflicts).toEqual([]);
  });

  it("非末轮不强制同开", async () => {
    const { env } = freshEnv();
    const body = (await (await post(env, "/api/admin/tournaments/13/windows/10/schedule/preview")).json()) as {
      matches: Dto[];
    };
    const points = body.matches.filter((m) => m.time != null).map((m) => `${m.day}|${m.time}`);
    expect(points).toHaveLength(2);
    expect(new Set(points).size).toBe(2);
  });

  it("有赛果的窗口拒绝重排", async () => {
    const { env } = freshEnv(true);
    const res = await post(env, "/api/admin/tournaments/13/windows/10/schedule/preview");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain("已开赛");
  });

  it("公布即锁定；解锁要理由", async () => {
    const { env, sqlite } = freshEnv();
    const early = await post(env, "/api/admin/tournaments/13/windows/10/publish");
    expect(early.status).toBe(409); // 两场都还没时刻

    const preview = (await (await post(env, "/api/admin/tournaments/13/windows/10/schedule/preview")).json()) as {
      proposalHash: string;
    };
    await post(env, "/api/admin/tournaments/13/windows/10/schedule/commit", { proposalHash: preview.proposalHash });

    const published = await post(env, "/api/admin/tournaments/13/windows/10/publish");
    expect(published.status).toBe(200);
    expect(sqlite.prepare("SELECT locked_at FROM round_window WHERE id = 10").get()).not.toEqual({ locked_at: null });

    const blocked = await post(env, "/api/admin/tournaments/13/windows/10/schedule/preview");
    expect(blocked.status).toBe(409);

    const noReason = await post(env, "/api/admin/tournaments/13/windows/10/unlock", {});
    expect(noReason.status).toBe(400);
    const unlocked = await post(env, "/api/admin/tournaments/13/windows/10/unlock", { reason: "补赛调整" });
    expect(unlocked.status).toBe(200);
    expect((await post(env, "/api/admin/tournaments/13/windows/10/schedule/preview")).status).toBe(200);
  });
});

describe("单场改期", () => {
  it("越窗改期要理由，写进 override + audit", async () => {
    const { env, sqlite } = freshEnv();
    const noReason = await call(env, "/api/admin/tournaments/13/matches/1/kickoff", {
      method: "PATCH",
      body: JSON.stringify({ week: 15, day: 5, time: "12:30" }),
    });
    expect(noReason.status).toBe(400);

    const ok = await call(env, "/api/admin/tournaments/13/matches/1/kickoff", {
      method: "PATCH",
      body: JSON.stringify({ week: 15, day: 6, time: "12:30", reason: "转播调整" }),
    });
    expect(ok.status).toBe(200);
    const row = sqlite.prepare("SELECT kickoff_day, kickoff_time, kickoff_override, kickoff_reason FROM match WHERE id = 1").get();
    expect(row).toEqual({ kickoff_day: 6, kickoff_time: "12:30", kickoff_override: 1, kickoff_reason: "转播调整" });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'kickoff_patch'").get()).toEqual({ n: 1 });
  });

  it("已有赛果的场次不能改时刻", async () => {
    const { env } = freshEnv(true);
    const res = await call(env, "/api/admin/tournaments/13/matches/3/kickoff", {
      method: "PATCH",
      body: JSON.stringify({ week: 15, day: 6, time: "12:30" }),
    });
    expect(res.status).toBe(409);
  });

  it("清空可以一键把时刻抹掉", async () => {
    const { env, sqlite } = freshEnv();
    await call(env, "/api/admin/tournaments/13/matches/1/kickoff", {
      method: "PATCH",
      body: JSON.stringify({ week: 15, day: 6, time: "12:30" }),
    });
    const res = await call(env, "/api/admin/tournaments/13/matches/1/kickoff", {
      method: "PATCH",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(
      sqlite.prepare("SELECT kickoff_time, kickoff_override FROM match WHERE id = 1").get()
    ).toEqual({ kickoff_time: null, kickoff_override: 0 });
  });
});
