// #13 头版门户公开端点：公告 / 快讯流 / 周报 / 单场战报。
// 全部 GET-only + pubCache：读时现算的派生口径见 lib/feedNews.ts 头注释，
// 缓存保证重算频率与访客数无关（每边缘节点每 TTL 至多算一次，其余访客边缘直出）。
// v5.0.2 起本文件还承载首页聚合端点 /home：它 import routes/public.ts 的两个列表构造器
// 与 routes/interact.ts 的反应计数构造器，同源复用，不在本文件重抄口径。
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { pubCache } from "../lib/cache";
import { buildFeed, buildRoundRecap, buildWeekly } from "../lib/feedNews";
import { buildMatchReport } from "../lib/report";
import { buildTournamentList, buildUpcomingList } from "./public";
import { buildReactionCounts } from "./interact";
import type { AnnouncementDTO, FeedItemDTO } from "../../shared/news";

const app = new Hono<AppEnv>();

// 活跃公告（至多一条）；无公告返回 null，前端不渲染 banner
export async function buildAnnouncement(db: D1Database): Promise<AnnouncementDTO | null> {
  const row = await db.prepare(
    "SELECT id, title, body, updated_at FROM announcement WHERE active = 1 ORDER BY updated_at DESC, id DESC LIMIT 1",
  ).first<{ id: number; title: string; body: string; updated_at: string }>();
  return row ? { id: row.id, title: row.title, body: row.body, updatedAt: row.updated_at } : null;
}

app.get("/announcement", pubCache(300), async (c) => {
  return c.json({ announcement: await buildAnnouncement(c.env.DB) });
});

// 快讯流（含 KV SWR），供 /feed 与首页聚合端点 /home 共用。
// 首页一次要现算 tournaments+upcoming+announcement+feed+reactions，冷重算约 5,000 行，
// 更不能压在某个访客的请求里 ⇒ SWR 这层在聚合端点同样保留。
async function feedWithSwr(
  c: Context<AppEnv>,
  limit: number,
  before: string | undefined,
): Promise<FeedItemDTO[]> {
  const key = `swr:feed:v2:${limit}:${before ?? "latest"}`;
  const store = (items: FeedItemDTO[]) =>
    c.executionCtx.waitUntil(
      c.env.KV.put(key, JSON.stringify({ at: Date.now(), items }), { expirationTtl: 1800 }).catch(() => {}),
    );
  const cached = before ? null : await c.env.KV.get<{ at: number; items: FeedItemDTO[] }>(key, "json");
  if (cached && Array.isArray(cached.items)) {
    if (Date.now() - cached.at < 300_000) return cached.items;
    c.executionCtx.waitUntil(
      buildFeed(c.env.DB, { limit, before })
        .then(store)
        .catch(() => {}),
    );
    return cached.items;
  }
  const items = await buildFeed(c.env.DB, { limit, before });
  if (!before) store(items); // 翻页冷路径不进 SWR：读取端不查缓存，写只会白烧 KV 配额
  return items;
}

// 快讯流：?limit（默认 15，上限 50）&before（ISO 游标，档案页翻页用）。
// 键版本 v2：FeedItemDTO 增加 paragraphs/drama 后整体变形，与 v1 旧缓存隔离。
// 首页（无 before）在边缘 Cache 之下再垫一层 KV SWR：300s 内直出缓存；
// 过期先把旧值回给访客、waitUntil 后台重算回填——冷重算的两波查询不再压在某个访客的请求里。
// KV 为最终一致且每键写限频，写失败/写冲突静默吞掉（旧值或边缘缓存兜底）；带 before 的翻页冷路径不进 SWR。
// TTL 300s：feed 是全站最贵读面，瘦身前冷重算 6,521 行（首页 limit=16）/ 7,016 行（列表页 limit=30），
// 按 60s 窗口算上限 930 万–1,010 万行/日，单独就超过账号 5,000,000 行/日的整池；瘦身后降到
// 4,315 / 4,957 行，300s 窗口（288 窗/日）上限约 124 万–143 万行/日。代价是首页动态最长陈旧 5 分钟，
// 比分与单场详情仍走 60s 的 /live 与 /matches/:mid，实时性不受影响。
app.get("/feed", pubCache(300), async (c) => {
  const limitRaw = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 15;
  const before = c.req.query("before") || undefined;
  return c.json({ items: await feedWithSwr(c, limit, before) });
});

// 首页聚合端点（v5.0.2）：把首屏 5 个公开读面合成一个响应，前端一轮从 6 个请求降到 2 个
// （/home + /live），并消掉原先 reactions 那次串行往返。
// TTL 必须按最慢的那段分组：/live 保持独立 60s，其余 5 段统一 300s。
// 反例（不要做）：把 /live 也并进来、给整个 /home 挂 60s——feed 单段冷重算 4,315 行，
// 60s 窗口（1,440 窗/日）上限 621 万行/日，单独就超过账号 5,000,000 行/日的整池。
// reactions 由服务端从刚构建的 feed ids 现算，与 GET /api/interact/reactions 共用同一构造器。
app.get("/home", pubCache(300), async (c) => {
  const limitRaw = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 15;
  const [tournaments, upcoming, announcement, items] = await Promise.all([
    buildTournamentList(c.env.DB),
    buildUpcomingList(c.env.DB),
    buildAnnouncement(c.env.DB),
    feedWithSwr(c, limit, undefined),
  ]);
  const reactions = await buildReactionCounts(
    c.env.DB,
    items.map((i) => i.id),
  );
  return c.json({ tournaments, upcoming, announcement, feed: items, reactions });
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
  if (!report) return c.json({ error: "not_found", message: "该比赛暂无战报（仅完赛场自动成文）" }, 404);
  return c.json({ report });
});

// 轮次综述页（该轮完赛即自动成文；未齐轮也可访问，isComplete 标注）
app.get("/tournaments/:tid/round/:sid/:round", pubCache(300), async (c) => {
  const tid = Number(c.req.param("tid"));
  const sid = Number(c.req.param("sid"));
  const round = Number(c.req.param("round"));
  if (![tid, sid, round].every(Number.isInteger)) return c.json({ error: "bad_request", message: "轮次参数不合法" }, 400);
  const recap = await buildRoundRecap(c.env.DB, tid, sid, round);
  if (!recap) return c.json({ error: "not_found", message: "该轮暂无综述" }, 404);
  return c.json({ recap });
});

export default app;
