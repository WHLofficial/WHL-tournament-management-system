// 句库与文案机制：所有文案池子、触发概率、角度选择集中于此。
// 四条铁律：
// 1. 池内变体必须事实等价——只换说法，不改事实；新池 ≥6 条。
// 2. 直白基调：每池带修辞/比喻的至多 1-2 条，其余直说（陈述事实+节制感受），活人感≠文学腔。
// 3. 触发永不百分百：呼吸句/态度句/事件型标题一律过 chance()，概率常量只在 RATES 里调。
// 4. humanizer 底线：禁「彰显/见证/证明/展示/标志着/不仅…而是/三段式列举/破折号/emoji/模糊归因/
//    金句式收尾」；长短句交错，开头换主语，具体细节优先。
import { chance, pickText } from "../../shared/textpick";
import { cnum } from "./context";
import type { MatchFacts } from "./narrativeFacts";

// ---------- 触发率（0..1，全部走 chance；调口味只改这里） ----------
export const RATES = {
  breathNews: 0.55, // 快讯呼吸句（每篇预算 ≤1）
  breathReport: 0.65, // 战报呼吸句（每篇预算 ≤2）
  attitudeNews: 0.4, // 快讯快评段出现概率
  paraThird: 0.5, // 快讯第三段（收尾段）在基础两段之外出现的概率——平淡场不注水
  titleEvent: 0.45, // 事件型标题入选（不霸屏）
  titleAtmo: 0.35, // 氛围型标题入选
  recapDramaAngle: 0.8, // dramaScore≥60 时综述/快评走剧情角度
  recapMidAngle: 0.55, // 30-59
  recapLowAngle: 0.3, // <30
  reportDrama: 0.65, // 战报剧情句（背景块 2.5 节）出现概率
  formReport: 0.75, // 战报收尾近况段出现概率
} as const;

// ---------- 态度句的素材包 ----------
export interface CopyCtx {
  label: string; // 「主队 vs 客队」
  scoreLine: string; // 「2:1」
  goalCount: number;
  winnerName: string | null;
  loserName: string | null;
  heroName: string | null; // 一人扛队/单场最多进球者
  roundLabel: string;
}

