// 赛季级排期 S5：五端点全链路 + 旧窗口接口兼容性回归。
// 引擎 / 规则 / 版本单测在 tests/kickoff-season.test.ts，本文件只钉两件事：
//   1. 总览 → 预览 → 提交 → 版本列表 → 公布 → 回滚 一条链跑通，revision 状态与哈希连贯；
//   2. 旧 …/windows/:wid/… 接口在赛季级改动后不 break（列表 / 预览 / 提交 / 下钻 / 改期 / 解锁），
//      且赛季 publish 与旧窗口共享 round_window.locked_at。
import { describe, expect, it } from "vitest";
import { call, fullEnv, post, routeEnvOf } from "./kickoff-season.fixtures";

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
  violations: Array<{ level: string; reason: string }>;
  revisions: RevisionDto[];
};

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
  violations: Array<{ level: string; reason: string }>;
  hash: string;
};

type PreviewBody = {
  ok: boolean;
  segmentIds: number[];
  blockedSegmentIds: number[];
  unplayableMatchIds: number[];
  fixed: Array<{ matchId: number }>;
  candidates: PreviewCandidate[];
};

type CommitBody = {
  ok: boolean;
  revision: RevisionDto;
  applied: number;
  violations: Array<{ level: string }>;
};

describe("赛季级排期 S5：五端点全链路", () => {
  it("总览 → 预览 → 提交 → 版本列表 → 公布 → 回滚：revision 状态与哈希连贯", async () => {
    const { sqlite } = fullEnv();
    const env = routeEnvOf(sqlite);

    // 1) 总览：16 段 57 场，初始只排了 6 场（已开赛 4 + 已公布段 2），还没有版本
    const overviewRes = await call(env, "/api/admin/seasons/1/schedule");
    expect(overviewRes.status).toBe(200);
    const before = (await overviewRes.json()) as OverviewBody;
    expect(before.season).toMatchObject({ id: 1, name: "S9" });
    expect(before.counts).toMatchObject({
      segments: 16,
      matches: 57,
      scheduled: 6,
      unscheduled: 51,
      unmatched: 0,
    });
    expect(before.revisions).toEqual([]);
    expect(before.violations.filter((v) => v.level === "hard")).toEqual([]);

    // 2) 预览：三套候选，指标与指纹齐全，不动库
    const previewRes = await post(env, "/api/admin/seasons/1/schedule/preview");
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as PreviewBody;
    expect(preview.fixed.map((f) => f.matchId)).toEqual([101, 102, 103, 104, 153, 154]);
    expect(preview.unplayableMatchIds).toEqual([157]);
    expect(preview.candidates.map((c) => c.key)).toEqual(["A", "B", "C"]);
    for (const candidate of preview.candidates) {
      expect(candidate.metrics.hard).toBe(0);
      expect(candidate.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(candidate.assignments).toHaveLength(50);
    }
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM match WHERE kickoff_time IS NOT NULL").get()
    ).toEqual({ n: 6 });

    // 3) 提交候选 A：落成 r1，写库后全季 56 场有时刻（157 无对手，排不了）
    const pick = preview.candidates[0];
    const commitRes = await post(env, "/api/admin/seasons/1/schedule/commit", {
      key: pick.key,
      hash: pick.hash,
    });
    expect(commitRes.status).toBe(200);
    const committed = (await commitRes.json()) as CommitBody;
    expect(committed).toMatchObject({ ok: true, applied: 50 });
    expect(committed.revision).toMatchObject({
      revision: 1,
      status: "committed",
      assignmentCount: 56,
      createdBy: "管理员",
    });
    expect(committed.revision.hash).toBe(pick.hash);
    expect(committed.revision.metrics).toMatchObject({
      segments: 15,
      matches: 57,
      scheduled: 56,
      hard: 0,
      soft: 0,
    });
    expect(committed.violations.filter((v) => v.level === "hard")).toEqual([]);

    // 4) 版本列表：只有赛季 revision，r1 就是刚提交的哈希
    const snapsRes = await call(env, "/api/admin/seasons/1/schedule/snapshots");
    expect(snapsRes.status).toBe(200);
    const snaps = (await snapsRes.json()) as { seasonId: number; revisions: RevisionDto[] };
    expect(snaps.seasonId).toBe(1);
    expect(snaps.revisions).toHaveLength(1);
    expect(snaps.revisions[0]).toMatchObject({
      revision: 1,
      status: "committed",
      hash: pick.hash,
      lockedAt: null,
    });

    // 5) 公布：版本置 published 并锁住它覆盖且尚未锁定的段
    //    （214 早就锁着、216 没有已排场次，所以是 14 段）
    const publishRes = await post(env, "/api/admin/seasons/1/schedule/publish", { revision: 1 });
    expect(publishRes.status).toBe(200);
    const published = (await publishRes.json()) as {
      ok: boolean;
      revision: RevisionDto;
      lockedSegmentIds: number[];
    };
    expect(published.revision).toMatchObject({ revision: 1, status: "published" });
    expect(published.revision.lockedAt).toBeTruthy();
    expect(published.lockedSegmentIds).toHaveLength(14);
    expect(published.lockedSegmentIds).toContain(202);
    expect(published.lockedSegmentIds).toContain(215);
    expect(published.lockedSegmentIds).not.toContain(214);
    expect(published.lockedSegmentIds).not.toContain(216);

    // 6) 回滚到 r1：已公布段的目标时刻与当前一致 → 放行；落成 r2 restored，哈希不变
    const restoreRes = await post(env, "/api/admin/seasons/1/schedule/restore/1");
    expect(restoreRes.status).toBe(200);
    const restored = (await restoreRes.json()) as {
      ok: boolean;
      revision: RevisionDto;
      restoredMatchIds: number[];
      skippedMatchIds: number[];
      violations: Array<{ level: string }>;
    };
    expect(restored.revision).toMatchObject({
      revision: 2,
      status: "restored",
      hash: pick.hash,
    });
    expect(restored.revision.note).toContain("回滚自版本 r1");
    expect(restored.restoredMatchIds).toHaveLength(52);
    expect(restored.skippedMatchIds).toEqual([101, 102, 103, 104]);
    expect(restored.violations.filter((v) => v.level === "hard")).toEqual([]);

    // 7) 总览复查：两个版本按新→旧，排期仍是 r1 的 56 场
    const afterRes = await call(env, "/api/admin/seasons/1/schedule");
    expect(afterRes.status).toBe(200);
    const after = (await afterRes.json()) as OverviewBody;
    expect(after.counts.scheduled).toBe(56);
    expect(after.placements).toHaveLength(56);
    expect(after.revisions.map((r) => `${r.revision}:${r.status}`)).toEqual([
      "2:restored",
      "1:published",
    ]);
    expect(after.revisions[0].hash).toBe(after.revisions[1].hash);
    expect(after.violations.filter((v) => v.level === "hard")).toEqual([]);
  });
});

