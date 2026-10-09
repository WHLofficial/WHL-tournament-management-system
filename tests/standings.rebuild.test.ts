// 积分榜全量重建与同分规则：worker/lib/standings.ts。
// 设计口径（TECH_DESIGN §6）是不做增量累加——每场报分/改判/扣分都整阶段删表重建。
// 这里钉四件事：
//   1) 计分口径：胜 3 平 1 负 0、点球决胜（平局 + 点胜 2 分 / 点负 1 分）、双弃权不给分不计进失球、
//      扣分可为负（points_deduction 记录表，整表替换，可只作用于某个阶段）
//   2) 重建幂等与作用域：改判只反映最后结果；只统计本阶段 finished 场次；榜单只列已重建过的阶段
//   3) 排序链：pts → gd → gf → 相互战绩 → seed，链可由赛事配置改写（开赛后也可改）
//   4) 分组边界：小组阶段按组隔离；循环赛阶段却按 entry.group_id 分子块编号（缺陷 D3）
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { applyMigrations, createTestD1, createTestKV, sqlAll, sqlGet } from "./d1";

type Env = Record<string, unknown>;

type StandingRow = {
  entryId: number;
  teamName: string;
  seed: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  penWon: number;
  penLost: number;
  pts: number;
  pointsDeducted: number;
  rank: number;
};

type StageBoard = {
  stageId: number;
  kind: "group" | "round_robin";
  name: string | null;
  groups: { groupId: number | null; name: string; rows: StandingRow[] }[];
};

type StandingDbRow = {
  entry_id: number;
  group_id: number | null;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  pts: number;
  gf: number;
  ga: number;
  pen_won: number;
  pen_lost: number;
};

// 两个赛事共用 8 支球队：
//   赛事 8「联赛」纯循环赛：报名 600–605（group_id 全 NULL）
//     阶段 80 循环赛 / 82 淘汰赛 / 83 排名赛
//   赛事 9「杯赛」小组赛：报名 610–615（610/611→A 组 900、612/613→B 组 901、614/615 无组）
//     阶段 81 小组赛 / 84 排名赛（兼具小组与循环赛阶段，用于复现缺陷 D3）
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
  s.run(81, 9, "group", 1, "小组赛");
  s.run(84, 9, "round_robin", 2, "排名赛");
  const g = sqlite.prepare('INSERT INTO "group" (id, stage_id, name, sort_order) VALUES (?, 81, ?, ?)');
  g.run(900, "A 组", 1);
  g.run(901, "B 组", 2);

  const e = sqlite.prepare(
    "INSERT INTO entry (id, tournament_id, team_id, seed, group_id) VALUES (?, ?, ?, ?, ?)"
  );
  let seed = 1;
  for (const teamId of [10, 11, 12, 13, 14, 15]) e.run(599 + seed, 8, teamId, seed, null), seed++;
  const groupOf = [900, 900, 901, 901, null, null];
  [10, 11, 12, 13, 14, 15].forEach((teamId, i) => e.run(610 + i, 9, teamId, i + 1, groupOf[i]));

  const env: Env = {
    DB: createTestD1(sqlite),
    KV: createTestKV(new Map([["sess:tok-super", JSON.stringify({ userId: 1 })]])) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
  };
  return { env, sqlite };
}

const AUTH = { Cookie: "whl_session=tok-super", "Content-Type": "application/json" };

let nextMatchId = 800;
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

const finish = (env: Env, matchId: number, body: Record<string, unknown>): Promise<Response> =>
  app.request(
    `/api/admin/matches/${matchId}/finish`,
    { method: "POST", headers: AUTH, body: JSON.stringify(body) },
    env
  );

const patch = (env: Env, path: string, body: unknown) =>
  app.request(path, { method: "PATCH", headers: AUTH, body: JSON.stringify(body) }, env);

