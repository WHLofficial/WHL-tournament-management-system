// #13 头版门户：单场战报文章引擎。news-writing 倒金字塔：
// 标题（结果导向）→ 导语（谁/何时/结果/意义）→ 过程（比分状态机选句）→ 赛事背景段 → 数据框。
// 全部句子由比赛事实模板化生成：数据不动文章一字不动，数据变了自动重写（纯派生，无撤稿概念）。
import type { MatchReportDTO, ReportCardDTO, ReportGoalDTO } from "../../shared/news";
import { chance, pickText } from "../../shared/textpick";
import {
  cnDate,
  cnum,
  currentStreaks,
  fetchEventRows,
  fetchMatchById,
  fetchScorerTotals,
  fetchStageMaxRounds,
  fetchTournamentFinished,
  rankOf,
  roundLabel,
  scorersBefore,
  standingsBefore,
  standingsSnapshot,
  type FinishedMatch,
  type RawEvent,
} from "./context";
import { BREATH, RATES, SEAL_REPLACE, SEAL_WORDS, heroPhrase, pickReportDrama } from "./copybanks";
import { computeMatchFacts } from "./narrativeFacts";

interface GoalFact {
  minute: number | null;
  playerName: string | null;
  teamName: string;
  side: "home" | "away";
  type: "goal" | "pen_goal" | "own_goal";
  assistId: number | null; // 助攻者（own_goal 恒为 null）
  assistName: string | null;
  sentenceIdx: number; // 对应过程句下标（功臣后缀挂最后一句）
  playerKey: string;
}

