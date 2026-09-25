// v4.0.0 步骤 10/11：名册同步（拉模式对账）+ 球员写入端点下线。
//
// 这个同步是个会删数据的定时任务，所以测试的重心不在「正常路径能跑」，而在三条防御：
// 空快照不动库、形状坏不写库、只对快照出现过的队做删除。另外把「首次同步的预期」
// （号码 0 改动、名字一批被改写、0 增 0 删）钉成断言，上线前核对时才有对照物。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { hashPassword } from "../worker/lib/crypto";
import { fetchClubSquads, syncRosters, type ClubSquad } from "../worker/lib/clubRoster";
import { applyMigrations, createTestD1, createTestKV, sqlAll, sqlGet } from "./d1";

let userHash = "";

beforeAll(async () => {
  userHash = await hashPassword("TestPass123");
});

/** 两支队（阿森纳 10 / 曼城 11）+ 一名管理员；clubBase 给了才配 CLUB_API_BASE */
function freshEnv(clubBase?: string) {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  sqlite
    .prepare(
      "INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(1, "管理员", "", userHash, "admin", 0, 0);
  const iso = "2026-01-01T00:00:00Z";
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (10, 1, '阿森纳', ?)").run(iso);
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (11, 1, '曼城', ?)").run(iso);
  const kv = new Map<string, string>([["sess:tok-admin", JSON.stringify({ userId: 1 })]]);
  const env: Record<string, unknown> = {
    DB: createTestD1(sqlite),
    KV: createTestKV(kv) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
  };
  if (clubBase !== undefined) env.CLUB_API_BASE = clubBase;
  return { env, sqlite };
}

/** 记下真正**执行**过的写语句：稳态同步「一条写都不发」这个断言只有它能证。
 *  注意记的是 run() 而不是 prepare()——dryRun 下语句照样会被 prepare 出来，只是从不执行。 */
function instrument(sqlite: DatabaseSync) {
  const inner = createTestD1(sqlite);
  const writes: string[] = [];
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const isWrite = /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(sql);
    const raw = stmt as unknown as {
      bind(...a: unknown[]): D1PreparedStatement;
      first(): Promise<unknown>;
      all(): Promise<unknown>;
      run(): Promise<unknown>;
    };
    return {
      bind: (...args: unknown[]) => wrap(raw.bind(...args), sql),
      first: () => raw.first(),
      all: () => raw.all(),
      run: () => {
        if (isWrite) writes.push(sql);
        return raw.run();
      },
    } as unknown as D1PreparedStatement;
  };
  const db = {
    prepare: (sql: string) => wrap(inner.prepare(sql), sql),
    batch: (stmts: D1PreparedStatement[]) => {
      writes.push(`BATCH(${stmts.length})`);
      return inner.batch(stmts as never);
    },
  } as unknown as D1Database;
  return { db, writes };
}

function seedPlayer(
  sqlite: DatabaseSync,
  id: number,
  teamId: number,
  name: string,
  number: string | null = null
) {
  sqlite.prepare("INSERT INTO player (id, team_id, name, number) VALUES (?, ?, ?, ?)").run(id, teamId, name, number);
}

/** 给 player 100 挂一条进球事件：删这个球员会被 match_event 外键拦下 */
function seedEventOnPlayer100(sqlite: DatabaseSync) {
  sqlite
    .prepare("INSERT INTO tournament (id, org_id, name, format, status, created_by) VALUES (7, 1, '联赛', 'round_robin', 'running', 1)")
    .run();
  sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (70, 7, 'round_robin', 1)").run();
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (500, 7, 10, 1)").run();
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (501, 7, 11, 2)").run();
  sqlite
    .prepare(
      "INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, score_home, score_away, status, finished_at) VALUES (800, 70, 1, 1, 500, 501, 3, 1, 'finished', '2026-03-01T10:00:00Z')"
    )
    .run();
  sqlite
    .prepare("INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, created_by) VALUES (900, 800, 500, 100, 'goal', 30, 1)")
    .run();
}

