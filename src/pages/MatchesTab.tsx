import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { MatchScore, computeAgg } from "../components/MatchScore";
import { TeamLogo } from "../components/TeamLogo";
import { EventDot } from "../components/Cards";
import { LineupGrid } from "../components/LineupView";
import type {
  EntryDTO,
  MatchDTO,
  MatchEventDTO,
  MatchEventType,
  MatchLineupDTO,
  PlayerDTO,
  StageDTO,
  SuspensionConfig,
  SuspensionStatusDTO,
  SuspensionsResp,
  TournamentDetailDTO,
} from "../../shared/types";

const MATCH_STATUS: Record<MatchDTO["status"], string> = {
  pending: "未开打",
  live: "进行中",
  finished: "已完赛",
};

// 事件类型下拉只列 8 类：red_2y（两黄变一红）由后端在第二张黄牌时自动生成，不开放手选
const EVENT_LABEL: Record<Exclude<MatchEventType, "red_2y">, string> = {
  goal: "进球",
  pen_goal: "点球进球",
  pen_miss: "点球射失",
  own_goal: "乌龙球（计入对方）",
  injury_minor: "轻伤 🩹",
  injury_major: "重伤 🚑",
  yellow: "黄牌",
  red: "红牌",
};

// 事件显示名（含自动生成的 red_2y），事件列表用
const EVENT_NAME: Record<MatchEventType, string> = {
  ...EVENT_LABEL,
  red_2y: "两黄变一红",
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
  reload: () => void | Promise<void>;
}) {
  const [matches, setMatches] = useState<MatchDTO[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [openPanel, setOpenPanel] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  // 参赛队名单缓存：tab 打开即并行预取全部队，面板展开零等待
  const [playersCache, setPlayersCache] = useState<Map<number, PlayerDTO[]>>(
    new Map(),
  );
  // 停赛状态（纯派生，事件增删后随 tick 重拉）
  const [susp, setSusp] = useState<Map<number, SuspensionStatusDTO>>(new Map());
  const [suspCfg, setSuspCfg] = useState<SuspensionConfig | null>(null);

  const entryById = new Map<number, EntryDTO>(
    detail.entries.map((e) => [e.id, e]),
  );

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

  // 停赛状态（纯派生）：打开事件面板才拉，事件增删后随 tick 重拉——进 tab 不再全量重放整届停赛
  const panelActive = openPanel !== null;
  useEffect(() => {
    if (!panelActive) return;
    let on = true;
    api<SuspensionsResp>(`/api/admin/tournaments/${detail.tournament.id}/suspensions`)
      .then((b) => {
        if (!on) return;
        setSusp(new Map(b.players.map((p) => [p.playerId, p])));
        setSuspCfg(b.config);
      })
      .catch(() => {}); // 拉不到就不做停赛标记，录入流程不受影响
    return () => {
      on = false;
    };
  }, [panelActive, detail.tournament.id, tick]);

  // 自驱动补拉缺失的队名单（拉完缓存更新，触发重试直至补齐）
  useEffect(() => {
    if (!matches) return;
    const ids = new Set<number>();
    for (const m of matches) {
      for (const eid of [m.homeEntryId, m.awayEntryId]) {
        const tid = eid != null ? entryById.get(eid)?.teamId : undefined;
        if (tid != null) ids.add(tid);
      }
    }
    const missing = [...ids].filter((tid) => !playersCache.has(tid));
    if (missing.length === 0) return;
    let alive = true;
    Promise.all(
      missing.map((tid) =>
        api<{ players: PlayerDTO[] }>(`/api/admin/teams/${tid}`).then(
          (b) => [tid, b.players] as const,
        ),
      ),
    )
      .then((pairs) => {
        if (alive)
          setPlayersCache((prev) => new Map([...prev, ...pairs]));
      })
      .catch(() => {}); // 名单拉不到就保持空：事件照录，仅无球员选项
    return () => {
      alive = false;
    };
  }, [matches, playersCache, entryById]);

  const playersOf = (entryId: number | null): PlayerDTO[] =>
    entryId == null
      ? []
      : (playersCache.get(entryById.get(entryId)?.teamId ?? -1) ?? []);
  const playerById = new Map<number, string>();
  for (const list of playersCache.values())
    for (const p of list) playerById.set(p.id, p.name);

  const act = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setMessage(null);
    try {
      const note = await fn();
      // 操作后的全量刷新改并行：赛程与赛事详情同时重取，停赛数据随 tick 跟进
      await Promise.all([refetch(), reload()]);
      setTick((t) => t + 1);
      if (note) setMessage(note);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  if (matches === null) return <p className="muted card">加载中…</p>;

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
                      homePlayers={playersOf(m.homeEntryId)}
                      awayPlayers={playersOf(m.awayEntryId)}
                      playerById={playerById}
                      susp={susp}
                      suspThreshold={suspCfg?.yellowThreshold ?? 0}
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
              homePlayers={playersOf(m.homeEntryId)}
              awayPlayers={playersOf(m.awayEntryId)}
              playerById={playerById}
              susp={susp}
              suspThreshold={suspCfg?.yellowThreshold ?? 0}
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
  homePlayers,
  awayPlayers,
  playerById,
  susp,
  suspThreshold,
  busy,
  act,
  tick,
  panelOpen,
  togglePanel,
}: {
  match: MatchDTO;
  agg: [number, number] | null;
  entryById: Map<number, EntryDTO>;
  homePlayers: PlayerDTO[];
  awayPlayers: PlayerDTO[];
  playerById: Map<number, string>;
  susp: Map<number, SuspensionStatusDTO>;
  suspThreshold: number;
  busy: boolean;
  act: Act;
  tick: number;
  panelOpen: boolean;
  togglePanel: () => void;
}) {
  const bye = m.note === "轮空";
  const [lineupOpen, setLineupOpen] = useState(false);

  return (
    <div className={`match-row mr-${m.status}`}>
      <div className="mr-line">
        <span className={`mr-team${m.winnerEntryId === m.homeEntryId ? " mr-win" : ""}`}>
          {m.homeTeamName ? (
            <>
              <TeamLogo name={m.homeTeamName} url={m.homeLogoUrl} size={18} />
              {m.homeTeamName}
            </>
          ) : (
            "待定"
          )}
        </span>
        <MatchScore m={m} agg={agg} />
        <span className={`mr-team mr-away${m.winnerEntryId === m.awayEntryId ? " mr-win" : ""}`}>
          {m.awayTeamName ? (
            <>
              {m.awayTeamName}
              <TeamLogo name={m.awayTeamName} url={m.awayLogoUrl} size={18} />
            </>
          ) : (
            "待定"
          )}
        </span>
        <span className={`m-badge ms-${m.status}`}>{MATCH_STATUS[m.status]}</span>
        <span className="mr-actions">
          {!bye && m.homeEntryId !== null && m.awayEntryId !== null && (
            <MatchActions match={m} busy={busy} act={act} panelOpen={panelOpen} togglePanel={togglePanel} />
          )}
          {!bye && (
            <button className="btn btn-sm" onClick={() => setLineupOpen((v) => !v)}>
              {lineupOpen ? "收起阵容" : "阵容"}
            </button>
          )}
        </span>
      </div>
      {!bye && panelOpen && m.homeEntryId !== null && m.awayEntryId !== null && (
        <MatchPanel
          match={m}
          entryById={entryById}
          homePlayers={homePlayers}
          awayPlayers={awayPlayers}
          playerById={playerById}
          susp={susp}
          suspThreshold={suspThreshold}
          busy={busy}
          act={act}
          tick={tick}
          togglePanel={togglePanel}
        />
      )}
      {lineupOpen && !bye && <LineupPanel matchId={m.id} />}
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
  homePlayers,
  awayPlayers,
  playerById,
  susp,
  suspThreshold,
  busy,
  act,
  tick,
  togglePanel,
}: {
  match: MatchDTO;
  entryById: Map<number, EntryDTO>;
  homePlayers: PlayerDTO[];
  awayPlayers: PlayerDTO[];
  playerById: Map<number, string>;
  susp: Map<number, SuspensionStatusDTO>;
  suspThreshold: number;
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
      )}
      {(m.status === "live" || m.status === "finished") && (
        <>
          <EventForm
            match={m}
            homePlayers={homePlayers}
            awayPlayers={awayPlayers}
            susp={susp}
            suspThreshold={suspThreshold}
            busy={busy}
            act={act}
          />
          <EventList
            matchId={m.id}
            entryById={entryById}
            playerById={playerById}
            busy={busy}
            act={act}
            tick={tick}
          />
        </>
      )}
      {m.status === "live" && (
        <ScoreForm match={m} busy={busy} act={act} onDone={togglePanel} live />
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
  const [sh, setSh] = useState(live ? "" : (m.scoreHome?.toString() ?? ""));
  const [sa, setSa] = useState(live ? "" : (m.scoreAway?.toString() ?? ""));
  const [ph, setPh] = useState(m.penHome?.toString() ?? "");
  const [pa, setPa] = useState(m.penAway?.toString() ?? "");
  const [err, setErr] = useState<string | null>(null);
  // 两击确认防误触：首击进入待确认态，3 秒内再击才真正提交；改动输入即复位
  const [arm, setArm] = useState(false);
  const armTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (armTimer.current) window.clearTimeout(armTimer.current);
    };
  }, []);

  const change = (
    setter: (v: string) => void
  ) =>
    (v: string) => {
      setter(v);
      setArm(false);
      if (armTimer.current) window.clearTimeout(armTimer.current);
    };

  const submit = () => {
    if (!arm) {
      setArm(true);
      if (armTimer.current) window.clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => setArm(false), 3000);
      return;
    }
    if (armTimer.current) window.clearTimeout(armTimer.current);
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
  };

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
          onChange={(e) => change(setSh)(e.target.value)}
          placeholder={live ? String(m.scoreHome ?? 0) : "主"}
          style={{ width: "4.5em" }}
        />
        {" : "}
        <input
          className="input"
          type="number"
          min="0"
          value={sa}
          onChange={(e) => change(setSa)(e.target.value)}
          placeholder={live ? String(m.scoreAway ?? 0) : "客"}
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
          onChange={(e) => change(setPh)(e.target.value)}
          placeholder="主"
          style={{ width: "4.5em" }}
        />
        {" : "}
        <input
          className="input"
          type="number"
          min="0"
          value={pa}
          onChange={(e) => change(setPa)(e.target.value)}
          placeholder="客"
          style={{ width: "4.5em" }}
        />
      </label>
      <button
        className={arm ? "btn btn-sm btn-danger" : "btn btn-sm"}
        type="submit"
        disabled={busy}
      >
        {arm
          ? "再点一次确认"
          : live
            ? "终场确认"
            : m.status === "finished"
              ? "保存改判"
              : "记为完赛"}
      </button>
      {live && <button className="btn btn-sm" type="button" disabled={busy} onClick={onDone}>取消</button>}
      {live && <span className="muted">留空 = 按事件累计比分终场</span>}
      {equal && <span className="muted">平局且是淘汰赛时必须填点球比分</span>}
      {err && <span className="error-text">{err}</span>}
    </form>
  );
}