// ---------- 呼吸句池：按剧情情景分组，一句话的换气口，不解释不拔高 ----------
export const BREATH = {
  // 罚失点球（事件当下反应）
  penMissLive: [
    "点球点上的机会，就这样溜走了。",
    "十二码前的机会，没能变成进球。",
    "这一脚罚出去，运气没站在他这边。",
    "机会给了，可惜没接住。",
    "点球罚失，场上的气氛一下沉了下去。",
    "门将赌对了方向，罚球的人只能认。",
  ],
  // 红牌（事件当下反应）
  redLive: [
    "少一人，此后每一步都更难。",
    "红牌之后，场上的平衡被打破了。",
    "接下来，十个人要顶住十一个人的进攻。",
    "这张牌改变的不只是人数。",
    "少一人作战，替补席上的算盘得重打。",
    "红牌一出，剩下的时间都是考验。",
  ],
  // 大胜静态总结（净胜 ≥3）
  rout: [
    "这是一场一边倒的较量。",
    "分差说明了一切。",
    "从第一分钟到最后一分钟，主动权都在同一边。",
    "赢家踢得轻松，输家踢得漫长。",
    "三个球的差距，是两支球队今天的真实距离。",
    "这种比赛，过程和比分一样直白。",
  ],
  // 绝杀（末球 ≥80' 破平或反超制胜）
  lateWinner: [
    "胜负直到最后十分钟才分出来。",
    "决定结果的那个球，来得比想象中晚。",
    "前面八十多分钟没分出高下，最后一刻分了。",
    "最后的比分，是比赛真正结束前才写上的。",
    "最后十分钟比分又动了一次，就这一次定了输赢。",
    "这种球，没到哨响都不敢说赢。",
  ],
  // 大逆转（曾落后两球以上翻盘）
  comebackBig: [
    "两球落后之后，一点一点追了回来。",
    "落后两球没崩，剩下的时间全用来还账。",
    "从两球落后到赢球，中间没有放弃两个字。",
    "被拉开两球的时候比赛很难看，结尾很好看。",
    "两球的差距最后填平了，还多拿了一场胜利。",
    "落后两球的队伍赢了，这本身就是全部看点。",
  ],
  // 小翻盘（曾落后一球赢回）
  comebackSmall: [
    "一球落后，追平，再赢下，过程不算惊险，结果扎实。",
    "先丢一球再反超，赢法比比分好看。",
    "落后那段时间没乱，追平之后也没停。",
    "一球的坡不大，但他们认真爬完了。",
    "追平只是底线，赢回来才算数。",
    "这种赢法不热闹，但很硬。",
  ],
  // 红牌后崩/缩水
  redFell: [
    "红牌之后，比赛走向变了。",
    "少一人的代价，最后落在了比分上。",
    "多打一人的对面，不会一直客气。",
    "红牌是转折点，比分是结果。",
    "少一人之后，能守住的东西越来越少。",
    "那张牌，把之前的优势一点点磨掉了。",
  ],
  // 红牌后顶住/更好
  redHeld: [
    "少一人，阵型收了收，局面稳住了。",
    "红牌之后没有再出事，这就够。",
    "十个人守住了该守的东西。",
    "少一人之后，比赛没有往坏里走。",
    "人数的亏，用阵型和跑动补了回来。",
    "一张红牌没有改变结果的方向。",
  ],
  // 点球戏（点球制胜/罚失方反而赢）
  pen: [
    "胜负最后出在点球点上。",
    "十二码前的那一下，就是全场的分水岭。",
    "点球这种事，进了是功臣，不进是背景板。",
    "比赛的胜负，被一个点球定了。",
    "十二码，最短也最长的距离。",
    "踢点球的人压力最大，看的人也一样。",
  ],
  // 乌龙胜负手
  ownGoal: [
    "决定胜负的一球，记在了对面的账上。",
    "赢球的分，来自对面的失误。",
    "乌龙球没法指责谁，但它分出了胜负。",
    "这场的胜负手，是个谁都不想要的结果。",
    "有人替对手进了最关键的一球。",
    "失误人人有，这场的失误刚好值三分。",
  ],
  // 两球领先被抹平
  blownLead: [
    "两球的领先，最后没能带回家。",
    "领先两球之后，比赛反倒不会踢了。",
    "到手的两球优势，一球一球还了回去。",
    "领先的时候有多稳，被追平的时候就有多难堪。",
    "原本两球在手，结局却不是他们要的。",
    "被追两球这种事，比一开始就落后更伤。",
  ],
  // 一人扛队/帽子戏法以上
  hero: [
    "全队的进球，基本都出自一个人。",
    "这场的进球账本，翻来翻去是同一个名字。",
    "别人踢比赛，他今天负责进球。",
    "一人扛着锋线，把比分扛到了终点。",
    "他进一个，大家还惦记下一个，结果真有下一个。",
    "这种状态的球员，一场比赛就够了。",
  ],
  // 进球潮/尾段连环
  flurry: [
    "进球集中在很短的一段时间里。",
    "很短的时间里，比分被接连改写。",
    "那段时间，谁也拦不住进球。",
    "进球一来就是一批。",
    "短时间连着进球，比分一下就打开了。",
    "密集的进球，把比赛的节奏整个带走了。",
  ],
  // 爆冷下克上
  upset: [
    "排名靠后的把靠前的拉下马了。",
    "名次低的一方赢了，赛前这么猜的人不多。",
    "积分榜的位置没帮上忙，球是踢出来的。",
    "这场比赛的结果，和积分榜的排序正好相反。",
    "赛前被看低的一方，把比赛拿了下来。",
    "冷门不是每天都有，今天有。",
  ],
  // 金身/连胜被终结
  streak: [
    "他们的那串纪录，今天停了。",
    "顺了很久的日子，今天到头了。",
    "纪录停在数字上，比赛输在今天。",
    "好状态总有到头的一天，今天就是。",
    "这份势头，被今天这场掐断了。",
    "纪录终结之日，对面踢得更好。",
  ],
  // 拉锯战（双方都领先过/领先易手多次）
  seeSaw: [
    "领先权换了几次手，谁都没能坐稳。",
    "两边都领先过，也都紧张过。",
    "这种比赛，领先不算安全。",
    "你追我赶，比分直到最后才定。",
    "谁领先都不踏实，这就是这种比赛的脾气。",
    "交替领先的比赛最费心，也最好看。",
  ],
  // 开场闪电（首球 ≤10'）
  bolt: [
    "开场不到十分钟，比分就动了。",
    "第一球来得非常早。",
    "刚开场的进球，把比赛计划全打乱了。",
    "哨响没多久，比分就变了。",
    "开局进球早，后面的人都得跟着调整。",
    "有人还没坐进看台，场上已经进球了。",
  ],
  // 闷战/哑火期/上半场沉闷
  dull: [
    "中间很长一段时间，两边都没能进球。",
    "进球来得晚，中间的部分比较熬人。",
    "有一阵子，场上唯一的事就是等一个进球。",
    "长时间不进球的比赛，比的其实是耐心。",
    "等进球等得久，来了就格外响。",
    "比赛一直缺一个进球，直到缺到最后。",
  ],
} as const;

