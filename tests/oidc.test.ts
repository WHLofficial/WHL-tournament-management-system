// 统一认证接入测试（迁移步骤②，auth 项目 PRD P0-7，tour 降级）：
// in-process 伪认证服务器——stub 全局 fetch 提供 jwks/token 两端点，用 jose 现签
// id_token / logout_token（独立密钥对，challenge/verifier 哈希用 node:crypto 独立实现），
// 驱动 RP 全流程：发起登录 → 回调建会话 → 教练/管理台端点认人 → 登出吊销 → back-channel 通知；
// 兼容模式（未配 OIDC_*）回归 KV 共享会话旧行为。
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import app from "../worker/index";
import { hashPassword } from "../worker/lib/crypto";
import { applyMigrations, createTestD1, createTestKV, sqlGet } from "./d1";
import { runAccountMirror, MIRROR_PASSWORD } from "../worker/lib/accountMirror";
import { BACKCHANNEL_LOGOUT_EVENT, b64urlDecode } from "../worker/lib/oidc";

const ISSUER = "https://auth.example";
const CLIENT_ID = "tour";
const nowSec = () => Math.floor(Date.now() / 1000);

// ---- 密钥与令牌（独立于 tour 代码的验签材料） ----

interface KeyMaterial {
  privateKey: CryptoKey;
  jwk: { kid: string; kty: string; n: string; e: string };
}

let signing: KeyMaterial;
let rogue: KeyMaterial;
let userHash: string;

beforeAll(async () => {
  const make = async (kid: string): Promise<KeyMaterial> => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = (await exportJWK(publicKey)) as { kty: string; n: string; e: string };
    return { privateKey, jwk: { ...jwk, kid } };
  };
  signing = await make("test-key-1");
  rogue = await make("rogue-key");
  userHash = await hashPassword("TestPass123");
});

function mint(key: KeyMaterial, claims: JWTPayload): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: key.jwk.kid }).sign(key.privateKey);
}

// ---- 伪认证服务器：stub 全局 fetch，只服务 /jwks.json 与 /token ----

interface StubState {
  code: string;
  challenge: string;
  nonce: string;
  sub: string;
  sid: string;
  idToken?: string; // 覆盖默认现签（伪造签名 / nonce 不符用）
  tokenStatus?: number; // 强制换票失败
  userinfoStatus?: number; // 强制 userinfo 失败
  userinfo?: Record<string, unknown>; // 覆盖默认 claims（userinfo 缺字段负例用）
  tokenCalls: URLSearchParams[];
}

// userinfo 下发的 claims（§6.2 播种投影：admin=recorder+coach，coach=coach），
// 与 user 表种子一一对应——收口后判定只认这份 claims，不再查表
const USERINFO_BY_SUB: Record<string, Record<string, unknown>> = {
  "1": {
    sub: "1", name: "oidc管理", locked: false, must_change_pw: false,
    roles: ["tour.coach", "tour.recorder"],
    permissions: ["tour.match.manage", "tour.team.bind", "tour.accounts.manage"],
  },
  "2": { sub: "2", name: "oidc教练", locked: false, must_change_pw: false, roles: ["tour.coach"], permissions: ["tour.team.bind"] },
  "3": {
    sub: "3", name: "oidc待改密", locked: false, must_change_pw: true,
    roles: ["tour.recorder"], permissions: ["tour.match.manage"],
  },
};

let stub: StubState;

