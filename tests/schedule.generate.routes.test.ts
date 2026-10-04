// 赛程编排路由级回归：阶段赛程生成（淘汰/循环/小组）、抽签、名次取人、
// 清空与补全双循环、阶段结构调整。
// 算法本体（seeding.ts 的 seedOrder / roundRobinSchedule / buildElimPlan / drawGroups）
// 目前没有独立的纯函数测试文件，本文件是通过路由间接覆盖其结论的第一处覆盖；
// 这里钉的是「算法结论 → 写库结果」这一段：种子号到 entry 的映射、轮空预填、
// 重生成清空、各守卫的中文报错与状态码。
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { applyMigrations, createTestD1, createTestKV, sqlAll, sqlGet } from "./d1";

const ISO = "2026-01-01T00:00:00Z";
const AUTH = { Cookie: "whl_session=tok-admin", "Content-Type": "application/json" };
type Env = Record<string, unknown>;

type MatchRow = {
  round: number;
  slot: number;
  leg: number | null;
  home_entry_id: number | null;
  away_entry_id: number | null;
  status: string;
  winner_entry_id: number | null;
  note: string | null;
};

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
  const env: Env = {
    DB: createTestD1(sqlite),
    KV: createTestKV(new Map([["sess:tok-admin", JSON.stringify({ userId: 1 })]])) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
  };
  return { env, sqlite };
}

const post = (env: Env, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: AUTH, body: JSON.stringify(body) }, env);
const del = (env: Env, path: string) => app.request(path, { method: "DELETE", headers: AUTH }, env);
const msg = async (res: Response) => ((await res.json()) as { message?: string }).message ?? "";

const generate = (env: Env, tid: number, stageId: number) =>
  post(env, `/api/admin/tournaments/${tid}/stages/${stageId}/generate`, {});
const draw = (env: Env, tid: number, stageId: number) =>
  post(env, `/api/admin/tournaments/${tid}/stages/${stageId}/draw`, {});
const completeDouble = (env: Env, tid: number, stageId: number) =>
  post(env, `/api/admin/tournaments/${tid}/stages/${stageId}/complete-double`, {});
const finish = (env: Env, matchId: number, body: Record<string, unknown>) =>
  post(env, `/api/admin/matches/${matchId}/finish`, body);

function mkTournament(sqlite: DatabaseSync, tid: number, status = "running") {
  sqlite
    .prepare(
      "INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (?, 1, ?, 'round_robin', ?, 1, ?)"
    )
    .run(tid, `赛${tid}`, status, ISO);
}

function mkStage(
  sqlite: DatabaseSync,
  id: number,
  tid: number,
  kind: "elim" | "round_robin" | "group",
  sortOrder: number,
  config: Record<string, unknown> = {}
) {
  sqlite
    .prepare("INSERT INTO stage (id, tournament_id, kind, sort_order, config_json) VALUES (?, ?, ?, ?, ?)")
    .run(id, tid, kind, sortOrder, JSON.stringify(config));
}

// teamStart 缺省 40：必须落在 freshEnv 建好的 8 支队（40..47）范围内
function mkEntries(sqlite: DatabaseSync, tid: number, ids: number[], seeds?: number[], teamStart = 40) {
  const stmt = sqlite.prepare(
    "INSERT INTO entry (id, tournament_id, team_id, seed, group_id) VALUES (?, ?, ?, ?, NULL)"
  );
  ids.forEach((id, i) => stmt.run(id, tid, teamStart + i, seeds ? seeds[i] : i + 1));
}

