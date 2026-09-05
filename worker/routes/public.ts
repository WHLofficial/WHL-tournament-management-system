import { Hono } from "hono";
import type { AppEnv } from "../env";
import type {
  EntryDTO,
  MatchDTO,
  LiveDTO,
  PublicMatchEventDTO,
  RecentDTO,
  TournamentDTO,
  UpcomingDTO,
} from "../../shared/types";
import { readStageStandings } from "../lib/standings";
import { buildStats, buildToplists } from "../lib/topstats";
import { mediaUrl } from "../lib/media";

// 公开页接口：无登录墙，游客可看。draft（草稿）赛事不对外——列表不含、详情按 404 处理。
const app = new Hono<AppEnv>();

app.get("/tournaments", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT t.id, t.name, t.description, t.format, t.status, t.created_at, t.cover_key,
       (SELECT COUNT(*) FROM entry e WHERE e.tournament_id = t.id) AS entry_count
     FROM tournament t
     WHERE t.status != 'draft'
     ORDER BY CASE t.status WHEN 'running' THEN 0 WHEN 'registering' THEN 1 ELSE 2 END,
       t.created_at DESC`
  ).all<{
    id: number;
    name: string;
    description: string | null;
    format: TournamentDTO["format"];
    status: TournamentDTO["status"];
    created_at: string;
    entry_count: number;
    cover_key: string | null;
  }>();
  const tournaments: TournamentDTO[] = rows.results.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    format: r.format,
    status: r.status,
    createdAt: r.created_at,
    entryCount: r.entry_count,
    coverUrl: mediaUrl(r.cover_key),
  }));
  return c.json({ tournaments });
});

app.get("/tournaments/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const t = await c.env.DB.prepare(
    `SELECT t.id, t.name, t.description, t.format, t.status, t.created_at, t.cover_key,
       (SELECT COUNT(*) FROM entry e WHERE e.tournament_id = t.id) AS entry_count
     FROM tournament t WHERE t.id = ? AND t.status != 'draft'`
  )
    .bind(id)
    .first<{
      id: number;
      name: string;
      description: string | null;
      format: TournamentDTO["format"];
      status: TournamentDTO["status"];
      created_at: string;
      entry_count: number;
      cover_key: string | null;
    }>();
  if (!t) return c.json({ message: "赛事不存在或未发布" }, 404);

  const [stages, groups, entries] = await Promise.all([
    c.env.DB.prepare(
      "SELECT id, kind, sort_order, config_json FROM stage WHERE tournament_id = ? ORDER BY sort_order"
    )
      .bind(id)
      .all<{ id: number; kind: "elim" | "round_robin" | "group"; sort_order: number; config_json: string }>(),
    c.env.DB.prepare(
      `SELECT g.id, g.stage_id, g.name, g.sort_order FROM "group" g
       JOIN stage s ON s.id = g.stage_id WHERE s.tournament_id = ?
       ORDER BY s.sort_order, g.sort_order`
    )
      .bind(id)
      .all<{ id: number; stage_id: number; name: string; sort_order: number }>(),
    c.env.DB.prepare(
      `SELECT e.id, e.team_id, e.seed, e.group_id, e.points_deducted, tm.name AS team_name, tm.logo_key,
         (SELECT COUNT(*) FROM player p WHERE p.team_id = e.team_id) AS player_count
       FROM entry e JOIN team tm ON tm.id = e.team_id
       WHERE e.tournament_id = ? ORDER BY e.seed`
    )
      .bind(id)
      .all<{
        id: number;
        team_id: number;
        seed: number;
        group_id: number | null;
        points_deducted: number;
        team_name: string;
        logo_key: string | null;
        player_count: number;
      }>(),
  ]);

  return c.json({
    tournament: {
      id: t.id,
      name: t.name,
      description: t.description,
      format: t.format,
      status: t.status,
      createdAt: t.created_at,
      entryCount: t.entry_count,
      coverUrl: mediaUrl(t.cover_key),
    } satisfies TournamentDTO,
    stages: stages.results.map((s) => ({
      id: s.id,
      kind: s.kind,
      sortOrder: s.sort_order,
      config: JSON.parse(s.config_json || "{}"),
    })),
    groups: groups.results.map((g) => ({
      id: g.id,
      stageId: g.stage_id,
      name: g.name,
      sortOrder: g.sort_order,
    })),
    entries: entries.results.map(
      (e): EntryDTO => ({
        id: e.id,
        teamId: e.team_id,
        teamName: e.team_name,
        seed: e.seed,
        groupId: e.group_id,
        playerCount: e.player_count,
        pointsDeducted: e.points_deducted,
        teamLogoUrl: mediaUrl(e.logo_key),
      })
    ),
  });
});

// 赛程对阵（含 live 比分的事件覆盖），与 admin 端同构
// 公共事件视图：不暴露内部 id，side 标主/客，射手/助攻带名字。
// side 按「场+entry」判——同一 entry 在不同场次主客不同，不能用全局 entryId 映射。
// 跨赛事复用（/live、/recent）：按 match id 过滤，与赛事无关
async function fetchPublicEvents(
  db: D1Database,
  matchRows: { id: number; home_entry_id: number | null; away_entry_id: number | null }[],
): Promise<Map<number, PublicMatchEventDTO[]>> {
  const ids = [...new Set(matchRows.map((r) => r.id))];
  const byMatch = new Map<number, PublicMatchEventDTO[]>();
  if (ids.length === 0) return byMatch;
  const sideByEvent = new Map<string, "home" | "away">();
  for (const r of matchRows) {
    if (r.home_entry_id !== null) sideByEvent.set(`${r.id}:${r.home_entry_id}`, "home");
    if (r.away_entry_id !== null) sideByEvent.set(`${r.id}:${r.away_entry_id}`, "away");
  }
  // D1 单条查询 bind 参数上限 100，赛程可能超过 100 场（如 12 队双循环 132 场），按批拆分 IN 查询
  const rows: {
    id: number; match_id: number; type: PublicMatchEventDTO["type"];
    minute: number | null; entry_id: number | null;
    player_name: string | null; assist_player_name: string | null;
  }[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const res = await db
      .prepare(
        `SELECT me.id, me.match_id, me.type, me.minute, me.entry_id,
           p.name AS player_name, ap.name AS assist_player_name
         FROM match_event me
         LEFT JOIN player p ON p.id = me.player_id
         LEFT JOIN player ap ON ap.id = me.assist_player_id
         WHERE me.match_id IN (${chunk.map(() => "?").join(",")})
         ORDER BY me.match_id, COALESCE(me.minute, -1), me.id`
      )
      .bind(...chunk)
      .all<{
        id: number; match_id: number; type: PublicMatchEventDTO["type"];
        minute: number | null; entry_id: number | null;
        player_name: string | null; assist_player_name: string | null;
      }>();
    rows.push(...(res.results ?? []));
  }
  for (const r of rows) {
    const side = r.entry_id !== null ? sideByEvent.get(`${r.match_id}:${r.entry_id}`) : undefined;
    if (!side) continue;
    const list = byMatch.get(r.match_id) ?? [];
    list.push({
      id: r.id,
      type: r.type,
      minute: r.minute,
      side,
      playerName: r.player_name,
      assistPlayerName: r.assist_player_name,
    });
    byMatch.set(r.match_id, list);
  }
  return byMatch;
}

// live 实时比分与管理端 liveScore 同口径：goal/pen_goal 计事件方，own_goal 记到对方。
// sideByEvent：`matchId:entryId` -> home|away，由调用方从当次查询结果构建（禁止模块级可变态，并发会串）
async function fetchLiveScores(
  db: D1Database,
  tid: number,
  sideByEvent: Map<string, "home" | "away">,
): Promise<Map<number, { home: number; away: number }>> {
  const rows = await db
    .prepare(
      `SELECT me.match_id, me.entry_id, me.type, COUNT(*) AS n
       FROM match_event me
       JOIN match m ON m.id = me.match_id
       JOIN stage s ON s.id = m.stage_id
       WHERE s.tournament_id = ? AND m.status = 'live'
       GROUP BY me.match_id, me.entry_id, me.type`
    )
    .bind(tid)
    .all<{ match_id: number; entry_id: number | null; type: string; n: number }>();
  const scores = new Map<number, { home: number; away: number }>();
  for (const r of rows.results ?? []) {
    if (r.entry_id === null) continue;
    const side = sideByEvent.get(`${r.match_id}:${r.entry_id}`);
    if (!side) continue;
    const isHome = side === "home";
    const sc = scores.get(r.match_id) ?? { home: 0, away: 0 };
    const goalsFor = r.type === "goal" || r.type === "pen_goal" ? r.n : 0;
    const ownGoals = r.type === "own_goal" ? r.n : 0;
    // own_goal 是事件所属方球员踢进自家门，记对方得分
    if (isHome) {
      sc.home += goalsFor;
      sc.away += ownGoals;
    } else {
      sc.away += goalsFor;
      sc.home += ownGoals;
    }
    scores.set(r.match_id, sc);
  }
  return scores;
}

app.get("/tournaments/:id/matches", async (c) => {
  const tid = Number(c.req.param("id"));
  const pub = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tournament WHERE id = ? AND status != 'draft'"
  )
    .bind(tid)
    .first<{ n: number }>();
  if (!pub?.n) return c.json({ message: "赛事不存在或未发布" }, 404);

  type MatchRow = {
    id: number; stage_id: number; round: number; slot: number; leg: number | null;
    home_entry_id: number | null; away_entry_id: number | null;
    home_team_name: string | null; away_team_name: string | null;
    home_logo_key: string | null; away_logo_key: string | null;
    score_home: number | null; score_away: number | null;
    pen_home: number | null; pen_away: number | null;
    status: MatchDTO["status"]; winner_entry_id: number | null; note: string | null;
    stage_kind: MatchDTO["stageKind"];
  };
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.stage_id, m.round, m.slot, m.leg,
       m.home_entry_id, m.away_entry_id,
       ht.name AS home_team_name, at.name AS away_team_name,
       ht.logo_key AS home_logo_key, at.logo_key AS away_logo_key,
       m.score_home, m.score_away, m.pen_home, m.pen_away,
       m.status, m.winner_entry_id, m.note, s.kind AS stage_kind
     FROM match m
     JOIN stage s ON s.id = m.stage_id
     LEFT JOIN entry he ON he.id = m.home_entry_id
     LEFT JOIN team ht ON ht.id = he.team_id
     LEFT JOIN entry ae ON ae.id = m.away_entry_id
     LEFT JOIN team at ON at.id = ae.team_id
     WHERE s.tournament_id = ?
     ORDER BY s.sort_order, m.round, m.slot, m.leg`
  )
    .bind(tid)
    .all<MatchRow>();
  const list = rows.results ?? [];

  const sideByEvent = new Map<string, "home" | "away">();
  for (const r of list) {
    if (r.home_entry_id !== null) sideByEvent.set(`${r.id}:${r.home_entry_id}`, "home");
    if (r.away_entry_id !== null) sideByEvent.set(`${r.id}:${r.away_entry_id}`, "away");
  }
  const liveScores =
    list.some((r) => r.status === "live")
      ? await fetchLiveScores(c.env.DB, tid, sideByEvent)
      : new Map<number, { home: number; away: number }>();
  const eventsByMatch = await fetchPublicEvents(c.env.DB, list);

  const matches: MatchDTO[] = list.map((r) => {
    const live = liveScores.get(r.id);
    return {
      id: r.id,
      stageId: r.stage_id,
      round: r.round,
      slot: r.slot,
      leg: r.leg,
      homeEntryId: r.home_entry_id,
      awayEntryId: r.away_entry_id,
      homeTeamName: r.home_team_name,
      awayTeamName: r.away_team_name,
      scoreHome: r.status === "live" ? live?.home ?? 0 : r.score_home,
      scoreAway: r.status === "live" ? live?.away ?? 0 : r.score_away,
      penHome: r.pen_home,
      penAway: r.pen_away,
      status: r.status,
      winnerEntryId: r.winner_entry_id,
      note: r.note,
      events: eventsByMatch.get(r.id) ?? [],
      stageKind: r.stage_kind,
      homeLogoUrl: mediaUrl(r.home_logo_key),
      awayLogoUrl: mediaUrl(r.away_logo_key),
    };
  });
  return c.json({ matches });
});

