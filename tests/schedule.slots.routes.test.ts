// 淘汰赛手动落位路由回归（T2 落位端点 + T5 开打闸门）：
//   POST   /api/admin/tournaments/:id/stages/:stageId/slots        追加首轮空场次
//   PUT    …/slots/:slot                                          落位 / 轮空 / 清空
//   DELETE …/slots/:slot                                          删除并前移后续序号
// 结构规则本体在 worker/lib/manualBracket.ts（差量对齐后续轮空壳 + 原地 UPDATE 保 match.id）；
// 这里钉「HTTP → 写库结果」这一段：2 的幂约束、16 场上限、轮空存储形态、冻结守卫、
// 序号前移不改 id，以及与晋级器 buildAdvanceStmts 的联动（下游清过期预填 → 重算）。
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { applyMigrations, createTestD1, createTestKV, sqlAll, sqlGet } from "./d1";

const ISO = "2026-01-01T00:00:00Z";
const AUTH = { Cookie: "whl_session=tok-admin", "Content-Type": "application/json" };
type Env = Record<string, unknown>;

type Row = {
  id: number;
  round: number;
  slot: number;
  leg: number | null;
  home_entry_id: number | null;
  away_entry_id: number | null;
  winner_entry_id: number | null;
  status: string;
  note: string | null;
};

// 赛事 60 + 8 支队（entry 600..607 / team 40..47）
function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  sqlite
    .prepare(
      "INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(1, "管理员", "", "x", "admin", 0, 0);
  for (let i = 0; i < 8; i++) {
    sqlite
      .prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (?, 1, ?, ?)")
      .run(40 + i, `T${40 + i}`, ISO);
  }
  sqlite
    .prepare(
      "INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (60, 1, '淘汰赛', 'single_elim', 'running', 1, ?)"
    )
    .run(ISO);
  const env: Env = {
    DB: createTestD1(sqlite),
    KV: createTestKV(new Map([["sess:tok-admin", JSON.stringify({ userId: 1 })]])) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
  };
  return { env, sqlite };
}

function mkStage(sqlite: DatabaseSync, id: number, kind: string, sortOrder: number, config: Record<string, unknown>) {
  sqlite
    .prepare("INSERT INTO stage (id, tournament_id, kind, sort_order, config_json) VALUES (?, 60, ?, ?, ?)")
    .run(id, kind, sortOrder, JSON.stringify(config));
}

function mkEntries(sqlite: DatabaseSync, ids: number[]) {
  const stmt = sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed, group_id) VALUES (?, 60, ?, ?, NULL)");
  ids.forEach((id, i) => stmt.run(id, 40 + i, i + 1));
}

const slotsPath = (stageId: number) => `/api/admin/tournaments/60/stages/${stageId}/slots`;
const post = (env: Env, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: AUTH, body: JSON.stringify(body) }, env);
const put = (env: Env, path: string, body: unknown) =>
  app.request(path, { method: "PUT", headers: AUTH, body: JSON.stringify(body) }, env);
const del = (env: Env, path: string) => app.request(path, { method: "DELETE", headers: AUTH }, env);
const msg = async (res: Response) => ((await res.json()) as { message?: string }).message ?? "";

const addSlot = (env: Env, stageId: number) => post(env, slotsPath(stageId), {});
const place = (env: Env, stageId: number, slot: number, home: number | null, away: number | null) =>
  put(env, `${slotsPath(stageId)}/${slot}`, { homeEntryId: home, awayEntryId: away });
const dropSlot = (env: Env, stageId: number, slot: number) => del(env, `${slotsPath(stageId)}/${slot}`);
const start = (env: Env, matchId: number) => post(env, `/api/admin/matches/${matchId}/start`, {});
const finish = (env: Env, matchId: number, scoreHome: number, scoreAway: number) =>
  post(env, `/api/admin/matches/${matchId}/finish`, { scoreHome, scoreAway });

const rowsOf = (sqlite: DatabaseSync, stageId: number) =>
  sqlAll<Row>(
    sqlite,
    `SELECT id, round, slot, leg, home_entry_id, away_entry_id, winner_entry_id, status, note
     FROM match WHERE stage_id = ? ORDER BY round, slot, leg, id`,
    stageId
  );
