import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { AppEnv, SessionUser } from "../env";
import { randomToken } from "./crypto";

const COOKIE = "whl_session";
const TTL_SECONDS = 7 * 24 * 3600;

export async function createSession(c: Context<AppEnv>, userId: number): Promise<void> {
  const token = randomToken();
  await c.env.KV.put(`sess:${token}`, JSON.stringify({ userId }), { expirationTtl: TTL_SECONDS });
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: new URL(c.req.url).protocol === "https:",
    maxAge: TTL_SECONDS,
  });
}

export async function getSessionUser(c: Context<AppEnv>): Promise<SessionUser | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const raw = await c.env.KV.get(`sess:${token}`);
  if (!raw) return null;
  const { userId } = JSON.parse(raw) as { userId: number };
  const row = await c.env.DB.prepare("SELECT id, name, role FROM user WHERE id = ?")
    .bind(userId)
    .first<{ id: number; name: string; role: SessionUser["role"] }>();
  return row ? { id: row.id, name: row.name, role: row.role } : null;
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, COOKIE);
  if (token) await c.env.KV.delete(`sess:${token}`);
  deleteCookie(c, COOKIE, { path: "/" });
}
