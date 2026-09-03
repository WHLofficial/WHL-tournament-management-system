import { useEffect, useState } from "react";
import { api } from "../api";
import type { StageStandingDTO } from "../../shared/types";

// 积分榜：小组/循环阶段各一张表，行序已由后端排好（积分→净胜→进球→相互战绩）。
// 管理端挂在「积分榜」tab；公开页直接复用 <StandingsTables>。
export default function StandingsTab({ tournamentId }: { tournamentId: number }) {
  const [standings, setStandings] = useState<StageStandingDTO[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ standings: StageStandingDTO[] }>(`/api/admin/tournaments/${tournamentId}/standings`)
      .then((b) => setStandings(b.standings))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "加载积分榜失败"));
  }, [tournamentId]);

  if (err) return <p className="muted card">{err}</p>;
  if (standings === null) return <p className="muted card">加载中…</p>;
  if (standings.length === 0)
    return <p className="muted card">还没有积分榜。循环赛或小组赛阶段产生比分后，这里会自动出现排名。</p>;

  return <StandingsTables standings={standings} />;
}

export function StandingsTables({ standings }: { standings: StageStandingDTO[] }) {
  const stageTitle = { group: "小组赛", round_robin: "循环赛" } as const;
  return (
    <>
      {standings.map((st) => (
        <section key={st.stageId} className="standings-stage">
          <h3 className="stage-head">{stageTitle[st.kind]}</h3>
          <div className={st.groups.length > 1 ? "standings-grid" : ""}>
            {st.groups.map((g) => (
              <table key={g.groupId ?? 0} className="standings-table">
                {g.name && <caption>{g.name} 组</caption>}
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th className="team-col">球队</th>
                    <th className="num">赛</th>
                    <th className="num">胜</th>
                    <th className="num">平</th>
                    <th className="num">负</th>
                    <th className="num">进</th>
                    <th className="num">失</th>
                    <th className="num">净</th>
                    <th className="num">
                      积分<span className="pen-hint">*</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((r) => (
                    <tr key={r.entryId}>
                      <td className="num">{r.rank}</td>
                      <td className="team-col">{r.teamName}</td>
                      <td className="num">{r.played}</td>
                      <td className="num">{r.won}</td>
                      <td className="num">{r.drawn}</td>
                      <td className="num">{r.lost}</td>
                      <td className="num">{r.goalsFor}</td>
                      <td className="num">{r.goalsAgainst}</td>
                      <td className="num">{r.goalsFor - r.goalsAgainst}</td>
                      <td className="num pts">{r.pts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
          </div>
        </section>
      ))}
      <p className="muted standings-note">
        * 积分：胜 3、平 1、负 0；平局后点球决胜的点球胜者记 2 分、负者记 1 分。排名依次比较积分、净胜球、进球数、相互战绩。
      </p>
    </>
  );
}
