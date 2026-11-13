// 双循环（对称/不对称）赛程纯算法（设计 §5）：状态、违例计量、双模式搜索与 complete-double 洗牌。
// 设计见 docs/superpowers/specs/2026-11-12-asymmetric-double-round-robin-design.md。
//
// 与 seeding.ts 的分工：单循环编排/修复原语（roundRobinPairs/balanceHomeAway）留在 seeding，
// 双循环的状态机与搜索复杂度都收在本文件。结果只由 mulberry32(seed) 驱动，同一 seed + 同一输入
// → 同一结果（§5.8）；Math.random 不出现，Date.now 只用于预算检查（§5.8 每 256 步一查），
// 不参与结果内容。
import { balanceHomeAway, roundRobinPairs, type RrMatch } from "./seeding";

// 主 / 客 / 轮空（奇数队每轮有一队轮空，venue 序列扫描跳过 -1）
export type Venue = 1 | 0 | -1;

export interface Violation {
  team: number; // 0-based 队号；路由映射成 entryId
  kind: "streak" | "firstTwo" | "lastTwo";
  side: "home" | "away";
  rounds: number[]; // 1..2k 的绝对轮次，例如 [3,4,5]
}

// 双循环状态机（§5.1）。以 0-based 队号工作；每对的两回合由 flip 定方向、orders[0] 定第二循环轮序：
// 第一循环第 pairRound[p] 轮 + 第二循环第 k + orders[0][pairRound[p]-1] + 1 轮，主客必相反。
// orders 是二维数组为 3+ 循环预留（未来 orders[1] = 第三循环轮序），本次只读写 orders[0]；
// orders[0][i] = i 为正向镜像，反向镜像已淘汰、不再定义。
export interface DoubleState {
  n: number;
  k: number; // 第一循环轮数
  loops: 2;
  pairs: Array<[number, number]>; // 每对的标准方向（来自 roundRobinPairs）
  pairRound: number[]; // 每对在第一循环的轮次 1..k
  pairIndex: Map<string, number>; // 规范键 "min-max" -> pair 下标
  flip: boolean[]; // 是否翻转该对的两回合主客
  orders: number[][]; // 长度 loops-1；当前只有 orders[0]
  venue: Int8Array; // n * 2k；venue[t*2k + (round-1)]
  hard: number;
  soft: number;
  violations: { hard: Violation[]; soft: Violation[] };
}

const pairKey = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);

// 退火温度带（§5.5：T 从 5.0 降到 0.05）与步数上限（§5.8：预算外再设 maxSteps 硬顶）
const T0 = 5.0;
const T1 = 0.05;
const REPAIR_MAX_STEPS = 20000;
const REPAIR_BOUNDED_STEPS = 1500; // improve 内嵌修复的步数上限
const IMPROVE_MAX_STEPS = 3000;

const stateCost = (state: DoubleState): number => state.hard * 100 + state.soft;

export function nonMirrorCount(order: number[]): number {
  let c = 0;
  for (let i = 0; i < order.length; i++) if (order[i] !== i) c++;
  return c;
}

// 由 roundRobinPairs + balanceHomeAway 得到第一循环方向 → 每对的 flip 起点（§5.4/§5.5 第 1 步）
function initialFlip(pairs: Array<[number, number]>, pairRound: number[], n: number): boolean[] {
  const first: RrMatch[] = pairs.map(([a, b], i) => ({ round: pairRound[i], home: a, away: b }));
  const { matches } = balanceHomeAway(first, n);
  const idx = new Map<string, number>();
  pairs.forEach(([a, b], i) => idx.set(pairKey(a, b), i));
  const flip = new Array<boolean>(pairs.length).fill(false);
  for (const m of matches) {
    const p = idx.get(pairKey(m.home, m.away));
    // balanceHomeAway 只翻方向不改配对/轮次，这里按（轮次, 配对）回填 flip
    if (p === undefined || pairRound[p] !== m.round) continue;
    flip[p] = m.home !== pairs[p][0];
  }
  return flip;
}

