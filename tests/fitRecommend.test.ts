// 一键推荐 + 阵型对比 + 替补角色化纯函数单测（src/lib/fitRecommend.ts，B2 计划 S2/S3/S4 / 计划 S5「补测」）：
// ① fitRecPool：排除停赛/伤停（isAvailable 注入口径）、无 meta 恒不进池、可用不足 11 放开全员；
// ② fitDiffRows：出/入/保持三分支、空槽（只有「入」）、无 meta 现任（显示「出」且 FIT 无数据）、
//    推荐没填上的槽（有现任照旧 keep / 空槽整行不出）、行序随槽序；
// ③ fitCompareRows：全阵型各跑一次 optimalXI——总分取整降序、各阵型按各自角色配槽、
//    展开明细短板在前（无推荐槽最先 → FIT 升序）、空池全 null 排尾；
// ④ fitBenchTopTags：替补「擅长」top3——fitTile 降序、跨位置群无档不进榜、并列稳定序。
import { describe, expect, it } from "vitest";
import {
  fitBenchTopTags,
  fitCompareRows,
  fitDiffRows,
  fitRecPool,
  type FitDiffSlot,
} from "../src/lib/fitRecommend";
import type { FitProfile, FitSlotScore } from "../shared/fitScore";

/** 手搭 FitSlotScore：注入数值同时当 score（fitTile 个人内排位用）与 rankRaw（排序/权重用） */
const score = (v: number): FitSlotScore =>
  ({ score: v, rankRaw: v, rankShown: Math.min(99, Math.round(v)) }) as FitSlotScore;
const prof = (bySlot: Record<string, number>): FitProfile =>
  new Map(Object.entries(bySlot).map(([k, v]) => [k, score(v)]));

describe("fitRecPool：候选池选取", () => {
  // 14 人：100 停赛、101 伤停（不可上场）；102/103 无 meta；其余可上场且有数据
  const players = Array.from({ length: 14 }, (_, i) => ({ id: 100 + i }));
  const isAvailable = (pid: number) => pid !== 100 && pid !== 101;
  const hasMeta = (pid: number) => pid !== 102 && pid !== 103;

  it("可上场 ≥ 11：不放开，池 = 可上场 ∩ 有 meta", () => {
    const r = fitRecPool(players, isAvailable, hasMeta);
    expect(r.widened).toBe(false);
    expect(r.pids).toEqual([104, 105, 106, 107, 108, 109, 110, 111, 112, 113]);
  });

  it("可上场 < 11：放开全员（停赛/伤停回池），无 meta 仍不进池", () => {
    const small = players.slice(0, 10); // 可上场 8 人 < 11
    const r = fitRecPool(small, isAvailable, hasMeta);
    expect(r.widened).toBe(true);
    expect(r.pids).toEqual([100, 101, 104, 105, 106, 107, 108, 109]);
  });

  it("全员都无 meta：放开后池仍为空（放开救不了没数据的人）", () => {
    const r = fitRecPool(players, () => true, () => false);
    expect(r.widened).toBe(false);
    expect(r.pids).toEqual([]);
  });

  it("minSlots 可注入（测试用小阵）", () => {
    const r = fitRecPool(players, isAvailable, hasMeta, 13);
    expect(r.widened).toBe(true);
    expect(r.pids).toContain(100);
  });
});

