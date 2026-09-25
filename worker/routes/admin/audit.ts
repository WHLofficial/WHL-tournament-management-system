import { Hono } from "hono";
import type { AppEnv } from "../../env";
import { AuthApiError } from "../../lib/authClient";
import { authAdminAuditQuery } from "../../lib/authAdmin";
// 与账号管理同权限档：审计日志含全生态安全事件（登录失败、权限变更、强制下线），超管专属
import { requirePermission } from "../../middleware/auth";

const app = new Hono<AppEnv>();

app.use("*", requirePermission("tour.accounts.manage", "superadmin"));

// 审计日志（v3.1.0，PRD P1-3）：界面在本仓，数据真源在 auth audit_log，这里只做
// 查询参数 → auth /api/admin/audit/query 的转发。GET + query string，纯读不记审计。
// 筛选：account（auth account.id）、event、since/until（ISO 8601）、limit（≤100）、cursor（翻页）。
app.get("/", async (c) => {
  const numOrNull = (v: string | undefined) => {
    if (!v) return null;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  try {
    const out = await authAdminAuditQuery(c.env, {
      accountId: numOrNull(c.req.query("account")),
      event: c.req.query("event")?.trim() || null,
      since: c.req.query("since")?.trim() || null,
      until: c.req.query("until")?.trim() || null,
      limit: numOrNull(c.req.query("limit")) ?? undefined,
      cursor: numOrNull(c.req.query("cursor")),
    });
    return c.json(out);
  } catch (e) {
    if (e instanceof AuthApiError) {
      if (e.code === "unconfigured") return c.json({ message: "认证中心通道未配置" }, 500);
      if (e.code === "bad_request") return c.json({ message: e.message || "查询参数不对" }, 400);
      return c.json({ message: "认证中心暂不可用，请稍后再试" }, 502);
    }
    throw e;
  }
});

export default app;
