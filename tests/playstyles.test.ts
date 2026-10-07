// 冻结的 FC26 PlayStyle 表（shared/fc26Playstyles.ts）——钉住四件事：
// ① 73 项齐全（0 号占位 + 银 36 + 金 36），id 不重复；
// ② 金徽就是银徽 +100，且 type 与大类名逐项成对（与 club 侧 playstyleIdOf 同口径）；
// ③ 战术页要用的三枚徽章 psid（死球 4 / 精准头球 5 / 空中堡垒 26）不被改号；
// ④ hasPlaystyle 银金都认，且只认自己要的那一枚（不误伤相邻 id）。
// 这张表是从 club 仓 web/assets/ref/playstyle.json 冻过来的一份副本，那边改一次这里要同步。
import { describe, expect, it } from "vitest";
import {
  FC26_PLAYSTYLES,
  PLAYSTYLE_GOLD_MIN,
  PS_AERIAL_FORTRESS,
  PS_DEADBALL,
  PS_PRECISION_HEADER,
  getPlaystyle,
  hasPlaystyle,
  playstyleTier,
} from "../shared/fc26Playstyles";

const silver = FC26_PLAYSTYLES.filter((p) => p.id > 0 && p.id < 100);
const gold = FC26_PLAYSTYLES.filter((p) => p.id >= PLAYSTYLE_GOLD_MIN);

describe("FC26 PlayStyle 冻结表", () => {
  it("73 项：0 号占位 + 银 36 + 金 36，id 不重复", () => {
    expect(FC26_PLAYSTYLES).toHaveLength(73);
    expect(silver).toHaveLength(36);
    expect(gold).toHaveLength(36);
    expect(new Set(FC26_PLAYSTYLES.map((p) => p.id)).size).toBe(73);
    expect(FC26_PLAYSTYLES[0]).toEqual({
      id: 0,
      en: "-",
      chs: "-",
      type: "None",
    });
  });

  it("金徽 = 银徽 +100：每枚银徽都有对应的金徽，type 相同、名字只差结尾的 +", () => {
    const byId = new Map(FC26_PLAYSTYLES.map((p) => [p.id, p]));
    for (const s of silver) {
      const g = byId.get(s.id + 100);
      expect(g, `银 ${s.id}（${s.chs}）缺金徽 ${s.id + 100}`).toBeDefined();
      expect(g!.type).toBe(s.type);
      expect(g!.en).toBe(`${s.en} +`);
      expect(g!.chs).toBe(`${s.chs} +`);
    }
  });

  it("档位判据：>= 101 是金，100 是空档（两段之间没有 100 号）", () => {
    expect(PLAYSTYLE_GOLD_MIN).toBe(101);
    expect(playstyleTier(4)).toBe("silver");
    expect(playstyleTier(100)).toBe("silver");
    expect(playstyleTier(101)).toBe("gold");
    expect(playstyleTier(156)).toBe("gold");
    expect(FC26_PLAYSTYLES.some((p) => p.id === 100)).toBe(false);
  });

  it("三枚战术徽章逐项核对：死球 4 / 精准头球 5 / 空中堡垒 26", () => {
    expect([PS_DEADBALL, PS_PRECISION_HEADER, PS_AERIAL_FORTRESS]).toEqual([
      4, 5, 26,
    ]);
    expect(getPlaystyle(PS_DEADBALL)).toEqual({
      en: "Dead Ball",
      chs: "死球",
      tier: "silver",
    });
    expect(getPlaystyle(PS_PRECISION_HEADER)).toEqual({
      en: "Precision Header",
      chs: "精准头球",
      tier: "silver",
    });
    expect(getPlaystyle(PS_AERIAL_FORTRESS)).toEqual({
      en: "Aerial Fortress",
      chs: "空中堡垒",
      tier: "silver",
    });
    // 金版与银版是同一枚技能的上下位（104 / 105 / 126）
    expect(getPlaystyle(PS_DEADBALL + 100)?.chs).toBe("死球 +");
    expect(getPlaystyle(PS_PRECISION_HEADER + 100)?.chs).toBe("精准头球 +");
    expect(getPlaystyle(PS_AERIAL_FORTRESS + 100)?.chs).toBe("空中堡垒 +");
    expect(getPlaystyle(PS_DEADBALL + 100)?.tier).toBe("gold");
  });
});

describe("getPlaystyle / hasPlaystyle", () => {
  it("表外 id 与 0 号占位都返回 null（别让 UI 画出「PS 999」这种名字）", () => {
    expect(getPlaystyle(0)).toBeNull();
    expect(getPlaystyle(9)).toBeNull();
    expect(getPlaystyle(100)).toBeNull();
    expect(getPlaystyle(999)).toBeNull();
    expect(getPlaystyle(-1)).toBeNull();
  });

  it("hasPlaystyle：银徽与金徽都算命中", () => {
    expect(hasPlaystyle([4], PS_DEADBALL)).toBe(true);
    expect(hasPlaystyle([104], PS_DEADBALL)).toBe(true);
    expect(hasPlaystyle([3, 104, 51], PS_DEADBALL)).toBe(true);
    expect(hasPlaystyle([5], PS_DEADBALL)).toBe(false);
    expect(hasPlaystyle([26], PS_AERIAL_FORTRESS)).toBe(true);
    expect(hasPlaystyle([126], PS_AERIAL_FORTRESS)).toBe(true);
    expect(hasPlaystyle([25, 125], PS_AERIAL_FORTRESS)).toBe(false);
  });

  it("hasPlaystyle：空数组 / null / undefined 都不算命中", () => {
    expect(hasPlaystyle([], PS_DEADBALL)).toBe(false);
    expect(hasPlaystyle(null, PS_DEADBALL)).toBe(false);
    expect(hasPlaystyle(undefined, PS_DEADBALL)).toBe(false);
  });
});
