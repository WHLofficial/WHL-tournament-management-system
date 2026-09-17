// 教练端伤停/停赛概览路由测试：兼容模式会话驱动真实 app（AUTH_DB 手建绑定关系）。
// 钉死：停赛按赛事口径（切赛事重算）、伤停跨赛事不随赛事变、只回本队球员、
// 草稿赛事不进列表也不当默认、未绑队回空结构、字段形状（防 D1 蛇形列名静默 undefined）。
import { beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { hashPassword } from "../worker/lib/crypto";
import { applyMigrations, createTestD1, createTestKV } from "./d1";

let userHash = "";

// 认证中心的极简镜像：boundTeamId / teamMembers 只跑裸 SQL（worker/lib/authClient.ts:89-97）
function authDb(bindTourTeamId: number | null): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    `CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
     CREATE TABLE team (id INTEGER PRIMARY KEY, name TEXT NOT NULL, tour_team_id INTEGER);
     CREATE TABLE team_binding (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, team_id INTEGER NOT NULL, bound_at TEXT NOT NULL);`,
  );
  sqlite.prepare("INSERT INTO account (id, name) VALUES (1, '教练甲')").run();
  sqlite.prepare("INSERT INTO team (id, name, tour_team_id) VALUES (1, '红队', ?)").run(bindTourTeamId);
  if (bindTourTeamId != null) {
    sqlite
      .prepare("INSERT INTO team_binding (id, account_id, team_id, bound_at) VALUES (1, 1, 1, '2026-01-01T00:00:00Z')")
      .run();
  }
  return createTestD1(sqlite);
}

