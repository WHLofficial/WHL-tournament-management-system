// 排期器管理端接口（P3-B）：窗口粒度的预览 / 提交 / 公布 / 解锁 / 回滚，以及单场改期。
// 排期算法在 worker/lib/kickoffScheduler.ts（纯函数），这里只负责取数、校验、落库与留痕。
// 口径：时刻是虚拟标签（周/天/HH:MM），不换算真实日期；一场比赛的「有赛果」= 不允许再排。
import { Hono } from "hono";
import type { AppEnv } from "../../env";
import { auditStmt } from "../../lib/audit";
import { sha256Hex } from "../../lib/crypto";
import { phaseForWeek, type Competition, type Stream } from "../../lib/kickoffCalendar";
import {
  absHours,
  parseTime,
  scheduleWindow,
  validatePlacement,
  type History,
  type SchedMatch,
  type Slot,
} from "../../lib/kickoffScheduler";

const app = new Hono<AppEnv>();

type WindowRow = {
  id: number;
  season_id: number;
  tournament_id: number;
  stream: Stream;
  round: number;
  leg: number | null;
  week: number;
  day_start: number;
  day_end: number;
  slot_override: string | null;
  locked_at: string | null;
  tournament_name: string;
};

type MatchRow = {
  id: number;
  round: number;
  slot: number;
  leg: number | null;
  status: string;
  stage_id: number;
  score_home: number | null;
  score_away: number | null;
  kickoff_override: number;
  kickoff_week: number | null;
  kickoff_day: number | null;
  kickoff_time: string | null;
  home_team_id: number | null;
  away_team_id: number | null;
  home_name: string | null;
  away_name: string | null;
};

type Placed = {
  matchId: number;
  week: number;
  day: number;
  time: string;
};

const MATCH_SELECT = `SELECT m.id, m.stage_id, m.round, m.slot, m.leg, m.status,
       m.score_home, m.score_away, m.kickoff_override,
       m.kickoff_week, m.kickoff_day, m.kickoff_time,
       he.team_id AS home_team_id, ae.team_id AS away_team_id,
       ht.name AS home_name, at.name AS away_name
  FROM match m
  LEFT JOIN entry he ON he.id = m.home_entry_id
  LEFT JOIN team ht ON ht.id = he.team_id
  LEFT JOIN entry ae ON ae.id = m.away_entry_id
  LEFT JOIN team at ON at.id = ae.team_id`;

