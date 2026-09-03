import { Hono } from "hono";
import type { AppEnv } from "../../env";
import { requireAdmin } from "../../middleware/auth";
import { buildStandingsStmts, buildAdvanceStmts, AdvancerError } from "../../lib/standings";
import { buildCrossStagePlan } from "./schedule";
import type { MatchEventDTO, MatchEventType } from "../../../shared/types";

const app = new Hono<AppEnv>();
app.use("*", requireAdmin);

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

type MatchRow = {
  id: number;
  stage_id: number;
  round: number;
  slot: number;
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

async function loadMatch(db: D1Database, matchId: number): Promise<MatchRow> {
  const m = await db.prepare("SELECT * FROM match WHERE id = ?").bind(matchId).first<MatchRow>();
  if (!m) throw new HttpError(404, "比赛不存在");
  return m;
}

// 归档赛事只读：比分与事件一律锁定（归档是终点状态）
async function assertNotArchived(db: D1Database, matchId: number): Promise<void> {
  const t = await db
    .prepare(
      `SELECT t.status FROM tournament t
       WHERE t.id = (SELECT s.tournament_id FROM stage s
                     WHERE s.id = (SELECT stage_id FROM match WHERE id = ?))`
    )
    .bind(matchId)
    .first<{ status: string }>();
  if (t?.status === "archived") throw new HttpError(400, "赛事已归档，比分已锁定");
}

// live 期间的实时比分：进球类事件累计，乌龙球计入对方（终场确认才落 score 列）
async function liveScore(
  db: D1Database,
  m: MatchRow
): Promise<{ home: number; away: number }> {
  const res = await db
    .prepare(
      `SELECT entry_id,
              SUM(CASE WHEN type IN ('goal', 'pen_goal') THEN 1 ELSE 0 END) AS scored,
              SUM(CASE WHEN type = 'own_goal' THEN 1 ELSE 0 END) AS og
       FROM match_event
       WHERE match_id = ? GROUP BY entry_id`
    )
    .bind(m.id)
    .all<{ entry_id: number; scored: number | null; og: number | null }>();
  let home = 0;
  let away = 0;
  for (const r of res.results ?? []) {
    if (r.entry_id === m.home_entry_id) {
      home += r.scored ?? 0;
      away += r.og ?? 0;
    } else if (r.entry_id === m.away_entry_id) {
      away += r.scored ?? 0;
      home += r.og ?? 0;
    }
  }
  return { home, away };
}

// POST /start：pending → live
app.post("/:id/start", async (c) => {
  const id = Number(c.req.param("id"));
  try {
    const m = await loadMatch(c.env.DB, id);
    await assertNotArchived(c.env.DB, id);
    if (m.note === "轮空") return fail(c, 400, "轮空场无需开赛");
    if (m.home_entry_id == null || m.away_entry_id == null)
      return fail(c, 400, "对阵双方尚未确定，无法开赛");
    if (m.status !== "pending") return fail(c, 400, "仅待开打的比赛可以开赛");
    await c.env.DB.prepare("UPDATE match SET status = 'live' WHERE id = ?").bind(id).run();
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof HttpError) return fail(c, e.status, e.message);
    throw e;
  }
});

