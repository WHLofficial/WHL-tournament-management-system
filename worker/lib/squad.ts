// 现役归属口径（docs/design-tournament-player-teams.md §4.1）：
// player_team_history 里一条 left_at IS NULL 的开放窗口 = 现役。名单、归属校验、榜单队名
// 全从这里取，不要再直接读 player 表判断归属（0035 已删列）。
// 15 处读端共用这里的片段：join 条件只写一遍，漏掉 left_at IS NULL 的读端就没有第二次机会。

/** 单队名单；排序表达式全站一致（号码空值最后、按数字序），改动前先看 d1 执行计划测试 */
export const SQUAD_PLAYERS_SQL = `SELECT p.id, p.name, p.number
  FROM player_team_history h
  JOIN player p ON p.id = h.player_id
  WHERE h.team_id = ? AND h.left_at IS NULL
  ORDER BY (p.number IS NULL), CAST(p.number AS INTEGER), p.number, p.id`;

/** 赛事批量名单：一次取齐所有参赛队的现役球员，按队分组用 */
export const TOURNAMENT_SQUAD_PLAYERS_SQL = `SELECT p.id, h.team_id, p.name, p.number
  FROM player_team_history h
  JOIN player p ON p.id = h.player_id
  WHERE h.left_at IS NULL
    AND h.team_id IN (SELECT team_id FROM entry WHERE tournament_id = ?)
  ORDER BY h.team_id, (p.number IS NULL), CAST(p.number AS INTEGER), p.number, p.id`;

/** 归属校验：这 n 个球员是否都在这支队的开放窗口里（参数顺序：teamId, ...playerIds） */
export function squadOwnedCountSql(n: number): string {
  return `SELECT COUNT(*) AS n FROM player_team_history h
    WHERE h.team_id = ? AND h.left_at IS NULL
      AND h.player_id IN (${Array.from({ length: n }, () => "?").join(",")})`;
}

/** 某球员当前所属队 id 的标量子查询（最多一行，开放窗口异常时也不会让外层行翻倍） */
export function currentTeamIdSql(playerExpr: string): string {
  return `(SELECT h.team_id FROM player_team_history h
    WHERE h.player_id = ${playerExpr} AND h.left_at IS NULL
    ORDER BY h.joined_at DESC, h.id DESC LIMIT 1)`;
}
