// 停赛规则引擎：worker/lib/suspension.ts（纯派生，不落库）+ worker/routes/admin/tournaments.ts 的三个端点。
// 引擎口径（文件头注释）：直红停 redBan 场、两黄变一红停 red2yBan 场、累积 yellowThreshold 张黄牌停 1 场并清零；
// 红黄牌停赛并行叠加；pending 场不消耗；轮空场不算比赛；弃权场只有非弃权方消耗。
// 这里钉：停赛重放的消耗次序、轮空/弃权例外、清零锚点的两段重放、配置归一与坏值回退、榜单停赛标记，
// 以及「删事件后自动生效」——引擎无任何反冲逻辑，全部结果都由当前数据实时推出。
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import app from "../worker/index";
import { applyMigrations, createTestD1, createTestKV, sqlGet } from "./d1";

type Env = Record<string, unknown>;
type PlayerStatus = {
  playerId: number;
  playerName: string;
  teamId: number;
  teamName: string;
  entryId: number;
  remaining: number;
  yellows: number;
};
type SuspConfig = {
  redBan: number;
  red2yBan: number;
  yellowThreshold: number;
  yellowResetAt: string | null;
};
type CardsRow = { playerId: number; playerName: string; yellows: number; reds: number; suspended?: boolean };

const TID = 30;
const SEQ_BASE = 4001; // 比赛 id 基数：与 entry/player id 拉开，避免写错行号时静默通过

// 赛事 30「停赛赛」：两队六个球员。
//   队伍 30 红队：entry 300，球员 300 张三 / 301 李四
//   队伍 31 蓝队：entry 301，球员 302 王五 / 303 赵六
function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  sqlite
    .prepare(
      "INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(1, "管理员", "", "x", "admin", 0, 0);

  const iso = "2026-02-01T00:00:00Z";
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (?, 1, ?, ?)").run(30, "红队", iso);
  sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (?, 1, ?, ?)").run(31, "蓝队", iso);
  sqlite
    .prepare("INSERT INTO tournament (id, org_id, name, format, status, created_by, created_at) VALUES (?, 1, ?, 'round_robin', 'running', 1, ?)")
    .run(TID, "停赛赛", iso);
  const st = sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order, name) VALUES (?, ?, ?, ?, ?)");
  st.run(300, TID, "round_robin", 1, "常规赛");
  st.run(302, TID, "elim", 2, "淘汰赛");

  const e = sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed, group_id) VALUES (?, ?, ?, ?, NULL)");
  e.run(300, TID, 30, 1);
  e.run(301, TID, 31, 2);
  const p = sqlite.prepare("INSERT INTO player (id, team_id, name, number, created_at) VALUES (?, ?, ?, NULL, ?)");
  p.run(300, 30, "张三", iso);
  p.run(301, 30, "李四", iso);
  p.run(302, 31, "王五", iso);
  p.run(303, 31, "赵六", iso);

  const env: Env = {
    DB: createTestD1(sqlite),
    KV: createTestKV(new Map([["sess:tok-admin", JSON.stringify({ userId: 1 })]])) as unknown as KVNamespace,
    MEDIA: {} as never,
    ASSETS: {} as never,
  };
  return { env, sqlite };
}

const AUTH = { Cookie: "whl_session=tok-admin", "Content-Type": "application/json" };

// 生成一段比赛序列：round 递增即比赛序，主队固定 entry 300、客队 entry 301
function seq(sqlite: DatabaseSync, statuses: string[], stageId = 300): number[] {
  const ins = sqlite.prepare(
    `INSERT INTO match (id, stage_id, round, slot, leg, home_entry_id, away_entry_id, status, winner_entry_id, note, walkover_side)
     VALUES (?, ?, ?, 1, NULL, 300, 301, ?, NULL, NULL, '')`
  );
  return statuses.map((s, i) => {
    const id = SEQ_BASE + i;
    ins.run(id, stageId, i + 1, s);
    return id;
  });
}

