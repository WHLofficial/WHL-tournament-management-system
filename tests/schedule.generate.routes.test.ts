// 赛程编排路由级回归：阶段赛程生成（淘汰/循环/小组）、抽签、名次取人、
// 清空与补全双循环、阶段结构调整。
// 算法本体（seeding.ts 的 seedOrder / roundRobinSchedule / buildElimPlan / drawGroups）
// 目前没有独立的纯函数测试文件，本文件是通过路由间接覆盖其结论的第一处覆盖；
// 这里钉的是「算法结论 → 写库结果」这一段：种子号到 entry 的映射、轮空预填、
// 重生成清空、各守卫的中文报错与状态码。
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { completeDoubleOrder } from "../worker/lib/doubleSchedule";
import { recoverScheduleJobs } from "../worker/lib/schedule-jobs";
import type { Bindings } from "../worker/env";
import { applyMigrations, createTestDb, createTestD1, createTestKV, sqlAll, sqlGet } from "./d1";

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

const generate = (env: Env, tid: number, stageId: number, body: Record<string, unknown> = {}) =>
  post(env, `/api/admin/tournaments/${tid}/stages/${stageId}/generate`, body);
const get = (env: Env, path: string) => app.request(path, { headers: AUTH }, env);
const jobUrl = (tid: number, stageId: number, jobId: number | string) =>
  `/api/admin/tournaments/${tid}/stages/${stageId}/schedule-jobs/${jobId}`;
const draw = (env: Env, tid: number, stageId: number) =>
  post(env, `/api/admin/tournaments/${tid}/stages/${stageId}/draw`, {});
const completeDouble = (env: Env, tid: number, stageId: number, body: Record<string, unknown> = {}) =>
  post(env, `/api/admin/tournaments/${tid}/stages/${stageId}/complete-double`, body);
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

// 手工插一条 schedule_job（复用/409 守卫用例要的是「活跃中」状态；
// 路由内联执行的任务到达不了断言时刻——POST 返回时已 done）
function mkJob(
  sqlite: DatabaseSync,
  id: number,
  tid: number,
  stageId: number,
  mode: "mirror" | "asymmetric",
  status: "pending" | "running"
) {
  sqlite
    .prepare(
      "INSERT INTO schedule_job (id, tournament_id, stage_id, kind, mode, status, seed, budget_ms, created_at) VALUES (?, ?, ?, 'generate_double', ?, ?, 42, 15000, ?)"
    )
    .run(id, tid, stageId, mode, status, ISO);
}

