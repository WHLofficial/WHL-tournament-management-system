// 伤停登记路由 + scoring 联动集成测试：兼容模式会话驱动真实 app。
// 钉死：登记必须挂伤病事件、跨赛事勾选校验、severity 名库档位校验、
// 删事件级联撤登记（带提示）、挂登记时改事件类型 409、伤停中派生口径。
import { beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { hashPassword } from "../worker/lib/crypto";
import { applyMigrations, createTestD1, createTestKV } from "./d1";
import { listActiveInjuries } from "../worker/lib/injury";

let userHash = "";

function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  sqlite
    .prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(1, "管理员", "", userHash, "admin", 0, 0);
  // 两队 + 球员（organization id=1 迁移已建）
  const iso = "2026-01-01T00:00:00Z";
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (10, 1, '红队', ?)").run(iso);
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (11, 1, '蓝队', ?)").run(iso);
  sqlite.prepare("INSERT INTO player (id, team_id, name) VALUES (100, 10, '张三')").run();
  sqlite.prepare("INSERT INTO player (id, team_id, name) VALUES (101, 11, '李四')").run();
  // 两届赛事：A（受伤地）与 B（跨赛事缺阵地）
  sqlite
    .prepare("INSERT INTO tournament (id, org_id, name, format, status, created_by) VALUES (7, 1, '联赛', 'round_robin', 'running', 1)")
    .run();
  sqlite
    .prepare("INSERT INTO tournament (id, org_id, name, format, status, created_by) VALUES (9, 1, '冠军杯', 'round_robin', 'running', 1)")
    .run();
  sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (70, 7, 'round_robin', 1)").run();
  sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (90, 9, 'round_robin', 1)").run();
  // entry：联赛 7 红队(500)、蓝队(501)；冠军杯 9 红队(600)
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (500, 7, 10, 1)").run();
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (501, 7, 11, 2)").run();
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (600, 9, 10, 1)").run();
  // 联赛第 1 轮：红 3:1 蓝（已完赛，受伤场）；第 2 轮 红 vs 蓝（pending）；冠军杯第 1 轮 红 vs ???（pending，跨赛事勾选用）
  sqlite
    .prepare(
      "INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, score_home, score_away, status, finished_at) VALUES (800, 70, 1, 1, 500, 501, 3, 1, 'finished', '2026-03-01T10:00:00Z')"
    )
    .run();
  sqlite
    .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status) VALUES (801, 70, 2, 1, 501, 500, 'pending')")
    .run();
  sqlite
    .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status) VALUES (810, 90, 1, 1, 600, NULL, 'pending')")
    .run();
  // 伤病事件：张三受伤（红队 500）在 800 场
  sqlite
    .prepare("INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, created_by) VALUES (900, 800, 500, 100, 'injury_minor', 30, 1)")
    .run();
  const kv = new Map<string, string>([["sess:tok-admin", JSON.stringify({ userId: 1 })]]);
  const env: Record<string, unknown> = {
    DB: createTestD1(sqlite),
    KV: createTestKV(kv) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
  };
  return { env, sqlite };
}

const post = (env: Record<string, unknown>, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { Cookie: "whl_session=tok-admin", "content-type": "application/json" }, body: JSON.stringify(body) }, env);
const put = (env: Record<string, unknown>, path: string, body: unknown) =>
  app.request(path, { method: "PUT", headers: { Cookie: "whl_session=tok-admin", "content-type": "application/json" }, body: JSON.stringify(body) }, env);
const del = (env: Record<string, unknown>, path: string) =>
  app.request(path, { method: "DELETE", headers: { Cookie: "whl_session=tok-admin" } }, env);
const get = (env: Record<string, unknown>, path: string) =>
  app.request(path, { headers: { Cookie: "whl_session=tok-admin" } }, env);

beforeAll(async () => {
  userHash = await hashPassword("TestPass123");
});

