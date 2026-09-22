import { Hono } from "hono";
import type { AppEnv, Bindings } from "./env";
import { attachUser } from "./middleware/auth";
import { runRosterSync } from "./lib/clubRoster";
import oidcRoutes from "./routes/oidc";
import authRoutes from "./routes/auth";
import adminRoutes from "./routes/admin";
import publicRoutes from "./routes/public";
import portalRoutes from "./routes/portal";
import interactRoutes from "./routes/interact";
import coachRoutes from "./routes/coach";
import mediaRoutes from "./routes/media";

const app = new Hono<AppEnv>();

// 公开读路由（公开接口 + 媒体 + 快讯表态读/写，均与登录态无关）不读登录态：
// 跳过会话检查，登录用户每请求省一次 KV+D1 往返
const PUBLIC_PATHS = ["/api/public/", "/api/media/", "/api/interact/reactions"];
app.use("/api/*", (c, next) =>
  PUBLIC_PATHS.some((p) => c.req.path.startsWith(p)) ? next() : attachUser(c, next)
);

app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }));

// 统一认证 RP 端点先挂（GET /login、GET /callback、POST /backchannel-logout，
// 与 authRoutes 的 POST /login 等旧入口按方法+路径天然不冲突）
app.route("/api/auth", oidcRoutes);
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

// 增量 33：名册同步定时任务（wrangler.jsonc 的 triggers.crons）。用 Object.assign 把 scheduled
// 挂到同一个 app 上，默认导出仍是这个 Hono 实例——测试里的 `app.request(...)` 因此一行不用改。
// runRosterSync 内部自己吞异常并记日志：一次网络抖动不该把这次 cron 记成失败（cron 也没有重试）。
export default Object.assign(app, {
  scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(runRosterSync(env));
  },
});
