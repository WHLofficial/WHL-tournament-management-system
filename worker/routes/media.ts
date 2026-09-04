import { Hono } from "hono";
import type { AppEnv } from "../env";

const app = new Hono<AppEnv>();

// 公开读取媒体：key 全部由服务端生成（team/|tournament/ 前缀），版本化 key + immutable 缓存
app.get("/*", async (c) => {
  const key = decodeURIComponent(c.req.path.replace(/^\/api\/media\//, ""));
  if (!/^(team|tournament)\/\d+\//.test(key)) {
    return c.json({ error: "not_found" }, 404);
  }
  const obj = await c.env.MEDIA.get(key);
  if (!obj) return c.json({ error: "not_found" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  if (obj.httpEtag) headers.set("ETag", obj.httpEtag);
  return new Response(obj.body, { headers });
});

export default app;
