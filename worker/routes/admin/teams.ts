import { Hono } from "hono";
import type { AppEnv } from "../../env";
import type { PlayerDTO, TeamDTO } from "../../../shared/types";
import { deleteImage, mediaUrl, saveImage } from "../../lib/media";
import { pushError, pushTeamToClub } from "../../lib/clubSync";
import { BULK_MAX, NAME_MAX, parseBulkLine } from "../../lib/teamBulk";
import { teamCodes, teamMembers } from "../../lib/authClient";
import { listTeamInjuries } from "../../lib/injury";

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

// 新建球队（增量 37：显式指定游戏球队 ID，建完推给俱乐部平台建档）
app.post("/", async (c) => {
  const body = await c.req.json<{ gameTeamId?: unknown; name?: unknown }>().catch(() => null);
  const gameTeamId = Number(body?.gameTeamId);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!Number.isInteger(gameTeamId) || gameTeamId <= 0) {
    return c.json({ message: "游戏球队 ID 应为正整数（与游戏内球队编号一致）" }, 400);
  }
  if (!name || name.length > NAME_MAX) {
    return c.json({ message: `队名不能为空，且不超过 ${NAME_MAX} 字` }, 400);
  }
  const taken = await c.env.DB.prepare("SELECT id FROM team WHERE id = ?").bind(gameTeamId).first();
  if (taken) return c.json({ message: `球队 ID #${gameTeamId} 已被占用` }, 409);
  try {
    // 显式写 id：本仓 team.id = 游戏球队 ID = club.clubs.id，三处同号（增量 37 的前提）
    await c.env.DB.prepare("INSERT INTO team (id, org_id, name, created_by) VALUES (?, 1, ?, ?)")
      .bind(gameTeamId, name, c.get("user")!.id)
      .run();
  } catch {
    return c.json({ message: "同名球队已存在" }, 409);
  }
  // 同步失败不回滚本地建队：列表里有「同步」按钮可重试，club 侧对账页也会兜底
  const sync = await pushTeamToClub(c.env, { id: gameTeamId, name, operator: c.get("user")!.id });
  return c.json({ team: { id: gameTeamId, name }, clubSyncError: pushError(sync) }, 201);
});

// 批量粘贴建队（每行「游戏球队 ID 队名」）
app.post("/bulk", async (c) => {
  const body = await c.req.json<{ lines?: unknown }>().catch(() => null);
  const lines = (Array.isArray(body?.lines) ? body.lines.map((l) => String(l).trim()) : []).filter(Boolean);
  if (lines.length === 0) return c.json({ message: "没有可用的行" }, 400);
  if (lines.length > BULK_MAX) return c.json({ message: `一次最多添加 ${BULK_MAX} 支球队` }, 400);

  const skipped: { line: number; reason: string }[] = [];
  const candidates: { id: number; name: string; line: number }[] = [];
  const seenId = new Set<number>();
  const seenName = new Set<string>();
  lines.forEach((line, i) => {
    const n = i + 1;
    const p = parseBulkLine(line);
    if ("error" in p) return void skipped.push({ line: n, reason: p.error });
    if (seenId.has(p.id)) return void skipped.push({ line: n, reason: `本批内 ID #${p.id} 重复` });
    if (seenName.has(p.name)) return void skipped.push({ line: n, reason: `本批内队名「${p.name}」重复` });
    seenId.add(p.id);
    seenName.add(p.name);
    candidates.push({ ...p, line: n });
  });

  // 先查库里的 id 与队名占用，把注定违反主键/唯一约束的行挑出来——否则整批 batch 会一起失败
  const ids = candidates.map((p) => p.id);
  const names = candidates.map((p) => p.name);
  const takenIdRows = ids.length
    ? (await c.env.DB.prepare(`SELECT id FROM team WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: number }>()).results
    : [];
  const takenNameRows = names.length
    ? (await c.env.DB.prepare(`SELECT name FROM team WHERE org_id = 1 AND name IN (${names.map(() => "?").join(",")})`).bind(...names).all<{ name: string }>()).results
    : [];
  const takenIds = new Set(takenIdRows.map((r) => r.id));
  const takenNames = new Set(takenNameRows.map((r) => r.name));

  const toCreate = candidates.filter((p) => {
    if (takenIds.has(p.id)) return void skipped.push({ line: p.line, reason: `球队 ID #${p.id} 已被占用` }), false;
    if (takenNames.has(p.name)) return void skipped.push({ line: p.line, reason: `队名「${p.name}」已存在` }), false;
    return true;
  });

  const createdBy = c.get("user")!.id;
  if (toCreate.length > 0) {
    await c.env.DB.batch(
      toCreate.map((p) =>
        c.env.DB.prepare("INSERT INTO team (id, org_id, name, created_by) VALUES (?, 1, ?, ?)").bind(
          p.id,
          p.name,
          createdBy,
        ),
      ),
    );
  }
  // 并行推送（串行 64 支会把这次请求拖到几十秒）；单支失败只回报，不回滚已建的队
  const pushed = await Promise.all(
    toCreate.map(async (p) => ({
      id: p.id,
      error: pushError(await pushTeamToClub(c.env, { id: p.id, name: p.name, operator: createdBy })),
    })),
  );
  skipped.sort((a, b) => a.line - b.line);
  return c.json(
    {
      created: toCreate.length,
      skipped,
      clubSyncFailed: pushed.filter((x) => x.error !== null).map((x) => ({ id: x.id, message: x.error })),
    },
    201,
  );
});

