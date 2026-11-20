// 赛季级排期：S1 schema / 归档 / 回归 + S2 整季求解引擎与整季体检 + S3 版本与回滚。
// 夹具见 tests/kickoff-season.fixtures.ts；跨端点全链路与旧窗口兼容性回归见
// tests/kickoff-season.routes.test.ts。
// S1 钉的是：
//   - fresh DB 跑完全部迁移后 schedule_revision / season_rule 存在，schedule_snapshot 没被动；
//   - 当前 match.kickoff_* 能按 season + segment + match 归档成 revision 1；
//   - 归档幂等，不覆盖、不碰 schedule_snapshot；
//   - 旧窗口接口仍可用。
// S2 钉的是：
//   - scheduleSeason 整季夹具跑通：3 套候选（seed/步数固定）指标齐全、可复现、hard=0；
//   - 已开赛场 / 已公布段是冻结上下文；没配池子的段进 blockedSegmentIds；
//   - validateSeason 规则矩阵：48h/64h/72h、两连主、末轮同开、档位池、跨赛事相邻场；
//   - seasonCommitGate：有 hard 拒绝，soft/report 放行。
// S3 钉的是：
//   - preview/commit/publish/restore 主链路：commit 落成新 revision、publish 锁段、restore 落 restored 版本；
//   - 硬冲突 commit 直接 409 且不写库；publish 只认当前排期一致的版本；
//   - 旧窗口接口不 break：preview/commit 走整季 prospective 体检，单场改期牵出跨赛事冲突。
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../worker/lib/crypto";
import {
  DEFAULT_SEASON_RULE,
  SEASON_SCHEDULER_SEED,
  SEASON_SCHEDULER_STEPS,
  auditSeason,
  scheduleSeason,
  seasonCommitGate,
  validateSeason,
} from "../worker/lib/kickoffSeason";
import type {
  SeasonPlacement,
  SeasonRule,
  SeasonSegment,
  SeasonViolation,
  SegmentPool,
} from "../worker/lib/kickoffSeason";
import { call, freshEnv, fullEnv, post, routeEnvOf } from "./kickoff-season.fixtures";

type ArchiveBody = {
  ok: boolean;
  revision: number;
  hash: string;
  status: string;
  assignmentCount: number;
  alreadyArchived: boolean;
  unmatchedMatchIds: number[];
  createdBy: string | null;
  metrics: {
    segments: number;
    matches: number;
    scheduled: number;
    hard: number;
    soft: number;
    unmatchedMatchIds: number[];
  };
};

type OverviewBody = {
  season: { id: number; name: string; weeks: number };
  counts: {
    segments: number;
    matches: number;
    scheduled: number;
    unscheduled: number;
    unmatched: number;
  };
  segments: Array<{ id: number; matchCount: number; scheduledCount: number; lockedAt: string | null }>;
  placements: Array<{ matchId: number; segmentId: number | null; week: number; day: number; time: string }>;
  violations: Array<{ matchId: number; level: "hard" | "soft"; reason: string; teamId?: number }>;
  rules: Array<{ competition: string; minGapHours: number; softGapHours: number }>;
  revisions: Array<{ revision: number; status: string; assignmentCount: number }>;
};

