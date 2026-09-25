import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { verifyPassword } from "../lib/crypto"; // 仅 login 兼容分支用（user 表只读）
import { rateLimit } from "../lib/ratelimit";
import { createSession, destroyOidcSession, destroySession, isStaleOidcSession } from "../lib/session";
import { deleteCookie, getCookie } from "hono/cookie";
import { OIDC_PROBE_COOKIE, OIDC_SESSION_COOKIE } from "../lib/oidc";
import { isOidc } from "../lib/oidc";
import { boundTeamId } from "../lib/authClient";
import { requireUser } from "../middleware/auth";
import type { MeEnvelope, MeResp } from "../../shared/types";

const app = new Hono<AppEnv>();

function clientIp(c: { req: { header(name: string): string | undefined } }): string {
  return c.req.header("CF-Connecting-IP") ?? "local";
}

async function teamIdOf(c: Context<AppEnv>, userId: number): Promise<number | null> {
  // v1.0.0：绑定真源在 auth 库（team_binding），本仓只读派生
  return boundTeamId(c.env, userId);
}

// 注册收口到认证中心（v3.0.0 残留清理：兼容模式直写 user 表的分支已删，user 表转只读；
// 兼容模式下本端点返回 410，注册走认证中心）
app.post("/register", (c) =>
  isOidc(c.env)
    ? c.redirect(`${c.env.OIDC_ISSUER}/register`, 302)
    : c.json({ error: "gone", message: "注册已收口到统一认证中心，请前往认证中心注册" }, 410),
);

app.post("/login", async (c) => {
  // OIDC 模式：登录收口到认证中心，本端点退化为跳 RP 登录发起（旧前端入口兜底）
  if (isOidc(c.env)) return c.redirect("/api/auth/login", 302);
  const ip = clientIp(c);
  if (!(await rateLimit(c.env, `login-ip:${ip}`, 10, 900)))
    return c.json({ error: "rate_limited", message: "尝试太频繁，请 15 分钟后再来" }, 429);

  const body = await c.req.json<{ name?: string; password?: string }>().catch(() => null);
  if (!body) return c.json({ error: "bad_request", message: "请求格式不对" }, 400);
  const name = (body.name ?? "").trim();
  if (!name) return c.json({ error: "bad_request", message: "请输入昵称" }, 400);
  if (!(await rateLimit(c.env, `login-name:${name}`, 5, 900)))
    return c.json({ error: "rate_limited", message: "这个账号尝试太频繁，请 15 分钟后再来" }, 429);

  const row = await c.env.DB.prepare(
    "SELECT id, name, role, locked, must_change_pw, password_hash FROM user WHERE name = ?",
  )
    .bind(name)
    .first<{ id: number; name: string; role: MeResp["role"]; locked: number; must_change_pw: number; password_hash: string }>();
  if (!row || !(await verifyPassword(body.password ?? "", row.password_hash)))
    return c.json({ error: "unauthorized", message: "昵称或密码不正确" }, 401);

  await createSession(c, row.id);
  const resp: MeResp = {
    id: row.id,
    name: row.name,
    role: row.role,
    teamId: await teamIdOf(c, row.id),
    locked: row.locked === 1,
    mustChangePassword: row.must_change_pw === 1,
  };
  return c.json(resp);
});

app.post("/logout", async (c) => {
  if (isOidc(c.env)) {
    // 先吊销本地会话行并清 cookie；前端再跳认证中心 end_session，联动全生态登出
    await destroyOidcSession(c);
    const origin = c.env.OIDC_REDIRECT_ORIGIN || new URL(c.req.url).origin;
    return c.json({
      ok: true,
      redirect: `${c.env.OIDC_ISSUER}/logout?post_logout_redirect_uri=${encodeURIComponent(origin + "/")}`,
    });
  }
  await destroySession(c);
  return c.json({ ok: true });
});

// 修改自己的密码：收口到认证中心（v3.0.0 残留清理：兼容模式直写 user 表 password_hash
// 的分支已删，user 表转只读；兼容模式下本端点返回 410）
app.post("/password", requireUser, (c) =>
  isOidc(c.env)
    ? c.redirect(`${c.env.OIDC_ISSUER}/password`, 302)
    : c.json({ error: "gone", message: "改密已收口到统一认证中心，请前往认证中心操作" }, 410),
);

// 认人接口：user 与认证模式一起下发（前端据此切换登录/注册/改密/登出入口）。
// 未登录也回 200 + user:null——前端需要 authMode 决定跳哪，401 会让它拿不到这个信息。
// syncProbe（进站即探测）：匿名 + oidc 模式 + 不在探测冷却期 → 前端自动跳 /api/auth/sync
// 无感同步登录态；冷却标记防循环（SPA 页面请求直达静态资源，探测只能由前端发起）
app.get("/me", async (c) => {
  const user = c.get("user");
  const oidc = isOidc(c.env);
  const authMode = oidc ? "oidc" : "shared";
  const authHome = oidc ? c.env.OIDC_ISSUER! : null;
  if (!user) {
    const probeCooling = Boolean(getCookie(c, OIDC_PROBE_COOKIE));
    // stale 会话 cookie（行已撤销/过期）：顺手清掉，浏览器侧同步瘦身
    if (oidc && (await isStaleOidcSession(c))) {
      deleteCookie(c, OIDC_SESSION_COOKIE, { path: "/", secure: true });
    }
    return c.json({ user: null, authMode, authHome, syncProbe: oidc && !probeCooling ? true : undefined } satisfies MeEnvelope);
  }
  const resp: MeResp = {
    id: user.id,
    name: user.name,
    role: user.role,
    teamId: await teamIdOf(c, user.id),
    locked: user.locked,
    mustChangePassword: user.mustChangePassword,
  };
  return c.json({ user: resp, authMode, authHome } satisfies MeEnvelope);
});

export default app;
