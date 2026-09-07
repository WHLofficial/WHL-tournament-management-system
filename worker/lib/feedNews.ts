// #13 头版门户：快讯流与周报引擎。
// 快讯是读时现算的纯派生物——事实成立条目即在，pubCache 控制重算频率（每边缘节点每 60s 至多一次）；
// 同数据同输出（确定性 item_id + 稳定排序），数据变动自动重算，无陈旧新闻。
// 时效梯度：红牌(live 即时报) → 战报(终场) → 综述(全轮) → 周报(周末)。
import type { D1Database } from "@cloudflare/workers-types";
import type { FeedItemDTO, RecapDTO, WeeklyDTO, WeeklyMatchDTO } from "../../shared/news";
import type { RawEvent, FinishedMatch } from "./context";
import { pickText } from "../../shared/textpick";
import {
  currentStreaks,
  fetchEventRows,
  fetchFinishedWindow,
  fetchRoundFinished,
  fetchStageMaxRounds,
  fetchTournamentFinished,
  rankRowsSimple,
  redCardBanSuffix,
  roundLabel,
  standingsSnapshot,
  subtractMatchContribution,
} from "./context";

// ---------- 周报（自然周，周一起算，UTC 口径；本周空回退最近有比赛的一周） ----------

const WEEK_MS = 7 * 24 * 3600 * 1000;

function mondayUTC(d: Date): Date {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (t.getUTCDay() + 6) % 7; // 周一=0
  t.setUTCDate(t.getUTCDate() - dow);
  return t;
}

function weekKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function weekMatches(db: D1Database, startISO: string, endISO: string): Promise<FinishedMatch[]> {
  const res = await db
    .prepare(
      `SELECT m.id, m.stage_id, s.tournament_id, t.name AS tournament_name,
         s.kind AS stage_kind, s.name AS stage_name, m.round,
         m.home_entry_id, m.away_entry_id,
         ht.name AS home_team_name, at.name AS away_team_name,
         ht.logo_key AS home_logo_key, at.logo_key AS away_logo_key,
         m.score_home, m.score_away, m.pen_home, m.pen_away,
         m.walkover_side, m.note, m.status, m.finished_at
       FROM match m
       JOIN stage s ON s.id = m.stage_id
       JOIN tournament t ON t.id = s.tournament_id
       JOIN entry he ON he.id = m.home_entry_id
       JOIN team ht ON ht.id = he.team_id
       JOIN entry ae ON ae.id = m.away_entry_id
       JOIN team at ON at.id = ae.team_id
       WHERE t.status != 'draft' AND m.status = 'finished'
         AND m.finished_at >= ? AND m.finished_at < ?
       ORDER BY m.finished_at DESC, m.id DESC`
    )
    .bind(startISO, endISO)
    .all<{
      id: number; stage_id: number; tournament_id: number; tournament_name: string;
      stage_kind: "elim" | "round_robin" | "group"; stage_name: string | null; round: number;
      home_entry_id: number; away_entry_id: number;
      home_team_name: string; away_team_name: string;
      home_logo_key: string | null; away_logo_key: string | null;
      score_home: number; score_away: number;
      pen_home: number | null; pen_away: number | null;
      walkover_side: string | null; note: string | null;
      status: "pending" | "live" | "finished"; finished_at: string | null;
    }>();
  const rows = res.results ?? [];
  return rows.map((r) => ({
    id: r.id,
    stageId: r.stage_id,
    tournamentId: r.tournament_id,
    tournamentName: r.tournament_name,
    stageKind: r.stage_kind,
    stageName: r.stage_name,
    round: r.round,
    homeEntryId: r.home_entry_id,
    awayEntryId: r.away_entry_id,
    homeTeamName: r.home_team_name,
    awayTeamName: r.away_team_name,
    homeLogoUrl: null,
    awayLogoUrl: null,
    scoreHome: r.score_home,
    scoreAway: r.score_away,
    penHome: r.pen_home,
    penAway: r.pen_away,
    walkoverSide: r.walkover_side ?? "",
    note: r.note,
    status: r.status,
    finishedAt: r.finished_at,
  }));
}

const fmtMD = (iso: string): string => iso.slice(5, 7) + "." + iso.slice(8, 10);