// bind=null 表示「账号没绑队」；noAuthDb=true 表示整个认证中心没配（AUTH_DB 不存在）
function freshEnv(opts: { bind?: number | null; noAuthDb?: boolean } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  sqlite
    .prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(1, "教练甲", "", userHash, "coach", 0, 0);
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (10, 1, '红队', '2026-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (11, 1, '蓝队', '2026-01-01T00:00:00Z')").run();
  for (const [pid, tid, name] of [
    [100, 10, "张三"],
    [101, 10, "李四"],
    [103, 10, "赵六"],
    [102, 11, "王五"],
  ] as const) {
    sqlite.prepare("INSERT INTO player (id, team_id, name) VALUES (?, ?, ?)").run(pid, tid, name);
  }
  // 联赛 7（在打，有已完赛可消耗停赛）、冠军杯 9（更新 → 默认赛事）、草稿 8（不该出现）
  const t = sqlite.prepare(
    "INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (?, 1, ?, 'round_robin', ?, 1, ?)",
  );
  t.run(7, "联赛", "running", "2026-01-01T00:00:00Z");
  t.run(9, "冠军杯", "running", "2026-02-01T00:00:00Z");
  t.run(8, "筹备中的杯赛", "draft", "2026-03-01T00:00:00Z");
  const s = sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (?, ?, 'round_robin', 1)");
  s.run(70, 7);
  s.run(90, 9);
  s.run(80, 8);
  const e = sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (?, ?, ?, ?)");
  e.run(500, 7, 10, 1);
  e.run(501, 7, 11, 2);
  e.run(600, 9, 10, 1);
  e.run(700, 8, 10, 1);
  // 联赛：第 1、2 轮已完赛，第 3 轮待开；冠军杯：第 1 轮已完赛，第 2 轮待开；草稿赛事有场待开
  const m = sqlite.prepare(
    "INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, status, finished_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)",
  );
  m.run(800, 70, 1, 500, 501, "finished", "2026-01-10T10:00:00Z");
  m.run(801, 70, 2, 501, 500, "finished", "2026-01-17T10:00:00Z");
  m.run(802, 70, 3, 500, 501, "pending", null);
  m.run(810, 90, 1, 600, null, "finished", "2026-02-10T10:00:00Z");
  m.run(811, 90, 2, 600, null, "pending", null);
  m.run(820, 80, 1, 700, null, "pending", null);
  const ev = sqlite.prepare(
    "INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, created_by) VALUES (?, ?, ?, ?, ?, 20, 1)",
  );
  ev.run(900, 800, 500, 100, "red"); // 张三直红 → 停 2 场（联赛内第 2 轮已消耗 1）
  ev.run(901, 800, 500, 101, "yellow"); // 李四第 1 黄
  ev.run(902, 801, 501, 101, "yellow"); // 李四第 2 黄 → 临界（阈值 3）
  ev.run(903, 800, 501, 102, "red"); // 王五直红（蓝队，须被过滤掉）
  ev.run(910, 800, 500, 103, "injury_minor"); // 赵六受伤（下面挂伤停登记）
  ev.run(920, 810, 600, 100, "red"); // 张三在冠军杯也直红（跨赛事各算各的）
  // 伤停登记：赵六缺阵联赛第 3 轮（该场待开 → 伤停中；跨赛事跟着人走）
  sqlite
    .prepare("INSERT INTO injury (id, team_id, player_id, event_id, injury_name) VALUES (1, 10, 103, 910, '膝内侧副韧带')")
    .run();
  sqlite.prepare("INSERT INTO injury_miss (id, injury_id, match_id) VALUES (1, 1, 802)").run();

  const kv = new Map<string, string>([["sess:tok-coach", JSON.stringify({ userId: 1 })]]);
  const env: Record<string, unknown> = {
    DB: createTestD1(sqlite),
    KV: createTestKV(kv) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
  };
  if (!opts.noAuthDb) env.AUTH_DB = authDb(opts.bind === undefined ? 10 : opts.bind);
  return { env, sqlite };
}

const getStatus = (env: Record<string, unknown>, qs = "") =>
  app.request(`/api/coach/me/status${qs}`, { headers: { Cookie: "whl_session=tok-coach" } }, env);

type StatusBody = {
  tournaments: { tournamentId: number; name: string; default: boolean }[];
  tournamentId: number | null;
  yellowThreshold: number;
  players: { playerId: number; playerName: string; remaining: number; yellows: number }[];
  injuries: {
    playerId: number;
    playerName: string;
    injuryName: string | null;
    recoverPercent: number;
    misses: { matchId: number; status: string }[];
  }[];
};

beforeAll(async () => {
  userHash = await hashPassword("TestPass123");
});

describe("教练端伤停/停赛概览", () => {
  it("未绑队 / 没有认证库：回空结构且不报错", async () => {
    for (const env of [freshEnv({ noAuthDb: true }).env, freshEnv({ bind: null }).env]) {
      const res = await getStatus(env);
      expect(res.status).toBe(200);
      const b = (await res.json()) as StatusBody;
      expect(b.tournaments).toEqual([]);
      expect(b.tournamentId).toBeNull();
      expect(b.yellowThreshold).toBe(0);
      expect(b.players).toEqual([]);
      expect(b.injuries).toEqual([]);
    }
  });

  it("默认赛事 = 最近一场待开比赛所在赛事；停赛按该赛事算，伤停跨赛事仍列出", async () => {
    const { env } = freshEnv();
    const b = (await (await getStatus(env)).json()) as StatusBody;
    // 赛事列表：按 created_at DESC（冠军杯更新在前）；草稿赛事不出现
    expect(b.tournaments).toEqual([
      { tournamentId: 9, name: "冠军杯", default: true },
      { tournamentId: 7, name: "联赛", default: false },
    ]);
    // 待开比赛里冠军杯是最近的（同 t.created_at DESC 口径），默认落到它
    expect(b.tournamentId).toBe(9);
    expect(b.yellowThreshold).toBe(3);
    // 张三在冠军杯第 1 轮直红 → 停 2 场（第 2 轮待开不消耗）
    expect(b.players.map((p) => [p.playerId, p.playerName, p.remaining, p.yellows])).toEqual([
      [100, "张三", 2, 0],
    ]);
    // 字段形状：D1 蛇形列名漏转驼峰会静默 undefined，这里钉死
    for (const p of b.players) {
      expect(Number.isInteger(p.playerId)).toBe(true);
      expect(typeof p.playerName).toBe("string");
      expect(Number.isInteger(p.remaining)).toBe(true);
      expect(Number.isInteger(p.yellows)).toBe(true);
    }
    // 伤停跨赛事：赵六的缺阵在联赛，但默认赛事是冠军杯，照样在列（剩 1 场、未恢复）
    expect(b.injuries.map((i) => [i.playerId, i.playerName, i.injuryName, i.recoverPercent])).toEqual([
      [103, "赵六", "膝内侧副韧带", 0],
    ]);
    expect(b.injuries[0].misses.map((m) => [m.matchId, m.status])).toEqual([[802, "pending"]]);
  });

  it("指定 tournamentId 切赛事：停赛场数按该赛事重算，伤停不变", async () => {
    const { env } = freshEnv();
    const b = (await (await getStatus(env, "?tournamentId=7")).json()) as StatusBody;
    expect(b.tournamentId).toBe(7);
    // 张三：联赛第 1 轮直红 → 停 2 场，第 2 轮（已完赛）消耗 1 → 剩 1；李四 2 黄 → 阈值 3 未停赛，临界
    expect(b.players.map((p) => [p.playerId, p.playerName, p.remaining, p.yellows])).toEqual([
      [100, "张三", 1, 0],
      [101, "李四", 0, 2],
    ]);
    // 蓝队王五的红牌不进本队名单
    expect(b.players.some((p) => p.playerId === 102)).toBe(false);
    // 伤停与赛事无关
    expect(b.injuries.length).toBe(1);
    expect(b.tournaments.filter((t) => t.default).map((t) => t.tournamentId)).toEqual([9]);
  });

  it("tournamentId 不属于本队（草稿赛事 / 不存在）：静默回落默认赛事", async () => {
    const { env } = freshEnv();
    for (const qs of ["?tournamentId=8", "?tournamentId=999", "?tournamentId=abc"]) {
      const b = (await (await getStatus(env, qs)).json()) as StatusBody;
      expect(b.tournamentId).toBe(9);
      expect(b.players.map((p) => p.playerId)).toEqual([100]);
    }
  });

  it("绑定到别队：只看该队的人（赛事列表也跟着变）", async () => {
    const { env } = freshEnv({ bind: 11 });
    const b = (await (await getStatus(env)).json()) as StatusBody;
    // 蓝队只报名了联赛 → 默认赛事就是联赛（没有别的赛事待开）
    expect(b.tournaments).toEqual([{ tournamentId: 7, name: "联赛", default: true }]);
    expect(b.tournamentId).toBe(7);
    expect(b.players.map((p) => [p.playerId, p.playerName, p.remaining, p.yellows])).toEqual([
      [102, "王五", 1, 0],
    ]);
    // 伤停登记属于红队，蓝队看不到
    expect(b.injuries).toEqual([]);
  });
});
