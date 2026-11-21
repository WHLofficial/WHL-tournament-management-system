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
  rankRowsSimple,
  roundLabel,
  scorersBefore,
  standingsBefore,
  standingsSnapshot,
  subtractMatchContribution,
  type FinishedMatch,
  type RawEvent,
} from "./context";
import {
  BREATH,
  MILESTONE_GOALS_TITLE,
  OG_VERBS,
  RATES,
  SEAL_REPLACE,
  SEAL_WORDS,
  heroPhrase,
  pickReportDrama,
  pickResultHook,
  pickResultTitle,
  type OgVerbState,
} from "./copybanks";
import { LATE_WINNER_MIN, computeMatchFacts, type MatchFacts } from "./narrativeFacts";
import { pickCombo, pickMethodLine } from "./methodCopy";
import { ASSIST_METHODS, GOAL_METHODS, type AssistMethod, type GoalMethod } from "../../shared/methods";

// C2 篇内片段去重（audit §4.2 之⑥战报侧）：标题/导语用过的短语进 Set，aftermath 选句避开同短语
const WATCH_PHRASES = ["握手言和", "带走胜利", "拿下三分", "各取一分", "挺进下一轮"] as const;

interface GoalFact {
  minute: number | null;
  playerName: string | null;
  teamName: string;
  side: "home" | "away";
  type: "goal" | "pen_goal" | "own_goal";
  assistId: number | null; // 助攻者（own_goal 恒为 null）
  assistName: string | null;
  sentenceIdx: number; // 对应过程句下标（run 合并后同句多球共享下标）
  playerKey: string;
  diffAfter: number; // 该球后得分方净胜（seal 门槛：此刻领先 ≤2 直通）
  prevLeader: "home" | "away" | null; // 该球前的领先方（null=平），破平/反超判定（audit §4.1 之③）
  runIdx: number; // 所属合并段序号
  fragIdx: number; // 段内片段序号（seal 回填只改末球所在片段）
  methodOk: boolean; // 片段是否走 methodCopy 方式句（功臣后缀按此决定融合或逗号分隔，2026-11-21 #3）
}

