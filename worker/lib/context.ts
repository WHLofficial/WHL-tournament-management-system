// #13 头版门户：赛事语境公共计算——战报背景段与快讯叙事层共用同一套事实采集，
// 保证「战报和快讯说的是同一种联赛语言」。
// 「赛前值」口径 = 当前 standing 表值减去本场贡献后按 积分→净胜→进球→种子位 重排；
// 叙事文案不承担 h2h 决胜链完全体，同分边界差一位不影响故事正确性。
import { readStandings } from "./standings";
import type { StandRow } from "./standings";
import { mediaUrl } from "./media";
import { getSuspensionConfig } from "./suspension";
import type { MatchEventType } from "../../shared/types";
import { elimRoundName } from "../../shared/rounds";

export interface FinishedMatch {
  id: number;
  stageId: number;
  tournamentId: number;
  tournamentName: string;
  stageKind: "elim" | "round_robin" | "group";
  stageName: string | null;
  round: number;
  homeEntryId: number;
  awayEntryId: number;
  homeTeamName: string;
  awayTeamName: string;
  homeLogoUrl: string | null;
  awayLogoUrl: string | null;
  scoreHome: number;
  scoreAway: number;
  penHome: number | null;
  penAway: number | null;
  walkoverSide: string; // '' | home | away | both
  note: string | null;
  status: "pending" | "live" | "finished";
  finishedAt: string | null;
}

const FINISHED_COLS = `SELECT m.id, m.stage_id, s.tournament_id, t.name AS tournament_name,
   s.kind AS stage_kind, s.name AS stage_name, m.round,
   m.home_entry_id, m.away_entry_id,
   ht.name AS home_team_name, at.name AS away_team_name,
   ht.logo_key AS home_logo_key, at.logo_key AS away_logo_key,
   m.score_home, m.score_away, m.pen_home, m.pen_away,
   m.walkover_side, m.note, m.status, m.finished_at`;

const FINISHED_FROM = `FROM match m
   JOIN stage s ON s.id = m.stage_id
   JOIN tournament t ON t.id = s.tournament_id
   JOIN entry he ON he.id = m.home_entry_id
   JOIN team ht ON ht.id = he.team_id
   JOIN entry ae ON ae.id = m.away_entry_id
   JOIN team at ON at.id = ae.team_id`;

type FinishedRow = {
  id: number; stage_id: number; tournament_id: number; tournament_name: string;
  stage_kind: "elim" | "round_robin" | "group"; stage_name: string | null; round: number;
  home_entry_id: number; away_entry_id: number;
  home_team_name: string; away_team_name: string;
  home_logo_key: string | null; away_logo_key: string | null;
  score_home: number; score_away: number;
  pen_home: number | null; pen_away: number | null;
  walkover_side: string | null; note: string | null;
  status: "pending" | "live" | "finished"; finished_at: string | null;
};

function toFinished(r: FinishedRow): FinishedMatch {
  return {
    id: r.id,
    stageId: r.stage_id,
    tournamentId: r.tournament_id,
    tournamentName: r.tournament_name,
    stageKind: r.stage_kind,
    stageName: r.stage_name,
    round: r.round,
    homeEntryId: r.home_entry_id,
    awayEntryId: r.away_entry_id,
    homeTeamName: r.home_team_name,
    awayTeamName: r.away_team_name,
    homeLogoUrl: mediaUrl(r.home_logo_key),
    awayLogoUrl: mediaUrl(r.away_logo_key),
    scoreHome: r.score_home,
    scoreAway: r.score_away,
    penHome: r.pen_home,
    penAway: r.pen_away,
    walkoverSide: r.walkover_side ?? "",
    note: r.note,
    status: r.status,
    finishedAt: r.finished_at,
  };
}

// 跨赛事最近完赛窗口（feed 橱窗原料）。before 为游标（ISO UTC 字符串可字典序比较）。
export async function fetchFinishedWindow(
  db: D1Database,
  limit: number,
  before?: string
): Promise<FinishedMatch[]> {
  const sql = `${FINISHED_COLS} ${FINISHED_FROM}
     WHERE t.status != 'draft' AND m.status = 'finished'
       ${before ? "AND m.finished_at < ?" : ""}
     ORDER BY m.finished_at DESC, m.id DESC LIMIT ?`;
  const res = before
    ? await db.prepare(sql).bind(before, limit).all<FinishedRow>()
    : await db.prepare(sql).bind(limit).all<FinishedRow>();
  return (res.results ?? []).map(toFinished);
}

