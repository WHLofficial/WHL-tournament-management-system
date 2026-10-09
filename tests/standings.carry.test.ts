// 循环赛阶段的带入积分（stage.config_json.carry）与阶段级扣分的对外口径：
// worker/lib/standings.ts 的带入计算 + 级联重建，以及 admin 侧两个端点。
// 钉六件事：
//   1) carriedPts = round(源阶段榜上的实际积分 × 倍率/100)：倍率是浮点百分比，源阶段的扣分会顺着带入下来
//   2) mode=points 时场次列只算本阶段；mode=record 把源阶段战绩叠进场次列（积分一律带入）
//   3) 链式带入：下游带的是上游「已含带入」的积分，上游改判/改扣分沿链级联
//   4) 来源解析：缺省取最近的上游循环赛阶段；显式 fromStage 必须更早且同为循环赛
//   5) 随时可改（已在开打也不套赛制锁），改完立刻重算
//   6) 参赛集收敛（配了 source 的循环赛阶段只列本阶段出场的队）与「没算过榜的阶段不凭空造榜」
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import app from "../worker/index";
import { applyMigrations, createTestD1, createTestKV, sqlAll, sqlGet } from "./d1";

type Env = Record<string, unknown>;

type StandingRow = {
  entryId: number;
  teamName: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  pts: number;
  pointsDeducted: number;
  carriedPts: number;
  rank: number;
};

type StageBoard = {
  stageId: number;
  kind: "group" | "round_robin";
  sortOrder: number;
  carry: {
    mode: string;
    multiplier: number;
    fromStageId: number;
    fromStageName: string | null;
  } | null;
  groups: { groupId: number | null; name: string; rows: StandingRow[] }[];
};

type StandingDbRow = {
  pts: number;
  played: number;
  carried_pts: number;
  deduct_pts: number;
};

// 赛事 8「联赛」纯循环赛，报名 600–605（与 standings.rebuild.test.ts 同一套编号）：
//   阶段 80 循环赛(sort 1) / 82 淘汰赛 / 83 排名赛(sort 3) / 85 总决赛循环(sort 4)
// 85 是本文件新增的，用来钉「链式带入」（83 从 80 带、85 再从 83 带）。
// 赛事 9「杯赛」的小组赛阶段 81 用来钉「小组赛不能带入」。
function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  sqlite
    .prepare(
      "INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(1, "超管", "", "x", "superadmin", 0, 0);

  const iso = "2026-02-01T00:00:00Z";
  const teams: [number, string][] = [
    [10, "甲队"],
    [11, "乙队"],
    [12, "丙队"],
    [13, "丁队"],
    [14, "戊队"],
    [15, "己队"],
  ];
  for (const [id, name] of teams) {
    sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (?, 1, ?, ?)").run(id, name, iso);
  }
  const t = sqlite.prepare(
    "INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (?, 1, ?, ?, 'running', 1, ?)"
  );
  t.run(8, "联赛", "round_robin", iso);
  t.run(9, "杯赛", "group_knockout", iso);

  const s = sqlite.prepare(
    "INSERT INTO stage (id, tournament_id, kind, sort_order, name) VALUES (?, ?, ?, ?, ?)"
  );
  s.run(80, 8, "round_robin", 1, "循环赛");
  s.run(82, 8, "elim", 2, "淘汰赛");
  s.run(83, 8, "round_robin", 3, "排名赛");
  s.run(85, 8, "round_robin", 4, "总决赛循环");
  s.run(81, 9, "group", 1, "小组赛");
  const g = sqlite.prepare('INSERT INTO "group" (id, stage_id, name, sort_order) VALUES (?, 81, ?, ?)');
  g.run(900, "A 组", 1);

  const e = sqlite.prepare(
    "INSERT INTO entry (id, tournament_id, team_id, seed, group_id) VALUES (?, ?, ?, ?, ?)"
  );
  let seed = 1;
  for (const teamId of [10, 11, 12, 13, 14, 15]) e.run(599 + seed, 8, teamId, seed, null), seed++;
  [10, 11].forEach((teamId, i) => e.run(810 + i, 9, teamId, i + 1, 900));

  const env: Env = {
    DB: createTestD1(sqlite),
    KV: createTestKV(new Map([["sess:tok-super", JSON.stringify({ userId: 1 })]])) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
  };
  return { env, sqlite };
}