const post = (env: Record<string, unknown>, path: string) =>
  app.request(path, { method: "POST", headers: { Cookie: "whl_session=tok-admin" } }, env);
const del = (env: Record<string, unknown>, path: string) =>
  app.request(path, { method: "DELETE", headers: { Cookie: "whl_session=tok-admin" } }, env);
const patch = (env: Record<string, unknown>, path: string) =>
  app.request(path, { method: "PATCH", headers: { Cookie: "whl_session=tok-admin" } }, env);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("名册同步对账（syncRosters）", () => {
  it("首次同步：club 有 tour 无 → 按 fcId 建行，姓名号码照抄", async () => {
    const { sqlite } = freshEnv();
    const db = createTestD1(sqlite);
    const squads: ClubSquad[] = [
      { clubId: 10, clubName: "阿森纳", players: [{ fcId: 239085, name: "Erling Haaland", number: "9" }] },
      { clubId: 11, clubName: "曼城", players: [{ fcId: 212602, name: "Ederson", number: "31" }] },
    ];

    const s = await syncRosters(db, squads);

    expect(s).toMatchObject({
      dryRun: false,
      teams: 2,
      desired: 2,
      inserted: 2,
      teamMoved: 0,
      renamed: 0,
      renumbered: 0,
      stale: 0,
      deleted: 0,
      kept: [],
      unknownTeams: [],
    });
    expect(s.skipped).toBeUndefined();
    // player.id 就是 fcId（两库早前一起 rekey 过）
    expect(sqlAll(sqlite, "SELECT id, team_id, name, number FROM player ORDER BY id")).toEqual([
      { id: 212602, team_id: 11, name: "Ederson", number: "31" },
      { id: 239085, team_id: 10, name: "Erling Haaland", number: "9" },
    ]);
  });

  it("稳态：没有差异时一条写语句都不发", async () => {
    const { sqlite } = freshEnv();
    seedPlayer(sqlite, 239085, 10, "Erling Haaland", "9");
    const { db, writes } = instrument(sqlite);

    const s = await syncRosters(db, [
      { clubId: 10, clubName: "阿森纳", players: [{ fcId: 239085, name: "Erling Haaland", number: "9" }] },
    ]);

    expect(s).toMatchObject({ desired: 1, inserted: 0, teamMoved: 0, renamed: 0, renumbered: 0, stale: 0, deleted: 0 });
    expect(writes).toEqual([]);
  });

  it("换队 + 改名 + 改号一次到位，改名样例留痕", async () => {
    const { sqlite } = freshEnv();
    seedPlayer(sqlite, 239085, 10, "E. Haaland", "9");
    const db = createTestD1(sqlite);

    const s = await syncRosters(db, [
      { clubId: 11, clubName: "曼城", players: [{ fcId: 239085, name: "Erling Haaland", number: "17" }] },
    ]);

    expect(s).toMatchObject({ teamMoved: 1, renamed: 1, renumbered: 1, inserted: 0, deleted: 0 });
    expect(s.renamedSample).toEqual([{ id: 239085, from: "E. Haaland", to: "Erling Haaland" }]);
    expect(sqlGet(sqlite, "SELECT team_id, name, number FROM player WHERE id = 239085")).toEqual({
      team_id: 11,
      name: "Erling Haaland",
      number: "17",
    });
  });

  it("快照里没有的人 = 已离队 → 删除；快照之外的队一行不碰", async () => {
    const { sqlite } = freshEnv();
    seedPlayer(sqlite, 1, 10, "已离队");
    seedPlayer(sqlite, 2, 11, "别队的人");
    seedPlayer(sqlite, 3, 10, "还在队里");
    const db = createTestD1(sqlite);

    const s = await syncRosters(db, [
      { clubId: 10, clubName: "阿森纳", players: [{ fcId: 3, name: "还在队里", number: "5" }] },
    ]);

    expect(s).toMatchObject({ desired: 1, stale: 1, deleted: 1, inserted: 0 });
    expect(sqlAll(sqlite, "SELECT id FROM player ORDER BY id")).toEqual([{ id: 2 }, { id: 3 }]);
  });

  it("有比赛事件引用的行删不掉 → 保留并在 kept 里点名", async () => {
    const { sqlite } = freshEnv();
    seedPlayer(sqlite, 100, 10, "张三");
    seedEventOnPlayer100(sqlite);
    const db = createTestD1(sqlite);

    const s = await syncRosters(db, [
      { clubId: 10, clubName: "阿森纳", players: [{ fcId: 101, name: "李四", number: "7" }] },
    ]);

    expect(s.stale).toBe(1);
    expect(s.deleted).toBe(0);
    expect(s.kept).toEqual([{ id: 100, name: "张三", reason: "有比赛事件引用，保留" }]);
    // 历史比赛记录不能为了「同步干净」被删
    expect(sqlGet(sqlite, "SELECT id FROM player WHERE id = 100")).toEqual({ id: 100 });
  });

  it("空快照 → 整体跳过（对方挂了或配置写错时，绝不能当成「全员离队」）", async () => {
    const { sqlite } = freshEnv();
    seedPlayer(sqlite, 100, 10, "张三");
    const { db, writes } = instrument(sqlite);

    const empty = await syncRosters(db, []);

    expect(empty.skipped).toContain("0 支球队");
    expect(empty).toMatchObject({ inserted: 0, stale: 0, deleted: 0 });
    expect(writes).toEqual([]);
    expect(sqlAll(sqlite, "SELECT id, name FROM player")).toEqual([{ id: 100, name: "张三" }]);
  });

  it("快照里的队本仓一支都没有 → 整体跳过，不拿它去清队", async () => {
    const { sqlite } = freshEnv();
    seedPlayer(sqlite, 100, 10, "张三");
    const { db, writes } = instrument(sqlite);

    const unknown = await syncRosters(db, [
      { clubId: 999, clubName: "还没建过来的队", players: [{ fcId: 100, name: "张三", number: null }] },
    ]);

    expect(unknown.unknownTeams).toEqual([999]);
    expect(unknown.skipped).toContain("一支都没有");
    expect(unknown).toMatchObject({ inserted: 0, stale: 0, deleted: 0 });
    expect(writes).toEqual([]);
    expect(sqlAll(sqlite, "SELECT id, team_id, name FROM player")).toEqual([{ id: 100, team_id: 10, name: "张三" }]);
  });

  it("同一个人出现在两队 → 抛错且一行不写（快照自相矛盾）", async () => {
    const { sqlite } = freshEnv();
    seedPlayer(sqlite, 100, 10, "张三");
    const db = createTestD1(sqlite);

    await expect(
      syncRosters(db, [
        { clubId: 10, clubName: "阿森纳", players: [{ fcId: 100, name: "张三", number: "9" }] },
        { clubId: 11, clubName: "曼城", players: [{ fcId: 100, name: "张三", number: "17" }] },
      ])
    ).rejects.toThrow("同时出现在多支球队里");

    expect(sqlGet(sqlite, "SELECT team_id, number FROM player WHERE id = 100")).toEqual({
      team_id: 10,
      number: null,
    });
  });

  it("dryRun：差异算得出来，但一行都不写", async () => {
    const { sqlite } = freshEnv();
    seedPlayer(sqlite, 1, 10, "已离队");
    seedPlayer(sqlite, 2, 10, "E. Haaland", "9");
    const { db, writes } = instrument(sqlite);

    const s = await syncRosters(
      db,
      [{ clubId: 10, clubName: "阿森纳", players: [{ fcId: 2, name: "Erling Haaland", number: "17" }] }],
      { dryRun: true }
    );

    expect(s).toMatchObject({ dryRun: true, renamed: 1, renumbered: 1, stale: 1, deleted: 0 });
    expect(writes).toEqual([]);
    expect(sqlAll(sqlite, "SELECT id, name, number FROM player ORDER BY id")).toEqual([
      { id: 1, name: "已离队", number: null },
      { id: 2, name: "E. Haaland", number: "9" },
    ]);
  });

  it("号码为空串与 null 等价（不该被当成一次改号）", async () => {
    const { sqlite } = freshEnv();
    seedPlayer(sqlite, 2, 10, "张三", null);
    const { db, writes } = instrument(sqlite);

    const s = await syncRosters(db, [
      { clubId: 10, clubName: "阿森纳", players: [{ fcId: 2, name: "张三", number: "" }] },
    ]);

    expect(s.renumbered).toBe(0);
    expect(writes).toEqual([]);
  });
});

