// 业务日历日改上海口径（UTC 时刻 +8h 取日期）：钉住原 UTC 口径的跨日边界。
// 2026-10-03T15:59:59Z 与 16:00:00Z 在旧实现里同为 10 月 3 日，新口径分属两日（上海 23:59:59 / 次日 00:00:00）。
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { applyMigrations, createTestD1 } from "./d1";
import { cnDate } from "../worker/lib/context";
import { shanghaiDateOf, shanghaiDateStr } from "../worker/lib/time";

describe("上海日历日（UTC+8）", () => {
  it("shanghaiDateStr：15:59:59Z 仍是当日，16:00:00Z 跨到次日", () => {
    expect(shanghaiDateStr(new Date("2026-10-03T15:59:59Z").getTime())).toBe("2026-10-03");
    expect(shanghaiDateStr(new Date("2026-10-03T16:00:00Z").getTime())).toBe("2026-10-04");
  });

  it("cnDate：上海日历日的「M 月 D 日」（旧实现两者同日，这就是要钉住的边界）", () => {
    expect(cnDate("2026-10-03T15:59:59Z")).toBe("10 月 3 日");
    expect(cnDate("2026-10-03T16:00:00Z")).toBe("10 月 4 日");
  });

  it("cnDate：null / 空串 / 非法输入回退空串（保持既有行为）", () => {
    expect(cnDate(null)).toBe("");
    expect(cnDate("")).toBe("");
    expect(cnDate("not-a-date")).toBe("");
  });

  it("dateLabel（shanghaiDateOf）：同样各验一侧，输出仍是 YYYY-MM-DD", () => {
    expect(shanghaiDateOf("2026-10-03T15:59:59Z")).toBe("2026-10-03");
    expect(shanghaiDateOf("2026-10-03T16:00:00Z")).toBe("2026-10-04");
  });

  it("dateLabel：null / 空串 / 非法输入回退空串", () => {
    expect(shanghaiDateOf(null)).toBe("");
    expect(shanghaiDateOf("")).toBe("");
    expect(shanghaiDateOf("not-a-date")).toBe("");
  });
});

// ---------- 路由级：HTT 交手日期标签（public.ts 的 dateLabel 消费点） ----------

(globalThis as unknown as { caches: unknown }).caches = {
  default: { match: async () => undefined, put: async () => {} },
};
const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

// 一场已完赛交锋（800）+ 一场待打场次（801，即请求的这场）：h2h 返回的交手列表只含 800
function freshDb() {
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
    .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, score_home, score_away, status, finished_at) VALUES (800, 70, 1, 1, 500, 501, 3, 1, 'finished', ?)")
    .run("2026-10-03T15:59:59Z");
  sqlite
    .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status) VALUES (801, 70, 2, 1, 501, 500, 'pending')")
    .run();
  return { sqlite, env: { DB: createTestD1(sqlite) } };
}

type H2HBody = { meetings: { dateLabel: string }[] };

describe("HTT 交手 dateLabel：上海日历日", () => {
  it("15:59:59Z → 当日；16:00:00Z → 次日（旧实现两者同为 10-03）", async () => {
    const { sqlite, env } = freshDb();
    const get = async (): Promise<string> => {
      const res = await app.request("/api/public/tournaments/7/matches/801/h2h", {}, env, execCtx as never);
      expect(res.status).toBe(200);
      const body = (await res.json()) as H2HBody;
      expect(body.meetings).toHaveLength(1);
      return body.meetings[0].dateLabel;
    };
    expect(await get()).toBe("2026-10-03");
    sqlite.prepare("UPDATE match SET finished_at = ? WHERE id = 800").run("2026-10-03T16:00:00Z");
    expect(await get()).toBe("2026-10-04");
  });
});
