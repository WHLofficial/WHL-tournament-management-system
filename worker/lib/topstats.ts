// 单赛事榜单与数据统计：公开页与管理端共用（草稿守卫由调用方决定）。
// 口径：球员榜按事件；球队进球/失球/零封按完赛比分（与积分榜一致）；趣味/趋势按完赛比分。

export interface PlayerRow {
  playerId: number;
  playerName: string;
  teamName: string;
  count: number;
}

export interface CardsPlayerRow {
  playerId: number;
  playerName: string;
  teamName: string;
  yellows: number;
  reds: number;
  /** 当前是否停赛中（两黄变红计入红牌数；黄牌数不含与 red_2y 同场的黄牌） */
  suspended?: boolean;
}

export interface TeamRow {
  teamId: number;
  teamName: string;
  count: number;
}

export interface CardsTeamRow {
  teamId: number;
  teamName: string;
  yellows: number;
  reds: number;
}

export interface Toplists {
  scorers: PlayerRow[];
  assists: PlayerRow[];
  cardsPlayers: CardsPlayerRow[];
  injuries: PlayerRow[];
  teamGoals: TeamRow[];
  teamConceded: TeamRow[];
  cleanSheets: TeamRow[];
  cardsTeams: CardsTeamRow[];
}

export interface MatchHighlight {
  matchId: number;
  homeName: string;
  awayName: string;
  scoreHome: number;
  scoreAway: number;
  stageName: string;
  round: number;
}

export interface Stats {
  progress: { total: number; finished: number; live: number; pending: number };
  goals: { total: number; avg: number; penScored: number; penMissed: number };
  cards: { yellows: number; reds: number };
  biggestMargin: (MatchHighlight & { margin: number }) | null;
  fun: {
    topTeam: { teamId: number; teamName: string; total: number; avg: number } | null;
    bestDefense: { teamId: number; teamName: string; total: number; avg: number } | null;
    maxMatchGoals: { matchId: number; homeName: string; awayName: string; total: number } | null;
    ownGoals: number;
  };
  topMatches: (MatchHighlight & { total: number })[];
  roundTrend: { label: string; goals: number }[];
  injuryMatch: (Omit<MatchHighlight, "scoreHome" | "scoreAway"> & {
    scoreHome: number | null;
    scoreAway: number | null;
    count: number;
  }) | null;
}

interface EventRow {
  match_id: number;
  player_id: number | null;
  assist_player_id: number | null;
  type: string;
  player_name: string | null;
  assist_name: string | null;
  team_id: number;
  team_name: string;
}

interface FinishedRow {
  id: number;
  round: number;
  score_home: number;
  score_away: number;
  home_team_id: number;
  home_team_name: string;
  away_team_id: number;
  away_team_name: string;
  stage_kind: string;
  stage_order: number;
}

const KIND_LABEL: Record<string, string> = {
  elim: "淘汰赛",
  round_robin: "循环赛",
  group: "小组赛",
};

// 阶段显示名：淘汰赛 / 循环赛，多阶段时加（第N阶段）后缀
function stageLabel(kind: string, order: number): string {
  return KIND_LABEL[kind] ?? `第${order}阶段`;
}

interface SideAgg {
  name: string;
  scored: number;
  conceded: number;
  played: number;
  cleanSheets: number;
}

const avg2 = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) / 100 : 0);

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "zh");
const byPlayerName = (a: { playerName: string }, b: { playerName: string }) =>
  a.playerName.localeCompare(b.playerName, "zh");
const byTeamName = (a: { teamName: string }, b: { teamName: string }) =>
  a.teamName.localeCompare(b.teamName, "zh");

const EVENTS_SQL = `
  FROM match_event me
  JOIN match m ON m.id = me.match_id
  JOIN stage s ON s.id = m.stage_id
  WHERE s.tournament_id = ?`;

const FINISHED_SQL = `
  FROM match m
  JOIN stage s ON s.id = m.stage_id
  JOIN entry he ON he.id = m.home_entry_id
  JOIN team ht ON ht.id = he.team_id
  JOIN entry ae ON ae.id = m.away_entry_id
  JOIN team at ON at.id = ae.team_id
  WHERE s.tournament_id = ? AND m.status = 'finished'
    AND m.score_home IS NOT NULL AND m.score_away IS NOT NULL`;

