// #13 头版门户：快讯流与周报引擎。
// 快讯是读时现算的纯派生物——事实成立条目即在，pubCache 控制重算频率（每边缘节点每 60s 至多一次）；
// 同数据同输出（确定性 item_id + 稳定排序），数据变动自动重算，无陈旧新闻。
// 时效梯度：红牌(live 即时报) → 战报(终场) → 综述(全轮, Phase 2) → 周报(周末)。
import type { D1Database } from "@cloudflare/workers-types";
import type { FeedItemDTO, WeeklyDTO, WeeklyMatchDTO } from "../../shared/news";
import {
  fetchEventRows,
  fetchFinishedWindow,
  fetchStageMaxRounds,
  redCardBanSuffix,
  roundLabel,
  type FinishedMatch,
} from "./context";

// ---------- 周报（自然周，周一起算，UTC 口径；本周空回退最近有比赛的一周） ----------

const WEEK_MS = 7 * 24 * 3600 * 1000;

function mondayUTC(d: Date): Date {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (t.getUTCDay() + 6) % 7; // 周一=0
  t.setUTCDate(t.getUTCDate() - dow);
  return t;
}

function weekKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function weekMatches(db: D1Database, startISO: string, endISO: string): Promise<FinishedMatch[]> {
  const res = await db
    .prepare(
      `SELECT m.id, m.stage_id, s.tournament_id, t.name AS tournament_name,
         s.kind AS stage_kind, s.name AS stage_name, m.round,
         m.home_entry_id, m.away_entry_id,
         ht.name AS home_team_name, at.name AS away_team_name,
         ht.logo_key AS home_logo_key, at.logo_key AS away_logo_key,
         m.score_home, m.score_away, m.pen_home, m.pen_away,
         m.walkover_side, m.note, m.status, m.finished_at
       FROM match m
       JOIN stage s ON s.id = m.stage_id
       JOIN tournament t ON t.id = s.tournament_id
       JOIN entry he ON he.id = m.home_entry_id
       JOIN team ht ON ht.id = he.team_id
       JOIN entry ae ON ae.id = m.away_entry_id
       JOIN team at ON at.id = ae.team_id
       WHERE t.status != 'draft' AND m.status = 'finished'
         AND m.finished_at >= ? AND m.finished_at < ?
       ORDER BY m.finished_at DESC, m.id DESC`
    )
    .bind(startISO, endISO)
    .all<{
      id: number; stage_id: number; tournament_id: number; tournament_name: string;
      stage_kind: "elim" | "round_robin" | "group"; stage_name: string | null; round: number;
      home_entry_id: number; away_entry_id: number;
      home_team_name: string; away_team_name: string;
      home_logo_key: string | null; away_logo_key: string | null;
      score_home: number; score_away: number;
      pen_home: number | null; pen_away: number | null;
      walkover_side: string | null; note: string | null;
      status: "pending" | "live" | "finished"; finished_at: string | null;
    }>();
  const rows = res.results ?? [];
  return rows.map((r) => ({
    id: r.id,
    stageId: r.stage_id,
    tournamentId: r.tournament_id,
    tournamentName: r.tournament_name,
    stageKind: r.stage_kind,
    stageName: r.stage_name,
    round: r.round,
    homeEntryId: r.home_entry_id,
    awayEntryId: r.away_entry_id,
    homeTeamName: r.home_team_name,
    awayTeamName: r.away_team_name,
    homeLogoUrl: null,
    awayLogoUrl: null,
    scoreHome: r.score_home,
    scoreAway: r.score_away,
    penHome: r.pen_home,
    penAway: r.pen_away,
    walkoverSide: r.walkover_side ?? "",
    note: r.note,
    status: r.status,
    finishedAt: r.finished_at,
  }));
}

const fmtMD = (iso: string): string => iso.slice(5, 7) + "." + iso.slice(8, 10);