const AUTH = { Cookie: "whl_session=tok-super", "Content-Type": "application/json" };

let nextMatchId = 900;
function addMatch(sqlite: DatabaseSync, stageId: number, home: number, away: number): number {
  const id = nextMatchId++;
  sqlite
    .prepare(
      `INSERT INTO match (id, stage_id, round, slot, leg, home_entry_id, away_entry_id, status, winner_entry_id, note, walkover_side)
       VALUES (?, ?, 1, 1, NULL, ?, ?, 'pending', NULL, NULL, '')`
    )
    .run(id, stageId, home, away);
  return id;
}

async function shoot(env: Env, matchId: number, home: number, away: number) {
  const res = await app.request(
    `/api/admin/matches/${matchId}/finish`,
    { method: "POST", headers: AUTH, body: JSON.stringify({ scoreHome: home, scoreAway: away }) },
    env
  );
  expect(res.status).toBe(200);
}

async function boards(env: Env, tid = 8): Promise<StageBoard[]> {
  const res = await app.request(`/api/admin/tournaments/${tid}/standings`, { headers: AUTH }, env);
  expect(res.status).toBe(200);
  return ((await res.json()) as { standings: StageBoard[] }).standings;
}

async function boardOf(env: Env, stageId: number, tid = 8): Promise<StageBoard | undefined> {
  return (await boards(env, tid)).find((s) => s.stageId === stageId);
}

const rowOf = (b: StageBoard | undefined, entryId: number): StandingRow | undefined =>
  (b?.groups ?? []).flatMap((g) => g.rows).find((r) => r.entryId === entryId);

const putCarry = (env: Env, stageId: number, carry: unknown, tid = 8) =>
  app.request(
    `/api/admin/tournaments/${tid}/stages/${stageId}/carry`,
    { method: "PUT", headers: AUTH, body: JSON.stringify({ carry }) },
    env
  );

const deduct = (env: Env, entryId: number, items: unknown[], tid = 8) =>
  app.request(
    `/api/admin/tournaments/${tid}/entries/${entryId}/deduction`,
    { method: "PATCH", headers: AUTH, body: JSON.stringify({ items }) },
    env
  );

const dbRow = (sqlite: DatabaseSync, entryId: number, stageId: number) =>
  sqlGet<StandingDbRow>(sqlite, "SELECT * FROM standing WHERE stage_id = ? AND entry_id = ?", stageId, entryId);

