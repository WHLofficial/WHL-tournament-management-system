// 增量 37：建队/批量报名的行输入解析（「游戏球队 ID 队名」）。
// 队名上限与俱乐部平台对齐（club.clubs.name 限 40）——建队要推过去建档，
// 两边上限不一致就会出现「本仓建得下、推过去被拒」。
export const NAME_MAX = 40;
export const BULK_MAX = 64;

export interface ParsedTeamLine {
  id: number;
  name: string;
}

/** 解析一行：「游戏球队 ID 队名」，分隔符收空格/tab/中英文逗号 */
export function parseBulkLine(line: string): ParsedTeamLine | { error: string } {
  const m = line.match(/^(\d+)[\s,，\t]+(.+)$/);
  if (!m) return { error: "格式应为「游戏球队 ID 队名」，如 1 Arsenal" };
  const id = Number(m[1]);
  const name = m[2].trim();
  if (!Number.isInteger(id) || id <= 0) return { error: "游戏球队 ID 应为正整数" };
  if (!name) return { error: "缺少队名" };
  if (name.length > NAME_MAX) return { error: `队名不超过 ${NAME_MAX} 字` };
  return { id, name };
}
