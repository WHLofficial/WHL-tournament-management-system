// 赛季级排期管理端接口（S1 总览/版本 + S3 五端点）。
//
// 设计 docs/design-season-scheduler.md §5：
//   GET    /seasons/:id/schedule                 赛季总览（S1）
//   POST   /seasons/:id/schedule/preview        整季预览（S3，可传 segmentIds 部分求解）
//   POST   /seasons/:id/schedule/commit          提交成新版本（S3，硬冲突 409）
//   POST   /seasons/:id/schedule/publish         公布并锁定版本（S3）
//   POST   /seasons/:id/schedule/restore/:rid   回滚到版本（S3，落成 restored 新版本）
//   GET    /seasons/:id/schedule/snapshots       版本列表（S1）
//   POST   /seasons/:id/schedule/archive         一次性基线归档（S1，幂等 revision 1）
//
// 旧窗口接口（/tournaments/:id/windows/...）完全保留，仍走 admin/kickoff.ts；
// 那边的体检入口内部改调本模块的赛季级校验器（validateSeason）。
//
// commit 的防伪口径：客户端不回传 assignments，只回传候选 key + 提案 hash；
// 服务端用相同参数重跑 scheduleSeason（固定 seed/步数可复现）→ 按 hash 对上才落库。
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../env";
import { auditStmt } from "../../lib/audit";
import {
  SeasonRevisionError,
  archiveSeasonRevision,
  guardChangesStmt,
  guardRevisionStmt,
  hashSeasonAssignments,
  listSeasonRevisions,
  loadSeasonData,
  loadSeasonRules,
  restoreSeasonRevision,
  runSeasonRevisionBatch,
  scheduleSeason,
  seasonCommitGate,
  validateSeason,
  type SeasonPlacement,
  type SeasonViolation,
} from "../../lib/kickoffSeason";

const app = new Hono<AppEnv>();

/**
 * 部分提交只 gate「本次选中段 + 选中场次直接相关」的硬冲突。
 * 其他段的历史烂账留给整季总览/对应段的局部重排处理，不能把一次局部修复卡死。
 */
function scopedCommitViolations(
  violations: SeasonViolation[],
  segmentIds: Set<number>,
  matchIds: Set<number>
): SeasonViolation[] {
  return violations.filter(
    (v) =>
      (v.segmentId != null && segmentIds.has(v.segmentId)) ||
      matchIds.has(v.matchId) ||
      (v.relatedMatchId != null && matchIds.has(v.relatedMatchId))
  );
}

function parseSeasonId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function seasonNotFound(c: Context<AppEnv>) {
  return c.json({ message: "赛季不存在" }, 404);
}

// SeasonRevisionError → HTTP 的统一映射：
//   season_not_found / revision_not_found → 404
//   segment_not_found → 400（preview/commit 的 segmentIds 参数不合法）
//   empty_schedule / hash_mismatch / segment_locked → 409
function seasonError(c: Context<AppEnv>, err: unknown) {
  if (err instanceof SeasonRevisionError) {
    const status =
      err.code === "season_not_found" || err.code === "revision_not_found"
        ? 404
        : err.code === "segment_not_found"
          ? 400
          : 409;
    return c.json({ message: err.message }, status);
  }
  // Low-7：并发撞 `schedule_revision.revision` 先回 409，别把用户直接丢进 500。
  if (
    err instanceof Error &&
    err.message.includes("UNIQUE constraint failed") &&
    err.message.includes("schedule_revision.revision")
  ) {
    return c.json({ message: "排期版本号冲突，请重试" }, 409);
  }
  throw err;
}

/** 读 JSON body；空 body 视为 {}。JSON 坏了返回 null 由调用方 400。 */
async function readJsonBody(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  const raw = await c.req.text();
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** undefined=未提供；null=不合法；number[]=解析结果 */
function optionalIntList(raw: unknown): number[] | null | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((v) => !Number.isInteger(v) || v <= 0))
    return null;
  return raw as number[];
}

/** seed/steps 的请求上限。steps 不封顶，steps=1e9 会直接把 Worker CPU 烧穿。 */
const MAX_SEED = Number.MAX_SAFE_INTEGER;
const MAX_STEPS = 20_000;

/** undefined=未提供；null=不合法；number=解析结果。带 max，防 steps=1e9 烧 Worker。 */
function optionalNonNegInt(raw: unknown, max: number): number | null | undefined {
  if (raw == null) return undefined;
  if (!Number.isInteger(raw) || (raw as number) < 0) return null;
  if ((raw as number) > max) return null;
  return raw as number;
}

