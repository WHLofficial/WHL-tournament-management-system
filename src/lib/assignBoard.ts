// 定位球编排页的半场板摆位：板子横放——对方球门在上、中线在下（角球防守那面是自家球门在上）。
// 坐标是板子宽高的百分比（x 从左、y 从上），钉子跟战术页磁贴一样用 translate(-50%,-50%) 居中，
// 所以摆位只跟板子的宽高比有关，跟屏幕宽度无关。
import type { AssignKey } from "../../shared/tactics";

export type AssignBoardSide = "attack" | "defense";

/** 钉子：上面一行槽位短码，下面一行姓氏（空位画虚线框「空」） */
export type AssignNail = { short: string; x: number; y: number };

export const ASSIGN_NAILS: Record<AssignKey, AssignNail> = {
  // 队长没有板子（纯候选列表），这条只是让表覆盖全部 18 个键
  captain: { short: "队长", x: 50, y: 50 },
  // 任意球：点球点在罚球点上，左右短任意球在两侧禁区前沿，长任意球在中线附近
  fk_penalty: { short: "点球", x: 50, y: 21 },
  fk_left_short: { short: "左短", x: 24, y: 42 },
  fk_right_short: { short: "右短", x: 76, y: 42 },
  fk_long: { short: "远距", x: 50, y: 78 },
  // 角球进攻：两角旗、门前两点、点球点（目标球员）、弧顶、后场掩护
  ca_left: { short: "左角", x: 11, y: 9 },
  ca_right: { short: "右角", x: 89, y: 9 },
  ca_near: { short: "近柱", x: 31, y: 20 },
  ca_far: { short: "远柱", x: 69, y: 20 },
  ca_target: { short: "目标", x: 50, y: 33 },
  ca_arc: { short: "弧顶", x: 50, y: 56 },
  ca_cover: { short: "掩护", x: 50, y: 80 },
  // 角球防守：门线、两侧门柱、禁区里盯人
  cd_guard: { short: "门柱", x: 50, y: 8 },
  cd_near: { short: "近柱", x: 30, y: 21 },
  cd_far: { short: "远柱", x: 70, y: 21 },
  cd_threat: { short: "盯防", x: 50, y: 36 },
  // 界外球：两侧边线（贴边线摆，坐标留出钉子自身的宽度）
  ti_left: { short: "左线", x: 12, y: 45 },
  ti_right: { short: "右线", x: 88, y: 45 },
};

/** 哪几组有半场板、板子算攻还是守（队长组没有板子 → 查不到） */
export const ASSIGN_BOARD_SIDE: Record<string, AssignBoardSide> = {
  任意球: "attack",
  角球进攻: "attack",
  界外球: "attack",
  角球防守: "defense",
};

export function boardSideOf(groupTitle: string): AssignBoardSide | null {
  return ASSIGN_BOARD_SIDE[groupTitle] ?? null;
}
