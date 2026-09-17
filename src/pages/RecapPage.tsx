import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api";
import type { RecapDTO } from "../../shared/news";

// 轮次综述页：某轮全部完赛后自动成文；未齐轮也可看（isComplete 标注）
export default function RecapPage() {
  const params = useParams();
  const tid = Number(params.tid);
  const sid = Number(params.sid);
  const round = Number(params.round);
  const valid = [tid, sid, round].every(Number.isInteger);
  const [data, setData] = useState<RecapDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!valid) return;
    setData(null);
    setErr(null);
    api<{ recap: RecapDTO | null }>(`/api/public/tournaments/${tid}/round/${sid}/${round}`)
      .then((d) => {
        setData(d.recap);
        if (!d.recap) setErr("该轮暂无综述");
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "加载失败"));
  }, [valid, tid, sid, round]);

  if (err || !valid) {
    return (
      <main className="container">
        <p className="muted card">{err ?? "参数不合法"}</p>
        <p>
          <Link to="/">← 回到首页</Link>
        </p>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="container">
        <p className="muted">加载中…</p>
      </main>
    );
  }

  const injuries = data.injuries ?? [];

  return (
    <main className="container">
      <article className="art">
        <div className="art-kicker">
          <Link to={`/t/${data.tournamentId}`}>{data.tournamentName}</Link> · 综述
        </div>
        <h1 className="art-title">
          {data.roundLabel}综述{" "}
          {!data.isComplete && <span className="badge-warn">未齐轮 · 已完赛 {data.played} 场</span>}
        </h1>

        {data.paragraphs.map((p, i) => (
          <p key={i} className={i === 0 ? "art-lede" : "art-p"}>
            {p}
          </p>
        ))}

        {data.standings.length > 0 && (
          <div className="art-sec">
            <h3>积分榜前五</h3>
            <table className="st-mini">
              <thead>
                <tr>
                  <th>#</th>
                  <th>球队</th>
                  <th>赛</th>
                  <th>积分</th>
                </tr>
              </thead>
              <tbody>
                {data.standings.map((s) => (
                  <tr key={s.rank}>
                    <td>{s.rank}</td>
                    <td>
                      {s.rank === 1 ? "👑 " : ""}
                      {s.teamName}
                    </td>
                    <td>{s.played}</td>
                    <td>{s.pts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {injuries.length > 0 && (
          <div className="art-sec">
            <h3>本轮伤情（{injuries.length} 人）</h3>
            <ul className="inj-line">
              {injuries.map((f) => (
                <li key={f.playerId}>
                  <span className="inj-line-name">{f.playerName}</span>
                  <span className="muted">（{f.teamName}）</span>
                  <span className={`iw-sev${f.severity === "major" ? " iw-sev-major" : ""}`}>
                    {f.severity === "major" ? "重伤" : "轻伤"}
                  </span>
                  {f.injuryName && <span className="inj-line-hurt">{f.injuryName}</span>}
                  {f.outMatches > 0 && <span className="inj-line-rest">还缺 {f.outMatches} 场</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="art-sec">
          <h3>本轮比赛（{data.matches.length} 场）</h3>
          {data.matches.map((m) => (
            <div key={m.matchId} className="news-item">
              <Link className="news-item-link" to={`/report/${m.matchId}`}>
                <div className="news-item-top">
                  <span className="news-kind">战报</span>
                  <span className="news-item-title">
                    {m.homeTeamName} {m.scoreHome}:{m.scoreAway} {m.awayTeamName}
                  </span>
                </div>
              </Link>
            </div>
          ))}
        </div>

        <p className="art-meta">
          <Link to={`/t/${data.tournamentId}?tab=schedule`}>← {data.tournamentName}赛程</Link>
          {" · "}
          <Link to="/">WHL 头版</Link>
        </p>
      </article>
    </main>
  );
}