// 单场详情：公开端比赛页用，结构同赛程接口的元素
app.get("/tournaments/:id/matches/:mid", async (c) => {
  const tid = Number(c.req.param("id"));
  const mid = Number(c.req.param("mid"));
  const pub = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tournament WHERE id = ? AND status != 'draft'"
  )
    .bind(tid)
    .first<{ n: number }>();
  if (!pub?.n) return c.json({ message: "赛事不存在或未发布" }, 404);

  const row = await c.env.DB.prepare(
    `SELECT m.id, m.stage_id, m.round, m.slot, m.leg,
       m.home_entry_id, m.away_entry_id,
       ht.name AS home_team_name, at.name AS away_team_name,
       ht.logo_key AS home_logo_key, at.logo_key AS away_logo_key,
       m.score_home, m.score_away, m.pen_home, m.pen_away,
       m.status, m.winner_entry_id, m.note, s.kind AS stage_kind
     FROM match m
     JOIN stage s ON s.id = m.stage_id
     LEFT JOIN entry he ON he.id = m.home_entry_id
     LEFT JOIN team ht ON ht.id = he.team_id
     LEFT JOIN entry ae ON ae.id = m.away_entry_id
     LEFT JOIN team at ON at.id = ae.team_id
     WHERE s.tournament_id = ? AND m.id = ?`
  )
    .bind(tid, mid)
    .first<{
      id: number; stage_id: number; round: number; slot: number; leg: number | null;
      home_entry_id: number | null; away_entry_id: number | null;
      home_team_name: string | null; away_team_name: string | null;
      home_logo_key: string | null; away_logo_key: string | null;
      score_home: number | null; score_away: number | null;
      pen_home: number | null; pen_away: number | null;
      status: MatchDTO["status"]; winner_entry_id: number | null; note: string | null;
      stage_kind: MatchDTO["stageKind"];
    }>();
  if (!row) return c.json({ message: "比赛不存在" }, 404);

  const sideByEvent = new Map<string, "home" | "away">();
  if (row.home_entry_id !== null) sideByEvent.set(`${row.id}:${row.home_entry_id}`, "home");
  if (row.away_entry_id !== null) sideByEvent.set(`${row.id}:${row.away_entry_id}`, "away");

  const liveScores =
    row.status === "live"
      ? await fetchLiveScores(c.env.DB, tid, sideByEvent)
      : new Map<number, { home: number; away: number }>();
  const eventsByMatch = await fetchPublicEvents(c.env.DB, [row]);
  const live = liveScores.get(row.id);
  const match: MatchDTO = {
    id: row.id,
    stageId: row.stage_id,
    round: row.round,
    slot: row.slot,
    leg: row.leg,
    homeEntryId: row.home_entry_id,
    awayEntryId: row.away_entry_id,
    homeTeamName: row.home_team_name,
    awayTeamName: row.away_team_name,
    scoreHome: row.status === "live" ? live?.home ?? 0 : row.score_home,
    scoreAway: row.status === "live" ? live?.away ?? 0 : row.score_away,
    penHome: row.pen_home,
    penAway: row.pen_away,
    status: row.status,
    winnerEntryId: row.winner_entry_id,
    note: row.note,
    events: eventsByMatch.get(row.id) ?? [],
    stageKind: row.stage_kind,
    homeLogoUrl: mediaUrl(row.home_logo_key),
    awayLogoUrl: mediaUrl(row.away_logo_key),
  };
  return c.json({ match });
});