// 单赛事全部完赛（升序）：streak / h2h / 轮次完赛判定的原料。轮空场排除。
export async function fetchTournamentFinished(
  db: D1Database,
  tid: number
): Promise<FinishedMatch[]> {
  const res = await db
    .prepare(
      `${FINISHED_COLS} ${FINISHED_FROM}
       WHERE s.tournament_id = ? AND m.status = 'finished' AND COALESCE(m.note, '') != '轮空'
       ORDER BY m.finished_at ASC, m.id ASC`
    )
    .bind(tid)
    .all<FinishedRow>();
  return (res.results ?? []).map(toFinished);
}

// 单场任意状态读取（战报只对 finished 出文，判定在调用方）
export async function fetchMatchById(db: D1Database, mid: number): Promise<FinishedMatch | null> {
  const row = await db
    .prepare(`${FINISHED_COLS} ${FINISHED_FROM} WHERE m.id = ?`)
    .bind(mid)
    .first<FinishedRow>();
  return row ? toFinished(row) : null;
}

// 某轮的完赛场（升序）：轮次综述的原料
export async function fetchRoundFinished(
  db: D1Database,
  stageId: number,
  round: number,
): Promise<FinishedMatch[]> {
  const res = await db
    .prepare(
      `${FINISHED_COLS} ${FINISHED_FROM}
       WHERE m.stage_id = ? AND m.round = ? AND m.status = 'finished'
       ORDER BY m.finished_at ASC, m.id ASC`,
    )
    .bind(stageId, round)
    .all<FinishedRow>();
  return (res.results ?? []).map(toFinished);
}

// h2h：两 entry 在本赛事的完赛交锋（升序，不含轮空）
export async function fetchH2H(
  db: D1Database,
  tid: number,
  entryA: number,
  entryB: number
): Promise<FinishedMatch[]> {
  const all = await fetchTournamentFinished(db, tid);
  return all.filter(
    (m) =>
      m.id !== undefined &&
      ((m.homeEntryId === entryA && m.awayEntryId === entryB) ||
        (m.homeEntryId === entryB && m.awayEntryId === entryA))
  );
}

// ---------- 事件采集（带名字与 player_id，战报/快讯/周报共用） ----------

export interface RawEvent {
  id: number;
  matchId: number;
  type: MatchEventType;
  minute: number | null;
  entryId: number | null;
  playerId: number | null;
  playerName: string | null;
  assistPlayerId: number | null;
  assistName: string | null;
  createdAt: string;
}

// 批量取多场事件（D1 bind 上限 100，按 90 一批拆分并行，照 fetchPublicEvents 模式）
export async function fetchEventRows(
  db: D1Database,
  matchIds: number[]
): Promise<Map<number, RawEvent[]>> {
  const ids = [...new Set(matchIds)];
  const byMatch = new Map<number, RawEvent[]>();
  if (ids.length === 0) return byMatch;
  type Row = {
    id: number; match_id: number; type: MatchEventType; minute: number | null;
    entry_id: number | null; player_id: number | null;
    player_name: string | null; assist_player_id: number | null; assist_name: string | null; created_at: string;
  };
  const queries: Promise<D1Result<Row>>[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    queries.push(
      db
        .prepare(
          `SELECT me.id, me.match_id, me.type, me.minute, me.entry_id, me.player_id,
             p.name AS player_name, ap.id AS assist_player_id, ap.name AS assist_name, me.created_at
           FROM match_event me
           LEFT JOIN player p ON p.id = me.player_id
           LEFT JOIN player ap ON ap.id = me.assist_player_id
           WHERE me.match_id IN (${chunk.map(() => "?").join(",")})
           ORDER BY me.match_id, COALESCE(me.minute, -1), me.id`
        )
        .bind(...chunk)
        .all<Row>(),
    );
  }
  for (const res of await Promise.all(queries)) {
    for (const r of res.results ?? []) {
      const list = byMatch.get(r.match_id) ?? [];
      list.push({
        id: r.id,
        matchId: r.match_id,
        type: r.type,
        minute: r.minute,
        entryId: r.entry_id,
        playerId: r.player_id,
        playerName: r.player_name,
        assistPlayerId: r.assist_player_id,
        assistName: r.assist_name,
        createdAt: r.created_at,
      });
      byMatch.set(r.match_id, list);
    }
  }
  return byMatch;
}

// ---------- 积分榜快照（赛后=standing 表现值，赛前=减本场贡献重排） ----------