// 呼吸句统一入口：按剧情强度排序逐情景 chance 门控，取满 budget 为止；同篇 seed 相同则结果确定。
export function pickBreath(seed: string, facts: MatchFacts, budget: number, rate: number): string[] {
  const out: string[] = [];
  const tryKind = (kind: string, pool: readonly string[], ok: boolean): void => {
    if (!ok || out.length >= budget) return;
    if (chance(`${seed}:${kind}`, rate)) out.push(pickText(`${seed}:${kind}`, pool));
  };
  tryKind("lw", BREATH.lateWinner, facts.lateWinner);
  tryKind("cb", BREATH.comebackBig, facts.comeback === "big");
  tryKind("cs", BREATH.comebackSmall, facts.comeback === "small");
  tryKind(
    "rf",
    BREATH.redFell,
    facts.redTurn?.outcome === "collapsed" || facts.redTurn?.outcome === "faded",
  );
  tryKind(
    "rh",
    BREATH.redHeld,
    facts.redTurn?.outcome === "held" || facts.redTurn?.outcome === "improved",
  );
  tryKind("pn", BREATH.pen, facts.penDecider || facts.penMissSwing);
  tryKind("og", BREATH.ownGoal, facts.ogDecider);
  tryKind("bl", BREATH.blownLead, facts.blownLead);
  tryKind("he", BREATH.hero, facts.soloAct != null || facts.maxBagGoals >= 3);
  tryKind("fl", BREATH.flurry, facts.goalBurst != null || facts.lateFlurryCount >= 2);
  tryKind("up", BREATH.upset, facts.upset != null);
  tryKind("st", BREATH.streak, facts.streakBroken != null);
  tryKind("ss", BREATH.seeSaw, facts.bothLed || facts.leadChanges >= 2);
  tryKind("bo", BREATH.bolt, facts.openingBolt);
  tryKind("du", BREATH.dull, facts.shape === "dull" || facts.drought != null);
  return out;
}

// ---------- 态度句（快评段）：剧情角度 vs 数据角度，各池 ≥6，变体为观点、不虚构事实 ----------
export const ATTITUDE = {
  drama: [
    (c: CopyCtx) => `过程比 ${c.scoreLine} 这个比分好看。`,
    (c: CopyCtx) => `这一轮要是只看一场，看 ${c.label}。`,
    (c: CopyCtx) => (c.winnerName ? "输的一方可惜，赢的一方提气，观众赚到。" : "谁都没赢，但观众没白来。"),
    (c: CopyCtx) =>
      c.winnerName ? `${c.winnerName} 的三分来得不轻松，含金量足。` : "点到为止，双方都不亏。",
    (_c: CopyCtx) => "这种比赛放到整个赛季里看，也算排得上号。",
    (_c: CopyCtx) => "不到最后一刻不知道结果，就是好比赛。",
  ],
  data: [
    (c: CopyCtx) =>
      c.winnerName ? `比分 ${c.scoreLine}，球就是这样赢的。` : `比分 ${c.scoreLine}，谁也没能多走一步。`,
    (c: CopyCtx) => `${c.heroName ?? "进球的人"}，决定了 ${c.scoreLine}。`,
    (c: CopyCtx) => `一场 ${c.goalCount} 球的比赛，效率说了算。`,
    (c: CopyCtx) => (c.winnerName ? `三分到手，${c.winnerName} 的方式很实际。` : `${c.scoreLine}，两边都务实。`),
    (_c: CopyCtx) => "比分之外的东西，赛后慢慢聊。",
    (c: CopyCtx) => `结果先记下：${c.scoreLine}，过程有得聊。`,
  ],
} as const;

export type NewsAngle = "drama" | "data";

// 角度选择：drama 高则剧情角度加权；平淡场偶尔也给态度，但概率压低。
export function chooseAngle(seed: string, dramaScore: number | null): NewsAngle {
  const key = `${seed}:ang`;
  if (dramaScore == null) return chance(key, 0.25) ? "drama" : "data";
  if (dramaScore >= 60) return chance(key, RATES.recapDramaAngle) ? "drama" : "data";
  if (dramaScore >= 30) return chance(key, RATES.recapMidAngle) ? "drama" : "data";
  return chance(key, RATES.recapLowAngle) ? "drama" : "data";
}

export function pickAttitude(seed: string, angle: NewsAngle, c: CopyCtx): string {
  const pool = angle === "drama" ? ATTITUDE.drama : ATTITUDE.data;
  return pickText(seed, pool)(c);
}

// ---------- 快讯数据段：纯数字盘面（比分/总进球/胜负/点球大战），直白基调 ----------
// 不重复事件段的人物细节；平局/零进球/点球大战各自成立，池内变体对同一输入事实等价。
export interface MatchDataCtx {
  scoreHome: number;
  scoreAway: number;
  totalGoals: number;
  winnerName: string | null; // null = 平局（含点球大战：记分平局，胜负由 penLine 交代）
  penLine: string | null; // 「点球大战 4:3 分出胜负」，无点球大战为 null
}

