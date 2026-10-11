// 默认展示轮的统一口径（公开赛事页的轮次条与管理页「比赛」tab 共用，避免两侧再分叉）：
// 正在打的轮 > 最早有未开打场次的轮 > 最后一轮（全完赛时停在最近打完的一轮）。
// 传入的 pending 必须只数「还要打的场次」——轮空场 status 也是 pending 但不会再打，
// 统计侧须先排除（见 shared/matchNotes.ts 的 BYE_NOTE），否则默认轮会卡在含轮空的首轮。
export function defaultRoundIndex(
  chips: readonly { live: number; pending: number }[],
): number {
  if (chips.length === 0) return -1;
  const live = chips.findIndex((c) => c.live > 0);
  if (live >= 0) return live;
  const pending = chips.findIndex((c) => c.pending > 0);
  if (pending >= 0) return pending;
  return chips.length - 1;
}
