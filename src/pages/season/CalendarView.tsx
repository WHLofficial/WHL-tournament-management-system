// 赛历视图（默认工作台，design-season-scheduler-ui.md §10 / mockup season-calendar.html v2 稿）：
// 4 周一行 × 8 行的周卡墙（31 周）+ 阶段条 + 31 格周导航 + inline 详情。
// - 周卡 = week-rail（阶段起始周带 phase-tag，mono W#）+ D1–D7 表头 + 7 列 × N 条 lane；
// - lane 动态生成：杯赛类占第一 lane，顶级/次级随后，映射不到的赛事按 tournamentId 顺序落 lane，
//   不留空 lane（见 buildLanes）；
// - cal-block 跨日（dayStart..dayEnd），赛事色四组，flag 显示必须解决/建议调整/提醒计数；
// - 点块 → 该 4 周行正下方展开 inline 详情（grid-column 1/-1，不定高、不内部滚动），再点收起。
// 数据来自 useSeasonSchedule 的总览（OverviewDto）；开球档位是虚拟时刻，不换算真实日期。
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { OverviewDto, SeasonViolationDto, SegmentDto, SegmentStatus } from "./data";
import { segmentStatus, tournamentRows } from "./data";
import { kickoffText, weekdayCn } from "../../lib/kickoff";

const STREAM_LABEL: Record<string, string> = {
  league: "联赛",
  playoff: "季后赛",
  group: "小组赛",
  elim: "淘汰赛",
};

// 赛季阶段区间：目前是设计稿常量（season-calendar.html:808-814）。
// TODO 数据源就绪后改为按 season_week 的 phase 配置生成，不再写死。
// TODO 转会窗整周色带、超级杯/决赛单独标记：tour 当前没有转会表，也没有超级杯赛事；
// 等数据源落地后再画，不能先靠前端编造日期/赛事。
export const PHASES = [
  { from: 1, to: 7, name: "夏季", tone: "summer" },
  { from: 8, to: 12, name: "秋季", tone: "autumn" },
  { from: 13, to: 18, name: "冬季", tone: "winter" },
  { from: 19, to: 23, name: "春季", tone: "spring" },
  { from: 24, to: 31, name: "夏季", tone: "summer" },
] as const;

export function phaseOf(week: number): (typeof PHASES)[number] {
  return PHASES.find((p) => week >= p.from && week <= p.to) ?? PHASES[PHASES.length - 1];
}

/** 周卡墙每行 4 周（calendar_chart.py 的 weeks_per_row=4） */
const WEEKS_PER_ROW = 4;

/**
 * lane 行高：<768px 时触控目标 ≥44px（设计稿 §6），周卡格内块与行一起加高。
 * matchMedia 在 jsdom（测试环境）里不存在，直接按桌面档处理。
 */
