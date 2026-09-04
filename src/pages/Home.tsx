import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { FORMAT_LABEL, STATUS_LABEL } from "../labels";
import type { TournamentDTO, UpcomingDTO } from "../../shared/types";

// 登录后首页：所有非草稿赛事 + 跨赛事"即将进行"。未登录会被 RequireRole 踢到登录页；/t/:id 单赛事页仍公开。
export function Home() {
  const [list, setList] = useState<TournamentDTO[] | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingDTO[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, u] = await Promise.all([
        api<{ tournaments: TournamentDTO[] }>("/api/public/tournaments"),
        api<{ upcoming: UpcomingDTO[] }>("/api/public/upcoming"),
      ]);
      setList(b.tournaments);
      setUpcoming(u.upcoming);
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
      {list === null && !err && <p className="muted">加载中…</p>}
      {list !== null && list.length === 0 && (
        <p className="muted card">还没有赛事。管理员登录后可以创建。</p>
      )}
      <div className="home-list">
        {list?.map((t) => (
          <Link to={`/t/${t.id}`} key={t.id} className="home-card">
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
      </main>
    </>
  );
}
