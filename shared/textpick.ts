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
