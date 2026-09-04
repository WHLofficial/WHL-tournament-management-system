import { Hono } from "hono";
import type { AppEnv } from "../../env";
import type { PlayerDTO, TeamDTO } from "../../../shared/types";

const app = new Hono<AppEnv>();

// 球队库列表（含名单数、报名数）
app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT t.id, t.name,
       (SELECT COUNT(*) FROM player p WHERE p.team_id = t.id) AS player_count,
       (SELECT COUNT(*) FROM entry e WHERE e.team_id = t.id) AS entry_count
     FROM team t WHERE t.org_id = 1 ORDER BY t.name`
  ).all<{ id: number; name: string; player_count: number; entry_count: number }>();
  const teams: TeamDTO[] = rows.results.map((r) => ({
    id: r.id,
    name: r.name,
    playerCount: r.player_count,
    entryCount: r.entry_count,
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
  const team = await c.env.DB.prepare(
    "SELECT id, name FROM team WHERE id = ? AND org_id = 1"
  )
    .bind(id)
    .first<{ id: number; name: string }>();
  if (!team) return c.json({ message: "球队不存在" }, 404);
  const rows = await c.env.DB.prepare(
    "SELECT id, name, number FROM player WHERE team_id = ? ORDER BY id"
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

// 录入球员
app.post("/:id/players", async (c) => {
  const teamId = Number(c.req.param("id"));
  const body = await c.req
    .json<{ name?: string; number?: string | null }>()
    .catch(() => null);
  const name = body?.name?.trim();
  if (!name || name.length > 32) {
    return c.json({ message: "球员名不能为空，且不超过 32 字" }, 400);
  }
  const number = body?.number?.trim() || null;
  const team = await c.env.DB.prepare("SELECT id FROM team WHERE id = ?")
    .bind(teamId)
    .first();
  if (!team) return c.json({ message: "球队不存在" }, 404);
  const r = await c.env.DB.prepare(
    "INSERT INTO player (team_id, name, number) VALUES (?, ?, ?)"
  )
    .bind(teamId, name, number)
    .run();
  return c.json({ player: { id: r.meta.last_row_id, name, number } }, 201);
});

// 批量导入球员：名字相同→更新号码；号码被他人占用→拒绝该行；否则新增。D1 batch 全成或全不动
app.post("/:id/players/bulk", async (c) => {
  const teamId = Number(c.req.param("id"));
  const body = await c.req
    .json<{ rows?: { line?: number; name?: string; number?: string | null }[] }>()
    .catch(() => null);
  const rows = body?.rows ?? [];
  if (rows.length === 0) return c.json({ message: "没有可导入的球员" }, 400);
  if (rows.length > 100) return c.json({ message: "一次最多导入 100 名球员" }, 400);

  const team = await c.env.DB.prepare("SELECT id FROM team WHERE id = ?")
    .bind(teamId)
    .first();
  if (!team) return c.json({ message: "球队不存在" }, 404);

  const existing = await c.env.DB.prepare(
    "SELECT id, name, number FROM player WHERE team_id = ?"
  )
    .bind(teamId)
    .all<{ id: number; name: string; number: string | null }>();

  // 按粘贴顺序逐行处理；isNew 的行最后统一生成 INSERT，
  // 这样粘贴内同名改号天然收敛成一条最终 INSERT
  interface Slot {
    id: number;
    number: string | null;
    isNew: boolean;
  }
  const roster = new Map<string, Slot>();
  const owner = new Map<string, string>(); // 号码 -> 占用球员名
  for (const p of existing.results) {
    roster.set(p.name, { id: p.id, number: p.number, isNew: false });
    if (p.number !== null) owner.set(p.number, p.name);
  }

  const updateStmts: D1PreparedStatement[] = [];
  const skipped: { line: number; reason: string }[] = [];
  let inserted = 0;
  let updated = 0;
  let nextFake = -1;

  for (const row of rows) {
    const line = row.line ?? 0;
    const name = row.name?.trim() ?? "";
    const number = row.number?.trim() || null;
    if (!name || name.length > 32) {
      skipped.push({ line, reason: "球员名为空或超过 32 字" });
      continue;
    }
    if (number !== null && number.length > 8) {
      skipped.push({ line, reason: "号码过长（最多 8 字符）" });
      continue;
    }
    const slot = roster.get(name);
    if (slot) {
      if (number === null || number === slot.number) {
        skipped.push({
          line,
          reason: number === null ? "已存在，且未提供号码" : "已存在，号码未变",
        });
        continue;
      }
      const holder = owner.get(number);
      if (holder !== undefined && holder !== name) {
        skipped.push({ line, reason: `${number} 号已被 ${holder} 占用` });
        continue;
      }
      if (slot.number !== null) owner.delete(slot.number);
      owner.set(number, name);
      slot.number = number;
      if (!slot.isNew) {
        updateStmts.push(
          c.env.DB.prepare("UPDATE player SET number = ? WHERE id = ?").bind(
            number,
            slot.id
          )
        );
        updated += 1;
      }
      continue;
    }
    if (number !== null && owner.has(number)) {
      skipped.push({ line, reason: `${number} 号已被 ${owner.get(number)} 占用` });
      continue;
    }
    roster.set(name, { id: nextFake--, number, isNew: true });
    if (number !== null) owner.set(number, name);
    inserted += 1;
  }

  const stmts: D1PreparedStatement[] = [...updateStmts];
  for (const [name, slot] of roster) {
    if (slot.isNew) {
      stmts.push(
        c.env.DB.prepare(
          "INSERT INTO player (team_id, name, number) VALUES (?, ?, ?)"
        ).bind(teamId, name, slot.number)
      );
    }
  }
  if (stmts.length > 0) await c.env.DB.batch(stmts);

  return c.json({ inserted, updated, skipped }, 200);
});

// 修改球员
app.patch("/:id/players/:pid", async (c) => {
  const pid = Number(c.req.param("pid"));
  const body = await c.req
    .json<{ name?: string; number?: string | null }>()
    .catch(() => null);
  if (body?.name === undefined && body?.number === undefined) {
    return c.json({ message: "没有要修改的字段" }, 400);
  }
  const sets: string[] = [];
  const binds: (string | null)[] = [];
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name || name.length > 32) {
      return c.json({ message: "球员名不能为空，且不超过 32 字" }, 400);
    }
    sets.push("name = ?");
    binds.push(name);
  }
  if (body.number !== undefined) {
    sets.push("number = ?");
    binds.push(body.number?.trim() || null);
  }
  binds.push(String(pid));
  const r = await c.env.DB.prepare(
    `UPDATE player SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();
  if (r.meta.changes === 0) return c.json({ message: "球员不存在" }, 404);
  return c.json({ ok: true });
});

// 删除球员
app.delete("/:id/players/:pid", async (c) => {
  const pid = Number(c.req.param("pid"));
  await c.env.DB.prepare("DELETE FROM player WHERE id = ?").bind(pid).run();
  return c.json({ ok: true });
});

export default app;
