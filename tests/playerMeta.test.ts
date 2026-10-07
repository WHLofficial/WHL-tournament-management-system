// player_meta 的读侧（worker/lib/playerMeta.ts）与镜像写侧（worker/lib/clubMeta.ts）。
// 钉住四条线：
// ① 读侧真查 D1：脏 JSON、非数值属性、非法徽章 id 一律挡掉；三个字段都空的行走「没有这条 meta」
//    （DTO 里 meta 缺省的旧语义不能变，前端按「有才渲染」）；
// ② 读侧出错不上抛：表没迁移、字段脏都不该让阵容读出 500（meta 只是附加展示信息）；
// ③ 写侧分批 90、单批失败不中断、响应形状不对只降级（name 册同步的桩对所有 fetch 都回 squads 数组，
//    那条路径必须安静地变成「这一批没拉到」，绝不能抛进名册同步）；
// ④ 只拉本仓 player 表里有的 fcId；upsert 一人一行、synced_at 跟着刷新。
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { Bindings } from "../worker/env";
import {
  META_BATCH,
  fetchPlayerMetaBatch,
  syncPlayerMeta,
  upsertPlayerMeta,
} from "../worker/lib/clubMeta";
import { loadPlayerMeta } from "../worker/lib/playerMeta";
import { createTestDb, createTestKV, sqlAll } from "./d1";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 只塞一支队 + 若干球员：同步入口会先跟 player 表求交集，球员工资表在这里就够用了 */
function seedPlayers(sqlite: DatabaseSync, ids: number[]): void {
  sqlite
    .prepare(
      "INSERT INTO team (id, org_id, name, created_at) VALUES (7, 1, '阿森纳', ?)",
    )
    .run("2026-01-01T00:00:00Z");
  const ins = sqlite.prepare(
    "INSERT INTO player (id, team_id, name, number) VALUES (?, 7, ?, NULL)",
  );
  for (const id of ids) ins.run(id, `球员${id}`);
}

function insertMeta(
  sqlite: DatabaseSync,
  fcId: number,
  height: number | null,
  attrs: string,
  playstyles: string,
): void {
  sqlite
    .prepare(
      "INSERT INTO player_meta (fc_id, height, attrs, playstyles, synced_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(fcId, height, attrs, playstyles, "2026-01-01T00:00:00.000Z");
}

function testEnv(db: D1Database, clubBase?: string): Bindings {
  return {
    DB: db,
    KV: createTestKV(),
    MEDIA: {} as never,
    ASSETS: {} as never,
    ...(clubBase === undefined ? {} : { CLUB_API_BASE: clubBase }),
  } as unknown as Bindings;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** 从请求 URL 里解出这一批 fcId（写侧分批对不对，只有它看得出） */
function idsOf(url: string): number[] {
  return (new URL(url).searchParams.get("fcIds") ?? "")
    .split(",")
    .filter((s) => s !== "")
    .map(Number);
}

/** 桩：按请求里的 fcId 原样回一份合规响应，便于断言「发了几批、每批几个」 */
function echoStub(): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    return json({
      players: idsOf(url).map((fcId) => ({
        fcId,
        height: 180,
        attrs: { curve: 80 },
        playstyles: [4],
      })),
    });
  });
  return { urls };
}

