// schedule_job 任务库（迁移 0036 + worker/lib/schedule-jobs.ts）：读写面与 cron 判死。
// 真库（node:sqlite）上钉四件事：
//   1) 活跃唯一索引：同一阶段至多一条 pending/running，第二条 INSERT 直接抛约束错误
//   2) claim 抢位语义：pending → running 一次成功，二次 claim changes=0 返回 false
//   3) 归属校验：readScheduleJob 对错误赛事/阶段返回 null（表没有外键，得靠查询兜）
//   4) 超时恢复：created_at 超 10 分钟的 pending/running 判 failed（固定文案 + finished_at），
//      5 分钟前的不动，done/failed 的永不重判
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createTestDb, createTestKV, sqlAll, sqlGet } from "./d1";
import {
  claimScheduleJob,
  createOrReuseScheduleJob,
  createScheduleJob,
  failScheduleJob,
  findActiveScheduleJob,
  latestScheduleJob,
  readScheduleJob,
  recoverScheduleJobs,
  scheduleJobDoneStmt,
} from "../worker/lib/schedule-jobs";
import type { Bindings } from "../worker/env";

const MIN = 60 * 1000;

function bindingsWith(db: D1Database): Bindings {
  return { DB: db, KV: createTestKV(), ASSETS: {}, MEDIA: {} } as unknown as Bindings;
}

