import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Link } from "react-router";
import { MatchScore, computeAgg } from "../components/MatchScore";
import { TeamLogo } from "../components/TeamLogo";
import { EventDot } from "../components/Cards";
import { LineupGrid } from "../components/LineupView";
import type {
  AuditEntryDTO,
  EntryDTO,
  InjuryListResp,
  InjuryStatusDTO,
  MatchDTO,
  MatchEventDTO,
  MatchEventType,
  AdminMatchLineupDTO,
  PlayerDTO,
  StageDTO,
  SuspensionConfig,
  SuspensionStatusDTO,
  SuspensionsResp,
  TournamentDetailDTO,
} from "../../shared/types";
import { elimRoundName } from "../../shared/rounds";

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
  // 停赛重拉专用信号：影响停赛账本的操作（牌类事件、开赛/终场）后 bump，进球不必拉
  const [suspTick, setSuspTick] = useState(0);
  // 参赛队名单缓存：tab 打开即并行预取全部队，面板展开零等待
  const [playersCache, setPlayersCache] = useState<Map<number, PlayerDTO[]>>(
    new Map(),
  );
  // 停赛状态（纯派生，事件增删后随 tick 重拉）
  const [susp, setSusp] = useState<Map<number, SuspensionStatusDTO>>(new Map());
  const [suspCfg, setSuspCfg] = useState<SuspensionConfig | null>(null);
  // 伤停数据（按队缓存）：只用于事件表单的软提示，面板打开才拉
  const [injuriesByTeam, setInjuriesByTeam] = useState<Map<number, InjuryStatusDTO[]>>(
    new Map(),
  );
  // 轮次分页（对齐公开页）：用户点选的轮；null = 跟随默认（live 轮 > 第一个轮）
  const [selRoundRaw, setSelRoundRaw] = useState<string | null>(null);

  const entryById = useMemo(
    () => new Map<number, EntryDTO>(detail.entries.map((e) => [e.id, e])),
    [detail.entries],
  );

  const refetchSeq = useRef(0);
  const refetch = useCallback(async () => {
    const seq = ++refetchSeq.current;
    try {
      const b = await api<{ matches: MatchDTO[] }>(
        `/api/admin/tournaments/${detail.tournament.id}/matches`,
      );
      // 序号守卫：解锁先行后允许快速连点，旧响应不得覆盖新状态
      if (seq === refetchSeq.current) setMatches(b.matches);
    } catch (e) {
      if (seq === refetchSeq.current)
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
  }, [panelActive, detail.tournament.id, suspTick]);

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

  // 伤停登记（按队拉）：给事件表单做「选了伤停球员」的软提示。登记本身在伤停管理页
  useEffect(() => {
    if (!panelActive || !matches) return;
    const ids = new Set<number>();
    for (const m of matches) {
      for (const eid of [m.homeEntryId, m.awayEntryId]) {
        const tid = eid != null ? entryById.get(eid)?.teamId : undefined;
        if (tid != null) ids.add(tid);
      }
    }
    if (ids.size === 0) return;
    let alive = true;
    Promise.all(
      [...ids].map((tid) =>
        api<InjuryListResp>(`/api/admin/injuries?teamId=${tid}`).then(
          (b) => [tid, b.injuries] as const,
        ),
      ),
    )
      .then((pairs) => {
        if (alive) setInjuriesByTeam(new Map(pairs));
      })
      .catch(() => {}); // 拉不到就不做伤停标记，录入流程不受影响
    return () => {
      alive = false;
    };
  }, [panelActive, matches, entryById]);

  const playersOf = (entryId: number | null): PlayerDTO[] =>
    entryId == null
      ? []
      : (playersCache.get(entryById.get(entryId)?.teamId ?? -1) ?? []);
  const playerById = useMemo(() => {
    const m = new Map<number, string>();
    for (const list of playersCache.values())
      for (const p of list) m.set(p.id, p.name);
    return m;
  }, [playersCache]);

  // 某 entry 所属队的伤停登记（登记面板判存在、球员下拉加伤停标记共用）
  const injuriesOf = (entryId: number | null): InjuryStatusDTO[] => {
    const tid = entryId == null ? undefined : entryById.get(entryId)?.teamId;
    return tid == null ? [] : (injuriesByTeam.get(tid) ?? []);
  };

  const act = async (
    fn: () => Promise<string | null>,
    opts?: { light?: boolean; resusp?: boolean },
  ): Promise<string | null> => {
    setBusy(true);
    setMessage(null);
    let note: string | null = null;
    try {
      note = await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "操作失败";
      setMessage(msg);
      setBusy(false);
      // 失败不刷新（原来的 if (!ok) return 语义），并把文案交给调用方做就近提示
      return msg;
    }
    setBusy(false);
    // 解锁先行：操作一返回就放行下一次录入，提示即时给出
    if (note) setMessage(note);
    // 后台刷新不阻塞下一次操作：赛程必刷（live 比分在列）；事件增删走轻刷新
    // （跳过整届详情，entries/stages 不因事件改变）；停赛在「影响停赛账本」的操作后
    // 重拉——牌类事件（新 ban）与开赛/终场（live 消耗/落账），进球不必拉
    void refetch();
    if (!opts?.light) void reload();
    setTick((t) => t + 1);
    if (!opts?.light || opts.resusp) setSuspTick((t) => t + 1);
    return null;
  };

  if (matches === null) return <p className="muted card">加载中…</p>;

  // 轮次分页（对齐公开页）：从全量比赛派生轮次 chips，一次只渲染一个轮；孤儿比赛仍走底部「其他比赛」
  const stageById = new Map(detail.stages.map((s) => [s.id, s]));
  const matchesByRoundKey = new Map<string, MatchDTO[]>();
  const stageMaxRound = new Map<number, number>();
  for (const m of matches) {
    if (!stageById.has(m.stageId)) continue;
    const key = `${m.stageId}:${m.round}`;
    const list = matchesByRoundKey.get(key);
    if (list) list.push(m);
    else matchesByRoundKey.set(key, [m]);
    stageMaxRound.set(m.stageId, Math.max(stageMaxRound.get(m.stageId) ?? 0, m.round));
  }
  const stageOrder = new Map(detail.stages.map((s, i) => [s.id, i]));
  const orphan = matches.filter((m) => !stageById.has(m.stageId));
  const roundChips = [...matchesByRoundKey.entries()]
    .map(([key, list]) => {
      const stage = stageById.get(list[0].stageId)!;
      const roundLabel =
        stage.kind === "elim"
          ? elimRoundName(list[0].round, stageMaxRound.get(stage.id) ?? list[0].round)
          : `第 ${list[0].round} 轮`;
      return {
        key,
        stageId: stage.id,
        round: list[0].round,
        stageName: stage.name?.trim() || stageTitle[stage.kind],
        roundLabel,
        live: list.filter((m) => m.status === "live").length,
      };
    })
    .sort(
      (a, b) =>
        (stageOrder.get(a.stageId) ?? 0) - (stageOrder.get(b.stageId) ?? 0) ||
        a.round - b.round,
    );

  // 当前选中轮：点选 > 记住的轮仍存在 > live 轮 > 第一个轮（赛程重建后自动回退，无需 effect）
  const fallbackChip = roundChips.find((c) => c.live > 0) ?? roundChips[0];
  const selRound =
    selRoundRaw && matchesByRoundKey.has(selRoundRaw)
      ? selRoundRaw
      : (fallbackChip?.key ?? null);
  const selMatches = selRound ? (matchesByRoundKey.get(selRound) ?? null) : null;
  const selStage = selMatches ? (stageById.get(selMatches[0].stageId) ?? null) : null;
  const selChip = roundChips.find((c) => c.key === selRound);
  // 其他轮的 live 比赛聚合展示（公开页同款「进行中」区）
  const liveElsewhere = matches.filter(
    (m) =>
      m.status === "live" &&
      stageById.has(m.stageId) &&
      `${m.stageId}:${m.round}` !== selRound,
  );

  const renderRow = (m: MatchDTO, roundList: MatchDTO[] | null) => (
    <MatchRow
      key={m.id}
      match={m}
      tid={detail.tournament.id}
      agg={roundList ? computeAgg(m, roundList) : null}
      entryById={entryById}
      homePlayers={playersOf(m.homeEntryId)}
      awayPlayers={playersOf(m.awayEntryId)}
      playerById={playerById}
      susp={susp}
      suspThreshold={suspCfg?.yellowThreshold ?? 0}
      busy={busy}
      act={act}
      tick={tick}
      injuriesOf={injuriesOf}
      panelOpen={openPanel === m.id}
      togglePanel={() => setOpenPanel(openPanel === m.id ? null : m.id)}
    />
  );

  return (
    <div className="matches-tab">
      {message && <p className="banner">{message}</p>}
      {roundChips.length === 0 && orphan.length === 0 && (
        <p className="muted card">还没有赛程。先到「编排」页生成比赛。</p>
      )}

      {roundChips.length > 0 && (
        <div className="round-tabs">
          {roundChips.map((c) => (
            <button
              key={c.key}
              className={`rt-chip${c.key === selRound ? " rt-active" : ""}`}
              onClick={() => setSelRoundRaw(c.key)}
            >
              {c.live > 0 && <span className="rt-dot" />}
              {c.stageName} · {c.roundLabel}
            </button>
          ))}
        </div>
      )}

      {liveElsewhere.length > 0 && (
        <section className="stage-block">
          <h3 className="stage-head">进行中</h3>
          {liveElsewhere.map((m) =>
            renderRow(m, matchesByRoundKey.get(`${m.stageId}:${m.round}`) ?? null),
          )}
        </section>
      )}

      {selStage && selMatches && selChip && (
        <section key={selStage.id} className="stage-block">
          <h3 className="stage-head">
            {selStage.name?.trim() || stageTitle[selStage.kind]}
          </h3>
          <div className="round-block">
            <h4 className="round-head">{selChip.roundLabel}</h4>
            {selMatches.map((m) => renderRow(m, selMatches))}
          </div>
        </section>
      )}

      {orphan.length > 0 && (
        <section className="stage-block">
          <h3 className="stage-head">其他比赛</h3>
          {orphan.map((m) => renderRow(m, null))}
        </section>
      )}
    </div>
  );
}