function competitionOf(name: string): Competition {
  if (name.includes("冠军杯")) return "cup";
  if (name.includes("次级")) return "sub";
  return "top";
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

async function loadWindow(
  db: D1Database,
  tournamentId: number,
  windowId: number
): Promise<WindowRow | null> {
  return db
    .prepare(
      `SELECT w.*, t.name AS tournament_name
         FROM round_window w JOIN tournament t ON t.id = w.tournament_id
        WHERE w.id = ? AND w.tournament_id = ?`
    )
    .bind(windowId, tournamentId)
    .first<WindowRow>();
}

/** 窗口对应哪些 stage：次级联赛的「联赛轮」与「小组/淘汰轮」共用 round 号，只能靠 stage 配置区分。 */
async function stageIdsFor(
  db: D1Database,
  window: WindowRow,
  comp: Competition
): Promise<number[]> {
  const { results } = await db
    .prepare(`SELECT id, kind, config_json FROM stage WHERE tournament_id = ? ORDER BY sort_order, id`)
    .bind(window.tournament_id)
    .all<{ id: number; kind: string; config_json: string | null }>();
  const hasSource = (json: string | null): boolean => {
    try {
      return Boolean(JSON.parse(json ?? "{}").source);
    } catch {
      return false;
    }
  };
  if (comp === "cup") {
    const kind = window.stream === "group" ? "group" : "elim";
    return results.filter((r) => r.kind === kind).map((r) => r.id);
  }
  if (comp === "sub") {
    if (window.stream === "league") {
      return results.filter((r) => r.kind === "round_robin" && !hasSource(r.config_json)).map((r) => r.id);
    }
    // 附加赛窗口用 round=0 记，对应 stage 5 的 round 1
    if (window.round === 0) return results.filter((r) => r.kind === "elim").map((r) => r.id);
    return results.filter((r) => r.kind === "round_robin" && hasSource(r.config_json)).map((r) => r.id);
  }
  return results.filter((r) => r.kind === "round_robin").map((r) => r.id);
}

/** 窗口里的场次：附加赛（round 0）落到 stage 的 round 1。 */
async function loadWindowMatches(
  db: D1Database,
  window: WindowRow,
  comp: Competition
): Promise<MatchRow[]> {
  const stageIds = await stageIdsFor(db, window, comp);
  if (stageIds.length === 0) return [];
  const matchRound = comp === "sub" && window.stream === "playoff" && window.round === 0 ? 1 : window.round;
  const legSql = window.leg == null ? "m.leg IS NULL" : "m.leg = ?";
  const args: unknown[] = [...stageIds, matchRound];
  if (window.leg != null) args.push(window.leg);
  const { results } = await db
    .prepare(
      `${MATCH_SELECT}
        WHERE m.stage_id IN (${placeholders(stageIds.length)}) AND m.round = ? AND ${legSql}
        ORDER BY m.slot, m.id`
    )
    .bind(...args)
    .all<MatchRow>();
  return results;
}

type PoolView = {
  pool: Record<number, Slot[]>;
  dayStart: number;
  dayEnd: number;
  overridden: boolean;
  /** 末轮同时开球：窗口内所有场次压在同一天同一刻（防止看别人的结果踢） */
  simultaneous: boolean;
};

function parseOverride(raw: string | null, dayEnd: number): { day: number; slots: Slot[] } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    // 兼容 0031 刚落地时的旧形态（纯数组，视为窗口最后一天）
    if (Array.isArray(v)) return { day: dayEnd, slots: v as Slot[] };
    const o = v as { day?: number; slots?: Slot[] };
    if (o && Number.isInteger(o.day) && Array.isArray(o.slots)) return { day: o.day!, slots: o.slots! };
  } catch {
    /* 坏 JSON 当没有覆盖 */
  }
  return null;
}

async function poolFor(
  db: D1Database,
  window: WindowRow,
  comp: Competition
): Promise<PoolView> {
  const override = parseOverride(window.slot_override, window.day_end);
  if (override && override.slots.length > 0) {
    return {
      pool: { [override.day]: override.slots },
      dayStart: override.day,
      dayEnd: override.day,
      overridden: true,
      simultaneous: true,
    };
  }
  const phase = phaseForWeek(window.week);
  const { results } = await db
    .prepare(
      `SELECT day, slots FROM time_pool WHERE season_id = ? AND phase = ? AND competition = ?`
    )
    .bind(window.season_id, phase, comp)
    .all<{ day: number; slots: string }>();
  const pool: Record<number, Slot[]> = {};
  for (const row of results) {
    try {
      pool[row.day] = JSON.parse(row.slots) as Slot[];
    } catch {
      pool[row.day] = [];
    }
  }
  return { pool, dayStart: window.day_start, dayEnd: window.day_end, overridden: false, simultaneous: false };
}

