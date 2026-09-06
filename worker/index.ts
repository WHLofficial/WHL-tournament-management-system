import { Hono } from "hono";
import type { AppEnv } from "./env";
import { attachUser } from "./middleware/auth";
import authRoutes from "./routes/auth";
import adminRoutes from "./routes/admin";
import publicRoutes from "./routes/public";
import portalRoutes from "./routes/portal";
import interactRoutes from "./routes/interact";
import coachRoutes from "./routes/coach";
import mediaRoutes from "./routes/media";

const app = new Hono<AppEnv>();

// 公开读路由（公开接口 + 媒体）不读登录态：跳过会话检查，登录用户每请求省一次 KV+D1 往返
const PUBLIC_PATHS = ["/api/public/", "/api/media/"];
app.use("/api/*", (c, next) =>
  PUBLIC_PATHS.some((p) => c.req.path.startsWith(p)) ? next() : attachUser(c, next)
);

app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }));

app.route("/api/auth", authRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/public", publicRoutes);
app.route("/api/public", portalRoutes); // #13 头版门户：公告/快讯/周报/战报（独立文件，不动 public.ts）
app.route("/api/interact", interactRoutes); // #13 互动层：MOTM（需登录）+ 快讯表态（匿名）
app.route("/api/coach", coachRoutes);
app.route("/api/media", mediaRoutes);

// run_worker_first 只把 /api/* 送进 Worker，其余路径由静态资产处理
// （未命中按 SPA 规则回退 index.html），这里只兜底 API 的未知路径。
app.notFound((c) => c.json({ error: "not_found" }, 404));

export default app;
