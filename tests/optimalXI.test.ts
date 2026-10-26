// 二部图最大权匹配（shared/optimalXI.ts，B2 计划 S1）——四组用例钉住计划清单：
// ① 最优性对拍：固定种子 LCG 生成随机权重阵（含 null 缺边），与暴力枚举「部分单射」
//   （每槽可空）的最大总权一致；5×8 为主，另加 8×5（槽多于人 → 空槽路径）与 6×6（方阵）；
// ② spec 点名冲突用例：两人都以 ST 为最优，验证「总和最大」——次优者流向另一槽，
//   含一个贪心会掉坑的变体（ST 最高者让位才是全局最优）；
// ③ 空候选 / 槽位全不可分配（weightOf 恒 null 无边可建）→ null；
// ④ 一人只占一槽：一人全场最优也只出现一次，分配无重复 pid。
import { describe, expect, it } from "vitest";
import { optimalXI } from "../shared/optimalXI";

const EPS_DIGITS = 6; // 权重和浮点漂移 ~1e-13 量级，6 位小数足够

/** 固定种子 LCG（Numerical Recipes 常数）：s < 2^32、乘积 < 2^53，整数运算精确可复现 */
const lcg = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
};

/** 随机用例：权重 40-99（一位小数，仿 rankRaw 量级），nullRate 概率置 null（不可分配） */
const randCase = (rnd: () => number, nSlots: number, nPids: number, nullRate: number) => {
  const pids = Array.from({ length: nPids }, (_, i) => 900 + i);
  const weights: (number | null)[][] = Array.from({ length: nSlots }, () =>
    pids.map(() => (rnd() < nullRate ? null : Math.round((40 + rnd() * 59) * 10) / 10)),
  );
  const slots = weights.map((row, i) => ({
    key: `S${i}`,
    weightOf: (pid: number) => {
      const j = pids.indexOf(pid);
      return j < 0 ? null : row[j];
    },
  }));
  return { slots, pids, weights };
};

/** 暴力神谕：枚举每槽「空 或 任选未占候选」的全部部分单射，取最大总权 */
const bruteBest = (weights: (number | null)[][]): number => {
  const p = weights[0]?.length ?? 0;
  const taken = new Array<boolean>(p).fill(false);
  let best = 0; // 全空分配恒可行（对应 optimalXI 的空槽/null 语义）
  const rec = (i: number, acc: number): void => {
    if (acc > best) best = acc;
    if (i >= weights.length) return;
    rec(i + 1, acc); // 该槽空着
    for (let j = 0; j < p; j++) {
      const w = weights[i][j];
      if (w === null || taken[j]) continue;
      taken[j] = true;
      rec(i + 1, acc + w);
      taken[j] = false;
    }
  };
  rec(0, 0);
  return best;
};

/** 分配合法性：键都是真槽位、值都是真候选、无重复 pid、total = 逐对权重和 */
const expectValidAssignment = (
  res: { assignment: Map<string, number>; total: number },
  c: ReturnType<typeof randCase>,
) => {
  let sum = 0;
  for (const [key, pid] of res.assignment) {
    const i = c.slots.findIndex((s) => s.key === key);
    expect(i).toBeGreaterThanOrEqual(0);
    const j = c.pids.indexOf(pid);
    expect(j).toBeGreaterThanOrEqual(0);
    const w = c.weights[i][j];
    expect(w).not.toBeNull();
    sum += w as number;
  }
  expect(res.total).toBeCloseTo(sum, EPS_DIGITS);
  expect(new Set(res.assignment.values()).size).toBe(res.assignment.size);
};