export function buildDoubleState(n: number, flip: boolean[], order0: number[]): DoubleState {
  const base = roundRobinPairs(n);
  const pairs: Array<[number, number]> = [];
  const pairRound: number[] = [];
  base.forEach((rp, ri) => {
    for (const [a, b] of rp) {
      pairs.push([a, b]);
      pairRound.push(ri + 1);
    }
  });
  if (flip.length !== pairs.length) throw new Error(`flip 长度应为 ${pairs.length}`);
  if (order0.length !== base.length) throw new Error(`order0 长度应为 ${base.length}`);
  const pairIndex = new Map<string, number>();
  pairs.forEach(([a, b], i) => pairIndex.set(pairKey(a, b), i));
  const state: DoubleState = {
    n,
    k: base.length,
    loops: 2,
    pairs,
    pairRound,
    pairIndex,
    flip: [...flip],
    orders: [[...order0]],
    // 先整体填 -1（轮空），再由 emitPair 覆盖实际比赛的格子
    venue: new Int8Array(n * base.length * 2).fill(-1),
    hard: 0,
    soft: 0,
    violations: { hard: [], soft: [] },
  };
  rebuildVenue(state);
  recountAll(state);
  return state;
}

// 第二循环列（0-based）：第一循环轮 r 的对放在 k + orders[0][r-1]
function secondCol(state: DoubleState, firstRound: number): number {
  return state.k + state.orders[0][firstRound - 1];
}

// 按 flip 与 orders[0] 写一对的两回合 venue（4 格；两个循环列都重写，幂等）
function emitPair(state: DoubleState, p: number): void {
  const w = state.k * 2;
  const [a, b] = state.pairs[p];
  const c1 = state.pairRound[p] - 1;
  const c2 = secondCol(state, state.pairRound[p]);
  const firstHome = state.flip[p] ? b : a;
  const firstAway = state.flip[p] ? a : b;
  state.venue[firstHome * w + c1] = 1;
  state.venue[firstAway * w + c1] = 0;
  state.venue[firstAway * w + c2] = 1;
  state.venue[firstHome * w + c2] = 0;
}

function rebuildVenue(state: DoubleState): void {
  state.venue.fill(-1);
  for (let p = 0; p < state.pairs.length; p++) emitPair(state, p);
}

// 单队违例扫描（§5.2）：轮空（-1）跳过；每队至多一条 streak、一条 firstTwo、一条 lastTwo，
// 与 seeding 的 checkHomeStreaks/checkEdgeHomeAway「每队最多一条」口径一致。
function scanTeam(state: DoubleState, t: number, out: { hard: Violation[]; soft: Violation[] }): void {
  const w = state.k * 2;
  const seq: Array<{ round: number; side: 1 | 0 }> = [];
  for (let c = 0; c < w; c++) {
    const v = state.venue[t * w + c];
    if (v === -1) continue;
    seq.push({ round: c + 1, side: v as 1 | 0 });
  }
  // streak：第一段 ≥3 连同侧（找到即止，每队一条）
  for (let i = 0; i + 2 < seq.length; i++) {
    const s = seq[i].side;
    if (seq[i + 1].side === s && seq[i + 2].side === s) {
      let j = i + 3;
      while (j < seq.length && seq[j].side === s) j++;
      out.hard.push({
        team: t,
        kind: "streak",
        side: s === 1 ? "home" : "away",
        rounds: seq.slice(i, j).map((x) => x.round),
      });
      break;
    }
  }
  if (seq.length >= 2) {
    if (seq[0].side === seq[1].side) {
      out.soft.push({
        team: t,
        kind: "firstTwo",
        side: seq[0].side === 1 ? "home" : "away",
        rounds: [seq[0].round, seq[1].round],
      });
    }
    const m = seq.length;
    if (seq[m - 1].side === seq[m - 2].side) {
      out.hard.push({
        team: t,
        kind: "lastTwo",
        side: seq[m - 1].side === 1 ? "home" : "away",
        rounds: [seq[m - 2].round, seq[m - 1].round],
      });
    }
  }
}

