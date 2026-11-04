// 排期页（P3-B）：按窗口生成提案 → 提交 → 公布；单场可越窗改期（留 override 标记）。
// 时刻是虚拟标签（周/天/HH:MM），周几只做显示，不换算真实日期。
import { useCallback, useEffect, useMemo, useState } from "react";
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

type Issue = { matchId: number; level: "hard" | "soft"; reason: string };

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
  violations: Issue[];
  blocked: string | null;
};

type PreviewResp = {
  proposalHash: string;
  matches: RowDto[];
  conflicts: Issue[];
  canCommit: boolean;
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
}: {
  detail: TournamentDetailDTO;
  reload: () => void;
}) {
  const tid = detail.tournament.id;
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
    setSelected((cur) => cur ?? body.windows.find((w) => w.matchCount > 0)?.id ?? null);
  }, [tid]);

  const loadView = useCallback(async () => {
    if (selected == null) return;
    setView(await api<ScheduleResp>(`/api/admin/tournaments/${tid}/windows/${selected}/schedule`));
  }, [tid, selected]);

  useEffect(() => {
    void loadWindows().catch((e) => setMsg(e instanceof Error ? e.message : "加载窗口失败"));
  }, [loadWindows]);

  useEffect(() => {
    setPreview(null);
    setEditing(null);
    void loadView().catch((e) => setMsg(e instanceof Error ? e.message : "加载排期失败"));
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
      return `已生成提案：${p.matches.filter((m) => m.time).length} 场，${
        p.conflicts.filter((c) => c.level === "hard").length
      } 条硬冲突、${p.conflicts.filter((c) => c.level === "soft").length} 条软冲突`;
    });

  const commit = () =>
    act(async () => {
      if (selected == null || !preview) return null;
      await api(`/api/admin/tournaments/${tid}/windows/${selected}/schedule/commit`, {
        method: "POST",
        body: { proposalHash: preview.proposalHash },
      });
      setPreview(null);
      return "已提交到赛程";
    }, "把预览结果写进赛程？");

  const publish = () =>
    act(async () => {
      if (selected == null) return null;
      await api(`/api/admin/tournaments/${tid}/windows/${selected}/publish`, { method: "POST" });
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
    const m = new Map<number, Issue[]>();
    for (const i of issues) m.set(i.matchId, [...(m.get(i.matchId) ?? []), i]);
    return m;
  }, [issues]);
  const current = windows?.find((w) => w.id === selected) ?? null;
  const hardCount = issues.filter((i) => i.level === "hard").length;

  return (
    <section className="card">
      <h3>排期</h3>
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
          <button className="btn" disabled={busy || !preview?.canCommit} onClick={commit}>
            提交
          </button>
          <button className="btn" disabled={busy || !!current?.lockedAt} onClick={publish}>
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
                        {i.level === "hard" ? "⛔" : "⚠️"} {i.reason}
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

      {hardCount > 0 && <p className="muted">有 {hardCount} 条硬冲突，提交会被拒。</p>}
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
