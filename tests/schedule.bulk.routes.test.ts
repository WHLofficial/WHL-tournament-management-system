// 管理端批量落场守卫（v5.0.2）：原来逐场调 guardMatch（每场 4 条串行查询，
// 24 场 ≈ 96 条串行 ≈ 19s），改成整批 2 条查询后在内存判定。
// 这里钉住批量化没有改变任何一条判定规则，以及「任一不过整批拒、不留半截写入」。
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { applyMigrations, createTestD1, createTestKV, sqlGet } from "./d1";

function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  sqlite
    .prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(1, "管理员", "", "x", "admin", 0, 0);

  const iso = "2026-01-01T00:00:00Z";
  for (const [id, name] of [[10, "红队"], [11, "蓝队"], [12, "黄队"], [13, "绿队"], [14, "黑队"], [15, "白队"]] as const) {
    sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (?, 1, ?, ?)").run(id, name, iso);
  }
  sqlite
    .prepare("INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (7, 1, '联赛', 'round_robin', 'running', 1, ?)")
    .run(iso);
  const s = sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order, name) VALUES (?, 7, ?, 1, ?)");
  s.run(70, "round_robin", "循环赛");
  s.run(71, "group", "小组赛");
  s.run(72, "elim", "淘汰赛");
  const g = sqlite.prepare('INSERT INTO "group" (id, stage_id, name, sort_order) VALUES (?, 71, ?, ?)');
  g.run(900, "A 组", 1);
  g.run(901, "B 组", 2);
  const e = sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed, group_id) VALUES (?, 7, ?, ?, ?)");
  e.run(500, 10, 1, 900);
  e.run(501, 11, 2, 900);
  e.run(502, 12, 3, 901);
  e.run(503, 13, 4, 901);
  e.run(504, 14, 5, 901);
  e.run(505, 15, 6, 901);

  const env: Record<string, unknown> = {
    DB: createTestD1(sqlite),
    KV: createTestKV(new Map([["sess:tok-admin", JSON.stringify({ userId: 1 })]])) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
  };
  return { env, sqlite };
}

const post = (env: Record<string, unknown>, path: string, body: unknown) =>
  app.request(
    path,
    {
      method: "POST",
      headers: { Cookie: "whl_session=tok-admin", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );

const bulk = (env: Record<string, unknown>, pairs: unknown, round = 1, stageId = 70) =>
  post(env, `/api/admin/tournaments/7/stages/${stageId}/matches/bulk`, { round, pairs });

const pair = (homeEntryId: number, awayEntryId: number) => ({ homeEntryId, awayEntryId });

const countMatches = (sqlite: DatabaseSync, stageId: number) =>
  sqlGet<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM match WHERE stage_id = ?", stageId)!.n;

describe("管理端批量落场", () => {
  it("两场都合规时一次落库，slot 依次递增", async () => {
    const { env, sqlite } = freshEnv();
    const res = await bulk(env, [pair(500, 501), pair(502, 503)]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, created: 2, round: 1 });
    const rows = sqlite
      .prepare("SELECT slot, home_entry_id, away_entry_id FROM match WHERE stage_id = 70 ORDER BY slot")
      .all() as unknown as { slot: number; home_entry_id: number; away_entry_id: number }[];
    expect(rows).toEqual([
      { slot: 1, home_entry_id: 500, away_entry_id: 501 },
      { slot: 2, home_entry_id: 502, away_entry_id: 503 },
    ]);
  });

  it("批内同一支队出现两次：拒第 2 场（批内互斥先于整批守卫）", async () => {
    const { env, sqlite } = freshEnv();
    const res = await bulk(env, [pair(500, 501), pair(500, 502)]);
    expect(res.status).toBe(400);
    const { message } = (await res.json()) as { message: string };
    expect(message).toContain("第 2 场");
    expect(message).toContain("已在本批第 1 场出场");
    expect(countMatches(sqlite, 70)).toBe(0);
  });

  it("本轮已有其中一支球队的比赛：报出场次且整批不落库", async () => {
    const { env, sqlite } = freshEnv();
    sqlite
      .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status) VALUES (800, 70, 1, 1, 500, 501, 'pending')")
      .run();
    const res = await bulk(env, [pair(502, 503), pair(500, 504)]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe("第 2 场：本轮已有其中一支球队的比赛");
    expect(countMatches(sqlite, 70)).toBe(1); // 只有夹具那场，没有半截写入
  });

  it("两队在本阶段已交手过（loops=1）：拒；改成双循环后放行", async () => {
    const { env, sqlite } = freshEnv();
    sqlite
      .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status) VALUES (800, 70, 1, 1, 500, 501, 'finished')")
      .run();
    // 注意主客对调也算同一对
    const denied = await bulk(env, [pair(501, 500), pair(502, 503)], 2);
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { message: string }).message).toBe("第 1 场：两队在本阶段已交手过");

    sqlite.prepare("UPDATE stage SET config_json = '{\"loops\":2}' WHERE id = 70").run();
    const ok = await bulk(env, [pair(501, 500), pair(502, 503)], 2);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, created: 2, round: 2 });
  });

  it("小组赛跨组：拒", async () => {
    const { env } = freshEnv();
    const res = await bulk(env, [pair(500, 502), pair(501, 503)], 1, 71);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe("第 1 场：小组赛只能在同组球队之间落场");
  });

  it("参赛队伍不存在（entry 不属于本赛事）：拒", async () => {
    const { env } = freshEnv();
    const res = await bulk(env, [pair(500, 999), pair(502, 503)], 1);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe("第 1 场：参赛队伍不存在");
  });

  it("淘汰赛阶段不支持批量手动落场，指引到落位端点", async () => {
    const { env } = freshEnv();
    const res = await bulk(env, [pair(500, 501), pair(502, 503)], 1, 72);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe("第 1 场：淘汰赛请在赛程页逐场点选落位");
  });

  it("单场路由仍按旧口径分流：本轮/交手冲突回 409，其余 400；成功回 201", async () => {
    const { env, sqlite } = freshEnv();
    sqlite
      .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status) VALUES (800, 70, 1, 1, 500, 501, 'pending')")
      .run();
    const conflict = await post(env, "/api/admin/tournaments/7/stages/70/matches", {
      round: 1,
      homeEntryId: 501,
      awayEntryId: 502,
    });
    expect(conflict.status).toBe(409);

    const bad = await post(env, "/api/admin/tournaments/7/stages/70/matches", {
      round: 1,
      homeEntryId: 500,
      awayEntryId: 999,
    });
    expect(bad.status).toBe(400);

    const created = await post(env, "/api/admin/tournaments/7/stages/70/matches", {
      round: 2,
      homeEntryId: 502,
      awayEntryId: 503,
    });
    expect(created.status).toBe(201);
  });
});