type JobResponse = {
  id: number;
  kind: string;
  mode: string;
  status: string;
  result: {
    created?: number;
    rounds?: number;
    mode?: string;
    balanced?: boolean;
    violations?: { hard: unknown[]; soft: unknown[] };
    asymmetric?: { nonMirrorRounds: number; swaps: number; ms: number };
    kickoffCleared?: number;
    warnings?: string[];
  } | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

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

  it("loops=2：202 + jobId，内联执行后 GET job 为 done 且 result 齐全", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 46);
    mkEntries(sqlite, 46, [460, 461, 462, 463]);
    mkStage(sqlite, 460, 46, "round_robin", 1, { loops: 2 });

    const res = await generate(env, 46, 460);
    expect(res.status).toBe(202);
    const { jobId, status } = (await res.json()) as { jobId: number; status: string };
    expect(jobId).toBeGreaterThan(0);
    expect(status).toBe("done"); // vitest 无 ExecutionContext，内联执行：POST 返回时任务已结束（spec §6.6）

    const jobRes = await get(env, jobUrl(46, 460, jobId));
    expect(jobRes.status).toBe(200);
    const job = (await jobRes.json()) as JobResponse;
    expect(job.id).toBe(jobId);
    expect(job.kind).toBe("generate_double");
    expect(job.mode).toBe("asymmetric"); // 请求/配置都未指定 → 默认 asymmetric（spec §4.1）
    expect(job.status).toBe("done");
    expect(job.error).toBeNull();
    expect(job.startedAt).toBeTruthy();
    expect(job.finishedAt).toBeTruthy();
    expect(job.result?.created).toBe(12);
    expect(job.result?.rounds).toBe(6);
    expect(job.result?.mode).toBe("asymmetric");
    expect(job.result?.balanced).toBe(true);
    expect(job.result?.kickoffCleared).toBe(0);
    expect(typeof job.result?.asymmetric?.nonMirrorRounds).toBe("number");
    expect(job.result?.violations?.hard).toEqual([]);

    const rows = rowsOf(sqlite, 460);
    expect(rows).toHaveLength(12);
    for (const [a, b] of [[460, 461], [460, 462], [460, 463], [461, 462], [461, 463], [462, 463]] as const) {
      const forward = rows.filter((r) => r.home_entry_id === a && r.away_entry_id === b);
      const backward = rows.filter((r) => r.home_entry_id === b && r.away_entry_id === a);
      expect(forward).toHaveLength(1);
      expect(backward).toHaveLength(1);
    }
  });

  it("loops=2 复用：活跃任务同 mode 再 POST 返回同一 jobId 与当前状态（202）", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 46);
    mkEntries(sqlite, 46, [460, 461, 462, 463]);
    mkStage(sqlite, 460, 46, "round_robin", 1, { loops: 2 });
    mkJob(sqlite, 9001, 46, 460, "asymmetric", "pending");

    const res = await generate(env, 46, 460);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ jobId: 9001, status: "pending" });

    // running 同样复用，状态原样回显；不创建第二条任务
    sqlite.prepare("UPDATE schedule_job SET status = 'running' WHERE id = 9001").run();
    const res2 = await generate(env, 46, 460);
    expect(res2.status).toBe(202);
    expect(await res2.json()).toEqual({ jobId: 9001, status: "running" });
    const jobs = sqlAll<{ id: number }>(sqlite, "SELECT id FROM schedule_job");
    expect(jobs).toHaveLength(1);
  });

  it("复用（真实任务回拨）：POST 拿 jobId → 手工回拨 pending → 再 POST 返回同一 jobId 且不重跑", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 46);
    mkEntries(sqlite, 46, [460, 461, 462, 463]);
    mkStage(sqlite, 460, 46, "round_robin", 1, { loops: 2 });

    const res1 = await generate(env, 46, 460);
    const { jobId } = (await res1.json()) as { jobId: number };
    expect(jobId).toBeGreaterThan(0);

    // 模拟「任务卡在 pending」：路由自建的任务回拨状态
    sqlite.prepare("UPDATE schedule_job SET status = 'pending' WHERE id = ?").run(jobId);

    const res2 = await generate(env, 46, 460);
    expect(res2.status).toBe(202);
    // 复用分支只回显当前状态、不重复创建也不重跑（spec §6.2）
    expect(await res2.json()).toEqual({ jobId, status: "pending" });
    expect(sqlAll<{ id: number }>(sqlite, "SELECT id FROM schedule_job")).toHaveLength(1);
    const job = (await (await get(env, jobUrl(46, 460, jobId))).json()) as JobResponse;
    expect(job.status).toBe("pending"); // 复用路径不触发执行
  });

  it("loops=1 仍同步且不建 job：POST 200 同步响应、schedule_job 无行（spec §9.2）", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 46);
    mkEntries(sqlite, 46, [460, 461, 462, 463, 464, 465, 466, 467]);
    mkStage(sqlite, 460, 46, "round_robin", 1, { loops: 1 });

    const res = await generate(env, 46, 460);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: number; rounds: number; balanced: boolean };
    expect(body.created).toBe(28);
    expect(body.rounds).toBe(7);
    expect(body.balanced).toBe(true);
    expect(sqlAll<{ id: number }>(sqlite, "SELECT id FROM schedule_job")).toHaveLength(0);
  });

  it("loops=2 冲突：活跃任务不同 mode → 409；同 mode 的显式请求复用 → 202", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 46);
    mkEntries(sqlite, 46, [460, 461, 462, 463]);
    mkStage(sqlite, 460, 46, "round_robin", 1, { loops: 2 });
    mkJob(sqlite, 9001, 46, 460, "mirror", "pending");

    const res = await generate(env, 46, 460); // 默认 asymmetric ≠ mirror
    expect(res.status).toBe(409);
    expect(await msg(res)).toBe("该阶段已有另一种模式的任务在跑");

    const res2 = await generate(env, 46, 460, { mode: "mirror" });
    expect(res2.status).toBe(202);
    expect(await res2.json()).toEqual({ jobId: 9001, status: "pending" });
  });

  it("job 状态查询：错误赛事/阶段/jobId 一律 404；latest 空阶段 404、有任务 200、跨赛事 404", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 46);
    mkEntries(sqlite, 46, [460, 461, 462, 463]);
    mkStage(sqlite, 460, 46, "round_robin", 1, { loops: 2 });
    mkStage(sqlite, 461, 46, "round_robin", 2, { loops: 1 });

    // 460 还没有任务
    const emptyLatest = await get(env, jobUrl(46, 460, "latest"));
    expect(emptyLatest.status).toBe(404);

    const res = await generate(env, 46, 460);
    const { jobId } = (await res.json()) as { jobId: number };

    expect((await get(env, jobUrl(47, 460, jobId))).status).toBe(404); // 错误赛事
    expect((await get(env, jobUrl(46, 461, jobId))).status).toBe(404); // 错误阶段
    expect((await get(env, jobUrl(46, 460, 99999))).status).toBe(404); // 不存在的 jobId

    const latest = await get(env, jobUrl(46, 460, "latest"));
    expect(latest.status).toBe(200);
    expect(((await latest.json()) as JobResponse).id).toBe(jobId);
  });

  it("latest 返回最近任务的完整形状（done + result 概要）", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 46);
    mkEntries(sqlite, 46, [460, 461, 462, 463]);
    mkStage(sqlite, 460, 46, "round_robin", 1, { loops: 2 });

    await generate(env, 46, 460);
    const latest = await get(env, jobUrl(46, 460, "latest"));
    expect(latest.status).toBe(200);
    const job = (await latest.json()) as JobResponse;
    expect(job.status).toBe("done");
    expect(job.kind).toBe("generate_double");
    expect(job.mode).toBe("asymmetric");
    expect(job.result?.created).toBe(12);
    expect(job.result?.rounds).toBe(6);
    expect(job.result?.mode).toBe("asymmetric");
  });

  it("loops=2 失败不写入：n=4 mirror 结构性无解 → job=failed，旧赛程保留", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 46);
    mkEntries(sqlite, 46, [460, 461, 462, 463]);
    mkStage(sqlite, 460, 46, "round_robin", 1, { loops: 2 });

    // 先用默认 asymmetric 生成成功（12 场）
    await generate(env, 46, 460);
    const before = rowsOf(sqlite, 460);
    expect(before).toHaveLength(12);

    // mirror 在 n=4 双循环下 hard>0 结构性无解（见 tests/doubleSchedule.test.ts）→ 失败
    const res = await generate(env, 46, 460, { mode: "mirror" });
    expect(res.status).toBe(202);
    const { jobId, status } = (await res.json()) as { jobId: number; status: string };
    expect(status).toBe("failed");

    const job = (await (await get(env, jobUrl(46, 460, jobId))).json()) as JobResponse;
    expect(job.status).toBe("failed");
    expect(job.error).toBe("未能满足硬约束");
    expect(job.finishedAt).toBeTruthy();
    expect(job.result?.balanced).toBe(false);
    expect(job.result?.violations?.hard?.length).toBeGreaterThan(0);

    // 失败不写入：场次集合与失败前完全一致
    expect(rowsOf(sqlite, 460)).toEqual(before);
  });

  it("loops=2 kickoffCleared：旧场次带 kickoff_* 标注 → 重建后清零且计数正确", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 46);
    mkEntries(sqlite, 46, [460, 461, 462, 463]);
    mkStage(sqlite, 460, 46, "round_robin", 1, { loops: 2 });
    // 预置旧场次并打上开球标注（0031 的 kickoff_* 列）
    sqlite
      .prepare(
        "INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status, kickoff_week, kickoff_day, kickoff_time) VALUES (800, 460, 1, 1, 460, 461, 'pending', 3, 6, '21:00')"
      )
      .run();

    const res = await generate(env, 46, 460);
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: number };
    const job = (await (await get(env, jobUrl(46, 460, jobId))).json()) as JobResponse;
    expect(job.status).toBe("done");
    expect(job.result?.kickoffCleared).toBe(1);
    expect(job.result?.created).toBe(12);

    // 重建后：旧标注随 DELETE 清空，全部场次 kickoff_* 为空
    const marked = sqlGet<{ n: number }>(
      sqlite,
      "SELECT COUNT(*) AS n FROM match WHERE stage_id = 460 AND (kickoff_week IS NOT NULL OR kickoff_day IS NOT NULL OR kickoff_time IS NOT NULL)"
    );
    expect(marked?.n).toBe(0);
  });

  it("预检失败不建 job：取人来源未完赛 → 400，schedule_job 无行", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 46);
    mkEntries(sqlite, 46, [460, 461, 462, 463]);
    mkStage(sqlite, 450, 46, "round_robin", 1, { loops: 1, source: { take: 2 } });
    mkStage(sqlite, 460, 46, "round_robin", 2, { loops: 2, source: { take: 2, fromStage: 450 } });
    mkEntries(sqlite, 46, [450, 451, 452, 453], undefined, 44);

    const res = await generate(env, 46, 460); // 来源阶段还没完赛 → takeRangePool 抛 400
    expect(res.status).toBe(400);
    expect(await msg(res)).toBe("取人来源阶段尚未全部完赛，还不能按名次取人生成");
    // 预检失败发生在建 job 之前：schedule_job 无任何行
    expect(sqlAll<{ id: number }>(sqlite, "SELECT id FROM schedule_job")).toHaveLength(0);
  });

  it("阶段已开打 → 409 不建 job；已有 done 任务行原样保留", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 46);
    mkEntries(sqlite, 46, [460, 461, 462, 463]);
    mkStage(sqlite, 460, 46, "round_robin", 1, { loops: 2 });
    await generate(env, 46, 460); // done 任务一行
    setStatus(
      sqlite,
      sqlGet<{ id: number }>(sqlite, "SELECT id FROM match WHERE stage_id = 460 LIMIT 1")!.id,
      "live"
    );

    const res = await generate(env, 46, 460);
    expect(res.status).toBe(409);
    expect(await msg(res)).toBe("该阶段已有开打或完赛的场次，不能重新生成");
    // 路由预检在建 job 之前拒绝：不新增 job 行
    expect(sqlAll<{ id: number }>(sqlite, "SELECT id FROM schedule_job")).toHaveLength(1);
  });

  it("活跃 job 期间：loops=1 与 group 的 generate、complete-double 都 409", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 46);
    mkEntries(sqlite, 46, [460, 461, 462, 463]);
    mkStage(sqlite, 460, 46, "round_robin", 1, { loops: 1 });
    mkStage(sqlite, 470, 46, "group", 2, { group_count: 2, group_size: 2, loops: 1 });
    mkGroups(sqlite, 470, ["A", "B"]);
    setGroup(sqlite, 460, 900);
    setGroup(sqlite, 461, 900);
    setGroup(sqlite, 462, 901);
    setGroup(sqlite, 463, 901);

    // loops=1：活跃 job → 409
    mkJob(sqlite, 9001, 46, 460, "asymmetric", "pending");
    const res = await generate(env, 46, 460);
    expect(res.status).toBe(409);
    expect(await msg(res)).toBe("该阶段已有双循环生成任务在跑，请等它结束");

    // group：活跃 job → 409
    mkJob(sqlite, 9002, 46, 470, "asymmetric", "pending");
    const resGroup = await generate(env, 46, 470);
    expect(resGroup.status).toBe(409);
    expect(await msg(resGroup)).toBe("该阶段已有双循环生成任务在跑，请等它结束");

    // complete-double：独立 stage 先同步生成第一循环（无活跃 job），再插活跃 job → 409
    mkStage(sqlite, 480, 46, "round_robin", 3, { loops: 1 });
    mkEntries(sqlite, 46, [480, 481, 482, 483], undefined, 44);
    const first = await generate(env, 46, 480);
    expect(first.status).toBe(200);
    mkJob(sqlite, 9003, 46, 480, "asymmetric", "pending");
    const resCd = await completeDouble(env, 46, 480);
    expect(resCd.status).toBe(409);
    expect(await msg(resCd)).toBe("该阶段已有双循环生成任务在跑，请等它结束");
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

  it("group loops=2（默认 asymmetric）：balanced=true，每组双循环（软约束告警允许）", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 47);
    mkEntries(sqlite, 47, [470, 471, 472, 473, 474, 475, 476, 477]);
    mkStage(sqlite, 470, 47, "group", 1, {
      group_count: 2,
      group_size: 4,
      loops: 2,
      qualify_per_group: 2,
    });
    mkGroups(sqlite, 470, ["A", "B"]);
    for (const e of [470, 471, 472, 473]) setGroup(sqlite, e, 900);
    for (const e of [474, 475, 476, 477]) setGroup(sqlite, e, 901);

    const res = await generate(env, 47, 470);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      created: number;
      rounds: number;
      skippedGroups: string[];
      balanced: boolean;
      warnings: string[];
    };
    expect(body.balanced).toBe(true); // 两组 hard=0
    // 软约束（前两场同侧）是 best-effort（§5.2/§5.5）：为最大化 nonMirrorRounds 允许保留，
    // 因此告警只断言「不含硬违例（三连/末两场）」，而不是要求空数组。
    for (const w of body.warnings) expect(w).toMatch(/两主开始|两客开始/);
    expect(body.created).toBe(24); // 2 组 × 4 队双循环各 12 场
    expect(body.rounds).toBe(6);
  });

  it("group loops=2 单组 unbalanced（mirror n=4 结构性无解）：不阻塞写入，warnings 按组名报违例", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 47);
    mkEntries(sqlite, 47, [470, 471, 472, 473, 474, 475, 476, 477]);
    mkStage(sqlite, 470, 47, "group", 1, {
      group_count: 2,
      group_size: 4,
      loops: 2,
      qualify_per_group: 2,
    });
    mkGroups(sqlite, 470, ["A", "B"]);
    for (const e of [470, 471, 472, 473]) setGroup(sqlite, e, 900);
    for (const e of [474, 475, 476, 477]) setGroup(sqlite, e, 901);

    const res = await generate(env, 47, 470, { mode: "mirror" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: number; balanced: boolean; warnings: string[] };
    expect(body.balanced).toBe(false); // 两组都是 n=4 mirror → hard>0
    // mirror 失败态每组有多条违例（streak/lastTwo/firstTwo 各按队计），按组名前缀归组
    expect(body.warnings.filter((w) => w.startsWith("A 组：")).length).toBeGreaterThan(0);
    expect(body.warnings.filter((w) => w.startsWith("B 组：")).length).toBeGreaterThan(0);
    expect(body.warnings.every((w) => /^(A|B) 组：team \d+ (三连|两)(主|客)/.test(w))).toBe(true);
    // 单组 unbalanced 不阻塞：照常写入
    expect(body.created).toBe(24);
    expect(countOf(sqlite, 470)).toBe(24);
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

  it("complete-double asymmetric（默认）：200 同步、order 是排列、同对主客对调 slot 相同、轮次映射是双射", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 50);
    mkEntries(sqlite, 50, [500, 501, 502, 503]);
    mkStage(sqlite, 500, 50, "round_robin", 1, { loops: 1 });
    await generate(env, 50, 500);
    const firstLoop = rowsOf(sqlite, 500);
    expect(firstLoop).toHaveLength(6);

    const res = await completeDouble(env, 50, 500);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      created: number;
      deleted: number;
      mode: string;
      order: number[];
      seed: number | null;
      kickoffCleared: number;
      warnings: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.created).toBe(6);
    expect(body.deleted).toBe(0);
    expect(body.mode).toBe("asymmetric"); // 未指定 mode → 默认 asymmetric（spec §4.1）
    expect([...body.order].sort((a, b) => a - b)).toEqual([0, 1, 2]); // 0..k-1 的排列
    expect(body.order.some((v, i) => v !== i)).toBe(true); // k>1 保证非 identity
    expect(typeof body.seed).toBe("number");
    expect(body.kickoffCleared).toBe(0);
    expect(body.warnings).toEqual([]);

    const rows = rowsOf(sqlite, 500);
    expect(rows).toHaveLength(12);
    // 第一循环 m.round → 第二循环 k + order[m.round-1] + 1（spec §5.7 第 6 步）；主客对调、slot 保留
    for (const m of firstLoop) {
      const mirror = rows.find(
        (r) => r.home_entry_id === m.away_entry_id && r.away_entry_id === m.home_entry_id && r.slot === m.slot
      );
      expect(mirror).toBeDefined();
      expect(mirror!.round).toBe(3 + body.order[m.round - 1] + 1);
    }
    // 轮次映射是双射：第二循环轮次恰为 4..6
    const secondRounds = new Set(rows.filter((r) => r.round > 3).map((r) => r.round));
    expect(secondRounds).toEqual(new Set([4, 5, 6]));
  });

  it("complete-double mirror：order=[0..k-1]、seed=null、round=m.round+k", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 50);
    mkEntries(sqlite, 50, [500, 501, 502, 503]);
    mkStage(sqlite, 500, 50, "round_robin", 1, { loops: 1 });
    await generate(env, 50, 500);
    const firstLoop = rowsOf(sqlite, 500);

    const res = await completeDouble(env, 50, 500, { mode: "mirror" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      created: number;
      deleted: number;
      mode: string;
      order: number[];
      seed: number | null;
      kickoffCleared: number;
      warnings: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("mirror");
    expect(body.order).toEqual([0, 1, 2]); // 正向镜像恒等序（spec §5.6）
    expect(body.seed).toBeNull(); // mirror 不用 seed
    expect(body.warnings).toEqual([]);

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

  it("complete-double 换 seed：order 变化（k>=3）；不带 seed 幂等（行集合与 seed 一致）", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 50);
    mkEntries(sqlite, 50, [500, 501, 502, 503]);
    mkStage(sqlite, 500, 50, "round_robin", 1, { loops: 1 });
    await generate(env, 50, 500);

    const first = (await (await completeDouble(env, 50, 500)).json()) as {
      order: number[];
      seed: number;
    };
    const before = rowsOf(sqlite, 500).map((r) => [r.round, r.slot, r.home_entry_id, r.away_entry_id]);

    // 换 seed → order 变化：确定性构造——在候选序列（0,1,2,…）中找一个经本地复算
    // completeDoubleOrder(k,{seed}) 产生不同 order 的显式 seed，既测「显式 seed 生效」又保证非相等
    const k = 3;
    let pickedSeed: number | null = null;
    let expectedOrder: number[] = [];
    for (let s = 0; s < 64; s++) {
      const candidate = completeDoubleOrder(k, { seed: s }).order;
      if (candidate.some((v, i) => v !== first.order[i])) {
        pickedSeed = s;
        expectedOrder = candidate;
        break;
      }
    }
    expect(pickedSeed).not.toBeNull();

    const reseeded = (await (await completeDouble(env, 50, 500, { seed: pickedSeed! })).json()) as {
      order: number[];
      seed: number;
    };
    expect(reseeded.seed).toBe(pickedSeed);
    expect(reseeded.order).toEqual(expectedOrder); // 显式 seed 原样生效，且与本地复算一致
    expect(reseeded.order).not.toEqual(first.order);

    // 不带 seed：默认 seed 由第一循环哈希决定 → 与第一次完全一致（幂等，行集合一致）
    setStatus(
      sqlite,
      sqlGet<{ id: number }>(sqlite, "SELECT id FROM match WHERE stage_id = 500 AND round > 3 ORDER BY id LIMIT 1")!.id,
      "pending"
    );
    const res = await completeDouble(env, 50, 500);
    const body = (await res.json()) as { seed: number; order: number[]; created: number; deleted: number };
    expect(body.seed).toBe(first.seed);
    expect(body.order).toEqual(first.order);
    expect(body.created).toBe(6);
    expect(body.deleted).toBe(6);
    expect(rowsOf(sqlite, 500).map((r) => [r.round, r.slot, r.home_entry_id, r.away_entry_id])).toEqual(before);
  });

  it("complete-double kickoffCleared：被删第二循环带 kickoff 标注 → 计数并入 warnings", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 50);
    mkEntries(sqlite, 50, [500, 501, 502, 503]);
    mkStage(sqlite, 500, 50, "round_robin", 1, { loops: 1 });
    await generate(env, 50, 500);
    await completeDouble(env, 50, 500);
    // 给第二循环的一场打上开球标注
    const secondMatch = sqlGet<{ id: number }>(
      sqlite,
      "SELECT id FROM match WHERE stage_id = 500 AND round > 3 LIMIT 1"
    )!;
    sqlite
      .prepare("UPDATE match SET kickoff_week = 3, kickoff_day = 6, kickoff_time = '21:00' WHERE id = ?")
      .run(secondMatch.id);

    const res = await completeDouble(env, 50, 500);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number; kickoffCleared: number; warnings: string[] };
    expect(body.deleted).toBe(6);
    expect(body.kickoffCleared).toBe(1);
    expect(body.warnings).toEqual(["已清空 1 场已排的开球时间，需重新排期"]);
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

    // 有活跃 generate job → 409 且不创建新 job
    mkJob(sqlite, 9100, 50, 500, "asymmetric", "pending");
    const blockedByJob = await completeDouble(env, 50, 500);
    expect(blockedByJob.status).toBe(409);
    expect(await msg(blockedByJob)).toBe("该阶段已有双循环生成任务在跑，请等它结束");
    expect(sqlAll<{ id: number }>(sqlite, "SELECT id FROM schedule_job")).toHaveLength(1);
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

