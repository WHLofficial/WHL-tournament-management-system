import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { FORMAT_LABEL, STATUS_LABEL } from "../labels";
import { EventTimeline } from "../components/EventTimeline";
import { TeamLogo } from "../components/TeamLogo";
import "./portal.css";
import type { AnnouncementDTO, FeedItemDTO, FeedKind } from "../../shared/news";
import { pickText } from "../../shared/textpick";
import type { LiveDTO, TournamentDTO, UpcomingDTO } from "../../shared/types";

export const KIND_LABEL: Record<FeedKind, string> = {
  match: "战报",
  walkover: "弃权",
  recap: "综述",
  leader: "榜首",
  streak: "纪录",
  milestone: "里程碑",
  rescore: "更正",
  discipline: "红牌",
  weekly: "周报",
};
// 暖色徽标的非常规条目（改判/红牌/弃权）
export const KIND_HOT: Partial<Record<FeedKind, boolean>> = { walkover: true, rescore: true, discipline: true };

const EMOJIS: { key: "fire" | "thumb" | "mind" | "cry"; label: string }[] = [
  { key: "fire", label: "🔥" },
  { key: "thumb", label: "👍" },
  { key: "mind", label: "🤯" },
  { key: "cry", label: "😢" },
];
const REACT_LS = (itemId: string) => `whl.react.${itemId}`;

// 条目点击去向：战报/弃权→战报文章页；综述→综述页；周报→周报页；榜首/纪录→积分榜；里程碑→榜单；红牌/更正→单场
export function itemHref(i: FeedItemDTO): string {
  switch (i.kind) {
    case "match":
    case "walkover":
      return `/report/${i.matchId}`;
    case "recap":
      return `/recap/${i.tournamentId}/${i.stageId}/${i.round}`;
    case "weekly":
      return `/weekly?week=${i.weekStart}`;
    case "leader":
    case "streak":
      return `/t/${i.tournamentId}?tab=standings`;
    case "milestone":
      return `/t/${i.tournamentId}?tab=toplists`;
    case "rescore":
    case "discipline":
      return `/t/${i.tournamentId}/match/${i.matchId}`;
  }
}

export function fmtTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export type ReactionCounts = Partial<Record<"fire" | "thumb" | "mind" | "cry", number>>;

// 表态按钮组：匿名去重靠 localStorage，点过的一键置亮且不再发请求
export function ReactionBar({
  itemId,
  counts,
  mine,
  onReact,
}: {
  itemId: string;
  counts: ReactionCounts | undefined;
  mine: Set<string>;
  onReact: (itemId: string, emoji: "fire" | "thumb" | "mind" | "cry") => void;
}) {
  return (
    <div className="reaction-bar" onClick={(e) => e.stopPropagation()}>
      {EMOJIS.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          className={`react-btn${mine.has(key) ? " on" : ""}`}
          disabled={mine.has(key)}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onReact(itemId, key);
          }}
        >
          {label}
          {counts?.[key] ? ` ${counts[key]}` : ""}
        </button>
      ))}
    </div>
  );
}

