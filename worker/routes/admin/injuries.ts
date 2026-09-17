// 伤停登记路由：登记必须挂一次伤病事件（injury_minor / injury_major），
// 勾选缺阵比赛（可跨赛事、不限于未开赛——支持补录）。出阵不拦截，登记只是记录。
// 删伤病事件 → 登记随 FK 级联消失（误录语义，见 scoring.ts 的删事件提示）。
import { Hono } from "hono";
import type { AppEnv } from "../../env";
import { auditStmt } from "../../lib/audit";
import { listAllInjuries, listRegistrableInjuryEvents, listTeamInjuries, listTeamMissCandidates } from "../../lib/injury";
import { findInjuryCatalog, severityOfEventType } from "../../../shared/injuries";
import type {
  InjuryCandidatesResp,
  InjuryEventCandidatesResp,
  InjuryStatusDTO,
} from "../../../shared/types";

const app = new Hono<AppEnv>();

// GET /injuries?teamId=：登记列表。带 teamId → 该队（球队页）；不带 → 全部（集中管理页）
app.get("/", async (c) => {
  const q = c.req.query("teamId");
  if (q != null && q !== "") {
    const teamId = Number(q);
    if (!Number.isInteger(teamId) || teamId <= 0)
      return c.json({ message: "teamId 不合法" }, 400);
    const injuries = await listTeamInjuries(c.env.DB, teamId);
    return c.json({ injuries } satisfies { injuries: InjuryStatusDTO[] });
  }
  const injuries = await listAllInjuries(c.env.DB);
  return c.json({ injuries } satisfies { injuries: InjuryStatusDTO[] });
});

// GET /injuries/events：已记伤病事件但还没有登记的事件（集中页的「待登记」清单）
app.get("/events", async (c) => {
  const events = await listRegistrableInjuryEvents(c.env.DB);
  return c.json({ events } satisfies InjuryEventCandidatesResp);
});

// GET /injuries/candidates?teamId=：该队可勾选为缺阵的比赛（跨赛事、含已完赛）
app.get("/candidates", async (c) => {
  const teamId = Number(c.req.query("teamId"));
  if (!Number.isInteger(teamId) || teamId <= 0)
    return c.json({ message: "缺少 teamId" }, 400);
  const candidates = await listTeamMissCandidates(c.env.DB, teamId);
  return c.json({ candidates } satisfies InjuryCandidatesResp);
});

