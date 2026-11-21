// C5 全量回归（汇总任务 4/8 的草稿与新增）：状态机动词、呼吸句预算、seal 门槛、
// 近况 2.0（角色门控/P7/预算/T3/平局更正面方）、标题档位与优先级、导语 sl、哑火拆池、
// C2 句法（拆句标点/转折时机）、改判自动重写对拍。
// fixture 模式仿 tests/news.assist.test.ts：node:sqlite + applyMigrations + createTestD1。
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, createTestD1, insertPlayer } from "./d1";
import { buildMatchReport } from "../worker/lib/report";
import {
  BREATH,
  MATCH_DATA_PARA,
  RESULT_TITLE,
  matchDataPara,
  pickBreath,
  pickResultHook,
  pickResultTitle,
} from "../worker/lib/copybanks";
import { computeMatchFacts, type MatchFacts } from "../worker/lib/narrativeFacts";

interface GoalSpec {
  id: number;
  matchId: number;
  entryId: number;
  playerId: number;
  minute: number;
  type?: "goal" | "pen_goal" | "own_goal";
  assistId?: number | null;
}
interface PrevMatchSpec {
  id: number;
  round: number;
  slot: number;
  homeEntryId: number;
  awayEntryId: number;
  scoreHome: number;
  scoreAway: number;
  day: number;
}
interface ReportOpts {
  matchId: number;
  /** 报告场主客（默认 500=红队主 / 501=蓝队客） */
  homeEntryId?: number;
  awayEntryId?: number;
  scoreHome: number;
  scoreAway: number;
  goals: GoalSpec[];
  reds?: Array<{ id: number; matchId: number; entryId: number; playerId: number; minute: number }>;
  penMiss?: Array<{ id: number; matchId: number; entryId: number; playerId: number; minute: number }>;
  prevMatches?: PrevMatchSpec[];
  /** (stageId=70) 当前榜行——T3 排名走势与 aftermath 积分段的输入 */
  standings?: Array<{ entryId: number; played: number; won: number; drawn: number; lost: number; pts: number; gf: number; ga: number }>;
  /** motm_vote 行（P7：上一场票王） */
  votes?: Array<{ matchId: number; userId: number; playerId: number }>;
  /** P1 复出：playerId 的伤情事件挂在 eventMatchId，missMatchIds 各勾一场缺阵 */
  injury?: { playerId: number; eventMatchId: number; missMatchIds: number[] } | null;
}

// 红队(10, entry 500) / 蓝队(11, entry 501) / 丙队(12, entry 502)；球员 100/101/102 红、200/201 蓝、300 丙
function reportDb(opts: ReportOpts): { db: ReturnType<typeof createTestD1>; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const iso = "2026-01-01T00:00:00Z";
  for (const u of [1, 2, 3]) {
    sqlite
      .prepare("INSERT INTO user (id, name, email, password_hash, role, locked, must_change_pw) VALUES (?, ?, '', 'x', 'admin', 0, 0)")
      .run(u, `用户${u}`);
  }
  for (const [id, name] of [
    [10, "红队"],
    [11, "蓝队"],
    [12, "丙队"],
  ] as const) {
    sqlite.prepare("INSERT INTO team (id, org_id, name, created_at) VALUES (?, 1, ?, ?)").run(id, name, iso);
  }
  for (const [id, team, name] of [
    [100, 10, "红前锋"],
    [101, 10, "红中场"],
    [102, 10, "红边锋"],
    [200, 11, "蓝前锋"],
    [201, 11, "蓝中场"],
    [300, 12, "丙球员"],
  ] as const) {
    insertPlayer(sqlite, { id, teamId: team, name });
  }
  sqlite
    .prepare("INSERT INTO tournament (id, org_id, name, format, status, created_by) VALUES (7, 1, '联赛', 'round_robin', 'running', 1)")
    .run();
  sqlite.prepare("INSERT INTO stage (id, tournament_id, kind, sort_order) VALUES (70, 7, 'round_robin', 1)").run();
  for (const [id, team, seed] of [
    [500, 10, 1],
    [501, 11, 2],
    [502, 12, 3],
  ] as const) {
    sqlite.prepare("INSERT INTO entry (id, tournament_id, team_id, seed) VALUES (?, 7, ?, ?)").run(id, team, seed);
  }
  if (opts.standings) {
    const st = sqlite.prepare(
      "INSERT INTO standing (stage_id, group_id, entry_id, played, won, drawn, lost, pts, gf, ga, pen_won, pen_lost) VALUES (70, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)",
    );
    for (const s of opts.standings) st.run(s.entryId, s.played, s.won, s.drawn, s.lost, s.pts, s.gf, s.ga);
  }
  const mk = sqlite.prepare(
    "INSERT INTO match (id, stage_id, round, slot, home_entry_id, away_entry_id, score_home, score_away, status, finished_at) VALUES (?, 70, ?, ?, ?, ?, ?, ?, 'finished', ?)",
  );
  const t = (h: number) => new Date(Date.UTC(2026, 0, h, 12)).toISOString();
  const homeEntryId = opts.homeEntryId ?? 500;
  const awayEntryId = opts.awayEntryId ?? 501;
  mk.run(opts.matchId, 2, 2, homeEntryId, awayEntryId, opts.scoreHome, opts.scoreAway, t(7));
  for (const pm of opts.prevMatches ?? []) {
    mk.run(pm.id, pm.round, pm.slot, pm.homeEntryId, pm.awayEntryId, pm.scoreHome, pm.scoreAway, t(pm.day));
  }
  const goal = sqlite.prepare(
    "INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, assist_player_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
  );
  for (const g of opts.goals) {
    goal.run(g.id, g.matchId, g.entryId, g.playerId, g.type ?? "goal", g.minute, g.assistId ?? null);
  }
  const red = sqlite.prepare(
    "INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, created_by) VALUES (?, ?, ?, ?, 'red', ?, 1)",
  );
  for (const r of opts.reds ?? []) red.run(r.id, r.matchId, r.entryId, r.playerId, r.minute);
  const pm = sqlite.prepare(
    "INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, created_by) VALUES (?, ?, ?, ?, 'pen_miss', ?, 1)",
  );
  for (const p of opts.penMiss ?? []) pm.run(p.id, p.matchId, p.entryId, p.playerId, p.minute);
  const vote = sqlite.prepare("INSERT INTO motm_vote (match_id, user_id, player_id) VALUES (?, ?, ?)");
  for (const v of opts.votes ?? []) vote.run(v.matchId, v.userId, v.playerId);
  if (opts.injury) {
    const injEventId = 9000 + opts.matchId;
    sqlite
      .prepare("INSERT INTO match_event (id, match_id, entry_id, player_id, type, minute, created_by) VALUES (?, ?, 500, ?, 'injury_minor', 85, 1)")
      .run(injEventId, opts.injury.eventMatchId, opts.injury.playerId);
    const inj = sqlite
      .prepare("INSERT INTO injury (team_id, player_id, event_id, injury_name, created_by) VALUES (10, ?, ?, '踝关节扭伤', 1)")
      .run(opts.injury.playerId, injEventId);
    for (const mid of opts.injury.missMatchIds) {
      sqlite.prepare("INSERT INTO injury_miss (injury_id, match_id) VALUES (?, ?)").run(Number(inj.lastInsertRowid), mid);
    }
  }
  return { db: createTestD1(sqlite), sqlite };
}