// 单队名单（排序表达式与 tournament 作用域的批量版保持一致，避免优化器静默不用 idx_player_team）
export const TEAM_PLAYERS_SQL =
  "SELECT id, name, number FROM player WHERE team_id = ? ORDER BY (number IS NULL), CAST(number AS INTEGER), number, id";

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
  const rows = await c.env.DB.prepare(TEAM_PLAYERS_SQL)
    .bind(id)
    .all<{ id: number; name: string; number: string | null }>();
  const players: PlayerDTO[] = rows.results.map((r) => ({
    id: r.id,
    name: r.name,
    number: r.number,
  }));
  return c.json({ team, players });
});

// 球队详情一次取齐（增量 40）：队 + 名单 + 认证码 + 已绑定教练 + 伤停登记。
// 前端原来先取 /:id 再并行取三个（4 请求、2 波往返），而它不只在挂载时跑 ——
// 生成认证码/解绑/改队名/传删队徽/伤停登记保存共 7 处都会重发这 4 个请求。
// 这里 6 条查询并行、1 波返回；认证码与教练名单读 AUTH_DB（只读镜像绑定），与本地读同一失败域。
// 字段名沿用四个原端点的口径（team/players/codes/members/injuries），前端与测试可直接对拍。
app.get("/:id/context", async (c) => {
  const id = Number(c.req.param("id"));
  const teamRow = await c.env.DB.prepare(
    "SELECT id, name, logo_key FROM team WHERE id = ? AND org_id = 1"
  )
    .bind(id)
    .first<{ id: number; name: string; logo_key: string | null }>();
  if (!teamRow) return c.json({ message: "球队不存在" }, 404);
  const [rows, codes, members, injuries] = await Promise.all([
    c.env.DB.prepare(TEAM_PLAYERS_SQL)
      .bind(id)
      .all<{ id: number; name: string; number: string | null }>(),
    teamCodes(c.env, id),
    teamMembers(c.env, id),
    listTeamInjuries(c.env.DB, id),
  ]);
  return c.json({
    team: { id: teamRow.id, name: teamRow.name, logoUrl: mediaUrl(teamRow.logo_key) },
    players: (rows.results ?? []).map((r) => ({ id: r.id, name: r.name, number: r.number })),
    codes,
    members,
    injuries,
  });
});

// 改队名（增量 37 边界：改名不联动俱乐部平台，只在对账页显示两边不一致）
app.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ name?: string }>().catch(() => null);
  const name = body?.name?.trim();
  if (!name || name.length > NAME_MAX) {
    return c.json({ message: `队名不能为空，且不超过 ${NAME_MAX} 字` }, 400);
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

// 手动重推建档（增量 37）：建队时同步失败的补救入口，幂等
app.post("/:id/sync-club", async (c) => {
  const id = Number(c.req.param("id"));
  const team = await c.env.DB.prepare("SELECT id, name FROM team WHERE id = ? AND org_id = 1")
    .bind(id)
    .first<{ id: number; name: string }>();
  if (!team) return c.json({ message: "球队不存在" }, 404);
  const sync = await pushTeamToClub(c.env, { id: team.id, name: team.name, operator: c.get("user")!.id });
  if (!sync.ok) return c.json({ message: sync.message }, 502);
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
