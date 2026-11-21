// 进球方式 / 助攻方式词库与组合句：docs/news-method-copybank.md §2/§3/§4 的逐字转录（含修辞条与短形）。
// 方式词枚举与中文标签的真源在 shared/methods.ts（worker 校验与前端下拉共用）；本文件只管
// 把已录入的方式词渲染成句子：池子、组合专表、通用 fallback、红线正则。
// 铁律（copybank §0）：pickText(hash(matchId, eventId, poolKey), pool) 确定性选取，禁 Math.random；
// 每池 ≥6 全形（修辞 ≤2）+ 2 短形（≤12 字）；片段不含分钟（分钟由调用方拼「第 X 分钟」）；
// 插槽 {A}=助攻人、{P}=进球人、{T}=进球方队伍；pen_goal / own_goal 不进这套池。
import { pickText } from "../../shared/textpick";
import type { AssistMethod, GoalMethod } from "../../shared/methods";

export interface MethodPool {
  // 全形：可直接渲染的完整片段（含 ≤2 条修辞），≥6 条
  full: readonly string[];
  // 短形：无插槽（≤12 字），供组合截短、跑马灯、比分条复用
  short: readonly string[];
}

// ---------- §2 进球方式池（`method`，14 词，逐字转录） ----------
export const METHOD_POOLS: Record<GoalMethod, MethodPool> = {
  long_shot: {
    short: ["远射破门", "30 米外起脚"],
    full: [
      "{P} 30 米外起脚，球轰入死角",
      "{P} 突施冷箭，球应声入网",
      "{P} 在禁区外沿直接起脚，球贴地钻进死角",
      "{P} 远射，球带着弧线绕过人群",
      "防线退得太深，{P} 在外沿一步空间里直接轰门",
      "{P} 退到弧顶，直接抽射破门",
      "{P} 拿球调整一步，远射破门",
    ],
  },
  curler: {
    short: ["兜射远角", "内脚背一兜"],
    full: [
      "{P} 内脚背一兜，球划着弧线钻进死角",
      "{P} 禁区外沿兜出一道弧线，球绕过人群入网",
      "{P} 不发死力，脚腕一抖，球兜着弧线挂向远角",
      "{P} 横向一拨让开角度，内脚背兜射远角",
      "{P} 的兜射带着弧线，球听话地拐进网窝",
      "{P} 侧身兜出一脚，球贴着远门柱入网",
      // 修辞
      "这球不是抽的，是兜的——{P} 懂弧线",
    ],
  },
  drive: {
    short: ["劲射上角", "禁区内爆射"],
    full: [
      "{P} 近距离爆射，打得毫不讲理",
      "{P} 势大力沉的一脚，球砸进网窝",
      "球到 {P} 脚下没有停顿，一脚劲射入网",
      "{P} 禁区里一脚发力的爆射",
      "{P} 一步趟开角度，抽射近角",
      "{P} 起脚就是全力，抽射入网",
    ],
  },
  header: {
    short: ["头槌破网", "高高跃起顶进"],
    full: [
      "{P} 高高跃起，把球顶进",
      "{P} 头槌破网",
      "{P} 抢在防守身前一头顶进",
      "球飞到门前，{P} 甩头一顶",
      "{P} 力压后卫，头球直挂死角",
      "{P} 飞身冲顶，把球砸进网窝",
      // 修辞
      "{P} 起跳的高度就是优势",
    ],
  },
  volley: {
    short: ["凌空抽射", "凌空挂死角"],
    full: [
      "{P} 不等球落地，凌空抽射挂死角",
      "{P} 侧身凌空，球窜向后角",
      "半高球落在 {P} 身前，他直接抡了",
      "{P} 凌空垫射，球贴地窜进网窝",
      "球从空中划过，{P} 迎上去就是一脚",
      "{P} 一脚凌空，球应声入网",
    ],
  },
  chip: {
    short: ["轻轻一挑", "吊过门将"],
    full: [
      "{P} 轻轻一挑，越过出击的门将",
      "{P} 看到门将站位靠前，把球送过他的头顶",
      "{P} 挑射破门，球从门将头顶落进网里",
      "{P} 脚背一搓，球越过门将落进网里",
      "{P} 面对出击，轻巧地挑过门将",
      // 修辞
      "一记四两拨千斤，{P} 打的",
    ],
  },
  tap_in: {
    short: ["门前捅进", "推进空门"],
    full: [
      "{P} 门前捅进",
      "{P} 近距离推射入网",
      "球滚到门前，{P} 跟上一脚推进",
      "{P} 门前后点跟上，一脚推进死角",
      "门前二点，{P} 先一步出脚",
      "{P} 没浪费门前机会，推进死角",
    ],
  },
  rebound: {
    short: ["跟进补一脚", "二点补进"],
    full: [
      "门将扑出，{P} 跟进补一脚",
      "{P} 二点反应最快，补射入网",
      "第一下被挡，{P} 跟上补进",
      "球弹回门前，{P} 不客气地补进",
      "{P} 补射得手，二点包抄到位",
      "{P} 门线前补上一脚，球进了",
    ],
  },
  one_on_one: {
    short: ["单刀推过门将", "单刀推远角"],
    full: [
      "{P} 单刀赴会，冷静推过门将",
      "单刀机会，{P} 没有脚软",
      "{P} 单刀面对门将，推射入网",
      "{P} 拿到单刀，处理得干脆",
      "{P} 突入禁区形成单刀，一脚定音",
      "{P} 单刀直入，趟一步推远角",
    ],
  },
  free_kick: {
    short: ["圆月弯刀", "任意球直挂死角"],
    full: [
      "{P} 圆月弯刀，任意球直接破门",
      "{P} 主罚的任意球绕过人墙，直挂死角",
      "{P} 任意球重炮，球从人墙上方越过",
      "{P} 一脚精确制导的任意球",
      "{P} 的任意球从人墙缝隙里钻过去",
      "{P} 任意球打门，球速快得离谱",
      // 修辞
      "{P} 站在球前，所有人都知道他要打，还是进了",
    ],
  },
  counter: {
    short: ["反击一锤定音", "由守转攻打进"],
    full: [
      "{P} 三传两递打进反击，{T} 由守转攻很干脆",
      "反击一气呵成，{P} 完成最后一击",
      "{P} 反击中推射空当，防守回追不及",
      "{T} 打穿转换，{P} 一锤定音",
      "防线压上没回位，{P} 推进死角",
      // 修辞
      "{P} 在转换里完成终结，防守只来得及回头看",
    ],
  },
  solo: {
    short: ["单骑闯关", "一条龙破门"],
    full: [
      "{P} 自己带到底自己解决，一条龙破门",
      "{P} 中场开始的一条龙，连过数人后起脚",
      "{P} 单骑闯关，把球带进大门",
      "{P} 拿球、带球、射门，全程自己来",
      "{P} 长驱直入，一路带到门前",
      "{P} 一条龙杀进禁区，最后一脚精彩终结",
    ],
  },
  first_time: {
    short: ["不停球直接打门", "迎球怒射"],
    full: [
      "{P} 不停球直接打门，一脚出球直挂死角",
      "球到 {P} 脚下没有停顿，直接打门",
      "{P} 迎球怒射，打得干脆",
      "{P} 一次触球完成终结",
      "{P} 第一时间起脚，角度打得极刁",
      "{P} 半转身不停球直接打，球窜向后角",
    ],
  },
  turn_shot: {
    short: ["转身抽射", "背身转身一脚"],
    full: [
      "{P} 背身拿球转身抽射，直挂死角",
      "{P} 转身摆脱防守，抽射入网",
      "{P} 半转身发力，球贴地窜进死角",
      "{P} 转身就是一脚，打得坚决",
      "{P} 护住球转身，小角度也打得进",
      "{P} 背身扛住防守，转身抽近角",
    ],
  },
};