// 过程句生成：按时间顺序走一遍事件流，用比分状态机选动词
function buildNarrative(
  m: FinishedMatch,
  events: RawEvent[],
): { sentences: string[]; goalFacts: GoalFact[]; cards: ReportCardDTO[] } {
  const sentences: string[] = [];
  const goalFacts: GoalFact[] = [];
  const cards: ReportCardDTO[] = [];
  let home = 0;
  let away = 0;
  const minutePre = (minute: number | null) => (minute === null ? "比赛中，" : `第 ${minute} 分钟，`);
  let firstGoalDone = false;
  // 助攻从句整场去重：同一份战报里助攻说法不重复
  const usedAssist = new Set<string>();
  // 呼吸句：纯叙述、不带占位符的短句，只在对应事件真实发生时插入；战报预算 ≤2，逐槽 chance 门控（条件满足不一定触发）；同类事件（多次红牌/多次罚失点球）整场只呼吸一次，防同池句复现
  let breathBudget = 2;
  const breathFired = new Set<string>();
  const tryBreath = (slot: string, seed: string, pool: readonly string[]): void => {
    if (breathBudget <= 0 || breathFired.has(slot)) return;
    if (!chance(`${seed}:go`, RATES.breathReport)) return;
    sentences.push(pickText(seed, pool));
    breathFired.add(slot);
    breathBudget -= 1;
  };

  for (const e of events) {
    const side = e.entryId !== null ? (e.entryId === m.homeEntryId ? "home" : e.entryId === m.awayEntryId ? "away" : null) : null;
    const isGoalish = e.type === "goal" || e.type === "pen_goal" || e.type === "own_goal";
    if (isGoalish && side) {
      const scoring = e.type === "own_goal" ? (side === "home" ? "away" : "home") : side;
      const scoringTeam = scoring === "home" ? m.homeTeamName : m.awayTeamName;
      const beforeLevel = home === away;
      const wasBehind = scoring === "home" ? home < away : away < home;
      const wasAhead = scoring === "home" ? home > away : away > home;
      if (e.type === "own_goal") {
        if (scoring === "home") away += 1;
        else home += 1;
      } else if (scoring === "home") home += 1;
      else away += 1;

      const pre = minutePre(e.minute);
      const who = e.playerName ?? scoringTeam; // 无球员名退化：球队口径
      // 进球动词句库：同一事实多种说法，按「比赛+事件」种子确定性选一条（重复请求不变，不同场散开）
      const evSeed = `${m.id}:${e.minute ?? "x"}:${e.playerId ?? e.playerName ?? "?"}:${e.type}`;
      const isFirst = !firstGoalDone;
      let verb: string;
      if (!firstGoalDone) {
        verb =
          e.type === "own_goal"
            ? pickText(evSeed, ["不慎自摆乌龙，场上僵局就此打破", "自摆乌龙，送出本场第一球"])
            : e.type === "pen_goal"
              ? pickText(evSeed, ["点球命中，率先打破僵局", "顶住压力罚进点球，首开纪录", "主罚点球稳稳命中，拔得头筹"])
              : pickText(evSeed, ["率先打破僵局", "首开纪录", "拔得头筹", "打进本场第一球"]);
        firstGoalDone = true;
      } else if (wasBehind && home !== away && (scoring === "home" ? home > away : away > home)) {
        verb = e.type === "pen_goal"
          ? pickText(evSeed, [`点球命中，帮助${scoringTeam}再度超出`, `点球罚进，${scoringTeam}反超了比分`])
          : pickText(evSeed, [`帮助${scoringTeam}再度超出`, `帮${scoringTeam}重新取得领先`, `让${scoringTeam}反超了比分`]);
      } else if (wasBehind && home === away) {
        verb =
          e.type === "own_goal"
            ? pickText(evSeed, [`不慎自摆乌龙，${scoringTeam} 得以扳平`, `自摆乌龙，${scoringTeam} 将比分追平`])
            : e.type === "pen_goal"
              ? pickText(evSeed, [`点球命中，为${scoringTeam}扳平比分`, `顶住压力罚进点球，扳平比分`, `点球稳稳罚进，双方回到同一起跑线`])
              : pickText(evSeed, [`为${scoringTeam}扳平比分`, `把比分追成平手`, `帮${scoringTeam}追平`]);
      } else if (beforeLevel) {
        // 平局僵持中超出（非首球）：重新领先
        verb = e.type === "pen_goal"
          ? pickText(evSeed, [`点球命中，${scoringTeam}再度领先`, `点球罚进，${scoringTeam}再次超出`])
          : pickText(evSeed, [`帮助${scoringTeam}再度领先`, `让${scoringTeam}再次超出`, `帮${scoringTeam}重新取得领先`]);
      } else if (wasAhead) {
        // 领先方扩大优势（是否锁定胜局在下方按「此后对方是否再进球」回填；动词须含下方回填替换词表中的词）
        verb = e.type === "pen_goal"
          ? pickText(evSeed, ["点球再下一城", "点球命中，扩大战果", "点球再进一球"])
          : pickText(evSeed, ["再下一城", "扩大战果", "再入一球"]);
      } else {
        verb = pickText(evSeed, [`为${scoringTeam}扳回一城`, `帮${scoringTeam}追回一球`]);
      }
      // 助攻从句：只给关键节点进球提（首开纪录/扳平/反超），且写在进球之前——数据里几乎每个进球
      // 都记了助攻，逐个写太机械；领先方扩大优势、落后方追回一球都不提。句库散变体 + 整场去重（乌龙无助攻）。
      const assistLead = (() => {
        const nowAhead = scoring === "home" ? home > away : away > home;
        const key = !wasAhead && (nowAhead || home === away);
        if (!e.assistName || e.type === "own_goal" || !key) return "";
        const pool = ["送出助攻", "助攻得手", "送出妙传", "贡献一记助攻", "做饼得手", "送出致命一传"];
        const seed = `${evSeed}:ast`;
        let a = pickText(seed, pool);
        if (usedAssist.has(a)) a = pickText(`${seed}:r`, pool);
        if (usedAssist.has(a)) a = pool.find((x) => !usedAssist.has(x)) ?? a;
        usedAssist.add(a);
        return `${e.assistName} ${a}，`;
      })();
      const s = `${pre}${assistLead}${who} ${verb}。`;
      sentences.push(s);
      goalFacts.push({
        minute: e.minute,
        playerName: e.playerName,
        teamName: scoringTeam,
        side: scoring,
        type: e.type as "goal" | "pen_goal" | "own_goal",
        assistId: e.type !== "own_goal" ? e.assistPlayerId : null,
        assistName: e.type !== "own_goal" ? e.assistName : null,
        sentenceIdx: sentences.length - 1,
        playerKey: e.playerId === null ? `team:${scoringTeam}` : `p:${e.playerId}`,
      });
      if (isFirst && e.minute !== null && e.minute <= 10) {
        tryBreath("bref", `${m.id}:bref`, BREATH.bolt);
      }
      continue;
    }
    if (e.type === "pen_miss") {
      sentences.push(
        `${minutePre(e.minute)}${e.playerName ?? "球员"}${pickText(`${m.id}:${e.minute ?? "x"}:pm:${e.playerId ?? e.playerName ?? "?"}`, [
          "主罚点球未能命中。",
          "点球罚失。",
          "没能把点球罚进。",
        ])}`,
      );
      tryBreath("brpm", `${m.id}:brpm`, BREATH.penMissLive);
      continue;
    }
    if (e.type === "red" || e.type === "red_2y") {
      const redSeed = `${m.id}:${e.minute ?? "x"}:red:${e.playerId ?? e.playerName ?? "?"}`;
      const redPhrase =
        e.type === "red"
          ? pickText(redSeed, ["直接红牌被罚下", "吃到红牌，提前回了更衣室", "被主裁直接出示红牌"])
          : pickText(redSeed, ["两黄变一红被罚下", "领到第二张黄牌，两黄变一红", "累积两黄，被红牌罚下"]);
      sentences.push(`${minutePre(e.minute)}${e.playerName ?? "球员"} ${redPhrase}。`);
      tryBreath("brred", `${m.id}:brred`, BREATH.redLive);
      cards.push({
        type: "red",
        minute: e.minute,
        playerName: e.playerName,
        playerId: e.playerId,
        teamName: side === "home" ? m.homeTeamName : m.awayTeamName,
      });
      continue;
    }
    if (e.type === "injury_major") {
      sentences.push(
        `${minutePre(e.minute)}${e.playerName ?? "球员"}${pickText(`${m.id}:${e.minute ?? "x"}:inj:${e.playerId ?? e.playerName ?? "?"}`, [
          "伤退离场。",
          "因伤离场。",
          "无法坚持比赛，伤退下场。",
        ])}`,
      );
      continue;
    }
    if (e.type === "yellow") {
      cards.push({
        type: "yellow",
        minute: e.minute,
        playerName: e.playerName,
        playerId: e.playerId,
        teamName: side === "home" ? m.homeTeamName : m.awayTeamName,
      });
    }
    // injury_minor 不进叙事（小伤无碍）
  }

  // 收尾呼吸句：大胜场的静态总结（纯叙述、不带数据）
  if (home !== away && Math.abs(home - away) >= 3) {
    tryBreath("brout", `${m.id}:brout`, BREATH.rout);
  }

  // 「锁定胜局」回填：最后一个进球句若是 eventual winner 打进且此后对方无进球（即它本身就是最后一粒），
  // 且比分非平——把「扩大优势类」动词句改写为锁定胜局（词表须覆盖领先方扩大/落后方追回两支句库的全部动词）
  const lastGoal = goalFacts[goalFacts.length - 1];
  if (lastGoal && home !== away) {
    const winnerSide = home > away ? "home" : "away";
    if (lastGoal.side === winnerSide) {
      sentences[lastGoal.sentenceIdx] = SEAL_WORDS.reduce(
        (acc, w) => acc.replace(w, SEAL_REPLACE),
        sentences[lastGoal.sentenceIdx],
      );
    }
  }

  // 功臣后缀：同一球员 ≥2 球，缀在其最后一次进球句的射手名后、动词前（「梅开二度锁定胜局」的战报语序）
  const byPlayer = new Map<string, { count: number; lastIdx: number; name: string }>();
  for (const g of goalFacts) {
    if (g.type === "own_goal") continue; // 乌龙不算射手功臣
    const cur = byPlayer.get(g.playerKey);
    if (cur) {
      cur.count += 1;
      cur.lastIdx = g.sentenceIdx;
    } else {
      byPlayer.set(g.playerKey, { count: 1, lastIdx: g.sentenceIdx, name: g.playerName ?? g.teamName });
    }
  }
  for (const info of byPlayer.values()) {
    if (info.count < 2) continue;
    const suffix = heroPhrase(info.count);
    const s = sentences[info.lastIdx];
    const gf = goalFacts.find((g) => g.sentenceIdx === info.lastIdx);
    const who = gf ? gf.playerName ?? gf.teamName : info.name;
    const cut = s.indexOf(`${who} `);
    const head = cut > 0 ? cut + who.length + 1 : -1;
    sentences[info.lastIdx] =
      head > 0 ? `${s.slice(0, head)}${suffix}${s.slice(head)}` : s.replace(/。$/, `，${suffix}。`);
  }

  return { sentences, goalFacts, cards };
}