// 过程句生成：按时间顺序走一遍事件流，用比分状态机选动词。
// C2（audit §4.5）：同队连进合并为一句（片段逗号衔接、分钟并列），对队得分新句以「但」转折起头，
// 哑火窗编码「直到…才」；进球方式（迁移 0038）非空的 goal 换 methodCopy 单句/组合句，
// key-node 头衔照 copybank §4.4 叠加在句尾。事件一个不丢：goalFacts/goals 数据框与句子事实一致。
function buildNarrative(
  m: FinishedMatch,
  events: RawEvent[],
  facts: MatchFacts | null,
): { sentences: string[]; goalFacts: GoalFact[]; cards: ReportCardDTO[] } {
  const sentences: string[] = [];
  const goalFacts: GoalFact[] = [];
  const cards: ReportCardDTO[] = [];
  const runs: { side: "home" | "away"; frags: string[] }[] = []; // 已成句的合并段（seal 按片段回填后重拼）
  let home = 0;
  let away = 0;
  const minutePre = (minute: number | null) => (minute === null ? "比赛中，" : `第 ${minute} 分钟，`);
  let firstGoalDone = false;
  let prevGoalMinute: number | null = null; // 上一粒进球分钟（哑火窗判定）
  let lastRunSide: "home" | "away" | null = null; // 上一段合并句的得分方（转折衔接判定）
  let curRun: {
    side: "home" | "away";
    frags: string[];
    pending: Array<Omit<GoalFact, "sentenceIdx" | "runIdx" | "fragIdx">>;
  } | null = null;
  // 助攻从句整场去重：同一份战报里助攻说法不重复
  const usedAssist = new Set<string>();
  // 呼吸句：纯叙述、不带占位符的短句，只在对应事件真实发生时插入；战报预算 ≤2，逐槽 chance 门控（条件满足不一定触发）；同类事件（多次红牌/多次罚失点球）整场只呼吸一次，防同池句复现
  let breathBudget = 2;
  const breathFired = new Set<string>();
  // 门控判定与 tryBreath 共用同一 chance 键，供调用方「会命中才冲刷 run」的顺序安排
  const breathWillFire = (slot: string, seed: string): boolean =>
    breathBudget > 0 && !breathFired.has(slot) && chance(`${seed}:go`, RATES.breathReport);
  const tryBreath = (slot: string, seed: string, pool: readonly string[]): void => {
    if (!breathWillFire(slot, seed)) return;
    sentences.push(pickText(seed, pool));
    breathFired.add(slot);
    breathBudget -= 1;
  };
  // 冲刷当前 run：同队连进的片段拼成一句，goalFacts 共享该句下标（hero/seal 用 runIdx/fragIdx 定位片段）
  const flushRun = (): void => {
    if (!curRun || curRun.frags.length === 0) return;
    sentences.push(`${curRun.frags.join("，")}。`);
    const runIdx = runs.length;
    const sentenceIdx = sentences.length - 1;
    runs.push({ side: curRun.side, frags: curRun.frags });
    curRun.pending.forEach((f, fragIdx) => goalFacts.push({ ...f, sentenceIdx, runIdx, fragIdx }));
    lastRunSide = curRun.side;
    curRun = null;
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
      const prevLeader: "home" | "away" | null = home > away ? "home" : away > home ? "away" : null;
      // 记分（2026-11-21 #1 修复）：scoring 已是受益方（乌龙取摆乌龙者的对面），受益方 +1。
      // 原实现把乌龙记给非受益方：227 的 87' 乌龙后内部记分错成 2:2，97' 被误判成「再度领先」
      if (scoring === "home") home += 1;
      else away += 1;

      // 乌龙无球员名时主语退化为摆乌龙方球队口径——用受益方队名会读成「受益方自摆乌龙」，方向反了
      const who =
        e.playerName ??
        (e.type === "own_goal" ? (side === "home" ? m.homeTeamName : m.awayTeamName) : scoringTeam);
      // 进球动词句库：同一事实多种说法，按「比赛+事件」种子确定性选一条（重复请求不变，不同场散开）
      const evSeed = `${m.id}:${e.minute ?? "x"}:${e.playerId ?? e.playerName ?? "?"}:${e.type}`;
      const isFirst = !firstGoalDone;
      firstGoalDone = true;
      // 哑火窗「直到…才」（audit §4.5）：只认事实层窗口——首球 ≥60'（lateFirstGoal），
      // 或恰为 facts.drought 缺口两端（from=上球分钟、to=本球分钟），不按本地分钟自行推断
      const inDrought =
        facts != null &&
        e.minute !== null &&
        ((facts.lateFirstGoal && prevGoalMinute === null) ||
          (facts.drought != null &&
            prevGoalMinute === facts.drought.from &&
            e.minute === facts.drought.to));
      // C2 run 合并：同队连进合一句，单句最多并 3 个片段——更长的连进另起一句（避免不可读的长句），
      // 同侧另起句不转折（lastRunSide 未变）
      const appendToRun: boolean =
        curRun != null && curRun.side === scoring && curRun.frags.length < 3;
      const pre: string = inDrought
        ? `直到第 ${e.minute} 分钟，`
        : appendToRun
          ? e.minute === null
            ? "比赛中，"
            : `第 ${e.minute} 分钟，` // 段内片段自带分隔逗号（2026-11-21 #4）：「第 87 分钟Pierre Kalulu」式直粘已修
          : minutePre(e.minute);
      // 对队得分用转折衔接（audit §4.5）：上一段连进是对手时，新句以「但」起头。
      // 判定取当前未冲刷的 run（两段连进直接相接、中间无牌/罚失/呼吸句隔开时 lastRunSide 尚未更新）
      const prevSide: "home" | "away" | null = curRun?.side ?? lastRunSide;
      const turnLead: string = !appendToRun && prevSide !== null && prevSide !== scoring ? "但" : "";
      let core: string;
      const methodOk =
        e.type === "goal" &&
        e.method != null &&
        (GOAL_METHODS as readonly string[]).includes(e.method);
      if (methodOk) {
        // methodCopy 接入：方式词来自录入端 CHECK 白名单（shared/methods.ts）；
        // 助攻方式与助攻人都在时走组合专表/通用 fallback，仅方式走进球池单句（solo/free_kick 无助攻）。
        // key-node 头衔照 copybank §4.4 叠加在句尾；扩大/追回尾巴保留 SEAL 词，供「锁定胜局」回填
        // 2026-11-21 追加修复：wasBehind 只说明「进球前落后」，进完可能仍然落后（如 1:3 → 2:3）——
        // 反超必须以「进球后领先」为准，否则 227 的 97' 追回球会被写成「尤文图斯 反超了比分」
        const tail = isFirst
          ? `，${scoringTeam} 首开纪录`
          : wasBehind && home === away
            ? `，${scoringTeam} 扳平比分`
            : wasBehind && (scoring === "home" ? home > away : away > home)
              ? `，${scoringTeam} 反超了比分`
              : beforeLevel
                ? `，${scoringTeam} 再度领先`
                : wasAhead
                  ? `，${scoringTeam} 扩大战果`
                  : `，${scoringTeam} 扳回一城`;
        const comboSeed = `${m.id}:${e.minute ?? "x"}:${e.playerId ?? e.playerName ?? "?"}:mc`;
        const line =
          e.assistName != null &&
          e.assistMethod != null &&
          (ASSIST_METHODS as readonly string[]).includes(e.assistMethod)
            ? pickCombo(comboSeed, e.assistMethod as AssistMethod, e.method as GoalMethod, {
                A: e.assistName,
                P: who,
                T: scoringTeam,
              })
            : pickMethodLine(comboSeed, e.method as GoalMethod, { P: who, T: scoringTeam });
        core = `${line}${tail}`;
      } else {
        let verb: string;
        if (e.type === "own_goal") {
          // 乌龙球措辞（2026-11-21 #1）：任何比分状态下都必须有乌龙字样，句式明确受益方
          // （scoringTeam）得利、摆乌龙者非正常进球；池内避开 SEAL_WORDS，「锁定胜局」回填不改写乌龙句
          const ogState: OgVerbState = isFirst
            ? "first"
            : wasBehind && home === away
              ? "retie"
              : wasBehind && (scoring === "home" ? home > away : away > home)
                ? "overtake"
                : beforeLevel
                  ? "break"
                  : wasAhead
                    ? "extend"
                    : "chase";
          verb = pickText(evSeed, OG_VERBS[ogState](scoringTeam));
        } else if (isFirst) {
          verb = e.type === "pen_goal"
            ? pickText(evSeed, ["点球命中，率先打破僵局", "顶住压力罚进点球，首开纪录", "主罚点球稳稳命中，拔得头筹"])
            : pickText(evSeed, ["率先打破僵局", "首开纪录", "拔得头筹", "打进本场第一球"]);
        } else if (wasBehind && home !== away && (scoring === "home" ? home > away : away > home)) {
          verb = e.type === "pen_goal"
            ? pickText(evSeed, [`点球命中，帮助${scoringTeam}再度超出`, `点球罚进，${scoringTeam}反超了比分`])
            : pickText(evSeed, [`帮助${scoringTeam}再度超出`, `帮${scoringTeam}重新取得领先`, `让${scoringTeam}反超了比分`]);
        } else if (wasBehind && home === away) {
          verb = e.type === "pen_goal"
            ? pickText(evSeed, [`点球命中，为${scoringTeam}扳平比分`, `顶住压力罚进点球，扳平比分`, `点球稳稳罚进，双方回到同一起跑线`])
            : pickText(evSeed, [`为${scoringTeam}扳平比分`, `把比分追成平手`, `帮${scoringTeam}追平`]);
        } else if (beforeLevel) {
          // 平局僵持中超出（非首球）：重新领先
          verb = e.type === "pen_goal"
            ? pickText(evSeed, [`点球命中，${scoringTeam}再度领先`, `点球罚进，${scoringTeam}再次超出`])
            : pickText(evSeed, [`帮助${scoringTeam}再度领先`, `让${scoringTeam}再次超出`, `帮${scoringTeam}重新取得领先`]);
        } else if (wasAhead) {
          // 领先方扩大优势（是否锁定胜局在下方按局势门槛回填；动词须含下方回填替换词表中的词）
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
        core = `${assistLead}${who} ${inDrought ? "才" : ""}${verb}`;
      }
      const frag: string = `${turnLead}${pre}${core}`;
      const factBase: Omit<GoalFact, "sentenceIdx" | "runIdx" | "fragIdx"> = {
        minute: e.minute,
        playerName: e.playerName,
        teamName: scoringTeam,
        side: scoring,
        type: e.type as "goal" | "pen_goal" | "own_goal",
        assistId: e.type !== "own_goal" ? e.assistPlayerId : null,
        assistName: e.type !== "own_goal" ? e.assistName : null,
        playerKey: e.playerId === null ? `team:${scoringTeam}` : `p:${e.playerId}`,
        diffAfter: scoring === "home" ? home - away : away - home,
        prevLeader,
        methodOk,
      };
      if (appendToRun) {
        curRun!.frags.push(frag);
        curRun!.pending.push(factBase);
      } else {
        flushRun();
        curRun = { side: scoring, frags: [frag], pending: [factBase] };
      }
      prevGoalMinute = e.minute;
      if (isFirst && e.minute !== null && e.minute <= 10) {
        // 闪电呼吸句真会命中才冲刷当前 run（呼吸句要排在进球句之后）；未命中不打断同队连进合并
        if (breathWillFire("bref", `${m.id}:bref`)) {
          flushRun();
          tryBreath("bref", `${m.id}:bref`, BREATH.bolt);
        }
      }
      continue;
    }
    if (e.type === "pen_miss") {
      flushRun();
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
      flushRun();
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
      flushRun();
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

  flushRun(); // 收尾前把未冲刷的连进段落句

  // 收尾呼吸句：大胜场的静态总结（纯叙述、不带数据）
  if (home !== away && Math.abs(home - away) >= 3) {
    tryBreath("brout", `${m.id}:brout`, BREATH.rout);
  }

  // 「锁定胜局」回填（audit §4.1 之③：按局势不按位置）：最后一个进球是 eventual winner 打进
  // 且此后对方无进球（即它本身就是最后一粒）、比分非平，再加门槛——此刻领先 ≤2，
  // 或末球 ≥80' 且该球破平/反超（prevLeader 非胜方）；不满足则留在「再下一城/扩大战果」池。
  // 回填只改末球所在片段（合并句里更早的进球不受牵连），改完按片段重拼整句
  const lastGoal = goalFacts[goalFacts.length - 1];
  if (lastGoal && home !== away) {
    const winnerSide = home > away ? "home" : "away";
    const sealOk =
      lastGoal.diffAfter <= 2 ||
      (lastGoal.minute !== null &&
        lastGoal.minute >= LATE_WINNER_MIN &&
        lastGoal.prevLeader !== winnerSide);
    if (lastGoal.side === winnerSide && sealOk) {
      const run = runs[lastGoal.runIdx];
      run.frags[lastGoal.fragIdx] = SEAL_WORDS.reduce(
        (acc, w) => acc.replace(w, SEAL_REPLACE),
        run.frags[lastGoal.fragIdx],
      );
      sentences[lastGoal.sentenceIdx] = `${run.frags.join("，")}。`;
    }
  }

  // 功臣后缀：同一球员 ≥2 球，缀在其最后一次进球句的射手名后、动词前（「梅开二度锁定胜局」的战报语序）；
  // 合并句里同名多次出现时取最后一次（他最近一球的语义位置）
  const byPlayer = new Map<string, { count: number; lastIdx: number; name: string; methodOk: boolean }>();
  for (const g of goalFacts) {
    if (g.type === "own_goal") continue; // 乌龙不算射手功臣
    const cur = byPlayer.get(g.playerKey);
    if (cur) {
      cur.count += 1;
      cur.lastIdx = g.sentenceIdx;
      cur.methodOk = g.methodOk;
    } else {
      byPlayer.set(g.playerKey, {
        count: 1,
        lastIdx: g.sentenceIdx,
        name: g.playerName ?? g.teamName,
        methodOk: g.methodOk,
      });
    }
  }
  for (const info of byPlayer.values()) {
    if (info.count < 2) continue;
    const suffix = heroPhrase(info.count);
    const s = sentences[info.lastIdx];
    const who = info.name;
    const cut = s.lastIndexOf(`${who} `);
    const head = cut > 0 ? cut + who.length + 1 : -1;
    // 后缀衔接（2026-11-21 #3）：方式句（methodCopy）里后缀直粘动词是病句「梅开二度半转身发力」，
    // 补分隔逗号；普通动词保持「梅开二度再入一球」融合语序
    sentences[info.lastIdx] =
      head > 0
        ? `${s.slice(0, head)}${suffix}${info.methodOk ? "，" : ""}${s.slice(head)}`
        : s.replace(/。$/, `，${suffix}。`);
  }

  return { sentences, goalFacts, cards };
}

// C2 节奏检查（audit §4.5）：过程段每段至少一个短句（≤15 字）；没有时把段内首个够长、
// 带 ≥2 逗号的句子在最后一个逗号处拆成两句（头尾各自带谓语），长短错落靠拆句补足，确定性无骰点。
// 2026-11-21 #4 联动：run 合并片段自带「第 N 分钟，」前缀后，句末逗号可能紧跟在光杆时间短语
// 之后——在那里断句会把「第 35 分钟。」孤悬成半句；拆点跳过此类逗号（前段恰为光杆时间短语）
function ensureShortSentence(para: string): string {
  const parts = para.split(/(?<=。)/).filter((x) => x.length > 0);
  if (parts.length < 2) return para;
  if (parts.some((s) => [...s.replace(/。$/, "")].length <= 15)) return para;
  const BARE_TIME = /^(?:第 \S+ 分钟|比赛中|直到第 \S+ 分钟)$/;
  for (let i = 0; i < parts.length; i++) {
    const body = parts[i].replace(/。$/, "");
    if ([...body].length < 20) continue;
    const commas = [...body]
      .map((ch, idx) => (ch === "，" ? idx : -1))
      .filter((idx) => idx >= 0);
    if (commas.length < 2) continue;
    // 从最后往前找拆点，跳过「前段是光杆时间短语」的逗号（避免拆出「第 35 分钟。」半句）
    let cut = -1;
    for (let k = commas.length - 1; k >= 0; k--) {
      const seg = body.slice((k > 0 ? commas[k - 1] : -1) + 1, commas[k]);
      if (!BARE_TIME.test(seg)) {
        cut = commas[k];
        break;
      }
    }
    if (cut < 0) continue;
    const tail = body.slice(cut + 1);
    if ([...tail].length < 6) continue;
    // 拆点去掉逗号再接句号——保留逗号会产出「拔得头筹，。」双标点病句
    parts.splice(i, 1, `${body.slice(0, cut)}。`, `${tail}。`);
    return parts.join("");
  }
  return para;
}

// 标题与导语的结果短语
function resultPhrases(m: FinishedMatch, events: RawEvent[], facts: MatchFacts) {
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
  // 功臣（≥2 球）：既作六档标题的「焦点是 {X}」输入，也负责标题尾部的功臣后缀
  const counts = new Map<string, number>();
  for (const e of events) {
    if ((e.type === "goal" || e.type === "pen_goal") && e.playerName)
      counts.set(e.playerName, (counts.get(e.playerName) ?? 0) + 1);
  }
  let hero: { name: string; goals: number } | null = null;
  for (const [name, n] of counts) if (!hero || n > hero.goals) hero = { name, goals: n };

  // 标题：六档池（copybank §5，C3）——旧四档 pickText 池整体替换（含被 §5 点名的「客场得手」拼接变体）；
  // pen 档沿用现有点球淘汰文案；战报页单篇调用不传 seenTails（不承诺跨场去重，跨屏去重在 feed 循环）
  let title = pickResultTitle(`tt:${m.id}`, facts, {
    home: m.homeTeamName,
    away: m.awayTeamName,
    scoreHome: h,
    scoreAway: a,
    heroName: hero && hero.goals >= 2 ? hero.name : null,
  });

  // 功臣后缀（≥2 球）兼容照旧：缀在六档标题之后
  if (hero && hero.goals >= 2) {
    title += `，${hero.name} ${heroPhrase(hero.goals)}`;
  }

  let outcome: string;
  if (shootout && penWinner) outcome = `${penWinner} 点球 ${m.penHome}:${m.penAway} 淘汰对手`;
  else if (winner) outcome = m.stageKind === "elim" ? `${winner} 挺进下一轮` : `${winner} 拿下三分`;
  else outcome = "双方各取一分";

  return { title, outcome, hero };
}

// ---------- 近况 2.0 状态画像文案池（audit §7.5 参照扩写；每池 ≥6，事实等价、直说、池内无 chance） ----------
// 数字排版统一「三场」式不留空格（cnum）。占位按池各自标注：p=球员、team=球队、venue=主场/客场、
// n=场数/轮数、k=连场数、y=窗口进球数、c=票数、mv=名次变动、r0/r1=变动前后名次。
const FORM_POOLS = {
  // P1 复出（未进球）
  comeback: [
    (v: { p: string; n: number }) => `缺席${cnum(v.n)}场之后，${v.p} 把状态找了回来。`,
    (v: { p: string; n: number }) => `${v.p} 回来的第一场，名字就写回了计分表。`,
    (v: { p: string; n: number }) => `伤停名单出去了，${v.p} 用这场做了自我介绍。`,
    (v: { p: string; n: number }) => `${v.p} 缺席${cnum(v.n)}场后复出，节奏没有掉。`,
    (v: { p: string; n: number }) => `缺席${cnum(v.n)}场，${v.p} 复出这一场把状态接上了。`,
    (v: { p: string; n: number }) => `伤停结束，${v.p} 复出首战就站稳了。`,
  ] as ReadonlyArray<(v: { p: string; n: number }) => string>,
  // P1 升级：复出即破门
  comebackScored: [
    (v: { p: string; n: number }) => `缺席${cnum(v.n)}场之后复出，${v.p} 复出即破门。`,
    (v: { p: string; n: number }) => `复出手感没凉：${v.p} 这一场直接进球。`,
    (v: { p: string; n: number }) => `伤停${cnum(v.n)}场，${v.p} 复出首球来得毫无生涩。`,
    (v: { p: string; n: number }) => `缺席${cnum(v.n)}场不耽误事，${v.p} 复出即进球。`,
    (v: { p: string; n: number }) => `伤愈复出的 ${v.p} 把进球也带了回来。`,
    (v: { p: string; n: number }) => `复出即破门，${v.p} 的缺席没有留下痕迹。`,
  ] as ReadonlyArray<(v: { p: string; n: number }) => string>,
  // P2 连场破门（K 2-3）
  streakHot: [
    (v: { p: string; k: number }) => `连着${cnum(v.k)}场破门，${v.p} 的手感不需要热。`,
    (v: { p: string; k: number }) => `${cnum(v.k)}连进球，每份球探报告的第一页都是 ${v.p}。`,
    (v: { p: string; k: number }) => `${v.p} 连续${cnum(v.k)}场收获进球，脚风正顺。`,
    (v: { p: string; k: number }) => `连续${cnum(v.k)}场进球，${v.p} 的状态正在峰值。`,
    (v: { p: string; k: number }) => `${v.p} 把进球变成了习惯，已经连着${cnum(v.k)}场。`,
    (v: { p: string; k: number }) => `场场都有 ${v.p} 的进球，这条连续破门纪录来到${cnum(v.k)}场。`,
  ] as ReadonlyArray<(v: { p: string; k: number }) => string>,
  // P2 连场破门（K≥4 夸张档）
  streakBlaze: [
    (v: { p: string; k: number }) => `${cnum(v.k)}连进球，${v.p} 一脚一脚把纪录往长了写。`,
    (v: { p: string; k: number }) => `连续${cnum(v.k)}场破门，这条线再延伸下去就是赛会话题。`,
    (v: { p: string; k: number }) => `${v.p} 连续${cnum(v.k)}场破门，名字固定在进球名单上。`,
    (v: { p: string; k: number }) => `场场有进球，连续${cnum(v.k)}场，${v.p} 的输出肉眼可见。`,
    (v: { p: string; k: number }) => `进球这件事，${v.p} 已经连着${cnum(v.k)}场没落下。`,
    (v: { p: string; k: number }) => `连续${cnum(v.k)}场破门，${v.p} 把火热的手感烧成了常态。`,
  ] as ReadonlyArray<(v: { p: string; k: number }) => string>,
  // P3 近窗产能（近 N 场 Y 球）
  production: [
    (v: { p: string; n: number; y: number }) => `近${cnum(v.n)}场出场打进${cnum(v.y)}球，${v.p} 的产出稳定。`,
    (v: { p: string; n: number; y: number }) => `${v.p} 最近${cnum(v.n)}场收获${cnum(v.y)}球，输出不减。`,
    (v: { p: string; n: number; y: number }) => `近${cnum(v.n)}次出场${cnum(v.y)}球入账，${v.p} 的进球效率在线。`,
    (v: { p: string; n: number; y: number }) => `${cnum(v.y)}球来自最近${cnum(v.n)}场，${v.p} 的产能看得见。`,
    (v: { p: string; n: number; y: number }) => `${v.p} 近${cnum(v.n)}场交出${cnum(v.y)}球，产量说话。`,
    (v: { p: string; n: number; y: number }) => `最近${cnum(v.n)}场${cnum(v.y)}球，${v.p} 的进球节奏没有断档。`,
  ] as ReadonlyArray<(v: { p: string; n: number; y: number }) => string>,
  // P7 票选热度（上一场全场最佳票王）
  motm: [
    (v: { p: string; c: number }) => `上一场球迷选出的全场最佳 ${v.p}，这一场还在名单上。`,
    (v: { p: string; c: number }) => `${v.p} 上一场被球迷选为全场最佳，热度延续到了这一场。`,
    (v: { p: string; c: number }) => `上一场全场最佳投票里 ${v.p} 拿到${cnum(v.c)}票，这一场他继续出场。`,
    (v: { p: string; c: number }) => `${cnum(v.c)}票全场最佳——${v.p} 的人气延续到了这一场。`,
    (v: { p: string; c: number }) => `${v.p} 带着上一场全场最佳的票选热度来到这一场。`,
    (v: { p: string; c: number }) => `上一场以${cnum(v.c)}票当选全场最佳，${v.p} 的状态获得了球迷背书。`,
  ] as ReadonlyArray<(v: { p: string; c: number }) => string>,
  // T2 主/客场地连胜
  venueStreak: [
    (v: { team: string; venue: string; n: number }) => `${v.team} 在${v.venue}已经拿下${cnum(v.n)}连胜。`,
    (v: { team: string; venue: string; n: number }) => `${v.venue}${cnum(v.n)}连胜，${v.team} 在这里的状态靠得住。`,
    (v: { team: string; venue: string; n: number }) => `连续${cnum(v.n)}个${v.venue}全取三分，${v.team} 在这块场地上有办法。`,
    (v: { team: string; venue: string; n: number }) => `${v.team} 的${v.venue}连胜延续到${cnum(v.n)}场。`,
    (v: { team: string; venue: string; n: number }) => `${cnum(v.n)}个${v.venue}全胜，${v.team} 的场地优势正在做实。`,
    (v: { team: string; venue: string; n: number }) => `${v.venue}近${cnum(v.n)}场全胜，${v.team} 把这里当成了加分项。`,
  ] as ReadonlyArray<(v: { team: string; venue: string; n: number }) => string>,
  // T3 排名走势（升）
  rankUp: [
    (v: { team: string; n: number; mv: number; r0: number; r1: number }) => `近${cnum(v.n)}轮升了${cnum(v.mv)}位，${v.team} 的曲线朝上。`,
    (v: { team: string; n: number; mv: number; r0: number; r1: number }) => `积分榜上 ${v.team} 近${cnum(v.n)}轮爬升${cnum(v.mv)}位。`,
    (v: { team: string; n: number; mv: number; r0: number; r1: number }) => `${cnum(v.n)}轮里排名前进${cnum(v.mv)}位，${v.team} 的走势向上。`,
    (v: { team: string; n: number; mv: number; r0: number; r1: number }) => `${v.team} 近${cnum(v.n)}轮从第${v.r0}位升到第${v.r1}位。`,
    (v: { team: string; n: number; mv: number; r0: number; r1: number }) => `排名连升${cnum(v.mv)}位，${v.team} 近${cnum(v.n)}轮的状态兑现成了名次。`,
    (v: { team: string; n: number; mv: number; r0: number; r1: number }) => `${v.team} 近${cnum(v.n)}轮名次上升${cnum(v.mv)}位，账面在兑现。`,
  ] as ReadonlyArray<(v: { team: string; n: number; mv: number; r0: number; r1: number }) => string>,
  // T3 排名走势（降，仅败方）
  rankDown: [
    (v: { team: string; n: number; mv: number; r0: number; r1: number }) => `近${cnum(v.n)}轮跌了${cnum(v.mv)}位，${v.team} 需要止住下滑。`,
    (v: { team: string; n: number; mv: number; r0: number; r1: number }) => `积分榜上 ${v.team} 近${cnum(v.n)}轮下滑${cnum(v.mv)}位。`,
    (v: { team: string; n: number; mv: number; r0: number; r1: number }) => `${cnum(v.n)}轮里排名后退${cnum(v.mv)}位，${v.team} 的曲线朝下。`,
    (v: { team: string; n: number; mv: number; r0: number; r1: number }) => `${v.team} 近${cnum(v.n)}轮从第${v.r0}位跌到第${v.r1}位。`,
    (v: { team: string; n: number; mv: number; r0: number; r1: number }) => `排名连降${cnum(v.mv)}位，${v.team} 近${cnum(v.n)}轮的账面在滑坡。`,
    (v: { team: string; n: number; mv: number; r0: number; r1: number }) => `${v.team} 的名次近${cnum(v.n)}轮下滑${cnum(v.mv)}位，走势需要修正。`,
  ] as ReadonlyArray<(v: { team: string; n: number; mv: number; r0: number; r1: number }) => string>,
};

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
  // 事实层：剧情句（2.5 节）、过程句的哑火窗与近况段共用的本场画像
  const facts = computeMatchFacts(m, events);
  const { sentences, goalFacts, cards } = buildNarrative(m, events, facts);
  let { title, outcome, hero } = resultPhrases(m, events, facts!); // 非弃权场 facts 恒非空
  const dateStr = cnDate(m.finishedAt);
  // 导语按「点球 / 大胜(净胜≥3) / 常规胜负 / 平局」分档，档内 6 个结构变体按比赛种子确定性选一
  const shootout = m.penHome !== null && m.penAway !== null;
  const regWinner = m.scoreHome > m.scoreAway ? m.homeTeamName : m.scoreAway > m.scoreHome ? m.awayTeamName : null;
  const loserName = regWinner ? (regWinner === m.homeTeamName ? m.awayTeamName : m.homeTeamName) : null;
  const margin = Math.abs(m.scoreHome - m.scoreAway);
  const sw = m.scoreHome >= m.scoreAway ? `${m.scoreHome}:${m.scoreAway}` : `${m.scoreAway}:${m.scoreHome}`;
  // 败方视角比分（audit §4.1 之①）：败方主语的导语变体必须填败方口径，不再写反
  const sl = regWinner === m.homeTeamName ? `${m.scoreAway}:${m.scoreHome}` : `${m.scoreHome}:${m.scoreAway}`;
  const heroTail = hero && hero.goals >= 2 ? `，${hero.name} 凭 ${hero.goals} 粒进球当选本场焦点` : "";
  // C2 篇内片段去重（audit §4.2 之⑥战报侧）：标题/导语用过的短语进 Set，后续导语变体与 aftermath 选句避开
  const usedPhrases = new Set<string>();
  const harvestPhrases = (s: string): void => {
    for (const p of WATCH_PHRASES) if (s.includes(p)) usedPhrases.add(p);
  };
  const pickFresh = (seed: string, pool: readonly string[]): string => {
    const fresh = pool.filter((v) => ![...usedPhrases].some((p) => v.includes(p)));
    return pickText(seed, fresh.length > 0 ? fresh : pool);
  };
  harvestPhrases(title);
  const ledeSeed = `lede:${m.id}`;
  let lede: string;
  if (shootout) {
    lede = pickFresh(ledeSeed, [
      `${rl}（${dateStr}），${m.homeTeamName} 与 ${m.awayTeamName} ${m.scoreHome}:${m.scoreAway} 战罢难分高下，${outcome}${heroTail}。`,
      `${rl}（${dateStr}）被拖入点球大战，常规时间 ${m.homeTeamName} 与 ${m.awayTeamName} 战成 ${m.scoreHome}:${m.scoreAway}，${outcome}${heroTail}。`,
      `十二码决出胜负：${rl}（${dateStr}），${m.homeTeamName} 与 ${m.awayTeamName} ${m.scoreHome}:${m.scoreAway} 之后仍未分高下，${outcome}${heroTail}。`,
      `${rl}（${dateStr}），${m.scoreHome}:${m.scoreAway} 之后双方走上点球点，${outcome}${heroTail}。`,
    ]);
  } else if (regWinner && margin >= 3) {
    lede = pickFresh(ledeSeed, [
      `${rl}（${dateStr}），${regWinner} ${sw} 大胜 ${loserName}，${outcome}${heroTail}。`,
      `${rl}（${dateStr}）呈现一边倒，${regWinner} 以 ${sw} 击溃 ${loserName}，${outcome}${heroTail}。`,
      `${dateStr}的${rl}，${regWinner} 打出 ${sw}，轻取 ${loserName}，${outcome}${heroTail}。`,
      `比分定格在 ${sw}：${rl}（${dateStr}），${regWinner} 完胜 ${loserName}，${outcome}${heroTail}。`,
      `${rl}（${dateStr}），${regWinner} 收获一场 ${sw} 的大胜，${outcome}${heroTail}。`,
      `${rl}（${dateStr}），${loserName} 挡不住 ${regWinner} 的攻势，以 ${sl} 败下阵来，${outcome}${heroTail}。`,
    ]);
  } else if (regWinner) {
    lede = pickFresh(ledeSeed, [
      `${rl}（${dateStr}），${m.homeTeamName} 与 ${m.awayTeamName} ${m.scoreHome}:${m.scoreAway} 战罢，${outcome}${heroTail}。`,
      `${rl}（${dateStr}），${regWinner} 凭 ${sw} 击败 ${loserName}，${outcome}${heroTail}。`,
      `${dateStr}，${rl}：${m.homeTeamName} ${m.scoreHome}:${m.scoreAway} ${m.awayTeamName}，${outcome}${heroTail}。`,
      `${rl}（${dateStr}）战罢，记分牌停在 ${m.scoreHome}:${m.scoreAway}，胜者是 ${regWinner}，${outcome}${heroTail}。`,
      `终场哨响，${rl}（${dateStr}）的比分是 ${m.scoreHome}:${m.scoreAway}，${outcome}${heroTail}。`,
      `${rl}（${dateStr}），比分 ${m.scoreHome}:${m.scoreAway}，${regWinner} 带走胜利，${outcome}${heroTail}。`,
    ]);
  } else {
    lede = pickFresh(ledeSeed, [
      `${rl}（${dateStr}），${m.homeTeamName} 与 ${m.awayTeamName} ${m.scoreHome}:${m.scoreAway} 战罢，${outcome}${heroTail}。`,
      `${rl}（${dateStr}），${m.homeTeamName} 与 ${m.awayTeamName} ${m.scoreHome}:${m.scoreAway} 握手言和，${outcome}${heroTail}。`,
      `谁也没能带走胜利：${rl}（${dateStr}），${m.homeTeamName} 与 ${m.awayTeamName} 战成 ${m.scoreHome}:${m.scoreAway}，${outcome}${heroTail}。`,
      `${dateStr}，${rl}：${m.homeTeamName} ${m.scoreHome}:${m.scoreAway} ${m.awayTeamName}，${outcome}${heroTail}。`,
      `${rl}（${dateStr}）的比分最终停在 ${m.scoreHome}:${m.scoreAway}，${outcome}${heroTail}。`,
      `${rl}（${dateStr}）打成平手，${m.homeTeamName} 与 ${m.awayTeamName} ${m.scoreHome}:${m.scoreAway}，${outcome}${heroTail}。`,
    ]);
  }
  harvestPhrases(lede);

  // 过程分节：句多时拆两段，保持「可扫描结构」；每段做节奏检查（至少一个短句）
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
    paragraphs.push(ensureShortSentence(sentences.join("")));
  } else {
    const half = Math.ceil(sentences.length / 2);
    paragraphs.push(ensureShortSentence(sentences.slice(0, half).join("")));
    paragraphs.push(ensureShortSentence(sentences.slice(half).join("")));
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
                  `赛前 ${best.teamName} ${best.pts} 分，排在积分榜第 ${best.rank} 位。`,
                  `进入本场时，${best.teamName} 手握 ${best.pts} 分，排积分榜第 ${best.rank} 位。`,
                  `积分榜上，${best.teamName} 赛前排第 ${best.rank}，${best.pts} 分。`,
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
            pickFresh(`${m.id}:ctxC`, [
              `${winnerAfter.teamName} 反超 ${oldLeader.teamName} 登顶积分榜，现在 ${winnerAfter.pts} 分领跑。`,
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
              ? pickFresh(`${m.id}:ctxD`, [
                  `${winnerAfter.teamName} 将领先优势扩大到 ${gap} 分。`,
                  `${winnerAfter.teamName} 的领跑优势扩大到 ${gap} 分。`,
                ])
              : pickFresh(`${m.id}:ctxE`, [
                  `${winnerAfter.teamName} 继续领跑积分榜。`,
                  `积分榜上，${winnerAfter.teamName} 依旧排在头名。`,
                ]),
          );
        } else {
          aftermath.push(
            pickFresh(`${m.id}:ctxF`, [
              `${winnerAfter.teamName} 现在 ${winnerAfter.pts} 分，排在积分榜第 ${winnerAfter.rank} 位。`,
              `积分榜上，${winnerAfter.teamName} ${winnerAfter.pts} 分，排第 ${winnerAfter.rank} 位。`,
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
          pickFresh(`${m.id}:rec1`, [
            `${wName} 终结了 ${lName} 的${cnum(lBefore.win)}连胜。`,
            `${lName} 的${cnum(lBefore.win)}连胜，被 ${wName} 挡停。`,
            `${lName} 的${cnum(lBefore.win)}连胜，就此作古。`,
          ]),
        );
      if (wAfter.win >= 3)
        streakLines.push(
          pickFresh(`${m.id}:rec2`, [
            `${wName} 收获${cnum(wAfter.win)}连胜。`,
            `${wName} 的连胜来到${cnum(wAfter.win)}场。`,
            `赢下本场，${wName} 已经连赢${cnum(wAfter.win)}场。`,
          ]),
        );
      if (lBefore.unbeaten >= 3)
        streakLines.push(
          pickFresh(`${m.id}:rec3`, [
            `${lName} ${cnum(lBefore.unbeaten)}场不败遭终结。`,
            `${wName} 终结了 ${lName} ${cnum(lBefore.unbeaten)}场不败的纪录。`,
            `${lName} ${cnum(lBefore.unbeaten)}场不败的纪录，就此作古。`,
          ]),
        );
      if (wAfter.cleanSheet >= 2)
        streakLines.push(
          pickFresh(`${m.id}:rec4`, [
            `${wName} 连续${cnum(wAfter.cleanSheet)}场零封。`,
            `${wName} 的球门已经连续${cnum(wAfter.cleanSheet)}场没有被攻破。`,
          ]),
        );
      if (wAfter.unbeaten >= 5)
        streakLines.push(
          pickFresh(`${m.id}:rec5`, [
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
          pickFresh(`${m.id}:rec6h`, [
            `${m.homeTeamName} 已${cnum(hAfter.unbeaten)}轮不败。`,
            `近${cnum(hAfter.unbeaten)}轮，${m.homeTeamName} 仍未尝败绩。`,
          ]),
        );
      if (aAfter.unbeaten >= 5)
        streakLines.push(
          pickFresh(`${m.id}:rec6a`, [
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
            pickFresh(`${m.id}:h2h1`, [
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
            pickFresh(`${m.id}:h2h2`, [
              `${nowWinner} 对 ${opp} 已连续${cnum(run)}场交锋取胜。`,
              `近${cnum(run)}次碰面，赢的都是 ${nowWinner}。`,
            ]),
          );
        }
      } else if (nowWinner && prevWinner && prevWinner !== nowWinner) {
        aftermath.push(
          pickFresh(`${m.id}:h2h3`, [
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
          pickFresh(`${m.id}:h2h5`, [
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
            pickFresh(`${m.id}:top1`, [
              `${after.name} 以 ${after.goals} 球登顶射手榜。`,
              `射手榜随之改写：${after.name} 凭 ${after.goals} 球升至头名。`,
            ]),
          );
        } else if (rankAfter === 1 && rankBefore === 1 && after.goals >= 2) {
          const second = scorerTotals[1];
          const gap = second ? after.goals - second.goals : 0;
          lines.push(
            gap > 0
              ? pickFresh(`${m.id}:top2`, [
                  `${after.name} 以 ${after.goals} 球继续领跑射手榜（领先第 2 名 ${gap} 球）。`,
                  `射手榜上 ${after.name} 依旧第一，${after.goals} 球，比第二名多 ${gap} 球。`,
                ])
              : pickFresh(`${m.id}:top3`, [
                  `${after.name} 以 ${after.goals} 球继续领跑射手榜。`,
                  `${after.name} 仍以 ${after.goals} 球占据射手榜头名。`,
                ]),
          );
        } else if (rankAfter >= 2 && rankAfter <= 3) {
          const leader = scorerTotals[0];
          const gap = leader ? leader.goals - after.goals : 0;
          if (gap > 0 && gap <= 2 && rankAfter < rankBefore) {
            lines.push(
              pickFresh(`${m.id}:top4`, [
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

    // 5.5) #7 战报侧里程碑尾注：该场进球者（非乌龙）本届总进球达到 5 的奇数倍（5/15/25…，
    // feed 砍档的那档）时追一句「本届第 N 球」（MILESTONE_GOALS_TITLE 变体）；
    // 每场至多 1 条（按事件序取首个命中者），计入 aftermath 3 句预算
    const milestoneFact = goalFacts.find((g) => {
      if (g.type === "own_goal") return false;
      const pid = g.playerKey.startsWith("p:") ? Number(g.playerKey.slice(2)) : 0;
      if (!(pid > 0)) return false;
      const t = scorerTotals.find((x) => x.playerId === pid);
      return t != null && t.goals >= 5 && t.goals % 10 === 5;
    });
    if (milestoneFact) {
      const pid = Number(milestoneFact.playerKey.slice(2));
      const t = scorerTotals.find((x) => x.playerId === pid)!;
      aftermath.push(`${pickText(`${m.id}:ms:${pid}`, MILESTONE_GOALS_TITLE)(t.name, t.goals)}。`);
    }

    // 影响收尾段：本场之后才成立的事织进正文（倒金字塔结尾层），最多 3 句
    if (aftermath.length > 0) paragraphs.push(aftermath.slice(0, 3).join(""));

    // C3 钩子池接线（audit §5 钩子一段制）：streakBroken 取败方赛前连况（与 aftermath streakLines
    // 同源的 currentStreaks 重放）、revenge 取 h2h 首回合失利本场复仇；comebackDeficit 未重放，
    // 「连追 N 球」变体自动跳过。钩子最多一段，缀在六档标题之后
    const hookStreakBroken = lEntry
      ? (() => {
          const st = currentStreaks(beforeList, lEntry);
          return st.win >= 2 ? { kind: "win" as const, count: st.win, teamName: lName } : null;
        })()
      : null;
    const hookRevenge = (() => {
      if (!wEntry) return false;
      const prev = tFinished.find(
        (x) =>
          x.id !== m.id &&
          x.walkoverSide === "" &&
          ((x.homeEntryId === m.homeEntryId && x.awayEntryId === m.awayEntryId) ||
            (x.homeEntryId === m.awayEntryId && x.awayEntryId === m.homeEntryId)),
      );
      if (!prev) return false;
      const prevWinner =
        prev.scoreHome > prev.scoreAway ? prev.homeTeamName : prev.scoreAway > prev.scoreHome ? prev.awayTeamName : null;
      const nowWinner = m.scoreHome > m.scoreAway ? m.homeTeamName : m.scoreAway > m.scoreHome ? m.awayTeamName : null;
      return prevWinner != null && nowWinner != null && prevWinner !== nowWinner;
    })();
    const hook = pickResultHook(
      `hk:${m.id}`,
      { ...facts!, streakBroken: hookStreakBroken }, // 非弃权场 facts 恒非空
      {
        home: m.homeTeamName,
        away: m.awayTeamName,
        scoreHome: m.scoreHome,
        scoreAway: m.scoreAway,
        heroName: hero?.name ?? null,
        revenge: hookRevenge,
      },
    );
    // 标题功臣短语只出现一次（2026-11-21 #2）：resultPhrases 已在标题尾缀过功臣短语时，
    // 钩子池的同名功臣句（{X} 梅开二度/帽子戏法/双响救主）不再重复追加——
    // 生产 227 标题曾出现「Romelu Lukaku 梅开二度，Romelu Lukaku 梅开二度」
    const heroDuplicated =
      hook != null &&
      hero != null &&
      hero.goals >= 2 &&
      hook.includes(hero.name) &&
      title.includes(`${hero.name} ${heroPhrase(hero.goals)}`);
    if (hook && !heroDuplicated) title += `，${hook}`;

    // 6) 球队近况 2.0：状态画像（audit §7，C1）。role = winner / loser / level（点球胜负按 shootout
    // 胜方；弃权场走独立模板不进此段）。预算 B=3 句：① 最高档球员事实（P1>P2/P3>P7，胜方 hero 优先
    // 于败方，败方行允许但不落最后）→ ② 另一侧球队行（任意极性）→ ③ 胜方（平局取更正面一方）正句殿后
    // （T1 正向 > T2 场地连胜 > T3 升位 > 胜方 hero 次高档球员事实）。事实选择不骰、池内变体 pickText、
    // 段落整体过 RATES.formReport；窗口 = 两队各最近 8 场完赛（含本场、剔除弃权），排名走势重放近 5 轮。
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
    const ps = facts?.penShootout ?? null;
    const regWinnerSide: "home" | "away" | null =
      m.scoreHome > m.scoreAway ? "home" : m.scoreAway > m.scoreHome ? "away" : null;
    const penWinnerSide: "home" | "away" | null = ps ? (ps.home > ps.away ? "home" : "away") : null;
    const winnerSide: "home" | "away" | null = regWinnerSide ?? penWinnerSide;
    const loserSide: "home" | "away" | null =
      winnerSide != null ? (winnerSide === "home" ? "away" : "home") : null;
    const entryOf = (side: "home" | "away") => (side === "home" ? m.homeEntryId : m.awayEntryId);
    const teamNameOf = (side: "home" | "away") => (side === "home" ? m.homeTeamName : m.awayTeamName);
    const teamMatches = (side: "home" | "away"): FinishedMatch[] =>
      afterList.filter(
        (x) => x.walkoverSide === "" && (x.homeEntryId === entryOf(side) || x.awayEntryId === entryOf(side)),
      );

    // 球员候选：本场出场证据 = 进球/助攻（goalFacts，乌龙不算）；胜方侧优先，平局按主客自然序
    const cands: Array<{ playerId: number; name: string; side: "home" | "away"; scored: boolean }> = [];
    {
      const seen = new Set<number>();
      const push = (pid: number | null, name: string | null, side: "home" | "away", scored: boolean) => {
        if (pid == null || !name || seen.has(pid)) return;
        seen.add(pid);
        cands.push({ playerId: pid, name, side, scored });
      };
      for (const side of winnerSide != null ? [winnerSide, loserSide!] : (["home", "away"] as const)) {
        for (const g of goalFacts) {
          if (g.side !== side) continue;
          // 射手 id 从 playerKey（"p:{id}"）反解；无球员名退化为球队口径的乌龙行不进候选
          const pid = g.playerKey.startsWith("p:") ? Number(g.playerKey.slice(2)) : null;
          if (g.type !== "own_goal") push(pid, g.playerName, side, true);
          if (g.assistId != null) push(g.assistId, g.assistName, side, false);
        }
      }
    }
    const windowIds = [
      ...new Set([...teamMatches("home").slice(-8), ...teamMatches("away").slice(-8)].map((x) => x.id)),
    ];
    const candIds = [...new Set(cands.map((c) => c.playerId))];

    // 三条小查询并行（§7.6 预算：进球行=窗口内进球、缺阵行=点查、票选行 HAVING≥3）
    const [goalRows, missRows, motmRows] = await Promise.all([
      windowIds.length
        ? db
            .prepare(
              `SELECT match_id, player_id FROM match_event
               WHERE match_id IN (${windowIds.map(() => "?").join(",")})
                 AND type IN ('goal', 'pen_goal') AND player_id IS NOT NULL`,
            )
            .bind(...windowIds)
            .all<{ match_id: number; player_id: number }>()
        : Promise.resolve({ results: [] as Array<{ match_id: number; player_id: number }> }),
      candIds.length && windowIds.length
        ? db
            .prepare(
              `SELECT im.match_id, i.player_id
               FROM injury_miss im JOIN injury i ON i.id = im.injury_id
               WHERE i.player_id IN (${candIds.map(() => "?").join(",")})
                 AND im.match_id IN (${windowIds.map(() => "?").join(",")})`,
            )
            .bind(...candIds, ...windowIds)
            .all<{ match_id: number; player_id: number }>()
        : Promise.resolve({ results: [] as Array<{ match_id: number; player_id: number }> }),
      (() => {
        const prevIds = [
          teamMatches("home").slice(0, -1).at(-1)?.id,
          teamMatches("away").slice(0, -1).at(-1)?.id,
        ].filter((x): x is number => x != null);
        return prevIds.length
          ? db
              .prepare(
                `SELECT match_id, player_id, COUNT(*) AS cnt
                 FROM motm_vote
                 WHERE match_id IN (${prevIds.map(() => "?").join(",")})
                 GROUP BY match_id, player_id HAVING COUNT(*) >= 3
                 ORDER BY cnt DESC, player_id ASC`,
              )
              .bind(...prevIds)
              .all<{ match_id: number; player_id: number; cnt: number }>()
          : Promise.resolve({ results: [] as Array<{ match_id: number; player_id: number; cnt: number }> });
      })(),
    ]);
    const scoredIn = new Map<number, Set<number>>();
    for (const r of goalRows.results) {
      const s = scoredIn.get(r.match_id) ?? new Set<number>();
      s.add(r.player_id);
      scoredIn.set(r.match_id, s);
    }
    const missByPlayer = new Map<number, Set<number>>();
    for (const r of missRows.results) {
      const s = missByPlayer.get(r.player_id) ?? new Set<number>();
      s.add(r.match_id);
      missByPlayer.set(r.player_id, s);
    }

    interface PlayerFact {
      tier: 1 | 2 | 3 | 4;
      text: string;
      side: "home" | "away";
      playerId: number;
    }
    const playerFactOf = (c: (typeof cands)[number]): PlayerFact | null => {
      const win = teamMatches(c.side).slice(-8);
      // P1：上一场起连续缺阵 ≥1 场后，本场回归；本场进球升级「复出即破门」
      const missSet = missByPlayer.get(c.playerId);
      let absent = 0;
      if (missSet) {
        for (let i = win.length - 2; i >= 0; i--) {
          if (!missSet.has(win[i].id)) break;
          absent += 1;
        }
      }
      if (absent >= 1) {
        return {
          tier: 1,
          text: pickText(`${m.id}:pf:${c.playerId}:1`, c.scored ? FORM_POOLS.comebackScored : FORM_POOLS.comeback)({
            p: c.name,
            n: absent,
          }),
          side: c.side,
          playerId: c.playerId,
        };
      }
      // P2：连续 K 场破门（含本场），K≥2；K≥4 用更夸张变体池
      let k = 0;
      for (let i = win.length - 1; i >= 0; i--) {
        if ((scoredIn.get(win[i].id) ?? new Set<number>()).has(c.playerId)) k += 1;
        else break;
      }
      if (k >= 2) {
        return {
          tier: 2,
          text: pickText(`${m.id}:pf:${c.playerId}:2`, k >= 4 ? FORM_POOLS.streakBlaze : FORM_POOLS.streakHot)({
            p: c.name,
            k,
          }),
          side: c.side,
          playerId: c.playerId,
        };
      }
      // P3：近 N(≥3) 场 Y 球，Y≥2 才成事实（与 P2 互斥取高：走到这里即无连场）
      const recent = win.slice(-4);
      if (recent.length >= 3) {
        let y = 0;
        for (const x of recent) {
          for (const r of goalRows.results) {
            if (r.match_id === x.id && r.player_id === c.playerId) y += 1;
          }
        }
        if (y >= 2) {
          return {
            tier: 3,
            text: pickText(`${m.id}:pf:${c.playerId}:3`, FORM_POOLS.production)({
              p: c.name,
              n: recent.length,
              y,
            }),
            side: c.side,
            playerId: c.playerId,
          };
        }
      }
      return null;
    };
    // P7：两队各自上一场完赛的全场最佳票王（cnt≥3），且该球员本场出场（进球/助攻候选）
    const motmKing = (side: "home" | "away"): { playerId: number; cnt: number } | null => {
      const prev = teamMatches(side).slice(0, -1).at(-1) ?? null;
      if (!prev) return null;
      const row = motmRows.results.find((r) => r.match_id === prev.id);
      return row ? { playerId: row.player_id, cnt: row.cnt } : null;
    };
    const factsList: PlayerFact[] = [];
    for (const c of cands) {
      const f = playerFactOf(c);
      if (f) {
        factsList.push(f);
        continue;
      }
      const king = motmKing(c.side);
      if (king && king.playerId === c.playerId) {
        factsList.push({
          tier: 4,
          text: pickText(`${m.id}:pf:${c.playerId}:7`, FORM_POOLS.motm)({ p: c.name, c: king.cnt }),
          side: c.side,
          playerId: c.playerId,
        });
      }
    }
    const sideRank = (s: "home" | "away") => (winnerSide != null ? (s === winnerSide ? 0 : 1) : 0);
    const candOrder = new Map(cands.map((c, i) => [c.playerId, i]));
    factsList.sort(
      (a, b) =>
        a.tier - b.tier ||
        sideRank(a.side) - sideRank(b.side) ||
        (candOrder.get(a.playerId) ?? 0) - (candOrder.get(b.playerId) ?? 0),
    );
    const topFact = factsList[0] ?? null;

    // T3 排名走势：当前榜重放近 ≤5 轮（升=正/降=负；多组小组赛与不可回溯时放弃，纯 CPU 零新查询）
    const rankMove = new Map<number, number>();
    let tail5Len = 0;
    if (snap) {
      const singleGroup = new Set(snap.rows.map((r) => r.groupId ?? 0)).size <= 1;
      const tail = afterList.filter((x) => x.stageId === m.stageId).slice(-5);
      if (singleGroup && tail.length >= 2) {
        const rows5 = snap.rows.map((r) => ({ ...r }));
        let ok = true;
        for (const x of tail) {
          if (!subtractMatchContribution(rows5, x)) {
            ok = false;
            break;
          }
        }
        if (ok) {
          rankRowsSimple(rows5);
          tail5Len = tail.length;
          for (const r of rows5) {
            const now = snap.byEntry.get(r.entryId);
            if (now) rankMove.set(r.entryId, r.rank - now.rank);
          }
        }
      }
    }

    interface TeamRow {
      text: string;
      positive: boolean;
    }
    const teamRowOf = (side: "home" | "away", role: "winner" | "loser" | "level"): TeamRow | null => {
      const entry = entryOf(side);
      const team = teamNameOf(side);
      // T1 基础近 5（角色门控：丧气句仅败方且过 chance；正向=积分/胜场/净胜，中性=不败/失球）
      const f = formOf(entry, "all");
      const t1: TeamRow[] = [];
      if (f) {
        // T1 模板空格（2026-11-21 #7）：队名与「近」之间留半角空格，对齐 T3/近况段惯例
        if (f.pts >= 10) t1.push({ text: `${team} 近${cnum(f.n)}场拿下${cnum(f.pts)}分。`, positive: true });
        if (f.w >= 3) t1.push({ text: `${team} 近${cnum(f.n)}场赢下${cnum(f.w)}场。`, positive: true });
        if (f.l === 0)
          t1.push({ text: `${team} 近${cnum(f.n)}场${cnum(f.w)}胜${cnum(f.d)}平保持不败。`, positive: false });
        if (f.ga <= 2) t1.push({ text: `${team} 近${cnum(f.n)}场只丢${cnum(f.ga)}球。`, positive: false });
        if (f.gd >= 4) t1.push({ text: `${team} 近${cnum(f.n)}场净胜${cnum(f.gd)}球。`, positive: true });
        if (f.l >= 3 && role === "loser" && chance(`${m.id}:fslump:${entry}`, 0.5))
          t1.push({ text: `${team} 近${cnum(f.n)}场输掉${cnum(f.l)}场，需要调整状态。`, positive: false });
      }
      // T2 场地连胜：venue 窗口全胜且 ≥2 场；整体连胜已进 aftermath rec2（≥3）时让位
      let t2: TeamRow | null = null;
      const venue = side === "home" ? "主场" : "客场";
      const venueWin = afterList
        .filter((x) => x.walkoverSide === "" && (side === "home" ? x.homeEntryId === entry : x.awayEntryId === entry))
        .slice(-5);
      const w = venueWin.filter((x) =>
        side === "home" ? x.scoreHome > x.scoreAway : x.scoreAway > x.scoreHome,
      ).length;
      if (venueWin.length >= 2 && w === venueWin.length && currentStreaks(afterList, entry).win < 3) {
        t2 = {
          text: pickText(`${m.id}:t2:${entry}`, FORM_POOLS.venueStreak)({ team, venue, n: venueWin.length }),
          positive: true,
        };
      }
      // T3 排名走势（升=正、降=丧气；降位仅败方用）
      let t3: TeamRow | null = null;
      const move = rankMove.get(entry);
      if (move != null && move !== 0) {
        const now = snap!.byEntry.get(entry)!;
        const positive = move > 0;
        if (positive || role === "loser") {
          t3 = {
            text: pickText(`${m.id}:t3:${entry}`, positive ? FORM_POOLS.rankUp : FORM_POOLS.rankDown)({
              team,
              n: tail5Len,
              mv: Math.abs(move),
              r0: now.rank + move,
              r1: now.rank,
            }),
            positive,
          };
        }
      }
      if (role === "winner") {
        // 胜方殿后行只认正向：T1 正向 → T2 → T3 升位
        const pos = t1.filter((x) => x.positive);
        if (pos.length > 0) return pickText(`${m.id}:t1w:${entry}`, pos);
        if (t2) return t2;
        if (t3 && t3.positive) return t3;
        return null;
      }
      // 败方/平局中段行：T1（角色门控后任意极性）→ T2 → T3
      if (t1.length > 0) return pickText(`${m.id}:t1m:${entry}`, t1);
      if (t2) return t2;
      if (t3) return t3;
      return null;
    };

    // 装填（§7.4，确定性）
    let formMiddle: TeamRow | null = null;
    let formCloser: TeamRow | { text: string } | null = null;
    if (winnerSide != null) {
      formMiddle = teamRowOf(loserSide!, "loser");
      const wRow = teamRowOf(winnerSide, "winner");
      if (wRow) {
        formCloser = wRow;
      } else {
        // 无正向球队行 → 胜方 hero 的次高档球员事实（非 topFact 本条）
        const alt = factsList.find((f) => f.side === winnerSide && f !== topFact);
        formCloser = alt ? { text: alt.text } : null;
      }
    } else {
      // 平局：更正面一方收尾——正向球队行优先（两队都有 → 近 5 积分高者，再同分主队）；
      // 无正向球队行时收尾取最高档球员事实，预算余量内另一侧球队行进中段
      const rowsH = teamRowOf("home", "level");
      const rowsA = teamRowOf("away", "level");
      const hPos = rowsH?.positive ?? false;
      const aPos = rowsA?.positive ?? false;
      if (hPos || aPos) {
        const closeSide =
          hPos === aPos
            ? (formOf(entryOf("home"), "all")?.pts ?? 0) >= (formOf(entryOf("away"), "all")?.pts ?? 0)
              ? "home"
              : "away"
            : hPos
              ? "home"
              : "away";
        formCloser = closeSide === "home" ? rowsH : rowsA;
        formMiddle = closeSide === "home" ? rowsA : rowsH;
      } else if (topFact) {
        formCloser = { text: topFact.text };
        formMiddle = topFact.side === "home" ? rowsA : rowsH;
      }
    }
    const formSentences: string[] = [];
    const closerIsTop = formCloser != null && topFact != null && formCloser.text === topFact.text;
    if (topFact && !closerIsTop) formSentences.push(topFact.text);
    if (formMiddle) formSentences.push(formMiddle.text);
    if (formCloser) formSentences.push(formCloser.text);
    // 最后一句必须是胜方（平局更正面一方）的正句——closer 缺席则整段不出
    if (formCloser != null && formSentences.length > 0 && chance(`${m.id}:fg`, RATES.formReport)) {
      paragraphs.push(formSentences.slice(-3).join(""));
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
