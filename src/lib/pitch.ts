// 球场磁贴坐标（%）：y 越小越靠近己方球门（GK 在底部），进攻朝上。
// 战术板与赛前情报的「典型首发」小战术板共用这一套摆位。
// 磁贴 92x44 时，29 种阵型在桌面 460x590 与手机 314x396 / 299x377 三种球场尺寸下都不重叠
// （tests/pitch.test.ts 守着）。整张表按 12% 一档从 GK 铺到 ST，两条底线就是从这里来的：
// 纵向每一档都要 ≥12%（球场矮于 367px 相邻两档就贴上），同行磁贴之间要 ≥32% 横向间距（内框窄于 288px 就贴上）。
// 改任何一个 y 之前先跑 tests/pitch.test.ts：档距一缩，整列都会连锁贴上来。
export const POS_XY: Record<string, [number, number]> = {
  GK: [50, 6],
  CB: [50, 18],
  RB: [84, 30],
  LB: [16, 30],
  CDM: [50, 42],
  CM: [50, 54],
  RM: [80, 66],
  LM: [20, 66],
  CAM: [50, 78],
  RW: [84, 78],
  LW: [16, 78],
  ST: [50, 90],
};

// 同位多人时的横向散开（%）。相邻两个要隔 32%，正好等于 92px 磁贴在 288px 宽球场上的宽度占比。
// 29 种阵型里同位置最多 3 人（4 人同排不存在，3 中卫还会被 tilePositions 的回退覆盖），第 4 档只是兜底。
export const SPREAD: Record<number, number[]> = {
  2: [-16, 16],
  3: [-32, 0, 32],
  4: [-32, -11, 11, 32],
};

export const CENTRAL: Record<string, number | undefined> = { CB: 1, CDM: 1, CM: 1, CAM: 1, ST: 1 };

// 磁贴尺寸（px），与 styles.css 的 .tac-tile 一致；磁贴上的名字可用宽 = TILE_W - 左右内边距 4x2 - 边框 1.5x2。
export const TILE_W = 92;
export const TILE_H = 44;
export const TILE_NAME_MAX = TILE_W - 11;

// 阵型磁贴摆位：同位多人散开，三中卫时 RB/LB 回收到中圈高度、CB 上提。
// 返回与 FormDef.pos 等长的坐标数组，供磁贴按序取用。
// 同位多人的左右：阵型槽序是「右→左」枚举的（数据里 RB 在 LB 前、RM 在 LM 前、RW 在 LW 前，
// 而游戏把 RW 画在右），所以槽序在前的人画在靠右，SPREAD 下标要倒着取。
export function tilePositions(positions: string[]): [number, number][] {
  const counts: Record<string, number> = {};
  for (const p of positions) counts[p] = (counts[p] ?? 0) + 1;
  const seen: Record<string, number> = {};
  const cbN = positions.filter((p) => p === "CB").length;
  return positions.map((position) => {
    const xy: [number, number] = [...POS_XY[position]];
    if (CENTRAL[position] && counts[position] > 1) {
      const n = counts[position];
      xy[0] += SPREAD[n][n - 1 - (seen[position] || 0)];
    }
    if (cbN >= 3) {
      if (position === "RB" || position === "LB") xy[1] = 38;
      if (position === "CB") xy[1] = 24;
    }
    seen[position] = (seen[position] || 0) + 1;
    return xy;
  });
}

// 热区取哪一套：中轴线上的位置（CB/CDM/CM/CAM/ST）在 FC26 数据里有 Default/Left/Right 三套，
// 按磁贴横向落在中线的哪一侧选（x < 50 取 Left、x > 50 取 Right、正落在 50 用 Default）。
export function heatSide(x: number): "L" | "R" | null {
  if (x < 50) return "L";
  if (x > 50) return "R";
  return null;
}

// 磁贴上的名字只留最后一节（Toni Kroos → Kroos），长姓氏靠缩字号解决，不再切连字符。
export function surname(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] || name;
}

// 磁贴名字的字号：名字固定一行不换行、不省略，放不下就按比例缩。
// measure 可注入（测试里用假量宽），量不到宽度（无 DOM）时返回基准字号。
export const NAME_BASE_SIZE = 10;
export function nameFontSize(
  text: string,
  maxWidth: number,
  measure?: (text: string, size: number) => number,
): number {
  if (!text || maxWidth <= 0) return NAME_BASE_SIZE;
  const w = (measure ?? measureText)(text, NAME_BASE_SIZE);
  if (w <= 0 || w <= maxWidth) return NAME_BASE_SIZE;
  return Math.max(6, Math.round((NAME_BASE_SIZE * maxWidth) / w * 100) / 100);
}

let ctx: CanvasRenderingContext2D | null | undefined;
function measureText(text: string, size: number): number {
  if (ctx === undefined) {
    ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  }
  if (!ctx) return 0;
  ctx.font = `500 ${size}px system-ui, sans-serif`;
  return ctx.measureText(text).width;
}