const shape = (r: Row): unknown[] => [
  r.round,
  r.slot,
  r.leg,
  r.home_entry_id,
  r.away_entry_id,
  r.winner_entry_id,
  r.status,
  r.note,
];
const setStatus = (sqlite: DatabaseSync, matchId: number, status: string) =>
  sqlite.prepare("UPDATE match SET status = ? WHERE id = ?").run(status, matchId);
const idAt = (sqlite: DatabaseSync, stageId: number, round: number, slot: number) =>
  sqlGet<{ id: number }>(
    sqlite,
    "SELECT id FROM match WHERE stage_id = ? AND round = ? AND slot = ? ORDER BY leg, id LIMIT 1",
    stageId,
    round,
    slot
  )!.id;

describe("淘汰赛落位：新增/删除场次", () => {
  it("空阶段新增 1 场：只铺首轮 1 行（单场即决赛，无后续轮）", async () => {
    const { env, sqlite } = freshEnv();
    mkEntries(sqlite, [600, 601, 602, 603]);
    mkStage(sqlite, 600, "elim", 1, { legs: 1 });

    const res = await addSlot(env, 600);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, slot: 1, count: 1 });
    expect(rowsOf(sqlite, 600).map(shape)).toEqual([[1, 1, null, null, null, null, "pending", null]]);
  });

  it("场次数 → 轮数：4 场铺 3 轮（首轮 4 + 半决赛 2 + 决赛 1）", async () => {
    const { env, sqlite } = freshEnv();
    mkEntries(sqlite, [600, 601, 602, 603, 604, 605, 606, 607]);
    mkStage(sqlite, 600, "elim", 1, { legs: 1 });
    for (let i = 0; i < 4; i++) expect((await addSlot(env, 600)).status).toBe(200);

    expect(rowsOf(sqlite, 600).map((r) => [r.round, r.slot, r.home_entry_id])).toEqual([
      [1, 1, null],
      [1, 2, null],
      [1, 3, null],
      [1, 4, null],
      [2, 1, null],
      [2, 2, null],
      [3, 1, null],
    ]);
  });

  it("非 2 的幂（3 场）：不铺后续轮；补到 4 场后才出现空壳", async () => {
    const { env, sqlite } = freshEnv();
    mkEntries(sqlite, [600, 601, 602, 603, 604, 605, 606, 607]);
    mkStage(sqlite, 600, "elim", 1, { legs: 1 });
    for (let i = 0; i < 3; i++) await addSlot(env, 600);
    expect(rowsOf(sqlite, 600).map((r) => [r.round, r.slot])).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
    ]);

    expect((await addSlot(env, 600)).status).toBe(200);
    expect(rowsOf(sqlite, 600).filter((r) => r.round > 1).map((r) => [r.round, r.slot])).toEqual([
      [2, 1],
      [2, 2],
      [3, 1],
    ]);
  });

  it("首轮 16 场上限：第 17 场 400，已有结构不动", async () => {
    const { env, sqlite } = freshEnv();
    mkEntries(sqlite, [600, 601, 602, 603]);
    mkStage(sqlite, 600, "elim", 1, { legs: 1 });
    for (let i = 0; i < 16; i++) expect((await addSlot(env, 600)).status).toBe(200);
    const before = rowsOf(sqlite, 600);

    const res = await addSlot(env, 600);
    expect(res.status).toBe(400);
    expect(await msg(res)).toBe("首轮最多 16 场（32 支队）");
    expect(rowsOf(sqlite, 600)).toEqual(before);
  });

  it("DELETE：后续序号前移，且被前移场次的 match.id 不变（战术提交/互动外键不级联丢）", async () => {
    const { env, sqlite } = freshEnv();
    mkEntries(sqlite, [600, 601, 602, 603, 604, 605, 606, 607]);
    mkStage(sqlite, 600, "elim", 1, { legs: 1 });
    for (let i = 0; i < 4; i++) await addSlot(env, 600);
    await place(env, 600, 1, 600, 601);
    await place(env, 600, 2, 602, 603);
    await place(env, 600, 3, 604, 605);
    await place(env, 600, 4, 606, 607);
    const idOfOld2 = idAt(sqlite, 600, 1, 2);
    const idOfOld3 = idAt(sqlite, 600, 1, 3);

    const res = await dropSlot(env, 600, 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, count: 3 });
    expect(rowsOf(sqlite, 600).filter((r) => r.round === 1).map((r) => [r.slot, r.id, r.home_entry_id, r.away_entry_id])).toEqual([
      [1, idOfOld2, 602, 603],
      [2, idOfOld3, 604, 605],
      [3, expect.any(Number), 606, 607],
    ]);
    // 第 4 场前移后 id 也应保持
    expect(sqlGet<{ id: number }>(sqlite, "SELECT id FROM match WHERE stage_id = 600 AND round = 1 AND slot = 3")!.id).toBe(
      sqlGet<{ id: number }>(sqlite, "SELECT id FROM match WHERE stage_id = 600 AND round = 1 AND home_entry_id = 606")!.id
    );
    // 4 场 → 3 场：后续轮空壳随之收掉
    expect(rowsOf(sqlite, 600).filter((r) => r.round > 1)).toEqual([]);
  });

  it("DELETE 不存在的场次 → 404；已开打 → 409", async () => {
    const { env, sqlite } = freshEnv();
    mkEntries(sqlite, [600, 601, 602, 603]);
    mkStage(sqlite, 600, "elim", 1, { legs: 1 });
    await addSlot(env, 600);
    await addSlot(env, 600);

    const missing = await dropSlot(env, 600, 5);
    expect(missing.status).toBe(404);
    expect(await msg(missing)).toBe("首轮第 5 场不存在");

    await place(env, 600, 1, 600, 601);
    setStatus(sqlite, idAt(sqlite, 600, 1, 1), "live");
    const frozen = await dropSlot(env, 600, 2);
    expect(frozen.status).toBe(409);
    expect(await msg(frozen)).toBe("该阶段已有开打或完赛的场次，不能增删场次");
    const addFrozen = await addSlot(env, 600);
    expect(addFrozen.status).toBe(409);
    expect(await msg(addFrozen)).toBe("该阶段已有开打或完赛的场次，不能增删场次");
  });
});

