// FIT 适配度引擎（shared/fitScore.ts）——钉住 spec §4.2 / 计划 S8 的不变量：
// ① 区间：base ∈ [0,99]、fitTile / rankShown ∈ [0,99]（score = base+徽章可到 102，不在此列）；
// ② breakdown：属性贡献加权和 = base、缺键不进表、徽章命中银金都记（badgeHits 不因封顶截断）；
// ③ 加分：PosID 命中 +2、RoleID 一档 +3 / ++ 档 +5（同槽位多枚取最高档）、徽章银 +0.5 / 金 +1 封顶 3；
// ④ 无 meta / 无 attrs → null；6 键全缺 → 整槽位 null；缺键按已有键加权；
// ⑤ fitTile：个人内百分位 = 排名/(n-1)×99、池内最高 99、n=1 = 99、GK 族与场上族分池；
//   位置群口径（用户 2026-10-29）：门将三槽映射到 85-99（99/92/85），门将的场上槽位记 0；
//   场上球员的 GK 槽位仍无档（null，灰虚线 + 悬停「非其位置群」），
//   绝对分 rankShown 跨群照算（候选面板不缺行）；
// ⑥ rankRaw 不被 99 截断（候选排序口径），rankShown 才封顶。
import { describe, expect, it } from "vitest";
import {
  fitPosGroup,
  fitProfileAll,
  fitTile,
  fitTileTip,
  type FitProfile,
  type FitSlotScore,
} from "../shared/fitScore";
import { FIT_ATTR_KEYS, ROLE_FIT } from "../shared/roleFit";
import type { PlayerMeta } from "../shared/types";

const meta = (attrs: Record<string, number>, playstyles?: number[]): PlayerMeta => ({
  attrs,
  ...(playstyles === undefined ? {} : { playstyles }),
});

// 门将 fixture：gk 五维 + reactions 手挑（三个 GK 槽位 base 手算可得整），其余权重键给一组
// 确定性铺开的场上值——场上 46 槽全部可算且分数互不相同（分池均值检验的前提）。
// PosID1=0（GK）：钉 posHit 的方向。
const GK_META: PlayerMeta = {
  attrs: {
    ...Object.fromEntries(
      FIT_ATTR_KEYS.filter((k) => !k.startsWith("gk")).map((k, i) => [
        k,
        40 + ((i * 7) % 55),
      ]),
    ),
    gkreflexes: 90,
    gkdiving: 84,
    gkpositioning: 81,
    gkhandling: 78,
    gkkicking: 66,
    reactions: 72,
    shortpassing: 60,
    longpassing: 57,
    PosID1: 0,
  },
};
// 手算锚点：GK|GK = (90×3+84×3+81×2+78×2+72+66)/12 = 81.5；
// GK|SK = (90×3+81×3+84×2+66×2+78+72)/12 = 80.25；GK|BPK = (66×3+60×3+57×2+90×2+84+78)/12 = 69.5。

// 场上 fixture：ST 禁区之王画像 + PosID1=25（ST）+ 两枚同槽 RoleID（42 一档 / 142 ++ 档）
// + 银徽 7 与金徽 101（=1+100）。
const ST_META = meta(
  {
    finishing: 90,
    positioning: 84,
    reactions: 72,
    shotpower: 72,
    composure: 60,
    sprintspeed: 60,
    PosID1: 25,
    RoleID1: 42,
    RoleID2: 142,
  },
  [7, 101],
);
// 手算锚点：ST|PO base = (90×3+84×3+72×2+72×2+60+60)/12 = 77.5；badge = 0.5+1 = 1.5；
// rankRaw = 77.5 + 2(ST) + 5(++档) + 1.5 = 86。

/** fitTile 只读 score：手搭 profile 做百分位纯数学，不用绕完整引擎 */
const profOf = (scores: Record<string, number>): FitProfile =>
  new Map<string, FitSlotScore | null>(
    Object.entries(scores).map(([s, score]) => [s, { score } as FitSlotScore]),
  );

