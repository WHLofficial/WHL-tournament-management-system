// UI 纯函数单测（src/components/FitCandidateList.tsx）——计划 S8.4 / spec §9.4 点名：
// ① fitTileClass：磁贴底衬四态的唯一落点，阈值 85/50（个人内契合分，spec §5.1 定稿）——
//    ≥85 绿 fit-g、50–84 黄 fit-y、<50 红橙 fit-o、null/undefined 灰虚线 fit-na（无数据）；
//    阈值常量改动必须在这里红，防止测试口径与 styles.css 色档漂移；
// ② sortFitCandidates：候选排序比较器——rankRaw 降序（未截断原始值，封顶只压显示不压
//    排序）→ 球衣号升序 → 原序兜底；无数据（rank null）恒排尾（null 之间按球衣号、再原序）；
//    纯函数不动输入数组（面板每次渲染重排，不能有副作用）。
import { describe, expect, it } from "vitest";
import { fitTileClass, sortFitCandidates } from "../src/components/FitCandidateList";

describe("fitTileClass：85/50 分档边界（spec §9.4 阈值钉住）", () => {
  it("四态边界逐点：85 绿、84 黄、50 黄、49 红橙", () => {
    expect(fitTileClass(85)).toBe("fit-g");
    expect(fitTileClass(84)).toBe("fit-y");
    expect(fitTileClass(50)).toBe("fit-y");
    expect(fitTileClass(49)).toBe("fit-o");
  });

  it("端点与跨档典型值：0 红橙、51 黄、99 绿", () => {
    expect(fitTileClass(0)).toBe("fit-o");
    expect(fitTileClass(51)).toBe("fit-y");
    expect(fitTileClass(99)).toBe("fit-g");
  });

  it("无数据：null 与 undefined 同落灰虚线 fit-na（fitTile 返回 null 的唯一渲染出口）", () => {
    expect(fitTileClass(null)).toBe("fit-na");
    expect(fitTileClass(undefined)).toBe("fit-na");
  });
});

describe("sortFitCandidates：候选排序比较器", () => {
  interface Row {
    id: number;
    rank: number | null;
    jersey: number;
  }
  /** 注入 rank/jersey 取值，返回排完的 id 序列（比较器只认注入函数，不绑死球员形状） */
  const order = (rows: Row[]) =>
    sortFitCandidates(rows, (r) => r.rank, (r) => r.jersey).map((r) => r.id);

  it("rankRaw 降序用未截断原始值：99.5 排在 99 前（显示同为 99，排序仍分先后）", () => {
    expect(
      order([
        { id: 1, rank: 99, jersey: 7 },
        { id: 2, rank: 99.5, jersey: 8 },
      ]),
    ).toEqual([2, 1]);
  });

  it("无数据（null）恒排尾：哪怕球衣号最小、有分者分数再低", () => {
    expect(
      order([
        { id: 1, rank: null, jersey: 1 },
        { id: 2, rank: 30, jersey: 99 },
        { id: 3, rank: null, jersey: 2 },
      ]),
    ).toEqual([2, 1, 3]);
  });

  it("两个无数据之间：球衣号升序 → 原序兜底", () => {
    expect(
      order([
        { id: 1, rank: null, jersey: 9 },
        { id: 2, rank: null, jersey: 4 },
        { id: 3, rank: null, jersey: 4 },
      ]),
    ).toEqual([2, 3, 1]);
  });

  it("同分：球衣号升序；同分同号：原序兜底", () => {
    expect(
      order([
        { id: 1, rank: 77, jersey: 10 },
        { id: 2, rank: 77, jersey: 8 },
        { id: 3, rank: 77, jersey: 8 },
      ]),
    ).toEqual([2, 3, 1]);
  });

  it("全量序 = rank 降序 → 球衣号升序 → 原序，且不动输入数组", () => {
    const input: Row[] = [
      { id: 1, rank: 60, jersey: 5 },
      { id: 2, rank: null, jersey: 3 },
      { id: 3, rank: 90, jersey: 30 },
      { id: 4, rank: 60, jersey: 2 },
      { id: 5, rank: null, jersey: 1 },
    ];
    const before = JSON.stringify(input);
    expect(order(input)).toEqual([3, 4, 1, 5, 2]);
    expect(JSON.stringify(input)).toBe(before);
  });
});