describe("赛季级排期 S1", () => {
  it("fresh DB 跑完全部迁移：新表存在，旧 schedule_snapshot 原样保留", () => {
    const { sqlite } = freshEnv();
    const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (r) => r.name
    );
    expect(tables).toContain("schedule_revision");
    expect(tables).toContain("schedule_revision_assignment");
    expect(tables).toContain("season_rule");
    expect(tables).toContain("schedule_snapshot");

    const revCols = (
      sqlite.prepare("PRAGMA table_info(schedule_revision)").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(revCols).toEqual(
      expect.arrayContaining(["season_id", "revision", "hash", "status", "locked_at", "created_by"])
    );
    const snapCols = (
      sqlite.prepare("PRAGMA table_info(schedule_snapshot)").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(snapCols).toEqual(["id", "window_id", "payload", "created_by", "created_at"]);

    // season_id + revision 唯一
    sqlite.prepare("INSERT INTO schedule_revision (season_id, revision, hash) VALUES (1, 1, 'x')").run();
    expect(() =>
      sqlite.prepare("INSERT INTO schedule_revision (season_id, revision, hash) VALUES (1, 1, 'y')").run()
    ).toThrow();
  });

  it("迁移给已有赛季补一条默认 all 规则", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const split = files.indexOf("0037_schedule_revision.sql");
    expect(split).toBeGreaterThan(0);
    for (const file of files.slice(0, split)) sqlite.exec(readFileSync(join(dir, file), "utf8"));
    sqlite.prepare("INSERT INTO season (id, name, weeks) VALUES (1, 'S9', 31)").run();
    for (const file of files.slice(split)) sqlite.exec(readFileSync(join(dir, file), "utf8"));

    expect(
      sqlite.prepare("SELECT * FROM season_rule WHERE season_id = 1 AND competition = 'all'").get()
    ).toMatchObject({
      min_gap_hours: 48,
      soft_gap_hours: 64,
      report_gap_hours: 72,
      consecutive_home_exempt: 1,
      last_round_simultaneous: 1,
    });
  });

  it("把当前排期归档成 revision 1：段/场次/时刻/override/reason 全部保留", async () => {
    const { env, sqlite } = freshEnv();
    const res = await post(env, "/api/admin/seasons/1/schedule/archive");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ArchiveBody;
    expect(body).toMatchObject({
      ok: true,
      revision: 1,
      status: "committed",
      assignmentCount: 3,
      alreadyArchived: false,
      unmatchedMatchIds: [],
      createdBy: "管理员",
    });
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.hash).toBe(
      await sha256Hex(
        "1:10:12:6:20:00:0::1:2|2:10:14:7:14:00:1:转播调整:3:4|3:11:13:1:12:00:0::1:3",
      ),
    );

    const rows = sqlite
      .prepare("SELECT * FROM schedule_revision_assignment ORDER BY match_id")
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      season_id: 1,
      segment_id: 10,
      match_id: 1,
      week: 12,
      day: 6,
      time: "20:00",
      override: 0,
      reason: null,
    });
    expect(rows[1]).toMatchObject({
      segment_id: 10,
      match_id: 2,
      week: 14,
      day: 7,
      time: "14:00",
      override: 1,
      reason: "转播调整",
    });
    expect(rows[2]).toMatchObject({
      segment_id: 11,
      match_id: 3,
      week: 13,
      day: 1,
      time: "12:00",
    });

    // 旧快照不动
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM schedule_snapshot").get()).toEqual({ n: 1 });
    expect(
      sqlite.prepare("SELECT payload FROM schedule_snapshot WHERE window_id = 10").get()
    ).toEqual({ payload: JSON.stringify({ assignments: [] }) });

    // 幂等：第二次调用原样返回，不新增版本、不重复审计
    const again = await post(env, "/api/admin/seasons/1/schedule/archive");
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as ArchiveBody;
    expect(againBody.alreadyArchived).toBe(true);
    expect(againBody.assignmentCount).toBe(3);
    expect(againBody.hash).toBe(body.hash);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM schedule_revision").get()).toEqual({ n: 1 });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'schedule_revision_archive'")
        .get()
    ).toEqual({ n: 1 });
  });

  it("赛季总览：段计数、已排场次、整季跨段冲突、默认规则", async () => {
    const { env } = freshEnv();
    await post(env, "/api/admin/seasons/1/schedule/archive");
    const res = await call(env, "/api/admin/seasons/1/schedule");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewBody;
    expect(body.season).toMatchObject({ id: 1, name: "S9", weeks: 31 });
    expect(body.counts).toMatchObject({
      segments: 2,
      matches: 4,
      scheduled: 3,
      unscheduled: 1,
      unmatched: 0,
    });
    expect(body.segments).toHaveLength(2);
    expect(body.segments[0]).toMatchObject({ id: 10, matchCount: 2, scheduledCount: 2, lockedAt: null });
    expect(body.segments[1]).toMatchObject({ id: 11, matchCount: 2, scheduledCount: 1, lockedAt: null });
    expect(body.placements).toHaveLength(3);
    expect(body.placements.find((p) => p.matchId === 3)).toMatchObject({
      segmentId: 11,
      week: 13,
      day: 1,
      time: "12:00",
    });
    // 红队 1 号场（第 12 周第 6 天 20:00）→ 3 号场（第 13 周第 1 天 12:00）只隔 40h
    expect(
      body.violations.some((v) => v.level === "hard" && v.teamId === 1 && v.reason.includes("间隔"))
    ).toBe(true);
    expect(body.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ competition: "all", minGapHours: 48, softGapHours: 64 }),
      ])
    );
    expect(body.revisions).toHaveLength(1);
    expect(body.revisions[0]).toMatchObject({ revision: 1, status: "committed", assignmentCount: 3 });
  });

  it("版本列表只列赛季 revision，不混入旧 schedule_snapshot", async () => {
    const { env } = freshEnv();
    const before = await call(env, "/api/admin/seasons/1/schedule/snapshots");
    expect(before.status).toBe(200);
    expect(((await before.json()) as { revisions: unknown[] }).revisions).toHaveLength(0);

    await post(env, "/api/admin/seasons/1/schedule/archive");
    const after = await call(env, "/api/admin/seasons/1/schedule/snapshots");
    const body = (await after.json()) as { revisions: Array<{ revision: number }> };
    expect(body.revisions).toHaveLength(1);
    expect(body.revisions[0].revision).toBe(1);
  });

  it("没排场次的赛季拒绝归档；不存在的赛季 404", async () => {
    const { env, sqlite } = freshEnv();
    sqlite.prepare("INSERT INTO season (id, name, weeks) VALUES (2, 'S10', 31)").run();
    const empty = await post(env, "/api/admin/seasons/2/schedule/archive");
    expect(empty.status).toBe(409);
    expect(((await empty.json()) as { message: string }).message).toContain("没有已排场次");

    const missing = await post(env, "/api/admin/seasons/999/schedule/archive");
    expect(missing.status).toBe(404);
    const bad = await call(env, "/api/admin/seasons/abc/schedule");
    expect(bad.status).toBe(400);
  });

  it("已排但映射不到段的场次：归档保留并单列，不静默丢数据", async () => {
    const { env, sqlite } = freshEnv();
    sqlite
      .prepare(
        `INSERT INTO match
           (id, stage_id, round, slot, home_entry_id, away_entry_id, status,
            kickoff_week, kickoff_day, kickoff_time, kickoff_override, kickoff_reason)
         VALUES (5, 131, 99, 3, 902, 904, 'pending', 12, 7, '17:00', 0, NULL)`
      )
      .run();
    const res = await post(env, "/api/admin/seasons/1/schedule/archive");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ArchiveBody;
    expect(body.assignmentCount).toBe(4);
    expect(body.unmatchedMatchIds).toEqual([5]);
    expect(
      sqlite.prepare("SELECT segment_id FROM schedule_revision_assignment WHERE match_id = 5").get()
    ).toEqual({ segment_id: null });
  });

  it("旧窗口接口仍可用，且归档不影响旧快照", async () => {
    const { env, sqlite } = freshEnv();
    await post(env, "/api/admin/seasons/1/schedule/archive");
    const res = await call(env, "/api/admin/tournaments/13/windows");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      windows: Array<{ id: number; matchCount: number; scheduledCount: number }>;
    };
    expect(body.windows).toHaveLength(2);
    expect(body.windows[0]).toMatchObject({ id: 10, matchCount: 2, scheduledCount: 2 });
    expect(body.windows[1]).toMatchObject({ id: 11, matchCount: 2, scheduledCount: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM schedule_snapshot").get()).toEqual({ n: 1 });
  });

  it("归档体检用 season_rule 覆盖值，且两连主豁免生效", async () => {
    const { env, sqlite } = freshEnv();
    // top 覆盖把硬约束降到 36h：1 号与 3 号场只隔 40h，且红队两场都是主场 → 不报 hard/soft
    sqlite
      .prepare(
        `INSERT INTO season_rule (season_id, competition, min_gap_hours, soft_gap_hours, report_gap_hours)
         VALUES (1, 'top', 36, 64, 72)`
      )
      .run();
    const res = await post(env, "/api/admin/seasons/1/schedule/archive");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ArchiveBody;
    expect(body.metrics).toMatchObject({ hard: 0, soft: 0 });
  });

  it("season_rule 的 competition 覆盖能被总览读出来", async () => {
    const { env, sqlite } = freshEnv();
    sqlite
      .prepare(
        `INSERT INTO season_rule (season_id, competition, soft_gap_hours, consecutive_home_exempt)
         VALUES (1, 'top', 72, 0)`
      )
      .run();
    const res = await call(env, "/api/admin/seasons/1/schedule");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewBody;
    expect(body.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ competition: "all", softGapHours: 64 }),
        expect.objectContaining({ competition: "top", softGapHours: 72 }),
      ])
    );
  });
});

