// 终场收敛点：worker/routes/admin/scoring.ts 的 POST /:id/start 与 POST /:id/finish。
// 全站比分只有这一个写入口（pending 快速报分 / live 确认终场 / finished 改判 / 弃权判负），
// 且它同时是积分重算与淘汰晋级的触发器，所以这里钉三层一致性：
//   1) 入参校验（轮空、对阵未定、改判必须给完整比分、平局点球、双弃权指定晋级方）
//   2) 落库结果（比分/点球/winner/walkover_side/note/finished_at）
//   3) 派生结果（standing 重建、下游对阵回填）与失败时的一致性（晋级冲突 409 回滚终场）
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { applyMigrations, createTestD1, createTestKV, sqlAll, sqlGet } from "./d1";

type Env = Record<string, unknown>;

type MatchState = {
  status: string;
  score_home: number | null;
  score_away: number | null;
  pen_home: number | null;
  pen_away: number | null;
  winner_entry_id: number | null;
  walkover_side: string;
  note: string | null;
  finished_at: string | null;
};

type StandState = {
  played: number;
  won: number;
  drawn: number;
  lost: number;
  pts: number;
  gf: number;
  ga: number;
  pen_won: number;
  pen_lost: number;
};

// 赛事 7：循环赛阶段 70（含一场轮空、一场对阵未定）+ 淘汰赛阶段 72（两场首轮 + 决赛壳场）
function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  sqlite
    .prepare(
      "INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(1, "管理员", "", "x", "admin", 0, 0);

  const iso = "2026-01-01T00:00:00Z";
  for (const [id, name] of [
    [10, "甲队"],
    [11, "乙队"],
    [12, "丙队"],
    [13, "丁队"],
  ] as const) {
    sqlite
      .prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (?, 1, ?, ?)")
      .run(id, name, iso);
  }
  sqlite
    .prepare(
      "INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (7, 1, '联赛', 'round_robin', 'running', 1, ?)"
    )
    .run(iso);
  const s = sqlite.prepare(
    "INSERT INTO stage (id, tournament_id, kind, sort_order, name) VALUES (?, 7, ?, ?, ?)"
  );
  s.run(70, "round_robin", 1, "循环赛");
  s.run(72, "elim", 2, "淘汰赛");

  const e = sqlite.prepare(
    "INSERT INTO entry (id, tournament_id, team_id, seed, group_id) VALUES (?, 7, ?, ?, NULL)"
  );
  e.run(500, 10, 1);
  e.run(501, 11, 2);
  e.run(502, 12, 3);
  e.run(503, 13, 4);

  const m = sqlite.prepare(
    `INSERT INTO match (id, stage_id, round, slot, leg, home_entry_id, away_entry_id, status, winner_entry_id, note, walkover_side)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, '')`
  );
  m.run(800, 70, 1, 1, 500, 501, "pending", null, null);
  m.run(801, 70, 1, 2, 502, 503, "pending", null, null);
  m.run(802, 70, 2, 1, 500, null, "pending", 500, "轮空");
  m.run(803, 70, 2, 2, null, null, "pending", null, null);
  m.run(810, 72, 1, 1, 500, 501, "pending", null, null);
  m.run(811, 72, 1, 2, 502, 503, "pending", null, null);
  m.run(812, 72, 2, 1, null, null, "pending", null, null);

  const env: Env = {
    DB: createTestD1(sqlite),
    KV: createTestKV(new Map([["sess:tok-admin", JSON.stringify({ userId: 1 })]])) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
  };
  return { env, sqlite };
}

