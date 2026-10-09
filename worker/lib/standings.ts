import type {
  CarryMode,
  StageStandingDTO,
  StandingGroupDTO,
  TiebreakerKey,
} from "../../shared/types";
import { mediaUrl } from "./media";
// 积分重算 + 淘汰晋级器（TECH_DESIGN §6：全量重算而非增量累加，
// 报分/改分/改判走同一条路径，永远收敛到正确结果）
// 两个构建器都只读 + 返回 D1PreparedStatement[]，由调用方与报分写入合并进
// 同一个 db.batch 原子提交（D1 batch = 隐式事务）。

type FinishedMatchRow = {
  home_entry_id: number | null;
  away_entry_id: number | null;
  score_home: number | null;
  score_away: number | null;
  pen_home: number | null;
  pen_away: number | null;
  walkover_side: string | null;
};

// ---------- 带入积分：从上游循环赛阶段按倍数带分 ----------
// 配置写在目标阶段自己的 config_json.carry（见 shared/types.ts 的 CarryConfig）。
// 折算基数就是源阶段榜上的实际积分（源 standing.pts，注意它已经扣过该阶段命中的扣分）：
// 罚分把源阶段的分打低，下游带入的部分就跟着少，不做任何「加回扣分」的还原；
// 链式带入（A→B→C）自动成立，因为 B.pts 里已经含了 B 带入的分。
// 倍数是浮点倍数：1 = 源分照搬、0.5 = 一半、0 = 不带分（v5.6.1 起从百分数改口径，
// 5.6.0 期间写下的百分数由迁移 0028 一次性换算成倍数）。
type StageLite = { id: number; kind: string; name: string | null; sort_order: number };

type CarryResolution = { fromStageId: number; mode: CarryMode; multiplier: number };

export function listStages(db: D1Database, tournamentId: number): Promise<D1Result<StageLite>> {
  return db
    .prepare(`SELECT id, kind, name, sort_order FROM stage WHERE tournament_id = ?`)
    .bind(tournamentId)
    .all<StageLite>();
}

export function normalizeCarry(
  raw: unknown
): { fromStage?: number; mode: CarryMode; multiplier: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as { fromStage?: unknown; mode?: unknown; multiplier?: unknown };
  const m = typeof c.multiplier === "number" ? c.multiplier : Number(c.multiplier);
  // 倍数是浮点倍数（1 = 原分）：非有限值或负数一律当没配（非法配置由写入端点拦，读侧稳健降级）
  if (!Number.isFinite(m) || m < 0) return null;
  const from = Number(c.fromStage);
  return {
    fromStage: Number.isInteger(from) && from > 0 ? from : undefined,
    // 方式缺省「积分+战绩」（v5.6.1 起的默认值；界面也按这个默认值写配置）
    mode: c.mode === "points" ? "points" : "record",
    multiplier: m,
  };
}

// 纯函数：在候选阶段里挑出源阶段。只认排在本阶段前面的 round_robin 阶段 ——
// 带入的前提是源榜已经算完，排在后面或类型不对都当没配。
export function pickCarrySource(
  kind: string,
  sortOrder: number,
  rawCarry: unknown,
  stages: StageLite[]
): CarryResolution | null {
  if (kind !== "round_robin") return null;
  const carry = normalizeCarry(rawCarry);
  if (!carry) return null;
  const earlier = stages.filter((s) => s.kind === "round_robin" && s.sort_order < sortOrder);
  const src =
    carry.fromStage != null
      ? earlier.find((s) => s.id === carry.fromStage)
      : earlier.sort((a, b) => b.sort_order - a.sort_order)[0];
  if (!src) return null;
  return { fromStageId: src.id, mode: carry.mode, multiplier: carry.multiplier };
}