export interface StandingSnap {
  rows: StandRow[];
  byEntry: Map<number, StandRow>;
  leader: StandRow | null;
}

export async function standingsSnapshot(db: D1Database, stageId: number): Promise<StandingSnap | null> {
  const rows = await readStandings(db, stageId);
  if (rows.length === 0) return null; // 淘汰赛无积分榜
  const byEntry = new Map(rows.map((r) => [r.entryId, r]));
  return { rows, byEntry, leader: rows.find((r) => r.rank === 1) ?? rows[0] };
}

// 简化决胜链排序（积分→净胜→进球→种子位）并赋 rank；叙事口径专用（不承担 h2h 链与扣分）
export function rankRowsSimple(rows: StandRow[]): void {
  rows.sort(
    (a, b) =>
      b.pts - a.pts ||
      (b.goalsFor - b.goalsAgainst) - (a.goalsFor - a.goalsAgainst) ||
      b.goalsFor - a.goalsFor ||
      a.seed - b.seed,
  );
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });
}

// 从行集中就地扣除一场比赛的贡献。与 buildStandingsStmts 的加法严格互逆：
// 双弃权各记负不计球；平分点球决胜 = 点胜 2 分/点负 1 分且不动胜负平计数。
// 任一队不在行集中时返回 false，调用方视为无法回溯。
export function subtractMatchContribution(rows: StandRow[], m: FinishedMatch): boolean {
  const home = rows.find((r) => r.entryId === m.homeEntryId);
  const away = rows.find((r) => r.entryId === m.awayEntryId);
  if (!home || !away) return false;
  const sh = m.scoreHome;
  const sa = m.scoreAway;
  home.played -= 1;
  away.played -= 1;
  if (m.walkoverSide === "both") {
    home.lost -= 1;
    away.lost -= 1;
    return true;
  }
  home.goalsFor -= sh;
  home.goalsAgainst -= sa;
  away.goalsFor -= sa;
  away.goalsAgainst -= sh;
  if (sh > sa) {
    home.won -= 1;
    home.pts -= 3;
    away.lost -= 1;
  } else if (sh < sa) {
    away.won -= 1;
    away.pts -= 3;
    home.lost -= 1;
  } else if (m.penHome != null && m.penAway != null && m.penHome !== m.penAway) {
    if (m.penHome > m.penAway) {
      home.pts -= 2;
      home.penWon -= 1;
      away.pts -= 1;
      away.penLost -= 1;
    } else {
      away.pts -= 2;
      away.penWon -= 1;
      home.pts -= 1;
      home.penLost -= 1;
    }
  } else {
    home.drawn -= 1;
    home.pts -= 1;
    away.drawn -= 1;
    away.pts -= 1;
  }
  return true;
}

// 赛前快照：把本场贡献从当前值里减掉再重排。双弃权=各记负 0 分不计球（照 #10 口径）。
export function standingsBefore(snap: StandingSnap, m: FinishedMatch): StandingSnap | null {
  const rows = snap.rows.map((r) => ({ ...r }));
  if (!subtractMatchContribution(rows, m)) return null;
  rankRowsSimple(rows);
  const byEntry = new Map(rows.map((r) => [r.entryId, r]));
  return { rows, byEntry, leader: rows[0] };
}

// ---------- 球队近况（streak 叙事的原料） ----------

export interface TeamStreaks {
  win: number; // 当前连胜
  cleanSheet: number; // 当前连续零封（弃权场不奖励也不清账——直接打断）
  unbeaten: number; // 当前不败
}

export function currentStreaks(matchesAsc: FinishedMatch[], entryId: number): TeamStreaks {
  let win = 0, cs = 0, ub = 0;
  let winBroken = false, csBroken = false, ubBroken = false;
  for (let i = matchesAsc.length - 1; i >= 0 && !(winBroken && csBroken && ubBroken); i--) {
    const m = matchesAsc[i];
    if (m.homeEntryId !== entryId && m.awayEntryId !== entryId) continue;
    const both = m.walkoverSide === "both";
    const isHome = m.homeEntryId === entryId;
    const gf = isHome ? m.scoreHome : m.scoreAway;
    const ga = isHome ? m.scoreAway : m.scoreHome;
    const won = !both && gf > ga;
    const drawn = !both && gf === ga;
    if (!winBroken) {
      if (won) win += 1;
      else winBroken = true;
    }
    if (!csBroken) {
      // 弃权场不奖励零封（与周报聚合口径一致）：无论谁弃权都打断连续零封
      if (m.walkoverSide === "" && ga === 0) cs += 1;
      else csBroken = true;
    }
    if (!ubBroken) {
      if (won || drawn) ub += 1;
      else ubBroken = true;
    }
  }
  return { win, cleanSheet: cs, unbeaten: ub };
}