describe("fitProfileAll：base 与 breakdown", () => {
  it("base = 6 属性加权均值（权重 3/3/2/2/1/1），breakdown 贡献 = 值×权重/权重和且加和 = base", () => {
    const p = fitProfileAll(GK_META)!;
    expect(p.get("GK|GK")!.base).toBeCloseTo(81.5, 10);
    expect(p.get("GK|SK")!.base).toBeCloseTo(80.25, 10);
    expect(p.get("GK|BPK")!.base).toBeCloseTo(69.5, 10);
    const bd = p.get("GK|GK")!.breakdown;
    expect(bd.attr).toHaveLength(6);
    expect(bd.attr[0]).toEqual(["gkreflexes", 90, 22.5]); // 90×3/12
    const sum = bd.attr.reduce((s, [, , c]) => s + c, 0);
    expect(sum).toBeCloseTo(p.get("GK|GK")!.base, 10);
  });

  it("缺键按已有键加权：分母只用已有键的权重和，缺键不按 0 分拉低", () => {
    const p = fitProfileAll(meta({ gkreflexes: 90, gkdiving: 60 }))!;
    // GK|GK：(90×3 + 60×3) / 6 = 75，breakdown 只剩 2 行
    expect(p.get("GK|GK")!.base).toBeCloseTo(75, 10);
    expect(p.get("GK|GK")!.breakdown.attr).toHaveLength(2);
    // ST|AF 只有 sprintspeed(3)/finishing(2)/positioning(2) 在场：(60×3+90×2+84×2)/7
    const st = fitProfileAll(ST_META)!;
    expect(st.get("ST|AF")!.base).toBeCloseTo(528 / 7, 10);
    expect(st.get("ST|AF")!.breakdown.attr).toHaveLength(3);
  });

  it("该角色 6 键全缺 → 整槽位 null（无数据 ≠ 0 分），fitTile 也返回 null", () => {
    const p = fitProfileAll(meta({ headingaccuracy: 77 }))!;
    expect(p.get("ST|TF")!.base).toBe(77); // 唯一键 headingaccuracy 权重 3：77×3/3
    expect(p.get("GK|GK")).toBeNull();
    expect(fitTile(p, "GK|GK", "OUT")).toBeNull();
  });

  it("无 meta / 无 attrs → 整个 profile 为 null（徽章单独存在也算无数据）", () => {
    expect(fitProfileAll(undefined)).toBeNull();
    expect(fitProfileAll({})).toBeNull();
    expect(fitProfileAll({ attrs: {} })).toBeNull();
    expect(fitProfileAll({ playstyles: [4] })).toBeNull();
    expect(fitTile(null, "ST|AF", "OUT")).toBeNull();
    expect(fitTile(undefined, "ST|AF", "OUT")).toBeNull();
    // attrs 只有引擎外的键（CA/PA / RoleID / 定位球组的 freekickaccuracy、penalties）= 无数据；
    // 注意 curve / longshots 虽在 ATTR_KEYS 里，但分别是 CAM|C10 / CDM|BC 的权重键，引擎可读
    expect(fitProfileAll({ attrs: { CA: 88, PA: 3 } })).toBeNull();
    expect(
      fitProfileAll({ attrs: { RoleID1: 142, freekickaccuracy: 80, penalties: 70 } }),
    ).toBeNull();
    // 展示键不改变有数据球员的引擎输出：CA/PA 在场与否，分数逐槽一致（playstyles 原样带）
    const withCapa = fitProfileAll({
      ...ST_META,
      attrs: { ...ST_META.attrs, CA: 88, PA: 3 },
    })!;
    const without = fitProfileAll(ST_META)!;
    for (const [slot, v] of without) {
      expect(withCapa.get(slot), slot).toEqual(v);
    }
  });

  it("区间：非 null 槽位的 base ∈ [0,99]，fitTile 与 rankShown ∈ [0,99]", () => {
    for (const m of [GK_META, ST_META]) {
      const p = fitProfileAll(m)!;
      const group = fitPosGroup(m);
      for (const [slot, v] of p) {
        if (!v) continue;
        expect(v.base, slot).toBeGreaterThanOrEqual(0);
        expect(v.base, slot).toBeLessThanOrEqual(99);
        const tile = fitTile(p, slot, group); // 跨群槽位为 null，区间检查只看本群
        expect(tile === null || (tile >= 0 && tile <= 99), slot).toBe(true);
        expect(v.rankShown, slot).toBeGreaterThanOrEqual(0);
        expect(v.rankShown, slot).toBeLessThanOrEqual(99);
      }
    }
  });

  it("breakdown 命中：badgeHits 银金都记（按权重表顺序）、posHit 认 PosID 映射的位置码", () => {
    const p = fitProfileAll(ST_META)!;
    const bd = p.get("ST|PO")!.breakdown;
    expect(bd.badgeHits).toEqual([7, 1]); // ST|PO 徽章 [7,1,8]：7 银在库、1 经金徽 101 命中
    expect(bd.posHit).toBe(true); // PosID1=25 → "ST"
    expect(bd.roleHit).toBe(2); // RoleID 42（一档）与 142（++）同槽位，取最高档
    const gk = fitProfileAll(GK_META)!;
    expect(gk.get("GK|GK")!.breakdown.posHit).toBe(true); // PosID1=0 → "GK"
    expect(gk.get("ST|AF")!.breakdown.posHit).toBe(false);
    expect(gk.get("ST|AF")!.breakdown.roleHit).toBe(0);
  });
});