describe("带入积分：折算口径", () => {
  it("倍率折算进 pts，mode=points 场次列只算本阶段；改倍率立刻重算（开打后也不锁）", async () => {
    const { env, sqlite } = freshEnv();
    await shoot(env, addMatch(sqlite, 80, 600, 601), 3, 1); // 600 拿 3 分
    await shoot(env, addMatch(sqlite, 80, 602, 603), 0, 0); // 602/603 各 1 分

    expect((await putCarry(env, 83, { fromStage: 80, mode: "points", multiplier: 100 })).status).toBe(200);
    await shoot(env, addMatch(sqlite, 83, 600, 602), 2, 0); // 本阶段 600 再拿 3 分

    const b83 = await boardOf(env, 83);
    expect(b83!.carry).toEqual({
      mode: "points",
      multiplier: 100,
      fromStageId: 80,
      fromStageName: "循环赛",
    });
    expect(b83!.groups[0].rows).toHaveLength(6);
    expect(rowOf(b83, 600)).toMatchObject({
      carriedPts: 3,
      pts: 6,
      played: 1,
      won: 1,
      goalsFor: 2,
      goalsAgainst: 0,
    });
    expect(rowOf(b83, 602)).toMatchObject({
      carriedPts: 1,
      pts: 1,
      played: 1,
      lost: 1,
      goalsFor: 0,
      goalsAgainst: 2,
    });
    expect(rowOf(b83, 605)).toMatchObject({ carriedPts: 0, pts: 0, played: 0 });
    // 上游那张榜不受影响（带入是单向的）
    expect(rowOf(await boardOf(env, 80), 600)).toMatchObject({ pts: 3, carriedPts: 0 });

    // 浮点倍率：3 分 × 50.5% = 1.515 → 四舍五入 2 分；1 分 × 50.5% = 0.505 → 1 分
    expect((await putCarry(env, 83, { fromStage: 80, mode: "points", multiplier: 50.5 })).status).toBe(200);
    const b83b = await boardOf(env, 83);
    expect(rowOf(b83b, 600)).toMatchObject({ carriedPts: 2, pts: 5 });
    expect(rowOf(b83b, 602)).toMatchObject({ carriedPts: 1, pts: 1 });

    // 倍率 0：开关还开着但不折算（榜上不带入，模式注解仍在）
    await putCarry(env, 83, { fromStage: 80, mode: "points", multiplier: 0 });
    const b83c = await boardOf(env, 83);
    expect(b83c!.carry).toMatchObject({ multiplier: 0, fromStageId: 80 });
    expect(rowOf(b83c, 600)).toMatchObject({ carriedPts: 0, pts: 3 });
    expect(dbRow(sqlite, 600, 83)).toMatchObject({ pts: 3, carried_pts: 0 });
  });

  it("折算基数取源阶段榜上的实际积分：源阶段扣分会把带入一起打低", async () => {
    const { env, sqlite } = freshEnv();
    await shoot(env, addMatch(sqlite, 80, 600, 601), 3, 1); // 80 的 600 得 3 分
    expect((await deduct(env, 600, [{ points: 2, stageId: 80 }])).status).toBe(200);
    expect(rowOf(await boardOf(env, 80), 600)).toMatchObject({ pts: 1, pointsDeducted: 2 });

    // 基数 = 榜上那 1 分（而不是扣分前的 3 分）：1 × 150% = 1.5 → 2 分
    await putCarry(env, 83, { fromStage: 80, mode: "points", multiplier: 150 });
    await shoot(env, addMatch(sqlite, 83, 600, 602), 0, 0);
    const b83 = await boardOf(env, 83);
    expect(rowOf(b83, 600)).toMatchObject({ carriedPts: 2, pts: 3, played: 1, pointsDeducted: 0 });
  });

  it("mode=record：源阶段战绩叠加进场次列，积分照常带入；切回 points 立刻还原", async () => {
    const { env, sqlite } = freshEnv();
    await shoot(env, addMatch(sqlite, 80, 600, 601), 3, 1);
    await shoot(env, addMatch(sqlite, 80, 602, 603), 0, 0);
    expect((await putCarry(env, 83, { fromStage: 80, mode: "record", multiplier: 100 })).status).toBe(200);
    await shoot(env, addMatch(sqlite, 83, 600, 602), 2, 0);

    // 600：源 1 胜(3:1) + 本阶段 1 胜(2:0) → 2 战 2 胜，进 5 失 1
    expect(rowOf(await boardOf(env, 83), 600)).toMatchObject({
      carriedPts: 3,
      pts: 6,
      played: 2,
      won: 2,
      drawn: 0,
      lost: 0,
      goalsFor: 5,
      goalsAgainst: 1,
    });
    // 602：源 1 平(0:0) + 本阶段 1 负(0:2)
    expect(rowOf(await boardOf(env, 83), 602)).toMatchObject({
      carriedPts: 1,
      pts: 1,
      played: 2,
      won: 0,
      drawn: 1,
      lost: 1,
      goalsFor: 0,
      goalsAgainst: 2,
    });

    // 切回「仅积分」：场次列只剩本阶段，积分不变
    await putCarry(env, 83, { fromStage: 80, mode: "points", multiplier: 100 });
    expect(rowOf(await boardOf(env, 83), 600)).toMatchObject({
      played: 1,
      won: 1,
      goalsFor: 2,
      goalsAgainst: 0,
      carriedPts: 3,
      pts: 6,
    });
  });

  it("链式带入：下游带的是上游已含带入的积分；缺省来源取最近的上游循环赛阶段", async () => {
    const { env, sqlite } = freshEnv();
    await shoot(env, addMatch(sqlite, 80, 600, 601), 3, 1);
    await putCarry(env, 83, { fromStage: 80, mode: "points", multiplier: 100 });
    await shoot(env, addMatch(sqlite, 83, 600, 602), 2, 0);
    expect(rowOf(await boardOf(env, 83), 600)).toMatchObject({ carriedPts: 3, pts: 6 });

    // 85 不带 fromStage → 最近的上游循环赛阶段就是 83，带的是 83 的 6 分（含 83 自己带入的 3 分）
    expect((await putCarry(env, 85, { mode: "points", multiplier: 100 })).status).toBe(200);
    await shoot(env, addMatch(sqlite, 85, 600, 601), 1, 1);
    const b85 = await boardOf(env, 85);
    expect(b85!.carry).toEqual({
      mode: "points",
      multiplier: 100,
      fromStageId: 83,
      fromStageName: "排名赛",
    });
    expect(rowOf(b85, 600)).toMatchObject({ carriedPts: 6, pts: 7, played: 1, drawn: 1 });
  });
});

