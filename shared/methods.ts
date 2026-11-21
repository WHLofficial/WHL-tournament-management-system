// 进球方式 / 助攻方式词表：唯一真源，worker 校验与前端下拉共用这一份。
// 词与顺序照 docs/news-method-copybank.md §2（method，14 词）/ §3（assist_method，13 词）定稿，
// 中文标签即两节的小节标题名，逐字一致。迁移 0038 的 match_event 两列 CHECK 约束与这两个数组一一对应。
// 联动规则（pen_goal / own_goal 拒绝两列；solo 与 free_kick 直接打门不记助攻、录入端隐藏助攻框；
// assist_method 仅在选了助攻人时允许）由录入端与 worker 校验实现，本文件只管词表与显示名。

export const GOAL_METHODS = [
  "long_shot",
  "curler",
  "drive",
  "header",
  "volley",
  "chip",
  "tap_in",
  "rebound",
  "one_on_one",
  "free_kick",
  "counter",
  "solo",
  "first_time",
  "turn_shot",
] as const;

export type GoalMethod = (typeof GOAL_METHODS)[number];

export const ASSIST_METHODS = [
  "cross_45",
  "cross_byline",
  "through_ball",
  "long_pass",
  "lofted_pass",
  "cutback",
  "give_and_go",
  "dribble_pass",
  "set_piece",
  "corner_kick",
  "free_kick_delivery",
  "backheel",
  "keeper_launch",
] as const;

export type AssistMethod = (typeof ASSIST_METHODS)[number];

// 显示名（前端下拉、时间线徽标用）
export const METHOD_LABEL: Record<GoalMethod, string> = {
  long_shot: "远射",
  curler: "兜射",
  drive: "劲射",
  header: "头球",
  volley: "凌空抽射",
  chip: "挑射",
  tap_in: "近距离推捅",
  rebound: "补射",
  one_on_one: "单刀",
  free_kick: "任意球直接",
  counter: "反击终结",
  solo: "个人一条龙",
  first_time: "不停球直接打门",
  turn_shot: "转身抽射",
};

export const ASSIST_METHOD_LABEL: Record<AssistMethod, string> = {
  cross_45: "45 度传中",
  cross_byline: "下底传中",
  through_ball: "直塞",
  long_pass: "长传调度",
  lofted_pass: "过顶挑传",
  cutback: "倒三角",
  give_and_go: "撞墙二过一",
  dribble_pass: "突破分球",
  set_piece: "定位球做球",
  corner_kick: "角球传中",
  free_kick_delivery: "任意球传中",
  backheel: "脚后跟",
  keeper_launch: "门将长传发动",
};