describe("伤停登记路由", () => {
  it("POST 挂 injury_minor 事件建登记：默认球员、跨赛事勾选、severity 派生", async () => {
    const { env, sqlite } = freshEnv();
    const res = await post(env, "/api/admin/injuries", {
      eventId: 900,
      injuryName: "踝关节扭伤",
      note: "下场可能复出",
      missMatchIds: [801, 810], // 联赛 pending + 冠军杯 pending（跨赛事）
    });
    expect(res.status).toBe(200);
    const inj = sqlite.prepare("SELECT * FROM injury WHERE event_id = 900").get() as {
      id: number;
      team_id: number;
      player_id: number;
      injury_name: string;
    };
    expect(inj.team_id).toBe(10);
    expect(inj.player_id).toBe(100);
    expect(inj.injury_name).toBe("踝关节扭伤");
    const misses = sqlite.prepare("SELECT match_id FROM injury_miss WHERE injury_id = ? ORDER BY match_id").all(inj.id) as unknown as { match_id: number }[];
    expect(misses.map((m) => m.match_id)).toEqual([801, 810]);
    expect(sqlite.prepare("SELECT action FROM audit_log WHERE action='injury_create'").get()).toBeTruthy();

    const list = await get(env, "/api/admin/injuries?teamId=10");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { injuries: { fromLabel: string; misses: { tournamentName: string; status: string }[]; recoverPercent: number; severity: string }[] };
    expect(body.injuries.length).toBe(1);
    expect(body.injuries[0].fromLabel).toBe("联赛 · 第1轮");
    expect(body.injuries[0].severity).toBe("minor");
    expect(body.injuries[0].recoverPercent).toBe(0); // 全 pending
    // 两届赛事的勾选都齐（跨赛事）；跨赛事排序不保证先后（都按各赛事轮次排）
    expect([...body.injuries[0].misses.map((m) => m.tournamentName)].sort()).toEqual(["冠军杯", "联赛"]);

    // 伤停中派生：还有 pending → 在列；把两场都改 finished → 不在列（伤愈）
    const act1 = await listActiveInjuries(env.DB as D1Database, 10);
    expect(act1.length).toBe(1);
    sqlite.prepare("UPDATE match SET status='finished' WHERE id IN (801, 810)").run();
    const act2 = await listActiveInjuries(env.DB as D1Database, 10);
    expect(act2.length).toBe(0);
  });

  it("校验逐类：非伤病事件 404、轻重伤档不匹配 400、库外名 400、重复登记 409、勾他队比赛 400", async () => {
    const { env, sqlite } = freshEnv();
    sqlite.prepare("INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, created_by) VALUES (901, 800, 500, 100, 'goal', 60, 1)").run();
    expect((await post(env, "/api/admin/injuries", { eventId: 901 })).status).toBe(404);

    const r1 = await post(env, "/api/admin/injuries", { eventId: 900, injuryName: "跖骨骨折" });
    expect(r1.status).toBe(400);
    expect((await r1.json()).message).toContain("轻伤");

    const r2 = await post(env, "/api/admin/injuries", { eventId: 900, injuryName: "神秘的伤" });
    expect(r2.status).toBe(400);
    expect((await r2.json()).message).toContain("名库");

    // 勾了不存在的比赛先被拒（在 409 重复检查之前）
    const r3 = await post(env, "/api/admin/injuries", { eventId: 900, missMatchIds: [802] });
    expect(r3.status).toBe(400);
    expect((await r3.json()).message).toContain("不是该队的比赛");

    expect((await post(env, "/api/admin/injuries", { eventId: 900, missMatchIds: [801] })).status).toBe(200);
    const dup = await post(env, "/api/admin/injuries", { eventId: 900, missMatchIds: [] });
    expect(dup.status).toBe(409);
    expect((await dup.json()).message).toContain("已建过登记");
  });

  it("PUT 重勾缺阵整体替换 + 换名；DELETE 撤销", async () => {
    const { env, sqlite } = freshEnv();
    await post(env, "/api/admin/injuries", { eventId: 900, injuryName: "踝关节扭伤", missMatchIds: [801, 810] });
    const id = (sqlite.prepare("SELECT id FROM injury WHERE event_id = 900").get() as { id: number }).id;

    const u = await put(env, `/api/admin/injuries/${id}`, { injuryName: "肌肉抽筋", note: null, missMatchIds: [810] });
    expect(u.status).toBe(200);
    const row = sqlite.prepare("SELECT injury_name, note FROM injury WHERE id = ?").get(id) as { injury_name: string; note: string | null };
    expect(row.injury_name).toBe("肌肉抽筋");
    expect(row.note).toBeNull();
    expect((sqlite.prepare("SELECT match_id FROM injury_miss WHERE injury_id = ?").all(id) as unknown as { match_id: number }[]).map((r) => r.match_id)).toEqual([810]);

    expect((await del(env, `/api/admin/injuries/${id}`)).status).toBe(200);
    expect(sqlite.prepare("SELECT id FROM injury WHERE id = ?").get(id)).toBeUndefined();
    expect(sqlite.prepare("SELECT id FROM injury_miss WHERE injury_id = ?").all(id).length).toBe(0);
    expect(sqlite.prepare("SELECT action FROM audit_log WHERE action='injury_delete'").get()).toBeTruthy();

    expect((await put(env, `/api/admin/injuries/9999`, {})).status).toBe(404);
    expect((await del(env, `/api/admin/injuries/9999`)).status).toBe(404);
  });

  it("scoring 联动：删伤病事件 → FK 级联撤登记 + 提示；挂登记时改事件类型 409", async () => {
    const { env, sqlite } = freshEnv();
    await post(env, "/api/admin/injuries", { eventId: 900, missMatchIds: [801] });

    // PUT 换类型被拒（injury_minor → goal）
    const chg = await put(env, "/api/admin/matches/800/events/900", { type: "goal", entryId: 500, playerId: 100, minute: 30 });
    expect(chg.status).toBe(409);
    expect((await chg.json()).message).toContain("撤销登记");

    // DELETE 事件带提示，登记随级联消失
    const drop = await del(env, "/api/admin/matches/800/events/900");
    expect(drop.status).toBe(200);
    expect(((await drop.json()) as { notice?: string }).notice).toContain("伤停登记已一并撤销");
    expect(sqlite.prepare("SELECT id FROM injury").get()).toBeUndefined();
    expect(sqlite.prepare("SELECT id FROM injury_miss").get()).toBeUndefined();
  });

  it("未登录拒绝；带 teamId 走按队过滤，不带则全量", async () => {
    const { env } = freshEnv();
    const res = await app.request("/api/admin/injuries?teamId=10", {}, env);
    expect(res.status).toBe(401);
    const all = await get(env, "/api/admin/injuries");
    expect(all.status).toBe(200);
    expect(((await all.json()) as { injuries: unknown[] }).injuries).toEqual([]);
  });
});