describe("加分与封顶（rankRaw 侧）", () => {
  it("PosID 命中 +2、RoleID 一档 +3；rankRaw = base + 加分 + 徽章（精确手算）", () => {
    const p = fitProfileAll(ST_META)!;
    expect(p.get("ST|PO")!.rankRaw).toBeCloseTo(77.5 + 2 + 5 + 1.5, 10);
    expect(p.get("ST|PO")!.rankShown).toBe(86);
    // 只有一档 RoleID：+3 而非 +5
    const t1 = fitProfileAll(
      meta(
        {
          finishing: 90,
          positioning: 84,
          reactions: 72,
          shotpower: 72,
          composure: 60,
          sprintspeed: 60,
          PosID1: 25,
          RoleID1: 42,
        },
        [7, 101],
      ),
    )!;
    expect(t1.get("ST|PO")!.breakdown.roleHit).toBe(1);
    expect(t1.get("ST|PO")!.rankRaw).toBeCloseTo(77.5 + 2 + 3 + 1.5, 10);
  });

  it("徽章：银 +0.5 / 金 +1，超过 3 封顶 3；badgeHits 不因封顶截断", () => {
    const p = fitProfileAll(ST_META)!;
    expect(p.get("ST|PO")!.badge).toBe(1.5);
    // CB|S 有 5 枚相关徽章，全带金徽 → 5 分封顶 3，命中清单仍是 5 个
    const cb = fitProfileAll(
      meta(
        {
          jumping: 50,
          standingtackle: 50,
          aggression: 50,
          defensiveawareness: 50,
          strength: 50,
          interceptions: 50,
        },
        [126, 122, 105, 123, 144],
      ),
    )!;
    expect(cb.get("CB|S")!.badge).toBe(3);
    expect(cb.get("CB|S")!.breakdown.badgeHits).toHaveLength(5);
  });

  it("rankRaw 不被 99 截断（排序口径），rankShown = min(99, round(rankRaw))", () => {
    const max = fitProfileAll(
      meta(
        {
          finishing: 99,
          positioning: 99,
          reactions: 99,
          shotpower: 99,
          composure: 99,
          sprintspeed: 99,
          PosID1: 25,
          RoleID1: 142,
        },
        [107, 101, 108],
      ),
    )!;
    const po = max.get("ST|PO")!;
    expect(po.base).toBe(99);
    expect(po.badge).toBe(3);
    expect(po.rankRaw).toBe(99 + 2 + 5 + 3); // 109，排序用它区分「显示同分」的顶级球员
    expect(po.rankShown).toBe(99);
    // 恒等式钉满全部槽位：rankShown 永远 = min(99, round(rankRaw))
    for (const [slot, v] of max) {
      if (!v) continue;
      expect(v.rankShown, slot).toBe(Math.min(99, Math.round(v.rankRaw)));
    }
  });
});

