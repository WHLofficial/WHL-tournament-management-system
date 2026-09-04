import { Hono } from "hono";
import type { AppEnv } from "../../env";
import { genTempPassword, hashPassword } from "../../lib/crypto";
import { requireSuperadmin } from "../../middleware/auth";

const app = new Hono<AppEnv>();

app.use("*", requireSuperadmin);

// 账号列表（含绑定球队；一账号一队，LEFT JOIN 至多一行）
app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.role, u.locked, u.created_at,
            tm.team_id AS team_id, t.name AS team_name
     FROM user u
     LEFT JOIN team_member tm ON tm.user_id = u.id
     LEFT JOIN team t ON t.id = tm.team_id
     ORDER BY u.id`
  ).all<{
    id: number;
    name: string;
    email: string | null;
    role: string;
    locked: number;
    created_at: string;
    team_id: number | null;
    team_name: string | null;
  }>();
  return c.json({
    accounts: rows.results.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      locked: r.locked === 1,
      createdAt: r.created_at,
      teamId: r.team_id,
      teamName: r.team_name,
    })),
  });
});

// 改角色：仅教练↔录入员互转；不能改自己，超管角色锁死
app.patch("/:id/role", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ role?: string }>().catch(() => null);
  const role = body?.role;
  if (role !== "coach" && role !== "admin") {
    return c.json({ message: "角色只能是教练或录入员" }, 400);
  }
  if (id === c.get("user")!.id) {
    return c.json({ message: "不能修改自己的角色" }, 400);
  }
  const target = await c.env.DB.prepare("SELECT id, role FROM user WHERE id = ?")
    .bind(id)
    .first<{ id: number; role: string }>();
  if (!target) return c.json({ message: "账号不存在" }, 404);
  if (target.role === "superadmin") {
    return c.json({ message: "超级管理员角色不可修改" }, 400);
  }
  await c.env.DB.prepare("UPDATE user SET role = ? WHERE id = ?").bind(role, id).run();
  return c.json({ ok: true });
});

// 解锁观众号：locked 置 0，解锁后即可凭认证码绑队
app.post("/:id/unlock", async (c) => {
  const id = Number(c.req.param("id"));
  const target = await c.env.DB.prepare("SELECT id FROM user WHERE id = ?")
    .bind(id)
    .first<{ id: number }>();
  if (!target) return c.json({ message: "账号不存在" }, 404);
  await c.env.DB.prepare("UPDATE user SET locked = 0 WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// 重置密码：生成临时密码，明码只在本次响应里出现，让对方登录后自行修改
app.post("/:id/reset-password", async (c) => {
  const id = Number(c.req.param("id"));
  const target = await c.env.DB.prepare("SELECT id, role FROM user WHERE id = ?")
    .bind(id)
    .first<{ id: number; role: string }>();
  if (!target) return c.json({ message: "账号不存在" }, 404);
  if (target.role === "superadmin") {
    return c.json({ message: "超级管理员密码不能在线重置" }, 400);
  }
  const tempPassword = genTempPassword();
  await c.env.DB.prepare("UPDATE user SET password_hash = ?, must_change_pw = 1 WHERE id = ?")
    .bind(await hashPassword(tempPassword), id)
    .run();
  return c.json({ tempPassword }, 200);
});

export default app;