// ---------- C2 句法（拆句标点 / 转折时机；承接任务 8 返工钉子） ----------
describe("report C2 句法（audit §4.5）", () => {
  it("转折时机：两段异侧连进直接相接（中间无牌/罚失/呼吸句）时，对队句以「但」起头", async () => {
    const { db } = reportDb({
      matchId: 3001,
      scoreHome: 2,
      scoreAway: 1,
      goals: [
        { id: 1, matchId: 3001, entryId: 500, playerId: 100, minute: 12 },
        { id: 2, matchId: 3001, entryId: 500, playerId: 102, minute: 35 },
        { id: 3, matchId: 3001, entryId: 501, playerId: 200, minute: 50 },
      ],
    });
    const rep = await buildMatchReport(db, 3001);
    const text = rep!.paragraphs.join("");
    expect(text).toContain("但第 50 分钟");
    expect(rep!.goals).toHaveLength(3);
  });

  it("拆句标点：节奏拆句在逗号处断句，不产出「，。」双标点", async () => {
    const { db } = reportDb({
      matchId: 3002,
      scoreHome: 1,
      scoreAway: 2,
      goals: [
        { id: 1, matchId: 3002, entryId: 501, playerId: 200, minute: 12 },
        { id: 2, matchId: 3002, entryId: 501, playerId: 200, minute: 35 },
        { id: 3, matchId: 3002, entryId: 500, playerId: 100, minute: 50 },
      ],
    });
    const rep = await buildMatchReport(db, 3002);
    const text = rep!.paragraphs.join("");
    expect(text).not.toContain("，。");
    expect(text).not.toContain("。。");
    expect(text).toMatch(/(率先打破僵局|首开纪录|拔得头筹|打进本场第一球)。第 35 分钟/);
  });
});