describe("loadPlayerMeta：按 id 查 player_meta", () => {
  it("空表 / 没命中的 id → 空 Map（DTO 里 meta 仍然缺省）", async () => {
    const { sqlite, db } = createTestDb();
    expect(await loadPlayerMeta(db, [2500801])).toEqual(new Map());

    insertMeta(sqlite, 2500801, 189, '{"curve":88}', "[4]");
    const map = await loadPlayerMeta(db, [2500801, 999999]);
    expect(map.size).toBe(1);
    expect(map.has(999999)).toBe(false);
  });

  it("正常读：attrs 数值 / playstyles 排序去重 / height 一起带出", async () => {
    const { sqlite, db } = createTestDb();
    insertMeta(
      sqlite,
      2500801,
      189,
      '{"curve":88,"headingaccuracy":71}',
      "[105,4,4]",
    );
    expect(await loadPlayerMeta(db, [2500801])).toEqual(
      new Map([
        [
          2500801,
          {
            attrs: { curve: 88, headingaccuracy: 71 },
            playstyles: [4, 105],
            height: 189,
          },
        ],
      ]),
    );
  });

  it("脏数据：坏 JSON / 非数组 / 非对象 / 三字段全空 → 整条不进 Map", async () => {
    const { sqlite, db } = createTestDb();
    insertMeta(sqlite, 1, null, "not-json", '{"a":1}'); // 两个字段都坏
    insertMeta(sqlite, 2, null, "[]", "[]"); // JSON 合法但不是对象/数组
    insertMeta(sqlite, 3, null, "{}", "[]"); // 全都空
    insertMeta(sqlite, 4, null, '{"curve":90}', "[4]"); // 好的那条
    const map = await loadPlayerMeta(db, [1, 2, 3, 4]);
    expect([...map.keys()]).toEqual([4]);
  });

  it("过滤规则：属性只留有限数值，徽章只留正整数", async () => {
    const { sqlite, db } = createTestDb();
    insertMeta(
      sqlite,
      1,
      180,
      '{"curve":90,"name":"x","flag":true,"nil":null}',
      "[4,4,0,-3,105,1.5,205]",
    );
    const meta = (await loadPlayerMeta(db, [1])).get(1)!;
    expect(meta.attrs).toEqual({ curve: 90 });
    expect(meta.playstyles).toEqual([4, 105, 205]);
  });

  it("id 先去重再查：非法 id 不占位（1 个合法 id 就发 1 个占位符）", async () => {
    const { sqlite, db } = createTestDb();
    insertMeta(sqlite, 100, 180, '{"curve":90}', "[4]");
    const sqls: string[] = [];
    const spy = {
      prepare: (sql: string) => {
        sqls.push(sql);
        return db.prepare(sql);
      },
    } as unknown as D1Database;
    const map = await loadPlayerMeta(spy, [100, 100, 0, -5, 1.5]);
    expect(map.size).toBe(1);
    expect(sqls).toHaveLength(1);
    expect((sqls[0].match(/\?/g) ?? []).length).toBe(1);
  });

  it("超过 50 个 id 自动分批（每批 50）", async () => {
    const { sqlite, db } = createTestDb();
    const ids = Array.from({ length: 60 }, (_, i) => 1000 + i);
    for (const id of ids) insertMeta(sqlite, id, 180, '{"curve":90}', "[4]");
    const sqls: string[] = [];
    const spy = {
      prepare: (sql: string) => {
        sqls.push(sql);
        return db.prepare(sql);
      },
    } as unknown as D1Database;
    const map = await loadPlayerMeta(spy, ids);
    expect(map.size).toBe(60);
    expect(sqls.map((s) => (s.match(/\?/g) ?? []).length)).toEqual([50, 10]);
  });

  it("表不在（迁移没跑）时降级成空 Map，不抛给阵容读出", async () => {
    const { sqlite, db } = createTestDb();
    sqlite.exec("DROP TABLE player_meta");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(loadPlayerMeta(db, [1])).resolves.toEqual(new Map());
    expect(logged).toHaveBeenCalledTimes(1);
  });
});