describe("赛季级排期 S5：旧窗口接口兼容性回归", () => {
  it("旧列表 / 单段预览 / 提交 / 下钻照常工作，赛季归档不碰旧 schedule_snapshot", async () => {
    const { sqlite } = fullEnv();
    const env = routeEnvOf(sqlite);

    // 旧窗口列表：仍按 tournament 过滤，字段口径不变
    const listRes = await call(env, "/api/admin/tournaments/13/windows");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      windows: Array<{ id: number; matchCount: number; scheduledCount: number; lockedAt: string | null }>;
    };
    expect(list.windows).toHaveLength(10);
    expect(list.windows.find((w) => w.id === 201)).toMatchObject({
      matchCount: 4,
      scheduledCount: 4,
    });
    expect(list.windows.find((w) => w.id === 202)).toMatchObject({
      matchCount: 4,
      scheduledCount: 0,
      lockedAt: null,
    });

    // 旧单段预览 / 提交：照旧写 match 与 schedule_snapshot
    const previewRes = await post(env, "/api/admin/tournaments/13/windows/202/schedule/preview");
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as {
      proposalHash: string;
      canCommit: boolean;
      seasonViolations: unknown[];
    };
    expect(preview.canCommit).toBe(true);
    expect(preview.seasonViolations).toEqual([]);
    expect(preview.proposalHash).toMatch(/^[0-9a-f]{64}$/);

    const commitRes = await post(env, "/api/admin/tournaments/13/windows/202/schedule/commit", {
      proposalHash: preview.proposalHash,
    });
    expect(commitRes.status).toBe(200);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM schedule_snapshot WHERE window_id = 202").get()
    ).toEqual({ n: 1 });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM match WHERE id BETWEEN 105 AND 108 AND kickoff_time IS NOT NULL").get()
    ).toEqual({ n: 4 });
    // Medium-1：窗口提交同时落一条赛季 revision（note 旧窗口提交），assignments 10 场
    const winRev = sqlite
      .prepare("SELECT revision, status, note FROM schedule_revision WHERE revision = 1")
      .get() as { revision: number; status: string; note: string };
    expect(winRev).toMatchObject({ revision: 1, status: "committed" });
    expect(winRev.note).toContain("旧窗口提交");
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM schedule_revision_assignment WHERE revision_id = 1").get()
    ).toEqual({ n: 10 });

    // 旧单段下钻：仍能读到本窗口时刻与体检
    const drillRes = await call(env, "/api/admin/tournaments/13/windows/202/schedule");
    expect(drillRes.status).toBe(200);
    const drill = (await drillRes.json()) as { violations: unknown[] };
    expect(drill.violations).toEqual([]);

    // 归档幂等：窗口提交已经把当前排期落成 r1（Medium-1），archive 直接认账不再重建
    const archiveRes = await post(env, "/api/admin/seasons/1/schedule/archive");
    expect(archiveRes.status).toBe(200);
    const archived = (await archiveRes.json()) as {
      revision: number;
      status: string;
      assignmentCount: number;
      alreadyArchived: boolean;
    };
    expect(archived).toMatchObject({
      revision: 1,
      status: "committed",
      assignmentCount: 10,
      alreadyArchived: true,
    });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM schedule_snapshot").get()
    ).toEqual({ n: 1 });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM schedule_revision_assignment WHERE revision_id = 1").get()
    ).toEqual({ n: 10 });

    // 旧列表仍按旧口径统计
    const afterList = (await (await call(env, "/api/admin/tournaments/13/windows")).json()) as {
      windows: Array<{ id: number; scheduledCount: number }>;
    };
    expect(afterList.windows.find((w) => w.id === 202)?.scheduledCount).toBe(4);
  });

  it("赛季 publish 锁段与旧窗口共享 locked_at：旧预览 409，解锁后恢复，旧改期仍可用", async () => {
    const { sqlite } = fullEnv();
    const env = routeEnvOf(sqlite);

    // 赛季级提交 + 公布，锁住 202
    const preview = (await (
      await post(env, "/api/admin/seasons/1/schedule/preview")
    ).json()) as PreviewBody;
    const commit = await post(env, "/api/admin/seasons/1/schedule/commit", {
      key: "A",
      hash: preview.candidates[0].hash,
    });
    expect(commit.status).toBe(200);
    const publish = await post(env, "/api/admin/seasons/1/schedule/publish", {});
    expect(publish.status).toBe(200);

    // 旧窗口列表看到同一把锁；旧预览被拦
    const list = (await (await call(env, "/api/admin/tournaments/13/windows")).json()) as {
      windows: Array<{ id: number; lockedAt: string | null }>;
    };
    expect(list.windows.find((w) => w.id === 202)?.lockedAt).toBeTruthy();
    const blocked = await post(env, "/api/admin/tournaments/13/windows/202/schedule/preview");
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { message: string }).message).toContain("已公布");

    // 旧解锁仍要理由；解锁后旧预览恢复
    expect((await post(env, "/api/admin/tournaments/13/windows/202/unlock", {})).status).toBe(400);
    const unlocked = await post(env, "/api/admin/tournaments/13/windows/202/unlock", {
      reason: "补赛调整",
    });
    expect(unlocked.status).toBe(200);
    expect((await post(env, "/api/admin/tournaments/13/windows/202/schedule/preview")).status).toBe(200);

    // 旧单场改期仍可用（带理由）：不产生旧快照，改的是 schedule_revision（Medium-1，r2）
    const patch = await call(env, "/api/admin/tournaments/13/matches/105/kickoff", {
      method: "PATCH",
      body: JSON.stringify({ week: 2, day: 7, time: "20:00", reason: "转播调整" }),
    });
    expect(patch.status).toBe(200);
    expect(
      sqlite.prepare("SELECT kickoff_override, kickoff_reason FROM match WHERE id = 105").get()
    ).toEqual({ kickoff_override: 1, kickoff_reason: "转播调整" });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM schedule_snapshot").get()
    ).toEqual({ n: 0 });

    // 赛季版本状态不受旧窗口解锁影响；改期本身追加成 r2（committed），r1 仍 published
    const snaps = (await (
      await call(env, "/api/admin/seasons/1/schedule/snapshots")
    ).json()) as { revisions: RevisionDto[] };
    expect(snaps.revisions).toHaveLength(2);
    expect(snaps.revisions[0]).toMatchObject({ revision: 2, status: "committed" });
    expect(snaps.revisions[0].note).toContain("单场改期");
    expect(snaps.revisions[1]).toMatchObject({ revision: 1, status: "published" });
  });
});