function recountAll(state: DoubleState): void {
  state.violations.hard = [];
  state.violations.soft = [];
  for (let t = 0; t < state.n; t++) scanTeam(state, t, state.violations);
  state.hard = state.violations.hard.length;
  state.soft = state.violations.soft.length;
}

// 增量重算：只重扫指定球队（flipPair 的增量范围是「该对两队」，§5.3）
function recountTeams(state: DoubleState, teams: number[]): void {
  const affected = [...new Set(teams)];
  const drop = new Set(affected);
  state.violations.hard = state.violations.hard.filter((v) => !drop.has(v.team));
  state.violations.soft = state.violations.soft.filter((v) => !drop.has(v.team));
  for (const t of affected) scanTeam(state, t, state.violations);
  state.hard = state.violations.hard.length;
  state.soft = state.violations.soft.length;
}

// ---------- 三种移动（§5.3）：全部是自反操作，重施同参即撤销 ----------

// 翻转第 p 对的两回合主客；只重算该对两队
function flipPair(state: DoubleState, p: number): void {
  state.flip[p] = !state.flip[p];
  emitPair(state, p);
  recountTeams(state, [state.pairs[p][0], state.pairs[p][1]]);
}

// 翻转第一循环第 r 轮所有对（对应第二循环同对联动翻转）；重算全队
function flipRound(state: DoubleState, r: number): void {
  for (let p = 0; p < state.pairs.length; p++) {
    if (state.pairRound[p] !== r) continue;
    state.flip[p] = !state.flip[p];
    emitPair(state, p);
  }
  recountAll(state);
}

// 交换第二循环第 a、b 个位置；重算全队
function swapOrder(state: DoubleState, a: number, b: number): void {
  if (a === b) return;
  const o = state.orders[0];
  // 受影响的是第二循环第 k+o[a]+1、k+o[b]+1 两列（交换前这两列的占用者对调）：
  // 先按旧值清空（含奇数队轮空位），再按新顺序重排 a+1、b+1 两轮的对
  const ca = state.k + o[a];
  const cb = state.k + o[b];
  [o[a], o[b]] = [o[b], o[a]];
  const w = state.k * 2;
  for (let t = 0; t < state.n; t++) {
    state.venue[t * w + ca] = -1;
    state.venue[t * w + cb] = -1;
  }
  for (let p = 0; p < state.pairs.length; p++) {
    const pr = state.pairRound[p];
    if (pr === a + 1 || pr === b + 1) emitPair(state, p);
  }
  recountAll(state);
}

function teamPairs(state: DoubleState, t: number): number[] {
  const out: number[] = [];
  for (let p = 0; p < state.pairs.length; p++) {
    if (state.pairs[p][0] === t || state.pairs[p][1] === t) out.push(p);
  }
  return out;
}

function restoreState(state: DoubleState, flip: boolean[], order: number[]): void {
  state.flip = [...flip];
  state.orders[0] = [...order];
  rebuildVenue(state);
  recountAll(state);
}

