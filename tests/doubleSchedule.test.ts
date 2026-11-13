// 双循环纯算法（worker/lib/doubleSchedule.ts，设计 §5）单测，按 §9.1 清单：
// 结构不变量、与旧检查器的对拍、symmetric/asymmetric 收敛、n=12、complete-double 轮序、确定性。
import { describe, expect, it } from "vitest";
import {
  applyMove,
  buildDoubleState,
  completeDoubleOrder,
  generateDouble,
  hash32,
  mulberry32,
  stateMatches,
  type DoubleState,
  type GenerateDoubleResult,
} from "../worker/lib/doubleSchedule";
import {
  checkEdgeHomeAway,
  checkHomeStreaks,
  roundRobinPairs,
  roundRobinSchedule,
  type RrMatch,
  type RrSchedule,
} from "../worker/lib/seeding";

function randPerm(k: number, rng: () => number): number[] {
  const a = Array.from({ length: k }, (_, i) => i);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function stripMs(r: GenerateDoubleResult): Omit<GenerateDoubleResult, "ms"> {
  const { ms: _ms, ...rest } = r;
  return rest;
}

// ---------- 结构不变量 ----------

function expectInvariants(n: number, matches: RrMatch[], rounds: number): void {
  const k = rounds / 2;
  // 轮次 1..2k 各出现一次，每轮场数正确（偶数 n/2 场，奇数 (n-1)/2 场）
  const perRound = new Map<number, number>();
  for (const m of matches) perRound.set(m.round, (perRound.get(m.round) ?? 0) + 1);
  const per = n % 2 === 0 ? n / 2 : (n - 1) / 2;
  for (let r = 1; r <= rounds; r++) expect(perRound.get(r), `round ${r}`).toBe(per);

  // 每对两场、无重复交手；第一/第二循环各一套
  const firstOf = new Map<string, { home: number; round: number }>();
  const secondOf = new Map<string, { home: number; round: number }>();
  for (const m of matches) {
    const key = m.home < m.away ? `${m.home}-${m.away}` : `${m.away}-${m.home}`;
    const bucket = m.round <= k ? firstOf : secondOf;
    expect(bucket.has(key), `pair ${key} 重复`).toBe(false);
    bucket.set(key, { home: m.home, round: m.round });
  }
  const pairTotal = (n * (n - 1)) / 2;
  expect(firstOf.size).toBe(pairTotal);
  expect(secondOf.size).toBe(pairTotal);

  // 第二循环与第一循环主客相反；同一第一循环轮的所有对映到同一第二循环位（order 是双射）
  const mapByFirst = new Map<number, number>();
  for (const [key, f] of firstOf) {
    const s = secondOf.get(key);
    expect(s, `pair ${key} 缺第二循环`).toBeDefined();
    expect(s!.home).not.toBe(f.home);
    const mapped = s!.round - k;
    const prev = mapByFirst.get(f.round);
    if (prev === undefined) mapByFirst.set(f.round, mapped);
    else expect(prev, `round ${f.round} 映射分裂`).toBe(mapped);
  }
  expect(mapByFirst.size).toBe(k);
  expect(new Set(mapByFirst.values()).size).toBe(k);

  // 奇数队：每轮恰一队轮空，每队两循环各轮空一次
  if (n % 2 === 1) {
    const byes = new Map<number, number>(Array.from({ length: n }, (_, t) => [t, 0]));
    for (let r = 1; r <= rounds; r++) {
      const busy = new Set<number>();
      for (const m of matches) {
        if (m.round !== r) continue;
        busy.add(m.home);
        busy.add(m.away);
      }
      expect(busy.size).toBe(n - 1);
      for (let t = 0; t < n; t++) if (!busy.has(t)) byes.set(t, (byes.get(t) ?? 0) + 1);
    }
    for (const [t, b] of byes) expect(b, `team ${t} 轮空数`).toBe(2);
  }
}

describe("generateDouble 结构不变量", () => {
  for (const n of [4, 5, 6, 7, 8]) {
    for (const mode of ["mirror", "asymmetric"] as const) {
      it(`n=${n} ${mode}：每对两场主客各一、第二循环主客相反、轮次 1..2k、奇数队轮空`, () => {
        const r = generateDouble(n, { mode, seed: 42, budgetMs: 500 });
        expect(r.rounds).toBe(2 * roundRobinPairs(n).length);
        expectInvariants(n, r.matches, r.rounds);
        // 搜索输出自洽：结果里报的违例条数必须与 matches 过一遍旧检查器的条数一致
        // （曾借这条抓出 swapOrder 增量更新写错列、venue 与 flip/orders 脱钩的 bug）
        const oldCount =
          checkHomeStreaks(r.matches, n).length + checkEdgeHomeAway(r.matches, n).length;
        expect(r.hard + r.soft, `n=${n} ${mode} 违例对拍`).toBe(oldCount);
      });
    }
  }

  it("随机状态（任意 flip/order 组合）同样满足结构不变量", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 20; i++) {
      const n = 4 + Math.floor(rng() * 6);
      const pairs = roundRobinPairs(n);
      const P = pairs.reduce((s, rp) => s + rp.length, 0);
      const flip = Array.from({ length: P }, () => rng() < 0.5);
      const state = buildDoubleState(n, flip, randPerm(pairs.length, rng));
      expectInvariants(n, stateMatches(state), state.k * 2);
    }
  });
});

