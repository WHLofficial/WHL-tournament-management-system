import { Hono } from "hono";
import type { AppEnv } from "./env";
import { attachUser } from "./middleware/auth";
import authRoutes from "./routes/auth";
import adminRoutes from "./routes/admin";
import publicRoutes from "./routes/public";
import coachRoutes from "./routes/coach";

const app = new Hono<AppEnv>();

app.use("/api/*", attachUser);

app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }));

app.route("/api/auth", authRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/public", publicRoutes);
app.route("/api/coach", coachRoutes);

// run_worker_first 只把 /api/* 送进 Worker，其余路径由静态资产处理
// （未命中按 SPA 规则回退 index.html），这里只兜底 API 的未知路径。
app.notFound((c) => c.json({ error: "not_found" }, 404));

export default app;
