// shared/tactics.ts 里「指派相关性」这一块的规范测试（战术页候选球员的属性 pill / 徽章 chip / 排序）。
// 钉住四件事：
// ① 18 个 AssignKey 全都有相关性定义，且与定案的角色 → 属性/徽章对照表逐项一致（这张表是 UI 的唯一依据）；
// ② 用到的属性键就是 club 仓 game_attrs 的真实英文键（freekickaccuracy 这种没下划线的容易写错，逐字钉）；
// ③ 评分规则：40 起算、身高分档、缺数据不计、徽章不计分（排序必须可解释）；
// ④ height 特例：先取 meta.height，取不到回退 game_attrs.height。
import { describe, expect, it } from "vitest";
import { ASSIGN_KEYS, type AssignKey } from "../shared/tactics";
import {
  ASSIGN_ATTR_LABELS,
  ASSIGN_BADGE_PSID,
  ASSIGN_RELEVANCE,
  ATTR_KEYS,
  assignAttrValue,
  assignRelevanceScore,
  hasAssignBadge,
} from "../shared/tactics";
import { PS_AERIAL_FORTRESS, PS_DEADBALL, PS_PRECISION_HEADER } from "../shared/fc26Playstyles";

const T = ATTR_KEYS;

describe("指派相关性：角色 → 属性 / 徽章", () => {
  it("属性键与 club 仓 game_attrs 逐字一致", () => {
    expect(ATTR_KEYS).toEqual({
      height: "height",
      curve: "curve",
      freekickAccuracy: "freekickaccuracy",
      finishing: "finishing",
      longShots: "longshots",
      penalties: "penalties",
      jumping: "jumping",
      headingAccuracy: "headingaccuracy",
      defensiveAwareness: "defensiveawareness",
      strength: "strength",
      aggression: "aggression",
    });
  });

  it("每个属性键都有中文展示名，没有多余或漏掉的键", () => {
    expect(Object.keys(ASSIGN_ATTR_LABELS).sort()).toEqual(
      Object.values(ATTR_KEYS).sort(),
    );
    expect(ASSIGN_ATTR_LABELS[T.freekickAccuracy]).toBe("定位球");
    expect(ASSIGN_ATTR_LABELS[T.height]).toBe("身高");
    expect(ASSIGN_ATTR_LABELS[T.headingAccuracy]).toBe("头球");
    // 展示名不重名，否则 pill 上分不清
    const names = Object.values(ASSIGN_ATTR_LABELS);
    expect(new Set(names).size).toBe(names.length);
  });

  it("18 个指派键一个不少、一个不多", () => {
    expect(ASSIGN_KEYS).toHaveLength(18);
    expect(Object.keys(ASSIGN_RELEVANCE).sort()).toEqual(
      [...ASSIGN_KEYS].sort(),
    );
  });

  it("逐项对照表：分组按定案，与 shared/tactics.ts 里的定义完全一致", () => {
    const fkCommon = [T.curve, T.freekickAccuracy, T.finishing];
    const caHead = [T.height, T.finishing, T.jumping, T.headingAccuracy];
    const cdAir = [T.height, T.strength, T.jumping];
    const expected: Record<AssignKey, { keys: string[]; badge?: string }> = {
      captain: { keys: [] },
      fk_left_short: { keys: [...fkCommon, T.longShots], badge: "deadball" },
      fk_right_short: { keys: [...fkCommon, T.longShots], badge: "deadball" },
      fk_long: { keys: [...fkCommon, T.longShots], badge: "deadball" },
      fk_penalty: { keys: [...fkCommon, T.penalties], badge: "deadball" },
      ca_left: { keys: caHead, badge: "heading" },
      ca_right: { keys: caHead, badge: "heading" },
      ca_target: { keys: caHead, badge: "heading" },
      ca_near: { keys: caHead, badge: "heading" },
      ca_far: { keys: caHead, badge: "heading" },
      ca_arc: {
        keys: [T.height, T.finishing, T.longShots],
        badge: "heading",
      },
      ca_cover: {
        keys: [T.defensiveAwareness, T.strength, T.aggression],
        badge: "heading",
      },
      cd_threat: { keys: cdAir, badge: "aerial" },
      cd_guard: { keys: cdAir, badge: "aerial" },
      cd_near: { keys: cdAir, badge: "aerial" },
      cd_far: { keys: cdAir, badge: "aerial" },
      ti_left: { keys: [] },
      ti_right: { keys: [] },
    };
    for (const k of ASSIGN_KEYS) {
      expect([...ASSIGN_RELEVANCE[k].attrKeys], k).toEqual(expected[k].keys);
      expect(ASSIGN_RELEVANCE[k].badge, k).toBe(expected[k].badge);
    }
  });

  it("属性键都在白名单里（没有拼错的键混进来）", () => {
    const known = new Set<string>(Object.values(ATTR_KEYS));
    for (const k of ASSIGN_KEYS) {
      for (const attr of ASSIGN_RELEVANCE[k].attrKeys) {
        expect(known.has(attr), `${k} 用了白名单外的属性键 ${attr}`).toBe(true);
      }
    }
  });

  it("徽章 psid 指向 fc26Playstyles 的三枚常量", () => {
    expect(ASSIGN_BADGE_PSID).toEqual({
      deadball: PS_DEADBALL,
      heading: PS_PRECISION_HEADER,
      aerial: PS_AERIAL_FORTRESS,
    });
    expect(ASSIGN_BADGE_PSID).toEqual({
      deadball: 4,
      heading: 5,
      aerial: 26,
    });
  });

  it("hasAssignBadge：银徽金徽都算命中，没徽章的返回 false", () => {
    expect(hasAssignBadge([4], "deadball")).toBe(true);
    expect(hasAssignBadge([104], "deadball")).toBe(true);
    expect(hasAssignBadge([105], "heading")).toBe(true);
    expect(hasAssignBadge([126], "aerial")).toBe(true);
    expect(hasAssignBadge([126], "deadball")).toBe(false);
    expect(hasAssignBadge([], "aerial")).toBe(false);
    expect(hasAssignBadge(undefined, "heading")).toBe(false);
  });
});

