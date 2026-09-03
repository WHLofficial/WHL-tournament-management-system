// seeding.ts 自检：node scripts/check-seeding.ts 直接跑（Node 24 strip-types）
import {
  seedOrder,
  buildElimPlan,
  roundRobinSchedule,
  checkHomeStreaks,
  defaultCrossTemplate,
} from "../worker/lib/seeding.ts";

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failed++;
    console.error("  ✗ " + msg);
  }
}

// --- seedOrder ---
console.log("seedOrder:");
for (const size of [2, 4, 8]) {
  const o = seedOrder(size);
  assert(o.length === size, `size ${size} 长度 ${o.length}`);
  assert([...o].sort((a, b) => a - b).every((v, i) => v === i + 1), `size ${size} 是 1..size 排列`);
  // 相邻配对的种子号之和都等于 size+1（1v8, 4v5…）
  for (let i = 0; i < size; i += 2) {
    assert(o[i] + o[i + 1] === size + 1, `size ${size} 配对 ${o[i]}v${o[i + 1]} 和=${size + 1}`);
  }
}
console.log("  8 队序:", seedOrder(8).join(","));
console.log("  4 队序:", seedOrder(4).join(","));

// --- buildElimPlan ---
console.log("buildElimPlan:");
{
  const { matches, rounds } = buildElimPlan(8, { legs: 1, thirdPlace: false });
  assert(rounds === 3, "8 队 3 轮");
  const r1 = matches.filter((m) => m.round === 1);
  assert(r1.length === 4, "第一轮 4 场");
  assert(r1.every((m) => m.home !== null && m.away !== null), "第一轮全员真实");
  assert(matches.filter((m) => m.round === 2).length === 2, "第二轮 2 壳");
  assert(matches.filter((m) => m.round === 3).length === 1, "决赛 1 壳");
}
{
  const { matches, rounds } = buildElimPlan(6, { legs: 1, thirdPlace: false });
  assert(rounds === 3, "6 队补到 8 位 3 轮");
  const byes = matches.filter((m) => m.note === "轮空");
  assert(byes.length === 2, "6 队 2 个轮空，实得 " + byes.length);
  const real1 = matches.filter((m) => m.round === 1 && m.note !== "轮空");
  assert(real1.length === 2, "第一轮真实对 2 场");
  // 轮空场一方必须是真实位（≤6），另一方虚拟位（>6）
  assert(
    byes.every((m) => (m.home! <= 6) !== (m.away! <= 6)),
    "轮空场一方真实一方虚拟"
  );
}
{
  const { matches, rounds } = buildElimPlan(4, { legs: 2, thirdPlace: true });
  const r1 = matches.filter((m) => m.round === 1);
  assert(r1.length === 4, "4 队 legs=2 第一轮 4 场（2 对 × 2）");
  assert(r1.filter((m) => m.leg === 1).length === 2 && r1.filter((m) => m.leg === 2).length === 2, "leg 1/2 各 2 场");
  const leg1 = r1.find((m) => m.leg === 1)!;
  const leg2 = r1.find((m) => m.leg === 2 && m.slot === leg1.slot)!;
  assert(leg1.home === leg2.away && leg1.away === leg2.home, "两回合主客互换");
  const third = matches.find((m) => m.note === "季军赛");
  assert(third && third.round === rounds && third.slot === 2, "季军赛挂决赛轮 slot 2");
}

// --- roundRobinSchedule ---
console.log("roundRobinSchedule:");
for (const n of [3, 4, 5, 6, 7, 8, 10, 12]) {
  for (const loops of [1, 2] as const) {
    const { matches, balanced } = roundRobinSchedule(n, loops);
    const expectPerLoop = (n * (n - 1)) / 2; // 单循环 C(n,2)：偶数 (n-1)轮×n/2；奇数 n轮×(n-1)/2（补虚拟）
    assert(matches.length === expectPerLoop * loops, `n=${n} loops=${loops} 场数 ${matches.length} != ${expectPerLoop * loops}`);
    // 每对交手 loops 次（虚拟队不出现）
    const key = (a: number, b: number) => [Math.min(a, b), Math.max(a, b)].join("-");
    const pairCount = new Map<string, number>();
    for (const m of matches) {
      assert(m.home < n && m.away < n, `n=${n} 无虚拟队出场`);
      const k = key(m.home, m.away);
      pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
    }
    const expectedPairs = (n * (n - 1)) / 2;
    assert(pairCount.size === expectedPairs, `n=${n} 对数 ${pairCount.size} != ${expectedPairs}`);
    for (const c of pairCount.values()) assert(c === loops, `n=${n} 每对交手 ${loops} 次，实际 ${c}`);
    // 双循环两场主客互换
    if (loops === 2) {
      for (const [k, c] of pairCount) {
        if (c === 2) {
          const [a, b] = k.split("-").map(Number);
          const h = matches.filter((m) => key(m.home, m.away) === k);
          assert(h.some((m) => m.home === a && m.away === b) && h.some((m) => m.home === b && m.away === a), `n=${n} 对 ${k} 主客互换`);
        }
      }
    }
    // 每轮每队最多一场
    const roundTeams = new Map<string, number>();
    for (const m of matches) {
      for (const t of [m.home, m.away]) {
        const k = m.round + "-" + t;
        roundTeams.set(k, (roundTeams.get(k) ?? 0) + 1);
      }
    }
    for (const c of roundTeams.values()) assert(c <= 1, `n=${n} 同轮一队只一场`);
    // 整季无三连同主/客
    const streaks = checkHomeStreaks(matches, n);
    assert(streaks.length === 0, `n=${n} loops=${loops} 主客三连: ${streaks.join(";")}`);
    // 双循环：每队首末一主一客
    if (loops === 2) {
      const seq = new Map<number, Array<0 | 1>>();
      for (let t = 0; t < n; t++) seq.set(t, []);
      for (const m of [...matches].sort((x, y) => x.round - y.round)) {
        seq.get(m.home)!.push(1);
        seq.get(m.away)!.push(0);
      }
      for (const [t, s] of seq) {
        assert(s.length >= 2 && s[0] !== s[s.length - 1], `n=${n} 队${t} 双循环首末一主一客`);
      }
    }
    console.log(`  n=${n} loops=${loops}: ${matches.length} 场, balanced=${balanced}`);
  }
}

// --- defaultCrossTemplate ---
console.log("defaultCrossTemplate:");
console.log("  4 组 2 出线:", defaultCrossTemplate(4, 2).join(" "));
assert(defaultCrossTemplate(4, 2).length === 4, "4 组出 8 队 4 场");
assert(defaultCrossTemplate(4, 2).join() === "A1-B2,B1-A2,C1-D2,D1-C2", "模板内容");
assert(defaultCrossTemplate(4, 3).length === 0, "非 2 出线留空手填");

console.log(failed === 0 ? "\n全部通过 ✓" : `\n${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