describe("fitPosGroup：位置群判定（fitTile 兜底的输入）", () => {
  it("PosID1-4 任一映射到 GK → 门将群；否则场上群（含无 PosID / 只有 -1 占位）", () => {
    expect(fitPosGroup(GK_META)).toBe("GK"); // PosID1=0 → GK
    expect(fitPosGroup(ST_META)).toBe("OUT"); // PosID1=25 → ST
    expect(fitPosGroup(undefined)).toBe("OUT");
    expect(fitPosGroup({ attrs: { PosID1: -1 } })).toBe("OUT"); // 「无位置」占位不算门将
    expect(fitPosGroup({ attrs: { PosID1: 25, PosID2: 0 } })).toBe("GK"); // 副位置门将也算
  });
});

describe("fitTile：个人内百分位与分池", () => {
  it("百分位定义：排名/(n-1)×99（排名取严格低于自己的个数），池内最高 99、最低 0", () => {
    const p = profOf({ "ST|AF": 10, "ST|PO": 20, "ST|TF": 30 });
    expect(fitTile(p, "ST|AF", "OUT")).toBe(0);
    expect(fitTile(p, "ST|PO", "OUT")).toBe(50); // 1/2×99 = 49.5 → 50
    expect(fitTile(p, "ST|TF", "OUT")).toBe(99);
  });

  it("并列同分取同一百分位；池内只剩自己（n=1）= 99", () => {
    const tied = profOf({ "CB|D": 50, "CB|S": 50, "CB|BPD": 80 });
    expect(fitTile(tied, "CB|D", "OUT")).toBe(0);
    expect(fitTile(tied, "CB|S", "OUT")).toBe(0);
    expect(fitTile(tied, "CB|BPD", "OUT")).toBe(99);
    const solo = profOf({ "ST|AF": 42 });
    expect(fitTile(solo, "ST|AF", "OUT")).toBe(99);
  });

  it("分池：GK 族 3 槽与场上族互不掺和——GK 分数不进场上池、场上分数不进 GK 池", () => {
    const p = profOf({
      "GK|GK": 90,
      "GK|SK": 80,
      "GK|BPK": 70,
      "ST|AF": 10,
      "ST|PO": 20,
    });
    // GK 池 n=3：GK|SK 是次高 → 原始 50，门将展示映射后 85 + round(50/99×14) = 92
    expect(fitTile(p, "GK|SK", "GK")).toBe(92);
    // 场上池只有两个槽位（GK 三槽不计入）：ST|PO 是最高 → 99（混池会被 GK 分数压下去）
    expect(fitTile(p, "ST|PO", "OUT")).toBe(99);
    expect(fitTile(p, "ST|AF", "OUT")).toBe(0);
  });

  it("位置群口径（用户 2026-10-29）：门将外场槽记 0，场上球员的 GK 槽仍无档", () => {
    const p = profOf({
      "GK|GK": 90,
      "GK|SK": 80,
      "GK|BPK": 70,
      "ST|AF": 10,
      "ST|PO": 20,
    });
    // 门将群球员：场上族槽位统一 0（不再灰虚线无档；S5 的 257 个假绿档由此归零）
    expect(fitTile(p, "ST|PO", "GK")).toBe(0);
    expect(fitTile(p, "ST|AF", "GK")).toBe(0);
    // 场上群球员：GK 族槽位仍 null
    expect(fitTile(p, "GK|GK", "OUT")).toBeNull();
    expect(fitTile(p, "GK|SK", "OUT")).toBeNull();
  });

  it("门将 fixture：GK 槽映射 99/92/85（最差也绿档），场上 46 槽统一 0", () => {
    const p = fitProfileAll(GK_META)!;
    expect(fitPosGroup(GK_META)).toBe("GK");
    expect(fitTile(p, "GK|GK", "GK")).toBe(99);
    expect(fitTile(p, "GK|SK", "GK")).toBe(92);
    expect(fitTile(p, "GK|BPK", "GK")).toBe(85);

    const outfieldSlots = Object.keys(ROLE_FIT).filter((s) => !s.startsWith("GK|"));
    expect(outfieldSlots).toHaveLength(46);
    // fixture 属性给全：场上槽位 score 全部可算（候选面板绝对分照显），但门将不客串 → 0
    for (const s of outfieldSlots) {
      expect(p.get(s), s).not.toBeNull();
      expect(fitTile(p, s, "GK"), s).toBe(0);
    }
    expect(fitTile(p, "NOPE|X", "GK")).toBeNull(); // 陌生槽位键 → 无数据
  });

  it("场上球员带 gk 属性：GK 槽位绝对分照算（候选面板不缺行），档位仍为 null", () => {
    // 生产数据里场上球员普遍带着 5-15 的 gk 属性——绝对分可算、位置群兜底只挡档位
    const st = fitProfileAll(
      meta({ ...ST_META.attrs, gkreflexes: 11, gkdiving: 9, gkpositioning: 8, gkhandling: 7, gkkicking: 6 }),
    )!;
    expect(st.get("GK|GK")).not.toBeNull();
    expect(st.get("GK|GK")!.rankShown).toBeGreaterThan(0);
    expect(fitTile(st, "GK|GK", "OUT")).toBeNull();
  });
});

