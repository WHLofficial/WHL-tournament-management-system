import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { AppEnv, SessionUser } from "../env";
import { randomToken } from "./crypto";

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

export async function getSessionUser(c: Context<AppEnv>): Promise<SessionUser | null> {
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