async function fetchEvents(db: D1Database, tid: number) {
  return db
    .prepare(
      `SELECT me.match_id, me.player_id, me.assist_player_id, me.type,
         p.name AS player_name, ap.name AS assist_name,
         t.id AS team_id, t.name AS team_name
       FROM match_event me
       JOIN match m ON m.id = me.match_id
       JOIN stage s ON s.id = m.stage_id
       JOIN entry e ON e.id = me.entry_id
       JOIN team t ON t.id = e.team_id
       LEFT JOIN player p ON p.id = me.player_id
       LEFT JOIN player ap ON ap.id = me.assist_player_id
       WHERE s.tournament_id = ?`
    )
    .bind(tid)
    .all<EventRow>();
}

async function fetchFinished(db: D1Database, tid: number) {
  return db
    .prepare(
      `SELECT m.id, m.round, m.score_home, m.score_away,
         he.team_id AS home_team_id, ht.name AS home_team_name,
         ae.team_id AS away_team_id, at.name AS away_team_name,
         s.kind AS stage_kind, s.sort_order AS stage_order
       ${FINISHED_SQL}
       ORDER BY m.id`
    )
    .bind(tid)
    .all<FinishedRow>();
}

function aggregateSides(rows: FinishedRow[]): Map<number, SideAgg> {
  const sides = new Map<number, SideAgg>();
  const side = (id: number, name: string) =>
    sides.get(id) ?? { name, scored: 0, conceded: 0, played: 0, cleanSheets: 0 };
  for (const r of rows) {
    const h = side(r.home_team_id, r.home_team_name);
    h.scored += r.score_home;
    h.conceded += r.score_away;
    h.played += 1;
    if (r.score_away === 0) h.cleanSheets += 1;
    sides.set(r.home_team_id, h);
    const a = side(r.away_team_id, r.away_team_name);
    a.scored += r.score_away;
    a.conceded += r.score_home;
    a.played += 1;
    if (r.score_home === 0) a.cleanSheets += 1;
    sides.set(r.away_team_id, a);
  }
  return sides;
}

export async function buildToplists(db: D1Database, tid: number): Promise<Toplists> {
  const [ev, fin] = await Promise.all([fetchEvents(db, tid), fetchFinished(db, tid)]);

  interface PlayerBucket {
    name: string;
    teamName: string;
    goals: number;
    assists: number;
    yellows: number;
    reds: number;
    injuries: number;
  }
  interface TeamBucket {
    name: string;
    yellows: number;
    reds: number;
  }
  const players = new Map<number, PlayerBucket>();
  const teams = new Map<number, TeamBucket>();
  const bucket = (id: number, name: string, teamName: string): PlayerBucket =>
    players.get(id) ?? { name, teamName, goals: 0, assists: 0, yellows: 0, reds: 0, injuries: 0 };

  // 两黄变一红口径：red_2y 计 1 张红牌；与 red_2y 同场同球员的黄牌不计入黄牌数
  const twoYellow = new Set<string>();
  for (const r of ev.results ?? []) {
    if (r.type === "red_2y") twoYellow.add(`${r.match_id}:${r.player_id}`);
  }
  const isYellow = (r: EventRow) =>
    r.type === "yellow" && !twoYellow.has(`${r.match_id}:${r.player_id}`);

  for (const r of ev.results ?? []) {
    if (r.player_id !== null && r.player_name !== null) {
      const b = bucket(r.player_id, r.player_name, r.team_name);
      if (r.type === "goal" || r.type === "pen_goal") b.goals += 1;
      else if (isYellow(r)) b.yellows += 1;
      else if (r.type === "red" || r.type === "red_2y") b.reds += 1;
      else if (r.type === "injury_minor" || r.type === "injury_major") b.injuries += 1;
      players.set(r.player_id, b);
    }
    if (r.assist_player_id !== null && r.assist_name !== null) {
      const b = bucket(r.assist_player_id, r.assist_name, r.team_name);
      b.assists += 1;
      players.set(r.assist_player_id, b);
    }
    const tb = teams.get(r.team_id) ?? { name: r.team_name, yellows: 0, reds: 0 };
    if (isYellow(r)) tb.yellows += 1;
    else if (r.type === "red" || r.type === "red_2y") tb.reds += 1;
    teams.set(r.team_id, tb);
  }

  const scorers: PlayerRow[] = [];
  const assists: PlayerRow[] = [];
  const cardsPlayers: CardsPlayerRow[] = [];
  const injuries: PlayerRow[] = [];
  for (const [playerId, b] of players) {
    if (b.goals > 0) scorers.push({ playerId, playerName: b.name, teamName: b.teamName, count: b.goals });
    if (b.assists > 0) assists.push({ playerId, playerName: b.name, teamName: b.teamName, count: b.assists });
    if (b.yellows + b.reds > 0)
      cardsPlayers.push({ playerId, playerName: b.name, teamName: b.teamName, yellows: b.yellows, reds: b.reds });
    if (b.injuries > 0) injuries.push({ playerId, playerName: b.name, teamName: b.teamName, count: b.injuries });
  }
  scorers.sort((a, b) => b.count - a.count || byPlayerName(a, b));
  assists.sort((a, b) => b.count - a.count || byPlayerName(a, b));
  injuries.sort((a, b) => b.count - a.count || byPlayerName(a, b));
  cardsPlayers.sort((a, b) => b.reds - a.reds || b.yellows - a.yellows || byPlayerName(a, b));

  const cardsTeams: CardsTeamRow[] = [...teams]
    .filter(([, b]) => b.yellows + b.reds > 0)
    .map(([teamId, b]) => ({ teamId, teamName: b.name, yellows: b.yellows, reds: b.reds }))
    .sort((a, b) => b.reds - a.reds || b.yellows - a.yellows || byTeamName(a, b));

  // 球队进球/失球/零封按完赛比分（与积分榜口径一致）
  const sides = aggregateSides(fin.results ?? []);
  const teamGoals: TeamRow[] = [];
  const teamConceded: TeamRow[] = [];
  const cleanSheets: TeamRow[] = [];
  for (const [teamId, b] of sides) {
    if (b.played === 0) continue;
    if (b.scored > 0) teamGoals.push({ teamId, teamName: b.name, count: b.scored });
    if (b.conceded > 0) teamConceded.push({ teamId, teamName: b.name, count: b.conceded });
    if (b.cleanSheets > 0) cleanSheets.push({ teamId, teamName: b.name, count: b.cleanSheets });
  }
  teamGoals.sort((a, b) => b.count - a.count || byTeamName(a, b));
  teamConceded.sort((a, b) => a.count - b.count || byTeamName(a, b));
  cleanSheets.sort((a, b) => b.count - a.count || byTeamName(a, b));

  return { scorers, assists, cardsPlayers, injuries, teamGoals, teamConceded, cleanSheets, cardsTeams };
}

