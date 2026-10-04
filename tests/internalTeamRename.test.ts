// v5.2.0：球队改名机器端点 POST /api/internal/team-rename 测试。
//
// 覆盖四块：
//   ① 签名金标准——与俱乐部平台的代调端共用同一组死值（secret / ts / raw / hex 逐字相同），
//      本仓的 hmacHex 与独立算的 node:crypto 必须落在同一个 hex 上，端点也必须认这组头；
//      路径是签名串的一部分：拿 team-upsert 的路径签出来的名字，team-rename 必须拒收；
//   ② 正常改名——落库 + 审计留痕（actor 留 NULL、target_type='team'、记下原名新名）；
//   ③ 幂等——重推同名回 200 renamed:false，不写库也不留审计；
//   ④ 拒绝矩阵——错签/过期/缺头/未配密钥/坏 JSON/坏 id/坏 name/撞名/不存在。
//
// 机器通道一律不带 Cookie：验签放行靠签名，不靠会话。
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import app from "../worker/index";
import { applyMigrations, createTestD1, createTestKV, sqlAll, sqlGet } from "./d1";
import { TEAM_RENAME_PATH, TEAM_UPSERT_PATH, hmacHex } from "../worker/lib/clubSync";

// 与俱乐部平台代调端共用的一组金标准常量（两侧各算一遍，谁偷偷改口径谁红）
const SECRET = "increment-37-golden-secret";
const GOLDEN_TS = 1767225600; // 2026-01-01T00:00:00Z
const GOLDEN_RAW = '{"id":700,"name":"Arsenal"}';
const GOLDEN_MSG = `POST|${TEAM_RENAME_PATH}|${GOLDEN_TS}|${GOLDEN_RAW}`;
const GOLDEN_HEX = "d6dadafa1c903870a8b19747c094e6ace3a52beb402e7ded8530e10458305cba";

const nowSec = () => Math.floor(Date.now() / 1000);

function freshEnv(opts: { secret?: boolean } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  // 机器端点不走会话：KV 空着即可（中间件对 /api/internal/ 是放行的）
  const env: Record<string, unknown> = {
    DB: createTestD1(sqlite),
    KV: createTestKV() as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
    ...(opts.secret !== false ? { TEAM_SYNC_SECRET: SECRET } : {}),
  };
  return { env, sqlite };
}

function seedTeam(sqlite: DatabaseSync, id: number, name: string) {
  // created_by 留空：机器建档没有本仓用户身份，team.created_by 本就是可空外键
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_by) VALUES (?, 1, ?, NULL)").run(id, name);
}

/** 按入站契约直接发请求；默认不带 Cookie——机器通道必须靠验签放行 */
function inbound(
  env: Record<string, unknown>,
  body: unknown,
  opts: {
    secret?: string;
    ts?: number;
    sign?: string;
    path?: string;
    omitSign?: boolean;
    omitTs?: boolean;
    raw?: string;
  } = {},
) {
  const raw = opts.raw ?? JSON.stringify(body);
  const ts = opts.ts ?? nowSec();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!opts.omitTs) headers["x-timestamp"] = String(ts);
  if (!opts.omitSign) {
    headers["x-sign"] =
      opts.sign ??
      createHmac("sha256", opts.secret ?? SECRET)
        .update(`POST|${opts.path ?? TEAM_RENAME_PATH}|${ts}|${raw}`)
        .digest("hex");
  }
  return app.request(TEAM_RENAME_PATH, { method: "POST", headers, body: raw }, env);
}

const auditRows = (sqlite: DatabaseSync) => sqlAll(sqlite, "SELECT * FROM audit_log ORDER BY id");

afterEach(() => {
  vi.useRealTimers();
});

