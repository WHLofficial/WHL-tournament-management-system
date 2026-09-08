import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";

// 公开 GET 边缘缓存：按完整 URL（含 query）键存入 Cloudflare 边缘 Cache API。
// 公开路由不读登录态、响应与用户无关，可安全跨访客共享；404/非 2xx 不缓存。
// TTL 由路由指定（2026-09-08 行读配额优化，延迟换配额）：直播比分类 60s——
// ≥ 前端 30s 轮询间隔，轮询改吃边缘缓存，不再次次穿透 D1，新进球/开赛最坏 ~1 分钟可见；
// 榜单详情类 300s——榜单/赛事信息本就低频更新。
// 大陆高 RTT 下重复浏览从「每趟 ~0.9s 网络 + 每查询 ~0.2s」变成边缘直出。
export function pubCache(ttlSeconds: number) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.req.method !== "GET") return next();
    const cache = caches.default;
    const key = new Request(c.req.url);
    const hit = await cache.match(key);
    if (hit) return hit;

    await next();
    if (!c.res.ok) return;
    // 不重建 Response（body 流只能消费一次，换构造会与 hono 响应管线冲突）：
    // 直接在原响应上设缓存头，clone 一份给边缘缓存
    c.res.headers.set("Cache-Control", `public, max-age=${ttlSeconds}`);
    c.executionCtx.waitUntil(cache.put(key, c.res.clone()));
  });
}
