import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { api } from "../api";
import { POLL_MS } from "../lib/polling";
import { FORMAT_LABEL, STATUS_LABEL } from "../labels";
import { StandingsTables } from "./StandingsTab";
import { stageTitle } from "./MatchesTab";
import { elimRoundName } from "../../shared/rounds";
import { MatchScore, computeAgg } from "../components/MatchScore";
import { EventTimeline } from "../components/EventTimeline";
import { TeamLogo } from "../components/TeamLogo";
import { Toplists } from "../components/Toplists";
import { StatsDashboard } from "../components/StatsDashboard";
import { ShareButton } from "../components/ShareButton";
import { drawTournamentCard, drawRoundCard, matchToShare } from "../lib/share";
import type { AnnouncementDTO } from "../../shared/news";
import type {
  EntryDTO,
  MatchDTO,
  MatchSummaryDTO,
  RoundMetaDTO,
  StageDTO,
  StageRoundsDTO,
  StageStandingDTO,
  RankZoneSettings,
  TiebreakerKey,
  TournamentDetailDTO,
} from "../../shared/types";

// 公开赛事页：赛程对阵 / 积分榜 / 参赛球队，无登录墙。
// 赛程按轮分页：一轮只在切换时加载一次，live 时每 30 秒刷新；无进行中比赛则完全不轮询。
const roundKey = (s: { stageId: number; round: number }) => `${s.stageId}:${s.round}`;
type RoundChip = RoundMetaDTO & { stageId: number; stage: StageRoundsDTO };
const flatRounds = (stages: StageRoundsDTO[]): RoundChip[] =>
  stages.flatMap((st) => st.rounds.map((r) => ({ ...r, stageId: st.stageId, stage: st })));

// ---------- 淘汰赛公开赛程：回合分块 / 空席位占位（手动落位编排 T10） ----------

/** 席位文案：有队名用队名；空席位用后端下发的候选占位（如「1/2」「A 组第 1」），缺省/空串回退「待定」 */
export function seatLabel(
  teamName: string | null | undefined,
  placeholder: string | null | undefined,
): string {
  if (teamName) return teamName;
  const p = placeholder?.trim();
  return p ? p : "待定";
}

export type ElimPair = { slot: number; leg1: MatchDTO | null; leg2: MatchDTO | null };
export type ElimRoundLayout = { twoLeg: boolean; pairs: ElimPair[] };

/**
 * 淘汰赛轮次布局：轮内存在 leg 行 = 两回合制 → 按 slot 配对（轮空单行只落在 leg1 侧）；
 * 否则视为单场轮次（如单场决赛），保持整轮平铺、不分块。
 */
export function groupElimRound(rows: MatchDTO[]): ElimRoundLayout {
  if (!rows.some((m) => m.leg != null)) return { twoLeg: false, pairs: [] };
  const bySlot = new Map<number, ElimPair>();
  for (const m of rows) {
    let p = bySlot.get(m.slot);
    if (!p) {
      p = { slot: m.slot, leg1: null, leg2: null };
      bySlot.set(m.slot, p);
    }
    if (m.leg === 2) p.leg2 = m;
    else p.leg1 = m;
  }
  return { twoLeg: true, pairs: [...bySlot.values()].sort((a, b) => a.slot - b.slot) };
}

/** 两回合对局的晋级方：总比分（computeAgg 语义）→ 平局看点球（点球踢在次回合）；判不出返回 null */
export function matchupWinnerId(leg1: MatchDTO | null, leg2: MatchDTO | null): number | null {
  if (!leg1 || !leg2) return (leg1 ?? leg2)?.winnerEntryId ?? null;
  const agg = computeAgg(leg2, [leg1, leg2]);
  if (!agg) return null;
  if (agg[0] !== agg[1]) return agg[0] > agg[1] ? leg2.homeEntryId : leg2.awayEntryId;
  if (leg2.penHome != null && leg2.penAway != null && leg2.penHome !== leg2.penAway)
    return leg2.penHome > leg2.penAway ? leg2.homeEntryId : leg2.awayEntryId;
  return null;
}

/** 淘汰阶段尚无任何场次（rounds 元信息按 match 内连接聚合，零场次阶段不会出现） */
export function emptyElimStages(stages: StageDTO[], meta: StageRoundsDTO[]): StageDTO[] {
  const laid = new Set(meta.map((s) => s.stageId));
  return stages.filter((s) => s.kind === "elim" && !laid.has(s.id));
}

