// 跨服务实联冒烟（增量 8）：tour 的管理能力打真实 auth 的 /api/admin/*，验证机器通道真的通。
//
// 与 tests/oidc.test.ts 的区别：那边把 fetch 换成伪 auth，只验本仓逻辑；这边不换 fetch，
// 用真实 HMAC 签名打一个真的在跑的认证中心——路径拼错、字段名对不上、密钥不符都会在这里翻出来，
// 而这些正是伪实现覆盖不到的（伪实现只认自己那套约定）。
//
// 需要认证中心在本地跑着（auth 仓：npm run dev，默认 127.0.0.1:8792；.dev.vars 里的 BIND_SECRET 作为密钥）：
//   AUTH_LIVE_URL=http://127.0.0.1:8792 AUTH_LIVE_SECRET=<auth/.dev.vars 的 BIND_SECRET> \
//     npx vitest run tests/admin.live.test.ts
// 未设这两个环境变量则整个文件跳过（CI / 日常 npm test 不受影响）。
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../worker/env";
import { AuthApiError } from "../worker/lib/authClient";
import {
  authAdminAccountDetail,
  authAdminCatalog,
  authAdminCreateSignupCode,
  authAdminListAccounts,
  authAdminListSignupCodes,
  authAdminOrgSettings,
} from "../worker/lib/authAdmin";

const URL_ = process.env.AUTH_LIVE_URL ?? "";
const SECRET = process.env.AUTH_LIVE_SECRET ?? "";
const live = URL_ && SECRET ? it : it.skip;

const env = { OIDC_ISSUER: URL_, AUTH_BIND_SECRET: SECRET } as unknown as AppEnv["Bindings"];
// 操作者 id 只用于写进 auth 的审计与「不能对自己动手」判定，读接口不校验它是否存在
const ACTOR = 1;

describe("管理能力实联：tour → 真实 auth 的机器通道", () => {
  live("目录：真实认证中心返回 3 系统 / 7 角色 / 17 权限点 + 角色权限映射", async () => {
    const cat = await authAdminCatalog(env);
    expect(cat.apps.map((a) => a.clientId).sort()).toEqual(["club", "guess", "tour"]);
    expect(cat.roles).toHaveLength(7);
    expect(cat.permissions).toHaveLength(17);
    expect(cat.rolePermissions.length).toBeGreaterThan(0);
    const superRole = cat.roles.find((r) => r.appId === null && r.key === "superadmin");
    expect(superRole?.name).toBe("超级管理员");
    expect(cat.rolePermissions.filter((rp) => rp.roleId === superRole!.id)).toHaveLength(17);
  });

  live("账号列表：字段名对得上（camelCase 映射靠的是真实响应）", async () => {
    const rows = await authAdminListAccounts(env, { limit: 5 });
    expect(Array.isArray(rows)).toBe(true);
    for (const r of rows) {
      expect(typeof r.id).toBe("number");
      expect(typeof r.name).toBe("string");
      expect(typeof r.locked).toBe("boolean");
      expect(typeof r.disabled).toBe("boolean");
      expect(Array.isArray(r.roles)).toBe(true);
      for (const role of r.roles) {
        expect(typeof role.key).toBe("string");
        expect(role.name.length).toBeGreaterThan(0);
      }
    }
  });

  live("详情：不存在的账号要被认证中心认出业务码（说明 body 解析正常，不是 400 bad body）", async () => {
    await expect(authAdminAccountDetail(env, { accountId: 99_999_999, actorId: ACTOR })).rejects.toThrow(AuthApiError);
    try {
      await authAdminAccountDetail(env, { accountId: 99_999_999, actorId: ACTOR });
    } catch (e) {
      expect((e as AuthApiError).code).toBe("account_not_found");
    }
  });

  live("开放注册开关：读到布尔值（PUT 是写动作，冒烟不碰生产开关）", async () => {
    const out = await authAdminOrgSettings(env);
    expect(typeof out.allowOpenReg).toBe("boolean");
  });

  live("注册码列表：id 是 12 位哈希指纹（证明确实读到了 auth 的 signup_code 表）", async () => {
    const rows = await authAdminListSignupCodes(env);
    expect(Array.isArray(rows)).toBe(true);
    for (const r of rows) {
      expect(r.id).toMatch(/^[0-9a-f]{12}$/);
      expect(typeof r.usedCount).toBe("number");
    }
  });

  // 死写回归的跨服务版本：以前管理台把码写进本仓 signup_code，认证中心压根看不到，生成的码一个都用不掉。
  // 这里走真实写入，再用列表读回来对齐指纹——写通道与读通道都被证明指向认证中心。
  live("注册码：经 tour 发出去的码落进认证中心，能被列表读回（写入回环）", async () => {
    const created = await authAdminCreateSignupCode(env, { actorId: ACTOR, maxUses: 1, expiresInHours: 1 });
    expect(created.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/); // 无歧义字母表，8 位
    expect(created.maxUses).toBe(1);
    expect(created.expiresAt).toBeTruthy();

    const { createHash } = await import("node:crypto");
    const fingerprint = createHash("sha256").update(created.code).digest("hex").slice(0, 12);
    const rows = await authAdminListSignupCodes(env);
    const row = rows.find((r) => r.id === fingerprint);
    expect(row, "刚发的码应能在认证中心列表里按指纹找到").toBeTruthy();
    expect(row!.maxUses).toBe(1);
    expect(row!.usedCount).toBe(0);
  });
});
