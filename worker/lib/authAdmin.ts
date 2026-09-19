// 账号管理能力（增量 8）：auth 侧 12 条 /api/admin/* 机器端点。
//
// 背景：账号真源 2026-09-14 已收口 auth（account / credential / user_role），本仓管理台原本直写自己的
// user / organization / signup_code 表，收口后那些写全部变成「死写」——改了没效果（改角色不影响鉴权、
// 重置出来的临时密码登不进去、生成的注册码一个都用不掉）。现在管理台只出界面，动作一律经这里转 auth。
//
// 命名映射：auth 侧 snake_case ↔ 本仓 camelCase，全部写动作带 actorId（转 auth 的 actor_id，auth 会记进
// 自己的审计），本仓另行留一份本地审计。HMAC 契约复用 authClient.ts 的 machineCall。
import type { AppEnv } from "../env";
import { AuthApiError, machineCall } from "./authClient";

const num = (v: unknown): number => Number(v);
const bool = (v: unknown): boolean => v === true;
const asArr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const asStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const asNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export interface AdminRoleRef {
  key: string;
  name: string;
}

export interface AdminAccountRow {
  id: number;
  name: string;
  email: string | null;
  /** 观众号（无码注册）：解锁前不能绑队，但仍可正常登录 */
  locked: boolean;
  mustChangePassword: boolean;
  /** 停用（增量 8 新语义，与 locked 无关）：登录被拒 + 会话全吊销 */
  disabled: boolean;
  isSuper: boolean;
  createdAt: string;
  roles: AdminRoleRef[];
  teamId: number | null;
  teamName: string | null;
}

export interface AdminSessionRow {
  /** session 表主键 token_hash：只用于「强制下线」定位，无法反推出会话 token */
  sessionHash: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  ip: string | null;
}

export interface AdminAccountDetail {
  account: {
    id: number;
    name: string;
    email: string | null;
    locked: boolean;
    mustChangePassword: boolean;
    disabled: boolean;
    isSuper: boolean;
    createdAt: string;
  };
  roles: AdminRoleRef[];
  grants: { key: string; description: string | null; grantedAt: string }[];
  sessions: AdminSessionRow[];
  qq: string | null;
}

export interface AdminCatalog {
  apps: { clientId: string; name: string }[];
  roles: { id: number; appId: string | null; key: string; name: string }[];
  permissions: { id: number; appId: string; key: string; description: string | null }[];
  /** 角色→权限点映射：界面据此算「角色带来的权限」与「额外授予」的并集 */
  rolePermissions: { roleId: number; permissionId: number }[];
}

/** 账号列表（含绑定球队与角色）。会话不进列表——那是详情的事。 */
export async function authAdminListAccounts(
  env: AppEnv["Bindings"],
  { q, after, limit }: { q?: string; after?: number | null; limit?: number } = {},
): Promise<AdminAccountRow[]> {
  const out = await machineCall(env, "/api/admin/accounts/list", {
    q: q ?? null,
    after: after ?? null,
    limit: limit ?? 200,
  });
  return asArr(out.accounts).map((r) => ({
    id: num(r.id),
    name: String(r.name),
    email: asStr(r.email),
    locked: bool(r.locked),
    mustChangePassword: bool(r.must_change_pw),
    disabled: bool(r.disabled),
    isSuper: bool(r.is_super),
    createdAt: String(r.created_at),
    roles: asArr(r.roles).map((x) => ({ key: String(x.key), name: String(x.name) })),
    teamId: asNum(r.team_id),
    teamName: asStr(r.team_name),
  }));
}

export async function authAdminAccountDetail(
  env: AppEnv["Bindings"],
  { accountId, actorId }: { accountId: number; actorId: number },
): Promise<AdminAccountDetail> {
  const out = await machineCall(env, "/api/admin/accounts/detail", { account_id: accountId, actor_id: actorId });
  const a = (out.account ?? {}) as Record<string, unknown>;
  return {
    account: {
      id: num(a.id),
      name: String(a.name),
      email: asStr(a.email),
      locked: bool(a.locked),
      mustChangePassword: bool(a.must_change_pw),
      disabled: bool(a.disabled),
      isSuper: bool(a.is_super),
      createdAt: String(a.created_at),
    },
    roles: asArr(out.roles).map((r) => ({ key: String(r.key), name: String(r.name) })),
    grants: asArr(out.grants).map((g) => ({
      key: String(g.key),
      description: asStr(g.description),
      grantedAt: String(g.granted_at),
    })),
    sessions: asArr(out.sessions).map((s) => ({
      sessionHash: String(s.session_hash),
      createdAt: String(s.created_at),
      expiresAt: String(s.expires_at),
      lastSeenAt: asStr(s.last_seen_at),
      ip: asStr(s.ip),
    })),
    qq: asStr(out.qq),
  };
}

