// 伤停派生层：与 suspension.ts 同思路，纯派生不落状态列。
// 「伤停中」= 某条登记勾选的缺阵比赛里仍有 pending/live 场；
// 「伤愈进度」= 已完赛的缺阵场 / 总勾选场（勾了 0 场视为已伤愈，仅存档）。
// 删事件、改勾选、补录后下次计算自动生效，无反冲逻辑。
import type {
  InjuryEventCandidateDTO,
  InjuryMissCandidateDTO,
  InjuryMissDTO,
  InjurySeverity,
  InjuryStatusDTO,
  InjuryWatchDTO,
  InjuryWatchGroupDTO,
  MatchEventType,
  PublicAbsenceDTO,
} from "../../shared/types";
import { severityOfEventType } from "../../shared/injuries";
import { mediaUrl } from "./media";

interface InjuryRow {
  id: number;
  team_id: number;
  player_id: number;
  event_id: number;
  injury_name: string | null;
  note: string | null;
  created_at: string;
  event_type: "injury_minor" | "injury_major";
  event_minute: number | null;
  player_name: string;
  from_match_id: number;
  from_tournament_id: number;
  from_tournament_name: string;
  from_round: number;
  from_stage_kind: "elim" | "round_robin" | "group";
}

export interface MissRow {
  injury_id: number;
  match_id: number;
  tournament_id: number;
  tournament_name: string;
  round: number;
  stage_kind: "elim" | "round_robin" | "group";
  status: "pending" | "live" | "finished";
}

// 某队（可跨赛事）全部伤停登记。teamId 为 entry 维度背后的 team id；
// fromLabel 组装成「赛事名 · 第N轮」供管理端展示。
export async function listTeamInjuries(
  db: D1Database,
  teamId: number
): Promise<InjuryStatusDTO[]> {
  const [injuries, misses] = await Promise.all([
    db
      .prepare(
        `SELECT i.id, i.team_id, i.player_id, i.event_id, i.injury_name, i.note, i.created_at,
                me.type AS event_type, me.minute AS event_minute,
                p.name AS player_name,
                fm.id AS from_match_id, ft.id AS from_tournament_id, ft.name AS from_tournament_name,
                fm.round AS from_round, fs.kind AS from_stage_kind
         FROM injury i
         JOIN match_event me ON me.id = i.event_id
         JOIN player p ON p.id = i.player_id
         JOIN match fm ON fm.id = me.match_id
         JOIN stage fs ON fs.id = fm.stage_id
         JOIN tournament ft ON ft.id = fs.tournament_id
         WHERE i.team_id = ?
         ORDER BY i.created_at DESC, i.id DESC`
      )
      .bind(teamId)
      .all<InjuryRow>(),
    missesForTeams(db, [teamId]),
  ]);
  return assemble(injuries.results ?? [], misses.results ?? [], (r) => `${r.from_tournament_name} · 第${r.from_round}轮`);
}

// 公开端：单场比赛（赛前情报/详情页）双方当前缺阵名单。
// 每条登记若勾选了该场即入列，附带伤情（名称/档位/伤愈进度）。
// 公开端 DTO（PublicAbsenceDTO / InjuryWatchDTO / InjuryWatchGroupDTO）定义在 shared/types.ts，
// 前端与管理端共用一份形状；这里转出，老的 `from "../lib/injury"` 导入不受影响
// 管理端集中页：不限队伍的全部登记（带队名，赛事/球队筛在前端做——数据量小）
export async function listAllInjuries(db: D1Database): Promise<InjuryStatusDTO[]> {
  const [injuries, misses] = await Promise.all([
    db
      .prepare(
        `SELECT i.id, i.team_id, i.player_id, i.event_id, i.injury_name, i.note, i.created_at,
                me.type AS event_type, me.minute AS event_minute,
                p.name AS player_name, tm.name AS team_name,
                fm.id AS from_match_id, ft.id AS from_tournament_id, ft.name AS from_tournament_name,
                fm.round AS from_round, fs.kind AS from_stage_kind
         FROM injury i
         JOIN match_event me ON me.id = i.event_id
         JOIN player p ON p.id = i.player_id
         JOIN team tm ON tm.id = i.team_id
         JOIN match fm ON fm.id = me.match_id
         JOIN stage fs ON fs.id = fm.stage_id
         JOIN tournament ft ON ft.id = fs.tournament_id
         ORDER BY i.created_at DESC, i.id DESC`
      )
      .all<InjuryRow & { team_name: string }>(),
    missesAll(db),
  ]);
  return assemble(injuries.results ?? [], misses.results ?? [], () => "", (r) => r.team_name ?? "");
}

