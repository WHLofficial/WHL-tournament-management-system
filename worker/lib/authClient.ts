// 认证中心机器通道（增量 7 球队绑定上收）：绑定真源在 auth 库（team/team_bind_code/team_binding），
// 本仓经只读 AUTH_DB 派生读，经这里写（发码/烧码/解绑/目录登记）。
// HMAC 契约与 auth machine.ts / 竞猜插件逐字一致：X-Sign = hex(HMAC-SHA256(secret, "POST|path|ts|raw"))，
// X-Timestamp 秒级 ±300s。基地址复用 OIDC_ISSUER（同一台认证中心）；密钥 AUTH_BIND_SECRET 独立配。
import type { AppEnv } from "../env";

export class AuthApiError extends Error {
  constructor(
    /** auth 端业务错误码：invalid_code / already_bound / not_bound / team_not_found / club_taken / … */
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type MachineBody = Record<string, unknown>;

async function machineCall(env: AppEnv["Bindings"], path: string, body: MachineBody): Promise<Record<string, unknown>> {
  const secret = env.AUTH_BIND_SECRET ?? "";
  const base = env.OIDC_ISSUER ?? "";
  if (!secret || !base) throw new AuthApiError("unconfigured", "认证中心通道未配置（OIDC_ISSUER / AUTH_BIND_SECRET）");
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`POST|${path}|${ts}|${raw}`));
  const sign = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-timestamp": String(ts), "x-sign": sign },
      body: raw,
    });
  } catch {
    throw new AuthApiError("auth_unreachable", "认证中心不可达");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new AuthApiError("auth_bad_response", "认证中心响应不是 JSON");
  }
  if (!res.ok) {
    throw new AuthApiError(
      typeof parsed.error === "string" ? parsed.error : `http_${res.status}`,
      typeof parsed.message === "string" ? parsed.message : "认证中心拒绝请求",
    );
  }
  return parsed;
}

// 管理端发码（admin.ts auth-codes）：明码只在本次响应出现
export async function authIssueTeamCode(
  env: AppEnv["Bindings"],
  { tourTeamId, hours }: { tourTeamId: number; hours: number },
): Promise<{ code: string; expiresAt: string }> {
  const out = await machineCall(env, "/api/team/bindcode", { tour_team_id: tourTeamId, via: "tour", ttl_hours: hours });
  if (typeof out.code !== "string" || typeof out.expires_at !== "string") {
    throw new AuthApiError("auth_bad_response", "发码响应缺少 code/expires_at");
  }
  return { code: out.code, expiresAt: out.expires_at };
}

// 建队后登记目录（admin/teams.ts）：team_not_found 自愈的兜底
export async function authRegisterTeam(env: AppEnv["Bindings"], { tourTeamId, name }: { tourTeamId: number; name: string }): Promise<void> {
  await machineCall(env, "/api/team/register", { tour_team_id: tourTeamId, name });
}

// 教练烧码（coach.ts /bind）：写 auth team_binding（一账号一队由 auth 挡并发）
export async function authBindTeam(
  env: AppEnv["Bindings"],
  { code, accountId, via }: { code: string; accountId: number; via: "tour" | "club" },
): Promise<{ teamId: number }> {
  const out = await machineCall(env, "/api/team/bind", { code, account_id: accountId, via });
  const teamId = Number(out.teamId);
  if (!Number.isInteger(teamId)) throw new AuthApiError("auth_bad_response", "烧码响应缺少 teamId");
  return { teamId };
}

// 管理端解绑
export async function authUnbindTeam(env: AppEnv["Bindings"], accountId: number): Promise<void> {
  await machineCall(env, "/api/team/unbind", { account_id: accountId });
}

// ---- 只读派生（AUTH_DB）：account.id 与本仓 user.id 过渡期同值；team.tour_team_id 即本仓 team.id ----