// 公开端三处数据露出：单场「因伤缺阵」名单、赛事级伤停动态分组、伤病榜「伤停中」徽标。
// pubCache 中间件用 caches.default + executionCtx.waitUntil，测试环境这里补最小桩。
(globalThis as unknown as { caches: unknown }).caches = {
  default: { match: async () => undefined, put: async () => {} },
};
const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

describe("伤停公开露出", () => {
  const pub = (env: Record<string, unknown>, path: string) =>
    app.request(path, {}, env, execCtx as never);

  it("单场详情带缺阵名单：按队分组、进度与伤名照登记走", async () => {
    const { env } = freshEnv();
    await post(env, "/api/admin/injuries", { eventId: 900, injuryName: "踝关节扭伤", missMatchIds: [800, 801] });

    const res = await pub(env, "/api/public/tournaments/7/matches/800");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      absences: { home: { playerId: number; playerName: string; severity: string; injuryName: string; recoverPercent: number }[]; away: unknown[] };
    };
    expect(body.absences.home.length).toBe(1);
    expect(body.absences.home[0]).toMatchObject({
      playerId: 100,
      playerName: "张三",
      severity: "minor",
      injuryName: "踝关节扭伤",
      recoverPercent: 50, // 勾了 800(finished)+801(pending)
    });
    expect(body.absences.away).toEqual([]);

    // 没勾的场次（801 是蓝队主场）蓝队一侧仍空
    const res2 = await pub(env, "/api/public/tournaments/7/matches/801");
    const b2 = (await res2.json()) as { absences: { home: unknown[]; away: { playerName: string }[] } };
    expect(b2.absences.home).toEqual([]);
    expect(b2.absences.away.map((a) => a.playerName)).toEqual(["张三"]);
  });

  it("赛事伤停动态：只列该届参赛队、跨赛事登记同一条、已伤愈不入列", async () => {
    const { env, sqlite } = freshEnv();
    await post(env, "/api/admin/injuries", { eventId: 900, injuryName: "踝关节扭伤", missMatchIds: [800, 801] });

    const res = await pub(env, "/api/public/tournaments/7/injuries");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: { teamId: number; teamName: string; injuries: { playerName: string; injuredInLabel: string; recoverPercent: number; misses: { status: string }[] }[] }[];
    };
    expect(body.groups.length).toBe(1); // 蓝队没伤停，空组被滤掉
    expect(body.groups[0].teamId).toBe(10);
    expect(body.groups[0].injuries[0].playerName).toBe("张三");
    expect(body.groups[0].injuries[0].injuredInLabel).toBe("联赛 · 第1轮");
    expect(body.groups[0].injuries[0].recoverPercent).toBe(50);

    // 同一份登记也出现在另一届（红队是冠军杯参赛队）——跨赛事可见
    const cup = await pub(env, "/api/public/tournaments/9/injuries");
    const cupBody = (await cup.json()) as { groups: { teamId: number; injuries: unknown[] }[] };
    expect(cupBody.groups.map((g) => g.teamId)).toEqual([10]);
    expect(cupBody.groups[0].injuries.length).toBe(1);

    // 缺阵场次全部打完 → 不再算伤停中，动态板清空
    sqlite.prepare("UPDATE match SET status='finished' WHERE id IN (800, 801)").run();
    const done = await pub(env, "/api/public/tournaments/7/injuries");
    expect(((await done.json()) as { groups: unknown[] }).groups).toEqual([]);
  });

  it("伤病榜行带伤停中徽标（跨赛事派生）", async () => {
    const { env, sqlite } = freshEnv();
    await post(env, "/api/admin/injuries", { eventId: 900, injuryName: "踝关节扭伤", missMatchIds: [801] });

    const res = await pub(env, "/api/public/tournaments/7/toplists");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { injuries: { playerName: string; injured?: boolean }[] };
    const row = body.injuries.find((r) => r.playerName === "张三");
    expect(row).toBeTruthy();
    expect(row?.injured).toBe(true);

    // 撤销登记 → 徽标消失
    const id = (sqlite.prepare("SELECT id FROM injury WHERE event_id = 900").get() as { id: number }).id;
    expect((await del(env, `/api/admin/injuries/${id}`)).status).toBe(200);
    const after = await pub(env, "/api/public/tournaments/7/toplists");
    const afterBody = (await after.json()) as { injuries: { playerName: string; injured?: boolean }[] };
    expect(afterBody.injuries.find((r) => r.playerName === "张三")?.injured).toBeFalsy();
  });
});

