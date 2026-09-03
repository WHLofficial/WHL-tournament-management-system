import { Hono } from "hono";
import type { AppEnv } from "../../env";
import { requireAdmin } from "../../middleware/auth";
import type { MatchDTO } from "../../../shared/types";
import {
  buildElimPlan,
  drawGroups,
  roundRobinSchedule,
} from "../../lib/seeding";

const app = new Hono<AppEnv>();
app.use("*", requireAdmin);

type StageRow = {
  id: number;
  tournament_id: number;
  kind: "elim" | "round_robin" | "group";
  config_json: string | null;
};

type EntryRow = { id: number; seed: number | null; group_id: number | null };

// 载入并校验赛事/阶段归属；任何阶段存在已开打或已完赛的场次时禁止重排/重抽
async function loadStage(
  db: D1Database,
  tid: number,
  stageId: number
): Promise<{ stage: StageRow; started: number }> {
  const stage = await db.prepare(
    "SELECT id, tournament_id, kind, config_json FROM stage WHERE id = ? AND tournament_id = ?"
  )
    .bind(stageId, tid)
    .first<StageRow>();
  if (!stage) throw new HttpError(404, "阶段不存在");
  const started =
    (
      await db.prepare(
        "SELECT COUNT(*) AS n FROM match WHERE stage_id = ? AND status IN ('live','finished')"
      )
        .bind(stageId)
        .first<{ n: number }>()
    )?.n ?? 0;
  return { stage, started };
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

const fail = (c: { json: Function }, status: number, message: string) =>
  c.json({ message }, status);

// ---------- 自动生成阶段赛程 ----------

app.post("/:id/stages/:stageId/generate", async (c) => {
  const tid = Number(c.req.param("id"));
  const stageId = Number(c.req.param("stageId"));
  const env = c.env;
  let stage: StageRow;
  let started: number;
  try {
    ({ stage, started } = await loadStage(env.DB, tid, stageId));
  } catch (e) {
    if (e instanceof HttpError) return fail(c, e.status, e.message);
    throw e;
  }
  if (started > 0) {
    return fail(c, 409, "该阶段已有开打或完赛的场次，不能重新生成");
  }

  const entries = await env.DB.prepare(
    "SELECT id, seed, group_id FROM entry WHERE tournament_id = ? ORDER BY seed"
  )
    .bind(tid)
    .all<EntryRow>();
  const list = entries.results ?? [];

  // 重生成 = 清空该阶段全部未开打的场次后重建
  const del = env.DB.prepare("DELETE FROM match WHERE stage_id = ?").bind(stageId);
  const stmts: D1PreparedStatement[] = [del];
  const insertMatch =
    "INSERT INTO match (stage_id, round, slot, leg, home_entry_id, away_entry_id, status, winner_entry_id, note) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)";
  let rounds = 0;
  let created = 0;
  let balanced: boolean | undefined;

  if (stage.kind === "elim") {
    if (list.length < 2) return fail(c, 400, "报名不足 2 支，无法生成对阵");
    const cfg = (JSON.parse(stage.config_json || "{}") ?? {}) as {
      legs?: number;
      final_legs?: number;
      third_place?: boolean;
    };
    const plan = buildElimPlan(list.length, {
      legs: cfg.legs === 2 ? 2 : 1,
      finalLegs: cfg.final_legs === 2 ? 2 : cfg.final_legs === 1 ? 1 : undefined,
      thirdPlace: !!cfg.third_place,
    });
    rounds = plan.rounds;
    for (const m of plan.matches) {
      const home = m.home !== null && m.home <= list.length ? list[m.home - 1].id : null;
      const away = m.away !== null && m.away <= list.length ? list[m.away - 1].id : null;
      // 轮空场：pending + 预填 winner，避免 finished 挡住重生成；note 沿用 plan（轮空/季军赛）
      const isBye = home !== null && away === null;
      stmts.push(
        env.DB.prepare(insertMatch).bind(
          stageId,
          m.round,
          m.slot,
          m.leg ?? null,
          home,
          away,
          isBye ? home : null,
          m.note ?? null
        )
      );
      created++;
    }
  } else if (stage.kind === "round_robin") {
    if (list.length < 2) return fail(c, 400, "报名不足 2 支，无法生成赛程");
    const cfg = (JSON.parse(stage.config_json || "{}") ?? {}) as { loops?: number };
    const sched = roundRobinSchedule(list.length, cfg.loops === 2 ? 2 : 1);
    balanced = sched.balanced;
    rounds = sched.matches.reduce((mx, m) => Math.max(mx, m.round), 0);
    const slotOf = new Map<number, number>(); // 轮内序号
    for (const m of sched.matches) {
      const slot = (slotOf.get(m.round) ?? 0) + 1;
      slotOf.set(m.round, slot);
      stmts.push(
        env.DB.prepare(insertMatch).bind(
          stageId,
          m.round,
          slot,
          null,
          list[m.home].id,
          list[m.away].id,
          null,
          null
        )
      );
      created++;
    }
  } else {
    // group：每组独立循环；未抽签或某组不足 2 队时跳过该组
    const groups = await env.DB.prepare(
      'SELECT id, name FROM "group" WHERE stage_id = ? ORDER BY sort_order'
    )
      .bind(stageId)
      .all<{ id: number; name: string }>();
    const cfg = (JSON.parse(stage.config_json || "{}") ?? {}) as { loops?: number };
    const loops = cfg.loops === 2 ? 2 : 1;
    const byGroup = new Map<number, EntryRow[]>();
    for (const e of list) {
      if (e.group_id == null) continue;
      const arr = byGroup.get(e.group_id) ?? [];
      arr.push(e);
      byGroup.set(e.group_id, arr);
    }
    const skipped: string[] = [];
    for (const g of groups.results ?? []) {
      const members = byGroup.get(g.id) ?? [];
      if (members.length < 2) {
        skipped.push(g.name);
        continue;
      }
      const sched = roundRobinSchedule(members.length, loops);
      rounds = Math.max(rounds, sched.matches.reduce((mx, m) => Math.max(mx, m.round), 0));
      const slotOf = new Map<number, number>();
      for (const m of sched.matches) {
        const slot = (slotOf.get(m.round) ?? 0) + 1;
        slotOf.set(m.round, slot);
        stmts.push(
          env.DB.prepare(insertMatch).bind(
            stageId,
            m.round,
            slot,
            null,
            members[m.home].id,
            members[m.away].id,
            null,
            null
          )
        );
        created++;
      }
    }
    if (created === 0) {
      return fail(c, 400, "先抽签分组（且每组至少 2 队）才能生成小组赛程");
    }
    await env.DB.batch(stmts);
    return c.json({ created, rounds, skippedGroups: skipped });
  }

  await env.DB.batch(stmts);
  return c.json({ created, rounds, balanced });
});

// ---------- 小组抽签 ----------

app.post("/:id/stages/:stageId/draw", async (c) => {
  const tid = Number(c.req.param("id"));
  const stageId = Number(c.req.param("stageId"));
  let stage: StageRow;
  let started: number;
  try {
    ({ stage, started } = await loadStage(c.env.DB, tid, stageId));
  } catch (e) {
    if (e instanceof HttpError) return fail(c, e.status, e.message);
    throw e;
  }
  if (stage.kind !== "group") return fail(c, 400, "只有小组赛阶段支持抽签");
  if (started > 0) return fail(c, 409, "该阶段已有开打或完赛的场次，不能重新抽签");

  const groups = await c.env.DB.prepare(
    'SELECT id, name FROM "group" WHERE stage_id = ? ORDER BY sort_order'
  )
    .bind(stageId)
    .all<{ id: number; name: string }>();
  const groupRows = groups.results ?? [];
  if (groupRows.length === 0) return fail(c, 400, "该阶段没有小组");

  const entries = await c.env.DB.prepare(
    "SELECT id FROM entry WHERE tournament_id = ?"
  )
    .bind(tid)
    .all<{ id: number }>();
  const entryIds = (entries.results ?? []).map((e) => e.id);
  if (entryIds.length < groupRows.length * 2) {
    return fail(
      c,
      400,
      `报名 ${entryIds.length} 支不足 ${groupRows.length} 组每组 2 队，无法抽签`
    );
  }

  const byName = drawGroups(entryIds, groupRows.length); // Map entryId -> 组名
  const groupIdByName = new Map(groupRows.map((g) => [g.name, g.id]));
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare("UPDATE entry SET group_id = NULL WHERE tournament_id = ?").bind(tid),
  ];
  for (const [entryId, name] of byName) {
    const gid = groupIdByName.get(name);
    if (gid == null) continue;
    stmts.push(
      c.env.DB.prepare("UPDATE entry SET group_id = ? WHERE id = ?").bind(gid, entryId)
    );
  }
  await c.env.DB.batch(stmts);

  const result: Record<string, number[]> = {};
  for (const g of groupRows) result[g.name] = [];
  for (const [entryId, name] of byName) {
    (result[name] ??= []).push(entryId);
  }
  return c.json({ assigned: byName.size, groups: result });
});

