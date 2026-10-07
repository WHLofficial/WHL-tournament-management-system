// 战术页与定位球编排页共用的草稿层：两页读写同一份 localStorage（按身份 scope 隔离），
// 所以在编排页改完返回战术页，首发名单与指派都是同一份，不会各看各的。
import { BU, FORMS, isAssignKey, type Buildup, type TacticState } from "../../shared/tactics";
import type { PlayerMeta } from "../../shared/types";

/**
 * 草稿按身份分开放：本队一份（ftc26-*），每个代打场次各一份（ftc26-proxy-<mid>-*）——
 * 否则替别人排完阵容切回本队，会看到对方的名单，指派也叠在自己那份上。
 */
export const DRAFT_KEYS = (scope: string) => ({
  state: `${scope}-state-v1`,
  names: `${scope}-names-v1`,
  assign: `${scope}-assign-v1`,
});

export function loadLS<T>(k: string, d: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(k) ?? "");
    return v == null ? d : (v as T);
  } catch {
    return d;
  }
}

export function saveLS(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* 本机存不下就算了 */
  }
}

/**
 * URL 里的 scope 只认两种：本队 ftc26、代打 ftc26-proxy-<mid>（与战术页算 wantScope 同口径）；
 * 别的值一律退回本队，避免手改地址栏把草稿写到莫名其妙的键上。
 */
export function parseScopeParam(raw: string | null): { scope: string; proxyMid: number | null } {
  const m = raw ? /^ftc26-proxy-(\d+)$/.exec(raw) : null;
  if (m) return { scope: raw as string, proxyMid: Number(m[1]) };
  return { scope: "ftc26", proxyMid: null };
}

export const DEFAULT_STATE: TacticState = { form: "3142", bu: "balanced", lh: 50, roles: {} };

export function loadScopeState(scope: string): TacticState {
  const saved = loadLS<TacticState | null>(DRAFT_KEYS(scope).state, null);
  if (!saved || !FORMS.some((f) => f.value === saved.form) || BU[saved.bu as Buildup] === undefined) {
    return { ...DEFAULT_STATE };
  }
  return {
    form: saved.form,
    bu: saved.bu,
    lh: Math.min(100, Math.max(1, Number(saved.lh) || 50)),
    roles: saved.roles && typeof saved.roles === "object" ? saved.roles : {},
  };
}

/** 指派白名单过滤：只留认识的项 + 正整数值（与后端 parseAssignJson 同口径，坏数据当没填） */
export function sanitizeAssign(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isAssignKey(k) && Number.isInteger(v) && (v as number) > 0) out[k] = v as number;
  }
  return out;
}

/**
 * 指派候选池＝本场场上 11 名首发（FC26 口径：指派只能从场上球员里选），按人去重；
 * 一人占两个位置时位置串起来显示（#7 LB/LCB 张三）。没摆满 11 个位置就留空并提示。
 */
export function assignPoolOf(
  pos: readonly { lid: number; position: string }[],
  names: Record<string, string>,
): { id: number; pos: string }[] {
  const out: { id: number; pos: string }[] = [];
  const at = new Map<number, number>();
  for (const p of pos) {
    const v = Number(names[String(p.lid)]);
    if (!Number.isInteger(v) || v <= 0) continue;
    const hit = at.get(v);
    if (hit != null) out[hit] = { ...out[hit], pos: `${out[hit].pos}/${p.position}` };
    else {
      at.set(v, out.length);
      out.push({ id: v, pos: p.position });
    }
  }
  return out;
}

/** 名册条目（/bootstrap 的 team.players 与代打板的 players）：名字/号码必在，meta 有才有 */
export interface RosterPlayer {
  id: number;
  name: string;
  number: string | null;
  meta?: PlayerMeta;
}

/** 候选行数据（结构与 components/AssignCandidate 的 AssignCandidateItem 一致，这里不依赖组件层） */
export interface AssignCandidate {
  playerId: number;
  name: string | null;
  number: string | null;
  pos: string;
  meta?: PlayerMeta;
}

/**
 * 候选行 = 首发池 + 名册文案 + FC26 数据（战术页、编排页、手机弹层共用这一份口径）。
 * meta 两个来源同源同形，优先级：已提交阵容 DTO（metaOfPid，能覆盖「已指派但已不在首发」的人）
 *   > 名册条目自带（接口层随名册下发的裁剪版，见 worker/lib/playerMeta.ts）。
 * 后一条是主流程的来源：「首次起草阵容、还没提交过」时阵容 DTO 是空的，候选行全靠它才不是「无数据」。
 */
export function assignCandidatesOf(
  pool: readonly { id: number; pos: string }[],
  roster: readonly RosterPlayer[] | null,
  metaOfPid?: ReadonlyMap<number, PlayerMeta>,
): AssignCandidate[] {
  return pool.map((c) => {
    const p = roster?.find((x) => x.id === c.id) ?? null;
    return {
      playerId: c.id,
      name: p?.name ?? null,
      number: p?.number ?? null,
      pos: c.pos,
      meta: metaOfPid?.get(c.id) ?? p?.meta,
    };
  });
}
