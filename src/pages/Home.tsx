import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { FORMAT_LABEL, STATUS_LABEL } from "../labels";
import { EventTimeline } from "../components/EventTimeline";
import type {
  LiveDTO,
  RecentDTO,
  TournamentDTO,
  UpcomingDTO,
} from "../../shared/types";

// 登录后首页：所有非草稿赛事 + 跨赛事"即将进行"。未登录会被 RequireRole 踢到登录页；/t/:id 单赛事页仍公开。
export function Home() {
  const [list, setList] = useState<TournamentDTO[] | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingDTO[] | null>(null);
  const [recent, setRecent] = useState<RecentDTO[] | null>(null);
  const [liveList, setLiveList] = useState<LiveDTO[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, u, r, l] = await Promise.all([
        api<{ tournaments: TournamentDTO[] }>("/api/public/tournaments"),
        api<{ upcoming: UpcomingDTO[] }>("/api/public/upcoming"),
        api<{ recent: RecentDTO[] }>("/api/public/recent"),
        api<{ live: LiveDTO[] }>("/api/public/live"),
      ]);
      setList(b.tournaments);
      setUpcoming(u.upcoming);
      setRecent(r.recent);
      setLiveList(l.live);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, 30000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <>
      <main className="container">
      <h1>WHL 赛事</h1>
      {err && <p className="error-msg">{err}</p>}
      {list === null && !err && <p className="muted">加载中…</p>}
      {list !== null && list.length === 0 && (
        <p className="muted card">还没有赛事。管理员登录后可以创建。</p>
      )}
      <div className="home-list">
        {list?.map((t) => (
          <Link to={`/t/${t.id}`} key={t.id} className="home-card">
            {t.coverUrl && (
              <img className="home-card-cover" src={t.coverUrl} alt={`${t.name} 封面`} />
            )}
            <div className="home-card-head">
              <strong>{t.name}</strong>
              <span className={`status-badge st-${t.status}`}>{STATUS_LABEL[t.status]}</span>
            </div>
            {t.description && <p className="home-card-desc">{t.description}</p>}
            <p className="home-card-meta">
              {FORMAT_LABEL[t.format]} · {t.entryCount} 支球队
            </p>
          </Link>
        ))}
      </div>
      {liveList !== null && liveList.length > 0 && (
        <section className="upcoming">
          <h2>
            进行中 <span className="live-dot" aria-hidden />
          </h2>
          <div className="up-list">
            {liveList.map((v) => (
              <Link
                key={v.matchId}
                to={`/t/${v.tournamentId}/match/${v.matchId}`}
                className="up-card up-live"
              >
                <span className="up-meta">
                  {v.tournamentName} · {v.stageKind === "elim" ? "淘汰赛" : v.stageKind === "group" ? "小组赛" : "循环赛"} 第{v.round}轮
                </span>
                <span className="up-teams">
                  {v.homeTeamName}{" "}
                  <span className="up-score up-score-live">
                    {v.scoreHome}:{v.scoreAway}
                  </span>{" "}
                  {v.awayTeamName}
                </span>
                <EventTimeline events={v.events} />
              </Link>
            ))}
          </div>
        </section>
      )}
      {upcoming !== null && upcoming.length > 0 && (
        <section className="upcoming">
          <h2>即将进行</h2>
          <div className="up-list">
            {upcoming.map((u) => (
              <Link
                key={u.matchId}
                to={`/t/${u.tournamentId}/match/${u.matchId}`}
                className="up-card"
              >
                <span className="up-meta">
                  {u.tournamentName} · {u.stageKind === "elim" ? "淘汰赛" : u.stageKind === "group" ? "小组赛" : "循环赛"} 第{u.round}轮
                </span>
                <span className="up-teams">
                  {u.homeTeamName} vs {u.awayTeamName}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
      {recent !== null && recent.length > 0 && (
        <section className="upcoming">
          <h2>最近进行</h2>
          <div className="up-list">
            {recent.map((r) => (
              <Link
                key={r.matchId}
                to={`/t/${r.tournamentId}/match/${r.matchId}`}
                className="up-card"
              >
                <span className="up-meta">
                  {r.tournamentName} · {r.stageKind === "elim" ? "淘汰赛" : r.stageKind === "group" ? "小组赛" : "循环赛"} 第{r.round}轮
                </span>
                <span className="up-teams">
                  {r.homeTeamName}{" "}
                  <span className="up-score">
                    {r.scoreHome}:{r.scoreAway}
                  </span>{" "}
                  {r.awayTeamName}
                </span>
                <EventTimeline events={r.events} />
              </Link>
            ))}
          </div>
        </section>
      )}
      </main>
    </>
  );
}