// 管理端集中页：已记伤病事件、但还没建伤停登记的事件（「待登记」清单）
export async function listRegistrableInjuryEvents(
  db: D1Database
): Promise<InjuryEventCandidateDTO[]> {
  const r = await db
    .prepare(
      `SELECT me.id AS event_id, me.match_id, me.type AS event_type, me.minute,
              t2.id AS tournament_id, t2.name AS tournament_name,
              s.kind AS stage_kind, m.round, m.status AS match_status, m.finished_at,
              t.id AS team_id, t.name AS team_name,
              p.id AS player_id, p.name AS player_name,
              CASE WHEN e1.team_id = t.id THEN ea.name ELSE eh.name END AS opponent_name
       FROM match_event me
       JOIN match m ON m.id = me.match_id
       JOIN stage s ON s.id = m.stage_id
       JOIN tournament t2 ON t2.id = s.tournament_id
       JOIN entry e1 ON e1.id = m.home_entry_id
       JOIN team eh ON eh.id = e1.team_id
       LEFT JOIN entry e2 ON e2.id = m.away_entry_id
       LEFT JOIN team ea ON ea.id = e2.team_id
       JOIN entry e ON e.id = me.entry_id
       JOIN team t ON t.id = e.team_id
       LEFT JOIN player p ON p.id = me.player_id
       LEFT JOIN injury i ON i.event_id = me.id
       WHERE me.type IN ('injury_minor', 'injury_major') AND i.id IS NULL
       ORDER BY m.finished_at DESC, me.id DESC`,
    )
    .all<{
      event_id: number;
      match_id: number;
      event_type: "injury_minor" | "injury_major";
      minute: number | null;
      tournament_id: number;
      tournament_name: string;
      stage_kind: "elim" | "round_robin" | "group";
      round: number;
      match_status: "pending" | "live" | "finished";
      finished_at: string | null;
      team_id: number;
      team_name: string;
      player_id: number | null;
      player_name: string | null;
      opponent_name: string | null;
    }>();
  return (r.results ?? []).map((x) => ({
    eventId: x.event_id,
    matchId: x.match_id,
    tournamentId: x.tournament_id,
    tournamentName: x.tournament_name,
    round: x.round,
    stageKind: x.stage_kind,
    matchStatus: x.match_status,
    teamId: x.team_id,
    teamName: x.team_name,
    playerId: x.player_id,
    playerName: x.player_name,
    severity: severityOfEventType(x.event_type),
    minute: x.minute,
    opponentName: x.opponent_name,
    finishedAt: x.finished_at,
  }));
}

export type {
  InjuryWatchDTO,
  InjuryWatchGroupDTO,
  PublicAbsenceDTO,
  TournamentInjuriesResp,
} from "../../shared/types";

// 两队伤停，按队分组返回（home/away 各一列）
export async function listMatchAbsences(
  db: D1Database,
  matchId: number,
  homeTeamId: number | null,
  awayTeamId: number | null
): Promise<{ home: PublicAbsenceDTO[]; away: PublicAbsenceDTO[] }> {
  const teamIds = [homeTeamId, awayTeamId].filter((x) => x != null);
  if (teamIds.length === 0) return { home: [], away: [] };
  const [injuries, misses] = await Promise.all([
    db
      .prepare(
        `SELECT i.id, i.team_id, i.player_id, i.event_id, i.injury_name, i.note, i.created_at,
                me.type AS event_type, me.minute AS event_minute,
                p.name AS player_name,
                fm.id AS from_match_id, ft.id AS from_tournament_id, ft.name AS from_tournament_name,
                fm.round AS from_round, fs.kind AS from_stage_kind
         FROM injury i
         JOIN match_event me ON me.id = i.event_id
         JOIN player p ON p.id = i.player_id
         JOIN match fm ON fm.id = me.match_id
         JOIN stage fs ON fs.id = fm.stage_id
         JOIN tournament ft ON ft.id = fs.tournament_id
         WHERE i.team_id IN (${teamIds.map(() => "?").join(",")})`
      )
      .bind(...teamIds)
      .all<InjuryRow>(),
    missesForTeams(db, teamIds),
  ]);
  const byId = assembleRaw(injuries.results ?? [], misses.results ?? []);
  const home: PublicAbsenceDTO[] = [];
  const away: PublicAbsenceDTO[] = [];
  for (const inj of byId.values()) {
    if (!inj.misses.some((m) => m.matchId === matchId)) continue;
    const dto = toPublic(inj);
    if (inj.teamId === homeTeamId) home.push(dto);
    else if (inj.teamId === awayTeamId) away.push(dto);
  }
  home.sort((a, b) => b.recoverPercent - a.recoverPercent || a.playerName.localeCompare(b.playerName, "zh"));
  away.sort((a, b) => b.recoverPercent - a.recoverPercent || a.playerName.localeCompare(b.playerName, "zh"));
  return { home, away };
}

