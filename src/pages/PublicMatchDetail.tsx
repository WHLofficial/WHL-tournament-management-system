import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { MatchScore } from "../components/MatchScore";
import { EventTimeline } from "../components/EventTimeline";
import { TeamLogo } from "../components/TeamLogo";
import type { MatchDTO } from "../../shared/types";

const STAGE_TITLE: Record<string, string> = {
  elim: "淘汰赛",
  round_robin: "循环赛",
  group: "小组赛",
};

// 公开比赛详情页：大比分 + 完整事件时间线，30 秒轮询（后台标签页暂停）
export default function PublicMatchDetail() {
  const { id, mid } = useParams();
  const tid = Number(id);
  const matchId = Number(mid);
  const [m, setM] = useState<MatchDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const b = await api<{ match: MatchDTO }>(
        `/api/public/tournaments/${tid}/matches/${matchId}`,
      );
      setM(b.match);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
    }
  }, [tid, matchId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) void refetch();
    }, 30000);
    return () => clearInterval(t);
  }, [refetch]);

  return (
    <main className="container">
      <p className="muted">
        <Link to={`/t/${tid}`}>← 返回赛事</Link>
      </p>
      {err ? (
        <p className="error-msg">{err === "比赛不存在" ? "比赛不存在或已隐藏。" : err}</p>
      ) : m === null ? (
        <p className="muted">加载中…</p>
      ) : (
        <>
          <h2 className="md-title">
            {m.stageKind ? STAGE_TITLE[m.stageKind] : ""} 第{m.round}轮
            {m.leg ? ` · 第${m.leg}回合` : ""}
          </h2>
          <div className={`card md-card md-${m.status}`}>
            <div className="md-line">
              <span className={`md-team${m.winnerEntryId === m.homeEntryId ? " md-win" : ""}`}>
                {m.homeTeamName ? (
                  <>
                    <TeamLogo name={m.homeTeamName} url={m.homeLogoUrl} size={22} />
                    {m.homeTeamName}
                  </>
                ) : (
                  "待定"
                )}
              </span>
              <MatchScore m={m} agg={null} />
              <span className={`md-team md-away${m.winnerEntryId === m.awayEntryId ? " md-win" : ""}`}>
                {m.awayTeamName ? (
                  <>
                    {m.awayTeamName}
                    <TeamLogo name={m.awayTeamName} url={m.awayLogoUrl} size={22} />
                  </>
                ) : (
                  "待定"
                )}
              </span>
              {m.status === "live" && <span className="m-badge ms-live">进行中</span>}
            </div>
            <EventTimeline events={m.events ?? []} showAll />
            {(m.events ?? []).length === 0 && m.note !== "轮空" && (
              <p className="muted md-empty">还没有事件记录。</p>
            )}
          </div>
        </>
      )}
    </main>
  );
}
