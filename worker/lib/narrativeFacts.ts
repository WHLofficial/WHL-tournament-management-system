// 叙事事实层：把一场比赛的原始事件流重放成「可写的剧情事实」+ 戏剧性评分（dramaScore）。
// 纯函数、零数据库访问——快讯/战报/综述/周报把 FinishedMatch + RawEvent[] 喂进来，
// 这里只钉死「发生了什么」，措辞归 copybanks，触发概率归 chance。
// 事实必须能从事件行直接验证，不推断、不脑补；进球时间未知（minute 为空）的时间类事实一律放弃。
// 事件行已按 (COALESCE(minute,-1), id) 排序：null 分钟排最前——所以首球时间未知即可判定整场时间不可知。

import type { FinishedMatch, RawEvent, TeamStreaks } from "./context";

// ---------- 阈值常量（分钟数分界，不依赖半场哨事件；调口味改这里） ----------
export const LATE_WINNER_MIN = 80; // 绝杀：制胜球 ≥80' 且此后无回应
export const LATE_FLURRY_MIN = 85; // 尾段连环：85' 后 ≥2 球
export const BOLT_MAX_MIN = 10; // 开场闪电：首球 ≤10'
export const BURST_WINDOW = 15; // 进球潮：窗口宽度
export const BURST_MIN_GOALS = 3; // 进球潮：窗口内球数门槛
export const DROUGHT_MIN = 60; // 哑火期：连续无进球分钟数门槛
export const FIRST_HALF_END = 45; // 上半场沉闷：前 45' 零进球
export const UPSET_RANK_GAP = 5; // 爆冷下克上：双方排名差 ≥5
export const UNBEATEN_BROKEN_MIN = 5; // 不败金身告破：≥5 场不败被终结
export const STREAK_KILLED_MIN = 3; // 连胜被终结：≥3 连胜被掐断

export type Side = "home" | "away";

// 赛前语境（可选）：爆冷/金身告破需要「该场完赛时刻」的榜位与连况，由调用方重放后喂入
export interface FactsContext {
  homeRankBefore?: number;
  awayRankBefore?: number;
  homeStreaksBefore?: TeamStreaks;
  awayStreaksBefore?: TeamStreaks;
}

export interface GoalMoment {
  side: Side | null; // 得分受益方（乌龙记摆乌龙者，受益为对面；entry 缺失时为 null）
  minute: number | null;
  type: "goal" | "pen_goal" | "own_goal";
  playerName: string | null;
  playerId: number | null;
}

export interface RedMoment {
  side: Side;
  minute: number | null;
  type: "red" | "red_2y";
  playerName: string | null;
  scoreHome: number; // 吃红时比分（事件序重放）
  scoreAway: number;
  diffFor: number; // 吃红方视角净胜
  state: "leading" | "level" | "behind";
}