// 直接插一条指定状态/时间戳的任务行（无外键，不用先造赛事/阶段）。
// done 行补 finished_at、running 行补 started_at，让 recover 的「不重判」断言看得出未被动过。
function insertJob(
  sqlite: DatabaseSync,
  o: {
    id: number;
    stageId: number;
    status: string;
    createdMinAgo: number;
    startedMinAgo?: number;
    error?: string;
    mode?: string;
  }
): void {
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT INTO schedule_job
         (id, tournament_id, stage_id, kind, mode, status, seed, budget_ms,
          result_json, error, created_by, created_at, started_at, finished_at)
       VALUES (?, 7, ?, 'generate_double', ?, ?, 42, 15000,
          NULL, ?, 1, ?, ?, ?)`
    )
    .run(
      o.id,
      o.stageId,
      o.mode ?? "asymmetric",
      o.status,
      o.error ?? null,
      new Date(now - o.createdMinAgo * MIN).toISOString(),
      o.startedMinAgo === undefined ? null : new Date(now - o.startedMinAgo * MIN).toISOString(),
      o.status === "done" ? new Date(now - (o.createdMinAgo - 1) * MIN).toISOString() : null
    );
}

describe("0036 迁移", () => {
  it("表列与两个索引都在", () => {
    const { sqlite } = createTestDb();
    const cols = sqlAll<{ name: string }>(sqlite, "PRAGMA table_info(schedule_job)").map((c) => c.name);
    expect(cols).toEqual([
      "id", "tournament_id", "stage_id", "kind", "mode", "status", "seed", "budget_ms",
      "result_json", "error", "created_by", "created_at", "started_at", "finished_at",
    ]);
    const indexes = sqlAll<{ name: string }>(sqlite, "SELECT name FROM sqlite_master WHERE type = 'index'").map(
      (i) => i.name
    );
    expect(indexes).toContain("idx_schedule_job_active");
    expect(indexes).toContain("idx_schedule_job_stage");
  });
});

describe("createScheduleJob / findActiveScheduleJob", () => {
  it("写入默认值并返回自增 id；同阶段第二条活跃任务撞活跃唯一索引", async () => {
    const { sqlite, db } = createTestDb();
    const jobId = await createScheduleJob(db, {
      tournamentId: 7,
      stageId: 70,
      mode: "asymmetric",
      seed: 12345,
      budgetMs: 15000,
      createdBy: 1,
    });
    expect(jobId).toBeGreaterThan(0);
    const row = sqlGet<Record<string, unknown>>(sqlite, "SELECT * FROM schedule_job WHERE id = ?", jobId);
    expect(row).toMatchObject({
      tournament_id: 7,
      stage_id: 70,
      kind: "generate_double",
      mode: "asymmetric",
      status: "pending",
      seed: 12345,
      budget_ms: 15000,
      created_by: 1,
      result_json: null,
      error: null,
      started_at: null,
      finished_at: null,
    });
    expect(row?.created_at).toBeTruthy();

    const active = await findActiveScheduleJob(db, 70);
    expect(active?.id).toBe(jobId);
    expect(active?.mode).toBe("asymmetric");

    // 并发兜底：同 stage 再插一条 pending，唯一部分索引直接挡下
    await expect(
      createScheduleJob(db, { tournamentId: 7, stageId: 70, mode: "mirror", seed: 2, budgetMs: 15000 })
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("不同阶段互不干扰；任务终态后 findActiveScheduleJob 返回 null", async () => {
    const { db } = createTestDb();
    const id1 = await createScheduleJob(db, {
      tournamentId: 7, stageId: 70, mode: "mirror", seed: 1, budgetMs: 15000,
    });
    const id2 = await createScheduleJob(db, {
      tournamentId: 7, stageId: 71, mode: "asymmetric", seed: 2, budgetMs: 15000,
    });
    expect((await findActiveScheduleJob(db, 70))?.id).toBe(id1);
    expect((await findActiveScheduleJob(db, 71))?.id).toBe(id2);
    expect(await findActiveScheduleJob(db, 72)).toBeNull();

    await failScheduleJob(db, id1, "x");
    expect(await findActiveScheduleJob(db, 70)).toBeNull();
  });
});

describe("claimScheduleJob", () => {
  it("pending → running 并记 started_at；二次 claim 返回 false（changes=0）", async () => {
    const { db } = createTestDb();
    const jobId = await createScheduleJob(db, {
      tournamentId: 7, stageId: 70, mode: "mirror", seed: 1, budgetMs: 15000,
    });
    expect(await claimScheduleJob(db, jobId)).toBe(true);
    const row = await readScheduleJob(db, 7, 70, jobId);
    expect(row?.status).toBe("running");
    expect(row?.startedAt).toBeTruthy();
    expect(await claimScheduleJob(db, jobId)).toBe(false);
    // done/failed 同样领不动
    await failScheduleJob(db, jobId, "x");
    expect(await claimScheduleJob(db, jobId)).toBe(false);
  });
});

describe("scheduleJobDoneStmt", () => {
  it("语句形态可与写入并批：同批提交后任务 done、result_json 落库", async () => {
    const { db, sqlite } = createTestDb();
    const jobId = await createScheduleJob(db, {
      tournamentId: 7, stageId: 70, mode: "asymmetric", seed: 1, budgetMs: 15000,
    });
    await claimScheduleJob(db, jobId);
    const result = { balanced: true, rounds: 6 };
    await db.batch([
      // 模拟「场次写入」与完成标记同批：顺手对另一阶段的行做一次 UPDATE
      db.prepare("UPDATE schedule_job SET error = 'x' WHERE id = ?").bind(999),
      scheduleJobDoneStmt(db, jobId, JSON.stringify(result)),
    ]);
    const row = await readScheduleJob(db, 7, 70, jobId);
    expect(row?.status).toBe("done");
    expect(JSON.parse(row?.resultJson ?? "null")).toEqual(result);
    expect(row?.finishedAt).toBeTruthy();
    expect(sqlGet<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM schedule_job WHERE status = 'done'")?.n).toBe(1);
  });
});

describe("failScheduleJob", () => {
  it("记 error/finished_at；resultJson 可选存违例明细", async () => {
    const { db } = createTestDb();
    const id1 = await createScheduleJob(db, {
      tournamentId: 7, stageId: 70, mode: "asymmetric", seed: 1, budgetMs: 15000,
    });
    await failScheduleJob(db, id1, "未能满足硬约束", JSON.stringify({ balanced: false, violations: ["甲队连场"] }));
    const r1 = await readScheduleJob(db, 7, 70, id1);
    expect(r1?.status).toBe("failed");
    expect(r1?.error).toBe("未能满足硬约束");
    expect(JSON.parse(r1?.resultJson ?? "null")).toEqual({ balanced: false, violations: ["甲队连场"] });
    expect(r1?.finishedAt).toBeTruthy();

    const id2 = await createScheduleJob(db, {
      tournamentId: 7, stageId: 71, mode: "mirror", seed: 2, budgetMs: 15000,
    });
    await failScheduleJob(db, id2, "执行异常");
    const r2 = await readScheduleJob(db, 7, 71, id2);
    expect(r2?.status).toBe("failed");
    expect(r2?.resultJson).toBeNull();
    expect(r2?.finishedAt).toBeTruthy();
  });
});

describe("readScheduleJob", () => {
  it("归属校验：id 不存在/赛事不符/阶段不符都返回 null", async () => {
    const { db } = createTestDb();
    const jobId = await createScheduleJob(db, {
      tournamentId: 7, stageId: 70, mode: "mirror", seed: 1, budgetMs: 15000,
    });
    expect(await readScheduleJob(db, 7, 70, 999)).toBeNull();
    expect(await readScheduleJob(db, 8, 70, jobId)).toBeNull();
    expect(await readScheduleJob(db, 7, 71, jobId)).toBeNull();
    expect((await readScheduleJob(db, 7, 70, jobId))?.id).toBe(jobId);
  });
});

describe("latestScheduleJob", () => {
  it("取该阶段 id 最大一条（含 done/failed）；从未建过任务返回 null", async () => {
    const { db } = createTestDb();
    expect(await latestScheduleJob(db, 70)).toBeNull();
    const id1 = await createScheduleJob(db, {
      tournamentId: 7, stageId: 70, mode: "mirror", seed: 1, budgetMs: 15000,
    });
    await failScheduleJob(db, id1, "x");
    const id2 = await createScheduleJob(db, {
      tournamentId: 7, stageId: 70, mode: "asymmetric", seed: 2, budgetMs: 15000,
    });
    await claimScheduleJob(db, id2);
    const latest = await latestScheduleJob(db, 70);
    expect(latest?.id).toBe(id2);
    expect(latest?.status).toBe("running");
    expect(await latestScheduleJob(db, 71)).toBeNull();
  });
});

describe("recoverScheduleJobs", () => {
  it("11 分钟前的 pending/running 判死（固定文案 + finished_at）；5 分钟前与终态行不动", async () => {
    const { sqlite, db } = createTestDb();
    insertJob(sqlite, { id: 1, stageId: 70, status: "pending", createdMinAgo: 11 });
    insertJob(sqlite, { id: 2, stageId: 71, status: "running", createdMinAgo: 11, startedMinAgo: 10 });
    insertJob(sqlite, { id: 3, stageId: 72, status: "pending", createdMinAgo: 5 });
    insertJob(sqlite, { id: 4, stageId: 73, status: "done", createdMinAgo: 30 });
    insertJob(sqlite, { id: 5, stageId: 74, status: "failed", createdMinAgo: 30, error: "原先的失败原因" });

    await recoverScheduleJobs(bindingsWith(db));

    const rows = sqlAll<{ id: number; status: string; error: string | null; finished_at: string | null }>(
      sqlite,
      "SELECT id, status, error, finished_at FROM schedule_job ORDER BY id"
    );
    expect(rows).toEqual([
      { id: 1, status: "failed", error: "任务超时，请重试", finished_at: expect.any(String) },
      { id: 2, status: "failed", error: "任务超时，请重试", finished_at: expect.any(String) },
      { id: 3, status: "pending", error: null, finished_at: null },
      { id: 4, status: "done", error: null, finished_at: expect.any(String) },
      { id: 5, status: "failed", error: "原先的失败原因", finished_at: null },
    ]);
    // 判死不重跑：同阶段可以立刻建新任务（活跃索引不再拦）
    const newId = await createScheduleJob(db, {
      tournamentId: 7, stageId: 70, mode: "mirror", seed: 3, budgetMs: 15000,
    });
    expect(newId).toBeGreaterThan(1);
  });
});

// 建任务（含并发窗口）：createOrReuseScheduleJob 的复用/冲突/竞争兜底。
// 竞争时序 = 两个请求都过了「活跃查询」，后插入者撞 idx_schedule_job_active；
// 这里用包装 DB 让建任务前的那次查询返回空（真实活跃行仍在库里）来复现。
describe("createOrReuseScheduleJob", () => {
  const input = {
    tournamentId: 7,
    stageId: 60,
    mode: "asymmetric" as const,
    seed: 1,
    budgetMs: 15000,
  };

  function dbWithFirstLookupMiss(real: D1Database): D1Database {
    let missed = false;
    const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
      ({
        bind: (...args: unknown[]) =>
          wrap((stmt.bind as (...a: unknown[]) => D1PreparedStatement)(...args)),
        first: async (...args: unknown[]) => {
          if (!missed) {
            missed = true;
            return null;
          }
          return (stmt.first as (...a: unknown[]) => Promise<unknown>)(...args);
        },
        run: () => (stmt.run as () => Promise<unknown>)() as never,
        all: () => (stmt.all as () => Promise<unknown>)() as never,
      }) as unknown as D1PreparedStatement;
    return { prepare: (sql: string) => wrap(real.prepare(sql)) } as unknown as D1Database;
  }

  function jobCount(sqlite: DatabaseSync): number {
    return sqlGet<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM schedule_job")?.n ?? -1;
  }

  it("无活跃任务时新建，返回新 jobId", async () => {
    const { db, sqlite } = createTestDb();
    const r = await createOrReuseScheduleJob(db, input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reused).toBe(false);
    expect(r.jobId).toBeGreaterThan(0);
    expect((await findActiveScheduleJob(db, 60))?.id).toBe(r.jobId);
    expect(jobCount(sqlite)).toBe(1);
  });

  it("同 mode 活跃任务复用，不新建", async () => {
    const { db, sqlite } = createTestDb();
    insertJob(sqlite, { id: 5, stageId: 60, status: "pending", createdMinAgo: 1 });
    const r = await createOrReuseScheduleJob(db, input);
    expect(r).toEqual({ ok: true, jobId: 5, reused: true, status: "pending" });
    expect(jobCount(sqlite)).toBe(1);
  });

  it("异 mode 活跃任务冲突", async () => {
    const { db, sqlite } = createTestDb();
    insertJob(sqlite, {
      id: 6, stageId: 60, status: "running", createdMinAgo: 1, startedMinAgo: 1, mode: "mirror",
    });
    const r = await createOrReuseScheduleJob(db, input);
    expect(r).toEqual({ ok: false, activeMode: "mirror" });
  });

  it("并发窗口：首次查询漏掉活跃行 → 撞唯一索引后回读复用（不 500）", async () => {
    const { db, sqlite } = createTestDb();
    insertJob(sqlite, { id: 9, stageId: 60, status: "pending", createdMinAgo: 0 });
    const r = await createOrReuseScheduleJob(dbWithFirstLookupMiss(db), input);
    expect(r).toEqual({ ok: true, jobId: 9, reused: true, status: "pending" });
    expect(jobCount(sqlite)).toBe(1);
  });

  it("并发窗口 + 异 mode：按冲突返回而不是抛错", async () => {
    const { db, sqlite } = createTestDb();
    insertJob(sqlite, {
      id: 10, stageId: 60, status: "running", createdMinAgo: 0, startedMinAgo: 0, mode: "mirror",
    });
    const r = await createOrReuseScheduleJob(dbWithFirstLookupMiss(db), input);
    expect(r).toEqual({ ok: false, activeMode: "mirror" });
  });

  it("非唯一约束错误原样上抛", async () => {
    const failing = {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          run: async () => {
            throw new Error("D1_ERROR: disk I/O error");
          },
        }),
      }),
    } as unknown as D1Database;
    await expect(createOrReuseScheduleJob(failing, input)).rejects.toThrow(/disk I\/O/);
  });

  it("唯一冲突但回读不到活跃任务时上抛", async () => {
    const failing = {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          run: async () => {
            throw new Error("D1_ERROR: UNIQUE constraint failed: schedule_job.stage_id");
          },
        }),
      }),
    } as unknown as D1Database;
    await expect(createOrReuseScheduleJob(failing, input)).rejects.toThrow(/UNIQUE constraint failed/);
  });
});
