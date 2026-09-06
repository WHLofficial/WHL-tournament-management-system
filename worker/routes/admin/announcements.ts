// #13 头版门户：公告管理。同一时刻至多一条 active=1（发布/激活在同一 batch 内下线旧条）；
// 历史永久保留（active=0），可复激活，不物理删除。
import { Hono } from "hono";
import type { AppEnv } from "../../env";

const app = new Hono<AppEnv>();

const TITLE_MAX = 80;
const BODY_MAX = 2000;

app.get("/", async (c) => {
  const res = await c.env.DB.prepare(
    `SELECT id, title, body, active, created_at, updated_at
     FROM announcement ORDER BY active DESC, updated_at DESC, id DESC LIMIT 100`,
  ).all<{
    id: number; title: string; body: string;
    active: number; created_at: string; updated_at: string;
  }>();
  return c.json({
    announcements: (res.results ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      active: r.active === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

// 发布：下线旧条 + 插入新条同批事务
app.post("/", async (c) => {
  const b = await c.req.json<{ title?: unknown; body?: unknown }>();
  const title = typeof b.title === "string" ? b.title.trim() : "";
  const body = typeof b.body === "string" ? b.body.trim() : "";
  if (!title || !body) return c.json({ error: "标题与正文不能为空" }, 400);
  if (title.length > TITLE_MAX || body.length > BODY_MAX) {
    return c.json({ error: `标题不超过 ${TITLE_MAX} 字、正文不超过 ${BODY_MAX} 字` }, 400);
  }
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE announcement SET active = 0, updated_at = ? WHERE active = 1").bind(now),
    c.env.DB.prepare(
      "INSERT INTO announcement (title, body, active, created_by, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)",
    ).bind(title, body, user.id, now, now),
  ]);
  const row = await c.env.DB.prepare(
    "SELECT id FROM announcement WHERE active = 1 ORDER BY id DESC LIMIT 1",
  ).first<{ id: number }>();
  return c.json({ ok: true, id: row?.id ?? null });
});

// 编辑 / 上线 / 下线：上线与下线旧条同批，保持至多一条 active
app.put("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad_id" }, 400);
  const b = await c.req.json<{ title?: unknown; body?: unknown; active?: unknown }>();
  const existing = await c.env.DB.prepare(
    "SELECT id, title, body, active FROM announcement WHERE id = ?",
  )
    .bind(id)
    .first<{ id: number; title: string; body: string; active: number }>();
  if (!existing) return c.json({ error: "not_found" }, 404);

  const title = typeof b.title === "string" ? b.title.trim() : existing.title;
  const body = typeof b.body === "string" ? b.body.trim() : existing.body;
  if (!title || !body) return c.json({ error: "标题与正文不能为空" }, 400);
  if (title.length > TITLE_MAX || body.length > BODY_MAX) {
    return c.json({ error: `标题不超过 ${TITLE_MAX} 字、正文不超过 ${BODY_MAX} 字` }, 400);
  }
  const active = typeof b.active === "boolean" ? (b.active ? 1 : 0) : existing.active;
  const now = new Date().toISOString();

  if (active === 1 && existing.active !== 1) {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE announcement SET active = 0, updated_at = ? WHERE active = 1 AND id != ?").bind(now, id),
      c.env.DB.prepare("UPDATE announcement SET title = ?, body = ?, active = 1, updated_at = ? WHERE id = ?").bind(title, body, now, id),
    ]);
  } else {
    await c.env.DB.prepare(
      "UPDATE announcement SET title = ?, body = ?, active = ?, updated_at = ? WHERE id = ?",
    )
      .bind(title, body, active, now, id)
      .run();
  }
  return c.json({ ok: true });
});

export default app;
