import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { TeamLogo } from "../components/TeamLogo";
import { ShareButton } from "../components/ShareButton";
import { drawNewsCard } from "../lib/share";
import type { MatchReportDTO } from "../../shared/news";

type MotmResp = {
  totals: { playerId: number; playerName: string; cnt: number }[];
  myVote: number | null;
};

const GOAL_TAG: Record<string, string> = { goal: "⚽", pen_goal: "⚽ 点球", own_goal: "乌龙" };

// 单场战报文章页：后端预渲染整页直出；完赛场可投全场最佳（MOTM）
export default function ReportPage() {
  const { mid } = useParams();
  const midNum = Number(mid);
  const [report, setReport] = useState<MatchReportDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [motm, setMotm] = useState<MotmResp | null>(null);
  const [voteMsg, setVoteMsg] = useState<string | null>(null);
  const [voting, setVoting] = useState(false);
  const { user } = useAuth();

  useEffect(() => {
    if (!Number.isInteger(midNum)) return;
    setReport(null);
    setErr(null);
    api<{ report: MatchReportDTO | null }>(`/api/public/matches/${midNum}/report`)
      .then((d) => {
        setReport(d.report);
        if (!d.report) setErr("该比赛暂无战报（仅完赛场自动成文）");
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "加载失败"));
  }, [midNum]);

  useEffect(() => {
    if (!report) return;
    api<MotmResp>(`/api/interact/matches/${midNum}/motm`)
      .then(setMotm)
      .catch(() => {});
  }, [report, midNum]);

  // MOTM 候选 = 数据框里出现过的球员（进球/助攻/红黄牌），按进球数、助攻数次序排前
  const candidates = useMemo(() => {
    if (!report) return [];
    const map = new Map<
      number,
      { playerId: number; name: string; teamName: string; goals: number; assists: number }
    >();
    const touch = (playerId: number, name: string, teamName: string) => {
      const cur = map.get(playerId) ?? { playerId, name, teamName, goals: 0, assists: 0 };
      map.set(playerId, cur);
      return cur;
    };
    for (const g of report.goals) {
      if (g.playerId == null || g.type === "own_goal") continue;
      touch(g.playerId, g.playerName ?? "球员", g.teamName).goals += 1;
      if (g.assistPlayerId != null) {
        touch(g.assistPlayerId, g.assistPlayerName ?? "球员", g.teamName).assists += 1;
      }
    }
    for (const c of report.cards) {
      if (c.playerId == null) continue;
      touch(c.playerId, c.playerName ?? "球员", c.teamName);
    }
    return [...map.values()].sort(
      (a, b) => b.goals - a.goals || b.assists - a.assists || a.name.localeCompare(b.name, "zh"),
    );
  }, [report]);

  const vote = async (playerId: number) => {
    if (!user || voting) return;
    setVoting(true);
    setVoteMsg(null);
    try {
      await api(`/api/interact/matches/${midNum}/motm`, { method: "POST", body: { playerId } });
      setMotm(await api<MotmResp>(`/api/interact/matches/${midNum}/motm`));
      setVoteMsg("已投票，可改票");
    } catch (e) {
      setVoteMsg(e instanceof Error ? e.message : "投票失败");
    } finally {
      setVoting(false);
    }
  };

  if (err) {
    return (
      <main className="container">
        <p className="muted card">{err}</p>
        <p>
          <Link to="/">← 回到首页</Link>
        </p>
      </main>
    );
  }
  if (!report) {
    return (
      <main className="container">
        <p className="muted">加载中…</p>
      </main>
    );
  }

  const wo = report.walkoverSide !== "";
  const dateStr = report.finishedAt
    ? new Date(report.finishedAt).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })
    : "";
  const cntOf = (pid: number) => motm?.totals.find((t) => t.playerId === pid)?.cnt ?? 0;
  const topCnt = motm?.totals[0]?.cnt ?? 0;

  return (
    <main className="container">
      <article className="art">
        <div className="art-kicker">
          {report.tournamentName} · {report.roundLabel} · 战报
        </div>
        <h1 className="art-title">{report.title}</h1>
        <p className="art-meta">
          {dateStr}
          {wo && (
            <>
              {" · "}
              <span className="badge-warn">弃权判负</span>
            </>
          )}
        </p>

        <div className="rp-scorebox">
          <span className="side">
            <TeamLogo name={report.homeTeamName} url={report.homeLogoUrl} size={52} />
            {report.homeTeamName}
          </span>
          <span className="num">
            {report.scoreHome}:{report.scoreAway}
            {report.penHome != null && report.penAway != null && (
              <span className="pen">（点 {report.penHome}:{report.penAway}）</span>
            )}
          </span>
          <span className="side">
            <TeamLogo name={report.awayTeamName} url={report.awayLogoUrl} size={52} />
            {report.awayTeamName}
          </span>
        </div>
        {report.note && <p className="art-meta">备注：{report.note}</p>}

        <p className="art-lede">{report.lede}</p>
        {report.paragraphs.map((p, i) => (
          <p key={i} className="art-p">
            {p}
          </p>
        ))}

        {report.context.length > 0 && (
          <div className="art-context">
            <h3>赛事背景</h3>
            {report.context.map((p, i) => (
              <p key={i} className="art-p">
                {p}
              </p>
            ))}
          </div>
        )}

        {(report.goals.length > 0 || report.cards.length > 0) && (
          <div className="art-sec">
            <h3>比赛数据</h3>
            <div className="rp-cols">
              <div className="rp-col">
                <h4>{report.homeTeamName}</h4>
                {report.goals
                  .filter((g) => g.side === "home")
                  .map((g, i) => (
                    <div key={`hg${i}`} className="rp-ev">
                      <span className="m">{g.minute != null ? `${g.minute}'` : ""}</span>
                      <span>{GOAL_TAG[g.type] ?? "⚽"}</span>
                      <span>
                        {g.playerName ?? "未知球员"}
                        {g.assistPlayerName ? `（${g.assistPlayerName} 助攻）` : ""}
                      </span>
                    </div>
                  ))}
                {report.cards
                  .filter((c) => c.teamName === report.homeTeamName)
                  .map((c, i) => (
                    <div key={`hc${i}`} className="rp-ev">
                      <span className="m">{c.minute != null ? `${c.minute}'` : ""}</span>
                      <span>{c.type === "red" ? "🟥" : "🟨"}</span>
                      <span>{c.playerName ?? "球员"}</span>
                    </div>
                  ))}
              </div>
              <div className="rp-col">
                <h4>{report.awayTeamName}</h4>
                {report.goals
                  .filter((g) => g.side === "away")
                  .map((g, i) => (
                    <div key={`ag${i}`} className="rp-ev">
                      <span className="m">{g.minute != null ? `${g.minute}'` : ""}</span>
                      <span>{GOAL_TAG[g.type] ?? "⚽"}</span>
                      <span>
                        {g.playerName ?? "未知球员"}
                        {g.assistPlayerName ? `（${g.assistPlayerName} 助攻）` : ""}
                      </span>
                    </div>
                  ))}
                {report.cards
                  .filter((c) => c.teamName === report.awayTeamName)
                  .map((c, i) => (
                    <div key={`ac${i}`} className="rp-ev">
                      <span className="m">{c.minute != null ? `${c.minute}'` : ""}</span>
                      <span>{c.type === "red" ? "🟥" : "🟨"}</span>
                      <span>{c.playerName ?? "球员"}</span>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        )}

        {candidates.length > 0 && (
          <div className="art-sec">
            <h3>全场最佳 · 你的一票</h3>
            <div className="motm-cand">
              {candidates.map((c) => {
                const mine = motm?.myVote === c.playerId;
                const cnt = cntOf(c.playerId);
                return (
                  <button
                    key={c.playerId}
                    type="button"
                    className={`motm-btn${mine ? " my" : ""}`}
                    disabled={!user || voting}
                    onClick={() => void vote(c.playerId)}
                  >
                    {cnt > 0 && cnt === topCnt ? "👑 " : ""}
                    {c.name}
                    <span className="muted">（{c.teamName}）</span>
                    {cnt > 0 ? ` · ${cnt} 票` : ""}
                    {mine ? " ✓" : ""}
                  </button>
                );
              })}
            </div>
            <p className="art-meta">
              {!user ? (
                <>
                  <Link to="/login">登录</Link>后可为本场球员投票（观众号也可以）
                </>
              ) : (
                voteMsg ?? "一人一场一票，点击即可改票"
              )}
            </p>
          </div>
        )}

        <div className="art-sec">
          <ShareButton
            label="分享战报卡"
            title={report.title}
            url={`${window.location.origin}/report/${report.matchId}`}
            draw={(canvas) =>
              drawNewsCard(canvas, {
                kicker: `WHL 头版 · ${report.roundLabel}`,
                title: report.title,
                homeTeam: report.homeTeamName,
                awayTeam: report.awayTeamName,
                score: `${report.scoreHome}:${report.scoreAway}`,
                url: `${window.location.origin}/report/${report.matchId}`,
              })
            }
          />
        </div>

        <p className="art-meta">
          <Link to={`/t/${report.tournamentId}`}>← {report.tournamentName}</Link>
          {" · "}
          <Link to="/">WHL 头版</Link>
        </p>
      </article>
    </main>
  );
}
