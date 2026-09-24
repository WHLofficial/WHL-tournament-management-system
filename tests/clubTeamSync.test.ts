// 增量 37：球队建档双向同步（tour 侧）测试。
//
// 覆盖三块：
//   ① 入站机器端点 POST /api/internal/team-upsert —— 验签矩阵（错签/缺头/过期/未配密钥 fail-closed）、
//      幂等（同 id 不覆写、名字不同只回报 nameDiffers）、显式 id 与 created_by 留空、认证中心登记；
//   ② 出站 pushTeamToClub —— URL/头名/签名串/体形状，以及四类失败文案；
//   ③ 四个调用点（单个建队 / 批量建队 / 批量报名 / 手动重推）在新入参「游戏球队 ID + 队名」下的行为，
//      重点是「同步失败不回滚本地、本地建队优先」。
//
// 签名契约与俱乐部仓 tests/team-sync.test.ts 逐字对称：两侧各有一份独立算出的金标准，
// 任何一侧偷偷改口径（路径、签名串、头名、时间窗）都会在这里红。
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import app from "../worker/index";
import { hashPassword } from "../worker/lib/crypto";
import { applyMigrations, createTestD1, createTestKV, sqlAll, sqlGet } from "./d1";
import { TEAM_UPSERT_PATH, hmacHex, pushError, pushTeamToClub } from "../worker/lib/clubSync";
import { BULK_MAX, NAME_MAX, parseBulkLine } from "../worker/lib/teamBulk";

const CLUB_BASE = "https://club.example";
const SECRET = "team-sync-secret";
const ISSUER = "https://auth.example";
const AUTH_SECRET = "machine-secret";

const nowSec = () => Math.floor(Date.now() / 1000);

// ---- fetch 桩：同时充当俱乐部平台与伪认证中心 ----

interface Captured {
  url: string;
  path: string;
  headers: Record<string, string>;
  raw: string;
  body: Record<string, unknown> | null;
}

