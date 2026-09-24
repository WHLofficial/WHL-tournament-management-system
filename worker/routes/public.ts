import { Hono } from "hono";
import type { AppEnv } from "../env";
import type {
  EntryDTO,
  MatchDTO,
  LiveDTO,
  PublicMatchEventDTO,
  RecentDTO,
  StageRoundsDTO,
  TournamentDTO,
  UpcomingDTO,
  H2HDTO,
  H2HFormItem,
  H2HMeetingDTO,
  LineupStatsDTO,
  TeamTacticsDTO,
  TacticXIPlayerDTO,
} from "../../shared/types";
import { readStageStandings } from "../lib/standings";
import { parseRankZoneSettings } from "../../shared/rankZones";
import { buildStats } from "../lib/topstats";
import { buildToplistsWithSuspension } from "../lib/suspension";
import { listMatchAbsences, listTournamentActiveInjuries } from "../lib/injury";
import { mediaUrl } from "../lib/media";
import { fetchMatchLineup, LineupError, parseSlotsJson } from "../lib/lineup";
import { FORMS } from "../../shared/tactics";
import type { StoredLineupSlot } from "../../shared/types";
import { pubCache } from "../lib/cache";

// 公开页接口：无登录墙，游客可看。draft（草稿）赛事不对外——列表不含、详情按 404 处理。
const app = new Hono<AppEnv>();

// 赛事列表（非草稿）。抽成函数供首页聚合端点 /api/public/home 复用，避免两处口径分叉。
export async function buildTournamentList(db: D1Database): Promise<TournamentDTO[]> {
  const rows = await db.prepare(
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
  return rows.results.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    format: r.format,
    status: r.status,
    createdAt: r.created_at,
    entryCount: r.entry_count,
    coverUrl: mediaUrl(r.cover_key),
  }));
}

app.get("/tournaments", pubCache(300), async (c) => {
  return c.json({ tournaments: await buildTournamentList(c.env.DB) });
});

app.get("/tournaments/:id", pubCache(300), async (c) => {
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
  const chunkQueries: Promise<D1Result<{
    id: number; match_id: number; type: PublicMatchEventDTO["type"];
    minute: number | null; entry_id: number | null;
    player_name: string | null; assist_player_name: string | null;
  }>>[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    chunkQueries.push(
      db
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
        }>(),
    );
  }
  // 批间并行同发，不再逐批串行等往返
  for (const res of await Promise.all(chunkQueries)) rows.push(...(res.results ?? []));
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

// 赛程行共享片段：matches / rounds meta / summary 三端点复用同一查询结构
type PubMatchRow = {
  id: number; stage_id: number; round: number; slot: number; leg: number | null;
  home_entry_id: number | null; away_entry_id: number | null;
  home_team_name: string | null; away_team_name: string | null;
  home_logo_key: string | null; away_logo_key: string | null;
  score_home: number | null; score_away: number | null;
  pen_home: number | null; pen_away: number | null;
  status: MatchDTO["status"]; winner_entry_id: number | null; note: string | null;
  walkover_side: string | null;
  stage_kind: MatchDTO["stageKind"];
  stage_name: string | null; stage_order: number;
};
const MATCH_COLS = `SELECT m.id, m.stage_id, m.round, m.slot, m.leg,
   m.home_entry_id, m.away_entry_id,
   ht.name AS home_team_name, at.name AS away_team_name,
   ht.logo_key AS home_logo_key, at.logo_key AS away_logo_key,
   m.score_home, m.score_away, m.pen_home, m.pen_away,
   m.status, m.winner_entry_id, m.note, m.walkover_side, s.kind AS stage_kind,
   s.name AS stage_name, s.sort_order AS stage_order`;
const MATCH_FROM = `FROM match m
   JOIN stage s ON s.id = m.stage_id
   LEFT JOIN entry he ON he.id = m.home_entry_id
   LEFT JOIN team ht ON ht.id = he.team_id
   LEFT JOIN entry ae ON ae.id = m.away_entry_id
   LEFT JOIN team at ON at.id = ae.team_id`;

const toPubMatch = (
  r: PubMatchRow,
  liveScores: Map<number, { home: number; away: number }>,
  eventsByMatch: Map<number, PublicMatchEventDTO[]>
): MatchDTO => {
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
    walkoverSide: (r.walkover_side || null) as MatchDTO["walkoverSide"],
    events: eventsByMatch.get(r.id) ?? [],
    stageKind: r.stage_kind,
    stageName: r.stage_name,
    homeLogoUrl: mediaUrl(r.home_logo_key),
    awayLogoUrl: mediaUrl(r.away_logo_key),
  };
};