describe("赛季级排期 S2：scheduleSeason 整季求解", () => {
  it("整季夹具：3 套候选指标齐全、hard=0、两次调用逐字节一致", async () => {
    const { db } = fullEnv();
    const r1 = await scheduleSeason(db, 1);
    expect(r1.seasonId).toBe(1);
    expect(r1.segmentIds).toHaveLength(16);
    expect(r1.totalSegments).toBe(16);
    expect(r1.blockedSegmentIds).toEqual([]);
    expect(r1.unplayableMatchIds).toEqual([157]);
    expect(r1.unplacedMatchIds).toEqual([]);
    // 冻结上下文：第 1 轮已开赛 4 场 + 半决赛首回合（已公布段）2 场
    expect(r1.fixed.map((f) => f.matchId).sort((a, b) => a - b)).toEqual([
      101, 102, 103, 104, 153, 154,
    ]);

    expect(r1.candidates.map((c) => c.key)).toEqual(["A", "B", "C"]);
    expect(r1.candidates.map((c) => c.seed)).toEqual([
      SEASON_SCHEDULER_SEED,
      SEASON_SCHEDULER_SEED + 7919,
      SEASON_SCHEDULER_SEED + 2 * 7919,
    ]);
    for (const c of r1.candidates) {
      expect(c.steps).toBe(SEASON_SCHEDULER_STEPS);
      expect(c.metrics.hard).toBe(0);
      expect(c.metrics.soft).toBe(0);
      expect(c.metrics.minGapHours).toBeGreaterThanOrEqual(48);
      expect(c.metrics.lateRatio).toBeGreaterThan(0);
      expect(c.metrics.lateRatio).toBeLessThanOrEqual(1);
      expect(c.metrics.maxConsecutiveLoad).toBeGreaterThanOrEqual(2);
      expect(c.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(seasonCommitGate(c.violations).canCommit).toBe(true);
      const ids = c.assignments.map((a) => a.matchId);
      expect(ids).toHaveLength(50);
      expect(new Set(ids).size).toBe(50);
      for (const a of c.assignments) expect(a.override).toBe(false);
    }
    // 固定 seed + 固定步数：同一输入两次求解必须逐字节一致（可复现）
    const r2 = await scheduleSeason(db, 1);
    expect(JSON.stringify(r2)).toBe(JSON.stringify(r1));
  });

  it("末轮折叠与 slot_override：第 10 轮整轮同开、小组第 3 轮压到覆盖档", async () => {
    const { db } = fullEnv();
    const r = await scheduleSeason(db, 1);
    for (const c of r.candidates) {
      const r10 = c.assignments.filter((a) => a.segmentId === 210);
      expect(r10).toHaveLength(4);
      expect(new Set(r10.map((a) => `${a.day}|${a.time}`))).toEqual(new Set(["7|20:00"]));
      const g3 = c.assignments.filter((a) => a.segmentId === 213);
      expect(g3).toHaveLength(4);
      expect(new Set(g3.map((a) => `${a.day}|${a.time}`))).toEqual(new Set(["3|21:00"]));
    }
  });

  it("segmentIds 部分求解：只动指定段，范围外只当上下文", async () => {
    const { db } = fullEnv();
    const r = await scheduleSeason(db, 1, { segmentIds: [202] });
    expect(r.segmentIds).toEqual([202]);
    expect(r.totalSegments).toBe(16);
    expect(r.unplayableMatchIds).toEqual([]);
    for (const c of r.candidates) {
      expect(c.assignments).toHaveLength(4);
      for (const a of c.assignments) {
        expect(a.segmentId).toBe(202);
        expect(a.week).toBe(2);
        expect(a.day).toBeGreaterThanOrEqual(6);
        expect(a.day).toBeLessThanOrEqual(7);
      }
      expect(c.metrics.hard).toBe(0);
    }
    expect(r.fixed.map((f) => f.matchId).sort((a, b) => a - b)).toEqual([
      101, 102, 103, 104, 153, 154,
    ]);
  });

  it("没配池子的段进 blockedSegmentIds：明说而不是静默跳过", async () => {
    const { db, sqlite } = fullEnv();
    sqlite.prepare("DELETE FROM time_pool WHERE competition = 'cup'").run();
    const r = await scheduleSeason(db, 1);
    // 214 已公布（locked）不算 blocked；213 有 slot_override 自带档位
    expect(r.blockedSegmentIds).toEqual([211, 212, 215, 216]);
    for (const c of r.candidates) {
      const segIds = new Set(c.assignments.map((a) => a.segmentId));
      for (const id of [211, 212, 215, 216]) expect(segIds.has(id)).toBe(false);
      expect(c.metrics.hard).toBe(0);
    }
    const g3 = r.candidates[0].assignments.filter((a) => a.segmentId === 213);
    expect(g3).toHaveLength(4);
    expect(new Set(g3.map((a) => `${a.day}|${a.time}`))).toEqual(new Set(["3|21:00"]));
  });

  it("未知段 / 未知赛季 / 空赛季：业务错误码", async () => {
    const { db, sqlite } = fullEnv();
    sqlite.prepare("INSERT INTO season (id, name, weeks) VALUES (2, 'S10', 31)").run();
    await expect(scheduleSeason(db, 1, { segmentIds: [999] })).rejects.toMatchObject({
      code: "segment_not_found",
    });
    await expect(scheduleSeason(db, 999)).rejects.toMatchObject({ code: "season_not_found" });
    await expect(scheduleSeason(db, 2)).rejects.toMatchObject({ code: "empty_schedule" });
  });

  it("已开赛场与已公布段不出现在任何候选里（冻结上下文）", async () => {
    const { db } = fullEnv();
    const r = await scheduleSeason(db, 1);
    const moved = new Set(r.candidates.flatMap((c) => c.assignments.map((a) => a.matchId)));
    for (const id of [101, 102, 103, 104, 153, 154]) {
      expect(moved.has(id)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// S2 单元：整季体检的规则矩阵（纯内存对象，不连库）
// ---------------------------------------------------------------------------

const RULES: SeasonRule[] = [{ competition: "all", ...DEFAULT_SEASON_RULE }];

function mkSeg(p: Partial<SeasonSegment> & { id: number }): SeasonSegment {
  return {
    tournamentId: 13,
    tournamentName: "S9 | 顶级联赛",
    competition: "top",
    stream: "league",
    round: 1,
    leg: null,
    week: 1,
    dayStart: 6,
    dayEnd: 7,
    slotOverride: null,
    lockedAt: null,
    stageIds: [131],
    ...p,
  };
}

function mkPool(p: Partial<SegmentPool> & { segmentId: number }): SegmentPool {
  return {
    pool: { 6: [{ time: "19:30", cap: 1 }, { time: "20:30", cap: 2 }], 7: [{ time: "18:00", cap: 2 }] },
    dayStart: 6,
    dayEnd: 7,
    overridden: false,
    lastRound: false,
    ...p,
  };
}

function mkPlace(p: Partial<SeasonPlacement> & { matchId: number }): SeasonPlacement {
  return {
    segmentId: 1,
    week: 1,
    day: 6,
    time: "20:30",
    override: true,
    reason: null,
    homeTeamId: 1,
    awayTeamId: 2,
    ...p,
  };
}

describe("赛季级排期 S2：整季体检规则", () => {
  it("同队间隔 40h → hard，并落到最小间隔指标", () => {
    const segments = [mkSeg({ id: 1 })];
    const pools = [mkPool({ segmentId: 1 })];
    const placements = [
      mkPlace({ matchId: 1, week: 1, day: 6, time: "19:30" }),
      mkPlace({ matchId: 2, homeTeamId: 1, awayTeamId: 3, week: 2, day: 1, time: "11:30" }),
    ];
    const { violations, metrics } = auditSeason({ segments, placements, pools }, RULES);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      matchId: 2,
      level: "hard",
      teamId: 1,
      segmentId: 1,
      reason: "队伍 1 间隔 40.0h < 48h",
    });
    expect(metrics.hard).toBe(1);
    expect(metrics.soft).toBe(0);
    expect(metrics.report).toBe(0);
    expect(metrics.minGapHours).toBe(40);
  });

  it("60h 非两连主 → soft；两连主豁免 → 只进备用报告", () => {
    const segments = [mkSeg({ id: 1 })];
    const pools = [mkPool({ segmentId: 1 })];
    const first = mkPlace({ matchId: 1, week: 1, day: 6, time: "20:00" });
    const away = mkPlace({
      matchId: 2,
      homeTeamId: 3,
      awayTeamId: 1,
      week: 2,
      day: 2,
      time: "08:00",
    });
    const awayAudit = auditSeason({ segments, placements: [first, away], pools }, RULES);
    expect(awayAudit.violations).toHaveLength(1);
    expect(awayAudit.violations[0]).toMatchObject({
      matchId: 2,
      level: "soft",
      teamId: 1,
      reason: "队伍 1 间隔 60.0h < 64h（非两连主）",
    });

    const home = mkPlace({ matchId: 2, homeTeamId: 1, awayTeamId: 3, week: 2, day: 2, time: "08:00" });
    const homeAudit = auditSeason({ segments, placements: [first, home], pools }, RULES);
    expect(homeAudit.violations).toHaveLength(1);
    expect(homeAudit.violations[0]).toMatchObject({
      matchId: 2,
      level: "report",
      teamId: 1,
      reason: "队伍 1 间隔 60.0h < 72h（备用报告）",
    });
  });

  it("规则关掉两连主豁免后，两连主 60h 也按 soft 报", () => {
    const segments = [mkSeg({ id: 1 })];
    const pools = [mkPool({ segmentId: 1 })];
    const placements = [
      mkPlace({ matchId: 1, week: 1, day: 6, time: "20:00" }),
      mkPlace({ matchId: 2, homeTeamId: 1, awayTeamId: 3, week: 2, day: 2, time: "08:00" }),
    ];
    const rules: SeasonRule[] = [
      { competition: "all", ...DEFAULT_SEASON_RULE, consecutiveHomeExempt: false },
    ];
    const { violations } = auditSeason({ segments, placements, pools }, rules);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ level: "soft", reason: "队伍 1 间隔 60.0h < 64h（非两连主）" });
  });

  it("68h → 只进备用报告；72h 起完全干净", () => {
    const segments = [mkSeg({ id: 1 })];
    const pools = [mkPool({ segmentId: 1 })];
    const first = mkPlace({ matchId: 1, week: 1, day: 6, time: "20:00" });
    const at68 = mkPlace({ matchId: 2, awayTeamId: 3, week: 2, day: 2, time: "16:00" });
    const reportAudit = auditSeason({ segments, placements: [first, at68], pools }, RULES);
    expect(reportAudit.violations).toHaveLength(1);
    expect(reportAudit.violations[0]).toMatchObject({
      level: "report",
      reason: "队伍 1 间隔 68.0h < 72h（备用报告）",
    });

    const at72 = mkPlace({ matchId: 2, week: 2, day: 2, time: "20:00" });
    const cleanAudit = auditSeason({ segments, placements: [first, at72], pools }, RULES);
    expect(cleanAudit.violations).toEqual([]);
    expect(cleanAudit.metrics.minGapHours).toBe(72);
  });

  it("跨赛事相邻场：杯赛场排到联赛场次日，同样拦下", () => {
    const segments = [
      mkSeg({ id: 1 }),
      mkSeg({
        id: 2,
        tournamentId: 14,
        tournamentName: "S9 | 冠军杯",
        competition: "cup",
        stream: "group",
        dayStart: 2,
        dayEnd: 3,
      }),
    ];
    const pools = [mkPool({ segmentId: 1 })];
    const placements = [
      mkPlace({ matchId: 1, week: 1, day: 6, time: "20:00" }),
      mkPlace({ matchId: 2, segmentId: 2, awayTeamId: 3, week: 1, day: 7, time: "22:00" }),
    ];
    const { violations } = auditSeason({ segments, placements, pools }, RULES);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      matchId: 2,
      level: "hard",
      teamId: 1,
      reason: "队伍 1 间隔 26.0h < 48h",
    });
  });

  it("映射不到段的已排场次 → hard", () => {
    const placements = [mkPlace({ matchId: 9, segmentId: null, week: 20, day: 1, time: "20:00" })];
    const violations = validateSeason({ segments: [mkSeg({ id: 1 })], placements }, RULES);
    expect(violations).toEqual([
      { matchId: 9, level: "hard", reason: "该场不在任何排期窗口" },
    ]);
  });

  it("档位池：越界天 / 不在池时刻 / 超容量 / override 豁免", () => {
    const segments = [mkSeg({ id: 1 })];
    const pools = [mkPool({ segmentId: 1 })];
    const data = (placements: SeasonPlacement[]) => ({ segments, placements, pools });

    // 第 5 天越界：天数与时刻两条都报（时刻池只认第 5 天自己的档位）
    const dayOut = validateSeason(
      data([mkPlace({ matchId: 1, override: false, day: 5, time: "20:30" })]),
      RULES
    );
    expect(dayOut.map((v) => v.reason)).toEqual([
      "第 5 天不在排期段 6–7",
      "时刻 20:30 不在第 5 天的池子",
    ]);

    // 时刻不在池子
    const badTime = validateSeason(
      data([mkPlace({ matchId: 1, override: false, day: 6, time: "21:00" })]),
      RULES
    );
    expect(badTime).toHaveLength(1);
    expect(badTime[0]).toMatchObject({
      matchId: 1,
      level: "hard",
      reason: "时刻 21:00 不在第 6 天的池子",
    });

    // 同段同档超容量：19:30 档 cap=1，塞两场
    const over = validateSeason(
      data([
        mkPlace({ matchId: 1, override: false, day: 6, time: "19:30" }),
        mkPlace({ matchId: 2, override: false, day: 6, time: "19:30", homeTeamId: 3, awayTeamId: 4 }),
      ]),
      RULES
    );
    expect(over).toHaveLength(1);
    expect(over[0]).toMatchObject({
      matchId: 0,
      level: "hard",
      reason: "第 6 天 19:30 档超出容量 2/1",
    });

    // 越窗 override 的场是人工决定，不做池校验
    const exempt = validateSeason(
      data([mkPlace({ matchId: 1, override: true, day: 5, time: "20:30" })]),
      RULES
    );
    expect(exempt).toEqual([]);
  });

  it("末轮应同开：少数侧 hard，规则可关，override 场不参与", () => {
    const segments = [mkSeg({ id: 1 })];
    const pools = [
      mkPool({
        segmentId: 1,
        lastRound: true,
        pool: { 6: [{ time: "19:30", cap: 1 }], 7: [{ time: "20:30", cap: 2 }] },
      }),
    ];
    const placements = [
      mkPlace({ matchId: 1, override: false, day: 7, time: "20:30" }),
      mkPlace({ matchId: 2, override: false, day: 7, time: "20:30", homeTeamId: 3, awayTeamId: 4 }),
      mkPlace({ matchId: 3, override: false, day: 6, time: "19:30", homeTeamId: 5, awayTeamId: 6 }),
      mkPlace({ matchId: 4, override: true, day: 6, time: "19:30", homeTeamId: 7, awayTeamId: 8 }),
    ];
    const violations = validateSeason({ segments, placements, pools }, RULES);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      matchId: 3,
      level: "hard",
      segmentId: 1,
      reason: "末轮应同开：该场在第 6 天 19:30，基准是第 7 天 20:30",
    });

    // 规则关掉后不查同开（其余校验不受影响）
    const rules: SeasonRule[] = [
      { competition: "all", ...DEFAULT_SEASON_RULE, lastRoundSimultaneous: false },
    ];
    expect(validateSeason({ segments, placements, pools }, rules)).toEqual([]);
  });

  it("指标：晚场占比、连续负荷、无对局时最小间隔为 null", () => {
    const segments = [mkSeg({ id: 1 })];
    const pools = [mkPool({ segmentId: 1 })];
    const placements = [
      mkPlace({ matchId: 1, day: 1, time: "12:00", awayTeamId: 2 }),
      mkPlace({ matchId: 2, day: 2, time: "12:00", awayTeamId: 3 }),
      mkPlace({ matchId: 3, day: 5, time: "16:00", awayTeamId: 4 }),
      mkPlace({ matchId: 4, day: 6, time: "20:00", awayTeamId: 5 }),
    ];
    const { metrics } = auditSeason({ segments, placements, pools }, RULES);
    expect(metrics.hard).toBe(2); // 24h 与 28h 两个间隔
    expect(metrics.minGapHours).toBe(24);
    expect(metrics.lateRatio).toBe(0.25);
    expect(metrics.maxConsecutiveLoad).toBe(4);

    // 只有一场：没有相邻对，minGapHours 为 null
    const single = auditSeason(
      { segments, placements: [placements[0]], pools },
      RULES
    );
    expect(single.metrics.minGapHours).toBeNull();
    expect(single.metrics.maxConsecutiveLoad).toBe(1);
  });

  it("没配池子的段不做池校验；配了空池仍校验周/天范围", () => {
    const segments = [mkSeg({ id: 1 })];
    const placements = [mkPlace({ matchId: 1, override: false, day: 5, time: "21:00" })];
    // 完全没配池子：S1 兼容，跳过池校验
    expect(validateSeason({ segments, placements }, RULES)).toEqual([]);
    // 配了段池但没有任何档位：不再连周/天范围一起放过
    const pools = [mkPool({ segmentId: 1, pool: {} })];
    expect(validateSeason({ segments, placements, pools }, RULES)).toEqual([
      {
        matchId: 1,
        level: "hard",
        segmentId: 1,
        reason: "第 5 天不在排期段 6–7",
      },
    ]);
  });

  it("commit gate：有 hard 拒绝，soft / report 放行", () => {
    const hard: SeasonViolation = { matchId: 1, level: "hard", reason: "硬冲突" };
    const soft: SeasonViolation = { matchId: 2, level: "soft", reason: "软冲突" };
    const report: SeasonViolation = { matchId: 3, level: "report", reason: "备用报告" };
    expect(seasonCommitGate([soft, hard, report])).toEqual({ canCommit: false, hard: [hard] });
    expect(seasonCommitGate([soft, report])).toEqual({ canCommit: true, hard: [] });
    expect(seasonCommitGate([])).toEqual({ canCommit: true, hard: [] });
  });
});