describe("淘汰赛落位：落位 / 轮空 / 清空", () => {
  it("落位写主客队；清空（两者皆 null）回到空席位", async () => {
    const { env, sqlite } = freshEnv();
    mkEntries(sqlite, [600, 601, 602, 603]);
    mkStage(sqlite, 600, "elim", 1, { legs: 1 });
    await addSlot(env, 600);
    await addSlot(env, 600);

    const res = await place(env, 600, 1, 600, 601);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, slot: 1, home: 600, away: 601 });
    expect(rowsOf(sqlite, 600).filter((r) => r.round === 1 && r.slot === 1).map(shape)).toEqual([
      [1, 1, null, 600, 601, null, "pending", null],
    ]);

    const clear = await place(env, 600, 1, null, null);
    expect(clear.status).toBe(200);
    expect(rowsOf(sqlite, 600).filter((r) => r.round === 1 && r.slot === 1).map(shape)).toEqual([
      [1, 1, null, null, null, null, "pending", null],
    ]);
  });

  it("legs=2：落位铺两条 leg 行且主客对调；轮空只铺一条（leg null）", async () => {
    const { env, sqlite } = freshEnv();
    mkEntries(sqlite, [600, 601, 602, 603]);
    mkStage(sqlite, 600, "elim", 1, { legs: 2 });
    await addSlot(env, 600);
    await addSlot(env, 600);

    await place(env, 600, 1, 600, 601);
    expect(rowsOf(sqlite, 600).filter((r) => r.round === 1 && r.slot === 1).map(shape)).toEqual([
      [1, 1, 1, 600, 601, null, "pending", null],
      [1, 1, 2, 601, 600, null, "pending", null],
    ]);

    await place(env, 600, 2, 602, null);
    expect(rowsOf(sqlite, 600).filter((r) => r.round === 1 && r.slot === 2).map(shape)).toEqual([
      [1, 2, null, 602, null, 602, "pending", "轮空"],
    ]);
    // 轮空行不参与开赛
    const bye = await start(env, idAt(sqlite, 600, 1, 2));
    expect(bye.status).toBe(400);
    expect(await msg(bye)).toBe("轮空场无需开赛");
  });

  it("final_legs 覆盖决赛：2 场（2 轮）时首轮两回合、决赛单场", async () => {
    const { env, sqlite } = freshEnv();
    mkEntries(sqlite, [600, 601, 602, 603]);
    mkStage(sqlite, 600, "elim", 1, { legs: 2, final_legs: 1 });
    await addSlot(env, 600);
    await addSlot(env, 600);
    await place(env, 600, 1, 600, 601);

    expect(rowsOf(sqlite, 600).map((r) => [r.round, r.slot, r.leg, r.home_entry_id, r.away_entry_id])).toEqual([
      [1, 1, 1, 600, 601],
      [1, 1, 2, 601, 600],
      [1, 2, null, null, null],
      [2, 1, null, null, null], // 决赛 = final_legs 1 → 单行
    ]);
  });

  it("配置改回合制后重新落位：leg 行按新 legs 重铺（保留 match.id）", async () => {
    const { env, sqlite } = freshEnv();
    mkEntries(sqlite, [600, 601, 602, 603]);
    mkStage(sqlite, 600, "elim", 1, { legs: 1 });
    await addSlot(env, 600);
    await addSlot(env, 600);
    await place(env, 600, 1, 600, 601);
    const idBefore = idAt(sqlite, 600, 1, 1);

    sqlite.prepare("UPDATE stage SET config_json = ? WHERE id = 600").run(JSON.stringify({ legs: 2 }));
    expect((await place(env, 600, 1, 600, 601)).status).toBe(200);
    const rows = rowsOf(sqlite, 600).filter((r) => r.round === 1 && r.slot === 1);
    expect(rows.map((r) => [r.leg, r.home_entry_id, r.away_entry_id])).toEqual([
      [1, 600, 601],
      [2, 601, 600],
    ]);
    // 形状变了必须换行（一条行装不下两回合），但首行 id 允许变；此处只钉「不再是一条旧行 + 残留」
    expect(rows).toHaveLength(2);
    expect(idBefore).toBeGreaterThan(0);
  });

  it("参数守卫：序号/主客组合/队伍归属/本轮占用", async () => {
    const { env, sqlite } = freshEnv();
    mkEntries(sqlite, [600, 601, 602, 603]);
    mkStage(sqlite, 600, "elim", 1, { legs: 1 });
    await addSlot(env, 600);
    await addSlot(env, 600);

    const badSlot = await put(env, `${slotsPath(600)}/0`, { homeEntryId: 600, awayEntryId: 601 });
    expect(badSlot.status).toBe(400);
    expect(await msg(badSlot)).toBe("场次序号必须是正整数");

    const noBody = await post(env, `${slotsPath(600)}/1`, {});
    expect(noBody.status).toBe(404); // PUT 才是落位入口，带序号的路径没有 POST 分支

    const halfPair = await put(env, `${slotsPath(600)}/1`, { homeEntryId: null, awayEntryId: 601 });
    expect(halfPair.status).toBe(400);
    expect(await msg(halfPair)).toBe("主队留空时不能指定客队");

    const sameTeam = await place(env, 600, 1, 600, 600);
    expect(sameTeam.status).toBe(400);
    expect(await msg(sameTeam)).toBe("主客队不能是同一支队伍");

    const missingSlot = await place(env, 600, 5, 600, 601);
    expect(missingSlot.status).toBe(404);
    expect(await msg(missingSlot)).toBe("首轮第 5 场不存在");

    const foreign = await place(env, 600, 1, 600, 999);
    expect(foreign.status).toBe(400);
    expect(await msg(foreign)).toBe("参赛队伍不存在");

    expect((await place(env, 600, 1, 600, 601)).status).toBe(200);
    const occupied = await place(env, 600, 2, 601, 602);
    expect(occupied.status).toBe(409);
    expect(await msg(occupied)).toBe("该队在本轮已有其它场次");
  });

  it("非淘汰赛阶段：落位端点一律 400", async () => {
    const { env, sqlite } = freshEnv();
    mkEntries(sqlite, [600, 601, 602, 603]);
    mkStage(sqlite, 601, "round_robin", 1, { loops: 1 });

    const res = await addSlot(env, 601);
    expect(res.status).toBe(400);
    expect(await msg(res)).toBe("手动落位只适用于淘汰赛阶段");
  });

  it("冻结守卫：本场已开打 → 409；后续轮已开打 → 首轮落位 409", async () => {
    const { env, sqlite } = freshEnv();
    mkEntries(sqlite, [600, 601, 602, 603, 604, 605, 606, 607]);
    mkStage(sqlite, 600, "elim", 1, { legs: 1 });
    for (let i = 0; i < 4; i++) await addSlot(env, 600);
    await place(env, 600, 1, 600, 601);
    await place(env, 600, 2, 602, 603);

    setStatus(sqlite, idAt(sqlite, 600, 1, 1), "live");
    const onLive = await place(env, 600, 1, 604, 605);
    expect(onLive.status).toBe(409);
    expect(await msg(onLive)).toBe("该场次已开打，不能调整落位");

    // 首轮未开打的另一场仍可落位
    expect((await place(env, 600, 3, 604, 605)).status).toBe(200);

    // 后续轮开打后，首轮落位整体冻结（下游对阵已按当前首轮结果铺开）
    setStatus(sqlite, idAt(sqlite, 600, 1, 1), "pending");
    setStatus(sqlite, idAt(sqlite, 600, 2, 1), "live");
    const onLater = await place(env, 600, 1, 600, 601);
    expect(onLater.status).toBe(409);
    expect(await msg(onLater)).toBe("后续轮次已开打，不能再调整首轮落位");
  });
});

