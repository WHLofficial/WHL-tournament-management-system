// 编排算法纯函数：不碰数据库，输入输出都是计划数据，方便自检与复用。
// match 计划里 home/away 统一存"bracket 种子位"（1-based，≤ entryCount 为真实队，
// > entryCount 为补幂用的虚拟位）；循环赛函数直接输出队号（0-based）。

export interface SeedEntry {
  id: number;
  seed: number;
}

// Fisher-Yates 洗牌：循环赛编排前打散队序，让轮次安排与主客分布每次不同。
// 只影响"谁第几轮碰谁/谁主场"，不影响交手集合（单循环每对恰好一场）。
export function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface PlanMatch {
  round: number; // 1-based 轮次
  slot: number; // 轮内位次 1-based
  leg?: 1 | 2;
  home: number | null; // 种子号（1..entryCount 真实，>entryCount 虚拟轮空）；null = 待晋级器填充
  away: number | null;
  note?: string; // '轮空' / '季军赛'
}

// ---------- 单败淘汰 ----------

// 标准种子位序：位置 1..size 上各放几号种子。
// 递归展开 [1] -> [1,2] -> [1,4,2,3] -> [1,8,4,5,2,7,3,6]，保证同种子对早期不相邻。
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const span = order.length * 2 + 1;
    const next: number[] = [];
    for (const p of order) next.push(p, span - p);
    order = next;
  }
  return order;
}

export function buildElimPlan(
  entryCount: number,
  opts: { legs: 1 | 2; finalLegs?: 1 | 2; thirdPlace: boolean }
): { matches: PlanMatch[]; rounds: number } {
  const size = 2 ** Math.ceil(Math.log2(Math.max(entryCount, 2)));
  const rounds = Math.log2(size);
  const order = seedOrder(size);
  const matches: PlanMatch[] = [];

  const isReal = (pos: number) => order[pos - 1] <= entryCount;
  // 决赛轮（含季军赛）回合数独立配置，缺省跟随 legs
  const legsOf = (r: number) =>
    r === rounds ? (opts.finalLegs ?? opts.legs) : opts.legs;

  for (let i = 0; i < size / 2; i++) {
    const posA = 2 * i + 1;
    const posB = 2 * i + 2;
    const seedA = order[posA - 1];
    const seedB = order[posB - 1];
    if (!isReal(posA) && !isReal(posB)) continue;
    if (!isReal(posA) || !isReal(posB)) {
      matches.push({
        round: 1,
        slot: i + 1,
        home: isReal(posA) ? seedA : seedB,
        away: isReal(posA) ? seedB : seedA,
        note: "轮空",
      });
      continue;
    }
    if (legsOf(1) === 2) {
      matches.push({ round: 1, slot: i + 1, leg: 1, home: seedA, away: seedB });
      matches.push({ round: 1, slot: i + 1, leg: 2, home: seedB, away: seedA });
    } else {
      matches.push({ round: 1, slot: i + 1, home: seedA, away: seedB });
    }
  }

  for (let r = 2; r <= rounds; r++) {
    const slots = size / 2 ** r;
    for (let j = 0; j < slots; j++) {
      if (legsOf(r) === 2) {
        matches.push({ round: r, slot: j + 1, leg: 1, home: null, away: null });
        matches.push({ round: r, slot: j + 1, leg: 2, home: null, away: null });
      } else {
        matches.push({ round: r, slot: j + 1, home: null, away: null });
      }
    }
  }

  if (opts.thirdPlace && rounds >= 2) {
    const thirdSlot = size / 2 ** rounds + 1;
    if (legsOf(rounds) === 2) {
      matches.push({ round: rounds, slot: thirdSlot, leg: 1, home: null, away: null, note: "季军赛" });
      matches.push({ round: rounds, slot: thirdSlot, leg: 2, home: null, away: null, note: "季军赛" });
    } else {
      matches.push({ round: rounds, slot: thirdSlot, home: null, away: null, note: "季军赛" });
    }
  }

  return { matches, rounds };
}