// 伤停动态板块（榜单 tab）：全平台（或某队）「伤停中」球员，按队分组。
// 每条登记若还有未打完的缺阵场即在列；跨赛事标注赛事名。
export async function listActiveInjuries(
  db: D1Database,
  teamId?: number
): Promise<InjuryWatchDTO[]> {
  const [injuries, misses] = await Promise.all([
    teamId != null
      ? db
          .prepare(
            `SELECT i.id, i.team_id, i.player_id, i.event_id, i.injury_name, i.note, i.created_at,
                    me.type AS event_type, me.minute AS event_minute,
                    p.name AS player_name, t.name AS team_name,
                    fm.id AS from_match_id, ft.id AS from_tournament_id, ft.name AS from_tournament_name,
                    fm.round AS from_round, fs.kind AS from_stage_kind
             FROM injury i
             JOIN match_event me ON me.id = i.event_id
             JOIN player p ON p.id = i.player_id
             JOIN team t ON t.id = i.team_id
             JOIN match fm ON fm.id = me.match_id
             JOIN stage fs ON fs.id = fm.stage_id
             JOIN tournament ft ON ft.id = fs.tournament_id
             WHERE i.team_id = ?`
          )
          .bind(teamId)
          .all<InjuryRow & { team_name: string }>()
      : db
          .prepare(
            `SELECT i.id, i.team_id, i.player_id, i.event_id, i.injury_name, i.note, i.created_at,
                    me.type AS event_type, me.minute AS event_minute,
                    p.name AS player_name, t.name AS team_name,
                    fm.id AS from_match_id, ft.id AS from_tournament_id, ft.name AS from_tournament_name,
                    fm.round AS from_round, fs.kind AS from_stage_kind
             FROM injury i
             JOIN match_event me ON me.id = i.event_id
             JOIN player p ON p.id = i.player_id
             JOIN team t ON t.id = i.team_id
             JOIN match fm ON fm.id = me.match_id
             JOIN stage fs ON fs.id = fm.stage_id
             JOIN tournament ft ON ft.id = fs.tournament_id`
          )
          .all<InjuryRow & { team_name: string }>(),
    teamId != null ? missesForTeams(db, [teamId]) : missesAll(db),
  ]);
  const out: InjuryWatchDTO[] = [];
  for (const inj of assembleRaw(injuries.results ?? [], misses.results ?? [], (r) => (r as InjuryRow & { team_name: string }).team_name).values()) {
    const remaining = inj.misses.filter((m) => m.status !== "finished");
    if (remaining.length === 0) continue; // 已伤愈，不在「伤停中」
    out.push({
      playerId: inj.playerId,
      playerName: inj.playerName,
      teamId: inj.teamId,
      teamName: inj.teamName,
      severity: inj.severity,
      injuryName: inj.injuryName,
      note: inj.note,
      recoverPercent: inj.recoverPercent,
      misses: [...remaining, ...inj.misses.filter((m) => m.status === "finished")],
      injuredInLabel: inj.fromLabel,
    });
  }
  out.sort((a, b) => {
    // 重伤档在前（更值得关注），同档按进度低在前（刚伤的先看）
    if (a.severity !== b.severity) return a.severity === "major" ? -1 : 1;
    return a.recoverPercent - b.recoverPercent || a.playerName.localeCompare(b.playerName, "zh");
  });
  return out;
}