describe("带入积分：端点校验与清空", () => {
  it("来源与参数校验：非循环赛阶段、非更早阶段、坏倍率都挡在写库之前", async () => {
    const { env, sqlite } = freshEnv();
    // 第一个循环赛阶段没有更早的循环赛阶段可带
    expect((await putCarry(env, 80, { mode: "points", multiplier: 100 })).status).toBe(400);
    // 淘汰赛 / 小组赛阶段没有积分榜
    expect((await putCarry(env, 82, { fromStage: 80, mode: "points", multiplier: 100 })).status).toBe(400);
    expect((await putCarry(env, 81, { fromStage: 80, mode: "points", multiplier: 100 }, 9)).status).toBe(400);
    // 来源必须同为循环赛（淘汰赛/小组赛）、必须排在本阶段之前、必须在同一赛事
    expect((await putCarry(env, 83, { fromStage: 82, mode: "points", multiplier: 100 })).status).toBe(400);
    expect((await putCarry(env, 83, { fromStage: 85, mode: "points", multiplier: 100 })).status).toBe(400);
    expect((await putCarry(env, 83, { fromStage: 81, mode: "points", multiplier: 100 })).status).toBe(400);
    // 倍率：只要求有限且非负（浮点可以，负数/非数字不行）；方式只有两档
    expect((await putCarry(env, 83, { fromStage: 80, mode: "points", multiplier: -0.5 })).status).toBe(400);
    expect((await putCarry(env, 83, { fromStage: 80, mode: "points", multiplier: "abc" })).status).toBe(400);
    expect((await putCarry(env, 83, { fromStage: 80, mode: "avg", multiplier: 100 })).status).toBe(400);
    // 阶段不存在 / 不属于本赛事
    expect((await putCarry(env, 999, { mode: "points", multiplier: 100 })).status).toBe(404);
    // 校验失败的都没写库
    expect(sqlAll(sqlite, "SELECT id FROM stage WHERE config_json LIKE '%carry%'")).toEqual([]);
  });

  it("清空（carry: null）删掉配置键，榜上的带入分与注解一起归零", async () => {
    const { env, sqlite } = freshEnv();
    await shoot(env, addMatch(sqlite, 80, 600, 601), 3, 1);
    await putCarry(env, 83, { fromStage: 80, mode: "points", multiplier: 100 });
    await shoot(env, addMatch(sqlite, 83, 600, 602), 2, 0);
    expect(rowOf(await boardOf(env, 83), 600)).toMatchObject({ carriedPts: 3, pts: 6 });

    const res = await putCarry(env, 83, null);
    expect(res.status).toBe(200);
    expect((await res.json()) as { carry: unknown }).toMatchObject({ carry: null });

    const cfg = sqlGet<{ config_json: string }>(sqlite, "SELECT config_json FROM stage WHERE id = 83")!;
    expect(Object.hasOwn(JSON.parse(cfg.config_json) as object, "carry")).toBe(false);
    const b = await boardOf(env, 83);
    expect(b!.carry).toBeNull();
    expect(rowOf(b, 600)).toMatchObject({ carriedPts: 0, pts: 3 });
  });
});