describe("伤停集中页接口", () => {
  it("GET /injuries 不带 teamId 返回全部登记，带队伍名", async () => {
    const { env } = freshEnv();
    await post(env, "/api/admin/injuries", { eventId: 900, injuryName: "踝关节扭伤", note: "待观察", missMatchIds: [801] });

    const res = await get(env, "/api/admin/injuries");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      injuries: { playerName: string; teamName: string; severity: string; injuryName: string; misses: unknown[] }[];
    };
    expect(body.injuries).toHaveLength(1);
    expect(body.injuries[0]).toMatchObject({
      playerName: "张三",
      teamName: "红队",
      severity: "minor",
      injuryName: "踝关节扭伤",
    });
    expect(body.injuries[0].misses).toHaveLength(1);
  });

  it("GET /injuries 仍支持按队过滤；teamId 不合法 400", async () => {
    const { env } = freshEnv();
    await post(env, "/api/admin/injuries", { eventId: 900 });

    const mine = await get(env, "/api/admin/injuries?teamId=10");
    expect(((await mine.json()) as { injuries: unknown[] }).injuries).toHaveLength(1);
    const other = await get(env, "/api/admin/injuries?teamId=11");
    expect(((await other.json()) as { injuries: unknown[] }).injuries).toHaveLength(0);
    expect((await get(env, "/api/admin/injuries?teamId=abc")).status).toBe(400);
  });

  it("GET /injuries/events 只列还没建登记的伤病事件，建完就消失", async () => {
    const { env, sqlite } = freshEnv();
    const first = (await (await get(env, "/api/admin/injuries/events")).json()) as {
      events: Record<string, unknown>[];
    };
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({
      eventId: 900,
      matchId: 800,
      tournamentId: 7,
      tournamentName: "联赛",
      round: 1,
      teamId: 10,
      teamName: "红队",
      playerId: 100,
      playerName: "张三",
      severity: "minor",
      minute: 30,
      opponentName: "蓝队",
      matchStatus: "finished",
      finishedAt: "2026-03-01T10:00:00Z",
    });

    await post(env, "/api/admin/injuries", { eventId: 900 });
    const after = (await (await get(env, "/api/admin/injuries/events")).json()) as { events: unknown[] };
    expect(after.events).toHaveLength(0);
  });

  it("事件没记球员也列出来（playerId 为 null，前端提示先去补球员）", async () => {
    const { env, sqlite } = freshEnv();
    sqlite
      .prepare(
        "INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, created_by) VALUES (901, 800, 500, NULL, 'injury_major', 70, 1)"
      )
      .run();
    const body = (await (await get(env, "/api/admin/injuries/events")).json()) as {
      events: { eventId: number; playerId: number | null; playerName: string | null; severity: string }[];
    };
    const ev = body.events.find((e) => e.eventId === 901);
    expect(ev).toMatchObject({ playerId: null, playerName: null, severity: "major" });
  });
});

