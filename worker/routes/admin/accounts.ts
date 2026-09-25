import { Hono } from "hono";
import type { AppEnv } from "../../env";
import { AuthApiError } from "../../lib/authClient";
import {
  authAdminAccountDetail,
  authAdminCatalog,
  authAdminDisable,
  authAdminListAccounts,
  authAdminResetPassword,
  authAdminRevokeSessions,
  authAdminSetGrants,
  authAdminSetRoles,
  authAdminUnlock,
} from "../../lib/authAdmin";
import { accountAuditStmt } from "../../lib/audit";
// 账号管理 ≡ 旧 requireSuperadmin（superadmin 专属权限点，行为等价）
import { requirePermission } from "../../middleware/auth";

const app = new Hono<AppEnv>();

app.use("*", requirePermission("tour.accounts.manage", "superadmin"));

// v2.0.0：账号真源在 auth（account / credential / user_role）。本仓不再读写自己的 user 表——
// 收口后那些写是死写（改角色不影响鉴权、重置出的临时密码登不进去）。这里只做两件事：
// 转发到 auth 的 /api/admin/*，以及记一条本地审计（谁在管理台按了哪个按钮）。
//
// 错误分流：auth 的业务码原样回给前端（前端按码出文案），通道未配置/不可达统一 502。
function fail(c: import("hono").Context<AppEnv>, e: unknown) {
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

/** 操作者身份：权威身份来自会话（c.get("user")），不接受前端传的 id。 */
const actorOf = (c: import("hono").Context<AppEnv>) => c.get("user")!.id;

const intOf = (c: import("hono").Context<AppEnv>): number | null => {
  const id = Number(c.req.param("id"));
  return Number.isInteger(id) && id > 0 ? id : null;
};

// 角色 / 权限点目录：界面渲染勾选项用。auth 侧有 isolate 级 60s 缓存。
app.get("/catalog", async (c) => {
  try {
    return c.json(await authAdminCatalog(c.env));
  } catch (e) {
    return fail(c, e);
  }
});

// 账号列表（角色 + 绑定球队随列表一次带出；会话不进列表，只有详情报）
app.get("/", async (c) => {
  const q = c.req.query("q")?.trim() || undefined;
  try {
    return c.json({ accounts: await authAdminListAccounts(c.env, { q }) });
  } catch (e) {
    return fail(c, e);
  }
});

// 账号详情：角色、额外权限点、活跃会话（IP/登录时间/最后活跃）、QQ 绑定
app.get("/:id", async (c) => {
  const id = intOf(c);
  if (id === null) return c.json({ message: "账号不存在" }, 404);
  try {
    return c.json(await authAdminAccountDetail(c.env, { accountId: id, actorId: actorOf(c) }));
  } catch (e) {
    return fail(c, e);
  }
});

// 角色授权：传「应有的角色全集」，auth 端算差集（幂等）。本仓按差集记本地审计。
app.patch("/:id/roles", async (c) => {
  const id = intOf(c);
  if (id === null) return c.json({ message: "账号不存在" }, 404);
  const body = await c.req.json<{ roles?: unknown }>().catch(() => null);
  if (!Array.isArray(body?.roles)) return c.json({ message: "roles 必须是数组" }, 400);
  const next = body.roles.map(String);
  const me = actorOf(c);
  try {
    const out = await authAdminSetRoles(c.env, { accountId: id, actorId: me, roles: next });
    // 差集由 auth 回在响应里，本地审计不必再回查详情（省一次机器调用）
    if (out.changed) {
      await c.env.DB.batch([
        ...out.granted.map((k) => accountAuditStmt(c.env.DB, me, "role.grant", id, { role: k })),
        ...out.revoked.map((k) => accountAuditStmt(c.env.DB, me, "role.revoke", id, { role: k })),
      ]);
    }
    return c.json({ ok: true, changed: out.changed, roles: next });
  } catch (e) {
    return fail(c, e);
  }
});

// 权限点额外授予（只加不减：取消勾选只删这一层，角色带来的权限点不受影响）
app.put("/:id/grants", async (c) => {
  const id = intOf(c);
  if (id === null) return c.json({ message: "账号不存在" }, 404);
  const body = await c.req.json<{ permissions?: unknown }>().catch(() => null);
  if (!Array.isArray(body?.permissions)) return c.json({ message: "permissions 必须是数组" }, 400);
  const next = body.permissions.map(String);
  const me = actorOf(c);
  try {
    const out = await authAdminSetGrants(c.env, { accountId: id, actorId: me, permissions: next });
    if (out.changed) {
      await c.env.DB.batch([
        ...out.granted.map((k) => accountAuditStmt(c.env.DB, me, "perm.grant", id, { permission: k })),
        ...out.revoked.map((k) => accountAuditStmt(c.env.DB, me, "perm.revoke", id, { permission: k })),
      ]);
    }
    return c.json({ ok: true, changed: out.changed, permissions: next });
  } catch (e) {
    return fail(c, e);
  }
});

// 重置密码：临时密码只在本次响应出现；auth 会同时置 must_change_pw 并吊销该账号全部会话
app.post("/:id/reset-password", async (c) => {
  const id = intOf(c);
  if (id === null) return c.json({ message: "账号不存在" }, 404);
  const me = actorOf(c);
  try {
    const out = await authAdminResetPassword(c.env, { accountId: id, actorId: me });
    await accountAuditStmt(c.env.DB, me, "pw.reset", id, { sessionsRevoked: out.sessionsRevoked }).run();
    return c.json({ tempPassword: out.tempPassword, sessionsRevoked: out.sessionsRevoked });
  } catch (e) {
    return fail(c, e);
  }
});

// 解锁观众号（locked 1→0）。locked 不是封禁，是「观众号」标记：解锁前不能绑队。
app.post("/:id/unlock", async (c) => {
  const id = intOf(c);
  if (id === null) return c.json({ message: "账号不存在" }, 404);
  const me = actorOf(c);
  try {
    const out = await authAdminUnlock(c.env, { accountId: id, actorId: me });
    if (out.changed) await accountAuditStmt(c.env.DB, me, "account.unlock", id, null).run();
    return c.json({ ok: true, changed: out.changed });
  } catch (e) {
    return fail(c, e);
  }
});

// 停用 / 启用：停用后登录被拒、全部会话（含 OIDC refresh）即时吊销
app.post("/:id/disable", async (c) => {
  const id = intOf(c);
  if (id === null) return c.json({ message: "账号不存在" }, 404);
  const body = await c.req.json<{ disabled?: unknown }>().catch(() => null);
  if (typeof body?.disabled !== "boolean") return c.json({ message: "缺少 disabled（布尔）" }, 400);
  const me = actorOf(c);
  try {
    const out = await authAdminDisable(c.env, { accountId: id, actorId: me, disabled: body.disabled });
    if (out.changed) {
      await accountAuditStmt(
        c.env.DB,
        me,
        body.disabled ? "account.disable" : "account.enable",
        id,
        body.disabled ? { sessionsRevoked: out.sessionsRevoked } : null
      ).run();
    }
    return c.json({ ok: true, changed: out.changed, sessionsRevoked: out.sessionsRevoked });
  } catch (e) {
    return fail(c, e);
  }
});

// 强制下线：带 sessionHash 踢单个会话；不带则吊销该账号全部会话
app.post("/:id/sessions/revoke", async (c) => {
  const id = intOf(c);
  if (id === null) return c.json({ message: "账号不存在" }, 404);
  const body = await c.req.json<{ sessionHash?: unknown }>().catch(() => null);
  const sessionHash = typeof body?.sessionHash === "string" && body.sessionHash ? body.sessionHash : undefined;
  const me = actorOf(c);
  try {
    const out = await authAdminRevokeSessions(c.env, { accountId: id, actorId: me, sessionHash });
    if (out.revoked > 0) {
      await accountAuditStmt(c.env.DB, me, "session.revoke", id, {
        scope: sessionHash ? "one" : "account",
        sid: sessionHash ? sessionHash.slice(0, 12) : null,
        revoked: out.revoked,
      }).run();
    }
    return c.json({ ok: true, revoked: out.revoked });
  } catch (e) {
    return fail(c, e);
  }
});

export default app;
