// FIT 适配度双指标引擎（B1 计划 S2 / spec §4.2）。纯函数、无 IO，只依赖 shared/roleFit 的
// 冻结表，前端战术板实时调用——不新增任何接口，保密边界靠「只有教练端页面调它」维持（spec §7）。
//
// 两个指标各归其位（spec §3/§4.2，不得混用）：
// - fitTile：个人内契合，「和自己比」——score（base+徽章）在自己同族槽位池里的百分位 0-99，
//   磁贴底衬用（阈值 85/50 在 UI 侧）。PosID/RoleID 不参与个人内比较（已隐含在属性结构里，
//   且 RoleID 有时乱给）。GK 族槽位（GK|GK/GK|SK/GK|BPK）与场上族槽位分池排，且只在本位置群
//   内出档（fitPosGroup，跨群一律 null——兜底定稿见 fitTile 注释）。
// - rankRaw / rankShown：绝对分，「和联盟比」——base + PosID 命中 +2 + RoleID 熟悉档 +3/+5
//   + 徽章（封顶 3），候选面板排序与行首数字用。排序用未截断 rankRaw（顶级 14 人会到 100-105），
//   显示层 min(99, round(rankRaw))——封顶只压显示、不压排序。绝对分跨位置群照算（门将也能在
//   候选面板看到他在场上槽位的绝对分），只是不出档。
//
// 硬口径：CA/PA 不进任何公式、不参与任何计算与排序（用户 2026-10-25 修订：CA/PA 随 trim
// 下发仅作展示参考，引擎不读、不进 FIT_ATTR_KEYS）；球员无 meta / attrs 里没有引擎可读的
// 关键属性时返回 null，UI 显示「无数据」——缺数据是事实，不是 0 分。
import type { PlayerMeta } from "./types";
import { FC26_POS_BY_ID, FC26_ROLE_BY_ID, ROLE_FIT } from "./roleFit";

/** 单槽位得分。缺属性键按已有键加权；该角色 6 键全缺 → 这个槽位在表里是 null（无数据 ≠ 0 分） */
export interface FitSlotScore {
  /** 6 项关键属性的加权均值，0-99 */
  base: number;
  /** 相关徽章加成：银 +0.5 / 金 +1（金 = 银基 + 100，口径同 shared/fc26Playstyles），封顶 3 */
  badge: number;
  /** base + badge，个人内排位（fitTile）用这个，不含 PosID/RoleID 加分 */
  score: number;
  /** base + posBonus(2) + roleBonus(3/5) + badge —— 未截断，候选排序用 */
  rankRaw: number;
  /** min(99, round(rankRaw))，显示用 */
  rankShown: number;
  breakdown: {
    /** [属性键, 原值, 加权贡献]；贡献 = 值×权重/已有权重和，加权和 = base。缺键不进表 */
    attr: [string, number, number][];
    /** 命中的相关徽章（银基 psid，金银都算命中，按权重表顺序） */
    badgeHits: number[];
    /** 球员 PosID1-4 覆盖该槽位的位置码 */
    posHit: boolean;
    /** RoleID1-5 里该槽位的最高熟悉档（0 = 没有；同槽位多枚取最高档） */
    roleHit: 0 | 1 | 2;
  };
}

/**
 * 一名球员全部槽位的得分表。49 个「位置|角色码」键齐全（fitTile 分池要遍历同族槽位），
 * 算不出的槽位值为 null——计划骨架里的「全缺 → 整槽位 null」落在这里。
 */
export type FitProfile = Map<string, FitSlotScore | null>;

/** GK 族槽位池：三个门将角色。分池依据槽位族属，不依据球员（spec §4.2 ①） */
const isGkSlot = (slot: string): boolean => slot.startsWith("GK|");

/** 位置群：门将群 / 场上群。fitTile 只在本群槽位内出档（用户 2026-10-25 兜底定稿）。 */
export type FitGroup = "GK" | "OUT";

