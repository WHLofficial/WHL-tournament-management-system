import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { AppEnv, SessionUser } from "../env";
import { randomToken, sha256Hex } from "./crypto";
import { OIDC_SESSION_COOKIE, OIDC_TEMP_COOKIE, isOidc } from "./oidc";

const COOKIE = "whl_session";
const TTL_SECONDS = 7 * 24 * 3600;

/** 配置 COOKIE_DOMAIN 时用主域根，同主域子系统共享登录态；否则 host-only */
function cookieDomain(c: Context<AppEnv>): { domain?: string } {
  return c.env.COOKIE_DOMAIN ? { domain: c.env.COOKIE_DOMAIN } : {};
}

export async function createSession(c: Context<AppEnv>, userId: number): Promise<void> {
  const token = randomToken();
  await c.env.KV.put(`sess:${token}`, JSON.stringify({ userId }), { expirationTtl: TTL_SECONDS });
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: new URL(c.req.url).protocol === "https:",
    maxAge: TTL_SECONDS,
    ...cookieDomain(c),
  });
  // 切换共享域后清掉历史 host-only 同名 cookie，避免新旧两个 whl_session 并存、读取歧义
  if (c.env.COOKIE_DOMAIN) deleteCookie(c, COOKIE, { path: "/" });
}

// ---------- OIDC 模式（统一认证迁移步骤②，auth 项目 PRD P0-7） ----------

// __Host- 前缀 cookie 只存随机 token，会话行按 sha256(token) 查；
// sub 即 tour user id（账号真源仍在本库），姓名/角色每次现查，与 KV 模式行为等价
async function resolveOidcUser(c: Context<AppEnv>): Promise<SessionUser | null> {
  const token = getCookie(c, OIDC_SESSION_COOKIE);
  if (!token) return null;
  const row = await c.env.DB.prepare(
    "SELECT sub FROM oidc_session WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?",
  )
    .bind(await sha256Hex(token), new Date().toISOString())
    .first<{ sub: string }>();
  if (!row) return null;
  const userId = Number(row.sub);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  const user = await c.env.DB.prepare(
    "SELECT id, name, role, locked, must_change_pw FROM user WHERE id = ?",
  ).bind(userId).first<{
    id: number;
    name: string;
    role: SessionUser["role"];
    locked: number;
    must_change_pw: number;
  }>();
  return user
    ? {
        id: user.id,
        name: user.name,
        role: user.role,
        locked: user.locked === 1,
        mustChangePassword: user.must_change_pw === 1,
      }
    : null;
}

/** 吊销 OIDC 本地会话行并清两枚 cookie（RP 登出用；back-channel 由 routes/oidc.ts 按 sid 吊销） */
export async function destroyOidcSession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, OIDC_SESSION_COOKIE);
  if (token) {
    await c.env.DB.prepare(
      "UPDATE oidc_session SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
    )
      .bind(new Date().toISOString(), await sha256Hex(token))
      .run();
  }
  deleteCookie(c, OIDC_SESSION_COOKIE, { path: "/", secure: true });
  deleteCookie(c, OIDC_TEMP_COOKIE, { path: "/", secure: true });
}

export async function getSessionUser(c: Context<AppEnv>): Promise<SessionUser | null> {
  // 双模式互斥：配置 OIDC_* 只认本地 OIDC 会话，不再回落共享 KV（避免两种登录态混用）
  if (isOidc(c.env)) return resolveOidcUser(c);
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const raw = await c.env.KV.get(`sess:${token}`);
  if (!raw) return null;
  const { userId } = JSON.parse(raw) as { userId: number };
  const row = await c.env.DB.prepare(
    "SELECT id, name, role, locked, must_change_pw FROM user WHERE id = ?",
  )
    .bind(userId)
    .first<{ id: number; name: string; role: SessionUser["role"]; locked: number; must_change_pw: number }>();
  return row
    ? {
        id: row.id,
        name: row.name,
        role: row.role,
        locked: row.locked === 1,
        mustChangePassword: row.must_change_pw === 1,
      }
    : null;
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, COOKIE);
  if (token) await c.env.KV.delete(`sess:${token}`);
  // 删除需 Name+Domain+Path 全匹配：共享域下漏掉 domain 会删不掉，登出后仍带登录态
  deleteCookie(c, COOKIE, { path: "/", ...cookieDomain(c) });
  // 兜底清掉切换共享域前遗留的 host-only 同名 cookie
  if (c.env.COOKIE_DOMAIN) deleteCookie(c, COOKIE, { path: "/" });
}
