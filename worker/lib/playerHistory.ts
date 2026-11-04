// 球员归属履历：重建与回填（设计 docs/design-tournament-player-teams.md §6）。
//
// 履历表是「当前归属」的唯一真源：开放窗口（left_at IS NULL）= 现役。本模块只处理履历本身，
// 不碰球员归属列：归属只由名册同步维护的履历窗口表达。
//
// 数据源是俱乐部平台的转会记录（GET /api/players/{fcId}/transfers，最近 50 条已完成单据）。
// 重建必须幂等：同一份记录 + 同一个观察值重复跑，窗口集合与时间戳不漂移；实现方式是每次
// 「删掉该球员全部窗口 → 按回放结果重写」，一次 batch 原子提交。
import type { Bindings } from "../env";

export type HistorySource = "transfer" | "fallback" | "sync" | "seed";

export interface HistoryWindow {
  teamId: number;
  joinedAt: string;
  leftAt: string | null;
  source: HistorySource;
}

/** 俱乐部平台转会记录（只保留重建用到的字段） */
export interface TransferRecord {
  type: string;
  fromClubId: number | null;
  fromClubName: string | null;
  toClubId: number | null;
  toClubName: string | null;
  completedAt: string | null;
}

/** 5xx / 超时 / 429 / 形状坏：调用方保留旧履历，下一轮重试 */
export class TransferFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TransferFetchError";
  }
}

/** 拉取超时：无人值守的定时任务，对方挂住时必须变成一条可观察的失败分支 */
const FETCH_TIMEOUT_MS = 10_000;
/** 每轮回填人数与有界并发（设计 §6.4：40 人串行最坏 400 秒，会撞 Worker 预算） */
const BACKFILL_BATCH = 40;
const BACKFILL_CONCURRENCY = 5;
const BACKFILL_DEADLINE_MS = 60_000;
/** 429 只做一次短退避，仍失败就放弃该球员（保持 history_synced_at 为 NULL，下轮再来） */
const RETRY_429_MS = 1_000;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clubBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/** 转会接口的字段校验：形状坏按 5xx 处理，绝不把半截数据当履历用 */
function parseTransferRecord(raw: unknown, url: string, i: number): TransferRecord {
  const r = raw as {
    type?: unknown;
    fromClubId?: unknown;
    fromClubName?: unknown;
    toClubId?: unknown;
    toClubName?: unknown;
    completedAt?: unknown;
  };
  if (typeof r.type !== "string" || r.type === "") {
    throw new TransferFetchError(`GET ${url} 第 ${i + 1} 条转会记录缺 type`);
  }
  const clubId = (v: unknown, field: string): number | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== "number" || !Number.isInteger(v)) {
      throw new TransferFetchError(`GET ${url} 第 ${i + 1} 条转会记录的 ${field} 不是整数`);
    }
    return v;
  };
  const clubName = (v: unknown): string | null => (typeof v === "string" ? v : null);
  if (r.completedAt !== null && r.completedAt !== undefined && typeof r.completedAt !== "string") {
    throw new TransferFetchError(`GET ${url} 第 ${i + 1} 条转会记录的 completedAt 不是字符串`);
  }
  return {
    type: r.type,
    fromClubId: clubId(r.fromClubId, "fromClubId"),
    fromClubName: clubName(r.fromClubName),
    toClubId: clubId(r.toClubId, "toClubId"),
    toClubName: clubName(r.toClubName),
    completedAt: typeof r.completedAt === "string" ? r.completedAt : null,
  };
}

/**
 * 拉取一名球员的已完成转会记录。
 * 404/410 = 俱乐部平台查无此人（终态）；其余失败抛 TransferFetchError 由调用方决定重试。
 */