describe("v5.2.0：入站机器端点 POST /api/internal/team-rename", () => {
  it("金标准：本仓 hex 与 node:crypto 同值，端点认这组头；换条路径签的名拒收", async () => {
    expect(TEAM_RENAME_PATH).toBe("/api/internal/team-rename");
    // 本仓实现走 crypto.subtle，这里再用 node:crypto 独立算一遍——两边都必须等于死值
    expect(await hmacHex(SECRET, GOLDEN_MSG)).toBe(GOLDEN_HEX);
    expect(createHmac("sha256", SECRET).update(GOLDEN_MSG).digest("hex")).toBe(GOLDEN_HEX);

    const { env, sqlite } = freshEnv();
    seedTeam(sqlite, 700, "旧队名");
    vi.useFakeTimers();
    vi.setSystemTime(GOLDEN_TS * 1000);
    try {
      // 路径参与签名串：同体、同时间戳，用 team-upsert 的路径签出来必须被拒
      const cross = await inbound(
        env,
        { id: 700, name: "Arsenal" },
        { ts: GOLDEN_TS, secret: SECRET, path: TEAM_UPSERT_PATH },
      );
      expect(cross.status).toBe(403);

      const res = await inbound(env, { id: 700, name: "Arsenal" }, { ts: GOLDEN_TS, sign: GOLDEN_HEX });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, renamed: true, id: 700, name: "Arsenal" });
    } finally {
      vi.useRealTimers();
    }
    expect(sqlGet<{ name: string }>(sqlite, "SELECT name FROM team WHERE id = ?", 700)?.name).toBe("Arsenal");
  });

  it("改名成功：team.name 落库，审计记 team_rename（actor 留 NULL，detail 带原名新名）", async () => {
    const { env, sqlite } = freshEnv();
    seedTeam(sqlite, 700, "旧队名");

    const res = await inbound(env, { id: 700, name: "阿森纳" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, renamed: true, id: 700, name: "阿森纳" });

    expect(sqlGet<{ name: string }>(sqlite, "SELECT name FROM team WHERE id = ?", 700)?.name).toBe("阿森纳");
    expect(auditRows(sqlite)).toEqual([
      {
        id: 1,
        actor_user_id: null,
        action: "team_rename",
        target_type: "team",
        target_id: 700,
        detail_json: JSON.stringify({ from: "旧队名", to: "阿森纳" }),
        created_at: expect.any(String),
      },
    ]);
  });

  it("队名两侧空白先裁后落库（与建档口径一致）", async () => {
    const { env, sqlite } = freshEnv();
    seedTeam(sqlite, 700, "旧队名");

    const res = await inbound(env, { id: 700, name: "  阿森纳  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, renamed: true, id: 700, name: "阿森纳" });
    expect(sqlGet<{ name: string }>(sqlite, "SELECT name FROM team WHERE id = ?", 700)?.name).toBe("阿森纳");
  });

  it("幂等：重推同名回 renamed:false，不写库也不留审计", async () => {
    const { env, sqlite } = freshEnv();
    seedTeam(sqlite, 700, "阿森纳");

    const res = await inbound(env, { id: 700, name: "阿森纳" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, renamed: false, id: 700, name: "阿森纳" });

    expect(sqlGet<{ name: string }>(sqlite, "SELECT name FROM team WHERE id = ?", 700)?.name).toBe("阿森纳");
    expect(auditRows(sqlite)).toEqual([]);
  });

  it("撞名：改成别队占着的名字回 409 并指名占用者，库里不动", async () => {
    const { env, sqlite } = freshEnv();
    seedTeam(sqlite, 700, "A队");
    seedTeam(sqlite, 701, "B队");

    const res = await inbound(env, { id: 700, name: "B队" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict", message: "队名「B队」已被球队 #701 占用" });
    expect(sqlGet<{ name: string }>(sqlite, "SELECT name FROM team WHERE id = ?", 700)?.name).toBe("A队");
    expect(auditRows(sqlite)).toEqual([]);
  });

  it("404：球队不存在", async () => {
    const { env } = freshEnv();
    const res = await inbound(env, { id: 999, name: "阿森纳" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", message: "球队 #999 不存在" });
  });

  it("验签矩阵：错签/过期/缺头一律 403，未配密钥回 503", async () => {
    const { env, sqlite } = freshEnv();
    seedTeam(sqlite, 700, "旧队名");

    // 错签：格式合法但内容不对
    const bad = await inbound(env, { id: 700, name: "阿森纳" }, { sign: "0".repeat(64) });
    expect(bad.status).toBe(403);
    expect(await bad.json()).toEqual({ error: "bad_signature", message: "签名校验失败" });

    // 过期：签名本身有效，但 ts 偏离当前时刻 301s（超过 ±300s 铁窗）
    const stale = await inbound(env, { id: 700, name: "阿森纳" }, { ts: nowSec() - 301 });
    expect(stale.status).toBe(403);

    // 缺 x-sign / 缺 x-timestamp
    expect((await inbound(env, { id: 700, name: "阿森纳" }, { omitSign: true })).status).toBe(403);
    expect((await inbound(env, { id: 700, name: "阿森纳" }, { omitTs: true })).status).toBe(403);

    // 全都拒了：库里没动
    expect(sqlGet<{ name: string }>(sqlite, "SELECT name FROM team WHERE id = ?", 700)?.name).toBe("旧队名");

    // 未配密钥：fail-closed，503 而不是 403
    const bare = freshEnv({ secret: false });
    seedTeam(bare.sqlite, 700, "旧队名");
    const res = await inbound(bare.env, { id: 700, name: "阿森纳" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "unconfigured",
      message: "本仓未配置 TEAM_SYNC_SECRET，拒绝机器写入",
    });
  });

  it("坏请求体：非 JSON 400；id 非正整数、name 非法 400；40 字边界放行", async () => {
    const { env, sqlite } = freshEnv();
    seedTeam(sqlite, 700, "旧队名");

    const badJson = await inbound(env, null, { raw: "not-json" });
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toEqual({ error: "bad_json", message: "请求体不是合法 JSON" });

    for (const body of [
      { id: 0, name: "阿森纳" },
      { id: -1, name: "阿森纳" },
      { id: 1.5, name: "阿森纳" },
      { id: "abc", name: "阿森纳" },
      { name: "阿森纳" },
      { id: 700, name: "" },
      { id: 700, name: "   " },
      { id: 700, name: 123 },
      { id: 700, name: "x".repeat(41) },
    ]) {
      const res = await inbound(env, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toMatchObject({ error: "bad_request" });
    }

    // 边界：40 字正好放行（NAME_MAX 与 club 的 clubs.name 上限一致）
    const max = await inbound(env, { id: 700, name: "x".repeat(40) });
    expect(max.status).toBe(200);
    expect(await max.json()).toEqual({ ok: true, renamed: true, id: 700, name: "x".repeat(40) });
    expect(sqlGet<{ name: string }>(sqlite, "SELECT name FROM team WHERE id = ?", 700)?.name).toBe("x".repeat(40));
  });
});
