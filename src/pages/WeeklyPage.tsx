import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api";
import type { WeeklyDTO } from "../../shared/news";

const WEEK_MS = 7 * 24 * 3600 * 1000;

function mondayOf(iso: string): Date {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d;
}
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

// WHL 周报页：本周自动回退最近有比赛的一周；?week=YYYY-MM-DD 往期回看
export default function WeeklyPage() {
  const [sp, setSp] = useSearchParams();
  const week = sp.get("week") ?? undefined;
  const [data, setData] = useState<WeeklyDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setErr(null);
    const q = week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? `?week=${week}` : "";
    api<{ weekly: WeeklyDTO }>(`/api/public/weekly${q}`)
      .then((d) => setData(d.weekly))
      .catch((e) => setErr(e instanceof Error ? e.message : "加载失败"));
  }, [week]);

  if (err) {
    return (
      <main className="container">
        <p className="error-msg card">{err}</p>
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

  const base = mondayOf(data.weekStart);
  const thisMonday = mondayOf(isoDate(new Date()));
  const prev = isoDate(new Date(base.getTime() - WEEK_MS));
  const next = isoDate(new Date(base.getTime() + WEEK_MS));
  const canNext = base.getTime() < thisMonday.getTime();

  // 卡序轮换：按周种子确定性旋转，破「射手王永远第一张」的固定版式；「本周最佳」为新增卡
  const cards: ReactNode[] = [];
  if (data.topScorer)
    cards.push(
      <div className="wk-card" key="scorer">
        <b>👑 射手王</b>
        {data.topScorer.name}
        <span className="muted">（{data.topScorer.teamName}）</span> · {data.topScorer.goals} 球
      </div>,
    );
  if (data.bestDefense)
    cards.push(
      <div className="wk-card" key="defense">
        <b>🛡 最佳防守</b>
        {data.bestDefense.teamName} · 仅失 {data.bestDefense.conceded} 球
      </div>,
    );
  if (data.biggestMargin)
    cards.push(
      <div className="wk-card" key="margin">
        <b>💥 最大分差</b>
        <Link to={`/report/${data.biggestMargin.matchId}`}>{data.biggestMargin.score}</Link>
      </div>,
    );
  if (data.bestMatch)
    cards.push(
      <div className="wk-card" key="best">
        <b>⭐ 本周最佳</b>
        <Link to={`/report/${data.bestMatch.matchId}`}>{data.bestMatch.label}</Link>
        <span className="muted">（{data.bestMatch.score}）</span>
      </div>,
    );
  let seedH = 0;
  for (const ch of data.weekStart) seedH = (seedH * 31 + ch.charCodeAt(0)) % 997;
  const off = cards.length > 0 ? seedH % cards.length : 0;
  const rotatedCards = [...cards.slice(off), ...cards.slice(0, off)];

  // 本周伤情：只列本周确实发生的受伤，概览给人数，逐名给轻重与伤名（兼容旧缓存无该字段）
  const injuries = data.injuries ?? [];
  const injuryCount = injuries.length;

  return (
    <main className="container">
      <article className="art">
        <div className="whl-masthead">
          <h2>WHL 周报</h2>
          <span className="whl-masthead-date">{data.label}</span>
          <span className="whl-masthead-all" />
        </div>
        {data.isFallback && (
          <p className="art-meta">
            本周还没有比赛——先看最近有比赛的一周。<Link to="/weekly">回到本周</Link>
          </p>
        )}

        <div className="wk-stats">
          <div className="wk-stat">
            <div className="n">{data.played}</div>
            <div className="l">比赛</div>
          </div>
          <div className="wk-stat">
            <div className="n">{data.goals}</div>
            <div className="l">进球</div>
          </div>
          <div className="wk-stat">
            <div className="n">{data.played ? (data.goals / data.played).toFixed(1) : "0.0"}</div>
            <div className="l">场均进球</div>
          </div>
          <div className="wk-stat">
            <div className="n">{data.cleanSheets}</div>
            <div className="l">零封</div>
          </div>
          <div className="wk-stat">
            <div className="n">{data.ownGoals}</div>
            <div className="l">乌龙球</div>
          </div>
          {injuryCount > 0 && (
            <div className="wk-stat wk-stat-inj">
              <div className="n">{injuryCount}</div>
              <div className="l">伤员</div>
            </div>
          )}
        </div>

        <div className="wk-high">{rotatedCards}</div>

        {injuryCount > 0 && (
          <div className="art-sec">
            <h3>本周伤情（{injuryCount} 人）</h3>
            <ul className="inj-line">
              {injuries.map((f) => (
                <li key={f.playerId}>
                  <span className="inj-line-name">{f.playerName}</span>
                  <span className="muted">
                    （{f.teamName} · {f.tournamentName}）
                  </span>
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

        {data.matches.length > 0 && (
          <div className="art-sec">
            <h3>本周比赛（{data.matches.length} 场）</h3>
            {data.matches.map((m) => (
              <div key={m.matchId} className="news-item">
                <Link className="news-item-link" to={`/report/${m.matchId}`}>
                  <div className="news-item-top">
                    <span className="news-kind">{m.tournamentName}</span>
                    <span className="news-item-title">
                      {m.homeTeamName} {m.scoreHome}:{m.scoreAway} {m.awayTeamName}
                    </span>
                    <span className="news-item-time">
                      {m.finishedAt
                        ? new Date(m.finishedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
                        : ""}
                    </span>
                  </div>
                </Link>
              </div>
            ))}
          </div>
        )}

        <div className="pager">
          <button type="button" onClick={() => setSp({ week: prev })}>
            ← 上一周
          </button>
          {week && (
            <button type="button" onClick={() => setSp({})}>
              本周
            </button>
          )}
          <button type="button" disabled={!canNext} onClick={() => setSp({ week: next })}>
            下一周 →
          </button>
          <Link to="/news" className="whl-masthead-all">
            快讯档案 →
          </Link>
        </div>
      </article>
    </main>
  );
}
