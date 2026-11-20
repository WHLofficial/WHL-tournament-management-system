// 排期页（P3-B 起家；S4 起定位为单段下钻页）：按窗口生成提案 → 提交 → 公布；单场可越窗改期（留 override 标记）。
// 时刻是虚拟标签（周/天/HH:MM），周几只做显示，不换算真实日期。
// S4：赛季总览页（ScheduleSeasonTab）点矩阵格跳进来 —— drill.segmentId 就是 round_window.id，
// 窗口 = 排期段是同一张表。矩阵含全赛季所有赛事的段：跨赛事段要跟着 drill.tournamentId
// 把窗口清单/下钻请求切到段属赛事（High-1），否则永远 404「窗口不存在」。
// 不传 drill 时保持旧行为（当前赛事、自己挑窗口）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { TournamentDetailDTO } from "../../shared/types";
import { weekdayCn } from "../lib/kickoff";

type WindowDto = {
  id: number;
  stream: string;
  round: number;
  leg: number | null;
  week: number;
  dayStart: number;
  dayEnd: number;
  lockedAt: string | null;
  matchCount: number;
  scheduledCount: number;
  playableCount: number;
  hasOverride: boolean;
};

type RowDto = {
  matchId: number;
  slot: number;
  homeName: string | null;
  awayName: string | null;
  status: string;
  scoreHome: number | null;
  scoreAway: number | null;
  week: number | null;
  day: number | null;
  time: string | null;
  override: boolean;
  playable: boolean;
};

/** 整季体检违规（后端 SeasonViolation）：level 多一档 report；matchId=0 是段容量类 */
type SeasonIssue = {
  matchId: number;
  level: "hard" | "soft" | "report";
  reason: string;
  teamId?: number;
  segmentId?: number | null;
  relatedMatchId?: number;
};

type ScheduleResp = {
  window: {
    id: number;
    stream: string;
    round: number;
    leg: number | null;
    week: number;
    dayStart: number;
    dayEnd: number;
    overridden: boolean;
    simultaneous: boolean;
    lockedAt: string | null;
  };
  matches: RowDto[];
  violations: SeasonIssue[];
  blocked: string | null;
};

type PreviewResp = {
  proposalHash: string;
  matches: RowDto[];
  conflicts: SeasonIssue[];
  /** 整季体检里与本段相关的违规（S3）：canCommit 由它的 hard 决定，Medium-3 前端接住展示 */
  seasonViolations: SeasonIssue[];
  canCommit: boolean;
  /** 可排但没落档的场次；非空 = 半排窗口，不能提交 */
  unplaced: number[];
  unscheduled: number[];
};

const STREAM_LABEL: Record<string, string> = {
  league: "联赛",
  playoff: "季后赛",
  group: "小组赛",
  elim: "淘汰赛",
};

function windowLabel(w: WindowDto): string {
  const leg = w.leg == null ? "" : ` · 第${w.leg}回合`;
  return `第 ${w.week} 周 · ${STREAM_LABEL[w.stream] ?? w.stream} 第${w.round}轮${leg}（${w.matchCount} 场）`;
}

function dayRangeText(dayStart: number, dayEnd: number): string {
  if (dayStart === dayEnd) return `周${weekdayCn(dayStart)}`;
  return `周${weekdayCn(dayStart)}–周${weekdayCn(dayEnd)}`;
}