export default function PublicTournament() {
  const { id } = useParams();
  const tid = Number(id);
  const [detail, setDetail] = useState<TournamentDetailDTO | null>(null);
  const [meta, setMeta] = useState<StageRoundsDTO[] | null>(null);
  const [summary, setSummary] = useState<MatchSummaryDTO | null>(null);
  const [roundCache, setRoundCache] = useState<Map<string, MatchDTO[]>>(new Map());
  const [sel, setSel] = useState<{ stageId: number; round: number } | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  type PubTab = "schedule" | "standings" | "teams" | "toplists" | "stats";
  const TAB_KEYS: PubTab[] = ["schedule", "standings", "teams", "toplists", "stats"];
  const [tab, setTabState] = useState<PubTab>(() => {
    const t = searchParams.get("tab");
    return TAB_KEYS.includes(t as PubTab) ? (t as PubTab) : "schedule";
  });
  const setTab = (t: PubTab) => {
    setTabState(t);
    setSearchParams(t === "schedule" ? {} : { tab: t }, { replace: true });
  };
  const [err, setErr] = useState<string | null>(null);
  // 头版官方公告（同源 banner，至多一条）
  const [announcement, setAnnouncement] = useState<AnnouncementDTO | null>(null);
  useEffect(() => {
    api<{ announcement: AnnouncementDTO | null }>("/api/public/announcement")
      .then((d) => setAnnouncement(d.announcement))
      .catch(() => {});
  }, []);
  // 切轮次时页面内容会先清空再填充（未缓存轮次要现拉），高度塌缩会把滚动位置挤到顶上；
  // 记下点击时的滚动位置，等新轮数据渲染完成后恢复。
  const lockScrollY = useRef<number | null>(null);
  const pickRound = (c: RoundChip) => {
    lockScrollY.current = window.scrollY;
    setSel({ stageId: c.stageId, round: c.round });
  };
  useLayoutEffect(() => {
    if (lockScrollY.current == null || !sel) return;
    if (!roundCache.has(roundKey(sel))) return;
    window.scrollTo({ top: lockScrollY.current });
    lockScrollY.current = null;
  }, [sel, roundCache]);

  const refresh = useCallback(async () => {
    try {
      const [d, m, s] = await Promise.all([
        api<TournamentDetailDTO>(`/api/public/tournaments/${tid}`),
        api<{ stages: StageRoundsDTO[] }>(`/api/public/tournaments/${tid}/matches/rounds`),
        api<MatchSummaryDTO>(`/api/public/tournaments/${tid}/matches/summary`),
      ]);
      setDetail(d);
      setMeta(m.stages);
      setSummary(s);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
    }
  }, [tid]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // meta 到位后定默认轮：live 轮 > 最早含未完赛的轮 > 全完赛时最大轮（只定一次，之后尊重用户选择）
  useEffect(() => {
    if (!meta || sel) return;
    const chips = flatRounds(meta);
    const liveChip = chips.find((c) => c.live > 0);
    const pendingChip = chips.find((c) => c.pending > 0);
    const target = liveChip ?? pendingChip ?? chips[chips.length - 1];
    if (target) setSel({ stageId: target.stageId, round: target.round });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta]);

  // 按需拉取：当前选中的轮 + 有 live 的轮，进缓存
  useEffect(() => {
    if (!meta) return;
    const need: { stageId: number; round: number }[] = [];
    if (sel && !roundCache.has(roundKey(sel))) need.push(sel);
    for (const c of flatRounds(meta))
      if (c.live > 0 && !roundCache.has(roundKey(c)))
        need.push({ stageId: c.stageId, round: c.round });
    if (need.length === 0) return;
    let alive = true;
    void (async () => {
      const fetched = await Promise.all(
        need.map(async ({ stageId, round }) => {
          const b = await api<{ matches: MatchDTO[] }>(
            `/api/public/tournaments/${tid}/matches?stageId=${stageId}&round=${round}`,
          );
          return [roundKey({ stageId, round }), b.matches] as const;
        }),
      );
      if (!alive) return;
      setRoundCache((prev) => {
        const next = new Map(prev);
        for (const [k, ms] of fetched) next.set(k, ms);
        return next;
      });
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [meta, sel, roundCache, tid]);

  const hasLive = !!meta?.some((st) => st.rounds.some((r) => r.live > 0));

  // 轮询（POLL_MS，与公开面 pubCache 的 60s TTL 对齐）：只有存在进行中比赛时才启动；页面不可见时暂停，回来立刻刷一次
  useEffect(() => {
    if (!hasLive) return;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        await refresh();
        const targets = new Set<string>();
        if (sel) targets.add(roundKey(sel));
        for (const c of flatRounds(meta ?? [])) if (c.live > 0) targets.add(roundKey(c));
        // 各目标轮并行拉取，原先逐轮串行等往返
        await Promise.all(
          [...targets].map(async (t) => {
            const [sid, rd] = t.split(":").map(Number);
            const b = await api<{ matches: MatchDTO[] }>(
              `/api/public/tournaments/${tid}/matches?stageId=${sid}&round=${rd}`,
            );
            setRoundCache((prev) => new Map(prev).set(t, b.matches));
          }),
        );
      } catch {
        // 单次轮询失败静默，下一轮再试
      }
    };
    const iv = setInterval(() => void tick(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hasLive, refresh, sel, meta, tid]);

  if (err)
    return (
      <>
        <main className="container">
        <p className="error-msg">{err}</p>
        <Link to="/">← 返回赛事列表</Link>
        </main>
      </>
    );
  if (!detail || meta === null || summary === null)
    return (
      <>
        <main className="container">
          <p className="muted">加载中…</p>
        </main>
      </>
    );

  const t = detail.tournament;
  const chips = flatRounds(meta);
  const stageDisplayName = (st: StageRoundsDTO) => st.name || stageTitle[st.kind];
  const roundLabel = (c: RoundChip) =>
    c.stage.kind === "elim"
      ? elimRoundName(c.round, Math.max(...c.stage.rounds.map((r) => r.round)))
      : `第 ${c.round} 轮`;
  const entriesByGroup = new Map<number, EntryDTO[]>();
  for (const e of detail.entries) {
    const k = e.groupId ?? -1;
    if (!entriesByGroup.has(k)) entriesByGroup.set(k, []);
    entriesByGroup.get(k)!.push(e);
  }
  const groupName = new Map(
    detail.groups.map((g) => [g.id, g.name] as const),
  );

  const origin = window.location.origin;
  // 分享卡对阵区：有完赛展示最近赛果，否则展示对阵预告（summary 端点数据）
  const shareMatchList = (
    summary.recent.length > 0 ? summary.recent : summary.upcoming
  ).map(matchToShare);
  const shareResultLabel = summary.recent.length > 0 ? "最近赛果" : "对阵预告";

  const selChip = sel ? chips.find((c) => roundKey(c) === roundKey(sel)) : undefined;
  const selRows = sel ? (roundCache.get(roundKey(sel)) ?? []) : [];
  const liveElsewhere = chips.filter(
    (c) => c.live > 0 && (!sel || roundKey(c) !== roundKey(sel)),
  );
  const emptyElims = emptyElimStages(detail.stages, meta);

  return (
    <>
      <main className="container">
      <p className="crumb">
        <Link to="/">← 赛事列表</Link>
      </p>
      {t.coverUrl && (
        <div className="cover-banner">
          <img src={t.coverUrl} alt={`${t.name} 封面`} />
        </div>
      )}
      <header className="pub-head">
        <h1>{t.name}</h1>
        <span className="pub-head-side">
          <span className={`status-badge st-${t.status}`}>{STATUS_LABEL[t.status]}</span>
          <ShareButton
            title={`分享「${t.name}」`}
            url={`${origin}/t/${tid}`}
            draw={(c) =>
              drawTournamentCard(c, {
                name: t.name,
                subtitle: `${STATUS_LABEL[t.status]} · ${FORMAT_LABEL[t.format]} · ${t.entryCount} 支球队`,
                coverUrl: t.coverUrl ?? null,
                resultLabel: shareResultLabel,
                matches: shareMatchList,
                url: `${origin}/t/${tid}`,
              })
            }
          />
        </span>
      </header>
      {announcement && (
        <div className="whl-banner" role="note">
          <span className="whl-banner-icon" aria-hidden>📢</span>
          <div>
            <div className="whl-banner-title">{announcement.title}</div>
            {announcement.body && <p className="whl-banner-body">{announcement.body}</p>}
          </div>
        </div>
      )}
      <p className="muted">
        {FORMAT_LABEL[t.format]} · {t.entryCount} 支球队
        {t.description ? ` · ${t.description}` : ""}
      </p>

      <nav className="tabs">
        {(
          [
            ["schedule", "赛程"],
            ["standings", "积分榜"],
            ["teams", "参赛球队"],
            ["toplists", "榜单"],
            ["stats", "数据"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            className={`tab${tab === key ? " tab-active" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "schedule" && (
        <div className="matches-tab">
          {chips.length === 0 && emptyElims.length === 0 && (
            <p className="muted card">赛程还没排出来，排好后会显示在这里。</p>
          )}
          {chips.length > 0 && (
            <div className="round-tabs">
              {chips.map((c) => (
                <button
                  key={roundKey(c)}
                  className={`rt-chip${sel && roundKey(sel) === roundKey(c) ? " rt-active" : ""}${c.live > 0 ? " rt-live" : ""}`}
                  onClick={() => pickRound(c)}
                >
                  {c.live > 0 && <span className="rt-dot" aria-hidden />}
                  {stageDisplayName(c.stage)} · {roundLabel(c)}
                </button>
              ))}
            </div>
          )}
          {liveElsewhere.length > 0 && (
            <section className="stage-block">
              <h3 className="stage-head stage-head-live">
                进行中 <span className="live-dot" aria-hidden />
              </h3>
              {liveElsewhere.map((c) =>
                (roundCache.get(roundKey(c)) ?? [])
                  .filter((m) => m.status === "live")
                  .map((m) => (
                    <PublicMatchRow key={m.id} tid={tid} match={m} agg={null} />
                  )),
              )}
            </section>
          )}
          {selChip && (
            <section className="stage-block">
              <h3 className="stage-head">{stageDisplayName(selChip.stage)}</h3>
              <div className="round-block">
                <h4 className="round-head">
                  <span>{roundLabel(selChip)}</span>
                  <ShareButton
                    title={`分享「${roundLabel(selChip)}」`}
                    url={`${origin}/t/${tid}?tab=schedule`}
                    draw={(c) =>
                      drawRoundCard(c, {
                        tournamentName: t.name,
                        title: roundLabel(selChip),
                        coverUrl: t.coverUrl ?? null,
                        matches: selRows.map(matchToShare),
                        url: `${origin}/t/${tid}?tab=schedule`,
                      })
                    }
                  />
                </h4>
                <RoundMatches tid={tid} stageKind={selChip.stage.kind} rows={selRows} />
              </div>
            </section>
          )}
          {emptyElims.map((st) => (
            <section className="stage-block" key={st.id}>
              <h3 className="stage-head">{st.name || stageTitle[st.kind]}</h3>
              <div className="round-block">
                <p className="muted">赛程待编排</p>
              </div>
            </section>
          ))}
        </div>
      )}

      {tab === "standings" && (
        <PublicStandings tid={tid} tournamentName={t.name} coverUrl={t.coverUrl ?? null} />
      )}

      {tab === "teams" &&
        (detail.entries.length === 0 ? (
          <p className="muted card">还没有球队报名。</p>
        ) : (
          <div className="teams-public">
            {[...entriesByGroup.keys()]
              .sort((a, b) => a - b)
              .map((k) => (
                <section key={k} className="stage-block">
                  {k !== -1 && <h3 className="stage-head">{groupName.get(k) ?? ""} 组</h3>}
                  <ul className="team-list">
                    {entriesByGroup.get(k)!.map((e) => (
                      <li key={e.id}>
                        <span className="team-seed">#{e.seed}</span>
                        <span className="cell-with-logo">
                          <TeamLogo name={e.teamName} url={e.teamLogoUrl} size={22} />
                          {e.teamName}
                        </span>
                        <span className="muted">（{e.playerCount} 名球员）</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
          </div>
        ))}
      {tab === "toplists" && (
        <Toplists
          tid={tid}
          base="/api/public"
          share={{ tournamentName: t.name, url: `${origin}/t/${tid}?tab=toplists`, coverUrl: t.coverUrl ?? null }}
        />
      )}
      {tab === "stats" && <StatsDashboard tid={tid} base="/api/public" />}
      </main>
    </>
  );
}

export function PublicMatchRow({
  tid,
  match: m,
  agg,
  winnerId,
}: {
  tid: number;
  match: MatchDTO;
  agg: [number, number] | null;
  /** 高亮方覆盖：两回合对局传总比分晋级方；缺省用本行 winnerEntryId；显式 null 不高亮 */
  winnerId?: number | null;
}) {
  const win = winnerId === undefined ? m.winnerEntryId : winnerId;
  const isWin = (entryId: number | null) => entryId != null && entryId === win;
  return (
    <div className={`match-row mr-${m.status}`}>
      <Link to={`/t/${tid}/match/${m.id}`} className="mr-link">
        <div className="mr-line">
          <span className={`mr-team${isWin(m.homeEntryId) ? " mr-win" : ""}`}>
            {m.homeTeamName && <TeamLogo name={m.homeTeamName} url={m.homeLogoUrl} size={18} />}
            {seatLabel(m.homeTeamName, m.homePlaceholder)}
          </span>
          <MatchScore m={m} agg={agg} />
          <span className={`mr-team mr-away${isWin(m.awayEntryId) ? " mr-win" : ""}`}>
            {seatLabel(m.awayTeamName, m.awayPlaceholder)}
            {m.awayTeamName && <TeamLogo name={m.awayTeamName} url={m.awayLogoUrl} size={18} />}
          </span>
          {m.status === "live" && <span className="m-badge ms-live">进行中</span>}
          {m.walkoverSide && <span className="m-badge ms-wo">弃权</span>}
        </div>
      </Link>
      <EventTimeline events={m.events ?? []} />
    </div>
  );
}

// 选中轮的对阵区：淘汰赛两回合制轮次按「首回合」「次回合」分块（区块内一行 = 一场对阵，
// 次回合行带总比分与晋级方高亮）；单场轮次与非淘汰阶段保持整轮平铺的现状。
export function RoundMatches({
  tid,
  stageKind,
  rows,
}: {
  tid: number;
  stageKind: StageRoundsDTO["kind"];
  rows: MatchDTO[];
}) {
  const layout = stageKind === "elim" ? groupElimRound(rows) : null;
  if (!layout || !layout.twoLeg) {
    return (
      <>
        {rows.map((m) => (
          <PublicMatchRow key={m.id} tid={tid} match={m} agg={computeAgg(m, rows)} />
        ))}
      </>
    );
  }
  const leg1 = layout.pairs.filter((p) => p.leg1);
  const leg2 = layout.pairs.filter((p) => p.leg2);
  return (
    <>
      {leg1.length > 0 && <h5 className="round-title">首回合</h5>}
      {leg1.map((p) => (
        <PublicMatchRow
          key={p.leg1!.id}
          tid={tid}
          match={p.leg1!}
          agg={null}
          // 两回合对局的晋级方只在次回合行高亮；轮空单行仍按本行 winner 高亮
          winnerId={p.leg2 ? null : undefined}
        />
      ))}
      {leg2.length > 0 && <h5 className="round-title">次回合</h5>}
      {leg2.map((p) => (
        <PublicMatchRow
          key={p.leg2!.id}
          tid={tid}
          match={p.leg2!}
          agg={computeAgg(p.leg2!, rows)}
          winnerId={matchupWinnerId(p.leg1, p.leg2)}
        />
      ))}
    </>
  );
}

function PublicStandings({
  tid,
  tournamentName,
  coverUrl,
}: {
  tid: number;
  tournamentName: string;
  coverUrl: string | null;
}) {
  const [standings, setStandings] = useState<StageStandingDTO[] | null>(null);
  const [rankZones, setRankZones] = useState<RankZoneSettings | null>(null);
  const [tiebreakers, setTiebreakers] = useState<TiebreakerKey[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{
      standings: StageStandingDTO[];
      rankZones: RankZoneSettings | null;
      tiebreakers?: TiebreakerKey[];
    }>(`/api/public/tournaments/${tid}/standings`)
      .then((b) => {
        setStandings(b.standings);
        setRankZones(b.rankZones ?? null);
        setTiebreakers(b.tiebreakers ?? null);
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "加载积分榜失败"));
  }, [tid]);

  if (err) return <p className="error-msg">{err}</p>;
  if (standings === null) return <p className="muted card">加载中…</p>;
  if (standings.length === 0)
    return <p className="muted card">积分榜尚未产生。比赛开打后这里会显示排名。</p>;
  return (
    <StandingsTables
      standings={standings}
      rankZones={rankZones}
      tiebreakers={tiebreakers}
      share={{
        tournamentName,
        url: `${window.location.origin}/t/${tid}?tab=standings`,
        coverUrl,
      }}
    />
  );
}
