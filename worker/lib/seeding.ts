// 编排算法纯函数：不碰数据库，输入输出都是计划数据，方便自检与复用。
// match 计划里 home/away 统一存"bracket 种子位"（1-based，≤ entryCount 为真实队，
// > entryCount 为补幂用的虚拟位）；循环赛函数直接输出队号（0-based）。

export interface SeedEntry {
  id: number;
  seed: number;
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
  opts: { legs: 1 | 2; thirdPlace: boolean }
): { matches: PlanMatch[]; rounds: number } {
  const size = 2 ** Math.ceil(Math.log2(Math.max(entryCount, 2)));
  const rounds = Math.log2(size);
  const order = seedOrder(size);
  const matches: PlanMatch[] = [];

  const isReal = (pos: number) => order[pos - 1] <= entryCount;

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
    if (opts.legs === 2) {
      matches.push({ round: 1, slot: i + 1, leg: 1, home: seedA, away: seedB });
      matches.push({ round: 1, slot: i + 1, leg: 2, home: seedB, away: seedA });
    } else {
      matches.push({ round: 1, slot: i + 1, home: seedA, away: seedB });
    }
  }

  for (let r = 2; r <= rounds; r++) {
    const slots = size / 2 ** r;
    for (let j = 0; j < slots; j++) {
      if (opts.legs === 2) {
        matches.push({ round: r, slot: j + 1, leg: 1, home: null, away: null });
        matches.push({ round: r, slot: j + 1, leg: 2, home: null, away: null });
      } else {
        matches.push({ round: r, slot: j + 1, home: null, away: null });
      }
    }
  }

  if (opts.thirdPlace && rounds >= 2) {
    matches.push({
      round: rounds,
      slot: size / 2 ** rounds + 1,
      home: null,
      away: null,
      note: "季军赛",
    });
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
// 注："首战与末战一主一客"只在场次为偶数时可满足（双循环自动成立），单循环不检查。
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

// 修复手段：单场翻转 + 整轮翻转，贪心接受违例数下降的一步，最多 60 轮。
export function balanceHomeAway(matches: RrMatch[], teamCount: number): RrSchedule {
  let current = matches.map((m) => ({ ...m }));
  for (let iter = 0; iter < 60; iter++) {
    const bad = checkHomeStreaks(current, teamCount);
    if (bad.length === 0) return { matches: current, balanced: true };
    let improved = false;
    for (let i = 0; i < current.length && !improved; i++) {
      const flipped = current.map((m, j) =>
        j === i ? { ...m, home: m.away, away: m.home } : { ...m }
      );
      if (checkHomeStreaks(flipped, teamCount).length < bad.length) {
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
        if (checkHomeStreaks(flipped, teamCount).length < bad.length) {
          current = flipped;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return { matches: current, balanced: checkHomeStreaks(current, teamCount).length === 0 };
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
  // 双循环：第一循环修到无三连后，第二循环主客对调 + 轮序反向拼接。
  // 每对必然主客互换；且可证拼接后无三连、每队首末一主一客（只要第一循环无三连）。
  // 不能在拼接后再跑修复——整轮/单场翻转会破坏"每对主客互换"。
  const { matches: balancedFirst, balanced } = balanceHomeAway(first, teamCount);
  const k = base.length;
  const second = balancedFirst.map((m) => ({
    round: k + (k - m.round) + 1, // 轮序反向：第 1 轮的对调场排到最后
    home: m.away,
    away: m.home,
  }));
  return { matches: [...balancedFirst, ...second], balanced };
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