/** 角色 / 权限点目录（auth 侧已有 isolate 60s 缓存，这里不再二次缓存） */
export async function authAdminCatalog(env: AppEnv["Bindings"]): Promise<AdminCatalog> {
  const out = await machineCall(env, "/api/admin/catalog", {});
  return {
    apps: asArr(out.apps).map((a) => ({ clientId: String(a.client_id), name: String(a.name) })),
    roles: asArr(out.roles).map((r) => ({
      id: num(r.id),
      appId: asStr(r.app_id),
      key: String(r.key),
      name: String(r.name),
    })),
    permissions: asArr(out.permissions).map((p) => ({
      id: num(p.id),
      appId: String(p.app_id),
      key: String(p.key),
      description: asStr(p.description),
    })),
    rolePermissions: asArr(out.role_permissions).map((rp) => ({
      roleId: num(rp.role_id),
      permissionId: num(rp.permission_id),
    })),
  };
}

/** 角色授权：传「应有的角色全集」，auth 端算差集后增删（幂等，界面反复保存无副作用）。
 *  响应带回 granted/revoked 差集，调用方据此记本地审计——无需回查一次详情。
 *  涉及全局超管的增删 auth 一律拒（superadmin_locked），因为它经 CROSS JOIN 已持全部权限点。 */
export async function authAdminSetRoles(
  env: AppEnv["Bindings"],
  { accountId, actorId, roles }: { accountId: number; actorId: number; roles: string[] },
): Promise<{ changed: boolean; granted: string[]; revoked: string[] }> {
  const out = await machineCall(env, "/api/admin/accounts/roles", { account_id: accountId, actor_id: actorId, roles });
  return {
    changed: bool(out.changed),
    granted: asArr(out.granted).map(String),
    revoked: asArr(out.revoked).map(String),
  };
}

/** 账号级权限点「额外授予」：只加不减——取消勾选只删本表行，角色带来的权限点不受影响。 */
export async function authAdminSetGrants(
  env: AppEnv["Bindings"],
  { accountId, actorId, permissions }: { accountId: number; actorId: number; permissions: string[] },
): Promise<{ changed: boolean; granted: string[]; revoked: string[] }> {
  const out = await machineCall(env, "/api/admin/accounts/grants", {
    account_id: accountId,
    actor_id: actorId,
    permissions,
  });
  return {
    changed: bool(out.changed),
    granted: asArr(out.granted).map(String),
    revoked: asArr(out.revoked).map(String),
  };
}

/** 重置密码：auth 生成临时密码 + 置 must_change_pw + 吊销该账号全部会话。明码只在本次响应出现。 */
export async function authAdminResetPassword(
  env: AppEnv["Bindings"],
  { accountId, actorId }: { accountId: number; actorId: number },
): Promise<{ tempPassword: string; sessionsRevoked: number }> {
  const out = await machineCall(env, "/api/admin/accounts/password", { account_id: accountId, actor_id: actorId });
  if (typeof out.temp_password !== "string") {
    throw new AuthApiError("auth_bad_response", "重置密码响应缺少 temp_password");
  }
  return { tempPassword: out.temp_password, sessionsRevoked: num(out.sessions_revoked) };
}

/** 解锁观众号（locked 1→0）。locked 不是封禁而是「观众号」标记：解锁前不能绑队。 */
export async function authAdminUnlock(
  env: AppEnv["Bindings"],
  { accountId, actorId }: { accountId: number; actorId: number },
): Promise<{ changed: boolean }> {
  const out = await machineCall(env, "/api/admin/accounts/unlock", { account_id: accountId, actor_id: actorId });
  return { changed: bool(out.changed) };
}

/** 停用 / 启用账号：停用会吊销该账号全部会话（含 OIDC refresh 与 back-channel 通知）。 */
export async function authAdminDisable(
  env: AppEnv["Bindings"],
  { accountId, actorId, disabled }: { accountId: number; actorId: number; disabled: boolean },
): Promise<{ changed: boolean; sessionsRevoked: number }> {
  const out = await machineCall(env, "/api/admin/accounts/disable", {
    account_id: accountId,
    actor_id: actorId,
    disabled,
  });
  return { changed: bool(out.changed), sessionsRevoked: num(out.sessions_revoked) };
}