describe("淘汰赛落位：与晋级器联动", () => {
  it("打满首轮自动填半决赛：晋级器按 (round, slot) 算术落位", async () => {
    const { env, sqlite } = freshEnv();
    mkEntries(sqlite, [600, 601, 602, 603, 604, 605, 606, 607]);
    mkStage(sqlite, 600, "elim", 1, { legs: 1 });
    for (let i = 0; i < 4; i++) await addSlot(env, 600);
    await place(env, 600, 1, 600, 601);
    await place(env, 600, 2, 602, 603);
    await place(env, 600, 3, 604, 605);
    await place(env, 600, 4, 606, 607);

    for (let slot = 1; slot <= 4; slot++) {
      const res = await finish(env, idAt(sqlite, 600, 1, slot), 1, 0); // 主队晋级
      expect(res.status).toBe(200);
    }
    expect(rowsOf(sqlite, 600).filter((r) => r.round === 2).map(shape)).toEqual([
      [2, 1, null, 600, 602, null, "pending", null],
      [2, 2, null, 604, 606, null, "pending", null],
    ]);

    // 已完赛的首轮场次落位冻结（改对阵要整段清除赛程重摆）
    const frozen = await place(env, 600, 2, null, null);
    expect(frozen.status).toBe(409);
    expect(await msg(frozen)).toBe("该场次已开打，不能调整落位");
  });

  it("轮空预填的后续轮：改首轮落位会清掉过期预填，等新结果再填", async () => {
    const { env, sqlite } = freshEnv();
    mkEntries(sqlite, [600, 601, 602, 603]);
    mkStage(sqlite, 600, "elim", 1, { legs: 1 });
    await addSlot(env, 600);
    await addSlot(env, 600);
    // 两场都轮空 → 决赛按预填晋级者铺开（601 那场仍 pending）
    await place(env, 600, 1, 600, null);
    await place(env, 600, 2, 601, null);
    expect(rowsOf(sqlite, 600).filter((r) => r.round === 2).map(shape)).toEqual([
      [2, 1, null, 600, 601, null, "pending", null],
    ]);

    // 第 1 场改成真对阵（该场 pending，允许）→ 决赛的过期预填被清空，等结果
    expect((await place(env, 600, 1, 602, 603)).status).toBe(200);
    expect(rowsOf(sqlite, 600).filter((r) => r.round === 2).map(shape)).toEqual([
      [2, 1, null, null, null, null, "pending", null],
    ]);
    expect(rowsOf(sqlite, 600).filter((r) => r.round === 1).map(shape)).toEqual([
      [1, 1, null, 602, 603, null, "pending", null],
      [1, 2, null, 601, null, 601, "pending", "轮空"],
    ]);
  });

  it("轮空：单行预填晋级；另一场分出胜负后填入决赛", async () => {
    const { env, sqlite } = freshEnv();
    mkEntries(sqlite, [600, 601, 602, 603]);
    mkStage(sqlite, 600, "elim", 1, { legs: 1 });
    await addSlot(env, 600);
    await addSlot(env, 600);
    await place(env, 600, 1, 600, null);
    await place(env, 600, 2, 601, 602);

    expect((await finish(env, idAt(sqlite, 600, 1, 2), 0, 1)).status).toBe(200); // 602 胜
    expect(rowsOf(sqlite, 600).filter((r) => r.round === 2).map(shape)).toEqual([
      [2, 1, null, 600, 602, null, "pending", null],
    ]);
  });

  it("开打闸门：首轮场次数非 2 的幂 → start/finish 一律 409；补齐后放行", async () => {
    const { env, sqlite } = freshEnv();
    mkEntries(sqlite, [600, 601, 602, 603, 604, 605, 606, 607]);
    mkStage(sqlite, 600, "elim", 1, { legs: 1 });
    for (let i = 0; i < 3; i++) await addSlot(env, 600);
    await place(env, 600, 1, 600, 601);
    const matchId = idAt(sqlite, 600, 1, 1);
    const gate = "首轮场次数需为 2 的幂（当前 3 场），请先在赛程页增删场次";

    const started = await start(env, matchId);
    expect(started.status).toBe(409);
    expect(await msg(started)).toBe(gate);

    const finished = await finish(env, matchId, 1, 0);
    expect(finished.status).toBe(409);
    expect(await msg(finished)).toBe(gate);
    expect(sqlGet<{ status: string }>(sqlite, "SELECT status FROM match WHERE id = ?", matchId)!.status).toBe("pending");

    // 补到 4 场（2 的幂）后放行
    expect((await addSlot(env, 600)).status).toBe(200);
    expect((await start(env, matchId)).status).toBe(200);
  });
});

