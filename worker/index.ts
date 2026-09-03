import { Hono } from "hono";

export type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: Fetcher;
};

export type AppEnv = { Bindings: Bindings };

const app = new Hono<AppEnv>();

app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }));

// run_worker_first 只把 /api/* 送进 Worker，其余路径由静态资产处理
// （未命中按 SPA 规则回退 index.html），这里只兜底 API 的未知路径。
app.notFound((c) => c.json({ error: "not_found" }, 404));

export default app;