describe("跨轮整批保存（PUT matches/batch）", () => {
  const put = (env: Record<string, unknown>, path: string, body: unknown) =>
    app.request(
      path,
      {
        method: "PUT",
        headers: { Cookie: "whl_session=tok-admin", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
  const saveBatch = (env: Record<string, unknown>, body: unknown, stageId = 70) =>
    put(env, `/api/admin/tournaments/7/stages/${stageId}/matches/batch`, body);
  const seedMatch = (
    sqlite: DatabaseSync,
    id: number,
    round: number,
    slot: number,
    home: number,
    away: number,
    status = "pending",
  ) =>
    sqlite
      .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status) VALUES (?, 70, ?, ?, ?, ?, ?)")
      .run(id, round, slot, home, away, status);
  const rowsOf = (sqlite: DatabaseSync) =>
    sqlite
      .prepare("SELECT id, round, slot, home_entry_id, away_entry_id FROM match WHERE stage_id = 70 ORDER BY round, slot")
      .all() as unknown as Array<{ id: number; round: number; slot: number; home_entry_id: number; away_entry_id: number }>;

  it("跨轮 adds 一次落库，slot 按轮各自续号", async () => {
    const { env, sqlite } = freshEnv();
    seedMatch(sqlite, 800, 1, 1, 500, 501);
    const res = await saveBatch(env, {
      adds: [
        { round: 1, homeEntryId: 502, awayEntryId: 503 },
        { round: 2, homeEntryId: 500, awayEntryId: 502 },
        { round: 2, homeEntryId: 501, awayEntryId: 503 },
      ],
      deleteIds: [],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, created: 3, deleted: 0 });
    expect(rowsOf(sqlite)).toEqual([
      { id: 800, round: 1, slot: 1, home_entry_id: 500, away_entry_id: 501 },
      { id: expect.any(Number), round: 1, slot: 2, home_entry_id: 502, away_entry_id: 503 },
      { id: expect.any(Number), round: 2, slot: 1, home_entry_id: 500, away_entry_id: 502 },
      { id: expect.any(Number), round: 2, slot: 2, home_entry_id: 501, away_entry_id: 503 },
    ]);
  });

  it("批内互斥：同轮一队只允许一场", async () => {
    const { env, sqlite } = freshEnv();
    const res = await saveBatch(env, {
      adds: [
        { round: 1, homeEntryId: 500, awayEntryId: 501 },
        { round: 1, homeEntryId: 501, awayEntryId: 502 },
      ],
      deleteIds: [],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: "第 2 场：该队已在本批第 1 场出场" });
    expect(countMatches(sqlite, 70)).toBe(0);
  });

  it("loops=1 同对跨轮两场 → 整批拒绝", async () => {
    const { env, sqlite } = freshEnv();
    const res = await saveBatch(env, {
      adds: [
        { round: 1, homeEntryId: 500, awayEntryId: 501 },
        { round: 2, homeEntryId: 501, awayEntryId: 500 },
      ],
      deleteIds: [],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: "第 1 场：两队在本阶段已交手过" });
    expect(countMatches(sqlite, 70)).toBe(0);
  });

  it("删除校验：pending 删得掉；不在阶段 400；已开打 409；重复 400", async () => {
    const { env, sqlite } = freshEnv();
    seedMatch(sqlite, 800, 1, 1, 500, 501);

    const ghost = await saveBatch(env, { adds: [], deleteIds: [999] });
    expect(ghost.status).toBe(400);
    expect(await ghost.json()).toEqual({ message: "要删除的比赛 #999 不在该阶段" });

    sqlite
      .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status) VALUES (801, 70, 1, 2, 502, 503, 'live')")
      .run();
    const live = await saveBatch(env, { adds: [], deleteIds: [801] });
    expect(live.status).toBe(409);
    expect(await live.json()).toEqual({ message: "只有未开打的比赛可以删除" });

    const dup = await saveBatch(env, { adds: [], deleteIds: [800, 800] });
    expect(dup.status).toBe(400);
    expect(await dup.json()).toEqual({ message: "待删除的场次有重复" });

    const ok = await saveBatch(env, { adds: [], deleteIds: [800] });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, created: 0, deleted: 1 });
    expect(countMatches(sqlite, 70)).toBe(1);
  });

  it("删 + 增混合：同轮释放占用重排，删了再排同一对也放行", async () => {
    const { env, sqlite } = freshEnv();
    seedMatch(sqlite, 800, 1, 1, 500, 501);
    const res = await saveBatch(env, {
      adds: [{ round: 1, homeEntryId: 500, awayEntryId: 502 }],
      deleteIds: [800],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, created: 1, deleted: 1 });
    expect(rowsOf(sqlite)).toEqual([
      { id: expect.any(Number), round: 1, slot: 1, home_entry_id: 500, away_entry_id: 502 },
    ]);

    sqlite.prepare("DELETE FROM match").run();
    seedMatch(sqlite, 810, 1, 1, 500, 501);
    const same = await saveBatch(env, {
      adds: [{ round: 1, homeEntryId: 500, awayEntryId: 501 }],
      deleteIds: [810],
    });
    expect(same.status).toBe(200);
    expect(rowsOf(sqlite)).toEqual([
      { id: expect.any(Number), round: 1, slot: 1, home_entry_id: 500, away_entry_id: 501 },
    ]);
  });

  it("形状守卫：缺数组 / 双空 / 超限 / 轮次非法", async () => {
    const { env, sqlite } = freshEnv();

    const missing = await saveBatch(env, { adds: [] });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ message: "请提供 adds 与 deleteIds 数组" });

    const empty = await saveBatch(env, { adds: [], deleteIds: [] });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ message: "没有要保存的改动" });

    const overflow = await saveBatch(env, {
      adds: Array.from({ length: 65 }, () => ({ round: 1, homeEntryId: 500, awayEntryId: 501 })),
      deleteIds: [],
    });
    expect(overflow.status).toBe(400);
    expect(await overflow.json()).toEqual({ message: "一次最多保存 96 条改动（新增 64 场 + 删除 32 场），请分批保存" });

    const badRound = await saveBatch(env, {
      adds: [{ round: 0, homeEntryId: 500, awayEntryId: 501 }],
      deleteIds: [],
    });
    expect(badRound.status).toBe(400);
    expect(await badRound.json()).toEqual({ message: "第 1 场：轮次必须是正整数" });
    expect(countMatches(sqlite, 70)).toBe(0);
  });

  it("阶段类型守卫：跨组 400、淘汰赛 400", async () => {
    const { env, sqlite } = freshEnv();

    const cross = await saveBatch(env, { adds: [{ round: 1, homeEntryId: 500, awayEntryId: 502 }], deleteIds: [] }, 71);
    expect(cross.status).toBe(400);
    expect(await cross.json()).toEqual({ message: "第 1 场：小组赛只能在同组球队之间落场" });

    const elim = await saveBatch(env, { adds: [{ round: 1, homeEntryId: 500, awayEntryId: 501 }], deleteIds: [] }, 72);
    expect(elim.status).toBe(400);
    expect(await elim.json()).toEqual({ message: "淘汰赛请在赛程页增删场次" });
    expect(countMatches(sqlite, 70)).toBe(0);
  });
});
