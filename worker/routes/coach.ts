import { Hono } from "hono";
import type { AppEnv } from "../env";
import { sha256Hex } from "../lib/crypto";
import { rateLimit } from "../lib/ratelimit";
import { fetchMatchLineup, LineupError, validateLineupSlots } from "../lib/lineup";
import { requirePwChanged, requireUser } from "../middleware/auth";
import type { LineupSubmitBody } from "../../shared/types";

// 教练侧：凭认证码绑定球队 + 我的球队。一账号一队；解绑只走管理员接口。
const app = new Hono<AppEnv>();

app.use("*", requireUser);
app.use("*", requirePwChanged);

app.post("/bind", async (c) => {
  const user = c.get("user")!;
  // 观众号锁定：放限流前，不烧失败次数
  if (user.locked) {
    return c.json({ message: "你的账号暂不能绑定球队，请联系管理员解锁" }, 403);
  }
  // 按 IP 限尝试次数：10 分钟窗口 5 次（正常输入一次就成功，够防爆破）
  const ip = c.req.header("CF-Connecting-IP") ?? "local";
  const ok = await rateLimit(c.env, `bindfail:${ip}`, 5, 600);
  if (!ok) {
    return c.json({ message: "尝试太频繁，请 10 分钟后再来" }, 429);
  }

  const body = await c.req.json<{ code?: string }>().catch(() => null);
  const code = body?.code?.trim().toUpperCase();
  if (!code || code.length !== 8) {
    return c.json({ message: "认证码格式不对，应为 8 位字母数字" }, 400);
  }

  const hash = await sha256Hex(code);
  const row = await c.env.DB.prepare(
    `SELECT id, team_id, expires_at FROM auth_code
     WHERE code_hash = ? AND used_by IS NULL
       AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
  )
    .bind(hash)
    .first<{ id: number; team_id: number; expires_at: string | null }>();
  if (!row) {
    return c.json({ message: "认证码无效或已过期" }, 400);
  }

  // 一账号一队先查再插：查不出已绑时不烧码，提示更友好
  const existing = await c.env.DB.prepare(
    "SELECT team_id FROM team_member WHERE user_id = ?"
  )
    .bind(user.id)
    .first<{ team_id: number }>();
  if (existing) {
    return c.json({ message: "该账号已经绑定了球队，解绑需联系管理员" }, 409);
  }

  // 条件烧码防并发重复使用（两个请求同码竞速，只有一个能改到行）
  const burn = await c.env.DB.prepare(
    `UPDATE auth_code SET used_by = ?, used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND used_by IS NULL`
  )
    .bind(user.id, row.id)
    .run();
  if ((burn.meta.changes ?? 0) !== 1) {
    return c.json({ message: "认证码无效或已过期" }, 400);
  }
  try {
    await c.env.DB.prepare("INSERT INTO team_member (team_id, user_id) VALUES (?, ?)").bind(
      row.team_id,
      user.id,
    ).run();
  } catch {
    return c.json({ message: "该账号已经绑定了球队，解绑需联系管理员" }, 409);
  }
  return c.json({ ok: true, teamId: row.team_id });
});

// 我的球队（未绑定时 team 为 null）
app.get("/me/team", async (c) => {
  const user = c.get("user")!;
  const tm = await c.env.DB.prepare(
    "SELECT team_id FROM team_member WHERE user_id = ?"
  )
    .bind(user.id)
    .first<{ team_id: number }>();
  if (!tm) return c.json({ team: null });

  const team = await c.env.DB.prepare("SELECT id, name FROM team WHERE id = ?")
    .bind(tm.team_id)
    .first<{ id: number; name: string }>();
  const [players, members, entries] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, name, number FROM player WHERE team_id = ?
       ORDER BY (number IS NULL), CAST(number AS INTEGER), number, id`
    )
      .bind(tm.team_id)
      .all<{ id: number; name: string; number: string | null }>(),
    c.env.DB.prepare(
      `SELECT u.id, u.name, tm.created_at FROM team_member tm
       JOIN user u ON u.id = tm.user_id WHERE tm.team_id = ? ORDER BY tm.created_at`
    )
      .bind(tm.team_id)
      .all<{ id: number; name: string; created_at: string }>(),
    c.env.DB.prepare(
      `SELECT e.id, t.name AS tournament_name, t.status, g.name AS group_name, e.seed
       FROM entry e
       JOIN tournament t ON t.id = e.tournament_id
       LEFT JOIN "group" g ON g.id = e.group_id
       WHERE e.team_id = ? ORDER BY t.created_at DESC`
    )
      .bind(tm.team_id)
      .all<{
        id: number;
        tournament_name: string;
        status: string;
        group_name: string | null;
        seed: number;
      }>(),
  ]);
  return c.json({
    team: {
      id: team?.id ?? tm.team_id,
      name: team?.name ?? "",
      players: players.results.map((p) => ({
        id: p.id,
        name: p.name,
        number: p.number,
      })),
      members: members.results.map((m) => ({
        id: m.id,
        name: m.name,
        joinedAt: m.created_at,
      })),
      entries: entries.results.map((e) => ({
        id: e.id,
        tournamentName: e.tournament_name,
        status: e.status,
        groupName: e.group_name,
        seed: e.seed,
      })),
    },
  });
});

// 教练侧写入口约定：阵容提交是唯一的教练写赛事数据端点（一赛一队一份，重复提交覆盖）。
// 可见性：赛前仅管理员可见（备案）；开赛（live）后公开。教练回显只看得到自己那份，看不到对手的。

async function teamIdOf(db: D1Database, userId: number): Promise<number | null> {
  const tm = await db
    .prepare("SELECT team_id FROM team_member WHERE user_id = ?")
    .bind(userId)
    .first<{ team_id: number }>();
  return tm?.team_id ?? null;
}

