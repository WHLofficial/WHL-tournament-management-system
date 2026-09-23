import { Hono } from "hono";
import type { AppEnv, Bindings } from "./env";
import { attachUser } from "./middleware/auth";
import { runRosterSync } from "./lib/clubRoster";
import { runAccountMirror } from "./lib/accountMirror";
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

// 未捕获异常的兜底（增量 36）。Hono 默认把它压成 text/plain 的 "Internal Server Error"，
// 于是前端 src/api.ts 的 res.json() 解析失败、只剩一句「请求失败（500）」——报错无明细，
// 用户报过来也查不出是哪一步炸的（2026-09-23 那次只能靠反查 D1 才定位到外键）。
// 这里统一成与业务错误同形（error 机器码 + message 中文），并把方法/路径/堆栈写进日志。
app.onError((err, c) => {
  console.error(
    `[error] ${c.req.method} ${c.req.path}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  return c.json({ error: "internal", message: "服务异常，请稍后重试" }, 500);
});

// 定时任务（wrangler.jsonc 的 triggers.crons，每小时一次）。用 Object.assign 把 scheduled
// 挂到同一个 app 上，默认导出仍是这个 Hono 实例——测试里的 `app.request(...)` 因此一行不用改。
// 两个任务都自己吞异常并记日志：一次网络抖动不该把这次 cron 记成失败（cron 也没有重试）。
// runAccountMirror 是登录回调投影账号行的兜底：存量会话、以及建了账号还没登录过的人靠它补。
export default Object.assign(app, {
  scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(runRosterSync(env));
    ctx.waitUntil(runAccountMirror(env));
  },
});