describe("fitDiffRows：逐槽 diff 行", () => {
  const slots: FitDiffSlot[] = [
    { lid: 1, position: "GK", slotKey: "GK|GK" },
    { lid: 2, position: "ST", slotKey: "ST|AF" },
    { lid: 3, position: "CM", slotKey: "CM|BTB" },
  ];
  /** 注入现任/推荐/FIT，构造行后断言用 */
  const rows = (
    cur: Record<number, number | null>,
    rec: Record<number, number | null>,
    shown: Record<number, number>,
  ) =>
    fitDiffRows(
      slots,
      (lid) => cur[lid] ?? null,
      (lid) => rec[lid] ?? null,
      (pid) => shown[pid] ?? null,
    );

  it("出：现任被换下，FIT 变化 = 推荐分 - 现任分（可为负）", () => {
    const [gk] = rows({ 1: 5 }, { 1: 7 }, { 5: 64, 7: 87 });
    expect(gk).toMatchObject({
      lid: 1,
      position: "GK",
      kind: "out",
      curPid: 5,
      newPid: 7,
      curShown: 64,
      newShown: 87,
      delta: 23,
    });
    const [down] = rows({ 1: 5 }, { 1: 7 }, { 5: 90, 7: 80 });
    expect(down.delta).toBe(-10);
  });

  it("入：空槽只有「入」，无现任侧、无 delta", () => {
    const [st] = rows({ 2: null }, { 2: 7 }, { 7: 87 });
    expect(st).toMatchObject({
      lid: 2,
      kind: "in",
      curPid: null,
      newPid: 7,
      curShown: null,
      newShown: 87,
      delta: null,
    });
  });

  it("保持：推荐与现任相同，FIT 照显、delta 不给", () => {
    const [cm] = rows({ 3: 5 }, { 3: 5 }, { 5: 87 });
    expect(cm).toMatchObject({
      kind: "keep",
      curPid: 5,
      newPid: 5,
      curShown: 87,
      newShown: 87,
      delta: null,
    });
  });

  it("无 meta 现任首发：不在池里必然被换下 → 「出」行，FIT 侧无数据、delta 不硬算", () => {
    const [gk] = rows({ 1: 5 }, { 1: 7 }, { 7: 87 });
    expect(gk).toMatchObject({
      kind: "out",
      curPid: 5,
      newPid: 7,
      curShown: null,
      newShown: 87,
      delta: null,
    });
  });

  it("推荐没填上的槽：有现任照旧（keep）、空槽整行不出", () => {
    const out = rows({ 1: 5, 2: null, 3: 9 }, { 1: null, 2: null, 3: null }, { 5: 70, 9: 88 });
    expect(out).toHaveLength(2); // lid 2 空槽无推荐 → 跳过
    expect(out.map((r) => r.lid)).toEqual([1, 3]);
    expect(out[0]).toMatchObject({ lid: 1, kind: "keep", curPid: 5, newPid: 5, curShown: 70 });
    expect(out[1]).toMatchObject({ lid: 3, kind: "keep", curPid: 9, newPid: 9 });
  });

  it("行序随槽序、一槽一行；空槽输入返回空数组", () => {
    const out = rows({ 1: 5, 2: 6, 3: null }, { 1: 5, 2: 7, 3: 8 }, { 5: 80, 6: 64, 7: 87, 8: 70 });
    expect(out.map((r) => [r.lid, r.kind])).toEqual([
      [1, "keep"],
      [2, "out"],
      [3, "in"],
    ]);
    expect(fitDiffRows([], () => null, () => null, () => null)).toEqual([]);
  });
});