function mkGroups(sqlite: DatabaseSync, stageId: number, names: string[], firstId = 900) {
  names.forEach((n, i) =>
    sqlite
      .prepare('INSERT INTO "group" (id, stage_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .run(firstId + i, stageId, n, i + 1)
  );
}

const setGroup = (sqlite: DatabaseSync, entryId: number, groupId: number | null) =>
  sqlite.prepare("UPDATE entry SET group_id = ? WHERE id = ?").run(groupId, entryId);

const rowsOf = (sqlite: DatabaseSync, stageId: number) =>
  sqlAll<MatchRow>(
    sqlite,
    `SELECT round, slot, leg, home_entry_id, away_entry_id, status, winner_entry_id, note
     FROM match WHERE stage_id = ? ORDER BY round, slot, leg, id`,
    stageId
  );

const countOf = (sqlite: DatabaseSync, stageId: number) =>
  sqlGet<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM match WHERE stage_id = ?", stageId)!.n;

const setStatus = (sqlite: DatabaseSync, matchId: number, status: string) =>
  sqlite.prepare("UPDATE match SET status = ? WHERE id = ?").run(status, matchId);

const pairsOf = (rows: MatchRow[]) =>
  rows
    .filter((r) => r.home_entry_id !== null && r.away_entry_id !== null)
    .map((r) => [r.home_entry_id!, r.away_entry_id!] as [number, number]);
const keyOf = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

describe("赛程生成：淘汰赛已改为手动落位", () => {
  it("淘汰赛阶段调用自动生成 → 400（不再自动生成对阵）", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 40);
    mkEntries(sqlite, 40, [400, 401, 402, 403, 404, 405, 406, 407]);
    mkStage(sqlite, 400, 40, "elim", 1, { legs: 1 });

    const res = await generate(env, 40, 400);
    expect(res.status).toBe(400);
    expect(await msg(res)).toBe("淘汰赛改为手动落位，不再自动生成对阵");
    expect(countOf(sqlite, 400)).toBe(0);
  });

  it("已有开打场次的淘汰赛阶段仍先撞 409 结构闸门", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 40);
    mkEntries(sqlite, 40, [400, 401]);
    mkStage(sqlite, 400, 40, "elim", 1, { legs: 1 });
    sqlite
      .prepare(
        "INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status, note) VALUES (9998, 400, 1, 1, 400, 401, 'live', NULL)"
      )
      .run();

    const res = await generate(env, 40, 400);
    expect(res.status).toBe(409);
    expect(await msg(res)).toBe("该阶段已有开打或完赛的场次，不能重新生成");
  });

  it("阶段不属于该赛事时 404", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 40);
    mkEntries(sqlite, 40, [400, 401]);
    mkStage(sqlite, 400, 40, "elim", 1, {});

    const res = await generate(env, 43, 400);
    expect(res.status).toBe(404);
    expect(await msg(res)).toBe("阶段不存在");
  });
});