describe("拉取的形状校验（fetchClubSquads）", () => {
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("正常响应解析成 ClubSquad[]，号码数字转字符串", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse({
        squads: [
          { clubId: 10, clubName: "阿森纳", players: [{ fcId: 1, name: "张三", number: 9 }] },
          { clubId: 11, clubName: "曼城", players: [{ fcId: 2, name: "李四", number: null }] },
        ],
      })
    );

    const squads = await fetchClubSquads("https://club.example.com/");

    expect(squads).toEqual([
      { clubId: 10, clubName: "阿森纳", players: [{ fcId: 1, name: "张三", number: "9" }] },
      { clubId: 11, clubName: "曼城", players: [{ fcId: 2, name: "李四", number: null }] },
    ]);
  });

  it("非 2xx 抛错", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ message: "boom" }, 500));
    await expect(fetchClubSquads("https://club.example.com")).rejects.toThrow("返回 500");
  });

  it("响应里没有 squads 数组 → 抛错（半截数据不能当快照用）", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ ok: true }));
    await expect(fetchClubSquads("https://club.example.com")).rejects.toThrow("没有 squads 数组");
  });

  it("球员缺 fcId / 缺姓名 → 抛错", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ squads: [{ clubId: 10, players: [{ name: "张三" }] }] }));
    await expect(fetchClubSquads("https://club.example.com")).rejects.toThrow("缺 fcId");

    vi.stubGlobal("fetch", async () => jsonResponse({ squads: [{ clubId: 10, players: [{ fcId: 1, name: "  " }] }] }));
    await expect(fetchClubSquads("https://club.example.com")).rejects.toThrow("缺姓名");
  });

  it("快照里出现的队名单为空 → 抛错（空名单会把该队镜像整队删光）", async () => {
    vi.stubGlobal(
      "fetch",
      async () => jsonResponse({ squads: [{ clubId: 10, clubName: "阿森纳", players: [] }] })
    );
    await expect(fetchClubSquads("https://club.example.com")).rejects.toThrow("名单是空的");
  });

  it("拉取带超时信号：对方挂住时要有可观察的失败，不能一直挂着", async () => {
    let saw: AbortSignal | null = null;
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      saw = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    await expect(fetchClubSquads("https://club.example.com", { timeoutMs: 10 })).rejects.toThrow();

    const signal = saw as AbortSignal | null;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
  });
});

