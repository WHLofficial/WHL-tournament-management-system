// v1.0.0 球队绑定改造测试：烧码/发码/解绑走伪认证中心机器端点（stub 全局 fetch + HMAC 验签），
// 派生读（teamId/members/codes/账号映射）走 AUTH_DB 内存库（手工建 auth 侧最小表面）。
// 用兼容模式会话驱动路由，重点钉死：错误映射（400/409/502）、HMAC 契约、本地不再读写 auth_code/team_member。
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac } from "node:crypto";
import app from "../worker/index";
import { hashPassword } from "../worker/lib/crypto";
import { applyMigrations, createTestD1, createTestKV } from "./d1";

const ISSUER = "https://auth.example";
const SECRET = "machine-secret";

const nowSec = () => Math.floor(Date.now() / 1000);

// ---- 伪认证中心机器端点 ----

interface Captured {
  path: string;
  body: Record<string, unknown>;
  sign: string;
  ts: number;
  raw: string;
}

const responses: { status: number; body: unknown }[] = [];
const captures: Captured[] = [];

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof URL ? input : new URL(String(input));
  if (url.origin === ISSUER && url.pathname.startsWith("/api/team/")) {
    const raw = String(init?.body ?? "");
    captures.push({
      path: url.pathname,
      body: JSON.parse(raw) as Record<string, unknown>,
      sign: String((init?.headers as Record<string, string>)["x-sign"] ?? ""),
      ts: Number((init?.headers as Record<string, string>)["x-timestamp"] ?? 0),
      raw,
    });
    const out = responses[captures.length - 1] ?? { status: 200, body: { ok: true, teamId: 100 } };
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
  }
  return new Response("not found", { status: 404 });
}

function stubMachine(...outs: { status: number; body: unknown }[]) {
  responses.length = 0;
  responses.push(...outs);
  captures.length = 0;
}

// ---- AUTH_DB 内存库：auth 侧最小表面 ----

function freshAuthDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE team (id INTEGER PRIMARY KEY, tour_team_id INTEGER UNIQUE, club_id INTEGER UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE team_bind_code (id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL, code_hash TEXT NOT NULL UNIQUE, via TEXT NOT NULL, expires_at TEXT, used_by INTEGER, used_at TEXT, created_at TEXT NOT NULL);
    CREATE TABLE team_binding (account_id INTEGER NOT NULL, team_id INTEGER NOT NULL, bound_via TEXT NOT NULL, bound_at TEXT NOT NULL, PRIMARY KEY (account_id, team_id));
    CREATE UNIQUE INDEX idx_team_binding_account ON team_binding(account_id);
    CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  const iso = new Date().toISOString();
  sqlite.prepare("INSERT INTO team (id, tour_team_id, name, created_at) VALUES (10, 100, ?, ?)").run("百年豪门", iso);
  sqlite.prepare("INSERT INTO team (id, tour_team_id, name, created_at) VALUES (11, 101, ?, ?)").run("新晋之师", iso);
  sqlite.prepare("INSERT INTO account (id, name, created_at) VALUES (2, 'oidc教练', ?)").run(iso);
  sqlite.prepare("INSERT INTO team_binding (account_id, team_id, bound_via, bound_at) VALUES (2, 10, 'tour', ?)").run(iso);
  return { db: createTestD1(sqlite), sqlite };
}

// ---- tour 侧环境（兼容模式 KV 会话） ----

let userHash = "";

function freshEnv(opts: { auth?: boolean } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const h = userHash;
  sqlite
    .prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(1, "管理员", "", h, "admin", 0, 0);
  sqlite
    .prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(2, "教练", "", h, "coach", 0, 0);
  const kv = new Map<string, string>([
    ["sess:tok-coach", JSON.stringify({ userId: 2 })],
    ["sess:tok-admin", JSON.stringify({ userId: 1 })],
  ]);
  const authPair = freshAuthDb();
  const env: Record<string, unknown> = {
    DB: createTestD1(sqlite),
    KV: createTestKV(kv) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
    OIDC_ISSUER: ISSUER,
    ...(opts.auth !== false ? { AUTH_DB: authPair.db, AUTH_BIND_SECRET: SECRET } : {}),
  };
  return { env, sqlite };
}

const post = (env: Record<string, unknown>, path: string, body: unknown, token: string) =>
  app.request(
    path,
    { method: "POST", headers: { Cookie: `whl_session=${token}`, "content-type": "application/json" }, body: JSON.stringify(body) },
    env,
  );
const get = (env: Record<string, unknown>, path: string, token: string) =>
  app.request(path, { headers: { Cookie: `whl_session=${token}` } }, env);

beforeAll(async () => {
  userHash = await hashPassword("TestPass123"); // PBKDF2 走 crypto.subtle，须 await
  vi.stubGlobal("fetch", fakeFetch);
});

afterEach(() => {
  responses.length = 0;
  captures.length = 0;
});