// 头版门户（公开）：工具入口 + 赛事卡 + 官方公告 + 快讯 ticker + 「WHL 头版」（头条对撞卡 + 快讯流橱窗）
export function Home() {
  const [list, setList] = useState<TournamentDTO[] | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingDTO[] | null>(null);
  const [liveList, setLiveList] = useState<LiveDTO[] | null>(null);
  const [announcement, setAnnouncement] = useState<AnnouncementDTO | null>(null);
  const [feed, setFeed] = useState<FeedItemDTO[] | null>(null);
  const [reactions, setReactions] = useState<Record<string, ReactionCounts>>({});
  const [mine, setMine] = useState<Record<string, Set<string>>>({});
  const [err, setErr] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // 轮询节流闸：有无进行中比赛决定快慢刷（ref 避免 load 闭包重建）
  const liveRef = useRef(0);

  const load = useCallback(async () => {
    try {
      const [b, u, l, a, f] = await Promise.all([
        api<{ tournaments: TournamentDTO[] }>("/api/public/tournaments"),
        api<{ upcoming: UpcomingDTO[] }>("/api/public/upcoming"),
        api<{ live: LiveDTO[] }>("/api/public/live"),
        api<{ announcement: AnnouncementDTO | null }>("/api/public/announcement"),
        api<{ items: FeedItemDTO[] }>("/api/public/feed?limit=16"),
      ]);
      setList(b.tournaments);
      setUpcoming(u.upcoming);
      setLiveList(l.live);
      setAnnouncement(a.announcement);
      setFeed(f.items);
      liveRef.current = l.live.length;
      setErr(null);
      const ids = f.items.map((i) => i.id);
      if (ids.length > 0) {
        const r = await api<{ reactions: Record<string, ReactionCounts> }>(
          `/api/interact/reactions?ids=${ids.map(encodeURIComponent).join(",")}`,
        );
        setReactions(r.reactions);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    void load();
    let ticks = 0;
    const t = setInterval(() => {
      if (document.hidden) return;
      ticks++;
      // 有 live 30s 快刷；无 live 降到 120s 慢刷兜底（不漏新开的比赛）
      if (liveRef.current > 0 || ticks % 4 === 0) void load();
    }, 30000);
    return () => clearInterval(t);
  }, [load]);

  // 表态：localStorage 已点过直接忽略；否则乐观计数 + 落存储
  const react = useCallback(async (itemId: string, emoji: "fire" | "thumb" | "mind" | "cry") => {
    const key = REACT_LS(itemId);
    const prev: string[] = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (prev.includes(emoji)) return;
    localStorage.setItem(key, JSON.stringify([...prev, emoji]));
    setMine((m) => ({ ...m, [itemId]: new Set([...(m[itemId] ?? []), emoji]) }));
    setReactions((r) => ({ ...r, [itemId]: { ...r[itemId], [emoji]: (r[itemId]?.[emoji] ?? 0) + 1 } }));
    try {
      const res = await api<{ ok: boolean; cnt: number }>(`/api/interact/reactions/${itemId}`, {
        method: "POST",
        body: { emoji },
      });
      setReactions((r) => ({ ...r, [itemId]: { ...r[itemId], [emoji]: res.cnt } }));
    } catch {
      // 失败回滚计数（保留本地已点标记，防连点刷数）
      setReactions((r) => ({ ...r, [itemId]: { ...r[itemId], [emoji]: Math.max(0, (r[itemId]?.[emoji] ?? 1) - 1) } }));
    }
  }, []);

  // 头条 = 最近战报里有效剧情分最高的一场，平手取更早出现者；无战报时退弃权条目。
  // 有效剧情分 = drama × 0.75^idx（idx 为其前更新的完赛条目数，下限 0）：每多一场更新的完赛打七五折，
  // 比赛日约 10 场，老的高分比赛一个比赛日内让位、隔天基本出清，新的新闻才上得来
  const HEADLINE_DECAY = 0.75;
  const matchFeed = (feed ?? []).filter((i) => i.kind === "match" && i.homeTeamName);
  const headline =
    matchFeed.length > 0
      ? matchFeed
          .map((item, idx) => ({ item, eff: Math.max(0, (item.drama ?? 0) * Math.pow(HEADLINE_DECAY, idx)) }))
          .reduce((a, b) => (b.eff > a.eff ? b : a)).item
      : ((feed ?? []).find((i) => i.kind === "walkover" && i.homeTeamName) ?? null);
  const shelf = (feed ?? []).filter((i) => i !== headline).slice(0, 3);
  const tickerItems = (feed ?? []).slice(0, 12);
  // 已归档赛事不进主列表，收进底部折叠条（后端列表照常返回，前端拆）
  const activeList = list ? list.filter((t) => t.status !== "archived") : [];
  const archivedList = list ? list.filter((t) => t.status === "archived") : [];

  const card = (t: TournamentDTO) => (
    <Link to={`/t/${t.id}`} key={t.id} className="home-card">
      {t.coverUrl && <img className="home-card-cover" src={t.coverUrl} alt={`${t.name} 封面`} />}
      <div className="home-card-head">
        <strong>{t.name}</strong>
        <span className={`status-badge st-${t.status}`}>{STATUS_LABEL[t.status]}</span>
      </div>
      {t.description && <p className="home-card-desc">{t.description}</p>}
      <p className="home-card-meta">
        {FORMAT_LABEL[t.format]} · {t.entryCount} 支球队
      </p>
    </Link>
  );

  return (
    <>
      <main className="container">
        <h1>WHL 赛事</h1>
        <Link to="/tactics" className="tac-entry">
          <strong>🧩 战术板</strong>
          <span>FC26 战术码在线排阵 · 无需登录</span>
        </Link>
        {err && <p className="error-msg">{err}</p>}
        {list === null && !err && <p className="muted">加载中…</p>}
        {list !== null && activeList.length === 0 && (
          <p className="muted card">
            {archivedList.length > 0 ? "赛事均已归档，可在下方展开查看。" : "还没有赛事。管理员登录后可以创建。"}
          </p>
        )}
        <div className="home-list">{activeList.map((t) => card(t))}</div>

        {archivedList.length > 0 && (
          <div className="archive-sec">
            <button type="button" className="archive-toggle" onClick={() => setShowArchived((v) => !v)}>
              已归档赛事（{archivedList.length}）{showArchived ? "▲" : "▼"}
            </button>
            {showArchived && <div className="home-list">{archivedList.map((t) => card(t))}</div>}
          </div>
        )}

        {announcement && (
          <div className="whl-banner" role="note">
            <span className="whl-banner-icon" aria-hidden>📢</span>
            <div>
              <div className="whl-banner-title">{announcement.title}</div>
              {announcement.body && <p className="whl-banner-body">{announcement.body}</p>}
            </div>
          </div>
        )}

        {tickerItems.length > 0 && (
          <div className="whl-ticker" aria-label="快讯">
            <span className="whl-ticker-tag">快讯</span>
            <div className="whl-ticker-viewport">
              <div className="whl-ticker-inner">
                {[0, 1].map((dup) =>
                  tickerItems.map((i) => (
                    <Link
                      key={`${dup}-${i.id}`}
                      className="whl-ticker-item"
                      to={itemHref(i)}
                      aria-hidden={dup === 1 || undefined}
                      tabIndex={dup === 1 ? -1 : undefined}
                    >
                      <span className="t">{fmtTime(i.at)}</span>
                      {i.title}
                    </Link>
                  )),
                )}
              </div>
            </div>
          </div>
        )}

        {liveList !== null && liveList.length > 0 && (
          <section className="upcoming">
            <h2>
              进行中 <span className="live-dot" aria-hidden />
            </h2>
            <div className="up-list">
              {liveList.map((v) => (
                <Link
                  key={v.matchId}
                  to={`/t/${v.tournamentId}/match/${v.matchId}`}
                  className="up-card up-live"
                >
                  <span className="up-meta">
                    {v.tournamentName} · {v.stageKind === "elim" ? "淘汰赛" : v.stageKind === "group" ? "小组赛" : "循环赛"} 第{v.round}轮
                  </span>
                  <span className="up-teams">
                    <span className="up-side up-home">{v.homeTeamName}</span>
                    <span className="up-score up-score-live">
                      {v.scoreHome}:{v.scoreAway}
                    </span>
                    <span className="up-side up-away">{v.awayTeamName}</span>
                  </span>
                  <EventTimeline events={v.events} />
                </Link>
              ))}
            </div>
          </section>
        )}

        {feed !== null && feed.length > 0 && (
          <section className="whl-press">
            <div className="whl-masthead">
              <h2>WHL 头版</h2>
              <span className="whl-masthead-date">
                {new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}
              </span>
              <Link className="whl-masthead-all" to="/news">
                查看全部 →
              </Link>
            </div>

            {headline && (
              <article className={`whl-headline whl-headline--${pickText(headline.id, ["v0", "v1", "v2", "v3"])}`}>
                <Link className="whl-headline-link" to={itemHref(headline)}>
                  <span className="whl-headline-kicker">
                    头条 · {headline.roundLabel ?? KIND_LABEL[headline.kind]}
                  </span>
                  <div className="whl-headline-vs">
                    <span className="whl-headline-side">
                      <TeamLogo name={headline.homeTeamName ?? ""} url={headline.homeLogoUrl} size={80} />
                      <span className="tname">{headline.homeTeamName}</span>
                    </span>
                    <span className="whl-headline-score">
                      {headline.scoreHome}:{headline.scoreAway}
                    </span>
                    <span className="whl-headline-side">
                      <TeamLogo name={headline.awayTeamName ?? ""} url={headline.awayLogoUrl} size={80} />
                      <span className="tname">{headline.awayTeamName}</span>
                    </span>
                  </div>
                  <p className="whl-headline-title">{headline.title}</p>
                  <span className="whl-headline-read">阅读战报 →</span>
                </Link>
                <ReactionBar
                  itemId={headline.id}
                  counts={reactions[headline.id]}
                  mine={mine[headline.id] ?? new Set()}
                  onReact={react}
                />
              </article>
            )}

            <div className="whl-shelf">
              {shelf.map((i) => (
                <div key={i.id} className="news-item">
                  <Link className="news-item-link" to={itemHref(i)}>
                    <div className="news-item-top">
                      <span className={`news-kind${KIND_HOT[i.kind] ? " k-hot" : i.kind === "weekly" ? " k-weekly" : ""}`}>
                        {KIND_LABEL[i.kind]}
                      </span>
                      <span className="news-item-title">{i.title}</span>
                      <span className="news-item-time">{fmtTime(i.at)}</span>
                    </div>
                    <p className="news-item-body">{i.body}</p>
                  </Link>
                  <ReactionBar
                    itemId={i.id}
                    counts={reactions[i.id]}
                    mine={mine[i.id] ?? new Set()}
                    onReact={react}
                  />
                </div>
              ))}
            </div>
            <Link className="whl-more" to="/news">
              阅读更多快讯 →
            </Link>
          </section>
        )}

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
                    <span className="up-side up-home">{u.homeTeamName}</span>
                    <span className="up-vs">vs</span>
                    <span className="up-side up-away">{u.awayTeamName}</span>
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>
    </>
  );
}
