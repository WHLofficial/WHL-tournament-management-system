// #13 头版门户互动层：全场最佳（MOTM）投票（需登录，观众号同权）+ 快讯表态（匿名，前端 localStorage 去重）。
// 挂载在 /api/interact（不进 PUBLIC_PATHS，需要 attachUser 读会话）；
// 纯匿名可用的表态计数读取也放这里（低频，匿名访客多付一次会话检查可接受）。
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireUser } from "../middleware/auth";
import { rateLimit } from "../lib/ratelimit";
import { shanghaiMidnightISO } from "../lib/time";

const app = new Hono<AppEnv>();

const EMOJIS = ["fire", "thumb", "mind", "cry"] as const;
type EmojiKey = (typeof EMOJIS)[number];
// 快讯条目 id 的形态：kind:id 或 kind:id:id（milestone/streak），白名单字符防垃圾行
const ITEM_ID_RE = /^[a-z]+:[0-9A-Za-z:_-]{1,64}$/;

// ---------- 全场最佳（MOTM） ----------

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

  // 只能投本场两队球员（归属按开放窗口，entry 按 team 匹配本场两侧）
  const mine = await c.env.DB.prepare(
    `SELECT p.id FROM player p
     JOIN player_team_history h ON h.player_id = p.id AND h.left_at IS NULL
     JOIN entry e ON e.team_id = h.team_id
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
  if (!Number.isInteger(mid)) return c.json({ error: "bad_request", message: "比赛 id 不合法" }, 400);
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

// 日期串（YYYY-MM-DD）→ 所在周的周一；纯日历运算，口径与 feedNews 的 mondayOfDateStr 一致
function mondayOf(dateStr: string): string {
  const t = new Date(`${dateStr}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
}

// 上海周 [周一, 次周一) 的 UTC 窗口（口径同 feedNews weekWindow，经 lib/time 的上海零点换算）
function weekWindowOf(mondayStr: string): [string, string] {
  const next = new Date(`${mondayStr}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 7);
  return [shanghaiMidnightISO(mondayStr), shanghaiMidnightISO(next.toISOString().slice(0, 10))];
}

// 条目存在性校验（audit 批次一 #10）：快讯条 id 是派生 id，表态前按前缀 kind 点查主表，
// 防止对已删改/伪造条目写 reaction 垃圾行（历史垃圾行不清理，只防新写入）。
// kind 集合 = feedNews 实际 push 的 id 前缀；查询全部走主键/既有索引，每条一次点查。
async function itemExists(db: D1Database, itemId: string): Promise<boolean> {
  const [kind, ...rest] = itemId.split(":");
  switch (kind) {
    // match:{id} / wo:{id} / leader:{matchId} / streak:{matchId}:{entryId} / milestone:{matchId}:{playerId}
    // → 首段都是 match.id
    case "match":
    case "wo":
    case "leader":
    case "streak":
    case "milestone": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) return false;
      const row = await db.prepare("SELECT 1 AS ok FROM match WHERE id = ?").bind(id).first();
      return row != null;
    }
    // discipline:{match_event.id} —— 红牌事件行
    case "discipline": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) return false;
      const row = await db.prepare("SELECT 1 AS ok FROM match_event WHERE id = ?").bind(id).first();
      return row != null;
    }
    // rescore:{audit_log.id}
    case "rescore": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) return false;
      const row = await db.prepare("SELECT 1 AS ok FROM audit_log WHERE id = ?").bind(id).first();
      return row != null;
    }
    // recap:{stageId}:{round} / injury:{stageId}:{round} → 该 (stage_id, round) 存在完赛场
    case "recap":
    case "injury": {
      const stageId = Number(rest[0]);
      const round = Number(rest[1]);
      if (!Number.isInteger(stageId) || !Number.isInteger(round)) return false;
      const row = await db
        .prepare("SELECT 1 AS ok FROM match WHERE stage_id = ? AND round = ? AND status = 'finished' LIMIT 1")
        .bind(stageId, round)
        .first();
      return row != null;
    }
    // weekly:{YYYY-MM-DD 周一} → 该上海周窗口 [周一, 次周一) 内有完赛场（口径同 feedNews weekMatches）
    case "weekly": {
      const monday = rest[0] ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(monday)) return false;
      const probe = new Date(`${monday}T00:00:00Z`);
      if (Number.isNaN(probe.getTime()) || mondayOf(monday) !== monday) return false;
      const [startISO, endISO] = weekWindowOf(monday);
      const row = await db
        .prepare(
          `SELECT 1 AS ok
           FROM match m
           JOIN stage s ON s.id = m.stage_id
           JOIN tournament t ON t.id = s.tournament_id
           WHERE t.status != 'draft' AND m.status = 'finished'
             AND m.finished_at >= ? AND m.finished_at < ? LIMIT 1`,
        )
        .bind(startISO, endISO)
        .first();
      return row != null;
    }
    default:
      return false;
  }
}

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

  // 形态白名单之后再点查条目存在性（audit 批次一 #10）：查无即 404，不落 reaction 行
  if (!(await itemExists(c.env.DB, itemId)))
    return c.json({ error: "not_found", message: "条目不存在" }, 404);

  const row = await c.env.DB.prepare(
    `INSERT INTO reaction (item_id, emoji, cnt) VALUES (?, ?, 1)
     ON CONFLICT (item_id, emoji) DO UPDATE SET cnt = cnt + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     RETURNING cnt`,
  )
    .bind(itemId, body.emoji)
    .first<{ cnt: number }>();
  return c.json({ ok: true, cnt: row?.cnt ?? 0 });
});

// 批量计数（橱窗可见条目一次性拉，?ids=a,b,c 至多 50 个）。
// 抽成函数供首页聚合端点 /api/public/home 复用：服务端从刚构建的 feed ids 直接算，
// 省掉前端那一次串行往返（口径与 GET /api/interact/reactions 同源，不重抄过滤规则）。
export async function buildReactionCounts(
  db: D1Database,
  ids: string[],
): Promise<Record<string, Partial<Record<EmojiKey, number>>>> {
  const clean = ids
    .map((s) => s.trim())
    .filter((s) => s && ITEM_ID_RE.test(s))
    .slice(0, 50);
  const out: Record<string, Partial<Record<EmojiKey, number>>> = {};
  if (clean.length === 0) return out;
  const res = await db.prepare(
    `SELECT item_id, emoji, cnt FROM reaction WHERE item_id IN (${clean.map(() => "?").join(",")})`,
  )
    .bind(...clean)
    .all<{ item_id: string; emoji: EmojiKey; cnt: number }>();
  for (const r of res.results ?? []) {
    const row = (out[r.item_id] ??= {});
    row[r.emoji] = r.cnt;
  }
  return out;
}

app.get("/reactions", async (c) => {
  const ids = (c.req.query("ids") ?? "").split(",");
  return c.json({ reactions: await buildReactionCounts(c.env.DB, ids) });
});

export default app;
