import { Hono } from "hono";
import type { AppEnv } from "../env";
import type { EntryDTO, MatchDTO, TournamentDTO } from "../../shared/types";
import { readStageStandings } from "../lib/standings";
import { buildStats, buildToplists } from "../lib/topstats";

// 公开页接口：无登录墙，游客可看。draft（草稿）赛事不对外——列表不含、详情按 404 处理。
const app = new Hono<AppEnv>();

app.get("/tournaments", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT t.id, t.name, t.description, t.format, t.status, t.created_at,
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
  }>();
  const tournaments: TournamentDTO[] = rows.results.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    format: r.format,
    status: r.status,
    createdAt: r.created_at,
    entryCount: r.entry_count,
  }));
  return c.json({ tournaments });
});

app.get("/tournaments/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const t = await c.env.DB.prepare(
    `SELECT t.id, t.name, t.description, t.format, t.status, t.created_at,
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
      `SELECT e.id, e.team_id, e.seed, e.group_id, e.points_deducted, tm.name AS team_name,
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
      })
    ),
  });
});

// 赛程对阵（含 live 比分的事件覆盖），与 admin 端同构
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
    score_home: number | null; score_away: number | null;
    pen_home: number | null; pen_away: number | null;
    status: MatchDTO["status"]; winner_entry_id: number | null; note: string | null;
  };
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.stage_id, m.round, m.slot, m.leg,
       m.home_entry_id, m.away_entry_id,
       ht.name AS home_team_name, at.name AS away_team_name,
       m.score_home, m.score_away, m.pen_home, m.pen_away,
       m.status, m.winner_entry_id, m.note
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
  const liveIds = (rows.results ?? []).filter((r) => r.status === "live").map((r) => r.id);
  const liveGoals = new Map<string, number>();
  for (const mid of liveIds) {
    const g = await c.env.DB.prepare(
      `SELECT entry_id, COUNT(*) AS n FROM match_event
       WHERE match_id = ? AND type = 'goal' GROUP BY entry_id`
    )
      .bind(mid)
      .all<{ entry_id: number; n: number }>();
    for (const row of g.results ?? []) liveGoals.set(`${mid}:${row.entry_id}`, row.n);
  }
  const matches: MatchDTO[] = (rows.results ?? []).map((r) => ({
    id: r.id,
    stageId: r.stage_id,
    round: r.round,
    slot: r.slot,
    leg: r.leg,
    homeEntryId: r.home_entry_id,
    awayEntryId: r.away_entry_id,
    homeTeamName: r.home_team_name,
    awayTeamName: r.away_team_name,
    scoreHome:
      r.status === "live"
        ? liveGoals.get(`${r.id}:${r.home_entry_id}`) ?? 0
        : r.score_home,
    scoreAway:
      r.status === "live"
        ? liveGoals.get(`${r.id}:${r.away_entry_id}`) ?? 0
        : r.score_away,
    penHome: r.pen_home,
    penAway: r.pen_away,
    status: r.status,
    winnerEntryId: r.winner_entry_id,
    note: r.note,
  }));
  return c.json({ matches });
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