// ---------- seal 门槛四分支（audit §4.1 之③） ----------
describe("report seal 门槛", () => {
  it("分差 ≥3 末球（97'）不锁定，扩大类动词保留", async () => {
    const { db } = reportDb({
      matchId: 5101,
      scoreHome: 0,
      scoreAway: 4,
      goals: [
        { id: 1, matchId: 5101, entryId: 501, playerId: 200, minute: 10 },
        { id: 2, matchId: 5101, entryId: 501, playerId: 200, minute: 30 },
        { id: 3, matchId: 5101, entryId: 501, playerId: 201, minute: 60 },
        { id: 4, matchId: 5101, entryId: 501, playerId: 200, minute: 97 },
      ],
    });
    const rep = await buildMatchReport(db, 5101);
    const text = rep!.paragraphs.join("");
    expect(text).not.toContain("锁定胜局");
    expect(text).toMatch(/扩大战果|再下一城|再入一球/);
  });

  it("分差 ≤2 末球（97'）锁定", async () => {
    const { db } = reportDb({
      matchId: 5102,
      scoreHome: 1,
      scoreAway: 3,
      goals: [
        { id: 1, matchId: 5102, entryId: 500, playerId: 100, minute: 10 },
        { id: 2, matchId: 5102, entryId: 501, playerId: 200, minute: 30 },
        { id: 3, matchId: 5102, entryId: 501, playerId: 201, minute: 60 },
        { id: 4, matchId: 5102, entryId: 501, playerId: 200, minute: 97 },
      ],
    });
    const rep = await buildMatchReport(db, 5102);
    expect(rep!.paragraphs.join("")).toContain("锁定胜局");
  });

  it("末球 85' 破平（0:0 → 0:1）：sealOk 成立但首开动词无 SEAL 词，不产出锁定胜局", async () => {
    // 分支③（minute≥80 且破平）的 sealOk 为真，但破平末球的动词是「首开」系（不含 SEAL 词），
    // 回填无从替换——锁定胜局只出现在「扩大」动词上（分支①②）。这里钉真实契约。
    const { db } = reportDb({
      matchId: 5103,
      scoreHome: 0,
      scoreAway: 1,
      goals: [{ id: 1, matchId: 5103, entryId: 501, playerId: 200, minute: 85 }],
    });
    const rep = await buildMatchReport(db, 5103);
    const text = rep!.paragraphs.join("");
    expect(text).toMatch(/率先打破僵局|首开纪录|拔得头筹|打进本场第一球/);
    expect(text).not.toContain("锁定胜局");
    expect(text).not.toMatch(/扩大战果|再下一城|再入一球/);
  });

  it("末球 85' 扩大分差（0:3 → 0:4）不锁定", async () => {
    const { db } = reportDb({
      matchId: 5104,
      scoreHome: 0,
      scoreAway: 4,
      goals: [
        { id: 1, matchId: 5104, entryId: 501, playerId: 200, minute: 10 },
        { id: 2, matchId: 5104, entryId: 501, playerId: 200, minute: 30 },
        { id: 3, matchId: 5104, entryId: 501, playerId: 201, minute: 60 },
        { id: 4, matchId: 5104, entryId: 501, playerId: 200, minute: 85 },
      ],
    });
    const rep = await buildMatchReport(db, 5104);
    expect(rep!.paragraphs.join("")).not.toContain("锁定胜局");
  });
});

// ---------- C5 状态机动词（比分状态机各分支取句） ----------
describe("report 状态机动词", () => {
  it("首开/扳平/超出/扩大/追回各分支取句正确，末球按门槛锁定", async () => {
    const { db } = reportDb({
      matchId: 5001,
      scoreHome: 4,
      scoreAway: 2,
      goals: [
        { id: 1, matchId: 5001, entryId: 501, playerId: 200, minute: 10 }, // 蓝 首开 0:1
        { id: 2, matchId: 5001, entryId: 500, playerId: 100, minute: 30 }, // 红 扳平 1:1
        { id: 3, matchId: 5001, entryId: 500, playerId: 102, minute: 60 }, // 红 超出 2:1
        { id: 4, matchId: 5001, entryId: 500, playerId: 100, minute: 70 }, // 红 扩大 3:1
        { id: 5, matchId: 5001, entryId: 501, playerId: 200, minute: 75 }, // 蓝 追回 3:2
        { id: 6, matchId: 5001, entryId: 500, playerId: 102, minute: 85 }, // 红 末球 4:2 → 锁定
      ],
    });
    const rep = await buildMatchReport(db, 5001);
    const text = rep!.paragraphs.join("");
    expect(text).toMatch(/率先破门|首开纪录|打开局面|拔得头筹|打进本场第一球/);
    expect(text).toMatch(/扳平比分|追成平手|追平/);
    expect(text).toMatch(/再度领先|再次超出|重新取得领先/);
    expect(text).toMatch(/扩大战果|再入一球|再下一城/); // 中段扩大片段不被 seal 触碰（seal 只回填末球片段）
    expect(text).toMatch(/扳回一城|追回一球/);
    expect(text).toContain("锁定胜局"); // 末球 diffAfter=2 → 锁定
  });

  it("点球分支：点球首开与点球锁定各取句正确", async () => {
    const { db } = reportDb({
      matchId: 5002,
      scoreHome: 2,
      scoreAway: 1,
      goals: [
        { id: 1, matchId: 5002, entryId: 500, playerId: 100, minute: 10, type: "pen_goal" },
        { id: 2, matchId: 5002, entryId: 501, playerId: 200, minute: 40 },
        { id: 3, matchId: 5002, entryId: 500, playerId: 102, minute: 50 },
        { id: 4, matchId: 5002, entryId: 500, playerId: 100, minute: 85, type: "pen_goal" },
      ],
    });
    const rep = await buildMatchReport(db, 5002);
    const text = rep!.paragraphs.join("");
    expect(text).toMatch(/点球命中，率先打破僵局|顶住压力罚进点球，首开纪录|主罚点球稳稳命中，拔得头筹/);
    // 点球扩大池三变体经 SEAL 替换后均可读作「点球…锁定胜局」
    expect(text).toMatch(/点球(命中，)?锁定胜局|点球奠定胜局/);
  });
});