export const MATCH_DATA_PARA: ((c: MatchDataCtx) => string)[] = [
  (c) =>
    c.totalGoals === 0
      ? `终场 ${c.scoreHome}:${c.scoreAway}，双方都没能取得进球。`
      : `终场 ${c.scoreHome}:${c.scoreAway}，两队合计打进 ${c.totalGoals} 球。`,
  (c) =>
    c.totalGoals === 0
      ? `全场比分 ${c.scoreHome}:${c.scoreAway}，进球数为零。`
      : `全场比分 ${c.scoreHome}:${c.scoreAway}，共 ${c.totalGoals} 粒进球。`,
  (c) =>
    c.winnerName
      ? `${c.winnerName} 收下比赛，比分 ${c.scoreHome}:${c.scoreAway}。`
      : `双方战成 ${c.scoreHome}:${c.scoreAway}。`,
  (c) => `${c.scoreHome}:${c.scoreAway}，${c.winnerName ? "胜负已分" : "不分胜负"}。`,
  (c) =>
    c.winnerName
      ? `胜负分晓：${c.winnerName}，${c.scoreHome}:${c.scoreAway}。`
      : `${c.scoreHome}:${c.scoreAway}，难分胜负。`,
  (c) =>
    c.totalGoals === 0
      ? `${c.scoreHome}:${c.scoreAway}，双方互交白卷。`
      : `${c.totalGoals} 球，比分 ${c.scoreHome}:${c.scoreAway}。`,
];

export function matchDataPara(seed: string, c: MatchDataCtx): string {
  const base = pickText(seed, MATCH_DATA_PARA)(c);
  return c.penLine ? `${base}${c.penLine}。` : base;
}

// ---------- 锁定胜局回填词表：report.ts 收尾句替换的唯一来源；扩收尾句池必须同步这里 ----------
export const SEAL_WORDS = ["再下一城", "再进一球", "扩大战果", "再入一球", "扳回一城", "扳回一球"] as const;
export const SEAL_REPLACE = "锁定胜局";

// 功臣后缀（同一球员 ≥2 球，缀在进球句射手名后、动词前）
export function heroPhrase(count: number): string {
  if (count === 2) return "梅开二度";
  if (count === 3) return "上演帽子戏法";
  return `独中${cnum(count)}球`;
}

// ---------- 标题池：骨架多样（比分前置/事件/纪录/氛围），标题 ≤32 字 ----------
// 基础比分题永远可用；事件型/氛围型过 chance 不霸屏；纪录型按数据条件出现。

export interface MatchTitleBase {
  roundLabel: string;
  home: string;
  away: string;
  scoreHome: number;
  scoreAway: number;
  winnerName: string | null;
  loserName: string | null;
}

export const MATCH_TITLE_BASE = [
  (c: MatchTitleBase) => `${c.roundLabel}｜${c.home} ${c.scoreHome}:${c.scoreAway} ${c.away}`,
  (c: MatchTitleBase) => `${c.roundLabel}｜全场战罢，${c.home} ${c.scoreHome}:${c.scoreAway} ${c.away}`,
  (c: MatchTitleBase) => `${c.roundLabel}｜比分定格：${c.home} ${c.scoreHome}:${c.scoreAway} ${c.away}`,
  (c: MatchTitleBase) => `${c.roundLabel}｜终场哨响，${c.home} ${c.scoreHome}:${c.scoreAway} ${c.away}`,
  (c: MatchTitleBase) => `${c.roundLabel}｜${c.home} 与 ${c.away} 打出 ${c.scoreHome}:${c.scoreAway}`,
  (c: MatchTitleBase) => `${c.roundLabel}｜${c.scoreHome}:${c.scoreAway}，${c.home} 对阵 ${c.away}`,
];