describe("① 最优性对拍：随机权重阵 vs 暴力全排列（固定种子 LCG）", () => {
  const shapes = [
    { nSlots: 5, nPids: 8, nullRate: 0, seeds: [1, 120] }, // 计划点名规模，稠密
    { nSlots: 5, nPids: 8, nullRate: 0.25, seeds: [101, 180] }, // 缺边稀疏
    { nSlots: 8, nPids: 5, nullRate: 0.2, seeds: [201, 280] }, // 槽多于人 → 空槽路径
    { nSlots: 6, nPids: 6, nullRate: 0, seeds: [301, 340] }, // 方阵
  ];
  for (const { nSlots, nPids, nullRate, seeds } of shapes) {
    it(`${nSlots} 槽 × ${nPids} 人（缺边率 ${nullRate}，种子 ${seeds[0]}-${seeds[1]}）总权与神谕一致`, () => {
      for (let seed = seeds[0]; seed <= seeds[1]; seed++) {
        const c = randCase(lcg(seed), nSlots, nPids, nullRate);
        const best = bruteBest(c.weights);
        const res = optimalXI(c.slots, c.pids);
        if (best === 0) {
          expect(res).toBeNull(); // 一条边都没有 → null
        } else {
          expect(res).not.toBeNull();
          expect(res!.total).toBeCloseTo(best, EPS_DIGITS);
          expectValidAssignment(res!, c);
        }
      }
    });
  }
});

describe("② 冲突用例：两人都是 ST 最优，总和最大优先", () => {
  const mk = (st: Record<number, number>, cm: Record<number, number>) => [
    { key: "ST", weightOf: (pid: number) => st[pid] ?? null },
    { key: "CM", weightOf: (pid: number) => cm[pid] ?? null },
  ];

  it("次优者流向另一槽：A→ST(95) + B→CM(93) = 188，而非 A 挤 ST 后只剩 164", () => {
    // A: ST 95 / CM 70，B: ST 94 / CM 93，两人最优槽都是 ST；可行分配只有两种
    const res = optimalXI(mk({ 101: 95, 102: 94 }, { 101: 70, 102: 93 }), [101, 102]);
    expect(res).not.toBeNull();
    expect(res!.assignment.get("ST")).toBe(101);
    expect(res!.assignment.get("CM")).toBe(102);
    expect(res!.total).toBe(188);
  });

  it("贪心陷阱：ST 最高者让位才是全局最优——A→CM(99) + B→ST(99) = 198，而非 102", () => {
    // A: ST 100 / CM 99，B: ST 99 / CM 2。「ST 锁死给最高分」只剩 102
    const res = optimalXI(mk({ 201: 100, 202: 99 }, { 201: 99, 202: 2 }), [201, 202]);
    expect(res).not.toBeNull();
    expect(res!.assignment.get("ST")).toBe(202);
    expect(res!.assignment.get("CM")).toBe(201);
    expect(res!.total).toBe(198);
  });
});

describe("③ 空候选 / 槽位全不可分配 → null", () => {
  it("候选列表为空 → null", () => {
    expect(optimalXI([{ key: "ST", weightOf: () => 88 }], [])).toBeNull();
  });

  it("weightOf 恒 null（无边可建）→ null", () => {
    const slots = ["ST", "CM"].map((key) => ({ key, weightOf: () => null }));
    expect(optimalXI(slots, [1, 2, 3])).toBeNull();
  });
});

describe("④ 一人只占一槽（分配无重复）", () => {
  it("一人全槽位碾压也只占一槽，其余槽由次优候选补、补不上的空着", () => {
    // 3 槽 × 2 人：P1（90/50/40）在每槽都压过 P2（9/8/1），
    // 最优唯一 = P1→S1 + P2→S2 = 98（次优 P1→S1 + P2→S3 = 91）
    const slots = ["S1", "S2", "S3"].map((key, i) => ({
      key,
      weightOf: (pid: number) => (pid === 501 ? [90, 50, 40][i] : [9, 8, 1][i]),
    }));
    const res = optimalXI(slots, [501, 502])!;
    expect(res.assignment.get("S1")).toBe(501);
    expect(res.assignment.get("S2")).toBe(502);
    expect(res.assignment.get("S3")).toBeUndefined(); // 候选不足 → 空槽
    expect([...res.assignment.values()].filter((pid) => pid === 501)).toHaveLength(1);
    expect(new Set(res.assignment.values()).size).toBe(res.assignment.size);
    expect(res.total).toBe(98);
  });
});
