import { Hono } from "hono";
import type { AppEnv } from "../env";
import { generateCode, sha256Hex } from "../lib/crypto";
import { requireAdmin } from "../middleware/auth";
import teamsRoutes from "./admin/teams";
import tournamentsRoutes from "./admin/tournaments";

const app = new Hono<AppEnv>();

app.use("*", requireAdmin);

app.route("/teams", teamsRoutes);
app.route("/tournaments", tournamentsRoutes);

// 生成注册码；明码只在这一次响应里出现，库存 sha256
app.post("/signup-codes", async (c) => {
  const body = await c.req
    .json<{ maxUses?: number | null; expiresInHours?: number | null }>()
    .catch(() => ({}) as { maxUses?: number | null; expiresInHours?: number | null });
  const maxUses = typeof body.maxUses === "number" && body.maxUses > 0 ? Math.floor(body.maxUses) : null;
  const expiresInHours =
    typeof body.expiresInHours === "number" && body.expiresInHours > 0 ? body.expiresInHours : null;
  const expiresAt = expiresInHours ? new Date(Date.now() + expiresInHours * 3600_000).toISOString() : null;

  const code = generateCode(8);
  await c.env.DB.prepare(
    "INSERT INTO signup_code (code_hash, expires_at, max_uses, created_by) VALUES (?, ?, ?, ?)",
  )
    .bind(await sha256Hex(code), expiresAt, maxUses, c.get("user")!.id)
    .run();
  return c.json({ code, maxUses, expiresAt }, 201);
});

export default app;
