// 指派候选行纯逻辑的规范测试（src/lib/assignCandidates.ts）。
// 钉住四件事：
// ① 属性 pill 的顺序 / 取值 / 缺数据跳过，以及队长与界外球不渲染属性行；
// ② 徽章 chip 的金银优先级（银金都带取金，chs 自带「 +」）与「角色无徽章定义 / 球员没这枚」为 null；
// ③ 候选排序：相关性降序 → 同分球衣号升序 → 原序兜底，且不动输入数组；
// ④ 互斥预检只认 ASSIGN_EXCLUSIVE（角球主罚 ⊥ 角球抢点），其余兼任不算冲突；
// ⑤ 状态后缀文案与优先级逐字（停赛 > 黄牌临界 > 伤停），与战术页下拉口径一致。
import { describe, expect, it } from "vitest";
import {
  assignAttrPills,
  assignBadgeChip,
  candidateConflicts,
  conflictingKey,
  hasFc26Data,
  sortAssignCandidates,
  statusSuffix,
  type AssignCandidatePlayer,
} from "../src/lib/assignCandidates";
import type { PlayerMeta } from "../shared/types";

function p(playerId: number, number: string | null, meta?: PlayerMeta): AssignCandidatePlayer {
  return { playerId, number, name: `球员${playerId}`, meta };
}

describe("候选行属性 pill", () => {
  it("顺序照 ASSIGN_RELEVANCE.attrKeys，短名用 ASSIGN_ATTR_LABELS", () => {
    const meta: PlayerMeta = {
      attrs: { curve: 80, freekickaccuracy: 75, finishing: 70, longshots: 60 },
    };
    expect(assignAttrPills(meta, "fk_left_short")).toEqual([
      { key: "curve", label: "弧线", value: 80 },
      { key: "freekickaccuracy", label: "定位球", value: 75 },
      { key: "finishing", label: "射术", value: 70 },
      { key: "longshots", label: "远射", value: 60 },
    ]);
  });

  it("height 先取 meta.height，取不到回退 game_attrs.height；缺的属性不占位", () => {
    const meta: PlayerMeta = { height: 187, attrs: { jumping: 60, headingaccuracy: 50 } };
    expect(assignAttrPills(meta, "ca_target")).toEqual([
      { key: "height", label: "身高", value: 187 },
      { key: "jumping", label: "弹跳", value: 60 },
      { key: "headingaccuracy", label: "头球", value: 50 },
    ]);
    expect(assignAttrPills({ attrs: { height: 180 } }, "ca_target")).toEqual([
      { key: "height", label: "身高", value: 180 },
    ]);
    expect(assignAttrPills(undefined, "ca_target")).toEqual([]);
  });

  it("队长 / 界外球（attrKeys 为空）不渲染属性行", () => {
    const meta: PlayerMeta = { attrs: { strength: 90 }, height: 190 };
    expect(assignAttrPills(meta, "captain")).toEqual([]);
    expect(assignAttrPills(meta, "ti_left")).toEqual([]);
    expect(assignAttrPills(meta, "ti_right")).toEqual([]);
  });
});

describe("候选行徽章 chip", () => {
  it("银金都带取金（chs 自带「 +」），只有银就取银", () => {
    expect(assignBadgeChip({ playstyles: [104] }, "fk_penalty")?.chs).toBe("死球 +");
    expect(assignBadgeChip({ playstyles: [104] }, "fk_penalty")?.tier).toBe("gold");
    expect(assignBadgeChip({ playstyles: [4] }, "fk_penalty")).toMatchObject({
      psid: 4,
      chs: "死球",
      tier: "silver",
    });
    expect(assignBadgeChip({ playstyles: [4, 104] }, "fk_long")?.psid).toBe(104);
    expect(assignBadgeChip({ playstyles: [5] }, "ca_near")?.chs).toBe("精准头球");
    expect(assignBadgeChip({ playstyles: [126] }, "cd_guard")?.chs).toBe("空中堡垒 +");
  });

  it("角色没有徽章定义（队长 / 界外球）或球员没这枚徽章时为 null", () => {
    expect(assignBadgeChip({ playstyles: [104] }, "captain")).toBeNull();
    expect(assignBadgeChip({ playstyles: [104] }, "ti_left")).toBeNull();
    expect(assignBadgeChip({ playstyles: [5] }, "fk_penalty")).toBeNull();
    expect(assignBadgeChip({ playstyles: [] }, "ca_target")).toBeNull();
    expect(assignBadgeChip(undefined, "ca_target")).toBeNull();
  });
});

