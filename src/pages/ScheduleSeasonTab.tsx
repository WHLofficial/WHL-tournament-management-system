// 赛季排期总览页（S4，design §6「赛季排期台」）：
//   1. 阶段矩阵表：行 = 赛事，列 = 排期段（round_window），每格状态灯 + 已排/可排数量，点格下钻；
//   2. 方案对比：POST preview 生成 3 套候选方案，并排三栏只看指标摘要，不做拖拽；
//   3. 冲突展示：状态灯 + 数量，点开看具体场次/球队/间隔，每条带「应用建议」（该段局部重排）；
//   4. 快照历史：revision 列表 + 一键恢复（POST restore）。
// 不做时间轴视图、不做冲突热图（本期范围外）。单段下钻走旧 KickoffTab（传 segmentId）。
//
// 赛季入口：本页挂在赛事管理下（tid），通过窗口清单的 seasonId 字段跳到赛季维度；
// 一个赛事理论上只属于一个赛季，出现多个时下拉切换。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { TournamentDetailDTO } from "../../shared/types";
import { kickoffText, weekdayCn } from "../lib/kickoff";
import { useTimeFmt } from "../lib/datetime";

// —— 后端 DTO（worker/routes/admin/kickoffSeason.ts 的响应形状）——

type SegmentDto = {
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

type SeasonViolationDto = {
  matchId: number; // 0 = 池容量类违规
  level: "hard" | "soft" | "report";
  reason: string;
  teamId?: number;
  segmentId?: number;
};

type RevisionDto = {
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

type OverviewDto = {
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
  violations: SeasonViolationDto[];
  revisions: RevisionDto[];
};

type CandidateMetrics = {
  hard: number;
  soft: number;
  report: number;
  minGapHours: number | null;
  lateRatio: number;
  maxConsecutiveLoad: number;
};

type CandidateDto = {
  key: "A" | "B" | "C";
  seed: number;
  steps: number;
  metrics: CandidateMetrics;
  violations: SeasonViolationDto[];
  /** 该候选自己还没落档的场次；结果级 unplacedMatchIds 是三套并集，不能拿来判断单套 */
  unplacedMatchIds: number[];
  hash: string;
};

type PreviewDto = {
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

type CommitDto = {
  ok: boolean;
  revision: RevisionDto;
  applied: number;
  violations: SeasonViolationDto[];
};

type RestoreDto = {
  ok: boolean;
  revision: RevisionDto;
  restoredMatchIds: number[];
  clearedMatchIds: number[];
  skippedMatchIds: number[];
  skippedReasons: Array<{ matchId: number; reason: "not_pending" | "scope_missing" }>;
  violations: SeasonViolationDto[];
};

type WindowLiteDto = { id: number; seasonId: number; matchCount: number };

const STREAM_LABEL: Record<string, string> = {
  league: "联赛",
  playoff: "季后赛",
  group: "小组赛",
  elim: "淘汰赛",
};

type Light = "green" | "yellow" | "red" | "gray";

function segLight(seg: SegmentDto, segViolations: SeasonViolationDto[]): Light {
  // 硬冲突优先于锁定：锁定的段也可能有病，不能一颗灰点把红点盖掉。
  if (segViolations.some((v) => v.level === "hard")) return "red";
  if (seg.lockedAt) return "gray"; // 已公布锁定：先解锁才能动
  if (
    segViolations.some((v) => v.level === "soft") ||
    seg.scheduledCount < seg.playableCount
  )
    return "yellow";
  return "green";
}

function segLabel(seg: SegmentDto): string {
  const leg = seg.leg == null ? "" : ` 第${seg.leg}回合`;
  const days =
    seg.dayStart === seg.dayEnd ? `周${weekdayCn(seg.dayStart)}` : `周${weekdayCn(seg.dayStart)}–周${weekdayCn(seg.dayEnd)}`;
  return `第 ${seg.week} 周 · ${STREAM_LABEL[seg.stream] ?? seg.stream}第${seg.round}轮${leg}（${days}）`;
}

function levelIcon(level: SeasonViolationDto["level"]): string {
  return level === "hard" ? "⛔" : level === "soft" ? "⚠️" : "💬";
}

/** 三套候选里挑综合最优：先排除自己还有未落档场次的候选，再按硬→软→报告比较 */
function pickBest(candidates: CandidateDto[]): CandidateDto | null {
  if (candidates.length === 0) return null;
  const complete = candidates.filter((c) => c.unplacedMatchIds.length === 0);
  const pool = complete.length > 0 ? complete : candidates;
  return [...pool].sort(
    (a, b) =>
      a.metrics.hard - b.metrics.hard || a.metrics.soft - b.metrics.soft || a.metrics.report - b.metrics.report,
  )[0];
}

export default function ScheduleSeasonTab({
  detail,
  reload,
  onDrilldown,
}: {
  detail: TournamentDetailDTO;
  reload: () => void;
  /**
   * 点矩阵格跳单段下钻（round_window.id 即 segmentId）。
   * 矩阵含全赛季所有赛事的段——跨赛事段必须把段属赛事一起带回（High-1：
   * 只回传 segmentId 的话，下钻页会用当前赛事的 tid 拉窗口清单与下钻视图，
   * 对方的段在当前赛事名下永远 404「窗口不存在」）。
   */
  onDrilldown: (segment: { id: number; tournamentId: number; tournamentName: string }) => void;
}) {
  const tid = detail.tournament.id;
  const { time } = useTimeFmt(); // 快照历史的创建时间走共享时区偏好层，不裸切 UTC
  const [seasonIds, setSeasonIds] = useState<number[] | null>(null);
  const [seasonId, setSeasonId] = useState<number | null>(null);
  const [overview, setOverview] = useState<OverviewDto | null>(null);
  const [preview, setPreview] = useState<PreviewDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // 赛季切换后旧请求可能晚回来；用 ref 记当前赛季，别让旧响应覆盖新总览。
  const seasonIdRef = useRef<number | null>(null);
  useEffect(() => {
    seasonIdRef.current = seasonId;
  }, [seasonId]);

  // 赛事 → 赛季：窗口清单带 seasonId（S4 新增字段），一个赛事通常只挂一个赛季
  useEffect(() => {
    let alive = true;
    // 切赛事时旧赛季/旧总览一律作废；否则会出现「赛事 A 的 seasonId 去拉赛事 B 的总览」。
    setOverview(null);
    setPreview(null);
    setSeasonIds(null);
    setSeasonId(null);
    setMsg(null);
    void (async () => {
      try {
        const body = await api<{ windows: WindowLiteDto[] }>(`/api/admin/tournaments/${tid}/windows`);
        if (!alive) return;
        const ids = [...new Set(body.windows.map((w) => w.seasonId))];
        setSeasonIds(ids);
        setSeasonId((cur) => (cur != null && ids.includes(cur) ? cur : (ids[0] ?? null)));
      } catch (e) {
        if (alive) setMsg(e instanceof Error ? e.message : "加载窗口失败");
      }
    })();
    return () => {
      alive = false;
    };
  }, [tid]);

  const loadOverview = useCallback(async () => {
    if (seasonId == null) return;
    const requested = seasonId;
    const body = await api<OverviewDto>(`/api/admin/seasons/${requested}/schedule`);
    if (seasonIdRef.current !== requested || body.season.id !== requested) return;
    setOverview(body);
  }, [seasonId]);

  useEffect(() => {
    setOverview(null);
    setPreview(null);
    if (seasonId == null) return;
    void loadOverview().catch((e) => setMsg(e instanceof Error ? e.message : "加载赛季总览失败"));
  }, [loadOverview, seasonId]);

  const refresh = async () => {
    await loadOverview();
    reload();
  };

  const act = async (fn: () => Promise<string | null>) => {
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
  };

  // —— 矩阵数据：按赛事分组；违规按段归类 ——
  const violationsBySegment = useMemo(() => {
    const m = new Map<number, SeasonViolationDto[]>();
    for (const v of overview?.violations ?? []) {
      if (v.segmentId == null) continue;
      m.set(v.segmentId, [...(m.get(v.segmentId) ?? []), v]);
    }
    return m;
  }, [overview]);

  const tournamentRows = useMemo(() => {
    // 后端按周次排序，联赛与杯赛会交替出现；必须按赛事聚合，不能假设相邻即同一赛事。
    const rows = new Map<number, { tournamentId: number; name: string; segs: SegmentDto[] }>();
    for (const seg of overview?.segments ?? []) {
      const row = rows.get(seg.tournamentId);
      if (row) row.segs.push(seg);
      else rows.set(seg.tournamentId, { tournamentId: seg.tournamentId, name: seg.tournamentName, segs: [seg] });
    }
    return [...rows.values()];
  }, [overview]);

  // —— 方案对比：整季三套候选 ——
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

  const counts = overview?.counts;
  const hardTotal = overview?.violations.filter((v) => v.level === "hard").length ?? 0;
  const softTotal = overview?.violations.filter((v) => v.level === "soft").length ?? 0;
  const reportTotal = overview?.violations.filter((v) => v.level === "report").length ?? 0;

  return (
    <section className="card">
      <h3>赛季排期</h3>
      <p className="muted">
        整季视角：矩阵看每段的排期状态，三套方案并排对比后一键应用；单段微调点格子进下钻页。
      </p>

      {seasonIds && seasonIds.length === 0 && (
        <p className="muted">这个赛事还没有赛历窗口。先导入赛季赛历（season / round_window）。</p>
      )}

      {seasonIds && seasonIds.length > 1 && (
        <div className="btn-row" style={{ marginTop: 8 }}>
          <select value={seasonId ?? ""} onChange={(e) => setSeasonId(Number(e.target.value))} disabled={busy}>
            {seasonIds.map((id) => (
              <option key={id} value={id}>
                赛季 #{id}
              </option>
            ))}
          </select>
        </div>
      )}

      {msg && <p className="muted">{msg}</p>}

      {overview && (
        <>
          <p className="muted">
            {overview.season.name}：{counts?.segments} 段 · {counts?.matches} 场（已排 {counts?.scheduled} · 待排{" "}
            {counts?.unscheduled}
            {counts && counts.unplayable > 0 ? ` · 对手未定 ${counts.unplayable}` : ""}
            {counts && counts.unmatched > 0 ? ` · 已排未归段 ${counts.unmatched}` : ""}）
            <span style={{ marginLeft: 10 }}>
              <span className="season-dot season-dot-red" />
              硬冲突 {hardTotal} · <span className="season-dot season-dot-yellow" />
              软冲突 {softTotal} · <span className="season-dot season-dot-gray" />
              提示 {reportTotal}
            </span>
          </p>

          {/* —— 1. 阶段矩阵：行 = 赛事，列 = 排期段 —— */}
          {tournamentRows.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>赛事</th>
                  <th>排期段（点格子下钻）</th>
                </tr>
              </thead>
              <tbody>
                {tournamentRows.map((row) => (
                  <tr key={row.tournamentId}>
                    <td style={{ whiteSpace: "nowrap" }}>{row.name}</td>
                    <td>
                      <div className="btn-row" style={{ flexWrap: "wrap", gap: 8 }}>
                        {row.segs.map((seg) => {
                          const segViol = violationsBySegment.get(seg.id) ?? [];
                          const light = segLight(seg, segViol);
                          return (
                            <button
                              key={seg.id}
                              className="seg-cell"
                              disabled={busy}
                              title={segLabel(seg)}
                              onClick={() =>
                                onDrilldown({
                                  id: seg.id,
                                  tournamentId: seg.tournamentId,
                                  tournamentName: seg.tournamentName,
                                })
                              }
                            >
                              <span className={`season-dot season-dot-${light}`} />
                              第{seg.week}周 · 第{seg.round}轮{seg.leg != null ? `·L${seg.leg}` : ""}
                              {seg.lockedAt ? " 🔒" : ""} {seg.scheduledCount}/{seg.playableCount}
                            </button>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* —— 2. 冲突展示：场次/球队/间隔 + 一键应用建议 —— */}
          {overview.violations.length > 0 && (
            <details className="season-viol" open={hardTotal > 0}>
              <summary>
                冲突明细（{overview.violations.length} 条：硬 {hardTotal} · 软 {softTotal} · 提示 {reportTotal}）
              </summary>
              <ul style={{ margin: "6px 0", paddingLeft: 18 }}>
                {overview.violations.map((v, idx) => {
                  const seg = overview.segments.find((s) => s.id === v.segmentId);
                  const label = seg ? segLabel(seg) : "未挂接段";
                  return (
                    <li key={idx} style={{ margin: "3px 0" }}>
                      {levelIcon(v.level)} {v.matchId > 0 ? `#${v.matchId} ` : ""}
                      {v.reason}
                      <span className="muted">（{label}）</span>
                      {v.segmentId != null && v.level !== "report" && seg?.lockedAt == null && (
                        <button
                          className="btn btn-sm"
                          style={{ marginLeft: 8 }}
                          disabled={busy}
                          onClick={() => void applySuggestion(v.segmentId!, label)}
                        >
                          应用建议
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              <p className="muted">「应用建议」= 让引擎只重排这一段并提交最优方案；硬冲突解不掉时会直接告诉你原因。</p>
            </details>
          )}

          {/* —— 3. 方案对比：并排三栏，只看指标摘要，不做拖拽 —— */}
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button className="btn" disabled={busy || seasonId == null} onClick={genPreview}>
              生成整季方案（3 套）
            </button>
            {preview && (
              <span className="muted">
                求解范围 {preview.segmentIds.length}/{preview.totalSegments} 段 · 已锁定上下文 {preview.fixed.length} 场
                {preview.unplacedMatchIds.length > 0 ? ` · 未排上 ${preview.unplacedMatchIds.length} 场` : ""}
                {preview.blockedSegmentIds.length > 0 ? ` · 缺时刻池段 ${preview.blockedSegmentIds.length} 个` : ""}
              </span>
            )}
          </div>

          {preview && (
            <div className="season-cols">
              {preview.candidates.map((cand) => (
                <div key={cand.key} className="season-col">
                  <h4>
                    方案 {cand.key}
                    <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
                      {" "}
                      seed {cand.seed} · {cand.steps} 步
                    </span>
                  </h4>
                  <div className="season-metric">
                    <span>硬冲突</span>
                    <span className={`v${cand.metrics.hard > 0 ? " season-bad" : ""}`}>{cand.metrics.hard}</span>
                  </div>
                  <div className="season-metric">
                    <span>软冲突</span>
                    <span className="v">{cand.metrics.soft}</span>
                  </div>
                  <div className="season-metric">
                    <span>备用提示（72h）</span>
                    <span className="v">{cand.metrics.report}</span>
                  </div>
                  <div className="season-metric">
                    <span>最小间隔</span>
                    <span className="v">{cand.metrics.minGapHours == null ? "—" : `${cand.metrics.minGapHours.toFixed(1)}h`}</span>
                  </div>
                  <div className="season-metric">
                    <span>晚场占比（≥20:00）</span>
                    <span className="v">{(cand.metrics.lateRatio * 100).toFixed(0)}%</span>
                  </div>
                  <div className="season-metric">
                    <span>最大连续负荷（场/周）</span>
                    <span className="v">{cand.metrics.maxConsecutiveLoad}</span>
                  </div>
                  <button
                    className="btn"
                    style={{ marginTop: 8, width: "100%" }}
                    disabled={
                      busy ||
                      cand.metrics.hard > 0 ||
                      cand.unplacedMatchIds.length > 0 ||
                      preview.blockedSegmentIds.length > 0
                    }
                    title={
                      cand.metrics.hard > 0
                        ? "有硬冲突，提交会被拒（409）"
                        : cand.unplacedMatchIds.length > 0
                          ? `方案 ${cand.key} 还有 ${cand.unplacedMatchIds.length} 场没落档，先补齐`
                          : preview.blockedSegmentIds.length > 0
                            ? "还有段缺时刻池，先补池子"
                            : undefined
                    }
                    onClick={() => void commitCandidate(cand)}
                  >
                    应用此方案
                  </button>
                  {cand.metrics.hard > 0 && <p className="muted">有硬冲突，先处理红色冲突或调整规则。</p>}
                </div>
              ))}
            </div>
          )}

          {/* —— 4. 快照历史：revision 列表 + 一键恢复 —— */}
          <h4 style={{ margin: "18px 0 6px" }}>快照历史</h4>
          {overview.revisions.length === 0 && (
            <p className="muted">还没有版本。提交一次方案、或回滚一次，都会在这里落成新版本。</p>
          )}
          {overview.revisions.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>版本</th>
                  <th>状态</th>
                  <th>场次</th>
                  <th>体检</th>
                  <th>创建人 / 时间</th>
                  <th>备注</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {overview.revisions.map((rev) => (
                  <tr key={rev.id}>
                    <td>r{rev.revision}</td>
                    <td>
                      {rev.status === "published" ? "已公布" : rev.status === "restored" ? "回滚版" : "已提交"}
                      {rev.lockedAt ? " 🔒" : ""}
                    </td>
                    <td>{rev.assignmentCount}</td>
                    <td>
                      {rev.metrics ? `硬 ${rev.metrics.hard} · 软 ${rev.metrics.soft}` : "—"}
                    </td>
                    <td className="muted">
                      {rev.createdBy ?? "—"} / {time(rev.createdAt)}
                    </td>
                    <td className="muted" style={{ maxWidth: 260 }}>
                      {rev.note ?? "—"}
                    </td>
                    <td>
                      <div className="btn-row">
                        <button
                          className="btn btn-sm"
                          disabled={busy || hardTotal > 0 || rev.assignmentCount === 0}
                          title={
                            hardTotal > 0
                              ? "整季还有硬冲突，先处理再公布"
                              : rev.assignmentCount === 0
                                ? "空版本不能公布"
                                : rev.status === "published"
                                  ? "已公布版本：解锁后可再次点击补锁"
                                  : undefined
                          }
                          onClick={() => void publishRevision(rev)}
                        >
                          {rev.status === "published" ? "补锁" : "公布"}
                        </button>
                        <button className="btn btn-sm" disabled={busy} onClick={() => void restoreRevision(rev)}>
                          恢复
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {overview.placements.length > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary className="muted">已排场次（{overview.placements.length} 场，虚拟时刻）</summary>
              <p className="muted" style={{ margin: "6px 0" }}>
                {overview.placements
                  .map((p) => `#${p.matchId} ${kickoffText(p.week, p.day, p.time)}${p.override ? "（改期）" : ""}`)
                  .slice(0, 80)
                  .join("；")}
                {overview.placements.length > 80 ? " …" : ""}
              </p>
            </details>
          )}
        </>
      )}
    </section>
  );
}
