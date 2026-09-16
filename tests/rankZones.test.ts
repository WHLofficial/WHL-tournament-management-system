import { describe, it, expect } from "vitest";
import {
  parseRankZoneSettings,
  validateRankZoneSettings,
  matchRankZone,
  zonesForTable,
  MAX_ZONES,
} from "../shared/rankZones";
import type { RankZone } from "../shared/types";

const zone = (p: Partial<RankZone>): RankZone => ({
  id: "z1",
  name: "升级区",
  from: 1,
  to: 2,
  color: "#16a34a",
  enabled: true,
  scope: { kind: "all" },
  ...p,
});

describe("parseRankZoneSettings", () => {
  it("坏 JSON / 缺 zones 返回 null（未配置）", () => {
    expect(parseRankZoneSettings("{oops")).toBeNull();
    expect(parseRankZoneSettings(null)).toBeNull();
    expect(parseRankZoneSettings("{}")).toBeNull();
    expect(parseRankZoneSettings('{"rankZones":{"style":"strip"}}')).toBeNull();
  });

  it("合法配置解析出 style 与 zones，缺省 style 为 strip", () => {
    const cfg = JSON.stringify({
      rankZones: {
        style: "divider",
        zones: [{ id: "a", name: "升级区", from: 1, to: 2, color: "#16a34a", scope: { kind: "all" } }],
      },
    });
    const parsed = parseRankZoneSettings(cfg);
    expect(parsed).toEqual({ style: "divider", zones: [{ id: "a", name: "升级区", from: 1, to: 2, color: "#16a34a", enabled: true, scope: { kind: "all" } }] });
    expect(parseRankZoneSettings('{"rankZones":{"zones":[{"id":"a","name":"降级区","from":9,"to":9,"color":"#dc2626","scope":{"kind":"all"},"enabled":false}]}}'))
      .toEqual({ style: "strip", zones: [{ id: "a", name: "降级区", from: 9, to: 9, color: "#dc2626", enabled: false, scope: { kind: "all" } }] });
  });

  it("非法条目静默丢弃，全非法时返回 null", () => {
    const cfg = JSON.stringify({
      rankZones: {
        zones: [
          { name: "", from: 1, to: 2, color: "#16a34a", scope: { kind: "all" } }, // 空名
          { name: "坏颜色", from: 1, to: 2, color: "red", scope: { kind: "all" } }, // 非 #rrggbb
          { name: "坏区间", from: 3, to: 2, color: "#16a34a", scope: { kind: "all" } }, // 起点>终点
          { name: "坏scope", from: 1, to: 2, color: "#16a34a", scope: { kind: "stage" } }, // scope 缺 id
          { id: "ok", name: "正常", from: 5, to: 6, color: "#2563eb", scope: { kind: "all" } },
        ],
      },
    });
    expect(parseRankZoneSettings(cfg)).toEqual({
      style: "strip",
      zones: [{ id: "ok", name: "正常", from: 5, to: 6, color: "#2563eb", enabled: true, scope: { kind: "all" } }],
    });
  });

  it("存储形状（rankZones 数组 + rankZoneStyle）与对象形状都能解析", () => {
    const zone = { id: "a", name: "升级区", from: 1, to: 2, color: "#16a34a", enabled: true, scope: { kind: "all" } };
    // PATCH 落库形状：config_json.rankZones 为数组，样式在 rankZoneStyle
    expect(parseRankZoneSettings(JSON.stringify({ loops: 2, rankZoneStyle: "strip", rankZones: [zone] })))
      .toEqual({ style: "strip", zones: [zone] });
    expect(parseRankZoneSettings(JSON.stringify({ rankZoneStyle: "divider", rankZones: [zone] })))
      .toEqual({ style: "divider", zones: [zone] });
    // 对象形状兼容（直接写库的旧数据）
    expect(parseRankZoneSettings(JSON.stringify({ rankZones: { style: "strip", zones: [zone] } })))
      .toEqual({ style: "strip", zones: [zone] });
  });
});

