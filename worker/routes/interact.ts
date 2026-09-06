// #13 头版门户互动层：MOTM 投票（需登录，观众号同权）+ 快讯表态（匿名，前端 localStorage 去重）。
// 挂载在 /api/interact（不进 PUBLIC_PATHS，需要 attachUser 读会话）；
// 纯匿名可用的表态计数读取也放这里（低频，匿名访客多付一次会话检查可接受）。
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireUser } from "../middleware/auth";
import { rateLimit } from "../lib/ratelimit";

const app = new Hono<AppEnv>();

const EMOJIS = ["fire", "thumb", "mind", "cry"] as const;
type EmojiKey = (typeof EMOJIS)[number];
// 快讯条目 id 的形态：kind:id 或 kind:id:id（milestone/streak），白名单字符防垃圾行
const ITEM_ID_RE = /^[a-z]+:[0-9A-Za-z:_-]{1,64}$/;

// ---------- MOTM 全场最佳 ----------

// 投票/改票（一人一场一票，改票覆盖）
app.post("/matches/:mid/motm", requireUser, async (c) => {
  const mid = Number(c.req.param("mid"));
  const body = await c.req.json<{ playerId?: unknown }>().catch(() => ({}) as { playerId?: unknown });
  const playerId = Number(body.playerId);
  if (!Number.isInteger(mid) || !Number.isInteger(playerId))
    return c.json({ error: "bad_request", message: "参数不合法" }, 400);

  const ip = c.req.header("CF-Connecting-IP") ?? "local";
  if (!(await rateLimit(c.env, `motm:${ip}`, 10, 60)))
    return c.json({ error: "rate_limited", message: "操作太频繁，稍后再试" }, 429);

  const match = await c.env.DB.prepare("SELECT id, status, home_entry_id, away_entry_id FROM match WHERE id = ?")
    .bind(mid)
    .first<{ id: number; status: string; home_entry_id: number; away_entry_id: number }>();
  if (!match) return c.json({ error: "not_found", message: "比赛不存在" }, 404);
  if (match.status !== "finished")
    return c.json({ error: "not_finished", message: "比赛完赛后才能投票" }, 409);

  // 只能投本场两队球员（player 按 team_id 归属，entry 按 team 匹配本场两侧）
  const mine = await c.env.DB.prepare(
    `SELECT p.id FROM player p
     JOIN entry e ON e.team_id = p.team_id
     WHERE p.id = ? AND e.id IN (?, ?)`,
  )
    .bind(playerId, match.home_entry_id, match.away_entry_id)
    .first<{ id: number }>();
  if (!mine) return c.json({ error: "bad_player", message: "只能投票给本场两队的球员" }, 400);

  await c.env.DB.prepare(
    `INSERT INTO motm_vote (match_id, user_id, player_id, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (match_id, user_id)
     DO UPDATE SET player_id = excluded.player_id, updated_at = excluded.updated_at`,
  )
    .bind(mid, c.get("user")!.id, playerId)
    .run();
  return c.json({ ok: true });
});

// 结果（公开读；登录用户附带自己的一票）
app.get("/matches/:mid/motm", async (c) => {
  const mid = Number(c.req.param("mid"));
  if (!Number.isInteger(mid)) return c.json({ error: "bad_request" }, 400);
  const totals = await c.env.DB.prepare(
    `SELECT mv.player_id AS playerId, p.name AS playerName, COUNT(*) AS cnt
     FROM motm_vote mv JOIN player p ON p.id = mv.player_id
     WHERE mv.match_id = ?
     GROUP BY mv.player_id
     ORDER BY cnt DESC, p.name ASC`,
  )
    .bind(mid)
    .all<{ playerId: number; playerName: string; cnt: number }>();
  let myVote: number | null = null;
  const user = c.get("user");
  if (user) {
    const row = await c.env.DB.prepare("SELECT player_id FROM motm_vote WHERE match_id = ? AND user_id = ?")
      .bind(mid, user.id)
      .first<{ player_id: number }>();
    myVote = row?.player_id ?? null;
  }
  return c.json({ totals: totals.results ?? [], myVote });
});

// ---------- 快讯表态 ----------

// 表态（匿名可用；去重靠前端 localStorage，服务端只累加）
app.post("/reactions/:itemId", async (c) => {
  const itemId = c.req.param("itemId");
  if (!ITEM_ID_RE.test(itemId)) return c.json({ error: "bad_request", message: "条目不合法" }, 400);
  const body = await c.req.json<{ emoji?: unknown }>().catch(() => ({}) as { emoji?: unknown });
  if (!EMOJIS.includes(body.emoji as EmojiKey))
    return c.json({ error: "bad_request", message: "不支持的表态" }, 400);

  const ip = c.req.header("CF-Connecting-IP") ?? "local";
  if (!(await rateLimit(c.env, `react:${ip}`, 30, 60)))
    return c.json({ error: "rate_limited", message: "操作太频繁，稍后再试" }, 429);

  const row = await c.env.DB.prepare(
    `INSERT INTO reaction (item_id, emoji, cnt) VALUES (?, ?, 1)
     ON CONFLICT (item_id, emoji) DO UPDATE SET cnt = cnt + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     RETURNING cnt`,
  )
    .bind(itemId, body.emoji)
    .first<{ cnt: number }>();
  return c.json({ ok: true, cnt: row?.cnt ?? 0 });
});

// 批量计数（橱窗可见条目一次性拉，?ids=a,b,c 至多 50 个）
app.get("/reactions", async (c) => {
  const ids = (c.req.query("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && ITEM_ID_RE.test(s))
    .slice(0, 50);
  const out: Record<string, Partial<Record<EmojiKey, number>>> = {};
  if (ids.length > 0) {
    const res = await c.env.DB.prepare(
      `SELECT item_id, emoji, cnt FROM reaction WHERE item_id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(...ids)
      .all<{ item_id: string; emoji: EmojiKey; cnt: number }>();
    for (const r of res.results ?? []) {
      const row = (out[r.item_id] ??= {});
      row[r.emoji] = r.cnt;
    }
  }
  return c.json({ reactions: out });
});

export default app;
