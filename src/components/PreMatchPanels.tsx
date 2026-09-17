// 未开赛详情页的赛前情报三 Tab：交锋（跨赛事 H2H）/ 球员（本届榜单对决）/ 阵容（跨赛事战术档案）。
// 数据全部是历史统计——「赛前不亮牌」产品决策不动，本场提交的阵容开赛才亮。
import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { TeamLogo } from "./TeamLogo";
import { CardIcon } from "./Cards";
import { FORMS, POS_ZH, formTitle } from "../../shared/tactics";
import { recoverStageLabel } from "../../shared/injuries";
import { tilePositions } from "../lib/pitch";
import type {
  H2HDTO,
  H2HFormItem,
  LineupStatsDTO,
  MatchAbsencesResp,
  MatchDTO,
  PublicAbsenceDTO,
  TeamLineupDTO,
  TeamTacticsDTO,
} from "../../shared/types";

interface TopRow {
  playerId: number;
  playerName: string;
  teamName: string;
  count: number;
}
interface CardsTeamRow {
  teamId: number;
  teamName: string;
  yellows: number;
  reds: number;
}
interface CardsPlayerRow {
  playerId: number;
  playerName: string;
  teamName: string;
  yellows: number;
  reds: number;
  suspended?: boolean;
}
interface ToplistsData {
  scorers: TopRow[];
  assists: TopRow[];
  cardsTeams: CardsTeamRow[];
  cardsPlayers: CardsPlayerRow[];
}

type TabKey = "h2h" | "players" | "lineup" | "mine";

const TABS: { key: TabKey; label: string }[] = [
  { key: "h2h", label: "交锋" },
  { key: "players", label: "球员" },
  { key: "lineup", label: "阵容" },
];

// 本队教练已提交本场阵容时，它排在最前并默认选中（只有本队账号看得到）
const MINE_TAB: { key: TabKey; label: string } = { key: "mine", label: "已提交阵容" };

// 挂载即拉一次、不进 30 秒轮询；失败静默（非关键内容不挡页面）
function useFetch<T>(url: string | null): { data: T | null; fail: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [fail, setFail] = useState(false);
  useEffect(() => {
    if (!url) return;
    let dead = false;
    api<T>(url)
      .then((b) => {
        if (!dead) setData(b);
      })
      .catch(() => {
        if (!dead) setFail(true);
      });
    return () => {
      dead = true;
    };
  }, [url]);
  return { data, fail };
}

export function PreMatchTabs({
  tid,
  match,
  absences,
}: {
  tid: number;
  match: MatchDTO;
  absences?: MatchAbsencesResp | null;
}) {
  // 本队教练赛前回显自己那份：只有绑了队的账号才去问教练端点（公开端点不读登录态，教练端点无缓存且只回本队）
  const { user } = useAuth();
  const { data: mine } = useFetch<{ lineup: TeamLineupDTO | null }>(
    user?.teamId != null ? `/api/coach/matches/${match.id}/lineup` : null,
  );
  const myLineup = mine?.lineup ?? null;
  // 已提交时它排第一个并默认选中；用户点过其它 Tab 之后就不再自动切
  const [tab, setTab] = useState<TabKey | null>(null);
  const cur = tab ?? (myLineup ? "mine" : "h2h");
  const tabs = myLineup ? [MINE_TAB, ...TABS] : TABS;
  return (
    <div className="pmt-wrap">
      <div className="pmt-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={`pmt-tab${cur === t.key ? " on" : ""}`}
            onClick={() => setTab(t.key)}
            role="tab"
            aria-selected={cur === t.key}
          >
            {t.label}
          </button>
        ))}
      </div>
      {cur === "mine" && myLineup && <MyLineupPanel l={myLineup} />}
      {cur === "h2h" && <H2HPanel tid={tid} match={match} />}
      {cur === "players" && <PlayersPanel tid={tid} match={match} absences={absences} />}
      {cur === "lineup" && <LineupPanel tid={tid} match={match} />}
    </div>
  );
}

function Loading() {
  return <p className="muted pmt-loading">加载中…</p>;
}

// ---------- 交锋 ----------