// 跨组淘汰（小组赛后的淘汰阶段）：第一轮配对由 cross 模板解析而来（entry id 或 null 占位），
// 后续轮次与季军赛只生成壳场，胜者由晋级器回填。队数必须是 2 的幂。
export function buildCrossPlan(
  round1Pairs: Array<[number | null, number | null]>,
  opts: { legs: 1 | 2; finalLegs?: 1 | 2; thirdPlace: boolean }
): { matches: PlanMatch[]; rounds: number } {
  const size = round1Pairs.length * 2;
  if (size < 2 || (size & (size - 1)) !== 0) {
    throw new Error("cross 对阵数必须是 2 的幂");
  }
  const rounds = Math.log2(size);
  const matches: PlanMatch[] = [];
  const legsOf = (r: number) =>
    r === rounds ? (opts.finalLegs ?? opts.legs) : opts.legs;

  round1Pairs.forEach(([h, a], i) => {
    if (legsOf(1) === 2) {
      matches.push({ round: 1, slot: i + 1, leg: 1, home: h, away: a });
      matches.push({ round: 1, slot: i + 1, leg: 2, home: a, away: h });
    } else {
      matches.push({ round: 1, slot: i + 1, home: h, away: a });
    }
  });

  for (let r = 2; r <= rounds; r++) {
    const slots = size / 2 ** r;
    for (let j = 0; j < slots; j++) {
      if (legsOf(r) === 2) {
        matches.push({ round: r, slot: j + 1, leg: 1, home: null, away: null });
        matches.push({ round: r, slot: j + 1, leg: 2, home: null, away: null });
      } else {
        matches.push({ round: r, slot: j + 1, home: null, away: null });
      }
    }
  }

  if (opts.thirdPlace && rounds >= 2) {
    const thirdSlot = size / 2 ** rounds + 1;
    if (legsOf(rounds) === 2) {
      matches.push({ round: rounds, slot: thirdSlot, leg: 1, home: null, away: null, note: "季军赛" });
      matches.push({ round: rounds, slot: thirdSlot, leg: 2, home: null, away: null, note: "季军赛" });
    } else {
      matches.push({ round: rounds, slot: thirdSlot, home: null, away: null, note: "季军赛" });
    }
  }

  return { matches, rounds };
}

// ---------- 循环赛 ----------

// 经典轮转法（circle method）。奇数队补虚拟队（编号 teamCount），含虚拟的配对不产出。
// 返回 rounds[r] 内的配对，只定"谁和谁"，方向由 balanceHomeAway 决定。
export function roundRobinPairs(teamCount: number): Array<Array<[number, number]>> {
  const hasBye = teamCount % 2 === 1;
  const n = hasBye ? teamCount + 1 : teamCount;
  const BYE = hasBye ? n - 1 : -1;
  const ids = Array.from({ length: n }, (_, i) => i);
  const rounds: Array<Array<[number, number]>> = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < n / 2; i++) {
      const a = ids[i];
      const b = ids[n - 1 - i];
      if (a === BYE || b === BYE) continue;
      // 固定位（i=0）按轮次交替方向，其余按位次交替——避免固定队全程主场
      const homeFirst = i === 0 ? r % 2 === 0 : i % 2 === 0;
      pairs.push(homeFirst ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    // 除固定首位的 ids[0] 外，其余循环右移一位
    const fixed = ids[0];
    const rest = ids.slice(1);
    rest.unshift(rest.pop()!);
    ids.splice(0, ids.length, fixed, ...rest);
  }
  return rounds;
}

export interface RrMatch {
  round: number; // 1-based；双循环时第二循环 round 偏移
  home: number; // 0-based 队号
  away: number;
}

export interface RrSchedule {
  matches: RrMatch[];
  balanced: boolean; // false = 自动修复未收敛，提示改手动
}

// 主客健康约束：任何队不连续三场同侧。
export function checkHomeStreaks(matches: RrMatch[], teamCount: number): string[] {
  const byTeam = new Map<number, Array<0 | 1>>();
  for (let t = 0; t < teamCount; t++) byTeam.set(t, []);
  const sorted = [...matches].sort((x, y) => x.round - y.round);
  for (const m of sorted) {
    byTeam.get(m.home)!.push(1);
    byTeam.get(m.away)!.push(0);
  }
  const bad: string[] = [];
  for (const [t, seq] of byTeam) {
    for (let i = 2; i < seq.length; i++) {
      if (seq[i] === seq[i - 1] && seq[i - 1] === seq[i - 2]) {
        bad.push(`team ${t} 三连${seq[i] === 1 ? "主" : "客"}`);
        break;
      }
    }
  }
  return bad;
}

// 首末一主一客：每队第一场与最后一场侧别不同（轮空队按实际出场的首末场计）。
export function checkEdgeHomeAway(matches: RrMatch[], teamCount: number): string[] {
  const byTeam = new Map<number, { first?: 0 | 1; last?: 0 | 1 }>();
  for (let t = 0; t < teamCount; t++) byTeam.set(t, {});
  const sorted = [...matches].sort((x, y) => x.round - y.round);
  for (const m of sorted) {
    const h = byTeam.get(m.home)!;
    if (h.first === undefined) h.first = 1;
    h.last = 1;
    const a = byTeam.get(m.away)!;
    if (a.first === undefined) a.first = 0;
    a.last = 0;
  }
  const bad: string[] = [];
  for (const [t, e] of byTeam) {
    if (e.first !== undefined && e.first === e.last) {
      bad.push(`team ${t} 首末同${e.first === 1 ? "主" : "客"}`);
    }
  }
  return bad;
}

