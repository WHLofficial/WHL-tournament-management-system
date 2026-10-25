// 管理端操作者凭证（v5.9.0）：auth 的 /api/admin/* 现在要两把凭证——
//   1) AUTH_ADMIN_SECRET 的 HMAC：证明请求来自 tour 服务端；
//   2) 当前管理员的 access token：auth 据此识别操作者、复核 MFA 与权限点。
// 本文件只负责取第二把：登录回调把 access/refresh token 存进 oidc_session，
// access 过期时用 refresh token 换新；换不到就要求重新登录，绝不让管理台静默降级。
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AdminActor, AppEnv } from "../env";
import { sha256Hex } from "./crypto";
import { OIDC_SESSION_COOKIE, isOidc } from "./oidc";

const REFRESH_LEEWAY_MS = 60_000;

type TokenRow = {
  access_token: string | null;
  access_expires_at: string | null;
  refresh_token: string | null;
};

async function readTokenRow(c: Context<AppEnv>): Promise<TokenRow | null> {
  const cookie = getCookie(c, OIDC_SESSION_COOKIE);
  if (!cookie) return null;
  return c.env.DB.prepare(
    `SELECT access_token, access_expires_at, refresh_token
       FROM oidc_session
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
  )
    .bind(await sha256Hex(cookie), new Date().toISOString())
    .first<TokenRow>();
}

function stillFresh(row: TokenRow | null): row is TokenRow & { access_token: string } {
  if (!row?.access_token) return false;
  const exp = Date.parse(row.access_expires_at ?? "");
  return Number.isFinite(exp) && exp > Date.now() + REFRESH_LEEWAY_MS;
}

/** 取当前管理员的 access token；cookie 会话不在、refresh 失败都返回 null（调用方给 401）。 */
export async function getAdminActor(c: Context<AppEnv>): Promise<AdminActor | null> {  if (!isOidc(c.env)) return null;
  const user = c.get("user");
  if (!user) return null;

  const row = await readTokenRow(c);
  if (stillFresh(row)) return { id: user.id, token: row.access_token };
  if (!row?.refresh_token) return null;

  let refreshed: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown } | null;
  try {
    const res = await fetch(`${c.env.OIDC_ISSUER}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: row.refresh_token,
        client_id: c.env.OIDC_CLIENT_ID,
      }),
    });
    refreshed = res.ok ? ((await res.json().catch(() => null)) as typeof refreshed) : null;
  } catch {
    refreshed = null;
  }

  if (typeof refreshed?.access_token !== "string" || !refreshed.access_token) {
    // 并发刷新时另一个请求可能已经换好了：重读一次，有新鲜 access 就直接用
    const again = await readTokenRow(c);
    return stillFresh(again) ? { id: user.id, token: again.access_token } : null;
  }

  const access = refreshed.access_token;
  const nextRefresh = typeof refreshed.refresh_token === "string" ? refreshed.refresh_token : row.refresh_token;
  const expiresIn = Number(refreshed.expires_in) > 0 ? Number(refreshed.expires_in) : 1800;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  const cookie = getCookie(c, OIDC_SESSION_COOKIE);
  if (cookie) {
    // 只有 refresh token 没被并发请求换掉才写回，避免把别人刚轮换的新 token 覆盖回旧的
    await c.env.DB.prepare(
      `UPDATE oidc_session
          SET access_token = ?, access_expires_at = ?, refresh_token = ?
        WHERE token_hash = ? AND refresh_token = ?`,
    )
      .bind(access, expiresAt, nextRefresh, await sha256Hex(cookie), row.refresh_token)
      .run();
  }
  return { id: user.id, token: access };
}

/**
 * 仅挂在真正转发 auth /api/admin/* 的路由上。赛事/赛程等本地管理端点不需要操作者 token，
 * 别把「auth 会话」变成整个管理台的单点条件（测试与本地无 OIDC 也能跑）。
 */
export const requireAdminActor: MiddlewareHandler<AppEnv> = async (c, next) => {
  const actor = await getAdminActor(c);
  if (!actor) return c.json({ error: "reauth_required", message: "登录已过期，请重新登录" }, 401);
  c.set("adminActor", actor);
  await next();
};