export async function buildWeekly(db: D1Database, weekParam?: string): Promise<WeeklyDTO> {
  const nowMonday = mondayUTC(new Date());
  let start = weekParam ? mondayUTC(new Date(`${weekParam}T00:00:00Z`)) : nowMonday;
  // 指定周不强回退（空周就是空态）；「本周」无比赛时回退最近有比赛的一周（最多回溯 8 周）
  let list: FinishedMatch[] = [];
  let isFallback = false;
  if (weekParam) {
    list = await weekMatches(db, weekKey(start), weekKey(new Date(start.getTime() + WEEK_MS)));
  } else {
    list = await weekMatches(db, weekKey(start), weekKey(new Date(start.getTime() + WEEK_MS)));
    if (list.length === 0) {
      for (let i = 1; i <= 8; i++) {
        const s = new Date(start.getTime() - i * WEEK_MS);
        const l = await weekMatches(db, weekKey(s), weekKey(new Date(s.getTime() + WEEK_MS)));
        if (l.length > 0) {
          start = s;
          list = l;
          isFallback = true;
          break;
        }
      }
    }
  }
  const end = new Date(start.getTime() + WEEK_MS);

  // 事件（乌龙数 / 本周射手王）
  const eventsByMatch = await fetchEventRows(db, list.map((m) => m.id));
  let ownGoals = 0;
  const scorerGoals = new Map<string, { name: string; teamName: string; goals: number }>();
  for (const m of list) {
    for (const e of eventsByMatch.get(m.id) ?? []) {
      if (e.type === "own_goal") ownGoals += 1;
      if ((e.type === "goal" || e.type === "pen_goal") && e.playerName) {
        const key = e.playerName;
        const cur = scorerGoals.get(key) ?? { name: e.playerName, teamName: "", goals: 0 };
        cur.goals += 1;
        if (!cur.teamName) {
          cur.teamName = e.entryId === m.homeEntryId ? m.homeTeamName : m.awayTeamName;
        }
        scorerGoals.set(key, cur);
      }
    }
  }
  const topScorer = [...scorerGoals.values()].sort((a, b) => b.goals - a.goals || a.name.localeCompare(b.name, "zh"))[0] ?? null;

  // 聚合：进球含弃权判负记分（0:3 与积分榜口径一致）；零封/最佳防守不计弃权场
  let goals = 0;
  let cleanSheets = 0;
  let biggestMargin: WeeklyDTO["biggestMargin"] = null;
  let bestDiff = 0;
  const teamConceded = new Map<string, { conceded: number; played: number }>();
  for (const m of list) {
    goals += m.scoreHome + m.scoreAway;
    const diff = Math.abs(m.scoreHome - m.scoreAway);
    if (diff > bestDiff) {
      bestDiff = diff;
      biggestMargin = { matchId: m.id, tournamentId: m.tournamentId, score: `${m.scoreHome}:${m.scoreAway}` };
    }
    const wo = m.walkoverSide !== "";
    if (!wo) {
      if (m.scoreHome === 0 || m.scoreAway === 0) cleanSheets += 1;
      for (const [name, conceded] of [
        [m.homeTeamName, m.scoreAway],
        [m.awayTeamName, m.scoreHome],
      ] as const) {
        const cur = teamConceded.get(name) ?? { conceded: 0, played: 0 };
        cur.conceded += conceded;
        cur.played += 1;
        teamConceded.set(name, cur);
      }
    }
  }
  let bestDefense: WeeklyDTO["bestDefense"] = null;
  for (const [teamName, v] of teamConceded) {
    if (v.played === 0) continue;
    if (!bestDefense || v.conceded < bestDefense.conceded) bestDefense = { teamName, conceded: v.conceded };
  }

  const matches: WeeklyMatchDTO[] = list.map((m) => ({
    matchId: m.id,
    tournamentId: m.tournamentId,
    tournamentName: m.tournamentName,
    homeTeamName: m.homeTeamName,
    awayTeamName: m.awayTeamName,
    scoreHome: m.scoreHome,
    scoreAway: m.scoreAway,
    finishedAt: m.finishedAt,
  }));

  return {
    weekStart: weekKey(start),
    label: `${fmtMD(weekKey(start))} – ${fmtMD(weekKey(end))}`,
    isFallback,
    played: list.length,
    goals,
    biggestMargin,
    cleanSheets,
    ownGoals,
    topScorer,
    bestDefense,
    matches,
  };
}

// ---------- 快讯流 ----------