// ---------- §3 助攻方式池（`assist_method`，13 词，逐字转录） ----------
export const ASSIST_POOLS: Record<AssistMethod, MethodPool> = {
  cross_45: {
    short: ["45 度起球", "45 度吊禁区"],
    full: [
      "{A} 45 度起球，落点找到人",
      "{A} 的 45 度传中越过防守，落向后点",
      "{A} 45 度吊进禁区，弧线又低又平",
      "{A} 45 度横向转移后起球，宽度用足了",
      "{A} 的 45 度传中又飘又准，抢点的舒服",
      // 修辞
      "小高球！张路指导说这是最好传的球——{A} 传出来了",
    ],
  },
  cross_byline: {
    short: ["下底传中", "底线起球"],
    full: [
      "{A} 底线上挑到门前",
      "{A} 下底传中，球带着旋转找后点",
      "{A} 贴着底线把球带到底，起球到门前",
      "{A} 下底后传中，球速又快又平",
      "{A} 底线前最后一脚传中，落点还是找后点",
      "{A} 奔着底线去，起球找门前",
    ],
  },
  through_ball: {
    short: ["直塞穿透防线", "直传身后"],
    full: [
      "{A} 直塞穿透两层防线",
      "{A} 一脚直传打穿防线，时机正好",
      "{A} 手术刀直塞，防线瞬间裂开",
      "{A} 的直塞正好送到跑动线路上",
      "{A} 直传身后，防线转身都来不及",
      "{A} 塞了一脚防线中间的空当",
    ],
  },
  long_pass: {
    short: ["对角线长传", "长传找到前插"],
    full: [
      "{A} 对角线长传找到人",
      "{A} 长传转移，落点精准",
      "{A} 一脚跨越半场的调度",
      "{A} 的长传直接找到前插的队友",
      "{A} 视野开阔，防线整体移动之前球已经到了",
      "{A} 一记转移长传，进攻换个方向打",
    ],
  },
  lofted_pass: {
    short: ["过顶球越防线", "挑传身后"],
    full: [
      "{A} 过顶球越过整条防线",
      "{A} 挑传防线身后，球落下时防守还没转身",
      "防线压上的一瞬，{A} 的过顶球从头顶越过",
      "{A} 一记挑传，落点拿捏得刚好",
      "{A} 把球兜过防线，前锋只要跑对路线",
      "{A} 过顶球给得舒服，剩下的就是跑",
    ],
  },
  cutback: {
    short: ["倒三角回敲", "回敲禁区弧顶"],
    full: [
      "{A} 底线倒三角回敲",
      "{A} 带到底线，倒三角回传",
      "{A} 回敲到禁区弧顶",
      "{A} 底线不贪功，回敲中路",
      "{A} 倒三角，把防守整条线让给了弧顶",
      // 修辞
      "{A} 倒三角传球，防守全在门前，没人看弧顶",
    ],
  },
  give_and_go: {
    short: ["二过一撞穿防线", "撞墙做球"],
    full: [
      "{A} 二过一撞进禁区",
      "{A} 撞墙配合，一脚出球要回传球",
      "{A} 与队友二过一，把防线甩在身后",
      "{A} 一磕一回，防线跟着球走散了",
      "{A} 的撞墙配合撕开中路",
      // 修辞
      "{A} 一磕一回，防线在二过一里散了架",
    ],
  },
  dribble_pass: {
    short: ["突破后分球", "突到底线横传"],
    full: [
      "{A} 带球撕开防线后分出",
      "{A} 突破两人后传球，牵走了防守重心",
      "{A} 盘带搅乱阵型，最后一传致命",
      "{A} 突到底线前横传门前",
      "{A} 连过两人再分球，防守全被他带走",
      "{A} 突进去再横敲，防线两头都顾不上",
    ],
  },
  set_piece: {
    short: ["定位球做球", "战术做球"],
    full: [
      "{A} 战术任意球轻轻一拨",
      "{A} 短传做球，配合打得聪明",
      "{A} 战术定位球做球，配合按剧本走",
      "{A} 一拨一传，把球做到位",
      "{A} 定位球做球，直接送到射门位置",
      // 修辞
      "{A} 把定位球当阵地战打",
    ],
  },
  corner_kick: {
    short: ["角球开到后点", "角球起球"],
    full: [
      "{A} 角球开到后点",
      "{A} 的角球绕过前点，落点极佳",
      "{A} 角球起球，把球直接送进危险区域",
      "{A} 角球起球，门前一片混乱里有人抢到",
      "{A} 的角球又快又平，专找前冲的人",
      "{A} 角球开向前点，抢点的人就在那",
    ],
  },
  free_kick_delivery: {
    short: ["任意球起球", "任意球找后点"],
    full: [
      "{A} 任意球起球到禁区",
      "{A} 主罚的任意球绕过人墙外侧，落向后点",
      "{A} 的任意球弧线找到接应点",
      "{A} 任意球起球，高度正好越过前点",
      "{A} 的任意球给得极深，直接找后门柱",
      "{A} 任意球起球，把球送到禁区深处",
    ],
  },
  backheel: {
    short: ["脚后跟一磕", "背身妙传"],
    full: [
      "{A} 脚后跟一磕，正好落在跑动线路上",
      "{A} 背身用脚后跟做球",
      "{A} 脚后跟妙传，动作小，效果大",
      "{A} 用脚后跟把球磕进禁区",
      "{A} 脚后跟磕球变向，防线重心全在正面",
      // copybank 该池仅 5 句，按铁律补 1 句达 ≥6（事实等价、直说）
      "{A} 用脚后跟把球磕给队友",
    ],
  },
  keeper_launch: {
    short: ["门将长传发动", "大脚开球"],
    full: [
      "门将 {A} 长传直接发动进攻",
      "{A} 大脚开球，球越过整个中场",
      "{A} 的长传让前锋直接面对防线",
      "门将 {A} 一脚长传，把进攻直接送到前场",
      "门将 {A} 的长传越过中场，前场拿球就是机会",
      // copybank 该池仅 5 句，按铁律补 1 句达 ≥6（事实等价、直说）
      "{A} 的大脚开球直接找到前场队友",
    ],
  },
};

