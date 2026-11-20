// 赛季级排期（S2）：赛季总览取数、整季体检、赛季级求解引擎、基线归档。
//
// 设计见 docs/design-season-scheduler.md：
//   season（赛季）→ segment（段，物理表仍是 round_window）→ slot（周/天/时刻）。
//   S1 落地只读总览 + revision 1 基线归档；S2 在这里补齐：
//     - scheduleSeason：整季（或指定段）一次解出 3 套可复现的候选方案；
//     - auditSeason / validateSeason：48h/64h/72h、两连主、末轮同开、容量、跨段相邻场。
//   S3 的赛季级五端点（preview/commit/publish/restore）以后也在这里接。
//
// 和窗口级接口的关系：
//   - 窗口级预览/提交/公布/回滚仍在 routes/admin/kickoff.ts，读写 match.kickoff_* 与
//     schedule_snapshot；本文件不碰 schedule_snapshot。
//   - 这里按「赛事 → stage → round_window」的同一口径把场次映射到段，
//     口径与 kickoff.ts 的 stageIdsFor / loadWindowMatches / poolFor / parseOverride /
//     collapseToCommonSlot 保持一致（S3 收口时合并）。
import { auditStmt } from "./audit";
import { sha256Hex } from "./crypto";
import { phaseForWeek, type Competition, type Stream } from "./kickoffCalendar";
import {
  absHours,
  mulberry32,
  parseTime,
  scheduleWindow,
  type History,
  type Slot,
} from "./kickoffScheduler";

// ---------- 类型 ----------

export type SeasonRow = {
  id: number;
  name: string;
  weeks: number;
};

export type SeasonSegment = {
  id: number;
  tournamentId: number;
  tournamentName: string;
  competition: Competition;
  stream: Stream;
  round: number;
  leg: number | null;
  week: number;
  dayStart: number;
  dayEnd: number;
  slotOverride: string | null;
  lockedAt: string | null;
  /** 该段对应的 stage id（次级联赛的联赛轮/附加赛共用 round 号，靠 stage 配置区分） */
  stageIds: number[];
};

export type SeasonMatch = {
  id: number;
  stageId: number;
  round: number;
  leg: number | null;
  slot: number;
  status: string;
  scoreHome: number | null;
  scoreAway: number | null;
  homeTeamId: number | null;
  awayTeamId: number | null;
  kickoffWeek: number | null;
  kickoffDay: number | null;
  kickoffTime: string | null;
  override: boolean;
  reason: string | null;
  /** 解析出来的段；null = 这场没有对应的 round_window（异常数据，归档时单列） */
  segmentId: number | null;
};

export type SeasonPlacement = {
  matchId: number;
  segmentId: number | null;
  week: number;
  day: number;
  time: string;
  override: boolean;
  reason: string | null;
  homeTeamId: number | null;
  awayTeamId: number | null;
};

/** 一段的时刻池：slot_override 优先，否则按周次的 phase 取 time_pool（S2）。 */
export type SegmentPool = {
  segmentId: number;
  /** day → 档位 */
  pool: Record<number, Slot[]>;
  dayStart: number;
  dayEnd: number;
  /** slot_override 生效（该轮窗口口径里视为已同开） */
  overridden: boolean;
  /** 该赛事 stream 的最后一轮（末轮同开约束挂在它上面） */
  lastRound: boolean;
};

export type SeasonData = {
  season: SeasonRow | null;
  segments: SeasonSegment[];
  /** 赛季内所有场次（含未排时刻的） */
  matches: SeasonMatch[];
  /** 已排时刻的场次（week/day/time 齐全） */
  placements: SeasonPlacement[];
  /** 已排时刻但映射不到段的场次（异常，归档时记 id） */
  unmatched: SeasonMatch[];
  /** 每段一条的时刻池（体检的容量/末轮同开、引擎的档位都从这里来） */
  pools: SegmentPool[];
};

export type SeasonRule = {
  competition: "all" | Competition;
  minGapHours: number;
  softGapHours: number;
  reportGapHours: number;
  consecutiveHomeExempt: boolean;
  lastRoundSimultaneous: boolean;
};

export const DEFAULT_SEASON_RULE: Omit<SeasonRule, "competition"> = {
  minGapHours: 48,
  softGapHours: 64,
  reportGapHours: 72,
  consecutiveHomeExempt: true,
  lastRoundSimultaneous: true,
};

export type SeasonViolation = {
  matchId: number;
  /** hard = 拒绝提交；soft = 警告；report = 72h 备用约束，只报告不动门槛 */
  level: "hard" | "soft" | "report";
  reason: string;
  teamId?: number;
  segmentId?: number | null;
  /**
   * 同队间隔类违规牵涉两场：matchId 是后一场，relatedMatchId 是前一场。
   * 窗口级门槛靠它判断「另一条腿在不在本窗口」——两边都不在本窗口的预存冲突，
   * 本窗口重排修不了，不该卡窗口提交（Medium-2）。
   */
  relatedMatchId?: number;
};

export type RevisionStatus = "draft" | "committed" | "published" | "restored";

export type RevisionMetrics = {
  segments: number;
  matches: number;
  scheduled: number;
  unmatchedMatchIds: number[];
  hard: number;
  soft: number;
};

export type SeasonRevisionSummary = {
  id: number;
  seasonId: number;
  revision: number;
  hash: string;
  status: RevisionStatus;
  lockedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  metrics: RevisionMetrics | null;
  note: string | null;
  assignmentCount: number;
};

export type ArchiveSeasonRevisionResult = SeasonRevisionSummary & {
  alreadyArchived: boolean;
  unmatchedMatchIds: number[];
};

// S3：赛季级五端点的业务错误码。
//   season_not_found / revision_not_found → 404
//   segment_not_found → 400（preview/commit 的 segmentIds 参数不合法）
//   empty_schedule / hash_mismatch / segment_locked → 409
export type SeasonRevisionErrorCode =
  | "season_not_found"
  | "empty_schedule"
  | "segment_not_found"
  | "revision_not_found"
  | "hash_mismatch"
  | "segment_locked"
  | "baseline_mismatch"
  | "revision_incomplete"
  | "restore_conflict"
  | "revision_conflict"
  | "invalid_schedule";

export class SeasonRevisionError extends Error {
  constructor(
    public readonly code: SeasonRevisionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SeasonRevisionError";
  }
}

// ---------- 取数 ----------

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

type StageRow = {
  id: number;
  tournament_id: number;
  kind: string;
  config_json: string | null;
};

type MatchRow = {
  id: number;
  stage_id: number;
  round: number;
  leg: number | null;
  slot: number;
  status: string;
  score_home: number | null;
  score_away: number | null;
  home_team_id: number | null;
  away_team_id: number | null;
  kickoff_week: number | null;
  kickoff_day: number | null;
  kickoff_time: string | null;
  kickoff_override: number;
  kickoff_reason: string | null;
};

type SeasonRuleRow = {
  competition: string;
  min_gap_hours: number;
  soft_gap_hours: number;
  report_gap_hours: number;
  consecutive_home_exempt: number;
  last_round_simultaneous: number;
};

type RevisionRow = {
  id: number;
  season_id: number;
  revision: number;
  hash: string;
  status: string;
  locked_at: string | null;
  created_by: string | null;
  created_at: string;
  metrics_json: string | null;
  note: string | null;
  assignment_count: number;
};

export function competitionOf(name: string): Competition {
  if (name.includes("冠军杯")) return "cup";
  if (name.includes("次级")) return "sub";
  return "top";
}

/** 与 routes/admin/kickoff.ts 的 stageIdsFor 同口径。 */
function stageIdsForWindow(
  window: { stream: Stream; round: number },
  stages: StageRow[],
  comp: Competition
): number[] {
  const hasSource = (json: string | null): boolean => {
    try {
      return Boolean(JSON.parse(json ?? "{}").source);
    } catch {
      return false;
    }
  };
  if (comp === "cup") {
    const kind = window.stream === "group" ? "group" : "elim";
    return stages.filter((s) => s.kind === kind).map((s) => s.id);
  }
  if (comp === "sub") {
    if (window.stream === "league") {
      return stages.filter((s) => s.kind === "round_robin" && !hasSource(s.config_json)).map((s) => s.id);
    }
    // 附加赛窗口用 round=0 记，对应 stage 的 round 1
    if (window.round === 0) return stages.filter((s) => s.kind === "elim").map((s) => s.id);
    return stages.filter((s) => s.kind === "round_robin" && hasSource(s.config_json)).map((s) => s.id);
  }
  return stages.filter((s) => s.kind === "round_robin").map((s) => s.id);
}

async function loadSeasonSegments(db: D1Database, seasonId: number): Promise<SeasonSegment[]> {
  const { results: windows } = await db
    .prepare(
      `SELECT w.id, w.season_id, w.tournament_id, w.stream, w.round, w.leg, w.week,
              w.day_start, w.day_end, w.slot_override, w.locked_at,
              t.name AS tournament_name
         FROM round_window w
         JOIN tournament t ON t.id = w.tournament_id
        WHERE w.season_id = ?
        ORDER BY w.week, w.tournament_id, w.stream, w.round, w.leg`
    )
    .bind(seasonId)
    .all<WindowRow>();
  if (windows.length === 0) return [];

  const tournamentIds = [...new Set(windows.map((w) => w.tournament_id))];
  const { results: stages } = await db
    .prepare(
      `SELECT id, tournament_id, kind, config_json
         FROM stage
        WHERE tournament_id IN (SELECT value FROM json_each(?))
        ORDER BY sort_order, id`
    )
    .bind(JSON.stringify(tournamentIds))
    .all<StageRow>();
  const stagesByTournament = new Map<number, StageRow[]>();
  for (const stage of stages) {
    const list = stagesByTournament.get(stage.tournament_id);
    if (list) list.push(stage);
    else stagesByTournament.set(stage.tournament_id, [stage]);
  }

  return windows.map((w) => {
    const comp = competitionOf(w.tournament_name);
    return {
      id: w.id,
      tournamentId: w.tournament_id,
      tournamentName: w.tournament_name,
      competition: comp,
      stream: w.stream,
      round: w.round,
      leg: w.leg,
      week: w.week,
      dayStart: w.day_start,
      dayEnd: w.day_end,
      slotOverride: w.slot_override,
      lockedAt: w.locked_at,
      stageIds: stageIdsForWindow(w, stagesByTournament.get(w.tournament_id) ?? [], comp),
    };
  });
}

