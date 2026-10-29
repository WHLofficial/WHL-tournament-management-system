// 球员自己的角色档（shared/playerRoles.ts）——纯展示层，钉住四件事：
// ① 无 meta / 无 attrs / RoleID 全 0 都安静返回空表（业务线上未同步数据的球员照样能渲染）；
// ② 脏 id（非整数、映射表没有的值）跳过而不是抛错——平台镜像里 0 是常态、脏值不该炸页面；
// ③ 同槽位多枚取最高档（与 fitScore 的 roleHit 同口径，否则 UI 显示的档和加分档会打架）；
// ④ 排序 tier 降序 → 槽位字典序、tag 拼法（"PO++"/"BTB+"）与 tier→加号映射。
import { describe, expect, it } from "vitest";
import type { PlayerMeta } from "../shared/types";
import {
  ownRoleTag,
  playerOwnRoles,
  roleMark,
} from "../shared/playerRoles";

const meta = (attrs: Record<string, number>): PlayerMeta => ({ attrs });

describe("playerOwnRoles", () => {
  it("无 meta / 无 attrs / 无角色 id 都返回空表", () => {
    expect(playerOwnRoles(null)).toEqual([]);
    expect(playerOwnRoles(undefined)).toEqual([]);
    expect(playerOwnRoles({})).toEqual([]);
    expect(playerOwnRoles(meta({ RoleID1: 0, RoleID2: 0 }))).toEqual([]);
  });

  it("脏 id 安静跳过：非整数、映射表没有的值都不炸", () => {
    expect(
      playerOwnRoles(meta({ RoleID1: 999, RoleID2: 1.5, RoleID3: 18 })),
    ).toEqual([{ slot: "CM|BTB", pos: "CM", role: "BTB", tier: 1 }]);
  });

  it("同槽位多枚取最高档（与 fitScore roleHit 同口径）", () => {
    // 18 = CM|BTB 熟悉(+)，118 = CM|BTB 世界级(++)
    expect(playerOwnRoles(meta({ RoleID1: 18, RoleID2: 118 }))).toEqual([
      { slot: "CM|BTB", pos: "CM", role: "BTB", tier: 2 },
    ]);
  });

  it("排序：世界级在前，同档按槽位字典序", () => {
    // 118 = CM|BTB ++、142 = ST|PO ++、11 = CB|D +、33 = CAM|HW +
    const got = playerOwnRoles(
      meta({ RoleID1: 18, RoleID2: 142, RoleID3: 33, RoleID4: 118, RoleID5: 11 }),
    );
    expect(got.map((r) => `${r.slot}#${r.tier}`)).toEqual([
      "CM|BTB#2",
      "ST|PO#2",
      "CAM|HW#1",
      "CB|D#1",
    ]);
  });
});

describe("标签与查档", () => {
  it("roleMark / ownRoleTag 拼法", () => {
    expect(roleMark(1)).toBe("+");
    expect(roleMark(2)).toBe("++");
    const [r] = playerOwnRoles(meta({ RoleID1: 142 }));
    expect(r.slot).toBe("ST|PO");
    expect(ownRoleTag(r)).toBe("PO++");
  });
});
