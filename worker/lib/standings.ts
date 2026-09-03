import type { StageStandingDTO, StandingGroupDTO } from "../../shared/types";
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
};

// ---------- 积分：全量重建某 stage 的 standing ----------
// 胜 3 平 1 负 0；平分且录了点球 → 点胜 2 分 / 点负 1 分（pen_won/pen_lost 计次）。
// 淘汰阶段无积分榜，返回空。
export async function buildStandingsStmts(
  db: D1Database,
  stageId: number
): Promise<D1PreparedStatement[]> {
  const stage = await db
    .prepare("SELECT kind FROM stage WHERE id = ?")
    .bind(stageId)
    .first<{ kind: string }>();
  if (!stage || stage.kind === "elim") return [];

  // 参赛集：小组阶段取挂在本阶段组下的 entry；无分组循环取赛事全部报名
  const entries =
    stage.kind === "group"
      ? await db
          .prepare(
            `SELECT e.id, e.group_id FROM entry e
             WHERE e.group_id IN (SELECT id FROM "group" WHERE stage_id = ?)`
          )
          .bind(stageId)
          .all<{ id: number; group_id: number | null }>()
      : await db
          .prepare(
            `SELECT e.id, e.group_id FROM entry e
             WHERE e.tournament_id = (SELECT tournament_id FROM stage WHERE id = ?)`
          )
          .bind(stageId)
          .all<{ id: number; group_id: number | null }>();

  const finished = await db
    .prepare(
      `SELECT home_entry_id, away_entry_id, score_home, score_away, pen_home, pen_away
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
  for (const e of entries.results ?? []) {
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
      // 平分点球决胜：点胜 2 分、点负 1 分
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

  return [
    db.prepare("DELETE FROM standing WHERE stage_id = ?").bind(stageId),
    ...[...rows.entries()].map(([entryId, r]) =>
      db
        .prepare(
          `INSERT INTO standing (stage_id, group_id, entry_id, played, won, drawn, lost, pts, gf, ga, pen_won, pen_lost)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          stageId,
          r.group_id,
          entryId,
          r.played,
          r.won,
          r.drawn,
          r.lost,
          r.pts,
          r.gf,
          r.ga,
          r.pen_won,
          r.pen_lost
        )
    ),
  ];
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
  rank: number;
};

export async function readStandings(
  db: D1Database,
  stageId: number
): Promise<StandRow[]> {
  const res = await db
    .prepare(
      `SELECT s.entry_id, e.team_id, e.seed, e.group_id, t.name AS team_name,
              s.played, s.won, s.drawn, s.lost,
              s.gf, s.ga, s.pen_won, s.pen_lost, s.pts
       FROM standing s
       JOIN entry e ON e.id = s.entry_id
       JOIN team t ON t.id = e.team_id
       WHERE s.stage_id = ?`
    )
    .bind(stageId)
    .all<{
      entry_id: number;
      seed: number;
      group_id: number | null;
      team_name: string;
      played: number;
      won: number;
      drawn: number;
      lost: number;
      gf: number;
      ga: number;
      pen_won: number;
      pen_lost: number;
      pts: number;
    }>();
  const rows: StandRow[] = (res.results ?? []).map((r) => ({
    entryId: r.entry_id,
    teamName: r.team_name,
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
    rank: 0,
  }));
  if (rows.length === 0) return [];

  // 相互战绩：该 stage 全部完赛场次的每队小循环积分/净胜
  const finished = await db
    .prepare(
      `SELECT home_entry_id, away_entry_id, score_home, score_away, pen_home, pen_away
       FROM match WHERE stage_id = ? AND status = 'finished'
         AND home_entry_id IS NOT NULL AND away_entry_id IS NOT NULL AND note != '轮空'`
    )
    .bind(stageId)
    .all<FinishedMatchRow>();
  const finishedRows = finished.results ?? [];
  const h2h = new Map<number, { pts: number; gd: number }>();
  const bump = (id: number, pts: number, gd: number) => {
    const cur = h2h.get(id) ?? { pts: 0, gd: 0 };
    cur.pts += pts;
    cur.gd += gd;
    h2h.set(id, cur);
  };
  const addPair = (m: FinishedMatchRow, ids: Set<number>) => {
    if (m.home_entry_id == null || m.away_entry_id == null) return;
    if (!ids.has(m.home_entry_id) || !ids.has(m.away_entry_id)) return;
    const hs = m.score_home ?? 0;
    const as = m.score_away ?? 0;
    if (hs > as) {
      bump(m.home_entry_id, 3, hs - as);
      bump(m.away_entry_id, 0, as - hs);
    } else if (hs < as) {
      bump(m.home_entry_id, 0, hs - as);
      bump(m.away_entry_id, 3, as - hs);
    } else if (m.pen_home != null && m.pen_away != null && m.pen_home !== m.pen_away) {
      // 点球决胜：小循环按点胜 2 / 点负 1 计
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
  };

  // 分组内排序；组内再按"前三项完全相同"切块，块内用相互战绩微调
  const byGroup = new Map<number | null, StandRow[]>();
  for (const r of rows) {
    const key = r.group_id ?? 0;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key)!.push(r);
  }
  const out: StandRow[] = [];
  for (const list of byGroup.values()) {
    list.sort(
      (a, b) =>
        b.pts - a.pts ||
        b.goalsFor - b.goalsAgainst - (a.goalsFor - a.goalsAgainst) ||
        b.goalsFor - a.goalsFor ||
        a.seed - b.seed
    );
    // 并列块（pts/gd/gf 全同）内做 h2h 重排
    let i = 0;
    while (i < list.length) {
      let j = i + 1;
      const key = (r: StandRow) => `${r.pts}|${r.goalsFor - r.goalsAgainst}|${r.goalsFor}`;
      while (j < list.length && key(list[j]) === key(list[i])) j++;
      if (j - i > 1) {
        const ids = new Set(list.slice(i, j).map((r) => r.entryId));
        h2h.clear();
        for (const m of finishedRows) addPair(m, ids);
        const block = list.slice(i, j).sort(
          (a, b) =>
            (h2h.get(b.entryId)?.pts ?? 0) - (h2h.get(a.entryId)?.pts ?? 0) ||
            (h2h.get(b.entryId)?.gd ?? 0) - (h2h.get(a.entryId)?.gd ?? 0) ||
            a.seed - b.seed
        );
        for (let k = 0; k < block.length; k++) list[i + k] = block[k];
      }
      i = j;
    }
    list.forEach((r, idx) => (r.rank = idx + 1));
    out.push(...list);
  }
  return out;
}

// ---------- 积分榜读取（admin 与公开页共用）----------
// 小组/循环阶段各生成一份；小组按组表 sort_order 分块，循环赛单组。
export async function readStageStandings(
  db: D1Database,
  tournamentId: number
): Promise<StageStandingDTO[]> {
  const stages = await db
    .prepare(
      `SELECT id, kind, sort_order FROM stage
       WHERE tournament_id = ? AND kind != 'elim' ORDER BY sort_order`
    )
    .bind(tournamentId)
    .all<{ id: number; kind: "group" | "round_robin"; sort_order: number }>();

  const standings: StageStandingDTO[] = [];
  for (const st of stages.results ?? []) {
    const rows = await readStandings(db, st.id);
    if (rows.length === 0) continue;
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
    standings.push({ stageId: st.id, kind: st.kind, sortOrder: st.sort_order, groups });
  }
  return standings;
}