/** preview/commit 共用的求解参数（seed/steps 默认走引擎常量）。 */
function solveOptionsFrom(body: Record<string, unknown>): {
  ok: true;
  options: { segmentIds?: number[]; seed?: number; steps?: number };
} | { ok: false; message: string } {
  const segmentIds = optionalIntList(body.segmentIds);
  if (segmentIds === null) return { ok: false, message: "segmentIds 要是非空正整数数组" };
  const seed = optionalNonNegInt(body.seed, MAX_SEED);
  if (seed === null) return { ok: false, message: `seed 要是 0–${MAX_SEED} 的整数` };
  const steps = optionalNonNegInt(body.steps, MAX_STEPS);
  if (steps === null) return { ok: false, message: `steps 要是 0–${MAX_STEPS} 的整数` };
  return {
    ok: true,
    options: {
      ...(segmentIds ? { segmentIds } : {}),
      ...(seed != null ? { seed } : {}),
      ...(steps != null ? { steps } : {}),
    },
  };
}

/** 把候选 assignments 合并进现有 placements，得到“写库后的全季现状”用于落版和体检。 */
function mergeSeasonPlacements(
  current: SeasonPlacement[],
  assignments: SeasonPlacement[]
): SeasonPlacement[] {
  const byMatch = new Map<number, SeasonPlacement>();
  for (const p of current) byMatch.set(p.matchId, p);
  for (const a of assignments) byMatch.set(a.matchId, a);
  return [...byMatch.values()].sort((a, b) => a.matchId - b.matchId);
}


// GET /seasons/current —— 当前赛季（取最新 season 行）。
// 入口页只拿 id/name/weeks，不拉总览；S10 启用后不会再把用户送到 season 1。
app.get("/current", async (c) => {
  const row = await c.env.DB
    .prepare(`SELECT id, name, weeks FROM season ORDER BY id DESC LIMIT 1`)
    .first<{ id: number; name: string; weeks: number }>();
  if (!row) return c.json({ message: "还没有赛季" }, 404);
  return c.json(row);
});

// GET /seasons/:id/schedule —— 赛季总览：段、已排场次、整季体检、版本列表
app.get("/:id/schedule", async (c) => {
  const seasonId = parseSeasonId(c.req.param("id"));
  if (seasonId == null) return c.json({ message: "season id 不合法" }, 400);

  const data = await loadSeasonData(c.env.DB, seasonId);
  if (!data.season) return seasonNotFound(c);
  const [rules, revisions, savedRows] = await Promise.all([
    loadSeasonRules(c.env.DB, seasonId),
    listSeasonRevisions(c.env.DB, seasonId),
    c.env.DB
      .prepare(
        `SELECT DISTINCT a.segment_id
           FROM schedule_revision_assignment a
           JOIN schedule_revision r ON r.id = a.revision_id
          WHERE r.season_id = ?
            AND r.status IN ('committed', 'published', 'restored')
            AND a.segment_id IS NOT NULL`
      )
      .bind(seasonId)
      .all<{ segment_id: number }>(),
  ]);
  const savedSegmentIds = savedRows.results.map((r) => r.segment_id);
  const violations = validateSeason(data, rules);

  const segments = data.segments.map((s) => {
    const matches = data.matches.filter((m) => m.segmentId === s.id);
    return {
      id: s.id,
      tournamentId: s.tournamentId,
      tournamentName: s.tournamentName,
      competition: s.competition,
      stream: s.stream,
      round: s.round,
      leg: s.leg,
      week: s.week,
      dayStart: s.dayStart,
      dayEnd: s.dayEnd,
      lockedAt: s.lockedAt,
      hasOverride: s.slotOverride != null,
      matchCount: matches.length,
      scheduledCount: matches.filter(
        (m) => m.kickoffWeek != null && m.kickoffDay != null && m.kickoffTime != null
      ).length,
      playableCount: matches.filter((m) => m.homeTeamId != null && m.awayTeamId != null).length,
    };
  });

  return c.json({
    season: { id: data.season.id, name: data.season.name, weeks: data.season.weeks },
    counts: {
      segments: data.segments.length,
      matches: data.matches.length,
      scheduled: data.placements.length,
      unscheduled: data.matches.length - data.placements.length,
      unmatched: data.unmatched.length,
      unplayable: data.matches.filter((m) => m.homeTeamId == null || m.awayTeamId == null).length,
    },
    segments,
    placements: data.placements.map((p) => ({
      matchId: p.matchId,
      segmentId: p.segmentId,
      week: p.week,
      day: p.day,
      time: p.time,
      override: p.override,
      reason: p.reason,
    })),
    unmatchedMatchIds: data.unmatched.map((m) => m.id),
    savedSegmentIds,
    violations,
    rules,
    revisions,
  });
});