export function matchNewsTitle(seed: string, c: MatchTitleBase, facts: MatchFacts | null): string {
  // 标题 ≤32 字兜底：选中变体超长时退池内最短变体（仍然确定）
  const fit = (s: string, pool: string[]): string => {
    const t = pickText(s, pool);
    if ([...t].length <= 32) return t;
    return pool.reduce((a, b) => ([...a].length <= [...b].length ? a : b));
  };
  const cands: string[] = MATCH_TITLE_BASE.map((f) => f(c));
  if (!facts) return fit(seed, cands);

  // 事件型（过 chance，不霸屏）：绝杀/逆转/翻盘/爆发/爆冷/点球制胜/尾段进球潮
  const ev: string[] = [];
  const lg = facts.lastGoal;
  if (facts.lateWinner && lg) {
    if (lg.minute != null && lg.playerName) {
      ev.push(`${lg.playerName} 第 ${lg.minute} 分钟绝杀，${c.home} ${c.scoreHome}:${c.scoreAway} ${c.away}`);
      ev.push(`${c.home} ${c.scoreHome}:${c.scoreAway} ${c.away}，${lg.playerName} 最后时刻一锤定音`);
    } else {
      ev.push(`${c.home} ${c.scoreHome}:${c.scoreAway} ${c.away}，最后时刻分出胜负`);
      ev.push(`胜负在尾声阶段才揭晓，比分 ${c.scoreHome}:${c.scoreAway}`);
    }
  }
  const hero = facts.playerBags.find((b) => b.goals === facts.maxBagGoals && b.goals >= 3);
  if (hero) {
    ev.push(`${hero.playerName} ${heroPhrase(hero.goals)}，${c.home} ${c.scoreHome}:${c.scoreAway} ${c.away}`);
    ev.push(`${c.home} ${c.scoreHome}:${c.scoreAway} ${c.away}，${hero.playerName} 一人进了 ${cnum(hero.goals)} 球`);
  }
  if (facts.soloAct && facts.maxBagGoals < 3) {
    const team = facts.soloAct.side === "home" ? c.home : c.away;
    ev.push(`${facts.soloAct.playerName} 包办 ${team} 全部进球，比分 ${c.scoreHome}:${c.scoreAway}`);
    ev.push(`${c.home} ${c.scoreHome}:${c.scoreAway} ${c.away}，${team} 的进球全由 ${facts.soloAct.playerName} 打进`);
  }
  if (facts.comeback === "big" && c.winnerName && c.loserName) {
    ev.push(`${c.winnerName} 落后两球逆转 ${c.loserName}，比分 ${c.scoreHome}:${c.scoreAway}`);
    ev.push(`${c.winnerName} 上演大逆转，${c.scoreHome}:${c.scoreAway} 击退 ${c.loserName}`);
  }
  if (facts.comeback === "small" && c.winnerName && c.loserName) {
    ev.push(`${c.winnerName} 翻盘 ${c.loserName}，比分 ${c.scoreHome}:${c.scoreAway}`);
    ev.push(`${c.home} ${c.scoreHome}:${c.scoreAway} ${c.away}，${c.winnerName} 后发制人`);
  }
  if (facts.upset) {
    ev.push(`排名 ${facts.upset.winnerRank} 的 ${facts.upset.winnerName} 爆冷击败 ${c.loserName}`);
    ev.push(`${facts.upset.winnerName} 以下克上，${c.scoreHome}:${c.scoreAway} 击败 ${c.loserName}`);
  }
  if (facts.penDecider && c.winnerName && c.loserName) {
    ev.push(`制胜球来自点球，${c.winnerName} ${c.scoreHome}:${c.scoreAway} ${c.loserName}`);
    ev.push(`${c.winnerName} 靠点球拿下 ${c.loserName}，比分 ${c.scoreHome}:${c.scoreAway}`);
  }
  if (facts.lateFlurryCount >= 2) {
    ev.push(`尾段连入 ${cnum(facts.lateFlurryCount)} 球，${c.home} ${c.scoreHome}:${c.scoreAway} ${c.away}`);
    ev.push(`最后几分钟连进 ${cnum(facts.lateFlurryCount)} 球，比分定格 ${c.scoreHome}:${c.scoreAway}`);
  }
  // 门控骰子本身就是随机源：过门直接采用，不与基础题混池（否则被 6 条基础题稀释）
  if (ev.length && chance(`${seed}:ev`, RATES.titleEvent)) return fit(`${seed}:ev`, ev);

  // 纪录型（数据条件直出，不掷骰）：进球大战/大胜/互交白卷/点球大战
  const rec: string[] = [];
  if (facts.totalGoals >= 5) {
    rec.push(`${c.roundLabel}｜${cnum(facts.totalGoals)} 球大战，${c.home} ${c.scoreHome}:${c.scoreAway} ${c.away}`);
    rec.push(`${c.roundLabel}｜进球大战：${c.home} ${c.scoreHome}:${c.scoreAway} ${c.away}`);
  }
  if (facts.margin >= 4 && c.winnerName && c.loserName) {
    rec.push(`${c.roundLabel}｜${c.winnerName} 大胜 ${c.loserName}，比分 ${c.scoreHome}:${c.scoreAway}`);
    rec.push(`${c.roundLabel}｜${c.scoreHome}:${c.scoreAway}，${c.winnerName} 横扫 ${c.loserName}`);
  }
  if (facts.totalGoals === 0) {
    rec.push(`${c.roundLabel}｜互交白卷，${c.home} 0:0 ${c.away}`);
    rec.push(`${c.roundLabel}｜均无建树，双方 0:0 收场`);
  }
  if (facts.penShootout && c.winnerName) {
    rec.push(`点球大战 ${facts.penShootout.home}:${facts.penShootout.away} 分胜负，${c.winnerName} 过关`);
    rec.push(`${c.scoreHome}:${c.scoreAway} 后点球决胜，${c.winnerName} 笑到最后`);
  }
  if (rec.length) return fit(`${seed}:rec`, rec);

  // 氛围型（过 chance）：拉锯/闷战/闪电开场
  const at: string[] = [];
  if (facts.bothLed || facts.leadChanges >= 2) {
    at.push(`比分两度易手，${c.home} ${c.scoreHome}:${c.scoreAway} ${c.away}`);
    at.push(`${c.home} ${c.scoreHome}:${c.scoreAway} ${c.away}，一场拉锯战`);
  }
  if (facts.shape === "dull" || facts.drought) {
    at.push(`${c.roundLabel}｜闷战一场：${c.home} ${c.scoreHome}:${c.scoreAway} ${c.away}`);
    at.push(`${c.home} ${c.scoreHome}:${c.scoreAway} ${c.away}，节奏偏慢的一晚`);
  }
  const fg = facts.firstGoal;
  if (facts.openingBolt && fg && fg.minute != null) {
    if (fg.playerName) at.push(`${fg.playerName} 开场 ${fg.minute} 分钟闪击，${c.home} ${c.scoreHome}:${c.scoreAway} ${c.away}`);
    at.push(`开场 ${fg.minute} 分钟就有进球，${c.home} ${c.scoreHome}:${c.scoreAway} ${c.away}`);
  }
  if (at.length && chance(`${seed}:at`, RATES.titleAtmo)) return fit(`${seed}:at`, at);

  return fit(seed, cands);
}

