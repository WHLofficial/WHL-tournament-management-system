import { useEffect, useState } from "react";
import { api } from "../api";

interface MatchHighlight {
  matchId: number;
  homeName: string;
  awayName: string;
  scoreHome: number;
  scoreAway: number;
  stageName: string;
  round: number;
}

interface StatsData {
  progress: { total: number; finished: number; live: number; pending: number };
  goals: { total: number; avg: number; penScored: number; penMissed: number };
  cards: { yellows: number; reds: number };
  biggestMargin: (MatchHighlight & { margin: number }) | null;
  injuryMatch: (Omit<MatchHighlight, "scoreHome" | "scoreAway"> & {
    scoreHome: number | null;
    scoreAway: number | null;
    count: number;
  }) | null;
  fun: {
    topTeam: { teamId: number; teamName: string; total: number; avg: number } | null;
    bestDefense: { teamId: number; teamName: string; total: number; avg: number } | null;
    maxMatchGoals: { matchId: number; homeName: string; awayName: string; total: number } | null;
    ownGoals: number;
  };
  topMatches: (MatchHighlight & { total: number })[];
  roundTrend: { label: string; goals: number }[];
}

function NumCard({ label, num }: { label: string; num: string | number }) {
  return (
    <div className="stat-card">
      <span className="num">{num}</span>
      <span className="label">{label}</span>
    </div>
  );
}

// 单赛事数据仪表盘：概览 + 趣味卡 + 最大分差 + 进球大战 + 轮次趋势（口径同积分榜：完赛）
export function StatsDashboard({ tid, base }: { tid: number; base: string }) {
  const [data, setData] = useState<StatsData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    api<StatsData>(`${base}/tournaments/${tid}/stats`)
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
  if (data.progress.total === 0)
    return <p className="muted">还没有排比赛，开始比赛后这里就是仪表盘。</p>;

  const { progress, goals, cards, fun } = data;
  const maxTrend = Math.max(1, ...data.roundTrend.map((r) => r.goals));

  return (
    <div className="stats-tab">
      <h3>概览</h3>
      <div className="stat-grid">
        <NumCard label="总场次" num={progress.total} />
        <NumCard label="已完赛" num={progress.finished} />
        <NumCard label="进行中" num={progress.live} />
        <NumCard label="未开打" num={progress.pending} />
      </div>
      <div className="stat-grid">
        <NumCard label="总进球 / 场均" num={`${goals.total} / ${goals.avg.toFixed(2)}`} />
        <NumCard
          label="点球（进/总）"
          num={`${goals.penScored} / ${goals.penScored + goals.penMissed}`}
        />
        <NumCard label="黄牌" num={cards.yellows} />
        <NumCard label="红牌" num={cards.reds} />
      </div>

      <h3>趣味数据</h3>
      <div className="stat-grid">
        <div className="stat-card">
          <span className="emoji">🔥</span>
          <span className="num">{fun.topTeam ? fun.topTeam.teamName : "—"}</span>
          <span className="label">
            火力最强{fun.topTeam ? ` · ${fun.topTeam.total} 球 · 场均 ${fun.topTeam.avg.toFixed(2)}` : "暂无"}
          </span>
        </div>
        <div className="stat-card">
          <span className="emoji">🛡️</span>
          <span className="num">{fun.bestDefense ? fun.bestDefense.teamName : "—"}</span>
          <span className="label">
            防守最好{fun.bestDefense ? ` · 失 ${fun.bestDefense.total} 球 · 场均 ${fun.bestDefense.avg.toFixed(2)}` : "暂无"}
          </span>
        </div>
        <div className="stat-card">
          <span className="emoji">⚡</span>
          <span className="num">{fun.maxMatchGoals ? `${fun.maxMatchGoals.total} 球` : "—"}</span>
          <span className="label">
            单场最高{fun.maxMatchGoals ? ` · ${fun.maxMatchGoals.homeName} vs ${fun.maxMatchGoals.awayName}` : "暂无"}
          </span>
        </div>
        <div className="stat-card">
          <span className="emoji">🙃</span>
          <span className="num">{fun.ownGoals}</span>
          <span className="label">乌龙球</span>
        </div>
      </div>

      {(data.biggestMargin || data.injuryMatch) && (
        <>
          <h3>对决之最</h3>
          <div className="stat-grid">
            {data.biggestMargin && (
              <div className="stat-card wide">
                <span className="num">
                  {data.biggestMargin.homeName} {data.biggestMargin.scoreHome}:{data.biggestMargin.scoreAway}{" "}
                  {data.biggestMargin.awayName}
                </span>
                <span className="label">
                  净胜 {data.biggestMargin.margin} 球 · {data.biggestMargin.stageName} 第
                  {data.biggestMargin.round}轮
                </span>
              </div>
            )}
            {data.injuryMatch && (
              <div className="stat-card">
                <span className="num">
                  {data.injuryMatch.scoreHome === null || data.injuryMatch.scoreAway === null
                    ? `${data.injuryMatch.homeName} vs ${data.injuryMatch.awayName}`
                    : `${data.injuryMatch.homeName} ${data.injuryMatch.scoreHome}:${data.injuryMatch.scoreAway} ${data.injuryMatch.awayName}`}
                </span>
                <span className="label">
                  ⚔️ 刺刀见红 · 伤 {data.injuryMatch.count} 人次 · {data.injuryMatch.stageName} 第
                  {data.injuryMatch.round}轮
                </span>
              </div>
            )}
          </div>
        </>
      )}

      {data.topMatches.length > 0 && (
        <>
          <h3>进球大战 Top5</h3>
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>对阵</th>
                <th>比分</th>
                <th>进球</th>
                <th>轮次</th>
              </tr>
            </thead>
            <tbody>
              {data.topMatches.map((m, i) => (
                <tr key={m.matchId}>
                  <td>{i + 1}</td>
                  <td>
                    {m.homeName} vs {m.awayName}
                  </td>
                  <td>
                    {m.scoreHome}:{m.scoreAway}
                  </td>
                  <td>{m.total}</td>
                  <td>
                    {m.stageName} 第{m.round}轮
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {data.roundTrend.length > 0 && (
        <>
          <h3>轮次趋势</h3>
          <div className="trend">
            {data.roundTrend.map((r) => (
              <div className="trend-row" key={r.label}>
                <span className="trend-label">{r.label}</span>
                <div className="trend-bar-wrap">
                  <div className="trend-bar" style={{ width: `${(r.goals / maxTrend) * 100}%` }} />
                </div>
                <span className="trend-num">{r.goals}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