export async function buildWeekly(db: D1Database, weekParam?: string): Promise<WeeklyDTO> {
  const nowMonday = mondayUTC(new Date());
  let start = weekParam ? mondayUTC(new Date(`${weekParam}T00:00:00Z`)) : nowMonday;
  // 指定周不强回退（空周就是空态）；「本周」无比赛时回退最近有比赛的一周（最多回溯 8 周）
  let list: FinishedMatch[] = [];
  let isFallback = false;
  if (weekParam) {
    list = await weekMatches(db, weekKey(start), weekKey(new Date(start.getTime() + WEEK_MS)));
  } else {
    list = await weekMatches(db, weekKey(start), weekKey(new Date(start.getTime() + WEEK_MS)));
    if (list.length === 0) {
      for (let i = 1; i <= 8; i++) {
        const s = new Date(start.getTime() - i * WEEK_MS);
        const l = await weekMatches(db, weekKey(s), weekKey(new Date(s.getTime() + WEEK_MS)));
        if (l.length > 0) {
          start = s;
          list = l;
          isFallback = true;
          break;
        }
      }
    }
  }
  const end = new Date(start.getTime() + WEEK_MS);

  // 事件（乌龙数 / 本周射手王）
  const eventsByMatch = await fetchEventRows(db, list.map((m) => m.id));
  let ownGoals = 0;
  for (const m of list) {
    for (const e of eventsByMatch.get(m.id) ?? []) {
      if (e.type === "own_goal") ownGoals += 1;
    }
  }
  const topScorer = topScorerOf(eventsByMatch, list);

  // 聚合：进球含弃权判负记分（0:3 与积分榜口径一致）；零封/最佳防守不计弃权场
  let goals = 0;
  let cleanSheets = 0;
  let biggestMargin: WeeklyDTO["biggestMargin"] = null;
  let bestDiff = 0;
  const teamConceded = new Map<string, { conceded: number; played: number }>();
  for (const m of list) {
    goals += m.scoreHome + m.scoreAway;
    const diff = Math.abs(m.scoreHome - m.scoreAway);
    if (diff > bestDiff) {
      bestDiff = diff;
      biggestMargin = { matchId: m.id, tournamentId: m.tournamentId, score: `${m.scoreHome}:${m.scoreAway}` };
    }
    const wo = m.walkoverSide !== "";
    if (!wo) {
      if (m.scoreHome === 0 || m.scoreAway === 0) cleanSheets += 1;
      for (const [name, conceded] of [
        [m.homeTeamName, m.scoreAway],
        [m.awayTeamName, m.scoreHome],
      ] as const) {
        const cur = teamConceded.get(name) ?? { conceded: 0, played: 0 };
        cur.conceded += conceded;
        cur.played += 1;
        teamConceded.set(name, cur);
      }
    }
  }
  let bestDefense: WeeklyDTO["bestDefense"] = null;
  for (const [teamName, v] of teamConceded) {
    if (v.played === 0) continue;
    if (!bestDefense || v.conceded < bestDefense.conceded) bestDefense = { teamName, conceded: v.conceded };
  }

  const matches: WeeklyMatchDTO[] = list.map(toWeeklyMatch);

  return {
    weekStart: weekKey(start),
    label: `${fmtMD(weekKey(start))} – ${fmtMD(weekKey(end))}`,
    isFallback,
    played: list.length,
    goals,
    biggestMargin,
    cleanSheets,
    ownGoals,
    topScorer,
    bestDefense,
    matches,
  };
}

// ---------- 轮次聚合（综述快讯条与综述页共用） ----------

function toWeeklyMatch(m: FinishedMatch): WeeklyMatchDTO {
  return {
    matchId: m.id,
    tournamentId: m.tournamentId,
    tournamentName: m.tournamentName,
    homeTeamName: m.homeTeamName,
    awayTeamName: m.awayTeamName,
    scoreHome: m.scoreHome,
    scoreAway: m.scoreAway,
    finishedAt: m.finishedAt,
  };
}

function roundAgg(list: FinishedMatch[]) {
  let goals = 0;
  let cleanSheets = 0;
  let bestDiff = 0;
  let biggestMargin: { matchId: number; label: string; score: string } | null = null;
  for (const m of list) {
    goals += m.scoreHome + m.scoreAway; // 弃权判负记分与积分榜口径一致
    const diff = Math.abs(m.scoreHome - m.scoreAway);
    if (diff > bestDiff) {
      bestDiff = diff;
      biggestMargin = {
        matchId: m.id,
        label: `${m.homeTeamName} vs ${m.awayTeamName}`,
        score: `${m.scoreHome}:${m.scoreAway}`,
      };
    }
    if (m.walkoverSide === "" && (m.scoreHome === 0 || m.scoreAway === 0)) cleanSheets += 1;
  }
  return { played: list.length, goals, cleanSheets, biggestMargin };
}

// 射手王（goal/pen_goal，同人聚合，乌龙不计）：周报与综述共用
function topScorerOf(
  eventsByMatch: Map<number, RawEvent[]>,
  list: FinishedMatch[],
): { name: string; teamName: string; goals: number } | null {
  const scorerGoals = new Map<string, { name: string; teamName: string; goals: number }>();
  for (const m of list) {
    for (const e of eventsByMatch.get(m.id) ?? []) {
      if ((e.type !== "goal" && e.type !== "pen_goal") || !e.playerName) continue;
      const cur = scorerGoals.get(e.playerName) ?? { name: e.playerName, teamName: "", goals: 0 };
      cur.goals += 1;
      if (!cur.teamName) {
        cur.teamName = e.entryId === m.homeEntryId ? m.homeTeamName : m.awayTeamName;
      }
      scorerGoals.set(e.playerName, cur);
    }
  }
  return (
    [...scorerGoals.values()].sort((a, b) => b.goals - a.goals || a.name.localeCompare(b.name, "zh"))[0] ??
    null
  );
}