// ---------- 射手榜（里程碑/射手榜易主原料） ----------

export interface ScorerTotal {
  playerId: number;
  name: string;
  teamName: string;
  goals: number;
}

export async function fetchScorerTotals(db: D1Database, tid: number): Promise<ScorerTotal[]> {
  const res = await db
    .prepare(
      `SELECT me.player_id, p.name, tm.name AS team_name, COUNT(*) AS goals
       FROM match_event me
       JOIN match m ON m.id = me.match_id
       JOIN stage s ON s.id = m.stage_id
       JOIN player p ON p.id = me.player_id
       JOIN entry e ON e.id = me.entry_id
       JOIN team tm ON tm.id = e.team_id
       WHERE s.tournament_id = ? AND me.type IN ('goal', 'pen_goal') AND me.player_id IS NOT NULL
       GROUP BY me.player_id
       ORDER BY goals DESC, p.name ASC`
    )
    .bind(tid)
    .all<{ player_id: number; name: string; team_name: string; goals: number }>();
  return (res.results ?? []).map((r) => ({
    playerId: r.player_id,
    name: r.name,
    teamName: r.team_name,
    goals: r.goals,
  }));
}

// 赛前射手榜：把某场贡献的进球从总数里减掉（total 减到 0 的球员移出榜单）
export function scorersBefore(
  totals: ScorerTotal[],
  matchGoals: { playerId: number }[]
): ScorerTotal[] {
  const minus = new Map<number, number>();
  for (const g of matchGoals) minus.set(g.playerId, (minus.get(g.playerId) ?? 0) + 1);
  return totals
    .map((t) => {
      const d = minus.get(t.playerId) ?? 0;
      return d > 0 ? { ...t, goals: t.goals - d } : t;
    })
    .filter((t) => t.goals > 0)
    .sort((a, b) => b.goals - a.goals || a.name.localeCompare(b.name, "zh"));
}

export function rankOf(list: ScorerTotal[], playerId: number): number {
  const idx = list.findIndex((t) => t.playerId === playerId);
  return idx === -1 ? 0 : idx + 1;
}

// ---------- 文案工具 ----------

const CN = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

export function cnum(n: number): string {
  if (n <= 10) return CN[n] ?? String(n);
  if (n < 20) return `十${CN[n - 10]}`;
  return String(n);
}

// 「9 月 6 日」（UTC 日期口径；终场时间为服务器记录时刻，确定性优先）
export function cnDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
}

// 轮次文案：淘汰赛用轮次名，小组/循环用第 N 轮；阶段有自定义名时前置
export function roundLabel(
  m: Pick<FinishedMatch, "stageKind" | "stageName" | "round">,
  maxRound: number,
): string {
  const stage = m.stageName?.trim() || "";
  if (m.stageKind === "elim") {
    const r = elimRoundName(m.round, maxRound);
    return stage ? `${stage}·${r}` : r;
  }
  if (m.stageKind === "group") return `${stage || "小组赛"}第 ${m.round} 轮`;
  return stage ? `${stage}·第 ${m.round} 轮` : `第 ${m.round} 轮`;
}

// 各阶段最大轮数（淘汰赛轮次名依赖总轮数），一次分组查询
export async function fetchStageMaxRounds(
  db: D1Database,
  stageIds: number[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const ids = [...new Set(stageIds)];
  if (ids.length === 0) return out;
  const res = await db
    .prepare(
      `SELECT stage_id, MAX(round) AS mr FROM match
       WHERE stage_id IN (${ids.map(() => "?").join(",")}) GROUP BY stage_id`
    )
    .bind(...ids)
    .all<{ stage_id: number; mr: number }>();
  for (const r of res.results ?? []) out.set(r.stage_id, r.mr);
  return out;
}

// 红牌停赛文案尾巴（读赛事停赛配置，不硬编码）
export async function redCardBanSuffix(
  db: D1Database,
  tid: number,
  type: "red" | "red_2y",
): Promise<string> {
  const cfg = await getSuspensionConfig(db, tid);
  const ban = type === "red" ? cfg.redBan : cfg.red2yBan;
  return ban > 0 ? `，自动停赛 ${ban} 场` : "";
}