// ---------- §4.3 特殊组合专表（19 组，键 `${assist}|${goal}`，未命中走 §4.2 通用规则） ----------
// 组 4：cross_45 / cross_byline × header 两键共用变体（{A} 片段按各自池语义带出）；
// 组 18：rebound × 原射者记助攻——rebound 是进球方式，助攻键不限，用 `*|rebound` 通配；
// 组 17 第 2 变体的「快发一拨」按附录 v3 整组删除（定位球做球不必然快发），按铁律等价改写去快发。
const COMBO_CROSS_HEADER = [
  "{A} 起球到门前，{P} 跃起头槌",
  "{A} 传中找后点，{P} 空中完成终结",
  "{A} 底线上挑，{P} 旱地拔葱顶进",
] as const;

export const METHOD_COMBOS: Record<string, readonly string[]> = {
  // 组 1：through_ball × one_on_one
  "through_ball|one_on_one": [
    "{A} 直塞穿透防线，{P} 单刀赴会，推过门将",
    "{A} 直传身后，{P} 停球一趟就是单刀，推远角",
    "防线被 {A} 一脚撕开，{P} 面对门将没有犹豫",
    "{A} 的直塞分量正好，{P} 单刀推射入网",
  ],
  // 组 2：corner_kick × header
  "corner_kick|header": [
    "{A} 角球开到后点，{P} 高高跃起顶进",
    "{A} 的角球找后点，{P} 力压防守头槌破网",
    "战术角球开出，{P} 在空中完成终结",
    "{A} 起球，{P} 旱地拔葱",
  ],
  // 组 3：free_kick_delivery × header
  "free_kick_delivery|header": [
    "{A} 任意球起球，{P} 头球一点改变方向",
    "{A} 的任意球精确到米，{P} 迎球冲顶",
    "{A} 起球到禁区，{P} 在人群里顶到最高的那个点",
  ],
  // 组 4：cross_45 / cross_byline × header（两键共用变体）
  "cross_45|header": COMBO_CROSS_HEADER,
  "cross_byline|header": COMBO_CROSS_HEADER,
  // 组 5：cutback × first_time
  "cutback|first_time": [
    "{A} 底线倒三角回敲，{P} 不停球直接打门",
    "{A} 回敲，{P} 迎球怒射，防守全在门前没人看弧顶",
    "{A} 倒三角，{P} 一次触球完成终结",
  ],
  // 组 6：cutback × drive
  "cutback|drive": [
    "{A} 倒三角回敲，{P} 禁区外一步劲射上角",
    "{A} 回敲弧顶，{P} 爆射破门",
  ],
  // 组 7：give_and_go × turn_shot
  "give_and_go|turn_shot": [
    "二过一撞穿防线，{P} 转身抽射直挂死角",
    "{A} 撞墙回敲，{P} 背身转身就是一脚",
  ],
  // 组 8：give_and_go × tap_in
  "give_and_go|tap_in": [
    "{A} 撞墙配合推进禁区，{P} 门前捅进",
    "二过一撕开防线，{A} 做球，{P} 推进空门",
  ],
  // 组 9：dribble_pass × tap_in
  "dribble_pass|tap_in": [
    "{A} 突到底线横传，{P} 后点推进空门",
    "{A} 连过两人分球，{P} 门前捅进死角",
  ],
  // 组 10：dribble_pass × drive
  "dribble_pass|drive": [
    "{A} 突破后分球，{P} 劲射上角",
    "{A} 吸走防守再分出，{P} 禁区里一脚爆射",
  ],
  // 组 11：backheel × tap_in
  "backheel|tap_in": [
    "{A} 脚后跟一磕，{P} 门前捅进死角",
    "{A} 背身妙传，{P} 近距离推进死角",
  ],
  // 组 12：keeper_launch × counter（句首「门将 {A}」）
  "keeper_launch|counter": [
    "门将 {A} 长传发动，{T} 三传两递，{P} 完成终结",
    "{A} 大脚开球，反击一气呵成，{P} 一锤定音",
  ],
  // 组 13：lofted_pass × one_on_one
  "lofted_pass|one_on_one": [
    "{A} 过顶球越过防线，{P} 落地就是单刀，推射入网",
    "{A} 挑传身后，{P} 停球一趟，单刀直入",
  ],
  // 组 14：lofted_pass × volley
  "lofted_pass|volley": [
    "{A} 过顶挑传，{P} 不等球落地直接抽",
    "{A} 的挑传落点正好，{P} 凌空一脚",
  ],
  // 组 15：long_pass × one_on_one
  "long_pass|one_on_one": [
    "{A} 长传找到前插，{P} 单刀推远角",
    "{A} 一脚跨越半场，{P} 直接面对门将",
  ],
  // 组 16：set_piece × long_shot
  "set_piece|long_shot": [
    "战术任意球一拨，{P} 禁区外轰开大门",
    "{A} 做球，{P} 禁区外迎球怒射",
  ],
  // 组 17：set_piece × drive（第 2 变体原文「快发一拨」已按附录 v3 删除）
  "set_piece|drive": [
    "战术定位球做出来，{P} 劲射上角",
    "{A} 一拨做球，{P} 禁区内爆射破门",
  ],
  // 组 18：rebound × 原射者记助攻（§4.1 特例：rebound 默认无助攻，录了助攻即原射者）
  "*|rebound": [
    "{A} 的射门被门将扑出，{P} 跟进补一脚",
    "{A} 第一脚被挡，{P} 二点补进",
  ],
  // 组 19：cutback × curler
  "cutback|curler": [
    "{A} 底线倒三角回敲，{P} 迎球兜射远角",
    "{A} 回敲弧顶，{P} 内脚背兜出弧线",
  ],
};