describe("带入积分：级联与参赛集", () => {
  it("上游改判/改扣分沿链级联（折算基数取源阶段榜上的实际积分）", async () => {
    const { env, sqlite } = freshEnv();
    const m80 = addMatch(sqlite, 80, 600, 601);
    await shoot(env, m80, 3, 1);
    await putCarry(env, 83, { fromStage: 80, mode: "points", multiplier: 100 });
    await putCarry(env, 85, { mode: "points", multiplier: 100 });
    await shoot(env, addMatch(sqlite, 83, 600, 602), 2, 0);
    await shoot(env, addMatch(sqlite, 85, 600, 601), 0, 0);
    expect(rowOf(await boardOf(env, 85), 600)).toMatchObject({ carriedPts: 6, pts: 7 });

    // 上游改判 3:1 → 1:1：80 剩 1 分，83 带入 1（本阶段 3 分），85 再带 83 的 4 分
    await shoot(env, m80, 1, 1);
    expect(rowOf(await boardOf(env, 80), 600)).toMatchObject({ pts: 1, carriedPts: 0 });
    expect(rowOf(await boardOf(env, 83), 600)).toMatchObject({ carriedPts: 1, pts: 4 });
    expect(rowOf(await boardOf(env, 85), 600)).toMatchObject({ carriedPts: 4, pts: 5 });

    // 阶段 80 扣 2 分：80 的榜掉到 -1，带入基数就是榜上的实际积分 → 83 带入 -1（本阶段 3 分）→ 85 再带 83 的 2 分
    expect((await deduct(env, 600, [{ points: 2, stageId: 80 }])).status).toBe(200);
    expect(rowOf(await boardOf(env, 80), 600)).toMatchObject({ pts: -1, pointsDeducted: 2 });
    expect(rowOf(await boardOf(env, 83), 600)).toMatchObject({ carriedPts: -1, pts: 2 });
    expect(rowOf(await boardOf(env, 85), 600)).toMatchObject({ carriedPts: 2, pts: 3 });

    // 全赛事扣分（stage_id NULL）：每张榜各扣一次；80 归 0 → 下游带入跟着归 0
    expect((await deduct(env, 600, [{ points: 1, stageId: null }])).status).toBe(200);
    expect(rowOf(await boardOf(env, 83), 600)).toMatchObject({
      carriedPts: 0,
      pts: 2,
      pointsDeducted: 1,
    });
    expect(dbRow(sqlite, 600, 80)).toMatchObject({ carried_pts: 0, deduct_pts: 1 });
    expect(dbRow(sqlite, 600, 83)).toMatchObject({ carried_pts: 0, deduct_pts: 1 });
    // 阶段 80 专属的那条扣分被整表替换掉了，只剩全赛事这 1 分
    expect(dbRow(sqlite, 600, 80)!.pts).toBe(0);
  });

  it("参与集收敛：配了 source 的循环赛阶段只列本阶段出场的队；场次清空后回退全量", async () => {
    const { env, sqlite } = freshEnv();
    await shoot(env, addMatch(sqlite, 80, 600, 601), 3, 1);
    await shoot(env, addMatch(sqlite, 80, 602, 603), 0, 0);
    await shoot(env, addMatch(sqlite, 83, 600, 602), 2, 0);
    expect((await boardOf(env, 83))!.groups[0].rows).toHaveLength(6);

    // 编排页给 83 配了「从上游取人」：参赛集收敛为本阶段场次里出现过的队
    sqlite
      .prepare("UPDATE stage SET config_json = ? WHERE id = 83")
      .run(JSON.stringify({ source: { take: 4 } }));
    await putCarry(env, 83, { fromStage: 80, mode: "points", multiplier: 100 });
    const narrowed = await boardOf(env, 83);
    expect(narrowed!.groups[0].rows.map((r) => r.entryId).sort((a, b) => a - b)).toEqual([600, 602]);
    expect(rowOf(narrowed, 600)).toMatchObject({ carriedPts: 3, pts: 6 });
    // 没配 source 的阶段照旧全量
    expect((await boardOf(env, 80))!.groups[0].rows).toHaveLength(6);

    // 「配了 source 但场次被清空」的中间态：接口不允许删已完赛场次，这里直接改库模拟，
    // 期望参赛集回退全量（榜上只剩带入分），不至于显示一张空榜
    sqlite.prepare("DELETE FROM match WHERE stage_id = 83").run();
    await putCarry(env, 83, { fromStage: 80, mode: "points", multiplier: 100 });
    const fallback = await boardOf(env, 83);
    expect(fallback!.groups[0].rows).toHaveLength(6);
    expect(rowOf(fallback, 600)).toMatchObject({ carriedPts: 3, pts: 3, played: 0 });
  });

  it("没算过榜的阶段不会因为配带入/扣分凭空冒出一张全 0 榜", async () => {
    const { env, sqlite } = freshEnv();
    expect((await putCarry(env, 83, { fromStage: 80, mode: "points", multiplier: 100 })).status).toBe(200);
    expect((await deduct(env, 600, [{ points: 5, stageId: 85 }])).status).toBe(200);

    expect((await boards(env)).map((s) => s.stageId)).toEqual([]);
    expect(sqlAll(sqlite, "SELECT id FROM standing")).toEqual([]);
  });
});