function useLaneHeight(): number {
  const [compact, setCompact] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(max-width: 768px)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(max-width: 768px)");
    const onChange = () => setCompact(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return compact ? 44 : 22;
}

export type CalLane = {
  tournamentId: number;
  name: string;
  /** 赛事色组：cup/事件色、top、sub；映射不到三赛事时按 event 色 + tournamentId 顺序落 lane */
  tone: "top" | "sub" | "cup" | "event";
};

/**
 * lane 按数据里的赛事聚合动态生成（mockup laneOf：杯赛/赛事事件 lane1、顶级 lane2、次级 lane3）：
 * 杯赛类（competition=cup）占第一 lane，其次顶级、次级；competition 映射不到三赛事的赛事
 * 按 tournamentId 顺序追加在后面，空档不保留（lane 序号 = 数组下标 + 1）。
 */
export function buildLanes(overview: OverviewDto | null): CalLane[] {
  const cups: CalLane[] = [];
  const tops: CalLane[] = [];
  const subs: CalLane[] = [];
  const rest: CalLane[] = [];
  for (const row of tournamentRows(overview)) {
    const comp = row.segs[0]?.competition ?? "";
    const lane: CalLane = {
      tournamentId: row.tournamentId,
      name: row.name,
      tone: comp === "cup" ? "cup" : comp === "sub" ? "sub" : comp === "top" ? "top" : "event",
    };
    if (comp === "cup") cups.push(lane);
    else if (comp === "top") tops.push(lane);
    else if (comp === "sub") subs.push(lane);
    else rest.push(lane);
  }
  return [...cups, ...tops, ...subs, ...rest];
}

/** 段上的体检计数（必须解决/建议调整/提醒），flag 取优先级最高的一个数字 */
function flagOf(segViolations: SeasonViolationDto[]): { level: "hard" | "soft" | "report"; n: number } | null {
  const count = (level: SeasonViolationDto["level"]) =>
    segViolations.filter((v) => v.level === level).length;
  const hard = count("hard");
  const soft = count("soft");
  const report = count("report");
  if (hard > 0) return { level: "hard", n: hard };
  if (soft > 0) return { level: "soft", n: soft };
  if (report > 0) return { level: "report", n: report };
  return null;
}

/** 赛事名短名：「S9 | 顶级联赛」→「顶级联赛」；不带 | 的原样返回 */
function shortName(tournamentName: string): string {
  return tournamentName.includes("|") ? (tournamentName.split("|").pop() ?? "").trim() : tournamentName;
}

/** 单日格放不下全称：取 label 最后一段做短名（mockup 996-1000 规则） */
function blockLabel(seg: SegmentDto): string {
  const full = `${shortName(seg.tournamentName)} 第 ${seg.round} 轮`;
  return seg.dayStart === seg.dayEnd && full.includes(" ") ? (full.split(" ").pop() ?? full) : full;
}

export function dayRangeText(seg: SegmentDto): string {
  return seg.dayStart === seg.dayEnd
    ? `周${weekdayCn(seg.dayStart)}`
    : `周${weekdayCn(seg.dayStart)}–周${weekdayCn(seg.dayEnd)}`;
}

export function CalendarView({
  overview,
  lanes,
  violationsBySegment,
  selectedSegmentId,
  onSelectSegment,
}: {
  overview: OverviewDto;
  lanes: CalLane[];
  violationsBySegment: Map<number, SeasonViolationDto[]>;
  selectedSegmentId: number | null;
  onSelectSegment: (id: number | null) => void;
}) {
  const navigate = useNavigate();
  const weeks = Math.max(1, overview.season.weeks);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const laneH = useLaneHeight();

  const segmentsByWeek = useMemo(() => {
    const m = new Map<number, SegmentDto[]>();
    for (const seg of overview.segments) {
      m.set(seg.week, [...(m.get(seg.week) ?? []), seg]);
    }
    return m;
  }, [overview]);

  const laneIndexOf = useMemo(() => {
    const m = new Map<number, number>();
    lanes.forEach((lane, i) => m.set(lane.tournamentId, i + 1));
    return m;
  }, [lanes]);

  const placementsBySegment = useMemo(() => {
    const m = new Map<number, OverviewDto["placements"][number][]>();
    for (const p of [...overview.placements].sort((a, b) => a.matchId - b.matchId)) {
      m.set(p.segmentId, [...(m.get(p.segmentId) ?? []), p]);
    }
    return m;
  }, [overview]);

  const selectedSeg =
    selectedSegmentId != null ? (overview.segments.find((s) => s.id === selectedSegmentId) ?? null) : null;

  // 点块后把 inline 详情滚进视口（mockup selectEvent 的 requestAnimationFrame 范式）
  useEffect(() => {
    if (selectedSegmentId == null) return;
    const raf = requestAnimationFrame(() => {
      detailRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedSegmentId]);

  // Esc 清掉选中（设计稿 §5：Esc 清除选中）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedSegmentId != null) onSelectSegment(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedSegmentId, onSelectSegment]);

  const scrollToWeek = (week: number) => {
    document.getElementById(`cal-week-${week}`)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };

  const rowCount = Math.ceil(weeks / WEEKS_PER_ROW);
  const rows: Array<{ start: number; end: number }> = [];
  for (let r = 0; r < rowCount; r++) {
    rows.push({
      start: r * WEEKS_PER_ROW + 1,
      end: Math.min((r + 1) * WEEKS_PER_ROW, weeks),
    });
  }

  return (
    <div className="cal-view">
      {/* —— 阶段条：五段按周数 flex 伸缩，点击滚到阶段首周 —— */}
      <div className="cal-phase-strip" aria-label="赛季阶段">
        {PHASES.filter((p) => p.from <= weeks).map((p) => {
          const to = Math.min(p.to, weeks);
          return (
            <button
              key={`${p.from}-${p.to}`}
              type="button"
              className={`tone-${p.tone}`}
              style={{ flex: to - p.from + 1 }}
              data-week={p.from}
              onClick={() => scrollToWeek(p.from)}
            >
              <strong>{p.name}</strong>
              <small>
                W{p.from}–W{to}
              </small>
            </button>
          );
        })}
      </div>

      {/* —— 31 格周导航：mono 周号 + 阶段色底线，选中周高亮 —— */}
      <div className="cal-week-nav-scroll">
        <div
          className="cal-week-nav"
          aria-label={`${weeks} 周导航`}
          style={{ gridTemplateColumns: `repeat(${weeks}, minmax(30px, 1fr))` }}
        >
          {Array.from({ length: weeks }, (_, i) => {
            const w = i + 1;
            return (
              <button
                key={w}
                type="button"
                className={`tone-${phaseOf(w).tone}${selectedSeg?.week === w ? " selected" : ""}`}
                title={`跳到第 ${w} 周`}
                onClick={() => scrollToWeek(w)}
              >
                W{w}
              </button>
            );
          })}
        </div>
      </div>

      {/* —— 周卡墙：4 周一行；选中段的详情插在所在 4 周行正下方 —— */}
      <div className="cal-wrap" aria-label="赛季赛历">
        <div className="cal-calendar">
          {rows.map(({ start, end }) => (
            <Fragment key={start}>
              {Array.from({ length: end - start + 1 }, (_, i) => {
                const week = start + i;
                const phase = phaseOf(week);
                const weekSegs = [...(segmentsByWeek.get(week) ?? [])].sort(
                  (a, b) =>
                    (laneIndexOf.get(a.tournamentId) ?? 99) - (laneIndexOf.get(b.tournamentId) ?? 99) ||
                    a.dayStart - b.dayStart ||
                    a.id - b.id,
                );
                const hasSelected = weekSegs.some((s) => s.id === selectedSegmentId);
                return (
                  <section
                    key={week}
                    id={`cal-week-${week}`}
                    className={`cal-week tone-${phase.tone}${hasSelected ? " selected" : ""}${
                      week % WEEKS_PER_ROW === 0 || week === weeks ? " row-end" : ""
                    }`}
                  >
                    <div className="cal-week-rail">
                      {week === phase.from && <span className="cal-phase-tag">{phase.name}</span>}
                      <strong>W{week}</strong>
                      <small>第 {week} 周</small>
                    </div>
                    <div className="cal-week-main">
                      <div className="cal-week-days">
                        {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                          <span key={d}>D{d}</span>
                        ))}
                      </div>
                      <div
                        className="cal-week-grid"
                        style={{ gridTemplateRows: `repeat(${Math.max(lanes.length, 1)}, ${laneH}px)` }}
                      >
                        {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                          <i key={d} className="cal-day-cell" style={{ gridColumn: d }} aria-hidden="true" />
                        ))}
                        {weekSegs.map((seg) => {
                          const segViol = violationsBySegment.get(seg.id) ?? [];
                          const flag = flagOf(segViol);
                          const lane = laneIndexOf.get(seg.tournamentId) ?? lanes.length + 1;
                          const state = segmentStatus(seg, overview.savedSegmentIds);
                          const tip =
                            `${seg.tournamentName} · ${STREAM_LABEL[seg.stream] ?? seg.stream}第 ${seg.round} 轮` +
                            `${seg.leg != null ? `（第 ${seg.leg} 回合）` : ""} · 第 ${seg.week} 周 · ${dayRangeText(seg)}` +
                            ` · ${seg.scheduledCount}/${seg.matchCount} 场` +
                            (segViol.some((v) => v.level === "hard")
                              ? ` · ${segViol.filter((v) => v.level === "hard").length} 处必须解决`
                              : "") +
                            (segViol.some((v) => v.level === "soft")
                              ? ` · ${segViol.filter((v) => v.level === "soft").length} 处建议调整`
                              : "") +
                            (segViol.some((v) => v.level === "report")
                              ? ` · ${segViol.filter((v) => v.level === "report").length} 条提醒`
                              : "");
                          return (
                            <button
                              key={seg.id}
                              type="button"
                              className={`cal-block ${lanes.find((l) => l.tournamentId === seg.tournamentId)?.tone ?? "event"}` +
                                `${seg.id === selectedSegmentId ? " selected" : ""}` +
                                `${state === "published" ? " is-locked" : state === "saved" ? " is-saved" : " is-draft"}`}
                              title={tip}
                              aria-expanded={seg.id === selectedSegmentId}
                              style={{ gridColumn: `${seg.dayStart} / ${seg.dayEnd + 1}`, gridRow: lane }}
                              onClick={() => onSelectSegment(seg.id === selectedSegmentId ? null : seg.id)}
                            >
                              <span className="cal-label">{blockLabel(seg)}</span>
                              {flag && <span className={`cal-flag ${flag.level}`}>{flag.n}</span>}
                              <span className="cal-meta">
                                {seg.scheduledCount}/{seg.matchCount}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </section>
                );
              })}
              {selectedSeg && selectedSeg.week >= start && selectedSeg.week <= end && (
                <CalendarDetail
                  ref={detailRef}
                  seg={selectedSeg}
                  status={segmentStatus(selectedSeg, overview.savedSegmentIds)}
                  violations={violationsBySegment.get(selectedSeg.id) ?? []}
                  placements={placementsBySegment.get(selectedSeg.id) ?? []}
                  onClose={() => onSelectSegment(null)}
                  onJumpWeek={() => scrollToWeek(selectedSeg.week)}
                  onOpenKickoff={() =>
                    navigate(
                      `/admin/t/${selectedSeg.tournamentId}?tab=kickoff&segment=${selectedSeg.id}&tname=${encodeURIComponent(
                        selectedSeg.tournamentName,
                      )}`,
                    )
                  }
                />
              )}
            </Fragment>
          ))}
        </div>
      </div>

      {/* —— 图例：四季色 + 四赛事色 + 线型/数字含义 —— */}
      <div className="cal-legend">
        <span className="cal-item">
          <i className="cal-chip phase-summer" />夏季
        </span>
        <span className="cal-item">
          <i className="cal-chip phase-autumn" />秋季
        </span>
        <span className="cal-item">
          <i className="cal-chip phase-winter" />冬季
        </span>
        <span className="cal-item">
          <i className="cal-chip phase-spring" />春季
        </span>
        <span className="cal-item">
          <i className="cal-chip top" />顶级联赛
        </span>
        <span className="cal-item">
          <i className="cal-chip sub" />次级联赛
        </span>
        <span className="cal-item">
          <i className="cal-chip cup" />冠军杯
        </span>
        <span className="cal-item">
          <i className="cal-chip event" />赛事事件
        </span>
        <span>实线：已公布或已保存 · 虚线：草稿 · 数字：必须解决 / 建议调整</span>
      </div>
    </div>
  );
}

type Placement = OverviewDto["placements"][number];

/** inline 详情：插在选中段所在 4 周行的正下方（grid-column 1/-1），不定高、不内部滚动 */
function CalendarDetail({
  seg,
  status,
  violations,
  placements,
  onClose,
  onJumpWeek,
  onOpenKickoff,
  ref,
}: {
  seg: SegmentDto;
  status: SegmentStatus;
  violations: SeasonViolationDto[];
  placements: Placement[];
  onClose: () => void;
  onJumpWeek: () => void;
  onOpenKickoff: () => void;
  ref?: React.Ref<HTMLDivElement>;
}) {
  const hard = violations.filter((v) => v.level === "hard");
  const soft = violations.filter((v) => v.level === "soft");
  const report = violations.filter((v) => v.level === "report");
  const statusText = status === "published" ? "已公布" : status === "saved" ? "已保存" : "草稿";
  const unscheduled = seg.matchCount - seg.scheduledCount;
  const groups = (
    [
      { level: "hard", title: `必须解决的时间冲突 ${hard.length} 处`, items: hard },
      { level: "soft", title: `建议调整 ${soft.length} 处`, items: soft },
      { level: "report", title: `提醒 ${report.length} 条`, items: report },
    ] as Array<{ level: SeasonViolationDto["level"]; title: string; items: SeasonViolationDto[] }>
  ).filter((g) => g.items.length > 0);

  return (
    <article ref={ref} className="cal-detail-row">
      <div className="cal-detail-inner">
        <div className="cal-detail-head">
          <div>
            <div className="cal-eyebrow">
              <span className="cal-badge">
                {seg.tournamentName} · {STREAM_LABEL[seg.stream] ?? seg.stream}
              </span>
              <span className={`cal-badge${status === "draft" ? " hard" : ""}`}>{statusText}</span>
            </div>
            <h2>
              第 {seg.week} 周 · 第 {seg.round} 轮{seg.leg != null ? `（第 ${seg.leg} 回合）` : ""}
            </h2>
            <div className="cal-sub">{dayRangeText(seg)} · 开球档位是虚拟时间，不换算真实日期</div>
          </div>
          <button className="btn ghost" type="button" onClick={onClose}>
            收起
          </button>
        </div>

        <div className="cal-detail-stats">
          <div className="cal-stat">
            <b>{seg.matchCount}</b>
            <span>场次</span>
          </div>
          <div className="cal-stat">
            <b>{seg.scheduledCount}</b>
            <span>已定</span>
          </div>
          <div className="cal-stat">
            <b>{unscheduled}</b>
            <span>没排时间</span>
          </div>
          <div className="cal-stat">
            <b>{violations.length}</b>
            <span>要看的冲突</span>
          </div>
        </div>

        <table className="cal-match-table">
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
                <td colSpan={3} className="cal-status">
                  这个轮次安排还没有已定的开球档位。
                </td>
              </tr>
            ) : (
              placements.map((p) => (
                <tr key={p.matchId}>
                  <td className="cal-time">#{p.matchId}</td>
                  <td className="cal-time">{kickoffText(p.week, p.day, p.time) ?? "—"}</td>
                  <td className="cal-status">
                    {p.override ? <span className="cal-tag pending">改期</span> : <span className="cal-tag ok">已定</span>}
                    {p.reason ? <span className="cal-why">{p.reason}</span> : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {groups.map((g) => (
          <div key={g.level} className={`cal-conflict ${g.level}`}>
            <h3>{g.title}</h3>
            {g.items.map((v, i) => (
              <p key={`${v.matchId}-${i}`}>
                {v.matchId > 0 ? `#${v.matchId} ` : ""}
                {v.reason}
              </p>
            ))}
          </div>
        ))}

        <div className="cal-detail-actions">
          <button className="btn" type="button" onClick={onJumpWeek}>
            看这一周
          </button>
          {/* 跨赛事下钻：段属赛事一起带回（High-1），KickoffTab 按 drill.tournamentId 拉窗口 */}
          <button className="btn ghost" type="button" onClick={onOpenKickoff}>
            打开开球时刻
          </button>
        </div>
      </div>
    </article>
  );
}
