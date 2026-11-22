// 分享卡两回合文案：口径与 KnockoutStageView.slotScoreLabel 一致。
import { describe, expect, it } from "vitest";
import {
  roundCardSections,
  tieAggregate,
  tieScoreLabel,
  type ShareMatch,
} from "../src/lib/share";

const leg = (
  n: number,
  scoreHome: number | null,
  scoreAway: number | null,
  extra: Partial<ShareMatch> = {},
): ShareMatch => ({
  home: { name: "红队" },
  away: { name: "蓝队" },
  scoreHome,
  scoreAway,
  status: "finished",
  leg: n,
  ...extra,
});

describe("tieScoreLabel", () => {
  it("两回合完赛：首回合、次回合、总比分分段展示", () => {
    expect(tieScoreLabel([leg(1, 2, 1), leg(2, 0, 3)])).toBe(
      "首回合 2:1 · 次回合 0:3 · 总比分 5:1",
    );
  });

  it("次回合未开打时不编总比分", () => {
    expect(tieScoreLabel([leg(1, 2, 1), leg(2, null, null, { status: "pending" })])).toBe(
      "首回合 2:1 · 次回合 未开打",
    );
  });

  it("点球追加在末尾", () => {
    expect(
      tieScoreLabel([leg(1, 1, 1), leg(2, 2, 2, { penHome: 4, penAway: 3 })]),
    ).toBe("首回合 1:1 · 次回合 2:2 · 总比分 3:3 · 点球 4:3");
  });

  it("缺一条 leg 返回 null", () => {
    expect(tieScoreLabel([leg(1, 2, 1)])).toBeNull();
  });
});

describe("tieAggregate", () => {
  it("按次回合主队视角汇总", () => {
    expect(tieAggregate([leg(1, 2, 1), leg(2, 0, 3)])).toEqual({ home: 1, away: 5 });
  });

  it("两回合都完赛才汇总", () => {
    expect(tieAggregate([leg(1, 2, 1), leg(2, null, null, { status: "pending" })])).toBeNull();
    expect(tieAggregate([leg(1, 2, 1)])).toBeNull();
  });
});

describe("roundCardSections", () => {
  it("按 leg 分组并标记 twoLeg", () => {
    const s = roundCardSections([
      leg(1, 1, 0, { slot: 1 }),
      leg(2, 0, 1, { slot: 1 }),
    ]);
    expect(s.first).toHaveLength(1);
    expect(s.second).toHaveLength(1);
    expect(s.twoLeg).toBe(true);
  });

  it("单回合不标 twoLeg，无 leg 的进 rest", () => {
    const s = roundCardSections([
      leg(1, 1, 0),
      { ...leg(1, 0, 0), leg: null },
    ]);
    expect(s.twoLeg).toBe(false);
    expect(s.rest).toHaveLength(1);
  });
});