function setStatus(sqlite: DatabaseSync, matchId: number, status: string) {
  sqlite.prepare("UPDATE match SET status = ? WHERE id = ?").run(status, matchId);
}
function setWalkover(sqlite: DatabaseSync, matchId: number, side: string) {
  sqlite.prepare("UPDATE match SET walkover_side = ? WHERE id = ?").run(side, matchId);
}
function setConfigJson(sqlite: DatabaseSync, json: string) {
  sqlite.prepare("UPDATE tournament SET config_json = ? WHERE id = ?").run(json, TID);
}

let nextEventId = 5001;
function ev(
  sqlite: DatabaseSync,
  matchId: number,
  playerId: number,
  type: string,
  opts: { entryId?: number; createdAt?: string } = {}
) {
  const id = nextEventId++;
  const entryId = opts.entryId ?? (playerId === 300 || playerId === 301 ? 300 : 301);
  sqlite
    .prepare(
      `INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 30, 1, ?)`
    )
    .run(id, matchId, entryId, playerId, type, opts.createdAt ?? "2026-02-10T00:00:00.000Z");
  return id;
}

async function status(env: Env, tid = TID): Promise<{ config: SuspConfig; players: PlayerStatus[] }> {
  const res = await app.request(`/api/admin/tournaments/${tid}/suspensions`, { headers: AUTH }, env);
  expect(res.status).toBe(200);
  return (await res.json()) as { config: SuspConfig; players: PlayerStatus[] };
}
async function players(env: Env, tid = TID): Promise<PlayerStatus[]> {
  return (await status(env, tid)).players;
}
const putCfg = (env: Env, body: unknown, tid = TID) =>
  app.request(
    `/api/admin/tournaments/${tid}/suspensions`,
    { method: "PUT", headers: AUTH, body: JSON.stringify(body) },
    env
  );
const resetYellows = (env: Env, tid = TID) =>
  app.request(`/api/admin/tournaments/${tid}/suspensions/reset-yellows`, { method: "POST", headers: AUTH }, env);