/**
 * 位置群判定：attrs 的 PosID1-4 经 FC26_POS_BY_ID 映射后任一为 GK → 门将群，否则场上群。
 * 判定的是「群归属」，不是加分——PosID 主/副位置数据比 RoleID 可靠，也不违背「RoleID 不参与
 * 个人内比较」的定稿口径。无 PosID 的脏数据按场上群：错判方向的代价不对称，缺判只会少出档
 * （灰虚线），不会把门将的场上槽位错涂绿。
 */
export function fitPosGroup(meta: PlayerMeta | null | undefined): FitGroup {
  const attrs = meta?.attrs;
  if (!attrs) return "OUT";
  for (let i = 1; i <= 4; i++) {
    const id = attrs[`PosID${i}`];
    if (typeof id !== "number" || !Number.isInteger(id)) continue;
    if (FC26_POS_BY_ID[id] === "GK") return "GK";
  }
  return "OUT";
}

/**
 * 一名球员的全部槽位分数，一次算完供磁贴底衬（fitTile）与候选面板（rankRaw）共用。
 * 无 meta、attrs 全空、或 attrs 里没有任何引擎可读的关键属性（只剩 CA/PA / RoleID /
 * 定位球键这类引擎外的键）时返回 null（调用方按「无数据」渲染）；attrs 有键但某角色
 * 6 键全缺，该槽位为 null。
 */
export function fitProfileAll(meta: PlayerMeta | undefined): FitProfile | null {
  const attrs = meta?.attrs;
  if (!attrs || Object.keys(attrs).length === 0) return null;
  const ps = meta?.playstyles ?? [];

  // RoleID1-5 / PosID1-4 预解析一遍，49 个槽位共用。冻结映射查不到的 id（脏数据 / 未来版本）
  // 安静跳过：加分项只是小额修正，不该让它抛错。
  const tierBySlot = new Map<string, 0 | 1 | 2>();
  for (let i = 1; i <= 5; i++) {
    const id = attrs[`RoleID${i}`];
    if (typeof id !== "number" || !Number.isInteger(id)) continue;
    const hit = FC26_ROLE_BY_ID[id];
    if (!hit) continue;
    const cur = tierBySlot.get(hit.slot);
    if (cur === undefined || hit.tier > cur) tierBySlot.set(hit.slot, hit.tier);
  }
  const posSet = new Set<string>();
  for (let i = 1; i <= 4; i++) {
    const id = attrs[`PosID${i}`];
    if (typeof id !== "number" || !Number.isInteger(id)) continue;
    const code = FC26_POS_BY_ID[id];
    if (code && code !== "-") posSet.add(code); // -1 是「无位置」占位
  }

  const out: FitProfile = new Map();
  for (const [slot, prof] of Object.entries(ROLE_FIT)) {
    const hits: [string, number, number][] = [];
    for (const [k, w] of prof.attrs) {
      const v = attrs[k];
      if (typeof v === "number" && Number.isFinite(v)) hits.push([k, v, w]);
    }
    if (hits.length === 0) {
      out.set(slot, null); // 该角色 6 键全缺 → 整槽位无数据
      continue;
    }
    // 缺键按已有键加权：分母只用已有键的权重和，缺键不按 0 分拉低均值
    const wSum = hits.reduce((s, [, , w]) => s + w, 0);
    const base = hits.reduce((s, [, v, w]) => s + v * w, 0) / wSum;
    const attrBd = hits.map(
      ([k, v, w]) => [k, v, (v * w) / wSum] as [string, number, number],
    );

    // 相关徽章：银基命中 +0.5、金徽（银基+100）命中 +1；封顶 3。命中清单不因封顶截断。
    const badgeHits: number[] = [];
    let badge = 0;
    for (const b of prof.badges) {
      if (ps.includes(b + 100)) {
        badge += 1;
        badgeHits.push(b);
      } else if (ps.includes(b)) {
        badge += 0.5;
        badgeHits.push(b);
      }
    }
    if (badge > 3) badge = 3;

    const posHit = posSet.has(slot.split("|")[0]);
    const roleHit = tierBySlot.get(slot) ?? 0;
    const roleBonus = roleHit === 2 ? 5 : roleHit === 1 ? 3 : 0;
    const rankRaw = base + (posHit ? 2 : 0) + roleBonus + badge;
    out.set(slot, {
      base,
      badge,
      score: base + badge,
      rankRaw,
      rankShown: Math.min(99, Math.round(rankRaw)),
      breakdown: { attr: attrBd, badgeHits, posHit, roleHit },
    });
  }
  // attrs 里一个引擎可读的关键属性都没有（trim 后只剩 CA/PA / 定位球键这类引擎外的键是
  // 真实边界）→ 与无 meta 同口径返回 null，不让调用方拿到一整张 null 表
  for (const v of out.values()) if (v) return out;
  return null;
}