// GET /seasons/:id/schedule/snapshots —— 版本列表（赛季级；旧 schedule_snapshot 不在这里）
app.get("/:id/schedule/snapshots", async (c) => {
  const seasonId = parseSeasonId(c.req.param("id"));
  if (seasonId == null) return c.json({ message: "season id 不合法" }, 400);
  const season = await c.env.DB.prepare(`SELECT id FROM season WHERE id = ?`)
    .bind(seasonId)
    .first();
  if (!season) return seasonNotFound(c);
  const revisions = await listSeasonRevisions(c.env.DB, seasonId);
  return c.json({ seasonId, revisions });
});

// POST /seasons/:id/schedule/preview —— 整季（或部分段）求解，返回 3 套候选方案
// body: { segmentIds?: number[], seed?: number, steps?: number }
app.post("/:id/schedule/preview", async (c) => {
  const seasonId = parseSeasonId(c.req.param("id"));
  if (seasonId == null) return c.json({ message: "season id 不合法" }, 400);
  const body = await readJsonBody(c);
  if (body == null) return c.json({ message: "请求体不是合法 JSON" }, 400);
  const parsed = solveOptionsFrom(body);
  if (!parsed.ok) return c.json({ message: parsed.message }, 400);

  try {
    const result = await scheduleSeason(c.env.DB, seasonId, parsed.options);
    return c.json({ ok: true, ...result });
  } catch (err) {
    return seasonError(c, err);
  }
});