const totalViolations = (matches: RrMatch[], teamCount: number): number =>
  checkHomeStreaks(matches, teamCount).length + checkEdgeHomeAway(matches, teamCount).length;

// 固定种子的 LCG，保证退火结果可复现（同一队数+轮次永远生成同一赛程）
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// 模拟退火：贪心卡在局部极小（如奇数队单循环首末违例）时的逃逸。
// 只翻方向不改变配对；接受标准逐步降温，最终按总违例收敛为 0 或返回 null。
function annealFix(matches: RrMatch[], teamCount: number): RrMatch[] | null {
  let cur = matches.map((m) => ({ ...m }));
  let bad = totalViolations(cur, teamCount);
  if (bad === 0) return cur;
  const rng = lcg(teamCount * 31 + 7);
  let T = 2.0;
  for (let s = 0; s < 6000; s++) {
    if (bad === 0) return cur;
    const mode = rng() < 0.7 ? "single" : "round";
    const cand =
      mode === "single"
        ? cur.map((m, i) =>
            i === Math.floor(rng() * cur.length) ? { ...m, home: m.away, away: m.home } : { ...m }
          )
        : (() => {
            const rnd = 1 + Math.floor(rng() * teamCount);
            return cur.map((m) => (m.round === rnd ? { ...m, home: m.away, away: m.home } : { ...m }));
          })();
    const nb = totalViolations(cand, teamCount);
    if (nb < bad || rng() < Math.exp((bad - nb) / T)) {
      cur = cand;
      bad = nb;
    }
    T = Math.max(0.05, T * 0.999);
  }
  return totalViolations(cur, teamCount) === 0 ? cur : null;
}

// 修复手段：单场翻转 + 整轮翻转，贪心接受违例数下降的一步，最多 60 轮。
// 贪心卡在「单步不下降」且只剩首末违例（三连已净）时，试两步：
// 翻某违例队的末战场 → 只接受「三连下降且首末不恶化」的翻转修三连 → 总违例下降则接受。
export function balanceHomeAway(matches: RrMatch[], teamCount: number): RrSchedule {
  let current = matches.map((m) => ({ ...m }));
  for (let iter = 0; iter < 60; iter++) {
    const bad = totalViolations(current, teamCount);
    if (bad === 0) return { matches: current, balanced: true };
    let improved = false;
    for (let i = 0; i < current.length && !improved; i++) {
      const flipped = current.map((m, j) =>
        j === i ? { ...m, home: m.away, away: m.home } : { ...m }
      );
      if (totalViolations(flipped, teamCount) < bad) {
        current = flipped;
        improved = true;
      }
    }
    if (!improved) {
      const maxRound = Math.max(...current.map((m) => m.round));
      for (let r = 1; r <= maxRound && !improved; r++) {
        const flipped = current.map((m) =>
          m.round === r ? { ...m, home: m.away, away: m.home } : { ...m }
        );
        if (totalViolations(flipped, teamCount) < bad) {
          current = flipped;
          improved = true;
        }
      }
    }
    // 两步搜索：翻违例队的首战或末战场，随后只修三连（首末不恶化）
    if (!improved) {
      const edgeBad = checkEdgeHomeAway(current, teamCount);
      if (edgeBad.length > 0 && checkHomeStreaks(current, teamCount).length === 0) {
        const edgeTeams = new Set<number>();
        for (const s of edgeBad) {
          const m = s.match(/team (\d+)/);
          if (m) edgeTeams.add(Number(m[1]));
        }
        const edgeIdx = new Map<number, Set<number>>(); // team -> 首战/末战场次下标集合
        const sorted = [...current].sort((x, y) => x.round - y.round);
        for (const t of edgeTeams) {
          const kept: number[] = [];
          sorted.forEach((m, i) => {
            if (m.home === t || m.away === t) kept.push(i);
          });
          // kept 按轮次排序：首场与末场
          const cands = new Set<number>();
          for (const i of [kept[0], kept[kept.length - 1]]) {
            if (i !== undefined) cands.add(i);
          }
          edgeIdx.set(t, cands);
        }
        // 候选场下标（sorted 顺序）→ 还原到 current 的下标
        const sortedIdxOfCurrent = (si: number) =>
          current.findIndex(
            (m) => m.round === sorted[si].round && m.home === sorted[si].home && m.away === sorted[si].away
          );
        for (const t of edgeTeams) {
          for (const si of edgeIdx.get(t) ?? []) {
            const cand = sortedIdxOfCurrent(si);
            if (cand < 0) continue;
            let f2 = current.map((m, j) =>
              j === cand ? { ...m, home: m.away, away: m.home } : { ...m }
            );
            for (let sub = 0; sub < 12; sub++) {
              const st = checkHomeStreaks(f2, teamCount);
              if (st.length === 0) break;
              let subImproved = false;
              for (let j = 0; j < f2.length && !subImproved; j++) {
                const ff = f2.map((m, k) =>
                  k === j ? { ...m, home: m.away, away: m.home } : { ...m }
                );
                if (
                  checkHomeStreaks(ff, teamCount).length < st.length &&
                  checkEdgeHomeAway(ff, teamCount).length <= edgeBad.length
                ) {
                  f2 = ff;
                  subImproved = true;
                }
              }
              if (!subImproved) {
                const mx = Math.max(...f2.map((m) => m.round));
                for (let r = 1; r <= mx && !subImproved; r++) {
                  const ff = f2.map((m) =>
                    m.round === r ? { ...m, home: m.away, away: m.home } : { ...m }
                  );
                  if (
                    checkHomeStreaks(ff, teamCount).length < st.length &&
                    checkEdgeHomeAway(ff, teamCount).length <= edgeBad.length
                  ) {
                    f2 = ff;
                    subImproved = true;
                  }
                }
              }
              if (!subImproved) break;
            }
            if (totalViolations(f2, teamCount) < bad) {
              current = f2;
              improved = true;
              break;
            }
          }
          if (improved) break;
        }
      }
    }
    if (!improved) break;
  }
  if (totalViolations(current, teamCount) > 0) {
    const fixed = annealFix(current, teamCount);
    if (fixed) current = fixed;
  }
  return { matches: current, balanced: totalViolations(current, teamCount) === 0 };
}

