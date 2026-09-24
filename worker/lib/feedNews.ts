// #13 头版门户：快讯流与周报引擎。
// 快讯是读时现算的纯派生物——事实成立条目即在，pubCache 控制重算频率（每边缘节点每 60s 至多一次）；
// 同数据同输出（确定性 item_id + 稳定排序），数据变动自动重算，无陈旧新闻。
// 时效梯度：红牌(live 即时报) → 战报(终场) → 综述(全轮) → 周报(周末)。
import type { D1Database } from "@cloudflare/workers-types";
import type { FeedItemDTO, InjuryLineDTO, RecapDTO, WeeklyDTO, WeeklyMatchDTO } from "../../shared/news";
import type { RawEvent, FinishedMatch } from "./context";
import { chance, pickText } from "../../shared/textpick";
import {
  cnum,
  compareScorers,
  currentStreaks,
  fetchEventRows,
  fetchFinishedWindow,
  fetchRoundFinished,
  fetchScoringEvents,
  fetchStageMaxRounds,
  fetchTournamentFinished,
  rankRowsSimple,
  redCardBanSuffix,
  roundLabel,
  standingsSnapshot,
  subtractMatchContribution,
} from "./context";
import { bestMatchOf, computeMatchFacts, summarizeRound } from "./narrativeFacts";
import { injuriesInRound, injuriesInWindow, type InjuryFact } from "./injury";
import {
  INJURY_CLEAR_TAIL,
  INJURY_OUT_TAIL,
  INJURY_TITLE,
  LEADER_TITLE,
  MILESTONE_GOALS_TITLE,
  MILESTONE_TOP_TITLE,
  RED2Y_TITLE,
  RED_TITLE,
  RECAP_TITLE,
  STREAK_CLEAN_TITLE,
  STREAK_UNBEATEN_TITLE,
  STREAK_WIN_TITLE,
  RATES,
  chooseAngle,
  matchDataPara,
  matchNewsTitle,
  pickAttitude,
  pickBreath,
  walkoverTitle,
  weeklyTitle,
} from "./copybanks";

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

  // 本周最佳比赛：dramaScore 最高（平分取先完赛者）；弃权场 computeMatchFacts 返 null 自然出局
  const bestMatch = bestMatchOf(
    list.map((m) => ({ m, facts: computeMatchFacts(m, eventsByMatch.get(m.id) ?? []) })),
  );

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

  // 本周伤情：与本周比赛同窗口（左闭右开）；同一人一周内多条伤情按最后一条留（同一人只占一行）
  const injuries = dedupePlayerFacts(await injuriesInWindow(db, weekKey(start), weekKey(end))).map(toInjuryLine);

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
    bestMatch,
    injuries,
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
// 并列口径与射手榜一致（同球数点球少的在前）
function topScorerOf(
  eventsByMatch: Map<number, RawEvent[]>,
  list: FinishedMatch[],
): { name: string; teamName: string; goals: number } | null {
  const scorerGoals = new Map<string, { name: string; teamName: string; goals: number; penGoals: number }>();
  for (const m of list) {
    for (const e of eventsByMatch.get(m.id) ?? []) {
      if ((e.type !== "goal" && e.type !== "pen_goal") || !e.playerName) continue;
      const cur =
        scorerGoals.get(e.playerName) ?? { name: e.playerName, teamName: "", goals: 0, penGoals: 0 };
      cur.goals += 1;
      if (e.type === "pen_goal") cur.penGoals += 1;
      if (!cur.teamName) {
        cur.teamName = e.entryId === m.homeEntryId ? m.homeTeamName : m.awayTeamName;
      }
      scorerGoals.set(e.playerName, cur);
    }
  }
  return [...scorerGoals.values()].sort(compareScorers)[0] ?? null;
}

// ---------- 叙事事实：按「该场完赛时刻」重放 ----------
// 积分榜快照/射手榜都是「当前值」，直接给历史窗口比赛贴叙事会张冠李戴（后打的球算进前头的里程碑）。
// 这里统一重放：射手账本逐场滚动；榜首判定把后续场次的贡献从当前榜里扣回去。

