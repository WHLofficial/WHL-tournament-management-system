// 淘汰赛空席位占位（T6）与管理端出线名单（T7）：
//   公开 GET /api/public/tournaments/:id/matches?stageId=… → MatchDTO.homePlaceholder/awayPlaceholder
//   管理 GET /api/admin/tournaments/:id/matches            → { matches, qualifiers }
// 占位口径（spec §3.5）：后续轮取上一轮两个来源场次的队名「/」连接（季军赛取两场半决赛）；
// 首轮按来源阶段名次——跨组模板命中列队名、未命中列「A 组第 N」，取人区间 ≤2 支列队名、
// >2 支列「<阶段名> 第 a–b 名」；轮空行与非空席位都不下发（前端回退「待定」）。
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { applyMigrations, createTestD1, createTestKV } from "./d1";

// 公开端路由挂了 pubCache（caches.default + executionCtx.waitUntil），测试环境补最小桩；
// match 恒 undefined ⇒ 每次都是冷路径，断言的是真实查询结果。
(globalThis as unknown as { caches: unknown }).caches = {
  default: { match: async () => undefined, put: async () => {} },
};
const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

const ISO = "2026-01-01T00:00:00Z";
const AUTH = { Cookie: "whl_session=tok-admin", "Content-Type": "application/json" };
type Env = Record<string, unknown>;
type MatchDto = {
  id: number;
  stageId: number;
  round: number;
  slot: number;
  leg: number | null;
  homeTeamName: string | null;
  awayTeamName: string | null;
  note: string | null;
  homePlaceholder?: string | null;
  awayPlaceholder?: string | null;
};

const pub = (env: Env, path: string) => app.request(path, {}, env, execCtx as never);
const adm = (env: Env, path: string) => app.request(path, { headers: AUTH }, env, execCtx as never);
const post = (env: Env, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: AUTH, body: JSON.stringify(body) }, env);
const put = (env: Env, path: string, body: unknown) =>
  app.request(path, { method: "PUT", headers: AUTH, body: JSON.stringify(body) }, env);

const slotsPath = (stageId: number) => `/api/admin/tournaments/60/stages/${stageId}/slots`;
const addSlot = (env: Env, stageId: number) => post(env, slotsPath(stageId), {});
const place = (env: Env, stageId: number, slot: number, home: number | null, away: number | null) =>
  put(env, `${slotsPath(stageId)}/${slot}`, { homeEntryId: home, awayEntryId: away });

// 赛事 60（group_knockout）：来源小组赛 601（A 组 北京/上海、B 组 广州/深圳），
// 淘汰赛 600（跨组模板）、淘汰赛 602（取人区间）
function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  sqlite
    .prepare(
      "INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (1, '管理员', '', 'x', 'admin', 0, 0)"
    )
    .run();
  const teams: [number, string][] = [
    [40, "北京"],
    [41, "上海"],
    [42, "广州"],
    [43, "深圳"],
  ];
  for (const [id, name] of teams) {
    sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (?, 1, ?, ?)").run(id, name, ISO);
  }
  sqlite
    .prepare(
      "INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (60, 1, '测试杯', 'group_knockout', 'running', 1, ?)"
    )
    .run(ISO);

  const mkStage = (id: number, kind: string, sortOrder: number, name: string, config: Record<string, unknown>) =>
    sqlite
      .prepare("INSERT INTO stage (id, tournament_id, kind, sort_order, name, config_json) VALUES (?, 60, ?, ?, ?, ?)")
      .run(id, kind, sortOrder, name, JSON.stringify(config));
  mkStage(601, "group", 1, "小组赛", { group_count: 2, group_size: 2, qualify_per_group: 2 });
  sqlite.prepare('INSERT INTO "group" (id, stage_id, name, sort_order) VALUES (1, 601, ?, 0)').run("A");
  sqlite.prepare('INSERT INTO "group" (id, stage_id, name, sort_order) VALUES (2, 601, ?, 1)').run("B");

  const mkEntry = (id: number, teamId: number, seed: number, groupId: number) =>
    sqlite
      .prepare("INSERT INTO entry (id, tournament_id, team_id, seed, group_id) VALUES (?, 60, ?, ?, ?)")
      .run(id, teamId, seed, groupId);
  mkEntry(600, 40, 1, 1);
  mkEntry(601, 41, 2, 1);
  mkEntry(602, 42, 3, 2);
  mkEntry(603, 43, 4, 2);

  // 小组名次：A 组 北京(6 分) > 上海(3 分)；B 组 广州(6 分) > 深圳(3 分)
  const mkStanding = (entryId: number, groupId: number, pts: number) =>
    sqlite
      .prepare("INSERT INTO standing (stage_id, group_id, entry_id, played, won, pts) VALUES (601, ?, ?, 2, 2, ?)")
      .run(groupId, entryId, pts);
  mkStanding(600, 1, 6);
  mkStanding(601, 1, 3);
  mkStanding(602, 2, 6);
  mkStanding(603, 2, 3);

  // 来源阶段必须全部完赛名次才作数（与赛程生成 takeRangePool 同口径）
  const mkFinished = (id: number, slot: number, home: number, away: number) =>
    sqlite
      .prepare(
        "INSERT INTO match (id, stage_id, round, slot, leg, home_entry_id, away_entry_id, score_home, score_away, status, winner_entry_id) VALUES (?, 601, 1, ?, NULL, ?, ?, 2, 0, 'finished', ?)"
      )
      .run(id, slot, home, away, home);
  mkFinished(9001, 1, 600, 601);
  mkFinished(9002, 2, 602, 603);

  mkStage(600, "elim", 2, "淘汰赛", { legs: 1, source: { fromStage: 601, cross: ["A1-B2", "B1-A2"] } });
  mkStage(602, "elim", 3, "排位赛", { legs: 1, source: { fromStage: 601, from: 2, to: 3 } });
  mkStage(603, "elim", 4, "两回合淘汰赛", { legs: 2, source: { fromStage: 601, cross: ["A1-B2", "B1-A2"] } });

  const env: Env = {
    DB: createTestD1(sqlite),
    KV: createTestKV(new Map([["sess:tok-admin", JSON.stringify({ userId: 1 })]])) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
  };
  return { env, sqlite };
}