describe("fetchPlayerMetaBatch：单批拉取", () => {
  it("URL 形状与解析：base 末尾斜杠归一、height 取整、脏字段就地丢掉", async () => {
    let url = "";
    let init: RequestInit | undefined;
    vi.stubGlobal("fetch", async (u: string, i?: RequestInit) => {
      url = u;
      init = i;
      return json({
        players: [
          { fcId: 2500801, height: 189.4, attrs: { curve: 88, bad: "x" }, playstyles: [105, 4, 4] },
          { fcId: 2500802, height: null, attrs: "x", playstyles: [1] },
          { fcId: 0, height: 180, attrs: {}, playstyles: [] }, // fcId 非法 → 跳过
          { name: "没有 fcId" }, // 缺 fcId → 跳过
        ],
      });
    });
    const rows = await fetchPlayerMetaBatch("https://club.whleague.win/", [
      2500801, 2500802,
    ]);
    expect(url).toBe(
      "https://club.whleague.win/api/players/meta?fcIds=2500801,2500802",
    );
    expect(init?.headers).toEqual({ accept: "application/json" });
    expect(rows).toEqual([
      { fcId: 2500801, height: 189, attrs: { curve: 88 }, playstyles: [4, 105] },
      { fcId: 2500802, height: null, attrs: {}, playstyles: [1] },
    ]);
  });

  it("非 2xx 抛错，且报错里不带整串 fcId（90 个 id 能把日志撑爆）", async () => {
    vi.stubGlobal("fetch", async () => json({ message: "boom" }, 503));
    const err = await fetchPlayerMetaBatch("https://club.whleague.win", [1, 2, 3]).catch(
      (e: Error) => e,
    );
    expect(String(err)).toContain("返回 503");
    expect(String(err)).toContain("3 个 fcId");
    expect(String(err)).not.toContain("fcIds=");
  });

  it("响应里没有 players 数组就抛（形状坏掉不能当空数据用）", async () => {
    vi.stubGlobal("fetch", async () => json({ ok: true }));
    await expect(fetchPlayerMetaBatch("https://x", [1])).rejects.toThrow(
      "没有 players 数组",
    );
  });

  it("空 fcId 列表直接返回空，不发请求", async () => {
    const { urls } = echoStub();
    expect(await fetchPlayerMetaBatch("https://x", [])).toEqual([]);
    expect(urls).toHaveLength(0);
  });
});

