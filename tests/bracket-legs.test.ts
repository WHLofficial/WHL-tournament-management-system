import { describe, expect, it } from "vitest";
import { buildElimPlan } from "../worker/lib/seeding";
import { legsOfRound } from "../worker/lib/manualBracket";

// 决赛轮回合数可以独立于 stage 级 legs 配置（「半决赛双回合 + 决赛单回合」）。
// 2026-11-04 修 S9 冠军杯时把这个能力落到 stage 7 的 config 上，这里锁住语义。

describe("淘汰赛按轮覆盖回合数", () => {
  it("legsOfRound：只在最后一轮用 finalLegs", () => {
    const cfg = { legs: 2 as const, finalLegs: 1 as const, thirdPlace: false };
    expect(legsOfRound(cfg, 1, 3)).toBe(2);
    expect(legsOfRound(cfg, 2, 3)).toBe(2);
    expect(legsOfRound(cfg, 3, 3)).toBe(1);
  });

  it("finalLegs 缺省时跟随 legs", () => {
    expect(legsOfRound({ legs: 2, thirdPlace: false }, 3, 3)).toBe(2);
    expect(legsOfRound({ legs: 1, thirdPlace: false }, 3, 3)).toBe(1);
  });

  it("buildElimPlan：8 队，前两轮双回合、决赛单回合", () => {
    const { matches, rounds } = buildElimPlan(8, { legs: 2, finalLegs: 1, thirdPlace: false });
    expect(rounds).toBe(3);
    expect(matches.filter((m) => m.round === 1)).toHaveLength(8);
    expect(matches.filter((m) => m.round === 2)).toHaveLength(4);
    const final = matches.filter((m) => m.round === 3);
    expect(final).toHaveLength(1);
    // 单回合的场次不带 leg（与联赛一致），不是 leg=1
    expect(final[0].leg).toBeUndefined();
  });

  it("buildElimPlan：不配 finalLegs 时决赛仍是双回合", () => {
    const { matches } = buildElimPlan(8, { legs: 2, thirdPlace: false });
    expect(matches.filter((m) => m.round === 3)).toHaveLength(2);
  });

  it("buildElimPlan：反过来也能配（前轮单回合、决赛双回合）", () => {
    const { matches } = buildElimPlan(8, { legs: 1, finalLegs: 2, thirdPlace: false });
    expect(matches.filter((m) => m.round === 1)).toHaveLength(4);
    expect(matches.filter((m) => m.round === 3)).toHaveLength(2);
  });
});