describe("fitTileTip：磁贴悬停 FIT 追加段（与底衬同口径）", () => {
  // 手搭最小 profile：fitTileTip 只读 score / rankShown 与 fitTile
  const tipProf = (pairs: [string, { score: number; rankShown: number }][]): FitProfile =>
    new Map(pairs.map(([s, v]) => [s, v] as [string, FitSlotScore]));

  it("本群槽位：两个数照显（个人内契合 + 该位置水平，逐字同定稿文案）", () => {
    const p = tipProf([["ST|PO", { score: 50, rankShown: 86 }]]);
    expect(fitTileTip(p, "ST|PO", "OUT")).toBe(
      " · 个人内契合 99 · 该位置水平 86(本站估算,非 FC26 游戏内 CAPA)",
    ); // 池内只剩自己 → 99
  });

  it("场上球员的 GK 槽：不显两个数，改显「非其位置群」", () => {
    const p = tipProf([["GK|GK", { score: 90, rankShown: 83 }]]);
    expect(fitTileTip(p, "GK|GK", "OUT")).toBe(" · 非其位置群");
  });

  it("门将的场上槽：显「门将不客串（0 分）」+ 该位置水平", () => {
    const p = tipProf([
      ["ST|PO", { score: 40, rankShown: 61 }],
      ["GK|GK", { score: 90, rankShown: 83 }],
    ]);
    expect(fitTileTip(p, "ST|PO", "GK")).toBe(
      " · 门将不客串（0 分） · 该位置水平 61(本站估算,非 FC26 游戏内 CAPA)",
    );
  });

  it("无 profile / 槽位缺键 → 空串（「无数据不追加」定稿不变）", () => {
    expect(fitTileTip(null, "ST|PO", "OUT")).toBe("");
    expect(fitTileTip(new Map(), "ST|PO", "OUT")).toBe("");
  });
});
