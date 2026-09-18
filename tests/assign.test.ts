// 球员指派（FC26 Assignments）测试：纯规则 + 提交/代打/存档三条链路的落库与回读。
// 钉死六件事：18 项 5 组不多不少、互斥只在「角球主罚 ↔ 角球进攻接应」之间、
// 提交的指派随阵容落库并按 ASSIGN_GROUPS 顺序回读、指派里点非本队球员被 400、
// 代打提交按被代打队判归属、存档（草稿本）不做归属校验且 assign 能往返。
import { beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { hashPassword } from "../worker/lib/crypto";
import {
  ASSIGN_GROUPS,
  ASSIGN_KEYS,
  assignConflicts,
  conflictText,
  defaultPair,
  encodeFut26,
  FORMS,
  pairEa,
} from "../shared/tactics";
import { normalizeAssign, parseAssignJson } from "../worker/lib/lineup";
import { applyMigrations, createTestD1, createTestKV } from "./d1";

let userHash = "";

// 认证中心极简镜像：account / team / team_binding（同 lineupProxy 路由测试）
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
  bind.run(1, 1, iso);
  bind.run(2, 2, iso);
  return createTestD1(sqlite);
}

// 一场待开的红蓝对（802）。红队 12 人：100-110 是首发池，111 只在名单里（用来验 starter:false）
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
  const p = sqlite.prepare("INSERT INTO player (id, team_id, name, number) VALUES (?, ?, ?, ?)");
  const red = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111];
  const blue = [200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210];
  red.forEach((id, i) => p.run(id, 10, `红${i + 1}`, String(i + 1)));
  blue.forEach((id, i) => p.run(id, 11, `蓝${i + 1}`, String(i + 1)));
  sqlite
    .prepare("INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (7, 1, '联赛', 'round_robin', 'running', 1, '2026-01-01T00:00:00Z')")
    .run();
  sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (70, 7, 'round_robin', 1)").run();
  const e = sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (?, 7, ?, ?)");
  e.run(500, 10, 1);
  e.run(501, 11, 2);
  sqlite
    .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status) VALUES (802, 70, 3, 1, 500, 501, 'pending')")
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

function formDef() {
  const def = FORMS.find((f) => f.value === FORM);
  if (!def) throw new Error(`阵型 ${FORM} 不存在，测试数据要跟着改`);
  return def;
}

// 合法首发：按阵型位序配该队 11 人
function slots(team: 10 | 11) {
  const pids = team === 10 ? [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110] : [200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210];
  return formDef().pos.map((p, i) => ({ lid: p.lid, position: p.position, player_id: pids[i] }));
}

// 各位置默认角色对应的 eaId 拼出的合法战术码（存档接口要求 code 能解码）
function validCode() {
  const def = formDef();
  const ea = def.pos.map((p) => {
    const d = defaultPair(p.position);
    const v = pairEa(p.position, d.role, d.focus);
    if (v == null) throw new Error(`默认角色 ${p.position} ${d.role}/${d.focus} 没配到 eaId`);
    return v;
  });
  return encodeFut26({ form: FORM, bu: "balanced", lh: 50, ea });
}

type LineupAssign = {
  key: string;
  playerId: number;
  name: string | null;
  number: string | null;
  starter: boolean;
};

beforeAll(async () => {
  userHash = await hashPassword("TestPass123");
});

describe("指派规则（shared/tactics）", () => {
  it("18 项 5 组，键不重复", () => {
    expect(ASSIGN_GROUPS.map((g) => [g.title, g.items.length])).toEqual([
      ["队长", 1],
      ["任意球", 4],
      ["角球进攻", 7],
      ["角球防守", 4],
      ["界外球", 2],
    ]);
    expect(ASSIGN_KEYS.length).toBe(18);
    expect(new Set(ASSIGN_KEYS).size).toBe(18);
  });

  it("互斥只在角球主罚人与角球进攻接应角色之间，且双向", () => {
    // 主罚人不能接应
    expect(assignConflicts({ ca_left: 5, ca_target: 5 })).toEqual([
      { playerId: 5, a: "ca_left", b: "ca_target" },
    ]);
    expect(assignConflicts({ ca_right: 5, ca_cover: 5 }).length).toBe(1);
    // 接应角色之间可以同一人；一人开两侧角球可以；主罚人与角球防守组可以
    expect(assignConflicts({ ca_target: 5, ca_near: 5, ca_far: 5 })).toEqual([]);
    expect(assignConflicts({ ca_left: 5, ca_right: 5 })).toEqual([]);
    expect(assignConflicts({ ca_left: 5, cd_near: 5, cd_guard: 5 })).toEqual([]);
    // 不同人是不同的事
    expect(assignConflicts({ ca_left: 5, ca_target: 6 })).toEqual([]);
  });

  it("冲突文案点名两个角色（含组名，避免近门柱/远门柱歧义）", () => {
    const [c] = assignConflicts({ ca_left: 5, ca_target: 5 });
    expect(conflictText(c)).toBe("角球主罚「角球进攻·左侧角球」和接应「角球进攻·目标球员」不能是同一名球员");
  });
});