// ---------- 叙事事实：按「该场完赛时刻」重放 ----------
// 积分榜快照/射手榜都是「当前值」，直接给历史窗口比赛贴叙事会张冠李戴（后打的球算进前头的里程碑）。
// 这里统一重放：射手账本逐场滚动；榜首判定把后续场次的贡献从当前榜里扣回去。

interface ScorerRow {
  playerId: number;
  name: string;
  teamName: string;
  goals: number;
}

interface NarrativeFacts {
  finAsc: FinishedMatch[]; // 该赛事全部完赛场（升序）
  scorersAt: Map<number, { before: ScorerRow[]; after: ScorerRow[] }>; // 窗口比赛的赛前/赛后射手榜
}

async function buildNarrativeFacts(
  db: D1Database,
  tid: number,
  wantedMatchIds: Set<number>,
): Promise<NarrativeFacts> {
  const finAsc = await fetchTournamentFinished(db, tid);
  const scorersAt = new Map<number, { before: ScorerRow[]; after: ScorerRow[] }>();
  if (wantedMatchIds.size === 0) return { finAsc, scorersAt };
  const evAll = await fetchEventRows(
    db,
    finAsc.map((m) => m.id),
  );
  const ledger = new Map<number, { name: string; teamName: string; goals: number }>();
  const sortedLedger = (): ScorerRow[] =>
    [...ledger.entries()]
      .map(([playerId, v]) => ({ playerId, ...v }))
      .sort((a, b) => b.goals - a.goals || a.name.localeCompare(b.name, "zh"));
  for (const m of finAsc) {
    const cap = wantedMatchIds.has(m.id) ? { before: sortedLedger(), after: [] as ScorerRow[] } : null;
    if (cap) scorersAt.set(m.id, cap);
    for (const e of evAll.get(m.id) ?? []) {
      if ((e.type !== "goal" && e.type !== "pen_goal") || e.playerId == null) continue;
      const cur = ledger.get(e.playerId) ?? { name: e.playerName ?? "未知球员", teamName: "", goals: 0 };
      cur.goals += 1;
      if (!cur.teamName) {
        cur.teamName = e.entryId === m.homeEntryId ? m.homeTeamName : m.awayTeamName;
      }
      ledger.set(e.playerId, cur);
    }
    if (cap) cap.after = sortedLedger();
  }
  return { finAsc, scorersAt };
}

// 某队最近 n 场（从升序列表尾部往前取）的进失/胜负累计，纪录条 body 用
function entryTail(cutAsc: FinishedMatch[], entryId: number, n: number) {
  let gf = 0,
    ga = 0,
    w = 0,
    d = 0,
    taken = 0;
  for (let i = cutAsc.length - 1; i >= 0 && taken < n; i--) {
    const m = cutAsc[i];
    if (m.homeEntryId !== entryId && m.awayEntryId !== entryId) continue;
    const isHome = m.homeEntryId === entryId;
    const egf = isHome ? m.scoreHome : m.scoreAway;
    const ega = isHome ? m.scoreAway : m.scoreHome;
    gf += egf;
    ga += ega;
    if (m.walkoverSide !== "both") {
      if (egf > ega) w += 1;
      else if (egf === ega) d += 1;
    }
    taken += 1;
  }
  return { gf, ga, w, d };
}

// ---------- 快讯流 ----------

// 进球摘要：同人聚合、乌龙标 OG、点球不特殊标注；返回三种句式（名单 / 带球数 / 带分钟），由快讯条按种子选一
function goalSummaries(events: RawEvent[]): string[] {
  const per = new Map<string, { n: number; mins: (number | null)[]; og: boolean }>();
  for (const e of events) {
    if (e.type !== "goal" && e.type !== "pen_goal" && e.type !== "own_goal") continue;
    const name = e.playerName ?? "未知球员";
    const cur = per.get(name) ?? { n: 0, mins: [], og: false };
    cur.n += 1;
    cur.mins.push(e.minute ?? null);
    if (e.type === "own_goal") cur.og = true;
    per.set(name, cur);
  }
  if (per.size === 0) return [];
  const list = [...per.entries()];
  return [
    list.map(([name, v]) => `${name}${v.og ? "(OG)" : ""}`).join(" · "),
    list.map(([name, v]) => `${name}${v.og ? "(OG)" : ""}${v.n > 1 ? `（${v.n} 球）` : ""}`).join(" · "),
    list
      .map(([name, v]) =>
        v.mins.some((m) => m === null)
          ? `${name}${v.og ? "(OG)" : ""}`
          : `${name}${v.og ? "(OG)" : ""} ${v.mins.map((m) => `${m}'`).join("、")}`,
      )
      .join(" · "),
  ];
}

