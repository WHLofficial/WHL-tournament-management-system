// 双循环自动生成的异步任务库（设计 §6）：schedule_job 表的读写面。
// 设计见 docs/superpowers/specs/2026-11-12-asymmetric-double-round-robin-design.md。
//
// 生命周期：路由 createScheduleJob（活跃任务复用/新建，202 返回 jobId）→ 执行器
// claimScheduleJob 抢位（pending → running，changes=0 说明已被别人领走）→ 收尾走
// scheduleJobDoneStmt（与场次写入并批，完成标记和数据写入原子生效）或 failScheduleJob。
// 僵尸任务由 cron 的 recoverScheduleJobs 统一判死，不自动重跑。
import type { Bindings } from "../env";

export type ScheduleJobKind = "generate_double";
export type ScheduleJobStatus = "pending" | "running" | "done" | "failed";
export type ScheduleJobMode = "mirror" | "asymmetric";

export interface ScheduleJobRow {
  id: number;
  tournamentId: number;
  stageId: number;
  kind: ScheduleJobKind;
  mode: ScheduleJobMode;
  status: ScheduleJobStatus;
  seed: number;
  budgetMs: number;
  resultJson: string | null;
  error: string | null;
  createdBy: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CreateScheduleJobInput {
  tournamentId: number;
  stageId: number;
  mode: ScheduleJobMode;
  seed: number;
  budgetMs: number;
  createdBy?: number | null;
}

const ROW_SQL = `SELECT id, tournament_id AS tournamentId, stage_id AS stageId, kind, mode, status,
  seed, budget_ms AS budgetMs, result_json AS resultJson, error, created_by AS createdBy,
  created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt
  FROM schedule_job`;

// 同一阶段当前活跃（pending/running）的任务；活跃唯一索引保证至多一条，按 id 最新取。
export async function findActiveScheduleJob(
  db: D1Database,
  stageId: number
): Promise<ScheduleJobRow | null> {
  return db
    .prepare(`${ROW_SQL} WHERE stage_id = ? AND status IN ('pending','running') ORDER BY id DESC LIMIT 1`)
    .bind(stageId)
    .first<ScheduleJobRow>();
}

// 插入新任务，返回自增 id。同一阶段已有 pending/running 时撞活跃唯一索引，异常原样抛出——
// 正常走 createOrReuseScheduleJob 先行复用；这里被撞说明是并发窗口内的漏网，由它回读活跃任务处理。
export async function createScheduleJob(
  db: D1Database,
  input: CreateScheduleJobInput
): Promise<number> {
  const r = await db
    .prepare(
      `INSERT INTO schedule_job
         (tournament_id, stage_id, kind, mode, status, seed, budget_ms, created_by, created_at)
       VALUES (?, ?, 'generate_double', ?, 'pending', ?, ?, ?, ?)`
    )
    .bind(
      input.tournamentId,
      input.stageId,
      input.mode,
      input.seed,
      input.budgetMs,
      input.createdBy ?? null,
      new Date().toISOString()
    )
    .run();
  return r.meta.last_row_id;
}

// 建任务的结果：新建成功 / 复用已有同 mode 活跃任务 / 与另一 mode 的活动任务冲突。
export type CreateOrReuseResult =
  | { ok: true; jobId: number; reused: boolean; status?: ScheduleJobStatus }
  | { ok: false; activeMode: ScheduleJobMode };

// 建任务（含并发窗口）：先查活跃任务——同 mode 复用、异 mode 冲突；没有则插入。
// 两个请求都过了首次查询、后插入者撞 idx_schedule_job_active 时，回读活跃任务按同样规则
// 复用/冲突，绝不让并发漏成 500（设计 §6.2「同阶段单活跃任务」）。
export async function createOrReuseScheduleJob(
  db: D1Database,
  input: CreateScheduleJobInput
): Promise<CreateOrReuseResult> {
  const active = await findActiveScheduleJob(db, input.stageId);
  if (active) {
    return active.mode === input.mode
      ? { ok: true, jobId: active.id, reused: true, status: active.status }
      : { ok: false, activeMode: active.mode };
  }
  try {
    const jobId = await createScheduleJob(db, input);
    return { ok: true, jobId, reused: false };
  } catch (e) {
    // 只兜唯一索引冲突；其它错误（D1 不可用等）原样上抛
    const msg = e instanceof Error ? e.message : String(e);
    if (!/UNIQUE constraint failed/i.test(msg)) throw e;
    const raced = await findActiveScheduleJob(db, input.stageId);
    if (!raced) throw e;
    return raced.mode === input.mode
      ? { ok: true, jobId: raced.id, reused: true, status: raced.status }
      : { ok: false, activeMode: raced.mode };
  }
}

// 抢任务：pending → running 并记 started_at。changes=0 说明已被人领走（或已不在 pending）。
export async function claimScheduleJob(db: D1Database, jobId: number): Promise<boolean> {
  const r = await db
    .prepare("UPDATE schedule_job SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'")
    .bind(new Date().toISOString(), jobId)
    .run();
  return r.meta.changes > 0;
}

// 完成标记的语句形态：供 writeAndRebuild 与场次写入并批，任务完成与数据写入同批提交。
export function scheduleJobDoneStmt(
  db: D1Database,
  jobId: number,
  resultJson: string
): D1PreparedStatement {
  return db
    .prepare("UPDATE schedule_job SET status = 'done', result_json = ?, finished_at = ? WHERE id = ?")
    .bind(resultJson, new Date().toISOString(), jobId);
}

// 失败收尾。resultJson 可选：balanced=false 的违例明细也要留档（设计 §6.3 第 5 步）。
export async function failScheduleJob(
  db: D1Database,
  jobId: number,
  error: string,
  resultJson?: string
): Promise<void> {
  await db
    .prepare("UPDATE schedule_job SET status = 'failed', error = ?, result_json = ?, finished_at = ? WHERE id = ?")
    .bind(error, resultJson ?? null, new Date().toISOString(), jobId)
    .run();
}

// 状态查询读面：校验 tournament_id + stage_id 归属（表没有外键，阶段删了行还在，
// 拿别的赛事/阶段的 id 来查必须查不到），不匹配返回 null。
export async function readScheduleJob(
  db: D1Database,
  tournamentId: number,
  stageId: number,
  jobId: number
): Promise<ScheduleJobRow | null> {
  const row = await db.prepare(`${ROW_SQL} WHERE id = ?`).bind(jobId).first<ScheduleJobRow>();
  if (!row || row.tournamentId !== tournamentId || row.stageId !== stageId) return null;
  return row;
}

// 状态查询 latest：该阶段 id 最大的一条（含 done/failed），从未建过任务返回 null。
export async function latestScheduleJob(
  db: D1Database,
  stageId: number
): Promise<ScheduleJobRow | null> {
  return db
    .prepare(`${ROW_SQL} WHERE stage_id = ? ORDER BY id DESC LIMIT 1`)
    .bind(stageId)
    .first<ScheduleJobRow>();
}

// cron 兜底（设计 §6.5）：pending/running 且 created_at < now-10min 的任务判死——
// 标记 failed、error='任务超时，请重试'、finished_at=now。不自动重跑：避免与仍在运行的
// Worker 竞争，用户再点一次生成即可创建新任务；「场次写入 + 完成标记」同批提交，
// 超时任务不会留下半截状态。单行失败吞掉继续；整体异常也吞掉只记日志（cron 无重试，
// 一次抖动不该把这次调度记成失败——与 healPendingRebuilds 等任务同口径）。
export async function recoverScheduleJobs(env: Bindings): Promise<void> {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  try {
    const stale = await env.DB.prepare(
      "SELECT id FROM schedule_job WHERE status IN ('pending','running') AND created_at < ?"
    )
      .bind(cutoff)
      .all<{ id: number }>();
    for (const r of stale.results ?? []) {
      try {
        await env.DB
          .prepare(
            "UPDATE schedule_job SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status IN ('pending','running')"
          )
          .bind("任务超时，请重试", new Date().toISOString(), r.id)
          .run();
      } catch (e) {
        console.error(`[schedule-job] 任务 ${r.id} 超时标记失败：${errText(e)}`);
      }
    }
  } catch (e) {
    console.error(`[schedule-job] 超时任务扫描失败：${errText(e)}`);
  }
}
