import { Hono } from "hono";
import type { AppEnv } from "../env";
import { generateCode, sha256Hex } from "../lib/crypto";
import { requireAdmin } from "../middleware/auth";
import teamsRoutes from "./admin/teams";
import tournamentsRoutes from "./admin/tournaments";
import scheduleRoutes from "./admin/schedule";
import scoringRoutes from "./admin/scoring";

const app = new Hono<AppEnv>();

app.use("*", requireAdmin);

app.route("/teams", teamsRoutes);
app.route("/tournaments", tournamentsRoutes);
app.route("/tournaments", scheduleRoutes);
app.route("/matches", scoringRoutes);

// 生成注册码；明码只在这一次响应里出现，库存 sha256
app.post("/signup-codes", async (c) => {
  const body = await c.req
    .json<{ maxUses?: number | null; expiresInHours?: number | null }>()
    .catch(() => ({}) as { maxUses?: number | null; expiresInHours?: number | null });
  const maxUses = typeof body.maxUses === "number" && body.maxUses > 0 ? Math.floor(body.maxUses) : null;
  const expiresInHours =
    typeof body.expiresInHours === "number" && body.expiresInHours > 0 ? body.expiresInHours : null;
  const expiresAt = expiresInHours ? new Date(Date.now() + expiresInHours * 3600_000).toISOString() : null;

  const code = generateCode(8);
  await c.env.DB.prepare(
    "INSERT INTO signup_code (code_hash, expires_at, max_uses, created_by) VALUES (?, ?, ?, ?)",
  )
    .bind(await sha256Hex(code), expiresAt, maxUses, c.get("user")!.id)
    .run();
  return c.json({ code, maxUses, expiresAt }, 201);
});

// ---- 球队认证码（教练绑定用）：一次有效，默认 24h ----
app.post("/teams/:id/auth-codes", async (c) => {
  const teamId = Number(c.req.param("id"));
  const team = await c.env.DB.prepare("SELECT id FROM team WHERE id = ?")
    .bind(teamId)
    .first<{ id: number }>();
  if (!team) return c.json({ message: "球队不存在" }, 404);

  const body = await c.req.json<{ expiresInHours?: number }>().catch(() => null);
  const hours =
    typeof body?.expiresInHours === "number" && body.expiresInHours > 0
      ? body.expiresInHours
      : 24;
  const expiresAt = new Date(Date.now() + hours * 3600_000).toISOString();
  const code = generateCode(8);
  await c.env.DB.prepare(
    "INSERT INTO auth_code (team_id, code_hash, expires_at, created_by) VALUES (?, ?, ?, ?)"
  )
    .bind(teamId, await sha256Hex(code), expiresAt, c.get("user")!.id)
    .run();
  return c.json({ code, expiresAt }, 201);
});

app.get("/teams/:id/auth-codes", async (c) => {
  const teamId = Number(c.req.param("id"));
  const rows = await c.env.DB.prepare(
    `SELECT id, expires_at, used_by, used_at, created_at FROM auth_code
     WHERE team_id = ? ORDER BY created_at DESC LIMIT 20`
  )
    .bind(teamId)
    .all<{
      id: number;
      expires_at: string | null;
      used_by: number | null;
      used_at: string | null;
      created_at: string;
    }>();
  return c.json({
    codes: rows.results.map((r) => ({
      id: r.id,
      expiresAt: r.expires_at,
      used: r.used_by !== null,
      usedAt: r.used_at,
      createdAt: r.created_at,
    })),
  });
});

app.get("/teams/:id/members", async (c) => {
  const teamId = Number(c.req.param("id"));
  const rows = await c.env.DB.prepare(
    `SELECT tm.user_id, u.name, tm.created_at FROM team_member tm
     JOIN user u ON u.id = tm.user_id WHERE tm.team_id = ? ORDER BY tm.created_at`
  )
    .bind(teamId)
    .all<{ user_id: number; name: string; created_at: string }>();
  return c.json({
    members: rows.results.map((r) => ({
      userId: r.user_id,
      name: r.name,
      joinedAt: r.created_at,
    })),
  });
});

// 解绑教练（一账号一队，解绑后可凭新码绑别队）
app.delete("/teams/:id/members/:userId", async (c) => {
  const teamId = Number(c.req.param("id"));
  const userId = Number(c.req.param("userId"));
  await c.env.DB.prepare("DELETE FROM team_member WHERE team_id = ? AND user_id = ?")
    .bind(teamId, userId)
    .run();
  return c.json({ ok: true });
});

export default app;