app.get("/tournaments/:id/matches", pubCache(60), async (c) => {
  const tid = Number(c.req.param("id"));
  const pub = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tournament WHERE id = ? AND status != 'draft'"
  )
    .bind(tid)
    .first<{ n: number }>();
  if (!pub?.n) return c.json({ message: "赛事不存在或未发布" }, 404);

  type MatchRow = PubMatchRow;
  // 按需过滤：?stageId=X 单阶段，&round=N 单轮；无参 = 全量（兼容旧调用）
  const qStage = Number(c.req.query("stageId")) || null;
  const qRound = Number(c.req.query("round")) || null;
  const where = ["s.tournament_id = ?"];
  const binds: (number | string)[] = [tid];
  if (qStage) {
    where.push("m.stage_id = ?");
    binds.push(qStage);
  }
  if (qRound) {
    where.push("m.round = ?");
    binds.push(qRound);
  }
  const rows = await c.env.DB.prepare(
    `${MATCH_COLS}
     ${MATCH_FROM}
     WHERE ${where.join(" AND ")}
     ORDER BY s.sort_order, m.round, m.slot, m.leg`
  )
    .bind(...binds)
    .all<MatchRow>();
  const list = rows.results ?? [];

  const sideByEvent = new Map<string, "home" | "away">();
  for (const r of list) {
    if (r.home_entry_id !== null) sideByEvent.set(`${r.id}:${r.home_entry_id}`, "home");
    if (r.away_entry_id !== null) sideByEvent.set(`${r.id}:${r.away_entry_id}`, "away");
  }
  // live 比分与事件查询互不依赖，并行发；无参调用是兼容旧路径（前端全按轮拉取），不再附带全赛事事件大 payload
  const [liveScores, eventsByMatch] = await Promise.all([
    list.some((r) => r.status === "live")
      ? fetchLiveScores(c.env.DB, tid, sideByEvent)
      : Promise.resolve(new Map<number, { home: number; away: number }>()),
    qStage || qRound
      ? fetchPublicEvents(c.env.DB, list)
      : Promise.resolve(new Map<number, PublicMatchEventDTO[]>()),
  ]);

  const matches: MatchDTO[] = list.map((r) => toPubMatch(r, liveScores, eventsByMatch));
  return c.json({ matches });
});

// 轮次元信息：公开页跨阶段统一轮次条的分页依据（必须注册在 /matches/:mid 之前，否则被 :mid 吞掉）
app.get("/tournaments/:id/matches/rounds", pubCache(60), async (c) => {
  const tid = Number(c.req.param("id"));
  const pub = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tournament WHERE id = ? AND status != 'draft'"
  )
    .bind(tid)
    .first<{ n: number }>();
  if (!pub?.n) return c.json({ message: "赛事不存在或未发布" }, 404);

  const rows = await c.env.DB.prepare(
    `SELECT s.id AS stage_id, s.name AS stage_name, s.kind AS stage_kind, s.sort_order AS stage_order,
       m.round AS round,
       COUNT(*) AS count,
       SUM(m.status = 'live') AS live,
       SUM(m.status = 'finished') AS finished,
       SUM(m.status = 'pending') AS pending
     FROM match m
     JOIN stage s ON s.id = m.stage_id
     WHERE s.tournament_id = ?
     GROUP BY s.id, m.round
     ORDER BY s.sort_order, m.round`
  )
    .bind(tid)
    .all<{
      stage_id: number;
      stage_name: string | null;
      stage_kind: StageRoundsDTO["kind"];
      stage_order: number;
      round: number;
      count: number;
      live: number;
      finished: number;
      pending: number;
    }>();
  const stages: StageRoundsDTO[] = [];
  for (const r of rows.results ?? []) {
    let st = stages.find((s) => s.stageId === r.stage_id);
    if (!st) {
      st = {
        stageId: r.stage_id,
        name: r.stage_name,
        kind: r.stage_kind,
        sortOrder: r.stage_order,
        rounds: [],
      };
      stages.push(st);
    }
    st.rounds.push({
      round: r.round,
      count: r.count,
      live: r.live,
      finished: r.finished,
      pending: r.pending,
    });
  }
  return c.json({ stages });
});

// 赛事摘要：分享卡数据源——最近完赛 4 场（带事件）+ 最早待打 4 场（排除轮空与队伍待定）
app.get("/tournaments/:id/matches/summary", pubCache(60), async (c) => {
  const tid = Number(c.req.param("id"));
  const pub = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tournament WHERE id = ? AND status != 'draft'"
  )
    .bind(tid)
    .first<{ n: number }>();
  if (!pub?.n) return c.json({ message: "赛事不存在或未发布" }, 404);

  // 待打 4 场走两段式：先只取 id（match + stage 两表），再只为这 4 场补齐整行。
  // 原版把 21 列与 4 张队名表都 join 进主查询，LIMIT 4 在 join 之后才生效（实测 805 行 → 约 400 行）。
  const [recentRows, upcomingIdRows] = await Promise.all([
    c.env.DB.prepare(
      `${MATCH_COLS}
       ${MATCH_FROM}
       WHERE s.tournament_id = ? AND m.status = 'finished'
       ORDER BY m.finished_at DESC, m.id DESC
       LIMIT 4`
    )
      .bind(tid)
      .all<PubMatchRow>(),
    c.env.DB.prepare(
      `SELECT m.id
       FROM match m
       JOIN stage s ON s.id = m.stage_id
       WHERE s.tournament_id = ? AND m.status = 'pending'
         AND m.home_entry_id IS NOT NULL AND m.away_entry_id IS NOT NULL
       ORDER BY s.sort_order, m.round, m.slot
       LIMIT 4`
    )
      .bind(tid)
      .all<{ id: number }>(),
  ]);
  const recentList = recentRows.results ?? [];
  const upcomingIds = (upcomingIdRows.results ?? []).map((r) => r.id);
  const [upcomingRows, eventsByMatch] = await Promise.all([
    upcomingIds.length
      ? c.env.DB.prepare(
          `${MATCH_COLS}
           ${MATCH_FROM}
           WHERE m.id IN (${upcomingIds.map(() => "?").join(",")})
           ORDER BY s.sort_order, m.round, m.slot`
        )
          .bind(...upcomingIds)
          .all<PubMatchRow>()
      : Promise.resolve({ results: [] as PubMatchRow[] }),
    fetchPublicEvents(c.env.DB, recentList),
  ]);
  const upcomingList = upcomingRows.results ?? [];
  const emptyLive = new Map<number, { home: number; away: number }>();
  return c.json({
    recent: recentList.map((r) => toPubMatch(r, emptyLive, eventsByMatch)),
    upcoming: upcomingList.map((r) => toPubMatch(r, emptyLive, eventsByMatch)),
  });
});