describe("FC26 数据有无", () => {
  it("身高 / 属性 / 徽章任一即为有数据", () => {
    expect(hasFc26Data(undefined)).toBe(false);
    expect(hasFc26Data({})).toBe(false);
    expect(hasFc26Data({ height: 180 })).toBe(true);
    expect(hasFc26Data({ attrs: { jumping: 70 } })).toBe(true);
    expect(hasFc26Data({ playstyles: [4] })).toBe(true);
    expect(hasFc26Data({ playstyles: [] })).toBe(false);
  });
});

describe("候选排序", () => {
  it("相关性分降序：身高分档高的中卫排在前面", () => {
    const tall = p(1, "5", { height: 195 });
    const mid = p(2, "4", { height: 183 });
    const noData = p(3, "3");
    const sorted = sortAssignCandidates([mid, noData, tall], "cd_threat");
    expect(sorted.map((x) => x.playerId)).toEqual([1, 2, 3]);
  });

  it("同分按球衣号升序，空号 / 非数字殿后，纯函数不动输入数组", () => {
    const a = p(10, "23");
    const b = p(11, "7");
    const c = p(12, null);
    const d = p(13, "门将");
    const input = [a, b, c, d];
    const sorted = sortAssignCandidates(input, "captain");
    expect(sorted.map((x) => x.playerId)).toEqual([11, 10, 12, 13]);
    expect(input.map((x) => x.playerId)).toEqual([10, 11, 12, 13]);
  });

  it("完全同分同位时保持原序（稳定）", () => {
    const list = [p(1, "9"), p(2, "9"), p(3, "9")];
    expect(sortAssignCandidates(list, "captain").map((x) => x.playerId)).toEqual([1, 2, 3]);
  });
});

describe("互斥预检", () => {
  it("角球主罚与角球抢点撞人才算冲突，并指出对方槽位", () => {
    const assign = { ca_near: 7 };
    expect(conflictingKey(assign, "ca_left", 7)).toBe("ca_near");
    expect(candidateConflicts(assign, "ca_left", 7)).toBe(true);
    expect(conflictingKey(assign, "ca_left", 8)).toBeNull();
    // 双向：从抢点侧看主罚侧
    expect(conflictingKey({ ca_left: 7 }, "ca_far", 7)).toBe("ca_left");
  });

  it("同组内可兼任（左右角球）与他人不互斥（角球防守 / 队长）不算冲突", () => {
    expect(conflictingKey({ ca_right: 7 }, "ca_left", 7)).toBeNull();
    expect(conflictingKey({ cd_far: 7 }, "ca_left", 7)).toBeNull();
    expect(conflictingKey({ captain: 7, ti_left: 7 }, "ca_target", 7)).toBeNull();
    expect(conflictingKey({}, "ca_target", 7)).toBeNull();
  });
});

describe("状态后缀", () => {
  it("停赛 > 黄牌临界 > 伤停，文案逐字（与战术页下拉一致）", () => {
    expect(statusSuffix(null, 4)).toBe("");
    expect(statusSuffix({ susp: 0, yellows: 0, near: false, inj: null }, 4)).toBe("");
    expect(statusSuffix({ susp: 2, yellows: 1, near: false, inj: null }, 4)).toBe(
      "（🟥停赛 剩2场）",
    );
    expect(
      statusSuffix({ susp: 2, yellows: 1, near: false, inj: { rest: 1 } }, 4),
    ).toBe("（🟥停赛 剩2场）（🩹伤停 剩1场）");
    expect(statusSuffix({ susp: 0, yellows: 3, near: true, inj: null }, 4)).toBe(
      "（⚠️再1黄停赛）",
    );
    expect(statusSuffix({ susp: 0, yellows: 3, near: true, inj: { rest: 2 } }, 4)).toBe(
      "（⚠️再1黄停赛）（🩹伤停 剩2场）",
    );
    expect(statusSuffix({ susp: 0, yellows: 0, near: false, inj: { rest: 3 } }, 4)).toBe(
      "（🩹伤停 剩3场）",
    );
  });
});