export async function buildFeed(
  db: D1Database,
  opts: { limit?: number; before?: string } = {},
): Promise<FeedItemDTO[]> {
  const cap = Math.min(Math.max(opts.limit ?? 15, 1), 50);
  const before = opts.before;
  const items: FeedItemDTO[] = [];

  // 1) 完赛窗口 → 战报/弃权条（窗口取深些给混排留余量）
  const window = await fetchFinishedWindow(db, Math.max(cap * 3, 40), before);
  const eventsByMatch = await fetchEventRows(db, window.map((m) => m.id));
  const maxRounds = await fetchStageMaxRounds(db, window.map((m) => m.stageId));
  for (const m of window) {
    const rl = roundLabel(m, maxRounds.get(m.stageId) ?? m.round);
    const base = {
      at: m.finishedAt,
      tournamentId: m.tournamentId,
      tournamentName: m.tournamentName,
      matchId: m.id,
      homeTeamName: m.homeTeamName,
      awayTeamName: m.awayTeamName,
      homeLogoUrl: m.homeLogoUrl,
      awayLogoUrl: m.awayLogoUrl,
      scoreHome: m.scoreHome,
      scoreAway: m.scoreAway,
      roundLabel: rl,
    };
    if (m.walkoverSide === "home" || m.walkoverSide === "away" || m.walkoverSide === "both") {
      const loser =
        m.walkoverSide === "home" ? m.homeTeamName : m.walkoverSide === "away" ? m.awayTeamName : null;
      const winner = loser ? (loser === m.homeTeamName ? m.awayTeamName : m.homeTeamName) : null;
      items.push({
        ...base,
        id: `wo:${m.id}`,
        kind: "walkover",
        title:
          m.walkoverSide === "both"
            ? `${m.homeTeamName} 与 ${m.awayTeamName} 双双弃权`
            : `${loser} 弃权，${winner} 不战而胜`,
        body: pickText(`wo:${m.id}`, [
          `${rl}｜比分记 ${m.scoreHome}:${m.scoreAway}${m.note ? `（${m.note}）` : ""}`,
          `${rl}｜判定比分 ${m.scoreHome}:${m.scoreAway}${m.note ? `，${m.note}` : ""}`,
        ]),
      });
    } else {
      const summaries = goalSummaries(eventsByMatch.get(m.id) ?? []);
      const goalless = m.scoreHome === 0 && m.scoreAway === 0;
      items.push({
        ...base,
        id: `match:${m.id}`,
        kind: "match",
        title: `${rl}｜${m.homeTeamName} ${m.scoreHome}:${m.scoreAway} ${m.awayTeamName}`,
        body: summaries.length
          ? pickText(`mb:${m.id}`, summaries)
          : goalless
            ? pickText(`ng:${m.id}`, ["双方均无进球入账", "两队都没能敲开对方球门", "互交白卷，比分没有改写"])
            : `比分 ${m.scoreHome}:${m.scoreAway}，进球明细未录入`,
      });
    }
  }

  // 1.5) 叙事条：榜首易主 / 纪录 / 里程碑——全部按「该场完赛时刻」口径重放
  const wantedByTid = new Map<number, Set<number>>();
  for (const m of window) {
    const s = wantedByTid.get(m.tournamentId) ?? new Set<number>();
    s.add(m.id);
    wantedByTid.set(m.tournamentId, s);
  }
  const factsEntries = await Promise.all(
    [...wantedByTid.entries()].map(
      async ([tid, wanted]) => [tid, await buildNarrativeFacts(db, tid, wanted)] as const,
    ),
  );
  const factsByTid = new Map(factsEntries);
  const snapEntries = await Promise.all(
    [...new Set(window.map((m) => m.stageId))].map(
      async (sid) => [sid, await standingsSnapshot(db, sid)] as const,
    ),
  );
  const snapMap = new Map(snapEntries);

  for (const m of window) {
    const facts = factsByTid.get(m.tournamentId);
    if (!facts) continue;
    const rl = roundLabel(m, maxRounds.get(m.stageId) ?? m.round);
    const base = {
      at: m.finishedAt,
      tournamentId: m.tournamentId,
      tournamentName: m.tournamentName,
      matchId: m.id,
    };
    const finAsc = facts.finAsc;
    const stageFinished = finAsc.filter((f) => f.stageId === m.stageId);
    const pos = stageFinished.findIndex((f) => f.id === m.id);
    const cut = pos >= 0 ? finAsc.slice(0, pos + 1) : null;

    // a) 榜首易主：当前榜扣掉「本场之后」完赛的贡献 = 该场完赛时刻的赛后榜；
    //    多组小组赛跨组排名无意义，不报
    const snap = snapMap.get(m.stageId) ?? null;
    if (
      snap &&
      cut &&
      pos >= 0 &&
      new Set(snap.rows.map((r) => r.groupId ?? 0)).size <= 1
    ) {
      const afterRows = snap.rows.map((r) => ({ ...r }));
      let replayable = true;
      for (let i = pos + 1; i < stageFinished.length; i++) {
        if (!subtractMatchContribution(afterRows, stageFinished[i])) {
          replayable = false;
          break;
        }
      }
      if (replayable) {
        rankRowsSimple(afterRows);
        const beforeRows = afterRows.map((r) => ({ ...r }));
        if (subtractMatchContribution(beforeRows, m)) {
          rankRowsSimple(beforeRows);
          const newL = afterRows[0];
          const oldL = beforeRows[0];
          const hB = beforeRows.find((r) => r.entryId === m.homeEntryId);
          const aB = beforeRows.find((r) => r.entryId === m.awayEntryId);
          if (
            newL &&
            oldL &&
            newL.entryId !== oldL.entryId &&
            (newL.entryId === m.homeEntryId || newL.entryId === m.awayEntryId) &&
            hB &&
            aB &&
            hB.played > 0 &&
            aB.played > 0
          ) {
            const gap = afterRows.length > 1 ? newL.pts - afterRows[1].pts : 0;
            items.push({
              ...base,
              id: `leader:${m.id}`,
              kind: "leader",
              title: pickText(`ld:${m.id}`, [`${newL.teamName} 登顶积分榜`, `积分榜易主，${newL.teamName} 登上头名`]),
              body: pickText(`ldb:${m.id}`, [
                `${rl}过后反超 ${oldL.teamName}${gap > 0 ? `，领先 ${gap} 分` : ""}`,
                `把 ${oldL.teamName} 挤下头名（${rl}）${gap > 0 ? `，领先 ${gap} 分` : ""}`,
              ]),
            });
          }
        }
      }
    }

    // b) 纪录：每队每场至多一条（连胜 ≥3 > 不败 ≥5 > 零封 ≥2），该场即延长纪录的那一场
    if (cut) {
      for (const entryId of [m.homeEntryId, m.awayEntryId]) {
        const teamName = entryId === m.homeEntryId ? m.homeTeamName : m.awayTeamName;
        const st = currentStreaks(cut, entryId);
        let title = "";
        let body = "";
        if (st.win >= 3) {
          const t = entryTail(cut, entryId, st.win);
          title = pickText(`sw:${m.id}:${entryId}`, [`${teamName} ${st.win} 连胜`, `${teamName} 斩获${st.win}连胜`]);
          body = pickText(`swb:${m.id}:${entryId}`, [
            `${rl}｜近 ${st.win} 场全胜，进 ${t.gf} 球失 ${t.ga} 球`,
            `${rl}｜${st.win} 连胜期间进 ${t.gf} 球失 ${t.ga} 球`,
          ]);
        } else if (st.unbeaten >= 5) {
          const t = entryTail(cut, entryId, st.unbeaten);
          title = pickText(`su:${m.id}:${entryId}`, [
            `${teamName} 连续 ${st.unbeaten} 场不败`,
            `${teamName} 已连续 ${st.unbeaten} 场不败`,
          ]);
          body = pickText(`sub:${m.id}:${entryId}`, [
            `${rl}｜近 ${st.unbeaten} 场 ${t.w} 胜 ${t.d} 平，进 ${t.gf} 球失 ${t.ga} 球`,
            `${rl}｜${st.unbeaten} 场 ${t.w} 胜 ${t.d} 平，还未尝败绩`,
          ]);
        } else if (st.cleanSheet >= 2) {
          const t = entryTail(cut, entryId, st.cleanSheet);
          title = pickText(`sc:${m.id}:${entryId}`, [
            `${teamName} 连续 ${st.cleanSheet} 场零封`,
            `${teamName} 的球门连续 ${st.cleanSheet} 场未被攻破`,
          ]);
          body = pickText(`scb:${m.id}:${entryId}`, [
            `${rl}｜近 ${st.cleanSheet} 场零封，进 ${t.gf} 球`,
            `${rl}｜连续 ${st.cleanSheet} 场零封，期间打进 ${t.gf} 球`,
          ]);
        }
        if (title) {
          items.push({ ...base, id: `streak:${m.id}:${entryId}`, kind: "streak", title, body });
        }
      }
    }

    // c) 里程碑：进球数达成 5 的倍数，或登顶射手榜（≥2 球门槛防开局噪音），每名射手每场至多一条
    const sc = facts.scorersAt.get(m.id);
    if (sc) {
      const seen = new Set<number>();
      for (const e of eventsByMatch.get(m.id) ?? []) {
        if ((e.type !== "goal" && e.type !== "pen_goal") || e.playerId == null || seen.has(e.playerId))
          continue;
        seen.add(e.playerId);
        const afterRow = sc.after.find((p) => p.playerId === e.playerId);
        if (!afterRow) continue;
        const rankAfter = sc.after.indexOf(afterRow) + 1;
        const beforeIdx = sc.before.findIndex((p) => p.playerId === e.playerId);
        if (afterRow.goals % 5 === 0) {
          items.push({
            ...base,
            id: `milestone:${m.id}:${e.playerId}`,
            kind: "milestone",
            title: pickText(`mg:${m.id}:${e.playerId}`, [
              `${afterRow.name} 达成本届第 ${afterRow.goals} 球`,
              `${afterRow.name} 攻入本届第 ${afterRow.goals} 球`,
            ]),
            body: pickText(`mgb:${m.id}:${e.playerId}`, [
              `${rl}｜代表 ${afterRow.teamName}，本届进球来到 ${afterRow.goals} 个`,
              `${rl}｜为 ${afterRow.teamName} 出战，本届进球数来到 ${afterRow.goals}`,
            ]),
          });
        } else if (rankAfter === 1 && beforeIdx !== 0 && afterRow.goals >= 2) {
          items.push({
            ...base,
            id: `milestone:${m.id}:${e.playerId}`,
            kind: "milestone",
            title: pickText(`mt:${m.id}:${e.playerId}`, [
              `${afterRow.name} 登顶射手榜`,
              `${afterRow.name} 升至射手榜头名`,
            ]),
            body: pickText(`mtb:${m.id}:${e.playerId}`, [
              `${rl}过后以 ${afterRow.goals} 球升至射手榜首位`,
              `${rl}｜${afterRow.goals} 球，抢下射手榜第一`,
            ]),
          });
        }
      }
    }
  }

  // 2) 红牌即时快讯（live/finished 都算，录入即出条）
  type RedRow = {
    id: number; type: "red" | "red_2y"; created_at: string;
    player_name: string | null;
    match_id: number; tournament_id: number; tournament_name: string;
    stage_kind: "elim" | "round_robin" | "group"; stage_name: string | null; round: number; stage_id: number;
  };
  const redRes = await db
    .prepare(
      `SELECT me.id, me.type, me.created_at, p.name AS player_name,
         m.id AS match_id, t.id AS tournament_id, t.name AS tournament_name,
         s.kind AS stage_kind, s.name AS stage_name, s.id AS stage_id, m.round
       FROM match_event me
       JOIN match m ON m.id = me.match_id
       JOIN stage s ON s.id = m.stage_id
       JOIN tournament t ON t.id = s.tournament_id
       LEFT JOIN player p ON p.id = me.player_id
       WHERE me.type IN ('red', 'red_2y') AND t.status != 'draft'
         ${before ? "AND me.created_at < ?" : ""}
       ORDER BY me.created_at DESC, me.id DESC LIMIT ${cap}`
    )
    .bind(...(before ? [before] : []))
    .all<RedRow>();
  const redRows = redRes.results ?? [];
  const redMaxRounds = await fetchStageMaxRounds(db, redRows.map((r) => r.stage_id));
  const banSuffixes = await Promise.all(redRows.map((r) => redCardBanSuffix(db, r.tournament_id, r.type)));
  for (let i = 0; i < redRows.length; i++) {
    const r = redRows[i];
    items.push({
      id: `discipline:${r.id}`,
      kind: "discipline",
      at: r.created_at,
      tournamentId: r.tournament_id,
      tournamentName: r.tournament_name,
      matchId: r.match_id,
      title: pickText(`dp:${r.id}`, [
        `${r.player_name ?? "球员"} ${r.type === "red" ? "直红" : "两黄变一红"}被罚下`,
        r.type === "red" ? `${r.player_name ?? "球员"} 吃到红牌` : `${r.player_name ?? "球员"} 两黄变红离场`,
      ]),
      body: `${roundLabel(
        { stageKind: r.stage_kind, stageName: r.stage_name, round: r.round },
        redMaxRounds.get(r.stage_id) ?? r.round,
      )}${banSuffixes[i]}`,
    });
  }

  // 3) 更正启事（改判审计）
  type AuditRow = {
    id: number; created_at: string; target_id: number; detail_json: string | null;
    tournament_id: number; tournament_name: string;
    home_team_name: string; away_team_name: string;
    stage_kind: "elim" | "round_robin" | "group"; stage_name: string | null; stage_id: number; round: number;
  };
  const auditRes = await db
    .prepare(
      `SELECT a.id, a.created_at, a.target_id, a.detail_json,
         t.id AS tournament_id, t.name AS tournament_name,
         ht.name AS home_team_name, at.name AS away_team_name,
         s.kind AS stage_kind, s.name AS stage_name, s.id AS stage_id, m.round
       FROM audit_log a
       JOIN match m ON m.id = a.target_id
       JOIN stage s ON s.id = m.stage_id
       JOIN tournament t ON t.id = s.tournament_id
       JOIN entry he ON he.id = m.home_entry_id
       JOIN team ht ON ht.id = he.team_id
       JOIN entry ae ON ae.id = m.away_entry_id
       JOIN team at ON at.id = ae.team_id
       WHERE a.action = 'match_rescore' AND t.status != 'draft'
         ${before ? "AND a.created_at < ?" : ""}
       ORDER BY a.id DESC LIMIT ${cap}`
    )
    .bind(...(before ? [before] : []))
    .all<AuditRow>();
  for (const a of auditRes.results ?? []) {
    let body = pickText(`ra:${a.id}`, ["比分经复核更正", "赛后比分复核有变"]);
    try {
      const d = JSON.parse(a.detail_json ?? "{}") as {
        old?: { scoreHome?: number | null; scoreAway?: number | null };
        new?: { scoreHome?: number | null; scoreAway?: number | null };
      };
      if (d.old && d.new) {
        body = pickText(`rr:${a.id}`, [
          `比分由 ${d.old.scoreHome}:${d.old.scoreAway} 更正为 ${d.new.scoreHome}:${d.new.scoreAway}`,
          `经复核，比分从 ${d.old.scoreHome}:${d.old.scoreAway} 改为 ${d.new.scoreHome}:${d.new.scoreAway}`,
        ]);
      }
    } catch {
      // detail 解析失败退化为通用文案
    }
    items.push({
      id: `rescore:${a.id}`,
      kind: "rescore",
      at: a.created_at,
      tournamentId: a.tournament_id,
      tournamentName: a.tournament_name,
      matchId: a.target_id,
      title: `更正启事｜${a.home_team_name} vs ${a.away_team_name}`,
      body,
    });
  }

  // 3.5) 轮次综述条：最近完赛的 5 个「全轮完赛」轮次（详情走综述端点）
  type RecapGroupRow = {
    stage_id: number;
    round: number;
    last_at: string | null;
    tournament_id: number;
    tournament_name: string;
    stage_kind: "elim" | "round_robin" | "group";
    stage_name: string | null;
  };
  const recapRes = await db
    .prepare(
      `SELECT m.stage_id, m.round, MAX(m.finished_at) AS last_at,
         s.tournament_id, t.name AS tournament_name,
         s.kind AS stage_kind, s.name AS stage_name
       FROM match m
       JOIN stage s ON s.id = m.stage_id
       JOIN tournament t ON t.id = s.tournament_id
       WHERE t.status != 'draft' AND m.home_entry_id IS NOT NULL AND m.away_entry_id IS NOT NULL
         AND COALESCE(m.note, '') != '轮空'
       GROUP BY m.stage_id, m.round
       HAVING COUNT(*) = SUM(CASE WHEN m.status = 'finished' THEN 1 ELSE 0 END)
         AND MAX(m.finished_at) < COALESCE(?, '9999-12-31')
       ORDER BY last_at DESC, stage_id DESC, round DESC LIMIT ${cap}`,
    )
    .bind(before ?? "9999-12-31")
    .all<RecapGroupRow>();
  const recapRows = recapRes.results ?? [];
  const recapMaxRounds = await fetchStageMaxRounds(db, recapRows.map((r) => r.stage_id));
  const recapLists = await Promise.all(
    recapRows.map((r) => fetchRoundFinished(db, r.stage_id, r.round)),
  );
  for (let i = 0; i < recapRows.length; i++) {
    const g = recapRows[i];
    const agg = roundAgg(recapLists[i]);
    if (agg.played === 0) continue;
    const rl = roundLabel(
      { stageKind: g.stage_kind, stageName: g.stage_name, round: g.round },
      recapMaxRounds.get(g.stage_id) ?? g.round,
    );
    items.push({
      id: `recap:${g.stage_id}:${g.round}`,
      kind: "recap",
      at: g.last_at,
      tournamentId: g.tournament_id,
      tournamentName: g.tournament_name,
      stageId: g.stage_id,
      round: g.round,
      title: `${rl}综述｜${agg.played} 场 ${agg.goals} 球`,
      body: agg.biggestMargin
        ? pickText(`rb:${g.stage_id}:${g.round}`, [
            `最大分差 ${agg.biggestMargin.score}（${agg.biggestMargin.label}）`,
            `单场最悬殊：${agg.biggestMargin.label} 打出 ${agg.biggestMargin.score}`,
          ])
        : pickText(`rb0:${g.stage_id}:${g.round}`, [
            `${agg.played} 场比赛全部完赛`,
            `${agg.played} 场比赛已全部打完`,
          ]),
    });
  }

  // 4) 周报条（本周/回退周有比赛才出）
  const weekly = await buildWeekly(db);
  if (weekly.played > 0) {
    const weeklyAt = weekly.matches[0]?.finishedAt ?? `${weekly.weekStart}T00:00:00Z`;
    if (!before || (weeklyAt && weeklyAt < before)) {
      items.push({
        id: `weekly:${weekly.weekStart}`,
        kind: "weekly",
        at: weeklyAt,
        weekStart: weekly.weekStart,
        title: `WHL 周报 · ${weekly.label}${weekly.isFallback ? "（上周）" : ""}`,
        body: pickText(`wk:${weekly.weekStart}`, [
          `${weekly.played} 场 ${weekly.goals} 球${weekly.topScorer ? `，射手王 ${weekly.topScorer.name}（${weekly.topScorer.goals} 球）` : ""}`,
          `本周 ${weekly.played} 战共打进 ${weekly.goals} 球${weekly.topScorer ? `，${weekly.topScorer.name} 以 ${weekly.topScorer.goals} 球领跑` : ""}`,
        ]),
      });
    }
  }

  // 混排：at 倒序（null 沉底），同刻按 id 保序
  items.sort((a, b) => {
    if (a.at && b.at && a.at !== b.at) return a.at < b.at ? 1 : -1;
    if (a.at && !b.at) return -1;
    if (!a.at && b.at) return 1;
    return a.id < b.id ? -1 : 1;
  });
  return items.slice(0, cap);
}