describe("赛程生成：循环赛", () => {
  it("8 队单循环：28 场 7 轮，每对恰好一场且无自交手", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 43);
    mkEntries(sqlite, 43, [430, 431, 432, 433, 434, 435, 436, 437]);
    mkStage(sqlite, 430, 43, "round_robin", 1, { loops: 1 });

    const res = await generate(env, 43, 430);
    const body = (await res.json()) as { created: number; rounds: number; balanced: boolean };
    expect(body.created).toBe(28);
    expect(body.rounds).toBe(7);
    expect(body.balanced).toBe(true);

    const rows = rowsOf(sqlite, 430);
    const keys = rows.map((r) => keyOf(r.home_entry_id!, r.away_entry_id!));
    expect(new Set(keys).size).toBe(28); // 每对只碰一次
    expect(rows.some((r) => r.home_entry_id === r.away_entry_id)).toBe(false);
    for (const team of [430, 431, 432, 433, 434, 435, 436, 437]) {
      const games = rows.filter((r) => r.home_entry_id === team || r.away_entry_id === team);
      expect(games).toHaveLength(7);
      const homeGames = rows.filter((r) => r.home_entry_id === team).length;
      expect([3, 4]).toContain(homeGames); // 主客尽量均衡
    }
  });

  it("5 队单循环：轮空位不产出场次，共 10 场 5 轮", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 44);
    mkEntries(sqlite, 44, [440, 441, 442, 443, 444]);
    mkStage(sqlite, 440, 44, "round_robin", 1, { loops: 1 });

    const res = await generate(env, 44, 440);
    expect(await res.json()).toEqual({ created: 10, rounds: 5, balanced: true });
    const rows = rowsOf(sqlite, 440);
    expect(new Set(rows.map((r) => keyOf(r.home_entry_id!, r.away_entry_id!))).size).toBe(10);
    expect(rows.every((r) => r.home_entry_id !== null && r.away_entry_id !== null)).toBe(true);
  });

  it("loops=2：每对主客各一场", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 46);
    mkEntries(sqlite, 46, [460, 461, 462, 463]);
    mkStage(sqlite, 460, 46, "round_robin", 1, { loops: 2 });

    const res = await generate(env, 46, 460);
    const body = (await res.json()) as { created: number; rounds: number };
    expect(body.created).toBe(12);
    expect(body.rounds).toBe(6);

    const rows = rowsOf(sqlite, 460);
    for (const [a, b] of [[460, 461], [460, 462], [460, 463], [461, 462], [461, 463], [462, 463]] as const) {
      const forward = rows.filter((r) => r.home_entry_id === a && r.away_entry_id === b);
      const backward = rows.filter((r) => r.home_entry_id === b && r.away_entry_id === a);
      expect(forward).toHaveLength(1);
      expect(backward).toHaveLength(1);
    }
  });

  it("4 队单循环：场次集合与轮数固定（主客健康约束的实际收敛结果）", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 45);
    mkEntries(sqlite, 45, [450, 451, 452, 453]);
    mkStage(sqlite, 450, 45, "round_robin", 1, { loops: 1 });

    const res = await generate(env, 45, 450);
    const body = (await res.json()) as { created: number; rounds: number; balanced: boolean };
    expect(body.created).toBe(6);
    expect(body.rounds).toBe(3);
    // n=4 单循环每队只有 3 场，前两场/后两场一主一客在数学上无解（见 worker/lib/seeding.ts:221 注释）
    // → 退火停在最接近状态并如实返回 balanced=false，前端据此提示改手动
    expect(body.balanced).toBe(false);

    const rows = rowsOf(sqlite, 450);
    expect(new Set(rows.map((r) => keyOf(r.home_entry_id!, r.away_entry_id!))).size).toBe(6);
    // 求解器给出的最接近结果：主场数分布为 2/1/2/1，合计 6 场主场
    const homes = new Map<number, number>();
    for (const r of rows) homes.set(r.home_entry_id!, (homes.get(r.home_entry_id!) ?? 0) + 1);
    expect([...homes.values()].sort()).toEqual([1, 1, 2, 2]);
  });

  it("重复生成：清空重建后互赛组合不变，每对恰好交手一次", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 43);
    mkEntries(sqlite, 43, [430, 431, 432, 433, 434, 435, 436, 437]);
    mkStage(sqlite, 430, 43, "round_robin", 1, { loops: 1 });

    await generate(env, 43, 430);
    const first = new Set(rowsOf(sqlite, 430).map((r) => keyOf(r.home_entry_id!, r.away_entry_id!)));
    await generate(env, 43, 430);
    const second = new Set(rowsOf(sqlite, 430).map((r) => keyOf(r.home_entry_id!, r.away_entry_id!)));
    expect([...second].sort()).toEqual([...first].sort());
    expect(second.size).toBe(28); // C(8,2)：28 行、28 个互异组合 → 无遗漏也无重复
    expect(rowsOf(sqlite, 430)).toHaveLength(28); // 重建不会叠加旧场次
  });
});