export interface MatchFacts {
  totalGoals: number; // 记分口径（含乌龙/点球）
  margin: number; // |净胜|
  winnerSide: Side | null; // 记分平局为 null（点球决胜不改比分，见 penShootout）
  penShootout: { home: number; away: number } | null; // 点球大战比分（淘汰赛平局后）
  timingKnown: boolean; // 进球时间是否全已知
  firstGoal: GoalMoment | null;
  lastGoal: GoalMoment | null;
  openingBolt: boolean; // 开场闪电：首球 ≤10'
  firstHalfQuiet: boolean; // 上半场沉闷：前 45' 零进球（含 0:0）
  drought: { from: number; to: number; minutes: number } | null; // 哑火期 ≥60'
  goalBurst: { from: number; to: number; count: number } | null; // 进球潮：15' 窗 ≥3 球
  lateFlurryCount: number; // 85' 后进球数（≥2 才成剧情）
  lateWinner: boolean; // 绝杀：末球 ≥80'、破平或反超、此后无回应
  comeback: "big" | "small" | null; // 逆转：big=曾落后 ≥2 球翻盘，small=曾落后 1 球赢回
  blownLead: boolean; // 两球领先被抹平：曾领先 ≥2 球，最终没赢
  bothLed: boolean; // 双方都领先过（拉锯战）
  leadChanges: number; // 领先易手次数（A 领先→B 领先记 1，扳平不计）
  equalizeRetake: boolean; // 被追平后再度领先并赢下（胜方视角）
  shape: "oneSided" | "seeSaw" | "dull" | "normal"; // 比赛形状（一边倒/对攻拉锯/闷战/常态）
  reds: RedMoment[];
  redTurn: {
    side: Side;
    minute: number;
    type: "red" | "red_2y";
    playerName: string | null;
    state: "leading" | "level" | "behind"; // 吃红时该队局面
    outcome: "improved" | "held" | "faded" | "collapsed"; // 少一人后：追回反超/顶住/仍赢但优势缩水/崩
  } | null; // 双方都吃红时为 null（混乱局不成故事）
  penGoalCount: number;
  penDecider: boolean; // 点球制胜：最后一球是点球且正是制胜球
  penMissCount: number;
  penMissSwing: boolean; // 罚失点球的一方反而赢了
  ogBenefit: { side: Side; minute: number | null }[]; // 乌龙受益记录
  ogDecider: boolean; // 乌龙胜负手：净胜球全部来自乌龙大礼
  playerBags: { playerId: number; playerName: string; side: Side; goals: number }[]; // 进球账本（goal+pen_goal）
  soloAct: { playerId: number; playerName: string; side: Side; goals: number } | null; // 一人扛队：包办全队进球且 ≥2
  maxBagGoals: number; // 个人单场最多进球（梅开二度 2 / 帽子戏法 3 / 大四喜 4+）
  linkTwice: { scorerName: string; assistName: string; count: number } | null; // 同一条连线一场两度以上
  upset: { winnerName: string; winnerRank: number; loserRank: number } | null; // 爆冷下克上（需赛前榜位）
  streakBroken: { kind: "unbeaten" | "win"; count: number; teamName: string } | null; // 金身/连胜被终结（需赛前连况）
  dramaScore: number; // 0-100 戏剧性评分（确定性加权；驱动角度选择/首页头条/最佳比赛）
}

export function teamNameOfSide(m: FinishedMatch, side: Side): string {
  return side === "home" ? m.homeTeamName : m.awayTeamName;
}