// ---------- S3：赛季级五端点（走 app.request 全链路） ----------

type PreviewCandidate = {
  key: string;
  seed: number;
  steps: number;
  assignments: Array<{
    matchId: number;
    segmentId: number;
    week: number;
    day: number;
    time: string;
    override: boolean;
  }>;
  metrics: { hard: number; soft: number; report: number };
  violations: Array<{ matchId: number; level: string; reason: string }>;
  hash: string;
};

type PreviewBody = {
  ok: boolean;
  seasonId: number;
  segmentIds: number[];
  totalSegments: number;
  blockedSegmentIds: number[];
  unplayableMatchIds: number[];
  unplacedMatchIds: number[];
  fixed: Array<{ matchId: number }>;
  candidates: PreviewCandidate[];
};

type RevisionDto = {
  revision: number;
  hash: string;
  status: string;
  lockedAt: string | null;
  createdBy: string | null;
  note: string | null;
  assignmentCount: number;
  metrics: { segments: number; matches: number; scheduled: number; hard: number; soft: number };
};

type CommitBody = { ok: boolean; revision: RevisionDto; applied: number };

describe("赛季级排期 S3：preview / commit / publish / restore", () => {
  it("preview：整季 3 套候选 + 部分段求解 + 错误码", async () => {
    const { sqlite } = fullEnv();
    const env = routeEnvOf(sqlite);

    const res = await post(env, "/api/admin/seasons/1/schedule/preview");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;
    expect(body.totalSegments).toBe(16);
    expect(body.segmentIds).toHaveLength(16);
    expect(body.blockedSegmentIds).toEqual([]);
    expect(body.unplayableMatchIds).toEqual([157]);
    expect(body.unplacedMatchIds).toEqual([]);
    expect(body.fixed.map((f) => f.matchId)).toEqual([101, 102, 103, 104, 153, 154]);
    expect(body.candidates.map((cd) => cd.key)).toEqual(["A", "B", "C"]);
    for (const cd of body.candidates) {
      expect(cd.seed).toBe(SEASON_SCHEDULER_SEED + ["A", "B", "C"].indexOf(cd.key) * 7919);
      expect(cd.steps).toBe(SEASON_SCHEDULER_STEPS);
      expect(cd.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(cd.assignments).toHaveLength(50);
      expect(new Set(cd.assignments.map((a) => a.matchId)).size).toBe(50);
      expect(cd.assignments.every((a) => !a.override)).toBe(true);
    }

    // 部分求解：只动第 202 段
    const partial = (await (
      await post(env, "/api/admin/seasons/1/schedule/preview", { segmentIds: [202] })
    ).json()) as PreviewBody;
    expect(partial.segmentIds).toEqual([202]);
    expect(partial.candidates[0].assignments).toHaveLength(4);
    expect(partial.candidates[0].assignments.every((a) => a.segmentId === 202)).toBe(true);

    // 错误码：未知段 400 / 未知赛季 404 / 无窗口赛季 409
    expect((await post(env, "/api/admin/seasons/1/schedule/preview", { segmentIds: [999] })).status).toBe(400);
    expect((await post(env, "/api/admin/seasons/999/schedule/preview")).status).toBe(404);
    sqlite.prepare("INSERT INTO season (id, name, weeks) VALUES (2, 'S10', 31)").run();
    const empty = await post(env, "/api/admin/seasons/2/schedule/preview");
    expect(empty.status).toBe(409);
    expect(((await empty.json()) as { message: string }).message).toContain("没有");
  });

  it("commit：hash 对不上 409；对上后整季落库并生成新 revision，重复提交版本号递增", async () => {
    const { sqlite } = fullEnv();
    const env = routeEnvOf(sqlite);

    const preview = (await (await post(env, "/api/admin/seasons/1/schedule/preview")).json()) as PreviewBody;
    const pick = preview.candidates[0];

    const stale = await post(env, "/api/admin/seasons/1/schedule/commit", {
      key: pick.key,
      hash: await sha256Hex("stale"),
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { message: string }).message).toContain("预览已过期");

    const bad = await post(env, "/api/admin/seasons/1/schedule/commit", { key: "D", hash: pick.hash });
    expect(bad.status).toBe(400);

    const ok = await post(env, "/api/admin/seasons/1/schedule/commit", {
      key: pick.key,
      hash: pick.hash,
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as CommitBody;
    expect(body.applied).toBe(50);
    expect(body.revision.revision).toBe(1);
    expect(body.revision.status).toBe("committed");
    expect(body.revision.createdBy).toBe("管理员");
    expect(body.revision.assignmentCount).toBe(56);
    expect(body.revision.metrics.hard).toBe(0);
    // Medium-4：unmatched 的口径是「已排却映射不到段」，157 是对手未定（unplayable），不能错记
    expect(body.revision.metrics.unmatchedMatchIds).toEqual([]);

    // 场次全落库 + revision assignments + audit
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM match WHERE kickoff_time IS NOT NULL").get()
    ).toEqual({ n: 56 });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM schedule_revision_assignment WHERE revision_id = 1").get()
    ).toEqual({ n: 56 });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'schedule_revision_commit'").get()
    ).toEqual({ n: 1 });

    // 再提交一次：版本号递增成 2
    const again = (await (await post(env, "/api/admin/seasons/1/schedule/preview")).json()) as PreviewBody;
    const second = await post(env, "/api/admin/seasons/1/schedule/commit", {
      key: "B",
      hash: again.candidates[1].hash,
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as CommitBody).revision.revision).toBe(2);
  });

  it("硬冲突 commit 直接 409，一场都不落库", async () => {
    const { sqlite } = fullEnv();
    const env = routeEnvOf(sqlite);
    // fullEnv 没有规则行（lib 走默认兜底）；显式插一条 200h 最小间隔 → 必有 hard
    sqlite
      .prepare(
        `INSERT INTO season_rule
           (season_id, competition, min_gap_hours, soft_gap_hours, report_gap_hours,
            consecutive_home_exempt, last_round_simultaneous)
         VALUES (1, 'all', 200, 200, 200, 1, 1)`
      )
      .run();

    const preview = (await (
      await post(env, "/api/admin/seasons/1/schedule/preview", { segmentIds: [202] })
    ).json()) as PreviewBody;
    expect(preview.candidates.every((cd) => cd.metrics.hard > 0)).toBe(true);

    const rejected = await post(env, "/api/admin/seasons/1/schedule/commit", {
      key: "A",
      hash: preview.candidates[0].hash,
      segmentIds: [202],
    });
    expect(rejected.status).toBe(409);
    const rb = (await rejected.json()) as { message: string; violations: Array<{ level: string }> };
    expect(rb.message).toContain("硬冲突");
    expect(rb.violations.some((v) => v.level === "hard")).toBe(true);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM match WHERE id BETWEEN 105 AND 108 AND kickoff_time IS NOT NULL").get()
    ).toEqual({ n: 0 });
  });

  it("链路：commit → 单场改期后 publish 拒绝 → 部分提交对齐 → publish 锁段 → 幂等 → 回滚撞锁 409", async () => {
    const { sqlite } = fullEnv();
    const env = routeEnvOf(sqlite);

    // 还没有版本：publish 404
    expect((await post(env, "/api/admin/seasons/1/schedule/publish", {})).status).toBe(404);

    const preview = (await (await post(env, "/api/admin/seasons/1/schedule/preview")).json()) as PreviewBody;
    const committed = await post(env, "/api/admin/seasons/1/schedule/commit", {
      key: "A",
      hash: preview.candidates[0].hash,
    });
    expect(committed.status).toBe(200);

    // 改一场的时刻（换到与引擎结果不同的档，保证 hash 变化）。
    // Medium-1 起改期本身落成 r2（committed），版本流与线上保持对齐——
    // publish 的「不一致」拦截不再由改期触发，改由下面绕开版本流的直改模拟。
    const cur = sqlite
      .prepare("SELECT kickoff_day AS d, kickoff_time AS t FROM match WHERE id = 105")
      .get() as { d: number; t: string };
    const moved = cur.d === 6 && cur.t === "17:30" ? "19:30" : "17:30";
    const patched = await call(env, "/api/admin/tournaments/13/matches/105/kickoff", {
      method: "PATCH",
      body: JSON.stringify({ week: 2, day: 6, time: moved }),
    });
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as { revision: number };
    expect(patchedBody.revision).toBe(2);

    // 模拟不落版本的写路径（比如旧窗口快照回滚）：直接 SQL 改时刻 → 最新版本 hash 与线上不一致
    sqlite
      .prepare("UPDATE match SET kickoff_time = '23:59' WHERE id = 105")
      .run();

    // 排期已变：publish 拒绝，要求先对齐
    const stale = await post(env, "/api/admin/seasons/1/schedule/publish", {});
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { message: string }).message).toContain("不一致");

    // 部分提交 202 段 → 新版本与线上对齐 → publish 通过并只锁本段
    const partial = (await (
      await post(env, "/api/admin/seasons/1/schedule/preview", { segmentIds: [202] })
    ).json()) as PreviewBody;
    const reCommit = await post(env, "/api/admin/seasons/1/schedule/commit", {
      key: "A",
      hash: partial.candidates[0].hash,
      segmentIds: [202],
    });
    expect(reCommit.status).toBe(200);
    const reBody = (await reCommit.json()) as CommitBody;
    // r1 = 整季提交；r2 = 上面那次单场改期（Medium-1 起改期也落版本）；这次部分提交 = r3
    expect(reBody.revision.revision).toBe(3);
    expect(reBody.revision.note).toContain("202");

    const published = await post(env, "/api/admin/seasons/1/schedule/publish", {});
    expect(published.status).toBe(200);
    const pb = (await published.json()) as { ok: boolean; revision: RevisionDto; lockedSegmentIds: number[] };
    expect(pb.revision.status).toBe("published");
    expect(pb.revision.lockedAt).toBeTruthy();
    // 版本是全季快照：publish 锁它覆盖的全部未锁段（214 本来就锁着、216 没有已排场次）
    expect(pb.lockedSegmentIds).toContain(202);
    expect(pb.lockedSegmentIds).toHaveLength(14);
    expect(pb.lockedSegmentIds).not.toContain(214);
    expect(pb.lockedSegmentIds).not.toContain(216);
    expect(
      sqlite.prepare("SELECT locked_at FROM round_window WHERE id = 202").get() as { locked_at: string | null }
    ).not.toEqual({ locked_at: null });
    expect(sqlite.prepare("SELECT locked_at FROM round_window WHERE id = 216").get()).toEqual({ locked_at: null });

    // 幂等：再 publish 还是 200
    const again = await post(env, "/api/admin/seasons/1/schedule/publish", {});
    expect(again.status).toBe(200);
    expect(((await again.json()) as { alreadyPublished: boolean }).alreadyPublished).toBe(true);

    // 回滚到 r1：202 段已公布且 105 的时刻不同 → 409
    const blocked = await post(env, "/api/admin/seasons/1/schedule/restore/1");
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { message: string }).message).toContain("先解锁");
  });

  it("restore：回滚写回旧时刻、跳过已开赛场、落成 restored 新版本", async () => {
    const { sqlite } = fullEnv();
    const env = routeEnvOf(sqlite);

    const preview = (await (await post(env, "/api/admin/seasons/1/schedule/preview")).json()) as PreviewBody;
    await post(env, "/api/admin/seasons/1/schedule/commit", { key: "A", hash: preview.candidates[0].hash });

    // 改 105 的时刻（写 override，Medium-1 起这次改期本身落成 r2），再回滚：应恢复引擎结果
    const cur = sqlite
      .prepare("SELECT kickoff_day AS d, kickoff_time AS t FROM match WHERE id = 105")
      .get() as { d: number; t: string };
    const moved = cur.d === 6 && cur.t === "17:30" ? "19:30" : "17:30";
    await call(env, "/api/admin/tournaments/13/matches/105/kickoff", {
      method: "PATCH",
      body: JSON.stringify({ week: 2, day: 6, time: moved, reason: "转播调整" }),
    });

    const res = await post(env, "/api/admin/seasons/1/schedule/restore/1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      revision: RevisionDto;
      restoredMatchIds: number[];
      skippedMatchIds: number[];
      violations: unknown[];
    };
    expect(body.revision.revision).toBe(3);
    expect(body.revision.status).toBe("restored");
    expect(body.revision.note).toContain("回滚自版本 r1");
    expect(body.restoredMatchIds).toHaveLength(52);
    expect(body.skippedMatchIds).toEqual([101, 102, 103, 104]);
    expect(
      sqlite.prepare("SELECT kickoff_week, kickoff_day, kickoff_time, kickoff_override FROM match WHERE id = 105").get()
    ).toEqual({ kickoff_week: 2, kickoff_day: cur.d, kickoff_time: cur.t, kickoff_override: 0 });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'schedule_revision_restore'").get()
    ).toEqual({ n: 1 });

    // 未知版本 404
    expect((await post(env, "/api/admin/seasons/1/schedule/restore/999")).status).toBe(404);
  });

  it("restore：目标版本没有的新排期会被清空并计入 clearedMatchIds", async () => {
    const { sqlite } = fullEnv();
    const env = routeEnvOf(sqlite);

    // r1：全量占位（52 场）
    const first = (await (await post(env, "/api/admin/seasons/1/schedule/preview")).json()) as PreviewBody;
    expect(
      (await post(env, "/api/admin/seasons/1/schedule/commit", { key: "A", hash: first.candidates[0].hash }))
        .status
    ).toBe(200);

    // r2：清掉 105（51 场）
    expect(
      (
        await call(env, "/api/admin/tournaments/13/matches/105/kickoff", {
          method: "PATCH",
          body: JSON.stringify({ week: null, day: null, time: null }),
        })
      ).status
    ).toBe(200);

    // r3：再把 105 排回来（52 场），此时线上比 r2 多一场
    const again = (await (await post(env, "/api/admin/seasons/1/schedule/preview")).json()) as PreviewBody;
    expect(
      (await post(env, "/api/admin/seasons/1/schedule/commit", { key: "A", hash: again.candidates[0].hash }))
        .status
    ).toBe(200);

    const res = await post(env, "/api/admin/seasons/1/schedule/restore/2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      revision: RevisionDto;
      restoredMatchIds: number[];
      clearedMatchIds: number[];
      skippedMatchIds: number[];
    };
    expect(body.revision.revision).toBe(4);
    expect(body.revision.status).toBe("restored");
    expect(body.restoredMatchIds).toHaveLength(51);
    expect(body.clearedMatchIds).toEqual([105]);
    expect(
      sqlite.prepare("SELECT kickoff_week, kickoff_day, kickoff_time FROM match WHERE id = 105").get()
    ).toEqual({ kickoff_week: null, kickoff_day: null, kickoff_time: null });
  });
});

