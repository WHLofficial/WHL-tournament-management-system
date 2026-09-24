// 周报回退（增量 40）：原来是「本周空则逐周串行试，最多 8 次往返」，
// 现在改成「一次探针定周 + 一次取数」。这里钉回退语义与 8 周边界都逐字不变。
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, createTestD1 } from "./d1";
import { buildWeekly } from "../worker/lib/feedNews";

const WEEK_MS = 7 * 24 * 3600 * 1000;

function mondayUTC(d: Date): Date {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); // 周一=0
  return t;
}

const nowMonday = mondayUTC(new Date());
/** 第 i 周（i=0 是本周）内的一个时刻 */
const inWeek = (i: number): string => new Date(nowMonday.getTime() - i * WEEK_MS + 10 * 3600 * 1000).toISOString();
/** 本周内的「刚刚完赛」——取运行时刻，避免周一凌晨时 inWeek(0) 落在未来 */
const justNow = (): string => new Date().toISOString();

/** 只有一场完赛比赛，落在第 weekOffset 周；不建时（weekOffset=null）只留 pending 场 */
function freshDb(weekOffset: number | null) {
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
  if (weekOffset !== null) {
    const at = weekOffset === 0 ? justNow() : inWeek(weekOffset);
    sqlite
      .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, score_home, score_away, status, finished_at) VALUES (800, 70, 1, 1, 500, 501, 3, 1, 'finished', ?)")
      .run(at);
  }
  return createTestD1(sqlite);
}

describe("周报回退（增量 40：探针定周）", () => {
  it("本周有比赛：不回退，weekStart 是本周一", async () => {
    const wk = await buildWeekly(freshDb(0));
    expect(wk.isFallback).toBe(false);
    expect(wk.played).toBe(1);
    expect(wk.weekStart).toBe(new Date(nowMonday).toISOString().slice(0, 10));
  });

  it("本周空、上周有比赛：回退到上周", async () => {
    const wk = await buildWeekly(freshDb(1));
    expect(wk.isFallback).toBe(true);
    expect(wk.played).toBe(1);
    expect(wk.weekStart).toBe(new Date(nowMonday.getTime() - WEEK_MS).toISOString().slice(0, 10));
  });

  it("边界：第 8 周仍有比赛要回退到它（窗口含左端）", async () => {
    const wk = await buildWeekly(freshDb(8));
    expect(wk.isFallback).toBe(true);
    expect(wk.played).toBe(1);
    expect(wk.weekStart).toBe(new Date(nowMonday.getTime() - 8 * WEEK_MS).toISOString().slice(0, 10));
  });

  it("边界：只有第 9 周有比赛则超出回退范围，保持本周空态", async () => {
    const wk = await buildWeekly(freshDb(9));
    expect(wk.isFallback).toBe(false);
    expect(wk.played).toBe(0);
    expect(wk.weekStart).toBe(new Date(nowMonday).toISOString().slice(0, 10));
  });

  it("没有任何完赛比赛：保持本周空态（不因探针未命中而误标回退）", async () => {
    const wk = await buildWeekly(freshDb(null));
    expect(wk.isFallback).toBe(false);
    expect(wk.played).toBe(0);
    expect(wk.matches).toEqual([]);
  });

  it("指定周不参与回退：空周就是空态", async () => {
    const db = freshDb(1);
    const wk = await buildWeekly(db, new Date(nowMonday).toISOString().slice(0, 10));
    expect(wk.isFallback).toBe(false);
    expect(wk.played).toBe(0);
  });
});