let captures: Captured[] = [];
let clubReply: (path: string) => { status: number; body: unknown } = () => ({
  status: 200,
  body: { ok: true, created: true, authLinked: true },
});

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof URL ? input : new URL(String(input));
  const raw = String(init?.body ?? "");
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    body = null;
  }
  captures.push({ url: url.href, path: url.pathname, headers: (init?.headers ?? {}) as Record<string, string>, raw, body });

  if (url.origin === ISSUER && url.pathname.startsWith("/api/team/")) {
    return new Response(JSON.stringify({ ok: true, teamId: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.origin === CLUB_BASE) {
    const out = clubReply(url.pathname);
    return new Response(JSON.stringify(out.body), {
      status: out.status,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("not found", { status: 404 });
}

const pushed = () => captures.filter((c) => c.path === TEAM_UPSERT_PATH);
const registered = () => captures.filter((c) => c.path === "/api/team/register");

// ---- tour 侧环境（兼容模式 KV 会话，管理员 id 1） ----

let userHash = "";

function freshEnv(opts: { clubBase?: boolean; secret?: boolean; auth?: boolean } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const h = userHash;
  sqlite
    .prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(1, "管理员", "", h, "admin", 0, 0);
  const kv = new Map<string, string>([["sess:tok-admin", JSON.stringify({ userId: 1 })]]);

  const authSqlite = new DatabaseSync(":memory:");
  authSqlite.exec(
    "CREATE TABLE team (id INTEGER PRIMARY KEY, tour_team_id INTEGER UNIQUE, club_id INTEGER UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL)",
  );

  const env: Record<string, unknown> = {
    DB: createTestD1(sqlite),
    KV: createTestKV(kv) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
    ...(opts.clubBase !== false ? { CLUB_API_BASE: CLUB_BASE } : {}),
    ...(opts.secret !== false ? { TEAM_SYNC_SECRET: SECRET } : {}),
    ...(opts.auth !== false
      ? { AUTH_DB: createTestD1(authSqlite), AUTH_BIND_SECRET: AUTH_SECRET, OIDC_ISSUER: ISSUER }
      : {}),
  };
  return { env, sqlite };
}

const post = (env: Record<string, unknown>, path: string, body: unknown, token = "tok-admin") =>
  app.request(
    path,
    {
      method: "POST",
      headers: { Cookie: `whl_session=${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );

const patch = (env: Record<string, unknown>, path: string, body: unknown, token = "tok-admin") =>
  app.request(
    path,
    {
      method: "PATCH",
      headers: { Cookie: `whl_session=${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );

/** 直接按入站契约发起请求：默认不带 Cookie——机器通道必须靠验签放行，不能靠会话 */
function inbound(
  env: Record<string, unknown>,
  body: unknown,
  opts: {
    secret?: string;
    ts?: number;
    sign?: string;
    omitSign?: boolean;
    omitTs?: boolean;
    raw?: string;
    /** 只改签名覆盖的串、不改实际发送的体——用来验证「签名有效但请求体被换掉」也必须拒 */
    signOver?: string;
    upper?: boolean;
  } = {},
) {
  const raw = opts.raw ?? JSON.stringify(body);
  const ts = opts.ts ?? nowSec();
  const headers: Record<string, string> = { "content-type": "application/json" };
  const tName = opts.upper ? "X-Timestamp" : "x-timestamp";
  const sName = opts.upper ? "X-Sign" : "x-sign";
  if (!opts.omitTs) headers[tName] = String(ts);
  if (!opts.omitSign) {
    headers[sName] =
      opts.sign ??
      createHmac("sha256", opts.secret ?? SECRET)
        .update(`POST|${TEAM_UPSERT_PATH}|${ts}|${opts.signOver ?? raw}`)
        .digest("hex");
  }
  return app.request(TEAM_UPSERT_PATH, { method: "POST", headers, body: raw }, env);
}

/** 插一个报名期赛事，供批量报名用例使用 */
function seedTournament(sqlite: DatabaseSync, status = "registering", id = 1) {
  sqlite
    .prepare("INSERT INTO tournament (id, org_id, name, format, status, created_by) VALUES (?, 1, ?, 'single_elim', ?, 1)")
    .run(id, "测试杯", status);
}

function seedTeam(sqlite: DatabaseSync, id: number, name: string, createdBy: number | null = 1) {
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_by) VALUES (?, 1, ?, ?)").run(id, name, createdBy);
}

beforeAll(async () => {
  userHash = await hashPassword("TestPass123"); // PBKDF2 走 crypto.subtle，须 await
});

beforeEach(() => {
  captures = [];
  clubReply = () => ({ status: 200, body: { ok: true, created: true, authLinked: true } });
  vi.stubGlobal("fetch", fakeFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// =====================================================================================
describe("增量 37：入站机器端点 POST /api/internal/team-upsert", () => {
  it("正签建档：显式 id 落库、created_by 留空、认证中心登记，且不需要会话 cookie", async () => {
    const { env, sqlite } = freshEnv();
    const res = await inbound(env, { id: 700, name: "推来的队" });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, created: true, authLinked: true });

    // 三处同号的前提：id 就是推过来的游戏球队 ID；created_by 留空（机器没有本仓用户身份）
    expect(sqlGet(sqlite, "SELECT id, name, org_id, created_by FROM team WHERE id = ?", 700)).toEqual({
      id: 700,
      name: "推来的队",
      org_id: 1,
      created_by: null,
    });
    // 认证中心目录登记：tour_team_id 用同一个号
    expect(registered()).toHaveLength(1);
    expect(registered()[0].body).toEqual({ tour_team_id: 700, name: "推来的队" });
  });

  it("幂等：同 id 再来一次不覆写；名字不同只回报 nameDiffers，也不再重复登记认证中心", async () => {
    const { env, sqlite } = freshEnv();
    seedTeam(sqlite, 700, "本仓原名");
    captures = [];

    const res = await inbound(env, { id: 700, name: "推来的新名" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, created: false, name: "本仓原名", nameDiffers: true });
    expect(sqlGet<{ name: string }>(sqlite, "SELECT name FROM team WHERE id = ?", 700)!.name).toBe("本仓原名");
    expect(captures).toHaveLength(0);

    const same = await inbound(env, { id: 700, name: "本仓原名" });
    expect((await same.json()).nameDiffers).toBe(false);
  });

  it.each([
    ["签名是别的密钥算的", { secret: "wrong-secret" }],
    ["签名头缺失", { omitSign: true }],
    ["时间戳头缺失", { omitTs: true }],
    ["时间戳不是数字", { ts: Number("abc") }],
    // 超窗两条传的是相对冻结时钟的偏移，不是 nowSec()±301：用例表在收集阶段求值，
    // 真时钟若在「建表」与「发请求」之间走满一秒，超前 301 就会翻回窗内、端点会正确放行。
    ["时间戳过期 301 秒", { tsDelta: -301 }],
    ["时间戳超前 301 秒", { tsDelta: +301 }],
    ["签名对但请求体被换掉", { signOver: JSON.stringify({ id: 700, name: "被换过的名字" }) }],
  ])("验签失败一律 403 且不落库：%s", async (_label, opts) => {
    const { env, sqlite } = freshEnv();
    const { tsDelta } = opts as { tsDelta?: number };
    let res: Response;
    if (tsDelta === undefined) {
      res = await inbound(env, { id: 700, name: "偷渡的队" }, opts as never);
    } else {
      const frozen = new Date("2026-01-01T00:00:00Z");
      const base = Math.floor(frozen.getTime() / 1000);
      vi.useFakeTimers();
      vi.setSystemTime(frozen);
      try {
        res = await inbound(env, { id: 700, name: "偷渡的队" }, { ts: base + tsDelta } as never);
      } finally {
        vi.useRealTimers();
      }
    }
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("bad_signature");
    expect(sqlGet(sqlite, "SELECT id FROM team WHERE id = ?", 700)).toBeUndefined();
  });

  it("大写头名 X-Timestamp / X-Sign 同样通过（HTTP 头名大小写不敏感）", async () => {
    const { env, sqlite } = freshEnv();
    const res = await inbound(env, { id: 700, name: "大写头" }, { upper: true });
    expect(res.status).toBe(201);
    expect(sqlGet(sqlite, "SELECT id FROM team WHERE id = ?", 700)).toBeDefined();
  });

  it("时间窗边界：±300 秒收，±301 秒拒（冻结时钟，避免真时钟走一秒把边界翻面）", async () => {
    const frozen = new Date("2026-01-01T00:00:00Z");
    const base = Math.floor(frozen.getTime() / 1000);
    vi.useFakeTimers();
    vi.setSystemTime(frozen);
    try {
      const accept = [-300, -299, 0, 299, 300];
      const reject = [-301, 301];
      for (const [i, delta] of accept.entries()) {
        const { env, sqlite } = freshEnv();
        const res = await inbound(env, { id: 800 + i, name: `边界${delta}` }, { ts: base + delta });
        expect(res.status, `delta=${delta} 应通过`).toBe(201);
        expect(sqlGet(sqlite, "SELECT id FROM team WHERE id = ?", 800 + i)).toBeDefined();
      }
      for (const delta of reject) {
        const { env, sqlite } = freshEnv();
        const res = await inbound(env, { id: 900, name: "超窗" }, { ts: base + delta });
        expect(res.status, `delta=${delta} 应拒绝`).toBe(403);
        expect(sqlGet(sqlite, "SELECT id FROM team WHERE id = ?", 900)).toBeUndefined();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("本仓未配 TEAM_SYNC_SECRET → 503，fail-closed（写端点不能像 cron 那样缺密钥就放行）", async () => {
    const { env, sqlite } = freshEnv({ secret: false });
    const res = await inbound(env, { id: 700, name: "偷渡的队" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unconfigured", message: "本仓未配置 TEAM_SYNC_SECRET，拒绝机器写入" });
    expect(sqlGet(sqlite, "SELECT id FROM team WHERE id = ?", 700)).toBeUndefined();
  });

  it.each([
    ["请求体不是 JSON", { raw: "{oops", error: "bad_json" }],
    ["id 为 0", { body: { id: 0, name: "x" }, error: "bad_id" }],
    ["id 为负", { body: { id: -3, name: "x" }, error: "bad_id" }],
    ["id 不是整数", { body: { id: 1.5, name: "x" }, error: "bad_id" }],
    ["id 不是数字", { body: { id: "abc", name: "x" }, error: "bad_id" }],
    ["队名空白", { body: { id: 700, name: "   " }, error: "bad_name" }],
    ["队名超 40 字", { body: { id: 700, name: "あ".repeat(41) }, error: "bad_name" }],
  ])("入参校验 400：%s", async (_label, c) => {
    const { env, sqlite } = freshEnv();
    const res = await inbound(env, (c as { body?: unknown }).body ?? null, c as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe((c as { error: string }).error);
    expect(sqlGet(sqlite, "SELECT id FROM team WHERE id = ?", 700)).toBeUndefined();
  });

  it("队名正好 40 字通过（与 club.clubs.name 上限对齐，推过去不会被拒）", async () => {
    const { env, sqlite } = freshEnv();
    const name = "あ".repeat(NAME_MAX);
    const res = await inbound(env, { id: 700, name });
    expect(res.status).toBe(201);
    expect(sqlGet<{ name: string }>(sqlite, "SELECT name FROM team WHERE id = ?", 700)!.name).toBe(name);
  });

  it("队名已被别的球队占用 → 409 且指名道姓（不能只说「ID 被占用」，操作员填的是队名）", async () => {
    const { env, sqlite } = freshEnv();
    seedTeam(sqlite, 800, "已经存在的队名");
    const res = await inbound(env, { id: 801, name: "已经存在的队名" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "conflict",
      message: "队名「已经存在的队名」已被球队 #800 占用",
    });
    expect(sqlGet(sqlite, "SELECT id FROM team WHERE id = ?", 801)).toBeUndefined();
    expect(sqlGet<{ name: string }>(sqlite, "SELECT name FROM team WHERE id = ?", 800)!.name).toBe("已经存在的队名");
  });

  it("认证中心不可用不影响建档：authLinked=false，队照样落库", async () => {
    const { env, sqlite } = freshEnv();
    vi.stubGlobal("fetch", () => Promise.reject(new Error("auth down")));
    const res = await inbound(env, { id: 700, name: "认证中心挂了也要建" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, created: true, authLinked: false });
    expect(sqlGet(sqlite, "SELECT id FROM team WHERE id = ?", 700)).toBeDefined();
  });
});

// =====================================================================================
describe("增量 37：出站 pushTeamToClub 契约", () => {
  const clubEnv = { CLUB_API_BASE: CLUB_BASE, TEAM_SYNC_SECRET: SECRET } as never;

  it("未配基址 / 未配密钥：只回报不抛（本地建队优先，失败是可重试的旁路）", async () => {
    expect(await pushTeamToClub({} as never, { id: 1, name: "a" })).toEqual({
      ok: false,
      message: "未配置 CLUB_API_BASE，无法同步到俱乐部平台",
    });
    expect(await pushTeamToClub({ CLUB_API_BASE: CLUB_BASE } as never, { id: 1, name: "a" })).toEqual({
      ok: false,
      message: "未配置 TEAM_SYNC_SECRET，无法同步到俱乐部平台",
    });
    expect(pushError({ ok: true })).toBeNull();
    expect(pushError({ ok: false, message: "x" })).toBe("x");
  });

  it("正签：URL / 头名 / 体形状 / 签名串逐字（期望值用 node:crypto 独立复算）", async () => {
    expect(await pushTeamToClub(clubEnv, { id: 700, name: "Arsenal", operator: 1 })).toEqual({ ok: true });
    expect(pushed()).toHaveLength(1);
    const cap = pushed()[0];
    expect(cap.url).toBe(`${CLUB_BASE}${TEAM_UPSERT_PATH}`);
    expect(cap.body).toEqual({ id: 700, name: "Arsenal", operator: 1 });
    expect(cap.headers["content-type"]).toBe("application/json");
    const ts = Number(cap.headers["x-timestamp"]);
    expect(cap.headers["x-sign"]).toBe(
      createHmac("sha256", SECRET).update(`POST|${TEAM_UPSERT_PATH}|${ts}|${cap.raw}`).digest("hex"),
    );
    // 与仓内 hmacHex 实现互证（crypto.subtle 与 node:crypto 必须同值）
    expect(cap.headers["x-sign"]).toBe(await hmacHex(SECRET, `POST|${TEAM_UPSERT_PATH}|${ts}|${cap.raw}`));
  });

  it("不带 operator 时体里就没有这个字段（机器侧没有本仓用户身份）", async () => {
    await pushTeamToClub(clubEnv, { id: 700, name: "Arsenal" });
    expect(pushed()[0].body).toEqual({ id: 700, name: "Arsenal" });
  });

  it("基址带尾斜杠不拼出双斜杠", async () => {
    await pushTeamToClub({ CLUB_API_BASE: `${CLUB_BASE}//`, TEAM_SYNC_SECRET: SECRET } as never, { id: 700, name: "Arsenal" });
    expect(pushed()[0].url).toBe(`${CLUB_BASE}${TEAM_UPSERT_PATH}`);
  });

  it("对端不可达 → 固定文案；非 2xx 透传对方 message，没有 message 则兜底带状态码", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("boom")));
    expect(await pushTeamToClub(clubEnv, { id: 700, name: "Arsenal" })).toEqual({
      ok: false,
      message: "俱乐部平台不可达",
    });

    vi.stubGlobal("fetch", fakeFetch);
    clubReply = () => ({ status: 409, body: { error: "conflict", message: "球队 ID #700 已被登记册占用" } });
    expect(await pushTeamToClub(clubEnv, { id: 700, name: "Arsenal" })).toEqual({
      ok: false,
      message: "球队 ID #700 已被登记册占用",
    });

    clubReply = () => ({ status: 502, body: { error: "oops" } });
    expect(await pushTeamToClub(clubEnv, { id: 700, name: "Arsenal" })).toEqual({
      ok: false,
      message: "俱乐部平台拒绝同步（HTTP 502）",
    });
  });
});

// =====================================================================================
describe("增量 37：建队端点（游戏球队 ID + 队名）", () => {
  it("201：显式 id 落库、created_by 记管理员、推给俱乐部平台并回报 clubSyncError:null", async () => {
    const { env, sqlite } = freshEnv();
    const res = await post(env, "/api/admin/teams", { gameTeamId: 700, name: "Arsenal" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ team: { id: 700, name: "Arsenal" }, clubSyncError: null });

    expect(sqlGet(sqlite, "SELECT id, org_id, name, created_by FROM team WHERE id = ?", 700)).toEqual({
      id: 700,
      org_id: 1,
      name: "Arsenal",
      created_by: 1,
    });
    expect(pushed()).toHaveLength(1);
    expect(pushed()[0].body).toEqual({ id: 700, name: "Arsenal", operator: 1 });
  });

  it.each([
    ["没填 ID", { name: "Arsenal" }, "游戏球队 ID 应为正整数（与游戏内球队编号一致）"],
    ["ID 为 0", { gameTeamId: 0, name: "Arsenal" }, "游戏球队 ID 应为正整数（与游戏内球队编号一致）"],
    ["ID 不是整数", { gameTeamId: 2.5, name: "Arsenal" }, "游戏球队 ID 应为正整数（与游戏内球队编号一致）"],
    ["队名空白", { gameTeamId: 700, name: "   " }, `队名不能为空，且不超过 ${NAME_MAX} 字`],
    ["队名超 40 字", { gameTeamId: 700, name: "あ".repeat(41) }, `队名不能为空，且不超过 ${NAME_MAX} 字`],
  ])("入参校验 400：%s", async (_label, body, message) => {
    const { env, sqlite } = freshEnv();
    const res = await post(env, "/api/admin/teams", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message });
    expect(sqlAll(sqlite, "SELECT id FROM team")).toHaveLength(0);
    expect(captures).toHaveLength(0);
  });

  it("队名正好 40 字可以建（上限与俱乐部平台对齐）", async () => {
    const { env } = freshEnv();
    const res = await post(env, "/api/admin/teams", { gameTeamId: 700, name: "あ".repeat(NAME_MAX) });
    expect(res.status).toBe(201);
  });

  it("ID 已被占用 → 409，且不推送（不能把别人的队改名推过去）", async () => {
    const { env, sqlite } = freshEnv();
    seedTeam(sqlite, 700, "原有的队");
    const res = await post(env, "/api/admin/teams", { gameTeamId: 700, name: "冒名队" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ message: "球队 ID #700 已被占用" });
    expect(captures).toHaveLength(0);
  });

  it("同名但不同 ID → 409（本仓 UNIQUE(org_id,name)）", async () => {
    const { env, sqlite } = freshEnv();
    seedTeam(sqlite, 700, "Arsenal");
    const res = await post(env, "/api/admin/teams", { gameTeamId: 701, name: "Arsenal" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ message: "同名球队已存在" });
    expect(captures).toHaveLength(0);
  });

  it("推送失败不回滚本地建队：201 + clubSyncError，队仍在库里（可点「同步」重试）", async () => {
    const { env, sqlite } = freshEnv();
    clubReply = () => ({ status: 500, body: {} });
    const res = await post(env, "/api/admin/teams", { gameTeamId: 700, name: "Arsenal" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      team: { id: 700, name: "Arsenal" },
      clubSyncError: "俱乐部平台拒绝同步（HTTP 500）",
    });
    expect(sqlGet(sqlite, "SELECT id FROM team WHERE id = ?", 700)).toBeDefined();
  });

  it("未配 CLUB_API_BASE：本地照建，只回报配置提示（本地可用优先）", async () => {
    const { env, sqlite } = freshEnv({ clubBase: false });
    const res = await post(env, "/api/admin/teams", { gameTeamId: 700, name: "Arsenal" });
    expect(res.status).toBe(201);
    expect((await res.json()).clubSyncError).toBe("未配置 CLUB_API_BASE，无法同步到俱乐部平台");
    expect(sqlGet(sqlite, "SELECT id FROM team WHERE id = ?", 700)).toBeDefined();
    expect(captures).toHaveLength(0);
  });

  it("PATCH 改名：40 字通过、41 字 400（改名不联动，上限仍要对齐）", async () => {
    const { env, sqlite } = freshEnv();
    seedTeam(sqlite, 700, "旧名");
    const ok = await patch(env, "/api/admin/teams/700", { name: "あ".repeat(NAME_MAX) });
    expect(ok.status).toBe(200);
    const tooLong = await patch(env, "/api/admin/teams/700", { name: "あ".repeat(NAME_MAX + 1) });
    expect(tooLong.status).toBe(400);
    expect(sqlGet<{ name: string }>(sqlite, "SELECT name FROM team WHERE id = ?", 700)!.name).toBe("あ".repeat(NAME_MAX));
    // 改名不推送
    expect(captures).toHaveLength(0);
  });

  it("POST /:id/sync-club：成功 200；推送失败 502；队不存在 404", async () => {
    const { env, sqlite } = freshEnv();
    seedTeam(sqlite, 700, "Arsenal");

    const ok = await post(env, "/api/admin/teams/700/sync-club", {});
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(pushed()[0].body).toEqual({ id: 700, name: "Arsenal", operator: 1 });

    clubReply = () => ({ status: 409, body: { message: "球队 ID #700 已被登记册占用" } });
    const bad = await post(env, "/api/admin/teams/700/sync-club", {});
    expect(bad.status).toBe(502);
    expect(await bad.json()).toEqual({ message: "球队 ID #700 已被登记册占用" });

    const missing = await post(env, "/api/admin/teams/999/sync-club", {});
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "球队不存在" });
  });
});

// =====================================================================================
describe("增量 37：批量建队 POST /api/admin/teams/bulk", () => {
  it("每行「游戏球队 ID 队名」：显式 id 落库并逐支推送", async () => {
    const { env, sqlite } = freshEnv();
    const res = await post(env, "/api/admin/teams/bulk", { lines: ["700 Arsenal", "701 Chelsea"] });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ created: 2, skipped: [], clubSyncFailed: [] });
    expect(sqlAll<{ id: number }>(sqlite, "SELECT id FROM team ORDER BY id").map((r) => r.id)).toEqual([700, 701]);
    expect(pushed().map((c) => c.body!.id).sort()).toEqual([700, 701]);
  });

  it("批内重复与格式错都进 skipped 明细，不影响同批其它行", async () => {
    const { env, sqlite } = freshEnv();
    const res = await post(env, "/api/admin/teams/bulk", {
      lines: ["700 Arsenal", "700 Arsenal", "701 Arsenal", "乱写的一行", "702 Chelsea"],
    });
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.created).toBe(2);
    // 同一行同时撞 ID 与队名时只报 ID（ID 先判）——要分别命中两条分支得用不同 ID 同名
    expect(j.skipped).toEqual([
      { line: 2, reason: "本批内 ID #700 重复" },
      { line: 3, reason: "本批内队名「Arsenal」重复" },
      { line: 4, reason: "格式应为「游戏球队 ID 队名」，如 1 Arsenal" },
    ]);
    expect(sqlAll(sqlite, "SELECT id FROM team")).toHaveLength(2);
  });

  it("库里已占用的 ID / 队名进 skipped，其余照建", async () => {
    const { env, sqlite } = freshEnv();
    seedTeam(sqlite, 700, "已有的队");
    seedTeam(sqlite, 702, "Chelsea");
    const res = await post(env, "/api/admin/teams/bulk", { lines: ["700 别的名", "701 Arsenal", "703 Chelsea"] });
    const j = await res.json();
    expect(j.created).toBe(1);
    expect(j.skipped).toEqual([
      { line: 1, reason: "球队 ID #700 已被占用" },
      { line: 3, reason: "队名「Chelsea」已存在" },
    ]);
    expect(sqlGet(sqlite, "SELECT id FROM team WHERE id = ?", 701)).toBeDefined();
  });

  it("空行 / 超 64 行 → 400", async () => {
    const { env } = freshEnv();
    expect((await post(env, "/api/admin/teams/bulk", { lines: ["   ", ""] })).status).toBe(400);
    const many = Array.from({ length: BULK_MAX + 1 }, (_, i) => `${1000 + i} 队${i}`);
    const res = await post(env, "/api/admin/teams/bulk", { lines: many });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: `一次最多添加 ${BULK_MAX} 支球队` });
  });

  it("推送失败逐支回报 clubSyncFailed，队都已建好（不回滚）", async () => {
    const { env, sqlite } = freshEnv();
    clubReply = () => ({ status: 502, body: { message: "赛事系统拒绝" } });
    const res = await post(env, "/api/admin/teams/bulk", { lines: ["700 Arsenal", "701 Chelsea"] });
    const j = await res.json();
    expect(j.created).toBe(2);
    expect(j.clubSyncFailed).toEqual([
      { id: 700, message: "赛事系统拒绝" },
      { id: 701, message: "赛事系统拒绝" },
    ]);
    expect(sqlAll(sqlite, "SELECT id FROM team")).toHaveLength(2);
  });
});

// =====================================================================================
describe("增量 37：批量报名 POST /api/admin/tournaments/:id/entries/bulk", () => {
  it("行里的队库里没有 → 自动建队（显式 id）并报名，新队推给俱乐部平台", async () => {
    const { env, sqlite } = freshEnv();
    seedTournament(sqlite);
    const res = await post(env, "/api/admin/tournaments/1/entries/bulk", { lines: ["700 Arsenal", "701 Chelsea"] });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      createdEntries: 2,
      createdTeams: 2,
      skippedAlready: [],
      skipped: [],
      nameMismatch: [],
      clubSyncFailed: [],
    });
    expect(sqlAll<{ id: number }>(sqlite, "SELECT id FROM team ORDER BY id").map((r) => r.id)).toEqual([700, 701]);
    expect(sqlAll<{ team_id: number }>(sqlite, "SELECT team_id FROM entry ORDER BY team_id").map((r) => r.team_id)).toEqual([700, 701]);
    expect(pushed().map((c) => c.body!.id).sort()).toEqual([700, 701]);
  });

  it("队按 ID 认：库里已有这支队时名字以库里为准，行里的名字只回报 nameMismatch", async () => {
    const { env, sqlite } = freshEnv();
    seedTournament(sqlite);
    seedTeam(sqlite, 700, "库里名");
    const res = await post(env, "/api/admin/tournaments/1/entries/bulk", { lines: ["700 行里名"] });
    const j = await res.json();
    expect(j.createdTeams).toBe(0);
    expect(j.createdEntries).toBe(1);
    expect(j.nameMismatch).toEqual([{ id: 700, name: "库里名", input: "行里名" }]);
    expect(sqlGet<{ name: string }>(sqlite, "SELECT name FROM team WHERE id = ?", 700)!.name).toBe("库里名");
    expect(pushed()).toHaveLength(0); // 已存在的队不重推
  });

  it("已在赛事中的队进 skippedAlready，不重复报名", async () => {
    const { env, sqlite } = freshEnv();
    seedTournament(sqlite);
    seedTeam(sqlite, 700, "Arsenal");
    sqlite.prepare("INSERT INTO entry (tournament_id, team_id, seed) VALUES (1, 700, 1)").run();
    const res = await post(env, "/api/admin/tournaments/1/entries/bulk", { lines: ["700 Arsenal", "701 Chelsea"] });
    const j = await res.json();
    expect(j.skippedAlready).toEqual([700]);
    expect(j.createdEntries).toBe(1);
    expect(j.createdTeams).toBe(1);
  });

  it("待建队名已被另一支队占用 → 该行跳过，同批其它行照常建队报名（不整批失败）", async () => {
    const { env, sqlite } = freshEnv();
    seedTournament(sqlite);
    seedTeam(sqlite, 800, "Arsenal");
    const res = await post(env, "/api/admin/tournaments/1/entries/bulk", { lines: ["700 Arsenal", "701 Chelsea"] });
    const j = await res.json();
    expect(j.skipped).toEqual([{ line: 1, reason: "队名「Arsenal」已属于另一支球队" }]);
    expect(j.createdTeams).toBe(1);
    expect(j.createdEntries).toBe(1);
    expect(sqlGet(sqlite, "SELECT id FROM team WHERE id = ?", 700)).toBeUndefined();
    expect(sqlGet(sqlite, "SELECT id FROM team WHERE id = ?", 701)).toBeDefined();
    expect(sqlAll<{ team_id: number }>(sqlite, "SELECT team_id FROM entry").map((r) => r.team_id)).toEqual([701]);
  });

  it("推送失败逐支回报，队与报名都已落地", async () => {
    const { env, sqlite } = freshEnv();
    seedTournament(sqlite);
    clubReply = () => ({ status: 500, body: {} });
    const res = await post(env, "/api/admin/tournaments/1/entries/bulk", { lines: ["700 Arsenal"] });
    const j = await res.json();
    expect(j.createdEntries).toBe(1);
    expect(j.createdTeams).toBe(1);
    expect(j.clubSyncFailed).toEqual([{ id: 700, message: "俱乐部平台拒绝同步（HTTP 500）" }]);
    expect(sqlAll(sqlite, "SELECT id FROM entry")).toHaveLength(1);
  });

  it("赛事不存在 404 / 开赛后 409 / 空行与超 64 行 400", async () => {
    const { env, sqlite } = freshEnv();
    const missing = await post(env, "/api/admin/tournaments/999/entries/bulk", { lines: ["700 Arsenal"] });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "赛事不存在" });

    seedTournament(sqlite, "running", 2);
    const started = await post(env, "/api/admin/tournaments/2/entries/bulk", { lines: ["700 Arsenal"] });
    expect(started.status).toBe(409);
    expect(await started.json()).toEqual({ message: "开赛后不能改动报名名单" });

    seedTournament(sqlite, "registering", 3);
    expect((await post(env, "/api/admin/tournaments/3/entries/bulk", { lines: [] })).status).toBe(400);
    const many = Array.from({ length: BULK_MAX + 1 }, (_, i) => `${1000 + i} 队${i}`);
    expect((await post(env, "/api/admin/tournaments/3/entries/bulk", { lines: many })).status).toBe(400);
  });
});