// ---------- 轮次综述页（/tournaments/:tid/round/:sid/:round） ----------

export async function buildRoundRecap(
  db: D1Database,
  tournamentId: number,
  stageId: number,
  round: number,
): Promise<RecapDTO | null> {
  const tour = await db
    .prepare("SELECT name, status FROM tournament WHERE id = ?")
    .bind(tournamentId)
    .first<{ name: string; status: string }>();
  if (!tour || tour.status === "draft") return null;
  const stage = await db
    .prepare("SELECT kind, name FROM stage WHERE id = ? AND tournament_id = ?")
    .bind(stageId, tournamentId)
    .first<{ kind: "elim" | "round_robin" | "group"; name: string | null }>();
  if (!stage) return null;
  // 该轮应赛场数（排除轮空与未定空壳）——「齐轮」以此为准
  const total = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM match
       WHERE stage_id = ? AND round = ?
         AND home_entry_id IS NOT NULL AND away_entry_id IS NOT NULL
         AND COALESCE(note, '') != '轮空'`,
    )
    .bind(stageId, round)
    .first<{ n: number }>();
  if (!total || total.n === 0) return null;
  const finished = await fetchRoundFinished(db, stageId, round);
  const isComplete = finished.length >= total.n;
  const maxRounds = await fetchStageMaxRounds(db, [stageId]);
  const rl = roundLabel(
    { stageKind: stage.kind, stageName: stage.name, round },
    maxRounds.get(stageId) ?? round,
  );

  const agg = roundAgg(finished);
  const eventsByMatch = await fetchEventRows(
    db,
    finished.map((m) => m.id),
  );
  const topScorer = topScorerOf(eventsByMatch, finished);

  // 积分榜前 5：读时现算口径=当前榜；多组小组赛跨组排名无意义，整段留空
  const snap = await standingsSnapshot(db, stageId);
  const singleGroup = snap ? new Set(snap.rows.map((r) => r.groupId ?? 0)).size <= 1 : false;
  const standings =
    snap && singleGroup
      ? snap.rows
          .slice(0, 5)
          .map((r) => ({ rank: r.rank, teamName: r.teamName, played: r.played, pts: r.pts }))
      : [];

  // 段落句库：开头/过渡各有变体，按「阶段+轮次」种子确定性选一（同一轮综述永远同一份，不同轮散开）
  const rSeed = `${stageId}:${round}`;
  const paragraphs: string[] = [];
  let p1 = pickText(`${rSeed}:p1`, [
    `${rl}一共 ${agg.played} 场比赛，打进 ${agg.goals} 球`,
    `${rl}战罢，${agg.played} 场比赛合计打进 ${agg.goals} 球`,
    `${agg.played} 场比赛，${agg.goals} 粒进球，这是${rl}交出的答卷`,
    `${rl}的 ${agg.played} 场较量，总共产生 ${agg.goals} 粒进球`,
    `进球数停在 ${agg.goals}，${rl}目前完赛 ${agg.played} 场`,
    `${rl}暂时完赛 ${agg.played} 场，进球 ${agg.goals} 个`,
    `${rl}的比分牌，有人欢喜有人愁`,
  ]);
  if (agg.cleanSheets > 0)
    p1 += pickText(`${rSeed}:cs`, [`，其中 ${agg.cleanSheets} 场零封`, `，零封的有 ${agg.cleanSheets} 场`]);
  if (agg.biggestMargin)
    p1 += pickText(`${rSeed}:bm`, [
      `。最大分差出现在 ${agg.biggestMargin.label}（${agg.biggestMargin.score}）`,
      `。最悬殊的一场是 ${agg.biggestMargin.label}（${agg.biggestMargin.score}）`,
    ]);
  paragraphs.push(p1);
  if (topScorer) {
    paragraphs.push(
      pickText(`${rSeed}:p2`, [
        `射手方面，${topScorer.name}（${topScorer.teamName}）本轮打进 ${topScorer.goals} 球`,
        `进球最多的是${topScorer.name}（${topScorer.teamName}），打进 ${topScorer.goals} 球`,
        `射手这轮的头条属于${topScorer.name}（${topScorer.teamName}），打进 ${topScorer.goals} 球`,
      ]),
    );
  }
  if (standings.length > 0 && isComplete) {
    paragraphs.push(
      pickText(`${rSeed}:p3`, [
        `积分榜上，${standings[0].teamName} 以 ${standings[0].pts} 分位居榜首`,
        `${standings[0].teamName} 以 ${standings[0].pts} 分继续待在积分榜首的位置`,
        `榜首属于${standings[0].teamName}，${standings[0].pts} 分`,
      ]),
    );
  }

  return {
    tournamentId,
    tournamentName: tour.name,
    stageId,
    round,
    roundLabel: rl,
    isComplete,
    played: agg.played,
    goals: agg.goals,
    cleanSheets: agg.cleanSheets,
    biggestMargin: agg.biggestMargin,
    topScorer,
    standings,
    paragraphs,
    matches: finished.map(toWeeklyMatch),
  };
}