/** 该 stream 在本赛季的最大轮次 —— 末轮（= 最大轮）必须同时开球。 */
async function maxRoundOfStream(
  db: D1Database,
  seasonId: number,
  tournamentId: number,
  stream: string
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT MAX(round) AS m FROM round_window
        WHERE season_id = ? AND tournament_id = ? AND stream = ?`
    )
    .bind(seasonId, tournamentId, stream)
    .first<{ m: number | null }>();
  return row?.m ?? null;
}

/** 末轮同开：取窗口最后一天的最晚档，容量放开到全场次数。 */
function collapseToCommonSlot(view: PoolView, playable: number): PoolView {
  for (let day = view.dayEnd; day >= view.dayStart; day -= 1) {
    const slots = view.pool[day];
    if (!slots || slots.length === 0) continue;
    const latest = slots.reduce((a, b) => (parseTime(b.time) > parseTime(a.time) ? b : a));
    return {
      pool: { [day]: [{ time: latest.time, cap: Math.max(playable, 1) }] },
      dayStart: day,
      dayEnd: day,
      overridden: true,
      simultaneous: true,
    };
  }
  return view;
}

/** 该窗口之前已排的场次，折算成每队「上一场开球时刻 / 上一场是否主场」。 */
async function loadHistory(
  db: D1Database,
  seasonId: number,
  before: number
): Promise<History> {
  const { results } = await db
    .prepare(`SELECT DISTINCT tournament_id FROM round_window WHERE season_id = ?`)
    .bind(seasonId)
    .all<{ tournament_id: number }>();
  const tids = results.map((r) => r.tournament_id);
  if (tids.length === 0) return new Map();
  const { results: rows } = await db
    .prepare(
      `SELECT m.kickoff_week AS week, m.kickoff_day AS day, m.kickoff_time AS time,
              he.team_id AS home_id, ae.team_id AS away_id
         FROM match m
         JOIN stage s ON s.id = m.stage_id
         LEFT JOIN entry he ON he.id = m.home_entry_id
         LEFT JOIN entry ae ON ae.id = m.away_entry_id
        WHERE s.tournament_id IN (${placeholders(tids.length)})
          AND m.kickoff_week IS NOT NULL AND m.kickoff_day IS NOT NULL AND m.kickoff_time IS NOT NULL`
    )
    .bind(...tids)
    .all<{ week: number; day: number; time: string; home_id: number | null; away_id: number | null }>();
  const history: History = new Map();
  for (const row of rows) {
    const start = absHours(row.week, row.day, row.time);
    if (start >= before) continue;
    const bump = (teamId: number | null, wasHome: boolean) => {
      if (teamId == null) return;
      const prev = history.get(teamId);
      if (prev && prev.lastStartHours >= start) return;
      history.set(teamId, { lastStartHours: start, lastWasHome: wasHome });
    };
    bump(row.home_id, true);
    bump(row.away_id, false);
  }
  return history;
}

type Plan = {
  window: WindowRow;
  comp: Competition;
  matches: MatchRow[];
  poolView: PoolView;
  schedMatches: SchedMatch[];
  history: History;
};

async function buildPlan(db: D1Database, window: WindowRow): Promise<Plan> {
  const comp = competitionOf(window.tournament_name);
  const matches = await loadWindowMatches(db, window, comp);
  const playable = matches.filter((m) => m.home_team_id != null && m.away_team_id != null).length;
  const maxRound = await maxRoundOfStream(db, window.season_id, window.tournament_id, window.stream);
  const isLast = maxRound != null && window.round === maxRound;
  const baseView = await poolFor(db, window, comp);
  const poolView =
    isLast && !baseView.simultaneous ? collapseToCommonSlot(baseView, playable) : baseView;
  const history = await loadHistory(db, window.season_id, absHours(window.week, poolView.dayStart, "00:00"));
  const schedMatches: SchedMatch[] = matches
    .filter((m) => m.home_team_id != null && m.away_team_id != null)
    .map((m) => ({ id: m.id, slot: m.slot, homeTeamId: m.home_team_id!, awayTeamId: m.away_team_id! }));
  return { window, comp, matches, poolView, schedMatches, history };
}

/** 一次求解：scheduleWindow 会改写传入的 history，所以每个请求只调一次。 */
function solve(plan: Plan) {
  return scheduleWindow({
    week: plan.window.week,
    dayStart: plan.poolView.dayStart,
    dayEnd: plan.poolView.dayEnd,
    pool: plan.poolView.pool,
    matches: plan.schedMatches,
    history: plan.history,
  });
}

const toPlaced = (plan: Plan, assignments: { matchId: number; day: number; time: string }[]): Placed[] =>
  assignments.map((a) => ({ matchId: a.matchId, week: plan.window.week, day: a.day, time: a.time }));

/** 提案指纹：只对「场次 → 时刻」排序后取哈希，前端拿它提交，数据变了就 409。 */
async function hashProposal(places: Placed[]): Promise<string> {
  const normalized = [...places]
    .sort((a, b) => a.matchId - b.matchId)
    .map((p) => `${p.matchId}:${p.week}:${p.day}:${p.time}`)
    .join("|");
  return sha256Hex(normalized);
}

function toDto(matches: MatchRow[], places: Placed[] | null) {
  const byId = new Map((places ?? []).map((p) => [p.matchId, p]));
  return matches.map((m) => {
    const planned = byId.get(m.id);
    const week = planned?.week ?? m.kickoff_week;
    const day = planned?.day ?? m.kickoff_day;
    const time = planned?.time ?? m.kickoff_time;
    return {
      matchId: m.id,
      slot: m.slot,
      homeName: m.home_name,
      awayName: m.away_name,
      status: m.status,
      scoreHome: m.score_home,
      scoreAway: m.score_away,
      week,
      day,
      time,
      override: planned ? false : m.kickoff_override === 1,
      playable: m.home_team_id != null && m.away_team_id != null,
    };
  });
}

/** 窗口里有没有不能动的场次：已开赛/已完赛/有比分。 */
function lockReason(matches: MatchRow[]): string | null {
  const started = matches.filter(
    (m) => m.status !== "pending" || m.score_home != null || m.score_away != null
  );
  if (started.length > 0) return `窗口内有 ${started.length} 场已开赛或有比分，不能重排`;
  return null;
}

// ---------- 路由 ----------

// GET /tournaments/:id/windows —— 赛历窗口清单（排期页的左侧列表）
app.get("/:id/windows", async (c) => {
  const tid = Number(c.req.param("id"));
  if (!Number.isInteger(tid)) return c.json({ message: "tournament id 不合法" }, 400);
  const { results } = await c.env.DB.prepare(
    `SELECT w.*, t.name AS tournament_name
       FROM round_window w JOIN tournament t ON t.id = w.tournament_id
      WHERE w.tournament_id = ?
      ORDER BY w.week, w.stream, w.round, w.leg`
  )
    .bind(tid)
    .all<WindowRow>();
  const windows: Array<Record<string, unknown>> = [];
  for (const w of results) {
    const matches = await loadWindowMatches(c.env.DB, w, competitionOf(w.tournament_name));
    windows.push({
      id: w.id,
      stream: w.stream,
      round: w.round,
      leg: w.leg,
      week: w.week,
      dayStart: w.day_start,
      dayEnd: w.day_end,
      lockedAt: w.locked_at,
      matchCount: matches.length,
      scheduledCount: matches.filter((m) => m.kickoff_week != null && m.kickoff_time != null).length,
      playableCount: matches.filter((m) => m.home_team_id != null && m.away_team_id != null).length,
      hasOverride: w.slot_override != null,
    });
  }
  return c.json({ windows });
});

// GET /tournaments/:id/windows/:wid/schedule —— 当前时刻 + 体检结果
app.get("/:id/windows/:wid/schedule", async (c) => {
  const tid = Number(c.req.param("id"));
  const wid = Number(c.req.param("wid"));
  const window = await loadWindow(c.env.DB, tid, wid);
  if (!window) return c.json({ message: "窗口不存在" }, 404);
  const plan = await buildPlan(c.env.DB, window);
  const violations = validatePlacement(
    plan.matches
      .filter((m) => m.kickoff_week != null && m.kickoff_day != null && m.kickoff_time != null)
      .map((m) => ({
        id: m.id,
        slot: m.slot,
        homeTeamId: m.home_team_id,
        awayTeamId: m.away_team_id,
        week: m.kickoff_week!,
        day: m.kickoff_day!,
        time: m.kickoff_time!,
      })),
    { week: window.week, dayStart: plan.poolView.dayStart, dayEnd: plan.poolView.dayEnd, pool: plan.poolView.pool }
  );
  return c.json({
    window: {
      id: window.id,
      stream: window.stream,
      round: window.round,
      leg: window.leg,
      week: window.week,
      dayStart: plan.poolView.dayStart,
      dayEnd: plan.poolView.dayEnd,
      overridden: plan.poolView.overridden,
      simultaneous: plan.poolView.simultaneous,
      lockedAt: window.locked_at,
    },
    matches: toDto(plan.matches, null),
    violations,
    blocked: lockReason(plan.matches),
  });
});

// POST /tournaments/:id/windows/:wid/schedule/preview —— 出提案（不写库）
app.post("/:id/windows/:wid/schedule/preview", async (c) => {
  const tid = Number(c.req.param("id"));
  const wid = Number(c.req.param("wid"));
  const window = await loadWindow(c.env.DB, tid, wid);
  if (!window) return c.json({ message: "窗口不存在" }, 404);
  if (window.locked_at) return c.json({ message: "窗口已公布，先解锁再重排" }, 409);
  const plan = await buildPlan(c.env.DB, window);
  const blocked = lockReason(plan.matches);
  if (blocked) return c.json({ message: blocked }, 409);
  if (plan.schedMatches.length === 0) return c.json({ message: "窗口内没有可排的场次（对手未定）" }, 409);

  const solved = solve(plan);
  const places = toPlaced(plan, solved.assignments);
  const conflicts = solved.conflicts;
  const hard = conflicts.filter((x) => x.level === "hard");
  return c.json({
    proposalHash: await hashProposal(places),
    matches: toDto(plan.matches, places),
    conflicts,
    canCommit: hard.length === 0,
    unscheduled: plan.matches.filter((m) => m.home_team_id == null || m.away_team_id == null).map((m) => m.id),
  });
});

// POST /tournaments/:id/windows/:wid/schedule/commit —— 按预览指纹落库
app.post("/:id/windows/:wid/schedule/commit", async (c) => {
  const tid = Number(c.req.param("id"));
  const wid = Number(c.req.param("wid"));
  const body = (await c.req.json().catch(() => null)) as { proposalHash?: string } | null;
  if (!body?.proposalHash) return c.json({ message: "缺少 proposalHash" }, 400);
  const window = await loadWindow(c.env.DB, tid, wid);
  if (!window) return c.json({ message: "窗口不存在" }, 404);
  if (window.locked_at) return c.json({ message: "窗口已公布，先解锁再重排" }, 409);

  const plan = await buildPlan(c.env.DB, window);
  const blocked = lockReason(plan.matches);
  if (blocked) return c.json({ message: blocked }, 409);
  const solved = solve(plan);
  const places = toPlaced(plan, solved.assignments);
  if ((await hashProposal(places)) !== body.proposalHash)
    return c.json({ message: "预览已过期（窗口数据或历史变了），请重新预览" }, 409);

  const conflicts = solved.conflicts;
  const hard = conflicts.filter((x) => x.level === "hard");
  if (hard.length > 0)
    return c.json({ message: "存在硬冲突，不能提交", conflicts: hard }, 422);

  const user = c.get("user")!;
  const stmts = places.map((p) =>
    c.env.DB.prepare(
      `UPDATE match SET kickoff_week = ?, kickoff_day = ?, kickoff_time = ?,
              kickoff_override = 0, kickoff_reason = NULL
        WHERE id = ?`
    ).bind(p.week, p.day, p.time, p.matchId)
  );
  stmts.push(
    c.env.DB.prepare(
      `INSERT INTO schedule_snapshot (window_id, payload, created_by) VALUES (?, ?, ?)`
    ).bind(window.id, JSON.stringify({ assignments: places, conflicts }), user.name)
  );
  stmts.push(
    auditStmt(
      c.env.DB,
      user.id,
      "kickoff_commit",
      window.id,
      { tournamentId: tid, week: window.week, count: places.length, conflicts: conflicts.length },
      "round_window"
    )
  );
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, count: places.length, conflicts });
});

// DELETE /tournaments/:id/windows/:wid/schedule —— 清空该窗口的时刻（未公布、未开赛）
app.delete("/:id/windows/:wid/schedule", async (c) => {
  const tid = Number(c.req.param("id"));
  const wid = Number(c.req.param("wid"));
  const window = await loadWindow(c.env.DB, tid, wid);
  if (!window) return c.json({ message: "窗口不存在" }, 404);
  if (window.locked_at) return c.json({ message: "窗口已公布，先解锁再清空" }, 409);
  const plan = await buildPlan(c.env.DB, window);
  const blocked = lockReason(plan.matches);
  if (blocked) return c.json({ message: blocked }, 409);
  const user = c.get("user")!;
  const ids = plan.matches.map((m) => m.id);
  const stmts = ids.map((id) =>
    c.env.DB.prepare(
      `UPDATE match SET kickoff_week = NULL, kickoff_day = NULL, kickoff_time = NULL,
              kickoff_override = 0, kickoff_reason = NULL
        WHERE id = ?`
    ).bind(id)
  );
  stmts.push(
    auditStmt(c.env.DB, user.id, "kickoff_clear", window.id, { tournamentId: tid, count: ids.length }, "round_window")
  );
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, cleared: ids.length });
});

// POST /tournaments/:id/windows/:wid/publish —— 公布即锁定
app.post("/:id/windows/:wid/publish", async (c) => {
  const tid = Number(c.req.param("id"));
  const wid = Number(c.req.param("wid"));
  const window = await loadWindow(c.env.DB, tid, wid);
  if (!window) return c.json({ message: "窗口不存在" }, 404);
  if (window.locked_at) return c.json({ ok: true, lockedAt: window.locked_at });
  const plan = await buildPlan(c.env.DB, window);
  const missing = plan.matches.filter((m) => m.kickoff_week == null || m.kickoff_time == null);
  if (missing.length > 0)
    return c.json({ message: `还有 ${missing.length} 场没有时刻`, matchIds: missing.map((m) => m.id) }, 409);
  const now = new Date().toISOString();
  const user = c.get("user")!;
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE round_window SET locked_at = ? WHERE id = ?`).bind(now, window.id),
    auditStmt(c.env.DB, user.id, "kickoff_publish", window.id, { tournamentId: tid, week: window.week }, "round_window"),
  ]);
  return c.json({ ok: true, lockedAt: now });
});