/** 强制下线：给 sessionHash 踢单个会话；不给则吊销该账号全部会话。 */
export async function authAdminRevokeSessions(
  env: AppEnv["Bindings"],
  { accountId, actorId, sessionHash }: { accountId: number; actorId: number; sessionHash?: string },
): Promise<{ revoked: number }> {
  const out = await machineCall(env, "/api/admin/sessions/revoke", {
    account_id: accountId,
    actor_id: actorId,
    session_hash: sessionHash ?? null,
  });
  return { revoked: num(out.revoked) };
}

/** 开放注册开关：不带 patch = 读，带 = 写。真源是 auth 的 organization 表。 */
export async function authAdminOrgSettings(
  env: AppEnv["Bindings"],
  patch?: { allowOpenReg: boolean; actorId: number },
): Promise<{ allowOpenReg: boolean }> {
  const body = patch ? { allow_open_reg: patch.allowOpenReg, actor_id: patch.actorId } : {};
  const out = await machineCall(env, "/api/admin/org-settings", body);
  return { allowOpenReg: bool(out.allow_open_reg) };
}

/** 生成注册码：明码只在本次响应出现（auth 库里只有 sha256）。 */
export async function authAdminCreateSignupCode(
  env: AppEnv["Bindings"],
  { actorId, maxUses, expiresInHours }: { actorId: number; maxUses: number | null; expiresInHours: number | null },
): Promise<{ code: string; maxUses: number | null; expiresAt: string | null }> {
  const out = await machineCall(env, "/api/admin/signup-codes/create", {
    actor_id: actorId,
    max_uses: maxUses,
    expires_in_hours: expiresInHours,
  });
  if (typeof out.code !== "string") throw new AuthApiError("auth_bad_response", "注册码响应缺少 code");
  return { code: out.code, maxUses: asNum(out.max_uses), expiresAt: asStr(out.expires_at) };
}

export interface SignupCodeRow {
  /** 不可逆指纹前 12 位：auth 的注册码表主键就是 code_hash，明码不落库、不可回查 */
  id: string;
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  createdAt: string;
}

export async function authAdminListSignupCodes(env: AppEnv["Bindings"]): Promise<SignupCodeRow[]> {
  const out = await machineCall(env, "/api/admin/signup-codes/list", {});
  return asArr(out.codes).map((r) => ({
    id: String(r.id),
    maxUses: asNum(r.max_uses),
    usedCount: num(r.used_count),
    expiresAt: asStr(r.expires_at),
    createdAt: String(r.created_at),
  }));
}

export interface AdminAuditEvent {
  id: number;
  accountId: number | null;
  event: string;
  detail: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

export interface AdminAuditQuery {
  accountId?: number | null;
  event?: string | null;
  since?: string | null;
  until?: string | null;
  /** 单批行数，auth 端夹取 1-100，缺省 50 */
  limit?: number;
  /** 上一页响应的 next_cursor；不传 = 第一页 */
  cursor?: number | null;
}

/** 审计日志查询（增量 10，PRD P1-3）：真源在 auth audit_log，本仓只转发筛选条件。
 *  auth 端按 id 倒序返回并带 next_cursor（翻页），单次一条 SELECT 不做 COUNT。 */
export async function authAdminAuditQuery(
  env: AppEnv["Bindings"],
  q: AdminAuditQuery,
): Promise<{ events: AdminAuditEvent[]; nextCursor: number | null }> {
  const out = await machineCall(env, "/api/admin/audit/query", {
    account_id: q.accountId ?? null,
    event: q.event ?? null,
    since: q.since ?? null,
    until: q.until ?? null,
    limit: q.limit ?? 50,
    cursor: q.cursor ?? null,
  });
  return {
    events: asArr(out.events).map((r) => ({
      id: num(r.id),
      accountId: asNum(r.account_id),
      event: String(r.event),
      detail: r.detail && typeof r.detail === "object" ? (r.detail as Record<string, unknown>) : null,
      ip: asStr(r.ip),
      createdAt: String(r.created_at),
    })),
    nextCursor: asNum(out.next_cursor),
  };
}
