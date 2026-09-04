import { useEffect, useState } from "react";
import { api } from "../api";
import { ShareButton } from "./ShareButton";
import { drawTableCard } from "../lib/share";

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
  action,
}: {
  title: string;
  head: string[];
  rows: React.ReactNode[][];
  action?: React.ReactNode;
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <div className="rank-head">
        <h3>{title}</h3>
        {action}
      </div>
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

type Seg = "player" | "team";

interface ListDef {
  key: string;
  name: string;
  title: string;
  head: string[];
  rows: React.ReactNode[][];
  plain: string[][];
}

// 单赛事榜单：顶部球员榜/球队榜分段，左列菜单选具体榜单
export function Toplists({
  tid,
  base,
  share,
}: {
  tid: number;
  base: string;
  share?: { tournamentName: string; url: string } | null;
}) {
  const [data, setData] = useState<ToplistsData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [seg, setSeg] = useState<Seg>("player");
  const [sel, setSel] = useState("scorers");

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

  const cardsText = (y: number, r: number) =>
    [y > 0 ? `${y}🟨` : "", r > 0 ? `${r}🟥` : ""].filter(Boolean).join(" ") || "0";

  const playerLists: ListDef[] = [
    {
      key: "scorers",
      name: "射手榜",
      title: "射手榜",
      head: ["#", "球员", "球队", "进球"],
      rows: data.scorers.map((r, i) => [i + 1, r.playerName, r.teamName, r.count]),
      plain: data.scorers.map((r, i) => [String(i + 1), r.playerName, r.teamName, String(r.count)]),
    },
    {
      key: "assists",
      name: "助攻榜",
      title: "助攻榜",
      head: ["#", "球员", "球队", "助攻"],
      rows: data.assists.map((r, i) => [i + 1, r.playerName, r.teamName, r.count]),
      plain: data.assists.map((r, i) => [String(i + 1), r.playerName, r.teamName, String(r.count)]),
    },
    {
      key: "cardsPlayers",
      name: "红黄牌榜",
      title: "红黄牌榜",
      head: ["#", "球员", "球队", "牌"],
      rows: data.cardsPlayers.map((r, i) => [i + 1, r.playerName, r.teamName, cards(r.yellows, r.reds)]),
      plain: data.cardsPlayers.map((r, i) => [String(i + 1), r.playerName, r.teamName, cardsText(r.yellows, r.reds)]),
    },
    {
      key: "injuries",
      name: "伤病榜",
      title: "伤病榜",
      head: ["#", "球员", "球队", "次数"],
      rows: data.injuries.map((r, i) => [i + 1, r.playerName, r.teamName, r.count]),
      plain: data.injuries.map((r, i) => [String(i + 1), r.playerName, r.teamName, String(r.count)]),
    },
  ];

  const teamLists: ListDef[] = [
    {
      key: "teamGoals",
      name: "进球榜",
      title: "球队进球榜",
      head: ["#", "球队", "进球"],
      rows: data.teamGoals.map((r, i) => [i + 1, r.teamName, r.count]),
      plain: data.teamGoals.map((r, i) => [String(i + 1), r.teamName, String(r.count)]),
    },
    {
      key: "teamConceded",
      name: "失球榜",
      title: "球队失球榜（少者前）",
      head: ["#", "球队", "失球"],
      rows: data.teamConceded.map((r, i) => [i + 1, r.teamName, r.count]),
      plain: data.teamConceded.map((r, i) => [String(i + 1), r.teamName, String(r.count)]),
    },
    {
      key: "cleanSheets",
      name: "零封榜",
      title: "零封榜",
      head: ["#", "球队", "零封"],
      rows: data.cleanSheets.map((r, i) => [i + 1, r.teamName, r.count]),
      plain: data.cleanSheets.map((r, i) => [String(i + 1), r.teamName, String(r.count)]),
    },
    {
      key: "cardsTeams",
      name: "红黄牌榜",
      title: "球队红黄牌榜",
      head: ["#", "球队", "牌"],
      rows: data.cardsTeams.map((r, i) => [i + 1, r.teamName, cards(r.yellows, r.reds)]),
      plain: data.cardsTeams.map((r, i) => [String(i + 1), r.teamName, cardsText(r.yellows, r.reds)]),
    },
  ];

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

  const lists = seg === "player" ? playerLists : teamLists;
  const current = lists.find((l) => l.key === sel) ?? lists[0];

  const switchSeg = (s: Seg) => {
    setSeg(s);
    setSel(s === "player" ? "scorers" : "teamGoals");
  };

  return (
    <div className="toplists-tab">
      <div className="seg-control">
        <button
          type="button"
          className={seg === "player" ? "seg-btn active" : "seg-btn"}
          onClick={() => switchSeg("player")}
        >
          球员榜
        </button>
        <button
          type="button"
          className={seg === "team" ? "seg-btn active" : "seg-btn"}
          onClick={() => switchSeg("team")}
        >
          球队榜
        </button>
      </div>
      <div className="toplists-layout">
        <div className="toplist-menu">
          {lists.map((l) => (
            <button
              type="button"
              key={l.key}
              className={l.key === current.key ? "menu-item active" : "menu-item"}
              onClick={() => setSel(l.key)}
            >
              {l.name}
            </button>
          ))}
        </div>
        <div className="toplist-panel">
          {current.rows.length === 0 ? (
            <p className="muted">这项还没有数据，打完比赛就有了。</p>
          ) : (
            <RankTable
              title={current.title}
              head={current.head}
              rows={current.rows}
              action={
                share && (
                  <ShareButton
                    title={`分享「${current.title}」`}
                    url={share.url}
                    draw={(c) =>
                      drawTableCard(c, {
                        tournamentName: share.tournamentName,
                        title: current.title,
                        columns: current.head,
                        rows: current.plain,
                        url: share.url,
                      })
                    }
                  />
                )
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
