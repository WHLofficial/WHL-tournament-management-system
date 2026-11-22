// 分享卡两回合文案：口径与 KnockoutStageView.slotScoreLabel 一致。
import { describe, expect, it } from "vitest";
import { roundCardRows, tieAggregate, tieScoreLabel, type ShareMatch } from "../src/lib/share";

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
  it("两回合完赛按次回合主队视角汇总", () => {
    expect(tieAggregate([leg(1, 2, 1, { slot: 1 }), leg(2, 0, 3, { slot: 1 })])).toEqual({
      home: 1,
      away: 5,
    });
  });

  it("任一回合并未完赛返回 null", () => {
    expect(
      tieAggregate([
        leg(1, 2, 1, { slot: 1 }),
        leg(2, null, null, { slot: 1, status: "pending" }),
      ]),
    ).toBeNull();
  });
});

describe("roundCardRows", () => {
  it("同 slot 的首/次回合标回合名，次回合并入上一行同组", () => {
    const rows = roundCardRows([
      leg(1, 2, 1, { slot: 1 }),
      leg(2, 0, 3, { slot: 1 }),
      leg(1, 1, 0, { slot: 2 }),
      leg(2, 0, 1, { slot: 2 }),
    ]);
    expect(rows.map((r) => r.legLabel)).toEqual(["首回合", "次回合", "首回合", "次回合"]);
    expect(rows.map((r) => r.sameTie)).toEqual([false, true, false, true]);
  });

  it("非两回合不标回合名", () => {
    const rows = roundCardRows([leg(0, 1, 0)]);
    expect(rows[0].legLabel).toBeUndefined();
    expect(rows[0].sameTie).toBe(false);
  });
});