export function computeMatchFacts(
  m: FinishedMatch,
  events: RawEvent[],
  ctx?: FactsContext,
): MatchFacts | null {
  if (m.walkoverSide !== "") return null; // 轮空/弃权场不成剧情

  const sideOfEntry = (entryId: number | null): Side | null =>
    entryId === m.homeEntryId ? "home" : entryId === m.awayEntryId ? "away" : null;
  // 得分受益方：乌龙记在摆乌龙者名下，得分的是对面
  const scoringSide = (e: RawEvent): Side | null => {
    const s = sideOfEntry(e.entryId);
    if (s === null) return null;
    return e.type === "own_goal" ? (s === "home" ? "away" : "home") : s;
  };

  // ---------- 单趟重放：比分推进 + 吃红快照 + 领先轨迹 ----------
  let cumH = 0;
  let cumA = 0;
  let lastLeader: Side | null = null; // 不因扳平重置：扳平后再由原方领先不算易手
  let leadChanges = 0;
  let maxDefHome = 0; // 主队最深落后
  let maxDefAway = 0;
  let maxLeadHome = 0;
  let maxLeadAway = 0;
  const leaderAfter: (Side | null)[] = []; // 每球之后的领先方（null=平）
  const goalMoments: (GoalMoment & { prevLeader: Side | null })[] = [];
  const redMoments: RedMoment[] = [];
  const ogBenefit: { side: Side; minute: number | null }[] = [];
  const penMissSides = new Set<Side>();

  for (const e of events) {
    if (e.type === "goal" || e.type === "pen_goal" || e.type === "own_goal") {
      const side = scoringSide(e);
      // 该球之前的实际局面（平局为 null）——绝杀/点球制胜的判定依据，与易手游标分开
      const prevLeader: Side | null = cumH > cumA ? "home" : cumA > cumH ? "away" : null;
      if (side === "home") cumH += 1;
      else if (side === "away") cumA += 1;
      if (e.type === "own_goal" && side) ogBenefit.push({ side, minute: e.minute });
      const leader: Side | null = cumH > cumA ? "home" : cumA > cumH ? "away" : null;
      if (leader && lastLeader && leader !== lastLeader) leadChanges += 1;
      if (leader) lastLeader = leader;
      leaderAfter.push(leader);
      maxDefHome = Math.max(maxDefHome, cumA - cumH);
      maxDefAway = Math.max(maxDefAway, cumH - cumA);
      maxLeadHome = Math.max(maxLeadHome, cumH - cumA);
      maxLeadAway = Math.max(maxLeadAway, cumA - cumH);
      goalMoments.push({
        side,
        minute: e.minute,
        type: e.type,
        playerName: e.playerName,
        playerId: e.playerId,
        prevLeader,
      });
    } else if (e.type === "red" || e.type === "red_2y") {
      const s = sideOfEntry(e.entryId);
      if (s) {
        const diffFor = s === "home" ? cumH - cumA : cumA - cumH;
        redMoments.push({
          side: s,
          minute: e.minute,
          type: e.type,
          playerName: e.playerName,
          scoreHome: cumH,
          scoreAway: cumA,
          diffFor,
          state: diffFor > 0 ? "leading" : diffFor === 0 ? "level" : "behind",
        });
      }
    } else if (e.type === "pen_miss") {
      const s = sideOfEntry(e.entryId);
      if (s) penMissSides.add(s);
    }
  }

  // ---------- 基本盘 ----------
  const totalGoals = m.scoreHome + m.scoreAway;
  const margin = Math.abs(m.scoreHome - m.scoreAway);
  const winnerSide: Side | null =
    m.scoreHome > m.scoreAway ? "home" : m.scoreAway > m.scoreHome ? "away" : null;
  const penShootout =
    winnerSide === null && m.penHome != null && m.penAway != null && m.penHome !== m.penAway
      ? { home: m.penHome, away: m.penAway }
      : null;
  const firstGoal = goalMoments[0] ?? null;
  const lastGoal = goalMoments[goalMoments.length - 1] ?? null;
  // null 分钟排在最前（COALESCE(minute,-1)），首球时间未知即整场时间不可知
  const timingKnown = !firstGoal || firstGoal.minute !== null;
  const knownMinutes = timingKnown ? goalMoments.map((g) => g.minute as number) : [];

  // ---------- 时间类剧情 ----------
  const openingBolt = timingKnown && firstGoal != null && firstGoal.minute! <= BOLT_MAX_MIN;
  const firstHalfQuiet = timingKnown && !knownMinutes.some((min) => min <= FIRST_HALF_END);
  let drought: MatchFacts["drought"] = null;
  if (timingKnown) {
    const bounds = [0, ...knownMinutes, 90];
    for (let i = 1; i < bounds.length; i++) {
      const gap = bounds[i] - bounds[i - 1];
      if (gap >= DROUGHT_MIN) {
        drought = { from: bounds[i - 1], to: bounds[i], minutes: gap };
        break;
      }
    }
  }
  let goalBurst: MatchFacts["goalBurst"] = null;
  if (timingKnown && knownMinutes.length >= BURST_MIN_GOALS) {
    for (let i = 0; i + BURST_MIN_GOALS - 1 < knownMinutes.length; i++) {
      const j = i + BURST_MIN_GOALS - 1;
      if (knownMinutes[j] - knownMinutes[i] <= BURST_WINDOW) {
        goalBurst = { from: knownMinutes[i], to: knownMinutes[j], count: BURST_MIN_GOALS };
        break;
      }
    }
  }
  const lateFlurryCount = timingKnown
    ? knownMinutes.filter((min) => min >= LATE_FLURRY_MIN).length
    : 0;
  const lateWinner =
    timingKnown &&
    lastGoal != null &&
    lastGoal.minute != null &&
    lastGoal.minute >= LATE_WINNER_MIN &&
    winnerSide != null &&
    lastGoal.side === winnerSide &&
    lastGoal.prevLeader !== winnerSide;

  // ---------- 逆转 / 领先轨迹 ----------
  const comeback: MatchFacts["comeback"] =
    winnerSide === "home"
      ? maxDefHome >= 2
        ? "big"
        : maxDefHome === 1
          ? "small"
          : null
      : winnerSide === "away"
        ? maxDefAway >= 2
          ? "big"
          : maxDefAway === 1
            ? "small"
            : null
        : null;
  const blownLead =
    (maxLeadHome >= 2 && winnerSide !== "home") || (maxLeadAway >= 2 && winnerSide !== "away");
  const bothLed = maxLeadHome > 0 && maxLeadAway > 0;
  // 被追平后再度领先并赢下：胜方 W 的轨迹里存在 W→平→W
  const equalizeRetake = (() => {
    if (!winnerSide) return false;
    let seenLead = false;
    let seenLevel = false;
    for (const l of leaderAfter) {
      if (l === winnerSide) {
        if (seenLevel) return true;
        seenLead = true;
      } else if (l === null && seenLead) {
        seenLevel = true;
      }
    }
    return false;
  })();

  let shape: MatchFacts["shape"] = "normal";
  if (margin >= 3) shape = "oneSided";
  else if (totalGoals <= 1 && !lateWinner) shape = "dull";
  else if (bothLed || leadChanges >= 2 || totalGoals >= 5) shape = "seeSaw";

  // ---------- 红牌转折 ----------
  let redTurn: MatchFacts["redTurn"] = null;
  const redSides = new Set(redMoments.map((r) => r.side));
  if (redMoments.length > 0 && redSides.size === 1) {
    const first = redMoments[0];
    if (first.minute != null) {
      const finalDiffFor =
        first.side === "home" ? m.scoreHome - m.scoreAway : m.scoreAway - m.scoreHome;
      const outcome: NonNullable<MatchFacts["redTurn"]>["outcome"] =
        finalDiffFor > first.diffFor
          ? "improved"
          : finalDiffFor === first.diffFor
            ? "held"
            : finalDiffFor <= 0
              ? "collapsed"
              : "faded";
      redTurn = {
        side: first.side,
        minute: first.minute,
        type: first.type,
        playerName: first.playerName,
        state: first.state,
        outcome,
      };
    }
  }

  // ---------- 点球戏 / 乌龙 ----------
  const penGoalCount = goalMoments.filter((g) => g.type === "pen_goal").length;
  const penDecider =
    lastGoal != null &&
    lastGoal.type === "pen_goal" &&
    winnerSide != null &&
    lastGoal.side === winnerSide &&
    lastGoal.prevLeader !== winnerSide;
  const penMissCount = penMissSides.size;
  const penMissSwing = winnerSide != null && penMissSides.has(winnerSide);
  const ogFor = (side: Side) => ogBenefit.filter((o) => o.side === side).length;
  const ogDecider =
    winnerSide != null &&
    (winnerSide === "home"
      ? m.scoreHome - ogFor("home") <= m.scoreAway
      : m.scoreAway - ogFor("away") <= m.scoreHome);

  // ---------- 个人表演 ----------
  const bags = new Map<number, { playerName: string; side: Side; goals: number }>();
  for (const g of goalMoments) {
    if (g.type === "own_goal" || g.playerId == null || !g.side) continue;
    const cur = bags.get(g.playerId) ?? {
      playerName: g.playerName ?? "未知球员",
      side: g.side,
      goals: 0,
    };
    cur.goals += 1;
    bags.set(g.playerId, cur);
  }
  const playerBags = [...bags.entries()].map(([playerId, v]) => ({ playerId, ...v }));
  const soloAct =
    playerBags.find(
      (p) => p.goals >= 2 && p.goals + ogFor(p.side) === (p.side === "home" ? m.scoreHome : m.scoreAway),
    ) ?? null;
  const maxBagGoals = playerBags.reduce((mx, p) => Math.max(mx, p.goals), 0);
  // 同一条连线（射手+助攻）一场两度以上
  const links = new Map<string, { scorerName: string; assistName: string; count: number }>();
  for (const e of events) {
    if ((e.type !== "goal" && e.type !== "pen_goal") || e.playerId == null || e.assistPlayerId == null)
      continue;
    const k = `${e.playerId}|${e.assistPlayerId}`;
    const cur = links.get(k) ?? {
      scorerName: e.playerName ?? "未知球员",
      assistName: e.assistName ?? "未知球员",
      count: 0,
    };
    cur.count += 1;
    links.set(k, cur);
  }
  const linkTwice =
    [...links.values()].sort((a, b) => b.count - a.count).find((l) => l.count >= 2) ?? null;

  // ---------- 赛前语境：爆冷 / 金身告破 ----------
  const rankOf = (side: Side | null) =>
    side === "home" ? ctx?.homeRankBefore : side === "away" ? ctx?.awayRankBefore : undefined;
  let upset: MatchFacts["upset"] = null;
  if (winnerSide != null) {
    const wr = rankOf(winnerSide);
    const lr = rankOf(winnerSide === "home" ? "away" : "home");
    if (wr != null && lr != null && wr - lr >= UPSET_RANK_GAP) {
      upset = { winnerName: teamNameOfSide(m, winnerSide), winnerRank: wr, loserRank: lr };
    }
  }
  let streakBroken: MatchFacts["streakBroken"] = null;
  if (winnerSide != null) {
    const loserSide: Side = winnerSide === "home" ? "away" : "home";
    const ls = loserSide === "home" ? ctx?.homeStreaksBefore : ctx?.awayStreaksBefore;
    const loserName = teamNameOfSide(m, loserSide);
    if (ls) {
      if (ls.unbeaten >= UNBEATEN_BROKEN_MIN) streakBroken = { kind: "unbeaten", count: ls.unbeaten, teamName: loserName };
      else if (ls.win >= STREAK_KILLED_MIN) streakBroken = { kind: "win", count: ls.win, teamName: loserName };
    }
  }

  // ---------- dramaScore（确定性加权，封顶 100） ----------
  let drama = 0;
  if (comeback === "big") drama += 30;
  else if (comeback === "small") drama += 16;
  if (lateWinner) drama += 22;
  if (lateFlurryCount >= 2) drama += 8;
  drama += Math.min(leadChanges * 5, 10);
  drama += Math.min(totalGoals, 6) * 2;
  if (redTurn) drama += redTurn.outcome === "collapsed" ? 12 : redTurn.outcome === "faded" ? 4 : 10;
  if (penDecider) drama += 8;
  if (penMissSwing) drama += 10;
  if (ogDecider) drama += 6;
  if (soloAct) drama += 8;
  if (maxBagGoals >= 4) drama += 6;
  else if (maxBagGoals === 3) drama += 4;
  if (blownLead) drama += 10;
  if (goalBurst) drama += 5;
  if (bothLed) drama += 4;
  if (upset) drama += 8;
  if (streakBroken) drama += 6;
  const dramaScore = Math.min(drama, 100);

  return {
    totalGoals,
    margin,
    winnerSide,
    penShootout,
    timingKnown,
    firstGoal: firstGoal ?? null,
    lastGoal: lastGoal ?? null,
    openingBolt,
    firstHalfQuiet,
    drought,
    goalBurst,
    lateFlurryCount,
    lateWinner,
    comeback,
    blownLead,
    bothLed,
    leadChanges,
    equalizeRetake,
    shape,
    reds: redMoments,
    redTurn,
    penGoalCount,
    penDecider,
    penMissCount,
    penMissSwing,
    ogBenefit,
    ogDecider,
    playerBags,
    soloAct,
    maxBagGoals,
    linkTwice,
    upset,
    streakBroken,
    dramaScore,
  };
}

