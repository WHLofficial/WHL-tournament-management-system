import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
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