describe("停赛重放：直红与两黄变一红", () => {
  it("直红默认停 2 场，逐场消耗，pending 场不消耗", async () => {
    const { env, sqlite } = freshEnv();
    const [m1, m2, m3, m4] = seq(sqlite, ["finished", "pending", "pending", "pending"]);
    ev(sqlite, m1, 300, "red");

    const first = await players(env);
    expect(first).toHaveLength(1); // 只列有红黄牌记录的球员
    expect(first[0]).toMatchObject({
      playerId: 300,
      playerName: "张三",
      teamId: 30,
      teamName: "红队",
      entryId: 300,
      remaining: 2,
      yellows: 0,
    });

    setStatus(sqlite, m2, "live"); // live 也算一场消耗
    expect((await players(env))[0].remaining).toBe(1);

    setStatus(sqlite, m3, "finished");
    expect((await players(env))[0].remaining).toBe(0);

    setStatus(sqlite, m4, "finished");
    expect((await players(env))[0].remaining).toBe(0); // 消耗不会出现负数
  });

  it("停赛场数可配：改 redBan 立即改变剩余场数，0 = 不停赛", async () => {
    const { env, sqlite } = freshEnv();
    const ids = seq(sqlite, ["finished", "pending", "pending"]);
    ev(sqlite, ids[0], 300, "red");

    expect((await players(env))[0].remaining).toBe(2); // 默认 redBan=2
    const r1 = await putCfg(env, { redBan: 1, red2yBan: 1, yellowThreshold: 3 });
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { config: SuspConfig }).config.redBan).toBe(1);
    expect((await players(env))[0].remaining).toBe(1);

    await putCfg(env, { redBan: 0, red2yBan: 0, yellowThreshold: 0 });
    expect((await players(env))[0].remaining).toBe(0); // 0 场 = 红牌不触发停赛
  });

  it("两黄变一红停 red2yBan 场，且同场黄牌不计入黄牌累积", async () => {
    const { env, sqlite } = freshEnv();
    const [m1, m2, m3] = seq(sqlite, ["finished", "pending", "pending"]);
    // 后端在第二张黄牌时把该事件改存为 red_2y（MatchesTab 注释：UI 不开放手选），
    // 所以数据形状是「1 张 yellow + 1 条 red_2y」，而不是两张黄牌。
    ev(sqlite, m1, 300, "yellow");
    ev(sqlite, m1, 300, "red_2y");
    ev(sqlite, m1, 301, "yellow");

    const list = await players(env);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ playerId: 300, remaining: 1, yellows: 0 }); // 同场黄牌被跳过
    expect(list[1]).toMatchObject({ playerId: 301, remaining: 0, yellows: 1 });

    // 榜单口径一致：red_2y 计入红牌数，同场黄牌不计入黄牌数
    const res = await app.request(`/api/admin/tournaments/${TID}/toplists`, { headers: AUTH }, env);
    expect(res.status).toBe(200);
    const cards = ((await res.json()) as { cardsPlayers: CardsRow[] }).cardsPlayers;
    expect(cards.find((r) => r.playerId === 300)).toMatchObject({ yellows: 0, reds: 1, suspended: true });
    expect(cards.find((r) => r.playerId === 301)).toMatchObject({ yellows: 1, reds: 0, suspended: false });

    setStatus(sqlite, m2, "finished"); // 停 1 场被 m2 消耗掉，停赛标记随之消失
    setStatus(sqlite, m3, "finished");
    expect((await players(env))[0]).toMatchObject({ remaining: 0 });

    const res2 = await app.request(`/api/admin/tournaments/${TID}/toplists`, { headers: AUTH }, env);
    const cards2 = ((await res2.json()) as { cardsPlayers: CardsRow[] }).cardsPlayers;
    expect(cards2.find((r) => r.playerId === 300)?.suspended).toBe(false);
  });

  it("红牌与黄牌停赛并行叠加：红牌停完，黄牌停赛仍挂着", async () => {
    const { env, sqlite } = freshEnv();
    const [m1, m2, m3, m4] = seq(sqlite, ["finished", "finished", "finished", "pending"]);
    ev(sqlite, m1, 300, "yellow"); // 累积 1
    ev(sqlite, m1, 300, "red"); // 直红停 2 场，从 m2 起
    ev(sqlite, m2, 300, "yellow"); // 累积 2，同时消耗红牌停赛
    ev(sqlite, m3, 300, "yellow"); // 累积 3 → 触发黄牌停赛 1 场，从 m4 起，计数清零

    const p = (await players(env))[0];
    expect(p).toMatchObject({ remaining: 1, yellows: 0 }); // 红牌停赛已在 m2/m3 消耗完，剩下的是黄牌停赛

    setStatus(sqlite, m4, "finished");
    expect((await players(env))[0].remaining).toBe(0);
  });

  it("删掉红牌事件后停赛立即消失（纯派生，无落库状态）", async () => {
    const { env, sqlite } = freshEnv();
    const ids = seq(sqlite, ["finished", "pending"]);
    const evId = ev(sqlite, ids[0], 300, "red");
    expect((await players(env))[0].remaining).toBe(2);

    const res = await app.request(
      `/api/admin/matches/${ids[0]}/events/${evId}`,
      { method: "DELETE", headers: AUTH },
      env
    );
    expect(res.status).toBe(200);
    expect(await players(env)).toEqual([]);
  });
});