// ---------- 跨场之最（综述「本轮之最」/ 周报「本周最佳比赛」的原料） ----------

export interface RoundEntry {
  m: FinishedMatch;
  facts: MatchFacts | null;
}

const matchLabel = (m: FinishedMatch): string => `${m.homeTeamName} vs ${m.awayTeamName}`;

export interface RoundExtremes {
  fastestGoal: { minute: number; playerName: string | null; matchId: number; label: string } | null;
  latestGoal: { minute: number; playerName: string | null; matchId: number; label: string } | null;
  latestWinner: { minute: number; playerName: string | null; matchId: number; label: string } | null;
  maxMargin: { matchId: number; label: string; score: string; margin: number } | null;
  mostGoals: { matchId: number; label: string; score: string; goals: number } | null;
  redCount: number;
}

export function summarizeRound(entries: RoundEntry[]): RoundExtremes {
  const out: RoundExtremes = {
    fastestGoal: null,
    latestGoal: null,
    latestWinner: null,
    maxMargin: null,
    mostGoals: null,
    redCount: 0,
  };
  for (const { m, facts } of entries) {
    if (!facts) continue;
    out.redCount += facts.reds.length;
    const consider = (cur: { minute: number } | null, next: { minute: number }): boolean =>
      cur === null || next.minute < cur.minute;
    if (facts.firstGoal?.minute != null) {
      const cand = {
        minute: facts.firstGoal.minute,
        playerName: facts.firstGoal.playerName,
        matchId: m.id,
        label: matchLabel(m),
      };
      if (consider(out.fastestGoal, cand)) out.fastestGoal = cand;
    }
    if (facts.lastGoal?.minute != null) {
      const cand = {
        minute: facts.lastGoal.minute,
        playerName: facts.lastGoal.playerName,
        matchId: m.id,
        label: matchLabel(m),
      };
      if (!out.latestGoal || cand.minute > out.latestGoal.minute) out.latestGoal = cand;
      if (facts.lateWinner && (!out.latestWinner || cand.minute > out.latestWinner.minute))
        out.latestWinner = cand;
    }
    const margin = facts.margin;
    if (margin > 0 && (!out.maxMargin || margin > out.maxMargin.margin)) {
      out.maxMargin = {
        matchId: m.id,
        label: matchLabel(m),
        score: `${m.scoreHome}:${m.scoreAway}`,
        margin,
      };
    }
    if (!out.mostGoals || facts.totalGoals > out.mostGoals.goals) {
      out.mostGoals = {
        matchId: m.id,
        label: matchLabel(m),
        score: `${m.scoreHome}:${m.scoreAway}`,
        goals: facts.totalGoals,
      };
    }
  }
  return out;
}

// 本轮/本周最佳比赛：dramaScore 最高（平分取先完赛者，确定性）
export function bestMatchOf(
  entries: RoundEntry[],
): { matchId: number; label: string; score: string; dramaScore: number } | null {
  let best: (RoundEntry & { score: string }) | null = null;
  for (const e of entries) {
    if (!e.facts) continue;
    const score = `${e.m.scoreHome}:${e.m.scoreAway}`;
    if (!best || e.facts.dramaScore > best.facts!.dramaScore) best = { ...e, score };
  }
  if (!best || !best.facts) return null;
  return {
    matchId: best.m.id,
    label: matchLabel(best.m),
    score: best.score,
    dramaScore: best.facts.dramaScore,
  };
}