// ---------- C5 呼吸句预算（pickBreath 单元） ----------
describe("report 呼吸句预算", () => {
  const manyFlags: MatchFacts = {
    totalGoals: 5,
    margin: 1,
    winnerSide: "home",
    penShootout: null,
    timingKnown: true,
    firstGoal: { side: "home", minute: 8, type: "goal", playerName: "甲", playerId: 1 },
    lastGoal: { side: "home", minute: 88, type: "goal", playerName: "甲", playerId: 1 },
    openingBolt: true,
    firstHalfQuiet: false,
    drought: null,
    lateFirstGoal: false,
    goalBurst: { from: 10, to: 20, count: 3 },
    lateFlurryCount: 2,
    lateWinner: true,
    comeback: "big",
    blownLead: false,
    bothLed: true,
    leadChanges: 2,
    equalizeRetake: false,
    shape: "seeSaw",
    reds: [{ side: "away", minute: 30, type: "red", playerName: "乙", scoreHome: 1, scoreAway: 0, diffFor: 1, state: "leading" }],
    redTurn: null,
    penGoalCount: 1,
    penDecider: true,
    penMissCount: 1,
    penMissSwing: false,
    ogBenefit: [],
    ogDecider: true,
    playerBags: [{ playerId: 1, playerName: "甲", side: "home", goals: 3 }],
    soloAct: { playerId: 1, playerName: "甲", side: "home", goals: 3 },
    maxBagGoals: 3,
    linkTwice: null,
    upset: { winnerName: "红队", winnerRank: 8, loserRank: 1 },
    streakBroken: { kind: "win", count: 3, teamName: "蓝队" },
    dramaScore: 90,
  };

  it("预算 ≤2：多槽全命中也只出两句，且无重复（同槽只呼吸一次）", () => {
    const out = pickBreath("rb:1", manyFlags, 2, 1.0);
    expect(out.length).toBeLessThanOrEqual(2);
    expect(new Set(out).size).toBe(out.length);
  });

  it("确定性：同 seed 同输出", () => {
    expect(pickBreath("rb:1", manyFlags, 2, 1.0)).toEqual(pickBreath("rb:1", manyFlags, 2, 1.0));
  });
});

// ---------- C5 哑火拆池（audit §4.1 之②：drought / lateFirstGoal 各归各句） ----------
describe("report 哑火拆池", () => {
  const lateFacts: MatchFacts = {
    totalGoals: 1,
    margin: 1,
    winnerSide: "home",
    penShootout: null,
    timingKnown: true,
    firstGoal: { side: "home", minute: 63, type: "goal", playerName: "甲", playerId: 1 },
    lastGoal: { side: "home", minute: 63, type: "goal", playerName: "甲", playerId: 1 },
    openingBolt: false,
    firstHalfQuiet: true,
    drought: { from: 0, to: 63, minutes: 63 },
    lateFirstGoal: true,
    goalBurst: null,
    lateFlurryCount: 0,
    lateWinner: false,
    comeback: null,
    blownLead: false,
    bothLed: false,
    leadChanges: 0,
    equalizeRetake: false,
    shape: "dull",
    reds: [],
    redTurn: null,
    penGoalCount: 0,
    penDecider: false,
    penMissCount: 0,
    penMissSwing: false,
    ogBenefit: [],
    ogDecider: false,
    playerBags: [{ playerId: 1, playerName: "甲", side: "home", goals: 1 }],
    soloAct: null,
    maxBagGoals: 1,
    linkTwice: null,
    upset: null,
    streakBroken: null,
    dramaScore: 10,
  };
  const midFacts: MatchFacts = {
    ...lateFacts,
    firstGoal: { side: "home", minute: 16, type: "goal", playerName: "甲", playerId: 1 },
    lastGoal: { side: "home", minute: 16, type: "goal", playerName: "甲", playerId: 1 },
    drought: { from: 16, to: 90, minutes: 74 },
    lateFirstGoal: false,
    firstHalfQuiet: false,
  };

  it("首球 16' 场（中途哑火）不出「等进球等得久」句", () => {
    for (let i = 0; i < 40; i++) {
      for (const line of pickBreath(`dm:m:${i}`, midFacts, 2, 1.0)) {
        expect(line, line).not.toContain("等进球等得久");
      }
    }
  });

  it("首球 63' 场（lateFirstGoal）才可能出「等进球等得久」句", () => {
    const outs = new Set<string>();
    for (let i = 0; i < 40; i++) {
      for (const line of pickBreath(`dm:l:${i}`, lateFacts, 2, 1.0)) outs.add(line);
    }
    expect([...outs].some((t) => t.includes("等进球等得久"))).toBe(true);
  });
});