// 施一步移动并返回撤销闭包（三种移动都是自反的：同参重施即回滚）。
// 导出供定向换位的回归测试摆 rng 与检查命中列。
export function applyMove(state: DoubleState, rng: () => number, allowSwap: boolean): () => void {
  if (state.violations.hard.length > 0 && rng() < 0.7) {
    // 定向修复（§5.5）：拿一条硬违例队，翻涉及它的对，或交换含违例的第二循环轮
    const hv = state.violations.hard;
    const v = hv[Math.floor(rng() * hv.length)];
    if (rng() < 0.6) {
      const cands = teamPairs(state, v.team);
      if (cands.length > 0) {
        const p = cands[Math.floor(rng() * cands.length)];
        flipPair(state, p);
        return () => flipPair(state, p);
      }
    }
    const secondRounds = v.rounds.filter((r) => r > state.k);
    if (allowSwap && state.k >= 2 && secondRounds.length > 0) {
      // §5.5：把「含该违例的第二循环轮」与另一轮交换。swapOrder 交换的是 orders 里的
      // 两个位置，而违例带的是第二循环列号（0-based round value = r-k-1）——必须先映射回
      // 它在 orders[0] 中的下标，否则被移动的是「恰好排在该位置上的轮」而不是违例轮。
      const pos = state.orders[0].indexOf(secondRounds[0] - state.k - 1);
      let other = Math.floor(rng() * state.k);
      if (other === pos) other = (pos + 1 + Math.floor(rng() * (state.k - 1))) % state.k;
      swapOrder(state, pos, other);
      return () => swapOrder(state, pos, other);
    }
    // 违例轮在第一循环（或不允许换位）：翻其源轮（第二循环轮 r 的源是第 r-k 轮）
    const r = v.rounds[Math.floor(rng() * v.rounds.length)];
    flipRound(state, r <= state.k ? r : r - state.k);
    return () => flipRound(state, r <= state.k ? r : r - state.k);
  }
  // 随机逃逸：flipPair / flipRound /（允许时）swapOrder
  const roll = rng();
  if (roll < 0.5) {
    const p = Math.floor(rng() * state.pairs.length);
    flipPair(state, p);
    return () => flipPair(state, p);
  }
  if (roll < 0.8 || !allowSwap || state.k < 2) {
    const r = 1 + Math.floor(rng() * state.k);
    flipRound(state, r);
    return () => flipRound(state, r);
  }
  const a = Math.floor(rng() * state.k);
  const b = (a + 1 + Math.floor(rng() * (state.k - 1))) % state.k;
  swapOrder(state, a, b);
  return () => swapOrder(state, a, b);
}

// 修复（§5.4 第 3 步 / §5.5 第 2 步）：定向修复 + 指数退火（T 5.0→0.05）+ 随机逃逸。
// symmetric（allowSwap=false）以 cost=0 为目标；asymmetric 到 hard=0 即交棒 improve。
// 全程维护 cost 最优快照，结束时不优于快照则回滚。
function repair(
  state: DoubleState,
  rng: () => number,
  deadline: number,
  allowSwap: boolean,
  maxSteps: number
): void {
  let bestCost = stateCost(state);
  let bestFlip = [...state.flip];
  let bestOrder = [...state.orders[0]];
  for (let step = 0; step < maxSteps; step++) {
    if (allowSwap ? state.hard === 0 : stateCost(state) === 0) break;
    if ((step & 255) === 255 && Date.now() >= deadline) break;
    const T = Math.max(T1, T0 * Math.pow(T1 / T0, step / maxSteps));
    const oldCost = stateCost(state);
    const undo = applyMove(state, rng, allowSwap);
    const newCost = stateCost(state);
    if (newCost > oldCost && rng() >= Math.exp((oldCost - newCost) / T)) {
      undo();
    } else if (newCost < bestCost) {
      bestCost = newCost;
      bestFlip = [...state.flip];
      bestOrder = [...state.orders[0]];
    }
  }
  if (stateCost(state) > bestCost) restoreState(state, bestFlip, bestOrder);
}

// improve（§5.5 第 3 步）：hard=0 后重复「随机 swapOrder → repair」；
// 仍 hard=0 且 nonMirrorRounds 增加（或持平但 soft 下降）才保留，否则回滚。返回接受的换位次数。
function improve(state: DoubleState, rng: () => number, deadline: number): number {
  if (state.hard !== 0 || state.k < 2) return 0;
  let curNm = nonMirrorCount(state.orders[0]);
  let curSoft = state.soft;
  let swaps = 0;
  for (let step = 0; step < IMPROVE_MAX_STEPS; step++) {
    if (curNm >= state.k) break; // 已是完全错位排列，非镜像轮无法更多
    if ((step & 255) === 255 && Date.now() >= deadline) break;
    const snapFlip = [...state.flip];
    const snapOrder = [...state.orders[0]];
    const a = Math.floor(rng() * state.k);
    const b = (a + 1 + Math.floor(rng() * (state.k - 1))) % state.k;
    swapOrder(state, a, b);
    repair(state, rng, deadline, true, REPAIR_BOUNDED_STEPS);
    const nm = nonMirrorCount(state.orders[0]);
    if (state.hard === 0 && (nm > curNm || (nm === curNm && state.soft < curSoft))) {
      curNm = nm;
      curSoft = state.soft;
      swaps++;
    } else {
      restoreState(state, snapFlip, snapOrder);
    }
  }
  return swaps;
}

