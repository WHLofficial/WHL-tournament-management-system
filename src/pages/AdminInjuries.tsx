// 伤停管理（集中页）：所有伤停登记在这里看、改、撤，待登记也在这里建。
// 登记仍挂在具体的伤病事件上（一个事件一条登记），缺阵场次可跨赛事勾选。
// 比赛页只保留「选了伤停球员给个警告」的软提示，不再散着放登记入口。
import { Fragment, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { InjuryRegPanel } from "../components/InjuryRegPanel";
import { Page } from "../components/ui";
import type {
  InjuryEventCandidateDTO,
  InjuryEventCandidatesResp,
  InjuryListResp,
  InjuryStatusDTO,
} from "../../shared/types";

const MATCH_STATUS: Record<"pending" | "live" | "finished", string> = {
  pending: "未开打",
  live: "进行中",
  finished: "已完赛",
};

export function AdminInjuries() {
  const [list, setList] = useState<InjuryStatusDTO[] | null>(null);
  const [events, setEvents] = useState<InjuryEventCandidateDTO[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [openInj, setOpenInj] = useState<number | null>(null); // 展开编辑的登记 id
  const [openEvent, setOpenEvent] = useState<number | null>(null); // 展开登记的事件 id
  // 筛选：赛事 / 球队 / 球员搜索 / 只看仍在伤停
  const [fTour, setFTour] = useState("");
  const [fTeam, setFTeam] = useState("");
  const [fQ, setFQ] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);

  async function reload() {
    const [a, b] = await Promise.all([
      api<InjuryListResp>("/api/admin/injuries"),
      api<InjuryEventCandidatesResp>("/api/admin/injuries/events"),
    ]);
    setList(a.injuries);
    setEvents(b.events);
  }

  // 待登记卡片整块可点：再按一次收起。没记球员的事件打不开（登记要有人）
  function togglePending(e: InjuryEventCandidateDTO) {
    if (e.playerId == null) return;
    setOpenInj(null);
    setOpenEvent((cur) => (cur === e.eventId ? null : e.eventId));
  }
  useEffect(() => {
    reload().catch((e: unknown) => {
      setList([]);
      setEvents([]);
      setMsg(e instanceof Error ? e.message : "加载失败");
    });
  }, []);

  // 与比赛页/球队页同款 busy + 提示语义
  async function act(fn: () => Promise<string | null>) {
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
  }

  const all = list ?? [];
  // 赛事下拉的选项：从登记与待登记事件里收（没有赛事表接口，这里够用）
  const tours = useMemo(() => {
    const m = new Map<number, string>();
    for (const i of all)
      for (const x of i.misses) m.set(x.tournamentId, x.tournamentName);
    for (const e of events ?? []) m.set(e.tournamentId, e.tournamentName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], "zh"));
  }, [all, events]);
  const teams = useMemo(() => {
    const m = new Map<number, string>();
    for (const i of all) m.set(i.teamId, i.teamName || `#${i.teamId}`);
    for (const e of events ?? []) m.set(e.teamId, e.teamName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], "zh"));
  }, [all, events]);

  const injuries = all.filter((i) => {
    if (fTeam && String(i.teamId) !== fTeam) return false;
    if (fTour && !i.misses.some((x) => String(x.tournamentId) === fTour)) return false;
    if (fQ && !i.playerName.includes(fQ.trim())) return false;
    if (activeOnly && !(i.misses.length > 0 && i.misses.some((x) => x.status !== "finished")))
      return false;
    return true;
  });
  const pending = (events ?? []).filter((e) => {
    if (fTeam && String(e.teamId) !== fTeam) return false;
    if (fTour && String(e.tournamentId) !== fTour) return false;
    if (fQ && !(e.playerName ?? "").includes(fQ.trim())) return false;
    return true;
  });

  const activeCount = all.filter(
    (i) => i.misses.length > 0 && i.misses.some((x) => x.status !== "finished"),
  ).length;

  return (
    <Page>
      <h2>伤停管理</h2>
      <p className="muted">
        登记的伤停都集中在这里。登记挂在具体的伤病事件上（一个事件一条登记）：先在赛程里记一条「轻伤 / 重伤」事件，
        再到这里建登记、勾缺阵场次。缺阵场次可跨赛事勾选，已完赛的也能补录（误登就撤销，提前复出就把场次去掉）。
      </p>

      {msg && <p className="banner">{msg}</p>}

      <div className="card">
        <div className="inj-filter">
          <label>
            赛事
            <select className="input" value={fTour} onChange={(e) => setFTour(e.target.value)}>
              <option value="">全部</option>
              {tours.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            球队
            <select className="input" value={fTeam} onChange={(e) => setFTeam(e.target.value)}>
              <option value="">全部</option>
              {teams.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            球员
            <input
              className="input"
              value={fQ}
              onChange={(e) => setFQ(e.target.value)}
              placeholder="按名字搜"
            />
          </label>
          <label className="inj-filter-check">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
            />
            只看仍在伤停（{activeCount}）
          </label>
        </div>

        <h3>伤停登记（{injuries.length}）</h3>
        {list === null ? (
          <p className="muted">加载中…</p>
        ) : injuries.length === 0 ? (
          <p className="muted">
            {all.length === 0 ? "还没有伤停登记。" : "没有符合筛选的登记。"}
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>球员</th>
                <th>球队</th>
                <th>伤情</th>
                <th>受伤那一场</th>
                <th>缺阵</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {injuries.map((inj) => {
                const total = inj.misses.length;
                const done = inj.misses.filter((x) => x.status === "finished").length;
                const rest = total - done;
                return (
                  <Fragment key={inj.id}>
                    <tr>
                      <td>{inj.playerName}</td>
                      <td>{inj.teamName || `#${inj.teamId}`}</td>
                      <td>
                        {inj.severity === "minor" ? "轻伤" : "重伤"}
                        {inj.injuryName ? ` · ${inj.injuryName}` : ""}
                        {inj.note ? `（${inj.note}）` : ""}
                      </td>
                      <td>
                        {inj.fromLabel}
                        {total > 0 && (
                          <span className="inj-tours">
                            {[
                              ...new Set(inj.misses.map((x) => x.tournamentName)),
                            ].join("、")}
                          </span>
                        )}
                      </td>
                      <td>
                        {total === 0
                          ? "未勾缺阵场次"
                          : rest > 0
                            ? `还缺 ${rest} 场 / 共 ${total} 场（伤愈 ${inj.recoverPercent}%）`
                            : `缺阵 ${total} 场已走完（已伤愈）`}
                      </td>
                      <td>
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={busy}
                          onClick={() => {
                            setOpenEvent(null);
                            setOpenInj(openInj === inj.id ? null : inj.id);
                          }}
                        >
                          {openInj === inj.id ? "收起" : "改登记"}
                        </button>
                      </td>
                    </tr>
                    {openInj === inj.id && (
                      <tr>
                        <td colSpan={6}>
                          <InjuryRegPanel
                            eventId={null}
                            teamId={inj.teamId}
                            severity={inj.severity}
                            playerName={inj.playerName}
                            existing={inj}
                            busy={busy}
                            act={act}
                            onSaved={() => void reload()}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>待登记（{pending.length}）</h3>
        <p className="muted">
          已经记过伤病事件、但还没建伤停登记的事件。点开卡片就能直接建登记，不用回赛程页翻。
        </p>
        {events === null ? (
          <p className="muted">加载中…</p>
        ) : pending.length === 0 ? (
          <p className="muted">
            {(events ?? []).length === 0
              ? "没有待登记的伤病事件——新伤病在赛程页记一条事件后就会出现在这里。"
              : "没有符合筛选的待登记事件。"}
          </p>
        ) : (
          <ul className="inj-pending">
            {pending.map((e) => {
              const canOpen = e.playerId != null;
              const open = canOpen && openEvent === e.eventId;
              return (
                <li key={e.eventId} className={`${canOpen ? "clickable" : ""}${open ? " open" : ""}`}>
                  <div
                    className={`inj-pending-head${canOpen ? " clickable" : ""}`}
                    onClick={canOpen ? () => togglePending(e) : undefined}
                    role={canOpen ? "button" : undefined}
                    tabIndex={canOpen ? 0 : undefined}
                    aria-expanded={canOpen ? open : undefined}
                    onKeyDown={
                      canOpen
                        ? (ev) => {
                            if (ev.key === "Enter" || ev.key === " ") {
                              ev.preventDefault();
                              togglePending(e);
                            }
                          }
                        : undefined
                    }
                  >
                    <div className="ipb-main">
                      <span className={`iw-sev${e.severity === "major" ? " iw-sev-major" : ""}`}>
                        {e.severity === "major" ? "重伤" : "轻伤"}
                      </span>
                      <b>{e.playerName ?? "未记球员"}</b>
                      <span className="ir-status">{MATCH_STATUS[e.matchStatus]}</span>
                      {canOpen && (
                        <span className="inj-pending-caret" aria-hidden="true">
                          ›
                        </span>
                      )}
                    </div>
                    <div className="ipb-sub">
                      <span>
                        {e.teamName}
                        {e.opponentName ? ` vs ${e.opponentName}` : ""}
                      </span>
                      <span>
                        {e.tournamentName} · 第 {e.round} 轮
                        {e.minute != null ? ` · 第 ${e.minute} 分钟` : ""}
                      </span>
                    </div>
                    {!canOpen && <div className="ipb-hint">该事件没记球员，先去赛程里补上球员</div>}
                  </div>
                  {open && (
                    <InjuryRegPanel
                      eventId={e.eventId}
                      teamId={e.teamId}
                      severity={e.severity}
                      playerName={e.playerName ?? ""}
                      existing={undefined}
                      busy={busy}
                      act={act}
                      onSaved={() => void reload()}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Page>
  );
}
