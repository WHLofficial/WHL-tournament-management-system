// 角色适配权重表（shared/roleFit.ts）——钉住五件事：
// ① 49 个「位置|角色码」与 shared/tactics PTE26 的全部「位置×角色」组合一一对应（无孤儿、无缺配）；
// ② 每条恰 6 项属性、权重恰为 3/3/2/2/1/1（和 = 12）、键不重复；
// ③ 徽章 3-6 个、都是银基 psid、全部存在于 FC26_PLAYSTYLES、不重复；
// ④ RoleID/PosID 冻结映射的哨兵值（142 = ST 禁区之王 ++，与 club 仓 role.json 对齐的那次人工核对）；
// ⑤ FIT_ATTR_KEYS 确实是权重表键并集（trim 放宽的口径不被手抄漂移）。
import { describe, expect, it } from "vitest";
import { FC26_PLAYSTYLES } from "../shared/fc26Playstyles";
import {
  FC26_POS_BY_ID,
  FC26_ROLE_BY_ID,
  FIT_ATTR_KEYS,
  ROLE_FIT,
} from "../shared/roleFit";
import { PTE26 } from "../shared/tactics";

// PTE26 的全部「位置×角色」去重（同一角色带多个重心，去重后恰 49 个）
const slotKeys = [
  ...new Set(
    Object.entries(PTE26).flatMap(([pos, list]) =>
      list.map((e) => `${pos}|${e.role}`),
    ),
  ),
];

const silverBaseIds = new Set(
  FC26_PLAYSTYLES.filter((p) => p.id > 0 && p.id < 100).map((p) => p.id),
);

describe("角色适配权重表", () => {
  it("49 个「位置|角色码」与 PTE26 全组合一一对应（无孤儿、无缺配）", () => {
    expect(slotKeys).toHaveLength(49);
    expect(Object.keys(ROLE_FIT)).toHaveLength(49);
    expect(new Set(Object.keys(ROLE_FIT))).toEqual(new Set(slotKeys));
  });

  it("每条恰 6 项属性，权重恰为 3/3/2/2/1/1（和 = 12），属性键不重复", () => {
    for (const [key, p] of Object.entries(ROLE_FIT)) {
      expect(p.attrs, key).toHaveLength(6);
      expect(
        p.attrs.map(([, w]) => w).sort((a, b) => a - b),
        key,
      ).toEqual([1, 1, 2, 2, 3, 3]);
      expect(
        p.attrs.reduce((s, [, w]) => s + w, 0),
        key,
      ).toBe(12);
      expect(new Set(p.attrs.map(([k]) => k)).size, key).toBe(6);
    }
  });

  it("每条 3-6 个徽章，都是银基 psid 且存在于 FC26_PLAYSTYLES，不重复", () => {
    for (const [key, p] of Object.entries(ROLE_FIT)) {
      expect(p.badges.length, key).toBeGreaterThanOrEqual(3);
      expect(p.badges.length, key).toBeLessThanOrEqual(6);
      expect(new Set(p.badges).size, key).toBe(p.badges.length);
      for (const psid of p.badges) {
        expect(silverBaseIds.has(psid), `${key} 徽章 psid ${psid}`).toBe(true);
      }
    }
  });

  it("zh 中文名非空（候选面板展示用）", () => {
    for (const [key, p] of Object.entries(ROLE_FIT)) {
      expect(p.zh.trim().length, key).toBeGreaterThan(0);
    }
  });

  it("role 级权重：左右镜像的同角色共用一份（LB/RB、LM/RM、LW/RW、四路边锋族）", () => {
    const same = (a: string, b: string) => {
      expect(ROLE_FIT[a].attrs, a).toEqual(ROLE_FIT[b].attrs);
      expect(ROLE_FIT[a].badges, a).toEqual(ROLE_FIT[b].badges);
    };
    for (const c of ["FB", "WB", "FAB", "AWB", "IWB"]) same(`LB|${c}`, `RB|${c}`);
    for (const c of ["W", "WP", "IF"]) {
      same(`LM|${c}`, `RM|${c}`);
      same(`LW|${c}`, `RW|${c}`);
      same(`LM|${c}`, `LW|${c}`);
    }
    same("LM|WM", "RM|WM");
  });

  it("FIT_ATTR_KEYS = 全部权重键的并集（去重排序，不含 CA/PA）", () => {
    const union = new Set(
      Object.values(ROLE_FIT).flatMap((p) => p.attrs.map(([k]) => k)),
    );
    expect(FIT_ATTR_KEYS).toEqual([...union].sort());
    expect(FIT_ATTR_KEYS).not.toContain("CA");
    expect(FIT_ATTR_KEYS).not.toContain("PA");
  });
});

describe("RoleID/PosID 冻结映射（scripts/freeze-fc26-refs.mjs 生成）", () => {
  it("哨兵值：142 = ST|PO tier 2（ST 禁区之王 ++），另有 1/45/148 三个跨段锚点", () => {
    expect(FC26_ROLE_BY_ID[142]).toEqual({ slot: "ST|PO", tier: 2 });
    expect(FC26_ROLE_BY_ID[1]).toEqual({ slot: "GK|GK", tier: 1 });
    expect(FC26_ROLE_BY_ID[45]).toEqual({ slot: "GK|BPK", tier: 1 });
    expect(FC26_ROLE_BY_ID[148]).toEqual({ slot: "CB|WDB", tier: 2 });
  });

  it("98 个 RoleID = 49 槽位 × +/++ 两档，slot 全部落在 ROLE_FIT 里", () => {
    expect(Object.keys(FC26_ROLE_BY_ID)).toHaveLength(98);
    const bySlot = new Map<string, number[]>();
    for (const m of Object.values(FC26_ROLE_BY_ID)) {
      expect([1, 2], m.slot).toContain(m.tier);
      expect(ROLE_FIT[m.slot], m.slot).toBeDefined();
      bySlot.set(m.slot, [...(bySlot.get(m.slot) ?? []), m.tier]);
    }
    expect(bySlot.size).toBe(49);
    for (const [slot, tiers] of bySlot) {
      expect(tiers.sort(), slot).toEqual([1, 2]);
    }
  });

  it("PosID：0=GK、27=LW、5=CB，共 13 条（含 -1 无位置占位）", () => {
    expect(FC26_POS_BY_ID[0]).toBe("GK");
    expect(FC26_POS_BY_ID[27]).toBe("LW");
    expect(FC26_POS_BY_ID[5]).toBe("CB");
    expect(FC26_POS_BY_ID[-1]).toBe("-");
    expect(Object.keys(FC26_POS_BY_ID)).toHaveLength(13);
  });
});