describe("停赛重放：黄牌累积与阈值", () => {
  it("累积满 3 张黄牌停 1 场并清零，跨比赛累积；同场先消耗后触发", async () => {
    const { env, sqlite } = freshEnv();
    const [m1, m2, m3, m4] = seq(sqlite, ["finished", "finished", "finished", "pending"]);
    ev(sqlite, m1, 300, "yellow");
    ev(sqlite, m2, 300, "yellow");
    ev(sqlite, m3, 300, "yellow");

    expect((await players(env))[0]).toMatchObject({ remaining: 1, yellows: 0 });

    // m4 既消耗上一张停赛单，也重新开始累计黄牌
    setStatus(sqlite, m4, "finished");
    ev(sqlite, m4, 300, "yellow");
    expect((await players(env))[0]).toMatchObject({ remaining: 0, yellows: 1 });
  });

  it("阈值可配：yellowThreshold=2 时第 2 张黄牌就停赛", async () => {
    const { env, sqlite } = freshEnv();
    const [m1, m2, m3] = seq(sqlite, ["finished", "finished", "pending"]);
    ev(sqlite, m1, 300, "yellow");
    ev(sqlite, m2, 300, "yellow");
    expect((await players(env))[0]).toMatchObject({ remaining: 0, yellows: 2 }); // 默认阈值 3，不停赛

    await putCfg(env, { redBan: 2, red2yBan: 1, yellowThreshold: 2 });
    expect((await players(env))[0]).toMatchObject({ remaining: 1, yellows: 0 });

    await putCfg(env, { redBan: 2, red2yBan: 1, yellowThreshold: 0 });
    setStatus(sqlite, m3, "finished");
    ev(sqlite, m3, 300, "yellow");
    expect((await players(env))[0]).toMatchObject({ remaining: 0, yellows: 3 }); // 0 = 只累计不停赛
  });
});

describe("停赛重放：轮空与弃权", () => {
  it("轮空场不进比赛序，因而不消耗停赛", async () => {
    const { env, sqlite } = freshEnv();
    const [m1, m2, m3] = seq(sqlite, ["finished", "finished", "pending"]);
    ev(sqlite, m1, 300, "red");
    sqlite.prepare("UPDATE match SET note = '轮空', away_entry_id = NULL, winner_entry_id = 300 WHERE id = ?").run(m2);

    // 若轮空也算一场，m2 就会消耗掉一张停赛单（remaining 会变成 1）
    expect((await players(env))[0].remaining).toBe(2);

    setStatus(sqlite, m3, "finished");
    expect((await players(env))[0].remaining).toBe(1); // 真正消耗停赛的是 m3
  });

  it("弃权方不消耗停赛，对手照常消耗；双弃权双方都不消耗", async () => {
    const { env, sqlite } = freshEnv();
    const [m1, m2, m3] = seq(sqlite, ["finished", "finished", "pending"]);
    ev(sqlite, m1, 300, "red"); // 红队（主队）
    ev(sqlite, m1, 302, "red"); // 蓝队（客队）
    setWalkover(sqlite, m2, "home"); // 红队弃权：红队不消耗，蓝队照常消耗

    let list = await players(env);
    expect(list.find((p) => p.playerId === 300)).toMatchObject({ remaining: 2 });
    expect(list.find((p) => p.playerId === 302)).toMatchObject({ remaining: 1 });

    setWalkover(sqlite, m2, "both"); // 双弃权：谁都不消耗
    list = await players(env);
    expect(list.find((p) => p.playerId === 300)).toMatchObject({ remaining: 2 });
    expect(list.find((p) => p.playerId === 302)).toMatchObject({ remaining: 2 });

    setWalkover(sqlite, m2, "home");
    setStatus(sqlite, m3, "finished"); // 一场正常比赛：双方各消耗一次；红队只剩 m3 这一次可消耗
    list = await players(env);
    expect(list.find((p) => p.playerId === 300)).toMatchObject({ remaining: 1 });
    expect(list.find((p) => p.playerId === 302)).toMatchObject({ remaining: 0 }); // m2 + m3 各消耗一次
  });

  it("客队弃权：只消耗主队球员的停赛（弃权方按本场主客身份判定）", async () => {
    const { env, sqlite } = freshEnv();
    const [m1, m2, m3] = seq(sqlite, ["finished", "finished", "finished"]);
    ev(sqlite, m1, 300, "red"); // 红队 = 主队（entry 300）
    ev(sqlite, m1, 302, "red"); // 蓝队 = 客队（entry 301）
    setWalkover(sqlite, m2, "away"); // 蓝队弃权：蓝队不消耗，主队照常消耗

    const list = await players(env);
    expect(list.find((p) => p.playerId === 300)).toMatchObject({ remaining: 0 }); // m2 + m3
    expect(list.find((p) => p.playerId === 302)).toMatchObject({ remaining: 1 }); // 只剩 m3
  });
});