// 单场详情：公开端比赛页用，结构同赛程接口的元素
app.get("/tournaments/:id/matches/:mid", pubCache(60), async (c) => {
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
       he.team_id AS home_team_id, ae.team_id AS away_team_id,
       ht.name AS home_team_name, at.name AS away_team_name,
       ht.logo_key AS home_logo_key, at.logo_key AS away_logo_key,
       m.score_home, m.score_away, m.pen_home, m.pen_away,
       m.status, m.winner_entry_id, m.note, m.walkover_side, s.kind AS stage_kind
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
      home_team_id: number | null; away_team_id: number | null;
      home_team_name: string | null; away_team_name: string | null;
      home_logo_key: string | null; away_logo_key: string | null;
      score_home: number | null; score_away: number | null;
      pen_home: number | null; pen_away: number | null;
      status: MatchDTO["status"]; winner_entry_id: number | null; note: string | null;
      walkover_side: string | null;
      stage_kind: MatchDTO["stageKind"];
    }>();
  if (!row) return c.json({ message: "比赛不存在" }, 404);

  const sideByEvent = new Map<string, "home" | "away">();
  if (row.home_entry_id !== null) sideByEvent.set(`${row.id}:${row.home_entry_id}`, "home");
  if (row.away_entry_id !== null) sideByEvent.set(`${row.id}:${row.away_entry_id}`, "away");

  // live 比分、事件、改判标记、因伤缺阵名单互不依赖，并行发
  const [liveScores, eventsByMatch, rescored, absences] = await Promise.all([
    row.status === "live"
      ? fetchLiveScores(c.env.DB, tid, sideByEvent)
      : Promise.resolve(new Map<number, { home: number; away: number }>()),
    fetchPublicEvents(c.env.DB, [row]),
    c.env.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_log
         WHERE target_type = 'match' AND target_id = ? AND action = 'match_rescore'`
      )
      .bind(row.id)
      .first<{ n: number }>(),
    // 因伤缺阵：登记里勾了这一场的人。赛前也返回——赛前情报要看对手伤停，
    // 与「阵容赛前不亮牌」不冲突（伤停是公开事实，不是战术底牌）
    listMatchAbsences(c.env.DB, row.id, row.home_team_id, row.away_team_id),
  ]);
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
    walkoverSide: (row.walkover_side || null) as MatchDTO["walkoverSide"],
    rescored: (rescored?.n ?? 0) > 0,
    events: eventsByMatch.get(row.id) ?? [],
    stageKind: row.stage_kind,
    homeLogoUrl: mediaUrl(row.home_logo_key),
    awayLogoUrl: mediaUrl(row.away_logo_key),
  };
  return c.json({ match, absences });
});

// 已提交战术阵容：开赛（live/finished）后公开；未开打或草稿赛事一律双方 null（赛前不亮牌）。
// 只给首发、替补、阵型和队长：定位球与角球是战术隐私，公开端不回（assignMode="captain"）。
app.get("/matches/:mid/lineup", pubCache(60), async (c) => {
  try {
    return c.json(await fetchMatchLineup(c.env.DB, Number(c.req.param("mid")), true, "captain"));
  } catch (e) {
    if (e instanceof LineupError) return c.json({ message: e.message }, e.status);
    throw e;
  }
});

// ---------- 赛前情报：未开赛详情页三 Tab ----------

// 待定/轮空时的空壳：前端据 home/away 为 null 直接不渲染
const H2H_EMPTY: H2HDTO = {
  home: null,
  away: null,
  overall: null,
  meetings: [],
  storylines: [],
  homeForm: [],
  awayForm: [],
  ranks: null,
};

type PairRow = {
  id: number;
  finished_at: string | null;
  score_home: number | null;
  score_away: number | null;
  pen_home: number | null;
  pen_away: number | null;
  walkover_side: string | null;
  tournament_id: number;
  tournament_name: string;
  stage_name: string | null;
  round: number;
  leg: number | null;
  h_tid: number;
  h_name: string;
  h_logo: string | null;
  a_tid: number;
  a_name: string;
  a_logo: string | null;
};

// 单场结果（本队视角）：W/D/L。双弃权双方记负；点球决胜按点球——与积分榜口径一致
function formLetter(r: PairRow, teamTid: number): "W" | "D" | "L" {
  if (r.walkover_side === "both") return "L";
  const home = r.h_tid === teamTid;
  const mine = (home ? r.score_home : r.score_away) ?? 0;
  const theirs = (home ? r.score_away : r.score_home) ?? 0;
  if (mine !== theirs) return mine > theirs ? "W" : "L";
  const pm = home ? r.pen_home : r.pen_away;
  const pt = home ? r.pen_away : r.pen_home;
  if (pm != null && pt != null && pm !== pt) return pm > pt ? "W" : "L";
  return "D";
}

// 交锋总览口径的胜方 team_id：双弃权视为平（两队的交锋里「双负」无法表达）；其余按比分/点球
function meetingWinner(r: PairRow): number | null {
  if (r.walkover_side !== "both") {
    const sh = r.score_home ?? 0;
    const sa = r.score_away ?? 0;
    if (sh !== sa) return sh > sa ? r.h_tid : r.a_tid;
    if (r.pen_home != null && r.pen_away != null && r.pen_home !== r.pen_away)
      return r.pen_home > r.pen_away ? r.h_tid : r.a_tid;
  }
  return null;
}

const PAIR_FROM = `
  FROM match m
  JOIN stage s ON s.id = m.stage_id
  JOIN tournament t ON t.id = s.tournament_id AND t.status != 'draft'
  JOIN entry he ON he.id = m.home_entry_id
  JOIN entry ae ON ae.id = m.away_entry_id
  JOIN team ht ON ht.id = he.team_id
  JOIN team at ON at.id = ae.team_id`;

const PAIR_COLS = `
  SELECT m.id, m.finished_at, m.score_home, m.score_away, m.pen_home, m.pen_away,
    m.walkover_side, t.id AS tournament_id, t.name AS tournament_name,
    s.name AS stage_name, m.round, m.leg,
    he.team_id AS h_tid, ht.name AS h_name, ht.logo_key AS h_logo,
    ae.team_id AS a_tid, at.name AS a_name, at.logo_key AS a_logo`;

// 增量 39：`he.team_id = ? OR ae.team_id = ?` 改成 match 自身列上的 IN 子查询。
// 原式 OR 作用在 JOIN 出来的列上，规划器用不了 match 上的任何索引 ⇒ 全表扫 match
// （h2h 单次冷路径实测 1,102 行，见 scripts/d1-read-audit/README.md §12）。
// 两个 IS NOT NULL 守卫是必需的：PAIR_FROM 用 INNER JOIN entry，本来就把队伍待定的行丢掉；
// 换成 `IN (子查询)` 后 `NULL IN (...)` 为 NULL 不为真，但 OR 另一支可能为真 ⇒ 必须显式排除。
export const H2H_FORM_SQL = `${PAIR_COLS} ${PAIR_FROM}
    WHERE m.status = 'finished' AND (m.note IS NULL OR m.note != '轮空') AND m.id != ?
      AND m.home_entry_id IS NOT NULL AND m.away_entry_id IS NOT NULL
      AND (m.home_entry_id IN (SELECT id FROM entry WHERE team_id = ?)
           OR m.away_entry_id IN (SELECT id FROM entry WHERE team_id = ?))
    ORDER BY m.finished_at DESC, m.id DESC LIMIT 5`;

// 两队之间的交锋记录：两个「主客对」的 OR，两支各自都是 IN 子查询。
export const H2H_MEETINGS_SQL = `${PAIR_COLS} ${PAIR_FROM}
       WHERE m.status = 'finished' AND (m.note IS NULL OR m.note != '轮空') AND m.id != ?
         AND m.home_entry_id IS NOT NULL AND m.away_entry_id IS NOT NULL
         AND ((m.home_entry_id IN (SELECT id FROM entry WHERE team_id = ?)
               AND m.away_entry_id IN (SELECT id FROM entry WHERE team_id = ?))
           OR (m.home_entry_id IN (SELECT id FROM entry WHERE team_id = ?)
               AND m.away_entry_id IN (SELECT id FROM entry WHERE team_id = ?)))
       ORDER BY m.finished_at DESC, m.id DESC LIMIT 100`;

// 跨赛事历史交锋（未开赛场次用）：两队按 team_id 对 team_id，全量安全帽 100，展示取前 10
app.get("/tournaments/:id/matches/:mid/h2h", pubCache(60), async (c) => {
  const tid = Number(c.req.param("id"));
  const mid = Number(c.req.param("mid"));
  const m = await c.env.DB.prepare(
    `SELECT m.id, m.note, m.stage_id, m.home_entry_id, m.away_entry_id, s.kind AS stage_kind,
       he.team_id AS home_tid, ae.team_id AS away_tid,
       ht.name AS home_name, at.name AS away_name,
       ht.logo_key AS home_logo, at.logo_key AS away_logo
     FROM match m
     JOIN stage s ON s.id = m.stage_id
     JOIN tournament t ON t.id = s.tournament_id AND t.status != 'draft'
     LEFT JOIN entry he ON he.id = m.home_entry_id
     LEFT JOIN team ht ON ht.id = he.team_id
     LEFT JOIN entry ae ON ae.id = m.away_entry_id
     LEFT JOIN team at ON at.id = ae.team_id
     WHERE s.tournament_id = ? AND m.id = ?`
  )
    .bind(tid, mid)
    .first<{
      id: number;
      note: string | null;
      stage_id: number;
      home_entry_id: number | null;
      away_entry_id: number | null;
      stage_kind: string;
      home_tid: number | null;
      away_tid: number | null;
      home_name: string | null;
      away_name: string | null;
      home_logo: string | null;
      away_logo: string | null;
    }>();
  if (!m) return c.json({ message: "比赛不存在" }, 404);
  if (m.home_tid == null || m.away_tid == null || m.note === "轮空") return c.json(H2H_EMPTY);

  const [meetingsRes, homeFormRes, awayFormRes, stageList] = await Promise.all([
    c.env.DB.prepare(H2H_MEETINGS_SQL)
      .bind(mid, m.home_tid, m.away_tid, m.away_tid, m.home_tid)
      .all<PairRow>(),
    c.env.DB.prepare(H2H_FORM_SQL).bind(mid, m.home_tid, m.home_tid).all<PairRow>(),
    c.env.DB.prepare(H2H_FORM_SQL).bind(mid, m.away_tid, m.away_tid).all<PairRow>(),
    // 排名对话只有非淘汰赛阶段才有；淘汰赛直接跳过省一趟查询
    m.stage_kind === "elim"
      ? Promise.resolve([])
      : readStageStandings(c.env.DB, tid),
  ]);

  const meetings = meetingsRes.results ?? [];
  let winsHome = 0;
  let draws = 0;
  let winsAway = 0;
  let goals = 0;
  for (const r of meetings) {
    const w = meetingWinner(r);
    if (w === m.home_tid) winsHome++;
    else if (w === m.away_tid) winsAway++;
    else draws++;
    goals += (r.score_home ?? 0) + (r.score_away ?? 0);
  }
  const played = meetings.length;
  const overall =
    played > 0
      ? {
          played,
          winsHome,
          draws,
          winsAway,
          avgGoals: Math.round((goals / played) * 10) / 10,
        }
      : null;

  // 彩蛋文案：连胜/不败 → 点球宿敌 → 最大分差之战 → 场均进球，最多 3 条
  const homeName = m.home_name ?? "主队";
  const awayName = m.away_name ?? "客队";
  const storylines: string[] = [];
  if (played > 0) {
    const results = meetings.map(meetingWinner); // 最新一场在前
    const first = results[0];
    if (first != null) {
      let allWin = 0;
      let unbeaten = 0;
      for (const w of results) {
        if (w === first) {
          allWin++;
          unbeaten++;
        } else if (w == null) {
          unbeaten++;
        } else break;
      }
      const who = first === m.home_tid ? homeName : awayName;
      if (allWin >= 2) storylines.push(`近 ${allWin} 次交手，${who} 全胜`);
      else if (unbeaten >= 2) storylines.push(`近 ${unbeaten} 次交手，${who} 保持不败`);
    }
    const penGames = meetings.filter((r) => r.pen_home != null && r.pen_away != null).length;
    if (penGames >= 2) storylines.push(`两队有 ${penGames} 次交手打到点球`);
    let best: PairRow | null = null;
    let bestMargin = 0;
    for (const r of meetings) {
      const margin = Math.abs((r.score_home ?? 0) - (r.score_away ?? 0));
      if (margin > bestMargin) {
        bestMargin = margin;
        best = r;
      }
    }
    if (best && bestMargin >= 2) {
      const d = best.finished_at?.slice(5, 10) ?? "";
      storylines.push(
        `最大分差之战：${d} ${best.h_name} ${best.score_home}:${best.score_away} ${best.a_name}`,
      );
    }
    if (storylines.length < 3 && overall) storylines.push(`两队交手场均 ${overall.avgGoals} 球`);
  }
  storylines.splice(3);

  const toForm = (rows: PairRow[], teamTid: number): H2HFormItem[] =>
    rows.map((r) => {
      const home = r.h_tid === teamTid;
      return {
        matchId: r.id,
        result: formLetter(r, teamTid),
        scoreLabel: `${(home ? r.score_home : r.score_away) ?? 0}:${(home ? r.score_away : r.score_home) ?? 0}`,
        opponentName: home ? r.a_name : r.h_name,
      };
    });

  // 排名对话：两队须同阶段同组（循环赛 groupId 为 null 也算同组）
  let ranks: H2HDTO["ranks"] = null;
  const st = stageList.find((s) => s.stageId === m.stage_id);
  if (st) {
    for (const g of st.groups) {
      const h = g.rows.find((r) => r.entryId === m.home_entry_id);
      const a = g.rows.find((r) => r.entryId === m.away_entry_id);
      if (h && a) {
        ranks = {
          label: st.kind === "group" ? "小组排名" : "积分排名",
          home: { rank: h.rank, pts: h.pts, played: h.played, groupName: g.name || null },
          away: { rank: a.rank, pts: a.pts, played: a.played, groupName: g.name || null },
        };
        break;
      }
    }
  }

  const meetingDTOs: H2HMeetingDTO[] = meetings.slice(0, 10).map((r) => ({
    matchId: r.id,
    tournamentId: r.tournament_id,
    tournamentName: r.tournament_name,
    stageName: r.stage_name,
    round: r.round,
    leg: r.leg,
    dateLabel: r.finished_at?.slice(0, 10) ?? "",
    homeTeamName: r.h_name,
    awayTeamName: r.a_name,
    homeLogoUrl: mediaUrl(r.h_logo),
    awayLogoUrl: mediaUrl(r.a_logo),
    scoreHome: r.score_home ?? 0,
    scoreAway: r.score_away ?? 0,
    penHome: r.pen_home,
    penAway: r.pen_away,
    walkoverSide: (r.walkover_side || null) as H2HMeetingDTO["walkoverSide"],
    winnerTeamId: meetingWinner(r),
    isThisTournament: r.tournament_id === tid,
  }));

  const dto: H2HDTO = {
    home: { teamId: m.home_tid, teamName: m.home_name ?? "", logoUrl: mediaUrl(m.home_logo) },
    away: { teamId: m.away_tid, teamName: m.away_name ?? "", logoUrl: mediaUrl(m.away_logo) },
    overall,
    meetings: meetingDTOs,
    storylines,
    homeForm: toForm(homeFormRes.results ?? [], m.home_tid),
    awayForm: toForm(awayFormRes.results ?? [], m.away_tid),
    ranks,
  };
  return c.json(dto);
});

// 某队最近场次（用于阵容沿用链）：同款 OR 改 IN 子查询（增量 39）。
export const TEAM_TACTICS_MATCHES_SQL = `SELECT m.id
       FROM match m
       JOIN stage s ON s.id = m.stage_id
       JOIN tournament t ON t.id = s.tournament_id AND t.status != 'draft'
       JOIN entry he ON he.id = m.home_entry_id
       JOIN entry ae ON ae.id = m.away_entry_id
       WHERE m.status IN ('live','finished') AND m.id != ?
         AND m.home_entry_id IS NOT NULL AND m.away_entry_id IS NOT NULL
         AND (m.home_entry_id IN (SELECT id FROM entry WHERE team_id = ?)
              OR m.away_entry_id IN (SELECT id FROM entry WHERE team_id = ?))
       ORDER BY s.sort_order DESC, m.round DESC, m.slot DESC, m.leg DESC, m.id DESC
       LIMIT 25`;

// 某队最近场次的「有效阵容」序列（链式沿用：未提交的场次自动按上一场的算）。
// 只统计已开打（live/finished）的非草稿赛事场次；窗口外更早的真实提交也能作为沿用源头。
async function buildTeamTactics(
  db: D1Database,
  teamId: number,
  teamName: string,
  excludeMatchId: number,
): Promise<TeamTacticsDTO | null> {
  const rows = await db
    .prepare(TEAM_TACTICS_MATCHES_SQL)
    .bind(excludeMatchId, teamId, teamId)
    .all<{ id: number }>();
  const matchIds = (rows.results ?? []).map((r) => r.id);
  if (matchIds.length === 0) return null;

  const subs = await db
    .prepare(
      `SELECT match_id, form, slots_json FROM tactic_submission
       WHERE team_id = ? AND match_id IN (${matchIds.map(() => "?").join(",")})`
    )
    .bind(teamId, ...matchIds)
    .all<{ match_id: number; form: string; slots_json: string }>();
  const subByMatch = new Map<number, { form: string; slots: StoredLineupSlot[] }>();
  for (const r of subs.results ?? []) {
    // 同场重复提交以后写的为准（与 fetchMatchLineup 口径一致）
    subByMatch.set(r.match_id, { form: r.form, slots: parseSlotsJson(r.slots_json) });
  }

  // 时间正序走一遍：某场没提交就沿用「上一场」的有效阵容；首次提交之前的场次不计入样本
  type StarterSlot = Extract<StoredLineupSlot, { lid: number }>;
  type EffLineup = { form: string; slots: StarterSlot[] };
  let last: EffLineup | null = null;
  const eff: { lineup: EffLineup | null; real: boolean }[] = [];
  let firstRealSeen = false;
  for (const id of [...matchIds].reverse()) {
    const sub = subByMatch.get(id);
    let real = false;
    if (sub) {
      const starters = sub.slots.filter((s): s is StarterSlot => !("kind" in s));
      if (starters.length === 11) {
        last = { form: sub.form, slots: starters };
        real = true;
        firstRealSeen = true;
      }
    }
    eff.push({ lineup: firstRealSeen ? last : null, real });
  }
  const sample = eff.filter((e) => e.lineup).slice(-10);
  if (sample.length === 0) return null;
  const real = sample.filter((e) => e.real).length;

  const formCount = new Map<string, number>();
  for (const e of sample) formCount.set(e.lineup!.form, (formCount.get(e.lineup!.form) ?? 0) + 1);
  const forms = [...formCount.entries()]
    .map(([form, n]) => ({ form, n }))
    .sort((a, b) => b.n - a.n);
  const typicalForm = forms[0]?.form ?? null;

  const startCount = new Map<number, number>();
  const posCount = new Map<number, Map<string, number>>();
  const lidBest = new Map<number, Map<number, number>>(); // 典型阵型位 → 球员 → 次数
  for (const e of sample) {
    for (const s of e.lineup!.slots) {
      startCount.set(s.player_id, (startCount.get(s.player_id) ?? 0) + 1);
      const pc = posCount.get(s.player_id) ?? new Map<string, number>();
      pc.set(s.position, (pc.get(s.position) ?? 0) + 1);
      posCount.set(s.player_id, pc);
      if (e.lineup!.form === typicalForm) {
        const lb = lidBest.get(s.lid) ?? new Map<number, number>();
        lb.set(s.player_id, (lb.get(s.player_id) ?? 0) + 1);
        lidBest.set(s.lid, lb);
      }
    }
  }

  const typicalXI: TacticXIPlayerDTO[] = [];
  const def = FORMS.find((f) => f.value === typicalForm);
  if (def) {
    for (const p of def.pos) {
      const lb = lidBest.get(p.lid);
      if (!lb) continue;
      let pid = 0;
      let n = 0;
      for (const [k, v] of lb) {
        if (v > n) {
          pid = k;
          n = v;
        }
      }
      if (pid) typicalXI.push({ lid: p.lid, position: p.position, playerId: pid, name: null, number: null, starts: n });
    }
  }

  // 名字/号码一次补齐（含典型首发与首发王涉及的球员）
  const ids = [...new Set([...startCount.keys(), ...typicalXI.map((x) => x.playerId)])];
  const players = new Map<number, { name: string | null; number: string | null }>();
  if (ids.length) {
    const rs = await db
      .prepare(`SELECT id, name, number FROM player WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all<{ id: number; name: string; number: string | null }>();
    for (const p of rs.results ?? []) players.set(p.id, { name: p.name, number: p.number });
  }
  for (const x of typicalXI) {
    const p = players.get(x.playerId);
    x.name = p?.name ?? null;
    x.number = p?.number ?? null;
  }

  const topEntry = [...startCount.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  let topStarter: TeamTacticsDTO["topStarter"] = null;
  if (topEntry) {
    const pc = [...(posCount.get(topEntry[0])?.entries() ?? [])].sort((a, b) => b[1] - a[1])[0];
    const p = players.get(topEntry[0]);
    topStarter = {
      playerId: topEntry[0],
      name: p?.name ?? "已离队",
      number: p?.number ?? null,
      position: pc?.[0] ?? "",
      starts: topEntry[1],
    };
  }

  return {
    teamId,
    teamName,
    sampleSize: sample.length,
    realSubmissions: real,
    forms,
    typicalForm,
    typicalXI,
    topStarter,
  };
}

// 未开赛场次的双方阵容档案（跨赛事）：常用阵型 / 典型首发 / 首发王。
// 沿用规则：未提交的场次按上一场算（见 buildTeamTactics）；本场永远排除。
app.get("/tournaments/:id/matches/:mid/lineup-stats", pubCache(60), async (c) => {
  const tid = Number(c.req.param("id"));
  const mid = Number(c.req.param("mid"));
  const m = await c.env.DB.prepare(
    `SELECT m.id, m.note, he.team_id AS home_tid, ae.team_id AS away_tid,
       ht.name AS home_name, at.name AS away_name
     FROM match m
     JOIN stage s ON s.id = m.stage_id
     JOIN tournament t ON t.id = s.tournament_id AND t.status != 'draft'
     LEFT JOIN entry he ON he.id = m.home_entry_id
     LEFT JOIN team ht ON ht.id = he.team_id
     LEFT JOIN entry ae ON ae.id = m.away_entry_id
     LEFT JOIN team at ON at.id = ae.team_id
     WHERE s.tournament_id = ? AND m.id = ?`
  )
    .bind(tid, mid)
    .first<{
      note: string | null;
      home_tid: number | null;
      away_tid: number | null;
      home_name: string | null;
      away_name: string | null;
    }>();
  if (!m) return c.json({ message: "比赛不存在" }, 404);
  if (m.home_tid == null || m.away_tid == null || m.note === "轮空")
    return c.json({ home: null, away: null } satisfies LineupStatsDTO);

  const [home, away] = await Promise.all([
    buildTeamTactics(c.env.DB, m.home_tid, m.home_name ?? "", mid),
    buildTeamTactics(c.env.DB, m.away_tid, m.away_name ?? "", mid),
  ]);
  return c.json({ home, away } satisfies LineupStatsDTO);
});

// 只为最终入选的几场补主客队名（两段式的第二段）。
// 单语句版把队名 join 进主查询时 LIMIT 在 join 之后才生效，待打场次每场都要付 4 张表的读。
async function fetchTeamNamesForMatches(
  db: D1Database,
  matchIds: number[]
): Promise<Map<number, { home: string; away: string }>> {
  const out = new Map<number, { home: string; away: string }>();
  if (matchIds.length === 0) return out;
  const res = await db
    .prepare(
      `SELECT m.id, ht.name AS home_team_name, at.name AS away_team_name
       FROM match m
       JOIN entry he ON he.id = m.home_entry_id
       JOIN team ht ON ht.id = he.team_id
       JOIN entry ae ON ae.id = m.away_entry_id
       JOIN team at ON at.id = ae.team_id
       WHERE m.id IN (${matchIds.map(() => "?").join(",")})`
    )
    .bind(...matchIds)
    .all<{ id: number; home_team_name: string; away_team_name: string }>();
  for (const r of res.results ?? []) out.set(r.id, { home: r.home_team_name, away: r.away_team_name });
  return out;
}

// 跨赛事"即将进行"：非草稿赛事的未开打场次（排除轮空/队伍待定），running 优先。
// 抽成函数供首页聚合端点 /api/public/home 复用，避免两处口径分叉。
// 两段式：第一段只取排序键与场次 id（三表），第二段只为最终 8 场补队名。
// 原七表 join 版 LIMIT 8 在 join 之后才生效 ⇒ 149 场待打比赛每场都付 7 张表（实测 1192 行）。
// home/away_entry_id 的 IS NOT NULL 顶掉原来靠 INNER JOIN 隐式完成的「队伍待定」排除。
export async function buildUpcomingList(db: D1Database): Promise<UpcomingDTO[]> {
  const rows = await db.prepare(
    `SELECT t.id AS tournament_id, t.name AS tournament_name, t.status AS tournament_status,
       m.id AS match_id, s.kind AS stage_kind, s.sort_order AS stage_order, m.round
     FROM match m
     JOIN stage s ON s.id = m.stage_id
     JOIN tournament t ON t.id = s.tournament_id
     WHERE t.status != 'draft' AND m.status = 'pending'
       AND m.home_entry_id IS NOT NULL AND m.away_entry_id IS NOT NULL
       AND (m.note IS NULL OR m.note != '轮空')
     ORDER BY CASE t.status WHEN 'running' THEN 0 ELSE 1 END,
       t.id, s.sort_order, m.round, m.slot
     LIMIT 8`
  ).all<{
    tournament_id: number; tournament_name: string; tournament_status: string;
    match_id: number; stage_kind: "elim" | "round_robin" | "group";
    stage_order: number; round: number;
  }>();
  const picked = rows.results ?? [];
  const names = await fetchTeamNamesForMatches(db, picked.map((r) => r.match_id));
  return picked.map((r) => ({
    tournamentId: r.tournament_id,
    tournamentName: r.tournament_name,
    matchId: r.match_id,
    stageKind: r.stage_kind,
    stageOrder: r.stage_order,
    round: r.round,
    homeTeamName: names.get(r.match_id)?.home ?? "",
    awayTeamName: names.get(r.match_id)?.away ?? "",
  }));
}

// 待打列表：TTL 300s——两段式后冷重算实测 644 行读/次，按 60s 窗口算上限约 93 万行/日；拉到 300s 后约 18.5 万行/日。
// 待打列表本来就是「未来赛程」，5 分钟陈旧无实感；已开打的场次走 /live 与单场详情（仍 60s）。
app.get("/upcoming", pubCache(300), async (c) => {
  return c.json({ upcoming: await buildUpcomingList(c.env.DB) });
});

// 跨赛事"进行中"：live 场，实时比分与 liveScore 同口径（goal/pen_goal 计事件方，own_goal 记对方）
app.get("/live", pubCache(60), async (c) => {
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
  // 聚合计分查询与公开事件查询互不依赖，先发后收并行
  const eventsByMatchP = fetchPublicEvents(
    c.env.DB,
    list.map((r) => ({ id: r.match_id, home_entry_id: r.home_entry_id, away_entry_id: r.away_entry_id })),
  );
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
  const eventsByMatch = await eventsByMatchP;
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
app.get("/recent", pubCache(60), async (c) => {
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

app.get("/tournaments/:id/standings", pubCache(300), async (c) => {
  const id = Number(c.req.param("id"));
  const t = await c.env.DB.prepare(
    "SELECT id, config_json FROM tournament WHERE id = ? AND status != 'draft'"
  )
    .bind(id)
    .first<{ id: number; config_json: string | null }>();
  if (!t) return c.json({ message: "赛事不存在或未发布" }, 404);
  const standings = await readStageStandings(c.env.DB, id);
  return c.json({
    standings,
    rankZones: parseRankZoneSettings(t.config_json),
  });
});

// 榜单（球员榜+球队榜）与数据统计：单赛事内；管理端另有不受草稿限制的同名端点
app.get("/tournaments/:id/toplists", pubCache(300), async (c) => {
  const id = Number(c.req.param("id"));
  const t = await c.env.DB.prepare(
    "SELECT id FROM tournament WHERE id = ? AND status != 'draft'"
  )
    .bind(id)
    .first<{ id: number }>();
  if (!t) return c.json({ message: "赛事不存在或未发布" }, 404);
  return c.json(await buildToplistsWithSuspension(c.env.DB, id));
});

// 伤停动态（榜单 tab 的板块）：本届参赛队里仍在伤停中的球员，按队分组。
// 伤停跨赛事，所以每条登记自带「受伤那一场」的赛事名标注
app.get("/tournaments/:id/injuries", pubCache(300), async (c) => {
  const id = Number(c.req.param("id"));
  const t = await c.env.DB.prepare(
    "SELECT id FROM tournament WHERE id = ? AND status != 'draft'"
  )
    .bind(id)
    .first<{ id: number }>();
  if (!t) return c.json({ message: "赛事不存在或未发布" }, 404);
  return c.json({ groups: await listTournamentActiveInjuries(c.env.DB, id) });
});

app.get("/tournaments/:id/stats", pubCache(300), async (c) => {
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
