// 履历重建（设计 §6.2）：转会回放、未知俱乐部屏障、observed 优先级、失败分级、幂等、回填调度。
// 这些断言锁的是「重建一次，名单/榜单/归档就都跟着对」的那条链路——错了不会报错，只会悄悄把人
// 放进错误的队，所以逐条钉死。

import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb, sqlAll, sqlGet } from "./d1";
import { insertPlayerWithWindow } from "./fixtures/players";
import {
  fetchTransferRecords,
  rebuildPlayerHistory,
  runHistoryBackfill,
} from "../worker/lib/playerHistory";
import type { Bindings } from "../worker/env";

const API = "https://club.example.com";
const NOW = "2026-09-01T00:00:00.000Z";

interface WindowRow {
  team_id: number;
  joined_at: string;
  left_at: string | null;
  source: string;
}

function windows(sqlite: DatabaseSync, playerId: number): WindowRow[] {
  return sqlAll<WindowRow>(
    sqlite,
    "SELECT team_id, joined_at, left_at, source FROM player_team_history WHERE player_id = ? ORDER BY joined_at, id",
    playerId,
  );
}

/** 俱乐部平台 /transfers 的响应（只带重建用到的字段） */
function transfersResponse(rows: unknown[], status = 200): Response {
  return new Response(JSON.stringify({ transfers: rows }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubTransfers(rows: unknown[] | (() => Response), status = 200): void {
  vi.stubGlobal("fetch", async () =>
    typeof rows === "function" ? rows() : transfersResponse(rows, status),
  );
}

const move = (from: number | null, to: number | null, at: string, type = "transfer") => ({
  type,
  fromClubId: from,
  fromClubName: from === null ? null : `队 ${from}`,
  toClubId: to,
  toClubName: to === null ? null : `队 ${to}`,
  completedAt: at,
});

function freshDb(): { sqlite: DatabaseSync; db: D1Database } {
  const { sqlite, db } = createTestDb();
  sqlite.exec("INSERT INTO team (id, org_id, name) VALUES (10, 1, '阿森纳')");
  sqlite.exec("INSERT INTO team (id, org_id, name) VALUES (11, 1, '曼城')");
  sqlite.exec("INSERT INTO team (id, org_id, name) VALUES (12, 1, '利物浦')");
  insertPlayerWithWindow(sqlite, { id: 100, teamId: 10, name: "张三" });
  return { sqlite, db };
}

function flag(sqlite: DatabaseSync, id = 100): string | null | undefined {
  return sqlGet<{ history_synced_at: string | null }>(
    sqlite,
    "SELECT history_synced_at FROM player WHERE id = ?",
    id,
  )?.history_synced_at;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchTransferRecords", () => {
  it("正常响应解析，404 是终态，5xx 抛错", async () => {
    vi.stubGlobal("fetch", async () =>
      transfersResponse([
        { type: "transfer", fromClubId: 10, toClubId: 11, completedAt: "2026-02-01T00:00:00.000Z" },
      ]),
    );
    const ok = await fetchTransferRecords(API, 100);
    expect(ok).toEqual({
      kind: "ok",
      records: [
        {
          type: "transfer",
          fromClubId: 10,
          fromClubName: null,
          toClubId: 11,
          toClubName: null,
          completedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
    });

    vi.stubGlobal("fetch", async () => transfersResponse({ message: "nope" }, 404));
    expect(await fetchTransferRecords(API, 100)).toEqual({ kind: "not_found" });

    vi.stubGlobal("fetch", async () => new Response("boom", { status: 503 }));
    await expect(fetchTransferRecords(API, 100)).rejects.toMatchObject({ status: 503 });
  });

  it("形状坏按失败处理（缺 transfers 数组 / clubId 不是整数）", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(fetchTransferRecords(API, 100)).rejects.toThrow("没有 transfers 数组");

    vi.stubGlobal("fetch", async () =>
      transfersResponse([{ type: "transfer", fromClubId: "10", toClubId: 11, completedAt: NOW }]),
    );
    await expect(fetchTransferRecords(API, 100)).rejects.toThrow("fromClubId 不是整数");
  });
});

describe("rebuildPlayerHistory", () => {
  it("转会回放：旧队关窗、新队开窗，写入回填标记", async () => {
    const { sqlite, db } = freshDb();
    stubTransfers([move(10, 11, "2026-02-01T00:00:00.000Z")]);

    const res = await rebuildPlayerHistory(db, 100, { apiBase: API, mode: "backfill", now: NOW });
    expect(res.barrier).toBe(false);
    expect(res.applied).toBe(1);
    expect(windows(sqlite, 100)).toEqual([
      { team_id: 10, joined_at: "2026-01-01T00:00:00.000Z", left_at: "2026-02-01T00:00:00.000Z", source: "transfer" },
      { team_id: 11, joined_at: "2026-02-01T00:00:00.000Z", left_at: null, source: "transfer" },
    ]);
    expect(flag(sqlite)).toBe(NOW);
  });

  it("自由身加盟（from 为空）只开新窗；from == to 不算换队", async () => {
    const { sqlite, db } = freshDb();
    // 先清掉种子窗口，模拟俱乐部平台上的新球员
    sqlite.exec("DELETE FROM player_team_history WHERE player_id = 100");
    stubTransfers([
      move(10, 10, "2026-01-15T00:00:00.000Z", "match"),
      move(null, 11, "2026-02-01T00:00:00.000Z", "free_agent"),
    ]);

    await rebuildPlayerHistory(db, 100, { apiBase: API, mode: "backfill", now: NOW });
    expect(windows(sqlite, 100)).toEqual([
      { team_id: 11, joined_at: "2026-02-01T00:00:00.000Z", left_at: null, source: "transfer" },
    ]);
  });

  it("解约（to 为空）：只关不开，left_at 取解约时间", async () => {
    const { sqlite, db } = freshDb();
    stubTransfers([
      move(10, 11, "2026-02-01T00:00:00.000Z"),
      move(11, null, "2026-03-01T00:00:00.000Z", "termination"),
    ]);

    await rebuildPlayerHistory(db, 100, { apiBase: API, mode: "backfill", now: NOW });
    expect(windows(sqlite, 100)).toEqual([
      { team_id: 10, joined_at: "2026-01-01T00:00:00.000Z", left_at: "2026-02-01T00:00:00.000Z", source: "transfer" },
      { team_id: 11, joined_at: "2026-02-01T00:00:00.000Z", left_at: "2026-03-01T00:00:00.000Z", source: "transfer" },
    ]);
  });

  it("未知俱乐部是屏障：屏障前的记录照常应用，不伪造 team_id", async () => {
    const { sqlite, db } = freshDb();
    stubTransfers([
      move(10, 11, "2026-02-01T00:00:00.000Z"),
      move(11, 999, "2026-03-01T00:00:00.000Z"),
      move(999, 12, "2026-04-01T00:00:00.000Z"),
    ]);

    const res = await rebuildPlayerHistory(db, 100, { apiBase: API, mode: "backfill", now: NOW });
    expect(res.barrier).toBe(true);
    expect(res.applied).toBe(1);
    expect(windows(sqlite, 100)).toEqual([
      { team_id: 10, joined_at: "2026-01-01T00:00:00.000Z", left_at: "2026-02-01T00:00:00.000Z", source: "transfer" },
      { team_id: 11, joined_at: "2026-02-01T00:00:00.000Z", left_at: null, source: "transfer" },
    ]);
  });

  it("observed 优先于回放终态（同步看到他在哪队就是哪队）", async () => {
    const { sqlite, db } = freshDb();
    stubTransfers([move(10, 11, "2026-02-01T00:00:00.000Z")]);

    await rebuildPlayerHistory(db, 100, {
      apiBase: API,
      mode: "sync",
      observed: { teamId: 12, at: "2026-05-01T00:00:00.000Z" },
      now: NOW,
    });
    expect(windows(sqlite, 100).filter((w) => w.left_at === null)).toEqual([
      { team_id: 12, joined_at: "2026-05-01T00:00:00.000Z", left_at: null, source: "sync" },
    ]);
  });

  it("observed 为 null（确认离队）：关光开放窗，离队时间取现在", async () => {
    const { sqlite, db } = freshDb();
    stubTransfers([move(10, 11, "2026-02-01T00:00:00.000Z")]);

    await rebuildPlayerHistory(db, 100, {
      apiBase: API,
      mode: "sync",
      observed: { teamId: null, at: "2026-06-01T00:00:00.000Z" },
      now: NOW,
    });
    expect(windows(sqlite, 100)).toEqual([
      { team_id: 10, joined_at: "2026-01-01T00:00:00.000Z", left_at: "2026-02-01T00:00:00.000Z", source: "transfer" },
      { team_id: 11, joined_at: "2026-02-01T00:00:00.000Z", left_at: NOW, source: "transfer" },
    ]);
  });

  it("404：按无记录处理，保留现有窗口并写标记（不永久阻塞归档）", async () => {
    const { sqlite, db } = freshDb();
    vi.stubGlobal("fetch", async () => transfersResponse({ message: "not found" }, 404));

    await rebuildPlayerHistory(db, 100, { apiBase: API, mode: "backfill", now: NOW });
    expect(windows(sqlite, 100)).toEqual([
      { team_id: 10, joined_at: "2026-01-01T00:00:00.000Z", left_at: null, source: "seed" },
    ]);
    expect(flag(sqlite)).toBe(NOW);
  });

  it("5xx：抛错、窗口与回填标记都不动", async () => {
    const { sqlite, db } = freshDb();
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));

    await expect(
      rebuildPlayerHistory(db, 100, { apiBase: API, mode: "backfill", now: NOW }),
    ).rejects.toMatchObject({ status: 500 });
    expect(windows(sqlite, 100)).toEqual([
      { team_id: 10, joined_at: "2026-01-01T00:00:00.000Z", left_at: null, source: "seed" },
    ]);
    expect(flag(sqlite)).toBeNull();
  });

  it("幂等：同一输入连续重建两次，窗口与时间戳不漂移", async () => {
    const { sqlite, db } = freshDb();
    stubTransfers([
      move(10, 11, "2026-02-01T00:00:00.000Z"),
      move(11, 12, "2026-03-01T00:00:00.000Z"),
    ]);

    await rebuildPlayerHistory(db, 100, { apiBase: API, mode: "backfill", now: NOW });
    const first = windows(sqlite, 100);
    await rebuildPlayerHistory(db, 100, { apiBase: API, mode: "backfill", now: NOW });
    expect(windows(sqlite, 100)).toEqual(first);
  });

  it("连续同队记录合并，不把同一队碎成多条", async () => {
    const { sqlite, db } = freshDb();
    stubTransfers([
      move(10, 11, "2026-02-01T00:00:00.000Z"),
      move(11, 11, "2026-02-15T00:00:00.000Z", "match"),
    ]);

    await rebuildPlayerHistory(db, 100, { apiBase: API, mode: "backfill", now: NOW });
    expect(windows(sqlite, 100)).toEqual([
      { team_id: 10, joined_at: "2026-01-01T00:00:00.000Z", left_at: "2026-02-01T00:00:00.000Z", source: "transfer" },
      { team_id: 11, joined_at: "2026-02-01T00:00:00.000Z", left_at: null, source: "transfer" },
    ]);
  });
});

describe("runHistoryBackfill", () => {
  function envWith(db: D1Database): Bindings {
    return { DB: db, CLUB_API_BASE: API } as unknown as Bindings;
  }

  it("只跑未回填的人，跳过 skip，404 算成功、5xx 算失败", async () => {
    const { sqlite, db } = createTestDb();
    sqlite.exec("INSERT INTO team (id, org_id, name) VALUES (10, 1, '阿森纳')");
    insertPlayerWithWindow(sqlite, { id: 100, teamId: 10, name: "张三" });
    insertPlayerWithWindow(sqlite, { id: 101, teamId: 10, name: "李四" });
    insertPlayerWithWindow(sqlite, { id: 102, teamId: 10, name: "王五" });
    sqlite.exec("UPDATE player SET history_synced_at = '2026-01-01T00:00:00.000Z' WHERE id = 102");

    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/101/")) return new Response("boom", { status: 500 });
      return transfersResponse({ message: "not found" }, 404);
    });

    const out = await runHistoryBackfill(envWith(db), { limit: 40 });
    expect(out).toMatchObject({ attempted: 2, succeeded: 1, failed: 1, skipped: false });
    expect(flag(sqlite, 100)).not.toBeNull();
    expect(flag(sqlite, 101)).toBeNull();

    // skip 掉 100 后没有可跑的人
    sqlite.exec("UPDATE player SET history_synced_at = NULL WHERE id = 100");
    vi.stubGlobal("fetch", async () => transfersResponse({ message: "not found" }, 404));
    const out2 = await runHistoryBackfill(envWith(db), { skip: new Set([100]) });
    expect(out2.attempted).toBe(1);
  });

  it("没配 CLUB_API_BASE 整轮跳过", async () => {
    const { db } = createTestDb();
    const out = await runHistoryBackfill({ DB: db } as unknown as Bindings);
    expect(out).toMatchObject({ attempted: 0, skipped: true });
  });
});