function EventForm({
  match: m,
  homePlayers,
  awayPlayers,
  susp,
  suspThreshold,
  busy,
  act,
}: {
  match: MatchDTO;
  homePlayers: PlayerDTO[];
  awayPlayers: PlayerDTO[];
  susp: Map<number, SuspensionStatusDTO>;
  suspThreshold: number;
  busy: boolean;
  act: Act;
}) {
  const [type, setType] = useState<Exclude<MatchEventDTO["type"], "red_2y">>("goal");
  const [side, setSide] = useState<"home" | "away">("home");
  const [playerId, setPlayerId] = useState("");
  const [assistId, setAssistId] = useState("");
  const [minute, setMinute] = useState("");

  const players = side === "home" ? homePlayers : awayPlayers;
  const goalish = type === "goal" || type === "pen_goal";
  const switchSide = (s: "home" | "away") => {
    setSide(s);
    setPlayerId("");
    setAssistId("");
  };

  // 软约束提示：选中停赛球员给红色警告，逼近黄牌阈值给黄色预警（都不拦截录入）
  const sel = playerId !== "" ? susp.get(Number(playerId)) : undefined;
  const suspWarn = sel && sel.remaining > 0;
  const yellowWarn =
    sel && !suspWarn && suspThreshold > 0 && sel.yellows === suspThreshold - 1;

  // 下拉选项文本：停赛球员与临界黄牌球员加后缀（option 是纯文本，用符号标记）
  const optionSuffix = (pid: number): string => {
    const s = susp.get(pid);
    if (!s) return "";
    if (s.remaining > 0) return `（⛔停赛 剩${s.remaining}场）`;
    if (suspThreshold > 0 && s.yellows === suspThreshold - 1)
      return `（⚠️再${suspThreshold - s.yellows}黄停赛）`;
    return "";
  };

  return (
    <>
      <form
        className="inline-form event-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          act(async () => {
            const entryId = side === "home" ? m.homeEntryId : m.awayEntryId;
            if (entryId === null) return null;
            const b = await api<{
              scoreHome: number;
              scoreAway: number;
              notice?: string;
              warning?: string;
            }>(`/api/admin/matches/${m.id}/events`, {
              method: "POST",
              body: {
                type,
                entryId,
                playerId: playerId === "" ? undefined : Number(playerId),
                assistPlayerId:
                  goalish && assistId !== "" ? Number(assistId) : undefined,
                minute: minute === "" ? undefined : Number(minute),
              },
            });
            return [b.notice, b.warning].filter(Boolean).join("；") || null;
          });
        }}
      >
        <div className="ev-side-seg" role="group" aria-label="所属球队">
          <button
            type="button"
            aria-pressed={side === "home"}
            onClick={() => switchSide("home")}
          >
            {m.homeTeamName ?? "主队"}
          </button>
          <button
            type="button"
            aria-pressed={side === "away"}
            onClick={() => switchSide("away")}
          >
            {m.awayTeamName ?? "客队"}
          </button>
        </div>
        <select
          className="input"
          value={type}
          onChange={(e) => setType(e.target.value as Exclude<MatchEventDTO["type"], "red_2y">)}
        >
          {(Object.keys(EVENT_LABEL) as Exclude<MatchEventType, "red_2y">[]).map((t) => (
            <option key={t} value={t}>
              {EVENT_LABEL[t]}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={playerId}
          onChange={(e) => setPlayerId(e.target.value)}
        >
          <option value="">球员（可选）</option>
          {players.map((p) => (
            <option key={p.id} value={p.id}>
              {p.number ? `#${p.number} ` : ""}
              {p.name}
              {optionSuffix(p.id)}
            </option>
          ))}
        </select>
        {goalish && (
          <select
            className="input"
            value={assistId}
            onChange={(e) => setAssistId(e.target.value)}
          >
            <option value="">助攻（可选）</option>
            {players
              .filter((p) => String(p.id) !== playerId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number ? `#${p.number} ` : ""}
                  {p.name}
                </option>
              ))}
          </select>
        )}
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
        {sel && suspWarn && (
          <span className="warn-line susp-warn">
            ⚠ {sel.playerName} 停赛中（剩 {sel.remaining} 场）——软约束不拦截，请确认该球员是否合规出场
          </span>
        )}
        {sel && yellowWarn && (
          <span className="warn-line yellow-warn">
            ⚠ {sel.playerName} 已累积 {sel.yellows} 张黄牌，再吃 1 张将自动停赛 1 场
          </span>
        )}
      </form>
    </>
  );
}