let fakeFetchCalls = 0;
/** 记录最近一次转发给 auth 的审计查询 body（断言筛选参数确实透传） */
let lastAuditBody: Record<string, unknown> | null = null;

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof URL ? input : new URL(String(input));
  if (url.pathname.endsWith("/jwks.json")) {
    return new Response(JSON.stringify({ keys: [signing.jwk] }), {
      headers: { "content-type": "application/json" },
    });
  }
  if (url.pathname.endsWith("/userinfo")) {
    fakeFetchCalls++;
    if (stub.userinfoStatus) return new Response("boom", { status: stub.userinfoStatus });
    const auth = String(init?.headers instanceof Headers ? init.headers.get("authorization") : (init?.headers as Record<string, string>)?.authorization ?? "");
    if (auth !== "Bearer fake-at") return new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 });
    return new Response(JSON.stringify(stub.userinfo ?? USERINFO_BY_SUB[stub.sub] ?? {}), {
      headers: { "content-type": "application/json" },
    });
  }
  // 管理能力（v2.0.0）：账号管理台经机器通道转发认证中心。这里只需要 org-settings 读一条
  // （真身是 auth 的 organization 表；返回固定值即可，本仓库已不再有自己的开关可读）
  if (url.pathname.endsWith("/api/admin/org-settings")) {
    return new Response(JSON.stringify({ allow_open_reg: false }), {
      headers: { "content-type": "application/json" },
    });
  }
  // 审计查询（v3.1.0）：转发 /api/admin/audit/query，body 供断言筛选透传
  if (url.pathname.endsWith("/api/admin/audit/query")) {
    lastAuditBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        events: [
          { id: 12, account_id: 3, event: "login.fail", detail: { name: "x" }, ip: "1.2.3.4", created_at: "2026-09-19T00:00:00.000Z" },
          { id: 11, account_id: null, event: "logout", detail: null, ip: null, created_at: "2026-09-18T00:00:00.000Z" },
        ],
        next_cursor: null,
      }),
      { headers: { "content-type": "application/json" } },
    );
  }
  if (url.pathname.endsWith("/api/admin/catalog")) {
    return new Response(
      JSON.stringify({
        apps: [{ client_id: "tour", name: "赛事系统" }],
        roles: [{ id: 1, app_id: "tour", key: "coach", name: "教练" }],
        permissions: [{ id: 1, app_id: "tour", key: "tour.team.bind", description: "绑定球队" }],
        role_permissions: [{ role_id: 1, permission_id: 1 }],
      }),
      { headers: { "content-type": "application/json" } },
    );
  }
  if (url.pathname.endsWith("/api/admin/accounts/list")) {
    return new Response(
      JSON.stringify({
        accounts: [
          {
            id: 2,
            name: "张三",
            email: null,
            locked: false,
            must_change_pw: false,
            disabled: false,
            is_super: false,
            created_at: "2026-01-01T00:00:00.000Z",
            roles: [{ key: "tour.coach", name: "教练" }],
            team_id: null,
            team_name: null,
          },
        ],
        next_after: null,
      }),
      { headers: { "content-type": "application/json" } },
    );
  }
  if (url.pathname.endsWith("/token")) {
    const form = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init?.body ?? ""));
    stub.tokenCalls.push(form);
    if (stub.tokenStatus) {
      return new Response(JSON.stringify({ error: "server_error" }), { status: stub.tokenStatus });
    }
    const ok =
      form.get("grant_type") === "authorization_code" &&
      form.get("code") === stub.code &&
      form.get("client_id") === CLIENT_ID &&
      form.get("redirect_uri") === "http://localhost/api/auth/callback" &&
      createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === stub.challenge;
    if (!ok) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    const idToken =
      stub.idToken ??
      (await mint(signing, {
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: stub.sub,
        sid: stub.sid,
        nonce: stub.nonce,
        iat: nowSec(),
        exp: nowSec() + 600,
      }));
    return new Response(
      JSON.stringify({
        access_token: "fake-at",
        token_type: "Bearer",
        expires_in: 1800,
        refresh_token: "fake-rt",
        scope: "openid",
        id_token: idToken,
      }),
      { headers: { "content-type": "application/json" } },
    );
  }
  return new Response("not found", { status: 404 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- 测试环境（user 表用真实迁移建出；KV 种一条旧共享会话验证模式互斥） ----

interface Fixture {
  env: Record<string, unknown>;
  sqlite: DatabaseSync;
}

function freshEnv(oidc: boolean): Fixture {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  sqlite
    .prepare(
      "INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(1, "oidc管理", "", userHash, "admin", 0, 0);
  sqlite
    .prepare(
      "INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(2, "oidc教练", "", userHash, "coach", 0, 0);
  sqlite
    .prepare(
      "INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(3, "oidc待改密", "", userHash, "admin", 0, 1);
  const kv = new Map<string, string>([["sess:tok-legacy", JSON.stringify({ userId: 2 })]]);
  const env: Record<string, unknown> = {
    DB: createTestD1(sqlite),
    KV: createTestKV(kv) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
    // 管理台转认证中心用（v2.0.0）：OIDC 模式下生产必配，未配则管理台的 org-settings/注册码一律 500
    ...(oidc ? { AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: CLIENT_ID, AUTH_BIND_SECRET: "test-bind-secret" } : {}),
  };
  return { env, sqlite };
}

function cookieOf(res: Response, name: string): string | undefined {
  for (const line of res.headers.getSetCookie()) {
    const m = new RegExp(`^${name}=([^;]*)`).exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** 完整登录：发起 → 伪 auth 发码 → 回调。返回回调响应与会话 cookie。 */
async function oidcLogin(
  env: Record<string, unknown>,
  opts?: { sub?: string; sid?: string; userinfo?: Record<string, unknown> },
) {
  const login = await app.request("/api/auth/login", { method: "GET" }, env);
  expect(login.status).toBe(302);
  const authUrl = new URL(login.headers.get("Location")!);
  const temp = cookieOf(login, "__Host-tour_oidc");
  expect(temp).toBeTruthy();
  stub = {
    code: "CODE-1",
    challenge: authUrl.searchParams.get("code_challenge")!,
    nonce: authUrl.searchParams.get("nonce")!,
    sub: opts?.sub ?? "2",
    sid: opts?.sid ?? "sid-1",
    userinfo: opts?.userinfo,
    tokenCalls: [],
  };
  const cb = await app.request(
    `/api/auth/callback?code=${stub.code}&state=${authUrl.searchParams.get("state")}&iss=${encodeURIComponent(ISSUER)}`,
    { method: "GET", headers: { Cookie: `__Host-tour_oidc=${temp}` } },
    env,
  );
  return { login, authUrl, cb, session: cookieOf(cb, "__Host-tour_session") };
}

describe("统一认证接入（步骤② OIDC RP，tour 降级）", () => {
  it("兼容模式：KV 会话照常登录认人，RP 端点 404，/api/auth/me 下发 authMode=shared", async () => {
    const { env } = freshEnv(false);

    const login = await app.request(
      "/api/auth/login",
      { method: "POST", body: JSON.stringify({ name: "oidc教练", password: "TestPass123" }), headers: { "content-type": "application/json" } },
      env,
    );
    expect(login.status).toBe(200);
    const legacyCookie = cookieOf(login, "whl_session");
    expect(legacyCookie).toBeTruthy();

    const me = await app.request("/api/auth/me", { method: "GET", headers: { Cookie: `whl_session=${legacyCookie}` } }, env);
    const meBody = (await me.json()) as { user: { name: string } | null; authMode: string; authHome: string | null };
    expect(meBody.user?.name).toBe("oidc教练");
    expect(meBody.authMode).toBe("shared");
    expect(meBody.authHome).toBeNull();

    // OIDC RP 端点在兼容模式一律 404
    expect((await app.request("/api/auth/login", { method: "GET" }, env)).status).toBe(404);
    expect((await app.request("/api/auth/callback?code=x&state=y", { method: "GET" }, env)).status).toBe(404);
    expect((await app.request("/api/auth/backchannel-logout", { method: "POST" }, env)).status).toBe(404);

    // 旧登出仍是纯 JSON，不带 redirect
    const out = (await (await app.request("/api/auth/logout", { method: "POST" }, env)).json()) as { ok: boolean; redirect?: string };
    expect(out.ok).toBe(true);
    expect(out.redirect).toBeUndefined();

    // v3.0.0：注册直写 user 表已删，兼容模式一律 410（改密同理，但需登录态才到 410 判定）
    const reg = await app.request(
      "/api/auth/register",
      { method: "POST", body: JSON.stringify({ name: "x", password: "TestPass123" }), headers: { "content-type": "application/json" } },
      env,
    );
    expect(reg.status).toBe(410);
  });

  it("OIDC 模式：旧登录/注册/改密端点移交认证中心，/api/auth/me 未登录也回 200", async () => {
    vi.stubGlobal("fetch", fakeFetch);
    const { env } = freshEnv(true);

    const post = async (path: string) => app.request(path, { method: "POST" }, env);
    const login = await post("/api/auth/login");
    expect(login.status).toBe(302);
    expect(login.headers.get("Location")).toBe("/api/auth/login");
    expect((await post("/api/auth/register")).headers.get("Location")).toBe(`${ISSUER}/register`);

    const me0 = await app.request("/api/auth/me", { method: "GET" }, env);
    expect(await me0.json()).toEqual({ user: null, authMode: "oidc", authHome: ISSUER, syncProbe: true });

    // 改密移交需有效会话（挂在 requireUser 后面）
    const { session } = await oidcLogin(env);
    const pwd = await app.request(
      "/api/auth/password",
      { method: "POST", headers: { Cookie: `__Host-tour_session=${session}` } },
      env,
    );
    expect(pwd.status).toBe(302);
    expect(pwd.headers.get("Location")).toBe(`${ISSUER}/password`);
  });

  it("发起登录：302 到 authorize，scope=openid + PKCE S256 + 临时 cookie", async () => {
    vi.stubGlobal("fetch", fakeFetch);
    const { env } = freshEnv(true);
    const { login, authUrl } = await oidcLogin(env);
    void authUrl;
    const u = new URL(login.headers.get("Location")!);
    expect(`${u.protocol}//${u.host}${u.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost/api/auth/callback");
    expect(u.searchParams.get("scope")).toBe("openid profile");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    // S256 challenge 恒 43 位 base64url（auth 侧逐字校验这个形态）
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.has("nonce")).toBe(true);
    expect(u.searchParams.has("state")).toBe(true);
    const sc = login.headers.getSetCookie().find((l) => l.startsWith("__Host-tour_oidc="));
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Lax");
    expect(sc).toContain("Max-Age=600");
    expect(sc).toContain("Path=/");
    expect(sc).toContain("Secure"); // __Host- 前缀强制
  });

  it("回调建会话：换票验签入库，/api/auth/me 认出人（authMode=oidc），旧 whl_session 被无视", async () => {
    vi.stubGlobal("fetch", fakeFetch);
    const { env, sqlite } = freshEnv(true);
    const { cb, session } = await oidcLogin(env);

    expect(cb.status).toBe(302);
    expect(new URL(cb.headers.get("Location")!, "http://localhost").pathname).toBe("/");
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // 临时 cookie 已删（空值过期），会话 cookie 属性齐全
    const deleted = cb.headers.getSetCookie().find((l) => l.startsWith("__Host-tour_oidc="));
    expect(deleted).toMatch(/^__Host-tour_oidc=;/);
    const sc = cb.headers.getSetCookie().find((l) => l.startsWith("__Host-tour_session="));
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Lax");
    expect(sc).toContain("Max-Age=604800");
    expect(sc).toContain("Secure");

    // 会话行：token_hash 是会话 cookie 的 sha256（独立实现核对），sub/sid 来自 id_token，
    // claims 是回调时 userinfo 的原样存档（收口后判定唯一依据）
    const row = sqlGet<{ token_hash: string; sub: string; auth_sid: string; claims: string; revoked_at: null }>(
      sqlite,
      "SELECT token_hash, sub, auth_sid, claims, revoked_at FROM oidc_session",
    );
    expect(row).toEqual({
      token_hash: createHash("sha256").update(session!).digest("hex"),
      sub: "2",
      auth_sid: "sid-1",
      claims: JSON.stringify({
        name: "oidc教练",
        locked: false,
        must_change_pw: false,
        roles: ["tour.coach"],
        permissions: ["tour.team.bind"],
      }),
      revoked_at: null,
    });

    // /api/auth/me 用会话 cookie 认人（姓名/角色/权限全部来自会话内 claims，不再查 user 表）
    const me = await app.request("/api/auth/me", { method: "GET", headers: { Cookie: `__Host-tour_session=${session}` } }, env);
    const meBody = (await me.json()) as { user: { id: number; name: string; role: string; locked: boolean; mustChangePassword: boolean }; authMode: string };
    expect(meBody.user).toEqual({ id: 2, name: "oidc教练", role: "coach", teamId: null, locked: false, mustChangePassword: false });
    expect(meBody.authMode).toBe("oidc");

    // 模式互斥：OIDC 模式下旧的共享会话 cookie 不再生效
    const legacy = await app.request("/api/auth/me", { method: "GET", headers: { Cookie: "whl_session=tok-legacy" } }, env);
    expect(((await legacy.json()) as { user: unknown }).user).toBeNull();
  });

  // v4.1.0：收口后本库 user 表没有写入方，但 14 列外键仍指向它（tactic.created_by、
  // match_event.created_by、audit_log.actor_user_id …）。回调不投影账号行，新账号的第一次
  // 写入就撞 FOREIGN KEY constraint failed → 500，而前端只看到「请求失败（500）」
  it("新账号登录：回调把账号投影进本库 user 表，此后写档不再撞外键（v4.1.0）", async () => {
    vi.stubGlobal("fetch", fakeFetch);
    const { env, sqlite } = freshEnv(true);
    // 账号 14 在认证中心存在、本库 user 表没有行——收口后的新账号就是这个形状
    const { cb } = await oidcLogin(env, {
      sub: "14",
      sid: "sid-new",
      userinfo: {
        sub: "14",
        name: "雷雷雷",
        locked: false,
        must_change_pw: false,
        roles: ["tour.coach"],
        permissions: ["tour.team.bind"],
      },
    });
    expect(cb.status).toBe(302);

    const row = sqlGet<{ name: string; password_hash: string; role: string; locked: number }>(
      sqlite,
      "SELECT name, password_hash, role, locked FROM user WHERE id = 14",
    );
    expect(row).toEqual({ name: "雷雷雷", password_hash: MIRROR_PASSWORD, role: "coach", locked: 0 });

    // 投影的意义就在这条：没有补行时它抛 FOREIGN KEY constraint failed（线上 2026-09-23 的形状）
    sqlite
      .prepare(
        "INSERT INTO tactic (team_id, created_by, code, form, buildup, line_height) VALUES (NULL, ?, ?, ?, ?, ?)",
      )
      .run(14, "12345678901", "433", "balanced", 50);
    expect(sqlGet<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM tactic WHERE created_by = 14")?.n).toBe(1);

    // 已存在的老账号：只同步 name/locked；role 与 password_hash 绝不能被覆盖
    // （role 跟着 auth 走就是第二个角色真源，password_hash 跟着走就是本地能自证身份）
    const { cb: cb2 } = await oidcLogin(env, {
      sub: "1",
      sid: "sid-admin",
      userinfo: {
        sub: "1",
        name: "改名后的管理",
        locked: true,
        must_change_pw: false,
        roles: ["tour.recorder"],
        permissions: ["tour.match.manage"],
      },
    });
    expect(cb2.status).toBe(302);
    expect(
      sqlGet<{ name: string; role: string; locked: number; password_hash: string }>(
        sqlite,
        "SELECT name, role, locked, password_hash FROM user WHERE id = 1",
      ),
    ).toEqual({ name: "改名后的管理", role: "admin", locked: 1, password_hash: userHash });
  });

  it("定时对账：补上没登录过的账号、同步改名与注册时间，不删行（v4.1.0）", async () => {
    const { env, sqlite } = freshEnv(true);
    const authSqlite = new DatabaseSync(":memory:");
    authSqlite.exec(
      "CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, locked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)",
    );
    authSqlite.exec(
      `INSERT INTO account (id, name, locked, created_at) VALUES
       (1, '改名后的管理', 1, '2026-09-01T00:00:00.000Z'),
       (2, 'oidc教练', 0, '2026-09-02T00:00:00.000Z'),
       (20, '新来的', 0, '2026-09-20T00:00:00.000Z')`,
    );
    await runAccountMirror({ ...env, AUTH_DB: createTestD1(authSqlite) } as never);

    // 建了账号却没登录过的 20 补上了；改名与注册时间按 auth 的真值纠正
    expect(sqlGet<{ name: string; created_at: string }>(sqlite, "SELECT name, created_at FROM user WHERE id = 20")).toEqual({
      name: "新来的",
      created_at: "2026-09-20T00:00:00.000Z",
    });
    expect(sqlGet<{ name: string; locked: number }>(sqlite, "SELECT name, locked FROM user WHERE id = 1")).toEqual({
      name: "改名后的管理",
      locked: 1,
    });
    // 只补不删：auth 里没有的本库行（例如已下线账号）留着，它们是历史数据的外键靶子
    expect(sqlGet<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM user")?.n).toBe(4);
    // 未配 AUTH_DB（本地 dev）不报错，只记日志跳过
    await expect(runAccountMirror(env as never)).resolves.toBeUndefined();
  });

  it("验收探针：OIDC 会话下教练端点与管理台端点正常认人、权限点照常拦人", async () => {
    vi.stubGlobal("fetch", fakeFetch);
    const { env, sqlite } = freshEnv(true);

    const coach = await oidcLogin(env, { sub: "2" });
    const admin = await oidcLogin(env, { sub: "1", sid: "sid-admin" });
    // 收口断言：判定只认会话内 claims——把本库 user 表清空，认人与权限判定照常工作
    sqlite.prepare("DELETE FROM user").run();

    const coachTeam = await app.request(
      "/api/coach/me/team",
      { method: "GET", headers: { Cookie: `__Host-tour_session=${coach.session}` } },
      env,
    );
    expect(coachTeam.status).toBe(200);
    expect(((await coachTeam.json()) as { team: unknown }).team).toBeNull();

    const orgSettings = await app.request(
      "/api/admin/org-settings",
      { method: "GET", headers: { Cookie: `__Host-tour_session=${admin.session}` } },
      env,
    );
    expect(orgSettings.status).toBe(200);

    // 教练撞管理台：403（claims 里没有 tour.match.manage，判定不因换认证方式而放宽）
    const forbidden = await app.request(
      "/api/admin/org-settings",
      { method: "GET", headers: { Cookie: `__Host-tour_session=${coach.session}` } },
      env,
    );
    expect(forbidden.status).toBe(403);

    // 被重置未改密的管理员：除改密/登出外全拦，文案指向认证中心
    const pending = await oidcLogin(env, { sub: "3", sid: "sid-pw" });
    const blocked = await app.request(
      "/api/admin/org-settings",
      { method: "GET", headers: { Cookie: `__Host-tour_session=${pending.session}` } },
      env,
    );
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { message: string }).message).toContain("认证中心");
  });

  // 线上教训（2026-09-23 用户反馈「500 报错」却查不出原因）：Hono 默认的未捕获异常处理是
  // console.error + text/plain 的 "Internal Server Error"，前端 res.json() 拿不到东西，
  // 于是只剩「请求失败（500）」——既没有给用户任何解释，也没有给排查留下路径。
  it("未捕获异常：500 回 JSON 带中文 message，并在日志里留下方法与路径（v4.1.0）", async () => {
    vi.stubGlobal("fetch", fakeFetch);
    const { env, sqlite } = freshEnv(true);
    const admin = await oidcLogin(env, { sub: "1", sid: "sid-admin" });
    // 制造真实的 DB 故障（不是 mock 抛错）：表没了，路由里的 UPDATE 就会炸
    sqlite.exec("DROP TABLE announcement");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await app.request(
      "/api/admin/announcements",
      {
        method: "POST",
        headers: {
          Cookie: `__Host-tour_session=${admin.session}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "标题", body: "正文" }),
      },
      env,
    );

    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "internal", message: "服务异常，请稍后重试" });
    const line = logged.mock.calls.map((c) => String(c[0])).find((s) => s.includes("announcements"));
    expect(line).toContain("POST");
    expect(line).toContain("no such table");
    logged.mockRestore();
  });

  it("账号管理台：端点经机器通道转发认证中心，snake_case 映射成前端要的 camelCase（v2.0.0）", async () => {
    vi.stubGlobal("fetch", fakeFetch);
    const { env } = freshEnv(true);
    const admin = await oidcLogin(env, { sub: "1", sid: "sid-admin" });
    const coach = await oidcLogin(env, { sub: "2", sid: "sid-coach" });

    const catalog = await app.request(
      "/api/admin/accounts/catalog",
      { method: "GET", headers: { Cookie: `__Host-tour_session=${admin.session}` } },
      env,
    );
    expect(catalog.status).toBe(200);
    const cat = (await catalog.json()) as {
      roles: { id: number; appId: string; key: string; name: string }[];
      permissions: { id: number; appId: string; key: string; description: string }[];
      rolePermissions: { roleId: number; permissionId: number }[];
    };
    expect(cat.roles).toEqual([{ id: 1, appId: "tour", key: "coach", name: "教练" }]);
    expect(cat.permissions).toEqual([{ id: 1, appId: "tour", key: "tour.team.bind", description: "绑定球队" }]);
    expect(cat.rolePermissions).toEqual([{ roleId: 1, permissionId: 1 }]);

    const list = await app.request(
      "/api/admin/accounts",
      { method: "GET", headers: { Cookie: `__Host-tour_session=${admin.session}` } },
      env,
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      accounts: { id: number; mustChangePassword: boolean; teamId: number | null; roles: unknown }[];
    };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].mustChangePassword).toBe(false);
    expect(body.accounts[0].teamId).toBeNull();
    expect(body.accounts[0].roles).toEqual([{ key: "tour.coach", name: "教练" }]);

    // 没有 tour.accounts.manage 的教练：403（权限点照常拦人，不因新端点放水）
    const forbidden = await app.request(
      "/api/admin/accounts",
      { method: "GET", headers: { Cookie: `__Host-tour_session=${coach.session}` } },
      env,
    );
    expect(forbidden.status).toBe(403);
  });

  it("审计日志：筛选参数透传认证中心 + snake_case 映射 camelCase，无权限点拦下（v3.1.0）", async () => {
    vi.stubGlobal("fetch", fakeFetch);
    const { env } = freshEnv(true);
    const admin = await oidcLogin(env, { sub: "1", sid: "sid-admin" });
    const coach = await oidcLogin(env, { sub: "2", sid: "sid-coach" });

    const res = await app.request(
      "/api/admin/audit?event=login.fail&account=3&since=2026-09-01T00:00:00.000Z",
      { method: "GET", headers: { Cookie: `__Host-tour_session=${admin.session}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { id: number; accountId: number | null; event: string; ip: string | null; createdAt: string }[];
      nextCursor: number | null;
    };
    expect(body.events).toHaveLength(2);
    expect(body.events[0]).toMatchObject({
      id: 12,
      accountId: 3,
      event: "login.fail",
      ip: "1.2.3.4",
      createdAt: "2026-09-19T00:00:00.000Z",
    });
    expect(body.nextCursor).toBeNull();
    // 查询参数确实透传给了认证中心（snake_case 原样；纯读端点不带 actor_id）
    expect(lastAuditBody).toMatchObject({ event: "login.fail", account_id: 3, since: "2026-09-01T00:00:00.000Z" });

    // 没有 tour.accounts.manage 的教练：403（审计含全生态安全事件，与账号管理同档）
    const forbidden = await app.request(
      "/api/admin/audit",
      { method: "GET", headers: { Cookie: `__Host-tour_session=${coach.session}` } },
      env,
    );
    expect(forbidden.status).toBe(403);
  });

  it("回调异常路径：state/临时 cookie/iss → 400；换票/验签/nonce/PKCE → 502", async () => {
    vi.stubGlobal("fetch", fakeFetch);
    const { env } = freshEnv(true);
    const login = await app.request("/api/auth/login", { method: "GET" }, env);
    const authUrl = new URL(login.headers.get("Location")!);
    const temp = cookieOf(login, "__Host-tour_oidc")!;
    const state = authUrl.searchParams.get("state")!;

    const bad = (query: string, cookie?: string) =>
      app.request(
        `/api/auth/callback?${query}`,
        { method: "GET", headers: cookie ? { Cookie: `__Host-tour_oidc=${cookie}` } : {} },
        env,
      );

    // state 不符（CSRF 防线）、临时 cookie 丢失、iss 与配置的认证中心不一致（RFC 9207 自查）
    expect((await bad(`code=C&state=other&iss=${encodeURIComponent(ISSUER)}`, temp)).status).toBe(400);
    expect((await bad(`code=C&state=${state}&iss=${encodeURIComponent(ISSUER)}`)).status).toBe(400);
    expect((await bad(`code=C&state=${state}&iss=https://evil.example`, temp)).status).toBe(400);

    // 换票失败（伪 auth 500）→ 502
    stub = {
      code: "CODE-2",
      challenge: authUrl.searchParams.get("code_challenge")!,
      nonce: authUrl.searchParams.get("nonce")!,
      sub: "2",
      sid: "sid-1",
      tokenStatus: 500,
      tokenCalls: [],
    };
    expect((await bad(`code=CODE-2&state=${state}&iss=${encodeURIComponent(ISSUER)}`, temp)).status).toBe(502);

    // 签名不对（rogue 密钥、kid 冒用）→ 502
    stub = {
      ...stub,
      tokenStatus: undefined,
      idToken: await mint(rogue, { iss: ISSUER, aud: CLIENT_ID, sub: "2", sid: "sid-1", nonce: stub.nonce, iat: nowSec(), exp: nowSec() + 600 }),
    };
    expect((await bad(`code=CODE-2&state=${state}&iss=${encodeURIComponent(ISSUER)}`, temp)).status).toBe(502);

    // nonce 不符（防重放）→ 502
    stub = {
      ...stub,
      idToken: await mint(signing, { iss: ISSUER, aud: CLIENT_ID, sub: "2", sid: "sid-1", nonce: "other-nonce", iat: nowSec(), exp: nowSec() + 600 }),
    };
    expect((await bad(`code=CODE-2&state=${state}&iss=${encodeURIComponent(ISSUER)}`, temp)).status).toBe(502);

    // sub 不是数字串（必须是 tour user id）→ 502
    stub = {
      ...stub,
      idToken: await mint(signing, { iss: ISSUER, aud: CLIENT_ID, sub: "not-a-number", sid: "sid-1", nonce: stub.nonce, iat: nowSec(), exp: nowSec() + 600 }),
    };
    expect((await bad(`code=CODE-2&state=${state}&iss=${encodeURIComponent(ISSUER)}`, temp)).status).toBe(502);

    // PKCE verifier 与 authorize 的 challenge 不符：伪 auth 拒绝换票（400）→ tour 502
    stub = { ...stub, idToken: undefined, challenge: "A".repeat(43) };
    expect((await bad(`code=CODE-2&state=${state}&iss=${encodeURIComponent(ISSUER)}`, temp)).status).toBe(502);
    expect(stub.tokenCalls.at(-1)!.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // userinfo 失败 / 缺关键字段（收口后 claims 是判定唯一来源，拉不到/不完整不能建会话）→ 502
    stub = { ...stub, challenge: authUrl.searchParams.get("code_challenge")!, userinfoStatus: 500 };
    expect((await bad(`code=CODE-2&state=${state}&iss=${encodeURIComponent(ISSUER)}`, temp)).status).toBe(502);
    stub = { ...stub, userinfoStatus: undefined, userinfo: { sub: "2", locked: false } };
    expect((await bad(`code=CODE-2&state=${state}&iss=${encodeURIComponent(ISSUER)}`, temp)).status).toBe(502);
  });

  it("登出：吊销本地会话行，返回认证中心 end_session 地址带白名单回跳", async () => {
    vi.stubGlobal("fetch", fakeFetch);
    const { env, sqlite } = freshEnv(true);
    const { session } = await oidcLogin(env);

    const logout = await app.request(
      "/api/auth/logout",
      { method: "POST", headers: { Cookie: `__Host-tour_session=${session}` } },
      env,
    );
    expect(logout.status).toBe(200);
    const body = (await logout.json()) as { ok: boolean; redirect: string };
    expect(body.ok).toBe(true);
    const target = new URL(body.redirect);
    expect(`${target.protocol}//${target.host}${target.pathname}`).toBe(`${ISSUER}/logout`);
    expect(target.searchParams.get("post_logout_redirect_uri")).toBe("http://localhost/");

    // 两枚 cookie 都被清掉
    const cleared = logout.headers.getSetCookie().filter((l) => l.startsWith("__Host-tour_"));
    expect(cleared.length).toBe(2);
    for (const line of cleared) expect(line).toMatch(/Max-Age=0/i);

    const row = sqlGet<{ revoked_at: string | null }>(sqlite, "SELECT revoked_at FROM oidc_session");
    expect(row?.revoked_at).not.toBeNull();

    const me = await app.request("/api/auth/me", { method: "GET", headers: { Cookie: `__Host-tour_session=${session}` } }, env);
    expect(((await me.json()) as { user: unknown }).user).toBeNull();
  });

  it("back-channel：按 sid 吊销会话并回 200 空体；坏 token 400；未知 sid 不动既有会话", async () => {
    vi.stubGlobal("fetch", fakeFetch);
    const { env, sqlite } = freshEnv(true);
    const { session } = await oidcLogin(env, { sid: "sid-bc-1" });

    const post = async (token: string) =>
      app.request(
        "/api/auth/backchannel-logout",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ logout_token: token }),
        },
        env,
      );
    const logoutClaims = (sid: string, extra: JWTPayload = {}): JWTPayload => ({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: "2",
      sid,
      jti: "jti-1",
      iat: nowSec(),
      events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
      ...extra,
    });

    // 签名不对 → 400；带 nonce → 400（规范禁止 logout_token 携带 nonce）
    expect((await post(await mint(rogue, logoutClaims("sid-bc-1")))).status).toBe(400);
    expect((await post(await mint(signing, logoutClaims("sid-bc-1", { nonce: "x" })))).status).toBe(400);

    // 缺登出事件 → 400
    const { events: _drop, ...noEvent } = logoutClaims("sid-bc-1");
    expect((await post(await mint(signing, noEvent))).status).toBe(400);

    // 正常通知 → 200 空体，会话行被吊销，/api/auth/me 立刻认不出人
    const ok = await post(await mint(signing, logoutClaims("sid-bc-1")));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("");
    const row = sqlGet<{ revoked_at: string | null }>(sqlite, "SELECT revoked_at FROM oidc_session");
    expect(row?.revoked_at).not.toBeNull();
    const me = await app.request("/api/auth/me", { method: "GET", headers: { Cookie: `__Host-tour_session=${session}` } }, env);
    expect(((await me.json()) as { user: unknown }).user).toBeNull();

    // 未知 sid 也回 200（规范），且不影响其他存活会话
    const other = await oidcLogin(env, { sid: "sid-bc-2" });
    expect(other.cb.status).toBe(302);
    expect((await post(await mint(signing, logoutClaims("sid-unknown")))).status).toBe(200);
    const alive = sqlGet<{ revoked_at: string | null }>(
      sqlite,
      "SELECT revoked_at FROM oidc_session WHERE auth_sid = 'sid-bc-2'",
    );
    expect(alive?.revoked_at).toBeNull();
  });

describe("静默同步探测（prompt=none，进站即探测）", () => {
  async function startSync(env: Record<string, unknown>, back = "/portal") {
    const sync = await app.request(`/api/auth/sync?back=${encodeURIComponent(back)}`, { method: "GET" }, env);
    expect(sync.status).toBe(302);
    const authUrl = new URL(sync.headers.get("Location")!);
    expect(authUrl.origin).toBe(ISSUER);
    expect(authUrl.searchParams.get("prompt")).toBe("none");
    expect(authUrl.searchParams.get("redirect_uri")).toContain("/api/auth/callback");
    return { authUrl, temp: cookieOf(sync, "__Host-tour_oidc"), probe: cookieOf(sync, "__Host-tour_probe") };
  }

  it("sync 端点：prompt=none 发起，temp 存 returnTo，种 60 秒冷却标记；me 据此下发 syncProbe", async () => {
    const { env } = freshEnv(true);
    const { authUrl, temp, probe } = await startSync(env);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(JSON.parse(b64urlDecode(temp!)).returnTo).toBe("/portal");
    expect(probe).toBe("1");
    // 探测冷却 60 秒（temp 中转仍是 600，别改错对象）
    const probeSc = (await app.request("/api/auth/sync?back=%2F", { method: "GET" }, env))
      .headers.getSetCookie().find((l) => l.startsWith("__Host-tour_probe="));
    expect(probeSc).toContain("Max-Age=60");
    const me = await app.request("/api/auth/me", { method: "GET" }, env);
    expect(((await me.json()) as { syncProbe?: boolean }).syncProbe).toBe(true);
    // 冷却中的 me：syncProbe 不再下发
    const meCooling = await app.request("/api/auth/me", { method: "GET", headers: { Cookie: "__Host-tour_probe=1" } }, env);
    expect(((await meCooling.json()) as { syncProbe?: boolean }).syncProbe).toBeUndefined();
  });

  it("auth 无会话回 error=login_required：原路送回来源页继续匿名，不出错页", async () => {
    const { env } = freshEnv(true);
    const { authUrl, temp } = await startSync(env);
    const cb = await app.request(
      `/api/auth/callback?error=login_required&state=${authUrl.searchParams.get("state")}&iss=${encodeURIComponent(ISSUER)}`,
      { method: "GET", headers: { Cookie: `__Host-tour_oidc=${temp}` } },
      env,
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("Location")).toBe("/portal");
    expect(cookieOf(cb, "__Host-tour_session")).toBeUndefined();
  });

  it("auth 有会话：静默登录回跳来源页；back 非站内相对路径归一化为 /", async () => {
    vi.stubGlobal("fetch", fakeFetch);
    const { env, sqlite } = freshEnv(true);
    const { authUrl, temp } = await startSync(env, "https://evil.example/x");
    expect(JSON.parse(b64urlDecode(temp!)).returnTo).toBe("/");
    stub = { code: "CODE-1", challenge: authUrl.searchParams.get("code_challenge")!, nonce: authUrl.searchParams.get("nonce")!, sub: "2", sid: "sid-1", tokenCalls: [] };
    const cb = await app.request(
      `/api/auth/callback?code=${stub.code}&state=${authUrl.searchParams.get("state")}&iss=${encodeURIComponent(ISSUER)}`,
      { method: "GET", headers: { Cookie: `__Host-tour_oidc=${temp}` } },
      env,
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("Location")).toBe("/");
    expect(cookieOf(cb, "__Host-tour_session")).toBeTruthy();
  });

  it("stale 会话：me 认不出人（行已撤销）→ 下发 syncProbe + 清掉无效会话 cookie", async () => {
    vi.stubGlobal("fetch", fakeFetch);
    const { env, sqlite } = freshEnv(true);
    const { session } = await oidcLogin(env);
    // 正常会话：me 认人，无 syncProbe，不清 cookie
    const meLive = await app.request("/api/auth/me", { method: "GET", headers: { Cookie: `__Host-tour_session=${session}` } }, env);
    const liveJson = (await meLive.json()) as { user: unknown; syncProbe?: boolean };
    expect(liveJson.user).toBeTruthy();
    expect(liveJson.syncProbe).toBeUndefined();
    expect(meLive.headers.getSetCookie().find((l) => l.startsWith("__Host-tour_session="))).toBeUndefined();
    // 撤销后（back-channel 登出撤行的浏览器侧后果）：cookie 还在但行没了 → 清 cookie + 照常探测
    sqlite.prepare("UPDATE oidc_session SET revoked_at = '2020-01-01T00:00:00.000Z'").run();
    const meStale = await app.request("/api/auth/me", { method: "GET", headers: { Cookie: `__Host-tour_session=${session}` } }, env);
    const staleJson = (await meStale.json()) as { user: unknown; syncProbe?: boolean };
    expect(staleJson.user).toBeNull();
    expect(staleJson.syncProbe).toBe(true);
    const sc = meStale.headers.getSetCookie().find((l) => l.startsWith("__Host-tour_session="));
    expect(sc).toMatch(/^__Host-tour_session=;/);
    expect(sc).toContain("Max-Age=0");
  });
});

});
