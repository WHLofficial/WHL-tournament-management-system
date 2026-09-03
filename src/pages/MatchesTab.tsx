import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { MatchScore, computeAgg } from "../components/MatchScore";
import type {
  EntryDTO,
  MatchDTO,
  MatchEventDTO,
  StageDTO,
  TournamentDetailDTO,
} from "../../shared/types";

const MATCH_STATUS: Record<MatchDTO["status"], string> = {
  pending: "未开打",
  live: "进行中",
  finished: "已完赛",
};

const EVENT_LABEL: Record<MatchEventDTO["type"], string> = {
  goal: "进球",
  yellow: "黄牌",
  red: "红牌",
};

export function elimRoundName(round: number, rounds: number): string {
  const slots = 2 ** (rounds - round);
  if (slots === 1) return "决赛";
  if (slots === 2) return "半决赛";
  if (slots === 4) return "1/4 决赛";
  return `1/${slots} 决赛`;
}

export const stageTitle: Record<StageDTO["kind"], string> = {
  elim: "淘汰赛",
  round_robin: "循环赛",
  group: "小组赛",
};

export default function MatchesTab({
  detail,
  reload,
}: {
  detail: TournamentDetailDTO;
  reload: () => void;
}) {
  const [matches, setMatches] = useState<MatchDTO[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [openPanel, setOpenPanel] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(async () => {
    try {
      const b = await api<{ matches: MatchDTO[] }>(
        `/api/admin/tournaments/${detail.tournament.id}/matches`,
      );
      setMatches(b.matches);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "加载赛程失败");
    }
  }, [detail.tournament.id]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const act = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setMessage(null);
    try {
      const note = await fn();
      await refetch();
      reload();
      setTick((t) => t + 1);
      if (note) setMessage(note);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  if (matches === null) return <p className="muted card">加载中…</p>;

  const entryById = new Map<number, EntryDTO>(
    detail.entries.map((e) => [e.id, e]),
  );

  const stagesWithMatches = detail.stages.filter((s) =>
    matches.some((m) => m.stageId === s.id),
  );
  const orphan = matches.filter((m) => !detail.stages.some((s) => s.id === m.stageId));

  return (
    <div className="matches-tab">
      {message && <p className="banner">{message}</p>}
      {stagesWithMatches.length === 0 && orphan.length === 0 && (
        <p className="muted card">还没有赛程。先到「编排」页生成比赛。</p>
      )}

      {stagesWithMatches.map((stage) => {
        const list = matches.filter((m) => m.stageId === stage.id);
        const rounds = [...new Set(list.map((m) => m.round))].sort((a, b) => a - b);
        return (
          <section key={stage.id} className="stage-block">
            <h3 className="stage-head">
              {stageTitle[stage.kind]}
            </h3>
            {rounds.map((round) => {
              const roundList = list.filter((m) => m.round === round);
              const label =
                stage.kind === "elim"
                  ? elimRoundName(round, Math.max(...list.map((m) => m.round)))
                  : `第 ${round} 轮`;
              return (
                <div key={round} className="round-block">
                  <h4 className="round-head">{label}</h4>
                  {roundList.map((m) => (
                    <MatchRow
                      key={m.id}
                      match={m}
                      agg={computeAgg(m, roundList)}
                      entryById={entryById}
                      busy={busy}
                      act={act}
                      tick={tick}
                      panelOpen={openPanel === m.id}
                      togglePanel={() =>
                        setOpenPanel(openPanel === m.id ? null : m.id)
                      }
                    />
                  ))}
                </div>
              );
            })}
          </section>
        );
      })}

      {orphan.length > 0 && (
        <section className="stage-block">
          <h3 className="stage-head">其他比赛</h3>
          {orphan.map((m) => (
            <MatchRow
              key={m.id}
              match={m}
              agg={null}
              entryById={entryById}
              busy={busy}
              act={act}
              tick={tick}
              panelOpen={openPanel === m.id}
              togglePanel={() => setOpenPanel(openPanel === m.id ? null : m.id)}
            />
          ))}
        </section>
      )}
    </div>
  );
}

type Act = (fn: () => Promise<string | null>) => Promise<void>;

function MatchRow({
  match: m,
  agg,
  entryById,
  busy,
  act,
  tick,
  panelOpen,
  togglePanel,
}: {
  match: MatchDTO;
  agg: [number, number] | null;
  entryById: Map<number, EntryDTO>;
  busy: boolean;
  act: Act;
  tick: number;
  panelOpen: boolean;
  togglePanel: () => void;
}) {
  const bye = m.note === "轮空";

  return (
    <div className={`match-row mr-${m.status}`}>
      <div className="mr-line">
        <span className={`mr-team${m.winnerEntryId === m.homeEntryId ? " mr-win" : ""}`}>
          {m.homeTeamName ?? "待定"}
        </span>
        <MatchScore m={m} agg={agg} />
        <span className={`mr-team${m.winnerEntryId === m.awayEntryId ? " mr-win" : ""}`}>
          {m.awayTeamName ?? "待定"}
        </span>
        <span className={`m-badge ms-${m.status}`}>{MATCH_STATUS[m.status]}</span>
        <span className="mr-actions">
          {!bye && m.homeEntryId !== null && m.awayEntryId !== null && (
            <MatchActions match={m} busy={busy} act={act} panelOpen={panelOpen} togglePanel={togglePanel} />
          )}
        </span>
      </div>
      {!bye && panelOpen && m.homeEntryId !== null && m.awayEntryId !== null && (
        <MatchPanel
          match={m}
          entryById={entryById}
          busy={busy}
          act={act}
          tick={tick}
          togglePanel={togglePanel}
        />
      )}
    </div>
  );
}

function MatchActions({
  match: m,
  busy,
  act,
  panelOpen,
  togglePanel,
}: {
  match: MatchDTO;
  busy: boolean;
  act: Act;
  panelOpen: boolean;
  togglePanel: () => void;
}) {
  if (m.status === "pending") {
    return (
      <>
        <button
          className="btn btn-sm"
          disabled={busy}
          onClick={() =>
            act(async () => {
              await api(`/api/admin/matches/${m.id}/start`, { method: "POST" });
              return null;
            })
          }
        >
          开赛
        </button>
        <button className="btn btn-sm" disabled={busy} onClick={togglePanel}>
          {panelOpen ? "收起" : "直接报分"}
        </button>
      </>
    );
  }
  if (m.status === "live") {
    return (
      <>
        <button className="btn btn-sm" disabled={busy} onClick={togglePanel}>
          {panelOpen ? "收起" : "事件录入"}
        </button>
      </>
    );
  }
  // finished
  return (
    <button className="btn btn-sm" disabled={busy} onClick={togglePanel}>
      {panelOpen ? "收起" : "改判 / 补录"}
    </button>
  );
}

function MatchPanel({
  match: m,
  entryById,
  busy,
  act,
  tick,
  togglePanel,
}: {
  match: MatchDTO;
  entryById: Map<number, EntryDTO>;
  busy: boolean;
  act: Act;
  tick: number;
  togglePanel: () => void;
}) {
  const homeName = m.homeTeamName ?? "主队";
  const awayName = m.awayTeamName ?? "客队";

  return (
    <div className="match-panel">
      {m.status !== "live" && <ScoreForm match={m} busy={busy} act={act} onDone={togglePanel} />}
      {m.status === "live" && (
        <>
          <div className="event-quick">
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const b = await api<{ scoreHome: number; scoreAway: number }>(
                    `/api/admin/matches/${m.id}/events`,
                    {
                      method: "POST",
                      body: { type: "goal", entryId: m.homeEntryId },
                    },
                  );
                  return `进球！当前比分 ${b.scoreHome} : ${b.scoreAway}`;
                })
              }
            >
              {homeName} 进球
            </button>
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const b = await api<{ scoreHome: number; scoreAway: number }>(
                    `/api/admin/matches/${m.id}/events`,
                    {
                      method: "POST",
                      body: { type: "goal", entryId: m.awayEntryId },
                    },
                  );
                  return `进球！当前比分 ${b.scoreHome} : ${b.scoreAway}`;
                })
              }
            >
              {awayName} 进球
            </button>
          </div>
          <EventForm match={m} busy={busy} act={act} />
          <EventList matchId={m.id} entryById={entryById} busy={busy} act={act} tick={tick} />
          <ScoreForm match={m} busy={busy} act={act} onDone={togglePanel} live />
        </>
      )}
    </div>
  );
}