export const WALKOVER_TITLE_SOLO = [
  (loser: string, winner: string) => `${loser} 弃权，${winner} 不战而胜`,
  (loser: string, winner: string) => `${winner} 不战而胜，${loser} 弃权`,
  (loser: string, _winner: string) => `${loser} 未能出赛，判负`,
  (loser: string, winner: string) => `${loser} 弃权，${winner} 直接过关`,
  (loser: string, winner: string) => `${loser} 弃权，${winner} 判定获胜`,
  (loser: string, winner: string) => `${winner} 判胜，${loser} 弃权`,
];
export const WALKOVER_TITLE_BOTH = [
  (home: string, away: string) => `${home} 与 ${away} 双双弃权`,
  (home: string, away: string) => `${home}、${away} 均弃权，比赛取消`,
  (home: string, away: string) => `双方都弃权，${home} 对 ${away} 没能进行`,
  (home: string, away: string) => `${home} 和 ${away} 两队弃权`,
  (home: string, away: string) => `两队双双弃权，${home} 对 ${away} 记判定比分`,
];
export function walkoverTitle(seed: string, loser: string | null, winner: string | null, home: string, away: string): string {
  if (loser && winner) return pickText(seed, WALKOVER_TITLE_SOLO)(loser, winner);
  return pickText(seed, WALKOVER_TITLE_BOTH)(home, away);
}

export const LEADER_TITLE = [
  (team: string, _old: string) => `${team} 登顶积分榜`,
  (team: string, _old: string) => `积分榜易主，${team} 登上头名`,
  (team: string, _old: string) => `${team} 升至积分榜第一`,
  (team: string, _old: string) => `榜首易主：${team}`,
  (team: string, old: string) => `${team} 挤下 ${old} 登顶`,
  (team: string, _old: string) => `${team} 抢下榜首位置`,
];
export const STREAK_WIN_TITLE = [
  (team: string, n: number) => `${team} ${n} 连胜`,
  (team: string, n: number) => `${team} 斩获${n}连胜`,
  (team: string, n: number) => `${team} ${n} 场全胜`,
  (team: string, n: number) => `势不可挡，${team} ${n} 连胜`,
  (team: string, n: number) => `${team} 连赢 ${n} 场`,
  (team: string, n: number) => `${n} 连胜：${team}`,
];
export const STREAK_UNBEATEN_TITLE = [
  (team: string, n: number) => `${team} 连续 ${n} 场不败`,
  (team: string, n: number) => `${team} 已连续 ${n} 场不败`,
  (team: string, n: number) => `${n} 场不败：${team}`,
  (team: string, n: number) => `${team} 保持 ${n} 场不败`,
  (team: string, n: number) => `${team} 近 ${n} 场没有输过`,
  (team: string, n: number) => `连续 ${n} 场不败，${team} 还在延续`,
];
export const STREAK_CLEAN_TITLE = [
  (team: string, n: number) => `${team} 连续 ${n} 场零封`,
  (team: string, n: number) => `${team} 的球门连续 ${n} 场未被攻破`,
  (team: string, n: number) => `连续 ${n} 场零封：${team}`,
  (team: string, n: number) => `${team} 连续 ${n} 场不丢球`,
  (team: string, n: number) => `${team} 再度零封对手，已是连续 ${n} 场`,
  (team: string, n: number) => `连续 ${n} 场零封，${team} 后防稳固`,
];
export const MILESTONE_GOALS_TITLE = [
  (name: string, g: number) => `${name} 达成本届第 ${g} 球`,
  (name: string, g: number) => `${name} 攻入本届第 ${g} 球`,
  (name: string, g: number) => `${name} 本届进球数来到 ${g}`,
  (name: string, g: number) => `第 ${g} 球到手：${name}`,
  (name: string, g: number) => `${name} 打进本届第 ${g} 球`,
  (name: string, g: number) => `${g} 球里程碑，${name} 达成`,
];
export const MILESTONE_TOP_TITLE = [
  (name: string, _g: number) => `${name} 登顶射手榜`,
  (name: string, _g: number) => `${name} 升至射手榜头名`,
  (name: string, _g: number) => `${name} 抢下射手榜第一`,
  (name: string, _g: number) => `射手榜易主，${name} 登顶`,
  (name: string, g: number) => `${name} 以 ${g} 球领跑射手榜`,
  (name: string, _g: number) => `射手榜第一换人：${name}`,
];
export const RED_TITLE = [
  (name: string) => `${name} 直红被罚下`,
  (name: string) => `${name} 吃到红牌`,
  (name: string) => `${name} 领到直接红牌`,
  (name: string) => `${name} 被红牌罚下`,
  (name: string) => `红牌：${name} 被逐出场`,
  (name: string) => `${name} 染红离场`,
];
export const RED2Y_TITLE = [
  (name: string) => `${name} 两黄变一红被罚下`,
  (name: string) => `${name} 两黄变红离场`,
  (name: string) => `${name} 累积两黄被罚下`,
  (name: string) => `两黄变一红：${name} 被罚下`,
  (name: string) => `${name} 两黄在身，变红离场`,
  (name: string) => `${name} 因累积两黄被罚下`,
];
export const RECAP_TITLE = [
  (rl: string, played: number, goals: number) => `${rl}综述｜${played} 场 ${goals} 球`,
  (rl: string, played: number, goals: number) => `${rl}｜${played} 场打进 ${goals} 球`,
  (rl: string, played: number, goals: number) => `${rl}收官：${played} 场 ${goals} 球`,
  (rl: string, played: number, goals: number) => `${rl}尘埃落定，${played} 场共 ${goals} 球`,
  (rl: string, played: number, goals: number) => `${rl}｜${played} 场战罢，合共 ${goals} 球`,
  (rl: string, played: number, goals: number) => `${rl}落幕：${played} 场 ${goals} 球入账`,
];
export function weeklyTitle(
  seed: string,
  v: { label: string; played: number; goals: number; topScorerName?: string; topScorerGoals?: number },
): string {
  const pool = [
    `WHL 周报 · ${v.label}`,
    `WHL 周报 · ${v.label}（${v.played} 场 ${v.goals} 球）`,
    `WHL 周报 · ${v.label}：${v.played} 战 ${v.goals} 球`,
    v.topScorerName ? `WHL 周报 · ${v.label}，${v.topScorerName} ${v.topScorerGoals} 球领跑` : "",
  ].filter(Boolean);
  return pickText(seed, pool);
}