describe("指派解析/校验（worker/lib/lineup）", () => {
  it("parseAssignJson 对坏数据退化为空，不炸接口", () => {
    expect(parseAssignJson("")).toEqual({});
    expect(parseAssignJson("{")).toEqual({});
    expect(parseAssignJson("[1,2]")).toEqual({});
    expect(parseAssignJson("null")).toEqual({});
    expect(parseAssignJson('{"nope":1,"captain":"7","fk_long":-1,"ti_left":0}')).toEqual({});
    expect(parseAssignJson('{"captain":7,"ca_left":45}')).toEqual({ captain: 7, ca_left: 45 });
  });

  it("normalizeAssign 掐掉未知键与坏值、拦互斥冲突；缺省视为空", () => {
    expect(normalizeAssign(undefined)).toEqual({});
    expect(normalizeAssign(null)).toEqual({});
    expect(normalizeAssign({ captain: 7 })).toEqual({ captain: 7 });
    expect(() => normalizeAssign("x")).toThrowError("指派格式不对，请回战术板重填");
    expect(() => normalizeAssign({ nope: 1 })).toThrowError("指派项不认识，请回战术板重填");
    expect(() => normalizeAssign({ captain: "7" })).toThrowError("指派里有点坏掉的项，请回战术板重选球员");
    expect(() => normalizeAssign({ ca_left: 5, ca_target: 5 })).toThrowError(/^指派冲突：/);
  });
});