describe("secondLoopMode 配置通道（PATCH → stage.config_json，spec §4.2）", () => {
  it("PATCH config_json.secondLoopMode 落到 round_robin 与 group 阶段行", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 53, "draft"); // 无场次 → 赛制参数可改
    mkStage(sqlite, 530, 53, "round_robin", 1, { loops: 2 });
    mkStage(sqlite, 531, 53, "group", 2, { group_count: 2, loops: 1 });

    const res = await app.request(
      "/api/admin/tournaments/53",
      { method: "PATCH", headers: AUTH, body: JSON.stringify({ config_json: { secondLoopMode: "mirror" } }) },
      env
    );
    expect(res.status).toBe(200);

    const rr = sqlGet<{ config_json: string }>(sqlite, "SELECT config_json FROM stage WHERE id = 530")!;
    expect(JSON.parse(rr.config_json)).toEqual({ loops: 2, secondLoopMode: "mirror" });
    const gp = sqlGet<{ config_json: string }>(sqlite, "SELECT config_json FROM stage WHERE id = 531")!;
    expect(JSON.parse(gp.config_json)).toEqual({ group_count: 2, loops: 1, secondLoopMode: "mirror" });

    // 显式传 asymmetric 也应照写覆盖
    const res2 = await app.request(
      "/api/admin/tournaments/53",
      { method: "PATCH", headers: AUTH, body: JSON.stringify({ config_json: { secondLoopMode: "asymmetric" } }) },
      env
    );
    expect(res2.status).toBe(200);
    const rr2 = sqlGet<{ config_json: string }>(sqlite, "SELECT config_json FROM stage WHERE id = 530")!;
    expect(JSON.parse(rr2.config_json).secondLoopMode).toBe("asymmetric");
  });
});

