// 积分榜重算自愈（v5.8.0）：worker/lib/rebuild-guard.ts 的写入协议与自愈闭环。
// 病根见 migrations/0029_rebuild_pending.sql：终场提交是两段式且无跨语句事务（D1 没有交互式事务），
// 第二段（榜重算 / 晋级填位 / 下一阶段首轮生成）失败时留下「比赛已 finished、榜没重算、审计缺行」
// 的半截状态——2026-10-15 的 match 193 就是这样丢的，事后只能靠人工比对 fin/played 才发现。
// 这里钉四件事：
//   1) 协议：主写入与欠账标记同批；后续处理全部成功才销账；失败降级留标记（attempts/last_error）
//   2) 三个出口：瞬时失败就地重试一次；AdvancerError 原样抛给调用方（回滚终场 + 清标记）；
//      cron（healPendingRebuilds）按阶段补跑，一小时内自己收敛
//   3) 六个写入点接的是同一个守卫，且报分链把降级如实回报成 standingsPending
//   4) 体检：pending 是硬信号、mismatches 是软信号；carried_played 记「带入当时的场次数」，
//      源阶段继续开打不会把带入榜误报成对不上（对账假阳性的主要来源）
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { applyMigrations, createTestD1, createTestKV, sqlAll, sqlGet } from "./d1";
import {
  findStandingsMismatches,
  healPendingRebuilds,
  listPendingRebuilds,
  runStageRebuildGuard,
} from "../worker/lib/rebuild-guard";
import { buildAutoFillStmts } from "../worker/routes/admin/schedule";

type Env = Record<string, unknown>;

const AUTH = { Cookie: "whl_session=tok-admin", "Content-Type": "application/json" };
const ISO = "2026-03-01T00:00:00Z";

type StandingRow = {
  played: number;
  won: number;
  drawn: number;
  lost: number;
  pts: number;
  gf: number;
  ga: number;
  carried_pts: number;
  deduct_pts: number;
  carried_played: number;
};

// 赛事 7：阶段 70 循环赛（预赛）/ 71 循环赛（复赛，带入的上游）/ 72 淘汰赛；
// 报名 500–503（对应队 10–13）；场次 800/801（阶段 70，待打）、810（阶段 71，待打）
function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  sqlite
    .prepare(
      "INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(1, "超管", "", "x", "superadmin", 0, 0);
  for (const [id, name] of [
    [10, "甲队"],
    [11, "乙队"],
    [12, "丙队"],
    [13, "丁队"],
  ] as const) {
    sqlite
      .prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (?, 1, ?, ?)")
      .run(id, name, ISO);
  }
  sqlite
    .prepare(
      "INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (7, 1, '联赛', 'round_robin', 'running', 1, ?)"
    )
    .run(ISO);
  const st = sqlite.prepare(
    "INSERT INTO stage (id, tournament_id, kind, sort_order, name, config_json) VALUES (?, 7, ?, ?, ?, '{}')"
  );
  st.run(70, "round_robin", 1, "预赛");
  st.run(71, "round_robin", 2, "复赛");
  st.run(72, "elim", 3, "淘汰赛");
  const e = sqlite.prepare(
    "INSERT INTO entry (id, tournament_id, team_id, seed, group_id) VALUES (?, 7, ?, ?, NULL)"
  );
  e.run(500, 10, 1);
  e.run(501, 11, 2);
  e.run(502, 12, 3);
  e.run(503, 13, 4);
  addPending(sqlite, 800, 70, 500, 501);
  addPending(sqlite, 801, 70, 502, 503);
  addPending(sqlite, 810, 71, 500, 502);

  const env: Env = {
    DB: createTestD1(sqlite),
    KV: createTestKV(
      new Map([["sess:tok-admin", JSON.stringify({ userId: 1 })]])
    ) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
  };
  return { env, sqlite };
}

// 待打场次（fixture 专用）
function addPending(sqlite: DatabaseSync, id: number, stageId: number, home: number, away: number) {
  sqlite
    .prepare(
      `INSERT INTO match (id, stage_id, round, slot, leg, home_entry_id, away_entry_id, status, winner_entry_id, note, walkover_side)
       VALUES (?, ?, 1, 1, NULL, ?, ?, 'pending', NULL, NULL, '')`
    )
    .run(id, stageId, home, away);
}

