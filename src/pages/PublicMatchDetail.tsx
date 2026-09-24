import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { POLL_MS } from "../lib/polling";
import { MatchScore } from "../components/MatchScore";
import { EventTimeline, eventMeta, timelineSide } from "../components/EventTimeline";
import { TeamLogo } from "../components/TeamLogo";
import { ShareButton } from "../components/ShareButton";
import { PreMatchTabs } from "../components/PreMatchPanels";
import { drawMatchCard, matchToShare } from "../lib/share";
import { LineupGrid } from "../components/LineupView";
import { recoverStageLabel } from "../../shared/injuries";
import type {
  MatchAbsencesResp,
  MatchDTO,
  MatchLineupDTO,
  PublicAbsenceDTO,
} from "../../shared/types";

const STAGE_TITLE: Record<string, string> = {
  elim: "淘汰赛",
  round_robin: "循环赛",
  group: "小组赛",
};

// 「因伤缺阵」名单：登记里勾了这一场的球员。有人的一侧才显示，两侧都没有就整块不出。
function AbsenceBlock({
  home,
  away,
  homeTeamName,
  awayTeamName,
}: {
  home: PublicAbsenceDTO[];
  away: PublicAbsenceDTO[];
  homeTeamName: string | null;
  awayTeamName: string | null;
}) {
  if (home.length === 0 && away.length === 0) return null;
  return (
    <div className="md-abs">
      <b className="md-abs-head">🩹 因伤缺阵</b>
      <div className="md-abs-grid">
        <AbsenceCol teamName={homeTeamName} list={home} />
        <AbsenceCol teamName={awayTeamName} list={away} away />
      </div>
    </div>
  );
}