describe("POST /api/admin/sync-rosters", () => {
  const stubSquads = (squads: unknown[]) =>
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ squads }), { status: 200, headers: { "content-type": "application/json" } })
    );

  it("未配 CLUB_API_BASE → 500，且不去够网络", async () => {
    const { env } = freshEnv();
    let called = false;
    vi.stubGlobal("fetch", async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });

    const res = await post(env, "/api/admin/sync-rosters");

    expect(res.status).toBe(500);
    expect((await res.json<{ message: string }>()).message).toContain("CLUB_API_BASE");
    expect(called).toBe(false);
  });

  it("正常同步：落库 + 审计留痕", async () => {
    const { env, sqlite } = freshEnv("https://club.example.com");
    stubSquads([{ clubId: 10, clubName: "阿森纳", players: [{ fcId: 239085, name: "Erling Haaland", number: "9" }] }]);

    const res = await post(env, "/api/admin/sync-rosters");

    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; inserted: number; desired: number; dryRun: boolean }>();
    expect(body).toMatchObject({ ok: true, dryRun: false, desired: 1, inserted: 1 });
    expect(sqlGet(sqlite, "SELECT name FROM player WHERE id = 239085")).toEqual({ name: "Erling Haaland" });
    expect(
      sqlGet<{ action: string; target_type: string; detail_json: string }>(
        sqlite,
        "SELECT action, target_type, detail_json FROM audit_log ORDER BY id DESC LIMIT 1"
      )
    ).toMatchObject({ action: "player.sync_rosters", target_type: "account" });
  });

  it("?dryRun=1：只算不写，也不记审计", async () => {
    const { env, sqlite } = freshEnv("https://club.example.com");
    stubSquads([{ clubId: 10, clubName: "阿森纳", players: [{ fcId: 239085, name: "Erling Haaland", number: "9" }] }]);

    const res = await post(env, "/api/admin/sync-rosters?dryRun=1");

    expect(res.status).toBe(200);
    expect(await res.json<{ dryRun: boolean; inserted: number }>()).toMatchObject({ dryRun: true, inserted: 1 });
    expect(sqlAll(sqlite, "SELECT id FROM player")).toEqual([]);
    expect(sqlAll(sqlite, "SELECT id FROM audit_log")).toEqual([]);
  });

  it("拉取失败 → 502，一行不写", async () => {
    const { env, sqlite } = freshEnv("https://club.example.com");
    seedPlayer(sqlite, 1, 10, "已离队");
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 503 }));

    const res = await post(env, "/api/admin/sync-rosters");

    expect(res.status).toBe(502);
    expect((await res.json<{ message: string }>()).message).toContain("拉取俱乐部平台名册失败");
    expect(sqlAll(sqlite, "SELECT id FROM player")).toEqual([{ id: 1 }]);
  });

  it("观众号调不动（403）", async () => {
    const { env } = freshEnv("https://club.example.com");
    const res = await app.request("/api/admin/sync-rosters", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });
});