// 跨赛事"即将进行"：非草稿赛事的未开打场次（排除轮空/队伍待定），running 优先
app.get("/upcoming", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT t.id AS tournament_id, t.name AS tournament_name, t.status AS tournament_status,
       m.id AS match_id, s.kind AS stage_kind, s.sort_order AS stage_order, m.round,
       ht.name AS home_team_name, at.name AS away_team_name
     FROM match m
     JOIN stage s ON s.id = m.stage_id
     JOIN tournament t ON t.id = s.tournament_id
     JOIN entry he ON he.id = m.home_entry_id
     JOIN team ht ON ht.id = he.team_id
     JOIN entry ae ON ae.id = m.away_entry_id
     JOIN team at ON at.id = ae.team_id
     WHERE t.status != 'draft' AND m.status = 'pending'
       AND (m.note IS NULL OR m.note != '轮空')
     ORDER BY CASE t.status WHEN 'running' THEN 0 ELSE 1 END,
       t.id, s.sort_order, m.round, m.slot
     LIMIT 8`
  ).all<{
    tournament_id: number; tournament_name: string; tournament_status: string;
    match_id: number; stage_kind: "elim" | "round_robin" | "group";
    stage_order: number; round: number;
    home_team_name: string; away_team_name: string;
  }>();
  const upcoming: UpcomingDTO[] = (rows.results ?? []).map((r) => ({
    tournamentId: r.tournament_id,
    tournamentName: r.tournament_name,
    matchId: r.match_id,
    stageKind: r.stage_kind,
    stageOrder: r.stage_order,
    round: r.round,
    homeTeamName: r.home_team_name,
    awayTeamName: r.away_team_name,
  }));
  return c.json({ upcoming });
});

// 跨赛事"进行中"：live 场，实时比分与 liveScore 同口径（goal/pen_goal 计事件方，own_goal 记对方）
app.get("/live", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT t.id AS tournament_id, t.name AS tournament_name,
       m.id AS match_id, s.kind AS stage_kind, m.round,
       he.id AS home_entry_id, ae.id AS away_entry_id,
       ht.name AS home_team_name, at.name AS away_team_name
     FROM match m
     JOIN stage s ON s.id = m.stage_id
     JOIN tournament t ON t.id = s.tournament_id
     JOIN entry he ON he.id = m.home_entry_id
     JOIN team ht ON ht.id = he.team_id
     JOIN entry ae ON ae.id = m.away_entry_id
     JOIN team at ON at.id = ae.team_id
     WHERE t.status != 'draft' AND m.status = 'live'
     ORDER BY t.id, s.sort_order, m.round, m.slot`
  ).all<{
    tournament_id: number; tournament_name: string;
    match_id: number; stage_kind: "elim" | "round_robin" | "group"; round: number;
    home_entry_id: number; away_entry_id: number;
    home_team_name: string; away_team_name: string;
  }>();
  const list = rows.results ?? [];

  // 一条聚合查询取全部 live 场的事件计分，再按 entry 归边
  const scores = new Map<number, { home: number; away: number }>();
  const sideByEvent = new Map<string, "home" | "away">();
  for (const r of list) {
    sideByEvent.set(`${r.match_id}:${r.home_entry_id}`, "home");
    sideByEvent.set(`${r.match_id}:${r.away_entry_id}`, "away");
  }
  if (list.length > 0) {
    const ev = await c.env.DB.prepare(
      `SELECT me.match_id, me.entry_id, me.type, COUNT(*) AS n
       FROM match_event me
       JOIN match m ON m.id = me.match_id
       JOIN stage s ON s.id = m.stage_id
       JOIN tournament t ON t.id = s.tournament_id
       WHERE m.status = 'live' AND t.status != 'draft'
       GROUP BY me.match_id, me.entry_id, me.type`
    )
      .all<{ match_id: number; entry_id: number | null; type: string; n: number }>();
    for (const r of ev.results ?? []) {
      if (r.entry_id === null) continue;
      const side = sideByEvent.get(`${r.match_id}:${r.entry_id}`);
      if (!side) continue;
      const sc = scores.get(r.match_id) ?? { home: 0, away: 0 };
      const goalsFor = r.type === "goal" || r.type === "pen_goal" ? r.n : 0;
      const ownGoals = r.type === "own_goal" ? r.n : 0;
      if (side === "home") {
        sc.home += goalsFor;
        sc.away += ownGoals;
      } else {
        sc.away += goalsFor;
        sc.home += ownGoals;
      }
      scores.set(r.match_id, sc);
    }
  }

  const eventsByMatch = await fetchPublicEvents(
    c.env.DB,
    list.map((r) => ({ id: r.match_id, home_entry_id: r.home_entry_id, away_entry_id: r.away_entry_id })),
  );
  const live: LiveDTO[] = list.map((r) => {
    const sc = scores.get(r.match_id) ?? { home: 0, away: 0 };
    return {
      tournamentId: r.tournament_id,
      tournamentName: r.tournament_name,
      matchId: r.match_id,
      stageKind: r.stage_kind,
      round: r.round,
      homeTeamName: r.home_team_name,
      awayTeamName: r.away_team_name,
      scoreHome: sc.home,
      scoreAway: sc.away,
      events: eventsByMatch.get(r.match_id) ?? [],
    };
  });
  return c.json({ live });
});