// =====================================================================================
describe("增量 37：行解析 parseBulkLine（建队与批量报名共用）", () => {
  it("接受空格 / tab / 中英文逗号分隔，队名保留内部空格", () => {
    expect(parseBulkLine("1 Arsenal")).toEqual({ id: 1, name: "Arsenal" });
    expect(parseBulkLine("1\tArsenal")).toEqual({ id: 1, name: "Arsenal" });
    expect(parseBulkLine("1,Arsenal")).toEqual({ id: 1, name: "Arsenal" });
    expect(parseBulkLine("1，Arsenal")).toEqual({ id: 1, name: "Arsenal" });
    expect(parseBulkLine("132681 United Tigers SC")).toEqual({ id: 132681, name: "United Tigers SC" });
  });

  it("拒绝：没有 ID、没有分隔符、ID 为 0、队名超 40 字", () => {
    expect(parseBulkLine("Arsenal")).toEqual({ error: "格式应为「游戏球队 ID 队名」，如 1 Arsenal" });
    expect(parseBulkLine("700Arsenal")).toEqual({ error: "格式应为「游戏球队 ID 队名」，如 1 Arsenal" });
    expect(parseBulkLine("0 Arsenal")).toEqual({ error: "游戏球队 ID 应为正整数" });
    expect(parseBulkLine(`1 ${"あ".repeat(41)}`)).toEqual({ error: `队名不超过 ${NAME_MAX} 字` });
  });
});

