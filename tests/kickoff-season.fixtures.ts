// 赛季级排期测试共用的 SQLite / env 夹具。
// 引擎测试（tests/kickoff-season.test.ts）与接口测试（tests/kickoff-season.routes.test.ts）共用，
// 避免把 8 队整季夹具复制两份。
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { poolRows } from "../worker/lib/kickoffCalendar";
import { applyMigrations, createTestD1, createTestKV } from "./d1";

export const iso = "2026-01-01T00:00:00Z";

/** S1 小夹具：4 队 + 2 个联赛窗口 + 4 场（3 场已排、1 场未排）+ 1 条旧快照。 */
export function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  sqlite
    .prepare(
      "INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (1, '管理员', '', 'x', 'admin', 0, 0)"
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (13, 1, 'S9 | 顶级联赛', 'round_robin', 'running', 1, ?)"
    )
    .run(iso);
  sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (131, 13, 'round_robin', 1)").run();
  for (const [id, name] of [
    [1, "红队"],
    [2, "蓝队"],
    [3, "黄队"],
    [4, "绿队"],
  ] as const) {
    sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (?, 1, ?, ?)").run(id, name, iso);
    sqlite
      .prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (?, 13, ?, ?)")
      .run(900 + id, id, id);
  }
  sqlite.prepare("INSERT INTO season (id, name, weeks) VALUES (1, 'S9', 31)").run();
  sqlite
    .prepare(
      `INSERT INTO round_window (id, season_id, tournament_id, stream, round, leg, week, day_start, day_end)
       VALUES (10, 1, 13, 'league', 11, NULL, 12, 6, 7)`
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO round_window (id, season_id, tournament_id, stream, round, leg, week, day_start, day_end)
       VALUES (11, 1, 13, 'league', 12, NULL, 13, 1, 2)`
    )
    .run();

  const insertMatch = sqlite.prepare(
    `INSERT INTO match
       (id, stage_id, round, slot, home_entry_id, away_entry_id, status,
        kickoff_week, kickoff_day, kickoff_time, kickoff_override, kickoff_reason)
     VALUES (?, 131, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
  );
  insertMatch.run(1, 11, 1, 901, 902, 12, 6, "20:00", 0, null);
  // 越窗补赛：窗口在第 12 周，但这场被改到第 14 周，归档仍应归到 segment 10
  insertMatch.run(2, 11, 2, 903, 904, 14, 7, "14:00", 1, "转播调整");
  // 与 1 号场同队（红队），跨段只隔 40h → 整季体检应报 hard
  insertMatch.run(3, 12, 1, 901, 903, 13, 1, "12:00", 0, null);
  // 未排时刻的场次：归档不应把它算进 revision
  insertMatch.run(4, 12, 2, 902, 904, null, null, null, 0, null);

  // 旧窗口快照先放一条：归档 revision 1 不能删/改它
  sqlite
    .prepare("INSERT INTO schedule_snapshot (window_id, payload, created_by) VALUES (10, ?, 'seed')")
    .run(JSON.stringify({ assignments: [] }));

  const kv = new Map<string, string>([["sess:tok-admin", JSON.stringify({ userId: 1 })]]);
  const env: Record<string, unknown> = {
    DB: createTestD1(sqlite),
    KV: createTestKV(kv) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
  };
  return { env, sqlite };
}

export const call = (env: Record<string, unknown>, path: string, init?: RequestInit) =>
  app.request(
    path,
    { ...init, headers: { "Content-Type": "application/json", Cookie: "whl_session=tok-admin" } },
    env
  );