// stage.config_json 解析：坏了就当没配，别让一张脏配置把整张榜打崩
export function parseStageConfigJson(configJson: string | null): Record<string, unknown> {
  try {
    return (JSON.parse(configJson || "{}") ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

type CarrySourceRow = {
  entry_id: number;
  pts: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
};

// 一个阶段算完后的每队「带入基数 + 战绩」：raw 就是榜上那个实际积分（净值，扣分已经在里面）——
// 下游按它折算，所以罚分会顺着带入链传导到后面的阶段。
type StageTotals = {
  raw: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
};

type CarriedEntry = {
  pts: number;
  // record 模式叠加的战绩列（点球计次不叠：它只在同分/计分语义内部用，叠了会让口径含糊）
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
};

// 读源阶段榜上的实际积分与战绩。源阶段还没算过榜（行不存在）→ 无带入。
async function readStageTotals(db: D1Database, stageId: number): Promise<Map<number, StageTotals>> {
  const res = await db
    .prepare(
      `SELECT entry_id, pts, played, won, drawn, lost, gf, ga
       FROM standing WHERE stage_id = ?`
    )
    .bind(stageId)
    .all<CarrySourceRow>();
  return new Map(
    (res.results ?? []).map((r) => [
      r.entry_id,
      {
        raw: r.pts,
        played: r.played,
        won: r.won,
        drawn: r.drawn,
        lost: r.lost,
        gf: r.gf,
        ga: r.ga,
      },
    ])
  );
}

// 按倍数折算带入分（倍数浮点，1 = 源分照搬；四舍五入到整数分）
function applyCarry(
  totals: Map<number, StageTotals>,
  multiplier: number
): Map<number, CarriedEntry> {
  return new Map(
    [...totals.entries()].map(([entryId, t]) => [
      entryId,
      {
        pts: Math.round(t.raw * multiplier),
        played: t.played,
        won: t.won,
        drawn: t.drawn,
        lost: t.lost,
        gf: t.gf,
        ga: t.ga,
      },
    ])
  );
}

// 本阶段命中的扣分合计：阶段级（stage_id = 本阶段）+ 全赛事（stage_id IS NULL）。
// 阶段级扣分不穿透到下游阶段，下游只汇总自己命中的那些。
async function readStageDeducts(db: D1Database, stageId: number): Promise<Map<number, number>> {
  const res = await db
    .prepare(
      `SELECT d.entry_id, SUM(d.points) AS pts FROM points_deduction d
       WHERE (d.stage_id IS NULL OR d.stage_id = ?)
         AND d.entry_id IN (SELECT id FROM entry WHERE tournament_id = (SELECT tournament_id FROM stage WHERE id = ?))
       GROUP BY d.entry_id`
    )
    .bind(stageId, stageId)
    .all<{ entry_id: number; pts: number }>();
  return new Map((res.results ?? []).map((r) => [r.entry_id, r.pts]));
}

const ZERO_RECORD = { played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0 };

// ---------- 积分：算出某 stage 的 standing 重建语句 ----------
// 胜 3 平 1 负 0；平分且录了点球 → 点胜 2 分 / 点负 1 分（pen_won/pen_lost 计次）。
// 落库的 pts = 本阶段得分 + 带入分 − 本阶段命中扣分（两项都单独落列，榜单要标出来）。
// 淘汰阶段无积分榜，返回 null。
// computedTotals 是同一轮级联重建里「已算过（但尚未提交）」的源阶段基数，见下方重建入口。
async function computeStageStandings(
  db: D1Database,
  stageId: number,
  computedTotals?: Map<number, Map<number, StageTotals>>
): Promise<{ stmts: D1PreparedStatement[]; totals: Map<number, StageTotals> } | null> {
  const stage = await db
    .prepare("SELECT kind, tournament_id, sort_order, config_json FROM stage WHERE id = ?")
    .bind(stageId)
    .first<{
      kind: string;
      tournament_id: number;
      sort_order: number;
      config_json: string | null;
    }>();
  if (!stage || stage.kind === "elim") return null;

  // 参赛集：小组阶段取挂在本阶段组下的 entry；循环赛默认本赛事全部报名。
  // 例外：配了 source（从上游取人）的循环赛阶段，参赛集收敛为「本阶段场次里出现过的 entry」——
  // 否则被上一阶段淘汰、没进本阶段的队会带着带入分留在榜上。还没有场次时回退全量（编排中途也能看榜）。
  const stageCfg = parseStageConfigJson(stage.config_json);
  const scopeEntries = stage.kind === "round_robin" && stageCfg.source != null;
  const entries = scopeEntries
    ? await db
        .prepare(
          `SELECT e.id, e.group_id FROM entry e
           WHERE e.tournament_id = ?
             AND e.id IN (
               SELECT home_entry_id FROM match WHERE stage_id = ? AND home_entry_id IS NOT NULL
               UNION
               SELECT away_entry_id FROM match WHERE stage_id = ? AND away_entry_id IS NOT NULL
             )`
        )
        .bind(stage.tournament_id, stageId, stageId)
        .all<{ id: number; group_id: number | null }>()
    : stage.kind === "group"
      ? await db
          .prepare(
            `SELECT e.id, e.group_id FROM entry e
             WHERE e.group_id IN (SELECT id FROM "group" WHERE stage_id = ?)`
          )
          .bind(stageId)
          .all<{ id: number; group_id: number | null }>()
      : await db
          .prepare(`SELECT e.id, e.group_id FROM entry e WHERE e.tournament_id = ?`)
          .bind(stage.tournament_id)
          .all<{ id: number; group_id: number | null }>();

  // 收敛后空表（配了 source 但场次被清空）→ 回退全量报名，与「无场次回退全量」同一口径
  const entryRows =
    scopeEntries && (entries.results ?? []).length === 0
      ? await db
          .prepare(`SELECT e.id, e.group_id FROM entry e WHERE e.tournament_id = ?`)
          .bind(stage.tournament_id)
          .all<{ id: number; group_id: number | null }>()
      : entries;

  const allStages = await listStages(db, stage.tournament_id);
  const carry = pickCarrySource(stage.kind, stage.sort_order, stageCfg.carry, allStages.results ?? []);
  // 源阶段的带入基数：同一轮级联重建里，源阶段可能刚被算过但还没提交（语句在 batch 之后才生效），
  // 所以优先用本轮内存里的结果，读库只作为兜底 —— 否则下游会带上改分前的旧值。
  const carriedByEntry = carry
    ? applyCarry(
        computedTotals?.get(carry.fromStageId) ?? (await readStageTotals(db, carry.fromStageId)),
        carry.multiplier
      )
    : new Map<number, CarriedEntry>();
  const deducts = await readStageDeducts(db, stageId);

  const finished = await db
    .prepare(
      `SELECT home_entry_id, away_entry_id, score_home, score_away, pen_home, pen_away, walkover_side
       FROM match WHERE stage_id = ? AND status = 'finished'`
    )
    .bind(stageId)
    .all<FinishedMatchRow>();

  type Row = {
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
  const rows = new Map<number, Row>();
  for (const e of entryRows.results ?? []) {
    rows.set(e.id, {
      group_id: e.group_id,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      pts: 0,
      gf: 0,
      ga: 0,
      pen_won: 0,
      pen_lost: 0,
    });
  }

  for (const m of finished.results ?? []) {
    if (m.home_entry_id == null || m.away_entry_id == null) continue;
    const home = rows.get(m.home_entry_id);
    const away = rows.get(m.away_entry_id);
    if (!home || !away) continue;
    const sh = m.score_home ?? 0;
    const sa = m.score_away ?? 0;
    home.played++;
    away.played++;
    // 双弃权：双方各记一场负、0 分，进失球不计（不给第三方刷净胜球空间）
    if (m.walkover_side === "both") {
      home.lost++;
      away.lost++;
      continue;
    }
    home.gf += sh;
    home.ga += sa;
    away.gf += sa;
    away.ga += sh;
    if (sh > sa) {
      home.won++;
      home.pts += 3;
      away.lost++;
    } else if (sh < sa) {
      away.won++;
      away.pts += 3;
      home.lost++;
    } else if (m.pen_home != null && m.pen_away != null && m.pen_home !== m.pen_away) {
      // 平分点球决胜：仍是平局（胜平负记平），点胜 2 分、点负 1 分
      home.drawn++;
      away.drawn++;
      if (m.pen_home > m.pen_away) {
        home.pen_won++;
        home.pts += 2;
        away.pen_lost++;
        away.pts += 1;
      } else {
        away.pen_won++;
        away.pts += 2;
        home.pen_lost++;
        home.pts += 1;
      }
    } else {
      home.drawn++;
      home.pts += 1;
      away.drawn++;
      away.pts += 1;
    }
  }

  const totals = new Map<number, StageTotals>();
  const stmts: D1PreparedStatement[] = [
    db.prepare("DELETE FROM standing WHERE stage_id = ?").bind(stageId),
    ...[...rows.entries()].map(([entryId, r]) => {
      const carried = carriedByEntry.get(entryId);
      const carriedPts = carried?.pts ?? 0;
      // record 模式：场次列叠加源阶段战绩（总战绩口径）；points 模式只看本阶段
      const rec = carry?.mode === "record" && carried ? carried : ZERO_RECORD;
      const deduct = deducts.get(entryId) ?? 0;
      // 落库的分 = 本阶段得分 + 带入分 − 本阶段命中扣分；带入基数是上游这个值（不是「未扣分总分」），
      // 所以上面算一遍、写库和给下游的都用它，两者不会走岔
      const pts = r.pts + carriedPts - deduct;
      // 供本轮下游阶段直接引用：raw 取落库的那个分值（含带入、已扣扣分），与读库口径一致
      totals.set(entryId, {
        raw: pts,
        played: r.played + rec.played,
        won: r.won + rec.won,
        drawn: r.drawn + rec.drawn,
        lost: r.lost + rec.lost,
        gf: r.gf + rec.gf,
        ga: r.ga + rec.ga,
      });
      return db
        .prepare(
          `INSERT INTO standing (stage_id, group_id, entry_id, played, won, drawn, lost, pts, gf, ga, pen_won, pen_lost, carried_pts, deduct_pts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          stageId,
          r.group_id,
          entryId,
          r.played + rec.played,
          r.won + rec.won,
          r.drawn + rec.drawn,
          r.lost + rec.lost,
          pts,
          r.gf + rec.gf,
          r.ga + rec.ga,
          r.pen_won,
          r.pen_lost,
          carriedPts,
          deduct
        );
    }),
  ];
  return { stmts, totals };
}

// ---------- 级联重建：受影响的阶段 + 所有排在其后的积分阶段 ----------
// 带入分与「从上游取人」都只允许引用排在前面的阶段，所以下游必在后方 —— 顺着 config 找引用反而会
// 漏掉「缺省取上一阶段」这种隐式依赖，不如按 sort_order 把后面全部重算（阶段数很小，重建是幂等的）。
// 不重算下游的后果：源阶段改分/改判后，下游榜里留着按旧分算出的带入分。
//
// 按 sort_order 顺序算：同一条链上的下游用本轮已算出的上游基数（computedTotals），
// 而不是库里的旧值 —— 语句要等 batch 提交才生效，光靠读库会慢一拍。
//
// 写路径统一入口：stageIds 给受影响的阶段（null = 全赛事扣分 → 全部积分阶段）；
// stageId 对应 buildStandingsChainStmts 的「本阶段 + 下游」。
//
// 重算条件：该阶段已经算过榜，或已经有完赛场次（首场报分后的第一次建榜）。
// 两个都不满足的阶段跳过 —— 没开打又没算过榜的阶段不该因为删场次/改扣分凭空冒出一张全 0 的表。
export async function buildStandingsForStagesStmts(
  db: D1Database,
  tournamentId: number,
  stageIds: (number | null)[]
): Promise<D1PreparedStatement[]> {
  const res = await db
    .prepare(
      `SELECT s.id, s.sort_order,
              (SELECT COUNT(*) FROM standing x WHERE x.stage_id = s.id) AS has_rows,
              (SELECT COUNT(*) FROM match m WHERE m.stage_id = s.id AND m.status = 'finished') AS has_finished
       FROM stage s
       WHERE s.tournament_id = ? AND s.kind != 'elim'
       ORDER BY s.sort_order`
    )
    .bind(tournamentId)
    .all<{ id: number; sort_order: number; has_rows: number; has_finished: number }>();
  const stages = res.results ?? [];
  if (stages.length === 0) return [];
  const orderOf = new Map(stages.map((s) => [s.id, s.sort_order]));
  const allAffected = stageIds.some((id) => id == null);
  const targets = allAffected
    ? stages
    : stages.filter((s) =>
        stageIds.some((id) => {
          const from = id == null ? undefined : orderOf.get(id);
          return from != null && s.sort_order >= from;
        })
      );
  const out: D1PreparedStatement[] = [];
  const computedTotals = new Map<number, Map<number, StageTotals>>();
  for (const s of targets) {
    if (s.has_rows === 0 && s.has_finished === 0) continue;
    const done = await computeStageStandings(db, s.id, computedTotals);
    if (!done) continue;
    computedTotals.set(s.id, done.totals);
    out.push(...done.stmts);
  }
  return out;
}

export async function buildStandingsChainStmts(
  db: D1Database,
  stageId: number
): Promise<D1PreparedStatement[]> {
  const st = await db
    .prepare("SELECT tournament_id FROM stage WHERE id = ?")
    .bind(stageId)
    .first<{ tournament_id: number }>();
  if (!st) return [];
  return buildStandingsForStagesStmts(db, st.tournament_id, [stageId]);
}

// ---------- 晋级器：把已决出的轮次胜者填进下一轮 slot ----------
// 仅淘汰阶段；幂等：pending 的下游场反复重填；需要换人但场已开打 → AdvancerError。
type MatchRow = {
  id: number;
  round: number;
  slot: number;
  leg: number | null;
  home_entry_id: number | null;
  away_entry_id: number | null;
  score_home: number | null;
  score_away: number | null;
  pen_home: number | null;
  pen_away: number | null;
  status: "pending" | "live" | "finished";
  winner_entry_id: number | null;
  note: string | null;
};

export class AdvancerError extends Error {}

export async function buildAdvanceStmts(
  db: D1Database,
  stageId: number
): Promise<D1PreparedStatement[]> {
  const res = await db
    .prepare(
      `SELECT id, round, slot, leg, home_entry_id, away_entry_id, score_home, score_away,
              pen_home, pen_away, status, winner_entry_id, note
       FROM match WHERE stage_id = ? ORDER BY round, slot, leg`
    )
    .bind(stageId)
    .all<MatchRow>();
  const all = res.results ?? [];
  if (all.length === 0) return [];

  const byRS = new Map<string, MatchRow[]>();
  let maxRound = 0;
  for (const m of all) {
    const key = `${m.round}:${m.slot}`;
    if (!byRS.has(key)) byRS.set(key, []);
    byRS.get(key)!.push(m);
    if (m.round > maxRound) maxRound = m.round;
  }

  // slot 是否已决出（该 slot 全部场次 finished，或轮空 winner 预填）
  const slotWinner = (round: number, slot: number): number | undefined => {
    const rows = byRS.get(`${round}:${slot}`);
    if (!rows || rows.length === 0) return undefined;
    if (rows.length === 1) {
      const r = rows[0];
      // 轮空场：pending 但 winner 已预填（away 为虚拟位）
      if (r.away_entry_id == null && r.winner_entry_id != null) return r.winner_entry_id;
      if (r.status !== "finished") return undefined;
      if (r.winner_entry_id != null) return r.winner_entry_id;
      if (r.pen_home != null && r.pen_away != null && r.pen_home !== r.pen_away)
        return r.pen_home > r.pen_away
          ? r.home_entry_id ?? undefined
          : r.away_entry_id ?? undefined;
      return undefined;
    }
    // legs=2：总比分（leg2 主客互换），平 → leg2 点球
    const agg = aggTwoLegs(rows);
    if (!agg) return undefined;
    if (agg.a !== agg.b)
      return agg.a > agg.b ? agg.aId ?? undefined : agg.bId ?? undefined;
    if (agg.aPen != null && agg.bPen != null && agg.aPen !== agg.bPen)
      return agg.aPen > agg.bPen ? agg.aId ?? undefined : agg.bId ?? undefined;
    return undefined;
  };

  const slotLoser = (round: number, slot: number): number | undefined => {
    const w = slotWinner(round, slot);
    if (w === undefined) return undefined;
    const rows = byRS.get(`${round}:${slot}`);
    if (!rows) return undefined;
    const ids = new Set<number>();
    for (const r of rows) {
      if (r.home_entry_id != null) ids.add(r.home_entry_id);
      if (r.away_entry_id != null) ids.add(r.away_entry_id);
    }
    ids.delete(w);
    return [...ids][0];
  };

  // A = leg1 主队 = leg2 客队；点球踢在 leg2，A 的点球数是 leg2 客队栏
  const aggTwoLegs = (rows: MatchRow[]) => {
    const leg1 = rows.find((r) => r.leg !== 2) ?? rows[0];
    const leg2 = rows.find((r) => r.leg === 2) ?? rows[1];
    if (!leg1 || !leg2 || leg1 === leg2) return null;
    if (
      leg1.home_entry_id == null ||
      leg1.away_entry_id == null ||
      leg2.home_entry_id == null ||
      leg2.away_entry_id == null
    )
      return null;
    const aId = leg1.home_entry_id;
    const bId = leg1.away_entry_id;
    if (leg2.away_entry_id !== aId || leg2.home_entry_id !== bId) return null;
    return {
      a: (leg1.score_home ?? 0) + (leg2.score_away ?? 0),
      b: (leg1.score_away ?? 0) + (leg2.score_home ?? 0),
      aId,
      bId,
      aPen: leg2.pen_away,
      bPen: leg2.pen_home,
    };
  };

  const updates: D1PreparedStatement[] = [];
  const fill = (matchId: number, home: number, away: number) => {
    updates.push(
      db
        .prepare("UPDATE match SET home_entry_id = ?, away_entry_id = ? WHERE id = ?")
        .bind(home, away, matchId)
    );
  };

  for (let r = 1; r < maxRound; r++) {
    const nextSlots = [...byRS.keys()]
      .filter((k) => k.startsWith(`${r + 1}:`))
      .map((k) => Number(k.split(":")[1]));
    if (nextSlots.length === 0) continue;
    for (const slot of nextSlots) {
      const w1 = slotWinner(r, slot * 2 - 1);
      const w2 = slotWinner(r, slot * 2);
      if (w1 === undefined || w2 === undefined) continue;
      const targets = byRS.get(`${r + 1}:${slot}`) ?? [];
      for (const t of targets) {
        const first = t.leg !== 2;
        const home = first ? w1 : w2;
        const away = first ? w2 : w1;
        if (t.status !== "pending") {
          if (t.home_entry_id !== home || t.away_entry_id !== away) {
            throw new AdvancerError("后续场次已开打，晋级对阵无法更新");
          }
          continue;
        }
        if (t.home_entry_id !== home || t.away_entry_id !== away) {
          fill(t.id, home, away);
        }
      }
    }
  }

  // 季军赛：决赛轮（maxRound）note='季军赛' 的场，参赛者 = 决赛前一轮的两位负者
  for (const m of all) {
    if (m.note !== "季军赛" || m.round !== maxRound) continue;
    const l1 = slotLoser(maxRound - 1, 1);
    const l2 = slotLoser(maxRound - 1, 2);
    if (l1 === undefined || l2 === undefined) continue;
    if (m.status !== "pending") {
      if (m.home_entry_id !== l1 || m.away_entry_id !== l2) {
        throw new AdvancerError("季军赛已开打，对阵无法更新");
      }
      continue;
    }
    if (m.home_entry_id !== l1 || m.away_entry_id !== l2) {
      fill(m.id, l1, l2);
    }
  }

  return updates;
}

// ---------- 积分榜读取：排序 = 积分 → 净胜球 → 进球 → 相互战绩 ----------
// 管理端与公开页共用。standing 表存重算结果，这里只做排序，不写库。
export type StandRow = {
  entryId: number;
  teamName: string;
  teamLogoUrl: string | null;
  groupId: number | null;
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
  /** 本阶段命中的扣分合计（阶段级 + 全赛事），已从 pts 扣掉 */
  pointsDeducted: number;
  /** 从上游阶段带入的分（已含在 pts 里）；不带入时为 0 */
  carriedPts: number;
  rank: number;
};

export async function readStandings(
  db: D1Database,
  stageId: number,
  chain?: TiebreakerKey[]
): Promise<StandRow[]> {
  const res = await db
    .prepare(
      `SELECT s.entry_id, e.team_id, e.seed, e.group_id, t.name AS team_name, t.logo_key,
              s.played, s.won, s.drawn, s.lost,
              s.gf, s.ga, s.pen_won, s.pen_lost, s.pts, s.deduct_pts, s.carried_pts,
              st.kind AS stage_kind
       FROM standing s
       JOIN entry e ON e.id = s.entry_id
       JOIN team t ON t.id = e.team_id
       JOIN stage st ON st.id = s.stage_id
       WHERE s.stage_id = ?`
    )
    .bind(stageId)
    .all<{
      entry_id: number;
      seed: number;
      group_id: number | null;
      team_name: string;
      logo_key: string | null;
      played: number;
      won: number;
      drawn: number;
      lost: number;
      gf: number;
      ga: number;
      pen_won: number;
      pen_lost: number;
      pts: number;
      deduct_pts: number;
      carried_pts: number;
      stage_kind: string;
    }>();
  const rows: StandRow[] = (res.results ?? []).map((r) => ({
    entryId: r.entry_id,
    teamName: r.team_name,
    teamLogoUrl: mediaUrl(r.logo_key),
    groupId: r.group_id,
    seed: r.seed,
    played: r.played,
    won: r.won,
    drawn: r.drawn,
    lost: r.lost,
    goalsFor: r.gf,
    goalsAgainst: r.ga,
    penWon: r.pen_won,
    penLost: r.pen_lost,
    pts: r.pts,
    pointsDeducted: r.deduct_pts,
    carriedPts: r.carried_pts,
    rank: 0,
  }));
  if (rows.length === 0) return [];
  // 同一 stage_id 的行必然同阶段，kind 取第一行即可
  const stageKind = res.results![0].stage_kind;

  // 相互战绩数据：该 stage 全部完赛场次（块内小循环重排时用）
  const finished = await db
    .prepare(
      `SELECT home_entry_id, away_entry_id, score_home, score_away, pen_home, pen_away, walkover_side
       FROM match WHERE stage_id = ? AND status = 'finished'
         AND home_entry_id IS NOT NULL AND away_entry_id IS NOT NULL AND COALESCE(note, '') != '轮空'`
    )
    .bind(stageId)
    .all<FinishedMatchRow>();
  const finishedRows = finished.results ?? [];

  // 分桶策略按阶段类型决定（缺陷 D3）：standing.group_id 对所有阶段都复制 entry.group_id
  // （抽签写入），只有 group 阶段它是合法的分桶键；其余阶段（round_robin）必须整表单桶，
  // 否则循环赛榜单会被上一阶段残留的 group_id 切成多块、名次重复 1,1,1,2,2,2。
  // group 阶段桶内编号语义不能动：takeRangePool（schedule.ts）与小组出线器都按桶内名次取人。
  if (stageKind === "group") {
    const byGroup = new Map<number | null, StandRow[]>();
    for (const r of rows) {
      const key = r.groupId ?? 0;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key)!.push(r);
    }
    const out: StandRow[] = [];
    for (const list of byGroup.values()) {
      sortStandRows(list, chain ?? DEFAULT_TIEBREAKERS, finishedRows);
      out.push(...list);
    }
    return out;
  }
  sortStandRows(rows, chain ?? DEFAULT_TIEBREAKERS, finishedRows);
  return rows;
}

// ---------- 同分规则（可配置决胜链）----------
// 积分永远第一；之后按链顺序比较（gd=净胜球、gf=进球数、h2h=相互战绩）；
// 链上各项全相同时按报名种子位（seed 升序）兜底。
// h2h 只在"其余项全同"的并列块内做小循环重排（积分/净胜，点球决胜按点胜 2 / 点负 1）。
export const DEFAULT_TIEBREAKERS: TiebreakerKey[] = ["gd", "gf", "h2h"];

// 「不启用任何同分规则」的存储哨兵：PATCH 全选「不启用」时落库为 ["none"]。
// 排序层永不接触哨兵——读侧一律经 effectiveTiebreakers 映射为空链（积分 → 种子位）。
const NONE_SENTINEL = "none";

// 存储形态：合法链 | 哨兵。空数组/全非法值回退默认链（缺陷 D4：不再退化为空链）。
export type StoredTiebreakers = TiebreakerKey[] | ["none"];

export function normalizeTiebreakers(v: unknown): StoredTiebreakers {
  if (!Array.isArray(v)) return DEFAULT_TIEBREAKERS;
  const out: TiebreakerKey[] = [];
  for (const x of v) {
    if ((x === "gd" || x === "gf" || x === "h2h") && !out.includes(x)) out.push(x);
  }
  if (out.length === 0) {
    return v.includes(NONE_SENTINEL) ? ["none"] : DEFAULT_TIEBREAKERS;
  }
  return out.slice(0, 3);
}

// 读侧口径：哨兵 → 空链；排序（sortStandRows 对空链 = 积分 → 种子位）与展示共用
export function effectiveTiebreakers(v: unknown): TiebreakerKey[] {
  const chain = normalizeTiebreakers(v);
  if (chain.length === 1 && chain[0] === NONE_SENTINEL) return [];
  // 排除哨兵后剩余形态即合法链（normalizeTiebreakers 不会产出含 "none" 的混合数组）
  return chain as TiebreakerKey[];
}

export function tiebreakersFromConfigJson(configJson: string | null): TiebreakerKey[] {
  let cfg: { tiebreakers?: unknown } = {};
  try {
    cfg = (JSON.parse(configJson || "{}") ?? {}) as { tiebreakers?: unknown };
  } catch {
    return DEFAULT_TIEBREAKERS;
  }
  return effectiveTiebreakers(cfg.tiebreakers);
}

// 读赛事的同分规则配置；缺省回退默认链；哨兵 ["none"] → 空链（仅积分 → 种子位）
export async function getTiebreakers(
  db: D1Database,
  tid: number
): Promise<TiebreakerKey[]> {
  const t = await db
    .prepare("SELECT config_json FROM tournament WHERE id = ?")
    .bind(tid)
    .first<{ config_json: string | null }>();
  if (!t) return DEFAULT_TIEBREAKERS;
  return tiebreakersFromConfigJson(t.config_json);
}

export function sortStandRows(
  rows: StandRow[],
  chain: TiebreakerKey[],
  finishedRows: FinishedMatchRow[]
): void {
  const nonH2h = chain.filter((t) => t !== "h2h");
  const val = (r: StandRow, t: "gd" | "gf") =>
    t === "gd" ? r.goalsFor - r.goalsAgainst : r.goalsFor;
  const blockKey = (r: StandRow) =>
    `${r.pts}|${nonH2h.map((t) => val(r, t)).join("|")}`;

  rows.sort((a, b) => {
    if (a.pts !== b.pts) return b.pts - a.pts;
    for (const t of nonH2h) {
      const va = val(a, t);
      const vb = val(b, t);
      if (va !== vb) return vb - va;
    }
    return a.seed - b.seed;
  });

  if (chain.includes("h2h")) {
    let i = 0;
    while (i < rows.length) {
      let j = i + 1;
      while (j < rows.length && blockKey(rows[j]) === blockKey(rows[i])) j++;
      if (j - i > 1) {
        const ids = new Set(rows.slice(i, j).map((r) => r.entryId));
        const h2h = new Map<number, { pts: number; gd: number }>();
        const bump = (id: number, p: number, g: number) => {
          const cur = h2h.get(id) ?? { pts: 0, gd: 0 };
          cur.pts += p;
          cur.gd += g;
          h2h.set(id, cur);
        };
        for (const m of finishedRows) {
          if (m.home_entry_id == null || m.away_entry_id == null) continue;
          if (!ids.has(m.home_entry_id) || !ids.has(m.away_entry_id)) continue;
          // 双弃权：双方各记负、无分无净胜（等效跳过，但不给平局分）
          if (m.walkover_side === "both") {
            bump(m.home_entry_id, 0, 0);
            bump(m.away_entry_id, 0, 0);
            continue;
          }
          const hs = m.score_home ?? 0;
          const as = m.score_away ?? 0;
          if (hs > as) {
            bump(m.home_entry_id, 3, hs - as);
            bump(m.away_entry_id, 0, as - hs);
          } else if (hs < as) {
            bump(m.home_entry_id, 0, hs - as);
            bump(m.away_entry_id, 3, as - hs);
          } else if (m.pen_home != null && m.pen_away != null && m.pen_home !== m.pen_away) {
            if (m.pen_home > m.pen_away) {
              bump(m.home_entry_id, 2, 0);
              bump(m.away_entry_id, 1, 0);
            } else {
              bump(m.home_entry_id, 1, 0);
              bump(m.away_entry_id, 2, 0);
            }
          } else {
            bump(m.home_entry_id, 1, 0);
            bump(m.away_entry_id, 1, 0);
          }
        }
        const block = rows.slice(i, j).sort(
          (a, b) =>
            (h2h.get(b.entryId)?.pts ?? 0) - (h2h.get(a.entryId)?.pts ?? 0) ||
            (h2h.get(b.entryId)?.gd ?? 0) - (h2h.get(a.entryId)?.gd ?? 0) ||
            a.seed - b.seed
        );
        for (let k = 0; k < block.length; k++) rows[i + k] = block[k];
      }
      i = j;
    }
  }
  rows.forEach((r, idx) => (r.rank = idx + 1));
}

// ---------- 积分榜读取（admin 与公开页共用）----------
// 小组/循环阶段各生成一份；小组按组表 sort_order 分块，循环赛单组。
export async function readStageStandings(
  db: D1Database,
  tournamentId: number
): Promise<StageStandingDTO[]> {
  // 阶段清单与破同分规则互不依赖，并行发
  const [stages, chain] = await Promise.all([
    db
      .prepare(
        `SELECT id, kind, name, sort_order, config_json FROM stage
         WHERE tournament_id = ? AND kind != 'elim' ORDER BY sort_order`
      )
      .bind(tournamentId)
      .all<{
        id: number;
        kind: "group" | "round_robin";
        name: string | null;
        sort_order: number;
        config_json: string | null;
      }>(),
    getTiebreakers(db, tournamentId),
  ]);

  const stageRows = stages.results ?? [];
  const stageById = new Map<number, StageLite>(
    stageRows.map((s): [number, StageLite] => [s.id, s])
  );

  // 各阶段并行计算：原先逐阶段串行等往返（2 阶段 = 8 连击），大陆高 RTT 下最差读路径
  const computed = await Promise.all(
    stageRows.map(async (st) => {
      const rows = await readStandings(db, st.id, chain);
      if (rows.length === 0) return null;
      // 带入说明只作为榜单脚注下发（计算早已落在 standing.carried_pts 里）
      const resolved = pickCarrySource(
        st.kind,
        st.sort_order,
        parseStageConfigJson(st.config_json).carry,
        stageRows
      );
      const carry = resolved
        ? {
            mode: resolved.mode,
            multiplier: resolved.multiplier,
            fromStageId: resolved.fromStageId,
            fromStageName: stageDisplayName(stageById.get(resolved.fromStageId)),
          }
        : null;
      let groups: StandingGroupDTO[];
      if (st.kind === "group") {
        const gRes = await db
          .prepare(`SELECT id, name FROM "group" WHERE stage_id = ? ORDER BY sort_order, id`)
          .bind(st.id)
          .all<{ id: number; name: string }>();
        const gname = new Map(gRes.results.map((g) => [g.id, g.name]));
        const byGroup = new Map<number | null, StandingGroupDTO>();
        for (const r of rows) {
          if (!byGroup.has(r.groupId)) {
            byGroup.set(r.groupId, {
              groupId: r.groupId,
              name: r.groupId != null ? (gname.get(r.groupId) ?? "") : "",
              rows: [],
            });
          }
          byGroup.get(r.groupId)!.rows.push(r);
        }
        const order = new Map(gRes.results.map((g, i) => [g.id, i]));
        groups = [...byGroup.values()].sort(
          (a, b) => (order.get(a.groupId ?? -1) ?? 99) - (order.get(b.groupId ?? -1) ?? 99)
        );
      } else {
        groups = [{ groupId: null, name: "", rows }];
      }
      return { stageId: st.id, kind: st.kind, name: st.name, sortOrder: st.sort_order, groups, carry } satisfies StageStandingDTO;
    })
  );
  return computed.filter((s): s is StageStandingDTO => s !== null);
}

// 阶段显示名兜底（与前端 stageTitle 同一口径）：管理员改过名就用改过的
export function stageDisplayName(st?: Pick<StageLite, "kind" | "name">): string {
  if (!st) return "";
  if (st.name) return st.name;
  return st.kind === "group" ? "小组赛" : "循环赛";
}