// ---------- 轮次伤情快讯标题（整轮完赛后出条） ----------
// 轻伤为主时只报人数；有重伤就把重伤人数摆出来，不形容伤势程度。
export const INJURY_TITLE: ((rl: string, n: number, major: number) => string)[] = [
  (rl, n, major) => `${rl}伤情：${n} 人受伤${major > 0 ? `，含 ${major} 人重伤` : ""}`,
  (rl, n, major) => `${rl}伤情通报，${n} 人进入伤停名单${major > 0 ? `（重伤 ${major} 人）` : ""}`,
  (rl, n, major) => `${n} 人在 ${rl}受伤${major > 0 ? `，其中 ${major} 人伤得不轻` : ""}`,
  (rl, n, major) => `${rl}打完，${n} 人挂彩${major > 0 ? `，${major} 人伤势较重` : ""}`,
  (rl, n, major) => `${rl}｜新增伤员 ${n} 人${major > 0 ? `，重伤 ${major} 人` : ""}`,
  (rl, n, major) => `${rl}的代价：${n} 人伤停${major > 0 ? `，${major} 人短期难回` : ""}`,
  (rl, n, major) => `${rl}伤退 ${n} 人${major > 0 ? `，重伤 ${major} 人` : ""}`,
];

// ---------- 战报剧情句（背景块 2.5 节）：本场戏剧性一句话，最多命中 1 句 ----------
// 优先级：大逆转 > 绝杀 > 小逆转 > 红牌顶住 > 红牌崩盘 > 点球决胜 > 一人扛队 > 乌龙定胜负；
// 每槽独立 chance(RATES.reportDrama)，条件满足不一定触发
export interface ReportDramaCtx extends CopyCtx {
  redTeamName?: string | null;
}

