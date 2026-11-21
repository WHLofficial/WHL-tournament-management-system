// 宽屏总览视图（design-season-scheduler-ui.md §10 / mockup season-scheduler.html）：
// 全季尺（31 格密度条 + 冲突红线）+ 216px 赛事列 + 31 列矩阵（横向滚动、周头/赛事列 sticky）
// + inspector（矩阵下方 280px+1fr 双列）+ 版本轨道 + 全部冲突弹层 + 三套排法弹层。
// 操作能力在此视图接线：看看三套排法（preview → commit）、公布（publish）、恢复（restore）、
// 应用建议（单段局部重排）；赛历视图只看形状（设计稿 §10）。
// 术语按 GLOSSARY.md：轮次安排、排法、第 N 版、必须解决 / 建议调整 / 提醒。
import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import type {
  CandidateDto,
  OverviewDto,
  PreviewDto,
  RevisionDto,
  SeasonViolationDto,
  SegmentDto,
  SegmentStatus,
} from "./data";
import { pickBest, revisionStatusText, segmentStatus } from "./data";
import { kickoffText } from "../../lib/kickoff";
import { dayRangeText, phaseOf, type CalLane } from "./CalendarView";

const STREAM_LABEL: Record<string, string> = {
  league: "联赛",
  playoff: "季后赛",
  group: "小组赛",
  elim: "淘汰赛",
};

export type BoardOps = {
  genPreview: () => Promise<void>;
  commitCandidate: (candidate: CandidateDto, segmentIds?: number[]) => Promise<void>;
  applySuggestion: (segmentId: number, label: string) => Promise<void>;
  publishRevision: (rev: RevisionDto) => Promise<void>;
  restoreRevision: (rev: RevisionDto) => Promise<void>;
};

function statusLabel(rev: RevisionDto): string {
  return revisionStatusText(rev.status);
}