describe("v1.0.0：球队绑定真源上收认证中心（tour 侧）", () => {
  it("烧码经机器通道写 auth：HMAC 契约正确，错误逐类映射", async () => {
    const { env } = freshEnv();

    stubMachine({ status: 200, body: { ok: true, teamId: 100 } });
    const ok = await post(env, "/api/coach/bind", { code: "ABCD2345" }, "tok-coach");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, teamId: 100 });
    const cap = captures[0];
    expect(cap.path).toBe("/api/team/bind");
    expect(cap.body).toEqual({ code: "ABCD2345", account_id: 2, via: "tour" });
    // X-Sign = hex(HMAC-SHA256(secret, "POST|path|ts|raw"))，时钟 ±300s
    expect(Math.abs(nowSec() - cap.ts)).toBeLessThanOrEqual(300);
    const expectSign = createHmac("sha256", SECRET).update(`POST|${cap.path}|${cap.ts}|${cap.raw}`).digest("hex");
    expect(cap.sign).toBe(expectSign);

    stubMachine({ status: 400, body: { error: "invalid_code", message: "认证码无效或已过期" } });
    const bad = await post(env, "/api/coach/bind", { code: "ZZZZ9999" }, "tok-coach");
    expect(bad.status).toBe(400);
    expect((await bad.json()).message).toBe("认证码无效或已过期");

    stubMachine({ status: 400, body: { error: "already_bound", message: "该账号已经绑定了球队，解绑需联系管理员" } });
    const dup = await post(env, "/api/coach/bind", { code: "QQQQ3333" }, "tok-coach");
    expect(dup.status).toBe(409);
    expect((await dup.json()).message).toContain("已经绑定了球队");

    stubMachine({ status: 500, body: { error: "server_error" } });
    const boom = await post(env, "/api/coach/bind", { code: "QQQQ3333" }, "tok-coach");
    expect(boom.status).toBe(502);
    expect((await boom.json()).message).toContain("认证中心暂不可用");
  });

  it("未配通道（secret/issuer 缺）时烧码明确报错，不静默假成功", async () => {
    const { env } = freshEnv({ auth: false });
    const res = await post(env, "/api/coach/bind", { code: "ABCD2345" }, "tok-coach");
    expect(res.status).toBe(502);
    expect((await res.json()).message).toContain("认证中心暂不可用");
  });

  it("我的球队派生自 AUTH_DB：teamId=目录 tour_team_id，成员姓名取 auth account", async () => {
    const { env, sqlite } = freshEnv();
    sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (100, 1, '百年豪门', '2026-01-01T00:00:00Z')").run();
    const me = await get(env, "/api/coach/me/team", "tok-coach");
    const body = (await me.json()) as { team: { id: number; name: string; members: { id: number; name: string }[] } | null };
    expect(body.team?.id).toBe(100);
    expect(body.team?.name).toBe("百年豪门");
    expect(body.team.members[0]).toMatchObject({ id: 2, name: "oidc教练" });

    // 本仓 team 表没有对应行时仍回绑定关系（id 取目录 tour_team_id，name 退空串）
    const env2 = freshEnv();
    const me2 = await get(env2.env, "/api/coach/me/team", "tok-coach");
    const body2 = (await me2.json()) as { team: { id: number; name: string } | null };
    expect(body2.team?.id).toBe(100);
    expect(body2.team?.name).toBe("");
  });

  it("管理端发码走 auth（team_not_found 自愈登记重试）、码列表/成员列表读派生、解绑调 unbind", async () => {
    const { env, sqlite } = freshEnv();

    stubMachine(
      { status: 400, body: { error: "team_not_found", message: "球队目录没有这支队" } },
      { status: 200, body: {} },
      { status: 200, body: { ok: true, code: "QWERT234", expires_at: "2026-12-31T00:00:00Z" } },
    );
    sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (100, 1, '百年豪门', '2026-01-01T00:00:00Z')").run();
    const issue = await post(env, "/api/admin/teams/100/auth-codes", { expiresInHours: 24 }, "tok-admin");
    expect(issue.status).toBe(201);
    expect(await issue.json()).toEqual({ code: "QWERT234", expiresAt: "2026-12-31T00:00:00Z" });
    expect(captures.map((c) => c.path)).toEqual(["/api/team/bindcode", "/api/team/register", "/api/team/bindcode"]);
    expect(captures[1].body).toEqual({ tour_team_id: 100, name: "百年豪门" });

    const codes = await get(env, "/api/admin/teams/100/auth-codes", "tok-admin");
    expect(codes.status).toBe(200);
    const members = await get(env, "/api/admin/teams/100/members", "tok-admin");
    expect(((await members.json()) as { members: unknown[] }).members.length).toBe(1);

    stubMachine({ status: 200, body: { ok: true } });
    const del = await app.request(
      "/api/admin/teams/100/members/2",
      { method: "DELETE", headers: { Cookie: "whl_session=tok-admin" } },
      env,
    );
    expect(del.status).toBe(200);
    expect(captures[captures.length - 1].body).toEqual({ account_id: 2 });
    const audits = sqlite
      .prepare("SELECT action FROM audit_log WHERE action = 'team.unbind'")
      .all() as unknown as { action: string }[];
    expect(audits.length).toBe(1);

    stubMachine({ status: 400, body: { error: "not_bound", message: "该账号未绑定球队" } });
    const del404 = await app.request(
      "/api/admin/teams/100/members/2",
      { method: "DELETE", headers: { Cookie: "whl_session=tok-admin" } },
      env,
    );
    expect(del404.status).toBe(404);
  });

  it("/api/auth/me 的 teamId 来自派生（AUTH_DB）", async () => {
    const { env } = freshEnv();
    const me = await get(env, "/api/auth/me", "tok-coach");
    const body = (await me.json()) as { user: { teamId: number | null } };
    expect(body.user.teamId).toBe(100);
  });
});