// 跨赛事"最近进行"：最近完赛的 10 场，按完赛时间倒序（改判刷新时间）
app.get("/recent", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT t.id AS tournament_id, t.name AS tournament_name,
       m.id AS match_id, s.kind AS stage_kind, m.round,
       m.home_entry_id, m.away_entry_id,
       ht.name AS home_team_name, at.name AS away_team_name,
       m.score_home, m.score_away, m.finished_at
     FROM match m
     JOIN stage s ON s.id = m.stage_id
     JOIN tournament t ON t.id = s.tournament_id
     JOIN entry he ON he.id = m.home_entry_id
     JOIN team ht ON ht.id = he.team_id
     JOIN entry ae ON ae.id = m.away_entry_id
     JOIN team at ON at.id = ae.team_id
     WHERE t.status != 'draft' AND m.status = 'finished'
       AND m.score_home IS NOT NULL AND m.score_away IS NOT NULL
     ORDER BY m.finished_at DESC, m.id DESC
     LIMIT 10`
  ).all<{
    tournament_id: number; tournament_name: string;
    match_id: number; stage_kind: "elim" | "round_robin" | "group"; round: number;
    home_entry_id: number | null; away_entry_id: number | null;
    home_team_name: string; away_team_name: string;
    score_home: number; score_away: number; finished_at: string | null;
  }>();
  const list = rows.results ?? [];
  const eventsByMatch = await fetchPublicEvents(
    c.env.DB,
    list.map((r) => ({ id: r.match_id, home_entry_id: r.home_entry_id, away_entry_id: r.away_entry_id })),
  );
  const recent: RecentDTO[] = list.map((r) => ({
    tournamentId: r.tournament_id,
    tournamentName: r.tournament_name,
    matchId: r.match_id,
    stageKind: r.stage_kind,
    round: r.round,
    homeTeamName: r.home_team_name,
    awayTeamName: r.away_team_name,
    scoreHome: r.score_home,
    scoreAway: r.score_away,
    finishedAt: r.finished_at,
    events: eventsByMatch.get(r.match_id) ?? [],
  }));
  return c.json({ recent });
});

app.get("/tournaments/:id/standings", async (c) => {
  const id = Number(c.req.param("id"));
  const t = await c.env.DB.prepare(
    "SELECT id FROM tournament WHERE id = ? AND status != 'draft'"
  )
    .bind(id)
    .first<{ id: number }>();
  if (!t) return c.json({ message: "赛事不存在或未发布" }, 404);
  const standings = await readStageStandings(c.env.DB, id);
  return c.json({ standings });
});

// 榜单（球员榜+球队榜）与数据统计：单赛事内；管理端另有不受草稿限制的同名端点
app.get("/tournaments/:id/toplists", async (c) => {
  const id = Number(c.req.param("id"));
  const t = await c.env.DB.prepare(
    "SELECT id FROM tournament WHERE id = ? AND status != 'draft'"
  )
    .bind(id)
    .first<{ id: number }>();
  if (!t) return c.json({ message: "赛事不存在或未发布" }, 404);
  return c.json(await buildToplists(c.env.DB, id));
});

app.get("/tournaments/:id/stats", async (c) => {
  const id = Number(c.req.param("id"));
  const t = await c.env.DB.prepare(
    "SELECT id FROM tournament WHERE id = ? AND status != 'draft'"
  )
    .bind(id)
    .first<{ id: number }>();
  if (!t) return c.json({ message: "赛事不存在或未发布" }, 404);
  return c.json(await buildStats(c.env.DB, id));
});

export default app;