function H2HPanel({ tid, match }: { tid: number; match: MatchDTO }) {
  const { data: d, fail } = useFetch<H2HDTO>(
    `/api/public/tournaments/${tid}/matches/${match.id}/h2h`,
  );
  if (fail) return null;
  if (!d) return <Loading />;
  if (!d.home || !d.away) return null;
  const homeTid = d.home.teamId;
  const awayTid = d.away.teamId;
  const o = d.overall;
  return (
    <div className="pmt-sec">
      {o && o.played > 0 && (
        <>
          <div className="h2h-record">
            <span className="h2h-side">
              <TeamLogo name={d.home.teamName} url={d.home.logoUrl} size={16} />
              {d.home.teamName}
            </span>
            <b className="h2h-nums">
              {o.winsHome} 胜 · {o.draws} 平 · {o.winsAway} 负
            </b>
            <span className="h2h-side right">
              {d.away.teamName}
              <TeamLogo name={d.away.teamName} url={d.away.logoUrl} size={16} />
            </span>
          </div>
          <div className="h2h-bar" title={`${o.played} 次交手 · 场均 ${o.avgGoals} 球`}>
            <i className="h2h-bar-h" style={{ width: `${(o.winsHome / o.played) * 100}%` }} />
            <i className="h2h-bar-d" style={{ width: `${(o.draws / o.played) * 100}%` }} />
            <i className="h2h-bar-a" style={{ width: `${(o.winsAway / o.played) * 100}%` }} />
          </div>
        </>
      )}
      {d.storylines.map((s, i) => (
        <p key={i} className="h2h-fact">
          {s}
        </p>
      ))}
      {d.meetings.length === 0 ? (
        <p className="h2h-first">✦ 两队首次相遇</p>
      ) : (
        <ul className="h2h-list">
          {d.meetings.map((mt) => {
            const meta = [
              mt.dateLabel,
              mt.tournamentName,
              mt.stageName ?? "",
              `第${mt.round}轮${mt.leg ? ` · 回合${mt.leg}` : ""}`,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={mt.matchId}>
                <span className="h2h-m-meta">
                  {meta}
                  {mt.isThisTournament && <span className="m-badge ms-this">本届</span>}
                </span>
                <span className="h2h-m-line">
                  <span className={`h2h-m-team${mt.winnerTeamId === homeTid ? " win" : ""}`}>
                    {mt.homeTeamName}
                  </span>
                  <span className="h2h-m-score">
                    {mt.scoreHome}:{mt.scoreAway}
                    {mt.penHome != null && mt.penAway != null && (
                      <small> 点 {mt.penHome}:{mt.penAway}</small>
                    )}
                    {mt.walkoverSide && <span className="m-badge ms-wo">弃权</span>}
                  </span>
                  <span className={`h2h-m-team right${mt.winnerTeamId === awayTid ? " win" : ""}`}>
                    {mt.awayTeamName}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {(d.homeForm.length > 0 || d.awayForm.length > 0) && (
        <div className="h2h-forms">
          <FormStrip label={d.home.teamName} form={d.homeForm} />
          <FormStrip label={d.away.teamName} form={d.awayForm} right />
        </div>
      )}
      {d.ranks && (
        <p className="h2h-ranks">
          {d.ranks.label}
          {d.ranks.home.groupName ? `（${d.ranks.home.groupName}）` : ""}：{d.home.teamName} 第
          {d.ranks.home.rank}（{d.ranks.home.pts}分） · {d.away.teamName} 第{d.ranks.away.rank}（
          {d.ranks.away.pts}分）
        </p>
      )}
    </div>
  );
}

function FormStrip({ label, form, right }: { label: string; form: H2HFormItem[]; right?: boolean }) {
  if (form.length === 0) return null;
  return (
    <div className={`h2h-formstrip${right ? " right" : ""}`}>
      <span className="h2h-formlabel">{label} 近况</span>
      <span className="h2h-dots">
        {form.map((f) => (
          <i
            key={f.matchId}
            className={`fdot fdot-${f.result}`}
            title={`${f.result === "W" ? "胜" : f.result === "D" ? "平" : "负"} ${f.scoreLabel}${
              f.opponentName ? ` vs ${f.opponentName}` : ""
            }`}
          >
            {f.result === "W" ? "胜" : f.result === "D" ? "平" : "负"}
          </i>
        ))}
      </span>
    </div>
  );
}

// ---------- 球员 ----------

function PlayersPanel({
  tid,
  match,
  absences,
}: {
  tid: number;
  match: MatchDTO;
  absences?: MatchAbsencesResp | null;
}) {
  const { data: d, fail } = useFetch<ToplistsData>(`/api/public/tournaments/${tid}/toplists`);
  if (fail) return null;
  if (!d) return <Loading />;
  const hn = match.homeTeamName ?? "";
  const an = match.awayTeamName ?? "";
  const top = (rows: TopRow[], name: string) => rows.find((r) => r.teamName === name) ?? null;
  const card = (name: string) => d.cardsTeams.find((r) => r.teamName === name) ?? null;
  const susp = d.cardsPlayers.filter((p) => p.suspended && (p.teamName === hn || p.teamName === an));
  // 伤停按队分成两段，标出是哪一队的人
  const injuries: { teamName: string; a: PublicAbsenceDTO }[] = [
    ...(absences?.home ?? []).map((a) => ({ teamName: hn, a })),
    ...(absences?.away ?? []).map((a) => ({ teamName: an, a })),
  ];
  const hs = top(d.scorers, hn);
  const as = top(d.scorers, an);
  const ha = top(d.assists, hn);
  const aa = top(d.assists, an);
  if (
    !hs &&
    !as &&
    !ha &&
    !aa &&
    !card(hn) &&
    !card(an) &&
    susp.length === 0 &&
    injuries.length === 0
  ) {
    return <p className="muted pmt-empty">本届还没有球员数据。</p>;
  }
  return (
    <div className="pmt-sec">
      <div className="pl-duel">
        <PlayerCol teamName={hn} logoUrl={match.homeLogoUrl ?? null} scorer={hs} assist={ha} cards={card(hn)} />
        <PlayerCol teamName={an} logoUrl={match.awayLogoUrl ?? null} scorer={as} assist={aa} cards={card(an)} away />
      </div>
      {injuries.length > 0 && (
        <div className="pl-susp pl-inj">
          <b>🩹 伤停情报</b>
          <ul>
            {injuries.map(({ teamName, a }) => (
              <li key={`${a.teamId}-${a.playerId}`}>
                {teamName} · {a.playerName} 伤停中
                {a.injuryName ? `（${a.injuryName}` : "（"}
                {a.severity === "major" ? "重伤" : "轻伤"} · {recoverStageLabel(a.recoverPercent)}）
              </li>
            ))}
          </ul>
        </div>
      )}
      {susp.length > 0 && (
        <div className="pl-susp">
          <b>🟥 停赛情报</b>
          <ul>
            {susp.map((p) => (
              <li key={p.playerId}>
                {p.teamName} · {p.playerName} 停赛中
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function PlayerCol({
  teamName,
  logoUrl,
  scorer,
  assist,
  cards,
  away,
}: {
  teamName: string;
  logoUrl: string | null;
  scorer: TopRow | null;
  assist: TopRow | null;
  cards: CardsTeamRow | null;
  away?: boolean;
}) {
  return (
    <div className={`pl-col${away ? " away" : ""}`}>
      <b className="pl-team">
        <TeamLogo name={teamName} url={logoUrl} size={16} />
        {teamName}
      </b>
      <div className="pl-row">
        <span className="pl-k">头号射手</span>
        {scorer ? (
          <span className="pl-v">
            <b>{scorer.playerName}</b> {scorer.count} 球
          </span>
        ) : (
          <span className="pl-v muted">暂无</span>
        )}
      </div>
      <div className="pl-row">
        <span className="pl-k">助攻王</span>
        {assist ? (
          <span className="pl-v">
            <b>{assist.playerName}</b> {assist.count} 助
          </span>
        ) : (
          <span className="pl-v muted">暂无</span>
        )}
      </div>
      <div className="pl-row">
        <span className="pl-k">球队纪律</span>
        <span className="pl-v pl-cards">
          <span>
            <CardIcon kind="yellow" />×{cards?.yellows ?? 0}
          </span>
          <span>
            <CardIcon kind="red" />×{cards?.reds ?? 0}
          </span>
        </span>
      </div>
    </div>
  );
}

// 本场已提交的阵容（教练视角）：赛前只回本队那份，对手阵容既不显示也不提示
function MyLineupPanel({ l }: { l: TeamLineupDTO }) {
  const slots: Map<number, MiniSlot> = new Map(
    l.starters.map((s) => [s.lid, { name: s.name, number: s.number }]),
  );
  return (
    <div className="pmt-sec">
      <p className="pmt-mine-head">
        <b>
          {l.teamName} · {formTitle(l.form)}
        </b>
        <span className="muted">这是你提交的本场阵容，赛前只有本队账号能看到，开赛后公开</span>
      </p>
      <MiniPitch form={l.form} slots={slots} />
      {l.bench.length > 0 && (
        <p className="lu-bench">
          替补：
          {l.bench.map((b) => `${b.number ? `#${b.number} ` : ""}${b.name ?? "已离队"}`).join("、")}
        </p>
      )}
      <p className="muted pmt-mine-meta">
        提交于 {l.submittedAt.slice(0, 16).replace("T", " ")}
        {l.submittedBy ? ` · ${l.submittedBy}` : ""}
      </p>
    </div>
  );
}

// ---------- 阵容 ----------

function LineupPanel({ tid, match }: { tid: number; match: MatchDTO }) {
  const { data: d, fail } = useFetch<LineupStatsDTO>(
    `/api/public/tournaments/${tid}/matches/${match.id}/lineup-stats`,
  );
  if (fail) return null;
  if (!d) return <Loading />;
  if (!d.home && !d.away) return <p className="muted pmt-empty">两队还没有阵容记录。</p>;
  return (
    <div className="pmt-sec">
      <p className="h2h-fact">未提交阵容的场次自动按上一场的阵容计。</p>
      <div className="lu-duel">
        {d.home && <TacticsCol t={d.home} />}
        {d.away && <TacticsCol t={d.away} />}
      </div>
    </div>
  );
}

function TacticsCol({ t }: { t: TeamTacticsDTO }) {
  const slotMap = new Map(t.typicalXI.map((x) => [x.lid, x]));
  return (
    <div className="tac-col">
      <b className="pl-team">
        <TeamLogo name={t.teamName} size={16} />
        {t.teamName}
      </b>
      <p className="tac-forms">{t.forms.map((f) => `${formTitle(f.form)} ×${f.n}`).join(" · ")}</p>
      {t.typicalForm && <MiniPitch form={t.typicalForm} slots={slotMap} />}
      {t.topStarter && (
        <p className="tac-top">
          首发王 <b>{t.topStarter.name}</b>
          {t.topStarter.position &&
            `（${POS_ZH[t.topStarter.position] ?? t.topStarter.position}）`}{" "}
          ×{t.topStarter.starts}
        </p>
      )}
      <p className="muted tac-meta">
        按最近 {t.sampleSize} 场计 · 真实提交 {t.realSubmissions} 场
      </p>
    </div>
  );
}

// starts 只有历史统计（cross-match 常用阵型）才有，本场提交的阵容不传
type MiniSlot = { name: string | null; number: string | null; starts?: number };

function MiniPitch({ form, slots }: { form: string; slots: Map<number, MiniSlot> }) {
  const def = FORMS.find((f) => f.value === form);
  if (!def) return null;
  const xys = tilePositions(def.pos.map((p) => p.position));
  return (
    <div className="h2h-pitch">
      <PitchSvg />
      {def.pos.map((p, i) => {
        const [x, y] = xys[i];
        const pl = slots.get(p.lid);
        const posZh = POS_ZH[p.position] ?? p.position;
        return (
          <span
            key={p.lid}
            className="h2h-tile"
            style={{ left: `${x}%`, top: `${100 - y}%` }}
            title={
              pl
                ? `${pl.name ?? "已离队"}${pl.starts != null ? ` 首发×${pl.starts}` : ""}`
                : `${posZh}（窗口内无人首发）`
            }
          >
            <b>{p.position}</b>
            {pl ? (
              <>
                <small>
                  {pl.number ? `#${pl.number} ` : ""}
                  {pl.name ?? "已离队"}
                </small>
                {pl.starts != null && <i className="h2h-tile-n">×{pl.starts}</i>}
              </>
            ) : (
              <small className="h2h-tile-none">{posZh}</small>
            )}
          </span>
        );
      })}
    </div>
  );
}

function PitchSvg() {
  return (
    <svg viewBox="0 0 100 130" preserveAspectRatio="none" aria-hidden="true">
      <g fill="none" stroke="rgba(244,246,243,.75)" strokeWidth=".6">
        <rect x="3" y="3" width="94" height="124" />
        <line x1="3" y1="65" x2="97" y2="65" />
        <circle cx="50" cy="65" r="13" />
        <rect x="27" y="114" width="46" height="13" />
        <rect x="38.5" y="124" width="23" height="3" />
        <path d="M36 114 A 14 14 0 0 1 64 114" />
        <rect x="27" y="3" width="46" height="13" />
        <rect x="38.5" y="3" width="23" height="3" />
        <path d="M36 16 A 14 14 0 0 0 64 16" />
        <path d="M3 5 A 2 2 0 0 0 5 3" />
        <path d="M97 5 A 2 2 0 0 1 95 3" />
        <path d="M3 125 A 2 2 0 0 1 5 127" />
        <path d="M97 125 A 2 2 0 0 0 95 127" />
      </g>
      <g fill="rgba(244,246,243,.75)">
        <circle cx="50" cy="65" r=".9" />
        <circle cx="50" cy="120.5" r=".8" />
        <circle cx="50" cy="9.5" r=".8" />
      </g>
    </svg>
  );
}