// 返回值 = 失败时的文案（成功为 null）。act 自己会把错误放到页顶 banner，但报分/弃权按钮在
// 长列表的某张卡片里，卡片滚出视野时那条 banner 就等于没提示——所以调用方还要拿这个返回值
// 在按钮旁就近再提示一次
type Act = (
  fn: () => Promise<string | null>,
  opts?: { light?: boolean; resusp?: boolean },
) => Promise<string | null>;

function MatchRow({
  match: m,
  tid,
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
  injuriesOf,
  panelOpen,
  togglePanel,
}: {
  match: MatchDTO;
  tid: number;
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
  injuriesOf: (entryId: number | null) => InjuryStatusDTO[];
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
        {m.walkoverSide && <span className="m-badge ms-wo">弃权</span>}
        {m.status === "pending" && (m.homeLineupSubmitted || m.awayLineupSubmitted) && (
          <span className="m-badge">
            阵容 {(m.homeLineupSubmitted ? 1 : 0) + (m.awayLineupSubmitted ? 1 : 0)}/2
          </span>
        )}
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
          tid={tid}
          entryById={entryById}
          homePlayers={homePlayers}
          awayPlayers={awayPlayers}
          playerById={playerById}
          susp={susp}
          suspThreshold={suspThreshold}
          busy={busy}
          act={act}
          tick={tick}
          injuriesOf={injuriesOf}
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
  // 开赛与完赛同样两段式确认：误触开赛后阵容即锁定亮牌，回退要进 console
  const [startArm, setStartArm] = useState(false);
  const startTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (startTimer.current) window.clearTimeout(startTimer.current);
  }, []);
  if (m.status === "pending") {
    return (
      <>
        <button
          className={startArm ? "btn btn-sm btn-danger" : "btn btn-sm"}
          disabled={busy}
          onClick={() => {
            if (!startArm) {
              setStartArm(true);
              if (startTimer.current) window.clearTimeout(startTimer.current);
              startTimer.current = window.setTimeout(() => setStartArm(false), 3000);
              return;
            }
            if (startTimer.current) window.clearTimeout(startTimer.current);
            setStartArm(false);
            void act(async () => {
              await api(`/api/admin/matches/${m.id}/start`, { method: "POST" });
              return null;
            });
          }}
        >
          {startArm ? "再点一次确认开赛" : "开赛"}
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
  tid,
  entryById,
  homePlayers,
  awayPlayers,
  playerById,
  susp,
  suspThreshold,
  busy,
  act,
  tick,
  injuriesOf,
  togglePanel,
}: {
  match: MatchDTO;
  tid: number;
  entryById: Map<number, EntryDTO>;
  homePlayers: PlayerDTO[];
  awayPlayers: PlayerDTO[];
  playerById: Map<number, string>;
  susp: Map<number, SuspensionStatusDTO>;
  suspThreshold: number;
  busy: boolean;
  act: Act;
  tick: number;
  injuriesOf: (entryId: number | null) => InjuryStatusDTO[];
  togglePanel: () => void;
}) {
  const homeName = m.homeTeamName ?? "主队";
  const awayName = m.awayTeamName ?? "客队";
  // 正在编辑的事件（EventList 点「编辑」进入，EventForm 保存/取消退出）
  const [editing, setEditing] = useState<MatchEventDTO | null>(null);

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
              }, { light: true })
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
              }, { light: true })
            }
          >
            {awayName} 进球
          </button>
        </div>
      )}
      {(m.status === "live" || m.status === "finished") && (
        <>
          <p className="muted inj-link-hint">
            这里只记伤病事件；<Link to="/admin/injuries">伤停管理</Link>
            里统一建登记、勾缺阵场次。
          </p>
          <EventForm
            match={m}
            homePlayers={homePlayers}
            awayPlayers={awayPlayers}
            susp={susp}
            suspThreshold={suspThreshold}
            busy={busy}
            act={act}
            editEv={editing}
            onCancelEdit={() => setEditing(null)}
            injuriesOf={injuriesOf}
          />
          <EventList
            matchId={m.id}
            entryById={entryById}
            playerById={playerById}
            busy={busy}
            act={act}
            tick={tick}
            editingId={editing?.id ?? null}
            onEdit={setEditing}
          />
        </>
      )}
      {m.status === "live" && (
        <ScoreForm match={m} busy={busy} act={act} onDone={togglePanel} live />
      )}
      {(m.status === "live" || m.status === "finished") && (
        <AuditPanel tid={tid} matchId={m.id} playerById={playerById} />
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
  // 两击确认防误触：首击进入待确认态，3 秒内再击才真正提交；改动输入即复位。
  // 报分与判弃权各持一个 arm，互不复用——避免报分待确认时点弃权直接提交
  const [arm, setArm] = useState(false);
  const armTimer = useRef<number | null>(null);
  const [woSide, setWoSide] = useState<"" | "home" | "away" | "both">("");
  const [woNote, setWoNote] = useState("");
  const [woWinner, setWoWinner] = useState<"" | "home" | "away">("");
  const [woArm, setWoArm] = useState(false);
  const woTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (armTimer.current) window.clearTimeout(armTimer.current);
      if (woTimer.current) window.clearTimeout(woTimer.current);
    };
  }, []);

  const change = (
    setter: (v: string) => void
  ) =>
    (v: string) => {
      setter(v);
      setArm(false);
      setWoArm(false);
      if (armTimer.current) window.clearTimeout(armTimer.current);
      if (woTimer.current) window.clearTimeout(woTimer.current);
    };

  const armBoth = () => {
    setArm(false);
    if (armTimer.current) window.clearTimeout(armTimer.current);
    setWoArm(true);
    if (woTimer.current) window.clearTimeout(woTimer.current);
    woTimer.current = window.setTimeout(() => setWoArm(false), 3000);
  };

  const submitWo = () => {
    if (!woSide) return;
    if (!woArm) {
      armBoth();
      return;
    }
    setWoArm(false);
    if (woTimer.current) window.clearTimeout(woTimer.current);
    act(async () => {
      setErr(null);
      // 淘汰赛双弃权必须指定晋级方（两回合对局晋级由总比分/点球决定，后端不收）
      const needWinner = m.stageKind === "elim" && m.leg == null && woSide === "both";
      if (needWinner && !woWinner) throw new Error("请先选择晋级方");
      const b = await api<{ ok: boolean; regenerated?: boolean }>(
        `/api/admin/matches/${m.id}/finish`,
        {
          method: "POST",
          body: {
            walkoverSide: woSide,
            ...(woNote.trim() ? { walkoverNote: woNote.trim() } : {}),
            ...(needWinner && woWinner
              ? { winnerEntryId: woWinner === "home" ? m.homeEntryId : m.awayEntryId }
              : {}),
          },
        },
      );
      onDone();
      return b.regenerated ? "淘汰赛对阵已自动生成" : null;
    }).then((msg) => setErr(msg));
  };

  const submit = () => {
    if (!arm) {
      setArm(true);
      setWoArm(false);
      if (armTimer.current) window.clearTimeout(armTimer.current);
      if (woTimer.current) window.clearTimeout(woTimer.current);
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
    }).then((msg) => setErr(msg));
  };

  const equal = sh !== "" && sa !== "" && Number(sh) === Number(sa);

  // 弃权三选一 / 晋级方二选一（值是受限联合，不走 change 的 string setter）
  const changeWo = (v: "" | "home" | "away" | "both") => {
    setWoSide(v);
    setWoWinner("");
    setArm(false);
    setWoArm(false);
    if (armTimer.current) window.clearTimeout(armTimer.current);
    if (woTimer.current) window.clearTimeout(woTimer.current);
  };
  const changeWinner = (v: "" | "home" | "away") => {
    setWoWinner(v);
    setWoArm(false);
    if (woTimer.current) window.clearTimeout(woTimer.current);
  };

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
          disabled={!!woSide}
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
          disabled={!!woSide}
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
          disabled={!!woSide}
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
          disabled={!!woSide}
          onChange={(e) => change(setPa)(e.target.value)}
          placeholder="客"
          style={{ width: "4.5em" }}
        />
      </label>
      <div className="wo-block">
        <div className="ev-side-seg" role="group" aria-label="判弃权">
          <button type="button" aria-pressed={woSide === "home"} onClick={() => changeWo("home")}>
            {m.homeTeamName ?? "主队"} 弃权
          </button>
          <button type="button" aria-pressed={woSide === "away"} onClick={() => changeWo("away")}>
            {m.awayTeamName ?? "客队"} 弃权
          </button>
          <button type="button" aria-pressed={woSide === "both"} onClick={() => changeWo("both")}>
            双方弃权
          </button>
        </div>
        {woSide !== "" && (
          <>
            <input
              className="input"
              value={woNote}
              maxLength={50}
              placeholder="备注（选填，公开显示）"
              onChange={(e) => change(setWoNote)(e.target.value)}
            />
            {woSide === "both" && m.stageKind === "elim" && m.leg == null && (
              <div className="ev-side-seg" role="group" aria-label="晋级方">
                <button
                  type="button"
                  aria-pressed={woWinner === "home"}
                  onClick={() => changeWinner("home")}
                >
                  {m.homeTeamName ?? "主队"} 晋级
                </button>
                <button
                  type="button"
                  aria-pressed={woWinner === "away"}
                  onClick={() => changeWinner("away")}
                >
                  {m.awayTeamName ?? "客队"} 晋级
                </button>
              </div>
            )}
            <span className="muted">
              {woSide === "both"
                ? "记 0:0，双方各算一场负（淘汰赛需指定晋级方）"
                : "记 0:3，对方胜出；弃权方停赛不消耗，对方照常消耗"}
            </span>
            <button
              className={woArm ? "btn btn-sm btn-danger" : "btn btn-sm"}
              type="button"
              disabled={busy}
              onClick={submitWo}
            >
              {woArm ? "再点一次确认弃权" : "判弃权并完赛"}
            </button>
          </>
        )}
      </div>
      <button
        className={arm ? "btn btn-sm btn-danger" : "btn btn-sm"}
        type="submit"
        disabled={busy || !!woSide}
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

