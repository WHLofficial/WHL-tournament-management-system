// v5.0.0：机器间入站端点（HMAC 验签，不走会话）。
// 目前两条：俱乐部平台新建俱乐部时把建档推过来（team-upsert）；
// v5.2.0 起队名改动也从同一条通道推（team-rename），否则对账页会常年挂着 nameDiffers。
// 详见 worker/lib/clubSync.ts 顶部关于「为什么只对建档破例开推」的说明。
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { TEAM_RENAME_PATH, verifyTeamSyncSignature } from "../lib/clubSync";
import { authRegisterTeam } from "../lib/authClient";
import { auditStmt } from "../lib/audit";

const app = new Hono<AppEnv>();

// 队名上限与俱乐部平台一致（club 的 clubs.name 限 40 字，这里对齐免得推过去被拒）
const NAME_MAX = 40;

app.post("/team-upsert", async (c) => {
  // 原始串必须用于验签，所以先取 text 再自己解析
  const raw = await c.req.text();
  const verdict = await verifyTeamSyncSignature(
    c.env,
    raw,
    c.req.header("x-timestamp"),
    c.req.header("x-sign"),
  );
  if (verdict === "unconfigured") {
    return c.json({ error: "unconfigured", message: "本仓未配置 TEAM_SYNC_SECRET，拒绝机器写入" }, 503);
  }
  if (verdict !== "ok") {
    return c.json({ error: "bad_signature", message: "签名校验失败" }, 403);
  }

  let body: { id?: unknown; name?: unknown; operator?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return c.json({ error: "bad_json", message: "请求体不是 JSON" }, 400);
  }
  const id = Number(body.id);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "bad_id", message: "游戏球队 ID 应为正整数（与游戏内球队编号一致）" }, 400);
  }
  if (!name || name.length > NAME_MAX) {
    return c.json({ error: "bad_name", message: `队名不能为空，且不超过 ${NAME_MAX} 字` }, 400);
  }

  const existing = await c.env.DB.prepare("SELECT id, name FROM team WHERE id = ?")
    .bind(id)
    .first<{ id: number; name: string }>();
  if (existing) {
    // 幂等：已建档就不动，名字不一致只回报不覆写（改名走文件末尾的 team-rename）
    return c.json({ ok: true, created: false, name: existing.name, nameDiffers: existing.name !== name });
  }
  // 队名占用单查一次：唯一约束也会拦住，但那样只能回报「ID 被占用」，
  // 而俱乐部平台的操作员看到的是自己刚填的队名——说清楚是谁占了名字才有用
  const nameTaken = await c.env.DB.prepare("SELECT id FROM team WHERE org_id = 1 AND name = ?")
    .bind(name)
    .first<{ id: number }>();
  if (nameTaken) {
    return c.json({ error: "conflict", message: `队名「${name}」已被球队 #${nameTaken.id} 占用` }, 409);
  }

  try {
    // 显式写 id（= 游戏球队 ID = club.clubs.id，三处同号）；created_by 留空——
    // 机器推送没有本仓用户身份，team.created_by 本就是可空外键，不必伪造系统账号。
    await c.env.DB.prepare(
      "INSERT INTO team (id, org_id, name, created_by) VALUES (?, 1, ?, NULL)",
    )
      .bind(id, name)
      .run();
  } catch {
    return c.json({ error: "conflict", message: `球队 ID #${id} 已被占用` }, 409);
  }

  // 认证中心目录登记：幂等 upsert，失败不回滚（与 club 侧建档同口径，可由重试或对账补齐）
  let authLinked = true;
  try {
    await authRegisterTeam(c.env, { tourTeamId: id, name });
  } catch {
    authLinked = false;
  }
  console.log(`[internal] team-upsert id=${id} name=${name} authLinked=${authLinked}`);
  return c.json({ ok: true, created: true, authLinked }, 201);
});

// POST /team-rename（v5.2.0）——俱乐部平台改完队名推过来。
// 与 team-upsert 同一套口径：HMAC 验签、幂等回执、撞名说清楚是谁占了名字。
app.post("/team-rename", async (c) => {
  // 原始串必须用于验签，所以先取 text 再自己解析
  const raw = await c.req.text();
  const verdict = await verifyTeamSyncSignature(
    c.env,
    raw,
    c.req.header("x-timestamp"),
    c.req.header("x-sign"),
    TEAM_RENAME_PATH,
  );
  if (verdict === "unconfigured") {
    return c.json({ error: "unconfigured", message: "本仓未配置 TEAM_SYNC_SECRET，拒绝机器写入" }, 503);
  }
  if (verdict !== "ok") {
    return c.json({ error: "bad_signature", message: "签名校验失败" }, 403);
  }

  let body: { id?: unknown; name?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return c.json({ error: "bad_json", message: "请求体不是合法 JSON" }, 400);
  }
  const id = Number(body.id);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "bad_request", message: "球队 ID 应为正整数" }, 400);
  }
  if (!name || name.length > NAME_MAX) {
    return c.json({ error: "bad_request", message: `队名不能为空，且不超过 ${NAME_MAX} 字` }, 400);
  }

  const existing = await c.env.DB.prepare("SELECT id, name FROM team WHERE id = ?")
    .bind(id)
    .first<{ id: number; name: string }>();
  if (!existing) {
    return c.json({ error: "not_found", message: `球队 #${id} 不存在` }, 404);
  }
  // 幂等：名字没变就当改名成功回执，不写库也不留审计（重推是常态）
  if (existing.name === name) {
    return c.json({ ok: true, renamed: false, id, name });
  }
  // 撞名先单查一次：唯一约束也会拦住，但那样只能回报「冲突」，
  // 而俱乐部平台的操作员看到的是自己刚填的队名——说清楚是谁占了名字才有用
  const nameTaken = await c.env.DB.prepare(
    "SELECT id FROM team WHERE org_id = 1 AND name = ? AND id <> ?",
  )
    .bind(name, id)
    .first<{ id: number }>();
  if (nameTaken) {
    return c.json({ error: "conflict", message: `队名「${name}」已被球队 #${nameTaken.id} 占用` }, 409);
  }

  try {
    // 改名与审计同批提交：机器调用没有本仓用户身份，actor 留 NULL
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE team SET name = ? WHERE id = ?").bind(name, id),
      auditStmt(c.env.DB, null, "team_rename", id, { from: existing.name, to: name }, "team"),
    ]);
  } catch (err) {
    // 并发撞名：单查之后、写入之前被别人抢先占了同一个名字，按同一口径回报；
    // 不是撞名（含迁移没先应用这类真故障）就交给全局 onError 报 500，不谎报 409
    const raced = await c.env.DB.prepare(
      "SELECT id FROM team WHERE org_id = 1 AND name = ? AND id <> ?",
    )
      .bind(name, id)
      .first<{ id: number }>();
    if (!raced) throw err;
    return c.json({ error: "conflict", message: `队名「${name}」已被球队 #${raced.id} 占用` }, 409);
  }

  console.log(`[internal] team-rename id=${id} name=${name}`);
  return c.json({ ok: true, renamed: true, id, name });
});

export default app;