describe("赛季级排期 S3：旧窗口接口内部改走整季体检", () => {
  it("窗口 preview/commit：canCommit 走整季口径，落库照旧", async () => {
    const { sqlite } = fullEnv();
    const env = routeEnvOf(sqlite);

    const preview = (await (
      await post(env, "/api/admin/tournaments/13/windows/202/schedule/preview")
    ).json()) as { proposalHash: string; canCommit: boolean; seasonViolations: unknown[]; conflicts: unknown[] };
    expect(preview.canCommit).toBe(true);
    expect(preview.seasonViolations).toEqual([]);

    const committed = await post(env, "/api/admin/tournaments/13/windows/202/schedule/commit", {
      proposalHash: preview.proposalHash,
    });
    expect(committed.status).toBe(200);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM schedule_snapshot WHERE window_id = 202").get()
    ).toEqual({ n: 1 });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'kickoff_commit'").get()
    ).toEqual({ n: 1 });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM match WHERE id BETWEEN 105 AND 108 AND kickoff_time IS NOT NULL").get()
    ).toEqual({ n: 4 });

    const drill = await call(env, "/api/admin/tournaments/13/windows/202/schedule");
    expect(drill.status).toBe(200);
    expect(((await drill.json()) as { violations: unknown[] }).violations).toEqual([]);

    // Medium-1：窗口提交也记 revision（note 旧窗口提交），assignments = 6 场固定 + 本窗 4 场
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM schedule_revision").get()).toEqual({ n: 1 });
    const revRow = sqlite
      .prepare("SELECT revision, status, note FROM schedule_revision WHERE id = 1")
      .get() as { revision: number; status: string; note: string };
    expect(revRow).toMatchObject({ revision: 1, status: "committed" });
    expect(revRow.note).toContain("旧窗口提交");
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM schedule_revision_assignment WHERE revision_id = 1").get()
    ).toEqual({ n: 10 });
  });

  it("单场改期牵出跨赛事硬冲突：无理由 400，有理由放行并附体检警告", async () => {
    const { sqlite } = fullEnv();
    const env = routeEnvOf(sqlite);

    // 杯赛 141（A 组：红一 vs 红四）改到第 1 周周六 18:00：越窗 + 与已开赛的 101（红一）只隔 0.5h
    const target = { week: 1, day: 6, time: "18:00" };
    const noReason = await call(env, "/api/admin/tournaments/14/matches/141/kickoff", {
      method: "PATCH",
      body: JSON.stringify(target),
    });
    expect(noReason.status).toBe(400);

    const ok = await call(env, "/api/admin/tournaments/14/matches/141/kickoff", {
      method: "PATCH",
      body: JSON.stringify({ ...target, reason: "场馆停电，临时改期" }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: boolean; warnings: string[]; revision: number };
    expect(body.warnings.some((w) => w.includes("硬冲突"))).toBe(true);
    expect(body.warnings.some((w) => w.includes("间隔"))).toBe(true);
    expect(
      sqlite.prepare("SELECT kickoff_override, kickoff_reason FROM match WHERE id = 141").get()
    ).toEqual({ kickoff_override: 1, kickoff_reason: "场馆停电，临时改期" });

    // Medium-1：单场改期也记 revision（note 单场改期），版本里 141 带 override + reason
    expect(body.revision).toBe(1);
    const revRow = sqlite
      .prepare("SELECT status, note FROM schedule_revision WHERE revision = 1")
      .get() as { status: string; note: string };
    expect(revRow.status).toBe("committed");
    expect(revRow.note).toContain("单场改期");
    expect(
      sqlite.prepare("SELECT override, reason FROM schedule_revision_assignment WHERE match_id = 141").get()
    ).toEqual({ override: 1, reason: "场馆停电，临时改期" });
  });

  it("Medium-2 回归：141 带理由改出窗外后，红一同时在打的 202 段照常可提交", async () => {
    const { sqlite } = fullEnv();
    const env = routeEnvOf(sqlite);

    // 原死锁链：141（红一）改到第 1 周 → 与已开赛的 101 只隔 0.5h（hard，双场都固定不可解）；
    // 红一同时打窗口 202 的 105 —— 旧门槛按「本窗队伍」把 141↔101 拉进 202 →
    // 202 canCommit=false 且无 reason 通道，永久死锁。
    await call(env, "/api/admin/tournaments/14/matches/141/kickoff", {
      method: "PATCH",
      body: JSON.stringify({ week: 1, day: 6, time: "18:00", reason: "场馆停电，临时改期" }),
    });

    // 新口径：只看 matchId / relatedMatchId 是否落在窗口里 —— 141、101 都不在 202，不卡
    const preview = (await (
      await post(env, "/api/admin/tournaments/13/windows/202/schedule/preview")
    ).json()) as { proposalHash: string; canCommit: boolean; seasonViolations: unknown[] };
    expect(preview.canCommit).toBe(true);
    expect(preview.seasonViolations).toEqual([]);

    const commit = await post(env, "/api/admin/tournaments/13/windows/202/schedule/commit", {
      proposalHash: preview.proposalHash,
    });
    expect(commit.status).toBe(200);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM match WHERE id BETWEEN 105 AND 108 AND kickoff_time IS NOT NULL").get()
    ).toEqual({ n: 4 });
  });

  it("Medium-2 放行通道：真解不开的窗口硬冲突，commit 带 reason 提交并落 revision", async () => {
    const { sqlite } = fullEnv();
    const env = routeEnvOf(sqlite);
    // 200h 最小间隔：202 段的场次怎么排都躲不开第 1 周已开赛的 101-104 → 必有与本窗相关的 hard
    sqlite
      .prepare(
        `INSERT INTO season_rule
           (season_id, competition, min_gap_hours, soft_gap_hours, report_gap_hours,
            consecutive_home_exempt, last_round_simultaneous)
         VALUES (1, 'all', 200, 200, 200, 1, 1)`
      )
      .run();

    const preview = (await (
      await post(env, "/api/admin/tournaments/13/windows/202/schedule/preview")
    ).json()) as { proposalHash: string; canCommit: boolean; seasonViolations: Array<{ level: string }> };
    expect(preview.canCommit).toBe(false);
    expect(preview.seasonViolations.some((v) => v.level === "hard")).toBe(true);

    const blocked = await post(env, "/api/admin/tournaments/13/windows/202/schedule/commit", {
      proposalHash: preview.proposalHash,
    });
    expect(blocked.status).toBe(422);
    expect(((await blocked.json()) as { message: string }).message).toContain("不能提交");

    const bypassed = await post(env, "/api/admin/tournaments/13/windows/202/schedule/commit", {
      proposalHash: preview.proposalHash,
      reason: "历史脏数据，先提交后治理",
    });
    expect(bypassed.status).toBe(200);
    const bBody = (await bypassed.json()) as { ok: boolean; revision: number };
    expect(bBody.ok).toBe(true);
    expect(bBody.revision).toBe(1);
    // 理由进审计
    const auditRow = sqlite
      .prepare("SELECT detail_json FROM audit_log WHERE action = 'kickoff_commit'")
      .get() as { detail_json: string };
    expect(auditRow.detail_json).toContain("历史脏数据");
    expect(auditRow.detail_json).toContain("bypassedHard");
    // 窗口提交照常写库 + 落 revision（原子同批）
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM match WHERE id BETWEEN 105 AND 108 AND kickoff_time IS NOT NULL").get()
    ).toEqual({ n: 4 });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM schedule_revision_assignment WHERE revision_id = 1").get()
    ).toEqual({ n: 10 });
  });
});