describe("syncPlayerMeta：分批、求交集、失败降级", () => {
  it("没配 CLUB_API_BASE → 跳过，不发请求", async () => {
    const { db } = createTestDb();
    const { urls } = echoStub();
    const s = await syncPlayerMeta(testEnv(db), [1, 2]);
    expect(s).toMatchObject({
      batches: 0,
      fetched: 0,
      upserted: 0,
      failedBatches: 0,
      skipped: "未配置 CLUB_API_BASE",
    });
    expect(urls).toHaveLength(0);
  });

  it("只拉本仓 player 表里有的 fcId（100/101 认识，999 不认识，-1 非法）", async () => {
    const { sqlite, db } = createTestDb();
    seedPlayers(sqlite, [100, 101]);
    const { urls } = echoStub();
    const s = await syncPlayerMeta(testEnv(db, "https://club.whleague.win"), [
      100, 999, 101, -1,
    ]);
    expect(urls).toHaveLength(1);
    expect(idsOf(urls[0])).toEqual([100, 101]);
    expect(s).toMatchObject({ batches: 1, fetched: 2, upserted: 2, failedBatches: 0 });
    expect(
      sqlAll<{ fc_id: number }>(sqlite, "SELECT fc_id FROM player_meta ORDER BY fc_id"),
    ).toEqual([{ fc_id: 100 }, { fc_id: 101 }]);
  });

  it("这批 fcId 本仓一个都不认识 → 跳过，不发请求", async () => {
    const { sqlite, db } = createTestDb();
    seedPlayers(sqlite, [100]);
    const { urls } = echoStub();
    const s = await syncPlayerMeta(testEnv(db, "https://x"), [999, 1000]);
    expect(s.skipped).toBe("这批 fcId 在本仓 player 表里都没有");
    expect(urls).toHaveLength(0);
  });

  it("空列表 → 跳过；200 人分 3 批（90/90/20）", async () => {
    const { sqlite, db } = createTestDb();
    seedPlayers(sqlite, Array.from({ length: 200 }, (_, i) => i + 1));
    const { urls } = echoStub();
    const env = testEnv(db, "https://club.whleague.win");
    expect((await syncPlayerMeta(env, [])).skipped).toBe("没有可拉的球员");

    const s = await syncPlayerMeta(
      env,
      Array.from({ length: 200 }, (_, i) => i + 1),
    );
    expect(META_BATCH).toBe(90);
    expect(urls).toHaveLength(3);
    expect(urls.map((u) => idsOf(u).length)).toEqual([90, 90, 20]);
    expect(s).toMatchObject({ batches: 3, fetched: 200, upserted: 200, failedBatches: 0 });
    expect(
      sqlAll<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM player_meta")[0].n,
    ).toBe(200);
  });

  it("中间某批 500：只丢那一批，其余照常落库，不抛", async () => {
    const { sqlite, db } = createTestDb();
    seedPlayers(sqlite, Array.from({ length: 200 }, (_, i) => i + 1));
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      if (urls.length === 2) return json({ message: "boom" }, 500);
      return json({
        players: idsOf(url).map((fcId) => ({
          fcId,
          height: 180,
          attrs: { curve: 80 },
          playstyles: [4],
        })),
      });
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await syncPlayerMeta(
      testEnv(db, "https://club.whleague.win"),
      Array.from({ length: 200 }, (_, i) => i + 1),
    );
    expect(s).toMatchObject({ batches: 2, fetched: 110, upserted: 110, failedBatches: 1 });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(
      sqlAll<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM player_meta")[0].n,
    ).toBe(110);
  });

  it("响应形状不对（名册同步的桩对所有 fetch 都回 squads 数组）→ 降级成失败批，不抛", async () => {
    const { sqlite, db } = createTestDb();
    seedPlayers(sqlite, [100, 101]);
    vi.stubGlobal("fetch", async () => json({ squads: [{ clubId: 7 }] }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await syncPlayerMeta(testEnv(db, "https://club.whleague.win"), [100, 101]);
    expect(s).toMatchObject({ batches: 0, fetched: 0, upserted: 0, failedBatches: 1 });
    expect(s.skipped).toBeUndefined();
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("同一批一个球员都没回（club 侧查无此人）→ 不发写语句", async () => {
    const { sqlite, db } = createTestDb();
    seedPlayers(sqlite, [100]);
    vi.stubGlobal("fetch", async () => json({ players: [] }));
    const s = await syncPlayerMeta(testEnv(db, "https://club.whleague.win"), [100]);
    expect(s).toMatchObject({ batches: 1, fetched: 0, upserted: 0, failedBatches: 0 });
    expect(
      sqlAll<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM player_meta")[0].n,
    ).toBe(0);
  });
});

describe("upsertPlayerMeta：一人一行，整行覆盖", () => {
  it("同一 fcId 写两次只留一行，字段与 synced_at 都被第二次覆盖", async () => {
    const { sqlite, db } = createTestDb();
    await upsertPlayerMeta(
      db,
      [{ fcId: 100, height: 180, attrs: { curve: 70 }, playstyles: [4] }],
      "2026-01-01T00:00:00.000Z",
    );
    await upsertPlayerMeta(
      db,
      [{ fcId: 100, height: 181, attrs: { curve: 71 }, playstyles: [104] }],
      "2026-01-02T00:00:00.000Z",
    );
    const rows = sqlAll<{
      fc_id: number;
      height: number;
      attrs: string;
      playstyles: string;
      synced_at: string;
    }>(sqlite, "SELECT fc_id, height, attrs, playstyles, synced_at FROM player_meta");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      fc_id: 100,
      height: 181,
      attrs: '{"curve":71}',
      playstyles: "[104]",
      synced_at: "2026-01-02T00:00:00.000Z",
    });
  });
});

describe("读写闭环：同步落库 → 战术页能读到", () => {
  it("club 下发什么，loadPlayerMeta 就还原什么（含身高与金银徽章）", async () => {
    const { sqlite, db } = createTestDb();
    seedPlayers(sqlite, [2500801]);
    vi.stubGlobal("fetch", async () =>
      json({
        players: [
          {
            fcId: 2500801,
            height: 189,
            attrs: { curve: 88, freekickaccuracy: 91, shotpower: 86, longshots: 80 },
            playstyles: [104, 5],
          },
        ],
      }),
    );
    const s = await syncPlayerMeta(testEnv(db, "https://club.whleague.win"), [2500801]);
    expect(s.upserted).toBe(1);

    const meta = (await loadPlayerMeta(db, [2500801])).get(2500801)!;
    expect(meta.height).toBe(189);
    expect(meta.attrs?.freekickaccuracy).toBe(91);
    expect(meta.playstyles).toEqual([5, 104]);
  });
});