describe("迁移 0027：存量扣分回填成记录表", () => {
  const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  it("entry.points_deducted 搬成 stage_id IS NULL 的记录并置 0，standing 补两列", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    // 先停在 0026：这样 0027 是单独执行的，能真实走一遍「老库升级」路径
    for (const f of files) {
      if (f.startsWith("0027_")) continue;
      sqlite.exec(readFileSync(dir + f, "utf8"));
    }
    const iso = "2026-02-01T00:00:00Z";
    sqlite
      .prepare(
        "INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (1, '超管', '', 'x', 'superadmin', 0, 0)"
      )
      .run();
    sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (10, 1, '甲队', ?)").run(iso);
    sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (11, 1, '乙队', ?)").run(iso);
    sqlite
      .prepare(
        "INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (8, 1, '联赛', 'round_robin', 'running', 1, ?)"
      )
      .run(iso);
    sqlite
      .prepare("INSERT INTO stage (id, tournament_id, kind, sort_order, name) VALUES (80, 8, 'round_robin', 1, '循环赛')")
      .run();
    const e = sqlite.prepare(
      "INSERT INTO entry (id, tournament_id, team_id, seed, group_id, points_deducted) VALUES (?, 8, ?, ?, NULL, ?)"
    );
    e.run(600, 10, 1, 7);
    e.run(601, 11, 2, 0);
    // 老库里的榜：pts 已经是「扣过分」的净值（旧代码写 r.pts - points_deducted），deduct_pts 还不存在
    const st = sqlite.prepare(
      "INSERT INTO standing (stage_id, group_id, entry_id, played, won, drawn, lost, pts, gf, ga, pen_won, pen_lost) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)"
    );
    st.run(80, 600, 3, 2, 0, 1, 3, 4, 3);
    st.run(80, 601, 3, 0, 1, 2, 1, 2, 5);

    sqlite.exec(readFileSync(dir + "0027_stage_carry_and_deduction.sql", "utf8"));

    expect(sqlAll(sqlite, "SELECT entry_id, stage_id, points FROM points_deduction")).toEqual([
      { entry_id: 600, stage_id: null, points: 7 },
    ]);
    expect(
      sqlGet<{ points_deducted: number }>(sqlite, "SELECT points_deducted FROM entry WHERE id = 600")!
        .points_deducted
    ).toBe(0);
    // 存量榜补上 deduct_pts（pts 保持净值不动），否则榜上「−N」标记会消失
    expect(
      sqlGet<{ pts: number; deduct_pts: number; carried_pts: number }>(
        sqlite,
        "SELECT pts, deduct_pts, carried_pts FROM standing WHERE stage_id = 80 AND entry_id = 600"
      )
    ).toEqual({ pts: 3, deduct_pts: 7, carried_pts: 0 });
    expect(
      sqlGet<{ deduct_pts: number }>(
        sqlite,
        "SELECT deduct_pts FROM standing WHERE stage_id = 80 AND entry_id = 601"
      )!.deduct_pts
    ).toBe(0);
    const cols = sqlAll<{ name: string }>(sqlite, "PRAGMA table_info(standing)").map((c) => c.name);
    expect(cols).toContain("carried_pts");
    expect(cols).toContain("deduct_pts");
  });
});
