import { Hono } from "hono";
import type { AppEnv } from "../../env";
import { requireAdmin } from "../../middleware/auth";
import { buildStandingsStmts, buildAdvanceStmts, AdvancerError } from "../../lib/standings";
import { buildAutoFillStmts } from "./schedule";
import { getSuspensionConfig } from "../../lib/suspension";
import { fetchMatchLineup, LineupError } from "../../lib/lineup";
import { auditStmt } from "../../lib/audit";
import type { MatchEventDTO, MatchEventType, MatchLineupDTO } from "../../../shared/types";

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
  walkover_side: string | null;
};

type MatchCtx = {
  m: MatchRow;
  stageKind: "elim" | "round_robin" | "group";
  tournamentId: number;
};

// 一条 JOIN 拿全上下文：比赛 + 阶段类型 + 赛事状态。原先 loadMatch → assertNotArchived
// →（终场还要再查一次 stage）三连串行往返压成 1 个；归档守卫顺路做掉。
async function loadMatchCtx(db: D1Database, matchId: number): Promise<MatchCtx> {
  const row = await db
    .prepare(
      `SELECT m.*, s.kind AS stage_kind, s.tournament_id, t.status AS tournament_status
       FROM match m
       JOIN stage s ON s.id = m.stage_id
       JOIN tournament t ON t.id = s.tournament_id
       WHERE m.id = ?`
    )
    .bind(matchId)
    .first<
      MatchRow & {
        stage_kind: MatchCtx["stageKind"];
        tournament_id: number;
        tournament_status: string;
      }
    >();
  if (!row) throw new HttpError(404, "比赛不存在");
  if (row.tournament_status === "archived") throw new HttpError(400, "赛事已归档，比分已锁定");
  return { m: row, stageKind: row.stage_kind, tournamentId: row.tournament_id };
}

const LIVE_SCORE_SQL = `SELECT entry_id,
        SUM(CASE WHEN type IN ('goal', 'pen_goal') THEN 1 ELSE 0 END) AS scored,
        SUM(CASE WHEN type = 'own_goal' THEN 1 ELSE 0 END) AS og
 FROM match_event
 WHERE match_id = ? GROUP BY entry_id`;
type ScoreRow = { entry_id: number; scored: number | null; og: number | null };

function scoreFromRows(m: MatchRow, rows: ScoreRow[]): { home: number; away: number } {
  let home = 0;
  let away = 0;
  for (const r of rows) {
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

// live 期间的实时比分：进球类事件累计，乌龙球计入对方（终场确认才落 score 列）
async function liveScore(
  db: D1Database,
  m: MatchRow
): Promise<{ home: number; away: number }> {
  const res = await db.prepare(LIVE_SCORE_SQL).bind(m.id).all<ScoreRow>();
  return scoreFromRows(m, res.results ?? []);
}

// POST /start：pending → live
app.post("/:id/start", async (c) => {
  const id = Number(c.req.param("id"));
  try {
    const ctx = await loadMatchCtx(c.env.DB, id);
    const m = ctx.m;
    if (m.note === "轮空") return fail(c, 400, "轮空场无需开赛");
    if (m.home_entry_id == null || m.away_entry_id == null)
      return fail(c, 400, "对阵双方尚未确定，无法开赛");
    if (m.status !== "pending") return fail(c, 400, "仅待开打的比赛可以开赛");
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE match SET status = 'live' WHERE id = ?").bind(id),
      auditStmt(c.env.DB, c.get("user")!.id, "match_start", id, null),
    ]);
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof HttpError) return fail(c, e.status, e.message);
    throw e;
  }
});

