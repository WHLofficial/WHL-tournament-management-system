// 球场磁贴坐标（%）：照搬战术板（Tactics.tsx 的 POS_XY/SPREAD/CENTRAL 与三中卫回收规则）。
// 用于赛前情报的「典型首发」小战术板，与战术板保持同一套摆位视觉。
export const POS_XY: Record<string, [number, number]> = {
  GK: [50, 6],
  CB: [50, 20],
  RB: [84, 28],
  LB: [16, 28],
  CDM: [50, 38],
  CM: [50, 53],
  RM: [80, 55],
  LM: [20, 55],
  CAM: [50, 70],
  RW: [78, 79],
  LW: [22, 79],
  ST: [50, 88],
};

export const SPREAD: Record<number, number[]> = {
  2: [-13, 13],
  3: [-22, 0, 22],
  4: [-24, -8, 8, 24],
};

export const CENTRAL: Record<string, number | undefined> = { CB: 1, CDM: 1, CM: 1, CAM: 1, ST: 1 };

// 阵型磁贴摆位：同位多人散开，三中卫时 RB/LB 回收到中圈高度、CB 上提。
// 返回与 FormDef.pos 等长的坐标数组，供磁贴按序取用。
export function tilePositions(positions: string[]): [number, number][] {
  const counts: Record<string, number> = {};
  for (const p of positions) counts[p] = (counts[p] ?? 0) + 1;
  const seen: Record<string, number> = {};
  const cbN = positions.filter((p) => p === "CB").length;
  return positions.map((position) => {
    const xy: [number, number] = [...POS_XY[position]];
    if (CENTRAL[position] && counts[position] > 1) {
      xy[0] += SPREAD[counts[position]][seen[position] || 0];
    }
    if (cbN >= 3) {
      if (position === "RB" || position === "LB") xy[1] = 38;
      if (position === "CB") xy[1] = 24;
    }
    seen[position] = (seen[position] || 0) + 1;
    return xy;
  });
}
