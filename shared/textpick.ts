// 确定性变体选择：同一 seed 永远选中同一变体（pubCache、重复请求、验收都稳），
// 不同 seed 均匀散开——后端句库（战报/快讯/综述）与前端头条版式 class 共用。
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

// 确定性加权抽选：weightOf 越大的项被抽中越多（与上两者同族，同 seed 同结果）。
// 「随机伤名」这类常见伤多、少见伤少的抽选走这里；权重全为 0 时退回第一项。
export function pickWeighted<T>(
  seed: string,
  items: readonly T[],
  weightOf: (item: T) => number,
): T {
  if (items.length === 0) throw new Error("pickWeighted: items 不能为空");
  let total = 0;
  for (const it of items) total += Math.max(0, weightOf(it));
  if (total === 0) return items[0];
  let roll = hash32(seed) % total;
  for (const it of items) {
    roll -= Math.max(0, weightOf(it));
    if (roll < 0) return it;
  }
  return items[items.length - 1];
}