// 标题与导语的结果短语
function resultPhrases(m: FinishedMatch, events: RawEvent[]) {
  const h = m.scoreHome;
  const a = m.scoreAway;
  const shootout = m.penHome !== null && m.penAway !== null;
  const penWinner =
    shootout && m.penHome !== m.penAway ? (m.penHome! > m.penAway! ? m.homeTeamName : m.awayTeamName) : null;
  const winner =
    shootout && penWinner
      ? penWinner
      : h > a
        ? m.homeTeamName
        : a > h
          ? m.awayTeamName
          : null;
  const loser = winner ? (winner === m.homeTeamName ? m.awayTeamName : m.homeTeamName) : null;

  let title: string;
  if (winner && shootout) {
    title = pickText(`t1:${m.id}`, [
      `${winner} ${h}:${a}（点 ${m.penHome}:${m.penAway}）淘汰 ${loser}`,
      `${winner} 点球 ${m.penHome}:${m.penAway} 淘汰 ${loser}`,
      `点球大战 ${m.penHome}:${m.penAway}，${winner} 过关`,
      `${winner} 笑到最后：点球 ${m.penHome}:${m.penAway}`,
      `${h}:${a} 之后点球决胜，${winner} 挺进下一轮`,
      `常规时间 ${h}:${a}，点球 ${m.penHome}:${m.penAway} ${winner} 胜出`,
    ]);
  } else if (h > a) {
    title = pickText(`t2:${m.id}`, [
      `${m.homeTeamName} ${h}:${a} 击败 ${m.awayTeamName}`,
      `${m.homeTeamName} 主场 ${h}:${a} 拿下 ${m.awayTeamName}`,
      `${m.homeTeamName} ${h}:${a} 战胜 ${m.awayTeamName}`,
      `${m.homeTeamName} 主场 ${h}:${a} 告捷`,
      `全场 ${h}:${a}，${m.homeTeamName} 击退 ${m.awayTeamName}`,
      `${m.homeTeamName} ${h}:${a} 拿下主场`,
    ]);
  } else if (a > h) {
    title = pickText(`t3:${m.id}`, [
      `${m.awayTeamName} 客场 ${a}:${h} 击败 ${m.homeTeamName}`,
      `${m.awayTeamName} ${a}:${h} 战胜 ${m.homeTeamName}`,
      `${m.homeTeamName} 主场 ${h}:${a} 不敌 ${m.awayTeamName}`,
      `${m.awayTeamName} 客场 ${a}:${h} 带走胜利`,
      `${m.homeTeamName} ${h}:${a} 落败，${m.awayTeamName} 客场得手`,
      `客场作战的 ${m.awayTeamName} ${a}:${h} 击退 ${m.homeTeamName}`,
    ]);
  } else {
    title = pickText(`t4:${m.id}`, [
      `${m.homeTeamName} ${h}:${a} 战平 ${m.awayTeamName}`,
      `${m.homeTeamName} 与 ${m.awayTeamName} ${h}:${a} 言和`,
      `${h}:${a}，${m.homeTeamName} 与 ${m.awayTeamName} 各取一分`,
      `${m.homeTeamName} 与 ${m.awayTeamName} 打成 ${h}:${a}`,
      `${h}:${a} 收场，双方均未占得便宜`,
    ]);
  }

  // 功臣后缀（≥2 球）
  const counts = new Map<string, number>();
  for (const e of events) {
    if ((e.type === "goal" || e.type === "pen_goal") && e.playerName)
      counts.set(e.playerName, (counts.get(e.playerName) ?? 0) + 1);
  }
  let hero: { name: string; goals: number } | null = null;
  for (const [name, n] of counts) if (!hero || n > hero.goals) hero = { name, goals: n };
  if (hero && hero.goals >= 2) {
    const suffix = heroPhrase(hero.goals);
    title += `，${hero.name} ${suffix}`;
  }

  let outcome: string;
  if (shootout && penWinner) outcome = `${penWinner} 点球 ${m.penHome}:${m.penAway} 淘汰对手`;
  else if (winner) outcome = m.stageKind === "elim" ? `${winner} 挺进下一轮` : `${winner} 拿下三分`;
  else outcome = "双方各取一分";

  return { title, outcome, hero };
}