// POST /tournaments/:id/windows/:wid/unlock —— 解锁（必须给理由）
app.post("/:id/windows/:wid/unlock", async (c) => {
  const tid = Number(c.req.param("id"));
  const wid = Number(c.req.param("wid"));
  const body = (await c.req.json().catch(() => null)) as { reason?: string } | null;
  const reason = body?.reason?.trim();
  if (!reason) return c.json({ message: "解锁要写理由" }, 400);
  const window = await loadWindow(c.env.DB, tid, wid);
  if (!window) return c.json({ message: "窗口不存在" }, 404);
  const user = c.get("user")!;
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE round_window SET locked_at = NULL WHERE id = ?`).bind(window.id),
    auditStmt(c.env.DB, user.id, "kickoff_unlock", window.id, { tournamentId: tid, reason }, "round_window"),
  ]);
  return c.json({ ok: true });
});

// POST /tournaments/:id/windows/:wid/restore/:snapshotId —— 回到某次提交
app.post("/:id/windows/:wid/restore/:snapshotId", async (c) => {
  const tid = Number(c.req.param("id"));
  const wid = Number(c.req.param("wid"));
  const sid = Number(c.req.param("snapshotId"));
  const window = await loadWindow(c.env.DB, tid, wid);
  if (!window) return c.json({ message: "窗口不存在" }, 404);
  if (window.locked_at) return c.json({ message: "窗口已公布，先解锁" }, 409);
  const snap = await c.env.DB.prepare(
    `SELECT payload, created_at FROM schedule_snapshot WHERE id = ? AND window_id = ?`
  )
    .bind(sid, window.id)
    .first<{ payload: string; created_at: string }>();
  if (!snap) return c.json({ message: "快照不存在" }, 404);
  const parsed = JSON.parse(snap.payload) as { assignments?: Placed[] };
  const places = parsed.assignments ?? [];
  if (places.length === 0) return c.json({ message: "快照为空" }, 409);
  const plan = await buildPlan(c.env.DB, window);
  const blocked = lockReason(plan.matches);
  if (blocked) return c.json({ message: blocked }, 409);
  const user = c.get("user")!;
  const stmts = places.map((p) =>
    c.env.DB.prepare(
      `UPDATE match SET kickoff_week = ?, kickoff_day = ?, kickoff_time = ? WHERE id = ?`
    ).bind(p.week, p.day, p.time, p.matchId)
  );
  stmts.push(
    auditStmt(c.env.DB, user.id, "kickoff_restore", window.id, { tournamentId: tid, snapshotId: sid }, "round_window")
  );
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, restored: places.length, snapshotAt: snap.created_at });
});

// PATCH /tournaments/:id/matches/:matchId/kickoff —— 单场改期（补赛/转播调整）
app.patch("/:id/matches/:matchId/kickoff", async (c) => {
  const tid = Number(c.req.param("id"));
  const matchId = Number(c.req.param("matchId"));
  const body = (await c.req.json().catch(() => null)) as
    | { week?: number | null; day?: number | null; time?: string | null; reason?: string }
    | null;
  if (!body) return c.json({ message: "缺少请求体" }, 400);
  const clearing = body.week == null && body.day == null && body.time == null;

  const row = await c.env.DB.prepare(
    `${MATCH_SELECT}
        JOIN stage s ON s.id = m.stage_id
       WHERE m.id = ? AND s.tournament_id = ?`
  )
    .bind(matchId, tid)
    .first<MatchRow>();
  if (!row) return c.json({ message: "场次不存在" }, 404);

  const { results: windows } = await c.env.DB.prepare(
    `SELECT w.*, t.name AS tournament_name
       FROM round_window w JOIN tournament t ON t.id = w.tournament_id
      WHERE w.tournament_id = ?`
  )
    .bind(tid)
    .all<WindowRow>();
  let window: WindowRow | null = null;
  for (const w of windows) {
    const comp = competitionOf(w.tournament_name);
    const stageIds = await stageIdsFor(c.env.DB, w, comp);
    const matchRound = comp === "sub" && w.stream === "playoff" && w.round === 0 ? 1 : w.round;
    const legOk = w.leg == null ? row.leg == null : row.leg === w.leg;
    if (stageIds.includes(row.stage_id) && row.round === matchRound && legOk) {
      window = w;
      break;
    }
  }
  if (!window) return c.json({ message: "该场次没有排期窗口" }, 409);
  if (window.locked_at) return c.json({ message: "窗口已公布，先解锁再改单场" }, 409);
  if (row.status !== "pending" || row.score_home != null || row.score_away != null)
    return c.json({ message: "已有赛果，不能再改时刻" }, 409);

  const user = c.get("user")!;
  if (clearing) {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE match SET kickoff_week = NULL, kickoff_day = NULL, kickoff_time = NULL,
                kickoff_override = 0, kickoff_reason = NULL WHERE id = ?`
      ).bind(matchId),
      auditStmt(c.env.DB, user.id, "kickoff_patch_clear", matchId, { tournamentId: tid }, "round_window"),
    ]);
    return c.json({ ok: true, cleared: true, warnings: [] });
  }

  const { week, day, time } = body as { week?: number; day?: number; time?: string };
  if (!Number.isInteger(week) || !Number.isInteger(day) || typeof time !== "string")
    return c.json({ message: "week / day / time 要一起给" }, 400);
  if (!/^\d{2}:\d{2}$/.test(time)) return c.json({ message: "time 用 HH:MM" }, 400);
  if (day! < 1 || day! > 7) return c.json({ message: "day 只能是 1–7" }, 400);

  const comp = competitionOf(window.tournament_name);
  const poolView = await poolFor(c.env.DB, window, comp);
  const warnings: string[] = [];
  if (week !== window.week) warnings.push(`不在窗口周次（窗口是第 ${window.week} 周）`);
  if (day! < poolView.dayStart || day! > poolView.dayEnd)
    warnings.push(`不在窗口天数（窗口是第 ${poolView.dayStart}–${poolView.dayEnd} 天）`);
  const slots = poolView.pool[day!] ?? [];
  const slot = slots.find((s) => s.time === time);
  if (!slot) warnings.push(`时刻不在池子里（第 ${day} 天可选：${slots.map((s) => s.time).join(" / ") || "无"}）`);
  if (warnings.length > 0 && !body.reason?.trim())
    return c.json({ message: "越窗改期要写理由", warnings }, 400);

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE match SET kickoff_week = ?, kickoff_day = ?, kickoff_time = ?,
              kickoff_override = 1, kickoff_reason = ? WHERE id = ?`
    ).bind(week, day, time, body.reason?.trim() ?? null, matchId),
    auditStmt(
      c.env.DB,
      user.id,
      "kickoff_patch",
      matchId,
      { tournamentId: tid, week, day, time, reason: body.reason ?? null, warnings },
      "round_window"
    ),
  ]);
  return c.json({ ok: true, warnings });
});

export default app;