// ---------- C5 近况 2.0（角色门控 / P7 / 预算 / T3 / 平局更正面方） ----------
describe("report 近况 2.0（状态画像）", () => {
  it("角色门控：胜方近 5 输三场不出丧气句，胜方正句殿后，预算 3 句", async () => {
    const { db } = reportDb({
      matchId: 5011,
      scoreHome: 8,
      scoreAway: 0,
      prevMatches: [
        { id: 5008, round: 1, slot: 1, homeEntryId: 501, awayEntryId: 500, scoreHome: 1, scoreAway: 0, day: 3 },
        { id: 5009, round: 2, slot: 1, homeEntryId: 501, awayEntryId: 500, scoreHome: 1, scoreAway: 0, day: 4 },
        { id: 5010, round: 3, slot: 1, homeEntryId: 501, awayEntryId: 500, scoreHome: 1, scoreAway: 0, day: 5 },
      ],
      goals: [5, 10, 15, 20, 25, 30, 35, 40].map((minute, i) => ({
        id: i + 1,
        matchId: 5011,
        entryId: 500,
        playerId: 100,
        minute,
      })),
    });
    const rep = await buildMatchReport(db, 5011);
    const text = rep!.paragraphs.join("");
    // 胜方（红）近四场输三场：丧气句仅败方可用
    expect(text).not.toContain("需要调整状态");
    // 近况段：P3 近窗产能 + 败方行 + 胜方正句 = 预算 3 句，胜方行殿后
    const last = rep!.paragraphs[rep!.paragraphs.length - 1];
    expect(last).toContain("八球");
    expect(last).toContain("蓝队");
    const sentences = last.split(/(?<=。)/).filter((x) => x.length > 0);
    expect(sentences.length).toBe(3);
    expect(sentences[sentences.length - 1]).toContain("红队");
  });

  it("P7 票选：上一场票王 cnt≥3 且本场出场才出；cnt<3 不出", async () => {
    const mk = (matchId: number, votes: Array<{ matchId: number; userId: number; playerId: number }>) =>
      reportDb({
        matchId,
        scoreHome: 2,
        scoreAway: 0,
        prevMatches: [
          { id: matchId - 2, round: 1, slot: 1, homeEntryId: 500, awayEntryId: 501, scoreHome: 4, scoreAway: 0, day: 3 },
          { id: matchId - 1, round: 2, slot: 1, homeEntryId: 500, awayEntryId: 501, scoreHome: 0, scoreAway: 0, day: 5 },
        ],
        goals: [
          { id: 1, matchId: matchId - 2, entryId: 500, playerId: 102, minute: 10 },
          { id: 2, matchId: matchId - 2, entryId: 500, playerId: 102, minute: 30 },
          { id: 3, matchId: matchId - 2, entryId: 500, playerId: 102, minute: 50 },
          { id: 4, matchId: matchId - 2, entryId: 500, playerId: 102, minute: 70 },
          { id: 5, matchId, entryId: 500, playerId: 100, minute: 40 },
        ],
        votes,
      });
    const withP7 = await buildMatchReport(
      mk(5012, [
        { matchId: 5011, userId: 1, playerId: 100 },
        { matchId: 5011, userId: 2, playerId: 100 },
        { matchId: 5011, userId: 3, playerId: 100 },
      ]).db,
      5012,
    );
    expect(withP7!.paragraphs.join("")).toContain("全场最佳");

    const withoutP7 = await buildMatchReport(
      mk(5013, [
        { matchId: 5012, userId: 1, playerId: 100 },
        { matchId: 5012, userId: 2, playerId: 100 },
      ]).db,
      5013,
    );
    expect(withoutP7!.paragraphs.join("")).not.toContain("全场最佳");
  });

  it("T3 降位：败方行写排名下滑（重放近 5 轮），预算内置中段", async () => {
    const { db } = reportDb({
      matchId: 5021,
      homeEntryId: 501,
      awayEntryId: 500,
      scoreHome: 1,
      scoreAway: 2,
      prevMatches: [
        { id: 5019, round: 1, slot: 1, homeEntryId: 500, awayEntryId: 501, scoreHome: 2, scoreAway: 0, day: 3 },
        { id: 5020, round: 2, slot: 1, homeEntryId: 502, awayEntryId: 500, scoreHome: 0, scoreAway: 1, day: 5 },
      ],
      goals: [
        { id: 1, matchId: 5019, entryId: 500, playerId: 100, minute: 30 },
        { id: 2, matchId: 5019, entryId: 500, playerId: 100, minute: 60 },
        { id: 3, matchId: 5020, entryId: 500, playerId: 100, minute: 70 },
        { id: 4, matchId: 5021, entryId: 501, playerId: 200, minute: 10, assistId: 201 },
        { id: 5, matchId: 5021, entryId: 500, playerId: 100, minute: 40, assistId: 101 },
        { id: 6, matchId: 5021, entryId: 500, playerId: 100, minute: 80 },
      ],
      standings: [
        { entryId: 500, played: 3, won: 3, drawn: 0, lost: 0, pts: 9, gf: 5, ga: 1 },
        { entryId: 501, played: 2, won: 0, drawn: 0, lost: 2, pts: 0, gf: 1, ga: 4 },
        { entryId: 502, played: 1, won: 0, drawn: 0, lost: 1, pts: 0, gf: 0, ga: 1 },
      ],
      votes: [
        { matchId: 5019, userId: 1, playerId: 201 },
        { matchId: 5019, userId: 2, playerId: 201 },
        { matchId: 5019, userId: 3, playerId: 201 },
      ],
      injury: { playerId: 101, eventMatchId: 5019, missMatchIds: [5020] },
    });
    const rep = await buildMatchReport(db, 5021);
    const last = rep!.paragraphs[rep!.paragraphs.length - 1];
    const sentences = last.split(/(?<=。)/).filter((x) => x.length > 0);
    expect(sentences.length).toBe(3); // P1 复出 + 败方 T3 降位 + 胜方正句
    // T3 重放：蓝队 2 → 3（rankDown 句族，mv=1 时确定性选中「连降一位」变体）
    expect(last).toContain("蓝队");
    expect(last).toMatch(/连降一位|跌到|下滑|后退/);
    expect(last).toContain("红中场"); // P1 复出行
    expect(sentences[sentences.length - 1]).toContain("红队"); // 胜方正句殿后
  });

  it("T3 升位 + 平局取更正面方：爬升的平局方以升位正句收尾", async () => {
    const { db } = reportDb({
      matchId: 5022,
      homeEntryId: 501,
      awayEntryId: 500,
      scoreHome: 1,
      scoreAway: 1,
      prevMatches: [
        { id: 5016, round: 1, slot: 1, homeEntryId: 501, awayEntryId: 500, scoreHome: 2, scoreAway: 0, day: 1 },
        { id: 5017, round: 2, slot: 1, homeEntryId: 501, awayEntryId: 500, scoreHome: 1, scoreAway: 1, day: 3 },
        { id: 5018, round: 3, slot: 1, homeEntryId: 502, awayEntryId: 500, scoreHome: 1, scoreAway: 1, day: 5 },
        { id: 5019, round: 4, slot: 1, homeEntryId: 500, awayEntryId: 502, scoreHome: 3, scoreAway: 0, day: 6 },
        { id: 5020, round: 5, slot: 1, homeEntryId: 501, awayEntryId: 502, scoreHome: 0, scoreAway: 2, day: 7 },
      ],
      goals: [{ id: 1, matchId: 5022, entryId: 500, playerId: 100, minute: 40 }],
      standings: [
        { entryId: 500, played: 5, won: 1, drawn: 3, lost: 1, pts: 6, gf: 6, ga: 5 },
        { entryId: 501, played: 4, won: 1, drawn: 2, lost: 1, pts: 5, gf: 4, ga: 4 },
        { entryId: 502, played: 3, won: 1, drawn: 1, lost: 1, pts: 4, gf: 3, ga: 4 },
      ],
    });
    const rep = await buildMatchReport(db, 5022);
    const last = rep!.paragraphs[rep!.paragraphs.length - 1];
    // 红队近 5 轮爬升（第 3 → 第 1）——平局取更正面一方（红队）的升位正句收尾；
    // 蓝队降位在 level 角色下不写（降=败方候选）
    expect(last).toContain("红队");
    expect(last).toContain("位");
    expect(last).not.toContain("跌到");
  });
});

