// 赛季排期数据层（IA 迁移，design-season-scheduler-ui.md §7.1）：
// 原 ScheduleSeasonTab.tsx（已删除）整体迁出的后端 DTO、聚合工具与
// preview / commit / publish / restore 操作，以及赛季级 useSeasonSchedule hook。
// 页面（SeasonSchedulePage）与赛历/宽屏两个视图都从这里拿数据。
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";

// —— 后端 DTO（worker/routes/admin/kickoffSeason.ts 的响应形状）——

export type SegmentDto = {
  id: number;
  tournamentId: number;
  tournamentName: string;
  competition: string;
  stream: string;
  round: number;
  leg: number | null;
  week: number;
  dayStart: number;
  dayEnd: number;
  lockedAt: string | null;
  hasOverride: boolean;
  matchCount: number;
  scheduledCount: number;
  playableCount: number;
};

export type SeasonViolationDto = {
  matchId: number; // 0 = 池容量类违规
  level: "hard" | "soft" | "report";
  reason: string;
  teamId?: number;
  segmentId?: number;
};

export type RevisionDto = {
  id: number;
  seasonId: number;
  revision: number;
  hash: string;
  status: string;
  lockedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  metrics: { segments: number; matches: number; scheduled: number; unmatchedMatchIds: number[]; hard: number; soft: number } | null;
  note: string | null;
  assignmentCount: number;
};

export type OverviewDto = {
  season: { id: number; name: string; weeks: number };
  counts: {
    segments: number;
    matches: number;
    scheduled: number;
    unscheduled: number;
    /** 已排时刻但映射不到排期段（归档/总览/回滚的“烂账”口径） */
    unmatched: number;
    /** 对手未定，当前根本排不了 */
    unplayable: number;
  };
  segments: SegmentDto[];
  placements: Array<{ matchId: number; segmentId: number; week: number; day: number; time: string; override: boolean; reason: string | null }>;
  unmatchedMatchIds: number[];
  /** 至少落入过一个非草稿版本的段：用于区分「已保存」与「草稿」 */
  savedSegmentIds: number[];
  violations: SeasonViolationDto[];
  revisions: RevisionDto[];
};

export type CandidateMetrics = {
  hard: number;
  soft: number;
  report: number;
  minGapHours: number | null;
  lateRatio: number;
  maxConsecutiveLoad: number;
};

export type CandidateDto = {
  key: "A" | "B" | "C";
  seed: number;
  steps: number;
  metrics: CandidateMetrics;
  violations: SeasonViolationDto[];
  /** 该候选自己还没落档的场次；结果级 unplacedMatchIds 是三套并集，不能拿来判断单套 */
  unplacedMatchIds: number[];
  hash: string;
};

export type PreviewDto = {
  ok: boolean;
  seasonId: number;
  segmentIds: number[];
  totalSegments: number;
  blockedSegmentIds: number[];
  unplayableMatchIds: number[];
  unplacedMatchIds: number[];
  fixed: Array<{ matchId: number; segmentId: number; week: number; day: number; time: string }>;
  candidates: CandidateDto[];
};

export type CommitDto = {
  ok: boolean;
  revision: RevisionDto;
  applied: number;
  violations: SeasonViolationDto[];
};

export type RestoreDto = {
  ok: boolean;
  revision: RevisionDto;
  restoredMatchIds: number[];
  clearedMatchIds: number[];
  skippedMatchIds: number[];
  skippedReasons: Array<{ matchId: number; reason: "not_pending" | "scope_missing" }>;
  violations: SeasonViolationDto[];
};

/** 版本状态文案：draft / committed / published / restored 全口径 */
export function revisionStatusText(status: string): string {
  if (status === "draft") return "草稿";
  if (status === "published") return "已公布";
  if (status === "restored") return "已恢复";
  return "已保存";
}

/** 赛季名里的序号（S9 → 9）；解析不到时退回 season id，避免同屏出现两套序号 */
export function seasonNumberFromName(name: string, fallbackId: number): number {
  const m = /^S(\d+)$/i.exec(name.trim());
  return m ? Number(m[1]) : fallbackId;
}

export type SegmentStatus = "published" | "saved" | "draft";