// 本队待开的比赛：选一场提交阵容用。轮空场排除（没有对阵意义）
app.get("/me/matches", async (c) => {
  const user = c.get("user")!;
  const teamId = await teamIdOf(c.env.DB, user.id);
  if (!teamId) return c.json({ matches: [] });
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.round, m.leg, m.note,
       t.id AS tournament_id, t.name AS tournament_name,
       s.name AS stage_name, s.kind AS stage_kind,
       he.team_id AS home_tid, ae.team_id AS away_tid,
       ht.name AS home_team_name, at.name AS away_team_name,
       ts.id AS sub_id
     FROM match m
     JOIN stage s ON s.id = m.stage_id
     JOIN tournament t ON t.id = s.tournament_id
     LEFT JOIN entry he ON he.id = m.home_entry_id
     LEFT JOIN entry ae ON ae.id = m.away_entry_id
     LEFT JOIN team ht ON ht.id = he.team_id
     LEFT JOIN team at ON at.id = ae.team_id
     LEFT JOIN tactic_submission ts ON ts.match_id = m.id AND ts.team_id = ?
     WHERE m.status = 'pending' AND t.status != 'draft'
       AND (m.note IS NULL OR m.note != '轮空')
       AND (he.team_id = ? OR ae.team_id = ?)
     ORDER BY t.created_at DESC, s.sort_order, m.round, m.slot`,
  )
    .bind(teamId, teamId, teamId)
    .all<{
      id: number;
      round: number;
      leg: number | null;
      tournament_id: number;
      tournament_name: string;
      stage_name: string | null;
      stage_kind: "elim" | "round_robin" | "group";
      home_tid: number | null;
      away_tid: number | null;
      home_team_name: string | null;
      away_team_name: string | null;
      sub_id: number | null;
    }>();
  return c.json({
    matches: (rows.results ?? []).map((r) => {
      const side: "home" | "away" = r.home_tid === teamId ? "home" : "away";
      return {
        id: r.id,
        tournamentId: r.tournament_id,
        tournamentName: r.tournament_name,
        stageName: r.stage_name,
        stageKind: r.stage_kind,
        round: r.round,
        leg: r.leg,
        side,
        opponentName: side === "home" ? r.away_team_name : r.home_team_name,
        submitted: r.sub_id !== null,
      };
    }),
  });
});

// 我在某场比赛已提交的阵容（提交面板回显；只回自己那份，对手的赛前看不到）
app.get("/matches/:mid/lineup", async (c) => {
  const user = c.get("user")!;
  const teamId = await teamIdOf(c.env.DB, user.id);
  if (!teamId) return c.json({ lineup: null });
  const mid = Number(c.req.param("mid"));
  let lineup;
  try {
    lineup = await fetchMatchLineup(c.env.DB, mid, false);
  } catch (e) {
    if (e instanceof LineupError) return c.json({ message: e.message }, e.status);
    throw e;
  }
  const mine =
    lineup.home?.teamId === teamId ? lineup.home : lineup.away?.teamId === teamId ? lineup.away : null;
  return c.json({ lineup: mine });
});

// 提交/覆盖阵容：比赛须属于本队且未开打；球员必须都在本队名单里
app.put("/matches/:mid/lineup", async (c) => {
  const user = c.get("user")!;
  if (user.locked) return c.json({ message: "你的账号暂不能提交阵容，请联系管理员解锁" }, 403);
  const teamId = await teamIdOf(c.env.DB, user.id);
  if (!teamId) return c.json({ message: "请先绑定球队再提交阵容" }, 403);
  const ip = c.req.header("CF-Connecting-IP") ?? "local";
  if (!(await rateLimit(c.env, `tsub:${ip}:${user.id}`, 10, 60))) {
    return c.json({ message: "提交太频繁，请一分钟后再试" }, 429);
  }

  const body = await c.req.json<LineupSubmitBody>().catch(() => null);
  if (!body || typeof body.form !== "string" || !Array.isArray(body.slots)) {
    return c.json({ message: "请求格式不对" }, 400);
  }
  let slots;
  try {
    slots = validateLineupSlots(body.form, body.slots);
  } catch (e) {
    if (e instanceof LineupError) return c.json({ message: e.message }, e.status);
    throw e;
  }

  const mid = Number(c.req.param("mid"));
  const m = await c.env.DB.prepare(
    `SELECT m.status, he.team_id AS home_tid, ae.team_id AS away_tid
     FROM match m
     LEFT JOIN entry he ON he.id = m.home_entry_id
     LEFT JOIN entry ae ON ae.id = m.away_entry_id
     WHERE m.id = ?`,
  )
    .bind(mid)
    .first<{
      status: "pending" | "live" | "finished";
      home_tid: number | null;
      away_tid: number | null;
    }>();
  if (!m || (m.home_tid !== teamId && m.away_tid !== teamId)) {
    return c.json({ message: "比赛不存在或不属于你的球队" }, 404);
  }
  if (m.status !== "pending") {
    return c.json({ message: "比赛已开打，阵容已锁定" }, 409);
  }

  const ids = [...new Set(slots.map((s) => s.player_id))];
  const owned = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM player WHERE team_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(teamId, ...ids)
    .first<{ n: number }>();
  if (owned?.n !== ids.length) {
    return c.json({ message: "名单里有不属于你球队的球员，请回战术板重选" }, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO tactic_submission (match_id, team_id, created_by, form, slots_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(match_id, team_id) DO UPDATE SET
       created_by = excluded.created_by,
       form = excluded.form,
       slots_json = excluded.slots_json,
       created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(mid, teamId, user.id, body.form, JSON.stringify(slots))
    .run();
  return c.json({ ok: true });
});

export default app;