// POST /seasons/:id/schedule/commit —— 提交候选成新版本
// body: { key: "A"|"B"|"C", hash: string, segmentIds?, seed?, steps? }
// 服务端同参重跑 scheduleSeason（可复现）→ key+hash 对上才写库；
// 硬冲突（>=48h 间隔/末轮同开/池子越界等）直接 409，无绕过开关。
app.post("/:id/schedule/commit", async (c) => {
  const seasonId = parseSeasonId(c.req.param("id"));
  if (seasonId == null) return c.json({ message: "season id 不合法" }, 400);
  const user = c.get("user")!;
  const body = await readJsonBody(c);
  if (body == null) return c.json({ message: "请求体不是合法 JSON" }, 400);

  const key = body.key;
  if (key !== "A" && key !== "B" && key !== "C")
    return c.json({ message: 'key 要是 "A" / "B" / "C"' }, 400);
  if (typeof body.hash !== "string" || !/^[0-9a-f]{64}$/i.test(body.hash))
    return c.json({ message: "hash 要是 64 位十六进制（来自 preview 响应）" }, 400);
  const parsed = solveOptionsFrom(body);
  if (!parsed.ok) return c.json({ message: parsed.message }, 400);

  try {
    // 同参重跑：固定 seed + 步数保证与 preview 一致
    const result = await scheduleSeason(c.env.DB, seasonId, parsed.options);
    const candidate = result.candidates.find((cd) => cd.key === key);
    if (!candidate || candidate.hash !== body.hash) {
      return c.json({ message: "预览已过期（排期数据变了），请重新预览" }, 409);
    }
    const gateScope = parsed.options.segmentIds != null ? new Set(result.segmentIds) : null;
    const candidateMatchIds = new Set(
      [...candidate.assignments, ...candidate.fixed]
        .filter((p) => p.segmentId != null && gateScope?.has(p.segmentId))
        .map((p) => p.matchId)
    );
    const gateViolations = gateScope
      ? scopedCommitViolations(candidate.violations, gateScope, candidateMatchIds)
      : candidate.violations;
    const gate = seasonCommitGate(gateViolations);
    if (!gate.canCommit) {
      return c.json({ message: "存在硬冲突，不能提交", violations: gate.hard }, 409);
    }
    const scopeIds = new Set(result.segmentIds);
    const blockedInScope = result.blockedSegmentIds.filter((id) => scopeIds.has(id));
    if (blockedInScope.length > 0 || candidate.unplacedMatchIds.length > 0) {
      return c.json(
        {
          message: "本次范围还有未排场次（档位满或无可用池），先补齐或缩小到可排段再提交",
          blockedSegmentIds: blockedInScope,
          unplacedMatchIds: candidate.unplacedMatchIds,
        },
        409
      );
    }

    // 只写本候选的可动场；unplaced 场保持旧时刻不动。
    // High-2 + Low-7：场次 UPDATE 和 revision 落账必须在同一个 db.batch 里，
    // 不能先写库再单独 commitSeasonRevision（那会把两个写路径拆成两次事务）。
    // 乐观锁基线：先记下当前最大版本号，再读全季排期；任何并发提交都会让
    // runSeasonRevisionBatch 的 batch 前置守卫失败，而不是用陈旧 placements 覆盖。
    const baseRow = await c.env.DB
      .prepare(`SELECT COALESCE(MAX(revision), 0) AS m FROM schedule_revision WHERE season_id = ?`)
      .bind(seasonId)
      .first<{ m: number }>();
    const baseRevision = baseRow?.m ?? 0;
    const data = await loadSeasonData(c.env.DB, seasonId);
    if (!data.season) return seasonNotFound(c);
    // R5：candidate.hash 只证明「候选内部一致」，不证明「预览后线上没被改」。
    // 用 preview 时的全季 hash 做值级 CAS，把两次读之间的 PATCH / 换队 / 改时刻挡掉。
    const currentBaseHash = await hashSeasonAssignments(data.placements);
    if (currentBaseHash !== result.baseHash) {
      return c.json({ message: "预览已过期（排期数据变了），请重新预览" }, 409);
    }
    const rules = await loadSeasonRules(c.env.DB, seasonId);
    const updatedPlacements = mergeSeasonPlacements(data.placements, candidate.assignments);
    // 预览后库里可能又有人改了时刻：候选 hash 是「预览时的全季快照」，
    // 与写库前的真实全季不一致就说明 proposal 已过期，不能拿它落版本。
    const updatedHash = await hashSeasonAssignments(updatedPlacements);
    if (updatedHash !== candidate.hash) {
      return c.json({ message: "预览已过期（排期数据变了），请重新预览" }, 409);
    }
    const violations = validateSeason(
      {
        segments: data.segments,
        placements: updatedPlacements,
        pools: data.pools,
        season: data.season,
      },
      rules
    );
    // Blocking-3：candidate 是预览时的体检结果，写库前必须用「合并后的真实全季状态」再 gate 一次。
    const updatedScopeMatchIds = new Set(
      updatedPlacements
        .filter((p) => p.segmentId != null && gateScope?.has(p.segmentId))
        .map((p) => p.matchId)
    );
    const gateAfterViolations = gateScope
      ? scopedCommitViolations(violations, gateScope, updatedScopeMatchIds)
      : violations;
    const gateAfter = seasonCommitGate(gateAfterViolations);
    if (!gateAfter.canCommit) {
      return c.json({ message: "存在硬冲突，不能提交", violations: gateAfter.hard }, 409);
    }
    const lockedSegmentIds = new Set(
      data.segments.filter((s) => s.lockedAt != null).map((s) => s.id)
    );
    const lockedAssignments = candidate.assignments.filter(
      (a) => a.segmentId != null && lockedSegmentIds.has(a.segmentId)
    );
    if (lockedAssignments.length > 0) {
      return c.json(
        {
          message: "提交会改动已公布段，先解锁再重排",
          segmentIds: [...new Set(lockedAssignments.map((a) => a.segmentId!))],
        },
        409
      );
    }
    const matchesById = new Map(data.matches.map((m) => [m.id, m]));
    const staleAssignments = candidate.assignments.filter((a) => {
      const m = matchesById.get(a.matchId);
      return !m || m.status !== "pending" || m.override;
    });
    if (staleAssignments.length > 0) {
      return c.json(
        {
          message: "排期数据已变化（场次开赛/改期），请重新预览",
          matchIds: staleAssignments.map((a) => a.matchId),
        },
        409
      );
    }
    const note =
      parsed.options.segmentIds != null
        ? `部分提交：段 ${parsed.options.segmentIds.join("、")}`
        : "全量提交";
    const updateStmt =
      candidate.assignments.length > 0
        ? c.env.DB
            .prepare(
              `UPDATE match AS m SET
                      kickoff_week = CAST(json_extract(j.value, '$.week') AS INTEGER),
                      kickoff_day = CAST(json_extract(j.value, '$.day') AS INTEGER),
                      kickoff_time = json_extract(j.value, '$.time'),
                      kickoff_override = 0,
                      kickoff_reason = NULL
                 FROM json_each(?) AS j
                WHERE m.id = CAST(json_extract(j.value, '$.matchId') AS INTEGER)
                  AND m.status = 'pending'
                  AND m.kickoff_override = 0
                  AND m.score_home IS NULL
                  AND m.score_away IS NULL`
            )
            .bind(
              JSON.stringify(
                candidate.assignments.map((a) => ({
                  matchId: a.matchId,
                  week: a.week,
                  day: a.day,
                  time: a.time,
                }))
              )
            )
        : null;

    const { summary: revisionSummary, businessResults } = await runSeasonRevisionBatch(
      c.env.DB,
      seasonId,
      updatedPlacements,
      {
        createdBy: user.name,
        actorUserId: user.id,
        status: "committed",
        note,
        violations,
        totalMatches: data.matches.length,
        // Medium-4：unmatched 的口径是「已排时刻却映射不到排期段」的场次（归档/总览/回滚都用
        // data.unmatched）；unplayableMatchIds 是「对手未定、排不了」的另一回事，不能混记。
        unmatchedMatchIds: updatedPlacements
          .filter((p) => p.segmentId == null)
          .map((p) => p.matchId),
      },
      updateStmt ? [updateStmt] : [],
      1,
      updateStmt ? [candidate.assignments.length] : [],
      baseRevision
    );
    if (updateStmt && (businessResults[0]?.meta?.changes ?? 0) !== candidate.assignments.length) {
      return c.json({ message: "排期写入被并发改动，请重新预览" }, 409);
    }
    return c.json({
      ok: true,
      revision: revisionSummary,
      applied: candidate.assignments.length,
      violations,
    });
  } catch (err) {
    return seasonError(c, err);
  }
});

