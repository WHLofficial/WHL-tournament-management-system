// 周报回退（v5.0.3）：原来是「本周空则逐周串行试，最多 8 次往返」，
// 现在改成「一次探针定周 + 一次取数」。这里钉回退语义与 8 周边界都逐字不变。
// 周界口径改为上海周一（UTC+8）：窗口起点 =（上海周一日期的前一天）T16:00:00Z。
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, createTestD1 } from "./d1";
import { buildWeekly } from "../worker/lib/feedNews";

const TZ_MS = 8 * 3600_000;
const WEEK_MS = 7 * 24 * 3600 * 1000;

/** 测试侧独立实现的上海周一（不与被测代码共享实现）：时刻 +8h 取日历日，再退到周一 */
function shanghaiMondayOf(ms: number): string {
  const t = new Date(ms + TZ_MS);
  t.setUTCHours(0, 0, 0, 0);
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
}

const addDays = (dateStr: string, n: number): string => {
  const t = new Date(`${dateStr}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

/** 上海某日历日 00:00 对应的 UTC 时刻 */
const shanghaiMidnight = (dateStr: string): number => new Date(`${dateStr}T00:00:00Z`).getTime() - TZ_MS;

const nowMonday = shanghaiMondayOf(Date.now());
/** 第 i 周（i=0 是本周）内上海周一上午 10 点 */
const inWeek = (i: number): string => new Date(shanghaiMidnight(addDays(nowMonday, -7 * i)) + 10 * 3600_000).toISOString();
/** 本周内的「刚刚完赛」——取运行时刻，避免周一凌晨时 inWeek(0) 落在未来 */
const justNow = (): string => new Date().toISOString();

/** 只有一场完赛比赛，完赛时刻为 at（null 则只留 pending 场） */
function freshDb(at: string | null) {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const iso = "2026-01-01T00:00:00Z";
  sqlite.prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (1, '管理员', '', 'x', 'admin', 0, 0)").run();
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (10, 1, '红队', ?)").run(iso);
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (11, 1, '蓝队', ?)").run(iso);
  sqlite
    .prepare("INSERT INTO tournament (id, org_id, name, format, status, created_by) VALUES (7, 1, '联赛', 'round_robin', 'running', 1)")
    .run();
  sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (70, 7, 'round_robin', 1)").run();
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (500, 7, 10, 1)").run();
  sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (501, 7, 11, 2)").run();
  sqlite
    .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status) VALUES (801, 70, 2, 1, 501, 500, 'pending')")
    .run();
  if (at !== null) {
    sqlite
      .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, score_home, score_away, status, finished_at) VALUES (800, 70, 1, 1, 500, 501, 3, 1, 'finished', ?)")
      .run(at);
  }
  return createTestD1(sqlite);
}

describe("周报回退（v5.0.3：探针定周；周界上海口径）", () => {
  it("本周有比赛：不回退，weekStart 是本周一", async () => {
    const wk = await buildWeekly(freshDb(justNow()));
    expect(wk.isFallback).toBe(false);
    expect(wk.played).toBe(1);
    expect(wk.weekStart).toBe(nowMonday);
  });

  it("本周空、上周有比赛：回退到上周", async () => {
    const wk = await buildWeekly(freshDb(inWeek(1)));
    expect(wk.isFallback).toBe(true);
    expect(wk.played).toBe(1);
    expect(wk.weekStart).toBe(addDays(nowMonday, -7));
  });

  it("边界：第 8 周仍有比赛要回退到它（窗口含左端）", async () => {
    const wk = await buildWeekly(freshDb(inWeek(8)));
    expect(wk.isFallback).toBe(true);
    expect(wk.played).toBe(1);
    expect(wk.weekStart).toBe(addDays(nowMonday, -56));
  });

  it("边界：只有第 9 周有比赛则超出回退范围，保持本周空态", async () => {
    const wk = await buildWeekly(freshDb(inWeek(9)));
    expect(wk.isFallback).toBe(false);
    expect(wk.played).toBe(0);
    expect(wk.weekStart).toBe(nowMonday);
  });

  it("没有任何完赛比赛：保持本周空态（不因探针未命中而误标回退）", async () => {
    const wk = await buildWeekly(freshDb(null));
    expect(wk.isFallback).toBe(false);
    expect(wk.played).toBe(0);
    expect(wk.matches).toEqual([]);
  });

  it("指定周不参与回退：空周就是空态", async () => {
    const db = freshDb(inWeek(1));
    const wk = await buildWeekly(db, nowMonday);
    expect(wk.isFallback).toBe(false);
    expect(wk.played).toBe(0);
  });

  it("指定周：周中任意一天都归到同一上海周（旧链接里的周一日期依旧有效）", async () => {
    const db = freshDb(justNow());
    const wk = await buildWeekly(db, addDays(nowMonday, 3));
    expect(wk.isFallback).toBe(false);
    expect(wk.played).toBe(1);
    expect(wk.weekStart).toBe(nowMonday);
  });
});

describe("上海周界（冻结时钟钉住 8 小时位移）", () => {
  afterEach(() => vi.useRealTimers());
  const freeze = (iso: string): void => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
  };

  it("now=2026-10-04T15:59:59Z（上海周日 23:59:59）：本周仍是 2026-09-28", async () => {
    freeze("2026-10-04T15:59:59Z");
    const wk = await buildWeekly(freshDb(null));
    expect(wk.weekStart).toBe("2026-09-28");
    expect(wk.isFallback).toBe(false);
    expect(wk.played).toBe(0);
  });

  it("now=2026-10-04T16:00:00Z（上海周一 00:00:00）：本周翻到 2026-10-05（旧 UTC 口径仍是 09-28）", async () => {
    freeze("2026-10-04T16:00:00Z");
    const wk = await buildWeekly(freshDb(null));
    expect(wk.weekStart).toBe("2026-10-05");
    expect(wk.isFallback).toBe(false);
  });

  it("上海周一凌晨完赛（UTC 周日 20:00）算新一周的比赛，不再落进旧 UTC 周", async () => {
    freeze("2026-10-06T00:00:00Z"); // 上海周二 08:00
    const wk = await buildWeekly(freshDb("2026-10-04T20:00:00Z")); // 上海周一 04:00
    expect(wk.weekStart).toBe("2026-10-05");
    expect(wk.isFallback).toBe(false);
    expect(wk.played).toBe(1);
  });
});