// =====================================================================================
// 跨仓签名契约金标准。与俱乐部仓 tests/team-sync.test.ts 的同一节**逐字同值**：
// 同样的 secret / ts / raw，同样的十六进制常量。这个常量是独立算出来的死值
// （node:crypto，输入见下），不是用被测代码算的——所以两侧任何一方偷改算法、路径或
// 签名串，这一节都会红；而如果两侧同时改，两份文件里的死值就对不上仓里的实现。
describe("增量 37：跨仓签名契约金标准（与 club 仓逐字同值）", () => {
  const GOLDEN_SECRET = "increment-37-golden-secret";
  const GOLDEN_TS = 1767225600; // 2026-01-01T00:00:00Z
  const GOLDEN_RAW = '{"id":700,"name":"Arsenal","operator":1}';
  const GOLDEN_HEX = "1437a305e893ae6c65364c50cc953a178e1edfa38f2f2040ae961966db065d30";

  it("路径与时间窗、队名上限三个常量逐字（两侧不同值就会出现「本仓建得下、推过去被拒」）", () => {
    expect(TEAM_UPSERT_PATH).toBe("/api/internal/team-upsert");
    expect(NAME_MAX).toBe(40);
    expect(BULK_MAX).toBe(64);
  });

  it("HMAC 金标准：hex(HMAC-SHA256(secret, \"POST|/api/internal/team-upsert|1767225600|{...}\"))", async () => {
    expect(await hmacHex(GOLDEN_SECRET, `POST|${TEAM_UPSERT_PATH}|${GOLDEN_TS}|${GOLDEN_RAW}`)).toBe(GOLDEN_HEX);
    // 同一份输入的另一种算法实现必须同值（crypto.subtle vs node:crypto）
    expect(
      createHmac("sha256", GOLDEN_SECRET).update(`POST|${TEAM_UPSERT_PATH}|${GOLDEN_TS}|${GOLDEN_RAW}`).digest("hex"),
    ).toBe(GOLDEN_HEX);
  });

  it("出站请求头与体形状：X-Timestamp 秒级、X-Sign 命中该金标准值", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(GOLDEN_TS * 1000));
    try {
      await pushTeamToClub({ CLUB_API_BASE: CLUB_BASE, TEAM_SYNC_SECRET: GOLDEN_SECRET } as never, {
        id: 700,
        name: "Arsenal",
        operator: 1,
      });
    } finally {
      vi.useRealTimers();
    }
    const cap = pushed()[0];
    expect(cap.raw).toBe(GOLDEN_RAW);
    expect(cap.headers["x-timestamp"]).toBe(String(GOLDEN_TS));
    expect(cap.headers["x-sign"]).toBe(GOLDEN_HEX);
  });

  it("入站接受同一份金标准签名（常量在两仓之间可直接互通）", async () => {
    const { env, sqlite } = freshEnv();
    env.TEAM_SYNC_SECRET = GOLDEN_SECRET;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(GOLDEN_TS * 1000));
    try {
      const res = await app.request(
        TEAM_UPSERT_PATH,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-timestamp": String(GOLDEN_TS), "x-sign": GOLDEN_HEX },
          body: GOLDEN_RAW,
        },
        env,
      );
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ ok: true, created: true, authLinked: true });
      expect(sqlGet<{ name: string }>(sqlite, "SELECT name FROM team WHERE id = ?", 700)).toEqual({ name: "Arsenal" });
    } finally {
      vi.useRealTimers();
    }
  });
});
