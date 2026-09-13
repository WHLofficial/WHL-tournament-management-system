import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { isOidc } from "../lib/oidc";
import { getSessionUser } from "../lib/session";

export const attachUser = createMiddleware<AppEnv>(async (c, next) => {
  c.set("user", await getSessionUser(c));
  await next();
});

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get("user")) return c.json({ error: "unauthorized", message: "请先登录" }, 401);
  await next();
});

// admin（录入员）及以上
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthorized", message: "请先登录" }, 401);
  if (user.role !== "admin" && user.role !== "superadmin")
    return c.json({ error: "forbidden", message: "需要管理员权限" }, 403);
  await next();
});

export const requireSuperadmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthorized", message: "请先登录" }, 401);
  if (user.role !== "superadmin")
    return c.json({ error: "forbidden", message: "需要超级管理员权限" }, 403);
  await next();
});

// 重置密码后未改密：除改密/登出外全部接口拦下（前端配套强制改密流程）
export const requirePwChanged = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (user?.mustChangePassword) {
    return c.json(
      {
        error: "password_change_required",
        // OIDC 模式改密入口在认证中心，文案同步指过去
        message: isOidc(c.env)
          ? "密码刚被重置，请先到认证中心设置新密码"
          : "密码刚被重置，请先设置新密码",
      },
      403,
    );
  }
  await next();
});
