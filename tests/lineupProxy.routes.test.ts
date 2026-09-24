// 阵容代打路由测试（migration 0023）：兼容模式会话驱动真实 app，AUTH_DB 手建两份绑定。
// 钉死四件事：代打提交落的是目标队的阵容并留痕（viaProxy / proxy_grant_id / 审计）、
// 被代打队教练在授权有效期内让位且撤销即恢复、开赛即自然失效、代打板取的是目标队的
// 名单与停赛口径（不是代打者本队的）。另含管理端授权 CRUD 与 /me/matches 的 proxyGranted。
import { beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { hashPassword } from "../worker/lib/crypto";
import { FORMS } from "../shared/tactics";
import { applyMigrations, createTestD1, createTestKV } from "./d1";

let userHash = "";

// 认证中心极简镜像：account / team / team_binding 三张表就够 boundAccounts 与 boundTeamId 跑
function authMirror(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    `CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
     CREATE TABLE team (id INTEGER PRIMARY KEY, name TEXT NOT NULL, tour_team_id INTEGER, created_at TEXT NOT NULL);
     CREATE TABLE team_binding (account_id INTEGER NOT NULL, team_id INTEGER NOT NULL, bound_via TEXT NOT NULL, bound_at TEXT NOT NULL, PRIMARY KEY (account_id, team_id));`,
  );
  const iso = "2026-01-01T00:00:00Z";
  const acc = sqlite.prepare("INSERT INTO account (id, name, created_at) VALUES (?, ?, ?)");
  acc.run(1, "教练甲", iso);
  acc.run(2, "教练乙", iso);
  acc.run(3, "管理员", iso);
  const tm = sqlite.prepare("INSERT INTO team (id, name, tour_team_id, created_at) VALUES (?, ?, ?, ?)");
  tm.run(1, "红队", 10, iso);
  tm.run(2, "蓝队", 11, iso);
  const bind = sqlite.prepare("INSERT INTO team_binding (account_id, team_id, bound_via, bound_at) VALUES (?, ?, 'tour', ?)");
  bind.run(1, 1, iso); // 教练甲 → 红队（tour team 10）
  bind.run(2, 2, iso); // 教练乙 → 蓝队（tour team 11）
  return createTestD1(sqlite);
}

// 一场待开的红蓝对（802）、一场已完赛（800，用来给红队造一张红牌）；
// 教练甲绑红队、教练乙绑蓝队、管理员不绑队
function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const u = sqlite.prepare(
    "INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, '', ?, ?, 0, 0)",
  );
  u.run(1, "教练甲", userHash, "coach");
  u.run(2, "教练乙", userHash, "coach");
  u.run(3, "管理员", userHash, "admin");
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (10, 1, '红队', '2026-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (11, 1, '蓝队', '2026-01-01T00:00:00Z')").run();
  const p = sqlite.prepare("INSERT INTO player (id, team_id, name) VALUES (?, ?, ?)");
  const red = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
  const blue = [200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210];
  red.forEach((id, i) => p.run(id, 10, `红${i + 1}`));
  blue.forEach((id, i) => p.run(id, 11, `蓝${i + 1}`));
  sqlite
    .prepare("INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (7, 1, '联赛', 'round_robin', 'running', 1, '2026-01-01T00:00:00Z')")
    .run();
  sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (70, 7, 'round_robin', 1)").run();
  const e = sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (?, 7, ?, ?)");
  e.run(500, 10, 1);
  e.run(501, 11, 2);
  const m = sqlite.prepare(
    "INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status, finished_at) VALUES (?, 70, ?, 1, 500, 501, ?, ?)",
  );
  m.run(800, 1, "finished", "2026-01-10T10:00:00Z");
  m.run(801, 2, "finished", "2026-01-17T10:00:00Z");
  m.run(802, 3, "pending", null);
  m.run(803, 4, "pending", null);
  // 红队 100 在已完赛那场直红 → 联赛内停 2 场（第 2 轮已消耗 1 → 剩 1）
  sqlite
    .prepare("INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, created_by) VALUES (900, 800, 500, 100, 'red', 20, 1)")
    .run();

  const kv = new Map<string, string>([
    ["sess:tok-a", JSON.stringify({ userId: 1 })],
    ["sess:tok-b", JSON.stringify({ userId: 2 })],
    ["sess:tok-admin", JSON.stringify({ userId: 3 })],
  ]);
  const env: Record<string, unknown> = {
    DB: createTestD1(sqlite),
    AUTH_DB: authMirror(),
    KV: createTestKV(kv) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
  };
  return { env, sqlite };
}