describe("validateRankZoneSettings", () => {
  it("合法配置原样通过", () => {
    const input = {
      style: "strip",
      zones: [{ id: "a", name: "降级区", from: 9, to: 10, color: "#dc2626", enabled: true, scope: { kind: "all" } }],
    };
    expect(validateRankZoneSettings(input)).toEqual(input);
  });

  it("样式/条目/数量/重复 id 报中文错误", () => {
    expect(validateRankZoneSettings({ style: "rainbow", zones: [] })).toBe("展示样式无效");
    expect(validateRankZoneSettings({ zones: "no" })).toBe("排名段标记配置无效");
    expect(validateRankZoneSettings({ zones: [{ name: "x", from: 1, to: 99, color: "red", scope: { kind: "all" } }] })).toMatch(/无效条目/);
    const many = Array.from({ length: MAX_ZONES + 1 }, (_, i) => ({
      id: `z${i}`, name: `n${i}`, from: 1, to: 1, color: "#16a34a", scope: { kind: "all" },
    }));
    expect(validateRankZoneSettings({ zones: many })).toMatch(/至多 12 条/);
    expect(
      validateRankZoneSettings({
        zones: [
          { id: "same", name: "A", from: 1, to: 1, color: "#16a34a", scope: { kind: "all" } },
          { id: "same", name: "B", from: 2, to: 2, color: "#dc2626", scope: { kind: "all" } },
        ],
      })
    ).toMatch(/重复条目/);
  });
});

describe("matchRankZone", () => {
  const zones: RankZone[] = [
    zone({ id: "top", name: "升级区", from: 1, to: 2, color: "#16a34a", scope: { kind: "all" } }),
    zone({ id: "stage", name: "组赛限定", from: 1, to: 3, color: "#2563eb", scope: { kind: "stage", stageId: 7 } }),
    zone({ id: "grp", name: "A组限定", from: 2, to: 4, color: "#d97706", scope: { kind: "group", groupId: 3 } }),
    zone({ id: "off", name: "停用", from: 1, to: 99, color: "#6b7280", enabled: false, scope: { kind: "all" } }),
  ];

  it("数组顺序即优先级，取第一条命中", () => {
    // 第 2 名同时命中 top/all、stage、grp、off（停用跳过）→ 取最前的 top
    expect(matchRankZone(2, zones, 7, 3)?.id).toBe("top");
    // 第 4 名：all 不覆盖、stage 不到 4、grp 命中
    expect(matchRankZone(4, zones, 7, 3)?.id).toBe("grp");
  });

  it("scope 限定生效，组表 groupId=null 时 group scope 不命中", () => {
    expect(matchRankZone(3, zones, 7, 9)?.id).toBe("stage");
    expect(matchRankZone(3, zones, 7, null)?.id).toBe("stage");
    // group scope 在非本组不命中、stage 不命中、all 不覆盖 → null
    expect(matchRankZone(4, zones, 8, 9)).toBeNull();
  });

  it("未命中任何返回 null，停用条目跳过", () => {
    expect(matchRankZone(99, zones, 8, null)).toBeNull();
    expect(matchRankZone(50, [zones[3]], 8, 3)).toBeNull();
  });
});

describe("zonesForTable", () => {
  const zones: RankZone[] = [
    zone({ id: "all", scope: { kind: "all" } }),
    zone({ id: "stage", scope: { kind: "stage", stageId: 7 }, enabled: false }),
    zone({ id: "stage2", scope: { kind: "stage", stageId: 8 } }),
    zone({ id: "grp", scope: { kind: "group", groupId: 3 } }),
  ];

  it("按 scope 过滤适用标记，停用与不匹配的排除，保持优先级顺序", () => {
    expect(zonesForTable(zones, 7, [3]).map((z) => z.id)).toEqual(["all", "grp"]);
    expect(zonesForTable(zones, 8, [9]).map((z) => z.id)).toEqual(["all", "stage2"]);
    expect(zonesForTable(zones, 8, [])?.map((z) => z.id)).toEqual(["all", "stage2"]);
  });
});