function AbsenceCol({
  teamName,
  list,
  away,
}: {
  teamName: string | null;
  list: PublicAbsenceDTO[];
  away?: boolean;
}) {
  if (list.length === 0) return null;
  return (
    <div className={`md-abs-col${away ? " md-abs-away" : ""}`}>
      <b className="md-abs-team">{teamName ?? "该队"}</b>
      <ul>
        {list.map((a) => (
          <li key={a.playerId}>
            <span className="md-abs-name">{a.playerName}</span>
            {a.injuryName && <span className="md-abs-hurt">{a.injuryName}</span>}
            <span className={`md-abs-sev${a.severity === "major" ? " md-abs-sev-major" : ""}`}>
              {a.severity === "major" ? "重伤" : "轻伤"}
            </span>
            <span className="md-abs-stage">{recoverStageLabel(a.recoverPercent)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// 公开比赛详情页：大比分 + 完整事件时间线，30 秒轮询（后台标签页暂停）
export default function PublicMatchDetail() {
  const { id, mid } = useParams();
  const tid = Number(id);
  const matchId = Number(mid);
  const [m, setM] = useState<MatchDTO | null>(null);
  const [tInfo, setTInfo] = useState<{ name: string; coverUrl: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lineup, setLineup] = useState<MatchLineupDTO | null>(null);
  // 阵容拉失败时 lineup 是 null，而 null 的渲染结果和「还没提交阵容」完全一样——要分开标出来
  const [lineupErr, setLineupErr] = useState<string | null>(null);
  const [absences, setAbsences] = useState<MatchAbsencesResp | null>(null);

  // 分享卡标题需要赛事名，进来时顺手拉一次
  useEffect(() => {
    api<{ tournament: { name: string; coverUrl: string | null } }>(`/api/public/tournaments/${tid}`)
      .then((b) => setTInfo({ name: b.tournament.name, coverUrl: b.tournament.coverUrl ?? null }))
      .catch(() => setTInfo(null));
  }, [tid]);

  // 弱网韧性：轮询失败保留旧数据静默重试，只有一次都没成功过才显示错误——
  // 不能让一次网络抖动把整页比分替换成报错
  const gotData = useRef(false);
  const refetch = useCallback(async () => {
    try {
      const b = await api<{ match: MatchDTO; absences: MatchAbsencesResp }>(
        `/api/public/tournaments/${tid}/matches/${matchId}`,
      );
      gotData.current = true;
      setM(b.match);
      setAbsences(b.absences ?? { home: [], away: [] });
      setErr(null);
    } catch (e) {
      if (!gotData.current) setErr(e instanceof Error ? e.message : "加载失败");
    }
  }, [tid, matchId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    // 完赛场停止自动轮询（省电省流量）；改判/补录后观众刷新页面即可
    if (m?.status === "finished") return;
    const t = setInterval(() => {
      if (!document.hidden) void refetch();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [refetch, m?.status]);

  // 提交阵容：开赛（live/finished）后公开接口才有数据，pending 不拉
  useEffect(() => {
    if (!m || m.status === "pending" || m.note === "轮空") {
      setLineup(null);
      setLineupErr(null);
      return;
    }
    let dead = false;
    setLineupErr(null);
    api<MatchLineupDTO>(`/api/public/matches/${matchId}/lineup`)
      .then((b) => {
        if (!dead) setLineup(b);
      })
      .catch((e: unknown) => {
        if (dead) return;
        setLineup(null);
        setLineupErr(e instanceof Error ? e.message : "加载失败");
      });
    return () => {
      dead = true;
    };
  }, [m?.status, m?.note, matchId]);

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
          <div className="md-title-row">
            <h2 className="md-title">
              {m.stageKind ? STAGE_TITLE[m.stageKind] : ""} 第{m.round}轮
              {m.leg ? ` · 第${m.leg}回合` : ""}
            </h2>
            {tInfo && (
              <ShareButton
                title={`分享这场比赛`}
                url={`${window.location.origin}/t/${tid}/match/${matchId}`}
                draw={(c) =>
                  drawMatchCard(c, {
                    tournamentName: tInfo.name,
                    coverUrl: tInfo.coverUrl,
                    subtitle:
                      (m.stageKind ? STAGE_TITLE[m.stageKind] : "") +
                      ` 第${m.round}轮` +
                      (m.leg ? ` · 第${m.leg}回合` : ""),
                    match: matchToShare(m),
                    eventRows: [...(m.events ?? [])]
                      .sort((a, b) => (a.minute ?? 0) - (b.minute ?? 0))
                      .flatMap((e) => {
                        const meta = eventMeta(e.type);
                        if (!meta) return [];
                        return [
                          {
                            side: timelineSide(e),
                            icon: meta.icon,
                            card: meta.card,
                            tag: meta.tag ?? null,
                            minute: e.minute,
                            playerName: e.playerName,
                            assistName: e.assistPlayerName,
                          },
                        ];
                      }),
                    url: `${window.location.origin}/t/${tid}/match/${matchId}`,
                  })
                }
              />
            )}
          </div>
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
              {m.walkoverSide && <span className="m-badge ms-wo">弃权</span>}
              {m.rescored && <span className="m-badge ms-rescored">比分经改判</span>}
            </div>
            {m.walkoverSide && m.note && m.note !== "轮空" && (
              <p className="muted md-wo-note">{m.note}</p>
            )}
            {m.note !== "轮空" && absences && (
              <AbsenceBlock
                home={absences.home}
                away={absences.away}
                homeTeamName={m.homeTeamName}
                awayTeamName={m.awayTeamName}
              />
            )}
            {m.status === "pending" &&
              m.homeEntryId != null &&
              m.awayEntryId != null &&
              m.note !== "轮空" && (
                <PreMatchTabs tid={tid} match={m} absences={absences} />
              )}
            <EventTimeline events={m.events ?? []} showAll />
            {(m.events ?? []).length === 0 && m.note !== "轮空" && m.status !== "pending" && (
              <p className="muted md-empty">还没有事件记录。</p>
            )}
            {lineup && (lineup.home || lineup.away) && (
              <div className="md-lineups">
                <h3>提交阵容</h3>
                <LineupGrid home={lineup.home} away={lineup.away} />
              </div>
            )}
            {lineupErr && (
              <p className="error-msg md-empty">提交阵容加载失败：{lineupErr}（不代表双方没交阵容）</p>
            )}
          </div>
        </>
      )}
    </main>
  );
}