// POST /finish：终场确认（唯一的比分收敛点）。
// pending 可快速报分；live 确认终场（比分取事件累计或传入覆盖）；finished 重报即改判；
// 传 walkoverSide 即弃权判负（单方 0:3 / 双方 0:0，可带备注；改判回普通比分自动清弃权）。
app.post("/:id/finish", async (c) => {
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as {
    scoreHome?: number;
    scoreAway?: number;
    penHome?: number;
    penAway?: number;
    walkoverSide?: string;
    walkoverNote?: string;
    winnerEntryId?: number;
  };
  try {
    const ctx = await loadMatchCtx(c.env.DB, id);
    const m = ctx.m;
    if (m.note === "轮空") return fail(c, 400, "轮空场无需报分");
    if (m.home_entry_id == null || m.away_entry_id == null)
      return fail(c, 400, "对阵双方尚未确定，无法报分");

    const woRaw = body.walkoverSide ?? "";
    const walkoverSide =
      woRaw === "home" || woRaw === "away" || woRaw === "both" ? woRaw : null;
    if (woRaw && !walkoverSide) return fail(c, 400, "弃权方必须是 home / away / both");

    let scoreHome: number;
    let scoreAway: number;
    let penHome: number | null = null;
    let penAway: number | null = null;
    let winner: number | null = null;
    let nextNote: string | null = null;

    if (walkoverSide) {
      // 弃权：比分固定（单方 0:3 / 双方 0:0）、不录点球，跳过淘汰赛平局点球校验
      const woNote = body.walkoverNote?.trim().slice(0, 60) || null;
      if (walkoverSide === "both") {
        scoreHome = 0;
        scoreAway = 0;
        nextNote = woNote ?? "双方弃权";
      } else {
        scoreHome = walkoverSide === "home" ? 0 : 3;
        scoreAway = walkoverSide === "home" ? 3 : 0;
        nextNote = woNote ?? (walkoverSide === "home" ? "主队弃权" : "客队弃权");
      }
      // 淘汰赛双弃权必须指定晋级方（两回合对局晋级由总比分/点球决定，不在此指定）
      if (walkoverSide === "both" && ctx.stageKind === "elim") {
        const slotRows = await c.env.DB.prepare(
          "SELECT COUNT(*) AS n FROM match WHERE stage_id = ? AND round = ? AND slot = ?"
        )
          .bind(m.stage_id, m.round, m.slot)
          .first<{ n: number }>();
        if ((slotRows?.n ?? 0) === 1) {
          const wid = body.winnerEntryId;
          if (wid !== m.home_entry_id && wid !== m.away_entry_id)
            return fail(c, 400, "双方弃权的淘汰赛必须指定晋级方");
          winner = wid;
        }
      }
      if (walkoverSide === "home") winner = m.away_entry_id;
      else if (walkoverSide === "away") winner = m.home_entry_id;
    } else {
      let sh = body.scoreHome;
      let sa = body.scoreAway;
      if (sh == null || sa == null) {
        if (m.status === "finished")
          return fail(c, 400, "改判请传入完整终场比分");
        const events = await liveScore(c.env.DB, m);
        sh = events.home;
        sa = events.away;
      }
      scoreHome = sh;
      scoreAway = sa;
      penHome = body.penHome ?? null;
      penAway = body.penAway ?? null;

      // 淘汰赛平局必须有非平的点球比分（legs=2 的单回合平局除外）
      if (scoreHome === scoreAway) {
        if (penHome != null && penAway != null && penHome === penAway)
          return fail(c, 400, "点球比分不能相同");
        if (penHome == null || penAway == null) {
          if (ctx.stageKind === "elim") {
            const slotRows = await c.env.DB.prepare(
              "SELECT COUNT(*) AS n FROM match WHERE stage_id = ? AND round = ? AND slot = ?"
            )
              .bind(m.stage_id, m.round, m.slot)
              .first<{ n: number }>();
            if ((slotRows?.n ?? 0) === 1) {
              return fail(c, 400, "淘汰赛平局需录入点球比分才能定晋级");
            }
          }
        }
      }
      winner =
        scoreHome > scoreAway
          ? m.home_entry_id
          : scoreAway > scoreHome
            ? m.away_entry_id
            : penHome != null && penAway != null && penHome !== penAway
              ? penHome > penAway
                ? m.home_entry_id
                : m.away_entry_id
              : null;
      // 普通报分/改判落在弃权场上即清除弃权标记与备注
      nextNote = m.walkover_side ? null : m.note;
    }

    const action =
      walkoverSide
        ? "match_walkover"
        : m.status === "finished"
          ? "match_rescore"
          : "match_finish";
    const auditDetail = {
      old: {
        status: m.status,
        scoreHome: m.score_home,
        scoreAway: m.score_away,
        penHome: m.pen_home,
        penAway: m.pen_away,
        walkoverSide: m.walkover_side || null,
      },
      new: {
        scoreHome,
        scoreAway,
        penHome,
        penAway,
        walkoverSide,
        note: nextNote,
        winnerEntryId: winner,
      },
    };

    const stmts: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `UPDATE match SET score_home = ?, score_away = ?, pen_home = ?, pen_away = ?,
         status = 'finished', winner_entry_id = ?, walkover_side = ?, note = ?,
         finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
        ).bind(scoreHome, scoreAway, penHome, penAway, winner, walkoverSide ?? "", nextNote, id),
    ];

    let regenerated = false;

    // 1) 先提交终场写入（D1 无跨语句交互式事务；重算/晋级语句必须在
    //    终场写入生效后构建才能读到最新 finished 集合。两段式之间的窗口
    //    由"全量重算幂等 + 每次 finish 都重建"自愈）
    await c.env.DB.batch(stmts);

    // 2) 构建重算与晋级语句；晋级冲突（下游已开打且需换人）→ 回滚终场
    let followUp: D1PreparedStatement[] = [];
    try {
      if (ctx.stageKind === "elim") {
        followUp = await buildAdvanceStmts(c.env.DB, m.stage_id);
      } else {
        followUp = await buildStandingsStmts(c.env.DB, m.stage_id);
        // 小组/循环阶段全部完赛：按下一阶段的取人规则（cross 模板 / topN）自动生成首轮赛程
        const autoStmts = await buildAutoFillStmts(c.env, ctx.tournamentId, m.stage_id);
        followUp.push(...autoStmts);
        if (autoStmts.length > 0) regenerated = true;
      }
      // 审计随重算/晋级批次提交（batch 恒非空）；晋级冲突 409 回滚时审计一并落空
      followUp.push(auditStmt(c.env.DB, c.get("user")!.id, action, id, auditDetail));
      await c.env.DB.batch(followUp);
    } catch (e) {
      if (e instanceof AdvancerError) {
        // 回滚终场写入，保持一致性
        await c.env.DB.prepare(
          `UPDATE match SET score_home = ?, score_away = ?, pen_home = ?, pen_away = ?,
           status = ?, winner_entry_id = ?, walkover_side = ?, note = ? WHERE id = ?`
        ).bind(
          m.score_home,
          m.score_away,
          m.pen_home,
          m.pen_away,
          m.status,
          m.winner_entry_id,
          m.walkover_side ?? "",
          m.note,
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

// POST /events：live 期间录事件实时累计比分；完赛后可补录/删改事件（只动事件流，比分列不变）
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
    // 读波并行：比赛上下文、球员归属、红黄牌计数互不依赖（都由请求体决定），
    // 原先最多 7 个串行读往返压成 1 波；裁决仍按原优先级在 JS 里做
    const pids = [body.playerId, body.assistPlayerId].filter(
      (p): p is number => p != null,
    );
    const wantCards =
      (body.type === "yellow" || body.type === "red") && body.playerId != null;
    const [ctx, owned, card] = await Promise.all([
      loadMatchCtx(c.env.DB, id),
      pids.length
        ? c.env.DB.prepare(
            `SELECT p.id FROM player p
             JOIN entry e ON e.team_id = p.team_id
             WHERE e.id = ? AND p.id IN (${pids.map(() => "?").join(",")})`
          )
            .bind(body.entryId, ...pids)
            .all<{ id: number }>()
        : Promise.resolve(null),
      wantCards
        ? c.env.DB.prepare(
            `SELECT SUM(CASE WHEN type IN ('red', 'red_2y') THEN 1 ELSE 0 END) AS reds,
                    SUM(CASE WHEN type = 'yellow' THEN 1 ELSE 0 END) AS yellows
             FROM match_event WHERE match_id = ? AND player_id = ?`
          )
            .bind(id, body.playerId)
            .first<{ reds: number | null; yellows: number | null }>()
        : Promise.resolve(null),
    ]);
    const m = ctx.m;
    if (m.status === "pending") return fail(c, 400, "比赛还没开打，开赛后才能录事件");
    if (body.entryId !== m.home_entry_id && body.entryId !== m.away_entry_id)
      return fail(c, 400, "该球队不在本场对阵中");
    // 球员归属校验：射手/助攻必须属于该参赛队（entry.team_id 关联 player.team_id）
    const ownedIds = new Set((owned?.results ?? []).map((r) => r.id));
    if (body.playerId != null && !ownedIds.has(body.playerId))
      return fail(c, 400, "进球球员不属于该球队");
    if (body.assistPlayerId != null && !ownedIds.has(body.assistPlayerId))
      return fail(c, 400, "助攻球员不属于该球队");
    const wantsAssist = body.assistPlayerId != null;
    if (wantsAssist && body.type !== "goal" && body.type !== "pen_goal")
      return fail(c, 400, "只有进球和点球进球可以记助攻");
    if (wantsAssist && body.playerId == null)
      return fail(c, 400, "记助攻需要先选择进球球员");
    if (wantsAssist && body.assistPlayerId === body.playerId)
      return fail(c, 400, "助攻球员不能和进球球员是同一人");

    // 纪律记录：已被罚下的球员本场不能再吃牌（更正请先删红牌事件）；
    // 第二张黄牌自动转存为两黄变一红（red_2y 只由系统生成，不在录入白名单）。
    // 停赛提醒不在这里做——那需要全量重放整届赛事，前端事件表单已用已拉取的停赛数据做提交前警告。
    let eventType: MatchEventType = body.type as MatchEventType;
    let notice: string | null = null;
    if (card) {
      if ((card.reds ?? 0) >= 1)
        return fail(c, 400, "该球员本场已被罚下，如需更正请先删除红牌事件");
      if (body.type === "yellow" && (card.yellows ?? 0) >= 1) {
        eventType = "red_2y";
        // 停赛档位只在真触发两黄变一红时才查（罕见路径），常规录事件零开销
        const sc = await getSuspensionConfig(c.env.DB, ctx.tournamentId);
        notice = `第 2 张黄牌已自动记录为两黄变一红（停赛 ${sc.red2yBan} 场）`;
      }
    }

    // 写入 batch：INSERT + 审计（+ live 时尾随实时比分查询——batch 内语句顺序执行、
    // 同一事务，尾 SELECT 能读到刚插入的行），一个往返全办完
    const live = m.status === "live";
    const batch: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `INSERT INTO match_event (match_id, entry_id, player_id, assist_player_id, type, minute, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        body.entryId,
        body.playerId ?? null,
        body.assistPlayerId ?? null,
        eventType,
        body.minute ?? null,
        c.get("user")!.id,
      ),
      auditStmt(c.env.DB, c.get("user")!.id, "event_create", id, {
        type: eventType,
        entryId: body.entryId,
        playerId: body.playerId ?? null,
        assistPlayerId: body.assistPlayerId ?? null,
        minute: body.minute ?? null,
        ...(eventType !== body.type ? { red2y: true } : {}),
      }),
    ];
    if (live) batch.push(c.env.DB.prepare(LIVE_SCORE_SQL).bind(id));
    const batchRes = await c.env.DB.batch(batch);
    const extras: Record<string, string> = {};
    if (notice) extras.notice = notice;
    if (live) {
      const score = scoreFromRows(m, (batchRes[2].results ?? []) as ScoreRow[]);
      return c.json({ ok: true, scoreHome: score.home, scoreAway: score.away, ...extras });
    }
    // 完赛后的补录不改比分列，返回当前比分即可
    return c.json({
      ok: true,
      scoreHome: m.score_home ?? 0,
      scoreAway: m.score_away ?? 0,
      ...extras,
    });
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
    // 比赛上下文与事件行互不依赖，并行发
    const [ctx, ev] = await Promise.all([
      loadMatchCtx(c.env.DB, id),
      c.env.DB.prepare(
        "SELECT id, entry_id, player_id, type, minute FROM match_event WHERE id = ? AND match_id = ?"
      )
        .bind(eventId, id)
        .first<{
          id: number;
          entry_id: number;
          player_id: number | null;
          type: string;
          minute: number | null;
        }>(),
    ]);
    const m = ctx.m;
    if (!ev) return fail(c, 404, "事件不存在");
    // 删除 + 审计（+ live 时尾随实时比分查询）一个 batch 办完；完赛补录修正不需要比分
    const live = m.status === "live";
    const batch: D1PreparedStatement[] = [
      c.env.DB.prepare("DELETE FROM match_event WHERE id = ?").bind(eventId),
      auditStmt(c.env.DB, c.get("user")!.id, "event_delete", id, {
        eventId: ev.id,
        type: ev.type,
        entryId: ev.entry_id,
        playerId: ev.player_id,
        minute: ev.minute,
      }),
    ];
    if (live) batch.push(c.env.DB.prepare(LIVE_SCORE_SQL).bind(id));
    const batchRes = await c.env.DB.batch(batch);
    let scoreHome: number | null = m.score_home;
    let scoreAway: number | null = m.score_away;
    if (live) {
      const score = scoreFromRows(m, (batchRes[2].results ?? []) as ScoreRow[]);
      scoreHome = score.home;
      scoreAway = score.away;
    }
    return c.json({ ok: true, scoreHome, scoreAway });
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

// GET /:id/lineup：双方提交的战术阵容。管理员备案可见，无比赛状态门槛（公开端开赛后才放行）
// 附带双方战术码备案；公开端 lineup 不返回码
app.get("/:id/lineup", async (c) => {
  const mid = Number(c.req.param("id"));
  let lineup: MatchLineupDTO;
  let subs: { team_id: number; code: string }[];
  try {
    const [l, rows] = await Promise.all([
      fetchMatchLineup(c.env.DB, mid, false),
      c.env.DB.prepare(`SELECT team_id, code FROM tactic_submission WHERE match_id = ?`)
        .bind(mid)
        .all<{ team_id: number; code: string }>(),
    ]);
    lineup = l;
    subs = rows.results ?? [];
  } catch (e) {
    if (e instanceof LineupError) return fail(c, e.status, e.message);
    throw e;
  }
  const codeOf = (tid: number | null | undefined) =>
    tid == null ? "" : (subs.find((r) => r.team_id === tid)?.code ?? "");
  return c.json({
    ...lineup,
    homeCode: codeOf(lineup.home?.teamId),
    awayCode: codeOf(lineup.away?.teamId),
  });
});

export default app;
