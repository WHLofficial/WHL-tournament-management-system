import type { BoundAccountRow } from "./authClient";
import type { AdminProxyGrantDTO, ProxySessionDTO } from "../../shared/types";

// 阵容代打授权（migration 0023）：管理员把「提交某队某场阵容」的权限临时授给另一个账号。
// 精确到单场，所以有效性只有两个条件——未撤销 + 比赛未开打。开赛即天然失效。
// 判活集中在这里，调用方不要再各自拼 status 条件。

type StageKind = "elim" | "round_robin" | "group";

type GrantRow = {
  id: number;
  match_id: number;
  team_id: number;
  grantee_user_id: number;
  granted_by: number;
  revoked_at: string | null;
  created_at: string;
  match_status: "pending" | "live" | "finished";
  round: number;
  leg: number | null;
  tournament_id: number;
  tournament_name: string;
  stage_name: string | null;
  stage_kind: StageKind;
  team_name: string | null;
  home_tid: number | null;
  away_tid: number | null;
  home_team_name: string | null;
  away_team_name: string | null;
  sub_id: number | null;
  sub_by: number | null;
};

const GRANT_SELECT = `
  g.id, g.match_id, g.team_id, g.grantee_user_id, g.granted_by, g.revoked_at, g.created_at,
  m.status AS match_status, m.round, m.leg,
  t.id AS tournament_id, t.name AS tournament_name,
  s.name AS stage_name, s.kind AS stage_kind,
  tt.name AS team_name,
  he.team_id AS home_tid, ae.team_id AS away_tid,
  ht.name AS home_team_name, at.name AS away_team_name,
  ts.id AS sub_id, ts.created_by AS sub_by
FROM lineup_proxy_grant g
JOIN match m ON m.id = g.match_id
JOIN stage s ON s.id = m.stage_id
JOIN tournament t ON t.id = s.tournament_id
LEFT JOIN entry he ON he.id = m.home_entry_id
LEFT JOIN entry ae ON ae.id = m.away_entry_id
LEFT JOIN team ht ON ht.id = he.team_id
LEFT JOIN team at ON at.id = ae.team_id
LEFT JOIN team tt ON tt.id = g.team_id
LEFT JOIN tactic_submission ts ON ts.match_id = g.match_id AND ts.team_id = g.team_id`;

/**
 * 账号姓名与球队名的来源。OIDC 收口后新账号在本库 user 表没有行，
 * 所以姓名只能取 auth 库 account.name——用本库 JOIN 会正好漏掉要授权的那批人。
 */
export interface AccountNames {
  name(userId: number | null): string | null;
  teamName(userId: number): string | null;
}

export function accountNames(rows: BoundAccountRow[]): AccountNames {
  const nameById = new Map<number, string>();
  const teamById = new Map<number, string | null>();
  for (const r of rows) {
    nameById.set(r.userId, r.name);
    teamById.set(r.userId, r.teamName);
  }
  return {
    name: (id) => (id == null ? null : nameById.get(id) ?? `账号 #${id}`),
    teamName: (id) => teamById.get(id) ?? null,
  };
}

function isActive(r: GrantRow): boolean {
  return r.revoked_at === null && r.match_status === "pending";
}

function side(r: GrantRow): "home" | "away" {
  return r.home_tid === r.team_id ? "home" : "away";
}

function toSession(r: GrantRow, acct: AccountNames): ProxySessionDTO {
  const s = side(r);
  return {
    matchId: r.match_id,
    teamId: r.team_id,
    teamName: r.team_name ?? `球队 #${r.team_id}`,
    opponentName: s === "home" ? r.away_team_name : r.home_team_name,
    side: s,
    tournamentId: r.tournament_id,
    tournamentName: r.tournament_name,
    stageName: r.stage_name,
    stageKind: r.stage_kind,
    round: r.round,
    leg: r.leg,
    submitted: r.sub_id !== null,
    submittedBy: acct.name(r.sub_by),
    grantedByName: acct.name(r.granted_by),
    grantedAt: r.created_at,
  };
}