// 已完赛场次（直接落库，不经过报分端点）：模拟「当时的写入路径留下的榜」
function addFinished(
  sqlite: DatabaseSync,
  id: number,
  stageId: number,
  home: number,
  away: number,
  hs: number,
  as: number,
  winner: number | null
) {
  sqlite
    .prepare(
      `INSERT INTO match (id, stage_id, round, slot, leg, home_entry_id, away_entry_id, status,
                          winner_entry_id, note, walkover_side, score_home, score_away, finished_at)
       VALUES (?, ?, 1, 1, NULL, ?, ?, 'finished', ?, NULL, '', ?, ?, ?)`
    )
    .run(id, stageId, home, away, winner, hs, as, ISO);
}

// 可控失败的 D1 壳：fail(批次序号) 返回错误则第 N 次 batch 抛错——模拟网络抖动 / 实例中断。
// 序号从 1 开始，按调用先后计数（不是按语句内容）。
function flakyEnv(env: Env, fail: (call: number) => Error | null): Env {
  const base = env.DB as D1Database;
  let call = 0;
  const wrapped = {
    ...(base as unknown as Record<string, unknown>),
    async batch(statements: unknown[]) {
      call++;
      const err = fail(call);
      if (err) throw err;
      return base.batch(statements as never);
    },
  };
  return { ...env, DB: wrapped as unknown as D1Database };
}

const post = (env: Env, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: AUTH, body: JSON.stringify(body) }, env);
const put = (env: Env, path: string, body: unknown) =>
  app.request(path, { method: "PUT", headers: AUTH, body: JSON.stringify(body) }, env);
const patch = (env: Env, path: string, body: unknown) =>
  app.request(path, { method: "PATCH", headers: AUTH, body: JSON.stringify(body) }, env);
const del = (env: Env, path: string) => app.request(path, { method: "DELETE", headers: AUTH }, env);
const get = (env: Env, path: string) => app.request(path, { headers: AUTH }, env);

const finish = (env: Env, matchId: number, body: Record<string, unknown> = {}) =>
  post(env, `/api/admin/matches/${matchId}/finish`, body);

const standingOf = (sqlite: DatabaseSync, stageId: number, entryId: number) =>
  sqlGet<StandingRow>(sqlite, "SELECT * FROM standing WHERE stage_id = ? AND entry_id = ?", stageId, entryId)!;

const pendingRows = (sqlite: DatabaseSync) =>
  sqlAll<{ stage_id: number; source: string; attempts: number; last_error: string | null }>(
    sqlite,
    "SELECT stage_id, source, attempts, last_error FROM rebuild_pending ORDER BY stage_id"
  );

const standingsCount = (sqlite: DatabaseSync, stageId: number) =>
  sqlGet<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM standing WHERE stage_id = ?", stageId)!.n;

