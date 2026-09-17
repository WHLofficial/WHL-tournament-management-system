import { Hono } from "hono";
import type { AppEnv } from "../env";
import { generateCode, sha256Hex } from "../lib/crypto";
import {
  AuthApiError,
  authIssueTeamCode,
  authRegisterTeam,
  authUnbindTeam,
  teamCodes,
  teamMembers,
} from "../lib/authClient";
import { requirePermission, requirePwChanged } from "../middleware/auth";
import teamsRoutes from "./admin/teams";
import tournamentsRoutes from "./admin/tournaments";
import scheduleRoutes from "./admin/schedule";
import scoringRoutes from "./admin/scoring";
import accountsRoutes from "./admin/accounts";
import announcementsRoutes from "./admin/announcements";
import injuriesRoutes from "./admin/injuries";

const app = new Hono<AppEnv>();

// 管理台整体 ≡ 旧 requireAdmin（admin+superadmin 才持有 tour.match.manage，行为等价）。
// 兼容模式回落旧角色判定（见 middleware requirePermission）。
app.use("*", requirePermission("tour.match.manage"));
app.use("*", requirePwChanged);

app.route("/teams", teamsRoutes);
app.route("/tournaments", tournamentsRoutes);
app.route("/tournaments", scheduleRoutes);
app.route("/matches", scoringRoutes);
app.route("/accounts", accountsRoutes);
app.route("/announcements", announcementsRoutes);
app.route("/injuries", injuriesRoutes);

// 组织级设置：允许无码注册（建锁定观众号）。改开关仅超管
app.get("/org-settings", async (c) => {
  const row = await c.env.DB.prepare("SELECT allow_open_reg FROM organization WHERE id = 1")
    .first<{ allow_open_reg: number }>();
  return c.json({ allowOpenReg: row?.allow_open_reg === 1 });
});

app.put("/org-settings", requirePermission("tour.org.settings", "superadmin"), async (c) => {
  const body = await c.req.json<{ allowOpenReg?: boolean }>().catch(() => null);
  if (typeof body?.allowOpenReg !== "boolean") {
    return c.json({ message: "请求格式不对" }, 400);
  }
  await c.env.DB.prepare("UPDATE organization SET allow_open_reg = ? WHERE id = 1")
    .bind(body.allowOpenReg ? 1 : 0)
    .run();
  return c.json({ ok: true });
});

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

// 注册码使用记录（明码不可回查，只给次数/过期/状态）
app.get("/signup-codes", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, max_uses, used_count, expires_at, created_at FROM signup_code
     ORDER BY created_at DESC, id DESC LIMIT 50`
  ).all<{
    id: number;
    max_uses: number | null;
    used_count: number;
    expires_at: string | null;
    created_at: string;
  }>();
  return c.json({
    codes: (rows.results ?? []).map((r) => ({
      id: r.id,
      maxUses: r.max_uses,
      usedCount: r.used_count,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    })),
  });
});

// ---- 球队认证码（教练绑定用）：一次有效，默认 24h ----
// ---- 球队认证码（教练绑定用）：一次有效，默认 24h。
// 增量 7：码表与烧码收口认证中心；这里只代理发码。目录缺行时自愈登记后重试一次。 ----
app.post("/teams/:id/auth-codes", async (c) => {
  const teamId = Number(c.req.param("id"));
  const team = await c.env.DB.prepare("SELECT id, name FROM team WHERE id = ?")
    .bind(teamId)
    .first<{ id: number; name: string }>();
  if (!team) return c.json({ message: "球队不存在" }, 404);

  const body = await c.req.json<{ expiresInHours?: number }>().catch(() => null);
  const requested =
    typeof body?.expiresInHours === "number" && body.expiresInHours > 0
      ? body.expiresInHours
      : 24;
  const hours = Math.min(requested, 720); // auth 端上限 30 天
  const issue = async () => authIssueTeamCode(c.env, { tourTeamId: teamId, hours });
  let out: { code: string; expiresAt: string };
  try {
    out = await issue();
  } catch (e) {
    // 目录缺行自愈：建队后没登记过（register 失败/迁移前建的队）→ 登记后重试
    if (e instanceof AuthApiError && e.code === "team_not_found") {
      try {
        await authRegisterTeam(c.env, { tourTeamId: teamId, name: team.name });
      } catch {
        return c.json({ message: "认证中心暂不可用，请稍后再试" }, 502);
      }
      try {
        out = await issue();
      } catch {
        return c.json({ message: "认证中心暂不可用，请稍后再试" }, 502);
      }
    } else {
      return c.json({ message: "认证中心暂不可用，请稍后再试" }, 502);
    }
  }
  return c.json({ code: out.code, expiresAt: out.expiresAt }, 201);
});

app.get("/teams/:id/auth-codes", async (c) => {
  const teamId = Number(c.req.param("id"));
  return c.json({ codes: await teamCodes(c.env, teamId) });
});

app.get("/teams/:id/members", async (c) => {
  const teamId = Number(c.req.param("id"));
  return c.json({ members: await teamMembers(c.env, teamId) });
});

// 解绑教练（一账号一队，解绑后可凭新码绑别队）；真源在 auth，本地留审计
app.delete("/teams/:id/members/:userId", async (c) => {
  const teamId = Number(c.req.param("id"));
  const userId = Number(c.req.param("userId"));
  try {
    await authUnbindTeam(c.env, userId);
  } catch (e) {
    if (e instanceof AuthApiError) {
      if (e.code === "not_bound") return c.json({ message: "该账号未绑定球队" }, 404);
      if (e.code === "unconfigured") return c.json({ message: "认证中心通道未配置" }, 500);
      return c.json({ message: "认证中心暂不可用，请稍后再试" }, 502);
    }
    throw e;
  }
  await c.env.DB.prepare(
    `INSERT INTO audit_log (actor_user_id, action, target_type, target_id, detail_json)
     VALUES (?, ?, 'team_member', ?, ?)`
  )
    .bind(c.get("user")!.id, "team.unbind", userId, JSON.stringify({ teamId }))
    .run();
  return c.json({ ok: true });
});

export default app;