describe("教练端提交指派", () => {
  it("随阵容落库并按组序回读：队长在最前，非首发球员标 starter:false", async () => {
    const { env, sqlite } = freshEnv();
    const res = await json(
      env,
      "a",
      "/api/coach/matches/802/lineup",
      { form: FORM, slots: slots(10), assign: { captain: 100, fk_penalty: 111, ti_left: 104 } },
      "PUT",
    );
    expect(res.status).toBe(200);

    const stored = sqlite
      .prepare("SELECT assign_json FROM tactic_submission WHERE match_id = 802 AND team_id = 10")
      .get() as { assign_json: string };
    expect(JSON.parse(stored.assign_json)).toEqual({ captain: 100, fk_penalty: 111, ti_left: 104 });

    const back = (await (await req(env, "a", "/api/coach/matches/802/lineup")).json()) as {
      lineup: { assign: LineupAssign[] } | null;
    };
    // 顺序 = ASSIGN_GROUPS 顺序（队长 → 任意球 → … → 界外球），不是提交时的键序
    expect(back.lineup?.assign).toEqual([
      { key: "captain", playerId: 100, name: "红1", number: "1", starter: true },
      { key: "fk_penalty", playerId: 111, name: "红12", number: "12", starter: false },
      { key: "ti_left", playerId: 104, name: "红5", number: "5", starter: true },
    ]);
    expect(back.lineup?.assign.every((a) => a.meta === undefined)).toBe(true);
  });

  it("管理端赛前备案看得到指派（automatically 随 DTO 展开）", async () => {
    const { env } = freshEnv();
    await json(env, "a", "/api/coach/matches/802/lineup", { form: FORM, slots: slots(10), assign: { captain: 100 } }, "PUT");
    const adm = (await (await req(env, "admin", "/api/admin/matches/802/lineup")).json()) as {
      home: { assign: LineupAssign[] } | null;
      away: unknown;
    };
    expect(adm.away).toBeNull();
    expect(adm.home?.assign).toEqual([
      { key: "captain", playerId: 100, name: "红1", number: "1", starter: true },
    ]);
  });

  it("覆盖提交整份替换：第二次不带指派就把指派清空", async () => {
    const { env, sqlite } = freshEnv();
    await json(env, "a", "/api/coach/matches/802/lineup", { form: FORM, slots: slots(10), assign: { captain: 100 } }, "PUT");
    await json(env, "a", "/api/coach/matches/802/lineup", { form: FORM, slots: slots(10) }, "PUT");
    const stored = sqlite
      .prepare("SELECT assign_json FROM tactic_submission WHERE match_id = 802 AND team_id = 10")
      .get() as { assign_json: string };
    expect(JSON.parse(stored.assign_json)).toEqual({});
  });

  it("指派指向非本队球员或未知角色：400", async () => {
    const { env } = freshEnv();
    let res = await json(env, "a", "/api/coach/matches/802/lineup", { form: FORM, slots: slots(10), assign: { captain: 200 } }, "PUT");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe("指派里点到了不属于该球队的球员，请回战术板重选");

    res = await json(env, "a", "/api/coach/matches/802/lineup", { form: FORM, slots: slots(10), assign: { nope: 100 } }, "PUT");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe("指派项不认识，请回战术板重填");
  });

  it("互斥冲突拦提交，错误消息点名双方角色", async () => {
    const { env } = freshEnv();
    const res = await json(
      env,
      "a",
      "/api/coach/matches/802/lineup",
      { form: FORM, slots: slots(10), assign: { ca_left: 100, ca_near: 100 } },
      "PUT",
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe(
      "指派冲突：角球主罚「角球进攻·左侧角球」和接应「角球进攻·近门柱」不能是同一名球员",
    );
  });
});

describe("代打链路上的指派", () => {
  it("代打提交带指派：按被代打队判归属，落库留痕，代打板与教练端都回读得到", async () => {
    const { env, sqlite } = freshEnv();
    const g = await json(env, "admin", "/api/admin/proxy-grants", { matchId: 802, teamId: 10, granteeUserId: 2 });
    expect(g.status).toBe(200);

    const res = await json(
      env,
      "b",
      "/api/coach/proxy/802/lineup",
      { form: FORM, slots: slots(10), assign: { captain: 100, ca_left: 104 } },
      "PUT",
    );
    expect(res.status).toBe(200);

    const stored = sqlite
      .prepare("SELECT team_id, assign_json, proxy_grant_id FROM tactic_submission WHERE match_id = 802")
      .get() as { team_id: number; assign_json: string; proxy_grant_id: number | null };
    expect(stored.team_id).toBe(10);
    expect(stored.proxy_grant_id).not.toBeNull();
    expect(JSON.parse(stored.assign_json)).toEqual({ captain: 100, ca_left: 104 });

    // 代打板上直接能看到目标队已提交的指派（代打者据此回填）
    const board = (await (await req(env, "b", "/api/coach/proxy/802/board")).json()) as {
      lineup: { assign: LineupAssign[] } | null;
    };
    expect(board.lineup?.assign).toEqual([
      { key: "captain", playerId: 100, name: "红1", number: "1", starter: true },
      { key: "ca_left", playerId: 104, name: "红5", number: "5", starter: true },
    ]);

    // 本队教练（让位中）看不到阵容，但管理员赛前备案看得到代打留下的指派
    const adm = (await (await req(env, "admin", "/api/admin/matches/802/lineup")).json()) as {
      home: { viaProxy: boolean; assign: LineupAssign[] } | null;
    };
    expect(adm.home?.viaProxy).toBe(true);
    expect(adm.home?.assign.length).toBe(2);
  });

  it("代打者用自己队（蓝队）的球员填指派：400（归属按目标队判）", async () => {
    const { env } = freshEnv();
    await json(env, "admin", "/api/admin/proxy-grants", { matchId: 802, teamId: 10, granteeUserId: 2 });
    const res = await json(
      env,
      "b",
      "/api/coach/proxy/802/lineup",
      { form: FORM, slots: slots(10), assign: { captain: 200 } },
      "PUT",
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe("指派里点到了不属于该球队的球员，请回战术板重选");
  });
});

describe("战术存档里的指派", () => {
  it("assign 随存档往返；存档是草稿本，允许存不在名单里的球员 id", async () => {
    const { env } = freshEnv();
    const code = validCode();
    const res = await json(
      env,
      "a",
      "/api/coach/tactics",
      { note: "常规阵", code, form: FORM, buildup: "balanced", lineHeight: 50, roster: { "1": "100" }, assign: { captain: 100, ca_left: 999 } },
    );
    expect(res.status).toBe(200);

    const list = (await (await req(env, "a", "/api/coach/tactics")).json()) as {
      tactics: { code: string; note: string; assign: Record<string, number>; roster: Record<string, string> }[];
    };
    expect(list.tactics.length).toBe(1);
    expect(list.tactics[0].assign).toEqual({ captain: 100, ca_left: 999 });
    expect(list.tactics[0].roster).toEqual({ "1": "100" });

    // 存档里带互斥冲突仍然被拦（规则一处定义，两处生效）
    const bad = await json(
      env,
      "a",
      "/api/coach/tactics",
      { code, form: FORM, buildup: "balanced", lineHeight: 50, assign: { ca_left: 100, ca_target: 100 } },
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toMatch(/^指派冲突：/);
  });
});