/**
 * 磁贴底衬分：score 在自己同群同族槽位池里的百分位 0-99。
 * 定义（spec §4.2，单测钉住）：池内排名 / (n-1) × 99；排名取「严格低于自己的个数」，
 * 并列同分；池内最高 = 99；池内只剩自己（n=1）= 99；自己无数据或 profile 为空 → null。
 *
 * 位置群兜底（用户 2026-10-25 定稿）：跨位置群槽位一律返回 null——门将群球员的场上族槽位、
 * 场上群球员的 GK 族槽位都无档（UI 走灰虚线 + 悬停「非其位置群」，文案见 fitTileTip）。
 * 缘由备查：S5 生产冒烟（2026-10-23 快照全量 43 名门将）出 257 个场上绿档而绝对分只有
 * 34-53——个人内百分位恒把池内前 ~15% 涂绿，GK/场上分池压不住门将场上槽位的相对高档。
 * 不用「绝对分下限」兜底：出球型门将（BPK）的传球属性与低 CA 场上球员重叠，阈值没有干净
 * 分隔；且任何绝对下限都会连带剥夺低 CA 场上球员的绿档，违背「低 CA 也有最佳位置」定稿。
 * 位置群判定（PosID 映射）无假阳性。本群内槽位的百分位算法与阈值完全不变。
 */
export function fitTile(
  profile: FitProfile | null | undefined,
  slot: string,
  group: FitGroup,
): number | null {
  if (!profile) return null;
  const self = profile.get(slot);
  if (!self) return null;
  if (isGkSlot(slot) !== (group === "GK")) return null; // 跨位置群 → 无档
  const gk = isGkSlot(slot);
  let n = 0;
  let less = 0;
  for (const [s, v] of profile) {
    if (!v || isGkSlot(s) !== gk) continue;
    n += 1;
    if (v.score < self.score) less += 1;
  }
  if (n <= 1) return 99; // n=0 理论不可达（self 必在池内），一并按「只剩自己」= 99
  return Math.round((less / (n - 1)) * 99);
}

/**
 * 磁贴悬停 title 的 FIT 追加段（Tactics.tsx 用；定稿口径：磁贴本体无数字，两个数只进悬停，
 * 无数据不追加）。与底衬同口径：跨位置群槽位不显示两个数，改显「非其位置群」；
 * 返回空串 = 不追加（无 meta / 该槽位缺键）。
 */
export function fitTileTip(
  profile: FitProfile | null | undefined,
  slot: string,
  group: FitGroup,
): string {
  if (!profile) return "";
  const score = profile.get(slot);
  if (!score) return "";
  const tile = fitTile(profile, slot, group);
  if (tile == null) return " · 非其位置群";
  return ` · 个人内契合 ${tile} · 该位置水平 ${score.rankShown}(本站估算,非 FC26 游戏内 CAPA)`;
}
