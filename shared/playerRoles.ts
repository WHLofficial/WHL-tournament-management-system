// 球员自己「有」哪些角色档（FC26 的 role+ / role++）——纯展示，不参与任何评分。
//
// 数据来源：player_meta.attrs 的 RoleID1-5（俱乐部平台镜像，见 worker/lib/clubMeta.ts），
// 经 shared/roleFit.ts 的冻结映射 FC26_ROLE_BY_ID 翻成「位置|角色 + tier」：
//   tier 1 = 熟悉（游戏里的 "+"，id 1-49）、tier 2 = 世界级（"++"，id 101-149）、0 = 没有。
// 与 shared/fitScore.ts 的 roleHit 同一张映射表、同一取高档口径（同槽位多枚取最高档），
// 但 FIT 的 +3/+5 加分只在那里算；这里只供 UI 显示，任何调用方都不得拿它进公式。
import type { PlayerMeta } from "./types";
import { FC26_ROLE_BY_ID } from "./roleFit";

/** 一个球员拥有的角色档 */
export interface OwnRole {
  /** 槽位键 "ST|AF"（与 ROLE_FIT / fitScore 同键） */
  slot: string;
  /** 位置码 "ST" */
  pos: string;
  /** 角色码 "AF" */
  role: string;
  /** 1 = 熟悉（"+"），2 = 世界级（"++"） */
  tier: 1 | 2;
}

/**
 * 球员自己的角色档清单：读 RoleID1-5，脏 id（0 / 非整数 / 映射表里没有）安静跳过，
 * 同槽位多枚取最高档；排序 tier 降序 → 槽位字典序（世界级排在熟悉前，同档稳定）。
 */
export function playerOwnRoles(meta: PlayerMeta | null | undefined): OwnRole[] {
  const attrs = meta?.attrs;
  if (!attrs) return [];
  const bySlot = new Map<string, OwnRole>();
  for (let i = 1; i <= 5; i++) {
    const id = attrs[`RoleID${i}`];
    if (typeof id !== "number" || !Number.isInteger(id)) continue;
    const hit = FC26_ROLE_BY_ID[id];
    if (!hit || (hit.tier !== 1 && hit.tier !== 2)) continue;
    const cur = bySlot.get(hit.slot);
    if (cur && cur.tier >= hit.tier) continue;
    const [pos, role] = hit.slot.split("|");
    bySlot.set(hit.slot, { slot: hit.slot, pos, role, tier: hit.tier });
  }
  return [...bySlot.values()].sort(
    (a, b) => b.tier - a.tier || (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0),
  );
}

/** tier → 游戏里的加号写法 */
export function roleMark(tier: 1 | 2): string {
  return tier === 2 ? "++" : "+";
}

/** 短标签 "AF++" —— 候选行 chip / 替补行小字用 */
export function ownRoleTag(r: OwnRole): string {
  return `${r.role}${roleMark(r.tier)}`;
}