function toAdminGrant(r: GrantRow, acct: AccountNames): AdminProxyGrantDTO {
  const s = side(r);
  return {
    id: r.id,
    matchId: r.match_id,
    teamId: r.team_id,
    teamName: r.team_name ?? `球队 #${r.team_id}`,
    opponentName: s === "home" ? r.away_team_name : r.home_team_name,
    side: s,
    tournamentId: r.tournament_id,
    tournamentName: r.tournament_name,
    stageName: r.stage_name,
    round: r.round,
    granteeUserId: r.grantee_user_id,
    granteeName: acct.name(r.grantee_user_id),
    granteeTeamName: acct.teamName(r.grantee_user_id),
    grantedBy: r.granted_by,
    grantedByName: acct.name(r.granted_by),
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
    active: isActive(r),
    submitted: r.sub_id !== null,
  };
}

// 代打端鉴权：这个账号对这场有有效授权吗？返回目标队（teamId 只从授权行推导，不接受请求参数）
export async function findGrantForGrantee(
  db: D1Database,
  matchId: number,
  granteeUserId: number,
): Promise<{ id: number; teamId: number; teamName: string } | null> {
  const r = await db
    .prepare(
      `SELECT ${GRANT_SELECT} WHERE g.match_id = ? AND g.grantee_user_id = ?
         AND g.revoked_at IS NULL AND m.status = 'pending'`,
    )
    .bind(matchId, granteeUserId)
    .first<GrantRow>();
  if (!r) return null;
  return { id: r.id, teamId: r.team_id, teamName: r.team_name ?? `球队 #${r.team_id}` };
}

// 本队教练闸：这场这一队有没有有效代打授权
export async function findGrantForTeam(
  db: D1Database,
  matchId: number,
  teamId: number,
): Promise<{ id: number; granteeUserId: number } | null> {
  const r = await db
    .prepare(
      `SELECT ${GRANT_SELECT} WHERE g.match_id = ? AND g.team_id = ?
         AND g.revoked_at IS NULL AND m.status = 'pending'`,
    )
    .bind(matchId, teamId)
    .first<GrantRow>();
  if (!r) return null;
  return { id: r.id, granteeUserId: r.grantee_user_id };
}

// 单场会话（代打板取数用）：同一份口径，只取这一场
export async function getGranteeSession(
  db: D1Database,
  matchId: number,
  granteeUserId: number,
  acct: AccountNames,
): Promise<ProxySessionDTO | null> {
  const r = await db
    .prepare(
      `SELECT ${GRANT_SELECT} WHERE g.match_id = ? AND g.grantee_user_id = ?
         AND g.revoked_at IS NULL AND m.status = 'pending'`,
    )
    .bind(matchId, granteeUserId)
    .first<GrantRow>();
  return r ? toSession(r, acct) : null;
}

// 我在代打的清单（战术板身份切换器用）；比赛已开打或已撤销自动消失
export async function listGranteeSessions(
  db: D1Database,
  granteeUserId: number,
  acct: AccountNames,
): Promise<ProxySessionDTO[]> {
  const rows = await db
    .prepare(
      `SELECT ${GRANT_SELECT} WHERE g.grantee_user_id = ?
         AND g.revoked_at IS NULL AND m.status = 'pending'
       ORDER BY t.created_at DESC, s.sort_order, m.round, m.slot`,
    )
    .bind(granteeUserId)
    .all<GrantRow>();
  return (rows.results ?? []).map((r) => toSession(r, acct));
}

// 管理端列表：含已撤销/已开赛的（active 标出来），可按赛事或单场过滤
export async function listGrants(
  db: D1Database,
  filter: { tournamentId?: number | null; matchId?: number | null },
  acct: AccountNames,
): Promise<AdminProxyGrantDTO[]> {
  const conds: string[] = [];
  const binds: number[] = [];
  if (filter.tournamentId != null) {
    conds.push("t.id = ?");
    binds.push(filter.tournamentId);
  }
  if (filter.matchId != null) {
    conds.push("g.match_id = ?");
    binds.push(filter.matchId);
  }
  const where = conds.length > 0 ? ` WHERE ${conds.join(" AND ")}` : "";
  const rows = await db
    .prepare(`SELECT ${GRANT_SELECT}${where} ORDER BY g.created_at DESC, g.id DESC LIMIT 200`)
    .bind(...binds)
    .all<GrantRow>();
  return (rows.results ?? []).map((r) => toAdminGrant(r, acct));
}