describe("recoverScheduleJobs（cron 判死，spec §6.5/§9.2）", () => {
  const MIN = 60 * 1000;

  function bindingsOf(db: D1Database): Bindings {
    return { DB: db, KV: createTestKV(), ASSETS: {}, MEDIA: {} } as unknown as Bindings;
  }

  // 直接插一条指定状态/创建时间的 schedule_job 行（无外键，不用造赛事/阶段）
  function insertStaleJob(
    sqlite: DatabaseSync,
    o: { id: number; stageId: number; status: string; createdMinAgo: number; startedMinAgo?: number; error?: string }
  ): void {
    const now = Date.now();
    sqlite
      .prepare(
        `INSERT INTO schedule_job
           (id, tournament_id, stage_id, kind, mode, status, seed, budget_ms,
            result_json, error, created_by, created_at, started_at, finished_at)
         VALUES (?, 46, ?, 'generate_double', 'asymmetric', ?, 42, 15000,
            NULL, ?, 1, ?, ?, ?)`
      )
      .run(
        o.id,
        o.stageId,
        o.status,
        o.error ?? null,
        new Date(now - o.createdMinAgo * MIN).toISOString(),
        o.startedMinAgo === undefined ? null : new Date(now - o.startedMinAgo * MIN).toISOString(),
        o.status === "done" ? new Date(now - (o.createdMinAgo - 1) * MIN).toISOString() : null
      );
  }

  it("created_at 超 10 分钟的 pending 判死：error 固定文案、finished_at 写入", async () => {
    const { sqlite, db } = createTestDb();
    insertStaleJob(sqlite, { id: 1, stageId: 70, status: "pending", createdMinAgo: 11 });

    await recoverScheduleJobs(bindingsOf(db));

    const row = sqlGet<{ status: string; error: string; finished_at: string }>(
      sqlite,
      "SELECT status, error, finished_at FROM schedule_job WHERE id = 1"
    );
    expect(row).toMatchObject({ status: "failed", error: "任务超时，请重试" });
    expect(row?.finished_at).toBeTruthy();
  });

  it("11 分钟前的 running 也判死——按 created_at 而非 started_at（started 仅 10 分钟前）", async () => {
    const { sqlite, db } = createTestDb();
    insertStaleJob(sqlite, { id: 2, stageId: 71, status: "running", createdMinAgo: 11, startedMinAgo: 10 });

    await recoverScheduleJobs(bindingsOf(db));

    expect(
      sqlGet<{ status: string; error: string }>(sqlite, "SELECT status, error FROM schedule_job WHERE id = 2")
    ).toMatchObject({ status: "failed", error: "任务超时，请重试" });
  });

  it("5 分钟前的 pending/running 不动；done/failed 终态不重判（failed 保留原 error）", async () => {
    const { sqlite, db } = createTestDb();
    insertStaleJob(sqlite, { id: 3, stageId: 72, status: "pending", createdMinAgo: 5 });
    insertStaleJob(sqlite, { id: 4, stageId: 73, status: "running", createdMinAgo: 5, startedMinAgo: 4 });
    insertStaleJob(sqlite, { id: 5, stageId: 74, status: "done", createdMinAgo: 30 });
    insertStaleJob(sqlite, { id: 6, stageId: 75, status: "failed", createdMinAgo: 30, error: "原先的失败原因" });

    await recoverScheduleJobs(bindingsOf(db));

    const rows = sqlAll<{ id: number; status: string; error: string | null; finished_at: string | null }>(
      sqlite,
      "SELECT id, status, error, finished_at FROM schedule_job WHERE id >= 3 ORDER BY id"
    );
    expect(rows).toEqual([
      { id: 3, status: "pending", error: null, finished_at: null },
      { id: 4, status: "running", error: null, finished_at: null },
      { id: 5, status: "done", error: null, finished_at: expect.any(String) },
      { id: 6, status: "failed", error: "原先的失败原因", finished_at: null },
    ]);
  });

  it("整体吞异常：扫描失败不抛出（cron 无重试，一次抖动不炸调度）", async () => {
    const badDb = {
      prepare() {
        throw new Error("db down");
      },
    } as unknown as D1Database;
    await expect(recoverScheduleJobs(bindingsOf(badDb))).resolves.toBeUndefined();
  });

  it("判死后同阶段可立即重新生成：走路由 POST 返回新 jobId", async () => {
    const { env, sqlite } = freshEnv();
    mkTournament(sqlite, 46);
    mkEntries(sqlite, 46, [460, 461, 462, 463]);
    mkStage(sqlite, 460, 46, "round_robin", 1, { loops: 2 });
    mkJob(sqlite, 9001, 46, 460, "asymmetric", "pending");
    sqlite
      .prepare("UPDATE schedule_job SET created_at = ? WHERE id = 9001")
      .run(new Date(Date.now() - 11 * MIN).toISOString());

    await recoverScheduleJobs(env as unknown as Bindings);
    expect(
      sqlGet<{ status: string; error: string }>(sqlite, "SELECT status, error FROM schedule_job WHERE id = 9001")
    ).toMatchObject({ status: "failed", error: "任务超时，请重试" });

    const res = await generate(env, 46, 460);
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: number };
    expect(jobId).not.toBe(9001); // 活跃索引不再拦：判死后可立即建新任务
    expect(jobId).toBeGreaterThan(9001);
  });
});
