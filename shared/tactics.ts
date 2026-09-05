// FC26/FC25 战术码编解码器与数据表。
// 迁移自战术板助手 v1（提取自 futbin.com eaCodeEncoder，FC26/FC27 完全一致）。
// 战术码自包含全部信息（阵型/组织风格/防线高度/11 个首发角色），
// 远期「在线提交战术阵容」时后端可用 decodeFut26 校验码合法性。

export type Buildup = "balanced" | "counter" | "shortpassing";

export interface FormSlot {
  lid: number;
  position: string;
}

export interface FormDef {
  value: string;
  eaId: number;
  disp: string;
  pos: FormSlot[];
}

export interface Pair {
  role: string;
  focus: string;
}

export interface PteEntry {
  role: string;
  focus: string;
  eaId: number;
  vct: number | null;
}

export type PteMap = Record<string, PteEntry[]>;

export interface Slot26 extends FormSlot, Pair {
  eaId: number;
}

export interface Slot25 extends FormSlot, Pair {
  raw: string;
}

export interface Decoded26 {
  year: 26;
  form: string;
  bu: Buildup;
  lh: number;
  slots: Slot26[];
}

export interface Decoded25 {
  year: 25;
  form: string;
  bu: Buildup;
  lh: number;
  slots: Slot25[];
}

export type TacticState = {
  form: string;
  bu: Buildup;
  lh: number;
  roles: Record<number, [string, string]>;
};

export class TacticError extends Error {
  kind:
    | "len"
    | "char"
    | "checksum"
    | "formation"
    | "buildup"
    | "lh"
    | "player";
  at?: number;
  want?: number | string;
  got?: number;
  val?: number;
  pos?: string;
  eaId?: number;
  role?: string;
  focus?: string;

