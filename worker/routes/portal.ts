// #13 头版门户公开端点：公告 / 快讯流 / 周报 / 单场战报。
// 全部 GET-only + pubCache：读时现算的派生口径见 lib/feedNews.ts 头注释，
// 缓存保证重算频率与访客数无关（每边缘节点每 TTL 至多算一次，其余访客边缘直出）。
// 本文件只新增路由，不改动 routes/public.ts 现有 handler（并行会话边界）。
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { pubCache } from "../lib/cache";
import { buildFeed, buildRoundRecap, buildWeekly } from "../lib/feedNews";
import { buildMatchReport } from "../lib/report";
import type { AnnouncementDTO, FeedItemDTO } from "../../shared/news";

const app = new Hono<AppEnv>();

// 活跃公告（至多一条）；无公告返回 null，前端不渲染 banner
app.get("/announcement", pubCache(60), async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT id, title, body, updated_at FROM announcement WHERE active = 1 ORDER BY updated_at DESC, id DESC LIMIT 1",
  ).first<{ id: number; title: string; body: string; updated_at: string }>();
  const announcement: AnnouncementDTO | null = row
    ? { id: row.id, title: row.title, body: row.body, updatedAt: row.updated_at }
    : null;
  return c.json({ announcement });
});

// 快讯流：?limit（默认 15，上限 50）&before（ISO 游标，档案页翻页用）。
// 首页（无 before）在边缘 Cache 之下再垫一层 KV SWR：60s 内直出缓存；
// 过期先把旧值回给访客、waitUntil 后台重算回填——冷重算的两波查询不再压在某个访客的请求里。
// KV 为最终一致且每键写限频，写失败/写冲突静默吞掉（旧值或边缘缓存兜底）；带 before 的翻页冷路径不进 SWR。
app.get("/feed", pubCache(60), async (c) => {
  const limitRaw = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 15;
  const before = c.req.query("before") || undefined;
  const key = `swr:feed:v1:${limit}:${before ?? "latest"}`;
  const store = (items: FeedItemDTO[]) =>
    c.executionCtx.waitUntil(
      c.env.KV.put(key, JSON.stringify({ at: Date.now(), items }), { expirationTtl: 600 }).catch(() => {}),
    );
  const cached = before ? null : await c.env.KV.get<{ at: number; items: FeedItemDTO[] }>(key, "json");
  if (cached && Array.isArray(cached.items)) {
    if (Date.now() - cached.at < 60_000) return c.json({ items: cached.items });
    c.executionCtx.waitUntil(
      buildFeed(c.env.DB, { limit, before })
        .then(store)
        .catch(() => {}),
    );
    return c.json({ items: cached.items });
  }
  const items = await buildFeed(c.env.DB, { limit, before });
  if (!before) store(items); // 翻页冷路径不进 SWR：读取端不查缓存，写只会白烧 KV 配额
  return c.json({ items });
});

// 周报：?week=YYYY-MM-DD（该周周一）按周回看；缺省=本周（空则回退最近有比赛周）
app.get("/weekly", pubCache(300), async (c) => {
  const week = c.req.query("week");
  const weekly = await buildWeekly(c.env.DB, week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? week : undefined);
  return c.json({ weekly });
});

// 单场战报文章（仅完赛场；数据预渲染，前端整页直出）
app.get("/matches/:mid/report", pubCache(60), async (c) => {
  const mid = Number(c.req.param("mid"));
  const report = await buildMatchReport(c.env.DB, mid);
  if (!report) return c.json({ error: "not_found" }, 404);
  return c.json({ report });
});

// 轮次综述页（该轮完赛即自动成文；未齐轮也可访问，isComplete 标注）
app.get("/tournaments/:tid/round/:sid/:round", pubCache(300), async (c) => {
  const tid = Number(c.req.param("tid"));
  const sid = Number(c.req.param("sid"));
  const round = Number(c.req.param("round"));
  if (![tid, sid, round].every(Number.isInteger)) return c.json({ error: "bad_request" }, 400);
  const recap = await buildRoundRecap(c.env.DB, tid, sid, round);
  if (!recap) return c.json({ error: "not_found" }, 404);
  return c.json({ recap });
});

export default app;
