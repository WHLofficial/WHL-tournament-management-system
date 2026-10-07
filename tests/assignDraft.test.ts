// 战术页与定位球编排页共用的草稿层（src/lib/assignDraft.ts）。钉三件事：
// ① URL 里的 scope 只认本队 ftc26 与代打 ftc26-proxy-<mid>，别的一律退回本队 —— 手改地址栏
//    不能把草稿写到莫名其妙的键上；② 指派白名单过滤与后端 parseAssignJson 同口径（坏数据当没填）；
// ③ 候选行的 FC26 数据有两个来源（已提交阵容 DTO > 名册自带），首次起草时只有后者，
//    这条链断了候选行就全是「无数据」—— 正是本次要修的缺口。
import { describe, expect, it } from "vitest";
import {
  DRAFT_KEYS,
  assignCandidatesOf,
  assignPoolOf,
  parseScopeParam,
  sanitizeAssign,
  type RosterPlayer,
} from "../src/lib/assignDraft";

describe("DRAFT_KEYS", () => {
  it("按 scope 隔离三份草稿（与战术页 wantScope 同口径）", () => {
    expect(DRAFT_KEYS("ftc26")).toEqual({
      state: "ftc26-state-v1",
      names: "ftc26-names-v1",
      assign: "ftc26-assign-v1",
    });
    expect(DRAFT_KEYS("ftc26-proxy-802").assign).toBe("ftc26-proxy-802-assign-v1");
  });
});

describe("parseScopeParam", () => {
  it("认代打场次", () => {
    expect(parseScopeParam("ftc26-proxy-802")).toEqual({ scope: "ftc26-proxy-802", proxyMid: 802 });
  });

  it("本队、空、以及所有不认识的写法都退回本队", () => {
    expect(parseScopeParam(null)).toEqual({ scope: "ftc26", proxyMid: null });
    expect(parseScopeParam("ftc26-proxy-")).toEqual({ scope: "ftc26", proxyMid: null });
    expect(parseScopeParam("ftc26-proxy-x")).toEqual({ scope: "ftc26", proxyMid: null });
    expect(parseScopeParam(" ftc26-proxy-1")).toEqual({ scope: "ftc26", proxyMid: null });
    expect(parseScopeParam("ftc26-proxy-1-2")).toEqual({ scope: "ftc26", proxyMid: null });
  });
});

describe("sanitizeAssign", () => {
  it("只留认识的项 + 正整数，其余当没填", () => {
    expect(
      sanitizeAssign({
        captain: 7,
        ca_left: 9,
        fk_left_short: 0,
        ca_right: -3,
        ti_left: 2.5,
        ca_near: "8",
        bogus: 5,
      }),
    ).toEqual({ captain: 7, ca_left: 9 });
  });

  it("非对象一律空表（数组 / null / 字符串 / 数字）", () => {
    expect(sanitizeAssign(null)).toEqual({});
    expect(sanitizeAssign([["captain", 7]])).toEqual({});
    expect(sanitizeAssign("captain")).toEqual({});
    expect(sanitizeAssign(7)).toEqual({});
  });
});

describe("assignPoolOf", () => {
  const POS = [
    { lid: 1, position: "GK" },
    { lid: 2, position: "LB" },
    { lid: 5, position: "LCB" },
    { lid: 9, position: "ST" },
    { lid: 10, position: "ST" },
  ];

  it("按人去重：一人占两格时位置串起来", () => {
    const names = { "1": "101", "2": "102", "5": "102", "9": "103", "10": "104" };
    expect(assignPoolOf(POS, names)).toEqual([
      { id: 101, pos: "GK" },
      { id: 102, pos: "LB/LCB" },
      { id: 103, pos: "ST" },
      { id: 104, pos: "ST" },
    ]);
  });

  it("没摆人或登记了非法球员号的格子跳过（不占位、不影响别的格子）", () => {
    const names = { "1": "101", "2": "", "5": "0", "9": "-4", "10": "8.5" };
    expect(assignPoolOf(POS, names)).toEqual([{ id: 101, pos: "GK" }]);
  });
});

describe("assignCandidatesOf", () => {
  const ROSTER: RosterPlayer[] = [
    { id: 101, name: "张三", number: "7", meta: { height: 190, attrs: { headingaccuracy: 88 } } },
    { id: 102, name: "李四", number: "9" },
  ];

  it("未提交阵容时靠名册自带的 meta：胶囊与徽章才有得渲染", () => {
    const out = assignCandidatesOf(
      [
        { id: 101, pos: "LCB" },
        { id: 102, pos: "ST" },
      ],
      ROSTER,
    );
    expect(out).toEqual([
      {
        playerId: 101,
        name: "张三",
        number: "7",
        pos: "LCB",
        meta: { height: 190, attrs: { headingaccuracy: 88 } },
      },
      { playerId: 102, name: "李四", number: "9", pos: "ST", meta: undefined },
    ]);
  });

  it("已提交阵容 DTO 的 meta 优先（能覆盖已指派但已不在首发的人）", () => {
    const dtoMeta = new Map([[101, { height: 181 }]]);
    const out = assignCandidatesOf([{ id: 101, pos: "LCB" }], ROSTER, dtoMeta);
    expect(out[0].meta).toEqual({ height: 181 });
  });

  it("名册没这个人（名单还没回来 / 已离队）：名字号码缺省为 null 且没有 meta", () => {
    expect(assignCandidatesOf([{ id: 999, pos: "ST" }], ROSTER)).toEqual([
      { playerId: 999, name: null, number: null, pos: "ST", meta: undefined },
    ]);
    // 名册整个还没加载（null）时也一样能算出候选行，不抛
    expect(assignCandidatesOf([{ id: 999, pos: "ST" }], null)[0].name).toBeNull();
  });

  it("空池就是空表", () => {
    expect(assignCandidatesOf([], ROSTER)).toEqual([]);
  });
});