// ---------- §4.2 通用组合规则（专表未覆盖的搭配） ----------
// 句式：{A} {助攻全形}，{P} {进球全形}；拼接 >34 字时助攻换短形；
// 主语交替：第二片段避免与第一片段同样以人名开头（用无主语变体或 {T} 起头变体）。
export interface MethodSlots {
  A?: string; // 助攻人
  P?: string; // 进球人
  T?: string; // 进球方队伍
}

const GENERIC_MAX_CHARS = 34; // §4.2 截短阈值（字符数，按码点计）

function fill(text: string, s: MethodSlots): string {
  return text
    .replaceAll("{A}", s.A ?? "{A}")
    .replaceAll("{P}", s.P ?? "{P}")
    .replaceAll("{T}", s.T ?? "{T}");
}

export function pickMethodLine(seed: string, method: GoalMethod, slots: MethodSlots = {}): string {
  return fill(pickText(`${seed}:m`, METHOD_POOLS[method].full), slots);
}

export function pickAssistLine(seed: string, method: AssistMethod, slots: MethodSlots = {}): string {
  return fill(pickText(`${seed}:a`, ASSIST_POOLS[method].full), slots);
}

// 组合句入口：无助攻走进球池单句（solo / free_kick / rebound 无助攻时由这里兜住）；
// 有助攻先查专表（含 `*|rebound` 通配），未命中走 §4.2 通用规则
export function pickCombo(
  seed: string,
  assist: AssistMethod | null,
  goal: GoalMethod,
  slots: MethodSlots = {},
): string {
  if (assist == null) return pickMethodLine(seed, goal, slots);
  const combo = METHOD_COMBOS[`${assist}|${goal}`] ?? METHOD_COMBOS[`*|${goal}`];
  if (combo) return fill(pickText(`${seed}:c`, combo), slots);

  const aFull = pickText(`${seed}:a`, ASSIST_POOLS[assist].full);
  let gFull = pickText(`${seed}:g`, METHOD_POOLS[goal].full);
  // 主语交替（§4.2）：第一片段以人名（{A}）开头时，第二片段避免同样以人名（{P}）开头——
  // 优先池内不以 {P} 开头的全形；池内全是 {P} 开头时保留原选（{P} 名字不能丢，归属优先于错落）
  if (aFull.startsWith("{A}") && gFull.startsWith("{P}")) {
    const alts = METHOD_POOLS[goal].full.filter((v) => !v.startsWith("{P}"));
    if (alts.length > 0) gFull = pickText(`${seed}:g2`, alts);
  }
  // 截短（§4.2）：两句拼接 >34 字时，助攻换短形（短形无插槽，人名前缀保留）
  let aLine = aFull;
  if ([...`${aFull}，${gFull}`].length > GENERIC_MAX_CHARS) {
    aLine = `{A} ${pickText(`${seed}:as`, ASSIST_POOLS[assist].short)}`;
  }
  return fill(`${aLine}，${gFull}`, slots);
}

// 红线词正则（copybank §0 之 8、§6 与附录 v2 清理记录）：不替对方编失败动作——
// 门将怎么扑、往哪扑、扑没扑到，防守怎么想、有没有反应过来，没被记录的反应一律不写。
// 供测试对 METHOD_POOLS / ASSIST_POOLS / METHOD_COMBOS 做零命中扫描；合法保留的是
// 词义断言的对方窘态（防线转身都来不及/回追不及/没人看弧顶/防守还没转身）与球路画面。
export const RED_LINE_RE =
  /扑错方向|站着没动|来不及移动|没反应过来|没想到|扑了个空|扑了个寂寞|扑到也按不住|脱手|没法扑|扑不到|不敢出击|门将已经尽力|以为他要回传|背对球门|不知道球在哪/;