async function publicMatches(env: Env, stageId: number): Promise<MatchDto[]> {
  const res = await pub(env, `/api/public/tournaments/60/matches?stageId=${stageId}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { matches: MatchDto[] }).matches;
}

describe("淘汰赛空席位占位（公开赛程）", () => {
  it("首轮跨组模板：命中名次列队名，未命中列「A 组第 N」", async () => {
    const { env, sqlite } = freshEnv();
    // 加一个未命中的组字母 token（C 组不存在），钉住回退文案
    sqlite
      .prepare("UPDATE stage SET config_json = ? WHERE id = 600")
      .run(JSON.stringify({ legs: 1, source: { fromStage: 601, cross: ["A1-B2", "C1-A1"] } }));
    await addSlot(env, 600);
    await addSlot(env, 600);

    let rows = await publicMatches(env, 600);
    const ph = (r: MatchDto) => [r.slot, r.homePlaceholder ?? null, r.awayPlaceholder ?? null];
    expect(rows.filter((r) => r.round === 1).map(ph)).toEqual([
      [1, "北京", "深圳"], // A1 - B2
      [2, "C 组第 1", "北京"], // C1 无此组 → 组字母 + 名次；A1 命中
    ]);

    // 落位后该场次不再下发占位（非空席位）
    expect((await place(env, 600, 1, 600, 601)).status).toBe(200);
    rows = await publicMatches(env, 600);
    const slot1 = rows.find((r) => r.round === 1 && r.slot === 1)!;
    expect(slot1.homeTeamName).toBe("北京");
    expect(slot1.homePlaceholder ?? null).toBeNull();
    expect(slot1.awayPlaceholder ?? null).toBeNull();
    // 另一场次不受影响
    expect(rows.find((r) => r.round === 1 && r.slot === 2)!.homePlaceholder).toBe("C 组第 1");

    // 轮空行不铺占位（away 空着也不给候选）
    expect((await place(env, 600, 2, 602, null)).status).toBe(200);
    rows = await publicMatches(env, 600);
    const bye = rows.find((r) => r.round === 1 && r.slot === 2)!;
    expect(bye.note).toBe("轮空");
    expect(bye.awayPlaceholder ?? null).toBeNull();
  });

  it("首轮取人区间：≤2 支列队名，>2 支列「<阶段名> 第 a–b 名」", async () => {
    const { env, sqlite } = freshEnv();
    await addSlot(env, 602);
    await addSlot(env, 602);

    // 全池取人顺序（组内名次优先 → 积分 → 种子位）：北京 广州 上海 深圳
    let rows = await publicMatches(env, 602);
    expect(rows.filter((r) => r.round === 1).map((r) => [r.slot, r.homePlaceholder, r.awayPlaceholder])).toEqual([
      [1, "广州/上海", "广州/上海"], // 第 2–3 名（2 支 → 列队名）
      [2, "广州/上海", "广州/上海"],
    ]);

    sqlite
      .prepare("UPDATE stage SET config_json = ? WHERE id = 602")
      .run(JSON.stringify({ legs: 1, source: { fromStage: 601, from: 1, to: 4 } }));
    rows = await publicMatches(env, 602);
    expect(rows.filter((r) => r.round === 1).map((r) => [r.slot, r.homePlaceholder, r.awayPlaceholder])).toEqual([
      [1, "小组赛 第 1–4 名", "小组赛 第 1–4 名"],
      [2, "小组赛 第 1–4 名", "小组赛 第 1–4 名"],
    ]);
  });

  it("后续轮占位：上一轮两队队名「/」连接；季军赛取两场半决赛", async () => {
    const { env, sqlite } = freshEnv();
    sqlite
      .prepare("UPDATE stage SET config_json = ? WHERE id = 600")
      .run(JSON.stringify({ legs: 1, third_place: true, source: { fromStage: 601, cross: ["A1-B2", "B1-A2"] } }));
    await addSlot(env, 600);
    await addSlot(env, 600);
    expect((await place(env, 600, 1, 600, 601)).status).toBe(200);
    expect((await place(env, 600, 2, 602, 603)).status).toBe(200);

    const rows = await publicMatches(env, 600);
    // 首轮两场都落满 → 无占位
    expect(rows.filter((r) => r.round === 1).every((r) => !r.homePlaceholder && !r.awayPlaceholder)).toBe(true);
    // 决赛与季军赛：来源 = 第 1 轮两场的参赛队
    expect(rows.filter((r) => r.round === 2).map((r) => [r.slot, r.note, r.homePlaceholder, r.awayPlaceholder])).toEqual([
      [1, null, "北京/上海", "广州/深圳"],
      [2, "季军赛", "北京/上海", "广州/深圳"],
    ]);
  });
});

describe("管理端出线名单（qualifiers）", () => {
  it("cross 按 token 顺序去重；range 按取人顺序；非淘汰赛阶段不给键", async () => {
    const { env } = freshEnv();
    const res = await adm(env, "/api/admin/tournaments/60/matches");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { qualifiers?: Record<string, number[]> };
    // A1-B2,B1-A2 → 北京、深圳、广州、上海；603（两回合，同模板）同样命中
    expect(body.qualifiers).toEqual({
      "600": [600, 603, 602, 601],
      "602": [602, 601],
      "603": [600, 603, 602, 601],
    });
    expect(body.qualifiers!["601"]).toBeUndefined();
  });

  it("后续轮来源是轮空：单队名也算候选（不再回退「待定」）", async () => {
    const { env } = freshEnv();
    await addSlot(env, 602);
    await addSlot(env, 602);
    expect((await place(env, 602, 1, 600, null)).status).toBe(200); // 北京轮空
    expect((await place(env, 602, 2, 602, 603)).status).toBe(200); // 广州 vs 深圳

    const rows = await publicMatches(env, 602);
    expect(rows.filter((r) => r.round === 2).map((r) => [r.homePlaceholder, r.awayPlaceholder])).toEqual([
      ["北京", "广州/深圳"],
    ]);
  });

  it("两回合：次回合行主客对调（与落位/晋级器同口径）", async () => {
    const { env } = freshEnv();
    await addSlot(env, 603);
    await addSlot(env, 603);
    const shape = (rs: MatchDto[]) =>
      rs
        .slice()
        .sort((a, b) => a.round - b.round || a.slot - b.slot || (a.leg ?? 0) - (b.leg ?? 0))
        .map((r) => [r.round, r.slot, r.leg, r.homePlaceholder ?? null, r.awayPlaceholder ?? null]);

    // 首轮两场都空（两回合阶段空场次也只是一行 leg=null）：cross token 队名；决赛空壳铺两条 leg 行
    expect(shape(await publicMatches(env, 603))).toEqual([
      [1, 1, null, "北京", "深圳"],
      [1, 2, null, "广州", "上海"],
      [2, 1, 1, null, null],
      [2, 1, 2, null, null],
    ]);

    // 落位第 1 场后：决赛 leg1 主队候选来自第 1 场，leg2 行对调到客队侧
    expect((await place(env, 603, 1, 600, 601)).status).toBe(200);
    expect(shape(await publicMatches(env, 603)).filter((r) => r[0] === 2)).toEqual([
      [2, 1, 1, "北京/上海", null],
      [2, 1, 2, null, "北京/上海"],
    ]);
  });

  it("来源阶段没打完：名次不作数 → 占位回退「待定」、不出线标记", async () => {
    const { env, sqlite } = freshEnv();
    sqlite.prepare("UPDATE match SET status = 'pending', winner_entry_id = NULL WHERE id = 9001").run();
    await addSlot(env, 600);
    await addSlot(env, 600);

    const rows = await publicMatches(env, 600);
    expect(rows.filter((r) => r.round === 1).map((r) => [r.homePlaceholder ?? null, r.awayPlaceholder ?? null])).toEqual([
      [null, null],
      [null, null],
    ]);
    const body = (await (await adm(env, "/api/admin/tournaments/60/matches")).json()) as {
      qualifiers?: Record<string, number[]>;
    };
    expect(body.qualifiers!["600"]).toBeUndefined();
  });

  it("没有取人规则（手动落位）：不给占位、不给「出线」标记", async () => {
    const { env, sqlite } = freshEnv();
    sqlite.prepare("UPDATE stage SET config_json = ? WHERE id = 602").run(JSON.stringify({ legs: 1 }));
    await addSlot(env, 602);

    const rows = await publicMatches(env, 602);
    expect(rows.filter((r) => r.round === 1).map((r) => [r.homePlaceholder ?? null, r.awayPlaceholder ?? null])).toEqual([
      [null, null],
    ]);
    const body = (await (await adm(env, "/api/admin/tournaments/60/matches")).json()) as {
      qualifiers?: Record<string, number[]>;
    };
    expect(body.qualifiers!["602"]).toBeUndefined();
  });
});