export default function KickoffTab({
  detail,
  reload,
  drill,
}: {
  detail: TournamentDetailDTO;
  reload: () => void;
  /**
   * S4：从赛季总览下钻进来的目标段。矩阵是全赛季的，段可能属于别的赛事——
   * 不传 = 沿旧行为（当前赛事、自己挑窗口）。
   */
  drill?: { segmentId: number; tournamentId: number; tournamentName: string } | null;
}) {
  // High-1：下钻段属别的赛事时，窗口清单 / 下钻 / 提交全部切到段属赛事
  const tid = drill?.tournamentId ?? detail.tournament.id;
  const [windows, setWindows] = useState<WindowDto[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [view, setView] = useState<ScheduleResp | null>(null);
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);

  const loadWindows = useCallback(async () => {
    const body = await api<{ windows: WindowDto[] }>(`/api/admin/tournaments/${tid}/windows`);
    setWindows(body.windows);
    // High-1 残留：窗口清单换到另一个赛事时，旧 selected 很可能不在新清单里
    // （跨赛事下钻 / 切赛事都会走到这里）。不能沿用不存在的 id，否则下钻/预览直接 404。
    if (drill?.segmentId != null && !body.windows.some((w) => w.id === drill.segmentId)) {
      setMsg("下钻的排期段已不存在（可能赛历被重建），已回到当前赛事默认窗口");
    }
    setSelected((cur) => {
      if (cur != null && body.windows.some((w) => w.id === cur)) return cur;
      const drillTarget = drill?.segmentId;
      if (drillTarget != null && body.windows.some((w) => w.id === drillTarget)) return drillTarget;
      return body.windows.find((w) => w.matchCount > 0)?.id ?? null;
    });
  }, [tid, drill?.segmentId]);

  // 请求归属校验：快速切窗口时，慢响应不能把上一个窗口的场次写进新窗口。
  const viewReq = useRef(0);
  // 旧 render 的 onDone 会在切窗口后继续调旧闭包里的 loadView；序号只能保证“最后请求胜出”，
  // 不能保证“最后请求属于当前 selected”。用同步 ref 再比一次当前窗口。
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selected;
  const loadView = useCallback(async () => {
    if (selected == null) return false;
    const wanted = selected;
    const req = ++viewReq.current;
    try {
      const next = await api<ScheduleResp>(
        `/api/admin/tournaments/${tid}/windows/${selected}/schedule`
      );
      if (req !== viewReq.current || selectedRef.current !== wanted) return false;
      setView(next);
      return true;
    } catch (e) {
      if (req === viewReq.current && selectedRef.current === wanted) {
        setMsg(e instanceof Error ? e.message : "加载排期失败");
      }
      return false;
    }
  }, [tid, selected]);

  useEffect(() => {
    void loadWindows().catch((e) => setMsg(e instanceof Error ? e.message : "加载窗口失败"));
  }, [loadWindows]);

  useEffect(() => {
    setView(null);
    setPreview(null);
    setEditing(null);
    void loadView();
  }, [loadView]);

  const act = async (fn: () => Promise<string | null>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setMsg(null);
    try {
      const note = await fn();
      if (note) setMsg(note);
      await Promise.all([loadWindows(), loadView()]);
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const genPreview = () =>
    act(async () => {
      if (selected == null) return null;
      const p = await api<PreviewResp>(
        `/api/admin/tournaments/${tid}/windows/${selected}/schedule/preview`,
        { method: "POST" }
      );
      setPreview(p);
      const seasonViolations = p.seasonViolations ?? [];
      const seasonHard = seasonViolations.filter((v) => v.level === "hard").length;
      return `已生成提案：${p.matches.filter((m) => m.time).length} 场，${
        p.conflicts.filter((c) => c.level === "hard").length
      } 条硬冲突、${p.conflicts.filter((c) => c.level === "soft").length} 条软冲突${
        seasonViolations.length > 0
          ? `；整季体检 ${p.seasonViolations.length} 条（硬 ${seasonHard}）`
          : ""
      }`;
    });

  const commit = () =>
    act(async () => {
      if (selected == null || !preview) return null;
      if ((preview.unplaced ?? []).length > 0) {
        setMsg(`还有 ${preview.unplaced.length} 场可排场次没落档，先调整窗口/池子再提交`);
        return null;
      }
      // 整季硬冲突的放行通道（Medium-2 / Medium-5）：窗口本身解不开时写理由提交，
      // 后端 canCommit=false 才强制要理由，理由进审计和版本流。
      let reason: string | undefined;
      const seasonHard = (preview.seasonViolations ?? []).filter((v) => v.level === "hard").length;
      if (!preview.canCommit) {
        const input = window.prompt(
          `整季体检有 ${seasonHard} 条硬冲突（见下方明细）。\n确认无解要强行提交时，填放行理由（会进审计）：`,
        );
        if (input == null) return null;
        if (!input.trim()) {
          setMsg("有整季硬冲突时必须填放行理由才能提交");
          return null;
        }
        reason = input.trim();
      }
      await api(`/api/admin/tournaments/${tid}/windows/${selected}/schedule/commit`, {
        method: "POST",
        timeoutMs: 60000,
        body: reason ? { proposalHash: preview.proposalHash, reason } : { proposalHash: preview.proposalHash },
      });
      setPreview(null);
      return reason ? "已带放行理由提交到赛程" : "已提交到赛程";
    }, "把预览结果写进赛程？");

  const publish = () =>
    act(async () => {
      if (selected == null) return null;
      if ((preview?.unplaced ?? []).length > 0) {
        setMsg("还有可排场次没落档，补排后再公布");
        return null;
      }
      try {
        await api(`/api/admin/tournaments/${tid}/windows/${selected}/publish`, {
          method: "POST",
          body: {},
        });
      } catch (e) {
        const text = e instanceof Error ? e.message : "公布失败";
        if (!text.includes("硬冲突")) throw e;
        const reason = window.prompt(`${text}\n确认无解要强行公布时，填放行理由（会进审计）：`);
        if (!reason?.trim()) return null;
        await api(`/api/admin/tournaments/${tid}/windows/${selected}/publish`, {
          method: "POST",
          body: { reason: reason.trim() },
        });
      }
      setPreview(null);
      return "已公布并锁定该窗口";
    }, "公布后该窗口锁定，确定？");

  const unlock = () =>
    act(async () => {
      if (selected == null) return null;
      const reason = window.prompt("解锁理由（会进审计）");
      if (!reason?.trim()) return null;
      await api(`/api/admin/tournaments/${tid}/windows/${selected}/unlock`, {
        method: "POST",
        body: { reason },
      });
      setPreview(null);
      return "已解锁";
    });

  const clear = () =>
    act(async () => {
      if (selected == null) return null;
      await api(`/api/admin/tournaments/${tid}/windows/${selected}/schedule`, { method: "DELETE" });
      setPreview(null);
      return "已清空该窗口的时刻";
    }, "清空这一窗口的所有时刻？（未开赛的场次才会被清）");

  const rows = preview?.matches ?? view?.matches ?? [];
  const issues = preview?.conflicts ?? view?.violations ?? [];
  const issueOf = useMemo(() => {
    const m = new Map<number, SeasonIssue[]>();
    for (const i of issues) m.set(i.matchId, [...(m.get(i.matchId) ?? []), i]);
    return m;
  }, [issues]);
  const current = windows?.find((w) => w.id === selected) ?? null;
  const hardCount = issues.filter((i) => i.level === "hard").length;
  // S3 整季体检（与本段相关的部分）：canCommit 由这里的 hard 决定，窗口级 conflicts 只随快照留档
  const seasonIssues = preview?.seasonViolations ?? [];
  const seasonHard = seasonIssues.filter((v) => v.level === "hard").length;

  return (
    <section className="card">
      <h3>排期 · 单段下钻</h3>
      {drill && drill.tournamentId !== detail.tournament.id && (
        <p className="muted">
          从赛季总览下钻：【{drill.tournamentName}】的窗口（当前页赛事是【{detail.tournament.name}】）。
        </p>
      )}
      <p className="muted">
        时刻是虚拟标签（第几周 / 周几 / 几点），不换算真实日期。生成提案只算不写，提交后才落库；
        公布即锁定，要改先解锁。
      </p>

      {windows && windows.length === 0 && (
        <p className="muted">这个赛事还没有赛历窗口。先导入赛季赛历（season / round_window）。</p>
      )}

      {windows && windows.length > 0 && (
        <div className="btn-row" style={{ flexWrap: "wrap", gap: 8 }}>
          <select
            value={selected ?? ""}
            onChange={(e) => setSelected(Number(e.target.value))}
            disabled={busy}
          >
            {windows.map((w) => (
              <option key={w.id} value={w.id}>
                {windowLabel(w)}
                {w.lockedAt ? " · 已锁定" : ""}
              </option>
            ))}
          </select>
          <button className="btn" disabled={busy || !!current?.lockedAt} onClick={genPreview}>
            生成提案
          </button>
          <button
            className="btn"
            disabled={busy || !preview || (preview.unplaced ?? []).length > 0}
            title={
              (preview?.unplaced ?? []).length > 0
                ? `还有 ${(preview?.unplaced ?? []).length} 场可排场次没落档，先补池子或调整窗口`
                : undefined
            }
            onClick={commit}
          >
            提交
          </button>
          <button
            className="btn"
            disabled={busy || !!current?.lockedAt || (preview?.unplaced ?? []).length > 0}
            title={
              (preview?.unplaced ?? []).length > 0
                ? `还有 ${(preview?.unplaced ?? []).length} 场可排场次没落档，先补池子或调整窗口`
                : undefined
            }
            onClick={publish}
          >
            公布
          </button>
          <button className="btn" disabled={busy || !current?.lockedAt} onClick={unlock}>
            解锁
          </button>
          <button className="btn" disabled={busy || !!current?.lockedAt} onClick={clear}>
            清空
          </button>
        </div>
      )}

      {view?.blocked && <p className="muted">⛔ {view.blocked}</p>}
      {preview && (preview.unplaced ?? []).length > 0 && (
        <p className="muted">
          ⚠️ 还有 {(preview.unplaced ?? []).length} 场可排场次没有落档；提交/公布已禁用，先补池子或调整窗口。
        </p>
      )}
      {msg && <p className="muted">{msg}</p>}

      {view && (
        <p className="muted">
          窗口：第 {view.window.week} 周 · {dayRangeText(view.window.dayStart, view.window.dayEnd)}
          {view.window.simultaneous ? "（末轮同时开球）" : view.window.overridden ? "（该轮有集中时刻覆盖）" : ""}
          {view.window.lockedAt ? " · 已公布锁定" : ""}
        </p>
      )}

      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>对阵</th>
              <th>状态</th>
              <th>时刻</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const rowIssues = issueOf.get(m.matchId) ?? [];
              const label =
                m.week && m.day && m.time
                  ? `第 ${m.week} 周 · 周${weekdayCn(m.day)} ${m.time}`
                  : "未排";
              return (
                <tr key={m.matchId}>
                  <td>{m.slot}</td>
                  <td>
                    {m.homeName ?? "待定"} vs {m.awayName ?? "待定"}
                    {!m.playable && <span className="muted">（对手未定）</span>}
                  </td>
                  <td>
                    {m.status === "pending" ? "未开赛" : m.status === "live" ? "进行中" : "已结束"}
                  </td>
                  <td>
                    {label}
                    {m.override && <span className="muted"> · 已改期</span>}
                    {rowIssues.map((i, idx) => (
                      <div key={idx} className="muted">
                        {i.level === "hard" ? "⛔" : i.level === "soft" ? "⚠️" : "ℹ️"} {i.reason}
                      </div>
                    ))}
                  </td>
                  <td>
                    {m.status === "pending" && !current?.lockedAt ? (
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => setEditing(editing === m.matchId ? null : m.matchId)}
                      >
                        {editing === m.matchId ? "取消" : "改期"}
                      </button>
                    ) : (
                      <span className="muted">—</span>
                    )}
                    {editing === m.matchId && (
                      <KickoffEditor
                        tid={tid}
                        row={m}
                        windowWeek={view?.window.week ?? null}
                        busy={busy}
                        onDone={async (note) => {
                          setEditing(null);
                          setMsg(note);
                          // 单场改期后旧提案必然过期；不清理的话表格仍显示旧预览时刻。
                          setPreview(null);
                          await Promise.all([loadWindows(), loadView()]);
                        }}
                        onError={setMsg}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {hardCount > 0 && (
        <p className="muted">
          窗口内有 {hardCount} 条硬冲突；整季体检有硬冲突或存在未落档场次时不能提交。
        </p>
      )}
      {preview && seasonHard > 0 && (
        <p className="muted">
          整季体检有 {seasonHard} 条硬冲突，提交会被拒；确认无解可在提交时填放行理由（进审计和版本流）。
        </p>
      )}
      {preview && seasonIssues.length > 0 && (
        <details className="season-viol" open={seasonHard > 0}>
          <summary>
            整季体检（提交门槛）：{seasonIssues.length} 条 · 硬 {seasonHard} · 软{" "}
            {seasonIssues.filter((v) => v.level === "soft").length} · 提示{" "}
            {seasonIssues.filter((v) => v.level === "report").length}
          </summary>
          <ul style={{ margin: "6px 0", paddingLeft: 18 }}>
            {seasonIssues.map((v, idx) => (
              <li key={idx}>
                {v.level === "hard" ? "⛔" : v.level === "soft" ? "⚠️" : "💬"}{" "}
                {v.matchId > 0 ? `#${v.matchId}` : "段容量"}
                {v.relatedMatchId != null ? `（与 #${v.relatedMatchId} 相邻）` : ""} {v.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

// 单场改期：越窗/不在池子里要求写理由，后端会打 kickoff_override。
function KickoffEditor({
  tid,
  row,
  windowWeek,
  busy,
  onDone,
  onError,
}: {
  tid: number;
  row: RowDto;
  windowWeek: number | null;
  busy: boolean;
  onDone: (note: string) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [week, setWeek] = useState(String(row.week ?? windowWeek ?? ""));
  const [day, setDay] = useState(String(row.day ?? ""));
  const [time, setTime] = useState(row.time ?? "");
  const [reason, setReason] = useState("");
  const [localBusy, setLocalBusy] = useState(false);

  const save = async () => {
    setLocalBusy(true);
    try {
      const res = await api<{ warnings?: string[] }>(
        `/api/admin/tournaments/${tid}/matches/${row.matchId}/kickoff`,
        {
          method: "PATCH",
          body: { week: Number(week), day: Number(day), time, reason: reason || undefined },
        }
      );
      const warn = res.warnings?.length ? `（${res.warnings.join("；")}）` : "";
      await onDone(`已改期${warn}`);
    } catch (e) {
      onError(e instanceof Error ? e.message : "改期失败");
    } finally {
      setLocalBusy(false);
    }
  };

  return (
    <div className="kickoff-editor">
      <input
        className="kickoff-num"
        inputMode="numeric"
        value={week}
        onChange={(e) => setWeek(e.target.value)}
        placeholder="周"
        aria-label="第几周"
      />
      <input
        className="kickoff-num"
        inputMode="numeric"
        value={day}
        onChange={(e) => setDay(e.target.value)}
        placeholder="天"
        aria-label="周几（1–7）"
      />
      <input
        className="kickoff-time"
        value={time}
        onChange={(e) => setTime(e.target.value)}
        placeholder="HH:MM"
        aria-label="时刻"
      />
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="理由（越窗必填）"
        aria-label="改期理由"
      />
      <button className="btn" disabled={busy || localBusy} onClick={() => void save()}>
        保存
      </button>
    </div>
  );
}
