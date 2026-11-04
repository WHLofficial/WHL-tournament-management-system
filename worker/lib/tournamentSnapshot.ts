// 赛事归档快照（payload v2，设计 §8）：把「这届赛事里出现过的球员待过哪些参赛队」冻结下来。
//
// 为什么归档要另存一份：球员会继续转会、球队会改名，归档页如果还按实时口径算，
// 历史赛事的榜单队名会随时间漂移。快照只在归档瞬间写一次，之后只读。
//
// 「待过」= 参赛队 ∩（履历区间与赛事时间窗有交集 ∪ 该队在这届赛事里有过他的事件）。
// 后半句是兜底：同步延迟、回填缺口、历史脏数据都可能让履历少了某一段，而事件是实打实发生过的。

export interface SnapshotTeam {
  teamId: number;
  teamName: string;
}

export interface SnapshotPlayer {
  playerId: number;
  playerName: string;
  teams: SnapshotTeam[];
}

export interface SnapshotPayload {
  v: 2;
  players: SnapshotPlayer[];
  teams: SnapshotTeam[];
}

/**
 * 该赛事有比赛事件（进球/助攻/牌/伤停）的球员里，履历还没回填过的人数。
 * 归档前置检查用：>0 时拒绝归档，避免快照把「同步延迟」冻成永久错误。
 */
export async function countUnsyncedPlayers(db: D1Database, tournamentId: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM player p
       WHERE p.history_synced_at IS NULL
         AND p.id IN (
           SELECT me.player_id FROM match_event me
           JOIN match m ON m.id = me.match_id
           JOIN stage s ON s.id = m.stage_id
           WHERE s.tournament_id = ? AND me.player_id IS NOT NULL
           UNION
           SELECT me.assist_player_id FROM match_event me
           JOIN match m ON m.id = me.match_id
           JOIN stage s ON s.id = m.stage_id
           WHERE s.tournament_id = ? AND me.assist_player_id IS NOT NULL
         )`
    )
    .bind(tournamentId, tournamentId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** 构建快照 payload。失败抛错，调用方据此拒绝归档（快照不能半截写进去）。 */
export async function buildSnapshot(
  db: D1Database,
  tournamentId: number,
  now = new Date().toISOString()
): Promise<SnapshotPayload> {
  const t = await db
    .prepare("SELECT created_at FROM tournament WHERE id = ?")
    .bind(tournamentId)
    .first<{ created_at: string }>();
  if (!t) throw new Error("赛事不存在");

  const entries = await db
    .prepare(
      `SELECT e.id AS entry_id, e.team_id, t.name AS team_name
       FROM entry e JOIN team t ON t.id = e.team_id
       WHERE e.tournament_id = ?
       ORDER BY e.id`
    )
    .bind(tournamentId)
    .all<{ entry_id: number; team_id: number; team_name: string }>();
  const entryRows = entries.results ?? [];
  if (entryRows.length === 0) throw new Error("赛事还没有参赛队");
  const teamNames = new Map(entryRows.map((r) => [r.team_id, r.team_name]));

  // 时间窗：第一场已完赛 → 最后一场已完赛；一场没打完退化为建赛 → 归档时刻。
  // 不用 created_at 当常规起点：报名期/筹备期的转会不该算「本届期间待过」。
  const win = await db
    .prepare(
      `SELECT MIN(m.finished_at) AS first_at, MAX(m.finished_at) AS last_at
       FROM match m JOIN stage s ON s.id = m.stage_id
       WHERE s.tournament_id = ? AND m.status = 'finished' AND m.finished_at IS NOT NULL`
    )
    .bind(tournamentId)
    .first<{ first_at: string | null; last_at: string | null }>();
  const start = win?.first_at ?? t.created_at;
  const end = win?.last_at ?? now;

  const players = await db
    .prepare(
      `SELECT DISTINCT pid FROM (
         SELECT me.player_id AS pid FROM match_event me
         JOIN match m ON m.id = me.match_id
         JOIN stage s ON s.id = m.stage_id
         WHERE s.tournament_id = ? AND me.player_id IS NOT NULL
         UNION
         SELECT me.assist_player_id AS pid FROM match_event me
         JOIN match m ON m.id = me.match_id
         JOIN stage s ON s.id = m.stage_id
         WHERE s.tournament_id = ? AND me.assist_player_id IS NOT NULL
       ) ORDER BY pid`
    )
    .bind(tournamentId, tournamentId)
    .all<{ pid: number }>();
  const playerIds = (players.results ?? []).map((r) => r.pid);

  const outPlayers: SnapshotPlayer[] = [];
  for (const playerId of playerIds) {
    const p = await db
      .prepare("SELECT name FROM player WHERE id = ?")
      .bind(playerId)
      .first<{ name: string }>();
    // 球员行理论上不会缺（事件外键挂着）；缺了就跳过，不让归档整体失败
    if (!p) continue;

    // 履历里与赛事时间窗有交集的参赛队：joined_at <= end 且 (未关窗 或 left_at >= start)
    const hist = await db
      .prepare(
        `SELECT h.team_id, MIN(h.joined_at) AS joined_at
         FROM player_team_history h
         WHERE h.player_id = ?
           AND h.joined_at <= ?
           AND (h.left_at IS NULL OR h.left_at >= ?)
         GROUP BY h.team_id`
      )
      .bind(playerId, end, start)
      .all<{ team_id: number; joined_at: string }>();

    // 该球员在这届赛事里留下过事件的队（兜底履历缺口）
    const eventTeams = await db
      .prepare(
        `SELECT e.team_id, MIN(me.created_at) AS first_at
         FROM match_event me
         JOIN match m ON m.id = me.match_id
         JOIN stage s ON s.id = m.stage_id
         JOIN entry e ON e.id = me.entry_id
         WHERE s.tournament_id = ? AND (me.player_id = ? OR me.assist_player_id = ?)
         GROUP BY e.team_id`
      )
      .bind(tournamentId, playerId, playerId)
      .all<{ team_id: number; first_at: string }>();

    const firstSeen = new Map<number, string>();
    const seen = (teamId: number, at: string) => {
      if (!teamNames.has(teamId)) return; // 只保留参赛队（并集后仍按参赛队过滤）
      const cur = firstSeen.get(teamId);
      if (cur === undefined || at < cur) firstSeen.set(teamId, at);
    };
    for (const h of hist.results ?? []) seen(h.team_id, h.joined_at);
    for (const e of eventTeams.results ?? []) seen(e.team_id, e.first_at);

    const teams = [...firstSeen.entries()]
      .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] - b[0]))
      .map(([teamId]) => ({ teamId, teamName: teamNames.get(teamId)! }));
    outPlayers.push({ playerId, playerName: p.name, teams });
  }

  return {
    v: 2,
    players: outPlayers,
    teams: entryRows.map((r) => ({ teamId: r.team_id, teamName: r.team_name })),
  };
}

/** 读快照；没有 / 损坏 / 版本不对都返回 null，调用方回退实时口径（不抛错） */
export async function loadSnapshot(db: D1Database, tournamentId: number): Promise<SnapshotPayload | null> {
  const row = await db
    .prepare("SELECT payload_json FROM tournament_snapshot WHERE tournament_id = ?")
    .bind(tournamentId)
    .first<{ payload_json: string }>();
  if (!row) return null;
  try {
    const p = JSON.parse(row.payload_json) as SnapshotPayload;
    if (p?.v !== 2 || !Array.isArray(p.players) || !Array.isArray(p.teams)) return null;
    return p;
  } catch {
    return null;
  }
}