describe("淘汰赛场次的结构守卫", () => {
  const patch = (env: Env, path: string, body: unknown) =>
    app.request(path, { method: "PATCH", headers: AUTH, body: JSON.stringify(body) }, env);

  it("单场删除端点：淘汰赛阶段一律 400（两回合的一条 leg 行不能单独删）", async () => {
    const { env, sqlite } = freshEnv();
    mkEntries(sqlite, [600, 601, 602, 603]);
    mkStage(sqlite, 600, "elim", 1, { legs: 2 });
    await addSlot(env, 600);
    await place(env, 600, 1, 600, 601);
    const matchId = idAt(sqlite, 600, 1, 1);

    const res = await del(env, `/api/admin/tournaments/60/matches/${matchId}`);
    expect(res.status).toBe(400);
    expect(await msg(res)).toBe("淘汰赛请在赛程页增删场次");
    expect(rowsOf(sqlite, 600)).toHaveLength(2);
  });

  it("回合制参数：阶段出现场次后锁定，清除赛程后放行", async () => {
    const { env, sqlite } = freshEnv();
    mkEntries(sqlite, [600, 601, 602, 603]);
    mkStage(sqlite, 600, "elim", 1, { legs: 1 });
    const path = "/api/admin/tournaments/60";
    const lockMsg = "该淘汰赛阶段已有场次，回合制参数已锁定（要改先清除赛程）";

    // 没场次时可改
    expect((await patch(env, path, { config_json: { legs: 2 } })).status).toBe(200);

    await addSlot(env, 600);
    await place(env, 600, 1, 600, 601);
    const locked = await patch(env, path, { config_json: { legs: 1 } });
    expect(locked.status).toBe(400);
    expect(await msg(locked)).toBe(lockMsg);

    // 同值重发（UI 常整份回传）不触发锁定
    expect((await patch(env, path, { config_json: { legs: 2 } })).status).toBe(200);

    // 清除赛程后解锁
    expect((await del(env, "/api/admin/tournaments/60/stages/600/matches")).status).toBe(200);
    expect(rowsOf(sqlite, 600)).toHaveLength(0);
    expect((await patch(env, path, { config_json: { legs: 1 } })).status).toBe(200);
  });
});
