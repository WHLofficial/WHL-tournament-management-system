// 定位球编排页半场板的摆位规范（src/lib/assignBoard.ts）。坐标是板子宽高的百分比，钉子在板上居中，
// 所以这层只钉三件事：
// ① 18 个 AssignKey 一个不落地有摆位，且都落在板子里（钉子自己有高度，贴边会被板子裁掉）；
// ② 同一组里任意两个钉子分得开（钉子 74px 宽 / 约 34px 高，板子按 600x470 估：
//    12 个「板宽百分点」宽的钉子 → 中心距 ≥15 才不会压在一起），所以坐标不能在闭区间里乱挪；
// ③ 攻守板归属：定位球四组有板子，队长组没有（null）。
import { describe, expect, it } from "vitest";
import { ASSIGN_GROUPS, ASSIGN_KEYS } from "../shared/tactics";
import { ASSIGN_BOARD_SIDE, ASSIGN_NAILS, boardSideOf } from "../src/lib/assignBoard";

describe("半场板摆位（ASSIGN_NAILS）", () => {
  it("18 个指派键都有摆位，坐标都在板内", () => {
    expect(Object.keys(ASSIGN_NAILS).sort()).toEqual([...ASSIGN_KEYS].sort());
    for (const key of ASSIGN_KEYS) {
      const n = ASSIGN_NAILS[key];
      expect(n.short.length, `${key} 的短码`).toBeGreaterThan(0);
      expect(n.short.length, `${key} 的短码太长`).toBeLessThanOrEqual(3);
      expect(n.x, `${key} 的 x`).toBeGreaterThan(3);
      expect(n.x, `${key} 的 x`).toBeLessThan(97);
      expect(n.y, `${key} 的 y`).toBeGreaterThan(3);
      expect(n.y, `${key} 的 y`).toBeLessThan(97);
    }
  });

  it("同组任意两个钉子都分得开（中心距 ≥15 个板宽百分点）", () => {
    // 板子 aspect-ratio 100/78：纵向 1 个百分点 = 0.78 个横向百分点，换算到同一把尺子再比
    for (const g of ASSIGN_GROUPS) {
      const nails = g.items.map((it) => ASSIGN_NAILS[it.key]);
      for (let i = 0; i < nails.length; i += 1) {
        for (let j = i + 1; j < nails.length; j += 1) {
          const gap = Math.hypot(nails[i].x - nails[j].x, (nails[i].y - nails[j].y) * 0.78);
          expect(gap, `${g.title}：${g.items[i].label} 与 ${g.items[j].label} 挨太近`).toBeGreaterThanOrEqual(15);
        }
      }
    }
  });
});

describe("哪几组有半场板（ASSIGN_BOARD_SIDE / boardSideOf）", () => {
  it("定位球四组有板子：角球防守是守板，其余三组是攻板", () => {
    expect(boardSideOf("角球防守")).toBe("defense");
    expect(boardSideOf("任意球")).toBe("attack");
    expect(boardSideOf("角球进攻")).toBe("attack");
    expect(boardSideOf("界外球")).toBe("attack");
  });

  it("队长组没有板子（纯候选列表）", () => {
    expect(boardSideOf("队长")).toBeNull();
    expect(Object.keys(ASSIGN_BOARD_SIDE).sort()).toEqual(["任意球", "界外球", "角球进攻", "角球防守"].sort());
  });

  it("有板的组里每一项都查得到钉子", () => {
    for (const g of ASSIGN_GROUPS) {
      if (!boardSideOf(g.title)) continue;
      expect(g.items.length, `${g.title} 的槽位数`).toBeGreaterThan(0);
      for (const it of g.items) expect(ASSIGN_NAILS[it.key], `${g.title} · ${it.label}`).toBeTruthy();
    }
  });
});