// 伤病榜「伤停中」徽标用：全平台仍在伤停中的球员 id 集合（跨赛事，球员在哪儿伤的都算）
export async function listActiveInjuryPlayerIds(db: D1Database): Promise<Set<number>> {
  const list = await listActiveInjuries(db);
  return new Set(list.map((i) => i.playerId));
}

// 公开端「伤停动态」板块：某届赛事的参赛队里，仍在伤停中的登记，按队分组。
// 伤停本身跨赛事（某队可能在别处伤人），这里只按「参赛队」筛，赛事名在每条里标注。
export async function listTournamentActiveInjuries(
  db: D1Database,
  tid: number
): Promise<InjuryWatchGroupDTO[]> {
  const [all, teams] = await Promise.all([
    listActiveInjuries(db),
    db
      .prepare(
        `SELECT DISTINCT t.id, t.name, t.logo_key
         FROM entry e JOIN team t ON t.id = e.team_id
         WHERE e.tournament_id = ?`
      )
      .bind(tid)
      .all<{ id: number; name: string; logo_key: string | null }>(),
  ]);
  const groups = new Map<number, InjuryWatchGroupDTO>();
  for (const t of teams.results ?? []) {
    groups.set(t.id, { teamId: t.id, teamName: t.name, logoUrl: mediaUrl(t.logo_key), injuries: [] });
  }
  for (const inj of all) {
    groups.get(inj.teamId)?.injuries.push(inj);
  }
  // 有伤停的队排前面（按队名稳定排序），空队不返回
  return [...groups.values()]
    .filter((g) => g.injuries.length > 0)
    .sort((a, b) => a.teamName.localeCompare(b.teamName, "zh"));
}

// 某事件时间窗内新出现的伤病（新闻周报/轮条用）：
// 窗口 = 赛事在该窗口内完赛的比赛（与 buildWeekly 口径一致按 finished_at），
// 挂在这些比赛上的 injury_minor/injury_major 事件且已建登记。
export interface InjuryFact {
  eventId: number;
  injuryId: number | null; // 有伤停登记才有值
  playerId: number;
  playerName: string;
  teamId: number;
  teamName: string;
  severity: InjurySeverity;
  injuryName: string | null;
  matchId: number;
  stageId: number;
  round: number;
  tournamentId: number;
  tournamentName: string;
  finishedAt: string | null;
  outMatches: number; // 登记里还挂着的未完赛缺阵场次；无登记为 0
}

// 伤情事实底表：伤病事件为事实源，登记（injury）只补伤名与缺阵状态。
// 事件没记球员/所属队就列不出名字，与伤病榜口径一致，直接不取。
const INJURY_FACT_SELECT = `
  SELECT me.id AS event_id, i.id AS injury_id,
         me.player_id, p.name AS player_name, t.id AS team_id, t.name AS team_name,
         me.type, i.injury_name,
         m.id AS match_id, m.stage_id, m.round, m.finished_at,
         s.tournament_id, tt.name AS tournament_name,
         (SELECT COUNT(*) FROM injury_miss im
            JOIN match m2 ON m2.id = im.match_id
           WHERE im.injury_id = i.id AND m2.status != 'finished') AS out_matches
  FROM match_event me
  JOIN match m ON m.id = me.match_id
  JOIN stage s ON s.id = m.stage_id
  JOIN tournament tt ON tt.id = s.tournament_id
  JOIN entry e ON e.id = me.entry_id
  JOIN team t ON t.id = e.team_id
  JOIN player p ON p.id = me.player_id
  LEFT JOIN injury i ON i.event_id = me.id
  WHERE me.type IN ('injury_minor', 'injury_major') AND tt.status != 'draft'`;