// POST /injuries：新建登记
// { eventId, playerId, injuryName?, note?, missMatchIds?[] }
app.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    eventId?: number;
    playerId?: number;
    injuryName?: string | null;
    note?: string | null;
    missMatchIds?: number[];
  } | null;
  if (!body || !Number.isInteger(body.eventId) || body.eventId! <= 0)
    return c.json({ message: "缺少伤病事件 eventId" }, 400);
  // 字段类型先兜住：非字符串/非数组（客户端乱传）当空处理，别让 .trim()/filter 抛 500
  const note = typeof body.note === "string" ? body.note.trim() || null : null;
  if (note && note.length > 200) return c.json({ message: "备注最多 200 字" }, 400);
  const missIds = Array.isArray(body.missMatchIds)
    ? body.missMatchIds.filter((x) => Number.isInteger(x) && x > 0)
    : [];
  if (new Set(missIds).size !== missIds.length)
    return c.json({ message: "缺阵比赛不能重复勾选" }, 400);

  const ev = await c.env.DB.prepare(
    `SELECT me.id, me.entry_id, me.player_id, me.type, me.match_id,
            e.team_id, m.stage_id, s.tournament_id
     FROM match_event me
     JOIN entry e ON e.id = me.entry_id
     JOIN match m ON m.id = me.match_id
     JOIN stage s ON s.id = m.stage_id
     WHERE me.id = ? AND me.type IN ('injury_minor', 'injury_major')`
  )
    .bind(body.eventId)
    .first<{
      id: number;
      entry_id: number;
      player_id: number | null;
      type: string;
      match_id: number;
      team_id: number;
      stage_id: number;
      tournament_id: number;
    }>();
  if (!ev) return c.json({ message: "伤病事件不存在（只支持 injury_minor / injury_major）" }, 404);

  const severity = severityOfEventType(ev.type as "injury_minor" | "injury_major");
  // 球员取事件上记的人；事件没记球员时必须补传（事件记的是谁，伤就是谁的）
  if (body.playerId != null && body.playerId !== ev.player_id)
    return c.json({ message: "球员与伤病事件记录的球员不一致，请先修正事件" }, 400);
  const playerId = ev.player_id ?? body.playerId ?? null;
  if (!playerId) return c.json({ message: "伤病事件未记录球员，请先在事件里补上球员" }, 400);

  const name = typeof body.injuryName === "string" ? body.injuryName.trim() || null : null;
  if (name) {
    const item = findInjuryCatalog(name);
    if (!item) return c.json({ message: "伤病名不在名库中，请从列表选择" }, 400);
    if (item.severity !== severity)
      return c.json({ message: `该事件是${severity === "major" ? "重" : "轻"}伤，请选择${severity === "major" ? "重" : "轻"}伤档伤病名` }, 400);
  }

  // 已挂登记拒绝重复建（一个事件一条登记）
  const dup = await c.env.DB.prepare("SELECT id FROM injury WHERE event_id = ?")
    .bind(ev.id)
    .first<{ id: number }>();
  if (dup) return c.json({ message: "该伤病事件已建过登记，请直接编辑" }, 409);

  // 校验勾选的比赛：必须都是该队参加的比赛（跨赛事允许，任意状态允许；
  // away 可为 NULL 的未编排场用 LEFT JOIN 兜住）
  if (missIds.length) {
    const ok = await c.env.DB.prepare(
      `SELECT m.id FROM match m
       JOIN entry e1 ON e1.id = m.home_entry_id
       LEFT JOIN entry e2 ON e2.id = m.away_entry_id
       WHERE m.id IN (${missIds.map(() => "?").join(",")})
         AND (e1.team_id = ? OR e2.team_id = ?)`
    )
      .bind(...missIds, ev.team_id, ev.team_id)
      .all<{ id: number }>();
    const found = new Set((ok.results ?? []).map((r) => r.id));
    const bad = missIds.filter((x) => !found.has(x));
    if (bad.length) return c.json({ message: `比赛 ${bad.join(", ")} 不是该队的比赛` }, 400);
  }

  const batch: D1PreparedStatement[] = [
    c.env.DB
      .prepare(
        `INSERT INTO injury (team_id, player_id, event_id, injury_name, note, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(ev.team_id, playerId, ev.id, name, note, c.get("user")!.id),
    auditStmt(c.env.DB, c.get("user")!.id, "injury_create", ev.match_id, {
      eventId: ev.id,
      playerId,
      teamId: ev.team_id,
      injuryName: name,
      missMatchIds: missIds,
    }),
  ];
  for (const mid of missIds) {
    batch.push(
      c.env.DB.prepare(
        "INSERT INTO injury_miss (injury_id, match_id) VALUES ((SELECT id FROM injury WHERE event_id = ?), ?)"
      ).bind(ev.id, mid)
    );
  }
  try {
    await c.env.DB.batch(batch);
  } catch (e) {
    // 上面的 dup 预检挡不住并发双提交，event_id 唯一索引（0022）兜底：撞上就当重复登记处理
    if (String(e).includes("UNIQUE constraint failed"))
      return c.json({ message: "该伤病事件已建过登记，请直接编辑" }, 409);
    throw e;
  }
  return c.json({ ok: true });
});

// PUT /injuries/:id：编辑登记（换伤病名/备注/重勾缺阵；事件挂靠不可改——误挂就删掉重建）
app.put("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => null)) as {
    injuryName?: string | null;
    note?: string | null;
    missMatchIds?: number[];
  } | null;
  if (!body) return c.json({ message: "请求体无效" }, 400);
  const note = typeof body.note === "string" ? body.note.trim() || null : null;
  if (note && note.length > 200) return c.json({ message: "备注最多 200 字" }, 400);
  const missIds = Array.isArray(body.missMatchIds)
    ? body.missMatchIds.filter((x) => Number.isInteger(x) && x > 0)
    : [];
  if (new Set(missIds).size !== missIds.length)
    return c.json({ message: "缺阵比赛不能重复勾选" }, 400);

  const row = await c.env.DB.prepare(
    `SELECT i.id, i.team_id, i.event_id, i.injury_name, me.type AS event_type, me.match_id
     FROM injury i
     JOIN match_event me ON me.id = i.event_id
     WHERE i.id = ?`
  )
    .bind(id)
    .first<{
      id: number;
      team_id: number;
      event_id: number;
      injury_name: string | null;
      event_type: string;
      match_id: number;
    }>();
  if (!row) return c.json({ message: "登记不存在" }, 404);

  const severity = severityOfEventType(row.event_type as "injury_minor" | "injury_major");
  const name = typeof body.injuryName === "string" ? body.injuryName.trim() || null : null;
  if (name) {
    const item = findInjuryCatalog(name);
    if (!item) return c.json({ message: "伤病名不在名库中，请从列表选择" }, 400);
    if (item.severity !== severity)
      return c.json({ message: `该事件是${severity === "major" ? "重" : "轻"}伤，请选择${severity === "major" ? "重" : "轻"}伤档伤病名` }, 400);
  }

  if (missIds.length) {
    const ok = await c.env.DB.prepare(
      `SELECT m.id FROM match m
       JOIN entry e1 ON e1.id = m.home_entry_id
       LEFT JOIN entry e2 ON e2.id = m.away_entry_id
       WHERE m.id IN (${missIds.map(() => "?").join(",")})
         AND (e1.team_id = ? OR e2.team_id = ?)`
    )
      .bind(...missIds, row.team_id, row.team_id)
      .all<{ id: number }>();
    const found = new Set((ok.results ?? []).map((r) => r.id));
    const bad = missIds.filter((x) => !found.has(x));
    if (bad.length) return c.json({ message: `比赛 ${bad.join(", ")} 不是该队的比赛` }, 400);
  }

  const batch: D1PreparedStatement[] = [
    c.env.DB
      .prepare("UPDATE injury SET injury_name = ?, note = ? WHERE id = ?")
      .bind(name, note, id),
    c.env.DB.prepare("DELETE FROM injury_miss WHERE injury_id = ?").bind(id),
    auditStmt(c.env.DB, c.get("user")!.id, "injury_update", row.match_id, {
      injuryId: id,
      before: { injuryName: row.injury_name },
      after: { injuryName: name, note, missMatchIds: missIds },
    }),
  ];
  for (const mid of missIds) {
    batch.push(
      c.env.DB.prepare("INSERT INTO injury_miss (injury_id, match_id) VALUES (?, ?)").bind(id, mid)
    );
  }
  await c.env.DB.batch(batch);
  return c.json({ ok: true });
});

// DELETE /injuries/:id：撤销登记（误登即撤；缺阵勾选与登记一起消失）
app.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare(
    `SELECT i.id, i.event_id, i.player_id, me.match_id
     FROM injury i JOIN match_event me ON me.id = i.event_id WHERE i.id = ?`
  )
    .bind(id)
    .first<{ id: number; event_id: number; player_id: number | null; match_id: number }>();
  if (!row) return c.json({ message: "登记不存在" }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM injury WHERE id = ?").bind(id),
    auditStmt(c.env.DB, c.get("user")!.id, "injury_delete", row.match_id, {
      injuryId: id,
      eventId: row.event_id,
      playerId: row.player_id,
    }),
  ]);
  return c.json({ ok: true });
});

export default app;