/** 场次落在哪个段：stage + round + leg 三者都要对上；同轮有多个窗口时优先周次相同的。 */
function segmentIdForMatch(segments: SeasonSegment[], match: MatchRow): number | null {
  let fallback: number | null = null;
  for (const segment of segments) {
    if (!segment.stageIds.includes(match.stage_id)) continue;
    const round =
      segment.competition === "sub" && segment.stream === "playoff" && segment.round === 0
        ? 1
        : segment.round;
    if (round !== match.round) continue;
    const legOk = segment.leg == null ? match.leg == null : match.leg === segment.leg;
    if (!legOk) continue;
    if (match.kickoff_week != null && segment.week === match.kickoff_week) return segment.id;
    if (fallback == null) fallback = segment.id;
  }
  return fallback;
}

async function loadSeasonMatches(db: D1Database, segments: SeasonSegment[]): Promise<SeasonMatch[]> {
  const stageIds = [...new Set(segments.flatMap((s) => s.stageIds))];
  if (stageIds.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT m.id, m.stage_id, m.round, m.leg, m.slot, m.status,
              m.score_home, m.score_away,
              m.kickoff_week, m.kickoff_day, m.kickoff_time,
              m.kickoff_override, m.kickoff_reason,
              he.team_id AS home_team_id, ae.team_id AS away_team_id
         FROM match m
         LEFT JOIN entry he ON he.id = m.home_entry_id
         LEFT JOIN entry ae ON ae.id = m.away_entry_id
        WHERE m.stage_id IN (SELECT value FROM json_each(?))
        ORDER BY m.id`
    )
    .bind(JSON.stringify(stageIds))
    .all<MatchRow>();
  return results.map((m) => ({
    id: m.id,
    stageId: m.stage_id,
    round: m.round,
    leg: m.leg,
    slot: m.slot,
    status: m.status,
    scoreHome: m.score_home,
    scoreAway: m.score_away,
    homeTeamId: m.home_team_id,
    awayTeamId: m.away_team_id,
    kickoffWeek: m.kickoff_week,
    kickoffDay: m.kickoff_day,
    kickoffTime: m.kickoff_time,
    override: m.kickoff_override === 1,
    reason: m.kickoff_reason,
    segmentId: segmentIdForMatch(segments, m),
  }));
}

/** 赛季总览取数：赛季 + 段 + 场次 + 已排时刻 + 每段时刻池。 */
export async function loadSeasonData(db: D1Database, seasonId: number): Promise<SeasonData> {
  const season = await db
    .prepare(`SELECT id, name, weeks FROM season WHERE id = ?`)
    .bind(seasonId)
    .first<SeasonRow>();
  if (!season) {
    return { season: null, segments: [], matches: [], placements: [], unmatched: [], pools: [] };
  }
  const segments = await loadSeasonSegments(db, seasonId);
  const matches = await loadSeasonMatches(db, segments);
  const placements: SeasonPlacement[] = [];
  for (const m of matches) {
    if (m.kickoffWeek == null || m.kickoffDay == null || m.kickoffTime == null) continue;
    placements.push({
      matchId: m.id,
      segmentId: m.segmentId,
      week: m.kickoffWeek,
      day: m.kickoffDay,
      time: m.kickoffTime,
      override: m.override,
      reason: m.reason,
      homeTeamId: m.homeTeamId,
      awayTeamId: m.awayTeamId,
    });
  }
  const unmatched = matches.filter(
    (m) =>
      m.segmentId == null &&
      m.kickoffWeek != null &&
      m.kickoffDay != null &&
      m.kickoffTime != null
  );
  const pools = await loadSeasonPools(db, seasonId, segments);
  return { season, segments, matches, placements, unmatched, pools };
}

/** 解析 round_window.slot_override；口径与 routes/admin/kickoff.ts 的 parseOverride 一致。 */
function parseSlotOverride(raw: string | null, dayEnd: number): { day: number; slots: Slot[] } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    // 兼容 0031 刚落地时的旧形态（纯数组，视为窗口最后一天）
    if (Array.isArray(v)) return { day: dayEnd, slots: cleanSlots(v) };
    const o = v as { day?: number; slots?: unknown };
    if (o && Number.isInteger(o.day) && Array.isArray(o.slots))
      return { day: o.day!, slots: cleanSlots(o.slots) };
  } catch {
    /* 坏 JSON 当没有覆盖 */
  }
  return null;
}

function slotCountOf(pool: SegmentPool): number {
  return Object.values(pool.pool).reduce((n, slots) => n + slots.length, 0);
}

/** 池子里的脏时刻（"99:99"、空串）不能让求解器在 parseTime 上抛 500；直接当无效档位丢掉。 */
function cleanSlots(raw: unknown): Slot[] {
  if (!Array.isArray(raw)) return [];
  const out: Slot[] = [];
  for (const v of raw) {
    const s = v as Partial<Slot>;
    if (typeof s?.time !== "string") continue;
    try {
      parseTime(s.time);
      out.push({ time: s.time, cap: typeof s.cap === "number" && s.cap > 0 ? s.cap : 1 });
    } catch {
      /* 脏时刻丢弃 */
    }
  }
  return out;
}

/**
 * 每段的时刻池：slot_override 优先，否则 time_pool（phase 由周次推出）。
 * 口径与 routes/admin/kickoff.ts 的 poolFor 一致（S3 收口时合并）；
 * 这里只给「原始池 + 是否末轮」，末轮要不要折叠由 season_rule 决定（见 effectivePoolOf）。
 * 周次超出 1–31 等异常数据按「没有池子」处理：求解会把段记进 blockedSegmentIds。
 */
async function loadSeasonPools(
  db: D1Database,
  seasonId: number,
  segments: SeasonSegment[]
): Promise<SegmentPool[]> {
  if (segments.length === 0) return [];
  const { results: maxRows } = await db
    .prepare(
      `SELECT tournament_id, stream, MAX(round) AS m
         FROM round_window WHERE season_id = ? GROUP BY tournament_id, stream`
    )
    .bind(seasonId)
    .all<{ tournament_id: number; stream: string; m: number | null }>();
  const maxRoundKey = new Map(maxRows.map((r) => [`${r.tournament_id}|${r.stream}`, r.m]));

  const poolCache = new Map<string, Record<number, Slot[]>>();
  const loadPhasePool = async (phase: string, competition: string): Promise<Record<number, Slot[]>> => {
    const cached = poolCache.get(`${phase}|${competition}`);
    if (cached) return cached;
    const { results } = await db
      .prepare(`SELECT day, slots FROM time_pool WHERE season_id = ? AND phase = ? AND competition = ?`)
      .bind(seasonId, phase, competition)
      .all<{ day: number; slots: string }>();
    const pool: Record<number, Slot[]> = {};
    for (const row of results) {
      try {
        pool[row.day] = cleanSlots(JSON.parse(row.slots));
      } catch {
        pool[row.day] = [];
      }
    }
    poolCache.set(`${phase}|${competition}`, pool);
    return pool;
  };

  const out: SegmentPool[] = [];
  for (const seg of segments) {
    const override = parseSlotOverride(seg.slotOverride, seg.dayEnd);
    let pool: Record<number, Slot[]>;
    let dayStart = seg.dayStart;
    let dayEnd = seg.dayEnd;
    let overridden = false;
    if (override && override.slots.length > 0) {
      pool = { [override.day]: override.slots };
      dayStart = override.day;
      dayEnd = override.day;
      overridden = true;
    } else {
      pool = {};
      let phase: string | null = null;
      try {
        phase = phaseForWeek(seg.week);
      } catch {
        // 周次超界：没有池子，调用方按「无档位」处理
      }
      if (phase != null) {
        // D1/解析错误不能吞：否则总览会把「读不到池子」伪装成「没配池子」。
        pool = await loadPhasePool(phase, seg.competition);
      }
    }
    const maxRound = maxRoundKey.get(`${seg.tournamentId}|${seg.stream}`) ?? null;
    out.push({
      segmentId: seg.id,
      pool,
      dayStart,
      dayEnd,
      overridden,
      lastRound: maxRound != null && seg.round === maxRound,
    });
  }
  return out;
}

// ---------- 规则 ----------

function ruleFromRow(row: SeasonRuleRow): SeasonRule {
  return {
    competition: row.competition as "all" | Competition,
    minGapHours: row.min_gap_hours,
    softGapHours: row.soft_gap_hours,
    reportGapHours: row.report_gap_hours,
    consecutiveHomeExempt: row.consecutive_home_exempt === 1,
    lastRoundSimultaneous: row.last_round_simultaneous === 1,
  };
}

/** 赛季规则：永远带一条 'all'（DB 没有就用内置默认值），competition 行覆盖它。 */
export async function loadSeasonRules(db: D1Database, seasonId: number): Promise<SeasonRule[]> {
  const { results } = await db
    .prepare(
      `SELECT competition, min_gap_hours, soft_gap_hours, report_gap_hours,
              consecutive_home_exempt, last_round_simultaneous
         FROM season_rule
        WHERE season_id = ?
        ORDER BY competition`
    )
    .bind(seasonId)
    .all<SeasonRuleRow>();
  const byCompetition = new Map<string, SeasonRule>();
  byCompetition.set("all", { competition: "all", ...DEFAULT_SEASON_RULE });
  for (const row of results) byCompetition.set(row.competition, ruleFromRow(row));
  return [...byCompetition.values()].sort((a, b) =>
    a.competition === "all" ? -1 : b.competition === "all" ? 1 : a.competition.localeCompare(b.competition)
  );
}

export function resolveSeasonRule(rules: SeasonRule[], competition: Competition | null): SeasonRule {
  if (competition) {
    const exact = rules.find((r) => r.competition === competition);
    if (exact) return exact;
  }
  return rules.find((r) => r.competition === "all") ?? { competition: "all", ...DEFAULT_SEASON_RULE };
}

// ---------- 体检 ----------

/** 20:00 及以后算晚场。设计只要求「晚场占比」，没有给阈值，这里按 20:00 钉死。 */
const LATE_KICKOFF_MINUTES = 20 * 60;
/**
 * 「连续负荷」= 每队在任意连续 168h（一周）窗口内的最多场次，取全季各队最大值。
 * 设计同样没给数值定义，按「周内连场密度」钉死：它对换天/换时刻最敏感，也最直观。
 */
const CONSECUTIVE_LOAD_WINDOW_HOURS = 168;

export type SeasonMetrics = {
  /** 硬冲突数（拒绝提交） */
  hard: number;
  /** 软冲突数（64h 非两连主等） */
  soft: number;
  /** 72h 备用约束的命中数（只报告） */
  report: number;
  /** 全季同队相邻两场的最小间隔（小时）；一对都没有时为 null */
  minGapHours: number | null;
  /** 晚场占比（0–1） */
  lateRatio: number;
  /** 每队在任意连续 168h 窗口内的最大场次，取全队最大值 */
  maxConsecutiveLoad: number;
};

export type SeasonAudit = { violations: SeasonViolation[]; metrics: SeasonMetrics };

/**
 * 整季体检 + 指标（S2 完整版）。一次扫描覆盖：
 *   1. 映射不到段的已排场次（hard）；
 *   2. 同队间隔：全季 placements 混在一个时间轴上，跨赛事、跨段、前后相邻场全覆盖
 *      —— gap < minGap（48h）hard；gap < softGap（64h）且非两连主 soft；gap < reportGap（72h）report；
 *   3. 档位池：天数越界 / 时刻不在池子 / 同段同档超容量（越窗 override 的场豁免）；
 *   4. 末轮同开：该赛事 stream 的最后一轮所有场次压到同一天同一时刻（规则可关）。
 * 池检查只对「配了池子的段」生效（库里没配 time_pool 时无从校验，跳过不报假冲突）。
 */
export function auditSeason(
  data: Pick<SeasonData, "placements" | "segments"> & {
    pools?: SegmentPool[];
    season?: SeasonRow | null;
  },
  rules: SeasonRule[] = []
): SeasonAudit {
  const pools = data.pools ?? [];
  const poolsById = new Map(pools.map((p) => [p.segmentId, p]));
  const ruleCache = new Map<number, SeasonRule>();
  const ruleFor = (segmentId: number | null): SeasonRule => {
    if (segmentId == null) return resolveSeasonRule(rules, null);
    const cached = ruleCache.get(segmentId);
    if (cached) return cached;
    const seg = data.segments.find((s) => s.id === segmentId);
    const rule = resolveSeasonRule(rules, seg?.competition ?? null);
    ruleCache.set(segmentId, rule);
    return rule;
  };

  const placements = data.placements;
  const segmentsById = new Map(data.segments.map((s) => [s.id, s]));
  const out: SeasonViolation[] = [];

  for (const p of placements) {
    if (p.segmentId == null) {
      out.push({ matchId: p.matchId, level: "hard", reason: "该场不在任何排期窗口" });
    }
  }

  // 脏数据兜底：坏 week/time 只报 hard，不让 validateSeason 抛异常把整页/整条写路径打成 500。
  const maxWeek = data.season?.weeks ?? 31;
  const checkable: SeasonPlacement[] = [];
  for (const p of placements) {
    let ok = true;
    if (!Number.isInteger(p.week) || p.week < 1 || p.week > maxWeek) {
      out.push({
        matchId: p.matchId,
        level: "hard",
        segmentId: p.segmentId,
        reason: `第 ${p.week} 周超出赛季范围 1–${maxWeek}`,
      });
      ok = false;
    }
    // day 是独立维度，不能因为段没配池子/是越窗 override 就跳过；
    // 0/8/9 这类脏 day 必须报 hard，否则会被审计和 restore 原样吞掉。
    if (!Number.isInteger(p.day) || p.day < 1 || p.day > 7) {
      out.push({
        matchId: p.matchId,
        level: "hard",
        segmentId: p.segmentId,
        reason: `第 ${p.day} 天不是合法比赛日 1–7`,
      });
      ok = false;
    }
    try {
      parseTime(p.time);
    } catch {
      out.push({
        matchId: p.matchId,
        level: "hard",
        segmentId: p.segmentId,
        reason: `时刻 ${p.time} 不是合法 HH:MM`,
      });
      ok = false;
    }
    if (ok) checkable.push(p);
  }

  // 同队间隔：跨赛事、跨段、前后相邻场次的同队间隔
  type Entry = { at: number; p: SeasonPlacement };
  const byTeam = new Map<number, Entry[]>();
  for (const p of checkable) {
    const at = absHours(p.week, p.day, p.time);
    for (const team of [p.homeTeamId, p.awayTeamId]) {
      if (team == null) continue;
      const list = byTeam.get(team);
      const entry = { at, p };
      if (list) list.push(entry);
      else byTeam.set(team, [entry]);
    }
  }

  let pairs = 0;
  let minGap = Number.POSITIVE_INFINITY;
  let maxLoad = 0;
  for (const [team, list] of byTeam) {
    list.sort((a, b) => a.at - b.at || a.p.matchId - b.p.matchId);
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1];
      const cur = list[i];
      const gap = cur.at - prev.at;
      pairs += 1;
      if (gap < minGap) minGap = gap;
      const rule = ruleFor(cur.p.segmentId);
      // 两连主：上一场和本场都是该队主场，才允许压到 minGapHours
      const exempt =
        rule.consecutiveHomeExempt && prev.p.homeTeamId === team && cur.p.homeTeamId === team;
      if (gap < rule.minGapHours) {
        out.push({
          matchId: cur.p.matchId,
          relatedMatchId: prev.p.matchId,
          level: "hard",
          teamId: team,
          segmentId: cur.p.segmentId,
          reason: `队伍 ${team} 间隔 ${gap.toFixed(1)}h < ${rule.minGapHours}h`,
        });
      } else if (gap < rule.softGapHours && !exempt) {
        out.push({
          matchId: cur.p.matchId,
          relatedMatchId: prev.p.matchId,
          level: "soft",
          teamId: team,
          segmentId: cur.p.segmentId,
          reason: `队伍 ${team} 间隔 ${gap.toFixed(1)}h < ${rule.softGapHours}h（非两连主）`,
        });
      } else if (gap < rule.reportGapHours) {
        out.push({
          matchId: cur.p.matchId,
          relatedMatchId: prev.p.matchId,
          level: "report",
          teamId: team,
          segmentId: cur.p.segmentId,
          reason: `队伍 ${team} 间隔 ${gap.toFixed(1)}h < ${rule.reportGapHours}h（备用报告）`,
        });
      }
    }
    // 连续负荷：以每场开球为锚，数 [锚点, 锚点+168h) 窗口内的场次
    let k = 0;
    for (let i = 0; i < list.length; i += 1) {
      while (list[i].at - list[k].at >= CONSECUTIVE_LOAD_WINDOW_HOURS) k += 1;
      maxLoad = Math.max(maxLoad, i - k + 1);
    }
  }

  // 档位池：天数 / 时刻 / 容量。越窗 override 的场是人工决定，不做池校验。
  type CapSlot = { segmentId: number; day: number; time: string };
  const capUsed = new Map<string, number>();
  const capMeta = new Map<string, CapSlot>();
  for (const p of checkable) {
    if (p.override || p.segmentId == null) continue;
    const seg = segmentsById.get(p.segmentId);
    if (seg && p.week !== seg.week) {
      out.push({
        matchId: p.matchId,
        level: "hard",
        segmentId: p.segmentId,
        reason: `第 ${p.week} 周与排期段第 ${seg.week} 周不一致`,
      });
    }
    const pool = poolsById.get(p.segmentId);
    if (!pool) continue;
    if (p.day < pool.dayStart || p.day > pool.dayEnd) {
      out.push({
        matchId: p.matchId,
        level: "hard",
        segmentId: p.segmentId,
        reason: `第 ${p.day} 天不在排期段 ${pool.dayStart}–${pool.dayEnd}`,
      });
    }
    // 空池也要先校验天/周，否则 day=0/9 的脏数据会被 continue 放过去。
    if (slotCountOf(pool) === 0) continue;
    const slots = pool.pool[p.day] ?? [];
    if (!slots.some((s) => s.time === p.time)) {
      out.push({
        matchId: p.matchId,
        level: "hard",
        segmentId: p.segmentId,
        reason: `时刻 ${p.time} 不在第 ${p.day} 天的池子`,
      });
    }
    const key = `${p.segmentId}|${p.day}|${p.time}`;
    capUsed.set(key, (capUsed.get(key) ?? 0) + 1);
    capMeta.set(key, { segmentId: p.segmentId, day: p.day, time: p.time });
  }
  for (const [key, n] of capUsed) {
    const meta = capMeta.get(key)!;
    const pool = poolsById.get(meta.segmentId);
    const slot = pool?.pool[meta.day]?.find((s) => s.time === meta.time);
    // 时刻不在池子里的已经在上面逐场报过，这里不再叠一条「容量」
    if (!slot || n <= slot.cap) continue;
    // 末轮同开的段：引擎折叠到同档时容量放开到整轮场次（cap=max(playable,1)），审计对齐口径；
    // 是否真的同开由下面的末轮检查单独把关，这里不再重复报容量。
    if (pool?.lastRound && ruleFor(meta.segmentId).lastRoundSimultaneous) continue;
    out.push({
      matchId: 0,
      level: "hard",
      segmentId: meta.segmentId,
      reason: `第 ${meta.day} 天 ${meta.time} 档超出容量 ${n}/${slot.cap}`,
    });
  }

  // 末轮同开：基准槽 = 人多的那档；打平取更早的（确定性）
  for (const pool of pools) {
    if (!pool.lastRound) continue;
    const rule = ruleFor(pool.segmentId);
    if (!rule.lastRoundSimultaneous) continue;
    const inSeg = checkable.filter((p) => p.segmentId === pool.segmentId && !p.override);
    if (inSeg.length < 2) continue;
    const counts = new Map<string, { day: number; time: string; n: number; at: number }>();
    for (const p of inSeg) {
      const at = absHours(p.week, p.day, p.time);
      const key = `${p.day}|${p.time}`;
      const hit = counts.get(key);
      if (hit) hit.n += 1;
      else counts.set(key, { day: p.day, time: p.time, n: 1, at });
    }
    const ref = [...counts.values()].sort((a, b) => b.n - a.n || a.at - b.at)[0];
    for (const p of inSeg) {
      if (p.day === ref.day && p.time === ref.time) continue;
      out.push({
        matchId: p.matchId,
        level: "hard",
        segmentId: pool.segmentId,
        reason: `末轮应同开：该场在第 ${p.day} 天 ${p.time}，基准是第 ${ref.day} 天 ${ref.time}`,
      });
    }
  }

  const late = checkable.reduce(
    (n, p) => n + (parseTime(p.time) >= LATE_KICKOFF_MINUTES ? 1 : 0),
    0
  );
  const metrics: SeasonMetrics = {
    hard: out.filter((v) => v.level === "hard").length,
    soft: out.filter((v) => v.level === "soft").length,
    report: out.filter((v) => v.level === "report").length,
    minGapHours: pairs === 0 ? null : minGap,
    lateRatio: placements.length === 0 ? 0 : late / placements.length,
    maxConsecutiveLoad: maxLoad,
  };
  return { violations: out, metrics };
}

/** 整季体检（只出违规清单；要指标用 auditSeason）。preview/commit/PATCH/publish/restore 统一走它。 */
export function validateSeason(
  data: Pick<SeasonData, "placements" | "segments"> & {
    pools?: SegmentPool[];
    season?: SeasonRow | null;
  },
  rules: SeasonRule[] = []
): SeasonViolation[] {
  return auditSeason(data, rules).violations;
}

/**
 * commit 门槛（设计 §4.4）：有硬冲突直接拒绝，没有绕过开关。
 * S2 是 lib 层，S3 的 commit 路由接这个函数。
 */
export function seasonCommitGate(violations: SeasonViolation[]): {
  canCommit: boolean;
  hard: SeasonViolation[];
} {
  const hard = violations.filter((v) => v.level === "hard");
  return { canCommit: hard.length === 0, hard };
}

// ---------- 引擎 ----------

/** 默认固定 seed：可复现验收的锚点。三套候选分别用 seed / seed+7919 / seed+2×7919。 */
export const SEASON_SCHEDULER_SEED = 42;
/** 默认固定步数（设计先钉 2000；后续嫌慢/嫌糙在路由层调 steps）。 */
export const SEASON_SCHEDULER_STEPS = 2000;
/** 三套候选的 seed 间隔（素数，避免短随机周期互撞） */
const CANDIDATE_SEED_STRIDE = 7919;
const CANDIDATE_KEYS = ["A", "B", "C"] as const;

export type ScheduleSeasonOptions = {
  /** 只重排这些段（部分求解）；不传 = 整季 */
  segmentIds?: number[];
  /** 固定 seed，默认 42 */
  seed?: number;
  /** 固定步数，默认 2000 */
  steps?: number;
};

/** 一场的求解位置：段内 week 由 segmentId 决定，状态里只存段/天/时刻 */
type SlotPos = { segmentId: number; day: number; time: string };

/**
 * 段内移动：换天 + 换时刻。本期只产生 reslot（不跨段）；
 * resegment（把场挪到另一个段）是预留接口——applySeasonMove 两分支都已实现，
 * 接跨段搜索 / CP-SAT 时在 proposeSeasonMove 里放开即可。
 */
type SeasonMove =
  | { kind: "reslot"; matchId: number; segmentId: number; day: number; time: string }
  | { kind: "resegment"; matchId: number; segmentId: number; day: number; time: string };

export type SeasonCandidate = {
  key: (typeof CANDIDATE_KEYS)[number];
  seed: number;
  steps: number;
  /** 可动场的新时刻（override 一律 false；不动场不在这里，见 result.fixed） */
  assignments: SeasonPlacement[];
  metrics: SeasonMetrics;
  violations: SeasonViolation[];
  /** 该候选最终状态下仍未排上的可动场（不是搜索前的快照） */
  unplacedMatchIds: number[];
  /** 该候选最终状态下不动的现有时刻（已开赛 / 已公布段 / 越窗改期 / 范围外） */
  fixed: SeasonPlacement[];
  /** 提案指纹：不动场 + 本提案的全量 placements 的 SHA-256（与 revision hash 同口径） */
  hash: string;
};

export type ScheduleSeasonResult = {
  seasonId: number;
  /** 本次重排的段 */
  segmentIds: number[];
  /** 全季段数（含未选进 scope 的） */
  totalSegments: number;
  /** 没有可用档位、无法重排的段（time_pool 缺配置 / 周次超界等） */
  blockedSegmentIds: number[];
  /** 范围内对手未定的场次 */
  unplayableMatchIds: number[];
  /** 可动但初始化没排上的场次（档位满了等；它们的旧时刻保留在 fixed） */
  unplacedMatchIds: number[];
  /** 不动场的现有时刻：已开赛 / 已公布段 / 越窗改期 / 范围外的场，作为上下文参与体检与指标 */
  fixed: SeasonPlacement[];
  /** 预览时线上全季排期的 hash；commit 用它做值级 CAS，防止「预览后别人改了场次」 */
  baseHash: string;
  candidates: SeasonCandidate[];
};

/** 段的有效池：末轮按规则折叠成单档（容量放开到全场数），与窗口级 collapseToCommonSlot 同口径。 */
type EffectivePool = SegmentPool & { simultaneous: boolean };

function effectivePoolOf(raw: SegmentPool, rule: SeasonRule, playable: number): EffectivePool {
  if (raw.overridden) return { ...raw, simultaneous: true };
  if (!raw.lastRound || !rule.lastRoundSimultaneous) return { ...raw, simultaneous: false };
  for (let day = raw.dayEnd; day >= raw.dayStart; day -= 1) {
    const slots = raw.pool[day];
    if (!slots || slots.length === 0) continue;
    const latest = slots.reduce((a, b) => (parseTime(b.time) > parseTime(a.time) ? b : a));
    return {
      segmentId: raw.segmentId,
      pool: { [day]: [{ time: latest.time, cap: Math.max(playable, 1) }] },
      dayStart: day,
      dayEnd: day,
      overridden: true,
      lastRound: raw.lastRound,
      simultaneous: true,
    };
  }
  return { ...raw, simultaneous: false };
}

/** 随机提议一个移动；本期只有段内 reslot。原地踏步返回 null（不算一步）。 */
function proposeSeasonMove(
  target: { matchId: number; segmentId: number },
  options: Array<{ day: number; time: string }>,
  current: Map<number, SlotPos>,
  rng: () => number
): SeasonMove | null {
  const opt = options[Math.floor(rng() * options.length)];
  if (!opt) return null;
  const cur = current.get(target.matchId);
  if (cur && cur.segmentId === target.segmentId && cur.day === opt.day && cur.time === opt.time)
    return null;
  return { kind: "reslot", matchId: target.matchId, segmentId: target.segmentId, day: opt.day, time: opt.time };
}

/** 应用移动到状态。resegment（跨段）分支同样可用，等接入跨段搜索。 */
function applySeasonMove(state: Map<number, SlotPos>, move: SeasonMove): void {
  state.set(move.matchId, { segmentId: move.segmentId, day: move.day, time: move.time });
}

/**
 * 赛季级求解（S2，设计 §4.2）：一次解整季（或指定段），出 3 套可复现的候选方案。
 *
 * 流程：
 *   1. 初始化：段按周次升序，逐段跑现有 scheduleWindow()（贪心、越疲劳越先排），
 *      每队「上一场」历史跨段累积，与窗口级排期口径一致；
 *   2. 局部搜索：只做段内「换天 + 换时刻」（SeasonMove），固定 seed + 固定步数，
 *      cost = hard×10000 + soft×100 + report（hard 是底线，绝不拿硬冲突换软指标）；
 *   3. 三套候选用三个 seed 各跑一遍，指标对比交给上层（局部最优风险走「多方案对比」缓解）。
 *
 * 不动场（已开赛 / 已公布段 / 越窗改期 / 范围外）保持现状，作为上下文参与体检。
 * 只读不写库：scheduleSeason 不落任何数据，落库由 S3 的 preview/commit 走。
 */
export async function scheduleSeason(
  db: D1Database,
  seasonId: number,
  opts: ScheduleSeasonOptions = {}
): Promise<ScheduleSeasonResult> {
  const data = await loadSeasonData(db, seasonId);
  if (!data.season) throw new SeasonRevisionError("season_not_found", "赛季不存在");
  if (data.segments.length === 0)
    throw new SeasonRevisionError("empty_schedule", "赛季没有排期段，无料可排");
  if (opts.segmentIds != null) {
    const known = new Set(data.segments.map((s) => s.id));
    for (const id of opts.segmentIds) {
      if (!known.has(id))
        throw new SeasonRevisionError("segment_not_found", `排期段 ${id} 不在赛季 ${seasonId}`);
    }
  }

  const rules = await loadSeasonRules(db, seasonId);
  const scopeIds =
    opts.segmentIds != null ? new Set(opts.segmentIds) : new Set(data.segments.map((s) => s.id));
  const ordered = [...data.segments.filter((s) => scopeIds.has(s.id))].sort(
    (a, b) => a.week - b.week || a.dayStart - b.dayStart || a.id - b.id
  );

  const poolsById = new Map(data.pools.map((p) => [p.segmentId, p]));
  const matchesBySegment = new Map<number, SeasonMatch[]>();
  for (const m of data.matches) {
    if (m.segmentId == null) continue;
    const list = matchesBySegment.get(m.segmentId);
    if (list) list.push(m);
    else matchesBySegment.set(m.segmentId, [m]);
  }

  // 可动段 / 可动场判定
  const effById = new Map<number, EffectivePool>();
  const blockedSegmentIds: number[] = [];
  const unplayableMatchIds: number[] = [];
  const movable = new Map<number, SeasonMatch>();
  for (const seg of ordered) {
    const segMatches = matchesBySegment.get(seg.id) ?? [];
    for (const m of segMatches) {
      if (m.homeTeamId == null || m.awayTeamId == null) unplayableMatchIds.push(m.id);
    }
    const raw = poolsById.get(seg.id);
    if (!raw) continue; // 理论上每段一条（loadSeasonPools 保证）；防御
    const playable = segMatches.filter((m) => m.homeTeamId != null && m.awayTeamId != null).length;
    const eff = effectivePoolOf(raw, resolveSeasonRule(rules, seg.competition), playable);
    effById.set(seg.id, eff);
    if (seg.lockedAt != null) continue; // 已公布：不动
    if (slotCountOf(eff) === 0) {
      blockedSegmentIds.push(seg.id); // 没配池子：没法排，明说而不是静默
      continue;
    }
    for (const m of segMatches) {
      if (m.homeTeamId == null || m.awayTeamId == null) continue;
      if (m.status !== "pending") continue; // 已开赛/已完赛：保持现状
      if (m.override && m.kickoffTime != null) continue; // 越窗改期：保留人工决定
      movable.set(m.id, m);
    }
  }

  // 1) 初始化：scheduleWindow 逐段跑，历史（上一场时刻）跨段累积
  const state = new Map<number, SlotPos>();
  {
    const events: Array<{ at: number; teamId: number; wasHome: boolean }> = [];
    for (const p of data.placements) {
      if (movable.has(p.matchId)) continue; // 可动场的旧时刻不进历史（求解会给它新位置）
      // 历史脏数据（坏 week/time）由 auditSeason 报 hard；这里不能因为 absHours 抛错把预览打成 500。
      let at: number;
      try {
        at = absHours(p.week, p.day, p.time);
      } catch {
        continue;
      }
      if (p.homeTeamId != null) events.push({ at, teamId: p.homeTeamId, wasHome: true });
      if (p.awayTeamId != null) events.push({ at, teamId: p.awayTeamId, wasHome: false });
    }
    for (const seg of ordered) {
      const eff = effById.get(seg.id);
      if (!eff || seg.lockedAt != null || slotCountOf(eff) === 0) continue;
      const schedMatches = (matchesBySegment.get(seg.id) ?? [])
        .filter((m) => movable.has(m.id))
        .map((m) => ({ id: m.id, slot: m.slot, homeTeamId: m.homeTeamId!, awayTeamId: m.awayTeamId! }));
      if (schedMatches.length === 0) continue;
      // 与窗口级 loadHistory 同口径：只看窗口开始之前的场
      const windowStart = absHours(seg.week, eff.dayStart, "00:00");
      const history: History = new Map();
      for (const ev of events) {
        if (ev.at >= windowStart) continue;
        const prev = history.get(ev.teamId);
        if (!prev || prev.lastStartHours < ev.at)
          history.set(ev.teamId, { lastStartHours: ev.at, lastWasHome: ev.wasHome });
      }
      const { assignments } = scheduleWindow({
        week: seg.week,
        dayStart: eff.dayStart,
        dayEnd: eff.dayEnd,
        pool: eff.pool,
        matches: schedMatches,
        history,
      });
      for (const a of assignments) {
        state.set(a.matchId, { segmentId: seg.id, day: a.day, time: a.time });
        const m = movable.get(a.matchId)!;
        const at = absHours(seg.week, a.day, a.time);
        if (m.homeTeamId != null) events.push({ at, teamId: m.homeTeamId, wasHome: true });
        if (m.awayTeamId != null) events.push({ at, teamId: m.awayTeamId, wasHome: false });
      }
    }
  }

  const assignedIds = new Set(state.keys());
  // 不动场 = 提案没覆盖的现有时刻（unplaced 场保留旧时刻，不凭空消失）
  const fixed = data.placements.filter((p) => !assignedIds.has(p.matchId));

  // 2) 局部搜索：段内换天/换时刻；单档段（末轮折叠/slot_override）没有移动空间，不参与
  const segmentsById = new Map(data.segments.map((s) => [s.id, s]));
  const optionsBySegment = new Map<number, Array<{ day: number; time: string }>>();
  for (const [id, eff] of effById) {
    const list: Array<{ day: number; time: string }> = [];
    for (const day of Object.keys(eff.pool).map(Number).sort((a, b) => a - b)) {
      for (const s of [...eff.pool[day]].sort((a, b) => parseTime(a.time) - parseTime(b.time)))
        list.push({ day, time: s.time });
    }
    optionsBySegment.set(id, list);
  }
  const searchSpace = ordered
    .filter((seg) => (optionsBySegment.get(seg.id) ?? []).length > 1 && seg.lockedAt == null)
    .flatMap((seg) =>
      (matchesBySegment.get(seg.id) ?? [])
        .filter((m) => movable.has(m.id))
        .map((m) => ({ matchId: m.id, segmentId: seg.id }))
    );
  const placementsOf = (positions: Map<number, SlotPos>): SeasonPlacement[] =>
    [...positions]
      .sort((a, b) => a[0] - b[0])
      .map(([matchId, pos]) => {
        const seg = segmentsById.get(pos.segmentId)!;
        const m = movable.get(matchId)!;
        return {
          matchId,
          segmentId: pos.segmentId,
          week: seg.week,
          day: pos.day,
          time: pos.time,
          override: false,
          reason: null,
          homeTeamId: m.homeTeamId,
          awayTeamId: m.awayTeamId,
        };
      });
  const auditOf = (positions: Map<number, SlotPos>): SeasonAudit => {
    // fixed 里可能还留着「可动但初始化没排上」的旧时刻；搜索把它排上位后要摘掉，避免一场算两次
    const fixedForState = fixed.filter((p) => !positions.has(p.matchId));
    return auditSeason(
      {
        placements: [...fixedForState, ...placementsOf(positions)],
        segments: data.segments,
        pools: data.pools,
        season: data.season,
      },
      rules
    );
  };
  type Cost = { hard: number; soft: number; report: number };
  const costOf = (a: SeasonAudit): Cost => ({
    hard: a.metrics.hard,
    soft: a.metrics.soft,
    report: a.metrics.report,
  });
  // 字典序：hard 永远压过任意多 soft/report；软冲突之后再比 report。
  const costLess = (a: Cost, b: Cost): boolean =>
    a.hard !== b.hard
      ? a.hard < b.hard
      : a.soft !== b.soft
        ? a.soft < b.soft
        : a.report < b.report;
  const costLe = (a: Cost, b: Cost): boolean => !costLess(b, a);

  // 3) 三套候选：同一个初始化，三个 seed 各自搜
  const baseSeed = opts.seed ?? SEASON_SCHEDULER_SEED;
  const steps = opts.steps ?? SEASON_SCHEDULER_STEPS;
  const candidates: SeasonCandidate[] = [];
  for (let k = 0; k < CANDIDATE_KEYS.length; k += 1) {
    const seed = baseSeed + k * CANDIDATE_SEED_STRIDE;
    const rng = mulberry32(seed);
    let cur = new Map(state);
    let audit = auditOf(cur);
    let cost = costOf(audit);
    let best = new Map(cur);
    let bestAudit = audit;
    let bestCost = cost;
    for (let step = 0; step < steps && searchSpace.length > 0; step += 1) {
      const target = searchSpace[Math.floor(rng() * searchSpace.length)];
      const move = proposeSeasonMove(target, optionsBySegment.get(target.segmentId)!, cur, rng);
      if (!move) continue;
      const prev = cur.get(move.matchId);
      applySeasonMove(cur, move);
      const nextAudit = auditOf(cur);
      const nextCost = costOf(nextAudit);
      if (costLe(nextCost, cost)) {
        // 接受：等代价也走（平台游走，帮搜索挪出平顶）；best 只记更优
        cost = nextCost;
        audit = nextAudit;
        if (costLess(nextCost, bestCost)) {
          best = new Map(cur);
          bestAudit = nextAudit;
          bestCost = nextCost;
        }
      } else {
        if (prev == null) cur.delete(move.matchId);
        else cur.set(move.matchId, prev);
      }
    }
    const assignments = placementsOf(best);
    const fixedForBest = fixed.filter((p) => !best.has(p.matchId));
    const bestAssignedIds = new Set(best.keys());
    candidates.push({
      key: CANDIDATE_KEYS[k],
      seed,
      steps,
      assignments,
      metrics: bestAudit.metrics,
      violations: bestAudit.violations,
      unplacedMatchIds: [...movable.keys()].filter((id) => !bestAssignedIds.has(id)),
      fixed: fixedForBest,
      hash: await hashSeasonAssignments([...fixedForBest, ...assignments]),
    });
  }

  // 结果级 unplaced/fixed 也按「三套候选里是否至少有一套排上」重算，
  // 不再返回搜索前的旧快照。
  const assignedByAny = new Set(candidates.flatMap((c) => c.assignments.map((a) => a.matchId)));
  const resultUnplaced = [...movable.keys()].filter((id) => !assignedByAny.has(id));
  const resultFixed = data.placements.filter((p) => !assignedByAny.has(p.matchId));

  return {
    seasonId,
    segmentIds: ordered.map((s) => s.id),
    totalSegments: data.segments.length,
    blockedSegmentIds,
    unplayableMatchIds,
    unplacedMatchIds: resultUnplaced,
    fixed: resultFixed,
    baseHash: await hashSeasonAssignments(data.placements),
    candidates,
  };
}

// ---------- 版本 ----------

/**
 * 赛季版本 hash：必须覆盖所有会影响「锁定/回滚语义」的字段。
 * 旧窗口的 hashProposal 只含周/天/时刻；版本历史额外带 segment、override、reason，
 * 否则同一时刻换了段、或改期理由被清掉，hash 仍相等，publish 会误判「当前版本没变」。
 */
export async function hashSeasonAssignments(
  placements: Array<
    Pick<
      SeasonPlacement,
      "matchId" | "segmentId" | "week" | "day" | "time" | "override" | "reason" | "homeTeamId" | "awayTeamId"
    >
  >
): Promise<string> {
  const canonical = [...placements]
    .sort((a, b) => a.matchId - b.matchId)
    .map(
      (p) =>
        `${p.matchId}:${p.segmentId ?? ""}:${p.week}:${p.day}:${p.time}:${p.override ? "1" : "0"}:${p.reason ?? ""}:${p.homeTeamId ?? ""}:${p.awayTeamId ?? ""}`
    )
    .join("|");
  return sha256Hex(canonical);
}

/** 落版本前把旧 PATCH/手工 SQL 留下的脏 week/day/time 拦成业务错误，而不是让 DB CHECK 变 500。 */
function assertPlacementsWritable(placements: SeasonPlacement[]): void {
  for (const p of placements) {
    let timeOk = true;
    try {
      parseTime(p.time);
    } catch {
      timeOk = false;
    }
    if (p.week < 1 || p.day < 1 || p.day > 7 || !timeOk) {
      throw new SeasonRevisionError(
        "invalid_schedule",
        `场次 ${p.matchId} 的周/天/时刻不合法（第 ${p.week} 周 第 ${p.day} 天 ${p.time}），不能落版本；先修正旧排期`
      );
    }
  }
}

function parseMetrics(raw: string | null): RevisionMetrics | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RevisionMetrics;
  } catch {
    return null;
  }
}

function toSummary(row: RevisionRow): SeasonRevisionSummary {
  return {
    id: row.id,
    seasonId: row.season_id,
    revision: row.revision,
    hash: row.hash,
    status: row.status as RevisionStatus,
    lockedAt: row.locked_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    metrics: parseMetrics(row.metrics_json),
    note: row.note,
    assignmentCount: row.assignment_count,
  };
}

const REVISION_SELECT = `SELECT r.id, r.season_id, r.revision, r.hash, r.status, r.locked_at,
       r.created_by, r.created_at, r.metrics_json, r.note,
       (SELECT COUNT(*) FROM schedule_revision_assignment a WHERE a.revision_id = r.id) AS assignment_count
  FROM schedule_revision r`;

export async function getRevisionByNumber(
  db: D1Database,
  seasonId: number,
  revision: number
): Promise<SeasonRevisionSummary | null> {
  const row = await db
    .prepare(`${REVISION_SELECT} WHERE r.season_id = ? AND r.revision = ?`)
    .bind(seasonId, revision)
    .first<RevisionRow>();
  return row ? toSummary(row) : null;
}

/** 读当前最高版本号，作为「本次写库基于哪个快照」的乐观锁基线。 */
export async function getSeasonRevisionBase(db: D1Database, seasonId: number): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(MAX(revision), 0) AS m FROM schedule_revision WHERE season_id = ?`)
    .bind(seasonId)
    .first<{ m: number }>();
  return row?.m ?? 0;
}

