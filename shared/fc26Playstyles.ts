// FC26 PlayStyle 徽章参照表（73 项）——冻结自俱乐部平台的真源：
//   WHL-club-operations-platform/web/assets/ref/playstyle.json（2026-10-07 取的快照）
// 为什么冻结成本仓 TS 常量而不是运行时拉 club：战术页要在候选球员旁边立刻画出徽章 chip
// （「这人有死球 +，定位球该给他罚」），为一张 73 行的静态表多打一次跨仓请求不值得；
// 而且这张表只随游戏版本换代，冻结后两侧漂移的风险用一条测试钉住（tests/playstyles.test.ts）。
//
// id 口径（与 club 侧 src/core/fc26.ts 逐字同源）：
//   1-99   银徽的基础段（每类技能的裸名，如 4 = Dead Ball）
//   101+   金徽（= 基础 id + 100，如 104 = Dead Ball +）；100 是空档，两侧都没用
//   tier 判据就是「psid >= 101」——用 JSON 的 type 字段核对过：type 只区分技能大类
//   （Finishing/Passing/Defending/Ballcontrol/Physical/Goalkeeper），不区分金银，
//   金银成对项的 type 与 en/ chs 前缀完全一致（测试逐项钉住）。
// 0 号是「无徽章」占位（en/chs 都是 "-"），保留只是为了照抄原表，取数时当没名字处理。

export type PlaystyleType =
  | "None"
  | "Finishing"
  | "Passing"
  | "Defending"
  | "Ballcontrol"
  | "Physical"
  | "Goalkeeper";

export interface Fc26Playstyle {
  id: number;
  en: string;
  chs: string;
  type: PlaystyleType;
}

/** 金徽分界：>= 101 是金徽（基础 id + 100） */
export const PLAYSTYLE_GOLD_MIN = 101;

export const FC26_PLAYSTYLES: readonly Fc26Playstyle[] = [
  { id: 0, en: "-", chs: "-", type: "None" },
  { id: 1, en: "Finesse Shot", chs: "精准搓射", type: "Finishing" },
  { id: 2, en: "Chip Shot", chs: "吊射", type: "Finishing" },
  { id: 3, en: "Power Shot", chs: "大力射门", type: "Finishing" },
  { id: 4, en: "Dead Ball", chs: "死球", type: "Finishing" },
  { id: 5, en: "Precision Header", chs: "精准头球", type: "Finishing" },
  { id: 6, en: "Acrobatic", chs: "杂耍", type: "Finishing" },
  { id: 7, en: "Low Driven Shot", chs: "低射", type: "Finishing" },
  { id: 8, en: "Gamechanger", chs: "破局者", type: "Finishing" },
  { id: 11, en: "Incisive Pass", chs: "精准直塞", type: "Passing" },
  { id: 12, en: "Pinged Pass", chs: "大力短传", type: "Passing" },
  { id: 13, en: "Long Ball Pass", chs: "长传", type: "Passing" },
  { id: 14, en: "Tiki Taka", chs: "Tiki Taka", type: "Passing" },
  { id: 15, en: "Whipped Pass", chs: "快速传中", type: "Passing" },
  { id: 16, en: "Inventive", chs: "别出心裁", type: "Passing" },
  { id: 21, en: "Jockey", chs: "跟防", type: "Defending" },
  { id: 22, en: "Block", chs: "封堵", type: "Defending" },
  { id: 23, en: "Intercept", chs: "拦截", type: "Defending" },
  { id: 24, en: "Anticipate", chs: "预判", type: "Defending" },
  { id: 25, en: "Slide Tackle", chs: "铲球", type: "Defending" },
  { id: 26, en: "Aerial Fortress", chs: "空中堡垒", type: "Defending" },
  { id: 31, en: "Technical", chs: "技术", type: "Ballcontrol" },
  { id: 32, en: "Rapid", chs: "灵动迅捷", type: "Ballcontrol" },
  { id: 33, en: "First Touch", chs: "第一脚触球", type: "Ballcontrol" },
  { id: 34, en: "Trickster", chs: "诡术师", type: "Ballcontrol" },
  { id: 35, en: "Press Proven", chs: "紧逼好手", type: "Ballcontrol" },
  { id: 41, en: "Quick Step", chs: "健步如飞", type: "Physical" },
  { id: 42, en: "Relentless", chs: "坚持不懈", type: "Physical" },
  { id: 43, en: "Long Throw", chs: "远距离界外球", type: "Physical" },
  { id: 44, en: "Bruiser", chs: "斗士", type: "Physical" },
  { id: 45, en: "Enforcer", chs: "执行者", type: "Physical" },
  { id: 51, en: "Far Throw", chs: "远距离抛球(GK)", type: "Goalkeeper" },
  { id: 52, en: "Footwork", chs: "步法(GK)", type: "Goalkeeper" },
  { id: 53, en: "Cross Claimer", chs: "传中没收者(GK)", type: "Goalkeeper" },
  { id: 54, en: "Rush Out", chs: "一对一紧逼(GK)", type: "Goalkeeper" },
  { id: 55, en: "Far Reach", chs: "远距离出击(GK)", type: "Goalkeeper" },
  { id: 56, en: "Deflector", chs: "快速反应(GK)", type: "Goalkeeper" },
  { id: 101, en: "Finesse Shot +", chs: "精准搓射 +", type: "Finishing" },
  { id: 102, en: "Chip Shot +", chs: "吊射 +", type: "Finishing" },
  { id: 103, en: "Power Shot +", chs: "大力射门 +", type: "Finishing" },
  { id: 104, en: "Dead Ball +", chs: "死球 +", type: "Finishing" },
  { id: 105, en: "Precision Header +", chs: "精准头球 +", type: "Finishing" },
  { id: 106, en: "Acrobatic +", chs: "杂耍 +", type: "Finishing" },
  { id: 107, en: "Low Driven Shot +", chs: "低射 +", type: "Finishing" },
  { id: 108, en: "Gamechanger +", chs: "破局者 +", type: "Finishing" },
  { id: 111, en: "Incisive Pass +", chs: "精准直塞 +", type: "Passing" },
  { id: 112, en: "Pinged Pass +", chs: "大力短传 +", type: "Passing" },
  { id: 113, en: "Long Ball Pass +", chs: "长传 +", type: "Passing" },
  { id: 114, en: "Tiki Taka +", chs: "Tiki Taka +", type: "Passing" },
  { id: 115, en: "Whipped Pass +", chs: "快速传中 +", type: "Passing" },
  { id: 116, en: "Inventive +", chs: "别出心裁 +", type: "Passing" },
  { id: 121, en: "Jockey +", chs: "跟防 +", type: "Defending" },
  { id: 122, en: "Block +", chs: "封堵 +", type: "Defending" },
  { id: 123, en: "Intercept +", chs: "拦截 +", type: "Defending" },
  { id: 124, en: "Anticipate +", chs: "预判 +", type: "Defending" },
  { id: 125, en: "Slide Tackle +", chs: "铲球 +", type: "Defending" },
  { id: 126, en: "Aerial Fortress +", chs: "空中堡垒 +", type: "Defending" },
  { id: 131, en: "Technical +", chs: "技术 +", type: "Ballcontrol" },
  { id: 132, en: "Rapid +", chs: "灵动迅捷 +", type: "Ballcontrol" },
  { id: 133, en: "First Touch +", chs: "第一脚触球 +", type: "Ballcontrol" },
  { id: 134, en: "Trickster +", chs: "诡术师 +", type: "Ballcontrol" },
  { id: 135, en: "Press Proven +", chs: "紧逼好手 +", type: "Ballcontrol" },
  { id: 141, en: "Quick Step +", chs: "健步如飞 +", type: "Physical" },
  { id: 142, en: "Relentless +", chs: "坚持不懈 +", type: "Physical" },
  { id: 143, en: "Long Throw +", chs: "远距离界外球 +", type: "Physical" },
  { id: 144, en: "Bruiser +", chs: "斗士 +", type: "Physical" },
  { id: 145, en: "Enforcer +", chs: "执行者 +", type: "Physical" },
  { id: 151, en: "Far Throw +", chs: "远距离抛球(GK) +", type: "Goalkeeper" },
  { id: 152, en: "Footwork +", chs: "步法(GK) +", type: "Goalkeeper" },
  { id: 153, en: "Cross Claimer +", chs: "传中没收者(GK) +", type: "Goalkeeper" },
  { id: 154, en: "Rush Out +", chs: "一对一紧逼(GK) +", type: "Goalkeeper" },
  { id: 155, en: "Far Reach +", chs: "远距离出击(GK) +", type: "Goalkeeper" },
  { id: 156, en: "Deflector +", chs: "快速反应(GK) +", type: "Goalkeeper" },
];