async function injuryFacts(
  db: D1Database,
  where: string,
  binds: (string | number)[]
): Promise<InjuryFact[]> {
  const r = await db
    .prepare(`${INJURY_FACT_SELECT} AND ${where} ORDER BY m.finished_at, me.id`)
    .bind(...binds)
    .all<{
      event_id: number;
      injury_id: number | null;
      player_id: number;
      player_name: string;
      team_id: number;
      team_name: string;
      type: MatchEventType;
      injury_name: string | null;
      match_id: number;
      stage_id: number;
      round: number;
      tournament_id: number;
      tournament_name: string;
      finished_at: string | null;
      out_matches: number;
    }>();
  return (r.results ?? []).map((row) => ({
    eventId: row.event_id,
    injuryId: row.injury_id,
    playerId: row.player_id,
    playerName: row.player_name,
    teamId: row.team_id,
    teamName: row.team_name,
    severity: severityOfEventType(row.type as "injury_minor" | "injury_major"),
    injuryName: row.injury_name,
    matchId: row.match_id,
    stageId: row.stage_id,
    round: row.round,
    tournamentId: row.tournament_id,
    tournamentName: row.tournament_name,
    finishedAt: row.finished_at,
    outMatches: row.out_matches ?? 0,
  }));
}

// 某一轮里的伤情（轮次伤情快讯条用；轮次的完赛判定由调用方负责）
export function injuriesInRound(
  db: D1Database,
  stageId: number,
  round: number
): Promise<InjuryFact[]> {
  return injuryFacts(db, "m.stage_id = ? AND m.round = ?", [stageId, round]);
}

// 时间窗口里的伤情（按完赛时刻，与 fetchFinishedWindow / weekMatches 同口径：左闭右开）；
// 传 tournamentId 只取该届，不传则跨赛事（周报用）
export function injuriesInWindow(
  db: D1Database,
  fromIso: string, // 含（>=）
  toIso: string, // 不含（<）
  tournamentId?: number
): Promise<InjuryFact[]> {
  return tournamentId == null
    ? injuryFacts(db, "m.finished_at >= ? AND m.finished_at < ?", [fromIso, toIso])
    : injuryFacts(db, "s.tournament_id = ? AND m.finished_at >= ? AND m.finished_at < ?", [
        tournamentId,
        fromIso,
        toIso,
      ]);
}

// 某队可勾选为缺阵的比赛：跨赛事全量（含已完赛，支持补录），登记面板用。
// away 可为 NULL 的未编排场用 LEFT JOIN 兜住（否则主队是它的场次会被漏掉）。
// 注意：D1 按 SQL 别名原样返列名，必须显式转到驼峰 DTO——漏转会让前端拿到 undefined
// 的 matchId（所有复选框共用一个 undefined 状态，点一场就全选）。
export async function listTeamMissCandidates(
  db: D1Database,
  teamId: number,
): Promise<InjuryMissCandidateDTO[]> {
  const r = await db
    .prepare(
      `SELECT m.id AS match_id, t2.id AS tournament_id, t2.name AS tournament_name,
              m.round, s.kind AS stage_kind, m.status,
              eh.name AS home_team_name, ea.name AS away_team_name
       FROM match m
       JOIN stage s ON s.id = m.stage_id
       JOIN tournament t2 ON t2.id = s.tournament_id
       JOIN entry e1 ON e1.id = m.home_entry_id
       JOIN team eh ON eh.id = e1.team_id
       LEFT JOIN entry e2 ON e2.id = m.away_entry_id
       LEFT JOIN team ea ON ea.id = e2.team_id
       WHERE e1.team_id = ? OR e2.team_id = ?
       ORDER BY t2.id, s.sort_order, m.round, m.slot, m.leg, m.id`,
    )
    .bind(teamId, teamId)
    .all<{
      match_id: number;
      tournament_id: number;
      tournament_name: string;
      round: number;
      stage_kind: "elim" | "round_robin" | "group";
      status: "pending" | "live" | "finished";
      home_team_name: string;
      away_team_name: string | null;
    }>();
  return (r.results ?? []).map((x) => ({
    matchId: x.match_id,
    tournamentId: x.tournament_id,
    tournamentName: x.tournament_name,
    round: x.round,
    stageKind: x.stage_kind,
    status: x.status,
    homeTeamName: x.home_team_name,
    awayTeamName: x.away_team_name,
  }));
}

// ---------- 组装（纯函数，可单测） ----------