// ---------- C5 标题档位（pickResultTitle 单元 + C3 池结构承接） ----------
function baseFacts(over: Partial<MatchFacts>): MatchFacts {
  const zero: MatchFacts = {
    totalGoals: 0,
    margin: 0,
    winnerSide: null,
    penShootout: null,
    timingKnown: true,
    firstGoal: null,
    lastGoal: null,
    openingBolt: false,
    firstHalfQuiet: false,
    drought: null,
    lateFirstGoal: false,
    goalBurst: null,
    lateFlurryCount: 0,
    lateWinner: false,
    comeback: null,
    blownLead: false,
    bothLed: false,
    leadChanges: 0,
    equalizeRetake: false,
    shape: "normal",
    reds: [],
    redTurn: null,
    penGoalCount: 0,
    penDecider: false,
    penMissCount: 0,
    penMissSwing: false,
    ogBenefit: [],
    ogDecider: false,
    playerBags: [],
    soloAct: null,
    maxBagGoals: 0,
    linkTwice: null,
    upset: null,
    streakBroken: null,
    dramaScore: 0,
  };
  return { ...zero, ...over };
}

const titleCtx = {
  home: "主队",
  away: "客队",
  scoreHome: 0,
  scoreAway: 0,
  heroName: "功臣" as string | null,
};