const post = (env: Env, path: string, body: unknown) =>
  app.request(
    path,
    {
      method: "POST",
      headers: { Cookie: "whl_session=tok-admin", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env
  );

const finish = (env: Env, matchId: number, body: Record<string, unknown> = {}) =>
  post(env, `/api/admin/matches/${matchId}/finish`, body);
const start = (env: Env, matchId: number) => post(env, `/api/admin/matches/${matchId}/start`, {});

const matchOf = (sqlite: DatabaseSync, id: number) =>
  sqlGet<MatchState>(sqlite, "SELECT * FROM match WHERE id = ?", id)!;
const standingOf = (sqlite: DatabaseSync, stageId: number, entryId: number) =>
  sqlGet<StandState>(sqlite, "SELECT * FROM standing WHERE stage_id = ? AND entry_id = ?", stageId, entryId);
const lastAudit = (sqlite: DatabaseSync, matchId: number) =>
  sqlGet<{ action: string; detail_json: string }>(
    sqlite,
    "SELECT action, detail_json FROM audit_log WHERE target_id = ? ORDER BY id DESC LIMIT 1",
    matchId
  );

describe("scoring 开赛（start）", () => {
  it("pending → live，并写 match_start 审计", async () => {
    const { env, sqlite } = freshEnv();
    const res = await start(env, 800);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(matchOf(sqlite, 800).status).toBe("live");
    expect(lastAudit(sqlite, 800)?.action).toBe("match_start");
  });

  it("非 pending 不能开赛（重复开赛被拒）", async () => {
    const { env } = freshEnv();
    await start(env, 800);
    const again = await start(env, 800);
    expect(again.status).toBe(400);
    expect((await again.json()).message).toBe("仅待开打的比赛可以开赛");
  });

  it("轮空场不能开赛", async () => {
    const { env } = freshEnv();
    const res = await start(env, 802);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("轮空场无需开赛");
  });

  it("对阵未定不能开赛", async () => {
    const { env } = freshEnv();
    const res = await start(env, 803);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("对阵双方尚未确定，无法开赛");
  });

  it("比赛不存在 → 404", async () => {
    const { env } = freshEnv();
    const res = await start(env, 9999);
    expect(res.status).toBe(404);
    expect((await res.json()).message).toBe("比赛不存在");
  });
});

describe("scoring 报分（finish）", () => {
  it("pending 快速报分：比分落库 + winner 判定 + match_finish 审计 + 积分榜重建", async () => {
    const { env, sqlite } = freshEnv();
    const res = await finish(env, 800, { scoreHome: 2, scoreAway: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, winner: 500, regenerated: false });

    const m = matchOf(sqlite, 800);
    expect(m.status).toBe("finished");
    expect([m.score_home, m.score_away]).toEqual([2, 1]);
    expect(m.winner_entry_id).toBe(500);
    expect(m.walkover_side).toBe("");
    expect(m.finished_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // 秒级以下带毫秒的 UTC
    expect(lastAudit(sqlite, 800)?.action).toBe("match_finish");

    // 同一 batch 内全量重建该阶段积分榜：未参赛的 502/503 也要有 0 行
    expect(sqlAll(sqlite, "SELECT entry_id FROM standing WHERE stage_id = 70").length).toBe(4);
    expect(standingOf(sqlite, 70, 500)).toMatchObject({ played: 1, won: 1, pts: 3, gf: 2, ga: 1 });
    expect(standingOf(sqlite, 70, 501)).toMatchObject({ played: 1, lost: 1, pts: 0, gf: 1, ga: 2 });
  });

  it("live 场不传比分 → 取事件累计，乌龙球记对方", async () => {
    const { env, sqlite } = freshEnv();
    await start(env, 800);
    const ev = sqlite.prepare(
      "INSERT INTO match_event (match_id, entry_id, player_id, type, minute, created_by) VALUES (?, ?, NULL, ?, ?, 1)"
    );
    ev.run(800, 500, "goal", 10);
    ev.run(800, 501, "own_goal", 20);
    ev.run(800, 501, "pen_goal", 30);

    const res = await finish(env, 800, {});
    expect(res.status).toBe(200);
    // 主队 1 球 + 客队乌龙 1 球 = 2；客队点球 1 球 = 1
    expect(await res.json()).toEqual({ ok: true, winner: 500, regenerated: false });
    expect(matchOf(sqlite, 800)).toMatchObject({ score_home: 2, score_away: 1 });
  });

  it("已完赛场次改判必须传完整终场比分", async () => {
    const { env } = freshEnv();
    await finish(env, 800, { scoreHome: 2, scoreAway: 1 });
    const res = await finish(env, 800, {});
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("改判请传入完整终场比分");
  });

  it("改判翻转胜负并重建积分榜，审计记 match_rescore", async () => {
    const { env, sqlite } = freshEnv();
    await finish(env, 800, { scoreHome: 2, scoreAway: 1 });
    const res = await finish(env, 800, { scoreHome: 0, scoreAway: 2 });
    expect(res.status).toBe(200);
    expect((await res.json()).winner).toBe(501);
    expect(lastAudit(sqlite, 800)?.action).toBe("match_rescore");
    expect(standingOf(sqlite, 70, 500)).toMatchObject({ won: 0, lost: 1, pts: 0, gf: 0, ga: 2 });
    expect(standingOf(sqlite, 70, 501)).toMatchObject({ won: 1, lost: 0, pts: 3, gf: 2, ga: 0 });
  });

  it("轮空场不能报分", async () => {
    const { env } = freshEnv();
    const res = await finish(env, 802, { scoreHome: 1, scoreAway: 0 });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("轮空场无需报分");
  });

  it("归档赛事的比分锁定", async () => {
    const { env, sqlite } = freshEnv();
    sqlite.prepare("UPDATE tournament SET status = 'archived' WHERE id = 7").run();
    const res = await finish(env, 800, { scoreHome: 1, scoreAway: 0 });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("赛事已归档，比分已锁定");
    expect(matchOf(sqlite, 800).status).toBe("pending");
  });

  it("弃权（主队）：比分记 0:3、winner 判给客队、note 默认「主队弃权」", async () => {
    const { env, sqlite } = freshEnv();
    const res = await finish(env, 800, { walkoverSide: "home" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, winner: 501, regenerated: false });
    expect(matchOf(sqlite, 800)).toMatchObject({
      score_home: 0,
      score_away: 3,
      winner_entry_id: 501,
      walkover_side: "home",
      note: "主队弃权",
    });
    expect(lastAudit(sqlite, 800)?.action).toBe("match_walkover");
    expect(standingOf(sqlite, 70, 500)).toMatchObject({ lost: 1, pts: 0 });
    expect(standingOf(sqlite, 70, 501)).toMatchObject({ won: 1, pts: 3 });
  });

  it("弃权（客队）：比分记 3:0、winner 判给主队、note 默认「客队弃权」", async () => {
    const { env, sqlite } = freshEnv();
    const res = await finish(env, 800, { walkoverSide: "away" });
    expect((await res.json()).winner).toBe(500);
    expect(matchOf(sqlite, 800)).toMatchObject({
      score_home: 3,
      score_away: 0,
      walkover_side: "away",
      note: "客队弃权",
    });
  });

  it("弃权（双方）：0:0、双方各记一负、进失球不计", async () => {
    const { env, sqlite } = freshEnv();
    const res = await finish(env, 800, { walkoverSide: "both" });
    expect((await res.json()).winner).toBe(null);
    expect(matchOf(sqlite, 800)).toMatchObject({
      score_home: 0,
      score_away: 0,
      walkover_side: "both",
      note: "双方弃权",
    });
    for (const entryId of [500, 501]) {
      expect(standingOf(sqlite, 70, entryId)).toMatchObject({
        played: 1,
        lost: 1,
        pts: 0,
        gf: 0,
        ga: 0,
      });
    }
  });

  it("弃权备注：trim 后取用、最多 60 字", async () => {
    const { env, sqlite } = freshEnv();
    await finish(env, 800, { walkoverSide: "home", walkoverNote: `  ${"备".repeat(70)}  ` });
    expect(matchOf(sqlite, 800).note?.length).toBe(60);
    expect(matchOf(sqlite, 800).note?.startsWith("备")).toBe(true); // 先 trim 掉首尾空格再截断
    expect(matchOf(sqlite, 801).status).toBe("pending"); // 只动本场，同阶段其它场次不受影响
  });

  it("非法弃权方 → 400", async () => {
    const { env } = freshEnv();
    const res = await finish(env, 800, { walkoverSide: "referee" });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("弃权方必须是 home / away / both");
  });

  it("改判普通比分同时清掉弃权标记与备注", async () => {
    const { env, sqlite } = freshEnv();
    await finish(env, 800, { walkoverSide: "both" });
    const res = await finish(env, 800, { scoreHome: 2, scoreAway: 0 });
    expect(res.status).toBe(200);
    expect((await res.json()).winner).toBe(500);
    expect(lastAudit(sqlite, 800)?.action).toBe("match_rescore");
    const m = matchOf(sqlite, 800);
    expect(m.walkover_side).toBe("");
    expect(m.note).toBe(null);
    expect(standingOf(sqlite, 70, 500)).toMatchObject({ won: 1, pts: 3, gf: 2 });
  });

  it("淘汰赛平局必须录点球比分才能定晋级", async () => {
    const { env } = freshEnv();
    const res = await finish(env, 810, { scoreHome: 1, scoreAway: 1 });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("淘汰赛平局需录入点球比分才能定晋级");
  });

  it("点球比分相同 → 400", async () => {
    const { env } = freshEnv();
    const res = await finish(env, 810, { scoreHome: 1, scoreAway: 1, penHome: 4, penAway: 4 });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("点球比分不能相同");
  });

  it("淘汰赛点球决胜：winner 判给点球胜方", async () => {
    const { env, sqlite } = freshEnv();
    const res = await finish(env, 810, { scoreHome: 1, scoreAway: 1, penHome: 5, penAway: 4 });
    expect(res.status).toBe(200);
    expect((await res.json()).winner).toBe(500);
    expect(matchOf(sqlite, 810)).toMatchObject({
      score_home: 1,
      score_away: 1,
      pen_home: 5,
      pen_away: 4,
      winner_entry_id: 500,
    });
    // 淘汰阶段不产出积分榜
    expect(sqlAll(sqlite, "SELECT id FROM standing WHERE stage_id = 72").length).toBe(0);
  });

  it("淘汰赛双方弃权必须指定晋级方", async () => {
    const { env, sqlite } = freshEnv();
    const bad = await finish(env, 810, { walkoverSide: "both" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).message).toBe("双方弃权的淘汰赛必须指定晋级方");
    expect(matchOf(sqlite, 810).status).toBe("pending");

    const ok = await finish(env, 810, { walkoverSide: "both", winnerEntryId: 501 });
    expect(ok.status).toBe(200);
    expect((await ok.json()).winner).toBe(501);
    expect(matchOf(sqlite, 810)).toMatchObject({ winner_entry_id: 501, walkover_side: "both" });
  });

  it("晋级器回填下游对阵：两场首轮都决出后决赛才落位", async () => {
    const { env, sqlite } = freshEnv();
    await finish(env, 810, { scoreHome: 1, scoreAway: 0 });
    expect(matchOf(sqlite, 812).home_entry_id).toBe(null); // 另一场未决出 → 不回填

    const res = await finish(env, 811, { scoreHome: 0, scoreAway: 2 });
    expect(res.status).toBe(200);
    const final = matchOf(sqlite, 812);
    expect([final.home_entry_id, final.away_entry_id]).toEqual([500, 503]);
    expect(final.status).toBe("pending");
  });

  it("下游场次已开打且需换人 → 409，且终场写入回滚、审计不落", async () => {
    const { env, sqlite } = freshEnv();
    // 决赛已开打（status=live），且场上是「错误」的晋级方
    sqlite.prepare("DELETE FROM match WHERE stage_id = 72").run();
    const m = sqlite.prepare(
      `INSERT INTO match (id, stage_id, round, slot, leg, home_entry_id, away_entry_id, status, winner_entry_id, note, walkover_side)
       VALUES (?, 72, ?, ?, NULL, ?, ?, ?, ?, ?, '')`
    );
    m.run(820, 1, 1, 500, 501, "pending", null, null);
    // 虚拟位场：away 为空 + winner 预填，晋级器据此判定该 slot 已决出
    m.run(821, 1, 2, 502, null, "pending", 502, null);
    m.run(822, 2, 1, 503, 502, "live", null, null);

    const res = await finish(env, 820, { scoreHome: 1, scoreAway: 0 });
    expect(res.status).toBe(409);
    expect((await res.json()).message).toBe("后续场次已开打，晋级对阵无法更新");

    // 终场写入必须回滚：残留一场 finished 会让积分/晋级漂在错误状态
    expect(matchOf(sqlite, 820)).toMatchObject({
      status: "pending",
      score_home: null,
      score_away: null,
      winner_entry_id: null,
    });
    expect(matchOf(sqlite, 822)).toMatchObject({ home_entry_id: 503, away_entry_id: 502, status: "live" });
    expect(sqlGet<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM audit_log")!.n).toBe(0);
    // 缺陷 D2：补偿回滚没有复原 finished_at（只有比分/状态/winner/note），
    // 于是比赛退回 pending 却留着终场时间戳。此处钉住现状，见 TEST_PLAN.md D2。
    expect(matchOf(sqlite, 820).finished_at).not.toBeNull();
  });

  it("阶段收官自动生成下一阶段首轮：取人读的是陈旧积分榜快照（缺陷 D1）", async () => {
    const { env, sqlite } = freshEnv();
    // 循环赛阶段只留 4 场（不做完整单循环，代码只校验「全部完赛」）
    sqlite.prepare("DELETE FROM match WHERE stage_id IN (70, 72)").run();
    sqlite.prepare("UPDATE stage SET config_json = ? WHERE id = 72").run('{"source":{"take":2}}');
    const m = sqlite.prepare(
      `INSERT INTO match (id, stage_id, round, slot, leg, home_entry_id, away_entry_id, status, winner_entry_id, note, walkover_side)
       VALUES (?, 70, ?, ?, NULL, ?, ?, 'pending', NULL, NULL, '')`
    );
    m.run(800, 1, 1, 500, 501);
    m.run(801, 1, 2, 500, 503);
    m.run(802, 2, 1, 502, 501);
    m.run(803, 2, 2, 502, 503);

    const first = await finish(env, 800, { scoreHome: 1, scoreAway: 0 });
    expect((await first.json()).regenerated).toBe(false); // 阶段未收官 → 不生成
    await finish(env, 801, { scoreHome: 1, scoreAway: 0 });
    await finish(env, 802, { scoreHome: 0, scoreAway: 1 }); // 501 胜
    // 此刻 standing 表：500 = 6 分，501 = 3 分（净胜 0），502/503 各 0 分 → 第 2 名 = 501
    expect(standingOf(sqlite, 70, 500)).toMatchObject({ pts: 6 });
    expect(standingOf(sqlite, 70, 501)).toMatchObject({ pts: 3, gf: 1, ga: 1 });

    const last = await finish(env, 803, { scoreHome: 0, scoreAway: 3 }); // 503 胜
    expect((await last.json()).regenerated).toBe(true);

    // 真实名次应为 500(6分) → 503(3分, 净胜+2) → 501(3分, 净胜0)：第 2 名是 503
    const fresh = await app.request(
      "/api/admin/tournaments/7/standings",
      { headers: { Cookie: "whl_session=tok-admin" } },
      env
    );
    const board = (await fresh.json()) as {
      standings: { stageId: number; groups: { rows: { entryId: number; rank: number }[] }[] }[];
    };
    const rows = board.standings.find((s) => s.stageId === 70)!.groups[0].rows;
    expect(rows.map((r) => r.entryId)).toEqual([500, 503, 501, 502]);
    expect(rows.find((r) => r.entryId === 503)!.rank).toBe(2);

    const created = sqlAll<{ home_entry_id: number | null; away_entry_id: number | null }>(
      sqlite,
      "SELECT home_entry_id, away_entry_id FROM match WHERE stage_id = 72"
    );
    expect(created.length).toBe(1);
    // 现状：autoFill 的取人在「本场 finished」之后、但积分重算语句执行之前跑，
    // 读到的 standing 表还停在上一次重建的快照，刚完赛这一场（503 3:0）没被算进去，
    // 于是第 2 名被算成 501 —— 错队被写进季后赛对阵（用户可见后果）。
    // 修好后此处应为 away_entry_id: 503。缺陷 D1 记入 TEST_PLAN.md。
    expect(created[0]).toMatchObject({ home_entry_id: 500, away_entry_id: 501 });
  });
});

// ---------------------------------------------------------------------------
// 事件录入：POST / PUT / DELETE / GET /api/admin/matches/:id/events
// 这是比分与纪律数据的唯一人工来源（live 时实时累计、终场不传比分时也读它），
// 而 red_2y 由「同场第二张黄牌」派生、直接喂给停赛重放 —— 所以校验顺序也要钉住。
function addPlayers(sqlite: DatabaseSync) {
  const p = sqlite.prepare("INSERT INTO player (id, team_id, name, number) VALUES (?, ?, ?, ?)");
  p.run(1, 10, "甲射手", 9);
  p.run(2, 10, "甲助攻", 7);
  p.run(3, 11, "乙球员", 4);
  p.run(4, 12, "丙球员", 5);
  p.run(5, 13, "丁球员", 6);
}

const EVENT_HEADERS = { Cookie: "whl_session=tok-admin", "Content-Type": "application/json" };
const eventUrl = (matchId: number) => `/api/admin/matches/${matchId}/events`;
const postEvent = (env: Env, matchId: number, body: Record<string, unknown>) =>
  post(env, eventUrl(matchId), body);
const putEvent = (env: Env, matchId: number, eventId: number, body: Record<string, unknown>) =>
  app.request(
    `${eventUrl(matchId)}/${eventId}`,
    { method: "PUT", headers: EVENT_HEADERS, body: JSON.stringify(body) },
    env
  );
const delEvent = (env: Env, matchId: number, eventId: number) =>
  app.request(`${eventUrl(matchId)}/${eventId}`, { method: "DELETE", headers: EVENT_HEADERS }, env);
const eventsOf = (sqlite: DatabaseSync, matchId: number) =>
  sqlAll<{
    id: number;
    entry_id: number;
    player_id: number | null;
    assist_player_id: number | null;
    type: string;
    minute: number | null;
    created_by: number;
  }>(
    sqlite,
    "SELECT id, entry_id, player_id, assist_player_id, type, minute, created_by FROM match_event WHERE match_id = ? ORDER BY id",
    matchId
  );
const auditOf = (sqlite: DatabaseSync, targetId: number, action: string) =>
  sqlGet<{ detail_json: string }>(
    sqlite,
    "SELECT detail_json FROM audit_log WHERE target_id = ? AND action = ? ORDER BY id DESC LIMIT 1",
    targetId,
    action
  );

describe("scoring 事件录入（events）", () => {
  it("pending 场不能录事件；分钟范围的校验排在比赛状态之前", async () => {
    const { env } = freshEnv();
    const res = await postEvent(env, 800, { type: "goal", entryId: 500, playerId: 1 });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("比赛还没开打，开赛后才能录事件");

    const bad = await postEvent(env, 800, { type: "goal", entryId: 500, minute: 301 });
    expect(bad.status).toBe(400);
    expect((await bad.json()).message).toBe("分钟数应在 0-300 之间");
  });

  it("live 场录事件实时累计比分（乌龙球记对方），比分列此时不动", async () => {
    const { env, sqlite } = freshEnv();
    addPlayers(sqlite);
    await start(env, 800);

    const g = await postEvent(env, 800, { type: "goal", entryId: 500, playerId: 1, minute: 10 });
    expect(await g.json()).toEqual({ ok: true, scoreHome: 1, scoreAway: 0 });

    const og = await postEvent(env, 800, { type: "own_goal", entryId: 501, playerId: 3, minute: 20 });
    expect(await og.json()).toEqual({ ok: true, scoreHome: 2, scoreAway: 0 });

    const pen = await postEvent(env, 800, { type: "pen_goal", entryId: 501, playerId: 3, minute: 30 });
    expect(await pen.json()).toEqual({ ok: true, scoreHome: 2, scoreAway: 1 });

    // 实时比分只是派生值：match.score_* 仍为 null，只有 finish 才落库
    const m = matchOf(sqlite, 800);
    expect([m.score_home, m.score_away]).toEqual([null, null]);
    expect(eventsOf(sqlite, 800).map((e) => [e.type, e.entry_id, e.player_id, e.minute, e.created_by])).toEqual([
      ["goal", 500, 1, 10, 1],
      ["own_goal", 501, 3, 20, 1],
      ["pen_goal", 501, 3, 30, 1],
    ]);
    // 每条事件各写一行 event_create 审计，detail 带事件归属（最新一条是点球进球）
    expect(auditOf(sqlite, 800, "event_create")?.detail_json).toBe(
      JSON.stringify({ type: "pen_goal", entryId: 501, playerId: 3, assistPlayerId: null, minute: 30 })
    );
  });

  it("同场第二张黄牌自动转存 red_2y 并提示停赛场数，之后该球员再吃牌被拒", async () => {
    const { env, sqlite } = freshEnv();
    addPlayers(sqlite);
    await start(env, 800);

    const first = await postEvent(env, 800, { type: "yellow", entryId: 500, playerId: 1, minute: 15 });
    expect(await first.json()).toEqual({ ok: true, scoreHome: 0, scoreAway: 0 });

    const second = await postEvent(env, 800, { type: "yellow", entryId: 500, playerId: 1, minute: 40 });
    expect(await second.json()).toEqual({
      ok: true,
      scoreHome: 0,
      scoreAway: 0,
      notice: "第 2 张黄牌已自动记录为两黄变一红（停赛 1 场）",
    });
    expect(eventsOf(sqlite, 800).map((e) => e.type)).toEqual(["yellow", "red_2y"]);
    expect(auditOf(sqlite, 800, "event_create")?.detail_json).toContain('"red2y":true');

    for (const type of ["yellow", "red"]) {
      const res = await postEvent(env, 800, { type, entryId: 500, playerId: 1 });
      expect(res.status, type).toBe(400);
      expect((await res.json()).message).toBe("该球员本场已被罚下，如需更正请先删除红牌事件");
    }
  });

  it("球员与助攻的归属、组合校验（跨队 / 非进球记助攻 / 助攻缺射手 / 自我助攻）", async () => {
    const { env, sqlite } = freshEnv();
    addPlayers(sqlite);
    await start(env, 800);

    const cases: [Record<string, unknown>, string][] = [
      [{ type: "goal", entryId: 500, playerId: 3 }, "进球球员不属于该球队"],
      [{ type: "goal", entryId: 500, playerId: 1, assistPlayerId: 3 }, "助攻球员不属于该球队"],
      [{ type: "goal", entryId: 500, playerId: 1, assistPlayerId: 1 }, "助攻球员不能和进球球员是同一人"],
      [{ type: "yellow", entryId: 500, playerId: 1, assistPlayerId: 2 }, "只有进球和点球进球可以记助攻"],
      [{ type: "goal", entryId: 500, assistPlayerId: 2 }, "记助攻需要先选择进球球员"],
      [{ type: "goal", entryId: 502, playerId: 4 }, "该球队不在本场对阵中"],
    ];
    for (const [body, message] of cases) {
      const res = await postEvent(env, 800, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).message, JSON.stringify(body)).toBe(message);
    }
    expect(eventsOf(sqlite, 800)).toHaveLength(0);
  });

  it("事件类型白名单（red_2y 不开放手选）与 entryId 必填", async () => {
    const { env } = freshEnv();
    for (const type of ["red_2y", "goal2", ""]) {
      const res = await postEvent(env, 800, { type, entryId: 500 });
      expect(res.status, type).toBe(400);
      expect((await res.json()).message).toBe(
        "事件类型必须是 goal / pen_goal / pen_miss / own_goal / injury_minor / injury_major / yellow / red"
      );
    }
    const noEntry = await postEvent(env, 800, { type: "goal" });
    expect(noEntry.status).toBe(400);
    expect((await noEntry.json()).message).toBe("缺少所属球队 entryId");
  });

  it("删除事件：live 实时比分回退 + event_delete 审计；不存在 404", async () => {
    const { env, sqlite } = freshEnv();
    addPlayers(sqlite);
    await start(env, 800);
    await postEvent(env, 800, { type: "goal", entryId: 500, playerId: 1 });
    const eventId = eventsOf(sqlite, 800)[0].id;

    const res = await delEvent(env, 800, eventId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, scoreHome: 0, scoreAway: 0 });
    expect(eventsOf(sqlite, 800)).toHaveLength(0);
    // 审计记录被删事件的完整快照，便于回溯误删
    expect(auditOf(sqlite, 800, "event_delete")?.detail_json).toBe(
      JSON.stringify({ eventId, type: "goal", entryId: 500, playerId: 1, minute: null })
    );

    const again = await delEvent(env, 800, eventId);
    expect(again.status).toBe(404);
    expect((await again.json()).message).toBe("事件不存在");
  });

  it("编辑事件：纪律计数排除自身（黄牌改回黄牌不会误转 red_2y），改类型生效并留 before/after 审计", async () => {
    const { env, sqlite } = freshEnv();
    addPlayers(sqlite);
    await start(env, 800);
    await postEvent(env, 800, { type: "yellow", entryId: 500, playerId: 1, minute: 15 });
    const eventId = eventsOf(sqlite, 800)[0].id;

    // 计数 SQL 带 `id != ?`：保留原球员改分钟不会被自己那张黄牌顶成 red_2y
    const edit = await putEvent(env, 800, eventId, { type: "yellow", entryId: 500, playerId: 1, minute: 45 });
    expect(edit.status).toBe(200);
    expect(await edit.json()).toEqual({ ok: true, scoreHome: 0, scoreAway: 0 });
    expect(eventsOf(sqlite, 800)[0]).toMatchObject({ type: "yellow", minute: 45 });

    const audit = auditOf(sqlite, 800, "event_update")?.detail_json ?? "";
    expect(audit).toContain('"before"');
    expect(audit).toContain('"minute":45');

    // 改成直红确实落库：之后该球员再吃牌被拒
    const toRed = await putEvent(env, 800, eventId, { type: "red", entryId: 500, playerId: 1 });
    expect(toRed.status).toBe(200);
    expect(eventsOf(sqlite, 800)[0].type).toBe("red");
    expect((await postEvent(env, 800, { type: "yellow", entryId: 500, playerId: 1 })).status).toBe(400);
  });

  it("伤病事件挂着伤停登记时不许改类型（409）；删除时提示登记连带撤销且确实级联删除", async () => {
    const { env, sqlite } = freshEnv();
    addPlayers(sqlite);
    await start(env, 800);
    await postEvent(env, 800, { type: "injury_major", entryId: 500, playerId: 1, minute: 25 });
    const eventId = eventsOf(sqlite, 800)[0].id;
    sqlite
      .prepare(
        "INSERT INTO injury (id, team_id, player_id, event_id, injury_name, created_by) VALUES (901, 10, 1, ?, '大腿拉伤', 1)"
      )
      .run(eventId);

    const res = await putEvent(env, 800, eventId, { type: "goal", entryId: 500, playerId: 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).message).toBe("该事件挂着伤停登记，请先在伤停管理里撤销登记再改类型");

    const del = await delEvent(env, 800, eventId);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({
      ok: true,
      scoreHome: 0,
      scoreAway: 0,
      notice: "该伤病事件挂着的伤停登记已一并撤销",
    });
    // injury.event_id 是 ON DELETE CASCADE，且测试库 PRAGMA foreign_keys=ON（tests/d1.ts:66）
    expect(sqlGet(sqlite, "SELECT id FROM injury WHERE id = 901")).toBeUndefined();
    expect(eventsOf(sqlite, 800)).toHaveLength(0); // 事件行本身也确实删掉了
  });

  it("GET 事件列表：按 id 升序并返回完整字段", async () => {
    const { env, sqlite } = freshEnv();
    addPlayers(sqlite);
    await start(env, 800);
    await postEvent(env, 800, { type: "goal", entryId: 500, playerId: 1, minute: 5 });
    await postEvent(env, 800, { type: "goal", entryId: 500, playerId: 2, assistPlayerId: 1, minute: 9 });

    const res = await app.request(eventUrl(800), { headers: EVENT_HEADERS }, env);
    expect(res.status).toBe(200);
    const { events } = (await res.json()) as { events: Array<Record<string, unknown>> };
    expect(events.map((e) => [e.type, e.playerId, e.assistPlayerId, e.minute])).toEqual([
      ["goal", 1, null, 5],
      ["goal", 2, 1, 9],
    ]);
    expect(events[0].matchId).toBe(800);
  });
});
