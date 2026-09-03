import type { TournamentFormat, TournamentStatus } from "../shared/types";

export const STATUS_LABEL: Record<TournamentStatus, string> = {
  draft: "草稿",
  registering: "报名中",
  running: "进行中",
  archived: "已归档",
};

export const FORMAT_LABEL: Record<TournamentFormat, string> = {
  single_elim: "单败淘汰",
  round_robin: "循环赛",
  group_knockout: "小组赛 + 淘汰赛",
  custom: "自定义",
};

export const FORMAT_HINT: Record<TournamentFormat, string> = {
  single_elim: "输一场就出局，可加季军赛",
  round_robin: "每两队交手两个回合，主客互换",
  group_knockout: "先分组单循环，出线后交叉打淘汰赛",
  custom: "从空白开始，在编排页自己搭阶段",
};

export const NEXT_ACTIONS: Record<
  TournamentStatus,
  { to: TournamentStatus; label: string; confirm?: string }[]
> = {
  draft: [{ to: "registering", label: "发布报名" }],
  registering: [
    { to: "draft", label: "退回草稿" },
    { to: "running", label: "开赛", confirm: "开赛后报名名单将锁定，确定开赛吗？" },
  ],
  running: [{ to: "archived", label: "归档", confirm: "归档后会锁定最终排名，确定归档吗？" }],
  archived: [],
};