function EventList({
  matchId,
  entryById,
  playerById,
  busy,
  act,
  tick,
}: {
  matchId: number;
  entryById: Map<number, EntryDTO>;
  playerById: Map<number, string>;
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
        const who = ev.playerId != null ? playerById.get(ev.playerId) : undefined;
        const assist =
          ev.assistPlayerId != null
            ? playerById.get(ev.assistPlayerId)
            : undefined;
        return (
          <li key={ev.id}>
            <EventDot type={ev.type} />
            {ev.minute !== null && <span className="ev-minute">{ev.minute}′</span>}
            <span>{EVENT_NAME[ev.type]}</span>
            {who && <span className="ev-player">{who}</span>}
            {assist && <span className="ev-assist">（助攻 {assist}）</span>}
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

// 管理端：双方提交的战术阵容（赛前备案可见；公开端开赛后才显示）
function LineupPanel({ matchId }: { matchId: number }) {
  const [data, setData] = useState<MatchLineupDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    api<MatchLineupDTO>(`/api/admin/matches/${matchId}/lineup`)
      .then((b) => {
        if (!dead) setData(b);
      })
      .catch((e: unknown) => {
        if (!dead) setErr(e instanceof Error ? e.message : "加载失败");
      });
    return () => {
      dead = true;
    };
  }, [matchId]);
  return (
    <div className="match-panel">
      {err ? (
        <p className="error-msg">{err}</p>
      ) : !data ? (
        <p className="muted">加载中…</p>
      ) : data.home || data.away ? (
        <LineupGrid home={data.home} away={data.away} />
      ) : (
        <p className="muted">双方都还没提交阵容（教练在战术板 → 提交阵容）。</p>
      )}
    </div>
  );
}