// ---------- 手动落场（仅循环/小组阶段；淘汰赛由晋级器填充） ----------

app.post("/:id/stages/:stageId/matches", async (c) => {
  const tid = Number(c.req.param("id"));
  const stageId = Number(c.req.param("stageId"));
  const body = await c.req.json().catch(() => null as null);
  const round = Number(body?.round);
  const homeEntryId = Number(body?.homeEntryId);
  const awayEntryId = Number(body?.awayEntryId);
  if (!Number.isInteger(round) || round < 1) {
    return fail(c, 400, "轮次必须是正整数");
  }
  if (!Number.isInteger(homeEntryId) || !Number.isInteger(awayEntryId)) {
    return fail(c, 400, "请选择主队和客队");
  }
  if (homeEntryId === awayEntryId) {
    return fail(c, 400, "主客队不能是同一支队伍");
  }

  let stage: StageRow;
  try {
    ({ stage } = await loadStage(c.env.DB, tid, stageId));
  } catch (e) {
    if (e instanceof HttpError) return fail(c, e.status, e.message);
    throw e;
  }
  if (stage.kind === "elim") {
    return fail(c, 400, "淘汰赛对阵由晋级器按结果填充，不支持手动落场");
  }

  const cfg = (JSON.parse(stage.config_json || "{}") ?? {}) as { loops?: number };
  const loops = cfg.loops === 2 ? 2 : 1;

  const e1 = await c.env.DB.prepare(
    "SELECT id, group_id FROM entry WHERE id = ? AND tournament_id = ?"
  )
    .bind(homeEntryId, tid)
    .first<{ id: number; group_id: number | null }>();
  const e2 = await c.env.DB.prepare(
    "SELECT id, group_id FROM entry WHERE id = ? AND tournament_id = ?"
  )
    .bind(awayEntryId, tid)
    .first<{ id: number; group_id: number | null }>();
  if (!e1 || !e2) return fail(c, 400, "参赛队伍不存在");

  if (stage.kind === "group") {
    if (e1.group_id == null || e1.group_id !== e2.group_id) {
      return fail(c, 400, "小组赛只能在同组球队之间落场");
    }
  }

  // 即点即校验：一队本轮只踢一场；两队交手次数不超过 loops
  const dup = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM match
     WHERE stage_id = ? AND round = ?
       AND (home_entry_id IN (?, ?) OR away_entry_id IN (?, ?))`
  )
    .bind(stageId, round, homeEntryId, awayEntryId, homeEntryId, awayEntryId)
    .first<{ n: number }>();
  if ((dup?.n ?? 0) > 0) {
    return fail(c, 409, "本轮已有其中一支球队的比赛");
  }
  const played = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM match
     WHERE stage_id = ?
       AND ((home_entry_id = ? AND away_entry_id = ?) OR (home_entry_id = ? AND away_entry_id = ?))`
  )
    .bind(stageId, homeEntryId, awayEntryId, awayEntryId, homeEntryId)
    .first<{ n: number }>();
  if ((played?.n ?? 0) >= loops) {
    return fail(c, 409, loops === 1 ? "两队在本阶段已交手过" : "两队交手次数已达上限（双循环）");
  }

  const r = await c.env.DB.prepare(
    `INSERT INTO match (stage_id, round, slot, home_entry_id, away_entry_id, status)
     VALUES (?, ?, (SELECT COALESCE(MAX(slot), 0) + 1 FROM match WHERE stage_id = ? AND round = ?), ?, ?, 'pending')`
  )
    .bind(stageId, round, stageId, round, homeEntryId, awayEntryId)
    .run();
  return c.json({ id: r.meta.last_row_id }, 201);
});

// ---------- 场次查询（全赛事，前端按阶段过滤）与删除 ----------

app.get("/:id/matches", async (c) => {
  const tid = Number(c.req.param("id"));
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
    scoreHome: r.score_home,
    scoreAway: r.score_away,
    penHome: r.pen_home,
    penAway: r.pen_away,
    status: r.status,
    winnerEntryId: r.winner_entry_id,
    note: r.note,
  }));
  return c.json({ matches });
});

app.delete("/:id/matches/:matchId", async (c) => {
  const tid = Number(c.req.param("id"));
  const matchId = Number(c.req.param("matchId"));
  const m = await c.env.DB.prepare(
    `SELECT m.id, m.status FROM match m JOIN stage s ON s.id = m.stage_id
     WHERE m.id = ? AND s.tournament_id = ?`
  )
    .bind(matchId, tid)
    .first<{ id: number; status: MatchDTO["status"] }>();
  if (!m) return fail(c, 404, "比赛不存在");
  if (m.status !== "pending") {
    return fail(c, 409, "只有未开打的比赛可以删除");
  }
  await c.env.DB.prepare("DELETE FROM match WHERE id = ?").bind(matchId).run();
  return c.json({ ok: true });
});

export default app;