// 候选缺阵比赛：字段名必须是驼峰——D1 按 SQL 别名原样返列名，漏转会给出 undefined 的
// matchId（前端所有复选框共用一个 undefined 状态，点一场就全选）与待定的队名。
describe("缺阵候选比赛接口", () => {
  it("跨赛事返回该队全部场次，字段是驼峰且带队名", async () => {
    const { env } = freshEnv();
    const body = (await (await get(env, "/api/admin/injuries/candidates?teamId=10")).json()) as {
      candidates: {
        matchId: number;
        tournamentId: number;
        tournamentName: string;
        round: number;
        stageKind: string;
        status: string;
        homeTeamName: string | null;
        awayTeamName: string | null;
      }[];
    };
    // 红队参赛：联赛第 1/2 轮（800/801）+ 冠军杯第 1 轮（810，对手未编排）
    expect(body.candidates.map((x) => x.matchId)).toEqual([800, 801, 810]);
    // 每行都必须有可用的 matchId 与队名，否则前端会退化成「待定 vs 待定」/ 全选
    expect(body.candidates.every((x) => Number.isInteger(x.matchId) && x.matchId > 0)).toBe(true);
    expect(body.candidates.every((x) => typeof x.tournamentName === "string" && x.tournamentName !== "")).toBe(true);
    expect(body.candidates.every((x) => typeof x.homeTeamName === "string" && x.homeTeamName !== "")).toBe(true);
    expect(body.candidates.find((x) => x.matchId === 800)).toMatchObject({
      tournamentId: 7,
      tournamentName: "联赛",
      round: 1,
      stageKind: "round_robin",
      status: "finished",
      homeTeamName: "红队",
      awayTeamName: "蓝队",
    });
    // 未编排对手的场次（away_entry_id 为 NULL）也要能勾，不参与时的对手名允许为空
    expect(body.candidates.find((x) => x.matchId === 810)).toMatchObject({
      tournamentId: 9,
      tournamentName: "冠军杯",
      status: "pending",
      homeTeamName: "红队",
      awayTeamName: null,
    });
    // 客队身份参赛的场次（801 蓝队主场红队客场）也在列表里，且队名取自主客两侧各自的 entry
    expect(body.candidates.find((x) => x.matchId === 801)).toMatchObject({
      homeTeamName: "蓝队",
      awayTeamName: "红队",
    });
  });
});