function missesForTeams(db: D1Database, teamIds: number[]): Promise<D1Result<MissRow>> {
  return db
    .prepare(
      `SELECT im.injury_id, im.match_id, t2.id AS tournament_id, t2.name AS tournament_name,
              m.round, s.kind AS stage_kind, m.status
       FROM injury_miss im
       JOIN injury i ON i.id = im.injury_id
       JOIN match m ON m.id = im.match_id
       JOIN stage s ON s.id = m.stage_id
       JOIN tournament t2 ON t2.id = s.tournament_id
       WHERE i.team_id IN (${teamIds.map(() => "?").join(",")})
       ORDER BY s.sort_order, m.round, m.slot, m.leg, m.id`
    )
    .bind(...teamIds)
    .all<MissRow>();
}

function missesAll(db: D1Database): Promise<D1Result<MissRow>> {
  return db
    .prepare(
      `SELECT im.injury_id, im.match_id, t2.id AS tournament_id, t2.name AS tournament_name,
              m.round, s.kind AS stage_kind, m.status
       FROM injury_miss im
       JOIN match m ON m.id = im.match_id
       JOIN stage s ON s.id = m.stage_id
       JOIN tournament t2 ON t2.id = s.tournament_id
       ORDER BY s.sort_order, m.round, m.slot, m.leg, m.id`
    )
    .all<MissRow>();
}

// 原始行 → 组装（导出供单测）；teamNameOf 可注入队名（listActiveInjuries 需要）
export function assembleRaw(
  rows: (InjuryRow & { team_name?: string })[],
  misses: MissRow[],
  teamNameOf?: (r: InjuryRow & { team_name?: string }) => string
): Map<number, AssembledInjury> {
  const byId = new Map<number, AssembledInjury>();
  for (const r of rows) {
    byId.set(r.id, {
      id: r.id,
      teamId: r.team_id,
      teamName: teamNameOf ? teamNameOf(r) : "",
      playerId: r.player_id,
      playerName: r.player_name,
      severity: severityOfEventType(r.event_type),
      injuryName: r.injury_name,
      note: r.note,
      createdAt: r.created_at,
      misses: [],
      recoverPercent: 0,
      fromLabel: `${r.from_tournament_name} · 第${r.from_round}轮`,
      eventId: r.event_id,
      fromMatchId: r.from_match_id,
    });
  }
  for (const m of misses) {
    const inj = byId.get(m.injury_id);
    if (!inj) continue;
    inj.misses.push({
      matchId: m.match_id,
      tournamentId: m.tournament_id,
      tournamentName: m.tournament_name,
      round: m.round,
      stageKind: m.stage_kind,
      status: m.status,
    });
  }
  for (const inj of byId.values()) {
    const total = inj.misses.length;
    const done = inj.misses.filter((m) => m.status === "finished").length;
    inj.recoverPercent = total === 0 ? 0 : Math.round((done / total) * 100);
  }
  return byId;
}

interface AssembledInjury {
  id: number;
  teamId: number;
  teamName: string;
  playerId: number;
  playerName: string;
  severity: InjurySeverity;
  injuryName: string | null;
  note: string | null;
  createdAt: string;
  misses: InjuryMissDTO[];
  recoverPercent: number;
  fromLabel: string;
  eventId: number;
  fromMatchId: number;
}

function assemble(
  rows: (InjuryRow & { team_name?: string })[],
  misses: MissRow[],
  fromLabelOf: (r: InjuryRow) => string,
  teamNameOf?: (r: InjuryRow & { team_name?: string }) => string,
): InjuryStatusDTO[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return [...assembleRaw(rows, misses, teamNameOf).values()].map((inj) => ({
    id: inj.id,
    teamId: inj.teamId,
    teamName: inj.teamName,
    playerId: inj.playerId,
    playerName: inj.playerName,
    eventId: inj.eventId,
    severity: inj.severity,
    injuryName: inj.injuryName,
    note: inj.note,
    createdAt: inj.createdAt,
    fromMatchId: inj.fromMatchId,
    fromLabel: inj.fromLabel || fromLabelOf(byId.get(inj.id)!),
    misses: inj.misses,
    recoverPercent: inj.recoverPercent,
  }));
}

function toPublic(inj: AssembledInjury): PublicAbsenceDTO {
  return {
    playerId: inj.playerId,
    playerName: inj.playerName,
    teamId: inj.teamId,
    severity: inj.severity,
    injuryName: inj.injuryName,
    note: inj.note,
    recoverPercent: inj.recoverPercent,
  };
}