describe("report 标题档位（C3）", () => {
  it("六档池 + 钩子池齐备（§5 变体数照录）", () => {
    expect(RESULT_TITLE.sweep.length).toBe(6);
    expect(RESULT_TITLE.edge.length).toBe(5);
    expect(RESULT_TITLE.win.length).toBe(5);
    expect(RESULT_TITLE.draw.length).toBe(5);
    expect(RESULT_TITLE.lateWinner.length).toBe(3);
    expect(RESULT_TITLE.comeback.length).toBe(3);
    expect(RESULT_TITLE.upset.length).toBe(2);
    expect(RESULT_TITLE.pen.length).toBe(2);
    expect(RESULT_TITLE.hooks.length).toBe(5);
  });

  it("档位判定不骰：同输入恒同档同输出；净胜 1/2、0:0、点球、横扫各归各档", () => {
    const once = pickResultTitle(
      "t:1",
      baseFacts({ margin: 1, totalGoals: 1, winnerSide: "home" }),
      { ...titleCtx, scoreHome: 2, scoreAway: 1 },
    );
    expect(
      pickResultTitle("t:1", baseFacts({ margin: 1, totalGoals: 1, winnerSide: "home" }), { ...titleCtx, scoreHome: 2, scoreAway: 1 }),
    ).toBe(once);
    expect(["小胜", "险胜", "力克", "憾负", "拿下"].some((w) => once.includes(w))).toBe(true);

    const win2 = pickResultTitle(
      "t:2",
      baseFacts({ margin: 2, totalGoals: 2, winnerSide: "away" }),
      { ...titleCtx, scoreHome: 1, scoreAway: 3 },
    );
    expect(["击败", "完胜", "战胜", "不敌", "顺利拿下"].some((w) => win2.includes(w))).toBe(true);

    const outs = new Set<string>();
    for (let i = 0; i < 40; i++) {
      outs.add(
        pickResultTitle(`t:3:${i}`, baseFacts({ margin: 0, totalGoals: 0 }), {
          ...titleCtx,
          scoreHome: 0,
          scoreAway: 0,
          heroName: null,
        }),
      );
    }
    expect([...outs].every((t) => !t.includes("焦点是"))).toBe(true);
    expect([...outs].some((t) => t.includes("互交白卷"))).toBe(true);

    const pens = new Set<string>();
    for (let i = 0; i < 40; i++) {
      pens.add(
        pickResultTitle(`t:4:${i}`, baseFacts({ margin: 0, totalGoals: 2, penShootout: { home: 4, away: 3 } }), {
          ...titleCtx,
          scoreHome: 1,
          scoreAway: 1,
        }),
      );
    }
    expect([...pens].every((t) => t.includes("主队"))).toBe(true);
    expect([...pens].some((t) => t.includes("点球大战 4:3"))).toBe(true);

    const sweep = pickResultTitle(
      "t:5",
      baseFacts({ margin: 4, totalGoals: 4, winnerSide: "home" }),
      { ...titleCtx, scoreHome: 4, scoreAway: 0 },
    );
    expect(["横扫", "大胜", "惨败", "压制", "带走一场大胜", "兵不血刃"].some((w) => sweep.includes(w))).toBe(true);
  });

  it("剧情叠加优先级：点球 > 绝杀 > 翻盘 > 爆冷", () => {
    const pen = pickResultTitle(
      "p:1",
      baseFacts({
        penShootout: { home: 4, away: 3 },
        lateWinner: true,
        comeback: "big",
        upset: { winnerName: "主队", winnerRank: 9, loserRank: 1 },
        margin: 0,
        totalGoals: 2,
      }),
      { ...titleCtx, scoreHome: 1, scoreAway: 1 },
    );
    expect(pen).toContain("点球大战");
    expect(pen).not.toContain("绝杀");

    const late = pickResultTitle(
      "p:2",
      baseFacts({
        lateWinner: true,
        comeback: "big",
        upset: { winnerName: "主队", winnerRank: 9, loserRank: 1 },
        margin: 1,
        totalGoals: 1,
        winnerSide: "home",
        lastGoal: { side: "home", minute: 85, type: "goal", playerName: "李四", playerId: 2 },
      }),
      { ...titleCtx, scoreHome: 2, scoreAway: 1 },
    );
    expect(late).toContain("绝杀");
    expect(late).not.toContain("翻盘");
    expect(late).not.toContain("爆冷");

    const cb = pickResultTitle(
      "p:3",
      baseFacts({ comeback: "big", upset: { winnerName: "主队", winnerRank: 9, loserRank: 1 }, margin: 1, totalGoals: 3, winnerSide: "home" }),
      { ...titleCtx, scoreHome: 3, scoreAway: 2 },
    );
    expect(cb).toMatch(/翻盘|逆转/);
    expect(cb).not.toContain("爆冷");

    const up = pickResultTitle(
      "p:4",
      baseFacts({ upset: { winnerName: "主队", winnerRank: 9, loserRank: 1 }, margin: 1, totalGoals: 1, winnerSide: "home" }),
      { ...titleCtx, scoreHome: 2, scoreAway: 1 },
    );
    expect(up).toContain("爆冷");
  });

  it("钩子最多一段：pickResultHook 单段无拼接，无事实命中返回 null", () => {
    const h = pickResultHook(
      "h:1",
      baseFacts({
        winnerSide: "home",
        maxBagGoals: 3,
        playerBags: [{ playerId: 1, playerName: "甲", side: "home", goals: 3 }],
      }),
      { ...titleCtx, scoreHome: 2, scoreAway: 1 },
    );
    expect(h).not.toBeNull();
    expect(h).not.toContain("，");
    const none = pickResultHook("h:2", baseFacts({}), { ...titleCtx });
    expect(none).toBeNull();
  });
});

// ---------- C5 dull 拆池 / 数据段 #6（copybanks 承接） ----------
describe("report dull 拆池（audit §4.1 之②）与数据段（#6）", () => {
  it("lateFirstGoal 与 drought 各 ≥6，旧 dull 键删除", () => {
    expect(BREATH.lateFirstGoal.length).toBeGreaterThanOrEqual(6);
    expect(BREATH.drought.length).toBeGreaterThanOrEqual(6);
    expect((BREATH as Record<string, unknown>).dull).toBeUndefined();
  });

  it("#6：总进球 1-2 时不再出现「合计 / 共 N 粒进球」；0:0 保留白卷分支", () => {
    const one = { scoreHome: 1, scoreAway: 0, totalGoals: 1, winnerName: "甲队", penLine: null };
    for (let i = 0; i < 60; i++) {
      const out = matchDataPara(`md:1:${i}`, one);
      expect(out, out).not.toContain("合计");
      expect(out, out).not.toContain("共 1 粒进球");
      expect(out, out).not.toMatch(/^1 球/);
    }
    const zero = { scoreHome: 0, scoreAway: 0, totalGoals: 0, winnerName: null, penLine: null };
    const outs = new Set<string>();
    for (let i = 0; i < 60; i++) outs.add(matchDataPara(`md:0:${i}`, zero));
    expect([...outs].some((t) => t.includes("互交白卷"))).toBe(true);
    expect(MATCH_DATA_PARA.length).toBe(6);
  });
});

