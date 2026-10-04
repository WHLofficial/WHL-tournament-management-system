// 淘汰赛「出线队」解析（resolveQualifiers）与首轮空席位候选占位文案（firstRoundSeatLabels）的纯函数测试。
// 规则见 docs/superpowers/specs/2026-10-04-knockout-manual-bracket-design.md §3.4/§3.5；
// cross token 顺序与生成端一致：第 s 场 = 展平后第 2s-2、2s-1 个 token（前主后客）。
import { describe, it, expect } from "vitest";
import {
  resolveQualifiers,
  firstRoundSeatLabels,
  type QualifierRow,
} from "../worker/lib/qualifiers";

const row = (
  entryId: number,
  teamName: string,
  rank: number,
  groupName: string | null = null
): QualifierRow => ({ entryId, teamName, rank, groupName });

// A 组：1 甲一（第 1）/ 2 甲二（第 2）；B 组：3 乙一（第 1）/ 4 乙二（第 2）
const groupRows: QualifierRow[] = [
  row(1, "甲一", 1, "A"),
  row(2, "甲二", 2, "A"),
  row(3, "乙一", 1, "B"),
  row(4, "乙二", 2, "B"),
];
const crossCfg = { source: { cross: ["A1-B2", "B1-A2"] } };
const none = { home: null, away: null };

describe("resolveQualifiers", () => {
  it("cross 名次已定：按 token 顺序给出具体 entryId", () => {
    // A1-B2, B1-A2 → [1,4,3,2]
    expect(resolveQualifiers(crossCfg, groupRows)).toEqual([1, 4, 3, 2]);
  });

  it("cross 名次未定（无榜单行）：返回空", () => {
    expect(resolveQualifiers(crossCfg, [])).toEqual([]);
  });

  it("cross 部分名次缺失：已定的照出，缺失的跳过", () => {
    expect(resolveQualifiers(crossCfg, [groupRows[0], groupRows[2]])).toEqual([1, 3]);
  });

  it("range：取名次区间内的队，按名次升序；from 缺省 1、to 缺省 take ?? from", () => {
    const rows = [row(11, "一", 1), row(12, "二", 2), row(13, "三", 3), row(14, "四", 4)];
    expect(resolveQualifiers({ source: { from: 2, to: 3 } }, rows)).toEqual([12, 13]);
    expect(resolveQualifiers({ source: { take: 2 } }, rows)).toEqual([11, 12]);
    expect(resolveQualifiers({ source: { from: 3 } }, rows)).toEqual([13]);
    expect(resolveQualifiers({ source: { from: 2, take: 4 } }, rows)).toEqual([12, 13, 14]);
  });

  it("range 越界 / 非法区间：返回空（不抛）", () => {
    const rows = [row(11, "一", 1), row(12, "二", 2)];
    expect(resolveQualifiers({ source: { from: 5, to: 9 } }, rows)).toEqual([]);
    expect(resolveQualifiers({ source: { from: 3, to: 2 } }, rows)).toEqual([]);
    expect(resolveQualifiers({ source: { from: "abc", to: 2 } }, rows)).toEqual([]);
    expect(resolveQualifiers({ source: { take: 0 } }, rows)).toEqual([]);
  });

  it("脏数据：非法 token / cross 非数组 / 配置缺失 均不抛异常", () => {
    // 字符串 "42" 被当 cross 配置但 token 非法 → 空
    expect(resolveQualifiers({ source: { cross: "42" } }, groupRows)).toEqual([]);
    // 非数组非字符串 → 视为未配置
    expect(resolveQualifiers({ source: { cross: 42 } }, groupRows)).toEqual([]);
    // X1（组超 A-P）、A0（名次 0）非法跳过；残留单 token A1 仍解析
    expect(resolveQualifiers({ source: { cross: ["X1-B2", "A0-C1", "A1"] } }, groupRows)).toEqual([4, 1]);
    expect(resolveQualifiers({}, groupRows)).toEqual([]);
    expect(resolveQualifiers(undefined, groupRows)).toEqual([]);
    expect(resolveQualifiers(null, groupRows)).toEqual([]);
  });

  it("兼容：逗号分隔 cross 字符串 / 直接传 source 对象 / 「A组」与小写组名", () => {
    expect(resolveQualifiers({ source: { cross: "A1-B2,B1-A2" } }, groupRows)).toEqual([1, 4, 3, 2]);
    expect(resolveQualifiers({ cross: ["A1-B2"] }, groupRows)).toEqual([1, 4]);
    const loose = [row(1, "甲一", 1, "a"), row(4, "乙二", 2, "B组")];
    expect(resolveQualifiers({ source: { cross: ["A1-B2"] } }, loose)).toEqual([1, 4]);
  });
});

