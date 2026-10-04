// 淘汰赛阶段的「出线来源」读取：把来源阶段的名次行喂给 worker/lib/qualifiers.ts 的纯函数。
// 两种语义各自的名次口径：
//   cross（跨组模板 A1-B2）→ rank = 组内名次、groupName = 组名
//   range（第 from–to 名）  → rank = 取人顺序（组内名次优先 → 积分 → 同分链 → 种子位），与赛程生成同序
import { getTiebreakers, readStandings, type StandRow } from "./standings";
import type { TiebreakerKey } from "../../shared/types";
import type { QualifierRow } from "./qualifiers";

export type SourceStageInfo = {
  id: number;
  kind: "elim" | "round_robin" | "group";
  name: string | null;
};

export type QualifierContext = {
  stageName: string | null;
  stageKind: string | null;
  rows: QualifierRow[];
};

// 取人来源阶段：显式 fromStage 优先，否则取排序紧邻的前一阶段（与赛程生成的取人规则一致）
export async function resolveSourceStage(
  db: D1Database,
  tid: number,
  stageId: number,
  fromStage?: number
): Promise<SourceStageInfo | null> {
  if (fromStage) {
    return await db
      .prepare(
        `SELECT id, kind, name FROM stage
         WHERE id = ? AND tournament_id = ?
           AND sort_order < (SELECT sort_order FROM stage WHERE id = ?)`
      )
      .bind(fromStage, tid, stageId)
      .first<SourceStageInfo>();
  }
  return await db
    .prepare(
      `SELECT id, kind, name FROM stage
       WHERE tournament_id = ?
         AND sort_order < (SELECT sort_order FROM stage WHERE id = ?)
       ORDER BY sort_order DESC LIMIT 1`
    )
    .bind(tid, stageId)
    .first<SourceStageInfo>();
}

// 跨组取人排序：组内名次优先（各小组第一先进），同名次内按 积分 → 同分链（无相互战绩可比，跳过 h2h）→ 种子位
export function sortSourceStandings(
  ranked: StandRow[],
  kind: string,
  chain: TiebreakerKey[]
): StandRow[] {
  if (kind !== "group") return ranked;
  const nonH2h = chain.filter((t) => t !== "h2h");
  const cmp = (a: StandRow, b: StandRow): number => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.pts !== b.pts) return b.pts - a.pts;
    for (const t of nonH2h) {
      const va = t === "gd" ? a.goalsFor - a.goalsAgainst : a.goalsFor;
      const vb = t === "gd" ? b.goalsFor - b.goalsAgainst : b.goalsFor;
      if (va !== vb) return vb - va;
    }
    return a.seed - b.seed;
  };
  ranked.sort(cmp);
  return ranked;
}

// range 语义的名次行（全池名次）
export async function rangeQualifierRows(
  db: D1Database,
  tid: number,
  srcStageId: number,
  kind: string
): Promise<QualifierRow[]> {
  const chain = await getTiebreakers(db, tid);
  const ranked = await readStandings(db, srcStageId, chain);
  return sortSourceStandings(ranked, kind, chain).map((r, i) => ({
    entryId: r.entryId,
    teamName: r.teamName,
    rank: i + 1,
    groupName: null,
  }));
}

// cross 语义的名次行（组名 + 组内名次）
export async function crossQualifierRows(
  db: D1Database,
  tid: number,
  srcStageId: number
): Promise<QualifierRow[]> {
  const groups = await db
    .prepare('SELECT id, name FROM "group" WHERE stage_id = ?')
    .bind(srcStageId)
    .all<{ id: number; name: string }>();
  const nameOf = new Map((groups.results ?? []).map((g) => [g.id, g.name]));
  const chain = await getTiebreakers(db, tid);
  const ranked = await readStandings(db, srcStageId, chain);
  return ranked.map((r) => ({
    entryId: r.entryId,
    teamName: r.teamName,
    rank: r.rank,
    groupName: r.groupId != null ? nameOf.get(r.groupId) ?? null : null,
  }));
}

// 配置里是否有可用的跨组模板（决定按 cross 还是 range 读名次行）
function hasCrossTemplate(cross: unknown): boolean {
  if (typeof cross === "string") return cross.trim() !== "";
  if (Array.isArray(cross)) {
    return cross.some((x) => typeof x === "string" && x.trim() !== "");
  }
  return false;
}

// 淘汰赛阶段的出线来源上下文（best-effort：解不出就是空行，调用方回退占位/省略标记）
export async function loadQualifierContext(
  db: D1Database,
  tid: number,
  stageId: number,
  configJson: string | null
): Promise<QualifierContext> {
  let cfg: { source?: Record<string, unknown> } = {};
  try {
    cfg = (JSON.parse(configJson || "{}") ?? {}) as { source?: Record<string, unknown> };
  } catch {
    return { stageName: null, stageKind: null, rows: [] };
  }
  const src = cfg.source ?? {};
  // 没有取人规则（手动落位的淘汰赛：候选就是全部参赛队）→ 没有出线名单：
  // 占位回退「待定」，管理端也不标「出线」，否则会把上一阶段第一名当成本阶段默认出线队。
  const hasRange =
    typeof src.from === "number" || typeof src.to === "number" || typeof src.take === "number";
  if (!hasCrossTemplate(src.cross) && !hasRange) {
    return { stageName: null, stageKind: null, rows: [] };
  }
  const fromStage = typeof src.fromStage === "number" ? src.fromStage : undefined;
  const srcStage = await resolveSourceStage(db, tid, stageId, fromStage);
  if (!srcStage || srcStage.kind === "elim") {
    return { stageName: null, stageKind: null, rows: [] };
  }
  // 名次要等来源阶段全部完赛才作数（与赛程生成 takeRangePool 同口径）：
  // 否则会把「还打完一半的名次」当成出线名单，公开页显示可能随时变化的队名。
  const st = await db
    .prepare("SELECT status, COUNT(*) AS n FROM match WHERE stage_id = ? GROUP BY status")
    .bind(srcStage.id)
    .all<{ status: string; n: number }>();
  const byStatus = new Map((st.results ?? []).map((r) => [r.status, r.n]));
  if ((byStatus.get("pending") ?? 0) + (byStatus.get("live") ?? 0) > 0 || !byStatus.get("finished")) {
    return { stageName: null, stageKind: null, rows: [] };
  }
  const rows = hasCrossTemplate(src.cross)
    ? await crossQualifierRows(db, tid, srcStage.id)
    : await rangeQualifierRows(db, tid, srcStage.id, srcStage.kind);
  return { stageName: srcStage.name ?? null, stageKind: srcStage.kind, rows };
}
