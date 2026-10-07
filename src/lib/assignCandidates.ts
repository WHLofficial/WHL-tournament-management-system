// FC26 指派 UI 的纯逻辑：候选行要画的属性 pill / 徽章 chip、候选排序、互斥预检、状态后缀。
// 与 shared/tactics 的 ASSIGN_RELEVANCE / assignRelevanceScore 是一套口径的两半：
// shared 层定义「看哪些属性、怎么打分」，这里把它铺成 UI 需要的形状（无 React 依赖，可单测）。
import {
  ASSIGN_ATTR_LABELS,
  ASSIGN_BADGE_PSID,
  ASSIGN_EXCLUSIVE,
  ASSIGN_RELEVANCE,
  assignAttrValue,
  assignRelevanceScore,
  hasAssignBadge,
  type AssignKey,
  type AttrKey,
} from "../../shared/tactics";
import { getPlaystyle, type PlaystyleTier } from "../../shared/fc26Playstyles";
import type { PlayerMeta } from "../../shared/types";

/** 候选行最小需要的球员形状（战术页池子的 {id,pos} 与 LineupPlayerDTO 叠出来的都满足） */
export interface AssignCandidatePlayer {
  playerId: number;
  name: string | null;
  number: string | null;
  meta?: PlayerMeta;
}

export interface AssignAttrPill {
  /** game_attrs 键（height 特例见 assignAttrValue） */
  key: AttrKey;
  /** pill 短名（ASSIGN_ATTR_LABELS） */
  label: string;
  value: number;
}

/**
 * 角色相关属性的 pill：顺序照 ASSIGN_RELEVANCE[key].attrKeys，取不到值的属性不占位
 * （队长 / 界外球的 attrKeys 是空的 → 返回空数组，不渲染属性行）。
 */
export function assignAttrPills(
  meta: PlayerMeta | undefined,
  key: AssignKey,
): AssignAttrPill[] {
  const out: AssignAttrPill[] = [];
  for (const attrKey of ASSIGN_RELEVANCE[key].attrKeys) {
    const value = assignAttrValue(meta, attrKey);
    if (value === null) continue;
    out.push({ key: attrKey, label: ASSIGN_ATTR_LABELS[attrKey], value: Math.round(value) });
  }
  return out;
}

export interface AssignBadgeChipData {
  psid: number;
  en: string;
  chs: string;
  tier: PlaystyleTier;
}

/**
 * 角色的相关徽章 → 金银 chip 数据。三道闸：角色本身有徽章定义、球员真带这枚徽章、
 * 命中项能查到展示名。银金都带时取金（chs 自带「 +」后缀），否则取银的那档。
 */
export function assignBadgeChip(
  meta: PlayerMeta | undefined,
  key: AssignKey,
): AssignBadgeChipData | null {
  const badge = ASSIGN_RELEVANCE[key].badge;
  if (!badge) return null;
  const playstyles = meta?.playstyles ?? [];
  if (!hasAssignBadge(playstyles, badge)) return null;
  const base = ASSIGN_BADGE_PSID[badge];
  const psid = playstyles.includes(base + 100) ? base + 100 : base;
  const ps = getPlaystyle(psid);
  return ps ? { psid, en: ps.en, chs: ps.chs, tier: ps.tier } : null;
}

/** 球员有没有 FC26 数据（身高 / 属性 / 徽章任一）；没有时属性区画「无数据」徽标，但仍可选 */
export function hasFc26Data(meta: PlayerMeta | undefined): boolean {
  if (!meta) return false;
  if (meta.height != null) return true;
  if (meta.attrs && Object.values(meta.attrs).some((v) => typeof v === "number")) return true;
  return (meta.playstyles?.length ?? 0) > 0;
}

/** 球衣号排序键：空号 / 非数字排到最后 */
function jerseyOrder(number: string | null): number {
  const text = (number ?? "").trim();
  if (text === "") return Number.POSITIVE_INFINITY;
  const n = Number(text);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/**
 * 候选排序：assignRelevanceScore 降序 → 同分球衣号升序 → 原序兜底（稳定，不动输入数组）。
 * 「不指定」不参与排序，由列表固定摆在最后一行。
 */
export function sortAssignCandidates<T extends AssignCandidatePlayer>(
  players: readonly T[],
  key: AssignKey,
): T[] {
  return players
    .map((player, index) => ({
      player,
      index,
      score: assignRelevanceScore(player.meta, key),
      jersey: jerseyOrder(player.number),
    }))
    .sort((a, b) => b.score - a.score || a.jersey - b.jersey || a.index - b.index)
    .map((x) => x.player);
}

/**
 * 把 playerId 填进 key 会撞上哪个互斥槽（ASSIGN_EXCLUSIVE，双向查）。
 * 返回对方槽位键供 UI 标「⚠ 已指定：组 · 项」；没有冲突返回 null。
 */
export function conflictingKey(
  assign: Record<string, number | undefined>,
  key: AssignKey,
  playerId: number,
): AssignKey | null {
  for (const [a, b] of ASSIGN_EXCLUSIVE) {
    if (a === key && assign[b] === playerId) return b;
    if (b === key && assign[a] === playerId) return a;
  }
  return null;
}

/** 上面那件事的布尔说法（候选行要不要标红） */
export function candidateConflicts(
  assign: Record<string, number | undefined>,
  key: AssignKey,
  playerId: number,
): boolean {
  return conflictingKey(assign, key, playerId) != null;
}

/** 状态后缀需要的字段（战术页 PStat 的子集，伤停跨赛事、停赛按赛事） */
export interface StatusSuffixInput {
  susp: number;
  yellows: number;
  near: boolean;
  inj?: { rest: number } | null;
}

/**
 * 球员状态后缀，文案与优先级照战术页下拉（停赛 > 黄牌临界 > 伤停）：
 * 停赛 🟥、再吃一黄 ⚠️、伤停 🩹；伤停后缀跟在停赛 / 黄牌文案后面。
 */
export function statusSuffix(
  st: StatusSuffixInput | null | undefined,
  yellowThreshold: number,
): string {
  if (!st) return "";
  const injSuffix = st.inj ? `（🩹伤停 剩${st.inj.rest}场）` : "";
  if (st.susp > 0) return `（🟥停赛 剩${st.susp}场）${injSuffix}`;
  if (st.near) return `（⚠️再${yellowThreshold - st.yellows}黄停赛）${injSuffix}`;
  return injSuffix;
}