// POST /seasons/:id/schedule/publish —— 公布版本并锁定其覆盖的段
// body: { revision?: number }（缺省 = 最新版本）
// 校验：版本存在；当前线上排期与该版本一致（hash 对齐）；整季体检无硬冲突。
// 已 published 的版本重复公布 → 幂等 200。
app.post("/:id/schedule/publish", async (c) => {
  const seasonId = parseSeasonId(c.req.param("id"));
  if (seasonId == null) return c.json({ message: "season id 不合法" }, 400);
  const user = c.get("user")!;
  const body = await readJsonBody(c);
  if (body == null) return c.json({ message: "请求体不是合法 JSON" }, 400);
  const wanted = optionalNonNegInt(body.revision, Number.MAX_SAFE_INTEGER);
  if (wanted === null) return c.json({ message: "revision 要是非负整数" }, 400);

  const data = await loadSeasonData(c.env.DB, seasonId);
  if (!data.season) return seasonNotFound(c);
  const revisions = await listSeasonRevisions(c.env.DB, seasonId);
  if (revisions.length === 0) return c.json({ message: "排期版本不存在" }, 404);
  const target = wanted != null ? revisions.find((r) => r.revision === wanted) : revisions[0];
  if (!target) return c.json({ message: "排期版本不存在" }, 404);

  const currentHash = await hashSeasonAssignments(data.placements);
  if (currentHash !== target.hash) {
    return c.json({ message: "当前排期与该版本不一致，先提交或回滚对齐" }, 409);
  }

  const rules = await loadSeasonRules(c.env.DB, seasonId);
  const violations = validateSeason(data, rules);
  const hard = violations.filter((v) => v.level === "hard");
  if (hard.length > 0) {
    return c.json({ message: "存在硬冲突，不能公布", violations: hard }, 409);
  }

  // 该版本覆盖的段。Blocking-4：只有「段内所有可排场次都已排」才允许锁段，
  // 否则会把半排段一起锁死；已 published 的版本解锁后重公布也要补锁缺失的段。
  const { results: covered } = await c.env.DB
    .prepare(
      `SELECT DISTINCT segment_id FROM schedule_revision_assignment
        WHERE revision_id = ? AND segment_id IS NOT NULL`
    )
    .bind(target.id)
    .all<{ segment_id: number }>();
  const coveredIds = covered.map((r) => r.segment_id);
  const incomplete = coveredIds
    .map((segmentId) => {
      const playable = data.matches.filter(
        (m) =>
          m.segmentId === segmentId && m.homeTeamId != null && m.awayTeamId != null
      );
      const unscheduled = playable.filter(
        (m) => m.kickoffWeek == null || m.kickoffDay == null || m.kickoffTime == null
      );
      return { segmentId, total: playable.length, unscheduled: unscheduled.length };
    })
    .filter((x) => x.unscheduled > 0);
  if (incomplete.length > 0) {
    return c.json(
      {
        message: "版本覆盖的段还有未排场次，不能公布",
        incomplete,
      },
      409
    );
  }

  const lockedById = new Map(data.segments.filter((s) => s.lockedAt != null).map((s) => [s.id, s.lockedAt!]));
  const lockedSegmentIds = coveredIds.filter((id) => !lockedById.has(id));
  const alreadyPublished = target.status === "published";
  if (alreadyPublished && lockedSegmentIds.length === 0) {
    return c.json({ ok: true, alreadyPublished: true, revision: target, lockedSegmentIds: [] });
  }

  const lockedAt = new Date().toISOString();
  // R1：publish 的 hash 校验在 batch 外，必须再用 revision 级 CAS 把「校验 → 写库」之间
  // 的并发提交挡住；否则会把旧版本标成 published，却锁到新版本的段。
  const stmts: D1PreparedStatement[] = [guardRevisionStmt(c.env.DB, seasonId, target.revision)];
  if (!alreadyPublished) {
    stmts.push(
      c.env.DB
        .prepare(`UPDATE schedule_revision SET status = 'published', locked_at = ? WHERE id = ?`)
        .bind(lockedAt, target.id)
    );
    stmts.push(guardChangesStmt(c.env.DB, 1));
  }
  let lockIndex = -1;
  if (lockedSegmentIds.length > 0) {
    stmts.push(
      c.env.DB
        .prepare(
          `UPDATE round_window SET locked_at = ?
            WHERE id IN (SELECT value FROM json_each(?))
              AND locked_at IS NULL`
        )
        .bind(lockedAt, JSON.stringify(lockedSegmentIds))
    );
    lockIndex = stmts.length - 1;
    stmts.push(guardChangesStmt(c.env.DB, lockedSegmentIds.length));
  }
  stmts.push(
    auditStmt(c.env.DB, user.id, "schedule_revision_publish", seasonId, {
      revision: target.revision,
      hash: target.hash,
      lockedSegmentIds,
      alreadyPublished,
    }, "season")
  );
  let results: Awaited<ReturnType<typeof c.env.DB.batch>>;
  try {
    results = await c.env.DB.batch(stmts);
  } catch (err) {
    if (err instanceof Error && err.message.includes("malformed JSON")) {
      return c.json({ message: "版本或段锁定状态已被并发修改，请刷新后重试" }, 409);
    }
    throw err;
  }
  if (lockIndex >= 0) {
    if ((results[lockIndex]?.meta?.changes ?? 0) !== lockedSegmentIds.length) {
      return c.json({ message: "段锁定状态已被并发修改，请刷新后重试" }, 409);
    }
  }

  const reloaded = (await listSeasonRevisions(c.env.DB, seasonId)).find(
    (r) => r.revision === target.revision
  );
  return c.json({ ok: true, revision: reloaded ?? target, lockedSegmentIds });
});