export async function buildMatchReport(db: D1Database, mid: number): Promise<MatchReportDTO | null> {
  const m = await fetchMatchById(db, mid);
  if (!m || m.status !== "finished") return null; // 只对完赛场出文（含弃权）

  const eventsByMatch = await fetchEventRows(db, [m.id]);
  const events = eventsByMatch.get(m.id) ?? [];
  const maxRounds = await fetchStageMaxRounds(db, [m.stageId]);
  const rl = roundLabel(m, maxRounds.get(m.stageId) ?? m.round);

  // ---------- 弃权场：独立模板 ----------
  if (m.walkoverSide === "home" || m.walkoverSide === "away" || m.walkoverSide === "both") {
    const loser = m.walkoverSide === "home" ? m.homeTeamName : m.walkoverSide === "away" ? m.awayTeamName : null;
    const winner = loser ? (loser === m.homeTeamName ? m.awayTeamName : m.homeTeamName) : null;
    const dateStr = cnDate(m.finishedAt);
    const title =
      m.walkoverSide === "both"
        ? `${m.homeTeamName} 与 ${m.awayTeamName} 双双弃权`
        : `${loser} 弃权，${winner} 不战而胜`;
    const lede =
      m.walkoverSide === "both"
        ? `${rl}（${dateStr}）因双方均弃权未能进行，依规则双方各记负，不计进球。`
        : `${rl}（${dateStr}）因 ${loser} 弃权未能进行，依规则判 ${winner} 获胜。`;
    return {
      matchId: m.id,
      tournamentId: m.tournamentId,
      tournamentName: m.tournamentName,
      roundLabel: rl,
      finishedAt: m.finishedAt,
      homeTeamName: m.homeTeamName,
      awayTeamName: m.awayTeamName,
      homeLogoUrl: m.homeLogoUrl,
      awayLogoUrl: m.awayLogoUrl,
      scoreHome: m.scoreHome,
      scoreAway: m.scoreAway,
      penHome: m.penHome,
      penAway: m.penAway,
      walkoverSide: m.walkoverSide as MatchReportDTO["walkoverSide"],
      title,
      lede,
      paragraphs: m.note ? [`赛会备注：${m.note}。`] : [],
      context: [],
      goals: [],
      cards: [],
      note: m.note,
    };
  }

  // ---------- 正常场 ----------
  // 事实层：剧情句（2.5 节）与近况段共用的本场画像；呼吸句槽仍由事件流驱动，不依赖 facts
  const facts = computeMatchFacts(m, events);
  const { sentences, goalFacts, cards } = buildNarrative(m, events);
  const { title, outcome, hero } = resultPhrases(m, events);
  const dateStr = cnDate(m.finishedAt);
  // 导语按「点球 / 大胜(净胜≥3) / 常规胜负 / 平局」分档，档内 6 个结构变体按比赛种子确定性选一
  const shootout = m.penHome !== null && m.penAway !== null;
  const regWinner = m.scoreHome > m.scoreAway ? m.homeTeamName : m.scoreAway > m.scoreHome ? m.awayTeamName : null;
  const loserName = regWinner ? (regWinner === m.homeTeamName ? m.awayTeamName : m.homeTeamName) : null;
  const margin = Math.abs(m.scoreHome - m.scoreAway);
  const sw = m.scoreHome >= m.scoreAway ? `${m.scoreHome}:${m.scoreAway}` : `${m.scoreAway}:${m.scoreHome}`;
  const heroTail = hero && hero.goals >= 2 ? `，${hero.name} 凭 ${hero.goals} 粒进球当选本场焦点` : "";
  const ledeSeed = `lede:${m.id}`;
  let lede: string;
  if (shootout) {
    lede = pickText(ledeSeed, [
      `${rl}（${dateStr}），${m.homeTeamName} 与 ${m.awayTeamName} ${m.scoreHome}:${m.scoreAway} 战罢难分高下，${outcome}${heroTail}。`,
      `${rl}（${dateStr}）被拖入点球大战，常规时间 ${m.homeTeamName} 与 ${m.awayTeamName} 战成 ${m.scoreHome}:${m.scoreAway}，${outcome}${heroTail}。`,
      `十二码决出胜负：${rl}（${dateStr}），${m.homeTeamName} 与 ${m.awayTeamName} ${m.scoreHome}:${m.scoreAway} 之后仍未分高下，${outcome}${heroTail}。`,
      `${rl}（${dateStr}），${m.scoreHome}:${m.scoreAway} 之后双方走上点球点，${outcome}${heroTail}。`,
    ]);
  } else if (regWinner && margin >= 3) {
    lede = pickText(ledeSeed, [
      `${rl}（${dateStr}），${regWinner} ${sw} 大胜 ${loserName}，${outcome}${heroTail}。`,
      `${rl}（${dateStr}）呈现一边倒，${regWinner} 以 ${sw} 击溃 ${loserName}，${outcome}${heroTail}。`,
      `${dateStr}的${rl}，${regWinner} 打出 ${sw}，轻取 ${loserName}，${outcome}${heroTail}。`,
      `比分定格在 ${sw}：${rl}（${dateStr}），${regWinner} 完胜 ${loserName}，${outcome}${heroTail}。`,
      `${rl}（${dateStr}），${regWinner} 收获一场 ${sw} 的大胜，${outcome}${heroTail}。`,
      `${rl}（${dateStr}），${loserName} 挡不住 ${regWinner} 的攻势，以 ${sw} 败下阵来，${outcome}${heroTail}。`,
    ]);
  } else if (regWinner) {
    lede = pickText(ledeSeed, [
      `${rl}（${dateStr}），${m.homeTeamName} 与 ${m.awayTeamName} ${m.scoreHome}:${m.scoreAway} 战罢，${outcome}${heroTail}。`,
      `${rl}（${dateStr}），${regWinner} 凭 ${sw} 击败 ${loserName}，${outcome}${heroTail}。`,
      `${dateStr}，${rl}：${m.homeTeamName} ${m.scoreHome}:${m.scoreAway} ${m.awayTeamName}，${outcome}${heroTail}。`,
      `${rl}（${dateStr}）战罢，记分牌停在 ${m.scoreHome}:${m.scoreAway}，胜者是 ${regWinner}，${outcome}${heroTail}。`,
      `终场哨响，${rl}（${dateStr}）的比分是 ${m.scoreHome}:${m.scoreAway}，${outcome}${heroTail}。`,
      `${rl}（${dateStr}），比分 ${m.scoreHome}:${m.scoreAway}，${regWinner} 带走胜利，${outcome}${heroTail}。`,
    ]);
  } else {
    lede = pickText(ledeSeed, [
      `${rl}（${dateStr}），${m.homeTeamName} 与 ${m.awayTeamName} ${m.scoreHome}:${m.scoreAway} 战罢，${outcome}${heroTail}。`,
      `${rl}（${dateStr}），${m.homeTeamName} 与 ${m.awayTeamName} ${m.scoreHome}:${m.scoreAway} 握手言和，${outcome}${heroTail}。`,
      `谁也没能带走胜利：${rl}（${dateStr}），${m.homeTeamName} 与 ${m.awayTeamName} 战成 ${m.scoreHome}:${m.scoreAway}，${outcome}${heroTail}。`,
      `${dateStr}，${rl}：${m.homeTeamName} ${m.scoreHome}:${m.scoreAway} ${m.awayTeamName}，${outcome}${heroTail}。`,
      `${rl}（${dateStr}）的比分最终停在 ${m.scoreHome}:${m.scoreAway}，${outcome}${heroTail}。`,
      `${rl}（${dateStr}）打成平手，${m.homeTeamName} 与 ${m.awayTeamName} ${m.scoreHome}:${m.scoreAway}，${outcome}${heroTail}。`,
    ]);
  }

  // 过程分节：句多时拆两段，保持「可扫描结构」
  const paragraphs: string[] = [];
  if (sentences.length === 0) {
    paragraphs.push(
      m.scoreHome === 0 && m.scoreAway === 0
        ? pickText(`z:${m.id}`, [
            "全场比赛，双方均无进球入账。",
            "终场哨响，双方都没能找到进球的办法。",
            "谁也没能敲开对方的球门，比分就此定格。",
          ])
        : `比分 ${m.scoreHome}:${m.scoreAway}，进球明细未录入。`,
    );
  } else if (sentences.length <= 5) {
    paragraphs.push(sentences.join(""));
  } else {
    const half = Math.ceil(sentences.length / 2);
    paragraphs.push(sentences.slice(0, half).join(""));
    paragraphs.push(sentences.slice(half).join(""));
  }

  // ---------- 背景与影响（倒金字塔：赛前事实留「赛事背景」块；本场之后才成立的事进正文收尾段） ----------
  const context: string[] = [];
  const aftermath: string[] = [];
  if (m.walkoverSide === "") {
    const [snap, tFinished, scorerTotals] = await Promise.all([
      m.stageKind === "elim" ? Promise.resolve(null) : standingsSnapshot(db, m.stageId),
      fetchTournamentFinished(db, m.tournamentId),
      fetchScorerTotals(db, m.tournamentId),
    ]);
    const idx = tFinished.findIndex((x) => x.id === m.id);
    const beforeList = idx >= 0 ? tFinished.slice(0, idx) : tFinished.slice(0, -1);
    const afterList = idx >= 0 ? tFinished.slice(0, idx + 1) : tFinished;

    // 1) 赛前态势 + 榜首大战
    let before: ReturnType<typeof standingsBefore> = null;
    if (snap) {
      before = standingsBefore(snap, m);
      if (before) {
        const hb = before.byEntry.get(m.homeEntryId);
        const ab = before.byEntry.get(m.awayEntryId);
        if (hb && ab && hb.played > 0 && ab.played > 0) {
          const topTwo = [hb, ab].every((r) => r.rank <= 2);
          if (topTwo && Math.abs(hb.pts - ab.pts) <= 2) {
            const leader = hb.pts >= ab.pts ? hb : ab;
            context.push(
              pickText(`${m.id}:ctxA`, [
                `赛前 ${leader.teamName} 以 ${leader.pts} 分领跑积分榜，本场是榜首大战。`,
                `榜首大战：两队赛前分列积分榜前两位，${leader.teamName} 以 ${leader.pts} 分居首。`,
                `本场是名副其实的榜首大战，赛前两队积分只差 ${Math.abs(hb.pts - ab.pts)} 分。`,
              ]),
            );
          } else {
            const best = hb.rank <= ab.rank ? hb : ab;
            if (best.rank <= 3)
              context.push(
                pickText(`${m.id}:ctxB`, [
                  `赛前 ${best.teamName} 以 ${best.pts} 分位列积分榜第 ${best.rank} 位。`,
                  `进入本场时，${best.teamName} 以 ${best.pts} 分排在积分榜第 ${best.rank} 位。`,
                  `积分榜上，${best.teamName} 赛前位居第 ${best.rank} 位（${best.pts} 分）。`,
                ]),
              );
          }
        }
      }
    }

    // 2) 积分影响
    if (snap && before) {
      const hAfter = snap.byEntry.get(m.homeEntryId);
      const aAfter = snap.byEntry.get(m.awayEntryId);
      const winnerAfter = m.scoreHome > m.scoreAway ? hAfter : m.scoreAway > m.scoreHome ? aAfter : null;
      if (winnerAfter) {
        const oldLeader = before.leader;
        if (oldLeader && oldLeader.entryId !== winnerAfter.entryId && snap.leader?.entryId === winnerAfter.entryId) {
          aftermath.push(
            pickText(`${m.id}:ctxC`, [
              `${winnerAfter.teamName} 反超 ${oldLeader.teamName} 登顶积分榜，目前以 ${winnerAfter.pts} 分居首。`,
              `积分榜易主：${winnerAfter.teamName} 以 ${winnerAfter.pts} 分超越 ${oldLeader.teamName}，登上头名。`,
            ]),
          );
        } else if (snap.leader?.entryId === winnerAfter.entryId && oldLeader?.entryId === winnerAfter.entryId) {
          const second = snap.rows.find((r) => r.rank === 2);
          const gap = second ? winnerAfter.pts - second.pts : 0;
          const secondBefore = before.rows.find((r) => r.rank === 2);
          const gapBefore = secondBefore ? winnerAfter.pts + 3 - secondBefore.pts : 0;
          aftermath.push(
            gap > gapBefore
              ? pickText(`${m.id}:ctxD`, [
                  `${winnerAfter.teamName} 将领先优势扩大到 ${gap} 分。`,
                  `${winnerAfter.teamName} 的领跑优势扩大到 ${gap} 分。`,
                ])
              : pickText(`${m.id}:ctxE`, [
                  `${winnerAfter.teamName} 继续领跑积分榜。`,
                  `积分榜上，${winnerAfter.teamName} 依旧排在头名。`,
                ]),
          );
        } else {
          aftermath.push(
            pickText(`${m.id}:ctxF`, [
              `${winnerAfter.teamName} 目前以 ${winnerAfter.pts} 分位列积分榜第 ${winnerAfter.rank} 位。`,
              `积分榜上，${winnerAfter.teamName} 以 ${winnerAfter.pts} 分排名第 ${winnerAfter.rank} 位。`,
            ]),
          );
        }
      }
    }

    // 3) 纪录延续与终结（最多 2 句，终结优先）
    const wEntry = m.scoreHome > m.scoreAway ? m.homeEntryId : m.scoreAway > m.scoreHome ? m.awayEntryId : null;
    const lEntry = wEntry ? (wEntry === m.homeEntryId ? m.awayEntryId : m.homeEntryId) : null;
    const wName = wEntry === m.homeEntryId ? m.homeTeamName : m.awayTeamName;
    const lName = lEntry === m.homeEntryId ? m.homeTeamName : m.awayTeamName;

    // 2.5) 本场剧情（事实层）：逆转/绝杀/红牌/点球/一人扛队，最多 1 句，条件满足不一定触发
    if (facts) {
      const topBag =
        facts.maxBagGoals >= 2 ? facts.playerBags.find((p) => p.goals === facts.maxBagGoals) ?? null : null;
      const dramaLine = pickReportDrama(`${m.id}:rdl`, facts, {
        label: `${m.homeTeamName} vs ${m.awayTeamName}`,
        scoreLine: `${m.scoreHome}:${m.scoreAway}`,
        goalCount: facts.totalGoals,
        winnerName: wEntry ? wName : null,
        loserName: lEntry ? lName : null,
        heroName: topBag?.playerName ?? null,
        roundLabel: rl,
        redTeamName: facts.redTurn ? (facts.redTurn.side === "home" ? m.homeTeamName : m.awayTeamName) : null,
      });
      if (dramaLine) aftermath.push(dramaLine);
    }

    const streakLines: string[] = [];
    if (wEntry && lEntry) {
      const wAfter = currentStreaks(afterList, wEntry);
      const lBefore = currentStreaks(beforeList, lEntry);
      if (lBefore.win >= 2)
        streakLines.push(
          pickText(`${m.id}:rec1`, [
            `${wName} 终结了 ${lName} 的${cnum(lBefore.win)}连胜。`,
            `${lName} 的${cnum(lBefore.win)}连胜，被 ${wName} 挡停。`,
            `${lName} 的${cnum(lBefore.win)}连胜，就此作古。`,
          ]),
        );
      if (wAfter.win >= 3)
        streakLines.push(
          pickText(`${m.id}:rec2`, [
            `${wName} 收获${cnum(wAfter.win)}连胜。`,
            `${wName} 的连胜来到${cnum(wAfter.win)}场。`,
            `赢下本场，${wName} 已经连赢${cnum(wAfter.win)}场。`,
          ]),
        );
      if (lBefore.unbeaten >= 3)
        streakLines.push(
          pickText(`${m.id}:rec3`, [
            `${lName} ${cnum(lBefore.unbeaten)}场不败遭终结。`,
            `${wName} 终结了 ${lName} ${cnum(lBefore.unbeaten)} 场不败的纪录。`,
            `${lName} ${cnum(lBefore.unbeaten)} 场不败的纪录，就此作古。`,
          ]),
        );
      if (wAfter.cleanSheet >= 2)
        streakLines.push(
          pickText(`${m.id}:rec4`, [
            `${wName} 连续${cnum(wAfter.cleanSheet)}场零封。`,
            `${wName} 的球门已经连续${cnum(wAfter.cleanSheet)}场没有被攻破。`,
          ]),
        );
      if (wAfter.unbeaten >= 5)
        streakLines.push(
          pickText(`${m.id}:rec5`, [
            `${wName} 已${cnum(wAfter.unbeaten)}轮不败。`,
            `${wName} 已经${cnum(wAfter.unbeaten)}轮没输过球。`,
          ]),
        );
    } else {
      // 平局：不败/零封延续仍值得一提
      const hAfter = currentStreaks(afterList, m.homeEntryId);
      const aAfter = currentStreaks(afterList, m.awayEntryId);
      if (hAfter.unbeaten >= 5)
        streakLines.push(
          pickText(`${m.id}:rec6h`, [
            `${m.homeTeamName} 已${cnum(hAfter.unbeaten)}轮不败。`,
            `近${cnum(hAfter.unbeaten)}轮，${m.homeTeamName} 仍未尝败绩。`,
          ]),
        );
      if (aAfter.unbeaten >= 5)
        streakLines.push(
          pickText(`${m.id}:rec6a`, [
            `${m.awayTeamName} 已${cnum(aAfter.unbeaten)}轮不败。`,
            `近${cnum(aAfter.unbeaten)}轮，${m.awayTeamName} 仍未尝败绩。`,
          ]),
        );
    }
    aftermath.push(...streakLines.slice(0, 2));

    // 4) 赛季交锋（h2h，仅第二次及以后交手才写）
    const h2h = tFinished.filter(
      (x) =>
        x.id !== m.id &&
        ((x.homeEntryId === m.homeEntryId && x.awayEntryId === m.awayEntryId) ||
          (x.homeEntryId === m.awayEntryId && x.awayEntryId === m.homeEntryId)),
    );
    if (h2h.length >= 1) {
      const prev = h2h[h2h.length - 1];
      const prevWinner =
        prev.walkoverSide === "both"
          ? null
          : prev.scoreHome > prev.scoreAway
            ? prev.homeTeamName
            : prev.scoreAway > prev.scoreHome
              ? prev.awayTeamName
              : null;
      const nowWinner =
        m.scoreHome > m.scoreAway ? m.homeTeamName : m.scoreAway > m.scoreHome ? m.awayTeamName : null;
      if (nowWinner && prevWinner === nowWinner) {
        if (h2h.length === 1) {
          const opp = nowWinner === m.homeTeamName ? m.awayTeamName : m.homeTeamName;
          aftermath.push(
            pickText(`${m.id}:h2h1`, [
              `双方本赛季首回合 ${nowWinner} 曾 ${prev.scoreHome}:${prev.scoreAway} 取胜，本场完成双杀。`,
              `加上首回合的 ${prev.scoreHome}:${prev.scoreAway}，${nowWinner} 本赛季对 ${opp} 完成双杀。`,
            ]),
          );
        } else {
          // 连胜场数 = 本场 + 此前连续取胜的交锋（中断即停）
          const opp = nowWinner === m.homeTeamName ? m.awayTeamName : m.homeTeamName;
          let run = 1;
          for (let i = h2h.length - 1; i >= 0; i--) {
            const x = h2h[i];
            const xw =
              x.walkoverSide === "both"
                ? null
                : x.scoreHome > x.scoreAway
                  ? x.homeTeamName
                  : x.scoreAway > x.scoreHome
                    ? x.awayTeamName
                    : null;
            if (xw === nowWinner) run += 1;
            else break;
          }
          aftermath.push(
            pickText(`${m.id}:h2h2`, [
              `${nowWinner} 对 ${opp} 已连续 ${cnum(run)} 场交锋取胜。`,
              `近 ${cnum(run)} 次碰面，赢的都是 ${nowWinner}。`,
            ]),
          );
        }
      } else if (nowWinner && prevWinner && prevWinner !== nowWinner) {
        aftermath.push(
          pickText(`${m.id}:h2h3`, [
            `本赛季首回合 ${prevWinner} 曾 ${prev.scoreHome}:${prev.scoreAway} 取胜，本场 ${nowWinner} 完成复仇。`,
            `首回合 ${prevWinner} 曾以 ${prev.scoreHome}:${prev.scoreAway} 取胜，这次 ${nowWinner} 复仇成功。`,
          ]),
        );
      } else if (nowWinner && !prevWinner) {
        context.push(
          pickText(`${m.id}:h2h4`, [
            `双方本赛季首回合 ${prev.scoreHome}:${prev.scoreAway} 战平。`,
            `两队首回合就战成 ${prev.scoreHome}:${prev.scoreAway}。`,
          ]),
        );
      } else if (!nowWinner && prevWinner) {
        aftermath.push(
          pickText(`${m.id}:h2h5`, [
            `本赛季首回合 ${prevWinner} 曾 ${prev.scoreHome}:${prev.scoreAway} 取胜，本场双方握手言和。`,
            `首回合 ${prevWinner} 曾以 ${prev.scoreHome}:${prev.scoreAway} 取胜，这次谁也没能再赢。`,
          ]),
        );
      }
    }

    // 5) 射手榜影响（只提本场进球球员，最多 2 句）
    //    并列次序与榜单一致：同球数点球少的排前，故本场进球要带上是否点球
    const matchGoals = goalFacts
      .filter((g) => g.type !== "own_goal")
      .map((g) => ({
        playerId: Number(g.playerKey.startsWith("p:") ? g.playerKey.slice(2) : 0),
        pen: g.type === "pen_goal",
      }))
      .filter((g) => g.playerId > 0);
    if (matchGoals.length > 0) {
      const beforeScorers = scorersBefore(scorerTotals, matchGoals);
      const lines: string[] = [];
      const seen = new Set<number>();
      for (const pid of matchGoals) {
        if (seen.has(pid.playerId)) continue;
        seen.add(pid.playerId);
        const after = scorerTotals.find((t) => t.playerId === pid.playerId);
        if (!after) continue;
        const rankAfter = rankOf(scorerTotals, pid.playerId);
        const rankBefore = rankOf(beforeScorers, pid.playerId);
        if (rankAfter === 1 && rankBefore !== 1 && after.goals >= 2) {
          lines.push(
            pickText(`${m.id}:top1`, [
              `${after.name} 以 ${after.goals} 球登顶射手榜。`,
              `射手榜随之改写：${after.name} 凭 ${after.goals} 球升至头名。`,
            ]),
          );
        } else if (rankAfter === 1 && rankBefore === 1 && after.goals >= 2) {
          const second = scorerTotals[1];
          const gap = second ? after.goals - second.goals : 0;
          lines.push(
            gap > 0
              ? pickText(`${m.id}:top2`, [
                  `${after.name} 以 ${after.goals} 球继续领跑射手榜（领先第 2 名 ${gap} 球）。`,
                  `射手榜上 ${after.name} 依旧第一，${after.goals} 球，比第二名多 ${gap} 球。`,
                ])
              : pickText(`${m.id}:top3`, [
                  `${after.name} 以 ${after.goals} 球继续领跑射手榜。`,
                  `${after.name} 仍以 ${after.goals} 球占据射手榜头名。`,
                ]),
          );
        } else if (rankAfter >= 2 && rankAfter <= 3) {
          const leader = scorerTotals[0];
          const gap = leader ? leader.goals - after.goals : 0;
          if (gap > 0 && gap <= 2 && rankAfter < rankBefore) {
            lines.push(
              pickText(`${m.id}:top4`, [
                `${after.name} 以 ${after.goals} 球追至射手榜第 ${rankAfter} 位，仅差 ${gap} 球。`,
                `${after.name} 的本届进球来到 ${after.goals}，距射手榜第 ${rankAfter} 位只差 ${gap} 球。`,
              ]),
            );
          }
        }
        if (lines.length >= 2) break;
      }
      aftermath.push(...lines);
    }

    // 影响收尾段：本场之后才成立的事织进正文（倒金字塔结尾层），最多 3 句
    if (aftermath.length > 0) paragraphs.push(aftermath.slice(0, 3).join(""));

    // 6) 球队近况（收尾新段）：整体近 5 场或分主/客，口径轮换（积分/胜场/不败/丢球/净胜/连败），样本 <3 场不写；弃权场不计入
    // 窗口用 afterList（截至本场、含本场）：本场战绩要算进「近 5 场」
    const formOf = (entryId: number, venue: "all" | "home" | "away") => {
      const recent = afterList
        .filter(
          (x) =>
            x.walkoverSide === "" &&
            (x.homeEntryId === entryId || x.awayEntryId === entryId) &&
            (venue === "all" || (venue === "home" ? x.homeEntryId === entryId : x.awayEntryId === entryId)),
        )
        .slice(-5);
      if (recent.length < 3) return null;
      let w = 0;
      let d = 0;
      let l = 0;
      let gf = 0;
      let ga = 0;
      for (const x of recent) {
        const isHome = x.homeEntryId === entryId;
        const f = isHome ? x.scoreHome : x.scoreAway;
        const a = isHome ? x.scoreAway : x.scoreHome;
        gf += f;
        ga += a;
        if (f > a) w += 1;
        else if (f === a) d += 1;
        else l += 1;
      }
      return { n: recent.length, w, d, l, pts: w * 3 + d, ga, gd: gf - ga };
    };
    const formLine = (
      teamName: string,
      f: { n: number; w: number; d: number; l: number; pts: number; ga: number; gd: number },
      venue: "all" | "home" | "away",
      seed: string,
    ): string | null => {
      const vn = venue === "all" ? `近 ${f.n} 场` : venue === "home" ? `近 ${f.n} 个主场` : `近 ${f.n} 个客场`;
      const cand: string[] = [];
      if (f.pts >= 10) cand.push(`${teamName} ${vn}拿下 ${f.pts} 分。`);
      if (f.w >= 3) cand.push(`${teamName} ${vn}赢下 ${f.w} 场。`);
      if (f.l === 0) cand.push(`${teamName} ${vn}${f.w}胜${f.d}平保持不败。`);
      if (f.ga <= 2) cand.push(`${teamName} ${vn}只丢 ${f.ga} 球。`);
      if (f.gd >= 4) cand.push(`${teamName} ${vn}净胜 ${f.gd} 球。`);
      if (f.l >= 3) cand.push(`${teamName} ${vn}输掉 ${f.l} 场，需要调整状态。`);
      if (cand.length === 0) return null;
      return pickText(seed, cand);
    };
    const formCand: string[] = [];
    for (const [entryId, teamName, isHome, seed] of [
      [m.homeEntryId, m.homeTeamName, true, `${m.id}:fh`],
      [m.awayEntryId, m.awayTeamName, false, `${m.id}:fa`],
    ] as const) {
      const all = formOf(entryId, "all");
      const allLine = all ? formLine(teamName, all, "all", `${seed}:a`) : null;
      const ven = formOf(entryId, isHome ? "home" : "away");
      const venLine = ven ? formLine(teamName, ven, isHome ? "home" : "away", `${seed}:v`) : null;
      const opts = allLine && venLine ? [allLine, venLine] : allLine ? [allLine] : venLine ? [venLine] : [];
      if (opts.length > 0) formCand.push(pickText(`${seed}:pick`, opts));
    }
    if (formCand.length > 0 && chance(`${m.id}:fg`, RATES.formReport)) {
      paragraphs.push(formCand.join(""));
    }
  }

  // 数据框
  const goals: ReportGoalDTO[] = goalFacts.map((g) => ({
    minute: g.minute,
    playerName: g.playerName,
    playerId: g.playerKey.startsWith("p:") ? Number(g.playerKey.slice(2)) : null,
    teamName: g.teamName,
    side: g.side,
    type: g.type,
    assistPlayerName: g.assistName,
    assistPlayerId: g.assistId,
  }));

  return {
    matchId: m.id,
    tournamentId: m.tournamentId,
    tournamentName: m.tournamentName,
    roundLabel: rl,
    finishedAt: m.finishedAt,
    homeTeamName: m.homeTeamName,
    awayTeamName: m.awayTeamName,
    homeLogoUrl: m.homeLogoUrl,
    awayLogoUrl: m.awayLogoUrl,
    scoreHome: m.scoreHome,
    scoreAway: m.scoreAway,
    penHome: m.penHome,
    penAway: m.penAway,
    walkoverSide: "",
    title,
    lede,
    paragraphs,
    context: context.slice(0, 4),
    goals,
    cards,
    note: null,
  };
}