/** 段级三态：已公布（locked）> 已保存（至少进过一个非草稿版本）> 草稿 */
export function segmentStatus(seg: SegmentDto, savedSegmentIds: readonly number[]): SegmentStatus {
  if (seg.lockedAt != null) return "published";
  return savedSegmentIds.includes(seg.id) ? "saved" : "draft";
}

/** 三套候选里挑综合最优：先排除自己还有未落档场次的候选，再按硬→软→报告比较 */
export function pickBest(candidates: CandidateDto[]): CandidateDto | null {
  if (candidates.length === 0) return null;
  const complete = candidates.filter((c) => c.unplacedMatchIds.length === 0);
  const pool = complete.length > 0 ? complete : candidates;
  return [...pool].sort(
    (a, b) =>
      a.metrics.hard - b.metrics.hard || a.metrics.soft - b.metrics.soft || a.metrics.report - b.metrics.report,
  )[0];
}

/** 违规按段归类（自原 ScheduleSeasonTab 迁出） */
export function violationsBySegment(overview: OverviewDto | null): Map<number, SeasonViolationDto[]> {
  const m = new Map<number, SeasonViolationDto[]>();
  for (const v of overview?.violations ?? []) {
    if (v.segmentId == null) continue;
    m.set(v.segmentId, [...(m.get(v.segmentId) ?? []), v]);
  }
  return m;
}

/**
 * 按赛事聚合轮次安排（自原 ScheduleSeasonTab 迁出）：
 * 后端按周次排序，联赛与杯赛会交替出现；必须按赛事聚合，不能假设相邻即同一赛事。
 */
export function tournamentRows(
  overview: OverviewDto | null,
): Array<{ tournamentId: number; name: string; segs: SegmentDto[] }> {
  const rows = new Map<number, { tournamentId: number; name: string; segs: SegmentDto[] }>();
  for (const seg of overview?.segments ?? []) {
    const row = rows.get(seg.tournamentId);
    if (row) row.segs.push(seg);
    else rows.set(seg.tournamentId, { tournamentId: seg.tournamentId, name: seg.tournamentName, segs: [seg] });
  }
  return [...rows.values()];
}

/**
 * 赛季排期总览 hook：GET /api/admin/seasons/:id/schedule + 四个写操作。
 * seasonId 来自路由参数（不再走 /windows 反查）；沿用 seasonIdRef 防旧响应覆盖新总览。
 */
