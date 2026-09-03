import { Hono } from "hono";
import type { AppEnv } from "../env";
import { sha256Hex } from "../lib/crypto";
import { rateLimit } from "../lib/ratelimit";

// 教练侧：凭认证码绑定球队 + 我的球队。一账号一队；解绑只走管理员接口。
const app = new Hono<AppEnv>();

app.post("/bind", async (c) => {
  const user = c.get("user")!;
  // 认证码爆破防线：按 IP 限流，5 次失败锁 10 分钟
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

  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE auth_code SET used_by = ?, used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
      ).bind(user.id, row.id),
      c.env.DB.prepare("INSERT INTO team_member (team_id, user_id) VALUES (?, ?)").bind(
        row.team_id,
        user.id,
      ),
    ]);
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
       ORDER BY (number IS NULL), number, id`
    )
      .bind(tm.team_id)
      .all<{ id: number; name: string; jersey: number | null }>(),
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

export default app;
