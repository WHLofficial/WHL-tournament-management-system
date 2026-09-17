// 确定性变体选择：同一 seed 永远选中同一变体（pubCache、重复请求、验收都稳），
// 不同 seed 均匀散开——后端句库（战报/快讯/综述）与前端头条版式 class 共用。
// 确定性只服务于「渲染可复现」：内容生成一律不用 Math.random；而用户点击触发的
// 交互式随机（如「随机伤名」）本身就该每次不同，走下面的 pickWeightedAt。
// FNV-1a 32 位：够散、无依赖。
function hash32(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function pickText<T>(seed: string, variants: readonly T[]): T {
  return variants[hash32(seed) % variants.length];
}

// 确定性概率掷骰：rate 取 0..1（千分位精度）。与 pickText 同族（FNV-1a），
// 同 seed 永远同结果、不同 seed 散开；渲染必须可复现，Math.random 一律禁用。
export function chance(seed: string, rate: number): boolean {
  return hash32(seed) % 1000 < Math.round(rate * 1000);
}

// 加权抽选：frac 是 [0,1) 上的均匀随机数（交互式随机传 Math.random()），
// weightOf 越大的项命中率越高；权重全为 0 时退回第一项。
export function pickWeightedAt<T>(
  frac: number,
  items: readonly T[],
  weightOf: (item: T) => number,
): T {
  if (items.length === 0) throw new Error("pickWeightedAt: items 不能为空");
  let total = 0;
  for (const it of items) total += Math.max(0, weightOf(it));
  if (total === 0) return items[0];
  let roll = Math.min(1, Math.max(0, frac)) * total;
  for (const it of items) {
    roll -= Math.max(0, weightOf(it));
    if (roll < 0) return it;
  }
  return items[items.length - 1];
}