describe("停赛重放：清零锚点（yellowResetAt）", () => {
  const ANCHOR = "2026-06-01T00:00:00.000Z";
  const anchorCfg = (extra = "") =>
    `{"suspension":{"redBan":2,"red2yBan":1,"yellowThreshold":3,"yellowResetAt":"${ANCHOR}"}${extra}}`;

  it("锚点后黄牌从零重计：锚点前后各 2 张不再凑满 3 张", async () => {
    const { env, sqlite } = freshEnv();
    const [m1, m2, m3, m4] = seq(sqlite, ["finished", "finished", "finished", "finished"]);
    setConfigJson(sqlite, anchorCfg());
    ev(sqlite, m1, 300, "yellow", { createdAt: "2026-05-01T00:00:00.000Z" });
    ev(sqlite, m2, 300, "yellow", { createdAt: "2026-05-02T00:00:00.000Z" });
    ev(sqlite, m3, 300, "yellow", { createdAt: "2026-07-01T00:00:00.000Z" });
    ev(sqlite, m4, 300, "yellow", { createdAt: "2026-07-02T00:00:00.000Z" });

    expect((await players(env))[0]).toMatchObject({ remaining: 0, yellows: 2 });

    // 去掉锚点后四张黄牌连贯累计：第 3 张触发停赛 1 场（由 m4 消耗），故黄牌数落在 1
    setConfigJson(sqlite, `{"suspension":{"redBan":2,"red2yBan":1,"yellowThreshold":3}}`);
    expect((await players(env))[0]).toMatchObject({ remaining: 0, yellows: 1 });
  });

  it("锚点只重置黄牌：已生效的红牌停赛照常按比赛序消耗", async () => {
    const { env, sqlite } = freshEnv();
    const [m1, m2, m3] = seq(sqlite, ["finished", "finished", "pending"]);
    setConfigJson(sqlite, anchorCfg());
    ev(sqlite, m1, 300, "yellow", { createdAt: "2026-05-01T00:00:00.000Z" });
    ev(sqlite, m1, 300, "red", { createdAt: "2026-05-01T00:00:00.000Z" });
    ev(sqlite, m2, 300, "yellow", { createdAt: "2026-05-02T00:00:00.000Z" });

    expect((await players(env))[0]).toMatchObject({ remaining: 1, yellows: 0 }); // m2 消耗掉 1 场红牌停赛

    setConfigJson(sqlite, `{"suspension":{"redBan":2,"red2yBan":1,"yellowThreshold":3}}`);
    expect((await players(env))[0]).toMatchObject({ remaining: 1, yellows: 2 }); // 红牌停赛结果不变
  });

  it("锚点边界：created_at 恰好等于锚点的黄牌算锚点前段（谓词是 <= 与 >）", async () => {
    const { env, sqlite } = freshEnv();
    const [m1, m2, m3] = seq(sqlite, ["finished", "finished", "finished"]);
    // 阈值降到 2：只要锚点后累积到 2 张就会停赛，从而让边界取向可观测
    setConfigJson(
      sqlite,
      `{"suspension":{"redBan":2,"red2yBan":1,"yellowThreshold":2,"yellowResetAt":"${ANCHOR}"}}`
    );
    ev(sqlite, m1, 300, "yellow", { createdAt: ANCHOR }); // 恰好等于锚点 → 归前段
    ev(sqlite, m2, 300, "yellow", { createdAt: "2026-07-01T00:00:00.000Z" });

    // 若边界取向相反（恰好等于算锚点后），锚点后就有 2 张黄牌 → remaining 会是 1
    expect((await players(env))[0]).toMatchObject({ remaining: 0, yellows: 1 });

    // 对照组：两张黄牌都严格在锚点之后，阈值确实生效（排除「锚点后从不触发」的误读）
    ev(sqlite, m3, 300, "yellow", { createdAt: "2026-07-02T00:00:00.000Z" });
    expect((await players(env))[0]).toMatchObject({ remaining: 1, yellows: 0 });
  });

  it("reset-yellows 写入毫秒时间戳锚点并清零现有黄牌；随后 PUT 参数不清掉锚点", async () => {
    const { env, sqlite } = freshEnv();
    const [m1, m2] = seq(sqlite, ["finished", "finished"]);
    ev(sqlite, m1, 300, "yellow", { createdAt: "2020-01-01T00:00:00.000Z" });
    ev(sqlite, m2, 300, "yellow", { createdAt: "2020-01-02T00:00:00.000Z" });
    expect((await players(env))[0].yellows).toBe(2);

    const res = await resetYellows(env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; yellowResetAt: string };
    expect(body.ok).toBe(true);
    // 必须保留毫秒：与 match_event.created_at 做字典序比较
    expect(body.yellowResetAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const after = await status(env);
    expect(after.config.yellowResetAt).toBe(body.yellowResetAt); // 锚点落库
    expect(after.players[0].yellows).toBe(0); // 历史黄牌全部在锚点前 → 清零

    const put = await putCfg(env, { redBan: 3, red2yBan: 2, yellowThreshold: 5 });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { config: SuspConfig }).config).toEqual({
      redBan: 3,
      red2yBan: 2,
      yellowThreshold: 5,
      yellowResetAt: body.yellowResetAt, // PUT 不提供锚点，但保留原值
    });
  });
});