describe("重算守卫：写入协议", () => {
  it("后续处理成功：主写入与标记同批落库，补算完把标记销掉", async () => {
    const { env, sqlite } = freshEnv();
    const res = await runStageRebuildGuard(
      env.DB as D1Database,
      { stageId: 70, tournamentId: 7, source: "generate" },
      [
        (env.DB as D1Database)
          .prepare("UPDATE match SET status = 'finished', score_home = 2, score_away = 0 WHERE id = 800")
          .bind(),
      ]
    );
    expect(res).toEqual({ followUpOk: true });
    // 主写入生效 + 榜按新结果算出来 + 没有欠账
    expect(sqlGet<{ status: string }>(sqlite, "SELECT status FROM match WHERE id = 800")!.status).toBe("finished");
    expect(standingOf(sqlite, 70, 500)).toMatchObject({ played: 1, pts: 3, won: 1 });
    expect(standingOf(sqlite, 70, 501)).toMatchObject({ played: 1, pts: 0, lost: 1 });
    expect(pendingRows(sqlite)).toEqual([]);
  });

  it("后续处理瞬时失败一次：就地重试成功，不算欠账", async () => {
    const { env, sqlite } = freshEnv();
    // 第 1 批是主写入+标记，第 2 批是榜语句（让它失败），第 3 批是重试
    const flaky = flakyEnv(env, (c) => (c === 2 ? new Error("模拟网络抖动") : null));
    const res = await runStageRebuildGuard(
      flaky.DB as D1Database,
      { stageId: 70, tournamentId: 7, source: "generate" },
      [
        (flaky.DB as D1Database)
          .prepare("UPDATE match SET status = 'finished', score_home = 1, score_away = 1 WHERE id = 800")
          .bind(),
      ]
    );
    expect(res).toEqual({ followUpOk: true });
    expect(standingOf(sqlite, 70, 500)).toMatchObject({ played: 1, pts: 1, drawn: 1 });
    expect(pendingRows(sqlite)).toEqual([]);
  });

  it("后续处理连续失败：降级——主写入留在库里，标记记 attempts/last_error", async () => {
    const { env, sqlite } = freshEnv();
    const flaky = flakyEnv(env, (c) => (c === 2 || c === 3 ? new Error("模拟实例中断") : null));
    const res = await runStageRebuildGuard(
      flaky.DB as D1Database,
      { stageId: 70, tournamentId: 7, source: "generate" },
      [
        (flaky.DB as D1Database)
          .prepare("UPDATE match SET status = 'finished', score_home = 2, score_away = 0 WHERE id = 800")
          .bind(),
      ]
    );
    expect(res.followUpOk).toBe(false);
    expect(res.error).toContain("模拟实例中断");
    // 比分已落库（这是产品要求：报分不能因为榜算不出来而失败）
    expect(sqlGet<{ status: string }>(sqlite, "SELECT status FROM match WHERE id = 800")!.status).toBe("finished");
    // 榜没算出来，但欠账记在库里：过程可查、cron 会补
    expect(standingsCount(sqlite, 70)).toBe(0);
    expect(pendingRows(sqlite)).toEqual([
      expect.objectContaining({ stage_id: 70, source: "generate", attempts: 1 }),
    ]);
    expect(pendingRows(sqlite)[0].last_error).toContain("模拟实例中断");
  });

  it("AdvancerError（下游已开打需换人）原样抛出：不重试、不销账，交给调用方", async () => {
    const { env, sqlite } = freshEnv();
    // 淘汰赛决赛已开打，且场上的晋级方与这次报分算出的不一致 → 晋级器要求换人
    sqlite.prepare("DELETE FROM match WHERE stage_id = 72").run();
    const m = sqlite.prepare(
      `INSERT INTO match (id, stage_id, round, slot, leg, home_entry_id, away_entry_id, status, winner_entry_id, note, walkover_side)
       VALUES (?, 72, ?, ?, NULL, ?, ?, ?, ?, ?, '')`
    );
    m.run(820, 1, 1, 500, 501, "pending", null, null);
    m.run(821, 1, 2, 502, null, "pending", 502, null);
    m.run(822, 2, 1, 503, 502, "live", null, null);

    const db = env.DB as D1Database;
    await expect(
      runStageRebuildGuard(db, { stageId: 72, tournamentId: 7, source: "scoring" }, [
        db
          .prepare(
            "UPDATE match SET status = 'finished', score_home = 1, score_away = 0, winner_entry_id = 500 WHERE id = 820"
          )
          .bind(),
      ])
    ).rejects.toThrow("后续场次已开打，晋级对阵无法更新");

    // 语义冲突 = 这次写入整体作废：标记也得留着等调用方回滚时一起清（scoring 的 409 路径）
    expect(pendingRows(sqlite)).toEqual([expect.objectContaining({ stage_id: 72, attempts: 0 })]);
  });
});