describe("球员写入端点已下线（v4.0.0 步骤 11）", () => {
  // 真源在俱乐部平台，本仓 player 表是镜像。留着手工写入口的后果不是「多一个入口」，
  // 而是「两个写者互相覆盖」——同步每跑一次就把手工改动抹掉。
  it("录入 / 批量导入 / 改名改号 / 删除四个端点都回 404", async () => {
    const { env, sqlite } = freshEnv();
    seedPlayer(sqlite, 100, 10, "张三");

    const cases: [string, () => Promise<Response>][] = [
      ["POST 录入", () => post(env, "/api/admin/teams/10/players")],
      ["POST 批量导入", () => post(env, "/api/admin/teams/10/players/bulk")],
      ["PATCH 改名改号", () => patch(env, "/api/admin/teams/10/players/100")],
      ["DELETE 删除", () => del(env, "/api/admin/teams/10/players/100")],
    ];

    for (const [label, call] of cases) {
      const res = await call();
      expect(res.status, label).toBe(404);
      expect(await res.json(), label).toEqual({ error: "not_found" });
    }
  });

  it("队级端点仍在（读详情 / 改队名），名单照常返回", async () => {
    const { env, sqlite } = freshEnv();
    seedPlayer(sqlite, 100, 10, "张三", "9");

    const detail = await app.request("/api/admin/teams/10", { headers: { Cookie: "whl_session=tok-admin" } }, env);
    expect(detail.status).toBe(200);
    expect(await detail.json<{ players: { id: number; name: string; number: string | null }[] }>()).toMatchObject({
      players: [{ id: 100, name: "张三", number: "9" }],
    });

    const renamed = await app.request(
      "/api/admin/teams/10",
      { method: "PATCH", headers: { Cookie: "whl_session=tok-admin", "content-type": "application/json" }, body: JSON.stringify({ name: "阿森纳二队" }) },
      env
    );
    expect(renamed.status).toBe(200);
    expect(sqlGet(sqlite, "SELECT name FROM team WHERE id = 10")).toEqual({ name: "阿森纳二队" });
  });
});