// 授权前置校验用：比赛在不在、开没开、有哪两队（含队名与赛事阶段，授权页选完比赛要显示）
export async function matchInfo(
  db: D1Database,
  matchId: number,
): Promise<{
  matchId: number;
  status: "pending" | "live" | "finished";
  tournamentId: number;
  tournamentName: string;
  stageName: string | null;
  round: number;
  leg: number | null;
  homeTeamId: number | null;
  homeTeamName: string | null;
  awayTeamId: number | null;
  awayTeamName: string | null;
} | null> {
  const r = await db
    .prepare(
      `SELECT m.id, m.status, m.round, m.leg,
         t.id AS tournament_id, t.name AS tournament_name, s.name AS stage_name,
         he.team_id AS home_tid, ae.team_id AS away_tid,
         ht.name AS home_team_name, at.name AS away_team_name
       FROM match m
       JOIN stage s ON s.id = m.stage_id
       JOIN tournament t ON t.id = s.tournament_id
       LEFT JOIN entry he ON he.id = m.home_entry_id
       LEFT JOIN entry ae ON ae.id = m.away_entry_id
       LEFT JOIN team ht ON ht.id = he.team_id
       LEFT JOIN team at ON at.id = ae.team_id
       WHERE m.id = ?`,
    )
    .bind(matchId)
    .first<{
      id: number;
      status: "pending" | "live" | "finished";
      round: number;
      leg: number | null;
      tournament_id: number;
      tournament_name: string;
      stage_name: string | null;
      home_tid: number | null;
      away_tid: number | null;
      home_team_name: string | null;
      away_team_name: string | null;
    }>();
  if (!r) return null;
  return {
    matchId: r.id,
    status: r.status,
    tournamentId: r.tournament_id,
    tournamentName: r.tournament_name,
    stageName: r.stage_name,
    round: r.round,
    leg: r.leg,
    homeTeamId: r.home_tid,
    homeTeamName: r.home_team_name,
    awayTeamId: r.away_tid,
    awayTeamName: r.away_team_name,
  };
}

// 建授权。同一 (比赛, 球队, 账号) 已存在则复活（清掉 revoked_at），重新授权不必先撤销
export async function upsertGrant(
  db: D1Database,
  g: { matchId: number; teamId: number; granteeUserId: number; grantedBy: number },
): Promise<number> {
  await db
    .prepare(
      `INSERT INTO lineup_proxy_grant (match_id, team_id, grantee_user_id, granted_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(match_id, team_id, grantee_user_id) DO UPDATE SET
         revoked_at = NULL,
         granted_by = excluded.granted_by,
         created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .bind(g.matchId, g.teamId, g.granteeUserId, g.grantedBy)
    .run();
  const row = await db
    .prepare(
      `SELECT id FROM lineup_proxy_grant
       WHERE match_id = ? AND team_id = ? AND grantee_user_id = ?`,
    )
    .bind(g.matchId, g.teamId, g.granteeUserId)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

// 撤销：置时间戳不硬删（留痕）。返回比赛 id 供审计用，未命中返回 null
export async function revokeGrant(db: D1Database, grantId: number): Promise<number | null> {
  const row = await db
    .prepare("SELECT id, match_id, revoked_at FROM lineup_proxy_grant WHERE id = ?")
    .bind(grantId)
    .first<{ id: number; match_id: number; revoked_at: string | null }>();
  if (!row) return null;
  // 已撤销的再撤一次不当作成功（调用方按「不存在或已撤销」一并处理，避免重复点按留下虚假审计）
  if (row.revoked_at !== null) return null;
  await db
    .prepare(`UPDATE lineup_proxy_grant SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .bind(grantId)
    .run();
  return row.match_id;
}