export const post = (env: Record<string, unknown>, path: string, body?: unknown) =>
  call(env, path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** 冠军杯小组第 3 轮的窗口级覆盖：所有场压到第 3 天 21:00（容量放开）。 */
const GROUP3_OVERRIDE = JSON.stringify({ day: 3, slots: [{ time: "21:00", cap: 10 }] });

// ---------------------------------------------------------------------------
// S2：整季求解引擎。夹具 = 8 队打满一季：顶级联赛 10 轮 + 冠军杯
// （小组 3 轮 + 半决赛两回合 + 决赛），档位池用 kickoffCalendar 的真实数据。
// ---------------------------------------------------------------------------
export function fullEnv() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  sqlite
    .prepare(
      "INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (1, '管理员', '', 'x', 'admin', 0, 0)"
    )
    .run();
  sqlite.prepare("INSERT INTO season (id, name, weeks) VALUES (1, 'S9', 31)").run();
  sqlite
    .prepare(
      "INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (13, 1, 'S9 | 顶级联赛', 'round_robin', 'running', 1, ?)"
    )
    .run(iso);
  sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (131, 13, 'round_robin', 1)").run();
  sqlite
    .prepare(
      "INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (14, 1, 'S9 | 冠军杯', 'group_knockout', 'running', 1, ?)"
    )
    .run(iso);
  sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (141, 14, 'group', 1)").run();
  sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (142, 14, 'elim', 2)").run();

  const teamNames = ["红一", "红二", "红三", "红四", "蓝一", "蓝二", "蓝三", "蓝四"];
  for (let i = 1; i <= 8; i += 1) {
    sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (?, 1, ?, ?)").run(i, teamNames[i - 1], iso);
    sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (?, 13, ?, ?)").run(900 + i, i, i);
    sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (?, 14, ?, ?)").run(910 + i, i, i);
  }

  const insertPool = sqlite.prepare(
    "INSERT INTO time_pool (season_id, phase, competition, day, slots) VALUES (1, ?, ?, ?, ?)"
  );
  for (const row of poolRows()) {
    insertPool.run(row.phase, row.competition, row.day, JSON.stringify(row.slots));
  }

  const insertWindow = sqlite.prepare(
    `INSERT INTO round_window
       (id, season_id, tournament_id, stream, round, leg, week, day_start, day_end, slot_override, locked_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // 顶级联赛第 1-10 轮：每周一轮，周末档（201-210）
  for (let r = 1; r <= 10; r += 1) insertWindow.run(200 + r, 13, "league", r, null, r, 6, 7, null, null);
  // 冠军杯小组第 1-3 轮：周中档（211-213）；第 3 轮带窗口级覆盖
  insertWindow.run(211, 14, "group", 1, null, 2, 2, 3, null, null);
  insertWindow.run(212, 14, "group", 2, null, 4, 2, 3, null, null);
  insertWindow.run(213, 14, "group", 3, null, 6, 2, 3, GROUP3_OVERRIDE, null);
  // 半决赛两回合 + 决赛（214-216）；首回合所在窗口已公布（locked_at）
  insertWindow.run(214, 14, "elim", 2, 1, 8, 2, 3, null, "2026-11-01T00:00:00Z");
  insertWindow.run(215, 14, "elim", 2, 2, 9, 2, 3, null, null);
  insertWindow.run(216, 14, "elim", 3, null, 11, 6, 6, null, null);

  // 8 队单循环对局表（circle method），偶数轮主客互换；第 8-10 轮复用第 1-3 轮对局再互换主客
  const circle: Array<Array<[number, number]>> = [];
  const arr = [1, 2, 3, 4, 5, 6, 7, 8];
  for (let r = 0; r < 7; r += 1) {
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < 4; i += 1) {
      const a = arr[i];
      const b = arr[7 - i];
      pairs.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    circle.push(pairs);
    arr.splice(1, 0, arr.pop() as number);
  }
  const insertLeague = sqlite.prepare(
    `INSERT INTO match
       (id, stage_id, round, slot, leg, home_entry_id, away_entry_id, status,
        kickoff_week, kickoff_day, kickoff_time, kickoff_override, kickoff_reason)
     VALUES (?, 131, ?, ?, NULL, ?, ?, 'pending', NULL, NULL, NULL, 0, NULL)`
  );
  for (let r = 1; r <= 10; r += 1) {
    for (let s = 0; s < 4; s += 1) {
      const [home, away] = r <= 7 ? circle[r - 1][s] : [circle[r - 8][s][1], circle[r - 8][s][0]];
      insertLeague.run(101 + (r - 1) * 4 + s, r, s + 1, 900 + home, 900 + away);
    }
  }
  // 第 1 轮已开赛（冻结上下文），全部落在夏季 top 池内
  const setFinished = sqlite.prepare(
    "UPDATE match SET status = 'finished', kickoff_week = 1, kickoff_day = ?, kickoff_time = ? WHERE id = ?"
  );
  setFinished.run(6, "17:30", 101);
  setFinished.run(6, "19:30", 102);
  setFinished.run(6, "20:30", 103);
  setFinished.run(7, "18:00", 104);

  // 冠军杯小组赛：A 组 1-4 队、B 组 5-8 队各打 3 轮（141-152）
  const groupCircle = (teams: number[]): Array<Array<[number, number]>> => {
    const rounds: Array<Array<[number, number]>> = [];
    const g = [...teams];
    for (let r = 0; r < 3; r += 1) {
      const pairs: Array<[number, number]> = [];
      for (let i = 0; i < 2; i += 1) {
        const a = g[i];
        const b = g[3 - i];
        pairs.push(r % 2 === 0 ? [a, b] : [b, a]);
      }
      rounds.push(pairs);
      g.splice(1, 0, g.pop() as number);
    }
    return rounds;
  };
  const groupA = groupCircle([1, 2, 3, 4]);
  const groupB = groupCircle([5, 6, 7, 8]);
  const insertGroup = sqlite.prepare(
    `INSERT INTO match
       (id, stage_id, round, slot, leg, home_entry_id, away_entry_id, status,
        kickoff_week, kickoff_day, kickoff_time, kickoff_override, kickoff_reason)
     VALUES (?, 141, ?, ?, NULL, ?, ?, 'pending', NULL, NULL, NULL, 0, NULL)`
  );
  for (let r = 1; r <= 3; r += 1) {
    for (let s = 0; s < 2; s += 1) {
      const [aHome, aAway] = groupA[r - 1][s];
      const [bHome, bAway] = groupB[r - 1][s];
      insertGroup.run(140 + (r - 1) * 4 + s * 2 + 1, r, s + 1, 910 + aHome, 910 + aAway);
      insertGroup.run(140 + (r - 1) * 4 + s * 2 + 2, r, s + 3, 910 + bHome, 910 + bAway);
    }
  }

  const insertElim = sqlite.prepare(
    `INSERT INTO match
       (id, stage_id, round, slot, leg, home_entry_id, away_entry_id, status,
        kickoff_week, kickoff_day, kickoff_time, kickoff_override, kickoff_reason)
     VALUES (?, 142, 2, ?, ?, ?, ?, 'pending', ?, ?, ?, 0, NULL)`
  );
  // 半决赛首回合（窗口 214 已公布）：时刻冻结不动（153-154）
  insertElim.run(153, 1, 1, 911, 915, 8, 3, "21:00");
  insertElim.run(154, 2, 1, 912, 916, 8, 3, "21:00");
  // 半决赛次回合：待排（155-156）
  insertElim.run(155, 1, 2, 915, 911, null, null, null);
  insertElim.run(156, 2, 2, 916, 912, null, null, null);
  // 决赛：晋级对手未定（157）→ unplayable
  sqlite
    .prepare(
      "INSERT INTO match (id, stage_id, round, slot, leg, home_entry_id, away_entry_id, status) VALUES (157, 142, 3, 1, NULL, NULL, NULL, 'pending')"
    )
    .run();

  return { sqlite, db: createTestD1(sqlite) };
}

/** fullEnv 的 sqlite 包成路由 env（会话同 S1 freshEnv 的 sess:tok-admin）。 */
export function routeEnvOf(sqlite: DatabaseSync) {
  const kv = new Map<string, string>([["sess:tok-admin", JSON.stringify({ userId: 1 })]]);
  const env: Record<string, unknown> = {
    DB: createTestD1(sqlite),
    KV: createTestKV(kv) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
  };
  return env;
}