// ---------- 对拍：增量违例条数 === 旧检查器条数 ----------

describe("对拍 checkHomeStreaks + checkEdgeHomeAway", () => {
  it("60 组随机状态上条数逐一相等（首/末两条拆分为 firstTwo + lastTwo）", () => {
    const rng = mulberry32(2026);
    for (let i = 0; i < 60; i++) {
      const n = 4 + Math.floor(rng() * 6); // 4..9，含奇数队轮空
      const pairs = roundRobinPairs(n);
      const P = pairs.reduce((s, rp) => s + rp.length, 0);
      const flip = Array.from({ length: P }, () => rng() < 0.5);
      const state = buildDoubleState(n, flip, randPerm(pairs.length, rng));
      const matches = stateMatches(state);
      const stateCount = state.violations.hard.length + state.violations.soft.length;
      const oldCount =
        checkHomeStreaks(matches, n).length + checkEdgeHomeAway(matches, n).length;
      expect(stateCount, `case ${i} n=${n}`).toBe(oldCount);
      // 种类口径：soft 只可能是 firstTwo；hard 只可能是 streak/lastTwo
      for (const v of state.violations.soft) expect(v.kind).toBe("firstTwo");
      for (const v of state.violations.hard) expect(["streak", "lastTwo"]).toContain(v.kind);
    }
  });

  it("违例字段：firstTwo/lastTwo 记首末两轮、streak 记整段连场", () => {
    // 构造 n=4 的状态：identity 轮序下手挑一个 flip 组合，让 0 号队出现可判定的违例形态
    const state = buildDoubleState(4, [false, false, false, false, false, true], [0, 1, 2]);
    const matches = stateMatches(state);
    // 与旧检查器对拍仍成立
    expect(state.violations.hard.length + state.violations.soft.length).toBe(
      checkHomeStreaks(matches, 4).length + checkEdgeHomeAway(matches, 4).length
    );
    for (const v of [...state.violations.hard, ...state.violations.soft]) {
      expect(v.team).toBeGreaterThanOrEqual(0);
      expect(v.team).toBeLessThan(4);
      expect(v.rounds.length).toBeGreaterThanOrEqual(2);
      for (const r of v.rounds) expect(r).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------- generate symmetric / asymmetric ----------

describe("generateDouble symmetric", () => {
  for (const n of [6, 8]) {
    it(`n=${n}：balanced=true 且 nonMirrorRounds=0`, () => {
      const r = generateDouble(n, { mode: "mirror", seed: 42, budgetMs: 2000 });
      expect(r.mode).toBe("mirror");
      expect(r.balanced).toBe(true);
      expect(r.hard).toBe(0);
      expect(r.nonMirrorRounds).toBe(0);
      expect(r.swaps).toBe(0);
      expectInvariants(n, r.matches, r.rounds);
    });
  }

  // n=4 + identity 轮序结构性无解：全部 2^6=64 种方向组合在旧检查器
  // （checkHomeStreaks + checkEdgeHomeAway）下最小违例数为 4，永不为 0
  // （独立于本实现复算过；现行线上 reverse 镜像序则最小为 0）。
  // 按 §5.4 第 5 步，generate 预算内 hard>0 → 失败返回，不写入——这里断言该行为。
  it("n=4：identity 轮序结构性无解，按 §5.4 第 5 步返回 balanced=false + 违例明细", () => {
    const r = generateDouble(4, { mode: "mirror", seed: 42, budgetMs: 2000 });
    expect(r.mode).toBe("mirror");
    expect(r.balanced).toBe(false);
    expect(r.hard).toBeGreaterThan(0);
    expect(r.nonMirrorRounds).toBe(0);
    expect(r.violations.hard.length).toBe(r.hard);
    expectInvariants(4, r.matches, r.rounds);
  });
});

describe("generateDouble asymmetric", () => {
  for (const n of [4, 6, 8]) {
    it(`n=${n}：balanced=true${n >= 6 ? " 且 nonMirrorRounds>0" : "（n=4 允许 0 + 警告）"}`, () => {
      // §9.1 未给 asymmetric 预算值，取 1000ms 留给 improve 足够步数
      const r = generateDouble(n, { mode: "asymmetric", seed: 42, budgetMs: 1000 });
      expect(r.mode).toBe("asymmetric");
      expect(r.balanced).toBe(true);
      expect(r.hard).toBe(0);
      if (n >= 6) expect(r.nonMirrorRounds).toBeGreaterThan(0);
      if (r.nonMirrorRounds === 0) expect(r.warnings).toContain("未能做出不对称");
      expectInvariants(n, r.matches, r.rounds);
    });
  }

  it("n=12：不变量 + balanced（预算 5000ms）", () => {
    const r = generateDouble(12, { mode: "asymmetric", seed: 42, budgetMs: 5000 });
    expectInvariants(12, r.matches, r.rounds);
    expect(r.balanced).toBe(true);
  });
});

// ---------- complete-double 轮序 ----------

describe("completeDoubleOrder", () => {
  it("k>1：0..k-1 的排列且非 identity；同 seed 两次一致", () => {
    for (const k of [2, 3, 4, 5, 6, 8]) {
      const { order, warnings } = completeDoubleOrder(k, { seed: 7 });
      expect(warnings).toEqual([]);
      expect([...order].sort((x, y) => x - y)).toEqual(Array.from({ length: k }, (_, i) => i));
      expect(order.some((v, i) => v !== i)).toBe(true);
      expect(completeDoubleOrder(k, { seed: 7 }).order).toEqual(order);
    }
  });

  it("洗牌恰好得到 identity 时循环右移 1 位（[k-1, 0, ..., k-2]）", () => {
    // 用导出的 mulberry32 复算原始洗牌，找到会洗成 identity 的 seed
    const raw = (k: number, seed: number) => {
      const rng = mulberry32(seed);
      const a = Array.from({ length: k }, (_, i) => i);
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    let found = -1;
    for (let seed = 1; seed <= 5000 && found < 0; seed++) {
      if (raw(4, seed).every((v, i) => v === i)) found = seed;
    }
    expect(found).toBeGreaterThan(0);
    expect(completeDoubleOrder(4, { seed: found }).order).toEqual([3, 0, 1, 2]);
  });

  it("不同 seed（k>=3）得到不同 order", () => {
    const o1 = completeDoubleOrder(6, { seed: 1 }).order;
    const o2 = completeDoubleOrder(6, { seed: 2 }).order;
    expect(o1).not.toEqual(o2);
    const orders = new Set<string>();
    for (let s = 1; s <= 10; s++) orders.add(completeDoubleOrder(6, { seed: s }).order.join(","));
    expect(orders.size).toBeGreaterThan(1);
  });

  it("k=1：order=[0] + 警告「队数过少，无非对称空间」", () => {
    const r = completeDoubleOrder(1, { seed: 7 });
    expect(r.order).toEqual([0]);
    expect(r.warnings).toEqual(["队数过少，无非对称空间"]);
  });
});

// ---------- 确定性原语与整体确定性 ----------

describe("hash32 / mulberry32", () => {
  const half = [
    { round: 1, slot: 1, home: 0, away: 1 },
    { round: 1, slot: 2, home: 2, away: 3 },
    { round: 2, slot: 1, home: 1, away: 2 },
  ];
  it("同输入稳定；stageId/轮次/序列变化即变化", () => {
    expect(hash32(7, half)).toBe(hash32(7, [...half]));
    expect(hash32(7, half)).not.toBe(hash32(8, half));
    expect(hash32(7, half)).not.toBe(hash32(7, half.map((m) => ({ ...m, round: m.round + 1 }))));
    expect(hash32(7, half)).not.toBe(hash32(7, [half[1], half[0], half[2]]));
    expect(hash32(7, half)).not.toBe(hash32(7, half.map((m) => ({ ...m, home: m.away, away: m.home }))));
  });
  it("值域 [0,1) 且同 seed 序列一致", () => {
    const a = mulberry32(9);
    const b = mulberry32(9);
    for (let i = 0; i < 100; i++) {
      const va = a();
      expect(va).toBe(b());
      expect(va).toBeGreaterThanOrEqual(0);
      expect(va).toBeLessThan(1);
    }
  });
});

describe("确定性：同 seed + 同输入 → 完全一致", () => {
  it("asymmetric n=6 两次调用除 ms 外 deepEqual", () => {
    const a = stripMs(generateDouble(6, { mode: "asymmetric", seed: 123, budgetMs: 5000 }));
    const b = stripMs(generateDouble(6, { mode: "asymmetric", seed: 123, budgetMs: 5000 }));
    expect(a).toEqual(b);
  });
  it("mirror n=8 两次调用除 ms 外 deepEqual", () => {
    const a = stripMs(generateDouble(8, { mode: "mirror", seed: 77, budgetMs: 5000 }));
    const b = stripMs(generateDouble(8, { mode: "mirror", seed: 77, budgetMs: 5000 }));
    expect(a).toEqual(b);
  });
});

// ---------- roundRobinSchedule 集成（seeding 接新算法，spec §11 步骤 3） ----------

// loops=2 的 RrSchedule 才带 asymmetric.ms（计时），逐字段比较时跳过它
function stripScheduleMs(s: RrSchedule): Omit<RrSchedule, "asymmetric"> & {
  asymmetric?: Omit<NonNullable<RrSchedule["asymmetric"]>, "ms">;
} {
  const { asymmetric, ...rest } = s;
  if (!asymmetric) return rest;
  const { ms: _ms, ...metrics } = asymmetric;
  return { ...rest, asymmetric: metrics };
}

describe("roundRobinSchedule loops=2（委托 generateDouble）", () => {
  it("不传 opts：默认 asymmetric，双循环字段齐全且不变量成立", () => {
    const s = roundRobinSchedule(6, 2);
    expect(s.mode).toBe("asymmetric");
    expect(s.balanced).toBe(true);
    expect(s.asymmetric?.nonMirrorRounds).toBeGreaterThan(0);
    expect(s.violations?.hard).toEqual([]);
    expect(s.warnings).toEqual([]);
    const rounds = s.matches.reduce((mx, m) => Math.max(mx, m.round), 0);
    expectInvariants(6, s.matches, rounds);
  });

  it("mode='mirror'：nonMirrorRounds=0、swaps=0 且 balanced", () => {
    const s = roundRobinSchedule(6, 2, { mode: "mirror", seed: 42, budgetMs: 2000 });
    expect(s.mode).toBe("mirror");
    expect(s.asymmetric?.nonMirrorRounds).toBe(0);
    expect(s.asymmetric?.swaps).toBe(0);
    expect(s.balanced).toBe(true);
    const rounds = s.matches.reduce((mx, m) => Math.max(mx, m.round), 0);
    expectInvariants(6, s.matches, rounds);
  });

  it("同 seed 两次调用结果一致（计时 ms 除外）", () => {
    const a = roundRobinSchedule(6, 2, { mode: "asymmetric", seed: 123, budgetMs: 5000 });
    const b = roundRobinSchedule(6, 2, { mode: "asymmetric", seed: 123, budgetMs: 5000 });
    expect(stripScheduleMs(a)).toEqual(stripScheduleMs(b));
    expect(a.asymmetric!.ms).toBeGreaterThan(0);
    expect(b.asymmetric!.ms).toBeGreaterThan(0);
  });

  it("loops=1 传 opts 不报错，行为与不传一致且不带双循环字段", () => {
    const withOpts = roundRobinSchedule(6, 1, { mode: "mirror", seed: 7, budgetMs: 1000 });
    const noOpts = roundRobinSchedule(6, 1);
    expect(withOpts).toEqual(noOpts);
    expect(withOpts.mode).toBeUndefined();
    expect(withOpts.violations).toBeUndefined();
    expect(withOpts.asymmetric).toBeUndefined();
    expect(withOpts.warnings).toBeUndefined();
  });
});

// ---------- §5.5 定向换位的命中列（回归） ----------
// 旧实现把「第二循环列号」直接当 orders 的下标传给 swapOrder，于是移动的是恰好排在该
// 位置上的轮、多数时候碰不到违例列；修复后先 indexOf 映射回违例轮在 orders 里的位置。
describe("asymmetric 定向换位命中违例轮", () => {
  // n=4、order=[2,0,1] 穷举全部 2^6 种方向，找「违例落在第二循环、且该列轮值不在其原位置」
  // 的状态——这正是旧实现换错列的必要条件。
  function findState(): { state: DoubleState; roundVal: number } | null {
    const n = 4;
    const k = 3;
    const order0 = [2, 0, 1];
    const pairCount = (n * (n - 1)) / 2;
    for (let mask = 0; mask < 1 << pairCount; mask++) {
      const flip = Array.from({ length: pairCount }, (_, i) => ((mask >> i) & 1) === 1);
      const state = buildDoubleState(n, flip, order0);
      // 只认 hv[0]：定向分支用 rng 选条目，测试脚本把 rng 摆成 0 → 固定选 hv[0]
      const v = state.violations.hard[0];
      if (!v) continue;
      const second = v.rounds.filter((r) => r > k);
      if (second.length === 0) continue;
      const roundVal = second[0] - k - 1; // 0-based 轮值
      if (order0.indexOf(roundVal) === roundVal) continue; // 位置恰等于轮值：区分不了新旧
      return { state, roundVal };
    }
    return null;
  }

  it("交换的是含违例的第二循环列，而不是恰好排在该位置的轮", () => {
    const found = findState();
    if (!found) throw new Error("应能构造出违例落在非固定点第二循环列的状态");
    const { state, roundVal } = found;
    const k = state.k;
    const w = k * 2;
    const col = k + roundVal; // 违例所在的第二循环列
    const pos = state.orders[0].indexOf(roundVal);
    expect(pos).not.toBe(roundVal); // 旧实现把 roundVal 当位置用，前提即「位置 ≠ 轮值」

    // 摆 rng：进定向分支(<0.7) → 选 hv[0] → 跳过翻对(≥0.6) → 另一位置取 0（与 pos 撞时再取）
    const script = [0.0, 0.0, 0.9, 0.0, 0.0];
    let i = 0;
    const rng = () => script[Math.min(i++, script.length - 1)];
    const other = pos === 0 ? 1 : 0;
    const prevO = [...state.orders[0]];
    const otherCol = k + prevO[other];
    const snap = state.venue.slice();
    const colBefore = Array.from({ length: state.n }, (_, t) => snap[t * w + col]);
    const otherBefore = Array.from({ length: state.n }, (_, t) => snap[t * w + otherCol]);

    const undo = applyMove(state, rng, true);

    // 违例列与「另一位置对应的列」内容整体对调（合上修复后的预期）
    for (let t = 0; t < state.n; t++) {
      expect(state.venue[t * w + col]).toBe(otherBefore[t]);
      expect(state.venue[t * w + otherCol]).toBe(colBefore[t]);
    }
    expect(state.orders[0][other]).toBe(roundVal);
    expect(state.orders[0][pos]).toBe(prevO[other]);

    // 自反：同参重施即撤销
    undo();
    expect(state.orders[0]).toEqual(prevO);
    expect(state.venue).toEqual(snap);
  });
});
