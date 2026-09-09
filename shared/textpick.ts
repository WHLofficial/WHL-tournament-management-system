// 确定性变体选择：同一 seed 永远选中同一变体（pubCache、重复请求、验收都稳），
// 不同 seed 均匀散开——后端句库（战报/快讯/综述）与前端头条版式 class 共用。
// FNV-1a 32 位：够散、无依赖。
export function pickText<T>(seed: string, variants: readonly T[]): T {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return variants[(h >>> 0) % variants.length];
}

// 确定性概率掷骰：rate 取 0..1（千分位精度）。与 pickText 同族（FNV-1a），
// 同 seed 永远同结果、不同 seed 散开；渲染必须可复现，Math.random 一律禁用。
export function chance(seed: string, rate: number): boolean {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 1000 < Math.round(rate * 1000);
}
