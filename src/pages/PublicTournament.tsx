import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { api } from "../api";
import { FORMAT_LABEL, STATUS_LABEL } from "../labels";
import { StandingsTables } from "./StandingsTab";
import { elimRoundName, stageTitle } from "./MatchesTab";
import { MatchScore, computeAgg } from "../components/MatchScore";
import { EventTimeline } from "../components/EventTimeline";
import { TeamLogo } from "../components/TeamLogo";
import { Toplists } from "../components/Toplists";
import { StatsDashboard } from "../components/StatsDashboard";
import { ShareButton } from "../components/ShareButton";
import { drawTournamentCard, drawRoundCard, matchToShare } from "../lib/share";
import type {
  EntryDTO,
  MatchDTO,
  MatchSummaryDTO,
  RoundMetaDTO,
  StageRoundsDTO,
  StageStandingDTO,
  TournamentDetailDTO,
} from "../../shared/types";

// 公开赛事页：赛程对阵 / 积分榜 / 参赛球队，无登录墙。
// 赛程按轮分页：一轮只在切换时加载一次，live 时每 30 秒刷新；无进行中比赛则完全不轮询。
const roundKey = (s: { stageId: number; round: number }) => `${s.stageId}:${s.round}`;
type RoundChip = RoundMetaDTO & { stageId: number; stage: StageRoundsDTO };
const flatRounds = (stages: StageRoundsDTO[]): RoundChip[] =>
  stages.flatMap((st) => st.rounds.map((r) => ({ ...r, stageId: st.stageId, stage: st })));