describe("停赛配置与榜单标记", () => {
  it("PUT 归一：缺字段/越界/非数字拒绝，数字串与小数被接受并取整", async () => {
    const { env, sqlite } = freshEnv();
    seq(sqlite, ["finished"]);

    expect((await putCfg(env, {})).status).toBe(400);
    expect((await putCfg(env, { redBan: -1, red2yBan: 1, yellowThreshold: 3 })).status).toBe(400);
    expect((await putCfg(env, { redBan: 11, red2yBan: 1, yellowThreshold: 3 })).status).toBe(400);
    expect((await putCfg(env, null)).status).toBe(400);
    expect((await putCfg(env, "nope")).status).toBe(400);

    const loose = await putCfg(env, { redBan: 1.9, red2yBan: "2", yellowThreshold: 3 });
    expect(loose.status).toBe(200);
    expect(((await loose.json()) as { config: SuspConfig }).config).toMatchObject({
      redBan: 1, // Math.floor
      red2yBan: 2, // 数字串被接受
    });

    // 请求体里的 yellowResetAt 不生效：锚点只能由 reset-yellows 写
    const smuggled = await putCfg(env, {
      redBan: 2,
      red2yBan: 1,
      yellowThreshold: 3,
      yellowResetAt: "2020-01-01T00:00:00.000Z",
    });
    expect(((await smuggled.json()) as { config: SuspConfig }).config.yellowResetAt).toBeNull();
  });

  it("PUT 只覆盖 suspension 段，不动同赛事其它配置（同分规则）", async () => {
    const { env, sqlite } = freshEnv();
    seq(sqlite, ["finished"]);
    setConfigJson(sqlite, '{"tiebreakers":["gd","h2h"],"suspension":{"redBan":1}}');

    const res = await putCfg(env, { redBan: 4, red2yBan: 3, yellowThreshold: 6 });
    expect(res.status).toBe(200);
    const raw = sqlGet<{ config_json: string }>(sqlite, "SELECT config_json FROM tournament WHERE id = ?", TID);
    const cfg = JSON.parse(raw!.config_json) as { tiebreakers: string[]; suspension: SuspConfig };
    expect(cfg.tiebreakers).toEqual(["gd", "h2h"]);
    expect(cfg.suspension).toEqual({ redBan: 4, red2yBan: 3, yellowThreshold: 6, yellowResetAt: null });
  });

  it("配置坏值逐字段回退默认，config_json 整体坏掉也用默认", async () => {
    const { env, sqlite } = freshEnv();
    seq(sqlite, ["finished"]);

    setConfigJson(sqlite, "{{{ 不是 JSON");
    expect((await status(env)).config).toEqual({
      redBan: 2,
      red2yBan: 1,
      yellowThreshold: 3,
      yellowResetAt: null,
    });

    setConfigJson(sqlite, `{"suspension":{"redBan":99,"red2yBan":"x","yellowResetAt":123}}`);
    expect((await status(env)).config).toEqual({
      redBan: 2, // 99 超上限 → 回退
      red2yBan: 1, // 非数字 → 回退
      yellowThreshold: 3, // 缺字段 → 回退
      yellowResetAt: null, // 非字符串 → 回退
    });
  });

  it("停赛球员在榜单上带 suspended 标记", async () => {
    const { env, sqlite } = freshEnv();
    const [m1, m2] = seq(sqlite, ["finished", "finished"]);
    ev(sqlite, m1, 300, "red"); // 停 2 场，m2 消耗 1 → 仍停赛
    ev(sqlite, m1, 301, "yellow"); // 只累计，不停赛

    const res = await app.request(`/api/admin/tournaments/${TID}/toplists`, { headers: AUTH }, env);
    const cards = ((await res.json()) as { cardsPlayers: CardsRow[] }).cardsPlayers;
    expect(cards.find((r) => r.playerId === 300)?.suspended).toBe(true);
    expect(cards.find((r) => r.playerId === 301)?.suspended).toBe(false);
  });

  it("排序：剩余停赛场数 → 黄牌数 → 姓名", async () => {
    const { env, sqlite } = freshEnv();
    const [m1, m2, m3] = seq(sqlite, ["finished", "finished", "finished"]);
    ev(sqlite, m1, 300, "yellow"); // 张三：1 黄
    ev(sqlite, m3, 300, "red"); // 张三：停 2 场（末场触发，之后无比赛）
    ev(sqlite, m1, 301, "yellow"); // 李四：2 黄
    ev(sqlite, m2, 301, "yellow");
    ev(sqlite, m3, 301, "red"); // 李四：停 2 场
    ev(sqlite, m2, 302, "red"); // 王五：停 1 场（m3 消耗一次）
    ev(sqlite, m2, 303, "red"); // 赵六：停 1 场

    // 末两位剩余停赛与黄牌数全同，只由姓名破并列；这里先显式断言本机 ICU 的中文排序取向，
    // 免得换到 small-icu 构建时排序翻面却看起来像停赛逻辑坏了
    expect("王五".localeCompare("赵六", "zh")).toBeLessThan(0);
    expect((await players(env)).map((p) => [p.playerName, p.remaining, p.yellows])).toEqual([
      ["李四", 2, 2], // 同为停 2 场，黄牌多者在前
      ["张三", 2, 1],
      ["王五", 1, 0], // 同为停 1 场 0 黄 → 姓名（王 < 赵）
      ["赵六", 1, 0],
    ]);
  });

  it("三个端点对不存在的赛事返回 404（校验先于存在性检查）", async () => {
    const { env } = freshEnv();
    const missing = 999;
    const get = await app.request(`/api/admin/tournaments/${missing}/suspensions`, { headers: AUTH }, env);
    expect(get.status).toBe(404);
    expect(((await get.json()) as { message: string }).message).toBe("赛事不存在");

    const put = await putCfg(env, { redBan: 2, red2yBan: 1, yellowThreshold: 3 }, missing);
    expect(put.status).toBe(404);

    const reset = await resetYellows(env, missing);
    expect(reset.status).toBe(404);

    // 非法请求体先被拦，不落到 404
    const bad = await putCfg(env, { redBan: 999 }, missing);
    expect(bad.status).toBe(400);
  });
});