interface ScorerRow {
  playerId: number;
  name: string;
  teamName: string;
  goals: number;
  penGoals: number;
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
  const evAll = await fetchScoringEvents(
    db,
    finAsc.map((m) => m.id),
  );
  const ledger = new Map<number, { name: string; teamName: string; goals: number; penGoals: number }>();
  const sortedLedger = (): ScorerRow[] =>
    [...ledger.entries()].map(([playerId, v]) => ({ playerId, ...v })).sort(compareScorers);
  for (const m of finAsc) {
    const cap = wantedMatchIds.has(m.id) ? { before: sortedLedger(), after: [] as ScorerRow[] } : null;
    if (cap) scorersAt.set(m.id, cap);
    for (const e of evAll.get(m.id) ?? []) {
      if (e.player_id == null) continue;
      const cur =
        ledger.get(e.player_id) ??
        { name: e.player_name ?? "未知球员", teamName: "", goals: 0, penGoals: 0 };
      cur.goals += 1;
      if (e.type === "pen_goal") cur.penGoals += 1;
      if (!cur.teamName) {
        cur.teamName = e.entry_id === m.homeEntryId ? m.homeTeamName : m.awayTeamName;
      }
      ledger.set(e.player_id, cur);
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

// match 条目 body：把进球事件流写成一句有走向的新闻句（首球—过程—收尾），按条目种子选写法。
// 只写事件里的事实（人/分钟/类型），不推断半场归属；同人多球挂梅开二度/帽子戏法
function matchBodyLines(m: FinishedMatch, events: RawEvent[]): string[] {
  const goals = events.filter((e) => e.type === "goal" || e.type === "pen_goal" || e.type === "own_goal");
  if (goals.length === 0) return [];
  const winnerSide = m.scoreHome > m.scoreAway ? "home" : m.scoreAway > m.scoreHome ? "away" : null;
  const nameOf = (e: RawEvent) => e.playerName ?? "球员";
  const scoringSide = (e: RawEvent) => (e.entryId === m.homeEntryId ? "home" : "away");
  const ogBeneficiary = (e: RawEvent) => (e.entryId === m.homeEntryId ? m.awayTeamName : m.homeTeamName);
  const counts = new Map<string, number>();
  const lastIdx = new Map<string, number>();
  goals.forEach((g, i) => {
    if (g.type === "own_goal") return;
    const n = nameOf(g);
    counts.set(n, (counts.get(n) ?? 0) + 1);
    lastIdx.set(n, i);
  });

  // 关键节点标记（口径同战报）：该球让进球方从「不领先」变「扳平或超出」（首开纪录/扳平/反超）；
  // 领先方扩大优势、落后方追回一球都不算。只有关键节点才提助攻——数据里几乎每个进球都记了助攻，逐个写太机械。
  const keyFlags: boolean[] = [];
  {
    let h = 0;
    let a = 0;
    for (const g of goals) {
      const side = scoringSide(g);
      const scoring = g.type === "own_goal" ? (side === "home" ? "away" : "home") : side;
      const wasAhead = scoring === "home" ? h > a : a > h;
      if (scoring === "home") h += 1;
      else a += 1;
      const nowAhead = scoring === "home" ? h > a : a > h;
      keyFlags.push(!wasAhead && (nowAhead || h === a));
    }
  }

  const phrase = (e: RawEvent, i: number, withTime: boolean, used: Set<string>) => {
    const n = nameOf(e);
    const first = i === 0;
    const closing =
      i === goals.length - 1 && winnerSide !== null && scoringSide(e) === winnerSide && e.type !== "own_goal";
    const seed = `mbp:${m.id}:${i}`;
    // 该侧在第 i 球前的进球数（乌龙记受益方），用于判定「本队首球」
    const teamGoalsBefore = (side: "home" | "away"): number => {
      let c = 0;
      for (let k = 0; k < i; k++) {
        const g = goals[k];
        const s = g.type === "own_goal" ? (scoringSide(g) === "home" ? "away" : "home") : scoringSide(g);
        if (s === side) c += 1;
      }
      return c;
    };
    const ogCountBefore = goals.slice(0, i).filter((g) => g.type === "own_goal").length;
    let pool: string[];
    if (e.type === "own_goal") {
      pool = first
        ? [`自摆乌龙，为 ${ogBeneficiary(e)} 送出开门礼`, `不慎自摆乌龙，${ogBeneficiary(e)} 白捡一球`]
        : ogCountBefore === 0
          ? // 全场第一个乌龙：不写「再送」，受益方首球时第二分句也属多余
            ["不慎自摆乌龙"]
          : [`再送一记乌龙，${ogBeneficiary(e)} 笑纳`, "又摆了一道乌龙"];
    } else if (closing) {
      pool = e.type === "pen_goal"
        ? ["点球锁定胜局", "点球奠定胜局"]
        : ["锁定胜局", "奠定胜局", "完成致命一击"];
    } else if (first) {
      pool = e.type === "pen_goal"
        ? ["点球首开纪录", "点球率先破门"]
        : ["率先破门", "首开纪录", "打开局面"];
    } else {
      // 本队（乌龙记受益方）此前没进过球时不用延续词，避免 A 队进球后 B 队球员「再下一城」的错位
      const teamFirst = teamGoalsBefore(scoringSide(e)) === 0;
      pool = e.type === "pen_goal"
        ? teamFirst
          ? ["点球破门得分", "点球建功"]
          : ["点球再下一城", "再度主罚点球命中"]
        : teamFirst
          ? ["破门得分", "为球队建功"]
          : ["再入一球", "接着破门", "也为球队建功"];
    }
    // 句内不重复用词：首选已被前面进球用过时，按种子换一个，再不行取池中第一个未用的
    let p = pickText(seed, pool);
    if (used.has(p)) p = pickText(`${seed}:r`, pool);
    if (used.has(p)) p = pool.find((x) => !used.has(x)) ?? p;
    used.add(p);
    const c = counts.get(n) ?? 0;
    const hero =
      c >= 2 && lastIdx.get(n) === i
        ? c === 2
          ? "梅开二度"
          : c === 3
            ? "上演帽子戏法"
            : `独中${cnum(c)}球`
        : null;
    // 功臣语序同战报：收尾句「梅开二度锁定胜局」融合动词，非收尾句功臣短语直接作谓语
    const core = hero ? (closing ? `${hero}${p}` : hero) : p;
    // 助攻从句：只给关键节点进球提，且写在进球之前（语序同战报）；句库散变体 + 本句去重
    let astLead = "";
    if (e.assistName && e.type !== "own_goal" && keyFlags[i]) {
      const apool = ["送出助攻", "助攻得手", "送出妙传", "贡献一记助攻", "做饼得手", "送出致命一传"];
      const aseed = `ast:${m.id}:${i}`;
      let a = pickText(aseed, apool);
      if (used.has(`a:${a}`)) a = pickText(`${aseed}:r`, apool);
      if (used.has(`a:${a}`)) a = apool.find((x) => !used.has(`a:${x}`)) ?? a;
      used.add(`a:${a}`);
      astLead = `${e.assistName} ${a}，`;
    }
    if (withTime && e.minute !== null) return `${astLead}${n} 第 ${e.minute} 分钟${core}`;
    return `${astLead}${n} ${core}`;
  };

  if (goals.length === 1) {
    const e = goals[0];
    if (e.type === "own_goal") return [phrase(e, 0, false, new Set())];
    return [
      phrase(e, 0, true, new Set()),
      pickText(`mbs:${m.id}`, [
        `${nameOf(e)} 打进全场唯一进球`,
        `全场唯一进球来自 ${nameOf(e)}${e.type === "pen_goal" ? "的点球" : ""}`,
      ]),
    ];
  }
  const cap = goals.length > 4 ? 3 : goals.length;
  const tail = goals.length > 4 ? `，双方合计打进 ${goals.length} 球` : "";
  const usedT = new Set<string>();
  const usedN = new Set<string>();
  return [
    goals.slice(0, cap).map((e, i) => phrase(e, i, true, usedT)).join("，") + tail,
    goals.slice(0, cap).map((e, i) => phrase(e, i, false, usedN)).join("，") + tail,
  ];
}

// 同一名球员在同一窗口可能出现多条伤病事件（一轮多场、一周多轮）：
// 按球员去重留最后一条，否则「N 人受伤」数的其实是事件数，正文还会把同一个人列两遍
function dedupePlayerFacts(facts: InjuryFact[]): InjuryFact[] {
  const byPlayer = new Map<number, InjuryFact>();
  for (const f of facts) byPlayer.set(f.playerId, f);
  return [...byPlayer.values()];
}

// 事实 → 一条伤情行（周报与综述共用同一份字段口径）
function toInjuryLine(f: InjuryFact): InjuryLineDTO {
  return {
    playerId: f.playerId,
    playerName: f.playerName,
    teamName: f.teamName,
    tournamentId: f.tournamentId,
    tournamentName: f.tournamentName,
    severity: f.severity,
    injuryName: f.injuryName,
    outMatches: f.outMatches,
  };
}

// 伤情逐名简列（快讯条正文用）：谁、哪队、轻重、伤名（有登记才有）
function injuryNames(facts: InjuryFact[]): string {
  return facts
    .map(
      (f) =>
        `${f.playerName}（${f.teamName} · ${f.severity === "major" ? "重伤" : "轻伤"}${f.injuryName ? ` · ${f.injuryName}` : ""}）`,
    )
    .join("、");
}

// 缺阵尾巴：有多少人还挂着未打完的缺阵场次就说多少人，一个都没有就说这批人不再缺阵
// （只换说法，不下「伤愈／全员健康」的结论——登记表里没有复出这个事实）
function injuryOutTail(facts: InjuryFact[], seed: string): string {
  const out = facts.filter((f) => f.outMatches > 0).length;
  return out > 0 ? pickText(`${seed}:out`, INJURY_OUT_TAIL)(out) : pickText(`${seed}:clear`, INJURY_CLEAR_TAIL);
}

/**
 * 轮次综述只保留「可能进入前 cap 名」的轮次，省掉被 slice 丢掉那些轮的整轮完赛名单与伤情查询。
 * 依据：最终输出是「按 at 倒序取前 cap」，而窗口已提供 max(cap*3, 40) 条带 at 的条目，
 * 所以 at 早于第 cap 条窗口项的条目必然排在前 cap 之外。判据用 >= 保守（并列时保留）。
 * 窗口不足 cap 条时无法定界，原样返回。
 */
export function filterRecapByCutoff<T extends { last_at: string | null }>(
  rows: T[],
  window: FinishedMatch[],
  cap: number,
): T[] {
  if (window.length < cap) return rows;
  const cutoff = window[cap - 1].finishedAt;
  if (!cutoff) return rows;
  return rows.filter((r) => r.last_at === null || r.last_at >= cutoff);
}

export async function buildFeed(
  db: D1Database,
  opts: { limit?: number; before?: string } = {},
): Promise<FeedItemDTO[]> {
  const cap = Math.min(Math.max(opts.limit ?? 15, 1), 50);
  const before = opts.before;
  const items: FeedItemDTO[] = [];

  // 请求内记忆化：同一批阶段 id 在一轮 buildFeed 里被问三次（窗口 / 红牌 / 综述），
  // 实测其中两次是同一集合不同顺序（[6,2,1] 与 [2,1,6]），各付 223 行。
  const maxRoundsCache = new Map<string, Promise<Map<number, number>>>();
  const maxRoundsOf = (stageIds: number[]) => {
    const key = [...new Set(stageIds)].sort((a, b) => a - b).join(",");
    let p = maxRoundsCache.get(key);
    if (!p) maxRoundsCache.set(key, (p = fetchStageMaxRounds(db, stageIds)));
    return p;
  };

  // 两波并行取代九段串行（冷缓存 20-40 查逐段 +0.2s，是 /feed 慢到超时的根因）：
  // 波 1 互相独立一起发——完赛窗口 / 红牌 / 改判 / 齐轮分组 / 周报；
  // 波 2 只依赖波 1，一批并行——窗口事件、阶段轮数、各赛事叙事事实、各阶段榜快照、红牌与综述的后置查询。
  type RedRow = {
    id: number; type: "red" | "red_2y"; created_at: string;
    player_name: string | null;
    match_id: number; tournament_id: number; tournament_name: string;
    stage_kind: "elim" | "round_robin" | "group"; stage_name: string | null; round: number; stage_id: number;
  };
  type AuditRow = {
    id: number; created_at: string; target_id: number; detail_json: string | null;
    tournament_id: number; tournament_name: string;
    home_team_name: string; away_team_name: string;
    stage_kind: "elim" | "round_robin" | "group"; stage_name: string | null; stage_id: number; round: number;
  };
  type RecapGroupRow = {
    stage_id: number;
    round: number;
    last_at: string | null;
    tournament_id: number;
    tournament_name: string;
    stage_kind: "elim" | "round_robin" | "group";
    stage_name: string | null;
  };
  const windowP = fetchFinishedWindow(db, Math.max(cap * 3, 40), before);
  const redP = db
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
  const auditP = db
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
  const recapP = db
    .prepare(
      `SELECT m.stage_id, m.round, MAX(m.finished_at) AS last_at,
         s.tournament_id, t.name AS tournament_name,
         s.kind AS stage_kind, s.name AS stage_name
       FROM match m
       JOIN stage s ON s.id = m.stage_id
       JOIN tournament t ON t.id = s.tournament_id
       WHERE t.status != 'draft' AND m.home_entry_id IS NOT NULL AND m.away_entry_id IS NOT NULL
         AND COALESCE(m.note, '') != '轮空'
         -- 先限定「至少有一场完赛」的轮，缩小 GROUP BY 的输入：规划器原本走 idx_match_stage
         -- 全索引扫描（实测 665 行 → 407 行，−38.8%）。语义等价：某轮若没有任何完赛场次，
         -- COUNT(*) 必然大于 SUM(finished)，HAVING 本就不成立。
         AND (m.stage_id, m.round) IN (SELECT stage_id, round FROM match WHERE status = 'finished')
       GROUP BY m.stage_id, m.round
       HAVING COUNT(*) = SUM(CASE WHEN m.status = 'finished' THEN 1 ELSE 0 END)
         AND MAX(m.finished_at) < COALESCE(?, '9999-12-31')
       ORDER BY last_at DESC, stage_id DESC, round DESC LIMIT ${cap}`,
    )
    .bind(before ?? "9999-12-31")
    .all<RecapGroupRow>();
  const weeklyP = buildWeekly(db);

  const window = await windowP;
  const wantedByTid = new Map<number, Set<number>>();
  for (const m of window) {
    const s = wantedByTid.get(m.tournamentId) ?? new Set<number>();
    s.add(m.id);
    wantedByTid.set(m.tournamentId, s);
  }

  const [eventsByMatch, maxRounds, factsEntries, snapEntries, red, recap] = await Promise.all([
    fetchEventRows(db, window.map((m) => m.id)),
    maxRoundsOf(window.map((m) => m.stageId)),
    Promise.all(
      [...wantedByTid.entries()].map(
        async ([tid, wanted]) => [tid, await buildNarrativeFacts(db, tid, wanted)] as const,
      ),
    ),
    Promise.all(
      [...new Set(window.map((m) => m.stageId))].map(
        async (sid) => [sid, await standingsSnapshot(db, sid)] as const,
      ),
    ),
    // 红牌后置：停赛后缀按（赛事,类型）去重并发（原先每行一查），轮数一查
    (async () => {
      const rows = (await redP).results ?? [];
      const suffixP = new Map<string, Promise<string>>();
      const suffixes = Promise.all(
        rows.map((r) => {
          const k = `${r.tournament_id}:${r.type}`;
          let p = suffixP.get(k);
          if (!p) suffixP.set(k, (p = redCardBanSuffix(db, r.tournament_id, r.type)));
          return p;
        }),
      );
      const [banSuffixes, redMaxRounds] = await Promise.all([
        suffixes,
        maxRoundsOf(rows.map((r) => r.stage_id)),
      ]);
      return { rows, banSuffixes, redMaxRounds };
    })(),
    // 综述后置：轮数、各轮完赛名单与各轮伤情并行
    (async () => {
      // 先按 cap 截断再发查询：被 slice 丢掉的轮次不必付整轮名单与伤情。
      // 必须在三个 .map 之前过滤，否则 recapRows / recapLists / recapInjuries 会按下标错位。
      const rows = filterRecapByCutoff((await recapP).results ?? [], window, cap);
      const [recapMaxRounds, recapLists, recapInjuries] = await Promise.all([
        maxRoundsOf(rows.map((r) => r.stage_id)),
        Promise.all(rows.map((r) => fetchRoundFinished(db, r.stage_id, r.round))),
        Promise.all(rows.map((r) => injuriesInRound(db, r.stage_id, r.round))),
      ]);
      return { rows, recapMaxRounds, recapLists, recapInjuries };
    })(),
  ]);
  const factsByTid = new Map(factsEntries);
  const snapMap = new Map(snapEntries);
  const auditRows = (await auditP).results ?? [];

  // 1) 完赛窗口 → 战报/弃权条（窗口取深些给混排留余量）
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
        title: walkoverTitle(`wt:${m.id}`, loser, winner, m.homeTeamName, m.awayTeamName),
        body: pickText(`wo:${m.id}`, [
          `${rl}｜比分记 ${m.scoreHome}:${m.scoreAway}${m.note ? `（${m.note}）` : ""}`,
          `${rl}｜判定比分 ${m.scoreHome}:${m.scoreAway}${m.note ? `，${m.note}` : ""}`,
        ]),
      });
    } else {
      const events = eventsByMatch.get(m.id) ?? [];
      const facts = computeMatchFacts(m, events);
      const winnerName = facts?.winnerSide
        ? facts.winnerSide === "home"
          ? m.homeTeamName
          : m.awayTeamName
        : null;
      const bodyLines = matchBodyLines(m, events);
      const goalless = m.scoreHome === 0 && m.scoreAway === 0;
      const loserName = winnerName
        ? winnerName === m.homeTeamName
          ? m.awayTeamName
          : m.homeTeamName
        : null;
      // p1 事件段（body=teaser，呼吸句 ≤1 条过骰子拼入段尾）；事件流水从句拼接天然无尾句号，统一补齐
      const body0 = bodyLines.length
        ? pickText(`mb:${m.id}`, bodyLines)
        : goalless
          ? pickText(`ng:${m.id}`, ["双方均无进球入账", "两队都没能敲开对方球门", "互交白卷，比分没有改写"])
          : `比分 ${m.scoreHome}:${m.scoreAway}，进球明细未录入`;
      const body = /[。！？]$/.test(body0) ? body0 : `${body0}。`;
      const breath = facts ? pickBreath(`nb:${m.id}`, facts, 1, RATES.breathNews) : [];
      const p1 = breath.length ? `${body}${breath[0]}` : body;
      // p2 数据段：纯数字盘面（比分/总进球/点球大战），不与事件段重复人物细节
      const p2 = matchDataPara(`md:${m.id}`, {
        scoreHome: m.scoreHome,
        scoreAway: m.scoreAway,
        totalGoals: facts?.totalGoals ?? m.scoreHome + m.scoreAway,
        winnerName,
        penLine: facts?.penShootout
          ? `点球大战 ${facts.penShootout.home}:${facts.penShootout.away} 分出胜负`
          : null,
      });
      const paragraphs = [p1, p2];
      // p3 快评段（可选）：drama 高的文章更常开口，平淡场不注水；过了骰子才出现
      if (facts) {
        const rate = facts.dramaScore >= 30 ? RATES.attitudeNews : RATES.paraThird;
        if (chance(`gp3:${m.id}`, rate)) {
          const topBag =
            facts.maxBagGoals >= 2
              ? facts.playerBags.find((p) => p.goals === facts.maxBagGoals) ?? null
              : null;
          paragraphs.push(
            pickAttitude(`av:${m.id}`, chooseAngle(`ag:${m.id}`, facts.dramaScore), {
              label: `${m.homeTeamName} vs ${m.awayTeamName}`,
              scoreLine: `${m.scoreHome}:${m.scoreAway}`,
              goalCount: facts.totalGoals,
              winnerName,
              loserName,
              heroName: topBag?.playerName ?? null,
              roundLabel: rl,
            }),
          );
        }
      }
      items.push({
        ...base,
        id: `match:${m.id}`,
        kind: "match",
        title: matchNewsTitle(`tt:${m.id}`, {
          roundLabel: rl,
          home: m.homeTeamName,
          away: m.awayTeamName,
          scoreHome: m.scoreHome,
          scoreAway: m.scoreAway,
          winnerName,
          loserName,
        }, facts),
        body: p1,
        paragraphs,
        drama: facts?.dramaScore,
      });
    }
  }

  // 1.5) 叙事条：榜首易主 / 纪录 / 里程碑——全部按「该场完赛时刻」口径重放（事实已在波 2 汇齐）
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
              title: pickText(`ld:${m.id}`, LEADER_TITLE)(newL.teamName, oldL.teamName),
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
          title = pickText(`sw:${m.id}:${entryId}`, STREAK_WIN_TITLE)(teamName, st.win);
          body = pickText(`swb:${m.id}:${entryId}`, [
            `${rl}｜近 ${st.win} 场全胜，进 ${t.gf} 球失 ${t.ga} 球`,
            `${rl}｜${st.win} 连胜期间进 ${t.gf} 球失 ${t.ga} 球`,
          ]);
        } else if (st.unbeaten >= 5) {
          const t = entryTail(cut, entryId, st.unbeaten);
          title = pickText(`su:${m.id}:${entryId}`, STREAK_UNBEATEN_TITLE)(teamName, st.unbeaten);
          body = pickText(`sub:${m.id}:${entryId}`, [
            `${rl}｜近 ${st.unbeaten} 场 ${t.w} 胜 ${t.d} 平，进 ${t.gf} 球失 ${t.ga} 球`,
            `${rl}｜${st.unbeaten} 场 ${t.w} 胜 ${t.d} 平，还未尝败绩`,
          ]);
        } else if (st.cleanSheet >= 2) {
          const t = entryTail(cut, entryId, st.cleanSheet);
          title = pickText(`sc:${m.id}:${entryId}`, STREAK_CLEAN_TITLE)(teamName, st.cleanSheet);
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
            title: pickText(`mg:${m.id}:${e.playerId}`, MILESTONE_GOALS_TITLE)(afterRow.name, afterRow.goals),
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
            title: pickText(`mt:${m.id}:${e.playerId}`, MILESTONE_TOP_TITLE)(afterRow.name, afterRow.goals),
            body: pickText(`mtb:${m.id}:${e.playerId}`, [
              `${rl}过后以 ${afterRow.goals} 球升至射手榜首位`,
              `${rl}｜${afterRow.goals} 球，抢下射手榜第一`,
            ]),
          });
        }
      }
    }
  }

  // 2) 红牌即时快讯（live/finished 都算，录入即出条）——查询在波 1 发出，后置在波 2 汇齐
  const { rows: redRows, banSuffixes, redMaxRounds } = red;
  for (let i = 0; i < redRows.length; i++) {
    const r = redRows[i];
    items.push({
      id: `discipline:${r.id}`,
      kind: "discipline",
      at: r.created_at,
      tournamentId: r.tournament_id,
      tournamentName: r.tournament_name,
      matchId: r.match_id,
      title: pickText(`dp:${r.id}`, r.type === "red" ? RED_TITLE : RED2Y_TITLE)(r.player_name ?? "球员"),
      body: `${roundLabel(
        { stageKind: r.stage_kind, stageName: r.stage_name, round: r.round, tournamentName: r.tournament_name },
        redMaxRounds.get(r.stage_id) ?? r.round,
      )}${banSuffixes[i]}`,
    });
  }

  // 3) 更正启事（改判审计）——查询在波 1 发出
  for (const a of auditRows) {
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

  // 3.5) 轮次综述条：最近完赛的 5 个「全轮完赛」轮次（详情走综述端点）——查询在波 1 发出，后置在波 2 汇齐
  const recapRows = recap.rows;
  const recapMaxRounds = recap.recapMaxRounds;
  const recapLists = recap.recapLists;
  const recapInjuries = recap.recapInjuries;
  for (let i = 0; i < recapRows.length; i++) {
    const g = recapRows[i];
    const agg = roundAgg(recapLists[i]);
    if (agg.played === 0) continue;
    const rl = roundLabel(
      { stageKind: g.stage_kind, stageName: g.stage_name, round: g.round, tournamentName: g.tournament_name },
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
      title: pickText(`rt:${g.stage_id}:${g.round}`, RECAP_TITLE)(rl, agg.played, agg.goals),
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

  // 3.6) 轮次伤情条：与综述条同一批「全轮完赛」轮次，该轮有人受伤才出条（详情走综述页）
  for (let i = 0; i < recapRows.length; i++) {
    const g = recapRows[i];
    const facts = dedupePlayerFacts(recapInjuries[i] ?? []);
    if (facts.length === 0) continue;
    const rl = roundLabel(
      { stageKind: g.stage_kind, stageName: g.stage_name, round: g.round, tournamentName: g.tournament_name },
      recapMaxRounds.get(g.stage_id) ?? g.round,
    );
    const major = facts.filter((f) => f.severity === "major").length;
    items.push({
      id: `injury:${g.stage_id}:${g.round}`,
      kind: "injury",
      at: g.last_at,
      tournamentId: g.tournament_id,
      tournamentName: g.tournament_name,
      stageId: g.stage_id,
      round: g.round,
      title: pickText(`it:${g.stage_id}:${g.round}`, INJURY_TITLE)(rl, facts.length, major),
      body: `${injuryNames(facts)}${injuryOutTail(facts, `it:${g.stage_id}:${g.round}`)}`,
    });
  }

  // 4) 周报条（本周/回退周有比赛才出）——与波 1 同时开算，此处只等结果
  const weekly = await weeklyP;
  if (weekly.played > 0) {
    const weeklyAt = weekly.matches[0]?.finishedAt ?? `${weekly.weekStart}T00:00:00Z`;
    if (!before || (weeklyAt && weeklyAt < before)) {
      const wkInjuries = weekly.injuries ?? [];
      const wkOut = wkInjuries.filter((f) => f.outMatches > 0).length;
      items.push({
        id: `weekly:${weekly.weekStart}`,
        kind: "weekly",
        at: weeklyAt,
        weekStart: weekly.weekStart,
        title: weeklyTitle(`wkt:${weekly.weekStart}`, {
          label: `${weekly.label}${weekly.isFallback ? "（上周）" : ""}`,
          played: weekly.played,
          goals: weekly.goals,
          topScorerName: weekly.topScorer?.name,
          topScorerGoals: weekly.topScorer?.goals,
        }),
        body:
          pickText(`wk:${weekly.weekStart}`, [
            `${weekly.played} 场比赛共打进 ${weekly.goals} 球${weekly.topScorer ? `，射手王是 ${weekly.topScorer.name}（${weekly.topScorer.goals} 球）` : ""}`,
            `本周 ${weekly.played} 战收获 ${weekly.goals} 球${weekly.topScorer ? `，${weekly.topScorer.name} 以 ${weekly.topScorer.goals} 球领跑射手榜` : ""}`,
          ]) +
          (wkInjuries.length > 0
            ? `；${wkInjuries.length} 人受伤${wkOut > 0 ? pickText(`wko:${weekly.weekStart}`, INJURY_OUT_TAIL)(wkOut) : pickText(`wkc:${weekly.weekStart}`, INJURY_CLEAR_TAIL)}`
            : ""),
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
    { stageKind: stage.kind, stageName: stage.name, round, tournamentName: tour.name },
    maxRounds.get(stageId) ?? round,
  );

  const agg = roundAgg(finished);
  const eventsByMatch = await fetchEventRows(
    db,
    finished.map((m) => m.id),
  );
  const topScorer = topScorerOf(eventsByMatch, finished);

  // 本轮之最（事实层聚合）：最快进球/最晚制胜球/红牌账；最大分差 p1 已记不重复
  const ext = summarizeRound(
    finished.map((m) => ({ m, facts: computeMatchFacts(m, eventsByMatch.get(m.id) ?? []) })),
  );

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
  // 场均 3 球以上才配气氛句（纯叙述、不带数据、条件门控）；接在从句后先补句号
  if (agg.played > 0 && agg.goals >= agg.played * 3) {
    if (!p1.endsWith("。")) p1 += "。";
    p1 += pickText(`${rSeed}:air`, ["这一轮的门将们日子不太好过。", "进攻端的账单拉得很长。"]);
  }
  if (!p1.endsWith("。")) p1 += "。";
  // 次段：射手与榜首织成一段（段内 2-3 句成文）
  const p2: string[] = [];
  if (topScorer) {
    p2.push(
      pickText(`${rSeed}:p2`, [
        `射手方面，${topScorer.name}（${topScorer.teamName}）本轮打进 ${topScorer.goals} 球`,
        `进球最多的是${topScorer.name}（${topScorer.teamName}），打进 ${topScorer.goals} 球`,
        `射手这轮的头条属于${topScorer.name}（${topScorer.teamName}），打进 ${topScorer.goals} 球`,
      ]),
    );
  }
  if (standings.length > 0 && isComplete) {
    p2.push(
      pickText(`${rSeed}:p3`, [
        `积分榜上，${standings[0].teamName} 以 ${standings[0].pts} 分位居榜首`,
        `${standings[0].teamName} 以 ${standings[0].pts} 分继续待在积分榜首的位置`,
        `榜首属于${standings[0].teamName}，${standings[0].pts} 分`,
      ]),
    );
  }
  const p2Text = p2.length > 0 ? p2.join("。") + "。" : null;

  // 段序轮换：约一半轮次把射手/榜首段提到开头，破「总账永远第一段」的固定版式
  const scorerFirst = p2Text !== null && chance(`${rSeed}:ord`, 0.5);
  if (p2Text !== null && scorerFirst) paragraphs.push(p2Text);
  paragraphs.push(p1);
  if (p2Text !== null && !scorerFirst) paragraphs.push(p2Text);

  // 尾段「本轮之最」：最快进球/绝杀/红牌账，有账才写（最大分差 p1 已记，不重复）
  const bits: string[] = [];
  if (ext.fastestGoal)
    bits.push(
      pickText(`${rSeed}:xfg`, [
        `本轮最快的进球出现在 ${ext.fastestGoal.label}（第 ${ext.fastestGoal.minute} 分钟${ext.fastestGoal.playerName ? `，${ext.fastestGoal.playerName}` : ""}）`,
        `${ext.fastestGoal.label} 打进了本轮最快的球，第 ${ext.fastestGoal.minute} 分钟`,
      ]),
    );
  if (ext.latestWinner)
    bits.push(
      pickText(`${rSeed}:xlw`, [
        `${ext.latestWinner.label} 一直缠到第 ${ext.latestWinner.minute} 分钟才分出胜负`,
        `最晚的制胜球也在本轮：${ext.latestWinner.label}，第 ${ext.latestWinner.minute} 分钟`,
      ]),
    );
  if (ext.redCount > 0)
    bits.push(
      pickText(`${rSeed}:xrc`, [
        ext.redCount === 1 ? "这轮还出现过一张红牌" : `红牌账上，这轮记了 ${ext.redCount} 张`,
        ext.redCount === 1 ? "有一场比赛见过了红牌" : `这轮的红牌总数是 ${ext.redCount} 张`,
      ]),
    );
  if (bits.length > 0) paragraphs.push(bits.join("。") + "。");

  // 本轮伤情：快讯条点进来要能看见对应内容（同一人一轮多次受伤只列一条）
  const injuries = dedupePlayerFacts(await injuriesInRound(db, stageId, round)).map(toInjuryLine);

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
    injuries,
    matches: finished.map(toWeeklyMatch),
  };
}