export async function fetchTransferRecords(
  base: string,
  playerId: number,
  opts: { timeoutMs?: number } = {},
): Promise<{ kind: "ok"; records: TransferRecord[] } | { kind: "not_found" }> {
  const url = `${clubBase(base)}/api/players/${playerId}/transfers`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new TransferFetchError(`GET ${url} 失败：${errText(e)}`);
  }
  // 404/410 是终态：球员在俱乐部平台不存在或不可考，按「没有转会记录」处理
  if (res.status === 404 || res.status === 410) return { kind: "not_found" };
  if (!res.ok) throw new TransferFetchError(`GET ${url} 返回 ${res.status}`, res.status);

  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    throw new TransferFetchError(`GET ${url} 响应不是 JSON：${errText(e)}`, res.status);
  }
  const raw = (body as { transfers?: unknown } | null)?.transfers;
  if (!Array.isArray(raw)) throw new TransferFetchError(`GET ${url} 响应里没有 transfers 数组`);
  return { kind: "ok", records: raw.map((r, i) => parseTransferRecord(r, url, i)) };
}

export interface ObservedTeam {
  /** 本次快照确实看到他在该队；null = 确实看到他不属于任何队 */
  teamId: number | null;
  at: string;
}

export interface RebuildOptions {
  apiBase: string;
  mode: "sync" | "backfill";
  /** 只有同步触发的重建才传；不传 = 没有可信观察 */
  observed?: ObservedTeam;
  /** 已知球队集合（回填时整轮复用，省掉每人一次 team 全表读） */
  knownTeams?: Set<number>;
  /** 收口用的当前时刻，测试注入 */
  now?: string;
}

export interface RebuildResult {
  windows: HistoryWindow[];
  /** 实际回放的转会记录条数（屏障前的） */
  applied: number;
  /** 是否被未知俱乐部屏障截断 */
  barrier: boolean;
}

type Segment = HistoryWindow;

/** 关闭某队最后一条仍开放的段；关不到返回 false */
function closeTeam(segments: Segment[], teamId: number, at: string): boolean {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (s.teamId === teamId && s.leftAt === null) {
      s.leftAt = s.joinedAt > at ? s.joinedAt : at;
      return true;
    }
  }
  return false;
}

/**
 * 按设计 §6.2 的十步重建一名球员的履历，并原子写回。
 *
 * 关键点：
 * - 记录升序回放，未知俱乐部是屏障（这条及之后的都不应用，不伪造 team_id）；
 * - 当前队优先级 observed → 比最后记录更新的开放窗口 → 回放终态 → 无；
 * - 无记录时 404 也写 history_synced_at（不阻塞归档）；5xx/429 抛错，标记保持 NULL。
 */