describe("firstRoundSeatLabels", () => {
  it("cross 名次已定：直接给队名；slot 映射 = 第 2s-2 / 2s-1 个 token", () => {
    const base = { config: crossCfg, sourceStageKind: "group", sourceRows: groupRows };
    expect(firstRoundSeatLabels({ ...base, slot: 1 })).toEqual({ home: "甲一", away: "乙二" });
    expect(firstRoundSeatLabels({ ...base, slot: 2 })).toEqual({ home: "乙一", away: "甲二" });
    // 超出已配对的 token 数 → null
    expect(firstRoundSeatLabels({ ...base, slot: 3 })).toEqual(none);
  });

  it("cross 名次未定：回退 token 摘要「A 组第 1」", () => {
    expect(
      firstRoundSeatLabels({ config: crossCfg, sourceStageKind: "group", sourceRows: [], slot: 1 })
    ).toEqual({ home: "A 组第 1", away: "B 组第 2" });
  });

  it("cross 部分组有名次：已定的给队名，未定的给摘要", () => {
    expect(
      firstRoundSeatLabels({
        config: crossCfg,
        sourceStageKind: "group",
        sourceRows: [groupRows[0]],
        slot: 1,
      })
    ).toEqual({ home: "甲一", away: "B 组第 2" });
  });

  it("cross 脏 token：非法席位 null，合法席位不受错位影响（空场次保留配对位次）", () => {
    const cfg = { source: { cross: ["X1-B2", "A0-C1", "A1"] } };
    expect(
      firstRoundSeatLabels({ config: cfg, sourceStageKind: "group", sourceRows: groupRows, slot: 1 })
    ).toEqual({ home: null, away: "乙二" });
    expect(
      firstRoundSeatLabels({ config: cfg, sourceStageKind: "group", sourceRows: groupRows, slot: 2 })
    ).toEqual({ home: null, away: "C 组第 1" });
    expect(
      firstRoundSeatLabels({ config: cfg, sourceStageKind: "group", sourceRows: groupRows, slot: 3 })
    ).toEqual({ home: "甲一", away: null });
  });

  it("range ≤2 支：队名用「/」连接，两个席位同文案", () => {
    const rows = [row(11, "上海", 1), row(12, "北京", 2), row(13, "广州", 3)];
    const cfg = { source: { from: 2, to: 3 } };
    expect(
      firstRoundSeatLabels({ config: cfg, sourceStageKind: "round_robin", sourceStageName: "循环赛", sourceRows: rows, slot: 1 })
    ).toEqual({ home: "北京/广州", away: "北京/广州" });
    // 区间只有 1 支也照列
    expect(
      firstRoundSeatLabels({ config: { source: { from: 2, to: 2 } }, sourceStageKind: "round_robin", sourceStageName: "循环赛", sourceRows: rows, slot: 2 })
    ).toEqual({ home: "北京", away: "北京" });
  });

  it("range >2 支：概括「<来源阶段名> 第 from–to 名」（en dash）", () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(100 + i, `队${i + 1}`, i + 1));
    expect(
      firstRoundSeatLabels({
        config: { source: { from: 5, to: 8 } },
        sourceStageKind: "round_robin",
        sourceStageName: "小组赛",
        sourceRows: rows,
        slot: 4,
      })
    ).toEqual({ home: "小组赛 第 5–8 名", away: "小组赛 第 5–8 名" });
  });

  it("range 来源阶段名缺失：>2 支算不出回退 null；≤2 支不受影响", () => {
    const many = Array.from({ length: 4 }, (_, i) => row(100 + i, `队${i + 1}`, i + 1));
    expect(
      firstRoundSeatLabels({ config: { source: { from: 1, to: 4 } }, sourceStageKind: "round_robin", sourceRows: many, slot: 1 })
    ).toEqual(none);
    expect(
      firstRoundSeatLabels({ config: { source: { from: 1, to: 2 } }, sourceStageKind: "round_robin", sourceRows: many, slot: 1 })
    ).toEqual({ home: "队1/队2", away: "队1/队2" });
  });

  it("脏数据：越界区间 / 非法 slot / 配置缺失 / cross 非数组 / 来源 kind=elim 均不抛异常", () => {
    const rows = [row(11, "一", 1)];
    expect(
      firstRoundSeatLabels({ config: { source: { from: 5, to: 9 } }, sourceStageKind: "round_robin", sourceRows: rows, slot: 1 })
    ).toEqual(none);
    expect(firstRoundSeatLabels({ config: crossCfg, sourceRows: groupRows, slot: 0 })).toEqual(none);
    expect(firstRoundSeatLabels({ config: crossCfg, sourceRows: groupRows, slot: 1.5 })).toEqual(none);
    expect(firstRoundSeatLabels({ slot: 1 })).toEqual(none);
    expect(firstRoundSeatLabels({ config: 42, sourceRows: groupRows, slot: 1 })).toEqual(none);
    expect(firstRoundSeatLabels({ config: { source: { cross: 9 } }, sourceRows: groupRows, slot: 1 })).toEqual(none);
    expect(
      firstRoundSeatLabels({ config: crossCfg, sourceStageKind: "elim", sourceRows: groupRows, slot: 1 })
    ).toEqual(none);
  });

  it("兼容：直接传 source 对象 / 「A组」与小写组名", () => {
    expect(
      firstRoundSeatLabels({ config: { cross: ["A1-B2"] }, sourceRows: groupRows, slot: 1 })
    ).toEqual({ home: "甲一", away: "乙二" });
    const loose = [row(1, "甲一", 1, "a"), row(4, "乙二", 2, "B组")];
    expect(
      firstRoundSeatLabels({ config: crossCfg, sourceRows: loose, slot: 1 })
    ).toEqual({ home: "甲一", away: "乙二" });
  });
});
