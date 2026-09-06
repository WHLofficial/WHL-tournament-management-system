import { Hono } from "hono";
import type { AppEnv } from "../env";

const app = new Hono<AppEnv>();

// 公开读取媒体：key 全部由服务端生成（team/|tournament/ 前缀），版本化 key + immutable 缓存
app.get("/*", async (c) => {
  const key = decodeURIComponent(c.req.path.replace(/^\/api\/media\//, ""));
  if (!/^(team|tournament)\/\d+\//.test(key)) {
    return c.json({ error: "not_found" }, 404);
  }
  // 版本化 key 内容不变：加边缘 Cache API，同 PoP 重复浏览不再打 R2
  const cache = caches.default;
  const cached = await cache.match(c.req.url);
  if (cached) return cached;
  const obj = await c.env.MEDIA.get(key);
  if (!obj) return c.json({ error: "not_found" }, 404);
  const buf = await obj.arrayBuffer();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  if (obj.httpEtag) headers.set("ETag", obj.httpEtag);
  const res = new Response(buf, { headers });
  c.executionCtx.waitUntil(cache.put(c.req.url, res.clone()));
  return res;
});

export default app;
