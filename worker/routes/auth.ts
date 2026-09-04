import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { hashPassword, sha256Hex, verifyPassword } from "../lib/crypto";
import { rateLimit } from "../lib/ratelimit";
import { createSession, destroySession } from "../lib/session";
import { requireUser } from "../middleware/auth";
import type { MeResp } from "../../shared/types";

const app = new Hono<AppEnv>();

function clientIp(c: { req: { header(name: string): string | undefined } }): string {
  return c.req.header("CF-Connecting-IP") ?? "local";
}

function nowIso(): string {
  return new Date().toISOString();
}

async function teamIdOf(c: Context<AppEnv>, userId: number): Promise<number | null> {
  const row = await c.env.DB.prepare("SELECT team_id FROM team_member WHERE user_id = ?")
    .bind(userId)
    .first<{ team_id: number }>();
  return row?.team_id ?? null;
}

app.post("/register", async (c) => {
  const ip = clientIp(c);
  if (!(await rateLimit(c.env, `reg:${ip}`, 5, 3600)))
    return c.json({ error: "rate_limited", message: "注册太频繁，请一小时后再试" }, 429);

  const body = await c.req.json<RegisterBody>().catch(() => null);
  if (!body) return c.json({ error: "bad_request", message: "请求格式不对" }, 400);

  const name = (body.name ?? "").trim();
  const password = body.password ?? "";
  if (name.length < 1 || name.length > 32)
    return c.json({ error: "bad_request", message: "昵称需要 1-32 个字符" }, 400);
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password))
    return c.json({ error: "bad_request", message: "密码至少 8 位，且要同时包含字母和数字" }, 400);
  const email = body.email?.trim() || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return c.json({ error: "bad_request", message: "邮箱格式不对" }, 400);

  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM user").first<{ n: number }>();
  const isFirst = (count?.n ?? 0) === 0;
  const code = (body.signupCode ?? "").trim();
  // 观众号：无注册码注册（需组织开关放开），锁定绑队直到超管解锁
  let locked = 0;

  if (!isFirst) {
    if (code) {
      const codeHash = await sha256Hex(code);
      const sc = await c.env.DB.prepare(
        "SELECT id, expires_at, max_uses, used_count FROM signup_code WHERE code_hash = ?",
      )
        .bind(codeHash)
        .first<{ id: number; expires_at: string | null; max_uses: number | null; used_count: number }>();
      if (!sc) return c.json({ error: "bad_request", message: "注册码无效" }, 400);
      if (sc.expires_at && sc.expires_at < nowIso())
        return c.json({ error: "bad_request", message: "注册码已过期" }, 400);
      if (sc.max_uses !== null && sc.used_count >= sc.max_uses)
        return c.json({ error: "bad_request", message: "注册码已用完" }, 400);
    } else {
      const org = await c.env.DB.prepare("SELECT allow_open_reg FROM organization WHERE id = 1")
        .first<{ allow_open_reg: number }>();
      if (!org?.allow_open_reg)
        return c.json({ error: "bad_request", message: "需要注册码" }, 400);
      locked = 1;
    }
  }

  const dup = await c.env.DB.prepare("SELECT id FROM user WHERE name = ?").bind(name).first();
  if (dup) return c.json({ error: "conflict", message: "这个昵称已被占用" }, 409);

  if (!isFirst && code) {
    const codeHash = await sha256Hex(code);
    const upd = await c.env.DB.prepare(
      "UPDATE signup_code SET used_count = used_count + 1 WHERE code_hash = ? AND (max_uses IS NULL OR used_count < max_uses) AND (expires_at IS NULL OR expires_at > ?)",
    )
      .bind(codeHash, nowIso())
      .run();
    if (upd.meta.changes !== 1)
      return c.json({ error: "bad_request", message: "注册码无效或已用完" }, 400);
  }

  const role = isFirst ? "superadmin" : "coach";
  try {
    const ins = await c.env.DB.prepare(
      "INSERT INTO user (name, email, password_hash, role, locked) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(name, email, await hashPassword(password), role, locked)
      .run();
    const userId = ins.meta.last_row_id;
    await createSession(c, userId);
    const resp: MeResp = {
      id: userId,
      name,
      role,
      teamId: null,
      locked: locked === 1,
      mustChangePassword: false,
    };
    return c.json(resp, 201);
  } catch {
    return c.json({ error: "conflict", message: "这个昵称已被占用" }, 409);
  }
});

app.post("/login", async (c) => {
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
  await destroySession(c);
  return c.json({ ok: true });
});

// 修改自己的密码：验证旧密码；改完当前会话保持有效
app.post("/password", requireUser, async (c) => {
  const user = c.get("user")!;
  if (!(await rateLimit(c.env, `pwd:${user.id}`, 5, 900)))
    return c.json({ error: "rate_limited", message: "尝试太频繁，请 15 分钟后再来" }, 429);

  const body = await c.req
    .json<{ oldPassword?: string; newPassword?: string }>()
    .catch(() => null);
  if (!body) return c.json({ error: "bad_request", message: "请求格式不对" }, 400);
  const newPassword = body.newPassword ?? "";
  if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword))
    return c.json({ error: "bad_request", message: "新密码至少 8 位，且要同时包含字母和数字" }, 400);

  const row = await c.env.DB.prepare("SELECT password_hash FROM user WHERE id = ?")
    .bind(user.id)
    .first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(body.oldPassword ?? "", row.password_hash)))
    return c.json({ error: "unauthorized", message: "旧密码不对" }, 400);

  await c.env.DB.prepare("UPDATE user SET password_hash = ?, must_change_pw = 0 WHERE id = ?")
    .bind(await hashPassword(newPassword), user.id)
    .run();
  return c.json({ ok: true });
});

app.get("/me", requireUser, async (c) => {
  const user = c.get("user")!;
  const resp: MeResp = {
    id: user.id,
    name: user.name,
    role: user.role,
    teamId: await teamIdOf(c, user.id),
    locked: user.locked,
    mustChangePassword: user.mustChangePassword,
  };
  return c.json(resp);
});

type RegisterBody = { name?: string; password?: string; signupCode?: string; email?: string };

export default app;