// 账号当前绑定球队（本仓 team.id）；未绑返回 null
export async function boundTeamId(env: AppEnv["Bindings"], userId: number): Promise<number | null> {
  if (!env.AUTH_DB) return null;
  const row = await env.AUTH_DB.prepare(
    "SELECT t.tour_team_id AS team_id FROM team_binding b JOIN team t ON t.id = b.team_id WHERE b.account_id = ?",
  )
    .bind(userId)
    .first<{ team_id: number }>();
  return row?.team_id ?? null;
}

export interface TeamMemberRow {
  userId: number;
  name: string;
  joinedAt: string;
}

// 一队多账号：成员列表（姓名取 auth account.name）
export async function teamMembers(env: AppEnv["Bindings"], tourTeamId: number): Promise<TeamMemberRow[]> {
  if (!env.AUTH_DB) return [];
  const rows = await env.AUTH_DB.prepare(
    `SELECT b.account_id, a.name, b.bound_at FROM team_binding b
     JOIN team t ON t.id = b.team_id JOIN account a ON a.id = b.account_id
     WHERE t.tour_team_id = ? ORDER BY b.bound_at`,
  )
    .bind(tourTeamId)
    .all<{ account_id: number; name: string; bound_at: string }>();
  return rows.results.map((r) => ({ userId: r.account_id, name: r.name, joinedAt: r.bound_at }));
}

export interface TeamCodeRow {
  id: number;
  expiresAt: string | null;
  used: boolean;
  usedAt: string | null;
  createdAt: string;
}

// 球队近期认证码（管理端列表；明码本就不落库，这里只有哈希行）
export async function teamCodes(env: AppEnv["Bindings"], tourTeamId: number): Promise<TeamCodeRow[]> {
  if (!env.AUTH_DB) return [];
  const rows = await env.AUTH_DB.prepare(
    `SELECT id, expires_at, used_by, used_at, created_at FROM team_bind_code
     WHERE team_id = (SELECT id FROM team WHERE tour_team_id = ?) ORDER BY created_at DESC LIMIT 20`,
  )
    .bind(tourTeamId)
    .all<{ id: number; expires_at: string | null; used_by: number | null; used_at: string | null; created_at: string }>();
  return rows.results.map((r) => ({ id: r.id, expiresAt: r.expires_at, used: r.used_by !== null, usedAt: r.used_at, createdAt: r.created_at }));
}

// 全生态账号→球队映射（账号管理列表合并用）；键 = account.id（= user.id）
export async function teamOfAccounts(env: AppEnv["Bindings"]): Promise<Map<number, { teamId: number; teamName: string }>> {
  const map = new Map<number, { teamId: number; teamName: string }>();
  if (!env.AUTH_DB) return map;
  const rows = await env.AUTH_DB.prepare(
    `SELECT b.account_id, t.tour_team_id, t.name FROM team_binding b JOIN team t ON t.id = b.team_id`,
  )
    .all<{ account_id: number; tour_team_id: number; name: string }>();
  for (const r of rows.results) map.set(r.account_id, { teamId: r.tour_team_id, teamName: r.name });
  return map;
}

export interface BoundAccountRow {
  userId: number;
  name: string;
  teamId: number | null;
  teamName: string | null;
}

// 全生态账号（含未绑队的），姓名取 auth 库 account.name。
// 代打授权要按姓名选人，而 OIDC 收口后新账号在本库 user 表没有行，
// 拿本库 JOIN 姓名会正好漏掉要授权的那批人——所以姓名只能从 auth 库取。
export async function boundAccounts(env: AppEnv["Bindings"]): Promise<BoundAccountRow[]> {
  if (!env.AUTH_DB) return [];
  const rows = await env.AUTH_DB.prepare(
    `SELECT a.id AS account_id, a.name, t.tour_team_id, t.name AS team_name
     FROM account a
     LEFT JOIN team_binding b ON b.account_id = a.id
     LEFT JOIN team t ON t.id = b.team_id
     ORDER BY (t.name IS NULL), t.name, a.name`,
  )
    .all<{ account_id: number; name: string; tour_team_id: number | null; team_name: string | null }>();
  return rows.results.map((r) => ({
    userId: r.account_id,
    name: r.name,
    teamId: r.tour_team_id,
    teamName: r.team_name,
  }));
}