export async function buildStats(db: D1Database, tid: number): Promise<Stats> {
  const [statusRows, typeRows, fin, injuryRows, cardRow] = await Promise.all([
    db
      .prepare(
        `SELECT m.status, COUNT(*) AS n FROM match m
         JOIN stage s ON s.id = m.stage_id
         WHERE s.tournament_id = ? GROUP BY m.status`
      )
      .bind(tid)
      .all<{ status: string; n: number }>(),
    db
      .prepare(`SELECT me.type, COUNT(*) AS n ${EVENTS_SQL} GROUP BY me.type`)
      .bind(tid)
      .all<{ type: string; n: number }>(),
    fetchFinished(db, tid),
    db
      .prepare(
        `SELECT me.match_id, COUNT(*) AS n ${EVENTS_SQL}
         AND me.type IN ('injury_minor', 'injury_major')
         GROUP BY me.match_id ORDER BY n DESC, me.match_id ASC LIMIT 1`
      )
      .bind(tid)
      .all<{ match_id: number; n: number }>(),
    // 红黄牌口径与榜单一致：黄牌排除两黄变一场，红牌含 red_2y
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN me.type = 'yellow'
                     AND NOT EXISTS (SELECT 1 FROM match_event r
                                     WHERE r.match_id = me.match_id
                                       AND r.player_id = me.player_id
                                       AND r.type = 'red_2y')
                    THEN 1 ELSE 0 END) AS yellows,
           SUM(CASE WHEN me.type IN ('red', 'red_2y') THEN 1 ELSE 0 END) AS reds
         FROM match_event me
         JOIN match m ON m.id = me.match_id
         JOIN stage s ON s.id = m.stage_id
         WHERE s.tournament_id = ?`
      )
      .bind(tid)
      .first<{ yellows: number | null; reds: number | null }>(),
  ]);

  const progress = { total: 0, finished: 0, live: 0, pending: 0 };
  for (const r of statusRows.results ?? []) {
    progress.total += r.n;
    if (r.status === "finished") progress.finished = r.n;
    else if (r.status === "live") progress.live = r.n;
    else progress.pending += r.n;
  }

  const goals = { total: 0, avg: 0, penScored: 0, penMissed: 0 };
  const cards = { yellows: cardRow?.yellows ?? 0, reds: cardRow?.reds ?? 0 };
  let ownGoals = 0;
  for (const r of typeRows.results ?? []) {
    if (r.type === "goal" || r.type === "pen_goal" || r.type === "own_goal") goals.total += r.n;
    if (r.type === "pen_goal") goals.penScored = r.n;
    else if (r.type === "pen_miss") goals.penMissed = r.n;
    else if (r.type === "own_goal") ownGoals = r.n;
  }
  goals.avg = avg2(goals.total, progress.finished);

  const rows = fin.results ?? [];
  const highlights = rows.map((r) => ({
    matchId: r.id,
    homeName: r.home_team_name,
    awayName: r.away_team_name,
    scoreHome: r.score_home,
    scoreAway: r.score_away,
    stageName: stageLabel(r.stage_kind, r.stage_order),
    round: r.round,
    stageOrder: r.stage_order,
  }));

  let biggestMargin: Stats["biggestMargin"] = null;
  const topMatches: (Stats["topMatches"])[number][] = [];
  const rounds = new Map<string, { order: number; round: number; label: string; goals: number }>();
  for (const h of highlights) {
    const margin = Math.abs(h.scoreHome - h.scoreAway);
    if (!biggestMargin || margin > biggestMargin.margin) biggestMargin = { ...h, margin };
    const total = h.scoreHome + h.scoreAway;
    topMatches.push({ ...h, total });
    const key = `${h.stageOrder}:${h.round}`;
    const b = rounds.get(key) ?? {
      order: h.stageOrder,
      round: h.round,
      label: `${h.stageName} 第${h.round}轮`,
      goals: 0,
    };
    b.goals += total;
    rounds.set(key, b);
  }
  topMatches.sort((a, b) => b.total - a.total || a.matchId - b.matchId);
  topMatches.splice(5);
  const roundTrend = [...rounds.values()]
    .sort((a, b) => a.order - b.order || a.round - b.round)
    .map((b) => ({ label: b.label, goals: b.goals }));

  const ranked = [...aggregateSides(rows).entries()].map(([teamId, b]) => ({
    teamId,
    name: b.name,
    scored: b.scored,
    conceded: b.conceded,
    avgScored: avg2(b.scored, b.played),
    avgConceded: avg2(b.conceded, b.played),
  }));
  const topTeam = ranked.length
    ? [...ranked].sort((a, b) => b.scored - a.scored || b.avgScored - a.avgScored || byName(a, b))[0]
    : null;
  const bestDefense = ranked.length
    ? [...ranked].sort((a, b) => a.conceded - b.conceded || a.avgConceded - b.avgConceded || byName(a, b))[0]
    : null;
  const maxMatch = topMatches.length ? topMatches[0] : null;

  // 刺刀见红：伤病人次最多的一场（live 也可入选，比分可能尚未写入）
  let injuryMatch: Stats["injuryMatch"] = null;
  const inj = injuryRows.results?.[0];
  if (inj) {
    const row = await db
      .prepare(
        `SELECT m.round, m.score_home, m.score_away,
           ht.name AS home_team_name, at.name AS away_team_name,
           s.kind AS stage_kind, s.sort_order AS stage_order
         FROM match m
         JOIN stage s ON s.id = m.stage_id
         JOIN entry he ON he.id = m.home_entry_id
         JOIN team ht ON ht.id = he.team_id
         JOIN entry ae ON ae.id = m.away_entry_id
         JOIN team at ON at.id = ae.team_id
         WHERE m.id = ?`
      )
      .bind(inj.match_id)
      .first<{
        round: number;
        score_home: number | null;
        score_away: number | null;
        home_team_name: string;
        away_team_name: string;
        stage_kind: string;
        stage_order: number;
      }>();
    if (row) {
      injuryMatch = {
        matchId: inj.match_id,
        homeName: row.home_team_name,
        awayName: row.away_team_name,
        scoreHome: row.score_home,
        scoreAway: row.score_away,
        stageName: stageLabel(row.stage_kind, row.stage_order),
        round: row.round,
        count: inj.n,
      };
    }
  }

  return {
    progress,
    goals,
    cards,
    biggestMargin,
    fun: {
      topTeam: topTeam ? { teamId: topTeam.teamId, teamName: topTeam.name, total: topTeam.scored, avg: topTeam.avgScored } : null,
      bestDefense: bestDefense
        ? { teamId: bestDefense.teamId, teamName: bestDefense.name, total: bestDefense.conceded, avg: bestDefense.avgConceded }
        : null,
      maxMatchGoals: maxMatch
        ? { matchId: maxMatch.matchId, homeName: maxMatch.homeName, awayName: maxMatch.awayName, total: maxMatch.total }
        : null,
      ownGoals,
    },
    topMatches,
    roundTrend,
    injuryMatch,
  };
}