/** mockup 1132-1134 的内联锁 SVG（不用 emoji） */
function LockIcon() {
  return (
    <svg className="sb-lock" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="2.2" y="5.2" width="7.6" height="5.2" rx="1" stroke="currentColor" strokeWidth="1.1" />
      <path d="M4 5V3.8a2 2 0 0 1 4 0V5" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

function segLabel(seg: SegmentDto): string {
  return `第 ${seg.week} 周 · 第 ${seg.round} 轮${seg.leg != null ? `（第 ${seg.leg} 回合）` : ""}`;
}

export function BoardView({
  overview,
  lanes,
  violationsBySegment,
  busy,
  ops,
}: {
  overview: OverviewDto;
  lanes: CalLane[];
  violationsBySegment: Map<number, SeasonViolationDto[]>;
  busy: boolean;
  ops: BoardOps;
}) {
  const navigate = useNavigate();
  const weeks = Math.max(1, overview.season.weeks);
  const hardTotal = overview.violations.filter((v) => v.level === "hard").length;
  const [compact, setCompact] = useState(false);
  // 选中态：segId（inspector 内容）+ week（列高亮 / 全季尺选中）。空 = 未选中。
  const [sel, setSel] = useState<{ segId: number | null; week: number | null }>({ segId: null, week: null });
  const [conflictsOpen, setConflictsOpen] = useState(false);

  const segmentsByWeekLane = useMemo(() => {
    // key = `${week}:${tournamentId}`，value = 该赛事该周的段（同周多段按 lane 顺序堆叠）
    const m = new Map<string, SegmentDto[]>();
    for (const seg of overview.segments) {
      const key = `${seg.week}:${seg.tournamentId}`;
      m.set(key, [...(m.get(key) ?? []), seg]);
    }
    for (const list of m.values()) list.sort((a, b) => a.dayStart - b.dayStart || a.id - b.id);
    return m;
  }, [overview]);

  const placementsBySegment = useMemo(() => {
    const m = new Map<number, OverviewDto["placements"][number][]>();
    for (const p of [...overview.placements].sort((a, b) => a.matchId - b.matchId)) {
      m.set(p.segmentId, [...(m.get(p.segmentId) ?? []), p]);
    }
    return m;
  }, [overview]);

  // 键盘导航的段序：lane 优先（同赛事按周升序），方向键在此序列上左右/上下移动
  const orderedSegs = useMemo(() => {
    const list: SegmentDto[] = [];
    for (const lane of lanes) {
      for (let w = 1; w <= weeks; w++) {
        list.push(...(segmentsByWeekLane.get(`${w}:${lane.tournamentId}`) ?? []));
      }
    }
    return list;
  }, [lanes, weeks, segmentsByWeekLane]);

  const selectedSeg = sel.segId != null ? (overview.segments.find((s) => s.id === sel.segId) ?? null) : null;
  const selectedWeek = sel.week;

  // 点 tile 后把它滚进可视区（mockup selectSegment 的 nearest 范式）
  useEffect(() => {
    if (sel.segId == null) return;
    document.querySelector(`.season-board [data-seg="${sel.segId}"]`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [sel.segId]);

  // 键盘（设计稿 §5）：方向键在矩阵内移动选中（左右 = 段序前后，上下 = 同周换赛事 lane），
  // Esc 清掉选中；冲突弹层开着时 Esc 只关弹层。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 弹层/输入框里不接管键盘：否则方向键会同时移动背景矩阵、Esc 会抢输入框的关闭行为。
      const target = e.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === "Escape") {
        if (conflictsOpen) setConflictsOpen(false);
        else setSel({ segId: null, week: null });
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      // 没选中时只允许左右“进入矩阵”；上下没有可移动目标，别 preventDefault 抢页面滚动。
      if (sel.segId == null && (e.key === "ArrowUp" || e.key === "ArrowDown")) return;
      e.preventDefault();
      setSel((prev) => {
        const idx = orderedSegs.findIndex((s) => s.id === prev.segId);
        let next: SegmentDto | null = null;
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          const step = e.key === "ArrowRight" ? 1 : -1;
          const fallback = step > 0 ? 0 : orderedSegs.length - 1;
          next = orderedSegs[idx === -1 ? fallback : Math.min(orderedSegs.length - 1, Math.max(0, idx + step))] ?? null;
        } else {
          const cur = idx >= 0 ? orderedSegs[idx] : null;
          const laneIdx = cur ? lanes.findIndex((l) => l.tournamentId === cur.tournamentId) : -1;
          const target = laneIdx >= 0 ? lanes[laneIdx + (e.key === "ArrowDown" ? 1 : -1)] : null;
          next = target ? ((segmentsByWeekLane.get(`${cur!.week}:${target.tournamentId}`) ?? [])[0] ?? null) : null;
        }
        return next ? { segId: next.id, week: next.week } : prev;
      });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [conflictsOpen, orderedSegs, lanes, segmentsByWeekLane, sel.segId]);

  const scrollToWeekCol = (week: number) => {
    document.getElementById(`sb-wh-${week}`)?.scrollIntoView?.({ block: "nearest", inline: "center" });
  };

  /** 点周头 / 全季尺格：选中该周首个段（按 lane 顺序）并把矩阵列滚到可视中部 */
  const selectWeek = (week: number) => {
    const candidates: SegmentDto[] = [];
    for (const lane of lanes) {
      const list = segmentsByWeekLane.get(`${week}:${lane.tournamentId}`);
      if (list) candidates.push(...list);
    }
    setSel({ segId: candidates[0]?.id ?? null, week });
    scrollToWeekCol(week);
  };

  const selectTile = (seg: SegmentDto) => {
    setSel({ segId: seg.id, week: seg.week });
  };

  const segsOfWeek = (week: number, lane: CalLane) =>
    segmentsByWeekLane.get(`${week}:${lane.tournamentId}`) ?? [];

  return (
    <div className={`season-board${compact ? " compact" : ""}`}>
      {/* —— 全季尺：每格三根密度条（按该周各赛事场次数定高）+ 冲突红线 + 选中淡绿底 —— */}
      <section className="sb-ruler-card" aria-label="全季周导航">
        <div className="sb-ruler-head">
          <strong>全季周导航</strong>
          <span className="sb-hint">点周次直接跳过去；底部红线代表这周有冲突</span>
        </div>
        <div
          className="sb-ruler"
          style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: weeks }, (_, i) => {
            const w = i + 1;
            const hasHard = overview.segments.some((s) => s.week === w && (violationsBySegment.get(s.id) ?? []).some((v) => v.level === "hard"));
            return (
              <button
                key={w}
                type="button"
                className={`sb-ruler-week${selectedWeek === w ? " selected" : ""}${hasHard ? " hard" : ""}`}
                title={`W${w}${hasHard ? " · 有冲突" : ""}`}
                aria-label={`W${w}`}
                onClick={() => selectWeek(w)}
              >
                <span className="sb-ruler-bars">
                  {lanes.map((lane) => {
                    const list = segsOfWeek(w, lane);
                    const count = list.reduce((n, s) => n + s.matchCount, 0);
                    const hard = list.some((s) => (violationsBySegment.get(s.id) ?? []).some((v) => v.level === "hard"));
                    if (list.length === 0) {
                      return <i key={lane.tournamentId} className={`sb-bar tone-${lane.tone} empty`} style={{ height: 2 }} />;
                    }
                    return (
                      <i
                        key={lane.tournamentId}
                        className={`sb-bar tone-${lane.tone}${hard ? " hard" : ""}`}
                        style={{ height: 10 + Math.min(count, 6) * 3 }}
                      />
                    );
                  })}
                </span>
                <span className="sb-ruler-label">{w % 2 === 1 ? `W${w}` : ""}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* —— 矩阵：216px 赛事列 + 31 周；周头 sticky top、赛事列 sticky left、角格 z 最高 —— */}
      <section className="sb-shell">
        <div className="sb-toolbar">
          <strong>各赛事排期</strong>
          <div className="sb-toolbar-actions">
            <div className="sb-legend" aria-label="图例">
              <span>
                <i className="sb-dot locked" />已锁定
              </span>
              <span>
                <i className="sb-dot draft" />草稿
              </span>
              <span>
                <i className="sb-dot soft" />建议调整
              </span>
              <span>
                <i className="sb-dot hard" />时间冲突
              </span>
            </div>
            <button
              type="button"
              className="btn small"
              onClick={() => setCompact((v) => !v)}
              title={compact ? "回到舒适密度" : "切到紧凑密度"}
            >
              {compact ? "舒适" : "紧凑"}
            </button>
          </div>
        </div>
        <div className="sb-scroll">
          <div
            className="sb-board"
            aria-label="各赛事排期矩阵"
            style={{
              gridTemplateColumns: `216px repeat(${weeks}, minmax(${compact ? 48 : 56}px, 1fr))`,
              minWidth: `${216 + (compact ? 48 : 56) * weeks}px`,
            }}
          >
            <div className="sb-corner">赛事 / 轮次</div>
            {Array.from({ length: weeks }, (_, i) => {
              const w = i + 1;
              return (
                <div
                  key={w}
                  id={`sb-wh-${w}`}
                  className={`sb-week-head ph-${phaseOf(w).tone}${selectedWeek === w ? " selected" : ""}${
                    w % 4 === 0 ? " week-block" : ""
                  }`}
                  onClick={() => selectWeek(w)}
                >
                  W{w}
                </div>
              );
            })}
            {lanes.map((lane) => {
              const laneSegs = overview.segments.filter((s) => s.tournamentId === lane.tournamentId);
              const streamText = [...new Set(laneSegs.map((s) => STREAM_LABEL[s.stream] ?? s.stream))].join(" / ");
              return (
                <Fragment key={lane.tournamentId}>
                  <div className={`sb-lane-label tone-${lane.tone}`}>
                    <div className="name">{lane.name}</div>
                    <div className="meta">
                      {laneSegs.length} 轮{streamText ? ` · ${streamText}` : ""}
                    </div>
                    <div className="bar" />
                  </div>
                  {Array.from({ length: weeks }, (_, i) => {
                    const w = i + 1;
                    const list = segsOfWeek(w, lane);
                    const cls =
                      `sb-cell${selectedWeek === w ? " selected-week" : ""}${w % 4 === 0 ? " week-block" : ""}`;
                    if (list.length === 0) {
                      return <div key={w} className={`${cls} empty`} />;
                    }
                    return (
                      <div key={w} className={cls}>
                        {list.map((seg) => {
                          const segViol = violationsBySegment.get(seg.id) ?? [];
                          const hard = segViol.filter((v) => v.level === "hard").length;
                          const soft = segViol.filter((v) => v.level === "soft").length;
                          const report = segViol.filter((v) => v.level === "report").length;
                          const level = hard > 0 ? "hard" : soft > 0 ? "soft" : report > 0 ? "report" : "";
                          const status = segmentStatus(seg, overview.savedSegmentIds);
                          const locked = status === "published";
                          const warn =
                            hard > 0 ? `${hard} 冲突` : soft > 0 ? `${soft} 建议` : report > 0 ? `${report} 提醒` : null;
                          return (
                            <button
                              key={seg.id}
                              type="button"
                              data-seg={seg.id}
                              className={`sb-tile${
                                status === "published" ? " locked" : status === "saved" ? " saved" : " draft"
                              }${level ? ` ${level}` : ""}${seg.id === sel.segId ? " selected" : ""}`}
                              title={`${seg.tournamentName} · W${seg.week} · ${seg.scheduledCount}/${seg.matchCount} 已定`}
                              onClick={() => selectTile(seg)}
                            >
                              {locked && <LockIcon />}
                              <span className="sb-count">
                                {seg.matchCount}
                                <span className="unit">场</span>
                              </span>
                              <span className="sb-meta">
                                {STREAM_LABEL[seg.stream] ?? seg.stream} · {seg.scheduledCount}/{seg.matchCount}
                              </span>
                              {warn && <span className="sb-warn">{warn}</span>}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </Fragment>
              );
            })}
          </div>
        </div>

        {/* —— inspector：矩阵下方 280px + 1fr，不定高 —— */}
        <aside className="sb-inspector" aria-live="polite">
          {!selectedSeg ? (
            <div className="sb-ins-empty">
              <strong>点一个格子看详情</strong>
              这里会显示这一周的场次、时间和冲突。
            </div>
          ) : (
            <BoardInspector
              seg={selectedSeg}
              status={segmentStatus(selectedSeg, overview.savedSegmentIds)}
              violations={violationsBySegment.get(selectedSeg.id) ?? []}
              placements={placementsBySegment.get(selectedSeg.id) ?? []}
              busy={busy}
              onJumpWeek={() => scrollToWeekCol(selectedSeg.week)}
              onOpenKickoff={() =>
                navigate(
                  `/admin/t/${selectedSeg.tournamentId}?tab=kickoff&segment=${selectedSeg.id}&tname=${encodeURIComponent(
                    selectedSeg.tournamentName,
                  )}`,
                )
              }
              onOpenConflicts={() => setConflictsOpen(true)}
            />
          )}
        </aside>
      </section>

      {/* —— 版本轨道：第 N 版 / 状态 / 短 hash / 硬·软计数 / 创建人 + 公布 / 恢复 —— */}
      <section className="sb-revisions" aria-label="版本记录">
        <div className="sb-rev-head">
          <strong>版本记录</strong>
          <span className="sb-hint">每卡可公布或恢复；恢复同样落成新版本</span>
        </div>
        <div className="sb-rev-track">
          {overview.revisions.length === 0 && (
            <p className="sb-hint">还没有版本。在排法弹层里用一套排法、或恢复一次，都会在这里落成新版本。</p>
          )}
          {overview.revisions.map((rev, i) => (
            <div key={rev.id} className={`sb-rev-item${i === 0 ? " current" : ""}`}>
              <span className="sb-rev-top">
                <b>第 {rev.revision} 版</b>
                <span className="sb-rev-status">{statusLabel(rev)}</span>
              </span>
              <span className="sb-rev-hash">{rev.hash.slice(0, 8)}</span>
              <span className="sb-rev-metrics">
                {rev.metrics ? (
                  <>
                    硬 <b>{rev.metrics.hard}</b> · 软 <b>{rev.metrics.soft}</b>
                  </>
                ) : (
                  "—"
                )}
                {rev.createdBy ? ` · ${rev.createdBy}` : ""}
              </span>
              <span className="sb-rev-ops">
                <button
                  type="button"
                  className="btn small"
                  disabled={busy || hardTotal > 0 || rev.assignmentCount === 0}
                  title={
                    hardTotal > 0
                      ? "整季还有必须解决的时间冲突，先处理再公布"
                      : rev.assignmentCount === 0
                        ? "空版本不能公布"
                        : rev.status === "published"
                          ? "已公布版本：解锁后可再次点击补锁"
                          : undefined
                  }
                  onClick={() => void ops.publishRevision(rev)}
                >
                  {rev.status === "published" ? "补锁" : "公布"}
                </button>
                <button type="button" className="btn small ghost" disabled={busy} onClick={() => void ops.restoreRevision(rev)}>
                  恢复
                </button>
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* —— 全部冲突弹层：按周定位 + reason + 必须解决/建议调整带「应用建议」 —— */}
      {conflictsOpen && (
        <div
          className="season-modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConflictsOpen(false);
          }}
        >
          <div className="season-sheet" role="dialog" aria-modal="true" aria-label="全季时间冲突">
            <div className="season-sheet-head">
              <div>
                <h2>全季时间冲突 · {overview.violations.length} 处</h2>
                <p>按周列出问题场次；必须解决 / 建议调整可以让引擎只重排那一段。</p>
              </div>
              <button type="button" className="season-close" aria-label="关闭" onClick={() => setConflictsOpen(false)}>
                ×
              </button>
            </div>
            <div className="season-sheet-body">
              <div className="sb-conflict-list">
                {overview.violations.map((v, i) => {
                  const seg = v.segmentId != null ? overview.segments.find((s) => s.id === v.segmentId) : null;
                  const canFix = seg != null && v.level !== "report" && seg.lockedAt == null;
                  return (
                    <div key={`${v.matchId}-${i}`} className={`sb-conflict-row ${v.level}`}>
                      <span className="week">{seg ? `第 ${seg.week} 周` : "未挂段"}</span>
                      <div>
                        <div className="match">
                          {v.matchId > 0 ? `#${v.matchId}` : "池容量"}
                          <span className="why"> · {v.reason}</span>
                        </div>
                      </div>
                      <div className="fix">
                        {canFix && seg && (
                          <button
                            type="button"
                            className="btn small"
                            disabled={busy}
                            onClick={() => void ops.applySuggestion(seg.id, segLabel(seg))}
                          >
                            应用建议
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
                {overview.violations.length === 0 && <p className="sb-hint">这一季目前没有时间冲突。</p>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type Placement = OverviewDto["placements"][number];

/** inspector：左列 badge + serif 标题 + 三格 stat + 冲突 + 动作 + 内部编号；右列场次表（同赛历视图字段口径） */
function BoardInspector({
  seg,
  status,
  violations,
  placements,
  busy,
  onJumpWeek,
  onOpenKickoff,
  onOpenConflicts,
}: {
  seg: SegmentDto;
  status: SegmentStatus;
  violations: SeasonViolationDto[];
  placements: Placement[];
  busy: boolean;
  onJumpWeek: () => void;
  onOpenKickoff: () => void;
  onOpenConflicts: () => void;
}) {
  const hard = violations.filter((v) => v.level === "hard");
  const soft = violations.filter((v) => v.level === "soft");
  const report = violations.filter((v) => v.level === "report");
  const statusText = status === "published" ? "已公布" : status === "saved" ? "已保存" : "草稿";
  const unscheduled = seg.matchCount - seg.scheduledCount;
  const conflictTitle =
    hard.length > 0
      ? `必须解决的时间冲突 ${hard.length} 处`
      : soft.length > 0
        ? `建议调整 ${soft.length} 处`
        : report.length > 0
          ? `提醒 ${report.length} 条`
          : "";
  const conflictClass = hard.length > 0 ? "hard" : soft.length > 0 ? "soft" : "report";
  return (
    <div className="sb-ins-layout">
      <div className="sb-ins-main">
        <div className="sb-ins-head">
          <div className="sb-eyebrow">
            <span className="sb-badge">
              {seg.tournamentName} · {STREAM_LABEL[seg.stream] ?? seg.stream}
            </span>
            <span className={`sb-badge${status === "draft" ? " hard" : ""}`}>{statusText}</span>
          </div>
          <h2>来自{segLabel(seg)}</h2>
          <div className="sb-ins-sub">{dayRangeText(seg)} · 开球档位只是虚拟时间标签，不会换算成真实日期</div>
        </div>
        <div className="sb-ins-stats">
          <div className="sb-ins-stat">
            <b>{seg.matchCount}</b>
            <span>场次</span>
          </div>
          <div className="sb-ins-stat">
            <b>{seg.scheduledCount}</b>
            <span>已定</span>
          </div>
          <div className="sb-ins-stat">
            <b>{unscheduled}</b>
            <span>没排时间</span>
          </div>
        </div>
        {conflictTitle && (
          <div className="sb-ins-section">
            <div className="sb-sec-head">
              <h3>{conflictTitle}</h3>
            </div>
            <div className={`sb-conflict-box ${conflictClass}`}>
              {hard.length > 0 ? (
                hard.map((v, i) => (
                  <p key={`${v.matchId}-${i}`}>
                    <strong>{v.matchId > 0 ? `#${v.matchId}` : "池容量"}</strong>
                    <br />
                    <span className="why">{v.reason}</span>
                  </p>
                ))
              ) : (
                <p>
                  <span className="why">这些不挡保存；保存前看一眼各队间隔就行。</span>
                </p>
              )}
            </div>
          </div>
        )}
        <div className="sb-ins-actions">
          <button type="button" className="btn small" onClick={onJumpWeek}>
            看这一周
          </button>
          {/* 跨赛事下钻：段属赛事一起带回（High-1），KickoffTab 按 drill.tournamentId 拉窗口 */}
          <button type="button" className="btn small ghost" onClick={onOpenKickoff}>
            打开开球时刻
          </button>
        </div>
        <div className="sb-ins-foot">
          内部编号 #{seg.id} · {status === "published" ? "已锁定" : "可调整"}
        </div>
      </div>
      <div className="sb-ins-table">
        <div className="sb-ins-section">
          <div className="sb-sec-head">
            <h3>这一轮的场次</h3>
            <button type="button" className="sb-link-btn" onClick={onOpenConflicts}>
              看全部冲突
            </button>
          </div>
          <table className="sb-match-table">
            <thead>
              <tr>
                <th>场次</th>
                <th>开球档位</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {placements.length === 0 ? (
                <tr>
                  <td colSpan={3} className="sb-muted">
                    这个轮次安排还没有已定的开球档位。
                  </td>
                </tr>
              ) : (
                placements.map((p) => (
                  <tr key={p.matchId}>
                    <td className="time">#{p.matchId}</td>
                    <td className="time">{kickoffText(p.week, p.day, p.time) ?? "—"}</td>
                    <td>
                      {p.override ? <span className="sb-tag hard">改期</span> : <span className="sb-tag ok">已定</span>}
                      {p.reason ? <span className="sb-why">{p.reason}</span> : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {busy && <p className="sb-muted">操作进行中…</p>}
        </div>
      </div>
    </div>
  );
}

// —— 三套排法弹层（页面级：preview 数据在 useSeasonSchedule 里） ——

export function ProposalSheet({
  preview,
  mode,
  busy,
  onCommit,
  onClose,
}: {
  preview: PreviewDto;
  mode: "preview" | "save";
  busy: boolean;
  onCommit: (candidate: CandidateDto, segmentIds?: number[]) => Promise<void>;
  onClose: () => void;
}) {
  const best = pickBest(preview.candidates);
  return (
    <div
      className="season-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="season-sheet" role="dialog" aria-modal="true" aria-label="全季排法预览">
        <div className="season-sheet-head">
          <div>
            <h2>{mode === "save" ? "保存为新版本 · 选一套排法" : "全季预览 · 三套排法"}</h2>
            <p>
              求解范围 {preview.segmentIds.length}/{preview.totalSegments} 段 · 已锁定上下文 {preview.fixed.length} 场
              {preview.unplacedMatchIds.length > 0 ? ` · 未排上 ${preview.unplacedMatchIds.length} 场` : ""}
              {preview.blockedSegmentIds.length > 0 ? ` · 缺时刻池段 ${preview.blockedSegmentIds.length} 个` : ""}
              ；同样条件下每次排出来的结果一致。
            </p>
          </div>
          <button type="button" className="season-close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="season-sheet-body">
          <div className="sb-proposals">
            {preview.candidates.map((cand) => {
              const recommended = best?.key === cand.key;
              const blocked =
                cand.metrics.hard > 0
                  ? "有必须解决的时间冲突，提交会被拒（409）"
                  : cand.unplacedMatchIds.length > 0
                    ? `排法 ${cand.key} 还有 ${cand.unplacedMatchIds.length} 场没落档，先补齐`
                    : preview.blockedSegmentIds.length > 0
                      ? "还有段缺时刻池，先补池子"
                      : undefined;
              return (
                <article key={cand.key} className={`sb-proposal${recommended ? " recommended" : ""}`}>
                  <div className="sb-proposal-top">
                    <strong>排法 {cand.key}</strong>
                    {recommended && <span className="sb-proposal-tag">综合最优</span>}
                  </div>
                  <div className="sb-proposal-grid">
                    <div>
                      <span>必须解决</span>
                      <b style={cand.metrics.hard > 0 ? { color: "var(--hard)" } : undefined}>{cand.metrics.hard}</b>
                    </div>
                    <div>
                      <span>建议调整</span>
                      <b style={cand.metrics.soft > 0 ? { color: "var(--soft)" } : undefined}>{cand.metrics.soft}</b>
                    </div>
                    <div>
                      <span>没排时间</span>
                      <b>{cand.unplacedMatchIds.length}</b>
                    </div>
                    <div>
                      <span>最小间隔</span>
                      <b>{cand.metrics.minGapHours == null ? "—" : `${cand.metrics.minGapHours.toFixed(1)}h`}</b>
                    </div>
                    <div>
                      <span>晚场占比</span>
                      <b>{(cand.metrics.lateRatio * 100).toFixed(0)}%</b>
                    </div>
                    <div>
                      <span>最大连续负荷</span>
                      <b>{cand.metrics.maxConsecutiveLoad}</b>
                    </div>
                  </div>
                  <ul className="sb-proposal-note">
                    <li>
                      seed {cand.seed} · {cand.steps} 步
                    </li>
                    {cand.unplacedMatchIds.length > 0 && <li>还有 {cand.unplacedMatchIds.length} 场没落档</li>}
                    {cand.metrics.hard > 0 && <li>先处理必须解决的时间冲突</li>}
                  </ul>
                  <button
                    type="button"
                    className={`btn${recommended ? " primary" : ""}`}
                    disabled={busy || blocked != null}
                    title={blocked}
                    onClick={() => void onCommit(cand)}
                  >
                    用这套
                  </button>
                </article>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