describe("赛程生成：小组赛", () => {
  it("每个 ≥2 队的组各出一份循环赛程，空组进 skippedGroups", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 47);
    mkEntries(sqlite, 47, [470, 471, 472, 473, 474, 475]);
    mkStage(sqlite, 470, 47, "group", 1, {
      group_count: 3,
      group_size: 4,
      loops: 1,
      qualify_per_group: 2,
    });
    mkGroups(sqlite, 470, ["A", "B", "C"]);
    for (const e of [470, 471, 472]) setGroup(sqlite, e, 900);
    for (const e of [473, 474, 475]) setGroup(sqlite, e, 901);

    const res = await generate(env, 47, 470);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 6, rounds: 3, skippedGroups: ["C"] });

    const rows = rowsOf(sqlite, 470);
    const inA = pairsOf(rows).every(([h, a]) => [470, 471, 472].includes(h) === [470, 471, 472].includes(a));
    expect(inA).toBe(true); // 不会跨组配对
    expect(rows.every((r) => r.leg === null && r.winner_entry_id === null)).toBe(true);
  });

  it("同批多个小组共用阶段级 (round, slot) 编号：同轮 slot 不再重号（缺陷 D5）", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 47);
    mkEntries(sqlite, 47, [470, 471, 472, 473, 474, 475]);
    mkStage(sqlite, 470, 47, "group", 1, { group_count: 2, group_size: 3, loops: 1, qualify_per_group: 2 });
    mkGroups(sqlite, 470, ["A", "B"]);
    for (const e of [470, 471, 472]) setGroup(sqlite, e, 900);
    for (const e of [473, 474, 475]) setGroup(sqlite, e, 901);

    await generate(env, 47, 470);
    const round1 = rowsOf(sqlite, 470).filter((r) => r.round === 1);
    expect(round1).toHaveLength(2);
    expect(round1.map((r) => r.slot)).toEqual([1, 2]); // A 组第 1 场、B 组第 1 场依次编号
  });

  it("小组赛程全阶段 (round, slot) 组合两两不重复", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 47);
    mkEntries(sqlite, 47, [470, 471, 472, 473, 474, 475]);
    mkStage(sqlite, 470, 47, "group", 1, { group_count: 2, group_size: 3, loops: 1, qualify_per_group: 2 });
    mkGroups(sqlite, 470, ["A", "B"]);
    for (const e of [470, 471, 472]) setGroup(sqlite, e, 900);
    for (const e of [473, 474, 475]) setGroup(sqlite, e, 901);

    await generate(env, 47, 470);
    const keys = rowsOf(sqlite, 470).map((r) => `${r.round}:${r.slot}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("所有组都凑不出比赛：400 且不清空已有场次", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 47);
    mkEntries(sqlite, 47, [470, 471, 472, 473, 474, 475]);
    mkStage(sqlite, 470, 47, "group", 1, { group_count: 2, group_size: 3, loops: 1, qualify_per_group: 2 });
    mkGroups(sqlite, 470, ["A", "B"]);
    for (const e of [470, 471, 472]) setGroup(sqlite, e, 900);
    for (const e of [473, 474, 475]) setGroup(sqlite, e, 901);
    await generate(env, 47, 470);
    expect(countOf(sqlite, 470)).toBe(6);

    for (const e of [470, 471, 472, 473, 474, 475]) setGroup(sqlite, e, null);
    const res = await generate(env, 47, 470);
    expect(res.status).toBe(400);
    expect(await msg(res)).toBe("先抽签分组（且每组至少 2 队）才能生成小组赛程");
    expect(countOf(sqlite, 470)).toBe(6); // 守卫在 batch 之前返回，清空语句没执行
  });
});

describe("小组抽签", () => {
  function groupFixture(opts: { groupSize?: number } = {}) {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 47);
    mkEntries(sqlite, 47, [470, 471, 472, 473, 474, 475]);
    mkStage(sqlite, 470, 47, "group", 1, {
      group_count: 2,
      group_size: opts.groupSize ?? 3,
      loops: 1,
      qualify_per_group: 2,
    });
    mkStage(sqlite, 471, 47, "round_robin", 2, { loops: 1 });
    mkGroups(sqlite, 470, ["A", "B"]);
    return { env, sqlite };
  }

  const groupIdsOf = (sqlite: DatabaseSync) =>
    sqlAll<{ id: number; group_id: number | null }>(sqlite, "SELECT id, group_id FROM entry WHERE tournament_id = 47 ORDER BY id");

  it("抽签把全部报名均匀分到各组并写回 group_id", async () => {
    const { env, sqlite } = groupFixture();
    const res = await draw(env, 47, 470);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assigned: number; groups: Record<string, number[]> };
    expect(body.assigned).toBe(6);
    expect(Object.keys(body.groups).sort()).toEqual(["A", "B"]);
    expect(body.groups.A).toHaveLength(3);
    expect(body.groups.B).toHaveLength(3);

    const rows = groupIdsOf(sqlite);
    expect(rows.every((r) => r.group_id === 900 || r.group_id === 901)).toBe(true);
    for (const [gid, ids] of [[900, body.groups.A], [901, body.groups.B]] as const) {
      expect(rows.filter((r) => r.group_id === gid).map((r) => r.id).sort()).toEqual([...ids].sort());
    }
  });

  it("重复抽签：先清空旧分配再重分（手工移出的队也会被重新分配）", async () => {
    const { env, sqlite } = groupFixture();
    await draw(env, 47, 470);
    setGroup(sqlite, 470, null);

    const res = await draw(env, 47, 470);
    expect(((await res.json()) as { assigned: number }).assigned).toBe(6);
    expect(groupIdsOf(sqlite).every((r) => r.group_id !== null)).toBe(true);
  });

  it("非小组赛阶段 / 阶段没有小组行 → 400", async () => {
    const { env, sqlite } = groupFixture();
    const wrongKind = await draw(env, 47, 471);
    expect(wrongKind.status).toBe(400);
    expect(await msg(wrongKind)).toBe("只有小组赛阶段支持抽签");

    mkStage(sqlite, 472, 47, "group", 3, { group_count: 2, group_size: 3, loops: 1, qualify_per_group: 2 });
    const noGroups = await draw(env, 47, 472);
    expect(noGroups.status).toBe(400);
    expect(await msg(noGroups)).toBe("该阶段没有小组");
  });

  it("报名不足组数×2 或超出组容量 → 400", async () => {
    const tiny = freshEnv();
    mkTournament(tiny.sqlite, 48);
    mkEntries(tiny.sqlite, 48, [480, 481, 482]);
    mkStage(tiny.sqlite, 480, 48, "group", 1, { group_count: 2, group_size: 3, loops: 1, qualify_per_group: 2 });
    mkGroups(tiny.sqlite, 480, ["A", "B"]);
    const tooFew = await draw(tiny.env, 48, 480);
    expect(tooFew.status).toBe(400);
    expect(await msg(tooFew)).toBe("报名 3 支不足 2 组每组 2 队，无法抽签");

    const { env, sqlite } = groupFixture({ groupSize: 2 }); // 容量 2×2=4 < 6
    const tooMany = await draw(env, 47, 470);
    expect(tooMany.status).toBe(400);
    expect(await msg(tooMany)).toBe("报名 6 队超出 2 组 × 2 队的容量，请先调整组数或每组队数");
    expect(groupIdsOf(sqlite).every((r) => r.group_id === null)).toBe(true); // 拒了就不写
  });

  it("阶段已有开打或完赛场次时 409", async () => {
    const { env, sqlite } = groupFixture();
    sqlite
      .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status) VALUES (9100, 470, 1, 1, 470, 471, 'finished')")
      .run();
    const res = await draw(env, 47, 470);
    expect(res.status).toBe(409);
    expect(await msg(res)).toBe("该阶段已有开打或完赛的场次，不能重新抽签");
  });
});

describe("名次取人（takeRangePool）", () => {
  async function twoStageFixture(opts: { configuredSource?: unknown } = {}) {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 51);
    mkEntries(sqlite, 51, [510, 511, 512, 513]);
    mkStage(sqlite, 510, 51, "round_robin", 1, { loops: 1 });
    // 淘汰赛不再自动生成，取人区间只服务非淘汰赛目标（出线标记/占位另见 qualifiers 用例）
    mkStage(sqlite, 511, 51, "round_robin", 2, { loops: 1, source: opts.configuredSource ?? { take: 4 } });
    return { env, sqlite };
  }

  const finishAll = async (env: Env, sqlite: DatabaseSync, stageId: number, skipLast = 0) => {
    const ids = sqlAll<{ id: number }>(sqlite, "SELECT id FROM match WHERE stage_id = ? ORDER BY round, slot", stageId);
    const target = skipLast > 0 ? ids.slice(0, ids.length - skipLast) : ids;
    for (const m of target) {
      const res = await finish(env, m.id, { scoreHome: 1, scoreAway: 0 });
      expect(res.status).toBe(200);
    }
  };

  it("来源阶段完赛后按名次区间取人：取 4 支 → 单循环 6 场（取人顺序另由占位/出线用例覆盖）", async () => {
    const { env, sqlite } = await twoStageFixture();
    await generate(env, 51, 510);
    await finishAll(env, sqlite, 510);

    const res = await generate(env, 51, 511);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: number; rounds: number };
    expect(body.created).toBe(6);
    expect(body.rounds).toBe(3);

    // 目标阶段是循环赛：池子会被 shuffle，故只钉「取到的是哪 4 支」与「两两交手各一次」
    const rows = rowsOf(sqlite, 511);
    const ids = new Set<number | null>();
    for (const r of rows) {
      ids.add(r.home_entry_id);
      ids.add(r.away_entry_id);
    }
    expect([...ids].sort((a, b) => a! - b!)).toEqual([510, 511, 512, 513]);
    expect(new Set(rows.map((r) => keyOf(r.home_entry_id!, r.away_entry_id!))).size).toBe(6);
  });

  it("来源阶段还没全部完赛 → 400", async () => {
    const { env, sqlite } = await twoStageFixture();
    await generate(env, 51, 510);

    const tooEarly = await generate(env, 51, 511);
    expect(tooEarly.status).toBe(400);
    expect(await msg(tooEarly)).toBe("取人来源阶段尚未全部完赛，还不能按名次取人生成");

    await finishAll(env, sqlite, 510, 1); // 差最后一场
    const stillEarly = await generate(env, 51, 511);
    expect(stillEarly.status).toBe(400);
    expect(await msg(stillEarly)).toBe("取人来源阶段尚未全部完赛，还不能按名次取人生成");
  });

  it("取不到指定名次 / 取人后不足 2 支 → 400", async () => {
    const tooMany = await twoStageFixture({ configuredSource: { take: 40 } });
    await generate(tooMany.env, 51, 510);
    await finishAll(tooMany.env, tooMany.sqlite, 510);
    const resOut = await generate(tooMany.env, 51, 511);
    expect(resOut.status).toBe(400);
    expect(await msg(resOut)).toBe("来源阶段共 4 支队，取不到第 1 到第 40 名");

    const tooFew = await twoStageFixture({ configuredSource: { from: 1, to: 1 } });
    await generate(tooFew.env, 51, 510);
    await finishAll(tooFew.env, tooFew.sqlite, 510);
    const resFew = await generate(tooFew.env, 51, 511);
    expect(resFew.status).toBe(400);
    expect(await msg(resFew)).toBe("报名不足 2 支，无法生成赛程");
  });

  it("第一阶段配了取人规则 → 400；取人来源是淘汰赛 → 400", async () => {
    const first = freshEnv();
    mkTournament(first.sqlite, 51);
    mkEntries(first.sqlite, 51, [510, 511, 512, 513]);
    mkStage(first.sqlite, 510, 51, "round_robin", 1, { loops: 1, source: { take: 2 } });
    const resFirst = await generate(first.env, 51, 510);
    expect(resFirst.status).toBe(400);
    expect(await msg(resFirst)).toBe("该阶段是第一阶段，不能配置取人规则");

    const elimSource = freshEnv();
    mkTournament(elimSource.sqlite, 51);
    mkEntries(elimSource.sqlite, 51, [510, 511, 512, 513]);
    mkStage(elimSource.sqlite, 510, 51, "elim", 1, { legs: 1 });
    mkStage(elimSource.sqlite, 511, 51, "round_robin", 2, { loops: 1, source: { take: 2, fromStage: 510 } });
    const resElim = await generate(elimSource.env, 51, 511);
    expect(resElim.status).toBe(400);
    expect(await msg(resElim)).toBe("取人来源不能是淘汰赛阶段（淘汰赛没有名次）");
  });
});

describe("清空场次、补全双循环与阶段结构", () => {
  it("一键清除：清空该阶段全部场次；已有开打场次 409；空阶段 deleted=0", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 50);
    mkEntries(sqlite, 50, [500, 501, 502, 503]);
    mkStage(sqlite, 500, 50, "round_robin", 1, { loops: 1 });
    await generate(env, 50, 500);
    expect(countOf(sqlite, 500)).toBe(6);

    const cleared = await del(env, "/api/admin/tournaments/50/stages/500/matches");
    expect(cleared.status).toBe(200);
    expect(countOf(sqlite, 500)).toBe(0);

    const again = await del(env, "/api/admin/tournaments/50/stages/500/matches");
    expect(await again.json()).toEqual({ ok: true, deleted: 0 });

    await generate(env, 50, 500);
    const firstId = sqlGet<{ id: number }>(sqlite, "SELECT id FROM match WHERE stage_id = 500 ORDER BY round, slot")!.id;
    setStatus(sqlite, firstId, "live");
    const blocked = await del(env, "/api/admin/tournaments/50/stages/500/matches");
    expect(blocked.status).toBe(409);
    expect(await msg(blocked)).toBe("该阶段已有开打或完赛的场次，不能一键清除");
    expect(countOf(sqlite, 500)).toBe(6);
  });

  it("单场删除：只有 pending 可删，跨赛事 404", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 50);
    mkEntries(sqlite, 50, [500, 501, 502, 503]);
    mkStage(sqlite, 500, 50, "round_robin", 1, { loops: 1 });
    await generate(env, 50, 500);
    const ids = sqlAll<{ id: number }>(sqlite, "SELECT id FROM match WHERE stage_id = 500 ORDER BY round, slot").map((r) => r.id);

    const ok = await del(env, `/api/admin/tournaments/50/matches/${ids[0]}`);
    expect(await ok.json()).toEqual({ ok: true });
    expect(countOf(sqlite, 500)).toBe(5);

    setStatus(sqlite, ids[1], "finished");
    const blocked = await del(env, `/api/admin/tournaments/50/matches/${ids[1]}`);
    expect(blocked.status).toBe(409);
    expect(await msg(blocked)).toBe("只有未开打的比赛可以删除");

    const notFound = await del(env, "/api/admin/tournaments/50/matches/999999");
    expect(notFound.status).toBe(404);
    expect(await msg(notFound)).toBe("比赛不存在");
  });

  it("complete-double：镜像第一循环，主客对调且轮次对称翻转", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 50);
    mkEntries(sqlite, 50, [500, 501, 502, 503]);
    mkStage(sqlite, 500, 50, "round_robin", 1, { loops: 1 });
    await generate(env, 50, 500);
    const firstLoop = rowsOf(sqlite, 500);
    expect(firstLoop).toHaveLength(6);

    const res = await completeDouble(env, 50, 500);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, created: 6, deleted: 0 });

    const rows = rowsOf(sqlite, 500);
    expect(rows).toHaveLength(12);
    // k = 3：第二循环 = 原轮次 + k，主客对调
    for (const m of firstLoop) {
      const mirror = rows.find(
        (r) => r.home_entry_id === m.away_entry_id && r.away_entry_id === m.home_entry_id && r.slot === m.slot
      );
      expect(mirror).toBeDefined();
      expect(mirror!.round).toBe(m.round + 3);
    }
  });

  it("complete-double 幂等：已有第二循环时清掉重建，场次数不变", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 50);
    mkEntries(sqlite, 50, [500, 501, 502, 503]);
    mkStage(sqlite, 500, 50, "round_robin", 1, { loops: 1 });
    await generate(env, 50, 500);
    await completeDouble(env, 50, 500);
    const before = rowsOf(sqlite, 500).map((r) => [r.round, r.slot, r.home_entry_id, r.away_entry_id]);

    setStatus(sqlite, sqlGet<{ id: number }>(sqlite, "SELECT id FROM match WHERE stage_id = 500 AND round = 4")!.id, "pending");
    const res = await completeDouble(env, 50, 500);
    expect(await res.json()).toEqual({ ok: true, created: 6, deleted: 6 });
    expect(rowsOf(sqlite, 500).map((r) => [r.round, r.slot, r.home_entry_id, r.away_entry_id])).toEqual(before);
  });

  it("complete-double 守卫：非循环赛 / 空阶段 / 第一循环不完整 / 重复交手 / 第二循环已开打", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 50);
    mkEntries(sqlite, 50, [500, 501, 502, 503]);
    mkStage(sqlite, 500, 50, "round_robin", 1, { loops: 1 });
    mkStage(sqlite, 501, 50, "elim", 2, { legs: 1 });

    const empty = await completeDouble(env, 50, 500);
    expect(empty.status).toBe(400);
    expect(await msg(empty)).toBe("阶段里还没有比赛，先生成赛程再补全双循环");

    const wrongKind = await completeDouble(env, 50, 501);
    expect(wrongKind.status).toBe(400);
    expect(await msg(wrongKind)).toBe("补全双循环只适用于循环赛阶段");

    await generate(env, 50, 500);
    await del(env, "/api/admin/tournaments/50/stages/500/matches"); // 清空后只补 2 轮
    sqlite
      .prepare("INSERT INTO match (stage_id, round, slot, home_entry_id, away_entry_id, status) VALUES (500, 1, 1, 500, 501, 'pending')")
      .run();
    sqlite
      .prepare("INSERT INTO match (stage_id, round, slot, home_entry_id, away_entry_id, status) VALUES (500, 2, 1, 502, 503, 'pending')")
      .run();
    const short = await completeDouble(env, 50, 500);
    expect(short.status).toBe(400);
    expect(await msg(short)).toBe("第一循环不完整：至少需要 3 轮，当前只有 2 轮");

    // 3 轮但同一对重复交手
    await del(env, "/api/admin/tournaments/50/stages/500/matches");
    const dup = sqlite.prepare(
      "INSERT INTO match (stage_id, round, slot, home_entry_id, away_entry_id, status) VALUES (500, ?, ?, ?, ?, 'pending')"
    );
    dup.run(1, 1, 500, 501);
    dup.run(1, 2, 502, 503);
    dup.run(2, 1, 500, 502);
    dup.run(2, 2, 501, 503);
    dup.run(3, 1, 500, 501);
    dup.run(3, 2, 502, 503);
    const repeated = await completeDouble(env, 50, 500);
    expect(repeated.status).toBe(400);
    expect(await msg(repeated)).toBe("第一循环存在重复交手，无法生成第二循环");

    // 第二循环已开打
    await del(env, "/api/admin/tournaments/50/stages/500/matches");
    await generate(env, 50, 500);
    await completeDouble(env, 50, 500);
    const secondRoundMatch = sqlGet<{ id: number }>(
      sqlite,
      "SELECT id FROM match WHERE stage_id = 500 AND round = 4 ORDER BY slot"
    )!;
    setStatus(sqlite, secondRoundMatch.id, "live");
    const started = await completeDouble(env, 50, 500);
    expect(started.status).toBe(409);
    expect(await msg(started)).toBe("第二循环已有开打或完赛的场次，不能覆盖重排");
    expect(countOf(sqlite, 500)).toBe(12); // 拒了就不删
  });

  it("阶段结构调整：draft/registering 可增删，running 一律拒绝", async () => {
    const draft = freshEnv();
    mkTournament(draft.sqlite, 52, "draft");
    mkEntries(draft.sqlite, 52, [520, 521, 522, 523]);
    mkStage(draft.sqlite, 520, 52, "elim", 1, { legs: 1 });

    const added = await post(draft.env, "/api/admin/tournaments/52/stages", { kind: "round_robin", loops: 2 });
    expect(added.status).toBe(201);
    expect(await added.json()).toEqual({ ok: true, stageId: 521, sortOrder: 2 });
    const removed = await del(draft.env, "/api/admin/tournaments/52/stages/520");
    expect(await removed.json()).toEqual({ ok: true });

    const running = freshEnv();
    mkTournament(running.sqlite, 50);
    mkEntries(running.sqlite, 50, [500, 501]);
    mkStage(running.sqlite, 500, 50, "elim", 1, { legs: 1 });
    const blockedAdd = await post(running.env, "/api/admin/tournaments/50/stages", { kind: "elim" });
    expect(blockedAdd.status).toBe(409);
    expect(await msg(blockedAdd)).toBe("赛事已开赛或已归档，不能再调整阶段结构");
    const blockedDel = await del(running.env, "/api/admin/tournaments/50/stages/500");
    expect(blockedDel.status).toBe(409);
    expect(await msg(blockedDel)).toBe("赛事已开赛或已归档，不能再调整阶段结构");

    const firstIsGroup = await post(draft.env, "/api/admin/tournaments/52/stages", { kind: "group" });
    expect(firstIsGroup.status).toBe(400);
    expect(await msg(firstIsGroup)).toBe("分组赛只能作为第一阶段");
  });
});