export async function rebuildPlayerHistory(
  db: D1Database,
  playerId: number,
  opts: RebuildOptions,
): Promise<RebuildResult> {
  const now = opts.now ?? new Date().toISOString();
  const player = await db
    .prepare("SELECT created_at FROM player WHERE id = ?")
    .bind(playerId)
    .first<{ created_at: string }>();
  if (!player) throw new Error(`球员 ${playerId} 不存在，无法重建履历`);

  const existing = await db
    .prepare(
      "SELECT team_id, joined_at, left_at, source FROM player_team_history WHERE player_id = ? ORDER BY joined_at, id",
    )
    .bind(playerId)
    .all<{ team_id: number; joined_at: string; left_at: string | null; source: HistorySource }>();
  const openWindow = existing.results.find((w) => w.left_at === null) ?? null;

  let knownTeams = opts.knownTeams;
  if (!knownTeams) {
    const teams = await db.prepare("SELECT id FROM team").all<{ id: number }>();
    knownTeams = new Set(teams.results.map((t) => t.id));
  }

  // not_found：按无记录处理并写入 history_synced_at（§6.2 第 9 步）；
  // 5xx / 超时 / 429 / 形状坏直接抛，不动已有履历、不更新标记
  const fetched = await fetchTransferRecords(opts.apiBase, playerId);
  const records = fetched.kind === "ok" ? fetched.records : [];

  // 升序回放：接口按 completed_at DESC 返回，但重建不能依赖调用方顺序，自己按时间排一次。
  // from == to（match / rc_change）不是换队；completedAt 为空的记录无法定位时间，跳过。
  const moves = records
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.completedAt !== null && r.fromClubId !== r.toClubId)
    .sort((a, b) => {
      const x = a.r.completedAt as string;
      const y = b.r.completedAt as string;
      if (x !== y) return x < y ? -1 : 1;
      // 同一时刻保持接口原序（completed_at DESC, id DESC）
      return a.i - b.i;
    })
    .map(({ r }) => r);

  const segments: Segment[] = [];
  let lastRecordAt: string | null = null;
  let replayTerminalTeam: number | null = null;
  let terminationAt: string | null = null;
  let barrier = false;
  let applied = 0;
  let firstApplied = true;

  for (const r of moves) {
    const at = r.completedAt as string;
    // 未知俱乐部是屏障：这条及之后的都不应用，保留前面算出的最后已知队
    if (
      (r.fromClubId !== null && !knownTeams.has(r.fromClubId)) ||
      (r.toClubId !== null && !knownTeams.has(r.toClubId))
    ) {
      barrier = true;
      break;
    }
    if (r.fromClubId !== null) {
      const closed = closeTeam(segments, r.fromClubId, at);
      // 最早一条的 from 没有更早的 joined_at 可考：用 player.created_at 兜底
      if (!closed && firstApplied) {
        segments.push({
          teamId: r.fromClubId,
          joinedAt: player.created_at,
          leftAt: player.created_at > at ? player.created_at : at,
          source: "transfer",
        });
      }
    }
    if (r.toClubId !== null) {
      const last = segments[segments.length - 1];
      // 连续同队的段合并：已经是该队且仍开放就不再开一条
      if (!(last && last.teamId === r.toClubId && last.leftAt === null)) {
        segments.push({ teamId: r.toClubId, joinedAt: at, leftAt: null, source: "transfer" });
      }
    }
    lastRecordAt = at;
    replayTerminalTeam = r.toClubId;
    if (r.toClubId === null) terminationAt = at;
    firstApplied = false;
    applied += 1;
  }

  // 第 5 步：确定当前队
  let currentTeam: number | null;
  if (opts.observed) {
    currentTeam = opts.observed.teamId;
  } else if (openWindow && (lastRecordAt === null || openWindow.joined_at > lastRecordAt)) {
    currentTeam = openWindow.team_id;
  } else if (lastRecordAt !== null) {
    currentTeam = replayTerminalTeam;
  } else {
    currentTeam = null;
  }

  // 第 7 步：无记录、无开放窗口、同步确实看到他属于某队 → fallback 兜底段
  if (segments.length === 0 && !openWindow && opts.observed && opts.observed.teamId !== null) {
    segments.push({ teamId: opts.observed.teamId, joinedAt: opts.observed.at, leftAt: null, source: "fallback" });
  }

  // 第 6 步：用当前队收口时间轴
  if (currentTeam !== null) {
    const sameTeamOpen = existing.results.find((w) => w.team_id === currentTeam && w.left_at === null);
    // 最后一条转入该队的记录时间（只在回放段里找）
    let lastInto: string | null = null;
    for (const s of segments) {
      if (s.teamId === currentTeam) lastInto = s.joinedAt;
    }
    let joinedAt: string;
    if (sameTeamOpen && (lastInto === null || sameTeamOpen.joined_at >= lastInto)) {
      joinedAt = sameTeamOpen.joined_at;
    } else if (lastInto !== null) {
      joinedAt = lastInto;
    } else if (opts.observed) {
      joinedAt = opts.observed.at;
    } else {
      joinedAt = now;
    }

    const last = segments[segments.length - 1];
    if (last && last.teamId === currentTeam && last.leftAt === null) {
      last.joinedAt = joinedAt;
    } else {
      for (const s of segments) {
        if (s.leftAt === null) s.leftAt = s.joinedAt > joinedAt ? s.joinedAt : joinedAt;
      }
      segments.push({
        teamId: currentTeam,
        joinedAt,
        leftAt: null,
        // 观察到的归属标 sync；没观察值时沿用同队窗口的来源（种子窗口不该被洗成 transfer）
        source: opts.observed ? "sync" : (sameTeamOpen?.source ?? "transfer"),
      });
    }
  } else {
    // 当前队为空：关闭所有开放段，离队时间优先取 termination
    const closeAt = terminationAt ?? now;
    for (const s of segments) {
      if (s.leftAt === null) s.leftAt = s.joinedAt > closeAt ? s.joinedAt : closeAt;
    }
  }

  const windows: HistoryWindow[] = segments
    .map((s) => ({ teamId: s.teamId, joinedAt: s.joinedAt, leftAt: s.leftAt, source: s.source }))
    .sort((a, b) => (a.joinedAt === b.joinedAt ? a.teamId - b.teamId : a.joinedAt < b.joinedAt ? -1 : 1));

  const stmts: D1PreparedStatement[] = [
    db.prepare("DELETE FROM player_team_history WHERE player_id = ?").bind(playerId),
  ];
  for (const w of windows) {
    stmts.push(
      db
        .prepare(
          "INSERT INTO player_team_history (player_id, team_id, joined_at, left_at, source) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(playerId, w.teamId, w.joinedAt, w.leftAt, w.source),
    );
  }
  stmts.push(db.prepare("UPDATE player SET history_synced_at = ? WHERE id = ?").bind(now, playerId));
  await db.batch(stmts);

  return { windows, applied, barrier };
}