  constructor(
    kind: TacticError["kind"],
    extra: Partial<Omit<TacticError, "kind" | "message">> = {},
  ) {
    super(kind);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const ROT26 = [7, 2, 31, 5, 29, 11, 23, 13, 17, 3, 19, 1];
const ROT25 = [7, 2, 31, 5, 29, 11, 23, 13, 17, 3, 19];
const ALPHA =
  "&123456789?@ABCDEFGH#JKLMN%PQRSTUVWXYZabcdefghijk$mnopqrstuvwxyz";

export const BU: Record<Buildup, number> = {
  balanced: 0,
  counter: 1,
  shortpassing: 2,
};
export const BU_ZH: Record<Buildup, string> = {
  balanced: "均衡",
  counter: "反击",
  shortpassing: "短传",
};
export const BUILDUPS = Object.keys(BU) as Buildup[];

const LHS: [string, number][] = [
  ["Deep", 25],
  ["Balanced", 50],
  ["High", 70],
  ["Aggressive", 95],
];
export function lhBucket(v: number): number {
  return v <= 30 ? 0 : v <= 59 ? 1 : v <= 89 ? 2 : 3;
}
export function lhName(v: number): string {
  const p = LHS[lhBucket(v)];
  return v === p[1] ? p[0] : `${p[0]}（${v}）`;
}

const DAE_LH = [25, 50, 70, 95];

const FORMS_RAW =
  "3142|22|cardlid11:GK,cardlid10:CB,cardlid9:CB,cardlid8:CB,cardlid5:CDM,cardlid7:RM,cardlid6:CM,cardlid4:CM,cardlid3:LM,cardlid2:ST,cardlid1:ST;3412|23|cardlid11:GK,cardlid10:CB,cardlid9:CB,cardlid8:CB,cardlid7:RM,cardlid6:CM,cardlid5:CM,cardlid4:LM,cardlid2:CAM,cardlid3:ST,cardlid1:ST;3421|24|cardlid11:GK,cardlid10:CB,cardlid9:CB,cardlid8:CB,cardlid7:RM,cardlid6:CM,cardlid5:CM,cardlid4:LM,cardlid3:CAM,cardlid1:CAM,cardlid2:ST;343|25|cardlid11:GK,cardlid10:CB,cardlid9:CB,cardlid8:CB,cardlid7:RM,cardlid6:CM,cardlid5:CM,cardlid4:LM,cardlid3:RW,cardlid2:ST,cardlid1:LW;352|27|cardlid11:GK,cardlid10:CB,cardlid9:CB,cardlid8:CB,cardlid6:CDM,cardlid5:CDM,cardlid7:RM,cardlid4:LM,cardlid2:CAM,cardlid3:ST,cardlid1:ST;41212|14|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:LB,cardlid5:CDM,cardlid6:RM,cardlid4:LM,cardlid2:CAM,cardlid3:ST,cardlid1:ST;41212-2|15|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:LB,cardlid5:CDM,cardlid6:CM,cardlid4:CM,cardlid2:CAM,cardlid3:ST,cardlid1:ST;4132|1|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:LB,cardlid5:CDM,cardlid6:RM,cardlid3:CM,cardlid4:LM,cardlid2:ST,cardlid1:ST;4141|2|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:LB,cardlid6:CDM,cardlid5:RM,cardlid4:CM,cardlid3:CM,cardlid2:LM,cardlid1:ST;4213|36|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:LB,cardlid6:CDM,cardlid5:CDM,cardlid4:CAM,cardlid3:RW,cardlid2:ST,cardlid1:LW;4222|13|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:LB,cardlid6:CDM,cardlid5:CDM,cardlid4:CAM,cardlid3:CAM,cardlid2:ST,cardlid1:ST;4231|3|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:LB,cardlid6:CDM,cardlid5:CDM,cardlid4:CAM,cardlid3:CAM,cardlid2:CAM,cardlid1:ST;4231-2|4|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:LB,cardlid6:CDM,cardlid5:CDM,cardlid4:RM,cardlid2:LM,cardlid3:CAM,cardlid1:ST;424|5|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:LB,cardlid6:CM,cardlid5:CM,cardlid4:RW,cardlid2:ST,cardlid1:ST,cardlid3:LW;4312|6|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:LB,cardlid6:CM,cardlid5:CM,cardlid4:CM,cardlid3:CAM,cardlid2:ST,cardlid1:ST;4321|7|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:LB,cardlid6:CM,cardlid5:CM,cardlid4:CM,cardlid3:CAM,cardlid1:CAM,cardlid2:ST;433|8|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:LB,cardlid6:CM,cardlid5:CM,cardlid4:CM,cardlid3:RW,cardlid2:ST,cardlid1:LW;433-2|9|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:LB,cardlid5:CDM,cardlid6:CM,cardlid4:CM,cardlid3:RW,cardlid2:ST,cardlid1:LW;433-3|10|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:LB,cardlid6:CDM,cardlid4:CDM,cardlid5:CM,cardlid3:RW,cardlid2:ST,cardlid1:LW;433-4|11|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:LB,cardlid6:CM,cardlid4:CM,cardlid5:CAM,cardlid3:RW,cardlid2:ST,cardlid1:LW;4411-2|18|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:LB,cardlid6:RM,cardlid5:CM,cardlid4:CM,cardlid3:LM,cardlid2:CAM,cardlid1:ST;442|16|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:LB,cardlid6:RM,cardlid5:CM,cardlid4:CM,cardlid3:LM,cardlid2:ST,cardlid1:ST;442-2|17|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:LB,cardlid5:CDM,cardlid4:CDM,cardlid6:RM,cardlid3:LM,cardlid2:ST,cardlid1:ST;451|21|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:LB,cardlid6:RM,cardlid4:CM,cardlid2:LM,cardlid5:CAM,cardlid3:CAM,cardlid1:ST;451-2|20|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:LB,cardlid6:RM,cardlid5:CM,cardlid4:CM,cardlid3:CM,cardlid2:LM,cardlid1:ST;5212|29|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:CB,cardlid6:LB,cardlid5:CM,cardlid4:CM,cardlid2:CAM,cardlid3:ST,cardlid1:ST;523|30|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:CB,cardlid6:LB,cardlid5:CM,cardlid4:CM,cardlid3:RW,cardlid2:ST,cardlid1:LW;532|31|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:CB,cardlid6:LB,cardlid4:CDM,cardlid5:CM,cardlid3:CM,cardlid2:ST,cardlid1:ST;541|33|cardlid11:GK,cardlid10:RB,cardlid9:CB,cardlid8:CB,cardlid7:CB,cardlid6:LB,cardlid5:RM,cardlid4:CM,cardlid3:CM,cardlid2:LM,cardlid1:ST";

const PTE26_RAW =
  "GK#GK/Defend=0,GK/Balanced=1,SK/Balanced=2,SK/Build-Up=3,BPK/Build-Up=4|LB#FB/Defend=0,FB/Balanced=1,WB/Balanced=2,WB/Support=3,FAB/Defend=4,FAB/Balanced=5,AWB/Support=6,AWB/Attack=7,FB/Versatile=8,IWB/Build-Up=9,IWB/Attack=10|RB#FB/Defend=0,FB/Balanced=1,WB/Balanced=2,WB/Support=3,FAB/Defend=4,FAB/Balanced=5,AWB/Support=6,AWB/Attack=7,FB/Versatile=8,IWB/Build-Up=9,IWB/Attack=10|CB#D/Defend=0,D/Balanced=1,S/Balanced=2,S/Aggressive=3,BPD/Defend=4,BPD/Build-Up=5,BPD/Aggressive=6,WDB/Defend=7,WDB/Aggressive=8,WDB/Support=9|CDM#CH/Defend=0,H/Defend=1,H/Ball-Winning=2,H/Roaming=3,DLP/Build-Up=4,DLP/Defend=5,DLP/Roaming=6,WH/Defend=7,WH/Build-Up=8,BC/Balanced=9|CM#BTB/Balanced=0,H/Defend=1,H/Ball-Winning=2,DLP/Build-Up=3,DLP/Defend=4,PL/Attack=5,PL/Roaming=6,HW/Attack=7,HW/Balanced=8,BTB/Ball-Winning=9,HW/Support=10|LM#W/Balanced=0,W/Attack=1,WP/Build-Up=2,WP/Attack=3,WM/Support=4,WM/Defend=5,IF/Balanced=6,IF/Attack=7,WM/Build-Up=8|RM#W/Balanced=0,W/Attack=1,WP/Build-Up=2,WP/Attack=3,WM/Support=4,WM/Defend=5,IF/Balanced=6,IF/Attack=7,WM/Build-Up=8|CAM#PL/Build-Up=0,PL/Balanced=1,PL/Roaming=2,SS/Attack=3,HW/Attack=4,HW/Balanced=5,C10/Attack=6,C10/Wide=7,HW/Roaming=8,C10/Versatile=9|LW#IF/Attack=0,IF/Balanced=1,IF/Roaming=2,W/Balanced=3,W/Attack=4,WP/Build-Up=5,WP/Attack=6,W/Versatile=7|RW#IF/Attack=0,IF/Balanced=1,IF/Roaming=2,W/Balanced=3,W/Attack=4,WP/Build-Up=5,WP/Attack=6,W/Versatile=7|ST#TF/Attack=0,TF/Balanced=1,TF/Wide=2,F9/Build-Up=3,PO/Attack=4,PO/Support=5,AF/Attack=6,AF/Support=7,AF/Versatile=8,F9/Attack=9,PO/Versatile=10";

const PTE25_RAW =
  "GK#GK/Defend=0:0,GK/Balanced=1:1,SK/Balanced=2:2,SK/Build-Up=3:3|LB#FB/Defend=0:4,FB/Balanced=1:5,WB/Balanced=2:6,WB/Support=3:7,FAB/Defend=4:8,FAB/Balanced=5:9,AWB/Balanced=6:10,AWB/Attack=7:11|RB#FB/Defend=0:4,FB/Balanced=1:5,WB/Balanced=2:6,WB/Support=3:7,FAB/Defend=4:8,FAB/Balanced=5:9,AWB/Balanced=6:10,AWB/Attack=7:11|CB#D/Defend=0:12,D/Balanced=1:13,S/Balanced=2:14,S/Aggressive=3:15,BPD/Defend=4:16,BPD/Build-Up=5:17,BPD/Aggressive=6:18|CDM#CH/Defend=0:19,H-CDM/Defend=1:20,H-CDM/Ball-Winning=2:21,H-CDM/Roaming=3:22,DLP-CDM/Build-Up=4:23,DLP-CDM/Defend=5:24,DLP-CDM/Roaming=6:25,WH/Defend=7:26,WH/Build-Up=8:27|CM#BTB/Balanced=0:28,H-CM/Defend=1:29,H-CM/Ball-Winning=2:30,DLP-CM/Build-Up=3:31,DLP-CM/Defend=4:32,PL-CM/Attack=5:33,PL-CM/Roaming=6:34,HW/Attack=7:35,HW/Balanced=8:36|LM#W/Balanced=0:37,W/Attack=1:38,WP/Build-Up=2:39,WP/Attack=3:40,WM/Balanced=4:41,WM/Defend=5:42,IF/Balanced=6:43,IF/Attack=7:44|RM#W/Balanced=0:37,W/Attack=1:38,WP/Build-Up=2:39,WP/Attack=3:40,WM/Balanced=4:41,WM/Defend=5:42,IF/Balanced=6:43,IF/Attack=7:44|CAM#PL-CAM/Build-Up=0:45,PL-CAM/Balanced=1:46,PL-CAM/Roaming=2:47,SS/Attack=3:48,HW/Attack=4:49,HW/Balanced=5:50,C10/Attack=6:51,C10/Wide=7:52|LW#IF/Attack=0:53,IF/Balanced=1:54,IF/Roaming=2:55,W/Balanced=3:56,W/Attack=4:57,WP/Build-Up=5:58,WP/Attack=6:59|RW#IF/Attack=0:53,IF/Balanced=1:54,IF/Roaming=2:55,W/Balanced=3:56,W/Attack=4:57,WP/Build-Up=5:58,WP/Attack=6:59|ST#TF/Attack=0:60,TF/Balanced=1:61,TF/Wide=2:62,F9/Build-Up=3:63,PO/Attack=4:64,PO/Support=5:65,AF/Attack=6:66,AF/Support=7:67,AF/Complete=8:68";

const R26_RAW =
  "H-CDM/Defend>H/Defend,H-CDM/Roaming>H/Roaming,H-CDM/Ball-Winning>H/Ball-Winning,H-CM/Defend>H/Defend,H-CM/Ball-Winning>H/Ball-Winning,DLP-CDM/Defend>DLP/Defend,DLP-CDM/Roaming>DLP/Roaming,DLP-CDM/Build-Up>DLP/Build-Up,DLP-CM/Defend>DLP/Defend,DLP-CM/Build-Up>DLP/Build-Up,PL-CM/Attack>PL/Attack,PL-CM/Roaming>PL/Roaming,PL-CAM/Balanced>PL/Balanced,PL-CAM/Roaming>PL/Roaming,PL-CAM/Build-Up>PL/Build-Up,AF/Complete>AF/Versatile,WM/Balanced>WM/Support,AWB/Balanced>AWB/Support";

export const DEFAULT_ROLES: Record<string, string> = {
  GK: "GK/Defend",
  CB: "D/Defend",
  RB: "FB/Balanced",
  LB: "FB/Balanced",
  CDM: "H/Defend",
  CM: "BTB/Balanced",
  LM: "W/Balanced",
  RM: "W/Balanced",
  CAM: "PL/Balanced",
  LW: "W/Balanced",
  RW: "W/Balanced",
  ST: "AF/Attack",
};

export const POS_ZH: Record<string, string> = {
  GK: "门将",
  CB: "中后卫",
  RB: "右边卫",
  LB: "左边卫",
  CDM: "后腰",
  CM: "中前卫",
  RM: "右前卫",
  LM: "左前卫",
  CAM: "前腰",
  RW: "右边锋",
  LW: "左边锋",
  ST: "中锋",
};

const ROLE_FULL: Record<string, string> = {
  GK: "Goalkeeper",
  SK: "Sweeper Keeper",
  BPK: "Ball-Playing Keeper",
  FB: "Fullback",
  WB: "Wingback",
  FAB: "Falseback",
  AWB: "Attacking Wingback",
  IWB: "Inverted Wingback",
  D: "Defender",
  S: "Stopper",
  BPD: "Ball-Playing Defender",
  WDB: "Wide Back",
  CH: "Centre-Half",
  H: "Holding",
  DLP: "Deep-Lying Playmaker",
  WH: "Wide Half",
  BC: "Box Crasher",
  BTB: "Box-to-Box",
  PL: "Playmaker",
  HW: "Half-Winger",
  W: "Winger",
  WP: "Wide Playmaker",
  WM: "Wide Midfielder",
  IF: "Inside Forward",
  SS: "Shadow Striker",
  C10: "Classic 10",
  TF: "Target Forward",
  F9: "False 9",
  PO: "Poacher",
  AF: "Advanced Forward",
};
export function roleFull(r: string): string {
  return ROLE_FULL[r] || r;
}

function dispName(v: string): string {
  const m = v.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return v;
  return (
    m[1].split("").join("-") + (m[2] ? ` (${m[2]})` : "")
  );
}

export const FORMS: FormDef[] = FORMS_RAW.split(";").map((s) => {
  const p = s.split("|");
  return {
    value: p[0],
    eaId: +p[1],
    disp: dispName(p[0]),
    pos: p[2].split(",").map((x) => {
      const q = x.split(":");
      return { lid: +q[0].slice(7), position: q[1] };
    }),
  };
});

function parsePte(raw: string): PteMap {
  const out: PteMap = {};
  for (const g of raw.split("|")) {
    const p = g.split("#");
    const grp: PteEntry[] = [];
    out[p[0]] = grp;
    for (const e of p[1].split(",")) {
      const rf = e.split("=");
      const ef = rf[1].split(":");
      const roles = rf[0].split("/");
      grp.push({
        role: roles[0],
        focus: roles[1],
        eaId: +ef[0],
        vct: ef.length > 1 ? +ef[1] : null,
      });
    }
  }
  return out;
}

export const PTE26: PteMap = parsePte(PTE26_RAW);
export const PTE25: PteMap = parsePte(PTE25_RAW);
export const R26: Record<string, string> = {};
for (const p of R26_RAW.split(",")) {
  const a = p.split(">");
  R26[a[0]] = a[1];
}

function findFormByValue(value: string): FormDef | null {
  return FORMS.find((f) => f.value === value) ?? null;
}
function findFormByEaId(eaId: number): FormDef | null {
  return FORMS.find((f) => f.eaId === eaId) ?? null;
}

function bitsToCode(field: bigint, n: number, rot: number[]): string {
  const g: number[] = [];
  for (let r = 0; r < n; r++) g.push(Number((field >> BigInt(6 * r)) & 63n));
  let out = "";
  for (let r = 0; r < n; r++) {
    const idx = (g[r] + (r >= 2 ? g[0] : 0) + rot[r]) % 64;
    out += ALPHA[idx];
  }
  return out;
}

function codeToBits(code: string, rot: number[]): bigint {
  const n = code.length;
  const idx: number[] = [];
  const v: number[] = [];
  const g: number[] = [];
  let f = 0n;
  for (let r = 0; r < n; r++) {
    idx[r] = ALPHA.indexOf(code[r]);
    if (idx[r] < 0) throw new TacticError("char", { at: r });
  }
  for (let r = 0; r < n; r++) v[r] = (((idx[r] - rot[r]) % 64) + 64) % 64;
  for (let r = 0; r < n; r++)
    g[r] = r < 2 ? v[r] : (((v[r] - v[0]) % 64) + 64) % 64;
  for (let r = 0; r < n; r++) f |= BigInt(g[r]) << BigInt(6 * r);
  return f;
}

export function encodeFut26(t: {
  form: string;
  bu: Buildup;
  lh: number;
  ea: number[];
}): string {
  const form = findFormByValue(t.form);
  if (!form) throw new TacticError("formation");
  if (!(t.lh >= 1 && t.lh <= 100)) throw new TacticError("lh");
  const buEa = BU[t.bu];
  if (buEa === undefined) throw new TacticError("buildup");
  let sum = 0;
  for (const e of t.ea) sum += e;
  const C = (91 + form.eaId + buEa + t.lh + sum) % 512;
  let field = BigInt(C);
  field |= BigInt(form.eaId) << 9n;
  field |= BigInt(t.lh) << 63n;
  field |= BigInt(buEa) << 70n;
  t.ea.forEach((e, i) => {
    field |= BigInt(e) << BigInt(59 - 4 * i);
  });
  return bitsToCode(field, 12, ROT26);
}

export function decodeFut26(code: string): Decoded26 {
  if (code.length !== 12)
    throw new TacticError("len", { want: 12, got: code.length });
  const field = codeToBits(code, ROT26);
  const C = Number(field & 511n);
  const fEa = Number((field >> 9n) & 1023n);
  const lh = Number((field >> 63n) & 127n);
  const bu = Number((field >> 70n) & 3n);
  const ea: number[] = [];
  for (let i = 0; i < 11; i++) ea.push(Number((field >> BigInt(59 - 4 * i)) & 15n));
  const form = findFormByEaId(fEa);
  if (!form) throw new TacticError("formation", { val: fEa });
  if (lh < 1 || lh > 100) throw new TacticError("lh", { val: lh });
  const buKey = (Object.keys(BU) as Buildup[]).find((k) => BU[k] === bu);
  if (!buKey) throw new TacticError("buildup", { val: bu });
  let sum = 0;
  for (const e of ea) sum += e;
  if ((91 + fEa + bu + lh + sum) % 512 !== C) throw new TacticError("checksum");
  const slots: Slot26[] = form.pos.map((p, i) => {
    const g = PTE26[p.position] || [];
    const hit = g.find((e) => e.eaId === ea[i]);
    if (!hit)
      throw new TacticError("player", { pos: p.position, eaId: ea[i] });
    return { lid: p.lid, position: p.position, eaId: ea[i], role: hit.role, focus: hit.focus };
  });
  return { year: 26, form: form.value, bu: buKey, lh, slots };
}

export function encodeFut25(t: {
  form: string;
  bu: Buildup;
  lh: number;
  slots: (FormSlot & Pair)[];
}): string {
  const form = findFormByValue(t.form);
  if (!form) throw new TacticError("formation");
  if (BU[t.bu] === undefined) throw new TacticError("buildup");
  const dae = t.lh <= 30 ? 0 : t.lh <= 59 ? 1 : t.lh <= 89 ? 2 : 3;
  let sum = 0;
  const entries: PteEntry[] = [];
  for (const s of t.slots) {
    const hit = (PTE25[s.position] || []).find(
      (e) => e.role === s.role && e.focus === s.focus,
    );
    if (!hit)
      throw new TacticError("player", {
        pos: s.position,
        role: s.role,
        focus: s.focus,
      });
    entries.push(hit);
    sum += hit.vct ?? 0;
  }
  const buEa = BU[t.bu];
  const C = (91 + form.eaId + buEa + dae + sum) % 256;
  let field = BigInt(C);
  field |= BigInt(form.eaId) << 8n;
  field |= BigInt(dae) << 62n;
  field |= BigInt(buEa) << 64n;
  entries.forEach((e, i) => {
    field |= BigInt(e.eaId) << BigInt(58 - 4 * i);
  });
  return bitsToCode(field, 11, ROT25);
}

export function decodeFut25(code: string): Decoded25 {
  if (code.length !== 11)
    throw new TacticError("len", { want: 11, got: code.length });
  const field = codeToBits(code, ROT25);
  const C = Number(field & 255n);
  const fEa = Number((field >> 8n) & 1023n);
  const dae = Number((field >> 62n) & 3n);
  const bu = Number((field >> 64n) & 3n);
  const ea: number[] = [];
  for (let i = 0; i < 11; i++) ea.push(Number((field >> BigInt(58 - 4 * i)) & 15n));
  const form = findFormByEaId(fEa);
  if (!form) throw new TacticError("formation", { val: fEa });
  const buKey = (Object.keys(BU) as Buildup[]).find((k) => BU[k] === bu);
  if (!buKey) throw new TacticError("buildup", { val: bu });
  let sum = 0;
  const slots: Slot25[] = form.pos.map((p, i) => {
    const g = PTE25[p.position] || [];
    const hit = g.find((e) => e.eaId === ea[i]);
    if (!hit)
      throw new TacticError("player", { pos: p.position, eaId: ea[i] });
    sum += hit.vct ?? 0;
    const pair = `${hit.role}/${hit.focus}`;
    const mapped = R26[pair] || pair;
    const mp = mapped.split("/");
    return { lid: p.lid, position: p.position, role: mp[0], focus: mp[1], raw: pair };
  });
  if ((91 + fEa + bu + dae + sum) % 256 !== C) throw new TacticError("checksum");
  return { year: 25, form: form.value, bu: buKey, lh: DAE_LH[dae], slots };
}

const ERR_ZH: Record<
  TacticError["kind"],
  (e: TacticError) => string
> = {
  len: (e) =>
    `长度不对：战术码是 ${e.want ?? "11 或 12"} 个字符，你现在输入了 ${e.got ?? 0} 个。`,
  char: (e) => `第 ${(e.at ?? 0) + 1} 个字符不在编码表里，代码可能抄错了。`,
  checksum: () =>
    "校验和不符——代码可能有一两个字符抄错了，请对照原码重试。",
  formation: () => "无法识别的阵型编号，代码可能不完整。",
  buildup: () => "无法识别的组织风格。",
  lh: () => "防线高度超出范围（1–100）。",
  player: (e) =>
    `第 ${e.eaId ?? "?"} 号角色不适用于 ${e.pos ?? "该位置"}，代码可能损坏。`,
};

export function errText(e: TacticError): string {
  return (ERR_ZH[e.kind] || (() => "解码失败。"))(e);
}

export function formTitle(value: string): string {
  return findFormByValue(value)?.disp ?? value;
}

export function defaultPair(pos: string): Pair {
  const d = (DEFAULT_ROLES[pos] ?? "").split("/");
  return { role: d[0] ?? "", focus: d[1] ?? "" };
}

export function pairEa(
  pos: string,
  role: string,
  focus: string,
): number | null {
  const hit = (PTE26[pos] || []).find(
    (e) => e.role === role && e.focus === focus,
  );
  return hit ? hit.eaId : null;
}