// 改动记录（audit_log）：live/finished 场可展开查看本场的开赛/报分/改判/弃权/事件增删留痕
const AUDIT_ACTION: Record<string, string> = {
  match_start: "开赛",
  match_finish: "终场报分",
  match_rescore: "改判",
  match_walkover: "判弃权",
  event_create: "录事件",
  event_update: "改事件",
  event_delete: "删事件",
};

function auditScoreText(d: {
  scoreHome?: number | null;
  scoreAway?: number | null;
  penHome?: number | null;
  penAway?: number | null;
  walkoverSide?: string | null;
}): string {
  const base = `${d.scoreHome ?? 0}:${d.scoreAway ?? 0}`;
  const pen =
    d.penHome != null && d.penAway != null ? `（点球 ${d.penHome}:${d.penAway}）` : "";
  return d.walkoverSide ? `${base}（弃权）` : `${base}${pen}`;
}

// audit_log.created_at 是 UTC ISO，列表里按本地时区显示到分
const fmtAuditTime = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(5, 16).replace("T", " ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function AuditPanel({
  tid,
  matchId,
  playerById,
}: {
  tid: number;
  matchId: number;
  playerById: Map<number, string>;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<AuditEntryDTO[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open || rows) return;
    let on = true;
    api<{ entries: AuditEntryDTO[] }>(
      `/api/admin/tournaments/${tid}/audit?matchId=${matchId}`,
    )
      .then((b) => {
        if (on) setRows(b.entries);
      })
      .catch((e: unknown) => {
        if (!on) return;
        // 空列表会被读成「本场没改过」，所以失败要标出来
        setRows([]);
        setLoadErr(e instanceof Error ? e.message : "加载失败");
      });
    return () => {
      on = false;
    };
  }, [open, rows, tid, matchId]);

  if (!open)
    return (
      <button className="btn btn-sm" onClick={() => setOpen(true)}>
        改动记录
      </button>
    );

  const line = (a: AuditEntryDTO): string => {
    let d: Record<string, unknown> | null = null;
    try {
      d = a.detailJson ? (JSON.parse(a.detailJson) as Record<string, unknown>) : null;
    } catch {
      d = null;
    }
    if (!d) return "";
    const pname = (id: unknown) =>
      typeof id === "number" ? (playerById.get(id) ?? `#${id}`) : "";
    if (a.action === "event_update") {
      const o = (d.before ?? {}) as Record<string, unknown>;
      const n = (d.after ?? {}) as Record<string, unknown>;
      const fmt = (x: Record<string, unknown>) => {
        const label = EVENT_NAME[x.type as MatchEventType] ?? ((x.type as string) ?? "");
        const who = pname(x.playerId);
        const min = x.minute != null ? ` ${x.minute}'` : "";
        return `${label}${who ? ` ${who}` : ""}${min}`;
      };
      return `${fmt(o)} → ${fmt(n)}`;
    }
    if (a.action === "event_create" || a.action === "event_delete") {
      const label = EVENT_NAME[d.type as MatchEventType] ?? ((d.type as string) ?? "");
      const who = pname(d.playerId);
      const min = d.minute != null ? ` ${d.minute}'` : "";
      const extra = d.red2y ? "（第 2 黄自动转红）" : "";
      return `${label}${who ? ` ${who}` : ""}${min}${extra}`;
    }
    if (a.action === "match_start") return "";
    const o = (d.old ?? {}) as Record<string, unknown>;
    const n = (d.new ?? {}) as Record<string, unknown>;
    const from =
      o.status === "pending"
        ? "未开打"
        : auditScoreText(o as Parameters<typeof auditScoreText>[0]);
    const to = auditScoreText(n as Parameters<typeof auditScoreText>[0]);
    const note = typeof n.note === "string" && n.note ? `（${n.note}）` : "";
    return `${from} → ${to}${note}`;
  };

  return (
    <div className="audit-block">
      <button className="btn btn-sm" onClick={() => setOpen(false)}>
        收起记录
      </button>
      {rows === null && <p className="muted">加载中…</p>}
      {loadErr && <p className="error-msg">改动记录加载失败：{loadErr}</p>}
      {rows !== null && rows.length === 0 && !loadErr && (
        <p className="muted">本场还没有改动记录。</p>
      )}
      {rows !== null && rows.length > 0 && (
        <ul className="audit-list">
          {rows.map((a) => (
            <li key={a.id}>
              <span className="audit-time">{fmtAuditTime(a.createdAt)}</span>
              <span className="audit-actor">{a.actorName ?? "—"}</span>
              <span className="audit-action">{AUDIT_ACTION[a.action] ?? a.action}</span>
              <span className="audit-detail">{line(a)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
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
  editEv,
  onCancelEdit,
  injuriesOf,
}: {
  match: MatchDTO;
  homePlayers: PlayerDTO[];
  awayPlayers: PlayerDTO[];
  susp: Map<number, SuspensionStatusDTO>;
  suspThreshold: number;
  busy: boolean;
  act: Act;
  editEv: MatchEventDTO | null;
  onCancelEdit: () => void;
  injuriesOf: (entryId: number | null) => InjuryStatusDTO[];
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

  // 进入编辑态：按事件回填（red_2y 不给编辑入口，这里兜底映射成 red 防御）
  useEffect(() => {
    if (!editEv) return;
    setSide(editEv.entryId === m.homeEntryId ? "home" : "away");
    setType(editEv.type === "red_2y" ? "red" : editEv.type);
    setPlayerId(editEv.playerId != null ? String(editEv.playerId) : "");
    setAssistId(editEv.assistPlayerId != null ? String(editEv.assistPlayerId) : "");
    setMinute(editEv.minute != null ? String(editEv.minute) : "");
  }, [editEv, m.homeEntryId]);

  const clearForm = () => {
    setType("goal");
    setSide("home");
    setPlayerId("");
    setAssistId("");
    setMinute("");
  };
  const exitEdit = () => {
    clearForm();
    onCancelEdit();
  };

  // 软约束提示：选中停赛球员给红色警告，逼近黄牌阈值给黄色预警（都不拦截录入）
  const sel = playerId !== "" ? susp.get(Number(playerId)) : undefined;
  const suspWarn = sel && sel.remaining > 0;
  const yellowWarn =
    sel && !suspWarn && suspThreshold > 0 && sel.yellows === suspThreshold - 1;

  // 伤停中 = 勾了缺阵场且还有没打完的（已伤愈的登记不再提示）
  const sideInjuries = injuriesOf(side === "home" ? m.homeEntryId : m.awayEntryId).filter(
    (i) => i.misses.some((x) => x.status !== "finished"),
  );
  const selInj =
    playerId === ""
      ? undefined
      : sideInjuries.find((i) => i.playerId === Number(playerId));
  const injRest = selInj
    ? selInj.misses.filter((x) => x.status !== "finished").length
    : 0;

  // 下拉选项文本：停赛球员与临界黄牌球员加后缀（option 是纯文本，用符号标记）
  const optionSuffix = (pid: number): string => {
    const s = susp.get(pid);
    const inj = sideInjuries.find((i) => i.playerId === pid);
    const injSuffix = inj
      ? `（🩹伤停 剩${inj.misses.filter((x) => x.status !== "finished").length}场）`
      : "";
    if (!s) return injSuffix;
    if (s.remaining > 0) return `（⛔停赛 剩${s.remaining}场）${injSuffix}`;
    if (suspThreshold > 0 && s.yellows === suspThreshold - 1)
      return `（⚠️再${suspThreshold - s.yellows}黄停赛）${injSuffix}`;
    return injSuffix;
  };

  return (
    <>
      <form
        className={editEv ? "inline-form event-form editing" : "inline-form event-form"}
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
            }>(
              editEv
                ? `/api/admin/matches/${m.id}/events/${editEv.id}`
                : `/api/admin/matches/${m.id}/events`,
              {
                method: editEv ? "PUT" : "POST",
                body: {
                  type,
                  entryId,
                  playerId: playerId === "" ? undefined : Number(playerId),
                  assistPlayerId:
                    goalish && assistId !== "" ? Number(assistId) : undefined,
                  minute: minute === "" ? undefined : Number(minute),
                },
              },
            );
            if (editEv) exitEdit();
            return [b.notice, b.warning].filter(Boolean).join("；") || null;
          }, {
            light: true,
            // 编辑时新旧类型任一是牌类都可能改变停赛账本，都要重拉停赛数据
            resusp:
              type === "yellow" ||
              type === "red" ||
              editEv?.type === "yellow" ||
              editEv?.type === "red" ||
              editEv?.type === "red_2y",
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
        <div className="ev-tail">
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
            {editEv ? (busy ? "保存中…" : "保存修改") : busy ? "记录中…" : "记录事件"}
          </button>
          {editEv && (
            <button className="btn btn-sm" type="button" disabled={busy} onClick={exitEdit}>
              取消
            </button>
          )}
        </div>
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
        {selInj && (
          <span className="warn-line injury-warn">
            ⚠ {selInj.playerName} 伤停中（{selInj.injuryName ?? "伤情未登记"}，还有 {injRest}{" "}
            场缺阵未走完，伤愈进度 {selInj.recoverPercent}%）——软约束不拦截，请确认该球员是否合规出场
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
  editingId,
  onEdit,
}: {
  matchId: number;
  entryById: Map<number, EntryDTO>;
  playerById: Map<number, string>;
  busy: boolean;
  act: Act;
  tick: number;
  editingId: number | null;
  onEdit: (ev: MatchEventDTO | null) => void;
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
        const isInjury = ev.type === "injury_minor" || ev.type === "injury_major";
        return (
          <li key={ev.id}>
            <div className="ev-line">
            <EventDot type={ev.type} />
            {ev.minute !== null && <span className="ev-minute">{ev.minute}′</span>}
            <span>{EVENT_NAME[ev.type]}</span>
            {who && <span className="ev-player">{who}</span>}
            {assist && <span className="ev-assist">（助攻 {assist}）</span>}
            <span className="ev-team">{name}</span>
            {isInjury && ev.playerId == null && (
              <span className="warn-line yellow-warn">未记球员，登记伤停前先补上球员</span>
            )}
            {ev.type !== "red_2y" && (
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={() => onEdit(ev)}
              >
                编辑
              </button>
            )}
            <button
              className="btn btn-sm btn-danger"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await api(`/api/admin/matches/${matchId}/events/${ev.id}`, {
                    method: "DELETE",
                  });
                  // 删的就是正在编辑的事件时，退出编辑态避免表单挂着已不存在的事件
                  if (ev.id === editingId) onEdit(null);
                  return null;
                }, {
                  light: true,
                  resusp: ev.type === "yellow" || ev.type === "red" || ev.type === "red_2y",
                })
              }
            >
              删除
            </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// 管理端：双方提交的战术阵容（赛前备案可见；公开端开赛后才显示）
function LineupPanel({ matchId }: { matchId: number }) {
  const [data, setData] = useState<AdminMatchLineupDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    api<AdminMatchLineupDTO>(`/api/admin/matches/${matchId}/lineup`)
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
        <LineupGrid home={data.home} away={data.away} homeCode={data.homeCode} awayCode={data.awayCode} />
      ) : (
        <p className="muted">双方都还没提交阵容（教练在战术板 → 提交阵容）。</p>
      )}
    </div>
  );
}