// 报分并断言成功，省掉每个用例的 status 检查噪音
async function shoot(env: Env, matchId: number, home: number, away: number, extra: Record<string, unknown> = {}) {
  const res = await finish(env, matchId, { scoreHome: home, scoreAway: away, ...extra });
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

// 榜单上出现的参赛方次序（跨组按返回次序拼接）
async function orderOf(env: Env, stageId: number, tid = 8): Promise<number[]> {
  const b = await boardOf(env, stageId, tid);
  return (b?.groups ?? []).flatMap((g) => g.rows.map((r) => r.entryId));
}

const dbRow = (sqlite: DatabaseSync, entryId: number, stageId = 80) =>
  sqlGet<StandingDbRow>(sqlite, "SELECT * FROM standing WHERE stage_id = ? AND entry_id = ?", stageId, entryId);

describe("积分榜重建：计分口径", () => {
  it("胜 3 平 1 负 0，进失球累计，未出场队伍记 0 行", async () => {
    const { env, sqlite } = freshEnv();
    await shoot(env, addMatch(sqlite, 80, 600, 601), 3, 1);
    await shoot(env, addMatch(sqlite, 80, 602, 603), 0, 0);
    await shoot(env, addMatch(sqlite, 80, 600, 602), 1, 2);

    expect(dbRow(sqlite, 600)).toMatchObject({
      played: 2,
      won: 1,
      drawn: 0,
      lost: 1,
      pts: 3,
      gf: 4,
      ga: 3,
      group_id: null,
    });
    expect(dbRow(sqlite, 603)).toMatchObject({ played: 1, drawn: 1, pts: 1, gf: 0, ga: 0 });
    expect(dbRow(sqlite, 602)).toMatchObject({ played: 2, won: 1, drawn: 1, lost: 0, pts: 4, gf: 2, ga: 1 });
    // 从未出场的两支也必须有行（前端要显示 0 分排位）
    expect(dbRow(sqlite, 604)).toMatchObject({ played: 0, pts: 0, gf: 0, ga: 0 });

    const b = await boardOf(env, 80);
    expect(b?.kind).toBe("round_robin");
    expect(b?.groups).toHaveLength(1); // 循环赛单组（groupId=null）
    expect(b?.groups[0].rows).toHaveLength(6);
    expect(b?.groups[0].rows.find((r) => r.entryId === 600)?.teamName).toBe("甲队");
    expect(b?.groups[0].rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("点球决胜：双方记平局，点胜 +2 分、点负 +1 分", async () => {
    const { env, sqlite } = freshEnv();
    await shoot(env, addMatch(sqlite, 80, 600, 601), 1, 1, { penHome: 5, penAway: 4 });
    expect(dbRow(sqlite, 600)).toMatchObject({ drawn: 1, pen_won: 1, pen_lost: 0, pts: 2, gf: 1, ga: 1 });
    expect(dbRow(sqlite, 601)).toMatchObject({ drawn: 1, pen_won: 0, pen_lost: 1, pts: 1, gf: 1, ga: 1 });
  });

  it("双方弃权：各记一场负、0 分，进失球不计", async () => {
    const { env, sqlite } = freshEnv();
    await shoot(env, addMatch(sqlite, 80, 600, 601), 0, 0, { walkoverSide: "both" });
    expect(dbRow(sqlite, 600)).toMatchObject({ played: 1, lost: 1, pts: 0, gf: 0, ga: 0 });
    expect(dbRow(sqlite, 601)).toMatchObject({ played: 1, lost: 1, pts: 0, gf: 0, ga: 0 });
    expect(dbRow(sqlite, 602)).toMatchObject({ played: 0, pts: 0 });
  });

  it("单方弃权：按 0:3 真实计分（胜方 +3 分与净胜球）", async () => {
    const { env, sqlite } = freshEnv();
    await shoot(env, addMatch(sqlite, 80, 600, 601), 0, 0, { walkoverSide: "home" });
    expect(dbRow(sqlite, 600)).toMatchObject({ played: 1, lost: 1, pts: 0, gf: 0, ga: 3 });
    expect(dbRow(sqlite, 601)).toMatchObject({ played: 1, won: 1, pts: 3, gf: 3, ga: 0 });
  });

  it("两回合交锋各算一场：主客各胜一场时同分，互相战绩也按两回合合计", async () => {
    const { env, sqlite } = freshEnv();
    const leg1 = addMatch(sqlite, 80, 600, 601);
    const leg2 = addMatch(sqlite, 80, 601, 600);
    sqlite.prepare("UPDATE match SET leg = 1 WHERE id = ?").run(leg1);
    sqlite.prepare("UPDATE match SET leg = 2 WHERE id = ?").run(leg2);
    await shoot(env, leg1, 1, 0);
    await shoot(env, leg2, 1, 0); // 第二回合主客互换，600 客场 1:0 取胜

    // 若把两回合当成一场（按对阵去重），这里就会是 played 1 / pts 3
    expect(dbRow(sqlite, 600)).toMatchObject({ played: 2, won: 1, lost: 1, pts: 3, gf: 1, ga: 1 });
    expect(dbRow(sqlite, 601)).toMatchObject({ played: 2, won: 1, lost: 1, pts: 3, gf: 1, ga: 1 });
    // 互相战绩把两回合都算进去（各 3 分、净胜球 0），咬平后回落到种子位
    expect(await orderOf(env, 80)).toEqual([600, 601, 602, 603, 604, 605]);
  });
});

describe("积分榜重建：幂等与作用域", () => {
  it("改判只反映最后结果（重建而非累加）", async () => {
    const { env, sqlite } = freshEnv();
    const mid = addMatch(sqlite, 80, 600, 601);
    await shoot(env, mid, 2, 0);
    expect(dbRow(sqlite, 600)).toMatchObject({ played: 1, won: 1, pts: 3, gf: 2, ga: 0 });

    await shoot(env, mid, 0, 2);
    expect(dbRow(sqlite, 600)).toMatchObject({ played: 1, won: 0, lost: 1, pts: 0, gf: 0, ga: 2 });
    expect(dbRow(sqlite, 601)).toMatchObject({ played: 1, won: 1, pts: 3, gf: 2, ga: 0 });
    expect(sqlAll(sqlite, "SELECT id FROM standing WHERE stage_id = 80")).toHaveLength(6);
  });

  it("只统计本阶段 finished 场次：他阶段战绩与 pending 场次都不入账", async () => {
    const { env, sqlite } = freshEnv();
    await shoot(env, addMatch(sqlite, 80, 600, 601), 4, 0);
    addMatch(sqlite, 80, 600, 602); // 未开打
    const other = addMatch(sqlite, 83, 600, 603);
    await shoot(env, other, 0, 5);

    expect(dbRow(sqlite, 600, 80)).toMatchObject({ played: 1, pts: 3, gf: 4, ga: 0 });
    expect(dbRow(sqlite, 600, 83)).toMatchObject({ played: 1, pts: 0, gf: 0, ga: 5 });
    expect(dbRow(sqlite, 603, 80)).toMatchObject({ played: 0, pts: 0 });
  });

  it("淘汰阶段不产出积分榜；从未报分的阶段不出现在榜单里", async () => {
    const { env, sqlite } = freshEnv();
    await shoot(env, addMatch(sqlite, 80, 600, 601), 1, 0);
    await shoot(env, addMatch(sqlite, 82, 600, 601), 1, 0); // 淘汰赛：赢了也不产生 standing

    // 榜单读的是 standing 快照表（readStandings），没重建过的阶段 83 直接缺席
    expect((await boards(env)).map((s) => s.stageId)).toEqual([80]);
    expect(dbRow(sqlite, 600, 83)).toBeUndefined();
  });
});

describe("积分榜重建：排序链", () => {
  it("默认链 pts → 净胜球 → 进球数 → 种子位", async () => {
    const { env, sqlite } = freshEnv();
    await shoot(env, addMatch(sqlite, 80, 600, 603), 3, 0); // 600: 3 分 净胜 +3 进 3
    await shoot(env, addMatch(sqlite, 80, 601, 604), 1, 0); // 601: 3 分 净胜 +1 进 1
    await shoot(env, addMatch(sqlite, 80, 602, 605), 1, 0); // 602: 3 分 净胜 +1 进 1
    // 601/602 净胜与进球完全相同，604/605 同为 0 分净胜 -1 进球 0，
    // 两对都没交过手（h2h 无从生效）→ 名次只能由种子位决定；603 净胜 -3 垫底
    expect(await orderOf(env, 80)).toEqual([600, 601, 602, 604, 605, 603]);
    expect((await boardOf(env, 80))!.groups[0].rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("相互战绩优先于种子位兜底（默认链含 h2h）", async () => {
    const { env, sqlite } = freshEnv();
    // 三队同积 3 分且净胜球都是 0：602 进球 3 排头名，600/601 同净胜同进球 → 直接对话定先后
    await shoot(env, addMatch(sqlite, 80, 600, 601), 0, 1); // 601 胜
    await shoot(env, addMatch(sqlite, 80, 600, 602), 2, 1); // 600 胜
    await shoot(env, addMatch(sqlite, 80, 601, 602), 1, 2); // 602 胜
    expect(dbRow(sqlite, 600)).toMatchObject({ pts: 3, gf: 2, ga: 2 });
    expect(dbRow(sqlite, 601)).toMatchObject({ pts: 3, gf: 2, ga: 2 });
    expect(dbRow(sqlite, 602)).toMatchObject({ pts: 3, gf: 3, ga: 3 });

    // 601 排在 600 之前 = h2h 生效（只比种子位会让 600 排前）
    expect(await orderOf(env, 80)).toEqual([602, 601, 600, 603, 604, 605]);
  });

  it("同分规则可配置：链可缩减；全非法值/空数组回退默认链，哨兵 [\"none\"] 表达不启用（缺陷 D4）", async () => {
    const { env, sqlite } = freshEnv();
    await shoot(env, addMatch(sqlite, 80, 600, 601), 0, 1);
    await shoot(env, addMatch(sqlite, 80, 600, 602), 2, 1);
    await shoot(env, addMatch(sqlite, 80, 601, 602), 1, 2);

    const res = await patch(env, "/api/admin/tournaments/8", { tiebreakers: ["gd", "gf"] });
    expect(res.status).toBe(200);
    expect((await orderOf(env, 80)).slice(0, 3)).toEqual([602, 600, 601]);

    // 缺陷 D4 修复（哨兵方案）：
    // - 全非法值 / 空数组 → 回退默认链（与 normalizeTiebreakers 注释契约一致，不再退化空链）；
    // - 显式「不启用」用哨兵 ["none"] 表达 → 空链，同分只剩种子位兜底。
    await patch(env, "/api/admin/tournaments/8", { tiebreakers: ["gd", "gf", "h2h"] });
    const byDefault = await orderOf(env, 80);

    await patch(env, "/api/admin/tournaments/8", { tiebreakers: ["nonsense", "nope"] });
    expect(await orderOf(env, 80)).toEqual(byDefault);
    await patch(env, "/api/admin/tournaments/8", { tiebreakers: [] });
    expect(await orderOf(env, 80)).toEqual(byDefault);

    await patch(env, "/api/admin/tournaments/8", { tiebreakers: ["none"] });
    expect((await orderOf(env, 80)).slice(0, 3)).toEqual([600, 601, 602]);
  });

  it("榜单接口返回生效的同分链（缺陷 D6：默认 / 自定义 / 哨兵三态）", async () => {
    const { env } = freshEnv();

    const adminTb = async () => {
      const res = await app.request("/api/admin/tournaments/8/standings", { headers: AUTH }, env);
      expect(res.status).toBe(200);
      return ((await res.json()) as { tiebreakers: string[] }).tiebreakers;
    };

    // 缺省配置 → 默认链；响应带 tiebreakers 字段供页脚渲染
    expect(await adminTb()).toEqual(["gd", "gf", "h2h"]);
    await patch(env, "/api/admin/tournaments/8", { tiebreakers: ["h2h"] });
    expect(await adminTb()).toEqual(["h2h"]);
    // 哨兵「不启用」→ 空数组；公开端与管理端口径一致
    await patch(env, "/api/admin/tournaments/8", { tiebreakers: ["none"] });
    expect(await adminTb()).toEqual([]);
    // 公开端 pubCache 需要 caches.default + executionCtx，测试环境补最小桩（同 assign.test）
    (globalThis as unknown as { caches: unknown }).caches ??= {
      default: { match: async () => undefined, put: async () => {} },
    };
    const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;
    const pub = await app.request("/api/public/tournaments/8/standings", {}, env, execCtx);
    expect(pub.status).toBe(200);
    expect(((await pub.json()) as { tiebreakers: string[] }).tiebreakers).toEqual([]);
  });

  it("只配 h2h 时，互相咬住的循环小圈回落到种子位", async () => {
    const { env, sqlite } = freshEnv();
    await shoot(env, addMatch(sqlite, 80, 600, 601), 0, 1);
    await shoot(env, addMatch(sqlite, 80, 600, 602), 2, 1);
    await shoot(env, addMatch(sqlite, 80, 601, 602), 1, 2);
    await patch(env, "/api/admin/tournaments/8", { tiebreakers: ["h2h"] });
    // 三队 h2h 各 3 分、h2h 净胜同为 0 → 只能靠种子位收场
    expect((await orderOf(env, 80)).slice(0, 3)).toEqual([600, 601, 602]);
  });

  it("链顺序生效：净胜球占优与进球数占优在两种链下名次互换", async () => {
    const { env, sqlite } = freshEnv();
    await shoot(env, addMatch(sqlite, 80, 600, 601), 5, 1); // 600: 3 分 净胜 +4 进 5
    await shoot(env, addMatch(sqlite, 80, 602, 603), 9, 8); // 602: 3 分 净胜 +1 进 9

    const gdFirst = await orderOf(env, 80); // 默认链先比净胜球
    expect(gdFirst.indexOf(600)).toBeLessThan(gdFirst.indexOf(602));

    await patch(env, "/api/admin/tournaments/8", { tiebreakers: ["gf", "gd"] });
    const gfFirst = await orderOf(env, 80);
    expect(gfFirst.indexOf(602)).toBeLessThan(gfFirst.indexOf(600));
  });
});

describe("积分榜重建：小组、循环赛共存与扣分", () => {
  it("小组阶段按组隔离排名，各组 rank 从 1 起，未分组队伍不入榜", async () => {
    const { env, sqlite } = freshEnv();
    await shoot(env, addMatch(sqlite, 81, 610, 611), 5, 0); // A 组
    await shoot(env, addMatch(sqlite, 81, 612, 613), 1, 0); // B 组

    const b = await boardOf(env, 81, 9);
    expect(b?.kind).toBe("group");
    expect(b?.groups.map((g) => g.name)).toEqual(["A 组", "B 组"]);
    const [a, bb] = b!.groups;
    expect(a.rows.map((r) => [r.entryId, r.rank])).toEqual([
      [610, 1],
      [611, 2],
    ]);
    expect(bb.rows.map((r) => [r.entryId, r.rank])).toEqual([
      [612, 1],
      [613, 2],
    ]);
    // 614/615 没有 group_id → 不进小组阶段积分榜
    expect(a.rows.length + bb.rows.length).toBe(4);
    // A 组的 5:0 不得污染 B 组
    expect(bb.rows[0]).toMatchObject({ goalsFor: 1, goalsAgainst: 0 });
  });

  it("缺陷 D3：同赛事既有小组又有循环赛时，循环赛榜单名次全表唯一 1..N，不受 entry.group_id 残留影响", async () => {
    const { env, sqlite } = freshEnv();
    await shoot(env, addMatch(sqlite, 84, 610, 611), 3, 0);

    const b = await boardOf(env, 84, 9); // 赛事 9 的排名赛（round_robin）
    expect(b?.kind).toBe("round_robin");
    expect(b?.groups).toHaveLength(1); // 对外只呈现一组
    const rows = b!.groups[0].rows;
    // 读侧按阶段类型分桶：round_robin 阶段整表单桶，名次唯一 1..6（修复前是 1,1,1,2,2,2）
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    // 顺序是全局积分序：610 三分居首；其余 0 分比同分链，611 净胜 -3 垫底
    expect(rows.map((r) => r.entryId)).toEqual([610, 612, 613, 614, 615, 611]);
    // group_id 仍原样写库——改的只是读侧分桶，不动历史数据
    expect(dbRow(sqlite, 610, 84)).toMatchObject({ pts: 3, group_id: 900 });
  });

  it("扣分记录整表替换并立即重建（可为负分，[] 清除，可只作用于某阶段）", async () => {
    const { env, sqlite } = freshEnv();
    await shoot(env, addMatch(sqlite, 80, 600, 601), 3, 1);
    expect(dbRow(sqlite, 600)!.pts).toBe(3);

    const deduct = (items: unknown[]) =>
      patch(env, "/api/admin/tournaments/8/entries/600/deduction", { items });

    expect((await deduct([{ points: 3, stageId: null }])).status).toBe(200);
    expect(dbRow(sqlite, 600)!.pts).toBe(0);

    await deduct([{ points: 10, stageId: 80 }]);
    expect(dbRow(sqlite, 600)!.pts).toBe(-7); // 扣分超过得分 → 负分
    const row = (await boardOf(env, 80))!.groups[0].rows.find((r) => r.entryId === 600);
    expect(row).toMatchObject({ pts: -7, pointsDeducted: 10 });

    // 同一支队允许多条：全赛事 5 分 + 本阶段 1 分 = 本阶段共扣 6 分
    await deduct([{ points: 5, stageId: null }, { points: 1, stageId: 80 }]);
    expect(dbRow(sqlite, 600)!.pts).toBe(-3);
    expect(
      (await boardOf(env, 80))!.groups[0].rows.find((r) => r.entryId === 600)
    ).toMatchObject({ pts: -3, pointsDeducted: 6 });

    // 指定后面那个阶段（83 排名赛）→ 阶段 80 这张榜分文不动
    await deduct([{ points: 4, stageId: 83 }]);
    expect(dbRow(sqlite, 600)!.pts).toBe(3);

    await deduct([]);
    expect(dbRow(sqlite, 600)!.pts).toBe(3);
    expect(
      (await boardOf(env, 80))!.groups[0].rows.find((r) => r.entryId === 600)
    ).toMatchObject({ pts: 3, pointsDeducted: 0 });

    expect((await deduct([{ points: 0, stageId: null }])).status).toBe(400);
    expect((await deduct([{ points: 1000, stageId: null }])).status).toBe(400);
    expect((await deduct([{ points: 1.5, stageId: null }])).status).toBe(400);
    // 阶段限定：淘汰赛没有积分榜，别的赛事的阶段也不行；stageId 不合法要挡在写库之前
    expect((await deduct([{ points: 1, stageId: 82 }])).status).toBe(400);
    expect((await deduct([{ points: 1, stageId: 81 }])).status).toBe(400);
    expect((await deduct([{ points: 1, stageId: 999999 }])).status).toBe(400);
    expect((await deduct(new Array(21).fill({ points: 1, stageId: null }))).status).toBe(400);
    // 旧 body 形状（单个 points）不再接受，避免旧前端静默改错语义
    expect((await patch(env, "/api/admin/tournaments/8/entries/600/deduction", { points: 2 })).status).toBe(400);
    expect(
      (await patch(env, "/api/admin/tournaments/8/entries/999/deduction", {
        items: [{ points: 1, stageId: null }],
      })).status
    ).toBe(404);
  });

  it("扣分后改判仍保留扣分（重建时按 points_deduction 现算）", async () => {
    const { env, sqlite } = freshEnv();
    const mid = addMatch(sqlite, 80, 600, 601);
    await shoot(env, mid, 3, 1);
    await patch(env, "/api/admin/tournaments/8/entries/600/deduction", {
      items: [{ points: 2, stageId: null }],
    });
    expect(dbRow(sqlite, 600)!.pts).toBe(1);

    await shoot(env, mid, 5, 0);
    expect(dbRow(sqlite, 600)!.pts).toBe(1); // 3 分 - 扣 2
    expect(dbRow(sqlite, 601)!.pts).toBe(0);
  });

  it("扣分进入排序键：同分同净胜球时给 600 扣 1 分即被 601 反超", async () => {
    const { env, sqlite } = freshEnv();
    await shoot(env, addMatch(sqlite, 80, 600, 601), 1, 1); // 1:1 → 两队 pts 1 / gd 0 / gf 1
    expect(await orderOf(env, 80)).toEqual([600, 601, 602, 603, 604, 605]); // 咬平后按种子位

    const deduct = await patch(env, "/api/admin/tournaments/8/entries/600/deduction", {
      items: [{ points: 1, stageId: null }],
    });
    expect(deduct.status).toBe(200);
    expect(dbRow(sqlite, 600)).toMatchObject({ pts: 0 }); // 1 分 - 扣 1；扣分原值在 points_deduction
    // 名次真的动了（不只是分数显示变化）
    expect(await orderOf(env, 80)).toEqual([601, 600, 602, 603, 604, 605]);
    const row = (await boardOf(env, 80))!.groups[0].rows.find((r) => r.entryId === 600);
    expect(row).toMatchObject({ rank: 2, pts: 0, pointsDeducted: 1 });
  });
});