describe("assignAttrValue：取值（身高特例）", () => {
  it("height 先取 meta.height，取不到回退 attrs.height", () => {
    expect(assignAttrValue({ height: 189 }, T.height)).toBe(189);
    expect(assignAttrValue({ height: null, attrs: { height: 191 } }, T.height)).toBe(191);
    expect(assignAttrValue({ attrs: { height: 191 } }, T.height)).toBe(191);
    expect(assignAttrValue({ attrs: { curve: 88 } }, T.height)).toBeNull();
  });

  it("其余属性读 attrs；没数据 / 非有限数值返回 null", () => {
    expect(assignAttrValue({ attrs: { curve: 88 } }, T.curve)).toBe(88);
    expect(assignAttrValue({ attrs: {} }, T.curve)).toBeNull();
    expect(assignAttrValue({ attrs: { curve: Number.NaN } }, T.curve)).toBeNull();
    expect(assignAttrValue({ attrs: { curve: Number.POSITIVE_INFINITY } }, T.curve)).toBeNull();
    expect(assignAttrValue(undefined, T.curve)).toBeNull();
  });
});

describe("assignRelevanceScore：排序分", () => {
  it("没有 meta、属性全空、或角色本身不看属性 → 0", () => {
    expect(assignRelevanceScore(undefined, "fk_left_short")).toBe(0);
    expect(assignRelevanceScore({}, "cd_threat")).toBe(0);
    expect(assignRelevanceScore({ attrs: {} }, "ca_target")).toBe(0);
    expect(
      assignRelevanceScore({ attrs: { curve: 99 }, playstyles: [104] }, "captain"),
    ).toBe(0);
    expect(assignRelevanceScore({ height: 195 }, "ti_right")).toBe(0);
  });

  it("属性分 = 每项 max(0, 值 - 40) 累加", () => {
    // 50 + 55 + 51 + 48
    expect(
      assignRelevanceScore(
        {
          attrs: {
            curve: 90,
            freekickaccuracy: 95,
            finishing: 91,
            longshots: 88,
          },
        },
        "fk_left_short",
      ),
    ).toBe(204);
  });

  it("40 分以下不参与（含 40 本身），小数四舍五入", () => {
    const score = (curve: number) =>
      assignRelevanceScore({ attrs: { curve } }, "fk_left_short");
    expect(score(0)).toBe(0);
    expect(score(39)).toBe(0);
    expect(score(40)).toBe(0);
    expect(score(41)).toBe(1);
    expect(score(70.4)).toBe(30);
    expect(score(70.6)).toBe(31);
  });

  it("只算这个角色相关的那几项：缺项不计，别的项再高也不加", () => {
    // fk_penalty 看点球，不看远射
    expect(
      assignRelevanceScore(
        {
          attrs: {
            curve: 90,
            freekickaccuracy: 90,
            finishing: 90,
            longshots: 99,
            penalties: 90,
          },
        },
        "fk_penalty",
      ),
    ).toBe(200);
    // ca_arc 看远射，不看头球
    expect(
      assignRelevanceScore(
        { height: 190, attrs: { finishing: 80, headingaccuracy: 99, longshots: 70 } },
        "ca_arc",
      ),
    ).toBe(32 + 40 + 30);
    // ca_cover 不看身高
    expect(
      assignRelevanceScore(
        {
          height: 195,
          attrs: { defensiveawareness: 80, strength: 80, aggression: 80 },
        },
        "ca_cover",
      ),
    ).toBe(120);
  });

  it("身高分档：195/190/185/180/175 各档递减，175 以下不计", () => {
    const score = (cm: number) =>
      assignRelevanceScore({ height: cm }, "cd_threat");
    expect(
      [195, 194, 190, 189, 185, 184, 180, 179, 175, 174].map(score),
    ).toEqual([40, 32, 32, 24, 24, 16, 16, 8, 8, 0]);
  });

  it("身高取不到时回退 game_attrs.height（club 侧两种口径都要认）", () => {
    expect(
      assignRelevanceScore({ height: null, attrs: { height: 191 } }, "cd_threat"),
    ).toBe(32);
    expect(
      assignRelevanceScore({ attrs: { height: 196, strength: 85 } }, "cd_threat"),
    ).toBe(40 + 45);
  });

  it("徽章不计分：只有徽章的人不会凭空排到前面（排序必须可解释）", () => {
    const base = { attrs: { curve: 88, freekickaccuracy: 88, finishing: 88, longshots: 88 } };
    const withBadge = assignRelevanceScore(
      { ...base, playstyles: [104] },
      "fk_left_short",
    );
    expect(withBadge).toBe(assignRelevanceScore(base, "fk_left_short"));
    expect(assignRelevanceScore({ playstyles: [104, 126] }, "cd_threat")).toBe(0);
  });

  it("单调性：同一角色把它相关的那项调高，分数不会下降", () => {
    const score = (curve: number) =>
      assignRelevanceScore(
        { attrs: { curve, freekickaccuracy: 70, finishing: 70, longshots: 70 } },
        "fk_long",
      );
    let prev = -1;
    for (const v of [0, 30, 45, 60, 75, 90, 99]) {
      const cur = score(v);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
    expect(score(99)).toBeGreaterThan(score(45));
  });
});