type Env = Record<string, unknown>;
const COOKIE: Record<string, string> = { a: "tok-a", b: "tok-b", admin: "tok-admin" };

function req(env: Env, who: "a" | "b" | "admin", path: string, init: RequestInit = {}) {
  return app.request(
    path,
    { ...init, headers: { Cookie: `whl_session=${COOKIE[who]}`, ...(init.headers ?? {}) } },
    env,
  );
}
const json = (env: Env, who: "a" | "b" | "admin", path: string, body: unknown, method = "POST") =>
  req(env, who, path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const FORM = "433";
// 合法首发：按阵型位序配该队 11 人
function slots(team: 10 | 11) {
  const def = FORMS.find((f) => f.value === FORM);
  if (!def) throw new Error(`阵型 ${FORM} 不存在，测试数据要跟着改`);
  const pids = team === 10 ? [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110] : [200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210];
  return def.pos.map((p, i) => ({ lid: p.lid, position: p.position, player_id: pids[i] }));
}

const grant = (env: Env, matchId: number, teamId: number, granteeUserId: number) =>
  json(env, "admin", "/api/admin/proxy-grants", { matchId, teamId, granteeUserId });

// 管理员把红队(10)本场阵容的提交权授给教练乙(2)
async function grantRedToB(env: Env, matchId = 802) {
  const res = await grant(env, matchId, 10, 2);
  expect(res.status).toBe(200);
  return ((await res.json()) as { grantId: number }).grantId;
}

beforeAll(async () => {
  userHash = await hashPassword("TestPass123");
});

describe("管理端代打授权", () => {
  it("建授权落库并出现在清单里；候选账号含两支队的教练与管理员的角色口径", async () => {
    const { env } = freshEnv();
    expect(((await (await req(env, "admin", "/api/admin/proxy-grants")).json()) as { grants: unknown[] }).grants).toEqual([]);

    const id = await grantRedToB(env);
    const b = (await (await req(env, "admin", "/api/admin/proxy-grants")).json()) as {
      grants: {
        id: number;
        matchId: number;
        teamId: number;
        teamName: string;
        opponentName: string | null;
        side: string;
        granteeUserId: number;
        granteeName: string | null;
        granteeTeamName: string | null;
        grantedByName: string | null;
        active: boolean;
        submitted: boolean;
      }[];
    };
    expect(b.grants.length).toBe(1);
    expect(b.grants[0]).toMatchObject({
      id,
      matchId: 802,
      teamId: 10,
      teamName: "红队",
      opponentName: "蓝队",
      side: "home",
      granteeUserId: 2,
      granteeName: "教练乙",
      granteeTeamName: "蓝队",
      grantedByName: "管理员",
      active: true,
      submitted: false,
    });

    const ctx = (await (await req(env, "admin", "/api/admin/proxy-grants/context")).json()) as {
      accounts: { userId: number; name: string; teamId: number | null; teamName: string | null }[];
    };
    // 姓名来自 auth 库（本库 user 表 JOIN 会漏人）；未绑队的管理员排在最后（teamId null）
    expect(ctx.accounts).toEqual([
      { userId: 1, name: "教练甲", teamId: 10, teamName: "红队" },
      { userId: 2, name: "教练乙", teamId: 11, teamName: "蓝队" },
      { userId: 3, name: "管理员", teamId: null, teamName: null },
    ]);
  });

  it("选完比赛取两队 id 与已有授权（比赛列表 DTO 里没有 team id）", async () => {
    const { env } = freshEnv();
    const b = (await (await req(env, "admin", "/api/admin/proxy-grants/match/802")).json()) as {
      matchId: number;
      status: string;
      homeTeamId: number;
      homeTeamName: string;
      awayTeamId: number;
      awayTeamName: string;
      tournamentName: string;
      grants: unknown[];
    };
    expect(b).toMatchObject({
      matchId: 802,
      status: "pending",
      homeTeamId: 10,
      homeTeamName: "红队",
      awayTeamId: 11,
      awayTeamName: "蓝队",
      tournamentName: "联赛",
      grants: [],
    });
  });

  it("拒掉的三种情况：授给本队教练自己 400、球队不在本场 400、账号不存在 400、比赛不存在 404", async () => {
    const { env } = freshEnv();
    // 教练甲本来就绑红队，授权去代打红队只会把他自己锁在门外
    let res = await grant(env, 802, 10, 1);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe("该账号本来就绑这支球队，不需要代打授权");

    res = await grant(env, 802, 99, 2);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe("该球队不在本场比赛中");

    res = await grant(env, 802, 10, 999);
    expect(res.status).toBe(400);
    res = await grant(env, 999, 10, 2);
    expect(res.status).toBe(404);
  });

  it("开打的比赛不能再授权（开打即失效，所以不需要 expires_at）", async () => {
    const { env, sqlite } = freshEnv();
    sqlite.prepare("UPDATE match SET status = 'live' WHERE id = 802").run();
    const res = await grant(env, 802, 10, 2);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toBe("比赛已开打，不能再授权代打");
  });

  it("撤销后 active 变 false 并留在清单里（留痕）；重复撤销 404", async () => {
    const { env } = freshEnv();
    const id = await grantRedToB(env);
    const del = await req(env, "admin", `/api/admin/proxy-grants/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const b = (await (await req(env, "admin", "/api/admin/proxy-grants")).json()) as {
      grants: { active: boolean; revokedAt: string | null }[];
    };
    expect(b.grants.length).toBe(1);
    expect(b.grants[0].active).toBe(false);
    expect(typeof b.grants[0].revokedAt).toBe("string");

    expect((await req(env, "admin", `/api/admin/proxy-grants/${id}`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("教练端代打", () => {
  it("代打者能交目标队阵容：落的是目标队那份，标 viaProxy，提交人是代打者，审计成对", async () => {
    const { env, sqlite } = freshEnv();
    const id = await grantRedToB(env);

    const sess = (await (await req(env, "b", "/api/coach/proxy/sessions")).json()) as {
      sessions: {
        matchId: number;
        teamId: number;
        teamName: string;
        opponentName: string | null;
        side: string;
        tournamentName: string;
        round: number;
        submitted: boolean;
        grantedByName: string | null;
      }[];
    };
    expect(sess.sessions.length).toBe(1);
    expect(sess.sessions[0]).toMatchObject({
      matchId: 802,
      teamId: 10,
      teamName: "红队",
      opponentName: "蓝队",
      side: "home",
      tournamentName: "联赛",
      round: 3,
      submitted: false,
      grantedByName: "管理员",
    });
    // 没被授权的教练甲看不到任何代打会话
    expect(((await (await req(env, "a", "/api/coach/proxy/sessions")).json()) as { sessions: unknown[] }).sessions).toEqual([]);

    const res = await json(env, "b", "/api/coach/proxy/802/lineup", { form: FORM, slots: slots(10), code: "ABC" }, "PUT");
    expect(res.status).toBe(200);

    // 管理端能同时看到两份：红队那份是代打交的，蓝队那份没人交
    const adm = (await (await req(env, "admin", "/api/admin/matches/802/lineup")).json()) as {
      home: { teamId: number; submittedBy: string | null; viaProxy: boolean; form: string } | null;
      away: unknown;
      homeCode: string;
    };
    expect(adm.away).toBeNull();
    expect(adm.home).toMatchObject({ teamId: 10, submittedBy: "教练乙", viaProxy: true, form: FORM });
    expect(adm.homeCode).toBe("ABC");

    // tactic_submission 落在 (match 802, team 10)，带 grant 留痕；审计两条都是 match 域
    const sub = sqlite
      .prepare("SELECT created_by, proxy_grant_id FROM tactic_submission WHERE match_id = 802 AND team_id = 10")
      .get() as { created_by: number; proxy_grant_id: number | null };
    expect(sub.created_by).toBe(2);
    expect(sub.proxy_grant_id).toBe(id);
    const audits = sqlite
      .prepare("SELECT action, target_type, target_id FROM audit_log ORDER BY id")
      .all() as { action: string; target_type: string; target_id: number }[];
    expect(audits).toEqual([
      { action: "lineup_proxy_grant", target_type: "match", target_id: 802 },
      { action: "lineup_proxy_submit", target_type: "match", target_id: 802 },
    ]);
  });

  it("被代打队教练让位：授权期间提交 403，撤销后立刻恢复", async () => {
    const { env } = freshEnv();
    const id = await grantRedToB(env);

    const blocked = await json(env, "a", "/api/coach/matches/802/lineup", { form: FORM, slots: slots(10) }, "PUT");
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { message: string }).message).toBe("本场阵容已授权他人代打，你暂不能提交");
    // 本队教练的另一条路也得拦（代打语义是「让位」，不是「再加一条写入口」）
    expect(
      ((await (await req(env, "a", "/api/coach/matches/802/lineup")).json()) as { lineup: unknown }).lineup,
    ).toBeNull();

    await req(env, "admin", `/api/admin/proxy-grants/${id}`, { method: "DELETE" });
    const ok = await json(env, "a", "/api/coach/matches/802/lineup", { form: FORM, slots: slots(10) }, "PUT");
    expect(ok.status).toBe(200);
  });

  it("开打即自然失效：会话消失、代打提交 403、本队教练回到既有 409 口径、清单标 active=false", async () => {
    const { env, sqlite } = freshEnv();
    await grantRedToB(env);
    sqlite.prepare("UPDATE match SET status = 'live' WHERE id = 802").run();

    expect(((await (await req(env, "b", "/api/coach/proxy/sessions")).json()) as { sessions: unknown[] }).sessions).toEqual([]);
    expect(
      (await json(env, "b", "/api/coach/proxy/802/lineup", { form: FORM, slots: slots(10) }, "PUT")).status,
    ).toBe(403);
    // 本队教练不再被代打闸拦，但回到「已开打」的既有 409：开赛后谁都交不了
    expect((await json(env, "a", "/api/coach/matches/802/lineup", { form: FORM, slots: slots(10) }, "PUT")).status).toBe(409);
    const b = (await (await req(env, "admin", "/api/admin/proxy-grants")).json()) as { grants: { active: boolean }[] };
    expect(b.grants[0].active).toBe(false);
  });

  it("代打板给的是目标队的名单与停赛口径（不是代打者本队蓝队的）", async () => {
    const { env } = freshEnv();
    await grantRedToB(env);

    const b = (await (await req(env, "b", "/api/coach/proxy/802/board")).json()) as {
      session: { teamId: number; tournamentId: number };
      players: { id: number; name: string }[];
      status: { tournamentId: number; yellowThreshold: number; tournaments: { tournamentId: number }[]; players: { playerId: number; remaining: number }[] };
      lineup: unknown;
    };
    expect(b.session).toMatchObject({ teamId: 10, tournamentId: 7 });
    expect(b.players.map((p) => p.id)).toEqual(slots(10).map((s) => s.player_id));
    expect(b.players[0].name).toBe("红1");
    // 停赛按目标队（红队 100 直红停 2 剩 1）算；蓝队一人无牌，故这行数据本身就是判据
    expect(b.status.tournamentId).toBe(7);
    expect(b.status.tournaments.map((t) => t.tournamentId)).toEqual([7]);
    expect(b.status.players.map((p) => [p.playerId, p.remaining])).toEqual([[100, 1]]);
    expect(b.lineup).toBeNull();

    // 没授权 / 没绑队：一律 403，且不泄露这场存不存在
    expect((await req(env, "a", "/api/coach/proxy/802/board")).status).toBe(403);
    // 授权只覆盖 802：同两队的 803 用不了
    expect((await json(env, "b", "/api/coach/proxy/803/lineup", { form: FORM, slots: slots(10) }, "PUT")).status).toBe(403);
    expect((await req(env, "b", "/api/coach/proxy/803/board")).status).toBe(403);
  });

  it("代打者交不属于目标队的球员：400（归属按目标队判，不按代打者本队）", async () => {
    const { env } = freshEnv();
    await grantRedToB(env);
    const res = await json(env, "b", "/api/coach/proxy/802/lineup", { form: FORM, slots: slots(11) }, "PUT");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe("名单里有不属于该球队的球员，请回战术板重选");
    // 目标队已有阵容时，代打者能覆盖（与教练本人行为一致，写入口仍是 UPSERT）
    await json(env, "b", "/api/coach/proxy/802/lineup", { form: FORM, slots: slots(10) }, "PUT");
    const again = await json(env, "b", "/api/coach/proxy/802/lineup", { form: FORM, slots: slots(10), code: "X" }, "PUT");
    expect(again.status).toBe(200);
  });

  it("/me/matches 把已授权代打的场次标出来（本队教练据此知道为何提交被拒）", async () => {
    const { env } = freshEnv();
    await grantRedToB(env, 802);
    const b = (await (await req(env, "a", "/api/coach/me/matches")).json()) as {
      matches: { id: number; proxyGranted: boolean; submitted: boolean }[];
    };
    // 排序口径同既有待开比赛列表（t.created_at DESC, sort_order, round, slot）：802 在 803 前
    expect(b.matches.map((m) => [m.id, m.proxyGranted])).toEqual([
      [802, true],
      [803, false],
    ]);
  });

  it("同一场同一队有多条未撤销授权时，/me/matches 仍然只回一条（授权台允许一场授多人）", async () => {
    const { env } = freshEnv();
    await grantRedToB(env, 802);
    // 授权台的账号候选只含有球队绑定的账号，所以第二条直接用 SQL 造：
    // 红队 802 这场同时授给教练乙和管理员，本队教练看到的仍应是一行
    await env.DB.prepare(
      "INSERT INTO lineup_proxy_grant (match_id, team_id, grantee_user_id, granted_by) VALUES (802, 10, 3, 3)",
    ).run();
    const b = (await (await req(env, "a", "/api/coach/me/matches")).json()) as {
      matches: { id: number; proxyGranted: boolean }[];
    };
    expect(b.matches.map((m) => [m.id, m.proxyGranted])).toEqual([
      [802, true],
      [803, false],
    ]);
  });

  it("/me/matches 覆盖客队一侧：蓝队教练看到同两场，side=away 且对手是红队", async () => {
    const { env } = freshEnv();
    // 上面几条都以红队教练（主队）身份请求，802/803 的 home_entry_id 都是红队 500；
    // 这里换蓝队教练（这两场都是客队）走同一段 SQL，确认 away 侧也命中、且主客名不串位。
    const b = (await (await req(env, "b", "/api/coach/me/matches")).json()) as {
      matches: { id: number; side: string; opponentName: string; homeTeamName?: string }[];
    };
    expect(b.matches.map((m) => [m.id, m.side, m.opponentName])).toEqual([
      [802, "away", "红队"],
      [803, "away", "红队"],
    ]);
  });
});