// POST /finish：终场确认（唯一的比分收敛点）。
// pending 可快速报分；live 确认终场（比分取事件累计或传入覆盖）；finished 重报即改判。
// 一个 db.batch 原子完成：写比分与胜者 → 全量重算积分 → 晋级器填下一轮/下一阶段。
app.post("/:id/finish", async (c) => {
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as {
    scoreHome?: number;
    scoreAway?: number;
    penHome?: number;
    penAway?: number;
  };
  try {
    const m = await loadMatch(c.env.DB, id);
    await assertNotArchived(c.env.DB, id);
    if (m.note === "轮空") return fail(c, 400, "轮空场无需报分");
    if (m.home_entry_id == null || m.away_entry_id == null)
      return fail(c, 400, "对阵双方尚未确定，无法报分");

    let scoreHome = body.scoreHome;
    let scoreAway = body.scoreAway;
    if (scoreHome == null || scoreAway == null) {
      if (m.status === "finished")
        return fail(c, 400, "改判请传入完整终场比分");
      const events = await liveScore(c.env.DB, m);
      scoreHome ??= events.home;
      scoreAway ??= events.away;
    }
    const penHome = body.penHome ?? null;
    const penAway = body.penAway ?? null;

    // 淘汰赛平局必须有非平的点球比分（legs=2 的单回合平局除外）
    if (scoreHome === scoreAway) {
      if (penHome != null && penAway != null && penHome === penAway)
        return fail(c, 400, "点球比分不能相同");
      if (penHome == null || penAway == null) {
        const stageKind = await c.env.DB.prepare("SELECT kind FROM stage WHERE id = ?")
          .bind(m.stage_id)
          .first<{ kind: string }>();
        const slotRows = await c.env.DB.prepare(
          "SELECT COUNT(*) AS n FROM match WHERE stage_id = ? AND round = ? AND slot = ?"
        )
          .bind(m.stage_id, m.round, m.slot)
          .first<{ n: number }>();
        if (stageKind?.kind === "elim" && (slotRows?.n ?? 0) === 1) {
          return fail(c, 400, "淘汰赛平局需录入点球比分才能定晋级");
        }
      }
    }
    const winner =
      scoreHome > scoreAway
        ? m.home_entry_id
        : scoreAway > scoreHome
          ? m.away_entry_id
          : penHome != null && penAway != null && penHome !== penAway
            ? penHome > penAway
              ? m.home_entry_id
              : m.away_entry_id
            : null;

    const stmts: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `UPDATE match SET score_home = ?, score_away = ?, pen_home = ?, pen_away = ?,
         status = 'finished', winner_entry_id = ? WHERE id = ?`
        ).bind(scoreHome, scoreAway, penHome, penAway, winner, id),
    ];

    const stage = await c.env.DB.prepare(
      "SELECT id, kind, tournament_id, sort_order FROM stage WHERE id = ?"
    )
      .bind(m.stage_id)
      .first<{ id: number; kind: string; tournament_id: number; sort_order: number }>();
    let regenerated = false;

    // 1) 先提交终场写入（D1 无跨语句交互式事务；重算/晋级语句必须在
    //    终场写入生效后构建才能读到最新 finished 集合。两段式之间的窗口
    //    由"全量重算幂等 + 每次 finish 都重建"自愈）
    await c.env.DB.batch(stmts);

    // 2) 构建重算与晋级语句；晋级冲突（下游已开打且需换人）→ 回滚终场
    let followUp: D1PreparedStatement[] = [];
    try {
      if (!stage) throw new Error("stage 不存在");
      if (stage.kind === "elim") {
        followUp = await buildAdvanceStmts(c.env.DB, stage.id);
      } else {
        followUp = await buildStandingsStmts(c.env.DB, stage.id);
        // 小组/循环阶段全部完赛：下一阶段若是跨组淘汰且还没生成，自动按模板取人生成
        const left = await c.env.DB.prepare(
          "SELECT COUNT(*) AS n FROM match WHERE stage_id = ? AND status != 'finished'"
        )
          .bind(stage.id)
          .first<{ n: number }>();
        if ((left?.n ?? 0) === 0) {
          const next = await c.env.DB.prepare(
            `SELECT id FROM stage WHERE tournament_id = ? AND kind = 'elim'
             AND sort_order > ? ORDER BY sort_order LIMIT 1`
          )
            .bind(stage.tournament_id, stage.sort_order)
            .first<{ id: number }>();
          const hasMatches = next
            ? await c.env.DB.prepare("SELECT COUNT(*) AS n FROM match WHERE stage_id = ?")
                .bind(next.id)
                .first<{ n: number }>()
            : null;
          if (next && (hasMatches?.n ?? 0) === 0) {
            const cfg = await c.env.DB.prepare("SELECT config_json FROM stage WHERE id = ?")
              .bind(next.id)
              .first<{ config_json: string | null }>();
            const parsed = (JSON.parse(cfg?.config_json || "{}") ?? {}) as {
              legs?: number;
              final_legs?: number;
              third_place?: boolean;
              source?: { cross?: string[] | string };
            };
            const raw = parsed.source?.cross;
            const tokens = Array.isArray(raw)
              ? raw.map((s) => String(s).trim()).filter(Boolean)
              : typeof raw === "string"
                ? raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
                : [];
            if (tokens.length > 0) {
              const plan = await buildCrossStagePlan(
                c.env,
                stage.tournament_id,
                next.id,
                tokens,
                {
                  legs: parsed.legs === 2 ? 2 : 1,
                  finalLegs:
                    parsed.final_legs === 2 ? 2 : parsed.final_legs === 1 ? 1 : undefined,
                  thirdPlace: !!parsed.third_place,
                }
              );
              for (const pm of plan.matches) {
                followUp.push(
                  c.env.DB.prepare(
                    `INSERT INTO match (stage_id, round, slot, leg, home_entry_id, away_entry_id, winner_entry_id, note)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                  ).bind(
                    next.id,
                    pm.round,
                    pm.slot,
                    pm.leg ?? null,
                    pm.home,
                    pm.away,
                    pm.home != null && pm.away == null ? pm.home : null,
                    pm.note ?? null
                  )
                );
              }
              regenerated = true;
            }
          }
        }
      }
      if (followUp.length > 0) await c.env.DB.batch(followUp);
    } catch (e) {
      if (e instanceof AdvancerError) {
        // 回滚终场写入，保持一致性
        await c.env.DB.prepare(
          `UPDATE match SET score_home = ?, score_away = ?, pen_home = ?, pen_away = ?,
           status = ?, winner_entry_id = ? WHERE id = ?`
        ).bind(
          m.score_home,
          m.score_away,
          m.pen_home,
          m.pen_away,
          m.status,
          m.winner_entry_id,
          id
        ).run();
        return fail(c, 409, e.message);
      }
      throw e;
    }
    return c.json({ ok: true, winner, regenerated });
  } catch (e) {
    if (e instanceof AdvancerError) return fail(c, 409, e.message);
    if (e instanceof HttpError) return fail(c, e.status, e.message);
    throw e;
  }
});

// POST /events：live 期间录事件，进球/点球进球/乌龙球实时累计比分，不触发重算
const EVENT_TYPES = [
  "goal",
  "pen_goal",
  "pen_miss",
  "own_goal",
  "injury_minor",
  "injury_major",
  "yellow",
  "red",
] as const;

app.post("/:id/events", async (c) => {
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => null)) as {
    type?: string;
    entryId?: number;
    playerId?: number | null;
    assistPlayerId?: number | null;
    minute?: number | null;
  } | null;
  if (!body?.type || !EVENT_TYPES.includes(body.type as (typeof EVENT_TYPES)[number]))
    return fail(c, 400, "事件类型必须是 goal / pen_goal / pen_miss / own_goal / injury_minor / injury_major / yellow / red");
  if (body.entryId == null) return fail(c, 400, "缺少所属球队 entryId");
  if (body.minute != null && (body.minute < 0 || body.minute > 300))
    return fail(c, 400, "分钟数应在 0-300 之间");
  try {
    const m = await loadMatch(c.env.DB, id);
    await assertNotArchived(c.env.DB, id);
    if (m.status !== "live") return fail(c, 400, "仅进行中的比赛可录事件");
    if (body.entryId !== m.home_entry_id && body.entryId !== m.away_entry_id)
      return fail(c, 400, "该球队不在本场对阵中");
    // 球员归属校验：射手/助攻必须属于该参赛队（entry.team_id 关联 player.team_id）
    for (const [label, pid] of [
      ["进球球员", body.playerId],
      ["助攻球员", body.assistPlayerId],
    ] as const) {
      if (pid == null) continue;
      const p = await c.env.DB.prepare(
        `SELECT p.id FROM player p
         JOIN entry e ON e.team_id = p.team_id
         WHERE p.id = ? AND e.id = ?`
      )
        .bind(pid, body.entryId)
        .first<{ id: number }>();
      if (!p) return fail(c, 400, `${label}不属于该球队`);
    }
    const wantsAssist = body.assistPlayerId != null;
    if (wantsAssist && body.type !== "goal" && body.type !== "pen_goal")
      return fail(c, 400, "只有进球和点球进球可以记助攻");
    if (wantsAssist && body.playerId == null)
      return fail(c, 400, "记助攻需要先选择进球球员");
    if (wantsAssist && body.assistPlayerId === body.playerId)
      return fail(c, 400, "助攻球员不能和进球球员是同一人");
    await c.env.DB.prepare(
      `INSERT INTO match_event (match_id, entry_id, player_id, assist_player_id, type, minute, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        body.entryId,
        body.playerId ?? null,
        body.assistPlayerId ?? null,
        body.type,
        body.minute ?? null,
        c.get("user")!.id,
      )
      .run();
    const score = await liveScore(c.env.DB, m);
    return c.json({ ok: true, scoreHome: score.home, scoreAway: score.away });
  } catch (e) {
    if (e instanceof HttpError) return fail(c, e.status, e.message);
    throw e;
  }
});

// DELETE /events/:eventId：删误录事件（live 中删除进球后实时比分随之回退；终场后仅作补录修正）
app.delete("/:id/events/:eventId", async (c) => {
  const id = Number(c.req.param("id"));
  const eventId = Number(c.req.param("eventId"));
  try {
    const m = await loadMatch(c.env.DB, id);
    await assertNotArchived(c.env.DB, id);
    const ev = await c.env.DB.prepare("SELECT id FROM match_event WHERE id = ? AND match_id = ?")
      .bind(eventId, id)
      .first<{ id: number }>();
    if (!ev) return fail(c, 404, "事件不存在");
    await c.env.DB.prepare("DELETE FROM match_event WHERE id = ?").bind(eventId).run();
    const score = await liveScore(c.env.DB, m);
    return c.json({
      ok: true,
      scoreHome: m.status === "live" ? score.home : m.score_home,
      scoreAway: m.status === "live" ? score.away : m.score_away,
    });
  } catch (e) {
    if (e instanceof HttpError) return fail(c, e.status, e.message);
    throw e;
  }
});

// GET /:id/events：事件列表（管理端展示用）
app.get("/:id/events", async (c) => {
  const id = Number(c.req.param("id"));
  const res = await c.env.DB.prepare(
    `SELECT e.id, e.entry_id, e.player_id, e.assist_player_id, e.type, e.minute, e.created_at
     FROM match_event e WHERE e.match_id = ? ORDER BY e.id`
  )
    .bind(id)
    .all();
  const rows = (res.results ?? []) as Array<{
    id: number;
    entry_id: number;
    player_id: number | null;
    assist_player_id: number | null;
    type: MatchEventType;
    minute: number | null;
    created_at: string;
  }>;
  const events: MatchEventDTO[] = rows.map((r) => ({
    id: r.id,
    matchId: id,
    entryId: r.entry_id,
    playerId: r.player_id,
    assistPlayerId: r.assist_player_id,
    type: r.type,
    minute: r.minute,
    createdAt: r.created_at,
  }));
  return c.json({ events });
});

export default app;