export const REPORT_DRAMA = {
  comebackBig: [
    (c: ReportDramaCtx) => `${c.winnerName ?? "赢球的一方"} 是从两球落后的坑里爬出来的。`,
    (c: ReportDramaCtx) => `两球落后都能翻回来，${c.winnerName ?? "赢球的一方"} 这场赢得够硬。`,
    (c: ReportDramaCtx) => `对 ${c.loserName ?? "对手"} 来说，两球的领先没能守住。`,
    () => "先丢两球再连着追回来，这场逆转值得记一笔。",
    () => "落后两球的时候，很少有人想到结局会是这样。",
    (c: ReportDramaCtx) => `${c.scoreLine} 的比分背后，是一次两球的翻盘。`,
  ],
  lateWinner: [
    (c: ReportDramaCtx) => `胜负在最后关头才定，${c.winnerName ?? "赢球的一方"} 打进了最值钱的一球。`,
    () => "比赛最后阶段的那粒进球，直接决定了归属。",
    (c: ReportDramaCtx) => `${c.winnerName ?? "赢球的一方"} 一直踢到最后一刻，才拿到回报。`,
    (c: ReportDramaCtx) => `最后时刻丢球最伤士气，${c.loserName ?? "对手"} 这次体会到了。`,
    () => "悬念保持到终场前，被一粒进球终结。",
    (c: ReportDramaCtx) => `眼看要收场，${c.winnerName ?? "赢球的一方"} 补上了最后一击。`,
  ],
  comebackSmall: [
    () => "先丢一球，后连本带利赢了回来。",
    (c: ReportDramaCtx) => `先丢一球再赢回来，${c.winnerName ?? "赢球的一方"} 的韧性够用。`,
    (c: ReportDramaCtx) => `丢球没有打乱 ${c.winnerName ?? "赢球的一方"} 的节奏。`,
    (c: ReportDramaCtx) => `一球落后不是终点，${c.winnerName ?? "赢球的一方"} 证明了这一点。`,
    (c: ReportDramaCtx) => `${c.loserName ?? "对手"} 的领先没保持到最后。`,
    (c: ReportDramaCtx) => `先失一球，后反超比分，${c.scoreLine} 是这么来的。`,
  ],
  redHeld: [
    (c: ReportDramaCtx) => `${c.redTeamName ?? "少一人的一方"} 少一人作战，还是把局面顶了下来。`,
    (c: ReportDramaCtx) => `少一个人的情况下，${c.redTeamName ?? "他们"} 没有乱。`,
    (c: ReportDramaCtx) => `红牌之后阵型收紧，${c.redTeamName ?? "他们"} 把该拿的结果守住了。`,
    (c: ReportDramaCtx) => `十个人踢完了大半场，${c.redTeamName ?? "他们"} 没让人数差变成比分差。`,
    (c: ReportDramaCtx) => `少一人反而踢得更专注，这是 ${c.redTeamName ?? "他们"} 今天值得肯定的地方。`,
    (c: ReportDramaCtx) => `红牌是考验，${c.redTeamName ?? "他们"} 顶住了。`,
  ],
  redFell: [
    (c: ReportDramaCtx) => `那张红牌成了转折，${c.redTeamName ?? "少一人的一方"} 之后再没稳住。`,
    (c: ReportDramaCtx) => `少一人之后，${c.redTeamName ?? "他们"} 的防线一点点被拉开。`,
    (c: ReportDramaCtx) => `红牌打乱了部署，${c.redTeamName ?? "他们"} 再没能组织起像样的反扑。`,
    () => "人数劣势，最终体现在了比分上。",
    () => `十一个人对十个人的账，最后算进了比分。`,
    (c: ReportDramaCtx) => `红牌之后，${c.redTeamName ?? "他们"} 越踢越被动。`,
  ],
  pen: [
    () => "全场的胜负，最后压在了点球上。",
    () => "一场比赛的决定权，交给了十二码。",
    () => "点球这种事，进了是功臣，不进只能怪运气。",
    () => "十二码前的得失，左右了整场比赛的走向。",
    () => "一脚点球，把整场的紧张推到了顶。",
    () => "胜负的答案，写在了十二码上。",
  ],
  soloAct: [
    (c: ReportDramaCtx) => `${c.heroName ?? "他"} 一个人包办了全队的进球。`,
    (c: ReportDramaCtx) => `这场的进球账，全记在 ${c.heroName ?? "一个人"} 名下。`,
    (c: ReportDramaCtx) => `球队 ${c.scoreLine} 的进球，全部出自 ${c.heroName ?? "他"} 一人。`,
    () => "一个人的火力，就是全队的火力。",
    (c: ReportDramaCtx) => `${c.heroName ?? "他"} 一脚一脚，把比赛踢成了个人表演。`,
    (c: ReportDramaCtx) => `全队的进攻，今天都通向 ${c.heroName ?? "同一个人"}。`,
  ],
  ogDecider: [
    () => "决定胜负的一球，来自对面的失误。",
    (c: ReportDramaCtx) => `${c.winnerName ?? "赢球的一方"} 的制胜球，是对面送的。`,
    () => "进球有功劳也有运气，这场的制胜球属于后者。",
    () => "胜负之间，隔着一个乌龙球。",
    () => "谁也没想到，定下胜负的是那样一个球。",
    (c: ReportDramaCtx) => `${c.scoreLine}，制胜球是个乌龙。`,
  ],
};

export function pickReportDrama(seed: string, facts: MatchFacts, c: ReportDramaCtx): string | null {
  const tryKind = (kind: keyof typeof REPORT_DRAMA, ok: boolean): string | null => {
    if (!ok || !chance(`${seed}:${kind}`, RATES.reportDrama)) return null;
    const t = pickText(`${seed}:${kind}`, REPORT_DRAMA[kind]);
    return typeof t === "function" ? t(c) : t;
  };
  return (
    tryKind("comebackBig", facts.comeback === "big") ??
    tryKind("lateWinner", facts.lateWinner) ??
    tryKind("comebackSmall", facts.comeback === "small") ??
    tryKind("redHeld", facts.redTurn?.outcome === "improved" || facts.redTurn?.outcome === "held") ??
    tryKind("redFell", facts.redTurn?.outcome === "collapsed" || facts.redTurn?.outcome === "faded") ??
    tryKind("pen", facts.penDecider || facts.penMissSwing) ??
    tryKind("soloAct", facts.soloAct != null) ??
    tryKind("ogDecider", facts.ogDecider)
  );
}