export function useSeasonSchedule(seasonId: number) {
  const [overview, setOverview] = useState<OverviewDto | null>(null);
  const [preview, setPreview] = useState<PreviewDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  // 赛季切换后旧请求可能晚回来；用 ref 记当前赛季，别让旧响应覆盖新总览。
  const seasonIdRef = useRef(seasonId);
  useEffect(() => {
    seasonIdRef.current = seasonId;
  }, [seasonId]);

  const loadOverview = useCallback(async () => {
    const requested = seasonId;
    const body = await api<OverviewDto>(`/api/admin/seasons/${requested}/schedule`);
    if (seasonIdRef.current !== requested || body.season.id !== requested) return;
    setOverview(body);
  }, [seasonId]);

  useEffect(() => {
    setOverview(null);
    setPreview(null);
    setMsg(null);
    setLoading(true);
    let alive = true;
    loadOverview()
      .catch((e) => {
        if (alive) setMsg(e instanceof Error ? e.message : "加载赛季总览失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [loadOverview]);

  const refresh = useCallback(async () => {
    await loadOverview();
  }, [loadOverview]);

  const act = useCallback(async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setMsg(null);
    try {
      const note = await fn();
      if (note) setMsg(note);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }, []);

  // —— 排法预览：整季三套候选 ——
  const genPreview = () =>
    act(async () => {
      const p = await api<PreviewDto>(`/api/admin/seasons/${seasonId}/schedule/preview`, {
        method: "POST",
        body: {},
        timeoutMs: 60_000, // 固定步数 2000×3 候选，正常几秒；放宽防慢环境
      });
      setPreview(p);
      const best = pickBest(p.candidates);
      return best
        ? `已生成 3 套方案：最优 ${best.key}（硬 ${best.metrics.hard} / 软 ${best.metrics.soft}）`
        : "没有可排的场次";
    });

  const commitCandidate = (candidate: CandidateDto, segmentIds?: number[]) =>
    act(async () => {
      const scope = segmentIds ? `（只重排选中的段）` : "";
      if (!window.confirm(`把方案 ${candidate.key} 写进赛程${scope}？已开赛的场不动。`)) return null;
      const c = await api<CommitDto>(`/api/admin/seasons/${seasonId}/schedule/commit`, {
        method: "POST",
        body: { key: candidate.key, hash: candidate.hash, ...(segmentIds ? { segmentIds } : {}) },
      });
      setPreview(null);
      await refresh();
      return `已应用方案 ${candidate.key}：写回 ${c.applied} 场，版本 r${c.revision.revision}${
        c.violations.length > 0 ? `（剩余体检提示 ${c.violations.length} 条）` : ""
      }`;
    });

  // —— 冲突建议：对该段跑一次局部求解，挑最优候选直接应用 ——
  const applySuggestion = (segmentId: number, label: string) =>
    act(async () => {
      const p = await api<PreviewDto>(`/api/admin/seasons/${seasonId}/schedule/preview`, {
        method: "POST",
        body: { segmentIds: [segmentId] },
        timeoutMs: 60_000,
      });
      const best = pickBest(p.candidates);
      if (!best) return "该段没有可排的场次（对手未定或没有时刻档）";
      if (best.unplacedMatchIds.length > 0 || p.blockedSegmentIds.includes(segmentId))
        return `这一段还没排满（方案 ${best.key} 未落档 ${best.unplacedMatchIds.length} 场），先补池子/调整窗口`;
      // 局部预览的 metrics 仍是全季口径，别段的 hard 不该卡这一段；
      // 能不能提交交给后端按 segmentIds 过滤后的 gate 判定。
      if (!window.confirm(`把「${label}」重排成方案 ${best.key}？只动这一段，已开赛/已公布的场不动。`)) return null;
      const c = await api<CommitDto>(`/api/admin/seasons/${seasonId}/schedule/commit`, {
        method: "POST",
        body: { key: best.key, hash: best.hash, segmentIds: [segmentId] },
      });
      setPreview(null);
      await refresh();
      return `已应用建议（方案 ${best.key}）：写回 ${c.applied} 场，版本 r${c.revision.revision}`;
    });

  // —— 快照历史：公布 / 一键恢复 ——
  const publishRevision = (rev: RevisionDto) =>
    act(async () => {
      if (rev.seasonId !== seasonId) return "版本不属于当前赛季，请刷新后再试";
      if (!window.confirm(`公布版本 r${rev.revision} 并锁定它覆盖的段？`)) return null;
      const r = await api<{ lockedSegmentIds: number[]; alreadyPublished?: boolean }>(
        `/api/admin/seasons/${seasonId}/schedule/publish`,
        { method: "POST", body: { revision: rev.revision } },
      );
      setPreview(null);
      await refresh();
      return r.alreadyPublished
        ? `r${rev.revision} 已是公布状态，本次补齐锁定 ${r.lockedSegmentIds.length} 段`
        : `已公布 r${rev.revision}，锁定 ${r.lockedSegmentIds.length} 段`;
    });

  const restoreRevision = (rev: RevisionDto) =>
    act(async () => {
      if (rev.seasonId !== seasonId) return "版本不属于当前赛季，请刷新后再试";
      if (!window.confirm(`回滚到版本 r${rev.revision}？已开赛的场不动，锁定段时刻不同会被拒绝。`)) return null;
      const r = await api<RestoreDto>(`/api/admin/seasons/${seasonId}/schedule/restore/${rev.revision}`, {
        method: "POST",
      });
      setPreview(null);
      await refresh();
      const reasons = r.skippedReasons ?? [];
      const scopeMissing = reasons.filter((x) => x.reason === "scope_missing").length;
      const notPending = reasons.filter((x) => x.reason === "not_pending").length;
      return `已回滚到 r${rev.revision}：写回 ${r.restoredMatchIds.length} 场、跳过 ${
        r.skippedMatchIds.length
      } 场（已开赛 ${notPending}、赛历已重建 ${scopeMissing}），落成版本 r${r.revision.revision}${
        r.violations.length > 0 ? `；剩余体检提示 ${r.violations.length} 条` : ""
      }`;
    });

  return {
    overview,
    preview,
    busy,
    loading,
    msg,
    setMsg,
    refresh,
    genPreview,
    commitCandidate,
    applySuggestion,
    publishRevision,
    restoreRevision,
  };
}
