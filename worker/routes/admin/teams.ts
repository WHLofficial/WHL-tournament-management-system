import { Hono } from "hono";
import type { AppEnv } from "../../env";
import type { PlayerDTO, TeamDTO } from "../../../shared/types";
import { deleteImage, mediaUrl, saveImage } from "../../lib/media";

const app = new Hono<AppEnv>();

// 球队库列表（含名单数、报名数）
app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT t.id, t.name, t.logo_key,
       (SELECT COUNT(*) FROM player p WHERE p.team_id = t.id) AS player_count,
       (SELECT COUNT(*) FROM entry e WHERE e.team_id = t.id) AS entry_count
     FROM team t WHERE t.org_id = 1 ORDER BY t.name`
  ).all<{ id: number; name: string; logo_key: string | null; player_count: number; entry_count: number }>();
  const teams: TeamDTO[] = rows.results.map((r) => ({
    id: r.id,
    name: r.name,
    playerCount: r.player_count,
    entryCount: r.entry_count,
    logoUrl: mediaUrl(r.logo_key),
  }));
  return c.json({ teams });
});

// 新建球队
app.post("/", async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => null);
  const name = body?.name?.trim();
  if (!name || name.length > 32) {
    return c.json({ message: "队名不能为空，且不超过 32 字" }, 400);
  }
  try {
    const r = await c.env.DB.prepare(
      "INSERT INTO team (org_id, name, created_by) VALUES (1, ?, ?)"
    )
      .bind(name, c.get("user")!.id)
      .run();
    return c.json({ team: { id: r.meta.last_row_id, name } }, 201);
  } catch {
    return c.json({ message: "同名球队已存在" }, 409);
  }
});

// 批量粘贴建队（多行队名）
app.post("/bulk", async (c) => {
  const body = await c.req.json<{ names?: string[] }>().catch(() => null);
  const names = [
    ...new Set((body?.names ?? []).map((n) => n.trim()).filter(Boolean)),
  ];
  if (names.length === 0) return c.json({ message: "没有可用的队名" }, 400);
  if (names.length > 64) return c.json({ message: "一次最多添加 64 支球队" }, 400);

  const placeholders = names.map(() => "?").join(",");
  const existing = await c.env.DB.prepare(
    `SELECT name FROM team WHERE org_id = 1 AND name IN (${placeholders})`
  )
    .bind(...names)
    .all<{ name: string }>();
  const skipped = existing.results.map((r) => r.name);
  const toCreate = names.filter((n) => !skipped.includes(n));
  const createdBy = c.get("user")!.id;
  if (toCreate.length > 0) {
    await c.env.DB.batch(
      toCreate.map((n) =>
        c.env.DB.prepare(
          "INSERT INTO team (org_id, name, created_by) VALUES (1, ?, ?)"
        ).bind(n, createdBy)
      )
    );
  }
  return c.json({ created: toCreate.length, skipped }, 201);
});

// 球队详情 + 名单
app.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const teamRow = await c.env.DB.prepare(
    "SELECT id, name, logo_key FROM team WHERE id = ? AND org_id = 1"
  )
    .bind(id)
    .first<{ id: number; name: string; logo_key: string | null }>();
  if (!teamRow) return c.json({ message: "球队不存在" }, 404);
  const team = { id: teamRow.id, name: teamRow.name, logoUrl: mediaUrl(teamRow.logo_key) };
  const rows = await c.env.DB.prepare(
    "SELECT id, name, number FROM player WHERE team_id = ? ORDER BY (number IS NULL), CAST(number AS INTEGER), number, id"
  )
    .bind(id)
    .all<{ id: number; name: string; number: string | null }>();
  const players: PlayerDTO[] = rows.results.map((r) => ({
    id: r.id,
    name: r.name,
    number: r.number,
  }));
  return c.json({ team, players });
});

// 改队名
app.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ name?: string }>().catch(() => null);
  const name = body?.name?.trim();
  if (!name || name.length > 32) {
    return c.json({ message: "队名不能为空，且不超过 32 字" }, 400);
  }
  try {
    await c.env.DB.prepare("UPDATE team SET name = ? WHERE id = ?")
      .bind(name, id)
      .run();
  } catch {
    return c.json({ message: "同名球队已存在" }, 409);
  }
  return c.json({ ok: true });
});

// 删除球队（已报名任何赛事则拒绝）
app.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const entry = await c.env.DB.prepare(
    "SELECT id FROM entry WHERE team_id = ? LIMIT 1"
  )
    .bind(id)
    .first();
  if (entry) {
    return c.json({ message: "该球队已报名赛事，请先从赛事报名名单中移除" }, 409);
  }
  await c.env.DB.prepare("DELETE FROM team WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// 增量 33：球员写入（录入 / 批量导入 / 改名改号 / 删除）四个端点已下线。
// 球员名与球衣号的真源在俱乐部平台（名字由 FC26 存档派生、号码由所属俱乐部在球员卡上设定），
// 本仓 player 表是它的镜像，只由 worker/lib/clubRoster.ts 的拉取同步写。
// 保留双写路径的后果不是「多一个入口」而是「两个写者互相覆盖」——同步每跑一次就把手工改动抹掉，
// 所以这里连兜底写入口都不留（要补人先到俱乐部平台把人签进队里，再等同步或手动触发）。

// 上传队徽：png/jpg/webp ≤1MB；key 版本化，旧对象删除
app.put("/:id/logo", async (c) => {
  const id = Number(c.req.param("id"));
  const team = await c.env.DB.prepare("SELECT logo_key FROM team WHERE id = ? AND org_id = 1")
    .bind(id)
    .first<{ logo_key: string | null }>();
  if (!team) return c.json({ message: "球队不存在" }, 404);
  const res = await saveImage(c, "team", id);
  if (!res.ok) return c.json({ message: res.message }, res.status);
  await c.env.DB.prepare("UPDATE team SET logo_key = ? WHERE id = ?").bind(res.key, id).run();
  await deleteImage(c, team.logo_key);
  return c.json({ logoUrl: mediaUrl(res.key) });
});

// 删除队徽：恢复默认（首字+色块）
app.delete("/:id/logo", async (c) => {
  const id = Number(c.req.param("id"));
  const team = await c.env.DB.prepare("SELECT logo_key FROM team WHERE id = ? AND org_id = 1")
    .bind(id)
    .first<{ logo_key: string | null }>();
  if (!team) return c.json({ message: "球队不存在" }, 404);
  await c.env.DB.prepare("UPDATE team SET logo_key = NULL WHERE id = ?").bind(id).run();
  await deleteImage(c, team.logo_key);
  return c.json({ ok: true });
});

export default app;