// pending 快速报分 / live 终场确认 / finished 改判，同一表单
function ScoreForm({
  match: m,
  busy,
  act,
  onDone,
  live = false,
}: {
  match: MatchDTO;
  busy: boolean;
  act: Act;
  onDone: () => void;
  live?: boolean;
}) {
  const [sh, setSh] = useState(m.scoreHome?.toString() ?? "");
  const [sa, setSa] = useState(m.scoreAway?.toString() ?? "");
  const [ph, setPh] = useState(m.penHome?.toString() ?? "");
  const [pa, setPa] = useState(m.penAway?.toString() ?? "");
  const [err, setErr] = useState<string | null>(null);

  const submit = () =>
    act(async () => {
      setErr(null);
      const body: Record<string, number> = {};
      if (sh !== "") body.scoreHome = Number(sh);
      if (sa !== "") body.scoreAway = Number(sa);
      if (ph !== "") body.penHome = Number(ph);
      if (pa !== "") body.penAway = Number(pa);
      const b = await api<{ ok: boolean; regenerated?: boolean }>(
        `/api/admin/matches/${m.id}/finish`,
        { method: "POST", body },
      );
      onDone();
      return b.regenerated ? "淘汰赛对阵已自动生成" : null;
    }).then(() => undefined, (e: unknown) => {
      setErr(e instanceof Error ? e.message : "提交失败");
    });

  const equal = sh !== "" && sa !== "" && Number(sh) === Number(sa);

  return (
    <form
      className="inline-form score-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) submit();
      }}
    >
      <label>
        比分{" "}
        <input
          className="input"
          type="number"
          min="0"
          value={sh}
          onChange={(e) => setSh(e.target.value)}
          placeholder={live ? "主队" : "主"}
          style={{ width: "4.5em" }}
        />
        {" : "}
        <input
          className="input"
          type="number"
          min="0"
          value={sa}
          onChange={(e) => setSa(e.target.value)}
          placeholder="客"
          style={{ width: "4.5em" }}
        />
      </label>
      <label>
        点球{" "}
        <input
          className="input"
          type="number"
          min="0"
          value={ph}
          onChange={(e) => setPh(e.target.value)}
          placeholder="主"
          style={{ width: "4.5em" }}
        />
        {" : "}
        <input
          className="input"
          type="number"
          min="0"
          value={pa}
          onChange={(e) => setPa(e.target.value)}
          placeholder="客"
          style={{ width: "4.5em" }}
        />
      </label>
      <button className="btn btn-sm" type="submit" disabled={busy}>
        {live ? "终场确认" : m.status === "finished" ? "保存改判" : "记为完赛"}
      </button>
      {live && <button className="btn btn-sm" type="button" disabled={busy} onClick={onDone}>取消</button>}
      {equal && <span className="muted">平局且是淘汰赛时必须填点球比分</span>}
      {err && <span className="error-text">{err}</span>}
    </form>
  );
}