export function roundRobinSchedule(
  teamCount: number,
  loops: 1 | 2
): RrSchedule {
  const base = roundRobinPairs(teamCount);
  const first: RrMatch[] = [];
  base.forEach((pairs, ri) => {
    pairs.forEach(([home, away]) => {
      first.push({ round: ri + 1, home, away });
    });
  });
  if (loops === 1) return balanceHomeAway(first, teamCount);
  // 双循环：第一循环修到健康后，第二循环主客对调 + 轮序反向拼接。
  // 每对必然主客互换；拼接可证无三连、每队首末一主一客（对调反向后首末与第一循环首轮互异）。
  // 不能在拼接后再跑修复——整轮/单场翻转会破坏"每对主客互换"。
  const { matches: balancedFirst } = balanceHomeAway(first, teamCount);
  const k = base.length;
  const second = balancedFirst.map((m) => ({
    round: k + (k - m.round) + 1, // 轮序反向：第 1 轮的对调场排到最后
    home: m.away,
    away: m.home,
  }));
  const merged = [...balancedFirst, ...second];
  const balanced =
    checkHomeStreaks(merged, teamCount).length === 0 &&
    checkEdgeHomeAway(merged, teamCount).length === 0;
  return { matches: merged, balanced };
}

// ---------- 小组抽签 ----------

export function drawGroups(
  entryIds: number[],
  groupCount: number,
  rng: () => number = Math.random
): Map<number, string> {
  const shuffled = [...entryIds];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const names = "ABCDEFGHIJKLMNOP".slice(0, groupCount).split("");
  const assign = new Map<number, string>();
  shuffled.forEach((id, i) => {
    assign.set(id, names[i % groupCount]);
  });
  return assign;
}

// 小组赛后淘汰阶段的默认交叉模板：A1-B2, B1-A2, C1-D2, D1-C2…（组内两条互为上下半区）
export function defaultCrossTemplate(
  groupCount: number,
  qualifyPerGroup: number
): string[] {
  if (qualifyPerGroup !== 2) {
    // 其他出线数暂无标准模板，留空由管理员手填
    return [];
  }
  const names = "ABCDEFGHIJKLMNOP".slice(0, groupCount).split("");
  const out: string[] = [];
  for (let i = 0; i < groupCount; i += 2) {
    if (i + 1 < groupCount) {
      out.push(`${names[i]}1-${names[i + 1]}2`);
      out.push(`${names[i + 1]}1-${names[i]}2`);
    } else {
      out.push(`${names[i]}1-${names[0]}2`);
    }
  }
  return out;
}