describe("报分链：降级如实回报 + cron 自愈", () => {
  it("正常路径：终场落库、榜重算、无欠账，响应形状与从前逐字相同", async () => {
    const { env, sqlite } = freshEnv();
    const res = await finish(env, 800, { scoreHome: 2, scoreAway: 0 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, winner: 500, regenerated: false });
    expect(standingOf(sqlite, 70, 500)).toMatchObject({ played: 1, pts: 3 });
    expect(pendingRows(sqlite)).toEqual([]);
  });

  it("后续处理连续失败 → 200 + standingsPending，随后 cron 补跑自愈", async () => {
    const { env, sqlite } = freshEnv();
    const flaky = flakyEnv(env, (c) => (c === 2 || c === 3 ? new Error("模拟终场第二段失败") : null));
    const res = await finish(flaky, 800, { scoreHome: 2, scoreAway: 0 });
    expect(res.status).toBe(200);
    // 比分已记录，但榜没跟上——如实说，不谎报成功
    expect(await res.json()).toEqual({
      ok: true,
      winner: 500,
      regenerated: false,
      standingsPending: true,
    });
    expect(sqlGet<{ status: string }>(sqlite, "SELECT status FROM match WHERE id = 800")!.status).toBe("finished");
    expect(standingsCount(sqlite, 70)).toBe(0);
    expect(pendingRows(sqlite)).toEqual([
      expect.objectContaining({ stage_id: 70, source: "scoring", attempts: 1 }),
    ]);

    // cron（每小时一次）拿同一份欠账补跑：榜补算出来、账销掉
    const healed = await healPendingRebuilds(flaky, { autoFill: buildAutoFillStmts });
    expect(healed).toEqual({ healed: 1, failed: 0 });
    expect(standingOf(sqlite, 70, 500)).toMatchObject({ played: 1, pts: 3 });
    expect(pendingRows(sqlite)).toEqual([]);
  });

  it("晋级冲突 409：终场回滚，且欠账标记一并清掉（这次写入不算数，不该留账）", async () => {
    const { env, sqlite } = freshEnv();
    sqlite.prepare("DELETE FROM match WHERE stage_id = 72").run();
    const m = sqlite.prepare(
      `INSERT INTO match (id, stage_id, round, slot, leg, home_entry_id, away_entry_id, status, winner_entry_id, note, walkover_side)
       VALUES (?, 72, ?, ?, NULL, ?, ?, ?, ?, ?, '')`
    );
    m.run(820, 1, 1, 500, 501, "pending", null, null);
    m.run(821, 1, 2, 502, null, "pending", 502, null);
    m.run(822, 2, 1, 503, 502, "live", null, null);

    const res = await finish(env, 820, { scoreHome: 1, scoreAway: 0 });
    expect(res.status).toBe(409);
    expect((await res.json()).message).toBe("后续场次已开打，晋级对阵无法更新");
    expect(
      sqlGet<{ status: string; score_home: number | null }>(
        sqlite,
        "SELECT status, score_home FROM match WHERE id = 820"
      )
    ).toMatchObject({ status: "pending", score_home: null });
    expect(pendingRows(sqlite)).toEqual([]);
    expect(sqlGet<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM audit_log")!.n).toBe(0);
  });

  it("cron 兜底：单个阶段失败不影响其它欠账，扫库异常不抛出", async () => {
    const { env, sqlite } = freshEnv();
    // 两个欠账：70 能补（800 已完赛），999 的阶段早被删了 → 走全量兜底
    sqlite.exec("UPDATE match SET status = 'finished', score_home = 2, score_away = 0, winner_entry_id = 500 WHERE id = 800");
    sqlite.exec(
      "INSERT INTO rebuild_pending (stage_id, tournament_id, source) VALUES (70, 7, 'scoring'), (999, 7, 'delete_stage')"
    );
    const logs: string[] = [];
    // 守卫内部会就地重试一次 ⇒ 要让它失败必须连失两批（模拟持续不可用，而不是一次抖动）
    const failedOnce = flakyEnv(env, (c) => (c <= 2 ? new Error("模拟补跑失败") : null));
    const first = await healPendingRebuilds(failedOnce, {
      autoFill: buildAutoFillStmts,
      logger: (m) => logs.push(m),
    });
    expect(first).toEqual({ healed: 1, failed: 1 });
    expect(logs[0]).toContain("[rebuild-heal] 阶段 70");
    // 失败的那条留着（attempts 累加），另一条已经销账——一个阶段补不动不该拖住别的欠账
    expect(pendingRows(sqlite)).toEqual([expect.objectContaining({ stage_id: 70, attempts: 1 })]);
    expect(standingOf(sqlite, 70, 500)).toMatchObject({ played: 1, pts: 3 });

    // 下一轮 cron：补干净最后一条
    const second = await healPendingRebuilds(env, { autoFill: buildAutoFillStmts });
    expect(second).toEqual({ healed: 1, failed: 0 });
    expect(pendingRows(sqlite)).toEqual([]);

    // 扫描本身失败（表都读不到）也不抛：cron 没有重试，吞掉记日志
    const brokenEnv: Env = {
      ...env,
      DB: { prepare: () => ({ all: async () => { throw new Error("DB 抖了"); } }) } as unknown as D1Database,
    };
    const logs2: string[] = [];
    expect(await healPendingRebuilds(brokenEnv, { logger: (m) => logs2.push(m) })).toEqual({
      healed: 0,
      failed: 0,
    });
    expect(logs2[0]).toContain("[rebuild-heal] 欠账扫描失败");
  });
});

describe("其它触发点：同一守卫、不留欠账", () => {
  it("扣分整表替换：写入与标记同批、重算后销账；清空与无受影响阶段都不留账", async () => {
    const { env, sqlite } = freshEnv();
    addFinished(sqlite, 805, 70, 500, 501, 2, 0, 500); // 直接落库（榜还没算）

    const res = await patch(env, "/api/admin/tournaments/7/entries/500/deduction", {
      items: [{ points: 1, stageId: 70 }],
    });
    expect(res.status).toBe(200);
    expect(standingOf(sqlite, 70, 500)).toMatchObject({ pts: 2, deduct_pts: 1 });
    expect(pendingRows(sqlite)).toEqual([]);

    // 清空扣分：榜跟着回涨（旧阶段也要参与重算）
    await patch(env, "/api/admin/tournaments/7/entries/500/deduction", { items: [] });
    expect(standingOf(sqlite, 70, 500)).toMatchObject({ pts: 3, deduct_pts: 0 });
    expect(pendingRows(sqlite)).toEqual([]);

    // 没有任何阶段受影响：不重算、也不标记
    const empty = await patch(env, "/api/admin/tournaments/7/entries/501/deduction", { items: [] });
    expect(empty.status).toBe(200);
    expect(pendingRows(sqlite)).toEqual([]);
  });

  it("改带入 / 删单场：重算后销账，带入榜的场次口径跟着刷新", async () => {
    const { env, sqlite } = freshEnv();
    addFinished(sqlite, 805, 70, 500, 501, 2, 0, 500); // 上游一场完赛
    sqlite.exec(
      "UPDATE match SET status = 'finished', score_home = 1, score_away = 1, winner_entry_id = NULL WHERE id = 810"
    ); // 复赛一场完赛（带入口径下 played 会叠加）

    // 先把两张榜按当前结果算出来：带入要读上游已算出的基数，上游没榜时带入会算成 0
    const seeded = await post(env, "/api/admin/tournaments/7/rebuild-standings", {});
    expect(seeded.status).toBe(200);

    const carry = await put(env, "/api/admin/tournaments/7/stages/71/carry", {
      carry: { mode: "record", multiplier: 1, fromStage: 70 },
    });
    expect(carry.status).toBe(200);
    // 500：上游 1 场带入 + 复赛自己 1 场 = 2；carried_played 记的是「带入当时那个数」
    expect(standingOf(sqlite, 71, 500)).toMatchObject({ played: 2, carried_played: 1 });
    expect(standingOf(sqlite, 70, 500)).toMatchObject({ played: 1, carried_played: 0 });
    expect(pendingRows(sqlite)).toEqual([]);

    const removed = await del(env, "/api/admin/tournaments/7/matches/801");
    expect(removed.status).toBe(200);
    expect(sqlGet<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM match WHERE id = 801")!.n).toBe(0);
    expect(pendingRows(sqlite)).toEqual([]);
  });
});

describe("体检与一键重算", () => {
  it("对账：榜与完赛场次对不上会被指出；正常的榜不误报", async () => {
    const { env, sqlite } = freshEnv();
    const ok = await finish(env, 800, { scoreHome: 2, scoreAway: 0 });
    expect(ok.status).toBe(200);
    expect(await findStandingsMismatches(env.DB as D1Database, 7)).toEqual([]);

    // 制造脱账：新完赛一场却不重算（正是 193 事故的现场）
    addFinished(sqlite, 806, 70, 500, 501, 1, 1, null);
    const rows = await findStandingsMismatches(env.DB as D1Database, 7);
    expect(rows.map((r) => [r.entryId, r.played, r.expected])).toEqual([
      [500, 1, 2],
      [501, 1, 2],
    ]);
    expect(rows.every((r) => r.stageId === 70)).toBe(true);
  });

  it("带入榜不因源阶段继续开打而误报（carried_played 的口径回归）", async () => {
    const { env, sqlite } = freshEnv();
    addFinished(sqlite, 805, 70, 500, 501, 2, 0, 500);
    sqlite.exec(
      "UPDATE match SET status = 'finished', score_home = 1, score_away = 1, winner_entry_id = NULL WHERE id = 810"
    );
    // 先建榜（带入要读上游基数），再配上带入
    await post(env, "/api/admin/tournaments/7/rebuild-standings", {});
    await put(env, "/api/admin/tournaments/7/stages/71/carry", {
      carry: { mode: "record", multiplier: 1, fromStage: 70 },
    });
    expect(standingOf(sqlite, 71, 500)).toMatchObject({ played: 2, carried_played: 1 });

    // 上游又打完一场（不重算下游）：源阶段的 expected 会涨，带入榜的 expected 不该涨
    addFinished(sqlite, 807, 70, 500, 502, 3, 0, 500);
    const rows = await findStandingsMismatches(env.DB as D1Database, 7);
    expect(rows.map((r) => r.stageId)).toEqual([70, 70]);
    expect(rows.map((r) => r.entryId)).toEqual([500, 502]);
    // 带入榜照旧：500 的 2 场（带入 1 + 复赛 1）与记载一致——源阶段现在有 2 场完赛，
    // 若拿「源阶段当前的 played」当期望值，这里会误报
    expect(standingOf(sqlite, 71, 500)).toMatchObject({ played: 2, carried_played: 1 });
  });

  it("体检端点：healthy 判定 + pending 明细；赛事不存在 404", async () => {
    const { env, sqlite } = freshEnv();
    const clean = await get(env, "/api/admin/tournaments/7/standings-health");
    expect(clean.status).toBe(200);
    expect(await clean.json()).toEqual({ ok: true, healthy: true, pending: [], mismatches: [] });

    sqlite.exec("INSERT INTO rebuild_pending (stage_id, tournament_id, source) VALUES (70, 7, 'scoring')");
    const dirty = (await (await get(env, "/api/admin/tournaments/7/standings-health")).json()) as {
      healthy: boolean;
      pending: unknown[];
    };
    expect(dirty.healthy).toBe(false);
    expect(dirty.pending).toEqual([
      expect.objectContaining({ stageId: 70, stageName: "预赛", source: "scoring", attempts: 0 }),
    ]);
    expect((await get(env, "/api/admin/tournaments/999/standings-health")).status).toBe(404);
  });

  it("一键重算：全量/指定阶段的清账范围不同；参数与阶段校验有明确文案；审计落库", async () => {
    const { env, sqlite } = freshEnv();
    addFinished(sqlite, 805, 70, 500, 501, 2, 0, 500);
    sqlite.exec(
      "INSERT INTO rebuild_pending (stage_id, tournament_id, source) VALUES (70, 7, 'scoring'), (71, 7, 'carry')"
    );

    // 指定阶段 71：复赛还没开打也没算过榜 ⇒ 这次没有可算的东西（语句 0 条），但账照销——
    // 它的欠账来源（带入写入）已被跳过规则判定为「无需重算」
    const partial = await post(env, "/api/admin/tournaments/7/rebuild-standings", { stageId: 71 });
    expect(partial.status).toBe(200);
    expect(await partial.json()).toEqual({ ok: true, statements: 0, cleared: 1 });
    expect(pendingRows(sqlite).map((r) => r.stage_id)).toEqual([70]);

    // 全量：索性从头算一遍（预赛已完赛 ⇒ 有榜要写），清掉该赛事所有欠账
    const full = await post(env, "/api/admin/tournaments/7/rebuild-standings", {});
    expect(full.status).toBe(200);
    const fullBody = (await full.json()) as { ok: boolean; statements: number; cleared: number };
    expect(fullBody.ok).toBe(true);
    expect(fullBody.statements).toBeGreaterThan(0);
    expect(fullBody.cleared).toBe(1);
    expect(pendingRows(sqlite)).toEqual([]);
    expect(standingOf(sqlite, 70, 500)).toMatchObject({ played: 1, pts: 3 });

    expect((await post(env, "/api/admin/tournaments/7/rebuild-standings", { stageId: "abc" })).status).toBe(400);
    expect((await post(env, "/api/admin/tournaments/7/rebuild-standings", { stageId: 999 })).status).toBe(404);
    expect((await post(env, "/api/admin/tournaments/7/rebuild-standings", { stageId: 72 })).status).toBe(400);
    expect((await post(env, "/api/admin/tournaments/999/rebuild-standings", {})).status).toBe(404);
    expect(
      sqlGet<{ n: number }>(
        sqlite,
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'standings_rebuild' AND target_type = 'tournament'"
      )!.n
    ).toBe(2);

    // 未登录：管理端守卫先拦
    const anon = await app.request("/api/admin/tournaments/7/standings-health", {}, env);
    expect(anon.status).toBe(401);
  });

  it("体检明细来自同一个欠账表：listPendingRebuilds 按赛事隔离", async () => {
    const { env, sqlite } = freshEnv();
    sqlite.exec("INSERT INTO rebuild_pending (stage_id, tournament_id, source) VALUES (70, 7, 'generate')");
    const rows = await listPendingRebuilds(env.DB as D1Database, 7);
    expect(rows).toEqual([
      expect.objectContaining({ stageId: 70, stageName: "预赛", source: "generate", attempts: 0 }),
    ]);
    expect(await listPendingRebuilds(env.DB as D1Database, 999)).toEqual([]);
  });
});
