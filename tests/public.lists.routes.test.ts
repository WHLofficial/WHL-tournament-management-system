import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { applyMigrations, createTestD1, createTestKV } from "./d1";

// 公开端列表路由（/upcoming 与 /tournaments/:id/matches/summary）挂了 pubCache，
// 测试环境补最小桩；match 恒回 undefined ⇒ 每次都是冷路径，断言的是真实查询结果。
(globalThis as unknown as { caches: unknown }).caches = {
  default: { match: async () => undefined, put: async () => {} },
};
const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} };
const pub = (env: Record<string, unknown>, path: string) =>
  app.request(path, {}, env, execCtx as never);

type Upcoming = {
  tournamentId: number; tournamentName: string; matchId: number;
  stageKind: string; stageOrder: number; round: number;
  homeTeamName: string; awayTeamName: string;
};
type PubMatch = {
  id: number; stageId: number; round: number;
  homeEntryId: number | null; awayEntryId: number | null;
  homeTeamName: string | null; awayTeamName: string | null;
  status: string; scoreHome: number | null; scoreAway: number | null;
  note: string | null;
};

// 三队、三届赛事（两届 running、一届 draft）、八场球，覆盖待打列表的每一条排除条件。
function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  sqlite
    .prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(1, "管理员", "", "x", "admin", 0, 0);

  const iso = "2026-01-01T00:00:00Z";
  for (const [id, name] of [[10, "红队"], [11, "蓝队"], [12, "黄队"]] as const) {
    sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (?, 1, ?, ?)").run(id, name, iso);
  }
  for (const [id, name, status, created] of [
    [7, "联赛", "running", "2026-01-01T00:00:00Z"],
    [9, "冠军杯", "running", "2026-02-01T00:00:00Z"],
    [8, "筹备中", "draft", "2026-03-01T00:00:00Z"],
  ] as const) {
    sqlite
      .prepare("INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (?, 1, ?, 'round_robin', ?, 1, ?)")
      .run(id, name, status, created);
  }
  for (const [id, tid] of [[70, 7], [90, 9], [80, 8]] as const) {
    sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order, name) VALUES (?, ?, 'round_robin', 1, '小组赛')").run(id, tid);
  }
  for (const [id, tid, team, seed] of [
    [500, 7, 10, 1], [501, 7, 11, 2],
    [600, 9, 10, 1], [601, 9, 12, 2],
    [700, 8, 10, 1], [701, 8, 11, 2],
  ] as const) {
    sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (?, ?, ?, ?)").run(id, tid, team, seed);
  }

  const pending = (id: number, stage: number, round: number, slot: number, home: number | null, away: number | null, note: string | null = null) =>
    sqlite
      .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status, note) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)")
      .run(id, stage, round, slot, home, away, note);
  const finished = (id: number, stage: number, round: number, slot: number, home: number, away: number, sh: number, sa: number, at: string) =>
    sqlite
      .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, score_home, score_away, status, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'finished', ?)")
      .run(id, stage, round, slot, home, away, sh, sa, at);

  // 联赛 7：两场已完赛（summary 的 recent 用）、一场正常待打、三类应被排除的待打场
  finished(800, 70, 1, 1, 500, 501, 3, 1, "2026-03-01T10:00:00Z");
  finished(808, 70, 6, 1, 501, 500, 0, 3, "2026-04-01T10:00:00Z");
  pending(801, 70, 2, 1, 501, 500);
  // 真实轮空场的形状：对手位是虚拟种子 ⇒ away_entry_id 为空，靠 IS NOT NULL 排除
  pending(802, 70, 3, 1, 500, null, "轮空");
  // 轮空但两侧都有 entry 的边界形状：只有显式的 note 判断能排除它
  pending(803, 70, 3, 2, 501, 500, "轮空");
  // 队伍待定（对手未决出）
  pending(806, 70, 4, 1, 500, null);
  // 已开打：不是待打
  sqlite
    .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status) VALUES (807, 70, 5, 1, 500, 501, 'live')")
    .run();
  // 冠军杯 9：待打一场（两届都是 running ⇒ 按 t.id 排在联赛之后）
  pending(804, 90, 1, 1, 600, 601);
  // 筹备中赛事 8：待打也不该出现
  pending(805, 80, 1, 1, 700, 701);

  const env: Record<string, unknown> = {
    DB: createTestD1(sqlite),
    KV: createTestKV(new Map()) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
  };
  return { env, sqlite };
}

describe("公开端待打列表", () => {
  it("/upcoming 只回非草稿赛事的正常待打场次，running 优先，且队名由第二段补齐", async () => {
    const { env } = freshEnv();
    const res = await pub(env, "/api/public/upcoming");
    expect(res.status).toBe(200);
    const { upcoming } = (await res.json()) as { upcoming: Upcoming[] };

    expect(upcoming.map((u) => u.matchId)).toEqual([801, 804]);
    expect(upcoming[0]).toMatchObject({
      tournamentId: 7,
      tournamentName: "联赛",
      stageKind: "round_robin",
      round: 2,
      homeTeamName: "蓝队",
      awayTeamName: "红队",
    });
    expect(upcoming[1]).toMatchObject({
      tournamentId: 9,
      tournamentName: "冠军杯",
      homeTeamName: "红队",
      awayTeamName: "黄队",
    });
    // 排除项逐条点名，失败时能直接看出是哪一条漏了
    const ids = upcoming.map((u) => u.matchId);
    expect(ids).not.toContain(802); // 轮空（对手位为空）
    expect(ids).not.toContain(803); // 轮空（两侧都有 entry，靠 note 排除）
    expect(ids).not.toContain(805); // 草稿赛事
    expect(ids).not.toContain(806); // 队伍待定
    expect(ids).not.toContain(807); // 已开打
    expect(ids).not.toContain(800); // 已完赛
    expect(ids).not.toContain(808);
  });
});

describe("公开端赛事摘要", () => {
  it("/tournaments/:id/matches/summary 的 recent 按完赛时间倒序，upcoming 沿用既有口径", async () => {
    const { env } = freshEnv();
    const res = await pub(env, "/api/public/tournaments/7/matches/summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recent: PubMatch[]; upcoming: PubMatch[] };

    expect(body.recent.map((m) => m.id)).toEqual([808, 800]);
    expect(body.recent[0]).toMatchObject({ homeTeamName: "蓝队", awayTeamName: "红队", scoreHome: 0, scoreAway: 3 });

    // 这条路由的历史口径只按「队伍待定」排除（home/away_entry_id IS NOT NULL），
    // 没有像 /upcoming、feed、教练端那样显式判断 note='轮空'。本次改写保持输出等价，
    // 所以两侧都有 entry 的轮空场 803 仍会出现；真实轮空场（对手位为空，如 802）本来就排除。
    expect(body.upcoming.map((m) => m.id)).toEqual([801, 803]);
    expect(body.upcoming[0]).toMatchObject({ homeTeamName: "蓝队", awayTeamName: "红队", status: "pending" });
    expect(body.upcoming.map((m) => m.id)).not.toContain(806); // 队伍待定
  });

  it("草稿赛事与不存在的赛事都回 404", async () => {
    const { env } = freshEnv();
    const draft = await pub(env, "/api/public/tournaments/8/matches/summary");
    expect(draft.status).toBe(404);
    const missing = await pub(env, "/api/public/tournaments/999/matches/summary");
    expect(missing.status).toBe(404);
  });
});