// 进球摘要（share 卡 eventSummaries 口径：同人×n 聚合、乌龙标 OG、点球不特殊标注）
function goalSummary(events: { type: string; playerName: string | null }[]): string {
  const per = new Map<string, { minutes: string[]; og: boolean }>();
  for (const e of events) {
    if (e.type !== "goal" && e.type !== "pen_goal" && e.type !== "own_goal") continue;
    const name = e.playerName ?? "未知球员";
    const cur = per.get(name) ?? { minutes: [], og: false };
    if (e.type === "own_goal") cur.og = true;
    per.set(name, cur);
  }
  if (per.size === 0) return "";
  return [...per.entries()].map(([name, v]) => `${name}${v.og ? "(OG)" : ""}`).join(" · ");
}

export async function buildFeed(
  db: D1Database,
  opts: { limit?: number; before?: string } = {},
): Promise<FeedItemDTO[]> {
  const cap = Math.min(Math.max(opts.limit ?? 15, 1), 50);
  const before = opts.before;
  const items: FeedItemDTO[] = [];

  // 1) 完赛窗口 → 战报/弃权条（窗口取深些给混排留余量）
  const window = await fetchFinishedWindow(db, Math.max(cap * 3, 40), before);
  const eventsByMatch = await fetchEventRows(db, window.map((m) => m.id));
  const maxRounds = await fetchStageMaxRounds(db, window.map((m) => m.stageId));
  for (const m of window) {
    const rl = roundLabel(m, maxRounds.get(m.stageId) ?? m.round);
    const base = {
      at: m.finishedAt,
      tournamentId: m.tournamentId,
      tournamentName: m.tournamentName,
      matchId: m.id,
      homeTeamName: m.homeTeamName,
      awayTeamName: m.awayTeamName,
      homeLogoUrl: m.homeLogoUrl,
      awayLogoUrl: m.awayLogoUrl,
      scoreHome: m.scoreHome,
      scoreAway: m.scoreAway,
      roundLabel: rl,
    };
    if (m.walkoverSide === "home" || m.walkoverSide === "away" || m.walkoverSide === "both") {
      const loser =
        m.walkoverSide === "home" ? m.homeTeamName : m.walkoverSide === "away" ? m.awayTeamName : null;
      const winner = loser ? (loser === m.homeTeamName ? m.awayTeamName : m.homeTeamName) : null;
      items.push({
        ...base,
        id: `wo:${m.id}`,
        kind: "walkover",
        title:
          m.walkoverSide === "both"
            ? `${m.homeTeamName} 与 ${m.awayTeamName} 双双弃权`
            : `${loser} 弃权，${winner} 不战而胜`,
        body: `${rl}｜比分记 ${m.scoreHome}:${m.scoreAway}${m.note ? `（${m.note}）` : ""}`,
      });
    } else {
      const summary = goalSummary(eventsByMatch.get(m.id) ?? []);
      items.push({
        ...base,
        id: `match:${m.id}`,
        kind: "match",
        title: `${rl}｜${m.homeTeamName} ${m.scoreHome}:${m.scoreAway} ${m.awayTeamName}`,
        body: summary || "双方均无进球入账",
      });
    }
  }

  // 2) 红牌即时快讯（live/finished 都算，录入即出条）
  type RedRow = {
    id: number; type: "red" | "red_2y"; created_at: string;
    player_name: string | null;
    match_id: number; tournament_id: number; tournament_name: string;
    stage_kind: "elim" | "round_robin" | "group"; stage_name: string | null; round: number; stage_id: number;
  };
  const redRes = await db
    .prepare(
      `SELECT me.id, me.type, me.created_at, p.name AS player_name,
         m.id AS match_id, t.id AS tournament_id, t.name AS tournament_name,
         s.kind AS stage_kind, s.name AS stage_name, s.id AS stage_id, m.round
       FROM match_event me
       JOIN match m ON m.id = me.match_id
       JOIN stage s ON s.id = m.stage_id
       JOIN tournament t ON t.id = s.tournament_id
       LEFT JOIN player p ON p.id = me.player_id
       WHERE me.type IN ('red', 'red_2y') AND t.status != 'draft'
         ${before ? "AND me.created_at < ?" : ""}
       ORDER BY me.created_at DESC, me.id DESC LIMIT 10`
    )
    .bind(...(before ? [before] : []))
    .all<RedRow>();
  const redRows = redRes.results ?? [];
  const redMaxRounds = await fetchStageMaxRounds(db, redRows.map((r) => r.stage_id));
  const banSuffixes = await Promise.all(redRows.map((r) => redCardBanSuffix(db, r.tournament_id, r.type)));
  for (let i = 0; i < redRows.length; i++) {
    const r = redRows[i];
    items.push({
      id: `discipline:${r.id}`,
      kind: "discipline",
      at: r.created_at,
      tournamentId: r.tournament_id,
      tournamentName: r.tournament_name,
      matchId: r.match_id,
      title: `${r.player_name ?? "球员"} ${r.type === "red" ? "直红" : "两黄变一红"}被罚下`,
      body: `${roundLabel(
        { stageKind: r.stage_kind, stageName: r.stage_name, round: r.round },
        redMaxRounds.get(r.stage_id) ?? r.round,
      )}${banSuffixes[i]}`,
    });
  }

  // 3) 更正启事（改判审计）
  type AuditRow = {
    id: number; created_at: string; target_id: number; detail_json: string | null;
    tournament_id: number; tournament_name: string;
    home_team_name: string; away_team_name: string;
    stage_kind: "elim" | "round_robin" | "group"; stage_name: string | null; stage_id: number; round: number;
  };
  const auditRes = await db
    .prepare(
      `SELECT a.id, a.created_at, a.target_id, a.detail_json,
         t.id AS tournament_id, t.name AS tournament_name,
         ht.name AS home_team_name, at.name AS away_team_name,
         s.kind AS stage_kind, s.name AS stage_name, s.id AS stage_id, m.round
       FROM audit_log a
       JOIN match m ON m.id = a.target_id
       JOIN stage s ON s.id = m.stage_id
       JOIN tournament t ON t.id = s.tournament_id
       JOIN entry he ON he.id = m.home_entry_id
       JOIN team ht ON ht.id = he.team_id
       JOIN entry ae ON ae.id = m.away_entry_id
       JOIN team at ON at.id = ae.team_id
       WHERE a.action = 'match_rescore' AND t.status != 'draft'
         ${before ? "AND a.created_at < ?" : ""}
       ORDER BY a.id DESC LIMIT 10`
    )
    .bind(...(before ? [before] : []))
    .all<AuditRow>();
  for (const a of auditRes.results ?? []) {
    let body = `比分经复核更正`;
    try {
      const d = JSON.parse(a.detail_json ?? "{}") as {
        old?: { scoreHome?: number | null; scoreAway?: number | null };
        new?: { scoreHome?: number | null; scoreAway?: number | null };
      };
      if (d.old && d.new) {
        body = `比分由 ${d.old.scoreHome}:${d.old.scoreAway} 更正为 ${d.new.scoreHome}:${d.new.scoreAway}`;
      }
    } catch {
      // detail 解析失败退化为通用文案
    }
    items.push({
      id: `rescore:${a.id}`,
      kind: "rescore",
      at: a.created_at,
      tournamentId: a.tournament_id,
      tournamentName: a.tournament_name,
      matchId: a.target_id,
      title: `更正启事｜${a.home_team_name} vs ${a.away_team_name}`,
      body,
    });
  }

  // 4) 周报条（本周/回退周有比赛才出）
  const weekly = await buildWeekly(db);
  if (weekly.played > 0) {
    const weeklyAt = weekly.matches[0]?.finishedAt ?? `${weekly.weekStart}T00:00:00Z`;
    if (!before || (weeklyAt && weeklyAt < before)) {
      items.push({
        id: `weekly:${weekly.weekStart}`,
        kind: "weekly",
        at: weeklyAt,
        weekStart: weekly.weekStart,
        title: `WHL 周报 · ${weekly.label}${weekly.isFallback ? "（上周）" : ""}`,
        body: `${weekly.played} 场 ${weekly.goals} 球${weekly.topScorer ? `，射手王 ${weekly.topScorer.name}（${weekly.topScorer.goals} 球）` : ""}`,
      });
    }
  }

  // 混排：at 倒序（null 沉底），同刻按 id 保序
  items.sort((a, b) => {
    if (a.at && b.at && a.at !== b.at) return a.at < b.at ? 1 : -1;
    if (a.at && !b.at) return -1;
    if (!a.at && b.at) return 1;
    return a.id < b.id ? -1 : 1;
  });
  return items.slice(0, cap);
}