describe("fitCompareRows：阵型对比", () => {
  // 三个阵型：A（当前，ST 用教练角色 PO）、B（默认角色 AF/D）、C（三槽含无人可分的 GK）
  const forms = [
    { value: "A", pos: [{ lid: 1, position: "ST" }, { lid: 2, position: "CM" }] },
    { value: "B", pos: [{ lid: 1, position: "ST" }, { lid: 2, position: "CB" }] },
    {
      value: "C",
      pos: [
        { lid: 1, position: "ST" },
        { lid: 2, position: "CM" },
        { lid: 3, position: "GK" },
      ],
    },
  ];
  // 池三人：P11 前锋型（PO 99.2 / AF 只 60）、P12 中场型、P13 中卫型
  const fitOfPid = new Map<number, FitProfile | null>([
    [11, prof({ "ST|PO": 99.2, "ST|AF": 60, "CM|BTB": 70.2, "CB|D": 50 })],
    [12, prof({ "ST|PO": 50, "ST|AF": 64, "CM|BTB": 87.6, "CB|D": 60 })],
    [13, prof({ "ST|AF": 10, "CM|BTB": 20, "CB|D": 80.5 })],
  ]);
  // pairOf 注入：A 的 ST 用教练调的 PO，其余全走默认角色（战术页里 current→players、其余→defaultPair）
  const defaultRole: Record<string, string> = { ST: "AF", CM: "BTB", CB: "D", GK: "GK" };
  const pairOf = (form: string, _lid: number, position: string) =>
    form === "A" && position === "ST"
      ? { role: "PO", focus: "Attack" }
      : { role: defaultRole[position] ?? "", focus: "Balanced" };

  it("总分（Σ rankRaw 取整）降序；各阵型按各自 pairOf 配槽——教练角色与默认角色分数不同", () => {
    const rows = fitCompareRows(forms, pairOf, [11, 12, 13], fitOfPid);
    expect(rows.map((r) => [r.form, r.total])).toEqual([
      ["A", 187], // P11 ST|PO 99.2 + P12 CM|BTB 87.6 = 186.8
      ["C", 148], // P11 ST|AF 60 + P12 CM|BTB 87.6 = 147.6（GK 槽无人可分，空着）
      ["B", 145], // P12 ST|AF 64 + P13 CB|D 80.5 = 144.5
    ]);
  });

  it("展开明细短板在前：无推荐槽最先，其后 FIT 升序", () => {
    const rows = fitCompareRows(forms, pairOf, [11, 12, 13], fitOfPid);
    const c = rows.find((r) => r.form === "C")!;
    expect(c.details!.map((d) => [d.position, d.pid, d.shown])).toEqual([
      ["GK", null, null],
      ["ST", 11, 60],
      ["CM", 12, 88],
    ]);
  });

  it("空候选池：全部阵型无可推荐，total/details 为 null 且保持 FORMS 声明序", () => {
    const rows = fitCompareRows(forms, pairOf, [], fitOfPid);
    expect(rows.map((r) => r.form)).toEqual(["A", "B", "C"]);
    expect(rows.every((r) => r.total === null && r.details === null)).toBe(true);
  });
});

describe("fitBenchTopTags：替补「擅长」top3 截取（S4）", () => {
  it("fitTile 降序取 top3，值为该槽 rankShown", () => {
    // 同群 4 槽 score 各异 → tile = 严格低于自己的个数 / (n-1) × 99：90→99、75→66、60→33、45→0
    const p = prof({ "ST|AF": 90, "CM|BTB": 75, "CB|D": 60, "ST|F9": 45 });
    expect(fitBenchTopTags(p, "OUT")).toEqual([
      { slot: "ST|AF", shown: 90 },
      { slot: "CM|BTB", shown: 75 },
      { slot: "CB|D", shown: 60 },
    ]);
  });

  it("跨位置群槽位无档不进榜：场上球员的 GK 族槽、门将的场上槽各归各群", () => {
    const p = prof({ "GK|GK": 95, "ST|AF": 60, "CM|BTB": 30 });
    // OUT 榜里没有 GK|GK（跨群无档），GK 榜里只有门将族槽位
    expect(fitBenchTopTags(p, "OUT")).toEqual([
      { slot: "ST|AF", shown: 60 },
      { slot: "CM|BTB", shown: 30 },
    ]);
    expect(fitBenchTopTags(p, "GK")).toEqual([{ slot: "GK|GK", shown: 95 }]);
  });

  it("tile 并列按 shown 降序、再按槽位键稳定序；max 可注入", () => {
    // ST|AF 与 ST|PO 同分同 shown → 键序 AF < PO；5 槽取 2
    const p = prof({ "ST|AF": 80, "ST|PO": 80, "CM|BTB": 75, "CB|D": 60, "ST|F9": 45 });
    expect(fitBenchTopTags(p, "OUT", 2)).toEqual([
      { slot: "ST|AF", shown: 80 },
      { slot: "ST|PO", shown: 80 },
    ]);
  });

  it("无 profile（无 meta / 未选人）返回空数组，整行不渲染由调用方判定", () => {
    expect(fitBenchTopTags(null, "OUT")).toEqual([]);
    expect(fitBenchTopTags(undefined, "OUT")).toEqual([]);
  });
});