const BY_ID = new Map<number, Fc26Playstyle>(FC26_PLAYSTYLES.map((p) => [p.id, p]));

export type PlaystyleTier = "gold" | "silver";

/** 金 / 银判据：psid >= 101 为金（= 基础 id + 100），其余为银 */
export function playstyleTier(psid: number): PlaystyleTier {
  return psid >= PLAYSTYLE_GOLD_MIN ? "gold" : "silver";
}

/**
 * psid → 展示名与金银档；表里没有的 id 返回 null（别硬编「PS 123」这种占位，UI 会照画）。
 * 银金两侧是同一技能的两档，中文名的差别只有结尾的「 +」。
 */
export function getPlaystyle(
  psid: number,
): { en: string; chs: string; tier: PlaystyleTier } | null {
  const hit = BY_ID.get(psid);
  if (!hit || psid === 0) return null;
  return { en: hit.en, chs: hit.chs, tier: playstyleTier(psid) };
}

// ── 战术指派要用的三枚徽章（psid 取自上面这张表，别在别处再写数字）──────
/** 死球（银 4 / 金 104）：任意球与点球主罚的看家徽章 */
export const PS_DEADBALL = 4;
/** 精准头球（银 5 / 金 105）：角球抢点与被用户口径称「强力头球」的那一枚 */
export const PS_PRECISION_HEADER = 5;
/** 空中堡垒（银 26 / 金 126）：角球防守的制空徽章 */
export const PS_AERIAL_FORTRESS = 26;

/**
 * 球员是否拥有某枚徽章：银段与金段任一命中都算（金徽 id = 基础 psid + 100）。
 * 战术页只关心「有没有」，不关心银还是金（分段在 chip 的配色里由 getPlaystyle 决定）。
 */
export function hasPlaystyle(
  playstyles: readonly number[] | null | undefined,
  basePsid: number,
): boolean {
  if (!playstyles || playstyles.length === 0) return false;
  return playstyles.includes(basePsid) || playstyles.includes(basePsid + 100);
}
