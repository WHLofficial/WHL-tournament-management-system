import { useCallback, useEffect, useState } from "react";
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
import type {
  EntryDTO,
  MatchDTO,
  StageStandingDTO,
  TournamentDetailDTO,
} from "../../shared/types";

// 公开赛事页：赛程对阵 / 积分榜 / 参赛球队，无登录墙，30 秒轮询。
export default function PublicTournament() {
  const { id } = useParams();
  const tid = Number(id);
  const [detail, setDetail] = useState<TournamentDetailDTO | null>(null);
  const [matches, setMatches] = useState<MatchDTO[] | null>(null);
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

  const refetch = useCallback(async () => {
    try {
      const [d, m] = await Promise.all([
        api<TournamentDetailDTO>(`/api/public/tournaments/${tid}`),
        api<{ matches: MatchDTO[] }>(`/api/public/tournaments/${tid}/matches`),
      ]);
      setDetail(d);
      setMatches(m.matches);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
    }
  }, [tid]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // 30s 轮询：页面不可见时暂停，回来立刻刷一次
  useEffect(() => {
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") void refetch();
    }, 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refetch]);

  if (err)
    return (
      <>
        <main className="container">
        <p className="error-msg">{err}</p>
        <Link to="/">← 返回赛事列表</Link>
        </main>
      </>
    );
  if (!detail || matches === null)
    return (
      <>
        <main className="container">
          <p className="muted">加载中…</p>
        </main>
      </>
    );

  const t = detail.tournament;
  const stagesWithMatches = detail.stages.filter((s) =>
    matches.some((m) => m.stageId === s.id),
  );
  const entriesByGroup = new Map<number, EntryDTO[]>();
  for (const e of detail.entries) {
    const k = e.groupId ?? -1;
    if (!entriesByGroup.has(k)) entriesByGroup.set(k, []);
    entriesByGroup.get(k)!.push(e);
  }
  const groupName = new Map(
    detail.groups.map((g) => [g.id, g.name] as const),
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
        <span className={`status-badge st-${t.status}`}>{STATUS_LABEL[t.status]}</span>
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
          {stagesWithMatches.length === 0 && (
            <p className="muted card">赛程还没排出来，排好后会显示在这里。</p>
          )}
          {matches.some((m) => m.status === "live") && (
            <section className="stage-block">
              <h3 className="stage-head stage-head-live">
                进行中 <span className="live-dot" aria-hidden />
              </h3>
              {matches
                .filter((m) => m.status === "live")
                .map((m) => (
                  <PublicMatchRow
                    key={m.id}
                    tid={tid}
                    match={m}
                    agg={null}
                  />
                ))}
            </section>
          )}
          {stagesWithMatches.map((stage) => {
            const list = matches.filter((m) => m.stageId === stage.id && m.status !== "live");
            const rounds = [...new Set(list.map((m) => m.round))].sort((a, b) => a - b);
            return (
              <section key={stage.id} className="stage-block">
                <h3 className="stage-head">{stageTitle[stage.kind]}</h3>
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
                        <PublicMatchRow
                          key={m.id}
                          tid={tid}
                          match={m}
                          agg={computeAgg(m, roundList)}
                        />
                      ))}
                    </div>
                  );
                })}
              </section>
            );
          })}
          {matches.filter((m) => !detail.stages.some((s) => s.id === m.stageId) && m.status !== "live").length > 0 && (
            <section className="stage-block">
              <h3 className="stage-head">其他比赛</h3>
              {matches
                .filter((m) => !detail.stages.some((s) => s.id === m.stageId) && m.status !== "live")
                .map((m) => (
                  <PublicMatchRow key={m.id} tid={tid} match={m} agg={null} />
                ))}
            </section>
          )}
        </div>
      )}

      {tab === "standings" && <PublicStandings tid={tid} />}

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
      {tab === "toplists" && <Toplists tid={tid} base="/api/public" />}
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

function PublicStandings({ tid }: { tid: number }) {
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
  return <StandingsTables standings={standings} />;
}