function EventForm({
  match: m,
  busy,
  act,
}: {
  match: MatchDTO;
  busy: boolean;
  act: Act;
}) {
  const [type, setType] = useState<MatchEventDTO["type"]>("yellow");
  const [side, setSide] = useState<"home" | "away">("home");
  const [minute, setMinute] = useState("");

  return (
    <form
      className="inline-form event-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        act(async () => {
          const entryId = side === "home" ? m.homeEntryId : m.awayEntryId;
          if (entryId === null) return null;
          await api(`/api/admin/matches/${m.id}/events`, {
            method: "POST",
            body: {
              type,
              entryId,
              minute: minute === "" ? undefined : Number(minute),
            },
          });
          return null;
        });
      }}
    >
      <select
        className="input"
        value={type}
        onChange={(e) => setType(e.target.value as MatchEventDTO["type"])}
      >
        <option value="goal">进球</option>
        <option value="yellow">黄牌</option>
        <option value="red">红牌</option>
      </select>
      <select
        className="input"
        value={side}
        onChange={(e) => setSide(e.target.value as "home" | "away")}
      >
        <option value="home">{m.homeTeamName ?? "主队"}</option>
        <option value="away">{m.awayTeamName ?? "客队"}</option>
      </select>
      <input
        className="input"
        type="number"
        min="0"
        max="300"
        value={minute}
        onChange={(e) => setMinute(e.target.value)}
        placeholder="分钟"
        style={{ width: "5em" }}
      />
      <button className="btn btn-sm" type="submit" disabled={busy}>
        记录事件
      </button>
    </form>
  );
}

function EventList({
  matchId,
  entryById,
  busy,
  act,
  tick,
}: {
  matchId: number;
  entryById: Map<number, EntryDTO>;
  busy: boolean;
  act: Act;
  tick: number;
}) {
  const [events, setEvents] = useState<MatchEventDTO[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ events: MatchEventDTO[] }>(`/api/admin/matches/${matchId}/events`)
      .then((b) => setEvents(b.events))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "加载事件失败"));
  }, [matchId, tick]);

  if (err) return <p className="error-text">{err}</p>;
  if (events === null) return <p className="muted">事件加载中…</p>;
  if (events.length === 0) return <p className="muted">还没有事件。进球、红黄牌都会出现在这里。</p>;

  return (
    <ul className="event-list">
      {events.map((ev) => {
        const e = entryById.get(ev.entryId);
        const name =
          e?.teamName ?? (ev.entryId === undefined ? "未知" : "未知球队");
        return (
          <li key={ev.id}>
            <span className={`ev-dot ev-${ev.type}`} />
            {ev.minute !== null && <span className="ev-minute">{ev.minute}′</span>}
            <span>{EVENT_LABEL[ev.type]}</span>
            <span className="ev-team">{name}</span>
            <button
              className="btn btn-sm btn-danger"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await api(`/api/admin/matches/${matchId}/events/${ev.id}`, {
                    method: "DELETE",
                  });
                  return null;
                })
              }
            >
              删除
            </button>
          </li>
        );
      })}
    </ul>
  );
}
