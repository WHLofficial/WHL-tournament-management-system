// 公开端首页聚合端点 /api/public/home（v5.0.2）：
// 把首页原来 6 个请求（tournaments / upcoming / live / announcement / feed / reactions）
// 里的 5 个合成一次往返，live 仍单独走 60s（见 worker/routes/portal.ts 的反例注释）。
// 这里钉的是聚合本身没改变任何一段的口径：段名齐、草稿赛事不漏、只回 active 公告、
// reactions 只覆盖 feed 里出现过的 id、空数据不炸、limit 透传。
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { applyMigrations, createTestD1, createTestKV } from "./d1";

// /home 挂了 pubCache(300)：match 恒回 undefined ⇒ 每次都是冷路径，断言的是真实查询结果。
(globalThis as unknown as { caches: unknown }).caches = {
  default: { match: async () => undefined, put: async () => {} },
};
const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} };
const pub = (env: Record<string, unknown>, path: string) =>
  app.request(path, {}, env, execCtx as never);

type Home = {
  tournaments: { id: number; name: string }[];
  upcoming: { matchId: number }[];
  announcement: { id: number; title: string } | null;
  feed: { id: string; kind: string }[];
  reactions: Record<string, Record<string, number>>;
};

function makeEnv(sqlite: DatabaseSync) {
  const env: Record<string, unknown> = {
    DB: createTestD1(sqlite),
    KV: createTestKV(new Map()) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
  };
  return env;
}

function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  sqlite
    .prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(1, "管理员", "", "x", "admin", 0, 0);

  const iso = "2026-01-01T00:00:00Z";
  for (const [id, name] of [[10, "红队"], [11, "蓝队"]] as const) {
    sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (?, 1, ?, ?)").run(id, name, iso);
  }
  // 一届在打（7）、一届草稿（8）——草稿赛事任何一段都不该出现
  for (const [id, name, status, created] of [
    [7, "联赛", "running", "2026-01-01T00:00:00Z"],
    [8, "筹备中", "draft", "2026-03-01T00:00:00Z"],
  ] as const) {
    sqlite
      .prepare("INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (?, 1, ?, 'round_robin', ?, 1, ?)")
      .run(id, name, status, created);
  }
  for (const [id, tid] of [[70, 7], [80, 8]] as const) {
    sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order, name) VALUES (?, ?, 'round_robin', 1, '小组赛')").run(id, tid);
  }
  for (const [id, tid, team, seed] of [[500, 7, 10, 1], [501, 7, 11, 2], [700, 8, 10, 1], [701, 8, 11, 2]] as const) {
    sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (?, ?, ?, ?)").run(id, tid, team, seed);
  }
  sqlite
    .prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, score_home, score_away, status, finished_at) VALUES (800, 70, 1, 1, 500, 501, 3, 1, 'finished', '2026-03-01T10:00:00Z')")
    .run();
  sqlite.prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status) VALUES (801, 70, 2, 1, 501, 500, 'pending')").run();
  sqlite.prepare("INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status) VALUES (805, 80, 1, 1, 700, 701, 'pending')").run();

  // 两条公告：只有 active=1 的那条该被返回
  const ann = sqlite.prepare(
    "INSERT INTO announcement (id, title, body, active, created_by, created_at, updated_at) VALUES (?, ?, '正文', ?, 1, ?, ?)",
  );
  ann.run(1, "旧公告", 0, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  ann.run(2, "新公告", 1, "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z");

  return { env: makeEnv(sqlite), sqlite };
}

describe("公开端首页聚合 /api/public/home", () => {
  it("五段齐备，且各段口径与拆开的端点一致", async () => {
    const { env } = freshEnv();
    const res = await pub(env, "/api/public/home?limit=16");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Home;

    expect(Object.keys(body).sort()).toEqual([
      "announcement",
      "feed",
      "reactions",
      "tournaments",
      "upcoming",
    ]);
    expect(body.tournaments.map((t) => t.id)).toEqual([7]); // 草稿赛事 8 不出现
    expect(body.upcoming.map((u) => u.matchId)).toEqual([801]); // 草稿赛事的 805 不出现
    expect(body.announcement).toMatchObject({ id: 2, title: "新公告" });
    expect(body.feed.map((i) => i.id)).toContain("match:800");
    expect(body.reactions).toEqual({});
  });

  it("reactions 只覆盖 feed 里出现过的 id，其它 id 被忽略", async () => {
    const { env, sqlite } = freshEnv();
    const first = await pub(env, "/api/public/home?limit=16");
    const { feed } = (await first.json()) as Home;
    expect(feed.length).toBeGreaterThan(0);
    const itemId = feed[0].id;

    sqlite.prepare("INSERT INTO reaction (item_id, emoji, cnt) VALUES (?, 'fire', 3)").run(itemId);
    // 不在这份 feed 里的 id：不该被算进来（否则会随 feed 窗口变化泄漏别的条目计数）
    sqlite.prepare("INSERT INTO reaction (item_id, emoji, cnt) VALUES (?, 'cry', 7)").run("match:999999");

    const res = await pub(env, "/api/public/home?limit=16");
    const body = (await res.json()) as Home;
    expect(body.reactions[itemId]).toEqual({ fire: 3 });
    expect(Object.keys(body.reactions)).toEqual([itemId]);
  });

  it("limit 透传给 feed（首页真实形状是 limit=16）", async () => {
    const { env } = freshEnv();
    const res = await pub(env, "/api/public/home?limit=1");
    const body = (await res.json()) as Home;
    expect(body.feed.length).toBeLessThanOrEqual(1);
  });

  it("库里什么都没有时也不炸：空数组 / null / 空对象", async () => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(sqlite);
    sqlite
      .prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(1, "管理员", "", "x", "admin", 0, 0);

    const res = await pub(makeEnv(sqlite), "/api/public/home");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Home;
    expect(body.tournaments).toEqual([]);
    expect(body.upcoming).toEqual([]);
    expect(body.announcement).toBeNull();
    expect(body.feed).toEqual([]);
    expect(body.reactions).toEqual({});
  });
});
