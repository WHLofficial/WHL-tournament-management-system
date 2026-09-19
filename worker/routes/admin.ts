import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import {
  AuthApiError,
  authIssueTeamCode,
  authRegisterTeam,
  authUnbindTeam,
  teamCodes,
  teamMembers,
} from "../lib/authClient";
import {
  authAdminCreateSignupCode,
  authAdminListSignupCodes,
  authAdminOrgSettings,
} from "../lib/authAdmin";
import { accountAuditStmt } from "../lib/audit";
import { requirePermission, requirePwChanged } from "../middleware/auth";
import teamsRoutes from "./admin/teams";
import tournamentsRoutes from "./admin/tournaments";
import scheduleRoutes from "./admin/schedule";
import scoringRoutes from "./admin/scoring";
import accountsRoutes from "./admin/accounts";
import auditRoutes from "./admin/audit";
import announcementsRoutes from "./admin/announcements";
import injuriesRoutes from "./admin/injuries";
import proxyGrantsRoutes from "./admin/proxyGrants";

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
app.route("/audit", auditRoutes);
app.route("/announcements", announcementsRoutes);
app.route("/injuries", injuriesRoutes);
app.route("/proxy-grants", proxyGrantsRoutes);

// 认证中心通道错误的统一分流：业务码原样给前端文案，未配置/不可达归为 502
function authFail(c: Context<AppEnv>, e: unknown) {
  if (e instanceof AuthApiError) {
    if (e.code === "unconfigured") return c.json({ message: "认证中心通道未配置" }, 500);
    if (e.code === "account_not_found") return c.json({ message: "账号不存在" }, 404);
    if (e.code === "session_not_found") return c.json({ message: "会话不存在或已结束" }, 404);
    if (e.code === "self_forbidden") return c.json({ message: "不能对自己执行这个操作" }, 403);
    if (e.code === "superadmin_locked") {
      return c.json({ message: "超级管理员不能在管理台改动，请直接改库" }, 403);
    }
    if (e.code === "bad_role" || e.code === "bad_permission" || e.code === "bad body") {
      return c.json({ message: e.message || "请求格式不对" }, 400);
    }
    return c.json({ message: "认证中心暂不可用，请稍后再试" }, 502);
  }
  throw e;
}

// 组织级设置：允许无码注册（建锁定观众号）。改开关仅超管。
// 增量 8：真源在认证中心 organization 表（收口前这里读写本仓 organization，
// 改开关对 auth 注册路径零影响 = 死写）。读写都转发 auth，本地留审计。
app.get("/org-settings", async (c) => {
  try {
    const out = await authAdminOrgSettings(c.env);
    return c.json({ allowOpenReg: out.allowOpenReg });
  } catch (e) {
    return authFail(c, e);
  }
});

app.put("/org-settings", requirePermission("tour.org.settings", "superadmin"), async (c) => {
  const body = await c.req.json<{ allowOpenReg?: boolean }>().catch(() => null);
  if (typeof body?.allowOpenReg !== "boolean") {
    return c.json({ message: "请求格式不对" }, 400);
  }
  const me = c.get("user")!.id;
  try {
    const out = await authAdminOrgSettings(c.env, { allowOpenReg: body.allowOpenReg, actorId: me });
    await accountAuditStmt(c.env.DB, me, "org.open_reg", null, { allowOpenReg: out.allowOpenReg }).run();
    return c.json({ ok: true, allowOpenReg: out.allowOpenReg });
  } catch (e) {
    return authFail(c, e);
  }
});

// 生成注册码；明码只在这一次响应里出现，认证中心只存 sha256
app.post("/signup-codes", async (c) => {
  const body = await c.req
    .json<{ maxUses?: number | null; expiresInHours?: number | null }>()
    .catch(() => ({}) as { maxUses?: number | null; expiresInHours?: number | null });
  const maxUses = typeof body.maxUses === "number" && body.maxUses > 0 ? Math.floor(body.maxUses) : null;
  const expiresInHours =
    typeof body.expiresInHours === "number" && body.expiresInHours > 0 ? body.expiresInHours : null;
  const me = c.get("user")!.id;
  try {
    const out = await authAdminCreateSignupCode(c.env, { actorId: me, maxUses, expiresInHours });
    await accountAuditStmt(c.env.DB, me, "signup_code.create", null, {
      maxUses: out.maxUses,
      expiresAt: out.expiresAt,
    }).run();
    return c.json({ code: out.code, maxUses: out.maxUses, expiresAt: out.expiresAt }, 201);
  } catch (e) {
    return authFail(c, e);
  }
});

// 注册码使用记录（明码不可回查，只给指纹/次数/过期）
app.get("/signup-codes", async (c) => {
  try {
    return c.json({ codes: await authAdminListSignupCodes(c.env) });
  } catch (e) {
    return authFail(c, e);
  }
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