// POST /seasons/:id/schedule/restore/:rid —— 回滚到版本 rid
// 已公布段目标时刻不同 → 409（先解锁）；已开赛场跳过；回滚本身落成 restored 新版本。
app.post("/:id/schedule/restore/:rid", async (c) => {
  const seasonId = parseSeasonId(c.req.param("id"));
  if (seasonId == null) return c.json({ message: "season id 不合法" }, 400);
  const rid = parseSeasonId(c.req.param("rid"));
  if (rid == null) return c.json({ message: "revision 不合法" }, 400);
  const user = c.get("user")!;
  try {
    const result = await restoreSeasonRevision(c.env.DB, seasonId, rid, {
      createdBy: user.name,
      actorUserId: user.id,
    });
    return c.json({
      ok: true,
      revision: result.revision,
      restoredMatchIds: result.restoredMatchIds,
      clearedMatchIds: result.clearedMatchIds,
      skippedMatchIds: result.skippedMatchIds,
      skippedReasons: result.skippedReasons,
      violations: result.violations,
    });
  } catch (err) {
    return seasonError(c, err);
  }
});

// POST /seasons/:id/schedule/archive —— 把当前线上排期一次性归档为 revision 1（幂等）
app.post("/:id/schedule/archive", async (c) => {
  const seasonId = parseSeasonId(c.req.param("id"));
  if (seasonId == null) return c.json({ message: "season id 不合法" }, 400);
  const user = c.get("user")!;
  try {
    const result = await archiveSeasonRevision(c.env.DB, seasonId, {
      createdBy: user.name,
      actorUserId: user.id,
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    return seasonError(c, err);
  }
});

export default app;
