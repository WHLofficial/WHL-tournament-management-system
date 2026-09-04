import { useEffect, useState } from "react";
import { api } from "../api";

interface PlayerRow {
  playerId: number;
  playerName: string;
  teamName: string;
  count: number;
}

interface CardsPlayerRow {
  playerId: number;
  playerName: string;
  teamName: string;
  yellows: number;
  reds: number;
}

interface TeamRow {
  teamId: number;
  teamName: string;
  count: number;
}

interface CardsTeamRow {
  teamId: number;
  teamName: string;
  yellows: number;
  reds: number;
}

interface ToplistsData {
  scorers: PlayerRow[];
  assists: PlayerRow[];
  cardsPlayers: CardsPlayerRow[];
  injuries: PlayerRow[];
  teamGoals: TeamRow[];
  teamConceded: TeamRow[];
  cleanSheets: TeamRow[];
  cardsTeams: CardsTeamRow[];
}

function RankTable({
  title,
  head,
  rows,
}: {
  title: string;
  head: string[];
  rows: React.ReactNode[][];
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <h3>{title}</h3>
      <table className="table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// 单赛事榜单：球员榜（射手/助攻/红黄牌/伤病）+ 球队榜（进球/失球/零封/红黄牌）
export function Toplists({ tid, base }: { tid: number; base: string }) {
  const [data, setData] = useState<ToplistsData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    api<ToplistsData>(`${base}/tournaments/${tid}/toplists`)
      .then((d) => {
        if (on) setData(d);
      })
      .catch((e) => {
        if (on) setErr(e instanceof Error ? e.message : "加载失败");
      });
    return () => {
      on = false;
    };
  }, [tid, base]);

  if (err) return <p className="error-msg">{err}</p>;
  if (!data) return <p className="muted">加载中…</p>;

  const allEmpty =
    data.scorers.length +
      data.assists.length +
      data.cardsPlayers.length +
      data.injuries.length +
      data.teamGoals.length +
      data.teamConceded.length +
      data.cleanSheets.length +
      data.cardsTeams.length ===
    0;
  if (allEmpty) return <p className="muted">还没有比赛数据，打完比赛这里就有榜了。</p>;

  const cards = (y: number, r: number) => (
    <>
      {y > 0 && <span title="黄牌">🟨 {y}</span>}
      {r > 0 && (
        <span title="红牌" style={{ marginLeft: y > 0 ? 8 : 0 }}>
          🟥 {r}
        </span>
      )}
    </>
  );

  return (
    <div className="toplists-tab">
      <h3>球员榜</h3>
      <RankTable
        title="射手榜"
        head={["#", "球员", "球队", "进球"]}
        rows={data.scorers.map((r, i) => [i + 1, r.playerName, r.teamName, r.count])}
      />
      <RankTable
        title="助攻榜"
        head={["#", "球员", "球队", "助攻"]}
        rows={data.assists.map((r, i) => [i + 1, r.playerName, r.teamName, r.count])}
      />
      <RankTable
        title="红黄牌榜"
        head={["#", "球员", "球队", "牌"]}
        rows={data.cardsPlayers.map((r, i) => [i + 1, r.playerName, r.teamName, cards(r.yellows, r.reds)])}
      />
      <RankTable
        title="伤病榜"
        head={["#", "球员", "球队", "次数"]}
        rows={data.injuries.map((r, i) => [i + 1, r.playerName, r.teamName, r.count])}
      />
      <h3>球队榜</h3>
      <RankTable
        title="球队进球榜"
        head={["#", "球队", "进球"]}
        rows={data.teamGoals.map((r, i) => [i + 1, r.teamName, r.count])}
      />
      <RankTable
        title="球队失球榜（少者前）"
        head={["#", "球队", "失球"]}
        rows={data.teamConceded.map((r, i) => [i + 1, r.teamName, r.count])}
      />
      <RankTable
        title="零封榜"
        head={["#", "球队", "零封"]}
        rows={data.cleanSheets.map((r, i) => [i + 1, r.teamName, r.count])}
      />
      <RankTable
        title="球队红黄牌榜"
        head={["#", "球队", "牌"]}
        rows={data.cardsTeams.map((r, i) => [i + 1, r.teamName, cards(r.yellows, r.reds)])}
      />
    </div>
  );
}
