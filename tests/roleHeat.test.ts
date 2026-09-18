// 角色热区（FC26，抓自 futbin 的角色页 + 阵型编辑器内嵌数据）测试：钉死数据完整性与方向。
// 五件事：113 个组合与 PTE26_RAW 一一对应、每张图 25 位 0-3、
// 行 0 是对方球门端（门将亮末行、中锋亮首行）、左右成对的位置互为逐行镜像、
// 中轴线上的五个位置有左右两套变体且都与默认不同。
import { describe, expect, it } from "vitest";
import { HEAT_COLS, HEAT_ROWS, ROLE_HEAT, ROLE_HEAT_SIDE, heatOf } from "../shared/roleHeat";
import { PTE26 } from "../shared/tactics";

const combos = Object.entries(PTE26).flatMap(([pos, list]) =>
  list.map((e) => `${pos} ${e.role}/${e.focus}`),
);
function rows(key: string): string[] {
  const raw = ROLE_HEAT[key];
  return Array.from({ length: HEAT_ROWS }, (_, r) => raw.slice(r * HEAT_COLS, (r + 1) * HEAT_COLS));
}
const zeros = (s: string) => /^0+$/.test(s);

describe("角色热区数据", () => {
  it("键与 PTE26 的 113 个「位置 角色/重心」一一对应", () => {
    expect(Object.keys(ROLE_HEAT)).toHaveLength(113);
    expect(new Set(Object.keys(ROLE_HEAT))).toEqual(new Set(combos));
    expect(combos).toHaveLength(113);
  });

  it("每张图都是 25 位、只含 0-3", () => {
    for (const [key, raw] of Object.entries(ROLE_HEAT)) expect(raw, key).toMatch(/^[0-3]{25}$/);
  });

  it("方向：门将只亮己方球门那一行，中锋的点球抢点只亮对方球门那一行", () => {
    const gk = rows("GK GK/Defend");
    expect(gk.slice(0, HEAT_ROWS - 1).every(zeros)).toBe(true);
    expect(gk[HEAT_ROWS - 1]).toBe("01310");
    const poacher = rows("ST PO/Attack");
    expect(poacher[0]).toBe("01310");
    expect(poacher.slice(1).every(zeros)).toBe(true);
  });

  it("方向：中前卫的 Box-to-Box 是贯穿全场的中央纵脊", () => {
    expect(rows("CM BTB/Balanced")).toEqual(["00100", "00300", "01310", "00300", "00100"]);
  });

  it("左右成对的位置互为逐行镜像（LB↔RB、LM↔RM、LW↔RW）", () => {
    for (const [left, right] of [
      ["LB", "RB"],
      ["LM", "RM"],
      ["LW", "RW"],
    ]) {
      for (const e of PTE26[left]) {
        const key = `${e.role}/${e.focus}`;
        expect(rows(`${right} ${key}`), `${right} ${key}`).toEqual(
          rows(`${left} ${key}`).map((r) => [...r].reverse().join("")),
        );
      }
    }
  });

  it("heatOf：认识的组合给 25 个数字，不认识给 null", () => {
    expect(heatOf("LB", "FB", "Balanced")).toHaveLength(25);
    expect(heatOf("CDM", "H", "Defend")).toHaveLength(25);
    expect(heatOf("XX", "FB", "Balanced")).toBeNull();
    expect(heatOf("LB", "FB", "Nope")).toBeNull();
  });
});

describe("中轴线位置的左右变体", () => {
  const SIDE_POS = ["CB", "CDM", "CM", "CAM", "ST"];

  it("只有中轴线上的五个位置有左右两套，共 52 个组合", () => {
    expect(Object.keys(ROLE_HEAT_SIDE)).toHaveLength(52);
    const withSide = combos.filter((k) => ROLE_HEAT_SIDE[k]);
    expect(withSide).toHaveLength(52);
    for (const k of withSide) expect(SIDE_POS, k).toContain(k.split(" ")[0]);
    for (const k of combos) {
      if (!SIDE_POS.includes(k.split(" ")[0])) expect(ROLE_HEAT_SIDE[k], k).toBeUndefined();
    }
  });

  it("两套变体都是 25 位 0-3，且都与默认那一套不同", () => {
    for (const [key, pair] of Object.entries(ROLE_HEAT_SIDE)) {
      expect(pair, key).toHaveLength(2);
      expect(pair[0], key).toMatch(/^[0-3]{25}$/);
      expect(pair[1], key).toMatch(/^[0-3]{25}$/);
      expect(pair[0], key).not.toBe(ROLE_HEAT[key]);
      expect(pair[1], key).not.toBe(ROLE_HEAT[key]);
    }
  });

  it("方向：同一个角色的左右两套分别贴向自己那一侧（CB Defend 末行 左 13200 / 中 02320 / 右 00231）", () => {
    const [l, r] = ROLE_HEAT_SIDE["CB D/Defend"];
    expect(l.slice(20)).toBe("13200");
    expect(ROLE_HEAT["CB D/Defend"].slice(20)).toBe("02320");
    expect(r.slice(20)).toBe("00231");
  });

  it("heatOf 传 side：中轴线位置取变体，边路位置仍取默认那一套", () => {
    expect(heatOf("CB", "D", "Defend", "L")).toEqual([...ROLE_HEAT_SIDE["CB D/Defend"][0]].map(Number));
    expect(heatOf("CB", "D", "Defend", "R")).toEqual([...ROLE_HEAT_SIDE["CB D/Defend"][1]].map(Number));
    expect(heatOf("CB", "D", "Defend")).toEqual([...ROLE_HEAT["CB D/Defend"]].map(Number));
    expect(heatOf("CB", "D", "Defend", "L")).not.toEqual(heatOf("CB", "D", "Defend"));
    expect(heatOf("ST", "AF", "Attack", "L")).not.toEqual(heatOf("ST", "AF", "Attack", "R"));
    // 边路位置的热区本身已经分了左右，没有第二套
    expect(heatOf("LB", "FB", "Balanced", "L")).toEqual(heatOf("LB", "FB", "Balanced"));
    expect(heatOf("GK", "GK", "Defend", "R")).toEqual(heatOf("GK", "GK", "Defend"));
  });
});