export interface BackfillSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  /** 未配置 CLUB_API_BASE，整轮跳过 */
  skipped: boolean;
}

/**
 * 每小时回填：`history_synced_at IS NULL` 的球员，按 id 升序每轮最多 40 人、并发 5、
 * 全局 60 秒 deadline。失败的人标记保持 NULL，下一轮自动重试。
 */
export async function runHistoryBackfill(
  env: Bindings,
  opts: { skip?: Set<number>; limit?: number; deadlineMs?: number } = {},
): Promise<BackfillSummary> {
  const out: BackfillSummary = { attempted: 0, succeeded: 0, failed: 0, skipped: false };
  const base = env.CLUB_API_BASE;
  if (!base) {
    console.log("[history-backfill] 未配置 CLUB_API_BASE，跳过");
    out.skipped = true;
    return out;
  }

  const limit = opts.limit ?? BACKFILL_BATCH;
  const deadline = Date.now() + (opts.deadlineMs ?? BACKFILL_DEADLINE_MS);
  const rows = await env.DB.prepare("SELECT id FROM player WHERE history_synced_at IS NULL ORDER BY id").all<{
    id: number;
  }>();
  const ids = rows.results
    .map((r) => r.id)
    .filter((id) => !opts.skip?.has(id))
    .slice(0, limit);
  if (ids.length === 0) return out;

  const teams = await env.DB.prepare("SELECT id FROM team").all<{ id: number }>();
  const knownTeams = new Set(teams.results.map((t) => t.id));

  let cursor = 0;
  const work = async (): Promise<void> => {
    while (true) {
      // deadline 到了就不再领新人；已在飞的一轮最多再跑一个 10 秒超时
      if (Date.now() >= deadline) return;
      const i = cursor++;
      if (i >= ids.length) return;
      const id = ids[i];
      out.attempted += 1;
      try {
        await rebuildPlayerHistory(env.DB, id, { apiBase: base, mode: "backfill", knownTeams });
        out.succeeded += 1;
      } catch (e) {
        const retry = e instanceof TransferFetchError && e.status === 429;
        if (retry && Date.now() < deadline) {
          await sleep(RETRY_429_MS);
          try {
            await rebuildPlayerHistory(env.DB, id, { apiBase: base, mode: "backfill", knownTeams });
            out.succeeded += 1;
            continue;
          } catch (e2) {
            out.failed += 1;
            console.error(`[history-backfill] 球员 ${id} 重试后仍失败：${errText(e2)}`);
            continue;
          }
        }
        out.failed += 1;
        console.error(`[history-backfill] 球员 ${id} 失败：${errText(e)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BACKFILL_CONCURRENCY, ids.length) }, () => work()));
  return out;
}