function rotateRight(order: number[]): number[] {
  if (order.length <= 1) return [...order];
  return [order[order.length - 1], ...order.slice(0, -1)];
}

function fisherYates<T>(arr: readonly T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- 确定性随机原语（§5.7/§5.8） ----------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface HashHalfMatch {
  round: number;
  slot: number;
  home: number;
  away: number;
}

// complete-double 默认 seed：对第一循环场次序列（round/slot/home/away）的稳定 32 位哈希。
// 同一批场次永远得到同一 seed → 不带 seed 重跑幂等（§5.7 第 2 步）。
export function hash32(stageId: number, firstHalf: readonly HashHalfMatch[]): number {
  let h = (0x811c9dc5 ^ Math.imul(stageId | 0, 0x9e3779b1)) | 0;
  const mix = (v: number) => {
    h = Math.imul(h ^ (v | 0), 0x01000193);
    h ^= h >>> 15;
  };
  for (const m of firstHalf) {
    mix(m.round);
    mix(m.slot);
    mix(m.home);
    mix(m.away);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return h >>> 0;
}

// ---------- 状态 → 场次输出 ----------

// 按 round 升序输出；轮内按第一循环对序（同轮的第二循环场次继承其源轮的对序），
// 保证路由按轮内计数分配 slot 时稳定可复现（§6.3）。
export function stateMatches(state: DoubleState): RrMatch[] {
  const out: RrMatch[] = [];
  const k = state.k;
  for (let r = 1; r <= k; r++) {
    for (let p = 0; p < state.pairs.length; p++) {
      if (state.pairRound[p] !== r) continue;
      const [a, b] = state.pairs[p];
      const f = state.flip[p];
      out.push({ round: r, home: f ? b : a, away: f ? a : b });
      out.push({ round: k + state.orders[0][r - 1] + 1, home: f ? a : b, away: f ? b : a });
    }
  }
  return out.sort((x, y) => x.round - y.round); // Array.sort 稳定（ES2019+），轮内顺序保持
}

// ---------- generate 双模式搜索（§5.4/§5.5） ----------

export interface GenerateDoubleOptions {
  mode: "mirror" | "asymmetric";
  seed: number;
  budgetMs: number;
}

export interface GenerateDoubleResult {
  mode: "mirror" | "asymmetric";
  balanced: boolean; // hard === 0
  rounds: number; // 2k
  matches: RrMatch[]; // round 升序、轮内按第一循环对序
  hard: number;
  soft: number;
  nonMirrorRounds: number;
  swaps: number; // asymmetric 接受的换位次数；mirror 恒 0
  ms: number;
  violations: { hard: Violation[]; soft: Violation[] };
  warnings: string[];
}

interface Candidate {
  flip: boolean[];
  order: number[];
  hard: number;
  soft: number;
  nm: number;
  swaps: number;
}

// §5.5 第 4 步：优先 hard=0，其次 nonMirrorRounds 最大，再其次 soft 最小；没有 hard=0 取 hard 最小
function isBetter(a: Candidate, b: Candidate | null): boolean {
  if (!b) return true;
  if (a.hard === 0 !== (b.hard === 0)) return a.hard === 0;
  if (a.hard !== b.hard) return a.hard < b.hard;
  if (a.hard === 0) {
    if (a.nm !== b.nm) return a.nm > b.nm;
    return a.soft < b.soft;
  }
  return a.soft < b.soft;
}

export function generateDouble(n: number, opts: GenerateDoubleOptions): GenerateDoubleResult {
  if (n < 2) throw new Error("至少需要 2 支球队");
  const t0 = Date.now();
  const deadline = t0 + Math.max(0, Math.floor(opts.budgetMs));
  const rng = mulberry32(opts.seed >>> 0);
  const base = roundRobinPairs(n);
  const k = base.length;
  const pairs: Array<[number, number]> = [];
  const pairRound: number[] = [];
  base.forEach((rp, ri) => {
    for (const [a, b] of rp) {
      pairs.push([a, b]);
      pairRound.push(ri + 1);
    }
  });
  const flip0 = initialFlip(pairs, pairRound, n);
  const identity = Array.from({ length: k }, (_, i) => i);
  // asymmetric 起点（§5.5 第 1 步）：identity + rot1 + 1–2 个随机排列；不使用 reverse
  const starts =
    opts.mode === "mirror"
      ? [identity]
      : [identity, rotateRight(identity), fisherYates(identity, rng), fisherYates(identity, rng)];

  let winner: Candidate | null = null;
  for (let i = 0; i < starts.length; i++) {
    if (i > 0 && Date.now() >= deadline) break;
    const state = buildDoubleState(n, flip0, starts[i]);
    repair(state, rng, deadline, opts.mode === "asymmetric", REPAIR_MAX_STEPS);
    let swaps = 0;
    if (opts.mode === "asymmetric" && state.hard === 0) {
      swaps = improve(state, rng, deadline);
    }
    const cand: Candidate = {
      flip: [...state.flip],
      order: [...state.orders[0]],
      hard: state.hard,
      soft: state.soft,
      nm: nonMirrorCount(state.orders[0]),
      swaps,
    };
    if (isBetter(cand, winner)) winner = cand;
    // 已达完全错位排列且 hard=0：不可能更好，提前收工
    if (winner && winner.hard === 0 && k >= 2 && winner.nm >= k) break;
  }

  const win = winner ?? { flip: flip0, order: identity, hard: 0, soft: 0, nm: 0, swaps: 0 };
  const state = buildDoubleState(n, win.flip, win.order);
  const warnings: string[] = [];
  // §5.5 第 5 步 / §5.8：做出了硬约束但没能不对称
  if (opts.mode === "asymmetric" && state.hard === 0 && nonMirrorCount(state.orders[0]) === 0) {
    warnings.push("未能做出不对称");
  }
  return {
    mode: opts.mode,
    balanced: state.hard === 0,
    rounds: state.k * 2,
    matches: stateMatches(state),
    hard: state.hard,
    soft: state.soft,
    nonMirrorRounds: nonMirrorCount(state.orders[0]),
    swaps: win.swaps,
    ms: Date.now() - t0,
    violations: { hard: state.violations.hard, soft: state.violations.soft },
    warnings,
  };
}

// ---------- complete-double 轮序（§5.7） ----------

export interface CompleteDoubleOrderResult {
  // 0-based 排列；order[r-1] = 第一循环第 r 轮的重赛在第二循环的位置（0-based），
  // 即第二循环 round = k + order[r-1] + 1（spec §5.7 第 6 步；与 stateMatches 的 orders[0] 同向）
  order: number[];
  warnings: string[];
}

export function completeDoubleOrder(k: number, opts: { seed: number }): CompleteDoubleOrderResult {
  // k<=1（2 队）只有一种轮序，无非对称空间（§5.7 第 5 步）
  if (k <= 1) return { order: k === 1 ? [0] : [], warnings: ["队数过少，无非对称空间"] };
  const order = fisherYates(Array.from({ length: k }, (_, i) => i), mulberry32(opts.seed));
  // 洗牌恰好得到 identity：循环右移 1 位，保证非镜像（§5.7 第 4 步）
  if (order.every((v, i) => v === i)) order.unshift(order.pop()!);
  return { order, warnings: [] };
}