export async function listSeasonRevisions(
  db: D1Database,
  seasonId: number
): Promise<SeasonRevisionSummary[]> {
  const { results } = await db
    .prepare(`${REVISION_SELECT} WHERE r.season_id = ? ORDER BY r.revision DESC`)
    .bind(seasonId)
    .all<RevisionRow>();
  return results.map(toSummary);
}

/**
 * 把当前线上排期一次性归档为 revision 1（幂等）。
 *
 * - 只读 match.kickoff_*，不碰 schedule_snapshot；
 * - 已有 revision 1 时原样返回，不覆盖（避免把后来的改动冲掉）；
 * - 没有已排场次时拒绝，避免造一个空基线；
 * - 整个写入（revision + 每场 assignment + audit）在一个 db.batch 里，
 *   并发重复调用由 UNIQUE(season_id, revision) 兜底，输的一方回读已有版本。
 */
export async function archiveSeasonRevision(
  db: D1Database,
  seasonId: number,
  actor: { createdBy: string | null; actorUserId?: number | null } = { createdBy: null }
): Promise<ArchiveSeasonRevisionResult> {
  const data = await loadSeasonData(db, seasonId);
  if (!data.season) throw new SeasonRevisionError("season_not_found", "赛季不存在");
  if (data.placements.length === 0)
    throw new SeasonRevisionError("empty_schedule", "当前赛季没有已排场次，无法归档");
  const hash = await hashSeasonAssignments(data.placements);

  const existing = await getRevisionByNumber(db, seasonId, 1);
  if (existing) {
    if (existing.hash !== hash) {
      throw new SeasonRevisionError(
        "baseline_mismatch",
        "r1 已存在且与当前排期不一致（可能已被旧窗口提交占用），不能重复归档；先确认基线版本"
      );
    }
    return {
      ...existing,
      alreadyArchived: true,
      unmatchedMatchIds: existing.metrics?.unmatchedMatchIds ?? [],
    };
  }

  const rules = await loadSeasonRules(db, seasonId);
  const violations = validateSeason(data, rules);
  const metrics: RevisionMetrics = {
    segments: data.segments.length,
    matches: data.matches.length,
    scheduled: data.placements.length,
    unmatchedMatchIds: data.unmatched.map((m) => m.id),
    hard: violations.filter((v) => v.level === "hard").length,
    soft: violations.filter((v) => v.level === "soft").length,
  };
  const createdAt = new Date().toISOString();
  const note = "S1 基线归档：旧窗口排期";
  assertPlacementsWritable(data.placements);
  // 整季可能有几百场，逐场一条 INSERT 会撞 D1 的 batch 语句数上限；
  // 这里把 assignments 作为一个 JSON 参数，用 json_each 在库内展开成行。
  const assignmentJson = JSON.stringify(
    data.placements.map((p) => ({
      segmentId: p.segmentId,
      matchId: p.matchId,
      week: p.week,
      day: p.day,
      time: p.time,
      override: p.override ? 1 : 0,
      reason: p.reason,
    }))
  );

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO schedule_revision
           (season_id, revision, hash, status, locked_at, created_by, created_at, metrics_json, note)
         VALUES (?, 1, ?, 'committed', NULL, ?, ?, ?, ?)`
      )
      .bind(seasonId, hash, actor.createdBy, createdAt, JSON.stringify(metrics), note),
    // revision 刚在同一 batch 里插入，用子查询取 id，避免依赖 last_insert_rowid 的跨语句行为。
    db
      .prepare(
        `INSERT INTO schedule_revision_assignment
           (revision_id, season_id, segment_id, match_id, match_key, week, day, time, override, reason)
         SELECT r.id, ?,
                json_extract(j.value, '$.segmentId'),
                json_extract(j.value, '$.matchId'),
                m.stage_id || ':' || m.round || ':' || COALESCE(m.slot, '') || ':' ||
                  COALESCE(m.leg, '') || ':' || COALESCE(m.home_entry_id, '') || ':' ||
                  COALESCE(m.away_entry_id, ''),
                json_extract(j.value, '$.week'),
                json_extract(j.value, '$.day'),
                json_extract(j.value, '$.time'),
                json_extract(j.value, '$.override'),
                json_extract(j.value, '$.reason')
           FROM schedule_revision r, json_each(?) j
           JOIN match m ON m.id = CAST(json_extract(j.value, '$.matchId') AS INTEGER)
          WHERE r.season_id = ? AND r.revision = 1`
      )
      .bind(seasonId, assignmentJson, seasonId),
    guardChangesStmt(db, data.placements.length),
    auditStmt(
      db,
      actor.actorUserId ?? null,
      "schedule_revision_archive",
      seasonId,
      {
        revision: 1,
        hash,
        count: data.placements.length,
        unmatched: metrics.unmatchedMatchIds,
      },
      "season"
    ),
  ];

  try {
    await db.batch(stmts);
  } catch (err) {
    // changes() 守卫：placements 读库后 match 被删/重建时，assignment 会少行。
    if (err instanceof Error && err.message.includes("malformed JSON")) {
      throw new SeasonRevisionError(
        "revision_incomplete",
        "归档时场次已被删除或重建，assignment 行数与预期不一致；请刷新后重试"
      );
    }
    // 并发归档：另一请求先写成功，回读它的结果。
    // 但只有 hash 一致才算「同一次归档」；hash 不一致时说明 r1 已被别的排期占用，
    // 不能把本次调用伪装成 alreadyArchived，否则调用方会以为基线就是当前排期。
    const again = await getRevisionByNumber(db, seasonId, 1);
    if (again) {
      if (again.hash !== hash) {
        throw new SeasonRevisionError(
          "baseline_mismatch",
          "r1 已存在且与当前排期不一致（可能已被旧窗口提交占用），不能重复归档；先确认基线版本"
        );
      }
      return {
        ...again,
        alreadyArchived: true,
        unmatchedMatchIds: again.metrics?.unmatchedMatchIds ?? [],
      };
    }
    throw err;
  }

  const created = await getRevisionByNumber(db, seasonId, 1);
  if (!created) throw new Error("归档写入后读不到 revision 1");
  return {
    ...created,
    alreadyArchived: false,
    unmatchedMatchIds: metrics.unmatchedMatchIds,
  };
}

/** commitSeasonRevision 的入参（S3）。 */
export type CommitSeasonRevisionInput = {
  createdBy: string | null;
  actorUserId?: number | null;
  /** 版本状态：引擎/窗口提交落版用 committed，回滚落版用 restored，窗口公布落版用 published */
  status: "committed" | "restored" | "published";
  /** published 版本需要带锁定时间，其他状态保持 NULL */
  lockedAt?: string | null;
  note: string | null;
  /** 落版后整季体检的结果（hard/soft 计数进 metrics；回滚路径即使有 hard 也照样落版） */
  violations: SeasonViolation[];
  totalMatches: number;
  unmatchedMatchIds: number[];
};

/**
 * 构造「落一个新版本」的全部语句（revision 行 + json_each 展开的 assignment 行 + 审计）。
 * 抽出来是为了让 restore / 旧窗口 commit / PATCH 把这些语句并进它们自己的 db.batch，
 * 业务写库与版本落账一个事务（High-2：避免「场次改了但版本流断了」）。
 */
export async function buildSeasonRevisionStmts(
  db: D1Database,
  seasonId: number,
  placements: SeasonPlacement[],
  input: CommitSeasonRevisionInput,
  revisionOverride?: number
): Promise<{ revision: number; stmts: D1PreparedStatement[] }> {
  const revision =
    revisionOverride ??
    (((
      await db
        .prepare(`SELECT MAX(revision) AS m FROM schedule_revision WHERE season_id = ?`)
        .bind(seasonId)
        .first<{ m: number | null }>()
    )?.m ?? 0) +
      1);

  // 旧 PATCH / 手工 SQL 可能留下 week=0、day=9、time=99:99；不要让它们撞
  // schedule_revision_assignment 的 CHECK 变成 500，先在业务层给出可读的 409。
  assertPlacementsWritable(placements);

  const hash = await hashSeasonAssignments(placements);
  const segmentIds = new Set<number>();
  for (const p of placements) if (p.segmentId != null) segmentIds.add(p.segmentId);
  const metrics: RevisionMetrics = {
    segments: segmentIds.size,
    matches: input.totalMatches,
    scheduled: placements.length,
    unmatchedMatchIds: input.unmatchedMatchIds,
    hard: input.violations.filter((v) => v.level === "hard").length,
    soft: input.violations.filter((v) => v.level === "soft").length,
  };
  const createdAt = new Date().toISOString();
  const assignmentJson = JSON.stringify(
    placements.map((p) => ({
      segmentId: p.segmentId,
      matchId: p.matchId,
      week: p.week,
      day: p.day,
      time: p.time,
      override: p.override ? 1 : 0,
      reason: p.reason,
    }))
  );

  return {
    revision,
    stmts: [
      db
        .prepare(
          `INSERT INTO schedule_revision
             (season_id, revision, hash, status, locked_at, created_by, created_at, metrics_json, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          seasonId,
          revision,
          hash,
          input.status,
          input.lockedAt ?? null,
          input.createdBy,
          createdAt,
          JSON.stringify(metrics),
          input.note
        ),
      db
        .prepare(
          `INSERT INTO schedule_revision_assignment
             (revision_id, season_id, segment_id, match_id, match_key, week, day, time, override, reason)
           SELECT r.id, ?,
                  json_extract(j.value, '$.segmentId'),
                  json_extract(j.value, '$.matchId'),
                  m.stage_id || ':' || m.round || ':' || COALESCE(m.slot, '') || ':' ||
                    COALESCE(m.leg, '') || ':' || COALESCE(m.home_entry_id, '') || ':' ||
                    COALESCE(m.away_entry_id, ''),
                  json_extract(j.value, '$.week'),
                  json_extract(j.value, '$.day'),
                  json_extract(j.value, '$.time'),
                  json_extract(j.value, '$.override'),
                  json_extract(j.value, '$.reason')
           FROM schedule_revision r, json_each(?) j
           JOIN match m ON m.id = CAST(json_extract(j.value, '$.matchId') AS INTEGER)
          WHERE r.season_id = ? AND r.revision = ?`
        )
        .bind(seasonId, assignmentJson, seasonId, revision),
      // 若 placements 读库后又有 match 被删/重建，JOIN match 会少插行；
      // 这里用 changes() 守住「版本头说 N 场、assignment 真写 N 行」。
      guardChangesStmt(db, placements.length),
      auditStmt(
        db,
        input.actorUserId ?? null,
        input.status === "restored"
          ? "schedule_revision_restore"
          : input.status === "published"
            ? "schedule_revision_publish"
            : "schedule_revision_commit",
        seasonId,
        { revision, hash, count: placements.length },
        "season"
      ),
    ],
  };
}