export default function PublicTournament() {
  const { id } = useParams();
  const tid = Number(id);
  const [detail, setDetail] = useState<TournamentDetailDTO | null>(null);
  const [meta, setMeta] = useState<StageRoundsDTO[] | null>(null);
  const [summary, setSummary] = useState<MatchSummaryDTO | null>(null);
  const [roundCache, setRoundCache] = useState<Map<string, MatchDTO[]>>(new Map());
  const [sel, setSel] = useState<{ stageId: number; round: number } | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  type PubTab = "schedule" | "standings" | "teams" | "toplists" | "stats";
  const TAB_KEYS: PubTab[] = ["schedule", "standings", "teams", "toplists", "stats"];
  const [tab, setTabState] = useState<PubTab>(() => {
    const t = searchParams.get("tab");
    return TAB_KEYS.includes(t as PubTab) ? (t as PubTab) : "schedule";
  });
  const setTab = (t: PubTab) => {
    setTabState(t);
    setSearchParams(t === "schedule" ? {} : { tab: t }, { replace: true });
  };
  const [err, setErr] = useState<string | null>(null);
  // 切轮次时页面内容会先清空再填充（未缓存轮次要现拉），高度塌缩会把滚动位置挤到顶上；
  // 记下点击时的滚动位置，等新轮数据渲染完成后恢复。
  const lockScrollY = useRef<number | null>(null);
  const pickRound = (c: RoundChip) => {
    lockScrollY.current = window.scrollY;
    setSel({ stageId: c.stageId, round: c.round });
  };
  useLayoutEffect(() => {
    if (lockScrollY.current == null || !sel) return;
    if (!roundCache.has(roundKey(sel))) return;
    window.scrollTo({ top: lockScrollY.current });
    lockScrollY.current = null;
  }, [sel, roundCache]);

  const refresh = useCallback(async () => {
    try {
      const [d, m, s] = await Promise.all([
        api<TournamentDetailDTO>(`/api/public/tournaments/${tid}`),
        api<{ stages: StageRoundsDTO[] }>(`/api/public/tournaments/${tid}/matches/rounds`),
        api<MatchSummaryDTO>(`/api/public/tournaments/${tid}/matches/summary`),
      ]);
      setDetail(d);
      setMeta(m.stages);
      setSummary(s);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
    }
  }, [tid]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // meta 到位后定默认轮：live 轮 > 最早含未完赛的轮 > 全完赛时最大轮（只定一次，之后尊重用户选择）
  useEffect(() => {
    if (!meta || sel) return;
    const chips = flatRounds(meta);
    const liveChip = chips.find((c) => c.live > 0);
    const pendingChip = chips.find((c) => c.pending > 0);
    const target = liveChip ?? pendingChip ?? chips[chips.length - 1];
    if (target) setSel({ stageId: target.stageId, round: target.round });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta]);

  // 按需拉取：当前选中的轮 + 有 live 的轮，进缓存
  useEffect(() => {
    if (!meta) return;
    const need: { stageId: number; round: number }[] = [];
    if (sel && !roundCache.has(roundKey(sel))) need.push(sel);
    for (const c of flatRounds(meta))
      if (c.live > 0 && !roundCache.has(roundKey(c)))
        need.push({ stageId: c.stageId, round: c.round });
    if (need.length === 0) return;
    let alive = true;
    void (async () => {
      const fetched = await Promise.all(
        need.map(async ({ stageId, round }) => {
          const b = await api<{ matches: MatchDTO[] }>(
            `/api/public/tournaments/${tid}/matches?stageId=${stageId}&round=${round}`,
          );
          return [roundKey({ stageId, round }), b.matches] as const;
        }),
      );
      if (!alive) return;
      setRoundCache((prev) => {
        const next = new Map(prev);
        for (const [k, ms] of fetched) next.set(k, ms);
        return next;
      });
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [meta, sel, roundCache, tid]);

  // 预加载其余轮次：进入页面后错开间隔逐轮拉取，之后切任何轮都是秒开，不用现等
  useEffect(() => {
    if (!meta) return;
    const next = flatRounds(meta).find((c) => !roundCache.has(roundKey(c)));
    if (!next) return;
    const timer = window.setTimeout(() => {
      void api<{ matches: MatchDTO[] }>(
        `/api/public/tournaments/${tid}/matches?stageId=${next.stageId}&round=${next.round}`,
      )
        .then((b) =>
          setRoundCache((prev) =>
            prev.has(roundKey(next)) ? prev : new Map(prev).set(roundKey(next), b.matches),
          ),
        )
        .catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [meta, roundCache, tid]);

  const hasLive = !!meta?.some((st) => st.rounds.some((r) => r.live > 0));

  // 30s 轮询：只有存在进行中比赛时才启动；页面不可见时暂停，回来立刻刷一次
  useEffect(() => {
    if (!hasLive) return;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        await refresh();
        const targets = new Set<string>();
        if (sel) targets.add(roundKey(sel));
        for (const c of flatRounds(meta ?? [])) if (c.live > 0) targets.add(roundKey(c));
        for (const t of targets) {
          const [sid, rd] = t.split(":").map(Number);
          const b = await api<{ matches: MatchDTO[] }>(
            `/api/public/tournaments/${tid}/matches?stageId=${sid}&round=${rd}`,
          );
          setRoundCache((prev) => new Map(prev).set(t, b.matches));
        }
      } catch {
        // 单次轮询失败静默，下一轮再试
      }
    };
    const iv = setInterval(() => void tick(), 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hasLive, refresh, sel, meta, tid]);

  if (err)
    return (
      <>
        <main className="container">
        <p className="error-msg">{err}</p>
        <Link to="/">← 返回赛事列表</Link>
        </main>
      </>
    );
  if (!detail || meta === null || summary === null)
    return (
      <>
        <main className="container">
          <p className="muted">加载中…</p>
        </main>
      </>
    );

  const t = detail.tournament;
  const chips = flatRounds(meta);
  const stageDisplayName = (st: StageRoundsDTO) => st.name || stageTitle[st.kind];
  const roundLabel = (c: RoundChip) =>
    c.stage.kind === "elim"
      ? elimRoundName(c.round, Math.max(...c.stage.rounds.map((r) => r.round)))
      : `第 ${c.round} 轮`;
  const entriesByGroup = new Map<number, EntryDTO[]>();
  for (const e of detail.entries) {
    const k = e.groupId ?? -1;
    if (!entriesByGroup.has(k)) entriesByGroup.set(k, []);
    entriesByGroup.get(k)!.push(e);
  }
  const groupName = new Map(
    detail.groups.map((g) => [g.id, g.name] as const),
  );

  const origin = window.location.origin;
  // 分享卡对阵区：有完赛展示最近赛果，否则展示对阵预告（summary 端点数据）
  const shareMatchList = (
    summary.recent.length > 0 ? summary.recent : summary.upcoming
  ).map(matchToShare);
  const shareResultLabel = summary.recent.length > 0 ? "最近赛果" : "对阵预告";

  const selChip = sel ? chips.find((c) => roundKey(c) === roundKey(sel)) : undefined;
  const selRows = sel ? (roundCache.get(roundKey(sel)) ?? []) : [];
  const liveElsewhere = chips.filter(
    (c) => c.live > 0 && (!sel || roundKey(c) !== roundKey(sel)),
  );

  return (
    <>
      <main className="container">
      <p className="crumb">
        <Link to="/">← 赛事列表</Link>
      </p>
      {t.coverUrl && (
        <div className="cover-banner">
          <img src={t.coverUrl} alt={`${t.name} 封面`} />
        </div>
      )}
      <header className="pub-head">
        <h1>{t.name}</h1>
        <span className="pub-head-side">
          <span className={`status-badge st-${t.status}`}>{STATUS_LABEL[t.status]}</span>
          <ShareButton
            title={`分享「${t.name}」`}
            url={`${origin}/t/${tid}`}
            draw={(c) =>
              drawTournamentCard(c, {
                name: t.name,
                subtitle: `${STATUS_LABEL[t.status]} · ${FORMAT_LABEL[t.format]} · ${t.entryCount} 支球队`,
                coverUrl: t.coverUrl ?? null,
                resultLabel: shareResultLabel,
                matches: shareMatchList,
                url: `${origin}/t/${tid}`,
              })
            }
          />
        </span>
      </header>
      <p className="muted">
        {FORMAT_LABEL[t.format]} · {t.entryCount} 支球队
        {t.description ? ` · ${t.description}` : ""}
      </p>

      <nav className="tabs">
        {(
          [
            ["schedule", "赛程"],
            ["standings", "积分榜"],
            ["teams", "参赛球队"],
            ["toplists", "榜单"],
            ["stats", "数据"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            className={`tab${tab === key ? " tab-active" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "schedule" && (
        <div className="matches-tab">
          {chips.length === 0 && (
            <p className="muted card">赛程还没排出来，排好后会显示在这里。</p>
          )}
          {chips.length > 0 && (
            <div className="round-tabs">
              {chips.map((c) => (
                <button
                  key={roundKey(c)}
                  className={`rt-chip${sel && roundKey(sel) === roundKey(c) ? " rt-active" : ""}${c.live > 0 ? " rt-live" : ""}`}
                  onClick={() => pickRound(c)}
                >
                  {c.live > 0 && <span className="rt-dot" aria-hidden />}
                  {stageDisplayName(c.stage)} · {roundLabel(c)}
                </button>
              ))}
            </div>
          )}
          {liveElsewhere.length > 0 && (
            <section className="stage-block">
              <h3 className="stage-head stage-head-live">
                进行中 <span className="live-dot" aria-hidden />
              </h3>
              {liveElsewhere.map((c) =>
                (roundCache.get(roundKey(c)) ?? [])
                  .filter((m) => m.status === "live")
                  .map((m) => (
                    <PublicMatchRow key={m.id} tid={tid} match={m} agg={null} />
                  )),
              )}
            </section>
          )}
          {selChip && (
            <section className="stage-block">
              <h3 className="stage-head">{stageDisplayName(selChip.stage)}</h3>
              <div className="round-block">
                <h4 className="round-head">
                  <span>{roundLabel(selChip)}</span>
                  <ShareButton
                    title={`分享「${roundLabel(selChip)}」`}
                    url={`${origin}/t/${tid}?tab=schedule`}
                    draw={(c) =>
                      drawRoundCard(c, {
                        tournamentName: t.name,
                        title: roundLabel(selChip),
                        coverUrl: t.coverUrl ?? null,
                        matches: selRows.map(matchToShare),
                        url: `${origin}/t/${tid}?tab=schedule`,
                      })
                    }
                  />
                </h4>
                {selRows.map((m) => (
                  <PublicMatchRow
                    key={m.id}
                    tid={tid}
                    match={m}
                    agg={computeAgg(m, selRows)}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {tab === "standings" && (
        <PublicStandings tid={tid} tournamentName={t.name} coverUrl={t.coverUrl ?? null} />
      )}

      {tab === "teams" &&
        (detail.entries.length === 0 ? (
          <p className="muted card">还没有球队报名。</p>
        ) : (
          <div className="teams-public">
            {[...entriesByGroup.keys()]
              .sort((a, b) => a - b)
              .map((k) => (
                <section key={k} className="stage-block">
                  {k !== -1 && <h3 className="stage-head">{groupName.get(k) ?? ""} 组</h3>}
                  <ul className="team-list">
                    {entriesByGroup.get(k)!.map((e) => (
                      <li key={e.id}>
                        <span className="team-seed">#{e.seed}</span>
                        <span className="cell-with-logo">
                          <TeamLogo name={e.teamName} url={e.teamLogoUrl} size={22} />
                          {e.teamName}
                        </span>
                        <span className="muted">（{e.playerCount} 名球员）</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
          </div>
        ))}
      {tab === "toplists" && (
        <Toplists
          tid={tid}
          base="/api/public"
          share={{ tournamentName: t.name, url: `${origin}/t/${tid}?tab=toplists`, coverUrl: t.coverUrl ?? null }}
        />
      )}
      {tab === "stats" && <StatsDashboard tid={tid} base="/api/public" />}
      </main>
    </>
  );
}

function PublicMatchRow({
  tid,
  match: m,
  agg,
}: {
  tid: number;
  match: MatchDTO;
  agg: [number, number] | null;
}) {
  return (
    <div className={`match-row mr-${m.status}`}>
      <Link to={`/t/${tid}/match/${m.id}`} className="mr-link">
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
          {m.status === "live" && <span className="m-badge ms-live">进行中</span>}
        </div>
      </Link>
      <EventTimeline events={m.events ?? []} />
    </div>
  );
}

function PublicStandings({
  tid,
  tournamentName,
  coverUrl,
}: {
  tid: number;
  tournamentName: string;
  coverUrl: string | null;
}) {
  const [standings, setStandings] = useState<StageStandingDTO[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ standings: StageStandingDTO[] }>(`/api/public/tournaments/${tid}/standings`)
      .then((b) => setStandings(b.standings))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "加载积分榜失败"));
  }, [tid]);

  if (err) return <p className="error-msg">{err}</p>;
  if (standings === null) return <p className="muted card">加载中…</p>;
  if (standings.length === 0)
    return <p className="muted card">积分榜尚未产生。比赛开打后这里会显示排名。</p>;
  return (
    <StandingsTables
      standings={standings}
      share={{
        tournamentName,
        url: `${window.location.origin}/t/${tid}?tab=standings`,
        coverUrl,
      }}
    />
  );
}