// ---------- C5 narrativeFacts.lateFirstGoal 事实锚 ----------
describe("report narrativeFacts.lateFirstGoal", () => {
  const match = (over: Partial<import("../worker/lib/context").FinishedMatch>) =>
    ({
      id: 1,
      stageId: 1,
      tournamentId: 1,
      tournamentName: "联赛",
      stageKind: "round_robin",
      stageName: null,
      round: 1,
      homeEntryId: 10,
      awayEntryId: 11,
      homeTeamName: "主队",
      awayTeamName: "客队",
      homeLogoUrl: null,
      awayLogoUrl: null,
      scoreHome: 0,
      scoreAway: 0,
      penHome: null,
      penAway: null,
      walkoverSide: "",
      note: null,
      status: "finished",
      finishedAt: "2026-01-01T00:00:00Z",
      ...over,
    }) as import("../worker/lib/context").FinishedMatch;
  const ev = (minute: number | null, type: "goal" | "pen_goal" | "own_goal" = "goal") =>
    ({
      id: minute ?? 0,
      matchId: 1,
      type,
      minute,
      entryId: 10,
      playerId: 1,
      playerName: "甲",
      assistPlayerId: null,
      assistName: null,
      method: null,
      assistMethod: null,
      createdAt: "2026-01-01T00:00:00Z",
    }) as import("../worker/lib/context").RawEvent;

  it("哑火期从 0' 起算（首球 ≥60'）→ true；中途哑火（首球早）→ false；时间不可知 → false", () => {
    const late = computeMatchFacts(match({ scoreHome: 1, scoreAway: 0 }), [ev(63)]);
    expect(late?.lateFirstGoal).toBe(true);
    expect(late?.drought).toMatchObject({ from: 0 });

    const mid = computeMatchFacts(match({ scoreHome: 1, scoreAway: 1 }), [ev(20), ev(85, "pen_goal")]);
    expect(mid?.lateFirstGoal).toBe(false);
    expect(mid?.drought).toMatchObject({ from: 20, to: 85 });

    const zero = computeMatchFacts(match(), []);
    expect(zero?.lateFirstGoal).toBe(true);
    expect(zero?.drought).toMatchObject({ from: 0, to: 90 });

    const unknown = computeMatchFacts(match({ scoreHome: 1, scoreAway: 0 }), [ev(null)]);
    expect(unknown?.timingKnown).toBe(false);
    expect(unknown?.lateFirstGoal).toBe(false);
  });
});

// ---------- C5 lede 败方比分 + 改判自动重写对拍 ----------
describe("report lede 与改判重写", () => {
  it("lede 败方比分正确：0:4 大胜档第 6 变体填败方视角比分（复现 match 222 形态）", async () => {
    let hit = false;
    for (let id = 5200; id < 5260; id++) {
      const { db } = reportDb({
        matchId: id,
        scoreHome: 0,
        scoreAway: 4,
        goals: [10, 20, 30, 40].map((minute, i) => ({
          id: i + 1,
          matchId: id,
          entryId: 501,
          playerId: 200,
          minute,
        })),
      });
      const rep = await buildMatchReport(db, id);
      if (rep!.lede.includes("败下阵来")) {
        hit = true;
        expect(rep!.lede).toContain("以 0:4 败下阵来");
        expect(rep!.lede).not.toContain("以 4:0 败下阵来");
        break;
      }
    }
    expect(hit, "60 个 matchId 内应命中大胜档第 6 变体").toBe(true);
  });

  it("改判后自动重写：比分翻转后锁定胜局失效、标题与导语易主（数据变 → 文章变）", async () => {
    const matchId = 5300;
    const first = reportDb({
      matchId,
      scoreHome: 1,
      scoreAway: 3,
      goals: [
        { id: 1, matchId, entryId: 500, playerId: 100, minute: 10 },
        { id: 2, matchId, entryId: 501, playerId: 200, minute: 30 },
        { id: 3, matchId, entryId: 501, playerId: 201, minute: 60 },
        { id: 4, matchId, entryId: 501, playerId: 200, minute: 97 },
      ],
    });
    const r1 = await buildMatchReport(first.db, matchId);
    expect(r1!.paragraphs.join("")).toContain("锁定胜局"); // 末球 97' diffAfter=2 → 锁定

    // 改判（管理端改比分+删客队末球事件）→ 同一 db 重跑，文章自动重写、旧断言失效
    first.sqlite.prepare("UPDATE match SET score_home = 3, score_away = 1 WHERE id = ?").run(matchId);
    first.sqlite.prepare("DELETE FROM match_event WHERE id = 4").run();
    const r2 = await buildMatchReport(first.db, matchId);
    expect(r2!.paragraphs.join("")).not.toContain("锁定胜局"); // 末球变成败方进球 → 不锁定
    expect(r2!.title).not.toBe(r1!.title);
    expect(r2!.lede).not.toBe(r1!.lede);
  });
});