/** 并发写 paths 撞 UNIQUE(season_id, revision) 时的识别；调用方据此重试一次。 */
function isRevisionConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("UNIQUE constraint failed") &&
    message.includes("schedule_revision.revision")
  );
}

/**
 * 业务写库 + 版本落账同批执行，并在 revision 号撞车时自动重试。
 * 入参的 businessStmts 必须先于版本语句执行（通常是对 match / round_window 的写）；
 * 它们不依赖 revision 号，因此可以安全重放到新 revision 上。
 */
type RevisionBatchResults = Awaited<ReturnType<D1Database["batch"]>>;

/**
 * batch 内守卫：business UPDATE 的实际 changes 与预期不符时抛错，整批回滚。
 * SQLite 没有 RAISE() 可用于普通 SELECT，这里用 json() 解析非法串抛
 * "malformed JSON"；调用方把它映射成 409。
 */
export function guardChangesStmt(db: D1Database, expected: number): D1PreparedStatement {
  return db
    .prepare(`SELECT json(CASE WHEN changes() = ? THEN '1' ELSE 'x' END)`)
    .bind(expected);
}

/** 乐观并发：调用方读全季状态时看到的 revision 若已变化，整批回滚。 */
export function guardRevisionStmt(
  db: D1Database,
  seasonId: number,
  expected: number
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT json(CASE WHEN (SELECT COALESCE(MAX(revision), 0) FROM schedule_revision WHERE season_id = ?) = ? THEN '1' ELSE 'x' END)`
    )
    .bind(seasonId, expected);
}

export async function runSeasonRevisionBatch(
  db: D1Database,
  seasonId: number,
  placements: SeasonPlacement[],
  input: CommitSeasonRevisionInput,
  businessStmts: D1PreparedStatement[] = [],
  // 不在 helper 里重试：调用方传进来的 placements 是进入函数前的快照，重试时只换
  // revision 号、不重读全季状态，会写出「版本 hash 与库不一致」的假成功。冲突就直接
  // 409，让前端重新预览/重新读库。
  maxAttempts = 1,
  // 与 businessStmts 逐条对应；给了数字就在该语句后插一条 changes() 守卫。
  expectedChanges: number[] = [],
  // 调用方读全季状态时看到的 revision；给了就在 batch 最前面加乐观锁守卫。
  expectedBaseRevision?: number
): Promise<{
  revision: number;
  summary: SeasonRevisionSummary;
  /** 仅 businessStmts 的结果，按调用方传入顺序；guard 语句不会混进来。 */
  businessResults: RevisionBatchResults;
}> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const maxRow = await db
      .prepare(`SELECT MAX(revision) AS m FROM schedule_revision WHERE season_id = ?`)
      .bind(seasonId)
      .first<{ m: number | null }>();
    const revision = (maxRow?.m ?? 0) + 1;
    const { stmts } = await buildSeasonRevisionStmts(
      db,
      seasonId,
      placements,
      input,
      revision
    );
    // 每条业务写后面插 changes() 守卫：只要有一场被并发改掉/已开赛，整批回滚，
    // 不会出现「版本已落、场次只改了一半」的半成功状态。
    const guardedBusiness = businessStmts.flatMap((stmt, i) =>
      expectedChanges[i] == null ? [stmt] : [stmt, guardChangesStmt(db, expectedChanges[i])]
    );
    const prefix =
      expectedBaseRevision == null
        ? []
        : [guardRevisionStmt(db, seasonId, expectedBaseRevision)];
    try {
      const rawResults = await db.batch([...prefix, ...guardedBusiness, ...stmts]);
      const businessResults: RevisionBatchResults = [];
      let cursor = prefix.length;
      for (let i = 0; i < businessStmts.length; i += 1) {
        businessResults.push(rawResults[cursor]);
        cursor += expectedChanges[i] == null ? 1 : 2;
      }
      const summary = await getRevisionByNumber(db, seasonId, revision);
      if (!summary) throw new Error(`版本 ${revision} 写入后读不到`);
      return { revision, summary, businessResults };
    } catch (err) {
      if (isRevisionConflict(err)) {
        throw new SeasonRevisionError(
          "revision_conflict",
          "排期版本号冲突（有人同时提交），请刷新后重试"
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("malformed JSON")) {
        throw new SeasonRevisionError(
          "revision_conflict",
          "场次已被并发修改或已开赛，本次写入已整体回滚，请刷新后重试"
        );
      }
      throw err;
    }
  }
  throw new SeasonRevisionError("revision_conflict", "排期版本号分配失败，请重试");
}

/**
 * 把一份整季 placements 落成新版本（S3）。
 *
 * 与 archiveSeasonRevision 的差别：不幂等、revision 取 MAX+1、status/note 由调用方定。
 * revision 的 assignments 仍然只存「有时刻」的场次（含已开赛场——它们的时刻是历史事实）。
 */
export async function commitSeasonRevision(
  db: D1Database,
  seasonId: number,
  placements: SeasonPlacement[],
  input: CommitSeasonRevisionInput
): Promise<SeasonRevisionSummary> {
  const { summary } = await runSeasonRevisionBatch(db, seasonId, placements, input);
  return summary;
}

export type RestoreSkipReason = "not_pending" | "scope_missing";

/** restoreSeasonRevision 的返回（S3）。 */
export type RestoreSeasonRevisionResult = {
  /** 回滚后新落成的 restored 版本 */
  revision: SeasonRevisionSummary;
  restoredMatchIds: number[];
  /** 目标版本 scope 内、当前有排期但目标版本没有的场次：回滚时清空 */
  clearedMatchIds: number[];
  /** 已开赛/有比分的场次：保持现状不写回（时刻本来也不会再变） */
  skippedMatchIds: number[];
  /** 跳过原因：让调用方区分“已开赛”与“赛历重建后对不上” */
  skippedReasons: Array<{ matchId: number; reason: RestoreSkipReason }>;
  /** 回滚后的整季体检（回滚是逃生通道：有 hard 也不拒绝，原样报告） */
  violations: SeasonViolation[];
};

/**
 * 把排期回滚到某个版本的时刻（S3）。
 *
 * - 已公布（锁定）的段：目标时刻与当前不同 → 整体拒绝（segment_locked），要解锁再回滚；
 * - 已开赛/有比分的场次跳过（保持现状）；
 * - 回滚本身也落成新版本（status='restored'，note 记来源），版本流不中断；
 * - 回滚后的整季体检只报告不拦截——回滚就是修复手段，不能把人锁死。
 */
export async function restoreSeasonRevision(
  db: D1Database,
  seasonId: number,
  revision: number,
  actor: { createdBy: string | null; actorUserId?: number | null }
): Promise<RestoreSeasonRevisionResult> {
  // 读全季状态前先记版本基线；之后的写库如果被别人插了 revision，乐观锁会让整批回滚。
  const baseRevision = await getSeasonRevisionBase(db, seasonId);
  const target = await getRevisionByNumber(db, seasonId, revision);
  if (!target) throw new SeasonRevisionError("revision_not_found", `排期版本 ${revision} 不存在`);

  const { results: assignments } = await db
    .prepare(
      `SELECT match_id, match_key, segment_id, week, day, time, override, reason
         FROM schedule_revision_assignment
        WHERE season_id = ? AND revision_id = ?`
    )
    .bind(seasonId, target.id)
    .all<{
      match_id: number;
      match_key: string;
      segment_id: number | null;
      week: number;
      day: number;
      time: string;
      override: number;
      reason: string | null;
    }>();
  if (assignments.length === 0)
    throw new SeasonRevisionError("empty_schedule", `版本 ${revision} 没有场次记录`);

  const { results: lockedRows } = await db
    .prepare(`SELECT id FROM round_window WHERE season_id = ? AND locked_at IS NOT NULL`)
    .bind(seasonId)
    .all<{ id: number }>();
  const lockedSegmentIds = new Set(lockedRows.map((r) => r.id));

  const data = await loadSeasonData(db, seasonId);
  if (!data.season) throw new SeasonRevisionError("season_not_found", "赛季不存在");
  const rules = await loadSeasonRules(db, seasonId);
  const matchById = new Map(data.matches.map((m) => [m.id, m]));
  const currentPlacementById = new Map(data.placements.map((p) => [p.matchId, p]));

  const { results: currentRows } = await db
    .prepare(
      `SELECT m.id, m.status, m.score_home, m.score_away,
              m.stage_id, m.round, m.slot, m.leg,
              m.home_entry_id, m.away_entry_id,
              m.kickoff_week, m.kickoff_day, m.kickoff_time,
              m.kickoff_override, m.kickoff_reason,
              a.segment_id, a.match_key,
              he.team_id AS home_team_id, ae.team_id AS away_team_id
         FROM match m
         JOIN schedule_revision_assignment a ON a.match_id = m.id
         LEFT JOIN entry he ON he.id = m.home_entry_id
         LEFT JOIN entry ae ON ae.id = m.away_entry_id
        WHERE a.season_id = ? AND a.revision_id = ?`
    )
    .bind(seasonId, target.id)
    .all<{
      id: number;
      status: string;
      score_home: number | null;
      score_away: number | null;
      stage_id: number;
      round: number;
      slot: number | null;
      leg: number | null;
      home_entry_id: number | null;
      away_entry_id: number | null;
      kickoff_week: number | null;
      kickoff_day: number | null;
      kickoff_time: string | null;
      kickoff_override: number;
      kickoff_reason: string | null;
      segment_id: number | null;
      home_team_id: number | null;
      away_team_id: number | null;
      match_key: string;
    }>();
  if (currentRows.length !== assignments.length) {
    throw new SeasonRevisionError(
      "revision_incomplete",
      `版本 ${revision} 包含 ${assignments.length} 场，但当前库只剩 ${currentRows.length} 场（赛事/阶段被删过），不能完整回滚`
    );
  }
  const currentById = new Map(currentRows.map((m) => [m.id, m]));
  // 目标版本里的场次可能因为 stage 被删而不在 loadSeasonData 的当前段范围内；
  // restore 会按 assignment 把它们写回，因此 match 元数据也必须能从 currentRows 补全，
  // 否则「已恢复」的场次不会进新 revision 的 placements/hash。
  for (const cur of currentRows) {
    if (matchById.has(cur.id)) continue;
    matchById.set(cur.id, {
      id: cur.id,
      stageId: cur.stage_id,
      round: cur.round,
      leg: cur.leg,
      slot: cur.slot ?? 0,
      status: cur.status,
      scoreHome: cur.score_home,
      scoreAway: cur.score_away,
      homeTeamId: cur.home_team_id,
      awayTeamId: cur.away_team_id,
      kickoffWeek: cur.kickoff_week,
      kickoffDay: cur.kickoff_day,
      kickoffTime: cur.kickoff_time,
      override: cur.kickoff_override === 1,
      reason: cur.kickoff_reason,
      segmentId: cur.segment_id,
    });
  }
  const currentKeyOf = (m: (typeof currentRows)[number]): string =>
    [
      m.stage_id,
      m.round,
      m.slot ?? "",
      m.leg ?? "",
      m.home_entry_id ?? "",
      m.away_entry_id ?? "",
    ].join(":");
  for (const a of assignments) {
    const cur = currentById.get(a.match_id);
    if (!cur || currentKeyOf(cur) !== a.match_key) {
      throw new SeasonRevisionError(
        "revision_incomplete",
        `版本 ${revision} 的 match ${a.match_id} 身份已变化（赛事/阶段被重建过），不能按旧快照回滚`
      );
    }
  }

  // 先算出哪些场次回滚时不会写：已开赛/有比分的场不该因为「目标时刻不同」
  // 触发锁定冲突，否则回滚逃生通道会被一场已完赛的场次卡死。
  const restoredMatchIds: number[] = [];
  const skippedMatchIds: number[] = [];
  const skippedSet = new Set<number>();
  const skippedReasons: Array<{ matchId: number; reason: RestoreSkipReason }> = [];
  const markSkipped = (matchId: number, reason: RestoreSkipReason): void => {
    if (skippedSet.has(matchId)) return;
    skippedSet.add(matchId);
    skippedMatchIds.push(matchId);
    skippedReasons.push({ matchId, reason });
  };
  for (const a of assignments) {
    const cur = currentById.get(a.match_id);
    const m = matchById.get(a.match_id);
    if (!cur || !m || m.segmentId == null) {
      // 当前赛历已不再覆盖这个场次（阶段/窗口被重建）：写回会让新 revision 的 hash
      // 与线上 loadSeasonData 的口径不一致，直接跳过并在结果里说明。
      markSkipped(a.match_id, "scope_missing");
      continue;
    }
    if (cur.status !== "pending" || cur.score_home != null || cur.score_away != null) {
      markSkipped(a.match_id, "not_pending");
      continue;
    }
    restoredMatchIds.push(a.match_id);
  }

  // 锁定段检查：目标段或当前所在段只要有一边已公布，且回滚会改变时刻/归属，
  // 就必须先解锁。只看目标段会漏掉「场次当前在锁定段、目标版本把它拉回未锁段」。
  const lockedConflicts = new Set<number>();
  for (const a of assignments) {
    if (skippedSet.has(a.match_id)) continue;
    const cur = currentById.get(a.match_id);
    const curSeg = currentPlacementById.get(a.match_id)?.segmentId ?? null;
    const targetLocked = a.segment_id != null && lockedSegmentIds.has(a.segment_id);
    const currentLocked = curSeg != null && lockedSegmentIds.has(curSeg);
    if (!targetLocked && !currentLocked) continue;
    const same =
      cur != null &&
      cur.kickoff_week === a.week &&
      cur.kickoff_day === a.day &&
      cur.kickoff_time === a.time &&
      curSeg === a.segment_id;
    if (!same) {
      if (targetLocked) lockedConflicts.add(a.segment_id!);
      if (currentLocked) lockedConflicts.add(curSeg!);
    }
  }
  if (lockedConflicts.size > 0) {
    const ids = [...lockedConflicts].sort((a, b) => a - b).join("、");
    throw new SeasonRevisionError("segment_locked", `段 ${ids} 已公布且目标时刻不同，先解锁再回滚`);
  }

  const restoredSet = new Set(restoredMatchIds);
  const restoreJson = JSON.stringify(
    assignments
      .filter((a) => restoredSet.has(a.match_id))
      .map((a) => ({ matchId: a.match_id, week: a.week, day: a.day, time: a.time, override: a.override, reason: a.reason }))
  );

  // 回滚后的整季状态在写库前就算好（不经二次读库）：
  // 不在版本里的场次保持现状；要回滚的场次换成版本时刻（跳过的保持现状）。
  const restoreById = new Map<number, (typeof assignments)[number]>();
  for (const a of assignments) {
    if (restoredSet.has(a.match_id)) restoreById.set(a.match_id, a);
  }
  const targetIds = new Set(assignments.map((a) => a.match_id));
  const clearedMatchIds: number[] = [];
  const placements: SeasonPlacement[] = [];
  for (const p of data.placements) {
    const a = restoreById.get(p.matchId);
    if (a && !skippedSet.has(p.matchId)) {
      // 场次被回滚：换成版本里的时刻 / override / reason（segmentId 用版本存的，回滚不猜）
      placements.push({
        matchId: p.matchId,
        // 回滚只改时刻/override/reason；段归属沿用当前赛历派生，避免旧 segment_id 已被重建。
        segmentId: p.segmentId,
        week: a.week,
        day: a.day,
        time: a.time,
        override: a.override === 1,
        reason: a.reason,
        homeTeamId: p.homeTeamId,
        awayTeamId: p.awayTeamId,
      });
      continue;
    }
    // 所有 revision 都是整季快照：当前有排期、目标版本里没有的场次，回滚时应清掉。
    // 只清还能改的场（pending、无比分）；已开赛/有比分的保留现状并计入 skipped。
    if (!targetIds.has(p.matchId)) {
      const m = matchById.get(p.matchId);
      const mutable =
        m != null &&
        m.status === "pending" &&
        m.scoreHome == null &&
        m.scoreAway == null;
      const locked = p.segmentId != null && lockedSegmentIds.has(p.segmentId);
      if (mutable && !locked) {
        clearedMatchIds.push(p.matchId);
        continue;
      }
      if (!mutable) markSkipped(p.matchId, "not_pending");
    }
    placements.push(p);
  }
  // 版本里有、当前没排上的场次（提交后被清空过）也要回到版本状态。
  const placedIds = new Set(placements.map((p) => p.matchId));
  for (const [id, a] of restoreById) {
    if (placedIds.has(id)) continue;
    if (skippedSet.has(id)) continue; // 已开赛/有比分的场不写回目标时刻
    const m = matchById.get(id);
    if (!m) continue;
    placements.push({
      matchId: id,
      // 段归属以当前赛历派生为准；旧版本里的 segment_id 可能已被重建。
      segmentId: m.segmentId,
      week: a.week,
      day: a.day,
      time: a.time,
      override: a.override === 1,
      reason: a.reason,
      homeTeamId: m.homeTeamId,
      awayTeamId: m.awayTeamId,
    });
  }
  placements.sort((a, b) => a.matchId - b.matchId);
  const violations = validateSeason(
    { segments: data.segments, placements, pools: data.pools, season: data.season },
    rules
  );

  const stmts: D1PreparedStatement[] = [];
  let restoreStmtIndex = -1;
  if (restoredMatchIds.length > 0) {
    restoreStmtIndex = stmts.length;
    stmts.push(
      db.prepare(
        `UPDATE match AS m SET
                kickoff_week = CAST(json_extract(j.value, '$.week') AS INTEGER),
                kickoff_day = CAST(json_extract(j.value, '$.day') AS INTEGER),
                kickoff_time = json_extract(j.value, '$.time'),
                kickoff_override = CAST(json_extract(j.value, '$.override') AS INTEGER),
                kickoff_reason = json_extract(j.value, '$.reason')
           FROM json_each(?) AS j
          WHERE m.id = CAST(json_extract(j.value, '$.matchId') AS INTEGER)
            AND m.status = 'pending'
            AND m.score_home IS NULL
            AND m.score_away IS NULL`
      ).bind(restoreJson)
    );
  }
  let clearStmtIndex = -1;
  if (clearedMatchIds.length > 0) {
    clearStmtIndex = stmts.length;
    stmts.push(
      db.prepare(
        `UPDATE match AS m SET
                kickoff_week = NULL, kickoff_day = NULL, kickoff_time = NULL,
                kickoff_override = 0, kickoff_reason = NULL
           FROM json_each(?) AS j
          WHERE m.id = CAST(json_extract(j.value, '$.matchId') AS INTEGER)
            AND m.status = 'pending'
            AND m.score_home IS NULL
            AND m.score_away IS NULL`
      ).bind(JSON.stringify(clearedMatchIds.map((matchId) => ({ matchId }))))
    );
  }
  const expectedChanges: number[] = [];
  if (restoreStmtIndex >= 0) expectedChanges[restoreStmtIndex] = restoredMatchIds.length;
  if (clearStmtIndex >= 0) expectedChanges[clearStmtIndex] = clearedMatchIds.length;
  const { summary } = await runSeasonRevisionBatch(
    db,
    seasonId,
    placements,
    {
      createdBy: actor.createdBy,
      actorUserId: actor.actorUserId ?? null,
      status: "restored",
      note: `回滚自版本 r${revision}`,
      violations,
      totalMatches: data.matches.length,
      unmatchedMatchIds: placements.filter((p) => p.segmentId == null).map((p) => p.matchId),
    },
    stmts,
    1,
    expectedChanges,
    baseRevision
  );
  return {
    revision: summary,
    restoredMatchIds,
    clearedMatchIds,
    skippedMatchIds,
    skippedReasons: skippedReasons.sort((a, b) => a.matchId - b.matchId),
    violations,
  };
}
